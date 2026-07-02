// ============================================================
// 세모플 — 목(Mock) API 클라이언트
// ------------------------------------------------------------
// API Spec.md 의 엔드포인트를 실행 가능한 async 함수로 구현한 레이어입니다.
// 화면(DC)은 이 파일 하나만 import 하면 되고, 정식 백엔드 연동 시
// 각 함수 본문을 fetch 호출로 바꾸기만 하면 됩니다.
//
//   // 교체 예시:
//   export async function searchPlatforms(params) {
//     const qs = new URLSearchParams(params).toString();
//     return (await fetch('/api/v1/platforms?' + qs)).json();
//   }
//
// 지연(latency)을 흉내 내 로딩 상태까지 실제와 비슷하게 검증할 수 있습니다.
// ============================================================

import { PLATFORMS, FEE_META, CATEGORIES, REGIONS } from './platforms.js';

// 네트워크 지연 시뮬레이션 (ms)
const LATENCY = 120;
const delay = (v) => new Promise((res) => setTimeout(() => res(v), LATENCY));

// 데이터 원본 재노출 (기존 화면 호환)
export { PLATFORMS, FEE_META, CATEGORIES, REGIONS };
export async function fetchPlatforms() {
  return delay(PLATFORMS.slice());
}

// ── 실사용자 ────────────────────────────────────────────────
// GET /platforms
export async function searchPlatforms({ q = '', category = [], region = [], fee = [], status = [], sort = 'rel', page = 1, size = 100 } = {}) {
  const arr = (x) => (Array.isArray(x) ? x : x ? [x] : []);
  const cats = arr(category), regs = arr(region), fees = arr(fee), sts = arr(status);
  let items = PLATFORMS.filter((p) => {
    if (q && !(p.name.includes(q) || p.category.includes(q) || p.desc.includes(q))) return false;
    if (cats.length && !cats.includes(p.category)) return false;
    if (regs.length && !regs.includes(p.region)) return false;
    if (fees.length && !fees.includes(p.fee)) return false;
    if (sts.includes('new') && !p.isNew) return false;
    if (sts.includes('verified') && !p.verified) return false;
    return true;
  });
  if (sort === 'new') items = items.slice().sort((a, b) => b.year - a.year);
  else if (sort === 'name') items = items.slice().sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  const total = items.length;
  const start = (page - 1) * size;
  return delay({ page, size, total, items: items.slice(start, start + size) });
}

// GET /platforms/:id  (+ similar)
export async function getPlatform(id) {
  const p = PLATFORMS.find((x) => x.id === id);
  if (!p) return delay(null);
  const similar = PLATFORMS.filter((x) => x.category === p.category && x.id !== id).slice(0, 3);
  return delay({ ...p, similar });
}

// GET /categories  (대분류 집계)
export async function getCategories() {
  const groups = CATEGORIES.map((c) => ({
    category: c,
    count: PLATFORMS.filter((p) => p.category === c).length,
  }));
  return delay(groups);
}

// GET /stats
export async function getStats() {
  return delay({
    platforms: 1559,
    categories: 35,
    newThisMonth: 98,
    commerce: 620,
  });
}

// GET /groups  (홈 대분류 5)
export async function getGroups() {
  return delay([
    { icon:'🛒', name:'커머스·판매채널',     meta:'10 분야 · 620 플랫폼', cats:'오픈마켓 · 소셜 · 라이브 · 패션 · 식품 …' },
    { icon:'🚢', name:'해외·B2B·유통',       meta:'4 분야 · 210 플랫폼',  cats:'수출입 · 도매 · 물류 · 사무·MRO' },
    { icon:'🧑‍💼', name:'서비스·전문가·일자리', meta:'4 분야 · 180 플랫폼',  cats:'프리랜서 · 구인구직 · 홈서비스 · 법률세무' },
    { icon:'💳', name:'금융·핀테크·투자',     meta:'6 분야 · 240 플랫폼',  cats:'크라우드펀딩 · 결제 · 대출 · 자산관리' },
    { icon:'📈', name:'마케팅·데이터·솔루션',  meta:'5 분야 · 190 플랫폼',  cats:'광고 · CRM · 애널리틱스 · 자동화' },
  ]);
}

