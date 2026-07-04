-- ============================================================
-- 세모플 0012 — 과금·매칭 QA 하드닝 (0001~0011 실행된 DB에 이어서 실행 · 멱등)
-- 종합 QA(적대적 교차 검증 확정 38건)의 서버측 수정 배치:
--   ① 구독 만료·갱신: place_order가 만료 임박(7일)부터 갱신 주문 허용, 입금 확인 시 기존 행 연장
--      (uq_subs_active 위반 원천 차단), pro_verified 배지에 주기 만료 검사 추가
--   ② 환불 부수효과: 구독 환불 → 구독 취소+포함 크레딧 소멸, 스폰서 환불 → 슬롯 회수
--   ③ 미입금 취소: admin_cancel_charge RPC + place_order가 본인 기한 경과 주문을 자동 취소
--   ④ 중복 주문 멱등: 동일 상품 입금 대기 건이 있으면 새 청구 대신 기존 건 반환(더블클릭 방어)
--   ⑤ admin_introduce·respond_to_interest 상태 가드: declined·마감 건 소개·과금 차단(stale 화면 방어)
--   ⑥ 크레딧 차감 행에 만료 스탬프 — 주기 넘어 잔액이 음수로 이월되던 정합성 버그 수정
--   ⑦ 입금 확인·환불 행 잠금(for update) — 동시 실행 레이스 차단
--   ⑧ 과금 기록 탈퇴 보존: user FK cascade→set null + 이메일 스냅샷(전자상거래법 거래기록 보존)
--   ⑨ 수신함 노출 필드(platform_name·size_text)까지 연락처 서버 차단 확장(0009 패턴과 동일 기준)
--   ⑩ 파운더 50% 할인 서버 적용(profiles.founder_discount_until — 관리자가 활동 이력 확인 후 수동 부여)
--   ⑪ 환불 큐 재설계: 도달 불가 조건(v_admin_refund_due)을 폐기하고 전체 청구 뷰(v_admin_charges)로 대체
-- 구현 노트: 0011과 동일하게 신규 enum 값은 뷰에서 ::text 비교, 함수는 전부 plpgsql.
-- ============================================================

-- ── 1) charges 확장 — 탈퇴 후에도 남는 이메일 스냅샷 + 주문 시 안내한 입금자명 규칙 ──
alter table public.charges
  add column if not exists user_email     text,   -- 청구 시점 스냅샷(탈퇴 시 거래기록 보존 — 전자상거래법 §6)
  add column if not exists depositor_hint text;   -- 주문 시 사용자에게 안내한 입금자명 규칙(대조 키)

-- ── 2) 과금·구독 기록의 탈퇴 보존 — cascade 파기(0005 §5)를 set null(익명화 보존)로 환원 ──
-- 0001 주석 기준 charges는 '세금계산서 근거' 테이블: 사용자 셀프 탈퇴로 세무·거래 기록이
-- 소멸하면 안 된다. 개인 식별자는 null로 끊고 행(금액·시각·상태)만 남긴다.
do $$ begin
  alter table public.charges alter column user_id drop not null;
  alter table public.charges drop constraint if exists charges_user_id_fkey;
  alter table public.charges add constraint charges_user_id_fkey
    foreign key (user_id) references public.profiles(id) on delete set null;
  alter table public.subscriptions alter column user_id drop not null;
  alter table public.subscriptions drop constraint if exists subscriptions_user_id_fkey;
  alter table public.subscriptions add constraint subscriptions_user_id_fkey
    foreign key (user_id) references public.profiles(id) on delete set null;
  alter table public.credit_ledger alter column user_id drop not null;
  alter table public.credit_ledger drop constraint if exists credit_ledger_user_id_fkey;
  alter table public.credit_ledger add constraint credit_ledger_user_id_fkey
    foreign key (user_id) references public.profiles(id) on delete set null;
  alter table public.sponsor_slots alter column sponsor_user_id drop not null;
  alter table public.sponsor_slots drop constraint if exists sponsor_slots_sponsor_user_id_fkey;
  alter table public.sponsor_slots add constraint sponsor_slots_sponsor_user_id_fkey
    foreign key (sponsor_user_id) references public.profiles(id) on delete set null;
end $$;

