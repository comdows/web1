import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { categories, groups, categoriesByGroup, categoryById } from "./data";
import type { Platform } from "./data";
import { Avatar, Badge, PlatformCard } from "./components";
import { usePlatforms, usePlatformIndex, usePlatformsLoaded, usePlatformStats } from "./lib/platforms";
import { getPlatform, remoteEnabled, trackEvent } from "./lib/api";
import { useFavs, useCompare, Recent } from "./lib/store";
import { useNav } from "./nav";

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
    getPlatform(id).then((r) => { if (alive) setRemote(r); }).finally(() => { if (alive) setFetching(false); });
    return () => { alive = false; };
  }, [id, local]);

  const p = local ?? remote ?? undefined;
  if (!p) {
    if (fetching || (!loaded && remoteEnabled)) return <div className="page container"><div className="empty">불러오는 중…</div></div>;
    return <div className="page container"><div className="empty">플랫폼을 찾을 수 없습니다. <button className="linklike" onClick={() => go("home")}>← 홈으로</button></div></div>;
  }
  const cat = categoryById(p.category);
  const on = favs.has(p.id);
  const inCmp = cmp.has(p.id);
  const related = (local ? list : (remote?.similar ?? [])).filter((x) => x.category === p.category && x.id !== p.id).slice(0, 6);
  return (
    <div className="page container">
      <button className="linklike" onClick={() => history.length > 1 ? history.back() : go("home")}>← 뒤로</button>
      <div className="detail-hero">
        <Avatar name={p.name} url={p.url} size="lg" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1>{p.name} {p.new && <Badge kind="new">NEW</Badge>}</h1>
          <div className="cat">{cat?.icon} <span className="linklike" onClick={() => go("search", { q: cat?.name ?? "" })}>{cat?.name}</span> · {p.region}</div>
          <div className="detail-cta">
            <a className="btn primary" href={p.url} target="_blank" rel="noopener noreferrer" onClick={() => { Recent.push(p.id); trackEvent("outbound", p.id); }}>공식 사이트 방문 ↗</a>
            <button className={`btn ghost ${on ? "on" : ""}`} onClick={() => favs.toggle(p.id)}>{on ? "★ 저장됨" : "☆ 즐겨찾기"}</button>
            <button className={`btn ghost ${inCmp ? "on" : ""}`} disabled={!inCmp && cmp.full} onClick={() => cmp.toggle(p.id)}>{inCmp ? "✓ 비교 담김" : "+ 비교 담기"}</button>
          </div>
        </div>
      </div>

      <div className="facts">
        <div className="fact"><div className="k">분야</div><div className="v">{cat?.icon} {cat?.name}</div></div>
        <div className="fact"><div className="k">지역</div><div className="v">{p.region}</div></div>
        <div className="fact"><div className="k">신규 여부</div><div className="v">{p.new ? "🆕 최근 등록" : "기존 등록"}</div></div>
        <div className="fact"><div className="k">공식 주소</div><div className="v mono" style={{ fontSize: 12, wordBreak: "break-all" }}>{p.url.replace(/^https?:\/\//, "").replace(/\/$/, "")}</div></div>
      </div>

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
    </div>
  );
}

/* ─────────────── Search Results ─────────────── */
type Sort = "relevance" | "new" | "name";
export function SearchResults({ initialQ = "" }: { initialQ?: string }) {
  const [q, setQ] = useState(initialQ);
  const [cats, setCats] = useState<Set<string>>(new Set());
  const [region, setRegion] = useState<string>("all");
  const [onlyNew, setOnlyNew] = useState(false);
  const [sort, setSort] = useState<Sort>("relevance");
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
      <div className="search-layout">
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
                  <label key={c.id} className="facet-opt sm">
                    <input type="checkbox" checked={cats.has(c.id)} onChange={() => toggleCat(c.id)} /> {c.name}
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
            ? <div className="empty">조건에 맞는 플랫폼이 없습니다. 필터를 줄여보세요.</div>
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
    { k: "공식", render: (p) => <a className="ext" href={p.url} target="_blank" rel="noopener noreferrer">방문 ↗</a> },
  ];
  return (
    <div className="page container">
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <h1 style={{ margin: 0 }}>비교 <span className="mono faint" style={{ fontSize: 16 }}>{items.length}/4</span></h1>
        <button className="linklike" style={{ marginLeft: "auto" }} onClick={() => cmp.clear()}>비우기</button>
      </div>
      <div className="cmp-scroll">
        <table className="cmp-table">
          <thead><tr><th></th>{items.map((p) => (
            <th key={p.id}>
              <div className="cmp-h"><span className="pname" onClick={() => go("detail", { id: p.id })}>{p.name}</span>
                <button className="linklike" onClick={() => cmp.toggle(p.id)}>✕</button></div>
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
  const [step, setStep] = useState(0);
  const [gsel, setGsel] = useState<Set<string>>(new Set());
  const [csel, setCsel] = useState<Set<string>>(new Set());
  const [newPref, setNewPref] = useState(false);

  const availCats = useMemo(() => categories.filter((c) => gsel.size === 0 || gsel.has(c.group)), [gsel]);
  const toggle = (set: Set<string>, id: string, fn: (s: Set<string>) => void) => { const n = new Set(set); if (n.has(id)) n.delete(id); else n.add(id); fn(n); };

  const recs = useMemo(() => {
    let list = platforms.filter((p) => (csel.size ? csel.has(p.category) : gsel.size ? gsel.has(categoryById(p.category)?.group ?? "") : false));
    if (newPref) list = [...list].sort((a, b) => (b.new ? 1 : 0) - (a.new ? 1 : 0));
    return list.slice(0, 12);
  }, [gsel, csel, newPref, platforms]);

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
          <div className="ob-nav"><button className="btn ghost" onClick={() => setStep(1)}>← 이전</button><button className="btn primary" onClick={() => setStep(3)}>추천 보기 →</button></div>
        </div>
      )}

      {step === 3 && (
        <div className="ob-panel">
          <h2>맞춤 추천 {recs.length}개</h2>
          <p className="muted">고르신 조건에 맞는 플랫폼입니다. ★로 저장하거나 상세를 확인하세요.</p>
          {recs.length === 0 ? <div className="empty">조건에 맞는 플랫폼이 없습니다. <button className="linklike" onClick={() => setStep(0)}>다시 고르기</button></div>
            : <div className="card-grid">{recs.map((p) => <PlatformCard key={p.id} p={p} />)}</div>}
          <div className="ob-nav"><button className="btn ghost" onClick={() => setStep(0)}>처음부터</button><button className="btn primary" onClick={() => go("home")}>전체 디렉토리 보기</button></div>
        </div>
      )}
    </div>
  );
}
