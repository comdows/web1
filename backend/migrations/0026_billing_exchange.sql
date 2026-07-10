-- ============================================================
-- 세모플 0026 — 수익화 v2: 거래소 과금 + 크레딧 충전 + 구독 수명주기 (M-2)
-- (0001~0025 실행된 DB에 이어 실행 · 멱등)
--
-- ⚠️ 이 마이그레이션은 아무것도 켜지 않는다 — 스위치(listing·buyer_membership)는 기본 false로
-- 시드되고, 기존 상품 동작은 무변경. "게이트 충족 후 스위치만 켜면 매출이 되는 상태"를 만드는 것.
--   ① 매물 리스팅료(90일)·연장·인수자 멤버십·크레딧 충전을 place_order가 처리
--   ② 가격 단일화: app_settings 'prices'에서 조회(없으면 기존 하드코딩 값 fallback — 무중단)
--   ③ 구독을 플랜별 공존 가능하게(uq_subs_active를 user+plan 스코프로) + 만료 임박 뷰(알림 잡용)
--   ④ 인수자 48시간 선공개: buyer_early 스위치 on일 때만 v_deals_public이 신규 매물을
--      buyer 구독자·admin에게만 노출(off면 현재와 완전 동일)
-- 원칙 유지: 성공보수·거래액 연동 없음(전부 정액), 디렉토리 무료, 자금 미보유(이용료만).
-- ============================================================

-- ── 0) 청구 종류에 크레딧 충전 추가 ──
-- (새 enum 값은 이 마이그레이션 안의 DML에서 사용하지 않는다 — 같은 트랜잭션 사용 제한 회피.
--  함수 본문 내 캐스팅은 실행 시점 평가라 안전.)
alter type public.charge_kind_t add value if not exists 'credit_topup';

-- ── 1) 스위치·가격 시드 (기본 off / 기존 키 보존) ──
update public.app_settings
  set value = value
    || jsonb_build_object('listing', coalesce(value->'listing', 'false'::jsonb))
    || jsonb_build_object('buyer_membership', coalesce(value->'buyer_membership', 'false'::jsonb))
    || jsonb_build_object('buyer_early', coalesce(value->'buyer_early', 'false'::jsonb))
  where key = 'billing';
insert into public.app_settings (key, value) values ('prices', '{
  "boost": 99000, "conn_B": 22000, "conn_C": 77000,
  "listing": 220000, "listing_ext": 110000,
  "credit_50_pay": 50000, "credit_50_get": 55000,
  "credit_100_pay": 100000, "credit_100_get": 115000
}') on conflict (key) do nothing;

-- ── 2) 플랜: buyer(인수자 멤버십) 시드 + 구독 플랜별 공존 ──
insert into public.plans (id, label, monthly_price, descr, active, sort)
values ('buyer', '인수자 멤버십', 55000, '신규 매물 48시간 선공개 + 인수 브리프 무제한', false, 30)
on conflict (id) do nothing;
update public.plans set monthly_price = 55000 where id = 'buyer' and monthly_price <> 55000;
-- 사용자당 활성 구독 1개(플랜 무관) → 플랜별 1개(Pro와 인수자 멤버십 공존 허용)
drop index if exists uq_subs_active;
create unique index if not exists uq_subs_active_plan on public.subscriptions(user_id, plan_id)
  where status in ('active', 'past_due');

-- ── 3) 매물 게재 기간 실체화 — listed_until(null=기간 미적용·무료 베타) ──
alter table public.deals add column if not exists listed_until date;
alter table public.deal_submissions add column if not exists paid_at timestamptz; -- 리스팅료 입금 확인 스탬프

