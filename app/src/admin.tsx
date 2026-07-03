/* P3 운영 화면 — 관리자 콘솔: 제보 검수 큐 · 라이프사이클 · 현황.
 * UI 노출은 편의일 뿐, 실제 권한은 RLS is_admin()이 DB에서 강제한다. */
import { useCallback, useEffect, useMemo, useState } from "react";
import { groups, categoriesByGroup, platforms as localPlatforms } from "./data";
import { Badge, StatTile } from "./components";
import { useNav } from "./nav";
import { useSession } from "./lib/auth";
import {
  createPlatform, getPendingCount, getPlatformLifecycle, getPopularSearches, getStats,
  LIFECYCLE_NEXT, listSubmissions, remoteEnabled, reviewSubmission, transitionPlatform,
} from "./lib/api";
import type { Lifecycle, Submission } from "./lib/api";

const LC_LABEL: Record<Lifecycle, string> = {
  soon: "등재 예정", review: "검토 중", verified: "검증됨", matched: "성사", rejected: "반려",
};

/* URL 호스트명 → id 슬러그 제안 (예: www.i-um.co.kr → i-um) */
function suggestId(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return host.split(".")[0].toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "") || "platform";
  } catch { return ""; }
}
/* 로컬 데이터 기준 중복 의심(이름·호스트 일치) — 검수 참고용 */
function dupCandidates(name: string, url: string): string[] {
  const n = name.trim().toLowerCase();
  let host = "";
  try { host = new URL(url).hostname.replace(/^www\./, ""); } catch { /* noop */ }
  return localPlatforms
    .filter((p) => p.name.toLowerCase() === n || (host && p.url.includes(host)))
    .map((p) => `${p.name} (${p.id})`).slice(0, 3);
}

