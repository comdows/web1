-- ============================================================
-- 세모플 0040 — 운영자 후기 답글(R4)
-- (0001~0039 실행된 DB에 이어 실행 · 멱등)
--
-- 배경(역할 감사): 인증 운영자가 자기 플랫폼 후기에 응답할 수단이 없었다.
-- 설계:
--   · reviews.operator_reply/operator_replied_at 컬럼 + 연락처 차단 CHECK(0037 본문과 동일 기준).
--   · 쓰기는 SECURITY DEFINER RPC(operator_reply_review)로만 — UPDATE 정책+컬럼 grant 조합은
--     admin 검수(status 갱신)와 권한이 얽혀 운영자가 status를 만질 수 있게 되므로 RPC가 안전.
--     본인 인증 플랫폼(platform_operators) + 게시된(published) 후기만, 빈 문자열이면 답글 삭제.
--   · v_reviews_public 개정: id·답글 컬럼 노출 — id는 무작위 uuid라 작성자 비노출 원칙 유지.
--     (부수 수정: 상세 화면 후기 신고 버튼이 뷰에 없는 id를 참조해 undefined로 나가던 잠복 버그 해소)
-- ============================================================

alter table public.reviews add column if not exists operator_reply text;
alter table public.reviews add column if not exists operator_replied_at timestamptz;

-- 답글 연락처 차단(0009/0037과 동일 기준 — 서버 이중화, 클라 hasContact 선차단과 짝)
alter table public.reviews drop constraint if exists chk_review_reply_nocontact;
alter table public.reviews add constraint chk_review_reply_nocontact
  check ( operator_reply is null or (
    char_length(operator_reply) <= 500
    and operator_reply !~* '(@|https?://|www\.|0\d{1,2}[-. ]?\d{3,4}[-. ]?\d{4}|공일공|카카오톡|카톡|kakao|텔레그램|텔레그람|telegram|인스타|\yinsta(gram)?\y|디스코드|discord|(^|[^가-힣])라인\s?아이디|\yline[ -]?id\y|위챗|wechat|지메일)'
  ) ) not valid;

-- 답글 쓰기 RPC — definer로 RLS를 우회하되 자격(본인 인증 플랫폼·published)을 함수 안에서 강제
create or replace function public.operator_reply_review(p_review uuid, p_reply text)
returns void language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  update public.reviews r
     set operator_reply      = nullif(btrim(coalesce(p_reply, '')), ''),
         operator_replied_at = case when nullif(btrim(coalesce(p_reply, '')), '') is null then null else now() end
   where r.id = p_review
     and r.status = 'published'
     and exists (select 1 from public.platform_operators po
                  where po.platform_id = r.platform_id and po.user_id = auth.uid());
  get diagnostics v_n = row_count;
  if v_n = 0 then raise exception 'FORBIDDEN_OR_NOT_FOUND'; end if;
end $$;
revoke execute on function public.operator_reply_review(uuid, text) from public, anon;
grant  execute on function public.operator_reply_review(uuid, text) to authenticated;

-- 공개 뷰 개정 — id(신고 대상 지정)·답글 노출. 작성자 식별자는 계속 비노출.
-- create or replace는 컬럼 추가·순서 변경을 거부하므로 drop 후 재생성(의존 객체 없음 — 클라 전용 뷰).
drop view if exists public.v_reviews_public;
create view public.v_reviews_public
  with (security_invoker = false) as
  select id, platform_id, rating, body, created_at, operator_reply, operator_replied_at
  from public.reviews
  where status = 'published'
  order by created_at desc;
grant select on public.v_reviews_public to anon, authenticated;
