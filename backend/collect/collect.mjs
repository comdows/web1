/* 신규 플랫폼·AI 도구 자동 수집기 — GitHub Actions 주간 실행(collect.yml).
 *
 * 흐름: 소스 수집(RSS/API) → 정규화 → 중복 제거(기존 등재 + 봇의 과거 제보) → 봇 계정으로
 * submissions에 후보 투입 → 관리 콘솔 "제보 검수 큐"에서 사람이 승인해야만 등재된다(자동 등재 없음).
 * 부가(G-C): 국내 뉴스 기사 제목이 "기존 등재 플랫폼"과 매칭되면 platform_news(0027)로 연결
 *   — 신규 후보 플로우와 독립이며, 실패해도 후보 투입 결과에 영향 없음.
 *
 * 필요 환경변수(GitHub Secrets):
 *   SUPABASE_URL, SUPABASE_ANON_KEY  — 공개 anon 키(서비스 키 아님)
 *   BOT_EMAIL, BOT_PASSWORD          — 사이트에서 가입한 봇 계정(일반 회원 — RLS로 본인 제보만 가능)
 *   ADMIN_BOT_EMAIL, ADMIN_BOT_PASSWORD (선택) — 소식(platform_news) 투입용 admin 봇(notify·digest와 동일 계정).
 *     미설정이면 소식 매핑만 건너뛴다(후보 수집은 정상 동작).
 *   PH_TOKEN (선택)          — Product Hunt API 토큰. 있으면 PH 소스가 GraphQL API로 제품 실사이트
 *     URL(website)을 받아 자동등재(directUrl) 자격을 얻는다. 없으면 기존 RSS 피드로 폴백(검수 큐 전용).
 *   ANTHROPIC_API_KEY (선택) — 있으면 후보 배치를 Claude Haiku로 분류·한국어 소개문 보강(enrich.mjs).
 *     없으면 기존 정규식 분류만 사용.
 *
 * 로컬 검증: node collect.mjs --dry [--fixture 디렉토리]
 *   --dry: 수집·중복제거까지만 하고 출력(DB 미접속·미투입·AI 보강 생략)
 *   --fixture: 네트워크 대신 저장된 응답 파일 사용(producthunt.xml, hn.json, platum.xml)
 */
import fs from "node:fs";
import path from "node:path";
import { enrich } from "./enrich.mjs";

const DRY = process.argv.includes("--dry");
const fixIdx = process.argv.indexOf("--fixture");
const FIXTURE_DIR = fixIdx > -1 ? process.argv[fixIdx + 1] : null;
const MAX_PER_RUN = 30; // 수집 상한(자동등재가 고신뢰분 흡수 + 일괄 승인으로 나머지 처리)
const BOT_PENDING_CAP = 10; // 봇 미처리 제보 RLS 상한(0028 my_pending_count<10)과 동일 — 검수 큐 투입은 이 한도 준수

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_ANON_KEY;
// 45개 분야 목록(정적 시드) — AI 보강(enrich)의 분류 화이트리스트로 사용
const CATEGORIES = JSON.parse(fs.readFileSync(
  path.join(path.dirname(new URL(import.meta.url).pathname), "../../app/src/data/platforms.json"), "utf8"
)).categories;

