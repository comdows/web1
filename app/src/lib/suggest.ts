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
  const terms = expandTerm(q); // [원어, ...동의어] — 원어 우선
  // 분야(최대 2)
  const catStarts = catIndex.filter((c) => terms.some((t) => c.lower.startsWith(t)));
  const catIncl = catIndex.filter((c) => !catStarts.includes(c) && terms.some((t) => c.lower.includes(t)));
  for (const c of [...catStarts, ...catIncl].slice(0, 2)) {
    out.push({ kind: "category", id: c.id, label: c.name, sub: "분야" });
  }
  // 플랫폼(startsWith 우선)
  const starts: Platform[] = [];
  const incl: Platform[] = [];
  for (const p of platforms) {
    const nm = p.name.toLowerCase();
    if (nm.startsWith(q)) starts.push(p);
    else if (terms.some((t) => nm.includes(t))) incl.push(p);
    if (starts.length >= n) break;
  }
  for (const p of [...starts, ...incl].slice(0, n - out.length)) {
    out.push({ kind: "platform", id: p.id, label: p.name, sub: catIndex.find((c) => c.id === p.category)?.name });
  }
  return out;
}

/* ── 검색 지능화(G-C) ─────────────────────────────────────── */

/* 동의어 그룹 — 같은 그룹의 어떤 단어로 검색해도 서로 매칭(소문자). 확장은 여기만. */
const SYNONYM_GROUPS: string[][] = [
  ["쇼핑몰", "커머스", "이커머스", "스토어", "온라인쇼핑"],
  ["오픈마켓", "마켓플레이스", "장터"],
  ["중고", "세컨핸드", "리셀", "중고거래"],
  ["배달", "딜리버리", "배송"],
  ["숙박", "호텔", "펜션", "민박", "스테이"],
  ["채용", "구인", "구직", "일자리", "리크루팅"],
  ["강의", "클래스", "교육", "온라인강의", "인강"],
  ["부동산", "프롭테크", "매물"],
  ["물류", "풀필먼트", "3pl"],
  ["펀딩", "크라우드펀딩", "후원"],
  ["재능", "외주", "프리랜서", "긱"],
  ["식자재", "식재료", "푸드"],
  ["뷰티", "화장품", "코스메틱"],
  ["패션", "의류", "옷"],
  ["여행", "투어", "트래블"],
  ["금융", "핀테크", "대출"],
  ["광고", "마케팅", "홍보"],
  ["예약", "부킹", "북킹"],
  ["구독", "정기배송", "멤버십"],
  ["도매", "사입", "b2b도매", "소싱"],
  ["핸드메이드", "수공예", "공예"],
  ["웹툰", "만화", "웹소설"],
  ["영상", "동영상", "비디오"],
  ["인공지능", "ai", "에이아이"],
  ["챗봇", "챗gpt", "지피티", "gpt"],
];
const SYN = new Map<string, string[]>();
for (const g of SYNONYM_GROUPS) for (const w of g) SYN.set(w, g.filter((x) => x !== w));

/* 질의 토큰 → [원어, ...동의어] (원어가 항상 앞 — 가중치 우선) */
export function expandTerm(t: string): string[] {
  return [t, ...(SYN.get(t) ?? [])];
}

/* 한글 자모 분해(음절 → 초·중·종 문자열) — 편집거리 계산용 */
const CHO = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ";
const JUNG = "ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ";
const JONG = "\u0000ㄱㄲㄳㄴㄵㄶㄷㄹㄺㄻㄼㄽㄾㄿㅀㅁㅂㅄㅅㅆㅇㅈㅊㅋㅌㅍㅎ";
function jamo(s: string): string {
  let out = "";
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    if (code >= 0xac00 && code <= 0xd7a3) {
      const i = code - 0xac00;
      out += CHO[Math.floor(i / 588)] + JUNG[Math.floor((i % 588) / 28)] + (i % 28 ? JONG[i % 28] : "");
    } else out += ch;
  }
  return out;
}
function editDistLe(a: string, b: string, max: number): boolean {
  if (Math.abs(a.length - b.length) > max) return false;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => i);
  for (let j = 1; j <= b.length; j++) {
    let prev = dp[0]; dp[0] = j;
    for (let i = 1; i <= a.length; i++) {
      const cur = dp[i];
      dp[i] = Math.min(dp[i] + 1, dp[i - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return dp[a.length] <= max;
}
/* 오타 교정 — 검색 0건일 때만 호출: 플랫폼·분야명에서 자모 편집거리 ≤ len/4(최소1·최대2) 최근접 이름 */
export function fuzzyCorrect(query: string, platforms: Platform[]): string | null {
  const q = jamo(query.trim().toLowerCase());
  if (q.length < 3) return null;
  const tol = Math.min(2, Math.max(1, Math.floor(q.length / 4)));
  let best: string | null = null; let bestLen = Infinity;
  const names = [...platforms.map((p) => p.name), ...categories.map((c) => c.name)];
  for (const name of names) {
    const j = jamo(name.toLowerCase());
    if (Math.abs(j.length - q.length) > tol) continue;
    if (editDistLe(q, j, tol) && j.length < bestLen) { best = name; bestLen = j.length; }
  }
  return best;
}
