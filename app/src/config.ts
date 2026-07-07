/* 서비스 단계 플래그 — 정식 오픈 시 true로. */
export const FLAGS = {
  stage2: true,  // 🤝 제휴 매칭 — 오픈(무료 베타)
  stage3: true,  // 🏦 플랫폼 거래소 — 오픈(무료 베타)
  contactEmail: "comdows@hanmail.net", // 공개 문의처(푸터·방침·접수 안내에 노출 — 바꾸려면 이 값만 수정)
  googleAuth: false, // Google 원클릭 로그인 — Supabase 대시보드에서 provider 설정 후 true로 (README 참고)
  /* 과금 스위치(상품별) — 프론트 렌더 게이트. 서버 진실은 app_settings 'billing'(place_order가 검사)이라
   * 둘 다 켜야 열린다. 켜기 전 필수: 통신판매업 신고 → pricing-policy §6-2 개정 → 처리방침 §1 증빙 항목 →
   * 30일 공지(pricing_announced_at). 가격 안내·환불 원칙·파운더 예고는 항상 공개(정보 게시), 주문 CTA만 이 게이트. */
  billing: { sponsor: false, connection: false, membership: false },
  /* 제휴 제안 서버 발송 스위치 — 세모플이 대표 이메일로 직접 발송(Edge Function). 서버 진실은
   * app_settings 'outreach'.server_send. 둘 다 켜야 열린다. 켜기 전 필수(0015 머리 주석):
   * ① 이메일 발송 서비스+도메인 인증 ② 정보통신망법 수신거부·표기 ③ 처리방침+TERMS_VERSION ④ 발송량 모니터링.
   * off인 동안 제안 작성기는 "회원 본인 메일(mailto)"로 대신 발송한다(세모플은 발신자 아님). */
  outreach: false,
};

/* 관리자 로컬 열람: localhost에서만 오픈 전 보드가 보인다(공개 URL 우회 불가). */
export function isLocalAdmin(): boolean {
  const h = location.hostname;
  return h === "localhost" || h === "127.0.0.1" || h === "0.0.0.0" || h === "";
}
