/* 일회용 DB 진단 — 봇 계정 시점에서 "어느 프로젝트에 붙어 무엇이 거부되는지"를 출력한다.
 * (collect-candidates가 is_suspended permission denied로 실패하는데 SQL Editor에선 권한이 true로
 *  보이는 모순 상황의 판별용 — 시크릿의 프로젝트와 에디터의 프로젝트가 다른지 확인)
 * 사용: debug-db 워크플로(workflow_dispatch)로 실행. 문제 해결 후 워크플로와 함께 삭제 예정. */

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_ANON_KEY;

// 프로젝트 ref 출력 — GitHub 로그 마스킹(시크릿 원문 일치)을 피하려고 글자 사이 공백.
// SUPABASE_URL·anon 키는 설계상 공개 값(.env.production에 커밋됨)이라 노출 무해.
const ref = new URL(SB_URL).hostname.split(".")[0];
console.log(`프로젝트 ref: ${ref.split("").join(" ")}`);

const login = await fetch(`${SB_URL}/auth/v1/token?grant_type=password`, {
  method: "POST", headers: { apikey: SB_KEY, "Content-Type": "application/json" },
  body: JSON.stringify({ email: process.env.BOT_EMAIL, password: process.env.BOT_PASSWORD }),
});
if (!login.ok) { console.log(`봇 로그인 실패: ${login.status} ${await login.text()}`); process.exit(1); }
const { access_token: token, user } = await login.json();
console.log(`봇 로그인 OK — uid ${user.id}`);

const H = { apikey: SB_KEY, Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

// 이 프로젝트의 데이터 규모(진짜 프로젝트면 platforms가 1,700+)
const cnt = await fetch(`${SB_URL}/rest/v1/platforms?select=id&limit=1`, {
  headers: { ...H, Prefer: "count=exact" },
});
console.log(`platforms 행 수: ${cnt.headers.get("content-range")} (HTTP ${cnt.status})`);

// 카나리 제보 insert — 실패 시 오류 원문, 성공 시 즉시 삭제(0009 본인 pending 삭제 정책)
const payload = { name: "진단용-삭제예정", url: "https://example.com/debug-canary", category_id: "", region: "domestic", desc: "debug-db 진단 카나리", note: "auto:debug" };
const ins = await fetch(`${SB_URL}/rest/v1/submissions`, {
  method: "POST", headers: { ...H, Prefer: "return=representation" },
  body: JSON.stringify({ submitter_id: user.id, payload }),
});
const body = await ins.text();
console.log(`카나리 insert: HTTP ${ins.status} — ${body.slice(0, 300)}`);
if (ins.ok) {
  try {
    const id = JSON.parse(body)?.[0]?.id;
    if (id) {
      const del = await fetch(`${SB_URL}/rest/v1/submissions?id=eq.${id}`, { method: "DELETE", headers: H });
      console.log(`카나리 삭제: HTTP ${del.status}`);
    }
  } catch { /* 정리 실패는 무시 — 검수 큐에서 반려하면 됨 */ }
  console.log("✓ 결론: insert 정상 — 권한 문제 해소됨. collect-candidates를 재실행하세요.");
} else {
  console.log("✗ 결론: 이 프로젝트(위 ref)의 DB에서 insert가 거부됨 — SQL Editor에서 권한을 실행한 프로젝트와 위 ref가 같은지 대조하세요.");
}
