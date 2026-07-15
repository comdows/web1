/* 소식·트렌드 피드(H-5) — platform_news(0027)를 상세·알림에만 가두지 않고 전용 피드로 승격.
 * 등재 플랫폼 관련 외부 기사를 최신순으로 모아 재방문 루프·유입을 만든다. 분야 필터 지원.
 * 원격 미연결/미시드 시 안내(정적 데이터엔 소식이 없음 — 수집 봇이 서버에 채움). */
import { useEffect, useMemo, useState } from "react";
import { listRecentPlatformNews, remoteEnabled } from "./lib/api";
import type { PlatformNews } from "./lib/api";
import { categories, categoryById } from "./data";
import { usePlatformIndex } from "./lib/platforms";
import { ReportButton, ShareButton } from "./components";
import { useNav } from "./nav";

type NewsRow = PlatformNews & { platform_id: string; created_at: string };

export function News() {
  const go = useNav();
  const idx = usePlatformIndex();
  const [rows, setRows] = useState<NewsRow[] | null>(null);
  const [cat, setCat] = useState("");

  useEffect(() => {
    if (!remoteEnabled) { setRows([]); return; }
    let alive = true;
    listRecentPlatformNews().then((r) => { if (alive) setRows(r); }).catch(() => { if (alive) setRows([]); });
    return () => { alive = false; };
  }, []);

  // 소식이 실제로 있는 분야만 필터 칩으로(빈 분야 노출 방지)
  const catsWithNews = useMemo(() => {
    if (!rows) return [];
    const ids = new Set<string>();
    for (const n of rows) { const p = idx.get(n.platform_id); if (p) ids.add(p.category); }
    return categories.filter((c) => ids.has(c.id));
  }, [rows, idx]);

  const shown = useMemo(() => {
    if (!rows) return [];
    return rows.filter((n) => { if (!cat) return true; const p = idx.get(n.platform_id); return p?.category === cat; });
  }, [rows, cat, idx]);

  return (
    <main className="page container">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <h1 style={{ margin: 0 }}>📰 소식·트렌드</h1>
        <ShareButton title="세모플 — 플랫폼·AI 도구 소식" />
      </div>
      <p className="lead" style={{ maxWidth: 680 }}>
        세모플에 등재된 플랫폼·AI 도구의 최근 소식을 한곳에 모았어요. 관심 분야의 변화를 놓치지 마세요 —
        각 항목은 외부 매체 기사 링크이며, 도구 상세로 이동하면 더 많은 소식과 정보를 볼 수 있습니다.
      </p>

      {catsWithNews.length > 1 && (
        <div className="chips-row" style={{ marginBottom: 14 }}>
          <button className={`fchip ${cat === "" ? "on" : ""}`} onClick={() => setCat("")}>전체</button>
          {catsWithNews.map((c) => (
            <button key={c.id} className={`fchip ${cat === c.id ? "on" : ""}`} onClick={() => setCat(c.id)}>{c.icon} {c.name}</button>
          ))}
        </div>
      )}

      {rows === null ? (
        <div className="empty">소식을 불러오는 중…</div>
      ) : shown.length === 0 ? (
        <div className="empty">
          {remoteEnabled ? "아직 등록된 소식이 없어요. 주간 수집기가 등재 플랫폼 관련 기사를 모아 여기에 채웁니다." : "소식 피드는 서버 연결 시 표시됩니다."}
          <div style={{ marginTop: 10 }}><button className="btn ghost sm" onClick={() => go("home")}>← 디렉토리로</button></div>
        </div>
      ) : (
        <>
          <div className="sub-list">
            {shown.map((n) => {
              const p = idx.get(n.platform_id);
              const c = p ? categoryById(p.category) : null;
              return (
                <div className="sub-item" key={n.url}>
                  <div style={{ minWidth: 0 }}>
                    <a href={n.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 14 }}
                      onClick={() => { /* 외부 매체 링크 — 계측 없이 그대로 이동 */ }}>{n.title} ↗</a>
                    <div className="frm-note">
                      {p ? <><button className="linklike" onClick={() => go("detail", { id: p.id })}>{p.name}</button>{c ? ` · ${c.name}` : ""}</> : n.platform_id}
                      {n.source ? ` · ${n.source}` : ""}{n.published_at ? ` · ${n.published_at.slice(0, 10)}` : ""}
                    </div>
                  </div>
                  <span style={{ flexShrink: 0 }}><ReportButton targetType="platform_news" targetId={String(n.id)} /></span>
                </div>
              );
            })}
          </div>
          <p className="sub faint" style={{ fontSize: 12, marginTop: 8 }}>
            외부 매체 기사 링크입니다 — 내용은 각 매체 책임이며 세모플의 평가·추천이 아닙니다.
          </p>
        </>
      )}
    </main>
  );
}
