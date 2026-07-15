/* 매칭 지능화 — 규칙 기반 적합도 점수(런타임 LLM 없음).
 *  · scoreBriefDeal: 인수 브리프 ↔ 매물 적합도(0~100) — 소개 우선순위·"맞는 매물" 랭킹.
 *  · rankSimilar:   같은 분야 내 유사 플랫폼 랭킹(설명 토큰 겹침) — 상세 "같은 분야" 6선 품질. */
import type { Platform } from "../data";

/* 밴드 텍스트에서 대표 규모(억 단위)를 뽑는다. '1~5억'→5, '5~20억'→20, '~1억'→1, '연매출 1~5억'→5, '3천만원'→0.3 등. */
function bandMax(t: string | undefined | null): number | null {
  if (!t) return null;
  const eok = [...t.matchAll(/(\d+(?:\.\d+)?)\s*억/g)].map((m) => parseFloat(m[1]));
  if (eok.length) return Math.max(...eok);
  const cheon = [...t.matchAll(/(\d+(?:\.\d+)?)\s*천/g)].map((m) => parseFloat(m[1]) * 0.1);
  if (cheon.length) return Math.max(...cheon);
  if (/만/.test(t)) return 0.3; // 만원대 → 1억 미만
  const bare = [...t.matchAll(/(\d+(?:\.\d+)?)/g)].map((m) => parseFloat(m[1]));
  return bare.length ? Math.max(...bare) : null;
}
/* 예산 ↔ 매출 규모 적합(0~25). 예산이 매출 규모 이상이면 감당 가능. 파싱 불가 시 중립. */
function budgetFit(budget: string, revenue: string): number {
  const bm = bandMax(budget), rm = bandMax(revenue);
  if (bm == null || rm == null) return 12;
  if (bm >= rm) return 25;
  if (bm >= rm * 0.5) return 15;
  return 5;
}

export interface BriefLike { categories: string[]; budget_band: string; mode: string; region_pref?: string }
export interface DealLike { category_id: string; mode: string; revenue_band?: string; region?: string }

/* 지역·예산 하한 게이트의 불리언 규칙은 briefMatchesDeal(api.ts)·matches(notify.mjs)에 있다.
 * 아래 점수 함수는 매칭된 쌍의 랭킹용이라 지역을 등급(일치>무관>불일치)으로 반영. */

/* 브리프 ↔ 매물 적합도(0~100). 분야 불일치는 0(비매칭). 분야·형태·예산·지역으로 가중.
 * (briefMatchesDeal의 불리언 게이트는 유지하고, 이 점수는 매칭된 것들의 랭킹·표시에 쓴다) */
export function scoreBriefDeal(b: BriefLike, d: DealLike): number {
  const catHit = !b.categories?.length || b.categories.includes(d.category_id);
  if (!catHit) return 0;
  let s = b.categories?.length ? 40 : 22; // 지정 분야 일치 > 분야 무관
  const modeOk = /무관/.test(b.mode || "") || b.mode === d.mode || (/자산/.test(b.mode || "") && /자산/.test(d.mode || ""));
  s += modeOk ? 20 : 0;
  s += budgetFit(b.budget_band, d.revenue_band ?? "");
  // 지역: 선호 일치 +15, 선호 없음(무관) +8(중립), 매물 지역 미상 +8, 불일치 0
  s += !b.region_pref || !d.region ? 8 : b.region_pref === d.region ? 15 : 0;
  return Math.min(100, s);
}

/* 제휴 제안 ↔ 뷰어 관심분야 적합도(0~100). 게시물이 "내 분야"에 있거나, 게시자가 "내 분야" 파트너를
 * 원할 때 높음. 가격·거래액과 무관(원칙 안전) — 보드 "내게 맞는 제안" 정렬·배지용. */
export function scorePartnerFit(viewerCats: string[], post: { category_id: string; want_categories: string[] }): number {
  if (!viewerCats.length) return 0;
  const set = new Set(viewerCats);
  let s = 0;
  if (set.has(post.category_id)) s += 50;              // 내 관심 분야의 제안
  const wantHit = (post.want_categories || []).filter((w) => set.has(w)).length;
  if (wantHit) s += Math.min(50, 30 + wantHit * 10);   // 그들이 내 분야 파트너를 원함
  return Math.min(100, s);
}

/* ── 유사 플랫폼(같은 분야 내 랭킹) ── */
const STOP = new Set(["및", "등", "the", "a", "an", "for", "and", "to", "of", "with", "서비스", "플랫폼", "기반", "제공", "다양한", "위한", "있는"]);
function tokens(s: string): string[] {
  return (s || "").toLowerCase().split(/[^a-z0-9가-힣]+/).filter((t) => t.length > 1 && !STOP.has(t));
}
/* 이름·설명 토큰 겹침 수(간이 유사도). 형태소·임베딩 없이 동일 분야 후보 재정렬에 충분. */
export function similarity(a: Platform, b: Platform): number {
  const ta = new Set([...tokens(a.name), ...tokens(a.blurb)]);
  if (!ta.size) return 0;
  const seen = new Set<string>();
  let hit = 0;
  for (const t of [...tokens(b.name), ...tokens(b.blurb)]) if (ta.has(t) && !seen.has(t)) { hit++; seen.add(t); }
  return hit;
}
export function rankSimilar(target: Platform, pool: Platform[], n = 6): Platform[] {
  return pool
    .filter((x) => x.id !== target.id)
    .map((x) => ({ x, s: similarity(target, x) }))
    .sort((a, b) => b.s - a.s || a.x.name.localeCompare(b.x.name, "ko"))
    .slice(0, n)
    .map((o) => o.x);
}
