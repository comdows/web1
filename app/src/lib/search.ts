/* 검색 관련도 — 기본 정렬 'relevance'가 no-op이던 문제 해결(감사2 P1).
 * 이름 정확일치 > 이름 시작 > 이름 포함 > 분야명 > 소개문, 토큰별 합산. */
import { categoryById } from "../data";
import { expandTerm } from "./suggest";
import type { Platform } from "../data";

export function scorePlatform(query: string, p: Platform): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const name = p.name.toLowerCase();
  const cat = (categoryById(p.category)?.name ?? "").toLowerCase();
  const blurb = p.blurb.toLowerCase();
  let score = 0;
  for (const t of q.split(/\s+/)) {
    if (!t) continue;
    // 원어 1.0 → 동의어 0.5 가중(동의어로 넓히되 원어 결과가 항상 위)
    expandTerm(t).forEach((w, wi) => {
      const m = wi === 0 ? 1 : 0.5;
      if (name === w) score += 100 * m;
      else if (name.startsWith(w)) score += 60 * m;
      else if (name.includes(w)) score += 40 * m;
      if (cat.includes(w)) score += 20 * m;
      if (blurb.includes(w)) score += 10 * m;
    });
  }
  return score;
}

/* 인기 보정(2차 신호) — 상한 있는 로그 스케일. 관련도(토큰 10~100)에 얹되 최대 +15로 눌러
 * "관련도 1차 · 인기 2차"를 지킨다(디렉토리 유료개입 금지 원칙과 무관한 유기적 신호). */
export function popularityBoost(score: number | undefined): number {
  if (!score || score <= 0) return 0;
  return Math.min(Math.log2(1 + score) * 3, 15);
}

export function sortByRelevance(list: Platform[], query: string, pop?: Map<string, number>): Platform[] {
  const key = (p: Platform) => scorePlatform(query, p) + (pop ? popularityBoost(pop.get(p.id)) : 0);
  return [...list].sort((a, b) => key(b) - key(a) || a.name.localeCompare(b.name, "ko"));
}

/* 명시적 "인기순" — 인기 내림차순(동점 이름). 인기 데이터 없으면 이름순으로 degrade. */
export function sortByPopularity(list: Platform[], pop: Map<string, number>): Platform[] {
  return [...list].sort((a, b) => (pop.get(b.id) ?? 0) - (pop.get(a.id) ?? 0) || a.name.localeCompare(b.name, "ko"));
}

/* 관심 조건(그룹/분야) 기반 추천 — 분야별 라운드로빈으로 특정 분야 독식 방지.
 * 온보딩 step3와 홈 "내 관심 분야" 스트립이 공유한다. */
export function pickRecommended(
  platforms: Platform[], groupIds: string[], catIds: string[], newPref: boolean, n = 12, pop?: Map<string, number>
): Platform[] {
  let list = platforms.filter((p) =>
    catIds.length ? catIds.includes(p.category)
    : groupIds.length ? groupIds.includes(categoryById(p.category)?.group ?? "")
    : false);
  // 인기순 우선 정렬(검증된 대표를 앞세움) → newPref면 신규를 다시 최상단으로(안정 정렬)
  if (pop) list = [...list].sort((a, b) => (pop.get(b.id) ?? 0) - (pop.get(a.id) ?? 0));
  if (newPref) list = [...list].sort((a, b) => (b.new ? 1 : 0) - (a.new ? 1 : 0));
  const byCat = new Map<string, Platform[]>();
  for (const p of list) { const arr = byCat.get(p.category) ?? []; arr.push(p); byCat.set(p.category, arr); }
  const out: Platform[] = [];
  const buckets = [...byCat.values()];
  for (let i = 0; out.length < n; i++) {
    let added = false;
    for (const b of buckets) { if (b[i]) { out.push(b[i]); added = true; if (out.length >= n) break; } }
    if (!added) break;
  }
  return out;
}
