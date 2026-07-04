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