// GET /recommendations  (개인화 온보딩)
const GOAL_SERVES = {
  smartstore: ['fee', 'traffic'], coupang: ['traffic', 'settle'], wadiz: ['validate'],
  musinsa: ['traffic'], alibaba: ['global', 'fee'], kmong: ['settle'], ium: ['fee'],
};
export async function getRecommendations({ goals = [] } = {}) {
  const scored = PLATFORMS.map((p) => {
    const serves = GOAL_SERVES[p.id] || [];
    const matched = serves.filter((s) => goals.includes(s));
    return { platform: p, score: matched.length, reasons: matched };
  }).sort((a, b) => b.score - a.score);
  const top = (goals.length ? scored.filter((x) => x.score > 0) : scored).slice(0, 3);
  const items = (top.length ? top : scored.slice(0, 3)).map((x, i) => ({
    ...x.platform,
    matchScore: goals.length ? Math.min(98, 72 + x.score * 9 - i * 3) : 80 - i * 4,
    reasons: x.reasons,
  }));
  return delay({ items });
}

// ── 즐겨찾기 (in-memory) ────────────────────────────────────
let _favs = [
  { id: 'f1', platformId: 'coupang',    collection: 'review',   memo: '수수료 높지만 트래픽·전환 매력. 로켓배송 기준 확인 필요.', alert: true },
  { id: 'f2', platformId: 'smartstore', collection: 'plan',     memo: '무료 입점 먼저 테스트 → 반응 보고 확대.', alert: false },
  { id: 'f3', platformId: 'wadiz',      collection: 'interest', memo: '신제품 라인 펀딩으로 수요 검증 검토.', alert: true },
  { id: 'f4', platformId: 'musinsa',    collection: 'review',   memo: '', alert: false },
  { id: 'f5', platformId: 'ium',        collection: 'interest', memo: '지산 입주 조건 해당 여부 확인.', alert: false },
];
// 플랫폼 정보를 조인해 화면이 바로 쓸 수 있는 형태로 반환
export async function listFavorites(collection) {
  const joined = _favs.map((f) => {
    const p = PLATFORMS.find((x) => x.id === f.platformId) || {};
    return { id: f.platformId, favId: f.id, initial: p.initial, name: p.name, cat: p.category, fee: p.fee, grad: p.grad, collection: f.collection, memo: f.memo, alert: f.alert };
  });
  return delay(collection && collection !== 'all' ? joined.filter((f) => f.collection === collection) : joined);
}
export async function addFavorite(platformId, collection = 'interest') {
  const f = { id: 'f' + Date.now(), platformId, collection, memo: '', alert: false };
  _favs = [..._favs, f];
  return delay(f);
}
export async function updateFavorite(id, patch) {
  _favs = _favs.map((f) => (f.id === id ? { ...f, ...patch } : f));
  return delay(_favs.find((f) => f.id === id));
}
export async function removeFavorite(id) {
  _favs = _favs.filter((f) => f.id !== id);
  return delay({ ok: true });
}

// ── 관리자 ──────────────────────────────────────────────────
// 라이프사이클 상태머신 (허용 전이)
export const LIFECYCLE = {
  soon: { label: '준비중', allow: ['review', 'rejected'] },
  review: { label: '검증대기', allow: ['verified', 'soon', 'rejected'] },
  verified: { label: '검증됨', allow: ['matched', 'review'] },
  matched: { label: '성사', allow: ['verified'] },
  rejected: { label: '반려', allow: ['soon'] },
};
export async function canTransition(from, to) {
  return delay(!!(LIFECYCLE[from] && LIFECYCLE[from].allow.includes(to)));
}
// POST /admin/platforms/:id/transition  (허용 전이만 반영, 감사 로그 서버 기록)
export async function transitionPlatform(id, to) {
  return delay({ id, status: to, at: new Date().toISOString() });
}

