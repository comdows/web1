/* SEO 프리렌더 — vite build 후 실행(package.json build 스크립트에 연결).
 * 1,637개 플랫폼 상세를 /p/<id>/index.html 정적 페이지로 생성한다:
 * 크롤러는 #root 안의 정적 콘텐츠(이름·설명·분야·링크)를 읽고,
 * 사람은 같은 페이지에서 SPA가 부팅되며 React가 #root를 상세 화면으로 교체한다
 * (App.tsx가 /p/<id> 경로를 detail 뷰로 해석). sitemap.xml·robots.txt도 함께 생성. */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const DIST = path.join(ROOT, "dist");
const SITE = "https://comdows.github.io/web1";

const data = JSON.parse(fs.readFileSync(path.join(ROOT, "src/data/platforms.json"), "utf8"));
const EN = JSON.parse(fs.readFileSync(path.join(ROOT, "src/data/platforms.en.json"), "utf8")); // 영어 쌍둥이 존재 판정(hreflang)
// 분야 허브 편집 인트로(한국어) — 검색 랜딩 본문. 없으면 목록만.
const HUB = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, "src/data/hub-intros.ko.json"), "utf8")); } catch { return {}; } })();
const template = fs.readFileSync(path.join(DIST, "index.html"), "utf8");
const catById = new Map(data.categories.map((c) => [c.id, c]));

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function pageFor(p) {
  const cat = catById.get(p.category);
  const title = `${p.name} — ${cat?.name ?? "플랫폼"} | 세모플`;
  const desc = `${p.name}: ${p.blurb} (${cat?.name ?? ""} · ${p.region})`.slice(0, 155);
  const canonical = `${SITE}/p/${p.id}/`;
  const similar = data.platforms.filter((x) => x.category === p.category && x.id !== p.id).slice(0, 8);

  const staticBody = `
<main style="max-width:720px;margin:32px auto;padding:0 20px">
  <p><a href="/web1/">세모플 — 세상의 모든 플랫폼</a> › <a href="/web1/?view=search&amp;q=${encodeURIComponent(cat?.name ?? "")}">${esc(cat?.icon ?? "")} ${esc(cat?.name ?? "")}</a></p>
  <h1>${esc(p.name)}</h1>
  <p>${esc(cat?.icon ?? "")} ${esc(cat?.name ?? "")} · ${esc(p.region)}${p.new ? " · 🆕 최근 등록" : ""}</p>
  <p>${esc(p.blurb)}</p>
  <ul>
    ${p.strength ? `<li>강점: ${esc(p.strength)}</li>` : ""}
    ${p.fee_text ? `<li>수수료(추정): ${esc(p.fee_text)}</li>` : ""}
    ${p.settle_text ? `<li>정산(추정): ${esc(p.settle_text)}</li>` : ""}
    ${p.enter_text ? `<li>입점 조건: ${esc(p.enter_text)}</li>` : ""}
    <li>공식 사이트: <a href="${esc(p.url)}" rel="noopener">${esc(p.url.replace(/^https?:\/\//, ""))}</a></li>
  </ul>
  ${similar.length ? `<h2>같은 분야의 다른 플랫폼</h2><ul>${similar.map((s) => `<li><a href="/web1/p/${s.id}/">${esc(s.name)}</a> — ${esc(s.blurb)}</li>`).join("")}</ul>` : ""}
  <p>세모플은 ${data.platforms.length.toLocaleString()}개 플랫폼·AI 도구를 같은 기준으로 정리한 B2B 디렉토리입니다. 수수료·정산 등은 공개 정보 기반 개략 추정치이며 공식 수치가 아닙니다 — 실제 조건은 공식 사이트에서 확인하세요.</p>
</main>`;

  return template
    .replace(/<title>[^<]*<\/title>/, `<title>${esc(title)}</title>`)
    .replace(/(<meta name="description" content=")[^"]*(")/, `$1${esc(desc)}$2`)
    .replace(/(<meta property="og:title" content=")[^"]*(")/, `$1${esc(title)}$2`)
    .replace(/(<meta property="og:description" content=")[^"]*(")/, `$1${esc(desc)}$2`)
    .replace(/(<meta property="og:url" content=")[^"]*(")/, `$1${canonical}$2`)
    .replace("</head>", `  <link rel="canonical" href="${canonical}">\n${EN.platforms[p.id] ? `  <link rel="alternate" hreflang="ko" href="${canonical}">\n  <link rel="alternate" hreflang="en" href="${SITE}/en/p/${p.id}/">\n  <link rel="alternate" hreflang="x-default" href="${canonical}">\n` : ""}  <script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [{ "@type": "ListItem", position: 1, name: "세모플", item: SITE + "/" }, { "@type": "ListItem", position: 2, name: cat?.name ?? "분야", item: `${SITE}/c/${p.category}/` }, { "@type": "ListItem", position: 3, name: p.name, item: canonical }] })}</script>\n  </head>`)
    .replace(/(<div id="root">)(<\/div>)/, `$1${staticBody}$2`);
}

/* 분야 허브 /c/<id>/ — "OO 플랫폼 목록" 롱테일 검색 랜딩 (ItemList JSON-LD) */
function catPage(c) {
  const list = data.platforms.filter((p) => p.category === c.id);
  const title = `${c.name} 플랫폼 ${list.length}곳 — 목록·비교 | 세모플`;
  // 인트로 첫 문장을 검색 스니펫으로(있으면) — 목록 나열보다 클릭 유도가 큼
  const introLede = HUB[c.id]?.intro?.split(/\n\n+/)[0]?.replace(/\s+/g, " ").trim();
  const desc = (introLede
    ? `${introLede}`
    : `${c.desc}. ${c.name} 분야 플랫폼 ${list.length}곳을 같은 기준으로 정리 — ${list.slice(0, 5).map((p) => p.name).join(", ")} 등.`).slice(0, 155);
  const canonical = `${SITE}/c/${c.id}/`;
  const hub = HUB[c.id];
  const lds = [{
    "@context": "https://schema.org", "@type": "ItemList", name: title,
    numberOfItems: list.length,
    itemListElement: list.slice(0, 30).map((p, i) => ({ "@type": "ListItem", position: i + 1, name: p.name, url: `${SITE}/p/${p.id}/` })),
  }];
  // FAQPage — 인트로에 선택 기준(pickBy)이 있을 때만(사실 기반 Q&A, 날조 금지). 리치 결과 후보.
  if (hub?.pickBy?.length) {
    lds.push({
      "@context": "https://schema.org", "@type": "FAQPage",
      mainEntity: [
        { "@type": "Question", name: `${c.name} 플랫폼을 고를 때 무엇을 봐야 하나요?`,
          acceptedAnswer: { "@type": "Answer", text: hub.pickBy.join(" · ") } },
        { "@type": "Question", name: `${c.name} 분야에는 어떤 플랫폼이 있나요?`,
          acceptedAnswer: { "@type": "Answer", text: `${list.slice(0, 8).map((p) => p.name).join(", ")} 등 ${list.length}곳을 세모플에서 같은 기준으로 비교할 수 있습니다.` } },
      ],
    });
  }
  const ld = JSON.stringify(lds.length === 1 ? lds[0] : lds);
  const introHtml = hub
    ? hub.intro.split(/\n\n+/).map((para) => `<p>${esc(para)}</p>`).join("") +
      (hub.pickBy?.length ? `<h2>고를 때 따져볼 기준</h2><ul>${hub.pickBy.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>` : "")
    : `<p>${esc(c.desc)} — 같은 기준으로 정리했습니다.</p>`;
  const body = `
<main style="max-width:720px;margin:32px auto;padding:0 20px">
  <p><a href="/web1/">세모플 — 세상의 모든 플랫폼</a></p>
  <h1>${esc(c.icon)} ${esc(c.name)} 플랫폼 ${list.length}곳</h1>
  ${introHtml}
  <h2>${esc(c.name)} 플랫폼 목록</h2>
  <ul>${list.map((p) => `<li><a href="/web1/p/${p.id}/">${esc(p.name)}</a>${p.region === "해외" ? " (해외)" : ""} — ${esc(p.blurb)}</li>`).join("")}</ul>
</main>`;
  return template
    .replace(/<title>[^<]*<\/title>/, `<title>${esc(title)}</title>`)
    .replace(/(<meta name="description" content=")[^"]*(")/, `$1${esc(desc)}$2`)
    .replace(/(<meta property="og:title" content=")[^"]*(")/, `$1${esc(title)}$2`)
    .replace(/(<meta property="og:description" content=")[^"]*(")/, `$1${esc(desc)}$2`)
    .replace(/(<meta property="og:url" content=")[^"]*(")/, `$1${canonical}$2`)
    .replace("</head>", `  <link rel="canonical" href="${canonical}">\n  <script type="application/ld+json">${ld}</script>\n  </head>`)
    .replace(/(<div id="root">)(<\/div>)/, `$1${body}$2`);
}
let catCount = 0;
for (const c of data.categories) {
  const dir = path.join(DIST, "c", c.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "index.html"), catPage(c));
  catCount++;
}

let count = 0;
for (const p of data.platforms) {
  const dir = path.join(DIST, "p", p.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "index.html"), pageFor(p));
  count++;
}

/* 원본 템플릿을 prerender-en.mjs에 전달 — 아래에서 루트 index.html을 재작성하면
 * #root가 더 이상 비어 있지 않아 EN 셸의 치환 정규식이 조용히 실패한다.
 * EN 스크립트가 이 파일을 읽고 마지막에 삭제한다(배포 산출물에 남지 않음). */
fs.writeFileSync(path.join(DIST, "_template.html"), template);

/* 루트 index.html 재작성 — 크롤러가 보는 홈이 빈 <div id="root">였다(내부 링크 2,300+개의 종착지가 공백).
 * /p/ 페이지와 동일 패턴: 정적 콘텐츠를 #root에 넣고, 사람에겐 SPA가 부팅되며 교체된다. */
const homeBody = `
<main style="max-width:720px;margin:32px auto;padding:0 20px">
  <h1>세모플 — 세상의 모든 플랫폼</h1>
  <p>${data.platforms.length.toLocaleString()}개 한국 비즈니스 플랫폼·AI 도구를 ${data.categories.length}개 분야, 같은 기준으로 정리한 B2B 디렉토리입니다.
  사업자가 입점·판매·홍보·소싱할 곳을 찾고, 플랫폼끼리 제휴하고, 사업을 넘길 곳을 만나는 인프라입니다.</p>
  <h2>분야별 플랫폼 목록</h2>
  <ul>${data.categories.map((c) => `<li><a href="/web1/c/${c.id}/">${esc(c.icon)} ${esc(c.name)}</a> — ${esc(c.desc)}</li>`).join("")}</ul>
  <p><a href="/web1/?view=partners">제휴 매칭</a> · <a href="/web1/?view=exchange">플랫폼 거래소</a> · <a href="/web1/?view=ai-finder">AI 도구 찾기</a> · <a href="/web1/en/">English directory</a></p>
</main>`;
// 홈 구조화 데이터 — 브랜드 지식패널·사이트링크 검색창 후보(Organization + WebSite) + Dataset(공개 데이터셋)
const homeLd = JSON.stringify([
  { "@context": "https://schema.org", "@type": "Organization", name: "세모플", alternateName: "SEMOPL",
    url: `${SITE}/`, description: "한국 비즈니스 플랫폼·AI 도구를 같은 기준으로 정리한 B2B 디렉토리" },
  { "@context": "https://schema.org", "@type": "WebSite", name: "세모플 — 세상의 모든 플랫폼", url: `${SITE}/`,
    potentialAction: { "@type": "SearchAction", target: { "@type": "EntryPoint", urlTemplate: `${SITE}/?view=search&q={query}` }, "query-input": "required name=query" } },
  { "@context": "https://schema.org", "@type": "Dataset", name: "세모플 플랫폼·AI 도구 디렉토리 데이터셋",
    description: "한국 비즈니스 플랫폼·AI 도구 목록(분야·지역·개략 정보). 기계 판독용 공개 데이터.",
    license: "https://creativecommons.org/licenses/by/4.0/", creator: { "@type": "Organization", name: "세모플" },
    distribution: [
      { "@type": "DataDownload", encodingFormat: "application/json", contentUrl: `${SITE}/en/data/platforms.json` },
      { "@type": "DataDownload", encodingFormat: "application/json", contentUrl: `${SITE}/en/data/ai-stack.json` },
    ] },
]);
fs.writeFileSync(path.join(DIST, "index.html"), template
  .replace("</head>", `  <link rel="canonical" href="${SITE}/">\n  <link rel="alternate" type="application/rss+xml" title="세모플 새 플랫폼" href="${SITE}/feed.xml">\n  <script type="application/ld+json">${homeLd}</script>\n  </head>`)
  .replace(/(<div id="root">)(<\/div>)/, `$1${homeBody}$2`));

/* 404.html — GitHub Pages가 미존재 경로에 서빙(삭제된 /p/ 등). 브랜드 안내 + 복귀 경로 + SPA 부팅 유지 */
const nfBody = `
<main style="max-width:720px;margin:32px auto;padding:0 20px">
  <h1>페이지를 찾을 수 없어요</h1>
  <p>주소가 바뀌었거나 삭제된 페이지예요. 찾으시던 플랫폼은 검색으로 다시 찾을 수 있습니다.</p>
  <p><a href="/web1/">← 세모플 홈</a> · <a href="/web1/?view=search">플랫폼 검색</a></p>
  <h2>분야로 찾기</h2>
  <ul>${data.categories.slice(0, 12).map((c) => `<li><a href="/web1/c/${c.id}/">${esc(c.icon)} ${esc(c.name)}</a></li>`).join("")}</ul>
</main>`;
fs.writeFileSync(path.join(DIST, "404.html"), template
  .replace(/<title>[^<]*<\/title>/, `<title>페이지를 찾을 수 없어요 | 세모플</title>`)
  .replace(/(<meta name="description" content=")[^"]*(")/, `$1주소가 바뀌었거나 삭제된 페이지 — 세모플에서 다시 찾아보세요.$2`)
  .replace("</head>", `  <meta name="robots" content="noindex">\n  </head>`)
  .replace(/(<div id="root">)(<\/div>)/, `$1${nfBody}$2`));

/* 사이트맵 + robots.
 * lastmod: 정적 데이터엔 플랫폼별 갱신시각이 없다 → 매 빌드 전 URL을 today로 찍으면 "전체가 바뀐 것"처럼
 * 보여 크롤 신뢰도가 떨어진다. 목록이 실제로 커지는 홈·허브·동적 뷰와 신규(new) 상세만 today, 안정 상세는 lastmod 생략. */
const today = new Date().toISOString().slice(0, 10);
const staticUrls = ["", "?view=partners", "?view=exchange", "?view=ai-finder", "?view=packs", "?view=weekly", "?view=onboarding", "?view=deal-guide", "?view=value-check"];
const urls = [
  ...staticUrls.map((u) => ({ loc: `${SITE}/${u}`, lastmod: today })),
  ...data.categories.map((c) => ({ loc: `${SITE}/c/${c.id}/`, lastmod: today })),
  ...data.platforms.map((p) => ({ loc: `${SITE}/p/${p.id}/`, lastmod: p.new ? today : null })),
];
fs.writeFileSync(path.join(DIST, "sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
  urls.map((u) => `  <url><loc>${u.loc.replace(/&/g, "&amp;")}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ""}</url>`).join("\n") +
  `\n</urlset>\n`);
fs.writeFileSync(path.join(DIST, "robots.txt"), `User-agent: *\nAllow: /\nSitemap: ${SITE}/sitemap.xml\n`);

/* 신규 등재 RSS 2.0 피드 — 재크롤 신호 + 구독 유입. 정적 데이터엔 등재일이 없어 new 표식을 최신 프록시로. */
const feedItems = data.platforms.filter((p) => p.new).slice(0, 50);
const feedList = feedItems.length ? feedItems : data.platforms.slice(0, 50);
const nowUtc = new Date().toUTCString();
const feedXml = `<?xml version="1.0" encoding="UTF-8"?>\n` +
  `<rss version="2.0"><channel>\n` +
  `<title>세모플 — 새로 등재된 플랫폼·AI 도구</title>\n` +
  `<link>${SITE}/?view=weekly</link>\n` +
  `<description>세모플에 새로 추가된 한국 비즈니스 플랫폼·AI 도구</description>\n` +
  `<language>ko</language>\n<lastBuildDate>${nowUtc}</lastBuildDate>\n` +
  `<atom:link xmlns:atom="http://www.w3.org/2005/Atom" href="${SITE}/feed.xml" rel="self" type="application/rss+xml"/>\n` +
  feedList.map((p) => {
    const cat = catById.get(p.category);
    return `<item><title>${esc(p.name)}</title><link>${SITE}/p/${p.id}/</link>` +
      `<guid isPermaLink="true">${SITE}/p/${p.id}/</guid>` +
      `<description>${esc(`${p.blurb} (${cat?.name ?? ""} · ${p.region})`)}</description>` +
      `${cat ? `<category>${esc(cat.name)}</category>` : ""}<pubDate>${nowUtc}</pubDate></item>`;
  }).join("\n") +
  `\n</channel></rss>\n`;
fs.writeFileSync(path.join(DIST, "feed.xml"), feedXml);

console.log(`프리렌더 상세 ${count}p + 분야 허브 ${catCount}p + sitemap(${urls.length} URL) + feed.xml(${feedList.length}) + robots.txt 생성`);
