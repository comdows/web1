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