-- ── 4) place_order 재정의 — listing / listing_extend / credit / buyer 구독 + 가격을 prices에서 ──
drop function if exists public.place_order(text, text, uuid, text);
drop function if exists public.place_order(text, text, uuid, text, text);
create function public.place_order(p_kind text, p_plan_id text default null, p_post_id uuid default null,
                                   p_depositor_hint text default null, p_ref text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare bill jsonb; prices jsonb; total int; v_amount int; v_vat int; cid uuid; deadline_days int;
        v_email text; v_disc numeric; v_until date; existing record; v_kind text; v_memo text; v_deal text;
begin
  if auth.uid() is null then raise exception '로그인이 필요합니다'; end if;
  select value into bill from public.app_settings where key = 'billing';
  select value into prices from public.app_settings where key = 'prices';
  deadline_days := coalesce((bill->>'deposit_deadline_days')::int, 7);
  update public.charges set status = 'canceled', refund_reason = '기한 내 미입금 — 자동 취소'
    where user_id = auth.uid() and status::text = 'awaiting_deposit'
      and kind::text in ('boost', 'subscription', 'listing_fee') and deposit_deadline < current_date;

  v_kind := p_kind; v_memo := null; v_deal := null;
  if p_kind = 'boost' then
    if not coalesce((bill->>'sponsor')::boolean, false) then raise exception '스폰서 상품은 아직 오픈 전입니다'; end if;
    if not exists (select 1 from public.partner_posts
                   where id = p_post_id and created_by = auth.uid() and status = 'published')
      then raise exception '게시 중인 본인 제안에만 신청할 수 있어요'; end if;
    total := coalesce((prices->>'boost')::int, 99000);
    v_memo := 'post:' || p_post_id;

  elsif p_kind = 'subscription' then
    if p_plan_id not in ('pro', 'buyer') then raise exception '신청 가능한 플랜이 아닙니다'; end if;
    if p_plan_id = 'pro' and not coalesce((bill->>'membership')::boolean, false)
      then raise exception '멤버십은 아직 오픈 전입니다'; end if;
    if p_plan_id = 'buyer' and not coalesce((bill->>'buyer_membership')::boolean, false)
      then raise exception '인수자 멤버십은 아직 오픈 전입니다'; end if;
    -- 같은 플랜의 활성 구독만 갱신 차단(만료 7일 전부터 갱신 허용) — 다른 플랜과는 공존
    if exists (select 1 from public.subscriptions
               where user_id = auth.uid() and plan_id = p_plan_id and status in ('active', 'past_due')
                 and coalesce(current_period_end, now() + interval '100 years') > now() + interval '7 days')
      then raise exception '이미 이용 중인 구독이 있습니다 — 만료 7일 전부터 갱신 주문이 가능해요'; end if;
    select monthly_price into total from public.plans where id = p_plan_id;
    v_memo := 'plan:' || p_plan_id;

  elsif p_kind = 'listing' then
    if not coalesce((bill->>'listing')::boolean, false) then raise exception '매물 리스팅은 현재 무료 베타입니다'; end if;
    if not exists (select 1 from public.deal_submissions
                   where id = p_post_id and submitter_id = auth.uid() and status in ('pending', 'hold'))
      then raise exception '검수 대기 중인 본인 매각 접수에만 결제할 수 있어요'; end if;
    total := coalesce((prices->>'listing')::int, 220000);
    v_kind := 'listing_fee'; v_memo := 'dealsub:' || p_post_id;

  elsif p_kind = 'listing_extend' then
    if not coalesce((bill->>'listing')::boolean, false) then raise exception '매물 리스팅은 현재 무료 베타입니다'; end if;
    if not exists (select 1 from public.deals
                   where id = p_ref and owner_id = auth.uid() and status <> 'closed')
      then raise exception '게시 중인 본인 매물만 연장할 수 있어요'; end if;
    total := coalesce((prices->>'listing_ext')::int, 110000);
    v_kind := 'listing_fee'; v_memo := 'extend:' || p_ref; v_deal := p_ref;

  elsif p_kind = 'credit' then
    -- 크레딧은 연결료 지갑 — connection 스위치를 따른다
    if not coalesce((bill->>'connection')::boolean, false) then raise exception '연결료·크레딧은 아직 오픈 전입니다'; end if;
    if p_ref not in ('50', '100') then raise exception '충전 패키지는 50 또는 100입니다'; end if;
    total := coalesce((prices->>('credit_' || p_ref || '_pay'))::int, (p_ref)::int * 1000);
    v_kind := 'credit_topup'; v_memo := 'credit:' || p_ref;

  else
    raise exception '알 수 없는 상품: %', p_kind;
  end if;

  -- 동일 상품 입금 대기 건 재사용(더블클릭·재주문 멱등)
  select id, amount, vat into existing from public.charges
    where user_id = auth.uid() and kind::text = v_kind and status::text = 'awaiting_deposit'
      and (v_memo is null or memo = v_memo)
    order by created_at desc limit 1;
  if existing.id is not null then
    return jsonb_build_object('id', existing.id, 'total', existing.amount + existing.vat, 'reused', true);
  end if;

  -- 파운더 할인(크레딧 충전 제외 — 적립 보너스와 중복 방지)
  if p_kind <> 'credit' then
    select founder_discount_until into v_until from public.profiles where id = auth.uid();
    if v_until is not null and v_until >= current_date then
      total := (total * 0.5)::int; v_disc := 0.5;
    end if;
  end if;

  v_amount := round(total / 1.1)::int;
  v_vat := total - v_amount;
  select email into v_email from auth.users where id = auth.uid();
  insert into public.charges (kind, user_id, user_email, amount, vat, status, deposit_deadline,
                              discount_rate, discount_reason, depositor_hint, memo, deal_id)
  values (v_kind::charge_kind_t, auth.uid(), v_email, v_amount, v_vat, 'awaiting_deposit',
          current_date + deadline_days,
          v_disc, case when v_disc is not null then 'founder' end, nullif(trim(p_depositor_hint), ''),
          v_memo, v_deal)
  returning id into cid;
  return jsonb_build_object('id', cid, 'total', v_amount + v_vat, 'reused', false);
end $$;
revoke execute on function public.place_order(text, text, uuid, text, text) from public, anon;
grant execute on function public.place_order(text, text, uuid, text, text) to authenticated;

-- ── 5) admin_confirm_deposit 재정의 — 구독 플랜 분기(pro/buyer) + 리스팅·크레딧 입금 처리 ──
create or replace function public.admin_confirm_deposit(p_charge_id uuid, p_depositor text)
returns void language plpgsql security definer set search_path = public as $$
declare c record; sid uuid; prev_end timestamptz; new_start timestamptz; new_end timestamptz;
        v_plan text; prices jsonb; v_get int; v_pkg text; v_sub uuid; v_deal text;
