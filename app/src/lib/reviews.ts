/* 반응형 평점맵 소스 — 앱 시작 시 공개 집계 뷰(v_review_stats)를 1회 로드해 캐시한다.
 * 카드·상세의 ★평점 표시 전용 — 검색 정렬 랭킹에는 반영하지 않는다(순위 조작 유인 차단).
 * 원격 아니거나 실패면 빈 Map — 배지만 안 뜨고 나머지는 그대로. popularity.ts 패턴 복제. */
import { useEffect, useState } from "react";
import { fetchReviewStats, remoteEnabled } from "./api";
import type { ReviewStat } from "./api";

let current = new Map<string, ReviewStat>();
let loaded = false;
let loading = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/* 앱 시작 시 1회(main.tsx). 성공 시 평점맵 교체 + 구독자 갱신. */
export function initReviewStats(): void {
  if (loading || loaded || !remoteEnabled) return;
  loading = true;
  fetchReviewStats()
    .then((m) => { if (m.size) { current = m; loaded = true; emit(); } })
    .catch(() => { /* 빈 맵 유지 */ })
    .finally(() => { loading = false; });
}

export function useReviewStats(): Map<string, ReviewStat> {
  const [, force] = useState(0);
  useEffect(() => { const l = () => force((n) => n + 1); listeners.add(l); return () => { listeners.delete(l); }; }, []);
  return current;
}
