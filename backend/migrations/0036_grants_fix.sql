-- ============================================================
-- 세모플 0036 — RLS 정책 헬퍼 함수 권한 재부여(운영 장애 수정)
-- (0001~0035 실행된 DB에 이어 실행 · 멱등 — grant는 중복 실행 무해)
-- 증상: 봇/회원의 submissions insert가 "permission denied for function is_suspended"로 거부
--   (collect-candidates run 29513012891). 0028에 grant가 있으나 라이브 DB에서 누락 확인
--   (SQL Editor 부분 실행 등으로 revoke 이후 grant가 빠진 것으로 추정).
-- 조치: 정책 표현식에서 호출되는 헬퍼 전부를 authenticated에 재부여(원 설계와 동일 —
--   anon/public은 계속 차단). create or replace 없이 grant만 — 기존 함수 정의 불변.
-- ============================================================
grant execute on function public.is_suspended()                          to authenticated;
grant execute on function public.my_pending_count(text)                  to authenticated;
grant execute on function public.admin_set_suspended(uuid, boolean)      to authenticated;
grant execute on function public.purge_old_notifications(integer, integer) to authenticated;
