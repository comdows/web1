/* 영문 정적 레이어(korea-gateway) — prerender.mjs 뒤에 실행(package.json build).
 * 외국 사업자용 "한국 진출 영문 디렉토리": /en/(랜딩) · /en/c/<분야>/ · /en/p/<플랫폼>/ · /en/guide/<slug>/.
 *
 * 법적 방화벽(전략위원회 판정): EN 페이지는 SPA 스크립트를 제거한 완전 정적 HTML이다 —
 * 제휴·거래소·가치진단·약관은 한국법 전제라 EN 표면에서 링크·노출 일절 금지(플래그가 아니라 스크립트 부재로 차단).
 * 데이터: platforms.en.json(검수된 commerce+trade 번역만) — 미번역 플랫폼은 EN에서 조용히 생략. */
import fs from "node:fs";
import path from "node:path";

import { SITE_URL } from "../site.config.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const DIST = path.join(ROOT, "dist");
const SITE = SITE_URL;

const data = JSON.parse(fs.readFileSync(path.join(ROOT, "src/data/platforms.json"), "utf8"));
const EN = JSON.parse(fs.readFileSync(path.join(ROOT, "src/data/platforms.en.json"), "utf8"));
const GUIDES = JSON.parse(fs.readFileSync(path.join(ROOT, "src/data/guides.en.json"), "utf8"));
const AI = JSON.parse(fs.readFileSync(path.join(ROOT, "src/data/ai-stack.en.json"), "utf8"));
const PF = JSON.parse(fs.readFileSync(path.join(ROOT, "src/data/profile-fields.en.json"), "utf8"));       // 판단 필드 3축(+공식 링크)
const COMPARE = JSON.parse(fs.readFileSync(path.join(ROOT, "src/data/compare.en.json"), "utf8"));          // 비교 페이지
const INTROS = JSON.parse(fs.readFileSync(path.join(ROOT, "src/data/hub-intros.en.json"), "utf8"));        // 허브 intro

/* ── 검증: 미존재 id 참조·빈 필드·과장 길이는 빌드 실패(미번역은 생략일 뿐 오류 아님) ── */
const koById = new Map(data.platforms.map((p) => [p.id, p]));
const errs = [];
for (const [id, e] of Object.entries(EN.platforms)) {
  if (!koById.has(id)) errs.push(`EN에만 있는 id: ${id}`);
  else if (!e.name?.trim() || !e.blurb?.trim()) errs.push(`빈 name/blurb: ${id}`);
  else if (e.blurb.length > 175) errs.push(`blurb 과장(${e.blurb.length}자): ${id}`);
}
for (const c of data.categories) if (!EN.categories[c.id]?.name) errs.push(`분야 번역 누락: ${c.id}`);
for (const g of data.groups) if (!EN.groups[g.id]?.name) errs.push(`그룹 번역 누락: ${g.id}`);
for (const g of Object.values(GUIDES)) for (const s of g.steps) for (const c of s.cats)
  if (!EN.categories[c]) errs.push(`가이드가 없는 분야 참조: ${c}`);
