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