-- ── 3) 연락처 서버 차단을 수신함 노출 필드까지 확장 ─────────────
-- 0011의 v_my_post_interests가 제안자에게 platform_name·size_text를 새로 노출하는데
-- 기존 check(0009)는 pitch만 검사했다. 패턴은 0009와 동일(클라이언트 anonymity.ts와 동기).
alter table public.partner_post_interests drop constraint if exists chk_ppint_nocontact;
alter table public.partner_post_interests add constraint chk_ppint_nocontact
  check ( (coalesce(pitch,'') || ' ' || coalesce(platform_name,'') || ' ' || coalesce(size_text,''))
    !~* '(@|https?://|www\.|0\d{1,2}[-. ]?\d{3,4}[-. ]?\d{4}|공일공|카카오톡|카톡|kakao|텔레그램|텔레그람|telegram|인스타|\yinsta(gram)?\y|디스코드|discord|(^|[^가-힣])라인\s?아이디|\yline[ -]?id\y|위챗|wechat|지메일)' ) not valid;

-- ── 4) 파운더 할인 부여 컬럼 — 관리자가 활동 이력 확인 후 수동 부여(자동 판정은 차기) ──
-- 부여: update profiles set founder_discount_until = current_date + interval '12 months' where id = '<uuid>';
alter table public.profiles add column if not exists founder_discount_until date;

-- ── 5) pro_verified 배지에 주기 만료 검사 — 만료된 구독의 배지 영구 표시 수정 ──
create or replace view public.v_partner_posts_public
  with (security_invoker = false) as
select pp.id, pp.title, pp.category_id, pp.type_id, pp.give_text, pp.get_text,
       pp.want_categories, pp.size_text, pp.detail, pp.status, pp.published_at::date as posted,
       exists (select 1 from public.subscriptions sb
               where sb.user_id = pp.created_by and sb.plan_id = 'pro'
                 and sb.status::text = 'active'
                 and coalesce(sb.current_period_end, now()) > now()) as pro_verified
from public.partner_posts pp where pp.status in ('published', 'matched');

-- ── 6) 환불 큐 재설계 — v_admin_refund_due는 도달 불가 조건(후불 구조에서 'paid인데 미소개'는
-- 존재할 수 없음)이라 폐기. 전 상태 청구 뷰로 대체: 입금 대기 큐·환불·슬롯 배정이 전부 여기서 나온다.
drop view if exists public.v_admin_refund_due;
drop view if exists public.v_admin_billing_queue;
drop view if exists public.v_admin_charges;
create view public.v_admin_charges
  with (security_invoker = false) as
select c.id, c.kind::text as kind, c.status::text as status, c.amount, c.vat, c.fee_tier,
       c.memo, c.depositor_name, c.depositor_hint, c.deposit_deadline, c.discount_rate,
       c.refund_amount, c.refund_reason, c.created_at, c.paid_at, c.refunded_at,
       c.user_id, coalesce(au.email, c.user_email) as user_email,
       exists (select 1 from public.sponsor_slots s where s.charge_id = c.id) as has_slot
from public.charges c
left join auth.users au on au.id = c.user_id
where public.is_admin();

