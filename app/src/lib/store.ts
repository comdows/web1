import { useEffect, useState } from "react";

/* localStorage wrapper with in-memory fallback (사파리 프라이빗 등 차단 대비) */
const mem: Record<string, string> = {};
function lsGet(k: string): string | null {
  try { return localStorage.getItem(k) ?? mem[k] ?? null; } catch { return mem[k] ?? null; }
}
function lsSet(k: string, v: string) {
  try { localStorage.setItem(k, v); } catch { mem[k] = v; }
}

const FAV_KEY = "sm.favs.v1";
const RECENT_KEY = "sm.recent.v1";
const CMP_KEY = "sm.compare.v1";
const MAX_RECENT = 20;
const MAX_COMPARE = 4;

const listeners = new Set<() => void>();
function emit() { listeners.forEach((l) => l()); }

function readSet(key: string): string[] {
  try { const v = lsGet(key); return v ? JSON.parse(v) : []; } catch { return []; }
}

/* 로그인 시 서버 동기화 콜백(lib/favsync.ts가 주입 — store는 백엔드를 모른다) */
let favSync: ((id: string, on: boolean) => void) | null = null;
export function setFavSync(fn: ((id: string, on: boolean) => void) | null) { favSync = fn; }

export const Favs = {
  all(): string[] { return readSet(FAV_KEY); },
  has(id: string): boolean { return readSet(FAV_KEY).includes(id); },
  toggle(id: string) {
    const cur = readSet(FAV_KEY);
    const on = !cur.includes(id);
    const next = on ? [...cur, id] : cur.filter((x) => x !== id);
    lsSet(FAV_KEY, JSON.stringify(next));
    emit();
    favSync?.(id, on);
  },
  /* 서버 → 로컬 합집합 병합(동기화 pull) */
  merge(ids: string[]) {
    if (!ids.length) return;
    const next = [...new Set([...readSet(FAV_KEY), ...ids])];
    lsSet(FAV_KEY, JSON.stringify(next));
    emit();
  },
  /* 계정 경계에서 로컬 즐겨찾기 비우기(로그아웃·계정 전환 시 이전 사용자 데이터 제거) */
  clear() { lsSet(FAV_KEY, JSON.stringify([])); emit(); },
};

export const Recent = {
  list(): string[] { return readSet(RECENT_KEY); },
  push(id: string) {
    const cur = readSet(RECENT_KEY).filter((x) => x !== id);
    lsSet(RECENT_KEY, JSON.stringify([id, ...cur].slice(0, MAX_RECENT)));
    emit();
  },
};

/* 관심 분야 프로필 — 온보딩 선택을 영속화(홈 추천·주간 필터의 업종 신호) */
const INTERESTS_KEY = "sm.interests.v1";
export interface InterestsState { groups: string[]; cats: string[]; newPref: boolean }
export const Interests = {
  get(): InterestsState | null {
    try { const v = lsGet(INTERESTS_KEY); return v ? JSON.parse(v) : null; } catch { return null; }
  },
  set(s: InterestsState) { lsSet(INTERESTS_KEY, JSON.stringify(s)); emit(); },
};

/* 폼 초안 — 긴 폼(매각 접수·제휴 제안) 작성 중 세션 만료·이탈 시 입력 유실 방지.
 * 제출 성공 시 clear. 연락처류는 애초에 입력 금지 필드라 민감 정보 저장 없음. */
export const Draft = {
  load<T>(key: string): T | null {
    try { const v = lsGet(`sm.draft.${key}`); return v ? (JSON.parse(v) as T) : null; } catch { return null; }
  },
  save(key: string, data: unknown): void { lsSet(`sm.draft.${key}`, JSON.stringify(data)); },
  clear(key: string): void { try { localStorage.removeItem(`sm.draft.${key}`); } catch { /* noop */ } },
};

/* 직전 방문 시각 — 세션당 1회, 직전 값을 읽은 뒤에 갱신(재방문 델타 배지용) */
const LASTVISIT_KEY = "sm.lastvisit.v1";
let lastVisitCache: string | null | undefined;
export function consumeLastVisit(): string | null {
  if (lastVisitCache === undefined) {
    lastVisitCache = lsGet(LASTVISIT_KEY);
    lsSet(LASTVISIT_KEY, new Date().toISOString());
  }
  return lastVisitCache;
}

export const Compare = {
  all(): string[] { return readSet(CMP_KEY); },
  has(id: string): boolean { return readSet(CMP_KEY).includes(id); },
  full(): boolean { return readSet(CMP_KEY).length >= MAX_COMPARE; },
  toggle(id: string) {
    const cur = readSet(CMP_KEY);
    if (cur.includes(id)) { lsSet(CMP_KEY, JSON.stringify(cur.filter((x) => x !== id))); emit(); return; }
    if (cur.length >= MAX_COMPARE) return; // 4개 초과 무시
    lsSet(CMP_KEY, JSON.stringify([...cur, id])); emit();
  },
  clear() { lsSet(CMP_KEY, JSON.stringify([])); emit(); },
};
export const MAX_CMP = MAX_COMPARE;

/* React hooks */
export function useFavs() {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);
  return {
    has: (id: string) => Favs.has(id),
    toggle: (id: string) => Favs.toggle(id),
    all: () => Favs.all(),
    count: Favs.all().length,
  };
}

export function useRecent(): string[] {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);
  return Recent.list();
}

export function useInterests(): InterestsState | null {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);
  return Interests.get();
}

export function useCompare() {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);
  return {
    has: (id: string) => Compare.has(id),
    toggle: (id: string) => Compare.toggle(id),
    all: () => Compare.all(),
    clear: () => Compare.clear(),
    count: Compare.all().length,
    full: Compare.full(),
  };
}
