// ============================================================
// 세모플 — 플랫폼 데이터 단일 소스 (Single Source of Truth)
// ------------------------------------------------------------
// 이 파일은 모든 화면이 참조하는 플랫폼 데이터의 유일한 출처입니다.
// 응답 형태(shape)를 실제 API 응답과 동일하게 맞춰두었으므로,
// 정식 백엔드 연동 시 fetchPlatforms() 본문만 fetch 호출로 교체하면 됩니다.
//
//   // 교체 예시:
//   export async function fetchPlatforms() {
//     const res = await fetch('/api/platforms');
//     return (await res.json()).items;
//   }
//
// 각 화면(DC)의 logic 클래스에서:
//   async componentDidMount() {
//     const { fetchPlatforms } = await import('./data/platforms.js');
//     this.setState({ pool: await fetchPlatforms() });
//   }
// 형태로 불러와 state로 렌더링합니다.
// ============================================================

// 수수료대 표시 메타 (배지 색상)
export const FEE_META = {
  '낮음': { bg: 'rgba(44,192,138,.16)', color: '#2CC08A' },
  '중간': { bg: 'rgba(245,181,68,.15)', color: '#F5B544' },
  '높음': { bg: 'rgba(242,105,95,.15)', color: '#F2695F' },
};

export const CATEGORIES = [
  '오픈마켓·종합몰', '크라우드펀딩', '패션·편집샵',
  '수출입·도매', '사무·MRO·B2B', '프리랜서·전문가',
];

export const REGIONS = ['국내', '해외'];

