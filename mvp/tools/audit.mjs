#!/usr/bin/env node
/*
 * audit.mjs — 플랫폼 데이터 정적 품질 감사 (오프라인, 어디서나 실행)
 *   cd mvp && node tools/audit.mjs
 * 중복(이름/URL/id)·필드 누락·잘못된 분야/지역·URL 형식·약한 링크(앱스토어/punycode/http)를 점검한다.
 * 라이브 응답(200/404)은 tools/checklinks.mjs로 별도 점검(인터넷 필요).
 */
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const C = require("../data/platforms.js");
const P = C.platforms, cats = new Set(C.categories.map((c) => c.id));
const norm = (s) => String(s).toLowerCase().replace(/[\s·.,\/&\-()]/g, "");
const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, "").replace(/^m\./, ""); } catch (e) { return null; } };

const grp = (key) => { const m = {}; for (const p of P) { const k = key(p); (m[k] = m[k] || []).push(p.name); } return Object.entries(m).filter(([, v]) => v.length > 1); };
const issues = { missing: [], badCat: [], badRegion: [], badUrl: [], nonHttps: [], appstore: [], punycode: [], shortBlurb: [] };
for (const p of P) {
  for (const f of ["id", "name", "category", "region", "url", "blurb"]) if (!p[f]) issues.missing.push(`${p.id || "?"}:${f}`);
  if (!cats.has(p.category)) issues.badCat.push(`${p.name}:${p.category}`);
  if (!["국내", "해외", "글로벌"].includes(p.region)) issues.badRegion.push(`${p.name}:${p.region}`);
  if (!host(p.url)) issues.badUrl.push(`${p.name}:${p.url}`);
  else if (!/^https/.test(p.url)) issues.nonHttps.push(p.name);
  if (/apps\.apple\.com|play\.google\.com/.test(p.url)) issues.appstore.push(p.name);
  if (/xn--/.test(p.url)) issues.punycode.push(p.name);
  if ((p.blurb || "").length < 6) issues.shortBlurb.push(p.name);
}
console.log(`총 ${P.length}개 · 분야 ${C.categories.length} · NEW ${P.filter((p) => p.new).length}`);
console.log(`중복 이름 ${grp((p) => norm(p.name)).length} · 중복 URL ${grp((p) => String(p.url).replace(/\/+$/, "")).length} · 중복 ID ${grp((p) => p.id).length}`);
console.log(`필드누락 ${issues.missing.length} · 잘못된분야 ${issues.badCat.length} · 잘못된지역 ${issues.badRegion.length} · URL오류 ${issues.badUrl.length}`);
console.log(`http(비https) ${issues.nonHttps.length} · 앱스토어링크 ${issues.appstore.length} · punycode ${issues.punycode.length} · 짧은설명 ${issues.shortBlurb.length}`);
const anyHard = issues.missing.length + issues.badCat.length + issues.badRegion.length + issues.badUrl.length + grp((p) => norm(p.name)).length + grp((p) => p.id).length;
console.log(anyHard === 0 ? "✅ 구조적 결함 없음" : "⚠️ 위 항목 확인 필요");
