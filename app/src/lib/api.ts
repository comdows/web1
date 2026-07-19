/* 데이터 접근 단일 지점 — API Spec(redesign/handoff/API Spec.md) §5 계약의 앱 구현.
 * VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY 가 설정되면 원격(Supabase PostgREST),
 * 없으면 로컬(JSON) 모드. 원격 실패 시 로컬로 폴백 → 백엔드 장애에도 발견 기능 유지. */
import { platforms, categories, categoryById } from "../data";
import type { Platform } from "../data";
import { getAccessToken, getSession, signOut } from "./auth";
import { sortByRelevance } from "./search";

const SB_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const SB_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
export const remoteEnabled = Boolean(SB_URL && SB_KEY);

/* 로그인 상태면 사용자 JWT, 아니면 anon 키로 호출(권한은 전적으로 RLS가 판정) */
export async function rest<T>(pathAndQuery: string, init?: RequestInit): Promise<T> {
  const token = (await getAccessToken()) ?? SB_KEY;
  const res = await fetch(`${SB_URL}/rest/v1/${pathAndQuery}`, {
    ...init,
    headers: {
      apikey: SB_KEY!,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    if (detail) console.warn(`API ${res.status} ${pathAndQuery.split("?")[0]}:`, detail); // 원문은 콘솔에만
    // 서버 RPC가 raise한 한국어 사유(P0001)는 그대로 노출 — '이미 활성 구독이 있습니다' 등이
    // 일반 문구('입력값을 확인해 주세요')로 뭉개지던 문제 수정. 내부 영어 에러는 계속 숨긴다.
    let serverMsg = "";
    try {
      const j = JSON.parse(detail) as { code?: string; message?: string };
      if (typeof j.message === "string" && (j.code === "P0001" || /[가-힣]/.test(j.message))) serverMsg = j.message;
    } catch { /* JSON 아님 — 일반 문구 사용 */ }
    // 세션이 있는데 401 = 만료·회수된 토큰(refresh는 통과했지만 REST가 거부한 잔여 케이스).
    // stale 세션에 갇히지 않게 정리하고 앱에 알린다(App.tsx 배너가 재로그인 유도).
    if (res.status === 401 && getSession()) {
      signOut();
      window.dispatchEvent(new CustomEvent("sm:session-expired"));
    }
    const msg = serverMsg || (res.status === 401 || res.status === 403 ? "권한이 없어요. 다시 로그인해 주세요."
      : res.status === 400 || res.status === 409 || res.status === 422 ? "입력값을 확인해 주세요."
      : res.status === 404 ? "대상을 찾을 수 없어요."
      : res.status === 429 ? "요청이 많아요. 잠시 후 다시 시도해 주세요."
      : "문제가 생겼어요. 잠시 후 다시 시도해 주세요.");
    const err = new Error(msg) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T; // return=minimal은 빈 본문
}

/* DB 행(region enum 영문) → 앱 Platform 형태로 변환 */
interface DbPlatform {
  id: string; name: string; category_id: string; region: "domestic" | "overseas";
  url: string; blurb: string; is_new: boolean;
  verified?: boolean; fee_band?: "low" | "mid" | "high" | null; fee_text?: string | null;
  settle_text?: string | null; enter_text?: string | null; strength?: string | null;
  link_status?: "ok" | "warn" | "dead" | null; link_checked_at?: string | null;
  ai_pricing?: "free" | "freemium" | "paid" | null;
}
const PLATFORM_COLS = "id,name,category_id,region,url,blurb,is_new,verified,fee_band,fee_text,settle_text,enter_text,strength,link_status,link_checked_at,ai_pricing";
const fromDb = (r: DbPlatform): Platform => ({
  id: r.id, name: r.name, category: r.category_id,
  region: r.region === "overseas" ? "해외" : "국내",
  url: r.url, blurb: r.blurb, new: r.is_new || undefined,
  verified: r.verified || undefined, fee_band: r.fee_band ?? undefined, fee_text: r.fee_text ?? undefined,
  settle_text: r.settle_text ?? undefined, enter_text: r.enter_text ?? undefined, strength: r.strength ?? undefined,
  link_status: r.link_status ?? undefined, link_checked_at: r.link_checked_at ?? undefined,
  ai_pricing: r.ai_pricing ?? undefined,
});

export interface SearchParams {
  q?: string; categories?: string[]; region?: "국내" | "해외" | "all";
  onlyNew?: boolean; sort?: "relevance" | "new" | "name"; limit?: number;
}

function searchLocal(p: SearchParams): Platform[] {
  const query = (p.q ?? "").trim().toLowerCase();
  let list = platforms.filter((x) => {
    if (p.categories?.length && !p.categories.includes(x.category)) return false;
    if (p.region && p.region !== "all" && x.region !== p.region) return false;
    if (p.onlyNew && !x.new) return false;
    if (query) {
      const hay = (x.name + " " + x.blurb + " " + (categoryById(x.category)?.name ?? "")).toLowerCase();
      if (!query.split(/\s+/).every((t) => hay.includes(t))) return false;
    }
    return true;
  });
  if (p.sort === "new") list = [...list].sort((a, b) => (b.new ? 1 : 0) - (a.new ? 1 : 0));
  else if (p.sort === "name") list = [...list].sort((a, b) => a.name.localeCompare(b.name, "ko"));
  else if (query) list = sortByRelevance(list, query);
  return list.slice(0, p.limit ?? 300);
}

export async function searchPlatforms(p: SearchParams): Promise<Platform[]> {
  if (!remoteEnabled) return searchLocal(p);
  try {
    const qs = new URLSearchParams({ select: PLATFORM_COLS });
    if (p.categories?.length) qs.set("category_id", `in.(${p.categories.join(",")})`);
    if (p.region && p.region !== "all") qs.set("region", `eq.${p.region === "해외" ? "overseas" : "domestic"}`);
    if (p.onlyNew) qs.set("is_new", "is.true");
    if (p.q?.trim()) qs.set("or", `(name.ilike.*${p.q.trim()}*,blurb.ilike.*${p.q.trim()}*)`);
    qs.set("order", p.sort === "name" ? "name.asc" : p.sort === "new" ? "is_new.desc,name.asc" : "name.asc");
    qs.set("limit", String(p.limit ?? 300));
    const rows = await rest<DbPlatform[]>(`platforms?${qs}`);
    return rows.map(fromDb);
  } catch { return searchLocal(p); } // 원격 실패 → 로컬 폴백
}

export async function getPlatform(id: string): Promise<(Platform & { similar: Platform[] }) | null> {
  const local = () => {
    const p = platforms.find((x) => x.id === id);
    if (!p) return null;
    return { ...p, similar: platforms.filter((x) => x.category === p.category && x.id !== p.id).slice(0, 6) };
  };
  if (!remoteEnabled) return local();
  try {
    const rows = await rest<DbPlatform[]>(`platforms?id=eq.${encodeURIComponent(id)}&select=${PLATFORM_COLS}`);
    if (!rows[0]) return null;
    const p = fromDb(rows[0]);
    const sim = await rest<DbPlatform[]>(`platforms?category_id=eq.${encodeURIComponent(p.category)}&id=neq.${encodeURIComponent(id)}&limit=6&select=${PLATFORM_COLS}`);
    return { ...p, similar: sim.map(fromDb) };
  } catch { return local(); }
}

/* 전체 플랫폼을 원격에서 로드(RLS로 archived/rejected 제외됨).
 * PostgREST 기본 max-rows(1000) 상한 → limit/offset 페이지네이션. 실패 시 정적 폴백. */
export async function fetchAllPlatforms(): Promise<Platform[]> {
  if (!remoteEnabled) return platforms;
  const pageSize = 1000;
  const out: Platform[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const rows = await rest<DbPlatform[]>(
      `platforms?select=${PLATFORM_COLS}&order=name.asc&limit=${pageSize}&offset=${offset}`
    );
    out.push(...rows.map(fromDb));
    if (rows.length < pageSize) break;
  }
  return out;
}

export async function getStats(): Promise<{ platforms: number; categories: number; newCount: number }> {
  const local = { platforms: platforms.length, categories: categories.length, newCount: platforms.filter((p) => p.new).length };
  if (!remoteEnabled) return local;
  try {
    const rows = await rest<{ platforms: number; categories: number; new_count: number }[]>("v_stats?select=*");
    return rows[0] ? { platforms: rows[0].platforms, categories: rows[0].categories, newCount: rows[0].new_count } : local;
  } catch { return local; }
}

/* ============================================================
 * P2 — 참여: 즐겨찾기 서버 동기화 · 플랫폼 제보 · 프로필
 * (모두 로그인 필요 — RLS가 user_id = auth.uid()를 강제)
 * ============================================================ */

export async function fetchServerFavs(): Promise<string[]> {
  const rows = await rest<{ platform_id: string }[]>("favorites?select=platform_id");
  return rows.map((r) => r.platform_id);
}
export async function upsertFavorite(platformId: string): Promise<void> {
  const uid = getSession()?.user.id;
  if (!uid) return;
  // alert=true: 즐겨찾기 = "이 플랫폼 링크가 죽으면 알려줘" 옵트인(헬스체크가 관심 등록자에게 알림).
  await rest("favorites?on_conflict=user_id,platform_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ user_id: uid, platform_id: platformId, alert: true }),
  });
}
export async function removeFavorite(platformId: string): Promise<void> {
  await rest(`favorites?platform_id=eq.${encodeURIComponent(platformId)}`, {
    method: "DELETE", headers: { Prefer: "return=minimal" },
  });
}

export interface CorrectionFields {
  fee_band?: string; fee_text?: string; settle_text?: string; enter_text?: string; strength?: string; url?: string;
}
export interface SubmissionPayload {
  name: string; url: string; category_id: string; region: "domestic" | "overseas"; desc: string; note?: string;
  confidence?: number; // 자동 수집기가 매긴 신뢰도(0~100) — 일괄 승인 우선순위 참고
  ai?: boolean;        // 수집기 AI 보강분(분야 분류·desc가 AI 생성 소개문) — 검수 화면 배지
  src_desc?: string;   // AI 보강 전 원문 설명(검수 참고용)
  // 정정 제안(기존 항목 판단 필드 교정·보강) — payload.kind로 검수 큐가 분기
  kind?: "correction";
  target_platform_id?: string;
  fields?: CorrectionFields;
  by_operator?: boolean; // 인증 운영자가 제출(높은 신뢰 — 우선 처리)
}
export interface Submission {
  id: string; payload: SubmissionPayload; status: "pending" | "hold" | "approved" | "rejected";
  review_reason: string | null; approved_platform_id: string | null; created_at: string;
}
export async function createSubmission(payload: SubmissionPayload): Promise<void> {
  const uid = getSession()?.user.id;
  if (!uid) throw new Error("로그인이 필요합니다");
  await rest("submissions", {
    method: "POST", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ payload, submitter_id: uid }),
  });
}
/* 기존 항목 정정·보강 제안 — 신규 등재와 같은 submissions 큐로(payload.kind='correction').
 * 인증 운영자면 by_operator=true(관리 큐에서 우선·신뢰 배지). 대상 식별정보는 표시용으로 payload에 함께 실음. */
