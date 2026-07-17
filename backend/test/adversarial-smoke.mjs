/* 적대적 입력 Playwright 스모크 — 손상 세션·미존재 뷰·초장문·손상 localStorage·연락처 제보 차단에서
 * 흰 화면(pageerror)·크래시가 없는지 검증. 원격(Supabase)은 차단하고 정적 dist만 띄운다.
 * 실행법은 backend/test/README.md 참조. CI 미연결(브라우저 무거움) — 릴리스 전 로컬 수동. */
import { chromium } from "/opt/node22/lib/node_modules/playwright/index.mjs";

const BASE = process.env.SMOKE_BASE || "http://localhost:4293/web1/";
const results = [];
const ok = (name, cond) => { results.push([cond ? "PASS" : "FAIL", name]); if (!cond) process.exitCode = 1; };

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });

async function newPage(initScript) {
  const page = await browser.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e.message).slice(0, 160)));
  await page.route("**://*.supabase.co/**", (r) => r.abort());      // 원격 차단(정적만)
  if (initScript) await page.addInitScript(initScript);
  return { page, errs };
}
const bodyText = (page) => page.evaluate(() => document.body.innerText.length);

// 1) 손상 세션(shape 어긋난 유효 JSON) 주입 후 홈·계정 진입 — pageerror 0, 화면 렌더
{
  const { page, errs } = await newPage(() => {
    localStorage.setItem("sm.session.v1", JSON.stringify({ access_token: "x" })); // user 없음
  });
  await page.goto(BASE, { waitUntil: "networkidle" });
  ok("손상세션: 홈 렌더", (await bodyText(page)) > 50);
  await page.goto(BASE + "?view=account", { waitUntil: "networkidle" });
  ok("손상세션: 계정 진입 pageerror 0", errs.length === 0);
  await page.close();
}

// 2) 미존재 view — 홈 폴백, 크래시 없음
{
  const { page, errs } = await newPage();
  await page.goto(BASE + "?view=zzz-does-not-exist", { waitUntil: "networkidle" });
  ok("미존재 view: 렌더 생존", (await bodyText(page)) > 50 && errs.length === 0);
  await page.close();
}

// 3) 초장문·특수문자 검색어 — 프리즈/크래시 없음
{
  const { page, errs } = await newPage();
  const q = encodeURIComponent("가".repeat(500) + " ,)(%$#@");
  await page.goto(`${BASE}?view=search&q=${q}`, { waitUntil: "networkidle" });
  ok("초장문 검색: 렌더 생존", (await bodyText(page)) > 20 && errs.length === 0);
  await page.close();
}

// 4) 손상 localStorage(비배열 값) — 부팅 생존(#95 회귀)
{
  const { page, errs } = await newPage(() => {
    localStorage.setItem("sm.compare.v1", "42");
    localStorage.setItem("sm.favs.v1", '{"not":"array"}');
    localStorage.setItem("sm.interests.v1", "null");
  });
  await page.goto(BASE, { waitUntil: "networkidle" });
  ok("손상 localStorage: 홈 부팅 생존", (await bodyText(page)) > 50 && errs.length === 0);
  await page.close();
}

// 5) 미존재 /p/<초장문 id> — not-found 화면, 크래시 없음
{
  const { page, errs } = await newPage();
  await page.goto(`${BASE}?view=detail&id=${"x".repeat(300)}`, { waitUntil: "networkidle" });
  ok("미존재 상세: not-found 생존", (await bodyText(page)) > 20 && errs.length === 0);
  await page.close();
}

for (const [s, n] of results) console.log(`${s === "PASS" ? "✅" : "❌"} ${n}`);
const fail = results.filter(([s]) => s === "FAIL").length;
console.log(`— ${results.length - fail}/${results.length} PASS`);
await browser.close();
