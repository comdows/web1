/* 검색 자동완성 — 플랫폼명·분야명 경량 프리픽스/부분 매칭(1a 핸드오프 권장 항목).
 * 입력마다 호출되므로 인덱스는 모듈 레벨에서 1회 구성, 매칭은 단순 문자열 연산만. */
import { categories } from "../data";
import type { Platform } from "../data";

export interface Suggestion {
  kind: "platform" | "category" | "query";
  id: string;      // platform id | category id | 검색어
  label: string;   // 표시 텍스트
  sub?: string;    // 보조 라벨(분야명 등)
}

/* 최근 검색어(제출 시 기록, 최대 5) — store.ts와 동일한 localStorage 방어 패턴 */
const RECENTQ_KEY = "sm.recentq.v1";
export const RecentQ = {
  list(): string[] {
    try {
      const p: unknown = JSON.parse(localStorage.getItem(RECENTQ_KEY) || "[]");
      return Array.isArray(p) ? p.filter((x): x is string => typeof x === "string") : [];
    } catch { return []; }
  },
  push(q: string) {
    const v = q.trim(); if (!v) return;
    try {
      const cur = RecentQ.list().filter((x) => x !== v);
      cur.unshift(v);
      localStorage.setItem(RECENTQ_KEY, JSON.stringify(cur.slice(0, 5)));
    } catch { /* noop */ }
  },
};

/* 분야 인덱스(정적 45개 — 모듈 1회) */
const catIndex = categories.map((c) => ({ id: c.id, name: c.name, lower: c.name.toLowerCase() }));

/* 제안 생성: 이름 startsWith > includes, 분야 우선 1~2개 + 플랫폼 나머지, 최대 n개 */
export function suggest(query: string, platforms: Platform[], n = 8): Suggestion[] {
  const q = query.trim().toLowerCase();
  if (!q) return RecentQ.list().map((x) => ({ kind: "query" as const, id: x, label: x, sub: "최근 검색" }));

  const out: Suggestion[] = [];
  // 분야(최대 2)
  const catStarts = catIndex.filter((c) => c.lower.startsWith(q));
  const catIncl = catIndex.filter((c) => !c.lower.startsWith(q) && c.lower.includes(q));
  for (const c of [...catStarts, ...catIncl].slice(0, 2)) {
    out.push({ kind: "category", id: c.id, label: c.name, sub: "분야" });
  }
  // 플랫폼(startsWith 우선)
  const starts: Platform[] = [];
  const incl: Platform[] = [];
  for (const p of platforms) {
    const nm = p.name.toLowerCase();
    if (nm.startsWith(q)) starts.push(p);
    else if (nm.includes(q)) incl.push(p);
    if (starts.length >= n) break;
  }
  for (const p of [...starts, ...incl].slice(0, n - out.length)) {
    out.push({ kind: "platform", id: p.id, label: p.name, sub: catIndex.find((c) => c.id === p.category)?.name });
  }
  return out;
}