/* ── 소스 정의 ─────────────────────────────────────────────── */
// directUrl: 항목 url이 "그 제품의 실제 사이트"인 소스(HN·PH는 제품 링크). 국내 뉴스 RSS는 url이
//   "기사 주소"라 사람이 실 URL을 찾아야 함(directUrl=false) → 자동 등재(D) 대상에서 제외되고 검수/일괄승인(C)로 감.
// koLaunch: 국내 뉴스는 "출시/론칭" 기사만 후보로(일반 소식 제외).
// ph: Product Hunt API 토픽 슬러그 — PH_TOKEN이 있으면 GraphQL API로 제품 실사이트(website)를 받아
//   항목 단위 directUrl:true가 된다(자동등재 자격). 토큰이 없으면 url(RSS 피드)로 폴백(현행 동작).
const SOURCES = [
  {
    id: "producthunt",
    label: "Product Hunt (AI)",
    url: "https://www.producthunt.com/feed?category=artificial-intelligence",
    fixture: "producthunt.xml",
    fixtureApi: "producthunt-api.json",
    region: "overseas",
    parse: parseAtom,
    ph: "artificial-intelligence",
    directUrl: false, // 피드 링크는 PH 게시물 페이지(제품 사이트 아님) — API 경로는 항목별 override
  },
  {
    id: "hn",
    label: "Hacker News (Show HN)",
    url: "https://hn.algolia.com/api/v1/search_by_date?tags=show_hn&hitsPerPage=30&query=AI",
    fixture: "hn.json",
    region: "overseas",
    parse: parseHN,
    directUrl: true, // Show HN url은 제품 실사이트
  },
  {
    id: "hn-marketplace",
    label: "Hacker News (Show HN · Marketplace)",
    url: "https://hn.algolia.com/api/v1/search_by_date?tags=show_hn&hitsPerPage=20&query=marketplace",
    fixture: "hn-marketplace.json",
    region: "overseas",
    parse: parseHN,
    directUrl: true,
  },
  {
    id: "hn-saas",
    label: "Hacker News (Show HN · SaaS)",
    url: "https://hn.algolia.com/api/v1/search_by_date?tags=show_hn&hitsPerPage=20&query=SaaS",
    fixture: "hn-saas.json",
    region: "overseas",
    parse: parseHN,
    directUrl: true,
  },
  {
    id: "betalist",
    label: "BetaList (신규 스타트업)",
    url: "https://feeds.feedburner.com/BetaList", // betalist.com/feed는 404(run 29513012891) — 공식 피드버너로
    fixture: "betalist.xml",
    region: "overseas",
    parse: parseRss,
    directUrl: false, // 피드 링크는 betalist 게시물 페이지
  },
  {
    id: "platum",
    label: "플래텀 (국내 스타트업)",
    url: "https://platum.kr/feed",
    fixture: "platum.xml",
    region: "domestic",
    parse: parseRss,
    koLaunch: true,
    directUrl: false,
  },
  {
    id: "venturesquare",
    label: "벤처스퀘어 (국내 스타트업)",
    url: "https://www.venturesquare.net/feed",
    fixture: "venturesquare.xml",
    region: "domestic",
    parse: parseRss,
    koLaunch: true,
    directUrl: false,
  },
  {
    id: "startuprecipe",
    label: "스타트업레시피 (국내 스타트업)",
    url: "https://startuprecipe.co.kr/feed",
    fixture: "startuprecipe.xml",
    region: "domestic",
    parse: parseRss,
    koLaunch: true,
    directUrl: false,
  },
  // ── 국내 매체 확대(커머스·서비스·핀테크 발굴) — 기사 URL이라 directUrl:false·koLaunch ──
  {
    id: "outstanding",
    label: "아웃스탠딩 (국내 IT/스타트업)",
    url: "https://outstanding.kr/feed",
    fixture: "outstanding.xml",
    region: "domestic",
    parse: parseRss,
    koLaunch: true,
    directUrl: false,
  },
  {
    id: "yozm",
    label: "요즘IT (국내 IT 제품)",
    url: "https://yozm.wishket.com/magazine/feed/",
    fixture: "yozm.xml",
    region: "domestic",
    parse: parseRss,
    koLaunch: true,
    directUrl: false,
  },
  {
    id: "byline",
    label: "바이라인네트워크 (국내 IT)",
    url: "https://byline.network/feed/",
    fixture: "byline.xml",
    region: "domestic",
    parse: parseRss,
    koLaunch: true,
    directUrl: false,
  },
  // ── 국내 제품 커뮤니티 — 언론을 거치지 않는 메이커 런칭 포착 ──
  {
    id: "geeknews",
    label: "GeekNews (국내 기술 커뮤니티)",
    url: "https://news.hada.io/rss/news",
    fixture: "geeknews.xml",
    region: "domestic",
    parse: parseRss,
    koLaunch: true, // 출시·공개성 항목만(비제품 뉴스는 AI 보강 is_platform 판정·검수에서 걸러짐)
    directUrl: false, // 링크가 토픽 페이지
  },
  // (디스콰이엇은 공개 RSS 부재 확인 — run 29513012891에서 404 → 제거. API 공개 시 재추가 검토)
  // ── 국내 비언론 보강: 구글뉴스 검색 RSS — 특정 매체에 안 실린 출시 소식도 포착(기사 URL이라 directUrl:false) ──
  {
    id: "gnews-service",
    label: "구글뉴스 검색 (서비스 출시)",
    url: "https://news.google.com/rss/search?q=%22%EC%84%9C%EB%B9%84%EC%8A%A4%20%EC%B6%9C%EC%8B%9C%22%20%EC%8A%A4%ED%83%80%ED%8A%B8%EC%97%85&hl=ko&gl=KR&ceid=KR:ko",
    fixture: "gnews-service.xml",
    region: "domestic",
    parse: parseRss,
    koLaunch: true,
    directUrl: false,
  },
  {
    id: "gnews-platform",
    label: "구글뉴스 검색 (플랫폼 출시)",
    url: "https://news.google.com/rss/search?q=%22%ED%94%8C%EB%9E%AB%ED%8F%BC%20%EC%B6%9C%EC%8B%9C%22&hl=ko&gl=KR&ceid=KR:ko",
    fixture: "gnews-platform.xml",
    region: "domestic",
    parse: parseRss,
    koLaunch: true,
    directUrl: false,
  },
  {
    id: "gnews-app",
    label: "구글뉴스 검색 (앱 출시)",
    url: "https://news.google.com/rss/search?q=%22%EC%95%B1%20%EC%B6%9C%EC%8B%9C%22%20%EC%8A%A4%ED%83%80%ED%8A%B8%EC%97%85&hl=ko&gl=KR&ceid=KR:ko",
    fixture: "gnews-app.xml",
    region: "domestic",
    parse: parseRss,
    koLaunch: true,
    directUrl: false,
  },
  // ── 글로벌 제품 디렉토리 확대(AI 외 커머스·핀테크·생산성) — PH 링크는 게시물 페이지라 directUrl:false,
  //    PH_TOKEN 있으면 API로 실사이트 획득 ──
  {
    id: "ph-ecommerce",
    label: "Product Hunt (E-commerce)",
    url: "https://www.producthunt.com/feed?category=e-commerce",
    fixture: "producthunt-ecommerce.xml",
    region: "overseas",
    parse: parseAtom,
    ph: "e-commerce",
    directUrl: false,
    catHint: "openmarket",
  },
  {
    id: "ph-fintech",
    label: "Product Hunt (Fintech)",
    url: "https://www.producthunt.com/feed?category=fintech",
    fixture: "producthunt-fintech.xml",
    region: "overseas",
    parse: parseAtom,
    ph: "fintech",
    directUrl: false,
    catHint: "finance",
  },
  {
    id: "ph-devtools",
    label: "Product Hunt (Developer Tools)",
    url: "https://www.producthunt.com/feed?category=developer-tools",
    fixture: "producthunt-devtools.xml",
    region: "overseas",
    parse: parseAtom,
    ph: "developer-tools",
    directUrl: false,
    catHint: "ai_code",
  },
  {
    id: "ph-marketing",
    label: "Product Hunt (Marketing)",
    url: "https://www.producthunt.com/feed?category=marketing",
    fixture: "producthunt-marketing.xml",
    region: "overseas",
    parse: parseAtom,
    ph: "marketing",
    directUrl: false,
    catHint: "ai_marketing",
  },
  {
    id: "ph-productivity",
    label: "Product Hunt (Productivity)",
    url: "https://www.producthunt.com/feed?category=productivity",
    fixture: "producthunt-productivity.xml",
    region: "overseas",
    parse: parseAtom,
    ph: "productivity",
    directUrl: false,
    catHint: "ai_auto",
  },
];

