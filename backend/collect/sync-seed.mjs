/* DB → 정적 시드 역동기화 — 검수 승인·확정된 라이브 플랫폼을 platforms.json(+EN)에 반영한다.
 * 목적: 수집기로 등재된 항목은 DB에만 존재해 SEO 프리렌더·EN 페이지·llms.txt에 안 실린다.
 *       이 스크립트가 차집합을 시드에 추가해 정적 레이어(1,719p+/en/)까지 연결한다(sync-seed.yml이 PR 생성).
 *
 * 동작:
 *   1) DB에서 공개 플랫폼 조회(archived 제외 + auto_listed=false — 사후검수 미완 자동등재분 제외)
 *   2) platforms.json에 없는 id만 추출(시드 → DB 방향은 0003이 담당 — 여기선 역방향만)
 *   3) 시드 스키마로 매핑해 platforms.json에 추가(new:true)
 *   4) EN 항목을 Claude API로 번역 생성(platforms.en.json) — EN 완역 어서션이 빌드를 막으므로 필수.
 *      ANTHROPIC_API_KEY가 없으면 신규분이 있어도 중단(부분 시드 추가로 빌드를 깨지 않기 위해).
 *   5) build-seed.mjs로 0003 재생성 + ALL.sql(0001~000N 연결) 재생성 — 시드 ⊆ 마이그레이션 불변 유지
 *
 * 사용: node backend/collect/sync-seed.mjs [--dry] [--fixture 파일.json]
 *   환경변수 SUPABASE_URL/SUPABASE_ANON_KEY 미설정 시 app/.env.production(공개 anon 키)에서 읽는다.
 *   --fixture: DB 대신 저장된 platforms 응답 JSON 사용(프록시 제한 환경 검증용 — collect.mjs와 동일 패턴)
 */
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const DRY = process.argv.includes("--dry");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const P_KO = path.join(ROOT, "app/src/data/platforms.json");
const P_EN = path.join(ROOT, "app/src/data/platforms.en.json");

/* ── 접속 정보(anon — 공개 키) ── */
let SB_URL = process.env.SUPABASE_URL, SB_KEY = process.env.SUPABASE_ANON_KEY;
if (!SB_URL || !SB_KEY) {
  const env = fs.readFileSync(path.join(ROOT, "app/.env.production"), "utf8");
  SB_URL ||= env.match(/VITE_SUPABASE_URL=(\S+)/)?.[1];
  SB_KEY ||= env.match(/VITE_SUPABASE_ANON_KEY=(\S+)/)?.[1];
}
if (!SB_URL || !SB_KEY) { console.error("Supabase 접속 정보 없음"); process.exit(1); }

const ko = JSON.parse(fs.readFileSync(P_KO, "utf8"));
const en = JSON.parse(fs.readFileSync(P_EN, "utf8"));
const seedIds = new Set(ko.platforms.map((p) => p.id));
const catIds = new Set(ko.categories.map((c) => c.id));

/* ── 1) DB 공개 플랫폼 조회 → 2) 시드 차집합 ── */
const fixIdx = process.argv.indexOf("--fixture");
let live;
if (fixIdx > -1) {
  live = JSON.parse(fs.readFileSync(process.argv[fixIdx + 1], "utf8"));
} else {
  const res = await fetch(
    `${SB_URL}/rest/v1/platforms?select=id,name,category_id,region,url,blurb,is_new&archived_at=is.null&auto_listed=eq.false&order=created_at.asc&limit=3000`,
    { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } },
  );
  if (!res.ok) { console.error(`DB 조회 실패: ${res.status} ${await res.text()}`); process.exit(1); }
  live = await res.json();
}
const fresh = live.filter((p) => !seedIds.has(p.id) && p.name && p.url);

