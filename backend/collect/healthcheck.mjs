/* 등재 URL 헬스체크 — 매월 GitHub Actions에서 실행(healthcheck.yml).
 * 정적 시드(app/src/data/platforms.json)의 전체 URL을 순회해 죽은 링크를 찾아
 * GitHub 이슈로 리포트한다(자동 삭제 없음 — 관리자가 확인 후 조치).
 * 봇 차단(403 등)은 "확인 필요"로만 분류해 오탐을 줄인다. */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const data = JSON.parse(fs.readFileSync(path.join(ROOT, "app/src/data/platforms.json"), "utf8"));

/* 라이브 데이터 우선 — 정적 시드만 돌면 콘솔에서 승인·정정된 등재분이 영구 무점검이 된다.
 * SUPABASE env가 있으면 anon PostgREST로 전량 페이지네이션 조회(공개 read RLS).
 * 조회 실패는 throw: Supabase 장애의 가용성 프로브를 겸한다(런 실패 → 알림 메일). */
async function fetchLivePlatforms() {
  const SB_URL = process.env.SUPABASE_URL, SB_KEY = process.env.SUPABASE_ANON_KEY;
  if (!SB_URL || !SB_KEY) return null;
  const rows = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const res = await fetch(`${SB_URL}/rest/v1/platforms?select=id,name,category_id,url&order=id.asc`, {
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, Range: `${from}-${from + PAGE - 1}` },
    });
    if (!res.ok) throw new Error(`라이브 플랫폼 조회 실패: ${res.status} ${await res.text()}`);
    const batch = await res.json();
    rows.push(...batch);
    if (batch.length < PAGE) break;
  }
  return rows.map((r) => ({ id: r.id, name: r.name, category: r.category_id, url: r.url }));
}
const live = await fetchLivePlatforms();
if (live) { data.platforms = live; console.log(`라이브 데이터 사용 — ${live.length}건(Supabase)`); }
else console.log("SUPABASE env 없음 — 정적 시드로 점검");

/* 죽은 링크가 있으면 그 플랫폼을 즐겨찾기(alert=true)한 회원에게 인앱 알림(notifications, 0018)을 넣는다.
 * admin 봇 필요(favorites admin read + notifications admin insert). 봇 Secrets 없으면 조용히 건너뜀(하위호환).
 * 멱등: unique(user_id, kind, ref_id) + ignore-duplicates → 같은 플랫폼 재점검해도 재알림 안 함. */
/* admin 봇 세션(1회 로그인 + 롤 확인) — 링크 상태 기록과 관심 등록자 알림이 공유. 봇 Secrets 없으면 null. */
let _botCtx;
async function botCtx() {
  if (_botCtx !== undefined) return _botCtx;
  const email = process.env.ADMIN_BOT_EMAIL, pw = process.env.ADMIN_BOT_PASSWORD;
  const SB_URL = process.env.SUPABASE_URL, SB_KEY = process.env.SUPABASE_ANON_KEY;
  if (!email || !pw || !SB_URL || !SB_KEY) { _botCtx = null; return null; }
  const lr = await fetch(`${SB_URL}/auth/v1/token?grant_type=password`, {
    method: "POST", headers: { apikey: SB_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: pw }),
  });
  if (!lr.ok) throw new Error(`봇 로그인 실패: ${lr.status}`);
  const token = (await lr.json()).access_token;
  const rest = async (pathQ, init = {}) => {
    const res = await fetch(`${SB_URL}/rest/v1/${pathQ}`, {
      ...init, headers: { apikey: SB_KEY, Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers || {}) },
    });
    if (!res.ok) throw new Error(`${res.status} ${pathQ.split("?")[0]}: ${await res.text()}`);
    const t = await res.text(); return t ? JSON.parse(t) : undefined;
  };
  // 센티널: 봇이 admin 롤이 아니면 admin-only 동작이 조용히 0행 → 런 실패시킴
  const sub = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).sub;
  const me = await rest(`profiles?id=eq.${sub}&select=role`);
  if (me[0]?.role !== "admin") throw new Error(`봇 계정이 admin 롤이 아님(role=${me[0]?.role ?? "없음"}) — 신뢰 불가`);
  _botCtx = { rest };
  return _botCtx;
}
const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };

/* 링크 생존 상태를 플랫폼 행에 기록(ok/warn/dead + 확인시각) → 카드/상세 신선도 배지(0020).
 * 회복(dead→ok)도 반영하려 세 상태 모두 기록. id 슬러그는 in.() 안전. 봇 Secrets 없으면 생략. */
async function writeLinkStatus(results) {
  const ctx = await botCtx();
  if (!ctx) return;
  const now = new Date().toISOString();
  const byState = { ok: [], warn: [], dead: [] };
  for (const r of results) if (byState[r.state]) byState[r.state].push(r.p.id);
  for (const st of ["ok", "warn", "dead"]) {
    for (const ids of chunk(byState[st], 100)) {
      await ctx.rest(`platforms?id=in.(${ids.join(",")})`, {
        method: "PATCH", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ link_status: st, link_checked_at: now }),
      });
    }
  }
  console.log(`✓ 링크 상태 기록 — ok ${byState.ok.length}·warn ${byState.warn.length}·dead ${byState.dead.length}`);
}

