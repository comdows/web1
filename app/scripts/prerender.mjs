/* SEO 프리렌더 — vite build 후 실행(package.json build 스크립트에 연결).
 * 전체 플랫폼(현재 1,719개) 상세를 /p/<id>/index.html 정적 페이지로 생성한다:
 * 크롤러는 #root 안의 정적 콘텐츠(이름·설명·분야·링크)를 읽고,
 * 사람은 같은 페이지에서 SPA가 부팅되며 React가 #root를 상세 화면으로 교체한다
 * (App.tsx가 /p/<id> 경로를 detail 뷰로 해석). sitemap.xml·robots.txt도 함께 생성. */
import fs from "node:fs";
import path from "node:path";

import { SITE_URL, SITE_BASE, CUSTOM_DOMAIN } from "../site.config.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const DIST = path.join(ROOT, "dist");
const SITE = SITE_URL;          // canonical·sitemap·og 접두어(끝 슬래시 없음)
const BASE = SITE_BASE;         // 정적 본문 내부 링크 접두어(끝 슬래시 포함)

const data = JSON.parse(fs.readFileSync(path.join(ROOT, "src/data/platforms.json"), "utf8"));
const EN = JSON.parse(fs.readFileSync(path.join(ROOT, "src/data/platforms.en.json"), "utf8")); // 영어 쌍둥이 존재 판정(hreflang)
// 분야 허브 편집 인트로(한국어) — 검색 랜딩 본문. 없으면 목록만.
const HUB = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, "src/data/hub-intros.ko.json"), "utf8")); } catch { return {}; } })();
// 편집 가이드(로드맵 v2 Phase 4 — /guide/<slug>/ 정적 페이지). 없으면 가이드 표면만 생략.
const ARTICLES = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, "src/data/articles.ko.json"), "utf8")); } catch { return {}; } })();
// 가이드 참조 무결성 — 미존재 분야·플랫폼 id 참조는 빌드 실패(EN 생성기 검증 패턴)
{
  const pids = new Set(data.platforms.map((p) => p.id));
  const cids = new Set(data.categories.map((c) => c.id));
  const errs = [];
  for (const [slug, a] of Object.entries(ARTICLES)) {
    if (!/^[a-z0-9-]+$/.test(slug)) errs.push(`가이드 slug 형식 오류: ${slug}`);
    if (!a.title?.trim() || !a.desc?.trim() || !a.sections?.length) errs.push(`가이드 필수 필드 누락: ${slug}`);
    if (!cids.has(a.category)) errs.push(`가이드가 없는 분야 참조: ${slug} → ${a.category}`);
    for (const r of a.related ?? []) if (!pids.has(r)) errs.push(`가이드의 미등재 플랫폼 참조: ${slug} → ${r}`);
  }
  if (errs.length) { console.error("가이드 데이터 오류:\n" + errs.map((e) => `  - ${e}`).join("\n")); process.exit(1); }
}
/* 템플릿 로드 시 og:url·og:image를 설정 도메인으로 일괄 정규화 —
 * index.html 원본의 절대 URL이 어떤 산출물에도 그대로 새지 않게(서브페이지 og:image 포함). */
