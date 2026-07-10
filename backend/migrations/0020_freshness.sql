-- ============================================================
-- 세모플 0020 — 링크 신선도(신뢰 가시화 D1b)
-- (0001~0019 실행된 DB에 이어 실행 · 멱등)
--
-- healthcheck가 월간 프로브한 링크 생존 상태를 플랫폼 행에 기록 → 카드/상세에 "링크 확인 필요" 노출.
--   · link_status: ok | warn(봇차단 가능) | dead. link_checked_at: 마지막 확인 시각.
--   · 쓰기는 admin(봇, healthcheck.mjs)만(기존 admin write platforms RLS). 공개 read는 그대로(익명성 무관).
-- ============================================================

alter table public.platforms add column if not exists link_status     text;
alter table public.platforms add column if not exists link_checked_at  timestamptz;
alter table public.platforms drop constraint if exists chk_platforms_link_status;
alter table public.platforms add constraint chk_platforms_link_status
  check ( link_status is null or link_status in ('ok', 'warn', 'dead') ) not valid;
create index if not exists idx_platforms_deadlink
  on public.platforms(link_checked_at desc) where link_status = 'dead' and archived_at is null;