export async function createCorrection(
  target: { id: string; name: string; url: string; category: string; region: string },
  fields: CorrectionFields, note: string, byOperator: boolean
): Promise<void> {
  return createSubmission({
    name: target.name, url: target.url, category_id: target.category,
    region: target.region === "해외" ? "overseas" : "domestic",
    desc: note, note: "correction", kind: "correction",
    target_platform_id: target.id, fields, by_operator: byOperator,
  });
}
export async function listMySubmissions(): Promise<Submission[]> {
  return rest<Submission[]>("submissions?select=id,payload,status,review_reason,approved_platform_id,created_at&order=created_at.desc&limit=50");
}
export async function updateDisplayName(name: string): Promise<void> {
  const uid = getSession()?.user.id;
  if (!uid) throw new Error("로그인이 필요합니다");
  await rest(`profiles?id=eq.${uid}`, {
    method: "PATCH", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ display_name: name }),
  });
}

/* ============================================================
 * P3 — 운영(관리자 전용 — RLS is_admin()이 강제, UI 노출은 편의일 뿐)
 * ============================================================ */

export async function listSubmissions(statuses: string[]): Promise<Submission[]> {
  return rest<Submission[]>(`submissions?status=in.(${statuses.join(",")})&select=id,payload,status,review_reason,approved_platform_id,created_at&order=created_at.asc&limit=100`);
}
export async function reviewSubmission(id: string, patch: {
  status: "approved" | "rejected" | "hold"; review_reason?: string; approved_platform_id?: string;
}): Promise<void> {
  const uid = getSession()?.user.id;
  await rest(`submissions?id=eq.${id}`, {
    method: "PATCH", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ ...patch, reviewed_by: uid, reviewed_at: new Date().toISOString() }),
  });
}
export async function createPlatform(row: {
  id: string; name: string; category_id: string; region: "domestic" | "overseas"; url: string; blurb: string;
  fee_band?: "low" | "mid" | "high" | null; fee_text?: string | null;
}): Promise<void> {
  await rest("platforms", {
    method: "POST", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ ...row, is_new: true, created_by: getSession()?.user.id ?? null }),
  });
}

export type Lifecycle = "soon" | "review" | "verified" | "matched" | "rejected";
/* 0001_schema.sql lifecycle_allowed()와 동일한 전이 맵(UI 표시용 — 서버가 재검증) */
export const LIFECYCLE_NEXT: Record<Lifecycle, Lifecycle[]> = {
  soon: ["review", "rejected"],
  review: ["verified", "soon", "rejected"],
  verified: ["matched", "review"],
  matched: ["verified"],
  rejected: ["soon"],
};
export async function getPlatformLifecycle(id: string): Promise<{ lifecycle: Lifecycle; verified: boolean } | null> {
  const rows = await rest<{ lifecycle: Lifecycle; verified: boolean }[]>(`platforms?id=eq.${encodeURIComponent(id)}&select=lifecycle,verified`);
  return rows[0] ?? null;
}
export async function transitionPlatform(id: string, to: Lifecycle, reason: string): Promise<void> {
  await rest("rpc/transition_platform", {
    method: "POST",
    body: JSON.stringify({ p_platform: id, p_to: to, p_reason: reason || null }),
  });
}
export async function getPopularSearches(): Promise<{ query: string; cnt: number }[]> {
  return rest<{ query: string; cnt: number }[]>("v_popular_searches?select=*");
}
export async function getPendingCount(): Promise<number> {
  // 개수만 필요 — count=exact 헤더로 본문 미전송(restCount). 이전엔 pending id 전량을 받아 length를 셌음.
  return restCount("submissions?status=eq.pending&select=id");
}

/* ============================================================
 * 2·3단계 오픈 — 제휴 보드 · 거래소 (0004_open.sql)
 * 공개 읽기는 익명 뷰(v_partner_posts_public / v_deals_public)로만.
 * ============================================================ */

export interface PartnerPost {
  id: string; title: string; category_id: string; type_id: string;
  give_text: string; get_text: string; want_categories: string[];
  size_text: string; detail: string; status: "published" | "matched"; posted: string | null;
  pro_verified?: boolean; // 작성자가 활성 Pro 구독자(0011 뷰 — boolean만, 익명성 유지)
  refreshed?: string | null; // 소유자 유효성 재확인일(0041 — 90일 미갱신 open은 뷰에서 제외)
}
/* 참조번호(표시용) — id에서 파생. 반익명 보드에서 신원 대신 제안을 지칭하는 수단(문의·소개 요청·검수 소통용) */
export const partnerRefCode = (id: string) => "P-" + id.replace(/-/g, "").slice(0, 4).toUpperCase();
export async function fetchPartnerPosts(): Promise<PartnerPost[]> {
  return rest<PartnerPost[]>("v_partner_posts_public?select=*&order=posted.desc.nullslast&limit=100");
}
export async function createPartnerPost(input: {
  title: string; category_id: string; type_id: string; give_text: string;
  get_text: string; want_categories: string[]; size_text: string; detail: string;
}): Promise<void> {
  const uid = getSession()?.user.id;
  if (!uid) throw new Error("로그인이 필요합니다");
  await rest("partner_posts", {
    method: "POST", headers: { Prefer: "return=minimal" },
    // contact_consent_at: 폼 필수 체크박스(매칭 확인 시 이메일 공유 동의) 시각 — B/C형 과금·소개의 전제
    body: JSON.stringify({ ...input, created_by: uid, contact_consent_at: new Date().toISOString() }),
  });
}
export async function applyToPartnerPost(postId: string, input: {
  platform_name: string; category_id?: string; size_text: string; pitch: string;
}): Promise<void> {
  const uid = getSession()?.user.id;
  if (!uid) throw new Error("로그인이 필요합니다");
  try {
    await rest("partner_post_interests", {
      method: "POST", headers: { Prefer: "return=minimal" },
      // contact_consent_at: 신청 폼의 필수 동의(매칭 확인 시 이메일 상호 공유) 시각
      body: JSON.stringify({ ...input, post_id: postId, user_id: uid, contact_consent_at: new Date().toISOString() }),
    });
  } catch (e) {
    if ((e as { status?: number }).status === 409) throw new Error("이미 이 제안에 신청했어요. 접수 후 세모플이 안내드립니다.");
    throw e;
  }
}

export interface PublicDeal {
  id: string; category_id: string; region: "domestic" | "overseas"; revenue_band: string;
  mode: string; summary: string; highlights: string[]; sale_reason: string | null;
  status: "open" | "in_progress"; is_demo: boolean; posted: string;
  owner_verified?: boolean; proofs?: string[]; // 0022 — 운영자 확인·준비 증빙 태그
  refreshed?: string | null; // 소유자 유효성 재확인일(0041)
}
export async function fetchDeals(): Promise<PublicDeal[]> {
  return rest<PublicDeal[]>("v_deals_public?select=*&order=posted.desc&limit=100");
}
/* 매물 단건(코드명 영구 링크용) — 없거나 마감이면 null */
export async function fetchDeal(id: string): Promise<PublicDeal | null> {
  const rows = await rest<PublicDeal[]>(`v_deals_public?id=eq.${encodeURIComponent(id)}&select=*&limit=1`).catch(() => [] as PublicDeal[]);
  return rows[0] ?? null;
}
export interface DealSubPayload {
  category_id: string; region: "domestic" | "overseas"; revenue_band: string;
  mode: string; summary: string; highlights: string; sale_reason: string;
  ack?: boolean; // 비중개(정보 게시·소개만) 확인 체크 — 오인 접수 방지 기록
  assets?: string[];             // 이전할 자산 체크리스트 — 게시 시 하이라이트 칩으로 합류
  proofs?: string[];             // 준비 증빙 유무 태그(매출·트래픽·상표 등 — 수치·가격 아님)
  handover?: string;             // 운영 인수인계(없음/1개월/3개월 동행)
  verify_note?: string;          // 비공개 검증 자료(URL·도메인 이메일) — 게시·공유 금지, 운영자 확인 전용
  contact_consent_at?: string;   // 매도자 이메일 공유 동의 시각(쌍방 확인 시 상대에게 공유)
}
export async function createDealSubmission(payload: DealSubPayload): Promise<void> {
  const uid = getSession()?.user.id;
  if (!uid) throw new Error("로그인이 필요합니다");
  await rest("deal_submissions", {
    method: "POST", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ payload, submitter_id: uid }),
  });
}
export async function createBuyerBrief(input: {
  categories: string[]; budget_band: string; mode: string; entity: string; note: string; region_pref?: string;
}): Promise<void> {
  const uid = getSession()?.user.id;
  if (!uid) throw new Error("로그인이 필요합니다");
  await rest("buyer_briefs", {
    method: "POST", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ ...input, user_id: uid }),
  });
}
export async function registerDealInterest(dealId: string, intro: string): Promise<void> {
  const uid = getSession()?.user.id;
  if (!uid) throw new Error("로그인이 필요합니다");
  try {
    await rest("deal_interests", {
      method: "POST", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ deal_id: dealId, user_id: uid, intro, contact_consent_at: new Date().toISOString() }),
    });
  } catch (e) {
    if ((e as { status?: number }).status === 409) throw new Error("이미 이 매물에 관심 등록했어요. 접수 후 세모플이 안내드립니다.");
    throw e;
  }
}

/* ── 제휴 수익화(0011) — 주문·수신함·스폰서·구독 (금액·상태 전이는 전부 서버 RPC) ── */
export interface MyPostInterest {
  id: string; post_id: string; post_title: string; platform_name: string;
  size_text: string; pitch: string; status: string; owner_confirmed_at: string | null; created_at: string;
}
export async function listInterestsOnMyPosts(): Promise<MyPostInterest[]> {
  return rest<MyPostInterest[]>("v_my_post_interests?select=*&order=created_at.desc&limit=100");
}
export async function respondToInterest(interestId: string, accept: boolean): Promise<void> {
  await rest("rpc/respond_to_interest", { method: "POST", body: JSON.stringify({ p_interest_id: interestId, p_accept: accept }) });
}
/* 주문 — 금액·할인·멱등(중복 주문 재사용)은 전부 서버가 판정. total은 안내 배너의 단일 소스 */
export interface OrderResult { id: string; total: number; reused: boolean }
/* 주문(무통장) — kind별 스위치·자격·가격 판정은 전부 서버(place_order RPC).
 * ref: listing_extend=매물 id(text), credit=패키지('50'|'100') — 0026 */
