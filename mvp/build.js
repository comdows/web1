#!/usr/bin/env node
/*
 * build.js — 디렉토리 프리렌더 (프레임워크 없음, 순수 Node)
 * ─────────────────────────────────────────────────────────────
 * platforms.js 단일 소스로부터:
 *   1) 데이터 검증(필수 필드) — 실패 시 빌드 중단
 *   2) /c/{category}.html — 분야별 목록 페이지(색인 가능, 본문에 플랫폼·설명 포함, JSON-LD ItemList)
 *   3) sitemap.xml, robots.txt
 * 실행:  node build.js   (mvp/ 디렉터리에서)
 */
const fs = require("fs");
const path = require("path");
const CFG = require("./data/platforms.js");

const ROOT = __dirname;
const SITE = "https://platformall.example"; // 실제 도메인으로 교체
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ── 1) 검증 ──
function validate(cats, platforms) {
  const errors = [];
  const catIds = new Set(cats.map((c) => c.id));
  for (const p of platforms) {
    for (const f of ["id", "name", "category", "blurb", "url"]) if (!p[f]) errors.push(`[${p.id || "?"}] ${f} 누락`);
    if (p.category && !catIds.has(p.category)) errors.push(`[${p.id}] 알 수 없는 category: ${p.category}`);
  }
  if (errors.length) { console.error("❌ 검증 실패:\n" + errors.map((e) => "  - " + e).join("\n")); process.exit(1); }
  console.log(`✅ 검증 통과 (분야 ${cats.length}, 플랫폼 ${platforms.length})`);
}

function shell({ title, desc, canonical, jsonld, body, depth }) {
  const asset = depth ? "../assets" : "assets";
  const home = depth ? "../index.html" : "index.html";
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta name="robots" content="index,follow">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${esc(canonical)}">
<link rel="stylesheet" href="${asset}/style.css">
${jsonld ? `<script type="application/ld+json">${JSON.stringify(jsonld)}</script>` : ""}
</head>
<body>
<header class="site"><div class="container">
  <div class="logo">플랫폼<b>올</b></div>
  <nav class="top"><a href="${home}">분야별 플랫폼</a></nav>
</div></header>
<main class="container">${body}</main>
<footer class="site"><div class="container">
  플랫폼올 (가칭) · 분야별 플랫폼 디렉토리 · 개략 설명이며 상세는 공식 사이트 확인.
</div></footer>
</body>
</html>`;
}

function categoryPage(cat, platforms) {
  const list = platforms.filter((p) => p.category === cat.id);
  const title = `${cat.name} 플랫폼 총정리 (${list.length}곳) | 플랫폼올`;
  const desc = `${cat.name} — ${cat.desc}. ${list.map((p) => p.name).join(", ")} 등 ${list.length}개 플랫폼을 개략 설명과 함께 정리했습니다.`;
  const canonical = `${SITE}/c/${cat.id}.html`;
  const jsonld = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    "name": `${cat.name} 플랫폼`,
    "itemListElement": list.map((p, i) => ({
      "@type": "ListItem", "position": i + 1, "name": p.name, "url": p.url, "description": p.blurb,
    })),
  };
  const body = `
    <nav class="sub" style="margin-top:20px"><a href="../index.html">분야별 플랫폼</a> › ${esc(cat.name)}</nav>
    <h1>${esc(cat.icon)} ${esc(cat.name)} 플랫폼</h1>
    <p class="sub">${esc(cat.desc)} · 총 ${list.length}곳 (개략 설명)</p>
    <div class="plist">
      ${list.map((p) => `<div class="pcard">
        <div class="row"><h3>${esc(p.name)}${p.new ? '<span class="new-tag">NEW</span>' : ''}</h3><span class="chip">${esc(p.region)}</span></div>
        <p class="blurb">${esc(p.blurb)}</p>
        <a class="btn ghost" style="align-self:flex-start;padding:6px 10px;font-size:12px" href="${esc(p.url)}" target="_blank" rel="nofollow noopener">공식 사이트 ↗</a>
      </div>`).join("")}
    </div>
    <p class="sub" style="margin-top:20px"><a href="../index.html">← 전체 분야 보기</a></p>`;
  return shell({ title, desc, canonical, jsonld, body, depth: true });
}

// ── 실행 ──
const cats = CFG.categories, platforms = CFG.platforms;
validate(cats, platforms);

const cDir = path.join(ROOT, "c");
fs.mkdirSync(cDir, { recursive: true });
const urls = [`${SITE}/index.html`];
for (const cat of cats) {
  fs.writeFileSync(path.join(cDir, `${cat.id}.html`), categoryPage(cat, platforms));
  urls.push(`${SITE}/c/${cat.id}.html`);
}

fs.writeFileSync(path.join(ROOT, "sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
  urls.map((u) => `  <url><loc>${esc(u)}</loc></url>`).join("\n") + `\n</urlset>`);
fs.writeFileSync(path.join(ROOT, "robots.txt"), `User-agent: *\nAllow: /\nSitemap: ${SITE}/sitemap.xml\n`);

console.log(`✅ 프리렌더 완료: 분야 페이지 ${cats.length}개, sitemap ${urls.length}개 URL → c/, sitemap.xml, robots.txt`);