// GET /admin/submissions
let _submissions = [
  { id:'ohouse', initial:'오', name:'오늘의집',   cat:'인테리어·리빙 커머스', region:'국내', fee:'중간', url:'ohou.se',        submitter:'user_2831', date:'07-01', desc:'인테리어 콘텐츠·커머스 결합. 가구·소품 판매채널로 성장 중.', dupSuspect:false, status:'pending', grad:'linear-gradient(135deg,#2CC08A,#0EA5A0)' },
  { id:'catch', initial:'캐', name:'캐치패션',   cat:'명품·패션 편집',       region:'국내', fee:'중간', url:'catchfashion.com', submitter:'user_5520', date:'07-01', desc:'글로벌 명품 병행수입 편집 커머스.', dupSuspect:true, dupName:'발란', status:'pending', grad:'linear-gradient(135deg,#7C97FF,#3D63FF)' },
  { id:'balaan', initial:'발', name:'발란',       cat:'명품 커머스',          region:'국내', fee:'중간', url:'balaan.co.kr',   submitter:'ops_intern', date:'06-30', desc:'명품 병행수입·플랫폼 커머스.', dupSuspect:false, status:'pending', grad:'linear-gradient(135deg,#161E30,#38BDF8)' },
  { id:'linkage', initial:'링', name:'링키지',     cat:'B2B 소싱·유통',        region:'국내', fee:'낮음', url:'linkage.io',     submitter:'user_1180', date:'06-30', desc:'제조사-바이어 B2B 소싱 매칭.', dupSuspect:false, status:'pending', grad:'linear-gradient(135deg,#22D3B8,#0EA5A0)' },
  { id:'idus', initial:'아', name:'아이디어스', cat:'수공예 마켓',          region:'국내', fee:'중간', url:'idus.com',       submitter:'user_9042', date:'06-29', desc:'핸드메이드·수공예 작가 마켓플레이스.', dupSuspect:false, status:'pending', grad:'linear-gradient(135deg,#F5B544,#F2695F)' },
];
export async function getSubmissions(status) {
  return delay(status && status !== 'all' ? _submissions.filter((s) => s.status === status) : _submissions.slice());
}
// PATCH /admin/submissions/:id  { action: approve|hold|reject, badge, lifecycle }
export async function updateSubmission(id, { action }) {
  const map = { approve: 'approved', hold: 'hold', reject: 'rejected' };
  _submissions = _submissions.map((s) => (s.id === id ? { ...s, status: map[action] || s.status } : s));
  return delay(_submissions.find((s) => s.id === id));
}

// ── 운영자 ──────────────────────────────────────────────────
export async function getMatches(type) {
  const all = [
    { id:'cj',    initial:'C', name:'CJ대한통운',   type:'물류·풀필먼트', typeKey:'logi',    score:92, grad:'linear-gradient(135deg,#3D63FF,#2445D4)', rationale:'풀필먼트 연계로 로켓배송 외 지역·물량 커버리지 확대.', reasons:['물류 보완','규모 유사'] },
    { id:'toss',  initial:'T', name:'토스페이먼츠', type:'결제·금융',     typeKey:'pay',     score:88, grad:'linear-gradient(135deg,#38BDF8,#2445D4)', rationale:'간편결제 연동으로 결제 전환율·재구매율 개선 기대.', reasons:['결제 연동','전환율'] },
    { id:'ohouse',initial:'오', name:'오늘의집',     type:'유통·소싱',     typeKey:'sourcing',score:79, grad:'linear-gradient(135deg,#2CC08A,#0EA5A0)', rationale:'리빙·인테리어 카테고리 보완. 상호 상품 소싱 가능.', reasons:['카테고리 보완'] },
    { id:'musinsa',initial:'무',name:'무신사',       type:'공동 마케팅',   typeKey:'mkt',     score:74, grad:'linear-gradient(135deg,#7C97FF,#3D63FF)', rationale:'패션 타깃 대상 공동 프로모션·크로스 노출.', reasons:['타깃 겹침','공동 캠페인'] },
    { id:'kurly', initial:'컬', name:'컬리',         type:'유통·소싱',     typeKey:'sourcing',score:71, grad:'linear-gradient(135deg,#22D3B8,#0EA5A0)', rationale:'신선식품 소싱 제휴로 식품 카테고리 강화.', reasons:['소싱 제휴'] },
    { id:'meta',  initial:'M', name:'메타 광고',    type:'공동 마케팅',   typeKey:'mkt',     score:68, grad:'linear-gradient(135deg,#F5B544,#F2695F)', rationale:'리타게팅 캠페인 공동 집행으로 CAC 절감.', reasons:['광고 협업'] },
  ];
  return delay(type && type !== 'all' ? all.filter((m) => m.typeKey === type) : all);
}
// GET /operator/proposals
export async function getProposals() {
  return delay({
    sent: [
      { initial:'롯', name:'롯데글로벌로지스', type:'물류·풀필먼트', status:'검토중', grad:'linear-gradient(135deg,#F2695F,#F5B544)' },
      { initial:'K', name:'KG이니시스',       type:'결제·금융',     status:'수락',   grad:'linear-gradient(135deg,#38BDF8,#22D3B8)' },
    ],
    received: [
      { initial:'발', name:'발란', type:'공동 마케팅', status:'신규', grad:'linear-gradient(135deg,#161E30,#38BDF8)' },
    ],
  });
}
export async function sendProposal(toPlatformId, type) {
  return delay({ id: 'p' + Date.now(), toPlatformId, type, status: '검토중', createdAt: new Date().toISOString() });
}
export async function getBoostTiers() {
  return delay([
    { id:'category',  name:'분야 상단 노출', desc:'자사 분야 검색결과 최상단 고정', price:3000,  ctr:0.032, impF:4,  previewTitle:'검색결과 · 오픈마켓·종합몰' },
    { id:'spotlight', name:'홈 스포트라이트', desc:'홈 신규·추천 영역 우선 노출',   price:8000,  ctr:0.024, impF:7,  previewTitle:'홈 · 신규·추천' },
    { id:'network',   name:'전 분야 네트워크', desc:'연관 분야 전반에 크로스 노출',   price:15000, ctr:0.018, impF:10, previewTitle:'네트워크 · 연관 분야' },
  ]);
}
// POST /boost/estimate
export async function estimateBoost({ tier, dailyBudget, days, addons = [] }) {
  const tiers = { category: { ctr: 0.032, impF: 4 }, spotlight: { ctr: 0.024, impF: 7 }, network: { ctr: 0.018, impF: 10 } };
  const addonPrice = { badge: 50000, ab: 20000, report: 10000 };
  const t = tiers[tier] || tiers.category;
  const media = dailyBudget * days;
  const addonCost = addons.reduce((s, a) => s + (addonPrice[a] || 0), 0);
  const estImpressions = dailyBudget * t.impF * days;
  return delay({
    estImpressions,
    estClicks: Math.round(estImpressions * t.ctr),
    total: media + addonCost,
  });
}
export async function getMetrics(platformId, range = '7d') {
  return delay({
    spark: [42, 55, 48, 63, 58, 71, 66],
    impressionsLabel: '12.4K',
    clicksLabel: '3.1K',
    favoritesLabel: '428',
  });
}