export async function placeOrder(
  kind: "boost" | "subscription" | "listing" | "listing_extend" | "credit",
  planId?: string, postId?: string, depositorHint?: string, ref?: string,
): Promise<OrderResult> {
  return rest<OrderResult>("rpc/place_order", {
    method: "POST",
    body: JSON.stringify({ p_kind: kind, p_plan_id: planId ?? null, p_post_id: postId ?? null, p_depositor_hint: depositorHint ?? null, p_ref: ref ?? null }),
  });
}
/* 내 구독(own RLS) — 만료일 표시·D-7 갱신 버튼용 */
export interface MySubscription { plan_id: string; status: string; current_period_end: string | null }
export async function listMySubscriptions(): Promise<MySubscription[]> {
  const uid = getSession()?.user.id;
  if (!uid) return [];
  return rest<MySubscription[]>(`subscriptions?user_id=eq.${uid}&status=in.(active,past_due)&select=plan_id,status,current_period_end`);
}
/* 내 크레딧 잔액(own credit ledger RLS) — 유효분(미만료)만 합산 */
export async function fetchMyCreditBalance(): Promise<number> {
  const uid = getSession()?.user.id;
  if (!uid) return 0;
  const rows = await rest<{ delta: number; expires_at: string | null }[]>(
    `credit_ledger?user_id=eq.${uid}&select=delta,expires_at`,
  ).catch(() => [] as { delta: number; expires_at: string | null }[]);
  const now = Date.now();
  return rows.filter((r) => !r.expires_at || new Date(r.expires_at).getTime() > now).reduce((s, r) => s + r.delta, 0);
}
/* 내 결제·청구 내역(own charges RLS) — 입금 대기 건은 계정 화면에서 계좌·기한을 다시 확인 */
export interface MyCharge {
  id: string; kind: string; status: string; amount: number; vat: number; fee_tier: string | null; memo: string | null;
  depositor_hint: string | null; deposit_deadline: string | null; discount_rate: number | null;
  refund_amount: number | null; created_at: string; paid_at: string | null; refunded_at: string | null;
}
export async function listMyCharges(): Promise<MyCharge[]> {
  const uid = getSession()?.user.id;
  if (!uid) return [];
  return rest<MyCharge[]>(`charges?user_id=eq.${uid}&select=id,kind,status,amount,vat,fee_tier,memo,depositor_hint,deposit_deadline,discount_rate,refund_amount,created_at,paid_at,refunded_at&order=created_at.desc&limit=20`);
}
export async function founderOptIn(): Promise<void> {
  const uid = getSession()?.user.id;
  if (!uid) throw new Error("로그인이 필요합니다");
  // 이미 신청한 경우 최초 시각을 보존(덮어쓰기 방지) — is.null 필터로 미설정 행만 갱신
  await rest(`profiles?id=eq.${uid}&founder_optin_at=is.null`, { method: "PATCH", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ founder_optin_at: new Date().toISOString() }) });
}
export interface SponsorSlotPublic {
  slot_no: number; id: string; title: string; category_id: string; type_id: string;
  give_text: string; get_text: string; want_categories: string[]; size_text: string; detail: string;
}
export async function fetchSponsorSlots(): Promise<SponsorSlotPublic[]> {
  return rest<SponsorSlotPublic[]>("v_sponsor_slots_public?select=*&order=slot_no.asc");
}
/* 관리자 청구 뷰(0012 v_admin_charges) — 입금 대기 큐·결제 완료·환불·슬롯 배정의 단일 데이터원 */
export interface AdminChargeRow {
  id: string; kind: string; status: string; amount: number; vat: number; fee_tier: string | null;
  memo: string | null; depositor_name: string | null; depositor_hint: string | null;
  deposit_deadline: string | null; discount_rate: number | null; refund_amount: number | null;
  refund_reason: string | null; created_at: string; paid_at: string | null; refunded_at: string | null;
  user_id: string | null; user_email: string | null; has_slot: boolean;
}
export async function listAdminCharges(): Promise<AdminChargeRow[]> {
  return rest<AdminChargeRow[]>("v_admin_charges?select=*&order=created_at.desc&limit=200");
}
export async function confirmDeposit(chargeId: string, depositor: string): Promise<void> {
  await rest("rpc/admin_confirm_deposit", { method: "POST", body: JSON.stringify({ p_charge_id: chargeId, p_depositor: depositor }) });
}
export async function cancelCharge(chargeId: string, reason?: string): Promise<void> {
  await rest("rpc/admin_cancel_charge", { method: "POST", body: JSON.stringify({ p_charge_id: chargeId, p_reason: reason ?? null }) });
}
export async function refundCharge(chargeId: string, amount: number, reason: string): Promise<void> {
  await rest("rpc/admin_refund_charge", { method: "POST", body: JSON.stringify({ p_charge_id: chargeId, p_amount: amount, p_reason: reason }) });
}
export interface SponsorSlotAdmin {
  id: string; slot_no: number; partner_post_id: string; sponsor_user_id: string;
  starts_on: string; ends_on: string; charge_id: string | null;
}
export async function listSponsorSlotsAdmin(): Promise<SponsorSlotAdmin[]> {
  return rest<SponsorSlotAdmin[]>("sponsor_slots?select=*&order=starts_on.desc&limit=50");
}
export async function createSponsorSlot(input: { slot_no: number; partner_post_id: string; sponsor_user_id: string; starts_on: string; ends_on: string; charge_id?: string }): Promise<void> {
  await rest("sponsor_slots", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(input) });
}
export interface SubscriptionAdmin {
  id: string; user_id: string; plan_id: string; status: string;
  current_period_end: string | null; price_snapshot: number | null; activated_at: string | null;
}
export async function listSubscriptionsAdmin(): Promise<SubscriptionAdmin[]> {
  return rest<SubscriptionAdmin[]>("subscriptions?select=*&order=current_period_end.asc.nullslast&limit=100");
}
export async function markOwnerConfirmed(kind: "partner" | "deal", interestId: string): Promise<void> {
  const table = kind === "partner" ? "partner_post_interests" : "deal_interests";
  // pending일 때만 — 거절·소개 완료된 건의 stale 화면 확인 방지
  await rest(`${table}?id=eq.${interestId}&status=eq.pending`, { method: "PATCH", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ owner_confirmed_at: new Date().toISOString() }) });
}
/* 관리자: 진행 불가 판정(메일 회신 거절·연락 두절·구버전 동의 없음 건 정리) */
export async function adminDeclineInterest(kind: "partner" | "deal", interestId: string): Promise<void> {
  const table = kind === "partner" ? "partner_post_interests" : "deal_interests";
  await rest(`${table}?id=eq.${interestId}&status=eq.pending`, { method: "PATCH", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ status: "declined" }) });
}
export async function adminIntroduce(kind: "partner" | "deal", interestId: string, evidence: string): Promise<void> {
  await rest("rpc/admin_introduce", { method: "POST", body: JSON.stringify({ p_kind: kind, p_interest_id: interestId, p_evidence: evidence }) });
}
export async function declinePendingInterests(postId: string): Promise<void> {
  await rest(`partner_post_interests?post_id=eq.${postId}&status=eq.pending`, {
    method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: "declined" }) });
}

/* ── 제휴 제안 아웃리치(0015) — 회원이 특정 플랫폼에 직접 제안 ── */
export interface OutreachConfig { server_send: boolean; from_name: string; daily_cap: number }
export async function fetchOutreachConfig(): Promise<OutreachConfig | null> {
  try {
    const rows = await rest<{ value: OutreachConfig }[]>("app_settings?key=eq.outreach&select=value");
    return rows[0]?.value ?? null;
  } catch { return null; }
}
export interface OutreachInput {
  target_platform_id: string; target_name: string; target_email: string;
  type_id: string; subject: string; body: string; sender_name: string;
}
/* 회원 본인 메일(mailto)로 보낸 제안을 기록(감사·현황). 서버 발송 off일 때의 경로. */
export async function recordOutreach(input: OutreachInput): Promise<void> {
  const uid = getSession()?.user.id;
  if (!uid) throw new Error("로그인이 필요합니다");
  await rest("outreach_proposals", { method: "POST", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ ...input, sender_id: uid, channel: "self", status: "composed" }) });
}
/* 서버 발송(Edge Function) — 스위치 on일 때만. 발송 성공/실패를 서버가 판정. */
export async function sendProposalServer(input: OutreachInput): Promise<{ ok?: boolean; id?: string; error?: string }> {
  const token = (await getAccessToken()) ?? SB_KEY;
  const res = await fetch(`${SB_URL}/functions/v1/send-proposal`, {
    method: "POST",
    headers: { apikey: SB_KEY!, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "발송에 실패했어요");
  return data;
}

/* ── 관리자: 검수 통지(0010) — 접수자 이메일 조회(v_admin_contact, is_admin만 행 반환) ── */
export async function getAdminContactEmail(kind: "submission" | "partner_post" | "deal_submission" | "operator_claim", ref: string): Promise<string | null> {
  const rows = await rest<{ email: string | null }[]>(`v_admin_contact?kind=eq.${kind}&ref=eq.${encodeURIComponent(ref)}&select=email`);
  return rows[0]?.email ?? null;
}

/* ── 관리자: 제휴·거래소 검수 큐 (RLS is_admin이 강제) ── */
export interface PartnerPostAdmin {
  id: string; title: string; category_id: string; type_id: string; give_text: string;
  get_text: string; want_categories: string[]; size_text: string; detail: string;
  status: "pending" | "published" | "matched" | "rejected" | "closed";
  review_reason: string | null; created_at: string;
  published_at?: string | null; refreshed_at?: string | null; // 수명 관리(0041 — listMyPartnerPosts만 조회)
}
export async function listPartnerPosts(statuses: string[]): Promise<PartnerPostAdmin[]> {
  return rest<PartnerPostAdmin[]>(`partner_posts?status=in.(${statuses.join(",")})&select=id,title,category_id,type_id,give_text,get_text,want_categories,size_text,detail,status,review_reason,created_at&order=created_at.asc&limit=100`);
}
export async function reviewPartnerPost(id: string, patch: { status: string; review_reason?: string }): Promise<void> {
  const uid = getSession()?.user.id;
  await rest(`partner_posts?id=eq.${id}`, {
    method: "PATCH", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ ...patch, reviewed_by: uid, ...(patch.status === "published" ? { published_at: new Date().toISOString() } : {}) }),
  });
}
export interface DealSubmissionRow {
  id: string; payload: Partial<DealSubPayload>; status: "pending" | "hold" | "approved" | "rejected";
  review_reason: string | null; submitter_id: string; created_at: string;
  approved_deal_id?: string | null;
}
export async function listDealSubmissions(statuses: string[]): Promise<DealSubmissionRow[]> {
  return rest<DealSubmissionRow[]>(`deal_submissions?status=in.(${statuses.join(",")})&select=id,payload,status,review_reason,submitter_id,created_at&order=created_at.asc&limit=100`);
}
export async function publishDeal(row: {
  id: string; category_id: string; region: "domestic" | "overseas"; revenue_band: string;
  mode: string; summary: string; highlights: string[]; sale_reason: string | null; owner_id: string;
  proofs?: string[]; owner_verified?: boolean;
}): Promise<void> {
  await rest("deals", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(row) });
}
/* 매물 운영자 확인 토글(admin — verify_note 검증 후) */
export async function setDealVerified(dealId: string, verified: boolean): Promise<void> {
  await rest(`deals?id=eq.${encodeURIComponent(dealId)}`, {
    method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ owner_verified: verified }),
  });
}