begin
  if not public.is_admin() then raise exception '관리자 전용'; end if;
  select * into c from public.charges where id = p_charge_id for update;
  if c is null then raise exception '청구를 찾을 수 없습니다'; end if;
  if c.status::text <> 'awaiting_deposit' then raise exception '입금 대기 상태가 아닙니다(%)', c.status; end if;
  update public.charges set status = 'paid', paid_at = now(),
    depositor_name = p_depositor, confirmed_by = auth.uid() where id = p_charge_id;

  if c.kind = 'subscription' then
    v_plan := coalesce(nullif(split_part(coalesce(c.memo, ''), ':', 2), ''), 'pro');
    select id, current_period_end into sid, prev_end from public.subscriptions
      where user_id = c.user_id and plan_id = v_plan order by started_at desc limit 1 for update;
    new_start := case when prev_end is not null and prev_end > now() then prev_end else now() end;
    new_end := new_start + interval '1 month';
    if sid is not null then
      update public.subscriptions set status = 'active',
        current_period_start = new_start, current_period_end = new_end,
        price_snapshot = c.amount + c.vat, activated_at = coalesce(activated_at, now())
      where id = sid;
    else
      insert into public.subscriptions (user_id, plan_id, status, current_period_start, current_period_end, price_snapshot, activated_at)
      values (c.user_id, v_plan, 'active', new_start, new_end, c.amount + c.vat, now());
    end if;
    -- Pro만 B형 소개 3건 포함분(66,000 상당) 적립 — buyer는 포함 크레딧 없음
    if v_plan = 'pro' then
      insert into public.credit_ledger (user_id, delta, reason, ref_id, bucket, expires_at)
      values (c.user_id, 66000, 'free_monthly', p_charge_id, 'plan_included', new_end);
    end if;

  elsif c.kind::text = 'listing_fee' then
    if c.memo like 'dealsub:%' then
      -- 신규 리스팅: 접수 건에 결제 스탬프(검수는 기존 큐 그대로 — 반려 시 admin_refund_charge로 전액 환불)
      update public.deal_submissions set paid_at = now()
        where id = nullif(split_part(c.memo, ':', 2), '')::uuid;
    elsif c.memo like 'extend:%' then
      -- 연장: 게재 만료일 +90일(기간 미적용 매물이면 오늘 기준 +90일)
      v_deal := split_part(c.memo, ':', 2);
      update public.deals set listed_until = greatest(coalesce(listed_until, current_date), current_date) + 90
        where id = v_deal;
    end if;

  elsif c.kind::text = 'credit_topup' then
    v_pkg := split_part(coalesce(c.memo, ''), ':', 2);
    select value into prices from public.app_settings where key = 'prices';
    v_get := coalesce((prices->>('credit_' || v_pkg || '_get'))::int, c.amount + c.vat);
    insert into public.credit_ledger (user_id, delta, reason, ref_id, bucket, expires_at)
    values (c.user_id, v_get, 'topup', p_charge_id, 'paid', now() + interval '5 years'); -- 유효기간 5년(pricing-policy §4)
  end if;