/* ── 파서(외부 의존성 없이 단순 정규식 — 실패 항목은 건너뜀) ── */
function decode(s) {
  return (s || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
    .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
function blocks(xml, tag) {
  return [...xml.matchAll(new RegExp(`<${tag}[\\s\\S]*?</${tag}>`, "g"))].map((m) => m[0]);
}
function field(block, tag) {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  return m ? m[1] : "";
}

function parseAtom(xml) {
  return blocks(xml, "entry").map((e) => {
    const linkM = e.match(/<link[^>]*href="([^"]+)"/);
    return { name: decode(field(e, "title")), url: linkM ? decode(linkM[1]) : "", desc: decode(field(e, "content")).slice(0, 160) };
  });
}
function parseRss(xml) {
  return blocks(xml, "item").map((e) => ({
    name: decode(field(e, "title")), url: decode(field(e, "link")), desc: decode(field(e, "description")).slice(0, 160),
    pub: decode(field(e, "pubDate")),
  }));
}
function parseHN(json) {
  const d = typeof json === "string" ? JSON.parse(json) : json;
  return (d.hits || []).filter((h) => h.url).map((h) => {
    // "Show HN: 이름 – 설명" → 이름/설명 분리(설명은 분류·신뢰도에 활용). 구분자 없으면 전체가 이름.
    const full = decode(h.title).replace(/^Show HN:\s*/i, "");
    const m = full.match(/^(.+?)\s*(?:[—–|]|\s-|:)\s+(.+)$/);
    return m ? { name: m[1], url: h.url, desc: m[2].slice(0, 160) } : { name: full, url: h.url, desc: "" };
  });
}
/* PH GraphQL API 응답 → 항목. 실측(run 29513012891): website 필드가 PH 상품페이지를 돌려주는 경우가
 * 많아 productLinks에서 비-PH 링크를 우선 채택하고, PH 링크(/r/ 리다이렉트 포함)면 리다이렉트를
 * 1회 해석해 실사이트를 얻는다. 끝내 PH 호스트면 비직접(검수 큐 전용)으로 강등. */
function pickPHUrl(node) {
  const links = (node.productLinks ?? []).map((l) => l?.url).filter(Boolean);
  const nonPH = links.find((u) => !/producthunt\.com/i.test(u));
  if (nonPH) return { url: nonPH, direct: true };
  const site = node.website || "";
  if (site && !/producthunt\.com/i.test(site)) return { url: site, direct: true };
  const redirect = [site, ...links].find((u) => u && /producthunt\.com\/r\//i.test(u));
  if (redirect) return { url: redirect, direct: false, resolve: true }; // 리다이렉트 해석 대상
  return { url: node.url || site, direct: false };
}
function parsePHApi(json) {
  const d = typeof json === "string" ? JSON.parse(json) : json;
  return (d.data?.posts?.edges ?? []).map(({ node }) => {
    const pick = pickPHUrl(node);
    return {
      name: decode(node.name || ""),
      url: pick.url,
      desc: decode(node.tagline || "").slice(0, 160),
      _direct: pick.direct,
      _resolve: !!pick.resolve,
    };
  }).filter((it) => it.name && it.url);
}
/* PH /r/ 리다이렉트 → 실사이트 해석(항목당 1회·실패는 비직접 유지).
 * 실측(run 29514189332): PH가 HEAD를 거부해 해석이 전부 실패 → GET으로 요청(응답 본문은 읽지 않음 —
 * fetch는 헤더 수신 시점에 resolve되고 res.url이 최종 리다이렉트 목적지). */
async function resolvePHRedirects(items) {
  for (const it of items) {
    if (!it._resolve) continue;
    try {
      const res = await fetch(it.url, {
        redirect: "follow",
        signal: AbortSignal.timeout(8000),
        headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36" },
      });
      const finalUrl = res.url || "";
      res.body?.cancel?.().catch?.(() => {});   // 본문 미사용 — 스트림 정리
      if (finalUrl && !/producthunt\.com/i.test(finalUrl)) { it.url = finalUrl.replace(/[?#].*$/, ""); it._direct = true; }
    } catch { /* 해석 실패 — PH 링크 그대로(비직접) */ }
  }
  return items;
}
async function fetchPH(src) {
  const res = await fetch("https://api.producthunt.com/v2/api/graphql", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.PH_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      query: "query($topic:String!){posts(first:20,order:NEWEST,topic:$topic){edges{node{name tagline website url productLinks{type url}}}}}",
      variables: { topic: src.ph },
    }),
  });
  if (!res.ok) throw new Error(`PH API HTTP ${res.status}`);
  return resolvePHRedirects(parsePHApi(await res.text()));
}

/* 제목·설명 키워드 → 분야 추정(검수 셀렉트 초기값 제안 — 오분류여도 관리자가 교정).
 * 45개 분야 전체. 첫 매치 우선이므로 "구체적 버티컬 → AI → 커머스 일반" 순서로 배치해
 * 광범위 키워드(마켓·플랫폼)가 버티컬을 삼키지 않게 한다. 키워드는 보수적으로(오탐 최소) —
 * 미매치 시 소스 catHint가 폴백(단, 자동등재 +20 가점은 여기 키워드 매치에만 부여 → hint만으론 자동등재 불가).*/
const CAT_RULES = [
  // ── life(생활·여가·예약) — 버티컬이 뚜렷해 먼저 ──
  [/반려동물|반려견|반려묘|펫\b|강아지|고양이|\bpet\b/i, "pet"],
  [/웨딩|결혼|예식|신혼|\bwedding\b/i, "wedding"],
  [/육아|키즈|유아|아기|영유아|\bkids?\b|\bbaby\b/i, "kids"],
  [/중고차|자동차|정비|카센터|\bauto(motive)?\b|\bcar\b/i, "auto"],
  [/부동산|상업공간|점포|매물|임대|\breal\s?estate\b|\bproperty\b/i, "realestate"],
  [/피트니스|헬스장|요가|필라테스|스포츠|운동|\bfitness\b|\bgym\b/i, "fitness"],
  [/티켓|공연|예매|콘서트|뮤지컬|\bticket\b/i, "ticket"],
  [/웨딩촬영|스냅|사진 촬영|영상 촬영|초대장|\bphoto(graphy)?\b/i, "photo"],
  [/케이터링|플라워|꽃집|행사 대행|파티 대행|\bcatering\b/i, "event"],
  [/미용실|헤어|피부과|성형|병원 예약|헬스케어 예약|\bclinic\b|\bsalon\b/i, "beautyhealth"],
  [/숙박|공간대여|파티룸|스터디룸|게스트하우스|투어 예약|\bbooking\b(?!.*flight)/i, "space"],
  [/렌탈|대여|정기 렌탈|\brental\b/i, "rental"],
  // ── service(서비스·전문가·일자리) ──
  [/프리랜서|재능마켓|재능|외주|\bfreelance\b|\bgig\b/i, "freelance"],
  [/구인구직|채용|일자리|긴급 인력|긱워크|\brecruit(ing)?\b|\bjobs?\b/i, "jobs"],
  [/법률|세무|변호사|세무사|노무사|법무|\blegal\b|\btax\b/i, "legaltax"],
  [/홈서비스|이사|청소|집수리|인테리어 시공|생활 o2o/i, "homeservice"],
  // ── money(자금·콘텐츠·창작) ──
  [/크라우드펀딩|펀딩|후원|\bcrowdfund/i, "funding"],
  [/인쇄|굿즈 제작|굿즈|\bprint(ing|-on-demand)?\b|\bpod\b/i, "print"],
  [/대출|보험|금융 비교|카드 비교|\bfintech\b|\bloan\b|\binsurance\b/i, "finance"],
  [/창작자 수익|크리에이터|팬 후원|뉴스레터|멤버십 콘텐츠|\bcreator\b/i, "content"],
  [/스톡|폰트|템플릿 판매|디지털 에셋|\bstock\b(?!.*market)|디자인 소스/i, "assets"],
  // ── trade(해외·B2B·유통) ──
  [/물류|풀필먼트|배송대행|3pl|\bfulfillment\b|\blogistics\b/i, "fulfillment"],
  [/수출|수입|역직구|해외 판매|크로스보더|\bcross-?border\b|\bexport\b|\bimport\b/i, "global"],
  [/도매|소싱|사입|\bwholesale\b|\bsourcing\b/i, "wholesale"],
  [/\bmro\b|산업재|사무용품|기업 구매|\boffice supply\b|b2b 구매/i, "office"],
  // ── ai(AI 도구) — 키워드가 뚜렷 ──
  [/video|영상|film|clip/i, "ai_video"], [/image|이미지|일러스트|logo|로고/i, "ai_image"],
  [/\bvoice|\baudio|music|음성|음악|\btts\b|speech/i, "ai_audio"], [/coding|developer|개발자|ide|copilot/i, "ai_code"],
  [/meeting|회의록|transcri|녹취/i, "ai_meeting"], [/마케팅 ai|seo ai|광고 ai|챗봇|customer support ai/i, "ai_marketing"],
  [/\bagent\b|automat|workflow|자동화 ai/i, "ai_auto"], [/리서치 ai|번역 ai|translat|논문|paper/i, "ai_research"],
  [/글쓰기 ai|copywrit|문서 작성 ai/i, "ai_writing"], [/\bai\b|gpt|llm|generative|생성형/i, "ai_chat"],
  // ── commerce(커머스·판매채널) — 일반 키워드라 마지막 ──
  [/홈쇼핑|t커머스|티커머스/i, "homeshopping"],
  [/라이브커머스|라이브 쇼핑|라방|\blive commerce\b/i, "live"],
  [/공동구매|공구|소셜커머스|특가딜/i, "social"],
  [/배달|음식 주문|퀵커머스|주문중개/i, "delivery"],
  [/중고거래|리커머스|리셀|\bresale\b|\bused\b/i, "resale"],
  [/핸드메이드|수공예|작가마켓|\bhandmade\b|\bcraft\b/i, "handmade"],
  [/식품|신선|밀키트|정기배송|\bgrocery\b|\bfresh\b/i, "food"],
  [/패션|의류|뷰티 커머스|\bfashion\b|\bapparel\b/i, "fashion"],
  [/자사몰|쇼핑몰 구축|쇼핑몰 솔루션|쇼핑몰 제작|스토어 구축|\bstorefront\b/i, "mallbuilder"],
  [/오픈마켓|종합몰|마켓플레이스|셀러|입점|\becommerce\b|\bmarketplace\b/i, "openmarket"],
];
function guessCategory(name, desc) {
  const hay = `${name} ${desc}`;
  for (const [re, cat] of CAT_RULES) if (re.test(hay)) return cat;
  return "";
}

/* ── 정규화·필터 ───────────────────────────────────────────── */
const KO_LAUNCH = /(출시|론칭|런칭|오픈|선보|공개)/;           // 국내 뉴스: 출시 소식만 후보로
const NAME_CUT = /\s*(?:[—–|]|\s-|:)\s+.*$/;                  // "이름 - 부제" / "이름: 부제" → 이름
// 뉴스·집계 호스트(기사 URL) — 자동 등재 신뢰도에서 감점(제품 실사이트가 아님)
const AGGREGATOR_HOSTS = /(platum\.kr|venturesquare\.net|startuprecipe\.co\.kr|producthunt\.com|news|blog|medium\.com|tistory\.com|naver\.com|brunch\.co\.kr)/i;

/* 호스트 정규화: www./m./mobile. 등 흔한 서브도메인 접두사를 벗겨 동일 사이트를 한 키로 모은다(B). */
function host(u) {
  try {
    let h = new URL(u).hostname.toLowerCase();
    let prev;
    do { prev = h; h = h.replace(/^(www|m|mobile|ko|kr|en|app)\./, ""); } while (h !== prev);
    return h;
  } catch { return ""; }
}
/* 이름 정규화 키: 소문자·공백·구두점·법인 접미(주식회사·㈜·inc·corp) 제거 → 띄어쓰기/대소문자/표기 차이 흡수(B). */
function nameKey(s) {
  return (s || "").toLowerCase()
    .replace(/주식회사|㈜|\(주\)|\binc\b|\bcorp\b|\bltd\b|\bco\b/g, "")
    .replace(/[\s\-_·.,'"()[\]|/™®©]+/g, "")
    .trim();
}
/* 레벤슈타인 거리 — 오탈자 1글자 차이까지 근접 중복으로 잡기 위한 경량 구현(B). */
function lev(a, b) {
  if (a === b) return 0;
  if (!a.length || !b.length) return Math.max(a.length, b.length);
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]; dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const t = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = t;
    }
  }
  return dp[b.length];
}
/* 정규화 키 집합(knownKeys)에 대해 근접(거리≤1) 이름이 있으면 true — 짧은 이름은 오탐 방지로 정확 일치만. */
function fuzzyNameHit(name, knownKeys) {
  const k = nameKey(name);
  if (!k) return false;
  if (knownKeys.has(k)) return true;
  if (k.length < 5) return false;               // 짧은 이름은 1글자 차이 오탐이 커 제외
  for (const kk of knownKeys) {
    if (Math.abs(kk.length - k.length) > 1) continue;
    if (lev(k, kk) <= 1) return true;
  }
  return false;
}

function normalize(items, src) {
  return items
    .map((it) => ({ ...it, name: it.name.replace(NAME_CUT, "").slice(0, 60).trim() }))
    .filter((it) => it.name && it.url && host(it.url))
    .filter((it) => !src.koLaunch || KO_LAUNCH.test(it.name + it.desc))
    .map((it) => ({
      name: it.name, url: it.url, desc: it.desc,
      region: src.region, source: src.id, sourceLabel: src.label,
      directUrl: !!(it._direct ?? src.directUrl), catHint: src.catHint || "", // _direct: PH API 항목별 override
    }));
}

/* ── 자동 등재 신뢰도 점수(D, 0~100) ──────────────────────────
 * "url이 제품 실사이트인가"가 핵심 안전 신호 — directUrl이 아니면 최대치가 임계 아래로 묶여
 * 절대 자동 등재되지 않는다(국내 뉴스는 기사 URL이라 사람이 실 URL 확인 필요 → 검수/일괄승인으로).*/
function confidence(c) {
  let score = 30;
  if (c.directUrl) score += 25;
  // 키워드 분야 매치 또는 AI 분류(화이트리스트 검증 통과분) — catHint 제외(자동등재 안전장치)
  if (guessCategory(c.name, c.desc) || c.aiCat) score += 20;
  if ((c.desc || "").trim().length >= 20) score += 10;
  const n = c.name.trim();
  if (n.length >= 2 && n.length <= 40 && !/^[A-Z ]+$/.test(n)) score += 10;
  if (AGGREGATOR_HOSTS.test(host(c.url))) score -= 25;
  score = Math.max(0, Math.min(100, score));
  // 비직접 URL(기사·게시물 링크)은 실사이트가 아니라 자동등재 임계(min_confidence≥80) 아래로 고정.
  // 단 분야·설명 가점은 반영돼 검수 트리아지·일괄 선택에 쓸모 있는 점수(≤55)를 준다.
  if (!c.directUrl) score = Math.min(score, 55);
  return score;
}

/* ── 수집 ─────────────────────────────────────────────────── */
/* 개별 소스 실패는 흡수하되(일시 장애·포맷 변경 가능성), 전 소스 동시 실패는
 * 수집기 자체의 고장(네트워크·차단·파서 붕괴)이므로 런을 실패시켜 알림을 받는다 — 조용한 수집 정체 방지 */
let sourceFails = 0;
const failedSources = []; // 부분 실패 알림용(3개 이상이면 ops-alert 이슈 — collect.yml)
/* 국내 뉴스 원문 항목(제목 전체 보존 — NAME_CUT 미적용). 기존 플랫폼 소식 매핑(G-C)용. */
const newsRaw = [];
function takeItems(items, src) {
  if (src.region === "domestic") {
    for (const it of items) {
      if (it.name && it.url) newsRaw.push({ title: it.name.trim(), url: it.url, pub: it.pub || "", sourceLabel: src.label });
    }
  }
  return normalize(items, src);
}
async function fetchSource(src) {
  if (FIXTURE_DIR) {
    // PH API 픽스처가 있으면 API 경로 파서 검증(항목별 directUrl override 포함), 없으면 RSS 픽스처
    if (src.fixtureApi && fs.existsSync(path.join(FIXTURE_DIR, src.fixtureApi))) {
      return takeItems(parsePHApi(fs.readFileSync(path.join(FIXTURE_DIR, src.fixtureApi), "utf8")), src);
    }
    const p = path.join(FIXTURE_DIR, src.fixture);
    if (!fs.existsSync(p)) return [];
    return takeItems(src.parse(fs.readFileSync(p, "utf8")), src);
  }
  try {
    // PH 토픽 소스: 토큰이 있으면 API(제품 실사이트 URL → 자동등재 자격), 없으면 RSS 폴백
    if (src.ph && process.env.PH_TOKEN) return takeItems(await fetchPH(src), src);
    let res = await fetch(src.url, { headers: { "User-Agent": `semopl-collector/1.0 (+${process.env.SITE_URL ?? "https://comdows.github.io/web1"}/)` } });
    if (res.status === 403 || res.status === 405) {
      // 일부 피드(요즘IT 405 등)가 비브라우저 UA를 차단 — 브라우저 헤더로 1회 재시도
      // (compatible; RSSReader/1.0 재시도는 여전히 405 — run 29514189332)
      res = await fetch(src.url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
          Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
          "Accept-Language": "ko,en;q=0.8",
        },
      });
    }
    if (!res.ok) { console.warn(`[skip] ${src.id}: HTTP ${res.status}`); sourceFails++; failedSources.push(src.id); return []; }
    return takeItems(src.parse(await res.text()), src);
  } catch (e) {
    console.warn(`[skip] ${src.id}: ${e.message}`);
    sourceFails++;
    failedSources.push(src.id);
    return [];
  }
}

