/*
 * listings.js — 2단계(제휴 매칭)·3단계(거래소) 리스팅 데이터
 * ─────────────────────────────────────────────────────────────
 * ⚠️ 아래 항목은 화면 구성 확인용 "데모 예시"다(실제 제안·매물 아님).
 *    실제 운영 시: 접수된 제안/매물을 검수 후 이 파일에 추가하고 재배포한다.
 *    매물(deals)은 익명 코드명으로만 게시하고 실명·식별정보를 넣지 않는다(기획서 §12).
 *
 * partnerships 스키마: { id, type(제휴 유형), from(제안 플랫폼 분야 id), want(원하는 상대 분야 id[]),
 *                        title(한 줄), detail(조건 요약), size(규모 밴드), status: "open"|"matched" }
 * deals 스키마:        { id(코드명), category(분야 id), region, revenue(연매출 밴드), mode(희망 형태),
 *                        summary(익명 요약), status: "open"|"진행중"|"완료" }
 */
(function () {
  var LISTINGS = {
    partnerships: [
      { id: "P-101", type: "회원 상호송출", from: "funding", want: ["fashion", "handmade"], demo: true,
        title: "리워드 펀딩 종료 메이커에게 판매채널 연결", detail: "펀딩 성공 메이커를 상시 판매채널로 송출하고, 반대로 셀러의 신제품 펀딩을 유치. 정산은 양사 직접.", size: "월 활성 메이커 수백 명", status: "open" },
      { id: "P-102", type: "교차 프로모션", from: "pet", want: ["space"], demo: true,
        title: "반려동물 커머스 × 애견동반 숙소 상호 쿠폰", detail: "구매 고객에게 상대 서비스 쿠폰 제공. 비용 정산 없는 상호 노출 교환.", size: "월 주문 수천 건", status: "open" },
      { id: "P-103", type: "공동 이벤트", from: "fitness", want: ["food"], demo: true,
        title: "러닝 대회 × 건강식단 브랜드 공동 챌린지", detail: "완주자 대상 식단 구독 체험권 제공, 공동 마케팅.", size: "회당 참가자 1천 명+", status: "matched" }
    ],
    deals: [
      { id: "D-001", category: "handmade", region: "국내", revenue: "연매출 1~5억", mode: "지분 전량 매각", demo: true,
        summary: "운영 6년차 수공예 버티컬 마켓. 작가 풀·단골 고객 보유, 운영자 이직으로 매각 희망.", status: "open" },
      { id: "D-002", category: "delivery", region: "국내", revenue: "연매출 5~10억", mode: "지분 일부 + 운영 승계", demo: true,
        summary: "지역 기반 배달 중개. 가맹점 네트워크 안정적, 확장 자본 유치 또는 매각 병행 검토.", status: "open" },
      { id: "D-003", category: "content", region: "국내", revenue: "연매출 1억 미만", mode: "자산 양수도(회원·콘텐츠)", demo: true,
        summary: "니치 취미 클래스 플랫폼. 콘텐츠 라이브러리와 회원 DB 중심의 자산 매각.", status: "진행중" }
    ]
  };
  if (typeof window !== "undefined") window.LISTINGS = LISTINGS;
  if (typeof module !== "undefined" && module.exports) module.exports = LISTINGS;
})();
