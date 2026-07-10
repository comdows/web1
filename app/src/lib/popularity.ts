/* 반응형 인기맵 소스 — 앱 시작 시 공개 집계 뷰(v_platform_popularity)를 1회 로드해 캐시한다.
 * 검색·추천 정렬이 이를 구독해 "많이 쓰이는 플랫폼"을 2차 신호로 반영(관련도가 1차).
 * 원격 아니거나 실패면 빈 Map — 정렬은 관련도만으로 degrade(오늘 동작 그대로). platforms.ts 패턴 복제. */
import { useEffect, useState } from "react";
import { fetchPopularity, remoteEnabled } from "./api";

let current = new Map<string, number>();
let loaded = false;
let loading = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/* 앱 시작 시 1회(main.tsx). 성공 시 인기맵 교체 + 구독자 갱신. */
export function initPopularity(): void {
  if (loading || loaded || !remoteEnabled) return;
  loading = true;
  fetchPopularity()
    .then((m) => { if (m.size) { current = m; loaded = true; emit(); } })
    .catch(() => { /* 빈 맵 유지 */ })
    .finally(() => { loading = false; });
}

export const getPopularity = (): Map<string, number> => current;

export function usePopularity(): Map<string, number> {
  const [, force] = useState(0);
  useEffect(() => { const l = () => force((n) => n + 1); listeners.add(l); return () => { listeners.delete(l); }; }, []);
  return current;
}
