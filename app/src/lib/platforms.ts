/* 반응형 플랫폼 소스 — 정적 JSON(즉시 렌더)로 시작해, 원격 모드면 Supabase에서
 * 전체 목록을 한 번 로드해 교체한다. 홈·검색·상세·통계가 모두 이 소스를 구독하므로,
 * 관리자가 승인·등재한 새 플랫폼이 재배포 없이 나타난다. 원격 실패 시 정적 유지(폴백). */
import { useEffect, useMemo, useState } from "react";
import { platforms as staticPlatforms } from "../data";
import type { Platform } from "../data";
import { fetchAllPlatforms, remoteEnabled } from "./api";

let current: Platform[] = staticPlatforms;
let loaded = false;      // 원격 로드 성공 여부
let settled = false;     // 최초 로드 시도 종료(성공/실패 무관) — not-found 판정 기준
let loading = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/* 앱 시작 시 1회 호출(main.tsx). 원격 성공 시 목록 교체 + 구독자 갱신. */
export function initPlatforms(): void {
  if (loading || loaded || !remoteEnabled) return;
  loading = true;
  fetchAllPlatforms()
    .then((rows) => { if (rows.length) { current = rows; loaded = true; emit(); } })
    .catch(() => { /* 정적 폴백 유지 */ })
    .finally(() => { loading = false; settled = true; emit(); });
}

export const getAllPlatforms = (): Platform[] => current;

function useSnapshot<T>(read: () => T): T {
  const [, force] = useState(0);
  useEffect(() => { const l = () => force((n) => n + 1); listeners.add(l); return () => { listeners.delete(l); }; }, []);
  return read();
}

/* 현재 플랫폼 목록(정적→원격) */
export function usePlatforms(): Platform[] { return useSnapshot(() => current); }

/* 소스 정착 여부(상세 404 판정에 사용 — 로드 시도가 끝나기 전엔 not-found를 띄우지 않는다).
 * 원격이 도달 불가여도 시도가 끝나면 정적 폴백으로 정착 → 무한 로딩 방지. */
export function usePlatformsLoaded(): boolean { return useSnapshot(() => settled || !remoteEnabled); }

/* id → 플랫폼 인덱스 */
export function usePlatformIndex(): Map<string, Platform> {
  const list = usePlatforms();
  return useMemo(() => new Map(list.map((p) => [p.id, p])), [list]);
}

/* 분야별 개수·신규 수·총계(홈 스탯·아코디언·검색 패싯이 같은 소스를 보게) */
export function usePlatformStats(): { counts: Map<string, number>; newCount: number; total: number } {
  const list = usePlatforms();
  return useMemo(() => {
    const counts = new Map<string, number>();
    let newCount = 0;
    for (const p of list) {
      counts.set(p.category, (counts.get(p.category) ?? 0) + 1);
      if (p.new) newCount++;
    }
    return { counts, newCount, total: list.length };
  }, [list]);
}