/* ── 매물 익명 Q&A(0022) — 질문 등록(본인), 공개는 answered만(신원 비노출 뷰) ── */
export interface DealQA { deal_id: string; question: string; answer: string | null; answered_at: string | null }
export async function fetchDealQuestions(dealId: string): Promise<DealQA[]> {
  return rest<DealQA[]>(`v_deal_questions_public?deal_id=eq.${encodeURIComponent(dealId)}&select=*&limit=20`).catch(() => []);
}
export async function askDealQuestion(dealId: string, question: string): Promise<void> {
  const uid = getSession()?.user.id;
  if (!uid) throw new Error("로그인이 필요합니다");
  await rest("deal_questions", {
    method: "POST", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ deal_id: dealId, asker_id: uid, question: question.trim() }),
  });
}
export interface PendingDealQ { id: string; deal_id: string; question: string; status: string; created_at: string }
export async function listPendingDealQuestions(): Promise<PendingDealQ[]> {
  return rest<PendingDealQ[]>("deal_questions?status=eq.pending&select=id,deal_id,question,status,created_at&order=created_at.asc&limit=100");
}
export async function answerDealQuestion(id: string, answer: string, hide = false): Promise<void> {
  await rest(`deal_questions?id=eq.${id}`, {
    method: "PATCH", headers: { Prefer: "return=minimal" },
    body: JSON.stringify(hide ? { status: "hidden" } : { answer: answer.trim(), status: "answered", answered_at: new Date().toISOString() }),
  });
}

/* ── 플랫폼 이용 후기(0025) — 게시는 검수(published) 후, 공개 뷰는 작성자 비노출 ── */
export interface PublicReview {
  platform_id: string; rating: number; body: string; created_at: string; id: string;
  operator_reply?: string | null; operator_replied_at?: string | null; // 0040 — 운영자 답글
}
/* 운영자 후기 답글(0040 RPC) — 본인 인증 플랫폼·게시 후기만, 빈 문자열이면 답글 삭제 */
export async function operatorReplyReview(reviewId: string, reply: string): Promise<void> {
  await rest("rpc/operator_reply_review", {
    method: "POST", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ p_review: reviewId, p_reply: reply }),
  });
}
/* ── 플랫폼 Q&A(0042 — P2) — 공개는 "답변된 질문"만(FAQ 자산화, 무응답 게시판 방지).
 * 질문은 익명(공개·운영자 뷰 모두 작성자 컬럼 없음), 유저당 플랫폼별 미답변 1개(DB unique). ── */
