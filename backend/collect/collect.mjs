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
const SOURCES = [
  {
    id: "producthunt",
    label: "Product Hunt (AI)",
    url: "https://www.producthunt.com/feed?category=artificial-intelligence",
    fixture: "producthunt.xml",
    region: "overseas",
    parse: parseAtom,
  },
  {
    id: "hn",
    label: "Hacker News (Show HN)",
    url: "https://hn.algolia.com/api/v1/search_by_date?tags=show_hn&hitsPerPage=30&query=AI",
    fixture: "hn.json",
    region: "overseas",
    parse: parseHN,
  },
  {
    id: "platum",
    label: "플래텀 (국내 스타트업)",
    url: "https://platum.kr/feed",
    fixture: "platum.xml",
    region: "domestic",
    parse: parseRss,
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

/* ── 정규화·필터 ───────────────────────────────────────────── */
const KO_LAUNCH = /(출시|론칭|런칭|오픈|선보|공개)/;           // 국내 뉴스: 출시 소식만 후보로
const NAME_CUT = /\s*(?:[—–|]|\s-|:)\s+.*$/;                  // "이름 - 부제" / "이름: 부제" → 이름
function host(u) { try { return new URL(u).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; } }

function normalize(items, src) {
  return items
    .map((it) => ({ ...it, name: it.name.replace(NAME_CUT, "").slice(0, 60).trim() }))
    .filter((it) => it.name && it.url && host(it.url))
    .filter((it) => src.id !== "platum" || KO_LAUNCH.test(it.name + it.desc))
    .map((it) => ({
      name: it.name, url: it.url, desc: it.desc,
      region: src.region, source: src.id, sourceLabel: src.label,
    }));
}

/* ── 수집 ─────────────────────────────────────────────────── */
async function fetchSource(src) {
  if (FIXTURE_DIR) {
    const p = path.join(FIXTURE_DIR, src.fixture);
    if (!fs.existsSync(p)) return [];
    return normalize(src.parse(fs.readFileSync(p, "utf8")), src);
  }
  try {
    const res = await fetch(src.url, { headers: { "User-Agent": "semopl-collector/1.0 (+https://comdows.github.io/web1/)" } });
    if (!res.ok) { console.warn(`[skip] ${src.id}: HTTP ${res.status}`); return []; }
    return normalize(src.parse(await res.text()), src);
  } catch (e) {
    console.warn(`[skip] ${src.id}: ${e.message}`);
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

// 1차: 수집분 내부 dedup(호스트 기준)
const seen = new Set();
let candidates = collected.filter((c) => { const h = host(c.url); if (seen.has(h)) return false; seen.add(h); return true; });

if (DRY && !SB_URL) {
  console.log(`\n[dry] DB 미접속 — 후보 ${candidates.length}건:`);
  for (const c of candidates.slice(0, 30)) console.log(`  - [${c.source}] ${c.name} | ${c.url}`);
  process.exit(0);
}

// 2차: 기존 등재 플랫폼 + 봇의 과거 제보와 dedup
const platforms = await rest("platforms?select=url,name");
const knownHosts = new Set(platforms.map((p) => host(p.url)).filter(Boolean));
const knownNames = new Set(platforms.map((p) => p.name.toLowerCase()));

const { token, uid } = DRY ? { token: null, uid: null } : await botLogin();
const mySubs = token ? await rest("submissions?select=payload&limit=1000", {}, token) : [];
for (const s of mySubs) { const h = host(s.payload?.url ?? ""); if (h) knownHosts.add(h); }

candidates = candidates
  .filter((c) => !knownHosts.has(host(c.url)) && !knownNames.has(c.name.toLowerCase()))
  .slice(0, MAX_PER_RUN);

console.log(`중복 제거 후 신규 후보 ${candidates.length}건 (상한 ${MAX_PER_RUN})`);
for (const c of candidates) console.log(`  + [${c.source}] ${c.name} | ${c.url}`);

if (DRY) { console.log("[dry] 투입 생략"); process.exit(0); }
if (candidates.length === 0) { console.log("신규 후보 없음 — 종료"); process.exit(0); }

for (const c of candidates) {
  await rest("submissions", {
    method: "POST", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      submitter_id: uid,
      payload: {
        name: c.name, url: c.url, category_id: "", region: c.region,
        desc: c.desc, note: `auto:${c.source} (${c.sourceLabel})`,
      },
    }),
  });
}
console.log(`✓ 검수 큐에 ${candidates.length}건 투입 완료 — 관리 콘솔에서 승인/반려하세요.`);
