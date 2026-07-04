-- ============================================================
-- 세모플 0011 — 제휴 수익화 실행 준비 (0001~0010 실행된 DB에 이어서 실행 · 멱등)
-- 3상품(스폰서 슬롯·연결료 A/B/C·Pro 멤버십)의 주문→무통장 입금 확인→활성화→환불
-- 생명주기를 "켜기 직전"까지 완성한다. 스위치는 이중(app_settings 'billing' + FLAGS.billing)이며
-- 기본 전부 꺼짐 — 프론트를 우회해 REST로 호출해도 place_order 첫 줄에서 거부된다.
--
-- ⚠️ 유료화 스위치를 켜기 전 필수 체크리스트(하나라도 미완이면 켜지 말 것):
--   ① 통신판매업 신고  ② pricing-policy.md §6-2 무통장 한시 허용 단서 개정
--   ③ 처리방침 §1 증빙 발행 정보 추가 + TERMS_VERSION 상향  ④ 30일 공지(app_settings 'pricing_announced_at' 설정)
--
-- 구현 노트: 신규 enum 값('awaiting_deposit','pending_payment')은 같은 트랜잭션에서
-- enum 리터럴로 쓸 수 없으므로(Supabase Editor 단일 트랜잭션) 뷰에서는 ::text 비교,
-- 함수는 전부 plpgsql(본문은 실행 시점 평가)로 작성한다. 인덱스 술어는 기존 값만 사용.
-- ============================================================

-- ── 1) 상태 enum 확장 ────────────────────────────────────────
alter type public.charge_status_t add value if not exists 'awaiting_deposit';
alter type public.sub_status_t    add value if not exists 'pending_payment';

-- ── 2) charges 확장(0001 테이블 재사용 — 무통장·환불·할인·증빙) ──
alter table public.charges
  add column if not exists interest_kind    text check (interest_kind in ('partner','deal')),
  add column if not exists interest_id      uuid,             -- 다형 참조(존재 검증은 admin_introduce가 수행)
  add column if not exists fee_tier         text check (fee_tier in ('A','B','C')),  -- 소개 시점 스냅샷(가격 개정 분쟁 방지)
  add column if not exists depositor_name   text,
  add column if not exists deposit_deadline date,
  add column if not exists confirmed_by     uuid references public.profiles(id) on delete set null,
  add column if not exists discount_rate    numeric check (discount_rate >= 0 and discount_rate <= 1),
  add column if not exists discount_reason  text,             -- 'founder' 등
  add column if not exists refund_amount    int check (refund_amount >= 0),
  add column if not exists refunded_at      timestamptz,
  add column if not exists refund_reason    text,
  add column if not exists cash_receipt_no  text,
  add column if not exists updated_at       timestamptz not null default now();
do $$ begin
  create trigger touch_charges before update on public.charges
    for each row execute function public.tg_touch_updated_at();
exception when duplicate_object then null; end $$;
-- 이중 과금 방지: 같은 소개 건에 살아있는 연결료 청구는 1건만
create unique index if not exists uq_charges_connection on public.charges(interest_id)
  where kind = 'connection_fee' and status not in ('canceled', 'refunded');

-- ── 3) subscriptions 확장 + 중복 활성 구독 방지 ──────────────
alter table public.subscriptions
  add column if not exists current_period_start timestamptz,
  add column if not exists current_period_end   timestamptz,
  add column if not exists price_snapshot       int,
  add column if not exists activated_at         timestamptz;
create unique index if not exists uq_subs_active on public.subscriptions(user_id)
  where status in ('active', 'past_due');

-- ── 4) credit_ledger 확장(Pro 포함분 버킷·만료) + 이중 차감 방지 ──
alter table public.credit_ledger
  add column if not exists bucket     text not null default 'paid' check (bucket in ('paid','bonus','plan_included')),
  add column if not exists expires_at timestamptz;
create unique index if not exists uq_credit_connection on public.credit_ledger(ref_id, reason)
  where reason = 'connection_fee';

-- ── 5) 제휴 유형 → 요금 등급(A 무료/B 22,000/C 77,000 · VAT 포함가) 확정 매핑 ──
alter table public.partner_types
  add column if not exists fee_tier text not null default 'A' check (fee_tier in ('A','B','C'));
update public.partner_types set fee_tier = 'B' where id in
  ('referral_fee','cross_signup','cross_onboarding','affiliate_listing','lead_exchange');
