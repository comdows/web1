/* 데이터 접근 단일 지점 — API Spec(redesign/handoff/API Spec.md) §5 계약의 앱 구현.
 * VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY 가 설정되면 원격(Supabase PostgREST),
 * 없으면 로컬(JSON) 모드. 원격 실패 시 로컬로 폴백 → 백엔드 장애에도 발견 기능 유지. */
import { platforms, categories, categoryById } from "../data";
import type { Platform } from "../data";
import { getAccessToken, getSession } from "./auth";
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
}
const PLATFORM_COLS = "id,name,category_id,region,url,blurb,is_new,verified,fee_band,fee_text,settle_text,enter_text,strength";
const fromDb = (r: DbPlatform): Platform => ({
  id: r.id, name: r.name, category: r.category_id,
  region: r.region === "overseas" ? "해외" : "국내",
  url: r.url, blurb: r.blurb, new: r.is_new || undefined,
  verified: r.verified || undefined, fee_band: r.fee_band ?? undefined, fee_text: r.fee_text ?? undefined,
  settle_text: r.settle_text ?? undefined, enter_text: r.enter_text ?? undefined, strength: r.strength ?? undefined,
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
  await rest("favorites?on_conflict=user_id,platform_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ user_id: uid, platform_id: platformId }),
  });
}
export async function removeFavorite(platformId: string): Promise<void> {
  await rest(`favorites?platform_id=eq.${encodeURIComponent(platformId)}`, {
    method: "DELETE", headers: { Prefer: "return=minimal" },
  });
}

export interface SubmissionPayload {
  name: string; url: string; category_id: string; region: "domestic" | "overseas"; desc: string; note?: string;
  confidence?: number; // 자동 수집기가 매긴 신뢰도(0~100) — 일괄 승인 우선순위 참고
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
  const rows = await rest<{ id: string }[]>("submissions?status=eq.pending&select=id");
  return rows.length;
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
}
export async function fetchDeals(): Promise<PublicDeal[]> {
  return rest<PublicDeal[]>("v_deals_public?select=*&order=posted.desc&limit=100");
}
export interface DealSubPayload {
  category_id: string; region: "domestic" | "overseas"; revenue_band: string;
  mode: string; summary: string; highlights: string; sale_reason: string;
  ack?: boolean; // 비중개(정보 게시·소개만) 확인 체크 — 오인 접수 방지 기록
  assets?: string[];             // 이전할 자산 체크리스트 — 게시 시 하이라이트 칩으로 합류
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
  categories: string[]; budget_band: string; mode: string; entity: string; note: string;
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
export async function placeOrder(kind: "boost" | "subscription", planId?: string, postId?: string, depositorHint?: string): Promise<OrderResult> {
  return rest<OrderResult>("rpc/place_order", { method: "POST", body: JSON.stringify({ p_kind: kind, p_plan_id: planId ?? null, p_post_id: postId ?? null, p_depositor_hint: depositorHint ?? null }) });
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
}): Promise<void> {
  await rest("deals", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(row) });
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
export interface QueueCounts { submission: number; partner: number; deal: number; operator: number; deposit: number; intro: number }
export async function fetchQueueCounts(): Promise<QueueCounts> {
  const n = async (pathQ: string) => {
    try { return (await rest<{ id?: string }[]>(pathQ)).length; } catch { return 0; }
  };
  const [submission, partner, deal, operator, deposit, intro] = await Promise.all([
    n("submissions?status=in.(pending,hold)&select=id&limit=200"),
    n("partner_posts?status=eq.pending&select=id&limit=200"),
    n("deal_submissions?status=in.(pending,hold)&select=id&limit=200"),
    n("operator_claims?status=in.(pending,code_sent)&select=id&limit=200"),
    n("v_admin_charges?status=eq.awaiting_deposit&select=id&limit=200"),
    n("v_admin_intro_queue?status=eq.pending&select=id&limit=200"),
  ]);
  return { submission, partner, deal, operator, deposit, intro };
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
  return rest<PartnerPostAdmin[]>(`partner_posts?created_by=eq.${uid}&select=id,title,category_id,type_id,give_text,get_text,want_categories,size_text,detail,status,review_reason,created_at&order=created_at.desc&limit=50`);
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
  return rest<BuyerBriefRow[]>(`buyer_briefs?user_id=eq.${uid}&select=id,categories,budget_band,mode,entity,note,active,created_at&order=created_at.desc&limit=50`);
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
export async function listDealsAdmin(): Promise<{ id: string; status: string; summary: string; is_demo: boolean; category_id: string; mode: string }[]> {
  return rest("deals?select=id,status,summary,is_demo,category_id,mode&order=posted.desc&limit=100");
}

/* 브리프 ↔ 매물 조건 대조(클라이언트 매칭 — 분야 + 형태) */
export function briefMatchesDeal(
  b: { categories: string[]; mode: string },
  d: { category_id: string; mode: string }
): boolean {
  const catOk = b.categories.length === 0 || b.categories.includes(d.category_id);
  const modeOk = /무관/.test(b.mode) || b.mode === d.mode || (/자산/.test(b.mode) && /자산/.test(d.mode));
  return catOk && modeOk;
}
/* 브리프 안내 완료 처리(active=false — 0005 admin update 정책 필요) */
export async function deactivateBrief(id: string): Promise<void> {
  await rest(`buyer_briefs?id=eq.${id}`, {
    method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ active: false }),
  });
}

export interface BuyerBriefRow {
  id: string; categories: string[]; budget_band: string; mode: string; entity: string; note: string; active: boolean; created_at: string;
}
export async function listBuyerBriefs(): Promise<BuyerBriefRow[]> {
  return rest<BuyerBriefRow[]>("buyer_briefs?active=is.true&select=id,categories,budget_band,mode,entity,note,active,created_at&order=created_at.desc&limit=100");
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
function eventRow(type: string, platformId?: string, query?: string) {
  return { type, platform_id: platformId ?? null, query: query ?? null,
    session_id: sid(), user_id: getSession()?.user.id ?? null, ref: currentRef() };
}
export function trackEvent(type: "impression" | "click" | "outbound" | "favorite" | "search", platformId?: string, query?: string): void {
  if (!remoteEnabled) return;
  rest("events", {
    method: "POST", headers: { Prefer: "return=minimal" },
    body: JSON.stringify(eventRow(type, platformId, query)),
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
