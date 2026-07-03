-- ============================================================
-- 세모플 0005 — 소개 이행 + 동의 기록 + 탈퇴 대비 + 데이터 정정
-- (0001~0004 실행된 DB에 이어서 실행 · 멱등: 재실행 무해)
-- 목적:
--  1) 관리자 소개 큐에 양측 이메일 제공(관리자에게만 — is_admin 가드 뷰)
--  2) 소개 = 이메일 제3자 제공 → 신청 시 개별 동의를 기록할 컬럼
--  3) 소개 이행 시각·주체 기록(향후 '미이행 환불' 판정 근거)
--  4) 게시 우회 3개 경로(pitch·intro·note)에 연락처 패턴 서버 방어
--  5) 회원 탈퇴(profiles 삭제)가 FK에 막히지 않도록 on delete 정리
--  6) 라이브 데이터 정정(URL 2건 · '글로벌' 지역 18건)
-- ============================================================

-- ── 1) 동의·이행 컬럼 ────────────────────────────────────────
alter table public.partner_post_interests
  add column if not exists contact_consent_at timestamptz,
  add column if not exists introduced_at      timestamptz,
  add column if not exists introduced_by      uuid references public.profiles(id) on delete set null;
alter table public.deal_interests
  add column if not exists contact_consent_at timestamptz,
  add column if not exists introduced_at      timestamptz,
  add column if not exists introduced_by      uuid references public.profiles(id) on delete set null;

-- ── 2) 관리자 소개 큐 뷰 — 양측 이메일 포함, is_admin()만 행 반환 ──
-- (뷰는 소유자 권한으로 auth.users를 읽되, where is_admin()이 비관리자에겐 0행)
create or replace view public.v_admin_intro_queue
  with (security_invoker = false) as
select 'partner'::text     as kind,
       i.id, i.created_at, i.status,
       i.pitch             as message,
       i.platform_name,
       coalesce(pp.title, '') as target_title,
       au1.email           as applicant_email,
       au2.email           as counterpart_email,
       i.contact_consent_at
from public.partner_post_interests i
join public.partner_posts pp on pp.id = i.post_id
left join auth.users au1 on au1.id = i.user_id
left join auth.users au2 on au2.id = pp.created_by
where public.is_admin()
union all
select 'deal', i.id, i.created_at, i.status,
       i.intro, '', i.deal_id,
       au1.email, au2.email, i.contact_consent_at
from public.deal_interests i
join public.deals d on d.id = i.deal_id
left join auth.users au1 on au1.id = i.user_id
left join auth.users au2 on au2.id = d.owner_id
where public.is_admin();

-- ── 3) buyer_briefs 관리자 처리 정책(비활성 처리에 필요 — 0002엔 select만) ──
drop policy if exists "admin manage briefs" on public.buyer_briefs;
create policy "admin manage briefs" on public.buyer_briefs for update
  using (public.is_admin()) with check (public.is_admin());

-- ── 4) 연락처 패턴 서버 방어(검수를 안 거치는 3개 자유입력 경로) ──
-- NOT VALID: 기존 행은 건드리지 않고 신규 입력만 검사
alter table public.partner_post_interests drop constraint if exists chk_ppint_nocontact;
alter table public.partner_post_interests add constraint chk_ppint_nocontact
  check ( pitch !~* '(@|https?://|www\.|010[- ]?[0-9]{3,4}[- ]?[0-9]{4}|카카오톡|카톡|kakao|텔레그램|telegram)' ) not valid;
alter table public.deal_interests drop constraint if exists chk_dint_nocontact;
alter table public.deal_interests add constraint chk_dint_nocontact
  check ( intro !~* '(@|https?://|www\.|010[- ]?[0-9]{3,4}[- ]?[0-9]{4}|카카오톡|카톡|kakao|텔레그램|telegram)' ) not valid;
alter table public.buyer_briefs drop constraint if exists chk_brief_nocontact;
alter table public.buyer_briefs add constraint chk_brief_nocontact
  check ( note !~* '(@|https?://|www\.|010[- ]?[0-9]{3,4}[- ]?[0-9]{4}|카카오톡|카톡|kakao|텔레그램|telegram)' ) not valid;