update public.partner_types set fee_tier = 'C' where id in
  ('api_embed','data_partnership','infra_deal','group_alliance');
update public.partner_types set fee_tier = 'A' where id not in
  ('referral_fee','cross_signup','cross_onboarding','affiliate_listing','lead_exchange',
   'api_embed','data_partnership','infra_deal','group_alliance');

-- ── 6) 플로우 컬럼: 제안자 동의·확인(B/C형 과금·환불 판정의 기준 시각) ──
alter table public.partner_posts          add column if not exists contact_consent_at timestamptz;
alter table public.partner_post_interests add column if not exists owner_confirmed_at timestamptz,
                                          add column if not exists introduced_evidence text;
alter table public.deal_interests         add column if not exists owner_confirmed_at timestamptz,
                                          add column if not exists introduced_evidence text;

-- ── 7) plans 시드 정정 — 규약: monthly_price = VAT "포함" 표시가 ──
comment on column public.plans.monthly_price is
  'VAT 포함 표시가(원). charges 기록 시 공급가=round(총액/1.1), 부가세=총액-공급가로 역산한다.';
update public.plans set monthly_price = 66000  where id = 'pro'     and monthly_price <> 66000;
update public.plans set monthly_price = 220000 where id = 'premium' and monthly_price <> 220000;

-- ── 8) 디렉토리 지면 광고 봉인(불변 원칙: 검색·비교·순위 비판매 — 유료 노출은 보드 한정) ──
update public.boost_tiers set active = false where id in ('home_hero','cat_top','search_boost');

-- ── 9) app_settings — 서버측 과금 스위치 + 30일 공지 기산점의 단일 소스 ──
create table if not exists public.app_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.app_settings enable row level security;
drop policy if exists "public read settings" on public.app_settings;
create policy "public read settings" on public.app_settings for select using (true);
drop policy if exists "admin write settings" on public.app_settings;
create policy "admin write settings" on public.app_settings for all
  using (public.is_admin()) with check (public.is_admin());
insert into public.app_settings (key, value) values
  ('billing', '{"sponsor": false, "connection": false, "membership": false, "bank": "", "deposit_deadline_days": 7}'),
  ('pricing_announced_at', 'null')
on conflict (key) do nothing;

-- ── 10) sponsor_slots — 보드 상단 2슬롯(소재 = 검수 통과한 자기 제안) ──
create extension if not exists btree_gist;
create table if not exists public.sponsor_slots (
  id              uuid primary key default gen_random_uuid(),
  slot_no         int not null check (slot_no in (1, 2)),
  partner_post_id uuid not null references public.partner_posts(id) on delete cascade,
  sponsor_user_id uuid not null references public.profiles(id) on delete cascade,
  starts_on       date not null,
  ends_on         date not null check (ends_on >= starts_on),
  charge_id       uuid references public.charges(id) on delete set null,
  created_at      timestamptz not null default now()
);
do $$ begin
  alter table public.sponsor_slots add constraint excl_sponsor_slot_overlap
    exclude using gist (slot_no with =, daterange(starts_on, ends_on, '[]') with &&);
exception when duplicate_object or duplicate_table then null; end $$;
alter table public.sponsor_slots enable row level security;
drop policy if exists "own or admin read slot" on public.sponsor_slots;
create policy "own or admin read slot" on public.sponsor_slots for select
  using (sponsor_user_id = auth.uid() or public.is_admin());
drop policy if exists "admin manage slots" on public.sponsor_slots;
create policy "admin manage slots" on public.sponsor_slots for all
  using (public.is_admin()) with check (public.is_admin());
-- 공개 뷰: 오늘 활성 슬롯의 익명 필드만(작성자 식별자 금지 — v_partner_posts_public 패턴)
create or replace view public.v_sponsor_slots_public
  with (security_invoker = false) as
select s.slot_no, p.id, p.title, p.category_id, p.type_id, p.give_text, p.get_text,
       p.want_categories, p.size_text, p.detail
from public.sponsor_slots s
join public.partner_posts p on p.id = s.partner_post_id
where current_date between s.starts_on and s.ends_on
  and p.status in ('published', 'matched');

-- ── 11) 공개 보드 뷰에 Pro 인증 배지(익명성 유지 — boolean만 노출) ──
create or replace view public.v_partner_posts_public
  with (security_invoker = false) as
select pp.id, pp.title, pp.category_id, pp.type_id, pp.give_text, pp.get_text,
       pp.want_categories, pp.size_text, pp.detail, pp.status, pp.published_at::date as posted,
       exists (select 1 from public.subscriptions sb
               where sb.user_id = pp.created_by and sb.plan_id = 'pro'
                 and sb.status::text = 'active') as pro_verified
