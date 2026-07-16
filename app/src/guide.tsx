/* 편집 가이드 뷰(로드맵 v2 Phase 4) — /guide/<slug>/ 정적 페이지의 SPA 짝.
 * articles.ko.json(레포 내 편집 데이터 — hub-intros 사상)을 렌더. 이 컴포넌트는 lazy 로드라
 * 가이드 본문이 부트 번들에 실리지 않는다(vite data 청크에서 articles 제외). 디렉토리 중립:
 * 비교 축 서술 + 고지문 — 특정 플랫폼 유료 추천 없음. */
import { useEffect } from "react";
import articlesData from "./data/articles.ko.json";
import { categoryById } from "./data";
import { PlatformCard, ShareButton } from "./components";
import { useNav } from "./nav";
import { usePlatformIndex } from "./lib/platforms";

interface Article {
  title: string; desc: string; category: string; date: string;
  sections: { h: string; b: string }[]; related?: string[];
}
const ARTICLES = articlesData as Record<string, Article>;

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
            <button className="btn ghost sm" onClick={() => go("news")}>소식·트렌드로 →</button>
          </div>
        </div>
        {Object.keys(ARTICLES).length > 0 && (
          <>
            <div className="sec-title">전체 가이드</div>
            <div className="sub-list">
              {Object.entries(ARTICLES).map(([s, art]) => (
                <div className="sub-item" key={s}>
                  <div style={{ minWidth: 0 }}>
                    <a href={`${import.meta.env.BASE_URL}guide/${s}/`} style={{ fontSize: 14 }}>{art.title}</a>
                    <div className="frm-note">{art.desc}</div>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </main>
    );
  }

  const cat = categoryById(a.category);
  const related = (a.related ?? []).map((id) => idx.get(id)).filter((p): p is NonNullable<typeof p> => !!p);

  return (
    <main className="page container" style={{ maxWidth: 760 }}>
      <p className="sub" style={{ marginBottom: 4 }}>
        <a href={`${import.meta.env.BASE_URL}c/${a.category}/`}>{cat?.icon} {cat?.name}</a> · {a.date} · 세모플 가이드
      </p>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <h1 style={{ marginTop: 0 }}>{a.title}</h1>
        <ShareButton title={`${a.title} | 세모플`} />
      </div>
      <p className="lead">{a.desc}</p>
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
      <p className="sub faint" style={{ fontSize: 12.5 }}>
        이 가이드는 공개 정보를 바탕으로 한 일반적 안내이며 특정 플랫폼의 공식 조건·추천이 아닙니다.
        요율·정책은 수시로 바뀌므로 실제 조건은 각 공식 사이트에서 확인하세요.
      </p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
        <a className="btn ghost sm" href={`${import.meta.env.BASE_URL}c/${a.category}/`}>{cat?.name} 플랫폼 전체 →</a>
        <button className="btn ghost sm" onClick={() => go("news")}>소식·트렌드 →</button>
      </div>
    </main>
  );
}
