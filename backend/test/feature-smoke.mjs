/* 기능 교차 스모크(QA 3차 산출) — #144~#164 웨이브가 만든 표면의 상호작용 회귀 방지.
 * 커버: R2 공지 배너(유효/만료·전역) · G1 투어(자동 1회·기록·수동 재실행·앵커 하이라이트) ·
 *   G3 도움말 허브/화면 연결 · R4 운영자 답글(표시·권한별 폼) · R3 알림 신종 3종(렌더·이동) ·
 *   R2 관리자 발행 도구 · 모바일(375px) 렌더+가로 오버플로.
 * route-smoke(정상 경로 전수)·adversarial(비정상 입력)과 역할 분리: 여기는 "기능 시나리오" 층.
 * 원격은 전부 mock — 운영 무영향. 실행 절차는 README.md §2와 동일(dist 서버 4293). */
import { chromium } from "/opt/node22/lib/node_modules/playwright/index.mjs";

const BASE = process.env.SMOKE_BASE || "http://localhost:4293/web1/";
const results = [];
const ok = (name, cond) => { results.push([cond ? "PASS" : "FAIL", name]); if (!cond) process.exitCode = 1; };
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });

const USER_ID = "00000000-0000-0000-0000-00000000000a";
const ADMIN_ID = "00000000-0000-0000-0000-0000000000ad";
const FUTURE = "2099-01-01", PAST = "2020-01-01";

/* mock 원격: notice(app_settings)·후기 뷰·운영자 조인·알림함·profiles 역할 주입 외 전부 []. */
async function newPage({ role = null, notice = null, reviews = null, notifs = null, operated = null, viewport = null } = {}) {
  const page = await browser.newPage(viewport ? { viewport } : {});
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e.message).slice(0, 150)));
  // localhost 외 전부 차단(먼저 등록 = 마지막 매칭) — 파비콘·CDN이 프록시 환경에서 매달리면 networkidle이 안 온다
  await page.route(/^https?:\/\/(?!localhost)/, (r) => r.abort());
  await page.route("**://api.github.com/**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"workflow_runs":[]}' }));
  await page.route("**://*.supabase.co/**", (r) => {
    const u = r.request().url();
    const json = (b) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
    if (u.includes("app_settings") && u.includes("key=eq.notice")) return json(notice ? [{ value: notice }] : []);
    if (u.includes("v_reviews_public")) return json(reviews ?? []);
    if (u.includes("platform_operators")) return json(operated ?? []);
    if (u.includes("/notifications") && r.request().method() === "GET") return json(notifs ?? []);
    if (role && u.includes("/profiles")) {
      const id = role === "admin" ? ADMIN_ID : USER_ID;
      return json([{ id, role: role === "admin" ? "admin" : "member", display_name: "테스트", suspended_at: null }]);
    }
    return json([]);
  });
  if (role) await page.addInitScript(({ id }) => {
    localStorage.setItem("sm.session.v1", JSON.stringify({
      access_token: "fake", refresh_token: "fake", expires_at: Math.floor(Date.now() / 1000) + 3600,
      user: { id, email: "t@test.kr" } }));
  }, { id: role === "admin" ? ADMIN_ID : USER_ID });
  return { page, errs };
}
const text = (page) => page.evaluate(() => document.body.innerText);
const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