/* 판단 필드 검증 — 미등재 id·길이 초과·비https 링크는 빌드 실패 */
for (const [id, f] of Object.entries(PF)) {
  if (!EN.platforms[id]) errs.push(`판단 필드의 미등재 id: ${id}`);
  if ((f.for ?? "").length > 170 || (f.enSupport ?? "").length > 150 || (f.sellerPath ?? "").length > 190) errs.push(`판단 필드 길이 초과: ${id}`);
  for (const u of Object.values(f.links ?? {})) if (!/^https:\/\//.test(u)) errs.push(`판단 필드 비https 링크: ${id}`);
}
for (const c of COMPARE) for (const r of c.rows) if (/fee|commission|수수료|legal|law/i.test(r.aspect)) errs.push(`비교 축 금지 위반: ${c.slug} → ${r.aspect}`);
/* AI 스택 검증 — 가격 수치·Top N 프레이밍은 스키마 단계에서 금지(방화벽), 필드 실측 필수 */
const aiIds = new Set(AI.tools.map((t) => t.id));
for (const t of AI.tools) {
  if (!/^[a-z0-9-]+$/.test(t.id)) errs.push(`AI id 형식 위반: ${t.id}`);
  if (!t.name?.trim() || !t.blurb?.trim() || !t.officialUrl || !t.lastVerified) errs.push(`AI 필수 필드 누락: ${t.id}`);
  if ((t.blurb ?? "").length > 175) errs.push(`AI blurb 과장(${t.blurb.length}자): ${t.id}`);
  if (!["confirmed", "unknown"].includes(t.paymentAbroad)) errs.push(`AI paymentAbroad 값 위반: ${t.id}`);
}
if (AI.tools.length !== aiIds.size) errs.push(`AI id 중복`);
for (const pid of Object.keys(AI.profiles)) if (!aiIds.has(pid)) errs.push(`프로필의 미등재 도구: ${pid}`);
for (const g of AI.guides) for (const s of g.sections) for (const tid of s.toolIds ?? [])
  if (!aiIds.has(tid)) errs.push(`AI 가이드가 없는 도구 참조: ${g.slug} → ${tid}`);
if (errs.length) { errs.slice(0, 20).forEach((e) => console.error(`  ✗ ${e}`)); process.exit(1); }

const enPlats = data.platforms.filter((p) => EN.platforms[p.id]);
const byCat = new Map();
for (const p of enPlats) { const a = byCat.get(p.category) ?? []; a.push(p); byCat.set(p.category, a); }
const enCats = data.categories.filter((c) => (byCat.get(c.id) ?? []).length > 0);

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const en = (id) => EN.platforms[id];
const catEn = (id) => EN.categories[id] ?? { name: id, desc: "" };

/* SPA 부팅 차단: 모듈 스크립트·프리로드 제거 + lang 치환 — EN 방화벽의 핵심.
 * 템플릿은 _template.html(원본) — dist/index.html은 prerender.mjs가 홈 정적 콘텐츠로 재작성해 #root가 비어 있지 않다. */
const template = fs.readFileSync(path.join(DIST, "_template.html"), "utf8")
  .replace(/<script type="module"[^>]*><\/script>\s*/g, "")
  .replace(/<link rel="modulepreload"[^>]*>\s*/g, "")
  .replace('lang="ko"', 'lang="en"');
if (/type="module"/.test(template)) { console.error("✗ EN 템플릿에 모듈 스크립트 잔존"); process.exit(1); }
if (!/<div id="root"><\/div>/.test(template)) { console.error("✗ EN 템플릿 #root가 비어 있지 않음 — 치환 실패 위험"); process.exit(1); }

const FOOTER = `
<footer style="max-width:760px;margin:48px auto 32px;padding:20px;border-top:1px solid #2a3350;font-size:13px;opacity:.75">
  <p><b>SEMOPL</b> — Korean business platforms, organized. Directory information only; not legal, financial, or tax advice.
  Fees, eligibility, and terms change — always verify on each platform's official site.</p>
  <p>The partnership board and business-transfer exchange serve Korea-based businesses in Korean, under Korean law, and are not offered in English.</p>
  <p><a href="https://github.com/comdows/web1/issues/new?title=${encodeURIComponent("[EN] Report an error / Ask about entering Korea")}" style="color:#7C97FF">Report an error or ask a question →</a> · <a href="/web1/en/about/" style="color:#7C97FF">About &amp; methodology</a> · <a href="/web1/" style="color:#7C97FF">한국어 사이트</a></p>
</footer>`;

function shell({ title, desc, canonical, koUrl, ld, body }) {
  return template
    .replace(/<title>[^<]*<\/title>/, `<title>${esc(title)}</title>`)
    .replace(/(<meta name="description" content=")[^"]*(")/, `$1${esc(desc)}$2`)
    .replace(/(<meta property="og:title" content=")[^"]*(")/, `$1${esc(title)}$2`)
    .replace(/(<meta property="og:description" content=")[^"]*(")/, `$1${esc(desc)}$2`)
    .replace(/(<meta property="og:url" content=")[^"]*(")/, `$1${canonical}$2`)
    .replace("</head>",
      `  <link rel="canonical" href="${canonical}">\n` +
      `  <link rel="alternate" hreflang="en" href="${canonical}">\n` +
      (koUrl ? `  <link rel="alternate" hreflang="ko" href="${koUrl}">\n  <link rel="alternate" hreflang="x-default" href="${koUrl}">\n` : "") +
      (ld ? `  <script type="application/ld+json">${ld}</script>\n` : "") + `  </head>`)
    .replace(/(<div id="root">)(<\/div>)/, `$1${body}${FOOTER}$2`);
}
const MAIN = `<main style="max-width:760px;margin:32px auto;padding:0 20px">`;
const NAV = `<p style="font-family:monospace;font-size:12px"><a href="/web1/en/" style="color:#7C97FF">SEMOPL — Korean platforms in English</a></p>`;
/* Korea Entry Inquiry(0단계 수요 계측) — 접수는 GitHub Issue Form, 소개 이행·과금은 전부 한국어 레이어.
 * EN 표면은 'inquiry' 프레이밍만: 제휴 보드·연결료·약관 비노출(방화벽 불변) */
const INQUIRY_URL = "https://github.com/comdows/web1/issues/new?template=korea-partner-inquiry.yml";
const inquiryCta = (topic) => `
<p style="margin:28px 0;padding:14px 16px;border:1px solid #2a3350;border-radius:10px">
  <b>Looking for a Korean partner${topic ? ` in ${esc(topic)}` : ""}?</b>
  We review inquiries from businesses entering Korea and, where there is a fit, introduce them to platforms in this directory —
  free for the inquiring business. <a href="/web1/en/partner-inquiry/" style="color:#7C97FF;font-weight:700">Submit an inquiry →</a>
</p>`;
const card = (p) => `<li style="margin:0 0 14px"><a href="/web1/en/p/${p.id}/" style="color:#7C97FF;font-weight:700">${esc(en(p.id).name)}</a>${p.region === "해외" ? " <small>(global)</small>" : ""} — ${esc(en(p.id).blurb)}</li>`;

const write = (rel, html) => { const d = path.join(DIST, rel); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, "index.html"), html); };

/* ── /en/ 랜딩 ── */
const landingLd = JSON.stringify({ "@context": "https://schema.org", "@graph": [
  { "@type": "WebSite", name: "SEMOPL (English)", url: `${SITE}/en/`, inLanguage: "en" },
  { "@type": "Dataset", name: "Korean commerce & trade platforms (English directory)",
    description: `${enPlats.length} Korean commerce and trade platforms with English names and one-line descriptions, each linked to its official site. Neutral directory — no paid placement.`,
    url: `${SITE}/en/`, license: "https://creativecommons.org/licenses/by/4.0/", isAccessibleForFree: true,
    distribution: [{ "@type": "DataDownload", encodingFormat: "application/json", contentUrl: `${SITE}/en/data/platforms.json` }] } ] });
write("en", shell({
  title: "Korean Business Platforms in English — SEMOPL",
  desc: `A structured English directory of Korean commerce & trade platforms (${enPlats.length} entries, ${enCats.length} categories) for foreign sellers and businesses entering Korea.`,
  canonical: `${SITE}/en/`, koUrl: `${SITE}/`, ld: landingLd,
  body: `${MAIN}
  <h1>Korean Business Platforms, in English</h1>
  <p>Korea is one of the world's largest e-commerce markets — but its platform landscape is documented almost entirely in Korean.
  SEMOPL catalogs 1,600+ Korean business platforms in one taxonomy; this English layer covers the <b>${enPlats.length} commerce &amp; trade platforms</b> most relevant to foreign sellers, each linked to its official site.</p>
  <h2>Guides</h2>
  <ul>${Object.entries(GUIDES).map(([slug, g]) => `<li style="margin-bottom:10px"><a href="/web1/en/guide/${slug}/" style="color:#7C97FF;font-weight:700">${esc(g.title)}</a> — ${esc(g.desc)}</li>`).join("")}
  ${COMPARE.map((c) => `<li style="margin-bottom:10px"><a href="/web1/en/compare/${c.slug}/" style="color:#7C97FF;font-weight:700">${esc(c.title)}</a> — ${esc(c.desc)}</li>`).join("")}
  <li style="margin-bottom:10px"><a href="/web1/en/official-links/" style="color:#7C97FF;font-weight:700">Official seller &amp; fee pages, verified</a> — direct links to the pages that are always current.</li></ul>
  <h2>AI tools for the Korean market</h2>
  <p><a href="/web1/en/ai/" style="color:#7C97FF;font-weight:700">${AI.tools.length} AI tools verified for Korean →</a> —
  Korean-made B2B tools and global tools with documented Korean support: English docs, evidence links, and payment-from-abroad status for each.</p>
  ${(() => { // Recently added — ko 신규 플래그 중 EN 번역 존재분(빌드 시 자동 재생성 — 한계비용 0)
    const recent = data.platforms.filter((p) => p.new && EN.platforms[p.id]).slice(0, 8);
    return recent.length ? `<h2>Recently added</h2>
  <ul>${recent.map((p) => `<li style="margin-bottom:8px"><a href="/web1/en/p/${p.id}/" style="color:#7C97FF;font-weight:700">${esc(en(p.id).name)}</a> — ${esc(en(p.id).blurb)}</li>`).join("")}</ul>` : "";
  })()}
  <h2>Browse by category</h2>
  <ul>${enCats.map((c) => `<li style="margin-bottom:8px"><a href="/web1/en/c/${c.id}/" style="color:#7C97FF;font-weight:700">${esc(catEn(c.id).name)}</a> (${byCat.get(c.id).length}) — ${esc(catEn(c.id).desc)}</li>`).join("")}</ul>
  <p><a href="/web1/en/all/" style="color:#7C97FF;font-weight:700">All platforms A–Z →</a> — find a platform by name.</p>
  ${inquiryCta("")}
</main>` }));

/* ── /en/c/<id>/ 분야 허브 ── */
for (const c of enCats) {
  const list = byCat.get(c.id);
  const ce = catEn(c.id);
  const ld = JSON.stringify({ "@context": "https://schema.org", "@type": "ItemList", name: `${ce.name} — Korean platforms`, numberOfItems: list.length,
    itemListElement: list.map((p, i) => ({ "@type": "ListItem", position: i + 1, name: en(p.id).name, url: `${SITE}/en/p/${p.id}/` })) });
  write(`en/c/${c.id}`, shell({
    title: `${ce.name} in Korea — ${list.length} Platforms | SEMOPL`,
    desc: `${ce.desc} ${list.length} Korean platforms in this category, each linked to its official site.`.slice(0, 155),
    canonical: `${SITE}/en/c/${c.id}/`, koUrl: `${SITE}/c/${c.id}/`, ld,
    body: `${MAIN}${NAV}
    <h1>${esc(ce.name)} — Korean Platforms</h1>
    <p>${esc(ce.desc)}</p>
    ${INTROS[c.id] ? `<p>${esc(INTROS[c.id])}</p>` : ""}
    <ul>${list.map(card).join("")}</ul>
    ${inquiryCta(ce.name)}
</main>` }));
}

/* ── /en/p/<id>/ 상세 ── */
for (const p of enPlats) {
  const e = en(p.id); const ce = catEn(p.category);
  const similar = (byCat.get(p.category) ?? []).filter((x) => x.id !== p.id).slice(0, 5);
  const ld = JSON.stringify({ "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [
    { "@type": "ListItem", position: 1, name: "SEMOPL (EN)", item: `${SITE}/en/` },
    { "@type": "ListItem", position: 2, name: ce.name, item: `${SITE}/en/c/${p.category}/` },
    { "@type": "ListItem", position: 3, name: e.name, item: `${SITE}/en/p/${p.id}/` }] });
  write(`en/p/${p.id}`, shell({
    title: `${e.name} — ${ce.name} | SEMOPL`,
    desc: e.blurb.slice(0, 155),
    canonical: `${SITE}/en/p/${p.id}/`, koUrl: `${SITE}/p/${p.id}/`, ld,
    body: `${MAIN}${NAV}
    <p><a href="/web1/en/c/${p.category}/" style="color:#7C97FF">${esc(ce.name)}</a>${p.region === "해외" ? " · global" : " · Korea"}</p>
    <h1>${esc(e.name)}</h1>
    <p>${esc(e.blurb)}</p>
    <p><a href="${esc(p.url)}" rel="noopener" style="color:#7C97FF;font-weight:700">Official site →</a></p>
    ${PF[p.id] ? `<h2>For businesses entering Korea</h2>
    <ul>
      ${PF[p.id].for ? `<li style="margin-bottom:8px"><b>Who it fits:</b> ${esc(PF[p.id].for)}</li>` : ""}
      ${PF[p.id].enSupport ? `<li style="margin-bottom:8px"><b>English support:</b> ${esc(PF[p.id].enSupport)}</li>` : ""}
      ${PF[p.id].sellerPath ? `<li style="margin-bottom:8px"><b>Becoming a seller:</b> ${esc(PF[p.id].sellerPath)}</li>` : ""}
      ${PF[p.id].links?.seller ? `<li><a href="${esc(PF[p.id].links.seller)}" rel="noopener" style="color:#7C97FF">Official seller page →</a></li>` : ""}
      ${PF[p.id].links?.fees ? `<li><a href="${esc(PF[p.id].links.fees)}" rel="noopener" style="color:#7C97FF">Official fee information →</a></li>` : ""}
    </ul>
    <p><small style="opacity:.75">Verified against official sources on ${esc(PF[p.id].lastVerified)}. Details change — the official pages above are always current.</small></p>` : ""}
    <p><i>See the official site for fees, settlement cycles, and seller requirements — these change frequently and are not republished here.</i></p>
    <p><a href="/web1/en/partner-inquiry/" style="color:#7C97FF">Looking to partner with Korean platforms like this? Submit an inquiry (free) →</a></p>
    ${similar.length ? `<h2>Similar platforms</h2><ul>${similar.map(card).join("")}</ul>` : ""}
</main>` }));
}

/* ── /en/guide/<slug>/ ── */
for (const [slug, g] of Object.entries(GUIDES)) {
  write(`en/guide/${slug}`, shell({
    title: `${g.title} | SEMOPL`, desc: g.desc.slice(0, 155),
    canonical: `${SITE}/en/guide/${slug}/`,
    body: `${MAIN}${NAV}
    <h1>${esc(g.title)}</h1>
    <p>${esc(g.intro)}</p>
    ${g.steps.map((s, i) => `<h2>${i + 1}. ${esc(s.t)}</h2><p>${esc(s.d)}</p>
      <p>Categories: ${s.cats.map((c) => `<a href="/web1/en/c/${c}/" style="color:#7C97FF">${esc(catEn(c).name)}</a>`).join(" · ")}</p>`).join("")}
    <p><b>Note:</b> ${esc(g.note)}</p>
</main>` }));
}

/* ── /en/about/ 신뢰·방법론 페이지 (중립성은 대행사가 채택 불가능한 자산 — 명문화) ── */
write("en/about", shell({
  title: "About & Methodology — SEMOPL English Directory",
  desc: "How this directory is built: neutral listing criteria, why we never republish fees, and how to report errors.",
  canonical: `${SITE}/en/about/`,
  body: `${MAIN}${NAV}
  <h1>About this directory</h1>
  <p>SEMOPL catalogs 1,600+ Korean business platforms in Korean; this English layer covers the ${enPlats.length} commerce and trade platforms most relevant to businesses researching the Korean market.</p>
  <h2>Neutrality</h2>
  <p><b>No platform or agency pays to be listed, ranked, or described.</b> There are no affiliate links, no paid placements, and no consulting funnel behind this directory. Every entry ends with a direct link to the platform's own official site.</p>
  <h2>Why we never republish fees</h2>
  <p>Commission rates, settlement cycles, and seller requirements change frequently and differ by category. Republishing them in English would go stale within months — so instead of copying numbers, we link you to the official source that is always current. If a page here disagrees with an official site, the official site is right.</p>
  <h2>Listing criteria & updates</h2>
  <p>Platforms are included when a business can sell, source, ship, or promote through them. The underlying dataset is maintained weekly in Korean (new platforms are collected, reviewed by a human, then added); English entries follow after translation review. Dead links are checked monthly.</p>
  <h2>Corrections</h2>
  <p><a href="https://github.com/comdows/web1/issues/new?title=${encodeURIComponent("[EN] Correction")}" style="color:#7C97FF">Report an error on GitHub →</a> — corrections ship in the next build.</p>
</main>` }));

/* ── /en/partner-inquiry/ — Korea Entry Inquiry 접수 안내(0단계 수요 계측).
 * 접수는 GitHub Issue Form(공개·en-inbound 라벨), 검토·소개·과금은 전부 한국어 레이어에서.
 * 외국 측 무과금 · 지분/펀딩/증권 명시 배제 · 동의 없는 연락처 공유 없음 ── */
write("en/partner-inquiry", shell({
  title: "Find a Korean Platform Partner — Free Inquiry | SEMOPL",
  desc: "Free inquiry for businesses entering Korea: we review your request and, where there is a fit, introduce you to Korean platforms — only with both parties' consent.",
  canonical: `${SITE}/en/partner-inquiry/`,
  body: `${MAIN}${NAV}
  <h1>Find a Korean Platform Partner</h1>
  <p>SEMOPL maintains the largest structured directory of Korean business platforms (1,600+ entries; ${enPlats.length} documented in English).
  If your business is entering Korea and needs a platform partner — a sales channel, a distributor, a fulfillment provider, or an integration partner —
  you can submit an inquiry below. It is <b>free for the inquiring business</b>.</p>
  <h2>How it works</h2>
  <ol>
    <li><b>Submit</b> — a short public inquiry via the form below (no confidential details needed).</li>
    <li><b>Review</b> — we check it against the directory and follow up on the same thread if there is a plausible fit.</li>
    <li><b>Introduction</b> — we contact the Korean platform first; an introduction happens <b>only when both sides consent</b>. Contact details are never shared without explicit consent.</li>
  </ol>
  <h2>Scope</h2>
  <p>In scope: marketplace listing, distribution &amp; wholesale, fulfillment &amp; logistics, technology/API integration, co-marketing.</p>
  <p><b>Out of scope:</b> equity investment, fundraising, and securities of any kind — such inquiries are closed without review.
  Business-transfer (M&amp;A) listings are not available through this channel.</p>
  <p style="margin:28px 0"><a href="${INQUIRY_URL}" rel="noopener" style="display:inline-block;padding:12px 18px;border:1px solid #3D63FF;border-radius:10px;color:#7C97FF;font-weight:700">Submit an inquiry on GitHub →</a></p>
  <p><small>The form is public. For sensitive matters, email <a href="mailto:comdows@hanmail.net" style="color:#7C97FF">comdows@hanmail.net</a> instead.
  See <a href="/web1/en/about/" style="color:#7C97FF">About &amp; methodology</a> for how this directory is run — no paid placement, no consulting funnel.</small></p>
</main>` }));

/* ── Korea AI Stack(/en/ai/) — 0단계 실측이 확인한 인용 공백만 겨냥:
 * '한국어 지원 필터'와 '한국 진출용 스택'. covered 영역(TTS 라운드업·번역기 비교·Naver SEO)은 집필하지 않음.
 * 차별화 = 검증 필드 3종(영문 문서·한국어 실증 URL·해외결제 확인/불명) + last verified 날짜 ── */
const AI_CATS = { writing: "Writing & copy", document: "Documents & OCR", voice: "Voice & speech",
  video: "Video", "chatbot-cs": "Chatbots & customer service", translation: "Translation",
  data: "Data & analytics", "dev-infra": "Developer & infrastructure" };
const aiCatLabel = (c) => AI_CATS[c] ?? "Other";
const aiToolLink = (id) => {
  const t = AI.tools.find((x) => x.id === id);
  if (!t) return "";
  return AI.profiles[id]
    ? `<a href="/web1/en/ai/${id}/" style="color:#7C97FF">${esc(t.name)}</a>`
    : `<a href="${esc(t.officialUrl)}" rel="noopener" style="color:#7C97FF">${esc(t.name)}</a>`;
};
const aiVerifyLine = (t) => [
  `Korean: ${esc(t.koreanNote)}${t.koreanEvidence ? ` (<a href="${esc(t.koreanEvidence)}" rel="noopener" style="color:#7C97FF">evidence</a>)` : ""}`,
  t.enDocs ? `English docs: <a href="${esc(t.enDocs)}" rel="noopener" style="color:#7C97FF">yes</a>` : "English docs: none found",
  `Payment from abroad: <b>${t.paymentAbroad}</b>${t.paymentNote ? ` — ${esc(t.paymentNote)}` : ""}`,
  `verified ${t.lastVerified}`,
].join(" · ");

const aiByCat = new Map();
for (const t of AI.tools) { const a = aiByCat.get(t.category) ?? []; a.push(t); aiByCat.set(t.category, a); }
const aiDirLd = JSON.stringify({ "@context": "https://schema.org", "@type": "ItemList",
  name: "AI tools verified for the Korean market", numberOfItems: AI.tools.length,
  itemListElement: AI.tools.map((t, i) => ({ "@type": "ListItem", position: i + 1, name: t.name,
    url: AI.profiles[t.id] ? `${SITE}/en/ai/${t.id}/` : t.officialUrl })) });
write("en/ai", shell({
  title: `AI Tools Verified for the Korean Market — ${AI.tools.length} Entries | SEMOPL`,
  desc: "AI tools that actually work in Korean, verified: official English docs, Korean-support evidence links, and whether you can pay from abroad. Not a learning-app list.",
  canonical: `${SITE}/en/ai/`, ld: aiDirLd,
  body: `${MAIN}${NAV}
  <h1>AI Tools, Verified for the Korean Market</h1>
  <p>Searching for "AI tools with Korean support" returns language-learning apps; global directories list Korean in a dropdown without checking it.
  This page is different: <b>${AI.tools.length} tools a business can actually use in or for Korea</b> — Korean-made B2B tools and global tools whose Korean support we could verify in official documentation.
  Each entry shows what we checked and when. No paid placement.</p>
  <p><b>How to read the fields</b> — <i>Korean</i>: what the Korean support actually is, with an official evidence link · <i>English docs</i>: whether an English UI/manual exists ·
  <i>Payment from abroad</i>: <b>confirmed</b> only when the official site shows self-serve checkout usable outside Korea; <b>unknown</b> means we could not verify without signing up.</p>
  <h2>Guides</h2>
  <ul>${AI.guides.map((g) => `<li style="margin-bottom:8px"><a href="/web1/en/guide/${g.slug}/" style="color:#7C97FF;font-weight:700">${esc(g.title)}</a> — ${esc(g.desc)}</li>`).join("")}</ul>
  ${[...aiByCat.entries()].map(([cat, list]) => `
  <h2>${esc(aiCatLabel(cat))}</h2>
  <ul>${list.map((t) => `<li style="margin:0 0 16px">
    ${AI.profiles[t.id] ? `<a href="/web1/en/ai/${t.id}/" style="color:#7C97FF;font-weight:700">${esc(t.name)}</a>` : `<b>${esc(t.name)}</b>`}
    <small>(${t.origin === "korean" ? "Korean" : "global"})</small> — ${esc(t.blurb)}
    <br><small style="opacity:.8">${aiVerifyLine(t)} · <a href="${esc(t.officialUrl)}" rel="noopener" style="color:#7C97FF">official site →</a></small>
  </li>`).join("")}</ul>`).join("")}
  ${inquiryCta("AI & software")}
</main>` }));

/* /en/ai/<id>/ 프로필 — 영문 독립 리뷰 0건인 한국 B2B 도구의 유일한 영문 출처가 될 수 있음: 검증 사실만 */
for (const [pid, prof] of Object.entries(AI.profiles)) {
  const t = AI.tools.find((x) => x.id === pid);
  const ld = JSON.stringify({ "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [
    { "@type": "ListItem", position: 1, name: "SEMOPL (EN)", item: `${SITE}/en/` },
    { "@type": "ListItem", position: 2, name: "AI tools for Korea", item: `${SITE}/en/ai/` },
    { "@type": "ListItem", position: 3, name: t.name, item: `${SITE}/en/ai/${pid}/` }] });
  write(`en/ai/${pid}`, shell({
    title: `${t.name} — ${aiCatLabel(t.category)} | Korea AI Stack | SEMOPL`,
    desc: t.blurb.slice(0, 155),
    canonical: `${SITE}/en/ai/${pid}/`, ld,
    body: `${MAIN}${NAV}
    <p><a href="/web1/en/ai/" style="color:#7C97FF">AI tools for Korea</a> · ${esc(aiCatLabel(t.category))}${t.origin === "korean" ? " · Korean" : " · global"}</p>
    <h1>${esc(t.name)}</h1>
    <p>${esc(t.blurb)}</p>
    <p style="padding:12px 14px;border:1px solid #2a3350;border-radius:10px"><small>${aiVerifyLine(t)}</small></p>
    ${prof.sections.map((s) => `<h2>${esc(s.h)}</h2><p>${esc(s.body)}</p>`).join("")}
    <p><a href="${esc(t.officialUrl)}" rel="noopener" style="color:#7C97FF;font-weight:700">Official site →</a></p>
</main>` }));
}

/* AI 가이드 — gap 판정 질의 직격 4편 */
for (const g of AI.guides) {
  write(`en/guide/${g.slug}`, shell({
    title: `${g.title} | SEMOPL`, desc: g.desc.slice(0, 155),
    canonical: `${SITE}/en/guide/${g.slug}/`,
    body: `${MAIN}${NAV}
    <h1>${esc(g.title)}</h1>
    <p>${esc(g.intro)}</p>
    ${g.sections.map((s) => `<h2>${esc(s.h)}</h2><p>${esc(s.body)}</p>
      ${(s.toolIds ?? []).length ? `<p>Tools: ${s.toolIds.map(aiToolLink).filter(Boolean).join(" · ")}</p>` : ""}`).join("")}
    <p><b>Note:</b> ${esc(g.note)}</p>
    <p><a href="/web1/en/ai/" style="color:#7C97FF">See all verified AI tools for the Korean market →</a></p>
</main>` }));
}

/* ── /en/official-links/ — 공식 셀러·수수료 페이지 허브(수치는 원출처로만 안내한다는 약속의 제품화) ── */
const linked = enPlats.filter((p) => PF[p.id]?.links && (PF[p.id].links.seller || PF[p.id].links.fees));
const linkedByCat = new Map();
for (const p of linked) { const a = linkedByCat.get(p.category) ?? []; a.push(p); linkedByCat.set(p.category, a); }
write("en/official-links", shell({
  title: `Official Seller & Fee Pages of Korean Platforms — ${linked.length} Verified Links | SEMOPL`,
  desc: "Direct links to the official seller-registration and fee pages of Korean platforms — the pages that are always current, verified by hand.",
  canonical: `${SITE}/en/official-links/`,
  body: `${MAIN}${NAV}
  <h1>Official Seller &amp; Fee Pages, Verified</h1>
  <p>Fees and entry requirements change too often to republish — so instead we link you straight to the official pages.
  ${linked.length} platforms below have hand-verified links to their seller registration and/or fee pages. If a link goes stale,
  <a href="https://github.com/comdows/web1/issues/new?title=${encodeURIComponent("[EN] Stale official link")}" style="color:#7C97FF">report it</a>.</p>
  ${[...linkedByCat.entries()].map(([cat, list]) => `
  <h2>${esc(catEn(cat).name)}</h2>
  <ul>${list.map((p) => {
    const L = PF[p.id].links;
    return `<li style="margin:0 0 10px"><a href="/web1/en/p/${p.id}/" style="color:#7C97FF;font-weight:700">${esc(en(p.id).name)}</a> —
      ${L.seller ? `<a href="${esc(L.seller)}" rel="noopener" style="color:#7C97FF">seller page</a>` : ""}${L.seller && L.fees ? " · " : ""}${L.fees ? `<a href="${esc(L.fees)}" rel="noopener" style="color:#7C97FF">fee page</a>` : ""}
      <small style="opacity:.7">(verified ${esc(PF[p.id].lastVerified)})</small></li>`;
  }).join("")}</ul>`).join("")}
</main>` }));

/* ── /en/compare/<slug>/ — 비교 페이지(수수료·법률 축 금지, 구조 비교만) ── */
for (const c of COMPARE) {
  write(`en/compare/${c.slug}`, shell({
    title: `${c.title} | SEMOPL`, desc: c.desc.slice(0, 155),
    canonical: `${SITE}/en/compare/${c.slug}/`,
    body: `${MAIN}${NAV}
    <h1>${esc(c.title)}</h1>
    <p>${esc(c.intro)}</p>
    <div style="overflow-x:auto"><table style="border-collapse:collapse;width:100%">
      <tr><th style="text-align:left;padding:8px;border-bottom:1px solid #2a3350"></th>
          <th style="text-align:left;padding:8px;border-bottom:1px solid #2a3350">${esc(c.aName)}</th>
          <th style="text-align:left;padding:8px;border-bottom:1px solid #2a3350">${esc(c.bName)}</th></tr>
      ${c.rows.map((r) => `<tr>
        <td style="padding:8px;border-bottom:1px solid #1c2440;font-weight:700">${esc(r.aspect)}</td>
        <td style="padding:8px;border-bottom:1px solid #1c2440">${esc(r.a)}</td>
        <td style="padding:8px;border-bottom:1px solid #1c2440">${esc(r.b)}</td></tr>`).join("")}
    </table></div>
    <h2>Which one, when</h2>
    <p>${esc(c.verdict)}</p>
    <p><b>Note:</b> ${esc(c.note)} Fees and terms are not compared here — check the <a href="/web1/en/official-links/" style="color:#7C97FF">official pages</a>.</p>
</main>` }));
}

/* ── /en/all/ — A–Z 전체 색인(이름을 아는 방문자의 직행 경로 · 순수 HTML, 방화벽 무충돌) ── */
const azGroups = new Map();
for (const p of [...enPlats].sort((a, b) => en(a.id).name.localeCompare(en(b.id).name, "en"))) {
  const ch = en(p.id).name[0].toUpperCase();
  const key = /[A-Z]/.test(ch) ? ch : "#";
  const arr = azGroups.get(key) ?? []; arr.push(p); azGroups.set(key, arr);
}
write("en/all", shell({
  title: `All ${enPlats.length} Korean Platforms, A–Z | SEMOPL`,
  desc: `Alphabetical index of all ${enPlats.length} Korean commerce & trade platforms in this directory — find a platform by name.`,
  canonical: `${SITE}/en/all/`,
  body: `${MAIN}${NAV}
  <h1>All Platforms, A–Z</h1>
  <p>${enPlats.length} Korean commerce &amp; trade platforms. Know the name? Jump straight to it.
  Also see <a href="/web1/en/ai/" style="color:#7C97FF">AI tools verified for Korean</a>.</p>
  <p>${[...azGroups.keys()].map((k) => `<a href="#az-${k === "#" ? "etc" : k}" style="color:#7C97FF;margin-right:8px;font-weight:700">${k}</a>`).join("")}</p>
  ${[...azGroups.entries()].map(([k, list]) => `
  <h2 id="az-${k === "#" ? "etc" : k}">${esc(k)}</h2>
  <ul>${list.map((p) => `<li><a href="/web1/en/p/${p.id}/" style="color:#7C97FF">${esc(en(p.id).name)}</a> — ${esc(catEn(p.category).name)}</li>`).join("")}</ul>`).join("")}
</main>` }));

/* ── AI 인용 레이어: llms.txt + 공개 데이터셋(JSON) — DA 0에서 가장 유리한 전장 ──
 * KO 프리렌더가 먼저 쓴 한국어 섹션을 보존하고 뒤에 EN 디렉토리 섹션을 잇는다(overwrite 금지). */
const today0 = new Date().toISOString().slice(0, 10);
const koLlms = (() => { try { return fs.readFileSync(path.join(DIST, "llms.txt"), "utf8").trimEnd() + "\n\n---\n\n"; } catch { return ""; } })();
fs.writeFileSync(path.join(DIST, "llms.txt"), koLlms + [
  `# SEMOPL — Korean Business Platforms (English directory)`,
  ``,
  `> Neutral English directory of ${enPlats.length} Korean commerce & trade platforms in ${enCats.length} categories,`,
  `> each linked to its official site. No paid placement, no affiliate links, no consulting funnel.`,
  `> Fees and requirements are never republished — every entry links to the official source. Built ${today0}.`,
  ``,
  `## Pages`,
  `- ${SITE}/en/ : landing & category index`,
  `- ${SITE}/en/about/ : methodology & neutrality`,
  `- ${SITE}/en/partner-inquiry/ : free partner inquiry for businesses entering Korea`,
  `- ${SITE}/en/all/ : A-Z index of all platforms`,
  `- ${SITE}/en/official-links/ : verified official seller & fee pages`,
  ...COMPARE.map((c) => `- ${SITE}/en/compare/${c.slug}/ : comparison`),
  `- ${SITE}/en/ai/ : AI tools verified for the Korean market (${AI.tools.length} entries)`,
  ...Object.keys(GUIDES).map((g) => `- ${SITE}/en/guide/${g}/ : guide`),
  ...AI.guides.map((g) => `- ${SITE}/en/guide/${g.slug}/ : guide (AI for Korea)`),
  ...enCats.map((c) => `- ${SITE}/en/c/${c.id}/ : ${catEn(c.id).name} (${byCat.get(c.id).length} platforms)`),
  ``,
  `## Dataset`,
  `- ${SITE}/en/data/platforms.json : full machine-readable dataset (CC BY 4.0)`,
  `- ${SITE}/en/data/ai-stack.json : AI tools verified for Korean — machine-readable (CC BY 4.0)`,
  ``,
  `## AI tools verified for Korean`,
  ...AI.tools.map((t) => `- ${AI.profiles[t.id] ? `${SITE}/en/ai/${t.id}/` : t.officialUrl} : ${t.name} — ${t.blurb}`),
  ``,
  `## Platforms`,
  ...enPlats.map((p) => `- ${SITE}/en/p/${p.id}/ : ${en(p.id).name} — ${en(p.id).blurb}`),
].join("\n") + "\n");

fs.mkdirSync(path.join(DIST, "en/data"), { recursive: true });
fs.writeFileSync(path.join(DIST, "en/data/platforms.json"), JSON.stringify({
  meta: { title: "Korean commerce & trade platforms (SEMOPL English directory)", built: today0,
    license: `CC BY 4.0 — attribution: SEMOPL (${SITE.replace(/^https?:\/\//, "")}/en)`, count: enPlats.length,
    note: "Neutral directory. Fees/requirements intentionally omitted — see each official site." },
  platforms: enPlats.map((p) => ({ id: p.id, name: en(p.id).name, category: p.category,
    categoryName: catEn(p.category).name, region: p.region === "해외" ? "global" : "korea",
    blurb: en(p.id).blurb, officialUrl: p.url, page: `${SITE}/en/p/${p.id}/`,
    ...(PF[p.id] ? { profile: PF[p.id] } : {}) })),
}, null, 1));
fs.writeFileSync(path.join(DIST, "en/data/ai-stack.json"), JSON.stringify({
  meta: { title: "AI tools verified for the Korean market (SEMOPL)", built: today0,
    license: `CC BY 4.0 — attribution: SEMOPL (${SITE.replace(/^https?:\/\//, "")}/en/ai)`, count: AI.tools.length,
    note: "Fields verified against official sources on lastVerified date. Pricing intentionally omitted. paymentAbroad=unknown means not verifiable without signup." },
  tools: AI.tools.map((t) => ({ ...t, page: AI.profiles[t.id] ? `${SITE}/en/ai/${t.id}/` : null })),
}, null, 1));
fs.appendFileSync(path.join(DIST, "robots.txt"), `# AI crawlers: see ${SITE}/llms.txt\n`);

/* ── sitemap.xml에 EN URL 삽입 ── */
const smPath = path.join(DIST, "sitemap.xml");
const today = new Date().toISOString().slice(0, 10);
const enUrls = [`${SITE}/en/`, `${SITE}/en/about/`, `${SITE}/en/partner-inquiry/`, `${SITE}/en/ai/`, `${SITE}/en/all/`,
  `${SITE}/en/official-links/`, ...COMPARE.map((c) => `${SITE}/en/compare/${c.slug}/`),
  ...enCats.map((c) => `${SITE}/en/c/${c.id}/`),
  ...enPlats.map((p) => `${SITE}/en/p/${p.id}/`),
  ...Object.keys(GUIDES).map((s) => `${SITE}/en/guide/${s}/`),
  ...AI.guides.map((g) => `${SITE}/en/guide/${g.slug}/`),
  ...Object.keys(AI.profiles).map((id) => `${SITE}/en/ai/${id}/`)];
fs.writeFileSync(smPath, fs.readFileSync(smPath, "utf8").replace("</urlset>",
  enUrls.map((u) => `  <url><loc>${u}</loc><lastmod>${today}</lastmod></url>`).join("\n") + "\n</urlset>"));

/* 금지 링크 최종 검사: EN 표면에 제휴·거래소·약관 경로·가격 수치가 없어야 한다 */
const banned = /view=partners|view=exchange|view=value-check|view=deal-guide|view=terms|view=privacy|shopping mall|\$\s?\d|KRW|₩/i;
let bannedHit = 0;
const walk = (dir) => { for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
  const fp = path.join(dir, f.name);
  if (f.isDirectory()) walk(fp);
  else if (banned.test(fs.readFileSync(fp, "utf8"))) { bannedHit++; console.error(`  ✗ 금지 링크: ${fp}`); }
} };
walk(path.join(DIST, "en"));
if (bannedHit) process.exit(1);

fs.rmSync(path.join(DIST, "_template.html")); // 전달용 원본 템플릿 — 배포 산출물에서 제거

console.log(`EN 프리렌더 — 랜딩 1 + 허브 ${enCats.length} + 상세 ${enPlats.length} + 가이드 ${Object.keys(GUIDES).length + AI.guides.length} + AI(${AI.tools.length}도구·프로필 ${Object.keys(AI.profiles).length}) · sitemap +${enUrls.length} · 금지 링크 0`);
/* EN 커버리지 경고(Phase 3 진행 지표 — 완역 후 실패 어서션으로 전환 예정). 상세: node app/scripts/en-coverage.mjs */
{
  const gap = data.platforms.length - enPlats.length;
  if (gap > 0) console.log(`EN 커버리지 경고 — 미번역 ${gap}건(${enPlats.length}/${data.platforms.length}, ${(enPlats.length / data.platforms.length * 100).toFixed(1)}%) · 허브 인트로 ${Object.keys(INTROS).length}/${data.categories.length}`);
}
