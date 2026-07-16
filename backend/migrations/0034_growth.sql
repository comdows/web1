-- ============================================================
-- 세모플 0034 — 성장 계측 기반(로드맵 v2 Phase 1)
-- (0001~0033 실행된 DB에 이어 실행 · 멱등)
--
-- 공백: 리텐션·WAU·코호트·시계열 측정 전무(v_funnel_7d는 7일 스냅샷) + 머니패스(매물 조회→브리프→관심→소개) 퍼널 없음.
-- 설계:
--   · events.entity_type/entity_id — 매물·제휴 등 비플랫폼 이벤트 수용(event_t enum 확장 회피, 0017 ref 패턴).
--   · metrics_weekly — 주간 확정치 스냅샷(events 90일 purge(0010)와 무관하게 히스토리 영구 보존).
--     쓰기는 admin_snapshot_weekly RPC(definer)만, 읽기는 admin. note 컬럼은 도메인 전환 등 이벤트 라벨(Phase 2).
--   · 뷰 3종(v_growth_weekly·v_retention_cohorts·v_money_funnel_30d) — 0017과 동일하게 뷰 안 is_admin() 인라인 가드
--     (events admin-only RLS를 definer 뷰가 우회하지 못하도록).
--   · 재방문(returning) 정의: 해당 주 등장 세션 중 그 주 이전에 이벤트가 존재하는 세션 — sm.sid가 localStorage
--     영속이라 "기기 재방문" 근사(초기화·다기기 미연결 한계, purge 90일 내). 패널에 "세션 기준 근사" 명기.
--   · 하단 퍼널(브리프·관심·소개)은 events가 아니라 실테이블(buyer_briefs·deal_interests·partner_post_interests)
--     집계 — 이벤트 유실과 무관하게 정확.
-- ============================================================

-- ── 1) events 엔티티 차원(매물 상세 조회 = type='impression' + entity_type='deal') ──
alter table public.events add column if not exists entity_type text;
alter table public.events add column if not exists entity_id   text;
alter table public.events drop constraint if exists chk_events_entity_len;
alter table public.events add constraint chk_events_entity_len
  check ( (entity_type is null or char_length(entity_type) <= 40)
      and (entity_id   is null or char_length(entity_id)   <= 80) ) not valid;
create index if not exists idx_events_created on public.events(created_at);

-- ── 2) v_funnel_7d 재생성 — 기존 의미(플랫폼 카드 퍼널) 보존: 엔티티 이벤트는 노출·클릭·외부방문 집계에서 제외 ──
create or replace view public.v_funnel_7d as
select
  count(*) filter (where type = 'impression' and entity_type is null)  as impressions,
  count(*) filter (where type = 'click'      and entity_type is null)  as clicks,
  count(*) filter (where type = 'outbound'   and entity_type is null)  as outbounds,
  count(*) filter (where type = 'search')                              as searches,
  count(*) filter (where type = 'favorite')                            as favorites,
  count(distinct session_id)                                           as sessions,
  count(distinct user_id) filter (where user_id is not null)           as logged_in
from public.events
where created_at > now() - interval '7 days' and public.is_admin();

-- ── 3) 주간 스냅샷 테이블 ──
create table if not exists public.metrics_weekly (
  week_start         date primary key,          -- UTC 주 시작(월요일, date_trunc('week'))
  sessions           int not null default 0,
  new_sessions       int not null default 0,
  returning_sessions int not null default 0,
  wau_users          int not null default 0,    -- 로그인 사용자 기준(정밀)
  searches           int not null default 0,
  outbounds          int not null default 0,
  favorites          int not null default 0,
  deal_views         int not null default 0,    -- 매물 상세 조회(entity_type='deal')
  briefs_created     int not null default 0,
  interests_created  int not null default 0,    -- 인수 관심(EOI)
  intros_done        int not null default 0,    -- 소개 실행(deal+partner introduced_at)
  platforms_total    int not null default 0,
  note               text,                      -- 이벤트 라벨(도메인 전환·대형 배포 등 — 수동 기입)
  updated_at         timestamptz not null default now()
);
alter table public.metrics_weekly enable row level security;
drop policy if exists "admin read metrics" on public.metrics_weekly;
create policy "admin read metrics" on public.metrics_weekly for select using (public.is_admin());
grant select on public.metrics_weekly to authenticated;

