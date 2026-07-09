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
