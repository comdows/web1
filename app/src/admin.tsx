/* P3 운영 화면 — 관리자 콘솔: 제보 검수 큐 · 라이프사이클 · 현황.
 * UI 노출은 편의일 뿐, 실제 권한은 RLS is_admin()이 DB에서 강제한다. */
import { useCallback, useEffect, useMemo, useState } from "react";
import { groups, categoriesByGroup, platforms as localPlatforms } from "./data";
import { Badge, StatTile } from "./components";
import { useNav } from "./nav";
import { useSession } from "./lib/auth";
import {
  briefMatchesDeal, createPlatform, deactivateBrief, fetchLatestDealCode, getDealOwner,
  getPendingCount, getPlatformLifecycle, getPopularSearches, getStats, LIFECYCLE_NEXT,
  fetchOutboundCounts, getPlatformFull, listAdminIntroQueue, listBuyerBriefs, listDealsAdmin,
  listDealSubmissions, listOperatorClaims,
  listPartnerPosts, listSubmissions, markIntroduced, publishDeal, remoteEnabled,
  reviewDealSubmission, reviewOperatorClaim, reviewPartnerPost, reviewSubmission,
  transitionPlatform, updateDealStatus, updatePlatform,
} from "./lib/api";
import type {
  BuyerBriefRow, DealSubmissionRow, IntroQueueRow, Lifecycle, PartnerPostAdmin, Submission,
} from "./lib/api";
import { checkAnonymity } from "./lib/anonymity";
import { partnerTypes } from "./data";

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
  const [feeBand, setFeeBand] = useState("");
  const [feeText, setFeeText] = useState("");
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
      fee_band: (feeBand || null) as "low" | "mid" | "high" | null, fee_text: feeText.trim() || null,
    });
    await reviewSubmission(s.id, { status: "approved", approved_platform_id: id.trim() });
  });

  return (
    <div className="admin-card">
      <div className="admin-card-h">
        <b>{s.payload.name}</b>
        <a href={s.payload.url} target="_blank" rel="noopener noreferrer" className="mono" style={{ fontSize: 12 }}>{s.payload.url} ↗</a>
        <Badge kind={s.status === "hold" ? "muted" : "soon"}>{s.status === "hold" ? "보류" : "대기"}</Badge>
        {s.payload.note?.startsWith("auto:") && <Badge kind="verify">🤖 자동 수집</Badge>}
        <span className="mono" style={{ color: "var(--faint)", fontSize: 11, marginLeft: "auto" }}>{s.created_at.slice(0, 10)}</span>
      </div>
      {s.payload.note?.startsWith("auto:") && (
        <div className="frm-note">출처: {s.payload.note.slice(5)} — 이름·분야·소개를 다듬은 뒤 승인하세요(자동 등재 없음).</div>
      )}
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
        <label>수수료대
          <select value={feeBand} onChange={(e) => setFeeBand(e.target.value)}>
            <option value="">모름</option><option value="low">낮음</option><option value="mid">중간</option><option value="high">높음</option>
          </select>
        </label>
        <label>수수료 표기 <input value={feeText} onChange={(e) => setFeeText(e.target.value)} placeholder="예: ~4–10.8%" /></label>
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

/* ── 플랫폼 편집기 + 정보 보강 큐 — 수수료·정산 등 리치 필드 축적, 죽은 링크 정정 ── */
const EDIT_FIELDS = [
  ["fee_text", "수수료 표기", "예: ~4–10.8%"], ["settle_text", "정산 주기", "예: 월 2회, D+7"],
  ["enter_text", "입점 조건", "예: 사업자등록 필요"], ["strength", "강점 한 줄", "예: 신선식품 새벽배송망"],
  ["url", "대표 URL", "https://…"], ["blurb", "한 줄 소개", "중립·사실 위주"],
] as const;
function PlatformEditor() {
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [feeBand, setFeeBand] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [enrich, setEnrich] = useState<{ id: string; name: string; clicks: number }[]>([]);
  // 보강 큐: 최근 30일 클릭 상위 ∩ 수수료 미기재 TOP 20
  useEffect(() => {
    fetchOutboundCounts().then((counts) => {
      const rows = localPlatforms
        .filter((p) => !p.fee_text)
        .map((p) => ({ id: p.id, name: p.name, clicks: counts.get(p.id) ?? 0 }))
        .filter((r) => r.clicks > 0)
        .sort((a, b) => b.clicks - a.clicks).slice(0, 20);
      setEnrich(rows);
    }).catch(() => setEnrich([]));
  }, []);
  const cands = useMemo(() => {
    const n = q.trim().toLowerCase();
    if (!n) return [];
    return localPlatforms.filter((p) => p.name.toLowerCase().includes(n) || p.id.includes(n)).slice(0, 8);
  }, [q]);
  const pick = async (id: string) => {
    setPicked(id); setMsg("");
    try {
      const p = await getPlatformFull(id);
      if (!p) { setMsg("원격에서 찾지 못했어요(정적 전용?)"); return; }
      setForm({ url: p.url, blurb: p.blurb, fee_text: p.fee_text ?? "", settle_text: p.settle_text ?? "", enter_text: p.enter_text ?? "", strength: p.strength ?? "" });
      setFeeBand(p.fee_band ?? "");
    } catch (ex) { setMsg(ex instanceof Error ? ex.message : String(ex)); }
  };
  const save = async () => {
    if (!picked || busy) return;
    setBusy(true); setMsg("");
    try {
      await updatePlatform(picked, {
        url: form.url, blurb: form.blurb,
        fee_band: (feeBand || null) as "low" | "mid" | "high" | null,
        fee_text: form.fee_text || null, settle_text: form.settle_text || null,
        enter_text: form.enter_text || null, strength: form.strength || null,
      });
      setMsg("✓ 저장됨 — 라이브에 즉시 반영. 정적 시드(platforms.json)·프리렌더 반영은 별도 커밋이 필요해요.");
    } catch (ex) { setMsg(ex instanceof Error ? ex.message : String(ex)); }
    finally { setBusy(false); }
  };
  return (
    <div className="admin-card">
      {enrich.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <div className="frm-note">📈 보강 우선순위 — 최근 30일 클릭 상위인데 수수료 미기재:</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
            {enrich.map((r) => <button key={r.id} className="fchip" onClick={() => pick(r.id)}>{r.name} <b className="mono">{r.clicks}</b></button>)}
          </div>
        </div>
      )}
      <div className="admin-form" style={{ marginTop: 0 }}>
        <label style={{ flex: 1 }}>플랫폼 찾기 <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="이름 또는 id" /></label>
      </div>
      {cands.length > 0 && !picked && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
          {cands.map((p) => <button key={p.id} className="fchip" onClick={() => pick(p.id)}>{p.name}</button>)}
        </div>
      )}
      {picked && (
        <div style={{ marginTop: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <b>{localPlatforms.find((p) => p.id === picked)?.name ?? picked}</b>
            <span className="mono" style={{ fontSize: 12, color: "var(--faint)" }}>{picked}</span>
            <button className="btn ghost sm" onClick={() => { setPicked(null); setQ(""); setMsg(""); }}>다른 플랫폼</button>
          </div>
          <div className="admin-form">
            <label>수수료대
              <select value={feeBand} onChange={(e) => setFeeBand(e.target.value)}>
                <option value="">모름</option><option value="low">낮음</option><option value="mid">중간</option><option value="high">높음</option>
              </select>
            </label>
            {EDIT_FIELDS.map(([k, label, ph]) => (
              <label key={k} style={{ flex: 1, minWidth: 180 }}>{label}
                <input value={form[k] ?? ""} onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))} placeholder={ph} />
              </label>
            ))}
          </div>
          {msg && <div className={msg.startsWith("✓") ? "ok" : "err"} style={{ marginTop: 8 }}>{msg}</div>}
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button className="btn primary sm" disabled={busy} onClick={save}>저장</button>
          </div>
        </div>
      )}
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