/* ── 제보 검수 카드 ───────────────────────────────────────── */
function ReviewCard({ s, onDone }: { s: Submission; onDone: () => void }) {
  const [id, setId] = useState(() => suggestId(s.payload.url));
  const [cat, setCat] = useState(s.payload.category_id || "");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const dups = useMemo(() => dupCandidates(s.payload.name, s.payload.url), [s]);

  const act = async (fn: () => Promise<void>) => {
    setErr(""); setBusy(true);
    try { await fn(); onDone(); }
    catch (ex) { setErr(ex instanceof Error ? ex.message : String(ex)); }
    finally { setBusy(false); }
  };
  const approve = () => act(async () => {
    if (!id.trim() || !cat) throw new Error("id와 분야를 확인하세요");
    await createPlatform({
      id: id.trim(), name: s.payload.name, category_id: cat,
      region: s.payload.region, url: s.payload.url, blurb: s.payload.desc || "",
    });
    await reviewSubmission(s.id, { status: "approved", approved_platform_id: id.trim() });
  });

  return (
    <div className="admin-card">
      <div className="admin-card-h">
        <b>{s.payload.name}</b>
        <a href={s.payload.url} target="_blank" rel="noopener noreferrer" className="mono" style={{ fontSize: 12 }}>{s.payload.url} ↗</a>
        <Badge kind={s.status === "hold" ? "muted" : "soon"}>{s.status === "hold" ? "보류" : "대기"}</Badge>
        <span className="mono" style={{ color: "var(--faint)", fontSize: 11, marginLeft: "auto" }}>{s.created_at.slice(0, 10)}</span>
      </div>
      {s.payload.desc && <p style={{ margin: "6px 0", fontSize: 14, color: "var(--muted)" }}>{s.payload.desc}</p>}
      {dups.length > 0 && <div className="err" style={{ fontSize: 12 }}>⚠ 중복 의심: {dups.join(", ")}</div>}
      <div className="admin-form">
        <label>id <input value={id} onChange={(e) => setId(e.target.value)} placeholder="영문 슬러그" /></label>
        <label>분야
          <select value={cat} onChange={(e) => setCat(e.target.value)}>
            <option value="" disabled>선택</option>
            {groups.map((g) => (
              <optgroup key={g.id} label={g.name}>
                {categoriesByGroup(g.id).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </optgroup>
            ))}
          </select>
        </label>
        <label>반려/보류 사유 <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="반려·보류 시" /></label>
      </div>
      {err && <div className="err">{err}</div>}
      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <button className="btn primary sm" disabled={busy} onClick={approve}>✓ 승인·등재</button>
        {s.status !== "hold" && (
          <button className="btn ghost sm" disabled={busy}
            onClick={() => act(() => reviewSubmission(s.id, { status: "hold", review_reason: reason || undefined }))}>보류</button>
        )}
        <button className="btn ghost sm" disabled={busy}
          onClick={() => act(() => reviewSubmission(s.id, { status: "rejected", review_reason: reason || "기준 미충족" }))}>반려</button>
      </div>
    </div>
  );
}

/* ── 라이프사이클 패널 ────────────────────────────────────── */
function LifecyclePanel() {
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<{ id: string; name: string } | null>(null);
  const [lc, setLc] = useState<Lifecycle | null>(null);
  const [reason, setReason] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const cands = useMemo(() => {
    const n = q.trim().toLowerCase();
    if (!n) return [];
    return localPlatforms.filter((p) => p.name.toLowerCase().includes(n) || p.id.includes(n)).slice(0, 8);
  }, [q]);

  const pick = async (id: string, name: string) => {
    setPicked({ id, name }); setLc(null); setMsg("");
    try { const r = await getPlatformLifecycle(id); setLc(r?.lifecycle ?? null); }
    catch { setMsg("상태 조회 실패"); }
  };
  const move = async (to: Lifecycle) => {
    if (!picked || busy) return;
    setMsg(""); setBusy(true);
    try { await transitionPlatform(picked.id, to, reason); setLc(to); setReason(""); setMsg(`✓ ${LC_LABEL[to]}(으)로 전이됨 — 감사로그 기록`); }
    catch (ex) { setMsg(ex instanceof Error ? ex.message : String(ex)); }
    finally { setBusy(false); }
  };

  return (
    <div className="admin-card">
      <div className="admin-form" style={{ marginTop: 0 }}>
        <label style={{ flex: 1 }}>플랫폼 찾기
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="이름 또는 id" />
        </label>
      </div>
      {cands.length > 0 && !picked && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
          {cands.map((p) => <button key={p.id} className="fchip" onClick={() => pick(p.id, p.name)}>{p.name}</button>)}
        </div>
      )}
      {picked && (
        <div style={{ marginTop: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <b>{picked.name}</b>
            <span className="mono" style={{ fontSize: 12, color: "var(--faint)" }}>{picked.id}</span>
            {lc && <Badge kind={lc === "verified" ? "verify" : lc === "matched" ? "good" : lc === "rejected" ? "muted" : "soon"}>{LC_LABEL[lc]}</Badge>}
            <button className="btn ghost sm" onClick={() => { setPicked(null); setQ(""); }}>다른 플랫폼</button>
          </div>
          {lc && (
            <>
              <div className="admin-form">
                <label style={{ flex: 1 }}>전이 사유(감사로그) <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="선택" /></label>
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                {LIFECYCLE_NEXT[lc].map((to) => (
                  <button key={to} className="btn ghost sm" disabled={busy} onClick={() => move(to)}>→ {LC_LABEL[to]}</button>
                ))}
              </div>
            </>
          )}
          {msg && <div className={msg.startsWith("✓") ? "ok" : "err"} style={{ marginTop: 8 }}>{msg}</div>}
        </div>
      )}
    </div>
  );
}

/* ── 콘솔 본체 ────────────────────────────────────────────── */
export function Admin() {
  const go = useNav();
  const { session, profile, isAdmin } = useSession();
  const [queue, setQueue] = useState<Submission[] | null>(null);
  const [stats, setStats] = useState<{ platforms: number; categories: number; newCount: number } | null>(null);
  const [pending, setPending] = useState(0);
  const [popular, setPopular] = useState<{ query: string; cnt: number }[]>([]);

  const reload = useCallback(() => {
    listSubmissions(["pending", "hold"]).then(setQueue).catch(() => setQueue([]));
    getStats().then(setStats).catch(() => { /* noop */ });
    getPendingCount().then(setPending).catch(() => { /* noop */ });
    getPopularSearches().then(setPopular).catch(() => { /* noop */ });
  }, []);
  useEffect(() => { if (isAdmin) reload(); }, [isAdmin, reload]);

  if (!remoteEnabled) return <main className="page container"><h1>관리 콘솔</h1><div className="empty">백엔드 미연결 빌드입니다.</div></main>;
  if (!session) return <main className="page container"><h1>관리 콘솔</h1><div className="empty">로그인이 필요합니다. <a onClick={() => go("account")} style={{ cursor: "pointer" }}>로그인 →</a></div></main>;
  if (!isAdmin) {
    return (
      <main className="page container">
        <h1>관리 콘솔</h1>
        <div className="empty">
          관리자 권한이 없는 계정입니다{profile ? ` (현재: ${profile.role})` : ""}.<br />
          최초 관리자 지정은 Supabase SQL Editor에서 — <span className="mono" style={{ fontSize: 12 }}>backend/README.md §4-F</span> 참고.
        </div>
      </main>
    );
  }

  return (
    <main className="page container">
      <h1>관리 콘솔</h1>

      <div className="stats" style={{ marginBottom: 20 }}>
        <StatTile n={stats ? stats.platforms.toLocaleString() : "—"} l="플랫폼" tone="b" />
        <StatTile n={String(pending)} l="검수 대기" tone="t" />
        <StatTile n={stats ? String(stats.newCount) : "—"} l="신규" />
      </div>

      <div className="sec-title">제보 검수 큐 {queue ? `· ${queue.length}건` : ""}</div>
      {queue === null ? <div className="empty">불러오는 중…</div>
        : queue.length === 0 ? <div className="empty">대기 중인 제보가 없습니다 ✓</div>
        : queue.map((s) => <ReviewCard key={s.id} s={s} onDone={reload} />)}

      <div className="sec-title">라이프사이클 전이</div>
      <p className="lead" style={{ maxWidth: 620, marginTop: -6 }}>
        허용 전이만 표시되며 서버가 재검증합니다(상태머신 + 감사로그). 등재 예정 → 검토 중 → 검증됨 → 성사.
      </p>
      <LifecyclePanel />

      <div className="sec-title">인기 검색어 (7일)</div>
      {popular.length === 0 ? <div className="empty">아직 수집된 검색이 없습니다.</div> : (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {popular.map((p) => <span key={p.query} className="fchip">{p.query} <b className="mono">{p.cnt}</b></span>)}
        </div>
      )}
    </main>
  );
}
