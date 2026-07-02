/* 서비스 단계 플래그 — 정식 오픈 시 true로. */
export const FLAGS = {
  stage2: false, // 🤝 제휴 매칭
  stage3: false, // 🏦 플랫폼 거래소
  contactEmail: "", // 비공개 접수 이메일(선택)
};

/* 관리자 로컬 열람: localhost에서만 오픈 전 보드가 보인다(공개 URL 우회 불가). */
export function isLocalAdmin(): boolean {
  const h = location.hostname;
  return h === "localhost" || h === "127.0.0.1" || h === "0.0.0.0" || h === "";
}