from public.partner_posts pp where pp.status in ('published', 'matched');

-- ── 12) 제안자 수신함 — 내 제안에 달린 신청(익명 필드만, 이메일·user_id 제외) ──
create or replace view public.v_my_post_interests
  with (security_invoker = false) as
select i.id, i.post_id, pp.title as post_title, i.platform_name, i.size_text, i.pitch,
       i.status, i.owner_confirmed_at, i.created_at
from public.partner_post_interests i
join public.partner_posts pp on pp.id = i.post_id
where pp.created_by = auth.uid();

-- ── 13) 소개 큐 뷰 재정의 — 상태 필터 + 제안자 확인 컬럼(0005 컬럼 순서 유지, 말미 추가) ──
create or replace view public.v_admin_intro_queue
  with (security_invoker = false) as
select 'partner'::text as kind, i.id, i.created_at, i.status,
       i.pitch as message, i.platform_name,
       coalesce(pp.title, '') as target_title,
       au1.email as applicant_email, au2.email as counterpart_email,
       i.contact_consent_at, i.owner_confirmed_at
from public.partner_post_interests i
join public.partner_posts pp on pp.id = i.post_id
left join auth.users au1 on au1.id = i.user_id
left join auth.users au2 on au2.id = pp.created_by
where public.is_admin() and pp.status in ('published', 'matched')
union all
select 'deal', i.id, i.created_at, i.status, i.intro, '', i.deal_id,
       au1.email, au2.email, i.contact_consent_at, i.owner_confirmed_at
from public.deal_interests i
join public.deals d on d.id = i.deal_id
left join auth.users au1 on au1.id = i.user_id
left join auth.users au2 on au2.id = d.owner_id
where public.is_admin() and d.status <> 'closed';

-- ── 14) 과금 운영 뷰(관리자) — ::text 비교(신규 enum 값의 동일 트랜잭션 안전성) ──
create or replace view public.v_admin_billing_queue
  with (security_invoker = false) as
select c.id, c.kind::text as kind, c.amount, c.vat, c.memo, c.depositor_name, c.deposit_deadline,
       c.fee_tier, c.created_at, au.email as user_email
from public.charges c left join auth.users au on au.id = c.user_id
where public.is_admin() and c.status::text = 'awaiting_deposit';
create or replace view public.v_admin_refund_due
  with (security_invoker = false) as
select c.id, c.amount, c.vat, c.interest_kind, c.interest_id, c.paid_at, au.email as user_email
from public.charges c left join auth.users au on au.id = c.user_id
where public.is_admin() and c.kind = 'connection_fee' and c.status = 'paid'
  and ((c.interest_kind = 'partner' and exists
         (select 1 from public.partner_post_interests i where i.id = c.interest_id and i.introduced_at is null))
    or (c.interest_kind = 'deal' and exists
         (select 1 from public.deal_interests i where i.id = c.interest_id and i.introduced_at is null)));

-- ── 15) 파운더 사전 등록(알림 채널 — 할인 "자격"은 활동 이력으로 판정) ──
alter table public.profiles add column if not exists founder_optin_at timestamptz;

-- ── 16) RPC들 (전부 plpgsql security definer + is_admin/소유자 가드) ──