-- ── 4) 주간 스냅샷 RPC — admin 봇(metrics.yml)이 매주 호출, 지난 완결 주를 멱등 upsert ──
create or replace function public.admin_snapshot_weekly(p_week date default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_start date;
  v_end   date;
  v_row   public.metrics_weekly;
begin
  if not public.is_admin() then raise exception 'FORBIDDEN'; end if;
  -- 기본: 지난 완결 UTC 주(월~일). metrics.yml은 월요일 01:15 UTC에 돌므로 직전 주가 확정 상태.
  v_start := coalesce(p_week, (date_trunc('week', now()))::date - 7);
  v_end   := v_start + 7;

  with wk as (
    select session_id, user_id, type, entity_type
    from public.events
    where created_at >= v_start and created_at < v_end
  ), sess as (
    select distinct session_id from wk where session_id is not null
  ), new_sess as (
    -- 그 주 이전 이벤트가 없는 세션 = 신규(90일 purge 내 근사)
    select s.session_id from sess s
    where not exists (
      select 1 from public.events e
      where e.session_id = s.session_id and e.created_at < v_start
    )
  )
  insert into public.metrics_weekly as m
    (week_start, sessions, new_sessions, returning_sessions, wau_users,
     searches, outbounds, favorites, deal_views,
     briefs_created, interests_created, intros_done, platforms_total, updated_at)
  select
    v_start,
    (select count(*) from sess),
    (select count(*) from new_sess),
    (select count(*) from sess) - (select count(*) from new_sess),
    (select count(distinct user_id) from wk where user_id is not null),
    (select count(*) from wk where type = 'search'),
    (select count(*) from wk where type = 'outbound' and entity_type is null),
    (select count(*) from wk where type = 'favorite'),
    (select count(*) from wk where type = 'impression' and entity_type = 'deal'),
    (select count(*) from public.buyer_briefs    where created_at >= v_start and created_at < v_end),
    (select count(*) from public.deal_interests  where created_at >= v_start and created_at < v_end),
    (select count(*) from public.deal_interests  where introduced_at >= v_start and introduced_at < v_end)
      + (select count(*) from public.partner_post_interests where introduced_at >= v_start and introduced_at < v_end),
    (select count(*) from public.platforms where archived_at is null and lifecycle <> 'rejected'),
    now()
  on conflict (week_start) do update set
    sessions = excluded.sessions, new_sessions = excluded.new_sessions,
    returning_sessions = excluded.returning_sessions, wau_users = excluded.wau_users,
    searches = excluded.searches, outbounds = excluded.outbounds, favorites = excluded.favorites,
    deal_views = excluded.deal_views, briefs_created = excluded.briefs_created,
    interests_created = excluded.interests_created, intros_done = excluded.intros_done,
    platforms_total = excluded.platforms_total, updated_at = now();
    -- note는 갱신하지 않음(수동 라벨 보존)

  select * into v_row from public.metrics_weekly where week_start = v_start;
  return to_jsonb(v_row);
end $$;
revoke execute on function public.admin_snapshot_weekly(date) from public, anon;
grant  execute on function public.admin_snapshot_weekly(date) to authenticated;

-- ── 5) 성장 시계열 뷰 — 스냅샷 최근 12주 + 진행 중인 이번 주 라이브(관리 콘솔 전용) ──
create or replace view public.v_growth_weekly as
select week_start, sessions, new_sessions, returning_sessions, wau_users,
       searches, outbounds, deal_views, briefs_created, interests_created, intros_done,
       platforms_total, note, false as live
from public.metrics_weekly
where week_start > (current_date - interval '12 weeks') and public.is_admin()
union all
select (date_trunc('week', now()))::date,
  count(distinct session_id),
  count(distinct session_id) filter (where not exists (
    select 1 from public.events p
    where p.session_id = e.session_id and p.created_at < date_trunc('week', now()))),
  count(distinct session_id) filter (where exists (
    select 1 from public.events p
    where p.session_id = e.session_id and p.created_at < date_trunc('week', now()))),
  count(distinct user_id) filter (where user_id is not null),
  count(*) filter (where type = 'search'),
  count(*) filter (where type = 'outbound' and entity_type is null),
  count(*) filter (where type = 'impression' and entity_type = 'deal'),
  0, 0, 0, 0, null, true
from public.events e
where created_at >= date_trunc('week', now())
having public.is_admin(); -- WHERE 가드는 집계 특성상 비관리자에게도 0값 1행을 만든다 — HAVING이 행 자체를 차단

-- ── 6) 리텐션 코호트(주간 첫 방문 코호트 × 경과 주, 최근 8주 — 세션 기준 근사) ──
create or replace view public.v_retention_cohorts as
with firsts as (
  select session_id, (date_trunc('week', min(created_at)))::date as cohort_week
  from public.events where session_id is not null group by session_id
), activity as (
  select distinct session_id, (date_trunc('week', created_at))::date as active_week
  from public.events where session_id is not null
)
select f.cohort_week,
       (a.active_week - f.cohort_week) / 7 as week_offset,
       count(distinct f.session_id)        as sessions
from firsts f
join activity a using (session_id)
where f.cohort_week > (current_date - interval '8 weeks')
  and a.active_week >= f.cohort_week
  and public.is_admin()
group by 1, 2;

-- ── 7) 머니패스 퍼널(최근 30일: 매물 조회 세션 → 브리프 → 관심 → 소개) ──
create or replace view public.v_money_funnel_30d as
select
  (select count(distinct session_id) from public.events
    where type = 'impression' and entity_type = 'deal' and created_at > now() - interval '30 days') as deal_view_sessions,
  (select count(*) from public.buyer_briefs   where created_at > now() - interval '30 days')        as briefs,
  (select count(*) from public.deal_interests where created_at > now() - interval '30 days')        as interests,
  (select count(*) from public.deal_interests where introduced_at > now() - interval '30 days')     as intros
where public.is_admin();

grant select on public.v_growth_weekly, public.v_retention_cohorts, public.v_money_funnel_30d to authenticated;
