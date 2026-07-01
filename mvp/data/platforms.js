/*
 * 플랫폼 데이터 (MVP 시드)
 * ─────────────────────────────────────────────────────────────
 * ⚠️ 데모용 예시 데이터입니다. 수수료·정산 조건은 실제와 다를 수 있으며,
 *    정식 서비스에서는 각 항목에 evidence(출처·검증일)를 강제합니다.
 *    (기획서 §7.2 데이터 무결성 원칙 참조)
 *
 * 비컨헤드(깊게): 크라우드펀딩  → 전체 스키마 채움
 * 카탈로그(얕게): 나머지 5개 버티컬 → 기본 정보만
 */
window.VERTICALS = [
  { id: "crowdfunding", name: "크라우드펀딩", depth: "deep",    desc: "리워드·투자형 자금조달 플랫폼", icon: "🎯" },
  { id: "freelance",    name: "프리랜서마켓", depth: "catalog", desc: "재능·용역 거래 플랫폼",       icon: "🧑‍💻" },
  { id: "delivery",     name: "배달·주문",   depth: "catalog", desc: "음식·상품 배달 중개",         icon: "🛵" },
  { id: "export",       name: "수출입",      depth: "catalog", desc: "국경 간 거래·조달 플랫폼",     icon: "🚢" },
  { id: "groupbuy",     name: "공동구매",    depth: "catalog", desc: "공동구매·소싱 플랫폼",         icon: "🛒" },
  { id: "distribution", name: "유통·입점",   depth: "catalog", desc: "판매채널·오픈마켓 입점",       icon: "🏬" }
];