const template = fs.readFileSync(path.join(DIST, "index.html"), "utf8")
  .replace(/(<meta property="og:url" content=")[^"]*(")/, `$1${SITE}/$2`)
  .replace(/(<meta property="og:image" content=")[^"]*(")/, `$1${SITE}/og-card.png$2`);
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
  <p><a href="${BASE}">세모플 — 세상의 모든 플랫폼</a> › <a href="${BASE}?view=search&amp;q=${encodeURIComponent(cat?.name ?? "")}">${esc(cat?.icon ?? "")} ${esc(cat?.name ?? "")}</a></p>
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
  ${similar.length ? `<h2>같은 분야의 다른 플랫폼</h2><ul>${similar.map((s) => `<li><a href="${BASE}p/${s.id}/">${esc(s.name)}</a> — ${esc(s.blurb)}</li>`).join("")}</ul>` : ""}
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
function catPage(c, hasCompare) {
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
  <p><a href="${BASE}">세모플 — 세상의 모든 플랫폼</a></p>
  <h1>${esc(c.icon)} ${esc(c.name)} 플랫폼 ${list.length}곳</h1>
  ${hasCompare ? `<p><a href="${BASE}c/${c.id}/compare/">📊 ${esc(c.name)} 비교표 — 수수료·정산·입점 조건 한눈에 →</a></p>` : ""}
  ${Object.entries(ARTICLES).filter(([, a]) => a.category === c.id).map(([slug, a]) => `<p><a href="${BASE}guide/${slug}/">📖 가이드: ${esc(a.title)} →</a></p>`).join("")}
  ${introHtml}
  <h2>${esc(c.name)} 플랫폼 목록</h2>
  <ul>${list.map((p) => `<li><a href="${BASE}p/${p.id}/">${esc(p.name)}</a>${p.region === "해외" ? " (해외)" : ""} — ${esc(p.blurb)}</li>`).join("")}</ul>
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
/* 분야 비교 페이지 /c/<id>/compare/ — 판단 필드(0014·1,637건)를 표로 재사용한 롱테일 랜딩.
 * 순위가 아니라 "비교"다: 가나다순 고정·기준 명시(디렉토리 중립 원칙 — 유료 개입 없음). */
const FEE_KO = { low: "낮음", mid: "중간", high: "높음" };
const compareList = (c) => data.platforms
  .filter((p) => p.category === c.id && (p.fee_band || p.fee_text || p.settle_text || p.enter_text || p.strength))
  .sort((a, b) => a.name.localeCompare(b.name, "ko"));
function comparePage(c, list) {
  const title = `${c.name} 플랫폼 비교 — 수수료·정산·입점 조건 | 세모플`;
  const introLede = HUB[c.id]?.intro?.split(/\n\n+/)[0]?.replace(/\s+/g, " ").trim();
  const desc = `${c.name} 플랫폼 ${list.length}곳의 수수료대·정산 주기·입점 조건·강점을 한 표로 비교(공개 정보 기반 추정 · 가나다순).`.slice(0, 155);
  const canonical = `${SITE}/c/${c.id}/compare/`;
  const ld = JSON.stringify({
    "@context": "https://schema.org", "@type": "ItemList", name: title, numberOfItems: list.length,
    itemListElement: list.slice(0, 30).map((p, i) => ({ "@type": "ListItem", position: i + 1, name: p.name, url: `${SITE}/p/${p.id}/` })),
  });
  const rows = list.map((p) =>
    `<tr><td><a href="${BASE}p/${p.id}/">${esc(p.name)}</a></td>` +
    `<td>${p.fee_band ? esc(FEE_KO[p.fee_band] ?? p.fee_band) : "—"}${p.fee_text ? `<br><small>${esc(p.fee_text)}</small>` : ""}</td>` +
    `<td>${esc(p.settle_text || "—")}</td><td>${esc(p.enter_text || "—")}</td><td>${esc(p.strength || "—")}</td></tr>`).join("\n");
  const pickBy = HUB[c.id]?.pickBy;
  const body = `
<main style="max-width:920px;margin:32px auto;padding:0 20px">
  <p><a href="${BASE}">세모플</a> › <a href="${BASE}c/${c.id}/">${esc(c.icon)} ${esc(c.name)}</a> › 비교</p>
  <h1>${esc(c.name)} 플랫폼 비교 — 수수료·정산·입점 조건</h1>
  ${introLede ? `<p>${esc(introLede)}</p>` : `<p>${esc(c.desc)}</p>`}
  <p>아래 표는 ${esc(c.name)} 분야 플랫폼 ${list.length}곳을 <strong>가나다순</strong>으로 정리한 것입니다(순위·추천순 아님).
  수수료·정산·입점 조건은 공개 정보를 바탕으로 한 세모플의 <strong>개략 추정치</strong>이며 공식 수치가 아닙니다 — 실제 값은 각 공식 사이트에서 확인하세요.</p>
  <div style="overflow-x:auto"><table border="1" cellpadding="6" style="border-collapse:collapse;font-size:14px">
    <thead><tr><th>플랫폼</th><th>수수료대(추정)</th><th>정산 주기(추정)</th><th>입점 조건</th><th>강점</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>
  ${pickBy?.length ? `<h2>고를 때 따져볼 기준</h2><ul>${pickBy.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>` : ""}
  <p><a href="${BASE}c/${c.id}/">${esc(c.name)} 전체 목록 →</a> · <a href="${BASE}?view=compare">직접 골라 비교하기 →</a> · <a href="${BASE}">세모플 홈</a></p>
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
let cmpCount = 0;
const cmpIds = new Set(); // sitemap·허브 링크용 — 비교표가 실제 생성된 분야만
for (const c of data.categories) {
  const dir = path.join(DIST, "c", c.id);
  fs.mkdirSync(dir, { recursive: true });
  const cl = compareList(c);
  const hasCompare = cl.length >= 3; // 3곳 미만이면 "비교"가 성립 안 함 — 얇은 페이지 방지
  fs.writeFileSync(path.join(dir, "index.html"), catPage(c, hasCompare));
  catCount++;
  if (hasCompare) {
    const cdir = path.join(dir, "compare");
    fs.mkdirSync(cdir, { recursive: true });
    fs.writeFileSync(path.join(cdir, "index.html"), comparePage(c, cl));
    cmpIds.add(c.id);
    cmpCount++;
  }
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
  <ul>${data.categories.map((c) => `<li><a href="${BASE}c/${c.id}/">${esc(c.icon)} ${esc(c.name)}</a> — ${esc(c.desc)}</li>`).join("")}</ul>
  <p><a href="${BASE}?view=partners">제휴 매칭</a> · <a href="${BASE}?view=exchange">플랫폼 거래소</a> · <a href="${BASE}?view=ai-finder">AI 도구 찾기</a> · <a href="${BASE}en/">English directory</a></p>
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
  .replace(/(<meta property="og:url" content=")[^"]*(")/, `$1${SITE}/$2`)
  .replace(/(<meta property="og:image" content=")[^"]*(")/, `$1${SITE}/og-card.png$2`)
  .replace("</head>", `  <link rel="canonical" href="${SITE}/">\n  <link rel="alternate" type="application/rss+xml" title="세모플 새 플랫폼" href="${SITE}/feed.xml">\n  <script type="application/ld+json">${homeLd}</script>\n  </head>`)
  .replace(/(<div id="root">)(<\/div>)/, `$1${homeBody}$2`));

/* 404.html — GitHub Pages가 미존재 경로에 서빙(삭제된 /p/ 등). 브랜드 안내 + 복귀 경로 + SPA 부팅 유지 */
const nfBody = `
<main style="max-width:720px;margin:32px auto;padding:0 20px">
  <h1>페이지를 찾을 수 없어요</h1>
  <p>주소가 바뀌었거나 삭제된 페이지예요. 찾으시던 플랫폼은 검색으로 다시 찾을 수 있습니다.</p>
  <p><a href="${BASE}">← 세모플 홈</a> · <a href="${BASE}?view=search">플랫폼 검색</a></p>
  <h2>분야로 찾기</h2>
  <ul>${data.categories.slice(0, 12).map((c) => `<li><a href="${BASE}c/${c.id}/">${esc(c.icon)} ${esc(c.name)}</a></li>`).join("")}</ul>
</main>`;
fs.writeFileSync(path.join(DIST, "404.html"), template
  .replace(/<title>[^<]*<\/title>/, `<title>페이지를 찾을 수 없어요 | 세모플</title>`)
  .replace(/(<meta name="description" content=")[^"]*(")/, `$1주소가 바뀌었거나 삭제된 페이지 — 세모플에서 다시 찾아보세요.$2`)
  .replace("</head>", `  <meta name="robots" content="noindex">\n  </head>`)
  .replace(/(<div id="root">)(<\/div>)/, `$1${nfBody}$2`));

/* 편집 가이드 /guide/<slug>/ — 분야 트렌드·비교 축 아티클(로드맵 v2 Phase 4).
 * 크롤러는 정적 본문을, 사람은 SPA guide 뷰(App.tsx가 경로 해석)를 본다. 디렉토리 중립:
 * 특정 플랫폼 추천이 아니라 "비교 축" 서술 — 고지문 포함. */
let guideCount = 0;
for (const [slug, a] of Object.entries(ARTICLES)) {
  const cat = catById.get(a.category);
  const title = `${a.title} | 세모플`;
  const canonical = `${SITE}/guide/${slug}/`;
  const relTitles = (a.related ?? []).map((id) => data.platforms.find((p) => p.id === id)).filter(Boolean);
  const ld = JSON.stringify([
    { "@context": "https://schema.org", "@type": "Article", headline: a.title, description: a.desc,
      datePublished: a.date, dateModified: a.date, inLanguage: "ko",
      author: { "@type": "Organization", name: "세모플" }, publisher: { "@type": "Organization", name: "세모플" },
      mainEntityOfPage: canonical },
    { "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [
      { "@type": "ListItem", position: 1, name: "세모플", item: `${SITE}/` },
      { "@type": "ListItem", position: 2, name: cat?.name ?? "분야", item: `${SITE}/c/${a.category}/` },
      { "@type": "ListItem", position: 3, name: a.title, item: canonical }] },
  ]);
  const body = `
<main style="max-width:720px;margin:32px auto;padding:0 20px">
  <p><a href="${BASE}">세모플 — 세상의 모든 플랫폼</a> › <a href="${BASE}c/${a.category}/">${esc(cat?.icon ?? "")} ${esc(cat?.name ?? "")}</a></p>
  <h1>${esc(a.title)}</h1>
  <p>${esc(a.date)} · 세모플 가이드</p>
  <p>${esc(a.desc)}</p>
  ${a.sections.map((s) => `<h2>${esc(s.h)}</h2><p>${esc(s.b)}</p>`).join("")}
  ${relTitles.length ? `<h2>이 글에서 함께 볼 플랫폼</h2><ul>${relTitles.map((p) => `<li><a href="${BASE}p/${p.id}/">${esc(p.name)}</a> — ${esc(p.blurb)}</li>`).join("")}</ul>` : ""}
  <p><a href="${BASE}c/${a.category}/">${esc(cat?.name ?? "")} 플랫폼 전체 보기 →</a></p>
  <p>이 가이드는 공개 정보를 바탕으로 한 일반적 안내이며 특정 플랫폼의 공식 조건·추천이 아닙니다. 요율·정책은 수시로 바뀌므로 실제 조건은 각 공식 사이트에서 확인하세요.</p>
</main>`;
  const dir = path.join(DIST, "guide", slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "index.html"), template
    .replace(/<title>[^<]*<\/title>/, `<title>${esc(title)}</title>`)
    .replace(/(<meta name="description" content=")[^"]*(")/, `$1${esc(a.desc.slice(0, 155))}$2`)
    .replace(/(<meta property="og:title" content=")[^"]*(")/, `$1${esc(title)}$2`)
    .replace(/(<meta property="og:description" content=")[^"]*(")/, `$1${esc(a.desc.slice(0, 155))}$2`)
    .replace(/(<meta property="og:url" content=")[^"]*(")/, `$1${canonical}$2`)
    .replace("</head>", `  <link rel="canonical" href="${canonical}">\n  <script type="application/ld+json">${ld}</script>\n  </head>`)
    .replace(/(<div id="root">)(<\/div>)/, `$1${body}$2`));
  guideCount++;
}

/* 소식·트렌드 랜딩 /news/ — platform_news(0027) 피드의 SEO 진입점.
 * 소식 자체는 서버(동적)라 빌드 시점엔 없으므로, 랜딩은 상록(evergreen) 셸:
 * 피드 설명 + 분야 허브 링크 + SPA 피드(?view=news) 링크. 실제 항목은 클라이언트가 하이드레이션. */
{
  const title = "플랫폼·AI 도구 소식·트렌드 — 최근 업데이트 | 세모플";
  const desc = "세모플에 등재된 한국 비즈니스 플랫폼·AI 도구의 최근 소식·업데이트를 분야별로 모았습니다. 관심 분야의 변화를 한곳에서 확인하세요.";
  const canonical = `${SITE}/news/`;
  const ld = JSON.stringify({
    "@context": "https://schema.org", "@type": "CollectionPage", name: title, url: canonical,
    description: desc, isPartOf: { "@type": "WebSite", name: "세모플", url: `${SITE}/` },
  });
  const body = `
<main style="max-width:720px;margin:32px auto;padding:0 20px">
  <p><a href="${BASE}">세모플 — 세상의 모든 플랫폼</a></p>
  <h1>📰 플랫폼·AI 도구 소식·트렌드</h1>
  <p>세모플에 등재된 한국 비즈니스 플랫폼·AI 도구의 최근 소식을 한곳에 모았습니다. 등재 플랫폼 관련 외부 매체 기사를 최신순으로 정리해, 관심 분야의 변화를 놓치지 않도록 돕습니다.</p>
  <p><a href="${BASE}?view=news">→ 최신 소식 피드 보기</a></p>
  ${Object.keys(ARTICLES).length ? `<h2>세모플 가이드</h2><ul>${Object.entries(ARTICLES).map(([slug, a]) => `<li><a href="${BASE}guide/${slug}/">${esc(a.title)}</a> — ${esc(a.desc.slice(0, 90))}…</li>`).join("")}</ul>` : ""}
  <h2>분야별로 살펴보기</h2>
  <ul>${data.categories.map((c) => `<li><a href="${BASE}c/${c.id}/">${esc(c.icon)} ${esc(c.name)}</a> — ${esc(c.desc)}</li>`).join("")}</ul>
  <p class="foot-desc">각 소식은 외부 매체 기사 링크이며, 내용은 각 매체 책임이자 세모플의 평가·추천이 아닙니다.</p>
</main>`;
  const dir = path.join(DIST, "news");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "index.html"), template
    .replace(/<title>[^<]*<\/title>/, `<title>${esc(title)}</title>`)
    .replace(/(<meta name="description" content=")[^"]*(")/, `$1${esc(desc)}$2`)
    .replace(/(<meta property="og:title" content=")[^"]*(")/, `$1${esc(title)}$2`)
    .replace(/(<meta property="og:description" content=")[^"]*(")/, `$1${esc(desc)}$2`)
    .replace(/(<meta property="og:url" content=")[^"]*(")/, `$1${canonical}$2`)
    .replace("</head>", `  <link rel="canonical" href="${canonical}">\n  <script type="application/ld+json">${ld}</script>\n  </head>`)
    .replace(/(<div id="root">)(<\/div>)/, `$1${body}$2`));
}

/* 사이트맵 + robots.
 * lastmod: 정적 데이터엔 플랫폼별 갱신시각이 없다 → 매 빌드 전 URL을 today로 찍으면 "전체가 바뀐 것"처럼
 * 보여 크롤 신뢰도가 떨어진다. 목록이 실제로 커지는 홈·허브·동적 뷰와 신규(new) 상세만 today, 안정 상세는 lastmod 생략. */
const today = new Date().toISOString().slice(0, 10);
const staticUrls = ["", "?view=partners", "?view=exchange", "?view=ai-finder", "?view=packs", "?view=weekly", "?view=onboarding", "?view=deal-guide", "?view=value-check"];
const urls = [
  ...staticUrls.map((u) => ({ loc: `${SITE}/${u}`, lastmod: today })),
  { loc: `${SITE}/news/`, lastmod: today }, // 소식 랜딩(자주 갱신 — today)
  ...Object.entries(ARTICLES).map(([slug, a]) => ({ loc: `${SITE}/guide/${slug}/`, lastmod: a.date })),
  ...data.categories.map((c) => ({ loc: `${SITE}/c/${c.id}/`, lastmod: today })),
  ...[...cmpIds].map((id) => ({ loc: `${SITE}/c/${id}/compare/`, lastmod: today })),
  ...data.platforms.map((p) => ({ loc: `${SITE}/p/${p.id}/`, lastmod: p.new ? today : null })),
];
fs.writeFileSync(path.join(DIST, "sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
  urls.map((u) => `  <url><loc>${u.loc.replace(/&/g, "&amp;")}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ""}</url>`).join("\n") +
  `\n</urlset>\n`);
fs.writeFileSync(path.join(DIST, "robots.txt"), `User-agent: *\nAllow: /\nSitemap: ${SITE}/sitemap.xml\n`);

/* 커스텀 도메인이 설정된 경우에만 CNAME 생성(GitHub Pages 커스텀 도메인 바인딩) —
 * 미설정 빌드에 CNAME이 섞이면 Pages 설정이 깨지므로 반드시 조건부. */
if (CUSTOM_DOMAIN) fs.writeFileSync(path.join(DIST, "CNAME"), CUSTOM_DOMAIN + "\n");

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
  // 편집 가이드 발행분(재크롤 신호 + 구독 유입) — 신규 플랫폼 항목 앞에 배치
  Object.entries(ARTICLES).map(([slug, a]) => {
    const d = new Date(a.date);
    return `<item><title>${esc(`[가이드] ${a.title}`)}</title><link>${SITE}/guide/${slug}/</link>` +
      `<guid isPermaLink="true">${SITE}/guide/${slug}/</guid>` +
      `<description>${esc(a.desc)}</description>` +
      `<pubDate>${isNaN(d.getTime()) ? nowUtc : d.toUTCString()}</pubDate></item>`;
  }).join("\n") + "\n" +
  feedList.map((p) => {
    const cat = catById.get(p.category);
    return `<item><title>${esc(p.name)}</title><link>${SITE}/p/${p.id}/</link>` +
      `<guid isPermaLink="true">${SITE}/p/${p.id}/</guid>` +
      `<description>${esc(`${p.blurb} (${cat?.name ?? ""} · ${p.region})`)}</description>` +
      `${cat ? `<category>${esc(cat.name)}</category>` : ""}<pubDate>${nowUtc}</pubDate></item>`;
  }).join("\n") +
  `\n</channel></rss>\n`;
fs.writeFileSync(path.join(DIST, "feed.xml"), feedXml);

console.log(`프리렌더 상세 ${count}p + 분야 허브 ${catCount}p + 비교표 ${cmpCount}p + 가이드 ${guideCount}p + sitemap(${urls.length} URL) + feed.xml(${feedList.length}) + robots.txt 생성`);