/* ── 제휴 제안 검수 큐 (partner_posts pending → 게시/반려) ── */
function PartnerPostQueue() {
  const [items, setItems] = useState<PartnerPostAdmin[] | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [loadErr, setLoadErr] = useState(false);
  const [busy, setBusy] = useState("");
  const reload = useCallback(() => {
    setLoadErr(false);
    listPartnerPosts(["pending"]).then(setItems).catch(() => { setItems(null); setLoadErr(true); });
  }, []);
  useEffect(reload, [reload]);
  const act = async (id: string, status: "published" | "rejected") => {
    setBusy(id); setErrs((e) => ({ ...e, [id]: "" }));
    try { await reviewPartnerPost(id, { status, review_reason: reasons[id] || undefined }); reload(); }
    catch (ex) { setErrs((e) => ({ ...e, [id]: ex instanceof Error ? ex.message : String(ex) })); }
    finally { setBusy(""); }
  };
  const tLabel = (id: string) => partnerTypes.find((t) => t.id === id)?.label ?? id;
  if (loadErr) return <div className="empty">큐를 불러오지 못했어요. <button className="linklike" onClick={reload}>다시 시도</button></div>;
  if (items === null) return <div className="empty">불러오는 중…</div>;
  if (items.length === 0) return <div className="empty">대기 중인 제휴 제안이 없습니다 ✓</div>;
  return (
    <>
      {items.map((p) => (
        <div className="admin-card" key={p.id}>
          <div className="admin-card-h">
            <b>{p.title}</b>
            <Badge kind="soon">{tLabel(p.type_id)}</Badge>
            <span className="mono" style={{ color: "var(--faint)", fontSize: 11, marginLeft: "auto" }}>{p.created_at.slice(0, 10)}</span>
          </div>
          <p style={{ margin: "6px 0", fontSize: 13, color: "var(--muted)" }}>
            Give: {p.give_text} / Get: {p.get_text} / {p.size_text}{p.detail ? ` — ${p.detail}` : ""}
          </p>
          <div className="admin-form">
            <label style={{ flex: 1 }}>반려 사유 <input value={reasons[p.id] ?? ""} onChange={(e) => setReasons((r) => ({ ...r, [p.id]: e.target.value }))} placeholder="반려 시(연락처 포함 등)" /></label>
          </div>
          {errs[p.id] && <div className="err">{errs[p.id]}</div>}
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button className="btn primary sm" disabled={busy === p.id} onClick={() => act(p.id, "published")}>✓ 게시</button>
            <button className="btn ghost sm" disabled={busy === p.id} onClick={() => act(p.id, "rejected")}>반려</button>
          </div>
        </div>
      ))}
    </>
  );
}