export interface PublicQA { id: string; platform_id: string; question: string; answer: string | null; answered_at: string | null }
export async function fetchPlatformQuestions(platformId: string): Promise<PublicQA[]> {
  return rest<PublicQA[]>(`v_platform_questions_public?platform_id=eq.${encodeURIComponent(platformId)}&select=*&limit=30`).catch(() => []);
}
export interface MyQuestionRow { id: string; question: string; status: "pending" | "answered" | "hidden"; created_at: string }
export async function listMyQuestionsFor(platformId: string): Promise<MyQuestionRow[]> {
  const uid = getSession()?.user.id;
  if (!uid) return [];
  return rest<MyQuestionRow[]>(`platform_questions?asker_id=eq.${uid}&platform_id=eq.${encodeURIComponent(platformId)}&select=id,question,status,created_at&order=created_at.desc&limit=10`).catch(() => []);
}
export async function askPlatformQuestion(platformId: string, question: string): Promise<void> {
  const uid = getSession()?.user.id;
  if (!uid) throw new Error("로그인이 필요해요.");
  try {
    await rest("platform_questions", {
      method: "POST", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ platform_id: platformId, asker_id: uid, question }),
    });
  } catch (e) {
    if ((e as { status?: number }).status === 409) throw new Error("이 플랫폼에 답변 대기 중인 질문이 이미 있어요 — 답변이 등록된 뒤 새 질문을 올릴 수 있어요.");
    throw e;
  }
}
export interface InboxQuestion { id: string; platform_id: string; question: string; created_at: string }
export async function fetchQuestionInbox(platformId?: string): Promise<InboxQuestion[]> {
  const q = platformId ? `platform_id=eq.${encodeURIComponent(platformId)}&` : "";
  return rest<InboxQuestion[]>(`v_platform_questions_inbox?${q}select=*&limit=50`).catch(() => []);
}
export async function answerPlatformQuestion(questionId: string, answer: string): Promise<void> {
  await rest("rpc/operator_answer_platform_question", {
    method: "POST", body: JSON.stringify({ p_question: questionId, p_answer: answer }),
  });
}
export async function fetchReviews(platformId: string): Promise<PublicReview[]> {
  return rest<PublicReview[]>(`v_reviews_public?platform_id=eq.${encodeURIComponent(platformId)}&select=*&limit=30`).catch(() => []);
}
export interface ReviewStat { avg_rating: number; review_count: number }
export async function fetchReviewStats(): Promise<Map<string, ReviewStat>> {
  const rows = await rest<({ platform_id: string } & ReviewStat)[]>("v_review_stats?select=*").catch(() => [] as ({ platform_id: string } & ReviewStat)[]);
  return new Map(rows.map((r) => [r.platform_id, { avg_rating: Number(r.avg_rating), review_count: Number(r.review_count) }]));
}
export interface MyReview { id: string; rating: number; body: string; status: "pending" | "published" | "hidden" }
export async function getMyReview(platformId: string): Promise<MyReview | null> {
  const uid = getSession()?.user.id;
  if (!uid) return null;
  const rows = await rest<MyReview[]>(`reviews?platform_id=eq.${encodeURIComponent(platformId)}&user_id=eq.${uid}&select=id,rating,body,status&limit=1`);
  return rows[0] ?? null;
}
/* 1인 1리뷰(unique) — 기존 리뷰가 있으면 갱신하되 재검수(pending)로 되돌린다(RLS도 강제) */
export async function submitReview(platformId: string, rating: number, body: string): Promise<void> {
  const uid = getSession()?.user.id;
  if (!uid) throw new Error("로그인이 필요합니다");
  const mine = await getMyReview(platformId);
  if (mine) {
    await rest(`reviews?id=eq.${mine.id}`, {
      method: "PATCH", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ rating, body: body.trim(), status: "pending" }),
    });
  } else {
    await rest("reviews", {
      method: "POST", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ platform_id: platformId, user_id: uid, rating, body: body.trim() }),
    });
  }
}
export interface PendingReview { id: string; platform_id: string; rating: number; body: string; created_at: string }
export async function listPendingReviews(): Promise<PendingReview[]> {
  return rest<PendingReview[]>("reviews?status=eq.pending&select=id,platform_id,rating,body,created_at&order=created_at.asc&limit=100");
}
export async function moderateReview(id: string, publish: boolean): Promise<void> {
  await rest(`reviews?id=eq.${id}`, {
    method: "PATCH", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ status: publish ? "published" : "hidden", reviewed_at: new Date().toISOString() }),
  });
}
/* 게시된 리뷰 사후 관리 — 재숨김은 위 moderateReview(id, false) 그대로 재사용 */
export async function listPublishedReviews(): Promise<PendingReview[]> {
  return rest<PendingReview[]>("reviews?status=eq.published&select=id,platform_id,rating,body,created_at&order=created_at.desc&limit=100");
}
/* 본인 리뷰 삭제(0028 own review delete) — 오게시·오타 정정의 최종 수단 */
export async function deleteMyReview(id: string): Promise<void> {
  await rest(`reviews?id=eq.${id}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
}

/* ── 신고(0028 reports) — 게시물 문제 신고: 접수는 회원, 처리는 관리 콘솔 큐 ── */
export type ReportTargetType = "review" | "partner_post" | "deal" | "platform_news" | "platform" | "platform_question";
export async function createReport(targetType: ReportTargetType, targetId: string, reason: string): Promise<void> {
  const uid = getSession()?.user.id;
  if (!uid) throw new Error("로그인이 필요합니다");
  try {
    await rest("reports", {
      method: "POST", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ reporter_id: uid, target_type: targetType, target_id: targetId, reason: reason.trim() }),
    });
  } catch (ex) {
    const s = (ex as { status?: number }).status;
    if (s === 409) throw new Error("이미 신고한 대상이에요 — 운영자가 순차 확인합니다.");
    if (s === 403) throw new Error("접수 한도(미처리 5건)를 초과했거나 접수가 제한된 계정이에요.");
    throw ex;
  }
}
export interface ReportRow {
  id: string; target_type: ReportTargetType; target_id: string; reason: string;
  status: "pending" | "resolved" | "dismissed"; resolve_note: string | null; created_at: string;
}
export async function listReports(): Promise<ReportRow[]> {
  return rest<ReportRow[]>("reports?status=eq.pending&select=id,target_type,target_id,reason,status,resolve_note,created_at&order=created_at.asc&limit=100");
}
export async function resolveReport(id: string, status: "resolved" | "dismissed", note: string): Promise<void> {
  await rest(`reports?id=eq.${id}`, {
    method: "PATCH", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ status, resolve_note: note.trim() || null, resolved_by: getSession()?.user.id ?? null, resolved_at: new Date().toISOString() }),
  });
}

/* ── 문의(0028 inquiries) — 인앱 접수·내역, 관리자 답변(답변 시 인앱 알림) ── */
export interface Inquiry {
  id: string; title: string; body: string; status: "open" | "answered" | "closed";
  reply: string | null; replied_at: string | null; created_at: string; user_id?: string;
}
export async function createInquiry(title: string, body: string): Promise<void> {
  const uid = getSession()?.user.id;
  if (!uid) throw new Error("로그인이 필요합니다");
  try {
    await rest("inquiries", {
      method: "POST", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ user_id: uid, title: title.trim(), body: body.trim() }),
    });
  } catch (ex) {
    if ((ex as { status?: number }).status === 403) throw new Error("답변 대기 중인 문의가 3건이에요 — 답변 후 다시 접수할 수 있어요.");
    throw ex;
  }
}
export async function listMyInquiries(): Promise<Inquiry[]> {
  if (!remoteEnabled || !getSession()) return [];
  const uid = getSession()!.user.id;
  return rest<Inquiry[]>(`inquiries?user_id=eq.${uid}&select=id,title,body,status,reply,replied_at,created_at&order=created_at.desc&limit=30`).catch(() => []);
}
export async function listOpenInquiries(): Promise<Inquiry[]> {
  return rest<Inquiry[]>("inquiries?status=eq.open&select=id,user_id,title,body,status,reply,replied_at,created_at&order=created_at.asc&limit=100");
}
export async function replyInquiry(id: string, userId: string, reply: string): Promise<void> {
  await rest(`inquiries?id=eq.${id}`, {
    method: "PATCH", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ reply: reply.trim(), status: "answered", replied_by: getSession()?.user.id ?? null, replied_at: new Date().toISOString() }),
  });
  // 인앱 알림(0018 — admin insert 정책·unique 멱등) — 재답변 시 중복 대신 병합
  await rest("notifications?on_conflict=user_id,kind,ref_id", {
    method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({
      user_id: userId, kind: "inquiry_reply", ref_type: "inquiry", ref_id: id,
      title: "문의에 답변이 등록됐어요", body: reply.trim().slice(0, 120), url: "?view=support",
    }),
  }).catch(() => { /* 알림 실패는 답변 자체를 되돌리지 않음 */ });
}
export async function reviewDealSubmission(id: string, patch: {
  status: "approved" | "rejected" | "hold"; review_reason?: string; approved_deal_id?: string;
}): Promise<void> {
  const uid = getSession()?.user.id;
  await rest(`deal_submissions?id=eq.${id}`, {
    method: "PATCH", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ ...patch, reviewed_by: uid, reviewed_at: new Date().toISOString() }),
  });
}
export interface InterestRow {
  id: string; status: string; created_at: string; pitch?: string; intro?: string;
  platform_name?: string; size_text?: string; post_id?: string; deal_id?: string;
  partner_posts?: { title: string } | null;
}
export async function listPartnerInterests(): Promise<InterestRow[]> {
  return rest<InterestRow[]>("partner_post_interests?status=eq.pending&select=id,status,created_at,pitch,platform_name,size_text,post_id,partner_posts(title)&order=created_at.asc&limit=100");
}
export async function listDealInterests(): Promise<InterestRow[]> {
  return rest<InterestRow[]>("deal_interests?status=eq.pending&select=id,status,created_at,intro,deal_id&order=created_at.asc&limit=100");
}
export async function markIntroduced(table: "partner_post_interests" | "deal_interests", id: string): Promise<void> {
  await rest(`${table}?id=eq.${id}`, {
    method: "PATCH", headers: { Prefer: "return=minimal" },
    // 이행 시각·주체 기록 — 향후 과금·'미이행 환불' 판정의 근거
    body: JSON.stringify({ status: "introduced", introduced_at: new Date().toISOString(), introduced_by: getSession()?.user.id ?? null }),
  });
}

/* 관리자 소개 큐(v_admin_intro_queue — is_admin만 행 반환): 양측 이메일 포함 */
export interface IntroQueueRow {
  kind: "partner" | "deal"; id: string; created_at: string; status: string;
  message: string; platform_name: string; target_title: string;
  applicant_email: string | null; counterpart_email: string | null;
  contact_consent_at: string | null; owner_confirmed_at: string | null;
}
/* 관리 콘솔 상단 요약 — 작업 큐별 대기 건수(한눈에 '뭐가 밀렸나'). 각 큐와 동일 필터. */
export interface QueueCounts { submission: number; partner: number; deal: number; operator: number; deposit: number; intro: number; report: number; inquiry: number }
export async function fetchQueueCounts(): Promise<QueueCounts> {
  // 개수만 필요 — count=exact 헤더로 본문 미전송(restCount). 이전엔 큐별 id를 최대 200행씩 받아 length를 셌음
  // (200 초과 시 200으로 잘려 실제 밀린 건수를 축소 표시) → 헤더 count로 전송량↓·정확도↑.
  const [submission, partner, deal, operator, deposit, intro, report, inquiry] = await Promise.all([
    restCount("submissions?status=in.(pending,hold)&select=id"),
    restCount("partner_posts?status=eq.pending&select=id"),
    restCount("deal_submissions?status=in.(pending,hold)&select=id"),
    restCount("operator_claims?status=in.(pending,code_sent)&select=id"),
    restCount("v_admin_charges?status=eq.awaiting_deposit&select=id"),
    restCount("v_admin_intro_queue?status=eq.pending&select=id"),
    restCount("reports?status=eq.pending&select=id"),
    restCount("inquiries?status=eq.open&select=id"),
  ]);
  return { submission, partner, deal, operator, deposit, intro, report, inquiry };
}
export async function listAdminIntroQueue(): Promise<IntroQueueRow[]> {
  return rest<IntroQueueRow[]>("v_admin_intro_queue?status=eq.pending&select=*&order=created_at.asc&limit=100");
}
/* ── 계정 자기결정권(0009) — 셀프 취소·마감·탈퇴 (권한은 전부 RLS/RPC가 판정) ── */
export async function cancelSubmission(id: string): Promise<void> {
  await rest(`submissions?id=eq.${id}&status=eq.pending`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
}
export async function cancelDealSubmission(id: string): Promise<void> {
  await rest(`deal_submissions?id=eq.${id}&status=eq.pending`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
}
export async function withdrawPartnerInterest(id: string): Promise<void> {
  await rest(`partner_post_interests?id=eq.${id}&status=eq.pending`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
}
export async function withdrawDealInterest(id: string): Promise<void> {
  await rest(`deal_interests?id=eq.${id}&status=eq.pending`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
}
export async function closeMyPost(postId: string): Promise<void> {
  await rest("rpc/close_my_post", { method: "POST", body: JSON.stringify({ p_post_id: postId }) });
}
export async function deleteMyAccount(): Promise<void> {
  await rest("rpc/delete_my_account", { method: "POST", body: "{}" });
}

/* ── 내 활동(본인 RLS + uid 필터 — admin 계정도 자기 것만) ── */
export async function listMyPartnerPosts(): Promise<PartnerPostAdmin[]> {
  const uid = getSession()?.user.id;
  if (!uid) return [];
  const base = `partner_posts?created_by=eq.${uid}&select=id,title,category_id,type_id,give_text,get_text,want_categories,size_text,detail,status,review_reason,created_at`;
  // 0041 미적용 DB(refreshed_at 없음)에서 내 활동 전체가 깨지지 않게 — 수명 컬럼 없이 재시도
  return rest<PartnerPostAdmin[]>(`${base},published_at,refreshed_at&order=created_at.desc&limit=50`)
    .catch(() => rest<PartnerPostAdmin[]>(`${base}&order=created_at.desc&limit=50`));
}
/* ── 게시글 수명 관리(0041) — 90일 미갱신 open 게시글은 공개 뷰에서 내려간다.
 * 갱신은 좁은 RPC(소유자·게시 상태만, refreshed_at만 변경) — "다시 게시"도 같은 호출(재노출). ── */
export interface MyDealRow { id: string; status: string; posted: string; refreshed_at: string | null; created_at: string }
export async function listMyOpenDeals(): Promise<MyDealRow[]> {
  const uid = getSession()?.user.id;
  if (!uid) return [];
  return rest<MyDealRow[]>(`deals?owner_id=eq.${uid}&status=in.(open,in_progress)&select=id,status,posted,refreshed_at,created_at&order=created_at.desc&limit=50`);
}
export async function refreshMyPartnerPost(postId: string): Promise<void> {
  await rest("rpc/refresh_my_partner_post", { method: "POST", body: JSON.stringify({ p_post_id: postId }) });
}
export async function refreshMyDeal(dealId: string): Promise<void> {
  await rest("rpc/refresh_my_deal", { method: "POST", body: JSON.stringify({ p_deal_id: dealId }) });
}
export async function listMyDealSubmissions(): Promise<DealSubmissionRow[]> {
  const uid = getSession()?.user.id;
  if (!uid) return [];
  return rest<DealSubmissionRow[]>(`deal_submissions?submitter_id=eq.${uid}&select=id,payload,status,review_reason,approved_deal_id,submitter_id,created_at&order=created_at.desc&limit=50`);
}
export interface MyInterestRow { id: string; post_id?: string; deal_id?: string; status: string; created_at: string; pitch?: string; intro?: string; partner_posts?: { title: string } | null }
export async function listMyPartnerInterests(): Promise<MyInterestRow[]> {
  const uid = getSession()?.user.id;
  if (!uid) return [];
  return rest<MyInterestRow[]>(`partner_post_interests?user_id=eq.${uid}&select=id,post_id,status,created_at,pitch,partner_posts(title)&order=created_at.desc&limit=50`);
}
export async function listMyDealInterests(): Promise<MyInterestRow[]> {
  const uid = getSession()?.user.id;
  if (!uid) return [];
  return rest<MyInterestRow[]>(`deal_interests?user_id=eq.${uid}&select=id,deal_id,status,created_at,intro&order=created_at.desc&limit=50`);
}
export async function listMyBriefs(): Promise<BuyerBriefRow[]> {
  const uid = getSession()?.user.id;
  if (!uid) return [];
  return rest<BuyerBriefRow[]>(`buyer_briefs?user_id=eq.${uid}&select=id,categories,budget_band,mode,entity,note,region_pref,active,created_at&order=created_at.desc&limit=50`);
}

/* 최신 코드명(D-###) — 매물 게시 기본값 제안용(세션 인덱스 대신 DB 기준).
 * id는 text PK라 사전순 정렬은 D-999 > D-1000 — 숫자 기준 최댓값을 클라이언트에서 계산 */
export async function fetchLatestDealCode(): Promise<string | null> {
  const rows = await rest<{ id: string }[]>("deals?select=id&limit=1000");
  let best: string | null = null; let bestN = -1;
  for (const r of rows) {
    const m = /^D-(\d+)$/.exec(r.id);
    if (m && Number(m[1]) > bestN) { bestN = Number(m[1]); best = r.id; }
  }
  return best;
}
/* 이미 게시된 매물의 소유자 확인(승인 재진입 판정용 — admin RLS) */
export async function getDealOwner(id: string): Promise<string | null> {
  const rows = await rest<{ owner_id: string | null }[]>(`deals?id=eq.${encodeURIComponent(id)}&select=owner_id`);
  return rows[0]?.owner_id ?? null;
}
/* 게시된 매물 상태 전이(모집중→진행중→마감) — closed는 공개 뷰에서 자동 제외 */
export async function updateDealStatus(id: string, status: "open" | "in_progress" | "closed"): Promise<void> {
  await rest(`deals?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status }),
  });
}
export async function listDealsAdmin(): Promise<{ id: string; status: string; summary: string; is_demo: boolean; category_id: string; mode: string; region?: "domestic" | "overseas"; owner_verified?: boolean }[]> {
  return rest("deals?select=id,status,summary,is_demo,category_id,mode,region,owner_verified&order=posted.desc&limit=100");
}

/* 브리프 ↔ 매물 조건 대조(클라이언트 매칭 — 분야 + 형태 + 지역).
 * 지역 게이트: 브리프 지역 선호가 없거나 매물 지역 정보가 없으면 통과(하위호환). */
export function briefMatchesDeal(
  b: { categories: string[]; mode: string; region_pref?: string },
  d: { category_id: string; mode: string; region?: string }
): boolean {
  const catOk = b.categories.length === 0 || b.categories.includes(d.category_id);
  const modeOk = /무관/.test(b.mode) || b.mode === d.mode || (/자산/.test(b.mode) && /자산/.test(d.mode));
  const regOk = !b.region_pref || !d.region || b.region_pref === d.region;
  return catOk && modeOk && regOk;
}
/* 브리프 안내 완료 처리(active=false — 0005 admin update 정책 필요) */
export async function deactivateBrief(id: string): Promise<void> {
  await rest(`buyer_briefs?id=eq.${id}`, {
    method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ active: false }),
  });
}

export interface BuyerBriefRow {
  id: string; categories: string[]; budget_band: string; mode: string; entity: string; note: string; region_pref?: string; active: boolean; created_at: string;
}
export async function listBuyerBriefs(): Promise<BuyerBriefRow[]> {
  return rest<BuyerBriefRow[]>("buyer_briefs?active=is.true&select=id,categories,budget_band,mode,entity,note,region_pref,active,created_at&order=created_at.desc&limit=100");
}