/* ── 소식 매핑(G-C): 기사 제목에 기존 플랫폼명이 등장하면 그 플랫폼의 소식으로 연결 ──
 * 부분 문자열 오탐 방지: 이름 앞은 한글·영숫자 불가(예: "원데이클래스"의 "클래스" 차단),
 * 2자 한글 이름(쿠팡·옥션·토스…)은 뒤가 비한글이거나 흔한 조사일 때만("토스트" 차단, "쿠팡이" 허용).
 * 영문 전용 이름은 4자 미만 제외("AI" 등). 최장 이름 매치 우선. */
const NEWS_MAX_PER_RUN = 30; // 공개 노출 콘텐츠 상한(오탐 시 관리 콘솔·SQL로 삭제 가능한 규모 유지)
const AFTER_PARTICLE = /^[이가은는을를과와의도만에서로측]/; // 2자 이름 직후 허용 조사(대표형)
function nameInTitle(t, n) {
  let i = t.indexOf(n);
  while (i !== -1) {
    const before = i === 0 ? "" : t[i - 1];
    const after = t.slice(i + n.length, i + n.length + 1);
    const beforeOk = !before || !/[가-힣a-z0-9]/i.test(before);
    const afterOk = n.length >= 3 || !after || !/[가-힣]/.test(after) || AFTER_PARTICLE.test(after);
    if (beforeOk && afterOk) return true;
    i = t.indexOf(n, i + 1);
  }
  return false;
}
function matchNewsPlatform(title, plats) {
  const t = (title || "").toLowerCase();
  let best = null;
  for (const p of plats) {
    const n = (p.name || "").toLowerCase().trim();
    if (n.length < 2 || (/^[\x20-\x7e]+$/.test(n) && n.length < 4)) continue;
    if (nameInTitle(t, n) && (!best || n.length > best.n.length)) best = { p, n };
  }
  return best?.p ?? null;
}
function buildNewsRows(raw, plats) {
  const seenUrl = new Set();
  const rows = [];
  for (const it of raw) {
    if (rows.length >= NEWS_MAX_PER_RUN) break;
    if (it.title.length < 4 || seenUrl.has(it.url)) continue;
    const p = matchNewsPlatform(it.title, plats);
    if (!p) continue;
    seenUrl.add(it.url);
    const d = new Date(it.pub);
    rows.push({
      platform_id: p.id, title: it.title.slice(0, 300), url: it.url,
      source: it.sourceLabel, published_at: isNaN(d.getTime()) ? null : d.toISOString(),
    });
  }
  return rows;
}
/* platform_news insert는 RLS가 admin 전용(0027) — notify·digest와 동일한 admin 봇으로 별도 로그인.
 * 실패는 경고만(후보 수집 결과를 깨지 않음). */