// ── 1) R2 공지 배너: 유효 until → 홈·검색 모두 노출(전역) ──
{
  const { page, errs } = await newPage({ notice: { text: "테스트 공지입니다", until: FUTURE } });
  await page.goto(BASE, { waitUntil: "networkidle" });
  ok("공지 배너: 유효 기간 → 홈 노출", (await text(page)).includes("테스트 공지입니다"));
  await page.goto(BASE + "?view=search", { waitUntil: "networkidle" });
  ok("공지 배너: 검색 뷰에서도 노출(전역)", (await text(page)).includes("테스트 공지입니다"));
  ok("공지: pageerror 0", errs.length === 0);
  await page.close();
}
// ── 2) R2 공지 배너: 만료 until → 미노출 ──
{
  const { page } = await newPage({ notice: { text: "만료된 공지", until: PAST } });
  await page.goto(BASE, { waitUntil: "networkidle" });
  ok("공지 배너: 만료 → 미노출", !(await text(page)).includes("만료된 공지"));
  await page.close();
}
// ── 3) G1 홈 투어: 첫 방문 자동 1회 → 기록 → 재방문 미실행 → 수동 재실행 ──
{
  const { page, errs } = await newPage({});
  await page.goto(BASE, { waitUntil: "networkidle" });
  const pop = await page.waitForSelector(".driver-popover", { timeout: 6000 }).catch(() => null);
  ok("투어: 첫 방문 자동 실행(driver 팝오버)", !!pop);
  const seen = await page.evaluate(() => JSON.parse(localStorage.getItem("sm.tour.v1") || "{}"));
  ok("투어: sm.tour.v1에 home 기록", !!seen.home);
  await page.keyboard.press("Escape");
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(2200); // 자동 실행 지연(1200ms) + 여유
  ok("투어: 재방문 자동 미실행", !(await page.$(".driver-popover")));
  await page.click("text=둘러보기");
  const pop2 = await page.waitForSelector(".driver-popover", { timeout: 6000 }).catch(() => null);
  ok("투어: ❔ 둘러보기 수동 재실행", !!pop2);
  if (pop2) {
    await page.click(".driver-popover-next-btn");
    await page.waitForTimeout(500);
    ok("투어: 스텝 진행 시 앵커 하이라이트", !!(await page.$(".driver-active-element")));
  }
  ok("투어: pageerror 0", errs.length === 0);
  await page.close();
}
// ── 4) 도움말 허브 → 도움말 글의 화면 연결 투어 버튼 ──
{
  const { page, errs } = await newPage({});
  await page.goto(BASE + "?view=help", { waitUntil: "networkidle" });
  ok("도움말 허브: 렌더", (await text(page)).length > 100);
  await page.goto(BASE + "?view=guide&id=help-search", { waitUntil: "networkidle" });
  ok("도움말 글: 화면 연결 투어 버튼", (await text(page)).includes("검색 화면에서 직접 보기"));
  ok("도움말: pageerror 0", errs.length === 0);
  await page.close();
}
// ── 5) R4 답글: 비로그인 — 답변 표시·폼 미노출 ──
{
  const rows = [{ id: "aaaaaaaa-0000-0000-0000-000000000001", platform_id: "coupang", rating: 5, body: "배송이 빨라요", created_at: "2026-07-01T00:00:00Z", operator_reply: "이용해 주셔서 감사합니다", operator_replied_at: "2026-07-02T00:00:00Z" }];
  const { page, errs } = await newPage({ reviews: rows });
  await page.goto(BASE + "?view=detail&id=coupang", { waitUntil: "networkidle" });
  const t = await text(page);
  ok("답글: 운영자 답변 본문 렌더", t.includes("운영자 답변") && t.includes("이용해 주셔서 감사합니다"));
  ok("답글: 비로그인 폼 미노출", !t.includes("답변 게시"));
  ok("답글: pageerror 0", errs.length === 0);
  await page.close();
}
// ── 6) R4 답글: 인증 운영자 — 답글 UI 노출 ──
{
  const rows = [{ id: "aaaaaaaa-0000-0000-0000-000000000001", platform_id: "coupang", rating: 4, body: "좋아요", created_at: "2026-07-01T00:00:00Z", operator_reply: null, operator_replied_at: null }];
  const { page, errs } = await newPage({ role: "member", reviews: rows, operated: [{ platform_id: "coupang", granted_at: "2026-01-01T00:00:00Z" }] });
  await page.goto(BASE + "?view=detail&id=coupang", { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  const t = await text(page);
  ok("답글: 운영자에게 답글 UI 노출", t.includes("답변 달기") || t.includes("답변 게시") || t.includes("운영자 답변"));
  ok("답글(운영자): pageerror 0", errs.length === 0);
  await page.close();
}
// ── 7) R3 알림 신종 3종: 렌더 + 문의 답변 클릭 → support 이동 ──
{
  const now = new Date().toISOString();
  const notifs = [
    { id: "n1", user_id: USER_ID, kind: "proposal", ref_type: "proposal", ref_id: "p1", title: "내 플랫폼에 제휴 제안이 도착했어요", body: "홍길동 — 입점 제휴 제안", url: "?view=account", read_at: null, created_at: now },
    { id: "n2", user_id: USER_ID, kind: "review_result", ref_type: "submission", ref_id: "sub:1", title: '제보하신 "테스트몰"이(가) 등재됐어요 🎉', body: "검수를 통과해 디렉토리에 등재됐습니다.", url: "?view=account", read_at: null, created_at: now },
    { id: "n3", user_id: USER_ID, kind: "inquiry_reply", ref_type: "inquiry", ref_id: "q1", title: "문의하신 내용에 답변이 등록됐어요", body: '"요금 문의" — 문의·도움말에서 답변을 확인하세요.', url: "?view=support", read_at: null, created_at: now },
  ];
  const { page, errs } = await newPage({ role: "member", notifs });
  await page.goto(BASE + "?view=notifications", { waitUntil: "networkidle" });
  const t = await text(page);
  ok("알림: proposal 렌더", t.includes("제휴 제안이 도착했어요"));
  ok("알림: review_result 렌더", t.includes("등재됐어요 🎉"));
  ok("알림: inquiry_reply 렌더", t.includes("답변이 등록됐어요"));
  await page.click("text=문의하신 내용에 답변이 등록됐어요");
  await page.waitForTimeout(800);
  ok("알림: 문의 답변 클릭 → support 이동", page.url().includes("view=support"));
  ok("알림: pageerror 0", errs.length === 0);
  await page.close();
}
// ── 8) R2 관리자 발행 도구: 공지 발행·소식 추가 렌더 ──
{
  const { page, errs } = await newPage({ role: "admin" });
  await page.goto(BASE + "?view=admin", { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);
  const t = await text(page);
  ok("관리자: 공지 발행 섹션", t.includes("공지 발행"));
  ok("관리자: 소식 추가 폼", t.includes("+ 소식 추가"));
  ok("관리자: pageerror 0", errs.length === 0);
  await page.close();
}
// ── 9) 모바일(375×667): 공지+투어 / 상세 답글 / 도움말 — 렌더 + 가로 오버플로 없음 ──
{
  const vp = { width: 375, height: 667 };
  const { page, errs } = await newPage({ notice: { text: "모바일에서도 보이는 공지입니다", until: null }, viewport: vp });
  await page.goto(BASE, { waitUntil: "networkidle" });
  ok("모바일 홈: 공지 배너 렌더", (await text(page)).includes("모바일에서도 보이는 공지"));
  const pop = await page.waitForSelector(".driver-popover", { timeout: 6000 }).catch(() => null);
  ok("모바일 홈: 투어 자동 실행", !!pop);
  if (pop) {
    const fits = await page.evaluate(() => {
      const r = document.querySelector(".driver-popover").getBoundingClientRect();
      return r.left >= -1 && r.right <= window.innerWidth + 1;
    });
    ok("모바일 홈: 투어 팝오버 화면 내", fits);
    await page.keyboard.press("Escape");
  }
  ok("모바일 홈: 가로 오버플로 없음", await noHScroll(page));
  ok("모바일 홈: pageerror 0", errs.length === 0);
  await page.close();

  const rows = [{ id: "aaaaaaaa-0000-0000-0000-000000000001", platform_id: "coupang", rating: 5, body: "좋습니다", created_at: "2026-07-01T00:00:00Z", operator_reply: "감사합니다. 더 좋은 서비스로 보답할게요.", operator_replied_at: "2026-07-02T00:00:00Z" }];
  const m2 = await newPage({ reviews: rows, viewport: vp });
  await m2.page.goto(BASE + "?view=detail&id=coupang", { waitUntil: "networkidle" });
  ok("모바일 상세: 운영자 답변 렌더", (await text(m2.page)).includes("운영자 답변"));
  ok("모바일 상세: 가로 오버플로 없음", await noHScroll(m2.page));
  ok("모바일 상세: pageerror 0", m2.errs.length === 0);
  await m2.page.close();

  const m3 = await newPage({ viewport: vp });
  await m3.page.goto(BASE + "?view=help", { waitUntil: "networkidle" });
  ok("모바일 도움말: 렌더", (await text(m3.page)).length > 100);
  ok("모바일 도움말: 가로 오버플로 없음", await noHScroll(m3.page));
  ok("모바일 도움말: pageerror 0", m3.errs.length === 0);
  await m3.page.close();
}

for (const [s, n] of results) console.log(`${s === "PASS" ? "✅" : "❌"} ${n}`);
const fail = results.filter(([s]) => s === "FAIL").length;
console.log(`— ${results.length - fail}/${results.length} PASS`);
await browser.close();
