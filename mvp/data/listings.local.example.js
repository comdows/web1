/*
 * listings.local.example.js — 관리자 실데이터 템플릿(예시)
 * ─────────────────────────────────────────────────────────────
 * 사용법:
 *   1) 이 파일을 같은 폴더에 `listings.local.js` 로 복사한다.
 *        cp data/listings.local.example.js data/listings.local.js   (Windows: copy)
 *   2) 아래 배열에 실제 접수된 제휴 제안/매물을 채운다.
 *   3) 로컬에서 확인:  cd mvp && python -m http.server 8000
 *        → http://localhost:8000/partners.html  (관리자만, 로컬에서만 보임)
 *
 * ⚠️ 중요
 *   - `listings.local.js` 는 .gitignore 처리되어 저장소/공개 배포에 절대 올라가지 않는다.
 *     (그래서 여기에 담긴 실데이터는 공개되지 않는다. 이것이 "관리자 로컬 전용"의 핵심.)
 *   - 그래도 개인정보(연락처·실명·이메일)는 넣지 말 것. 연락은 접수 후 비공개 채널로.
 *   - 매물(deals)은 익명 코드명만.
 *   - 이 파일이 있으면 공개용 listings.js 의 데모 데이터를 덮어쓴다(같은 window.LISTINGS).
 *
 * 스키마는 data/listings.js 주석 참고(partnerships v2 / deals).
 */
(function () {
  var LISTINGS = {
    partnerTypes: ["회원 상호송출", "교차 프로모션", "공동 이벤트", "광고 지면 교환", "공동구매·번들"],
    partnerships: [
      // 예: 접수·검수 통과한 실제 제휴 제안을 여기에.
      // { id: "P-201", type: "교차 프로모션", from: "fashion", want: ["beautyhealth"], verified: true,
      //   title: "...", detail: "...", give: "...", get: "...",
      //   size: "...", posted: "2026-07-02", status: "open" }
    ],
    deals: [
      // 예: 익명 코드명 매물.
      // { id: "D-101", category: "content", region: "국내", revenue: "연매출 1~5억",
      //   mode: "지분 매각", summary: "...", posted: "2026-07-02", status: "open" }
    ]
  };
  if (typeof window !== "undefined") window.LISTINGS = LISTINGS;
  if (typeof module !== "undefined" && module.exports) module.exports = LISTINGS;
})();
