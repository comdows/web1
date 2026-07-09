-- ============================================================
-- 세모플 0018 — 인앱 알림(리텐션 루프 C1)
-- (0001~0017 실행된 DB에 이어 실행 · 멱등)
--
-- "매칭돼도 접속해야만 확인" 문제 해소의 1단계 — 오프사이트 인프라(이메일) 없이 즉시 동작하는 인앱 알림.
--   · 생성은 admin(봇)만(notify.mjs 잡이 매칭을 계산해 insert). 사용자는 본인 알림만 읽기/읽음처리.
--   · unique(user_id, kind, ref_id) → 잡 재실행 시 같은 매칭 중복 방지(멱등).
-- 이후 C3에서 동일 데이터를 이메일로도 발송(게이트 뒤, 기본 off).
-- ============================================================

create table if not exists public.notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  kind       text not null,                    -- 'deal_match' | 'proposal' | 'fav_change' …
  ref_type   text,                             -- 'deal' | 'platform' | 'partner_post' …
  ref_id     text,                             -- 대상 식별자(중복 방지 키)
  title      text not null,
  body       text not null default '',
  url        text,                             -- 클릭 시 이동(?view=… 상대경로)
  read_at    timestamptz,
  created_at timestamptz not null default now(),
  unique (user_id, kind, ref_id)
);
create index if not exists idx_notif_user   on public.notifications(user_id, created_at desc);
create index if not exists idx_notif_unread on public.notifications(user_id) where read_at is null;

alter table public.notifications enable row level security;
-- 본인 알림만 열람(관리자는 운영상 열람 가능)
drop policy if exists "own notif read" on public.notifications;
create policy "own notif read" on public.notifications for select
  using (user_id = auth.uid() or public.is_admin());
-- 본인 알림만 읽음 처리(update) — user_id 변경 불가
drop policy if exists "own notif update" on public.notifications;
create policy "own notif update" on public.notifications for update
  using (user_id = auth.uid()) with check (user_id = auth.uid());
-- 생성은 admin(봇)만 — 사용자가 임의 알림을 만들지 못하게
drop policy if exists "admin notif insert" on public.notifications;
create policy "admin notif insert" on public.notifications for insert
  with check (public.is_admin());
