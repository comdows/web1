/* 영문 정적 레이어(korea-gateway) — prerender.mjs 뒤에 실행(package.json build).
 * 외국 사업자용 "한국 진출 영문 디렉토리": /en/(랜딩) · /en/c/<분야>/ · /en/p/<플랫폼>/ · /en/guide/<slug>/.
 *
 * 법적 방화벽(전략위원회 판정): EN 페이지는 SPA 스크립트를 제거한 완전 정적 HTML이다 —
 * 제휴·거래소·가치진단·약관은 한국법 전제라 EN 표면에서 링크·노출 일절 금지(플래그가 아니라 스크립트 부재로 차단).
 * 데이터: platforms.en.json(검수된 commerce+trade 번역만) — 미번역 플랫폼은 EN에서 조용히 생략. */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const DIST = path.join(ROOT, "dist");
const SITE = "https://comdows.github.io/web1";

const data = JSON.parse(fs.readFileSync(path.join(ROOT, "src/data/platforms.json"), "utf8"));
const EN = JSON.parse(fs.readFileSync(path.join(ROOT, "src/data/platforms.en.json"), "utf8"));
const GUIDES = JSON.parse(fs.readFileSync(path.join(ROOT, "src/data/guides.en.json"), "utf8"));

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
if (errs.length) { errs.slice(0, 20).forEach((e) => console.error(`  ✗ ${e}`)); process.exit(1); }

const enPlats = data.platforms.filter((p) => EN.platforms[p.id]);
const byCat = new Map();
for (const p of enPlats) { const a = byCat.get(p.category) ?? []; a.push(p); byCat.set(p.category, a); }
const enCats = data.categories.filter((c) => (byCat.get(c.id) ?? []).length > 0);

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const en = (id) => EN.platforms[id];
const catEn = (id) => EN.categories[id] ?? { name: id, desc: "" };

/* SPA 부팅 차단: 모듈 스크립트·프리로드 제거 + lang 치환 — EN 방화벽의 핵심 */
const template = fs.readFileSync(path.join(DIST, "index.html"), "utf8")
  .replace(/<script type="module"[^>]*><\/script>\s*/g, "")
  .replace(/<link rel="modulepreload"[^>]*>\s*/g, "")
  .replace('lang="ko"', 'lang="en"');
if (/type="module"/.test(template)) { console.error("✗ EN 템플릿에 모듈 스크립트 잔존"); process.exit(1); }

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
  <ul>${Object.entries(GUIDES).map(([slug, g]) => `<li style="margin-bottom:10px"><a href="/web1/en/guide/${slug}/" style="color:#7C97FF;font-weight:700">${esc(g.title)}</a> — ${esc(g.desc)}</li>`).join("")}</ul>
  <h2>Browse by category</h2>
  <ul>${enCats.map((c) => `<li style="margin-bottom:8px"><a href="/web1/en/c/${c.id}/" style="color:#7C97FF;font-weight:700">${esc(catEn(c.id).name)}</a> (${byCat.get(c.id).length}) — ${esc(catEn(c.id).desc)}</li>`).join("")}</ul>
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

/* ── AI 인용 레이어: llms.txt + 공개 데이터셋(JSON) — DA 0에서 가장 유리한 전장 ── */
const today0 = new Date().toISOString().slice(0, 10);
fs.writeFileSync(path.join(DIST, "llms.txt"), [
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
  ...Object.keys(GUIDES).map((g) => `- ${SITE}/en/guide/${g}/ : guide`),
  ...enCats.map((c) => `- ${SITE}/en/c/${c.id}/ : ${catEn(c.id).name} (${byCat.get(c.id).length} platforms)`),
  ``,
  `## Dataset`,
  `- ${SITE}/en/data/platforms.json : full machine-readable dataset (CC BY 4.0)`,
  ``,
  `## Platforms`,
  ...enPlats.map((p) => `- ${SITE}/en/p/${p.id}/ : ${en(p.id).name} — ${en(p.id).blurb}`),
].join("\n") + "\n");

fs.mkdirSync(path.join(DIST, "en/data"), { recursive: true });
fs.writeFileSync(path.join(DIST, "en/data/platforms.json"), JSON.stringify({
  meta: { title: "Korean commerce & trade platforms (SEMOPL English directory)", built: today0,
    license: "CC BY 4.0 — attribution: SEMOPL (comdows.github.io/web1/en)", count: enPlats.length,
    note: "Neutral directory. Fees/requirements intentionally omitted — see each official site." },
  platforms: enPlats.map((p) => ({ id: p.id, name: en(p.id).name, category: p.category,
    categoryName: catEn(p.category).name, region: p.region === "해외" ? "global" : "korea",
    blurb: en(p.id).blurb, officialUrl: p.url, page: `${SITE}/en/p/${p.id}/` })),
}, null, 1));
fs.appendFileSync(path.join(DIST, "robots.txt"), `# AI crawlers: see ${SITE}/llms.txt\n`);

/* ── sitemap.xml에 EN URL 삽입 ── */
const smPath = path.join(DIST, "sitemap.xml");
const today = new Date().toISOString().slice(0, 10);
const enUrls = [`${SITE}/en/`, `${SITE}/en/about/`, `${SITE}/en/partner-inquiry/`,
  ...enCats.map((c) => `${SITE}/en/c/${c.id}/`),
  ...enPlats.map((p) => `${SITE}/en/p/${p.id}/`),
  ...Object.keys(GUIDES).map((s) => `${SITE}/en/guide/${s}/`)];
fs.writeFileSync(smPath, fs.readFileSync(smPath, "utf8").replace("</urlset>",
  enUrls.map((u) => `  <url><loc>${u}</loc><lastmod>${today}</lastmod></url>`).join("\n") + "\n</urlset>"));

/* 금지 링크 최종 검사: EN 표면에 제휴·거래소·약관 경로가 없어야 한다 */
const banned = /view=partners|view=exchange|view=value-check|view=deal-guide|view=terms|view=privacy|shopping mall/i;
let bannedHit = 0;
const walk = (dir) => { for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
  const fp = path.join(dir, f.name);
  if (f.isDirectory()) walk(fp);
  else if (banned.test(fs.readFileSync(fp, "utf8"))) { bannedHit++; console.error(`  ✗ 금지 링크: ${fp}`); }
} };
walk(path.join(DIST, "en"));
if (bannedHit) process.exit(1);

console.log(`EN 프리렌더 — 랜딩 1 + 허브 ${enCats.length} + 상세 ${enPlats.length} + 가이드 ${Object.keys(GUIDES).length} · sitemap +${enUrls.length} · 금지 링크 0`);
