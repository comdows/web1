/*
 * 플랫폼 디렉토리 데이터 (분야별 목록 + 개략 설명)
 * ─────────────────────────────────────────────────────────────
 * 형식: "어떤 분야에 어떤 플랫폼이 있는지 + 한 줄 설명" 큐레이션 디렉토리.
 * 수수료·정산 등 상세 비교는 다루지 않는다(개략 설명만).
 * blurb는 각 플랫폼이 '무엇인지'에 대한 중립적·사실적 한 줄 소개.
 * 상세 조건은 각 플랫폼 공식 사이트에서 확인.
 */
(function () {
  var CFG = {
    categories: [
      { id: "openmarket",   name: "오픈마켓·종합몰",     icon: "🏬", desc: "종합 이커머스에 입점해 파는 판매채널" },
      { id: "social",       name: "소셜·공동구매·특가",  icon: "🤝", desc: "공동구매·특가·선물하기 기반 판매채널" },
      { id: "live",         name: "라이브커머스",        icon: "📺", desc: "실시간 방송으로 파는 채널" },
      { id: "funding",      name: "크라우드펀딩",        icon: "🎯", desc: "선주문·투자로 자금을 모으는 플랫폼" },
      { id: "freelance",    name: "프리랜서·재능마켓",   icon: "🧑‍💻", desc: "일·재능·전문가 용역을 거래" },
      { id: "delivery",     name: "배달·주문중개",       icon: "🛵", desc: "음식·상품 주문을 중개" },
      { id: "fulfillment",  name: "물류·풀필먼트·배송대행", icon: "📦", desc: "보관·포장·출고를 대행" },
      { id: "global",       name: "수출입·해외판매",     icon: "🚢", desc: "해외 바이어·소비자에게 파는 B2B/B2C 채널" },
      { id: "wholesale",    name: "도매·소싱",           icon: "🏭", desc: "사입·도매 상품을 떼오는 채널" },
      { id: "space",        name: "숙박·공간·예약",      icon: "🏨", desc: "숙소·공간·예약 서비스 중개" },
      { id: "resale",       name: "중고·리커머스",       icon: "♻️", desc: "중고 거래 플랫폼" },
      { id: "content",      name: "콘텐츠·창작 수익화",  icon: "🎨", desc: "콘텐츠·강의·창작물로 수익화" }
    ],

    platforms: [
      // ── 오픈마켓·종합몰 ──
      { id:"coupang",     name:"쿠팡",            category:"openmarket", region:"국내", url:"https://www.coupang.com",            blurb:"로켓배송 물류망을 갖춘 국내 최대 종합 이커머스." },
      { id:"smartstore",  name:"네이버 스마트스토어", category:"openmarket", region:"국내", url:"https://smartstore.naver.com",       blurb:"네이버 검색·페이와 연동되는 입점형 쇼핑몰." },
      { id:"11st",        name:"11번가",          category:"openmarket", region:"국내", url:"https://www.11st.co.kr",             blurb:"SK 계열 종합 오픈마켓." },
      { id:"gmarket",     name:"G마켓",           category:"openmarket", region:"국내", url:"https://www.gmarket.co.kr",          blurb:"신세계 계열 오픈마켓(옥션과 통합 운영)." },
      { id:"auction",     name:"옥션",            category:"openmarket", region:"국내", url:"https://www.auction.co.kr",          blurb:"국내 1세대 오픈마켓, 경매·즉시구매." },
      { id:"ssg",         name:"SSG닷컴",         category:"openmarket", region:"국내", url:"https://www.ssg.com",                blurb:"신세계·이마트 기반 종합몰." },
      { id:"lotteon",     name:"롯데온",          category:"openmarket", region:"국내", url:"https://www.lotteon.com",            blurb:"롯데 유통 계열 통합 온라인몰." },
      { id:"interpark",   name:"인터파크쇼핑",    category:"openmarket", region:"국내", url:"https://shopping.interpark.com",     blurb:"공연·투어에 강한 종합 쇼핑몰." },

      // ── 소셜·공동구매·특가 ──
      { id:"allways",     name:"올웨이즈",        category:"social", region:"국내", url:"https://www.notefolio.net",          blurb:"팀 구매(공동구매) 기반 초저가 커머스." },
      { id:"kakaogift",   name:"카카오톡 선물하기", category:"social", region:"국내", url:"https://gift.kakao.com",             blurb:"카카오톡 기반 선물·모바일 쿠폰 판매." },
      { id:"wemakeprice", name:"위메프",          category:"social", region:"국내", url:"https://www.wemakeprice.com",        blurb:"특가·딜 중심 소셜커머스." },
      { id:"tmon",        name:"티몬",            category:"social", region:"국내", url:"https://www.tmon.co.kr",             blurb:"타임딜·특가 중심 소셜커머스." },
      { id:"ohou",        name:"오늘의집(스토어)", category:"social", region:"국내", url:"https://ohou.se",                    blurb:"인테리어·리빙 콘텐츠 연계 커머스." },

      // ── 라이브커머스 ──
      { id:"navershopl",  name:"네이버 쇼핑라이브", category:"live", region:"국내", url:"https://shoppinglive.naver.com",     blurb:"네이버 스마트스토어 연동 라이브 방송 판매." },
      { id:"grip",        name:"그립(Grip)",      category:"live", region:"국내", url:"https://www.grip.show",              blurb:"소상공인·1인 판매자 중심 라이브커머스." },
      { id:"kakaoshopl",  name:"카카오 쇼핑라이브", category:"live", region:"국내", url:"https://store.kakao.com",            blurb:"카카오 채널 기반 라이브 판매." },
      { id:"coupanglive", name:"쿠팡 라이브",     category:"live", region:"국내", url:"https://www.coupang.com",            blurb:"쿠팡 내 라이브 방송 판매." },

      // ── 크라우드펀딩 ──
      { id:"wadiz",       name:"와디즈",          category:"funding", region:"국내", url:"https://www.wadiz.kr",              blurb:"리워드·투자형을 모두 다루는 국내 최대 크라우드펀딩." },
      { id:"tumblbug",    name:"텀블벅",          category:"funding", region:"국내", url:"https://tumblbug.com",              blurb:"창작·콘텐츠 프로젝트 중심 리워드형 펀딩." },
      { id:"ohmycompany", name:"오마이컴퍼니",    category:"funding", region:"국내", url:"https://www.ohmycompany.com",       blurb:"소셜·공익 프로젝트와 증권형을 다루는 펀딩." },
      { id:"crowdy",      name:"크라우디",        category:"funding", region:"국내", url:"https://www.ycrowdy.com",           blurb:"증권형(투자형) 크라우드펀딩 특화." },
      { id:"happybean",   name:"해피빈 펀딩",     category:"funding", region:"국내", url:"https://happybean.naver.com",       blurb:"네이버 기반 기부·공익 펀딩." },
      { id:"kickstarter", name:"킥스타터",        category:"funding", region:"해외", url:"https://www.kickstarter.com",       blurb:"하드웨어·게임에 강한 글로벌 리워드 펀딩(한국 직접 개설 미지원)." },

      // ── 프리랜서·재능마켓 ──
      { id:"kmong",       name:"크몽",            category:"freelance", region:"국내", url:"https://kmong.com",               blurb:"디자인·마케팅·IT 등 재능·용역 거래 마켓." },
      { id:"soomgo",      name:"숨고",            category:"freelance", region:"국내", url:"https://soomgo.com",              blurb:"레슨·이사·수리 등 생활 전문가 매칭." },
      { id:"wishket",     name:"위시켓",          category:"freelance", region:"국내", url:"https://www.wishket.com",         blurb:"IT 개발·디자인 프로젝트 외주 매칭." },
      { id:"taling",      name:"탈잉",            category:"freelance", region:"국내", url:"https://taling.me",               blurb:"취미·직무 원데이 클래스·튜터 매칭." },
      { id:"loud",        name:"라우드소싱",      category:"freelance", region:"국내", url:"https://www.loud.kr",             blurb:"디자인 공모전·콘테스트 기반 외주." },
      { id:"otwojob",     name:"오투잡",          category:"freelance", region:"국내", url:"https://www.otwojob.com",         blurb:"재능·서비스 거래 마켓." },

      // ── 배달·주문중개 ──
      { id:"baemin",      name:"배달의민족",      category:"delivery", region:"국내", url:"https://www.baemin.com",           blurb:"국내 1위 음식 배달 주문 중개." },
      { id:"coupangeats", name:"쿠팡이츠",        category:"delivery", region:"국내", url:"https://www.coupangeats.com",       blurb:"쿠팡의 음식 배달 주문 중개." },
      { id:"yogiyo",      name:"요기요",          category:"delivery", region:"국내", url:"https://www.yogiyo.co.kr",          blurb:"음식 배달 주문 중개." },
      { id:"ddangyo",     name:"땡겨요",          category:"delivery", region:"국내", url:"https://www.ddangyo.com",           blurb:"신한 계열, 낮은 수수료를 내세운 배달 앱." },

      // ── 물류·풀필먼트·배송대행 ──
      { id:"fassto",      name:"파스토(FASSTO)",  category:"fulfillment", region:"국내", url:"https://www.fassto.ai",          blurb:"이커머스 셀러 대상 풀필먼트(보관·출고)." },
      { id:"dohandsome",  name:"두손컴퍼니",      category:"fulfillment", region:"국내", url:"https://dohandsome.com",         blurb:"소량·스타트업 친화 풀필먼트." },
      { id:"wekeep",      name:"위킵",            category:"fulfillment", region:"국내", url:"https://wekeep.co.kr",           blurb:"쇼핑몰 물류 대행·풀필먼트." },
      { id:"qxpress",     name:"큐익스프레스",    category:"fulfillment", region:"해외", url:"https://www.qxpress.net",        blurb:"국제 배송·해외 풀필먼트." },

      // ── 수출입·해외판매 ──
      { id:"alibaba",     name:"알리바바닷컴",    category:"global", region:"해외", url:"https://www.alibaba.com",           blurb:"글로벌 B2B 도매·소싱 마켓플레이스." },
      { id:"amazongs",    name:"아마존 글로벌셀링", category:"global", region:"해외", url:"https://sell.amazon.com",          blurb:"아마존 해외 마켓 입점·판매." },
      { id:"shopee",      name:"쇼피(Shopee)",    category:"global", region:"해외", url:"https://shopee.com",                blurb:"동남아·대만 중심 이커머스 마켓." },
      { id:"qoo10",       name:"큐텐(Qoo10)",     category:"global", region:"해외", url:"https://www.qoo10.com",             blurb:"일본 등 아시아권 오픈마켓." },
      { id:"tradekorea",  name:"tradeKorea",      category:"global", region:"해외", url:"https://www.tradekorea.com",        blurb:"KOTRA 운영 B2B 수출 매칭 플랫폼." },
      { id:"buykorea",    name:"바이코리아",      category:"global", region:"해외", url:"https://www.buykorea.org",          blurb:"KOTRA 운영 수출 지원 B2B 플랫폼." },
      { id:"ec21",        name:"EC21",            category:"global", region:"해외", url:"https://www.ec21.com",              blurb:"국내 대표 B2B 수출 마켓플레이스." },

      // ── 도매·소싱 ──
      { id:"domeggook",   name:"도매꾹",          category:"wholesale", region:"국내", url:"https://domeggook.com",          blurb:"국내 대표 온라인 도매·소량 사입." },
      { id:"domemedae",   name:"도매매",          category:"wholesale", region:"국내", url:"https://domeme.domeggook.com",   blurb:"배송대행(위탁판매) 특화 도매." },
      { id:"ownerclan",   name:"오너클랜",        category:"wholesale", region:"국내", url:"https://ownerclan.com",          blurb:"위탁판매용 대량 상품 소싱." },
      { id:"onchannel",   name:"온채널",          category:"wholesale", region:"국내", url:"https://www.onch3.co.kr",        blurb:"위탁·도매 상품 공급 플랫폼." },

      // ── 숙박·공간·예약 ──
      { id:"yanolja",     name:"야놀자",          category:"space", region:"국내", url:"https://www.yanolja.com",            blurb:"숙박·레저 예약 중개." },
      { id:"goodchoice",  name:"여기어때",        category:"space", region:"국내", url:"https://www.goodchoice.kr",          blurb:"숙박·액티비티 예약 중개." },
      { id:"airbnb",      name:"에어비앤비",      category:"space", region:"해외", url:"https://www.airbnb.co.kr",           blurb:"글로벌 숙소·체험 호스팅." },
      { id:"spacecloud",  name:"스페이스클라우드", category:"space", region:"국내", url:"https://www.spacecloud.kr",          blurb:"모임·연습·촬영 공간 시간 대여." },
      { id:"catchtable",  name:"캐치테이블",      category:"space", region:"국내", url:"https://www.catchtable.co.kr",       blurb:"식당 예약·웨이팅 중개." },

      // ── 중고·리커머스 ──
      { id:"daangn",      name:"당근마켓",        category:"resale", region:"국내", url:"https://www.daangn.com",             blurb:"지역 기반 중고 직거래·동네생활." },
      { id:"bunjang",     name:"번개장터",        category:"resale", region:"국내", url:"https://m.bunjang.co.kr",            blurb:"모바일 중고 거래(안전결제 제공)." },
      { id:"junggonara",  name:"중고나라",        category:"resale", region:"국내", url:"https://web.joongna.com",            blurb:"국내 최대 규모 중고 거래 커뮤니티/앱." },

      // ── 콘텐츠·창작 수익화 ──
      { id:"npremium",    name:"네이버 프리미엄콘텐츠", category:"content", region:"국내", url:"https://contents.premium.naver.com", blurb:"유료 구독 콘텐츠 발행·판매." },
      { id:"class101",    name:"클래스101",       category:"content", region:"국내", url:"https://class101.net",              blurb:"온라인 클래스 제작·판매(크리에이터)." },
      { id:"brunch",      name:"브런치스토리",    category:"content", region:"국내", url:"https://brunch.co.kr",              blurb:"글 발행·작가 활동 플랫폼." },
      { id:"youtube",     name:"유튜브",          category:"content", region:"글로벌", url:"https://www.youtube.com",          blurb:"영상 콘텐츠 게시·광고 수익화." }
    ]
  };

  if (typeof window !== "undefined") { window.CATEGORIES = CFG.categories; window.PLATFORMS = CFG.platforms; }
  if (typeof module !== "undefined" && module.exports) { module.exports = CFG; }
})();
