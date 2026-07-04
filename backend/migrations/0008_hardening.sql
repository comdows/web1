-- ============================================================
-- 세모플 0008 — RLS 하드닝 (0001~0007 실행된 DB에 이어서 실행 · 멱등)
-- 크리티컬 갭 감사(2026-07-04) P0-1: 검수 우회·상태 위조·폭주 차단.
-- 배경: 익명성·연락처 차단·자산 양수도 한정은 법적 전제인데, 아래 구멍으로
-- 로그인 계정 하나가 검수를 통째로 우회할 수 있었다.
--  (1) 0002 "insert own deal"이 0004에서 제거되지 않아 존속 — 매도자가
--      deals에 직접 insert(status='open')하면 검수·익명화 없이 v_deals_public에 즉시 게시
--  (2) partner_posts insert가 status를 고정하지 않음 — status='published' 직접 게시 가능
--  (3) interests insert가 status·introduced_at 미고정 — 소개 큐 누락·과금 근거 오염
--  (4) deals owner update가 컬럼 무제한 — 게시 후 익명 요약에 연락처 사후 주입 가능
--  (5) deals 텍스트에 연락처 check 부재(0005는 pitch·intro·note만)
--  (6) events가 anon 무제한·무검증 insert — 공개 키만으로 스토리지 고갈 공격 가능
--  (7) v_popular_searches가 definer 뷰라 anon이 검색어 로그 열람 가능
-- ============================================================

-- ── 1) deals: 직접 게시 경로 폐쇄 ────────────────────────────
-- 매도자 접수는 deal_submissions(검수·익명화 SOP) 경로만. 게시는 0004의 admin insert만 존속.
drop policy if exists "insert own deal" on public.deals;

-- ── 2) deals: update는 admin 전용 + 소유자는 '마감' 전이만 RPC로 ──
-- 소유자 자유 update를 없애 게시문(익명 요약) 사후 변조를 차단한다.
drop policy if exists "own or admin update deal" on public.deals;
drop policy if exists "admin update deal" on public.deals;
create policy "admin update deal" on public.deals for update
  using (public.is_admin()) with check (public.is_admin());

-- 소유자 셀프 마감(모집 철회)만 허용하는 좁은 통로 — 컬럼은 status만 바뀐다.
create or replace function public.close_my_deal(p_deal_id text)
returns void language sql security definer set search_path = public as $$
  update public.deals set status = 'closed'
  where id = p_deal_id and owner_id = auth.uid() and status in ('open', 'in_progress');
$$;
revoke execute on function public.close_my_deal(text) from public, anon;
grant execute on function public.close_my_deal(text) to authenticated;

-- ── 3) partner_posts: 접수는 반드시 pending으로 ──────────────
drop policy if exists "insert own ppost" on public.partner_posts;
create policy "insert own ppost" on public.partner_posts for insert
  with check (
    auth.uid() is not null and created_by = auth.uid()
    and status = 'pending' and published_at is null and reviewed_by is null and review_reason is null
  );

-- ── 4) interests: 신청은 반드시 pending·미소개 상태로 ────────
-- introduced_at은 '미이행 환불' 판정 근거(0005 §3) — 클라이언트가 위조하면 안 된다.
drop policy if exists "insert own ppost interest" on public.partner_post_interests;
create policy "insert own ppost interest" on public.partner_post_interests for insert
  with check (
    auth.uid() is not null and user_id = auth.uid()
    and status = 'pending' and introduced_at is null and introduced_by is null
  );
drop policy if exists "insert own interest" on public.deal_interests;
create policy "insert own interest" on public.deal_interests for insert
  with check (
    user_id = auth.uid()
    and status = 'pending' and introduced_at is null and introduced_by is null
  );

