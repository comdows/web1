/* 매칭 알림 생성 — GitHub Actions(notify.yml)가 주기 실행.
 * 활성 인수 브리프(buyer_briefs.active) × 공개 매물(deals.open)을 대조해, 조건에 맞는 새 매물이 있으면
 * 브리프 소유자에게 인앱 알림(notifications)을 넣는다. "접속해야만 확인" 문제를 오프사이트 인프라 없이 해소.
 *
 * 멱등: notifications.unique(user_id, kind, ref_id) + PostgREST on_conflict ignore-duplicates →
 *   이미 알린 (브리프소유자, 매물) 조합은 재실행해도 다시 만들지 않는다(= 사실상 "신규 매물만" 알림).
 *
 * 필요 Secrets: SUPABASE_URL, SUPABASE_ANON_KEY, ADMIN_BOT_EMAIL, ADMIN_BOT_PASSWORD
 *   — admin 롤 봇(RLS is_admin — notifications insert 정책이 admin 전용). digest.mjs와 동일 계정.
 *
 * 로컬: node notify.mjs --dry [--fixture 파일.json]  (계산만, DB 미투입)
 */
const DRY = process.argv.includes("--dry");
const fixIdx = process.argv.indexOf("--fixture");
const FIXTURE = fixIdx > -1 ? process.argv[fixIdx + 1] : null;

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_ANON_KEY;

/* 브리프 ↔ 매물 매칭(분야 + 형태) — app/src/lib/api.ts briefMatchesDeal과 동일 규칙.
 * (예산·지역 반영 점수화는 Track B에서 별도 도입) */
function matches(brief, deal) {
  const catOk = !brief.categories?.length || brief.categories.includes(deal.category_id);
  const modeOk = /무관/.test(brief.mode || "") || brief.mode === deal.mode
    || (/자산/.test(brief.mode || "") && /자산/.test(deal.mode || ""));
  return catOk && modeOk;
}

async function login() {
  const res = await fetch(`${SB_URL}/auth/v1/token?grant_type=password`, {
    method: "POST", headers: { apikey: SB_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email: process.env.ADMIN_BOT_EMAIL, password: process.env.ADMIN_BOT_PASSWORD }),
  });
  if (!res.ok) throw new Error(`봇 로그인 실패: ${res.status} ${await res.text()}`);
  return (await res.json()).access_token;
}
/* 센티널(digest.mjs와 동일 취지): 봇이 admin 롤을 잃으면 RLS가 '0행 성공'을 줘 조용히 아무 알림도 안 만든다.
 * 롤을 명시 확인하고 아니면 런을 실패시켜 '고장=이상없음' 오작동을 막는다. */
async function assertAdmin(token) {
  const sub = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).sub;
  const res = await fetch(`${SB_URL}/rest/v1/profiles?id=eq.${sub}&select=role`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`봇 롤 확인 실패: ${res.status}`);
  const rows = await res.json();
  if (rows[0]?.role !== "admin") throw new Error(`봇 계정이 admin 롤이 아님(role=${rows[0]?.role ?? "없음"}) — 알림 생성 신뢰 불가`);
}
async function rest(token, pathQ, init = {}) {
  const res = await fetch(`${SB_URL}/rest/v1/${pathQ}`, {
    ...init, headers: { apikey: SB_KEY, Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  if (!res.ok) throw new Error(`${res.status} ${pathQ.split("?")[0]}: ${await res.text()}`);
  const t = await res.text();
  return t ? JSON.parse(t) : undefined;
}

/* ── 데이터 로드 ── */
let briefs, deals, token;
if (FIXTURE) {
  const fs = await import("node:fs");
  const fx = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
  briefs = fx.briefs || []; deals = fx.deals || [];
} else {
  token = await login();
  await assertAdmin(token);
  briefs = await rest(token, "buyer_briefs?active=is.true&select=id,user_id,categories,budget_band,mode");
  deals = await rest(token, "deals?status=eq.open&is_demo=is.false&select=id,category_id,mode,revenue_band,region,summary");
}
console.log(`활성 브리프 ${briefs.length} · 공개 매물 ${deals.length}`);

/* ── 매칭 → 알림 payload ── */
const notifs = [];
for (const b of briefs) {
  for (const d of deals) {
    if (!matches(b, d)) continue;
    notifs.push({
      user_id: b.user_id, kind: "deal_match", ref_type: "deal", ref_id: d.id,
      title: `조건에 맞는 새 매물이 있어요 (${d.id})`,
      body: `${(d.summary || "").slice(0, 80)} — 관심 있으면 거래소에서 관심 등록하세요.`,
      url: "?view=exchange",
    });
  }
}
console.log(`매칭 알림 후보 ${notifs.length}건`);

if (DRY) {
  for (const n of notifs.slice(0, 30)) console.log(`  + ${n.user_id.slice(0, 8)}… ← ${n.ref_id}: ${n.title}`);
  console.log("[dry] 투입 생략"); process.exit(0);
}
if (notifs.length === 0) { console.log("신규 매칭 없음 — 종료"); process.exit(0); }

/* 벌크 insert — unique 위반은 무시(이미 알린 조합). resolution=ignore-duplicates + on_conflict 지정. */
await rest(token, "notifications?on_conflict=user_id,kind,ref_id", {
  method: "POST",
  headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
  body: JSON.stringify(notifs),
});
console.log(`✓ 알림 upsert 완료(중복 무시) — 신규분만 회원에게 표시됩니다.`);
