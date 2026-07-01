#!/usr/bin/env node
/*
 * checklinks.mjs — 플랫폼 URL 상태 점검기 (제한 없는 네트워크에서 실행)
 * ─────────────────────────────────────────────────────────────
 * data/platforms.js의 모든 url을 실제로 요청해 살아있는지(응답 코드) 확인한다.
 * ⚠️ 이 저장소를 만든 샌드박스는 외부 접속이 차단되어 여기서 못 돌린다.
 *    로컬 PC 등 인터넷 되는 곳에서 아래처럼 실행:
 *
 *      cd mvp && node tools/checklinks.mjs
 *      node tools/checklinks.mjs --csv > linkreport.csv   # CSV로 저장
 *
 * Node 18+ (내장 fetch 사용, 외부 의존성 없음).
 * 출력: 상태별 요약 + 문제 URL 목록(4xx/5xx/타임아웃/에러).
 */
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const CFG = require("../data/platforms.js");

const CONCURRENCY = 20;
const TIMEOUT_MS = 12000;
const asCsv = process.argv.includes("--csv");
const UA = "Mozilla/5.0 (compatible; PlatformAllLinkCheck/1.0)";

async function check(p) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const started = Date.now();
  try {
    // HEAD 먼저, 405/501이면 GET 재시도 (일부 서버는 HEAD 미지원)
    let res = await fetch(p.url, { method: "HEAD", redirect: "follow", signal: ctrl.signal, headers: { "User-Agent": UA } });
    if ([405, 400, 403, 501].includes(res.status)) {
      res = await fetch(p.url, { method: "GET", redirect: "follow", signal: ctrl.signal, headers: { "User-Agent": UA } });
    }
    clearTimeout(t);
    return { p, status: res.status, ok: res.ok || res.status === 403, ms: Date.now() - started };
  } catch (e) {
    clearTimeout(t);
    return { p, status: e.name === "AbortError" ? "TIMEOUT" : "ERROR", ok: false, ms: Date.now() - started, err: (e.message || "").slice(0, 60) };
  }
}

async function run() {
  const items = CFG.platforms;
  const results = [];
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await check(items[idx]);
      if (!asCsv && idx % 50 === 0) process.stderr.write(`\r점검 중 ${idx}/${items.length}`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  process.stderr.write(`\r점검 완료 ${items.length}/${items.length}\n`);

  if (asCsv) {
    console.log("name,category,status,url");
    for (const r of results) console.log(`${JSON.stringify(r.p.name)},${r.p.category},${r.status},${r.p.url}`);
    return;
  }
  const bad = results.filter((r) => !r.ok);
  const byStatus = {};
  for (const r of results) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
  console.log("\n=== 상태 코드 요약 ===");
  Object.entries(byStatus).sort((a, b) => b[1] - a[1]).forEach(([s, n]) => console.log(`  ${s}: ${n}`));
  console.log(`\n=== 문제 URL (${bad.length}건) — 확인 필요 ===`);
  for (const r of bad) console.log(`  [${r.status}] ${r.p.name} (${r.p.category}) ${r.p.url}${r.err ? " — " + r.err : ""}`);
  console.log(`\n총 ${results.length}개 중 정상 ${results.length - bad.length} / 문제 ${bad.length}`);
  console.log("※ 403은 봇 차단일 뿐 실제로는 살아있는 경우가 많아 정상으로 집계함. 4xx/5xx/TIMEOUT/ERROR를 우선 확인.");
}
run();
