import { useEffect, useMemo, useState, useCallback } from "react";
import type { ReactNode, KeyboardEvent } from "react";
import { groups, categories, categoriesByGroup, categoryById } from "./data";
import type { Platform } from "./data";
import { Logo, LogoMark, StatTile, PlatformCard, Footer } from "./components";
import { usePlatforms, usePlatformStats, usePlatformIndex } from "./lib/platforms";
import { sortByRelevance } from "./lib/search";
import { useFavs, useCompare } from "./lib/store";
import { FLAGS } from "./config";
import { Partners, Exchange } from "./pages";
import { NavContext } from "./nav";
import type { ViewName } from "./nav";
import { PlatformDetail, SearchResults, Compare, Onboarding } from "./discovery";
import { Account, Submit } from "./account";
import { Admin } from "./admin";
import { Terms, Privacy } from "./legal";
import { useSession } from "./lib/auth";
import { remoteEnabled, trackEvent } from "./lib/api";

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

function sortPlatforms(list: Platform[], sort: Sort): Platform[] {
  if (sort === "new") return [...list].sort((a, b) => (b.new ? 1 : 0) - (a.new ? 1 : 0));
  if (sort === "name") return [...list].sort((a, b) => a.name.localeCompare(b.name, "ko"));
  return list;
}
/* 접근성 있는 헤더 내비 항목 — role/tabIndex/키보드로 마우스 없이도 이동 가능,
   모바일에선 라벨이 숨겨지므로 aria-label로 스크린리더 대응 */