-- ── 7) place_order 재정의 — 반환을 jsonb(id·총액·재사용 여부)로 확장(안내 금액의 단일 소스는 서버),
-- 중복 주문 멱등, 기한 경과 자동 취소, 갱신 창(만료 7일 전) 허용, 파운더 할인, 스냅샷 기록 ──
drop function if exists public.place_order(text, text, uuid);
drop function if exists public.place_order(text, text, uuid, text);
create function public.place_order(p_kind text, p_plan_id text default null, p_post_id uuid default null, p_depositor_hint text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare bill jsonb; total int; v_amount int; v_vat int; cid uuid; deadline_days int;
        v_email text; v_disc numeric; v_until date; existing record;
begin
  if auth.uid() is null then raise exception '로그인이 필요합니다'; end if;
  select value into bill from public.app_settings where key = 'billing';
  deadline_days := coalesce((bill->>'deposit_deadline_days')::int, 7);
  -- 기한이 지난 내 입금 대기 "주문"(boost·subscription)은 여기서 자동 취소('기한 경과 시 취소' 고지의 이행).
  -- connection_fee는 소개 이행 후의 채권이라 자동 취소하지 않는다(운영자 판단 — admin_cancel_charge).
  update public.charges set status = 'canceled', refund_reason = '기한 내 미입금 — 자동 취소'
    where user_id = auth.uid() and status::text = 'awaiting_deposit'
      and kind::text in ('boost', 'subscription') and deposit_deadline < current_date;
  if p_kind = 'boost' then
    if not coalesce((bill->>'sponsor')::boolean, false) then raise exception '스폰서 상품은 아직 오픈 전입니다'; end if;
    if not exists (select 1 from public.partner_posts
                   where id = p_post_id and created_by = auth.uid() and status = 'published')
      then raise exception '게시 중인 본인 제안에만 신청할 수 있어요'; end if;
    total := 99000;
  elsif p_kind = 'subscription' then
    if not coalesce((bill->>'membership')::boolean, false) then raise exception '멤버십은 아직 오픈 전입니다'; end if;
    if p_plan_id is distinct from 'pro' then raise exception '신청 가능한 플랜이 아닙니다'; end if;
    -- 만료 7일 전부터는 갱신 주문 허용(만료 후 재주문 영구 차단 버그 수정)
    if exists (select 1 from public.subscriptions
               where user_id = auth.uid() and status in ('active', 'past_due')
                 and coalesce(current_period_end, now() + interval '100 years') > now() + interval '7 days')
      then raise exception '이미 이용 중인 구독이 있습니다 — 만료 7일 전부터 갱신 주문이 가능해요'; end if;
    select monthly_price into total from public.plans where id = p_plan_id;
  else
    raise exception '알 수 없는 상품: %', p_kind;
  end if;
  -- 동일 상품이 이미 입금 대기 중이면 새 청구 대신 기존 건 반환(더블클릭·재주문 멱등)
  select id, amount, vat into existing from public.charges
    where user_id = auth.uid() and kind::text = p_kind and status::text = 'awaiting_deposit'
      and (p_kind <> 'boost' or memo = 'post:' || p_post_id)
    order by created_at desc limit 1;
  if existing.id is not null then
    return jsonb_build_object('id', existing.id, 'total', existing.amount + existing.vat, 'reused', true);
  end if;
  -- 파운더 할인(첫 12개월 50% — 부여 여부는 관리자가 활동 이력 확인 후 수동 기록)
  select founder_discount_until into v_until from public.profiles where id = auth.uid();
  if v_until is not null and v_until >= current_date then
    total := (total * 0.5)::int; v_disc := 0.5;
  end if;
  v_amount := round(total / 1.1)::int;  -- VAT 포함가 → 공급가 역산
  v_vat := total - v_amount;
  select email into v_email from auth.users where id = auth.uid();
  insert into public.charges (kind, user_id, user_email, amount, vat, status, deposit_deadline,
                              discount_rate, discount_reason, depositor_hint, memo)
  values (p_kind::charge_kind_t, auth.uid(), v_email, v_amount, v_vat, 'awaiting_deposit',
          current_date + deadline_days,
          v_disc, case when v_disc is not null then 'founder' end, nullif(trim(p_depositor_hint), ''),
          case when p_kind = 'boost' then 'post:' || p_post_id else 'plan:' || p_plan_id end)
  returning id into cid;
  return jsonb_build_object('id', cid, 'total', v_amount + v_vat, 'reused', false);
end $$;
revoke execute on function public.place_order(text, text, uuid, text) from public, anon;
grant execute on function public.place_order(text, text, uuid, text) to authenticated;

-- ── 8) admin_cancel_charge — 미입금·착오 주문의 수동 취소(입금 대기 상태만) ──
create or replace function public.admin_cancel_charge(p_charge_id uuid, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception '관리자 전용'; end if;
  update public.charges set status = 'canceled',
    refund_reason = coalesce(nullif(trim(p_reason), ''), '미입금 취소')
    where id = p_charge_id and status::text = 'awaiting_deposit';
  if not found then raise exception '입금 대기 상태의 청구가 아닙니다'; end if;
end $$;
revoke execute on function public.admin_cancel_charge(uuid, text) from public, anon;
grant execute on function public.admin_cancel_charge(uuid, text) to authenticated;

-- ── 9) admin_confirm_deposit 재정의 — 행 잠금(동시 확인 레이스) + 구독 갱신 분기
-- (기존 행 연장으로 uq_subs_active 위반 차단) + 포함 크레딧은 새 주기말로 만료 ──
create or replace function public.admin_confirm_deposit(p_charge_id uuid, p_depositor text)
returns void language plpgsql security definer set search_path = public as $$
declare c record; sid uuid; prev_end timestamptz; new_start timestamptz; new_end timestamptz;
begin
  if not public.is_admin() then raise exception '관리자 전용'; end if;
  select * into c from public.charges where id = p_charge_id for update;
  if c is null then raise exception '청구를 찾을 수 없습니다'; end if;
  if c.status::text <> 'awaiting_deposit' then raise exception '입금 대기 상태가 아닙니다(%)', c.status; end if;
  update public.charges set status = 'paid', paid_at = now(),
    depositor_name = p_depositor, confirmed_by = auth.uid() where id = p_charge_id;
  if c.kind = 'subscription' then
    -- 갱신: 기존 행이 있으면 연장(잔여 기간이 있으면 그 끝에서 이어붙임), 없으면 신규
    select id, current_period_end into sid, prev_end from public.subscriptions
      where user_id = c.user_id order by started_at desc limit 1 for update;
    new_start := case when prev_end is not null and prev_end > now() then prev_end else now() end;
    new_end := new_start + interval '1 month';
    if sid is not null then
      update public.subscriptions set plan_id = 'pro', status = 'active',
        current_period_start = new_start, current_period_end = new_end,
        price_snapshot = c.amount + c.vat, activated_at = coalesce(activated_at, now())
      where id = sid;
    else
      insert into public.subscriptions (user_id, plan_id, status, current_period_start, current_period_end, price_snapshot, activated_at)
      values (c.user_id, 'pro', 'active', new_start, new_end, c.amount + c.vat, now());
    end if;
    -- B형 3건 포함분(66,000 상당) — 주기말 소멸 버킷
    insert into public.credit_ledger (user_id, delta, reason, ref_id, bucket, expires_at)
    values (c.user_id, 66000, 'free_monthly', p_charge_id, 'plan_included', new_end);
  end if;