async function notifyFavoritersOfDead(deadResults) {
  if (FIXTURE_MODE || deadResults.length === 0) return;
  const ctx = await botCtx();
  if (!ctx) return;
  const byId = new Map(deadResults.map((r) => [r.p.id, r.p]));
  const ids = [...byId.keys()];
  const favs = await ctx.rest(`favorites?alert=is.true&platform_id=in.(${ids.join(",")})&select=user_id,platform_id`);
  if (!favs.length) { console.log("죽은 링크 관심 등록자 없음 — 알림 생략"); return; }
  const notifs = favs.map((f) => ({
    user_id: f.user_id, kind: "fav_change", ref_type: "platform", ref_id: f.platform_id,
    title: "관심 플랫폼 링크 확인 필요",
    body: `${byId.get(f.platform_id)?.name ?? f.platform_id}의 링크가 접속되지 않아요 — 대체 플랫폼을 찾아보세요.`,
  }));
  await ctx.rest("notifications?on_conflict=user_id,kind,ref_id", {
    method: "POST", headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
    body: JSON.stringify(notifs),
  });
  console.log(`✓ 관심 등록자 알림 ${notifs.length}건(중복 무시)`);
}

const CONCURRENCY = 15;
const TIMEOUT = 12000;
const UA = "Mozilla/5.0 (compatible; semopl-healthcheck/1.0; +https://comdows.github.io/web1/)";

async function probe(p) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(p.url, {
        redirect: "follow", signal: AbortSignal.timeout(TIMEOUT),
        headers: { "User-Agent": UA, Accept: "text/html,*/*" },
      });
      if (res.ok || (res.status >= 300 && res.status < 400)) return { p, state: "ok" };
      if ([401, 403, 405, 429, 503, 999].includes(res.status)) return { p, state: "warn", detail: `HTTP ${res.status}(봇 차단 가능)` };
      return { p, state: "dead", detail: `HTTP ${res.status}` };
    } catch (e) {
      if (attempt === 0) continue; // 일시 오류 1회 재시도
      return { p, state: "dead", detail: e.name === "TimeoutError" ? "타임아웃" : (e.cause?.code ?? e.message) };
    }
  }
}

const list = data.platforms;
console.log(`헬스체크 시작 — ${list.length}개 URL, 동시 ${CONCURRENCY}`);
const results = [];
for (let i = 0; i < list.length; i += CONCURRENCY) {
  const batch = await Promise.all(list.slice(i, i + CONCURRENCY).map(probe));
  results.push(...batch);
  if ((i / CONCURRENCY) % 10 === 0) console.log(`  ${Math.min(i + CONCURRENCY, list.length)}/${list.length}…`);
}

const dead = results.filter((r) => r.state === "dead");
const warn = results.filter((r) => r.state === "warn");
console.log(`완료 — 정상 ${results.length - dead.length - warn.length} · 확인 필요 ${warn.length} · 접속 불가 ${dead.length}`);

const line = (r) => `- [ ] **${r.p.name}** (\`${r.p.id}\`, ${r.p.category}) — ${r.detail} — ${r.p.url}`;
const body = [
  `등재 URL 헬스체크 결과 (${new Date().toISOString().slice(0, 10)}, 총 ${list.length}개)`,
  "",
  `## ⛔ 접속 불가 ${dead.length}건 — 폐업·이전 여부 확인 후 정정/보관 처리`,
  ...dead.map(line),
  "",
  `## ⚠️ 확인 필요 ${warn.length}건 — 봇 차단 응답(실제로는 정상일 수 있음, 브라우저로 확인)`,
  ...warn.slice(0, 40).map(line),
  warn.length > 40 ? `\n(외 ${warn.length - 40}건 — 로그 참조)` : "",
].join("\n");

// GitHub Step Summary + 이슈 생성(죽은 링크가 있을 때만)
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, body + "\n");
if (dead.length > 0 && process.env.GITHUB_TOKEN && process.env.GITHUB_REPOSITORY) {
  const res = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/issues`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json" },
    body: JSON.stringify({ title: `[헬스체크] 접속 불가 ${dead.length}건 (${new Date().toISOString().slice(0, 10)})`, body, labels: ["healthcheck"] }),
  });
  console.log(res.ok ? "✓ 이슈 생성" : `이슈 생성 실패: ${res.status}`);
}

// 링크 상태를 플랫폼에 기록(신선도 배지) + 죽은 링크 관심 등록자 알림(봇 Secrets 있을 때만)
await writeLinkStatus(results);
await notifyFavoritersOfDead(dead);