/* 지분·투자유치 접수 감지 — 게시 금지(무인가 투자중개 회피), 반려 사유 프리셋 안내 */
const isEquitySub = (mode?: string) => /지분|투자|주식/.test(mode ?? "");
const EQUITY_REJECT = "지분 매매·투자유치는 게시 대상이 아닙니다. 로펌·회계법인 등 전문 자문과 진행해 주세요(자산·사업 양수도는 다시 접수하실 수 있어요).";
/* 자산 체크리스트 → 게시 하이라이트 칩 초안(자산·인수인계는 카드의 핵심 신뢰 신호) */
function assetChips(p: { assets?: string[]; handover?: string }): string[] {
  const chips: string[] = [];
  if (p.assets?.length) chips.push(`자산: ${p.assets.map((a) => a.split("(")[0].trim()).join("·")}`);
  if (p.handover && !/없음/.test(p.handover)) chips.push(`인수인계 ${p.handover}`);
  return chips;
}

/* ── 매물 검수 큐 (deal_submissions → 익명화·코드명 부여 후 게시) ── */
function DealSubQueue() {
  const [items, setItems] = useState<DealSubmissionRow[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, { code: string; summary: string; highlights: string; reason: string }>>({});
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [loadErr, setLoadErr] = useState(false);
  const [busy, setBusy] = useState("");
  const reload = useCallback(() => {
    setLoadErr(false);
    Promise.all([
      listDealSubmissions(["pending", "hold"]),
      fetchLatestDealCode().catch(() => null),
    ]).then(([rows, latest]) => {
      setItems(rows);
      // 코드명 기본값: DB의 최신 D-### 다음 번호부터(세션 인덱스 기반은 재접속 시 PK 충돌)
      const base = latest && /^D-(\d+)$/.test(latest) ? parseInt(latest.slice(2), 10) + 1 : 201;
      setDrafts((d) => {
        const n = { ...d };
        rows.forEach((r, i) => {
          if (!n[r.id]) n[r.id] = {
            code: `D-${base + i}`, summary: r.payload.summary ?? "",
            highlights: [r.payload.highlights, ...assetChips(r.payload)].filter(Boolean).join(", "),
            reason: isEquitySub(r.payload.mode) ? EQUITY_REJECT : "",
          };
        });
        return n;
      });
    }).catch(() => { setItems(null); setLoadErr(true); });
  }, []);
  useEffect(reload, [reload]);

  const approve = async (s: DealSubmissionRow) => {
    const d = drafts[s.id];
    setErrs((e) => ({ ...e, [s.id]: "" })); setBusy(s.id);
    const code = d.code.trim();
    try {
      try {
        await publishDeal({
          id: code, category_id: s.payload.category_id ?? "", region: s.payload.region ?? "domestic",
          revenue_band: s.payload.revenue_band ?? "", mode: s.payload.mode ?? "",
          summary: d.summary.trim(), highlights: d.highlights ? d.highlights.split(",").map((x) => x.trim()).filter(Boolean) : [],
          sale_reason: s.payload.sale_reason || null, owner_id: s.submitter_id,
        });
      } catch (pubEx) {
        // 코드명 충돌: 같은 접수의 재승인(이미 게시됨)이면 게시를 건너뛰고 접수 상태만 갱신
        if ((pubEx as { status?: number }).status === 409) {
          const owner = await getDealOwner(code).catch(() => null);
          if (owner !== s.submitter_id) throw new Error(`코드명 ${code}가 이미 사용 중이에요 — 다른 번호를 입력하세요.`);
        } else throw pubEx;
      }
      await reviewDealSubmission(s.id, { status: "approved", approved_deal_id: code });
      reload();
    } catch (ex) { setErrs((e) => ({ ...e, [s.id]: ex instanceof Error ? ex.message : String(ex) })); }
    finally { setBusy(""); }
  };
  const reject = async (s: DealSubmissionRow) => {
    setErrs((e) => ({ ...e, [s.id]: "" })); setBusy(s.id);
    try { await reviewDealSubmission(s.id, { status: "rejected", review_reason: drafts[s.id]?.reason || "익명성 규칙 미충족" }); reload(); }
    catch (ex) { setErrs((e) => ({ ...e, [s.id]: ex instanceof Error ? ex.message : String(ex) })); }
    finally { setBusy(""); }
  };

  if (loadErr) return <div className="empty">큐를 불러오지 못했어요. <button className="linklike" onClick={reload}>다시 시도</button></div>;
  if (items === null) return <div className="empty">불러오는 중…</div>;
  if (items.length === 0) return <div className="empty">대기 중인 매각 접수가 없습니다 ✓</div>;
  return (
    <>
      {items.map((s) => {
        const d = drafts[s.id] ?? { code: "", summary: "", highlights: "", reason: "" };
        const set = (patch: Partial<typeof d>) => setDrafts((r) => ({ ...r, [s.id]: { ...d, ...patch } }));
        const equity = isEquitySub(s.payload.mode);
        // 익명성 자동 점검 — 원문과 게시 초안 양쪽의 누출 위험을 검수자에게 하이라이트
        const anon = checkAnonymity(s.payload.summary, s.payload.sale_reason, d.summary, d.highlights);
        return (
          <div className="admin-card" key={s.id}>
            <div className="admin-card-h">
              <b>매각 접수</b>
              <Badge kind="soon">{s.payload.revenue_band ?? "?"}</Badge>
              <Badge kind="muted">{s.payload.mode ?? "?"}</Badge>
              {equity && <Badge kind="muted">⚠ 지분 — 게시 불가</Badge>}
              <Badge kind={s.payload.contact_consent_at ? "verify" : "muted"}>
                {s.payload.contact_consent_at ? "이메일 공유 동의 ✓" : "⚠ 동의 없음(구버전)"}
              </Badge>
              <span className="mono" style={{ color: "var(--faint)", fontSize: 11, marginLeft: "auto" }}>{s.created_at.slice(0, 10)}</span>
            </div>
            <p style={{ margin: "6px 0", fontSize: 13, color: "var(--muted)" }}>
              원문: {s.payload.summary}{s.payload.sale_reason ? ` (사유: ${s.payload.sale_reason})` : ""}
            </p>
            {(s.payload.assets?.length || s.payload.handover) && (
              <p style={{ margin: "2px 0 6px", fontSize: 12.5, color: "var(--muted)" }}>
                자산: {s.payload.assets?.length ? s.payload.assets.join(", ") : "미기재"} · 인수인계: {s.payload.handover ?? "미기재"}
              </p>
            )}
            {s.payload.verify_note && (
              <div className="frm-note" style={{ marginBottom: 6 }}>
                🔒 비공개 검증 자료(게시에 복사 금지): <span className="mono" style={{ fontSize: 12 }}>{s.payload.verify_note}</span>
                {" — "}확인되면 하이라이트에 "운영자 확인 ✓" 칩을 직접 추가하세요.
              </div>
            )}
            {equity && (
              <div className="err" style={{ fontSize: 12.5 }}>
                지분·투자유치 접수 건 — 게시하면 무인가 투자중개 리스크가 있어 게시 버튼이 잠깁니다. 아래 프리셋 사유로 반려하세요.
              </div>
            )}
            {anon.length > 0 && (
              <div className="frm-note" style={{ marginBottom: 6 }}>
                🕶️ 익명성 점검: {anon.map((f) => `"${f.snippet}" (${f.hint})`).join(" · ")}
              </div>
            )}
            <div className="admin-form">
              <label>코드명 <input value={d.code} onChange={(e) => set({ code: e.target.value })} placeholder="D-201" /></label>
              <label style={{ flex: 2, minWidth: 240 }}>게시용 익명 요약(재작성)
                <input value={d.summary} onChange={(e) => set({ summary: e.target.value })} /></label>
              <label style={{ flex: 1, minWidth: 160 }}>하이라이트(쉼표)
                <input value={d.highlights} onChange={(e) => set({ highlights: e.target.value })} /></label>
              <label>반려 사유 <input value={d.reason} onChange={(e) => set({ reason: e.target.value })} placeholder="반려 시" /></label>
            </div>
            {errs[s.id] && <div className="err">{errs[s.id]}</div>}
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <button className="btn primary sm" disabled={busy === s.id || equity} title={equity ? "지분 접수 건은 게시할 수 없어요" : ""}
                onClick={() => approve(s)}>✓ 익명화 게시</button>
              <button className="btn ghost sm" disabled={busy === s.id} onClick={() => reject(s)}>반려</button>
            </div>
          </div>
        );
      })}
    </>
  );
}

/* ── 소개 대기(매칭 신청·인수 관심·브리프) — 양측 이메일로 실제 소개 이행 ──
 * 거래소 건은 2단 SOP: ① 매도자 의사 확인(단독 수신) → 회신 후 ② 소개 초안(양측 수신, NDA·§27 안내 포함) */
function IntroQueue() {
  const [rows, setRows] = useState<IntroQueueRow[] | null>(null);
  const [briefs, setBriefs] = useState<BuyerBriefRow[]>([]);
  const [deals, setDeals] = useState<{ id: string; status: string; is_demo: boolean; category_id: string; mode: string }[]>([]);
  const [mailed, setMailed] = useState<Set<string>>(new Set()); // 소개 초안을 연 건만 '소개 완료' 활성화
  const [loadErr, setLoadErr] = useState(false);
  const reload = useCallback(() => {
    setLoadErr(false);
    listAdminIntroQueue().then(setRows).catch(() => { setRows(null); setLoadErr(true); });
    listBuyerBriefs().then(setBriefs).catch(() => setBriefs([]));
    listDealsAdmin().then(setDeals).catch(() => setDeals([]));
  }, []);
  useEffect(reload, [reload]);
  const done = async (kind: "partner" | "deal", id: string) => {
    await markIntroduced(kind === "partner" ? "partner_post_interests" : "deal_interests", id).catch(() => { /* noop */ });
    reload();
  };
  const guideUrl = `${location.origin}${import.meta.env.BASE_URL}?view=deal-guide`;
  /* ① 매도자 의사 확인 — 관심자 정보는 익명 요지만, 소개 여부 회신 요청(현황 알림 겸용) */
  const sellerConfirmDraft = (r: IntroQueueRow) => {
    const subject = `[세모플] ${r.target_title} 인수 관심 접수 — 소개 진행 여부 회신 요청`;
    const body = `안녕하세요, 세모플입니다.\n\n회원님이 게시하신 매물 ${r.target_title}에 인수 관심 1건이 접수됐습니다.\n- 관심자 소개(익명 요지): ${r.message}\n\n소개(상호 이메일 공유)를 진행해도 될지 이 메일에 회신으로 알려주세요.\n진행을 원치 않으시면 사유 없이 "진행하지 않겠습니다"라고만 회신하셔도 됩니다.\n\n세모플 드림`;
    return `mailto:${r.counterpart_email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  };
  /* ② 소개 초안 — 거래소 건은 NDA·§27·다음 단계 안내 포함(소개 후 막다른 길 방지) */
  const mailDraft = (r: IntroQueueRow) => {
    const to = [r.applicant_email, r.counterpart_email].filter(Boolean).join(",");
    const subject = `[세모플 소개] ${r.target_title}`;
    const common = `안녕하세요, 세모플입니다.\n\n양측 동의에 따라 서로를 소개드립니다.\n- 신청: ${r.platform_name || r.applicant_email} (${r.applicant_email})\n- 상대: ${r.target_title} (${r.counterpart_email})\n- 제안 요지: ${r.message}\n`;
    const dealNext = `\n다음 단계(권장):\n1) 상호 NDA 체결 후 자료 교환(자산 목록·매출 증빙) — 참고 가이드: ${guideUrl}\n2) 실사·계약·대금은 전문 자문(로펌·회계법인)과 직접 진행하세요.\n3) 회원 DB 이전 시 개인정보보호법 제27조(영업양도 통지) 절차가 필요합니다.\n`;
    const body = common + (r.kind === "deal" ? dealNext : "") +
      `\n이후 협의는 두 분이 직접 진행해 주세요. 세모플의 역할은 여기까지입니다.\n(협상·가격·정산·계약에 세모플은 관여하지 않습니다)`;
    return `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  };
  if (loadErr) return <div className="empty">소개 큐를 불러오지 못했어요(0005 마이그레이션 필요 여부 확인). <button className="linklike" onClick={reload}>다시 시도</button></div>;
  if (rows === null) return <div className="empty">불러오는 중…</div>;
  if (rows.length === 0 && briefs.length === 0) return <div className="empty">소개 대기 건이 없습니다 ✓</div>;
  const activeDeals = deals.filter((d) => !d.is_demo && d.status !== "closed");
  return (
    <>
      {rows.map((r) => {
        const key = `${r.kind}-${r.id}`;
        const ready = Boolean(r.applicant_email && r.counterpart_email && r.contact_consent_at);
        return (
          <div className="sub-item" key={key}>
            <div style={{ minWidth: 0 }}>
              <b>{r.kind === "partner" ? "🤝 매칭 신청" : "🏦 인수 관심"}</b>
              {" — "}{r.platform_name ? `${r.platform_name} → ` : ""}"{r.target_title}"
              <div className="frm-note">{r.message}</div>
              <div className="mono" style={{ fontSize: 11, color: "var(--faint)" }}>
                {r.applicant_email ?? "이메일 없음"} ↔ {r.counterpart_email ?? "이메일 없음"}
                {r.contact_consent_at ? " · 동의 ✓" : " · ⚠ 이메일 공유 동의 없음(구버전 신청)"}
              </div>
            </div>
            <div style={{ display: "flex", gap: 6, flexShrink: 0, flexWrap: "wrap" }}>
              {r.kind === "deal" && r.counterpart_email && (
                <a className="btn ghost sm" href={sellerConfirmDraft(r)} title="매도자에게 관심 접수 현황을 알리고 소개 진행 여부를 확인">① 매도자 확인</a>
              )}
              {ready && (
                <a className="btn primary sm" href={mailDraft(r)} onClick={() => setMailed((s) => new Set(s).add(key))}>
                  {r.kind === "deal" ? "② 소개 초안" : "메일 초안"}
                </a>
              )}
              <button className="btn ghost sm" disabled={!ready || !mailed.has(key)}
                title={!ready ? "양측 이메일·동의가 있어야 소개할 수 있어요" : !mailed.has(key) ? "소개 초안을 먼저 발송하세요" : ""}
                onClick={() => done(r.kind, r.id)}>소개 완료</button>
            </div>
          </div>
        );
      })}
      {briefs.map((b) => {
        const matches = activeDeals.filter((d) => briefMatchesDeal(b, d));
        return (
          <div className="sub-item" key={b.id}>
            <div style={{ minWidth: 0 }}>
              <b>📮 인수 브리프</b> — {b.entity} · {b.budget_band} · {b.mode}
              <div className="frm-note">{b.categories.length ? b.categories.join(", ") : "분야 무관"}{b.note ? ` — ${b.note}` : ""}</div>
              <div className="mono" style={{ fontSize: 11, color: matches.length ? "var(--teal)" : "var(--faint)" }}>
                {matches.length ? `맞는 매물: ${matches.map((m) => m.id).join(", ")}` : "맞는 매물 없음(게시 중 기준)"}
              </div>
            </div>
            <div style={{ display: "flex", gap: 6, alignItems: "center", flexShrink: 0 }}>
              <span className="mono" style={{ fontSize: 11, color: "var(--faint)" }}>{b.created_at.slice(0, 10)}</span>
              <button className="btn ghost sm" onClick={async () => { await deactivateBrief(b.id).catch(() => { /* 0005 필요 */ }); reload(); }}>안내 완료</button>
            </div>
          </div>
        );
      })}
    </>
  );
}

