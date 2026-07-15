-- ============================================================
-- 세모플 0030 — 저장된 검색 + 조건 매칭 알림(H-1)
-- (0001~0029 실행된 DB에 이어 실행 · 멱등)
--
-- 검색 조건(분야·지역·수수료대·키워드)을 저장·구독 → 조건에 맞는 신규 플랫폼이 등재되면
-- 주간 notify.mjs가 인앱 알림(search_match)을 생성. 일회성 조회를 "이 분야 모니터링"으로 전환.
-- 생성은 본인, 알림 생성은 admin 봇(notifications 정책 재사용). 사용자당 상한 20.
-- ============================================================

create table if not exists public.saved_searches (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references public.profiles(id) on delete cascade,
  label            text not null check (char_length(label) between 1 and 80),
  criteria         jsonb not null default '{}'::jsonb,   -- {q?, cats?:[], region?, onlyNew?, fees?:[]}
  last_notified_at timestamptz,
  created_at       timestamptz not null default now(),
  unique (user_id, label)                                 -- 같은 이름 중복 저장 방지(재저장은 409)
);
create index if not exists idx_saved_searches_user on public.saved_searches(user_id, created_at desc);

-- 상한 카운터(정책 내 동일 테이블 서브쿼리의 RLS 재귀 회피 — 0009/0028 definer 카운터 패턴)
create or replace function public.my_saved_count()
returns integer language sql stable security definer set search_path = public as $$
  select count(*)::int from public.saved_searches where user_id = auth.uid();
$$;
revoke execute on function public.my_saved_count() from public, anon;
grant execute on function public.my_saved_count() to authenticated;

alter table public.saved_searches enable row level security;
drop policy if exists "own saved insert" on public.saved_searches;
create policy "own saved insert" on public.saved_searches for insert
  with check (user_id = auth.uid() and not public.is_suspended() and public.my_saved_count() < 20);
drop policy if exists "own saved read" on public.saved_searches;
create policy "own saved read" on public.saved_searches for select
  using (user_id = auth.uid() or public.is_admin());   -- admin: notify 봇이 전 조건 조회
drop policy if exists "own saved update" on public.saved_searches;
create policy "own saved update" on public.saved_searches for update
  using (user_id = auth.uid() or public.is_admin()) with check (user_id = auth.uid() or public.is_admin());
drop policy if exists "own saved delete" on public.saved_searches;
create policy "own saved delete" on public.saved_searches for delete
  using (user_id = auth.uid());
grant select, insert, update, delete on public.saved_searches to authenticated;
