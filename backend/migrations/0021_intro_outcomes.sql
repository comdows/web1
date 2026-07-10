-- ============================================================
-- 세모플 0021 — 소개 후 성사·후기 회수 루프(D3b)
-- (0001~0020 실행된 DB에 이어 실행 · 멱등)
--
-- 소개(introduced)가 흐름의 끝이던 것을, "도움이 됐나요/성사됐나요" 회수로 확장 → 성사율·품질 지표.
--   · 성공보수·거래액 연동 아님(품질 신호만). 자유서술 최소·구조화 선택지 위주(익명·비방 리스크 관리).
--   · 본인 응답만 기록/열람/수정(관리자는 집계 열람). unique로 응답 1건(재응답=갱신).
-- ============================================================

create table if not exists public.intro_outcomes (
  id         uuid primary key default gen_random_uuid(),
  ref_type   text not null check (ref_type in ('partner', 'deal')),
  ref_id     text not null,                     -- 관심(interest) id
  user_id    uuid not null references public.profiles(id) on delete cascade,
  outcome    text not null check (outcome in ('progressing', 'success', 'no')),
  note       text not null default '',
  created_at timestamptz not null default now(),
  unique (ref_type, ref_id, user_id)
);
create index if not exists idx_intro_outcomes_user on public.intro_outcomes(user_id, created_at desc);

alter table public.intro_outcomes enable row level security;
drop policy if exists "own outcome read" on public.intro_outcomes;
create policy "own outcome read" on public.intro_outcomes for select
  using (user_id = auth.uid() or public.is_admin());
drop policy if exists "own outcome insert" on public.intro_outcomes;
create policy "own outcome insert" on public.intro_outcomes for insert
  with check (user_id = auth.uid());
drop policy if exists "own outcome update" on public.intro_outcomes;
create policy "own outcome update" on public.intro_outcomes for update
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- 관리자 성사율 요약(admin 전용 — 뷰 내부 is_admin 가드, 0017 패턴)
create or replace view public.v_intro_success as
select
  count(*)                                          as responded,
  count(*) filter (where outcome = 'success')       as success,
  count(*) filter (where outcome = 'progressing')   as progressing,
  count(*) filter (where outcome = 'no')            as no_deal
from public.intro_outcomes
where public.is_admin();
