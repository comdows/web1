-- ============================================================
-- 세모플 0016 — 고신뢰 자동 등재(D) + 사후 검수 (수집기 D 경로용)
-- (0001~0015 실행된 DB에 이어 실행 · 멱등)
--
-- 원칙 "자동 등재 없음"을 "부분 개방 + 스위치"로 realize한다(과금·아웃리치와 동일한 게이트 패턴):
--   · 기본 스위치 OFF → 수집기는 전부 검수 큐로(오늘 동작 그대로). 관리자가 수집 신뢰도를
--     충분히 지켜본 뒤에만 app_settings 'autolist'.enabled=true + collector_id=봇uid 로 켠다.
--   · 켜져도 auto_list_candidate RPC가 서버에서 재검증: 스위치·collector_id·신뢰도·중복·분야.
--   · 자동 등재분은 lifecycle='review' + auto_listed=true 로만 들어가(공개엔 보이되) 사후 검수 큐에 뜬다.
--     관리자는 "확정(검증 승격)" 또는 "내리기(rejected→공개 제외)" 로 사후 스팟체크한다.
-- ============================================================

-- ── 1) 자동 등재 표식(감사·사후 검수 큐의 근거) ──
alter table public.platforms add column if not exists auto_listed    boolean not null default false;
alter table public.platforms add column if not exists auto_listed_at timestamptz;
create index if not exists idx_platforms_autolisted
  on public.platforms(auto_listed_at desc) where auto_listed and archived_at is null;

-- ── 2) 호스트 정규화(수집기 host()와 동일 규칙: 스킴·포트·경로 제거 + www/m/mobile 등 접두 제거) ──
create or replace function public.host_norm(u text)
returns text language sql immutable set search_path = public as $$
  select regexp_replace(
    split_part(split_part(regexp_replace(lower(coalesce(u, '')), '^https?://', ''), '/', 1), ':', 1),
    '^((www|m|mobile|ko|kr|en|app)\.)+', ''
  )
$$;

-- ── 3) app_settings — 자동 등재 스위치(기본 OFF) ──
insert into public.app_settings (key, value) values
  ('autolist', '{"enabled": false, "min_confidence": 80, "collector_id": null}')
on conflict (key) do nothing;

-- ── 4) 자동 등재 RPC — 수집기 봇(collector_id)만 호출, 서버가 전 조건 재검증 ──
create or replace function public.auto_list_candidate(p_payload jsonb, p_confidence int)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_cfg   jsonb;
  v_name  text := trim(p_payload->>'name');
  v_url   text := trim(p_payload->>'url');
  v_cat   text := p_payload->>'category_id';
  v_region text := coalesce(p_payload->>'region', 'overseas');
  v_desc  text := coalesce(p_payload->>'desc', '');
  v_base  text;
  v_id    text;
  v_n     int := 1;
begin
  select value into v_cfg from public.app_settings where key = 'autolist';
  if v_cfg is null or coalesce((v_cfg->>'enabled')::boolean, false) is not true then
    raise exception 'AUTOLIST_OFF';
  end if;
  if auth.uid() is null or (v_cfg->>'collector_id') is null
     or auth.uid()::text <> (v_cfg->>'collector_id') then
    raise exception 'FORBIDDEN';
  end if;
  if p_confidence < coalesce((v_cfg->>'min_confidence')::int, 80) then
    raise exception 'LOW_CONFIDENCE';
  end if;
  if v_name = '' or v_url = '' or public.host_norm(v_url) = '' then
    raise exception 'BAD_PAYLOAD';
  end if;
  if v_region not in ('domestic', 'overseas') then v_region := 'overseas'; end if;
  if not exists (select 1 from public.categories where id = v_cat) then
    raise exception 'BAD_CATEGORY';
  end if;
  -- 중복(정규화 호스트 일치) → 등재 거절(수집기는 검수 큐로 폴백)
  if exists (select 1 from public.platforms where public.host_norm(url) = public.host_norm(v_url)) then
    raise exception 'DUP_EXISTS';
  end if;

  -- id 슬러그 생성 + 충돌 회피
  v_base := regexp_replace(split_part(public.host_norm(v_url), '.', 1), '[^a-z0-9-]', '-', 'g');
  v_base := regexp_replace(v_base, '(^-+|-+$)', '', 'g');
  if v_base = '' then v_base := 'platform'; end if;
  v_id := v_base;
  while exists (select 1 from public.platforms where id = v_id) loop
    v_n := v_n + 1; v_id := v_base || '-' || v_n;
    if v_n > 50 then raise exception 'ID_EXHAUSTED'; end if;
  end loop;

  insert into public.platforms (id, name, category_id, region, url, blurb,
                                is_new, verified, lifecycle, auto_listed, auto_listed_at, created_by)
  values (v_id, left(v_name, 60), v_cat, v_region::region_t, v_url, left(v_desc, 300),
          true, false, 'review', true, now(), auth.uid());
  return v_id;
end $$;
revoke execute on function public.auto_list_candidate(jsonb, int) from public, anon;
grant  execute on function public.auto_list_candidate(jsonb, int) to authenticated;

-- ── 5) 사후 검수 RPC — 관리자만: 확정(검증 승격) / 내리기(공개 제외) ──
create or replace function public.review_auto_listed(p_id text, p_keep boolean, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_from lifecycle_t;
begin
  if not public.is_admin() then raise exception 'FORBIDDEN'; end if;
  select lifecycle into v_from from public.platforms where id = p_id for update;
  if v_from is null then raise exception 'NOT_FOUND'; end if;
  if p_keep then
    update public.platforms
       set auto_listed = false, verified = true,
           lifecycle = case when v_from = 'review' then 'verified'::lifecycle_t else lifecycle end
     where id = p_id;
    if v_from = 'review' then
      insert into public.lifecycle_transitions (platform_id, from_state, to_state, reason, actor_id)
      values (p_id, v_from, 'verified', coalesce(p_reason, '자동 등재 사후 확정'), auth.uid());
    end if;
  else
    update public.platforms
       set auto_listed = false, archived_at = now(),
           lifecycle = case when public.lifecycle_allowed(v_from, 'rejected') then 'rejected'::lifecycle_t else lifecycle end
     where id = p_id;
    if public.lifecycle_allowed(v_from, 'rejected') then
      insert into public.lifecycle_transitions (platform_id, from_state, to_state, reason, actor_id)
      values (p_id, v_from, 'rejected', coalesce(p_reason, '자동 등재 사후 반려'), auth.uid());
    end if;
  end if;
end $$;
revoke execute on function public.review_auto_listed(text, boolean, text) from public, anon;
grant  execute on function public.review_auto_listed(text, boolean, text) to authenticated;
