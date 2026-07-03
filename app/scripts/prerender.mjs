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
    ${p.fee_text ? `<li>수수료: ${esc(p.fee_text)}</li>` : ""}
    ${p.settle_text ? `<li>정산: ${esc(p.settle_text)}</li>` : ""}
    ${p.enter_text ? `<li>입점: ${esc(p.enter_text)}</li>` : ""}
    <li>공식 사이트: <a href="${esc(p.url)}" rel="noopener">${esc(p.url.replace(/^https?:\/\//, ""))}</a></li>
  </ul>
  ${similar.length ? `<h2>같은 분야의 다른 플랫폼</h2><ul>${similar.map((s) => `<li><a href="/web1/p/${s.id}/">${esc(s.name)}</a> — ${esc(s.blurb)}</li>`).join("")}</ul>` : ""}
  <p>세모플은 ${data.platforms.length.toLocaleString()}개 플랫폼·AI 도구를 같은 기준으로 정리한 B2B 디렉토리입니다. 설명은 개략 소개이며 상세 조건은 공식 사이트에서 확인하세요.</p>
</main>`;

  return template
    .replace(/<title>[^<]*<\/title>/, `<title>${esc(title)}</title>`)
    .replace(/(<meta name="description" content=")[^"]*(")/, `$1${esc(desc)}$2`)
    .replace(/(<meta property="og:title" content=")[^"]*(")/, `$1${esc(title)}$2`)
    .replace(/(<meta property="og:description" content=")[^"]*(")/, `$1${esc(desc)}$2`)
    .replace(/(<meta property="og:url" content=")[^"]*(")/, `$1${canonical}$2`)
    .replace("</head>", `  <link rel="canonical" href="${canonical}">\n  </head>`)
    .replace(/(<div id="root">)(<\/div>)/, `$1${staticBody}$2`);
}

let count = 0;
for (const p of data.platforms) {
  const dir = path.join(DIST, "p", p.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "index.html"), pageFor(p));
  count++;
}

/* 사이트맵 + robots */
const today = new Date().toISOString().slice(0, 10);
const staticUrls = ["", "?view=partners", "?view=exchange", "?view=ai-finder", "?view=packs", "?view=weekly", "?view=onboarding", "?view=deal-guide", "?view=value-check"];
const urls = [
  ...staticUrls.map((u) => `${SITE}/${u}`),
  ...data.platforms.map((p) => `${SITE}/p/${p.id}/`),
];
fs.writeFileSync(path.join(DIST, "sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
  urls.map((u) => `  <url><loc>${u.replace(/&/g, "&amp;")}</loc><lastmod>${today}</lastmod></url>`).join("\n") +
  `\n</urlset>\n`);
fs.writeFileSync(path.join(DIST, "robots.txt"), `User-agent: *\nAllow: /\nSitemap: ${SITE}/sitemap.xml\n`);

console.log(`프리렌더 ${count}p + sitemap(${urls.length} URL) + robots.txt 생성`);
