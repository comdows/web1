/* 대기건 일일 다이제스트 — GitHub Actions(digest.yml)가 매일 실행.
 * 관리 콘솔의 5개 검수·소개 큐 대기 수를 세서 1건 이상이면 GitHub 이슈(ops-digest)로 알린다
 * — 콘솔을 열지 않아도 접수를 당일 인지(콜드스타트 응답 지연 방지). 0건이면 열린 이슈를 닫는다.
 *
 * 필요 Secrets: SUPABASE_URL, SUPABASE_ANON_KEY, ADMIN_BOT_EMAIL, ADMIN_BOT_PASSWORD
 *   — admin 롤을 부여한 전용 봇 계정(RLS is_admin 필요: backend/README.md §4-F로 지정).
 *     본인 실계정 대신 별도 계정을 권장(Secrets 유출 반경 축소). GITHUB_TOKEN은 Actions 기본 제공. */

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_ANON_KEY;
const REPO = process.env.GITHUB_REPOSITORY;
const GH = process.env.GITHUB_TOKEN;
const CONSOLE_URL = "https://comdows.github.io/web1/?view=admin";

async function login() {
  const res = await fetch(`${SB_URL}/auth/v1/token?grant_type=password`, {
    method: "POST", headers: { apikey: SB_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email: process.env.ADMIN_BOT_EMAIL, password: process.env.ADMIN_BOT_PASSWORD }),
  });
  if (!res.ok) throw new Error(`봇 로그인 실패: ${res.status} ${await res.text()}`);
  return (await res.json()).access_token;
}

/* 센티널: 봇이 admin 롤을 상실하면 RLS가 401이 아니라 '0행 성공'을 준다 —
 * 그대로 진행하면 매일 '대기 0건'으로 집계되고 알림 이슈까지 자동 폐쇄되는
 * '고장 = 이상 없음' 오작동이 된다. 롤을 명시 확인하고 아니면 런을 실패시킨다. */
async function assertAdmin(token) {
  const sub = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).sub;
  const res = await fetch(`${SB_URL}/rest/v1/profiles?id=eq.${sub}&select=role`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`봇 롤 확인 실패: ${res.status}`);
  const rows = await res.json();
  if (rows[0]?.role !== "admin") throw new Error(`봇 계정이 admin 롤이 아님(role=${rows[0]?.role ?? "없음"}) — 다이제스트 신뢰 불가`);
}

/* PostgREST count=exact — 본문 없이 Content-Range 헤더로 개수만.
 * 실패는 throw(fail-loud): 0으로 조용히 넘기면 '대기 없음'으로 오인돼 이슈가 닫힌다. */
async function count(token, pathQ) {
  const res = await fetch(`${SB_URL}/rest/v1/${pathQ}`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${token}`, Prefer: "count=exact", Range: "0-0" },
  });
  if (!res.ok) throw new Error(`${pathQ.split("?")[0]} count 실패: ${res.status} ${await res.text()}`);
  return parseInt((res.headers.get("content-range") ?? "0/0").split("/")[1], 10) || 0;
}
async function oldest(token, table, filter) {
  const res = await fetch(`${SB_URL}/rest/v1/${table}?${filter}&select=created_at&order=created_at.asc&limit=1`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const rows = await res.json();
  return rows[0]?.created_at ?? null;
}
const waitDays = (iso) => iso ? Math.floor((Date.now() - new Date(iso).getTime()) / 86400000) : 0;

const token = await login();
await assertAdmin(token);
const QUEUES = [
  { label: "플랫폼 제보", table: "submissions", filter: "status=in.(pending,hold)" },
  { label: "제휴 제안 검수", table: "partner_posts", filter: "status=eq.pending" },
  { label: "매물 검수", table: "deal_submissions", filter: "status=in.(pending,hold)" },
  { label: "운영자 인증", table: "operator_claims", filter: "status=in.(pending,code_sent)" },
  { label: "소개 대기", table: "v_admin_intro_queue", filter: "status=eq.pending" },
];
const rows = [];
for (const q of QUEUES) {
  const n = await count(token, `${q.table}?${q.filter}`);
  const old = n > 0 ? await oldest(token, q.table, q.filter) : null;
  rows.push({ ...q, n, wait: waitDays(old) });
}
const total = rows.reduce((s, r) => s + r.n, 0);
console.log(rows.map((r) => `${r.label}: ${r.n}건${r.n ? ` (최장 ${r.wait}일 대기)` : ""}`).join("\n"));

/* GitHub 이슈 갱신 — ops-digest 라벨 이슈 1개를 재사용 */
if (!GH || !REPO) { console.log("(GITHUB_TOKEN 없음 — 로컬 실행, 이슈 생략)"); process.exit(0); }
const api = (path, init = {}) => fetch(`https://api.github.com/repos/${REPO}${path}`, {
  ...init, headers: { Authorization: `Bearer ${GH}`, Accept: "application/vnd.github+json", ...(init.headers ?? {}) },
});
const openList = await (await api(`/issues?labels=ops-digest&state=open&per_page=1`)).json();
const existing = Array.isArray(openList) ? openList[0] : null;

if (total === 0) {
  if (existing) {
    await api(`/issues/${existing.number}`, { method: "PATCH", body: JSON.stringify({ state: "closed" }) });
    console.log(`✓ 대기 0건 — 이슈 #${existing.number} 닫음`);
  } else console.log("대기 0건 — 조용히 종료");
  process.exit(0);
}

const today = new Date().toISOString().slice(0, 10);
const body = [
  `**검수·소개 대기 ${total}건** (${today} 기준)`,
  "",
  ...rows.filter((r) => r.n > 0).map((r) => `- **${r.label}**: ${r.n}건 — 최장 ${r.wait}일 대기`),
  "",
  `→ [관리 콘솔 열기](${CONSOLE_URL})`,
  "",
  "_매일 자동 갱신됩니다. 대기 0건이 되면 이 이슈는 자동으로 닫혀요._",
].join("\n");
const title = `[운영] 검수·소개 대기 ${total}건 (${today})`;

if (existing) {
  await api(`/issues/${existing.number}`, { method: "PATCH", body: JSON.stringify({ title, body }) });
  console.log(`✓ 이슈 #${existing.number} 갱신`);
} else {
  const res = await api(`/issues`, { method: "POST", body: JSON.stringify({ title, body, labels: ["ops-digest"] }) });
  console.log(res.ok ? "✓ 이슈 생성" : `이슈 생성 실패: ${res.status}`);
}