/* ── 관리자: 운영 지표(개수만 — count=exact 헤더, 본문 미전송) ── */
async function restCount(pathQ: string): Promise<number> {
  const token = (await getAccessToken()) ?? SB_KEY;
  const res = await fetch(`${SB_URL}/rest/v1/${pathQ}`, {
    headers: { apikey: SB_KEY!, Authorization: `Bearer ${token}`, Prefer: "count=exact", Range: "0-0" },
  });
  if (!res.ok) return 0;
  return parseInt((res.headers.get("content-range") ?? "0/0").split("/")[1], 10) || 0;
}
export interface AdminMetrics {
  members: number; favs: number; searches7d: number; outbound7d: number;
  livePosts: number; liveDeals: number; introduced: number;
}
export async function fetchAdminMetrics(): Promise<AdminMetrics> {
  const week = new Date(Date.now() - 7 * 86400000).toISOString();
  const [members, favs, searches7d, outbound7d, livePosts, liveDeals, introP, introD] = await Promise.all([
    restCount("profiles?select=id"),
    restCount("favorites?select=user_id"),
    restCount(`events?type=eq.search&created_at=gte.${week}&select=id`),
    restCount(`events?type=eq.outbound&created_at=gte.${week}&select=id`),
    restCount("partner_posts?status=in.(published,matched)&select=id"),
    restCount("deals?is_demo=is.false&status=neq.closed&select=id"),
    restCount("partner_post_interests?status=eq.introduced&select=id"),
    restCount("deal_interests?status=eq.introduced&select=id"),
  ]);
  return { members, favs, searches7d, outbound7d, livePosts, liveDeals, introduced: introP + introD };
}

/* ── 관리자: 운영 워크플로 헬스 — 수집·백업 등 예약 잡의 최근 실행 상태 ──
 * 리포가 public이라 무인증 GitHub API를 관리자 브라우저에서 직접 조회(DB·시크릿 불요).
 * 배경: 수집기가 봇 토큰 누락으로 여러 런 조용히 실패한 사고(#140) — "조용한 실패"를 콘솔에서 보이게.
 * 비인증 rate limit(60/h/IP)은 콘솔 진입당 6요청이라 여유. 실패는 null(카드에 '확인 불가'). */
export interface OpsRun {
  file: string; label: string; staleDays: number;
  conclusion: string | null;   // success | failure | ... | null(실행 중 또는 조회 실패)
  startedAt: string | null; url: string | null;
}
const OPS_WORKFLOWS: Pick<OpsRun, "file" | "label" | "staleDays">[] = [
  { file: "collect.yml",     label: "수집기 (주3회)",    staleDays: 4 },
  { file: "digest.yml",      label: "다이제스트 (매일)",  staleDays: 2 },
  { file: "notify.yml",      label: "알림 매칭 (매일)",   staleDays: 2 },
  { file: "backup.yml",      label: "백업 (주1회)",      staleDays: 9 },
  { file: "metrics.yml",     label: "주간 지표 (주1회)",  staleDays: 9 },
  { file: "healthcheck.yml", label: "링크 점검 (월1회)",  staleDays: 33 },
];
export async function fetchOpsHealth(): Promise<OpsRun[]> {
  return Promise.all(OPS_WORKFLOWS.map(async (w) => {
    try {
      const res = await fetch(`https://api.github.com/repos/comdows/web1/actions/workflows/${w.file}/runs?per_page=1`);
      if (!res.ok) throw new Error(String(res.status));
      const j = await res.json() as { workflow_runs?: { conclusion: string | null; run_started_at: string; html_url: string }[] };
      const r = j.workflow_runs?.[0];
      return { ...w, conclusion: r?.conclusion ?? null, startedAt: r?.run_started_at ?? null, url: r?.html_url ?? null };
    } catch { return { ...w, conclusion: null, startedAt: null, url: null }; }
  }));
}

/* ── 관리자: 투어 계측 집계(G6) — events(entity_type='tour')의 최근 기록을 클라에서 집계.
 * query 형식: tour:<id>:auto|manual(시작) · tour:<id>:end:n/N(종료·도달 스텝). RLS admin-only 읽기. */
export interface TourStat { id: string; starts: number; ends: number; completes: number }
export async function fetchTourStats(): Promise<TourStat[]> {
  const rows = await rest<{ query: string | null }[]>("events?entity_type=eq.tour&select=query&order=created_at.desc&limit=1000");
  const m = new Map<string, TourStat>();
  for (const r of rows) {
    const mt = (r.query || "").match(/^tour:([a-z-]+):(auto|manual|end:(\d+)\/(\d+))$/);
    if (!mt) continue;
    const st = m.get(mt[1]) ?? { id: mt[1], starts: 0, ends: 0, completes: 0 };
    if (mt[2] === "auto" || mt[2] === "manual") st.starts++;
    else { st.ends++; if (mt[3] === mt[4]) st.completes++; }
    m.set(mt[1], st);
  }
  return [...m.values()].sort((a, b) => b.starts - a.starts);
}

/* ── 관리자: 회원 조회·정지(0028 v_admin_members + admin_set_suspended RPC) ── */
export interface AdminMember {
  id: string; email: string | null; display_name: string | null; role: string;
  suspended_at: string | null; created_at: string;
  submissions: number; partner_posts: number; deal_subs: number; reviews: number;
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export async function searchAdminMembers(q: string): Promise<AdminMember[]> {
  const v = q.trim();
  if (!v) return [];
  const filter = UUID_RE.test(v)
    ? `id=eq.${v}`
    : `or=(email.ilike.*${encodeURIComponent(v)}*,display_name.ilike.*${encodeURIComponent(v)}*)`;
  return rest<AdminMember[]>(`v_admin_members?${filter}&select=*&limit=20`);
}
export async function setMemberSuspended(userId: string, suspend: boolean): Promise<void> {
  await rest("rpc/admin_set_suspended", {
    method: "POST", body: JSON.stringify({ p_user: userId, p_suspend: suspend }),
  });
}

/* ── 공지(R2) — app_settings 'notice' {text, until}. 읽기는 공개 정책(비로그인 포함), 쓰기는 admin.
 * 기존 updateAppSetting은 PATCH라 미존재 키에 무효 — 공지는 upsert(POST merge-duplicates)로. ── */
export interface SiteNotice { text: string; until: string | null }
export async function getNotice(): Promise<SiteNotice | null> {
  const rows = await rest<{ value: { text?: string; until?: string | null } }[]>("app_settings?key=eq.notice&select=value");
  const v = rows[0]?.value;
  return v && typeof v.text === "string" && v.text.trim() ? { text: v.text, until: v.until ?? null } : null;
}
export async function setNotice(text: string, until: string | null): Promise<void> {
  await rest("app_settings", {
    method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ key: "notice", value: { text: text.trim(), until } }),
  });
}

/* ── 소식 수기 추가(R2) — platform_news admin insert 정책(0027). 수집기와 동일 테이블·URL unique. ── */
export async function addPlatformNews(input: { platform_id: string; title: string; url: string; source: string }): Promise<void> {
  await rest("platform_news", {
    method: "POST", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ ...input, published_at: new Date().toISOString() }),
  });
}

/* ── 관리자: 운영 스위치(app_settings — admin write RLS는 0011) ── */
export interface AppSetting { key: string; value: Record<string, unknown> }
export async function listAppSettings(): Promise<AppSetting[]> {
  return rest<AppSetting[]>("app_settings?select=key,value&order=key.asc");
}
export async function updateAppSetting(key: string, value: Record<string, unknown>): Promise<void> {
  await rest(`app_settings?key=eq.${encodeURIComponent(key)}`, {
    method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ value }),
  });
}

/* ── 자동 수집(autolist) 스위치 콘솔 관리(0016 app_settings — admin write RLS) ──
 * 켜면 수집기가 directUrl·고신뢰(≥min) 후보를 자동 등재(lifecycle=review, 사후 검수 큐로). collector_id는
 * 수집 봇 uid(최근 auto 제보에서 감지)여야 서버 RPC(auto_list_candidate)가 통과시킨다. 기본 off. */
export interface AutolistConfig { enabled: boolean; min_confidence: number; collector_id: string | null }
const AUTOLIST_DEFAULT: AutolistConfig = { enabled: false, min_confidence: 80, collector_id: null };
export async function getAutolistConfig(): Promise<AutolistConfig> {
  try {
    const rows = await rest<{ value: Partial<AutolistConfig> }[]>("app_settings?key=eq.autolist&select=value");
    return { ...AUTOLIST_DEFAULT, ...(rows[0]?.value ?? {}) };
  } catch { return AUTOLIST_DEFAULT; }
}
export async function setAutolistConfig(cfg: AutolistConfig): Promise<void> {
  const min = Math.max(50, Math.min(100, Math.round(cfg.min_confidence || 80)));
  await updateAppSetting("autolist", { enabled: !!cfg.enabled, min_confidence: min, collector_id: cfg.collector_id });
}
/* 수집 봇 uid 감지 — 최근 자동 수집 제보(payload.note가 'auto:'로 시작)의 submitter_id(admin RLS로 열람). */
export async function detectCollectorId(): Promise<string | null> {
  try {
    const rows = await rest<{ submitter_id: string | null }[]>(
      "submissions?payload->>note=ilike.auto:*&select=submitter_id&order=created_at.desc&limit=1");
    return rows[0]?.submitter_id ?? null;
  } catch { return null; }
}

/* ── 관리자: 최근 처리 내역 — 별도 테이블 없이 각 큐의 처리분을 모아 보여준다(분쟁·문의 대응 근거) ── */
export interface ProcessedItem { kind: string; id: string; label: string; status: string; reason: string | null; at: string }
export async function listRecentProcessed(): Promise<ProcessedItem[]> {
  const safe = <T,>(p: Promise<T[]>) => p.catch(() => [] as T[]);
  const [subs, posts, deals, reviews] = await Promise.all([
    safe(rest<{ id: string; payload: { name?: string }; status: string; review_reason: string | null; reviewed_at: string | null }[]>(
      "submissions?status=in.(approved,rejected,hold)&select=id,payload,status,review_reason,reviewed_at&order=reviewed_at.desc.nullslast&limit=30")),
    safe(rest<{ id: string; title: string; status: string; review_reason: string | null; reviewed_at: string | null; created_at: string }[]>(
      "partner_posts?status=in.(published,rejected,closed,matched)&select=id,title,status,review_reason,reviewed_at,created_at&order=created_at.desc&limit=30")),
    safe(rest<{ id: string; approved_deal_id: string | null; payload: { summary?: string }; status: string; review_reason: string | null; reviewed_at: string | null }[]>(
      "deal_submissions?status=in.(approved,rejected)&select=id,approved_deal_id,payload,status,review_reason,reviewed_at&order=reviewed_at.desc.nullslast&limit=30")),
    safe(rest<{ id: string; platform_id: string; status: string; reviewed_at: string | null }[]>(
      "reviews?status=in.(published,hidden)&select=id,platform_id,status,reviewed_at&order=reviewed_at.desc.nullslast&limit=30")),
  ]);
  const items: ProcessedItem[] = [
    ...subs.map((s) => ({ kind: "제보", id: s.id, label: s.payload?.name ?? "(이름 없음)", status: s.status, reason: s.review_reason, at: s.reviewed_at ?? "" })),
    ...posts.map((p) => ({ kind: "제휴", id: p.id, label: p.title, status: p.status, reason: p.review_reason, at: p.reviewed_at ?? p.created_at })),
    ...deals.map((d) => ({ kind: "매각", id: d.id, label: d.approved_deal_id ?? ((d.payload?.summary ?? "").slice(0, 30) || d.id.slice(0, 8)), status: d.status, reason: d.review_reason, at: d.reviewed_at ?? "" })),
    ...reviews.map((r) => ({ kind: "리뷰", id: r.id, label: r.platform_id, status: r.status, reason: null, at: r.reviewed_at ?? "" })),
  ];
  return items.sort((a, b) => (b.at || "").localeCompare(a.at || "")).slice(0, 60);
}

