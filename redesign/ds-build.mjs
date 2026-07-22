/* system.html의 @dsCard 섹션을 컴포넌트별 파일로 분리 → redesign/ds/*.html
 * 각 파일: 첫 줄 <!-- @dsCard ... --> + tokens/컴포넌트 CSS 인라인(self-contained).
 * 클로드디자인(/design-sync)이 첫 줄 마커로 카드 인덱스를 만든다. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(DIR, "system.html"), "utf8");
const tokens = fs.readFileSync(path.join(DIR, "tokens.css"), "utf8");
const styleCss = (html.match(/<style>([\s\S]*?)<\/style>/) || [, ""])[1];

const outDir = path.join(DIR, "ds");
fs.mkdirSync(outDir, { recursive: true });

const head = (title) =>
  `<!doctype html>\n<html lang="ko" data-theme="dark">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>${title}</title>\n` +
  `<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable.css">\n` +
  `<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@fontsource/ibm-plex-mono@5.0.8/index.min.css">\n` +
  `<style>\n${tokens}\n${styleCss}\nbody{padding:28px}</style>\n</head>\n<body>\n`;

const re = /(<!--\s*@dsCard[^>]*-->)\s*(<section class="sec">[\s\S]*?<\/section>)/g;
let m, n = 0;
const cards = [];
while ((m = re.exec(html))) {
  const comment = m[1], section = m[2];
  const name = (comment.match(/name="([^"]+)"/) || [, "component" + n])[1];
  const group = (comment.match(/group="([^"]+)"/) || [, "Components"])[1];
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const file = `${slug}.html`;
  fs.writeFileSync(path.join(outDir, file), `${comment}\n${head(name)}${section}\n</body>\n</html>\n`);
  cards.push({ file, group, name });
  n++;
}
fs.writeFileSync(path.join(outDir, "_index.json"), JSON.stringify(cards, null, 2));
console.log(`생성: ${n}개 컴포넌트 파일 → redesign/ds/`);
cards.forEach((c) => console.log(`  [${c.group}] ${c.name} → ds/${c.file}`));
