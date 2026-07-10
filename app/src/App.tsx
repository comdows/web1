import { lazy, Suspense, useEffect, useMemo, useState, useCallback } from "react";
import type { ReactNode, KeyboardEvent } from "react";
import { groups, categories, categoriesByGroup, categoryById } from "./data";
import type { Platform } from "./data";
import { Logo, PlatformCard, Footer } from "./components";
import { GroupIcon, IcSearch, IcBell, IcHandshake, IcExchange, IcSparkle } from "./icons";
import { usePlatforms, usePlatformStats, usePlatformIndex } from "./lib/platforms";
import { usePopularity } from "./lib/popularity";
import { pickRecommended } from "./lib/search";
import { consumeLastVisit, useFavs, useCompare, useInterests, useRecent } from "./lib/store";
import { FLAGS } from "./config";
import { NavContext } from "./nav";
import type { ViewName } from "./nav";
import { PlatformDetail, SearchResults, Compare, Onboarding } from "./discovery";
/* 코드 스플리팅 — 발견(홈·검색·상세)만 메인 청크에 두고 나머지 뷰는 지연 로드. */
const Partners   = lazy(() => import("./pages").then((m) => ({ default: m.Partners })));
const Exchange   = lazy(() => import("./pages").then((m) => ({ default: m.Exchange })));
const DealGuide  = lazy(() => import("./pages").then((m) => ({ default: m.DealGuide })));
const ValueCheck = lazy(() => import("./pages").then((m) => ({ default: m.ValueCheck })));
const Account    = lazy(() => import("./account").then((m) => ({ default: m.Account })));
const Submit     = lazy(() => import("./account").then((m) => ({ default: m.Submit })));
const Admin      = lazy(() => import("./admin").then((m) => ({ default: m.Admin })));
const AiFinder   = lazy(() => import("./ai").then((m) => ({ default: m.AiFinder })));
const Weekly     = lazy(() => import("./growth").then((m) => ({ default: m.Weekly })));
const Packs      = lazy(() => import("./growth").then((m) => ({ default: m.Packs })));
const Terms      = lazy(() => import("./legal").then((m) => ({ default: m.Terms })));
const Privacy    = lazy(() => import("./legal").then((m) => ({ default: m.Privacy })));
const Notifications = lazy(() => import("./notifications").then((m) => ({ default: m.Notifications })));
import { useSession } from "./lib/auth";
import { fetchRecentPlatforms, remoteEnabled, rest, trackEvent, unreadNotifCount } from "./lib/api";

const REPORT_URL = "https://github.com/comdows/web1/issues/new?title=" + encodeURIComponent("[플랫폼 제보]");
/* 인기 데이터가 비어 있을 때 "이번 주 많이 찾은"의 대표 폴백(잘 알려진 국내외 대표군) */
const FEATURED_FALLBACK = ["smartstore", "coupang", "kmong", "wadiz", "11st", "tumblbug", "amazongs", "navershopl"];

function readParams() {
  const p = new URLSearchParams(location.search);
  // SEO 프리렌더 경로 진입: /p/<id> → 상세, /c/<분야> → 검색(분야 필터)
  const pre = location.pathname.match(/\/p\/([a-z0-9-]+)\/?$/);
  const cpre = location.pathname.match(/\/c\/([a-z0-9_-]+)\/?$/);
  return {
    view: pre ? ("detail" as ViewName) : cpre ? ("search" as ViewName) : (p.get("view") as ViewName) || "home",
    id: pre ? pre[1] : p.get("id") || "",
    q: p.get("q") || "",
    fav: p.get("fav") === "1",
  };
}

/* 접근성 있는 헤더 내비 항목 */
function NavItem({ active, onClick, label, children }: { active?: boolean; onClick: () => void; label: string; children: ReactNode }) {
  const key = (e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } };
  return (
    <a className={active ? "active" : ""} role="button" tabIndex={0} aria-label={label} onClick={onClick} onKeyDown={key}>
      {children}
    </a>
  );
}
function useTheme() {
  // 1a 채택안은 라이트 기본 — 저장된 선호가 있으면 존중
  const [theme, setTheme] = useState<string>(() => { try { return localStorage.getItem("sm.theme") || "light"; } catch { return "light"; } });
  useEffect(() => { document.documentElement.setAttribute("data-theme", theme); try { localStorage.setItem("sm.theme", theme); } catch { /* noop */ } }, [theme]);
  return { toggle: () => setTheme((t) => (t === "dark" ? "light" : "dark")) };
}

