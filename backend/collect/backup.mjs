/* 주간 데이터 백업 — GitHub Actions(backup.yml)가 매주 실행.
 * Supabase에만 존재하는 사용자 생성 데이터(제안·매물·신청·계정 연결)를 JSON 스냅샷으로 내려받는다
 * — 정적 시드(platforms.json·0003)는 디렉토리 초기분만 복구 가능하므로, 이 백업이 없으면
 *   관리 오조작·마이그레이션 실수 한 번에 접수·소개 이력(introduced_at = 환불 판정 근거)이 영구 유실된다.
 *
 * 원칙: service key 불사용 — digest.mjs와 동일하게 admin 봇 JWT(RLS is_admin)로만 읽는다.
 * fail-loud: 어떤 테이블이든 조회 실패 시 throw → 런 실패 → GitHub 실패 메일.
 *   (digest의 warn-후-0 패턴 금지 — 백업에서 '조용한 부분 성공'은 백업이 없는 것보다 나쁘다.)
 *
 * 필요 Secrets: SUPABASE_URL, SUPABASE_ANON_KEY, ADMIN_BOT_EMAIL, ADMIN_BOT_PASSWORD
 *   (+ backup.yml의 BACKUP_PASSPHRASE — 아티팩트 암호화용) */

import fs from "node:fs";

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_ANON_KEY;
if (!SB_URL || !SB_KEY) throw new Error("SUPABASE_URL/SUPABASE_ANON_KEY 누락");

async function login() {
  const res = await fetch(`${SB_URL}/auth/v1/token?grant_type=password`, {
    method: "POST", headers: { apikey: SB_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email: process.env.ADMIN_BOT_EMAIL, password: process.env.ADMIN_BOT_PASSWORD }),
  });
  if (!res.ok) throw new Error(`봇 로그인 실패: ${res.status} ${await res.text()}`);
  return (await res.json()).access_token;
}

/* 센티널: 봇이 admin 롤을 상실하면 RLS가 401이 아니라 '0행 성공'을 돌려준다 —
 * 빈 백업이 정상 백업을 덮지 않도록 롤을 명시 확인하고 아니면 즉시 실패한다. */
async function assertAdmin(token) {
  const sub = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).sub;
  const res = await fetch(`${SB_URL}/rest/v1/profiles?id=eq.${sub}&select=role`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`봇 롤 확인 실패: ${res.status}`);
  const rows = await res.json();
  if (rows[0]?.role !== "admin") throw new Error(`봇 계정이 admin 롤이 아님(role=${rows[0]?.role ?? "없음"}) — 백업 불가`);
}

/* Range 페이지네이션 전량 조회 — 페이지 간 정렬 고정 필수 */
async function fetchAll(token, table, orderCol) {
  const rows = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const res = await fetch(`${SB_URL}/rest/v1/${table}?select=*&order=${orderCol}.asc`, {
      headers: { apikey: SB_KEY, Authorization: `Bearer ${token}`, Range: `${from}-${from + PAGE - 1}` },
    });
    if (!res.ok) throw new Error(`${table} 조회 실패: ${res.status} ${await res.text()}`);
    const batch = await res.json();
    rows.push(...batch);
    if (batch.length < PAGE) break;
  }
  return rows;
}

/* 백업 대상 — 사용자 생성·운영 데이터 전부(분석 events는 제외: 대용량·비핵심).
 * favorites의 admin 읽기는 0008 정책 전제. */
const TABLES = [
  ["profiles", "created_at"],
  ["submissions", "created_at"],
  ["partner_posts", "created_at"],
  ["partner_post_interests", "created_at"],
  ["deal_submissions", "created_at"],
  ["deals", "created_at"],
  ["deal_interests", "created_at"],
  ["buyer_briefs", "created_at"],
  ["operator_claims", "created_at"],
  ["favorites", "created_at"],
  ["platforms", "id"],
];

const token = await login();
await assertAdmin(token);

const out = { meta: { taken_at: new Date().toISOString(), source: SB_URL.replace(/^https?:\/\//, ""), tables: {} }, data: {} };
for (const [table, order] of TABLES) {
  const rows = await fetchAll(token, table, order);
  out.data[table] = rows;
  out.meta.tables[table] = rows.length;
  console.log(`  ${table}: ${rows.length}행`);
}

const file = `backup-${new Date().toISOString().slice(0, 10)}.json`;
fs.writeFileSync(file, JSON.stringify(out));
console.log(`백업 완료 → ${file} (${Math.round(fs.statSync(file).size / 1024)}KB)`);
