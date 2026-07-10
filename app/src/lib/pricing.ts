/* 표시 가격 단일 소스(수익화 v2) — 결제 금액의 진짜 소스는 서버(place_order가
 * app_settings 'prices'에서 산정)이고, 이 상수는 "안내 표시" 전용이다.
 * 가격 변경 시: ① Supabase app_settings 'prices' 수정 ② 이 파일 동기화 ③ pricing-policy.md 개정.
 * 전부 VAT 포함 표시가(pricing-policy.md 규약). 성공보수·거래액 연동 상품은 존재하지 않는다. */
export const PRICES = {
  sponsor: 99000,      // 스폰서 슬롯(매칭 보드 상단 2슬롯·AD 표기) — 월
  connB: 22000,        // 연결료 B형(성과 레퍼럴) — 소개 실행 건당 후불
  connC: 77000,        // 연결료 C형(깊은 연동) — 소개 실행 건당 후불
  pro: 66000,          // Pro 멤버십 — 월(B형 소개 3건 포함)
  buyer: 55000,        // 인수자 멤버십 — 월(신규 매물 48시간 선공개 + 브리프 무제한)
  listing: 220000,     // 매물 리스팅료 — 90일(검수·익명화·소개 무제한 포함, 반려 시 전액 환불)
  listingExt: 110000,  // 리스팅 연장 — +90일
  credit50: { pay: 50000, get: 55000 },    // 선불 크레딧(연결료 지갑) — 10% 보너스
  credit100: { pay: 100000, get: 115000 }, // 15% 보너스
} as const;

export const won = (n: number): string => `${n.toLocaleString("ko-KR")}원`;
