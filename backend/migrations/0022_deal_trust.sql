-- ============================================================
-- 세모플 0022 — 거래소 신뢰 마무리(E-B)
-- (0001~0021 실행된 DB에 이어 실행 · 멱등)
--
-- ① 매물 "운영자 확인 ✓" — SellForm이 약속하던 표시를 실제로: deals.owner_verified(관리자가
--    verify_note 검증 후 토글) + 공개 뷰 노출. ② 준비 증빙 유무 태그(proofs — 수치·가격 아님,
--    가격·밸류에이션 필드 금지 원칙 준수). ③ 소개(연락처 공유) 전 익명 Q&A — 질문자 신원은
--    공개 뷰에 컬럼 자체가 없다(익명성 원칙). 게시는 관리자 검수(answered) 후에만.
-- ============================================================

-- ── 1) deals: 검증·증빙 태그 ──
alter table public.deals add column if not exists owner_verified boolean not null default false;
alter table public.deals add column if not exists proofs text[] not null default '{}';

-- ── 2) 공개 뷰 재정의(0002 definer 패턴 — 작성자 식별자 여전히 비노출) ──
create or replace view public.v_deals_public
  with (security_invoker = false) as
  select id, category_id, region, revenue_band, mode, summary, highlights, sale_reason,
         status, is_demo, posted, owner_verified, proofs
  from public.deals where status <> 'closed';

-- ── 3) 익명 Q&A ──
create table if not exists public.deal_questions (
  id          uuid primary key default gen_random_uuid(),
  deal_id     text not null references public.deals(id) on delete cascade,
  asker_id    uuid not null references public.profiles(id) on delete cascade,
  question    text not null check (char_length(question) between 5 and 300),
  answer      text,
  status      text not null default 'pending' check (status in ('pending', 'answered', 'hidden')),
  created_at  timestamptz not null default now(),
  answered_at timestamptz
);
create index if not exists idx_deal_questions_deal on public.deal_questions(deal_id, status, created_at desc);
alter table public.deal_questions enable row level security;
-- 질문 등록은 본인 명의로만
drop policy if exists "own question insert" on public.deal_questions;
create policy "own question insert" on public.deal_questions for insert
  with check (asker_id = auth.uid());
-- 원본 행 열람은 본인 질문 + admin(답변·검수). 공개 노출은 아래 뷰로만.
drop policy if exists "own question read" on public.deal_questions;
create policy "own question read" on public.deal_questions for select
  using (asker_id = auth.uid() or public.is_admin());
drop policy if exists "admin question update" on public.deal_questions;
create policy "admin question update" on public.deal_questions for update
  using (public.is_admin()) with check (public.is_admin());

-- 공개 Q&A 뷰 — answered만, 질문자 신원 컬럼 없음(definer)
create or replace view public.v_deal_questions_public
  with (security_invoker = false) as
  select deal_id, question, answer, answered_at
  from public.deal_questions
  where status = 'answered'
  order by answered_at desc;
grant select on public.v_deal_questions_public to anon, authenticated;
