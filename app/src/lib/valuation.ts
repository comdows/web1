/* 범주형 밴드 기반 비식별 플랫폼 가치 구간 추정 — 특허 출원 대상 모듈(patent-plan.md 발명 4).
 *
 * 규제 정합을 기술 구조로 강제하는 것이 구성의 핵심:
 * ① 입력은 정확 수치가 아닌 범주형 밴드(연매출 밴드·자산 구성 집합·인수인계·연차)로만 받고
 * ② 밴드를 수치 구간으로 사상해 분야별 기준 배수 구간과 가중치를 구간 연산으로 결합하며
 * ③ 출력도 구간(밴드)으로만 낸다 — 단일 가격을 출력하지 않아 감정·자문으로 오인될 여지를 차단.
 * ④ 연산은 전부 단말(브라우저)에서 수행되고 서버로 전송·저장되지 않으며 게시물과 구조적으로 분리.
 * ⑤ 입력 완전도에 따라 신뢰 등급을 함께 출력하고, 적용된 가정을 전면 공개한다.
 *
 * 기준 배수·가중치는 공개 시장 통례를 단순화한 "참고용 가정"이며 감정평가·투자자문이 아니다. */

export interface ValueInput {
  group: string;        // 분야 그룹 id (commerce/trade/service/life/money)
  revenueBand: string;  // 연매출 밴드
  assets: string[];     // 이전 자산 구성(체크리스트 부분집합)
  handover: string;     // 운영 인수인계
  years: string;        // 운영 연차 밴드
}

export interface ValueResult {
  low: number; high: number;         // 추정 구간(억 원)
  multLow: number; multHigh: number; // 적용 배수 구간(연매출 대비)
  confidence: "낮음" | "보통";
  factors: string[];                 // 적용된 가정(전면 공개)
}

export const VAL_YEARS = ["1년 미만", "1~3년", "3~6년", "6년 이상"];

/* 연매출 밴드 → 수치 구간(억 원) */
const REV_INTERVAL: Record<string, [number, number]> = {
  "연매출 1억 미만": [0.3, 1],
  "연매출 1~5억": [1, 5],
  "연매출 5~20억": [5, 20],
  "연매출 20억+": [20, 40],
};

/* 분야 그룹별 기준 배수 구간(연매출 대비) — 참고용 단순화 가정 */
const BASE_MULT: Record<string, [number, number]> = {
  commerce: [0.4, 0.9],
  trade: [0.4, 0.8],
  service: [0.5, 1.1],
  life: [0.4, 1.0],
  money: [0.6, 1.3],
};

/* 자산 구성 가중치 — 이전 가능 자산이 많을수록 배수 상향 */
const ASSET_W: Record<string, number> = {
  "회원 DB": 0.10, "입점·공급 계약": 0.10, "소스코드·저장소": 0.05,
  "상표·브랜드": 0.05, "도메인·앱": 0.03, "SNS·콘텐츠 계정": 0.03, "재고·설비": 0.02,
};
const HANDOVER_W: Record<string, number> = { "없음(자료 전달만)": 0, "1개월 동행": 0.05, "3개월 동행": 0.10 };
const YEARS_W: Record<string, number> = { "1년 미만": -0.10, "1~3년": 0, "3~6년": 0.05, "6년 이상": 0.10 };

const round1 = (n: number) => Math.round(n * 10) / 10;

/* 억 단위 구간을 사람이 읽는 밴드 문자열로 — 1억 미만은 천만 단위 */
export function fmtRange(low: number, high: number): string {
  const f = (n: number) => (n < 1 ? `${Math.round(n * 10)}천만` : `${round1(n)}억`);
  return `약 ${f(low)} ~ ${f(high)} 원`;
}

export function estimateValue(input: ValueInput): ValueResult {
  const rev = REV_INTERVAL[input.revenueBand] ?? [1, 5];
  const base = BASE_MULT[input.group] ?? [0.4, 1.0];
  const factors: string[] = [
    `분야 기준 배수 ${base[0]}~${base[1]}배(연매출 대비)`,
    `연매출 밴드 → ${rev[0]}~${rev[1]}억 구간으로 사상`,
  ];
  let adj = 0;
  const assetSum = input.assets.reduce((s, a) => s + (ASSET_W[a] ?? 0), 0);
  if (assetSum > 0) { adj += assetSum; factors.push(`이전 자산 구성 가중 +${round1(assetSum)}배 (${input.assets.length}종)`); }
  const h = HANDOVER_W[input.handover] ?? 0;
  if (h) { adj += h; factors.push(`운영 인수인계(${input.handover}) +${h}배`); }
  const y = YEARS_W[input.years] ?? 0;
  if (y) { adj += y; factors.push(`운영 연차(${input.years}) ${y > 0 ? "+" : ""}${y}배`); }

  // 구간 연산 — 하한에는 조정치의 60%만 반영해 구간이 과도하게 좁아지지 않게 유지
  const multLow = Math.max(0.1, round1(base[0] + adj * 0.6));
  const multHigh = round1(base[1] + adj);
  const confidence: ValueResult["confidence"] = input.assets.length >= 3 && input.years ? "보통" : "낮음";
  return {
    low: round1(rev[0] * multLow), high: round1(rev[1] * multHigh),
    multLow, multHigh, confidence, factors,
  };
}
