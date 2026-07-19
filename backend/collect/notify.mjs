/* 매칭·관심 알림 생성 — GitHub Actions(notify.yml)가 주기 실행. 인앱 알림(notifications, 0018)을 만든다:
 *   1) deal_match: 활성 인수 브리프(buyer_briefs.active) × 공개 매물(deals.open) 조건 매칭 → 브리프 소유자.
 *   2) cat_new:    즐겨찾기에서 유도한 "관심 분야"에 신규(is_new) 플랫폼 등재 → 즐겨찾기 소유자(사용자당 상한).
 *   2.5) fav_news: 즐겨찾기한 플랫폼의 최근 7일 소식(platform_news, 0027) → 즐겨찾기 소유자(사용자당 상한).
 *   2.7) search_match: 저장된 검색(saved_searches, 0030) 조건에 맞는 신규(is_new) 플랫폼 → 저장자(사용자당 상한).
 *   3) sub_expiry: 구독 만료 임박(D-7) 갱신 안내(0026).
 *   4) proposal: 내 인증 플랫폼에 온 제휴 제안(outreach_proposals) → 운영자(R3).
 *   5) review_result: 내 제보·매각 접수의 승인/반려 확정 → 제출자(R3).
 *   6) inquiry_reply: 내 문의 답변 등록 → 작성자(R3 — support 화면의 "알림으로 알려드려요" 약속 이행).
 *   7) post_stale: 게시 60일 경과한 제휴 제안·매물 → 소유자에게 갱신 안내(0041 — 90일 미갱신 시
 *      공개 뷰가 자동 제외하므로 잡은 알림만 만들고 상태는 건드리지 않는다).
 *   8) qa_answer: 내 플랫폼 질문에 답변 등록(0042) → 질문자("답변이 등록되면 알림" 약속 이행).
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

/* 밴드 텍스트에서 대표 규모(억 단위) 추출 — app/src/lib/match.ts bandMax와 동일 규칙. */
function bandMax(t) {
  if (!t) return null;
  const eok = [...String(t).matchAll(/(\d+(?:\.\d+)?)\s*억/g)].map((m) => parseFloat(m[1]));
  if (eok.length) return Math.max(...eok);
  const cheon = [...String(t).matchAll(/(\d+(?:\.\d+)?)\s*천/g)].map((m) => parseFloat(m[1]) * 0.1);
  if (cheon.length) return Math.max(...cheon);
  if (/만/.test(t)) return 0.3;
  const bare = [...String(t).matchAll(/(\d+(?:\.\d+)?)/g)].map((m) => parseFloat(m[1]));
  return bare.length ? Math.max(...bare) : null;
}
/* 브리프 ↔ 매물 매칭(분야 + 형태 + 지역 + 예산 하한) — app/src/lib/api.ts briefMatchesDeal
 * + match.ts regionOk/budgetFloorOk와 동일 규칙(Track B: 지역·예산 게이트 연결).
 * region_pref 미설정·deal.region 미상이면 지역 게이트 통과, 밴드 파싱 불가면 예산 게이트 통과. */
