/* 현행 앱 데이터(app/src/data/*.json) → backend/migrations/0003_seed.sql 생성
 * 데이터가 갱신되면 재실행: node backend/seed/build-seed.mjs */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const P = JSON.parse(fs.readFileSync(path.join(ROOT, "app/src/data/platforms.json"), "utf8"));
const L = JSON.parse(fs.readFileSync(path.join(ROOT, "app/src/data/listings.json"), "utf8"));
const PT = JSON.parse(fs.readFileSync(path.join(ROOT, "app/src/data/partnerTypes.json"), "utf8"));

const q = (s) => s == null ? "null" : `'${String(s).replace(/'/g, "''")}'`;
const region = (r) => (r === "해외" ? "overseas" : "domestic");
const rows = [];
const push = (s) => rows.push(s);

push(`-- ============================================================
-- 세모플 시드 v1 — build-seed.mjs 생성물 (직접 수정 금지)
-- 그룹 ${P.groups.length} · 분야 ${P.categories.length} · 플랫폼 ${P.platforms.length}
-- ============================================================
`);

push(`insert into public.groups (id, name, icon, description, sort) values`);
push(P.groups.map((g, i) => `  (${q(g.id)}, ${q(g.name)}, ${q(g.icon)}, ${q(g.desc)}, ${i})`).join(",\n") + "\non conflict (id) do nothing;\n");

push(`insert into public.categories (id, group_id, name, icon, description, sort) values`);
push(P.categories.map((c, i) => `  (${q(c.id)}, ${q(c.group)}, ${q(c.name)}, ${q(c.icon)}, ${q(c.desc)}, ${i})`).join(",\n") + "\non conflict (id) do nothing;\n");

// 플랫폼: 1,559건 — 500건 단위 배치
const chunks = [];
for (let i = 0; i < P.platforms.length; i += 500) chunks.push(P.platforms.slice(i, i + 500));
const feeBand = (v) => (v === "low" || v === "mid" || v === "high" ? `'${v}'` : "null");
for (const chunk of chunks) {
  push(`insert into public.platforms (id, name, category_id, region, url, blurb, is_new, fee_band, fee_text, settle_text, enter_text, strength) values`);
  push(chunk.map((p) =>
    `  (${q(p.id)}, ${q(p.name)}, ${q(p.category)}, '${region(p.region)}', ${q(p.url)}, ${q(p.blurb)}, ${p.new ? "true" : "false"}, ` +
    `${feeBand(p.fee_band)}, ${q(p.fee_text)}, ${q(p.settle_text)}, ${q(p.enter_text)}, ${q(p.strength)})`
  ).join(",\n") + "\non conflict (id) do nothing;\n");
}

// 제휴 방식 카탈로그(app/src/data/partnerTypes.json — 21종·6그룹)
push(`insert into public.partner_type_groups (id, label, descr, sort) values`);
push(PT.groups.map((g, i) => `  (${q(g.id)}, ${q(g.label)}, ${q(g.desc)}, ${i})`).join(",\n") + "\non conflict (id) do nothing;\n");

const arr = (a) => `'{${(a || []).map((x) => `"${x}"`).join(",")}}'`;
push(`insert into public.partner_types (id, group_id, label, descr, mechanics, example, settlement, effort, goals, sort) values`);
push(PT.types.map((t, i) =>
  `  (${q(t.id)}, ${q(t.group)}, ${q(t.label)}, ${q(t.desc)}, ${q(t.mechanics)}, ${q(t.example)}, '${t.settlement}', '${t.effort}', ${arr(t.goals)}, ${i})`
).join(",\n") + "\non conflict (id) do nothing;\n");

// 거래소 데모 매물(익명 필드만)
const dealStatus = (s) => (s === "open" ? "open" : s === "진행중" ? "in_progress" : "closed");
push(`insert into public.deals (id, category_id, region, revenue_band, mode, summary, status, is_demo, posted) values`);
push((L.deals || []).map((d) =>
  `  (${q(d.id)}, ${q(d.category)}, '${region(d.region)}', ${q(d.revenue)}, ${q(d.mode)}, ${q(d.summary)}, '${dealStatus(d.status)}', ${d.demo ? "true" : "false"}, ${q(d.posted)})`
).join(",\n") + "\non conflict (id) do nothing;\n");

// 구독 플랜(T3 — 게이트 통과 전 active=false) · 규약: monthly_price = VAT "포함" 표시가
push(`insert into public.plans (id, label, monthly_price, descr, active, sort) values
  ('free',    'Free',    0,      '등재·제휴 프로필·배너교환형 무제한·월 무료 크레딧', true,  0),
  ('pro',     'Pro',     66000,  'B형 연결 월 3건 포함·검증 배지·우선 검수·파트너 검색 무제한', false, 1),
  ('premium', 'Premium', 220000, '매칭 매니저 큐레이션·깊은연동 우선 소개·계약 템플릿·성과 리포트', false, 2)
on conflict (id) do nothing;\n`);

// 부스트 상품(초기 3종 — 단가는 오픈 전 조정)
push(`insert into public.boost_tiers (id, name, placement, cpm, est_ctr, sort) values
  ('home_hero',   '홈 상단 고정',     '홈 히어로 아래 첫 카드 슬롯', 8000, 0.0200, 0),
  ('cat_top',     '분야 상단 노출',   '해당 분야 목록 최상단',       5000, 0.0150, 1),
  ('search_boost','검색 상위 노출',   '관련 검색결과 상단(AD 표기)', 6000, 0.0180, 2)
on conflict (id) do nothing;\n`);

const out = path.join(ROOT, "backend/migrations/0003_seed.sql");
fs.writeFileSync(out, rows.join("\n"));
console.log(`생성: ${out} (${(fs.statSync(out).size / 1024).toFixed(0)}KB)`);