/* ── 운영자 클레임 검수 — 승인 시 운영자 지정 + 검증 배지(platforms.verified) ── */
function OperatorClaimQueue() {
  const [items, setItems] = useState<Awaited<ReturnType<typeof listOperatorClaims>> | null>(null);
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");
  const reload = useCallback(() => {
    listOperatorClaims().then(setItems).catch(() => setItems([]));
  }, []);
  useEffect(reload, [reload]);
  const act = async (c: (typeof items extends (infer T)[] | null ? T : never), approve: boolean) => {
    setBusy(c.id); setErrs((e) => ({ ...e, [c.id]: "" }));
    try { await reviewOperatorClaim(c, approve); reload(); }
    catch (ex) { setErrs((e) => ({ ...e, [c.id]: ex instanceof Error ? ex.message : String(ex) })); }
    finally { setBusy(""); }
  };
  const domainMatch = (c: { business_email: string | null; platforms?: { url: string } | null }) => {
    try {
      const host = new URL(c.platforms?.url ?? "").hostname.replace(/^www\./, "");
      const dom = (c.business_email ?? "").split("@")[1]?.toLowerCase() ?? "";
      return dom && (dom === host || host.endsWith("." + dom) || dom.endsWith("." + host) || host.includes(dom.split(".")[0]));
    } catch { return false; }
  };
  if (items === null) return <div className="empty">불러오는 중…</div>;
  if (items.length === 0) return <div className="empty">대기 중인 운영자 인증 신청이 없습니다 ✓</div>;
  return (
    <>
      {items.map((c) => (
        <div className="sub-item" key={c.id}>
          <div style={{ minWidth: 0 }}>
            <b>🏷 {c.platforms?.name ?? c.platform_id}</b>{" "}
            <a href={c.platforms?.url} target="_blank" rel="noopener noreferrer" className="mono" style={{ fontSize: 12 }}>{c.platforms?.url} ↗</a>
            <div className="mono" style={{ fontSize: 12 }}>
              {c.business_email ?? "이메일 미기재"}{" "}
              <Badge kind={domainMatch(c) ? "verify" : "muted"}>{domainMatch(c) ? "도메인 일치" : "⚠ 도메인 불일치 — 추가 확인"}</Badge>
            </div>
            {errs[c.id] && <div className="err">{errs[c.id]}</div>}
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexShrink: 0 }}>
            <span className="mono" style={{ fontSize: 11, color: "var(--faint)" }}>{c.created_at.slice(0, 10)}</span>
            <button className="btn primary sm" disabled={busy === c.id} onClick={() => act(c, true)}>✓ 승인(배지 부여)</button>
            <button className="btn ghost sm" disabled={busy === c.id} onClick={() => act(c, false)}>반려</button>
          </div>
        </div>
      ))}
    </>
  );
}

