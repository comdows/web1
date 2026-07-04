/* 등재 URL 헬스체크 — 매월 GitHub Actions에서 실행(healthcheck.yml).
 * 정적 시드(app/src/data/platforms.json)의 전체 URL을 순회해 죽은 링크를 찾아
 * GitHub 이슈로 리포트한다(자동 삭제 없음 — 관리자가 확인 후 조치).
 * 봇 차단(403 등)은 "확인 필요"로만 분류해 오탐을 줄인다. */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const data = JSON.parse(fs.readFileSync(path.join(ROOT, "app/src/data/platforms.json"), "utf8"));

/* 라이브 데이터 우선 — 정적 시드만 돌면 콘솔에서 승인·정정된 등재분이 영구 무점검이 된다.
 * SUPABASE env가 있으면 anon PostgREST로 전량 페이지네이션 조회(공개 read RLS).
 * 조회 실패는 throw: Supabase 장애의 가용성 프로브를 겸한다(런 실패 → 알림 메일). */
async function fetchLivePlatforms() {
  const SB_URL = process.env.SUPABASE_URL, SB_KEY = process.env.SUPABASE_ANON_KEY;
  if (!SB_URL || !SB_KEY) return null;
  const rows = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const res = await fetch(`${SB_URL}/rest/v1/platforms?select=id,name,category_id,url&order=id.asc`, {
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, Range: `${from}-${from + PAGE - 1}` },
    });
    if (!res.ok) throw new Error(`라이브 플랫폼 조회 실패: ${res.status} ${await res.text()}`);
    const batch = await res.json();
    rows.push(...batch);
    if (batch.length < PAGE) break;
  }
  return rows.map((r) => ({ id: r.id, name: r.name, category: r.category_id, url: r.url }));
}
const live = await fetchLivePlatforms();
if (live) { data.platforms = live; console.log(`라이브 데이터 사용 — ${live.length}건(Supabase)`); }
else console.log("SUPABASE env 없음 — 정적 시드로 점검");

const CONCURRENCY = 15;
const TIMEOUT = 12000;
const UA = "Mozilla/5.0 (compatible; semopl-healthcheck/1.0; +https://comdows.github.io/web1/)";

async function probe(p) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(p.url, {
        redirect: "follow", signal: AbortSignal.timeout(TIMEOUT),
        headers: { "User-Agent": UA, Accept: "text/html,*/*" },
      });
      if (res.ok || (res.status >= 300 && res.status < 400)) return { p, state: "ok" };
      if ([401, 403, 405, 429, 503, 999].includes(res.status)) return { p, state: "warn", detail: `HTTP ${res.status}(봇 차단 가능)` };
      return { p, state: "dead", detail: `HTTP ${res.status}` };
    } catch (e) {
      if (attempt === 0) continue; // 일시 오류 1회 재시도
      return { p, state: "dead", detail: e.name === "TimeoutError" ? "타임아웃" : (e.cause?.code ?? e.message) };
    }
  }
}

const list = data.platforms;
console.log(`헬스체크 시작 — ${list.length}개 URL, 동시 ${CONCURRENCY}`);
const results = [];
for (let i = 0; i < list.length; i += CONCURRENCY) {
  const batch = await Promise.all(list.slice(i, i + CONCURRENCY).map(probe));
  results.push(...batch);
  if ((i / CONCURRENCY) % 10 === 0) console.log(`  ${Math.min(i + CONCURRENCY, list.length)}/${list.length}…`);
}

const dead = results.filter((r) => r.state === "dead");
const warn = results.filter((r) => r.state === "warn");
console.log(`완료 — 정상 ${results.length - dead.length - warn.length} · 확인 필요 ${warn.length} · 접속 불가 ${dead.length}`);

const line = (r) => `- [ ] **${r.p.name}** (\`${r.p.id}\`, ${r.p.category}) — ${r.detail} — ${r.p.url}`;
const body = [
  `등재 URL 헬스체크 결과 (${new Date().toISOString().slice(0, 10)}, 총 ${list.length}개)`,
  "",
  `## ⛔ 접속 불가 ${dead.length}건 — 폐업·이전 여부 확인 후 정정/보관 처리`,
  ...dead.map(line),
  "",
  `## ⚠️ 확인 필요 ${warn.length}건 — 봇 차단 응답(실제로는 정상일 수 있음, 브라우저로 확인)`,
  ...warn.slice(0, 40).map(line),
  warn.length > 40 ? `\n(외 ${warn.length - 40}건 — 로그 참조)` : "",
].join("\n");

// GitHub Step Summary + 이슈 생성(죽은 링크가 있을 때만)
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, body + "\n");
if (dead.length > 0 && process.env.GITHUB_TOKEN && process.env.GITHUB_REPOSITORY) {
  const res = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/issues`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json" },
    body: JSON.stringify({ title: `[헬스체크] 접속 불가 ${dead.length}건 (${new Date().toISOString().slice(0, 10)})`, body, labels: ["healthcheck"] }),
  });
  console.log(res.ok ? "✓ 이슈 생성" : `이슈 생성 실패: ${res.status}`);
}
