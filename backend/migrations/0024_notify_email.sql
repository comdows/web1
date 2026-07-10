-- ============================================================
-- 세모플 0024 — 알림 이메일 레이어(E-D · 게이트 기본 off)
-- (0001~0023 실행된 DB에 이어 실행 · 멱등)
--
-- 인앱 알림(0018)을 이메일로도 — send-notify-email Edge Function이 미읽음 알림을
-- 요약해 사용자당 하루 1통만 발송한다. 스위치(enabled)가 기본 false라 이 마이그레이션을
-- 실행해도 아무것도 발송되지 않는다(켜기 절차는 README — Resend·SPF/DKIM/DMARC·정보통신망법 §50).
-- ============================================================

-- ── 1) 발송 게이트 + 설정(기본 off) ──
insert into public.app_settings (key, value) values
  ('notify_email', '{"enabled": false, "daily_cap": 1, "from_name": "세모플 알림"}')
on conflict (key) do nothing;

-- ── 2) 발송 로그 — 사용자당 하루 1통 강제(unique) + 감사 ──
-- 쓰기는 Edge Function(service 컨텍스트)만. 클라이언트에는 아무 정책도 열지 않는다(admin 열람만).
create table if not exists public.notify_email_log (
  user_id    uuid not null references public.profiles(id) on delete cascade,
  sent_on    date not null default current_date,
  notif_count int not null default 0,          -- 요약에 담은 알림 수(감사용)
  created_at timestamptz not null default now(),
  primary key (user_id, sent_on)
);
alter table public.notify_email_log enable row level security;
drop policy if exists "admin notify log read" on public.notify_email_log;
create policy "admin notify log read" on public.notify_email_log for select
  using (public.is_admin());
