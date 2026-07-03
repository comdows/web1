import { useEffect, useMemo, useState, useCallback } from "react";
import { groups, categories, platforms, categoriesByGroup, countByCategory, newCount, categoryById } from "./data";
import type { Platform } from "./data";
import { Logo, StatTile, PlatformCard, Footer } from "./components";
import { useFavs, useCompare } from "./lib/store";
import { FLAGS } from "./config";
import { Partners, Exchange } from "./pages";
import { NavContext } from "./nav";
import type { ViewName } from "./nav";
import { PlatformDetail, SearchResults, Compare, Onboarding } from "./discovery";
import { Account, Submit } from "./account";
import { Admin } from "./admin";
import { useSession } from "./lib/auth";
import { remoteEnabled } from "./lib/api";

type Sort = "default" | "new" | "name";
const REPORT_URL = "https://github.com/comdows/web1/issues/new?title=" + encodeURIComponent("[플랫폼 제보]");

function readParams() {
  const p = new URLSearchParams(location.search);
  return {
    view: (p.get("view") as ViewName) || "home",
    id: p.get("id") || "",
    q: p.get("q") || "",
    group: p.get("group") || "",
    fav: p.get("fav") === "1",
    onlyNew: p.get("new") === "1",
    sort: (p.get("sort") as Sort) || "default",
  };
}

const searchIndex = platforms.map((p) => ({
  p,
  hay: (p.name + " " + p.blurb + " " + (categoryById(p.category)?.name ?? "")).toLowerCase(),
}));
function sortPlatforms(list: Platform[], sort: Sort): Platform[] {
  if (sort === "new") return [...list].sort((a, b) => (b.new ? 1 : 0) - (a.new ? 1 : 0));
  if (sort === "name") return [...list].sort((a, b) => a.name.localeCompare(b.name, "ko"));
  return list;
}
function useTheme() {
  const [theme, setTheme] = useState<string>(() => { try { return localStorage.getItem("sm.theme") || "dark"; } catch { return "dark"; } });
  useEffect(() => { document.documentElement.setAttribute("data-theme", theme); try { localStorage.setItem("sm.theme", theme); } catch { /* noop */ } }, [theme]);
  return { toggle: () => setTheme((t) => (t === "dark" ? "light" : "dark")) };
}

