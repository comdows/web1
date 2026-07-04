-- ============================================================
-- 세모플 0009 — 계정 자기결정권 + 접수 상한 + 연락처 패턴 확장
-- (0001~0008 실행된 DB에 이어서 실행 · 멱등)
-- 크리티컬 갭 감사 P1: ① 셀프서비스 탈퇴(가입은 폼 1개인데 철회는 이메일이던 비대칭 해소)
-- ② 접수·신청 셀프 취소/마감(정정·처리정지권의 인앱 이행) ③ 사용자당 pending 상한(큐 폭주 방어)
-- ④ 연락처 차단 패턴 확장(일반 국번·한글 풀어쓰기·인스타·디스코드 등) — 클라이언트 anonymity.ts와 동시 갱신
-- ============================================================

-- ── 1) 셀프서비스 회원 탈퇴 ──────────────────────────────────
-- profiles가 auth.users on delete cascade(0001)이고 나머지 FK는 0005 §5가 정리 완료:
-- 개인 귀속 데이터는 함께 파기(cascade), 기록성 참조는 익명화(set null).
create or replace function public.delete_my_account()
returns void language sql security definer set search_path = public as $$
  delete from auth.users where id = auth.uid();
$$;
revoke execute on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;

-- ── 2) 접수·신청 셀프 취소(pending일 때만) ───────────────────
drop policy if exists "cancel own submission" on public.submissions;
create policy "cancel own submission" on public.submissions for delete
  using (submitter_id = auth.uid() and status = 'pending');
drop policy if exists "cancel own deal submission" on public.deal_submissions;
create policy "cancel own deal submission" on public.deal_submissions for delete
  using (submitter_id = auth.uid() and status = 'pending');
drop policy if exists "withdraw own ppost interest" on public.partner_post_interests;
create policy "withdraw own ppost interest" on public.partner_post_interests for delete
  using (user_id = auth.uid() and status = 'pending');
drop policy if exists "withdraw own deal interest" on public.deal_interests;
create policy "withdraw own deal interest" on public.deal_interests for delete
  using (user_id = auth.uid() and status = 'pending');

-- 제휴 제안 소유자 마감(검수 대기 철회 또는 게시 종료) — status 전이만 허용하는 좁은 RPC
create or replace function public.close_my_post(p_post_id uuid)
returns void language sql security definer set search_path = public as $$
  update public.partner_posts set status = 'closed'
  where id = p_post_id and created_by = auth.uid() and status in ('pending', 'published');
$$;
revoke execute on function public.close_my_post(uuid) from public, anon;
grant execute on function public.close_my_post(uuid) to authenticated;

-- ── 3) 사용자당 pending 상한(1인 검수 큐 폭주 방어) ──────────
-- RLS 정책 안에서 본인 행을 세기 위한 security definer 카운터(정책 재귀 없이 안전).
create or replace function public.my_pending_count(p_table text)
returns integer language plpgsql stable security definer set search_path = public as $$
declare n integer;
begin
  if p_table = 'submissions' then
    select count(*) into n from public.submissions where submitter_id = auth.uid() and status = 'pending';
  elsif p_table = 'partner_posts' then
    select count(*) into n from public.partner_posts where created_by = auth.uid() and status = 'pending';
  elsif p_table = 'deal_submissions' then
    select count(*) into n from public.deal_submissions where submitter_id = auth.uid() and status = 'pending';
  elsif p_table = 'buyer_briefs' then
    select count(*) into n from public.buyer_briefs where user_id = auth.uid() and active;
  else
    raise exception 'my_pending_count: unknown table %', p_table;
  end if;
  return n;
end $$;
revoke execute on function public.my_pending_count(text) from public, anon;
grant execute on function public.my_pending_count(text) to authenticated;

-- insert 정책에 상한 결합(0008 조건 유지 + cap)
drop policy if exists "insert own submission" on public.submissions;
create policy "insert own submission" on public.submissions for insert
  with check (auth.uid() is not null and submitter_id = auth.uid()
    and public.my_pending_count('submissions') < 10);
drop policy if exists "insert own ppost" on public.partner_posts;
create policy "insert own ppost" on public.partner_posts for insert
  with check (
    auth.uid() is not null and created_by = auth.uid()
    and status = 'pending' and published_at is null and reviewed_by is null and review_reason is null
    and public.my_pending_count('partner_posts') < 3
  );
drop policy if exists "insert own deal submission" on public.deal_submissions;
create policy "insert own deal submission" on public.deal_submissions for insert
  with check (auth.uid() is not null and submitter_id = auth.uid()
    and public.my_pending_count('deal_submissions') < 3);
