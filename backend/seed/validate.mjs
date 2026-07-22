/* 데이터 무결성 게이트 — 빌드마다 실행(package.json build, prerender 앞).
 * 하드 오류(빌드 실패): 잘못된 URL/id 형식, 빈 blurb·이름, 존재하지 않는 분야, 허용 외 도메인 중복.
 * 소프트 경고(통과): http URL, 15자 미만 blurb — 카운트만 출력해 보강 대상으로 추적. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const d = JSON.parse(fs.readFileSync(path.join(ROOT, "app/src/data/platforms.json"), "utf8"));

/* 같은 도메인이어도 정당한 쌍(같은 회사의 다른 서비스 등) — 오탐 시 여기에 추가 */
const DUP_ALLOW = new Set([
  "naver.com", "coupang.com", "kakao.com", "amazon.com", "google.com", "smartstore.naver.com",
  "shopping.naver.com", "cafe24.com", "wadiz.kr", "musinsa.com", "baemin.com", "29cm.co.kr",
  "github.com", "adobe.com", "deepl.com",
  "labs.google",   // Google Labs 산하 별개 제품(ImageFX /fx · Flow /flow — 검토 완료)
  // 앱 스토어 상세 링크(여러 앱이 같은 호스트) · 같은 회사의 복수 서비스(검토 완료)
  "apps.apple.com", "play.google.com", "rakuten.co.jp", "kurly.com", "wanted.co.kr",
  "kakaomobility.com", "ridibooks.com", "findsemusa.com", "castingn.com", "incheoneum.or.kr",
]);

const catIds = new Set(d.categories.map((c) => c.id));
const errors = [];
const byHost = new Map();
let httpCnt = 0, shortCnt = 0;

for (const p of d.platforms) {
  if (!/^[a-z0-9-]+$/.test(p.id)) errors.push(`id 형식 위반: ${p.id}`);
  if (!p.name?.trim()) errors.push(`이름 없음: ${p.id}`);
  if (!p.blurb?.trim()) errors.push(`설명 없음: ${p.id}`);
  else if (p.blurb.trim().length < 15) shortCnt++;
  if (!catIds.has(p.category)) errors.push(`없는 분야 참조: ${p.id} → ${p.category}`);
  let host = "";
  try { host = new URL(p.url).hostname.replace(/^www\./, "").toLowerCase(); }
  catch { errors.push(`URL 형식 위반: ${p.id} → ${p.url}`); continue; }
  if (p.url.startsWith("http://")) httpCnt++;
  const prev = byHost.get(host);
  if (prev && !DUP_ALLOW.has(host)) errors.push(`도메인 중복(오배정 의심): ${prev} ↔ ${p.id} → ${host}`);
  byHost.set(host, p.id);
}

const dupIds = d.platforms.length - new Set(d.platforms.map((p) => p.id)).size;
if (dupIds > 0) errors.push(`중복 id ${dupIds}건`);

console.log(`무결성 검사 — ${d.platforms.length}건 · 하드 오류 ${errors.length} · 경고(http ${httpCnt} · 짧은 설명 ${shortCnt})`);
if (errors.length) {
  for (const e of errors.slice(0, 30)) console.error(`  ✗ ${e}`);
  if (errors.length > 30) console.error(`  … 외 ${errors.length - 30}건`);
  process.exit(1);
}
