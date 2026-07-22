-- ============================================================
-- 세모플 0043 — 국가별 main/ad 수집 풀 서버 경계
-- (0001~0042 실행된 DB에 이어 실행 · 멱등)
--
-- 수집기에서 광고·출시 홍보형 후보를 별도 검수 풀로 분리해도, 기존
-- auto_list_candidate RPC가 collection_pool을 검사하지 않으면 봇 자격증명으로
-- 직접 호출해 우회할 수 있다. RPC에서도 명시적 main + 국가 일치를 강제한다.
-- ============================================================

create or replace function public.auto_list_candidate(p_payload jsonb, p_confidence int)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_cfg    jsonb;
  v_name   text := trim(p_payload->>'name');
  v_url    text := trim(p_payload->>'url');
  v_cat    text := p_payload->>'category_id';
  v_region text := coalesce(p_payload->>'region', 'overseas');
  v_pool   text := p_payload->>'collection_pool';
  v_collection_region text := p_payload->>'collection_region';
  v_desc   text := coalesce(p_payload->>'desc', '');
  v_base   text;
  v_id     text;
  v_n      int := 1;
begin
  select value into v_cfg from public.app_settings where key = 'autolist';
  if v_cfg is null or coalesce((v_cfg->>'enabled')::boolean, false) is not true then
    raise exception 'AUTOLIST_OFF';
  end if;
  if auth.uid() is null or (v_cfg->>'collector_id') is null
     or auth.uid()::text <> (v_cfg->>'collector_id') then
    raise exception 'FORBIDDEN';
  end if;

  -- 광고 풀과 구형(풀 미표시) payload는 검수 큐만 허용한다.
  if v_pool is distinct from 'main' then
    raise exception 'AD_POOL_REVIEW_ONLY';
  end if;
  -- 국가 버킷과 실제 등재 region이 다르면 어느 국가 예산에서 왔는지 감사할 수 없으므로 거절한다.
  if v_collection_region not in ('domestic', 'overseas')
     or v_collection_region is distinct from v_region then
    raise exception 'COLLECTION_REGION_MISMATCH';
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
  if exists (select 1 from public.platforms where public.host_norm(url) = public.host_norm(v_url)) then
    raise exception 'DUP_EXISTS';
  end if;

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
