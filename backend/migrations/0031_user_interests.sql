-- ============================================================
-- 세모플 0031 — 로그인 관심 프로필 서버화(H-2)
-- (0001~0030 실행된 DB에 이어 실행 · 멱등)
--
-- 온보딩 관심(그룹·분야·신규선호)이 그동안 localStorage에만 있어 기기 간 단절.
-- 서버로 올려 재로그인·다른 기기에서도 홈 개인화·추천이 이어지게 한다(즐겨찾기 동기화와 동형).
-- 사용자당 1행(upsert). 본인 CRUD, admin 조회(향후 알림 개인화 활용 여지).
-- ============================================================

create table if not exists public.user_interests (
  user_id    uuid primary key references public.profiles(id) on delete cascade,
  groups     text[] not null default '{}',
  cats       text[] not null default '{}',
  new_pref   boolean not null default false,
  updated_at timestamptz not null default now()
);
alter table public.user_interests enable row level security;
drop policy if exists "own interests read" on public.user_interests;
create policy "own interests read" on public.user_interests for select
  using (user_id = auth.uid() or public.is_admin());
drop policy if exists "own interests insert" on public.user_interests;
create policy "own interests insert" on public.user_interests for insert
  with check (user_id = auth.uid() and not public.is_suspended());
drop policy if exists "own interests update" on public.user_interests;
create policy "own interests update" on public.user_interests for update
  using (user_id = auth.uid()) with check (user_id = auth.uid());
grant select, insert, update on public.user_interests to authenticated;
