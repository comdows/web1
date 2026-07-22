/* EN 번역 커버리지 리포트(로드맵 v2 Phase 3 툴링) — 읽기 전용.
 * platforms.json 대비 platforms.en.json 차집합을 분야별로 출력한다(번역 배치 PR 본문 첨부용).
 * 사용: node app/scripts/en-coverage.mjs [--ids <분야id>]  (--ids: 해당 분야의 미번역 id 전체 나열) */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const KO = JSON.parse(fs.readFileSync(path.join(ROOT, "src/data/platforms.json"), "utf8"));
const EN = JSON.parse(fs.readFileSync(path.join(ROOT, "src/data/platforms.en.json"), "utf8"));
const HUB_EN = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, "src/data/hub-intros.en.json"), "utf8")); } catch { return {}; } })();

const idsArg = process.argv.indexOf("--ids");
const focusCat = idsArg > -1 ? process.argv[idsArg + 1] : null;

const groupName = Object.fromEntries(KO.groups.map((g) => [g.id, g.name]));
const rows = [];
let totKo = 0, totEn = 0;
for (const c of KO.categories) {
  const ko = KO.platforms.filter((p) => p.category === c.id);
  const done = ko.filter((p) => EN.platforms[p.id]);
  const missing = ko.filter((p) => !EN.platforms[p.id]);
  totKo += ko.length; totEn += done.length;
  rows.push({ group: c.group, cat: c.id, name: c.name, ko: ko.length, en: done.length, missing });
}

console.log(`# EN 커버리지 — 플랫폼 ${totEn}/${totKo} (${(totEn / totKo * 100).toFixed(1)}%) · 허브 인트로 ${Object.keys(HUB_EN).length}/${KO.categories.length}\n`);
console.log("| 그룹 | 분야 | EN/KO | 미번역 |");
console.log("|---|---|---|---|");
let curGroup = "";
for (const r of rows.sort((a, b) => a.group.localeCompare(b.group) || (b.ko - b.en) - (a.ko - a.en))) {
  const g = r.group === curGroup ? "" : (curGroup = r.group, groupName[r.group] ?? r.group);
  const mark = r.en === r.ko ? "✅" : r.en === 0 ? "⬜" : "◽";
  console.log(`| ${g} | ${mark} ${r.cat} (${r.name}) | ${r.en}/${r.ko} | ${r.ko - r.en} |`);
}
const hubMissing = KO.categories.filter((c) => !HUB_EN[c.id]).map((c) => c.id);
console.log(`\n허브 인트로 미번역(${hubMissing.length}): ${hubMissing.join(", ") || "없음"}`);

if (focusCat) {
  const r = rows.find((x) => x.cat === focusCat);
  if (!r) { console.error(`분야 없음: ${focusCat}`); process.exit(1); }
  console.log(`\n## ${focusCat} 미번역 ${r.missing.length}건`);
  for (const p of r.missing) console.log(`- ${p.id} : ${p.name} — ${p.blurb.slice(0, 60)}`);
}
