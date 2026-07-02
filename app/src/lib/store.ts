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

export const Favs = {
  all(): string[] { return readSet(FAV_KEY); },
  has(id: string): boolean { return readSet(FAV_KEY).includes(id); },
  toggle(id: string) {
    const cur = readSet(FAV_KEY);
    const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
    lsSet(FAV_KEY, JSON.stringify(next));
    emit();
  },
};

export const Recent = {
  list(): string[] { return readSet(RECENT_KEY); },
  push(id: string) {
    const cur = readSet(RECENT_KEY).filter((x) => x !== id);
    lsSet(RECENT_KEY, JSON.stringify([id, ...cur].slice(0, MAX_RECENT)));
    emit();
  },
};

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