console.log(`DB 공개 플랫폼 ${live.length}건 · 시드 ${ko.platforms.length}건 · 시드 미반영 ${fresh.length}건`);
for (const p of fresh) console.log(`  + ${p.id} | ${p.name} | ${p.category_id} | ${p.url}`);
const badCat = fresh.filter((p) => !catIds.has(p.category_id));
if (badCat.length) { console.error(`시드에 없는 분야 참조(수동 확인 필요): ${badCat.map((p) => `${p.id}:${p.category_id}`).join(", ")}`); process.exit(1); }
if (!fresh.length) { console.log("신규 없음 — 시드 최신 상태"); process.exit(0); }
if (DRY) { console.log("[dry] 반영 생략"); process.exit(0); }

/* ── 4) EN 번역(먼저 — 실패 시 시드를 건드리지 않는다) ── */
if (!process.env.ANTHROPIC_API_KEY) {
  console.error(`신규 ${fresh.length}건이 있으나 ANTHROPIC_API_KEY 미설정 — EN 완역 어서션 때문에 EN 항목 없이는 빌드가 깨진다. 키 설정 후 재실행.`);
  process.exit(1);
}
const banned = /\bfees?\b|commission|settlement|payout|₩|\bkrw\b|\$\s?\d/i;
const items = fresh.map((p, i) => ({ i, name: p.name, blurb: p.blurb || "", region: p.region }));
const prompt = `한국 플랫폼 디렉토리의 영문판 항목을 만듭니다. 각 항목에 대해:
- name_en: 공식/통용 영문명, 형식은 "EnglishName (한글명)". 이미 영문명이면 괄호 생략 가능.
- blurb_en: 서비스 설명 영어 한 문장(최대 175자). 수수료·정산·가격·금액 표현 절대 금지(fee/commission/settlement/₩/KRW/$숫자 금지 — 법적 방화벽). 사업모델 중립 서술.

입력: ${JSON.stringify(items)}

출력은 JSON 배열만: [{"i":0,"name_en":"...","blurb_en":"..."}, ...]`;
const aRes = await fetch("https://api.anthropic.com/v1/messages", {
  method: "POST",
  headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
  body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 8000, messages: [{ role: "user", content: prompt }] }),
});
if (!aRes.ok) { console.error(`번역 API 실패: ${aRes.status}`); process.exit(1); }
const aText = (await aRes.json()).content?.map((b) => b.text ?? "").join("") ?? "";
const aRows = JSON.parse(aText.match(/\[[\s\S]*\]/)?.[0] ?? "[]");
const enAdd = new Map();
for (const r of aRows) {
  const i = Number(r?.i);
  if (!Number.isInteger(i) || i < 0 || i >= fresh.length) continue;
  const name = String(r.name_en ?? "").trim().slice(0, 80);
  const blurb = String(r.blurb_en ?? "").replace(/\s+/g, " ").trim().slice(0, 175);
  if (!name || blurb.length < 10 || banned.test(name) || banned.test(blurb)) continue;
  enAdd.set(fresh[i].id, { name, blurb });
}
const missing = fresh.filter((p) => !enAdd.has(p.id));
if (missing.length) { console.error(`EN 번역 누락/검증 탈락 ${missing.length}건(${missing.map((p) => p.id).join(", ")}) — 전건 성공해야 반영(부분 반영 금지)`); process.exit(1); }

/* ── 3)+5) 시드 반영 + 재생성 ── */
const toKo = (p) => ({
  id: p.id, name: p.name, category: p.category_id,
  region: p.region === "overseas" ? "해외" : "국내",
  url: p.url, blurb: p.blurb || "", ...(p.is_new ? { new: true } : {}),
});
ko.platforms.push(...fresh.map(toKo));
fs.writeFileSync(P_KO, JSON.stringify(ko, null, 2));
for (const [id, v] of enAdd) en.platforms[id] = v;
fs.writeFileSync(P_EN, JSON.stringify(en, null, 2) + "\n");

execSync("node backend/seed/build-seed.mjs", { cwd: ROOT, stdio: "inherit" });
execSync("cat backend/migrations/00*.sql > backend/migrations/ALL.sql", { cwd: ROOT, stdio: "inherit" });
console.log(`✓ 시드 반영 ${fresh.length}건(KO+EN) + 0003·ALL.sql 재생성 — 빌드 검증 후 PR로 리뷰하세요.`);
