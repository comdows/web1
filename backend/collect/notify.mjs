/* 매칭·관심 알림 생성 — GitHub Actions(notify.yml)가 주기 실행. 인앱 알림(notifications, 0018)을 만든다:
 *   1) deal_match: 활성 인수 브리프(buyer_briefs.active) × 공개 매물(deals.open) 조건 매칭 → 브리프 소유자.
 *   2) cat_new:    즐겨찾기에서 유도한 "관심 분야"에 신규(is_new) 플랫폼 등재 → 즐겨찾기 소유자(사용자당 상한).
 *   2.5) fav_news: 즐겨찾기한 플랫폼의 최근 7일 소식(platform_news, 0027) → 즐겨찾기 소유자(사용자당 상한).
 *   3) sub_expiry: 구독 만료 임박(D-7) 갱신 안내(0026).
 * "접속해야만 확인" 문제를 오프사이트 인프라 없이 해소. (이메일 발송은 게이트 뒤 별도 — README 참고)
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

const CAT_NEW_CAP = 5; // 사용자당 1회 실행에서 "관심 분야 신규" 알림 상한(플러딩 방지 — 나머지는 다음 실행에 dedup으로 이어짐)

/* ── 데이터 로드 ── */
let briefs, deals, favorites, platforms, expiring, news, token;
if (FIXTURE) {
  const fs = await import("node:fs");
  const fx = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
  briefs = fx.briefs || []; deals = fx.deals || [];
  favorites = fx.favorites || []; platforms = fx.platforms || []; expiring = fx.expiring || [];
  news = fx.news || [];
} else {
  token = await login();
  await assertAdmin(token);
  briefs = await rest(token, "buyer_briefs?active=is.true&select=id,user_id,categories,budget_band,mode");
  deals = await rest(token, "deals?status=eq.open&is_demo=is.false&select=id,category_id,mode,revenue_band,region,summary");
  favorites = await rest(token, "favorites?select=user_id,platform_id&limit=10000");
  platforms = await rest(token, "platforms?select=id,name,category_id,is_new&limit=5000");
  // 만료 임박 구독(0026 v_expiring_subs — admin 뷰). 뷰 미적용(마이그레이션 전) DB에서도 잡이 죽지 않게 폴백.
  expiring = await rest(token, "v_expiring_subs?select=user_id,plan_id,current_period_end").catch(() => []);
  // 최근 7일 수집된 플랫폼 소식(0027) — 미적용 DB 폴백. published_at은 결측 가능해 created_at(수집 시각) 기준.
  const since = new Date(Date.now() - 7 * 86400e3).toISOString();
  news = await rest(token, `platform_news?created_at=gte.${since}&select=id,platform_id,title&order=created_at.desc&limit=1000`).catch(() => []);
}
console.log(`활성 브리프 ${briefs.length} · 공개 매물 ${deals.length} · 즐겨찾기 ${favorites.length} · 플랫폼 ${platforms.length} · 만료 임박 구독 ${(expiring || []).length} · 최근 소식 ${(news || []).length}`);

const notifs = [];

/* 1) 인수 브리프 ↔ 신규 매물 매칭 알림 */
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

/* 2) 관심 분야(즐겨찾기에서 유도) 신규 플랫폼 다이제스트 — 인앱.
 *    서버엔 온보딩 관심사가 없어(localStorage) 즐겨찾기한 플랫폼들의 분야를 "관심 분야"로 본다.
 *    이미 즐겨찾기한 플랫폼은 제외, 사용자당 CAP개까지(나머지는 dedup으로 다음 실행에). */
const catById = new Map(platforms.map((p) => [p.id, p]));
const newByCat = new Map(); // category_id → [신규 플랫폼]
for (const p of platforms) if (p.is_new) { const a = newByCat.get(p.category_id) || []; a.push(p); newByCat.set(p.category_id, a); }
const favByUser = new Map(); // user_id → Set(platform_id)
for (const f of favorites) { const s = favByUser.get(f.user_id) || new Set(); s.add(f.platform_id); favByUser.set(f.user_id, s); }
for (const [uid, favSet] of favByUser) {
  const followedCats = new Set([...favSet].map((pid) => catById.get(pid)?.category_id).filter(Boolean));
  let added = 0;
  for (const cat of followedCats) {
    for (const np of newByCat.get(cat) || []) {
      if (favSet.has(np.id) || added >= CAT_NEW_CAP) continue;
      notifs.push({
        user_id: uid, kind: "cat_new", ref_type: "platform", ref_id: np.id,
        title: "관심 분야에 새 플랫폼이 등록됐어요",
        body: `${np.name} — 즐겨찾기한 분야의 신규 등재입니다. 검색에서 확인해보세요.`,
        url: "?view=weekly",
      });
      added++;
    }
    if (added >= CAT_NEW_CAP) break;
  }
}
/* 2.5) 즐겨찾기 플랫폼의 최근 소식(0027 platform_news) — 사용자당 상한(플러딩 방지),
 *      ref_id=소식 id → 같은 기사로는 재실행해도 1회만(멱등). 링크는 플랫폼 상세(소식 섹션). */
const FAV_NEWS_CAP = 3;
const nameById = new Map(platforms.map((p) => [p.id, p.name]));
const newsByPlatform = new Map(); // platform_id → [소식] (로드가 최신순이라 그대로 최신 우선)
for (const n of news || []) { const a = newsByPlatform.get(n.platform_id) || []; a.push(n); newsByPlatform.set(n.platform_id, a); }
for (const [uid, favSet] of favByUser) {
  let added = 0;
  for (const pid of favSet) {
    for (const n of newsByPlatform.get(pid) || []) {
      if (added >= FAV_NEWS_CAP) break;
      notifs.push({
        user_id: uid, kind: "fav_news", ref_type: "news", ref_id: String(n.id),
        title: `즐겨찾기한 ${nameById.get(pid) || pid} 소식이 있어요`,
        body: (n.title || "").slice(0, 120),
        url: `?view=detail&id=${pid}`,
      });
      added++;
    }
    if (added >= FAV_NEWS_CAP) break;
  }
}

/* 3) 구독 만료 임박(D-7) — 자동결제가 없는 구조라 갱신 주문을 인앱으로 안내(수익화 v2).
 *    ref_id에 만료일을 넣어 "같은 주기엔 1회만" 알림(주기 갱신되면 만료일이 바뀌어 새 알림). */
const PLAN_KO = { pro: "Pro 멤버십", buyer: "인수자 멤버십" };
for (const e of expiring || []) {
  const endDay = (e.current_period_end || "").slice(0, 10);
  if (!endDay) continue;
  notifs.push({
    user_id: e.user_id, kind: "sub_expiry", ref_type: "subscription", ref_id: `${e.plan_id}:${endDay}`,
    title: `${PLAN_KO[e.plan_id] || e.plan_id} 만료 예정 (${endDay})`,
    body: "자동결제가 없어요 — 계정 → 내 구독에서 갱신 주문하면 잔여 기간 끝에 이어서 연장됩니다.",
    url: "?view=account",
  });
}
console.log(`알림 후보 ${notifs.length}건 (deal_match + cat_new + fav_news + sub_expiry)`);

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