// 플랫폼 레코드 (API 응답 1건과 동일한 형태)
export const PLATFORMS = [
  {
    id: 'coupang', name: '쿠팡', initial: '쿠', grad: 'linear-gradient(135deg,#3D63FF,#2445D4)',
    category: '오픈마켓·종합몰', region: '국내', fee: '높음', feeText: '~4–10.8%',
    year: 2024, verified: true, isNew: false,
    desc: '로켓배송 기반 국내 최대 규모의 오픈마켓·종합 이커머스 판매채널.',
    settle: '주 / 월 선택', enter: '사업자등록 필수', strength: '국내 최대 트래픽·로켓배송',
    url: 'coupang.com', matchedDeals: 12, updatedAt: '2026-06',
    fees: [
      { cat: '가전·디지털', fee: '~5 – 8%', note: '카테고리 상세는 셀러센터 기준' },
      { cat: '패션·잡화', fee: '~10 – 10.8%', note: '국내 오픈마켓 상단 수준' },
      { cat: '식품·생필품', fee: '~4 – 6%', note: '신선식품 별도 정책' },
      { cat: '로켓배송(3PL)', fee: '별도 협의', note: '물류·보관비 포함 구조' },
    ],
    pros: ['국내 최대 트래픽·높은 구매 전환', '로켓배송 자체 물류 인프라 활용', '주정산 등 빠른 정산 옵션'],
    cons: ['카테고리별 높은 판매수수료', '치열한 가격 경쟁·노출 경쟁', '로켓배송 입점·품질 기준 엄격'],
  },
  {
    id: 'smartstore', name: '스마트스토어', initial: '스', grad: 'linear-gradient(135deg,#2CC08A,#0EA5A0)',
    category: '오픈마켓·종합몰', region: '국내', fee: '낮음', feeText: '~2–6%',
    year: 2019, verified: true, isNew: false,
    desc: '네이버 생태계 기반 개인·소상공인 중심의 무료 입점 판매채널.',
    settle: '영업일+1~2', enter: '사업자·간이 가능', strength: '무료 입점·네이버 유입',
  },
  {
    id: '11st', name: '11번가', initial: '1', grad: 'linear-gradient(135deg,#F2695F,#F5B544)',
    category: '오픈마켓·종합몰', region: '국내', fee: '중간', feeText: '~중간',
    year: 2018, verified: false, isNew: false,
    desc: '종합 오픈마켓. 여행·해외직구 카테고리 강세.',
    settle: '주 / 월', enter: '사업자등록', strength: '해외직구·여행 강세',
  },
  {
    id: 'wadiz', name: '와디즈', initial: '와', grad: 'linear-gradient(135deg,#38BDF8,#2445D4)',
    category: '크라우드펀딩', region: '국내', fee: '중간', feeText: '~5–9%',
    year: 2023, verified: true, isNew: false,
    desc: '리워드·투자형 크라우드펀딩으로 신제품을 검증하고 초기 수요를 모으는 채널.',
    settle: '펀딩 종료 후', enter: '프로젝트 심사', strength: '신제품 검증·선주문',
  },
  {
    id: 'tumblbug', name: '텀블벅', initial: '텀', grad: 'linear-gradient(135deg,#7C97FF,#3D63FF)',
    category: '크라우드펀딩', region: '국내', fee: '중간', feeText: '~중간',
    year: 2020, verified: false, isNew: false,
    desc: '창작·문화 프로젝트 중심 리워드 펀딩.',
    settle: '펀딩 종료 후', enter: '프로젝트 심사', strength: '창작·문화 커뮤니티',
  },
  {
    id: 'musinsa', name: '무신사', initial: '무', grad: 'linear-gradient(135deg,#7C97FF,#3D63FF)',
    category: '패션·편집샵', region: '국내', fee: '중간', feeText: '~중간',
    year: 2022, verified: true, isNew: false,
    desc: '국내 최대 온라인 패션 편집샵이자 브랜드 커머스 플랫폼.',
    settle: '월정산', enter: '브랜드 입점 심사', strength: '패션 집중 트래픽',
  },
  {
    id: '29cm', name: '29CM', initial: '2', grad: 'linear-gradient(135deg,#161E30,#38BDF8)',
    category: '패션·편집샵', region: '국내', fee: '중간', feeText: '~중간',
    year: 2021, verified: false, isNew: false,
    desc: '감도 높은 셀렉트샵형 패션·라이프스타일 커머스.',
    settle: '월정산', enter: '브랜드 입점 심사', strength: '큐레이션·감도',
  },
  {
    id: 'alibaba', name: '알리바바', initial: 'A', grad: 'linear-gradient(135deg,#F5B544,#F2695F)',
    category: '수출입·도매', region: '해외', fee: '낮음', feeText: '멤버십형',
    year: 2021, verified: false, isNew: false,
    desc: '글로벌 B2B 도매·소싱 마켓플레이스. 해외 제조사·공급사 직거래.',
    settle: '별도 협의', enter: '글로벌 인증', strength: '글로벌 B2B 소싱',
  },
  {
    id: 'ec21', name: 'EC21', initial: 'E', grad: 'linear-gradient(135deg,#38BDF8,#22D3B8)',
    category: '수출입·도매', region: '해외', fee: '낮음', feeText: '멤버십형',
    year: 2015, verified: false, isNew: false,
    desc: '국내 대표 수출 B2B 무역 플랫폼.',
    settle: '별도 협의', enter: '수출 인증', strength: '수출 바이어 네트워크',
  },
  {
    id: 'ium', name: '이음(I:UM)', initial: '이', grad: 'linear-gradient(135deg,#22D3B8,#0EA5A0)',
    category: '사무·MRO·B2B', region: '국내', fee: '낮음', feeText: '낮음',
    year: 2026, verified: true, isNew: true,
    desc: '지식산업센터 입주 중소기업을 잇는 하이퍼로컬 B2B 네트워킹 플랫폼.',
    settle: '별도 협의', enter: '지산 입주사', strength: '하이퍼로컬 B2B',
  },
  {
    id: 'kmong', name: '크몽', initial: '크', grad: 'linear-gradient(135deg,#F5B544,#2CC08A)',
    category: '프리랜서·전문가', region: '국내', fee: '중간', feeText: '~중간',
    year: 2017, verified: true, isNew: false,
    desc: '프리랜서 재능·전문 서비스 거래 마켓.',
    settle: '거래 완료 후', enter: '전문가 등록', strength: '전문 서비스 거래',
  },
  {
    id: 'soomgo', name: '숨고', initial: '숨', grad: 'linear-gradient(135deg,#3D63FF,#38BDF8)',
    category: '프리랜서·전문가', region: '국내', fee: '중간', feeText: '~중간',
    year: 2019, verified: false, isNew: false,
    desc: '고수 매칭 기반 홈·전문가 서비스 견적 플랫폼.',
    settle: '거래 완료 후', enter: '고수 등록', strength: '견적 매칭',
  },
];

// ── 접근자 (실제 API 연동 시 이 함수만 교체) ──────────────────
export async function fetchPlatforms() {
  return PLATFORMS;
}

export function getPlatform(id) {
  return PLATFORMS.find((p) => p.id === id) || null;
}

export function getPlatformsByCategory(category) {
  return PLATFORMS.filter((p) => p.category === category);
}
