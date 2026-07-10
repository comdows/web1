-- ============================================================
-- 세모플 0025 — 플랫폼 이용 후기(리뷰·평점, F-A)
-- (0001~0024 실행된 DB에 이어 실행 · 멱등)
--
-- 디렉토리의 첫 사용자 생성 콘텐츠. 원칙: ① 게시는 검수(published) 후에만 —
-- 연락처·광고·비방을 클라이언트+검수 이중 차단 ② 공개 뷰에 작성자 식별자 컬럼 자체가
-- 없음(익명 게시 — 서비스 공통 원칙) ③ 평점은 표시용일 뿐 검색 정렬 랭킹에 즉시
-- 반영하지 않음(순위 조작 유인 차단, 디렉토리 중립성).
-- ============================================================

create table if not exists public.reviews (
  id          uuid primary key default gen_random_uuid(),
  platform_id text not null references public.platforms(id) on delete cascade,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  rating      int  not null check (rating between 1 and 5),
  body        text not null check (char_length(body) between 10 and 500),
  status      text not null default 'pending' check (status in ('pending', 'published', 'hidden')),
  created_at  timestamptz not null default now(),
  reviewed_at timestamptz,
  unique (platform_id, user_id)                 -- 1인 1리뷰(수정 = 같은 행 갱신 후 재검수)
);
create index if not exists idx_reviews_platform on public.reviews(platform_id, status);
alter table public.reviews enable row level security;

-- 등록은 본인 명의로만(항상 pending으로 시작 — default가 보장, 임의 status 지정 차단)
drop policy if exists "own review insert" on public.reviews;
create policy "own review insert" on public.reviews for insert
  with check (user_id = auth.uid() and status = 'pending');
-- 원본 행 열람은 본인 + admin(검수). 공개 노출은 아래 뷰로만.
drop policy if exists "own review read" on public.reviews;
create policy "own review read" on public.reviews for select
  using (user_id = auth.uid() or public.is_admin());
-- 본인 수정은 재검수 강제: 수정 결과는 반드시 pending — 게시 후 몰래 바꿔치기 방지
drop policy if exists "own review update" on public.reviews;
create policy "own review update" on public.reviews for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and status = 'pending');
-- 검수(게시/숨김)는 admin
drop policy if exists "admin review moderate" on public.reviews;
create policy "admin review moderate" on public.reviews for update
  using (public.is_admin()) with check (public.is_admin());

-- 공개 후기 뷰 — published만, 작성자 식별자 컬럼 없음(definer)
create or replace view public.v_reviews_public
  with (security_invoker = false) as
  select platform_id, rating, body, created_at
  from public.reviews
  where status = 'published'
  order by created_at desc;
grant select on public.v_reviews_public to anon, authenticated;

-- 평점 집계 뷰 — 카드·상세 표시용(정렬 랭킹 반영 아님)
create or replace view public.v_review_stats
  with (security_invoker = false) as
  select platform_id, round(avg(rating)::numeric, 1) as avg_rating, count(*) as review_count
  from public.reviews
  where status = 'published'
  group by platform_id;
grant select on public.v_review_stats to anon, authenticated;
