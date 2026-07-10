-- ============================================================
-- 세모플 백엔드 전체 마이그레이션 (한 번에 실행용)
-- 구성: 0001~0014 + 0015 아웃리치
-- ============================================================

-- ============================================================
-- 세모플 DB 스키마 v1  (Supabase/Postgres)
-- 기준: redesign/handoff/API Spec.md (v0.9)
-- 미래 기능(검수·라이프사이클·클레임·제휴·거래소·부스트·분석)을 선반영.
-- 실행 순서: 0001_schema.sql → 0002_policies.sql → 0003_seed.sql
-- ============================================================

create extension if not exists pg_trgm;        -- 한국어 부분일치 검색(ilike + trgm 인덱스)

-- ── Enums (영문 코드; 한국어 라벨은 프론트 담당) ──────────────
create type region_t            as enum ('domestic','overseas');            -- 국내/해외
create type fee_band_t          as enum ('low','mid','high');               -- 수수료대
create type lifecycle_t         as enum ('soon','review','verified','matched','rejected');
create type submission_status_t as enum ('pending','hold','approved','rejected');
create type collection_t        as enum ('interest','review','plan');       -- 관심/검토중/입점예정
create type proposal_status_t   as enum ('pending','accepted','rejected','withdrawn');
create type claim_method_t      as enum ('email','dns','meta','doc');       -- 도메인 이메일/DNS/메타태그/서류
create type claim_status_t      as enum ('pending','code_sent','verified','rejected');
create type deal_status_t       as enum ('open','in_progress','closed');
create type boost_status_t      as enum ('draft','review','active','paused','done','rejected');
create type role_t              as enum ('user','operator','admin');
create type event_t             as enum ('impression','click','outbound','favorite','search');

-- ── 공통 트리거: updated_at 자동 갱신 ─────────────────────────
create or replace function public.tg_touch_updated_at() returns trigger
language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

-- ============================================================
-- 1) 사용자 / 역할
-- ============================================================
create table public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  role         role_t not null default 'user',
  display_name text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create trigger touch_profiles before update on public.profiles
  for each row execute function public.tg_touch_updated_at();

-- auth.users 생성 시 프로필 자동 생성
create or replace function public.tg_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'name', split_part(new.email,'@',1)))
  on conflict (id) do nothing;
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.tg_new_user();

-- ============================================================
-- 2) 분류 체계 (현행 5그룹 · 35분야 유지)
-- ============================================================
create table public.groups (
  id          text primary key,          -- 'commerce' 등 (현행 slug 유지)
  name        text not null,
  icon        text not null default '',
  description text not null default '',
  sort        int  not null default 0
);

create table public.categories (
  id          text primary key,          -- 'openmarket' 등
  group_id    text not null references public.groups(id),
  name        text not null,
  icon        text not null default '',
  description text not null default '',
  sort        int  not null default 0
);
create index idx_categories_group on public.categories(group_id);

-- ============================================================
-- 3) 플랫폼 (디렉토리 본체 — 리치 필드 선반영)
-- ============================================================
create table public.platforms (
  id          text primary key,                      -- 현행 slug id 유지 ('coupang')
  name        text not null,
  category_id text not null references public.categories(id),
  region      region_t not null default 'domestic',
  url         text not null,
  blurb       text not null default '',              -- 개략 소개(중립·사실)
  is_new      boolean not null default false,        -- 🆕 배지
  -- 리치 필드(핸드오프 상세/비교 화면용, 조사 완료 전까지 null 허용)
  verified    boolean not null default false,        -- 검증 배지(공식 확인)
  lifecycle   lifecycle_t not null default 'verified',
  fee_band    fee_band_t,                            -- 수수료대(낮음/중간/높음)
  fee_text    text,                                  -- 표시용 "~4–10.8%"
  settle_text text,                                  -- 정산주기
  enter_text  text,                                  -- 입점조건
  strength    text,                                  -- 한 줄 강점(근거 검수 후)
  pros        text[] not null default '{}',          -- admin만 기록(명예훼손 방지)
  cons        text[] not null default '{}',
  year        int,                                   -- 디렉토리 등록연도
  logo_url    text,                                  -- 파비콘 대체용(선택)
  archived_at timestamptz,                           -- soft delete
  created_by  uuid references public.profiles(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create trigger touch_platforms before update on public.platforms
  for each row execute function public.tg_touch_updated_at();
create index idx_platforms_category  on public.platforms(category_id);
create index idx_platforms_lifecycle on public.platforms(lifecycle) where archived_at is null;
create index idx_platforms_new       on public.platforms(is_new) where is_new;
create index idx_platforms_name_trgm  on public.platforms using gin (name gin_trgm_ops);
create index idx_platforms_blurb_trgm on public.platforms using gin (blurb gin_trgm_ops);

-- 분야별 수수료 상세(상세 페이지 표)
create table public.platform_fees (
  id          bigint generated always as identity primary key,
  platform_id text not null references public.platforms(id) on delete cascade,
  label       text not null,     -- '가전·디지털'
  fee_text    text not null,     -- '~5–8%'
  note        text not null default '',
  source_url  text,              -- 근거 링크(공식 약관) — 신뢰 원칙
  sort        int not null default 0
);
create index idx_pfees_platform on public.platform_fees(platform_id);

-- ============================================================
-- 4) 제보/검수 (Submission) + 라이프사이클 감사로그
-- ============================================================
create table public.submissions (
  id            uuid primary key default gen_random_uuid(),
  -- 제보 내용(연락처 저장 금지 — 프론트 안내 + 검수 체크리스트)
  payload       jsonb not null,                       -- {name, category_id, region, url, desc, fee?...}
  submitter_id  uuid references public.profiles(id),  -- 비로그인 제보는 null(GitHub 이슈 경유 등)
  status        submission_status_t not null default 'pending',
  dup_suspect_platform_id text references public.platforms(id),
  approved_platform_id    text references public.platforms(id), -- 승인 시 생성된 플랫폼
  review_reason text,
  reviewed_by   uuid references public.profiles(id),
  reviewed_at   timestamptz,
  created_at    timestamptz not null default now()
);
create index idx_submissions_status on public.submissions(status, created_at desc);

-- 라이프사이클 상태머신: 허용 전이 정의(스펙 §3)
create or replace function public.lifecycle_allowed(p_from lifecycle_t, p_to lifecycle_t)
returns boolean language sql immutable as $$
  select (p_from, p_to) in (
    ('soon','review'), ('soon','rejected'),
    ('review','verified'), ('review','soon'), ('review','rejected'),
    ('verified','matched'), ('verified','review'),
    ('matched','verified'),
    ('rejected','soon')
  );
$$;

create table public.lifecycle_transitions (
  id          bigint generated always as identity primary key,
  platform_id text not null references public.platforms(id) on delete cascade,
  from_state  lifecycle_t not null,
  to_state    lifecycle_t not null,
  reason      text,
  actor_id    uuid references public.profiles(id),
  created_at  timestamptz not null default now()
);
create index idx_transitions_platform on public.lifecycle_transitions(platform_id, created_at desc);

-- 전이 RPC: 검증 + 적용 + 감사로그를 한 트랜잭션으로
create or replace function public.transition_platform(p_platform text, p_to lifecycle_t, p_reason text default null)
returns public.platforms language plpgsql security definer set search_path = public as $$
declare v_from lifecycle_t; v_row public.platforms;
begin
  if not public.is_admin() then raise exception 'FORBIDDEN'; end if;
  select lifecycle into v_from from public.platforms where id = p_platform for update;
  if v_from is null then raise exception 'NOT_FOUND'; end if;
  if not public.lifecycle_allowed(v_from, p_to) then
    raise exception 'INVALID_TRANSITION: % -> %', v_from, p_to;
  end if;
  update public.platforms set lifecycle = p_to where id = p_platform returning * into v_row;
  insert into public.lifecycle_transitions (platform_id, from_state, to_state, reason, actor_id)
  values (p_platform, v_from, p_to, p_reason, auth.uid());
  return v_row;
end $$;

-- ============================================================
-- 5) 즐겨찾기 (컬렉션·메모·알림 — 핸드오프 Favorites 화면)
-- ============================================================
create table public.favorites (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  platform_id text not null references public.platforms(id) on delete cascade,
  collection  collection_t not null default 'interest',
  memo        text not null default '',
  alert       boolean not null default false,        -- 변경 알림 수신
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (user_id, platform_id)
);
create trigger touch_favorites before update on public.favorites
  for each row execute function public.tg_touch_updated_at();
create index idx_favorites_user on public.favorites(user_id, collection);

-- ============================================================
-- 6) 운영자 소유권 (클레임 → 권한)
-- ============================================================
create table public.operator_claims (
  id             uuid primary key default gen_random_uuid(),
  platform_id    text not null references public.platforms(id) on delete cascade,
  user_id        uuid not null references public.profiles(id) on delete cascade,
  method         claim_method_t not null default 'email',
  business_email text,                     -- 도메인 일치 검증용(플랫폼 도메인 이메일)
  token          text,                     -- 인증 코드/DNS·메타 토큰 (Edge Function이 발급·검증)
  status         claim_status_t not null default 'pending',
  reviewed_by    uuid references public.profiles(id),
  created_at     timestamptz not null default now(),
  verified_at    timestamptz
);
create index idx_claims_platform on public.operator_claims(platform_id, status);

create table public.platform_operators (      -- 클레임 승인 시 부여되는 권한
  platform_id text not null references public.platforms(id) on delete cascade,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  granted_at  timestamptz not null default now(),
  primary key (platform_id, user_id)
);
create index idx_pops_user on public.platform_operators(user_id);

create or replace function public.is_operator_of(p_platform text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.platform_operators
                 where platform_id = p_platform and user_id = auth.uid());
$$;

-- ============================================================
-- 7) 제휴 매칭 (stage2 — 유형·제안)
-- ============================================================
create type settlement_t as enum ('none','direct','share');   -- 정산 없음/당사자 직접/비용 분담
create type effort_t     as enum ('light','mid','heavy');

create table public.partner_type_groups (   -- 제휴 방식 대분류(트래픽 교환·회원 성장 등)
  id    text primary key,
  label text not null,
  descr text not null default '',
  sort  int not null default 0
);

create table public.partner_types (          -- 제휴 방식 카탈로그(배너 맞교환·레퍼럴 등)
  id         text primary key,               -- 'banner_swap','referral_fee' 등
  group_id   text not null references public.partner_type_groups(id),
  label      text not null,
  descr      text not null default '',       -- 한 줄 정의
  mechanics  text not null default '',       -- 작동 방식
  example    text not null default '',       -- 예시
  settlement settlement_t not null default 'none',
  effort     effort_t not null default 'light',
  goals      text[] not null default '{}',   -- growth/revenue/awareness/content/cost
  sort       int not null default 0
);

create table public.proposals (
  id               uuid primary key default gen_random_uuid(),
  from_platform_id text not null references public.platforms(id),
  to_platform_id   text not null references public.platforms(id),
  type_id          text not null references public.partner_types(id),
  give_text        text not null default '',   -- 우리가 제공(공개 지면 — 개인정보 금지)
  get_text         text not null default '',   -- 상대에게 원하는 것
  size_text        text not null default '',   -- 규모 밴드
  status           proposal_status_t not null default 'pending',
  introduced_at    timestamptz,                -- 소개 실행(연락처 상호 공유) 시점 = 연결료 과금 트리거
  created_by       uuid not null references public.profiles(id),
  created_at       timestamptz not null default now(),
  responded_at     timestamptz,
  check (from_platform_id <> to_platform_id)
);
create index idx_proposals_from on public.proposals(from_platform_id, status);
create index idx_proposals_to   on public.proposals(to_platform_id, status);

-- ============================================================
-- 8) 거래소 (stage3 — 익명 매물; 연락처 컬럼 없음이 설계 원칙)
-- ============================================================
create table public.deals (
  id           text primary key,                        -- 'D-101' 코드명(익명)
  category_id  text not null references public.categories(id),
  region       region_t not null default 'domestic',
  revenue_band text not null,                            -- '연매출 1~5억'
  mode         text not null,                            -- '지분 전량 매각' 등
  summary      text not null,                            -- 익명 요약(익명성 규칙 검수 통과분)
  highlights   text[] not null default '{}',             -- 범주·밴드 표현만 ("작가 풀 보유" 등)
  sale_reason  text,                                     -- 매각 사유(선택, 신뢰 재료)
  -- 희망 가격 컬럼은 의도적으로 없음: 가격은 소개 후 당사자 협상(가격 개입 = 중개 인상 → 금지)
  status       deal_status_t not null default 'open',
  is_demo      boolean not null default false,
  owner_id     uuid references public.profiles(id),      -- 등록자(비공개; RLS로 보호)
  posted       date not null default current_date,
  created_at   timestamptz not null default now()
);
create index idx_deals_status on public.deals(status, posted desc);

create table public.buyer_briefs (                       -- 인수 희망 브리프(수요 풀)
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  categories  text[] not null default '{}',              -- 관심 분야(category id)
  budget_band text not null,                             -- 예산 밴드('~1억','1~5억'…)
  mode        text not null default '',                  -- 희망 형태(지분/자산 등)
  entity      text not null default '',                  -- 주체(개인/법인)
  note        text not null default '',                  -- 소개(연락처 금지)
  active      boolean not null default true,             -- 신규 매물 알림 대상
  created_at  timestamptz not null default now()
);
create index idx_briefs_active on public.buyer_briefs(active) where active;

create table public.deal_interests (                     -- 인수 관심(소개 요청)
  id         uuid primary key default gen_random_uuid(),
  deal_id    text not null references public.deals(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  intro      text not null default '',                   -- 소개(연락처 금지 안내)
  status     text not null default 'pending',            -- pending|introduced|closed
  created_at timestamptz not null default now(),
  unique (deal_id, user_id)
);

-- ============================================================
-- 9) 부스트 (광고 상품·주문 — 자금 미보유: 기록만, 결제는 외부)
-- ============================================================
create table public.boost_tiers (
  id         text primary key,          -- 'home_hero' 등
  name       text not null,             -- '홈 상단 고정'
  placement  text not null,             -- 노출 위치 설명
  cpm        int  not null,             -- 1천 노출당 단가(원)
  est_ctr    numeric(5,4) not null default 0.01,
  sort       int not null default 0,
  active     boolean not null default true
);

create table public.boost_orders (
  id              uuid primary key default gen_random_uuid(),
  platform_id     text not null references public.platforms(id),
  tier_id         text not null references public.boost_tiers(id),
  daily_budget    int not null check (daily_budget > 0),
  days            int not null check (days between 1 and 90),
  addons          text[] not null default '{}',
  est_impressions int not null default 0,
  est_clicks      int not null default 0,
  total           int not null default 0,
  status          boost_status_t not null default 'review',
  created_by      uuid not null references public.profiles(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create trigger touch_boost_orders before update on public.boost_orders
  for each row execute function public.tg_touch_updated_at();
create index idx_boost_platform on public.boost_orders(platform_id, status);

-- 견적 RPC(프론트 계산과 단일 소스)
create or replace function public.estimate_boost(p_tier text, p_daily_budget int, p_days int, p_addons text[] default '{}')
returns table (est_impressions int, est_clicks int, total int)
language sql stable as $$
  select
    ((p_daily_budget::numeric / t.cpm) * 1000 * p_days)::int,
    ((p_daily_budget::numeric / t.cpm) * 1000 * p_days * t.est_ctr)::int,
    (p_daily_budget * p_days * (1 + 0.1 * coalesce(array_length(p_addons,1),0)))::int
  from public.boost_tiers t where t.id = p_tier;
$$;

-- ============================================================
-- 9.5) 과금 (stage2-monetization-plan.md — 3층 하이브리드)
--  ⚠️ 자금 미보유 원칙: 여기 기록되는 금액은 전부 "세모플 명의 서비스 이용료"
--     (연결료·노출·구독·리스팅료)이며, 제휴·M&A 대금은 절대 다루지 않는다.
--  과금 트리거 = proposals.introduced_at (소개 실행 시점, 성사 아님)
-- ============================================================
create type charge_kind_t   as enum ('connection_fee','boost','subscription','listing_fee','success_report'); -- success_report=성사 자진신고 보상 기록(과금 아님, 배지·할인 근거)
create type charge_status_t as enum ('quoted','invoiced','paid','waived','refunded','canceled');
create type sub_status_t    as enum ('active','past_due','canceled');

create table public.plans (                    -- 구독 멤버십(T3)
  id            text primary key,              -- 'free','pro','premium'
  label         text not null,
  monthly_price int  not null default 0,       -- VAT 별도(원)
  descr         text not null default '',
  active        boolean not null default false,-- 게이트 통과 전 false(예고만)
  sort          int not null default 0
);

create table public.subscriptions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  plan_id    text not null references public.plans(id),
  status     sub_status_t not null default 'active',
  started_at timestamptz not null default now(),
  ends_at    timestamptz
);
create index idx_subs_user on public.subscriptions(user_id, status);

create table public.credit_ledger (            -- 선불 크레딧 지갑(연결료 차감·환급) — 합계=잔액
  id         bigint generated always as identity primary key,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  delta      int not null,                     -- +충전/보너스/환급, -차감
  reason     text not null,                    -- 'topup','bonus','connection_fee','refund','free_monthly'
  ref_id     uuid,                             -- 관련 charge/proposal id
  created_at timestamptz not null default now()
);
create index idx_credit_user on public.credit_ledger(user_id, created_at desc);

create table public.charges (                  -- 세모플 이용료 청구·수납 기록(세금계산서 근거)
  id          uuid primary key default gen_random_uuid(),
  kind        charge_kind_t not null,
  user_id     uuid not null references public.profiles(id),
  platform_id text references public.platforms(id),
  proposal_id uuid references public.proposals(id),  -- connection_fee의 근거(소개 실행 건)
  deal_id     text references public.deals(id),      -- listing_fee의 근거(3단계)
  amount      int not null check (amount >= 0),      -- 공급가(원)
  vat         int not null default 0,                -- 부가세(원)
  status      charge_status_t not null default 'quoted',
  invoice_no  text,                                  -- 세금계산서 번호(자동발행 API 연동)
  memo        text,
  created_at  timestamptz not null default now(),
  paid_at     timestamptz
);
create index idx_charges_user on public.charges(user_id, status, created_at desc);

-- ============================================================
-- 10) 분석 이벤트 (append-only) + 집계 뷰
-- ============================================================
create table public.events (
  id          bigint generated always as identity primary key,
  type        event_t not null,
  platform_id text references public.platforms(id) on delete set null,
  query       text,                          -- type='search'일 때
  session_id  text,                          -- 익명 세션(uuid 문자열)
  user_id     uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now()
);
create index idx_events_platform on public.events(platform_id, type, created_at desc);
create index idx_events_search   on public.events(created_at desc) where type = 'search';
-- 트래픽 증가 시: created_at 기준 월별 파티셔닝으로 전환(스키마 변경 없이 신규 테이블 교체 가능)

-- 홈 스탯(스펙 GET /stats)
create or replace view public.v_stats as
select
  (select count(*) from public.platforms where archived_at is null)                   as platforms,
  (select count(*) from public.categories)                                            as categories,
  (select count(*) from public.platforms where is_new and archived_at is null)        as new_count;

-- 인기 검색어(최근 7일)
create or replace view public.v_popular_searches as
select query, count(*) as cnt
from public.events
where type = 'search' and query is not null and created_at > now() - interval '7 days'
group by query order by cnt desc limit 20;

-- 운영자 콘솔 지표(최근 N일 노출/클릭)
create or replace function public.platform_metrics(p_platform text, p_days int default 7)
returns table (day date, impressions bigint, clicks bigint)
language sql stable as $$
  select d::date,
    count(*) filter (where e.type = 'impression'),
    count(*) filter (where e.type in ('click','outbound'))
  from generate_series(current_date - (p_days-1), current_date, interval '1 day') d
  left join public.events e on e.platform_id = p_platform and e.created_at::date = d::date
  group by d order by d;
$$;

-- ============================================================
-- 11) 추천 RPC (온보딩 — 스펙 GET /recommendations)
-- ============================================================
create or replace function public.recommend_platforms(
  p_categories text[] default '{}', p_groups text[] default '{}',
  p_prefer_new boolean default false, p_limit int default 12
) returns setof public.platforms
language sql stable as $$
  select p.* from public.platforms p
  join public.categories c on c.id = p.category_id
  where p.archived_at is null
    and (coalesce(array_length(p_categories,1),0) = 0 or p.category_id = any(p_categories))
    and (coalesce(array_length(p_groups,1),0) = 0 or c.group_id = any(p_groups))
  order by (case when p_prefer_new and p.is_new then 0 else 1 end),
           p.verified desc, p.name
  limit p_limit;
$$;

-- ============================================================
-- 세모플 RLS 정책 v1 — 권한의 단일 원천 (0001 다음에 실행)
-- 역할: anon(비로그인) / user / operator(플랫폼 소유) / admin
-- ============================================================

-- 역할 헬퍼
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin');
$$;

-- ── profiles ─────────────────────────────────────────────────
alter table public.profiles enable row level security;
create policy "own profile read"  on public.profiles for select using (id = auth.uid() or public.is_admin());
create policy "own profile write" on public.profiles for update using (id = auth.uid())
  with check (id = auth.uid() and role = (select role from public.profiles where id = auth.uid()));
  -- role 자체 변경은 불가(관리자 지정은 SQL/서비스 키로만)

-- ── 공개 읽기: 분류·플랫폼·수수료·제휴유형·부스트상품 ─────────
alter table public.groups         enable row level security;
alter table public.categories     enable row level security;
alter table public.platforms      enable row level security;
alter table public.platform_fees  enable row level security;
alter table public.partner_type_groups enable row level security;
alter table public.partner_types  enable row level security;
alter table public.boost_tiers    enable row level security;

create policy "public read groups"     on public.groups     for select using (true);
create policy "public read categories" on public.categories for select using (true);
create policy "public read platforms"  on public.platforms  for select
  using (archived_at is null and lifecycle <> 'rejected' or public.is_admin());
create policy "public read fees"       on public.platform_fees for select using (true);
create policy "public read ptype groups" on public.partner_type_groups for select using (true);
create policy "public read ptypes"     on public.partner_types for select using (true);
create policy "public read tiers"      on public.boost_tiers   for select using (active or public.is_admin());

-- 플랫폼 쓰기: admin 전면 / operator는 소유 플랫폼의 제한 필드만(뷰·RPC로 검수 경유 권장)
create policy "admin write platforms" on public.platforms for all
  using (public.is_admin()) with check (public.is_admin());
create policy "admin write fees" on public.platform_fees for all
  using (public.is_admin()) with check (public.is_admin());
create policy "admin write taxonomy g" on public.groups for all
  using (public.is_admin()) with check (public.is_admin());
create policy "admin write taxonomy c" on public.categories for all
  using (public.is_admin()) with check (public.is_admin());
create policy "admin write ptype groups" on public.partner_type_groups for all
  using (public.is_admin()) with check (public.is_admin());
create policy "admin write ptypes" on public.partner_types for all
  using (public.is_admin()) with check (public.is_admin());
create policy "admin write tiers" on public.boost_tiers for all
  using (public.is_admin()) with check (public.is_admin());

-- ── submissions: 로그인 사용자 제보, 본인 조회, admin 검수 ────
alter table public.submissions enable row level security;
create policy "insert own submission" on public.submissions for insert
  with check (auth.uid() is not null and submitter_id = auth.uid());
create policy "read own submission" on public.submissions for select
  using (submitter_id = auth.uid() or public.is_admin());
create policy "admin review submission" on public.submissions for update
  using (public.is_admin()) with check (public.is_admin());

-- ── lifecycle_transitions: admin 전용(기록은 RPC가 수행) ──────
alter table public.lifecycle_transitions enable row level security;
create policy "admin read transitions" on public.lifecycle_transitions for select using (public.is_admin());

-- ── favorites: 소유자 전용 ────────────────────────────────────
alter table public.favorites enable row level security;
create policy "own favorites" on public.favorites for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ── operator_claims / platform_operators ─────────────────────
alter table public.operator_claims    enable row level security;
alter table public.platform_operators enable row level security;
create policy "insert own claim" on public.operator_claims for insert
  with check (user_id = auth.uid());
create policy "read own claim" on public.operator_claims for select
  using (user_id = auth.uid() or public.is_admin());
create policy "admin review claim" on public.operator_claims for update
  using (public.is_admin()) with check (public.is_admin());
create policy "read own operatorship" on public.platform_operators for select
  using (user_id = auth.uid() or public.is_admin());
create policy "admin grant operatorship" on public.platform_operators for all
  using (public.is_admin()) with check (public.is_admin());

-- ── proposals: 관련 운영자(보낸/받는 쪽) + admin ──────────────
alter table public.proposals enable row level security;
create policy "operator send proposal" on public.proposals for insert
  with check (created_by = auth.uid() and public.is_operator_of(from_platform_id));
create policy "related read proposal" on public.proposals for select
  using (public.is_operator_of(from_platform_id) or public.is_operator_of(to_platform_id) or public.is_admin());
create policy "receiver respond proposal" on public.proposals for update
  using (public.is_operator_of(to_platform_id) or public.is_admin())
  with check (public.is_operator_of(to_platform_id) or public.is_admin());

-- ── deals: 익명성 보장 — 공개는 v_deals_public 뷰로만, 원본 테이블은 소유자/admin 전용 ──
-- 중요: 3단계 익명성은 사업모델의 핵심(stage3-exchange-plan §1). PostgREST는 원본
-- 테이블(/rest/v1/deals)도 직접 노출하므로, 공개 정책이 열려 있으면 anon이 owner_id를
-- 직접 조회해 매도자 신원을 역추적할 수 있다. 따라서 원본은 소유자/admin만 읽고,
-- 익명 컬럼만 담은 v_deals_public 뷰(소유자 권한 실행 → base RLS 우회)를 공개 창구로 쓴다.
alter table public.deals          enable row level security;
alter table public.deal_interests enable row level security;
-- 구버전(0002) 정책이 남아 있으면 permissive SELECT 정책이 OR로 병합돼 익명성 누수가
-- 되살아난다. 업그레이드/재실행 시에도 안전하도록 먼저 삭제한 뒤 재생성.
drop policy if exists "public read open deals" on public.deals;
drop policy if exists "own or admin read deal" on public.deals;
create policy "own or admin read deal" on public.deals for select
  using (owner_id = auth.uid() or public.is_admin());
create policy "insert own deal" on public.deals for insert
  with check (auth.uid() is not null and owner_id = auth.uid());
create policy "own or admin update deal" on public.deals for update
  using (owner_id = auth.uid() or public.is_admin())
  with check (owner_id = auth.uid() or public.is_admin());
create policy "insert own interest" on public.deal_interests for insert
  with check (user_id = auth.uid());
create policy "read own interest" on public.deal_interests for select
  using (user_id = auth.uid() or public.is_admin());
create policy "admin manage interest" on public.deal_interests for update
  using (public.is_admin()) with check (public.is_admin());

-- 익명 공개 뷰(owner_id 등 내부 필드 제외) — 프론트는 이 뷰만 읽는다.
-- security_invoker=false(소유자 권한 실행): 원본 deals의 소유자 전용 RLS를 우회해
-- 익명 컬럼만 공개한다. anon은 원본 테이블을 못 읽고 이 뷰로만 매물을 본다.
create or replace view public.v_deals_public
  with (security_invoker = false) as
  select id, category_id, region, revenue_band, mode, summary, highlights, sale_reason, status, is_demo, posted
  from public.deals where status <> 'closed';

-- buyer_briefs: 소유자 전용(수요 정보는 비공개 자산), admin 열람
alter table public.buyer_briefs enable row level security;
create policy "own briefs" on public.buyer_briefs for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "admin read briefs" on public.buyer_briefs for select using (public.is_admin());

-- ── boost_orders: 해당 플랫폼 운영자 + admin ──────────────────
alter table public.boost_orders enable row level security;
create policy "operator create order" on public.boost_orders for insert
  with check (created_by = auth.uid() and public.is_operator_of(platform_id));
create policy "related read order" on public.boost_orders for select
  using (created_by = auth.uid() or public.is_operator_of(platform_id) or public.is_admin());
create policy "admin manage order" on public.boost_orders for update
  using (public.is_admin()) with check (public.is_admin());

-- ── 과금: plans 공개 읽기 / 지갑·구독·청구는 소유자+admin ─────
alter table public.plans          enable row level security;
alter table public.subscriptions  enable row level security;
alter table public.credit_ledger  enable row level security;
alter table public.charges        enable row level security;
create policy "public read plans" on public.plans for select using (true);
create policy "admin write plans" on public.plans for all
  using (public.is_admin()) with check (public.is_admin());
create policy "own subscriptions" on public.subscriptions for select
  using (user_id = auth.uid() or public.is_admin());
create policy "admin manage subscriptions" on public.subscriptions for all
  using (public.is_admin()) with check (public.is_admin());
create policy "own credit ledger" on public.credit_ledger for select
  using (user_id = auth.uid() or public.is_admin());
create policy "admin write credit ledger" on public.credit_ledger for insert
  with check (public.is_admin());   -- 충전·차감은 서버(RPC/관리자)만 기록
create policy "own charges" on public.charges for select
  using (user_id = auth.uid() or public.is_admin());
create policy "admin manage charges" on public.charges for all
  using (public.is_admin()) with check (public.is_admin());

-- ── events: 누구나 기록 가능(익명 분석), 읽기는 admin만 ───────
alter table public.events enable row level security;
create policy "anyone insert event" on public.events for insert with check (true);
create policy "admin read events"   on public.events for select using (public.is_admin());

-- ============================================================
-- 세모플 시드 v1 — build-seed.mjs 생성물 (직접 수정 금지)
-- 그룹 6 · 분야 45 · 플랫폼 1637
-- ============================================================

insert into public.groups (id, name, icon, description, sort) values
  ('commerce', '커머스·판매채널', '🛒', '온라인에서 상품을 파는 입점·판매 채널', 0),
  ('trade', '해외·B2B·유통', '🚢', '수출입·도매·물류·기업 구매', 1),
  ('service', '서비스·전문가·일자리', '🧑‍💼', '일감·인력·생활서비스·전문가 매칭', 2),
  ('life', '생활·여가·예약', '🏝️', '여행·예약·차·집·가족·건강', 3),
  ('money', '자금·콘텐츠·창작', '💰', '자금조달·금융·콘텐츠 수익화·창작물 판매', 4),
  ('ai', 'AI 도구', '🧠', '일·콘텐츠·개발을 도와주는 전 세계 AI 도구', 5)
on conflict (id) do nothing;

insert into public.categories (id, group_id, name, icon, description, sort) values
  ('openmarket', 'commerce', '오픈마켓·종합몰', '🏬', '종합 이커머스에 입점해 파는 판매채널', 0),
  ('homeshopping', 'commerce', '홈쇼핑·T커머스', '🛍️', 'TV홈쇼핑·T커머스 종합 판매채널', 1),
  ('mallbuilder', 'commerce', '자사몰·쇼핑몰 구축', '🛠️', '독립 쇼핑몰 구축·호스팅 솔루션', 2),
  ('social', 'commerce', '소셜·공동구매·특가', '🤝', '공동구매·특가·선물하기 기반 판매채널', 3),
  ('live', 'commerce', '라이브커머스', '📺', '실시간 방송으로 파는 채널', 4),
  ('funding', 'money', '크라우드펀딩', '🎯', '선주문·투자로 자금을 모으는 플랫폼', 5),
  ('freelance', 'service', '프리랜서·재능마켓', '🧑‍💻', '일·재능·전문가 용역을 거래', 6),
  ('delivery', 'commerce', '배달·주문중개', '🛵', '음식·상품 주문을 중개', 7),
  ('fulfillment', 'trade', '물류·풀필먼트·배송대행', '📦', '보관·포장·출고를 대행', 8),
  ('global', 'trade', '수출입·해외판매', '🚢', '해외 바이어·소비자에게 파는 B2B/B2C 채널', 9),
  ('wholesale', 'trade', '도매·소싱', '🏭', '사입·도매 상품을 떼오는 채널', 10),
  ('space', 'life', '숙박·공간·투어 예약', '🏨', '숙소·공간·투어·액티비티 예약 중개', 11),
  ('resale', 'commerce', '중고·리커머스', '♻️', '중고 거래 플랫폼', 12),
  ('content', 'money', '콘텐츠·창작 수익화', '🎨', '온라인 강의·글·웹툰·영상 등 창작·교육 콘텐츠 수익화', 13),
  ('fashion', 'commerce', '패션·뷰티 버티컬 커머스', '👗', '패션·의류·뷰티 특화 입점 판매채널', 14),
  ('food', 'commerce', '식품·신선·정기배송', '🥬', '식품·농수산·신선식품 판매·정기배송 채널', 15),
  ('handmade', 'commerce', '핸드메이드·작가마켓', '🎁', '수공예·디자인 굿즈 창작자 마켓', 16),
  ('jobs', 'service', '구인구직·긱워크·인력', '🧰', '채용·아르바이트·긱 일자리 매칭', 17),
  ('homeservice', 'service', '생활·홈서비스 O2O', '🧹', '청소·이사·수리·돌봄 등 생활서비스 매칭', 18),
  ('realestate', 'life', '부동산·상업공간 중개', '🏢', '주거·사무실·매장 등 부동산 임차·거래 중개', 19),
  ('beautyhealth', 'life', '뷰티·헬스케어 예약', '💇', '미용실·병원·시술 예약 중개', 20),
  ('auto', 'life', '자동차 거래·정비', '🚗', '중고차 거래·자동차 정비 서비스 연결', 21),
  ('ticket', 'life', '티켓·공연·이벤트 예매', '🎟️', '공연·전시·스포츠 등 표 판매·예매', 22),
  ('pet', 'life', '반려동물', '🐾', '반려동물 커머스·돌봄·병원·서비스', 23),
  ('kids', 'life', '육아·키즈', '🧸', '육아용품·교육·돌봄 커머스/서비스', 24),
  ('print', 'money', '인쇄·굿즈 제작', '🖨️', 'POD·명함·판촉물·굿즈 제작 판매', 25),
  ('assets', 'money', '창작물·디지털 자산 유통', '🎼', '음원·사진·폰트·디자인·전자책 유통', 26),
  ('fitness', 'life', '운동·피트니스·스포츠', '🏋️', '운동시설 예약·강습·트레이너 매칭', 27),
  ('wedding', 'life', '웨딩·결혼 준비', '💍', '웨딩홀·스드메·청첩장·예물·허니문', 28),
  ('photo', 'life', '사진·영상 촬영·초대장', '📸', '스냅·영상 촬영 매칭·모바일 초대장·포토부스', 29),
  ('event', 'life', '행사·케이터링·꽃', '🎉', '파티·행사 대행·케이터링·꽃·기프트', 30),
  ('legaltax', 'service', '법률·세무·전문서비스', '⚖️', '변호사·세무·노무·전자계약·심리상담 매칭', 31),
  ('finance', 'money', '금융·대출·보험 비교', '💳', '대출·보험·카드·해외송금·정책자금 비교/중개', 32),
  ('rental', 'life', '렌탈·구독', '🔄', '가전·가구·명품·차량·장비 렌탈·구독', 33),
  ('office', 'trade', '사무·MRO·산업재 B2B', '🖇️', '사무용품·MRO·공구·전자부품·건자재·포장재', 34),
  ('ai_chat', 'ai', '범용 AI 챗봇', '🤖', '글쓰기·조사·아이디어까지 두루 시키는 범용 어시스턴트', 35),
  ('ai_writing', 'ai', '글쓰기·문서 AI', '✍️', '카피·블로그·보고서·발표자료 작성을 돕는 도구', 36),
  ('ai_image', 'ai', '이미지·디자인 AI', '🎨', '이미지 생성·배경 제거·디자인 제작 도구', 37),
  ('ai_video', 'ai', '영상 AI', '🎬', '영상 생성·아바타·자막·편집 도구', 38),
  ('ai_audio', 'ai', '음성·음악 AI', '🎙️', 'AI 성우·더빙·음악 생성·오디오 보정', 39),
  ('ai_code', 'ai', '개발·코딩 AI', '💻', '코드 작성·앱 생성을 돕는 개발 도구', 40),
  ('ai_meeting', 'ai', '회의·기록 AI', '📝', '회의 녹음을 텍스트·요약으로 바꾸는 도구', 41),
  ('ai_marketing', 'ai', '마케팅·고객응대 AI', '📣', '광고 소재·SNS·SEO·AI 상담봇', 42),
  ('ai_auto', 'ai', '자동화·AI 에이전트', '⚙️', '반복 업무 연결·자동화와 AI 에이전트 구축', 43),
  ('ai_research', 'ai', '리서치·번역 AI', '🔍', '출처 기반 검색·논문 조사·번역 도구', 44)
on conflict (id) do nothing;

insert into public.platforms (id, name, category_id, region, url, blurb, is_new, fee_band, fee_text, settle_text, enter_text, strength) values
  ('coupang', '쿠팡', 'openmarket', 'domestic', 'https://www.coupang.com', '로켓배송 물류망을 갖춘 국내 최대 종합 이커머스.', false, 'mid', '카테고리별 상이(정률)', '주·월 단위 정산 선택', '사업자등록·통신판매업 신고 후 판매자 가입', '로켓배송 물류·빠른배송, 대규모 트래픽'),
  ('smartstore', '네이버 스마트스토어', 'openmarket', 'domestic', 'https://smartstore.naver.com', '네이버 검색·페이와 연동되는 입점형 쇼핑몰.', false, 'low', '결제수수료+매출연동수수료', '구매확정 후 +1영업일 정산', '사업자·개인 가입 후 스토어 개설(판매 시 신고)', '네이버 검색 노출·페이 연동, 낮은 진입장벽'),
  ('11st', '11번가', 'openmarket', 'domestic', 'https://www.11st.co.kr', 'SK 계열 종합 오픈마켓.', false, 'mid', '카테고리별 상이', null, '사업자등록·통신판매업 신고 후 판매자 가입', 'SK 계열 종합 트래픽·프로모션'),
  ('gmarket', 'G마켓', 'openmarket', 'domestic', 'https://www.gmarket.co.kr', '신세계 계열 오픈마켓(옥션과 통합 운영).', false, 'mid', '카테고리별 상이', null, '사업자등록·통신판매업 신고 후 판매자 가입', '신세계 계열, 옥션과 통합 판매관리(ESM)'),
  ('auction', '옥션', 'openmarket', 'domestic', 'https://www.auction.co.kr', '국내 1세대 오픈마켓, 경매·즉시구매.', false, 'mid', '카테고리별 상이', null, '사업자등록·통신판매업 신고 후 판매자 가입', '경매·즉시구매 병행, 1세대 오픈마켓 인지도'),
  ('ssg', 'SSG닷컴', 'openmarket', 'domestic', 'https://www.ssg.com', '신세계·이마트 기반 종합몰.', false, 'mid', '카테고리별 상이', null, '입점 신청·심사 후 판매(사업자등록 필요)', '신세계·이마트 연계 신선·프리미엄 상품군'),
  ('lotteon', '롯데온', 'openmarket', 'domestic', 'https://www.lotteon.com', '롯데 유통 계열 통합 온라인몰.', false, 'mid', '카테고리별 상이', null, '입점 신청·심사 후 판매(사업자등록 필요)', '롯데 유통 계열 연계, 백화점·마트 상품군'),
  ('interpark', '인터파크쇼핑', 'openmarket', 'domestic', 'https://shopping.interpark.com', '공연·투어에 강한 종합 쇼핑몰.', false, 'mid', '카테고리별 상이', null, '사업자등록·통신판매업 신고 후 판매자 가입', '공연·투어·티켓 예매 연계에 강점'),
  ('shoppingseller', '톡스토어', 'openmarket', 'domestic', 'https://shopping-seller.kakao.com/', '카카오톡 채널 기반 오픈형 쇼핑 판매 플랫폼.', false, null, null, null, '사업자등록 후 톡스토어 판매자 입점', '카카오톡 채널 연계 판매·알림 도달'),
  ('aboutfishing', '어바웃피싱', 'openmarket', 'domestic', 'https://aboutfishing.kr/', '선상낚시 예약에 낚시용품 커머스·중고장터·커뮤니티를 결합한 낚시 버티컬 마켓으로 2023년 쇼핑몰을 연 신생 슈퍼앱.', true, null, null, null, '판매자 입점 신청(사업자등록 필요)', '낚시 버티컬 — 예약·용품·중고 통합'),
  ('hnsmall', '홈앤쇼핑', 'homeshopping', 'domestic', 'https://www.hnsmall.com/', '중소기업 제품 중심 TV홈쇼핑·온라인몰.', false, 'high', '정률 판매수수료 높은 편', null, '상품 제안·MD 협의·심사 후 편성 입점', '중소기업 제품 판로 중심 홈쇼핑·온라인몰'),
  ('gongyoungshop', '공영쇼핑', 'homeshopping', 'domestic', 'https://www.gongyoungshop.kr/', '중소기업·농어민 판로 지원 공영 홈쇼핑.', false, 'low', '공영 목적 낮은 수수료', null, '중소기업·농어민 상품 제안·심사 후 입점', '중소기업·농어민 판로 지원, 낮은 수수료'),
  ('nsmall', 'NS홈쇼핑', 'homeshopping', 'domestic', 'https://www.nsmall.com/', '식품·건강 강점 TV홈쇼핑·온라인몰.', false, 'high', '정률 판매수수료 높은 편', null, '상품 제안·MD 협의·심사 후 편성 입점', '식품·건강기능식품 상품군에 강점'),
  ('shinsegaetvshopping', '신세계TV쇼핑', 'homeshopping', 'domestic', 'https://www.shinsegaetvshopping.com/', '신세계 계열 T커머스·온라인몰.', false, 'high', '정률 판매수수료 높은 편', null, '상품 제안·MD 협의·심사 후 편성 입점', 'T커머스, 신세계 상품·유통 연계'),
  ('gsshop', 'GS샵', 'homeshopping', 'domestic', 'https://www.gsshop.com/', 'GS리테일 TV홈쇼핑·온라인 종합몰.', false, 'high', '정률 판매수수료 높은 편', null, '상품 제안·MD 협의·심사 후 편성 입점', 'TV홈쇼핑+온라인 종합 판매망'),
  ('cjonstyle', 'CJ온스타일', 'homeshopping', 'domestic', 'https://www.cjonstyle.com/', 'CJ ENM의 TV홈쇼핑·모바일 통합 쇼핑.', false, 'high', '정률 판매수수료 높은 편', null, '상품 제안·MD 협의·심사 후 편성 입점', 'TV·모바일 통합 라이브커머스 역량'),
  ('hmall', '현대Hmall', 'homeshopping', 'domestic', 'https://www.hmall.com/', '현대홈쇼핑 TV홈쇼핑·온라인 종합몰.', false, 'high', '정률 판매수수료 높은 편', null, '상품 제안·MD 협의·심사 후 편성 입점', '현대홈쇼핑 연계 종합 온라인몰'),
  ('lotteimall', '롯데홈쇼핑', 'homeshopping', 'domestic', 'https://www.lotteimall.com/', '롯데 TV홈쇼핑·온라인 쇼핑몰(롯데아이몰).', false, 'high', '정률 판매수수료 높은 편', null, '상품 제안·MD 협의·심사 후 편성 입점', '롯데 계열 홈쇼핑·아이몰 연계'),
  ('skstoa', 'SK스토아', 'homeshopping', 'domestic', 'https://www.skstoa.com/', 'SK의 T커머스 TV쇼핑·온라인몰.', false, 'high', '정률 판매수수료 높은 편', null, '상품 제안·MD 협의·심사 후 편성 입점', 'T커머스 중심 TV쇼핑·온라인몰'),
  ('kshop', 'KT알파 쇼핑', 'homeshopping', 'domestic', 'https://www.kshop.co.kr/', 'KT알파 T커머스 TV쇼핑 채널·온라인몰.', false, 'high', '정률 판매수수료 높은 편', null, '상품 제안·MD 협의·심사 후 편성 입점', 'KT알파 계열 T커머스 채널'),
  ('cafe242', '카페24', 'mallbuilder', 'domestic', 'https://www.cafe24.com/', '자사몰 구축·호스팅 이커머스 솔루션.', false, null, null, null, '회원가입 후 쇼핑몰 개설(판매 시 사업자등록)', '자사몰 구축·해외판매·마케팅 연동 폭넓음'),
  ('imweb', '아임웹', 'mallbuilder', 'domestic', 'https://imweb.me/', '노코드 드래그 방식 자사몰·웹사이트 빌더.', false, null, null, null, '회원가입 후 쇼핑몰·홈페이지 개설', '노코드 드래그로 빠른 자사몰 제작'),
  ('sixshop', '식스샵', 'mallbuilder', 'domestic', 'https://www.sixshop.com/', '디자인 템플릿 기반 노코드 자사몰 제작.', false, null, null, null, '회원가입 후 쇼핑몰 개설(판매 시 사업자등록)', '디자인 템플릿 중심 브랜드몰 제작'),
  ('makeshop', '메이크샵', 'mallbuilder', 'domestic', 'https://www.makeshop.co.kr/', '임대형 쇼핑몰 구축 솔루션.', false, null, null, null, '회원가입 후 임대형 쇼핑몰 구축', '임대형 쇼핑몰 기능·확장 옵션 다양'),
  ('godo', '고도몰', 'mallbuilder', 'domestic', 'https://www.godo.co.kr/', 'NHN의 쇼핑몰 구축·호스팅 솔루션.', false, null, null, null, '회원가입 후 쇼핑몰 구축·호스팅', 'NHN 연계 쇼핑몰 구축·확장성'),
  ('wisa', '위사', 'mallbuilder', 'domestic', 'https://www.wisa.co.kr/', '독립·임대형 쇼핑몰 구축 이커머스 솔루션.', false, null, null, null, '회원가입 후 독립·임대형 쇼핑몰 구축', '독립·임대형 선택형 구축 솔루션'),
  ('allways', '올웨이즈', 'social', 'domestic', 'https://alwayz.co', '팀 구매(공동구매) 기반 초저가 커머스.', false, null, null, null, '사업자 입점 신청 후 상품 등록', '팀 구매 기반 초저가·바이럴 유입'),
  ('kakaogift', '카카오톡 선물하기', 'social', 'domestic', 'https://gift.kakao.com', '카카오톡 기반 선물·모바일 쿠폰 판매.', false, null, null, null, '입점 심사 후 판매(사업자등록 필요)', '카카오톡 선물·모바일 쿠폰 수요 흡수'),
  ('wemakeprice', '위메프', 'social', 'domestic', 'https://www.wemakeprice.com', '특가·딜 중심 소셜커머스.', false, 'mid', '카테고리·딜별 상이', null, '판매자 입점 후 딜·상품 등록', '특가·딜 프로모션 노출에 강점'),
  ('tmon', '티몬', 'social', 'domestic', 'https://www.tmon.co.kr', '타임딜·특가 중심 소셜커머스.', false, 'mid', '카테고리·딜별 상이', null, '판매자 입점 후 딜·상품 등록', '타임딜·특가 기획전 중심 노출'),
  ('ohou', '오늘의집(스토어)', 'social', 'domestic', 'https://ohou.se', '인테리어·리빙 콘텐츠 연계 커머스.', false, null, null, null, '스토어 입점 신청·심사 후 판매', '인테리어·리빙 콘텐츠 연계 구매 전환'),
  ('dailyshot', '데일리샷', 'social', 'domestic', 'https://dailyshot.co/', '주류 특가·공동구매·예약 픽업 커머스.', false, null, null, null, '제휴 매장·주류 판매 입점 협의', '주류 특가·예약 픽업에 특화'),
  ('08liter', '공팔리터', 'social', 'domestic', 'https://www.08liter.com/', '인플루언서 공동구매·숏폼 기반 소셜 커머스.', false, null, null, null, '셀러·인플루언서 공동구매 입점 신청', '인플루언서·숏폼 기반 공동구매'),
  ('thirtymall', '떠리몰', 'social', 'domestic', 'https://thirtymall.com/', '유통기한 임박·B급 상품 할인 판매몰.', false, null, null, null, '임박·리퍼 상품 공급 입점 협의', '유통기한 임박·B급 재고 소진에 유리'),
  ('lastorder', '라스트오더', 'social', 'domestic', 'https://www.lastorder.co.kr/', '편의점·음식점 마감할인 상품 판매 플랫폼.', false, null, null, null, '매장 제휴 등록 후 마감 상품 판매', '편의점·음식점 마감 임박 재고 할인'),
  ('imbak', '임박몰', 'social', 'domestic', 'https://www.imbak.co.kr/', '유통기한 임박 식품·생활용품 할인몰.', false, null, null, null, '임박·재고 상품 공급사 제휴 후 입점', '유통기한 임박 재고 처리·할인 소싱에 강점'),
  ('eyoumall', '이유몰', 'social', 'domestic', 'https://www.eyoumall.co.kr/', '임박·못난이·재고 등 이유 있는 상품 할인몰.', false, null, null, null, '임박·못난이·재고 상품 공급사 제휴 입점', '임박·못난이·재고 등 잉여재고 할인 유통'),
  ('mahi', '마감히어로', 'social', 'domestic', 'https://www.mahi.co.kr/', '동네 매장 마감할인 실시간 알림·픽업 앱.', false, null, null, null, '동네 매장 사업자 가입 후 마감상품 등록', '매장 마감시간 임박 재고 실시간 할인·픽업'),
  ('simsale', '심쿵할인', 'social', 'domestic', 'http://www.simsale.kr/', '함께 살수록 싸지는 공동구매 쇼핑 앱.', false, null, null, null, '사업자등록·통신판매업 신고 후 입점', '함께 살수록 저렴해지는 공동구매형 판매'),
  ('market09', '공구마켓', 'social', 'domestic', 'https://www.market09.kr/', '2명부터 가능한 초특가 공동구매·라이브 경매.', false, null, null, null, '사업자등록·통신판매업 신고 후 입점', '소수 인원 공동구매·라이브 경매 특가'),
  ('udong09', '우동공구', 'social', 'domestic', 'https://udong09.com/', '지역 기반 우리동네 공동구매 플랫폼.', false, null, null, null, '사업자등록·통신판매업 신고 후 입점', '지역·동네 단위 공동구매에 특화'),
  ('witdeal', '윗딜', 'social', 'domestic', 'https://witdeal.co.kr/', '아파트 입주민 대상 무료배송 공동구매 앱.', false, null, null, null, '사업자등록·통신판매업 신고 후 입점', '아파트 단지 단위 공동구매·무료배송'),
  ('ssagojoa', '싸고좋아', 'social', 'domestic', 'https://www.ssagojoa.com/', '다양한 카테고리 연중 공동구매 마켓 앱.', false, null, null, null, '사업자등록·통신판매업 신고 후 입점', '다양한 카테고리 상시 공동구매 운영'),
  ('inpock', '인포크스토어', 'social', 'domestic', 'https://www.inpock.co.kr/', '인플루언서 SNS 판매·공동구매 마켓 플랫폼.', false, null, null, null, '인플루언서·셀러 가입 후 스토어 개설', '인플루언서 SNS 기반 판매·공동구매 구축'),
  ('coocha', '쿠차', 'social', 'domestic', 'http://www.coocha.co.kr/', '소셜커머스·오픈마켓 핫딜·특가 비교 검색.', false, null, null, null, null, '여러 쇼핑몰 핫딜·특가 비교 검색에 강점'),
  ('uglyus', '어글리어스', 'social', 'domestic', 'https://uglyus.co.kr/', '못난이 농산물 정기배송 친환경 구독.', false, null, null, null, '친환경 농산물 공급 생산자 제휴 입점', '못난이 농산물 정기배송 구독에 특화'),
  ('motnany', '못난이마켓', 'social', 'domestic', 'https://www.motnany.com/', '못난이 농산물 산지·소비자 직거래 마켓.', false, null, null, null, '농가·생산자 가입 후 상품 등록', '못난이 농산물 산지·소비자 직거래'),
  ('sodomall', '소도몰', 'social', 'domestic', 'https://www.sodomall.com/', '카톡 오픈채팅 기반으로 동네 매장에서 픽업하는 오프라인 공동구매 매장 프랜차이즈로 2024년 출범한 신생.', true, null, null, null, '가맹·제휴 문의 후 오프라인 매장 개설', '오픈채팅 기반 매장 픽업형 동네 공동구매'),
  ('colley', '콜리', 'social', 'domestic', 'https://colley.kr/', 'IP 소품 ''덕질''을 위한 편집샵·중고 덕친마켓·굿즈를 결합한 취향 커머스 앱으로 떠오르는 서비스.', true, null, null, null, '셀러 가입 후 굿즈·중고 상품 등록', 'IP 굿즈·덕질 취향 커머스·중고 거래 결합'),
  ('navershopl', '네이버 쇼핑라이브', 'live', 'domestic', 'https://shoppinglive.naver.com', '네이버 스마트스토어 연동 라이브 방송 판매.', false, 'low', '스마트스토어 판매수수료+라이브 연동수수료', '구매확정 후 영업일 정산', '스마트스토어 개설 후 라이브 방송 진행', '스마트스토어 트래픽·검색 연동 라이브'),
  ('grip', '그립(Grip)', 'live', 'domestic', 'https://www.grip.show', '소상공인·1인 판매자 중심 라이브커머스.', false, null, null, null, '판매자 가입·심사 후 라이브 방송', '1인·소상공인도 진행 쉬운 라이브 진입장벽 낮음'),
  ('kakaoshopl', '카카오 쇼핑라이브', 'live', 'domestic', 'https://store.kakao.com', '카카오 채널 기반 라이브 판매.', false, null, null, null, '입점 제휴·심사 후 방송(주로 브랜드 대상)', '카카오톡 채널·트래픽 연계 라이브'),
  ('coupanglive', '쿠팡 라이브', 'live', 'domestic', 'https://livecreator.coupang.com/', '쿠팡 내 라이브 방송 판매.', false, null, null, null, '쿠팡 판매자·크리에이터 가입 후 방송', '쿠팡 상품·물류 연계 라이브 판매'),
  ('sauce', '소스라이브', 'live', 'domestic', 'https://sauce.im/', '자사몰에 설치하는 라이브·쇼퍼블 비디오 커머스 솔루션.', false, null, null, null, '솔루션 도입 문의·계약 후 자사몰 연동', '자사몰 내 라이브·쇼퍼블 비디오 임베드 솔루션'),
  ('vogoplay', '보고플레이', 'live', 'domestic', 'https://www.vogoplay.com/', '초특가 상품 중심 모바일 라이브커머스 플랫폼.', false, null, null, null, '판매자 입점 제휴 후 라이브 방송', '초특가 상품 소싱 중심 모바일 라이브'),
  ('samsung', '삼성 라이브', 'live', 'domestic', 'https://www.samsung.com/sec/store-model/live/', '삼성닷컴 가전·IT 실시간 방송 판매 채널.', false, null, null, null, '삼성닷컴 공식 채널(일반 입점 대상 아님)', '삼성 가전·IT 공식 채널 실시간 방송'),
  ('11st2', '11번가 라이브', 'live', 'domestic', 'https://m.11st.co.kr/page/main/live11', '11번가 예능형 라이브커머스 오픈 채널.', false, null, null, null, '11번가 판매자 입점 후 라이브 신청', '11번가 오픈마켓 연계 예능형 라이브'),
  ('shinsegaeliveshopping', '신세계라이브쇼핑', 'live', 'domestic', 'https://www.shinsegaeliveshopping.com/', '신세계 계열 TV·온라인 결합 라이브 쇼핑.', false, 'high', null, null, '상품 제안·MD 편성 심사(홈쇼핑형)', 'TV홈쇼핑·온라인 결합 라이브 편성'),
  ('jamlive', '잼라이브', 'live', 'domestic', 'https://jamlive.tv/', '인플루언서 중심 인터랙티브 라이브커머스.', false, null, null, null, '제휴·입점 문의 후 방송', '인터랙티브·인플루언서 참여형 라이브'),
  ('display', 'CJ온스타일 라이브', 'live', 'domestic', 'https://display.cjonstyle.com/', 'CJ ENM 모바일 라이브 방송 커머스.', false, null, null, null, 'MD 편성·상품 제안 심사 후 방송', 'CJ온스타일 홈쇼핑 연계 모바일 라이브'),
  ('7shoppinglive', '세븐쇼핑라이브', 'live', 'domestic', 'https://7shoppinglive.com/', '뉴스 콘셉트 라이브 커머스 방송 플랫폼.', false, null, null, null, '입점·제휴 문의 후 방송', '뉴스형 콘텐츠 결합 라이브 방송'),
  ('soonshop', '순샵', 'live', 'domestic', 'https://www.soonshop.co.kr/', '크리에이터 숏폼 리뷰 영상으로 상품을 파는 숏폼 커머스로 2024년 5월 정식 출시된 신생(순이엔티).', true, null, null, null, '판매자·크리에이터 가입 후 숏폼 등록', '숏폼 리뷰 영상 기반 상품 판매'),
  ('wadiz', '와디즈', 'funding', 'domestic', 'https://www.wadiz.kr', '리워드·투자형을 모두 다루는 국내 최대 크라우드펀딩.', false, 'mid', '성공 시 모집액 연동 수수료(결제+서비스)', '펀딩 종료·결제 후 정산', '메이커 가입·프로젝트 심사 후 오픈', '리워드·투자형 모두 지원, 서포터 풀 넓음'),
  ('tumblbug', '텀블벅', 'funding', 'domestic', 'https://tumblbug.com', '창작·콘텐츠 프로젝트 중심 리워드형 펀딩.', false, 'mid', '성공 시 모집액 연동 플랫폼 수수료', '펀딩 성공·결제 후 정산', '창작자 가입·프로젝트 심사 후 오픈', '창작·콘텐츠 프로젝트 후원 결집에 강점'),
  ('ohmycompany', '오마이컴퍼니', 'funding', 'domestic', 'https://www.ohmycompany.com', '소셜·공익 프로젝트와 증권형을 다루는 펀딩.', false, null, null, null, '프로젝트 등록·심사 후 오픈', '소셜·공익 프로젝트와 증권형 병행'),
  ('crowdy', '크라우디', 'funding', 'domestic', 'https://www.ycrowdy.com', '증권형(투자형) 크라우드펀딩 특화.', false, null, null, null, '발행기업 심사 후 청약 진행', '비상장기업 증권형(투자형) 펀딩 특화'),
  ('happybean', '해피빈 펀딩', 'funding', 'domestic', 'https://happybean.naver.com', '네이버 기반 기부·공익 펀딩.', false, null, null, null, '공익단체·프로젝트 등록 후 모금', '네이버 기반 기부·공익 모금에 강점'),
  ('kickstarter', '킥스타터', 'funding', 'overseas', 'https://www.kickstarter.com', '하드웨어·게임에 강한 글로벌 리워드 펀딩(한국 직접 개설 미지원).', false, 'mid', '성공 시 모집액 5%+결제수수료', '펀딩 성공 후 정산', '해외 결제·법인 필요, 한국 직접 개설 미지원', '하드웨어·게임 글로벌 백커 도달에 강점'),
  ('funding4u', '펀딩포유', 'funding', 'domestic', 'https://www.funding4u.co.kr/', '비상장기업 증권형(온라인소액투자중개) 크라우드펀딩.', false, null, null, null, '발행기업 심사 후 청약 진행', '비상장기업 증권형 크라우드펀딩 중개'),
  ('crowdin', '굿펀딩', 'funding', 'domestic', 'https://crowdin.co.kr/', '청년·소셜벤처 후원·투자형 크라우드펀딩.', false, null, null, null, '프로젝트 등록·심사 후 오픈', '청년·소셜벤처 후원·투자형 펀딩'),
  ('benefitplus', '비플러스', 'funding', 'domestic', 'https://benefitplus.kr/', '소상공인·소셜벤처 대상 임팩트 대출형(온투업) 펀딩.', false, null, null, null, '가입·본인인증 후 투자, 차입은 사업자 심사', '소상공인·소셜벤처 임팩트 대출형 투자에 특화'),
  ('otrade', '오픈트레이드', 'funding', 'domestic', 'https://otrade.co/', '비상장기업 지분투자형 크라우드펀딩 플랫폼.', false, null, null, null, '투자자 가입 후 청약, 발행은 기업 심사', '비상장기업 지분투자형 펀딩 중개에 특화'),
  ('indiegogo', '인디고고', 'funding', 'overseas', 'https://www.indiegogo.com/', '글로벌 리워드형 크라우드펀딩 사이트.', false, 'mid', '플랫폼 수수료+결제 수수료', null, '계정 생성 후 프로젝트 등록(해외 결제 지원)', '글로벌 리워드형 펀딩, 해외 백커 도달에 강점'),
  ('kasa', '카사', 'funding', 'domestic', 'https://www.kasa.co.kr/', '상업용 부동산 수익증권 조각투자 플랫폼.', false, null, null, null, '앱 가입·본인인증 후 투자', '상업용 부동산 수익증권 소액 조각투자에 강점'),
  ('funble', '펀블', 'funding', 'domestic', 'https://www.funble.kr/', '블록체인 기반 부동산 조각투자 서비스.', false, null, null, null, '앱 가입·본인인증 후 투자', '블록체인 기반 부동산 조각투자에 강점'),
  ('sou', '소유', 'funding', 'domestic', 'https://sou.place/', '토큰증권 기반 부동산 조각투자(월배당) 플랫폼.', false, null, null, null, '앱 가입·본인인증 후 투자', '부동산 월배당형 조각투자에 강점'),
  ('together', '투게더펀딩', 'funding', 'domestic', 'https://www.together.co.kr/', '부동산담보대출 중심 P2P(온투업) 투자.', false, null, null, null, '가입·본인인증 후 투자', '부동산담보대출 중심 P2P 투자에 강점'),
  ('musicow', '뮤직카우', 'funding', 'domestic', 'https://www.musicow.com/', '음악 저작권료 수익증권 조각투자 플랫폼.', false, null, null, null, '앱 가입·본인인증 후 거래', '음악 저작권료 수익 기반 조각투자에 특화'),
  ('weshareart', '아트투게더', 'funding', 'domestic', 'https://weshareart.com/', '미술품 투자계약증권 조각투자 플랫폼.', false, null, null, null, '가입·본인인증 후 투자', '미술품 투자계약증권 소액 조각투자에 강점'),
  ('tessa', '테사', 'funding', 'domestic', 'https://www.tessa.art/', '블루칩 미술품 조각투자 플랫폼.', false, null, null, null, '앱 가입·본인인증 후 투자', '블루칩 미술품 조각투자에 강점'),
  ('8percent', '8퍼센트', 'funding', 'domestic', 'https://8percent.kr/', '개인·기업 신용대출 중개 P2P(온투업) 투자.', false, null, null, null, '가입·본인인증 후 투자', '개인·기업 신용대출 중개 P2P 투자에 강점'),
  ('funderful', '펀더풀', 'funding', 'domestic', 'https://funderful.kr/', '2021년 출범한 신생 K-콘텐츠 투자 플랫폼으로 영화·드라마·공연 등 개별 콘텐츠 프로젝트에 소액 투자할 수 있다.', true, null, null, null, '가입·본인인증 후 투자', '영화·드라마·공연 등 K콘텐츠 프로젝트 투자에 특화'),
  ('fundingplay', '펀딩플레이', 'funding', 'domestic', 'https://www.fundingplay.kr/', '드라마·영화·웹툰·음악 등 K-콘텐츠 IP에 투자하는 신생 콘텐츠 프로젝트 펀딩 전문 플랫폼이다.', true, null, null, null, '가입·본인인증 후 투자', '드라마·웹툰·음악 등 K콘텐츠 IP 투자에 특화'),
  ('withmix', '위드믹스', 'funding', 'domestic', 'https://withmix.kr/', '2022년 오픈한 신생 굿즈 크라우드펀딩 플랫폼으로 스트리머·크리에이터의 굿즈 프로젝트 펀딩을 지원한다.', true, null, null, null, '가입 후 프로젝트 등록으로 펀딩 개설', '스트리머·크리에이터 굿즈 리워드 펀딩에 특화'),
  ('runfunding', '런크라우드펀딩', 'funding', 'domestic', 'https://runfunding.co.kr/', '리워드·후원·투자형을 아우르는 신규 종합 크라우드펀딩 플랫폼으로 창작·아이디어 프로젝트 펀딩을 지원한다.', true, null, null, null, '가입 후 프로젝트 등록으로 펀딩 개설', '리워드·후원·투자형을 아우르는 종합 펀딩에 강점'),
  ('kmong', '크몽', 'freelance', 'domestic', 'https://kmong.com', '디자인·마케팅·IT 등 재능·용역 거래 마켓.', false, 'mid', '판매액 구간별 정률 수수료', '구매확정 후 정산', '개인·사업자 모두 가입 후 서비스 등록', '디자인·마케팅·IT 등 재능·용역 비대면 거래에 강점'),
  ('soomgo', '숨고', 'freelance', 'domestic', 'https://soomgo.com', '레슨·이사·수리 등 생활 전문가 매칭.', false, null, null, null, '전문가 가입·프로필 등록 후 견적 발송', '레슨·이사·수리 등 생활 전문가 매칭에 강점'),
  ('wishket', '위시켓', 'freelance', 'domestic', 'https://www.wishket.com', 'IT 개발·디자인 프로젝트 외주 매칭.', false, null, null, null, '파트너 가입·검증 후 프로젝트 지원', 'IT 개발·디자인 프로젝트 외주 매칭에 강점'),
  ('taling', '탈잉', 'freelance', 'domestic', 'https://taling.me', '취미·직무 원데이 클래스·튜터 매칭.', false, null, null, null, '튜터 가입·클래스 등록 후 개설', '취미·직무 원데이 클래스·튜터 매칭에 강점'),
  ('loud', '라우드소싱', 'freelance', 'domestic', 'https://www.loud.kr', '디자인 공모전·콘테스트 기반 외주.', false, null, null, null, '디자이너 가입 후 콘테스트 참여', '공모전·콘테스트 방식 디자인 외주에 특화'),
  ('otwojob', '오투잡', 'freelance', 'domestic', 'https://www.otwojob.com', '재능·서비스 거래 마켓.', false, null, null, null, '개인·사업자 모두 가입 후 서비스 등록', '재능·서비스 비대면 거래 마켓에 강점'),
  ('elancer', '이랜서', 'freelance', 'domestic', 'https://www.elancer.co.kr/', '기업과 IT 프리랜서를 프로젝트 단위로 매칭하는 아웃소싱 플랫폼.', false, null, null, null, '프리랜서 가입·프로필 등록 후 지원', 'IT 프리랜서 프로젝트 단위 아웃소싱 매칭에 강점'),
  ('freemoa', '프리모아', 'freelance', 'domestic', 'https://www.freemoa.net/', 'IT 개발·디자인 외주 프로젝트 중개 플랫폼.', false, null, null, null, '파트너 가입·프로필 등록 후 지원', 'IT 개발·디자인 외주 프로젝트 중개에 강점'),
  ('wanted', '원티드긱스', 'freelance', 'domestic', 'https://www.wanted.co.kr/gigs', '원티드가 운영하는 IT 프리랜서 외주 매칭.', false, null, null, null, '프리랜서 가입·프로필 등록 후 지원', '원티드 운영, IT 프리랜서 외주 매칭에 강점'),
  ('jaenung', '재능넷', 'freelance', 'domestic', 'https://www.jaenung.net/', '디자인·번역·영상 등 재능 거래 마켓.', false, null, null, null, '개인·사업자 모두 가입 후 서비스 등록', '디자인·번역·영상 등 재능 거래에 강점'),
  ('imjob', '아임잡', 'freelance', 'domestic', 'https://www.imjob.co.kr/', 'IT 인력과 기업 프로젝트를 연결하는 프리랜서 매칭.', false, null, null, null, '프리랜서 가입·프로필 등록 후 지원', 'IT 인력·기업 프로젝트 매칭에 강점'),
  ('notefolio', '노트폴리오', 'freelance', 'domestic', 'https://notefolio.net/', '디자이너 포트폴리오·디자인 외주 크리에이터 플랫폼.', false, null, null, null, '가입 후 포트폴리오 등록·외주 수주', '디자이너 포트폴리오 노출·디자인 외주에 강점'),
  ('datalab', '플리토 데이터랩', 'freelance', 'domestic', 'https://datalab.flitto.com', '크라우드소싱 다국어 번역·언어 데이터 가공 플랫폼.', false, null, null, null, '가입 후 참여자로 번역·데이터 작업 수행', '크라우드소싱 다국어 번역·언어 데이터 가공에 특화'),
  ('crowdworks', '크라우드웍스', 'freelance', 'domestic', 'https://www.crowdworks.kr', 'AI 학습 데이터 라벨링 크라우드소싱 플랫폼.', false, null, null, null, '가입 후 워커로 라벨링 작업 참여', 'AI 학습 데이터 라벨링 크라우드소싱에 특화'),
  ('selectstar', '셀렉트스타', 'freelance', 'domestic', 'https://selectstar.ai', 'AI 학습·평가 데이터 수집·가공 크라우드소싱.', false, null, null, null, '가입 후 워커로 데이터 수집·가공 참여', 'AI 학습·평가 데이터 수집·가공 크라우드소싱에 특화'),
  ('codenary', '코드너리', 'freelance', 'domestic', 'https://www.codenary.co.kr', '기술스택·개발자 채용·외주 큐레이션 플랫폼.', false, null, null, null, '가입 후 프로필·기술스택 등록', '기술스택 기반 개발자 채용·외주 큐레이션에 강점'),
  ('provoice', '프로보이스', 'freelance', 'domestic', 'https://provoice.co.kr', '성우·더빙·로컬라이징 보이스 외주 중개.', false, null, null, null, '성우 가입·프로필 등록 후 수주', '성우·더빙·로컬라이징 보이스 외주 중개에 특화'),
  ('skillagit', '재능아지트', 'freelance', 'domestic', 'https://www.skillagit.com', '디자인·번역·성우·영상 재능 거래 마켓.', false, null, null, null, '개인·사업자 모두 가입 후 서비스 등록', '디자인·번역·성우·영상 재능 거래에 강점'),
  ('talentbank', '탤런트뱅크', 'freelance', 'domestic', 'https://www.talentbank.co.kr/', '휴넷에서 분사해 성장한 긱워크 플랫폼으로, 검증된 시니어 전문가와 기업을 자문·프로젝트 단위로 연결한다.', true, null, null, null, '전문가 가입·검증 후 자문·프로젝트 매칭', '검증된 시니어 전문가 자문·프로젝트 매칭에 특화'),
  ('gigtalk', '긱톡', 'freelance', 'domestic', 'https://gigtalk.co.kr/', '전문가 네트워크 기반의 신흥 재능마켓으로, 프로젝트 매칭과 전문가 자문·인재추천을 중개한다.', true, null, null, null, '전문가 가입·프로필 등록 후 매칭', '전문가 네트워크 기반 프로젝트 매칭·인재추천에 강점'),
  ('sooooon', '쑨', 'freelance', 'domestic', 'https://sooooon.com/', '자영업자와 단기 근무자를 당일 단위로 이어 주는 초단기 알바 매칭 플랫폼으로 최근 고속 성장 중인 긱워크 서비스다.', true, null, null, null, '사업자·구직자 가입 후 당일 근무 매칭', '당일 단위 초단기 인력 즉시 매칭에 강점'),
  ('apps9', '돌파구', 'freelance', 'domestic', 'https://apps.apple.com/us/app/id6756605947', '수수료 0%를 내세워 최근 출시된 신생 재능마켓 앱으로, 부업·N잡 프리랜서와 기업 외주를 연결한다.', true, 'low', '수수료 0% 표방', null, '개인·사업자 가입 후 프로필 등록', '부업·N잡 외주 연결, 낮은 수수료 표방'),
  ('gigtalker', '긱톡커', 'freelance', 'domestic', 'https://gigtalker.com/', '지식상품 판매와 전문가 매칭을 지원하며 글로벌 시장을 겨냥해 최근 출시된 신규 재능마켓이다.', true, null, null, null, '개인·사업자 가입 후 프로필 등록', '지식상품 판매·전문가 매칭에 강점'),
  ('1point', '원포인트', 'freelance', 'domestic', 'https://1point.kr/', 'AI 기반으로 검증된 상위 마케터·디자이너 프리랜서를 기업과 연결하는 신생 전문가 매칭 플랫폼이다.', true, null, null, null, '전문가 심사·검증 후 프로필 등록', '검증된 마케터·디자이너 매칭에 강점'),
  ('ssosing', '쏘싱', 'freelance', 'domestic', 'https://ssosing.com/', '전담 PM이 프로젝트를 관리하는 방식으로 스타트업에 프리랜서·외주업체를 추천 매칭하는 신규 IT 아웃소싱 플랫폼이다.', true, null, null, null, '가입 후 프로젝트 의뢰·상담 진행', '전담 PM의 프로젝트 관리형 외주 매칭'),
  ('heybeagle', '헤이비글', 'freelance', 'domestic', 'https://heybeagle.co.kr/', 'MC·사회자·공연 전문가 견적 비교 섭외 플랫폼.', false, null, null, null, '전문가 프로필 등록/의뢰자 견적 요청', '공연·행사 전문가 견적 비교 섭외에 강점'),
  ('myoncast', '온캐스트', 'freelance', 'domestic', 'https://myoncast.com/', '아나운서·MC·사회자 매칭 섭외 서비스.', false, null, null, null, '전문가 등록/의뢰자 섭외 요청', '아나운서·MC·사회자 섭외 매칭에 강점'),
  ('ieumcompany', '이음컴퍼니', 'freelance', 'domestic', 'https://www.ieumcompany.co.kr/', '공연·사회자 섭외를 중개하는 플랫폼.', false, null, null, null, '전문가 등록/의뢰자 섭외 요청', '공연·사회자 섭외 중개에 강점'),
  ('lessoneasy', '레슨이지', 'freelance', 'domestic', 'https://lesson-easy.com/', '음악·미술·무용 레슨 강사 연결 플랫폼.', false, null, null, null, '강사 프로필 등록/수강생 매칭 신청', '음악·미술·무용 레슨 강사 연결에 강점'),
  ('lessoninfo', '레슨인포', 'freelance', 'domestic', 'https://lessoninfo.co.kr/', '음악 강사·학원 구인구직 매칭 플랫폼.', false, null, null, null, '강사·학원 가입 후 구인구직 등록', '음악 강사·학원 구인구직 매칭에 강점'),
  ('zimcarry', '짐캐리', 'freelance', 'domestic', 'https://zimcarry.net/', '여행짐 배송·보관 서비스 플랫폼.', false, null, null, null, '이용자 예약, 제휴처 파트너 등록', '여행짐 배송·보관 서비스에 강점'),
  ('lifeistravel', 'Life is Travel', 'freelance', 'domestic', 'https://www.lifeistravel.io/', '카페·편의점 제휴 기반 여행 짐보관 서비스.', false, null, null, null, '제휴 매장 등록/이용자 예약', '카페·편의점 제휴 기반 여행 짐보관에 강점'),
  ('goodlugg', 'Goodlugg', 'freelance', 'domestic', 'https://www.goodlugg.com/', '여행 수하물 배송·보관 글로벌 플랫폼.', false, null, null, null, '이용자 예약, 제휴처 파트너 등록', '여행 수하물 배송·보관에 강점'),
  ('ontrip', '온트립', 'freelance', 'overseas', 'http://www.ontrip.life/', '현지 가이드·투어·현지여행사를 직접 연결하는 플랫폼.', false, null, null, null, '가이드·현지여행사 등록/여행자 예약', '현지 가이드·현지여행사 직접 연결에 강점'),
  ('baemin', '배달의민족', 'delivery', 'domestic', 'https://www.baemin.com', '국내 1위 음식 배달 주문 중개.', false, 'high', '중개이용료+결제·배달비 별도(요금제별 상이)', null, '사업자등록·영업신고 후 입점 신청', '높은 주문 수요·배달 인프라로 주문 노출에 강점'),
  ('coupangeats', '쿠팡이츠', 'delivery', 'domestic', 'https://www.coupangeats.com', '쿠팡의 음식 배달 주문 중개.', false, 'high', '중개이용료+결제·배달비 별도(요금제별 상이)', null, '사업자등록·영업신고 후 입점 신청', '쿠팡 회원 트래픽 기반 단건배달에 강점'),
  ('yogiyo', '요기요', 'delivery', 'domestic', 'https://www.yogiyo.co.kr', '음식 배달 주문 중개.', false, 'high', '중개이용료+결제·배달비 별도(요금제별 상이)', null, '사업자등록·영업신고 후 입점 신청', '배달 주문중개·프랜차이즈 노출에 강점'),
  ('ddangyo', '땡겨요', 'delivery', 'domestic', 'https://www.ddangyo.com', '신한 계열, 낮은 수수료를 내세운 배달 앱.', false, 'low', '낮은 중개수수료 표방(신한 계열)', null, '사업자등록·영업신고 후 입점 신청', '낮은 수수료 부담, 지역상권 배달에 강점'),
  ('home', '부릉', 'delivery', 'domestic', 'https://home.vroong.com/', '상점 대상 프리미엄 배달대행(라이더 물류) 플랫폼.', false, null, null, null, '상점 계약 후 배달대행 이용', '상점 대상 프리미엄 라이더 물류·배달대행에 강점'),
  ('logiall', '생각대로', 'delivery', 'domestic', 'https://www.logiall.com/', '로지올이 운영하는 지역 배달대행 네트워크.', false, null, null, null, '지역 대리점 계약 후 이용', '전국 지역 배달대행 네트워크 규모에 강점'),
  ('mannaplus', '만나플러스', 'delivery', 'domestic', 'https://manna-plus.kr/', '배달대행 관제·정산 플랫폼.', false, null, null, null, '배달대행사·상점 가입 후 이용', '배달대행 관제·정산 관리에 강점'),
  ('spidor', '영웅배송 스파이더', 'delivery', 'domestic', 'http://www.spidor.co.kr/', 'IT 기반 종합 배달대행 플랫폼.', false, null, null, null, '배달대행사·상점 가입 후 이용', 'IT 기반 종합 배달대행 관제에 강점'),
  ('wmpo', '위메프오', 'delivery', 'domestic', 'https://www.wmpo.co.kr/', '저수수료 배달·픽업 주문중개 앱.', false, 'low', '저중개수수료 표방', null, '사업자등록·영업신고 후 입점 신청', '낮은 수수료, 픽업·배달 주문중개에 강점'),
  ('mukkebi', '먹깨비', 'delivery', 'domestic', 'https://www.mukkebi.com/', '지역화폐 연계 저수수료 공공배달앱.', false, 'low', '저수수료 공공배달(지역화폐 연계)', null, '지역 소재 사업자 입점 신청', '지역화폐 결제·낮은 수수료에 강점'),
  ('daeguro', '대구로', 'delivery', 'domestic', 'https://daeguro.co.kr/', '대구시 공식 저수수료 공공배달앱.', false, 'low', '저수수료 공공배달', null, '대구 소재 사업자 입점 신청', '대구 지역 공공배달, 낮은 수수료에 강점'),
  ('specialdelivery', '배달특급', 'delivery', 'domestic', 'https://www.specialdelivery.co.kr/', '경기도 공공배달앱, 지역화폐 결제 지원.', false, 'low', '저수수료 공공배달(지역화폐 연계)', null, '경기도 소재 사업자 입점 신청', '경기도 공공배달, 지역화폐 결제에 강점'),
  ('neubility', '뉴빌리티', 'delivery', 'domestic', 'https://www.neubility.co.kr/', '자율주행 배달로봇 라스트마일 배달 스타트업.', false, null, null, null, '제휴 문의 기반 B2B 도입', '자율주행 로봇 기반 라스트마일 배달에 강점'),
  ('insungdata', '인성데이타', 'delivery', 'domestic', 'https://insungdata.com/', '이륜차 퀵·배달대행 관제 프로그램 개발사.', false, null, null, null, '배달대행사 대상 프로그램 도입 계약', '이륜차 퀵·배달대행 관제 SW에 강점'),
  ('gunsan', '배달의명수', 'delivery', 'domestic', 'https://www.gunsan.go.kr/main/m2359', '군산시 공공배달앱(전국 최초), 중개수수료·광고료 없음.', false, 'low', '중개수수료·광고료 없음', null, '군산 소재 사업자 입점 신청', '무중개수수료 공공배달(전국 최초)'),
  ('apps7', '배달올거제', 'delivery', 'domestic', 'https://apps.apple.com/kr/app/id1561575473', '거제시 공공배달앱, 수수료·광고료·가입비 3무.', false, 'low', '수수료·광고료·가입비 없음', null, '거제 소재 사업자 입점 신청', '수수료·광고료·가입비 부담 없는 공공배달'),
  ('play', '놀장', 'delivery', 'domestic', 'https://play.google.com/store/apps/details?id=com.noljang', '전통시장 점포 장보기·배달 시장 배달 플랫폼.', false, null, null, null, '전통시장 점포 입점 신청', '전통시장 점포 장보기·배달에 강점'),
  ('jecheon', '배달모아', 'delivery', 'domestic', 'https://www.jecheon.go.kr/www/contents.do?key=49079', '제천시 공공배달앱, 지역화폐 할인·무수수료.', false, 'low', '무수수료(지역화폐 할인)', null, '제천 소재 사업자 입점 신청', '제천 공공배달, 무수수료·지역화폐 할인에 강점'),
  ('bsnamgu', '어디고', 'delivery', 'domestic', 'https://www.bsnamgu.go.kr/', '부산 남구 공공배달앱, 오륙도페이 결제.', false, 'low', '저수수료 공공배달', null, '부산 남구 소재 사업자 입점 신청', '부산 남구 공공배달, 오륙도페이 결제에 강점'),
  ('play2', '울산페달', 'delivery', 'domestic', 'https://play.google.com/store/apps/details?id=gov.ulsan.uspay', '울산시 공공배달, 울산페이 기반 저수수료.', false, 'low', '저수수료 공공배달(울산페이 연계)', null, '울산 소재 사업자 입점 신청', '울산 공공배달, 울산페이·저수수료에 강점'),
  ('incheoneum', '배달e음', 'delivery', 'domestic', 'https://incheoneum.or.kr/service/delivery', '인천e음 지역화폐 기반 공공배달·캐시백.', false, 'low', '저수수료 공공배달(지역화폐 연계)', null, '인천 소재 사업자 입점 신청', '인천e음 연계 공공배달·캐시백에 강점'),
  ('apps8', '소문난샵', 'delivery', 'domestic', 'https://apps.apple.com/kr/app/id1479154838', '지역 소상공인 배달·픽업 앱(공공배달 연계).', false, null, null, null, '사업자 가맹·입점 신청 후 메뉴 등록', '지역 소상공인·공공배달 연계 주문중개에 강점'),
  ('24242424', '화물맨', 'delivery', 'domestic', 'https://2424-2424.com/', '화주·화물차 기사 연결 화물 운송·퀵 중개.', false, null, null, null, '화주·기사 가입 후 건별 접수', '화주-화물차 기사 매칭 운송·퀵 중개에 강점'),
  ('gogox', '고고엑스', 'delivery', 'domestic', 'https://www.gogox.com/kr/', '오토바이~트럭 퀵·용달·화물 실시간 중개.', false, null, null, null, '가입 후 건별 접수·즉시 이용', '오토바이~트럭 실시간 퀵·용달·화물 배차에 강점'),
  ('algoquick', '알고퀵', 'delivery', 'domestic', 'https://algoquick.com/', '실시간 요금·관제 온디맨드 퀵·화물 배송.', false, null, null, null, '가입 후 건별 접수·실시간 견적', '실시간 요금·관제 기반 온디맨드 배송에 강점'),
  ('hudadaq', '후다닥', 'delivery', 'domestic', 'https://www.hudadaq.com/', '퀵·용달·화물·간단이사 자동견적 배송 플랫폼.', false, null, null, null, '가입 후 자동견적·건별 접수', '퀵·용달·화물·간단이사 자동견적 배송에 강점'),
  ('callkim', '콜킴', 'delivery', 'domestic', 'https://callkim.co.kr/', '오토바이·다마스·트럭 퀵서비스 요금조회·접수.', false, null, null, null, '가입 후 요금조회·건별 접수', '오토바이·다마스·트럭 퀵 요금조회·접수에 강점'),
  ('kakaomobility2', '카카오T 퀵', 'delivery', 'domestic', 'https://www.kakaomobility.com/service-kakaot/quick', '카카오모빌리티 퀵·도보 배송 서비스.', false, null, null, null, '카카오T 가입 후 건별 접수', '카카오T 연계 퀵·도보 배송 접근성에 강점'),
  ('play3', '퀵톡', 'delivery', 'domestic', 'https://play.google.com/store/apps/details?id=kr.co.nssoft.quicktalk', '전국 퀵서비스·화물 당일배송 접수 앱.', false, null, null, null, '가입 후 건별 접수·당일배송', '전국 퀵·화물 당일배송 접수에 강점'),
  ('ssinging', '씽잉', 'delivery', 'domestic', 'https://ssinging.com/', '배달·구매대행·설치·청소 종합 심부름 앱.', false, null, null, null, '가입 후 심부름 건별 접수', '배달·구매대행·설치·청소 종합 심부름에 강점'),
  ('amazing', '브이투브이', 'delivery', 'domestic', 'https://www.amazing.today/', '창고 없이 차량이 노선을 순환하며 물품을 주고받는 방식으로 수도권 당일배송을 제공하는 신생 도시물류 스타트업 서비스.', true, null, null, null, '가입 후 배송 건별 접수', '창고 없이 노선순환 방식 수도권 당일배송에 강점'),
  ('wemeetmobility', '위밋모빌리티', 'delivery', 'domestic', 'https://www.wemeetmobility.com/', '2023년 시작한 제주 지역 특화 당일배송 서비스로, 배차 최적화 기술을 활용한 지역기반 라스트마일 신규 서비스.', true, null, null, null, '가입 후 배송 건별 접수', '제주 지역 특화 배차최적화 라스트마일에 강점'),
  ('chainlogis', '체인로지스', 'delivery', 'domestic', 'https://chainlogis.com/', '물류 이륜차를 활용해 입고 후 4시간 내 당일도착을 표방하는 라스트마일 배송 스타트업.', true, null, null, null, '셀러 계약·입고 후 이용', '입고 후 4시간 내 당일도착 라스트마일에 강점'),
  ('returnit', '잇그린', 'delivery', 'domestic', 'https://www.returnit.kr/', '배달 다회용기를 배송·수거·세척해 순환시키는 친환경 라스트마일 신규 서비스.', true, null, null, null, '매장·사업자 제휴 후 이용', '배달 다회용기 순환(수거·세척) 친환경 물류에 강점'),
  ('inflow', 'INFLOW', 'delivery', 'domestic', 'https://in-flow.co.kr/', '이륜 라이더 대상 차량·관제와 퀵서비스(무브온) 등을 운영하는 라스트마일 모빌리티·배송대행 신생 플랫폼.', true, null, null, null, '라이더·사업자 가입 후 이용', '이륜 라이더 차량·관제·배송대행 통합 운영에 강점'),
  ('fassto', '파스토(FASSTO)', 'fulfillment', 'domestic', 'https://www.fassto.ai', '이커머스 셀러 대상 풀필먼트(보관·출고).', false, null, null, null, '셀러 계약·상품 입고 후 이용', '이커머스 셀러 보관·출고 풀필먼트에 강점'),
  ('dohandsome', '두손컴퍼니', 'fulfillment', 'domestic', 'https://dohandsome.com', '소량·스타트업 친화 풀필먼트.', false, null, null, null, '셀러 계약·상품 입고 후 이용', '소량·스타트업 친화 풀필먼트에 강점'),
  ('wekeep', '위킵', 'fulfillment', 'domestic', 'https://wekeep.co.kr', '쇼핑몰 물류 대행·풀필먼트.', false, null, null, null, '쇼핑몰 계약·상품 입고 후 이용', '쇼핑몰 물류대행·풀필먼트에 강점'),
  ('qxpress', '큐익스프레스', 'fulfillment', 'overseas', 'https://www.qxpress.net', '국제 배송·해외 풀필먼트.', false, null, null, null, '셀러 계약·상품 입고 후 이용', '국제 배송·해외 풀필먼트에 강점'),
  ('welcome', '품고', 'fulfillment', 'domestic', 'https://welcome.poomgo.com/', '이커머스 셀러 대상 풀필먼트 서비스.', false, null, null, null, '셀러 계약·상품 입고 후 이용', '이커머스 셀러 대상 풀필먼트에 강점'),
  ('ourbox', '아워박스', 'fulfillment', 'domestic', 'https://www.ourbox.co.kr/', '물류 자동화 설비 기반 풀필먼트 기업.', false, null, null, null, '셀러 계약·상품 입고 후 이용', '물류 자동화 설비 기반 풀필먼트에 강점'),
  ('dealibird', '딜리버드', 'fulfillment', 'domestic', 'https://dealibird.com/', '동대문 의류·잡화 전문 사입~배송 풀필먼트.', false, null, null, null, '셀러 계약 후 사입~배송 위탁', '동대문 의류·잡화 사입~배송 풀필먼트에 강점'),
  ('mychango', '마이창고', 'fulfillment', 'domestic', 'https://mychango.com/', '중소 셀러 대상 보관·물류대행 풀필먼트.', false, null, null, null, '셀러 계약·상품 입고 후 이용', '중소 셀러 보관·물류대행 풀필먼트에 강점'),
  ('colosseum', '콜로세움', 'fulfillment', 'domestic', 'https://colosseum.kr/', '보관~포장~배송~반품 풀필먼트 DX 플랫폼.', false, null, null, null, '셀러 계약·상품 입고 후 이용', '보관~포장~배송~반품 풀필먼트 DX에 강점'),
  ('ezadmin', '이지어드민', 'fulfillment', 'domestic', 'https://www.ezadmin.co.kr/', '쇼핑몰 통합관리·창고관리(WMS) 솔루션.', false, null, null, null, '가입·설정 후 통합관리 이용', '쇼핑몰 통합관리·WMS 솔루션에 강점'),
  ('logispot', '로지스팟', 'fulfillment', 'domestic', 'https://www.logi-spot.com/', 'IT 기반 화물운송·통합 물류 서비스.', false, null, null, null, '화주 계약 후 화물운송 이용', 'IT 기반 화물운송·통합 물류에 강점'),
  ('logiket', '로지켓', 'fulfillment', 'domestic', 'https://logiket.com/', '물류사 비교견적 3PL 대행 매칭 플랫폼.', false, null, null, null, '가입 후 비교견적·매칭 이용', '물류사 비교견적 3PL 대행 매칭에 강점'),
  ('cjlogistics', 'CJ대한통운 e-풀필먼트', 'fulfillment', 'domestic', 'https://www.cjlogistics.com/ko/business/fulfillment', '이커머스 통합 풀필먼트(더 풀필) 서비스.', false, null, null, null, '셀러 계약·상품 입고 후 이용', '이커머스 통합 풀필먼트·전국 배송망에 강점'),
  ('sellerrouteground', '루트그라운드', 'fulfillment', 'domestic', 'https://sellerrouteground.com/', '3PL 풀필먼트·로켓그로스 납품 대행.', false, null, null, null, '셀러 계약·상품 입고 후 이용', '3PL 풀필먼트·로켓그로스 납품 대행에 강점'),
  ('returneeds', '리터니즈', 'fulfillment', 'domestic', 'https://returneeds.com/', '2023년 설립돼 반품 전용 센터를 기반으로 이커머스 반품 물류를 대행하는 신생 역물류 스타트업.', true, null, null, null, '셀러 계약 후 반품물류 위탁', '반품 전용센터 기반 역물류 대행에 강점'),
  ('enterround', '엔터라운드', 'fulfillment', 'domestic', 'https://www.enter-round.kr/', '국내외 풀필먼트와 103개국 해외배송·역직구 배송대행을 결합한 크로스보더 물류 신규 서비스.', true, null, null, null, '셀러 계약·상품 입고 후 이용', '국내외 풀필먼트+해외배송 크로스보더 물류에 강점'),
  ('argoport', '테크타카', 'fulfillment', 'domestic', 'https://www.argoport.com/', '수요예측·재고·배송을 통합한 소프트웨어 기반 3PL 풀필먼트를 제공하는 물류 SaaS 스타트업.', true, null, null, null, '셀러 계약·상품 입고 후 이용', '수요예측·재고·배송 통합 SW 기반 3PL에 강점'),
  ('bold9', '볼드나인', 'fulfillment', 'domestic', 'https://www.bold-9.com/', '자체 풀필먼트 시스템으로 이커머스 셀러의 주문·배송·CS를 대행하는 기술 기반 풀필먼트 스타트업.', true, null, null, null, '셀러 계약·상품 입고 후 이용', '주문·배송·CS 통합 대행 풀필먼트에 강점'),
  ('alibaba', '알리바바닷컴', 'global', 'overseas', 'https://www.alibaba.com', '글로벌 B2B 도매·소싱 마켓플레이스.', false, null, null, null, '사업자 등록·멤버십 가입 후 상품 등록', '글로벌 B2B 도매·해외 바이어 소싱에 강점'),
  ('amazongs', '아마존 글로벌셀링', 'global', 'overseas', 'https://sell.amazon.com', '아마존 해외 마켓 입점·판매.', false, 'high', '카테고리별 판매수수료+월 계정료', '약 2주 주기 정산', '해외판매 계정·세금정보 등록 필요', '아마존 글로벌 마켓 진출·해외판매에 강점'),
  ('shopee', '쇼피(Shopee)', 'global', 'overseas', 'https://shopee.com', '동남아·대만 중심 이커머스 마켓.', false, 'mid', '마켓·카테고리별 수수료 상이', null, '글로벌셀러 등록·해외판매 계정 필요', '동남아·대만 이커머스 진출에 강점'),
  ('qoo10', '큐텐(Qoo10)', 'global', 'overseas', 'https://www.qoo10.com', '일본 등 아시아권 오픈마켓.', false, 'mid', null, null, '사업자등록 후 셀러 가입·크로스보더 판매', '일본 등 아시아권 역직구 판매에 강점'),
  ('tradekorea', 'tradeKorea', 'global', 'overseas', 'https://www.tradekorea.com', 'KOTRA 운영 B2B 수출 매칭 플랫폼.', false, null, null, null, '무료 회원가입 후 기업·수출상품 등록', 'KOTRA 운영 B2B 바이어 매칭·수출 상담에 강점'),
  ('buykorea', '바이코리아', 'global', 'overseas', 'https://www.buykorea.org', 'KOTRA 운영 수출 지원 B2B 플랫폼.', false, null, null, null, '무료 가입 후 수출상품 등록', 'KOTRA 운영 수출 지원·해외 바이어 연결에 강점'),
  ('ec21', 'EC21', 'global', 'overseas', 'https://www.ec21.com', '국내 대표 B2B 수출 마켓플레이스.', false, null, null, null, '가입 후 기업·상품 등록', 'B2B 수출 상품 노출·해외 인콰이어리 확보에 강점'),
  ('ebay', '이베이 셀러', 'global', 'overseas', 'https://www.ebay.com/', '한국 판매자가 전 세계 이베이에 해외판매하는 채널.', false, 'mid', null, null, '이베이 셀러 계정 등록 후 해외판매', '전 세계 대상 개인·소량 해외판매에 강점'),
  ('lazada', '라자다', 'global', 'overseas', 'https://www.lazada.com/', '동남아 크로스보더 셀러 입점 마켓플레이스.', false, 'mid', null, null, '크로스보더 셀러 등록 후 동남아 판매', '동남아 크로스보더 판매에 강점'),
  ('wish', '위시', 'global', 'overseas', 'https://www.wish.com/', '북미·유럽 중심 모바일 커머스 역직구 입점.', false, 'mid', null, null, '셀러 가입 후 상품 등록·해외판매', '북미·유럽 모바일 역직구 판매에 강점'),
  ('seller', '틱톡샵', 'global', 'overseas', 'https://seller.tiktok.com/', '숏폼 기반 크로스보더 셀러센터 해외판매.', false, null, null, null, '크로스보더 셀러센터 등록 후 판매', '숏폼·라이브 기반 크로스보더 판매에 강점'),
  ('seller2', '테무 셀러', 'global', 'overseas', 'https://seller.temu.com/', '저가 대량 판매 마켓플레이스 셀러 입점.', false, null, null, null, '셀러 입점 심사 후 상품 공급', '저가 대량 판매 시장 진입에 강점'),
  ('sell', '알리익스프레스 글로벌셀링', 'global', 'overseas', 'https://sell.aliexpress.com/', '한국 상품을 해외에 파는 알리익스프레스 셀러.', false, 'mid', null, null, '글로벌셀링 셀러 등록 후 해외판매', '알리 채널로 해외 소비자 판매에 강점'),
  ('rakuten', '라쿠텐', 'global', 'overseas', 'https://www.rakuten.co.jp/', '일본 최대 온라인 마켓 입점 판매.', false, 'mid', null, null, '입점 심사 후 일본 시장 판매', '일본 종합몰 판매에 강점'),
  ('marketplace', '월마트 마켓플레이스', 'global', 'overseas', 'https://marketplace.walmart.com/', '미국 대형 유통 마켓 초청제 글로벌 셀러.', false, 'mid', null, null, '초청·심사 후 미국 마켓 셀러 등록', '미국 대형 유통 마켓 진입에 강점'),
  ('shopify', '쇼피파이', 'global', 'overseas', 'https://www.shopify.com/kr', '다국어·다통화 자사몰로 해외 직접 판매 솔루션.', false, null, null, null, '구독 가입 후 자사몰 구축·해외 직접 판매', '다국어·다통화 자사몰 구축에 강점'),
  ('cafe24', '카페24 글로벌', 'global', 'overseas', 'https://www.cafe24.com/ecommerce/global/', '다국어 쇼핑몰·해외결제·배송 지원 솔루션.', false, null, null, null, '가입 후 다국어 쇼핑몰 구축', '해외결제·배송 연동 쇼핑몰 구축에 강점'),
  ('global', '메이크샵 글로벌', 'global', 'overseas', 'https://global.makeshop.com/', '영·일·중 통합 쇼핑몰 해외판매 솔루션.', false, null, null, null, '가입 후 다국어 쇼핑몰 구축', '영·일·중 통합 쇼핑몰 해외판매에 강점'),
  ('kr', '고비즈코리아', 'global', 'overseas', 'https://kr.gobizkorea.com/', '중소기업유통센터 B2B 온라인수출·바이어 매칭.', false, null, null, null, '중소기업 가입 후 수출상품 등록', '중소기업 온라인 수출·바이어 매칭에 강점'),
  ('marketplace2', '쿠팡 로켓그로스 해외진출', 'global', 'overseas', 'https://marketplace.coupang.com/', '쿠팡 통해 대만 등 해외 시장 동반 진출.', false, null, null, null, '쿠팡 셀러 자격으로 해외진출 프로그램 신청', '쿠팡 인프라로 대만 등 해외 동반 진출에 강점'),
  ('musinsa2', '무신사 글로벌', 'global', 'overseas', 'https://global.musinsa.com/', 'K-패션 브랜드 해외 소비자 대상 역직구 스토어.', false, null, null, null, '무신사 입점 브랜드 대상 글로벌 스토어 노출', 'K-패션 브랜드 역직구 판매에 강점'),
  ('malltail', '몰테일', 'global', 'overseas', 'https://www.malltail.com/', '9개국 물류 기반 역직구·해외배송 대행.', false, null, null, null, '회원가입 후 해외 배송대행 이용', '9개국 물류 기반 역직구·해외배송 대행에 강점'),
  ('delivered', '딜리버드 코리아', 'global', 'overseas', 'https://www.delivered.co.kr/', '한국 셀러 해외판매·배송 크로스보더 서비스.', false, null, null, null, '셀러 가입 후 해외판매·배송대행 이용', '한국 셀러 해외판매·배송 대행에 강점'),
  ('sellerhub', '셀러허브', 'global', 'overseas', 'https://www.sellerhub.co.kr/', '국내외 쇼핑몰 통합 관리 멀티채널 판매 솔루션.', false, null, null, null, '가입 후 쇼핑몰 연동·상품 통합 관리', '국내외 멀티채널 통합 관리에 강점'),
  ('shopigate', '쇼피게이트', 'global', 'overseas', 'https://shopigate.co.kr/', '쇼피파이 스토어 구축~해외물류 역직구 대행.', false, null, null, null, '상담 후 쇼피파이 스토어·물류 대행 이용', '쇼피파이 구축~해외물류 역직구 대행에 강점'),
  ('shipda', '셀러노트', 'global', 'domestic', 'https://www.ship-da.com', '이커머스 수입물류 포워딩 ''쉽다'' 운영.', false, null, null, null, '가입·견적 후 수입물류 포워딩 이용', '이커머스 수입물류 포워딩에 강점'),
  ('iporter', '아이포터', 'global', 'overseas', 'https://www.iporter.com', '미국·일본 배송대행·구매대행 서비스.', false, null, null, null, '회원가입 후 배송·구매대행 이용', '미국·일본 배송·구매대행에 강점'),
  ('ohmyzip', '오마이집', 'global', 'overseas', 'https://www.ohmyzip.com', '미국 물류센터 기반 해외 배송대행.', false, null, null, null, '회원가입 후 미국 배송대행 이용', '미국 물류센터 기반 배송대행에 강점'),
  ('tridge', '트릿지', 'global', 'overseas', 'https://www.tridge.com', '농식품 공급처·가격 데이터 B2B 무역 중개.', false, null, null, null, '가입 후 공급처·바이어 매칭 이용', '농식품 공급처·가격 데이터·무역 중개에 강점'),
  ('saruwa', '사루와', 'global', 'overseas', 'https://www.saruwa.co.kr', '일본 사이트 상품 구매·배송 대행 서비스.', false, null, null, null, '회원가입 후 일본 상품 구매·배송대행 이용', '일본 사이트 상품 구매·배송대행에 강점'),
  ('japandelivery', '재팬딜리버리', 'global', 'overseas', 'https://japandelivery.co.kr', '일본 쇼핑몰 구매·배송대행 서비스.', false, null, null, null, '회원가입 후 일본 구매·배송대행 이용', '일본 쇼핑몰 구매·배송대행에 강점'),
  ('rakuten2', '라쿠텐 이치바 셀러', 'global', 'overseas', 'https://www.rakuten.co.jp/ec/sellinjapan/kr/', '일본 최대급 종합몰 라쿠텐 이치바에 한국 셀러가 입점해 현지 판매하는 공식 셀러 프로그램.', false, 'mid', null, null, '입점 심사 후 일본 라쿠텐 이치바 판매', '일본 종합몰 현지 판매에 강점'),
  ('sell2', 'noon 셀러', 'global', 'overseas', 'https://sell.withnoon.com/en/', '중동 대표 마켓플레이스 눈(noon)의 판매자 등록 포털.', false, null, null, null, '셀러 등록·심사 후 중동 판매', '중동 마켓플레이스 판매에 강점'),
  ('global2', 'Ozon Global', 'global', 'overseas', 'https://global.ozon.com/', '러시아 오존 마켓에 해외 셀러가 상품을 공급하는 크로스보더 판매 채널.', false, null, null, null, '크로스보더 셀러 등록 후 러시아 판매', '러시아 오존 마켓 크로스보더 판매에 강점'),
  ('seller3', 'Flipkart Seller Hub', 'global', 'overseas', 'https://seller.flipkart.com/', '인도 대형 이커머스 플립카트의 셀러 등록·운영 허브.', false, null, null, null, '셀러 등록·심사 후 인도 마켓 판매', '인도 대형 이커머스 판매에 강점'),
  ('group', 'Jumia Marketplace 셀러', 'global', 'overseas', 'https://group.jumia.com/business/marketplace/sell', '나이지리아 등 아프리카 다국가를 커버하는 주미아 마켓플레이스 판매자 등록.', false, null, null, null, '셀러 등록 후 아프리카 마켓 판매', '아프리카 다국가 마켓 판매에 강점'),
  ('partner', 'Zalando Partner Program', 'global', 'overseas', 'https://partner.zalando.com/', '유럽 패션 마켓 잘란도의 승인형 파트너(입점) 프로그램.', false, null, null, null, '파트너 승인 심사 후 유럽 패션 판매', '유럽 패션 마켓 파트너 판매에 강점'),
  ('marketplace3', 'Cdiscount Marketplace', 'global', 'overseas', 'https://marketplace.cdiscount.com/en/service/international-sales/', '프랑스 씨디스카운트 마켓의 해외 셀러용 인터내셔널 판매 프로그램.', false, null, null, null, '셀러 등록 후 프랑스·유럽 판매', '프랑스 마켓 해외 셀러 판매에 강점'),
  ('sell3', 'Fruugo', 'global', 'overseas', 'https://sell.fruugo.com/en/', '40여 개국 다국어·다통화로 자동 노출되는 크로스보더 마켓플레이스.', false, null, null, null, '사업자 셀러 심사 후 입점(크로스보더)', '40여개국 다국어·다통화 자동 노출에 강점'),
  ('kogan', 'Kogan Marketplace', 'global', 'overseas', 'https://www.kogan.com/au/kogan-marketplace/', '호주 코간닷컴의 서드파티 셀러 마켓플레이스.', false, null, null, null, '사업자 셀러 심사 후 입점', '호주 코간닷컴 트래픽 기반 현지 판매에 강점'),
  ('reverb', 'Reverb', 'global', 'overseas', 'https://reverb.com/selling', '신품·빈티지 악기와 음향장비 전문 글로벌 셀러 마켓.', false, 'low', '판매수수료+결제수수료 구조', null, '개인·사업자 가입 후 상품 등록', '신품·빈티지 악기·음향장비 전문 수요에 강점'),
  ('sellervn', 'TikTok Shop 베트남 셀러센터', 'global', 'overseas', 'https://seller-vn.tiktok.com/', '틱톡샵 베트남의 국가별 판매자 센터(로컬·크로스보더 스토어).', false, null, null, null, '현지·크로스보더 셀러 가입 후 스토어 개설', '틱톡샵 베트남 숏폼·라이브 커머스 노출에 강점'),
  ('sellerid', 'Tokopedia 셀러센터', 'global', 'overseas', 'https://seller-id.tokopedia.com/', '인도네시아 토코피디아(틱톡샵 통합)의 셀러 관리 센터.', false, null, null, null, '셀러 가입 후 스토어 개설', '인도네시아 토코피디아·틱톡샵 통합 노출에 강점'),
  ('globalsellers', '쿠팡 글로벌셀러', 'global', 'overseas', 'https://globalsellers.coupang.com/', '국내 제조·판매사가 대만 등 쿠팡 해외 채널로 진출하는 글로벌셀러 프로그램.', false, null, null, null, '국내 제조·판매 사업자 심사 후 참여', '쿠팡 대만 등 해외 채널 진출에 강점'),
  ('sell4', '아마존 글로벌셀링 외부 서비스 사업자 네트워크', 'global', 'domestic', 'https://sell.amazon.co.kr/support/service-provider-network', '인증·물류·마케팅 등 아마존 진출을 돕는 공식 서비스 프로바이더(에이전시) 목록.', false, null, null, null, '아마존 진출 사업자가 서비스 파트너 탐색', '인증·물류·마케팅 공식 파트너 연결에 강점'),
  ('sellerpick', '셀러픽', 'global', 'domestic', 'https://www.sellerpick.co.kr/', '해외 마켓 상품 등록·이미지 번역·AI 추천을 지원하는 역직구/구매대행 솔루션.', false, null, null, null, '가입 후 이용', '해외 상품 등록·이미지 번역·AI 추천 지원에 강점'),
  ('globalselling', 'Mercado Libre Global Selling', 'global', 'overseas', 'https://global-selling.mercadolibre.com/', '멕시코·브라질 등 중남미를 단일 계정으로 판매하는 메르카도리브레 크로스보더 프로그램.', false, null, null, null, '셀러 가입·심사 후 단일 계정 판매', '멕시코·브라질 등 중남미 크로스보더 진출에 강점'),
  ('domeggook', '도매꾹', 'wholesale', 'domestic', 'https://domeggook.com', '국내 대표 온라인 도매·소량 사입.', false, null, null, null, '회원가입 후 구매, 판매는 셀러 등록', '소량 사입·국내 온라인 도매 물량에 강점'),
  ('domemedae', '도매매', 'wholesale', 'domestic', 'https://domeme.domeggook.com', '배송대행(위탁판매) 특화 도매.', false, null, null, null, '사업자등록 후 위탁판매 셀러 가입', '무재고 배송대행(위탁판매) 소싱에 강점'),
  ('ownerclan', '오너클랜', 'wholesale', 'domestic', 'https://ownerclan.com', '위탁판매용 대량 상품 소싱.', false, null, null, null, '사업자등록 후 가입', '위탁판매용 대량 상품 소싱·연동에 강점'),
  ('onchannel', '온채널', 'wholesale', 'domestic', 'https://www.onch3.co.kr', '위탁·도매 상품 공급 플랫폼.', false, null, null, null, '사업자등록 후 가입', '위탁·도매 상품 공급에 강점'),
  ('dometopia', '도매토피아', 'wholesale', 'domestic', 'https://dometopia.com/', '무사입 위탁판매 중심 B2B 종합 도매몰.', false, null, null, null, '사업자등록 후 가입', '무사입 위탁판매 중심 종합 도매에 강점'),
  ('domesin', '도매의신', 'wholesale', 'domestic', 'https://www.domesin.com/', '배송대행 특화 B2B 위탁 도매몰.', false, null, null, null, '사업자등록 후 위탁 셀러 가입', '배송대행 특화 위탁 도매에 강점'),
  ('naggama', '나까마시장', 'wholesale', 'domestic', 'https://naggama.com/', '덤핑·재고 상품 도매 거래 커뮤니티.', false, null, null, null, '회원가입 후 거래 참여', '덤핑·재고 물량 도매 거래에 강점'),
  ('sellpie', '셀파이', 'wholesale', 'domestic', 'https://sellpie.co.kr/', '위탁판매 전문 도매 사이트.', false, null, null, null, '사업자등록 후 가입', '위탁판매 전문 상품 소싱에 강점'),
  ('sellerocean', '셀러오션', 'wholesale', 'domestic', 'https://sellerocean.com/', '위탁판매 공급자 연결 도매·소싱 플랫폼.', false, null, null, null, '사업자등록 후 가입', '위탁판매 공급자 연결에 강점'),
  ('sinsangmarket', '신상마켓', 'wholesale', 'domestic', 'https://sinsangmarket.kr/', '동대문 패션 도소매 B2B 사입 거래.', false, null, null, null, '사업자등록 후 앱 가입', '동대문 패션 도소매 B2B 사입에 강점'),
  ('zentrade', '젠트레이드', 'wholesale', 'domestic', 'https://www.zentrade.co.kr/', '문구·잡화·생필품 B2B 도매 사이트.', false, null, null, null, '사업자등록 후 가입', '문구·잡화·생필품 B2B 도매에 강점'),
  ('domaechanggo', '도매창고', 'wholesale', 'domestic', 'https://domaechanggo.com/', '위탁판매용 B2B 도매 쇼핑몰.', false, null, null, null, '사업자등록 후 가입', '위탁판매용 B2B 도매 상품에 강점'),
  ('modoosale', '모두세일', 'wholesale', 'domestic', 'https://www.modoosale.co.kr/', '위탁도매·배송대행 소싱 플랫폼.', false, null, null, null, '사업자등록 후 가입', '위탁도매·배송대행 소싱에 강점'),
  ('asadalin', '아사달도매몰', 'wholesale', 'domestic', 'https://asadalin.com/', '유아·아동복 전문 B2B 도매 마켓.', false, null, null, null, '사업자등록 후 가입', '유아·아동복 전문 도매 소싱에 강점'),
  ('saibmoa', '사입모아', 'wholesale', 'domestic', 'https://www.saibmoa.net', '동대문 의류 사입·배송 대행 사입삼촌 서비스.', false, null, null, null, '사업자등록 후 가입', '동대문 의류 사입·배송대행에 강점'),
  ('selpi', '셀피', 'wholesale', 'domestic', 'https://www.selpi.co.kr', '동대문 도매 신상을 소매 셀러에 연결하는 사입앱.', false, null, null, null, '사업자등록 후 앱 가입', '동대문 도매 신상을 소매 셀러에 연결에 강점'),
  ('sellernow', '셀러나우', 'wholesale', 'domestic', 'https://sellernow.co.kr', '도매사이트 모음·3PL 비교 셀러 지원 플랫폼.', false, null, null, null, '셀러 가입 후 이용', '도매처 모음·3PL 비교 셀러 지원에 강점'),
  ('domegod', '도매갓', 'wholesale', 'domestic', 'https://domegod.com', '사업자 전용 낱장구매·위탁배송 B2B 도매몰.', false, null, null, null, '사업자 전용 가입', '낱장구매·위탁배송 B2B 도매에 강점'),
  ('doogo', '두고', 'wholesale', 'domestic', 'https://doogo.co', '위탁 셀러·공급사 연결 구독형 도매 오픈마켓.', false, null, null, null, '셀러·공급사 가입 후 이용(구독형)', '구독형 위탁 도매 오픈마켓 소싱에 강점'),
  ('uh2samarket', '어이사마켓', 'wholesale', 'domestic', 'https://uh2samarket.com', '광저우 보세 직거래 사입·통관·배송 B2B.', false, null, null, null, '사업자등록 후 가입', '광저우 보세 직거래 사입·통관·배송에 강점'),
  ('chinabuy', '차이나바이', 'wholesale', 'domestic', 'https://www.chinabuy.co.kr', '1688·타오바오 중국 구매대행 앱.', false, null, null, null, '가입 후 앱 이용', '1688·타오바오 중국 구매대행에 강점'),
  ('algugo', '알구고', 'wholesale', 'domestic', 'https://algugo.co.kr', '1688 연동 자동주문·검수·물류 중국 구매대행.', false, null, null, null, '가입 후 이용', '1688 연동 자동주문·검수·물류에 강점'),
  ('foodpang', '푸드팡', 'wholesale', 'domestic', 'https://foodpang.co', '외식업 농산물 도매시장 직거래 식자재 배송.', false, null, null, null, '외식업 사업자 가입 후 주문', '농산물 도매시장 직거래 식자재 배송에 강점'),
  ('beseller', '비셀러', 'wholesale', 'domestic', 'https://www.beseller.net', '농수축산 식품 B2B 위탁판매 플랫폼.', false, null, null, null, '사업자등록 후 가입', '농수축산 식품 B2B 위탁판매에 강점'),
  ('hairnmi', '헤어앤미', 'wholesale', 'domestic', 'https://hairnmi.co.kr/', '미용실 전용 헤어제품을 도매하는 미용재료 전문 쇼핑몰.', false, null, null, null, '미용업 사업자 가입 후 구매', '미용실 전용 헤어제품 도매에 강점'),
  ('hairsoo', '헤어수', 'wholesale', 'domestic', 'https://www.hairsoo.com/', '염색약·펌제 등 미용재료를 도매가에 파는 전문몰.', false, null, null, null, '미용업 사업자 가입 후 구매', '염색약·펌제 등 미용재료 도매가에 강점'),
  ('dckitchen', '디씨키친', 'wholesale', 'domestic', 'https://www.dckitchen.co.kr/', '싱크대·작업대 등 업소용 주방기구를 파는 도매 쇼핑몰.', false, null, null, null, '사업자 회원가입 후 도매 구매', '업소용 주방기구·설비 도매 소싱에 강점'),
  ('jubangbank', '주방뱅크', 'wholesale', 'domestic', 'https://www.jubangbank.co.kr', '업소용 주방용품·주방기기를 전문으로 하는 도매 사이트.', false, null, null, null, '사업자 회원가입 후 도매 구매', '업소용 주방용품·주방기기 전문 소싱'),
  ('jubangmart', '중고주방마트', 'wholesale', 'domestic', 'https://jubangmart.kr/', '업소용 주방기구를 납품·매입·렌탈하는 중고 전문 플랫폼.', false, null, null, null, '사업자 회원가입 후 매입·납품·렌탈 이용', '중고 주방기구 매입·렌탈까지 처리'),
  ('mednara', '메드나라', 'wholesale', 'domestic', 'https://mednara.com/', '중고·신품 의료기기를 매입·판매하는 거래 사이트.', false, null, null, null, '사업자 회원가입 후 매입·판매 거래', '중고·신품 의료기기 거래에 강점'),
  ('medimarket', '메디마켓', 'wholesale', 'domestic', 'https://medimarket.kr/', '병원용 중고 의료기기를 매입·판매하는 거래 쇼핑몰.', false, null, null, null, '사업자 회원가입 후 매입·판매 거래', '병원용 중고 의료기기 매입·판매'),
  ('medisale', '메디세일', 'wholesale', 'domestic', 'https://medisale.co.kr/', '병원 의료소모품을 사업자에게 도매하는 사이트.', false, null, null, null, '사업자 회원가입 후 도매 구매', '병원 의료소모품 정기 소싱에 강점'),
  ('nongdal', '농사의달인', 'wholesale', 'domestic', 'https://www.nongdal.co.kr/', '비료·종자·농약 등 농자재를 파는 농업 전문 쇼핑몰.', false, null, null, null, '회원가입 후 농자재 구매', '비료·종자·농약 등 농자재 소싱'),
  ('nongmart', '농마트', 'wholesale', 'domestic', 'https://www.nongmart.co.kr/', '비료·농약 등 농자재를 최저가 보상제로 파는 도매 쇼핑몰.', false, null, null, null, '회원가입 후 농자재 구매', '농자재 최저가 보상제로 가격 소싱'),
  ('vkm101', '바이킹마켓', 'wholesale', 'domestic', 'https://www.vkm101.com/', '노량진 중도매인이 운영하는 사업자 전용 수산물 B2B 도매몰.', false, null, null, null, '사업자 회원가입 필요(사업자 전용)', '노량진 산지 수산물 사업자 직거래'),
  ('seapro', '씨프로', 'wholesale', 'domestic', 'https://seapro.kr/', '식당·급식업체용 냉동수산물을 중개하는 B2B 도매 플랫폼.', false, null, null, null, '사업자 회원가입 후 도매 거래', '식당·급식용 냉동수산물 소싱에 강점'),
  ('haemulsa', '해물사관학교', 'wholesale', 'domestic', 'https://haemulsa.com/', '냉동수산물을 도매 최저가로 직거래하는 온라인 사이트.', false, null, null, null, '회원가입 후 도매 구매', '냉동수산물 도매 직거래에 강점'),
  ('dsfoodmall', '디에스푸드몰', 'wholesale', 'domestic', 'https://www.dsfoodmall.com/', '축산물을 도소매로 직거래하는 정육 유통 쇼핑몰.', false, null, null, null, '사업자 회원가입 후 도소매 구매', '축산물 정육 도소매 직거래'),
  ('onnurimeat', '온누리축산', 'wholesale', 'domestic', 'https://onnurimeat.com/', '1++ 한우 등 축산물을 도매하는 정육 전문 쇼핑몰.', false, null, null, null, '사업자 회원가입 후 도매 구매', '한우 등급육 등 축산 도매 소싱'),
  ('meatasia', '수입육거래소', 'wholesale', 'domestic', 'https://meat-asia.com/', '수입육을 온라인으로 도매 중개하는 축산 거래소.', false, null, null, null, '사업자 회원가입 후 도매 거래', '수입육 온라인 도매 중개에 강점'),
  ('wholesale119', '꽃도매119', 'wholesale', 'domestic', 'https://wholesale119.com/', '양재 화훼시장 상품을 온라인으로 사입하는 꽃 도매 사이트.', false, null, null, null, '사업자 회원가입 후 사입 이용', '양재 화훼시장 절화 온라인 사입'),
  ('krflower', '코리아꽃도매', 'wholesale', 'domestic', 'https://www.krflower.kr/', '수입화·절화 등을 취급하는 화훼 온라인 도매몰.', false, null, null, null, '사업자 회원가입 후 도매 구매', '수입화·절화 등 화훼 도매 소싱'),
  ('dplaza', '디플라자', 'wholesale', 'domestic', 'https://www.dplaza.kr/', '동대문 원단·의류부자재·액세서리를 파는 도매 종합몰.', false, null, null, null, '사업자 회원가입 후 도매 사입', '동대문 원단·의류부자재·부속 소싱'),
  ('dongdaemun153', '동대문153', 'wholesale', 'domestic', 'https://www.dongdaemun153.co.kr/', '액세서리·봉제 부자재를 다루는 동대문 도매 쇼핑몰.', false, null, null, null, '사업자 회원가입 후 도매 사입', '액세서리·봉제 부자재 소싱에 강점'),
  ('ndmarket', '남도마켓', 'wholesale', 'domestic', 'https://www.ndmarket.co.kr/', '남대문·동대문 도매상품 사입을 돕는 B2B 소싱 플랫폼.', false, null, null, null, '사업자 회원가입 후 사입 대행 이용', '남대문·동대문 사입 대행 소싱'),
  ('sellup', '셀업', 'wholesale', 'domestic', 'https://www.sell-up.co.kr/', '동대문 도소매·사입삼촌의 소싱·주문·결제·정산을 앱으로 처리하는 패션 B2B 사입 플랫폼으로 최근 급성장한 신흥 서비스.', true, null, null, null, '앱 가입 후 소매·사입 이용', '동대문 사입 주문·결제·정산 앱 일원화'),
  ('yanolja', '야놀자', 'space', 'domestic', 'https://www.yanolja.com', '숙박·레저 예약 중개.', false, 'mid', '예약 중개 수수료(정률)', null, '숙박·레저 사업자 제휴 신청 후 입점', '국내 숙박·레저 예약 노출·중개에 강점'),
  ('goodchoice', '여기어때', 'space', 'domestic', 'https://www.goodchoice.kr', '숙박·액티비티 예약 중개.', false, 'mid', '예약 중개 수수료(정률)', null, '숙박·액티비티 사업자 제휴 신청 후 입점', '국내 숙박·액티비티 예약 노출·중개'),
  ('airbnb', '에어비앤비', 'space', 'overseas', 'https://www.airbnb.co.kr', '글로벌 숙소·체험 호스팅.', false, 'low', '호스트 서비스 수수료(약 3%)', '체크인 후 약 24시간 뒤 지급', '개인·사업자 호스트 등록 후 리스팅', '글로벌 여행객 대상 숙소·체험 호스팅'),
  ('spacecloud', '스페이스클라우드', 'space', 'domestic', 'https://www.spacecloud.kr', '모임·연습·촬영 공간 시간 대여.', false, null, null, null, '공간 호스트 등록 후 게시', '모임·연습·촬영 공간 시간 단위 대여'),
  ('catchtable', '캐치테이블', 'space', 'domestic', 'https://www.catchtable.co.kr', '식당 예약·웨이팅 중개.', false, null, null, null, '식당 사업자 제휴 등록 후 이용', '식당 예약·웨이팅 관리에 강점'),
  ('myrealtrip', '마이리얼트립', 'space', 'domestic', 'https://www.myrealtrip.com', '투어·가이드·액티비티 예약 중개.', false, 'mid', '판매 중개 수수료(정률)', null, '가이드·사업자 상품 등록 후 판매', '투어·가이드·액티비티 상품 판매'),
  ('klook', '클룩(Klook)', 'space', 'overseas', 'https://www.klook.com', '아시아권 여행·액티비티·티켓 예약.', false, 'mid', '판매 중개 수수료(정률)', null, '액티비티 사업자 제휴 등록 후 판매', '아시아권 여행·액티비티·티켓 판매'),
  ('agoda', '아고다', 'space', 'overseas', 'https://www.agoda.com/ko-kr/', '호텔·숙소 예약 글로벌 OTA 플랫폼.', false, 'high', '예약 중개 수수료(정률)', null, '숙소 사업자 제휴 등록 후 입점', '글로벌 호텔·숙소 예약 노출에 강점'),
  ('booking', '부킹닷컴', 'space', 'overseas', 'https://www.booking.com/', '전 세계 숙소·호텔 예약 글로벌 OTA.', false, 'high', '예약 중개 수수료(정률)', null, '숙소 사업자 제휴 등록 후 입점', '전 세계 숙소 예약 노출에 강점'),
  ('hotelscombined', '호텔스컴바인', 'space', 'overseas', 'https://www.hotelscombined.com/', '호텔 가격 비교 메타서치 플랫폼.', false, null, null, null, 'OTA·호텔 제휴 등록 후 노출', '호텔 가격 비교 메타서치 노출'),
  ('trivago', '트리바고', 'space', 'overseas', 'https://www.trivago.com/', '호텔 가격 비교 메타서치.', false, null, null, null, 'OTA·호텔 제휴 등록 후 노출', '호텔 가격 비교 메타서치 노출'),
  ('kr2', '트립닷컴', 'space', 'overseas', 'https://kr.trip.com/', '항공·호텔·투어 종합 여행 예약 플랫폼.', false, 'mid', '예약 중개 수수료(정률)', null, '여행 사업자 제휴 등록 후 판매', '항공·호텔·투어 종합 예약에 강점'),
  ('triple', '트리플', 'space', 'domestic', 'https://triple.guide/', 'AI 일정 생성·항공/호텔/투어 예약 여행 플랫폼.', false, null, null, null, '여행 상품 제휴 등록 후 연동', 'AI 일정 생성·항공/호텔/투어 예약 연동'),
  ('onlinetour', '온라인투어', 'space', 'domestic', 'https://www.onlinetour.co.kr/', '항공권·패키지·호텔 예약 종합 여행사.', false, null, null, null, '여행 상품 제휴 등록 후 판매', '항공권·패키지·호텔 예약에 강점'),
  ('mtour', '위메프 여행레저', 'space', 'domestic', 'https://mtour.wonders.app/', '여행·숙박·레저 특가 판매 서비스.', false, null, null, null, '여행·숙박·레저 사업자 제휴 등록', '여행·숙박·레저 특가 판매 노출'),
  ('waug', '와그', 'space', 'domestic', 'https://www.waug.com/', '입장권·액티비티·투어 예약 여행 플랫폼.', false, null, null, null, '여행·액티비티 사업자 제휴 후 상품 등록', '국내외 입장권·투어·액티비티 예약에 강점'),
  ('frip', '프립', 'space', 'domestic', 'https://www.frip.co.kr/', '취미 클래스·액티비티·모임 예약 여가 플랫폼.', false, null, null, null, '호스트 가입·클래스 개설 후 심사', '취미 클래스·여가 액티비티 모객에 강점'),
  ('stayfolio', '스테이폴리오', 'space', 'domestic', 'https://www.stayfolio.com/', '디자인·감성 숙소 큐레이션 예약 플랫폼.', false, null, null, null, '숙소 제휴·큐레이션 심사 후 등록', '디자인·감성 숙소 큐레이션 노출에 강점'),
  ('livinginhotel', '호텔에삶', 'space', 'domestic', 'https://www.livinginhotel.com/', '호텔·레지던스 한 달 살기 단기 숙박 중개.', false, null, null, null, '호텔·레지던스 제휴 후 등록', '호텔·레지던스 한 달 살기 단기임대 중개에 강점'),
  ('wehome', '위홈', 'space', 'domestic', 'https://www.wehome.me/', '홈스테이 공유숙박 중개 플랫폼.', false, null, null, null, '호스트 가입·공유숙박 요건 확인 후 등록', '합법 공유숙박·홈스테이 중개에 강점'),
  ('hourplace', '아워플레이스', 'space', 'domestic', 'https://hourplace.co.kr/', '촬영 스튜디오·공간 시간제 예약 대여.', false, null, null, null, '공간 호스트 등록·심사 후 게시', '촬영 스튜디오·공간 시간제 대여에 강점'),
  ('shareit', '쉐어잇', 'space', 'domestic', 'https://shareit.kr/', '팝업·워크숍·모임 공간 중개 대여.', false, null, null, null, '공간 호스트 등록 후 게시', '팝업·워크숍·모임 공간 중개에 강점'),
  ('moim', '토즈', 'space', 'domestic', 'https://moim.toz.co.kr/', '모임·회의실·스터디룸 공간 예약.', false, null, null, null, '지점 예약 또는 공간 제휴 후 이용', '모임·회의·스터디 공간 예약에 강점'),
  ('camfit', '캠핏', 'space', 'domestic', 'https://camfit.co.kr/', '캠핑장·글램핑·차박 실시간 예약.', false, null, null, null, '캠핑장 사업자 제휴 후 등록', '캠핑장·글램핑·차박 실시간 예약에 강점'),
  ('thankqcamping', '땡큐캠핑', 'space', 'domestic', 'https://www.thankqcamping.com/', '캠핑장 실시간 예약·잔여석·리뷰.', false, null, null, null, '캠핑장 사업자 제휴 후 등록', '캠핑장 실시간 예약·잔여석 확인에 강점'),
  ('tabling', '테이블링', 'space', 'domestic', 'https://www.tabling.co.kr/', '식당 원격 줄서기·예약 웨이팅 플랫폼.', false, null, null, null, '매장 사업자 등록 후 웨이팅 운영', '식당 원격 줄서기·웨이팅 관리에 강점'),
  ('home2', '나우웨이팅', 'space', 'domestic', 'https://home.nowwaiting.co/', '매장 원격 대기·예약 웨이팅 플랫폼.', false, null, null, null, '매장 사업자 등록 후 대기 운영', '매장 원격 대기·예약 관리에 강점'),
  ('onoffmix', '온오프믹스', 'space', 'domestic', 'https://onoffmix.com/', '세미나·모임·행사 개설·신청 플랫폼.', false, null, null, null, '주최자 가입 후 행사 개설·신청 관리', '세미나·모임·행사 개설·참가 신청에 강점'),
  ('camperest', '캠퍼레스트', 'space', 'domestic', 'https://www.camperest.kr/', '2024년 출시된 신생 캠핑 올인원 앱으로, 캠핑장 예약·캠핑 다이어리·AI 맞춤 캠핑장 추천을 제공한다.', true, null, null, null, '캠핑장 제휴 후 등록', '캠핑장 예약·다이어리·맞춤 추천 통합에 강점'),
  ('cambak', '캠박', 'space', 'domestic', 'https://cambak.co.kr/', '전국 캠핑카 대여사를 연결해 차박·캠핑카 여행을 예약하는 신생 버티컬 플랫폼이다.', true, null, null, null, '캠핑카 대여사 제휴 후 등록', '캠핑카·차박 대여사 연결에 강점'),
  ('yomo', '요모', 'space', 'domestic', 'https://yomo.co.kr/', '지역 여행 전문가와 고객을 연결해 맞춤 일정을 설계하는 신생 프라이빗 여행 컨시어지 플랫폼이다.', true, null, null, null, '여행 전문가 등록·프로필 심사 후', '맞춤 일정 프라이빗 여행 컨시어지에 강점'),
  ('popply', '팝플리', 'space', 'domestic', 'https://www.popply.co.kr/', '팝업스토어 발견부터 공간 대여·행사 공간 매칭까지 지원하는 신규 팝업스토어 전문 플랫폼이다.', true, null, null, null, '공간·주최자 등록 후 매칭', '팝업스토어 발견·공간 매칭에 강점'),
  ('hanintel', '하닌텔', 'space', 'overseas', 'https://www.hanintel.com/', '전 세계 한인 게스트하우스·한인민박 예약 중개 플랫폼.', false, null, null, null, '한인 게하·민박 등록 후 게시', '해외 한인 민박·게스트하우스 예약 중개에 강점'),
  ('campingtalk', '캠핑톡', 'space', 'domestic', 'https://www.campingtalk.me/', '오토캠핑·글램핑·카라반·펜션을 예약하는 캠핑 플랫폼.', false, null, null, null, '캠핑장·펜션 사업자 제휴 후 등록', '오토캠핑·글램핑·카라반·펜션 예약에 강점'),
  ('realground', '리얼그라운드', 'space', 'domestic', 'https://realground.co.kr/', 'VR로 미리 보고 예약하는 캠핑장·글램핑 예약 서비스.', false, null, null, null, '캠핑장 사업자 제휴 후 등록', 'VR 미리보기 기반 캠핑장 예약에 강점'),
  ('oneulbamn', '오늘밤엔', 'space', 'domestic', 'https://www.oneulbamn.com/', '펜션·풀빌라·글램핑 실시간 숙소 예약 사이트.', false, null, null, null, '숙소 사업자 제휴 후 등록', '펜션·풀빌라·글램핑 실시간 예약에 강점'),
  ('wowple', '와우플', 'space', 'domestic', 'https://www.wowple.com/', '파티룸·회의실·스튜디오 등 공간 중개 플랫폼.', false, null, null, null, '공간 호스트 등록 후 게시', '파티룸·회의실·스튜디오 등 공간 중개에 강점'),
  ('kmeetingroom', '회의실닷컴', 'space', 'domestic', 'https://www.kmeetingroom.com/', '비즈니스 회의실을 비교·예약하는 매칭 서비스.', false, null, null, null, '회의실 공간 등록 후 게시', '비즈니스 회의실 비교·예약에 강점'),
  ('flowoffice', '플로우 공유오피스', 'space', 'domestic', 'https://flowoffice.co.kr/', '비상주사무실·공유오피스 전문 중개 플랫폼.', false, null, null, null, '공간 제휴 후 등록', '비상주사무실·공유오피스 중개에 강점'),
  ('theowl', '부엉이곳간', 'space', 'domestic', 'https://www.theowl.co.kr/', '마포·홍대·합정 공유오피스와 시간제 회의실 대여.', false, null, null, null, '이용 문의·계약 후 입주', '마포·홍대·합정권 공유오피스·회의실 대여에 강점'),
  ('valuevenue', '가치공간', 'space', 'domestic', 'https://www.valuevenue.co.kr/', '팝업스토어 전문 공간 대여·매칭 리테일 플랫폼.', false, null, null, null, '공간 호스트 등록 후 매칭', '팝업스토어 전문 공간 대여·매칭에 강점'),
  ('modushare', '쇼픈', 'space', 'domestic', 'https://www.modushare.co.kr/', '팝업·전시·촬영 용도별 공간을 매칭하는 대여 플랫폼.', false, null, null, null, '공간 호스트 등록 후 게시', '팝업·전시·촬영 용도별 공간 매칭에 강점'),
  ('daangn', '당근마켓', 'resale', 'domestic', 'https://www.daangn.com', '지역 기반 중고 직거래·동네생활.', false, 'low', '개인 간 직거래는 판매수수료 없음', null, '휴대폰 인증·가입 후 동네 인증', '지역 기반 중고 직거래·동네 커뮤니티에 강점'),
  ('bunjang', '번개장터', 'resale', 'domestic', 'https://m.bunjang.co.kr', '모바일 중고 거래(안전결제 제공).', false, 'low', '안전결제 이용 시 결제 수수료 부과', '구매확정 후 정산', '가입 후 상품 등록', '모바일 중고 거래·안전결제에 강점'),
  ('junggonara', '중고나라', 'resale', 'domestic', 'https://web.joongna.com', '국내 최대 규모 중고 거래 커뮤니티/앱.', false, null, null, null, '가입 후 카페·앱에서 상품 등록', '대규모 중고 거래 커뮤니티 트래픽에 강점'),
  ('mintit', '민팃', 'resale', 'domestic', 'https://www.mintit.co.kr/', 'AI 무인 ATM 중고폰 비대면 매입 리커머스.', false, null, null, null, 'ATM·앱에서 기기 등록 후 매입', '무인 ATM 비대면 중고폰 매입에 강점'),
  ('fongabi', '폰가비', 'resale', 'domestic', 'https://fongabi.com/', '중고폰·태블릿·노트북 매입/판매·시세 비교.', false, null, null, null, '앱·매장에서 기기 접수 후 매입·판매', '중고폰·태블릿·노트북 매입·시세 비교에 강점'),
  ('charan', '차란', 'resale', 'domestic', 'https://www.charan.co.kr/', '촬영·판매 대행 위탁형 세컨핸드 패션 앱.', false, null, null, null, '판매 의뢰 후 촬영·판매 대행 위탁', '위탁형 세컨핸드 패션 촬영·판매 대행에 강점'),
  ('marketinu', '마켓인유', 'resale', 'domestic', 'https://marketinu.com/', '세탁·검수 수입 빈티지·중고 의류 셀렉트샵.', false, null, null, null, null, '검수·세탁 수입 빈티지·중고 의류 셀렉션에 강점'),
  ('parabara', '파라바라', 'resale', 'domestic', 'https://www.parabara.kr/', '무인 자판기 기반 비대면 중고거래.', false, null, null, null, '앱 가입 후 자판기 등록·판매', '무인 자판기 기반 비대면 중고거래에 강점'),
  ('kream', 'KREAM', 'resale', 'domestic', 'https://kream.co.kr/', '검수 기반 한정판 스니커즈·패션·명품 리셀.', false, 'mid', '판매수수료+검수·배송비 별도', '검수 통과 후 판매자 정산', '개인·사업자 모두 가입 후 판매 입찰 등록', '정품 검수 기반 한정판 스니커즈·명품 리셀에 강점'),
  ('soldout', '솔드아웃', 'resale', 'domestic', 'https://www.soldout.co.kr/', '무신사의 한정판 스니커즈·패션 검수 리셀.', false, null, null, '검수 통과 후 정산', '개인·사업자 모두 가입 후 판매 등록', '무신사 연계 한정판 스니커즈·패션 검수 리셀에 강점'),
  ('gugus', '구구스', 'resale', 'domestic', 'https://www.gugus.co.kr/', '감정 기반 매장형 중고명품 매입·판매.', false, null, null, null, '매장 방문·감정 후 매입 또는 위탁 판매', '매장형 감정 기반 중고명품 매입·판매에 강점'),
  ('feelway', '필웨이', 'resale', 'domestic', 'https://www.feelway.com/', '대형 중고명품 직거래 사이트.', false, null, null, null, '가입 후 중고명품 매물 직접 등록', '대형 중고명품 직거래 매물 규모에 강점'),
  ('koibito', '고이비토', 'resale', 'domestic', 'https://www.koibito.co.kr/', '매입·위탁판매·감정 중고명품 플랫폼.', false, null, null, null, '매입·위탁 접수 또는 가입 후 판매', '매입·위탁·감정 병행 중고명품 거래에 강점'),
  ('mrcamel', '미스터카멜', 'resale', 'domestic', 'https://mrcamel.co.kr/', '중고명품 매물 통합검색·정가품 감정 앱.', false, null, null, null, '앱 설치 후 매물 검색·감정 이용', '중고명품 통합검색·정가품 감정에 강점'),
  ('apps', '패피스', 'resale', 'domestic', 'https://apps.apple.com/kr/app/id1640840534', '명품 수선·쇼핑·판매 결합 리세일 앱.', false, null, null, null, '앱 가입 후 판매·수선 의뢰', '명품 수선·쇼핑·판매 결합 리세일에 강점'),
  ('withsellit', '셀잇', 'resale', 'domestic', 'https://www.withsellit.com/', '중고 전자기기 컨시어지 거래 서비스.', false, null, null, null, '앱 가입 후 판매 접수(컨시어지 대행)', '중고 전자기기 컨시어지 대행 거래에 강점'),
  ('aladin', '알라딘 중고', 'resale', 'domestic', 'https://www.aladin.co.kr/usedstore/wgate.aspx', '온·오프라인 중고 도서·음반·굿즈 매입/판매.', false, null, null, null, '가입 후 온·오프라인 중고 매입 신청', '중고 도서·음반·굿즈 매입/판매 인프라에 강점'),
  ('hellomarket', '헬로마켓', 'resale', 'domestic', 'https://www.hellomarket.com/', '개인 간 중고거래 모바일 커머스 앱.', false, null, null, null, '앱 가입 후 개인 중고 매물 등록', '개인 간 중고거래 모바일 커머스에 강점'),
  ('recl', '리클', 'resale', 'domestic', 'https://recl.co.kr/', '모바일로 헌 옷을 간편 수거해 리워드를 주고 되파는 중고의류 리커머스로, 2023년 앱 출시 후 급성장한 신생.', true, null, null, null, '앱 가입 후 헌 옷 수거 신청', '간편 수거·리워드형 중고의류 리커머스에 강점'),
  ('newoff', '뉴오프', 'resale', 'domestic', 'https://www.newoff.co.kr/', '안 입는 옷을 수거·검수·살균해 재판매하는 중고의류 커머스로, 2024년 출시되고 퓨처플레이 시드 투자를 받은 신생.', true, null, null, null, '앱 가입 후 의류 수거 신청', '수거·검수·살균 후 재판매하는 중고의류 커머스에 강점'),
  ('secondsold', '세컨솔드', 'resale', 'domestic', 'https://secondsold.kr/', '전국 오프라인 빈티지샵을 한 곳에 모은 빈티지·구제 패션 모음 커머스 앱으로 2024년 말 나온 신생.', true, null, null, null, '앱 가입 후 매물 탐색(빈티지샵 입점)', '오프라인 빈티지샵 통합 구제 패션 모음에 강점'),
  ('collectiv', '콜렉티브', 'resale', 'domestic', 'https://collectiv.kr/', '프리미엄·디자이너 세컨핸드 패션을 거래하는 C2C 앱(크레이빙콜렉터)으로, 크림 투자를 받으며 떠오른 리커머스.', true, null, null, null, '앱 가입 후 프로필·매물 등록', '프리미엄·디자이너 세컨핸드 C2C 거래에 강점'),
  ('fruitsfamily', '후루츠패밀리', 'resale', 'domestic', 'https://fruitsfamily.com/', '판매수수료 0원을 내세운 빈티지·세컨핸드 패션 커뮤니티 마켓으로 Z세대 중심으로 떠오른 리커머스.', true, 'low', '판매수수료 0원 표방', null, '앱 가입 후 매물 등록', '판매수수료 부담 없는 빈티지·세컨핸드 커뮤니티 마켓'),
  ('viver', '바이버', 'resale', 'domestic', 'https://www.viver.co.kr/', '전문가 검수 기반 명품 시계 C2C 거래 플랫폼(두나무 계열)으로 최근 급성장한 신흥 리셀 서비스.', true, null, null, '검수 통과 후 정산', '앱 가입 후 시계 매물 등록', '전문가 검수 기반 명품 시계 C2C 거래에 강점'),
  ('chicpap', '시크', 'resale', 'domestic', 'https://chicpap.com/', '명품 커뮤니티 시크먼트와 크림이 함께 만든 안전결제 기반 중고 명품 거래 앱으로 2022년경 등장한 신생.', true, null, null, null, '앱 가입 후 매물 등록', '커뮤니티 연계 안전결제 중고 명품 거래에 강점'),
  ('npremium', '네이버 프리미엄콘텐츠', 'content', 'domestic', 'https://contents.premium.naver.com', '유료 구독 콘텐츠 발행·판매.', false, null, null, null, '창작자 채널 개설·승인 후 유료 콘텐츠 발행', '텍스트 유료 구독 콘텐츠 수익화에 강점'),
  ('class101', '클래스101', 'content', 'domestic', 'https://class101.net', '온라인 클래스 제작·판매(크리에이터).', false, null, null, null, '크리에이터 지원·심사 후 클래스 개설', '취미·실무 온라인 클래스 제작·판매에 강점'),
  ('brunch', '브런치스토리', 'content', 'domestic', 'https://brunch.co.kr', '글 발행·작가 활동 플랫폼.', false, null, null, null, '작가 신청·승인 후 글 발행', '글 창작·작가 브랜딩 플랫폼에 강점'),
  ('youtube', '유튜브', 'content', 'overseas', 'https://www.youtube.com', '영상 콘텐츠 게시·광고 수익화.', false, 'mid', '광고수익 약 45% 플랫폼 수취', '애드센스 기준액 도달 시 월 정산', '가입 후 업로드, 수익화는 파트너 조건 충족 필요', '영상 콘텐츠 게시·광고 수익화 도달 규모에 강점'),
  ('inflearn', '인프런', 'content', 'domestic', 'https://www.inflearn.com', '개발·디자인·직무 온라인 강의 마켓.', false, null, null, null, '지식공유자 신청 후 강의 등록', '개발·디자인·직무 온라인 강의 판매에 강점'),
  ('fastcampus', '패스트캠퍼스', 'content', 'domestic', 'https://fastcampus.co.kr', '직무·부트캠프형 프리미엄 온라인 강의.', false, null, null, null, '수강 결제 후 학습(강의는 협업·제작형)', '직무·부트캠프형 프리미엄 강의 제작에 강점'),
  ('naverwebtoon', '네이버웹툰', 'content', 'domestic', 'https://comic.naver.com', '국내 최대 웹툰 연재 플랫폼.', false, null, null, null, '작가 계약·도전만화 등 절차 통해 연재', '웹툰 연재·유료 열람 트래픽 규모에 강점'),
  ('kakaopage', '카카오페이지', 'content', 'domestic', 'https://page.kakao.com', '웹툰·웹소설 연재·유료 열람.', false, null, null, null, '작가·CP 계약 통해 연재 등록', '웹툰·웹소설 연재·유료 열람 수익화에 강점'),
  ('udemy', '유데미', 'content', 'overseas', 'https://www.udemy.com/ko/', '누구나 강의를 만들어 파는 글로벌 온라인 강의 마켓.', false, null, null, null, '강사 가입 후 강의 제작·등록', '누구나 강의를 파는 글로벌 강의 마켓 도달에 강점'),
  ('edu', '구름EDU', 'content', 'domestic', 'https://edu.goorm.io/', '클라우드 실습 기반 IT·코딩 교육 플랫폼.', false, null, null, null, '가입 후 실습 강의 수강 또는 개설', '클라우드 실습 기반 IT·코딩 교육에 강점'),
  ('codeit', '코드잇', 'content', 'domestic', 'https://www.codeit.kr/', '구독형 프로그래밍·데이터 강의·부트캠프.', false, null, null, null, '구독 결제 후 학습 이용', '구독형 프로그래밍·데이터 강의에 강점'),
  ('nomadcoders', '노마드코더', 'content', 'domestic', 'https://nomadcoders.co/', '클론코딩 방식 실전형 개발 강의·챌린지.', false, null, null, null, '가입·결제 후 강의 수강', '클론코딩 실전형 개발 강의·챌린지에 강점'),
  ('spartaclub', '스파르타코딩클럽', 'content', 'domestic', 'https://spartaclub.kr/', '부트캠프·온라인 코딩 강의 IT 교육 플랫폼.', false, null, null, null, '수강 신청·결제 후 부트캠프 참여', '부트캠프·입문 코딩 교육에 강점'),
  ('coloso', '콜로소', 'content', 'domestic', 'https://coloso.co.kr/', '현업 전문가 실무 VOD 강의 플랫폼.', false, null, null, null, '강의 결제 후 VOD 수강(강의는 협업·제작형)', '현업 전문가 실무 VOD 강의에 강점'),
  ('liveklass', '라이브클래스', 'content', 'domestic', 'https://www.liveklass.com/', '지식 크리에이터 VOD 강의 개설·판매 올인원.', false, null, null, null, '크리에이터 가입 후 VOD 강의 개설·판매', '지식 크리에이터 강의 개설·판매 올인원에 강점'),
  ('learnit', '러닛', 'content', 'domestic', 'https://www.learnit.co.kr/', '플립러닝 프로그래밍·IT 온라인 강의.', false, null, null, null, '가입·결제 후 강의 수강', '플립러닝 방식 프로그래밍·IT 강의에 강점'),
  ('classu', '클래스유', 'content', 'domestic', 'https://www.classu.co.kr/', '취미·실무 온라인 클래스 마켓.', false, null, null, null, '크리에이터 지원 후 클래스 개설(수강은 결제)', '취미·실무 온라인 클래스 마켓에 강점'),
  ('bearu', '베어유', 'content', 'domestic', 'https://bear-u.com/', '커리어·실무 온라인 클래스 서비스.', false, null, null, null, '수강 결제 후 학습 이용', '커리어·실무 온라인 클래스에 강점'),
  ('elice', '엘리스', 'content', 'domestic', 'https://elice.io/', 'AI 실습 기반 코딩 교육·부트캠프 에듀테크.', false, null, null, null, '가입 후 유료 과정 수강 신청', 'AI 코드 실습 환경 기반 코딩 교육·부트캠프에 강점'),
  ('postype', '포스타입', 'content', 'domestic', 'https://www.postype.com/', '창작 콘텐츠 유료 판매·후원·멤버십 커뮤니티.', false, null, null, null, '가입 후 창작자 등록·콘텐츠 발행', '웹툰·웹소설 등 창작 콘텐츠 유료 판매·후원에 강점'),
  ('ridibooks', '리디', 'content', 'domestic', 'https://ridibooks.com/', '전자책·웹소설·웹툰 콘텐츠 플랫폼.', false, null, null, null, '출판사·작가 콘텐츠 공급 계약(독자는 가입 후 구매)', '전자책·웹소설·웹툰 유료 콘텐츠 판매·유통에 강점'),
  ('munpia', '문피아', 'content', 'domestic', 'https://www.munpia.com/', '연재·유료화 중심 웹소설 창작 플랫폼.', false, null, null, null, '작가 가입 후 연재·유료화 시작', '웹소설 연재·유료화(판타지·무협 등)에 강점'),
  ('joara', '조아라', 'content', 'domestic', 'https://www.joara.com/', '아마추어·프로 작가 웹소설 연재 플랫폼.', false, null, null, null, '가입 후 자유 연재 시작', '아마추어·프로 웹소설 연재·유료화에 강점'),
  ('novelpia', '노벨피아', 'content', 'domestic', 'https://novelpia.com/', '웹소설 연재·수익화 플랫폼.', false, null, null, null, '작가 가입 후 연재·유료화 시작', '웹소설 연재·선작 기반 수익화에 강점'),
  ('emoticonstudio', '카카오 이모티콘 스튜디오', 'content', 'domestic', 'https://emoticonstudio.kakao.com/', '이모티콘 제안·출시·판매 창작 플랫폼.', false, null, null, null, '가입 후 제안·심사 통과 시 출시', '카카오톡 이모티콘 제안·출시·판매에 강점'),
  ('toonation', '투네이션', 'content', 'domestic', 'https://toonation.co.kr/', '스트리머·창작자 도네이션(후원) 플랫폼.', false, null, null, null, '창작자 가입 후 후원 위젯 연동', '스트리머·창작자 도네이션 수단 통합에 강점'),
  ('fanding', '팬딩', 'content', 'domestic', 'https://fanding.kr/', '구독형 창작자 후원·멤버십 플랫폼.', false, null, null, null, '창작자 가입 후 멤버십 개설', '구독형 창작자 후원·멤버십 운영에 강점'),
  ('twip', '트윕', 'content', 'domestic', 'https://www.twip.kr/', '스트리머 후원(도네이션) 도구 플랫폼.', false, null, null, null, '창작자 가입 후 후원 위젯 연동', '스트리머 후원·방송 알림 위젯에 강점'),
  ('sooplive', 'SOOP', 'content', 'domestic', 'https://www.sooplive.co.kr/', '후원 기반 라이브 스트리밍 플랫폼(구 아프리카TV).', false, null, null, null, '가입 후 방송(BJ) 시작', '별풍선 후원 기반 라이브 스트리밍에 강점'),
  ('chzzk', '치지직', 'content', 'domestic', 'https://chzzk.naver.com/', '네이버 게임 특화 라이브 스트리밍·후원 플랫폼.', false, null, null, null, '가입 후 스트리밍 시작(파트너 조건 별도)', '게임 방송 특화 라이브 스트리밍·후원(치즈)에 강점'),
  ('patreon', '패트리온', 'content', 'overseas', 'https://www.patreon.com/', '창작자 정기 구독 후원 글로벌 플랫폼.', false, 'mid', '요금제별 플랫폼 수수료+결제 수수료', null, '창작자 가입 후 멤버십 티어 개설', '정기 구독형 창작자 후원 글로벌 운영에 강점'),
  ('welaaa', '윌라', 'content', 'domestic', 'https://www.welaaa.com/', '오디오북·강연 구독형 오디오 콘텐츠 플랫폼.', false, null, null, null, '가입 후 월 구독(청취자 대상)', '오디오북·강연 구독형 청취에 강점'),
  ('millie', '밀리의 서재', 'content', 'domestic', 'https://www.millie.co.kr/', '전자책·오디오북 무제한 구독 독서 플랫폼.', false, null, null, null, '가입 후 월 구독', '전자책·오디오북 무제한 구독 독서에 강점'),
  ('podbbang', '팟빵', 'content', 'domestic', 'https://www.podbbang.com/', '광고·후원 기반 오디오·팟캐스트 플랫폼.', false, null, null, null, '가입 후 채널 개설·에피소드 업로드', '팟캐스트 배포·후원·광고 수익화에 강점'),
  ('audioclip', '네이버 오디오클립', 'content', 'domestic', 'https://audioclip.naver.com/', '구독·재생 기반 오디오 콘텐츠 플랫폼.', false, null, null, null, '채널 개설 후 오디오 콘텐츠 등록', '오디오북·팟캐스트 등 오디오 콘텐츠 유통에 강점'),
  ('mildang', '밀당PT', 'content', 'domestic', 'https://www.mildang.kr', 'AI 분석 맞춤 온라인 1:1 과외 서비스.', false, null, null, null, '가입 후 수강 신청(학생 대상)', 'AI 분석 맞춤 1:1 온라인 과외에 강점'),
  ('kr3', '산타', 'content', 'domestic', 'https://kr.aitutorsanta.com', 'AI 적응형 토익 온라인 교육 앱.', false, null, null, null, '앱 설치 후 가입·수강', 'AI 적응형 토익 점수 예측·학습에 강점'),
  ('yanadoo', '야나두', 'content', 'domestic', 'https://www.yanadoo.co.kr', '하루 10분 온라인 영어회화 어학 교육.', false, null, null, null, '가입 후 강의 구매·수강', '하루 10분 습관형 영어회화 학습에 강점'),
  ('siwonschool', '시원스쿨', 'content', 'domestic', 'https://www.siwonschool.com', '영어·외국어 중심 온라인 인강 플랫폼.', false, null, null, null, '가입 후 강의 구매·수강', '영어·제2외국어 기초 인강에 강점'),
  ('hackers', '해커스', 'content', 'domestic', 'https://www.hackers.com', '토익·토플 등 어학시험 대비 온라인 강의.', false, null, null, null, '가입 후 강의 수강(무료 자료 제공)', '토익·토플 등 어학시험 대비 강의에 강점'),
  ('eduwill', '에듀윌', 'content', 'domestic', 'https://eduwill.net', '공인중개사·공무원·자격증 온라인 인강.', false, null, null, null, '가입 후 강의 수강', '공인중개사·공무원·자격증 시험 대비에 강점'),
  ('megastudy', '메가스터디', 'content', 'domestic', 'https://www.megastudy.net', '수능·대입 고등 온라인 강의 인강 플랫폼.', false, null, null, null, '가입 후 강의 수강', '수능·대입 고등 인강에 강점'),
  ('etoos', '이투스', 'content', 'domestic', 'https://www.etoos.com', '구독형 고등 대입 온라인 강의 사이트.', false, null, null, null, '가입 후 강의 수강·프리패스 구독', '고등 대입 온라인 강의에 강점'),
  ('classting', '클래스팅', 'content', 'domestic', 'https://www.classting.com', '학급 관리·AI 개인화 학습 교육 플랫폼.', false, null, null, null, '교사·학생·학부모 가입 후 학급 개설·참여', '학급 소통·관리와 AI 개인화 학습에 강점'),
  ('tutoring', '링고라', 'content', 'domestic', 'https://tutoring.co.kr', '1:1 원어민 영어회화·AI 어학 교육 앱.', false, null, null, null, '앱 설치 후 가입·수업권 구매', '24시간 1:1 원어민·AI 영어회화에 강점'),
  ('stibee', '스티비', 'content', 'domestic', 'https://stibee.com/', '유료 구독 기능을 갖춘 국내 뉴스레터 발행·구독자 관리 플랫폼.', false, null, null, null, '가입 후 뉴스레터 발행·구독자 관리', '국내 뉴스레터 발행·유료 구독 운영에 강점'),
  ('maily', '메일리', 'content', 'domestic', 'https://maily.so/', '멤버십 유료 콘텐츠 수익화를 지원하는 뉴스레터 발행 플랫폼.', false, null, null, null, '가입 후 뉴스레터 발행·유료 멤버십 개설', '뉴스레터 기반 유료 콘텐츠 수익화에 강점'),
  ('airklass', '에어클래스', 'content', 'domestic', 'https://www.airklass.com/', '마스터(강사)가 클래스를 개설·판매하는 온라인 강의 플랫폼.', false, null, null, null, '강사 가입 후 클래스 개설·판매', '누구나 온라인 강의 개설·판매에 강점'),
  ('typecast', '타입캐스트', 'ai_audio', 'domestic', 'https://typecast.ai/', '감정 표현 TTS 기반의 AI 성우 음성 생성 서비스.', false, null, null, null, '가입 후 바로 사용(무료 체험 제공)', '감정 표현 TTS로 AI 성우 음성 생성에 강점'),
  ('pozalabs', '포자랩스', 'content', 'domestic', 'https://www.pozalabs.com/', '저작권 이슈 없는 AI 생성 배경음악을 제작·유통하는 음악 플랫폼.', false, null, null, null, '문의·구독 후 음원 이용', '저작권 이슈 없는 AI 배경음악 제작·유통에 강점'),
  ('britg', '브릿G', 'content', 'domestic', 'https://britg.kr/', '장편·중단편 소설을 장르 구분 없이 자유 연재·판매하는 플랫폼.', false, null, null, null, '작가 가입 후 자유 연재·유료 판매', '장르 구분 없는 중·장편 소설 연재·판매에 강점'),
  ('ctee', '크티', 'content', 'overseas', 'https://ctee.kr', '최근 성장 중인 신생 크리에이터 수익화 플랫폼으로 멤버십·후원·상품 판매를 플랫폼 수수료 0%로 지원한다.', true, 'low', '플랫폼 수수료 0%(결제 수수료 별도)', null, '창작자 가입 후 멤버십·후원 개설', '수수료 0% 창작자 멤버십·후원·상품 판매에 강점'),
  ('fancimm', '팬심M', 'content', 'overseas', 'https://fancimm.com', '크리에이터와 팬의 1:1 비공개 소통·후원·굿즈를 중개하는 신생 팬덤 수익화 플랫폼이다.', true, null, null, null, '창작자 가입 후 팬 후원·굿즈 개설', '크리에이터·팬 1:1 비공개 소통·굿즈 중개에 강점'),
  ('litt', '리틀리', 'content', 'overseas', 'https://litt.ly', '2021년 시작한 국내 올인원 프로필 링크 서비스로 링크 정리에 더해 후원·커머스 등 크리에이터 수익화 기능을 제공한다.', true, null, null, null, '가입 후 프로필 링크 페이지 생성(무료 시작)', '링크 정리에 후원·커머스 등 크리에이터 수익화 결합'),
  ('carat', '캐럿', 'content', 'overseas', 'https://carat.im', '스타트업 패러닷이 만든 신생 AI 콘텐츠 제작 에이전트로 대화형 인터페이스로 텍스트·이미지·영상·오디오를 생성한다.', true, null, null, null, '가입 후 바로 사용(무료 체험 대개 제공)', '대화형으로 텍스트·이미지·영상·오디오 통합 생성'),
  ('gazet', '가제트', 'content', 'overseas', 'https://gazet.ai', '한국어에 특화된 신생 생성형 AI 글쓰기 도구로 블로그·광고 카피 등 문장을 자동 생성한다.', true, null, null, null, '가입 후 바로 사용(무료 체험 대개 제공)', '한국어 블로그·광고 카피 문장 자동 생성에 특화'),
  ('musia', '뮤지아', 'content', 'overseas', 'https://musia.ai', '크리에이티브마인드가 운영하는 AI 작곡 서비스로 음악 지식 없이도 곡을 생성·편집할 수 있는 신생 뮤직테크 도구다.', true, null, null, null, '가입 후 바로 사용(무료 체험 대개 제공)', '음악 지식 없이 AI로 작곡·편집'),
  ('fikad', '피카클립', 'content', 'overseas', 'https://www.fikad.boo', '2023년 설립된 대전 스타트업 피카디의 서비스로 긴 영상을 AI가 여러 개의 숏폼으로 자동 제작해준다.', true, null, null, null, '가입 후 바로 사용(무료 체험 대개 제공)', '긴 영상을 AI가 숏폼으로 자동 제작'),
  ('toonda', '툰다', 'content', 'overseas', 'https://toonda.com', '스타트업 콘파파가 개발한 신생 웹툰 창작 툴로 글콘티·그림콘티·식자 작업을 지원한다.', true, null, null, null, '가입 후 바로 사용(무료 체험 대개 제공)', '웹툰 글·그림 콘티·식자 작업 지원'),
  ('ploonet', '플루닛', 'content', 'overseas', 'https://www.ploonet.com', '생성형·대화형 AI 기반의 가상인간과 영상 제작 서비스를 제공하는 국내 신생 AI 콘텐츠 기업이다.', true, null, null, null, '가입 후 사용(요금제·문의형 혼재)', '가상인간 기반 대화형 AI 영상 제작'),
  ('zigzag', '지그재그', 'fashion', 'domestic', 'https://zigzag.kr', '여성 패션 큐레이션 마켓, 영상쇼핑 중심.', false, 'mid', null, null, '사업자등록·통신판매업 신고 후 입점 신청', '여성 패션 큐레이션·영상쇼핑에 강점'),
  ('ably', '에이블리', 'fashion', 'domestic', 'https://www.a-bly.com', '여성 의류·잡화 셀러 입점형 마켓.', false, 'low', null, null, '사업자등록·통신판매업 신고 후 입점 신청', '여성 의류·잡화 셀러 입점형 마켓에 강점'),
  ('musinsa', '무신사', 'fashion', 'domestic', 'https://www.musinsa.com', '패션·스니커즈·뷰티 종합 플랫폼.', false, 'high', null, null, '브랜드 입점 심사·계약 후 판매', '패션·스니커즈·뷰티 브랜드 집객에 강점'),
  ('wconcept', 'W컨셉', 'fashion', 'domestic', 'https://www.wconcept.co.kr', '디자이너·컨템포러리 패션 편집몰.', false, null, null, null, '브랜드 입점 심사·계약 후 판매', '디자이너·컨템포러리 패션 편집 큐레이션'),
  ('brandi', '브랜디', 'fashion', 'domestic', 'https://www.brandi.co.kr', '모바일 여성 패션 마켓.', false, null, null, null, '사업자등록·통신판매업 신고 후 입점 신청', '모바일 여성 패션 셀러 입점형 마켓'),
  ('29cm', '29CM', 'fashion', 'domestic', 'https://www.29cm.co.kr', '패션·라이프스타일 편집 큐레이션몰.', false, null, null, null, '브랜드 입점 심사·계약 후 판매', '감도 높은 패션·라이프스타일 편집 큐레이션'),
  ('queenit', '퀸잇', 'fashion', 'domestic', 'https://queenit.co.kr/', '4050 여성 타깃 패션 버티컬 커머스 앱.', false, null, null, null, '사업자등록·통신판매업 신고 후 입점 신청', '4050 여성 타깃 패션 버티컬에 강점'),
  ('posty', '포스티', 'fashion', 'domestic', 'https://posty.kr/', '카카오스타일이 운영하는 4050 세대 대상 백화점·명품 패션 플랫폼.', false, null, null, null, '브랜드 입점 심사·계약 후 판매', '4050 세대 백화점·명품 패션에 강점'),
  ('asler', '애슬러', 'fashion', 'domestic', 'https://www.asler.co.kr/', '4050 시니어 남성 대상 패션 버티컬 커머스 앱.', false, null, null, null, '사업자등록·통신판매업 신고 후 입점 신청', '4050 시니어 남성 패션 타깃에 특화'),
  ('lookpin', '룩핀', 'fashion', 'domestic', 'https://lookpin.co.kr/', '남성 종합 패션·코디 추천 커머스 앱.', false, null, null, null, '사업자등록·통신판매업 신고 후 입점 신청', '남성 코디 추천 기반 종합 패션 커머스'),
  ('mustit', '머스트잇', 'fashion', 'domestic', 'https://mustit.co.kr/', '온라인 명품 전문 커머스 플랫폼.', false, null, null, null, '사업자등록·통신판매업 신고 후 입점 신청', '온라인 명품 중개·거래에 특화'),
  ('trenbe', '트렌비', 'fashion', 'domestic', 'https://www.trenbe.com/', '자체 감정·풀필먼트를 갖춘 온라인 명품 커머스.', false, null, null, null, '사업자등록·통신판매업 신고 후 입점 신청', '자체 감정·풀필먼트 갖춘 명품 커머스'),
  ('balaan', '발란', 'fashion', 'domestic', 'https://www.balaan.co.kr/', '온라인 명품 커머스 플랫폼.', false, null, null, null, '사업자등록·통신판매업 신고 후 입점 신청', '온라인 명품 커머스에 강점'),
  ('oliveyoung', '올리브영 온라인몰', 'fashion', 'domestic', 'https://www.oliveyoung.co.kr/', 'CJ올리브영의 뷰티·헬스 상품 온라인몰.', false, null, null, null, '브랜드 입점 제안·심사 후 매입/입점', '뷰티·헬스 상품, 오프라인 연계 온라인몰'),
  ('hwahae', '화해 쇼핑', 'fashion', 'domestic', 'https://www.hwahae.co.kr/', '성분·리뷰 기반 화장품 앱이 운영하는 K-뷰티 커머스.', false, null, null, null, '브랜드 입점 제안·심사 후 판매', '성분·리뷰 기반 화장품 커머스에 강점'),
  ('aprin', '에이피알', 'fashion', 'domestic', 'https://apr-in.com/', '메디큐브 등을 보유한 뷰티테크 D2C 자사몰 운영사.', false, null, null, null, null, '메디큐브 등 뷰티테크 D2C 자사몰 운영'),
  ('kurly2', '뷰티컬리', 'fashion', 'domestic', 'https://www.kurly.com/main/beauty', '컬리가 운영하는 뷰티 상품 새벽배송 커머스.', false, null, null, null, '입점 제안·심사 후 매입/입점', '뷰티 상품 새벽배송에 강점'),
  ('halfclub', '하프클럽', 'fashion', 'domestic', 'https://www.halfclub.com/', '패션 브랜드 상품을 모은 온라인 패션 종합몰.', false, null, null, null, '브랜드 입점 제안·심사 후 판매', '패션 브랜드 상품 아울렛형 종합몰'),
  ('fashionplus', '패션플러스', 'fashion', 'domestic', 'https://www.fashionplus.co.kr/', '수천 브랜드 패션을 아울렛형으로 파는 종합 패션몰.', false, null, null, null, '브랜드 입점 제안·심사 후 판매', '수천 브랜드 아울렛형 패션 종합몰'),
  ('jkids', '제이키즈', 'fashion', 'domestic', 'https://www.jkids.co.kr/', '아동복 전문 키즈 패션 쇼핑몰.', false, null, null, null, '사업자등록·통신판매업 신고 후 입점 신청', '아동복 전문 키즈 패션에 특화'),
  ('moomooz', '무무즈', 'fashion', 'domestic', 'https://www.moomooz.co.kr/', '키즈 패션·패밀리 라이프스타일 편집샵.', false, null, null, null, '사업자등록·통신판매업 신고 후 입점 신청', '키즈 패션·패밀리 라이프스타일 편집샵'),
  ('mami', '마미', 'fashion', 'domestic', 'https://mami.co.kr/', '아동복·육아용품·엄마 패션 쇼핑앱.', false, null, null, null, '사업자등록·통신판매업 신고 후 입점 신청', '아동복·육아용품·엄마 패션 통합'),
  ('stylebiggirl', '스타일빅걸', 'fashion', 'domestic', 'https://stylebiggirl.co.kr/', '여성 빅사이즈 의류 전문 쇼핑몰.', false, null, null, null, '사업자등록·통신판매업 신고 후 입점 신청', '여성 빅사이즈 의류 전문에 특화'),
  ('lalaswan', '라라스완', 'fashion', 'domestic', 'https://lalaswan.com/', '여성 플러스사이즈 의류 전문 쇼핑몰.', false, null, null, null, '사업자등록·통신판매업 신고 후 입점 신청', '여성 플러스사이즈 의류 전문에 특화'),
  ('bigmom', '빅맘', 'fashion', 'domestic', 'https://bigmom.co.kr/', '중년 여성 체형커버 빅사이즈 여성의류몰.', false, null, null, null, '사업자등록·통신판매업 신고 후 입점 신청', '중년 여성 체형커버 빅사이즈 의류'),
  ('venuseshop', '비너스', 'fashion', 'domestic', 'https://www.venus-eshop.co.kr/', '여성 속옷·언더웨어 전문 쇼핑몰.', false, null, null, null, null, '여성 속옷·언더웨어 전문에 특화'),
  ('dorosiwa', '도로시와', 'fashion', 'domestic', 'https://www.dorosiwa.co.kr/', '여성 언더웨어 공식몰.', false, null, null, null, null, '여성 언더웨어 공식몰'),
  ('rounz', '라운즈', 'fashion', 'domestic', 'https://rounz.com/', '가상피팅·얼굴형 추천 온라인 안경 쇼핑.', false, null, null, null, '사업자등록·통신판매업 신고 후 입점 신청', '가상피팅·얼굴형 추천 안경 쇼핑에 강점'),
  ('breezm', '브리즘', 'fashion', 'domestic', 'https://www.breezm.com/', '3D 스캔·프린팅 맞춤 아이웨어 브랜드.', false, null, null, null, null, '3D 스캔·프린팅 개인 맞춤 아이웨어에 강점'),
  ('amondz', '아몬즈', 'fashion', 'domestic', 'https://www.amondz.com/', '주얼리·액세서리 전문 편집 플랫폼.', false, null, null, null, null, '주얼리·액세서리 브랜드 편집 큐레이션에 강점'),
  ('goldria', '골드리아', 'fashion', 'domestic', 'https://www.goldria.net/', '14k·18k 주얼리 전문 브랜드 쇼핑몰.', false, null, null, null, null, '14k·18k 금 주얼리 전문에 강점'),
  ('monthlycosmetics', '먼슬리코스메틱', 'fashion', 'domestic', 'https://monthlycosmetics.com/', '맞춤 화장품 정기배송 뷰티 구독 서비스.', false, null, null, null, null, '맞춤 화장품 정기배송 구독에 강점'),
  ('toun28', '톤28', 'fashion', 'domestic', 'https://toun28.com/', '피부 진단 맞춤 화장품 구독 서비스.', false, null, null, null, null, '피부 진단 기반 맞춤 화장품 구독에 강점'),
  ('memebox', '미미박스', 'fashion', 'domestic', 'https://memebox.com/', '화장품 종합 쇼핑몰(뷰티 구독 출발).', false, null, null, null, null, '화장품 종합 셀렉션·자체 브랜드에 강점'),
  ('laka', '라카', 'fashion', 'domestic', 'https://laka.co.kr/', '젠더 뉴트럴 메이크업 브랜드 공식몰.', false, null, null, null, null, '젠더 뉴트럴 메이크업 브랜드에 강점'),
  ('bgroom', '비그룸', 'fashion', 'domestic', 'https://bgroom.co.kr/', '남성 전문 뷰티 셀렉샵.', false, null, null, null, null, '남성 전문 뷰티 셀렉션에 강점'),
  ('groominglab', '그루밍랩', 'fashion', 'domestic', 'https://groominglab.co.kr/', '남성 헤어·바디 그루밍 케어 브랜드.', false, null, null, null, null, '남성 헤어·바디 그루밍 케어에 강점'),
  ('shoeprize', '슈프라이즈', 'fashion', 'domestic', 'https://www.shoeprize.com/', '한정판 신발 발매 정보 스니커즈 플랫폼.', false, null, null, null, null, '한정판 스니커즈 발매 정보에 강점'),
  ('09women', '공구우먼', 'fashion', 'domestic', 'https://www.09women.com/', '빅사이즈 여성의류 전문 쇼핑몰.', false, null, null, null, null, '빅사이즈 여성의류 전문에 강점'),
  ('stylebot', '스타일봇', 'fashion', 'domestic', 'https://stylebot.co.kr/', 'AI 옷 분석·코디 추천 패션 스타일링 앱.', false, null, null, null, '가입 후 바로 사용(무료 체험 대개 제공)', 'AI 옷장 분석·코디 추천에 강점'),
  ('vinzip', '빈집샵', 'fashion', 'domestic', 'https://vinzip.kr/', '국내외 브랜드 빈티지 의류를 셀렉해 판매하는 온라인 구제 편집샵.', false, null, null, null, null, '국내외 브랜드 빈티지 구제 셀렉션에 강점'),
  ('tomovintage', '토모빈티지', 'fashion', 'domestic', 'https://tomovintage.com/', '일본 구제 위주로 매일 다량의 빈티지 신상을 공개하는 쇼핑몰.', false, null, null, null, null, '일본 구제 다량 신상 업데이트에 강점'),
  ('vintageone', '빈티지원', 'fashion', 'domestic', 'https://vintageone.co.kr/', '수입 빈티지 브랜드 구제 의류를 취급하는 온라인몰.', false, null, null, null, null, '수입 브랜드 빈티지 구제에 강점'),
  ('vintagezet', '빈티지제트', 'fashion', 'domestic', 'https://m.vintagezet.com/', '상태 좋은 빈티지 신발을 전문으로 다루는 쇼핑몰.', false, null, null, null, null, '상태 좋은 빈티지 신발 전문에 강점'),
  ('deadstock', 'DEADSTOCK', 'fashion', 'domestic', 'https://deadstock.co.kr/', '해외 브랜드 수입 빈티지를 정품으로 판매하는 편집샵.', false, null, null, null, null, '해외 브랜드 수입 빈티지 정품에 강점'),
  ('worknwalk', '워크앤워크', 'fashion', 'domestic', 'https://worknwalk.imweb.me/', '워크웨어·아메카지 스타일을 다루는 온라인 편집샵.', false, null, null, null, null, '워크웨어·아메카지 스타일에 강점'),
  ('drvintage', '닥터빈티지', 'fashion', 'domestic', 'https://drvintage.co.kr/', '아메카지·워크웨어 중심의 온·오프라인 빈티지 편집샵.', false, null, null, null, null, '아메카지·워크웨어 온·오프 편집에 강점'),
  ('bluesman', '블루즈맨', 'fashion', 'domestic', 'https://bluesman.co.kr/', '아메리칸 캐주얼 남성의류를 다루는 온라인 편집숍.', false, null, null, null, null, '아메리칸 캐주얼 남성의류에 강점'),
  ('outdoorfeel', '아웃도어필', 'fashion', 'domestic', 'https://outdoorfeel.com/', '수입 아웃도어 브랜드를 모은 온라인 셀렉트몰.', false, null, null, null, null, '수입 아웃도어 브랜드 셀렉션에 강점'),
  ('vegantigerkorea', '비건타이거', 'fashion', 'domestic', 'https://vegantigerkorea.com/', '동물성 소재를 배제한 국내 비건 패션 브랜드 자사몰.', false, null, null, null, null, '동물성 소재 배제 비건 패션에 강점'),
  ('bbybstore', 'BBYB', 'fashion', 'domestic', 'https://www.bbybstore.com/', '페이크 레더 기반 비건 가방·액세서리 브랜드 자사몰.', false, null, null, null, null, '페이크 레더 비건 가방·액세서리에 강점'),
  ('lotuff', '로터프', 'fashion', 'domestic', 'https://lotuff.co.kr/', '가죽 백팩·토트백 등을 만드는 국내 가죽가방 브랜드.', false, null, null, null, null, '국내 가죽 백팩·토트백 제작에 강점'),
  ('camelbrown', '캐멜브라운', 'fashion', 'domestic', 'https://camelbrown.com/', '여성 백팩·토트백 중심의 프리미엄 가방 브랜드.', false, null, null, null, null, '여성 프리미엄 백팩·토트백에 강점'),
  ('soulbag', '쏘울백', 'fashion', 'domestic', 'https://soulbag.co.kr/', '가죽가방·쇼퍼백·크로스백을 다루는 여성가방 자사몰.', false, null, null, null, null, '여성 가죽가방·크로스백에 강점'),
  ('prettica', '프레티카', 'fashion', 'domestic', 'https://prettica.co.kr/', '데일리용 심플한 실버 핸드메이드 주얼리 브랜드.', false, null, null, null, null, '데일리 실버 핸드메이드 주얼리에 강점'),
  ('dianajewelry', '다이애나쥬얼리', 'fashion', 'domestic', 'https://dianajewelry.shop/', '실버925 원석 귀걸이·반지 등 핸드메이드 주얼리 전문몰.', false, null, null, null, null, '실버925 원석 핸드메이드 주얼리에 강점'),
  ('hangleeyewear', '한글 아이웨어', 'fashion', 'domestic', 'https://hangle-eyewear.com/', '선글라스·블루라이트 안경 등을 만드는 아이웨어 브랜드 자사몰.', false, null, null, null, null, '선글라스·블루라이트 안경 자체 제작에 강점'),
  ('2eyeshop', '세컨아이즈', 'fashion', 'domestic', 'https://2eyeshop.com/', '자체 하우스 브랜드를 갖춘 안경·선글라스 쇼핑몰.', false, null, null, null, null, '자체 하우스 브랜드 안경·선글라스에 강점'),
  ('dongneoo', '동네선글라스', 'fashion', 'domestic', 'https://dongneoo.com/', '정품 아이웨어를 취급하는 선글라스 전문 온라인샵.', false, null, null, null, null, '정품 아이웨어 선글라스 셀렉션에 강점'),
  ('elleinnerwear', '엘르이너웨어', 'fashion', 'domestic', 'https://elleinnerwear.kr/', '엘르 라이선스 이너웨어를 판매하는 공식 온라인 스토어.', false, null, null, null, null, '엘르 라이선스 이너웨어 공식 판매에 강점'),
  ('sockstaz', '삭스타즈', 'fashion', 'domestic', 'https://sockstaz.com/', '양말을 중심으로 라이프스타일 소품을 전개하는 삭스 브랜드.', false, null, null, null, null, '양말 중심 라이프스타일 소품에 강점'),
  ('customsoxx', '커스텀삭스', 'fashion', 'domestic', 'https://customsoxx.com/', '디자인·주문제작 중심의 커스텀 양말 전문 브랜드.', false, null, null, null, null, '디자인·주문제작 커스텀 양말에 강점'),
  ('leesle', '리슬', 'fashion', 'domestic', 'https://leesle.kr/', '한복을 현대적으로 재해석한 모던 한복 패션 브랜드.', false, null, null, null, null, '현대적으로 재해석한 모던 한복에 강점'),
  ('wayyu', '웨이유', 'fashion', 'domestic', 'https://wayyu.kr/', '전통 요소를 캐주얼에 접목한 생활한복 브랜드 자사몰.', false, null, null, null, null, '전통·캐주얼 접목 생활한복 브랜드 자사몰'),
  ('thegoeun', '더고은', 'fashion', 'domestic', 'https://thegoeun.com/', '인사동 기반의 생활한복 브랜드 온라인몰.', false, null, null, null, null, '인사동 기반 생활한복 브랜드몰'),
  ('byatti', '바이아띠', 'fashion', 'domestic', 'https://www.byatti.com/', '생활한복을 전문으로 하는 온라인 쇼핑몰.', false, null, null, null, null, '생활한복 전문 온라인몰'),
  ('philosophia', '필로소피아', 'fashion', 'domestic', 'https://philosophia.co.kr/', '여성 요가복·필라테스복 전문 애슬레저 브랜드.', false, null, null, null, null, '여성 요가·필라테스 애슬레저 특화'),
  ('conch', '콘치웨어', 'fashion', 'domestic', 'https://conch.co.kr/', '필라테스·요가 레깅스 등 피트니스 웨어 브랜드.', false, null, null, null, null, '필라테스·요가 레깅스 등 피트니스웨어 특화'),
  ('kurly', '마켓컬리', 'food', 'domestic', 'https://www.kurly.com', '신선식품 새벽배송 이커머스.', false, null, null, null, '사업자등록 후 상품 제안·입점 심사', '신선식품 새벽배송·큐레이션 상품 구성'),
  ('oasis', '오아시스마켓', 'food', 'domestic', 'https://www.oasis.co.kr', '친환경·신선식품 새벽배송.', false, null, null, null, '사업자등록 후 입점 제안·심사', '친환경 신선식품 새벽배송'),
  ('jeongyukgak', '정육각', 'food', 'domestic', 'https://www.jeongyukgak.com', '신선육류 직판·정기배송.', false, null, null, null, null, '초신선 육류 직판·정기배송'),
  ('cookatmarket', '쿠캣마켓', 'food', 'domestic', 'https://cookatmarket.com/', '간편식·디저트·식단 제품 온라인 식품몰.', false, null, null, null, null, '간편식·디저트 트렌드 식품 특화'),
  ('yamtable', '얌테이블', 'food', 'domestic', 'http://www.yamtable.com/', '수산물 중심 온라인 수산식품 마켓.', false, null, null, null, null, '수산물 중심 온라인 식품 마켓'),
  ('choroc', '초록마을', 'food', 'domestic', 'https://www.choroc.com/', '친환경·유기농 먹거리 매장·온라인 식품몰.', false, null, null, null, null, '친환경·유기농 먹거리 매장+온라인'),
  ('jungoneshop', '정원e샵', 'food', 'domestic', 'https://www.jungoneshop.com/', '대상그룹 공식 온라인 식품몰.', false, null, null, null, null, '대상그룹 식품 공식 직영몰'),
  ('mart', '배민상회', 'food', 'domestic', 'https://mart.baemin.com/', '사장님용 식자재·부자재 B2B 장보기몰.', false, null, null, null, '외식 사업자 가입 후 이용', '외식 사장님용 식자재·부자재 B2B 장보기'),
  ('freshcode', '프레시코드', 'food', 'domestic', 'https://www.freshcode.me/', '샐러드·건강간편식 정기배송 푸드 커머스.', false, null, null, null, null, '샐러드·건강간편식 정기배송'),
  ('greating', '그리팅', 'food', 'domestic', 'https://www.greating.co.kr/', '현대그린푸드의 건강식단 정기배송 온라인몰.', false, null, null, null, null, '건강·케어 식단 정기배송(현대그린푸드)'),
  ('shop', '한살림 장보기', 'food', 'domestic', 'https://shop.hansalim.or.kr/', '한살림 협동조합의 친환경 식품 장보기몰.', false, null, null, null, '생협 조합원 가입 후 이용', '한살림 조합 친환경 식품 장보기'),
  ('icoop', '자연드림(아이쿱생협)', 'food', 'domestic', 'https://www.icoop.or.kr/coopmall/', '아이쿱생협의 유기농·공정무역 식품몰.', false, null, null, null, '생협 조합원 가입 후 이용', '유기농·공정무역 생협 식품'),
  ('boratr', '보라티알', 'food', 'domestic', 'https://www.boratr.co.kr/', '수입 식품·식자재 유통·판매 온라인 플랫폼.', false, null, null, null, null, '수입 식품·식자재 유통·판매'),
  ('sooldamhwa', '술담화', 'food', 'domestic', 'https://www.sooldamhwa.com/', '전통주 큐레이션 정기구독 배송 서비스.', false, null, null, null, '성인 인증 후 구독 신청', '전통주 큐레이션 정기구독'),
  ('purpledog', '퍼플독', 'food', 'domestic', 'https://www.purpledog.co.kr/', '취향 분석 맞춤 와인 정기구독 서비스.', false, null, null, null, '성인 인증 후 구독 신청', '취향 분석 맞춤 와인 정기구독'),
  ('thebanchan', '더반찬', 'food', 'domestic', 'https://www.thebanchan.co.kr/', '당일 조리 반찬·국·밀키트 새벽배송.', false, null, null, null, null, '당일조리 반찬·국·밀키트 새벽배송'),
  ('zipbanchan', '집반찬연구소', 'food', 'domestic', 'http://www.zipbanchan.co.kr/', '가정식 수제반찬 주문 배송 쇼핑몰.', false, null, null, null, null, '가정식 수제반찬 주문 배송'),
  ('thesoban', '더소반', 'food', 'domestic', 'https://thesoban.com/', '셰프 가정식 수제반찬 정기배송 구독.', false, null, null, null, null, '셰프 가정식 수제반찬 정기배송'),
  ('laclachansang', '락락한상', 'food', 'domestic', 'https://www.laclachansang.co.kr/', '반찬·국·메인요리 정기배송 가정식.', false, null, null, null, null, '반찬·국·메인 가정식 정기배송'),
  ('homebabs', '집밥연구소', 'food', 'domestic', 'https://homebabs.co.kr/', '주간 식단 반찬 정기배송 구독 서비스.', false, null, null, null, null, '주간 식단 반찬 정기배송 구독'),
  ('farmmorning', '팜모닝', 'food', 'domestic', 'https://farmmorning.com/', '농민 직접 판매 농산물 직거래·농사 지원.', false, null, null, null, '농민(생산자) 가입 후 판매·이용', '농민 직거래·영농 지원 결합'),
  ('marketsoo', '마켓수', 'food', 'domestic', 'https://www.marketsoo.kr/', '농·수·축산물 산지직송 직거래 사이트.', false, null, null, null, '사업자·산지 판매자 입점', '농수축산 산지직송 직거래'),
  ('sanjicook', '산지쿡농수산', 'food', 'domestic', 'https://www.sanjicook.com/', '검증 농수산물 산지직송 오픈마켓.', false, null, null, null, '사업자등록·통신판매 신고 후 입점', '검증 농수산물 산지직송 오픈마켓'),
  ('unclemart', '엉클농수산', 'food', 'domestic', 'https://unclemart.co.kr/', '농·축·수산물 산지직송 전문 마켓.', false, null, null, null, null, '농·축·수산 산지직송 전문 마켓'),
  ('fishsale', '피시세일', 'food', 'domestic', 'https://www.fishsale.co.kr/', '국내산 수산물 전문 온라인 쇼핑몰.', false, null, null, null, null, '국내산 수산물 전문 온라인몰'),
  ('farmmate', '참거래농민장터', 'food', 'domestic', 'https://farmmate.com/', '친환경 농산물 생산자·소비자 직거래.', false, null, null, null, '생산 농가 가입 후 직거래 판매', '친환경 농산물 생산자 직거래'),
  ('nhlocalfood', '농협로컬푸드직매장', 'food', 'domestic', 'https://nhlocalfood.com/', '지역 농산물 로컬푸드 직매장 온라인몰.', false, null, null, null, '지역 농가(조합원) 등록 후 출하', '지역 농산물 로컬푸드 직매장'),
  ('marcheat', '마르쉐', 'food', 'domestic', 'https://www.marcheat.net/', '농부·요리사·수공예가 도시형 농부시장.', false, null, null, null, null, '농부·요리사·수공예 도시형 장터'),
  ('meatbox', '미트박스', 'food', 'domestic', 'https://www.meatbox.co.kr/', '축산물 직거래 온라인 고기 플랫폼.', false, null, null, null, '사업자등록 후 판매자·구매자 가입', '축산물 직거래·도매 가격 비교'),
  ('permeal', '퍼밀', 'food', 'domestic', 'https://www.permeal.co.kr/', '산지 식재료·밀키트 온라인 푸드 플랫폼.', false, null, null, null, null, '산지 식재료·밀키트 큐레이션'),
  ('youngbakery', '영베이커리', 'food', 'domestic', 'https://youngbakery.com/', '빵 정기배송 베이커리 구독 서비스.', false, null, null, null, '사업자등록·통신판매업 신고 후 입점(자사몰형)', '빵 정기배송 구독에 강점'),
  ('hyfresh', '프레딧', 'food', 'domestic', 'https://www.hyfresh.co.kr/', 'hy의 국·탕·밀키트·신선식품 구독 쇼핑몰.', false, null, null, null, 'hy 운영 자사몰 — 일반 이용은 가입 후 바로', '국·탕·밀키트 등 신선식품 정기구독에 강점'),
  ('fresheasy', '프레시지', 'food', 'domestic', 'https://fresheasy.co.kr/', '밀키트·간편식·HMR 전문 온라인몰.', false, null, null, null, '자사 브랜드몰 — 이용은 가입 후 바로', '밀키트·HMR 간편식 전문에 강점'),
  ('soolmarket', '술마켓', 'food', 'domestic', 'https://www.soolmarket.com/', '전국 양조장 전통주 전문 판매 쇼핑몰.', false, null, null, null, '주류 판매는 면허·전통주 요건 필요', '전국 양조장 전통주 큐레이션에 강점'),
  ('soollove', '전통주애', 'food', 'domestic', 'https://soollove.com/', '전통주 전문 온라인 판매 쇼핑몰.', false, null, null, null, '주류 판매는 면허·전통주 온라인판매 요건 필요', '전통주 전문 온라인 판매에 강점'),
  ('business', '벨루가', 'food', 'domestic', 'https://business.veluga.kr/', '주류 도매 발주·와인 유통 중개 B2B.', false, null, null, null, '주류 도매 — 사업자·주류 면허 확인 후 거래', '주류 도매 발주·와인 유통 B2B 중개에 강점'),
  ('roout', '루트', 'food', 'domestic', 'https://roout.co.kr/', '농어민·소비자 연결 농수산물 직거래.', false, null, null, null, '농어민 판매자·소비자 가입 후 이용', '농수산물 산지 직거래 연결에 강점'),
  ('oraund', '오라운트', 'food', 'domestic', 'https://oraund.com/', '당일 로스팅 원두·드립백을 판매하는 스페셜티 커피 로스터리.', false, null, null, null, '자사 로스터리몰 — 이용은 가입 후 바로', '당일 로스팅 스페셜티 원두·드립백에 강점'),
  ('unspecialty', '언스페셜티', 'food', 'domestic', 'https://unspecialty.com/', '여러 로스터리 원두를 모은 스페셜티 커피 플랫폼.', false, null, null, null, '로스터리 입점형 — 사업자등록·통신판매업 신고 필요', '여러 로스터리 원두 모음 큐레이션에 강점'),
  ('180coffee', '180커피로스터스', 'food', 'domestic', 'https://180coffee.com/', '국가대표 로스터가 운영하는 스페셜티 원두 로스팅 컴퍼니.', false, null, null, null, '자사 로스터리몰 — 이용은 가입 후 바로', '국가대표 로스터 운영 스페셜티 원두에 강점')
on conflict (id) do nothing;

insert into public.platforms (id, name, category_id, region, url, blurb, is_new, fee_band, fee_text, settle_text, enter_text, strength) values
  ('altdif', '알디프', 'food', 'domestic', 'https://altdif.com/', '시그니처 블렌딩 티를 전개하는 티·라이프스타일 브랜드.', false, null, null, null, '자사 브랜드몰 — 이용은 가입 후 바로', '시그니처 블렌딩 티·라이프스타일에 강점'),
  ('lookourtea', '룩아워티', 'food', 'domestic', 'https://www.lookourtea.com/', '블렌딩 티를 전문으로 하는 티 브랜드.', false, null, null, null, '자사 브랜드몰 — 이용은 가입 후 바로', '블렌딩 티 전문에 강점'),
  ('zzann', '짠', 'food', 'domestic', 'https://zzann.co.kr/', '막걸리·약주·리큐르 등을 다루는 전통주 직거래 플랫폼.', false, null, null, null, '주류 판매는 면허·전통주 요건 필요', '막걸리·약주·리큐르 전통주 직거래에 강점'),
  ('mewolmejoo', '매월매주', 'food', 'domestic', 'https://mewolmejoo.com/', '전통주 구독·단품·선물세트를 다루는 전통주 허브몰.', false, null, null, null, '주류 판매는 면허·전통주 온라인판매 요건 필요', '전통주 구독·선물세트 허브에 강점'),
  ('lovinghut', '러빙헛', 'food', 'domestic', 'https://lovinghut.co.kr/', '식물성 대체육·비건 간편식을 파는 비건 채식 쇼핑몰.', false, null, null, null, '자사 브랜드몰 — 이용은 가입 후 바로', '식물성 대체육·비건 간편식에 강점'),
  ('hanggi', '채식한끼', 'food', 'domestic', 'https://m.hanggi.kr/', '대체육·대체해산물 등 비건 지향 식품 전문 쇼핑몰.', false, null, null, null, '자사몰형 — 이용은 가입 후 바로', '대체육·대체해산물 비건 식품에 강점'),
  ('vegemom', '베지맘', 'food', 'domestic', 'http://www.vegemom.net/', '비건 식품·조미료를 다루는 채식 전문 쇼핑몰.', false, null, null, null, '자사몰형 — 이용은 가입 후 바로', '비건 식품·조미료 채식 전문에 강점'),
  ('calobye', '칼로바이', 'food', 'domestic', 'https://www.calobye.shop/', '프로틴 음료 등 다이어트·단백질 식품을 파는 D2C 자사몰.', false, null, null, null, 'D2C 자사몰 — 이용은 가입 후 바로', '프로틴 음료·다이어트 식품 D2C에 강점'),
  ('dshop', '다신샵', 'food', 'domestic', 'https://dshop.dietshin.com/', '단백질·다이어트 식품을 전문으로 하는 다이어트 식품몰.', false, null, null, null, '자사몰형 — 이용은 가입 후 바로', '단백질·다이어트 식품 전문에 강점'),
  ('granola', '그래놀라몰', 'food', 'domestic', 'https://www.granola.co.kr/', '그래놀라·뮤즐리·견과 등을 모은 시리얼·건강간식 전문몰.', false, null, null, null, '자사몰형 — 이용은 가입 후 바로', '그래놀라·뮤즐리 등 건강간식 모음에 강점'),
  ('kihya', '키햐', 'food', 'domestic', 'https://www.kihya.com/', '위스키·와인·사케 등 주류를 가격비교·스마트오더로 파는 앱으로 2022년 설립된 신생 주류 커머스.', true, null, null, null, '주류 스마트오더 앱 — 가입 후 이용, 픽업은 매장 수령', '위스키·와인 가격비교·스마트오더에 강점'),
  ('idus', '아이디어스', 'handmade', 'domestic', 'https://www.idus.com', '수공예·핸드메이드 작가 마켓.', false, 'mid', '판매수수료+결제수수료 구조', null, '작가 가입·심사 후 작품 등록(개인·사업자)', '수공예 작가 마켓·핸드메이드 유통에 강점'),
  ('10x10', '텐바이텐', 'handmade', 'domestic', 'https://www.10x10.co.kr', '디자인 문구·잡화 편집 마켓.', false, null, null, null, '사업자등록·통신판매업 신고 후 입점 제안', '디자인 문구·잡화 편집 큐레이션에 강점'),
  ('handmadeo', '핸드메이드오', 'handmade', 'domestic', 'https://handmadeo.kr/', '메이커와 소비자를 잇는 관계지향형 핸드메이드 마켓.', false, null, null, null, '메이커 가입 후 프로필·작품 등록', '메이커-소비자 관계지향 핸드메이드에 강점'),
  ('handion', '핸디온', 'handmade', 'domestic', 'https://www.handion.com/', '수공예 액세서리·홈데코 전문 핸드메이드 오픈마켓.', false, null, null, null, '작가 가입 후 작품 등록(개인·사업자)', '수공예 액세서리·홈데코 오픈마켓에 강점'),
  ('youarehandmade', '유어핸드메이드', 'handmade', 'domestic', 'http://youarehandmade.com/', '작가 수공예 작품 판매 핸드메이드 쇼핑몰.', false, null, null, null, '작가 가입 후 작품 등록', '작가 수공예 작품 판매에 강점'),
  ('thehandz', '더핸즈', 'handmade', 'domestic', 'https://www.thehandz.com/', '수공예 완제품·DIY 재료 핸드메이드 포털.', false, null, null, null, '작가 가입 후 완제품·DIY 재료 등록', '수공예 완제품·DIY 재료 포털에 강점'),
  ('twenty', '트웬티', 'handmade', 'domestic', 'https://twenty.style/', '일러스트 작가 스티커·다이어리 굿즈 마켓.', false, null, null, null, '작가 가입 후 굿즈 등록', '일러스트 스티커·다이어리 굿즈에 강점'),
  ('etsy', '엣시', 'handmade', 'overseas', 'https://www.etsy.com/', '전 세계 창작자 핸드메이드·빈티지 글로벌 마켓.', false, 'mid', '리스팅+거래+결제 수수료 혼합', null, '판매자 등록·상점 개설 후 상품 리스팅', '글로벌 핸드메이드·빈티지 해외판매에 강점'),
  ('amazon', '아마존 핸드메이드', 'handmade', 'overseas', 'https://www.amazon.com/handmade', '아마존 장인·메이커 전용 수제 상품 코너.', false, 'mid', '판매수수료(리퍼럴) 기반', null, '메이커 심사·프로 셀러 계정 후 판매', '아마존 트래픽 기반 수제상품 판매에 강점'),
  ('folksy', '폭시', 'handmade', 'overseas', 'https://folksy.com/', '영국 기반 핸드메이드 공예품 마켓플레이스.', false, null, null, null, '영국 기반 — 판매자 등록·상점 개설 후 리스팅', '영국 핸드메이드 공예품 판매에 강점'),
  ('wooddle', '우들', 'handmade', 'domestic', 'https://wooddle.com/', '취미·핸드메이드 활동 매칭 플랫폼.', false, null, null, null, '가입 후 취미·핸드메이드 활동 매칭', '취미·핸드메이드 활동 매칭에 강점'),
  ('saramin', '사람인', 'jobs', 'domestic', 'https://www.saramin.co.kr', '정규·경력직 채용 매칭 플랫폼.', false, null, null, null, '기업 회원가입 후 채용공고 등록', '정규·경력직 채용 매칭에 강점'),
  ('jobkorea', '잡코리아', 'jobs', 'domestic', 'https://www.jobkorea.co.kr', '종합 채용 정보 플랫폼.', false, null, null, null, '기업 회원가입 후 채용공고 등록', '종합 채용 정보·구인구직에 강점'),
  ('albamon', '알바몬', 'jobs', 'domestic', 'https://www.albamon.com', '아르바이트·단기 일자리 중개.', false, null, null, null, '사업자·개인 고용주 가입 후 공고 등록', '아르바이트·단기 일자리 중개에 강점'),
  ('alba', '알바천국', 'jobs', 'domestic', 'https://www.alba.co.kr', '아르바이트 구인구직 플랫폼.', false, null, null, null, '기업·개인 가입 후 공고 등록·이력서 지원', '단기·아르바이트 구인구직에 강점'),
  ('coupangflex', '쿠팡플렉스', 'jobs', 'domestic', 'https://www.coupang.com/np/campaigns/1015', '개인 배송 긱워크(자차 배송).', false, null, null, null, '앱 가입·자차 등록 후 배송 시작', '자차 활용 개인 배송 부업에 적합'),
  ('baeminconnect', '배민커넥트', 'jobs', 'domestic', 'https://www.baemin.com/connect', '배달의민족 라이더 긱워크.', false, null, null, null, '앱 가입·교육 이수 후 배달 시작', '도보·자전거·차량 배달 부업에 적합'),
  ('wanted2', '원티드', 'jobs', 'domestic', 'https://www.wanted.co.kr/', 'IT 중심 지인추천 기반 채용 플랫폼.', false, null, null, null, '가입 후 프로필·이력서 등록', 'IT·개발 직군 채용과 지인추천에 강점'),
  ('incruit', '인크루트', 'jobs', 'domestic', 'https://www.incruit.com/', '종합 구인구직 채용 플랫폼.', false, null, null, null, '가입 후 이력서 등록·공고 지원', '종합 채용공고·기업정보 탐색에 강점'),
  ('rocketpunch', '로켓펀치', 'jobs', 'domestic', 'https://www.rocketpunch.com/', '스타트업 채용·비즈니스 네트워킹.', false, null, null, null, '가입 후 프로필 등록·공고 지원', '스타트업 채용·비즈니스 네트워킹에 강점'),
  ('career', '리멤버 커리어', 'jobs', 'domestic', 'https://career.rememberapp.co.kr/', '명함 기반 경력직 스카우트 채용.', false, null, null, null, '리멤버 가입·명함 등록 후 프로필 공개', '경력직 스카우트 제안 수신에 강점'),
  ('catch', '캐치', 'jobs', 'domestic', 'https://www.catch.co.kr/', '대기업·중견기업 채용 정보·일정 제공.', false, null, null, null, '가입 후 채용 일정·기업정보 이용', '대기업·공채 일정·기업분석 정보에 강점'),
  ('jobplanet', '잡플래닛', 'jobs', 'domestic', 'https://www.jobplanet.co.kr/', '기업 리뷰·연봉 정보와 채용 공고.', false, null, null, null, '가입 후 리뷰·공고 열람·지원', '기업 리뷰·연봉 정보 탐색에 강점'),
  ('peoplenjob', '피플앤잡', 'jobs', 'domestic', 'https://www.peoplenjob.com/', '외국계·헤드헌팅 채용 특화 사이트.', false, null, null, null, '가입 후 이력서 등록·공고 지원', '외국계·헤드헌팅 채용에 특화'),
  ('gubgoo', '급구', 'jobs', 'domestic', 'https://www.gubgoo.com/', '당일·단기 알바 실시간 매칭 긱워크 앱.', false, null, null, null, '앱 가입 후 실시간 매칭·근무', '당일·단기 알바 실시간 매칭에 강점'),
  ('barogo', '바로고', 'jobs', 'domestic', 'https://www.barogo.com/', '라이더·상점 연결 배달대행 긱워크.', false, null, null, null, '라이더 가입·등록 후 배차 수행', '라이더·상점 배달대행 연결에 강점'),
  ('work', '고용24', 'jobs', 'domestic', 'https://www.work.go.kr', '고용노동부 구인구직·직업정보 공공 취업포털.', false, null, null, null, '가입 후 구인·구직 등록(공공 서비스)', '공공 구인구직·고용서비스 통합 이용에 강점'),
  ('findjob', '벼룩시장', 'jobs', 'domestic', 'https://www.findjob.co.kr', '지역 생활밀착 알바·구인구직 정보 플랫폼.', false, null, null, null, '가입 후 공고 등록·구직 열람', '지역 생활밀착 알바·구인구직에 강점'),
  ('newworker', '뉴워커', 'jobs', 'domestic', 'https://www.newworker.co.kr', '인크루트 긱워커 매칭·정산 플랫폼.', false, null, null, null, '가입 후 프로필 등록·프로젝트 지원', '긱워커 프로젝트 매칭·정산 지원에 강점'),
  ('specter', '스펙터', 'jobs', 'domestic', 'https://www.specter.co.kr', '지원자 평판조회(레퍼런스 체크) 인재 검증.', false, null, null, null, '기업 가입 후 평판조회 요청', '지원자 평판조회·인재 검증에 특화'),
  ('attalework', '어테일워크', 'jobs', 'domestic', 'https://www.attalework.com', '4060 중장년·시니어 전문가 채용 매칭.', false, null, null, null, '가입 후 프로필 등록·매칭', '중장년·시니어 전문가 채용 매칭에 특화'),
  ('senior', '원더풀시니어', 'jobs', 'domestic', 'https://senior.saramin.co.kr', '사람인 중장년 취업 진단·구직·교육 지원.', false, null, null, null, '가입 후 진단·구직·교육 이용', '중장년 취업 진단·구직·교육 지원에 강점'),
  ('woodel', '우리동네딜리버리', 'jobs', 'domestic', 'https://woodel.co.kr', 'GS리테일 도보 배달 긱워크 플랫폼.', false, null, null, null, '앱 가입 후 도보 배달 수행', '도보 근거리 배달 부업에 적합'),
  ('codingvalley', 'AI 코딩밸리', 'jobs', 'domestic', 'https://www.codingvalley.com/', '2022년 창업한 유리프트가 운영하는 신생 에듀테크로, 직장인을 위한 ChatGPT·Claude·Gemini 등 AI 활용 및 코딩 교육을 모바일로 제공한다.', true, null, null, null, '가입 후 바로 수강(모바일 학습)', '직장인 AI 활용·코딩 학습에 강점'),
  ('epop', '말해보카', 'jobs', 'domestic', 'https://epop.ai/', '이팝소프트가 만든 AI 기반 영어 단어·회화 학습 앱으로, 게이미피케이션을 접목해 최근 빠르게 성장 중인 신흥 어학 에듀테크다.', true, null, null, null, '가입 후 바로 학습(무료 체험 제공)', 'AI 기반 영어 단어·회화 학습에 강점'),
  ('argong', '알공', 'jobs', 'domestic', 'https://www.argong.ai/', '디엔소프트가 선보인 초등 특화 AI 코스웨어로, 영어·수학을 맞춤형으로 학습시키는 신규 에듀테크 서비스다.', true, null, null, null, '가입 후 학습 시작', '초등 영어·수학 AI 맞춤 학습에 강점'),
  ('tiokorea', '티오', 'jobs', 'domestic', 'https://tiokorea.com/', '취업준비생을 위한 AI 자기소개서·면접 준비 어시스턴트를 표방하는 신생 커리어테크 서비스다.', true, null, null, null, '가입 후 바로 사용', 'AI 자소서·면접 준비 지원에 강점'),
  ('haijob', '하이잡', 'jobs', 'domestic', 'https://www.haijob.co.kr/', '직무적합성 진단부터 자소서 첨삭, 면접까지 한곳에서 돕는 신규 AI 취업 준비 플랫폼이다.', true, null, null, null, '가입 후 바로 사용', '직무진단·자소서·면접 준비 통합 지원'),
  ('naim', '나임', 'jobs', 'domestic', 'https://naim.cool/', '개인 경험 데이터를 기억해 자소서를 작성·검증해 주는 신생 AI 취업 지원 서비스다.', true, null, null, null, '가입 후 바로 사용', '경험 데이터 기반 자소서 작성·검증 지원'),
  ('groupby', '그룹바이', 'jobs', 'domestic', 'https://groupby.kr/', '스타트업 채용 공고와 취업 인사이트를 큐레이션하는 신흥 스타트업 전문 채용 플랫폼이다.', true, null, null, null, '가입 후 채용공고·인사이트 열람', '스타트업 채용공고·취업 인사이트 큐레이션'),
  ('dio', '디오', 'jobs', 'domestic', 'https://www.dio.so/', '검증된 경력직 인재를 구독형으로 매칭·채용하는 신규 HR테크 플랫폼이다.', true, null, null, null, '기업 가입 후 구독형 인재 매칭', '검증된 경력직 구독형 매칭에 강점'),
  ('1gada', '가다', 'jobs', 'domestic', 'https://1gada.com/', '건설 일용직 근로자와 현장을 실시간 연결하는 인력 중개 플랫폼으로, 2025년 시리즈B 투자를 유치하며 성장 중인 서비스다.', true, null, null, null, '앱 가입 후 현장·근로자 실시간 매칭', '건설 일용직·현장 실시간 인력 매칭에 강점'),
  ('kowork', '코워크', 'jobs', 'domestic', 'https://kowork.kr/', '2023년 앱을 정식 출시한 신규 플랫폼으로, 외국인 구직자와 국내 기업을 잇는 구인구직·비자 정보 서비스를 제공한다.', true, null, null, null, '가입 후 프로필 등록·매칭', '외국인 구직자·기업 매칭과 비자 정보에 강점'),
  ('workwiz', '워크위즈', 'jobs', 'domestic', 'https://www.workwiz.co.kr/', '4050 중장년 재취업에 특화된 커리어 매칭 플랫폼으로, 전문 컨설턴트 코칭과 일자리 매칭을 함께 제공하는 서비스다.', true, null, null, null, '가입 후 프로필 등록·매칭·코칭', '중장년 재취업 매칭·컨설팅에 특화'),
  ('miso', '미소', 'homeservice', 'domestic', 'https://miso.kr', '가사·청소·이사 등 홈서비스 매칭.', false, null, null, null, '앱 가입 후 서비스 예약·이용', '가사·청소·이사 등 홈서비스 매칭에 강점'),
  ('cleanlab', '청소연구소', 'homeservice', 'domestic', 'https://www.cleaninglab.co.kr', '가사도우미·홈클리닝 매칭.', false, null, null, null, '앱 가입 후 서비스 예약·이용', '정기·가사 홈클리닝 매칭에 강점'),
  ('daerijubu', '대리주부', 'homeservice', 'domestic', 'https://www.hom.kr', '가사·돌봄 도우미 중개.', false, null, null, null, '앱 가입 후 서비스 예약·이용', '가사·돌봄 도우미 중개에 강점'),
  ('jjakkak', '째깍악어', 'homeservice', 'domestic', 'https://www.tictoccroc.com', '아이 돌봄·놀이 선생님 매칭.', false, null, null, null, '앱 가입 후 돌봄 선생님 예약', '아이 돌봄·놀이 선생님 매칭에 특화'),
  ('homemaster', '홈마스터', 'homeservice', 'domestic', 'http://homemaster.co.kr/main/', '가사·청소 도우미 예약 매칭 서비스.', false, null, null, null, '앱 가입 후 서비스 예약·이용', '가사·청소 도우미 예약 매칭에 강점'),
  ('getwashswat', '세탁특공대', 'homeservice', 'domestic', 'https://www.getwashswat.com/', '모바일 세탁물 수거·배송 O2O.', false, null, null, null, '앱 가입 후 수거 신청; 세탁 파트너는 제휴 심사', '비대면 수거·배송 세탁에 강점'),
  ('laundrygo', '런드리고', 'homeservice', 'domestic', 'https://www.laundrygo.com/', '문 앞 수거·배송 세탁·수선 서비스.', false, null, null, null, '앱 가입 후 문앞 수거 신청; 세탁 파트너 제휴', '수거·배송+수선 원스톱 세탁에 강점'),
  ('apps2', '애니맨', 'homeservice', 'domestic', 'https://apps.apple.com/kr/app/id1341537162', '심부름·배달·청소 실시간 매칭 앱.', false, null, null, null, '가입 후 헬퍼·요청자 모두 이용; 헬퍼는 프로필 등록', '심부름·배달 실시간 매칭에 강점'),
  ('apps3', '해주세요', 'homeservice', 'domestic', 'https://apps.apple.com/kr/app/id1567338376', '배달·청소·이사·펫 등 심부름 매칭 앱.', false, null, null, null, '가입 후 요청 등록; 수행자는 프로필·인증 후 활동', '다목적 생활 심부름 매칭에 강점'),
  ('zipdoc', '집닥', 'homeservice', 'domestic', 'https://zipdoc.co.kr/', '인테리어 비교견적·시공 중개 O2O.', false, null, null, null, '시공사는 파트너 등록·심사 후 견적 참여', '인테리어 비교견적·시공 중개에 강점'),
  ('houstep', '하우스텝', 'homeservice', 'domestic', 'https://m.houstep.co.kr/estimate', '도배·마루·창호 등 표준 견적 시공 플랫폼.', false, null, null, null, '소비자는 표준 견적 신청; 시공팀은 파트너 등록', '도배·마루·창호 표준 견적 시공에 강점'),
  ('apps4', '인스타워시', 'homeservice', 'domestic', 'https://apps.apple.com/kr/app/id1112047529', '방문 프리미엄 출장 세차 O2O.', false, null, null, null, '앱 가입 후 출장 세차 예약', '방문 프리미엄 출장 세차에 강점'),
  ('wayopet', '와요', 'homeservice', 'domestic', 'https://wayopet.com/', '펫시터 방문 돌봄·산책 예약 플랫폼.', false, null, null, null, '가입 후 예약; 펫시터는 프로필·인증 후 활동', '펫 방문 돌봄·산책 예약에 강점'),
  ('dogmate', '도그메이트', 'homeservice', 'domestic', 'https://www.dogmate.co.kr/', '반려동물 방문 돌봄·산책 매칭.', false, null, null, null, '가입 후 예약; 펫시터는 프로필·인증 후 활동', '반려동물 방문 돌봄·산책 매칭에 강점'),
  ('mogwai', '모그와이', 'homeservice', 'domestic', 'https://www.mogwai.co.kr/', '펫시터 방문 돌봄 예약 플랫폼.', false, null, null, null, '가입 후 예약; 펫시터는 프로필·인증 후 활동', '펫시터 방문 돌봄 예약에 강점'),
  ('petplanet', '펫플래닛', 'homeservice', 'domestic', 'https://petplanet.co/', '펫시터 위탁·방문 돌봄 연결 플랫폼.', false, null, null, null, '가입 후 예약; 펫시터는 프로필·인증 후 활동', '펫 위탁·방문 돌봄 연결에 강점'),
  ('jaranda', '자란다', 'homeservice', 'domestic', 'https://www.jaranda.kr/', '아이 놀이·학습 선생님 매칭 돌봄.', false, null, null, null, '학부모 가입 후 매칭; 선생님은 프로필·인증 등록', '아이 놀이·학습 돌봄 매칭에 강점'),
  ('momsitter', '맘시터', 'homeservice', 'domestic', 'https://www.mom-sitter.com/', '베이비시터·아이돌보미 매칭 플랫폼.', false, null, null, null, '가입 후 매칭; 시터는 프로필·인증 후 활동', '베이비시터·아이돌보미 매칭에 강점'),
  ('zimssa', '짐싸', 'homeservice', 'domestic', 'https://www.zimssa.com', '앱으로 포장이사·입주청소 견적 비교·예약.', false, null, null, null, '앱으로 견적 신청; 이사·청소 업체는 파트너 등록', '포장이사·입주청소 견적 비교에 강점'),
  ('24mall', '이사몰', 'homeservice', 'domestic', 'https://www.24mall.co.kr', '이삿짐센터 포장이사 견적 실시간 비교.', false, null, null, null, '소비자는 견적 신청; 이삿짐센터는 파트너 등록', '포장이사 견적 실시간 비교에 강점'),
  ('modoo24', '모두이사', 'homeservice', 'domestic', 'https://modoo24.net', '허가 이사·입주청소 후기 기반 매칭.', false, null, null, null, '소비자는 견적 신청; 허가 이사업체 파트너 등록', '후기 기반 이사·입주청소 매칭에 강점'),
  ('hcmaster', '홈케어마스터', 'homeservice', 'domestic', 'https://www.hcmaster.kr', '소독·방역·해충방제 생활방역 홈케어.', false, null, null, null, '방문 소독·방역 서비스 예약 신청', '소독·방역·해충방제 홈케어에 강점'),
  ('hscare', 'HS홈케어', 'homeservice', 'domestic', 'https://hs-care.com', '매트리스·에어컨·세탁기 분해 세척 홈케어.', false, null, null, null, '방문 분해 세척 서비스 예약 신청', '가전·매트리스 분해 세척 홈케어에 강점'),
  ('yper', '와이퍼', 'homeservice', 'domestic', 'https://yper.co.kr', '수거-손세차-배달 원스톱 출장 세차.', false, null, null, null, '앱 가입 후 출장 세차 예약', '수거-손세차-배달 원스톱 세차에 강점'),
  ('kimzipsa', '김집사', 'homeservice', 'domestic', 'https://kimzipsa.co.kr', '아파트 상주형 배달·심부름 생활 대행 O2O.', false, null, null, null, '입주 아파트 단지에서 앱 가입 후 이용', '아파트 상주형 배달·심부름 대행에 강점'),
  ('bosalpim', '보살핌', 'homeservice', 'domestic', 'https://www.bosalpim.co.kr/', '2021년 출범한 신생 시니어케어 스타트업으로, 요양보호사 등 돌봄 인력과 어르신·기관을 연결하는 매칭 플랫폼이다.', true, null, null, null, '기관·보호자 가입 후 매칭; 요양보호사 등록', '시니어 돌봄 인력·기관 매칭에 강점'),
  ('forparents', '포페런츠', 'homeservice', 'domestic', 'https://forparents.co.kr/', '2022년 설립된 신규 스타트업으로, 전문 케어 인력 ''버디''가 동행하는 어르신 나들이·생활 돌봄 컨시어지 서비스를 제공한다.', true, null, null, null, '보호자 가입 후 예약; 케어 인력 등록·교육', '어르신 동행 나들이·생활 돌봄에 강점'),
  ('sinor', '시놀 79전화', 'homeservice', 'domestic', 'https://www.sinor.co.kr/', '2024년 출시된 시니어 대상 신규 서비스로, 5070 세대를 위한 AI 말벗·친구 매칭 등 비대면 돌봄을 표방한다.', true, null, null, null, '가입 후 이용(전화·앱 기반)', '5070 시니어 비대면 말벗·매칭에 강점'),
  ('petbom', '펫봄', 'homeservice', 'domestic', 'https://petbom.com/', '2021년 말 출시된 신생 하이퍼로컬 펫시터 앱으로, 이웃 돌봄님에게 강아지·고양이 방문 돌봄과 산책을 맡길 수 있다.', true, null, null, null, '가입 후 예약; 돌봄님은 프로필·인증 후 활동', '하이퍼로컬 이웃 펫 방문 돌봄에 강점'),
  ('hisitter', '하이시터', 'homeservice', 'domestic', 'https://hi-sitter.com/', '2024년 2월 출시된 신규 회원제 아이돌봄 서비스로, 영유아 대상 풀타임 가정 방문 베이비시터를 연결한다.', true, null, null, null, '회원제 가입 후 매칭; 시터는 인증 후 활동', '영유아 풀타임 가정 방문 돌봄에 강점'),
  ('woowarhanclean', '우아한정리', 'homeservice', 'domestic', 'https://www.woowarhanclean.com/', '정리수납·집정리 컨설팅 방문 서비스와 무료 견적을 제공한다.', false, null, null, null, '무료 견적 신청 후 방문 서비스 예약', '정리수납·집정리 컨설팅에 강점'),
  ('aftermoving', '이사후애', 'homeservice', 'domestic', 'https://www.aftermoving.net/', '이사 전후 짐 정리와 정리수납 전문가 방문 서비스를 다룬다.', false, null, null, null, '방문 견적 신청 후 정리 서비스 예약', '이사 전후 짐 정리·정리수납에 강점'),
  ('verygoodlife', '베리굿정리컨설팅', 'homeservice', 'domestic', 'https://www.verygoodlife.kr/', '가정·상업 공간의 정리수납 컨설팅과 교육을 제공하는 업체다.', false, null, null, null, '방문 컨설팅·교육 신청', '가정·상업 공간 정리수납 컨설팅·교육에 강점'),
  ('covering', '커버링', 'homeservice', 'domestic', 'https://www.covering.app/', '생활 쓰레기·폐기물 방문 수거를 앱으로 신청하는 서비스다.', false, null, null, null, '앱으로 폐기물 방문 수거 신청', '생활 쓰레기·폐기물 방문 수거에 강점'),
  ('sgin', '시공인', 'homeservice', 'domestic', 'https://www.sgin.co.kr/', '인테리어 시공 현장과 기술 인력을 지역·시간 기준으로 매칭한다.', false, null, null, null, '현장·기술자 가입 후 지역·시간 기준 매칭', '인테리어 시공 인력 지역 매칭에 강점'),
  ('cleanbell', '클린벨', 'homeservice', 'domestic', 'https://www.cleanbell.co.kr/', '입주·이사청소 업체 견적을 비교해 연결하는 플랫폼이다.', false, null, null, null, '소비자는 견적 신청; 청소업체는 파트너 등록', '입주·이사청소 업체 견적 비교에 강점'),
  ('archisketch', '아키스케치', 'homeservice', 'domestic', 'https://www.archisketch.com/', '3D 인테리어·가구배치 시뮬레이션 도구를 제공한다.', false, null, null, null, '가입 후 3D 인테리어 도구 사용', '3D 인테리어·가구배치 시뮬레이션에 강점'),
  ('zigbang', '직방', 'realestate', 'domestic', 'https://www.zigbang.com', '원룸·오피스텔·아파트 등 주거 부동산 중개.', false, null, null, null, '중개사무소는 제휴 가입 후 매물 등록', '원룸·오피스텔 등 주거 매물 탐색에 강점'),
  ('dabang', '다방', 'realestate', 'domestic', 'https://www.dabangapp.com', '주거용 부동산 매물 정보.', false, null, null, null, '중개사무소는 제휴 가입 후 매물 등록', '주거용 매물 정보 탐색에 강점'),
  ('naverland', '네이버 부동산', 'realestate', 'domestic', 'https://land.naver.com', '종합 부동산 매물·시세 정보.', false, null, null, null, '중개사무소는 제휴 채널로 매물 등록', '종합 매물·시세 정보 집약에 강점'),
  ('rsquare', '알스퀘어', 'realestate', 'domestic', 'https://www.rsquare.co.kr', '사무실·상업용 부동산 중개(B2B).', false, null, null, null, '임차 상담·문의 후 매물 제안(B2B 중개형)', '상업용 오피스 임대·사옥 이전 중개에 강점'),
  ('ziptoss', '집토스', 'realestate', 'domestic', 'https://www.ziptoss.com', '전·월세 중개 부동산 플랫폼.', false, null, null, null, '앱 가입 후 매물 검색·중개 문의', '전월세 직영 중개·수수료 절감형에 강점'),
  ('nemoapp', '네모', 'realestate', 'domestic', 'https://www.nemoapp.kr/', '상가·사무실·빌딩 상업용 부동산 임대·매매.', false, null, null, null, '가입 후 매물 검색, 중개사 매물 등록', '상가·사무실 상업용 임대매물 검색에 강점'),
  ('peterpanz', '피터팬의 좋은방 구하기', 'realestate', 'domestic', 'https://www.peterpanz.com/', '원룸·투룸 부동산 직거래·커뮤니티.', false, null, null, null, '가입 후 매물 검색·직거래 등록', '원룸·투룸 직거래·커뮤니티 매물에 강점'),
  ('hogangnono', '호갱노노', 'realestate', 'domestic', 'https://hogangnono.com/', '실거래가 기반 아파트 시세·매물 지도.', false, null, null, null, '가입 후 바로 이용(시세 조회)', '실거래가 기반 아파트 시세·비교에 강점'),
  ('asil', '아실', 'realestate', 'domestic', 'https://asil.kr/', '아파트 실거래가·단지 비교·투자 분석.', false, null, null, null, '가입 후 바로 이용(시세·분석 조회)', '아파트 실거래가·단지 비교·투자 분석에 강점'),
  ('disco', '디스코', 'realestate', 'domestic', 'https://www.disco.re/', '토지·빌딩·상가 실거래가·등기 지도 서비스.', false, null, null, null, '가입 후 바로 이용(지도 조회)', '토지·빌딩·상가 실거래가·등기 조회에 강점'),
  ('valueupmap', '밸류맵', 'realestate', 'domestic', 'https://www.valueupmap.com/', '토지·건물·상가·공장 실거래가·매물 지도.', false, null, null, null, '가입 후 바로 이용(지도 조회)', '토지·건물·공장 실거래가·매물 지도에 강점'),
  ('bdsplanet', '부동산플래닛', 'realestate', 'domestic', 'https://www.bdsplanet.com/', '토지·건물·상가 실거래가·노후도 분석.', false, null, null, null, '가입 후 바로 이용(실거래가 조회)', '실거래가·건물 노후도 분석에 강점'),
  ('r114', '부동산R114', 'realestate', 'domestic', 'https://r114.com/', '아파트·상가 시세·분양·매물 데이터 플랫폼.', false, null, null, null, '가입 후 바로 이용(시세·분양 조회)', '아파트·상가 시세·분양 데이터에 강점'),
  ('kbland', 'KB부동산', 'realestate', 'domestic', 'https://kbland.kr/', 'KB 시세 기반 실거래가·매물·분양 정보.', false, null, null, null, '가입 후 바로 이용(시세 조회)', 'KB 시세 기반 시세·대출 기준 정보에 강점'),
  ('smatch', '스매치', 'realestate', 'domestic', 'https://smatch.kr/', '사무실·상가·빌딩 임대·매매 상업용 중개.', false, null, null, null, '임차 문의·상담, 중개사 매물 등록', '사무실·상가·빌딩 상업용 임대매매 중개에 강점'),
  ('officefind', '오피스파인드', 'realestate', 'domestic', 'https://officefind.co.kr/', '데이터 기반 오피스 임대·이전 컨설팅.', false, null, null, null, '임차 상담·문의 후 오피스 제안', '데이터 기반 오피스 임대·이전 컨설팅에 강점'),
  ('fastfive', '패스트파이브', 'realestate', 'domestic', 'https://fastfive.co.kr/', '국내 최다 지점 공유오피스 브랜드.', false, null, null, null, '투어·문의 후 멤버십 계약·입주', '다지점 공유오피스·입주 편의에 강점'),
  ('sparkplus', '스파크플러스', 'realestate', 'domestic', 'https://sparkplus.co.kr/', '역세권 중심 사무 특화 공유오피스.', false, null, null, null, '투어·문의 후 멤버십 계약·입주', '역세권 사무 특화 공유오피스에 강점'),
  ('wework', '위워크 코리아', 'realestate', 'domestic', 'https://www.wework.com/', '글로벌 공유 업무공간·오피스 임대.', false, null, null, null, '투어·문의 후 멤버십 계약·입주', '글로벌 네트워크 공유 업무공간에 강점'),
  ('regus', '리저스', 'realestate', 'domestic', 'https://www.regus.co.kr/', '서비스드 오피스 글로벌 공유오피스 브랜드.', false, null, null, null, '문의·계약 후 이용', '글로벌 서비스드 오피스·비상주 사무실에 강점'),
  ('wecook', '위쿡', 'realestate', 'domestic', 'https://www.wecook.co.kr/', '제조·배달형 공유주방 공간 임대.', false, null, null, null, '문의·계약 후 입주', '제조·배달형 공유주방 공간 임대에 강점'),
  ('nanudakitchen', '나누다키친', 'realestate', 'domestic', 'https://nanudakitchen.com/', '상권분석 기반 공유주방 중개 플랫폼.', false, null, null, null, '상권 상담·문의 후 입점 계약', '상권분석 기반 공유주방 중개에 강점'),
  ('jisanlive', '지산라이브', 'realestate', 'domestic', 'https://jisanlive.com/', '지식산업센터·상가·창고 임대·매매 정보.', false, null, null, null, '가입 후 매물 검색·문의', '지식산업센터·상가·창고 임대매매 정보에 강점'),
  ('jumpapp', '점프컴퍼니', 'realestate', 'domestic', 'https://jumpapp.co.kr/', '지식산업센터·오피스 분양·임대·매매 중개.', false, null, null, null, '분양·임차 문의 후 매물 제안(중개형)', '지식산업센터·오피스 분양·임대 중개에 강점'),
  ('myfranchise', '마이프차', 'realestate', 'domestic', 'https://myfranchise.kr', '프랜차이즈 매출·창업비용 비교·상권분석.', false, null, null, null, '가입 후 바로 이용(비교·분석 조회)', '프랜차이즈 창업비용·매출 비교·상권분석에 강점'),
  ('openub', '오픈업', 'realestate', 'domestic', 'https://www.openub.com', '빅데이터 기반 AI 상권분석 플랫폼.', false, null, null, null, '가입 후 상권 데이터 조회', '빅데이터 기반 AI 상권분석에 강점'),
  ('auction1', '옥션원', 'realestate', 'domestic', 'https://www.auction1.co.kr', '법원경매·부동산경매 정보·교육 플랫폼.', false, null, null, null, '가입·구독 후 경매 정보·교육 이용', '법원경매·부동산경매 정보·교육에 강점'),
  ('ggi', '지지옥션', 'realestate', 'domestic', 'https://www.ggi.co.kr', '법원경매·공매 정보·권리분석 서비스.', false, null, null, null, '가입·구독 후 경매 정보 이용', '법원경매·공매 정보·권리분석에 강점'),
  ('dooinauction', '두인경매', 'realestate', 'domestic', 'https://www.dooinauction.com', '경매·공매·NPL·권리분석 정보 플랫폼.', false, null, null, null, '가입·구독 후 경매 정보 이용', '경매·공매·NPL 권리분석 정보에 강점'),
  ('thecomenstay', '컴앤스테이', 'realestate', 'domestic', 'https://www.thecomenstay.com', '월 단위 청년 셰어하우스 검색·운영 플랫폼.', false, null, null, null, '가입 후 검색·입주 문의', '월 단위 청년 셰어하우스 검색·운영에 강점'),
  ('gobang', '고방', 'realestate', 'domestic', 'https://gobang.kr', '원룸텔·셰어하우스·룸메이트 매칭 주거 플랫폼.', false, null, null, null, '앱 가입 후 검색·매칭 이용', '원룸텔·셰어하우스·룸메이트 매칭에 강점'),
  ('gosi1', '고시원넷', 'realestate', 'domestic', 'http://www.gosi1.net', '고시원·고시텔·원룸텔 검색 정보 사이트.', false, null, null, null, '가입 없이 검색·문의 이용', '고시원·고시텔·원룸텔 검색 정보에 강점'),
  ('drapt', '닥터아파트', 'realestate', 'domestic', 'http://www.drapt.com', '아파트 시세·분양·재건축 정보 포털.', false, null, null, null, '가입 후 시세·분양 정보 조회', '아파트 시세·분양·재건축 정보에 강점'),
  ('bbric', '비브릭', 'realestate', 'domestic', 'https://bbric.com/', '세종텔레콤이 부산 블록체인 규제샌드박스에서 운영하는 신생 상업용 부동산 조각투자 플랫폼이다.', true, null, null, null, '앱 가입·투자자 인증 후 이용(신생)', '상업용 부동산 조각투자 플랫폼(규제샌드박스 신생)'),
  ('naezipscan', '내집스캔', 'realestate', 'domestic', 'https://www.naezipscan.com/', '한국부동산데이터연구소가 만든 신생 서비스로, AI가 등기부·임대인 정보를 분석해 전세사기·깡통전세 위험도를 진단한다.', true, null, null, null, '가입 후 진단 신청(신생 서비스)', 'AI 등기부·임대인 분석 전세사기 위험 진단에 강점'),
  ('zippoom', '집품', 'realestate', 'domestic', 'https://zippoom.com/', '넥스트그라운드가 운영하는 신생 프롭테크로, 실거주 리뷰와 보증금 위험 분석 리포트를 제공한다.', true, null, null, null, '가입 후 리뷰·리포트 조회(신생)', '실거주 리뷰·보증금 위험 분석 리포트에 강점'),
  ('dizo', '디조', 'realestate', 'domestic', 'https://dizo.com/', '네이버 부동산 기획자 출신이 창업한 신규 프롭테크로, 주거·상업용 부동산 데이터와 중개사 마이페이지를 제공한다.', true, null, null, null, '가입 후 이용, 중개사 마이페이지 등록(신생)', '주거·상업용 부동산 데이터·중개사 도구에 강점'),
  ('arcadegod', '상가의신', 'realestate', 'domestic', 'https://www.arcadegod.co.kr/', '상가 분양·임대·매매 등 상업용 부동산 매물을 모아 비교하는 플랫폼.', false, null, null, null, '가입 후 매물 검색·문의', '상가 분양·임대·매매 매물 비교에 강점'),
  ('sangga114', '상가114', 'realestate', 'domestic', 'https://www.sangga114.co.kr/', '신규 상가 분양 정보를 안내하는 상가 전문 사이트.', false, null, null, null, '분양·중개 사업자 상가 매물 제휴 등록', '신규 상가 분양 정보 탐색에 강점'),
  ('imya', '임야114', 'realestate', 'domestic', 'https://imya.co.kr/', '임야·산 매매 매물을 경사도·도로 등 정보와 함께 제공하는 사이트.', false, null, null, null, '공인중개사·소유주 임야 매물 등록', '임야·산지 경사도·도로 등 조건 확인에 강점'),
  ('imya4989', '한국임야매매닷컴', 'realestate', 'domestic', 'http://imya4989.com/', '임야·산지 매매 매물을 다루는 토지 전문 중개 사이트.', false, null, null, null, '공인중개사·소유주 임야 매물 등록', '임야·산지 매매 매물 집중에 강점'),
  ('ddangya', '땅야', 'realestate', 'domestic', 'https://ddangya.com/', '전국 토지 실거래가 조회와 토지 매물 거래를 제공하는 서비스.', false, null, null, null, '가입 후 조회, 매물 등록은 사업자 문의', '전국 토지 실거래가 조회·비교에 강점'),
  ('zoomansa', '주만사', 'realestate', 'domestic', 'https://www.zoomansa.com/', '유휴 주차공간을 공유하는 월주차·일주차 중개 플랫폼.', false, null, null, null, '주차공간 소유주 등록·이용자 앱 가입', '유휴 주차공간 월·일주차 중개에 강점'),
  ('bunyangi', '분양알리미', 'realestate', 'domestic', 'https://bunyangi.com/', '신규 아파트 분양·청약 일정과 입지 정보를 모아 제공하는 서비스.', false, null, null, null, '가입 후 분양·청약 정보 열람', '신규 아파트 분양·청약 일정 정리에 강점'),
  ('gfauction', '굿프렌드경매', 'realestate', 'domestic', 'https://gfauction.info/', 'AI 권리분석과 낙찰 통계를 제공하는 부동산 경매 정보 플랫폼.', false, null, null, null, '가입 후 이용, 유료 정보 구독형', '경매 AI 권리분석·낙찰 통계 제공에 강점'),
  ('seeauction', '보이는부동산경매', 'realestate', 'domestic', 'https://seeauction.net/', '법원경매·공매 물건과 권리분석 정보를 제공하는 경매 사이트.', false, null, null, null, '가입 후 이용, 유료 정보 구독형', '법원경매·공매 권리분석 정보 제공에 강점'),
  ('zipgoai', '땅집고옥션', 'realestate', 'domestic', 'https://zipgoai.com/', '경·공매 및 NPL 물건을 AI로 분석해 주는 경매 정보 서비스.', false, null, null, null, '가입 후 이용, 유료 정보 구독형', '경·공매·NPL 물건 AI 분석에 강점'),
  ('building0', '빌사남', 'realestate', 'domestic', 'https://www.building0.com/', '중소형·꼬마빌딩 실거래가와 매물을 지도로 조회하는 서비스.', false, null, null, null, '가입 후 조회, 매물은 사업자 제휴 등록', '중소형·꼬마빌딩 실거래가 지도 조회에 강점'),
  ('buildingmeme', '빌딩매매닷컴', 'realestate', 'domestic', 'http://www.buildingmeme.com/', '빌딩·건물 매매 및 임대 매물을 다루는 중개 사이트.', false, null, null, null, '공인중개사·소유주 빌딩 매물 등록', '빌딩·건물 매매·임대 매물 취급에 강점'),
  ('archiproperty', '아키부동산', 'realestate', 'domestic', 'https://www.archiproperty.com/', '꼬마빌딩 매매와 상가·사무실 임대를 다루는 부동산 중개.', false, null, null, null, '매물 문의·중개 의뢰 후 이용', '꼬마빌딩 매매·상가 임대 중개에 강점'),
  ('xnob0bj3f9wty2d24ab95b', '공장네트웍스', 'realestate', 'domestic', 'https://xn--ob0bj3f9wty2d24ab95b.com/', '전국 공장·창고·물류센터 매매·임대 전문 중개 플랫폼.', false, null, null, null, '매물 등록·중개 의뢰는 사업자 문의', '공장·창고·물류센터 매매·임대 특화에 강점'),
  ('penggo', '펭고', 'realestate', 'domestic', 'http://www.penggo.net/', '상온·냉장·냉동 창고 임대와 매매를 중개하는 서비스.', false, null, null, null, '창고 소유주 등록·임차인 문의', '상온·냉장·냉동 창고 임대·매매 중개에 강점'),
  ('gangnamunni', '강남언니', 'beautyhealth', 'domestic', 'https://www.gangnamunni.com', '미용·성형·피부 시술 정보·예약.', false, null, null, null, '병원 제휴 입점, 이용자 앱 가입', '미용·성형·피부 시술 정보·예약에 강점'),
  ('goodoc', '굿닥', 'beautyhealth', 'domestic', 'https://www.goodoc.co.kr', '병원·약국 검색·예약.', false, null, null, null, '병원·약국 제휴 입점, 이용자 앱 가입', '병원·약국 검색·예약 접근성에 강점'),
  ('ddocdoc', '똑닥', 'beautyhealth', 'domestic', 'https://www.ddocdoc.com', '병원 예약·접수·대기 관리.', false, null, null, null, '병·의원 제휴 입점, 이용자 앱 가입', '병원 예약·접수·대기 관리에 강점'),
  ('kakaohair', '카카오헤어샵', 'beautyhealth', 'domestic', 'https://hairshop.kakao.com', '미용실 예약 중개.', false, null, null, null, '미용실 제휴 입점, 이용자 앱 가입', '미용실 예약 중개·카카오 연동에 강점'),
  ('yeoshin', '여신티켓', 'beautyhealth', 'domestic', 'https://www.yeoshin.co.kr/', '피부·성형 시술 정보·후기·병원 예약.', false, null, null, null, '병원 제휴 입점, 이용자 앱 가입', '피부·성형 시술 정보·후기·예약에 강점'),
  ('babitalk', '바비톡', 'beautyhealth', 'domestic', 'https://www.babitalk.com/', '성형·피부 시술 정보·후기·병원 예약.', false, null, null, null, '병원 제휴 입점, 이용자 앱 가입', '성형·피부 시술 후기 커뮤니티·예약에 강점'),
  ('modoodoc', '모두닥', 'beautyhealth', 'domestic', 'https://www.modoodoc.com/', '실방문 리뷰·가격으로 병원 비교·예약.', false, null, null, null, '병원 제휴 입점, 이용자 앱 가입', '실방문 리뷰·가격 기반 병원 비교에 강점'),
  ('hidoc', '하이닥', 'beautyhealth', 'domestic', 'https://www.hidoc.co.kr/', '건강 Q&A·의사/병원 찾기 건강 포털.', false, null, null, null, '가입 후 이용, 의료진 제휴 참여', '건강 Q&A·의사/병원 찾기 정보 제공에 강점'),
  ('doctornow', '닥터나우', 'beautyhealth', 'domestic', 'https://doctornow.co.kr/', '비대면 진료·처방·약국 찾기 원격의료.', false, null, null, null, '병원·약국 제휴 입점, 이용자 앱 가입', '비대면 진료·처방·약국 연결에 강점'),
  ('hospital', '핏펫', 'beautyhealth', 'domestic', 'https://hospital.fitpetmall.com/', '동물병원 검색·예약·반려 건강관리.', false, null, null, null, '동물병원 제휴 입점, 이용자 앱 가입', '동물병원 검색·예약·반려 건강관리에 강점'),
  ('heally', '힐리', 'beautyhealth', 'domestic', 'https://heally.co.kr/', '마사지샵 가격비교·예약 플랫폼.', false, null, null, null, '마사지샵 제휴 입점, 이용자 앱 가입', '마사지샵 가격비교·예약에 강점'),
  ('mamap', '마사지맵', 'beautyhealth', 'domestic', 'https://mamap.co.kr/', '마사지샵 최저가 검색·예약 앱.', false, null, null, null, '마사지샵 제휴 입점, 이용자 앱 가입', '마사지샵 최저가 검색·예약에 강점'),
  ('makangs', '마캉스', 'beautyhealth', 'domestic', 'http://www.makangs.com/', '마사지·왁싱·에스테틱 예약 앱.', false, null, null, null, '업소 제휴 입점, 이용자 앱 가입', '마사지·왁싱·에스테틱 예약에 강점'),
  ('fingerprincess', '핑프', 'beautyhealth', 'domestic', 'https://finger-princess.com/', '네일아트 탐색·예약·결제 뷰티 플랫폼.', false, null, null, null, '네일샵 제휴 입점, 이용자 앱 가입', '네일아트 탐색·예약·결제 통합에 강점'),
  ('pillyze', '필라이즈', 'beautyhealth', 'domestic', 'https://www.pillyze.com/', 'AI 식단·영양제·혈당 기록 건강관리 앱.', false, null, null, null, '가입 후 바로 사용', 'AI 식단·영양제·혈당 기록 관리에 강점'),
  ('noom', '눔', 'beautyhealth', 'overseas', 'https://www.noom.com/', '식단·운동·습관 코칭 헬스케어 앱.', false, null, null, null, '가입 후 사용, 구독형 코칭', '식단·운동·습관 코칭 프로그램에 강점'),
  ('pearlcare', '펄케어', 'beautyhealth', 'domestic', 'https://pearlcare.co.kr/', 'RF·EMS·광테라피 기반 두피·피부 홈 뷰티 디바이스 브랜드.', false, null, null, null, '브랜드 직접 운영몰, 일반 소비자 구매', 'RF·EMS·광테라피 홈 뷰티 디바이스에 강점'),
  ('pesade', '페사드', 'beautyhealth', 'domestic', 'https://pesade.kr/', '오드퍼퓸·핸드케어를 전개하는 니치 향수 라이프스타일 브랜드.', false, null, null, null, '브랜드 직접 운영몰, 일반 소비자 구매', '오드퍼퓸·핸드케어 니치 향수 전개에 강점'),
  ('athebeauty', '아떼', 'beautyhealth', 'domestic', 'https://athebeauty.com/', '비건 인증 스킨케어·메이크업을 만드는 비건 뷰티 브랜드.', false, null, null, null, '브랜드 직접 운영몰, 일반 소비자 구매', '비건 인증 스킨케어·메이크업에 강점'),
  ('melixir', '멜릭서', 'beautyhealth', 'domestic', 'https://www.melixir.me/', '식물성 성분 중심의 비건 스킨케어 브랜드 자사몰.', false, null, null, null, '브랜드 직접 운영몰, 일반 소비자 구매', '식물성 성분 비건 스킨케어에 강점'),
  ('jejuon', '제주온', 'beautyhealth', 'domestic', 'https://jejuon.kr/', '제주 유기농 원료로 만드는 비건 지향 천연 화장품 브랜드.', false, null, null, null, '브랜드 직접 운영몰, 일반 소비자 구매', '제주 유기농 원료 비건 지향 화장품에 강점'),
  ('en', '비그린', 'beautyhealth', 'domestic', 'https://en.vegreen.co.kr/', '비건·친환경을 표방하는 스킨케어 브랜드.', false, null, null, null, '가입 후 바로 구매·이용', '비건·친환경 지향 스킨케어에 강점'),
  ('nutridday', 'Nutri D-Day', 'beautyhealth', 'domestic', 'https://nutridday.com/', '저분자 피쉬콜라겐 등 이너뷰티 제품을 파는 D2C 자사몰.', false, null, null, null, '가입 후 바로 구매·이용', '피쉬콜라겐 등 이너뷰티 D2C에 강점'),
  ('foodology', '푸드올로지', 'beautyhealth', 'domestic', 'https://food-ology.co.kr/', '이너뷰티·다이어트 식품 라인을 운영하는 D2C 브랜드몰.', false, null, null, null, '가입 후 바로 구매·이용', '이너뷰티·다이어트 식품 D2C에 강점'),
  ('mindle', '마인들링', 'beautyhealth', 'domestic', 'https://mindle.kr/', '서울대병원 출신 정신과 전문의가 창업한 포티파이의 셀프 멘탈케어 구독 앱으로, 심리검사부터 맞춤형 케어까지 제공하는 신생 멘탈테크 서비스다.', true, null, null, null, '앱 설치·가입 후 검사·구독 이용', '셀프 멘탈케어·심리검사 구독에 강점'),
  ('inside', '인사이드', 'beautyhealth', 'domestic', 'https://www.inside.im/', '2021년 설립된 오웰헬스가 운영하는 인지행동치료(CBT) 기반 정신건강 자가검사·멘탈케어 앱으로, 현재 ''디스턴싱''으로 서비스되는 신생 서비스다.', true, null, null, null, '앱 설치·가입 후 검사·케어 이용', 'CBT 기반 정신건강 자가케어에 강점'),
  ('checkup', '착한의사', 'beautyhealth', 'domestic', 'https://checkup.adoc.co.kr/', '건강검진 비교·예약과 결과조회를 지원하는 헬스케어 플랫폼으로, 운영사 비바이노베이션이 2024년 60억원 규모 시리즈A를 유치한 신생 스타트업이다.', true, null, null, null, '가입 후 검진 비교·예약', '건강검진 비교·예약·결과조회에 강점'),
  ('checkupmoa', '검진모아', 'beautyhealth', 'domestic', 'https://www.checkupmoa.com/', '종합건강검진과 국가건강검진 비용 할인·예약 정보를 모아 제공하는 신생 건강검진 예약 플랫폼이다.', true, null, null, null, '가입 후 검진 비교·예약', '종합·국가검진 비용 비교·예약에 강점'),
  ('wellcheck', '웰체크', 'beautyhealth', 'domestic', 'https://www.well-check.co.kr/', '당뇨·고혈압 등 만성질환자의 혈압·혈당·복약 데이터를 의료진과 함께 관리하는 디지털 헬스케어 플랫폼이다.', true, null, null, null, '앱 설치·가입 후 데이터 관리 이용', '만성질환 데이터·복약 의료진 연계 관리에 강점'),
  ('heymama', '헤이마마', 'beautyhealth', 'domestic', 'https://heymama.kr/', '2023년 출시된 더패밀리랩의 펨테크 서비스로, 산후 여성의 기능 회복과 건강관리를 비대면 홈트레이닝으로 돕는 신생 여성 헬스케어 앱이다.', true, null, null, null, '앱 설치·가입 후 프로그램 이용', '산후 회복·여성 비대면 홈트레이닝에 강점'),
  ('encar', '엔카', 'auto', 'domestic', 'https://www.encar.com', '국내 대표 중고차 거래 플랫폼.', false, null, null, null, '딜러 등록 또는 개인 매물 등록 후 이용', '중고차 매물 검색·시세 확인에 강점'),
  ('heydealer', '헤이딜러', 'auto', 'domestic', 'https://www.heydealer.com', '내 차 팔기(딜러 경매) 중개.', false, null, null, null, '앱에서 차량 등록 후 딜러 견적 수령', '딜러 경매 방식 내차 팔기에 강점'),
  ('kcar', 'K Car(케이카)', 'auto', 'domestic', 'https://www.kcar.com', '중고차 직영 판매·매입.', false, null, null, null, '직영점·앱에서 구매·매입(입점 개념 없음)', '직영 중고차 판매·매입 신뢰성에 강점'),
  ('kbchachacha', 'KB차차차', 'auto', 'domestic', 'https://www.kbchachacha.com', 'KB 계열 중고차 거래 플랫폼.', false, null, null, null, '딜러 등록 또는 개인 매물 등록 후 이용', '금융 계열 연계 중고차 거래에 강점'),
  ('cardoc', '카닥', 'auto', 'domestic', 'https://www.cardoc.co.kr', '자동차 정비·수리 견적 매칭.', false, null, null, null, '가입 후 견적 요청·정비소 매칭', '정비·수리 견적 비교 매칭에 강점'),
  ('carnoon', '카눈', 'auto', 'domestic', 'https://www.carnoon.co.kr/', '신차 구매정보·견적 모음 플랫폼.', false, null, null, null, '가입 후 신차 견적·정보 조회', '신차 구매정보·견적 모음에 강점'),
  ('web', '겟차', 'auto', 'domestic', 'https://web.getcha.kr/', '신차 견적·할부·리스·장기렌트 비교.', false, null, null, null, '가입 후 견적·금융조건 비교', '신차 할부·리스·렌트 조건 비교에 강점'),
  ('web2', '첫차', 'auto', 'domestic', 'https://web.chutcha.net/', '중고차 매매 플랫폼.', false, null, null, null, '딜러 등록 또는 개인 매물 등록 후 이용', '중고차 매물 검색·매매에 강점'),
  ('reborncar', '리본카', 'auto', 'domestic', 'https://www.reborncar.co.kr/', '품질검사·시승 후 구매 직영 중고차 플랫폼.', false, null, null, null, '앱·직영에서 구매(입점 개념 없음)', '품질검사·시승 후 직영 중고차 구매에 강점'),
  ('autoplus', '오토플러스', 'auto', 'domestic', 'https://www.autoplus.co.kr/', '직영관리 중고차 판매·매입·경매.', false, null, null, null, '직영 구매·매입 또는 경매 참여', '직영관리 중고차 판매·매입·경매에 강점'),
  ('autobell', '오토벨', 'auto', 'domestic', 'https://autobell.co.kr/main', '현대글로비스 중고차 경매·매매·시세.', false, null, null, null, '회원 등록 후 경매·매매 이용', '대기업 계열 중고차 경매·시세에 강점'),
  ('carisyou', '카이즈유', 'auto', 'domestic', 'https://www.carisyou.com/', '자동차 통계·신차 견적·시승기 종합정보.', false, null, null, null, '가입 후 통계·견적·시승기 조회', '자동차 통계·종합정보 열람에 강점'),
  ('auto', '다나와 자동차', 'auto', 'domestic', 'https://auto.danawa.com/', '신차 견적·렌트/리스·중고차 가격비교.', false, null, null, null, '가입 후 견적·가격비교 이용', '신차·렌트·중고차 가격비교에 강점'),
  ('kcarauction', 'K Car 옥션', 'auto', 'domestic', 'https://www.kcarauction.com/', '케이카 중고차 경매 플랫폼.', false, null, null, null, '딜러 등록·심사 후 경매 참여', '중고차 경매 매입에 강점(주로 딜러 대상)'),
  ('mycle', '마이클', 'auto', 'domestic', 'https://mycle.co.kr/', '정비소 예약·소모품 알림 내차관리 앱.', false, null, null, null, '앱 설치·가입 후 예약·관리 이용', '정비 예약·소모품 알림 내차관리에 강점'),
  ('carsuri', '카수리', 'auto', 'domestic', 'https://www.carsuri.co.kr/', '출장 엔진오일·배터리 정비 서비스.', false, null, null, null, '가입 후 출장 정비 예약', '출장 오일·배터리 등 방문정비에 강점'),
  ('carpos', '카포스', 'auto', 'domestic', 'http://www.carpos.com', '자동차 정비사업조합 연합 정비·부품 정보.', false, null, null, null, '조합 가입 정비사업자 대상 이용', '정비조합 연합 정비·부품 정보에 강점'),
  ('partzone', '파트존', 'auto', 'domestic', 'https://www.partzone.co.kr', '차량번호 호환 부품 매칭·정비 예약 플랫폼.', false, null, null, null, '가입 후 부품 검색·정비 예약', '차량번호 호환 부품 매칭·예약에 강점'),
  ('cartem', '카템', 'auto', 'domestic', 'http://www.cartem.co.kr', '자동차 용품·튜닝 부품 온라인 스토어.', false, null, null, null, '가입 후 바로 구매·이용', '자동차 용품·튜닝 부품 온라인 구매에 강점'),
  ('autohub', '오토허브', 'auto', 'domestic', 'http://www.autohub.co.kr', '대형 중고차 매매단지·자동차 경매 운영.', false, null, null, null, '딜러 입점 또는 방문 구매·경매 참여', '대형 중고차 매매단지·경매 운영에 강점'),
  ('greencar', '그린카', 'auto', 'domestic', 'https://www.greencar.co.kr', '카셰어링·차량구독 모빌리티 플랫폼.', false, null, null, null, '앱 설치·가입·면허 등록 후 이용', '카셰어링·차량구독 단기 이용에 강점'),
  ('kakaomobility', '카카오T 대리', 'auto', 'domestic', 'https://www.kakaomobility.com/service-kakaot/driver', '모바일 대리운전 호출 서비스.', false, null, null, null, '앱 설치·가입 후 대리 호출', '모바일 대리운전 호출 접근성에 강점'),
  ('camtayo', '캠타요', 'auto', 'domestic', 'https://camtayo.com/', '개인 간 중고 캠핑카 직거래와 품질보장을 제공하는 플랫폼.', false, null, null, null, '가입 후 매물 등록·거래', '개인 간 중고 캠핑카 직거래에 강점'),
  ('campingncar', '캠핑엔카', 'auto', 'domestic', 'https://www.campingncar.co.kr/', '신차·중고 캠핑카와 카라반 매매·렌트를 다루는 사이트.', false, null, null, null, '가입 후 매물 조회·거래·렌트', '캠핑카·카라반 매매·렌트 정보에 강점'),
  ('wonderfulcar', '원더풀캠핑카', 'auto', 'domestic', 'http://wonderfulcar.kr/', '모터홈·차박용 캠핑카 판매와 사후관리를 제공하는 업체몰.', false, null, null, null, '업체 통해 상담·구매(입점 개념 없음)', '모터홈·차박 캠핑카 판매·사후관리에 강점'),
  ('zaekook', '캠핑제국', 'auto', 'domestic', 'https://www.zaekook.com/', '캠핑카·카라반 가격비교와 중고 직거래 정보를 제공하는 사이트.', false, null, null, null, '가입 후 가격비교·직거래 정보 조회', '캠핑카·카라반 가격비교·중고 직거래에 강점'),
  ('bikeweb', '바이크마트', 'auto', 'domestic', 'https://bikeweb.bikemart.co.kr/', '중고 오토바이·수입바이크 직거래와 시세 검색 전문 사이트.', false, null, null, null, '개인·사업자 모두 가입 후 매물 등록', '중고 오토바이·수입바이크 시세 검색·직거래에 강점'),
  ('revolt', '리볼트', 'auto', 'domestic', 'https://www.revolt.kr/', '배터리 진단 인증을 거친 중고 전기차 전문 거래 플랫폼.', false, null, null, null, '판매 차량 등록·진단 후 거래 진행', '배터리 진단 인증 기반 중고 전기차 거래에 강점'),
  ('charzing', '차징', 'auto', 'domestic', 'https://charzing.kr/', '전기차 배터리 성능(SOH)을 방문 진단하는 서비스.', false, null, null, null, '예약 후 방문 진단 이용', '전기차 배터리 성능(SOH) 방문 진단에 특화'),
  ('tirepick', '타이어픽', 'auto', 'domestic', 'https://www.tire-pick.com/', '타이어 가격 비교와 장착점 예약을 연결하는 플랫폼.', false, null, null, null, '가입 후 가격 비교·장착점 예약', '타이어 가격 비교와 장착점 예약 연결에 강점'),
  ('isnara', '장착나라', 'auto', 'domestic', 'https://isnara.co.kr/', '온라인 구매 타이어의 전국 장착점 예약을 중개하는 서비스.', false, null, null, null, '장착점은 제휴 등록, 소비자는 가입 후 예약', '온라인 구매 타이어의 전국 장착점 예약 중개'),
  ('otire', '오타이어', 'auto', 'domestic', 'https://otire.co.kr/', '지역 매장에서 인터넷 가격으로 당일 타이어 장착을 연결하는 서비스.', false, null, null, null, '지역 매장 제휴 등록, 소비자는 예약 이용', '인터넷 가격 당일 타이어 장착 연결에 강점'),
  ('automango', '오토망고', 'auto', 'domestic', 'https://automango.co.kr/', '인제스피디움이 운영하는 자동차용품·튜닝용품 전문 쇼핑몰.', false, null, null, null, '가입 후 바로 구매(자사 운영 쇼핑몰)', '자동차용품·튜닝용품 전문 쇼핑에 강점'),
  ('cazamall', '카자몰', 'auto', 'domestic', 'https://cazamall.co.kr/', '국산·수입차 차종별 튜닝파츠와 자동차용품 전문 쇼핑몰.', false, null, null, null, '가입 후 바로 구매', '국산·수입차 차종별 튜닝파츠 쇼핑에 강점'),
  ('liuparts', '리우파츠', 'auto', 'domestic', 'https://liuparts.com/', '벤츠·BMW·아우디 등 수입차 튜닝 부품 전문 쇼핑몰.', false, null, null, null, '가입 후 바로 구매', '벤츠·BMW·아우디 등 수입차 튜닝 부품에 특화'),
  ('happyscrapcar', '해피폐차', 'auto', 'domestic', 'https://happyscrapcar.com/', '전국 관허 폐차장을 경매로 연결하는 폐차 견적 플랫폼.', false, null, null, null, '차량 정보 등록 후 견적 비교', '관허 폐차장 경매 방식 폐차 견적 비교에 강점'),
  ('carbridge', '카브릿지', 'auto', 'domestic', 'https://car-bridge.co.kr/', '사고차·고장차를 수리 없이 매입 견적내는 서비스.', false, null, null, null, '차량 정보 등록 후 매입 견적 요청', '사고차·고장차를 수리 없이 매입 견적내는 데 특화'),
  ('joinsauto', '조인스오토', 'auto', 'domestic', 'https://joinsauto.co.kr/', '폐차 견적 비교(규제샌드박스 임시허가)를 제공하는 플랫폼.', false, null, null, null, '차량 정보 등록 후 견적 비교', '폐차 견적 비교(규제샌드박스 임시허가)에 강점'),
  ('goodbrother', '착한형오토바이', 'auto', 'domestic', 'https://goodbrother.co.kr/', '중고 오토바이 출장 매입을 전문으로 하는 서비스.', false, null, null, null, '매입 문의 후 출장 방문', '중고 오토바이 출장 매입에 특화'),
  ('evmodu', '모두의충전', 'auto', 'domestic', 'https://evmodu.kr/', '전국 전기차 충전소 정보와 통합결제(모두페이)를 제공하는 신생 스타트업 스칼라데이터의 EV 충전 앱으로, 30억원 규모 시리즈A를 유치했다.', true, null, null, null, '앱 설치·가입 후 충전 이용', '전국 충전소 정보·통합결제(모두페이) 제공에 강점'),
  ('pluglink', '플러그링크', 'auto', 'domestic', 'https://pluglink.kr/', '아파트·오피스텔 등 공동주택에 완속 충전 인프라를 무상 설치·운영하는 앱 기반 전기차 충전 신생 스타트업이다.', true, null, null, null, '공동주택 대상 설치 신청', '공동주택 완속 충전 인프라 무상 설치·운영에 강점'),
  ('octoev', '옥토브', 'auto', 'domestic', 'https://www.octoev.com/', '2022년 설립된 신생 스타트업으로, 레일을 따라 충전기가 이동하며 여러 대를 자동 충전하는 무인 전기차 충전 시스템 ''스카이차저''를 개발한다.', true, null, null, null, '도입 문의 후 설치 협의', '레일 이동형 무인 자동 충전 시스템에 특화'),
  ('autostay', '오토스테이', 'auto', 'domestic', 'https://www.autostay.co.kr/', '월정액 구독으로 전국 매장에서 자동세차를 무제한 이용하는 신생 구독형 세차 서비스로, 최근 세차·전기차 충전 결합 매장으로 확장 중이다.', true, null, null, null, '앱 가입 후 월정액 구독', '월정액 자동세차 무제한 구독에 강점'),
  ('carvazo', '카바조', 'auto', 'domestic', 'https://www.carvazo.com/', '중고차 구매 시 전문 정비사가 동행해 차량 상태를 검수해주는 O2O 서비스로, 2023년 헤이딜러로부터 전략적 투자를 유치한 신생 플랫폼이다.', true, null, null, null, '예약 후 검수 서비스 이용', '중고차 구매 시 정비사 동행 검수에 특화'),
  ('interparkticket', '인터파크 티켓', 'ticket', 'domestic', 'https://tickets.interpark.com', '공연·콘서트·스포츠 등 종합 예매.', false, null, null, null, '공연 등록은 주최사·기획사 제휴 계약 필요', '공연·콘서트·스포츠 종합 예매에 강점'),
  ('yes24ticket', '예스24 공연', 'ticket', 'domestic', 'http://ticket.yes24.com', '공연·뮤지컬 중심 예매.', false, null, null, null, '공연 등록은 주최사·기획사 제휴 계약 필요', '공연·뮤지컬 중심 예매에 강점'),
  ('ticketlink', '티켓링크', 'ticket', 'domestic', 'https://www.ticketlink.co.kr', '공연·스포츠 예매.', false, null, null, null, '공연 등록은 주최사·기획사 제휴 계약 필요', '공연·스포츠 예매에 강점'),
  ('melonticket', '멜론티켓', 'ticket', 'domestic', 'https://ticket.melon.com', '공연·콘서트 예매(음악 중심).', false, null, null, null, '공연 등록은 주최사·기획사 제휴 계약 필요', '콘서트·음악 공연 예매에 강점'),
  ('nol', 'NOL 티켓', 'ticket', 'domestic', 'https://nol.interpark.com/ticket', '콘서트·뮤지컬·전시 예매(구 인터파크티켓).', false, null, null, null, '공연 등록은 주최사·기획사 제휴 계약 필요', '콘서트·뮤지컬·전시 예매에 강점(구 인터파크티켓)'),
  ('ticketbay', '티켓베이', 'ticket', 'domestic', 'https://www.ticketbay.co.kr/', '공연·스포츠 티켓 양도·거래 중고 티켓.', false, null, null, null, '가입 후 티켓 양도 등록', '공연·스포츠 티켓 양도·중고 거래에 강점'),
  ('ticket', '하나티켓', 'ticket', 'domestic', 'https://ticket.hanatour.com/', '하나투어 공연·전시·레저 티켓 예매.', false, null, null, null, '가입 후 예매, 등록은 제휴 문의', '하나투어 공연·전시·레저 티켓 예매에 강점'),
  ('ticket2', '위메프 공연티켓', 'ticket', 'domestic', 'https://ticket.wemakeprice.com/', '뮤지컬·콘서트 할인 예매 서비스.', false, null, null, null, '가입 후 예매, 등록은 제휴 문의', '뮤지컬·콘서트 할인 예매에 강점'),
  ('clipservice', '클립서비스', 'ticket', 'domestic', 'https://www.clipservice.co.kr/', '공연 기획·제작·티켓 유통 예매 플랫폼.', false, null, null, null, '공연 유통은 기획·제작 제휴 문의', '공연 기획·제작·티켓 유통 일괄 처리에 강점'),
  ('playticket', '플레이티켓', 'ticket', 'domestic', 'https://www.playticket.co.kr/', '중소극장 공연 예매 사이트.', false, null, null, null, '공연 등록은 극장·주최사 제휴 문의', '중소극장 공연 예매에 특화'),
  ('nanumticket', '나눔티켓', 'ticket', 'domestic', 'https://www.nanumticket.or.kr/', '공연 잔여석 기부·저가 나눔 플랫폼.', false, null, null, null, '가입 후 이용, 공연 등록은 주최사 제휴', '공연 잔여석 기부·저가 나눔에 특화'),
  ('eventus', '이벤터스', 'ticket', 'domestic', 'https://event-us.kr/', '공연·전시·세미나 행사 신청·티켓 관리.', false, null, null, null, '주최자 가입 후 행사 등록·티켓 발행', '공연·전시·세미나 행사 신청·티켓 관리에 강점'),
  ('kopis', 'KOPIS', 'ticket', 'domestic', 'http://www.kopis.or.kr/', '공연예술 정보·예매처·통계 통합 제공.', false, null, null, null, '정보 조회는 무료, 등록은 공연시설·기획사', '공연예술 정보·예매처·통계 통합 조회에 강점'),
  ('sac', '예술의전당', 'ticket', 'domestic', 'https://www.sac.or.kr', '종합 예술기관 공연·전시 온라인 예매.', false, null, null, null, '가입 후 예매', '예술의전당 공연·전시 온라인 예매에 강점'),
  ('sejongpac', '세종문화회관', 'ticket', 'domestic', 'https://www.sejongpac.or.kr', '서울시 문화예술기관 공연·전시 예매.', false, null, null, null, '가입 후 예매', '세종문화회관 공연·전시 예매에 강점'),
  ('festivallife', '페스티벌라이프', 'ticket', 'domestic', 'https://festivallife.kr', '국내외 페스티벌 라인업·티켓 일정 안내.', false, null, null, null, '가입 후 정보 조회·예매 연결', '국내외 페스티벌 라인업·티켓 일정 안내에 강점'),
  ('timeticket', '타임티켓', 'ticket', 'domestic', 'https://timeticket.co.kr/', '연극·공연 등 문화 티켓을 예매하는 플랫폼.', false, null, null, null, '공연 등록은 극장·주최사 제휴 문의', '연극·소극장 등 문화 티켓 예매에 강점'),
  ('dongnemudae', '동네무대', 'ticket', 'domestic', 'https://dongnemudae.com/', '전국 소극장 연극·뮤지컬·콘서트 일정 검색·예매.', false, null, null, null, '극단·주최자가 공연 등록 후 예매 위탁', '소극장 연극·뮤지컬 일정 탐색·예매에 강점'),
  ('enticket', '엔티켓', 'ticket', 'domestic', 'http://enticket.com/', '인천 지역 공연 티켓 예매·발권 전문 서비스.', false, null, null, null, '지역 주최자 공연 발권·예매 대행 문의', '인천 지역 공연 예매·발권에 특화'),
  ('finestage', '파인스테이지', 'ticket', 'domestic', 'https://finestage.co.kr/', '클래식 음악 공연 전문 예매 사이트.', false, null, null, null, '클래식 주최자가 공연 예매 위탁 등록', '클래식 공연 전문 예매·정보 탐색에 강점'),
  ('ticketguide', '티켓가이드', 'ticket', 'overseas', 'https://www.ticketguide.co.kr/', '유럽축구 등 해외 스포츠 직관 티켓 예매 서비스.', false, null, null, null, null, '유럽축구 등 해외 스포츠 직관 티켓에 특화'),
  ('thebestplay', '연극열전', 'ticket', 'domestic', 'https://www.thebestplay.co.kr/', '연극 공연 정보·예매를 제공하는 사이트.', false, null, null, null, '극단·주최자가 연극 예매 등록', '연극 공연 정보·예매 제공에 강점'),
  ('petfriends', '펫프렌즈', 'pet', 'domestic', 'https://www.pet-friends.co.kr/', '사료·간식·용품 반려동물 종합 커머스·빠른배송.', false, null, null, null, null, '사료·간식·용품 종합 구매·빠른배송에 강점'),
  ('aboutpet', '어바웃펫', 'pet', 'domestic', 'https://www.aboutpet.co.kr/', 'GS리테일 계열 반려동물 종합 쇼핑 커머스.', false, null, null, null, null, '반려동물 종합 쇼핑, GS리테일 인프라 연계'),
  ('biteme', '바잇미', 'pet', 'domestic', 'https://www.biteme.co.kr/', '자체 제작 강아지 용품·간식·의류 브랜드몰.', false, null, null, null, null, '자체 제작 강아지 용품·간식·의류에 강점'),
  ('dogpre', '강아지대통령', 'pet', 'domestic', 'https://dogpre.com/', '강아지 사료·간식·용품 전문 커머스.', false, null, null, null, null, '강아지 사료·간식·용품 전문 구매에 강점'),
  ('dogpang', '도그팡', 'pet', 'domestic', 'https://www.dogpang.com/', '강아지 용품·사료 전문 쇼핑몰.', false, null, null, null, null, '강아지 용품·사료 전문 쇼핑에 강점'),
  ('catpang', '캣팡', 'pet', 'domestic', 'https://www.catpang.com/', '고양이 용품·사료 전문 반려묘 커머스.', false, null, null, null, null, '고양이 용품·사료 전문 구매에 강점'),
  ('catskingdom', '고양이왕국', 'pet', 'domestic', 'https://www.catskingdom.co.kr/', '고양이 용품 전문 온라인 쇼핑몰.', false, null, null, null, null, '고양이 용품 전문 온라인 구매에 강점'),
  ('maxcat', '맥스캣', 'pet', 'domestic', 'https://www.maxcat.co.kr/', '고양이 용품 전문 쇼핑몰.', false, null, null, null, null, '고양이 용품 전문 쇼핑에 강점'),
  ('drfelis', '닥터펠리스', 'pet', 'domestic', 'https://drfelis.com/', '수의사 기획 고양이 용품 D2C 브랜드몰.', false, null, null, null, null, '수의사 기획 고양이 용품 D2C에 강점'),
  ('petbazaar', '펫바자', 'pet', 'domestic', 'https://petbazaar.kr/', '반려동물 용품 아울렛형 커머스.', false, null, null, null, null, '반려동물 용품 아울렛형 저가 구매에 강점'),
  ('petmily', '펫밀리', 'pet', 'domestic', 'https://petmily.shop/', '반려동물 영양제·건강용품 쇼핑몰.', false, null, null, null, null, '반려동물 영양제·건강용품 구매에 강점'),
  ('petmart', '펫마트', 'pet', 'domestic', 'https://petmart.co.kr/', '사료·간식·용품 반려동물 종합몰.', false, null, null, null, null, '사료·간식·용품 종합 구매에 강점'),
  ('harimpetfood', '하림펫푸드', 'pet', 'domestic', 'https://harimpetfood.com/', '휴먼그레이드 사료·간식 제조 D2C몰.', false, null, null, null, null, '휴먼그레이드 사료·간식 제조 직판에 강점'),
  ('petfresh', '펫프레시', 'pet', 'domestic', 'https://www.petfresh.co.kr/', '사료 정기구독·AI 영양 상담 펫푸드 서비스.', false, null, null, null, '가입 후 정기구독 신청·영양 상담 이용', '사료 정기구독·맞춤 영양 상담에 강점'),
  ('dogmalion', '도그말리온', 'pet', 'domestic', 'https://dogmalion.com/', '무첨가 강아지 수제간식 D2C 브랜드.', false, null, null, null, null, '무첨가 강아지 수제간식 D2C에 강점'),
  ('petoi', '페토이', 'pet', 'domestic', 'https://petoi.co.kr/', 'IoT 자동급식기 등 펫테크 브랜드몰.', false, null, null, null, null, 'IoT 자동급식기 등 펫테크 제품에 강점'),
  ('petrasyu', '펫트라슈', 'pet', 'domestic', 'https://petrasyu.com/', '동물병원 진료비 조회·후기·예약 앱.', false, null, null, null, '동물병원이 병원 정보 등록·예약 연동', '동물병원 진료비 조회·후기·예약에 강점'),
  ('intopet', '인투펫', 'pet', 'domestic', 'https://intopet.co.kr/', '동물병원 접종·복약 관리·모바일 예약 앱.', false, null, null, null, '동물병원 제휴 등록 후 예약 연동', '접종·복약 관리와 병원 모바일 예약에 강점'),
  ('todaypaw', '오늘댕냥', 'pet', 'domestic', 'https://todaypaw.com/', '동물병원 진료비 비교·후기·예약 플랫폼.', false, null, null, null, '동물병원이 병원 등록·예약 연동', '동물병원 진료비 비교·후기·예약에 강점'),
  ('petdoc', '펫닥', 'pet', 'domestic', 'https://www.petdoc.co.kr/', '수의사 실시간 상담·케어 기록 앱.', false, null, null, null, '수의사·병원 제휴 등록 후 상담 제공', '수의사 실시간 상담·케어 기록에 강점'),
  ('ipet', '아이펫', 'pet', 'domestic', 'https://ipet.co.kr/', '반려동물 보험 비교·청구 관리 플랫폼.', false, null, null, null, null, '반려동물 보험 비교·청구 관리에 강점'),
  ('petforest', '펫포레스트', 'pet', 'domestic', 'https://petforest.co.kr/', '반려동물 장례·추모 공간 예약.', false, null, null, null, '장례업체가 시설 등록 후 예약 중개', '반려동물 장례·추모 공간 예약에 강점'),
  ('petnight', '펫나잇', 'pet', 'domestic', 'https://www.petnight.co.kr/', '전국 반려동물 장례식장 비교·예약.', false, null, null, null, '장례식장이 시설 등록·예약 연동', '전국 반려동물 장례식장 비교·예약에 강점'),
  ('banjjakpet', '반짝', 'pet', 'domestic', 'https://banjjakpet.com/', '반려동물 미용실 검색·포트폴리오·예약.', false, null, null, null, '미용실이 포트폴리오 등록 후 예약 연동', '반려동물 미용실 검색·포트폴리오·예약에 강점'),
  ('enterdog', '엔터독', 'pet', 'domestic', 'https://www.enterdog.com/', '애견동반 숙소·호텔·매장 예약 중개.', false, null, null, null, '숙소·매장이 업체 등록 후 예약 중개', '애견동반 숙소·호텔·매장 예약 중개에 강점'),
  ('hoteldogs', '호텔독스', 'pet', 'domestic', 'https://hoteldogs.co.kr/', 'CCTV·24시간 강아지 호텔·유치원.', false, null, null, null, '호텔·유치원 업체 등록 후 예약 연동', 'CCTV·24시간 강아지 호텔·유치원에 강점'),
  ('banlife', '반려생활', 'pet', 'domestic', 'https://www.ban-life.com/', '애견동반 숙소·여행지·맛집 예약 앱.', false, null, null, null, '숙소·매장 업체 등록 후 예약 연동', '애견동반 여행·숙소·맛집 예약에 강점'),
  ('pawinhand', '포인핸드', 'pet', 'domestic', 'https://pawinhand.kr/', '보호소 유기동물 입양·실종동물 찾기.', false, null, null, null, '보호소·기관이 동물 정보 등록', '보호소 유기동물 입양·실종동물 찾기에 강점'),
  ('petner', '펫트너', 'pet', 'domestic', 'https://www.petner.kr/', '방문 펫시터·방문 미용 예약 플랫폼.', false, null, null, null, '펫시터·미용사 프로필 등록 후 매칭', '방문 펫시터·방문 미용 예약에 강점'),
  ('woofoo', '우푸', 'pet', 'domestic', 'https://woofoo.kr/', '도그워커·방문 펫시터·캣시터 매칭.', false, null, null, null, '돌봄 제공자 프로필 등록 후 매칭', '도그워커·방문 펫시터·캣시터 매칭에 강점'),
  ('beforpet', '비포펫', 'pet', 'domestic', 'https://beforpet.com/', '반려견 산책 대행 서비스.', false, null, null, null, '사업자·펫시터 등록 후 산책 대행 매칭', '반려견 산책 대행 온디맨드 매칭에 특화'),
  ('9dogcat', '구독캣', 'pet', 'domestic', 'https://9dogcat.com/', '고양이 모래·용품을 정기구독 방식으로 배송하는 쇼핑몰이다.', false, null, null, null, '사업자등록·통신판매업 신고 후 이용', '고양이 모래·용품 정기구독 배송에 강점'),
  ('dogmeal', '도그밀', 'pet', 'domestic', 'https://dogmeal.shop/', '반려견 맞춤 식단을 정기배송하는 애견 식단 구독 서비스다.', false, null, null, null, '가입 후 반려견 정보 입력·구독 신청', '반려견 맞춤 식단 정기배송에 특화'),
  ('petbox', '펫박스', 'pet', 'domestic', 'https://www.petbox.kr/', '사료·수제간식 등 반려동물 용품을 판매하는 쇼핑몰이다.', false, null, null, null, '사업자등록·통신판매업 신고 후 이용', '사료·수제간식 등 반려용품 온라인 판매'),
  ('breeeeeding', '브리딩', 'pet', 'domestic', 'https://www.breeeeeding.com/', '강아지 훈련·교육 콘텐츠와 프로그램을 제공하는 서비스다.', false, null, null, null, '가입 후 훈련 콘텐츠·프로그램 이용', '강아지 훈련·행동교육 콘텐츠 제공에 강점'),
  ('petfins', '펫핀스', 'pet', 'domestic', 'https://petfins.net/', '여러 보험사의 펫보험 상품을 비교·가입하는 플랫폼이다.', false, null, null, null, '가입 후 반려동물 정보 입력·보험 비교', '여러 보험사 펫보험 비교·가입에 특화'),
  ('petme', '펫미', 'pet', 'domestic', 'https://www.petme.kr/', '미용·호텔 등 반려동물 서비스와 전문가를 연결하는 플랫폼이다.', false, null, null, null, '업체·전문가 등록 후 서비스 노출·예약', '미용·호텔 등 반려 서비스 전문가 매칭에 강점'),
  ('goodbyeangel', '굿바이엔젤', 'pet', 'domestic', 'https://www.goodbyeangel.co.kr/', '반려동물 장례·화장을 예약하고 24시간 상담을 제공한다.', false, null, null, null, '가입 후 장례 상담·예약 이용', '반려동물 장례 예약·24시간 상담에 특화'),
  ('21gram', '21그램', 'pet', 'domestic', 'https://21gram.co.kr/', '반려동물 장례 준비물부터 화장 절차까지 지원하는 장례식장이다.', false, null, null, null, '가입 후 장례 절차 상담·예약', '반려동물 장례식장 운영·화장 절차 전반 지원'),
  ('petvip', '펫VIP', 'pet', 'domestic', 'https://www.petvip.co.kr/', '반려동물 출장·방문 미용과 목욕·돌봄을 제공하는 서비스다.', false, null, null, null, '가입 후 출장 미용·돌봄 예약', '출장·방문 반려동물 미용·목욕·돌봄에 강점'),
  ('charactergrooming', '캐릭터그루밍', 'pet', 'domestic', 'https://charactergrooming.imweb.me/', '캐릭터·창작 스타일의 애견 미용을 예약하는 니치 그루밍샵이다.', false, null, null, null, '가입 후 예약, 니치 그루밍샵', '캐릭터·창작 스타일 애견 미용에 특화'),
  ('othermars', '아더마스', 'pet', 'domestic', 'https://othermars.shop/', '유기농 무첨가 자연식 펫푸드를 자사몰 중심으로 파는 D2C 브랜드(올데이올가닉)로 2023년 이후 성장한 신생.', true, null, null, null, '가입 후 바로 구매(자사몰형)', '유기농 무첨가 자연식 펫푸드 D2C 브랜드'),
  ('momq', '맘큐', 'kids', 'domestic', 'https://www.momq.co.kr/', '유한킴벌리 육아·출산용품 커머스·멤버십 직영몰.', false, null, null, null, '가입 후 바로 구매·멤버십 이용', '유한킴벌리 육아·출산용품 직영몰·멤버십에 강점'),
  ('kizmom', '키즈맘쇼핑', 'kids', 'domestic', 'https://www.kizmom.kr/', '수입 유아용품·완구 전문 온라인 쇼핑몰.', false, null, null, null, '가입 후 바로 구매', '수입 유아용품·완구 전문 온라인 판매'),
  ('inuri', '아이누리', 'kids', 'domestic', 'http://www.i-nuri.com/', '유아 보육·교육용품 커머스 사이트.', false, null, null, null, '가입 후 바로 구매', '유아 보육·교육용품 커머스에 특화'),
  ('mamigo', '마미고', 'kids', 'domestic', 'https://www.mamigo.co.kr/', '프리미엄 유아용품 온라인 육아 쇼핑몰.', false, null, null, null, '가입 후 바로 구매', '프리미엄 유아용품 온라인 판매에 강점'),
  ('agabang', '아가방몰', 'kids', 'domestic', 'https://www.agabang.co.kr/', '아가방 유아복·육아용품 공식 커머스몰.', false, null, null, null, '가입 후 바로 구매(공식몰)', '아가방 유아복·육아용품 공식 커머스'),
  ('momnuri', '맘누리', 'kids', 'domestic', 'https://www.momnuri.com/', '임부복·출산 준비물 임신·출산 커머스.', false, null, null, null, '가입 후 바로 구매', '임부복·출산 준비물 임신·출산 커머스에 특화'),
  ('ibaby', '아이베이비', 'kids', 'domestic', 'https://www.i-baby.co.kr/', '유아용품 안전거래 중고거래 플랫폼.', false, null, null, null, '가입 후 상품 등록·거래(중고 개인간)', '유아용품 안전거래 중고 플랫폼에 강점'),
  ('homelearn', '아이스크림 홈런', 'kids', 'domestic', 'https://www.home-learn.co.kr/', '초등 AI 온라인 학습 플랫폼.', false, null, null, null, '가입·구독 신청 후 학습 이용', '초등 대상 AI 온라인 학습에 특화'),
  ('smartall', '웅진스마트올', 'kids', 'domestic', 'https://smartall.wjthinkbig.com/', '웅진씽크빅 유아~중등 AI 스마트 학습.', false, null, null, null, '가입·구독 신청 후 학습 이용', '유아~중등 AI 스마트 학습 커버리지에 강점'),
  ('nurinori', '누리놀이', 'kids', 'domestic', 'https://www.nurinori.com/', '유아 교육·놀이 콘텐츠·교구 플랫폼.', false, null, null, null, '가입 후 콘텐츠·교구 이용', '유아 교육·놀이 콘텐츠·교구 제공에 특화'),
  ('sssd', '솜씨당', 'kids', 'domestic', 'https://www.sssd.co.kr/', '원데이클래스·체험 예약 취미 플랫폼(키즈 포함).', false, null, null, null, '클래스 운영자 등록 후 강좌 개설·예약', '원데이클래스·체험 예약 중개에 강점'),
  ('umclass', '움클래스', 'kids', 'domestic', 'https://www.umclass.com/', '체험권·원데이클래스 중개 예약 플랫폼.', false, null, null, null, '클래스 운영자 등록 후 강좌 개설·예약', '체험권·원데이클래스 중개 예약에 특화'),
  ('kidsday', '키즈데이', 'kids', 'domestic', 'https://kidsday.kr/', '유아·초등 체험학습·키즈클래스 예약.', false, null, null, null, '가입 후 클래스 검색·예약', '유아·초등 체험학습·키즈클래스 예약에 강점'),
  ('nolbal', '놀이의발견', 'kids', 'domestic', 'https://nolbal.com/', '가족·아이 여가 체험시설 검색·예약 플랫폼.', false, null, null, null, '시설 등록 후 노출·예약 접수', '가족·아이 여가 체험시설 검색·예약에 특화'),
  ('ipoomgo', '아이품고', 'kids', 'domestic', 'https://www.ipoomgo.co.kr/', '산후조리원 온라인 투어·비교·예약.', false, null, null, null, '가입 후 조리원 비교·투어·예약', '산후조리원 온라인 투어·비교·예약에 강점'),
  ('momsmanager', '맘스매니저', 'kids', 'domestic', 'https://www.momsmanager.co.kr/', '산후관리사·마사지 전문가 예약 매칭.', false, null, null, null, '관리사 등록·가입 후 예약 매칭', '산후관리사·마사지 전문가 예약 매칭에 특화'),
  ('doctormam', '닥터맘', 'kids', 'domestic', 'https://doctormam.com/', '산모도우미·산후관리사 매칭 케어 플랫폼.', false, null, null, null, '관리사 등록·가입 후 케어 매칭', '산모도우미·산후관리사 매칭에 강점'),
  ('imilkbook', '밀크북', 'kids', 'domestic', 'https://imilkbook.com/', '어린이 도서·전집 판매·구독 서비스.', false, null, null, null, '가입 후 도서 구매·구독 신청', '어린이 도서·전집 판매·구독에 특화'),
  ('saybooks', '세이북', 'kids', 'domestic', 'https://saybooks.net/', '어린이·가정 도서 정기구독 서비스.', false, null, null, null, '가입 후 구독 신청', '어린이·가정 도서 정기구독에 강점'),
  ('gilbutkid', '길벗어린이', 'kids', 'domestic', 'https://www.gilbutkid.co.kr/', '그림책·아동도서 출판·판매 채널.', false, null, null, null, '가입 후 바로 구매', '그림책·아동도서 출판·판매 채널'),
  ('littlebaby', '리틀베이비', 'kids', 'domestic', 'https://littlebaby.co.kr/', '수입 아기용품 대여·판매 렌탈 커머스.', false, null, null, null, '가입 후 대여·구매 신청', '수입 아기용품 대여·판매 렌탈에 특화'),
  ('babynoriter', '베이비노리터', 'kids', 'domestic', 'https://babynoriter.com/', '유아용품·장난감 대여 전문 플랫폼.', false, null, null, null, '가입 후 대여 신청', '유아용품·장난감 대여 전문에 강점'),
  ('toyuncle', '장난감아저씨', 'kids', 'domestic', 'https://toyuncle.co.kr/', '유아용품·장난감 방문 대여 렌탈 서비스.', false, null, null, null, '가입 후 방문 대여 신청', '유아용품·장난감 방문 대여에 특화'),
  ('ozkiz', '오즈키즈', 'kids', 'domestic', 'https://ozkiz.com/', '3~10세 아동복·키즈신발 브랜드몰.', false, null, null, null, '자사 브랜드몰(입점 아님)·회원가입 후 구매', '3~10세 아동복·키즈신발 자사 브랜드 상품에 강점'),
  ('nonikids', '노니키즈', 'kids', 'domestic', 'https://nonikids.kr/', '신생아~초등 종합 아동복 쇼핑몰.', false, null, null, null, '자사 쇼핑몰(입점 아님)·회원가입 후 구매', '신생아~초등 종합 아동복 구성에 강점'),
  ('bebezone', '베베존', 'kids', 'domestic', 'http://www.bebezone.com/', '임산부·출산용품 전문 커머스몰.', false, null, null, null, '자사 커머스몰(입점 아님)·회원가입 후 구매', '임산부·출산용품 전문 구성에 강점'),
  ('kidsnote', '키즈노트', 'kids', 'domestic', 'https://www.kidsnote.com/', '어린이집·유치원 알림장·원비 결제 플랫폼.', false, null, null, null, '어린이집·유치원 기관 단위 가입 후 이용', '원-학부모 알림장·원비 결제 통합 운영에 강점'),
  ('pinkids', '핀키즈', 'kids', 'domestic', 'https://pinkids.kr/', '수유실·노키즈존 여부 등 아이 동반 장소를 지도로 찾는 서비스다.', false, null, null, null, '가입 후 바로 이용(대개 무료)', '수유실·노키즈존 등 아이 동반 장소 탐색에 강점'),
  ('dorbom', '돌봄플러스', 'kids', 'domestic', 'http://dorbom.com/', '베이비시터·아이돌봄을 매칭하는 돌봄 플랫폼이다.', false, null, null, null, '부모·시터 가입·프로필 등록 후 매칭', '베이비시터·아이돌봄 매칭에 강점'),
  ('yummimeal', '얌이밀', 'kids', 'domestic', 'https://www.yummimeal.com/', '단계별 이유식·아기반찬을 정기배송하는 구독 서비스다.', false, null, null, null, '가입 후 구독 신청(소비자)', '단계별 이유식·아기반찬 정기배송에 강점'),
  ('planacampus', '플랜에이캠퍼스', 'kids', 'domestic', 'https://www.planacampus.com/', '검증된 교사가 방문하는 유아 미술 교육 서비스다.', false, null, null, null, '학부모 신청 후 이용·교사는 검증 후 활동', '검증 교사 방문형 유아 미술 교육에 강점'),
  ('gguge', '꾸그', 'kids', 'domestic', 'https://www.gguge.com/', '아동 대상 라이브 온라인 수업을 중개하는 플랫폼이다.', false, null, null, null, '강사 등록·심사 후 수업 개설, 학부모 수강신청', '아동 라이브 온라인 수업 개설·수강 중개에 강점'),
  ('raraclass', '라라클래스', 'kids', 'domestic', 'https://www.raraclass.com/', '미취학·초등 대상 체험·도슨트 프로그램을 운영한다.', false, null, null, null, '회원가입 후 프로그램 신청', '미취학·초등 체험·도슨트 프로그램 운영에 강점'),
  ('kidsning', '키즈닝', 'kids', 'domestic', 'https://www.kidsning.co.kr/', '육아맘 셀럽마켓·아동 패션·육아템을 모은 육아 라이프스타일 쇼핑앱(밀크코퍼레이션)으로 최근 떠오른 신흥.', true, null, null, null, '소비자 앱 가입 후 이용·셀러 입점은 별도', '육아맘 셀럽마켓·아동패션·육아템 큐레이션에 강점'),
  ('marpple', '마플', 'print', 'domestic', 'https://www.marpple.com/kr', '커스텀 굿즈를 1개부터 주문 제작하는 POD 플랫폼.', false, null, null, null, '가입 후 디자인 업로드·1개부터 주문', '1개부터 커스텀 굿즈 POD 주문 제작에 강점'),
  ('marpple2', '마플샵', 'print', 'domestic', 'https://marpple.shop/kr', '디자인 등록만으로 무재고 굿즈를 제작·판매하는 크리에이터 커머스.', false, null, null, null, '가입 후 디자인 등록으로 무재고 셀러 시작', '무재고 크리에이터 굿즈 제작·판매에 강점'),
  ('ohprint', '오프린트미', 'print', 'domestic', 'https://www.ohprint.me/', '명함·스티커·현수막·커스텀 의류를 소량 제작하는 인쇄 서비스.', false, null, null, null, '가입 후 디자인 업로드·소량 주문', '명함·스티커·현수막 등 소량 인쇄에 강점'),
  ('redprinting', '레드프린팅', 'print', 'domestic', 'https://www.redprinting.co.kr/ko', '스티커·명함·어패럴부터 상업 인쇄까지 온라인 인쇄소.', false, null, null, null, '가입 후 디자인 업로드·주문', '스티커·명함·어패럴·상업 인쇄 폭넓은 품목에 강점'),
  ('snaps', '스냅스', 'print', 'domestic', 'https://www.snaps.com/', '포토북·사진인화·액자·달력 등 사진 상품 제작.', false, null, null, null, '앱·웹 가입 후 사진 업로드·주문', '포토북·사진인화·액자 등 사진 상품 제작에 강점'),
  ('zzixx', '찍스', 'print', 'domestic', 'https://www.zzixx.com/', '사진인화·포토북·포토상품 주문 제작.', false, null, null, null, '가입 후 사진 업로드·주문', '사진인화·포토북·포토상품 주문 제작에 강점'),
  ('publog', '퍼블로그', 'print', 'domestic', 'https://www.publog.co.kr/', '포토북·포토카드·아크릴 굿즈 소량 제작 플랫폼.', false, null, null, null, '가입 후 디자인 업로드·소량 주문', '포토북·포토카드·아크릴 굿즈 소량 제작에 강점'),
  ('bizhows', '비즈하우스', 'print', 'domestic', 'https://www.bizhows.com/ko', '현수막·명함·판촉물을 온라인 툴로 1장부터 제작.', false, null, null, null, '가입 후 온라인 편집툴로 1장부터 주문', '온라인 편집툴로 현수막·판촉물 소량 제작에 강점'),
  ('withgoods', '위드굿즈', 'print', 'domestic', 'https://withgoods.net/', '주문·재고·CS 대행 아트굿즈 마켓플레이스.', false, null, null, null, '작가 입점 신청·심사 후 굿즈 등록', '주문·재고·CS 대행형 아트굿즈 판매에 강점'),
  ('shopfanpick', '샵팬픽', 'print', 'domestic', 'https://www.shopfanpick.com/', '크리에이터 IP 커스텀 굿즈 기획·제작·유통 팬덤 플랫폼.', false, null, null, null, '크리에이터 입점 후 굿즈 기획·판매', '크리에이터 IP 커스텀 굿즈 기획·유통에 강점'),
  ('designersbay', '디자이너스베이', 'print', 'domestic', 'https://www.designersbay.com/', '티셔츠·에코백 커스텀 굿즈 1장부터 제작.', false, null, null, null, '가입 후 디자인 업로드·1장부터 주문', '티셔츠·에코백 커스텀 소량 제작에 강점'),
  ('allthatprinting', '올댓프린팅', 'print', 'domestic', 'https://allthatprinting.co.kr/', '아크릴·우드 등 창작자용 인쇄 굿즈 소량·B2B 제작.', false, null, null, null, '가입 후 주문·B2B는 견적 문의', '창작자용 아크릴·우드 굿즈 소량·B2B 제작에 강점'),
  ('itension', '아이텐션', 'print', 'domestic', 'https://itension.co.kr/', '아크릴 키링·스탠드·등신대 굿즈 제작.', false, null, null, null, '가입 후 디자인 업로드·주문', '아크릴 키링·스탠드·등신대 굿즈 제작에 강점'),
  ('hanalldnp', '한올디앤피', 'print', 'domestic', 'https://hanalldnp.co.kr/', '아크릴 스탠드·키링을 레이저 커팅·UV 인쇄로 소량 제작.', false, null, null, null, '가입 후 디자인 업로드·소량 주문', '레이저 커팅·UV 인쇄 아크릴 굿즈 소량 제작에 강점'),
  ('hueandgo', '휴앤고', 'print', 'domestic', 'https://hueandgo.com/', '아크릴 키링·마우스패드 등 커스텀 굿즈 제작.', false, null, null, null, '가입 후 디자인 업로드·주문', '아크릴 키링·마우스패드 등 커스텀 굿즈 제작에 강점'),
  ('koaladesign', '코알라디자인', 'print', 'domestic', 'https://koaladesign.co.kr/', '아크릴 키링·모빌·DIY 키트 굿즈 제작.', false, null, null, null, '가입 후 디자인 업로드·주문', '아크릴 키링·모빌·DIY 키트 굿즈 제작에 강점'),
  ('customland', '커스텀랜드', 'print', 'domestic', 'https://www.customland.kr/', '공장 직영 커스텀 굿즈 1개~대량 제작.', false, null, null, null, '가입 후 주문·대량은 견적 문의', '공장 직영으로 1개~대량 커스텀 굿즈 제작에 강점'),
  ('dpl', '디플샵', 'print', 'domestic', 'https://dpl.shop/', '셀러·제작사 연결 굿즈 제작·배송 자동화 B2B.', false, null, null, null, '셀러 가입 후 제작사 연동·주문 자동화', '굿즈 제작·배송 자동화로 무재고 셀러 운영에 강점'),
  ('qrim', '큐림', 'print', 'domestic', 'https://qrim.co.kr/', '단체·커스텀 티셔츠 주문 제작 어패럴 인쇄.', false, null, null, null, '가입 후 디자인 업로드·단체 주문', '단체·커스텀 티셔츠 주문 제작에 강점'),
  ('customzone', '커스텀존', 'print', 'domestic', 'https://www.customzone.co.kr/', '프린팅 티셔츠 커스텀 제작 사이트.', false, null, null, null, '가입 후 디자인 업로드·주문', '프린팅 티셔츠 커스텀 제작에 강점'),
  ('stickerz', '스티커즈', 'print', 'domestic', 'https://stickerz.co.kr/', '스티커·포토카드 1장부터 당일 출고 제작.', false, null, null, null, '가입 후 디자인 업로드·1장부터 주문', '스티커·포토카드 1장부터 당일 출고 제작에 강점'),
  ('printingting', '프린팅팅', 'print', 'domestic', 'https://printingting.com/', '굿즈·명함·포토카드·스티커 소량 제작 인쇄.', false, null, null, null, '가입 후 디자인 업로드·소량 주문', '굿즈·명함·포토카드·스티커 소량 제작에 강점'),
  ('wowpress', '와우프레스', 'print', 'domestic', 'https://wowpress.co.kr/', '명함·스티커·전단 인쇄·후가공·배송 디지털 인쇄.', false, null, null, null, '가입 후 디자인 업로드·주문', '명함·스티커·전단 인쇄·후가공·배송 일괄에 강점'),
  ('swadpia', '성원애드피아', 'print', 'domestic', 'https://www.swadpia.co.kr/', '명함·전단·스티커·책자 종합 온라인 인쇄.', false, null, null, null, '가입 후 디자인 업로드·주문', '명함·전단·스티커·책자 종합 온라인 인쇄에 강점'),
  ('dtpia', '디티피아', 'print', 'domestic', 'https://dtpia.co.kr/', '명함·굿즈·포토카드 빠른 소량 인쇄.', false, null, null, null, '가입 후 온라인 주문·결제(사업자 불필요)', '명함·굿즈·포토카드 소량 인쇄에 강점'),
  ('printingkorea', '인쇄코리아', 'print', 'domestic', 'https://printingkorea.net/', '명함·스티커·전단·현수막·라벨 소량 주문 제작.', false, null, null, null, '가입 후 온라인 주문·결제', '명함·전단·현수막 등 종합 인쇄물 소량 주문에 강점'),
  ('ecard21', '명함천국', 'print', 'domestic', 'https://www.ecard21.co.kr/', '명함·스티커·전단·포토카드 인쇄 전문.', false, null, null, null, '가입 후 온라인 주문·결제', '명함 인쇄 전문·소량 제작에 강점'),
  ('inswaehada', '인쇄하다', 'print', 'domestic', 'https://www.inswaehada.com/', '배너·현수막 실사출력과 명함·전단 인쇄.', false, null, null, null, '가입 후 온라인 주문·결제', '실사출력과 명함·전단 인쇄 통합 주문에 강점'),
  ('nmk', '뉴마커스', 'print', 'domestic', 'https://www.n-mk.net/', '현수막·배너·에어간판 실사출력 홍보물 제작.', false, null, null, null, '가입 후 온라인 주문·결제', '현수막·배너·에어간판 실사출력 홍보물에 강점'),
  ('printing24', '인쇄24', 'print', 'domestic', 'https://printing24.co.kr/', '현수막·미니배너·롤스크린 실사출력 제작.', false, null, null, null, '가입 후 온라인 주문·결제', '현수막·미니배너·롤스크린 실사출력에 강점'),
  ('label', '아이라벨', 'print', 'domestic', 'https://www.label.kr/', '스티커·방수·바코드 라벨 주문 제작 전문.', false, null, null, null, '가입 후 온라인 주문·결제', '방수·바코드 라벨 주문 제작에 강점'),
  ('labelpack', '라벨팩', 'print', 'domestic', 'https://www.labelpack.co.kr/', '라벨·스티커·패키지 맞춤 제작 쇼핑몰.', false, null, null, null, '가입 후 온라인 주문·결제', '라벨·스티커·패키지 맞춤 제작에 강점'),
  ('juagift', '주아기프트', 'print', 'domestic', 'https://juagift.com/', '판촉물·기념품에 로고 인쇄·각인 주문 제작.', false, null, null, null, '가입 후 온라인 주문·견적 요청', '로고 인쇄·각인 판촉물·기념품 제작에 강점'),
  ('3dprocess', '3D프로', 'print', 'domestic', 'https://3dprocess.co.kr/', '3D프린팅 출력 대행·시제품 주문 제작.', false, null, null, null, '가입 후 도면 업로드·견적 주문', '3D프린팅 출력 대행·시제품 소량 제작에 강점'),
  ('stellamove', '스텔라무브', 'print', 'domestic', 'https://www.stellamove.com/', 'FDM·SLA 3D프린팅 시제품·조형물 제작.', false, null, null, null, '가입 후 도면 업로드·견적 주문', 'FDM·SLA 3D프린팅 시제품·조형물 제작에 강점'),
  ('creallo', '크렐로', 'print', 'domestic', 'https://creallo.com/', '3D프린팅·CNC·사출 맞춤 부품 온라인 제조.', false, null, null, null, '가입 후 도면 업로드·견적 주문', '3D프린팅·CNC·사출 맞춤 부품 온라인 제조에 강점'),
  ('inupt', '이넙트', 'print', 'domestic', 'https://inupt.io/', 'IP·캐릭터 굿즈 소량 제작을 쉽게 해주는 커스텀 굿즈 제작 플랫폼으로 새로 떠오른 신생 서비스.', true, null, null, null, '가입 후 굿즈 제작 의뢰', 'IP·캐릭터 커스텀 굿즈 소량 제작에 강점'),
  ('poclanos', '포크라노스', 'assets', 'domestic', 'https://poclanos.com/', '인디 뮤지션 음원·음반 국내외 배급 유통사.', false, null, null, null, '아티스트 신청·심사 후 유통 계약', '인디 뮤지션 음원 국내외 배급에 강점'),
  ('danalenter', '다날엔터테인먼트', 'assets', 'domestic', 'https://www.danalenter.co.kr/', '음원 국내외 스트리밍·다운로드 유통사.', false, null, null, null, '유통 계약 후 음원 등록', '음원 국내외 스트리밍·다운로드 유통에 강점'),
  ('bugscorp', '벅스 뮤직유통', 'assets', 'domestic', 'https://www.bugscorp.co.kr/', '아티스트·기획사 음원 B2B 유통 사업.', false, null, null, null, '유통 계약 후 음원 등록', '기획사·아티스트 음원 B2B 유통에 강점'),
  ('spaceoddity', '스페이스오디티', 'assets', 'domestic', 'https://www.spaceoddity.me/', '아티스트 음원 기획·유통 뮤직 컴퍼니.', false, null, null, null, '아티스트 협의·계약 후 진행', '음원 기획과 유통을 결합한 지원에 강점'),
  ('dittomusic', '디토뮤직', 'assets', 'overseas', 'https://dittomusic.com/', '150여 플랫폼 셀프 음원 배급 글로벌 서비스.', false, null, null, null, '가입·구독 후 셀프 음원 배급', '150여 플랫폼 셀프 음원 배급에 강점'),
  ('sellbuymusic', '셀바이뮤직', 'assets', 'domestic', 'https://www.sellbuymusic.com/', '저작권 BGM 음원 판매 오픈마켓.', false, null, null, null, '작곡가 가입·심사 후 음원 등록', '저작권 BGM 음원 판매·구매에 강점'),
  ('crowdpic', '크라우드픽', 'assets', 'domestic', 'https://www.crowdpic.net/', '사진·일러스트 작가 등록 상업용 스톡 마켓.', false, null, null, null, '작가 가입·심사 후 콘텐츠 업로드', '국내 사진·일러스트 스톡 판매에 강점'),
  ('iclickart', '아이클릭아트', 'assets', 'domestic', 'https://www.iclickart.co.kr/', '사진·일러스트·영상·폰트 올인원 스톡 플랫폼.', false, null, null, null, '작가 등록·심사 후 콘텐츠 업로드', '사진·일러스트·영상·폰트 통합 스톡에 강점'),
  ('utoimage', '유토이미지', 'assets', 'domestic', 'https://www.utoimage.com/', '사진·일러스트·그래픽 스톡 콘텐츠 마켓.', false, null, null, null, '작가 등록·심사 후 콘텐츠 업로드', '사진·일러스트·그래픽 스톡 유통에 강점'),
  ('gettyimagesbank', '게티이미지뱅크', 'assets', 'domestic', 'https://www.gettyimagesbank.com/', '국내 최대 로열티프리 스톡 이미지 플랫폼.', false, null, null, null, '가입 후 라이선스 구매(작가는 별도 기여 채널)', '로열티프리 스톡 이미지 다량 확보에 강점'),
  ('clipartkorea', '클립아트코리아', 'assets', 'domestic', 'https://www.clipartkorea.co.kr/', '사진·일러스트·폰트·영상 스톡 플랫폼.', false, null, null, null, '가입 후 라이선스 구매·이용', '사진·일러스트·폰트·영상 종합 스톡에 강점'),
  ('mbdrive', '게티이미지코리아', 'assets', 'domestic', 'https://mbdrive.gettyimageskorea.com/', '사진·영상 작가 콘텐츠 판매 기여자 채널.', false, null, null, null, '작가 등록·심사 후 콘텐츠 판매', '게티 계열 사진·영상 작가 판매 채널에 강점'),
  ('contributors', '게티이미지 기여자', 'assets', 'overseas', 'https://contributors.gettyimages.com/', '사진·영상 라이선스 판매 글로벌 기여 프로그램.', false, 'high', '작가 로열티 지급(수취 비중 낮음)', '월 정산(최소 지급액 도달 시)', '기여자 등록·심사 후 업로드', '게티 글로벌 라이선스 판매 기여 프로그램에 강점'),
  ('submit', '셔터스톡 기여자', 'assets', 'overseas', 'https://submit.shutterstock.com/', '사진·영상·벡터 업로드 로열티 글로벌 스톡.', false, 'high', '작가 로열티 지급(수취 비중 낮음)', '월 정산(최소 지급액 도달 시)', '기여자 가입·심사 후 업로드', '셔터스톡 글로벌 스톡 로열티 판매에 강점'),
  ('contributor', '어도비 스톡 기여자', 'assets', 'overseas', 'https://contributor.stock.adobe.com/', '사진·영상·벡터 판매 어도비 스톡 기여자.', false, 'high', '작가 로열티 지급(수취 비중 낮음)', '월 정산(최소 지급액 도달 시)', '기여자 가입·심사 후 업로드', '어도비 생태계 연동 스톡 판매에 강점'),
  ('pixta', '픽스타', 'assets', 'overseas', 'https://www.pixta.jp/', '일본 기반 사진·일러스트·영상 스톡 마켓.', false, null, null, null, '기여자 가입·심사 후 업로드', '일본 시장 중심 사진·일러스트·영상 스톡 판매에 강점'),
  ('pond5', '폰드파이브', 'assets', 'overseas', 'https://www.pond5.com/', '영상·음악·이미지 기여자 판매 미디어 마켓.', false, null, null, null, '기여자 가입·심사 후 업로드', '영상·음악 등 미디어 스톡 판매에 강점'),
  ('sandollcloud', '산돌구름', 'assets', 'domestic', 'https://www.sandollcloud.com/', '산돌 폰트 구독·판매 플랫폼.', false, null, null, null, '가입·구독 후 폰트 이용', '산돌 폰트 구독형 이용에 강점'),
  ('noonnu', '눈누', 'assets', 'domestic', 'https://noonnu.cc/', '상업용 무료 한글 폰트 큐레이션 배포.', false, null, null, null, '가입 없이 무료 폰트 탐색·다운로드', '상업용 무료 한글 폰트 탐색·확인에 강점'),
  ('font', '폰코', 'assets', 'domestic', 'https://font.co.kr/', '윤디자인 한글·글로벌 폰트 판매 플랫폼.', false, null, null, null, '가입 후 폰트 구매·라이선스', '윤디자인 한글·글로벌 폰트 판매에 강점'),
  ('fontclub', '폰트클럽', 'assets', 'domestic', 'http://www.fontclub.co.kr/', '국내외 폰트 판매 전문 쇼핑몰·커뮤니티.', false, null, null, null, '가입 후 폰트 구매·라이선스', '국내외 폰트 판매·커뮤니티에 강점'),
  ('rixfontcloud', '릭스폰트클라우드', 'assets', 'domestic', 'https://www.rixfontcloud.com/', '폰트릭스 릭스폰트 구독·판매 클라우드.', false, null, null, null, '가입·구독 후 폰트 이용', '폰트릭스 릭스폰트 구독형 이용에 강점'),
  ('miricanvas', '미리캔버스 기여자', 'assets', 'domestic', 'https://www.miricanvas.com/', '디자인 템플릿·요소·사진·음원 기여자 마켓.', false, null, null, null, '가입 후 소재 심사 통과·업로드로 판매', '디자인 템플릿·요소·사진·음원 기여 판매, 미리캔버스 이용자 노출'),
  ('bookk', '부크크', 'assets', 'domestic', 'https://bookk.co.kr/', '종이책·전자책 POD 자가출판 플랫폼.', false, null, null, null, '원고 등록·검수 후 출판, 재고 부담 없음', '종이책·전자책 POD 자가출판에 강점, 소량 주문제작'),
  ('pubple', '교보문고 퍼플', 'assets', 'domestic', 'http://pubple.kyobobook.co.kr/', '전자책·POD 종이책 자가출판 서비스.', false, null, null, null, '원고 등록·검수 후 출판', '교보문고 유통 연계 자가출판에 강점'),
  ('upaper', '유페이퍼', 'assets', 'domestic', 'https://www.upaper.net/', 'EPUB 전자책 자가출판·서점 유통 플랫폼.', false, null, null, null, 'EPUB 제작·등록 후 서점 유통', 'EPUB 전자책 제작·주요 서점 유통에 강점'),
  ('ridibooks2', '리디 파트너스', 'assets', 'domestic', 'https://ridibooks.com/partners/', '웹소설·웹툰·전자책 작가 투고·출간 채널.', false, null, null, null, '작품 투고·심사 후 출간', '웹소설·웹툰·전자책 작가 투고·리디 독자 노출'),
  ('jakkawa', '작가와', 'assets', 'domestic', 'https://www.jakkawa.com/', '워드로 전자책·POD 출판·서점 유통 플랫폼.', false, null, null, null, '원고(워드) 등록 후 출판·유통', '워드 기반 전자책·POD 출판·서점 유통에 강점'),
  ('happycampus', '해피캠퍼스', 'assets', 'domestic', 'https://www.happycampus.com/', '레포트·논문·PPT 문서 판매 지식 거래.', false, null, null, null, '가입 후 자료 등록·판매', '레포트·논문·PPT 등 학습 문서 판매 수요에 강점'),
  ('reportworld', '레포트월드', 'assets', 'domestic', 'https://www.reportworld.co.kr/', '레포트·자료·문서 등록·판매 플랫폼.', false, null, null, null, '가입 후 자료 등록·판매', '레포트·문서 자료 등록·판매에 강점'),
  ('audiojungle', '오디오정글', 'assets', 'overseas', 'https://audiojungle.net/', '로열티프리 배경음악 판매 글로벌 스톡 음악.', false, 'high', '독점 여부·등급별 요율 상이', null, '작가 등록·소재 심사 후 판매', '로열티프리 배경음악 글로벌 판매에 강점'),
  ('assetstore', '유니티 에셋스토어', 'assets', 'overseas', 'https://assetstore.unity.com/', '2D·3D·툴 게임 개발 에셋 판매 공식 마켓.', false, 'mid', '판매액 약 30% 플랫폼 수수료', null, '퍼블리셔 등록·에셋 심사 후 판매', '유니티 게임 개발 에셋 판매 공식 채널'),
  ('fab', '팹', 'assets', 'overseas', 'https://www.fab.com/', '3D·게임 에셋 판매 에픽게임즈 통합 마켓.', false, 'low', '판매액 약 12% 수수료', null, '셀러 등록·에셋 심사 후 판매', '3D·게임 에셋 판매, 에픽게임즈 통합 마켓 노출'),
  ('cgtrader', 'CG트레이더', 'assets', 'overseas', 'https://www.cgtrader.com/', '3D 모델·프린팅 파일 판매 글로벌 마켓.', false, null, null, null, '작가 등록·모델 업로드로 판매', '3D 모델·프린팅 파일 글로벌 판매에 강점'),
  ('sketchfab', '스케치팹 스토어', 'assets', 'overseas', 'https://sketchfab.com/store', '실시간 3D 모델 판매 글로벌 마켓.', false, null, null, null, '작가 등록·3D 모델 업로드로 판매', '실시간 3D 모델 뷰어 기반 판매에 강점'),
  ('artstation', '아트스테이션 마켓', 'assets', 'overseas', 'https://www.artstation.com/marketplace', '3D 에셋·브러시·튜토리얼 판매 크리에이티브 마켓.', false, null, null, null, '작가 등록·소재 업로드로 판매', '3D 에셋·브러시·튜토리얼 등 크리에이티브 판매'),
  ('artipio', '아티피오', 'assets', 'domestic', 'https://www.artipio.com/', '예스24 계열이 2023년 선보인 신생 미술품 투자계약증권 발행 플랫폼으로 소액 아트 조각투자를 지원한다.', true, null, null, null, '가입·본인인증 후 청약 참여', '미술품 소액 조각투자에 강점(예스24 계열)'),
  ('treasurer', '트레져러', 'assets', 'domestic', 'https://www.treasurer.co.kr/', '명품 시계·와인 등 고가 수집품을 소액 단위로 나눠 투자하는 신생 대체투자 조각투자 플랫폼이다.', true, null, null, null, '가입·본인인증 후 청약 참여', '명품 시계·와인 등 수집품 소액 조각투자에 강점'),
  ('bankcow', '뱅카우', 'assets', 'domestic', 'https://www.bankcow.co.kr/', '스탁키퍼가 운영하는 국내 최초 한우 조각투자 플랫폼으로 4만원대부터 송아지 공동투자가 가능한 신생 서비스다.', true, null, null, null, '가입·본인인증 후 청약 참여', '한우 소액 공동투자에 특화된 조각투자'),
  ('twig', '트위그', 'assets', 'domestic', 'https://twig.money/', '슈퍼카·비상장주식 등 글로벌 자산을 소액으로 공동투자하는 신생 대체투자 조각투자 플랫폼이다.', true, null, null, null, '가입·본인인증 후 청약 참여', '슈퍼카 등 글로벌 대체자산 소액 조각투자에 강점'),
  ('creators', 'OGQ 크리에이터 스튜디오', 'assets', 'domestic', 'https://creators.ogq.me/', '이모티콘·스티커·이미지를 한 번 업로드로 여러 마켓에 판매하는 크리에이터 스튜디오.', false, null, null, null, '가입 후 콘텐츠 업로드·심사', '이모티콘·이미지 한 번 업로드로 다중 마켓 유통'),
  ('stipop', '스티팝', 'assets', 'overseas', 'https://stipop.io/', '작가 스티커(이모티콘)를 글로벌 메신저에 유통하는 스티커 API 플랫폼.', false, null, null, null, '작가 등록·스티커 업로드로 유통', '스티커의 글로벌 메신저·API 유통에 강점'),
  ('stock', '드롭샷스톡', 'assets', 'domestic', 'https://stock.dropshot.io/ko', '한국적 소재의 상업용 스톡 영상을 판매·유통하는 영상 스톡 플랫폼.', false, null, null, null, '작가 등록·영상 업로드로 판매', '한국적 소재 상업용 스톡 영상 판매에 강점'),
  ('obud', '오붓', 'fitness', 'domestic', 'https://www.obud.co', '요가·필라테스·바레 등 웰니스 스튜디오 통합 이용권.', false, null, null, null, '제휴 스튜디오로 입점 신청(이용자는 가입)', '요가·필라테스·바레 등 웰니스 스튜디오 통합 이용권'),
  ('healthboypass', '헬보올패스', 'fitness', 'domestic', 'https://healthboypass.co.kr', '헬스보이짐 전국 지점 통합 헬스장 패스.', false, null, null, null, '앱 가입 후 지점 통합 이용', '헬스보이짐 전국 지점 통합 이용에 강점'),
  ('likefit', '라이크핏', 'fitness', 'domestic', 'https://www.likefit.me', '카메라 자세 인식 AI 홈트레이닝 코칭 앱.', false, null, null, null, '앱 설치·가입 후 바로 이용', '카메라 자세 인식 AI 홈트레이닝 코칭에 강점'),
  ('quat', '콰트', 'fitness', 'domestic', 'https://quat.life', '필라테스·요가·홈트 온라인 운동 코칭 앱.', false, null, null, null, '앱 설치·가입 후 이용', '필라테스·요가·홈트 온라인 코칭에 강점'),
  ('planfit', '플랜핏', 'fitness', 'domestic', 'https://planfit.ai', 'AI 운동 루틴 추천·기록·음성 코칭 앱.', false, null, null, null, '앱 가입 후 이용(무료 기능 제공)', 'AI 운동 루틴 추천·기록·음성 코칭에 강점'),
  ('dagym', '다짐', 'fitness', 'domestic', 'https://www.da-gym.co.kr', '주변 헬스장·PT·필라테스 가격비교·예약 앱.', false, null, null, null, '앱 설치 후 시설 검색·예약(시설은 제휴)', '주변 헬스장·PT·필라테스 가격비교·예약에 강점'),
  ('ngym', '니짐내짐', 'fitness', 'domestic', 'https://www.ngym.co.kr', '주변 헬스장 월 구독 할인 이용 예약 앱.', false, null, null, null, '앱 가입 후 구독 이용(시설은 제휴)', '주변 헬스장 월 구독형 할인 이용에 강점'),
  ('helssg', '헬쓱', 'fitness', 'domestic', 'https://www.helssg.com', '헬스·요가·PT 회원권 양도·양수 거래 플랫폼.', false, null, null, null, '가입 후 회원권 양도·양수 등록', '헬스·요가·PT 회원권 양도·양수 중개에 강점'),
  ('kimcaddie', '김캐디', 'fitness', 'domestic', 'https://kimcaddie.com', '스크린골프·연습장·레슨 가격비교 예약.', false, null, null, null, '앱 설치 후 검색·예약(시설은 제휴)', '스크린골프·연습장·레슨 가격비교·예약에 강점'),
  ('kakao', '카카오골프예약', 'fitness', 'domestic', 'https://www.kakao.golf', '골프장 티타임 검색·온라인 부킹(카카오VX).', false, null, null, null, '앱 가입 후 티타임 검색·부킹', '골프장 티타임 검색·온라인 부킹에 강점(카카오VX)'),
  ('golfzon', '골프존', 'fitness', 'domestic', 'https://www.golfzon.com', '스크린골프 매장 예약·시뮬레이터 서비스.', false, null, null, null, '앱 가입 후 매장 예약(매장은 제휴)', '스크린골프 매장 예약·시뮬레이터에 강점'),
  ('golfzonmarket', '골프존마켓', 'fitness', 'domestic', 'https://www.golfzonmarket.com', '골프클럽·용품 판매·렌탈 O2O 마켓.', false, null, null, null, '가입 후 용품 구매·렌탈', '골프 클럽·용품 판매·렌탈 O2O에 강점'),
  ('plabfootball', '플랩풋볼', 'fitness', 'domestic', 'https://www.plabfootball.com', '소셜 축구·풋살 매칭·구장 예약 플랫폼.', false, null, null, null, '앱 가입 후 매치 참여·구장 예약', '소셜 축구·풋살 매칭·구장 예약에 강점'),
  ('iamground', '아이엠그라운드', 'fitness', 'domestic', 'https://www.iamground.kr', '풋살장 실시간 예약·팀매칭 앱.', false, null, null, null, '앱 가입 후 예약·팀매칭', '풋살장 실시간 예약·팀매칭에 강점'),
  ('smaxh', '스매시', 'fitness', 'domestic', 'https://www.smaxh.com', '테니스 코트 예약·레슨·클럽 매칭 플랫폼.', false, null, null, null, '앱 가입 후 이용, 코트·레슨은 시설별 예약', '테니스 코트 예약·레슨·클럽 매칭 통합에 강점'),
  ('pleisure', '플레져', 'fitness', 'domestic', 'https://www.pleisure.co', '테니스 코트 예약 서비스.', false, null, null, null, '앱 가입 후 코트 예약', '테니스 코트 예약 특화'),
  ('theclimb', '더클라임', 'fitness', 'domestic', 'https://theclimb.co.kr', '통합 회원권 실내 볼더링 클라이밍짐.', false, null, null, null, '회원 가입·통합 회원권 등록 후 지점 이용', '실내 볼더링 지점 통합 회원권에 강점'),
  ('watercleanse', '워터클랜즈', 'fitness', 'domestic', 'https://watercleanse.co.kr', '지역별 소규모 수영 특강 예약 플랫폼.', false, null, null, null, '앱 가입 후 지역 특강 예약', '지역 소규모 수영 특강 예약에 특화'),
  ('ddakple', '딱플', 'fitness', 'domestic', 'https://www.ddakple.com', '생활체육 체육관 실시간 검색·예약·결제.', false, null, null, null, '앱 가입 후 체육관 검색·예약·결제', '생활체육 체육관 실시간 검색·예약에 강점'),
  ('runday', '런데이', 'fitness', 'domestic', 'https://runday.co.kr', '음성 코칭 러닝·걷기 트레이닝 앱.', false, null, null, null, '가입 후 바로 사용, 무료 이용 중심', '음성 코칭 기반 러닝·걷기 초보 트레이닝에 강점'),
  ('mochaclass', '모카클래스', 'fitness', 'domestic', 'https://mochaclass.com', '요가·필라테스·레저 원데이클래스 예약.', false, null, null, null, '앱 가입 후 원데이클래스 예약', '요가·필라테스·레저 원데이클래스 예약에 강점'),
  ('play4', '웨잇버디', 'fitness', 'domestic', 'https://play.google.com/store/apps/details?id=com.weight.buddy', '2023년 출시된 신생 앱으로, 조건별 헬스메이트·운동 파트너를 AI로 매칭해주는 피트니스 플랫폼이다.', true, null, null, null, '앱 가입 후 프로필 등록·파트너 매칭', '조건별 운동 파트너 AI 매칭에 강점'),
  ('woondoc', '운동닥터', 'fitness', 'domestic', 'https://www.woondoc.com/', '내 주변 헬스 PT·필라테스 트레이너의 가격·후기·자격을 조회하고 매칭하는 신생 피트니스 스타트업 서비스다.', true, null, null, null, '앱 가입 후 트레이너 조회·매칭', '주변 PT·필라테스 트레이너 가격·후기·자격 비교에 강점'),
  ('mobile', '러닝라이프', 'fitness', 'domestic', 'https://mobile.runninglife.co.kr/', '2023년 러닝 커뮤니티로 시작해 앱으로 성장한 신생 서비스로, 러닝 대회·러닝크루·기록 관리를 한곳에서 제공한다.', true, null, null, null, '앱 가입 후 러닝 기록·크루 참여', '러닝 대회·크루·기록 관리 통합에 강점'),
  ('runable', '러너블', 'fitness', 'domestic', 'https://runable.me/', '마라톤 대회 접수와 AI 맞춤 러닝 코칭을 결합한 신생 러닝 특화 플랫폼이다.', true, null, null, null, '앱 가입 후 대회 접수·코칭 이용', '마라톤 대회 접수와 AI 러닝 코칭 결합에 강점'),
  ('play5', '다톡이', 'fitness', 'domestic', 'https://play.google.com/store/apps/details?id=com.sentif.datoki', '2026년 출시된 신규 앱으로, 사진·대화만으로 칼로리와 식단을 분석·기록해주는 에이전틱 AI 다이어트 코치다.', true, null, null, null, '가입 후 바로 사용, 무료 체험 제공', '사진·대화 기반 AI 칼로리·식단 기록에 강점'),
  ('studiomate', '스튜디오메이트', 'fitness', 'domestic', 'https://studiomate.kr/', '필라테스·요가 스튜디오의 회원 수업 예약·관리 앱이다.', false, null, null, null, '스튜디오 사업자 가입 후 회원·수업 관리', '필라테스·요가 스튜디오 예약·회원 관리에 강점'),
  ('classworks', '클래스웍스', 'fitness', 'domestic', 'https://www.classworks.kr/', '운동 스튜디오의 수업 예약·회원 관리를 지원하는 서비스다.', false, null, null, null, '스튜디오 사업자 가입 후 수업·회원 관리', '운동 스튜디오 예약·회원 관리 지원에 강점'),
  ('percentup', '퍼센트업', 'fitness', 'domestic', 'https://www.percentup.co.kr/', '헬스장·PT 트레이너를 비교·매칭하는 플랫폼이다.', false, null, null, null, '앱 가입 후 헬스장·트레이너 비교·매칭', '헬스장·PT 트레이너 비교·매칭에 강점'),
  ('golfspot', '골프스팟', 'fitness', 'domestic', 'https://golfspot.co.kr/', '골프 레슨 프로와 수강생을 조건별로 매칭하는 플랫폼이다.', false, null, null, null, '앱 가입 후 프로·수강생 조건별 매칭', '골프 레슨 프로·수강생 조건 매칭에 강점'),
  ('semos', '세모스', 'fitness', 'domestic', 'https://semos.kr/', '수영·다이빙·서핑 등 레저스포츠 프로그램을 검색·예약한다.', false, null, null, null, '앱 가입 후 레저 프로그램 검색·예약', '수영·다이빙·서핑 등 레저스포츠 예약에 강점'),
  ('marathongo', '마라톤GO', 'fitness', 'domestic', 'https://marathongo.co.kr/', '국내외 마라톤 대회와 러닝 크루를 통합 검색하는 서비스다.', false, null, null, null, '앱 가입 후 대회·크루 검색', '국내외 마라톤 대회·러닝 크루 통합 검색에 강점'),
  ('plsr', '베이스라인', 'fitness', 'domestic', 'https://www.plsr.live/', '테니스장 예약과 대회·실력 평가를 제공하는 앱이다.', false, null, null, null, '앱 가입 후 코트 예약·대회 참여', '테니스장 예약과 대회·실력 평가 제공에 강점'),
  ('weddingbook', '웨딩북', 'wedding', 'domestic', 'https://www.weddingbook.com/', '웨딩홀·스드메·허니문 예약·후기 결혼준비 플랫폼.', false, null, null, null, '앱 가입 후 예약·상담 이용', '웨딩홀·스드메·허니문 예약·후기 통합에 강점'),
  ('iwedding', '아이웨딩', 'wedding', 'domestic', 'https://www.iwedding.co.kr/', '웨딩홀 예약·스드메 패키지 종합 웨딩 플랫폼.', false, null, null, null, '가입 후 예약·상담 이용', '웨딩홀 예약·스드메 패키지 종합 준비에 강점'),
  ('directwedding', '다이렉트 결혼준비', 'wedding', 'domestic', 'https://www.directwedding.co.kr/', '웨딩홀·스드메·허니문·혼수 결혼준비 플랫폼.', false, null, null, null, '가입 후 예약·견적 이용', '웨딩홀·스드메·허니문·혼수 통합 준비에 강점'),
  ('itwed', '아이티웨딩', 'wedding', 'domestic', 'https://www.itwed.co.kr/', '웨딩홀 찾기·웨딩 역경매 결혼준비 플랫폼.', false, null, null, null, '가입 후 웨딩홀 찾기·역경매 이용', '웨딩홀 역경매 견적에 강점'),
  ('sinbuya', '신부야', 'wedding', 'domestic', 'https://www.sinbuya.com/', '웨딩홀·스드메 가격·견적 공개 결혼준비 플랫폼.', false, null, null, null, '가입 후 가격·견적 조회', '웨딩홀·스드메 가격·견적 공개에 강점'),
  ('wedqueen', '웨딩의 여신', 'wedding', 'domestic', 'https://www.wedqueen.com/', '결혼 준비 일정·견적 공유 웨딩 준비 앱.', false, null, null, null, '앱 가입 후 일정·견적 관리', '결혼 준비 일정·견적 공유에 강점'),
  ('apps5', '요즘웨딩', 'wedding', 'domestic', 'https://apps.apple.com/kr/app/id6739044980', '맞춤 계획표·웨딩업체 추천 올인원 앱.', false, null, null, null, '앱 가입 후 계획표·업체 추천 이용', '맞춤 계획표·웨딩업체 추천 올인원에 강점'),
  ('oding', '오딩', 'wedding', 'domestic', 'https://oding.co.kr', '스드메·본식스냅·스몰웨딩 비교·예약.', false, null, null, null, '앱 가입 후 스드메 비교·예약', '스드메·본식스냅·스몰웨딩 비교·예약에 강점'),
  ('kingswed', '웨딩킹', 'wedding', 'domestic', 'https://kingswed.com/', '제휴사 예약·셀프 견적 결혼준비 플랫폼.', false, null, null, null, '가입 후 제휴사 예약·셀프 견적', '제휴사 예약·셀프 견적에 강점'),
  ('wedytor', '웨디터', 'wedding', 'domestic', 'https://wedytor.co.kr/', '모바일청첩장·식순·예산장 올인원 플랫폼.', false, null, null, null, '가입 후 청첩장·예산장 도구 이용', '모바일청첩장·식순·예산장 올인원에 강점'),
  ('kgwed', '결직웨딩', 'wedding', 'domestic', 'https://kgwed.com/', '스드메·본식 촬영 직거래 연결 플랫폼.', false, null, null, null, '가입 후 업체 직거래 연결 이용', '스드메·본식 촬영 직거래 연결에 강점'),
  ('smartweddingpro', '스마트웨딩', 'wedding', 'domestic', 'https://smartwedding-pro.com/', '웨딩홀 추천·스드메 패키지 웨딩 플랫폼.', false, null, null, null, '가입 후 웨딩홀 추천·패키지 이용', '웨딩홀 추천·스드메 패키지에 강점'),
  ('houseweddinglink', '하우스웨딩링크', 'wedding', 'domestic', 'https://www.houseweddinglink.com/', '스몰·하우스웨딩 장소·업체 연결 플랫폼.', false, null, null, null, '가입 후 장소·업체 연결 이용', '스몰·하우스웨딩 장소·업체 연결에 강점'),
  ('haileyhouse', '헤일리하우스', 'wedding', 'domestic', 'https://haileyhouse.co.kr/', '주택·별장 스몰웨딩 장소·디렉팅 서비스.', false, null, null, null, '가입·상담 후 장소·디렉팅 이용', '주택·별장 스몰웨딩 장소·디렉팅에 강점'),
  ('barunsoncard', '바른손카드', 'wedding', 'domestic', 'https://www.barunsoncard.com/', '종이·모바일 청첩장 제작 브랜드.', false, null, null, null, '온라인 주문·제작 의뢰', '종이·모바일 청첩장 제작에 강점'),
  ('itscard', '잇츠카드', 'wedding', 'domestic', 'https://www.itscard.co.kr/', '모바일 청첩장 제작·수정 서비스.', false, null, null, null, '가입 후 청첩장 제작·수정', '모바일 청첩장 제작·수정에 강점'),
  ('bojagicard', '보자기카드', 'wedding', 'domestic', 'https://bojagicard.com/', '종이·모바일 청첩장·식전영상 서비스.', false, null, null, null, '가입 후 온라인 셀프 제작·주문(무료 템플릿 대개 제공)', '종이·모바일 청첩장·식전영상 통합 제작에 강점'),
  ('salondeletter', '살롱드레터', 'wedding', 'domestic', 'https://salondeletter.com/', '테마·음악 커스텀 모바일 청첩장 서비스.', false, null, null, null, '가입 후 온라인 셀프 제작·주문(무료 템플릿 대개 제공)', '테마·음악 커스텀 모바일 청첩장에 강점'),
  ('toourguest', '투아워게스트', 'wedding', 'domestic', 'https://toourguest.com/', '디자인 템플릿 모바일 청첩장 제작.', false, null, null, null, '가입 후 온라인 셀프 제작·주문(무료 템플릿 대개 제공)', '디자인 템플릿 기반 모바일 청첩장 제작에 강점'),
  ('theirmood', '데어무드', 'wedding', 'domestic', 'https://theirmood.com/', '템플릿형 모바일 청첩장 제작 서비스.', false, null, null, null, '가입 후 온라인 셀프 제작·주문(무료 템플릿 대개 제공)', '템플릿형 모바일 청첩장 제작에 강점'),
  ('pastelmovie', '파스텔무비', 'wedding', 'domestic', 'https://pastelmovie.com/', '모바일 청첩장·식전영상 제작 서비스.', false, null, null, null, '가입 후 온라인 셀프 제작·주문(무료 템플릿 대개 제공)', '모바일 청첩장·식전영상 동시 제작에 강점'),
  ('maad', '메드스튜디오', 'wedding', 'domestic', 'https://m.maad.co.kr/', '결혼반지·예물 웨딩 주얼리 브랜드.', false, null, null, null, '온라인·매장 예약 후 상담·주문', '결혼반지·예물 웨딩 주얼리에 특화'),
  ('nouv', '누브', 'wedding', 'domestic', 'https://nouv.co.kr/', '청담 예물 다이아몬드·주얼리 브랜드.', false, null, null, null, '온라인·매장 예약 후 상담·주문', '청담 예물 다이아몬드·주얼리에 특화'),
  ('ringplate', '링플레이트', 'wedding', 'domestic', 'http://www.ringplate.com/', '커스텀 웨딩밴드·커플링 주얼리 브랜드.', false, null, null, null, '온라인·매장 예약 후 상담·주문', '커스텀 웨딩밴드·커플링 제작에 강점'),
  ('ehoneymoon', '이허니문', 'wedding', 'overseas', 'https://e-honeymoon.co.kr/', '신혼여행지 상품 예약 허니문 전문 여행사.', false, null, null, null, '상담·예약 후 상품 결제', '신혼여행지 상품 예약·허니문 전문 상담에 강점'),
  ('palmtour', '팜투어', 'wedding', 'overseas', 'https://www.palmtour.co.kr/', '몰디브·하와이 등 허니문 전문 여행사.', false, null, null, null, '상담·예약 후 상품 결제', '몰디브·하와이 등 허니문 상품에 특화'),
  ('hihoneymoon', '하이허니문', 'wedding', 'overseas', 'https://www.hihoneymoon.co.kr/', '신혼여행 상품 예약 허니문 전문 여행사.', false, null, null, null, '상담·예약 후 상품 결제', '신혼여행 상품 예약·허니문 전문 상담에 강점'),
  ('monoscale', '모노스케일', 'wedding', 'domestic', 'https://monoscale.net/', '본식스냅·웨딩 영상 촬영 예약 플랫폼.', false, null, null, null, '작가 등록 또는 온라인 예약·결제', '본식스냅·웨딩 영상 촬영 예약에 강점'),
  ('wooawedding', '우아한웨딩', 'wedding', 'domestic', 'https://wooawedding.com/', '플로리스트·사진·헤어메이크업 섭외 웨딩 디렉팅 플랫폼.', false, null, null, null, '상담·예약 후 이용', '플로리스트·사진·헤어메이크업 통합 섭외·디렉팅에 강점'),
  ('hanboknam', '한복남', 'wedding', 'domestic', 'https://hanboknam.com/', '경복궁·전주 등 한복 대여 및 택배 대여 서비스.', false, null, null, null, '온라인 예약 후 매장 방문 또는 택배 수령', '경복궁·전주 한복 대여 및 택배 대여에 강점'),
  ('jaengyi', '한복쟁이', 'wedding', 'domestic', 'https://jaengyi.com/', '온·오프라인 한복 대여 서비스.', false, null, null, null, '온라인 예약 후 매장 방문 또는 택배 수령', '온·오프라인 한복 대여에 강점'),
  ('onedayhanbok', '원데이한복', 'wedding', 'domestic', 'https://www.onedayhanbok.com/', '체험·여행용 한복 대여 예약 서비스.', false, null, null, null, '온라인 예약 후 매장 방문 수령', '체험·여행용 한복 대여 예약에 강점'),
  ('dolbokhouse', '첫날한복', 'wedding', 'domestic', 'https://dolbokhouse.com/', '돌복·기념일 한복 대여 서비스.', false, null, null, null, '온라인 예약 후 매장 방문 또는 택배 수령', '돌복·기념일 한복 대여에 특화'),
  ('filmconnect', '필름커넥트', 'photo', 'domestic', 'https://www.filmconnect.co.kr/', '본식·돌·프로필 스냅/스튜디오 작가 예약·매칭.', false, null, null, null, '작가 가입 후 포트폴리오 등록·심사', '본식·돌·프로필 스냅/스튜디오 작가 예약·매칭에 강점'),
  ('snaaaper', '스냅퍼', 'photo', 'domestic', 'https://www.snaaaper.com/', '본식·돌·데이트스냅 작가 검색·예약 서비스.', false, null, null, null, '작가 가입 후 포트폴리오 등록', '본식·돌·데이트스냅 작가 검색·예약에 강점'),
  ('graphus', '그래퍼스', 'photo', 'domestic', 'https://www.graphus.co.kr/', '사진·영상 작가 포트폴리오 검색·중개 플랫폼.', false, null, null, null, '작가 가입 후 포트폴리오 등록', '사진·영상 작가 포트폴리오 검색·중개에 강점'),
  ('apps6', '스냅핏', 'photo', 'domestic', 'https://apps.apple.com/kr/app/id6642695481', '프로필·스냅 작가 포트폴리오·가격비교 예약 앱.', false, null, null, null, '작가 가입 후 포트폴리오·가격 등록', '프로필·스냅 작가 가격비교·예약에 강점'),
  ('snappi', '스내피', 'photo', 'domestic', 'https://snappi.imweb.me/', '일상·프로필 촬영 작가 매칭 서비스.', false, null, null, null, '작가 가입 후 포트폴리오 등록', '일상·프로필 촬영 작가 매칭에 강점'),
  ('snapcap', '스냅캡', 'photo', 'domestic', 'https://snapcap.kr/', '장소·컨셉·작가 선택 출장 촬영 매칭 플랫폼.', false, null, null, null, '작가 가입 후 포트폴리오 등록', '장소·컨셉·작가 선택 출장 촬영 매칭에 강점'),
  ('honeypic', '허니픽', 'photo', 'overseas', 'https://honeypic.com/', '해외 여행지 현지 스냅 작가 매칭·예약.', false, null, null, null, '작가 가입 후 포트폴리오 등록', '해외 여행지 현지 스냅 작가 매칭에 강점'),
  ('stafpic', '스텝픽', 'photo', 'domestic', 'https://stafpic.com/', '영상 촬영·제작사 의뢰자 연결 외주 매칭.', false, null, null, null, '제작사 가입 후 프로필 등록', '영상 촬영·제작사 외주 매칭에 강점'),
  ('videocon', '비디오콘', 'photo', 'domestic', 'https://www.videocon.io/', '영상 제작사 매칭·비교견적 외주 플랫폼.', false, null, null, null, '제작사 가입 후 프로필 등록', '영상 제작사 비교견적 외주에 강점'),
  ('vidfolio', '비드폴리오', 'photo', 'domestic', 'https://vidfolio.kr/', '포트폴리오 기반 영상 제작사 매칭 서비스.', false, null, null, null, '제작사 가입 후 포트폴리오 등록', '포트폴리오 기반 영상 제작사 매칭에 강점'),
  ('match', '드롭샷매치', 'photo', 'domestic', 'https://match.dropshot.io/', '기업·영상제작사 비교견적 B2B 매칭.', false, null, null, null, '제작사 가입 후 프로필 등록', '기업·영상제작사 비교견적 B2B 매칭에 강점'),
  ('vcrewcorp', '브이크루', 'photo', 'domestic', 'https://www.vcrewcorp.com/', '영상 제작·편집·촬영 대행 매칭 서비스.', false, null, null, null, '제작사 가입 후 프로필 등록', '영상 제작·편집·촬영 대행 매칭에 강점'),
  ('studiopeople', '스튜디오피플', 'photo', 'domestic', 'https://www.studiopeople.kr/', '프로필·증명·바디프로필 촬영 예약 서비스.', false, null, null, null, '온라인 예약·결제 후 이용', '프로필·증명·바디프로필 촬영 예약에 강점'),
  ('successstudio', '성공사진관', 'photo', 'domestic', 'https://www.success-studio.kr/', '사진관 예약·고객·매출 관리 솔루션.', false, null, null, null, '가입 후 사진관 운영에 도입·이용', '사진관 예약·고객·매출 관리 솔루션에 특화'),
  ('mcard', '바른손M카드', 'photo', 'domestic', 'https://mcard.barunsoncard.com/', '바른손 모바일 청첩장·초대장 제작.', false, null, null, null, '가입 후 온라인 셀프 제작·주문', '바른손 모바일 청첩장·초대장 제작에 강점'),
  ('feelmaker', '필메이커', 'photo', 'domestic', 'https://feelmaker.co.kr/', '스킨 선택 무료 모바일 청첩장 제작.', false, null, null, null, '가입 후 온라인 셀프 제작(무료 제공)', '스킨 선택 무료 모바일 청첩장 제작에 강점'),
  ('directwedcard', '필카드', 'photo', 'domestic', 'https://directwedcard.com/', '무료 모바일 청첩장 제작 서비스.', false, null, null, null, '가입 후 온라인 셀프 제작(무료 제공)', '무료 모바일 청첩장 제작에 강점'),
  ('moiitee', '모이티', 'photo', 'domestic', 'https://www.moiitee.com/', '모바일 청첩장·웨딩포스터·식권 셀프 제작.', false, null, null, null, '가입 후 온라인 셀프 제작·주문', '모바일 청첩장·웨딩포스터·식권 셀프 제작에 강점'),
  ('dalpeng', '달팽', 'photo', 'domestic', 'https://dalpeng.com/', '청첩장·돌잔치·행사 모바일 초대장 제작.', false, null, null, null, '가입 후 온라인으로 초대장 제작·주문', '청첩장·돌잔치 모바일 초대장 제작에 강점'),
  ('deardeer', '디얼디어', 'photo', 'domestic', 'https://deardeer.kr/', '종이·모바일 청첩장 제작 서비스.', false, null, null, null, '온라인 주문 후 종이·모바일 청첩장 제작', '종이·모바일 청첩장 제작을 함께 제공'),
  ('ofy', '온니포유', 'photo', 'domestic', 'https://ofy.kr/', '돌잔치·청첩장 모바일 초대장 제작.', false, null, null, null, '가입 후 온라인으로 초대장 제작·주문', '돌잔치·청첩장 모바일 초대장 제작에 강점'),
  ('life4cut', '인생네컷', 'photo', 'domestic', 'https://www.life4cut.co.kr/', '셀프 촬영·즉석 인화 네컷사진 포토부스.', false, null, null, null, '가맹·매장 설치는 창업 문의, 이용은 현장 결제', '셀프 즉석 인화 네컷사진 부스에 강점'),
  ('photogray', '포토그레이', 'photo', 'domestic', 'https://photogray.com/', '셀프 촬영 포토부스 네컷사진 브랜드.', false, null, null, null, '가맹·매장 설치는 창업 문의, 이용은 현장 결제', '셀프 촬영 포토부스 네컷사진 브랜드'),
  ('photoair', '포토에어', 'photo', 'domestic', 'https://photo-air.com/', '출장형 렌탈 셀프 포토부스 서비스.', false, null, null, null, '행사 단위 렌탈 예약·견적 문의', '출장형 셀프 포토부스 렌탈에 강점'),
  ('partypang', '파티팡', 'event', 'domestic', 'https://www.partypang.co.kr/', '파티용품·장식·헬륨풍선 배달 전문몰.', false, null, null, null, '가입 후 온라인 주문·배달', '파티용품·장식·헬륨풍선 배달에 강점'),
  ('partyhae', '파티해', 'event', 'domestic', 'https://partyhae.com/', '파티 장식·풍선·이벤트 소품 할인 쇼핑몰.', false, null, null, null, '가입 후 온라인 주문', '파티 장식·풍선·이벤트 소품 할인 구매'),
  ('joyparty', '조이파티', 'event', 'domestic', 'https://www.joyparty.co.kr/', '생일파티용품·풍선 차량배달 전문점.', false, null, null, null, '온라인 주문·차량배달 이용', '생일파티용품·풍선 차량배달에 강점'),
  ('rentalfr', '렌탈프리', 'event', 'domestic', 'https://rentalfr.com/', '포토월·바테이블 등 행사용품 렌탈.', false, null, null, null, '행사 단위 대여 예약·견적 문의', '포토월·바테이블 등 행사용품 렌탈에 강점'),
  ('rentalmonkey', '렌탈몽키', 'event', 'domestic', 'https://rental-monkey.com/', '테이블 등 행사용품 대여 전문 업체.', false, null, null, null, '행사 단위 대여 예약·견적 문의', '테이블 등 행사용품 대여에 강점'),
  ('whitebooth', '하얀부스', 'event', 'domestic', 'https://www.whitebooth.co.kr/', '행사용품 렌탈·설치·행사 기획 업체.', false, null, null, null, '행사 단위 렌탈·설치·기획 문의', '행사용품 렌탈에 설치·기획까지 제공'),
  ('partykorea', '파티코리아', 'event', 'domestic', 'https://partykorea.co.kr/', '개업·기업행사 출장뷔페·케이터링.', false, null, null, null, '행사 단위 케이터링 주문·견적 문의', '개업·기업행사 출장뷔페에 강점'),
  ('koreabuffet', '코리아출장부페', 'event', 'domestic', 'https://www.koreabuffet.co.kr/', '수도권 출장뷔페·케이터링 서비스.', false, null, null, null, '행사 단위 케이터링 주문·견적 문의', '수도권 출장뷔페·케이터링에 강점'),
  ('awesomeparty', '어썸파티', 'event', 'domestic', 'https://awesomeparty.co.kr/', '포장 배달형 케이터링·파티박스 서비스.', false, null, null, null, '온라인 주문·배달 이용', '포장 배달형 케이터링·파티박스에 강점'),
  ('roomservicehomeparty', '룸서비스 홈파티', 'event', 'domestic', 'https://roomservicehomeparty.com/', '집들이·모임 홈파티 출장뷔페 케이터링.', false, null, null, null, '행사 단위 케이터링 주문·견적 문의', '집들이·모임 홈파티 출장뷔페에 강점'),
  ('justincatering', '저스틴케이터링', 'event', 'domestic', 'https://www.justincatering.com/', '호텔식 도시락·프리미엄 케이터링 주문.', false, null, null, null, '온라인 주문·견적 문의', '호텔식 도시락·프리미엄 케이터링에 강점'),
  ('damsoban', '담소반', 'event', 'domestic', 'https://www.damsoban.co.kr/', '셰프·플로리스트 케이터링·도시락 주문.', false, null, null, null, '온라인 주문·견적 문의', '셰프·플로리스트 케이터링·도시락에 강점'),
  ('foodsupporters', '푸드서포터즈', 'event', 'domestic', 'https://www.foodsupporters.com/', '단체 도시락·케이터링 주문·배달 플랫폼.', false, null, null, null, '가입 후 단체 도시락·케이터링 주문', '단체 도시락·케이터링 주문·배달에 강점'),
  ('fooding', '오피스푸딩', 'event', 'domestic', 'https://fooding.io/', '사무실 단체식·간식·케이터링 주문 플랫폼.', false, null, null, null, '가입 후 사무실 단체식·간식 주문', '사무실 단체식·간식·케이터링 주문에 강점')
on conflict (id) do nothing;

insert into public.platforms (id, name, category_id, region, url, blurb, is_new, fee_band, fee_text, settle_text, enter_text, strength) values
  ('kukka', '꾸까', 'event', 'domestic', 'https://kukka.kr/', '꽃 정기구독 온라인 플라워 브랜드.', false, null, null, null, '가입 후 정기구독·주문', '꽃 정기구독 온라인 브랜드'),
  ('flipflower', '플립플라워', 'event', 'domestic', 'https://www.flipflower.co.kr/', '꽃 정기구독 서비스.', false, null, null, null, '가입 후 정기구독 신청', '꽃 정기구독 서비스'),
  ('florano', '플로라노', 'event', 'domestic', 'https://www.florano.shop/', '프리미엄 꽃 정기구독·플라워 카페 브랜드.', false, null, null, null, '가입 후 정기구독·주문', '프리미엄 꽃 정기구독·플라워 카페에 강점'),
  ('snowfoxflowers', '스노우폭스 플라워', 'event', 'domestic', 'https://snowfoxflowers.com/', '합리적 가격 꽃 판매 플라워 브랜드.', false, null, null, null, '가입 후 온라인·매장 주문', '합리적 가격대 꽃 판매에 강점'),
  ('honestflower', '어니스트플라워', 'event', 'domestic', 'https://honestflower.kr/', '일상용 꽃 판매·배송 플라워 브랜드.', false, null, null, null, '가입 후 온라인 주문·배송', '일상용 꽃 판매·배송에 강점'),
  ('fleurue', '플레루', 'event', 'domestic', 'https://www.fleurue.com/', '일상용 꽃 정기구독 플라워 서비스.', false, null, null, null, '가입 후 정기구독 신청', '일상용 꽃 정기구독에 강점'),
  ('flowerrepublic', '플라워리퍼블릭', 'event', 'domestic', 'http://www.flowerrepublic.co.kr/', '근조·축하화환·개업선물 당일배송.', false, null, null, null, '온라인 주문·당일배송 이용', '근조·축하화환·개업선물 당일배송에 강점'),
  ('cultwoflower', '컬투플라워', 'event', 'domestic', 'https://www.cultwo-flower.com/', '꽃다발·화환 전국 당일배송 꽃배달.', false, null, null, null, '온라인 주문·당일배송 이용', '꽃다발·화환 전국 당일배송에 강점'),
  ('flower119', '플라워119', 'event', 'domestic', 'https://www.flower119.co.kr/', '전국 꽃집 네트워크 화환·꽃 당일배송.', false, null, null, null, '온라인 주문·전국 꽃집 배송', '전국 꽃집 네트워크 화환 당일배송에 강점'),
  ('flowerplus', '플라워플러스', 'event', 'domestic', 'https://flowerplus.co.kr/', '기업용 화환·식물 원스톱 꽃배달.', false, null, null, null, '가입 후 기업용 화환·식물 주문', '기업용 화환·식물 원스톱 배송에 강점'),
  ('biz', '기프티쇼 비즈', 'event', 'domestic', 'https://biz.giftishow.com/', '기업용 모바일쿠폰·판촉물 대량발송.', false, null, null, null, '기업 가입 후 대량 발송 주문', '기업용 모바일쿠폰·판촉물 대량발송에 강점'),
  ('barunsonthegift', '바른손 더기프트', 'event', 'domestic', 'https://www.barunsonthegift.com/', '답례품·선물 전문몰.', false, null, null, null, '가입 후 온라인 주문', '답례품·선물 전문 구매에 강점'),
  ('giftinfo', '세종기프트', 'event', 'domestic', 'https://giftinfo.co.kr/', '판촉물·기념품·답례품 제작·판매.', false, null, null, null, '주문·제작 견적 문의', '판촉물·기념품·답례품 제작에 강점'),
  ('showgle', '쇼글', 'event', 'domestic', 'https://www.showgle.co.kr/', '공연팀·연예인 섭외 매칭 플랫폼.', false, null, null, null, '공연팀·의뢰자 가입 후 섭외 매칭', '공연팀·연예인 섭외 매칭에 강점'),
  ('eventnet', '이벤트넷', 'event', 'domestic', 'https://eventnet.co.kr/', '행사·전시·컨벤션 전문가 매칭 커뮤니티.', false, null, null, null, '가입 후 전문가·의뢰 매칭 이용', '행사·전시·컨벤션 전문가 매칭에 강점'),
  ('eventplus', '이벤트플러스', 'event', 'domestic', 'https://www.eventplus.co.kr/', '장비 대여·인력 섭외 행사 대행 매칭.', false, null, null, null, '사업자 등록 후 행사 의뢰·업체 매칭 이용', '장비 대여·인력 섭외 등 행사 대행 매칭에 강점'),
  ('myfair', '마이페어', 'event', 'domestic', 'https://myfair.co/', '해외 박람회 부스 예약·파트너 매칭 전시.', false, null, null, null, '참가 희망 기업 문의·상담 후 부스 예약', '해외 박람회 부스 예약·현지 파트너 매칭에 특화'),
  ('iex', '아이전시', 'event', 'domestic', 'https://i-ex.co.kr/', '전시·박람회 부스·포토존 설치 대행.', false, null, null, null, '전시 참가 기업 견적 문의 후 설치 의뢰', '전시·박람회 부스·포토존 설치 대행에 강점'),
  ('gopropose', '고프로포즈', 'event', 'domestic', 'https://gopropose.com/', '프로포즈·기념일 서프라이즈 이벤트 대행.', false, null, null, null, '이용자 문의·상담 후 이벤트 대행 예약', '프로포즈·기념일 서프라이즈 이벤트 대행에 특화'),
  ('luvhunter', '러브헌터', 'event', 'domestic', 'https://www.luvhunter.net/', '프로포즈·기념일 이벤트 대행 업체.', false, null, null, null, '이용자 문의·상담 후 이벤트 예약', '프로포즈·기념일 이벤트 대행에 특화'),
  ('haruclass', '하루클래스', 'event', 'domestic', 'https://haruclass.kr/', '취미·원데이 클래스를 예약하는 플랫폼.', false, null, null, null, '강사·업체는 클래스 등록, 이용자는 가입 후 예약', '취미·원데이 클래스 예약·발견에 강점'),
  ('deardayclass', '디어데이클래스', 'event', 'domestic', 'https://deardayclass.co.kr/', '원데이클래스 예약·소개 서비스.', false, null, null, null, '강사는 클래스 등록, 이용자는 가입 후 예약', '원데이클래스 예약·소개에 특화'),
  ('annaandparty', '안나앤파티', 'event', 'domestic', 'https://annaandparty.com/', '백일상·돌상 셀프 상차림 대여 서비스.', false, null, null, null, '이용자 가입 후 상차림 대여 예약', '백일상·돌상 셀프 상차림 대여에 특화'),
  ('pookoodol', '뿌꾸돌상', 'event', 'domestic', 'https://pookoodol.com/', '돌상·백일상·한복 대여 상차림 전문 서비스.', false, null, null, null, '이용자 가입 후 상차림·한복 대여 예약', '돌상·백일상 상차림·한복 대여에 전문'),
  ('dollsdream', '돌스드림', 'event', 'domestic', 'https://dollsdream.co.kr/', '집에서 하는 셀프 돌상 대여 서비스.', false, null, null, null, '이용자 가입 후 셀프 돌상 대여 예약', '집에서 하는 셀프 돌상 대여에 특화'),
  ('lawtalk', '로톡', 'legaltax', 'domestic', 'https://www.lawtalk.co.kr/', '변호사 검색·전화/영상/방문 법률 상담 매칭.', false, null, null, null, '변호사는 자격 인증 후 프로필 등록, 이용자는 가입 후 상담', '변호사 검색·전화/영상/방문 법률 상담 매칭에 강점'),
  ('lawandgood', '로앤굿', 'legaltax', 'domestic', 'https://www.lawandgood.com/', '질문지 기반 변호사 제안서 법률 매칭 플랫폼.', false, null, null, null, '변호사는 자격 인증 등록, 이용자는 질문지 작성 후 이용', '질문지 기반 변호사 제안서 매칭에 특화'),
  ('lawsee', '로시컴', 'legaltax', 'domestic', 'https://www.lawsee.com/', '변호사·노무사·세무사 상담 매칭 플랫폼.', false, null, null, null, '전문가는 자격 인증 등록, 이용자는 가입 후 상담', '변호사·노무사·세무사 상담 매칭에 강점'),
  ('helpme', '헬프미', 'legaltax', 'domestic', 'https://www.help-me.kr/', '지급명령·법인등기·상속 온라인 법률 리걸테크.', false, null, null, null, '이용자 가입 후 온라인 법률 서비스 신청', '지급명령·법인등기·상속 온라인 처리에 강점'),
  ('albup', '알법', 'legaltax', 'domestic', 'https://albup.co.kr/', '이용자·변호사 빠른 연결 법률상담 매칭 앱.', false, null, null, null, '변호사는 자격 인증 등록, 이용자는 앱 가입 후 상담', '이용자·변호사 빠른 연결 법률상담에 특화'),
  ('connects', '아하커넥츠', 'legaltax', 'domestic', 'https://connects.a-ha.io/', '변호사 등 전문가 1:1 유료 상담 플랫폼.', false, null, null, null, '전문가는 인증 후 등록, 이용자는 가입 후 유료 상담', '변호사 등 전문가 1:1 유료 상담에 특화'),
  ('lawmaster', '로마스터', 'legaltax', 'domestic', 'https://law-master.com/', '내용증명·지급명령 등 AI 법률 서비스 플랫폼.', false, null, null, null, '이용자 가입 후 AI 법률 서비스 이용', '내용증명·지급명령 등 AI 법률 문서 작성에 강점'),
  ('lawform', '로폼', 'legaltax', 'domestic', 'https://www.lawform.io/', '계약서·내용증명 자동작성·전자서명·보관.', false, null, null, null, '가입 후 바로 문서 작성·전자서명 이용', '계약서·내용증명 자동작성·전자서명·보관에 강점'),
  ('3o3', '삼쩜삼', 'legaltax', 'domestic', 'https://www.3o3.co.kr/', '종합소득세 신고·환급 모바일 세무 플랫폼.', false, null, null, null, '가입·본인인증 후 소득세 신고·환급 조회', '종합소득세 신고·환급 간편 처리에 강점'),
  ('taxmon', '택스몬', 'legaltax', 'domestic', 'https://taxmon.co.kr/', '양도·상속·증여세 시뮬레이션·상담 세무 서비스.', false, null, null, null, '이용자 가입 후 세금 시뮬레이션·상담 이용', '양도·상속·증여세 시뮬레이션·상담에 특화'),
  ('semutong', '세무통', 'legaltax', 'domestic', 'https://www.semutong.com/', '세무사 수수료·후기 비교·견적 매칭 플랫폼.', false, null, null, null, '세무사는 인증 등록, 이용자는 가입 후 견적 비교', '세무사 수수료·후기 비교·견적 매칭에 강점'),
  ('findsemusa', '찾아줘세무사', 'legaltax', 'domestic', 'https://www.findsemusa.com/', '세무사 실시간 상담 매칭 플랫폼.', false, null, null, null, '세무사는 자격 인증 등록, 이용자는 가입 후 상담', '세무사 실시간 상담 매칭에 강점'),
  ('jobis', '자비스', 'legaltax', 'domestic', 'https://jobis.co/', '세무사·회계사 기장·세무신고 대행 플랫폼.', false, null, null, null, '사업자 가입 후 기장·세무신고 대행 이용', '세무사·회계사 기장·세무신고 대행에 특화'),
  ('findsemusa2', '찾아줘노무사', 'legaltax', 'domestic', 'https://www.findsemusa.com/labor/', '노무사 실시간 채팅·전화 상담 매칭.', false, null, null, null, '노무사는 자격 인증 등록, 이용자는 가입 후 상담', '노무사 실시간 채팅·전화 상담 매칭에 강점'),
  ('markinfo', '마크인포', 'legaltax', 'domestic', 'https://markinfo.kr/', '온라인 상표 검색·출원 상표등록 플랫폼.', false, null, null, null, '가입 후 상표 검색·출원 신청', '온라인 상표 검색·출원 등록에 강점'),
  ('markinfoglobal', '마크인포 글로벌', 'legaltax', 'overseas', 'https://www.markinfoglobal.com/', '해외 상표등록 절차 지원 플랫폼.', false, null, null, null, '가입 후 해외 상표등록 절차 신청', '해외 상표등록 절차 지원에 특화'),
  ('modusign', '모두싸인', 'legaltax', 'domestic', 'https://modusign.co.kr/', '전자서명 요청·체결·관리 전자계약 SaaS.', false, null, null, null, '가입 후 전자서명 요청·체결 이용(무료 플랜 제공)', '전자서명 요청·체결·관리 전자계약에 강점'),
  ('eformsign', '이폼사인', 'legaltax', 'domestic', 'https://www.eformsign.com/', '전자계약 작성·서명·보관 클라우드 전자문서.', false, null, null, null, '가입 후 전자계약 작성·서명 이용', '전자계약 작성·서명·클라우드 보관에 강점'),
  ('glosign', '글로싸인', 'legaltax', 'domestic', 'https://www.glosign.com/', '온라인 계약 체결 전자계약·전자서명 플랫폼.', false, null, null, null, '가입 후 온라인 계약 체결 이용', '온라인 계약 체결 전자서명에 강점'),
  ('trost', '트로스트', 'legaltax', 'domestic', 'https://trost.co.kr/', '상담사 문자·전화·대면 심리상담 매칭.', false, null, null, null, '상담사는 인증 등록, 이용자는 가입 후 상담 예약', '문자·전화·대면 심리상담 매칭에 강점'),
  ('mindcafe', '마인드카페', 'legaltax', 'domestic', 'https://mindcafe.co.kr/', '익명 커뮤니티·전문가 원격 심리상담 플랫폼.', false, null, null, null, '이용자 가입 후 커뮤니티·원격 상담 이용', '익명 커뮤니티·전문가 원격 심리상담에 강점'),
  ('hellomindcare', '헬로마인드케어', 'legaltax', 'domestic', 'https://www.hellomindcare.com/', '심리상담사 매칭·영상 상담·심리검사 앱.', false, null, null, null, '이용자 앱 가입 후 상담 예약·심리검사', '심리상담사 매칭·영상 상담·심리검사에 강점'),
  ('zuzu', 'ZUZU', 'legaltax', 'domestic', 'https://zuzu.network/', '법인설립·등기·주주·스톡옵션 관리 플랫폼.', false, null, null, null, '법인·창업자 가입 후 설립·등기·지분 관리 이용', '법인설립·등기·주주·스톡옵션 관리에 강점'),
  ('scil', '서울신용평가정보', 'legaltax', 'domestic', 'https://scil.co.kr/', '채권추심 온라인 종합지원 채권 회수 서비스.', false, null, null, null, '이용자 가입 후 채권추심 지원 신청', '채권추심 온라인 종합지원·회수에 강점'),
  ('lbox', '엘박스', 'legaltax', 'domestic', 'https://lbox.kr/', '방대한 판결문 데이터를 기반으로 판례 검색과 AI 요약·분석을 제공하는 신규 리걸테크 스타트업 서비스다.', true, null, null, null, '변호사·법조인 가입·인증 후 판례 검색 이용', '방대한 판결문 기반 판례 검색·AI 요약·분석에 강점'),
  ('bhsn', '앨리비', 'legaltax', 'domestic', 'https://bhsn.ai/', '2020년 설립된 BHSN이 법률 특화 AI로 계약서 검토·기업법무를 지원하는 올인원 리걸AI 솔루션 ''앨리비''를 제공하는 신생 스타트업이다.', true, null, null, null, '문의·상담 후 기업 단위 도입', '계약서 검토·기업법무 AI 자동화에 강점'),
  ('seteuk', '세무특공대', 'legaltax', 'domestic', 'https://seteuk.tax/', '아이비즈온이 운영하는 AI 기장 서비스로, 홈택스·은행·카드 데이터를 연동해 거래 분류와 장부 작성을 자동화하는 신규 세무테크다.', true, null, null, null, '가입 후 홈택스·금융 데이터 연동', '거래 자동분류·장부 작성 자동화에 강점'),
  ('pluscompany', '덧셈', 'legaltax', 'domestic', 'https://www.pluscompany.kr/', '2023년 설립된 덧셈컴퍼니가 프리랜서·직장인·사업자의 종합소득세 신고와 세금 환급(경정청구)을 자동화해주는 신생 세무 서비스다.', true, null, null, null, '앱 가입·소득자료 연동 후 신고', '프리랜서·직장인 종소세 신고·환급에 강점'),
  ('heumtax', '더낸세금', 'legaltax', 'domestic', 'https://www.heumtax.com/', '세무법인 혜움이 2021년 선보인 세금 환급 서비스로, 누락된 공제·감면을 경정청구로 돌려받도록 돕는 신규 세무테크 플랫폼이다.', true, null, null, null, '가입·자료 연동 후 환급 조회', '누락 공제·감면 경정청구 환급에 강점'),
  ('finda', '핀다', 'finance', 'domestic', 'https://finda.co.kr/', 'AI 다수 금융사 대출 금리·한도 비교 플랫폼.', false, null, null, null, '앱 가입·본인인증 후 조회', '다수 금융사 대출 금리·한도 비교에 강점'),
  ('toss', '토스', 'finance', 'domestic', 'https://toss.im/', '송금·자산관리·대출 비교 금융 슈퍼앱.', false, null, null, null, '가입·본인인증 후 이용', '송금·자산관리·대출비교 통합 금융앱에 강점'),
  ('kakaopay', '카카오페이 대출', 'finance', 'domestic', 'https://www.kakaopay.com/', '여러 금융사 대출 금리·한도 조회·비교.', false, null, null, null, '가입·본인인증 후 조회', '여러 금융사 대출 한도·금리 일괄 조회에 강점'),
  ('banksalad', '뱅크샐러드', 'finance', 'domestic', 'https://www.banksalad.com/', '자산관리·대출/카드/보험 비교 마이데이터 앱.', false, null, null, null, '가입·마이데이터 연동 후 이용', '자산 통합관리·대출/카드/보험 비교에 강점'),
  ('dambee', '담비', 'finance', 'domestic', 'http://www.dambee.com/', '주담대·전세대출 담보대출 비교 플랫폼.', false, null, null, null, '앱 가입·본인인증 후 조회', '주담대·전세대출 등 담보대출 비교에 강점'),
  ('alda', '알다', 'finance', 'domestic', 'https://www.alda.ai/', '대출 비교·신청·관리(론테크) 앱.', false, null, null, null, '앱 가입·본인인증 후 조회', '대출 비교·신청·관리 통합(론테크)에 강점'),
  ('finnq', '핀크', 'finance', 'domestic', 'https://www.finnq.com/', '하나금융 계열 생활금융·대출/카드/보험 비교.', false, null, null, null, '가입·본인인증 후 이용', '생활금융·대출/카드/보험 비교에 강점'),
  ('bankmall', '뱅크몰', 'finance', 'domestic', 'https://www.bank-mall.co.kr/', '주담대·전세·신용대출 비교 플랫폼.', false, null, null, null, '앱 가입·본인인증 후 조회', '주담대·전세·신용대출 비교에 강점'),
  ('cashnote', '캐시노트', 'finance', 'domestic', 'https://cashnote.kr/', '소상공인 경영관리·사업자대출 비교·신청.', false, null, null, null, '사업자 가입·매출 데이터 연동 후 이용', '소상공인 경영관리·사업자대출 비교에 강점'),
  ('einsmarket', '보험다모아', 'finance', 'domestic', 'https://www.e-insmarket.or.kr/', '온라인 보험상품 비교·공시 슈퍼마켓.', false, null, null, null, '별도 가입 없이 조회', '온라인 보험상품 표준 비교·공시에 강점'),
  ('goodrich', '굿리치', 'finance', 'domestic', 'https://www.goodrich.co.kr/', '보험 조회·분석·비교·청구 인슈어테크·GA.', false, null, null, null, '앱 가입·본인인증 후 이용', '보험 조회·분석·비교·청구 통합관리에 강점'),
  ('bomapp', '보맵', 'finance', 'domestic', 'https://www.bomapp.co.kr/', '보험 조회·분석·비교·간편청구 관리 앱.', false, null, null, null, '앱 가입·본인인증 후 이용', '보험 조회·분석·간편청구 관리에 강점'),
  ('signalplanner', '시그널플래너', 'finance', 'domestic', 'https://signalplanner.co.kr/', '보험 조회·진단·비대면 상담 앱.', false, null, null, null, '앱 가입·본인인증 후 이용', '보험 진단·비대면 상담에 강점'),
  ('bodoc', '보닥', 'finance', 'domestic', 'https://www.bodoc.co.kr/', 'AI 보험 진단·분석·관리 보험 앱.', false, null, null, null, '앱 가입·본인인증 후 이용', 'AI 보험 진단·분석·관리에 강점'),
  ('bohumclinic', '보험클리닉', 'finance', 'domestic', 'https://bohumclinic.com/', '오프라인 매장 기반 보험 점검·비교·설계.', false, null, null, null, '매장 방문·상담 예약 후 이용', '오프라인 매장 기반 보험 점검·설계에 강점'),
  ('insvalley', '인스밸리', 'finance', 'domestic', 'https://www.insvalley.com/', '자동차보험 등 온라인 보험 견적 비교.', false, null, null, null, '본인인증 후 견적 조회', '자동차보험 등 온라인 견적 비교에 강점'),
  ('cardgorilla', '카드고릴라', 'finance', 'domestic', 'https://www.card-gorilla.com/', '신용·체크카드 혜택·순위 비교·추천 플랫폼.', false, null, null, null, '별도 가입 없이 조회', '신용·체크카드 혜택 비교·추천에 강점'),
  ('travelwallet', '트래블월렛', 'finance', 'domestic', 'https://www.travel-wallet.com/', '다통화 충전·환전·해외결제·송금 앱.', false, null, null, null, '앱 가입·카드 발급 후 이용', '다통화 충전·환전·해외결제에 강점'),
  ('wirebarley', '와이어바알리', 'finance', 'domestic', 'https://www.wirebarley.com/', '저수수료 다국가 해외송금 핀테크.', false, null, null, null, '앱 가입·본인인증 후 송금', '저수수료 다국가 해외송금에 강점'),
  ('sentbe', '센트비', 'finance', 'domestic', 'https://www.sentbe.com/', '개인·사업자 저비용 해외송금 서비스.', false, null, null, null, '가입·본인인증 후 송금(개인·사업자)', '개인·사업자 저비용 해외송금에 강점'),
  ('themoin', '모인', 'finance', 'domestic', 'https://www.themoin.com/', '우대환율·저수수료 다국가 해외송금 앱.', false, null, null, null, '앱 가입·본인인증 후 송금', '우대환율·저수수료 해외송금에 강점'),
  ('fint', '핀트', 'finance', 'domestic', 'https://www.fint.co.kr/', 'AI 로보어드바이저 비대면 자산관리 앱.', false, null, null, null, '가입·투자일임 계약 후 이용', 'AI 로보어드바이저 자동 자산관리에 강점'),
  ('ols', '소상공인정책자금', 'finance', 'domestic', 'https://ols.semas.or.kr/', '소상공인시장진흥공단 정책자금 안내·신청.', false, null, null, null, '사업자 대상 온라인 신청', '소상공인 정책자금 안내·신청 창구에 강점'),
  ('paywatch', '페이워치', 'finance', 'domestic', 'https://paywatch.co.kr/', '근로자가 급여일 전에 이미 일한 만큼의 임금을 미리 받을 수 있게 해주는 급여 선지급(EWA) 신생 핀테크다.', true, null, null, null, '사업장(기업) 도입 후 근로자 이용', '급여일 전 근로임금 선지급(EWA)에 강점'),
  ('canopy', '캐노피', 'finance', 'domestic', 'https://www.canopy.im/ko', '2024년 설립된 신생 스타트업으로, 근무 기록에 따라 근로자가 정산일 전에 급여를 실시간으로 인출하는 급여 선정산 서비스를 제공한다.', true, null, null, null, '기업 도입 후 근로자 이용', '근무기록 기반 실시간 급여 선정산에 강점'),
  ('ezloan', '이지론', 'finance', 'domestic', 'https://ezloan.io/', '소액·비상금·무직자 대출 등 다양한 상품을 연결해주는 신생 대출 비교·중개 성격의 핀테크 플랫폼이다.', true, null, null, null, '앱 가입·본인인증 후 조회', '소액·비상금·무직자 대출 상품 연결에 강점'),
  ('coway', '코웨이', 'rental', 'domestic', 'https://www.coway.com/', '정수기·공기청정기·매트리스 등 생활가전 렌탈 기업.', false, null, null, null, '렌탈 약정·신용조회 후 계약', '생활가전 렌탈·정기 방문관리에 강점'),
  ('skmagic', 'SK매직', 'rental', 'domestic', 'https://www.skmagic.com/', '주방·생활가전 렌탈·구독 서비스.', false, null, null, null, '렌탈 약정·신용조회 후 계약', '주방·생활가전 렌탈·구독에 강점'),
  ('lge', 'LG전자 구독', 'rental', 'domestic', 'https://www.lge.co.kr/lgekor/microsite/rentalcare/mrcMain.do', 'LG 가전 월 구독·방문 관리 렌탈 서비스.', false, null, null, null, '구독 약정·신용조회 후 계약', 'LG 가전 월 구독·방문 케어에 강점'),
  ('myomee', '롯데렌탈 묘미', 'rental', 'domestic', 'https://www.myomee.com/', '가전·가구·패션 단기~장기 라이프스타일 렌탈.', false, null, null, null, '렌탈 약정 후 계약(단기~장기)', '가전·가구·패션 단기~장기 렌탈에 강점'),
  ('hyundairentalcare', '현대렌탈케어 큐밍', 'rental', 'domestic', 'https://www.hyundairentalcare.com/', '현대백화점 계열 홈케어 가전 렌탈.', false, null, null, null, '렌탈 약정·신용조회 후 계약', '홈케어 가전 렌탈·관리에 강점'),
  ('chungho', '청호나이스', 'rental', 'domestic', 'https://www.chungho.com/', '정수기·공기청정기·안마의자 렌탈 기업.', false, null, null, null, '개인·사업자 신청 후 렌탈 계약(약정 기간)', '정수기·공기청정기·안마의자 렌탈·방문관리'),
  ('hellorental', 'LG헬로렌탈', 'rental', 'domestic', 'https://www.hello-rental.net/', '생활가전·안마의자·매트리스 렌탈·구독.', false, null, null, null, '개인·사업자 신청 후 렌탈·구독 계약', '생활가전·매트리스 폭넓은 렌탈·구독 라인업'),
  ('xn299ar6vqrd', '빌리고', 'rental', 'domestic', 'https://xn--299ar6vqrd.com/', '생활가전·가구·매트리스 월납 렌탈 플랫폼.', false, null, null, null, '가입·신청 후 월납 렌탈 계약', '가전·가구·매트리스 월납 렌탈로 초기비용 완화'),
  ('rentre', '렌트리', 'rental', 'domestic', 'https://rentre.kr/', '가전 렌탈 월요금·조건 비교 견적 플랫폼.', false, null, null, null, '가입 후 렌탈 견적 요청·비교', '가전 렌탈 월요금·조건 비교 견적에 강점'),
  ('closetshare', '클로젯셰어', 'rental', 'domestic', 'https://closetshare.com/', '명품가방·의류 공유·월정액 대여 패션 플랫폼.', false, null, null, null, '가입 후 월정액 구독·대여 신청', '명품 가방·의류 월정액 대여·공유'),
  ('reebonz', '리본즈 렌트잇', 'rental', 'domestic', 'https://www.reebonz.co.kr/', '명품 가방·시계 단기·구독 대여 서비스.', false, null, null, null, '가입 후 대여 신청(보증·심사 가능)', '명품 가방·시계 단기·구독 대여'),
  ('opengallery', '오픈갤러리', 'rental', 'domestic', 'https://www.opengallery.co.kr/', '작가 원화 미술품 3개월 교체 대여·구독.', false, null, null, null, '가입 후 월 구독·작품 대여 신청', '원화 미술품 3개월 교체 대여·공간 연출'),
  ('plan', '쏘카플랜', 'rental', 'domestic', 'https://plan.socar.kr/', '월 구독·기간형 중장기 차량 렌트.', false, null, null, null, '면허·심사 후 구독·렌트 계약', '월 구독·중장기 차량 렌트에 강점'),
  ('thetrive', '더트라이브', 'rental', 'domestic', 'https://thetrive.com/', '수입차 월 구독·관리 자동차 구독 플랫폼.', false, null, null, null, '면허·심사 후 월 구독 계약', '수입차 월 구독, 정비·보험 포함 관리'),
  ('hyundai', '현대 셀렉션', 'rental', 'domestic', 'https://www.hyundai.com/kr/ko/e/', '현대차 월 구독·교체 이용 자동차 구독.', false, null, null, null, '면허·심사 후 월 구독 가입', '현대차 월 구독·차종 교체 이용'),
  ('slrrent', 'SLR렌트', 'rental', 'domestic', 'https://www.slrrent.com/', '카메라·렌즈·촬영장비 단기 대여 전문.', false, null, null, null, '가입·예약 후 대여(보증금 가능)', '카메라·렌즈 촬영장비 단기 대여'),
  ('playslr', '플레이에스엘알', 'rental', 'domestic', 'https://playslr.co.kr/', 'DSLR·미러리스·렌즈 카메라 렌탈 서비스.', false, null, null, null, '가입·예약 후 대여(보증금 가능)', 'DSLR·미러리스·렌즈 렌탈'),
  ('youtuberental', '콩렌탈', 'rental', 'domestic', 'https://youtuberental.com/', '카메라·고프로 등 유튜브 장비 대여.', false, null, null, null, '가입·예약 후 대여', '고프로 등 유튜브 촬영장비 대여'),
  ('hanent', '한렌탈', 'rental', 'domestic', 'https://www.hanent.com/', '카메라·렌즈 촬영장비 대여 업체.', false, null, null, null, '가입·예약 후 대여', '카메라·렌즈 촬영장비 대여'),
  ('rrental', '알렌탈', 'rental', 'domestic', 'https://r-rental.co.kr/', '카메라·조명 촬영장비 대여 서비스.', false, null, null, null, '가입·예약 후 대여', '카메라·조명 촬영장비 대여'),
  ('pacey', '페이시', 'rental', 'domestic', 'https://www.pacey.co.kr/', '노트북·맥북·모니터 IT기기 구독·렌탈.', false, null, null, null, '가입·심사 후 구독·렌탈 계약', '노트북·맥북 등 IT기기 구독·렌탈'),
  ('arthurrental', '아서렌탈', 'rental', 'domestic', 'https://m.arthurrental.com/', '노트북·PC IT기기 기업·개인 대여.', false, null, null, null, '가입·문의 후 대여 계약', '노트북·PC 기업·개인 단기 대여'),
  ('korearental', '한국렌탈', 'rental', 'domestic', 'https://korearental.co.kr/', 'PC·계측기·산업장비 종합 렌탈 기업.', false, null, null, null, '기업 문의·심사 후 렌탈 계약', 'PC·계측기·산업장비 종합 렌탈'),
  ('hilti', '힐티 공구임대', 'rental', 'domestic', 'https://www.hilti.co.kr/', '전동공구 월 사용료 임대·관리 서비스.', false, null, null, null, '기업 계약 후 월 사용료 임대', '전동공구 월정액 임대·관리 프로그램'),
  ('jsrental', 'JS렌탈', 'rental', 'domestic', 'https://jsrental.co.kr/', '행사·이벤트용품 대여 전문 업체.', false, null, null, null, '문의·예약 후 대여 계약', '행사·이벤트용품 대여'),
  ('rentalevent', '이벤트렌탈', 'rental', 'domestic', 'https://rentalevent.com/', '천막·냉난방·전시용품 행사용품 대여.', false, null, null, null, '문의·예약 후 대여 계약', '천막·냉난방·전시 등 행사용품 대여'),
  ('campal', '캠팔', 'rental', 'domestic', 'http://www.campal.co.kr/', '텐트·타프 등 캠핑용품 대여 플랫폼.', false, null, null, null, '가입·예약 후 대여', '텐트·타프 등 캠핑용품 대여'),
  ('camproad', '캠프로드', 'rental', 'domestic', 'https://camp-road.co.kr/', '텐트·캠핑장비 대여 서비스.', false, null, null, null, '가입·예약 후 대여', '텐트·캠핑장비 대여'),
  ('info', '열린옷장', 'rental', 'domestic', 'https://info.theopencloset.net/', '면접·행사용 정장 택배·방문 대여 공유.', false, null, null, null, '가입·예약 후 택배·방문 대여', '면접·행사용 정장 저렴한 대여·공유'),
  ('jjinsuit', '제이진슈트', 'rental', 'domestic', 'https://jjinsuit.com/', '프리미엄 맞춤정장 렌탈 서비스.', false, null, null, null, '예약·방문 후 대여 계약', '프리미엄 맞춤정장 렌탈'),
  ('greant', '그린트', 'rental', 'domestic', 'https://m.greant.co.kr/', '면접·예복 정장 익일배송 렌탈.', false, null, null, null, '가입·예약 후 익일배송 대여', '면접·예복 정장 익일배송 렌탈'),
  ('eshare', '공유누리', 'rental', 'domestic', 'https://www.eshare.go.kr/', '공공기관 공구·기기 공유·대여 정부 플랫폼.', false, null, null, null, '회원가입 후 공공자원 예약·대여', '공공기관 보유 공구·기기·시설 대여'),
  ('ium', '이음(I:UM)', 'office', 'domestic', 'https://www.i-um.co.kr/', '지식산업센터·산업단지 입주 중소기업·제조사를 단지 단위로 잇는 하이퍼로컬 B2B 네트워킹 플랫폼. 협력사·거래처 발굴, 공급망 분석, 기업 홍보·파트너 매칭을 무료 제공.', true, null, null, null, '입주 중소기업·제조사 가입 후 이용(무료)', '단지 단위 협력사·거래처 발굴·파트너 매칭'),
  ('officedepot', '오피스디포', 'office', 'domestic', 'https://www.officedepot.co.kr/', '기업·개인 사무용품·소모품 온라인 쇼핑몰.', false, null, null, null, '사업자·개인 회원가입 후 구매', '사무용품·소모품 온라인 구매'),
  ('officenex', '오피스넥스', 'office', 'domestic', 'https://www.officenex.com/', '잉크·토너·사무기기 사무용품 B2B 쇼핑몰.', false, null, null, null, '사업자·개인 회원가입 후 구매', '잉크·토너·사무기기 소모품 구매'),
  ('ioffice', '아이오피스', 'office', 'domestic', 'http://i-office.co.kr/', '사무용품·비품 온라인 전문몰.', false, null, null, null, '회원가입 후 구매', '사무용품·비품 온라인 구매'),
  ('officezone', '오피스존', 'office', 'domestic', 'https://officezone.co.kr/', '사무용품·문구·비품 종합 쇼핑몰.', false, null, null, null, '회원가입 후 구매', '사무용품·문구·비품 종합 구매'),
  ('modenoffice', '모든오피스', 'office', 'domestic', 'https://www.modenoffice.com/', '사무용품·MRO 시스템 전문 쇼핑몰.', false, null, null, null, '기업 회원가입 후 통합구매/견적', '사무용품·MRO 통합구매 시스템'),
  ('mmarket', '엠마켓', 'office', 'domestic', 'https://www.m-market.net/', '복사용지·공구·안전용품 기업 통합구매몰.', false, null, null, null, '기업 회원가입 후 통합구매', '복사용지·공구·안전용품 기업 통합구매'),
  ('imarket', '아이마켓', 'office', 'domestic', 'https://www.imarket.co.kr/', '사무·산업재·안전용품 기업 전용 쇼핑몰.', false, null, null, null, '기업 회원가입 후 구매/견적', '사무·산업재·안전용품 기업 전용 구매'),
  ('imarketkorea', '아이마켓코리아', 'office', 'domestic', 'https://www.imarketkorea.com/', '기업 소모성자재(MRO) 통합구매대행.', false, null, null, null, '기업 계약·회원 가입 후 통합구매 이용', '대기업 MRO 통합구매대행·소싱 위탁에 강점'),
  ('serveone', '서브원', 'office', 'domestic', 'https://www.serveone.co.kr/', '기업 MRO 구매대행·자재 공급 플랫폼.', false, null, null, null, '기업 계약·회원 가입 후 구매 이용', '대량 MRO 구매대행·자재 공급 통합관리에 강점'),
  ('navimro', '나비엠알오', 'office', 'domestic', 'https://www.navimro.com/', '공구·안전·사무 MRO 기업 전용 쇼핑몰.', false, null, null, null, '사업자등록 후 기업회원 가입·구매', '공구·안전·사무 MRO 기업 전용 원스톱 구매에 강점'),
  ('bipum', '비품넷', 'office', 'domestic', 'https://www.bipum.net/', '청소·위생·사무 기업 비품 쇼핑몰.', false, null, null, null, '사업자등록 후 기업회원 가입·구매', '청소·위생·사무 비품 일괄 조달에 강점'),
  ('koskomro', '코스코엠알오', 'office', 'domestic', 'https://koskomro.com/', '안전용품·공구·소모자재·건자재 MRO 도매몰.', false, null, null, null, '사업자등록 후 가입·구매', '안전용품·공구·건자재 도매가 조달에 강점'),
  ('cretec', '크레텍', 'office', 'domestic', 'https://cretec.kr/', '산업공구 유통 전문 온라인 주문 시스템.', false, null, null, null, '사업자·대리점 가입 후 온라인 주문', '산업공구 유통망·전문 품목 온라인 주문에 강점'),
  ('kr4', '미스미코리아', 'office', 'domestic', 'https://kr.misumi-ec.com/', 'FA·금형 표준부품·간접자재 e카탈로그.', false, null, null, null, '사업자등록 후 회원 가입·카탈로그 주문', 'FA·금형 표준부품 규격 검색·간접자재 소싱에 강점'),
  ('gonggus', '공구닷컴', 'office', 'domestic', 'http://www.gonggus.com/', '산업·작업공구 온라인 공구 쇼핑몰.', false, null, null, null, '가입 후 구매(사업자 혜택 별도)', '산업·작업공구 폭넓은 품목 온라인 구매에 강점'),
  ('gongguro', '공구로', 'office', 'domestic', 'https://www.gongguro.co.kr/', '공구·안전용품·베어링 산업용품 쇼핑몰.', false, null, null, null, '가입 후 구매(사업자 회원 별도)', '공구·안전·베어링 등 산업용품 조달에 강점'),
  ('toolmall', '툴마트', 'office', 'domestic', 'http://www.toolmall.net/', '공구 전문 온라인 쇼핑몰.', false, null, null, null, '가입 후 구매', '공구 전문 품목 온라인 구매에 강점'),
  ('tools24', '툴스24', 'office', 'domestic', 'https://tools24.co.kr/', '절삭·수공구·농기계 공구 전문몰.', false, null, null, null, '가입 후 구매', '절삭·수공구·농기계 공구 전문 조달에 강점'),
  ('yugatool', '공구명가', 'office', 'domestic', 'https://yugatool.co.kr/', '측정기·전동공구·철물 산업용품 쇼핑몰.', false, null, null, null, '가입 후 구매', '측정기·전동공구·철물 산업용품 구매에 강점'),
  ('total09', '토탈공구', 'office', 'domestic', 'https://total09.net/', '작업·측정공구·산업용품 전문몰.', false, null, null, null, '가입 후 구매', '작업·측정공구·산업용품 전문 조달에 강점'),
  ('dntool', '동남툴스', 'office', 'domestic', 'https://dntool.co.kr/', '산업·측정공구 공구 도매 쇼핑몰.', false, null, null, null, '사업자 가입 후 도매 구매', '산업·측정공구 도매가 조달에 강점'),
  ('ggjt', '공구장터', 'office', 'domestic', 'https://www.ggjt.co.kr/', '사업자 공구·산업용품 종합 쇼핑몰.', false, null, null, null, '사업자 가입 후 구매', '공구·산업용품 종합 품목 사업자 구매에 강점'),
  ('dosomarket', '도소마켓', 'office', 'domestic', 'https://dosomarket.com/', '철강·건자재 견적 비교·거래 플랫폼.', false, null, null, null, '사업자등록 후 가입·견적 요청/거래', '철강·건자재 견적 비교·거래 매칭에 강점'),
  ('steellink', '스틸링크', 'office', 'domestic', 'https://www.steellink.kr/', '철강 견적·가격정보 온라인 거래 플랫폼.', false, null, null, null, '사업자등록 후 가입·견적/거래', '철강 실시간 가격정보·온라인 견적 거래에 강점'),
  ('cheolsusee', '철수씨', 'office', 'domestic', 'https://cheolsusee.com/', '철강 직거래 중개 온라인 플랫폼.', false, null, null, null, '사업자등록 후 가입·직거래 요청', '철강 직거래 중개·중간 유통 단축에 강점'),
  ('steelshop', '스틸샵', 'office', 'domestic', 'https://steelshop.com/', '철강재 온라인 거래 플랫폼(동국제강).', false, null, null, null, '사업자등록 후 가입·구매', '동국제강 철강재 직접 온라인 주문에 강점'),
  ('fixit', '픽스잇', 'office', 'domestic', 'https://www.fixit.co.kr/', '자재 공급사·시공업체 연결 건자재 B2B.', false, null, null, null, '사업자등록 후 가입·매칭 이용', '자재 공급사·시공업체 연결 건자재 조달에 강점'),
  ('buildersdepot', '손스', 'office', 'domestic', 'https://buildersdepot.co.kr/', '건축 장식 철물자재 온라인 도매몰.', false, null, null, null, '가입 후 구매(사업자 도매 별도)', '건축 장식 철물자재 도매 조달에 강점'),
  ('jajaemart', '자재마트', 'office', 'domestic', 'https://jajaemart.com/', '금속철물·건축자재 온라인 쇼핑몰.', false, null, null, null, '가입 후 구매', '금속철물·건축자재 온라인 구매에 강점'),
  ('boxmake', '박스공장닷컴', 'office', 'domestic', 'https://www.boxmake.co.kr/', '택배박스·완충재·포장 부자재 도매몰.', false, null, null, null, '가입 후 구매(사업자 도매 별도)', '택배박스·완충재 포장 부자재 도매 조달에 강점'),
  ('boxvill', '박스마을', 'office', 'domestic', 'https://boxvill.com/', '주문제작 박스·포장 부자재 전문몰.', false, null, null, null, '가입 후 주문(제작 문의 별도)', '주문제작 박스·포장 부자재 소량 제작에 강점'),
  ('boxmall', '박스몰', 'office', 'domestic', 'http://www.boxmall.net/', '박스·비닐·포장 부자재 전문 쇼핑몰.', false, null, null, null, '가입 후 구매', '박스·비닐·포장 부자재 일괄 구매에 강점'),
  ('xncmall', '엑스엔씨몰', 'office', 'domestic', 'https://www.xncmall.co.kr/', '택배봉투·박스·테이프 포장 부자재 몰.', false, null, null, null, '가입 후 구매', '택배봉투·박스·테이프 포장 부자재 조달에 강점'),
  ('eleparts', '엘레파츠', 'office', 'domestic', 'https://eleparts.co.kr/', '반도체·모듈·계측기 전자부품 전문몰.', false, null, null, null, '가입 후 구매(사업자 회원 별도)', '반도체·모듈·계측기 전자부품 소싱에 강점'),
  ('devicemart', '디바이스마트', 'office', 'domestic', 'https://www.devicemart.co.kr/', '아두이노·센서·개발보드 전자부품 몰.', false, null, null, null, '가입 후 구매', '아두이노·센서·개발보드 등 개발용 부품 조달에 강점'),
  ('icbanq', '아이씨뱅큐', 'office', 'domestic', 'https://www.icbanq.com/', '반도체·오픈소스HW·전자부품 쇼핑몰.', false, null, null, null, '가입 후 구매', '반도체·오픈소스HW 전자부품 소싱에 강점'),
  ('mechasolution', '메카솔루션', 'office', 'domestic', 'https://mechasolution.com/', '아두이노·임베디드·교육키트 전자부품몰.', false, null, null, null, '가입 후 구매', '아두이노·임베디드·교육키트 조달에 강점'),
  ('cleaniglobal', '크린글로벌', 'office', 'domestic', 'https://cleaniglobal.kr/', '세제·청소도구·건물관리용품 도매몰.', false, null, null, null, '가입 후 구매(사업자 도매 별도)', '세제·청소도구·건물관리용품 도매 조달에 강점'),
  ('ypcity', '용품시티', 'office', 'domestic', 'https://ypcity.co.kr/', '업소용 청소 소모품 도매 쇼핑몰.', false, null, null, null, '가입 후 구매', '업소용 청소 소모품 도매 조달에 강점'),
  ('hnrjh', '하나로종합', 'office', 'domestic', 'https://hnrjh.com/', '학교·건물·관공서 청소용품 도매 납품.', false, null, null, null, '사업자 가입 후 납품 문의·구매', '학교·관공서 청소용품 대량 납품에 강점'),
  ('hansolink', '한솔잉크', 'office', 'domestic', 'https://www.hansolink.com/', '잉크·토너 기업 납품 인쇄소모품 도매몰.', false, null, null, null, '가입 후 구매(사업자 납품 별도)', '잉크·토너 기업 납품 인쇄소모품 조달에 강점'),
  ('printersmall', '프린터스몰', 'office', 'domestic', 'https://www.printersmall.co.kr/', '프린터·복합기·잉크·토너 인쇄소모품몰.', false, null, null, null, '가입 후 구매', '프린터·복합기·잉크·토너 인쇄소모품 조달에 강점'),
  ('916er', '916ER', 'office', 'domestic', 'https://916er.com/', '사무실 인테리어 비교견적과 시공을 연결하는 플랫폼.', false, null, null, null, '비교견적 요청 후 시공사 매칭', '사무실 인테리어 견적 비교·시공 연결에 강점'),
  ('office0u', '오피스공유', 'office', 'domestic', 'https://www.office0u.com/', '공유오피스·사무실 공유 매물을 검색·광고하는 커뮤니티 사이트.', false, null, null, null, '가입 후 매물 등록·광고 게시', '공유오피스·사무실 공유 매물 검색·광고에 강점'),
  ('howmuchisit', '하우머치', 'office', 'domestic', 'https://howmuchisit.kr/', '공유오피스 가격 비교와 입주 지원금을 안내하는 중개 서비스.', false, null, null, null, '입주 상담·견적 요청 후 중개', '공유오피스 가격 비교·입주 지원금 안내에 강점'),
  ('mroofficedepot', '오피스디포 MRO', 'office', 'domestic', 'https://mro-officedepot.co.kr/', '기업 사무용품·비품 통합구매를 대행하는 법인 전용몰.', false, null, null, null, '법인 회원가입 후 구매', '사무용품·비품 통합구매 대행에 강점'),
  ('lalab2b', '라라팬시B2B', 'office', 'domestic', 'https://www.lalab2b.com/', '문구·팬시·사무용품을 사업자에게 도매하는 B2B 쇼핑몰.', false, null, null, null, '사업자등록 후 회원가입', '문구·팬시·사무용품 사업자 도매에 강점'),
  ('themro', 'THEMRO', 'office', 'domestic', 'https://www.themro.co.kr/', '공공기관 대상 소모성자재(MRO) 구매대행 전문 플랫폼.', false, null, null, null, '기관·법인 계약 후 이용', '공공기관 대상 소모성자재 구매대행에 강점'),
  ('adprint', '애드프린트', 'office', 'domestic', 'https://adprint.co.kr/', '명함·스티커·브로셔 등 인쇄물을 소량·대량 주문하는 인쇄 쇼핑몰.', false, null, null, null, '가입 후 주문·시안 제작', '명함·브로셔 등 인쇄물 소량·대량 주문에 강점'),
  ('pojangmall', '착한포장몰', 'office', 'domestic', 'https://pojangmall.co.kr/', '에어캡·완충재 등 포장 자재를 취급하는 도매 쇼핑몰.', false, null, null, null, '가입 후 주문·도매 구매', '에어캡·완충재 등 포장 자재 도매에 강점'),
  ('alwaysbomgift', '늘봄기프트', 'office', 'domestic', 'https://alwaysbomgift.com/', '기업·공공기관 판촉물과 기념품을 제작하는 도매 사이트.', false, null, null, null, '제작 문의·견적 후 주문', '기업·공공기관 판촉물·기념품 제작에 강점'),
  ('panchock', '판촉넷', 'office', 'domestic', 'https://panchock.net/', '기업 판촉물·기념품 제작 주문을 다루는 전문 사이트.', false, null, null, null, '제작 문의·견적 후 주문', '기업 판촉물·기념품 제작 주문에 강점'),
  ('workclo', '웍클로', 'office', 'domestic', 'https://www.workclo.co.kr/', '작업복·근무복·기업 단체복을 맞춤 제작하는 전문 쇼핑몰.', false, null, null, null, '제작 상담·견적 후 주문', '작업복·근무복·기업 단체복 맞춤 제작에 강점'),
  ('clicksports', '클릭스포츠', 'office', 'domestic', 'https://clicksports.co.kr/', '단체복·작업복·단체패딩을 주문 제작하는 쇼핑몰.', false, null, null, null, '제작 상담·견적 후 주문', '단체복·작업복·단체패딩 주문 제작에 강점'),
  ('mintcorn', '민트콘', 'office', 'domestic', 'https://mintcorn.com/', '매장 간판·사인물을 실내외 주문 제작하는 전문 서비스.', false, null, null, null, '제작 상담·현장 실측 후 주문', '매장 간판·사인물 실내외 제작에 강점'),
  ('mysign', '간판친구', 'office', 'domestic', 'https://mysign.kr/', '간판 디자인·설계·제작을 다루는 제작 서비스.', false, null, null, null, '디자인·설계 상담 후 제작', '간판 디자인·설계·제작에 강점'),
  ('dwsafety', '대원안전', 'office', 'domestic', 'http://www.dw-safety.co.kr/', '보호구 등 산업안전용품을 취급하는 안전용품 전문점.', false, null, null, null, '가입 후 주문·구매', '보호구 등 산업안전용품 취급에 강점'),
  ('gunjajae24', '건자재24', 'office', 'domestic', 'http://www.gunjajae24.com/', '건설현장용 건축자재·안전용품·MRO를 도매하는 특판몰.', false, null, null, null, '사업자 회원가입 후 도매 구매', '건설현장 건축자재·안전용품·MRO 도매에 강점'),
  ('b2btool', 'B2B공구도매', 'office', 'domestic', 'https://b2btool.toolpark.kr/', '산업공구·절삭·에어공구 등을 실시간 재고로 도매하는 B2B몰.', false, null, null, null, '사업자 회원가입 후 도매 구매', '산업·절삭·에어공구 실시간 재고 도매에 강점'),
  ('matched', '매치드 Matched', 'office', 'domestic', 'https://matched.biz/', '기업 의사결정권자를 대상으로 B2B 영업 미팅을 매칭하는 서비스.', false, null, null, null, '기업회원 가입 후 미팅 매칭 신청', '기업 의사결정권자 대상 B2B 영업 미팅 매칭에 강점'),
  ('b2bjoinkorea', '비투비조인코리아', 'office', 'domestic', 'https://www.b2bjoinkorea.com/', '제조업 기업정보와 B2B 중개·입찰을 제공하는 플랫폼.', false, null, null, null, '기업회원 가입 후 등록·이용', '제조업 기업정보·B2B 중개·입찰에 강점'),
  ('castingn', '캐스팅엔', 'office', 'domestic', 'https://www.castingn.com/', '기업 간접구매·외주를 전자입찰·전자계약으로 소싱하는 매칭 플랫폼.', false, null, null, null, '기업회원 가입 후 소싱 등록', '간접구매·외주 전자입찰·전자계약 소싱에 강점'),
  ('smartfactoria', '스마트팩토리아', 'office', 'domestic', 'https://smartfactoria.com/', '제조 자동화 수요기업과 로봇·비전·설비 공급사를 연결하는 매칭.', false, null, null, null, '기업회원 가입 후 수요·공급 등록', '제조 자동화 설비·로봇·비전 공급사 매칭에 강점'),
  ('factoryplatform', '팩토리플랫폼', 'office', 'domestic', 'https://www.factory-platform.com/', '식품 제조업체와 발주기업을 무료로 매칭하는 서비스.', false, null, null, null, '무료 가입 후 발주·매칭 이용', '식품 제조업체·발주기업 매칭에 강점'),
  ('workieum', '워키움', 'office', 'domestic', 'https://www.workieum.com/', '제조·외주가공·엔지니어링 전문 업체를 발굴·매칭하는 플랫폼.', false, null, null, null, '기업회원 가입 후 발주·매칭 이용', '제조·외주가공·엔지니어링 업체 발굴 매칭에 강점'),
  ('industrialmarket', '산업마켓', 'office', 'domestic', 'https://industrialmarket.biz/', '중고 기계·설비·공구를 기업 간 직거래하는 플랫폼.', false, null, null, null, '가입 후 매물 등록·직거래', '중고 기계·설비·공구 기업 간 직거래에 강점'),
  ('mc', '다아라기계장터', 'office', 'domestic', 'https://mc.daara.co.kr/', '산업기계·장비를 B2B로 직거래 중개하는 플랫폼.', false, null, null, null, '가입 후 매물 등록·직거래', '산업기계·장비 B2B 직거래 중개에 강점'),
  ('linkmachine', '링크머신', 'office', 'domestic', 'http://linkmachine.co.kr/', '중고기계 매입·판매·시세조회 직거래 플랫폼.', false, null, null, null, '가입 후 매물 등록·시세조회', '중고기계 매입·판매·시세조회 직거래에 강점'),
  ('nextunicorn', '넥스트유니콘', 'office', 'domestic', 'https://www.nextunicorn.kr/', '스타트업과 전문투자자를 연결하는 네트워킹 플랫폼.', false, null, null, null, '가입 후 기업·투자자 프로필 등록', '스타트업·전문투자자 네트워킹에 강점'),
  ('beginmate', '비긴메이트', 'office', 'domestic', 'https://www.beginmate.com/', '공동창업자·초기멤버 팀빌딩을 매칭하는 플랫폼.', false, null, null, null, '가입 후 프로필 등록·매칭 이용', '공동창업자·초기멤버 팀빌딩 매칭에 강점'),
  ('knowwherebridge', '노웨어브릿지', 'office', 'domestic', 'https://knowwherebridge.com/', '해외 파트너·바이어와의 비즈니스 매칭을 돕는 서비스.', false, null, null, null, '기업회원 가입 후 매칭 신청', '해외 파트너·바이어 비즈니스 매칭에 강점'),
  ('cretop', '크레탑', 'office', 'domestic', 'https://www.cretop.com/', '기업 신용·재무 정보를 조회하고 거래처를 발굴하는 서비스.', false, null, null, null, '가입·구독 후 조회 이용', '기업 신용·재무 조회·거래처 발굴에 강점'),
  ('kodata', '한국평가데이터', 'office', 'domestic', 'http://www.kodata.co.kr/', '국내 최대 규모의 기업 신용·산업 데이터를 제공.', false, null, null, null, '가입·구독 후 데이터 조회', '기업 신용·산업 데이터 제공에 강점'),
  ('companymarket', '컴파니마켓', 'office', 'domestic', 'https://www.companymarket.co.kr/', '기업거래·사업체 매매를 중개하는 플랫폼.', false, null, null, null, '가입 후 매물 등록·중개 이용', '기업거래·사업체 매매 중개에 강점'),
  ('kmx', '한국M&A거래소', 'office', 'domestic', 'https://kmx.kr/', '중소기업 M&A 매도·매수를 중개·매칭하는 거래소.', false, null, null, null, '가입 후 매도·매수 등록·매칭', '중소기업 M&A 매도·매수 중개·매칭에 강점'),
  ('fanfandaero', '판판대로', 'office', 'domestic', 'https://fanfandaero.kr/', '중소기업유통센터가 운영하는 판로개척 지원 플랫폼.', false, null, null, null, '중소기업 가입·심사 후 입점', '중소기업 판로개척 지원에 강점'),
  ('kompass', '콤파스코리아', 'office', 'domestic', 'https://kompass.co.kr/', '글로벌 기업 DB 기반 비즈니스 매칭 서비스.', false, null, null, null, '기업회원 가입 후 등록·매칭', '글로벌 기업 DB 기반 비즈니스 매칭에 강점'),
  ('capa', '캐파', 'office', 'domestic', 'https://capa.ai/', 'CNC·판금·사출 등 온라인 제조 견적·발주를 매칭하는 플랫폼.', false, null, null, null, '가입 후 도면 업로드로 견적 요청·발주', 'CNC·판금·사출 등 다품종 제조 견적 비교에 강점'),
  ('baroorder', '바로발주', 'office', 'domestic', 'https://baro-order.com/', '도면 업로드로 AI 실시간 견적 후 외주가공을 발주.', false, null, null, null, '가입 후 도면 업로드로 실시간 견적·발주', 'AI 실시간 견적 기반 외주가공 발주 속도에 강점'),
  ('pltik', '플틱', 'office', 'domestic', 'https://www.pltik.com/', '산업소재 가공 견적을 무료로 비교·요청하는 플랫폼.', false, null, null, null, '가입 후 가공 견적 무료 요청·비교', '산업소재 가공 견적 무료 비교에 강점'),
  ('makeit', '메이크잇', 'office', 'domestic', 'https://makeit.ai.kr/', '도면 업로드 시 AI가 가공 견적을 산출하고 업체를 매칭.', false, null, null, null, '가입 후 도면 업로드로 AI 견적·업체 매칭', 'AI 자동 견적과 가공업체 매칭에 강점'),
  ('make', '샤플메이크', 'office', 'domestic', 'https://make.shapl.com/', '공장 매칭 기반 온라인 제조 비교·견적 플랫폼.', false, null, null, null, '가입 후 도면·사양 입력으로 공장 매칭', '공장 매칭 기반 제조 비교견적에 강점'),
  ('mpnite', '엠피니티', 'office', 'domestic', 'https://mpnite.com/', '3D프린팅·CNC·판금·사출을 비교 견적하는 온라인 제조 플랫폼.', false, null, null, null, '가입 후 도면 업로드로 다공법 비교견적', '3D프린팅·CNC·판금 등 다공법 비교견적에 강점'),
  ('meviy', '메비', 'office', 'domestic', 'https://meviy.misumi-ec.com/ko-kr/', '3D CAD 파일로 판금·절삭 부품을 즉시 견적·주문.', false, null, null, null, '가입 후 3D CAD 업로드로 즉시 견적·주문', '3D CAD 즉시 견적·단납기 부품 조달에 강점'),
  ('ideaaudition', '아이디어오디션', 'office', 'domestic', 'https://www.ideaaudition.com/', '소량 발주를 모아 금형·사출 제조를 중개하는 플랫폼.', false, null, null, null, '가입 후 제작 아이디어·발주 등록', '소량 수요 취합으로 금형·사출 제작에 강점'),
  ('madeall3d', '메이드올', 'office', 'domestic', 'https://madeall3d.com/', '웹 기반 자동화 3D프린팅 출력·소량 제작 서비스.', false, null, null, null, '가입 후 3D 파일 업로드로 출력 주문', '웹 자동화 3D프린팅 소량 제작에 강점'),
  ('castingn2', '캐스팅엔소싱', 'office', 'domestic', 'https://www.castingn.com/sourcing', '기업 간접구매·외주 소싱 견적을 통합하는 플랫폼.', false, null, null, null, '기업 회원 가입 후 소싱 견적 요청', '기업 간접구매·외주 소싱 견적 통합에 강점'),
  ('koreab2b', '코리아B2B', 'office', 'domestic', 'https://www.koreab2b.com/', '제조기업 대상 MRO 구매대행·소싱 인프라 서비스.', false, null, null, null, '기업 회원 가입 후 구매대행·소싱 의뢰', '제조기업 MRO 구매대행·소싱에 강점'),
  ('speedmall', '스피드몰', 'office', 'domestic', 'https://www.speedmall.co.kr/', '기업 소모품·산업용 자재 전문 B2B 쇼핑몰.', false, null, null, null, '사업자 회원 가입 후 자재 구매', '기업 소모품·산업용 자재 조달에 강점'),
  ('esteel4u', '이스틸포유', 'office', 'domestic', 'https://www.esteel4u.com/', '철강 온라인 거래 플랫폼.', false, null, null, null, '사업자 회원 가입 후 철강 거래', '철강재 온라인 거래·조달에 강점'),
  ('sungple', '성플', 'office', 'domestic', 'https://www.sungple.com/', '재생플라스틱 원료 매매·압출·사출 견적 플랫폼.', false, null, null, null, '가입 후 원료 매매·가공 견적 요청', '재생플라스틱 원료 거래·가공 견적에 강점'),
  ('ic114', 'IC114', 'office', 'domestic', 'https://www.ic114.com/', '국내 최대 규모의 전자부품 전문 온라인 쇼핑몰.', false, null, null, null, '사업자 회원 가입 후 부품 구매', '전자부품 검색·구매 조달에 강점'),
  ('samplepcb', '샘플피씨비', 'office', 'domestic', 'https://www.samplepcb.co.kr/', 'PCB 실시간 견적·소량 발주 온라인 플랫폼.', false, null, null, null, '가입 후 PCB 사양 입력으로 견적·발주', 'PCB 소량·시제품 발주에 강점'),
  ('mpgate', '엠피게이트', 'office', 'domestic', 'https://www.mpgate.co.kr/', 'PCB 설계·제작·양산을 원스톱 주문제작하는 서비스.', false, null, null, null, '가입 후 PCB 설계·제작 주문', 'PCB 설계부터 양산까지 원스톱에 강점'),
  ('ecplaza', 'ECPlaza', 'global', 'domestic', 'https://www.ecplaza.net', '다국어를 지원하는 글로벌 B2B 무역 마켓플레이스.', false, null, null, null, '사업자 회원 가입 후 상품·기업 등록', '다국어 지원 글로벌 무역 바이어 발굴에 강점'),
  ('rinda', '린다', 'global', 'domestic', 'https://www.rinda.ai', 'AI로 해외 바이어를 발굴하고 콜드메일 영업을 자동화하는 수출 SaaS.', false, null, null, null, '가입 후 구독으로 바이어 발굴 사용', 'AI 해외 바이어 발굴·콜드메일 자동화에 강점'),
  ('tradlinx', '트레드링스', 'fulfillment', 'domestic', 'https://www.tradlinx.com', '수출입 물류비 비교견적·화물추적·포워딩을 중개하는 물류 플랫폼.', false, null, null, null, '가입 후 물류 견적 비교·포워딩 의뢰', '수출입 물류비 비교·화물추적에 강점'),
  ('utradehub', '유트레이드허브', 'global', 'domestic', 'https://www.utradehub.or.kr', '국가전자무역 플랫폼으로 무역서류·통관·결제를 원스톱 처리.', false, null, null, null, '무역업체 회원 가입 후 전자무역 이용', '무역서류·통관·결제 원스톱 처리에 강점'),
  ('sourcingchina', '소싱차이나', 'global', 'domestic', 'https://sourcingchina.co.kr', '중국 OEM/ODM 소싱·수입통관·물류를 대행하는 수입 소싱 플랫폼.', false, null, null, null, '가입 후 소싱·수입 대행 의뢰', '중국 OEM/ODM 소싱·수입통관 대행에 강점'),
  ('g2b', '나라장터', 'office', 'domestic', 'https://www.g2b.go.kr', '조달청이 운영하는 국가종합전자조달 시스템(공공입찰·쇼핑몰).', false, null, null, null, '사업자 등록 후 조달청 입찰 참가등록 필요', '공공입찰·조달 참여의 공식 창구에 강점'),
  ('g2bplus', '지투비플러스', 'office', 'domestic', 'https://www.g2bplus.kr', '나라장터 입찰·낙찰정보를 AI로 분석·알림하는 공공조달 서비스.', false, null, null, null, '가입 후 구독으로 입찰분석·알림 사용', '공공입찰 정보 AI 분석·알림에 강점'),
  ('kbid', '케이비드', 'office', 'domestic', 'https://www.kbid.co.kr', '공공·민간 입찰공고를 통합 검색·제공하는 입찰정보 서비스.', false, null, null, null, '가입 후 구독으로 입찰정보 열람', '공공·민간 입찰공고 통합 검색에 강점'),
  ('modoobid', '모두입찰', 'office', 'domestic', 'https://www.modoobid.co.kr', '빅데이터 기반 전자입찰 분석·투찰가 산출을 지원하는 서비스.', false, null, null, null, '가입 후 구독으로 입찰분석·투찰가 산출', '빅데이터 투찰가 산출·입찰분석에 강점'),
  ('marketbom', '마켓봄', 'food', 'domestic', 'https://marketbom.com/', '식자재 유통사와 거래처를 잇는 B2B 수발주 관리 플랫폼.', false, null, null, null, '유통사·거래처 가입 후 수발주 관리', '식자재 유통 수발주·거래처 관리에 강점'),
  ('foodspring', '식봄', 'food', 'domestic', 'https://www.foodspring.co.kr/', '외식 사장님 대상 식자재 오픈마켓, 익일배송.', false, null, null, null, '사업자 회원 가입 후 식자재 주문', '외식업 식자재 오픈마켓·익일배송에 강점'),
  ('kitchenboard', '키친보드', 'food', 'domestic', 'https://kitchenboard.co.kr/', '식당 식자재 주문·비용관리 및 유통사 연결 서비스.', false, null, null, null, '식당 회원 가입 후 주문·비용관리', '식당 식자재 주문·비용관리에 강점'),
  ('orderplus', '오더플러스', 'food', 'domestic', 'https://www.orderplus.io/', '식당 식자재 가격을 비교·주문하는 B2B 플랫폼.', false, null, null, null, '사업자 회원 가입 후 가격 비교·주문', '식자재 가격 비교·주문에 강점'),
  ('parado', '파라도', 'food', 'domestic', 'https://parado.co.kr/', '식당 대상 산지직송 온라인 식자재 도매몰.', false, null, null, null, '사업자 회원 가입 후 식자재 주문', '산지직송 식자재 도매 조달에 강점'),
  ('orderhero', '오더히어로', 'food', 'domestic', 'http://orderhero.co.kr/', '음식점 식자재를 통합 직매입·유통·발주하는 플랫폼.', false, null, null, null, '사업자 회원 가입 후 식자재 발주', '직매입 기반 식자재 통합 발주에 강점'),
  ('kafb2b', '카프비투비', 'food', 'domestic', 'https://kafb2b.or.kr/', 'aT가 운영하는 전국단위 농수산물 온라인 공영도매시장.', false, null, null, null, '사업자·중도매인 가입 후 도매 거래', '농수산물 온라인 공영도매 거래에 강점'),
  ('luckyfresh', '행운프레시', 'food', 'domestic', 'https://luckyfresh.co.kr/', '과일·농산물 B2B 도매 위탁판매와 자동발주 서비스.', false, null, null, null, '사업자 회원 가입 후 도매 주문·발주', '과일·농산물 도매 위탁판매·자동발주에 강점'),
  ('odyb2b', '오대양몰', 'food', 'domestic', 'https://odyb2b.co.kr/', '사업자 전용 냉동수산물 B2B 도매 전문몰.', false, null, null, null, '사업자 회원 가입 후 수산물 도매 주문', '냉동수산물 B2B 도매 조달에 강점'),
  ('koke', '코케비즈', 'food', 'domestic', 'https://biz.koke.kr/', '카페·식당 대상 원두·용품 납품 도매 플랫폼.', false, null, null, null, '사업자등록 후 도매 거래처 가입', '카페·식당 대상 원두·용품 도매 납품에 강점'),
  ('coffeeb2b', '커피비투비', 'food', 'domestic', 'https://coffeeb2b.co.kr/', '원두·시럽 등 카페 원부자재 B2B 도매몰.', false, null, null, null, '사업자등록 후 도매 회원가입', '원두·시럽 등 카페 원부자재 소싱에 강점'),
  ('baljuora', '발주오라', 'wholesale', 'domestic', 'https://baljuora.com/', '거래처 주문·정산·발주를 자동화하는 B2B 유통 솔루션.', false, null, null, null, '도입 문의·계약 후 이용', '거래처 주문·정산·발주 자동화에 강점'),
  ('baljumoa', '발주모아', 'wholesale', 'domestic', 'https://www.baljumoa.com/', '온라인 유통 판매를 통합관리·발주하는 솔루션.', false, null, null, null, '가입·계약 후 이용', '온라인 유통 판매 통합관리·발주에 강점'),
  ('cmtstory', '화장품스토리', 'wholesale', 'domestic', 'https://m.cmtstory.com/', 'K-뷰티 화장품 도매·위탁판매 B2B 플랫폼.', false, null, null, null, '사업자등록 후 도매 회원가입', 'K-뷰티 화장품 도매·위탁판매 소싱에 강점'),
  ('beautydome', '뷰티돔', 'wholesale', 'domestic', 'https://www.beautydome.co.kr/', '화장품 종합 도매 B2B 쇼핑몰.', false, null, null, null, '사업자등록 후 도매 회원가입', '화장품 종합 도매 소싱에 강점'),
  ('realflower', '리얼플라워', 'wholesale', 'domestic', 'https://realflower.co.kr/', '생화 도매 위탁·배송 B2B 플랫폼.', false, null, null, null, '사업자등록 후 도매 회원가입', '생화 도매 위탁·배송에 강점'),
  ('bizinfo', '기업마당', 'office', 'domestic', 'https://www.bizinfo.go.kr/', '중소기업·소상공인 정부지원사업 공고를 모은 통합 포털.', false, null, null, null, '무료 가입·기업 인증 후 이용', '중소기업·소상공인 정부지원사업 공고 통합 조회에 강점'),
  ('smes', '중소벤처24', 'office', 'domestic', 'https://www.smes.go.kr/', '중소벤처기업 지원사업을 조회·신청하는 통합 포털.', false, null, null, null, '회원가입·사업자 인증 후 신청', '중소벤처기업 지원사업 조회·온라인 신청에 강점'),
  ('kstartup', '케이스타트업', 'office', 'domestic', 'https://www.k-startup.go.kr/', '창업·스타트업 정부지원사업 정보를 제공하는 포털.', false, null, null, null, '회원가입 후 이용', '창업·스타트업 정부지원사업 정보 제공에 강점'),
  ('tigris', '티그리스', 'office', 'domestic', 'https://tigris.cloud/gov-promote', '정부지원사업을 검색·관리하는 업무 플랫폼.', false, null, null, null, '가입 후 이용', '정부지원사업 검색·관리에 강점'),
  ('kfund', '케이펀드', 'office', 'domestic', 'https://kfund.ai/', '정부지원사업 공고를 맞춤 알림해 주는 서비스.', false, null, null, null, '가입 후 조건 설정·알림 수신', '정부지원사업 공고 맞춤 알림에 강점'),
  ('works', '커넥트웍스', 'office', 'domestic', 'https://works.connect24.kr/', '정부지원사업을 통합 조회·관리하는 플랫폼.', false, null, null, null, '가입 후 이용', '정부지원사업 통합 조회·관리에 강점'),
  ('winkstone', '윙크스톤파트너스', 'finance', 'domestic', 'https://www.winkstone.com/', '중소사업자 대상 B2B 대출·BNPL 금융 서비스.', false, null, null, null, '사업자 심사 후 이용', '중소사업자 대상 B2B 대출·BNPL 금융 제공에 강점'),
  ('loanboss', '로안보스', 'finance', 'domestic', 'https://loanboss.isweb.co.kr/', '소상공인·중소기업 사업자대출 비교 플랫폼.', false, null, null, null, '사업자 정보 입력 후 비교·상담', '소상공인·중소기업 사업자대출 비교에 강점'),
  ('thevc', '더브이씨', 'office', 'domestic', 'https://thevc.kr/', '한국 스타트업 투자·지원사업 데이터베이스.', false, null, null, null, '가입 후 데이터 조회', '국내 스타트업 투자·지원사업 데이터 조회에 강점'),
  ('startupplus', '스타트업플러스', 'office', 'domestic', 'https://startup-plus.kr/', '스타트업과 투자자를 연결하는 투자 매칭 플랫폼.', false, null, null, null, '가입·프로필 등록 후 이용', '스타트업과 투자자 매칭에 강점'),
  ('barobill', '바로빌', 'finance', 'domestic', 'https://www.barobill.co.kr/', '전자세금계산서 발급·역발행을 대행하는 서비스.', false, null, null, null, '사업자 가입 후 이용', '전자세금계산서 발급·역발행 대행에 강점'),
  ('popbill', '팝빌', 'finance', 'domestic', 'https://www.popbill.com/', '전자세금계산서 대량발행 API·플랫폼.', false, null, null, null, '사업자 가입·API 연동 후 이용', '전자세금계산서 대량발행 API 연동에 강점'),
  ('factoring', '위하고팩토링', 'finance', 'domestic', 'https://factoring.wehago.com/', '중소기업 매출채권 팩토링 자금조달 서비스.', false, null, null, null, '사업자 심사 후 이용', '중소기업 매출채권 팩토링 자금조달에 강점'),
  ('sellerline', '셀러라인', 'finance', 'domestic', 'https://www.sellerline.co.kr/', '온라인 셀러 맞춤 선정산 서비스.', false, null, null, null, '온라인 셀러 가입·심사 후 이용', '온라인 셀러 맞춤 선정산 자금화에 강점'),
  ('allra', '올라', 'finance', 'domestic', 'https://allra.co.kr/', '온라인 셀러 자금관리·선정산 서비스.', false, null, null, null, '온라인 셀러 가입 후 이용', '온라인 셀러 자금관리·선정산에 강점'),
  ('home3', '바이나우', 'finance', 'domestic', 'https://home.buy-now.kr/', '쇼핑몰 매출 기반 선정산 자금화 서비스.', false, null, null, null, '쇼핑몰 연동·심사 후 이용', '쇼핑몰 매출 기반 선정산 자금화에 강점'),
  ('ofin', '오핀', 'finance', 'domestic', 'https://ofin.co.kr/', 'B2B 후불결제·즉시정산 솔루션.', false, null, null, null, '사업자 가입·심사 후 이용', 'B2B 후불결제·즉시정산에 강점'),
  ('gowid', '고위드', 'office', 'domestic', 'https://www.gowid.com/', '법인카드·지출관리·SaaS 혜택을 묶은 금융 플랫폼.', false, null, null, null, '법인 가입·심사 후 발급', '법인카드·지출관리·SaaS 혜택 통합에 강점'),
  ('spendit', '스팬딧', 'office', 'domestic', 'https://www.spendit.kr/', '스타트업 법인카드·경비 지출관리 서비스.', false, null, null, null, '법인 가입 후 이용', '스타트업 법인카드·경비 지출관리에 강점'),
  ('unipost', '유니포스트', 'office', 'domestic', 'https://unipost.co.kr/', '임직원 경비지출 디지털 증빙을 관리하는 SaaS.', false, null, null, null, '도입 문의·계약 후 이용', '임직원 경비지출 디지털 증빙 관리에 강점'),
  ('granter', '그랜터', 'office', 'domestic', 'https://granter.biz/', '스타트업 AI 재무·회계 자동화 솔루션.', false, null, null, null, '가입·계약 후 이용', '스타트업 AI 재무·회계 자동화에 강점'),
  ('scordi', '스코디', 'office', 'domestic', 'https://scordi.io/', '기업 SaaS 구독을 통합관리·비용분석하는 플랫폼.', false, null, null, null, '가입 후 SaaS 연동·이용', '기업 SaaS 구독 통합관리·비용분석에 강점'),
  ('smply', '에스엠플리', 'office', 'domestic', 'https://www.smply.one/', '사내 SaaS 사용·결제 현황을 관리하는 서비스.', false, null, null, null, '가입 후 이용', '사내 SaaS 사용·결제 현황 관리에 강점'),
  ('flex', '플렉스', 'office', 'domestic', 'https://flex.team/', '근태·급여·인사를 통합하는 HR SaaS 플랫폼.', false, null, null, null, '도입 문의·계약 후 이용', '근태·급여·인사 통합 HR 관리에 강점'),
  ('ustracloud', '유스트라', 'office', 'domestic', 'https://www.ustracloud.com/', '인사·근태·급여를 통합하는 클라우드 HR 솔루션.', false, null, null, null, '도입 문의·계약 후 이용', '인사·근태·급여 클라우드 통합 관리에 강점'),
  ('quotabook', '쿼타북', 'office', 'domestic', 'https://quotabook.com/', '비상장기업 주주명부·증권을 관리하는 SaaS.', false, null, null, null, '가입·계약 후 이용', '비상장기업 주주명부·증권 관리에 강점'),
  ('lezhin', '레진코믹스', 'content', 'domestic', 'https://www.lezhin.com', '유료 결제 모델 기반 웹툰 플랫폼.', false, null, null, null, '작가 심사·계약 후 연재', '유료 결제 기반 웹툰 연재·수익화에 강점'),
  ('muzeplatform', '뮤즈플랫폼', 'content', 'domestic', 'https://www.muzeplatform.com', '국내외 사이트로 음원을 유통하는 플랫폼.', false, null, null, null, '가입 후 음원 등록·유통', '국내외 사이트로 음원 유통에 강점'),
  ('topport', '탑포트', 'assets', 'domestic', 'https://www.topport.io', '작가 작품 중심 NFT 아트 마켓플레이스.', false, null, null, null, '작가 등록·심사 후 작품 발행', 'NFT 기반 디지털 아트 발행·거래에 강점'),
  ('weverse', '위버스', 'social', 'domestic', 'https://weverse.io', '하이브의 글로벌 팬덤 커뮤니티 플랫폼.', false, null, null, null, '아티스트·기획사 협의 입점, 팬은 가입 후 이용', '글로벌 팬덤 커뮤니티·팬 콘텐츠 연계에 강점'),
  ('artmug', '아트머그', 'handmade', 'domestic', 'https://artmug.kr', '일러스트·Live2D 창작 외주·커미션 플랫폼.', false, null, null, null, '작가·의뢰자 가입 후 프로필 등록', '일러스트·Live2D 창작 외주·커미션 매칭에 강점'),
  ('learningspoons', '러닝스푼즈', 'content', 'domestic', 'https://learningspoons.com', '데이터·마케팅·금융 등 직장인 직무교육 플랫폼.', false, null, null, null, '수강생 가입, 강사는 제안·심사 후 개설', '데이터·마케팅·금융 실무 직무교육에 강점'),
  ('programmers', '프로그래머스', 'content', 'domestic', 'https://programmers.co.kr', '코딩테스트·데브코스 개발자 취업 교육 플랫폼.', false, null, null, null, '가입 후 코딩테스트·강의 이용', '코딩테스트·개발자 취업 교육에 강점'),
  ('wecode', '위코드', 'content', 'domestic', 'https://wecode.co.kr', '개발자 양성 코딩 부트캠프.', false, null, null, null, '지원·선발 후 부트캠프 수강', '개발자 양성 집중 부트캠프에 강점'),
  ('supercoding', '슈퍼코딩', 'content', 'domestic', 'https://supercoding.net', '관리형 개발자 취업 코딩 부트캠프 플랫폼.', false, null, null, null, '지원·등록 후 수강', '관리형 개발자 취업 부트캠프에 강점'),
  ('speak', '스픽', 'content', 'domestic', 'https://www.speak.com/ko', 'AI 음성인식 기반 영어 스피킹 학습 앱.', false, null, null, null, '가입 후 구독·이용(체험 대개 제공)', 'AI 음성인식 기반 영어 스피킹 훈련에 강점'),
  ('cambly', '캠블리', 'content', 'domestic', 'https://www.cambly.com', '원어민 1:1 화상 영어회화 학습 플랫폼.', false, null, null, null, '가입 후 구독 이용, 튜터는 지원·등록', '원어민 1:1 화상 영어회화에 강점'),
  ('ringleplus', '링글', 'content', 'domestic', 'https://www.ringleplus.com/ko', '원어민 1:1 화상영어·AI 스피킹 학습 플랫폼.', false, null, null, null, '가입 후 수업 예약·구독', '원어민 1:1 화상영어·AI 스피킹에 강점'),
  ('ebsi', 'EBSi', 'content', 'domestic', 'https://www.ebsi.co.kr', '고교 대표 인터넷 강의 학습 플랫폼.', false, null, null, null, '가입 후 무료·유료 강의 수강', '고교 인터넷 강의·수능 대비에 강점'),
  ('kimstudy', '김과외', 'freelance', 'domestic', 'https://kimstudy.com', '대한민국 대표 과외 매칭 플랫폼.', false, null, null, null, '학생·교사 가입 후 매칭', '과외 교사 매칭에 강점'),
  ('qanda', '콴다과외', 'freelance', 'domestic', 'https://class.qanda.ai', '검증 선생님 1:1 맞춤 온라인 과외 매칭 앱.', false, null, null, null, '학생·교사 가입 후 매칭', '검증 교사 1:1 온라인 과외 매칭에 강점'),
  ('gawebada', '과외바다', 'freelance', 'domestic', 'https://www.gawebada.com', '중개 수수료 0% 과외 매칭 플랫폼.', false, 'low', '중개 수수료 0% 표방', null, '학생·교사 가입 후 직접 매칭', '수수료 없는 과외 직접 매칭에 강점'),
  ('wjthinkbig', '웅진씽크빅', 'kids', 'domestic', 'https://www.wjthinkbig.com', 'AI 맞춤학습 초등 스마트학습 플랫폼.', false, null, null, null, '구독 신청·학습기기 이용', 'AI 맞춤 초등 스마트학습에 강점'),
  ('milkt', '밀크티', 'kids', 'domestic', 'https://www.milkt.co.kr', '천재교육 초등 화상관리형 스마트학습 플랫폼.', false, null, null, null, '구독 신청·학습기기 이용', '화상관리형 초등 스마트학습에 강점'),
  ('symentor', '시멘토', 'kids', 'domestic', 'https://app.symentor.co.kr', '한글·영어·창의력 게임형 유아 학습 앱.', false, null, null, null, '가입 후 앱 구독·이용', '게임형 유아 한글·영어 학습에 강점'),
  ('mydoctor', '나만의닥터', 'beautyhealth', 'domestic', 'https://my-doctor.io/', '비대면 진료·약국찾기·병원예약 앱.', false, null, null, null, '가입 후 이용, 병원·약국은 제휴', '비대면 진료·약국찾기·병원예약 연계에 강점'),
  ('platpharm', '플랫팜', 'beautyhealth', 'domestic', 'https://www.platpharm.co.kr/', '약국 의약품 거래·주문·정산 플랫폼.', false, null, null, null, '약국 사업자 등록 후 이용', '약국 의약품 거래·주문·정산에 강점'),
  ('hihealth', '검진하이', 'beautyhealth', 'domestic', 'https://www.hihealth.co.kr/', '종합건강검진 할인·실시간 예약 플랫폼.', false, null, null, null, '가입 후 예약, 검진기관은 제휴', '건강검진 할인·실시간 예약에 강점'),
  ('drdiary', '닥터다이어리', 'beautyhealth', 'domestic', 'https://drdiary.co.kr/', '혈당·혈압·당뇨 등 만성질환 관리 앱.', false, null, null, null, '가입 후 앱 이용', '혈당·당뇨 등 만성질환 자가관리에 강점'),
  ('caring', '케어링', 'homeservice', 'domestic', 'https://caring.co.kr/', '방문요양·가족요양·주간보호 돌봄 서비스.', false, null, null, null, '이용자 상담 신청, 요양보호사는 등록', '방문요양·재가 돌봄 서비스에 강점'),
  ('neofect', '네오펙트', 'homeservice', 'domestic', 'https://www.neofect.com/kr', 'AI 재활·홈 재활훈련 헬스케어 플랫폼.', false, null, null, null, '가입·기기 이용', 'AI 홈 재활훈련 헬스케어에 강점'),
  ('edgc', 'EDGC', 'beautyhealth', 'domestic', 'https://www.edgc.com/kor/', '유전자 검사 기반 바이오 헬스케어 기업.', false, null, null, null, null, '유전자 검사 기반 바이오 헬스케어에 강점'),
  ('pilly', '필리', 'beautyhealth', 'domestic', 'https://pilly.kr/', '1:1 맞춤 영양제 정기구독 서비스.', false, null, null, null, '문진 후 구독 신청', '1:1 맞춤 영양제 정기구독에 강점'),
  ('iamiam', '아이엠', 'beautyhealth', 'domestic', 'https://iam-iam.com/', 'AI 분석 맞춤형 건강기능식품 구독.', false, null, null, null, '문진·분석 후 구독 신청', 'AI 분석 맞춤 건강기능식품 구독에 강점'),
  ('fitamin', '핏타민', 'beautyhealth', 'domestic', 'https://www.fitamin.kr/', '약사 상담 맞춤 영양제 구독 서비스.', false, null, null, null, '약사 상담 후 구독 신청', '약사 상담 맞춤 영양제 구독에 강점'),
  ('rallit', '랠릿', 'jobs', 'domestic', 'https://www.rallit.com/', '프로그래머스가 운영하는 IT 인재 채용 플랫폼.', false, null, null, null, '구직자 가입·프로필 등록, 기업은 채용 등록', 'IT 인재 채용·프로필 매칭에 강점'),
  ('jobda', '잡다', 'jobs', 'domestic', 'https://www.jobda.im/', '역량검사 기반으로 매칭하는 취업 플랫폼.', false, null, null, null, '구직자 가입·역량검사 응시, 기업은 채용 등록', '역량검사 기반 취업 매칭에 강점'),
  ('sherlockn', '셜록N', 'jobs', 'domestic', 'https://sherlockn.incruit.com/', '헤드헌터가 인재를 추천하는 헤드헌팅 플랫폼.', false, null, null, null, '구직자 가입, 헤드헌터가 추천', '헤드헌터 인재 추천 매칭에 강점'),
  ('hiddenscout', '히든스카우트', 'jobs', 'domestic', 'https://www.hiddenscout.co.kr/', '다수 헤드헌터가 인재를 추천하는 플랫폼.', false, null, null, null, '구직자 가입, 다수 헤드헌터가 추천', '다수 헤드헌터 경쟁 추천에 강점'),
  ('bzpp', '비즈니스피플', 'jobs', 'domestic', 'https://www.bzpp.co.kr/', '임원·경력직 핵심인재 채용 플랫폼.', false, null, null, null, '구직자 가입·프로필 등록, 기업은 채용 등록', '임원·경력직 핵심인재 채용에 강점'),
  ('dongnealba', '동네알바', 'jobs', 'domestic', 'https://www.dongnealba.com/', '사장이 먼저 제안하는 우리동네 알바 앱.', false, null, null, null, '구직자·사장 가입 후 이용', '지역 기반 알바 역제안 매칭에 강점'),
  ('connectin', '커넥틴', 'jobs', 'domestic', 'https://www.connec-tin.com/', '건설 근로자와 현장을 잇는 인력 중개 플랫폼.', false, null, null, null, '근로자·현장 가입 후 매칭', '건설 근로자·현장 인력 중개에 강점'),
  ('workmeet', '워크밋', 'jobs', 'domestic', 'https://www.workmeet.co.kr/', '일용직 구인구직 인력 매칭 플랫폼.', false, null, null, null, '근로자·구인자 가입 후 매칭', '일용직 구인구직 인력 매칭에 강점'),
  ('jobploy', '잡플로이', 'jobs', 'domestic', 'https://www.jobploy.kr/', '외국인 근로자 맞춤 일자리 매칭 플랫폼.', false, null, null, null, '구인기업 가입 후 채용공고 등록(구직자 무료)', '외국인 근로자 채용 매칭에 특화'),
  ('itdaa', '잇다', 'jobs', 'domestic', 'https://www.itdaa.net/', '현직자와 함께하는 취업 멘토링 플랫폼.', false, null, null, null, '가입 후 멘토·멘티 프로필 등록', '현직자 멘토링 기반 취업 준비 지원'),
  ('thehelper', '헬퍼', 'homeservice', 'domestic', 'https://www.thehelper.io/', '보호자가 간병인을 직접 고르는 매칭 플랫폼.', false, null, null, null, '보호자·간병인 가입 후 매칭 이용', '보호자가 간병인을 직접 고르는 매칭'),
  ('carenation', '케어네이션', 'homeservice', 'domestic', 'https://www.carenation.kr/', '간병·돌봄 매칭 앱.', false, null, null, null, '앱 가입 후 간병 요청·인력 등록', '간병·돌봄 인력 매칭에 강점'),
  ('ninehire', '나인하이어', 'office', 'domestic', 'https://www.ninehire.com/', '채용 전 과정 자동화 올인원 ATS 솔루션.', false, null, null, null, '가입 후 사용(무료 플랜 제공)', '채용 전 과정 자동화 올인원 ATS'),
  ('jiwon', '지원전에', 'office', 'domestic', 'https://jiwon.app/', '채용 플랫폼 통합관리·스카우트 SaaS.', false, null, null, null, '가입 후 사용', '채용 플랫폼 통합관리·스카우트 지원'),
  ('mobiletax', '모바일택스', 'legaltax', 'domestic', 'https://mobiletax.kr/', '1:1 세무사 배정 모바일 세무대리 앱.', false, null, null, null, '앱 가입 후 세무사 배정 신청', '1:1 세무사 배정 모바일 세무대리'),
  ('gommark', '곰마크', 'legaltax', 'domestic', 'https://www.gommark.com/', '온라인 상표·특허 등록 대행 서비스.', false, null, null, null, '가입 후 출원 의뢰', '온라인 상표·특허 출원 대행'),
  ('widsign', '위드싸인', 'office', 'domestic', 'https://www.widsign.com/', '클라우드 전자계약·본인인증 플랫폼.', false, null, null, null, '가입 후 계약서 발송(무료 플랜 대개 제공)', '클라우드 전자계약·본인인증'),
  ('ucansign', '유캔싸인', 'office', 'domestic', 'https://ucansign.com/', '저비용 전자계약 솔루션.', false, null, null, null, '가입 후 사용', '저비용 전자계약에 강점'),
  ('hancomsign', '한컴싸인', 'office', 'domestic', 'https://www.hancomsign.com/', '한글과컴퓨터의 전자계약·서명 서비스.', false, null, null, null, '가입 후 사용', '한컴 문서 연계 전자계약·서명'),
  ('donue', '도뉴', 'office', 'domestic', 'https://donue.co.kr/', '인증서 없이 쓰는 간편 전자계약 서비스.', false, null, null, null, '가입 후 사용', '인증서 없이 쓰는 간편 전자계약'),
  ('matazoo', '마타주', 'fulfillment', 'domestic', 'https://matazoo.net/', '개당 단위 픽업·보관 개인 짐 보관 서비스.', false, null, null, null, '가입 후 보관 신청', '개당 단위 픽업·보관 짐 보관'),
  ('sendy', '센디', 'delivery', 'domestic', 'https://sendy.ai/', 'AI 기반 용달·화물 운송 매칭·정산 플랫폼.', false, null, null, null, '화주·차주 가입 후 이용', '용달·화물 운송 매칭·정산에 강점'),
  ('kurlynextmile', '컬리넥스트마일', 'delivery', 'domestic', 'https://www.kurlynextmile.com/', '콜드체인 새벽배송 라스트마일 운송 서비스.', false, null, null, null, '화주 기업 제휴·운송 문의', '콜드체인 새벽배송 라스트마일 운송'),
  ('goodsflow', '굿스플로', 'office', 'domestic', 'https://www.goodsflow.com/', '주문수집·배송추적·반품자동화 SCM 솔루션.', false, null, null, null, '가입 후 쇼핑몰 연동 사용', '주문수집·배송추적·반품 자동화 SCM'),
  ('btorage', '비토리지', 'global', 'domestic', 'https://btorage.com/', '한국상품 전세계 역구매·배송대행 플랫폼.', false, null, null, null, '가입 후 주문·배송대행 이용', '한국상품 해외 역구매·배송대행'),
  ('tagby', '태그바이', 'social', 'domestic', 'https://tagby.io/', '인플루언서 체험단 모집·운영 올인원 마케팅 플랫폼.', false, null, null, null, '광고주 가입 후 캠페인 등록', '인플루언서 체험단 모집·운영 올인원'),
  ('brickc', '브릭씨', 'social', 'domestic', 'https://biz.brick-c.com/', '인플루언서 마케팅 캠페인 운영 플랫폼.', false, null, null, null, '광고주 가입 후 캠페인 등록', '인플루언서 마케팅 캠페인 운영'),
  ('itfl', '잇플루언서', 'social', 'domestic', 'https://itfl.io/', '브랜드와 인플루언서를 연결하는 매칭 플랫폼.', false, null, null, null, '광고주·인플루언서 가입 후 이용', '브랜드-인플루언서 매칭'),
  ('assaview', '아싸뷰', 'social', 'domestic', 'https://assaview.co.kr/', '블로그·인스타 체험단 리뷰 마케팅 플랫폼.', false, null, null, null, '광고주 가입 후 체험단 모집', '블로그·인스타 체험단 리뷰 마케팅'),
  ('realreview', '리얼리뷰', 'social', 'domestic', 'https://www.real-review.kr/', '체험단·인플루언서 리뷰 마케팅 플랫폼.', false, null, null, null, '광고주 가입 후 캠페인 등록', '체험단·인플루언서 리뷰 마케팅'),
  ('reviewnote', '리뷰노트', 'social', 'domestic', 'https://www.reviewnote.co.kr/', '블로그·인스타·유튜브 체험단 운영 플랫폼.', false, null, null, null, '광고주 가입 후 체험단 모집', '블로그·인스타·유튜브 체험단 운영'),
  ('stylec', '스타일씨', 'social', 'domestic', 'https://www.stylec.co.kr/', '블로그 체험단 모집·신청 플랫폼.', false, null, null, null, '가입 후 체험단 모집·신청', '블로그 체험단 모집·신청'),
  ('brixcorp', '브릭스', 'social', 'domestic', 'https://brixcorp.net/', '인플루언서 공동구매 모집·판매 대행 플랫폼.', false, null, null, null, '가입 후 공동구매 이용', '인플루언서 공동구매 모집·판매 대행'),
  ('flexmatch', '플렉스매치', 'social', 'domestic', 'https://www.flexmatch.kr/', '크리에이터 공동구매·협찬 매칭 플랫폼.', false, null, null, null, '가입 후 매칭 이용', '크리에이터 공동구매·협찬 매칭'),
  ('srookpay', '스룩페이', 'social', 'domestic', 'https://srookpay.com/', 'SNS 공동구매 간편결제·판매관리 솔루션.', false, null, null, null, '판매자 가입 후 사용', 'SNS 공동구매 간편결제·판매관리'),
  ('celebtion', '셀럽션', 'social', 'domestic', 'https://www.celebtion.com/', '인플루언서 공동구매 중개·정산 플랫폼.', false, null, null, null, '가입 후 공동구매 이용', '인플루언서 공동구매 중개·정산'),
  ('popomon', '포포몬', 'social', 'domestic', 'https://popomon.com/', '인플루언서 체험단 협찬 매칭 플랫폼.', false, null, null, null, '가입 후 매칭 이용', '인플루언서 체험단·협찬 매칭'),
  ('cellypick', '셀리픽', 'social', 'domestic', 'https://cellypick.com/', '인플루언서 커머스 판매·정산 지원 플랫폼.', false, null, null, null, '가입 후 이용', '인플루언서 커머스 판매·정산 지원'),
  ('creatorlink', '크리에이터링크', 'mallbuilder', 'domestic', 'https://www.creatorlink.net/', '무료 홈페이지·쇼핑몰 제작 빌더.', false, null, null, null, '가입 후 바로 제작(무료 플랜 제공)', '무료 홈페이지·쇼핑몰 제작 빌더'),
  ('bigin', '빅인', 'office', 'domestic', 'https://bigin.io/', '이커머스 CRM 마케팅 자동화 솔루션.', false, null, null, null, '가입 후 쇼핑몰 연동 사용', '이커머스 CRM 마케팅 자동화'),
  ('datarize', '데이터라이즈', 'office', 'domestic', 'https://www.datarize.ai/', 'AI 기반 이커머스 CRM 마케팅 자동화 솔루션.', false, null, null, null, '가입·연동 후 사용', 'AI 기반 이커머스 CRM 자동화'),
  ('notifly', '노티플라이', 'office', 'domestic', 'https://www.notifly.tech/', '앱·웹 CRM 마케팅 자동화 솔루션.', false, null, null, null, '가입 후 앱·웹 연동 사용', '앱·웹 CRM 마케팅 자동화'),
  ('igotcha', '갓차', 'auto', 'domestic', 'https://igotcha.co.kr/', '구독형 방문세차 예약 서비스.', false, null, null, null, '앱 가입 후 구독 신청', '구독형 방문세차 예약에 강점'),
  ('chaevi', '채비', 'auto', 'domestic', 'https://chaevi.com/', '전기차 충전 원스톱 솔루션·예약 결제.', false, null, null, null, '충전 인프라 사업자·시설 대상 도입 문의', '전기차 충전 예약·결제 원스톱 처리에 강점'),
  ('socar', '쏘카', 'rental', 'domestic', 'https://www.socar.kr/', '국내 대표 카셰어링 모빌리티 서비스.', false, null, null, null, '앱 가입·운전면허 등록 후 이용', '단기 카셰어링·비대면 차량 이용에 강점'),
  ('carmoa', '카모아', 'rental', 'domestic', 'https://www.carmoa.com/', '국내외 렌트카 가격비교·예약 플랫폼.', false, null, null, null, '이용자 앱 가입 후 예약; 렌트업체 제휴 입점', '중소 렌트카 업체 통합 비교·예약에 강점'),
  ('zzimcar', '찜카', 'rental', 'domestic', 'https://zzimcar.com/', '렌트카·항공권·숙소 실시간 가격비교.', false, null, null, null, '앱 가입 후 예약', '렌트카·항공·숙소 실시간 가격비교에 강점'),
  ('skdirect', 'SK렌터카', 'rental', 'domestic', 'https://www.skdirect.co.kr/', '장기렌트·단기렌트 직영 렌터카 서비스.', false, null, null, null, '온라인·상담 통한 렌트 계약', '장·단기 직영 렌터카 운영에 강점'),
  ('rtplanner', '렌트플래너', 'rental', 'domestic', 'https://rtplanner.com/', '장기렌트·자동차리스 견적 비교 플랫폼.', false, null, null, null, '견적 요청 후 상담 진행', '장기렌트·자동차리스 견적 비교에 강점'),
  ('modoobike', '모두의바이크', 'delivery', 'domestic', 'https://modoobike.com/', '배달오토바이 렌트·리스 전문 서비스.', false, null, null, null, '라이더·사업자 대상 렌트·리스 계약', '배달용 이륜차 렌트·리스에 강점'),
  ('arentalnservice', '에이렌탈', 'delivery', 'domestic', 'https://arentalnservice.com/', '배달오토바이 렌탈 전문, 전국배송.', false, null, null, null, '라이더·사업자 대상 렌탈 신청', '배달 이륜차 렌탈·전국 배송에 강점'),
  ('bikebank', '바이크뱅크', 'delivery', 'domestic', 'https://www.bikebank.kr/', '비즈니스 이륜차 렌트·리스 솔루션.', false, null, null, null, '사업자 대상 렌트·리스 계약', '비즈니스 이륜차 렌트·리스 솔루션에 강점'),
  ('tayota', '타요타', 'delivery', 'domestic', 'https://tayota.co.kr/', '배달 이륜차 리스·렌트 최저가 지향.', false, null, null, null, '라이더·사업자 대상 리스·렌트 계약', '배달 이륜차 리스·렌트 가격 경쟁력에 강점'),
  ('moduparking', '모두의주차장', 'auto', 'domestic', 'https://www.moduparking.com/', '주차장 찾기·할인·공유주차 앱.', false, null, null, null, '이용자 앱 가입; 주차장 소유자 공유 등록', '주차장 검색·공유주차·할인에 강점'),
  ('gcoo', '지쿠', 'rental', 'domestic', 'https://gcoo.io/', '전동킥보드·전기자전거 공유 모빌리티.', false, null, null, null, '앱 가입·면허 인증 후 이용', '전동킥보드·전기자전거 공유 이동에 강점'),
  ('33m2', '삼삼엠투', 'realestate', 'domestic', 'https://web.33m2.co.kr/', '보증금 33만원 단기임대 원룸 부동산 앱.', false, null, null, null, '임대인 매물 등록; 이용자 앱 가입 후 예약', '저보증금 단기 원룸 임대에 강점'),
  ('liveanywhere', '리브애니웨어', 'realestate', 'domestic', 'https://www.liveanywhere.me/', '한달살기·단기임대 숙소 중개 플랫폼.', false, null, null, null, '호스트 숙소 등록; 이용자 가입 후 예약', '한달살기·단기임대 숙소 중개에 강점'),
  ('zaritalk', '자리톡', 'realestate', 'domestic', 'https://zaritalk.com/', '임대인·세입자용 부동산 임대관리 서비스.', false, null, null, null, '임대인·세입자 가입 후 이용', '임대인·세입자 임대관리에 강점'),
  ('ezrems', '이지램스', 'realestate', 'domestic', 'https://www.ezrems.com/', '임대·자산관리 클라우드 SaaS.', false, null, null, null, '가입·구독 후 이용', '임대·자산관리 클라우드 운영에 강점'),
  ('thebldgs', '더빌딩', 'realestate', 'domestic', 'https://www.thebldgs.com/', 'AI 기반 통합 건물·임대 관리 플랫폼.', false, null, null, null, '가입 후 이용; 사업자 도입 문의', 'AI 기반 건물·임대 통합 관리에 강점'),
  ('interiorbay', '인테리어베이', 'homeservice', 'domestic', 'https://www.interiorbay.co.kr/', '인테리어 무료 비교견적 중개 플랫폼.', false, null, null, null, '이용자 견적 요청; 시공업체 입점 등록', '인테리어 비교견적 중개에 강점'),
  ('apartmentary', '아파트멘터리', 'homeservice', 'domestic', 'https://www.apartmentary.com/', '표준화 아파트 인테리어 리모델링 서비스.', false, null, null, null, '상담·견적 후 시공 계약', '표준화 아파트 리모델링 시공에 강점'),
  ('drbuild', '닥터빌드', 'homeservice', 'domestic', 'https://drbuild.co.kr/', 'AI 추천 건축사·시공사 매칭 건축 플랫폼.', false, null, null, null, '건축주 가입 후 프로젝트 등록; 시공사 입점', 'AI 건축사·시공사 매칭에 강점'),
  ('howbuild', '하우빌드', 'homeservice', 'domestic', 'https://www.howbuild.com/', '건설사 선정·공사관리 지원 건축 플랫폼.', false, null, null, null, '건축주 가입 후 프로젝트 등록; 건설사 입점', '건설사 선정·공사관리 지원에 강점'),
  ('fivespot', '파이브스팟', 'office', 'domestic', 'https://fivespot.io/', '1인·소형 사무실 공유오피스 워크라운지.', false, null, null, null, '입주 문의·계약 후 이용', '1인·소형 사무실 공유오피스에 강점'),
  ('camplink', '캠프링크', 'space', 'domestic', 'http://www.camplink.co.kr/', '캠핑장 예약·빈자리 알림·후기 앱.', false, null, null, null, '이용자 앱 가입 후 예약; 캠핑장 제휴 등록', '캠핑장 예약·빈자리 알림에 강점'),
  ('tamnao', '탐나오', 'ticket', 'domestic', 'https://www.tamnao.com/', '제주 렌트카·숙소·관광지 할인 플랫폼.', false, null, null, null, '이용자 가입 후 예약; 제주 업체 제휴', '제주 렌트카·숙소·관광 할인 예약에 강점'),
  ('discoverjeju', '디스커버제주', 'ticket', 'domestic', 'https://discover-jeju.com/', '제주 로컬 액티비티·체험 예약 플랫폼.', false, null, null, null, '이용자 가입 후 예약; 체험업체 입점', '제주 로컬 액티비티·체험 예약에 강점'),
  ('sunsang24', '선상24', 'ticket', 'domestic', 'https://www.sunsang24.com/', '전국 선상낚시·배낚시 실시간 예약.', false, null, null, null, '이용자 가입 후 예약; 선사 입점 등록', '선상낚시·배낚시 실시간 예약에 강점'),
  ('usin', '어신', 'ticket', 'domestic', 'https://www.us-in.io/', '낚시배·낚시터 통합 예약 피싱 플랫폼.', false, null, null, null, '이용자 가입 후 예약; 선사·낚시터 입점', '낚시배·낚시터 통합 예약에 강점'),
  ('athlit', '애슬릿', 'fitness', 'domestic', 'https://athlit.io/', '헬스·요가·크로스핏 드랍인 운동 클래스 예약.', false, null, null, null, '이용자 가입 후 예약; 운동시설 제휴 등록', '드랍인 운동 클래스 예약에 강점'),
  ('farmstay', '팜스테이', 'space', 'domestic', 'https://www.farmstay.co.kr/', '농협 농촌체험·팜스테이 숙박 예약.', false, null, null, null, '이용자 가입 후 예약; 참여 농가 등록', '농촌체험·팜스테이 숙박 예약에 강점'),
  ('welchon', '웰촌', 'space', 'domestic', 'https://www.welchon.com/', '농어촌체험휴양마을 여행 포털.', false, null, null, null, '이용자 가입 후 이용; 체험마을 등록', '농어촌체험휴양마을 정보·예약에 강점'),
  ('farmerstore88', '농가살리기', 'food', 'domestic', 'https://www.farmerstore88.com/', '농가·소기업 산지직송 D2C 커머스.', false, null, null, null, '판매 농가·소기업 입점 신청; 사업자등록 필요', '농가·소기업 산지직송 D2C 판매에 강점'),
  ('kgfarmmall', 'KG팜몰', 'office', 'domestic', 'https://www.kgfarmmall.co.kr/', '비료·농약·농자재 종합 온라인 쇼핑몰.', false, null, null, null, '구매자 가입; 판매·유통사 입점', '비료·농약·농자재 온라인 구매에 강점'),
  ('smartfarmkorea', '스마트팜코리아', 'office', 'domestic', 'https://www.smartfarmkorea.net/', '스마트팜 정보·교육·솔루션 종합 포털.', false, null, null, null, '가입 후 이용', '스마트팜 정보·교육·솔루션 제공에 강점'),
  ('nthing', '엔씽', 'office', 'domestic', 'https://www.nthing.net/', '컨테이너형 수직농장 AI 스마트팜 솔루션.', false, null, null, null, '사업자 도입 문의', '컨테이너형 수직농장 AI 스마트팜에 강점'),
  ('slf', '스마트로컬푸드', 'office', 'domestic', 'https://slf.happyict.co.kr/', '로컬푸드 직매장 출하·정산 운영 SaaS.', false, null, null, null, '직매장·출하 농가 대상 도입', '로컬푸드 직매장 출하·정산 운영에 강점'),
  ('farmdy', '팜디', 'content', 'domestic', 'https://farmdy.kr/', 'AI 병해충 분석·영농일지 올인원 농업 앱.', false, null, null, null, '가입 후 바로 사용(무료 앱)', 'AI 병해충 진단·영농일지 관리에 강점'),
  ('tpirates', '인어교주해적단', 'content', 'domestic', 'https://tpirates.com/', '전국 수산시장 당일 시세·수산물 정보 앱.', false, null, null, null, '가입 후 바로 사용(무료 앱)', '수산물 당일 시세·시장 정보 조회에 강점'),
  ('baroinfo', '바로정보', 'content', 'domestic', 'https://www.baroinfo.com/', '전국 로컬푸드 직매장·직거래 종합정보.', false, null, null, null, '가입 후 바로 사용(정보 조회)', '로컬푸드 직매장·직거래 정보 탐색에 강점'),
  ('hiver', '하이버', 'fashion', 'domestic', 'https://www.hiver.co.kr', '남성 전용 패션 쇼핑앱.', false, null, null, null, '사업자등록·통신판매업 신고 후 브랜드 입점', '남성 전용 패션 큐레이션에 강점'),
  ('houseof', '하우스오브', 'fashion', 'domestic', 'https://houseof.kr', '디자이너 브랜드 편집샵 커뮤니티.', false, null, null, null, '사업자등록 후 디자이너 브랜드 입점', '디자이너 브랜드 편집·커뮤니티 결합에 강점'),
  ('fetching', '페칭', 'fashion', 'domestic', 'https://fetching.co.kr', '디자이너·럭셔리 셀렉트샵 플랫폼.', false, null, null, null, '사업자등록 후 브랜드·셀러 입점', '디자이너·럭셔리 셀렉트에 강점'),
  ('resellground', '리셀그라운드', 'resale', 'domestic', 'https://www.resellground.com', '시세 기반 중고 명품가방 거래소.', false, null, null, null, '가입·본인인증 후 판매 등록', '명품가방 시세 기반 중고 거래에 강점'),
  ('fount', '파운트', 'finance', 'domestic', 'https://fount.co/', '로보어드바이저 AI 자산관리 서비스.', false, null, null, null, '가입·계좌 연동 후 이용', 'AI 로보어드바이저 자산관리에 강점'),
  ('honestfund', '어니스트펀드', 'funding', 'domestic', 'https://www.honestfund.kr/', 'AI 신용분석 기반 P2P 투자·대출 플랫폼.', false, null, null, null, '가입 후 투자자·차입자 등록', 'AI 신용분석 기반 P2P 투자·대출에 강점'),
  ('piece', '피스', 'assets', 'domestic', 'https://piece.run/', '명품시계·미술품 등 현물 조각투자 플랫폼.', false, null, null, null, '가입·투자자 등록 후 이용', '명품시계·미술품 현물 조각투자에 강점'),
  ('seoulexchange', '서울거래 비상장', 'assets', 'domestic', 'https://www.seoulexchange.kr/', '비상장·장외주식 거래 플랫폼.', false, null, null, null, '가입·본인인증 후 이용', '비상장·장외주식 거래에 강점'),
  ('ustockplus', '증권플러스 비상장', 'assets', 'domestic', 'https://www.ustockplus.com/', '두나무가 운영하는 비상장주식 거래 플랫폼.', false, null, null, null, '가입·증권계좌 연동 후 이용', '비상장주식 거래·시세 조회에 강점'),
  ('alphasquare', '알파스퀘어', 'assets', 'domestic', 'https://alphasquare.co.kr/', '차트·분석 통합 스마트 트레이딩 플랫폼.', false, null, null, null, '가입·증권계좌 연동 후 이용', '차트·분석 통합 트레이딩 환경에 강점'),
  ('tosspayments', '토스페이먼츠', 'office', 'domestic', 'https://www.tosspayments.com/', '온라인 사업자용 간편결제 PG 인프라.', false, 'mid', '결제수단·업종별 상이 PG 수수료', null, '사업자 심사·계약 후 연동', '온라인 결제 PG 인프라·개발 연동에 강점'),
  ('itemmania', '아이템매니아', 'assets', 'domestic', 'https://www.itemmania.com/', '게임 아이템·계정·게임머니 안전거래 플랫폼.', false, null, null, null, '가입·본인인증 후 거래', '게임 아이템·계정·머니 안전거래 중개에 강점'),
  ('itembay', '아이템베이', 'assets', 'domestic', 'https://www.itembay.com/', '게임머니·아이템·계정 시세 조회·안전거래 중개.', false, null, null, null, '가입·본인인증 후 거래', '게임머니·아이템 시세 조회·안전거래에 강점'),
  ('idfarm', '아이디팜', 'assets', 'domestic', 'https://idfarm.co.kr/', '계정·게임머니·아이템·상품권 거래 게임 거래소.', false, null, null, null, '가입·본인인증 후 거래', '계정·게임머니·상품권 거래에 강점'),
  ('gamemarket', '게임마켓', 'assets', 'domestic', 'https://www.gamemarket.kr/', '인증 판매자 기반 게임 계정·아이템 거래.', false, null, null, null, '인증 판매자 등록 후 거래', '인증 판매자 기반 게임 계정·아이템 거래에 강점'),
  ('barotem', '바로템', 'assets', 'domestic', 'https://www.barotem.com/', '계정·게임머니·아이템·상품권 거래 플랫폼.', false, null, null, null, '가입·본인인증 후 거래', '계정·게임머니·상품권 거래에 강점'),
  ('acon3d', '에이콘3D', 'assets', 'domestic', 'https://www.acon3d.com/', '웹툰·게임용 3D 배경 등 디지털 에셋 스토어.', false, null, null, null, '작가 입점 신청·심사 후 에셋 판매', '웹툰·게임용 3D 배경 등 디지털 에셋 유통에 강점'),
  ('directg', '다이렉트게임즈', 'assets', 'domestic', 'https://directg.net/', 'PC·콘솔 게임 다운로드 키를 파는 한국형 ESD.', false, null, null, null, '퍼블리셔·사업자 계약 후 입점', 'PC·콘솔 게임 다운로드 키 유통에 강점'),
  ('phocamarket', '포카마켓', 'resale', 'domestic', 'https://phocamarket.com/', 'K-POP 포토카드 시세 조회·안전 거래 앱.', false, null, null, null, '가입 후 프로필 등록·거래', 'K-POP 포토카드 시세·안전거래에 강점'),
  ('wyyyes', '와이스', 'resale', 'domestic', 'https://wyyyes.com/', '트레이딩카드를 라이브로 거래하는 수집 앱.', false, null, null, null, '가입 후 판매자 등록·라이브 거래', '트레이딩카드 라이브 수집 거래에 강점'),
  ('gigs', 'OP.GG Gigs', 'content', 'domestic', 'https://gigs.op.gg/', '롤·발로란트 등 전문가 게임 코칭·강의 플랫폼.', false, null, null, null, '가입 후 코치 프로필 등록', '롤·발로란트 등 전문가 게임 코칭에 강점'),
  ('lolcoach', '롤코치미', 'content', 'domestic', 'https://www.lol-coach.me/', '리그오브레전드 1:1 코칭 서비스.', false, null, null, null, '가입 후 코치 등록·매칭', '롤 1:1 코칭에 강점'),
  ('monthlytoy', '월간토이', 'content', 'domestic', 'https://monthlytoy.co.kr/', '매달 취미 키트를 배송하는 취미 구독 서비스.', false, null, null, null, '가입·결제 후 정기구독', '취미 키트 정기 구독 배송에 강점'),
  ('hobbyinthebox', '101박스', 'handmade', 'domestic', 'https://hobbyinthebox.co.kr/', '직접 만드는 창작 DIY 키트 쇼핑몰.', false, null, null, null, '가입 후 구매, 작가 입점 신청', '직접 만드는 DIY 창작 키트 판매·구매에 강점'),
  ('ozjejakso', '오즈의제작소', 'print', 'domestic', 'https://ozjejakso.com/', '굿즈 디자인·제작·배송 원스톱 제작 플랫폼.', false, null, null, null, '가입 후 디자인 업로드·제작 주문', '굿즈 디자인·소량 제작·배송 원스톱에 강점'),
  ('villagebaby', '베이비빌리', 'kids', 'domestic', 'https://www.villagebaby.co.kr/', '임산부·육아맘 임신출산 콘텐츠·커머스 앱.', false, null, null, null, '가입 후 이용', '임신·출산 콘텐츠와 커머스 결합에 강점'),
  ('mmtalk', '마미톡', 'kids', 'domestic', 'https://mmtalk.kr/', '초음파 영상·임신출산 정보 육아앱.', false, null, null, null, '가입·병원 연동 후 이용', '초음파 영상·임신출산 정보 제공에 강점'),
  ('zzimkong', '찜콩', 'kids', 'domestic', 'https://www.zzimkong.com/', '유아동 패션·가구 쇼핑앱.', false, null, null, null, '사업자등록 후 입점', '유아동 패션·가구 큐레이션에 강점'),
  ('kidikidi', '키디키디', 'kids', 'domestic', 'https://www.kidikidi.com/', '이랜드가 운영하는 유아동 패션 편집샵.', false, null, null, null, '사업자등록 후 브랜드 입점', '유아동 패션 브랜드 편집샵에 강점'),
  ('yugacrew', '육아크루', 'kids', 'domestic', 'https://www.yugacrew.com/', '동네 기반 육아친구 찾기 지역 커뮤니티 앱.', false, null, null, null, '가입 후 동네 인증·이용', '동네 기반 육아친구·정보 교류에 강점'),
  ('momsdiary', '맘스다이어리', 'kids', 'domestic', 'https://www.momsdiary.co.kr/', '임신육아일기·무료 포토북 출판 지원 앱.', false, null, null, null, '가입 후 이용(무료 앱)', '임신·육아 일기와 포토북 출판에 강점'),
  ('smartowl', '똑똑한부엉이', 'rental', 'domestic', 'https://smartowl.co.kr/', '유아~초등 전집·영어책 무제한 대여 서비스.', false, null, null, null, '가입·구독 신청 후 대여', '유아·초등 전집·영어책 무제한 대여에 강점'),
  ('buggyfriend', '유모차친구', 'rental', 'domestic', 'https://www.buggyfriend.com/', '제주 유모차·카시트 예약 픽업 대여 서비스.', false, null, null, null, '가입 후 온라인 예약·픽업으로 이용', '제주 여행 시 유모차·카시트 단기 대여에 강점'),
  ('barfdog', '바프독', 'pet', 'domestic', 'https://barfdog.co.kr/', '강아지 맞춤 생식 식단 정기배송 서비스.', false, null, null, null, '가입 후 구독 신청·정기배송 이용', '강아지 맞춤 생식 식단 정기배송에 강점'),
  ('comestay', '컴스테이', 'pet', 'domestic', 'https://comestay.kr/', '반려견 동반 가능 숙소 예약 플랫폼.', false, null, null, null, '가입 후 반려견 동반 숙소 검색·예약', '반려견 동반 여행 숙소 예약에 강점'),
  ('mypetplus', '마이펫플러스', 'beautyhealth', 'domestic', 'https://www.mypetplus.co.kr/', '동물병원 가격비교·찾기 앱.', false, null, null, null, '앱 설치 후 동물병원 검색·비교', '동물병원 가격 비교·탐색에 강점'),
  ('petping', '펫핑', 'beautyhealth', 'domestic', 'https://www.petping.com/', '스마트 반려동물 건강관리 펫테크 서비스.', false, null, null, null, '가입 후 서비스·기기 연동 이용', '반려동물 건강 데이터 관리에 강점'),
  ('airdny', '에어댕냥이', 'homeservice', 'domestic', 'https://www.airdny.co.kr/', '반려동물 돌봄·산책·펫시터 매칭 플랫폼.', false, null, null, null, '펫시터·이용자 가입 후 프로필 등록·매칭', '반려동물 돌봄·산책 펫시터 매칭에 강점'),
  ('rentalfriend', '렌탈프렌드', 'rental', 'domestic', 'https://rentalfriend.co.kr/', '정수기·가구 등 렌탈 가격비교 플랫폼.', false, null, null, null, '가입 후 렌탈 상품 비교·상담 신청', '정수기·가구 렌탈 조건 비교에 강점'),
  ('alphabox', '알파박스', 'rental', 'domestic', 'https://alphabox.co.kr/', '24시간 무인 셀프스토리지 짐보관.', false, null, null, null, '가입 후 보관 공간 예약·이용', '무인 24시간 셀프스토리지 짐보관에 강점'),
  ('dalock', '미니창고 다락', 'rental', 'domestic', 'https://www.dalock.kr/', '온습도 관리 개인 셀프스토리지 창고.', false, null, null, null, '가입 후 창고 공간 예약·이용', '온습도 관리 개인 물품 보관에 강점'),
  ('myzzym', '마이짐', 'rental', 'domestic', 'https://myzzym.com/', '짐보관 창고 중개 O2O 플랫폼.', false, null, null, null, '가입 후 보관처 검색·예약', '짐보관 창고 중개·연결에 강점'),
  ('select', '리디셀렉트', 'rental', 'domestic', 'https://select.ridibooks.com/', '전자책 무제한 월정액 구독 서비스.', false, null, null, null, '가입 후 월정액 구독 이용', '전자책 무제한 구독 열람에 강점'),
  ('ablanc', '에이블랑', 'fashion', 'domestic', 'https://ablanc.co.kr/', '월정액 명품 가방 대여 구독 서비스.', false, null, null, null, '가입 후 월정액 구독 대여 이용', '명품 가방 월정액 대여 구독에 강점'),
  ('streamingwear', '스트리밍웨어', 'fashion', 'domestic', 'https://streamingwear.com/', '월단위 패션 의류 정기구독 서비스.', false, null, null, null, '가입 후 월정액 의류 구독 이용', '패션 의류 정기구독 대여에 강점'),
  ('serieseight', '시리즈에잇', 'fashion', 'domestic', 'https://series-eight.com/', '명품 가방 대여 서비스.', false, null, null, null, '가입 후 명품 가방 대여 이용', '명품 가방 단기 대여에 강점'),
  ('kocorental', '코코렌탈', 'office', 'domestic', 'https://kocorental.co.kr/', '노트북·복합기 등 사무기기 렌탈.', false, null, null, null, '개인·사업자 가입 후 렌탈 상담·계약', '노트북·복합기 등 사무기기 렌탈에 강점'),
  ('lotterental', '롯데렌탈', 'office', 'domestic', 'https://www.lotterental.com/', '사무용 IT기기 종합 렌탈·A/S.', false, null, null, null, '사업자 문의 후 렌탈 계약·A/S', '사무용 IT기기 종합 렌탈과 A/S에 강점'),
  ('repercent', '리퍼센트', 'resale', 'domestic', 'https://repercent.com/', '시세 기반 중고폰 최고가 매입 앱.', false, null, null, null, '앱에서 시세 조회 후 매입 신청', '중고폰 시세 기반 매입에 강점'),
  ('sello', '셀로', 'resale', 'domestic', 'https://sell-o.kr/', '비대면 중고폰 판매 서비스.', false, null, null, null, '앱 가입 후 비대면 판매 신청', '비대면 중고폰 판매 처리에 강점'),
  ('repickus', '피커스', 'resale', 'domestic', 'https://www.repickus.com/', '중고 가전·가구 재활용 거래 플랫폼.', false, null, null, null, '가입 후 가전·가구 매입·거래 신청', '중고 가전·가구 재활용 거래에 강점'),
  ('refurlab', '리퍼연구소', 'resale', 'domestic', 'https://www.refurlab.com/', '리퍼·중고 노트북·태블릿 프리미엄 쇼핑.', false, null, null, null, '가입 후 리퍼·중고 제품 구매', '리퍼·중고 노트북·태블릿 구매에 강점'),
  ('watchexchange', '시계거래소', 'resale', 'domestic', 'https://www.watchexchange.co.kr/', '명품시계 매물·시세 제공 거래 서비스.', false, null, null, null, '가입 후 매물 등록·시세 조회', '명품시계 매물·시세 확인에 강점'),
  ('xgolf', '엑스골프', 'ticket', 'domestic', 'https://www.xgolf.com/', '전국·일본 골프장 실시간 예약과 조인 서비스.', false, null, null, null, '가입 후 골프장 검색·예약', '국내·일본 골프장 예약과 조인에 강점'),
  ('golfmon', '골프몬', 'ticket', 'domestic', 'https://golfmon.kr/', '골프 부킹·조인·해외골프 통합 예약 앱.', false, null, null, null, '앱 가입 후 부킹·조인 예약', '골프 부킹·조인·해외골프 통합 예약에 강점'),
  ('moolban', '물반고기반', 'ticket', 'domestic', 'https://www.moolban.com/', '바다·민물 낚시 통합 실시간 예약 앱.', false, null, null, null, '앱 가입 후 낚시 예약', '바다·민물 낚시 실시간 예약에 강점'),
  ('wrightbrothers', '라이트브라더스', 'openmarket', 'domestic', 'https://www.wrightbrothers.kr/', '자전거 인증 중고거래·커머스.', false, null, null, null, '가입 후 자전거 등록·인증 거래', '인증 기반 중고 자전거 거래에 강점'),
  ('market', '골핑', 'openmarket', 'domestic', 'https://market.golping.com/', '골프존커머스가 운영하는 골프용품 오픈마켓.', false, null, null, null, '사업자등록·통신판매업 신고 후 입점', '골프용품 전문 오픈마켓 판매에 강점'),
  ('hellin', '헬린캠프', 'fitness', 'domestic', 'https://hellin.camp/', '트레이너용 PT 운동일지·예약·회원관리.', false, null, null, null, '트레이너 가입 후 회원·일정 관리', 'PT 트레이너 운동일지·회원관리에 강점'),
  ('tranggle', '트랭글', 'content', 'domestic', 'https://www.tranggle.com/', '등산·자전거 GPS 기록·배지 커뮤니티.', false, null, null, null, '앱 가입 후 활동 기록·커뮤니티 이용', '등산·자전거 GPS 기록과 배지 커뮤니티에 강점'),
  ('apple', '램블러', 'content', 'domestic', 'https://apps.apple.com/kr/app/id531276104', '등산·걷기 경로 기록·사진 마커 커뮤니티.', false, null, null, null, '앱 가입 후 경로 기록·공유', '등산·걷기 경로 기록과 사진 마커에 강점'),
  ('myweddingdiary', '마웨다', 'wedding', 'domestic', 'https://myweddingdiary.co.kr', '웨딩홀 견적서 원본을 비교하는 플랫폼.', false, null, null, null, '가입 후 웨딩홀 견적 비교·조회', '웨딩홀 견적서 원본 비교에 강점'),
  ('snaplink', '스냅링크', 'photo', 'domestic', 'https://www.snaplink.run', 'AI 추천 여행·커플·웨딩 스냅작가 매칭.', false, null, null, null, '작가·이용자 가입 후 프로필 등록·매칭', '여행·웨딩 스냅작가 AI 매칭에 강점'),
  ('snapsta', '스냅스타', 'photo', 'domestic', 'https://www.snapsta.co.kr', '웨딩·돌잔치 스냅 촬영 전문 예약.', false, null, null, null, '가입 후 작가 검색·촬영 예약', '웨딩·돌잔치 스냅 촬영 예약에 강점'),
  ('ssople', '쏘플', 'event', 'domestic', 'https://ssople.com', '전국 프라이빗 파티룸 예약 서비스.', false, null, null, null, '가입 후 파티룸 검색·예약', '프라이빗 파티룸 예약에 강점'),
  ('amuse', '어뮤즈컴퍼니', 'event', 'domestic', 'https://amuse.company', '축제·MICE 행사 기획 대행 원스톱.', false, null, null, null, '문의·상담 후 행사 기획 대행 계약', '축제·MICE 행사 기획 대행에 강점'),
  ('dailoz', '데일로즈', 'event', 'domestic', 'https://www.dailoz.com', '주기별 꽃 정기구독 배송 서비스.', false, null, null, null, '가입 후 꽃 정기구독 신청', '주기별 꽃 정기구독 배송에 강점'),
  ('autopartsner', '파츠너', 'auto', 'domestic', 'https://auto-partsner.com/', '국산·수입·상용차 부품 전문 온라인 쇼핑몰.', false, null, null, null, '회원가입 후 차종별 부품 검색·구매', '국산·수입·상용차 부품 폭넓은 취급에 강점'),
  ('myungcha', '명차닷컴', 'auto', 'domestic', 'https://www.myungcha.com/', '벤츠·BMW·아우디 등 수입차 부품 전문몰.', false, null, null, null, '회원가입 후 구매', '벤츠·BMW·아우디 등 수입차 부품 특화'),
  ('hellowcar', '헬로우카', 'auto', 'domestic', 'https://hellowcar.com/', '현대모비스 순정부품 공식 온라인 대리점몰.', false, null, null, null, '회원가입 후 순정부품 구매', '현대모비스 순정부품 공식 대리점 채널'),
  ('partsro', '파츠로', 'auto', 'domestic', 'https://partsro.com/', '현대·기아 순정부품 부품번호·VIN 조회 판매.', false, null, null, null, '회원가입 후 VIN·부품번호 조회 구매', '부품번호·VIN 조회로 순정부품 정확 매칭'),
  ('tstation', '티스테이션', 'auto', 'domestic', 'https://www.tstation.com/', '한국타이어 타이어 예약·차량관리 플랫폼.', false, null, null, null, '앱·웹 가입 후 매장 예약', '한국타이어 타이어 예약·차량관리 원스톱'),
  ('bluetire', '블루타이어', 'auto', 'domestic', 'https://bluetire.co.kr/', '넥센타이어 공식몰, 장착점 배송 예약.', false, null, null, null, '가입 후 타이어 구매·장착 예약', '넥센타이어 공식몰, 장착점 배송·예약 연계'),
  ('parts114', '파츠114', 'auto', 'domestic', 'https://parts114.co.kr/', '수입차 부품 취급 전문 쇼핑몰.', false, null, null, null, '회원가입 후 구매', '수입차 부품 전문 취급에 강점'),
  ('pcarmall', '피카몰', 'auto', 'domestic', 'https://pcarmall.com/', '엔진오일·요소수 등 차량용품 종합몰.', false, null, null, null, '회원가입 후 구매', '엔진오일·요소수 등 소모품·차량용품 종합'),
  ('nebaqui', '네바퀴닷컴', 'auto', 'domestic', 'https://nebaqui.com/', '시트·매트 등 자동차용품 전문 쇼핑몰.', false, null, null, null, '회원가입 후 구매', '시트·매트 등 자동차 인테리어 용품 특화'),
  ('reitwagen', '라이트바겐', 'auto', 'domestic', 'https://www.reitwagen.co.kr/', '중고 오토바이 거래·할부 이륜차 플랫폼.', false, null, null, null, '회원가입 후 매물 등록·구매', '중고 이륜차 거래·할부 연계에 강점'),
  ('bstore', '블랙스토어', 'auto', 'domestic', 'https://b-store.co.kr/', '차량용 블랙박스 전문 쇼핑몰.', false, null, null, null, '회원가입 후 구매', '차량용 블랙박스 전문 취급'),
  ('gongim', '공임나라', 'auto', 'domestic', 'https://www.gongim.com/', '정비·엔진오일·타이어 출장장착 플랫폼.', false, null, null, null, '가입 후 정비·출장장착 예약', '정비·엔진오일·타이어 출장장착 예약에 강점'),
  ('intrax', '인트락스몰', 'auto', 'domestic', 'https://www.intrax.co.kr/', '자동차·오토바이 튜닝·모터스포츠 종합몰.', false, null, null, null, '회원가입 후 구매', '튜닝·모터스포츠 부품 종합 취급'),
  ('pechanara', '폐차나라', 'auto', 'domestic', 'https://pechanara.com/', '자동차 중고·폐차 부품 전문 쇼핑몰.', false, null, null, null, '회원가입 후 중고부품 구매', '중고·폐차 부품으로 저비용 수리에 강점'),
  ('carlandasia', '카랜드', 'auto', 'domestic', 'https://carlandasia.com/', '중고엔진·미션 등 자동차 중고부품 쇼핑몰.', false, null, null, null, '회원가입 후 구매', '중고엔진·미션 등 대형 중고부품 특화'),
  ('carssenb2b', '카쎈B2B', 'office', 'domestic', 'https://carssenb2b.com/', '사업자 전용 자동차 부품 B2B 도매몰.', false, null, null, null, '사업자등록 후 도매 회원가입', '사업자 전용 자동차 부품 B2B 도매에 강점'),
  ('mamedene', '마메드네', 'beautyhealth', 'domestic', 'https://mamedene.com/', 'AI 헤어 시뮬레이션과 미용실·네일·왁싱 예약 앱.', false, null, null, null, '샵은 사업자 등록 후 입점, 고객은 앱 예약', 'AI 헤어 시뮬레이션과 뷰티샵 예약 결합'),
  ('gongbiz', '공비서', 'beautyhealth', 'domestic', 'https://gongbiz.kr/', '네일·미용실·왁싱 등 뷰티샵 비교예약 앱.', false, null, null, null, '샵 등록 후 입점, 고객은 앱 예약', '네일·미용실·왁싱 비교예약에 강점'),
  ('mendlemendle', '맨들맨들', 'beautyhealth', 'domestic', 'https://mendlemendle.com/', '왁싱·네일·피부·속눈썹 뷰티샵 예약 플랫폼.', false, null, null, null, '샵 등록 후 입점, 고객은 앱 예약', '왁싱·네일·속눈썹 등 뷰티샵 예약 특화'),
  ('msgtong', '마통', 'beautyhealth', 'domestic', 'https://www.msgtong.co.kr/', '마사지·에스테틱·왁싱 예약결제 정보 플랫폼.', false, null, null, null, '샵 등록 후 입점, 고객은 앱 예약', '마사지·에스테틱·왁싱 예약결제 정보 제공'),
  ('mimobio', '미모', 'beautyhealth', 'domestic', 'http://www.mimobio.com/', '전문 피부관리샵 실시간 예약 플랫폼.', false, null, null, null, '샵 등록 후 입점, 고객은 앱 예약', '전문 피부관리샵 실시간 예약에 강점'),
  ('tattooshare', '타투쉐어', 'beautyhealth', 'domestic', 'https://m.tattooshare.co.kr/', '타투 견적비교·할인·리뷰 매칭 앱.', false, null, null, null, '타투이스트 등록·고객 견적 요청', '타투 견적비교·리뷰 매칭에 강점'),
  ('beauty', '용감한뷰티', 'beautyhealth', 'domestic', 'https://beauty.yonggam.com/', '뷰티샵 고객관리·예약 통합 관리 서비스.', false, null, null, null, '사업자 가입 후 매장 관리 이용', '뷰티샵 고객관리·예약 통합 관리 도구'),
  ('previewapp', '프리뷰', 'content', 'domestic', 'https://previewapp.co.kr/ko', '눈썹·입술 반영구 문신 시뮬레이션 상담 앱.', false, null, null, null, '앱 설치 후 이용, 샵 상담 연계', '눈썹·입술 반영구 시뮬레이션 상담에 강점'),
  ('meemong', '미몽', 'content', 'domestic', 'https://meemong.com/', '헤어 컨설팅·헤어모델 매칭 플랫폼.', false, null, null, null, '가입 후 프로필 등록·매칭', '헤어 컨설팅·헤어모델 매칭에 강점'),
  ('groomingjok', '그루밍족', 'content', 'domestic', 'https://groomingjok.com/', '남성 성형·시술 정보 커뮤니티 앱.', false, null, null, null, '앱 가입 후 커뮤니티 이용', '남성 성형·시술 정보 커뮤니티에 강점'),
  ('unpa', '언니의파우치', 'social', 'domestic', 'https://unpa.me/', '내돈내산 뷰티 리뷰·커뮤니티 앱.', false, null, null, null, '앱 가입 후 리뷰·커뮤니티 이용', '내돈내산 뷰티 리뷰·커뮤니티에 강점'),
  ('gov', '정부24', 'office', 'domestic', 'https://www.gov.kr/', '각종 민원 신청·발급·조회 통합 정부 포털.', false, null, null, null, '본인인증 후 민원 신청·발급', '각종 민원 신청·발급·조회 통합 처리'),
  ('safetyreport', '안전신문고', 'office', 'domestic', 'https://www.safetyreport.go.kr/', '생활 속 안전위험을 사진으로 신고하는 앱.', false, null, null, null, '가입·인증 후 신고', '생활 안전위험 사진 신고에 강점'),
  ('epeople', '국민신문고', 'office', 'domestic', 'https://www.epeople.go.kr/', '민원·제안·예산낭비신고 온라인 창구.', false, null, null, null, '가입·인증 후 이용', '민원·제안·예산낭비 신고 통합 창구'),
  ('cheongwon', '청원24', 'office', 'domestic', 'https://www.cheongwon.go.kr/', '국가기관에 온라인으로 청원하는 서비스.', false, null, null, null, '본인인증 후 청원 등록', '국가기관 온라인 청원에 강점'),
  ('mobileid', '모바일 신분증', 'office', 'domestic', 'https://www.mobileid.go.kr/', '주민등록증·운전면허증 모바일 발급 앱.', false, null, null, null, '본인인증 후 앱으로 발급', '주민등록증·운전면허증 모바일 발급'),
  ('airkorea', '에어코리아', 'content', 'domestic', 'https://www.airkorea.or.kr/', '실시간 미세먼지·대기질 정보 제공.', false, null, null, null, '앱 설치 후 바로 이용', '실시간 미세먼지·대기질 정보 제공'),
  ('pp', '한전 파워플래너', 'content', 'domestic', 'https://pp.kepco.co.kr/', '실시간 전기 사용량·요금 조회 절약 앱.', false, null, null, null, '한전 계정 연동 후 이용', '실시간 전기 사용량·요금 조회로 절약 지원'),
  ('solarplay', '솔라플레이', 'content', 'domestic', 'https://www.solarplay.co.kr/', '태양광발전소 발전량 실시간 모니터링.', false, null, null, null, '설비 등록·계정 연동 후 이용', '태양광발전소 발전량 실시간 모니터링'),
  ('lasee', '라씨', 'content', 'domestic', 'https://www.lasee.io/', '태양광 발전 현황·이상 알림 모니터링 앱.', false, null, null, null, '발전소 사업자 가입 후 모니터링 연동', '태양광 발전 현황·이상 알림 모니터링에 강점'),
  ('bikeseoul', '서울자전거 따릉이', 'social', 'domestic', 'https://www.bikeseoul.com/', '서울시 공공자전거 대여 서비스.', false, null, null, null, '앱 가입·이용권 결제 후 대여', '서울시 공공자전거 단거리 이동에 강점'),
  ('tashu', '대전 타슈', 'social', 'domestic', 'https://www.tashu.or.kr/', '대전시 무인 공공자전거 대여 서비스.', false, null, null, null, '앱 가입·이용권 결제 후 대여', '대전시 무인 공공자전거 근거리 이동에 강점'),
  ('thepodo', '오늘의 분리수거', 'social', 'domestic', 'https://www.thepodo.com/', '분리배출 실천하고 포인트 받는 앱.', false, null, null, null, '가입 후 분리배출 인증·포인트 적립', '분리배출 실천·포인트 리워드에 강점'),
  ('superbin', '수퍼빈', 'social', 'domestic', 'https://www.superbin.co.kr/', '재활용 회수기 네프론 자원순환 플랫폼.', false, null, null, null, '앱 가입 후 회수기(네프론) 이용', '재활용 회수기 통한 자원순환·보상에 강점'),
  ('treepla', '트리플래닛', 'social', 'domestic', 'https://www.treepla.net/', '크라우드펀딩으로 숲 조성 나무심기 플랫폼.', false, null, null, null, '가입 후 펀딩·후원 참여', '크라우드펀딩 기반 숲 조성·나무심기에 강점'),
  ('cpoint', '탄소중립포인트', 'finance', 'domestic', 'https://cpoint.or.kr/netzero/', '친환경 활동 시 현금·포인트 인센티브.', false, null, null, null, '참여기관 가입 후 친환경 활동 인증', '친환경 활동 현금·포인트 인센티브에 강점'),
  ('gmoney', '경기지역화폐', 'finance', 'domestic', 'https://apps.gmoney.or.kr/', '충전 인센티브 제공 지역사랑상품권 앱.', false, 'low', '지역화폐 가맹점 수수료 낮음', null, '앱 가입·충전 후 가맹점 결제', '충전 인센티브·지역 가맹점 결제에 강점'),
  ('zeropay', '제로페이', 'finance', 'domestic', 'https://www.zeropay.or.kr/', '소상공인 수수료 절감 QR 간편결제.', false, 'low', '소상공인 매출구간별 0%대 수수료', null, '사업자 가맹 신청 후 QR 발급', '소상공인 결제수수료 절감에 강점'),
  ('together2', '카카오같이가치', 'social', 'domestic', 'https://together.kakao.com/', '누구나 참여하는 모금·기부 플랫폼.', false, null, null, null, '카카오계정 로그인 후 모금 참여·개설', '모금·기부 캠페인 참여에 강점'),
  ('oraebakery', '오래베이커리', 'food', 'domestic', 'https://oraebakery.com/', '천연발효 사워도우 빵 정기배송.', false, null, null, null, '가입 후 정기배송 구독 신청', '천연발효 사워도우 빵 정기배송에 강점'),
  ('vegefood', '베지푸드', 'food', 'domestic', 'http://www.vegefood.co.kr/', '채식 전문 커머스.', false, null, null, null, '가입 후 상품 주문', '채식·비건 전문 식품 구매에 강점'),
  ('beanbrothers', '빈브라더스', 'food', 'domestic', 'https://www.beanbrothers.co.kr/subscribe/', '스페셜티 원두 정기구독 로스터리.', false, null, null, null, '가입 후 원두 정기구독 신청', '스페셜티 원두 정기구독·로스팅에 강점'),
  ('cafebox', '카페박스', 'food', 'domestic', 'https://cafebox.kr/', '매달 바뀌는 로스터리 커피 구독.', false, null, null, null, '가입 후 커피 구독 신청', '매달 바뀌는 로스터리 커피 큐레이션에 강점'),
  ('yundiet', '윤식단', 'food', 'domestic', 'https://www.yundiet.com/', '다이어트 단백질 도시락 정기배송.', false, null, null, null, '가입 후 식단 정기배송 신청', '다이어트 단백질 도시락 정기배송에 강점'),
  ('tandanji', '탄단지박스', 'food', 'domestic', 'https://www.tandanji.me/', '탄단지 밸런스 식단 구독 서비스.', false, null, null, null, '가입 후 식단 구독 신청', '탄단지 밸런스 식단 구독에 강점'),
  ('6meal', '식스밀', 'food', 'domestic', 'https://6meal.co.kr/', 'AI 식단코칭 다이어트 도시락 구독.', false, null, null, null, '가입 후 식단 구독 신청', 'AI 식단코칭 다이어트 도시락 구독에 강점'),
  ('farmtobaby', '팜투베이비', 'food', 'domestic', 'https://www.farmtobaby.co.kr/', '친환경 원료 영양맞춤 이유식 구독.', false, null, null, null, '가입 후 이유식 구독 신청', '친환경 원료 영양맞춤 이유식 구독에 강점'),
  ('bebecook', '베베쿡', 'food', 'domestic', 'https://www.bebecook.com/', '배달이유식 구독 브랜드.', false, null, null, null, '가입 후 이유식 구독 신청', '배달 이유식 구독에 강점'),
  ('pocketsalad', '포켓샐러드', 'food', 'domestic', 'https://pocketsalad.co.kr/', '주문 즉시 제작 샐러드 정기배송.', false, null, null, null, '가입 후 샐러드 정기배송 신청', '주문 즉시 제작 샐러드 정기배송에 강점'),
  ('cueat', '큐잇', 'food', 'domestic', 'https://cueat.kr/', '취향 큐레이션 과일·채소 구독.', false, null, null, null, '가입 후 과일·채소 구독 신청', '취향 큐레이션 과일·채소 구독에 강점'),
  ('ffd', '농사펀드', 'social', 'domestic', 'https://www.ffd.co.kr/', '농부-소비자 연결 제철농산물 크라우드.', false, null, null, null, '가입 후 펀딩 참여(농가는 프로젝트 등록)', '제철농산물 크라우드펀딩·농가 직거래에 강점'),
  ('tving', '티빙', 'content', 'domestic', 'https://www.tving.com', 'CJ ENM 계열 국내 대표 OTT, tvN·JTBC 콘텐츠.', false, null, null, null, '가입 후 구독권 결제', 'tvN·JTBC 등 CJ ENM 콘텐츠 시청에 강점'),
  ('wavve', '웨이브', 'content', 'domestic', 'https://www.wavve.com', '지상파 3사와 SK 합작 OTT, 방송 콘텐츠 강점.', false, null, null, null, '가입 후 구독권 결제', '지상파 방송 콘텐츠 다시보기에 강점'),
  ('watcha', '왓챠', 'content', 'domestic', 'https://watcha.com', '추천 기반 영화·드라마 OTT, 마니아 콘텐츠 특화.', false, null, null, null, '가입 후 구독권 결제', '추천 기반 영화·드라마, 마니아 콘텐츠에 강점'),
  ('coupangplay', '쿠팡플레이', 'content', 'domestic', 'https://www.coupangplay.com', '쿠팡이 운영하는 OTT, 스포츠·오리지널 콘텐츠.', false, null, null, null, '쿠팡 와우 멤버십 가입 시 이용', '스포츠 중계·오리지널 콘텐츠에 강점'),
  ('laftel', '라프텔', 'content', 'domestic', 'https://laftel.net', '애니메이션 전문 스트리밍 OTT.', false, null, null, null, '가입 후 구독권 결제', '애니메이션 전문 스트리밍에 강점'),
  ('vigloo', '비글루', 'content', 'domestic', 'https://www.vigloo.com', '글로벌 숏폼 드라마 플랫폼.', false, null, null, null, '가입 후 이용(회차 결제·구독)', '글로벌 숏폼 드라마 시청에 강점'),
  ('dramaboxapp', '드라마박스', 'content', 'domestic', 'https://www.dramaboxapp.com', '숏폼 드라마 스트리밍 앱.', false, null, null, null, '가입 후 이용(회차 결제·구독)', '숏폼 드라마 스트리밍에 강점'),
  ('audiocomics', '오디오코믹스', 'content', 'domestic', 'https://audiocomics.kr', '웹툰·웹소설 기반 오디오 드라마 플랫폼.', false, null, null, null, '가입 후 이용(회차 결제·구독)', '웹툰·웹소설 기반 오디오 드라마에 강점')
on conflict (id) do nothing;

insert into public.platforms (id, name, category_id, region, url, blurb, is_new, fee_band, fee_text, settle_text, enter_text, strength) values
  ('sooplive2', '숲', 'social', 'domestic', 'https://www.sooplive.com', '1인 방송·라이브 스트리밍 플랫폼(구 아프리카TV).', false, null, null, null, '가입 후 방송 개설·시청', '1인 라이브 방송·후원 기반 소통에 강점'),
  ('spooncast', '스푼', 'social', 'domestic', 'https://www.spooncast.net/kr', '목소리로 소통하는 오디오 라이브 방송 앱.', false, null, null, null, '가입 후 DJ 방송 개설·청취', '목소리 오디오 라이브 방송·후원에 강점'),
  ('vworld', '브이월드', 'social', 'domestic', 'https://v-world.io', '버튜버 팬 커뮤니티 플랫폼.', false, null, null, null, '가입 후 커뮤니티 참여', '버튜버 팬 커뮤니티·소통에 강점'),
  ('vrew', '브루', 'ai_video', 'domestic', 'https://vrew.ai/ko', 'AI 자동 자막·음성인식 기반 영상 편집 툴.', false, null, null, null, '가입 후 바로 사용(무료 플랜 제공)', 'AI 자동 자막·음성인식 영상 편집에 강점'),
  ('aistudios', 'AI스튜디오스', 'assets', 'domestic', 'https://www.aistudios.com', 'AI 아바타·텍스트 투 비디오 제작 SaaS.', false, null, null, null, '가입 후 사용(요금제 구독)', 'AI 아바타·텍스트 투 비디오 제작에 강점'),
  ('videomonster', '비디오몬스터', 'assets', 'domestic', 'https://www.videomonster.com', '템플릿 기반 자동 영상 제작 SaaS.', false, null, null, null, '가입 후 바로 사용(무료 체험 대개 제공)', '템플릿 기반 자동 영상 제작에 강점'),
  ('dental', '치과웨건', 'beautyhealth', 'domestic', 'https://dental.pricewagon.net/', '내 주변 임플란트·교정 치과 가격비교 사이트.', false, null, null, null, '이용자 검색·가격비교, 치과는 제휴 등록', '임플란트·교정 치과 가격비교에 강점'),
  ('gooodcare', '좋은케어', 'homeservice', 'domestic', 'https://www.gooodcare.com/', '교육받은 간병인·케어매니저 매칭 서비스.', false, null, null, null, '간병인·케어매니저 등록 또는 이용 신청', '교육받은 간병인·케어매니저 매칭에 강점'),
  ('modohan', '모두한', 'homeservice', 'domestic', 'https://www.modohan.co.kr/', '증상·지역별 한의원 검색·예약 한방 플랫폼.', false, null, null, null, '이용자 검색·예약, 한의원은 제휴 등록', '증상·지역별 한의원 검색·예약에 강점'),
  ('download', '슬립큐', 'content', 'domestic', 'https://download.sleepq.ai/', '식약처 허가 불면증 디지털 치료제 앱.', false, null, null, null, '처방 후 앱 이용(디지털 치료기기)', '식약처 허가 불면증 디지털 치료제에 강점'),
  ('lasikhelp', '라식헬프', 'content', 'domestic', 'https://lasikhelp.co.kr/', '라식·라섹 정보와 제휴 안과 이벤트 비교.', false, null, null, null, '이용자 정보 열람·비교, 안과는 제휴', '라식·라섹 정보·안과 이벤트 비교에 강점'),
  ('kormedi', '코메디닷컴', 'content', 'domestic', 'https://kormedi.com/', '건강·의학 정보 콘텐츠 미디어 플랫폼.', false, null, null, null, '콘텐츠 열람 무료, 가입 시 기능 확장', '건강·의학 정보 콘텐츠 제공에 강점'),
  ('thedirectdonation', '곧장기부', 'funding', 'domestic', 'https://thedirectdonation.org/', '수수료 없이 100% 전달하는 다이렉트 기부 플랫폼.', false, 'low', '수수료 없이 100% 전달', null, '가입 후 기부 참여(개인·단체)', '수수료 없이 전액 전달에 강점'),
  ('ilovegohyang', '고향사랑e음', 'funding', 'domestic', 'https://www.ilovegohyang.go.kr/', '고향사랑기부제 공식 온라인 기부·답례품 플랫폼.', false, null, null, null, '본인인증 후 기부 참여(세액공제·답례품)', '고향사랑기부제 공식 기부·답례품에 강점'),
  ('socialfunch', '소셜펀치', 'funding', 'domestic', 'https://www.socialfunch.org/', '인권·환경·노동 사회운동 후원 크라우드펀딩.', false, null, null, null, '캠페인 개설 신청 또는 후원 참여', '인권·환경·노동 사회운동 후원에 강점'),
  ('crowdnet', '크라우드넷', 'funding', 'domestic', 'https://www.crowdnet.or.kr/', '증권형 크라우드펀딩 정보 제공 공식 포털.', false, null, null, null, '정보 열람, 발행·투자는 연계 중개사 통해', '증권형 크라우드펀딩 정보 제공에 강점'),
  ('greenfund', '환경재단 그린펀드', 'funding', 'domestic', 'https://greenfund.org/', '환경 캠페인·기부를 모으는 환경재단 플랫폼.', false, null, null, null, '기부 참여 또는 캠페인 제안·신청', '환경 캠페인·기부 모금에 강점'),
  ('sharencare', '쉐어앤케어', 'funding', 'domestic', 'https://sharencare.me/', '콘텐츠 공유로 기업이 대신 기부하는 소셜 플랫폼.', false, null, null, null, '가입 후 콘텐츠 공유로 캠페인 참여', '콘텐츠 공유로 기업 대신 기부에 강점'),
  ('donus', '도너스', 'social', 'domestic', 'https://www.donus.org/', '비영리 후원자 개발·정기결제 모금 SaaS.', false, null, null, null, '비영리단체 가입 후 모금·정기결제 구축', '비영리 후원자 개발·정기결제 SaaS에 강점'),
  ('donationbox', '도네이션박스', 'social', 'domestic', 'https://donationbox.co.kr/', 'NGO 후원자·모금 관리 온라인 모금함 서비스.', false, null, null, null, '단체 가입 후 온라인 모금함 개설', 'NGO 후원자·모금 관리에 강점'),
  ('1365', '1365 자원봉사포털', 'social', 'domestic', 'https://www.1365.go.kr/', '전국 자원봉사 검색·신청·실적관리 공식 포털.', false, null, null, null, '회원가입 후 봉사활동 검색·신청', '전국 자원봉사 검색·신청·실적관리에 강점'),
  ('vms', 'VMS 사회복지자원봉사', 'social', 'domestic', 'https://www.vms.or.kr/', '사회복지 분야 자원봉사 모집·인증관리 시스템.', false, null, null, null, '가입 후 봉사 모집·참여·인증 관리', '사회복지 분야 자원봉사 인증관리에 강점'),
  ('donghaeng', '서울동행', 'social', 'domestic', 'https://www.donghaeng.seoul.kr/', '대학생 멘토링·기획봉사 매칭 자원봉사 플랫폼.', false, null, null, null, '대학생 가입 후 멘토링·봉사 매칭', '대학생 멘토링·기획봉사 매칭에 강점'),
  ('dovol', '청소년자원봉사 도볼', 'social', 'domestic', 'https://www.dovol.net/', '청소년 봉사활동 검색·신청·실적 원스톱 서비스.', false, null, null, null, '청소년 가입 후 봉사 검색·신청', '청소년 봉사활동 검색·신청·실적관리에 강점'),
  ('beautifulstore', '아름다운가게', 'social', 'domestic', 'https://www.beautifulstore.org/', '물품기부·재사용 판매로 이웃 돕는 나눔 플랫폼.', false, null, null, null, '물품 기부 또는 매장·온라인 구매', '물품기부·재사용 판매 나눔에 강점'),
  ('bigwalk', '빅워크', 'social', 'domestic', 'https://www.bigwalk.co.kr/', '걸음 기부로 사회·환경 문제 후원하는 앱.', false, null, null, null, '앱 설치 후 걸음 기부 참여', '걸음 기부로 사회·환경 문제 후원에 강점'),
  ('sepp', 'e스토어 36.5+', 'openmarket', 'domestic', 'https://www.sepp.or.kr/', '사회적경제기업 제품 공식 온라인 쇼핑몰.', false, null, null, null, '사회적경제기업 입점 신청', '사회적경제기업 제품 유통에 강점'),
  ('hknuri', '함께누리몰', 'openmarket', 'domestic', 'https://www.hknuri.co.kr/', '사회적기업·공정무역 제품 판매 커머스.', false, null, null, null, '사회적기업·공정무역 사업자 입점 신청', '사회적기업·공정무역 제품 판매에 강점'),
  ('fairtradeshop', '공정무역가게', 'openmarket', 'domestic', 'https://fairtradeshop.co.kr/', '공정무역기구 한국사무소 운영 공정무역 쇼핑몰.', false, null, null, null, '이용자 구매, 공정무역 제품 공급 협력', '공정무역 제품 유통에 강점'),
  ('buysocial', '바이소셜', 'openmarket', 'domestic', 'https://www.buysocial.or.kr/', '사회적경제 제품 구매·가치소비 캠페인 마켓.', false, null, null, null, '사회적경제기업 입점 또는 이용자 구매', '사회적경제 제품·가치소비 캠페인에 강점'),
  ('kr5', '튜터하이브', 'freelance', 'domestic', 'https://kr.tutorhive.co', '명문대 출신 유학생 과외 멘토 매칭 앱.', false, null, null, null, '튜터·학생 가입 후 프로필 등록·매칭', '유학생 과외 멘토 매칭에 강점'),
  ('uhakplanner', '유학플래너닷컴', 'content', 'domestic', 'https://www.uhakplanner.com/', '조기유학·해외대학 전문 유학 컨설팅.', false, null, null, null, '상담 신청 후 유학 컨설팅 진행', '조기유학·해외대학 유학 컨설팅에 강점'),
  ('uhakpeople', '유학피플', 'content', 'domestic', 'https://www.uhakpeople.com/', '해외유학·어학연수·조기유학 정보 포털.', false, null, null, null, '정보 열람 무료, 가입 시 상담 연계', '해외유학·어학연수 정보 제공에 강점'),
  ('edmuhak', 'edm유학센터', 'content', 'domestic', 'https://www.edmuhak.com/language-abroad', '국가별 어학연수·어학원 후기 비교.', false, null, null, null, '정보·후기 열람, 상담 신청 가능', '국가별 어학연수·어학원 후기 비교에 강점'),
  ('coei', '종로유학원', 'content', 'domestic', 'https://www.coei.com/', '어학연수·학위유학·조기유학 종합 유학원.', false, null, null, null, '상담 신청 후 유학 절차 진행', '어학연수·학위·조기유학 종합 유학원에 강점'),
  ('megagong', '넥스트공무원', 'content', 'domestic', 'https://www.megagong.net/', '9급·7급 공무원 인강, 합격 시 환급.', false, null, null, null, '가입 후 수강 신청(합격 환급형 상품)', '9급·7급 공무원 인강·합격 환급에 강점'),
  ('egosi', '해커스공무원', 'content', 'domestic', 'https://egosi.hackers.com/', '공무원 인강 및 수험정보 플랫폼.', false, null, null, null, '가입 후 인강 수강·수험정보 이용', '공무원 인강·수험정보 제공에 강점'),
  ('edumegong', '에듀공', 'content', 'domestic', 'https://www.edumegong.co.kr/', '공무원·경찰·소방 인강 및 교재 사이트.', false, null, null, null, '가입 후 인강 수강·교재 구매', '공무원·경찰·소방 인강·교재에 강점'),
  ('modoogong', '모두공', 'content', 'domestic', 'https://www.modoogong.com/', '학습량 관리형 공무원 인강 서비스.', false, null, null, null, '가입 후 수강 신청(학습량 관리형)', '학습량 관리형 공무원 인강에 강점'),
  ('passdong', '자격동스쿨', 'content', 'domestic', 'https://www.passdong.com/cert/', '자격증 독학 인강 플랫폼.', false, null, null, null, '가입 후 자격증 인강 수강', '자격증 독학 인강에 강점'),
  ('llo', '한국자격평생교육원', 'content', 'domestic', 'https://llo.or.kr/', '심리상담·지도사 등 자격증 인강.', false, null, null, null, '가입 후 수강 신청·결제', '심리상담·지도사 등 민간자격 인강에 특화'),
  ('lab', '잇올 랩', 'kids', 'domestic', 'https://m.lab.itall.com/', 'AI 합격예측 기반 입시전략 컨설팅 플랫폼.', false, null, null, null, '상담 예약 후 컨설팅 이용', 'AI 합격예측 기반 입시전략 컨설팅에 강점'),
  ('apple2', '이고다', 'kids', 'domestic', 'https://apps.apple.com/kr/app/id6449497486', '입시 컨설팅 매칭 플랫폼.', false, null, null, null, '가입 후 컨설턴트 매칭 신청', '입시 컨설팅 전문가 매칭에 강점'),
  ('mcc', '메가스터디 대입컨설팅', 'kids', 'domestic', 'https://mcc.megastudy.net/', '수시·정시·학종 맞춤 대입 컨설팅.', false, null, null, null, '상담 예약·결제 후 이용', '수시·정시·학종 맞춤 대입 컨설팅에 강점'),
  ('studymoa', '스터디모아', 'space', 'domestic', 'https://studymoa.me/', '스터디카페·스터디룸 좌석 예약 앱.', false, null, null, null, '앱 가입 후 좌석 예약·결제', '스터디카페·스터디룸 좌석 실시간 예약'),
  ('apple3', '와이즈스터디', 'space', 'domestic', 'https://apps.apple.com/kr/app/id1496015703', '프리미엄 독서실·스터디카페 좌석 예약.', false, null, null, null, '앱 가입 후 좌석 예약·결제', '프리미엄 독서실·스터디카페 좌석 예약'),
  ('pickko', '픽코', 'space', 'domestic', 'https://www.pickko.co.kr/', '전국 스터디카페·독서실 좌석 예약 앱.', false, null, null, null, '앱 가입 후 좌석 예약·결제', '전국 스터디카페·독서실 좌석 예약'),
  ('zaksim', '작심', 'space', 'domestic', 'https://www.zaksim.co.kr/kiosk', '무인 독서실·스터디카페 예약 결제.', false, null, null, null, '앱 가입 후 예약·결제', '무인 독서실·스터디카페 예약·결제에 강점'),
  ('studylive', '스터디라이브', 'content', 'domestic', 'https://studylive.co.kr/', '24시간 실시간 캠스터디 온라인 스터디룸.', false, null, null, null, '가입 후 스터디룸 참여', '24시간 실시간 캠스터디·온라인 스터디룸'),
  ('gongzakso', '공작소', 'content', 'domestic', 'https://www.gongzakso.com/', '온라인 스터디 그룹 모집·관리 앱.', false, null, null, null, '가입 후 그룹 개설·참여', '온라인 스터디 그룹 모집·관리에 강점'),
  ('hakwonsin', '학원의신', 'kids', 'domestic', 'https://hakwonsin.co.kr/', '전국 학원 정보·리뷰 비교 플랫폼.', false, null, null, null, '무료 가입 후 학원 검색·리뷰', '전국 학원 정보·리뷰 비교에 강점'),
  ('hakwonmap', '학원맵', 'kids', 'domestic', 'https://hakwonmap.com/', '학원 검색·비교·수강신청 통합 플랫폼.', false, null, null, null, '가입 후 학원 검색·수강신청', '학원 검색·비교·수강신청 통합에 강점'),
  ('sscoaching', '상상코칭', 'freelance', 'domestic', 'https://sscoaching.co.kr/', '성적·성향 맞춤 1:1 과외 매칭.', false, null, null, null, '가입 후 과외 매칭 신청', '성적·성향 맞춤 1:1 과외 매칭에 강점'),
  ('jinhak', '진학사', 'kids', 'domestic', 'https://www.jinhak.com/', '대입 합격예측·모의지원 입시 플랫폼.', false, null, null, null, '가입 후 성적 입력·서비스 이용', '대입 합격예측·모의지원에 강점'),
  ('adiga', '어디가', 'kids', 'domestic', 'https://www.adiga.kr/', '대교협 공식 대입정보 포털.', false, null, null, null, '회원가입 후 무료 이용', '대교협 공식 대입정보·성적 분석 제공'),
  ('gs25', '우리동네GS', 'delivery', 'domestic', 'https://gs25.gsretail.com/', '동네 편의점 즉시배송 퀵커머스.', false, null, null, null, '앱 가입 후 주문·즉시배송', '편의점 상품 즉시배송(퀵커머스)에 강점'),
  ('dongnemom', '동네맘', 'social', 'domestic', 'http://dongnemom.com/', '우리동네 지역·육아 정보 공유 맘 커뮤니티.', false, null, null, null, '무료 가입 후 이용', '지역·육아 정보 공유 커뮤니티'),
  ('mcafe', '맘카페', 'social', 'domestic', 'https://mcafe.me/', '전국 동네 맘 커뮤니티, 지역 정보·나눔 게시판.', false, null, null, null, '카페 가입 후 이용', '지역 정보·나눔 게시판 중심 맘 커뮤니티'),
  ('incheoneum2', '인천e음', 'social', 'domestic', 'https://incheoneum.or.kr/', '인천시 지역화폐, 동네 가맹점 캐시백 카드.', false, null, null, null, '앱 가입·카드 발급 후 사용', '인천 지역 가맹점 캐시백 지역화폐'),
  ('chatgpt', 'ChatGPT', 'ai_chat', 'overseas', 'https://chatgpt.com', 'OpenAI의 범용 AI 챗봇 — 글쓰기·분석·이미지 생성까지 가장 널리 쓰이는 기본기.', true, null, null, null, '가입 후 무료 사용, 유료 구독 제공', '글쓰기·분석·이미지 생성까지 두루 강한 범용 챗봇'),
  ('claude-ai', 'Claude', 'ai_chat', 'overseas', 'https://claude.ai', 'Anthropic의 AI 어시스턴트 — 긴 문서 이해와 꼼꼼한 글쓰기·코딩에 강점.', true, null, null, null, '가입 후 무료 사용, 유료 구독 제공', '긴 문서 이해·꼼꼼한 글쓰기·코딩에 강점'),
  ('gemini', 'Gemini', 'ai_chat', 'overseas', 'https://gemini.google.com', '구글의 AI 챗봇 — 검색·지메일·유튜브 등 구글 서비스와 연동.', true, null, null, null, '가입 후 무료 사용, 유료 구독 제공', '검색·지메일·유튜브 등 구글 서비스 연동에 강점'),
  ('ms-copilot', 'Microsoft Copilot', 'ai_chat', 'overseas', 'https://copilot.microsoft.com', '윈도우·엣지·오피스에 내장되는 마이크로소프트의 AI 비서.', true, null, null, null, '가입 후 무료 사용, 유료 구독 제공', '윈도우·엣지·오피스 내장 연동에 강점'),
  ('wrtn', '뤼튼', 'ai_chat', 'domestic', 'https://wrtn.ai', '국내 대표 AI 포털 — 챗봇·이미지·과제 도구를 한국어 중심으로 제공.', true, null, null, null, '가입 후 무료 사용', '한국어 중심 챗봇·이미지·과제 도구 통합'),
  ('clova-x', 'CLOVA X', 'ai_chat', 'domestic', 'https://clova-x.naver.com', '네이버의 한국어 특화 AI 챗봇 — 국내 정보·쇼핑 맥락 이해.', true, null, null, null, '가입 후 무료 사용', '한국어·국내 정보·쇼핑 맥락 이해에 강점'),
  ('grok', 'Grok', 'ai_chat', 'overseas', 'https://grok.com', 'xAI의 AI 챗봇 — X(트위터) 실시간 정보 반영이 특징.', true, null, null, null, '가입 후 사용(유료 구독 위주)', 'X(트위터) 실시간 정보 반영에 강점'),
  ('lechat', 'Le Chat', 'ai_chat', 'overseas', 'https://chat.mistral.ai', '유럽 미스트랄의 챗봇 — 빠른 응답 속도와 넓은 무료 사용 폭.', true, null, null, null, '가입 후 무료 사용, 유료 구독 제공', '빠른 응답 속도·넓은 무료 사용 폭'),
  ('notion-ai', 'Notion AI', 'ai_writing', 'overseas', 'https://www.notion.com/product/ai', '노션 문서 안에서 요약·초안·번역을 처리하는 업무용 글쓰기 AI.', true, null, null, null, '노션 가입 후 유료 애드온 사용', '노션 문서 내 요약·초안·번역에 강점'),
  ('gamma-app', 'Gamma', 'ai_writing', 'overseas', 'https://gamma.app', '프롬프트 한 줄로 발표자료·문서·웹페이지를 만들어 주는 생성 도구.', true, null, null, null, '가입 후 무료 크레딧, 유료 구독', '프롬프트로 발표자료·문서·웹페이지 생성'),
  ('jasper', 'Jasper', 'ai_writing', 'overseas', 'https://www.jasper.ai', '브랜드 톤을 학습해 마케팅 카피·블로그를 쓰는 기업용 글쓰기 AI.', true, null, null, null, '가입 후 유료 구독(체험 제공)', '브랜드 톤 학습 마케팅 카피·블로그 생성'),
  ('copy-ai', 'Copy.ai', 'ai_writing', 'overseas', 'https://www.copy.ai', '광고 카피·세일즈 문구 템플릿이 풍부한 카피라이팅 AI.', true, null, null, null, '가입 후 무료 플랜·유료 구독', '광고·세일즈 카피 템플릿이 풍부'),
  ('writesonic', 'Writesonic', 'ai_writing', 'overseas', 'https://writesonic.com', 'SEO 블로그·광고 문구를 빠르게 뽑는 콘텐츠 생성 AI.', true, null, null, null, '가입 후 무료 플랜·유료 구독', 'SEO 블로그·광고 문구 빠른 생성에 강점'),
  ('grammarly', 'Grammarly', 'ai_writing', 'overseas', 'https://www.grammarly.com', '영문 문법·톤 교정 — 영어 이메일·문서 품질을 올려주는 도구.', true, null, null, null, '가입 후 무료 사용, 유료 구독 제공', '영문 문법·톤 교정에 강점'),
  ('deepl-write', 'DeepL Write', 'ai_writing', 'overseas', 'https://www.deepl.com/write', '영어·독일어 문장을 자연스럽게 다듬어 주는 교정 AI.', true, null, null, null, '가입 후 무료 사용, 유료 구독 제공', '영어·독일어 문장 자연스러운 교정에 강점'),
  ('sudowrite', 'Sudowrite', 'ai_writing', 'overseas', 'https://www.sudowrite.com', '소설·창작 글쓰기에 특화된 스토리텔링 AI.', true, null, null, null, '가입 후 유료 구독(체험 제공)', '소설·창작 스토리텔링에 특화'),
  ('midjourney', 'Midjourney', 'ai_image', 'overseas', 'https://www.midjourney.com', '예술적 완성도로 유명한 이미지 생성 AI.', true, null, null, null, '가입 후 구독 시작(웹·디스코드에서 이용)', '예술적·회화적 스타일 이미지 생성에 강점'),
  ('adobe-firefly', 'Adobe Firefly', 'ai_image', 'overseas', 'https://firefly.adobe.com', '상업 사용을 고려한 어도비의 이미지 생성 — 포토샵과 연동.', true, null, null, null, '어도비 계정 가입 후 사용(크레딧 기반)', '상업 사용 고려·포토샵 연동 이미지 생성에 강점'),
  ('canva', 'Canva AI', 'ai_image', 'overseas', 'https://www.canva.com', '디자인 툴 캔바에 내장된 이미지 생성·매직 편집 기능.', true, null, null, null, '가입 후 바로 사용(무료·구독 혼합)', '디자인 툴 내장 이미지 생성·매직 편집에 강점'),
  ('ideogram', 'Ideogram', 'ai_image', 'overseas', 'https://ideogram.ai', '이미지 속 글자(타이포그래피) 표현에 강한 생성 AI.', true, null, null, null, '가입 후 바로 사용(무료 체험 제공)', '이미지 속 글자·타이포그래피 표현에 강점'),
  ('leonardo-ai', 'Leonardo.Ai', 'ai_image', 'overseas', 'https://leonardo.ai', '게임·제품 컨셉 아트에 강한 이미지 생성 스튜디오.', true, null, null, null, '가입 후 바로 사용(무료 크레딧 제공)', '게임·제품 컨셉 아트 생성에 강점'),
  ('stability-ai', 'Stable Diffusion', 'ai_image', 'overseas', 'https://stability.ai', '오픈소스 이미지 생성 모델 — 직접 설치·커스터마이즈 가능.', true, null, null, null, '오픈소스 모델 직접 설치 또는 API 이용', '오픈소스 기반 직접 설치·커스터마이즈에 강점'),
  ('flux-bfl', 'FLUX', 'ai_image', 'overseas', 'https://bfl.ai', '고품질 오픈 가중치 이미지 생성 모델 FLUX 시리즈.', true, null, null, null, '오픈 가중치 직접 이용 또는 API 연동', '고품질 오픈 가중치 이미지 생성에 강점'),
  ('recraft', 'Recraft', 'ai_image', 'overseas', 'https://www.recraft.ai', '벡터·브랜드 스타일 유지에 강한 디자이너용 생성 AI.', true, null, null, null, '가입 후 바로 사용(무료·구독 혼합)', '벡터·브랜드 스타일 유지 디자인에 강점'),
  ('remove-bg', 'remove.bg', 'ai_image', 'overseas', 'https://www.remove.bg', '사진 배경을 자동으로 지워 주는 원클릭 도구.', true, null, null, null, '가입 없이도 이용 가능(API·크레딧 제공)', '사진 배경 자동 제거 원클릭 처리에 강점'),
  ('photoroom', 'PhotoRoom', 'ai_image', 'overseas', 'https://www.photoroom.com', '상품 사진 배경 제거·연출에 특화 — 쇼핑몰 상세컷 제작에 유용.', true, null, null, null, '가입 후 바로 사용(무료 체험 제공)', '상품 사진 배경 제거·연출, 상세컷 제작에 강점'),
  ('sora', 'Sora', 'ai_video', 'overseas', 'https://sora.com', 'OpenAI의 텍스트→영상 생성 서비스.', true, null, null, null, 'OpenAI 계정 가입·구독 후 사용', '텍스트 기반 영상 생성에 강점'),
  ('runway', 'Runway', 'ai_video', 'overseas', 'https://runwayml.com', '영상 생성·편집(제거·확장) 도구의 선두 주자.', true, null, null, null, '가입 후 바로 사용(무료 크레딧 제공)', '영상 생성·편집(제거·확장) 통합 작업에 강점'),
  ('kling', 'Kling AI', 'ai_video', 'overseas', 'https://klingai.com', '인물 동작 표현에 강한 고품질 영상 생성 AI.', true, null, null, null, '가입 후 바로 사용(무료 크레딧 제공)', '인물 동작 표현·고품질 영상 생성에 강점'),
  ('pika', 'Pika', 'ai_video', 'overseas', 'https://pika.art', '짧은 밈·효과 영상 생성에 강한 도구.', true, null, null, null, '가입 후 바로 사용(무료 체험 제공)', '짧은 밈·효과 영상 생성에 강점'),
  ('luma', 'Luma Dream Machine', 'ai_video', 'overseas', 'https://lumalabs.ai', '사실적인 텍스트→영상 생성 모델.', true, null, null, null, '가입 후 바로 사용(무료 체험 제공)', '사실적인 텍스트→영상 생성에 강점'),
  ('heygen', 'HeyGen', 'ai_video', 'overseas', 'https://www.heygen.com', 'AI 아바타가 대본을 읽어 주는 영상 — 강의·홍보 영상 제작.', true, null, null, null, '가입 후 사용(무료 체험 후 구독)', 'AI 아바타 대본 낭독, 강의·홍보 영상 제작에 강점'),
  ('synthesia', 'Synthesia', 'ai_video', 'overseas', 'https://www.synthesia.io', '기업 교육용 AI 아바타 영상 제작 플랫폼.', true, null, null, null, '가입 후 구독 시작(기업용 플랜)', '기업 교육용 AI 아바타 영상 제작에 강점'),
  ('descript', 'Descript', 'ai_video', 'overseas', 'https://www.descript.com', '문서를 고치듯 영상·팟캐스트를 편집하는 도구.', true, null, null, null, '가입 후 사용(무료 플랜 제공)', '문서 편집 방식의 영상·팟캐스트 편집에 강점'),
  ('capcut', 'CapCut', 'ai_video', 'overseas', 'https://www.capcut.com', '자동 자막·템플릿으로 숏폼을 빠르게 만드는 편집 앱.', true, null, null, null, '가입 후 바로 사용(무료 기능 다수)', '자동 자막·템플릿 기반 숏폼 제작에 강점'),
  ('elevenlabs', 'ElevenLabs', 'ai_audio', 'overseas', 'https://elevenlabs.io', '자연스러운 AI 성우·더빙 — 다국어 보이스오버 제작.', true, null, null, null, '가입 후 사용(무료 크레딧 후 구독)', '자연스러운 AI 성우·다국어 더빙 제작에 강점'),
  ('suno', 'Suno', 'ai_audio', 'overseas', 'https://suno.com', '가사만 쓰면 노래를 만들어 주는 음악 생성 AI.', true, null, null, null, '가입 후 바로 사용(무료 크레딧 제공)', '가사 입력만으로 노래 생성에 강점'),
  ('udio', 'Udio', 'ai_audio', 'overseas', 'https://www.udio.com', '장르·보컬 스타일을 지정하는 고음질 음악 생성 AI.', true, null, null, null, '가입 후 바로 사용(무료 크레딧 제공)', '장르·보컬 지정 고음질 음악 생성에 강점'),
  ('supertone', '수퍼톤', 'ai_audio', 'domestic', 'https://supertone.ai', '하이브 계열 음성 합성·변환 기술 — 콘텐츠용 보이스 제작.', true, null, null, null, '가입 후 사용(콘텐츠용 보이스 제작)', '음성 합성·변환 콘텐츠 보이스 제작에 강점'),
  ('murf', 'Murf AI', 'ai_audio', 'overseas', 'https://murf.ai', '비즈니스 나레이션용 AI 보이스 스튜디오.', true, null, null, null, '가입 후 사용(무료 체험 후 구독)', '비즈니스 나레이션용 AI 보이스 제작에 강점'),
  ('adobe-podcast', 'Adobe Podcast', 'ai_audio', 'overseas', 'https://podcast.adobe.com', '녹음 잡음을 스튜디오 품질로 보정해 주는 도구.', true, null, null, null, '어도비 계정 가입 후 사용', '녹음 잡음 제거·음질 보정에 강점'),
  ('github-copilot', 'GitHub Copilot', 'ai_code', 'overseas', 'https://github.com/features/copilot', 'IDE 안에서 코드를 제안하는 코드 자동완성의 표준.', true, null, null, null, '가입 후 구독 시작(IDE 확장 설치)', 'IDE 내 코드 자동완성·제안에 강점'),
  ('cursor', 'Cursor', 'ai_code', 'overseas', 'https://cursor.com', 'AI 중심으로 설계된 코드 에디터 — 코드베이스와 대화하며 수정.', true, null, null, null, '에디터 설치·가입 후 사용(무료 플랜 제공)', '코드베이스와 대화하며 수정하는 작업에 강점'),
  ('claude-code', 'Claude Code', 'ai_code', 'overseas', 'https://claude.com/claude-code', '터미널·IDE에서 작업을 통째로 맡기는 Anthropic의 코딩 에이전트.', true, null, null, null, '가입 후 터미널·IDE에서 사용', '작업 단위를 맡기는 터미널·IDE 코딩 에이전트에 강점'),
  ('windsurf', 'Windsurf', 'ai_code', 'overseas', 'https://windsurf.com', '멀티파일 작업을 자동화하는 에이전트형 AI IDE.', true, null, null, null, '에디터 설치·가입 후 사용(무료 플랜 제공)', '멀티파일 작업 자동화 에이전트형 IDE에 강점'),
  ('replit', 'Replit', 'ai_code', 'overseas', 'https://replit.com', '브라우저에서 앱을 만들고 배포까지 — AI 에이전트 내장.', true, null, null, null, '가입 후 브라우저에서 바로 사용', '브라우저 기반 앱 개발·배포, AI 에이전트 내장에 강점'),
  ('v0', 'v0', 'ai_code', 'overseas', 'https://v0.dev', '프롬프트로 웹 UI(리액트)를 생성하는 Vercel의 도구.', true, null, null, null, '가입 후 사용(무료 크레딧 제공)', '프롬프트로 리액트 웹 UI 생성에 강점'),
  ('lovable', 'Lovable', 'ai_code', 'overseas', 'https://lovable.dev', '대화만으로 웹 서비스를 만들어 주는 AI 앱 빌더.', true, null, null, null, '가입 후 사용(무료 크레딧 제공)', '대화 기반 웹 서비스 생성에 강점'),
  ('bolt-new', 'Bolt.new', 'ai_code', 'overseas', 'https://bolt.new', '브라우저에서 풀스택 앱을 생성·실행하는 AI 빌더.', true, null, null, null, '가입 후 브라우저에서 바로 사용', '브라우저에서 풀스택 앱 생성·실행에 강점'),
  ('devin', 'Devin', 'ai_code', 'overseas', 'https://devin.ai', '이슈를 맡기면 스스로 코딩하는 AI 소프트웨어 엔지니어.', true, null, null, null, '가입·구독 후 이슈 위임하여 사용', '이슈를 맡아 자율 코딩하는 에이전트에 강점'),
  ('clova-note', '클로바노트', 'ai_meeting', 'domestic', 'https://clovanote.naver.com', '네이버의 회의 녹음→텍스트·요약 — 한국어 인식에 강점.', true, null, null, null, '네이버 계정 가입 후 바로 사용', '한국어 회의 녹음→텍스트·요약에 강점'),
  ('daglo', '다글로', 'ai_meeting', 'domestic', 'https://daglo.ai', '회의록·인터뷰 전사에 쓰는 국내 음성 기록 서비스.', true, null, null, null, '가입 후 바로 사용(무료 크레딧·구독형)', '국내 한국어 음성 전사·회의록 정리에 강점'),
  ('otter', 'Otter.ai', 'ai_meeting', 'overseas', 'https://otter.ai', '영어 회의 실시간 전사·요약의 대표 서비스.', true, null, null, null, '가입 후 바로 사용(무료 플랜·구독형)', '영어 회의 실시간 전사·요약에 강점'),
  ('fireflies', 'Fireflies.ai', 'ai_meeting', 'overseas', 'https://fireflies.ai', '줌·미트 회의에 참여해 회의록을 자동 작성.', true, null, null, null, '가입 후 회의 도구 연동(무료 플랜 제공)', '줌·미트 자동 참여 회의록 작성에 강점'),
  ('fathom', 'Fathom', 'ai_meeting', 'overseas', 'https://fathom.video', '무료 사용 폭이 넓은 회의 요약 — 하이라이트 클립 생성.', true, null, null, null, '가입 후 바로 사용(무료 폭 넓음)', '무료 요약·하이라이트 클립 생성에 강점'),
  ('tldv', 'tl;dv', 'ai_meeting', 'overseas', 'https://tldv.io', '회의 녹화·타임스탬프 요약 — 여러 회의 도구 지원.', true, null, null, null, '가입 후 회의 도구 연동(무료 플랜 제공)', '녹화·타임스탬프 요약, 다수 회의 도구 지원'),
  ('channeltalk', '채널톡', 'ai_marketing', 'domestic', 'https://channel.io', '국내 대표 채팅상담 — AI 상담봇으로 응대를 자동화.', true, null, null, null, '가입 후 사이트에 위젯 설치(구독형)', '채팅상담·AI 상담봇 응대 자동화에 강점'),
  ('intercom', 'Intercom Fin', 'ai_marketing', 'overseas', 'https://www.intercom.com', '고객 문의를 스스로 해결하는 AI 상담 에이전트.', true, null, null, null, '가입·연동 후 사용(구독형)', 'AI 에이전트가 고객 문의 자체 해결에 강점'),
  ('zendesk-ai', 'Zendesk AI', 'ai_marketing', 'overseas', 'https://www.zendesk.com', '헬프데스크에 내장된 AI 응대·문의 분류.', true, null, null, null, '헬프데스크 구독 후 AI 기능 활성화', '헬프데스크 내장 AI 응대·문의 분류에 강점'),
  ('tidio', 'Tidio', 'ai_marketing', 'overseas', 'https://www.tidio.com', '소규모 쇼핑몰용 챗봇·라이브챗 — 간단하게 도입.', true, null, null, null, '가입 후 쇼핑몰에 위젯 설치(무료 플랜)', '소규모 쇼핑몰 챗봇·라이브챗 간편 도입에 강점'),
  ('adcreative', 'AdCreative.ai', 'ai_marketing', 'overseas', 'https://www.adcreative.ai', '광고 배너·소재를 대량 생성하는 퍼포먼스 마케팅 AI.', true, null, null, null, '가입 후 바로 사용(구독형)', '광고 배너·소재 대량 생성에 강점'),
  ('predis', 'Predis.ai', 'ai_marketing', 'overseas', 'https://predis.ai', 'SNS 게시물(이미지+카피)을 자동 생성·예약하는 도구.', true, null, null, null, '가입 후 바로 사용(무료 플랜·구독형)', 'SNS 게시물 자동 생성·예약에 강점'),
  ('surfer', 'Surfer', 'ai_marketing', 'overseas', 'https://surferseo.com', 'SEO 점수를 기준으로 글을 최적화하는 콘텐츠 도구.', true, null, null, null, '가입 후 바로 사용(구독형)', 'SEO 점수 기반 콘텐츠 최적화에 강점'),
  ('zapier', 'Zapier', 'ai_auto', 'overseas', 'https://zapier.com', '수천 개 앱을 연결하는 업무 자동화 — AI 액션 내장.', true, null, null, null, '가입 후 바로 사용(무료 플랜·구독형)', '다수 앱 연결 업무 자동화에 강점'),
  ('make-com', 'Make', 'ai_auto', 'overseas', 'https://www.make.com', '시각적 시나리오로 짜는 자동화 — 복잡한 흐름에 강점.', true, null, null, null, '가입 후 바로 사용(무료 플랜·구독형)', '시각적 시나리오로 복잡한 자동화 구성에 강점'),
  ('n8n', 'n8n', 'ai_auto', 'overseas', 'https://n8n.io', '오픈소스 자동화 — AI 에이전트 워크플로 구축·자체 호스팅 가능.', true, null, null, null, '가입 또는 자체 호스팅(오픈소스)', '자체 호스팅·AI 에이전트 워크플로 구축에 강점'),
  ('lindy', 'Lindy', 'ai_auto', 'overseas', 'https://www.lindy.ai', '이메일·일정 등 업무를 맡기는 노코드 AI 비서 빌더.', true, null, null, null, '가입 후 바로 사용(구독형)', '노코드 AI 비서로 업무 위임에 강점'),
  ('relevance-ai', 'Relevance AI', 'ai_auto', 'overseas', 'https://relevanceai.com', '영업·리서치용 AI 에이전트 팀을 만드는 플랫폼.', true, null, null, null, '가입 후 바로 사용(구독형)', '영업·리서치용 AI 에이전트 구성에 강점'),
  ('manus', 'Manus', 'ai_auto', 'overseas', 'https://manus.im', '조사·작업을 자율 수행하는 범용 AI 에이전트.', true, null, null, null, '가입 후 사용(구독형)', '자율 조사·작업 수행 범용 에이전트에 강점'),
  ('dify', 'Dify', 'ai_auto', 'overseas', 'https://dify.ai', '오픈소스 LLM 앱·에이전트 빌더 — 사내 챗봇 구축에 활용.', true, null, null, null, '가입 또는 자체 호스팅(오픈소스)', '사내 LLM 앱·챗봇 구축에 강점'),
  ('perplexity', 'Perplexity', 'ai_research', 'overseas', 'https://www.perplexity.ai', '출처 링크와 함께 답하는 AI 검색 — 최신 정보 조사에 특화.', true, null, null, null, '가입 후 바로 사용(무료 플랜·구독형)', '출처 기반 최신 정보 조사에 강점'),
  ('notebooklm', 'NotebookLM', 'ai_research', 'overseas', 'https://notebooklm.google.com', '내 자료를 올려 근거 기반으로 질문하는 구글의 리서치 도구.', true, null, null, null, '구글 계정으로 바로 사용(무료)', '업로드 자료 근거 기반 질의·정리에 강점'),
  ('liner', '라이너', 'ai_research', 'domestic', 'https://getliner.com', '출처 신뢰도를 강조하는 국내 AI 검색·하이라이트 서비스.', true, null, null, null, '가입 후 바로 사용(무료 플랜·구독형)', '출처 신뢰도 강조 AI 검색·하이라이트에 강점'),
  ('deepl', 'DeepL', 'ai_research', 'overseas', 'https://www.deepl.com', '자연스러운 번역 품질로 유명한 번역기.', true, null, null, null, '가입 후 사용(무료 플랜·구독형)', '자연스러운 번역 품질에 강점'),
  ('papago', '파파고', 'ai_research', 'domestic', 'https://papago.naver.com', '네이버 번역 — 한국어 번역 쌍에 강점.', true, null, null, null, '가입 없이 바로 사용(무료)', '한국어 번역 쌍 품질에 강점'),
  ('flitto-ai', '플리토', 'ai_research', 'domestic', 'https://www.flitto.com', '전문 번역과 AI 번역 데이터를 함께 다루는 번역 플랫폼.', true, null, null, null, '가입 후 사용(전문·AI 번역)', '전문 번역과 AI 번역 데이터 결합에 강점'),
  ('elicit', 'Elicit', 'ai_research', 'overseas', 'https://elicit.com', '논문을 찾아 표로 정리해 주는 연구 특화 AI.', true, null, null, null, '가입 후 바로 사용(무료 플랜·구독형)', '논문 검색·표 정리 등 연구 작업에 강점'),
  ('consensus', 'Consensus', 'ai_research', 'overseas', 'https://consensus.app', '논문 근거로 질문에 답하는 학술 검색 AI.', true, null, null, null, '가입 후 바로 사용(무료 플랜·구독형)', '논문 근거 기반 학술 질의응답에 강점')
on conflict (id) do nothing;

insert into public.partner_type_groups (id, label, descr, sort) values
  ('traffic', '트래픽·노출 교환', '돈 없이 서로의 지면과 채널을 맞바꾼다 — 가장 쉬운 시작점', 0),
  ('growth', '회원 성장', '상대의 회원을 내 회원으로 — 상호송출·레퍼럴·간편입점', 1),
  ('commerce', '판매·상품 결합', '상품과 혜택을 묶어 양쪽 거래를 함께 키운다', 2),
  ('comarketing', '공동 마케팅', '이벤트·세미나·리포트를 함께 만들어 비용은 반, 도달은 두 배', 3),
  ('infra', '기능·데이터 연동', '서로의 기능·데이터·인프라를 연결하는 깊은 제휴', 4),
  ('trust', '신뢰·소개', '검증 배지와 리드 소개로 신뢰를 주고받는다', 5)
on conflict (id) do nothing;

insert into public.partner_types (id, group_id, label, descr, mechanics, example, settlement, effort, goals, sort) values
  ('banner_swap', 'traffic', '배너 맞교환', '서로의 홈·주요 지면에 배너를 동일 가치로 상호 게재', '노출량(또는 기간)을 동일 기준으로 정하고 각자 배너를 게재. 월 단위로 노출 수치를 상호 공유', 'B2B 네트워킹 플랫폼 ↔ MRO몰이 메인 배너를 한 달간 맞교환', 'none', 'light', '{"growth","awareness","cost"}', 0),
  ('newsletter_swap', 'traffic', '뉴스레터·푸시 스왑', '각자의 뉴스레터·앱 푸시에서 상대 플랫폼을 소개', '발송 리스트 규모를 맞춰 회당 교환. 서로의 회원 DB는 넘기지 않고 각자 발송(개인정보 이관 없음)', '직무 뉴스레터 하단 배너 ↔ 커리어 플랫폼 앱 푸시 1회', 'none', 'light', '{"growth","content"}', 1),
  ('content_exchange', 'traffic', '콘텐츠 교차 게재', '블로그·가이드 기고를 맞교환하고 상호 백링크', '상대 고객에게 유용한 실무 콘텐츠를 서로의 블로그에 기고. SEO 백링크 효과 덤', '물류 플랫폼이 커머스 블로그에 ''풀필먼트 고르는 법'' 기고', 'none', 'light', '{"content","awareness"}', 2),
  ('partner_zone', 'traffic', '파트너관 상호 입점', '앱·웹의 ''추천 서비스'' 코너에 서로를 상시 노출', '각자 서비스 내 파트너 코너를 만들고 상대 서비스 카드를 상시 게재(딥링크)', '쇼핑몰 빌더의 ''추천 도구''에 마케팅 SaaS 입점, 반대 방향도 동일', 'none', 'mid', '{"growth","awareness"}', 3),
  ('cross_signup', 'growth', '회원 상호송출', '가입 완료·핵심 액션 시점에 상대 플랫폼을 추천', '가입 완료 화면·온보딩 메일에 ''함께 쓰면 좋은 서비스''로 상대를 노출. 전환 수치 상호 공유', '펀딩 종료 메이커에게 상시 판매채널을, 판매채널 셀러에게 펀딩 개설을 안내', 'none', 'light', '{"growth"}', 4),
  ('referral_fee', 'growth', '레퍼럴 제휴 (성과 수수료)', '추천 링크·코드로 발생한 가입·거래에 성과 수수료 지급', '고유 추천 코드/UTM 링크 발급 → 전환 발생 시 건당·비율 수수료. 정산은 두 플랫폼이 직접(세모플은 연결만)', '회원모집 중인 플랫폼이 추천 가입 1건당 정액 지급, 파트너는 자기 회원에게 안내', 'direct', 'mid', '{"growth","revenue"}', 5),
  ('cross_onboarding', 'growth', '크로스 온보딩 (간편 입점)', '내 회원이 상대 플랫폼에 서류 재활용·우대 심사로 쉽게 입점', '입점 서류·검증 결과를 회원 동의하에 재활용하거나 전용 입점 링크로 심사 우대', '오픈마켓 우수 셀러가 물류 플랫폼에 원클릭 가입 + 첫 달 우대가', 'none', 'mid', '{"growth"}', 6),
  ('member_benefit', 'growth', '멤버십 상호 혜택', 'A 회원에게 B의 상시 할인·우대를 제공 (양방향)', '회원 등급·인증 기준으로 상대 서비스 상시 혜택 부여. 혜택 코드 방식이면 개인정보 이관 없음', '지식산업센터 입주사 인증 회원에게 사무용품몰 상시 할인', 'none', 'mid', '{"growth","awareness"}', 7),
  ('coupon_exchange', 'commerce', '쿠폰 상호 제공', '구매완료·예약확정 화면에 상대 플랫폼 쿠폰을 노출', '전환이 끝난 시점(구매완료)에 상대 쿠폰 노출 — 자기 전환을 깎지 않으면서 상대에게 고객 전달', '반려동물 커머스 주문완료 화면 ↔ 애견동반 숙소 예약확정 화면 쿠폰 맞교환', 'none', 'light', '{"revenue","growth"}', 8),
  ('bundle', 'commerce', '번들·패키지', '두 플랫폼의 상품·서비스를 묶어 패키지로 판매', '묶음 구성만 공동으로 하고 결제·배송·정산은 각자 자기 상품만 처리(교차 정산 없음)', '이유식 구독 첫 결제에 육아용품 할인권 동봉, 반대 방향도 동일', 'none', 'mid', '{"revenue"}', 9),
  ('joint_gongu', 'commerce', '공동구매 합동 진행', '양쪽 회원을 모아 한 번의 공동구매를 함께 연다', '모집 인원·물량을 합산해 단가를 낮추고, 주문·정산은 각 플랫폼이 자기 회원 몫만 처리', '두 지역 커머스가 제철 과일 공구를 합동 진행해 최소물량 돌파', 'none', 'mid', '{"revenue","growth"}', 10),
  ('affiliate_listing', 'commerce', '위탁·어필리에이트 입점', '상대 플랫폼의 상품·서비스를 내 지면에서 판매·중개', '링크·API로 상대 상품을 내 카탈로그에 노출, 판매 발생 시 수수료(당사자 직접 정산)', '인테리어 플랫폼이 가구 렌탈 상품을 자기 앱에서 판매 중개', 'direct', 'heavy', '{"revenue"}', 11),
  ('joint_event', 'comarketing', '공동 이벤트·챌린지', '참가형 이벤트를 공동 개최해 양쪽 브랜드를 함께 노출', '기획·경품·홍보를 분담하고 참가 접수는 각자 채널로. 성과(참가자 수) 상호 공유', '러닝 플랫폼 대회 완주자에게 건강식단 구독 체험권 리워드', 'share', 'mid', '{"awareness","growth"}', 12),
  ('joint_webinar', 'comarketing', '공동 웨비나·교육', 'B2B 실무 세미나를 공동 개최해 참가 리드를 나눈다', '주제·연사를 나눠 맡고 신청 페이지 공동 운영. 참가자 동의 기반으로 리드 공유', 'B2B 네트워킹 플랫폼 × 제조 견적 플랫폼의 ''공장 세일즈'' 웨비나', 'share', 'mid', '{"awareness","growth","content"}', 13),
  ('joint_report', 'comarketing', '공동 리서치·리포트', '업계 데이터 리포트를 공동 발행해 다운로드 리드를 수집', '각자 보유한 (비개인) 데이터·인사이트를 합쳐 리포트 발행, 다운로드 신청 리드는 동의 기반 공유', '물류 플랫폼 × 커머스 플랫폼의 ''이커머스 배송 트렌드'' 리포트', 'share', 'mid', '{"content","awareness"}', 14),
  ('offline_popup', 'comarketing', '오프라인 팝업·부스 공동 운영', '박람회 부스·팝업스토어를 함께 열어 비용을 나눈다', '부스 임차·운영 인력을 분담하고 서로의 고객층에 함께 노출', '창업 박람회에서 쇼핑몰 빌더 × 풀필먼트가 공동 부스', 'share', 'heavy', '{"awareness","cost"}', 15),
  ('api_embed', 'infra', 'API·위젯 연동', '상대 플랫폼의 기능을 내 서비스 안에 임베드', 'API·위젯으로 상대 기능(견적·예약·검색)을 내 화면에 통합. 발생 거래는 성과 기준 정산 가능', '커머스 셀러센터 안에 물류 플랫폼 견적 위젯 임베드', 'direct', 'heavy', '{"revenue","growth"}', 16),
  ('data_partnership', 'infra', '데이터 제휴', '상품·시세·카탈로그 데이터를 상호 제공 (개인정보 제외)', '비개인 데이터(시세·재고·카탈로그)만 API로 교환. 회원 DB 이관은 하지 않는다', '수산물 시세 플랫폼 데이터를 식자재 발주 앱에 제공, 반대로 수요 데이터 공유', 'direct', 'heavy', '{"revenue","content"}', 17),
  ('infra_deal', 'infra', '인프라 우대 제휴', '물류·결제·풀필먼트 등 인프라를 파트너 회원에게 우대 조건으로', '파트너 플랫폼 회원 대상 전용 요금·우선 처리 제공, 상대는 자기 채널에서 안내', '풀필먼트가 특정 오픈마켓 셀러에게 첫 3개월 보관비 우대', 'direct', 'mid', '{"growth","revenue"}', 18),
  ('trust_badge', 'trust', '파트너 인증 배지', '상호 검증을 마친 파트너임을 배지로 표시해 신뢰를 이전', '상호 실사·검증 후 서로의 지면에 ''공식 파트너'' 배지와 소개 페이지 게재', '세무 플랫폼 × 법인설립 플랫폼이 상호 공식 파트너 표기', 'none', 'light', '{"awareness"}', 19),
  ('lead_exchange', 'trust', 'B2B 리드 상호 소개', '내게 맞지 않는 문의를 맞는 파트너에게 소개 (동의 기반)', '고객 동의를 받은 문의만 소개. 개인정보 최소화 원칙 — 소개 성사 시 정액 사례 가능(당사자 간)', '인테리어 견적 문의 중 상업공간 건은 상업 전문 플랫폼으로 소개', 'direct', 'light', '{"revenue","awareness"}', 20),
  ('group_alliance', 'trust', '버티컬 연합 (3사 이상)', '같은 고객군의 플랫폼 여럿이 혜택·마케팅 연합을 결성', '동일 타깃(예: 1인 셀러)의 비경쟁 플랫폼 3~5곳이 공동 혜택 패키지·공동 캠페인 운영', '쇼핑몰 빌더 + 풀필먼트 + 세무 + 마케팅 SaaS의 ''창업 스타터 연합''', 'share', 'heavy', '{"growth","awareness","cost"}', 21)
on conflict (id) do nothing;

insert into public.deals (id, category_id, region, revenue_band, mode, summary, status, is_demo, posted) values
  ('D-001', 'handmade', 'domestic', '연매출 1~5억', '자산 전부 양수도(운영 승계 포함)', '운영 6년차 수공예 버티컬 마켓. 작가 풀·단골 고객 보유, 운영자 이직으로 매각 희망.', 'open', true, '2026-06-15'),
  ('D-002', 'delivery', 'domestic', '연매출 5~10억', '자산 선별 양수도', '지역 기반 배달 중개. 가맹점 네트워크·주문 시스템 등 핵심 자산 중심의 인수 협의 희망.', 'open', true, '2026-06-22'),
  ('D-003', 'content', 'domestic', '연매출 1억 미만', '자산 선별 양수도', '니치 취미 클래스 플랫폼. 콘텐츠 라이브러리와 회원 DB 중심의 자산 매각.', 'in_progress', true, '2026-06-05')
on conflict (id) do nothing;

insert into public.plans (id, label, monthly_price, descr, active, sort) values
  ('free',    'Free',    0,      '등재·제휴 프로필·배너교환형 무제한·월 무료 크레딧', true,  0),
  ('pro',     'Pro',     66000,  'B형 연결 월 3건 포함·검증 배지·우선 검수·파트너 검색 무제한', false, 1),
  ('premium', 'Premium', 220000, '매칭 매니저 큐레이션·깊은연동 우선 소개·계약 템플릿·성과 리포트', false, 2)
on conflict (id) do nothing;

insert into public.boost_tiers (id, name, placement, cpm, est_ctr, sort) values
  ('home_hero',   '홈 상단 고정',     '홈 히어로 아래 첫 카드 슬롯', 8000, 0.0200, 0),
  ('cat_top',     '분야 상단 노출',   '해당 분야 목록 최상단',       5000, 0.0150, 1),
  ('search_boost','검색 상위 노출',   '관련 검색결과 상단(AD 표기)', 6000, 0.0180, 2)
on conflict (id) do nothing;

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

-- ============================================================
-- 세모플 0005 — 소개 이행 + 동의 기록 + 탈퇴 대비 + 데이터 정정
-- (0001~0004 실행된 DB에 이어서 실행 · 멱등: 재실행 무해)
-- 목적:
--  1) 관리자 소개 큐에 양측 이메일 제공(관리자에게만 — is_admin 가드 뷰)
--  2) 소개 = 이메일 제3자 제공 → 신청 시 개별 동의를 기록할 컬럼
--  3) 소개 이행 시각·주체 기록(향후 '미이행 환불' 판정 근거)
--  4) 게시 우회 3개 경로(pitch·intro·note)에 연락처 패턴 서버 방어
--  5) 회원 탈퇴(profiles 삭제)가 FK에 막히지 않도록 on delete 정리
--  6) 라이브 데이터 정정(URL 2건 · '글로벌' 지역 18건)
-- ============================================================

-- ── 1) 동의·이행 컬럼 ────────────────────────────────────────
alter table public.partner_post_interests
  add column if not exists contact_consent_at timestamptz,
  add column if not exists introduced_at      timestamptz,
  add column if not exists introduced_by      uuid references public.profiles(id) on delete set null;
alter table public.deal_interests
  add column if not exists contact_consent_at timestamptz,
  add column if not exists introduced_at      timestamptz,
  add column if not exists introduced_by      uuid references public.profiles(id) on delete set null;

-- ── 2) 관리자 소개 큐 뷰 — 양측 이메일 포함, is_admin()만 행 반환 ──
-- (뷰는 소유자 권한으로 auth.users를 읽되, where is_admin()이 비관리자에겐 0행)
create or replace view public.v_admin_intro_queue
  with (security_invoker = false) as
select 'partner'::text     as kind,
       i.id, i.created_at, i.status,
       i.pitch             as message,
       i.platform_name,
       coalesce(pp.title, '') as target_title,
       au1.email           as applicant_email,
       au2.email           as counterpart_email,
       i.contact_consent_at
from public.partner_post_interests i
join public.partner_posts pp on pp.id = i.post_id
left join auth.users au1 on au1.id = i.user_id
left join auth.users au2 on au2.id = pp.created_by
where public.is_admin()
union all
select 'deal', i.id, i.created_at, i.status,
       i.intro, '', i.deal_id,
       au1.email, au2.email, i.contact_consent_at
from public.deal_interests i
join public.deals d on d.id = i.deal_id
left join auth.users au1 on au1.id = i.user_id
left join auth.users au2 on au2.id = d.owner_id
where public.is_admin();

-- ── 3) buyer_briefs 관리자 처리 정책(비활성 처리에 필요 — 0002엔 select만) ──
drop policy if exists "admin manage briefs" on public.buyer_briefs;
create policy "admin manage briefs" on public.buyer_briefs for update
  using (public.is_admin()) with check (public.is_admin());

-- ── 4) 연락처 패턴 서버 방어(검수를 안 거치는 3개 자유입력 경로) ──
-- NOT VALID: 기존 행은 건드리지 않고 신규 입력만 검사
alter table public.partner_post_interests drop constraint if exists chk_ppint_nocontact;
alter table public.partner_post_interests add constraint chk_ppint_nocontact
  check ( pitch !~* '(@|https?://|www\.|010[- ]?[0-9]{3,4}[- ]?[0-9]{4}|카카오톡|카톡|kakao|텔레그램|telegram)' ) not valid;
alter table public.deal_interests drop constraint if exists chk_dint_nocontact;
alter table public.deal_interests add constraint chk_dint_nocontact
  check ( intro !~* '(@|https?://|www\.|010[- ]?[0-9]{3,4}[- ]?[0-9]{4}|카카오톡|카톡|kakao|텔레그램|telegram)' ) not valid;
alter table public.buyer_briefs drop constraint if exists chk_brief_nocontact;
alter table public.buyer_briefs add constraint chk_brief_nocontact
  check ( note !~* '(@|https?://|www\.|010[- ]?[0-9]{3,4}[- ]?[0-9]{4}|카카오톡|카톡|kakao|텔레그램|telegram)' ) not valid;

-- ── 5) 회원 탈퇴 대비 FK 정리 ────────────────────────────────
-- profiles 행 삭제(= auth.users 삭제의 연쇄)가 막히지 않게:
-- 기록성 참조는 set null(익명 기록 보존), 개인 귀속 데이터는 cascade(함께 파기)
do $$ begin
  -- 기록 보존(set null)
  alter table public.platforms drop constraint if exists platforms_created_by_fkey;
  alter table public.platforms add constraint platforms_created_by_fkey
    foreign key (created_by) references public.profiles(id) on delete set null;
  alter table public.submissions drop constraint if exists submissions_submitter_id_fkey;
  alter table public.submissions add constraint submissions_submitter_id_fkey
    foreign key (submitter_id) references public.profiles(id) on delete set null;
  alter table public.submissions drop constraint if exists submissions_reviewed_by_fkey;
  alter table public.submissions add constraint submissions_reviewed_by_fkey
    foreign key (reviewed_by) references public.profiles(id) on delete set null;
  alter table public.lifecycle_transitions drop constraint if exists lifecycle_transitions_actor_id_fkey;
  alter table public.lifecycle_transitions add constraint lifecycle_transitions_actor_id_fkey
    foreign key (actor_id) references public.profiles(id) on delete set null;
  alter table public.deals drop constraint if exists deals_owner_id_fkey;
  alter table public.deals add constraint deals_owner_id_fkey
    foreign key (owner_id) references public.profiles(id) on delete set null;
  alter table public.operator_claims drop constraint if exists operator_claims_reviewed_by_fkey;
  alter table public.operator_claims add constraint operator_claims_reviewed_by_fkey
    foreign key (reviewed_by) references public.profiles(id) on delete set null;
  alter table public.partner_posts drop constraint if exists partner_posts_reviewed_by_fkey;
  alter table public.partner_posts add constraint partner_posts_reviewed_by_fkey
    foreign key (reviewed_by) references public.profiles(id) on delete set null;
  alter table public.deal_submissions drop constraint if exists deal_submissions_reviewed_by_fkey;
  alter table public.deal_submissions add constraint deal_submissions_reviewed_by_fkey
    foreign key (reviewed_by) references public.profiles(id) on delete set null;
  -- 개인 귀속(cascade — 탈퇴 시 함께 파기; 전부 미사용 P4/과금 테이블, 유료화 시 재검토)
  alter table public.operator_claims drop constraint if exists operator_claims_user_id_fkey;
  alter table public.operator_claims add constraint operator_claims_user_id_fkey
    foreign key (user_id) references public.profiles(id) on delete cascade;
  alter table public.platform_operators drop constraint if exists platform_operators_user_id_fkey;
  alter table public.platform_operators add constraint platform_operators_user_id_fkey
    foreign key (user_id) references public.profiles(id) on delete cascade;
  alter table public.proposals drop constraint if exists proposals_created_by_fkey;
  alter table public.proposals add constraint proposals_created_by_fkey
    foreign key (created_by) references public.profiles(id) on delete cascade;
  alter table public.boost_orders drop constraint if exists boost_orders_created_by_fkey;
  alter table public.boost_orders add constraint boost_orders_created_by_fkey
    foreign key (created_by) references public.profiles(id) on delete cascade;
  alter table public.charges drop constraint if exists charges_user_id_fkey;
  alter table public.charges add constraint charges_user_id_fkey
    foreign key (user_id) references public.profiles(id) on delete cascade;
end $$;

-- ── 6) 라이브 데이터 정정 ────────────────────────────────────
-- 잘못된 대표 URL 2건(본체 URL로 연결되던 서브서비스)
update public.platforms set url = 'https://livecreator.coupang.com/' where id = 'coupanglive';
update public.platforms set url = 'https://global.musinsa.com/'      where id = 'musinsa2';
-- 정적 데이터의 '글로벌' 표기 18건 — seed에서 domestic으로 잘못 매핑됨 → overseas로
update public.platforms set region = 'overseas' where id in (
  'shopify','cafe24','global','malltail','delivered','sellerhub','shopigate','sell3','reverb',
  'globalsellers','agoda','booking','hotelscombined','trivago','kr2','youtube','noom','stipop'
) and region = 'domestic';

-- ============================================================
-- 0006 — AI 도구 시드 (그룹 1 · 분야 10 · 도구 78) — 재실행 안전
-- ============================================================

insert into public.groups (id, name, icon, description, sort) values
  ('ai', 'AI 도구', '🧠', '일·콘텐츠·개발을 도와주는 전 세계 AI 도구', 5)
on conflict (id) do nothing;

insert into public.categories (id, group_id, name, icon, description, sort) values
  ('ai_chat', 'ai', '범용 AI 챗봇', '🤖', '글쓰기·조사·아이디어까지 두루 시키는 범용 어시스턴트', 35),
  ('ai_writing', 'ai', '글쓰기·문서 AI', '✍️', '카피·블로그·보고서·발표자료 작성을 돕는 도구', 36),
  ('ai_image', 'ai', '이미지·디자인 AI', '🎨', '이미지 생성·배경 제거·디자인 제작 도구', 37),
  ('ai_video', 'ai', '영상 AI', '🎬', '영상 생성·아바타·자막·편집 도구', 38),
  ('ai_audio', 'ai', '음성·음악 AI', '🎙️', 'AI 성우·더빙·음악 생성·오디오 보정', 39),
  ('ai_code', 'ai', '개발·코딩 AI', '💻', '코드 작성·앱 생성을 돕는 개발 도구', 40),
  ('ai_meeting', 'ai', '회의·기록 AI', '📝', '회의 녹음을 텍스트·요약으로 바꾸는 도구', 41),
  ('ai_marketing', 'ai', '마케팅·고객응대 AI', '📣', '광고 소재·SNS·SEO·AI 상담봇', 42),
  ('ai_auto', 'ai', '자동화·AI 에이전트', '⚙️', '반복 업무 연결·자동화와 AI 에이전트 구축', 43),
  ('ai_research', 'ai', '리서치·번역 AI', '🔍', '출처 기반 검색·논문 조사·번역 도구', 44)
on conflict (id) do nothing;

insert into public.platforms (id, name, category_id, region, url, blurb, is_new) values
  ('chatgpt', 'ChatGPT', 'ai_chat', 'overseas', 'https://chatgpt.com', 'OpenAI의 범용 AI 챗봇 — 글쓰기·분석·이미지 생성까지 가장 널리 쓰이는 기본기.', true),
  ('claude-ai', 'Claude', 'ai_chat', 'overseas', 'https://claude.ai', 'Anthropic의 AI 어시스턴트 — 긴 문서 이해와 꼼꼼한 글쓰기·코딩에 강점.', true),
  ('gemini', 'Gemini', 'ai_chat', 'overseas', 'https://gemini.google.com', '구글의 AI 챗봇 — 검색·지메일·유튜브 등 구글 서비스와 연동.', true),
  ('ms-copilot', 'Microsoft Copilot', 'ai_chat', 'overseas', 'https://copilot.microsoft.com', '윈도우·엣지·오피스에 내장되는 마이크로소프트의 AI 비서.', true),
  ('wrtn', '뤼튼', 'ai_chat', 'domestic', 'https://wrtn.ai', '국내 대표 AI 포털 — 챗봇·이미지·과제 도구를 한국어 중심으로 제공.', true),
  ('clova-x', 'CLOVA X', 'ai_chat', 'domestic', 'https://clova-x.naver.com', '네이버의 한국어 특화 AI 챗봇 — 국내 정보·쇼핑 맥락 이해.', true),
  ('grok', 'Grok', 'ai_chat', 'overseas', 'https://grok.com', 'xAI의 AI 챗봇 — X(트위터) 실시간 정보 반영이 특징.', true),
  ('lechat', 'Le Chat', 'ai_chat', 'overseas', 'https://chat.mistral.ai', '유럽 미스트랄의 챗봇 — 빠른 응답 속도와 넓은 무료 사용 폭.', true),
  ('notion-ai', 'Notion AI', 'ai_writing', 'overseas', 'https://www.notion.com/product/ai', '노션 문서 안에서 요약·초안·번역을 처리하는 업무용 글쓰기 AI.', true),
  ('gamma-app', 'Gamma', 'ai_writing', 'overseas', 'https://gamma.app', '프롬프트 한 줄로 발표자료·문서·웹페이지를 만들어 주는 생성 도구.', true),
  ('jasper', 'Jasper', 'ai_writing', 'overseas', 'https://www.jasper.ai', '브랜드 톤을 학습해 마케팅 카피·블로그를 쓰는 기업용 글쓰기 AI.', true),
  ('copy-ai', 'Copy.ai', 'ai_writing', 'overseas', 'https://www.copy.ai', '광고 카피·세일즈 문구 템플릿이 풍부한 카피라이팅 AI.', true),
  ('writesonic', 'Writesonic', 'ai_writing', 'overseas', 'https://writesonic.com', 'SEO 블로그·광고 문구를 빠르게 뽑는 콘텐츠 생성 AI.', true),
  ('grammarly', 'Grammarly', 'ai_writing', 'overseas', 'https://www.grammarly.com', '영문 문법·톤 교정 — 영어 이메일·문서 품질을 올려주는 도구.', true),
  ('deepl-write', 'DeepL Write', 'ai_writing', 'overseas', 'https://www.deepl.com/write', '영어·독일어 문장을 자연스럽게 다듬어 주는 교정 AI.', true),
  ('sudowrite', 'Sudowrite', 'ai_writing', 'overseas', 'https://www.sudowrite.com', '소설·창작 글쓰기에 특화된 스토리텔링 AI.', true),
  ('midjourney', 'Midjourney', 'ai_image', 'overseas', 'https://www.midjourney.com', '예술적 완성도로 유명한 이미지 생성 AI.', true),
  ('adobe-firefly', 'Adobe Firefly', 'ai_image', 'overseas', 'https://firefly.adobe.com', '상업 사용을 고려한 어도비의 이미지 생성 — 포토샵과 연동.', true),
  ('canva', 'Canva AI', 'ai_image', 'overseas', 'https://www.canva.com', '디자인 툴 캔바에 내장된 이미지 생성·매직 편집 기능.', true),
  ('ideogram', 'Ideogram', 'ai_image', 'overseas', 'https://ideogram.ai', '이미지 속 글자(타이포그래피) 표현에 강한 생성 AI.', true),
  ('leonardo-ai', 'Leonardo.Ai', 'ai_image', 'overseas', 'https://leonardo.ai', '게임·제품 컨셉 아트에 강한 이미지 생성 스튜디오.', true),
  ('stability-ai', 'Stable Diffusion', 'ai_image', 'overseas', 'https://stability.ai', '오픈소스 이미지 생성 모델 — 직접 설치·커스터마이즈 가능.', true),
  ('flux-bfl', 'FLUX', 'ai_image', 'overseas', 'https://bfl.ai', '고품질 오픈 가중치 이미지 생성 모델 FLUX 시리즈.', true),
  ('recraft', 'Recraft', 'ai_image', 'overseas', 'https://www.recraft.ai', '벡터·브랜드 스타일 유지에 강한 디자이너용 생성 AI.', true),
  ('remove-bg', 'remove.bg', 'ai_image', 'overseas', 'https://www.remove.bg', '사진 배경을 자동으로 지워 주는 원클릭 도구.', true),
  ('photoroom', 'PhotoRoom', 'ai_image', 'overseas', 'https://www.photoroom.com', '상품 사진 배경 제거·연출에 특화 — 쇼핑몰 상세컷 제작에 유용.', true),
  ('sora', 'Sora', 'ai_video', 'overseas', 'https://sora.com', 'OpenAI의 텍스트→영상 생성 서비스.', true),
  ('runway', 'Runway', 'ai_video', 'overseas', 'https://runwayml.com', '영상 생성·편집(제거·확장) 도구의 선두 주자.', true),
  ('kling', 'Kling AI', 'ai_video', 'overseas', 'https://klingai.com', '인물 동작 표현에 강한 고품질 영상 생성 AI.', true),
  ('pika', 'Pika', 'ai_video', 'overseas', 'https://pika.art', '짧은 밈·효과 영상 생성에 강한 도구.', true),
  ('luma', 'Luma Dream Machine', 'ai_video', 'overseas', 'https://lumalabs.ai', '사실적인 텍스트→영상 생성 모델.', true),
  ('heygen', 'HeyGen', 'ai_video', 'overseas', 'https://www.heygen.com', 'AI 아바타가 대본을 읽어 주는 영상 — 강의·홍보 영상 제작.', true),
  ('synthesia', 'Synthesia', 'ai_video', 'overseas', 'https://www.synthesia.io', '기업 교육용 AI 아바타 영상 제작 플랫폼.', true),
  ('descript', 'Descript', 'ai_video', 'overseas', 'https://www.descript.com', '문서를 고치듯 영상·팟캐스트를 편집하는 도구.', true),
  ('capcut', 'CapCut', 'ai_video', 'overseas', 'https://www.capcut.com', '자동 자막·템플릿으로 숏폼을 빠르게 만드는 편집 앱.', true),
  ('elevenlabs', 'ElevenLabs', 'ai_audio', 'overseas', 'https://elevenlabs.io', '자연스러운 AI 성우·더빙 — 다국어 보이스오버 제작.', true),
  ('suno', 'Suno', 'ai_audio', 'overseas', 'https://suno.com', '가사만 쓰면 노래를 만들어 주는 음악 생성 AI.', true),
  ('udio', 'Udio', 'ai_audio', 'overseas', 'https://www.udio.com', '장르·보컬 스타일을 지정하는 고음질 음악 생성 AI.', true),
  ('supertone', '수퍼톤', 'ai_audio', 'domestic', 'https://supertone.ai', '하이브 계열 음성 합성·변환 기술 — 콘텐츠용 보이스 제작.', true),
  ('murf', 'Murf AI', 'ai_audio', 'overseas', 'https://murf.ai', '비즈니스 나레이션용 AI 보이스 스튜디오.', true),
  ('adobe-podcast', 'Adobe Podcast', 'ai_audio', 'overseas', 'https://podcast.adobe.com', '녹음 잡음을 스튜디오 품질로 보정해 주는 도구.', true),
  ('github-copilot', 'GitHub Copilot', 'ai_code', 'overseas', 'https://github.com/features/copilot', 'IDE 안에서 코드를 제안하는 코드 자동완성의 표준.', true),
  ('cursor', 'Cursor', 'ai_code', 'overseas', 'https://cursor.com', 'AI 중심으로 설계된 코드 에디터 — 코드베이스와 대화하며 수정.', true),
  ('claude-code', 'Claude Code', 'ai_code', 'overseas', 'https://claude.com/claude-code', '터미널·IDE에서 작업을 통째로 맡기는 Anthropic의 코딩 에이전트.', true),
  ('windsurf', 'Windsurf', 'ai_code', 'overseas', 'https://windsurf.com', '멀티파일 작업을 자동화하는 에이전트형 AI IDE.', true),
  ('replit', 'Replit', 'ai_code', 'overseas', 'https://replit.com', '브라우저에서 앱을 만들고 배포까지 — AI 에이전트 내장.', true),
  ('v0', 'v0', 'ai_code', 'overseas', 'https://v0.dev', '프롬프트로 웹 UI(리액트)를 생성하는 Vercel의 도구.', true),
  ('lovable', 'Lovable', 'ai_code', 'overseas', 'https://lovable.dev', '대화만으로 웹 서비스를 만들어 주는 AI 앱 빌더.', true),
  ('bolt-new', 'Bolt.new', 'ai_code', 'overseas', 'https://bolt.new', '브라우저에서 풀스택 앱을 생성·실행하는 AI 빌더.', true),
  ('devin', 'Devin', 'ai_code', 'overseas', 'https://devin.ai', '이슈를 맡기면 스스로 코딩하는 AI 소프트웨어 엔지니어.', true),
  ('clova-note', '클로바노트', 'ai_meeting', 'domestic', 'https://clovanote.naver.com', '네이버의 회의 녹음→텍스트·요약 — 한국어 인식에 강점.', true),
  ('daglo', '다글로', 'ai_meeting', 'domestic', 'https://daglo.ai', '회의록·인터뷰 전사에 쓰는 국내 음성 기록 서비스.', true),
  ('otter', 'Otter.ai', 'ai_meeting', 'overseas', 'https://otter.ai', '영어 회의 실시간 전사·요약의 대표 서비스.', true),
  ('fireflies', 'Fireflies.ai', 'ai_meeting', 'overseas', 'https://fireflies.ai', '줌·미트 회의에 참여해 회의록을 자동 작성.', true),
  ('fathom', 'Fathom', 'ai_meeting', 'overseas', 'https://fathom.video', '무료 사용 폭이 넓은 회의 요약 — 하이라이트 클립 생성.', true),
  ('tldv', 'tl;dv', 'ai_meeting', 'overseas', 'https://tldv.io', '회의 녹화·타임스탬프 요약 — 여러 회의 도구 지원.', true),
  ('channeltalk', '채널톡', 'ai_marketing', 'domestic', 'https://channel.io', '국내 대표 채팅상담 — AI 상담봇으로 응대를 자동화.', true),
  ('intercom', 'Intercom Fin', 'ai_marketing', 'overseas', 'https://www.intercom.com', '고객 문의를 스스로 해결하는 AI 상담 에이전트.', true),
  ('zendesk-ai', 'Zendesk AI', 'ai_marketing', 'overseas', 'https://www.zendesk.com', '헬프데스크에 내장된 AI 응대·문의 분류.', true),
  ('tidio', 'Tidio', 'ai_marketing', 'overseas', 'https://www.tidio.com', '소규모 쇼핑몰용 챗봇·라이브챗 — 간단하게 도입.', true),
  ('adcreative', 'AdCreative.ai', 'ai_marketing', 'overseas', 'https://www.adcreative.ai', '광고 배너·소재를 대량 생성하는 퍼포먼스 마케팅 AI.', true),
  ('predis', 'Predis.ai', 'ai_marketing', 'overseas', 'https://predis.ai', 'SNS 게시물(이미지+카피)을 자동 생성·예약하는 도구.', true),
  ('surfer', 'Surfer', 'ai_marketing', 'overseas', 'https://surferseo.com', 'SEO 점수를 기준으로 글을 최적화하는 콘텐츠 도구.', true),
  ('zapier', 'Zapier', 'ai_auto', 'overseas', 'https://zapier.com', '수천 개 앱을 연결하는 업무 자동화 — AI 액션 내장.', true),
  ('make-com', 'Make', 'ai_auto', 'overseas', 'https://www.make.com', '시각적 시나리오로 짜는 자동화 — 복잡한 흐름에 강점.', true),
  ('n8n', 'n8n', 'ai_auto', 'overseas', 'https://n8n.io', '오픈소스 자동화 — AI 에이전트 워크플로 구축·자체 호스팅 가능.', true),
  ('lindy', 'Lindy', 'ai_auto', 'overseas', 'https://www.lindy.ai', '이메일·일정 등 업무를 맡기는 노코드 AI 비서 빌더.', true),
  ('relevance-ai', 'Relevance AI', 'ai_auto', 'overseas', 'https://relevanceai.com', '영업·리서치용 AI 에이전트 팀을 만드는 플랫폼.', true),
  ('manus', 'Manus', 'ai_auto', 'overseas', 'https://manus.im', '조사·작업을 자율 수행하는 범용 AI 에이전트.', true),
  ('dify', 'Dify', 'ai_auto', 'overseas', 'https://dify.ai', '오픈소스 LLM 앱·에이전트 빌더 — 사내 챗봇 구축에 활용.', true),
  ('perplexity', 'Perplexity', 'ai_research', 'overseas', 'https://www.perplexity.ai', '출처 링크와 함께 답하는 AI 검색 — 최신 정보 조사에 특화.', true),
  ('notebooklm', 'NotebookLM', 'ai_research', 'overseas', 'https://notebooklm.google.com', '내 자료를 올려 근거 기반으로 질문하는 구글의 리서치 도구.', true),
  ('liner', '라이너', 'ai_research', 'domestic', 'https://getliner.com', '출처 신뢰도를 강조하는 국내 AI 검색·하이라이트 서비스.', true),
  ('deepl', 'DeepL', 'ai_research', 'overseas', 'https://www.deepl.com', '자연스러운 번역 품질로 유명한 번역기.', true),
  ('papago', '파파고', 'ai_research', 'domestic', 'https://papago.naver.com', '네이버 번역 — 한국어 번역 쌍에 강점.', true),
  ('flitto-ai', '플리토', 'ai_research', 'domestic', 'https://www.flitto.com', '전문 번역과 AI 번역 데이터를 함께 다루는 번역 플랫폼.', true),
  ('elicit', 'Elicit', 'ai_research', 'overseas', 'https://elicit.com', '논문을 찾아 표로 정리해 주는 연구 특화 AI.', true),
  ('consensus', 'Consensus', 'ai_research', 'overseas', 'https://consensus.app', '논문 근거로 질문에 답하는 학술 검색 AI.', true)
on conflict (id) do nothing;

-- 기존 등재 도구를 AI 분야로 이동
update public.platforms set category_id = 'ai_video' where id = 'vrew';
update public.platforms set category_id = 'ai_audio' where id = 'typecast';

-- 0007 — 데이터 정정 (재실행 안전)
-- 올웨이즈: URL이 노트폴리오(notefolio.net)로 잘못 배정돼 있던 확정 오류 정정
update public.platforms set url = 'https://alwayz.co' where id = 'allways';

-- ============================================================
-- 세모플 0008 — RLS 하드닝 (0001~0007 실행된 DB에 이어서 실행 · 멱등)
-- 크리티컬 갭 감사(2026-07-04) P0-1: 검수 우회·상태 위조·폭주 차단.
-- 배경: 익명성·연락처 차단·자산 양수도 한정은 법적 전제인데, 아래 구멍으로
-- 로그인 계정 하나가 검수를 통째로 우회할 수 있었다.
--  (1) 0002 "insert own deal"이 0004에서 제거되지 않아 존속 — 매도자가
--      deals에 직접 insert(status='open')하면 검수·익명화 없이 v_deals_public에 즉시 게시
--  (2) partner_posts insert가 status를 고정하지 않음 — status='published' 직접 게시 가능
--  (3) interests insert가 status·introduced_at 미고정 — 소개 큐 누락·과금 근거 오염
--  (4) deals owner update가 컬럼 무제한 — 게시 후 익명 요약에 연락처 사후 주입 가능
--  (5) deals 텍스트에 연락처 check 부재(0005는 pitch·intro·note만)
--  (6) events가 anon 무제한·무검증 insert — 공개 키만으로 스토리지 고갈 공격 가능
--  (7) v_popular_searches가 definer 뷰라 anon이 검색어 로그 열람 가능
-- ============================================================

-- ── 1) deals: 직접 게시 경로 폐쇄 ────────────────────────────
-- 매도자 접수는 deal_submissions(검수·익명화 SOP) 경로만. 게시는 0004의 admin insert만 존속.
drop policy if exists "insert own deal" on public.deals;

-- ── 2) deals: update는 admin 전용 + 소유자는 '마감' 전이만 RPC로 ──
-- 소유자 자유 update를 없애 게시문(익명 요약) 사후 변조를 차단한다.
drop policy if exists "own or admin update deal" on public.deals;
drop policy if exists "admin update deal" on public.deals;
create policy "admin update deal" on public.deals for update
  using (public.is_admin()) with check (public.is_admin());

-- 소유자 셀프 마감(모집 철회)만 허용하는 좁은 통로 — 컬럼은 status만 바뀐다.
create or replace function public.close_my_deal(p_deal_id text)
returns void language sql security definer set search_path = public as $$
  update public.deals set status = 'closed'
  where id = p_deal_id and owner_id = auth.uid() and status in ('open', 'in_progress');
$$;
revoke execute on function public.close_my_deal(text) from public, anon;
grant execute on function public.close_my_deal(text) to authenticated;

-- ── 3) partner_posts: 접수는 반드시 pending으로 ──────────────
drop policy if exists "insert own ppost" on public.partner_posts;
create policy "insert own ppost" on public.partner_posts for insert
  with check (
    auth.uid() is not null and created_by = auth.uid()
    and status = 'pending' and published_at is null and reviewed_by is null and review_reason is null
  );

-- ── 4) interests: 신청은 반드시 pending·미소개 상태로 ────────
-- introduced_at은 '미이행 환불' 판정 근거(0005 §3) — 클라이언트가 위조하면 안 된다.
drop policy if exists "insert own ppost interest" on public.partner_post_interests;
create policy "insert own ppost interest" on public.partner_post_interests for insert
  with check (
    auth.uid() is not null and user_id = auth.uid()
    and status = 'pending' and introduced_at is null and introduced_by is null
  );
drop policy if exists "insert own interest" on public.deal_interests;
create policy "insert own interest" on public.deal_interests for insert
  with check (
    user_id = auth.uid()
    and status = 'pending' and introduced_at is null and introduced_by is null
  );

-- ── 5) deals 게시문 연락처 서버 방어(0005 §4와 동일 패턴 · NOT VALID) ──
alter table public.deals drop constraint if exists chk_deal_summary_nocontact;
alter table public.deals add constraint chk_deal_summary_nocontact
  check ( summary !~* '(@|https?://|www\.|010[- ]?[0-9]{3,4}[- ]?[0-9]{4}|카카오톡|카톡|kakao|텔레그램|telegram)' ) not valid;
alter table public.deals drop constraint if exists chk_deal_reason_nocontact;
alter table public.deals add constraint chk_deal_reason_nocontact
  check ( sale_reason is null or sale_reason !~* '(@|https?://|www\.|010[- ]?[0-9]{3,4}[- ]?[0-9]{4}|카카오톡|카톡|kakao|텔레그램|telegram)' ) not valid;
alter table public.deals drop constraint if exists chk_deal_highlights_nocontact;
alter table public.deals add constraint chk_deal_highlights_nocontact
  check ( array_to_string(highlights, ' ') !~* '(@|https?://|www\.|010[- ]?[0-9]{3,4}[- ]?[0-9]{4}|카카오톡|카톡|kakao|텔레그램|telegram)' ) not valid;

-- ── 6) 입력 길이 상한(폭주·저장 남용 방어 · NOT VALID) ───────
-- UI maxLength와 정합(여유분 포함): title 40→80, detail/give/get 200→2000, pitch/intro/note→1000
alter table public.partner_posts drop constraint if exists chk_ppost_len;
alter table public.partner_posts add constraint chk_ppost_len
  check ( char_length(title) <= 80 and char_length(detail) <= 2000
      and char_length(give_text) <= 2000 and char_length(get_text) <= 2000
      and char_length(size_text) <= 80 ) not valid;
alter table public.partner_post_interests drop constraint if exists chk_ppint_len;
alter table public.partner_post_interests add constraint chk_ppint_len
  check ( char_length(pitch) <= 1000 and char_length(platform_name) <= 80 and char_length(size_text) <= 80 ) not valid;
alter table public.deal_interests drop constraint if exists chk_dint_len;
alter table public.deal_interests add constraint chk_dint_len
  check ( char_length(intro) <= 1000 ) not valid;
alter table public.buyer_briefs drop constraint if exists chk_brief_len;
alter table public.buyer_briefs add constraint chk_brief_len
  check ( char_length(note) <= 1000 ) not valid;
alter table public.submissions drop constraint if exists chk_sub_payload_size;
alter table public.submissions add constraint chk_sub_payload_size
  check ( pg_column_size(payload) < 16384 ) not valid;
alter table public.deal_submissions drop constraint if exists chk_dealsub_payload_size;
alter table public.deal_submissions add constraint chk_dealsub_payload_size
  check ( pg_column_size(payload) < 16384 ) not valid;

-- ── 7) events: 공개 anon insert의 크기 상한 ──────────────────
alter table public.events drop constraint if exists chk_events_query_len;
alter table public.events add constraint chk_events_query_len
  check ( query is null or char_length(query) <= 80 ) not valid;
alter table public.events drop constraint if exists chk_events_session_len;
alter table public.events add constraint chk_events_session_len
  check ( session_id is null or char_length(session_id) <= 40 ) not valid;

-- ── 8) v_popular_searches: 검색어 로그는 admin만(행동 데이터 노출 차단) ──
-- definer 뷰가 events의 admin-only RLS를 우회하고 있었다. 사용처는 관리 콘솔뿐.
create or replace view public.v_popular_searches as
select query, count(*) as cnt
from public.events
where type = 'search' and query is not null and created_at > now() - interval '7 days'
  and public.is_admin()
group by query order by cnt desc limit 20;

-- ── 9) favorites: admin 읽기(백업 워크플로 전제 — 쓰기는 여전히 본인만) ──
drop policy if exists "admin read favorites" on public.favorites;
create policy "admin read favorites" on public.favorites for select
  using (user_id = auth.uid() or public.is_admin());

-- ============================================================
-- 세모플 0009 — 계정 자기결정권 + 접수 상한 + 연락처 패턴 확장
-- (0001~0008 실행된 DB에 이어서 실행 · 멱등)
-- 크리티컬 갭 감사 P1: ① 셀프서비스 탈퇴(가입은 폼 1개인데 철회는 이메일이던 비대칭 해소)
-- ② 접수·신청 셀프 취소/마감(정정·처리정지권의 인앱 이행) ③ 사용자당 pending 상한(큐 폭주 방어)
-- ④ 연락처 차단 패턴 확장(일반 국번·한글 풀어쓰기·인스타·디스코드 등) — 클라이언트 anonymity.ts와 동시 갱신
-- ============================================================

-- ── 1) 셀프서비스 회원 탈퇴 ──────────────────────────────────
-- profiles가 auth.users on delete cascade(0001)이고 나머지 FK는 0005 §5가 정리 완료:
-- 개인 귀속 데이터는 함께 파기(cascade), 기록성 참조는 익명화(set null).
create or replace function public.delete_my_account()
returns void language sql security definer set search_path = public as $$
  delete from auth.users where id = auth.uid();
$$;
revoke execute on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;

-- ── 2) 접수·신청 셀프 취소(pending일 때만) ───────────────────
drop policy if exists "cancel own submission" on public.submissions;
create policy "cancel own submission" on public.submissions for delete
  using (submitter_id = auth.uid() and status = 'pending');
drop policy if exists "cancel own deal submission" on public.deal_submissions;
create policy "cancel own deal submission" on public.deal_submissions for delete
  using (submitter_id = auth.uid() and status = 'pending');
drop policy if exists "withdraw own ppost interest" on public.partner_post_interests;
create policy "withdraw own ppost interest" on public.partner_post_interests for delete
  using (user_id = auth.uid() and status = 'pending');
drop policy if exists "withdraw own deal interest" on public.deal_interests;
create policy "withdraw own deal interest" on public.deal_interests for delete
  using (user_id = auth.uid() and status = 'pending');

-- 제휴 제안 소유자 마감(검수 대기 철회 또는 게시 종료) — status 전이만 허용하는 좁은 RPC
create or replace function public.close_my_post(p_post_id uuid)
returns void language sql security definer set search_path = public as $$
  update public.partner_posts set status = 'closed'
  where id = p_post_id and created_by = auth.uid() and status in ('pending', 'published');
$$;
revoke execute on function public.close_my_post(uuid) from public, anon;
grant execute on function public.close_my_post(uuid) to authenticated;

-- ── 3) 사용자당 pending 상한(1인 검수 큐 폭주 방어) ──────────
-- RLS 정책 안에서 본인 행을 세기 위한 security definer 카운터(정책 재귀 없이 안전).
create or replace function public.my_pending_count(p_table text)
returns integer language plpgsql stable security definer set search_path = public as $$
declare n integer;
begin
  if p_table = 'submissions' then
    select count(*) into n from public.submissions where submitter_id = auth.uid() and status = 'pending';
  elsif p_table = 'partner_posts' then
    select count(*) into n from public.partner_posts where created_by = auth.uid() and status = 'pending';
  elsif p_table = 'deal_submissions' then
    select count(*) into n from public.deal_submissions where submitter_id = auth.uid() and status = 'pending';
  elsif p_table = 'buyer_briefs' then
    select count(*) into n from public.buyer_briefs where user_id = auth.uid() and active;
  else
    raise exception 'my_pending_count: unknown table %', p_table;
  end if;
  return n;
end $$;
revoke execute on function public.my_pending_count(text) from public, anon;
grant execute on function public.my_pending_count(text) to authenticated;

-- insert 정책에 상한 결합(0008 조건 유지 + cap)
drop policy if exists "insert own submission" on public.submissions;
create policy "insert own submission" on public.submissions for insert
  with check (auth.uid() is not null and submitter_id = auth.uid()
    and public.my_pending_count('submissions') < 10);
drop policy if exists "insert own ppost" on public.partner_posts;
create policy "insert own ppost" on public.partner_posts for insert
  with check (
    auth.uid() is not null and created_by = auth.uid()
    and status = 'pending' and published_at is null and reviewed_by is null and review_reason is null
    and public.my_pending_count('partner_posts') < 3
  );
drop policy if exists "insert own deal submission" on public.deal_submissions;
create policy "insert own deal submission" on public.deal_submissions for insert
  with check (auth.uid() is not null and submitter_id = auth.uid()
    and public.my_pending_count('deal_submissions') < 3);
-- buyer_briefs: for all 단일 정책을 분해해 insert에만 상한(활성 3건) 적용
drop policy if exists "own briefs" on public.buyer_briefs;
drop policy if exists "own briefs read" on public.buyer_briefs;
create policy "own briefs read" on public.buyer_briefs for select using (user_id = auth.uid());
drop policy if exists "own briefs insert" on public.buyer_briefs;
create policy "own briefs insert" on public.buyer_briefs for insert
  with check (user_id = auth.uid() and public.my_pending_count('buyer_briefs') < 3);
drop policy if exists "own briefs update" on public.buyer_briefs;
create policy "own briefs update" on public.buyer_briefs for update
  using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "own briefs delete" on public.buyer_briefs;
create policy "own briefs delete" on public.buyer_briefs for delete using (user_id = auth.uid());

-- ── 4) 연락처 차단 패턴 확장(클라이언트 lib/anonymity.ts CONTACT_RE와 동일 기준 유지) ──
-- 추가: 일반 국번 전화(070·02·031 등), 공일공(한글 풀어쓰기), 인스타/디스코드/라인/위챗, 지메일.
-- \y = 단어 경계(insta가 instant에 오탐되지 않게). NOT VALID: 기존 행 무영향.
alter table public.partner_post_interests drop constraint if exists chk_ppint_nocontact;
alter table public.partner_post_interests add constraint chk_ppint_nocontact
  check ( pitch !~* '(@|https?://|www\.|0\d{1,2}[-. ]?\d{3,4}[-. ]?\d{4}|공일공|카카오톡|카톡|kakao|텔레그램|텔레그람|telegram|인스타|\yinsta(gram)?\y|디스코드|discord|(^|[^가-힣])라인\s?아이디|\yline[ -]?id\y|위챗|wechat|지메일)' ) not valid;
alter table public.deal_interests drop constraint if exists chk_dint_nocontact;
alter table public.deal_interests add constraint chk_dint_nocontact
  check ( intro !~* '(@|https?://|www\.|0\d{1,2}[-. ]?\d{3,4}[-. ]?\d{4}|공일공|카카오톡|카톡|kakao|텔레그램|텔레그람|telegram|인스타|\yinsta(gram)?\y|디스코드|discord|(^|[^가-힣])라인\s?아이디|\yline[ -]?id\y|위챗|wechat|지메일)' ) not valid;
alter table public.buyer_briefs drop constraint if exists chk_brief_nocontact;
alter table public.buyer_briefs add constraint chk_brief_nocontact
  check ( note !~* '(@|https?://|www\.|0\d{1,2}[-. ]?\d{3,4}[-. ]?\d{4}|공일공|카카오톡|카톡|kakao|텔레그램|텔레그람|telegram|인스타|\yinsta(gram)?\y|디스코드|discord|(^|[^가-힣])라인\s?아이디|\yline[ -]?id\y|위챗|wechat|지메일)' ) not valid;
alter table public.deals drop constraint if exists chk_deal_summary_nocontact;
alter table public.deals add constraint chk_deal_summary_nocontact
  check ( summary !~* '(@|https?://|www\.|0\d{1,2}[-. ]?\d{3,4}[-. ]?\d{4}|공일공|카카오톡|카톡|kakao|텔레그램|텔레그람|telegram|인스타|\yinsta(gram)?\y|디스코드|discord|(^|[^가-힣])라인\s?아이디|\yline[ -]?id\y|위챗|wechat|지메일)' ) not valid;
alter table public.deals drop constraint if exists chk_deal_reason_nocontact;
alter table public.deals add constraint chk_deal_reason_nocontact
  check ( sale_reason is null or sale_reason !~* '(@|https?://|www\.|0\d{1,2}[-. ]?\d{3,4}[-. ]?\d{4}|공일공|카카오톡|카톡|kakao|텔레그램|텔레그람|telegram|인스타|\yinsta(gram)?\y|디스코드|discord|(^|[^가-힣])라인\s?아이디|\yline[ -]?id\y|위챗|wechat|지메일)' ) not valid;
alter table public.deals drop constraint if exists chk_deal_highlights_nocontact;
alter table public.deals add constraint chk_deal_highlights_nocontact
  check ( array_to_string(highlights, ' ') !~* '(@|https?://|www\.|0\d{1,2}[-. ]?\d{3,4}[-. ]?\d{4}|공일공|카카오톡|카톡|kakao|텔레그램|텔레그람|telegram|인스타|\yinsta(gram)?\y|디스코드|discord|(^|[^가-힣])라인\s?아이디|\yline[ -]?id\y|위챗|wechat|지메일)' ) not valid;

-- ============================================================
-- 세모플 0010 — 운영 통지·정리 (0001~0009 실행된 DB에 이어서 실행 · 멱등)
-- 크리티컬 갭 감사 P2: ① 검수 결과 통지 채널(관리자가 반려·게시 안내 메일을 보낼 수단이 없었음)
-- ② events 보존 정리(0008 상한은 폭주만 막고 정상 트래픽의 단조 증가는 남음)
-- ============================================================

-- ── 1) 검수 통지용 접수자 이메일 뷰 — is_admin()만 행 반환(0005 v_admin_intro_queue 패턴) ──
-- 검수 큐에는 이메일이 없어 반려해도 알릴 수 없었다. 관리 콘솔의 '메일 안내' 버튼이 이 뷰를 읽는다.
create or replace view public.v_admin_contact
  with (security_invoker = false) as
select 'submission'::text as kind, s.id::text as ref, au.email, s.status::text as status
from public.submissions s left join auth.users au on au.id = s.submitter_id
where public.is_admin()
union all
select 'partner_post', pp.id::text, au.email, pp.status::text
from public.partner_posts pp left join auth.users au on au.id = pp.created_by
where public.is_admin()
union all
select 'deal_submission', d.id::text, au.email, d.status::text
from public.deal_submissions d left join auth.users au on au.id = d.submitter_id
where public.is_admin()
union all
select 'operator_claim', oc.id::text, au.email, oc.status::text
from public.operator_claims oc left join auth.users au on au.id = oc.user_id
where public.is_admin();

-- ── 2) events 보존 정리 — 90일 초과 익명 이벤트 삭제(관리자·봇만 호출) ──
create or replace function public.purge_old_events(p_days integer default 90)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if not public.is_admin() then raise exception '관리자 전용'; end if;
  -- 최소 30일 보장(실수로 0을 넘겨도 최근 데이터가 지워지지 않게)
  delete from public.events where created_at < now() - make_interval(days => greatest(p_days, 30));
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function public.purge_old_events(integer) from public, anon;
grant execute on function public.purge_old_events(integer) to authenticated;

-- ============================================================
-- 세모플 0011 — 제휴 수익화 실행 준비 (0001~0010 실행된 DB에 이어서 실행 · 멱등)
-- 3상품(스폰서 슬롯·연결료 A/B/C·Pro 멤버십)의 주문→무통장 입금 확인→활성화→환불
-- 생명주기를 "켜기 직전"까지 완성한다. 스위치는 이중(app_settings 'billing' + FLAGS.billing)이며
-- 기본 전부 꺼짐 — 프론트를 우회해 REST로 호출해도 place_order 첫 줄에서 거부된다.
--
-- ⚠️ 유료화 스위치를 켜기 전 필수 체크리스트(하나라도 미완이면 켜지 말 것):
--   ① 통신판매업 신고  ② pricing-policy.md §6-2 무통장 한시 허용 단서 개정
--   ③ 처리방침 §1 증빙 발행 정보 추가 + TERMS_VERSION 상향  ④ 30일 공지(app_settings 'pricing_announced_at' 설정)
--
-- 구현 노트: 신규 enum 값('awaiting_deposit','pending_payment')은 같은 트랜잭션에서
-- enum 리터럴로 쓸 수 없으므로(Supabase Editor 단일 트랜잭션) 뷰에서는 ::text 비교,
-- 함수는 전부 plpgsql(본문은 실행 시점 평가)로 작성한다. 인덱스 술어는 기존 값만 사용.
-- ============================================================

-- ── 1) 상태 enum 확장 ────────────────────────────────────────
alter type public.charge_status_t add value if not exists 'awaiting_deposit';
alter type public.sub_status_t    add value if not exists 'pending_payment';

-- ── 2) charges 확장(0001 테이블 재사용 — 무통장·환불·할인·증빙) ──
alter table public.charges
  add column if not exists interest_kind    text check (interest_kind in ('partner','deal')),
  add column if not exists interest_id      uuid,             -- 다형 참조(존재 검증은 admin_introduce가 수행)
  add column if not exists fee_tier         text check (fee_tier in ('A','B','C')),  -- 소개 시점 스냅샷(가격 개정 분쟁 방지)
  add column if not exists depositor_name   text,
  add column if not exists deposit_deadline date,
  add column if not exists confirmed_by     uuid references public.profiles(id) on delete set null,
  add column if not exists discount_rate    numeric check (discount_rate >= 0 and discount_rate <= 1),
  add column if not exists discount_reason  text,             -- 'founder' 등
  add column if not exists refund_amount    int check (refund_amount >= 0),
  add column if not exists refunded_at      timestamptz,
  add column if not exists refund_reason    text,
  add column if not exists cash_receipt_no  text,
  add column if not exists updated_at       timestamptz not null default now();
do $$ begin
  create trigger touch_charges before update on public.charges
    for each row execute function public.tg_touch_updated_at();
exception when duplicate_object then null; end $$;
-- 이중 과금 방지: 같은 소개 건에 살아있는 연결료 청구는 1건만
create unique index if not exists uq_charges_connection on public.charges(interest_id)
  where kind = 'connection_fee' and status not in ('canceled', 'refunded');

-- ── 3) subscriptions 확장 + 중복 활성 구독 방지 ──────────────
alter table public.subscriptions
  add column if not exists current_period_start timestamptz,
  add column if not exists current_period_end   timestamptz,
  add column if not exists price_snapshot       int,
  add column if not exists activated_at         timestamptz;
create unique index if not exists uq_subs_active on public.subscriptions(user_id)
  where status in ('active', 'past_due');

-- ── 4) credit_ledger 확장(Pro 포함분 버킷·만료) + 이중 차감 방지 ──
alter table public.credit_ledger
  add column if not exists bucket     text not null default 'paid' check (bucket in ('paid','bonus','plan_included')),
  add column if not exists expires_at timestamptz;
create unique index if not exists uq_credit_connection on public.credit_ledger(ref_id, reason)
  where reason = 'connection_fee';

-- ── 5) 제휴 유형 → 요금 등급(A 무료/B 22,000/C 77,000 · VAT 포함가) 확정 매핑 ──
alter table public.partner_types
  add column if not exists fee_tier text not null default 'A' check (fee_tier in ('A','B','C'));
update public.partner_types set fee_tier = 'B' where id in
  ('referral_fee','cross_signup','cross_onboarding','affiliate_listing','lead_exchange');
update public.partner_types set fee_tier = 'C' where id in
  ('api_embed','data_partnership','infra_deal','group_alliance');
update public.partner_types set fee_tier = 'A' where id not in
  ('referral_fee','cross_signup','cross_onboarding','affiliate_listing','lead_exchange',
   'api_embed','data_partnership','infra_deal','group_alliance');

-- ── 6) 플로우 컬럼: 제안자 동의·확인(B/C형 과금·환불 판정의 기준 시각) ──
alter table public.partner_posts          add column if not exists contact_consent_at timestamptz;
alter table public.partner_post_interests add column if not exists owner_confirmed_at timestamptz,
                                          add column if not exists introduced_evidence text;
alter table public.deal_interests         add column if not exists owner_confirmed_at timestamptz,
                                          add column if not exists introduced_evidence text;

-- ── 7) plans 시드 정정 — 규약: monthly_price = VAT "포함" 표시가 ──
comment on column public.plans.monthly_price is
  'VAT 포함 표시가(원). charges 기록 시 공급가=round(총액/1.1), 부가세=총액-공급가로 역산한다.';
update public.plans set monthly_price = 66000  where id = 'pro'     and monthly_price <> 66000;
update public.plans set monthly_price = 220000 where id = 'premium' and monthly_price <> 220000;

-- ── 8) 디렉토리 지면 광고 봉인(불변 원칙: 검색·비교·순위 비판매 — 유료 노출은 보드 한정) ──
update public.boost_tiers set active = false where id in ('home_hero','cat_top','search_boost');

-- ── 9) app_settings — 서버측 과금 스위치 + 30일 공지 기산점의 단일 소스 ──
create table if not exists public.app_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.app_settings enable row level security;
drop policy if exists "public read settings" on public.app_settings;
create policy "public read settings" on public.app_settings for select using (true);
drop policy if exists "admin write settings" on public.app_settings;
create policy "admin write settings" on public.app_settings for all
  using (public.is_admin()) with check (public.is_admin());
insert into public.app_settings (key, value) values
  ('billing', '{"sponsor": false, "connection": false, "membership": false, "bank": "", "deposit_deadline_days": 7}'),
  ('pricing_announced_at', 'null')
on conflict (key) do nothing;

-- ── 10) sponsor_slots — 보드 상단 2슬롯(소재 = 검수 통과한 자기 제안) ──
create extension if not exists btree_gist;
create table if not exists public.sponsor_slots (
  id              uuid primary key default gen_random_uuid(),
  slot_no         int not null check (slot_no in (1, 2)),
  partner_post_id uuid not null references public.partner_posts(id) on delete cascade,
  sponsor_user_id uuid not null references public.profiles(id) on delete cascade,
  starts_on       date not null,
  ends_on         date not null check (ends_on >= starts_on),
  charge_id       uuid references public.charges(id) on delete set null,
  created_at      timestamptz not null default now()
);
do $$ begin
  alter table public.sponsor_slots add constraint excl_sponsor_slot_overlap
    exclude using gist (slot_no with =, daterange(starts_on, ends_on, '[]') with &&);
exception when duplicate_object or duplicate_table then null; end $$;
alter table public.sponsor_slots enable row level security;
drop policy if exists "own or admin read slot" on public.sponsor_slots;
create policy "own or admin read slot" on public.sponsor_slots for select
  using (sponsor_user_id = auth.uid() or public.is_admin());
drop policy if exists "admin manage slots" on public.sponsor_slots;
create policy "admin manage slots" on public.sponsor_slots for all
  using (public.is_admin()) with check (public.is_admin());
-- 공개 뷰: 오늘 활성 슬롯의 익명 필드만(작성자 식별자 금지 — v_partner_posts_public 패턴)
create or replace view public.v_sponsor_slots_public
  with (security_invoker = false) as
select s.slot_no, p.id, p.title, p.category_id, p.type_id, p.give_text, p.get_text,
       p.want_categories, p.size_text, p.detail
from public.sponsor_slots s
join public.partner_posts p on p.id = s.partner_post_id
where current_date between s.starts_on and s.ends_on
  and p.status in ('published', 'matched');

-- ── 11) 공개 보드 뷰에 Pro 인증 배지(익명성 유지 — boolean만 노출) ──
create or replace view public.v_partner_posts_public
  with (security_invoker = false) as
select pp.id, pp.title, pp.category_id, pp.type_id, pp.give_text, pp.get_text,
       pp.want_categories, pp.size_text, pp.detail, pp.status, pp.published_at::date as posted,
       exists (select 1 from public.subscriptions sb
               where sb.user_id = pp.created_by and sb.plan_id = 'pro'
                 and sb.status::text = 'active') as pro_verified
from public.partner_posts pp where pp.status in ('published', 'matched');

-- ── 12) 제안자 수신함 — 내 제안에 달린 신청(익명 필드만, 이메일·user_id 제외) ──
create or replace view public.v_my_post_interests
  with (security_invoker = false) as
select i.id, i.post_id, pp.title as post_title, i.platform_name, i.size_text, i.pitch,
       i.status, i.owner_confirmed_at, i.created_at
from public.partner_post_interests i
join public.partner_posts pp on pp.id = i.post_id
where pp.created_by = auth.uid();

-- ── 13) 소개 큐 뷰 재정의 — 상태 필터 + 제안자 확인 컬럼(0005 컬럼 순서 유지, 말미 추가) ──
create or replace view public.v_admin_intro_queue
  with (security_invoker = false) as
select 'partner'::text as kind, i.id, i.created_at, i.status,
       i.pitch as message, i.platform_name,
       coalesce(pp.title, '') as target_title,
       au1.email as applicant_email, au2.email as counterpart_email,
       i.contact_consent_at, i.owner_confirmed_at
from public.partner_post_interests i
join public.partner_posts pp on pp.id = i.post_id
left join auth.users au1 on au1.id = i.user_id
left join auth.users au2 on au2.id = pp.created_by
where public.is_admin() and pp.status in ('published', 'matched')
union all
select 'deal', i.id, i.created_at, i.status, i.intro, '', i.deal_id,
       au1.email, au2.email, i.contact_consent_at, i.owner_confirmed_at
from public.deal_interests i
join public.deals d on d.id = i.deal_id
left join auth.users au1 on au1.id = i.user_id
left join auth.users au2 on au2.id = d.owner_id
where public.is_admin() and d.status <> 'closed';

-- ── 14) 과금 운영 뷰(관리자) — ::text 비교(신규 enum 값의 동일 트랜잭션 안전성) ──
create or replace view public.v_admin_billing_queue
  with (security_invoker = false) as
select c.id, c.kind::text as kind, c.amount, c.vat, c.memo, c.depositor_name, c.deposit_deadline,
       c.fee_tier, c.created_at, au.email as user_email
from public.charges c left join auth.users au on au.id = c.user_id
where public.is_admin() and c.status::text = 'awaiting_deposit';
create or replace view public.v_admin_refund_due
  with (security_invoker = false) as
select c.id, c.amount, c.vat, c.interest_kind, c.interest_id, c.paid_at, au.email as user_email
from public.charges c left join auth.users au on au.id = c.user_id
where public.is_admin() and c.kind = 'connection_fee' and c.status = 'paid'
  and ((c.interest_kind = 'partner' and exists
         (select 1 from public.partner_post_interests i where i.id = c.interest_id and i.introduced_at is null))
    or (c.interest_kind = 'deal' and exists
         (select 1 from public.deal_interests i where i.id = c.interest_id and i.introduced_at is null)));

-- ── 15) 파운더 사전 등록(알림 채널 — 할인 "자격"은 활동 이력으로 판정) ──
alter table public.profiles add column if not exists founder_optin_at timestamptz;

-- ── 16) RPC들 (전부 plpgsql security definer + is_admin/소유자 가드) ──

/* 주문 생성 — 서버가 스위치·금액을 판정(프론트 우회 봉인·금액 위조 방지) */
create or replace function public.place_order(p_kind text, p_plan_id text default null, p_post_id uuid default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare bill jsonb; total int; v_amount int; v_vat int; cid uuid; deadline_days int;
begin
  if auth.uid() is null then raise exception '로그인이 필요합니다'; end if;
  select value into bill from public.app_settings where key = 'billing';
  deadline_days := coalesce((bill->>'deposit_deadline_days')::int, 7);
  if p_kind = 'boost' then
    if not coalesce((bill->>'sponsor')::boolean, false) then raise exception '스폰서 상품은 아직 오픈 전입니다'; end if;
    if not exists (select 1 from public.partner_posts
                   where id = p_post_id and created_by = auth.uid() and status = 'published')
      then raise exception '게시 중인 본인 제안에만 신청할 수 있어요'; end if;
    total := 99000;
  elsif p_kind = 'subscription' then
    if not coalesce((bill->>'membership')::boolean, false) then raise exception '멤버십은 아직 오픈 전입니다'; end if;
    if p_plan_id is distinct from 'pro' then raise exception '신청 가능한 플랜이 아닙니다'; end if;
    if exists (select 1 from public.subscriptions where user_id = auth.uid() and status in ('active','past_due'))
      then raise exception '이미 활성 구독이 있습니다'; end if;
    select monthly_price into total from public.plans where id = p_plan_id;
  else
    raise exception '알 수 없는 상품: %', p_kind;
  end if;
  v_amount := round(total / 1.1)::int;  -- VAT 포함가 → 공급가 역산
  v_vat := total - v_amount;
  insert into public.charges (kind, user_id, amount, vat, status, deposit_deadline, memo)
  values (p_kind::charge_kind_t, auth.uid(), v_amount, v_vat, 'awaiting_deposit',
          current_date + deadline_days,
          case when p_kind = 'boost' then 'post:' || p_post_id else 'plan:' || p_plan_id end)
  returning id into cid;
  return cid;
end $$;
revoke execute on function public.place_order(text, text, uuid) from public, anon;
grant execute on function public.place_order(text, text, uuid) to authenticated;

/* 입금 확인 — awaiting_deposit→paid, 구독이면 활성화 + 포함 크레딧 적립 */
create or replace function public.admin_confirm_deposit(p_charge_id uuid, p_depositor text)
returns void language plpgsql security definer set search_path = public as $$
declare c record; period_end timestamptz;
begin
  if not public.is_admin() then raise exception '관리자 전용'; end if;
  select * into c from public.charges where id = p_charge_id;
  if c is null then raise exception '청구를 찾을 수 없습니다'; end if;
  if c.status::text <> 'awaiting_deposit' then raise exception '입금 대기 상태가 아닙니다(%)', c.status; end if;
  update public.charges set status = 'paid', paid_at = now(),
    depositor_name = p_depositor, confirmed_by = auth.uid() where id = p_charge_id;
  if c.kind = 'subscription' then
    period_end := now() + interval '1 month';
    insert into public.subscriptions (user_id, plan_id, status, current_period_start, current_period_end, price_snapshot, activated_at)
    values (c.user_id, 'pro', 'active', now(), period_end, c.amount + c.vat, now());
    -- B형 3건 포함분(66,000) — 주기말 소멸 버킷
    insert into public.credit_ledger (user_id, delta, reason, ref_id, bucket, expires_at)
    values (c.user_id, 66000, 'free_monthly', p_charge_id, 'plan_included', period_end);
  end if;
end $$;
revoke execute on function public.admin_confirm_deposit(uuid, text) from public, anon;
grant execute on function public.admin_confirm_deposit(uuid, text) to authenticated;

/* 환불 — paid→refunded만, 금액 상한 검증 */
create or replace function public.admin_refund_charge(p_charge_id uuid, p_amount int, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare c record;
begin
  if not public.is_admin() then raise exception '관리자 전용'; end if;
  select * into c from public.charges where id = p_charge_id;
  if c is null or c.status <> 'paid' then raise exception 'paid 상태의 청구만 환불할 수 있습니다'; end if;
  if p_amount < 0 or p_amount > c.amount + c.vat then raise exception '환불 금액이 결제액을 초과합니다'; end if;
  update public.charges set status = 'refunded', refund_amount = p_amount,
    refunded_at = now(), refund_reason = p_reason where id = p_charge_id;
end $$;
revoke execute on function public.admin_refund_charge(uuid, int, text) from public, anon;
grant execute on function public.admin_refund_charge(uuid, int, text) to authenticated;

/* 제안자 셀프 응답 — 수락(소개 진행 동의) / 거절 */
create or replace function public.respond_to_interest(p_interest_id uuid, p_accept boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.partner_post_interests i
                 join public.partner_posts pp on pp.id = i.post_id
                 where i.id = p_interest_id and pp.created_by = auth.uid())
    then raise exception '내 제안에 달린 신청이 아닙니다'; end if;
  if p_accept then
    update public.partner_post_interests set owner_confirmed_at = now()
    where id = p_interest_id and status = 'pending';
  else
    update public.partner_post_interests set status = 'declined'
    where id = p_interest_id and status = 'pending';
  end if;
end $$;
revoke execute on function public.respond_to_interest(uuid, boolean) from public, anon;
grant execute on function public.respond_to_interest(uuid, boolean) to authenticated;

/* 소개 실행의 단일 지점 — 상태·동의 검증, 이중 실행 방지, 증빙·요금 스냅샷,
 * (connection 스위치 on일 때만) 과금: Pro 포함 크레딧 우선 차감, 아니면 청구 생성 */
create or replace function public.admin_introduce(p_kind text, p_interest_id uuid, p_evidence text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare tier text; bill jsonb; charging boolean; total int; v_amount int; v_vat int;
        v_user uuid; bal int; used_credit boolean := false; cid uuid;
begin
  if not public.is_admin() then raise exception '관리자 전용'; end if;
  if coalesce(trim(p_evidence), '') = '' then raise exception '발송 증빙(메모)이 필요합니다'; end if;
  select value into bill from public.app_settings where key = 'billing';
  charging := coalesce((bill->>'connection')::boolean, false);

  if p_kind = 'partner' then
    perform 1 from public.partner_post_interests i
      join public.partner_posts pp on pp.id = i.post_id
      where i.id = p_interest_id and pp.status in ('published', 'matched');
    if not found then raise exception '대상 제안이 게시 상태가 아닙니다'; end if;
    perform 1 from public.partner_post_interests
      where id = p_interest_id and contact_consent_at is not null and owner_confirmed_at is not null;
    if not found then raise exception '양측 동의(신청자 동의 + 제안자 확인)가 완료되지 않았습니다'; end if;
    perform 1 from public.partner_post_interests where id = p_interest_id and introduced_at is null;
    if not found then raise exception '이미 소개가 실행된 건입니다'; end if;
    select pt.fee_tier, i.user_id into tier, v_user
      from public.partner_post_interests i
      join public.partner_posts pp on pp.id = i.post_id
      join public.partner_types pt on pt.id = pp.type_id
      where i.id = p_interest_id;
    update public.partner_post_interests
      set status = 'introduced', introduced_at = now(), introduced_by = auth.uid(), introduced_evidence = p_evidence
      where id = p_interest_id;
    if charging and tier <> 'A' then
      total := case tier when 'B' then 22000 else 77000 end;
      if tier = 'B' then
        select coalesce(sum(delta), 0) into bal from public.credit_ledger
          where user_id = v_user and bucket = 'plan_included' and (expires_at is null or expires_at > now());
        if bal >= total then
          insert into public.credit_ledger (user_id, delta, reason, ref_id, bucket)
          values (v_user, -total, 'connection_fee', p_interest_id, 'plan_included');
          used_credit := true;
        end if;
      end if;
      if not used_credit then
        v_amount := round(total / 1.1)::int; v_vat := total - v_amount;
        insert into public.charges (kind, user_id, interest_kind, interest_id, fee_tier, amount, vat, status, deposit_deadline)
        values ('connection_fee', v_user, 'partner', p_interest_id, tier, v_amount, v_vat, 'awaiting_deposit',
                current_date + coalesce((bill->>'deposit_deadline_days')::int, 7))
        returning id into cid;
      end if;
    end if;
    return jsonb_build_object('fee_tier', tier, 'charged', cid is not null, 'credit_used', used_credit);

  elsif p_kind = 'deal' then
    perform 1 from public.deal_interests i join public.deals d on d.id = i.deal_id
      where i.id = p_interest_id and d.status <> 'closed';
    if not found then raise exception '대상 매물이 게시 상태가 아닙니다'; end if;
    perform 1 from public.deal_interests
      where id = p_interest_id and contact_consent_at is not null and owner_confirmed_at is not null and introduced_at is null;
    if not found then raise exception '동의·확인 미완이거나 이미 소개된 건입니다'; end if;
    update public.deal_interests
      set status = 'introduced', introduced_at = now(), introduced_by = auth.uid(), introduced_evidence = p_evidence
      where id = p_interest_id;
    return jsonb_build_object('fee_tier', null, 'charged', false, 'credit_used', false);
  end if;
  raise exception '알 수 없는 kind: %', p_kind;
end $$;
revoke execute on function public.admin_introduce(text, uuid, text) from public, anon;
grant execute on function public.admin_introduce(text, uuid, text) to authenticated;

/* close_my_post 재정의 — 마감 시 남은 pending 신청을 함께 정리(영구 '접수됨' 방치 방지) */
create or replace function public.close_my_post(p_post_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.partner_posts set status = 'closed'
  where id = p_post_id and created_by = auth.uid() and status in ('pending', 'published');
  if found then
    update public.partner_post_interests set status = 'declined'
    where post_id = p_post_id and status = 'pending';
  end if;
end $$;

-- ============================================================
-- 세모플 0012 — 과금·매칭 QA 하드닝 (0001~0011 실행된 DB에 이어서 실행 · 멱등)
-- 종합 QA(적대적 교차 검증 확정 38건)의 서버측 수정 배치:
--   ① 구독 만료·갱신: place_order가 만료 임박(7일)부터 갱신 주문 허용, 입금 확인 시 기존 행 연장
--      (uq_subs_active 위반 원천 차단), pro_verified 배지에 주기 만료 검사 추가
--   ② 환불 부수효과: 구독 환불 → 구독 취소+포함 크레딧 소멸, 스폰서 환불 → 슬롯 회수
--   ③ 미입금 취소: admin_cancel_charge RPC + place_order가 본인 기한 경과 주문을 자동 취소
--   ④ 중복 주문 멱등: 동일 상품 입금 대기 건이 있으면 새 청구 대신 기존 건 반환(더블클릭 방어)
--   ⑤ admin_introduce·respond_to_interest 상태 가드: declined·마감 건 소개·과금 차단(stale 화면 방어)
--   ⑥ 크레딧 차감 행에 만료 스탬프 — 주기 넘어 잔액이 음수로 이월되던 정합성 버그 수정
--   ⑦ 입금 확인·환불 행 잠금(for update) — 동시 실행 레이스 차단
--   ⑧ 과금 기록 탈퇴 보존: user FK cascade→set null + 이메일 스냅샷(전자상거래법 거래기록 보존)
--   ⑨ 수신함 노출 필드(platform_name·size_text)까지 연락처 서버 차단 확장(0009 패턴과 동일 기준)
--   ⑩ 파운더 50% 할인 서버 적용(profiles.founder_discount_until — 관리자가 활동 이력 확인 후 수동 부여)
--   ⑪ 환불 큐 재설계: 도달 불가 조건(v_admin_refund_due)을 폐기하고 전체 청구 뷰(v_admin_charges)로 대체
-- 구현 노트: 0011과 동일하게 신규 enum 값은 뷰에서 ::text 비교, 함수는 전부 plpgsql.
-- ============================================================

-- ── 1) charges 확장 — 탈퇴 후에도 남는 이메일 스냅샷 + 주문 시 안내한 입금자명 규칙 ──
alter table public.charges
  add column if not exists user_email     text,   -- 청구 시점 스냅샷(탈퇴 시 거래기록 보존 — 전자상거래법 §6)
  add column if not exists depositor_hint text;   -- 주문 시 사용자에게 안내한 입금자명 규칙(대조 키)

-- ── 2) 과금·구독 기록의 탈퇴 보존 — cascade 파기(0005 §5)를 set null(익명화 보존)로 환원 ──
-- 0001 주석 기준 charges는 '세금계산서 근거' 테이블: 사용자 셀프 탈퇴로 세무·거래 기록이
-- 소멸하면 안 된다. 개인 식별자는 null로 끊고 행(금액·시각·상태)만 남긴다.
do $$ begin
  alter table public.charges alter column user_id drop not null;
  alter table public.charges drop constraint if exists charges_user_id_fkey;
  alter table public.charges add constraint charges_user_id_fkey
    foreign key (user_id) references public.profiles(id) on delete set null;
  alter table public.subscriptions alter column user_id drop not null;
  alter table public.subscriptions drop constraint if exists subscriptions_user_id_fkey;
  alter table public.subscriptions add constraint subscriptions_user_id_fkey
    foreign key (user_id) references public.profiles(id) on delete set null;
  alter table public.credit_ledger alter column user_id drop not null;
  alter table public.credit_ledger drop constraint if exists credit_ledger_user_id_fkey;
  alter table public.credit_ledger add constraint credit_ledger_user_id_fkey
    foreign key (user_id) references public.profiles(id) on delete set null;
  alter table public.sponsor_slots alter column sponsor_user_id drop not null;
  alter table public.sponsor_slots drop constraint if exists sponsor_slots_sponsor_user_id_fkey;
  alter table public.sponsor_slots add constraint sponsor_slots_sponsor_user_id_fkey
    foreign key (sponsor_user_id) references public.profiles(id) on delete set null;
end $$;

-- ── 3) 연락처 서버 차단을 수신함 노출 필드까지 확장 ─────────────
-- 0011의 v_my_post_interests가 제안자에게 platform_name·size_text를 새로 노출하는데
-- 기존 check(0009)는 pitch만 검사했다. 패턴은 0009와 동일(클라이언트 anonymity.ts와 동기).
alter table public.partner_post_interests drop constraint if exists chk_ppint_nocontact;
alter table public.partner_post_interests add constraint chk_ppint_nocontact
  check ( (coalesce(pitch,'') || ' ' || coalesce(platform_name,'') || ' ' || coalesce(size_text,''))
    !~* '(@|https?://|www\.|0\d{1,2}[-. ]?\d{3,4}[-. ]?\d{4}|공일공|카카오톡|카톡|kakao|텔레그램|텔레그람|telegram|인스타|\yinsta(gram)?\y|디스코드|discord|(^|[^가-힣])라인\s?아이디|\yline[ -]?id\y|위챗|wechat|지메일)' ) not valid;

-- ── 4) 파운더 할인 부여 컬럼 — 관리자가 활동 이력 확인 후 수동 부여(자동 판정은 차기) ──
-- 부여: update profiles set founder_discount_until = current_date + interval '12 months' where id = '<uuid>';
alter table public.profiles add column if not exists founder_discount_until date;

-- ── 5) pro_verified 배지에 주기 만료 검사 — 만료된 구독의 배지 영구 표시 수정 ──
create or replace view public.v_partner_posts_public
  with (security_invoker = false) as
select pp.id, pp.title, pp.category_id, pp.type_id, pp.give_text, pp.get_text,
       pp.want_categories, pp.size_text, pp.detail, pp.status, pp.published_at::date as posted,
       exists (select 1 from public.subscriptions sb
               where sb.user_id = pp.created_by and sb.plan_id = 'pro'
                 and sb.status::text = 'active'
                 and coalesce(sb.current_period_end, now()) > now()) as pro_verified
from public.partner_posts pp where pp.status in ('published', 'matched');

-- ── 6) 환불 큐 재설계 — v_admin_refund_due는 도달 불가 조건(후불 구조에서 'paid인데 미소개'는
-- 존재할 수 없음)이라 폐기. 전 상태 청구 뷰로 대체: 입금 대기 큐·환불·슬롯 배정이 전부 여기서 나온다.
drop view if exists public.v_admin_refund_due;
drop view if exists public.v_admin_billing_queue;
drop view if exists public.v_admin_charges;
create view public.v_admin_charges
  with (security_invoker = false) as
select c.id, c.kind::text as kind, c.status::text as status, c.amount, c.vat, c.fee_tier,
       c.memo, c.depositor_name, c.depositor_hint, c.deposit_deadline, c.discount_rate,
       c.refund_amount, c.refund_reason, c.created_at, c.paid_at, c.refunded_at,
       c.user_id, coalesce(au.email, c.user_email) as user_email,
       exists (select 1 from public.sponsor_slots s where s.charge_id = c.id) as has_slot
from public.charges c
left join auth.users au on au.id = c.user_id
where public.is_admin();

-- ── 7) place_order 재정의 — 반환을 jsonb(id·총액·재사용 여부)로 확장(안내 금액의 단일 소스는 서버),
-- 중복 주문 멱등, 기한 경과 자동 취소, 갱신 창(만료 7일 전) 허용, 파운더 할인, 스냅샷 기록 ──
drop function if exists public.place_order(text, text, uuid);
drop function if exists public.place_order(text, text, uuid, text);
create function public.place_order(p_kind text, p_plan_id text default null, p_post_id uuid default null, p_depositor_hint text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare bill jsonb; total int; v_amount int; v_vat int; cid uuid; deadline_days int;
        v_email text; v_disc numeric; v_until date; existing record;
begin
  if auth.uid() is null then raise exception '로그인이 필요합니다'; end if;
  select value into bill from public.app_settings where key = 'billing';
  deadline_days := coalesce((bill->>'deposit_deadline_days')::int, 7);
  -- 기한이 지난 내 입금 대기 "주문"(boost·subscription)은 여기서 자동 취소('기한 경과 시 취소' 고지의 이행).
  -- connection_fee는 소개 이행 후의 채권이라 자동 취소하지 않는다(운영자 판단 — admin_cancel_charge).
  update public.charges set status = 'canceled', refund_reason = '기한 내 미입금 — 자동 취소'
    where user_id = auth.uid() and status::text = 'awaiting_deposit'
      and kind::text in ('boost', 'subscription') and deposit_deadline < current_date;
  if p_kind = 'boost' then
    if not coalesce((bill->>'sponsor')::boolean, false) then raise exception '스폰서 상품은 아직 오픈 전입니다'; end if;
    if not exists (select 1 from public.partner_posts
                   where id = p_post_id and created_by = auth.uid() and status = 'published')
      then raise exception '게시 중인 본인 제안에만 신청할 수 있어요'; end if;
    total := 99000;
  elsif p_kind = 'subscription' then
    if not coalesce((bill->>'membership')::boolean, false) then raise exception '멤버십은 아직 오픈 전입니다'; end if;
    if p_plan_id is distinct from 'pro' then raise exception '신청 가능한 플랜이 아닙니다'; end if;
    -- 만료 7일 전부터는 갱신 주문 허용(만료 후 재주문 영구 차단 버그 수정)
    if exists (select 1 from public.subscriptions
               where user_id = auth.uid() and status in ('active', 'past_due')
                 and coalesce(current_period_end, now() + interval '100 years') > now() + interval '7 days')
      then raise exception '이미 이용 중인 구독이 있습니다 — 만료 7일 전부터 갱신 주문이 가능해요'; end if;
    select monthly_price into total from public.plans where id = p_plan_id;
  else
    raise exception '알 수 없는 상품: %', p_kind;
  end if;
  -- 동일 상품이 이미 입금 대기 중이면 새 청구 대신 기존 건 반환(더블클릭·재주문 멱등)
  select id, amount, vat into existing from public.charges
    where user_id = auth.uid() and kind::text = p_kind and status::text = 'awaiting_deposit'
      and (p_kind <> 'boost' or memo = 'post:' || p_post_id)
    order by created_at desc limit 1;
  if existing.id is not null then
    return jsonb_build_object('id', existing.id, 'total', existing.amount + existing.vat, 'reused', true);
  end if;
  -- 파운더 할인(첫 12개월 50% — 부여 여부는 관리자가 활동 이력 확인 후 수동 기록)
  select founder_discount_until into v_until from public.profiles where id = auth.uid();
  if v_until is not null and v_until >= current_date then
    total := (total * 0.5)::int; v_disc := 0.5;
  end if;
  v_amount := round(total / 1.1)::int;  -- VAT 포함가 → 공급가 역산
  v_vat := total - v_amount;
  select email into v_email from auth.users where id = auth.uid();
  insert into public.charges (kind, user_id, user_email, amount, vat, status, deposit_deadline,
                              discount_rate, discount_reason, depositor_hint, memo)
  values (p_kind::charge_kind_t, auth.uid(), v_email, v_amount, v_vat, 'awaiting_deposit',
          current_date + deadline_days,
          v_disc, case when v_disc is not null then 'founder' end, nullif(trim(p_depositor_hint), ''),
          case when p_kind = 'boost' then 'post:' || p_post_id else 'plan:' || p_plan_id end)
  returning id into cid;
  return jsonb_build_object('id', cid, 'total', v_amount + v_vat, 'reused', false);
end $$;
revoke execute on function public.place_order(text, text, uuid, text) from public, anon;
grant execute on function public.place_order(text, text, uuid, text) to authenticated;

-- ── 8) admin_cancel_charge — 미입금·착오 주문의 수동 취소(입금 대기 상태만) ──
create or replace function public.admin_cancel_charge(p_charge_id uuid, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception '관리자 전용'; end if;
  update public.charges set status = 'canceled',
    refund_reason = coalesce(nullif(trim(p_reason), ''), '미입금 취소')
    where id = p_charge_id and status::text = 'awaiting_deposit';
  if not found then raise exception '입금 대기 상태의 청구가 아닙니다'; end if;
end $$;
revoke execute on function public.admin_cancel_charge(uuid, text) from public, anon;
grant execute on function public.admin_cancel_charge(uuid, text) to authenticated;

-- ── 9) admin_confirm_deposit 재정의 — 행 잠금(동시 확인 레이스) + 구독 갱신 분기
-- (기존 행 연장으로 uq_subs_active 위반 차단) + 포함 크레딧은 새 주기말로 만료 ──
create or replace function public.admin_confirm_deposit(p_charge_id uuid, p_depositor text)
returns void language plpgsql security definer set search_path = public as $$
declare c record; sid uuid; prev_end timestamptz; new_start timestamptz; new_end timestamptz;
begin
  if not public.is_admin() then raise exception '관리자 전용'; end if;
  select * into c from public.charges where id = p_charge_id for update;
  if c is null then raise exception '청구를 찾을 수 없습니다'; end if;
  if c.status::text <> 'awaiting_deposit' then raise exception '입금 대기 상태가 아닙니다(%)', c.status; end if;
  update public.charges set status = 'paid', paid_at = now(),
    depositor_name = p_depositor, confirmed_by = auth.uid() where id = p_charge_id;
  if c.kind = 'subscription' then
    -- 갱신: 기존 행이 있으면 연장(잔여 기간이 있으면 그 끝에서 이어붙임), 없으면 신규
    select id, current_period_end into sid, prev_end from public.subscriptions
      where user_id = c.user_id order by started_at desc limit 1 for update;
    new_start := case when prev_end is not null and prev_end > now() then prev_end else now() end;
    new_end := new_start + interval '1 month';
    if sid is not null then
      update public.subscriptions set plan_id = 'pro', status = 'active',
        current_period_start = new_start, current_period_end = new_end,
        price_snapshot = c.amount + c.vat, activated_at = coalesce(activated_at, now())
      where id = sid;
    else
      insert into public.subscriptions (user_id, plan_id, status, current_period_start, current_period_end, price_snapshot, activated_at)
      values (c.user_id, 'pro', 'active', new_start, new_end, c.amount + c.vat, now());
    end if;
    -- B형 3건 포함분(66,000 상당) — 주기말 소멸 버킷
    insert into public.credit_ledger (user_id, delta, reason, ref_id, bucket, expires_at)
    values (c.user_id, 66000, 'free_monthly', p_charge_id, 'plan_included', new_end);
  end if;
end $$;
revoke execute on function public.admin_confirm_deposit(uuid, text) from public, anon;
grant execute on function public.admin_confirm_deposit(uuid, text) to authenticated;

-- ── 10) admin_refund_charge 재정의 — 행 잠금 + 부수효과 회수:
-- 구독 환불 → 구독 취소+미사용 포함 크레딧 즉시 소멸, 스폰서 환불 → 슬롯 회수 ──
create or replace function public.admin_refund_charge(p_charge_id uuid, p_amount int, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare c record;
begin
  if not public.is_admin() then raise exception '관리자 전용'; end if;
  select * into c from public.charges where id = p_charge_id for update;
  if c is null or c.status <> 'paid' then raise exception 'paid 상태의 청구만 환불할 수 있습니다'; end if;
  if p_amount < 0 or p_amount > c.amount + c.vat then raise exception '환불 금액이 결제액을 초과합니다'; end if;
  update public.charges set status = 'refunded', refund_amount = p_amount,
    refunded_at = now(), refund_reason = p_reason where id = p_charge_id;
  if c.kind = 'subscription' then
    update public.subscriptions set status = 'canceled', current_period_end = now()
      where user_id = c.user_id and status in ('active', 'past_due');
    update public.credit_ledger set expires_at = now()
      where user_id = c.user_id and bucket = 'plan_included' and (expires_at is null or expires_at > now());
  elsif c.kind = 'boost' then
    delete from public.sponsor_slots where charge_id = p_charge_id and starts_on >= current_date;
    update public.sponsor_slots set ends_on = current_date - 1
      where charge_id = p_charge_id and starts_on < current_date and ends_on >= current_date;
  end if;
end $$;
revoke execute on function public.admin_refund_charge(uuid, int, text) from public, anon;
grant execute on function public.admin_refund_charge(uuid, int, text) to authenticated;

-- ── 11) respond_to_interest 재정의 — 이미 처리된 건은 조용한 no-op 대신 명시 오류 ──
create or replace function public.respond_to_interest(p_interest_id uuid, p_accept boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.partner_post_interests i
                 join public.partner_posts pp on pp.id = i.post_id
                 where i.id = p_interest_id and pp.created_by = auth.uid())
    then raise exception '내 제안에 달린 신청이 아닙니다'; end if;
  if p_accept then
    update public.partner_post_interests set owner_confirmed_at = now()
    where id = p_interest_id and status = 'pending';
  else
    update public.partner_post_interests set status = 'declined'
    where id = p_interest_id and status = 'pending';
  end if;
  if not found then raise exception '이미 처리된 신청입니다(거절·마감·소개 완료)'; end if;
end $$;
revoke execute on function public.respond_to_interest(uuid, boolean) from public, anon;
grant execute on function public.respond_to_interest(uuid, boolean) to authenticated;

-- ── 12) admin_introduce 재정의 — pending 상태 가드(stale 화면에서 declined 건 소개·과금 차단)
-- + 크레딧 차감 행에 만료 스탬프(주기 넘는 음수 이월 수정) + 파운더 할인 적용 ──
create or replace function public.admin_introduce(p_kind text, p_interest_id uuid, p_evidence text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare tier text; bill jsonb; charging boolean; total int; v_amount int; v_vat int;
        v_user uuid; v_email text; bal int; used_credit boolean := false; cid uuid;
        v_exp timestamptz; v_until date; v_disc numeric;
begin
  if not public.is_admin() then raise exception '관리자 전용'; end if;
  if coalesce(trim(p_evidence), '') = '' then raise exception '발송 증빙(메모)이 필요합니다'; end if;
  select value into bill from public.app_settings where key = 'billing';
  charging := coalesce((bill->>'connection')::boolean, false);

  if p_kind = 'partner' then
    perform 1 from public.partner_post_interests i
      join public.partner_posts pp on pp.id = i.post_id
      where i.id = p_interest_id and pp.status in ('published', 'matched');
    if not found then raise exception '대상 제안이 게시 상태가 아닙니다'; end if;
    perform 1 from public.partner_post_interests where id = p_interest_id and status = 'pending';
    if not found then raise exception '진행 가능한 상태가 아닙니다(이미 거절·마감·소개된 신청)'; end if;
    perform 1 from public.partner_post_interests
      where id = p_interest_id and contact_consent_at is not null and owner_confirmed_at is not null;
    if not found then raise exception '양측 동의(신청자 동의 + 제안자 확인)가 완료되지 않았습니다'; end if;
    select pt.fee_tier, i.user_id into tier, v_user
      from public.partner_post_interests i
      join public.partner_posts pp on pp.id = i.post_id
      join public.partner_types pt on pt.id = pp.type_id
      where i.id = p_interest_id;
    update public.partner_post_interests
      set status = 'introduced', introduced_at = now(), introduced_by = auth.uid(), introduced_evidence = p_evidence
      where id = p_interest_id and status = 'pending';
    if not found then raise exception '동시에 다른 처리가 실행됐어요 — 새로고침 후 확인해 주세요'; end if;
    if charging and tier <> 'A' then
      total := case tier when 'B' then 22000 else 77000 end;
      select founder_discount_until into v_until from public.profiles where id = v_user;
      if v_until is not null and v_until >= current_date then
        total := (total * 0.5)::int; v_disc := 0.5;
      end if;
      if tier = 'B' then
        select coalesce(sum(delta), 0), max(expires_at) filter (where delta > 0) into bal, v_exp
          from public.credit_ledger
          where user_id = v_user and bucket = 'plan_included' and (expires_at is null or expires_at > now());
        if bal >= total then
          -- 차감도 해당 적립분과 같은 시점에 만료 — 주기 넘어 음수 이월 방지
          insert into public.credit_ledger (user_id, delta, reason, ref_id, bucket, expires_at)
          values (v_user, -total, 'connection_fee', p_interest_id, 'plan_included', v_exp);
          used_credit := true;
        end if;
      end if;
      if not used_credit then
        v_amount := round(total / 1.1)::int; v_vat := total - v_amount;
        select email into v_email from auth.users where id = v_user;
        insert into public.charges (kind, user_id, user_email, interest_kind, interest_id, fee_tier,
                                    amount, vat, status, deposit_deadline, discount_rate, discount_reason)
        values ('connection_fee', v_user, v_email, 'partner', p_interest_id, tier, v_amount, v_vat, 'awaiting_deposit',
                current_date + coalesce((bill->>'deposit_deadline_days')::int, 7),
                v_disc, case when v_disc is not null then 'founder' end)
        returning id into cid;
      end if;
    end if;
    return jsonb_build_object('fee_tier', tier, 'charged', cid is not null, 'credit_used', used_credit);

  elsif p_kind = 'deal' then
    perform 1 from public.deal_interests i join public.deals d on d.id = i.deal_id
      where i.id = p_interest_id and d.status <> 'closed';
    if not found then raise exception '대상 매물이 게시 상태가 아닙니다'; end if;
    perform 1 from public.deal_interests
      where id = p_interest_id and status = 'pending'
        and contact_consent_at is not null and owner_confirmed_at is not null and introduced_at is null;
    if not found then raise exception '동의·확인 미완이거나 이미 처리(거절·소개)된 건입니다'; end if;
    update public.deal_interests
      set status = 'introduced', introduced_at = now(), introduced_by = auth.uid(), introduced_evidence = p_evidence
      where id = p_interest_id and status = 'pending';
    if not found then raise exception '동시에 다른 처리가 실행됐어요 — 새로고침 후 확인해 주세요'; end if;
    return jsonb_build_object('fee_tier', null, 'charged', false, 'credit_used', false);
  end if;
  raise exception '알 수 없는 kind: %', p_kind;
end $$;
revoke execute on function public.admin_introduce(text, uuid, text) from public, anon;
grant execute on function public.admin_introduce(text, uuid, text) to authenticated;

-- ============================================================
-- 세모플 0013 — 3차 QA(실사용 여정) 서버측 수정 (0001~0012 실행된 DB에 이어서 실행 · 멱등)
-- 본인 게시물에 대한 자기 신청(EOI) 차단: 클라이언트 가드와 별개로 RLS가 강제.
-- 자기 신청이 통과되면 자기 동의까지 성립해 self-pair가 소개 큐에 진입하는 문제(QA3 확인).
-- 주의: partner_posts/deals의 select 정책은 본인·관리자 한정이라 정책 안에서 직접
-- 서브쿼리하면 타인 게시물 신청까지 막힌다 — security definer 헬퍼로 소유 여부만 판정.
-- ============================================================

create or replace function public.is_own_post(p_post_id uuid)
returns boolean language sql security definer stable set search_path = public as
$$ select exists (select 1 from public.partner_posts where id = p_post_id and created_by = auth.uid()) $$;
revoke execute on function public.is_own_post(uuid) from public, anon;
grant execute on function public.is_own_post(uuid) to authenticated;

create or replace function public.is_own_deal(p_deal_id text)
returns boolean language sql security definer stable set search_path = public as
$$ select exists (select 1 from public.deals where id = p_deal_id and owner_id = auth.uid()) $$;
revoke execute on function public.is_own_deal(text) from public, anon;
grant execute on function public.is_own_deal(text) to authenticated;

-- 0008 §4 정책에 자기 신청 차단 조건 추가(기존 조건 유지)
drop policy if exists "insert own ppost interest" on public.partner_post_interests;
create policy "insert own ppost interest" on public.partner_post_interests for insert
  with check (
    auth.uid() is not null and user_id = auth.uid()
    and status = 'pending' and introduced_at is null and introduced_by is null
    and not public.is_own_post(post_id)
  );
drop policy if exists "insert own interest" on public.deal_interests;
create policy "insert own interest" on public.deal_interests for insert
  with check (
    user_id = auth.uid()
    and status = 'pending' and introduced_at is null and introduced_by is null
    and not public.is_own_deal(deal_id)
  );

-- ============================================================
-- 세모플 0014 — 판단 필드 시드(수수료대·정산·입점조건·강점)
-- (0001~0013 실행된 DB에 이어 실행 · 멱등 — 라이브 platforms 행을 UPDATE)
-- 0003(on conflict do nothing)은 이미 등재된 행을 갱신하지 않으므로 별도 UPDATE.
-- 정확성: 근거 확실만(수수료대 85곳), 강점·입점조건은 전체. blurb·이름은 건드리지 않음.
-- ============================================================
update public.platforms p set
  fee_band    = coalesce(v.fee_band::fee_band_t, p.fee_band),
  fee_text    = coalesce(v.fee_text,    p.fee_text),
  settle_text = coalesce(v.settle_text, p.settle_text),
  enter_text  = coalesce(v.enter_text,  p.enter_text),
  strength    = coalesce(v.strength,    p.strength)
from (values
  ('coupang', 'mid', '카테고리별 상이(정률)', '주·월 단위 정산 선택', '사업자등록·통신판매업 신고 후 판매자 가입', '로켓배송 물류·빠른배송, 대규모 트래픽'),
  ('smartstore', 'low', '결제수수료+매출연동수수료', '구매확정 후 +1영업일 정산', '사업자·개인 가입 후 스토어 개설(판매 시 신고)', '네이버 검색 노출·페이 연동, 낮은 진입장벽'),
  ('11st', 'mid', '카테고리별 상이', null, '사업자등록·통신판매업 신고 후 판매자 가입', 'SK 계열 종합 트래픽·프로모션'),
  ('gmarket', 'mid', '카테고리별 상이', null, '사업자등록·통신판매업 신고 후 판매자 가입', '신세계 계열, 옥션과 통합 판매관리(ESM)'),
  ('auction', 'mid', '카테고리별 상이', null, '사업자등록·통신판매업 신고 후 판매자 가입', '경매·즉시구매 병행, 1세대 오픈마켓 인지도'),
  ('ssg', 'mid', '카테고리별 상이', null, '입점 신청·심사 후 판매(사업자등록 필요)', '신세계·이마트 연계 신선·프리미엄 상품군'),
  ('lotteon', 'mid', '카테고리별 상이', null, '입점 신청·심사 후 판매(사업자등록 필요)', '롯데 유통 계열 연계, 백화점·마트 상품군'),
  ('interpark', 'mid', '카테고리별 상이', null, '사업자등록·통신판매업 신고 후 판매자 가입', '공연·투어·티켓 예매 연계에 강점'),
  ('shoppingseller', null, null, null, '사업자등록 후 톡스토어 판매자 입점', '카카오톡 채널 연계 판매·알림 도달'),
  ('aboutfishing', null, null, null, '판매자 입점 신청(사업자등록 필요)', '낚시 버티컬 — 예약·용품·중고 통합'),
  ('hnsmall', 'high', '정률 판매수수료 높은 편', null, '상품 제안·MD 협의·심사 후 편성 입점', '중소기업 제품 판로 중심 홈쇼핑·온라인몰'),
  ('gongyoungshop', 'low', '공영 목적 낮은 수수료', null, '중소기업·농어민 상품 제안·심사 후 입점', '중소기업·농어민 판로 지원, 낮은 수수료'),
  ('nsmall', 'high', '정률 판매수수료 높은 편', null, '상품 제안·MD 협의·심사 후 편성 입점', '식품·건강기능식품 상품군에 강점'),
  ('shinsegaetvshopping', 'high', '정률 판매수수료 높은 편', null, '상품 제안·MD 협의·심사 후 편성 입점', 'T커머스, 신세계 상품·유통 연계'),
  ('gsshop', 'high', '정률 판매수수료 높은 편', null, '상품 제안·MD 협의·심사 후 편성 입점', 'TV홈쇼핑+온라인 종합 판매망'),
  ('cjonstyle', 'high', '정률 판매수수료 높은 편', null, '상품 제안·MD 협의·심사 후 편성 입점', 'TV·모바일 통합 라이브커머스 역량'),
  ('hmall', 'high', '정률 판매수수료 높은 편', null, '상품 제안·MD 협의·심사 후 편성 입점', '현대홈쇼핑 연계 종합 온라인몰'),
  ('lotteimall', 'high', '정률 판매수수료 높은 편', null, '상품 제안·MD 협의·심사 후 편성 입점', '롯데 계열 홈쇼핑·아이몰 연계'),
  ('skstoa', 'high', '정률 판매수수료 높은 편', null, '상품 제안·MD 협의·심사 후 편성 입점', 'T커머스 중심 TV쇼핑·온라인몰'),
  ('kshop', 'high', '정률 판매수수료 높은 편', null, '상품 제안·MD 협의·심사 후 편성 입점', 'KT알파 계열 T커머스 채널'),
  ('cafe242', null, null, null, '회원가입 후 쇼핑몰 개설(판매 시 사업자등록)', '자사몰 구축·해외판매·마케팅 연동 폭넓음'),
  ('imweb', null, null, null, '회원가입 후 쇼핑몰·홈페이지 개설', '노코드 드래그로 빠른 자사몰 제작'),
  ('sixshop', null, null, null, '회원가입 후 쇼핑몰 개설(판매 시 사업자등록)', '디자인 템플릿 중심 브랜드몰 제작'),
  ('makeshop', null, null, null, '회원가입 후 임대형 쇼핑몰 구축', '임대형 쇼핑몰 기능·확장 옵션 다양'),
  ('godo', null, null, null, '회원가입 후 쇼핑몰 구축·호스팅', 'NHN 연계 쇼핑몰 구축·확장성'),
  ('wisa', null, null, null, '회원가입 후 독립·임대형 쇼핑몰 구축', '독립·임대형 선택형 구축 솔루션'),
  ('allways', null, null, null, '사업자 입점 신청 후 상품 등록', '팀 구매 기반 초저가·바이럴 유입'),
  ('kakaogift', null, null, null, '입점 심사 후 판매(사업자등록 필요)', '카카오톡 선물·모바일 쿠폰 수요 흡수'),
  ('wemakeprice', 'mid', '카테고리·딜별 상이', null, '판매자 입점 후 딜·상품 등록', '특가·딜 프로모션 노출에 강점'),
  ('tmon', 'mid', '카테고리·딜별 상이', null, '판매자 입점 후 딜·상품 등록', '타임딜·특가 기획전 중심 노출'),
  ('ohou', null, null, null, '스토어 입점 신청·심사 후 판매', '인테리어·리빙 콘텐츠 연계 구매 전환'),
  ('dailyshot', null, null, null, '제휴 매장·주류 판매 입점 협의', '주류 특가·예약 픽업에 특화'),
  ('08liter', null, null, null, '셀러·인플루언서 공동구매 입점 신청', '인플루언서·숏폼 기반 공동구매'),
  ('thirtymall', null, null, null, '임박·리퍼 상품 공급 입점 협의', '유통기한 임박·B급 재고 소진에 유리'),
  ('lastorder', null, null, null, '매장 제휴 등록 후 마감 상품 판매', '편의점·음식점 마감 임박 재고 할인'),
  ('imbak', null, null, null, '임박·재고 상품 공급사 제휴 후 입점', '유통기한 임박 재고 처리·할인 소싱에 강점'),
  ('eyoumall', null, null, null, '임박·못난이·재고 상품 공급사 제휴 입점', '임박·못난이·재고 등 잉여재고 할인 유통'),
  ('mahi', null, null, null, '동네 매장 사업자 가입 후 마감상품 등록', '매장 마감시간 임박 재고 실시간 할인·픽업'),
  ('simsale', null, null, null, '사업자등록·통신판매업 신고 후 입점', '함께 살수록 저렴해지는 공동구매형 판매'),
  ('market09', null, null, null, '사업자등록·통신판매업 신고 후 입점', '소수 인원 공동구매·라이브 경매 특가'),
  ('udong09', null, null, null, '사업자등록·통신판매업 신고 후 입점', '지역·동네 단위 공동구매에 특화'),
  ('witdeal', null, null, null, '사업자등록·통신판매업 신고 후 입점', '아파트 단지 단위 공동구매·무료배송'),
  ('ssagojoa', null, null, null, '사업자등록·통신판매업 신고 후 입점', '다양한 카테고리 상시 공동구매 운영'),
  ('inpock', null, null, null, '인플루언서·셀러 가입 후 스토어 개설', '인플루언서 SNS 기반 판매·공동구매 구축'),
  ('coocha', null, null, null, null, '여러 쇼핑몰 핫딜·특가 비교 검색에 강점'),
  ('uglyus', null, null, null, '친환경 농산물 공급 생산자 제휴 입점', '못난이 농산물 정기배송 구독에 특화'),
  ('motnany', null, null, null, '농가·생산자 가입 후 상품 등록', '못난이 농산물 산지·소비자 직거래'),
  ('sodomall', null, null, null, '가맹·제휴 문의 후 오프라인 매장 개설', '오픈채팅 기반 매장 픽업형 동네 공동구매'),
  ('colley', null, null, null, '셀러 가입 후 굿즈·중고 상품 등록', 'IP 굿즈·덕질 취향 커머스·중고 거래 결합'),
  ('navershopl', 'low', '스마트스토어 판매수수료+라이브 연동수수료', '구매확정 후 영업일 정산', '스마트스토어 개설 후 라이브 방송 진행', '스마트스토어 트래픽·검색 연동 라이브'),
  ('grip', null, null, null, '판매자 가입·심사 후 라이브 방송', '1인·소상공인도 진행 쉬운 라이브 진입장벽 낮음'),
  ('kakaoshopl', null, null, null, '입점 제휴·심사 후 방송(주로 브랜드 대상)', '카카오톡 채널·트래픽 연계 라이브'),
  ('coupanglive', null, null, null, '쿠팡 판매자·크리에이터 가입 후 방송', '쿠팡 상품·물류 연계 라이브 판매'),
  ('sauce', null, null, null, '솔루션 도입 문의·계약 후 자사몰 연동', '자사몰 내 라이브·쇼퍼블 비디오 임베드 솔루션'),
  ('vogoplay', null, null, null, '판매자 입점 제휴 후 라이브 방송', '초특가 상품 소싱 중심 모바일 라이브'),
  ('samsung', null, null, null, '삼성닷컴 공식 채널(일반 입점 대상 아님)', '삼성 가전·IT 공식 채널 실시간 방송'),
  ('11st2', null, null, null, '11번가 판매자 입점 후 라이브 신청', '11번가 오픈마켓 연계 예능형 라이브'),
  ('shinsegaeliveshopping', 'high', null, null, '상품 제안·MD 편성 심사(홈쇼핑형)', 'TV홈쇼핑·온라인 결합 라이브 편성'),
  ('jamlive', null, null, null, '제휴·입점 문의 후 방송', '인터랙티브·인플루언서 참여형 라이브'),
  ('display', null, null, null, 'MD 편성·상품 제안 심사 후 방송', 'CJ온스타일 홈쇼핑 연계 모바일 라이브'),
  ('7shoppinglive', null, null, null, '입점·제휴 문의 후 방송', '뉴스형 콘텐츠 결합 라이브 방송'),
  ('soonshop', null, null, null, '판매자·크리에이터 가입 후 숏폼 등록', '숏폼 리뷰 영상 기반 상품 판매'),
  ('wadiz', 'mid', '성공 시 모집액 연동 수수료(결제+서비스)', '펀딩 종료·결제 후 정산', '메이커 가입·프로젝트 심사 후 오픈', '리워드·투자형 모두 지원, 서포터 풀 넓음'),
  ('tumblbug', 'mid', '성공 시 모집액 연동 플랫폼 수수료', '펀딩 성공·결제 후 정산', '창작자 가입·프로젝트 심사 후 오픈', '창작·콘텐츠 프로젝트 후원 결집에 강점'),
  ('ohmycompany', null, null, null, '프로젝트 등록·심사 후 오픈', '소셜·공익 프로젝트와 증권형 병행'),
  ('crowdy', null, null, null, '발행기업 심사 후 청약 진행', '비상장기업 증권형(투자형) 펀딩 특화'),
  ('happybean', null, null, null, '공익단체·프로젝트 등록 후 모금', '네이버 기반 기부·공익 모금에 강점'),
  ('kickstarter', 'mid', '성공 시 모집액 5%+결제수수료', '펀딩 성공 후 정산', '해외 결제·법인 필요, 한국 직접 개설 미지원', '하드웨어·게임 글로벌 백커 도달에 강점'),
  ('funding4u', null, null, null, '발행기업 심사 후 청약 진행', '비상장기업 증권형 크라우드펀딩 중개'),
  ('crowdin', null, null, null, '프로젝트 등록·심사 후 오픈', '청년·소셜벤처 후원·투자형 펀딩'),
  ('benefitplus', null, null, null, '가입·본인인증 후 투자, 차입은 사업자 심사', '소상공인·소셜벤처 임팩트 대출형 투자에 특화'),
  ('otrade', null, null, null, '투자자 가입 후 청약, 발행은 기업 심사', '비상장기업 지분투자형 펀딩 중개에 특화'),
  ('indiegogo', 'mid', '플랫폼 수수료+결제 수수료', null, '계정 생성 후 프로젝트 등록(해외 결제 지원)', '글로벌 리워드형 펀딩, 해외 백커 도달에 강점'),
  ('kasa', null, null, null, '앱 가입·본인인증 후 투자', '상업용 부동산 수익증권 소액 조각투자에 강점'),
  ('funble', null, null, null, '앱 가입·본인인증 후 투자', '블록체인 기반 부동산 조각투자에 강점'),
  ('sou', null, null, null, '앱 가입·본인인증 후 투자', '부동산 월배당형 조각투자에 강점'),
  ('together', null, null, null, '가입·본인인증 후 투자', '부동산담보대출 중심 P2P 투자에 강점'),
  ('musicow', null, null, null, '앱 가입·본인인증 후 거래', '음악 저작권료 수익 기반 조각투자에 특화'),
  ('weshareart', null, null, null, '가입·본인인증 후 투자', '미술품 투자계약증권 소액 조각투자에 강점'),
  ('tessa', null, null, null, '앱 가입·본인인증 후 투자', '블루칩 미술품 조각투자에 강점'),
  ('8percent', null, null, null, '가입·본인인증 후 투자', '개인·기업 신용대출 중개 P2P 투자에 강점'),
  ('funderful', null, null, null, '가입·본인인증 후 투자', '영화·드라마·공연 등 K콘텐츠 프로젝트 투자에 특화'),
  ('fundingplay', null, null, null, '가입·본인인증 후 투자', '드라마·웹툰·음악 등 K콘텐츠 IP 투자에 특화'),
  ('withmix', null, null, null, '가입 후 프로젝트 등록으로 펀딩 개설', '스트리머·크리에이터 굿즈 리워드 펀딩에 특화'),
  ('runfunding', null, null, null, '가입 후 프로젝트 등록으로 펀딩 개설', '리워드·후원·투자형을 아우르는 종합 펀딩에 강점'),
  ('kmong', 'mid', '판매액 구간별 정률 수수료', '구매확정 후 정산', '개인·사업자 모두 가입 후 서비스 등록', '디자인·마케팅·IT 등 재능·용역 비대면 거래에 강점'),
  ('soomgo', null, null, null, '전문가 가입·프로필 등록 후 견적 발송', '레슨·이사·수리 등 생활 전문가 매칭에 강점'),
  ('wishket', null, null, null, '파트너 가입·검증 후 프로젝트 지원', 'IT 개발·디자인 프로젝트 외주 매칭에 강점'),
  ('taling', null, null, null, '튜터 가입·클래스 등록 후 개설', '취미·직무 원데이 클래스·튜터 매칭에 강점'),
  ('loud', null, null, null, '디자이너 가입 후 콘테스트 참여', '공모전·콘테스트 방식 디자인 외주에 특화'),
  ('otwojob', null, null, null, '개인·사업자 모두 가입 후 서비스 등록', '재능·서비스 비대면 거래 마켓에 강점'),
  ('elancer', null, null, null, '프리랜서 가입·프로필 등록 후 지원', 'IT 프리랜서 프로젝트 단위 아웃소싱 매칭에 강점'),
  ('freemoa', null, null, null, '파트너 가입·프로필 등록 후 지원', 'IT 개발·디자인 외주 프로젝트 중개에 강점'),
  ('wanted', null, null, null, '프리랜서 가입·프로필 등록 후 지원', '원티드 운영, IT 프리랜서 외주 매칭에 강점'),
  ('jaenung', null, null, null, '개인·사업자 모두 가입 후 서비스 등록', '디자인·번역·영상 등 재능 거래에 강점'),
  ('imjob', null, null, null, '프리랜서 가입·프로필 등록 후 지원', 'IT 인력·기업 프로젝트 매칭에 강점'),
  ('notefolio', null, null, null, '가입 후 포트폴리오 등록·외주 수주', '디자이너 포트폴리오 노출·디자인 외주에 강점'),
  ('datalab', null, null, null, '가입 후 참여자로 번역·데이터 작업 수행', '크라우드소싱 다국어 번역·언어 데이터 가공에 특화'),
  ('crowdworks', null, null, null, '가입 후 워커로 라벨링 작업 참여', 'AI 학습 데이터 라벨링 크라우드소싱에 특화'),
  ('selectstar', null, null, null, '가입 후 워커로 데이터 수집·가공 참여', 'AI 학습·평가 데이터 수집·가공 크라우드소싱에 특화'),
  ('codenary', null, null, null, '가입 후 프로필·기술스택 등록', '기술스택 기반 개발자 채용·외주 큐레이션에 강점'),
  ('provoice', null, null, null, '성우 가입·프로필 등록 후 수주', '성우·더빙·로컬라이징 보이스 외주 중개에 특화'),
  ('skillagit', null, null, null, '개인·사업자 모두 가입 후 서비스 등록', '디자인·번역·성우·영상 재능 거래에 강점'),
  ('talentbank', null, null, null, '전문가 가입·검증 후 자문·프로젝트 매칭', '검증된 시니어 전문가 자문·프로젝트 매칭에 특화'),
  ('gigtalk', null, null, null, '전문가 가입·프로필 등록 후 매칭', '전문가 네트워크 기반 프로젝트 매칭·인재추천에 강점'),
  ('sooooon', null, null, null, '사업자·구직자 가입 후 당일 근무 매칭', '당일 단위 초단기 인력 즉시 매칭에 강점'),
  ('apps9', 'low', '수수료 0% 표방', null, '개인·사업자 가입 후 프로필 등록', '부업·N잡 외주 연결, 낮은 수수료 표방'),
  ('gigtalker', null, null, null, '개인·사업자 가입 후 프로필 등록', '지식상품 판매·전문가 매칭에 강점'),
  ('1point', null, null, null, '전문가 심사·검증 후 프로필 등록', '검증된 마케터·디자이너 매칭에 강점'),
  ('ssosing', null, null, null, '가입 후 프로젝트 의뢰·상담 진행', '전담 PM의 프로젝트 관리형 외주 매칭'),
  ('heybeagle', null, null, null, '전문가 프로필 등록/의뢰자 견적 요청', '공연·행사 전문가 견적 비교 섭외에 강점'),
  ('myoncast', null, null, null, '전문가 등록/의뢰자 섭외 요청', '아나운서·MC·사회자 섭외 매칭에 강점'),
  ('ieumcompany', null, null, null, '전문가 등록/의뢰자 섭외 요청', '공연·사회자 섭외 중개에 강점'),
  ('lessoneasy', null, null, null, '강사 프로필 등록/수강생 매칭 신청', '음악·미술·무용 레슨 강사 연결에 강점'),
  ('lessoninfo', null, null, null, '강사·학원 가입 후 구인구직 등록', '음악 강사·학원 구인구직 매칭에 강점'),
  ('zimcarry', null, null, null, '이용자 예약, 제휴처 파트너 등록', '여행짐 배송·보관 서비스에 강점'),
  ('lifeistravel', null, null, null, '제휴 매장 등록/이용자 예약', '카페·편의점 제휴 기반 여행 짐보관에 강점'),
  ('goodlugg', null, null, null, '이용자 예약, 제휴처 파트너 등록', '여행 수하물 배송·보관에 강점'),
  ('ontrip', null, null, null, '가이드·현지여행사 등록/여행자 예약', '현지 가이드·현지여행사 직접 연결에 강점'),
  ('baemin', 'high', '중개이용료+결제·배달비 별도(요금제별 상이)', null, '사업자등록·영업신고 후 입점 신청', '높은 주문 수요·배달 인프라로 주문 노출에 강점'),
  ('coupangeats', 'high', '중개이용료+결제·배달비 별도(요금제별 상이)', null, '사업자등록·영업신고 후 입점 신청', '쿠팡 회원 트래픽 기반 단건배달에 강점'),
  ('yogiyo', 'high', '중개이용료+결제·배달비 별도(요금제별 상이)', null, '사업자등록·영업신고 후 입점 신청', '배달 주문중개·프랜차이즈 노출에 강점'),
  ('ddangyo', 'low', '낮은 중개수수료 표방(신한 계열)', null, '사업자등록·영업신고 후 입점 신청', '낮은 수수료 부담, 지역상권 배달에 강점'),
  ('home', null, null, null, '상점 계약 후 배달대행 이용', '상점 대상 프리미엄 라이더 물류·배달대행에 강점'),
  ('logiall', null, null, null, '지역 대리점 계약 후 이용', '전국 지역 배달대행 네트워크 규모에 강점'),
  ('mannaplus', null, null, null, '배달대행사·상점 가입 후 이용', '배달대행 관제·정산 관리에 강점'),
  ('spidor', null, null, null, '배달대행사·상점 가입 후 이용', 'IT 기반 종합 배달대행 관제에 강점'),
  ('wmpo', 'low', '저중개수수료 표방', null, '사업자등록·영업신고 후 입점 신청', '낮은 수수료, 픽업·배달 주문중개에 강점'),
  ('mukkebi', 'low', '저수수료 공공배달(지역화폐 연계)', null, '지역 소재 사업자 입점 신청', '지역화폐 결제·낮은 수수료에 강점'),
  ('daeguro', 'low', '저수수료 공공배달', null, '대구 소재 사업자 입점 신청', '대구 지역 공공배달, 낮은 수수료에 강점'),
  ('specialdelivery', 'low', '저수수료 공공배달(지역화폐 연계)', null, '경기도 소재 사업자 입점 신청', '경기도 공공배달, 지역화폐 결제에 강점'),
  ('neubility', null, null, null, '제휴 문의 기반 B2B 도입', '자율주행 로봇 기반 라스트마일 배달에 강점'),
  ('insungdata', null, null, null, '배달대행사 대상 프로그램 도입 계약', '이륜차 퀵·배달대행 관제 SW에 강점'),
  ('gunsan', 'low', '중개수수료·광고료 없음', null, '군산 소재 사업자 입점 신청', '무중개수수료 공공배달(전국 최초)'),
  ('apps7', 'low', '수수료·광고료·가입비 없음', null, '거제 소재 사업자 입점 신청', '수수료·광고료·가입비 부담 없는 공공배달'),
  ('play', null, null, null, '전통시장 점포 입점 신청', '전통시장 점포 장보기·배달에 강점'),
  ('jecheon', 'low', '무수수료(지역화폐 할인)', null, '제천 소재 사업자 입점 신청', '제천 공공배달, 무수수료·지역화폐 할인에 강점'),
  ('bsnamgu', 'low', '저수수료 공공배달', null, '부산 남구 소재 사업자 입점 신청', '부산 남구 공공배달, 오륙도페이 결제에 강점'),
  ('play2', 'low', '저수수료 공공배달(울산페이 연계)', null, '울산 소재 사업자 입점 신청', '울산 공공배달, 울산페이·저수수료에 강점'),
  ('incheoneum', 'low', '저수수료 공공배달(지역화폐 연계)', null, '인천 소재 사업자 입점 신청', '인천e음 연계 공공배달·캐시백에 강점'),
  ('apps8', null, null, null, '사업자 가맹·입점 신청 후 메뉴 등록', '지역 소상공인·공공배달 연계 주문중개에 강점'),
  ('24242424', null, null, null, '화주·기사 가입 후 건별 접수', '화주-화물차 기사 매칭 운송·퀵 중개에 강점'),
  ('gogox', null, null, null, '가입 후 건별 접수·즉시 이용', '오토바이~트럭 실시간 퀵·용달·화물 배차에 강점'),
  ('algoquick', null, null, null, '가입 후 건별 접수·실시간 견적', '실시간 요금·관제 기반 온디맨드 배송에 강점'),
  ('hudadaq', null, null, null, '가입 후 자동견적·건별 접수', '퀵·용달·화물·간단이사 자동견적 배송에 강점'),
  ('callkim', null, null, null, '가입 후 요금조회·건별 접수', '오토바이·다마스·트럭 퀵 요금조회·접수에 강점'),
  ('kakaomobility2', null, null, null, '카카오T 가입 후 건별 접수', '카카오T 연계 퀵·도보 배송 접근성에 강점'),
  ('play3', null, null, null, '가입 후 건별 접수·당일배송', '전국 퀵·화물 당일배송 접수에 강점'),
  ('ssinging', null, null, null, '가입 후 심부름 건별 접수', '배달·구매대행·설치·청소 종합 심부름에 강점'),
  ('amazing', null, null, null, '가입 후 배송 건별 접수', '창고 없이 노선순환 방식 수도권 당일배송에 강점'),
  ('wemeetmobility', null, null, null, '가입 후 배송 건별 접수', '제주 지역 특화 배차최적화 라스트마일에 강점'),
  ('chainlogis', null, null, null, '셀러 계약·입고 후 이용', '입고 후 4시간 내 당일도착 라스트마일에 강점'),
  ('returnit', null, null, null, '매장·사업자 제휴 후 이용', '배달 다회용기 순환(수거·세척) 친환경 물류에 강점'),
  ('inflow', null, null, null, '라이더·사업자 가입 후 이용', '이륜 라이더 차량·관제·배송대행 통합 운영에 강점'),
  ('fassto', null, null, null, '셀러 계약·상품 입고 후 이용', '이커머스 셀러 보관·출고 풀필먼트에 강점'),
  ('dohandsome', null, null, null, '셀러 계약·상품 입고 후 이용', '소량·스타트업 친화 풀필먼트에 강점'),
  ('wekeep', null, null, null, '쇼핑몰 계약·상품 입고 후 이용', '쇼핑몰 물류대행·풀필먼트에 강점'),
  ('qxpress', null, null, null, '셀러 계약·상품 입고 후 이용', '국제 배송·해외 풀필먼트에 강점'),
  ('welcome', null, null, null, '셀러 계약·상품 입고 후 이용', '이커머스 셀러 대상 풀필먼트에 강점'),
  ('ourbox', null, null, null, '셀러 계약·상품 입고 후 이용', '물류 자동화 설비 기반 풀필먼트에 강점'),
  ('dealibird', null, null, null, '셀러 계약 후 사입~배송 위탁', '동대문 의류·잡화 사입~배송 풀필먼트에 강점'),
  ('mychango', null, null, null, '셀러 계약·상품 입고 후 이용', '중소 셀러 보관·물류대행 풀필먼트에 강점'),
  ('colosseum', null, null, null, '셀러 계약·상품 입고 후 이용', '보관~포장~배송~반품 풀필먼트 DX에 강점'),
  ('ezadmin', null, null, null, '가입·설정 후 통합관리 이용', '쇼핑몰 통합관리·WMS 솔루션에 강점'),
  ('logispot', null, null, null, '화주 계약 후 화물운송 이용', 'IT 기반 화물운송·통합 물류에 강점'),
  ('logiket', null, null, null, '가입 후 비교견적·매칭 이용', '물류사 비교견적 3PL 대행 매칭에 강점'),
  ('cjlogistics', null, null, null, '셀러 계약·상품 입고 후 이용', '이커머스 통합 풀필먼트·전국 배송망에 강점'),
  ('sellerrouteground', null, null, null, '셀러 계약·상품 입고 후 이용', '3PL 풀필먼트·로켓그로스 납품 대행에 강점'),
  ('returneeds', null, null, null, '셀러 계약 후 반품물류 위탁', '반품 전용센터 기반 역물류 대행에 강점'),
  ('enterround', null, null, null, '셀러 계약·상품 입고 후 이용', '국내외 풀필먼트+해외배송 크로스보더 물류에 강점'),
  ('argoport', null, null, null, '셀러 계약·상품 입고 후 이용', '수요예측·재고·배송 통합 SW 기반 3PL에 강점'),
  ('bold9', null, null, null, '셀러 계약·상품 입고 후 이용', '주문·배송·CS 통합 대행 풀필먼트에 강점'),
  ('alibaba', null, null, null, '사업자 등록·멤버십 가입 후 상품 등록', '글로벌 B2B 도매·해외 바이어 소싱에 강점'),
  ('amazongs', 'high', '카테고리별 판매수수료+월 계정료', '약 2주 주기 정산', '해외판매 계정·세금정보 등록 필요', '아마존 글로벌 마켓 진출·해외판매에 강점'),
  ('shopee', 'mid', '마켓·카테고리별 수수료 상이', null, '글로벌셀러 등록·해외판매 계정 필요', '동남아·대만 이커머스 진출에 강점'),
  ('qoo10', 'mid', null, null, '사업자등록 후 셀러 가입·크로스보더 판매', '일본 등 아시아권 역직구 판매에 강점'),
  ('tradekorea', null, null, null, '무료 회원가입 후 기업·수출상품 등록', 'KOTRA 운영 B2B 바이어 매칭·수출 상담에 강점'),
  ('buykorea', null, null, null, '무료 가입 후 수출상품 등록', 'KOTRA 운영 수출 지원·해외 바이어 연결에 강점'),
  ('ec21', null, null, null, '가입 후 기업·상품 등록', 'B2B 수출 상품 노출·해외 인콰이어리 확보에 강점'),
  ('ebay', 'mid', null, null, '이베이 셀러 계정 등록 후 해외판매', '전 세계 대상 개인·소량 해외판매에 강점'),
  ('lazada', 'mid', null, null, '크로스보더 셀러 등록 후 동남아 판매', '동남아 크로스보더 판매에 강점'),
  ('wish', 'mid', null, null, '셀러 가입 후 상품 등록·해외판매', '북미·유럽 모바일 역직구 판매에 강점'),
  ('seller', null, null, null, '크로스보더 셀러센터 등록 후 판매', '숏폼·라이브 기반 크로스보더 판매에 강점'),
  ('seller2', null, null, null, '셀러 입점 심사 후 상품 공급', '저가 대량 판매 시장 진입에 강점'),
  ('sell', 'mid', null, null, '글로벌셀링 셀러 등록 후 해외판매', '알리 채널로 해외 소비자 판매에 강점'),
  ('rakuten', 'mid', null, null, '입점 심사 후 일본 시장 판매', '일본 종합몰 판매에 강점'),
  ('marketplace', 'mid', null, null, '초청·심사 후 미국 마켓 셀러 등록', '미국 대형 유통 마켓 진입에 강점'),
  ('shopify', null, null, null, '구독 가입 후 자사몰 구축·해외 직접 판매', '다국어·다통화 자사몰 구축에 강점'),
  ('cafe24', null, null, null, '가입 후 다국어 쇼핑몰 구축', '해외결제·배송 연동 쇼핑몰 구축에 강점'),
  ('global', null, null, null, '가입 후 다국어 쇼핑몰 구축', '영·일·중 통합 쇼핑몰 해외판매에 강점'),
  ('kr', null, null, null, '중소기업 가입 후 수출상품 등록', '중소기업 온라인 수출·바이어 매칭에 강점'),
  ('marketplace2', null, null, null, '쿠팡 셀러 자격으로 해외진출 프로그램 신청', '쿠팡 인프라로 대만 등 해외 동반 진출에 강점'),
  ('musinsa2', null, null, null, '무신사 입점 브랜드 대상 글로벌 스토어 노출', 'K-패션 브랜드 역직구 판매에 강점'),
  ('malltail', null, null, null, '회원가입 후 해외 배송대행 이용', '9개국 물류 기반 역직구·해외배송 대행에 강점'),
  ('delivered', null, null, null, '셀러 가입 후 해외판매·배송대행 이용', '한국 셀러 해외판매·배송 대행에 강점'),
  ('sellerhub', null, null, null, '가입 후 쇼핑몰 연동·상품 통합 관리', '국내외 멀티채널 통합 관리에 강점'),
  ('shopigate', null, null, null, '상담 후 쇼피파이 스토어·물류 대행 이용', '쇼피파이 구축~해외물류 역직구 대행에 강점'),
  ('shipda', null, null, null, '가입·견적 후 수입물류 포워딩 이용', '이커머스 수입물류 포워딩에 강점'),
  ('iporter', null, null, null, '회원가입 후 배송·구매대행 이용', '미국·일본 배송·구매대행에 강점'),
  ('ohmyzip', null, null, null, '회원가입 후 미국 배송대행 이용', '미국 물류센터 기반 배송대행에 강점'),
  ('tridge', null, null, null, '가입 후 공급처·바이어 매칭 이용', '농식품 공급처·가격 데이터·무역 중개에 강점'),
  ('saruwa', null, null, null, '회원가입 후 일본 상품 구매·배송대행 이용', '일본 사이트 상품 구매·배송대행에 강점'),
  ('japandelivery', null, null, null, '회원가입 후 일본 구매·배송대행 이용', '일본 쇼핑몰 구매·배송대행에 강점'),
  ('rakuten2', 'mid', null, null, '입점 심사 후 일본 라쿠텐 이치바 판매', '일본 종합몰 현지 판매에 강점'),
  ('sell2', null, null, null, '셀러 등록·심사 후 중동 판매', '중동 마켓플레이스 판매에 강점'),
  ('global2', null, null, null, '크로스보더 셀러 등록 후 러시아 판매', '러시아 오존 마켓 크로스보더 판매에 강점'),
  ('seller3', null, null, null, '셀러 등록·심사 후 인도 마켓 판매', '인도 대형 이커머스 판매에 강점'),
  ('group', null, null, null, '셀러 등록 후 아프리카 마켓 판매', '아프리카 다국가 마켓 판매에 강점'),
  ('partner', null, null, null, '파트너 승인 심사 후 유럽 패션 판매', '유럽 패션 마켓 파트너 판매에 강점'),
  ('marketplace3', null, null, null, '셀러 등록 후 프랑스·유럽 판매', '프랑스 마켓 해외 셀러 판매에 강점'),
  ('sell3', null, null, null, '사업자 셀러 심사 후 입점(크로스보더)', '40여개국 다국어·다통화 자동 노출에 강점'),
  ('kogan', null, null, null, '사업자 셀러 심사 후 입점', '호주 코간닷컴 트래픽 기반 현지 판매에 강점'),
  ('reverb', 'low', '판매수수료+결제수수료 구조', null, '개인·사업자 가입 후 상품 등록', '신품·빈티지 악기·음향장비 전문 수요에 강점'),
  ('sellervn', null, null, null, '현지·크로스보더 셀러 가입 후 스토어 개설', '틱톡샵 베트남 숏폼·라이브 커머스 노출에 강점'),
  ('sellerid', null, null, null, '셀러 가입 후 스토어 개설', '인도네시아 토코피디아·틱톡샵 통합 노출에 강점'),
  ('globalsellers', null, null, null, '국내 제조·판매 사업자 심사 후 참여', '쿠팡 대만 등 해외 채널 진출에 강점'),
  ('sell4', null, null, null, '아마존 진출 사업자가 서비스 파트너 탐색', '인증·물류·마케팅 공식 파트너 연결에 강점'),
  ('sellerpick', null, null, null, '가입 후 이용', '해외 상품 등록·이미지 번역·AI 추천 지원에 강점'),
  ('globalselling', null, null, null, '셀러 가입·심사 후 단일 계정 판매', '멕시코·브라질 등 중남미 크로스보더 진출에 강점'),
  ('domeggook', null, null, null, '회원가입 후 구매, 판매는 셀러 등록', '소량 사입·국내 온라인 도매 물량에 강점'),
  ('domemedae', null, null, null, '사업자등록 후 위탁판매 셀러 가입', '무재고 배송대행(위탁판매) 소싱에 강점'),
  ('ownerclan', null, null, null, '사업자등록 후 가입', '위탁판매용 대량 상품 소싱·연동에 강점'),
  ('onchannel', null, null, null, '사업자등록 후 가입', '위탁·도매 상품 공급에 강점'),
  ('dometopia', null, null, null, '사업자등록 후 가입', '무사입 위탁판매 중심 종합 도매에 강점'),
  ('domesin', null, null, null, '사업자등록 후 위탁 셀러 가입', '배송대행 특화 위탁 도매에 강점'),
  ('naggama', null, null, null, '회원가입 후 거래 참여', '덤핑·재고 물량 도매 거래에 강점'),
  ('sellpie', null, null, null, '사업자등록 후 가입', '위탁판매 전문 상품 소싱에 강점'),
  ('sellerocean', null, null, null, '사업자등록 후 가입', '위탁판매 공급자 연결에 강점'),
  ('sinsangmarket', null, null, null, '사업자등록 후 앱 가입', '동대문 패션 도소매 B2B 사입에 강점'),
  ('zentrade', null, null, null, '사업자등록 후 가입', '문구·잡화·생필품 B2B 도매에 강점'),
  ('domaechanggo', null, null, null, '사업자등록 후 가입', '위탁판매용 B2B 도매 상품에 강점'),
  ('modoosale', null, null, null, '사업자등록 후 가입', '위탁도매·배송대행 소싱에 강점'),
  ('asadalin', null, null, null, '사업자등록 후 가입', '유아·아동복 전문 도매 소싱에 강점'),
  ('saibmoa', null, null, null, '사업자등록 후 가입', '동대문 의류 사입·배송대행에 강점'),
  ('selpi', null, null, null, '사업자등록 후 앱 가입', '동대문 도매 신상을 소매 셀러에 연결에 강점'),
  ('sellernow', null, null, null, '셀러 가입 후 이용', '도매처 모음·3PL 비교 셀러 지원에 강점'),
  ('domegod', null, null, null, '사업자 전용 가입', '낱장구매·위탁배송 B2B 도매에 강점'),
  ('doogo', null, null, null, '셀러·공급사 가입 후 이용(구독형)', '구독형 위탁 도매 오픈마켓 소싱에 강점'),
  ('uh2samarket', null, null, null, '사업자등록 후 가입', '광저우 보세 직거래 사입·통관·배송에 강점'),
  ('chinabuy', null, null, null, '가입 후 앱 이용', '1688·타오바오 중국 구매대행에 강점'),
  ('algugo', null, null, null, '가입 후 이용', '1688 연동 자동주문·검수·물류에 강점'),
  ('foodpang', null, null, null, '외식업 사업자 가입 후 주문', '농산물 도매시장 직거래 식자재 배송에 강점'),
  ('beseller', null, null, null, '사업자등록 후 가입', '농수축산 식품 B2B 위탁판매에 강점'),
  ('hairnmi', null, null, null, '미용업 사업자 가입 후 구매', '미용실 전용 헤어제품 도매에 강점'),
  ('hairsoo', null, null, null, '미용업 사업자 가입 후 구매', '염색약·펌제 등 미용재료 도매가에 강점'),
  ('dckitchen', null, null, null, '사업자 회원가입 후 도매 구매', '업소용 주방기구·설비 도매 소싱에 강점'),
  ('jubangbank', null, null, null, '사업자 회원가입 후 도매 구매', '업소용 주방용품·주방기기 전문 소싱'),
  ('jubangmart', null, null, null, '사업자 회원가입 후 매입·납품·렌탈 이용', '중고 주방기구 매입·렌탈까지 처리'),
  ('mednara', null, null, null, '사업자 회원가입 후 매입·판매 거래', '중고·신품 의료기기 거래에 강점'),
  ('medimarket', null, null, null, '사업자 회원가입 후 매입·판매 거래', '병원용 중고 의료기기 매입·판매'),
  ('medisale', null, null, null, '사업자 회원가입 후 도매 구매', '병원 의료소모품 정기 소싱에 강점'),
  ('nongdal', null, null, null, '회원가입 후 농자재 구매', '비료·종자·농약 등 농자재 소싱'),
  ('nongmart', null, null, null, '회원가입 후 농자재 구매', '농자재 최저가 보상제로 가격 소싱'),
  ('vkm101', null, null, null, '사업자 회원가입 필요(사업자 전용)', '노량진 산지 수산물 사업자 직거래'),
  ('seapro', null, null, null, '사업자 회원가입 후 도매 거래', '식당·급식용 냉동수산물 소싱에 강점'),
  ('haemulsa', null, null, null, '회원가입 후 도매 구매', '냉동수산물 도매 직거래에 강점'),
  ('dsfoodmall', null, null, null, '사업자 회원가입 후 도소매 구매', '축산물 정육 도소매 직거래'),
  ('onnurimeat', null, null, null, '사업자 회원가입 후 도매 구매', '한우 등급육 등 축산 도매 소싱'),
  ('meatasia', null, null, null, '사업자 회원가입 후 도매 거래', '수입육 온라인 도매 중개에 강점'),
  ('wholesale119', null, null, null, '사업자 회원가입 후 사입 이용', '양재 화훼시장 절화 온라인 사입'),
  ('krflower', null, null, null, '사업자 회원가입 후 도매 구매', '수입화·절화 등 화훼 도매 소싱'),
  ('dplaza', null, null, null, '사업자 회원가입 후 도매 사입', '동대문 원단·의류부자재·부속 소싱'),
  ('dongdaemun153', null, null, null, '사업자 회원가입 후 도매 사입', '액세서리·봉제 부자재 소싱에 강점'),
  ('ndmarket', null, null, null, '사업자 회원가입 후 사입 대행 이용', '남대문·동대문 사입 대행 소싱'),
  ('sellup', null, null, null, '앱 가입 후 소매·사입 이용', '동대문 사입 주문·결제·정산 앱 일원화'),
  ('yanolja', 'mid', '예약 중개 수수료(정률)', null, '숙박·레저 사업자 제휴 신청 후 입점', '국내 숙박·레저 예약 노출·중개에 강점'),
  ('goodchoice', 'mid', '예약 중개 수수료(정률)', null, '숙박·액티비티 사업자 제휴 신청 후 입점', '국내 숙박·액티비티 예약 노출·중개'),
  ('airbnb', 'low', '호스트 서비스 수수료(약 3%)', '체크인 후 약 24시간 뒤 지급', '개인·사업자 호스트 등록 후 리스팅', '글로벌 여행객 대상 숙소·체험 호스팅'),
  ('spacecloud', null, null, null, '공간 호스트 등록 후 게시', '모임·연습·촬영 공간 시간 단위 대여'),
  ('catchtable', null, null, null, '식당 사업자 제휴 등록 후 이용', '식당 예약·웨이팅 관리에 강점'),
  ('myrealtrip', 'mid', '판매 중개 수수료(정률)', null, '가이드·사업자 상품 등록 후 판매', '투어·가이드·액티비티 상품 판매'),
  ('klook', 'mid', '판매 중개 수수료(정률)', null, '액티비티 사업자 제휴 등록 후 판매', '아시아권 여행·액티비티·티켓 판매'),
  ('agoda', 'high', '예약 중개 수수료(정률)', null, '숙소 사업자 제휴 등록 후 입점', '글로벌 호텔·숙소 예약 노출에 강점'),
  ('booking', 'high', '예약 중개 수수료(정률)', null, '숙소 사업자 제휴 등록 후 입점', '전 세계 숙소 예약 노출에 강점'),
  ('hotelscombined', null, null, null, 'OTA·호텔 제휴 등록 후 노출', '호텔 가격 비교 메타서치 노출'),
  ('trivago', null, null, null, 'OTA·호텔 제휴 등록 후 노출', '호텔 가격 비교 메타서치 노출'),
  ('kr2', 'mid', '예약 중개 수수료(정률)', null, '여행 사업자 제휴 등록 후 판매', '항공·호텔·투어 종합 예약에 강점'),
  ('triple', null, null, null, '여행 상품 제휴 등록 후 연동', 'AI 일정 생성·항공/호텔/투어 예약 연동'),
  ('onlinetour', null, null, null, '여행 상품 제휴 등록 후 판매', '항공권·패키지·호텔 예약에 강점'),
  ('mtour', null, null, null, '여행·숙박·레저 사업자 제휴 등록', '여행·숙박·레저 특가 판매 노출'),
  ('waug', null, null, null, '여행·액티비티 사업자 제휴 후 상품 등록', '국내외 입장권·투어·액티비티 예약에 강점'),
  ('frip', null, null, null, '호스트 가입·클래스 개설 후 심사', '취미 클래스·여가 액티비티 모객에 강점'),
  ('stayfolio', null, null, null, '숙소 제휴·큐레이션 심사 후 등록', '디자인·감성 숙소 큐레이션 노출에 강점'),
  ('livinginhotel', null, null, null, '호텔·레지던스 제휴 후 등록', '호텔·레지던스 한 달 살기 단기임대 중개에 강점'),
  ('wehome', null, null, null, '호스트 가입·공유숙박 요건 확인 후 등록', '합법 공유숙박·홈스테이 중개에 강점'),
  ('hourplace', null, null, null, '공간 호스트 등록·심사 후 게시', '촬영 스튜디오·공간 시간제 대여에 강점'),
  ('shareit', null, null, null, '공간 호스트 등록 후 게시', '팝업·워크숍·모임 공간 중개에 강점'),
  ('moim', null, null, null, '지점 예약 또는 공간 제휴 후 이용', '모임·회의·스터디 공간 예약에 강점'),
  ('camfit', null, null, null, '캠핑장 사업자 제휴 후 등록', '캠핑장·글램핑·차박 실시간 예약에 강점'),
  ('thankqcamping', null, null, null, '캠핑장 사업자 제휴 후 등록', '캠핑장 실시간 예약·잔여석 확인에 강점'),
  ('tabling', null, null, null, '매장 사업자 등록 후 웨이팅 운영', '식당 원격 줄서기·웨이팅 관리에 강점'),
  ('home2', null, null, null, '매장 사업자 등록 후 대기 운영', '매장 원격 대기·예약 관리에 강점'),
  ('onoffmix', null, null, null, '주최자 가입 후 행사 개설·신청 관리', '세미나·모임·행사 개설·참가 신청에 강점'),
  ('camperest', null, null, null, '캠핑장 제휴 후 등록', '캠핑장 예약·다이어리·맞춤 추천 통합에 강점'),
  ('cambak', null, null, null, '캠핑카 대여사 제휴 후 등록', '캠핑카·차박 대여사 연결에 강점'),
  ('yomo', null, null, null, '여행 전문가 등록·프로필 심사 후', '맞춤 일정 프라이빗 여행 컨시어지에 강점'),
  ('popply', null, null, null, '공간·주최자 등록 후 매칭', '팝업스토어 발견·공간 매칭에 강점'),
  ('hanintel', null, null, null, '한인 게하·민박 등록 후 게시', '해외 한인 민박·게스트하우스 예약 중개에 강점'),
  ('campingtalk', null, null, null, '캠핑장·펜션 사업자 제휴 후 등록', '오토캠핑·글램핑·카라반·펜션 예약에 강점'),
  ('realground', null, null, null, '캠핑장 사업자 제휴 후 등록', 'VR 미리보기 기반 캠핑장 예약에 강점'),
  ('oneulbamn', null, null, null, '숙소 사업자 제휴 후 등록', '펜션·풀빌라·글램핑 실시간 예약에 강점'),
  ('wowple', null, null, null, '공간 호스트 등록 후 게시', '파티룸·회의실·스튜디오 등 공간 중개에 강점'),
  ('kmeetingroom', null, null, null, '회의실 공간 등록 후 게시', '비즈니스 회의실 비교·예약에 강점'),
  ('flowoffice', null, null, null, '공간 제휴 후 등록', '비상주사무실·공유오피스 중개에 강점'),
  ('theowl', null, null, null, '이용 문의·계약 후 입주', '마포·홍대·합정권 공유오피스·회의실 대여에 강점'),
  ('valuevenue', null, null, null, '공간 호스트 등록 후 매칭', '팝업스토어 전문 공간 대여·매칭에 강점'),
  ('modushare', null, null, null, '공간 호스트 등록 후 게시', '팝업·전시·촬영 용도별 공간 매칭에 강점'),
  ('daangn', 'low', '개인 간 직거래는 판매수수료 없음', null, '휴대폰 인증·가입 후 동네 인증', '지역 기반 중고 직거래·동네 커뮤니티에 강점'),
  ('bunjang', 'low', '안전결제 이용 시 결제 수수료 부과', '구매확정 후 정산', '가입 후 상품 등록', '모바일 중고 거래·안전결제에 강점'),
  ('junggonara', null, null, null, '가입 후 카페·앱에서 상품 등록', '대규모 중고 거래 커뮤니티 트래픽에 강점'),
  ('mintit', null, null, null, 'ATM·앱에서 기기 등록 후 매입', '무인 ATM 비대면 중고폰 매입에 강점'),
  ('fongabi', null, null, null, '앱·매장에서 기기 접수 후 매입·판매', '중고폰·태블릿·노트북 매입·시세 비교에 강점'),
  ('charan', null, null, null, '판매 의뢰 후 촬영·판매 대행 위탁', '위탁형 세컨핸드 패션 촬영·판매 대행에 강점'),
  ('marketinu', null, null, null, null, '검수·세탁 수입 빈티지·중고 의류 셀렉션에 강점'),
  ('parabara', null, null, null, '앱 가입 후 자판기 등록·판매', '무인 자판기 기반 비대면 중고거래에 강점'),
  ('kream', 'mid', '판매수수료+검수·배송비 별도', '검수 통과 후 판매자 정산', '개인·사업자 모두 가입 후 판매 입찰 등록', '정품 검수 기반 한정판 스니커즈·명품 리셀에 강점'),
  ('soldout', null, null, '검수 통과 후 정산', '개인·사업자 모두 가입 후 판매 등록', '무신사 연계 한정판 스니커즈·패션 검수 리셀에 강점'),
  ('gugus', null, null, null, '매장 방문·감정 후 매입 또는 위탁 판매', '매장형 감정 기반 중고명품 매입·판매에 강점'),
  ('feelway', null, null, null, '가입 후 중고명품 매물 직접 등록', '대형 중고명품 직거래 매물 규모에 강점'),
  ('koibito', null, null, null, '매입·위탁 접수 또는 가입 후 판매', '매입·위탁·감정 병행 중고명품 거래에 강점'),
  ('mrcamel', null, null, null, '앱 설치 후 매물 검색·감정 이용', '중고명품 통합검색·정가품 감정에 강점'),
  ('apps', null, null, null, '앱 가입 후 판매·수선 의뢰', '명품 수선·쇼핑·판매 결합 리세일에 강점'),
  ('withsellit', null, null, null, '앱 가입 후 판매 접수(컨시어지 대행)', '중고 전자기기 컨시어지 대행 거래에 강점'),
  ('aladin', null, null, null, '가입 후 온·오프라인 중고 매입 신청', '중고 도서·음반·굿즈 매입/판매 인프라에 강점'),
  ('hellomarket', null, null, null, '앱 가입 후 개인 중고 매물 등록', '개인 간 중고거래 모바일 커머스에 강점'),
  ('recl', null, null, null, '앱 가입 후 헌 옷 수거 신청', '간편 수거·리워드형 중고의류 리커머스에 강점'),
  ('newoff', null, null, null, '앱 가입 후 의류 수거 신청', '수거·검수·살균 후 재판매하는 중고의류 커머스에 강점'),
  ('secondsold', null, null, null, '앱 가입 후 매물 탐색(빈티지샵 입점)', '오프라인 빈티지샵 통합 구제 패션 모음에 강점'),
  ('collectiv', null, null, null, '앱 가입 후 프로필·매물 등록', '프리미엄·디자이너 세컨핸드 C2C 거래에 강점'),
  ('fruitsfamily', 'low', '판매수수료 0원 표방', null, '앱 가입 후 매물 등록', '판매수수료 부담 없는 빈티지·세컨핸드 커뮤니티 마켓'),
  ('viver', null, null, '검수 통과 후 정산', '앱 가입 후 시계 매물 등록', '전문가 검수 기반 명품 시계 C2C 거래에 강점'),
  ('chicpap', null, null, null, '앱 가입 후 매물 등록', '커뮤니티 연계 안전결제 중고 명품 거래에 강점'),
  ('npremium', null, null, null, '창작자 채널 개설·승인 후 유료 콘텐츠 발행', '텍스트 유료 구독 콘텐츠 수익화에 강점'),
  ('class101', null, null, null, '크리에이터 지원·심사 후 클래스 개설', '취미·실무 온라인 클래스 제작·판매에 강점'),
  ('brunch', null, null, null, '작가 신청·승인 후 글 발행', '글 창작·작가 브랜딩 플랫폼에 강점'),
  ('youtube', 'mid', '광고수익 약 45% 플랫폼 수취', '애드센스 기준액 도달 시 월 정산', '가입 후 업로드, 수익화는 파트너 조건 충족 필요', '영상 콘텐츠 게시·광고 수익화 도달 규모에 강점'),
  ('inflearn', null, null, null, '지식공유자 신청 후 강의 등록', '개발·디자인·직무 온라인 강의 판매에 강점'),
  ('fastcampus', null, null, null, '수강 결제 후 학습(강의는 협업·제작형)', '직무·부트캠프형 프리미엄 강의 제작에 강점'),
  ('naverwebtoon', null, null, null, '작가 계약·도전만화 등 절차 통해 연재', '웹툰 연재·유료 열람 트래픽 규모에 강점'),
  ('kakaopage', null, null, null, '작가·CP 계약 통해 연재 등록', '웹툰·웹소설 연재·유료 열람 수익화에 강점'),
  ('udemy', null, null, null, '강사 가입 후 강의 제작·등록', '누구나 강의를 파는 글로벌 강의 마켓 도달에 강점'),
  ('edu', null, null, null, '가입 후 실습 강의 수강 또는 개설', '클라우드 실습 기반 IT·코딩 교육에 강점'),
  ('codeit', null, null, null, '구독 결제 후 학습 이용', '구독형 프로그래밍·데이터 강의에 강점'),
  ('nomadcoders', null, null, null, '가입·결제 후 강의 수강', '클론코딩 실전형 개발 강의·챌린지에 강점'),
  ('spartaclub', null, null, null, '수강 신청·결제 후 부트캠프 참여', '부트캠프·입문 코딩 교육에 강점'),
  ('coloso', null, null, null, '강의 결제 후 VOD 수강(강의는 협업·제작형)', '현업 전문가 실무 VOD 강의에 강점'),
  ('liveklass', null, null, null, '크리에이터 가입 후 VOD 강의 개설·판매', '지식 크리에이터 강의 개설·판매 올인원에 강점'),
  ('learnit', null, null, null, '가입·결제 후 강의 수강', '플립러닝 방식 프로그래밍·IT 강의에 강점'),
  ('classu', null, null, null, '크리에이터 지원 후 클래스 개설(수강은 결제)', '취미·실무 온라인 클래스 마켓에 강점'),
  ('bearu', null, null, null, '수강 결제 후 학습 이용', '커리어·실무 온라인 클래스에 강점'),
  ('elice', null, null, null, '가입 후 유료 과정 수강 신청', 'AI 코드 실습 환경 기반 코딩 교육·부트캠프에 강점'),
  ('postype', null, null, null, '가입 후 창작자 등록·콘텐츠 발행', '웹툰·웹소설 등 창작 콘텐츠 유료 판매·후원에 강점'),
  ('ridibooks', null, null, null, '출판사·작가 콘텐츠 공급 계약(독자는 가입 후 구매)', '전자책·웹소설·웹툰 유료 콘텐츠 판매·유통에 강점'),
  ('munpia', null, null, null, '작가 가입 후 연재·유료화 시작', '웹소설 연재·유료화(판타지·무협 등)에 강점'),
  ('joara', null, null, null, '가입 후 자유 연재 시작', '아마추어·프로 웹소설 연재·유료화에 강점'),
  ('novelpia', null, null, null, '작가 가입 후 연재·유료화 시작', '웹소설 연재·선작 기반 수익화에 강점'),
  ('emoticonstudio', null, null, null, '가입 후 제안·심사 통과 시 출시', '카카오톡 이모티콘 제안·출시·판매에 강점'),
  ('toonation', null, null, null, '창작자 가입 후 후원 위젯 연동', '스트리머·창작자 도네이션 수단 통합에 강점'),
  ('fanding', null, null, null, '창작자 가입 후 멤버십 개설', '구독형 창작자 후원·멤버십 운영에 강점'),
  ('twip', null, null, null, '창작자 가입 후 후원 위젯 연동', '스트리머 후원·방송 알림 위젯에 강점'),
  ('sooplive', null, null, null, '가입 후 방송(BJ) 시작', '별풍선 후원 기반 라이브 스트리밍에 강점'),
  ('chzzk', null, null, null, '가입 후 스트리밍 시작(파트너 조건 별도)', '게임 방송 특화 라이브 스트리밍·후원(치즈)에 강점'),
  ('patreon', 'mid', '요금제별 플랫폼 수수료+결제 수수료', null, '창작자 가입 후 멤버십 티어 개설', '정기 구독형 창작자 후원 글로벌 운영에 강점'),
  ('welaaa', null, null, null, '가입 후 월 구독(청취자 대상)', '오디오북·강연 구독형 청취에 강점'),
  ('millie', null, null, null, '가입 후 월 구독', '전자책·오디오북 무제한 구독 독서에 강점'),
  ('podbbang', null, null, null, '가입 후 채널 개설·에피소드 업로드', '팟캐스트 배포·후원·광고 수익화에 강점'),
  ('audioclip', null, null, null, '채널 개설 후 오디오 콘텐츠 등록', '오디오북·팟캐스트 등 오디오 콘텐츠 유통에 강점'),
  ('mildang', null, null, null, '가입 후 수강 신청(학생 대상)', 'AI 분석 맞춤 1:1 온라인 과외에 강점'),
  ('kr3', null, null, null, '앱 설치 후 가입·수강', 'AI 적응형 토익 점수 예측·학습에 강점'),
  ('yanadoo', null, null, null, '가입 후 강의 구매·수강', '하루 10분 습관형 영어회화 학습에 강점'),
  ('siwonschool', null, null, null, '가입 후 강의 구매·수강', '영어·제2외국어 기초 인강에 강점'),
  ('hackers', null, null, null, '가입 후 강의 수강(무료 자료 제공)', '토익·토플 등 어학시험 대비 강의에 강점'),
  ('eduwill', null, null, null, '가입 후 강의 수강', '공인중개사·공무원·자격증 시험 대비에 강점'),
  ('megastudy', null, null, null, '가입 후 강의 수강', '수능·대입 고등 인강에 강점'),
  ('etoos', null, null, null, '가입 후 강의 수강·프리패스 구독', '고등 대입 온라인 강의에 강점'),
  ('classting', null, null, null, '교사·학생·학부모 가입 후 학급 개설·참여', '학급 소통·관리와 AI 개인화 학습에 강점'),
  ('tutoring', null, null, null, '앱 설치 후 가입·수업권 구매', '24시간 1:1 원어민·AI 영어회화에 강점'),
  ('stibee', null, null, null, '가입 후 뉴스레터 발행·구독자 관리', '국내 뉴스레터 발행·유료 구독 운영에 강점'),
  ('maily', null, null, null, '가입 후 뉴스레터 발행·유료 멤버십 개설', '뉴스레터 기반 유료 콘텐츠 수익화에 강점'),
  ('airklass', null, null, null, '강사 가입 후 클래스 개설·판매', '누구나 온라인 강의 개설·판매에 강점'),
  ('typecast', null, null, null, '가입 후 바로 사용(무료 체험 제공)', '감정 표현 TTS로 AI 성우 음성 생성에 강점'),
  ('pozalabs', null, null, null, '문의·구독 후 음원 이용', '저작권 이슈 없는 AI 배경음악 제작·유통에 강점'),
  ('britg', null, null, null, '작가 가입 후 자유 연재·유료 판매', '장르 구분 없는 중·장편 소설 연재·판매에 강점'),
  ('ctee', 'low', '플랫폼 수수료 0%(결제 수수료 별도)', null, '창작자 가입 후 멤버십·후원 개설', '수수료 0% 창작자 멤버십·후원·상품 판매에 강점'),
  ('fancimm', null, null, null, '창작자 가입 후 팬 후원·굿즈 개설', '크리에이터·팬 1:1 비공개 소통·굿즈 중개에 강점'),
  ('litt', null, null, null, '가입 후 프로필 링크 페이지 생성(무료 시작)', '링크 정리에 후원·커머스 등 크리에이터 수익화 결합'),
  ('carat', null, null, null, '가입 후 바로 사용(무료 체험 대개 제공)', '대화형으로 텍스트·이미지·영상·오디오 통합 생성'),
  ('gazet', null, null, null, '가입 후 바로 사용(무료 체험 대개 제공)', '한국어 블로그·광고 카피 문장 자동 생성에 특화'),
  ('musia', null, null, null, '가입 후 바로 사용(무료 체험 대개 제공)', '음악 지식 없이 AI로 작곡·편집'),
  ('fikad', null, null, null, '가입 후 바로 사용(무료 체험 대개 제공)', '긴 영상을 AI가 숏폼으로 자동 제작'),
  ('toonda', null, null, null, '가입 후 바로 사용(무료 체험 대개 제공)', '웹툰 글·그림 콘티·식자 작업 지원'),
  ('ploonet', null, null, null, '가입 후 사용(요금제·문의형 혼재)', '가상인간 기반 대화형 AI 영상 제작'),
  ('zigzag', 'mid', null, null, '사업자등록·통신판매업 신고 후 입점 신청', '여성 패션 큐레이션·영상쇼핑에 강점'),
  ('ably', 'low', null, null, '사업자등록·통신판매업 신고 후 입점 신청', '여성 의류·잡화 셀러 입점형 마켓에 강점'),
  ('musinsa', 'high', null, null, '브랜드 입점 심사·계약 후 판매', '패션·스니커즈·뷰티 브랜드 집객에 강점'),
  ('wconcept', null, null, null, '브랜드 입점 심사·계약 후 판매', '디자이너·컨템포러리 패션 편집 큐레이션'),
  ('brandi', null, null, null, '사업자등록·통신판매업 신고 후 입점 신청', '모바일 여성 패션 셀러 입점형 마켓'),
  ('29cm', null, null, null, '브랜드 입점 심사·계약 후 판매', '감도 높은 패션·라이프스타일 편집 큐레이션'),
  ('queenit', null, null, null, '사업자등록·통신판매업 신고 후 입점 신청', '4050 여성 타깃 패션 버티컬에 강점'),
  ('posty', null, null, null, '브랜드 입점 심사·계약 후 판매', '4050 세대 백화점·명품 패션에 강점'),
  ('asler', null, null, null, '사업자등록·통신판매업 신고 후 입점 신청', '4050 시니어 남성 패션 타깃에 특화'),
  ('lookpin', null, null, null, '사업자등록·통신판매업 신고 후 입점 신청', '남성 코디 추천 기반 종합 패션 커머스'),
  ('mustit', null, null, null, '사업자등록·통신판매업 신고 후 입점 신청', '온라인 명품 중개·거래에 특화'),
  ('trenbe', null, null, null, '사업자등록·통신판매업 신고 후 입점 신청', '자체 감정·풀필먼트 갖춘 명품 커머스'),
  ('balaan', null, null, null, '사업자등록·통신판매업 신고 후 입점 신청', '온라인 명품 커머스에 강점'),
  ('oliveyoung', null, null, null, '브랜드 입점 제안·심사 후 매입/입점', '뷰티·헬스 상품, 오프라인 연계 온라인몰'),
  ('hwahae', null, null, null, '브랜드 입점 제안·심사 후 판매', '성분·리뷰 기반 화장품 커머스에 강점'),
  ('aprin', null, null, null, null, '메디큐브 등 뷰티테크 D2C 자사몰 운영'),
  ('kurly2', null, null, null, '입점 제안·심사 후 매입/입점', '뷰티 상품 새벽배송에 강점'),
  ('halfclub', null, null, null, '브랜드 입점 제안·심사 후 판매', '패션 브랜드 상품 아울렛형 종합몰'),
  ('fashionplus', null, null, null, '브랜드 입점 제안·심사 후 판매', '수천 브랜드 아울렛형 패션 종합몰'),
  ('jkids', null, null, null, '사업자등록·통신판매업 신고 후 입점 신청', '아동복 전문 키즈 패션에 특화'),
  ('moomooz', null, null, null, '사업자등록·통신판매업 신고 후 입점 신청', '키즈 패션·패밀리 라이프스타일 편집샵'),
  ('mami', null, null, null, '사업자등록·통신판매업 신고 후 입점 신청', '아동복·육아용품·엄마 패션 통합'),
  ('stylebiggirl', null, null, null, '사업자등록·통신판매업 신고 후 입점 신청', '여성 빅사이즈 의류 전문에 특화'),
  ('lalaswan', null, null, null, '사업자등록·통신판매업 신고 후 입점 신청', '여성 플러스사이즈 의류 전문에 특화'),
  ('bigmom', null, null, null, '사업자등록·통신판매업 신고 후 입점 신청', '중년 여성 체형커버 빅사이즈 의류'),
  ('venuseshop', null, null, null, null, '여성 속옷·언더웨어 전문에 특화'),
  ('dorosiwa', null, null, null, null, '여성 언더웨어 공식몰'),
  ('rounz', null, null, null, '사업자등록·통신판매업 신고 후 입점 신청', '가상피팅·얼굴형 추천 안경 쇼핑에 강점'),
  ('breezm', null, null, null, null, '3D 스캔·프린팅 개인 맞춤 아이웨어에 강점'),
  ('amondz', null, null, null, null, '주얼리·액세서리 브랜드 편집 큐레이션에 강점'),
  ('goldria', null, null, null, null, '14k·18k 금 주얼리 전문에 강점'),
  ('monthlycosmetics', null, null, null, null, '맞춤 화장품 정기배송 구독에 강점'),
  ('toun28', null, null, null, null, '피부 진단 기반 맞춤 화장품 구독에 강점'),
  ('memebox', null, null, null, null, '화장품 종합 셀렉션·자체 브랜드에 강점'),
  ('laka', null, null, null, null, '젠더 뉴트럴 메이크업 브랜드에 강점'),
  ('bgroom', null, null, null, null, '남성 전문 뷰티 셀렉션에 강점'),
  ('groominglab', null, null, null, null, '남성 헤어·바디 그루밍 케어에 강점'),
  ('shoeprize', null, null, null, null, '한정판 스니커즈 발매 정보에 강점'),
  ('09women', null, null, null, null, '빅사이즈 여성의류 전문에 강점'),
  ('stylebot', null, null, null, '가입 후 바로 사용(무료 체험 대개 제공)', 'AI 옷장 분석·코디 추천에 강점'),
  ('vinzip', null, null, null, null, '국내외 브랜드 빈티지 구제 셀렉션에 강점'),
  ('tomovintage', null, null, null, null, '일본 구제 다량 신상 업데이트에 강점'),
  ('vintageone', null, null, null, null, '수입 브랜드 빈티지 구제에 강점'),
  ('vintagezet', null, null, null, null, '상태 좋은 빈티지 신발 전문에 강점'),
  ('deadstock', null, null, null, null, '해외 브랜드 수입 빈티지 정품에 강점'),
  ('worknwalk', null, null, null, null, '워크웨어·아메카지 스타일에 강점'),
  ('drvintage', null, null, null, null, '아메카지·워크웨어 온·오프 편집에 강점'),
  ('bluesman', null, null, null, null, '아메리칸 캐주얼 남성의류에 강점'),
  ('outdoorfeel', null, null, null, null, '수입 아웃도어 브랜드 셀렉션에 강점'),
  ('vegantigerkorea', null, null, null, null, '동물성 소재 배제 비건 패션에 강점'),
  ('bbybstore', null, null, null, null, '페이크 레더 비건 가방·액세서리에 강점'),
  ('lotuff', null, null, null, null, '국내 가죽 백팩·토트백 제작에 강점'),
  ('camelbrown', null, null, null, null, '여성 프리미엄 백팩·토트백에 강점'),
  ('soulbag', null, null, null, null, '여성 가죽가방·크로스백에 강점'),
  ('prettica', null, null, null, null, '데일리 실버 핸드메이드 주얼리에 강점'),
  ('dianajewelry', null, null, null, null, '실버925 원석 핸드메이드 주얼리에 강점'),
  ('hangleeyewear', null, null, null, null, '선글라스·블루라이트 안경 자체 제작에 강점'),
  ('2eyeshop', null, null, null, null, '자체 하우스 브랜드 안경·선글라스에 강점'),
  ('dongneoo', null, null, null, null, '정품 아이웨어 선글라스 셀렉션에 강점'),
  ('elleinnerwear', null, null, null, null, '엘르 라이선스 이너웨어 공식 판매에 강점'),
  ('sockstaz', null, null, null, null, '양말 중심 라이프스타일 소품에 강점'),
  ('customsoxx', null, null, null, null, '디자인·주문제작 커스텀 양말에 강점'),
  ('leesle', null, null, null, null, '현대적으로 재해석한 모던 한복에 강점'),
  ('wayyu', null, null, null, null, '전통·캐주얼 접목 생활한복 브랜드 자사몰'),
  ('thegoeun', null, null, null, null, '인사동 기반 생활한복 브랜드몰'),
  ('byatti', null, null, null, null, '생활한복 전문 온라인몰'),
  ('philosophia', null, null, null, null, '여성 요가·필라테스 애슬레저 특화'),
  ('conch', null, null, null, null, '필라테스·요가 레깅스 등 피트니스웨어 특화'),
  ('kurly', null, null, null, '사업자등록 후 상품 제안·입점 심사', '신선식품 새벽배송·큐레이션 상품 구성'),
  ('oasis', null, null, null, '사업자등록 후 입점 제안·심사', '친환경 신선식품 새벽배송'),
  ('jeongyukgak', null, null, null, null, '초신선 육류 직판·정기배송'),
  ('cookatmarket', null, null, null, null, '간편식·디저트 트렌드 식품 특화'),
  ('yamtable', null, null, null, null, '수산물 중심 온라인 식품 마켓'),
  ('choroc', null, null, null, null, '친환경·유기농 먹거리 매장+온라인'),
  ('jungoneshop', null, null, null, null, '대상그룹 식품 공식 직영몰'),
  ('mart', null, null, null, '외식 사업자 가입 후 이용', '외식 사장님용 식자재·부자재 B2B 장보기'),
  ('freshcode', null, null, null, null, '샐러드·건강간편식 정기배송'),
  ('greating', null, null, null, null, '건강·케어 식단 정기배송(현대그린푸드)'),
  ('shop', null, null, null, '생협 조합원 가입 후 이용', '한살림 조합 친환경 식품 장보기'),
  ('icoop', null, null, null, '생협 조합원 가입 후 이용', '유기농·공정무역 생협 식품'),
  ('boratr', null, null, null, null, '수입 식품·식자재 유통·판매'),
  ('sooldamhwa', null, null, null, '성인 인증 후 구독 신청', '전통주 큐레이션 정기구독'),
  ('purpledog', null, null, null, '성인 인증 후 구독 신청', '취향 분석 맞춤 와인 정기구독'),
  ('thebanchan', null, null, null, null, '당일조리 반찬·국·밀키트 새벽배송'),
  ('zipbanchan', null, null, null, null, '가정식 수제반찬 주문 배송'),
  ('thesoban', null, null, null, null, '셰프 가정식 수제반찬 정기배송'),
  ('laclachansang', null, null, null, null, '반찬·국·메인 가정식 정기배송'),
  ('homebabs', null, null, null, null, '주간 식단 반찬 정기배송 구독'),
  ('farmmorning', null, null, null, '농민(생산자) 가입 후 판매·이용', '농민 직거래·영농 지원 결합'),
  ('marketsoo', null, null, null, '사업자·산지 판매자 입점', '농수축산 산지직송 직거래'),
  ('sanjicook', null, null, null, '사업자등록·통신판매 신고 후 입점', '검증 농수산물 산지직송 오픈마켓'),
  ('unclemart', null, null, null, null, '농·축·수산 산지직송 전문 마켓'),
  ('fishsale', null, null, null, null, '국내산 수산물 전문 온라인몰'),
  ('farmmate', null, null, null, '생산 농가 가입 후 직거래 판매', '친환경 농산물 생산자 직거래'),
  ('nhlocalfood', null, null, null, '지역 농가(조합원) 등록 후 출하', '지역 농산물 로컬푸드 직매장'),
  ('marcheat', null, null, null, null, '농부·요리사·수공예 도시형 장터'),
  ('meatbox', null, null, null, '사업자등록 후 판매자·구매자 가입', '축산물 직거래·도매 가격 비교'),
  ('permeal', null, null, null, null, '산지 식재료·밀키트 큐레이션'),
  ('youngbakery', null, null, null, '사업자등록·통신판매업 신고 후 입점(자사몰형)', '빵 정기배송 구독에 강점'),
  ('hyfresh', null, null, null, 'hy 운영 자사몰 — 일반 이용은 가입 후 바로', '국·탕·밀키트 등 신선식품 정기구독에 강점'),
  ('fresheasy', null, null, null, '자사 브랜드몰 — 이용은 가입 후 바로', '밀키트·HMR 간편식 전문에 강점'),
  ('soolmarket', null, null, null, '주류 판매는 면허·전통주 요건 필요', '전국 양조장 전통주 큐레이션에 강점'),
  ('soollove', null, null, null, '주류 판매는 면허·전통주 온라인판매 요건 필요', '전통주 전문 온라인 판매에 강점'),
  ('business', null, null, null, '주류 도매 — 사업자·주류 면허 확인 후 거래', '주류 도매 발주·와인 유통 B2B 중개에 강점'),
  ('roout', null, null, null, '농어민 판매자·소비자 가입 후 이용', '농수산물 산지 직거래 연결에 강점'),
  ('oraund', null, null, null, '자사 로스터리몰 — 이용은 가입 후 바로', '당일 로스팅 스페셜티 원두·드립백에 강점'),
  ('unspecialty', null, null, null, '로스터리 입점형 — 사업자등록·통신판매업 신고 필요', '여러 로스터리 원두 모음 큐레이션에 강점'),
  ('180coffee', null, null, null, '자사 로스터리몰 — 이용은 가입 후 바로', '국가대표 로스터 운영 스페셜티 원두에 강점'),
  ('altdif', null, null, null, '자사 브랜드몰 — 이용은 가입 후 바로', '시그니처 블렌딩 티·라이프스타일에 강점'),
  ('lookourtea', null, null, null, '자사 브랜드몰 — 이용은 가입 후 바로', '블렌딩 티 전문에 강점'),
  ('zzann', null, null, null, '주류 판매는 면허·전통주 요건 필요', '막걸리·약주·리큐르 전통주 직거래에 강점'),
  ('mewolmejoo', null, null, null, '주류 판매는 면허·전통주 온라인판매 요건 필요', '전통주 구독·선물세트 허브에 강점'),
  ('lovinghut', null, null, null, '자사 브랜드몰 — 이용은 가입 후 바로', '식물성 대체육·비건 간편식에 강점'),
  ('hanggi', null, null, null, '자사몰형 — 이용은 가입 후 바로', '대체육·대체해산물 비건 식품에 강점'),
  ('vegemom', null, null, null, '자사몰형 — 이용은 가입 후 바로', '비건 식품·조미료 채식 전문에 강점'),
  ('calobye', null, null, null, 'D2C 자사몰 — 이용은 가입 후 바로', '프로틴 음료·다이어트 식품 D2C에 강점'),
  ('dshop', null, null, null, '자사몰형 — 이용은 가입 후 바로', '단백질·다이어트 식품 전문에 강점'),
  ('granola', null, null, null, '자사몰형 — 이용은 가입 후 바로', '그래놀라·뮤즐리 등 건강간식 모음에 강점'),
  ('kihya', null, null, null, '주류 스마트오더 앱 — 가입 후 이용, 픽업은 매장 수령', '위스키·와인 가격비교·스마트오더에 강점'),
  ('idus', 'mid', '판매수수료+결제수수료 구조', null, '작가 가입·심사 후 작품 등록(개인·사업자)', '수공예 작가 마켓·핸드메이드 유통에 강점'),
  ('10x10', null, null, null, '사업자등록·통신판매업 신고 후 입점 제안', '디자인 문구·잡화 편집 큐레이션에 강점'),
  ('handmadeo', null, null, null, '메이커 가입 후 프로필·작품 등록', '메이커-소비자 관계지향 핸드메이드에 강점'),
  ('handion', null, null, null, '작가 가입 후 작품 등록(개인·사업자)', '수공예 액세서리·홈데코 오픈마켓에 강점'),
  ('youarehandmade', null, null, null, '작가 가입 후 작품 등록', '작가 수공예 작품 판매에 강점'),
  ('thehandz', null, null, null, '작가 가입 후 완제품·DIY 재료 등록', '수공예 완제품·DIY 재료 포털에 강점'),
  ('twenty', null, null, null, '작가 가입 후 굿즈 등록', '일러스트 스티커·다이어리 굿즈에 강점'),
  ('etsy', 'mid', '리스팅+거래+결제 수수료 혼합', null, '판매자 등록·상점 개설 후 상품 리스팅', '글로벌 핸드메이드·빈티지 해외판매에 강점'),
  ('amazon', 'mid', '판매수수료(리퍼럴) 기반', null, '메이커 심사·프로 셀러 계정 후 판매', '아마존 트래픽 기반 수제상품 판매에 강점'),
  ('folksy', null, null, null, '영국 기반 — 판매자 등록·상점 개설 후 리스팅', '영국 핸드메이드 공예품 판매에 강점'),
  ('wooddle', null, null, null, '가입 후 취미·핸드메이드 활동 매칭', '취미·핸드메이드 활동 매칭에 강점'),
  ('saramin', null, null, null, '기업 회원가입 후 채용공고 등록', '정규·경력직 채용 매칭에 강점'),
  ('jobkorea', null, null, null, '기업 회원가입 후 채용공고 등록', '종합 채용 정보·구인구직에 강점'),
  ('albamon', null, null, null, '사업자·개인 고용주 가입 후 공고 등록', '아르바이트·단기 일자리 중개에 강점'),
  ('alba', null, null, null, '기업·개인 가입 후 공고 등록·이력서 지원', '단기·아르바이트 구인구직에 강점'),
  ('coupangflex', null, null, null, '앱 가입·자차 등록 후 배송 시작', '자차 활용 개인 배송 부업에 적합'),
  ('baeminconnect', null, null, null, '앱 가입·교육 이수 후 배달 시작', '도보·자전거·차량 배달 부업에 적합'),
  ('wanted2', null, null, null, '가입 후 프로필·이력서 등록', 'IT·개발 직군 채용과 지인추천에 강점'),
  ('incruit', null, null, null, '가입 후 이력서 등록·공고 지원', '종합 채용공고·기업정보 탐색에 강점'),
  ('rocketpunch', null, null, null, '가입 후 프로필 등록·공고 지원', '스타트업 채용·비즈니스 네트워킹에 강점'),
  ('career', null, null, null, '리멤버 가입·명함 등록 후 프로필 공개', '경력직 스카우트 제안 수신에 강점'),
  ('catch', null, null, null, '가입 후 채용 일정·기업정보 이용', '대기업·공채 일정·기업분석 정보에 강점'),
  ('jobplanet', null, null, null, '가입 후 리뷰·공고 열람·지원', '기업 리뷰·연봉 정보 탐색에 강점'),
  ('peoplenjob', null, null, null, '가입 후 이력서 등록·공고 지원', '외국계·헤드헌팅 채용에 특화'),
  ('gubgoo', null, null, null, '앱 가입 후 실시간 매칭·근무', '당일·단기 알바 실시간 매칭에 강점'),
  ('barogo', null, null, null, '라이더 가입·등록 후 배차 수행', '라이더·상점 배달대행 연결에 강점'),
  ('work', null, null, null, '가입 후 구인·구직 등록(공공 서비스)', '공공 구인구직·고용서비스 통합 이용에 강점'),
  ('findjob', null, null, null, '가입 후 공고 등록·구직 열람', '지역 생활밀착 알바·구인구직에 강점'),
  ('newworker', null, null, null, '가입 후 프로필 등록·프로젝트 지원', '긱워커 프로젝트 매칭·정산 지원에 강점'),
  ('specter', null, null, null, '기업 가입 후 평판조회 요청', '지원자 평판조회·인재 검증에 특화'),
  ('attalework', null, null, null, '가입 후 프로필 등록·매칭', '중장년·시니어 전문가 채용 매칭에 특화'),
  ('senior', null, null, null, '가입 후 진단·구직·교육 이용', '중장년 취업 진단·구직·교육 지원에 강점'),
  ('woodel', null, null, null, '앱 가입 후 도보 배달 수행', '도보 근거리 배달 부업에 적합'),
  ('codingvalley', null, null, null, '가입 후 바로 수강(모바일 학습)', '직장인 AI 활용·코딩 학습에 강점'),
  ('epop', null, null, null, '가입 후 바로 학습(무료 체험 제공)', 'AI 기반 영어 단어·회화 학습에 강점'),
  ('argong', null, null, null, '가입 후 학습 시작', '초등 영어·수학 AI 맞춤 학습에 강점'),
  ('tiokorea', null, null, null, '가입 후 바로 사용', 'AI 자소서·면접 준비 지원에 강점'),
  ('haijob', null, null, null, '가입 후 바로 사용', '직무진단·자소서·면접 준비 통합 지원'),
  ('naim', null, null, null, '가입 후 바로 사용', '경험 데이터 기반 자소서 작성·검증 지원'),
  ('groupby', null, null, null, '가입 후 채용공고·인사이트 열람', '스타트업 채용공고·취업 인사이트 큐레이션'),
  ('dio', null, null, null, '기업 가입 후 구독형 인재 매칭', '검증된 경력직 구독형 매칭에 강점'),
  ('1gada', null, null, null, '앱 가입 후 현장·근로자 실시간 매칭', '건설 일용직·현장 실시간 인력 매칭에 강점'),
  ('kowork', null, null, null, '가입 후 프로필 등록·매칭', '외국인 구직자·기업 매칭과 비자 정보에 강점'),
  ('workwiz', null, null, null, '가입 후 프로필 등록·매칭·코칭', '중장년 재취업 매칭·컨설팅에 특화'),
  ('miso', null, null, null, '앱 가입 후 서비스 예약·이용', '가사·청소·이사 등 홈서비스 매칭에 강점'),
  ('cleanlab', null, null, null, '앱 가입 후 서비스 예약·이용', '정기·가사 홈클리닝 매칭에 강점'),
  ('daerijubu', null, null, null, '앱 가입 후 서비스 예약·이용', '가사·돌봄 도우미 중개에 강점'),
  ('jjakkak', null, null, null, '앱 가입 후 돌봄 선생님 예약', '아이 돌봄·놀이 선생님 매칭에 특화'),
  ('homemaster', null, null, null, '앱 가입 후 서비스 예약·이용', '가사·청소 도우미 예약 매칭에 강점'),
  ('getwashswat', null, null, null, '앱 가입 후 수거 신청; 세탁 파트너는 제휴 심사', '비대면 수거·배송 세탁에 강점'),
  ('laundrygo', null, null, null, '앱 가입 후 문앞 수거 신청; 세탁 파트너 제휴', '수거·배송+수선 원스톱 세탁에 강점'),
  ('apps2', null, null, null, '가입 후 헬퍼·요청자 모두 이용; 헬퍼는 프로필 등록', '심부름·배달 실시간 매칭에 강점'),
  ('apps3', null, null, null, '가입 후 요청 등록; 수행자는 프로필·인증 후 활동', '다목적 생활 심부름 매칭에 강점'),
  ('zipdoc', null, null, null, '시공사는 파트너 등록·심사 후 견적 참여', '인테리어 비교견적·시공 중개에 강점'),
  ('houstep', null, null, null, '소비자는 표준 견적 신청; 시공팀은 파트너 등록', '도배·마루·창호 표준 견적 시공에 강점'),
  ('apps4', null, null, null, '앱 가입 후 출장 세차 예약', '방문 프리미엄 출장 세차에 강점'),
  ('wayopet', null, null, null, '가입 후 예약; 펫시터는 프로필·인증 후 활동', '펫 방문 돌봄·산책 예약에 강점'),
  ('dogmate', null, null, null, '가입 후 예약; 펫시터는 프로필·인증 후 활동', '반려동물 방문 돌봄·산책 매칭에 강점'),
  ('mogwai', null, null, null, '가입 후 예약; 펫시터는 프로필·인증 후 활동', '펫시터 방문 돌봄 예약에 강점'),
  ('petplanet', null, null, null, '가입 후 예약; 펫시터는 프로필·인증 후 활동', '펫 위탁·방문 돌봄 연결에 강점'),
  ('jaranda', null, null, null, '학부모 가입 후 매칭; 선생님은 프로필·인증 등록', '아이 놀이·학습 돌봄 매칭에 강점'),
  ('momsitter', null, null, null, '가입 후 매칭; 시터는 프로필·인증 후 활동', '베이비시터·아이돌보미 매칭에 강점'),
  ('zimssa', null, null, null, '앱으로 견적 신청; 이사·청소 업체는 파트너 등록', '포장이사·입주청소 견적 비교에 강점'),
  ('24mall', null, null, null, '소비자는 견적 신청; 이삿짐센터는 파트너 등록', '포장이사 견적 실시간 비교에 강점'),
  ('modoo24', null, null, null, '소비자는 견적 신청; 허가 이사업체 파트너 등록', '후기 기반 이사·입주청소 매칭에 강점'),
  ('hcmaster', null, null, null, '방문 소독·방역 서비스 예약 신청', '소독·방역·해충방제 홈케어에 강점'),
  ('hscare', null, null, null, '방문 분해 세척 서비스 예약 신청', '가전·매트리스 분해 세척 홈케어에 강점'),
  ('yper', null, null, null, '앱 가입 후 출장 세차 예약', '수거-손세차-배달 원스톱 세차에 강점'),
  ('kimzipsa', null, null, null, '입주 아파트 단지에서 앱 가입 후 이용', '아파트 상주형 배달·심부름 대행에 강점'),
  ('bosalpim', null, null, null, '기관·보호자 가입 후 매칭; 요양보호사 등록', '시니어 돌봄 인력·기관 매칭에 강점'),
  ('forparents', null, null, null, '보호자 가입 후 예약; 케어 인력 등록·교육', '어르신 동행 나들이·생활 돌봄에 강점'),
  ('sinor', null, null, null, '가입 후 이용(전화·앱 기반)', '5070 시니어 비대면 말벗·매칭에 강점'),
  ('petbom', null, null, null, '가입 후 예약; 돌봄님은 프로필·인증 후 활동', '하이퍼로컬 이웃 펫 방문 돌봄에 강점'),
  ('hisitter', null, null, null, '회원제 가입 후 매칭; 시터는 인증 후 활동', '영유아 풀타임 가정 방문 돌봄에 강점'),
  ('woowarhanclean', null, null, null, '무료 견적 신청 후 방문 서비스 예약', '정리수납·집정리 컨설팅에 강점'),
  ('aftermoving', null, null, null, '방문 견적 신청 후 정리 서비스 예약', '이사 전후 짐 정리·정리수납에 강점'),
  ('verygoodlife', null, null, null, '방문 컨설팅·교육 신청', '가정·상업 공간 정리수납 컨설팅·교육에 강점'),
  ('covering', null, null, null, '앱으로 폐기물 방문 수거 신청', '생활 쓰레기·폐기물 방문 수거에 강점'),
  ('sgin', null, null, null, '현장·기술자 가입 후 지역·시간 기준 매칭', '인테리어 시공 인력 지역 매칭에 강점'),
  ('cleanbell', null, null, null, '소비자는 견적 신청; 청소업체는 파트너 등록', '입주·이사청소 업체 견적 비교에 강점'),
  ('archisketch', null, null, null, '가입 후 3D 인테리어 도구 사용', '3D 인테리어·가구배치 시뮬레이션에 강점'),
  ('zigbang', null, null, null, '중개사무소는 제휴 가입 후 매물 등록', '원룸·오피스텔 등 주거 매물 탐색에 강점'),
  ('dabang', null, null, null, '중개사무소는 제휴 가입 후 매물 등록', '주거용 매물 정보 탐색에 강점'),
  ('naverland', null, null, null, '중개사무소는 제휴 채널로 매물 등록', '종합 매물·시세 정보 집약에 강점'),
  ('rsquare', null, null, null, '임차 상담·문의 후 매물 제안(B2B 중개형)', '상업용 오피스 임대·사옥 이전 중개에 강점'),
  ('ziptoss', null, null, null, '앱 가입 후 매물 검색·중개 문의', '전월세 직영 중개·수수료 절감형에 강점'),
  ('nemoapp', null, null, null, '가입 후 매물 검색, 중개사 매물 등록', '상가·사무실 상업용 임대매물 검색에 강점'),
  ('peterpanz', null, null, null, '가입 후 매물 검색·직거래 등록', '원룸·투룸 직거래·커뮤니티 매물에 강점'),
  ('hogangnono', null, null, null, '가입 후 바로 이용(시세 조회)', '실거래가 기반 아파트 시세·비교에 강점'),
  ('asil', null, null, null, '가입 후 바로 이용(시세·분석 조회)', '아파트 실거래가·단지 비교·투자 분석에 강점'),
  ('disco', null, null, null, '가입 후 바로 이용(지도 조회)', '토지·빌딩·상가 실거래가·등기 조회에 강점'),
  ('valueupmap', null, null, null, '가입 후 바로 이용(지도 조회)', '토지·건물·공장 실거래가·매물 지도에 강점'),
  ('bdsplanet', null, null, null, '가입 후 바로 이용(실거래가 조회)', '실거래가·건물 노후도 분석에 강점'),
  ('r114', null, null, null, '가입 후 바로 이용(시세·분양 조회)', '아파트·상가 시세·분양 데이터에 강점'),
  ('kbland', null, null, null, '가입 후 바로 이용(시세 조회)', 'KB 시세 기반 시세·대출 기준 정보에 강점'),
  ('smatch', null, null, null, '임차 문의·상담, 중개사 매물 등록', '사무실·상가·빌딩 상업용 임대매매 중개에 강점'),
  ('officefind', null, null, null, '임차 상담·문의 후 오피스 제안', '데이터 기반 오피스 임대·이전 컨설팅에 강점'),
  ('fastfive', null, null, null, '투어·문의 후 멤버십 계약·입주', '다지점 공유오피스·입주 편의에 강점'),
  ('sparkplus', null, null, null, '투어·문의 후 멤버십 계약·입주', '역세권 사무 특화 공유오피스에 강점'),
  ('wework', null, null, null, '투어·문의 후 멤버십 계약·입주', '글로벌 네트워크 공유 업무공간에 강점'),
  ('regus', null, null, null, '문의·계약 후 이용', '글로벌 서비스드 오피스·비상주 사무실에 강점'),
  ('wecook', null, null, null, '문의·계약 후 입주', '제조·배달형 공유주방 공간 임대에 강점'),
  ('nanudakitchen', null, null, null, '상권 상담·문의 후 입점 계약', '상권분석 기반 공유주방 중개에 강점'),
  ('jisanlive', null, null, null, '가입 후 매물 검색·문의', '지식산업센터·상가·창고 임대매매 정보에 강점'),
  ('jumpapp', null, null, null, '분양·임차 문의 후 매물 제안(중개형)', '지식산업센터·오피스 분양·임대 중개에 강점'),
  ('myfranchise', null, null, null, '가입 후 바로 이용(비교·분석 조회)', '프랜차이즈 창업비용·매출 비교·상권분석에 강점'),
  ('openub', null, null, null, '가입 후 상권 데이터 조회', '빅데이터 기반 AI 상권분석에 강점'),
  ('auction1', null, null, null, '가입·구독 후 경매 정보·교육 이용', '법원경매·부동산경매 정보·교육에 강점'),
  ('ggi', null, null, null, '가입·구독 후 경매 정보 이용', '법원경매·공매 정보·권리분석에 강점'),
  ('dooinauction', null, null, null, '가입·구독 후 경매 정보 이용', '경매·공매·NPL 권리분석 정보에 강점'),
  ('thecomenstay', null, null, null, '가입 후 검색·입주 문의', '월 단위 청년 셰어하우스 검색·운영에 강점'),
  ('gobang', null, null, null, '앱 가입 후 검색·매칭 이용', '원룸텔·셰어하우스·룸메이트 매칭에 강점'),
  ('gosi1', null, null, null, '가입 없이 검색·문의 이용', '고시원·고시텔·원룸텔 검색 정보에 강점'),
  ('drapt', null, null, null, '가입 후 시세·분양 정보 조회', '아파트 시세·분양·재건축 정보에 강점'),
  ('bbric', null, null, null, '앱 가입·투자자 인증 후 이용(신생)', '상업용 부동산 조각투자 플랫폼(규제샌드박스 신생)'),
  ('naezipscan', null, null, null, '가입 후 진단 신청(신생 서비스)', 'AI 등기부·임대인 분석 전세사기 위험 진단에 강점'),
  ('zippoom', null, null, null, '가입 후 리뷰·리포트 조회(신생)', '실거주 리뷰·보증금 위험 분석 리포트에 강점'),
  ('dizo', null, null, null, '가입 후 이용, 중개사 마이페이지 등록(신생)', '주거·상업용 부동산 데이터·중개사 도구에 강점'),
  ('arcadegod', null, null, null, '가입 후 매물 검색·문의', '상가 분양·임대·매매 매물 비교에 강점'),
  ('sangga114', null, null, null, '분양·중개 사업자 상가 매물 제휴 등록', '신규 상가 분양 정보 탐색에 강점'),
  ('imya', null, null, null, '공인중개사·소유주 임야 매물 등록', '임야·산지 경사도·도로 등 조건 확인에 강점'),
  ('imya4989', null, null, null, '공인중개사·소유주 임야 매물 등록', '임야·산지 매매 매물 집중에 강점'),
  ('ddangya', null, null, null, '가입 후 조회, 매물 등록은 사업자 문의', '전국 토지 실거래가 조회·비교에 강점'),
  ('zoomansa', null, null, null, '주차공간 소유주 등록·이용자 앱 가입', '유휴 주차공간 월·일주차 중개에 강점'),
  ('bunyangi', null, null, null, '가입 후 분양·청약 정보 열람', '신규 아파트 분양·청약 일정 정리에 강점'),
  ('gfauction', null, null, null, '가입 후 이용, 유료 정보 구독형', '경매 AI 권리분석·낙찰 통계 제공에 강점'),
  ('seeauction', null, null, null, '가입 후 이용, 유료 정보 구독형', '법원경매·공매 권리분석 정보 제공에 강점'),
  ('zipgoai', null, null, null, '가입 후 이용, 유료 정보 구독형', '경·공매·NPL 물건 AI 분석에 강점'),
  ('building0', null, null, null, '가입 후 조회, 매물은 사업자 제휴 등록', '중소형·꼬마빌딩 실거래가 지도 조회에 강점'),
  ('buildingmeme', null, null, null, '공인중개사·소유주 빌딩 매물 등록', '빌딩·건물 매매·임대 매물 취급에 강점'),
  ('archiproperty', null, null, null, '매물 문의·중개 의뢰 후 이용', '꼬마빌딩 매매·상가 임대 중개에 강점'),
  ('xnob0bj3f9wty2d24ab95b', null, null, null, '매물 등록·중개 의뢰는 사업자 문의', '공장·창고·물류센터 매매·임대 특화에 강점'),
  ('penggo', null, null, null, '창고 소유주 등록·임차인 문의', '상온·냉장·냉동 창고 임대·매매 중개에 강점'),
  ('gangnamunni', null, null, null, '병원 제휴 입점, 이용자 앱 가입', '미용·성형·피부 시술 정보·예약에 강점'),
  ('goodoc', null, null, null, '병원·약국 제휴 입점, 이용자 앱 가입', '병원·약국 검색·예약 접근성에 강점'),
  ('ddocdoc', null, null, null, '병·의원 제휴 입점, 이용자 앱 가입', '병원 예약·접수·대기 관리에 강점'),
  ('kakaohair', null, null, null, '미용실 제휴 입점, 이용자 앱 가입', '미용실 예약 중개·카카오 연동에 강점'),
  ('yeoshin', null, null, null, '병원 제휴 입점, 이용자 앱 가입', '피부·성형 시술 정보·후기·예약에 강점'),
  ('babitalk', null, null, null, '병원 제휴 입점, 이용자 앱 가입', '성형·피부 시술 후기 커뮤니티·예약에 강점'),
  ('modoodoc', null, null, null, '병원 제휴 입점, 이용자 앱 가입', '실방문 리뷰·가격 기반 병원 비교에 강점'),
  ('hidoc', null, null, null, '가입 후 이용, 의료진 제휴 참여', '건강 Q&A·의사/병원 찾기 정보 제공에 강점'),
  ('doctornow', null, null, null, '병원·약국 제휴 입점, 이용자 앱 가입', '비대면 진료·처방·약국 연결에 강점'),
  ('hospital', null, null, null, '동물병원 제휴 입점, 이용자 앱 가입', '동물병원 검색·예약·반려 건강관리에 강점'),
  ('heally', null, null, null, '마사지샵 제휴 입점, 이용자 앱 가입', '마사지샵 가격비교·예약에 강점'),
  ('mamap', null, null, null, '마사지샵 제휴 입점, 이용자 앱 가입', '마사지샵 최저가 검색·예약에 강점'),
  ('makangs', null, null, null, '업소 제휴 입점, 이용자 앱 가입', '마사지·왁싱·에스테틱 예약에 강점'),
  ('fingerprincess', null, null, null, '네일샵 제휴 입점, 이용자 앱 가입', '네일아트 탐색·예약·결제 통합에 강점'),
  ('pillyze', null, null, null, '가입 후 바로 사용', 'AI 식단·영양제·혈당 기록 관리에 강점'),
  ('noom', null, null, null, '가입 후 사용, 구독형 코칭', '식단·운동·습관 코칭 프로그램에 강점'),
  ('pearlcare', null, null, null, '브랜드 직접 운영몰, 일반 소비자 구매', 'RF·EMS·광테라피 홈 뷰티 디바이스에 강점'),
  ('pesade', null, null, null, '브랜드 직접 운영몰, 일반 소비자 구매', '오드퍼퓸·핸드케어 니치 향수 전개에 강점'),
  ('athebeauty', null, null, null, '브랜드 직접 운영몰, 일반 소비자 구매', '비건 인증 스킨케어·메이크업에 강점'),
  ('melixir', null, null, null, '브랜드 직접 운영몰, 일반 소비자 구매', '식물성 성분 비건 스킨케어에 강점'),
  ('jejuon', null, null, null, '브랜드 직접 운영몰, 일반 소비자 구매', '제주 유기농 원료 비건 지향 화장품에 강점'),
  ('en', null, null, null, '가입 후 바로 구매·이용', '비건·친환경 지향 스킨케어에 강점'),
  ('nutridday', null, null, null, '가입 후 바로 구매·이용', '피쉬콜라겐 등 이너뷰티 D2C에 강점'),
  ('foodology', null, null, null, '가입 후 바로 구매·이용', '이너뷰티·다이어트 식품 D2C에 강점'),
  ('mindle', null, null, null, '앱 설치·가입 후 검사·구독 이용', '셀프 멘탈케어·심리검사 구독에 강점'),
  ('inside', null, null, null, '앱 설치·가입 후 검사·케어 이용', 'CBT 기반 정신건강 자가케어에 강점'),
  ('checkup', null, null, null, '가입 후 검진 비교·예약', '건강검진 비교·예약·결과조회에 강점'),
  ('checkupmoa', null, null, null, '가입 후 검진 비교·예약', '종합·국가검진 비용 비교·예약에 강점'),
  ('wellcheck', null, null, null, '앱 설치·가입 후 데이터 관리 이용', '만성질환 데이터·복약 의료진 연계 관리에 강점'),
  ('heymama', null, null, null, '앱 설치·가입 후 프로그램 이용', '산후 회복·여성 비대면 홈트레이닝에 강점'),
  ('encar', null, null, null, '딜러 등록 또는 개인 매물 등록 후 이용', '중고차 매물 검색·시세 확인에 강점'),
  ('heydealer', null, null, null, '앱에서 차량 등록 후 딜러 견적 수령', '딜러 경매 방식 내차 팔기에 강점'),
  ('kcar', null, null, null, '직영점·앱에서 구매·매입(입점 개념 없음)', '직영 중고차 판매·매입 신뢰성에 강점'),
  ('kbchachacha', null, null, null, '딜러 등록 또는 개인 매물 등록 후 이용', '금융 계열 연계 중고차 거래에 강점'),
  ('cardoc', null, null, null, '가입 후 견적 요청·정비소 매칭', '정비·수리 견적 비교 매칭에 강점'),
  ('carnoon', null, null, null, '가입 후 신차 견적·정보 조회', '신차 구매정보·견적 모음에 강점'),
  ('web', null, null, null, '가입 후 견적·금융조건 비교', '신차 할부·리스·렌트 조건 비교에 강점'),
  ('web2', null, null, null, '딜러 등록 또는 개인 매물 등록 후 이용', '중고차 매물 검색·매매에 강점'),
  ('reborncar', null, null, null, '앱·직영에서 구매(입점 개념 없음)', '품질검사·시승 후 직영 중고차 구매에 강점'),
  ('autoplus', null, null, null, '직영 구매·매입 또는 경매 참여', '직영관리 중고차 판매·매입·경매에 강점'),
  ('autobell', null, null, null, '회원 등록 후 경매·매매 이용', '대기업 계열 중고차 경매·시세에 강점'),
  ('carisyou', null, null, null, '가입 후 통계·견적·시승기 조회', '자동차 통계·종합정보 열람에 강점'),
  ('auto', null, null, null, '가입 후 견적·가격비교 이용', '신차·렌트·중고차 가격비교에 강점'),
  ('kcarauction', null, null, null, '딜러 등록·심사 후 경매 참여', '중고차 경매 매입에 강점(주로 딜러 대상)'),
  ('mycle', null, null, null, '앱 설치·가입 후 예약·관리 이용', '정비 예약·소모품 알림 내차관리에 강점'),
  ('carsuri', null, null, null, '가입 후 출장 정비 예약', '출장 오일·배터리 등 방문정비에 강점'),
  ('carpos', null, null, null, '조합 가입 정비사업자 대상 이용', '정비조합 연합 정비·부품 정보에 강점'),
  ('partzone', null, null, null, '가입 후 부품 검색·정비 예약', '차량번호 호환 부품 매칭·예약에 강점'),
  ('cartem', null, null, null, '가입 후 바로 구매·이용', '자동차 용품·튜닝 부품 온라인 구매에 강점'),
  ('autohub', null, null, null, '딜러 입점 또는 방문 구매·경매 참여', '대형 중고차 매매단지·경매 운영에 강점'),
  ('greencar', null, null, null, '앱 설치·가입·면허 등록 후 이용', '카셰어링·차량구독 단기 이용에 강점'),
  ('kakaomobility', null, null, null, '앱 설치·가입 후 대리 호출', '모바일 대리운전 호출 접근성에 강점'),
  ('camtayo', null, null, null, '가입 후 매물 등록·거래', '개인 간 중고 캠핑카 직거래에 강점'),
  ('campingncar', null, null, null, '가입 후 매물 조회·거래·렌트', '캠핑카·카라반 매매·렌트 정보에 강점'),
  ('wonderfulcar', null, null, null, '업체 통해 상담·구매(입점 개념 없음)', '모터홈·차박 캠핑카 판매·사후관리에 강점'),
  ('zaekook', null, null, null, '가입 후 가격비교·직거래 정보 조회', '캠핑카·카라반 가격비교·중고 직거래에 강점'),
  ('bikeweb', null, null, null, '개인·사업자 모두 가입 후 매물 등록', '중고 오토바이·수입바이크 시세 검색·직거래에 강점'),
  ('revolt', null, null, null, '판매 차량 등록·진단 후 거래 진행', '배터리 진단 인증 기반 중고 전기차 거래에 강점'),
  ('charzing', null, null, null, '예약 후 방문 진단 이용', '전기차 배터리 성능(SOH) 방문 진단에 특화'),
  ('tirepick', null, null, null, '가입 후 가격 비교·장착점 예약', '타이어 가격 비교와 장착점 예약 연결에 강점'),
  ('isnara', null, null, null, '장착점은 제휴 등록, 소비자는 가입 후 예약', '온라인 구매 타이어의 전국 장착점 예약 중개'),
  ('otire', null, null, null, '지역 매장 제휴 등록, 소비자는 예약 이용', '인터넷 가격 당일 타이어 장착 연결에 강점'),
  ('automango', null, null, null, '가입 후 바로 구매(자사 운영 쇼핑몰)', '자동차용품·튜닝용품 전문 쇼핑에 강점'),
  ('cazamall', null, null, null, '가입 후 바로 구매', '국산·수입차 차종별 튜닝파츠 쇼핑에 강점'),
  ('liuparts', null, null, null, '가입 후 바로 구매', '벤츠·BMW·아우디 등 수입차 튜닝 부품에 특화'),
  ('happyscrapcar', null, null, null, '차량 정보 등록 후 견적 비교', '관허 폐차장 경매 방식 폐차 견적 비교에 강점'),
  ('carbridge', null, null, null, '차량 정보 등록 후 매입 견적 요청', '사고차·고장차를 수리 없이 매입 견적내는 데 특화'),
  ('joinsauto', null, null, null, '차량 정보 등록 후 견적 비교', '폐차 견적 비교(규제샌드박스 임시허가)에 강점'),
  ('goodbrother', null, null, null, '매입 문의 후 출장 방문', '중고 오토바이 출장 매입에 특화'),
  ('evmodu', null, null, null, '앱 설치·가입 후 충전 이용', '전국 충전소 정보·통합결제(모두페이) 제공에 강점'),
  ('pluglink', null, null, null, '공동주택 대상 설치 신청', '공동주택 완속 충전 인프라 무상 설치·운영에 강점'),
  ('octoev', null, null, null, '도입 문의 후 설치 협의', '레일 이동형 무인 자동 충전 시스템에 특화'),
  ('autostay', null, null, null, '앱 가입 후 월정액 구독', '월정액 자동세차 무제한 구독에 강점'),
  ('carvazo', null, null, null, '예약 후 검수 서비스 이용', '중고차 구매 시 정비사 동행 검수에 특화'),
  ('interparkticket', null, null, null, '공연 등록은 주최사·기획사 제휴 계약 필요', '공연·콘서트·스포츠 종합 예매에 강점'),
  ('yes24ticket', null, null, null, '공연 등록은 주최사·기획사 제휴 계약 필요', '공연·뮤지컬 중심 예매에 강점'),
  ('ticketlink', null, null, null, '공연 등록은 주최사·기획사 제휴 계약 필요', '공연·스포츠 예매에 강점'),
  ('melonticket', null, null, null, '공연 등록은 주최사·기획사 제휴 계약 필요', '콘서트·음악 공연 예매에 강점'),
  ('nol', null, null, null, '공연 등록은 주최사·기획사 제휴 계약 필요', '콘서트·뮤지컬·전시 예매에 강점(구 인터파크티켓)'),
  ('ticketbay', null, null, null, '가입 후 티켓 양도 등록', '공연·스포츠 티켓 양도·중고 거래에 강점'),
  ('ticket', null, null, null, '가입 후 예매, 등록은 제휴 문의', '하나투어 공연·전시·레저 티켓 예매에 강점'),
  ('ticket2', null, null, null, '가입 후 예매, 등록은 제휴 문의', '뮤지컬·콘서트 할인 예매에 강점'),
  ('clipservice', null, null, null, '공연 유통은 기획·제작 제휴 문의', '공연 기획·제작·티켓 유통 일괄 처리에 강점'),
  ('playticket', null, null, null, '공연 등록은 극장·주최사 제휴 문의', '중소극장 공연 예매에 특화'),
  ('nanumticket', null, null, null, '가입 후 이용, 공연 등록은 주최사 제휴', '공연 잔여석 기부·저가 나눔에 특화'),
  ('eventus', null, null, null, '주최자 가입 후 행사 등록·티켓 발행', '공연·전시·세미나 행사 신청·티켓 관리에 강점'),
  ('kopis', null, null, null, '정보 조회는 무료, 등록은 공연시설·기획사', '공연예술 정보·예매처·통계 통합 조회에 강점'),
  ('sac', null, null, null, '가입 후 예매', '예술의전당 공연·전시 온라인 예매에 강점'),
  ('sejongpac', null, null, null, '가입 후 예매', '세종문화회관 공연·전시 예매에 강점'),
  ('festivallife', null, null, null, '가입 후 정보 조회·예매 연결', '국내외 페스티벌 라인업·티켓 일정 안내에 강점'),
  ('timeticket', null, null, null, '공연 등록은 극장·주최사 제휴 문의', '연극·소극장 등 문화 티켓 예매에 강점'),
  ('dongnemudae', null, null, null, '극단·주최자가 공연 등록 후 예매 위탁', '소극장 연극·뮤지컬 일정 탐색·예매에 강점'),
  ('enticket', null, null, null, '지역 주최자 공연 발권·예매 대행 문의', '인천 지역 공연 예매·발권에 특화'),
  ('finestage', null, null, null, '클래식 주최자가 공연 예매 위탁 등록', '클래식 공연 전문 예매·정보 탐색에 강점'),
  ('ticketguide', null, null, null, null, '유럽축구 등 해외 스포츠 직관 티켓에 특화'),
  ('thebestplay', null, null, null, '극단·주최자가 연극 예매 등록', '연극 공연 정보·예매 제공에 강점'),
  ('petfriends', null, null, null, null, '사료·간식·용품 종합 구매·빠른배송에 강점'),
  ('aboutpet', null, null, null, null, '반려동물 종합 쇼핑, GS리테일 인프라 연계'),
  ('biteme', null, null, null, null, '자체 제작 강아지 용품·간식·의류에 강점'),
  ('dogpre', null, null, null, null, '강아지 사료·간식·용품 전문 구매에 강점'),
  ('dogpang', null, null, null, null, '강아지 용품·사료 전문 쇼핑에 강점'),
  ('catpang', null, null, null, null, '고양이 용품·사료 전문 구매에 강점'),
  ('catskingdom', null, null, null, null, '고양이 용품 전문 온라인 구매에 강점'),
  ('maxcat', null, null, null, null, '고양이 용품 전문 쇼핑에 강점'),
  ('drfelis', null, null, null, null, '수의사 기획 고양이 용품 D2C에 강점'),
  ('petbazaar', null, null, null, null, '반려동물 용품 아울렛형 저가 구매에 강점'),
  ('petmily', null, null, null, null, '반려동물 영양제·건강용품 구매에 강점'),
  ('petmart', null, null, null, null, '사료·간식·용품 종합 구매에 강점'),
  ('harimpetfood', null, null, null, null, '휴먼그레이드 사료·간식 제조 직판에 강점'),
  ('petfresh', null, null, null, '가입 후 정기구독 신청·영양 상담 이용', '사료 정기구독·맞춤 영양 상담에 강점'),
  ('dogmalion', null, null, null, null, '무첨가 강아지 수제간식 D2C에 강점'),
  ('petoi', null, null, null, null, 'IoT 자동급식기 등 펫테크 제품에 강점'),
  ('petrasyu', null, null, null, '동물병원이 병원 정보 등록·예약 연동', '동물병원 진료비 조회·후기·예약에 강점'),
  ('intopet', null, null, null, '동물병원 제휴 등록 후 예약 연동', '접종·복약 관리와 병원 모바일 예약에 강점'),
  ('todaypaw', null, null, null, '동물병원이 병원 등록·예약 연동', '동물병원 진료비 비교·후기·예약에 강점'),
  ('petdoc', null, null, null, '수의사·병원 제휴 등록 후 상담 제공', '수의사 실시간 상담·케어 기록에 강점'),
  ('ipet', null, null, null, null, '반려동물 보험 비교·청구 관리에 강점'),
  ('petforest', null, null, null, '장례업체가 시설 등록 후 예약 중개', '반려동물 장례·추모 공간 예약에 강점'),
  ('petnight', null, null, null, '장례식장이 시설 등록·예약 연동', '전국 반려동물 장례식장 비교·예약에 강점'),
  ('banjjakpet', null, null, null, '미용실이 포트폴리오 등록 후 예약 연동', '반려동물 미용실 검색·포트폴리오·예약에 강점'),
  ('enterdog', null, null, null, '숙소·매장이 업체 등록 후 예약 중개', '애견동반 숙소·호텔·매장 예약 중개에 강점'),
  ('hoteldogs', null, null, null, '호텔·유치원 업체 등록 후 예약 연동', 'CCTV·24시간 강아지 호텔·유치원에 강점'),
  ('banlife', null, null, null, '숙소·매장 업체 등록 후 예약 연동', '애견동반 여행·숙소·맛집 예약에 강점'),
  ('pawinhand', null, null, null, '보호소·기관이 동물 정보 등록', '보호소 유기동물 입양·실종동물 찾기에 강점'),
  ('petner', null, null, null, '펫시터·미용사 프로필 등록 후 매칭', '방문 펫시터·방문 미용 예약에 강점'),
  ('woofoo', null, null, null, '돌봄 제공자 프로필 등록 후 매칭', '도그워커·방문 펫시터·캣시터 매칭에 강점'),
  ('beforpet', null, null, null, '사업자·펫시터 등록 후 산책 대행 매칭', '반려견 산책 대행 온디맨드 매칭에 특화'),
  ('9dogcat', null, null, null, '사업자등록·통신판매업 신고 후 이용', '고양이 모래·용품 정기구독 배송에 강점'),
  ('dogmeal', null, null, null, '가입 후 반려견 정보 입력·구독 신청', '반려견 맞춤 식단 정기배송에 특화'),
  ('petbox', null, null, null, '사업자등록·통신판매업 신고 후 이용', '사료·수제간식 등 반려용품 온라인 판매'),
  ('breeeeeding', null, null, null, '가입 후 훈련 콘텐츠·프로그램 이용', '강아지 훈련·행동교육 콘텐츠 제공에 강점'),
  ('petfins', null, null, null, '가입 후 반려동물 정보 입력·보험 비교', '여러 보험사 펫보험 비교·가입에 특화'),
  ('petme', null, null, null, '업체·전문가 등록 후 서비스 노출·예약', '미용·호텔 등 반려 서비스 전문가 매칭에 강점'),
  ('goodbyeangel', null, null, null, '가입 후 장례 상담·예약 이용', '반려동물 장례 예약·24시간 상담에 특화'),
  ('21gram', null, null, null, '가입 후 장례 절차 상담·예약', '반려동물 장례식장 운영·화장 절차 전반 지원'),
  ('petvip', null, null, null, '가입 후 출장 미용·돌봄 예약', '출장·방문 반려동물 미용·목욕·돌봄에 강점'),
  ('charactergrooming', null, null, null, '가입 후 예약, 니치 그루밍샵', '캐릭터·창작 스타일 애견 미용에 특화'),
  ('othermars', null, null, null, '가입 후 바로 구매(자사몰형)', '유기농 무첨가 자연식 펫푸드 D2C 브랜드'),
  ('momq', null, null, null, '가입 후 바로 구매·멤버십 이용', '유한킴벌리 육아·출산용품 직영몰·멤버십에 강점'),
  ('kizmom', null, null, null, '가입 후 바로 구매', '수입 유아용품·완구 전문 온라인 판매'),
  ('inuri', null, null, null, '가입 후 바로 구매', '유아 보육·교육용품 커머스에 특화'),
  ('mamigo', null, null, null, '가입 후 바로 구매', '프리미엄 유아용품 온라인 판매에 강점'),
  ('agabang', null, null, null, '가입 후 바로 구매(공식몰)', '아가방 유아복·육아용품 공식 커머스'),
  ('momnuri', null, null, null, '가입 후 바로 구매', '임부복·출산 준비물 임신·출산 커머스에 특화'),
  ('ibaby', null, null, null, '가입 후 상품 등록·거래(중고 개인간)', '유아용품 안전거래 중고 플랫폼에 강점'),
  ('homelearn', null, null, null, '가입·구독 신청 후 학습 이용', '초등 대상 AI 온라인 학습에 특화'),
  ('smartall', null, null, null, '가입·구독 신청 후 학습 이용', '유아~중등 AI 스마트 학습 커버리지에 강점'),
  ('nurinori', null, null, null, '가입 후 콘텐츠·교구 이용', '유아 교육·놀이 콘텐츠·교구 제공에 특화'),
  ('sssd', null, null, null, '클래스 운영자 등록 후 강좌 개설·예약', '원데이클래스·체험 예약 중개에 강점'),
  ('umclass', null, null, null, '클래스 운영자 등록 후 강좌 개설·예약', '체험권·원데이클래스 중개 예약에 특화'),
  ('kidsday', null, null, null, '가입 후 클래스 검색·예약', '유아·초등 체험학습·키즈클래스 예약에 강점'),
  ('nolbal', null, null, null, '시설 등록 후 노출·예약 접수', '가족·아이 여가 체험시설 검색·예약에 특화'),
  ('ipoomgo', null, null, null, '가입 후 조리원 비교·투어·예약', '산후조리원 온라인 투어·비교·예약에 강점'),
  ('momsmanager', null, null, null, '관리사 등록·가입 후 예약 매칭', '산후관리사·마사지 전문가 예약 매칭에 특화'),
  ('doctormam', null, null, null, '관리사 등록·가입 후 케어 매칭', '산모도우미·산후관리사 매칭에 강점'),
  ('imilkbook', null, null, null, '가입 후 도서 구매·구독 신청', '어린이 도서·전집 판매·구독에 특화'),
  ('saybooks', null, null, null, '가입 후 구독 신청', '어린이·가정 도서 정기구독에 강점'),
  ('gilbutkid', null, null, null, '가입 후 바로 구매', '그림책·아동도서 출판·판매 채널'),
  ('littlebaby', null, null, null, '가입 후 대여·구매 신청', '수입 아기용품 대여·판매 렌탈에 특화'),
  ('babynoriter', null, null, null, '가입 후 대여 신청', '유아용품·장난감 대여 전문에 강점'),
  ('toyuncle', null, null, null, '가입 후 방문 대여 신청', '유아용품·장난감 방문 대여에 특화'),
  ('ozkiz', null, null, null, '자사 브랜드몰(입점 아님)·회원가입 후 구매', '3~10세 아동복·키즈신발 자사 브랜드 상품에 강점'),
  ('nonikids', null, null, null, '자사 쇼핑몰(입점 아님)·회원가입 후 구매', '신생아~초등 종합 아동복 구성에 강점'),
  ('bebezone', null, null, null, '자사 커머스몰(입점 아님)·회원가입 후 구매', '임산부·출산용품 전문 구성에 강점'),
  ('kidsnote', null, null, null, '어린이집·유치원 기관 단위 가입 후 이용', '원-학부모 알림장·원비 결제 통합 운영에 강점'),
  ('pinkids', null, null, null, '가입 후 바로 이용(대개 무료)', '수유실·노키즈존 등 아이 동반 장소 탐색에 강점'),
  ('dorbom', null, null, null, '부모·시터 가입·프로필 등록 후 매칭', '베이비시터·아이돌봄 매칭에 강점'),
  ('yummimeal', null, null, null, '가입 후 구독 신청(소비자)', '단계별 이유식·아기반찬 정기배송에 강점'),
  ('planacampus', null, null, null, '학부모 신청 후 이용·교사는 검증 후 활동', '검증 교사 방문형 유아 미술 교육에 강점'),
  ('gguge', null, null, null, '강사 등록·심사 후 수업 개설, 학부모 수강신청', '아동 라이브 온라인 수업 개설·수강 중개에 강점'),
  ('raraclass', null, null, null, '회원가입 후 프로그램 신청', '미취학·초등 체험·도슨트 프로그램 운영에 강점'),
  ('kidsning', null, null, null, '소비자 앱 가입 후 이용·셀러 입점은 별도', '육아맘 셀럽마켓·아동패션·육아템 큐레이션에 강점'),
  ('marpple', null, null, null, '가입 후 디자인 업로드·1개부터 주문', '1개부터 커스텀 굿즈 POD 주문 제작에 강점'),
  ('marpple2', null, null, null, '가입 후 디자인 등록으로 무재고 셀러 시작', '무재고 크리에이터 굿즈 제작·판매에 강점'),
  ('ohprint', null, null, null, '가입 후 디자인 업로드·소량 주문', '명함·스티커·현수막 등 소량 인쇄에 강점'),
  ('redprinting', null, null, null, '가입 후 디자인 업로드·주문', '스티커·명함·어패럴·상업 인쇄 폭넓은 품목에 강점'),
  ('snaps', null, null, null, '앱·웹 가입 후 사진 업로드·주문', '포토북·사진인화·액자 등 사진 상품 제작에 강점'),
  ('zzixx', null, null, null, '가입 후 사진 업로드·주문', '사진인화·포토북·포토상품 주문 제작에 강점'),
  ('publog', null, null, null, '가입 후 디자인 업로드·소량 주문', '포토북·포토카드·아크릴 굿즈 소량 제작에 강점'),
  ('bizhows', null, null, null, '가입 후 온라인 편집툴로 1장부터 주문', '온라인 편집툴로 현수막·판촉물 소량 제작에 강점'),
  ('withgoods', null, null, null, '작가 입점 신청·심사 후 굿즈 등록', '주문·재고·CS 대행형 아트굿즈 판매에 강점'),
  ('shopfanpick', null, null, null, '크리에이터 입점 후 굿즈 기획·판매', '크리에이터 IP 커스텀 굿즈 기획·유통에 강점'),
  ('designersbay', null, null, null, '가입 후 디자인 업로드·1장부터 주문', '티셔츠·에코백 커스텀 소량 제작에 강점'),
  ('allthatprinting', null, null, null, '가입 후 주문·B2B는 견적 문의', '창작자용 아크릴·우드 굿즈 소량·B2B 제작에 강점'),
  ('itension', null, null, null, '가입 후 디자인 업로드·주문', '아크릴 키링·스탠드·등신대 굿즈 제작에 강점'),
  ('hanalldnp', null, null, null, '가입 후 디자인 업로드·소량 주문', '레이저 커팅·UV 인쇄 아크릴 굿즈 소량 제작에 강점'),
  ('hueandgo', null, null, null, '가입 후 디자인 업로드·주문', '아크릴 키링·마우스패드 등 커스텀 굿즈 제작에 강점'),
  ('koaladesign', null, null, null, '가입 후 디자인 업로드·주문', '아크릴 키링·모빌·DIY 키트 굿즈 제작에 강점'),
  ('customland', null, null, null, '가입 후 주문·대량은 견적 문의', '공장 직영으로 1개~대량 커스텀 굿즈 제작에 강점'),
  ('dpl', null, null, null, '셀러 가입 후 제작사 연동·주문 자동화', '굿즈 제작·배송 자동화로 무재고 셀러 운영에 강점'),
  ('qrim', null, null, null, '가입 후 디자인 업로드·단체 주문', '단체·커스텀 티셔츠 주문 제작에 강점'),
  ('customzone', null, null, null, '가입 후 디자인 업로드·주문', '프린팅 티셔츠 커스텀 제작에 강점'),
  ('stickerz', null, null, null, '가입 후 디자인 업로드·1장부터 주문', '스티커·포토카드 1장부터 당일 출고 제작에 강점'),
  ('printingting', null, null, null, '가입 후 디자인 업로드·소량 주문', '굿즈·명함·포토카드·스티커 소량 제작에 강점'),
  ('wowpress', null, null, null, '가입 후 디자인 업로드·주문', '명함·스티커·전단 인쇄·후가공·배송 일괄에 강점'),
  ('swadpia', null, null, null, '가입 후 디자인 업로드·주문', '명함·전단·스티커·책자 종합 온라인 인쇄에 강점'),
  ('dtpia', null, null, null, '가입 후 온라인 주문·결제(사업자 불필요)', '명함·굿즈·포토카드 소량 인쇄에 강점'),
  ('printingkorea', null, null, null, '가입 후 온라인 주문·결제', '명함·전단·현수막 등 종합 인쇄물 소량 주문에 강점'),
  ('ecard21', null, null, null, '가입 후 온라인 주문·결제', '명함 인쇄 전문·소량 제작에 강점'),
  ('inswaehada', null, null, null, '가입 후 온라인 주문·결제', '실사출력과 명함·전단 인쇄 통합 주문에 강점'),
  ('nmk', null, null, null, '가입 후 온라인 주문·결제', '현수막·배너·에어간판 실사출력 홍보물에 강점'),
  ('printing24', null, null, null, '가입 후 온라인 주문·결제', '현수막·미니배너·롤스크린 실사출력에 강점'),
  ('label', null, null, null, '가입 후 온라인 주문·결제', '방수·바코드 라벨 주문 제작에 강점'),
  ('labelpack', null, null, null, '가입 후 온라인 주문·결제', '라벨·스티커·패키지 맞춤 제작에 강점'),
  ('juagift', null, null, null, '가입 후 온라인 주문·견적 요청', '로고 인쇄·각인 판촉물·기념품 제작에 강점'),
  ('3dprocess', null, null, null, '가입 후 도면 업로드·견적 주문', '3D프린팅 출력 대행·시제품 소량 제작에 강점'),
  ('stellamove', null, null, null, '가입 후 도면 업로드·견적 주문', 'FDM·SLA 3D프린팅 시제품·조형물 제작에 강점'),
  ('creallo', null, null, null, '가입 후 도면 업로드·견적 주문', '3D프린팅·CNC·사출 맞춤 부품 온라인 제조에 강점'),
  ('inupt', null, null, null, '가입 후 굿즈 제작 의뢰', 'IP·캐릭터 커스텀 굿즈 소량 제작에 강점'),
  ('poclanos', null, null, null, '아티스트 신청·심사 후 유통 계약', '인디 뮤지션 음원 국내외 배급에 강점'),
  ('danalenter', null, null, null, '유통 계약 후 음원 등록', '음원 국내외 스트리밍·다운로드 유통에 강점'),
  ('bugscorp', null, null, null, '유통 계약 후 음원 등록', '기획사·아티스트 음원 B2B 유통에 강점'),
  ('spaceoddity', null, null, null, '아티스트 협의·계약 후 진행', '음원 기획과 유통을 결합한 지원에 강점'),
  ('dittomusic', null, null, null, '가입·구독 후 셀프 음원 배급', '150여 플랫폼 셀프 음원 배급에 강점'),
  ('sellbuymusic', null, null, null, '작곡가 가입·심사 후 음원 등록', '저작권 BGM 음원 판매·구매에 강점'),
  ('crowdpic', null, null, null, '작가 가입·심사 후 콘텐츠 업로드', '국내 사진·일러스트 스톡 판매에 강점'),
  ('iclickart', null, null, null, '작가 등록·심사 후 콘텐츠 업로드', '사진·일러스트·영상·폰트 통합 스톡에 강점'),
  ('utoimage', null, null, null, '작가 등록·심사 후 콘텐츠 업로드', '사진·일러스트·그래픽 스톡 유통에 강점'),
  ('gettyimagesbank', null, null, null, '가입 후 라이선스 구매(작가는 별도 기여 채널)', '로열티프리 스톡 이미지 다량 확보에 강점'),
  ('clipartkorea', null, null, null, '가입 후 라이선스 구매·이용', '사진·일러스트·폰트·영상 종합 스톡에 강점'),
  ('mbdrive', null, null, null, '작가 등록·심사 후 콘텐츠 판매', '게티 계열 사진·영상 작가 판매 채널에 강점'),
  ('contributors', 'high', '작가 로열티 지급(수취 비중 낮음)', '월 정산(최소 지급액 도달 시)', '기여자 등록·심사 후 업로드', '게티 글로벌 라이선스 판매 기여 프로그램에 강점'),
  ('submit', 'high', '작가 로열티 지급(수취 비중 낮음)', '월 정산(최소 지급액 도달 시)', '기여자 가입·심사 후 업로드', '셔터스톡 글로벌 스톡 로열티 판매에 강점'),
  ('contributor', 'high', '작가 로열티 지급(수취 비중 낮음)', '월 정산(최소 지급액 도달 시)', '기여자 가입·심사 후 업로드', '어도비 생태계 연동 스톡 판매에 강점'),
  ('pixta', null, null, null, '기여자 가입·심사 후 업로드', '일본 시장 중심 사진·일러스트·영상 스톡 판매에 강점'),
  ('pond5', null, null, null, '기여자 가입·심사 후 업로드', '영상·음악 등 미디어 스톡 판매에 강점'),
  ('sandollcloud', null, null, null, '가입·구독 후 폰트 이용', '산돌 폰트 구독형 이용에 강점'),
  ('noonnu', null, null, null, '가입 없이 무료 폰트 탐색·다운로드', '상업용 무료 한글 폰트 탐색·확인에 강점'),
  ('font', null, null, null, '가입 후 폰트 구매·라이선스', '윤디자인 한글·글로벌 폰트 판매에 강점'),
  ('fontclub', null, null, null, '가입 후 폰트 구매·라이선스', '국내외 폰트 판매·커뮤니티에 강점'),
  ('rixfontcloud', null, null, null, '가입·구독 후 폰트 이용', '폰트릭스 릭스폰트 구독형 이용에 강점'),
  ('miricanvas', null, null, null, '가입 후 소재 심사 통과·업로드로 판매', '디자인 템플릿·요소·사진·음원 기여 판매, 미리캔버스 이용자 노출'),
  ('bookk', null, null, null, '원고 등록·검수 후 출판, 재고 부담 없음', '종이책·전자책 POD 자가출판에 강점, 소량 주문제작'),
  ('pubple', null, null, null, '원고 등록·검수 후 출판', '교보문고 유통 연계 자가출판에 강점'),
  ('upaper', null, null, null, 'EPUB 제작·등록 후 서점 유통', 'EPUB 전자책 제작·주요 서점 유통에 강점'),
  ('ridibooks2', null, null, null, '작품 투고·심사 후 출간', '웹소설·웹툰·전자책 작가 투고·리디 독자 노출'),
  ('jakkawa', null, null, null, '원고(워드) 등록 후 출판·유통', '워드 기반 전자책·POD 출판·서점 유통에 강점'),
  ('happycampus', null, null, null, '가입 후 자료 등록·판매', '레포트·논문·PPT 등 학습 문서 판매 수요에 강점'),
  ('reportworld', null, null, null, '가입 후 자료 등록·판매', '레포트·문서 자료 등록·판매에 강점'),
  ('audiojungle', 'high', '독점 여부·등급별 요율 상이', null, '작가 등록·소재 심사 후 판매', '로열티프리 배경음악 글로벌 판매에 강점'),
  ('assetstore', 'mid', '판매액 약 30% 플랫폼 수수료', null, '퍼블리셔 등록·에셋 심사 후 판매', '유니티 게임 개발 에셋 판매 공식 채널'),
  ('fab', 'low', '판매액 약 12% 수수료', null, '셀러 등록·에셋 심사 후 판매', '3D·게임 에셋 판매, 에픽게임즈 통합 마켓 노출'),
  ('cgtrader', null, null, null, '작가 등록·모델 업로드로 판매', '3D 모델·프린팅 파일 글로벌 판매에 강점'),
  ('sketchfab', null, null, null, '작가 등록·3D 모델 업로드로 판매', '실시간 3D 모델 뷰어 기반 판매에 강점'),
  ('artstation', null, null, null, '작가 등록·소재 업로드로 판매', '3D 에셋·브러시·튜토리얼 등 크리에이티브 판매'),
  ('artipio', null, null, null, '가입·본인인증 후 청약 참여', '미술품 소액 조각투자에 강점(예스24 계열)'),
  ('treasurer', null, null, null, '가입·본인인증 후 청약 참여', '명품 시계·와인 등 수집품 소액 조각투자에 강점'),
  ('bankcow', null, null, null, '가입·본인인증 후 청약 참여', '한우 소액 공동투자에 특화된 조각투자'),
  ('twig', null, null, null, '가입·본인인증 후 청약 참여', '슈퍼카 등 글로벌 대체자산 소액 조각투자에 강점'),
  ('creators', null, null, null, '가입 후 콘텐츠 업로드·심사', '이모티콘·이미지 한 번 업로드로 다중 마켓 유통'),
  ('stipop', null, null, null, '작가 등록·스티커 업로드로 유통', '스티커의 글로벌 메신저·API 유통에 강점'),
  ('stock', null, null, null, '작가 등록·영상 업로드로 판매', '한국적 소재 상업용 스톡 영상 판매에 강점'),
  ('obud', null, null, null, '제휴 스튜디오로 입점 신청(이용자는 가입)', '요가·필라테스·바레 등 웰니스 스튜디오 통합 이용권'),
  ('healthboypass', null, null, null, '앱 가입 후 지점 통합 이용', '헬스보이짐 전국 지점 통합 이용에 강점'),
  ('likefit', null, null, null, '앱 설치·가입 후 바로 이용', '카메라 자세 인식 AI 홈트레이닝 코칭에 강점'),
  ('quat', null, null, null, '앱 설치·가입 후 이용', '필라테스·요가·홈트 온라인 코칭에 강점'),
  ('planfit', null, null, null, '앱 가입 후 이용(무료 기능 제공)', 'AI 운동 루틴 추천·기록·음성 코칭에 강점'),
  ('dagym', null, null, null, '앱 설치 후 시설 검색·예약(시설은 제휴)', '주변 헬스장·PT·필라테스 가격비교·예약에 강점'),
  ('ngym', null, null, null, '앱 가입 후 구독 이용(시설은 제휴)', '주변 헬스장 월 구독형 할인 이용에 강점'),
  ('helssg', null, null, null, '가입 후 회원권 양도·양수 등록', '헬스·요가·PT 회원권 양도·양수 중개에 강점'),
  ('kimcaddie', null, null, null, '앱 설치 후 검색·예약(시설은 제휴)', '스크린골프·연습장·레슨 가격비교·예약에 강점'),
  ('kakao', null, null, null, '앱 가입 후 티타임 검색·부킹', '골프장 티타임 검색·온라인 부킹에 강점(카카오VX)'),
  ('golfzon', null, null, null, '앱 가입 후 매장 예약(매장은 제휴)', '스크린골프 매장 예약·시뮬레이터에 강점'),
  ('golfzonmarket', null, null, null, '가입 후 용품 구매·렌탈', '골프 클럽·용품 판매·렌탈 O2O에 강점'),
  ('plabfootball', null, null, null, '앱 가입 후 매치 참여·구장 예약', '소셜 축구·풋살 매칭·구장 예약에 강점'),
  ('iamground', null, null, null, '앱 가입 후 예약·팀매칭', '풋살장 실시간 예약·팀매칭에 강점'),
  ('smaxh', null, null, null, '앱 가입 후 이용, 코트·레슨은 시설별 예약', '테니스 코트 예약·레슨·클럽 매칭 통합에 강점'),
  ('pleisure', null, null, null, '앱 가입 후 코트 예약', '테니스 코트 예약 특화'),
  ('theclimb', null, null, null, '회원 가입·통합 회원권 등록 후 지점 이용', '실내 볼더링 지점 통합 회원권에 강점'),
  ('watercleanse', null, null, null, '앱 가입 후 지역 특강 예약', '지역 소규모 수영 특강 예약에 특화'),
  ('ddakple', null, null, null, '앱 가입 후 체육관 검색·예약·결제', '생활체육 체육관 실시간 검색·예약에 강점'),
  ('runday', null, null, null, '가입 후 바로 사용, 무료 이용 중심', '음성 코칭 기반 러닝·걷기 초보 트레이닝에 강점'),
  ('mochaclass', null, null, null, '앱 가입 후 원데이클래스 예약', '요가·필라테스·레저 원데이클래스 예약에 강점'),
  ('play4', null, null, null, '앱 가입 후 프로필 등록·파트너 매칭', '조건별 운동 파트너 AI 매칭에 강점'),
  ('woondoc', null, null, null, '앱 가입 후 트레이너 조회·매칭', '주변 PT·필라테스 트레이너 가격·후기·자격 비교에 강점'),
  ('mobile', null, null, null, '앱 가입 후 러닝 기록·크루 참여', '러닝 대회·크루·기록 관리 통합에 강점'),
  ('runable', null, null, null, '앱 가입 후 대회 접수·코칭 이용', '마라톤 대회 접수와 AI 러닝 코칭 결합에 강점'),
  ('play5', null, null, null, '가입 후 바로 사용, 무료 체험 제공', '사진·대화 기반 AI 칼로리·식단 기록에 강점'),
  ('studiomate', null, null, null, '스튜디오 사업자 가입 후 회원·수업 관리', '필라테스·요가 스튜디오 예약·회원 관리에 강점'),
  ('classworks', null, null, null, '스튜디오 사업자 가입 후 수업·회원 관리', '운동 스튜디오 예약·회원 관리 지원에 강점'),
  ('percentup', null, null, null, '앱 가입 후 헬스장·트레이너 비교·매칭', '헬스장·PT 트레이너 비교·매칭에 강점'),
  ('golfspot', null, null, null, '앱 가입 후 프로·수강생 조건별 매칭', '골프 레슨 프로·수강생 조건 매칭에 강점'),
  ('semos', null, null, null, '앱 가입 후 레저 프로그램 검색·예약', '수영·다이빙·서핑 등 레저스포츠 예약에 강점'),
  ('marathongo', null, null, null, '앱 가입 후 대회·크루 검색', '국내외 마라톤 대회·러닝 크루 통합 검색에 강점'),
  ('plsr', null, null, null, '앱 가입 후 코트 예약·대회 참여', '테니스장 예약과 대회·실력 평가 제공에 강점'),
  ('weddingbook', null, null, null, '앱 가입 후 예약·상담 이용', '웨딩홀·스드메·허니문 예약·후기 통합에 강점'),
  ('iwedding', null, null, null, '가입 후 예약·상담 이용', '웨딩홀 예약·스드메 패키지 종합 준비에 강점'),
  ('directwedding', null, null, null, '가입 후 예약·견적 이용', '웨딩홀·스드메·허니문·혼수 통합 준비에 강점'),
  ('itwed', null, null, null, '가입 후 웨딩홀 찾기·역경매 이용', '웨딩홀 역경매 견적에 강점'),
  ('sinbuya', null, null, null, '가입 후 가격·견적 조회', '웨딩홀·스드메 가격·견적 공개에 강점'),
  ('wedqueen', null, null, null, '앱 가입 후 일정·견적 관리', '결혼 준비 일정·견적 공유에 강점'),
  ('apps5', null, null, null, '앱 가입 후 계획표·업체 추천 이용', '맞춤 계획표·웨딩업체 추천 올인원에 강점'),
  ('oding', null, null, null, '앱 가입 후 스드메 비교·예약', '스드메·본식스냅·스몰웨딩 비교·예약에 강점'),
  ('kingswed', null, null, null, '가입 후 제휴사 예약·셀프 견적', '제휴사 예약·셀프 견적에 강점'),
  ('wedytor', null, null, null, '가입 후 청첩장·예산장 도구 이용', '모바일청첩장·식순·예산장 올인원에 강점'),
  ('kgwed', null, null, null, '가입 후 업체 직거래 연결 이용', '스드메·본식 촬영 직거래 연결에 강점'),
  ('smartweddingpro', null, null, null, '가입 후 웨딩홀 추천·패키지 이용', '웨딩홀 추천·스드메 패키지에 강점'),
  ('houseweddinglink', null, null, null, '가입 후 장소·업체 연결 이용', '스몰·하우스웨딩 장소·업체 연결에 강점'),
  ('haileyhouse', null, null, null, '가입·상담 후 장소·디렉팅 이용', '주택·별장 스몰웨딩 장소·디렉팅에 강점'),
  ('barunsoncard', null, null, null, '온라인 주문·제작 의뢰', '종이·모바일 청첩장 제작에 강점'),
  ('itscard', null, null, null, '가입 후 청첩장 제작·수정', '모바일 청첩장 제작·수정에 강점'),
  ('bojagicard', null, null, null, '가입 후 온라인 셀프 제작·주문(무료 템플릿 대개 제공)', '종이·모바일 청첩장·식전영상 통합 제작에 강점'),
  ('salondeletter', null, null, null, '가입 후 온라인 셀프 제작·주문(무료 템플릿 대개 제공)', '테마·음악 커스텀 모바일 청첩장에 강점'),
  ('toourguest', null, null, null, '가입 후 온라인 셀프 제작·주문(무료 템플릿 대개 제공)', '디자인 템플릿 기반 모바일 청첩장 제작에 강점'),
  ('theirmood', null, null, null, '가입 후 온라인 셀프 제작·주문(무료 템플릿 대개 제공)', '템플릿형 모바일 청첩장 제작에 강점'),
  ('pastelmovie', null, null, null, '가입 후 온라인 셀프 제작·주문(무료 템플릿 대개 제공)', '모바일 청첩장·식전영상 동시 제작에 강점'),
  ('maad', null, null, null, '온라인·매장 예약 후 상담·주문', '결혼반지·예물 웨딩 주얼리에 특화'),
  ('nouv', null, null, null, '온라인·매장 예약 후 상담·주문', '청담 예물 다이아몬드·주얼리에 특화'),
  ('ringplate', null, null, null, '온라인·매장 예약 후 상담·주문', '커스텀 웨딩밴드·커플링 제작에 강점'),
  ('ehoneymoon', null, null, null, '상담·예약 후 상품 결제', '신혼여행지 상품 예약·허니문 전문 상담에 강점'),
  ('palmtour', null, null, null, '상담·예약 후 상품 결제', '몰디브·하와이 등 허니문 상품에 특화'),
  ('hihoneymoon', null, null, null, '상담·예약 후 상품 결제', '신혼여행 상품 예약·허니문 전문 상담에 강점'),
  ('monoscale', null, null, null, '작가 등록 또는 온라인 예약·결제', '본식스냅·웨딩 영상 촬영 예약에 강점'),
  ('wooawedding', null, null, null, '상담·예약 후 이용', '플로리스트·사진·헤어메이크업 통합 섭외·디렉팅에 강점'),
  ('hanboknam', null, null, null, '온라인 예약 후 매장 방문 또는 택배 수령', '경복궁·전주 한복 대여 및 택배 대여에 강점'),
  ('jaengyi', null, null, null, '온라인 예약 후 매장 방문 또는 택배 수령', '온·오프라인 한복 대여에 강점'),
  ('onedayhanbok', null, null, null, '온라인 예약 후 매장 방문 수령', '체험·여행용 한복 대여 예약에 강점'),
  ('dolbokhouse', null, null, null, '온라인 예약 후 매장 방문 또는 택배 수령', '돌복·기념일 한복 대여에 특화'),
  ('filmconnect', null, null, null, '작가 가입 후 포트폴리오 등록·심사', '본식·돌·프로필 스냅/스튜디오 작가 예약·매칭에 강점'),
  ('snaaaper', null, null, null, '작가 가입 후 포트폴리오 등록', '본식·돌·데이트스냅 작가 검색·예약에 강점'),
  ('graphus', null, null, null, '작가 가입 후 포트폴리오 등록', '사진·영상 작가 포트폴리오 검색·중개에 강점'),
  ('apps6', null, null, null, '작가 가입 후 포트폴리오·가격 등록', '프로필·스냅 작가 가격비교·예약에 강점'),
  ('snappi', null, null, null, '작가 가입 후 포트폴리오 등록', '일상·프로필 촬영 작가 매칭에 강점'),
  ('snapcap', null, null, null, '작가 가입 후 포트폴리오 등록', '장소·컨셉·작가 선택 출장 촬영 매칭에 강점'),
  ('honeypic', null, null, null, '작가 가입 후 포트폴리오 등록', '해외 여행지 현지 스냅 작가 매칭에 강점'),
  ('stafpic', null, null, null, '제작사 가입 후 프로필 등록', '영상 촬영·제작사 외주 매칭에 강점'),
  ('videocon', null, null, null, '제작사 가입 후 프로필 등록', '영상 제작사 비교견적 외주에 강점'),
  ('vidfolio', null, null, null, '제작사 가입 후 포트폴리오 등록', '포트폴리오 기반 영상 제작사 매칭에 강점'),
  ('match', null, null, null, '제작사 가입 후 프로필 등록', '기업·영상제작사 비교견적 B2B 매칭에 강점'),
  ('vcrewcorp', null, null, null, '제작사 가입 후 프로필 등록', '영상 제작·편집·촬영 대행 매칭에 강점'),
  ('studiopeople', null, null, null, '온라인 예약·결제 후 이용', '프로필·증명·바디프로필 촬영 예약에 강점'),
  ('successstudio', null, null, null, '가입 후 사진관 운영에 도입·이용', '사진관 예약·고객·매출 관리 솔루션에 특화'),
  ('mcard', null, null, null, '가입 후 온라인 셀프 제작·주문', '바른손 모바일 청첩장·초대장 제작에 강점'),
  ('feelmaker', null, null, null, '가입 후 온라인 셀프 제작(무료 제공)', '스킨 선택 무료 모바일 청첩장 제작에 강점'),
  ('directwedcard', null, null, null, '가입 후 온라인 셀프 제작(무료 제공)', '무료 모바일 청첩장 제작에 강점'),
  ('moiitee', null, null, null, '가입 후 온라인 셀프 제작·주문', '모바일 청첩장·웨딩포스터·식권 셀프 제작에 강점'),
  ('dalpeng', null, null, null, '가입 후 온라인으로 초대장 제작·주문', '청첩장·돌잔치 모바일 초대장 제작에 강점'),
  ('deardeer', null, null, null, '온라인 주문 후 종이·모바일 청첩장 제작', '종이·모바일 청첩장 제작을 함께 제공'),
  ('ofy', null, null, null, '가입 후 온라인으로 초대장 제작·주문', '돌잔치·청첩장 모바일 초대장 제작에 강점'),
  ('life4cut', null, null, null, '가맹·매장 설치는 창업 문의, 이용은 현장 결제', '셀프 즉석 인화 네컷사진 부스에 강점'),
  ('photogray', null, null, null, '가맹·매장 설치는 창업 문의, 이용은 현장 결제', '셀프 촬영 포토부스 네컷사진 브랜드'),
  ('photoair', null, null, null, '행사 단위 렌탈 예약·견적 문의', '출장형 셀프 포토부스 렌탈에 강점'),
  ('partypang', null, null, null, '가입 후 온라인 주문·배달', '파티용품·장식·헬륨풍선 배달에 강점'),
  ('partyhae', null, null, null, '가입 후 온라인 주문', '파티 장식·풍선·이벤트 소품 할인 구매'),
  ('joyparty', null, null, null, '온라인 주문·차량배달 이용', '생일파티용품·풍선 차량배달에 강점'),
  ('rentalfr', null, null, null, '행사 단위 대여 예약·견적 문의', '포토월·바테이블 등 행사용품 렌탈에 강점'),
  ('rentalmonkey', null, null, null, '행사 단위 대여 예약·견적 문의', '테이블 등 행사용품 대여에 강점'),
  ('whitebooth', null, null, null, '행사 단위 렌탈·설치·기획 문의', '행사용품 렌탈에 설치·기획까지 제공'),
  ('partykorea', null, null, null, '행사 단위 케이터링 주문·견적 문의', '개업·기업행사 출장뷔페에 강점'),
  ('koreabuffet', null, null, null, '행사 단위 케이터링 주문·견적 문의', '수도권 출장뷔페·케이터링에 강점'),
  ('awesomeparty', null, null, null, '온라인 주문·배달 이용', '포장 배달형 케이터링·파티박스에 강점'),
  ('roomservicehomeparty', null, null, null, '행사 단위 케이터링 주문·견적 문의', '집들이·모임 홈파티 출장뷔페에 강점'),
  ('justincatering', null, null, null, '온라인 주문·견적 문의', '호텔식 도시락·프리미엄 케이터링에 강점'),
  ('damsoban', null, null, null, '온라인 주문·견적 문의', '셰프·플로리스트 케이터링·도시락에 강점'),
  ('foodsupporters', null, null, null, '가입 후 단체 도시락·케이터링 주문', '단체 도시락·케이터링 주문·배달에 강점'),
  ('fooding', null, null, null, '가입 후 사무실 단체식·간식 주문', '사무실 단체식·간식·케이터링 주문에 강점'),
  ('kukka', null, null, null, '가입 후 정기구독·주문', '꽃 정기구독 온라인 브랜드'),
  ('flipflower', null, null, null, '가입 후 정기구독 신청', '꽃 정기구독 서비스'),
  ('florano', null, null, null, '가입 후 정기구독·주문', '프리미엄 꽃 정기구독·플라워 카페에 강점'),
  ('snowfoxflowers', null, null, null, '가입 후 온라인·매장 주문', '합리적 가격대 꽃 판매에 강점'),
  ('honestflower', null, null, null, '가입 후 온라인 주문·배송', '일상용 꽃 판매·배송에 강점'),
  ('fleurue', null, null, null, '가입 후 정기구독 신청', '일상용 꽃 정기구독에 강점'),
  ('flowerrepublic', null, null, null, '온라인 주문·당일배송 이용', '근조·축하화환·개업선물 당일배송에 강점'),
  ('cultwoflower', null, null, null, '온라인 주문·당일배송 이용', '꽃다발·화환 전국 당일배송에 강점'),
  ('flower119', null, null, null, '온라인 주문·전국 꽃집 배송', '전국 꽃집 네트워크 화환 당일배송에 강점'),
  ('flowerplus', null, null, null, '가입 후 기업용 화환·식물 주문', '기업용 화환·식물 원스톱 배송에 강점'),
  ('biz', null, null, null, '기업 가입 후 대량 발송 주문', '기업용 모바일쿠폰·판촉물 대량발송에 강점'),
  ('barunsonthegift', null, null, null, '가입 후 온라인 주문', '답례품·선물 전문 구매에 강점'),
  ('giftinfo', null, null, null, '주문·제작 견적 문의', '판촉물·기념품·답례품 제작에 강점'),
  ('showgle', null, null, null, '공연팀·의뢰자 가입 후 섭외 매칭', '공연팀·연예인 섭외 매칭에 강점'),
  ('eventnet', null, null, null, '가입 후 전문가·의뢰 매칭 이용', '행사·전시·컨벤션 전문가 매칭에 강점'),
  ('eventplus', null, null, null, '사업자 등록 후 행사 의뢰·업체 매칭 이용', '장비 대여·인력 섭외 등 행사 대행 매칭에 강점'),
  ('myfair', null, null, null, '참가 희망 기업 문의·상담 후 부스 예약', '해외 박람회 부스 예약·현지 파트너 매칭에 특화'),
  ('iex', null, null, null, '전시 참가 기업 견적 문의 후 설치 의뢰', '전시·박람회 부스·포토존 설치 대행에 강점'),
  ('gopropose', null, null, null, '이용자 문의·상담 후 이벤트 대행 예약', '프로포즈·기념일 서프라이즈 이벤트 대행에 특화'),
  ('luvhunter', null, null, null, '이용자 문의·상담 후 이벤트 예약', '프로포즈·기념일 이벤트 대행에 특화'),
  ('haruclass', null, null, null, '강사·업체는 클래스 등록, 이용자는 가입 후 예약', '취미·원데이 클래스 예약·발견에 강점'),
  ('deardayclass', null, null, null, '강사는 클래스 등록, 이용자는 가입 후 예약', '원데이클래스 예약·소개에 특화'),
  ('annaandparty', null, null, null, '이용자 가입 후 상차림 대여 예약', '백일상·돌상 셀프 상차림 대여에 특화'),
  ('pookoodol', null, null, null, '이용자 가입 후 상차림·한복 대여 예약', '돌상·백일상 상차림·한복 대여에 전문'),
  ('dollsdream', null, null, null, '이용자 가입 후 셀프 돌상 대여 예약', '집에서 하는 셀프 돌상 대여에 특화'),
  ('lawtalk', null, null, null, '변호사는 자격 인증 후 프로필 등록, 이용자는 가입 후 상담', '변호사 검색·전화/영상/방문 법률 상담 매칭에 강점'),
  ('lawandgood', null, null, null, '변호사는 자격 인증 등록, 이용자는 질문지 작성 후 이용', '질문지 기반 변호사 제안서 매칭에 특화'),
  ('lawsee', null, null, null, '전문가는 자격 인증 등록, 이용자는 가입 후 상담', '변호사·노무사·세무사 상담 매칭에 강점'),
  ('helpme', null, null, null, '이용자 가입 후 온라인 법률 서비스 신청', '지급명령·법인등기·상속 온라인 처리에 강점'),
  ('albup', null, null, null, '변호사는 자격 인증 등록, 이용자는 앱 가입 후 상담', '이용자·변호사 빠른 연결 법률상담에 특화'),
  ('connects', null, null, null, '전문가는 인증 후 등록, 이용자는 가입 후 유료 상담', '변호사 등 전문가 1:1 유료 상담에 특화'),
  ('lawmaster', null, null, null, '이용자 가입 후 AI 법률 서비스 이용', '내용증명·지급명령 등 AI 법률 문서 작성에 강점'),
  ('lawform', null, null, null, '가입 후 바로 문서 작성·전자서명 이용', '계약서·내용증명 자동작성·전자서명·보관에 강점'),
  ('3o3', null, null, null, '가입·본인인증 후 소득세 신고·환급 조회', '종합소득세 신고·환급 간편 처리에 강점'),
  ('taxmon', null, null, null, '이용자 가입 후 세금 시뮬레이션·상담 이용', '양도·상속·증여세 시뮬레이션·상담에 특화'),
  ('semutong', null, null, null, '세무사는 인증 등록, 이용자는 가입 후 견적 비교', '세무사 수수료·후기 비교·견적 매칭에 강점'),
  ('findsemusa', null, null, null, '세무사는 자격 인증 등록, 이용자는 가입 후 상담', '세무사 실시간 상담 매칭에 강점'),
  ('jobis', null, null, null, '사업자 가입 후 기장·세무신고 대행 이용', '세무사·회계사 기장·세무신고 대행에 특화'),
  ('findsemusa2', null, null, null, '노무사는 자격 인증 등록, 이용자는 가입 후 상담', '노무사 실시간 채팅·전화 상담 매칭에 강점'),
  ('markinfo', null, null, null, '가입 후 상표 검색·출원 신청', '온라인 상표 검색·출원 등록에 강점'),
  ('markinfoglobal', null, null, null, '가입 후 해외 상표등록 절차 신청', '해외 상표등록 절차 지원에 특화'),
  ('modusign', null, null, null, '가입 후 전자서명 요청·체결 이용(무료 플랜 제공)', '전자서명 요청·체결·관리 전자계약에 강점'),
  ('eformsign', null, null, null, '가입 후 전자계약 작성·서명 이용', '전자계약 작성·서명·클라우드 보관에 강점'),
  ('glosign', null, null, null, '가입 후 온라인 계약 체결 이용', '온라인 계약 체결 전자서명에 강점'),
  ('trost', null, null, null, '상담사는 인증 등록, 이용자는 가입 후 상담 예약', '문자·전화·대면 심리상담 매칭에 강점'),
  ('mindcafe', null, null, null, '이용자 가입 후 커뮤니티·원격 상담 이용', '익명 커뮤니티·전문가 원격 심리상담에 강점'),
  ('hellomindcare', null, null, null, '이용자 앱 가입 후 상담 예약·심리검사', '심리상담사 매칭·영상 상담·심리검사에 강점'),
  ('zuzu', null, null, null, '법인·창업자 가입 후 설립·등기·지분 관리 이용', '법인설립·등기·주주·스톡옵션 관리에 강점'),
  ('scil', null, null, null, '이용자 가입 후 채권추심 지원 신청', '채권추심 온라인 종합지원·회수에 강점'),
  ('lbox', null, null, null, '변호사·법조인 가입·인증 후 판례 검색 이용', '방대한 판결문 기반 판례 검색·AI 요약·분석에 강점'),
  ('bhsn', null, null, null, '문의·상담 후 기업 단위 도입', '계약서 검토·기업법무 AI 자동화에 강점'),
  ('seteuk', null, null, null, '가입 후 홈택스·금융 데이터 연동', '거래 자동분류·장부 작성 자동화에 강점'),
  ('pluscompany', null, null, null, '앱 가입·소득자료 연동 후 신고', '프리랜서·직장인 종소세 신고·환급에 강점'),
  ('heumtax', null, null, null, '가입·자료 연동 후 환급 조회', '누락 공제·감면 경정청구 환급에 강점'),
  ('finda', null, null, null, '앱 가입·본인인증 후 조회', '다수 금융사 대출 금리·한도 비교에 강점'),
  ('toss', null, null, null, '가입·본인인증 후 이용', '송금·자산관리·대출비교 통합 금융앱에 강점'),
  ('kakaopay', null, null, null, '가입·본인인증 후 조회', '여러 금융사 대출 한도·금리 일괄 조회에 강점'),
  ('banksalad', null, null, null, '가입·마이데이터 연동 후 이용', '자산 통합관리·대출/카드/보험 비교에 강점'),
  ('dambee', null, null, null, '앱 가입·본인인증 후 조회', '주담대·전세대출 등 담보대출 비교에 강점'),
  ('alda', null, null, null, '앱 가입·본인인증 후 조회', '대출 비교·신청·관리 통합(론테크)에 강점'),
  ('finnq', null, null, null, '가입·본인인증 후 이용', '생활금융·대출/카드/보험 비교에 강점'),
  ('bankmall', null, null, null, '앱 가입·본인인증 후 조회', '주담대·전세·신용대출 비교에 강점'),
  ('cashnote', null, null, null, '사업자 가입·매출 데이터 연동 후 이용', '소상공인 경영관리·사업자대출 비교에 강점'),
  ('einsmarket', null, null, null, '별도 가입 없이 조회', '온라인 보험상품 표준 비교·공시에 강점'),
  ('goodrich', null, null, null, '앱 가입·본인인증 후 이용', '보험 조회·분석·비교·청구 통합관리에 강점'),
  ('bomapp', null, null, null, '앱 가입·본인인증 후 이용', '보험 조회·분석·간편청구 관리에 강점'),
  ('signalplanner', null, null, null, '앱 가입·본인인증 후 이용', '보험 진단·비대면 상담에 강점'),
  ('bodoc', null, null, null, '앱 가입·본인인증 후 이용', 'AI 보험 진단·분석·관리에 강점'),
  ('bohumclinic', null, null, null, '매장 방문·상담 예약 후 이용', '오프라인 매장 기반 보험 점검·설계에 강점'),
  ('insvalley', null, null, null, '본인인증 후 견적 조회', '자동차보험 등 온라인 견적 비교에 강점'),
  ('cardgorilla', null, null, null, '별도 가입 없이 조회', '신용·체크카드 혜택 비교·추천에 강점'),
  ('travelwallet', null, null, null, '앱 가입·카드 발급 후 이용', '다통화 충전·환전·해외결제에 강점'),
  ('wirebarley', null, null, null, '앱 가입·본인인증 후 송금', '저수수료 다국가 해외송금에 강점'),
  ('sentbe', null, null, null, '가입·본인인증 후 송금(개인·사업자)', '개인·사업자 저비용 해외송금에 강점'),
  ('themoin', null, null, null, '앱 가입·본인인증 후 송금', '우대환율·저수수료 해외송금에 강점'),
  ('fint', null, null, null, '가입·투자일임 계약 후 이용', 'AI 로보어드바이저 자동 자산관리에 강점'),
  ('ols', null, null, null, '사업자 대상 온라인 신청', '소상공인 정책자금 안내·신청 창구에 강점'),
  ('paywatch', null, null, null, '사업장(기업) 도입 후 근로자 이용', '급여일 전 근로임금 선지급(EWA)에 강점'),
  ('canopy', null, null, null, '기업 도입 후 근로자 이용', '근무기록 기반 실시간 급여 선정산에 강점'),
  ('ezloan', null, null, null, '앱 가입·본인인증 후 조회', '소액·비상금·무직자 대출 상품 연결에 강점'),
  ('coway', null, null, null, '렌탈 약정·신용조회 후 계약', '생활가전 렌탈·정기 방문관리에 강점'),
  ('skmagic', null, null, null, '렌탈 약정·신용조회 후 계약', '주방·생활가전 렌탈·구독에 강점'),
  ('lge', null, null, null, '구독 약정·신용조회 후 계약', 'LG 가전 월 구독·방문 케어에 강점'),
  ('myomee', null, null, null, '렌탈 약정 후 계약(단기~장기)', '가전·가구·패션 단기~장기 렌탈에 강점'),
  ('hyundairentalcare', null, null, null, '렌탈 약정·신용조회 후 계약', '홈케어 가전 렌탈·관리에 강점'),
  ('chungho', null, null, null, '개인·사업자 신청 후 렌탈 계약(약정 기간)', '정수기·공기청정기·안마의자 렌탈·방문관리'),
  ('hellorental', null, null, null, '개인·사업자 신청 후 렌탈·구독 계약', '생활가전·매트리스 폭넓은 렌탈·구독 라인업'),
  ('xn299ar6vqrd', null, null, null, '가입·신청 후 월납 렌탈 계약', '가전·가구·매트리스 월납 렌탈로 초기비용 완화'),
  ('rentre', null, null, null, '가입 후 렌탈 견적 요청·비교', '가전 렌탈 월요금·조건 비교 견적에 강점'),
  ('closetshare', null, null, null, '가입 후 월정액 구독·대여 신청', '명품 가방·의류 월정액 대여·공유'),
  ('reebonz', null, null, null, '가입 후 대여 신청(보증·심사 가능)', '명품 가방·시계 단기·구독 대여'),
  ('opengallery', null, null, null, '가입 후 월 구독·작품 대여 신청', '원화 미술품 3개월 교체 대여·공간 연출'),
  ('plan', null, null, null, '면허·심사 후 구독·렌트 계약', '월 구독·중장기 차량 렌트에 강점'),
  ('thetrive', null, null, null, '면허·심사 후 월 구독 계약', '수입차 월 구독, 정비·보험 포함 관리'),
  ('hyundai', null, null, null, '면허·심사 후 월 구독 가입', '현대차 월 구독·차종 교체 이용'),
  ('slrrent', null, null, null, '가입·예약 후 대여(보증금 가능)', '카메라·렌즈 촬영장비 단기 대여'),
  ('playslr', null, null, null, '가입·예약 후 대여(보증금 가능)', 'DSLR·미러리스·렌즈 렌탈'),
  ('youtuberental', null, null, null, '가입·예약 후 대여', '고프로 등 유튜브 촬영장비 대여'),
  ('hanent', null, null, null, '가입·예약 후 대여', '카메라·렌즈 촬영장비 대여'),
  ('rrental', null, null, null, '가입·예약 후 대여', '카메라·조명 촬영장비 대여'),
  ('pacey', null, null, null, '가입·심사 후 구독·렌탈 계약', '노트북·맥북 등 IT기기 구독·렌탈'),
  ('arthurrental', null, null, null, '가입·문의 후 대여 계약', '노트북·PC 기업·개인 단기 대여'),
  ('korearental', null, null, null, '기업 문의·심사 후 렌탈 계약', 'PC·계측기·산업장비 종합 렌탈'),
  ('hilti', null, null, null, '기업 계약 후 월 사용료 임대', '전동공구 월정액 임대·관리 프로그램'),
  ('jsrental', null, null, null, '문의·예약 후 대여 계약', '행사·이벤트용품 대여'),
  ('rentalevent', null, null, null, '문의·예약 후 대여 계약', '천막·냉난방·전시 등 행사용품 대여'),
  ('campal', null, null, null, '가입·예약 후 대여', '텐트·타프 등 캠핑용품 대여'),
  ('camproad', null, null, null, '가입·예약 후 대여', '텐트·캠핑장비 대여'),
  ('info', null, null, null, '가입·예약 후 택배·방문 대여', '면접·행사용 정장 저렴한 대여·공유'),
  ('jjinsuit', null, null, null, '예약·방문 후 대여 계약', '프리미엄 맞춤정장 렌탈'),
  ('greant', null, null, null, '가입·예약 후 익일배송 대여', '면접·예복 정장 익일배송 렌탈'),
  ('eshare', null, null, null, '회원가입 후 공공자원 예약·대여', '공공기관 보유 공구·기기·시설 대여'),
  ('ium', null, null, null, '입주 중소기업·제조사 가입 후 이용(무료)', '단지 단위 협력사·거래처 발굴·파트너 매칭'),
  ('officedepot', null, null, null, '사업자·개인 회원가입 후 구매', '사무용품·소모품 온라인 구매'),
  ('officenex', null, null, null, '사업자·개인 회원가입 후 구매', '잉크·토너·사무기기 소모품 구매'),
  ('ioffice', null, null, null, '회원가입 후 구매', '사무용품·비품 온라인 구매'),
  ('officezone', null, null, null, '회원가입 후 구매', '사무용품·문구·비품 종합 구매'),
  ('modenoffice', null, null, null, '기업 회원가입 후 통합구매/견적', '사무용품·MRO 통합구매 시스템'),
  ('mmarket', null, null, null, '기업 회원가입 후 통합구매', '복사용지·공구·안전용품 기업 통합구매'),
  ('imarket', null, null, null, '기업 회원가입 후 구매/견적', '사무·산업재·안전용품 기업 전용 구매'),
  ('imarketkorea', null, null, null, '기업 계약·회원 가입 후 통합구매 이용', '대기업 MRO 통합구매대행·소싱 위탁에 강점'),
  ('serveone', null, null, null, '기업 계약·회원 가입 후 구매 이용', '대량 MRO 구매대행·자재 공급 통합관리에 강점'),
  ('navimro', null, null, null, '사업자등록 후 기업회원 가입·구매', '공구·안전·사무 MRO 기업 전용 원스톱 구매에 강점'),
  ('bipum', null, null, null, '사업자등록 후 기업회원 가입·구매', '청소·위생·사무 비품 일괄 조달에 강점'),
  ('koskomro', null, null, null, '사업자등록 후 가입·구매', '안전용품·공구·건자재 도매가 조달에 강점'),
  ('cretec', null, null, null, '사업자·대리점 가입 후 온라인 주문', '산업공구 유통망·전문 품목 온라인 주문에 강점'),
  ('kr4', null, null, null, '사업자등록 후 회원 가입·카탈로그 주문', 'FA·금형 표준부품 규격 검색·간접자재 소싱에 강점'),
  ('gonggus', null, null, null, '가입 후 구매(사업자 혜택 별도)', '산업·작업공구 폭넓은 품목 온라인 구매에 강점'),
  ('gongguro', null, null, null, '가입 후 구매(사업자 회원 별도)', '공구·안전·베어링 등 산업용품 조달에 강점'),
  ('toolmall', null, null, null, '가입 후 구매', '공구 전문 품목 온라인 구매에 강점'),
  ('tools24', null, null, null, '가입 후 구매', '절삭·수공구·농기계 공구 전문 조달에 강점'),
  ('yugatool', null, null, null, '가입 후 구매', '측정기·전동공구·철물 산업용품 구매에 강점'),
  ('total09', null, null, null, '가입 후 구매', '작업·측정공구·산업용품 전문 조달에 강점'),
  ('dntool', null, null, null, '사업자 가입 후 도매 구매', '산업·측정공구 도매가 조달에 강점'),
  ('ggjt', null, null, null, '사업자 가입 후 구매', '공구·산업용품 종합 품목 사업자 구매에 강점'),
  ('dosomarket', null, null, null, '사업자등록 후 가입·견적 요청/거래', '철강·건자재 견적 비교·거래 매칭에 강점'),
  ('steellink', null, null, null, '사업자등록 후 가입·견적/거래', '철강 실시간 가격정보·온라인 견적 거래에 강점'),
  ('cheolsusee', null, null, null, '사업자등록 후 가입·직거래 요청', '철강 직거래 중개·중간 유통 단축에 강점'),
  ('steelshop', null, null, null, '사업자등록 후 가입·구매', '동국제강 철강재 직접 온라인 주문에 강점'),
  ('fixit', null, null, null, '사업자등록 후 가입·매칭 이용', '자재 공급사·시공업체 연결 건자재 조달에 강점'),
  ('buildersdepot', null, null, null, '가입 후 구매(사업자 도매 별도)', '건축 장식 철물자재 도매 조달에 강점'),
  ('jajaemart', null, null, null, '가입 후 구매', '금속철물·건축자재 온라인 구매에 강점'),
  ('boxmake', null, null, null, '가입 후 구매(사업자 도매 별도)', '택배박스·완충재 포장 부자재 도매 조달에 강점'),
  ('boxvill', null, null, null, '가입 후 주문(제작 문의 별도)', '주문제작 박스·포장 부자재 소량 제작에 강점'),
  ('boxmall', null, null, null, '가입 후 구매', '박스·비닐·포장 부자재 일괄 구매에 강점'),
  ('xncmall', null, null, null, '가입 후 구매', '택배봉투·박스·테이프 포장 부자재 조달에 강점'),
  ('eleparts', null, null, null, '가입 후 구매(사업자 회원 별도)', '반도체·모듈·계측기 전자부품 소싱에 강점'),
  ('devicemart', null, null, null, '가입 후 구매', '아두이노·센서·개발보드 등 개발용 부품 조달에 강점'),
  ('icbanq', null, null, null, '가입 후 구매', '반도체·오픈소스HW 전자부품 소싱에 강점'),
  ('mechasolution', null, null, null, '가입 후 구매', '아두이노·임베디드·교육키트 조달에 강점'),
  ('cleaniglobal', null, null, null, '가입 후 구매(사업자 도매 별도)', '세제·청소도구·건물관리용품 도매 조달에 강점'),
  ('ypcity', null, null, null, '가입 후 구매', '업소용 청소 소모품 도매 조달에 강점'),
  ('hnrjh', null, null, null, '사업자 가입 후 납품 문의·구매', '학교·관공서 청소용품 대량 납품에 강점'),
  ('hansolink', null, null, null, '가입 후 구매(사업자 납품 별도)', '잉크·토너 기업 납품 인쇄소모품 조달에 강점'),
  ('printersmall', null, null, null, '가입 후 구매', '프린터·복합기·잉크·토너 인쇄소모품 조달에 강점'),
  ('916er', null, null, null, '비교견적 요청 후 시공사 매칭', '사무실 인테리어 견적 비교·시공 연결에 강점'),
  ('office0u', null, null, null, '가입 후 매물 등록·광고 게시', '공유오피스·사무실 공유 매물 검색·광고에 강점'),
  ('howmuchisit', null, null, null, '입주 상담·견적 요청 후 중개', '공유오피스 가격 비교·입주 지원금 안내에 강점'),
  ('mroofficedepot', null, null, null, '법인 회원가입 후 구매', '사무용품·비품 통합구매 대행에 강점'),
  ('lalab2b', null, null, null, '사업자등록 후 회원가입', '문구·팬시·사무용품 사업자 도매에 강점'),
  ('themro', null, null, null, '기관·법인 계약 후 이용', '공공기관 대상 소모성자재 구매대행에 강점'),
  ('adprint', null, null, null, '가입 후 주문·시안 제작', '명함·브로셔 등 인쇄물 소량·대량 주문에 강점'),
  ('pojangmall', null, null, null, '가입 후 주문·도매 구매', '에어캡·완충재 등 포장 자재 도매에 강점'),
  ('alwaysbomgift', null, null, null, '제작 문의·견적 후 주문', '기업·공공기관 판촉물·기념품 제작에 강점'),
  ('panchock', null, null, null, '제작 문의·견적 후 주문', '기업 판촉물·기념품 제작 주문에 강점'),
  ('workclo', null, null, null, '제작 상담·견적 후 주문', '작업복·근무복·기업 단체복 맞춤 제작에 강점'),
  ('clicksports', null, null, null, '제작 상담·견적 후 주문', '단체복·작업복·단체패딩 주문 제작에 강점'),
  ('mintcorn', null, null, null, '제작 상담·현장 실측 후 주문', '매장 간판·사인물 실내외 제작에 강점'),
  ('mysign', null, null, null, '디자인·설계 상담 후 제작', '간판 디자인·설계·제작에 강점'),
  ('dwsafety', null, null, null, '가입 후 주문·구매', '보호구 등 산업안전용품 취급에 강점'),
  ('gunjajae24', null, null, null, '사업자 회원가입 후 도매 구매', '건설현장 건축자재·안전용품·MRO 도매에 강점'),
  ('b2btool', null, null, null, '사업자 회원가입 후 도매 구매', '산업·절삭·에어공구 실시간 재고 도매에 강점'),
  ('matched', null, null, null, '기업회원 가입 후 미팅 매칭 신청', '기업 의사결정권자 대상 B2B 영업 미팅 매칭에 강점'),
  ('b2bjoinkorea', null, null, null, '기업회원 가입 후 등록·이용', '제조업 기업정보·B2B 중개·입찰에 강점'),
  ('castingn', null, null, null, '기업회원 가입 후 소싱 등록', '간접구매·외주 전자입찰·전자계약 소싱에 강점'),
  ('smartfactoria', null, null, null, '기업회원 가입 후 수요·공급 등록', '제조 자동화 설비·로봇·비전 공급사 매칭에 강점'),
  ('factoryplatform', null, null, null, '무료 가입 후 발주·매칭 이용', '식품 제조업체·발주기업 매칭에 강점'),
  ('workieum', null, null, null, '기업회원 가입 후 발주·매칭 이용', '제조·외주가공·엔지니어링 업체 발굴 매칭에 강점'),
  ('industrialmarket', null, null, null, '가입 후 매물 등록·직거래', '중고 기계·설비·공구 기업 간 직거래에 강점'),
  ('mc', null, null, null, '가입 후 매물 등록·직거래', '산업기계·장비 B2B 직거래 중개에 강점'),
  ('linkmachine', null, null, null, '가입 후 매물 등록·시세조회', '중고기계 매입·판매·시세조회 직거래에 강점'),
  ('nextunicorn', null, null, null, '가입 후 기업·투자자 프로필 등록', '스타트업·전문투자자 네트워킹에 강점'),
  ('beginmate', null, null, null, '가입 후 프로필 등록·매칭 이용', '공동창업자·초기멤버 팀빌딩 매칭에 강점'),
  ('knowwherebridge', null, null, null, '기업회원 가입 후 매칭 신청', '해외 파트너·바이어 비즈니스 매칭에 강점'),
  ('cretop', null, null, null, '가입·구독 후 조회 이용', '기업 신용·재무 조회·거래처 발굴에 강점'),
  ('kodata', null, null, null, '가입·구독 후 데이터 조회', '기업 신용·산업 데이터 제공에 강점'),
  ('companymarket', null, null, null, '가입 후 매물 등록·중개 이용', '기업거래·사업체 매매 중개에 강점'),
  ('kmx', null, null, null, '가입 후 매도·매수 등록·매칭', '중소기업 M&A 매도·매수 중개·매칭에 강점'),
  ('fanfandaero', null, null, null, '중소기업 가입·심사 후 입점', '중소기업 판로개척 지원에 강점'),
  ('kompass', null, null, null, '기업회원 가입 후 등록·매칭', '글로벌 기업 DB 기반 비즈니스 매칭에 강점'),
  ('capa', null, null, null, '가입 후 도면 업로드로 견적 요청·발주', 'CNC·판금·사출 등 다품종 제조 견적 비교에 강점'),
  ('baroorder', null, null, null, '가입 후 도면 업로드로 실시간 견적·발주', 'AI 실시간 견적 기반 외주가공 발주 속도에 강점'),
  ('pltik', null, null, null, '가입 후 가공 견적 무료 요청·비교', '산업소재 가공 견적 무료 비교에 강점'),
  ('makeit', null, null, null, '가입 후 도면 업로드로 AI 견적·업체 매칭', 'AI 자동 견적과 가공업체 매칭에 강점'),
  ('make', null, null, null, '가입 후 도면·사양 입력으로 공장 매칭', '공장 매칭 기반 제조 비교견적에 강점'),
  ('mpnite', null, null, null, '가입 후 도면 업로드로 다공법 비교견적', '3D프린팅·CNC·판금 등 다공법 비교견적에 강점'),
  ('meviy', null, null, null, '가입 후 3D CAD 업로드로 즉시 견적·주문', '3D CAD 즉시 견적·단납기 부품 조달에 강점'),
  ('ideaaudition', null, null, null, '가입 후 제작 아이디어·발주 등록', '소량 수요 취합으로 금형·사출 제작에 강점'),
  ('madeall3d', null, null, null, '가입 후 3D 파일 업로드로 출력 주문', '웹 자동화 3D프린팅 소량 제작에 강점'),
  ('castingn2', null, null, null, '기업 회원 가입 후 소싱 견적 요청', '기업 간접구매·외주 소싱 견적 통합에 강점'),
  ('koreab2b', null, null, null, '기업 회원 가입 후 구매대행·소싱 의뢰', '제조기업 MRO 구매대행·소싱에 강점'),
  ('speedmall', null, null, null, '사업자 회원 가입 후 자재 구매', '기업 소모품·산업용 자재 조달에 강점'),
  ('esteel4u', null, null, null, '사업자 회원 가입 후 철강 거래', '철강재 온라인 거래·조달에 강점'),
  ('sungple', null, null, null, '가입 후 원료 매매·가공 견적 요청', '재생플라스틱 원료 거래·가공 견적에 강점'),
  ('ic114', null, null, null, '사업자 회원 가입 후 부품 구매', '전자부품 검색·구매 조달에 강점'),
  ('samplepcb', null, null, null, '가입 후 PCB 사양 입력으로 견적·발주', 'PCB 소량·시제품 발주에 강점'),
  ('mpgate', null, null, null, '가입 후 PCB 설계·제작 주문', 'PCB 설계부터 양산까지 원스톱에 강점'),
  ('ecplaza', null, null, null, '사업자 회원 가입 후 상품·기업 등록', '다국어 지원 글로벌 무역 바이어 발굴에 강점'),
  ('rinda', null, null, null, '가입 후 구독으로 바이어 발굴 사용', 'AI 해외 바이어 발굴·콜드메일 자동화에 강점'),
  ('tradlinx', null, null, null, '가입 후 물류 견적 비교·포워딩 의뢰', '수출입 물류비 비교·화물추적에 강점'),
  ('utradehub', null, null, null, '무역업체 회원 가입 후 전자무역 이용', '무역서류·통관·결제 원스톱 처리에 강점'),
  ('sourcingchina', null, null, null, '가입 후 소싱·수입 대행 의뢰', '중국 OEM/ODM 소싱·수입통관 대행에 강점'),
  ('g2b', null, null, null, '사업자 등록 후 조달청 입찰 참가등록 필요', '공공입찰·조달 참여의 공식 창구에 강점'),
  ('g2bplus', null, null, null, '가입 후 구독으로 입찰분석·알림 사용', '공공입찰 정보 AI 분석·알림에 강점'),
  ('kbid', null, null, null, '가입 후 구독으로 입찰정보 열람', '공공·민간 입찰공고 통합 검색에 강점'),
  ('modoobid', null, null, null, '가입 후 구독으로 입찰분석·투찰가 산출', '빅데이터 투찰가 산출·입찰분석에 강점'),
  ('marketbom', null, null, null, '유통사·거래처 가입 후 수발주 관리', '식자재 유통 수발주·거래처 관리에 강점'),
  ('foodspring', null, null, null, '사업자 회원 가입 후 식자재 주문', '외식업 식자재 오픈마켓·익일배송에 강점'),
  ('kitchenboard', null, null, null, '식당 회원 가입 후 주문·비용관리', '식당 식자재 주문·비용관리에 강점'),
  ('orderplus', null, null, null, '사업자 회원 가입 후 가격 비교·주문', '식자재 가격 비교·주문에 강점'),
  ('parado', null, null, null, '사업자 회원 가입 후 식자재 주문', '산지직송 식자재 도매 조달에 강점'),
  ('orderhero', null, null, null, '사업자 회원 가입 후 식자재 발주', '직매입 기반 식자재 통합 발주에 강점'),
  ('kafb2b', null, null, null, '사업자·중도매인 가입 후 도매 거래', '농수산물 온라인 공영도매 거래에 강점'),
  ('luckyfresh', null, null, null, '사업자 회원 가입 후 도매 주문·발주', '과일·농산물 도매 위탁판매·자동발주에 강점'),
  ('odyb2b', null, null, null, '사업자 회원 가입 후 수산물 도매 주문', '냉동수산물 B2B 도매 조달에 강점'),
  ('koke', null, null, null, '사업자등록 후 도매 거래처 가입', '카페·식당 대상 원두·용품 도매 납품에 강점'),
  ('coffeeb2b', null, null, null, '사업자등록 후 도매 회원가입', '원두·시럽 등 카페 원부자재 소싱에 강점'),
  ('baljuora', null, null, null, '도입 문의·계약 후 이용', '거래처 주문·정산·발주 자동화에 강점'),
  ('baljumoa', null, null, null, '가입·계약 후 이용', '온라인 유통 판매 통합관리·발주에 강점'),
  ('cmtstory', null, null, null, '사업자등록 후 도매 회원가입', 'K-뷰티 화장품 도매·위탁판매 소싱에 강점'),
  ('beautydome', null, null, null, '사업자등록 후 도매 회원가입', '화장품 종합 도매 소싱에 강점'),
  ('realflower', null, null, null, '사업자등록 후 도매 회원가입', '생화 도매 위탁·배송에 강점'),
  ('bizinfo', null, null, null, '무료 가입·기업 인증 후 이용', '중소기업·소상공인 정부지원사업 공고 통합 조회에 강점'),
  ('smes', null, null, null, '회원가입·사업자 인증 후 신청', '중소벤처기업 지원사업 조회·온라인 신청에 강점'),
  ('kstartup', null, null, null, '회원가입 후 이용', '창업·스타트업 정부지원사업 정보 제공에 강점'),
  ('tigris', null, null, null, '가입 후 이용', '정부지원사업 검색·관리에 강점'),
  ('kfund', null, null, null, '가입 후 조건 설정·알림 수신', '정부지원사업 공고 맞춤 알림에 강점'),
  ('works', null, null, null, '가입 후 이용', '정부지원사업 통합 조회·관리에 강점'),
  ('winkstone', null, null, null, '사업자 심사 후 이용', '중소사업자 대상 B2B 대출·BNPL 금융 제공에 강점'),
  ('loanboss', null, null, null, '사업자 정보 입력 후 비교·상담', '소상공인·중소기업 사업자대출 비교에 강점'),
  ('thevc', null, null, null, '가입 후 데이터 조회', '국내 스타트업 투자·지원사업 데이터 조회에 강점'),
  ('startupplus', null, null, null, '가입·프로필 등록 후 이용', '스타트업과 투자자 매칭에 강점'),
  ('barobill', null, null, null, '사업자 가입 후 이용', '전자세금계산서 발급·역발행 대행에 강점'),
  ('popbill', null, null, null, '사업자 가입·API 연동 후 이용', '전자세금계산서 대량발행 API 연동에 강점'),
  ('factoring', null, null, null, '사업자 심사 후 이용', '중소기업 매출채권 팩토링 자금조달에 강점'),
  ('sellerline', null, null, null, '온라인 셀러 가입·심사 후 이용', '온라인 셀러 맞춤 선정산 자금화에 강점'),
  ('allra', null, null, null, '온라인 셀러 가입 후 이용', '온라인 셀러 자금관리·선정산에 강점'),
  ('home3', null, null, null, '쇼핑몰 연동·심사 후 이용', '쇼핑몰 매출 기반 선정산 자금화에 강점'),
  ('ofin', null, null, null, '사업자 가입·심사 후 이용', 'B2B 후불결제·즉시정산에 강점'),
  ('gowid', null, null, null, '법인 가입·심사 후 발급', '법인카드·지출관리·SaaS 혜택 통합에 강점'),
  ('spendit', null, null, null, '법인 가입 후 이용', '스타트업 법인카드·경비 지출관리에 강점'),
  ('unipost', null, null, null, '도입 문의·계약 후 이용', '임직원 경비지출 디지털 증빙 관리에 강점'),
  ('granter', null, null, null, '가입·계약 후 이용', '스타트업 AI 재무·회계 자동화에 강점'),
  ('scordi', null, null, null, '가입 후 SaaS 연동·이용', '기업 SaaS 구독 통합관리·비용분석에 강점'),
  ('smply', null, null, null, '가입 후 이용', '사내 SaaS 사용·결제 현황 관리에 강점'),
  ('flex', null, null, null, '도입 문의·계약 후 이용', '근태·급여·인사 통합 HR 관리에 강점'),
  ('ustracloud', null, null, null, '도입 문의·계약 후 이용', '인사·근태·급여 클라우드 통합 관리에 강점'),
  ('quotabook', null, null, null, '가입·계약 후 이용', '비상장기업 주주명부·증권 관리에 강점'),
  ('lezhin', null, null, null, '작가 심사·계약 후 연재', '유료 결제 기반 웹툰 연재·수익화에 강점'),
  ('muzeplatform', null, null, null, '가입 후 음원 등록·유통', '국내외 사이트로 음원 유통에 강점'),
  ('topport', null, null, null, '작가 등록·심사 후 작품 발행', 'NFT 기반 디지털 아트 발행·거래에 강점'),
  ('weverse', null, null, null, '아티스트·기획사 협의 입점, 팬은 가입 후 이용', '글로벌 팬덤 커뮤니티·팬 콘텐츠 연계에 강점'),
  ('artmug', null, null, null, '작가·의뢰자 가입 후 프로필 등록', '일러스트·Live2D 창작 외주·커미션 매칭에 강점'),
  ('learningspoons', null, null, null, '수강생 가입, 강사는 제안·심사 후 개설', '데이터·마케팅·금융 실무 직무교육에 강점'),
  ('programmers', null, null, null, '가입 후 코딩테스트·강의 이용', '코딩테스트·개발자 취업 교육에 강점'),
  ('wecode', null, null, null, '지원·선발 후 부트캠프 수강', '개발자 양성 집중 부트캠프에 강점'),
  ('supercoding', null, null, null, '지원·등록 후 수강', '관리형 개발자 취업 부트캠프에 강점'),
  ('speak', null, null, null, '가입 후 구독·이용(체험 대개 제공)', 'AI 음성인식 기반 영어 스피킹 훈련에 강점'),
  ('cambly', null, null, null, '가입 후 구독 이용, 튜터는 지원·등록', '원어민 1:1 화상 영어회화에 강점'),
  ('ringleplus', null, null, null, '가입 후 수업 예약·구독', '원어민 1:1 화상영어·AI 스피킹에 강점'),
  ('ebsi', null, null, null, '가입 후 무료·유료 강의 수강', '고교 인터넷 강의·수능 대비에 강점'),
  ('kimstudy', null, null, null, '학생·교사 가입 후 매칭', '과외 교사 매칭에 강점'),
  ('qanda', null, null, null, '학생·교사 가입 후 매칭', '검증 교사 1:1 온라인 과외 매칭에 강점'),
  ('gawebada', 'low', '중개 수수료 0% 표방', null, '학생·교사 가입 후 직접 매칭', '수수료 없는 과외 직접 매칭에 강점'),
  ('wjthinkbig', null, null, null, '구독 신청·학습기기 이용', 'AI 맞춤 초등 스마트학습에 강점'),
  ('milkt', null, null, null, '구독 신청·학습기기 이용', '화상관리형 초등 스마트학습에 강점'),
  ('symentor', null, null, null, '가입 후 앱 구독·이용', '게임형 유아 한글·영어 학습에 강점'),
  ('mydoctor', null, null, null, '가입 후 이용, 병원·약국은 제휴', '비대면 진료·약국찾기·병원예약 연계에 강점'),
  ('platpharm', null, null, null, '약국 사업자 등록 후 이용', '약국 의약품 거래·주문·정산에 강점'),
  ('hihealth', null, null, null, '가입 후 예약, 검진기관은 제휴', '건강검진 할인·실시간 예약에 강점'),
  ('drdiary', null, null, null, '가입 후 앱 이용', '혈당·당뇨 등 만성질환 자가관리에 강점'),
  ('caring', null, null, null, '이용자 상담 신청, 요양보호사는 등록', '방문요양·재가 돌봄 서비스에 강점'),
  ('neofect', null, null, null, '가입·기기 이용', 'AI 홈 재활훈련 헬스케어에 강점'),
  ('edgc', null, null, null, null, '유전자 검사 기반 바이오 헬스케어에 강점'),
  ('pilly', null, null, null, '문진 후 구독 신청', '1:1 맞춤 영양제 정기구독에 강점'),
  ('iamiam', null, null, null, '문진·분석 후 구독 신청', 'AI 분석 맞춤 건강기능식품 구독에 강점'),
  ('fitamin', null, null, null, '약사 상담 후 구독 신청', '약사 상담 맞춤 영양제 구독에 강점'),
  ('rallit', null, null, null, '구직자 가입·프로필 등록, 기업은 채용 등록', 'IT 인재 채용·프로필 매칭에 강점'),
  ('jobda', null, null, null, '구직자 가입·역량검사 응시, 기업은 채용 등록', '역량검사 기반 취업 매칭에 강점'),
  ('sherlockn', null, null, null, '구직자 가입, 헤드헌터가 추천', '헤드헌터 인재 추천 매칭에 강점'),
  ('hiddenscout', null, null, null, '구직자 가입, 다수 헤드헌터가 추천', '다수 헤드헌터 경쟁 추천에 강점'),
  ('bzpp', null, null, null, '구직자 가입·프로필 등록, 기업은 채용 등록', '임원·경력직 핵심인재 채용에 강점'),
  ('dongnealba', null, null, null, '구직자·사장 가입 후 이용', '지역 기반 알바 역제안 매칭에 강점'),
  ('connectin', null, null, null, '근로자·현장 가입 후 매칭', '건설 근로자·현장 인력 중개에 강점'),
  ('workmeet', null, null, null, '근로자·구인자 가입 후 매칭', '일용직 구인구직 인력 매칭에 강점'),
  ('jobploy', null, null, null, '구인기업 가입 후 채용공고 등록(구직자 무료)', '외국인 근로자 채용 매칭에 특화'),
  ('itdaa', null, null, null, '가입 후 멘토·멘티 프로필 등록', '현직자 멘토링 기반 취업 준비 지원'),
  ('thehelper', null, null, null, '보호자·간병인 가입 후 매칭 이용', '보호자가 간병인을 직접 고르는 매칭'),
  ('carenation', null, null, null, '앱 가입 후 간병 요청·인력 등록', '간병·돌봄 인력 매칭에 강점'),
  ('ninehire', null, null, null, '가입 후 사용(무료 플랜 제공)', '채용 전 과정 자동화 올인원 ATS'),
  ('jiwon', null, null, null, '가입 후 사용', '채용 플랫폼 통합관리·스카우트 지원'),
  ('mobiletax', null, null, null, '앱 가입 후 세무사 배정 신청', '1:1 세무사 배정 모바일 세무대리'),
  ('gommark', null, null, null, '가입 후 출원 의뢰', '온라인 상표·특허 출원 대행'),
  ('widsign', null, null, null, '가입 후 계약서 발송(무료 플랜 대개 제공)', '클라우드 전자계약·본인인증'),
  ('ucansign', null, null, null, '가입 후 사용', '저비용 전자계약에 강점'),
  ('hancomsign', null, null, null, '가입 후 사용', '한컴 문서 연계 전자계약·서명'),
  ('donue', null, null, null, '가입 후 사용', '인증서 없이 쓰는 간편 전자계약'),
  ('matazoo', null, null, null, '가입 후 보관 신청', '개당 단위 픽업·보관 짐 보관'),
  ('sendy', null, null, null, '화주·차주 가입 후 이용', '용달·화물 운송 매칭·정산에 강점'),
  ('kurlynextmile', null, null, null, '화주 기업 제휴·운송 문의', '콜드체인 새벽배송 라스트마일 운송'),
  ('goodsflow', null, null, null, '가입 후 쇼핑몰 연동 사용', '주문수집·배송추적·반품 자동화 SCM'),
  ('btorage', null, null, null, '가입 후 주문·배송대행 이용', '한국상품 해외 역구매·배송대행'),
  ('tagby', null, null, null, '광고주 가입 후 캠페인 등록', '인플루언서 체험단 모집·운영 올인원'),
  ('brickc', null, null, null, '광고주 가입 후 캠페인 등록', '인플루언서 마케팅 캠페인 운영'),
  ('itfl', null, null, null, '광고주·인플루언서 가입 후 이용', '브랜드-인플루언서 매칭'),
  ('assaview', null, null, null, '광고주 가입 후 체험단 모집', '블로그·인스타 체험단 리뷰 마케팅'),
  ('realreview', null, null, null, '광고주 가입 후 캠페인 등록', '체험단·인플루언서 리뷰 마케팅'),
  ('reviewnote', null, null, null, '광고주 가입 후 체험단 모집', '블로그·인스타·유튜브 체험단 운영'),
  ('stylec', null, null, null, '가입 후 체험단 모집·신청', '블로그 체험단 모집·신청'),
  ('brixcorp', null, null, null, '가입 후 공동구매 이용', '인플루언서 공동구매 모집·판매 대행'),
  ('flexmatch', null, null, null, '가입 후 매칭 이용', '크리에이터 공동구매·협찬 매칭'),
  ('srookpay', null, null, null, '판매자 가입 후 사용', 'SNS 공동구매 간편결제·판매관리'),
  ('celebtion', null, null, null, '가입 후 공동구매 이용', '인플루언서 공동구매 중개·정산'),
  ('popomon', null, null, null, '가입 후 매칭 이용', '인플루언서 체험단·협찬 매칭'),
  ('cellypick', null, null, null, '가입 후 이용', '인플루언서 커머스 판매·정산 지원'),
  ('creatorlink', null, null, null, '가입 후 바로 제작(무료 플랜 제공)', '무료 홈페이지·쇼핑몰 제작 빌더'),
  ('bigin', null, null, null, '가입 후 쇼핑몰 연동 사용', '이커머스 CRM 마케팅 자동화'),
  ('datarize', null, null, null, '가입·연동 후 사용', 'AI 기반 이커머스 CRM 자동화'),
  ('notifly', null, null, null, '가입 후 앱·웹 연동 사용', '앱·웹 CRM 마케팅 자동화'),
  ('igotcha', null, null, null, '앱 가입 후 구독 신청', '구독형 방문세차 예약에 강점'),
  ('chaevi', null, null, null, '충전 인프라 사업자·시설 대상 도입 문의', '전기차 충전 예약·결제 원스톱 처리에 강점'),
  ('socar', null, null, null, '앱 가입·운전면허 등록 후 이용', '단기 카셰어링·비대면 차량 이용에 강점'),
  ('carmoa', null, null, null, '이용자 앱 가입 후 예약; 렌트업체 제휴 입점', '중소 렌트카 업체 통합 비교·예약에 강점'),
  ('zzimcar', null, null, null, '앱 가입 후 예약', '렌트카·항공·숙소 실시간 가격비교에 강점'),
  ('skdirect', null, null, null, '온라인·상담 통한 렌트 계약', '장·단기 직영 렌터카 운영에 강점'),
  ('rtplanner', null, null, null, '견적 요청 후 상담 진행', '장기렌트·자동차리스 견적 비교에 강점'),
  ('modoobike', null, null, null, '라이더·사업자 대상 렌트·리스 계약', '배달용 이륜차 렌트·리스에 강점'),
  ('arentalnservice', null, null, null, '라이더·사업자 대상 렌탈 신청', '배달 이륜차 렌탈·전국 배송에 강점'),
  ('bikebank', null, null, null, '사업자 대상 렌트·리스 계약', '비즈니스 이륜차 렌트·리스 솔루션에 강점'),
  ('tayota', null, null, null, '라이더·사업자 대상 리스·렌트 계약', '배달 이륜차 리스·렌트 가격 경쟁력에 강점'),
  ('moduparking', null, null, null, '이용자 앱 가입; 주차장 소유자 공유 등록', '주차장 검색·공유주차·할인에 강점'),
  ('gcoo', null, null, null, '앱 가입·면허 인증 후 이용', '전동킥보드·전기자전거 공유 이동에 강점'),
  ('33m2', null, null, null, '임대인 매물 등록; 이용자 앱 가입 후 예약', '저보증금 단기 원룸 임대에 강점'),
  ('liveanywhere', null, null, null, '호스트 숙소 등록; 이용자 가입 후 예약', '한달살기·단기임대 숙소 중개에 강점'),
  ('zaritalk', null, null, null, '임대인·세입자 가입 후 이용', '임대인·세입자 임대관리에 강점'),
  ('ezrems', null, null, null, '가입·구독 후 이용', '임대·자산관리 클라우드 운영에 강점'),
  ('thebldgs', null, null, null, '가입 후 이용; 사업자 도입 문의', 'AI 기반 건물·임대 통합 관리에 강점'),
  ('interiorbay', null, null, null, '이용자 견적 요청; 시공업체 입점 등록', '인테리어 비교견적 중개에 강점'),
  ('apartmentary', null, null, null, '상담·견적 후 시공 계약', '표준화 아파트 리모델링 시공에 강점'),
  ('drbuild', null, null, null, '건축주 가입 후 프로젝트 등록; 시공사 입점', 'AI 건축사·시공사 매칭에 강점'),
  ('howbuild', null, null, null, '건축주 가입 후 프로젝트 등록; 건설사 입점', '건설사 선정·공사관리 지원에 강점'),
  ('fivespot', null, null, null, '입주 문의·계약 후 이용', '1인·소형 사무실 공유오피스에 강점'),
  ('camplink', null, null, null, '이용자 앱 가입 후 예약; 캠핑장 제휴 등록', '캠핑장 예약·빈자리 알림에 강점'),
  ('tamnao', null, null, null, '이용자 가입 후 예약; 제주 업체 제휴', '제주 렌트카·숙소·관광 할인 예약에 강점'),
  ('discoverjeju', null, null, null, '이용자 가입 후 예약; 체험업체 입점', '제주 로컬 액티비티·체험 예약에 강점'),
  ('sunsang24', null, null, null, '이용자 가입 후 예약; 선사 입점 등록', '선상낚시·배낚시 실시간 예약에 강점'),
  ('usin', null, null, null, '이용자 가입 후 예약; 선사·낚시터 입점', '낚시배·낚시터 통합 예약에 강점'),
  ('athlit', null, null, null, '이용자 가입 후 예약; 운동시설 제휴 등록', '드랍인 운동 클래스 예약에 강점'),
  ('farmstay', null, null, null, '이용자 가입 후 예약; 참여 농가 등록', '농촌체험·팜스테이 숙박 예약에 강점'),
  ('welchon', null, null, null, '이용자 가입 후 이용; 체험마을 등록', '농어촌체험휴양마을 정보·예약에 강점'),
  ('farmerstore88', null, null, null, '판매 농가·소기업 입점 신청; 사업자등록 필요', '농가·소기업 산지직송 D2C 판매에 강점'),
  ('kgfarmmall', null, null, null, '구매자 가입; 판매·유통사 입점', '비료·농약·농자재 온라인 구매에 강점'),
  ('smartfarmkorea', null, null, null, '가입 후 이용', '스마트팜 정보·교육·솔루션 제공에 강점'),
  ('nthing', null, null, null, '사업자 도입 문의', '컨테이너형 수직농장 AI 스마트팜에 강점'),
  ('slf', null, null, null, '직매장·출하 농가 대상 도입', '로컬푸드 직매장 출하·정산 운영에 강점'),
  ('farmdy', null, null, null, '가입 후 바로 사용(무료 앱)', 'AI 병해충 진단·영농일지 관리에 강점'),
  ('tpirates', null, null, null, '가입 후 바로 사용(무료 앱)', '수산물 당일 시세·시장 정보 조회에 강점'),
  ('baroinfo', null, null, null, '가입 후 바로 사용(정보 조회)', '로컬푸드 직매장·직거래 정보 탐색에 강점'),
  ('hiver', null, null, null, '사업자등록·통신판매업 신고 후 브랜드 입점', '남성 전용 패션 큐레이션에 강점'),
  ('houseof', null, null, null, '사업자등록 후 디자이너 브랜드 입점', '디자이너 브랜드 편집·커뮤니티 결합에 강점'),
  ('fetching', null, null, null, '사업자등록 후 브랜드·셀러 입점', '디자이너·럭셔리 셀렉트에 강점'),
  ('resellground', null, null, null, '가입·본인인증 후 판매 등록', '명품가방 시세 기반 중고 거래에 강점'),
  ('fount', null, null, null, '가입·계좌 연동 후 이용', 'AI 로보어드바이저 자산관리에 강점'),
  ('honestfund', null, null, null, '가입 후 투자자·차입자 등록', 'AI 신용분석 기반 P2P 투자·대출에 강점'),
  ('piece', null, null, null, '가입·투자자 등록 후 이용', '명품시계·미술품 현물 조각투자에 강점'),
  ('seoulexchange', null, null, null, '가입·본인인증 후 이용', '비상장·장외주식 거래에 강점'),
  ('ustockplus', null, null, null, '가입·증권계좌 연동 후 이용', '비상장주식 거래·시세 조회에 강점'),
  ('alphasquare', null, null, null, '가입·증권계좌 연동 후 이용', '차트·분석 통합 트레이딩 환경에 강점'),
  ('tosspayments', 'mid', '결제수단·업종별 상이 PG 수수료', null, '사업자 심사·계약 후 연동', '온라인 결제 PG 인프라·개발 연동에 강점'),
  ('itemmania', null, null, null, '가입·본인인증 후 거래', '게임 아이템·계정·머니 안전거래 중개에 강점'),
  ('itembay', null, null, null, '가입·본인인증 후 거래', '게임머니·아이템 시세 조회·안전거래에 강점'),
  ('idfarm', null, null, null, '가입·본인인증 후 거래', '계정·게임머니·상품권 거래에 강점'),
  ('gamemarket', null, null, null, '인증 판매자 등록 후 거래', '인증 판매자 기반 게임 계정·아이템 거래에 강점'),
  ('barotem', null, null, null, '가입·본인인증 후 거래', '계정·게임머니·상품권 거래에 강점'),
  ('acon3d', null, null, null, '작가 입점 신청·심사 후 에셋 판매', '웹툰·게임용 3D 배경 등 디지털 에셋 유통에 강점'),
  ('directg', null, null, null, '퍼블리셔·사업자 계약 후 입점', 'PC·콘솔 게임 다운로드 키 유통에 강점'),
  ('phocamarket', null, null, null, '가입 후 프로필 등록·거래', 'K-POP 포토카드 시세·안전거래에 강점'),
  ('wyyyes', null, null, null, '가입 후 판매자 등록·라이브 거래', '트레이딩카드 라이브 수집 거래에 강점'),
  ('gigs', null, null, null, '가입 후 코치 프로필 등록', '롤·발로란트 등 전문가 게임 코칭에 강점'),
  ('lolcoach', null, null, null, '가입 후 코치 등록·매칭', '롤 1:1 코칭에 강점'),
  ('monthlytoy', null, null, null, '가입·결제 후 정기구독', '취미 키트 정기 구독 배송에 강점'),
  ('hobbyinthebox', null, null, null, '가입 후 구매, 작가 입점 신청', '직접 만드는 DIY 창작 키트 판매·구매에 강점'),
  ('ozjejakso', null, null, null, '가입 후 디자인 업로드·제작 주문', '굿즈 디자인·소량 제작·배송 원스톱에 강점'),
  ('villagebaby', null, null, null, '가입 후 이용', '임신·출산 콘텐츠와 커머스 결합에 강점'),
  ('mmtalk', null, null, null, '가입·병원 연동 후 이용', '초음파 영상·임신출산 정보 제공에 강점'),
  ('zzimkong', null, null, null, '사업자등록 후 입점', '유아동 패션·가구 큐레이션에 강점'),
  ('kidikidi', null, null, null, '사업자등록 후 브랜드 입점', '유아동 패션 브랜드 편집샵에 강점'),
  ('yugacrew', null, null, null, '가입 후 동네 인증·이용', '동네 기반 육아친구·정보 교류에 강점'),
  ('momsdiary', null, null, null, '가입 후 이용(무료 앱)', '임신·육아 일기와 포토북 출판에 강점'),
  ('smartowl', null, null, null, '가입·구독 신청 후 대여', '유아·초등 전집·영어책 무제한 대여에 강점'),
  ('buggyfriend', null, null, null, '가입 후 온라인 예약·픽업으로 이용', '제주 여행 시 유모차·카시트 단기 대여에 강점'),
  ('barfdog', null, null, null, '가입 후 구독 신청·정기배송 이용', '강아지 맞춤 생식 식단 정기배송에 강점'),
  ('comestay', null, null, null, '가입 후 반려견 동반 숙소 검색·예약', '반려견 동반 여행 숙소 예약에 강점'),
  ('mypetplus', null, null, null, '앱 설치 후 동물병원 검색·비교', '동물병원 가격 비교·탐색에 강점'),
  ('petping', null, null, null, '가입 후 서비스·기기 연동 이용', '반려동물 건강 데이터 관리에 강점'),
  ('airdny', null, null, null, '펫시터·이용자 가입 후 프로필 등록·매칭', '반려동물 돌봄·산책 펫시터 매칭에 강점'),
  ('rentalfriend', null, null, null, '가입 후 렌탈 상품 비교·상담 신청', '정수기·가구 렌탈 조건 비교에 강점'),
  ('alphabox', null, null, null, '가입 후 보관 공간 예약·이용', '무인 24시간 셀프스토리지 짐보관에 강점'),
  ('dalock', null, null, null, '가입 후 창고 공간 예약·이용', '온습도 관리 개인 물품 보관에 강점'),
  ('myzzym', null, null, null, '가입 후 보관처 검색·예약', '짐보관 창고 중개·연결에 강점'),
  ('select', null, null, null, '가입 후 월정액 구독 이용', '전자책 무제한 구독 열람에 강점'),
  ('ablanc', null, null, null, '가입 후 월정액 구독 대여 이용', '명품 가방 월정액 대여 구독에 강점'),
  ('streamingwear', null, null, null, '가입 후 월정액 의류 구독 이용', '패션 의류 정기구독 대여에 강점'),
  ('serieseight', null, null, null, '가입 후 명품 가방 대여 이용', '명품 가방 단기 대여에 강점'),
  ('kocorental', null, null, null, '개인·사업자 가입 후 렌탈 상담·계약', '노트북·복합기 등 사무기기 렌탈에 강점'),
  ('lotterental', null, null, null, '사업자 문의 후 렌탈 계약·A/S', '사무용 IT기기 종합 렌탈과 A/S에 강점'),
  ('repercent', null, null, null, '앱에서 시세 조회 후 매입 신청', '중고폰 시세 기반 매입에 강점'),
  ('sello', null, null, null, '앱 가입 후 비대면 판매 신청', '비대면 중고폰 판매 처리에 강점'),
  ('repickus', null, null, null, '가입 후 가전·가구 매입·거래 신청', '중고 가전·가구 재활용 거래에 강점'),
  ('refurlab', null, null, null, '가입 후 리퍼·중고 제품 구매', '리퍼·중고 노트북·태블릿 구매에 강점'),
  ('watchexchange', null, null, null, '가입 후 매물 등록·시세 조회', '명품시계 매물·시세 확인에 강점'),
  ('xgolf', null, null, null, '가입 후 골프장 검색·예약', '국내·일본 골프장 예약과 조인에 강점'),
  ('golfmon', null, null, null, '앱 가입 후 부킹·조인 예약', '골프 부킹·조인·해외골프 통합 예약에 강점'),
  ('moolban', null, null, null, '앱 가입 후 낚시 예약', '바다·민물 낚시 실시간 예약에 강점'),
  ('wrightbrothers', null, null, null, '가입 후 자전거 등록·인증 거래', '인증 기반 중고 자전거 거래에 강점'),
  ('market', null, null, null, '사업자등록·통신판매업 신고 후 입점', '골프용품 전문 오픈마켓 판매에 강점'),
  ('hellin', null, null, null, '트레이너 가입 후 회원·일정 관리', 'PT 트레이너 운동일지·회원관리에 강점'),
  ('tranggle', null, null, null, '앱 가입 후 활동 기록·커뮤니티 이용', '등산·자전거 GPS 기록과 배지 커뮤니티에 강점'),
  ('apple', null, null, null, '앱 가입 후 경로 기록·공유', '등산·걷기 경로 기록과 사진 마커에 강점'),
  ('myweddingdiary', null, null, null, '가입 후 웨딩홀 견적 비교·조회', '웨딩홀 견적서 원본 비교에 강점'),
  ('snaplink', null, null, null, '작가·이용자 가입 후 프로필 등록·매칭', '여행·웨딩 스냅작가 AI 매칭에 강점'),
  ('snapsta', null, null, null, '가입 후 작가 검색·촬영 예약', '웨딩·돌잔치 스냅 촬영 예약에 강점'),
  ('ssople', null, null, null, '가입 후 파티룸 검색·예약', '프라이빗 파티룸 예약에 강점'),
  ('amuse', null, null, null, '문의·상담 후 행사 기획 대행 계약', '축제·MICE 행사 기획 대행에 강점'),
  ('dailoz', null, null, null, '가입 후 꽃 정기구독 신청', '주기별 꽃 정기구독 배송에 강점'),
  ('autopartsner', null, null, null, '회원가입 후 차종별 부품 검색·구매', '국산·수입·상용차 부품 폭넓은 취급에 강점'),
  ('myungcha', null, null, null, '회원가입 후 구매', '벤츠·BMW·아우디 등 수입차 부품 특화'),
  ('hellowcar', null, null, null, '회원가입 후 순정부품 구매', '현대모비스 순정부품 공식 대리점 채널'),
  ('partsro', null, null, null, '회원가입 후 VIN·부품번호 조회 구매', '부품번호·VIN 조회로 순정부품 정확 매칭'),
  ('tstation', null, null, null, '앱·웹 가입 후 매장 예약', '한국타이어 타이어 예약·차량관리 원스톱'),
  ('bluetire', null, null, null, '가입 후 타이어 구매·장착 예약', '넥센타이어 공식몰, 장착점 배송·예약 연계'),
  ('parts114', null, null, null, '회원가입 후 구매', '수입차 부품 전문 취급에 강점'),
  ('pcarmall', null, null, null, '회원가입 후 구매', '엔진오일·요소수 등 소모품·차량용품 종합'),
  ('nebaqui', null, null, null, '회원가입 후 구매', '시트·매트 등 자동차 인테리어 용품 특화'),
  ('reitwagen', null, null, null, '회원가입 후 매물 등록·구매', '중고 이륜차 거래·할부 연계에 강점'),
  ('bstore', null, null, null, '회원가입 후 구매', '차량용 블랙박스 전문 취급'),
  ('gongim', null, null, null, '가입 후 정비·출장장착 예약', '정비·엔진오일·타이어 출장장착 예약에 강점'),
  ('intrax', null, null, null, '회원가입 후 구매', '튜닝·모터스포츠 부품 종합 취급'),
  ('pechanara', null, null, null, '회원가입 후 중고부품 구매', '중고·폐차 부품으로 저비용 수리에 강점'),
  ('carlandasia', null, null, null, '회원가입 후 구매', '중고엔진·미션 등 대형 중고부품 특화'),
  ('carssenb2b', null, null, null, '사업자등록 후 도매 회원가입', '사업자 전용 자동차 부품 B2B 도매에 강점'),
  ('mamedene', null, null, null, '샵은 사업자 등록 후 입점, 고객은 앱 예약', 'AI 헤어 시뮬레이션과 뷰티샵 예약 결합'),
  ('gongbiz', null, null, null, '샵 등록 후 입점, 고객은 앱 예약', '네일·미용실·왁싱 비교예약에 강점'),
  ('mendlemendle', null, null, null, '샵 등록 후 입점, 고객은 앱 예약', '왁싱·네일·속눈썹 등 뷰티샵 예약 특화'),
  ('msgtong', null, null, null, '샵 등록 후 입점, 고객은 앱 예약', '마사지·에스테틱·왁싱 예약결제 정보 제공'),
  ('mimobio', null, null, null, '샵 등록 후 입점, 고객은 앱 예약', '전문 피부관리샵 실시간 예약에 강점'),
  ('tattooshare', null, null, null, '타투이스트 등록·고객 견적 요청', '타투 견적비교·리뷰 매칭에 강점'),
  ('beauty', null, null, null, '사업자 가입 후 매장 관리 이용', '뷰티샵 고객관리·예약 통합 관리 도구'),
  ('previewapp', null, null, null, '앱 설치 후 이용, 샵 상담 연계', '눈썹·입술 반영구 시뮬레이션 상담에 강점'),
  ('meemong', null, null, null, '가입 후 프로필 등록·매칭', '헤어 컨설팅·헤어모델 매칭에 강점'),
  ('groomingjok', null, null, null, '앱 가입 후 커뮤니티 이용', '남성 성형·시술 정보 커뮤니티에 강점'),
  ('unpa', null, null, null, '앱 가입 후 리뷰·커뮤니티 이용', '내돈내산 뷰티 리뷰·커뮤니티에 강점'),
  ('gov', null, null, null, '본인인증 후 민원 신청·발급', '각종 민원 신청·발급·조회 통합 처리'),
  ('safetyreport', null, null, null, '가입·인증 후 신고', '생활 안전위험 사진 신고에 강점'),
  ('epeople', null, null, null, '가입·인증 후 이용', '민원·제안·예산낭비 신고 통합 창구'),
  ('cheongwon', null, null, null, '본인인증 후 청원 등록', '국가기관 온라인 청원에 강점'),
  ('mobileid', null, null, null, '본인인증 후 앱으로 발급', '주민등록증·운전면허증 모바일 발급'),
  ('airkorea', null, null, null, '앱 설치 후 바로 이용', '실시간 미세먼지·대기질 정보 제공'),
  ('pp', null, null, null, '한전 계정 연동 후 이용', '실시간 전기 사용량·요금 조회로 절약 지원'),
  ('solarplay', null, null, null, '설비 등록·계정 연동 후 이용', '태양광발전소 발전량 실시간 모니터링'),
  ('lasee', null, null, null, '발전소 사업자 가입 후 모니터링 연동', '태양광 발전 현황·이상 알림 모니터링에 강점'),
  ('bikeseoul', null, null, null, '앱 가입·이용권 결제 후 대여', '서울시 공공자전거 단거리 이동에 강점'),
  ('tashu', null, null, null, '앱 가입·이용권 결제 후 대여', '대전시 무인 공공자전거 근거리 이동에 강점'),
  ('thepodo', null, null, null, '가입 후 분리배출 인증·포인트 적립', '분리배출 실천·포인트 리워드에 강점'),
  ('superbin', null, null, null, '앱 가입 후 회수기(네프론) 이용', '재활용 회수기 통한 자원순환·보상에 강점'),
  ('treepla', null, null, null, '가입 후 펀딩·후원 참여', '크라우드펀딩 기반 숲 조성·나무심기에 강점'),
  ('cpoint', null, null, null, '참여기관 가입 후 친환경 활동 인증', '친환경 활동 현금·포인트 인센티브에 강점'),
  ('gmoney', 'low', '지역화폐 가맹점 수수료 낮음', null, '앱 가입·충전 후 가맹점 결제', '충전 인센티브·지역 가맹점 결제에 강점'),
  ('zeropay', 'low', '소상공인 매출구간별 0%대 수수료', null, '사업자 가맹 신청 후 QR 발급', '소상공인 결제수수료 절감에 강점'),
  ('together2', null, null, null, '카카오계정 로그인 후 모금 참여·개설', '모금·기부 캠페인 참여에 강점'),
  ('oraebakery', null, null, null, '가입 후 정기배송 구독 신청', '천연발효 사워도우 빵 정기배송에 강점'),
  ('vegefood', null, null, null, '가입 후 상품 주문', '채식·비건 전문 식품 구매에 강점'),
  ('beanbrothers', null, null, null, '가입 후 원두 정기구독 신청', '스페셜티 원두 정기구독·로스팅에 강점'),
  ('cafebox', null, null, null, '가입 후 커피 구독 신청', '매달 바뀌는 로스터리 커피 큐레이션에 강점'),
  ('yundiet', null, null, null, '가입 후 식단 정기배송 신청', '다이어트 단백질 도시락 정기배송에 강점'),
  ('tandanji', null, null, null, '가입 후 식단 구독 신청', '탄단지 밸런스 식단 구독에 강점'),
  ('6meal', null, null, null, '가입 후 식단 구독 신청', 'AI 식단코칭 다이어트 도시락 구독에 강점'),
  ('farmtobaby', null, null, null, '가입 후 이유식 구독 신청', '친환경 원료 영양맞춤 이유식 구독에 강점'),
  ('bebecook', null, null, null, '가입 후 이유식 구독 신청', '배달 이유식 구독에 강점'),
  ('pocketsalad', null, null, null, '가입 후 샐러드 정기배송 신청', '주문 즉시 제작 샐러드 정기배송에 강점'),
  ('cueat', null, null, null, '가입 후 과일·채소 구독 신청', '취향 큐레이션 과일·채소 구독에 강점'),
  ('ffd', null, null, null, '가입 후 펀딩 참여(농가는 프로젝트 등록)', '제철농산물 크라우드펀딩·농가 직거래에 강점'),
  ('tving', null, null, null, '가입 후 구독권 결제', 'tvN·JTBC 등 CJ ENM 콘텐츠 시청에 강점'),
  ('wavve', null, null, null, '가입 후 구독권 결제', '지상파 방송 콘텐츠 다시보기에 강점'),
  ('watcha', null, null, null, '가입 후 구독권 결제', '추천 기반 영화·드라마, 마니아 콘텐츠에 강점'),
  ('coupangplay', null, null, null, '쿠팡 와우 멤버십 가입 시 이용', '스포츠 중계·오리지널 콘텐츠에 강점'),
  ('laftel', null, null, null, '가입 후 구독권 결제', '애니메이션 전문 스트리밍에 강점'),
  ('vigloo', null, null, null, '가입 후 이용(회차 결제·구독)', '글로벌 숏폼 드라마 시청에 강점'),
  ('dramaboxapp', null, null, null, '가입 후 이용(회차 결제·구독)', '숏폼 드라마 스트리밍에 강점'),
  ('audiocomics', null, null, null, '가입 후 이용(회차 결제·구독)', '웹툰·웹소설 기반 오디오 드라마에 강점'),
  ('sooplive2', null, null, null, '가입 후 방송 개설·시청', '1인 라이브 방송·후원 기반 소통에 강점'),
  ('spooncast', null, null, null, '가입 후 DJ 방송 개설·청취', '목소리 오디오 라이브 방송·후원에 강점'),
  ('vworld', null, null, null, '가입 후 커뮤니티 참여', '버튜버 팬 커뮤니티·소통에 강점'),
  ('vrew', null, null, null, '가입 후 바로 사용(무료 플랜 제공)', 'AI 자동 자막·음성인식 영상 편집에 강점'),
  ('aistudios', null, null, null, '가입 후 사용(요금제 구독)', 'AI 아바타·텍스트 투 비디오 제작에 강점'),
  ('videomonster', null, null, null, '가입 후 바로 사용(무료 체험 대개 제공)', '템플릿 기반 자동 영상 제작에 강점'),
  ('dental', null, null, null, '이용자 검색·가격비교, 치과는 제휴 등록', '임플란트·교정 치과 가격비교에 강점'),
  ('gooodcare', null, null, null, '간병인·케어매니저 등록 또는 이용 신청', '교육받은 간병인·케어매니저 매칭에 강점'),
  ('modohan', null, null, null, '이용자 검색·예약, 한의원은 제휴 등록', '증상·지역별 한의원 검색·예약에 강점'),
  ('download', null, null, null, '처방 후 앱 이용(디지털 치료기기)', '식약처 허가 불면증 디지털 치료제에 강점'),
  ('lasikhelp', null, null, null, '이용자 정보 열람·비교, 안과는 제휴', '라식·라섹 정보·안과 이벤트 비교에 강점'),
  ('kormedi', null, null, null, '콘텐츠 열람 무료, 가입 시 기능 확장', '건강·의학 정보 콘텐츠 제공에 강점'),
  ('thedirectdonation', 'low', '수수료 없이 100% 전달', null, '가입 후 기부 참여(개인·단체)', '수수료 없이 전액 전달에 강점'),
  ('ilovegohyang', null, null, null, '본인인증 후 기부 참여(세액공제·답례품)', '고향사랑기부제 공식 기부·답례품에 강점'),
  ('socialfunch', null, null, null, '캠페인 개설 신청 또는 후원 참여', '인권·환경·노동 사회운동 후원에 강점'),
  ('crowdnet', null, null, null, '정보 열람, 발행·투자는 연계 중개사 통해', '증권형 크라우드펀딩 정보 제공에 강점'),
  ('greenfund', null, null, null, '기부 참여 또는 캠페인 제안·신청', '환경 캠페인·기부 모금에 강점'),
  ('sharencare', null, null, null, '가입 후 콘텐츠 공유로 캠페인 참여', '콘텐츠 공유로 기업 대신 기부에 강점'),
  ('donus', null, null, null, '비영리단체 가입 후 모금·정기결제 구축', '비영리 후원자 개발·정기결제 SaaS에 강점'),
  ('donationbox', null, null, null, '단체 가입 후 온라인 모금함 개설', 'NGO 후원자·모금 관리에 강점'),
  ('1365', null, null, null, '회원가입 후 봉사활동 검색·신청', '전국 자원봉사 검색·신청·실적관리에 강점'),
  ('vms', null, null, null, '가입 후 봉사 모집·참여·인증 관리', '사회복지 분야 자원봉사 인증관리에 강점'),
  ('donghaeng', null, null, null, '대학생 가입 후 멘토링·봉사 매칭', '대학생 멘토링·기획봉사 매칭에 강점'),
  ('dovol', null, null, null, '청소년 가입 후 봉사 검색·신청', '청소년 봉사활동 검색·신청·실적관리에 강점'),
  ('beautifulstore', null, null, null, '물품 기부 또는 매장·온라인 구매', '물품기부·재사용 판매 나눔에 강점'),
  ('bigwalk', null, null, null, '앱 설치 후 걸음 기부 참여', '걸음 기부로 사회·환경 문제 후원에 강점'),
  ('sepp', null, null, null, '사회적경제기업 입점 신청', '사회적경제기업 제품 유통에 강점'),
  ('hknuri', null, null, null, '사회적기업·공정무역 사업자 입점 신청', '사회적기업·공정무역 제품 판매에 강점'),
  ('fairtradeshop', null, null, null, '이용자 구매, 공정무역 제품 공급 협력', '공정무역 제품 유통에 강점'),
  ('buysocial', null, null, null, '사회적경제기업 입점 또는 이용자 구매', '사회적경제 제품·가치소비 캠페인에 강점'),
  ('kr5', null, null, null, '튜터·학생 가입 후 프로필 등록·매칭', '유학생 과외 멘토 매칭에 강점'),
  ('uhakplanner', null, null, null, '상담 신청 후 유학 컨설팅 진행', '조기유학·해외대학 유학 컨설팅에 강점'),
  ('uhakpeople', null, null, null, '정보 열람 무료, 가입 시 상담 연계', '해외유학·어학연수 정보 제공에 강점'),
  ('edmuhak', null, null, null, '정보·후기 열람, 상담 신청 가능', '국가별 어학연수·어학원 후기 비교에 강점'),
  ('coei', null, null, null, '상담 신청 후 유학 절차 진행', '어학연수·학위·조기유학 종합 유학원에 강점'),
  ('megagong', null, null, null, '가입 후 수강 신청(합격 환급형 상품)', '9급·7급 공무원 인강·합격 환급에 강점'),
  ('egosi', null, null, null, '가입 후 인강 수강·수험정보 이용', '공무원 인강·수험정보 제공에 강점'),
  ('edumegong', null, null, null, '가입 후 인강 수강·교재 구매', '공무원·경찰·소방 인강·교재에 강점'),
  ('modoogong', null, null, null, '가입 후 수강 신청(학습량 관리형)', '학습량 관리형 공무원 인강에 강점'),
  ('passdong', null, null, null, '가입 후 자격증 인강 수강', '자격증 독학 인강에 강점'),
  ('llo', null, null, null, '가입 후 수강 신청·결제', '심리상담·지도사 등 민간자격 인강에 특화'),
  ('lab', null, null, null, '상담 예약 후 컨설팅 이용', 'AI 합격예측 기반 입시전략 컨설팅에 강점'),
  ('apple2', null, null, null, '가입 후 컨설턴트 매칭 신청', '입시 컨설팅 전문가 매칭에 강점'),
  ('mcc', null, null, null, '상담 예약·결제 후 이용', '수시·정시·학종 맞춤 대입 컨설팅에 강점'),
  ('studymoa', null, null, null, '앱 가입 후 좌석 예약·결제', '스터디카페·스터디룸 좌석 실시간 예약'),
  ('apple3', null, null, null, '앱 가입 후 좌석 예약·결제', '프리미엄 독서실·스터디카페 좌석 예약'),
  ('pickko', null, null, null, '앱 가입 후 좌석 예약·결제', '전국 스터디카페·독서실 좌석 예약'),
  ('zaksim', null, null, null, '앱 가입 후 예약·결제', '무인 독서실·스터디카페 예약·결제에 강점'),
  ('studylive', null, null, null, '가입 후 스터디룸 참여', '24시간 실시간 캠스터디·온라인 스터디룸'),
  ('gongzakso', null, null, null, '가입 후 그룹 개설·참여', '온라인 스터디 그룹 모집·관리에 강점'),
  ('hakwonsin', null, null, null, '무료 가입 후 학원 검색·리뷰', '전국 학원 정보·리뷰 비교에 강점'),
  ('hakwonmap', null, null, null, '가입 후 학원 검색·수강신청', '학원 검색·비교·수강신청 통합에 강점'),
  ('sscoaching', null, null, null, '가입 후 과외 매칭 신청', '성적·성향 맞춤 1:1 과외 매칭에 강점'),
  ('jinhak', null, null, null, '가입 후 성적 입력·서비스 이용', '대입 합격예측·모의지원에 강점'),
  ('adiga', null, null, null, '회원가입 후 무료 이용', '대교협 공식 대입정보·성적 분석 제공'),
  ('gs25', null, null, null, '앱 가입 후 주문·즉시배송', '편의점 상품 즉시배송(퀵커머스)에 강점'),
  ('dongnemom', null, null, null, '무료 가입 후 이용', '지역·육아 정보 공유 커뮤니티'),
  ('mcafe', null, null, null, '카페 가입 후 이용', '지역 정보·나눔 게시판 중심 맘 커뮤니티'),
  ('incheoneum2', null, null, null, '앱 가입·카드 발급 후 사용', '인천 지역 가맹점 캐시백 지역화폐'),
  ('chatgpt', null, null, null, '가입 후 무료 사용, 유료 구독 제공', '글쓰기·분석·이미지 생성까지 두루 강한 범용 챗봇'),
  ('claude-ai', null, null, null, '가입 후 무료 사용, 유료 구독 제공', '긴 문서 이해·꼼꼼한 글쓰기·코딩에 강점'),
  ('gemini', null, null, null, '가입 후 무료 사용, 유료 구독 제공', '검색·지메일·유튜브 등 구글 서비스 연동에 강점'),
  ('ms-copilot', null, null, null, '가입 후 무료 사용, 유료 구독 제공', '윈도우·엣지·오피스 내장 연동에 강점'),
  ('wrtn', null, null, null, '가입 후 무료 사용', '한국어 중심 챗봇·이미지·과제 도구 통합'),
  ('clova-x', null, null, null, '가입 후 무료 사용', '한국어·국내 정보·쇼핑 맥락 이해에 강점'),
  ('grok', null, null, null, '가입 후 사용(유료 구독 위주)', 'X(트위터) 실시간 정보 반영에 강점'),
  ('lechat', null, null, null, '가입 후 무료 사용, 유료 구독 제공', '빠른 응답 속도·넓은 무료 사용 폭'),
  ('notion-ai', null, null, null, '노션 가입 후 유료 애드온 사용', '노션 문서 내 요약·초안·번역에 강점'),
  ('gamma-app', null, null, null, '가입 후 무료 크레딧, 유료 구독', '프롬프트로 발표자료·문서·웹페이지 생성'),
  ('jasper', null, null, null, '가입 후 유료 구독(체험 제공)', '브랜드 톤 학습 마케팅 카피·블로그 생성'),
  ('copy-ai', null, null, null, '가입 후 무료 플랜·유료 구독', '광고·세일즈 카피 템플릿이 풍부'),
  ('writesonic', null, null, null, '가입 후 무료 플랜·유료 구독', 'SEO 블로그·광고 문구 빠른 생성에 강점'),
  ('grammarly', null, null, null, '가입 후 무료 사용, 유료 구독 제공', '영문 문법·톤 교정에 강점'),
  ('deepl-write', null, null, null, '가입 후 무료 사용, 유료 구독 제공', '영어·독일어 문장 자연스러운 교정에 강점'),
  ('sudowrite', null, null, null, '가입 후 유료 구독(체험 제공)', '소설·창작 스토리텔링에 특화'),
  ('midjourney', null, null, null, '가입 후 구독 시작(웹·디스코드에서 이용)', '예술적·회화적 스타일 이미지 생성에 강점'),
  ('adobe-firefly', null, null, null, '어도비 계정 가입 후 사용(크레딧 기반)', '상업 사용 고려·포토샵 연동 이미지 생성에 강점'),
  ('canva', null, null, null, '가입 후 바로 사용(무료·구독 혼합)', '디자인 툴 내장 이미지 생성·매직 편집에 강점'),
  ('ideogram', null, null, null, '가입 후 바로 사용(무료 체험 제공)', '이미지 속 글자·타이포그래피 표현에 강점'),
  ('leonardo-ai', null, null, null, '가입 후 바로 사용(무료 크레딧 제공)', '게임·제품 컨셉 아트 생성에 강점'),
  ('stability-ai', null, null, null, '오픈소스 모델 직접 설치 또는 API 이용', '오픈소스 기반 직접 설치·커스터마이즈에 강점'),
  ('flux-bfl', null, null, null, '오픈 가중치 직접 이용 또는 API 연동', '고품질 오픈 가중치 이미지 생성에 강점'),
  ('recraft', null, null, null, '가입 후 바로 사용(무료·구독 혼합)', '벡터·브랜드 스타일 유지 디자인에 강점'),
  ('remove-bg', null, null, null, '가입 없이도 이용 가능(API·크레딧 제공)', '사진 배경 자동 제거 원클릭 처리에 강점'),
  ('photoroom', null, null, null, '가입 후 바로 사용(무료 체험 제공)', '상품 사진 배경 제거·연출, 상세컷 제작에 강점'),
  ('sora', null, null, null, 'OpenAI 계정 가입·구독 후 사용', '텍스트 기반 영상 생성에 강점'),
  ('runway', null, null, null, '가입 후 바로 사용(무료 크레딧 제공)', '영상 생성·편집(제거·확장) 통합 작업에 강점'),
  ('kling', null, null, null, '가입 후 바로 사용(무료 크레딧 제공)', '인물 동작 표현·고품질 영상 생성에 강점'),
  ('pika', null, null, null, '가입 후 바로 사용(무료 체험 제공)', '짧은 밈·효과 영상 생성에 강점'),
  ('luma', null, null, null, '가입 후 바로 사용(무료 체험 제공)', '사실적인 텍스트→영상 생성에 강점'),
  ('heygen', null, null, null, '가입 후 사용(무료 체험 후 구독)', 'AI 아바타 대본 낭독, 강의·홍보 영상 제작에 강점'),
  ('synthesia', null, null, null, '가입 후 구독 시작(기업용 플랜)', '기업 교육용 AI 아바타 영상 제작에 강점'),
  ('descript', null, null, null, '가입 후 사용(무료 플랜 제공)', '문서 편집 방식의 영상·팟캐스트 편집에 강점'),
  ('capcut', null, null, null, '가입 후 바로 사용(무료 기능 다수)', '자동 자막·템플릿 기반 숏폼 제작에 강점'),
  ('elevenlabs', null, null, null, '가입 후 사용(무료 크레딧 후 구독)', '자연스러운 AI 성우·다국어 더빙 제작에 강점'),
  ('suno', null, null, null, '가입 후 바로 사용(무료 크레딧 제공)', '가사 입력만으로 노래 생성에 강점'),
  ('udio', null, null, null, '가입 후 바로 사용(무료 크레딧 제공)', '장르·보컬 지정 고음질 음악 생성에 강점'),
  ('supertone', null, null, null, '가입 후 사용(콘텐츠용 보이스 제작)', '음성 합성·변환 콘텐츠 보이스 제작에 강점'),
  ('murf', null, null, null, '가입 후 사용(무료 체험 후 구독)', '비즈니스 나레이션용 AI 보이스 제작에 강점'),
  ('adobe-podcast', null, null, null, '어도비 계정 가입 후 사용', '녹음 잡음 제거·음질 보정에 강점'),
  ('github-copilot', null, null, null, '가입 후 구독 시작(IDE 확장 설치)', 'IDE 내 코드 자동완성·제안에 강점'),
  ('cursor', null, null, null, '에디터 설치·가입 후 사용(무료 플랜 제공)', '코드베이스와 대화하며 수정하는 작업에 강점'),
  ('claude-code', null, null, null, '가입 후 터미널·IDE에서 사용', '작업 단위를 맡기는 터미널·IDE 코딩 에이전트에 강점'),
  ('windsurf', null, null, null, '에디터 설치·가입 후 사용(무료 플랜 제공)', '멀티파일 작업 자동화 에이전트형 IDE에 강점'),
  ('replit', null, null, null, '가입 후 브라우저에서 바로 사용', '브라우저 기반 앱 개발·배포, AI 에이전트 내장에 강점'),
  ('v0', null, null, null, '가입 후 사용(무료 크레딧 제공)', '프롬프트로 리액트 웹 UI 생성에 강점'),
  ('lovable', null, null, null, '가입 후 사용(무료 크레딧 제공)', '대화 기반 웹 서비스 생성에 강점'),
  ('bolt-new', null, null, null, '가입 후 브라우저에서 바로 사용', '브라우저에서 풀스택 앱 생성·실행에 강점'),
  ('devin', null, null, null, '가입·구독 후 이슈 위임하여 사용', '이슈를 맡아 자율 코딩하는 에이전트에 강점'),
  ('clova-note', null, null, null, '네이버 계정 가입 후 바로 사용', '한국어 회의 녹음→텍스트·요약에 강점'),
  ('daglo', null, null, null, '가입 후 바로 사용(무료 크레딧·구독형)', '국내 한국어 음성 전사·회의록 정리에 강점'),
  ('otter', null, null, null, '가입 후 바로 사용(무료 플랜·구독형)', '영어 회의 실시간 전사·요약에 강점'),
  ('fireflies', null, null, null, '가입 후 회의 도구 연동(무료 플랜 제공)', '줌·미트 자동 참여 회의록 작성에 강점'),
  ('fathom', null, null, null, '가입 후 바로 사용(무료 폭 넓음)', '무료 요약·하이라이트 클립 생성에 강점'),
  ('tldv', null, null, null, '가입 후 회의 도구 연동(무료 플랜 제공)', '녹화·타임스탬프 요약, 다수 회의 도구 지원'),
  ('channeltalk', null, null, null, '가입 후 사이트에 위젯 설치(구독형)', '채팅상담·AI 상담봇 응대 자동화에 강점'),
  ('intercom', null, null, null, '가입·연동 후 사용(구독형)', 'AI 에이전트가 고객 문의 자체 해결에 강점'),
  ('zendesk-ai', null, null, null, '헬프데스크 구독 후 AI 기능 활성화', '헬프데스크 내장 AI 응대·문의 분류에 강점'),
  ('tidio', null, null, null, '가입 후 쇼핑몰에 위젯 설치(무료 플랜)', '소규모 쇼핑몰 챗봇·라이브챗 간편 도입에 강점'),
  ('adcreative', null, null, null, '가입 후 바로 사용(구독형)', '광고 배너·소재 대량 생성에 강점'),
  ('predis', null, null, null, '가입 후 바로 사용(무료 플랜·구독형)', 'SNS 게시물 자동 생성·예약에 강점'),
  ('surfer', null, null, null, '가입 후 바로 사용(구독형)', 'SEO 점수 기반 콘텐츠 최적화에 강점'),
  ('zapier', null, null, null, '가입 후 바로 사용(무료 플랜·구독형)', '다수 앱 연결 업무 자동화에 강점'),
  ('make-com', null, null, null, '가입 후 바로 사용(무료 플랜·구독형)', '시각적 시나리오로 복잡한 자동화 구성에 강점'),
  ('n8n', null, null, null, '가입 또는 자체 호스팅(오픈소스)', '자체 호스팅·AI 에이전트 워크플로 구축에 강점'),
  ('lindy', null, null, null, '가입 후 바로 사용(구독형)', '노코드 AI 비서로 업무 위임에 강점'),
  ('relevance-ai', null, null, null, '가입 후 바로 사용(구독형)', '영업·리서치용 AI 에이전트 구성에 강점'),
  ('manus', null, null, null, '가입 후 사용(구독형)', '자율 조사·작업 수행 범용 에이전트에 강점'),
  ('dify', null, null, null, '가입 또는 자체 호스팅(오픈소스)', '사내 LLM 앱·챗봇 구축에 강점'),
  ('perplexity', null, null, null, '가입 후 바로 사용(무료 플랜·구독형)', '출처 기반 최신 정보 조사에 강점'),
  ('notebooklm', null, null, null, '구글 계정으로 바로 사용(무료)', '업로드 자료 근거 기반 질의·정리에 강점'),
  ('liner', null, null, null, '가입 후 바로 사용(무료 플랜·구독형)', '출처 신뢰도 강조 AI 검색·하이라이트에 강점'),
  ('deepl', null, null, null, '가입 후 사용(무료 플랜·구독형)', '자연스러운 번역 품질에 강점'),
  ('papago', null, null, null, '가입 없이 바로 사용(무료)', '한국어 번역 쌍 품질에 강점'),
  ('flitto-ai', null, null, null, '가입 후 사용(전문·AI 번역)', '전문 번역과 AI 번역 데이터 결합에 강점'),
  ('elicit', null, null, null, '가입 후 바로 사용(무료 플랜·구독형)', '논문 검색·표 정리 등 연구 작업에 강점'),
  ('consensus', null, null, null, '가입 후 바로 사용(무료 플랜·구독형)', '논문 근거 기반 학술 질의응답에 강점')
) as v(id, fee_band, fee_text, settle_text, enter_text, strength)
where p.id = v.id;

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


-- ============================================================
-- 세모플 0016 — 고신뢰 자동 등재(D) + 사후 검수 (수집기 D 경로용)
-- (0001~0015 실행된 DB에 이어 실행 · 멱등)
--
-- 원칙 "자동 등재 없음"을 "부분 개방 + 스위치"로 realize한다(과금·아웃리치와 동일한 게이트 패턴):
--   · 기본 스위치 OFF → 수집기는 전부 검수 큐로(오늘 동작 그대로). 관리자가 수집 신뢰도를
--     충분히 지켜본 뒤에만 app_settings 'autolist'.enabled=true + collector_id=봇uid 로 켠다.
--   · 켜져도 auto_list_candidate RPC가 서버에서 재검증: 스위치·collector_id·신뢰도·중복·분야.
--   · 자동 등재분은 lifecycle='review' + auto_listed=true 로만 들어가(공개엔 보이되) 사후 검수 큐에 뜬다.
--     관리자는 "확정(검증 승격)" 또는 "내리기(rejected→공개 제외)" 로 사후 스팟체크한다.
-- ============================================================

-- ── 1) 자동 등재 표식(감사·사후 검수 큐의 근거) ──
alter table public.platforms add column if not exists auto_listed    boolean not null default false;
alter table public.platforms add column if not exists auto_listed_at timestamptz;
create index if not exists idx_platforms_autolisted
  on public.platforms(auto_listed_at desc) where auto_listed and archived_at is null;

-- ── 2) 호스트 정규화(수집기 host()와 동일 규칙: 스킴·포트·경로 제거 + www/m/mobile 등 접두 제거) ──
create or replace function public.host_norm(u text)
returns text language sql immutable set search_path = public as $$
  select regexp_replace(
    split_part(split_part(regexp_replace(lower(coalesce(u, '')), '^https?://', ''), '/', 1), ':', 1),
    '^((www|m|mobile|ko|kr|en|app)\.)+', ''
  )
$$;

-- ── 3) app_settings — 자동 등재 스위치(기본 OFF) ──
insert into public.app_settings (key, value) values
  ('autolist', '{"enabled": false, "min_confidence": 80, "collector_id": null}')
on conflict (key) do nothing;

-- ── 4) 자동 등재 RPC — 수집기 봇(collector_id)만 호출, 서버가 전 조건 재검증 ──
create or replace function public.auto_list_candidate(p_payload jsonb, p_confidence int)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_cfg   jsonb;
  v_name  text := trim(p_payload->>'name');
  v_url   text := trim(p_payload->>'url');
  v_cat   text := p_payload->>'category_id';
  v_region text := coalesce(p_payload->>'region', 'overseas');
  v_desc  text := coalesce(p_payload->>'desc', '');
  v_base  text;
  v_id    text;
  v_n     int := 1;
begin
  select value into v_cfg from public.app_settings where key = 'autolist';
  if v_cfg is null or coalesce((v_cfg->>'enabled')::boolean, false) is not true then
    raise exception 'AUTOLIST_OFF';
  end if;
  if auth.uid() is null or (v_cfg->>'collector_id') is null
     or auth.uid()::text <> (v_cfg->>'collector_id') then
    raise exception 'FORBIDDEN';
  end if;
  if p_confidence < coalesce((v_cfg->>'min_confidence')::int, 80) then
    raise exception 'LOW_CONFIDENCE';
  end if;
  if v_name = '' or v_url = '' or public.host_norm(v_url) = '' then
    raise exception 'BAD_PAYLOAD';
  end if;
  if v_region not in ('domestic', 'overseas') then v_region := 'overseas'; end if;
  if not exists (select 1 from public.categories where id = v_cat) then
    raise exception 'BAD_CATEGORY';
  end if;
  -- 중복(정규화 호스트 일치) → 등재 거절(수집기는 검수 큐로 폴백)
  if exists (select 1 from public.platforms where public.host_norm(url) = public.host_norm(v_url)) then
    raise exception 'DUP_EXISTS';
  end if;

  -- id 슬러그 생성 + 충돌 회피
  v_base := regexp_replace(split_part(public.host_norm(v_url), '.', 1), '[^a-z0-9-]', '-', 'g');
  v_base := regexp_replace(v_base, '(^-+|-+$)', '', 'g');
  if v_base = '' then v_base := 'platform'; end if;
  v_id := v_base;
  while exists (select 1 from public.platforms where id = v_id) loop
    v_n := v_n + 1; v_id := v_base || '-' || v_n;
    if v_n > 50 then raise exception 'ID_EXHAUSTED'; end if;
  end loop;

  insert into public.platforms (id, name, category_id, region, url, blurb,
                                is_new, verified, lifecycle, auto_listed, auto_listed_at, created_by)
  values (v_id, left(v_name, 60), v_cat, v_region::region_t, v_url, left(v_desc, 300),
          true, false, 'review', true, now(), auth.uid());
  return v_id;
end $$;
revoke execute on function public.auto_list_candidate(jsonb, int) from public, anon;
grant  execute on function public.auto_list_candidate(jsonb, int) to authenticated;

-- ── 5) 사후 검수 RPC — 관리자만: 확정(검증 승격) / 내리기(공개 제외) ──
create or replace function public.review_auto_listed(p_id text, p_keep boolean, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_from lifecycle_t;
begin
  if not public.is_admin() then raise exception 'FORBIDDEN'; end if;
  select lifecycle into v_from from public.platforms where id = p_id for update;
  if v_from is null then raise exception 'NOT_FOUND'; end if;
  if p_keep then
    update public.platforms
       set auto_listed = false, verified = true,
           lifecycle = case when v_from = 'review' then 'verified'::lifecycle_t else lifecycle end
     where id = p_id;
    if v_from = 'review' then
      insert into public.lifecycle_transitions (platform_id, from_state, to_state, reason, actor_id)
      values (p_id, v_from, 'verified', coalesce(p_reason, '자동 등재 사후 확정'), auth.uid());
    end if;
  else
    update public.platforms
       set auto_listed = false, archived_at = now(),
           lifecycle = case when public.lifecycle_allowed(v_from, 'rejected') then 'rejected'::lifecycle_t else lifecycle end
     where id = p_id;
    if public.lifecycle_allowed(v_from, 'rejected') then
      insert into public.lifecycle_transitions (platform_id, from_state, to_state, reason, actor_id)
      values (p_id, v_from, 'rejected', coalesce(p_reason, '자동 등재 사후 반려'), auth.uid());
    end if;
  end if;
end $$;
revoke execute on function public.review_auto_listed(text, boolean, text) from public, anon;
grant  execute on function public.review_auto_listed(text, boolean, text) to authenticated;


-- ============================================================
-- 세모플 0017 — 계측 보강(측정): events.ref(유입경로) + 퍼널·유입 admin 뷰
-- (0001~0016 실행된 DB에 이어 실행 · 멱등)
--
-- 목적: 노출→클릭→아웃바운드 퍼널과 유입경로(referrer/utm)를 측정 가능하게.
--   · events.ref 컬럼 추가(공개 anon insert이므로 0008 패턴대로 길이 상한).
--   · v_funnel_7d / v_referrers_7d 는 v_popular_searches(0008)와 동일하게 뷰 안에서 is_admin() 가드
--     (events의 admin-only 읽기 RLS를 definer 뷰가 우회하지 못하도록 — 행동 데이터 노출 차단).
-- ============================================================

-- ── 1) 유입경로 차원 ──
alter table public.events add column if not exists ref text;
alter table public.events drop constraint if exists chk_events_ref_len;
alter table public.events add constraint chk_events_ref_len
  check ( ref is null or char_length(ref) <= 120 ) not valid;

-- ── 2) 7일 퍼널 요약(관리 콘솔 전용) ──
create or replace view public.v_funnel_7d as
select
  count(*) filter (where type = 'impression')                        as impressions,
  count(*) filter (where type = 'click')                             as clicks,
  count(*) filter (where type = 'outbound')                          as outbounds,
  count(*) filter (where type = 'search')                            as searches,
  count(*) filter (where type = 'favorite')                          as favorites,
  count(distinct session_id)                                         as sessions,
  count(distinct user_id) filter (where user_id is not null)         as logged_in
from public.events
where created_at > now() - interval '7 days' and public.is_admin();

-- ── 3) 7일 유입경로 상위(관리 콘솔 전용) ──
create or replace view public.v_referrers_7d as
select coalesce(nullif(ref, ''), '(직접)') as ref,
       count(distinct session_id)          as sessions,
       count(*)                            as events
from public.events
where created_at > now() - interval '7 days' and public.is_admin()
group by 1 order by sessions desc, events desc limit 20;


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


-- ============================================================
-- 세모플 0019 — 공개 인기 집계 뷰(B2: 검색·추천 행동신호 랭킹)
-- (0001~0018 실행된 DB에 이어 실행 · 멱등)
--
-- 검색·추천에 "많이 쓰이는 플랫폼"을 2차 신호로 반영하기 위한 집계.
--   · events는 admin-only read(0002)라 anon이 원시 행을 못 읽는다 → 여기서 "플랫폼당 집계 점수"만
--     노출하는 공개 뷰를 만든다(세션·유저·쿼리·ref 등 개인 행동로그는 비노출).
--   · 뷰는 소유자 권한으로 events RLS를 우회(0008 주석이 지적한 definer-뷰 메커니즘을 집계·비식별 한정으로
--     의도적으로 사용). anon/authenticated에 select만 grant.
--   · count(distinct session_id)로 집계 → 한 세션이 반복 클릭해도 1표(단순 어뷰징 완화).
--   · 원칙: 디렉토리 "유료 개입 없음" 유지 — 이 신호는 유기적·집계·상한(클라이언트에서 2차 보정)만.
-- 인덱스: idx_events_platform(platform_id, type, created_at desc)(0001)가 이 집계에 최적 — 신규 인덱스 없음.
-- ============================================================

create or replace view public.v_platform_popularity as
select
  platform_id,
  ( 3.0 * count(distinct session_id) filter (where type = 'outbound')
  + 1.0 * count(distinct session_id) filter (where type = 'click')
  + 0.2 * count(distinct session_id) filter (where type = 'impression')
  )::numeric(12, 1) as score
from public.events
where platform_id is not null
  and created_at > now() - interval '30 days'
group by platform_id
having ( 3.0 * count(distinct session_id) filter (where type = 'outbound')
       + 1.0 * count(distinct session_id) filter (where type = 'click')
       + 0.2 * count(distinct session_id) filter (where type = 'impression') ) > 0;

-- 뷰는 기본 grant가 없다 — 공개 읽기를 위해 명시 grant(집계 컬럼만 노출되므로 안전)
grant select on public.v_platform_popularity to anon, authenticated;


-- ============================================================
-- 세모플 0020 — 링크 신선도(신뢰 가시화 D1b)
-- (0001~0019 실행된 DB에 이어 실행 · 멱등)
--
-- healthcheck가 월간 프로브한 링크 생존 상태를 플랫폼 행에 기록 → 카드/상세에 "링크 확인 필요" 노출.
--   · link_status: ok | warn(봇차단 가능) | dead. link_checked_at: 마지막 확인 시각.
--   · 쓰기는 admin(봇, healthcheck.mjs)만(기존 admin write platforms RLS). 공개 read는 그대로(익명성 무관).
-- ============================================================

alter table public.platforms add column if not exists link_status     text;
alter table public.platforms add column if not exists link_checked_at  timestamptz;
alter table public.platforms drop constraint if exists chk_platforms_link_status;
alter table public.platforms add constraint chk_platforms_link_status
  check ( link_status is null or link_status in ('ok', 'warn', 'dead') ) not valid;
create index if not exists idx_platforms_deadlink
  on public.platforms(link_checked_at desc) where link_status = 'dead' and archived_at is null;


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
