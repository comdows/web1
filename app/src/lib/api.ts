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
async function rest<T>(pathAndQuery: string, init?: RequestInit): Promise<T> {
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
    const msg = res.status === 401 || res.status === 403 ? "권한이 없어요. 다시 로그인해 주세요."
      : res.status === 400 || res.status === 409 || res.status === 422 ? "입력값을 확인해 주세요."
      : res.status === 404 ? "대상을 찾을 수 없어요."
      : res.status === 429 ? "요청이 많아요. 잠시 후 다시 시도해 주세요."
      : "문제가 생겼어요. 잠시 후 다시 시도해 주세요.";
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
}
const fromDb = (r: DbPlatform): Platform => ({
  id: r.id, name: r.name, category: r.category_id,
  region: r.region === "overseas" ? "해외" : "국내",
  url: r.url, blurb: r.blurb, new: r.is_new || undefined,
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
    const qs = new URLSearchParams({ select: "id,name,category_id,region,url,blurb,is_new" });
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
    const rows = await rest<DbPlatform[]>(`platforms?id=eq.${encodeURIComponent(id)}&select=id,name,category_id,region,url,blurb,is_new`);
    if (!rows[0]) return null;
    const p = fromDb(rows[0]);
    const sim = await rest<DbPlatform[]>(`platforms?category_id=eq.${encodeURIComponent(p.category)}&id=neq.${encodeURIComponent(id)}&limit=6&select=id,name,category_id,region,url,blurb,is_new`);
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
      `platforms?select=id,name,category_id,region,url,blurb,is_new&order=name.asc&limit=${pageSize}&offset=${offset}`
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
}
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
    body: JSON.stringify({ ...input, created_by: uid }),
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
  contact_consent_at: string | null;
}
export async function listAdminIntroQueue(): Promise<IntroQueueRow[]> {
  return rest<IntroQueueRow[]>("v_admin_intro_queue?status=eq.pending&select=*&order=created_at.asc&limit=100");
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

/* 최신 코드명(D-###) — 매물 게시 기본값 제안용(세션 인덱스 대신 DB 기준) */
export async function fetchLatestDealCode(): Promise<string | null> {
  const rows = await rest<{ id: string }[]>("deals?select=id&order=id.desc&limit=1");
  return rows[0]?.id ?? null;
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
export async function listDealsAdmin(): Promise<{ id: string; status: string; summary: string; is_demo: boolean }[]> {
  return rest("deals?select=id,status,summary,is_demo&order=posted.desc&limit=100");
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

/* 분석 이벤트(fire-and-forget) — 원격 모드에서만 기록. 실패 무시. */
let sessionId = "";
export function trackEvent(type: "impression" | "click" | "outbound" | "favorite" | "search", platformId?: string, query?: string): void {
  if (!remoteEnabled) return;
  if (!sessionId) sessionId = Math.random().toString(36).slice(2) + Date.now().toString(36);
  rest("events", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ type, platform_id: platformId ?? null, query: query ?? null, session_id: sessionId }),
  }).catch(() => { /* 분석은 UX를 막지 않는다 */ });
}
