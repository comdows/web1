/* 신규 플랫폼·AI 도구 자동 수집기 — GitHub Actions 주간 실행(collect.yml).
 *
 * 흐름: 소스 수집(RSS/API) → 정규화 → 중복 제거(기존 등재 + 봇의 과거 제보) → 봇 계정으로
 * submissions에 후보 투입 → 관리 콘솔 "제보 검수 큐"에서 사람이 승인해야만 등재된다(자동 등재 없음).
 *
 * 필요 환경변수(GitHub Secrets):
 *   SUPABASE_URL, SUPABASE_ANON_KEY  — 공개 anon 키(서비스 키 아님)
 *   BOT_EMAIL, BOT_PASSWORD          — 사이트에서 가입한 봇 계정(일반 회원 — RLS로 본인 제보만 가능)
 *
 * 로컬 검증: node collect.mjs --dry [--fixture 디렉토리]
 *   --dry: 수집·중복제거까지만 하고 출력(DB 미접속·미투입)
 *   --fixture: 네트워크 대신 저장된 응답 파일 사용(producthunt.xml, hn.json, platum.xml)
 */
import fs from "node:fs";
import path from "node:path";

const DRY = process.argv.includes("--dry");
const fixIdx = process.argv.indexOf("--fixture");
const FIXTURE_DIR = fixIdx > -1 ? process.argv[fixIdx + 1] : null;
const MAX_PER_RUN = 15; // 검수 부담 상한(1인 운영)

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_ANON_KEY;

/* ── 소스 정의 ─────────────────────────────────────────────── */
// directUrl: 항목 url이 "그 제품의 실제 사이트"인 소스(HN·PH는 제품 링크). 국내 뉴스 RSS는 url이
//   "기사 주소"라 사람이 실 URL을 찾아야 함(directUrl=false) → 자동 등재(D) 대상에서 제외되고 검수/일괄승인(C)로 감.
// koLaunch: 국내 뉴스는 "출시/론칭" 기사만 후보로(일반 소식 제외).
const SOURCES = [
  {
    id: "producthunt",
    label: "Product Hunt (AI)",
    url: "https://www.producthunt.com/feed?category=artificial-intelligence",
    fixture: "producthunt.xml",
    region: "overseas",
    parse: parseAtom,
    directUrl: false, // 피드 링크는 PH 게시물 페이지(제품 사이트 아님)
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
  }));
}
function parseHN(json) {
  const d = typeof json === "string" ? JSON.parse(json) : json;
  return (d.hits || []).filter((h) => h.url).map((h) => ({
    name: decode(h.title).replace(/^Show HN:\s*/i, ""), url: h.url, desc: "",
  }));
}

/* 제목·설명 키워드 → 분야 추정(검수 셀렉트 초기값 제안 — 오분류여도 관리자가 교정) */
const CAT_RULES = [
  [/video|영상|film|clip/i, "ai_video"], [/image|이미지|design|디자인|photo|logo/i, "ai_image"],
  [/voice|audio|music|음성|음악|tts|speech/i, "ai_audio"], [/code|coding|developer|개발|ide|api/i, "ai_code"],
  [/meeting|회의|transcri|note/i, "ai_meeting"], [/marketing|seo|광고|ads|customer|support|cs/i, "ai_marketing"],
  [/agent|automat|workflow|자동화/i, "ai_auto"], [/search|research|리서치|번역|translat|paper/i, "ai_research"],
  [/write|writing|copy|글쓰기|document|문서/i, "ai_writing"], [/\bai\b|gpt|llm|chat/i, "ai_chat"],
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
      directUrl: !!src.directUrl,
    }));
}

/* ── 자동 등재 신뢰도 점수(D, 0~100) ──────────────────────────
 * "url이 제품 실사이트인가"가 핵심 안전 신호 — directUrl이 아니면 최대치가 임계 아래로 묶여
 * 절대 자동 등재되지 않는다(국내 뉴스는 기사 URL이라 사람이 실 URL 확인 필요 → 검수/일괄승인으로).*/
function confidence(c) {
  let score = 30;
  if (c.directUrl) score += 25; else return Math.min(score + 5, 55); // 비직접 URL은 55 상한
  if (guessCategory(c.name, c.desc)) score += 20;
  if ((c.desc || "").trim().length >= 20) score += 10;
  const n = c.name.trim();
  if (n.length >= 2 && n.length <= 40 && !/^[A-Z ]+$/.test(n)) score += 10;
  if (AGGREGATOR_HOSTS.test(host(c.url))) score -= 25;
  return Math.max(0, Math.min(100, score));
}