end $$;
revoke execute on function public.admin_confirm_deposit(uuid, text) from public, anon;
grant execute on function public.admin_confirm_deposit(uuid, text) to authenticated;

-- ── 10) admin_refund_charge 재정의 — 행 잠금 + 부수효과 회수:
-- 구독 환불 → 구독 취소+미사용 포함 크레딧 즉시 소멸, 스폰서 환불 → 슬롯 회수 ──
create or replace function public.admin_refund_charge(p_charge_id uuid, p_amount int, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare c record;
begin
  if not public.is_admin() then raise exception '관리자 전용'; end if;
  select * into c from public.charges where id = p_charge_id for update;
  if c is null or c.status <> 'paid' then raise exception 'paid 상태의 청구만 환불할 수 있습니다'; end if;
  if p_amount < 0 or p_amount > c.amount + c.vat then raise exception '환불 금액이 결제액을 초과합니다'; end if;
  update public.charges set status = 'refunded', refund_amount = p_amount,
    refunded_at = now(), refund_reason = p_reason where id = p_charge_id;
  if c.kind = 'subscription' then
    update public.subscriptions set status = 'canceled', current_period_end = now()
      where user_id = c.user_id and status in ('active', 'past_due');
    update public.credit_ledger set expires_at = now()
      where user_id = c.user_id and bucket = 'plan_included' and (expires_at is null or expires_at > now());
  elsif c.kind = 'boost' then
    delete from public.sponsor_slots where charge_id = p_charge_id and starts_on >= current_date;
    update public.sponsor_slots set ends_on = current_date - 1
      where charge_id = p_charge_id and starts_on < current_date and ends_on >= current_date;
  end if;
end $$;
revoke execute on function public.admin_refund_charge(uuid, int, text) from public, anon;
grant execute on function public.admin_refund_charge(uuid, int, text) to authenticated;

-- ── 11) respond_to_interest 재정의 — 이미 처리된 건은 조용한 no-op 대신 명시 오류 ──
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
  if not found then raise exception '이미 처리된 신청입니다(거절·마감·소개 완료)'; end if;
end $$;
revoke execute on function public.respond_to_interest(uuid, boolean) from public, anon;
grant execute on function public.respond_to_interest(uuid, boolean) to authenticated;

-- ── 12) admin_introduce 재정의 — pending 상태 가드(stale 화면에서 declined 건 소개·과금 차단)
-- + 크레딧 차감 행에 만료 스탬프(주기 넘는 음수 이월 수정) + 파운더 할인 적용 ──
create or replace function public.admin_introduce(p_kind text, p_interest_id uuid, p_evidence text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare tier text; bill jsonb; charging boolean; total int; v_amount int; v_vat int;
        v_user uuid; v_email text; bal int; used_credit boolean := false; cid uuid;
        v_exp timestamptz; v_until date; v_disc numeric;
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
      total := case tier when 'B' then 22000 else 77000 end;
      select founder_discount_until into v_until from public.profiles where id = v_user;
      if v_until is not null and v_until >= current_date then
        total := (total * 0.5)::int; v_disc := 0.5;
      end if;
      if tier = 'B' then
        select coalesce(sum(delta), 0), max(expires_at) filter (where delta > 0) into bal, v_exp
          from public.credit_ledger
          where user_id = v_user and bucket = 'plan_included' and (expires_at is null or expires_at > now());
        if bal >= total then
          -- 차감도 해당 적립분과 같은 시점에 만료 — 주기 넘어 음수 이월 방지
          insert into public.credit_ledger (user_id, delta, reason, ref_id, bucket, expires_at)
          values (v_user, -total, 'connection_fee', p_interest_id, 'plan_included', v_exp);
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
revoke execute on function public.admin_introduce(text, uuid, text) from public, anon;
grant execute on function public.admin_introduce(text, uuid, text) to authenticated;
