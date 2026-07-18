/* 편집 가이드 + 도움말 뷰(/guide/<slug>/ 정적 페이지의 SPA 짝) — articles.ko.json 렌더.
 * kind:"help"(G3 도움말 센터)는 분야 무소속: 분야 링크 대신 도움말 허브로 연결하고,
 * 해당 화면 투어 딥링크(도움말→직접 보기)를 제공한다. lazy 청크라 부트 번들 무영향. */
import { useEffect } from "react";
import articlesData from "./data/articles.ko.json";
import { categoryById } from "./data";
import { PlatformCard, ShareButton } from "./components";
import { useNav } from "./nav";
import type { ViewName } from "./nav";
import { usePlatformIndex } from "./lib/platforms";
import { startTour, HOME_TOUR, SEARCH_TOUR, ACCOUNT_TOUR, type TourStep } from "./lib/tour";

interface Article {
  kind?: string;               // "help" = 이용 도움말(분야 무소속) · 없으면 편집 가이드
  title: string; desc: string; category?: string; date: string;
  sections: { h: string; b: string }[]; related?: string[];
}
const ARTICLES = articlesData as Record<string, Article>;

/* 도움말 → "이 화면에서 직접 보기" 투어 딥링크(해당 화면으로 이동 후 강제 재실행) */
const HELP_TOURS: Record<string, { view: ViewName; id: string; steps: TourStep[]; label: string }> = {
  "help-search": { view: "search", id: "search", steps: SEARCH_TOUR, label: "검색 화면에서 직접 보기" },
  "help-profile": { view: "account", id: "account", steps: ACCOUNT_TOUR, label: "계정 화면에서 직접 보기" },
  "help-signup": { view: "home", id: "home", steps: HOME_TOUR, label: "홈 투어로 훑어보기" },
};

const helpEntries = () => Object.entries(ARTICLES).filter(([, a]) => a.kind === "help");
const guideEntries = () => Object.entries(ARTICLES).filter(([, a]) => a.kind !== "help");

/* 도움말 센터 허브(?view=help) — 이용 도움말 + 편집 가이드 + 문의 연결 */
export function HelpHub() {
  const go = useNav();
  useEffect(() => {
    document.title = "도움말 — 세모플";
    return () => { document.title = "세모플 — 세상의 모든 플랫폼"; };
  }, []);
  return (
    <main className="page container" style={{ maxWidth: 760 }}>
      <h1>❓ 도움말</h1>
      <p className="lead">회원가입부터 검색·비교, 제보, 제휴·거래까지 — 처음이라면 여기서 시작하세요.</p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 18 }}>
        <button className="btn primary sm" onClick={() => { go("home"); setTimeout(() => startTour("home", HOME_TOUR), 900); }}>▶ 30초 투어 시작</button>
        <button className="btn ghost sm" onClick={() => go("support")}>💬 FAQ·1:1 문의</button>
      </div>
      <div className="sec-title" style={{ marginTop: 0 }}>이용 도움말</div>
      <div className="sub-list">
        {helpEntries().map(([s, a]) => (
          <div className="sub-item" key={s}>
            <div style={{ minWidth: 0 }}>
              <a href={`${import.meta.env.BASE_URL}guide/${s}/`} style={{ fontSize: 14, fontWeight: 600 }}>{a.title}</a>
              <div className="frm-note">{a.desc}</div>
            </div>
          </div>
        ))}
      </div>
      <div className="sec-title">분야 가이드 <span className="faint" style={{ fontWeight: 400, fontSize: 13 }}>· 비교 축 중심 편집 콘텐츠</span></div>
      <div className="sub-list">
        {guideEntries().map(([s, a]) => (
          <div className="sub-item" key={s}>
            <div style={{ minWidth: 0 }}>
              <a href={`${import.meta.env.BASE_URL}guide/${s}/`} style={{ fontSize: 14 }}>{a.title}</a>
              <div className="frm-note">{a.desc}</div>
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}

export function Guide({ slug }: { slug?: string }) {
  const go = useNav();
  const idx = usePlatformIndex();
  const a = slug ? ARTICLES[slug] : undefined;

  useEffect(() => {
    if (a) document.title = `${a.title} | 세모플`;
    return () => { document.title = "세모플 — 세상의 모든 플랫폼"; };
  }, [a]);

  if (!a) {
    return (
      <main className="page container">
        <div className="empty">가이드를 찾을 수 없어요 — 주소가 바뀌었거나 삭제된 글입니다.
          <div style={{ marginTop: 10 }}>
            <button className="btn ghost sm" onClick={() => go("help")}>❓ 도움말 센터 →</button>
            <button className="btn ghost sm" onClick={() => go("news")} style={{ marginLeft: 6 }}>소식·트렌드 →</button>
          </div>
        </div>
      </main>
    );
  }

  const isHelp = a.kind === "help";
  const cat = a.category ? categoryById(a.category) : undefined;
  const related = (a.related ?? []).map((id) => idx.get(id)).filter((p): p is NonNullable<typeof p> => !!p);
  const tourLink = slug ? HELP_TOURS[slug] : undefined;

  return (
    <main className="page container" style={{ maxWidth: 760 }}>
      <p className="sub" style={{ marginBottom: 4 }}>
        {isHelp
          ? <a style={{ cursor: "pointer" }} onClick={() => go("help")}>❓ 도움말</a>
          : <a href={`${import.meta.env.BASE_URL}c/${a.category}/`}>{cat?.icon} {cat?.name}</a>}
        {" "}· {a.date} · 세모플 {isHelp ? "도움말" : "가이드"}
      </p>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <h1 style={{ marginTop: 0 }}>{a.title}</h1>
        <ShareButton title={`${a.title} | 세모플`} />
      </div>
      <p className="lead">{a.desc}</p>
      {tourLink && (
        <button className="btn primary sm" style={{ marginBottom: 14 }}
          onClick={() => { go(tourLink.view); setTimeout(() => startTour(tourLink.id, tourLink.steps), 900); }}>
          ▶ {tourLink.label} (하이라이트 안내)
        </button>
      )}
      {a.sections.map((s) => (
        <section key={s.h} style={{ marginBottom: 18 }}>
          <h2 style={{ fontSize: 19, marginBottom: 6 }}>{s.h}</h2>
          <p style={{ lineHeight: 1.75, color: "var(--muted)" }}>{s.b}</p>
        </section>
      ))}
      {related.length > 0 && (
        <>
          <div className="sec-title">이 글에서 함께 볼 플랫폼</div>
          <div className="card-grid" style={{ marginBottom: 14 }}>
            {related.map((p) => <PlatformCard key={p.id} p={p} />)}
          </div>
        </>
      )}
      {!isHelp && (
        <p className="sub faint" style={{ fontSize: 12.5 }}>
          이 가이드는 공개 정보를 바탕으로 한 일반적 안내이며 특정 플랫폼의 공식 조건·추천이 아닙니다.
          요율·정책은 수시로 바뀌므로 실제 조건은 각 공식 사이트에서 확인하세요.
        </p>
      )}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
        {isHelp ? (
          <>
            <button className="btn ghost sm" onClick={() => go("help")}>❓ 도움말 센터 →</button>
            <button className="btn ghost sm" onClick={() => go("support")}>💬 문의하기 →</button>
          </>
        ) : (
          <>
            <a className="btn ghost sm" href={`${import.meta.env.BASE_URL}c/${a.category}/`}>{cat?.name} 플랫폼 전체 →</a>
            <button className="btn ghost sm" onClick={() => go("news")}>소식·트렌드 →</button>
          </>
        )}
      </div>
    </main>
  );
}
