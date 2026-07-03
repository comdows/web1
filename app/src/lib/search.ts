/* 검색 관련도 — 기본 정렬 'relevance'가 no-op이던 문제 해결(감사2 P1).
 * 이름 정확일치 > 이름 시작 > 이름 포함 > 분야명 > 소개문, 토큰별 합산. */
import { categoryById } from "../data";
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
    if (name === t) score += 100;
    else if (name.startsWith(t)) score += 60;
    else if (name.includes(t)) score += 40;
    if (cat.includes(t)) score += 20;
    if (blurb.includes(t)) score += 10;
  }
  return score;
}

export function sortByRelevance(list: Platform[], query: string): Platform[] {
  return [...list].sort(
    (a, b) => scorePlatform(query, b) - scorePlatform(query, a) || a.name.localeCompare(b.name, "ko")
  );
}

/* 관심 조건(그룹/분야) 기반 추천 — 분야별 라운드로빈으로 특정 분야 독식 방지.
 * 온보딩 step3와 홈 "내 관심 분야" 스트립이 공유한다. */
export function pickRecommended(
  platforms: Platform[], groupIds: string[], catIds: string[], newPref: boolean, n = 12
): Platform[] {
  let list = platforms.filter((p) =>
    catIds.length ? catIds.includes(p.category)
    : groupIds.length ? groupIds.includes(categoryById(p.category)?.group ?? "")
    : false);
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