async function pushNews(rows) {
  if (!process.env.ADMIN_BOT_EMAIL || !process.env.ADMIN_BOT_PASSWORD) {
    console.log("소식 매핑: ADMIN_BOT_EMAIL 미설정 — 투입 생략(collect.yml secrets에 추가하면 활성화)");
    return 0;
  }
  try {
    const res = await fetch(`${SB_URL}/auth/v1/token?grant_type=password`, {
      method: "POST", headers: { apikey: SB_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ email: process.env.ADMIN_BOT_EMAIL, password: process.env.ADMIN_BOT_PASSWORD }),
    });
    if (!res.ok) throw new Error(`admin 봇 로그인 실패: ${res.status}`);
    const adminToken = (await res.json()).access_token;
    await rest("platform_news?on_conflict=url", {
      method: "POST", headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
      body: JSON.stringify(rows),
    }, adminToken);
    return rows.length;
  } catch (e) {
    console.warn(`소식 투입 실패(후보 수집과 무관·무시): ${e.message}`);
    return 0;
  }
}

/* ── Supabase ─────────────────────────────────────────────── */
async function rest(pathQ, init = {}, token) {
  const res = await fetch(`${SB_URL}/rest/v1/${pathQ}`, {
    ...init,
    headers: { apikey: SB_KEY, Authorization: `Bearer ${token ?? SB_KEY}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  if (!res.ok) throw new Error(`${res.status} ${pathQ.split("?")[0]}: ${await res.text()}`);
  const t = await res.text();
  return t ? JSON.parse(t) : undefined;
}
async function botLogin() {
  const res = await fetch(`${SB_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: SB_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email: process.env.BOT_EMAIL, password: process.env.BOT_PASSWORD }),
  });
  if (!res.ok) throw new Error(`봇 로그인 실패: ${res.status} ${await res.text()}`);
  const d = await res.json();
  return { token: d.access_token, uid: d.user.id };
}

