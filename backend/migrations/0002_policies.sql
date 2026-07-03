-- ============================================================
-- 세모플 RLS 정책 v1 — 권한의 단일 원천 (0001 다음에 실행)
-- 역할: anon(비로그인) / user / operator(플랫폼 소유) / admin
-- ============================================================

-- 역할 헬퍼
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin');
$$;

-- ── profiles ─────────────────────────────────────────────────
alter table public.profiles enable row level security;
create policy "own profile read"  on public.profiles for select using (id = auth.uid() or public.is_admin());
create policy "own profile write" on public.profiles for update using (id = auth.uid())
  with check (id = auth.uid() and role = (select role from public.profiles where id = auth.uid()));
  -- role 자체 변경은 불가(관리자 지정은 SQL/서비스 키로만)

-- ── 공개 읽기: 분류·플랫폼·수수료·제휴유형·부스트상품 ─────────
alter table public.groups         enable row level security;
alter table public.categories     enable row level security;
alter table public.platforms      enable row level security;
alter table public.platform_fees  enable row level security;
alter table public.partner_type_groups enable row level security;
alter table public.partner_types  enable row level security;
alter table public.boost_tiers    enable row level security;

create policy "public read groups"     on public.groups     for select using (true);
create policy "public read categories" on public.categories for select using (true);
create policy "public read platforms"  on public.platforms  for select
  using (archived_at is null and lifecycle <> 'rejected' or public.is_admin());
create policy "public read fees"       on public.platform_fees for select using (true);
create policy "public read ptype groups" on public.partner_type_groups for select using (true);
create policy "public read ptypes"     on public.partner_types for select using (true);
create policy "public read tiers"      on public.boost_tiers   for select using (active or public.is_admin());

-- 플랫폼 쓰기: admin 전면 / operator는 소유 플랫폼의 제한 필드만(뷰·RPC로 검수 경유 권장)
create policy "admin write platforms" on public.platforms for all
  using (public.is_admin()) with check (public.is_admin());
create policy "admin write fees" on public.platform_fees for all
  using (public.is_admin()) with check (public.is_admin());
create policy "admin write taxonomy g" on public.groups for all
  using (public.is_admin()) with check (public.is_admin());
create policy "admin write taxonomy c" on public.categories for all
  using (public.is_admin()) with check (public.is_admin());
create policy "admin write ptype groups" on public.partner_type_groups for all
  using (public.is_admin()) with check (public.is_admin());
create policy "admin write ptypes" on public.partner_types for all
  using (public.is_admin()) with check (public.is_admin());
create policy "admin write tiers" on public.boost_tiers for all
  using (public.is_admin()) with check (public.is_admin());

-- ── submissions: 로그인 사용자 제보, 본인 조회, admin 검수 ────
alter table public.submissions enable row level security;
create policy "insert own submission" on public.submissions for insert
  with check (auth.uid() is not null and submitter_id = auth.uid());
create policy "read own submission" on public.submissions for select
  using (submitter_id = auth.uid() or public.is_admin());
create policy "admin review submission" on public.submissions for update
  using (public.is_admin()) with check (public.is_admin());

-- ── lifecycle_transitions: admin 전용(기록은 RPC가 수행) ──────
alter table public.lifecycle_transitions enable row level security;
create policy "admin read transitions" on public.lifecycle_transitions for select using (public.is_admin());

-- ── favorites: 소유자 전용 ────────────────────────────────────
alter table public.favorites enable row level security;
create policy "own favorites" on public.favorites for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ── operator_claims / platform_operators ─────────────────────
alter table public.operator_claims    enable row level security;
alter table public.platform_operators enable row level security;
create policy "insert own claim" on public.operator_claims for insert
  with check (user_id = auth.uid());
create policy "read own claim" on public.operator_claims for select
  using (user_id = auth.uid() or public.is_admin());
create policy "admin review claim" on public.operator_claims for update
  using (public.is_admin()) with check (public.is_admin());
create policy "read own operatorship" on public.platform_operators for select
  using (user_id = auth.uid() or public.is_admin());
create policy "admin grant operatorship" on public.platform_operators for all
  using (public.is_admin()) with check (public.is_admin());

-- ── proposals: 관련 운영자(보낸/받는 쪽) + admin ──────────────
alter table public.proposals enable row level security;
create policy "operator send proposal" on public.proposals for insert
  with check (created_by = auth.uid() and public.is_operator_of(from_platform_id));
create policy "related read proposal" on public.proposals for select
  using (public.is_operator_of(from_platform_id) or public.is_operator_of(to_platform_id) or public.is_admin());
