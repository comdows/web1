-- ============================================================
-- 세모플 0042 — 플랫폼 단위 Q&A(P2)
-- (0001~0041 실행된 DB에 이어 실행 · 멱등)
--
-- 배경(기능 기획 P2): 상세 화면의 의사결정 구간에 질문 흐름이 없었다(후기·정정만).
-- 설계(0022 deal_questions 패턴 이식 + 0040 운영자 RPC 패턴):
--   · 공개 표면에는 "답변된 질문"만(FAQ 자산화) — 무응답 게시판 역효과 차단.
--   · 질문은 익명(공개 뷰에 작성자 컬럼 없음) + 연락처 차단 CHECK(0037 기준) 이중화.
--   · 상한: 유저당 플랫폼별 미답변(pending) 질문 1개(부분 unique) + is_suspended 차단.
--   · 답변은 인증 운영자(platform_operators)·admin만 — RPC로 자격을 함수 안에서 강제.
--     운영자 대기함은 definer 뷰(작성자 id 비노출 — 운영자에게도 익명 유지).
-- ============================================================

create table if not exists public.platform_questions (
  id          uuid primary key default gen_random_uuid(),
  platform_id text not null references public.platforms(id) on delete cascade,
  asker_id    uuid not null references public.profiles(id) on delete cascade,
  question    text not null check (char_length(question) between 5 and 300),
  answer      text,
  status      text not null default 'pending' check (status in ('pending', 'answered', 'hidden')),
  created_at  timestamptz not null default now(),
  answered_at timestamptz
);
create index if not exists idx_pq_platform on public.platform_questions(platform_id, status, created_at desc);
-- 유저당 플랫폼별 미답변 질문 1개(플러딩·모더레이션 부담 상한)
create unique index if not exists uq_pq_pending on public.platform_questions(platform_id, asker_id) where status = 'pending';

-- 연락처 차단(0009/0037 동일 기준 — 클라 hasContact 선차단과 짝)
alter table public.platform_questions drop constraint if exists chk_pq_nocontact;
alter table public.platform_questions add constraint chk_pq_nocontact
  check ( (coalesce(question, '') || ' ' || coalesce(answer, ''))
    !~* '(@|https?://|www\.|0\d{1,2}[-. ]?\d{3,4}[-. ]?\d{4}|공일공|카카오톡|카톡|kakao|텔레그램|텔레그람|telegram|인스타|\yinsta(gram)?\y|디스코드|discord|(^|[^가-힣])라인\s?아이디|\yline[ -]?id\y|위챗|wechat|지메일)'
  ) not valid;

alter table public.platform_questions enable row level security;
-- 질문 등록은 본인 명의·pending으로만(정지 계정 차단)
drop policy if exists "own pq insert" on public.platform_questions;
create policy "own pq insert" on public.platform_questions for insert
  with check (asker_id = auth.uid() and status = 'pending' and not public.is_suspended());
-- 원본 행 열람은 본인 질문 + admin. 공개·운영자 노출은 아래 뷰로만.
drop policy if exists "own pq read" on public.platform_questions;
create policy "own pq read" on public.platform_questions for select
  using (asker_id = auth.uid() or public.is_admin());
-- 모더레이션(hidden 처리 등)은 admin만 — 답변은 아래 RPC가 유일한 통로
drop policy if exists "admin pq update" on public.platform_questions;
create policy "admin pq update" on public.platform_questions for update
  using (public.is_admin()) with check (public.is_admin());

-- 답변 RPC — 인증 운영자(해당 플랫폼)·admin만, 빈 문자열이면 답변 철회(pending 복귀)
create or replace function public.operator_answer_platform_question(p_question uuid, p_answer text)
returns void language plpgsql security definer set search_path = public as $$
declare v_ans text; v_n int;
begin
  v_ans := nullif(btrim(coalesce(p_answer, '')), '');
  update public.platform_questions q
     set answer      = v_ans,
         status      = case when v_ans is null then 'pending' else 'answered' end,
         answered_at = case when v_ans is null then null else now() end
   where q.id = p_question
     and q.status <> 'hidden'
     and ( public.is_admin()
        or exists (select 1 from public.platform_operators po
                    where po.platform_id = q.platform_id and po.user_id = auth.uid()) );
  get diagnostics v_n = row_count;
  if v_n = 0 then raise exception 'FORBIDDEN_OR_NOT_FOUND'; end if;
end $$;
revoke execute on function public.operator_answer_platform_question(uuid, text) from public, anon;
grant  execute on function public.operator_answer_platform_question(uuid, text) to authenticated;

-- 공개 Q&A 뷰 — answered만, 작성자 컬럼 없음. id는 신고 대상 지정용(무작위 uuid — 익명 유지).
create or replace view public.v_platform_questions_public
  with (security_invoker = false) as
  select id, platform_id, question, answer, answered_at
  from public.platform_questions
  where status = 'answered'
  order by answered_at desc;
grant select on public.v_platform_questions_public to anon, authenticated;

-- 운영자 대기함(definer) — 내 인증 플랫폼의 pending 질문만, 작성자 비노출. anon 없음.
create or replace view public.v_platform_questions_inbox
  with (security_invoker = false) as
  select q.id, q.platform_id, q.question, q.created_at
  from public.platform_questions q
  where q.status = 'pending'
    and exists (select 1 from public.platform_operators po
                 where po.platform_id = q.platform_id and po.user_id = auth.uid())
  order by q.created_at asc;
revoke all on public.v_platform_questions_inbox from anon;
grant select on public.v_platform_questions_inbox to authenticated;

-- 신고 대상에 Q&A 포함(0028 CHECK 개정 — 운영자 답변도 검수 없이 게시되므로 신고 경로 필수)
alter table public.reports drop constraint if exists reports_target_type_check;
alter table public.reports add constraint reports_target_type_check
  check (target_type in ('review', 'partner_post', 'deal', 'platform_news', 'platform', 'platform_question'));
