-- ============================================================
-- 세모플 0023 — 운영자 대시보드(E-C)
-- (0001~0022 실행된 DB에 이어 실행 · 멱등)
--
-- 운영자 인증(platform_operators)의 보상을 배지→데이터로 확장: 내 플랫폼의 30일
-- 노출·클릭·외부방문·즐겨찾기 수를 운영자 본인에게만 개방(인증→셀프필→제휴 수신 선순환).
-- events는 admin-only RLS라 definer 함수로 집계값만 반환 — 개별 행·세션·사용자
-- 식별자는 반환하지 않는다(개인 행동로그 비노출 원칙, 0019와 동일 기준).
-- ============================================================

-- ── 1) 운영자 범위 통계 RPC ──
create or replace function public.operator_platform_stats(p_platform text)
returns table (impressions bigint, clicks bigint, outbounds bigint, favorites bigint)
language plpgsql stable security definer set search_path = public as $$
begin
  if not exists (select 1 from public.platform_operators
                 where platform_id = p_platform and user_id = auth.uid()) then
    raise exception 'FORBIDDEN';
  end if;
  return query
  select
    count(distinct e.session_id) filter (where e.type = 'impression'),
    count(distinct e.session_id) filter (where e.type = 'click'),
    count(distinct e.session_id) filter (where e.type = 'outbound'),
    (select count(*) from public.favorites f where f.platform_id = p_platform)
  from public.events e
  where e.platform_id = p_platform and e.created_at > now() - interval '30 days';
end $$;
revoke execute on function public.operator_platform_stats(text) from public, anon;
grant execute on function public.operator_platform_stats(text) to authenticated;

-- ── 2) 내 플랫폼이 받은 제휴 제안 열람(운영자) ──
-- 기존 정책은 발신자 본인+admin뿐 — 수신 플랫폼 운영자에게 열람을 추가 개방.
-- 발신자 개인정보는 sender_name(제안 시점 스냅샷)뿐이고 target_email은 운영자 본인 주소.
drop policy if exists "operator outreach read" on public.outreach_proposals;
create policy "operator outreach read" on public.outreach_proposals for select
  using (target_platform_id in
         (select platform_id from public.platform_operators where user_id = auth.uid()));
