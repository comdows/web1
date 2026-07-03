/* 서비스 단계 플래그 — 정식 오픈 시 true로. */
export const FLAGS = {
  stage2: true,  // 🤝 제휴 매칭 — 오픈(무료 베타)
  stage3: true,  // 🏦 플랫폼 거래소 — 오픈(무료 베타)
  contactEmail: "comdows@hanmail.net", // 공개 문의처(푸터·방침·접수 안내에 노출 — 바꾸려면 이 값만 수정)
};

/* 관리자 로컬 열람: localhost에서만 오픈 전 보드가 보인다(공개 URL 우회 불가). */
export function isLocalAdmin(): boolean {
  const h = location.hostname;
  return h === "localhost" || h === "127.0.0.1" || h === "0.0.0.0" || h === "";
}