window.PLATFORMS = [
  // ───────── 비컨헤드: 크라우드펀딩 (전체 스키마) ─────────
  {
    platform_id: "wadiz",
    name: "와디즈",
    vertical: "crowdfunding",
    purpose: ["자금조달"],
    region: ["국내"],
    languages: ["ko"],
    funding_type: "리워드/투자",
    fee_model: { type: "percent", rate_min: 7, rate_max: 9, hidden_fees: ["PG 수수료 별도", "부가세 별도"] },
    settlement: { cycle_days: 14, holdback_pct: 0, escrow: false, dispute_policy: "펀딩 종료 후 정산, 배송 지연 시 조정" },
    onboarding: { biz_type_required: "개인/개인사업자/법인", review_days: 7, setup_cost: 0 },
    scale: { b2b_b2c: "B2C", geo: "국내", traffic_tier: "상(추정)" },
    highlights: ["국내 최대 트래픽", "투자형(증권형) 병행", "메이커 심사 엄격"],
    cautions: ["성공수수료+PG로 실부담 두 자릿수 가능", "심사 반려 사례 많음"],
    evidence: { source: "데모(공개정보 기반 추정)", verified_at: "2026-07-01", confidence: "low" }
  },
  {
    platform_id: "tumblbug",
    name: "텀블벅",
    vertical: "crowdfunding",
    purpose: ["자금조달"],
    region: ["국내"],
    languages: ["ko"],
    funding_type: "리워드",
    fee_model: { type: "percent", rate_min: 5, rate_max: 8, hidden_fees: ["PG 수수료 포함형", "부가세 별도"] },
    settlement: { cycle_days: 15, holdback_pct: 0, escrow: false, dispute_policy: "정산 신청 기반, 서류 확인" },
    onboarding: { biz_type_required: "개인/사업자", review_days: 5, setup_cost: 0 },
    scale: { b2b_b2c: "B2C", geo: "국내", traffic_tier: "중상(추정)" },
    highlights: ["창작·콘텐츠 프로젝트 강세", "리워드형 특화", "심사 상대적 유연"],
    cautions: ["투자형 없음", "대형 제조 프로젝트엔 부적합할 수 있음"],
    evidence: { source: "데모(공개정보 기반 추정)", verified_at: "2026-07-01", confidence: "low" }
  },
  {
    platform_id: "ohmycompany",
    name: "오마이컴퍼니",
    vertical: "crowdfunding",
    purpose: ["자금조달"],
    region: ["국내"],
    languages: ["ko"],
    funding_type: "리워드/투자",
    fee_model: { type: "percent", rate_min: 5, rate_max: 10, hidden_fees: ["PG 수수료 별도"] },
    settlement: { cycle_days: 14, holdback_pct: 0, escrow: false, dispute_policy: "프로젝트별 상이" },
    onboarding: { biz_type_required: "개인/사업자/단체", review_days: 7, setup_cost: 0 },
    scale: { b2b_b2c: "B2C", geo: "국내", traffic_tier: "중(추정)" },
    highlights: ["소셜·공익 프로젝트 강세", "증권형 크라우드펀딩 취급"],
    cautions: ["일반 리워드 트래픽은 대형 대비 낮을 수 있음"],
    evidence: { source: "데모(공개정보 기반 추정)", verified_at: "2026-07-01", confidence: "low" }
  },
  {
    platform_id: "crowdy",
    name: "크라우디",
    vertical: "crowdfunding",
    purpose: ["자금조달"],
    region: ["국내"],
    languages: ["ko"],
    funding_type: "투자/리워드",
    fee_model: { type: "percent", rate_min: 6, rate_max: 10, hidden_fees: ["증권형 별도 비용"] },
    settlement: { cycle_days: 21, holdback_pct: 0, escrow: true, dispute_policy: "증권형 규제 절차 준수" },
    onboarding: { biz_type_required: "법인 중심", review_days: 14, setup_cost: 0 },
    scale: { b2b_b2c: "B2B/B2C", geo: "국내", traffic_tier: "중(추정)" },
    highlights: ["증권형(투자) 크라우드펀딩 특화"],
    cautions: ["투자형은 규제·심사 기간 김", "개인 창작자엔 진입장벽"],
    evidence: { source: "데모(공개정보 기반 추정)", verified_at: "2026-07-01", confidence: "low" }
  },
  {
    platform_id: "happybean",
    name: "해피빈 펀딩",
    vertical: "crowdfunding",
    purpose: ["자금조달"],
    region: ["국내"],
    languages: ["ko"],
    funding_type: "기부/리워드",
    fee_model: { type: "percent", rate_min: 0, rate_max: 5, hidden_fees: ["PG 수수료"] },
    settlement: { cycle_days: 30, holdback_pct: 0, escrow: false, dispute_policy: "기부금 처리 절차 준수" },
    onboarding: { biz_type_required: "단체/공익", review_days: 10, setup_cost: 0 },
    scale: { b2b_b2c: "B2C", geo: "국내", traffic_tier: "중상(네이버 연동, 추정)" },
    highlights: ["기부·공익 특화", "네이버 트래픽 연동"],
    cautions: ["상업 프로젝트엔 부적합", "정산주기 김"],
    evidence: { source: "데모(공개정보 기반 추정)", verified_at: "2026-07-01", confidence: "low" }
  },
  {
    platform_id: "kickstarter",
    name: "킥스타터(해외)",
    vertical: "crowdfunding",
    purpose: ["자금조달"],
    region: ["해외"],
    languages: ["en", "ko"],
    funding_type: "리워드",
    fee_model: { type: "percent", rate_min: 8, rate_max: 10, hidden_fees: ["결제수수료 3~5%", "환율·송금 비용"] },
    settlement: { cycle_days: 14, holdback_pct: 0, escrow: false, dispute_policy: "All-or-Nothing 방식" },
    onboarding: { biz_type_required: "해외 결제계좌 필요", review_days: 3, setup_cost: 0 },
    scale: { b2b_b2c: "B2C", geo: "글로벌", traffic_tier: "상(글로벌, 추정)" },
    highlights: ["글로벌 도달", "하드웨어·게임 강세"],
    cautions: ["목표 미달 시 전액 무산(AoN)", "환율·세금·배송 복잡", "국내 정산 번거로움"],
    evidence: { source: "데모(공개정보 기반 추정)", verified_at: "2026-07-01", confidence: "low" }
  },

  // ───────── 카탈로그(얕게): 나머지 버티컬 대표 플랫폼 스텁 ─────────
  { platform_id: "kmong",       name: "크몽",         vertical: "freelance",    region: ["국내"], stub: true, note: "재능·용역 마켓 (상세 비교 준비 중)" },
  { platform_id: "soomgo",      name: "숨고",         vertical: "freelance",    region: ["국내"], stub: true, note: "전문가 매칭 (상세 비교 준비 중)" },
  { platform_id: "baemin",      name: "배달의민족",   vertical: "delivery",     region: ["국내"], stub: true, note: "배달 중개 (상세 비교 준비 중)" },
  { platform_id: "coupangeats", name: "쿠팡이츠",     vertical: "delivery",     region: ["국내"], stub: true, note: "배달 중개 (상세 비교 준비 중)" },
  { platform_id: "tradekorea",  name: "tradeKorea",   vertical: "export",       region: ["해외"], stub: true, note: "B2B 수출입 (상세 비교 준비 중)" },
  { platform_id: "alibaba",     name: "알리바바닷컴", vertical: "export",       region: ["해외"], stub: true, note: "글로벌 소싱 (상세 비교 준비 중)" },
  { platform_id: "domeggook",   name: "도매꾹",       vertical: "groupbuy",     region: ["국내"], stub: true, note: "도매·공동구매 (상세 비교 준비 중)" },
  { platform_id: "smartstore",  name: "스마트스토어", vertical: "distribution", region: ["국내"], stub: true, note: "네이버 입점 (상세 비교 준비 중)" },
  { platform_id: "coupang",     name: "쿠팡",         vertical: "distribution", region: ["국내"], stub: true, note: "오픈마켓 입점 (상세 비교 준비 중)" }
];
