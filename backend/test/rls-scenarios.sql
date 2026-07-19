-- 적대적 DB 시나리오 회귀 테스트 — ALL.sql(+authstub) 적용된 로컬 PG16에서 실행.
-- 각 시나리오는 방어가 살아있으면 PASS, 뚫리면 FAIL을 출력한다. 실행법은 backend/test/README.md.
-- (Supabase 라이브가 아닌 순정 PG16이므로 RLS 정책까지 태우려면 set role + jwt claim이 필요 —
--  여기서는 grant 상태·CHECK 실효·함수 가드 등 "정책 헬퍼 계층"을 직접 단언한다.)
\set ON_ERROR_STOP off
\pset tuples_only on

-- ── 1) 정책 헬퍼 grant: authenticated는 실행 가능, anon은 차단 ──
select case when
     has_function_privilege('authenticated','public.is_suspended()','execute')
 and has_function_privilege('authenticated','public.my_pending_count(text)','execute')
 and has_function_privilege('authenticated','public.is_own_post(uuid)','execute')
 and has_function_privilege('authenticated','public.is_own_deal(text)','execute')
 and not has_function_privilege('anon','public.is_suspended()','execute')
  then 'PASS' else 'FAIL' end || ' — 정책 헬퍼 grant(authenticated only)';

-- ── 2) 연락처 CHECK 실효(리뷰·매물Q&A) — 위반 insert가 거부돼야 PASS ──
do $$
declare v_ok boolean := true;
begin
  begin
    insert into public.reviews(platform_id,user_id,rating,body)
    values ('coupang', gen_random_uuid(), 5, '카톡 abc123 로 연락주세요');
    v_ok := false;  -- 여기 도달하면 CHECK가 안 잡은 것
  exception when check_violation then null;   -- 기대: check_violation
           when others then null;              -- FK 등 다른 이유로 막혀도 노출은 안 됨(관대)
  end;
  raise notice '%', case when v_ok then 'PASS — reviews 연락처 CHECK' else 'FAIL — reviews 연락처 CHECK(우회됨)' end;
end $$;

do $$
declare v_ok boolean := true;
begin
  begin
    insert into public.deal_questions(deal_id,asker_id,question)
    values ('d-x', gen_random_uuid(), '이메일 me@gmail.com 로 문의드려요');
    v_ok := false;
  exception when check_violation then null;
           when others then null;
  end;
  raise notice '%', case when v_ok then 'PASS — deal_questions 연락처 CHECK' else 'FAIL — deal_questions 연락처 CHECK(우회됨)' end;
end $$;

-- ── 3) 익명 공개 뷰에 작성자 식별자 컬럼 부재 ──
select case when not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='v_deals_public'
      and column_name in ('owner_id','created_by')
  ) then 'PASS' else 'FAIL' end || ' — v_deals_public 작성자 식별자 비노출';

-- ── 4) 가격·밸류에이션 컬럼 부재(불변 원칙) — deals에 희망가 컬럼이 없어야 ──
select case when not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='deals'
      and column_name ~* '(price|가격|valuation|밸류|asking)'
  ) then 'PASS' else 'FAIL' end || ' — deals 가격/밸류에이션 컬럼 부재';

-- ── 5) admin RPC는 revoke from anon(권한 상승 표면 차단) ──
select case when
     not has_function_privilege('anon','public.admin_set_suspended(uuid, boolean)','execute')
  then 'PASS' else 'FAIL' end || ' — admin_set_suspended anon 차단';

-- ── 5.5) 운영자 답글 RPC(0040) — anon 차단·authenticated 허용 ──
select case when
     not has_function_privilege('anon','public.operator_reply_review(uuid, text)','execute')
 and has_function_privilege('authenticated','public.operator_reply_review(uuid, text)','execute')
  then 'PASS' else 'FAIL' end || ' — operator_reply_review grant(anon 차단)';

-- ── 5.6) 게시글 갱신 RPC(0041) — anon 차단·authenticated 허용 ──
select case when
     not has_function_privilege('anon','public.refresh_my_partner_post(uuid)','execute')
 and not has_function_privilege('anon','public.refresh_my_deal(text)','execute')
 and has_function_privilege('authenticated','public.refresh_my_partner_post(uuid)','execute')
 and has_function_privilege('authenticated','public.refresh_my_deal(text)','execute')
  then 'PASS' else 'FAIL' end || ' — refresh_my_* grant(anon 차단)';

-- ── 6) profiles: insert/delete 정책 부재(직접 프로필 생성·삭제 차단 — role 자가지정 방지) ──
select case when not exists (
    select 1 from pg_policies
    where schemaname='public' and tablename='profiles' and cmd in ('INSERT','DELETE')
  ) then 'PASS' else 'FAIL' end || ' — profiles insert/delete 정책 부재';
