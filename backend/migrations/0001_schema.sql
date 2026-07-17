-- ============================================================
-- 세모플 DB 스키마 v1  (Supabase/Postgres) — 신규 DB 부트스트랩 전용(0001~0003)
--   ※ 라이브 재적용은 개별 마이그레이션(000N)으로. ALL.sql 전체 재실행은 신규 DB에서만.
-- 기준: redesign/handoff/API Spec.md (v0.9)
-- 미래 기능(검수·라이프사이클·클레임·제휴·거래소·부스트·분석)을 선반영.
-- 실행 순서: 0001_schema.sql → 0002_policies.sql → 0003_seed.sql
-- ============================================================

create extension if not exists pg_trgm;        -- 한국어 부분일치 검색(ilike + trgm 인덱스)

-- ── Enums (영문 코드; 한국어 라벨은 프론트 담당) ──────────────
-- ALL.sql 재실행 안전: 각 create type을 do-block으로 감싸 이미 존재하면 건너뛴다
-- (bare create type은 2회차 실행 시 "type already exists"로 전체를 중단시킴 — 운영 재적용 리스크).
do $$ begin create type region_t            as enum ('domestic','overseas');                          exception when duplicate_object then null; end $$;  -- 국내/해외
do $$ begin create type fee_band_t          as enum ('low','mid','high');                             exception when duplicate_object then null; end $$;  -- 수수료대
do $$ begin create type lifecycle_t         as enum ('soon','review','verified','matched','rejected'); exception when duplicate_object then null; end $$;
do $$ begin create type submission_status_t as enum ('pending','hold','approved','rejected');          exception when duplicate_object then null; end $$;
do $$ begin create type collection_t        as enum ('interest','review','plan');                     exception when duplicate_object then null; end $$;  -- 관심/검토중/입점예정
do $$ begin create type proposal_status_t   as enum ('pending','accepted','rejected','withdrawn');     exception when duplicate_object then null; end $$;
do $$ begin create type claim_method_t      as enum ('email','dns','meta','doc');                     exception when duplicate_object then null; end $$;  -- 도메인 이메일/DNS/메타태그/서류
do $$ begin create type claim_status_t      as enum ('pending','code_sent','verified','rejected');     exception when duplicate_object then null; end $$;
do $$ begin create type deal_status_t       as enum ('open','in_progress','closed');                  exception when duplicate_object then null; end $$;
do $$ begin create type boost_status_t      as enum ('draft','review','active','paused','done','rejected'); exception when duplicate_object then null; end $$;
do $$ begin create type role_t              as enum ('user','operator','admin');                      exception when duplicate_object then null; end $$;
do $$ begin create type event_t             as enum ('impression','click','outbound','favorite','search');  exception when duplicate_object then null; end $$;

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
