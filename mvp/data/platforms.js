/*
 * 플랫폼 데이터 (비컨헤드 검증판 v2)  ── 단일 소스 (build.js 프리렌더가 사용)
 * ─────────────────────────────────────────────────────────────
 * 검증 방법(정직 고지): 아래 크라우드펀딩 6개는 각 플랫폼 "공식 페이지" 출처(source_url)에 근거한다.
 *   단, 조사 시점(2026-07-01) 모든 공식 도메인이 자동 조회(fetch)를 차단(HTTP 403)하여
 *   검색엔진이 캐싱한 공식 페이지 스니펫으로 교차확인했다. 원문 표를 직접 열람하지 못했으므로
 *   confidence 상한은 'mid'다. 'high' 승급은 담당자가 라이브 페이지를 육안 대조해야 가능.
 *   요율이 공개되지 않은 항목(fee_model.disclosed=false)은 숫자를 지어내지 않고 '비공개'로 둔다.
 *
 * evidence.confidence: high(원문 직접확인)=현재 없음 / mid(공식 스니펫 교차확인) / low(핵심수치 미공개 or 2차)
 * fee_model.disclosed=false → rate_min/max는 null(요율 비공개). facts=사실성 주석(출처有), cautions=평가성(high에서만 렌더).
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
      // ───────── 와디즈 (mid: 공식 스니펫 교차확인) ─────────
      {
        platform_id: "wadiz", name: "와디즈", vertical: "crowdfunding",
        purpose: ["자금조달"], region: ["국내"], languages: ["ko"],
        funding_type: "리워드/투자(증권형)",
        outbound_url: "https://www.wadiz.kr", promoted: false,
        // 2026-02-02 개편 '글로벌 표준 요금제': Basic 10% / Pro 13% / Expert 19%+ (VAT 별도)
        fee_model: { type: "percent", disclosed: true, rate_min: 10, rate_max: 19, pg_included: false, vat_included: false,
          hidden_fees: ["결제대행(PG) 3%(국내)/4%(해외)", "기본 서비스 이용료 99,000원(성공·100만원↑)", "부가세 별도"] },
        settlement: { cycle_days: 10, holdback_pct: 40, escrow: false,
          dispute_policy: "종료 후 10영업일 내 정산내역서 → 월·수·금 지급(선정산 60%, 리워드 발송·환불 완료 후 40%)" },
        onboarding: { biz_type_required: "후원형=비사업자 개인 / 프리오더=통신판매신고 사업자 / 투자형=법인", review_days: null, setup_cost: 0 },
        scale: { b2b_b2c: "B2C", geo: "국내", traffic_tier: "상(추정)" },
        highlights: ["국내 최대 트래픽", "투자형(증권형) 병행"],
        facts: ["2026-02-02 요금제 전면 개편(Basic 10 / Pro 13 / Expert 19%+, VAT 별도)", "정산유보: 선정산 60% + 리워드 발송·환불 완료 후 40%"],
        cautions: ["메이커 심사가 엄격한 편(평가성)"],
        evidence: { source: "와디즈 도움말센터(요금제 안내)", source_url: "https://helpcenter.wadiz.kr/hc/ko/articles/25375315142169",
          method: "공식 스니펫 교차확인(원문 직접열람 불가·403)", verified_at: "2026-07-01", last_checked: "2026-07-01", next_review_due: "2026-10-01", confidence: "mid" }
      },
      // ───────── 텀블벅 (mid) ─────────
      {
        platform_id: "tumblbug", name: "텀블벅", vertical: "crowdfunding",
        purpose: ["자금조달"], region: ["국내"], languages: ["ko"],
        funding_type: "리워드",
        outbound_url: "https://tumblbug.com", promoted: false,
        // 요금제: Start 5% / Run 9% / Boost 15% (VAT 별도) + 결제대행 3% 별도
        fee_model: { type: "percent", disclosed: true, rate_min: 5, rate_max: 15, pg_included: false, vat_included: false,
          hidden_fees: ["결제 등 대행수수료 3%", "부가세 별도"] },
        settlement: { cycle_days: 7, holdback_pct: 0, escrow: false,
          dispute_policy: "결제 종료일로부터 은행 영업일 7일 후 정산(주말·공휴일 제외)" },
        onboarding: { biz_type_required: "개인/개인사업자(만 19세+, 본인 명의 계좌)", review_days: 7, setup_cost: 0 },
        scale: { b2b_b2c: "B2C", geo: "국내", traffic_tier: "중상(추정)" },
        highlights: ["창작·콘텐츠 프로젝트 강세", "리워드형 특화"],
        facts: ["플랫폼 수수료와 결제대행(PG) 3%는 별도 합산(각 VAT 별도)", "성공 프로젝트에만 부과, 무산 시 면제", "요금제 시행일 2025-07-24"],
        cautions: [],
        evidence: { source: "텀블벅 도움말센터(수수료 정책, 2025-07-24)", source_url: "https://help.tumblbug.com/hc/ko/articles/4746140140057",
          method: "공식 스니펫 교차확인(원문 직접열람 불가·403)", verified_at: "2026-07-01", last_checked: "2026-07-01", next_review_due: "2026-10-01", confidence: "mid" }
      },
      // ───────── 오마이컴퍼니 (low: 요율 미공개) ─────────
      {
        platform_id: "ohmycompany", name: "오마이컴퍼니", vertical: "crowdfunding",
        purpose: ["자금조달"], region: ["국내"], languages: ["ko"],
        funding_type: "리워드/투자(증권형)",
        outbound_url: "https://www.ohmycompany.com", promoted: false,
        fee_model: { type: "percent", disclosed: false, rate_min: null, rate_max: null, pg_included: false, vat_included: false,
          hidden_fees: ["플랫폼이용수수료(요율 비공개)", "결제대행(PG) 별도", "부가세 별도"], note: "플랫폼 수수료율 공식 미공개(직접 문의)" },
        settlement: { cycle_days: 10, holdback_pct: 0, escrow: false,
          dispute_policy: "마감 후 4~10일 내 정산서(Keep-it-all 4~7일 / All-or-nothing 7~10일) → 화·목 지급" },
        onboarding: { biz_type_required: "개인/사업자/단체 (증권형=창업 7년내 중소기업)", review_days: null, setup_cost: 0 },
        scale: { b2b_b2c: "B2C", geo: "국내", traffic_tier: "중(추정)" },
        highlights: ["소셜·공익 프로젝트 강세", "증권형 크라우드펀딩 취급"],
        facts: ["플랫폼 수수료율은 공개 페이지에 미기재 → 직접 문의 필요", "정부지원(우리동네 크라우드펀딩) 한시적 수수료 감면 존재"],
        cautions: [],
        evidence: { source: "오마이컴퍼니 메이커 이용가이드", source_url: "https://www.ohmycompany.com/guide/maker/reward/20",
          method: "공식 스니펫(구조 확인, 요율 미공개)·403", verified_at: "2026-07-01", last_checked: "2026-07-01", next_review_due: "2026-10-01", confidence: "low" }
      },
      // ───────── 크라우디 (low: 증권형, 성공수수료 미공개) ─────────
      {
        platform_id: "crowdy", name: "크라우디", vertical: "crowdfunding",
        purpose: ["자금조달"], region: ["국내"], languages: ["ko"],
        funding_type: "투자(증권형) 특화",
        outbound_url: "https://www.ycrowdy.com", promoted: false,
        fee_model: { type: "mixed", disclosed: false, rate_min: null, rate_max: null, pg_included: false, vat_included: false,
          hidden_fees: ["착수수수료 330만원(VAT 포함)", "성공수수료(요율 비공개)", "투자자 청약금액의 1%(최소 1만원)"], note: "증권형: 발행사 성공수수료율 비공개" },
        settlement: { cycle_days: null, holdback_pct: 0, escrow: true,
          dispute_policy: "증권형: 청약증거금 관리기관(은행/증권금융) 예치, 성공 시 발행사 납입·증권 예탁(이벤트 기반)" },
        onboarding: { biz_type_required: "주식회사 법인(설립 7년내 중소기업, 벤처는 예외). 금융·부동산·유흥업 제외", review_days: null, setup_cost: 3300000 },
        scale: { b2b_b2c: "B2B/B2C", geo: "국내", traffic_tier: "중(추정)" },
        highlights: ["증권형(투자) 크라우드펀딩 특화(온라인소액투자중개업 등록)"],
        facts: ["착수수수료 330만원(VAT 포함) + 성공수수료(비공개) + 투자자 이용료 1%", "자본시장법 규제: 청약증거금 관리기관 예치·한국예탁결제원 예탁", "모집 성공 기준 80%·청약기간 최소 10일(법정)"],
        cautions: [],
        evidence: { source: "크라우디(equity.ycrowdy.com) 발행사 안내", source_url: "https://equity.ycrowdy.com/101/company",
          method: "공식 스니펫(성공수수료율 미공개)·403", verified_at: "2026-07-01", last_checked: "2026-07-01", next_review_due: "2026-10-01", confidence: "low" }
      },
      // ───────── 해피빈 펀딩 (low: 공익·수수료 0%, 정산일 미확인) ─────────
      {
        platform_id: "happybean", name: "해피빈 펀딩", vertical: "crowdfunding",
        purpose: ["자금조달"], region: ["국내"], languages: ["ko"],
        funding_type: "기부/리워드(공익)",
        outbound_url: "https://happybean.naver.com", promoted: false,
        fee_model: { type: "percent", disclosed: true, rate_min: 0, rate_max: 0, pg_included: true, vat_included: false,
          hidden_fees: [], note: "플랫폼 수수료 면제 — 재단이 PG 부담, 참여금 100% 전달" },
        settlement: { cycle_days: null, holdback_pct: 0, escrow: false, dispute_policy: "정산주기(일) 공식 미확인" },
        onboarding: { biz_type_required: "공익단체/소상공인/창작자 (정기 영리사업자는 불가)", review_days: null, setup_cost: 0 },
        scale: { b2b_b2c: "B2C", geo: "국내", traffic_tier: "중상(네이버 연동, 추정)" },
        highlights: ["기부·공익 특화", "네이버 트래픽 연동", "참여금 100% 전달(수수료 재단 부담)"],
        facts: ["플랫폼 수수료 0%(재단이 PG 수수료까지 부담)", "정산주기·부가세 처리는 공식 미확인 → 고객센터 확인 필요"],
        cautions: [],
        evidence: { source: "해피빈(2차 출처 다수 일관) — 공식 열람 차단", source_url: "https://happybean.naver.com",
          method: "2차 출처 스니펫 교차(공식 403)", verified_at: "2026-07-01", last_checked: "2026-07-01", next_review_due: "2026-10-01", confidence: "low" }
      },
      // ───────── 킥스타터 (mid) ─────────
      {
        platform_id: "kickstarter", name: "킥스타터(해외)", vertical: "crowdfunding",
        purpose: ["자금조달"], region: ["해외"], languages: ["en", "ko"],
        funding_type: "리워드(All-or-Nothing)",
        outbound_url: "https://www.kickstarter.com", promoted: false,
        // 플랫폼 수수료 5% (성공 시) + 결제처리(Stripe) 3~5% 별도
        fee_model: { type: "percent", disclosed: true, rate_min: 5, rate_max: 5, pg_included: false, vat_included: false,
          hidden_fees: ["결제처리(Stripe) 3~5% 별도", "환율·해외송금 비용"] },
        settlement: { cycle_days: 14, holdback_pct: 0, escrow: false,
          dispute_policy: "마감 14일간 결제 수집 → 지급 개시, 이후 금융기관 3~14영업일" },
        onboarding: { biz_type_required: "지원국 거주자(정부 신분증+현지 은행계좌). 한국 미지원", review_days: null, setup_cost: 0 },
        scale: { b2b_b2c: "B2C", geo: "글로벌", traffic_tier: "상(글로벌, 추정)" },
        highlights: ["글로벌 도달", "하드웨어·게임 강세"],
        facts: ["플랫폼 수수료 5% + 결제처리(Stripe) 3~5% 별도(성공 시)", "한국 거주 창작자는 직접 이용 불가(지원국 아님) — 미국 법인 등 우회 필요", "All-or-Nothing: 목표 미달 시 전액 미집행·수수료 없음"],
        cautions: [],
        evidence: { source: "Kickstarter Support(What are the fees)", source_url: "https://help.kickstarter.com/hc/en-us/articles/115005028634-What-are-the-fees",
          method: "공식 스니펫 교차확인(원문 직접열람 불가·403)", verified_at: "2026-07-01", last_checked: "2026-07-01", next_review_due: "2026-10-01", confidence: "mid" }
      },

      // ───────── 카탈로그(얕게): 최소 유틸 스텁 (noindex 대상) ─────────
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

  if (typeof window !== "undefined") { window.VERTICALS = CFG.verticals; window.PLATFORMS = CFG.platforms; }
  if (typeof module !== "undefined" && module.exports) { module.exports = CFG; }
})();