create policy "receiver respond proposal" on public.proposals for update
  using (public.is_operator_of(to_platform_id) or public.is_admin())
  with check (public.is_operator_of(to_platform_id) or public.is_admin());

-- ── deals: 익명성 보장 — 공개는 v_deals_public 뷰로만, 원본 테이블은 소유자/admin 전용 ──
-- 중요: 3단계 익명성은 사업모델의 핵심(stage3-exchange-plan §1). PostgREST는 원본
-- 테이블(/rest/v1/deals)도 직접 노출하므로, 공개 정책이 열려 있으면 anon이 owner_id를
-- 직접 조회해 매도자 신원을 역추적할 수 있다. 따라서 원본은 소유자/admin만 읽고,
-- 익명 컬럼만 담은 v_deals_public 뷰(소유자 권한 실행 → base RLS 우회)를 공개 창구로 쓴다.
alter table public.deals          enable row level security;
alter table public.deal_interests enable row level security;
-- 구버전(0002) 정책이 남아 있으면 permissive SELECT 정책이 OR로 병합돼 익명성 누수가
-- 되살아난다. 업그레이드/재실행 시에도 안전하도록 먼저 삭제한 뒤 재생성.
drop policy if exists "public read open deals" on public.deals;
drop policy if exists "own or admin read deal" on public.deals;
create policy "own or admin read deal" on public.deals for select
  using (owner_id = auth.uid() or public.is_admin());
create policy "insert own deal" on public.deals for insert
  with check (auth.uid() is not null and owner_id = auth.uid());
create policy "own or admin update deal" on public.deals for update
  using (owner_id = auth.uid() or public.is_admin())
  with check (owner_id = auth.uid() or public.is_admin());
create policy "insert own interest" on public.deal_interests for insert
  with check (user_id = auth.uid());
create policy "read own interest" on public.deal_interests for select
  using (user_id = auth.uid() or public.is_admin());
create policy "admin manage interest" on public.deal_interests for update
  using (public.is_admin()) with check (public.is_admin());

-- 익명 공개 뷰(owner_id 등 내부 필드 제외) — 프론트는 이 뷰만 읽는다.
-- security_invoker=false(소유자 권한 실행): 원본 deals의 소유자 전용 RLS를 우회해
-- 익명 컬럼만 공개한다. anon은 원본 테이블을 못 읽고 이 뷰로만 매물을 본다.
create or replace view public.v_deals_public
  with (security_invoker = false) as
  select id, category_id, region, revenue_band, mode, summary, highlights, sale_reason, status, is_demo, posted
  from public.deals where status <> 'closed';

-- buyer_briefs: 소유자 전용(수요 정보는 비공개 자산), admin 열람
alter table public.buyer_briefs enable row level security;
create policy "own briefs" on public.buyer_briefs for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "admin read briefs" on public.buyer_briefs for select using (public.is_admin());

-- ── boost_orders: 해당 플랫폼 운영자 + admin ──────────────────
alter table public.boost_orders enable row level security;
create policy "operator create order" on public.boost_orders for insert
  with check (created_by = auth.uid() and public.is_operator_of(platform_id));
create policy "related read order" on public.boost_orders for select
  using (created_by = auth.uid() or public.is_operator_of(platform_id) or public.is_admin());
create policy "admin manage order" on public.boost_orders for update
  using (public.is_admin()) with check (public.is_admin());

-- ── 과금: plans 공개 읽기 / 지갑·구독·청구는 소유자+admin ─────
alter table public.plans          enable row level security;
alter table public.subscriptions  enable row level security;
alter table public.credit_ledger  enable row level security;
alter table public.charges        enable row level security;
create policy "public read plans" on public.plans for select using (true);
create policy "admin write plans" on public.plans for all
  using (public.is_admin()) with check (public.is_admin());
create policy "own subscriptions" on public.subscriptions for select
  using (user_id = auth.uid() or public.is_admin());
create policy "admin manage subscriptions" on public.subscriptions for all
  using (public.is_admin()) with check (public.is_admin());
create policy "own credit ledger" on public.credit_ledger for select
  using (user_id = auth.uid() or public.is_admin());
create policy "admin write credit ledger" on public.credit_ledger for insert
  with check (public.is_admin());   -- 충전·차감은 서버(RPC/관리자)만 기록
create policy "own charges" on public.charges for select
  using (user_id = auth.uid() or public.is_admin());
create policy "admin manage charges" on public.charges for all
  using (public.is_admin()) with check (public.is_admin());

-- ── events: 누구나 기록 가능(익명 분석), 읽기는 admin만 ───────
alter table public.events enable row level security;
create policy "anyone insert event" on public.events for insert with check (true);
create policy "admin read events"   on public.events for select using (public.is_admin());