function NavItem({ active, onClick, label, children }: { active?: boolean; onClick: () => void; label: string; children: ReactNode }) {
  const key = (e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } };
  return (
    <a className={active ? "active" : ""} role="button" tabIndex={0} aria-label={label} onClick={onClick} onKeyDown={key}>
      {children}
    </a>
  );
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
  const platforms = usePlatforms();
  const stats = usePlatformStats();
  const index = usePlatformIndex();
  const searchIndex = useMemo(
    () => platforms.map((p) => ({ p, hay: (p.name + " " + p.blurb + " " + (categoryById(p.category)?.name ?? "")).toLowerCase() })),
    [platforms]
  );

  const go = useCallback<(v: ViewName, params?: { id?: string; q?: string }) => void>((v, params) => {
    setView(v);
    const titles: Partial<Record<ViewName, string>> = {
      search: "검색", partners: "제휴 매칭", exchange: "플랫폼 거래소", compare: "비교",
      onboarding: "맞춤 추천", account: "계정", submit: "플랫폼 제보", admin: "관리 콘솔",
      terms: "이용약관", privacy: "개인정보처리방침",
    };
    document.title = titles[v] ? `${titles[v]} — 세모플` : "세모플 — 세상의 모든 플랫폼";
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
    if (sort === "default" && query) list = sortByRelevance(list, query);
    else list = sortPlatforms(list, sort);
    return list.slice(0, 200);
  }, [flatMode, query, fav, onlyNew, sort, favs, platforms, searchIndex]);
  const newPlatforms = useMemo(() => platforms.filter((p) => p.new).slice(0, 24), [platforms]);
  const shownGroups = group ? groups.filter((g) => g.id === group) : groups;

  const cmpNames = cmp.all().map((id) => index.get(id)?.name).filter(Boolean).join(", ");

  return (
    <NavContext.Provider value={go}>
      <header className="site-header"><div className="container inner">
        <NavItem onClick={() => go("home")} label="홈"><Logo /></NavItem>
        <nav>
          <NavItem active={view === "home"} onClick={() => go("home")} label="분야별">📂 <span className="navlbl">분야별</span></NavItem>
          <NavItem active={view === "search"} onClick={() => go("search")} label="검색">🔎 <span className="navlbl">검색</span></NavItem>
          <NavItem active={view === "onboarding"} onClick={() => go("onboarding")} label="추천">✨ <span className="navlbl">추천</span></NavItem>
          <NavItem active={view === "partners"} onClick={() => go("partners")} label="제휴">🤝 <span className="navlbl">제휴</span>{!FLAGS.stage2 && <span className="soon">준비중</span>}</NavItem>
          <NavItem active={view === "exchange"} onClick={() => go("exchange")} label="거래소">🏦 <span className="navlbl">거래소</span>{!FLAGS.stage3 && <span className="soon">준비중</span>}</NavItem>
          <NavItem onClick={() => { setFav(true); go("home"); }} label={`즐겨찾기 ${favs.count}개`}>★ {favs.count}</NavItem>
          {remoteEnabled && (
            <NavItem active={view === "account" || view === "admin"} onClick={() => go("account")} label={session ? "내 계정" : "로그인"}>
              👤 <span className="navlbl">{session ? (profile?.display_name || "내 계정") : "로그인"}</span>
              {isAdmin && <span className="soon" style={{ background: "var(--teal-tint)", color: "var(--teal)" }}>admin</span>}
            </NavItem>
          )}
          <button className="theme-btn" onClick={theme.toggle} aria-label="테마 전환">◐</button>
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
        : view === "terms" ? <Terms />
        : view === "privacy" ? <Privacy />
        : (
        <main className="container">
          <section className="hero">
            <div className="hero-bp" aria-hidden><LogoMark size={300} /></div>
            <div className="eyebrow">SEMOPL · 세상의 모든 플랫폼</div>
            <h1>어떤 분야에 어떤 플랫폼이 있을까?</h1>
            <p className="sub">사업자가 나가서 붙을 수 있는 플랫폼을 <b>같은 기준으로</b> 정리했습니다. 이름과 개략 설명을 빠르게 훑고, ★로 저장하세요.</p>
            <div className="search">
              <button type="button" className="ico" aria-label="검색" onClick={() => { if (q.trim()) { trackEvent("search", undefined, q.trim()); go("search", { q }); } }}>⌕</button>
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="플랫폼·분야 검색 (예: 쿠팡, 크라우드펀딩, 수출)"
                onKeyDown={(e) => { if (e.key === "Enter" && q.trim()) { trackEvent("search", undefined, q.trim()); go("search", { q }); } }} />
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
              <StatTile n={stats.total.toLocaleString()} l="플랫폼" tone="b" />
              <StatTile n={String(categories.length)} l="분야" />
              <StatTile n={String(stats.newCount)} l="신규" tone="t" />
            </div>
          </section>

          {/* 2·3단계 진입점 — 헤더 아이콘 외에 홈 본문에서 처음 노출 */}
          <div className="promo-grid">
            <button className="gcard promo" onClick={() => go("partners")}>
              <div className="g-ic">🤝</div><h4>제휴 매칭 <span className="badge good">오픈</span></h4>
              <div className="g-cats">배너 교환·회원 상호송출·레퍼럴 — 22가지 방식으로 다른 플랫폼과 함께 크세요. 무료 베타.</div>
              <div className="g-meta" style={{ marginTop: 8 }}>제안 등록 → 검수 게시 → 세모플이 소개</div>
            </button>
            <button className="gcard promo" onClick={() => go("exchange")}>
              <div className="g-ic">🏦</div><h4>플랫폼 거래소 <span className="badge good">오픈</span></h4>
              <div className="g-cats">운영하던 플랫폼의 매각·인수를 익명 리스팅으로. 코드명 게시, 쌍방 동의 시에만 소개.</div>
              <div className="g-meta" style={{ marginTop: 8 }}>매각 접수(비공개) · 인수 브리프</div>
            </button>
          </div>

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
                  const cnt = cats.reduce((s, c) => s + (stats.counts.get(c.id) ?? 0), 0);
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
                          <span className="ct">{stats.counts.get(c.id) ?? 0}</span><span className="chev">▸</span>
                        </button>
                        {isOpen && (
                          <div className="acc-b">
                            {(stats.counts.get(c.id) ?? 0) === 0
                              ? <div className="empty">이 분야는 아직 비어 있어요. <button className="linklike" onClick={() => go("submit")}>+ 첫 플랫폼 제보하기</button></div>
                              : <div className="card-grid">{platforms.filter((p) => p.category === c.id).map((p) => <PlatformCard key={p.id} p={p} showCat={false} />)}</div>}
                          </div>
                        )}
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
