/* 데이터 접근 단일 지점 — API Spec(redesign/handoff/API Spec.md) §5 계약의 앱 구현.
 * VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY 가 설정되면 원격(Supabase PostgREST),
 * 없으면 로컬(JSON) 모드. 원격 실패 시 로컬로 폴백 → 백엔드 장애에도 발견 기능 유지. */
import { platforms, categories, categoryById } from "../data";
import type { Platform } from "../data";
import { getAccessToken, getSession } from "./auth";

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
    throw new Error(`API ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
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
