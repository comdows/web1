-- ============================================================
-- 세모플 0038 — R3 성능: 관리자 집계 뷰 지원 인덱스(events)
-- (0001~0037 실행된 DB에 이어 실행 · 멱등)
--
-- 배경(성능검증 R3): 관리자 전용 뷰 v_retention_cohorts·v_money_funnel_30d(0034),
--   v_growth_weekly 라이브 주간 산출, admin_snapshot_weekly RPC가 events를
--   session_id 그룹핑(코호트 firsts/activity·재방문 상관 서브쿼리)과 deal 노출 필터
--   (머니패스)로 훑는다. events는 90일 purge(0010)로 상한이 있으나, 세션 그룹핑·deal
--   필터를 받쳐줄 인덱스가 없어(0001 idx_events_platform은 platform_id 선두, 0034
--   idx_events_created는 created_at 단일) 데이터 성장 시 셀프조인 비용↑.
--   뷰·RLS·집계 로직은 무변경 — 순수 가법 인덱스만 추가(관리자 조회 seq scan→index).
--
-- 설계 판단: 스냅샷 테이블이 아니라 인덱스 — 리텐션 코호트(삼각 행렬)·머니패스(롤링
--   30일)는 metrics_weekly식 주간 확정 스냅샷 모델에 맞지 않고, events가 이미 90일
--   상한이라 인덱스가 플래그된 셀프조인·필터 비용을 직접 제거하는 최소·정확한 처방.
--   (주간 시계열은 이미 metrics_weekly로 스냅샷됨 — 0034.)
-- ============================================================

-- ── 1) 세션 코호트/재방문 지원 ──
--   v_retention_cohorts: firsts(session_id별 min(created_at))·activity(distinct session_id,week)
--   v_growth_weekly 라이브: not exists(p.session_id = e.session_id and p.created_at < 주시작)
--   admin_snapshot_weekly: sess/new_sess(세션 최초 등장 판정)
--   → (session_id, created_at) 부분 인덱스로 그룹핑·상관 서브쿼리를 index scan화.
create index if not exists idx_events_session
  on public.events(session_id, created_at)
  where session_id is not null;

-- ── 2) 머니패스(매물 조회 세션) 지원 ──
--   v_money_funnel_30d: count(distinct session_id) where type='impression' and entity_type='deal'
--                       and created_at > now()-30d
--   admin_snapshot_weekly: deal_views(동일 필터 count)
--   → deal 노출은 전체 events의 소수 → 해당 술어 부분 인덱스에 session_id를 담아
--     롤링 범위 스캔 + distinct를 index-only로.
create index if not exists idx_events_deal_impr
  on public.events(created_at, session_id)
  where type = 'impression' and entity_type = 'deal';
