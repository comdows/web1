-- ============================================================
-- 세모플 0027 — 플랫폼 소식 피드(G-C)
-- (0001~0026 실행된 DB에 이어 실행 · 멱등)
--
-- 주간 수집기가 이미 읽는 뉴스 중 "기존 등재 플랫폼" 관련 기사를 플랫폼별 소식으로 연결.
-- 디렉토리를 정적 정보에서 살아있는 정보로(재방문 루프): 상세 "최근 소식" + 즐겨찾기 알림(fav_news).
-- 뉴스 제목·링크는 공개 정보라 공개 read — 쓰기는 admin(수집 봇)만.
-- ============================================================

create table if not exists public.platform_news (
  id           bigint generated always as identity primary key,
  platform_id  text not null references public.platforms(id) on delete cascade,
  title        text not null check (char_length(title) between 4 and 300),
  url          text not null unique,          -- 원문 링크 — 중복 수집 방지 키
  source       text not null default '',      -- 출처(매체명)
  published_at timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists idx_pnews_platform on public.platform_news(platform_id, published_at desc nulls last);

alter table public.platform_news enable row level security;
drop policy if exists "public news read" on public.platform_news;
create policy "public news read" on public.platform_news for select using (true);
drop policy if exists "admin news write" on public.platform_news;
create policy "admin news write" on public.platform_news for insert
  with check (public.is_admin());
drop policy if exists "admin news manage" on public.platform_news;
create policy "admin news manage" on public.platform_news for delete
  using (public.is_admin());
grant select on public.platform_news to anon, authenticated;
