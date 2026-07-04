import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { categories, groups, categoriesByGroup, categoryById } from "./data";
import type { Platform } from "./data";
import { Avatar, Badge, PlatformCard, ShareButton } from "./components";
import { usePlatforms, usePlatformIndex, usePlatformsLoaded, usePlatformStats } from "./lib/platforms";
import { amOperatorOf, createOperatorClaim, getMyClaim, getPlatform, remoteEnabled, trackEvent } from "./lib/api";
import type { OperatorClaim } from "./lib/api";
import { pickRecommended, sortByRelevance } from "./lib/search";
import { Compare as CompareStore, Favs, Interests, Recent, useCompare, useFavs } from "./lib/store";
import { useNav } from "./nav";
import { useSession } from "./lib/auth";

const Compare_hasSafe = (id: string) => CompareStore.has(id);

const FEE_LABEL: Record<string, { l: string; k: "good" | "soon" | "muted" }> = {
  low: { l: "낮음", k: "good" }, mid: { l: "중간", k: "soon" }, high: { l: "높음", k: "muted" },
};

/* ── 운영자 인증 신청(클레임) — 승인 시 운영자 지정 + 검증 배지, 제휴·거래소의 B2B 접점 ── */
function OperatorClaimBox({ platformId, platformUrl }: { platformId: string; platformUrl: string }) {
  const go = useNav();
  const { session } = useSession();
  const [claim, setClaim] = useState<OperatorClaim | null>(null);
  const [isOp, setIsOp] = useState(false);
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState(false);
  useEffect(() => {
    setClaim(null); setIsOp(false); setOpen(false); setDone(false);
    if (!session || !remoteEnabled) return;
    let alive = true;
    getMyClaim(platformId).then((c) => { if (alive) setClaim(c); }).catch(() => { /* noop */ });
    amOperatorOf(platformId).then((v) => { if (alive) setIsOp(v); }).catch(() => { /* noop */ });
    return () => { alive = false; };
  }, [platformId, session]);
  if (!remoteEnabled) return null;

  let host = "";
  try { host = new URL(platformUrl).hostname.replace(/^www\./, ""); } catch { /* noop */ }
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(""); setBusy(true);
    try { await createOperatorClaim(platformId, email.trim()); setDone(true); setOpen(false); }
    catch (ex) { setErr(ex instanceof Error ? ex.message : String(ex)); }
    finally { setBusy(false); }
  };

  return (
    <div className="banner" style={{ margin: "14px 0" }}>
      {isOp ? (
        <>✓ <b>운영자 인증 완료</b> — 이 플랫폼에 검증 배지가 표시됩니다. 정보 수정은 정정 제보 또는 문의로 반영돼요.</>
      ) : done || claim?.status === "pending" || claim?.status === "code_sent" ? (
        <>🏷 <b>운영자 인증 검수 중</b> — 도메인 이메일 확인 후 승인되면 검증 배지가 붙어요. 진행 상태는 이 페이지에서 확인할 수 있어요.</>
      ) : claim?.status === "verified" ? (
        <>✓ <b>운영자 인증 완료</b> — 검증 배지가 표시됩니다.</>
      ) : claim?.status === "rejected" ? (
        <>🏷 운영자 인증이 반려됐어요 — 도메인 이메일로 다시 신청하거나 문의해 주세요.
          <button className="btn ghost sm" style={{ marginLeft: 8 }} onClick={() => { setClaim(null); setOpen(true); }}>다시 신청</button></>
      ) : !session ? (
        <>🏷 <b>이 플랫폼의 운영자이신가요?</b> 인증하면 검증 배지가 붙고, 제휴 제안을 공식으로 받을 수 있어요.{" "}
          <button className="linklike" onClick={() => go("account")}>로그인 후 신청 →</button></>
      ) : !open ? (
        <>🏷 <b>이 플랫폼의 운영자이신가요?</b> 인증하면 검증 배지가 붙고, 제휴 제안을 공식으로 받을 수 있어요.{" "}
          <button className="btn ghost sm" onClick={() => setOpen(true)}>운영자 인증 신청</button></>
      ) : (
        <form className="frm" style={{ marginTop: 6 }} onSubmit={submit}>
          <label>업무용 이메일 *
            <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)}
              placeholder={host ? `예: name@${host}` : "도메인 이메일"} />
          </label>
          <div className="frm-note">플랫폼 도메인({host || "공식 도메인"})과 일치하는 이메일이면 검수가 빨라요. 서류 인증이 필요하면 검수 중에 안내드립니다.</div>
          {err && <div className="err">{err}</div>}
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn primary sm" disabled={busy} type="submit">{busy ? "신청 중…" : "인증 신청"}</button>
            <button className="btn ghost sm" type="button" onClick={() => setOpen(false)}>취소</button>
          </div>
        </form>
      )}
    </div>
  );
}