function matches(brief, deal) {
  const catOk = !brief.categories?.length || brief.categories.includes(deal.category_id);
  const modeOk = /무관/.test(brief.mode || "") || brief.mode === deal.mode
    || (/자산/.test(brief.mode || "") && /자산/.test(deal.mode || ""));
  const regionOk = !brief.region_pref || !deal.region || brief.region_pref === deal.region;
  const bm = bandMax(brief.budget_band), rm = bandMax(deal.revenue_band);
  const budgetOk = bm == null || rm == null || bm >= rm * 0.5; // 예산이 매출 절반 이상이면 통과
  return catOk && modeOk && regionOk && budgetOk;
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
let briefs, deals, favorites, platforms, expiring, news, saved, categories, token;
let proposals, operators, subDecided, dealSubDecided, answered, stalePosts, staleDeals, qaAnswered;
if (FIXTURE) {
  const fs = await import("node:fs");
  const fx = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
  briefs = fx.briefs || []; deals = fx.deals || [];
  favorites = fx.favorites || []; platforms = fx.platforms || []; expiring = fx.expiring || [];
  news = fx.news || []; saved = fx.saved || []; categories = fx.categories || [];
  proposals = fx.proposals || []; operators = fx.operators || [];
  subDecided = fx.subDecided || []; dealSubDecided = fx.dealSubDecided || []; answered = fx.answered || [];
  stalePosts = fx.stalePosts || []; staleDeals = fx.staleDeals || []; qaAnswered = fx.qaAnswered || [];
} else {
  token = await login();
  await assertAdmin(token);
  briefs = await rest(token, "buyer_briefs?active=is.true&select=id,user_id,categories,budget_band,mode,region_pref");
  deals = await rest(token, "deals?status=eq.open&is_demo=is.false&select=id,category_id,mode,revenue_band,region,summary");
  favorites = await rest(token, "favorites?select=user_id,platform_id&limit=10000");
  // region·fee_band·blurb는 저장 검색(0030) 조건 매칭에 필요
  platforms = await rest(token, "platforms?select=id,name,category_id,is_new,region,fee_band,blurb&limit=5000");
  // 만료 임박 구독(0026 v_expiring_subs — admin 뷰). 뷰 미적용(마이그레이션 전) DB에서도 잡이 죽지 않게 폴백.
  expiring = await rest(token, "v_expiring_subs?select=user_id,plan_id,current_period_end").catch(() => []);
  // 최근 7일 수집된 플랫폼 소식(0027) — 미적용 DB 폴백. published_at은 결측 가능해 created_at(수집 시각) 기준.
  const since = new Date(Date.now() - 7 * 86400e3).toISOString();
  news = await rest(token, `platform_news?created_at=gte.${since}&select=id,platform_id,title&order=created_at.desc&limit=1000`).catch(() => []);
  // 저장된 검색(0030) — admin 봇이 전 조건 조회(RLS 'own saved read'의 is_admin 분기). 미적용 DB 폴백.
  saved = await rest(token, "saved_searches?select=id,user_id,label,criteria&limit=5000").catch(() => []);
  categories = await rest(token, "categories?select=id,name").catch(() => []);
  // R3 — 최근 30일 창(첫 도입 시 과거 전체 플러딩 방지; 멱등 unique로 조합당 1회 보장)
  const d30 = new Date(Date.now() - 30 * 86400e3).toISOString();
  proposals = await rest(token, `outreach_proposals?created_at=gte.${d30}&target_platform_id=not.is.null&select=id,target_platform_id,sender_name,type_id,subject`).catch(() => []);
  operators = await rest(token, "platform_operators?select=user_id,platform_id").catch(() => []);
  subDecided = await rest(token, `submissions?status=in.(approved,rejected)&created_at=gte.${d30}&select=id,user_id,status,review_reason,payload`).catch(() => []);
  dealSubDecided = await rest(token, `deal_submissions?status=in.(approved,rejected)&created_at=gte.${d30}&select=id,submitter_id,status,review_reason,approved_deal_id`).catch(() => []);
  answered = await rest(token, `inquiries?status=eq.answered&replied_at=gte.${d30}&select=id,user_id,title`).catch(() => []);
  // 수명 관리(0041) — 경과 판정(coalesce 갱신일)은 JS에서. 미적용 DB(refreshed_at 없음) 폴백.
  stalePosts = await rest(token, "partner_posts?status=eq.published&select=id,created_by,title,published_at,refreshed_at,created_at&limit=2000").catch(() => []);
  staleDeals = await rest(token, "deals?status=eq.open&is_demo=is.false&owner_id=not.is.null&select=id,owner_id,refreshed_at,created_at&limit=2000").catch(() => []);
  // 플랫폼 Q&A 답변 확정(0042) — 미적용 DB 폴백
  qaAnswered = await rest(token, `platform_questions?status=eq.answered&answered_at=gte.${d30}&select=id,asker_id,platform_id`).catch(() => []);
}
console.log(`활성 브리프 ${briefs.length} · 공개 매물 ${deals.length} · 즐겨찾기 ${favorites.length} · 플랫폼 ${platforms.length} · 만료 임박 구독 ${(expiring || []).length} · 최근 소식 ${(news || []).length} · 저장 검색 ${(saved || []).length} · 제안 ${(proposals || []).length} · 검수확정 ${(subDecided || []).length + (dealSubDecided || []).length} · 문의답변 ${(answered || []).length}`);

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

/* 2.7) 저장된 검색(0030) ↔ 신규 플랫폼 매칭 → search_match 알림.
 *      후보 풀 = is_new 플랫폼(알림은 본질적으로 "새 등재"만). 프론트 검색 필터를 복제해 매칭.
 *      region: DB(domestic/overseas)를 프론트 어휘(국내/해외)로 정규화. sort/onlyNew는 매칭 무관(후보가 이미 신규).
 *      ref_id=검색id:플랫폼id → 같은 조합은 재실행해도 1회만(멱등). 사용자당 상한. */
const SEARCH_MATCH_CAP = 5;
const catNameById = new Map((categories || []).map((c) => [c.id, c.name]));
const newPlatforms = platforms.filter((p) => p.is_new);
function platformMatchesCriteria(p, c) {
  if (c.cats?.length && !c.cats.includes(p.category_id)) return false;
  if (c.region && c.region !== "all") {
    const ko = p.region === "overseas" ? "해외" : "국내";
    if (ko !== c.region) return false;
  }
  if (c.fees?.length && (!p.fee_band || !c.fees.includes(p.fee_band))) return false;
  if (c.q) {
    const hay = `${p.name} ${p.blurb ?? ""} ${catNameById.get(p.category_id) ?? ""}`.toLowerCase();
    if (!c.q.toLowerCase().split(/\s+/).filter(Boolean).every((t) => hay.includes(t))) return false;
  }
  return true;
}
const savedByUser = new Map(); // user_id → count(상한)
for (const s of saved || []) {
  const c = s.criteria || {};
  let added = savedByUser.get(s.user_id) || 0;
  if (added >= SEARCH_MATCH_CAP) continue;
  for (const p of newPlatforms) {
    if (added >= SEARCH_MATCH_CAP) break;
    if (!platformMatchesCriteria(p, c)) continue;
    notifs.push({
      user_id: s.user_id, kind: "search_match", ref_type: "platform", ref_id: `${s.id}:${p.id}`,
      title: `저장한 검색 "${s.label}"에 새 플랫폼이 있어요`,
      body: `${p.name} — 조건에 맞는 신규 등재입니다. 상세에서 확인해보세요.`,
      url: `?view=detail&id=${p.id}`,
    });
    added++;
  }
  savedByUser.set(s.user_id, added);
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
/* 4) 받은 제휴 제안(R3) — 대상 플랫폼의 인증 운영자 전원에게. ref_id=제안 id(1회). */
const opsByPlatform = new Map(); // platform_id → [user_id]
for (const o of operators || []) { const a = opsByPlatform.get(o.platform_id) || []; a.push(o.user_id); opsByPlatform.set(o.platform_id, a); }
for (const pr of proposals || []) {
  for (const uid of opsByPlatform.get(pr.target_platform_id) || []) {
    notifs.push({
      user_id: uid, kind: "proposal", ref_type: "proposal", ref_id: pr.id,
      title: "내 플랫폼에 제휴 제안이 도착했어요",
      body: `${pr.sender_name} — ${(pr.subject || "").slice(0, 100)}`,
      url: "?view=account",
    });
  }
}

/* 5) 제보·매각 접수 검수 결과(R3) — 승인/반려 확정을 제출자에게. ref_id=접수 id(1회). */
for (const sub of subDecided || []) {
  if (!sub.user_id) continue;
  const nm = sub.payload?.name || "제보하신 플랫폼";
  notifs.push({
    user_id: sub.user_id, kind: "review_result", ref_type: "submission", ref_id: `sub:${sub.id}`,
    title: sub.status === "approved" ? `제보하신 "${nm}"이(가) 등재됐어요 🎉` : `제보하신 "${nm}" 검수 결과 안내`,
    body: sub.status === "approved" ? "검수를 통과해 디렉토리에 등재됐습니다. 참여 감사해요!"
      : `아쉽지만 반려됐어요${sub.review_reason ? ` — ${String(sub.review_reason).slice(0, 80)}` : ""}. 자세한 내용은 계정 → 내 제보에서.`,
    url: "?view=account",
  });
}
for (const ds of dealSubDecided || []) {
  if (!ds.submitter_id) continue;
  notifs.push({
    user_id: ds.submitter_id, kind: "review_result", ref_type: "deal_submission", ref_id: `deal:${ds.id}`,
    title: ds.status === "approved" ? `매각 접수가 게시됐어요 (${ds.approved_deal_id || "익명 리스팅"})` : "매각 접수 검수 결과 안내",
    body: ds.status === "approved" ? "익명 매물로 게시됐습니다 — 관심이 들어오면 다시 알려드려요."
      : `아쉽지만 반려됐어요${ds.review_reason ? ` — ${String(ds.review_reason).slice(0, 80)}` : ""}. 계정 → 내 활동에서 확인하세요.`,
    url: "?view=account",
  });
}

/* 6) 문의 답변(R3) — support 화면의 "답변이 등록되면 알림" 약속 이행. ref_id=문의 id(1회). */
for (const q of answered || []) {
  if (!q.user_id) continue;
  notifs.push({
    user_id: q.user_id, kind: "inquiry_reply", ref_type: "inquiry", ref_id: q.id,
    title: "문의하신 내용에 답변이 등록됐어요",
    body: `"${(q.title || "").slice(0, 80)}" — 문의·도움말에서 답변을 확인하세요.`,
    url: "?view=support",
  });
}

/* 7) 게시글 수명(0041) — 기준시각(갱신일 ?? 게시시각) 60일 경과 시 소유자에게 갱신 안내.
 * ref_id에 기준일을 포함해 갱신 주기당 1회만(갱신하면 기준일이 바뀌어 다음 주기에 다시 1회). */
const STALE_MS = 60 * 86400e3;
for (const p of stalePosts || []) {
  const base = new Date(p.refreshed_at || p.published_at || p.created_at).getTime();
  if (!(Date.now() - base >= STALE_MS)) continue;
  notifs.push({
    user_id: p.created_by, kind: "post_stale", ref_type: "partner_post",
    ref_id: `pp:${p.id}:${new Date(base).toISOString().slice(0, 10)}`,
    title: "제휴 제안이 게시 60일을 넘겼어요",
    body: `"${(p.title || "").slice(0, 60)}" — 계속 유효하면 계정 → 내 활동에서 갱신해 주세요. 90일 미갱신 시 보드에서 잠시 내려가요(갱신하면 복구).`,
    url: "?view=account",
  });
}
for (const d of staleDeals || []) {
  const base = new Date(d.refreshed_at || d.created_at).getTime();
  if (!(Date.now() - base >= STALE_MS)) continue;
  notifs.push({
    user_id: d.owner_id, kind: "post_stale", ref_type: "deal",
    ref_id: `deal:${d.id}:${new Date(base).toISOString().slice(0, 10)}`,
    title: `매물 ${d.id}이(가) 게시 60일을 넘겼어요`,
    body: "매각 의사가 유효하면 계정 → 내 활동에서 갱신해 주세요. 90일 미갱신 시 보드에서 잠시 내려가요(갱신하면 복구).",
    url: "?view=account",
  });
}

/* 8) 플랫폼 Q&A 답변(0042) — 질문 화면의 "답변이 등록되면 알림" 약속 이행. ref_id=질문 id(1회). */
const platName = new Map((platforms || []).map((p) => [p.id, p.name]));
for (const q of qaAnswered || []) {
  if (!q.asker_id) continue;
  notifs.push({
    user_id: q.asker_id, kind: "qa_answer", ref_type: "platform_question", ref_id: q.id,
    title: "질문하신 내용에 답변이 등록됐어요",
    body: `${platName.get(q.platform_id) || q.platform_id} 상세의 질문·답변에서 확인하세요 — 답변과 함께 공개 Q&A로 게시됐어요.`,
    url: `?view=detail&id=${q.platform_id}`,
  });
}

console.log(`알림 후보 ${notifs.length}건 (deal_match + cat_new + fav_news + search_match + sub_expiry + proposal + review_result + inquiry_reply + post_stale + qa_answer)`);

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