/* ── 메인 ─────────────────────────────────────────────────── */
const collected = (await Promise.all(SOURCES.map(fetchSource))).flat();
console.log(`수집 ${collected.length}건 (${SOURCES.map((s) => s.id).join(", ")})`);
if (!FIXTURE_DIR && sourceFails >= SOURCES.length) throw new Error(`전 소스(${SOURCES.length}개) 수집 실패 — 수집기 점검 필요`);
// 부분 실패(3개 이상): 런은 성공시키되 collect.yml이 ops-alert 이슈를 만들도록 output 전달 — 조용한 수집량 감소 방지
if (!FIXTURE_DIR && sourceFails >= 3 && process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `srcfails=${sourceFails}\nsrcfailed=${failedSources.join(" ")}\n`);
}

// dedup 키: 제품 실사이트(directUrl)는 호스트로, 집계/기사 링크(비directUrl — PH 게시물·뉴스 기사는
// 모두 같은 호스트라 호스트로 묶으면 소스당 1건으로 붕괴)는 전체 URL로 구분한다.
const dedupKey = (c) => (c.directUrl ? host(c.url) : (c.url || "").replace(/[?#].*$/, "").replace(/\/+$/, ""));

// 1차: 수집분 내부 dedup
const seen = new Set();
let candidates = collected.filter((c) => { const k = dedupKey(c); if (!k || seen.has(k)) return false; seen.add(k); return true; });

if (DRY && !SB_URL) {
  console.log(`\n[dry] DB 미접속 — 후보 ${candidates.length}건 · 뉴스 원문 ${newsRaw.length}건(플랫폼 매칭은 DB 필요):`);
  for (const c of candidates.slice(0, 40)) {
    const sc = confidence(c), cat = guessCategory(c.name, c.desc) || c.catHint || "";
    const auto = c.directUrl && cat && sc >= 80 ? "★자동" : "검수";
    console.log(`  - [${c.source}] (${sc} ${auto} ${cat || "미분류"}) ${c.name} | ${c.url}`);
  }
  process.exit(0);
}

// 2차: 기존 등재 플랫폼 + 봇의 과거 제보와 dedup.
//  · knownHosts: 등재 플랫폼의 실사이트 호스트(directUrl 후보의 호스트 중복 차단용).
//  · knownUrls: 봇 과거 제보의 전체 URL(같은 기사·게시물 재투입 방지). 집계 호스트를 knownHosts에
//    넣으면(예전 버그) 그 소스의 모든 후보가 영구 차단되므로 넣지 않는다.
//  · knownKeys: 이름 정규화 키(퍼지 매칭) — 등재 + 과거 제보 양쪽.
const platforms = await rest("platforms?select=id,url,name");
const knownHosts = new Set(platforms.map((p) => host(p.url)).filter(Boolean));
const knownKeys = new Set(platforms.map((p) => nameKey(p.name)).filter(Boolean));
const knownUrls = new Set();

const { token, uid } = DRY ? { token: null, uid: null } : await botLogin();
const mySubs = token ? await rest("submissions?select=payload&limit=1000", {}, token) : [];
for (const s of mySubs) {
  const u = (s.payload?.url ?? "").replace(/[?#].*$/, "").replace(/\/+$/, ""); if (u) knownUrls.add(u);
  const k = nameKey(s.payload?.name ?? ""); if (k) knownKeys.add(k);
}

candidates = candidates
  .filter((c) => {
    if (fuzzyNameHit(c.name, knownKeys)) return false;                 // 이름 중복(등재·과거 제보)
    if (knownUrls.has(dedupKey(c))) return false;                      // 같은 기사·게시물 재투입 방지
    if (c.directUrl && knownHosts.has(host(c.url))) return false;      // 제품 실사이트 호스트 중복
    return true;
  })
  .slice(0, MAX_PER_RUN);

// AI 보강(선택): ANTHROPIC_API_KEY가 있으면 배치로 분류·한국어 소개문·"제품 여부" 판정(enrich.mjs).
// 키 부재·실패 시 null → 아래 매핑이 정규식 분류만으로 동작(현행 보존). DRY에서는 비용 방지로 생략.
let aiMap = null;
if (!DRY && candidates.length && process.env.ANTHROPIC_API_KEY) {
  try {
    aiMap = await enrich(candidates, CATEGORIES);
    if (aiMap) console.log(`AI 보강 ${aiMap.size}건 (분류·소개문·제품 판정)`);
  } catch (e) { console.warn(`AI 보강 실패(정규식 분류로 폴백): ${e.message}`); }
}

candidates = candidates
  .map((c, i) => {
    const ai = aiMap?.get(i) ?? null;
    if (ai && !ai.is_platform) return null;                            // AI 판정: 제품 아님(일반 기사·행사 등) → 제외
    // category_id: AI 분류(화이트리스트 검증분·문맥 이해) 우선 → 키워드 추정 → 소스 catHint 폴백.
    // confidence()의 +20 가점은 키워드·AI 매치에만 → catHint만으론 자동등재 임계(80)에 못 미침(안전).
    const kwCat = guessCategory(c.name, c.desc);
    return { ...c, ai, category_id: ai?.category_id || kwCat || c.catHint || "", confidence: confidence({ ...c, aiCat: !!ai?.category_id }) };
  })
  .filter(Boolean);

console.log(`중복 제거 후 신규 후보 ${candidates.length}건 (상한 ${MAX_PER_RUN})`);
for (const c of candidates) console.log(`  + [${c.source}] (${c.confidence}) ${c.name} | ${c.url}`);

// 소식 매핑(G-C): 국내 뉴스 원문 ↔ 기존 플랫폼 — 후보 플로우와 별개(중복 제거와 무관하게 계산)
const newsRows = buildNewsRows(newsRaw, platforms);
console.log(`기존 플랫폼 소식 매칭 ${newsRows.length}건 (뉴스 원문 ${newsRaw.length}건 중, 상한 ${NEWS_MAX_PER_RUN})`);
for (const r of newsRows) console.log(`  ~ [${r.source}] ${r.platform_id} ← ${r.title.slice(0, 60)}`);

if (DRY) { console.log("[dry] 투입 생략"); process.exit(0); }

// 자동 등재(D) 스위치 — app_settings 'autolist'.enabled + collector_id 일치할 때만.
// 기본 off → 전부 검수 큐로(오늘 동작 그대로). 켜져 있어도 confidence≥min & directUrl만 자동 등재.
let listed = 0, queued = 0, skipped = 0, insertFails = 0;
if (candidates.length > 0) {
  let auto = { enabled: false, min_confidence: 80, collector_id: null };
  try {
    const rows = await rest("app_settings?key=eq.autolist&select=value");
    if (rows?.[0]?.value) auto = { ...auto, ...rows[0].value };
  } catch { /* 설정 없으면 off로 간주 */ }
  const autoOn = !!auto.enabled && auto.collector_id === uid;

  // 검수 큐 투입은 봇 pending 상한(0028 RLS: status=pending < 10)을 넘으면 insert가 거부된다.
  // 미리 현재 pending 수를 세어 남은 슬롯만큼만 넣고, 초과분은 건너뛴다(다음 런에 다시 후보로 올라옴) — 런 실패 방지.
  const curPending = (await rest(`submissions?submitter_id=eq.${uid}&status=eq.pending&select=id`, {}, token))?.length ?? 0;
  let slotsLeft = Math.max(0, BOT_PENDING_CAP - curPending);

  for (const c of candidates) {
    // AI 보강분: 한국어 소개문(blurb_ko)을 desc로 — 자동등재 RPC·검수 승인 모두 payload.desc를 blurb로 쓰므로
    // 등재 품질이 그대로 올라간다. 원문 설명은 src_desc로 보존(검수 화면 참고용).
    const payload = {
      name: c.name, url: c.url, category_id: c.category_id, region: c.ai?.region || c.region,
      desc: c.ai?.blurb_ko || c.desc, confidence: c.confidence, note: `auto:${c.source} (${c.sourceLabel})`,
      ...(c.ai ? { ai: true, ...(c.ai.blurb_ko && c.desc && c.ai.blurb_ko !== c.desc ? { src_desc: c.desc } : {}) } : {}),
    };
    if (autoOn && c.directUrl && c.category_id && c.confidence >= auto.min_confidence) {
      // 서버 RPC가 재검증(스위치·collector_id·중복·id 생성)하고 lifecycle='review'+auto_listed로 등재.
      try {
        await rest("rpc/auto_list_candidate", {
          method: "POST",
          body: JSON.stringify({ p_payload: payload, p_confidence: c.confidence }),
        }, token);
        listed++;
        continue;
      } catch (e) {
        console.warn(`[auto-list 실패→검수 큐로] ${c.name}: ${e.message}`);
      }
    }
    if (slotsLeft <= 0) { skipped++; continue; } // 검수 큐 상한 도달 — 이번 런은 건너뜀
    // 개별 insert 실패(RLS 거부 등)는 흡수 — 한 건 때문에 전체 런과 소식 매핑까지 죽이지 않는다.
    // 단 전건 실패면 계정·정책 문제이므로 런을 실패시켜 ops-alert가 뜨게 한다.
    try {
      await rest("submissions", {
        method: "POST", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ submitter_id: uid, payload }),
      });
      queued++; slotsLeft--;
    } catch (e) {
      insertFails++;
      console.warn(`[검수 큐 투입 실패] ${c.name}: ${e.message}`);
    }
  }
  if (insertFails && queued === 0 && listed === 0) {
    throw new Error(`검수 큐 투입 전건 실패(${insertFails}건) — 봇 계정 권한·RLS 점검 필요(0036_grants_fix.sql 실행 여부 확인)`);
  }
  if (skipped) console.log(`검수 큐 상한(${BOT_PENDING_CAP}) 도달 — ${skipped}건은 다음 런으로 이월(큐를 비우면 투입됨)`);
} else {
  console.log("신규 후보 없음");
}

const newsPushed = newsRows.length ? await pushNews(newsRows) : 0;
console.log(`✓ 자동 등재 ${listed}건(사후 검수 대기) · 검수 큐 투입 ${queued}건${skipped ? ` · 이월 ${skipped}건` : ""} · 소식 연결 ${newsPushed}건(중복 무시) — 관리 콘솔에서 확인하세요.`);