/* ── 인앱 알림(0018) — 본인 알림 열람·읽음 처리(생성은 봇 잡이 admin으로) ── */
export interface Notification {
  id: string; kind: string; ref_type: string | null; ref_id: string | null;
  title: string; body: string; url: string | null; read_at: string | null; created_at: string;
}
export async function listNotifications(): Promise<Notification[]> {
  if (!remoteEnabled || !getSession()) return [];
  return rest<Notification[]>("notifications?select=*&order=created_at.desc&limit=50").catch(() => []);
}
export async function unreadNotifCount(): Promise<number> {
  if (!remoteEnabled || !getSession()) return 0;
  return restCount("notifications?read_at=is.null&select=id").catch(() => 0);
}
export async function markNotifRead(id: string): Promise<void> {
  await rest(`notifications?id=eq.${id}`, { method: "PATCH", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ read_at: new Date().toISOString() }) });
}
export async function markAllNotifsRead(): Promise<void> {
  await rest("notifications?read_at=is.null", { method: "PATCH", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ read_at: new Date().toISOString() }) });
}

/* ── 저장된 검색(0030) — 검색 조건 저장·구독. 신규 매칭 시 notify.mjs가 search_match 알림 ── */
export interface SearchCriteria { q?: string; cats?: string[]; region?: string; onlyNew?: boolean; fees?: string[] }
export interface SavedSearch { id: string; label: string; criteria: SearchCriteria; created_at: string }
export async function listSavedSearches(): Promise<SavedSearch[]> {
  if (!remoteEnabled || !getSession()) return [];
  return rest<SavedSearch[]>("saved_searches?select=id,label,criteria,created_at&order=created_at.desc&limit=20").catch(() => []);
}
export async function createSavedSearch(label: string, criteria: SearchCriteria): Promise<void> {
  const uid = getSession()?.user.id;
  if (!uid) throw new Error("로그인이 필요합니다");
  try {
    await rest("saved_searches", {
      method: "POST", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ user_id: uid, label: label.slice(0, 80), criteria }),
    });
  } catch (ex) {
    const s = (ex as { status?: number }).status;
    if (s === 409) throw new Error("같은 이름의 저장 검색이 이미 있어요.");
    if (s === 403) throw new Error("저장 검색은 20개까지예요 — 오래된 것을 지우고 다시 저장해 주세요.");
    throw ex;
  }
}
export async function deleteSavedSearch(id: string): Promise<void> {
  await rest(`saved_searches?id=eq.${id}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
}

/* ── 관심 프로필 서버화(0031) — 온보딩 관심을 기기 간 동기화(즐겨찾기와 동형) ── */
export interface ServerInterests { groups: string[]; cats: string[]; new_pref: boolean }
export async function fetchMyInterests(): Promise<ServerInterests | null> {
  const uid = getSession()?.user.id;
  if (!remoteEnabled || !uid) return null;
  const rows = await rest<ServerInterests[]>(`user_interests?user_id=eq.${uid}&select=groups,cats,new_pref`).catch(() => []);
  return rows[0] ?? null;
}
export async function saveMyInterests(i: { groups: string[]; cats: string[]; newPref: boolean }): Promise<void> {
  const uid = getSession()?.user.id;
  if (!remoteEnabled || !uid) return;
  await rest("user_interests?on_conflict=user_id", {
    method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ user_id: uid, groups: i.groups, cats: i.cats, new_pref: i.newPref, updated_at: new Date().toISOString() }),
  }).catch(() => { /* 동기화 실패해도 로컬 관심은 동작 */ });
}

/* ── 소개 후 성사·후기(0021) — 본인 응답 기록/조회(재응답=갱신) ── */
export type IntroOutcomeKind = "progressing" | "success" | "no";
export async function listMyIntroOutcomes(): Promise<Map<string, IntroOutcomeKind>> {
  if (!remoteEnabled || !getSession()) return new Map();
  const rows = await rest<{ ref_type: string; ref_id: string; outcome: IntroOutcomeKind }[]>(
    "intro_outcomes?select=ref_type,ref_id,outcome").catch(() => []);
  return new Map(rows.map((r) => [`${r.ref_type}:${r.ref_id}`, r.outcome]));
}
export async function recordIntroOutcome(refType: "partner" | "deal", refId: string, outcome: IntroOutcomeKind, note = ""): Promise<void> {
  const uid = getSession()?.user.id;
  if (!uid) throw new Error("로그인이 필요합니다");
  await rest("intro_outcomes?on_conflict=ref_type,ref_id,user_id", {
    method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ ref_type: refType, ref_id: refId, user_id: uid, outcome, note }),
  });
}

/* ── 관리자: 7일 퍼널·유입경로(0017 뷰 — is_admin 가드는 뷰 내부) ── */
export interface Funnel7d {
  impressions: number; clicks: number; outbounds: number; searches: number;
  favorites: number; sessions: number; logged_in: number;
}
export async function fetchFunnel(): Promise<Funnel7d | null> {
  const rows = await rest<Funnel7d[]>("v_funnel_7d?select=*").catch(() => []);
  return rows[0] ?? null;
}
export async function fetchReferrers(): Promise<{ ref: string; sessions: number; events: number }[]> {
  return rest<{ ref: string; sessions: number; events: number }[]>("v_referrers_7d?select=*").catch(() => []);
}
/* ── 관리자: 성장 시계열·리텐션·머니패스(0034 뷰 — is_admin 가드는 뷰 내부) ── */
export interface GrowthWeek {
  week_start: string; sessions: number; new_sessions: number; returning_sessions: number; wau_users: number;
  searches: number; outbounds: number; deal_views: number; briefs_created: number; interests_created: number;
  intros_done: number; platforms_total: number; note: string | null; live: boolean;
}
export async function fetchGrowthWeekly(): Promise<GrowthWeek[]> {
  return rest<GrowthWeek[]>("v_growth_weekly?select=*&order=week_start.asc").catch(() => []);
}
export interface CohortCell { cohort_week: string; week_offset: number; sessions: number }
export async function fetchRetentionCohorts(): Promise<CohortCell[]> {
  return rest<CohortCell[]>("v_retention_cohorts?select=*&order=cohort_week.asc,week_offset.asc").catch(() => []);
}
export interface MoneyFunnel { deal_view_sessions: number; briefs: number; interests: number; intros: number }
export async function fetchMoneyFunnel(): Promise<MoneyFunnel | null> {
  const rows = await rest<MoneyFunnel[]>("v_money_funnel_30d?select=*").catch(() => [] as MoneyFunnel[]);
  return rows[0] ?? null;
}
/* 소개 성사율(0021 v_intro_success — 관리 전용, 뷰 내부 is_admin 가드) */
export async function fetchIntroSuccess(): Promise<{ responded: number; success: number; progressing: number; no_deal: number } | null> {
  const rows = await rest<{ responded: number; success: number; progressing: number; no_deal: number }[]>("v_intro_success?select=*").catch(() => []);
  return rows[0] ?? null;
}

/* ── 관리자: 플랫폼 인라인 편집 + 정보 보강 큐 (admin write platforms RLS) ── */
export async function getPlatformFull(id: string): Promise<Platform | null> {
  const rows = await rest<DbPlatform[]>(`platforms?id=eq.${encodeURIComponent(id)}&select=${PLATFORM_COLS}`);
  return rows[0] ? fromDb(rows[0]) : null;
}
export async function updatePlatform(id: string, patch: {
  name?: string; url?: string; blurb?: string; fee_band?: "low" | "mid" | "high" | null;
  fee_text?: string | null; settle_text?: string | null; enter_text?: string | null; strength?: string | null;
}): Promise<void> {
  await rest(`platforms?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(patch),
  });
}
/* ── 자동 등재(D) 사후 검수 — auto_listed 플랫폼 목록 + 확정/내리기 ── */
export interface AutoListedRow {
  id: string; name: string; category_id: string; region: "domestic" | "overseas";
  url: string; blurb: string; auto_listed_at: string;
}
export async function listAutoListed(): Promise<AutoListedRow[]> {
  return rest<AutoListedRow[]>(
    "platforms?auto_listed=is.true&lifecycle=eq.review&archived_at=is.null" +
    "&select=id,name,category_id,region,url,blurb,auto_listed_at&order=auto_listed_at.desc&limit=100");
}
export async function reviewAutoListed(id: string, keep: boolean, reason?: string): Promise<void> {
  await rest("rpc/review_auto_listed", {
    method: "POST", body: JSON.stringify({ p_id: id, p_keep: keep, p_reason: reason ?? null }),
  });
}

/* 최근 30일 외부클릭 상위 — 수수료 미기재와 교차해 "보강 우선순위" 산출(admin read events RLS) */
export async function fetchOutboundCounts(days = 30): Promise<Map<string, number>> {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const rows = await rest<{ platform_id: string | null }[]>(
    `events?type=eq.outbound&created_at=gte.${since}&select=platform_id&limit=5000`);
  const m = new Map<string, number>();
  for (const r of rows) { if (r.platform_id) m.set(r.platform_id, (m.get(r.platform_id) ?? 0) + 1); }
  return m;
}

/* 공개 인기 집계(0019 v_platform_popularity) — 검색·추천의 2차 신호. platform_id→score.
 * 원격 아니거나 실패 시 빈 Map(랭킹은 관련도만으로 degrade). */
export async function fetchPopularity(): Promise<Map<string, number>> {
  if (!remoteEnabled) return new Map();
  try {
    const rows = await rest<{ platform_id: string; score: number }[]>("v_platform_popularity?select=platform_id,score&limit=5000");
    return new Map(rows.map((r) => [r.platform_id, Number(r.score) || 0]));
  } catch { return new Map(); }
}

/* 최근 등재(주간 다이제스트) — created_at 포함, 실패 시 정적 신규 폴백 */
export async function fetchRecentPlatforms(limit = 60): Promise<{ p: Platform; created: string }[]> {
  const local = () => platforms.filter((x) => x.new).slice(0, limit).map((p) => ({ p, created: "" }));
  if (!remoteEnabled) return local();
  try {
    const rows = await rest<(DbPlatform & { created_at: string })[]>(
      `platforms?select=${PLATFORM_COLS},created_at&order=created_at.desc&limit=${limit}`
    );
    return rows.map((r) => ({ p: fromDb(r), created: r.created_at }));
  } catch { return local(); }
}