end $$;

-- ── 6) admin_introduce의 연결료 가격을 prices에서 (fallback 유지) ──
-- 함수 전체 재정의 대신 가격 산정만 바뀌므로 0012 본문을 그대로 두고, 값을 바꾸려면
-- app_settings 'prices'의 conn_B/conn_C를 수정한다. (0012의 하드코딩 22000/77000은
-- prices 키 부재 시의 fallback으로만 남음 — 아래 재정의로 대체)
create or replace function public.admin_introduce(p_kind text, p_interest_id uuid, p_evidence text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare tier text; bill jsonb; prices jsonb; charging boolean; total int; v_amount int; v_vat int;
        v_user uuid; v_email text; bal int; used_credit boolean := false; cid uuid;
        v_exp timestamptz; v_until date; v_disc numeric;
begin
  if not public.is_admin() then raise exception '관리자 전용'; end if;
  if coalesce(trim(p_evidence), '') = '' then raise exception '발송 증빙(메모)이 필요합니다'; end if;
  select value into bill from public.app_settings where key = 'billing';
  select value into prices from public.app_settings where key = 'prices';
  charging := coalesce((bill->>'connection')::boolean, false);

  if p_kind = 'partner' then
    perform 1 from public.partner_post_interests i
      join public.partner_posts pp on pp.id = i.post_id
      where i.id = p_interest_id and pp.status in ('published', 'matched');
    if not found then raise exception '대상 제안이 게시 상태가 아닙니다'; end if;
    perform 1 from public.partner_post_interests where id = p_interest_id and status = 'pending';
    if not found then raise exception '진행 가능한 상태가 아닙니다(이미 거절·마감·소개된 신청)'; end if;
    perform 1 from public.partner_post_interests
      where id = p_interest_id and contact_consent_at is not null and owner_confirmed_at is not null;
    if not found then raise exception '양측 동의(신청자 동의 + 제안자 확인)가 완료되지 않았습니다'; end if;
    select pt.fee_tier, i.user_id into tier, v_user
      from public.partner_post_interests i
      join public.partner_posts pp on pp.id = i.post_id
      join public.partner_types pt on pt.id = pp.type_id
      where i.id = p_interest_id;
    update public.partner_post_interests
      set status = 'introduced', introduced_at = now(), introduced_by = auth.uid(), introduced_evidence = p_evidence
      where id = p_interest_id and status = 'pending';
    if not found then raise exception '동시에 다른 처리가 실행됐어요 — 새로고침 후 확인해 주세요'; end if;
    if charging and tier <> 'A' then
      total := case tier when 'B' then coalesce((prices->>'conn_B')::int, 22000)
                         else coalesce((prices->>'conn_C')::int, 77000) end;
      select founder_discount_until into v_until from public.profiles where id = v_user;
      if v_until is not null and v_until >= current_date then
        total := (total * 0.5)::int; v_disc := 0.5;
      end if;
      if tier = 'B' then
        -- 선불(paid·bonus) → Pro 포함분(plan_included) 순으로 잔액 판단(전 버킷 합)
        select coalesce(sum(delta), 0), max(expires_at) filter (where delta > 0) into bal, v_exp
          from public.credit_ledger
          where user_id = v_user and (expires_at is null or expires_at > now());
        if bal >= total then
          insert into public.credit_ledger (user_id, delta, reason, ref_id, bucket, expires_at)
          values (v_user, -total, 'connection_fee', p_interest_id, 'paid', v_exp);
          used_credit := true;
        end if;
      end if;
      if not used_credit then
        v_amount := round(total / 1.1)::int; v_vat := total - v_amount;
        select email into v_email from auth.users where id = v_user;
        insert into public.charges (kind, user_id, user_email, interest_kind, interest_id, fee_tier,
                                    amount, vat, status, deposit_deadline, discount_rate, discount_reason)
        values ('connection_fee', v_user, v_email, 'partner', p_interest_id, tier, v_amount, v_vat, 'awaiting_deposit',
                current_date + coalesce((bill->>'deposit_deadline_days')::int, 7),
                v_disc, case when v_disc is not null then 'founder' end)
        returning id into cid;
      end if;
    end if;
    return jsonb_build_object('fee_tier', tier, 'charged', cid is not null, 'credit_used', used_credit);

  elsif p_kind = 'deal' then
    perform 1 from public.deal_interests i join public.deals d on d.id = i.deal_id
      where i.id = p_interest_id and d.status <> 'closed';
    if not found then raise exception '대상 매물이 게시 상태가 아닙니다'; end if;
    perform 1 from public.deal_interests
      where id = p_interest_id and status = 'pending'
        and contact_consent_at is not null and owner_confirmed_at is not null and introduced_at is null;
    if not found then raise exception '동의·확인 미완이거나 이미 처리(거절·소개)된 건입니다'; end if;
    update public.deal_interests
      set status = 'introduced', introduced_at = now(), introduced_by = auth.uid(), introduced_evidence = p_evidence
      where id = p_interest_id and status = 'pending';
    if not found then raise exception '동시에 다른 처리가 실행됐어요 — 새로고침 후 확인해 주세요'; end if;
    return jsonb_build_object('fee_tier', null, 'charged', false, 'credit_used', false);
  end if;
  raise exception '알 수 없는 kind: %', p_kind;
end $$;

-- ── 7) v_deals_public 재정의 — 게재 기간 + 인수자 48h 선공개(스위치 off면 기존과 동일) ──
create or replace view public.v_deals_public
  with (security_invoker = false) as
  select id, category_id, region, revenue_band, mode, summary, highlights, sale_reason,
         status, is_demo, posted, owner_verified, proofs
  from public.deals d
  where status <> 'closed'
    and (listed_until is null or listed_until >= current_date)
    and ( is_demo
      or d.created_at <= now() - interval '48 hours'
      or not coalesce((select (value->>'buyer_early')::boolean from public.app_settings where key = 'billing'), false)
      or public.is_admin()
      or exists (select 1 from public.subscriptions sb
                 where sb.user_id = auth.uid() and sb.plan_id = 'buyer'
                   and sb.status::text = 'active' and coalesce(sb.current_period_end, now()) > now()) );

-- ── 8) 만료 임박 구독 뷰 — 알림 잡(admin 봇)·콘솔용 ──
create or replace view public.v_expiring_subs
  with (security_invoker = false) as
  select s.user_id, s.plan_id, s.current_period_end
  from public.subscriptions s
  where s.status::text = 'active'
    and s.current_period_end between now() and now() + interval '7 days'
    and public.is_admin();
grant select on public.v_expiring_subs to authenticated;
