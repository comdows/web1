-- ============================================================
-- 세모플 0028 — 실운용 준비: 신고·사후 모더레이션 + 회원 정지 + 문의 + 보존 정리 + 상한
-- (0001~0027 실행된 DB에 이어 실행 · 멱등)
--
-- 실사용자 유입 전 공백 해소:
--  · 신고(reports): 게시된 리뷰·제휴·매물·소식·플랫폼을 회원이 신고 → 관리 콘솔 큐에서 처리
--  · 회원 정지(suspended_at): 스팸·악성 계정의 쓰기만 차단(읽기·로그인은 유지 — 이의 제기 가능)
--  · 문의(inquiries): 인앱 문의 접수·답변(개인 mailto 단일 채널 탈피)
--  · 상한: 리뷰·질문·관심에도 사용자당 상한(0009 my_pending_count 패턴 확장 — 검수 큐 폭주 방어)
--  · notifications 보존 정리(0010 purge_old_events 패턴 — 무한 증가 방지)
-- ============================================================

-- ── 1) 회원 정지 — 컬럼 + 헬퍼 + 좁은 토글 RPC ─────────────────
-- profiles에 일반 admin update 정책을 열지 않는다(role 변경 통로 차단) — 정지 전용 RPC만.
alter table public.profiles add column if not exists suspended_at timestamptz;

create or replace function public.is_suspended()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and suspended_at is not null);
$$;
revoke execute on function public.is_suspended() from public, anon;
grant execute on function public.is_suspended() to authenticated;

create or replace function public.admin_set_suspended(p_user uuid, p_suspend boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception '관리자 전용'; end if;
  update public.profiles set suspended_at = case when p_suspend then now() else null end
   where id = p_user and role <> 'admin';    -- admin 계정 셀프락 방지
  if not found then raise exception '대상 회원이 없거나 관리자 계정입니다'; end if;
end $$;
revoke execute on function public.admin_set_suspended(uuid, boolean) from public, anon;
grant execute on function public.admin_set_suspended(uuid, boolean) to authenticated;

-- ── 2) my_pending_count 확장(0009 재정의 — 기존 4분기 원문 유지 + 신규 분기) ──
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
  elsif p_table = 'reports' then
    select count(*) into n from public.reports where reporter_id = auth.uid() and status = 'pending';
  elsif p_table = 'inquiries' then
    select count(*) into n from public.inquiries where user_id = auth.uid() and status = 'open';
  elsif p_table = 'reviews' then
    select count(*) into n from public.reviews where user_id = auth.uid() and status = 'pending';
  elsif p_table = 'deal_questions' then
    select count(*) into n from public.deal_questions where asker_id = auth.uid() and status = 'pending';
  elsif p_table = 'partner_post_interests' then
    select count(*) into n from public.partner_post_interests where user_id = auth.uid() and status = 'pending';
  elsif p_table = 'deal_interests' then
    select count(*) into n from public.deal_interests where user_id = auth.uid() and status = 'pending';
  else
    raise exception 'my_pending_count: unknown table %', p_table;
  end if;
  return n;
end $$;
revoke execute on function public.my_pending_count(text) from public, anon;
grant execute on function public.my_pending_count(text) to authenticated;

-- ── 3) reports — 회원 신고(본인 조회 · admin 처리 · 미처리 5건 상한) ──
create table if not exists public.reports (
  id           uuid primary key default gen_random_uuid(),
  reporter_id  uuid not null references public.profiles(id) on delete cascade,
  target_type  text not null check (target_type in ('review','partner_post','deal','platform_news','platform')),
  target_id    text not null,
  reason       text not null check (char_length(reason) between 10 and 500),
  status       text not null default 'pending' check (status in ('pending','resolved','dismissed')),
  resolve_note text,
  resolved_by  uuid references public.profiles(id) on delete set null,
  resolved_at  timestamptz,
  created_at   timestamptz not null default now(),
  unique (reporter_id, target_type, target_id)   -- 동일 대상 중복 신고 방지(재신고는 409)
);
create index if not exists idx_reports_status on public.reports(status, created_at asc);
alter table public.reports enable row level security;
drop policy if exists "own report insert" on public.reports;
create policy "own report insert" on public.reports for insert
  with check (reporter_id = auth.uid() and status = 'pending'
    and not public.is_suspended() and public.my_pending_count('reports') < 5);
drop policy if exists "own report read" on public.reports;
create policy "own report read" on public.reports for select
  using (reporter_id = auth.uid() or public.is_admin());
drop policy if exists "admin report manage" on public.reports;
create policy "admin report manage" on public.reports for update
  using (public.is_admin()) with check (public.is_admin());

-- ── 4) 리뷰 — 본인 삭제 + 공개 뷰에 행 id(신고 대상 지칭용 — 작성자 식별자 아님) ──
drop policy if exists "own review delete" on public.reviews;
create policy "own review delete" on public.reviews for delete
  using (user_id = auth.uid());
-- create or replace view는 컬럼 추가가 끝에서만 가능 — drop 후 재생성(grant 재발급)
drop view if exists public.v_reviews_public;
create view public.v_reviews_public
  with (security_invoker = false) as
  select platform_id, rating, body, created_at, id
  from public.reviews
  where status = 'published'
  order by created_at desc;
grant select on public.v_reviews_public to anon, authenticated;

