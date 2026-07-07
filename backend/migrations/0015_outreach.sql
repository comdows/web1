-- ============================================================
-- 세모플 0015 — 제휴 제안 아웃리치(회원→특정 플랫폼 직접 제안) "발송 직전"까지
-- (0001~0014 실행된 DB에 이어 실행 · 멱등)
--
-- 회원이 디렉토리의 특정 플랫폼에 제휴 방식별 제안을 작성·검토 후 발송한다.
-- ⚠️ 서버(세모플 명의) 발송은 법적 게이트 뒤 — 스위치는 이중(app_settings 'outreach' + FLAGS.outreach),
--    기본 전부 off. 켜기 전 필수 체크리스트(하나라도 미완이면 켜지 말 것):
--   ① 이메일 발송 서비스 계정 + 발신 도메인 인증(SPF/DKIM/DMARC) — Edge Function 시크릿 설정
--   ② 정보통신망법 §50 대응: 수신거부 링크 실동작 + 광고성 정보 표기 + 대표 이메일 수집 근거
--   ③ 처리방침에 아웃리치 발송·수신거부 안내 추가 + TERMS_VERSION 상향
--   ④ 발송량 상한·모니터링(스팸·평판 관리)
-- 스위치 off 동안에는 프론트가 "회원 본인 메일(mailto)"로 대신 발송한다(세모플은 발신자 아님 → 법적 안전).
-- ============================================================

-- ── 1) 아웃리치 제안 기록(발송 감사·중복 방지·현황) ──
create table if not exists public.outreach_proposals (
  id           uuid primary key default gen_random_uuid(),
  sender_id    uuid references public.profiles(id) on delete set null,
  sender_name  text not null,                     -- 발신 플랫폼 이름(제안 시점 스냅샷)
  target_platform_id text references public.platforms(id) on delete set null,
  target_name  text not null,
  target_email text not null,
  type_id      text not null,                     -- 제휴 방식(partner_types.id)
  subject      text not null,
  body         text not null,
  channel      text not null default 'self' check (channel in ('self','server')), -- self=회원 메일, server=세모플 발송
  status       text not null default 'composed' check (status in ('composed','queued','sent','failed','blocked')),
  fail_reason  text,
  created_at   timestamptz not null default now(),
  sent_at      timestamptz
);
create index if not exists idx_outreach_sender on public.outreach_proposals(sender_id, created_at desc);
alter table public.outreach_proposals enable row level security;
-- 본인 제안만 열람/기록. 서버 발송(Edge Function)은 service 컨텍스트로 상태를 갱신.
drop policy if exists "own outreach read" on public.outreach_proposals;
create policy "own outreach read" on public.outreach_proposals for select
  using (sender_id = auth.uid() or public.is_admin());
drop policy if exists "own outreach insert" on public.outreach_proposals;
create policy "own outreach insert" on public.outreach_proposals for insert
  with check (sender_id = auth.uid());

-- ── 2) 수신거부 목록(정보통신망법 §50 — 재발송 차단) ──
create table if not exists public.outreach_optout (
  email      text primary key,
  reason     text,
  created_at timestamptz not null default now()
);
alter table public.outreach_optout enable row level security;
-- 수신거부 등록은 누구나(공개 수신거부 링크), 조회는 관리자만(발송 전 대조는 서버가 수행)
drop policy if exists "public optout insert" on public.outreach_optout;
create policy "public optout insert" on public.outreach_optout for insert with check (true);
drop policy if exists "admin optout read" on public.outreach_optout;
create policy "admin optout read" on public.outreach_optout for select using (public.is_admin());

-- ── 3) 발송 남용 방지: 회원당 하루 제안 수 상한(서버 발송 시 Edge Function이 검사) ──
create or replace function public.outreach_quota_left(p_user uuid)
returns int language sql security definer stable set search_path = public as $$
  select greatest(0, 10 - (
    select count(*) from public.outreach_proposals
    where sender_id = p_user and created_at > now() - interval '1 day'
  ))::int
$$;
revoke execute on function public.outreach_quota_left(uuid) from public, anon;
grant execute on function public.outreach_quota_left(uuid) to authenticated;

-- ── 4) app_settings — 서버 발송 스위치(기본 off) + 발신 표기 ──
insert into public.app_settings (key, value) values
  ('outreach', '{"server_send": false, "from_name": "세모플 제휴", "daily_cap": 10}')
on conflict (key) do nothing;