-- buyer_briefs: for all 단일 정책을 분해해 insert에만 상한(활성 3건) 적용
drop policy if exists "own briefs" on public.buyer_briefs;
drop policy if exists "own briefs read" on public.buyer_briefs;
create policy "own briefs read" on public.buyer_briefs for select using (user_id = auth.uid());
drop policy if exists "own briefs insert" on public.buyer_briefs;
create policy "own briefs insert" on public.buyer_briefs for insert
  with check (user_id = auth.uid() and public.my_pending_count('buyer_briefs') < 3);
drop policy if exists "own briefs update" on public.buyer_briefs;
create policy "own briefs update" on public.buyer_briefs for update
  using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "own briefs delete" on public.buyer_briefs;
create policy "own briefs delete" on public.buyer_briefs for delete using (user_id = auth.uid());

-- ── 4) 연락처 차단 패턴 확장(클라이언트 lib/anonymity.ts CONTACT_RE와 동일 기준 유지) ──
-- 추가: 일반 국번 전화(070·02·031 등), 공일공(한글 풀어쓰기), 인스타/디스코드/라인/위챗, 지메일.
-- \y = 단어 경계(insta가 instant에 오탐되지 않게). NOT VALID: 기존 행 무영향.
alter table public.partner_post_interests drop constraint if exists chk_ppint_nocontact;
alter table public.partner_post_interests add constraint chk_ppint_nocontact
  check ( pitch !~* '(@|https?://|www\.|0\d{1,2}[-. ]?\d{3,4}[-. ]?\d{4}|공일공|카카오톡|카톡|kakao|텔레그램|텔레그람|telegram|인스타|\yinsta(gram)?\y|디스코드|discord|(^|[^가-힣])라인\s?아이디|\yline[ -]?id\y|위챗|wechat|지메일)' ) not valid;
alter table public.deal_interests drop constraint if exists chk_dint_nocontact;
alter table public.deal_interests add constraint chk_dint_nocontact
  check ( intro !~* '(@|https?://|www\.|0\d{1,2}[-. ]?\d{3,4}[-. ]?\d{4}|공일공|카카오톡|카톡|kakao|텔레그램|텔레그람|telegram|인스타|\yinsta(gram)?\y|디스코드|discord|(^|[^가-힣])라인\s?아이디|\yline[ -]?id\y|위챗|wechat|지메일)' ) not valid;
alter table public.buyer_briefs drop constraint if exists chk_brief_nocontact;
alter table public.buyer_briefs add constraint chk_brief_nocontact
  check ( note !~* '(@|https?://|www\.|0\d{1,2}[-. ]?\d{3,4}[-. ]?\d{4}|공일공|카카오톡|카톡|kakao|텔레그램|텔레그람|telegram|인스타|\yinsta(gram)?\y|디스코드|discord|(^|[^가-힣])라인\s?아이디|\yline[ -]?id\y|위챗|wechat|지메일)' ) not valid;
alter table public.deals drop constraint if exists chk_deal_summary_nocontact;
alter table public.deals add constraint chk_deal_summary_nocontact
  check ( summary !~* '(@|https?://|www\.|0\d{1,2}[-. ]?\d{3,4}[-. ]?\d{4}|공일공|카카오톡|카톡|kakao|텔레그램|텔레그람|telegram|인스타|\yinsta(gram)?\y|디스코드|discord|(^|[^가-힣])라인\s?아이디|\yline[ -]?id\y|위챗|wechat|지메일)' ) not valid;
alter table public.deals drop constraint if exists chk_deal_reason_nocontact;
alter table public.deals add constraint chk_deal_reason_nocontact
  check ( sale_reason is null or sale_reason !~* '(@|https?://|www\.|0\d{1,2}[-. ]?\d{3,4}[-. ]?\d{4}|공일공|카카오톡|카톡|kakao|텔레그램|텔레그람|telegram|인스타|\yinsta(gram)?\y|디스코드|discord|(^|[^가-힣])라인\s?아이디|\yline[ -]?id\y|위챗|wechat|지메일)' ) not valid;
alter table public.deals drop constraint if exists chk_deal_highlights_nocontact;
alter table public.deals add constraint chk_deal_highlights_nocontact
  check ( array_to_string(highlights, ' ') !~* '(@|https?://|www\.|0\d{1,2}[-. ]?\d{3,4}[-. ]?\d{4}|공일공|카카오톡|카톡|kakao|텔레그램|텔레그람|telegram|인스타|\yinsta(gram)?\y|디스코드|discord|(^|[^가-힣])라인\s?아이디|\yline[ -]?id\y|위챗|wechat|지메일)' ) not valid;
