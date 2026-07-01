/*
 * 플랫폼 데이터 (MVP 시드)  ── 단일 소스 (build.js 프리렌더가 이 파일을 사용)
 * ─────────────────────────────────────────────────────────────
 * ⚠️ 데모용 예시 데이터입니다. 수수료·정산 조건은 실제와 다를 수 있으며,
 *    모든 딥 레코드는 evidence(source·verified_at·source_url·신뢰도)를 강제합니다.
 *    confidence!=='high' 이거나 비공식 출처면, 평가성 부정 서술은 화면에 렌더되지 않습니다.
 *    (기획서 §7.2 데이터 무결성 · §12 법적 노출 대응)
 *
 * 비컨헤드(깊게): 크라우드펀딩  → 전체 스키마 채움 (deep)
 * 카탈로그(얕게): 나머지 5개 버티컬 → 최소 유틸(공개 수수료 1줄 + 출처 + 계산기 연결)
 *
 * fee_model.pg_included / vat_included : 수수료에 PG·부가세가 이미 포함되는지(계산기 이중계상 방지)
 */
(function () {
  var CFG = {
    verticals: [
      { id: "crowdfunding", name: "크라우드펀딩", depth: "deep",    desc: "리워드·투자형 자금조달 플랫폼", icon: "🎯" },
      { id: "freelance",    name: "프리랜서마켓", depth: "catalog", desc: "재능·용역 거래 플랫폼",       icon: "🧑‍💻" },
      { id: "delivery",     name: "배달·주문",   depth: "catalog", desc: "음식·상품 배달 중개",         icon: "🛵" },
      { id: "export",       name: "수출입",      depth: "catalog", desc: "국경 간 거래·조달 플랫폼",     icon: "🚢" },
      { id: "groupbuy",     name: "공동구매",    depth: "catalog", desc: "공동구매·소싱 플랫폼",         icon: "🛒" },
      { id: "distribution", name: "유통·입점",   depth: "catalog", desc: "판매채널·오픈마켓 입점",       icon: "🏬" }
    ],

    platforms: [
      // ───────── 비컨헤드: 크라우드펀딩 (전체 스키마 · deep) ─────────
      {
        platform_id: "wadiz", name: "와디즈", vertical: "crowdfunding",
        purpose: ["자금조달"], region: ["국내"], languages: ["ko"],
        funding_type: "리워드/투자",
        outbound_url: "https://www.wadiz.kr", promoted: false,
        fee_model: { type: "percent", rate_min: 7, rate_max: 9, pg_included: false, vat_included: false, hidden_fees: ["PG 수수료 별도", "부가세 별도"] },
        settlement: { cycle_days: 14, holdback_pct: 0, escrow: false, dispute_policy: "펀딩 종료 후 정산" },
        onboarding: { biz_type_required: "개인/개인사업자/법인", review_days: 7, setup_cost: 0 },
        scale: { b2b_b2c: "B2C", geo: "국내", traffic_tier: "상(추정)" },
        highlights: ["국내 최대 트래픽", "투자형(증권형) 병행"],
        cautions: ["메이커 심사가 엄격한 편"],
        evidence: { source: "데모(공개정보 기반 추정)", source_url: "https://www.wadiz.kr", verified_at: "2026-07-01", last_checked: "2026-07-01", next_review_due: "2026-10-01", confidence: "low" }
      },
      {
        platform_id: "tumblbug", name: "텀블벅", vertical: "crowdfunding",
        purpose: ["자금조달"], region: ["국내"], languages: ["ko"],
        funding_type: "리워드",
        outbound_url: "https://tumblbug.com", promoted: false,
        fee_model: { type: "percent", rate_min: 5, rate_max: 8, pg_included: true, vat_included: false, hidden_fees: ["PG 수수료 포함형", "부가세 별도"] },
        settlement: { cycle_days: 15, holdback_pct: 0, escrow: false, dispute_policy: "정산 신청 기반, 서류 확인" },
        onboarding: { biz_type_required: "개인/사업자", review_days: 5, setup_cost: 0 },
        scale: { b2b_b2c: "B2C", geo: "국내", traffic_tier: "중상(추정)" },
        highlights: ["창작·콘텐츠 프로젝트 강세", "리워드형 특화"],
        cautions: ["투자형은 취급하지 않음"],
        evidence: { source: "데모(공개정보 기반 추정)", source_url: "https://tumblbug.com", verified_at: "2026-07-01", last_checked: "2026-07-01", next_review_due: "2026-10-01", confidence: "low" }
      },
      {
        platform_id: "ohmycompany", name: "오마이컴퍼니", vertical: "crowdfunding",
        purpose: ["자금조달"], region: ["국내"], languages: ["ko"],
        funding_type: "리워드/투자",
        outbound_url: "https://www.ohmycompany.com", promoted: false,
        fee_model: { type: "percent", rate_min: 5, rate_max: 10, pg_included: false, vat_included: false, hidden_fees: ["PG 수수료 별도"] },
        settlement: { cycle_days: 14, holdback_pct: 0, escrow: false, dispute_policy: "프로젝트별 상이" },
        onboarding: { biz_type_required: "개인/사업자/단체", review_days: 7, setup_cost: 0 },
        scale: { b2b_b2c: "B2C", geo: "국내", traffic_tier: "중(추정)" },
        highlights: ["소셜·공익 프로젝트 강세", "증권형 크라우드펀딩 취급"],
        cautions: [],
        evidence: { source: "데모(공개정보 기반 추정)", source_url: "https://www.ohmycompany.com", verified_at: "2026-07-01", last_checked: "2026-07-01", next_review_due: "2026-10-01", confidence: "low" }
      },
      {
        platform_id: "crowdy", name: "크라우디", vertical: "crowdfunding",
        purpose: ["자금조달"], region: ["국내"], languages: ["ko"],
        funding_type: "투자/리워드",
        outbound_url: "https://www.ycrowdy.com", promoted: false,
        fee_model: { type: "percent", rate_min: 6, rate_max: 10, pg_included: false, vat_included: false, hidden_fees: ["증권형 별도 비용"] },
        settlement: { cycle_days: 21, holdback_pct: 0, escrow: true, dispute_policy: "증권형 규제 절차 준수" },
        onboarding: { biz_type_required: "법인 중심", review_days: 14, setup_cost: 0 },
        scale: { b2b_b2c: "B2B/B2C", geo: "국내", traffic_tier: "중(추정)" },
        highlights: ["증권형(투자) 크라우드펀딩 특화"],
        cautions: ["투자형은 심사 기간이 긴 편"],
        evidence: { source: "데모(공개정보 기반 추정)", source_url: "https://www.ycrowdy.com", verified_at: "2026-07-01", last_checked: "2026-07-01", next_review_due: "2026-10-01", confidence: "low" }
      },
      {
        platform_id: "happybean", name: "해피빈 펀딩", vertical: "crowdfunding",
        purpose: ["자금조달"], region: ["국내"], languages: ["ko"],
        funding_type: "기부/리워드",
        outbound_url: "https://happybean.naver.com", promoted: false,
        fee_model: { type: "percent", rate_min: 0, rate_max: 5, pg_included: false, vat_included: false, hidden_fees: ["PG 수수료"] },
        settlement: { cycle_days: 30, holdback_pct: 0, escrow: false, dispute_policy: "기부금 처리 절차 준수" },
        onboarding: { biz_type_required: "단체/공익", review_days: 10, setup_cost: 0 },
        scale: { b2b_b2c: "B2C", geo: "국내", traffic_tier: "중상(네이버 연동, 추정)" },
        highlights: ["기부·공익 특화", "네이버 트래픽 연동"],
        cautions: ["정산주기가 긴 편"],
        evidence: { source: "데모(공개정보 기반 추정)", source_url: "https://happybean.naver.com", verified_at: "2026-07-01", last_checked: "2026-07-01", next_review_due: "2026-10-01", confidence: "low" }
      },
      {
        platform_id: "kickstarter", name: "킥스타터(해외)", vertical: "crowdfunding",
        purpose: ["자금조달"], region: ["해외"], languages: ["en", "ko"],
        funding_type: "리워드",
        outbound_url: "https://www.kickstarter.com", promoted: false,
        fee_model: { type: "percent", rate_min: 8, rate_max: 10, pg_included: false, vat_included: false, hidden_fees: ["결제수수료 3~5%", "환율·송금 비용"] },
        settlement: { cycle_days: 14, holdback_pct: 0, escrow: false, dispute_policy: "All-or-Nothing 방식" },
        onboarding: { biz_type_required: "해외 결제계좌 필요", review_days: 3, setup_cost: 0 },
        scale: { b2b_b2c: "B2C", geo: "글로벌", traffic_tier: "상(글로벌, 추정)" },
        highlights: ["글로벌 도달", "하드웨어·게임 강세"],
        cautions: ["목표 미달 시 전액 무산(AoN)", "환율·세금·배송 절차가 복잡"],
        evidence: { source: "데모(공개정보 기반 추정)", source_url: "https://www.kickstarter.com", verified_at: "2026-07-01", last_checked: "2026-07-01", next_review_due: "2026-10-01", confidence: "low" }
      },

      // ───────── 카탈로그(얕게): 최소 유틸 스텁 (noindex 대상, 공개 수수료 1줄 + 출처) ─────────
      { platform_id: "kmong",       name: "크몽",         vertical: "freelance",    region: ["국내"], stub: true, official_fee_note: "판매자 수수료 구간제(공개 요율표 확인 필요)", source_url: "https://kmong.com", outbound_url: "https://kmong.com" },
      { platform_id: "soomgo",      name: "숨고",         vertical: "freelance",    region: ["국내"], stub: true, official_fee_note: "고수 견적/크레딧 모델(공식 안내 확인 필요)", source_url: "https://soomgo.com", outbound_url: "https://soomgo.com" },
      { platform_id: "baemin",      name: "배달의민족",   vertical: "delivery",     region: ["국내"], stub: true, official_fee_note: "중개·결제·배달 수수료 구조 상이(공식 상생요금 확인 필요)", source_url: "https://ceo.baemin.com", outbound_url: "https://www.baemin.com" },
      { platform_id: "coupangeats", name: "쿠팡이츠",     vertical: "delivery",     region: ["국내"], stub: true, official_fee_note: "중개 수수료 요금제 상이(공식 안내 확인 필요)", source_url: "https://store.coupangeats.com", outbound_url: "https://www.coupangeats.com" },
      { platform_id: "tradekorea",  name: "tradeKorea",   vertical: "export",       region: ["해외"], stub: true, official_fee_note: "B2B 매칭(무료/유료 서비스 혼재, 공식 안내 확인 필요)", source_url: "https://www.tradekorea.com", outbound_url: "https://www.tradekorea.com" },
      { platform_id: "alibaba",     name: "알리바바닷컴", vertical: "export",       region: ["해외"], stub: true, official_fee_note: "멤버십(Gold Supplier 등) 기반(공식 요금 확인 필요)", source_url: "https://www.alibaba.com", outbound_url: "https://www.alibaba.com" },
      { platform_id: "domeggook",   name: "도매꾹",       vertical: "groupbuy",     region: ["국내"], stub: true, official_fee_note: "판매 수수료·부가서비스 상이(공식 안내 확인 필요)", source_url: "https://domeggook.com", outbound_url: "https://domeggook.com" },
      { platform_id: "smartstore",  name: "스마트스토어", vertical: "distribution", region: ["국내"], stub: true, official_fee_note: "결제·매출연동 수수료(네이버 공식 요율 확인 필요)", source_url: "https://sell.smartstore.naver.com", outbound_url: "https://smartstore.naver.com" },
      { platform_id: "coupang",     name: "쿠팡",         vertical: "distribution", region: ["국내"], stub: true, official_fee_note: "카테고리별 판매수수료 상이(공식 요율표 확인 필요)", source_url: "https://wing.coupang.com", outbound_url: "https://www.coupang.com" }
    ]
  };

  // 브라우저 전역 + Node(require) 동시 지원 (build.js가 require)
  if (typeof window !== "undefined") {
    window.VERTICALS = CFG.verticals;
    window.PLATFORMS = CFG.platforms;
  }
  if (typeof module !== "undefined" && module.exports) {
    module.exports = CFG;
  }
})();
