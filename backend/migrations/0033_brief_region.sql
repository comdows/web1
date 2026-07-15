-- ============================================================
-- 세모플 0033 — 인수 브리프 지역 선호(region_pref) · 매칭 지능화(Track B)
-- (0001~0032 실행된 DB에 이어 실행 · 멱등 — 컬럼 add if not exists)
-- ''=지역 무관, 'domestic'=국내, 'overseas'=해외. 브리프↔매물 매칭 지역 게이트에 사용.
-- 예산 하한 게이트는 코드(app match.ts · notify.mjs)에서 기존 budget_band로 처리 — DB 변경 없음.
-- ============================================================
alter table public.buyer_briefs add column if not exists region_pref text not null default '';

-- 값 무결성(빈문자/국내/해외만) — 재실행 안전하게 조건부 추가
do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'buyer_briefs_region_pref_chk'
  ) then
    alter table public.buyer_briefs
      add constraint buyer_briefs_region_pref_chk
      check (region_pref in ('', 'domestic', 'overseas'));
  end if;
end $$;
