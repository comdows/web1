/* 주간 성장 스냅샷 — GitHub Actions(metrics.yml)가 매주 월 01:15 UTC(월 10:15 KST) 실행.
 * admin_snapshot_weekly RPC(0034)를 호출해 지난 완결 UTC 주의 확정치를 metrics_weekly에 멱등 upsert.
 * events 90일 purge(0010)와 무관하게 성장 히스토리를 영구 보존 — 관리 콘솔 성장 패널의 시계열 원천.
 *
 * 필요 Secrets: SUPABASE_URL, SUPABASE_ANON_KEY, ADMIN_BOT_EMAIL, ADMIN_BOT_PASSWORD (digest와 동일 계정)
 * 로컬: node metrics.mjs --dry  (로그인·롤 확인까지만 — RPC 미호출) */

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_ANON_KEY;
const DRY = process.argv.includes("--dry");

async function login() {
  const res = await fetch(`${SB_URL}/auth/v1/token?grant_type=password`, {
    method: "POST", headers: { apikey: SB_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email: process.env.ADMIN_BOT_EMAIL, password: process.env.ADMIN_BOT_PASSWORD }),
  });
  if (!res.ok) throw new Error(`봇 로그인 실패: ${res.status} ${await res.text()}`);
  return (await res.json()).access_token;
}

/* 센티널(digest.mjs와 동일 사상): 봇이 admin 롤을 잃으면 RPC가 FORBIDDEN으로 죽지만,
 * 원인 메시지를 명확히 하기 위해 롤을 먼저 확인하고 아니면 즉시 실패시킨다. */
async function assertAdmin(token) {
  const sub = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).sub;
  const res = await fetch(`${SB_URL}/rest/v1/profiles?id=eq.${sub}&select=role`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`봇 롤 확인 실패: ${res.status}`);
  const rows = await res.json();
  if (rows[0]?.role !== "admin") throw new Error(`봇 계정이 admin 롤이 아님(role=${rows[0]?.role ?? "없음"}) — 스냅샷 불가`);
}

if (!SB_URL || !SB_KEY) throw new Error("SUPABASE_URL/SUPABASE_ANON_KEY 미설정");
const token = await login();
await assertAdmin(token);

if (DRY) { console.log("[dry] 로그인·admin 롤 확인 완료 — RPC 호출 생략"); process.exit(0); }

const res = await fetch(`${SB_URL}/rest/v1/rpc/admin_snapshot_weekly`, {
  method: "POST",
  headers: { apikey: SB_KEY, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify({}),
});
if (!res.ok) throw new Error(`admin_snapshot_weekly 실패: ${res.status} ${await res.text()}`);
const row = await res.json();
console.log(`✓ 주간 스냅샷 upsert — ${row.week_start}: 세션 ${row.sessions}(신규 ${row.new_sessions}·재방문 ${row.returning_sessions}) · ` +
  `WAU ${row.wau_users} · 검색 ${row.searches} · 외부 ${row.outbounds} · 매물조회 ${row.deal_views} · ` +
  `브리프 ${row.briefs_created} · 관심 ${row.interests_created} · 소개 ${row.intros_done} · 등재 ${row.platforms_total}`);