-- ── 5) 회원 탈퇴 대비 FK 정리 ────────────────────────────────
-- profiles 행 삭제(= auth.users 삭제의 연쇄)가 막히지 않게:
-- 기록성 참조는 set null(익명 기록 보존), 개인 귀속 데이터는 cascade(함께 파기)
do $$ begin
  -- 기록 보존(set null)
  alter table public.platforms drop constraint if exists platforms_created_by_fkey;
  alter table public.platforms add constraint platforms_created_by_fkey
    foreign key (created_by) references public.profiles(id) on delete set null;
  alter table public.submissions drop constraint if exists submissions_submitter_id_fkey;
  alter table public.submissions add constraint submissions_submitter_id_fkey
    foreign key (submitter_id) references public.profiles(id) on delete set null;
  alter table public.submissions drop constraint if exists submissions_reviewed_by_fkey;
  alter table public.submissions add constraint submissions_reviewed_by_fkey
    foreign key (reviewed_by) references public.profiles(id) on delete set null;
  alter table public.lifecycle_transitions drop constraint if exists lifecycle_transitions_actor_id_fkey;
  alter table public.lifecycle_transitions add constraint lifecycle_transitions_actor_id_fkey
    foreign key (actor_id) references public.profiles(id) on delete set null;
  alter table public.deals drop constraint if exists deals_owner_id_fkey;
  alter table public.deals add constraint deals_owner_id_fkey
    foreign key (owner_id) references public.profiles(id) on delete set null;
  alter table public.operator_claims drop constraint if exists operator_claims_reviewed_by_fkey;
  alter table public.operator_claims add constraint operator_claims_reviewed_by_fkey
    foreign key (reviewed_by) references public.profiles(id) on delete set null;
  alter table public.partner_posts drop constraint if exists partner_posts_reviewed_by_fkey;
  alter table public.partner_posts add constraint partner_posts_reviewed_by_fkey
    foreign key (reviewed_by) references public.profiles(id) on delete set null;
  alter table public.deal_submissions drop constraint if exists deal_submissions_reviewed_by_fkey;
  alter table public.deal_submissions add constraint deal_submissions_reviewed_by_fkey
    foreign key (reviewed_by) references public.profiles(id) on delete set null;
  -- 개인 귀속(cascade — 탈퇴 시 함께 파기; 전부 미사용 P4/과금 테이블, 유료화 시 재검토)
  alter table public.operator_claims drop constraint if exists operator_claims_user_id_fkey;
  alter table public.operator_claims add constraint operator_claims_user_id_fkey
    foreign key (user_id) references public.profiles(id) on delete cascade;
  alter table public.platform_operators drop constraint if exists platform_operators_user_id_fkey;
  alter table public.platform_operators add constraint platform_operators_user_id_fkey
    foreign key (user_id) references public.profiles(id) on delete cascade;
  alter table public.proposals drop constraint if exists proposals_created_by_fkey;
  alter table public.proposals add constraint proposals_created_by_fkey
    foreign key (created_by) references public.profiles(id) on delete cascade;
  alter table public.boost_orders drop constraint if exists boost_orders_created_by_fkey;
  alter table public.boost_orders add constraint boost_orders_created_by_fkey
    foreign key (created_by) references public.profiles(id) on delete cascade;
  alter table public.charges drop constraint if exists charges_user_id_fkey;
  alter table public.charges add constraint charges_user_id_fkey
    foreign key (user_id) references public.profiles(id) on delete cascade;
end $$;

-- ── 6) 라이브 데이터 정정 ────────────────────────────────────
-- 잘못된 대표 URL 2건(본체 URL로 연결되던 서브서비스)
update public.platforms set url = 'https://livecreator.coupang.com/' where id = 'coupanglive';
update public.platforms set url = 'https://global.musinsa.com/'      where id = 'musinsa2';
-- 정적 데이터의 '글로벌' 표기 18건 — seed에서 domestic으로 잘못 매핑됨 → overseas로
update public.platforms set region = 'overseas' where id in (
  'shopify','cafe24','global','malltail','delivered','sellerhub','shopigate','sell3','reverb',
  'globalsellers','agoda','booking','hotelscombined','trivago','kr2','youtube','noom','stipop'
) and region = 'domestic';
