/* 전 라우트 스모크 — 모든 뷰 × (비로그인·로그인·관리자)에서 흰 화면(pageerror)·빈 렌더가 없는지 검증.
 * 원격은 mock([] 기본, profiles만 역할 주입)이라 운영 무영향. 실행법은 backend/test/README.md.
 * adversarial-smoke(적대 입력)와 역할 분리: 여기는 "정상 진입 경로 전수"가 목적. CI 미연결 — 릴리스 전 로컬 수동. */
import { chromium } from "/opt/node22/lib/node_modules/playwright/index.mjs";

const BASE = process.env.SMOKE_BASE || "http://localhost:4293/web1/";
const results = [];
const ok = (name, cond) => { results.push([cond ? "PASS" : "FAIL", name]); if (!cond) process.exitCode = 1; };
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });

const ADMIN_ID = "00000000-0000-0000-0000-0000000000ad";
const USER_ID  = "00000000-0000-0000-0000-00000000000a";

async function newPage(role /* null | "member" | "admin" */) {
  const page = await browser.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e.message).slice(0, 150)));
  // localhost 외 전부 차단(먼저 등록 = 마지막 매칭) — 파비콘·CDN이 프록시 환경에서 매달리면 networkidle이 안 온다
  await page.route(/^https?:\/\/(?!localhost)/, (r) => r.abort());
  // GitHub API(운영 잡 헬스 카드)도 mock — 외부 의존 없이 결정적으로
  await page.route("**://api.github.com/**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"workflow_runs":[]}' }));
  await page.route("**://*.supabase.co/**", (r) => {
    const u = r.request().url();
    if (role && u.includes("/profiles")) {
      const id = role === "admin" ? ADMIN_ID : USER_ID;
      return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([{ id, role: role === "admin" ? "admin" : "member", display_name: "테스트", suspended_at: null }]) });
    }
    return r.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });
  if (role) await page.addInitScript(({ id }) => {
    localStorage.setItem("sm.session.v1", JSON.stringify({
      access_token: "fake", refresh_token: "fake", expires_at: Math.floor(Date.now() / 1000) + 3600,
      user: { id, email: "t@test.kr" } }));
  }, { id: role === "admin" ? ADMIN_ID : USER_ID });
  return { page, errs };
}

async function visit(page, path) {
  await page.goto(BASE + path, { waitUntil: "networkidle" });
  return page.evaluate(() => document.body.innerText.length);
}

// ── A) 비로그인: 전 뷰(App.tsx 라우팅 전수) ──
const PUBLIC_ROUTES = [
  ["홈", ""], ["즐겨찾기 모드", "?fav=1"], ["검색", "?view=search&q=스토어"],
  ["상세", "?view=detail&id=coupang"], ["비교", "?view=compare"], ["온보딩", "?view=onboarding"],
  ["제휴", "?view=partners"], ["거래소", "?view=exchange"], ["양수도 가이드", "?view=deal-guide"],
  ["가치 진단", "?view=value-check"], ["AI 파인더", "?view=ai-finder"], ["주간 신규", "?view=weekly"],
  ["스타터 팩", "?view=packs"], ["소식", "?view=news"], ["가이드", "?view=guide&id=openmarket-entry-checklist"],
  ["계정(로그인 폼)", "?view=account"], ["제보", "?view=submit"], ["관리(비로그인 안내)", "?view=admin"],
  ["도움말 허브", "?view=help"], ["도움말 글", "?view=guide&id=help-search"],
  ["약관", "?view=terms"], ["개인정보", "?view=privacy"], ["알림", "?view=notifications"],
  ["수신거부", "?view=optout"], ["매물 상세(미존재)", "?view=deal&id=d-x"], ["문의", "?view=support"],
];
{
  const { page, errs } = await newPage(null);
  for (const [name, path] of PUBLIC_ROUTES) {
    const len = await visit(page, path);
    ok(`비로그인·${name}`, len > 20);
  }
  ok("비로그인·pageerror 0", errs.length === 0);
  if (errs.length) console.log("  errs:", [...new Set(errs)]);
  await page.close();
}

// ── B) 로그인(일반 회원): 인증 분기 뷰 ──
{
  const { page, errs } = await newPage("member");
  for (const [name, path] of [
    ["홈(개인화)", ""], ["계정", "?view=account"], ["제보 폼", "?view=submit"],
    ["알림함", "?view=notifications"], ["관리(권한 없음 안내)", "?view=admin"],
    ["제휴", "?view=partners"], ["거래소", "?view=exchange"],
  ]) {
    const len = await visit(page, path);
    ok(`회원·${name}`, len > 20);
  }
  ok("회원·pageerror 0", errs.length === 0);
  if (errs.length) console.log("  errs:", [...new Set(errs)]);
  await page.close();
}

// ── C) 관리자: 콘솔 본체(대시보드·헬스 카드 렌더) ──
{
  const { page, errs } = await newPage("admin");
  const len = await visit(page, "?view=admin");
  const text = await page.evaluate(() => document.body.innerText);
  ok("관리자·콘솔 렌더", len > 100 && text.includes("관리 콘솔"));
  ok("관리자·pageerror 0", errs.length === 0);
  if (errs.length) console.log("  errs:", [...new Set(errs)]);
  await page.close();
}

for (const [s, n] of results) console.log(`${s === "PASS" ? "✅" : "❌"} ${n}`);
const fail = results.filter(([s]) => s === "FAIL").length;
console.log(`— ${results.length - fail}/${results.length} PASS`);
await browser.close();