/* 주문 생성 — 서버가 스위치·금액을 판정(프론트 우회 봉인·금액 위조 방지) */
create or replace function public.place_order(p_kind text, p_plan_id text default null, p_post_id uuid default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare bill jsonb; total int; v_amount int; v_vat int; cid uuid; deadline_days int;
begin
  if auth.uid() is null then raise exception '로그인이 필요합니다'; end if;
  select value into bill from public.app_settings where key = 'billing';
  deadline_days := coalesce((bill->>'deposit_deadline_days')::int, 7);
  if p_kind = 'boost' then
    if not coalesce((bill->>'sponsor')::boolean, false) then raise exception '스폰서 상품은 아직 오픈 전입니다'; end if;
    if not exists (select 1 from public.partner_posts
                   where id = p_post_id and created_by = auth.uid() and status = 'published')
      then raise exception '게시 중인 본인 제안에만 신청할 수 있어요'; end if;
    total := 99000;
  elsif p_kind = 'subscription' then
    if not coalesce((bill->>'membership')::boolean, false) then raise exception '멤버십은 아직 오픈 전입니다'; end if;
    if p_plan_id is distinct from 'pro' then raise exception '신청 가능한 플랜이 아닙니다'; end if;
    if exists (select 1 from public.subscriptions where user_id = auth.uid() and status in ('active','past_due'))
      then raise exception '이미 활성 구독이 있습니다'; end if;
    select monthly_price into total from public.plans where id = p_plan_id;
  else
    raise exception '알 수 없는 상품: %', p_kind;
  end if;
  v_amount := round(total / 1.1)::int;  -- VAT 포함가 → 공급가 역산
  v_vat := total - v_amount;
  insert into public.charges (kind, user_id, amount, vat, status, deposit_deadline, memo)
  values (p_kind::charge_kind_t, auth.uid(), v_amount, v_vat, 'awaiting_deposit',
          current_date + deadline_days,
          case when p_kind = 'boost' then 'post:' || p_post_id else 'plan:' || p_plan_id end)
  returning id into cid;
  return cid;
end $$;
revoke execute on function public.place_order(text, text, uuid) from public, anon;
grant execute on function public.place_order(text, text, uuid) to authenticated;

/* 입금 확인 — awaiting_deposit→paid, 구독이면 활성화 + 포함 크레딧 적립 */
create or replace function public.admin_confirm_deposit(p_charge_id uuid, p_depositor text)
returns void language plpgsql security definer set search_path = public as $$
declare c record; period_end timestamptz;
begin
  if not public.is_admin() then raise exception '관리자 전용'; end if;
  select * into c from public.charges where id = p_charge_id;
  if c is null then raise exception '청구를 찾을 수 없습니다'; end if;
  if c.status::text <> 'awaiting_deposit' then raise exception '입금 대기 상태가 아닙니다(%)', c.status; end if;
  update public.charges set status = 'paid', paid_at = now(),
    depositor_name = p_depositor, confirmed_by = auth.uid() where id = p_charge_id;
  if c.kind = 'subscription' then
    period_end := now() + interval '1 month';
    insert into public.subscriptions (user_id, plan_id, status, current_period_start, current_period_end, price_snapshot, activated_at)
    values (c.user_id, 'pro', 'active', now(), period_end, c.amount + c.vat, now());
    -- B형 3건 포함분(66,000) — 주기말 소멸 버킷
    insert into public.credit_ledger (user_id, delta, reason, ref_id, bucket, expires_at)
    values (c.user_id, 66000, 'free_monthly', p_charge_id, 'plan_included', period_end);
  end if;
end $$;
revoke execute on function public.admin_confirm_deposit(uuid, text) from public, anon;
grant execute on function public.admin_confirm_deposit(uuid, text) to authenticated;

/* 환불 — paid→refunded만, 금액 상한 검증 */
create or replace function public.admin_refund_charge(p_charge_id uuid, p_amount int, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare c record;
begin
  if not public.is_admin() then raise exception '관리자 전용'; end if;
  select * into c from public.charges where id = p_charge_id;
  if c is null or c.status <> 'paid' then raise exception 'paid 상태의 청구만 환불할 수 있습니다'; end if;
  if p_amount < 0 or p_amount > c.amount + c.vat then raise exception '환불 금액이 결제액을 초과합니다'; end if;
  update public.charges set status = 'refunded', refund_amount = p_amount,
    refunded_at = now(), refund_reason = p_reason where id = p_charge_id;
end $$;
revoke execute on function public.admin_refund_charge(uuid, int, text) from public, anon;
grant execute on function public.admin_refund_charge(uuid, int, text) to authenticated;

/* 제안자 셀프 응답 — 수락(소개 진행 동의) / 거절 */
create or replace function public.respond_to_interest(p_interest_id uuid, p_accept boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.partner_post_interests i
                 join public.partner_posts pp on pp.id = i.post_id
                 where i.id = p_interest_id and pp.created_by = auth.uid())
    then raise exception '내 제안에 달린 신청이 아닙니다'; end if;
  if p_accept then
    update public.partner_post_interests set owner_confirmed_at = now()
    where id = p_interest_id and status = 'pending';
  else
    update public.partner_post_interests set status = 'declined'
    where id = p_interest_id and status = 'pending';
  end if;
end $$;
revoke execute on function public.respond_to_interest(uuid, boolean) from public, anon;
grant execute on function public.respond_to_interest(uuid, boolean) to authenticated;

/* 소개 실행의 단일 지점 — 상태·동의 검증, 이중 실행 방지, 증빙·요금 스냅샷,
 * (connection 스위치 on일 때만) 과금: Pro 포함 크레딧 우선 차감, 아니면 청구 생성 */
create or replace function public.admin_introduce(p_kind text, p_interest_id uuid, p_evidence text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare tier text; bill jsonb; charging boolean; total int; v_amount int; v_vat int;
        v_user uuid; bal int; used_credit boolean := false; cid uuid;
begin
  if not public.is_admin() then raise exception '관리자 전용'; end if;
  if coalesce(trim(p_evidence), '') = '' then raise exception '발송 증빙(메모)이 필요합니다'; end if;
  select value into bill from public.app_settings where key = 'billing';
  charging := coalesce((bill->>'connection')::boolean, false);

  if p_kind = 'partner' then
    perform 1 from public.partner_post_interests i
      join public.partner_posts pp on pp.id = i.post_id
      where i.id = p_interest_id and pp.status in ('published', 'matched');
    if not found then raise exception '대상 제안이 게시 상태가 아닙니다'; end if;
    perform 1 from public.partner_post_interests
      where id = p_interest_id and contact_consent_at is not null and owner_confirmed_at is not null;
    if not found then raise exception '양측 동의(신청자 동의 + 제안자 확인)가 완료되지 않았습니다'; end if;
    perform 1 from public.partner_post_interests where id = p_interest_id and introduced_at is null;
    if not found then raise exception '이미 소개가 실행된 건입니다'; end if;
    select pt.fee_tier, i.user_id into tier, v_user
      from public.partner_post_interests i
      join public.partner_posts pp on pp.id = i.post_id
      join public.partner_types pt on pt.id = pp.type_id
      where i.id = p_interest_id;
    update public.partner_post_interests
      set status = 'introduced', introduced_at = now(), introduced_by = auth.uid(), introduced_evidence = p_evidence
      where id = p_interest_id;
    if charging and tier <> 'A' then
      total := case tier when 'B' then 22000 else 77000 end;
      if tier = 'B' then
        select coalesce(sum(delta), 0) into bal from public.credit_ledger
          where user_id = v_user and bucket = 'plan_included' and (expires_at is null or expires_at > now());
        if bal >= total then
          insert into public.credit_ledger (user_id, delta, reason, ref_id, bucket)
          values (v_user, -total, 'connection_fee', p_interest_id, 'plan_included');
          used_credit := true;
        end if;
      end if;
      if not used_credit then
        v_amount := round(total / 1.1)::int; v_vat := total - v_amount;
        insert into public.charges (kind, user_id, interest_kind, interest_id, fee_tier, amount, vat, status, deposit_deadline)
        values ('connection_fee', v_user, 'partner', p_interest_id, tier, v_amount, v_vat, 'awaiting_deposit',
                current_date + coalesce((bill->>'deposit_deadline_days')::int, 7))
        returning id into cid;
      end if;
    end if;
    return jsonb_build_object('fee_tier', tier, 'charged', cid is not null, 'credit_used', used_credit);

  elsif p_kind = 'deal' then
    perform 1 from public.deal_interests i join public.deals d on d.id = i.deal_id
      where i.id = p_interest_id and d.status <> 'closed';
    if not found then raise exception '대상 매물이 게시 상태가 아닙니다'; end if;
    perform 1 from public.deal_interests
      where id = p_interest_id and contact_consent_at is not null and owner_confirmed_at is not null and introduced_at is null;
    if not found then raise exception '동의·확인 미완이거나 이미 소개된 건입니다'; end if;
    update public.deal_interests
      set status = 'introduced', introduced_at = now(), introduced_by = auth.uid(), introduced_evidence = p_evidence
      where id = p_interest_id;
    return jsonb_build_object('fee_tier', null, 'charged', false, 'credit_used', false);
  end if;
  raise exception '알 수 없는 kind: %', p_kind;
end $$;
revoke execute on function public.admin_introduce(text, uuid, text) from public, anon;
grant execute on function public.admin_introduce(text, uuid, text) to authenticated;

/* close_my_post 재정의 — 마감 시 남은 pending 신청을 함께 정리(영구 '접수됨' 방치 방지) */
create or replace function public.close_my_post(p_post_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.partner_posts set status = 'closed'
  where id = p_post_id and created_by = auth.uid() and status in ('pending', 'published');
  if found then
    update public.partner_post_interests set status = 'declined'
    where post_id = p_post_id and status = 'pending';
  end if;
end $$;