// ── 운영자 소유권 클레임 ─────────────────────────────────────
// POST /operator/claims  { platformId, method, email }
export async function submitClaim({ platformId, method, email }) {
  return delay({ id: 'claim_' + Date.now(), platformId, method, email, status: 'verifying' });
}
// POST /operator/claims/:id/verify  { code }
export async function verifyClaim(id, code) {
  return delay({ id, status: code && code.length >= 4 ? 'verified' : 'invalid' });
}

// ── 관리자 대시보드 ─────────────────────────────────────────
// GET /admin/dashboard
export async function getAdminDashboard() {
  return delay({
    kpis: [
      { n: '1,559', l: '총 플랫폼', color: '#7C97FF' },
      { n: '5', l: '검수 대기', color: '#F5B544' },
      { n: '23', l: '이번주 승인', color: '#2CC08A' },
      { n: '7', l: '데이터 이슈', color: '#F2695F' },
    ],
    quality: {
      duplicates: [
        { name: '캐치패션', hint: '발란과 유사', platformId: 'catch' },
        { name: '트렌비', hint: '발란·머스트잇과 유사', platformId: 'trenbe' },
      ],
      deadLinks: [
        { name: '고비즈코리아', hint: '404 · 3일 전 확인', platformId: 'gobiz' },
      ],
      stale: [
        { name: 'EC21', hint: '18개월 미갱신', platformId: 'ec21' },
        { name: '11번가', hint: '13개월 미갱신', platformId: '11st' },
      ],
    },
    popularSearches: [
      { q: '쿠팡', n: 1284, up: true },
      { q: '크라우드펀딩', n: 903, up: true },
      { q: '수출', n: 611, up: false },
      { q: '무신사', n: 542, up: true },
      { q: '스마트스토어', n: 498, up: false },
    ],
    activity: [
      { who: 'ops@semopl', what: '이음(I:UM) 승인·게시', when: '12분 전', dot: '#2CC08A' },
      { who: 'ops@semopl', what: '캐치패션 보류(중복 검토)', when: '34분 전', dot: '#F5B544' },
      { who: 'partner@coupang', what: '쿠팡 프로필 수정 요청', when: '1시간 전', dot: '#7C97FF' },
      { who: 'ops@semopl', what: '와디즈 성사 처리', when: '3시간 전', dot: '#2CC08A' },
    ],
  });
}
