-- ============================================================
-- 세모플 0004 — 2·3단계 오픈 (0001~0003 실행된 DB에 이어서 실행)
-- 제휴 매칭 보드(공개 접수·검수·게시) + 거래소 매각 접수(검수·익명화 경유)
-- 원칙 유지: 연락처 컬럼 없음 · 작성자(created_by/owner)는 공개 뷰에서 차단
-- ※ 멱등(idempotent): 이미 실행된 DB에서 재실행해도 에러 없이 통과한다.
-- ============================================================

-- ── 제휴 제안(공개 보드용 — 운영자 검증 전 단계의 가벼운 접수) ──
-- proposals(운영자 검증 필수, P4)와 별개: 오픈 초기엔 로그인만으로 제안을 받고
-- 관리자 검수 후 게시한다. 게시물의 표시 이름은 작성자가 적은 반익명 이름
-- ("핸드메이드 마켓 A" 등)이며, 계정 식별자는 공개 뷰에서 제외된다.
do $$ begin
  create type ppost_status_t as enum ('pending','published','matched','rejected','closed');
exception when duplicate_object then null; end $$;

create table if not exists public.partner_posts (
  id              uuid primary key default gen_random_uuid(),
  created_by      uuid not null references public.profiles(id) on delete cascade,
  title           text not null,                                    -- 표시 이름(반익명 권장)
  category_id     text not null references public.categories(id),  -- 우리 분야
  type_id         text not null references public.partner_types(id),
  give_text       text not null default '',                        -- 제공할 것(연락처 금지)
  get_text        text not null default '',                        -- 원하는 것
  want_categories text[] not null default '{}',                    -- 원하는 상대 분야
  size_text       text not null default '',                        -- 규모 밴드
  detail          text not null default '',                        -- 한 줄 소개
  status          ppost_status_t not null default 'pending',
  review_reason   text,
  reviewed_by     uuid references public.profiles(id),
  published_at    timestamptz,
  created_at      timestamptz not null default now()
);
create index if not exists idx_ppost_status on public.partner_posts(status, published_at desc);

-- 매칭 신청(제안에 대한 응답 — 소개는 세모플이 비공개로 진행)
create table if not exists public.partner_post_interests (
  id            uuid primary key default gen_random_uuid(),
  post_id       uuid not null references public.partner_posts(id) on delete cascade,
  user_id       uuid not null references public.profiles(id) on delete cascade,
  platform_name text not null,                                     -- 신청자 플랫폼(반익명 가능)
  category_id   text references public.categories(id),
  size_text     text not null default '',
  pitch         text not null default '',                          -- 제안 요지(연락처 금지)
  status        text not null default 'pending',                   -- pending|introduced|closed
  created_at    timestamptz not null default now(),
  unique (post_id, user_id)
);
create index if not exists idx_ppint_status on public.partner_post_interests(status, created_at desc);

-- ── 거래소 매각 접수(비공개) — SOP: 접수 → 검수·익명화(관리자 재작성) → 게시 ──
-- 원문은 여기 머물고, 공개되는 deals 행은 관리자가 코드명·익명 요약으로 새로 만든다.
create table if not exists public.deal_submissions (
  id               uuid primary key default gen_random_uuid(),
  submitter_id     uuid not null references public.profiles(id) on delete cascade,
  payload          jsonb not null,               -- {category_id, region, revenue_band, mode, summary, highlights, sale_reason}
  status           submission_status_t not null default 'pending',
  review_reason    text,
  approved_deal_id text references public.deals(id),
  reviewed_by      uuid references public.profiles(id),
  reviewed_at      timestamptz,
  created_at       timestamptz not null default now()
);
create index if not exists idx_dealsub_status on public.deal_submissions(status, created_at desc);

-- ── RLS ──────────────────────────────────────────────────────
alter table public.partner_posts          enable row level security;
alter table public.partner_post_interests enable row level security;
alter table public.deal_submissions       enable row level security;

-- partner_posts: 원본은 작성자/admin만 — 공개는 아래 뷰로만(작성자 식별자 차단)
drop policy if exists "insert own ppost" on public.partner_posts;
create policy "insert own ppost" on public.partner_posts for insert
  with check (auth.uid() is not null and created_by = auth.uid());
drop policy if exists "read own ppost" on public.partner_posts;
create policy "read own ppost" on public.partner_posts for select
  using (created_by = auth.uid() or public.is_admin());
drop policy if exists "admin review ppost" on public.partner_posts;
create policy "admin review ppost" on public.partner_posts for update
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists "insert own ppost interest" on public.partner_post_interests;
create policy "insert own ppost interest" on public.partner_post_interests for insert
  with check (auth.uid() is not null and user_id = auth.uid());
drop policy if exists "read own ppost interest" on public.partner_post_interests;
create policy "read own ppost interest" on public.partner_post_interests for select
  using (user_id = auth.uid() or public.is_admin());
drop policy if exists "admin manage ppost interest" on public.partner_post_interests;
create policy "admin manage ppost interest" on public.partner_post_interests for update
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists "insert own deal submission" on public.deal_submissions;
create policy "insert own deal submission" on public.deal_submissions for insert
  with check (auth.uid() is not null and submitter_id = auth.uid());
drop policy if exists "read own deal submission" on public.deal_submissions;
create policy "read own deal submission" on public.deal_submissions for select
  using (submitter_id = auth.uid() or public.is_admin());
drop policy if exists "admin review deal submission" on public.deal_submissions;
create policy "admin review deal submission" on public.deal_submissions for update
  using (public.is_admin()) with check (public.is_admin());

-- 승인 시 관리자가 익명화된 매물을 직접 게시할 수 있어야 한다
-- (기존 "insert own deal"은 owner_id = auth.uid()만 허용 → 판매자 명의 게시 불가)
drop policy if exists "admin insert deal" on public.deals;
create policy "admin insert deal" on public.deals for insert
  with check (public.is_admin());

-- 공개 뷰: 게시/성사 건의 익명 필드만(created_by 제외) — v_deals_public과 동일 패턴
create or replace view public.v_partner_posts_public
  with (security_invoker = false) as
  select id, title, category_id, type_id, give_text, get_text, want_categories,
         size_text, detail, status, published_at::date as posted
  from public.partner_posts where status in ('published','matched');