const VIEW_TITLES: Partial<Record<ViewName, string>> = {
  search: "검색", partners: "제휴 매칭", exchange: "플랫폼 거래소", compare: "비교",
  onboarding: "맞춤 추천", account: "계정", submit: "플랫폼 제보", admin: "관리 콘솔",
  terms: "이용약관", privacy: "개인정보처리방침", "deal-guide": "양수도 가이드", "value-check": "가치 자가 진단",
  "ai-finder": "AI 도구 찾기", weekly: "새로 나온 플랫폼·AI", packs: "업종별 시작 조합",
};

export default function App() {
  const init = readParams();
  const [view, setView] = useState<ViewName>(init.view);
  const [detailId, setDetailId] = useState(init.id);
  const [pricingNotice, setPricingNotice] = useState<string | null>(null); // 유료화 30일 공지(0011 app_settings)
  useEffect(() => {
    if (!remoteEnabled) return;
    rest<{ value: string | null }[]>("app_settings?key=eq.pricing_announced_at&select=value")
      .then((rows) => { const v = rows[0]?.value; if (typeof v === "string" && v) setPricingNotice(v); })
      .catch(() => { /* 공지 없음 */ });
  }, []);
  const [searchQ, setSearchQ] = useState(init.q);
  // home-only state (1a: 히어로 검색은 검색 페이지로 보냄, fav는 ★ 보기)
  const [q, setQ] = useState(init.view === "home" ? init.q : "");
  const [fav, setFav] = useState(init.fav);
  const [expanded, setExpanded] = useState<Set<string>>(new Set()); // 분야별 "더 보기" 그룹
  const favs = useFavs();
  const cmp = useCompare();
  const theme = useTheme();
  const { session, profile, isAdmin } = useSession();
  const [unreadNotif, setUnreadNotif] = useState(0);
  useEffect(() => {
    if (!session) { setUnreadNotif(0); return; }
    unreadNotifCount().then(setUnreadNotif).catch(() => setUnreadNotif(0));
  }, [session, view]);
  const platforms = usePlatforms();
  const pop = usePopularity();
  const stats = usePlatformStats();
  const index = usePlatformIndex();

  const go = useCallback<(v: ViewName, params?: { id?: string; q?: string }) => void>((v, params) => {
    setView(v);
    if (params?.id !== undefined) setDetailId(params.id);
    if (params?.q !== undefined) setSearchQ(params.q);
    const sp = new URLSearchParams();
    if (v !== "home") sp.set("view", v);
    if (v === "detail" && params?.id) sp.set("id", params.id);
    if (v === "search" && params?.q) sp.set("q", params.q);
    history.pushState(null, "", import.meta.env.BASE_URL + (sp.toString() ? `?${sp}` : ""));
    window.scrollTo(0, 0);
  }, []);

  /* 분야 카드 → 검색 뷰(해당 분야 필터) — SearchResults가 URL cats 파라미터를 읽는다 */
  const goCat = useCallback((catId: string) => {
    history.pushState(null, "", import.meta.env.BASE_URL + "?view=search&cats=" + encodeURIComponent(catId));
    setSearchQ("");
    setView("search");
    window.scrollTo(0, 0);
  }, []);

  useEffect(() => {
    const onPop = () => { const p = readParams(); setView(p.view); setDetailId(p.id); setSearchQ(p.q); setFav(p.fav); };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // 탭 타이틀 동기화
  useEffect(() => {
    if (view === "detail") return;
    const pathCat = location.pathname.match(/\/c\/([a-z0-9_-]+)\/?$/)?.[1];
    const catName = pathCat ? categoryById(pathCat)?.name : undefined;
    document.title = catName ? `${catName} 플랫폼 — 세모플`
      : VIEW_TITLES[view] ? `${VIEW_TITLES[view]} — 세모플` : "세모플 — 세상의 모든 플랫폼";
  }, [view]);

  // 홈 상태 → URL(q·fav만)
  useEffect(() => {
    if (view !== "home") return;
    const p = new URLSearchParams();
    if (q) p.set("q", q); if (fav) p.set("fav", "1");
    history.replaceState(null, "", p.toString() ? `?${p}` : location.pathname);
  }, [view, q, fav]);

  const submitSearch = () => { if (q.trim()) { trackEvent("search", undefined, q.trim()); go("search", { q: q.trim() }); } };

  /* 이번 주 많이 찾은 플랫폼 — 인기 집계(0019) 상위, 데이터 없으면 대표 폴백+신규로 채움 */
  const popular = useMemo(() => {
    const ranked = pop.size
      ? [...platforms].filter((p) => (pop.get(p.id) ?? 0) > 0).sort((a, b) => (pop.get(b.id) ?? 0) - (pop.get(a.id) ?? 0))
      : [];
    const picked: Platform[] = ranked.slice(0, 8);
    if (picked.length < 8) {
      const have = new Set(picked.map((p) => p.id));
      for (const id of FEATURED_FALLBACK) {
        if (picked.length >= 8) break;
        const p = index.get(id); if (p && !have.has(p.id)) { picked.push(p); have.add(p.id); }
      }
      for (const p of platforms) {
        if (picked.length >= 8) break;
        if (p.new && !have.has(p.id)) { picked.push(p); have.add(p.id); }
      }
    }
    return picked;
  }, [platforms, pop, index]);

  const aiCount = useMemo(() => platforms.filter((p) => p.category.startsWith("ai_")).length, [platforms]);
  const favPlatforms = useMemo(() => {
    const set = new Set(favs.all());
    return platforms.filter((p) => set.has(p.id));
  }, [favs, platforms]);

  const cmpNames = cmp.all().map((id) => index.get(id)?.name).filter(Boolean).join(", ");

  // ★ 저장 넛지
  const [nudgeClosed, setNudgeClosed] = useState<boolean>(() => { try { return !!localStorage.getItem("sm.nudge.fav.v1"); } catch { return true; } });
  const showNudge = remoteEnabled && !session && favs.count >= 2 && !nudgeClosed && cmp.count === 0 && view !== "account";
  const closeNudge = () => { try { localStorage.setItem("sm.nudge.fav.v1", "1"); } catch { /* noop */ } setNudgeClosed(true); };

  // 🕘 최근 본 / ✨ 관심 분야 / 재방문 델타
  const recentIds = useRecent();
  const recentPlatforms = useMemo(() => recentIds.map((x) => index.get(x)).filter(Boolean).slice(0, 12) as Platform[], [recentIds, index]);
  const interests = useInterests();
  const interestRecs = useMemo(
    () => interests ? pickRecommended(platforms, interests.groups, interests.cats, interests.newPref, 12, pop) : [],
    [interests, platforms, pop]
  );
  const [sinceCount, setSinceCount] = useState(0);
  useEffect(() => {
    const last = consumeLastVisit();
    if (!last || !remoteEnabled) return;
    fetchRecentPlatforms(60).then((rows) => setSinceCount(rows.filter((r) => r.created && r.created > last).length)).catch(() => { /* noop */ });
  }, []);

  /* 의도 칩 → 그룹 섹션 스크롤 / AI 파인더 */
  const scrollToGroup = (gid: string) => {
    const el = document.getElementById(`g-${gid}`);
    if (el) window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 80, behavior: "smooth" });
  };
  const toggleExpand = (gid: string) => setExpanded((prev) => { const n = new Set(prev); if (n.has(gid)) n.delete(gid); else n.add(gid); return n; });

  return (
    <NavContext.Provider value={go}>
      <header className="site-header"><div className="container inner">
        <NavItem onClick={() => { setFav(false); go("home"); }} label="홈"><Logo /></NavItem>
        <nav>
          <NavItem active={view === "home" || view === "search"} onClick={() => { setFav(false); go("home"); }} label="플랫폼 찾기">플랫폼 찾기</NavItem>
          <NavItem active={view === "partners"} onClick={() => go("partners")} label="제휴 매칭">제휴 매칭{!FLAGS.stage2 && <span className="soon">준비중</span>}</NavItem>
          <NavItem active={view === "exchange"} onClick={() => go("exchange")} label="거래소">거래소{!FLAGS.stage3 && <span className="soon">준비중</span>}</NavItem>
          <NavItem active={view === "ai-finder"} onClick={() => go("ai-finder")} label="AI 도구">AI 도구</NavItem>
          <NavItem onClick={() => { setQ(""); setFav(true); go("home"); }} label={`즐겨찾기 ${favs.count}개`}>★ {favs.count}</NavItem>
        </nav>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 12, flexShrink: 0 }}>
          <a href={`${import.meta.env.BASE_URL}en/`} style={{ fontSize: 13.5, color: "var(--faint)" }}>English</a>
          {remoteEnabled && session && (
            <NavItem active={view === "notifications"} onClick={() => go("notifications")} label="알림">
              <span style={{ position: "relative", display: "inline-flex", color: "var(--muted)" }}><IcBell size={17} />
                {unreadNotif > 0 && <span className="notif-badge" style={{ position: "absolute", top: -7, right: -9, background: "var(--danger)", color: "#fff", fontSize: 10, lineHeight: "15px", minWidth: 15, height: 15, borderRadius: 8, padding: "0 4px", textAlign: "center", fontWeight: 700 }}>{unreadNotif > 9 ? "9+" : unreadNotif}</span>}
              </span>
            </NavItem>
          )}
          {remoteEnabled && (
            <button className="btn login" onClick={() => go("account")}>
              {session ? (profile?.display_name || "내 계정") : "로그인"}
              {isAdmin && <span className="soon" style={{ marginLeft: 4, color: "var(--teal)" }}>admin</span>}
            </button>
          )}
          <button className="theme-btn" onClick={theme.toggle} aria-label="테마 전환">◐</button>
        </div>
      </div></header>

      {pricingNotice && (
        <div className="container"><div className="banner" style={{ marginTop: 10 }}>
          📢 <b>유료화 사전 공지</b> — {pricingNotice.slice(0, 10)}부터 일부 제휴 서비스(스폰서·연결료·Pro)가 유료로 전환됩니다.
          진행 중인 제휴·소개는 무료로 마무리되며, 자세한 내용은 제휴 페이지 요금 안내를 확인하세요.
        </div></div>
      )}
      <Suspense fallback={<main className="container"><div className="empty" style={{ marginTop: 40 }}>불러오는 중…</div></main>}>
      {view === "partners" ? <Partners />
        : view === "exchange" ? <Exchange />
        : view === "deal-guide" ? <DealGuide />
        : view === "value-check" ? <ValueCheck />
        : view === "ai-finder" ? <AiFinder />
        : view === "weekly" ? <Weekly />
        : view === "packs" ? <Packs />
        : view === "detail" ? <PlatformDetail id={detailId} />
        : view === "search" ? <SearchResults initialQ={searchQ} />
        : view === "compare" ? <Compare />
        : view === "onboarding" ? <Onboarding />
        : view === "account" ? <Account />
        : view === "submit" ? <Submit />
        : view === "admin" ? <Admin />
        : view === "terms" ? <Terms />
        : view === "privacy" ? <Privacy />
        : view === "notifications" ? <Notifications />
        : (
        <main>
          {/* ── 1a 히어로: 검색 + 의도 칩 + 지표 스트립을 한 시각 단위로 ── */}
          <section className="hero">
            <div className="hero-in">
              <h1>어떤 분야에 어떤 플랫폼이 있을까?</h1>
              <p className="sub">입점·소싱·홍보·AI까지 — 사업에 필요한 플랫폼을 분야별로 찾아보세요.</p>
              <div className="search">
                <span className="ico" aria-hidden><IcSearch size={18} /></span>
                <input value={q} onChange={(e) => setQ(e.target.value)} aria-label="플랫폼·분야 검색"
                  placeholder="플랫폼 이름이나 분야를 검색해 보세요 — 예: 스마트스토어, 재능마켓"
                  onKeyDown={(e) => { if (e.key === "Enter") submitSearch(); }} />
                <button className="go" onClick={submitSearch}>검색</button>
              </div>
              <div className="intent-chips">
                <button className="ichip" onClick={() => scrollToGroup("commerce")}>입점하고 싶어요</button>
                <button className="ichip" onClick={() => scrollToGroup("trade")}>상품을 소싱해요</button>
                <button className="ichip" onClick={() => scrollToGroup("service")}>서비스를 알리고 싶어요</button>
                <button className="ichip" onClick={() => go("ai-finder")}>AI 도구를 찾아요</button>
              </div>
              {sinceCount > 0 && (
                <button className="fchip on" onClick={() => go("weekly")}>다녀간 사이 새 플랫폼·AI {sinceCount}개 →</button>
              )}
              <div className="stat-strip">
                <div className="cell"><span className="n">{stats.total.toLocaleString()}</span><span className="l">등록 플랫폼</span></div>
                <div className="cell"><span className="n">{categories.length}</span><span className="l">분야</span></div>
                <div className="cell"><span className="n">{aiCount.toLocaleString()}</span><span className="l">AI 도구</span></div>
              </div>
            </div>
          </section>

          {fav ? (
            /* ★ 즐겨찾기 보기 */
            <section className="home-sec"><div className="container">
              <div className="sec-title" style={{ marginTop: 0 }}>내 즐겨찾기 <span className="faint" style={{ fontSize: 14, fontWeight: 600 }}>{favPlatforms.length}개</span>
                <button className="linklike" style={{ marginLeft: "auto" }} onClick={() => setFav(false)}>홈으로 →</button></div>
              {favPlatforms.length === 0
                ? <div className="empty">아직 즐겨찾기한 플랫폼이 없어요. 카드의 ☆를 눌러 저장하세요.</div>
                : <div className="card-grid">{favPlatforms.map((p) => <PlatformCard key={p.id} p={p} />)}</div>}
            </div></section>
          ) : (
            <>
              {/* ── 1a 이번 주 많이 찾은 플랫폼 ── */}
              <section className="home-sec"><div className="container">
                <div className="sec-title" style={{ marginTop: 0 }}>이번 주 많이 찾은 플랫폼
                  <button className="sec-link" onClick={() => go("search")}>전체 보기 →</button></div>
                <div className="pop-grid">{popular.map((p) => <PlatformCard key={p.id} p={p} />)}</div>

                {recentPlatforms.length >= 2 && (<>
                  <div className="sec-title">최근 본 플랫폼</div>
                  <div className="hstrip">{recentPlatforms.map((p) => <PlatformCard key={p.id} p={p} />)}</div>
                </>)}
                {interestRecs.length > 0 && (<>
                  <div className="sec-title">내 관심 분야 추천
                    <button className="sec-link" onClick={() => go("onboarding")}>조건 다시 고르기 →</button></div>
                  <div className="hstrip">{interestRecs.map((p) => <PlatformCard key={p.id} p={p} />)}</div>
                </>)}
              </div></section>

              {/* ── 1a 분야별로 찾아보기: 그룹별 3열 카드 + 더 보기 ── */}
              <section className="home-sec alt"><div className="container">
                <div className="sec-title" style={{ marginTop: 0, marginBottom: 6 }}>분야별로 찾아보기
                  <button className="sec-link" onClick={() => go("packs")}>업종별 시작 조합 →</button></div>
                <p className="sec-sub" style={{ margin: "0 0 8px" }}>{categories.length}개 분야 · 그룹별 상위 분야만 먼저 보여드려요</p>
                {groups.map((g) => {
                  const cats = [...categoriesByGroup(g.id)].sort((a, b) => (stats.counts.get(b.id) ?? 0) - (stats.counts.get(a.id) ?? 0));
                  const isOpen = expanded.has(g.id);
                  const shown = isOpen ? cats : cats.slice(0, 5);
                  const rest = cats.length - 5;
                  const total = cats.reduce((s, c) => s + (stats.counts.get(c.id) ?? 0), 0);
                  return (
                    <div key={g.id} id={`g-${g.id}`} style={{ scrollMarginTop: 80 }}>
                      <div className="group-h">
                        <GroupIcon id={g.id} size={18} />
                        <h3>{g.name}</h3>
                        <span className="g-ct">{cats.length}개 분야 · {total.toLocaleString()}개</span>
                      </div>
                      <div className="cat-grid">
                        {shown.map((c) => (
                          <button className="ccard" key={c.id} onClick={() => goCat(c.id)}>
                            <span style={{ minWidth: 0 }}>
                              <span className="c-name">{c.name}</span>
                              <span className="c-desc" style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.desc}</span>
                            </span>
                            <span className="c-ct">{stats.counts.get(c.id) ?? 0}</span>
                          </button>
                        ))}
                        {rest > 0 && (
                          <button className="ccard more" onClick={() => toggleExpand(g.id)}>
                            <span>{isOpen ? "접기 ↑" : `+ ${rest}개 분야 더 보기`}</span>
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div></section>

              {/* ── 1a 도구 섹션: 찾는 걸로 끝나지 않아요 ── */}
              <section className="home-sec tools"><div className="container">
                <div className="sec-title" style={{ marginTop: 0 }}>찾는 걸로 끝나지 않아요</div>
                <div className="tool-grid">
                  <button className="tcard" onClick={() => go("partners")}>
                    <IcHandshake size={24} />
                    <span className="t-title">제휴 매칭</span>
                    <p>플랫폼과 사업자를 연결해 드립니다. 조건을 등록하면 맞는 파트너를 찾아드려요.</p>
                    <span className="t-cta">매칭 신청하기 →</span>
                  </button>
                  <button className="tcard" onClick={() => go("exchange")}>
                    <IcExchange size={24} />
                    <span className="t-title">플랫폼 거래소</span>
                    <p>운영 중인 스토어·계정·플랫폼을 안전하게 사고팔 수 있는 거래 공간.</p>
                    <span className="t-cta">거래소 둘러보기 →</span>
                  </button>
                  <button className="tcard" onClick={() => go("ai-finder")}>
                    <IcSparkle size={24} />
                    <span className="t-title">AI로 찾기</span>
                    <p>"수공예품을 해외에 팔고 싶어요"처럼 상황을 고르면 맞는 도구 조합을 추천해요.</p>
                    <span className="t-cta">AI에게 물어보기 →</span>
                  </button>
                </div>
                <div style={{ marginTop: 16, fontSize: 13, color: "var(--faint)" }}>
                  찾는 플랫폼이 없나요?{" "}
                  {remoteEnabled
                    ? <button className="linklike" onClick={() => go("submit")}>+ 플랫폼 제보하기</button>
                    : <a className="linklike" href={REPORT_URL} target="_blank" rel="noopener noreferrer">+ 플랫폼 제보하기</a>}
                </div>
              </div></section>
            </>
          )}
        </main>
      )}
      </Suspense>

      {showNudge && (
        <div className="container"><div className="cmp-bar">
          <span>★ {favs.count}개 저장됨 — 지금은 이 브라우저에만 있어요.</span>
          <button className="btn primary sm" onClick={() => go("account")}>가입하고 계정에 지키기 →</button>
          <button className="btn ghost sm" onClick={closeNudge}>닫기</button>
        </div></div>
      )}
      {cmp.count > 0 && view !== "compare" && (
        <div className="container"><div className="cmp-bar">
          <span style={{ color: "var(--brand)", fontWeight: 700, fontSize: 13 }}>비교 {cmp.count}/4</span>
          <span className="names">{cmpNames}</span>
          <button className="btn ghost sm" onClick={() => cmp.clear()}>비우기</button>
          <button className="btn primary sm" onClick={() => go("compare")}>비교하기 →</button>
        </div></div>
      )}
      <Footer />
    </NavContext.Provider>
  );
}