/* ─────────────── Platform Detail ─────────────── */
export function PlatformDetail({ id }: { id?: string }) {
  const go = useNav();
  const favs = useFavs();
  const cmp = useCompare();
  const list = usePlatforms();
  const index = usePlatformIndex();
  const loaded = usePlatformsLoaded();
  const local = id ? index.get(id) : undefined;

  // 목록에 없으면(원격 전용 신규 등) 개별 원격 조회 폴백
  const [remote, setRemote] = useState<(Platform & { similar?: Platform[] }) | null>(null);
  const [fetching, setFetching] = useState(false);
  useEffect(() => {
    setRemote(null);
    if (!id || local || !remoteEnabled) return;
    let alive = true;
    setFetching(true);
    getPlatform(id).then((r) => { if (alive) setRemote(r); }).catch(() => { /* 폴백은 local */ }).finally(() => { if (alive) setFetching(false); });
    return () => { alive = false; };
  }, [id, local]);

  const p = local ?? remote ?? undefined;
  useEffect(() => {
    if (p) { document.title = `${p.name} — 세모플`; Recent.push(p.id); } // 열람 이력 기록(최근 본)
    return () => { document.title = "세모플 — 세상의 모든 플랫폼"; };
  }, [p]);
  // 검색엔진(/p/ 프리렌더 경로)으로 들어온 첫 방문에만 사이트 소개 배너 1회 노출
  const [seoCtx] = useState(() => {
    if (!/\/p\/[a-z0-9-]+\/?$/.test(location.pathname)) return false;
    try { if (sessionStorage.getItem("sm.seen.v1")) return false; sessionStorage.setItem("sm.seen.v1", "1"); } catch { /* noop */ }
    return true;
  });
  if (!p) {
    if (fetching || (!loaded && remoteEnabled)) return <div className="page container"><div className="empty">불러오는 중…</div></div>;
    return (
      <div className="page container">
        <div className="empty">
          플랫폼을 찾을 수 없습니다 — 주소가 바뀌었거나 삭제된 항목이에요.{" "}
          <button className="linklike" onClick={() => go("search")}>🔍 검색으로 찾기</button>{" "}
          <button className="linklike" onClick={() => go("home")}>← 홈으로</button>
        </div>
      </div>
    );
  }
  const cat = categoryById(p.category);
  const on = favs.has(p.id);
  const inCmp = cmp.has(p.id);
  const related = (local ? list : (remote?.similar ?? [])).filter((x) => x.category === p.category && x.id !== p.id).slice(0, 6);
  return (
    <div className="page container">
      {seoCtx && (
        <div className="banner" style={{ marginBottom: 12 }}>
          △ <b>세모플</b> — 1,600여 개 플랫폼·AI 도구를 같은 기준으로 정리한 무료 디렉토리예요. 비교하고 ★로 저장해 보세요.{" "}
          <button className="linklike" onClick={() => go("home")}>전체 디렉토리 →</button>{" "}
          <button className="linklike" onClick={() => go("ai-finder")}>AI 도구 찾기 →</button>
        </div>
      )}
      <button className="linklike" onClick={() => history.length > 1 ? history.back() : go("home")}>← 뒤로</button>
      <div className="detail-hero">
        <Avatar name={p.name} url={p.url} size="lg" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1>{p.name} {p.verified && <Badge kind="verify">검증</Badge>}{p.new && <Badge kind="new">NEW</Badge>}</h1>
          <div className="cat">{cat?.icon} <span className="linklike" onClick={() => go("search", { q: cat?.name ?? "" })}>{cat?.name}</span> · {p.region}</div>
          <div className="detail-cta">
            <a className="btn primary" href={p.url} target="_blank" rel="noopener noreferrer" onClick={() => { Recent.push(p.id); trackEvent("outbound", p.id); }}>공식 사이트 방문 ↗</a>
            <button className={`btn ghost ${on ? "on" : ""}`} onClick={() => favs.toggle(p.id)}>{on ? "★ 저장됨" : "☆ 즐겨찾기"}</button>
            <button className={`btn ghost ${inCmp ? "on" : ""}`} disabled={!inCmp && cmp.full} onClick={() => cmp.toggle(p.id)}>{inCmp ? "✓ 비교 담김" : "+ 비교 담기"}</button>
            <ShareButton small={false} title={`${p.name} — 세모플`} url={`${location.origin}${import.meta.env.BASE_URL}p/${p.id}/`} />
          </div>
        </div>
      </div>

      {p.blurb && <p className="lead" style={{ maxWidth: 640, marginTop: 4 }}>{p.blurb}</p>}

      <div className="facts">
        <div className="fact"><div className="k">분야</div><div className="v">{cat?.icon} {cat?.name}</div></div>
        <div className="fact"><div className="k">지역</div><div className="v">{p.region}</div></div>
        <div className="fact"><div className="k">신규 여부</div><div className="v">{p.new ? "🆕 최근 등록" : "기존 등록"}</div></div>
        <div className="fact"><div className="k">공식 주소</div><div className="v mono" style={{ fontSize: 12, wordBreak: "break-all" }}>{p.url.replace(/^https?:\/\//, "").replace(/\/$/, "")}</div></div>
        {p.fee_band && (
          <div className="fact"><div className="k">수수료대</div><div className="v">
            <Badge kind={FEE_LABEL[p.fee_band].k}>{FEE_LABEL[p.fee_band].l}</Badge>{p.fee_text ? ` ${p.fee_text}` : ""}
          </div></div>
        )}
        {p.settle_text && <div className="fact"><div className="k">정산 주기</div><div className="v">{p.settle_text}</div></div>}
        {p.enter_text && <div className="fact"><div className="k">입점 조건</div><div className="v">{p.enter_text}</div></div>}
        {p.strength && <div className="fact"><div className="k">강점</div><div className="v">{p.strength}</div></div>}
      </div>

      <OperatorClaimBox platformId={p.id} platformUrl={p.url} />

      <div className="panel-note banner">
        ⓘ 세모플의 설명은 <b>개략 소개</b>입니다. 수수료·정산·입점 조건 등 상세는 <b>공식 사이트</b>에서 확인하세요.
        정보가 다르면 <a href={`https://github.com/comdows/web1/issues/new?title=${encodeURIComponent("[정보 정정] " + p.name)}`} target="_blank" rel="noopener noreferrer">정정 제보</a> 부탁드립니다.
      </div>

      {related.length > 0 && (
        <>
          <div className="sec-title">같은 분야의 다른 플랫폼</div>
          <div className="card-grid">{related.map((r) => <PlatformCard key={r.id} p={r} showCat={false} />)}</div>
        </>
      )}
      {(() => {
        const rec = Recent.list().filter((x) => x !== p.id).map((x) => index.get(x)).filter(Boolean).slice(0, 4) as Platform[];
        if (rec.length < 2) return null;
        return (
          <>
            <div className="sec-title">🕘 최근 본 플랫폼</div>
            <div className="card-grid">{rec.map((r) => <PlatformCard key={r.id} p={r} />)}</div>
            <p className="sub faint" style={{ fontSize: 12.5 }}>★로 저장하면 로그인 시 계정에 동기화돼요.</p>
          </>
        );
      })()}
    </div>
  );
}

/* ─────────────── Search Results ─────────────── */
type Sort = "relevance" | "new" | "name";
export function SearchResults({ initialQ = "" }: { initialQ?: string }) {
  const go = useNav();
  // URL에서 필터 복원(새로고침·공유·뒤로가기에 필터 유지)
  const sp0 = new URLSearchParams(location.search);
  const pathCat = location.pathname.match(/\/c\/([a-z0-9_-]+)\/?$/)?.[1]; // 분야 허브(/c/) 진입
  const [q, setQ] = useState(initialQ || sp0.get("q") || "");
  const [cats, setCats] = useState<Set<string>>(() => new Set([...(sp0.get("cats") ?? "").split(",").filter(Boolean), ...(pathCat ? [pathCat] : [])]));
  const [showFilters, setShowFilters] = useState(false); // 모바일: 필터 접이식(결과 먼저)
  const [region, setRegion] = useState<string>(sp0.get("region") ?? "all");
  const [onlyNew, setOnlyNew] = useState(sp0.get("new") === "1");
  const [sort, setSort] = useState<Sort>((sp0.get("sort") as Sort) || "relevance");

  // 필터 상태 → URL(replaceState — 홈과 동일 패턴)
  useEffect(() => {
    const p = new URLSearchParams();
    p.set("view", "search");
    if (q.trim()) p.set("q", q.trim());
    if (cats.size) p.set("cats", [...cats].join(","));
    if (region !== "all") p.set("region", region);
    if (onlyNew) p.set("new", "1");
    if (sort !== "relevance") p.set("sort", sort);
    history.replaceState(null, "", `?${p}`);
  }, [q, cats, region, onlyNew, sort]);
  const platforms = usePlatforms();
  const stats = usePlatformStats();

  const toggleCat = (id: string) => setCats((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  // 검색어가 멈추면 이벤트 기록(관리자 '인기 검색어' 근거) — 원격 모드에서만, 실패 무시
  useEffect(() => {
    const query = q.trim();
    if (query.length < 2) return;
    const id = setTimeout(() => trackEvent("search", undefined, query), 600);
    return () => clearTimeout(id);
  }, [q]);

  const results = useMemo(() => {
    const query = q.trim().toLowerCase();
    let list = platforms.filter((p) => {
      if (cats.size && !cats.has(p.category)) return false;
      if (region !== "all" && p.region !== region) return false;
      if (onlyNew && !p.new) return false;
      if (query) {
        const hay = (p.name + " " + p.blurb + " " + (categoryById(p.category)?.name ?? "")).toLowerCase();
        if (!query.split(/\s+/).every((t) => hay.includes(t))) return false;
      }
      return true;
    });
    if (sort === "new") list = [...list].sort((a, b) => (b.new ? 1 : 0) - (a.new ? 1 : 0));
    else if (sort === "name") list = [...list].sort((a, b) => a.name.localeCompare(b.name, "ko"));
    else if (query) list = sortByRelevance(list, query); // 관련도: 이름 정확 > 시작 > 포함 > 분야 > 소개
    return list;
  }, [q, cats, region, onlyNew, sort, platforms]);

  const activeChips: { label: string; clear: () => void }[] = [];
  cats.forEach((c) => activeChips.push({ label: categoryById(c)?.name ?? c, clear: () => toggleCat(c) }));
  if (region !== "all") activeChips.push({ label: region, clear: () => setRegion("all") });
  if (onlyNew) activeChips.push({ label: "신규만", clear: () => setOnlyNew(false) });

  return (
    <div className="page container search-page">
      <div className="search" style={{ maxWidth: "none", marginBottom: 18 }}>
        <span className="ico">⌕</span>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="플랫폼·분야 검색" autoFocus />
      </div>
      <button className="btn ghost sm filters-toggle" onClick={() => setShowFilters((v) => !v)}>
        {showFilters ? "필터 접기 ▴" : `필터 열기${activeChips.length ? ` (${activeChips.length}개 적용 중)` : ""} ▾`}
      </button>
      <div className={`search-layout ${showFilters ? "filters-open" : ""}`}>
        <aside className="facets">
          <div className="facet-group">
            <div className="facet-title">지역</div>
            {["all", "국내", "해외"].map((r) => (
              <label key={r} className="facet-opt"><input type="radio" name="region" checked={region === r} onChange={() => setRegion(r)} /> {r === "all" ? "전체" : r}</label>
            ))}
          </div>
          <div className="facet-group">
            <div className="facet-title">신규</div>
            <label className="facet-opt"><input type="checkbox" checked={onlyNew} onChange={() => setOnlyNew((v) => !v)} /> 🆕 최근 등록만</label>
          </div>
          <div className="facet-group">
            <div className="facet-title">분야</div>
            {groups.map((g) => (
              <div key={g.id} className="facet-sub">
                <div className="facet-sub-title">{g.icon} {g.name}</div>
                {categoriesByGroup(g.id).map((c) => (
                  <label key={c.id} className="facet-opt sm" style={(stats.counts.get(c.id) ?? 0) === 0 ? { opacity: .45 } : undefined}>
                    <input type="checkbox" disabled={(stats.counts.get(c.id) ?? 0) === 0 && !cats.has(c.id)}
                      checked={cats.has(c.id)} onChange={() => toggleCat(c.id)} /> {c.name}
                    <span className="facet-ct">{stats.counts.get(c.id) ?? 0}</span>
                  </label>
                ))}
              </div>
            ))}
          </div>
        </aside>
        <div className="search-main">
          <div className="search-toolbar">
            <div className="result-meta" style={{ margin: 0 }}>{results.length.toLocaleString()}개 결과</div>
            <select className="select" value={sort} onChange={(e) => setSort(e.target.value as Sort)} style={{ marginLeft: "auto" }}>
              <option value="relevance">관련도</option>
              <option value="new">신규 우선</option>
              <option value="name">가나다</option>
            </select>
          </div>
          {activeChips.length > 0 && (
            <div className="chips-row">
              {activeChips.map((c, i) => <button key={i} className="fchip on" onClick={c.clear}>{c.label} ✕</button>)}
              <button className="linklike" onClick={() => { setCats(new Set()); setRegion("all"); setOnlyNew(false); }}>전체 해제</button>
            </div>
          )}
          {results.length === 0
            ? <div className="empty">조건에 맞는 플랫폼이 없습니다. 필터를 줄여보세요. 찾는 플랫폼이 없다면 <button className="linklike" onClick={() => go("submit")}>+ 제보</button>해 주시면 검수 후 등재해 드려요.</div>
            : <div className="card-grid">{results.slice(0, 300).map((p) => <PlatformCard key={p.id} p={p} />)}</div>}
          {results.length > 300 && <div className="result-meta">상위 300개 표시 · 검색어·필터로 좁혀보세요.</div>}
        </div>
      </div>
    </div>
  );
}

/* ─────────────── Compare ─────────────── */
export function Compare() {
  const go = useNav();
  const cmp = useCompare();
  const index = usePlatformIndex();
  // 공유 링크(?ids=a,b,c)로 진입하면 비교함을 채운다 — 비교표가 "보낼 수 있는 산출물"이 됨
  useEffect(() => {
    const ids = (new URLSearchParams(location.search).get("ids") ?? "").split(",").filter(Boolean).slice(0, 4);
    for (const id of ids) if (!Compare_hasSafe(id)) cmp.toggle(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // 비교함 상태를 URL에 반영(새로고침·공유 유지)
  useEffect(() => {
    const p = new URLSearchParams(location.search);
    if (cmp.count > 0) p.set("ids", cmp.all().join(",")); else p.delete("ids");
    history.replaceState(null, "", `?${p}`);
  }, [cmp.count]);
  const items = cmp.all().map((id) => index.get(id)).filter(Boolean) as Platform[];
  if (items.length === 0) return (
    <div className="page container"><h1>비교</h1>
      <div className="empty">비교할 플랫폼이 없습니다. 카드의 <b>+ 비교</b>로 최대 4개까지 담아보세요. <button className="linklike" onClick={() => go("search")}>검색하러 가기</button></div>
    </div>
  );
  const rows: { k: string; render: (p: Platform) => ReactNode }[] = [
    { k: "분야", render: (p) => `${categoryById(p.category)?.icon ?? ""} ${categoryById(p.category)?.name ?? p.category}` },
    { k: "지역", render: (p) => p.region },
    { k: "신규", render: (p) => (p.new ? "🆕" : "—") },
    { k: "설명", render: (p) => <span style={{ fontSize: 13 }}>{p.blurb}</span> },
  ];
  // 리치 필드: 비교 대상 중 하나라도 값이 있으면 행 생성(전원 null 행은 숨김)
  if (items.some((p) => p.fee_band)) rows.push({ k: "수수료대", render: (p) => p.fee_band ? `${FEE_LABEL[p.fee_band].l}${p.fee_text ? ` (${p.fee_text})` : ""}` : "—" });
  if (items.some((p) => p.settle_text)) rows.push({ k: "정산 주기", render: (p) => p.settle_text ?? "—" });
  if (items.some((p) => p.enter_text)) rows.push({ k: "입점 조건", render: (p) => p.enter_text ?? "—" });
  if (items.some((p) => p.strength)) rows.push({ k: "강점", render: (p) => p.strength ?? "—" });
  rows.push({ k: "공식", render: (p) => <a className="ext" href={p.url} target="_blank" rel="noopener noreferrer">방문 ↗</a> });
  return (
    <div className="page container">
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <h1 style={{ margin: 0 }}>비교 <span className="mono faint" style={{ fontSize: 16 }}>{items.length}/4</span></h1>
        <ShareButton title={`세모플 비교 — ${items.map((p) => p.name).join(" vs ")}`} />
        <button className="linklike" style={{ marginLeft: "auto" }} onClick={() => cmp.clear()}>비우기</button>
      </div>
      <div className="cmp-scroll">
        <table className="cmp-table">
          <thead><tr><th></th>{items.map((p) => (
            <th key={p.id}>
              <div className="cmp-h"><button className="pname" onClick={() => go("detail", { id: p.id })}>{p.name}</button>
                <button className="linklike" onClick={() => cmp.toggle(p.id)} aria-label="비교에서 제거">✕</button></div>
            </th>
          ))}</tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.k}><td className="cmp-k">{r.k}</td>{items.map((p) => <td key={p.id}>{r.render(p)}</td>)}</tr>
          ))}</tbody>
        </table>
      </div>
    </div>
  );
}

/* ─────────────── Onboarding ─────────────── */
export function Onboarding() {
  const go = useNav();
  const platforms = usePlatforms();
  const saved = Interests.get(); // 이전 온보딩 선택 복원(관심 프로필)
  const [step, setStep] = useState(0);
  const [gsel, setGsel] = useState<Set<string>>(new Set(saved?.groups ?? []));
  const [csel, setCsel] = useState<Set<string>>(new Set(saved?.cats ?? []));
  const [newPref, setNewPref] = useState(saved?.newPref ?? false);
  const [savedAll, setSavedAll] = useState(false);

  const availCats = useMemo(() => categories.filter((c) => gsel.size === 0 || gsel.has(c.group)), [gsel]);
  const toggle = (set: Set<string>, id: string, fn: (s: Set<string>) => void) => { const n = new Set(set); if (n.has(id)) n.delete(id); else n.add(id); fn(n); };

  const recs = useMemo(() => pickRecommended(platforms, [...gsel], [...csel], newPref, 12), [gsel, csel, newPref, platforms]);

  const steps = ["관심 영역", "세부 분야", "선호", "추천"];
  return (
    <div className="page container onboarding">
      <div className="ob-bar">{steps.map((s, i) => <div key={i} className={`ob-step ${i === step ? "on" : ""} ${i < step ? "done" : ""}`}><span className="mono">{i + 1}</span> {s}</div>)}</div>

      {step === 0 && (
        <div className="ob-panel">
          <h2>어떤 영역에서 팔거나 사업을 확장하시나요?</h2>
          <p className="muted">관심 있는 대분류를 고르세요 (복수 선택).</p>
          <div className="groups">{groups.map((g) => (
            <button key={g.id} className={`gcard ${gsel.has(g.id) ? "sel" : ""}`} onClick={() => toggle(gsel, g.id, setGsel)}>
              <div className="g-ic">{g.icon}</div><h4>{g.name}</h4><div className="g-meta">{categoriesByGroup(g.id).length} 분야</div>
            </button>
          ))}</div>
          <div className="ob-nav"><button className="btn primary" disabled={gsel.size === 0} onClick={() => setStep(1)}>다음 →</button></div>
        </div>
      )}

      {step === 1 && (
        <div className="ob-panel">
          <h2>구체적으로 어떤 분야인가요?</h2>
          <p className="muted">해당하는 분야를 고르세요 (건너뛰면 대분류 전체 추천).</p>
          <div className="chips-row" style={{ maxHeight: 300, overflow: "auto" }}>
            {availCats.map((c) => <button key={c.id} className={`fchip ${csel.has(c.id) ? "on" : ""}`} onClick={() => toggle(csel, c.id, setCsel)}>{c.icon} {c.name}</button>)}
          </div>
          <div className="ob-nav"><button className="btn ghost" onClick={() => setStep(0)}>← 이전</button><button className="btn primary" onClick={() => setStep(2)}>다음 →</button></div>
        </div>
      )}

      {step === 2 && (
        <div className="ob-panel">
          <h2>선호를 알려주세요</h2>
          <label className="facet-opt" style={{ fontSize: 15 }}><input type="checkbox" checked={newPref} onChange={() => setNewPref((v) => !v)} /> 🆕 새로 나온 플랫폼을 우선 추천</label>
          <div className="ob-nav"><button className="btn ghost" onClick={() => setStep(1)}>← 이전</button><button className="btn primary" onClick={() => { Interests.set({ groups: [...gsel], cats: [...csel], newPref }); setStep(3); }}>추천 보기 →</button></div>
        </div>
      )}

      {step === 3 && (
        <div className="ob-panel">
          <h2>맞춤 추천 {recs.length}개</h2>
          <p className="muted">고르신 조건에 맞는 플랫폼입니다. ★로 저장하거나 상세를 확인하세요.</p>
          {recs.length === 0 ? <div className="empty">조건에 맞는 플랫폼이 없습니다. <button className="linklike" onClick={() => setStep(0)}>다시 고르기</button></div>
            : <div className="card-grid">{recs.map((p) => <PlatformCard key={p.id} p={p} />)}</div>}
          <div className="frm-note" style={{ marginTop: 8 }}>선택하신 관심 분야는 저장돼요 — 홈과 "새로 나온 것"에서 내 분야 위주로 볼 수 있습니다.</div>
          <div className="ob-nav">
            <button className="btn ghost" onClick={() => setStep(0)}>처음부터</button>
            {recs.length > 0 && (
              <button className="btn ghost" disabled={savedAll} onClick={() => { recs.forEach((p) => { if (!Favs.has(p.id)) Favs.toggle(p.id); }); setSavedAll(true); }}>
                {savedAll ? "★ 저장됨" : "★ 추천 전체 저장"}
              </button>
            )}
            <button className="btn primary" onClick={() => go("home")}>전체 디렉토리 보기</button>
          </div>
        </div>
      )}
    </div>
  );
}