/* ── 게시물 상태 전이(제안 성사/마감 · 매물 진행/마감) ──
   성사돼도 '모집 중'으로 남아 신규 신청이 계속 들어오던 문제 해결 */
function LivePanel() {
  const [posts, setPosts] = useState<PartnerPostAdmin[]>([]);
  const [deals, setDeals] = useState<{ id: string; status: string; summary: string; is_demo: boolean }[]>([]);
  const [busy, setBusy] = useState("");
  const reload = useCallback(() => {
    listPartnerPosts(["published", "matched"]).then(setPosts).catch(() => setPosts([]));
    listDealsAdmin().then((d) => setDeals(d.filter((x) => !x.is_demo && x.status !== "closed"))).catch(() => setDeals([]));
  }, []);
  useEffect(reload, [reload]);
  const movePost = async (id: string, status: string) => {
    setBusy(id);
    try { await reviewPartnerPost(id, { status }); reload(); } finally { setBusy(""); }
  };
  const moveDeal = async (id: string, status: "open" | "in_progress" | "closed") => {
    setBusy(id);
    try { await updateDealStatus(id, status); reload(); } finally { setBusy(""); }
  };
  if (posts.length === 0 && deals.length === 0) return <div className="empty">게시 중인 제안·매물이 없습니다.</div>;
  return (
    <>
      {posts.map((p) => (
        <div className="sub-item" key={p.id}>
          <div style={{ minWidth: 0 }}>
            <b>🤝 {p.title}</b> <Badge kind={p.status === "matched" ? "good" : "soon"}>{p.status === "matched" ? "성사" : "게시 중"}</Badge>
            <div className="frm-note">Give {p.give_text} / Get {p.get_text}</div>
          </div>
          <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
            {p.status === "published" && <button className="btn ghost sm" disabled={busy === p.id} onClick={() => movePost(p.id, "matched")}>성사 처리</button>}
            <button className="btn ghost sm" disabled={busy === p.id} onClick={() => movePost(p.id, "closed")}>마감(내리기)</button>
          </div>
        </div>
      ))}
      {deals.map((d) => (
        <div className="sub-item" key={d.id}>
          <div style={{ minWidth: 0 }}>
            <b>🏦 {d.id}</b> <Badge kind={d.status === "in_progress" ? "soon" : "good"}>{d.status === "in_progress" ? "진행 중" : "모집 중"}</Badge>
            <div className="frm-note">{d.summary.slice(0, 60)}</div>
          </div>
          <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
            {d.status === "open" && <button className="btn ghost sm" disabled={busy === d.id} onClick={() => moveDeal(d.id, "in_progress")}>진행 중으로</button>}
            {d.status === "in_progress" && <button className="btn ghost sm" disabled={busy === d.id} onClick={() => moveDeal(d.id, "open")}>모집 중으로</button>}
            <button className="btn ghost sm" disabled={busy === d.id} onClick={() => moveDeal(d.id, "closed")}>마감(내리기)</button>
          </div>
        </div>
      ))}
    </>
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

      <div className="sec-title">🤝 제휴 제안 검수</div>
      <PartnerPostQueue />

      <div className="sec-title">🏦 매물 검수 (익명화 → 코드명 게시)</div>
      <DealSubQueue />

      <div className="sec-title">🏷 운영자 인증 신청</div>
      <OperatorClaimQueue />

      <div className="sec-title">📮 소개 대기 (매칭 신청 · 인수 관심 · 브리프)</div>
      <IntroQueue />

      <div className="sec-title">📡 게시 중 (상태 전이 — 성사·진행·마감)</div>
      <LivePanel />

      <div className="sec-title">✏️ 플랫폼 정보 편집 · 보강 큐</div>
      <PlatformEditor />

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