/* ── 운영자 클레임 (operator_claims / platform_operators — 0001 스키마 재사용) ──
 * 플랫폼 운영자가 "우리 플랫폼"을 인증 신청 → 관리자 승인 시 운영자 지정 + 검증 배지 */
export interface OperatorClaim {
  id: string; platform_id: string; business_email: string | null;
  status: "pending" | "code_sent" | "verified" | "rejected"; created_at: string;
  platforms?: { name: string; url: string } | null;
}
export async function createOperatorClaim(platformId: string, businessEmail: string): Promise<void> {
  const uid = getSession()?.user.id;
  if (!uid) throw new Error("로그인이 필요합니다");
  await rest("operator_claims", {
    method: "POST", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ platform_id: platformId, user_id: uid, method: "email", business_email: businessEmail }),
  });
}
export async function getMyClaim(platformId: string): Promise<OperatorClaim | null> {
  const uid = getSession()?.user.id;
  if (!uid) return null;
  const rows = await rest<OperatorClaim[]>(`operator_claims?platform_id=eq.${encodeURIComponent(platformId)}&user_id=eq.${uid}&select=id,platform_id,business_email,status,created_at&order=created_at.desc&limit=1`);
  return rows[0] ?? null;
}
export async function amOperatorOf(platformId: string): Promise<boolean> {
  const uid = getSession()?.user.id;
  if (!uid) return false;
  const rows = await rest<{ platform_id: string }[]>(`platform_operators?platform_id=eq.${encodeURIComponent(platformId)}&user_id=eq.${uid}&select=platform_id`);
  return rows.length > 0;
}
/* 관리자: 대기 클레임 목록(플랫폼 이름·URL 조인) + 승인/반려 */
export async function listOperatorClaims(): Promise<(OperatorClaim & { user_id: string })[]> {
  return rest(`operator_claims?status=in.(pending,code_sent)&select=id,platform_id,user_id,business_email,status,created_at,platforms(name,url)&order=created_at.asc&limit=100`);
}
export async function reviewOperatorClaim(c: { id: string; platform_id: string; user_id: string }, approve: boolean): Promise<void> {
  const uid = getSession()?.user.id;
  await rest(`operator_claims?id=eq.${c.id}`, {
    method: "PATCH", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ status: approve ? "verified" : "rejected", reviewed_by: uid, ...(approve ? { verified_at: new Date().toISOString() } : {}) }),
  });
  if (approve) {
    await rest("platform_operators?on_conflict=platform_id,user_id", {
      method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ platform_id: c.platform_id, user_id: c.user_id }),
    });
    await rest(`platforms?id=eq.${encodeURIComponent(c.platform_id)}`, {
      method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ verified: true }),
    });
  }
}

/* 이메일 수신거부 등록(0015 outreach_optout — 공개 insert 정책) — 제휴 제안·알림 메일 공통.
 * 등록 후 조회는 관리자·서버만 가능해, 이미 등록된 주소의 재등록(409)은 성공으로 취급한다. */
export async function registerOptout(email: string): Promise<void> {
  try {
    await rest("outreach_optout", {
      method: "POST", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ email: email.trim().toLowerCase(), reason: "user_request" }),
    });
  } catch (ex) {
    if ((ex as { status?: number }).status !== 409) throw ex;
  }
}

/* ── 플랫폼 소식(0027) — 수집기가 연결한 공개 뉴스, 상세 "최근 소식" 섹션용 ── */
export interface PlatformNews { id: number; title: string; url: string; source: string; published_at: string | null }
export async function fetchPlatformNews(platformId: string): Promise<PlatformNews[]> {
  return rest<PlatformNews[]>(
    `platform_news?platform_id=eq.${encodeURIComponent(platformId)}&select=id,title,url,source,published_at&order=published_at.desc.nullslast&limit=5`,
  ).catch(() => []);
}
/* 관리자: 최근 수집 소식 조회·오탐 삭제(0027 admin delete 정책) */
export async function listRecentPlatformNews(): Promise<(PlatformNews & { platform_id: string; created_at: string })[]> {
  return rest<(PlatformNews & { platform_id: string; created_at: string })[]>(
    "platform_news?select=id,platform_id,title,url,source,published_at,created_at&order=created_at.desc&limit=50");
}
export async function deletePlatformNews(id: number): Promise<void> {
  await rest(`platform_news?id=eq.${id}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
}

/* ── 운영자 대시보드(0023) — 인증된 운영자에게 내 플랫폼 데이터 개방 ── */
export interface OperatedPlatform { platform_id: string; granted_at: string }
export async function listMyOperatedPlatforms(): Promise<OperatedPlatform[]> {
  const uid = getSession()?.user.id;
  if (!uid) return [];
  return rest<OperatedPlatform[]>(`platform_operators?user_id=eq.${uid}&select=platform_id,granted_at&order=granted_at.desc`);
}
export interface OperatorStats { impressions: number; clicks: number; outbounds: number; favorites: number }
/* definer RPC — 운영자 본인 플랫폼만(아니면 FORBIDDEN), 30일 집계값만 반환 */
export async function fetchOperatorStats(platformId: string): Promise<OperatorStats | null> {
  const rows = await rest<OperatorStats[]>("rpc/operator_platform_stats", {
    method: "POST", body: JSON.stringify({ p_platform: platformId }),
  });
  return rows[0] ?? null;
}
export interface ReceivedProposal {
  id: string; sender_name: string; target_platform_id: string | null;
  type_id: string; subject: string; status: string; created_at: string;
}
/* 내 플랫폼이 받은 제휴 제안(0023 운영자 read 정책) — 내가 보낸 제안과 구분하려 대상 플랫폼으로 한정 */
export async function listReceivedProposals(platformIds: string[]): Promise<ReceivedProposal[]> {
  if (platformIds.length === 0) return [];
  const list = platformIds.map((p) => `"${p}"`).join(",");
  return rest<ReceivedProposal[]>(
    `outreach_proposals?target_platform_id=in.(${encodeURIComponent(list)})&select=id,sender_name,target_platform_id,type_id,subject,status,created_at&order=created_at.desc&limit=50`,
  );
}

/* 분석 이벤트(fire-and-forget) — 원격 모드에서만 기록. 실패 무시.
 * 세션 지속(localStorage)·로그인 사용자·유입경로(ref)를 함께 남겨 퍼널·귀속·리텐션 분석을 가능하게 한다. */
let sessionId = "";
function sid(): string {
  if (sessionId) return sessionId;
  const gen = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
  try {
    sessionId = localStorage.getItem("sm.sid") || "";
    if (!sessionId) { sessionId = gen(); localStorage.setItem("sm.sid", sessionId); }
  } catch { sessionId = sessionId || gen(); }
  return sessionId;
}
/* 유입경로: utm_* 우선, 없으면 referrer 호스트명(전체 경로·개인정보 배제). 세션당 1회 계산·캐시. */
let refCache: string | null | undefined;
function currentRef(): string | null {
  if (refCache !== undefined) return refCache;
  try {
    const u = new URL(location.href);
    const utm = ["utm_source", "utm_medium", "utm_campaign"].map((k) => u.searchParams.get(k)).filter(Boolean).join("|");
    const r = utm || (document.referrer ? new URL(document.referrer).hostname : "");
    refCache = (r || "").slice(0, 120) || null;
  } catch { refCache = null; }
  return refCache;
}
function eventRow(type: string, platformId?: string, query?: string, entity?: { type: string; id: string }) {
  const row: Record<string, unknown> = { type, platform_id: platformId ?? null, query: query ?? null,
    session_id: sid(), user_id: getSession()?.user.id ?? null, ref: currentRef() };
  // entity 컬럼(0034)은 있을 때만 포함 — 마이그레이션 전 DB에서도 일반 이벤트 insert가 깨지지 않게
  if (entity) { row.entity_type = entity.type; row.entity_id = entity.id; }
  return row;
}
/* 프론트 오류 수집(0039) — 미처리 예외·흰 화면을 events(type='error')로 기록, 관리자만 열람.
 * 성장 지표 오염 방지: session_id·user_id를 싣지 않는다(주간 세션·WAU·리텐션이 session/user 기준 —
 * null이면 집계에서 자동 제외). 폭주 방지: 동일 메시지 1회 + 페이지 수명당 최대 10건.
 * 0039 미적용 DB에서는 enum 거부로 조용히 무시(수집만 안 될 뿐 UX 무영향). */
const seenErrors = new Set<string>();
let errorBudget = 10;
export function trackError(message: string): void {
  if (!remoteEnabled || errorBudget <= 0) return;
  const msg = String(message).slice(0, 300);
  if (!msg || seenErrors.has(msg)) return;
  seenErrors.add(msg); errorBudget--;
  const view = (new URLSearchParams(location.search).get("view") || location.pathname.slice(0, 40) || "home").slice(0, 40);
  rest("events", {
    method: "POST", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ type: "error", query: msg, entity_type: view }),
  }).catch(() => { /* 수집 실패는 무시 */ });
}
/* 관리자: 최근 프론트 오류 — 메시지(query)·뷰(entity_type)·시각. RLS admin-only 읽기. */
export interface FrontError { query: string | null; entity_type: string | null; created_at: string }
export async function listFrontErrors(): Promise<FrontError[]> {
  return rest<FrontError[]>("events?type=eq.error&select=query,entity_type,created_at&order=created_at.desc&limit=20");
}
export async function countFrontErrors7d(): Promise<number> {
  const week = new Date(Date.now() - 7 * 86400000).toISOString();
  return restCount(`events?type=eq.error&created_at=gte.${week}&select=id`);
}

export function trackEvent(type: "impression" | "click" | "outbound" | "favorite" | "search", platformId?: string, query?: string,
  entity?: { type: string; id: string }): void {
  if (!remoteEnabled) return;
  rest("events", {
    method: "POST", headers: { Prefer: "return=minimal" },
    body: JSON.stringify(eventRow(type, platformId, query, entity)),
  }).catch(() => { /* 분석은 UX를 막지 않는다 */ });
}
/* 노출(impression)은 결과당 수십~수백 건 → 세션당 플랫폼 1회 dedup + 디바운스 벌크 insert(단일 요청). */
const impSeen = new Set<string>();
let impBuf: string[] = [];
let impTimer: ReturnType<typeof setTimeout> | undefined;
function flushImpressions(): void {
  if (!impBuf.length) return;
  const rows = impBuf.map((pid) => eventRow("impression", pid));
  impBuf = [];
  rest("events", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(rows) }).catch(() => { /* noop */ });
}
export function trackImpression(platformId: string): void {
  if (!remoteEnabled || !platformId || impSeen.has(platformId)) return;
  impSeen.add(platformId); impBuf.push(platformId);
  clearTimeout(impTimer); impTimer = setTimeout(flushImpressions, 1500);
}