-- ── 5) inquiries — 인앱 문의(본인 접수·조회 · admin 답변 · open 3건 상한) ──
create table if not exists public.inquiries (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  title      text not null check (char_length(title) between 2 and 100),
  body       text not null check (char_length(body) between 10 and 2000),
  status     text not null default 'open' check (status in ('open','answered','closed')),
  reply      text,
  replied_by uuid references public.profiles(id) on delete set null,
  replied_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_inquiries_status on public.inquiries(status, created_at asc);
alter table public.inquiries enable row level security;
drop policy if exists "own inquiry insert" on public.inquiries;
create policy "own inquiry insert" on public.inquiries for insert
  with check (user_id = auth.uid() and status = 'open'
    and not public.is_suspended() and public.my_pending_count('inquiries') < 3);
drop policy if exists "own inquiry read" on public.inquiries;
create policy "own inquiry read" on public.inquiries for select
  using (user_id = auth.uid() or public.is_admin());
drop policy if exists "admin inquiry manage" on public.inquiries;
create policy "admin inquiry manage" on public.inquiries for update
  using (public.is_admin()) with check (public.is_admin());

-- ── 6) v_admin_members — 회원 조회(auth.users.email 포함, admin에게만 행 반환 — 0005 패턴) ──
create or replace view public.v_admin_members
  with (security_invoker = false) as
select p.id, au.email, p.display_name, p.role::text as role, p.suspended_at, p.created_at,
       (select count(*) from public.submissions s       where s.submitter_id  = p.id) as submissions,
       (select count(*) from public.partner_posts pp    where pp.created_by   = p.id) as partner_posts,
       (select count(*) from public.deal_submissions ds where ds.submitter_id = p.id) as deal_subs,
       (select count(*) from public.reviews r           where r.user_id       = p.id) as reviews
from public.profiles p
left join auth.users au on au.id = p.id
where public.is_admin();
grant select on public.v_admin_members to authenticated;

-- ── 7) 쓰기 insert 정책 재생성 — 기존 조건 원문 + not is_suspended() (+신규 상한) ──
-- 정책명·기존 조건은 0002/0004/0009/0013/0022/0025의 현행 원문 그대로, 결합만 추가.
drop policy if exists "insert own submission" on public.submissions;
create policy "insert own submission" on public.submissions for insert
  with check (auth.uid() is not null and submitter_id = auth.uid()
    and not public.is_suspended()
    and public.my_pending_count('submissions') < 10);
drop policy if exists "insert own ppost" on public.partner_posts;
create policy "insert own ppost" on public.partner_posts for insert
  with check (
    auth.uid() is not null and created_by = auth.uid()
    and status = 'pending' and published_at is null and reviewed_by is null and review_reason is null
    and not public.is_suspended()
    and public.my_pending_count('partner_posts') < 3
  );
drop policy if exists "insert own deal submission" on public.deal_submissions;
create policy "insert own deal submission" on public.deal_submissions for insert
  with check (auth.uid() is not null and submitter_id = auth.uid()
    and not public.is_suspended()
    and public.my_pending_count('deal_submissions') < 3);
drop policy if exists "own briefs insert" on public.buyer_briefs;
create policy "own briefs insert" on public.buyer_briefs for insert
  with check (user_id = auth.uid()
    and not public.is_suspended()
    and public.my_pending_count('buyer_briefs') < 3);
drop policy if exists "own review insert" on public.reviews;
create policy "own review insert" on public.reviews for insert
  with check (user_id = auth.uid() and status = 'pending'
    and not public.is_suspended()
    and public.my_pending_count('reviews') < 5);
drop policy if exists "own question insert" on public.deal_questions;
create policy "own question insert" on public.deal_questions for insert
  with check (asker_id = auth.uid()
    and not public.is_suspended()
    and public.my_pending_count('deal_questions') < 10);
drop policy if exists "insert own ppost interest" on public.partner_post_interests;
create policy "insert own ppost interest" on public.partner_post_interests for insert
  with check (
    auth.uid() is not null and user_id = auth.uid()
    and status = 'pending' and introduced_at is null and introduced_by is null
    and not public.is_own_post(post_id)
    and not public.is_suspended()
    and public.my_pending_count('partner_post_interests') < 10
  );
drop policy if exists "insert own interest" on public.deal_interests;
create policy "insert own interest" on public.deal_interests for insert
  with check (
    user_id = auth.uid()
    and status = 'pending' and introduced_at is null and introduced_by is null
    and not public.is_own_deal(deal_id)
    and not public.is_suspended()
    and public.my_pending_count('deal_interests') < 10
  );

-- ── 8) notifications 보존 정리(0010 purge_old_events 패턴 — 봇이 주간 호출) ──
create or replace function public.purge_old_notifications(p_read_days integer default 90, p_unread_days integer default 180)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if not public.is_admin() then raise exception '관리자 전용'; end if;
  -- 최소 보존 보장(실수로 작은 값을 넘겨도 최근 알림이 지워지지 않게)
  delete from public.notifications
   where (read_at is not null and read_at    < now() - make_interval(days => greatest(p_read_days, 30)))
      or (read_at is null     and created_at < now() - make_interval(days => greatest(p_unread_days, 60)));
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function public.purge_old_notifications(integer, integer) from public, anon;
grant execute on function public.purge_old_notifications(integer, integer) to authenticated;