-- ── 5) deals 게시문 연락처 서버 방어(0005 §4와 동일 패턴 · NOT VALID) ──
alter table public.deals drop constraint if exists chk_deal_summary_nocontact;
alter table public.deals add constraint chk_deal_summary_nocontact
  check ( summary !~* '(@|https?://|www\.|010[- ]?[0-9]{3,4}[- ]?[0-9]{4}|카카오톡|카톡|kakao|텔레그램|telegram)' ) not valid;
alter table public.deals drop constraint if exists chk_deal_reason_nocontact;
alter table public.deals add constraint chk_deal_reason_nocontact
  check ( sale_reason is null or sale_reason !~* '(@|https?://|www\.|010[- ]?[0-9]{3,4}[- ]?[0-9]{4}|카카오톡|카톡|kakao|텔레그램|telegram)' ) not valid;
alter table public.deals drop constraint if exists chk_deal_highlights_nocontact;
alter table public.deals add constraint chk_deal_highlights_nocontact
  check ( array_to_string(highlights, ' ') !~* '(@|https?://|www\.|010[- ]?[0-9]{3,4}[- ]?[0-9]{4}|카카오톡|카톡|kakao|텔레그램|telegram)' ) not valid;

-- ── 6) 입력 길이 상한(폭주·저장 남용 방어 · NOT VALID) ───────
-- UI maxLength와 정합(여유분 포함): title 40→80, detail/give/get 200→2000, pitch/intro/note→1000
alter table public.partner_posts drop constraint if exists chk_ppost_len;
alter table public.partner_posts add constraint chk_ppost_len
  check ( char_length(title) <= 80 and char_length(detail) <= 2000
      and char_length(give_text) <= 2000 and char_length(get_text) <= 2000
      and char_length(size_text) <= 80 ) not valid;
alter table public.partner_post_interests drop constraint if exists chk_ppint_len;
alter table public.partner_post_interests add constraint chk_ppint_len
  check ( char_length(pitch) <= 1000 and char_length(platform_name) <= 80 and char_length(size_text) <= 80 ) not valid;
alter table public.deal_interests drop constraint if exists chk_dint_len;
alter table public.deal_interests add constraint chk_dint_len
  check ( char_length(intro) <= 1000 ) not valid;
alter table public.buyer_briefs drop constraint if exists chk_brief_len;
alter table public.buyer_briefs add constraint chk_brief_len
  check ( char_length(note) <= 1000 ) not valid;
alter table public.submissions drop constraint if exists chk_sub_payload_size;
alter table public.submissions add constraint chk_sub_payload_size
  check ( pg_column_size(payload) < 16384 ) not valid;
alter table public.deal_submissions drop constraint if exists chk_dealsub_payload_size;
alter table public.deal_submissions add constraint chk_dealsub_payload_size
  check ( pg_column_size(payload) < 16384 ) not valid;

-- ── 7) events: 공개 anon insert의 크기 상한 ──────────────────
alter table public.events drop constraint if exists chk_events_query_len;
alter table public.events add constraint chk_events_query_len
  check ( query is null or char_length(query) <= 80 ) not valid;
alter table public.events drop constraint if exists chk_events_session_len;
alter table public.events add constraint chk_events_session_len
  check ( session_id is null or char_length(session_id) <= 40 ) not valid;

-- ── 8) v_popular_searches: 검색어 로그는 admin만(행동 데이터 노출 차단) ──
-- definer 뷰가 events의 admin-only RLS를 우회하고 있었다. 사용처는 관리 콘솔뿐.
create or replace view public.v_popular_searches as
select query, count(*) as cnt
from public.events
where type = 'search' and query is not null and created_at > now() - interval '7 days'
  and public.is_admin()
group by query order by cnt desc limit 20;

-- ── 9) favorites: admin 읽기(백업 워크플로 전제 — 쓰기는 여전히 본인만) ──
drop policy if exists "admin read favorites" on public.favorites;
create policy "admin read favorites" on public.favorites for select
  using (user_id = auth.uid() or public.is_admin());
