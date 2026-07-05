-- ============================================================
-- 세모플 0013 — 3차 QA(실사용 여정) 서버측 수정 (0001~0012 실행된 DB에 이어서 실행 · 멱등)
-- 본인 게시물에 대한 자기 신청(EOI) 차단: 클라이언트 가드와 별개로 RLS가 강제.
-- 자기 신청이 통과되면 자기 동의까지 성립해 self-pair가 소개 큐에 진입하는 문제(QA3 확인).
-- 주의: partner_posts/deals의 select 정책은 본인·관리자 한정이라 정책 안에서 직접
-- 서브쿼리하면 타인 게시물 신청까지 막힌다 — security definer 헬퍼로 소유 여부만 판정.
-- ============================================================

create or replace function public.is_own_post(p_post_id uuid)
returns boolean language sql security definer stable set search_path = public as
$$ select exists (select 1 from public.partner_posts where id = p_post_id and created_by = auth.uid()) $$;
revoke execute on function public.is_own_post(uuid) from public, anon;
grant execute on function public.is_own_post(uuid) to authenticated;

create or replace function public.is_own_deal(p_deal_id text)
returns boolean language sql security definer stable set search_path = public as
$$ select exists (select 1 from public.deals where id = p_deal_id and owner_id = auth.uid()) $$;
revoke execute on function public.is_own_deal(text) from public, anon;
grant execute on function public.is_own_deal(text) to authenticated;

-- 0008 §4 정책에 자기 신청 차단 조건 추가(기존 조건 유지)
drop policy if exists "insert own ppost interest" on public.partner_post_interests;
create policy "insert own ppost interest" on public.partner_post_interests for insert
  with check (
    auth.uid() is not null and user_id = auth.uid()
    and status = 'pending' and introduced_at is null and introduced_by is null
    and not public.is_own_post(post_id)
  );
drop policy if exists "insert own interest" on public.deal_interests;
create policy "insert own interest" on public.deal_interests for insert
  with check (
    user_id = auth.uid()
    and status = 'pending' and introduced_at is null and introduced_by is null
    and not public.is_own_deal(deal_id)
  );