/* ── 수집 ─────────────────────────────────────────────────── */
/* 개별 소스 실패는 흡수하되(일시 장애·포맷 변경 가능성), 전 소스 동시 실패는
 * 수집기 자체의 고장(네트워크·차단·파서 붕괴)이므로 런을 실패시켜 알림을 받는다 — 조용한 수집 정체 방지 */
let sourceFails = 0;
async function fetchSource(src) {
  if (FIXTURE_DIR) {
    const p = path.join(FIXTURE_DIR, src.fixture);
    if (!fs.existsSync(p)) return [];
    return normalize(src.parse(fs.readFileSync(p, "utf8")), src);
  }
  try {
    const res = await fetch(src.url, { headers: { "User-Agent": "semopl-collector/1.0 (+https://comdows.github.io/web1/)" } });
    if (!res.ok) { console.warn(`[skip] ${src.id}: HTTP ${res.status}`); sourceFails++; return []; }
    return normalize(src.parse(await res.text()), src);
  } catch (e) {
    console.warn(`[skip] ${src.id}: ${e.message}`);
    sourceFails++;
    return [];
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

// 1차: 수집분 내부 dedup(호스트 기준)
const seen = new Set();
let candidates = collected.filter((c) => { const h = host(c.url); if (seen.has(h)) return false; seen.add(h); return true; });

if (DRY && !SB_URL) {
  console.log(`\n[dry] DB 미접속 — 후보 ${candidates.length}건 (신뢰도·자동등재대상 표시):`);
  for (const c of candidates.slice(0, 40)) {
    const sc = confidence(c), cat = guessCategory(c.name, c.desc);
    const auto = c.directUrl && cat && sc >= 80 ? "★자동" : "검수";
    console.log(`  - [${c.source}] (${sc} ${auto}) ${c.name} | ${c.url}`);
  }
  process.exit(0);
}

// 2차: 기존 등재 플랫폼 + 봇의 과거 제보와 dedup (호스트 정규화 + 이름 퍼지 매칭)
const platforms = await rest("platforms?select=url,name");
const knownHosts = new Set(platforms.map((p) => host(p.url)).filter(Boolean));
const knownKeys = new Set(platforms.map((p) => nameKey(p.name)).filter(Boolean));

const { token, uid } = DRY ? { token: null, uid: null } : await botLogin();
const mySubs = token ? await rest("submissions?select=payload&limit=1000", {}, token) : [];
for (const s of mySubs) {
  const h = host(s.payload?.url ?? ""); if (h) knownHosts.add(h);
  const k = nameKey(s.payload?.name ?? ""); if (k) knownKeys.add(k);
}

candidates = candidates
  .filter((c) => !knownHosts.has(host(c.url)) && !fuzzyNameHit(c.name, knownKeys))
  .slice(0, MAX_PER_RUN)
  .map((c) => ({ ...c, confidence: confidence(c), category_id: guessCategory(c.name, c.desc) }));

console.log(`중복 제거 후 신규 후보 ${candidates.length}건 (상한 ${MAX_PER_RUN})`);
for (const c of candidates) console.log(`  + [${c.source}] (${c.confidence}) ${c.name} | ${c.url}`);

if (DRY) { console.log("[dry] 투입 생략"); process.exit(0); }
if (candidates.length === 0) { console.log("신규 후보 없음 — 종료"); process.exit(0); }

// 자동 등재(D) 스위치 — app_settings 'autolist'.enabled + collector_id 일치할 때만.
// 기본 off → 전부 검수 큐로(오늘 동작 그대로). 켜져 있어도 confidence≥min & directUrl만 자동 등재.
let auto = { enabled: false, min_confidence: 80, collector_id: null };
try {
  const rows = await rest("app_settings?key=eq.autolist&select=value");
  if (rows?.[0]?.value) auto = { ...auto, ...rows[0].value };
} catch { /* 설정 없으면 off로 간주 */ }
const autoOn = !!auto.enabled && auto.collector_id === uid;

let listed = 0, queued = 0;
for (const c of candidates) {
  const payload = {
    name: c.name, url: c.url, category_id: c.category_id, region: c.region,
    desc: c.desc, confidence: c.confidence, note: `auto:${c.source} (${c.sourceLabel})`,
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
  await rest("submissions", {
    method: "POST", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ submitter_id: uid, payload }),
  });
  queued++;
}
console.log(`✓ 자동 등재 ${listed}건(사후 검수 대기) · 검수 큐 투입 ${queued}건 — 관리 콘솔에서 확인하세요.`);
