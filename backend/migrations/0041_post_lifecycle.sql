-- ============================================================
-- 세모플 0041 — 게시글 수명 관리(P1)
-- (0001~0040 실행된 DB에 이어 실행 · 멱등)
--
-- 배경(기능 기획 P1): 제휴 제안·매물 보드는 유동성 콜드스타트 단계라 죽은 게시글이
-- 쌓이면 보드 신뢰가 무너진다. 시간 기반 만료·소유자 갱신·경과 알림이 없었다.
-- 설계:
--   · refreshed_at 컬럼(제휴·매물) — "계속 유효함"의 소유자 확인 시각. 순위 조작성
--     끌어올리기가 아니라 유효성 재확인만(정렬은 기존 posted 그대로 — 디렉토리 중립).
--   · 만료는 상태 저장 없이 공개 뷰 필터로: 기준시각(coalesce(refreshed_at, 게시시각))이
--     90일을 넘긴 open 게시글은 뷰에서 제외 — 잡이 상태를 바꿀 필요가 없어 멱등·무드리프트,
--     "복구" = 갱신 RPC 1회(재노출). matched(성사)·demo·진행 중 매물은 만료 대상 아님.
--   · 갱신은 좁은 RPC로만(0008 close_my_deal 패턴) — 소유자 직접 UPDATE는 게시문 사후
--     변조 차단 설계라 계속 막아둔다. 60일 경과 알림은 notify.mjs(post_stale)가 생성.
-- ============================================================

alter table public.partner_posts add column if not exists refreshed_at timestamptz;
alter table public.deals         add column if not exists refreshed_at timestamptz;

-- 소유자 갱신 RPC — 자격(본인·게시 상태)을 함수 안에서 강제, 바뀌는 건 refreshed_at뿐
create or replace function public.refresh_my_partner_post(p_post_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  update public.partner_posts set refreshed_at = now()
   where id = p_post_id and created_by = auth.uid() and status = 'published';
  get diagnostics v_n = row_count;
  if v_n = 0 then raise exception 'FORBIDDEN_OR_NOT_FOUND'; end if;
end $$;
revoke execute on function public.refresh_my_partner_post(uuid) from public, anon;
grant  execute on function public.refresh_my_partner_post(uuid) to authenticated;

create or replace function public.refresh_my_deal(p_deal_id text)
returns void language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  update public.deals set refreshed_at = now()
   where id = p_deal_id and owner_id = auth.uid() and status in ('open', 'in_progress');
  get diagnostics v_n = row_count;
  if v_n = 0 then raise exception 'FORBIDDEN_OR_NOT_FOUND'; end if;
end $$;
revoke execute on function public.refresh_my_deal(text) from public, anon;
grant  execute on function public.refresh_my_deal(text) to authenticated;

-- 공개 뷰 개정 — 기존 컬럼·조건(0012/0026) 유지 + 끝에 refreshed 추가 + 90일 미갱신 제외.
-- create or replace는 "끝에 컬럼 추가"만 허용되는 제약에 맞춘 개정(기존 컬럼 순서 불변).
create or replace view public.v_partner_posts_public
  with (security_invoker = false) as
select pp.id, pp.title, pp.category_id, pp.type_id, pp.give_text, pp.get_text,
       pp.want_categories, pp.size_text, pp.detail, pp.status, pp.published_at::date as posted,
       exists (select 1 from public.subscriptions sb
               where sb.user_id = pp.created_by and sb.plan_id = 'pro'
                 and sb.status::text = 'active'
                 and coalesce(sb.current_period_end, now()) > now()) as pro_verified,
       pp.refreshed_at::date as refreshed
from public.partner_posts pp
where pp.status in ('published', 'matched')
  and ( pp.status = 'matched'   -- 성사 사례는 신뢰 자산 — 만료 없음
     or coalesce(pp.refreshed_at, pp.published_at, pp.created_at) > now() - interval '90 days' );

create or replace view public.v_deals_public
  with (security_invoker = false) as
  select id, category_id, region, revenue_band, mode, summary, highlights, sale_reason,
         status, is_demo, posted, owner_verified, proofs,
         refreshed_at::date as refreshed
  from public.deals d
  where status <> 'closed'
    and (listed_until is null or listed_until >= current_date)
    and ( is_demo                 -- 데모·진행 중 매물은 만료 대상 아님(open 모집만)
       or status <> 'open'
       or coalesce(d.refreshed_at, d.created_at) > now() - interval '90 days' )
    and ( is_demo
      or d.created_at <= now() - interval '48 hours'
      or not coalesce((select (value->>'buyer_early')::boolean from public.app_settings where key = 'billing'), false)
      or public.is_admin()
      or exists (select 1 from public.subscriptions sb
                 where sb.user_id = auth.uid() and sb.plan_id = 'buyer'
                   and sb.status::text = 'active' and coalesce(sb.current_period_end, now()) > now()) );