export default function App() {
  const init = readParams();
  const [view, setView] = useState<ViewName>(init.view);
  const [detailId, setDetailId] = useState(init.id);
  const [searchQ, setSearchQ] = useState(init.q);
  // home-only state
  const [q, setQ] = useState(init.view === "home" ? init.q : "");
  const [group, setGroup] = useState(init.group);
  const [fav, setFav] = useState(init.fav);
  const [onlyNew, setOnlyNew] = useState(init.onlyNew);
  const [sort, setSort] = useState<Sort>(init.sort);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const favs = useFavs();
  const cmp = useCompare();
  const theme = useTheme();
  const { session, profile, isAdmin } = useSession();

  const go = useCallback<(v: ViewName, params?: { id?: string; q?: string }) => void>((v, params) => {
    setView(v);
    if (params?.id !== undefined) setDetailId(params.id);
    if (params?.q !== undefined) setSearchQ(params.q);
    const sp = new URLSearchParams();
    if (v !== "home") sp.set("view", v);
    if (v === "detail" && params?.id) sp.set("id", params.id);
    if (v === "search" && params?.q) sp.set("q", params.q);
    history.pushState(null, "", sp.toString() ? `?${sp}` : location.pathname);
    window.scrollTo(0, 0);
  }, []);

  useEffect(() => {
    const onPop = () => { const p = readParams(); setView(p.view); setDetailId(p.id); setSearchQ(p.q); };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // sync home filter state to URL only while on home
  useEffect(() => {
    if (view !== "home") return;
    const p = new URLSearchParams();
    if (q) p.set("q", q); if (group) p.set("group", group); if (fav) p.set("fav", "1");
    if (onlyNew) p.set("new", "1"); if (sort !== "default") p.set("sort", sort);
    history.replaceState(null, "", p.toString() ? `?${p}` : location.pathname);
  }, [view, q, group, fav, onlyNew, sort]);

  const toggleCat = useCallback((id: string) => setOpen((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; }), []);

  const query = q.trim().toLowerCase();
  const flatMode = query.length > 0 || fav || onlyNew;
  const flatResults = useMemo(() => {
    if (!flatMode) return [] as Platform[];
    let list = query ? searchIndex.filter((x) => query.split(/\s+/).every((t) => x.hay.includes(t))).map((x) => x.p) : platforms.slice();
    if (fav) { const set = new Set(favs.all()); list = list.filter((p) => set.has(p.id)); }
    if (onlyNew) list = list.filter((p) => p.new);
    return sortPlatforms(list, sort).slice(0, 200);
  }, [flatMode, query, fav, onlyNew, sort, favs]);
  const newPlatforms = useMemo(() => platforms.filter((p) => p.new).slice(0, 24), []);
  const shownGroups = group ? groups.filter((g) => g.id === group) : groups;

  const cmpNames = cmp.all().map((id) => platforms.find((p) => p.id === id)?.name).filter(Boolean).join(", ");

  return (
    <NavContext.Provider value={go}>
      <header className="site-header"><div className="container inner">
        <a onClick={() => go("home")} style={{ cursor: "pointer" }}><Logo /></a>
        <nav>
          <a className={view === "home" ? "active" : ""} onClick={() => go("home")}>분야별</a>
          <a className={view === "search" ? "active" : ""} onClick={() => go("search")}>🔎 <span className="navlbl">검색</span></a>
          <a className={view === "onboarding" ? "active" : ""} onClick={() => go("onboarding")}>✨ <span className="navlbl">추천</span></a>
          <a className={view === "partners" ? "active" : ""} onClick={() => go("partners")}>🤝 <span className="navlbl">제휴</span>{!FLAGS.stage2 && <span className="soon">준비중</span>}</a>
          <a className={view === "exchange" ? "active" : ""} onClick={() => go("exchange")}>🏦 <span className="navlbl">거래소</span>{!FLAGS.stage3 && <span className="soon">준비중</span>}</a>
          <a onClick={() => { setFav(true); go("home"); }}>★ {favs.count}</a>
          {remoteEnabled && (
            <a className={view === "account" || view === "admin" ? "active" : ""} onClick={() => go("account")}>
              👤 <span className="navlbl">{session ? (profile?.display_name || "내 계정") : "로그인"}</span>
              {isAdmin && <span className="soon" style={{ background: "var(--teal-tint)", color: "var(--teal)" }}>admin</span>}
            </a>
          )}
          <button className="theme-btn" onClick={theme.toggle} aria-label="테마">◐</button>
        </nav>
      </div></header>

      {view === "partners" ? <Partners />
        : view === "exchange" ? <Exchange />
        : view === "detail" ? <PlatformDetail id={detailId} />
        : view === "search" ? <SearchResults initialQ={searchQ} />
        : view === "compare" ? <Compare />
        : view === "onboarding" ? <Onboarding />
        : view === "account" ? <Account />
        : view === "submit" ? <Submit />
        : view === "admin" ? <Admin />
        : (
        <main className="container">
          <section className="hero">
            <div className="eyebrow">SEMOPL · 세상의 모든 플랫폼</div>
            <h1>어떤 분야에 어떤 플랫폼이 있을까?</h1>
            <p className="sub">사업자가 나가서 붙을 수 있는 플랫폼을 <b>같은 기준으로</b> 정리했습니다. 이름과 개략 설명을 빠르게 훑고, ★로 저장하세요.</p>
            <div className="search">
              <span className="ico">⌕</span>
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="플랫폼·분야 검색 (예: 쿠팡, 크라우드펀딩, 수출)"
                onKeyDown={(e) => { if (e.key === "Enter" && q.trim()) go("search", { q }); }} />
            </div>
            <div className="toolbar">
              <select className="select" value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
                <option value="default">기본 정렬</option><option value="new">신규 우선</option><option value="name">가나다</option>
              </select>
              <button className={`btn ghost ${onlyNew ? "on" : ""}`} onClick={() => setOnlyNew((v) => !v)}>🆕 신규만</button>
              <button className={`btn ghost ${fav ? "on" : ""}`} onClick={() => setFav((v) => !v)}>★ 내 즐겨찾기</button>
              <button className="btn ghost" onClick={() => go("onboarding")}>✨ 추천받기</button>
              {group && <button className="btn ghost" onClick={() => setGroup("")}>✕ {groups.find((g) => g.id === group)?.name}</button>}
              {remoteEnabled
                ? <button className="btn primary" onClick={() => go("submit")}>+ 플랫폼 제보</button>
                : <a className="btn primary" href={REPORT_URL} target="_blank" rel="noopener noreferrer">+ 플랫폼 제보</a>}
            </div>
            <div className="stats">
              <StatTile n={platforms.length.toLocaleString()} l="플랫폼" tone="b" />
              <StatTile n={String(categories.length)} l="분야" />
              <StatTile n={String(newCount)} l="신규" tone="t" />
            </div>
          </section>

          {flatMode ? (
            <>
              <div className="result-meta">{fav ? "내 즐겨찾기" : onlyNew ? "신규 플랫폼" : `"${q}" 검색결과`} · {flatResults.length}개{flatResults.length >= 200 ? " (상위 200)" : ""}</div>
              {flatResults.length === 0
                ? <div className="empty">{fav ? "아직 즐겨찾기한 플랫폼이 없어요. 카드의 ☆를 눌러 저장하세요." : "결과가 없습니다."}</div>
                : <div className="card-grid">{flatResults.map((p) => <PlatformCard key={p.id} p={p} />)}</div>}
            </>
          ) : (
            <>
              {newPlatforms.length > 0 && (<>
                <div className="sec-title">🆕 새로 나온 플랫폼</div>
                <div className="hstrip">{newPlatforms.map((p) => <PlatformCard key={p.id} p={p} />)}</div>
              </>)}
              <div className="sec-title">분야 한눈에 보기</div>
              <div className="groups">
                {groups.map((g) => {
                  const cats = categoriesByGroup(g.id);
                  const cnt = cats.reduce((s, c) => s + countByCategory(c.id), 0);
                  return (
                    <button className="gcard" key={g.id} onClick={() => { setGroup(g.id); window.scrollTo({ top: 420, behavior: "smooth" }); }}>
                      <div className="g-ic">{g.icon}</div><h4>{g.name}</h4>
                      <div className="g-meta">{cats.length} 분야 · {cnt.toLocaleString()} 플랫폼</div>
                      <div className="g-cats">{cats.slice(0, 5).map((c) => c.name).join(" · ")}{cats.length > 5 ? " …" : ""}</div>
                    </button>
                  );
                })}
              </div>
              <div className="sec-title">디렉토리</div>
              {shownGroups.map((g) => (
                <div key={g.id} style={{ marginBottom: 24 }}>
                  <h3 style={{ fontSize: 16, margin: "18px 0 10px" }}>{g.icon} {g.name}</h3>
                  {categoriesByGroup(g.id).map((c) => {
                    const isOpen = open.has(c.id);
                    return (
                      <div className={`acc ${isOpen ? "open" : ""}`} key={c.id}>
                        <button className="acc-h" onClick={() => toggleCat(c.id)}>
                          <span className="ic">{c.icon}</span><span className="nm">{c.name}</span>
                          <span className="ct">{countByCategory(c.id)}</span><span className="chev">▸</span>
                        </button>
                        {isOpen && <div className="acc-b"><div className="card-grid">{platforms.filter((p) => p.category === c.id).map((p) => <PlatformCard key={p.id} p={p} showCat={false} />)}</div></div>}
                      </div>
                    );
                  })}
                </div>
              ))}
            </>
          )}
        </main>
      )}

      {cmp.count > 0 && view !== "compare" && (
        <div className="container"><div className="cmp-bar">
          <span className="mono" style={{ color: "var(--brand-soft)" }}>비교 {cmp.count}/4</span>
          <span className="names">{cmpNames}</span>
          <button className="btn ghost sm" onClick={() => cmp.clear()}>비우기</button>
          <button className="btn primary sm" onClick={() => go("compare")}>비교하기 →</button>
        </div></div>
      )}
      <Footer />
    </NavContext.Provider>
  );
}
