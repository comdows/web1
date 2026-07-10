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
  fetchAdminMetrics, fetchFunnel, fetchIntroSuccess, fetchOutboundCounts, fetchQueueCounts, fetchReferrers, getAdminContactEmail, getPlatformFull, listAdminIntroQueue, listAutoListed, listBuyerBriefs, listDealsAdmin,
  reviewAutoListed,
  listDealSubmissions, listOperatorClaims,
  adminDeclineInterest, adminIntroduce, cancelCharge, confirmDeposit, createSponsorSlot, declinePendingInterests,
  listAdminCharges, listPartnerPosts, listSponsorSlotsAdmin, listSubmissions, listSubscriptionsAdmin,
  answerDealQuestion, listPendingDealQuestions, listPendingReviews, moderateReview, setDealVerified,
  markOwnerConfirmed, partnerRefCode, publishDeal, refundCharge, remoteEnabled, rest,
  reviewDealSubmission, reviewOperatorClaim, reviewPartnerPost, reviewSubmission,
  transitionPlatform, updateDealStatus, updatePlatform,
  listReports, resolveReport, listPublishedReviews, listRecentPlatformNews, deletePlatformNews,
  searchAdminMembers, setMemberSuspended, listAppSettings, updateAppSetting, listRecentProcessed,
  listOpenInquiries, replyInquiry,
} from "./lib/api";
import type {
  AdminChargeRow, BuyerBriefRow, DealSubmissionRow, IntroQueueRow, Lifecycle, PartnerPostAdmin,
  PendingDealQ, PendingReview, SponsorSlotAdmin, Submission, SubscriptionAdmin,
  ReportRow, AdminMember, AppSetting, ProcessedItem, Inquiry, PlatformNews,
} from "./lib/api";
import { checkAnonymity } from "./lib/anonymity";
import { scoreBriefDeal } from "./lib/match";
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

/* 제보 1건 승인·등재 — 개별 카드와 일괄 승인이 공유(등재 순단 시 409 멱등 복구 포함). */
async function approveSubmission(s: Submission, opts: {
  id: string; cat: string; feeBand?: string; feeText?: string;
}): Promise<void> {
  const id = opts.id.trim();
  if (!id || !opts.cat) throw new Error(`${s.payload.name}: id와 분야를 확인하세요`);
  try {
    await createPlatform({
      id, name: s.payload.name, category_id: opts.cat,
      region: s.payload.region, url: s.payload.url, blurb: s.payload.desc || "",
      fee_band: (opts.feeBand || null) as "low" | "mid" | "high" | null, fee_text: opts.feeText?.trim() || null,
    });
  } catch (pubEx) {
    // 등재 후 접수 갱신 전 순단 → 재승인 시 PK 409. 같은 접수(URL 호스트 일치)면 생성 건너뛰고 상태만 갱신.
    if ((pubEx as { status?: number }).status !== 409) throw pubEx;
    const existing = await getPlatformFull(id).catch(() => null);
    const sameHost = (a: string, b: string) => { try { return new URL(a).hostname.replace(/^www\./, "") === new URL(b).hostname.replace(/^www\./, ""); } catch { return false; } };
    if (!existing || !sameHost(existing.url, s.payload.url)) {
      throw new Error(`id ${id}는 이미 다른 플랫폼이 쓰고 있어요 — 다른 id를 입력하세요.`);
    }
  }
  await reviewSubmission(s.id, { status: "approved", approved_platform_id: id });
}

/* 카테고리 id → 이름(일괄 승인·사후 검수 표시용) */
function catName(id: string): string {
  for (const g of groups) { const c = categoriesByGroup(g.id).find((x) => x.id === id); if (c) return c.name; }
  return id;
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
  const approve = () => act(() => approveSubmission(s, { id, cat, feeBand, feeText }));

  return (
    <div className="admin-card">
      <div className="admin-card-h">
        <b>{s.payload.name}</b>
        <a href={s.payload.url} target="_blank" rel="noopener noreferrer" className="mono" style={{ fontSize: 12 }}>{s.payload.url} ↗</a>
        <Badge kind={s.status === "hold" ? "muted" : "soon"}>{s.status === "hold" ? "보류" : "대기"}</Badge>
        {s.payload.note?.startsWith("auto:") && <Badge kind="verify">🤖 자동 수집</Badge>}
        {typeof s.payload.confidence === "number" && <Badge kind={s.payload.confidence >= 80 ? "soon" : "muted"}>신뢰도 {s.payload.confidence}</Badge>}
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
        <MailButton kind="submission" refId={s.id}
          subject="[세모플] 플랫폼 제보 검수 결과 안내"
          body={`안녕하세요, 세모플입니다.\n\n제보해 주신 "${s.payload.name ?? ""}"의 검수 결과를 안내드립니다.\n\n결과: (등재/보류/반려)\n사유: ${reason || "-"}\n\n이용해 주셔서 감사합니다.`} />
      </div>
    </div>
  );
}

/* ── 정정·보강 제안 검수 카드 — 회원·운영자가 제안한 판단 필드 교정을 대상 플랫폼에 적용 ── */
const CORRECTION_LABELS: Record<string, string> = {
  fee_band: "수수료대", fee_text: "수수료 표기", settle_text: "정산 주기", enter_text: "입점 조건", strength: "강점", url: "URL",
};
function CorrectionCard({ s, onDone }: { s: Submission; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [reason, setReason] = useState("");
  const pid = s.payload.target_platform_id ?? "";
  const fields = s.payload.fields ?? {};
  const entries = Object.entries(fields).filter(([, v]) => v != null && String(v).trim() !== "");
  const act = async (fn: () => Promise<void>) => {
    setErr(""); setBusy(true);
    try { await fn(); onDone(); } catch (ex) { setErr(ex instanceof Error ? ex.message : String(ex)); } finally { setBusy(false); }
  };
  const apply = () => act(async () => {
    if (!pid) throw new Error("대상 플랫폼 id가 없어요");
    if (entries.length) await updatePlatform(pid, Object.fromEntries(entries) as Parameters<typeof updatePlatform>[1]);
    await reviewSubmission(s.id, { status: "approved", approved_platform_id: pid });
  });
  return (
    <div className="admin-card">
      <div className="admin-card-h">
        <b>✏️ 정정 제안 — {s.payload.name}</b>
        <a href={s.payload.url} target="_blank" rel="noopener noreferrer" className="mono" style={{ fontSize: 12 }}>{s.payload.url} ↗</a>
        <Badge kind="soon">정정</Badge>
        {s.payload.by_operator && <Badge kind="verify">✓ 운영자 확인</Badge>}
        <span className="mono" style={{ color: "var(--faint)", fontSize: 11, marginLeft: "auto" }}>{s.created_at.slice(0, 10)}</span>
      </div>
      <div className="frm-note">대상: <span className="mono">{pid}</span> — 아래 제안 값을 확인하고 적용하세요{s.payload.by_operator ? " (운영자 제출 — 우선)" : ""}.</div>
      {entries.length === 0 ? <div className="frm-note">제안 필드 없음(메모만) — 메모: {s.payload.desc || "-"}</div>
        : <ul style={{ margin: "6px 0", fontSize: 13 }}>
            {entries.map(([k, v]) => <li key={k}><b>{CORRECTION_LABELS[k] ?? k}</b> → {String(v)}</li>)}
          </ul>}
      {s.payload.desc && <div className="frm-note">메모: {s.payload.desc}</div>}
      {err && <div className="err">{err}</div>}
      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <button className="btn primary sm" disabled={busy} onClick={apply}>✓ 정정 적용</button>
        <button className="btn ghost sm" disabled={busy} onClick={() => act(() => reviewSubmission(s.id, { status: "rejected", review_reason: reason || "정정 미채택" }))}>반려</button>
        <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="반려 사유" style={{ flex: 1, minWidth: 100 }} />
      </div>
    </div>
  );
}

/* ── (C) 1클릭 일괄 승인 — 사람을 없애지 말고 확장한다. ────────────────
 * 자동 수집(auto:) + 분야 추정 있음 + 중복 의심 없음 + id 슬러그 유효한 "고신뢰" 후보만
 * 기본 체크 → 관리자가 한 번 훑고 "선택 N건 승인·등재". id/분야는 자동 추정값을 그대로 쓴다. */
function BatchApprovePanel({ queue, onDone }: { queue: Submission[]; onDone: () => void }) {
  const eligible = useMemo(() => queue
    .filter((s) => s.payload.note?.startsWith("auto:") && s.payload.category_id
      && suggestId(s.payload.url) && dupCandidates(s.payload.name, s.payload.url).length === 0)
    .map((s) => ({ s, id: suggestId(s.payload.url), cat: s.payload.category_id })), [queue]);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  // 목록이 바뀌면 고신뢰(≥80)만 기본 선택(신뢰도 없으면 분야 추정만으로 선택)
  useEffect(() => {
    setSel(new Set(eligible.filter((e) => (e.s.payload.confidence ?? 60) >= 60).map((e) => e.s.id)));
  }, [eligible]);

  if (eligible.length === 0) return null;
  const toggle = (id: string) => setSel((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const run = async () => {
    setBusy(true); setMsg("");
    let ok = 0; const fails: string[] = [];
    for (const e of eligible) {
      if (!sel.has(e.s.id)) continue;
      try { await approveSubmission(e.s, { id: e.id, cat: e.cat }); ok++; }
      catch (ex) { fails.push(`${e.s.payload.name}: ${ex instanceof Error ? ex.message : String(ex)}`); }
    }
    setBusy(false);
    setMsg(`${ok}건 승인·등재 완료${fails.length ? ` · 실패 ${fails.length}건 (${fails[0]}${fails.length > 1 ? " 외" : ""})` : ""}`);
    onDone();
  };

  return (
    <div className="banner" style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
        <b>⚡ 일괄 승인 후보 {eligible.length}건</b>
        <span className="faint" style={{ fontSize: 12 }}>분야 추정 있음 · 중복 없음 — id·분야는 추정값으로 등재됩니다(등재 후 편집기에서 보강).</span>
        <button className="btn primary sm" disabled={busy || sel.size === 0} style={{ marginLeft: "auto" }} onClick={run}>
          {busy ? "승인 중…" : `선택 ${sel.size}건 승인·등재 →`}
        </button>
      </div>
      <div style={{ display: "grid", gap: 4 }}>
        {eligible.map((e) => (
          <label key={e.s.id} className="facet-opt" style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
            <input type="checkbox" checked={sel.has(e.s.id)} onChange={() => toggle(e.s.id)} />
            <b style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.s.payload.name}</b>
            <Badge kind="muted">{catName(e.cat)}</Badge>
            {typeof e.s.payload.confidence === "number" && <span className="mono faint" style={{ fontSize: 11 }}>{e.s.payload.confidence}</span>}
            <span className="mono faint" style={{ fontSize: 11 }}>→ {e.id}</span>
          </label>
        ))}
      </div>
      {msg && <div className="ok" style={{ marginTop: 8, fontSize: 13 }}>{msg}</div>}
    </div>
  );
}

/* ── (D) 자동 등재 사후 검수 — auto_listed(lifecycle=review) 플랫폼 스팟체크 ────
 * 스위치(app_settings 'autolist')가 켜진 경우에만 채워진다. 기본 off면 항상 비어 있음. */
function AutoListedQueue() {
  const [rows, setRows] = useState<Awaited<ReturnType<typeof listAutoListed>> | null>(null);
  const [busy, setBusy] = useState("");
  const load = useCallback(() => { listAutoListed().then(setRows).catch(() => setRows([])); }, []);
  useEffect(() => { load(); }, [load]);
  const act = async (id: string, keep: boolean) => {
    setBusy(id);
    try { await reviewAutoListed(id, keep); load(); } catch { /* noop */ } finally { setBusy(""); }
  };
  if (rows === null) return <div className="empty">불러오는 중…</div>;
  if (rows.length === 0) return <div className="empty">자동 등재 대기 건이 없습니다 ✓ <span className="faint" style={{ fontSize: 12 }}>(자동 등재 스위치가 꺼져 있으면 항상 비어 있습니다.)</span></div>;
  return (
    <div style={{ display: "grid", gap: 6 }}>
      {rows.map((r) => (
        <div key={r.id} className="admin-card" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <b>{r.name}</b>
          <Badge kind="muted">{catName(r.category_id)}</Badge>
          <a href={r.url} target="_blank" rel="noopener noreferrer" className="mono" style={{ fontSize: 12 }}>{r.url} ↗</a>
          <span className="mono faint" style={{ fontSize: 11 }}>{r.auto_listed_at.slice(0, 10)}</span>
          <div style={{ display: "flex", gap: 6, marginLeft: "auto" }}>
            <button className="btn primary sm" disabled={!!busy} onClick={() => act(r.id, true)}>확정(검증)</button>
            <button className="btn ghost sm" disabled={!!busy} onClick={() => act(r.id, false)}>내리기</button>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ── 퍼널·유입 패널(7일) — 노출→클릭→아웃바운드 전환 + 유입경로 상위 ── */
function FunnelPanel() {
  const [f, setF] = useState<Awaited<ReturnType<typeof fetchFunnel>>>(null);
  const [refs, setRefs] = useState<Awaited<ReturnType<typeof fetchReferrers>>>([]);
  const [intro, setIntro] = useState<Awaited<ReturnType<typeof fetchIntroSuccess>>>(null);
  useEffect(() => {
    fetchFunnel().then(setF).catch(() => { /* noop */ });
    fetchReferrers().then(setRefs).catch(() => { /* noop */ });
    fetchIntroSuccess().then(setIntro).catch(() => { /* noop */ });
  }, []);
  if (!f) return null;
  const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0);
  return (
    <div className="banner" style={{ marginBottom: 20 }}>
      <b>퍼널·유입 (최근 7일)</b>
      <div className="stats" style={{ marginTop: 8 }}>
        <StatTile n={f.impressions.toLocaleString()} l="노출" />
        <StatTile n={`${f.clicks.toLocaleString()} · ${pct(f.clicks, f.impressions)}%`} l="클릭(노출대비)" />
        <StatTile n={`${f.outbounds.toLocaleString()} · ${pct(f.outbounds, f.clicks)}%`} l="외부방문(클릭대비)" tone="t" />
        <StatTile n={f.searches.toLocaleString()} l="검색" />
        <StatTile n={f.sessions.toLocaleString()} l="세션" tone="b" />
        <StatTile n={`${f.logged_in.toLocaleString()}`} l="로그인 사용자" />
      </div>
      {refs.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div className="frm-note" style={{ marginBottom: 4 }}>유입경로 상위(세션 기준)</div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {refs.slice(0, 12).map((r) => (
              <Badge key={r.ref} kind="muted">{r.ref} · {r.sessions}</Badge>
            ))}
          </div>
        </div>
      )}
      {intro && intro.responded > 0 && (
        <div style={{ marginTop: 10 }}>
          <div className="frm-note" style={{ marginBottom: 4 }}>소개 후속 응답 {intro.responded}건</div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <Badge kind="good">성사 {intro.success}</Badge>
            <Badge kind="soon">진행 중 {intro.progressing}</Badge>
            <Badge kind="muted">무산 {intro.no_deal}</Badge>
            <span className="faint" style={{ fontSize: 12 }}>성사율 {Math.round((intro.success / intro.responded) * 100)}%</span>
          </div>
        </div>
      )}
      {f.impressions === 0 && <div className="frm-note" style={{ marginTop: 6 }}>아직 노출 데이터가 없어요 — 계측 배포 후 방문이 쌓이면 채워집니다.</div>}
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
            <span className="mono" style={{ color: "var(--faint)", fontSize: 11, marginLeft: "auto" }}>{partnerRefCode(p.id)} · {p.created_at.slice(0, 10)}</span>
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
            <MailButton kind="partner_post" refId={p.id}
              subject={`[세모플] 제휴 제안(${partnerRefCode(p.id)}) 검수 결과 안내`}
              body={`안녕하세요, 세모플입니다.\n\n등록하신 제휴 제안 "${p.title}"(${partnerRefCode(p.id)})의 검수 결과를 안내드립니다.\n\n결과: (게시/반려)\n사유: ${reasons[p.id] || "-"}\n\n감사합니다.`} />
          </div>
        </div>
      ))}
    </>
  );
}

/* 검수 결과 메일 안내(0010 v_admin_contact) — 큐에 이메일이 없어 반려를 알릴 수 없던 공백 해소.
 * 버튼 클릭 시 이메일 조회 → mailto 템플릿(제목·본문 프리필). 발송 여부는 운영자 판단. */
function MailButton({ kind, refId, subject, body }: {
  kind: "submission" | "partner_post" | "deal_submission" | "operator_claim";
  refId: string; subject: string; body: string;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <button className="btn ghost sm" disabled={busy} title="접수자에게 결과 안내 메일(mailto)"
      onClick={async () => {
        setBusy(true);
        try {
          const email = await getAdminContactEmail(kind, refId);
          if (!email) { alert("접수자 이메일을 찾을 수 없어요(비로그인 접수 등)."); return; }
          location.href = `mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
        } catch (ex) { alert(ex instanceof Error ? ex.message : String(ex)); }
        finally { setBusy(false); }
      }}>📧 메일 안내</button>
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
  const [drafts, setDrafts] = useState<Record<string, { code: string; summary: string; highlights: string; reason: string; verified: boolean }>>({});
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
            verified: false,
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
          proofs: s.payload.proofs ?? [], owner_verified: d.verified,
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
        const d = drafts[s.id] ?? { code: "", summary: "", highlights: "", reason: "", verified: false };
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
                {s.payload.proofs?.length ? <> · 준비 증빙: {s.payload.proofs.join(", ")}</> : null}
              </p>
            )}
            {s.payload.verify_note && (
              <div className="frm-note" style={{ marginBottom: 6 }}>
                🔒 비공개 검증 자료(게시에 복사 금지): <span className="mono" style={{ fontSize: 12 }}>{s.payload.verify_note}</span>
                <label className="facet-opt" style={{ fontSize: 12.5, marginTop: 4 }}>
                  <input type="checkbox" checked={d.verified} onChange={() => set({ verified: !d.verified })} />
                  검증 자료 확인 완료 — 게시 시 <b>운영자 확인 ✓</b> 배지 부여
                </label>
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
              <MailButton kind="deal_submission" refId={s.id}
                subject="[세모플] 매각 접수 검수 결과 안내"
                body={`안녕하세요, 세모플입니다.\n\n매각 접수 건의 검수 결과를 안내드립니다.\n\n결과: (게시/보류/반려)\n사유: ${d.reason || "-"}\n\n게시된 경우 관심자가 나타나면 소개 진행 여부를 이메일로 확인드립니다.\n감사합니다.`} />
            </div>
          </div>
        );
      })}
    </>
  );
}

/* ── 매물 익명 Q&A 답변 큐 (0022) — pending 질문에 매도자 확인을 거쳐 답변 입력 →
 * answered로 게시(공개 뷰는 질문자 신원 컬럼 자체가 없음). 부적절 질문은 hidden. ── */
function DealQAQueue() {
  const [items, setItems] = useState<PendingDealQ[] | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");
  const [errs, setErrs] = useState<Record<string, string>>({});
  const reload = useCallback(() => {
    listPendingDealQuestions().then(setItems).catch(() => setItems(null));
  }, []);
  useEffect(reload, [reload]);
  const act = async (q: PendingDealQ, hide: boolean) => {
    const a = (answers[q.id] ?? "").trim();
    if (!hide && !a) { setErrs((e) => ({ ...e, [q.id]: "답변을 입력하세요 — 게시는 답변과 함께만 됩니다." })); return; }
    // 답변에도 연락처·신원 유추 표현이 실리면 안 됨(공개 게시물)
    if (!hide) {
      const anon = checkAnonymity(a);
      if (anon.length > 0) { setErrs((e) => ({ ...e, [q.id]: `익명성 점검: ${anon.map((f) => `"${f.snippet}"`).join(" · ")} — 수정 후 게시하세요.` })); return; }
    }
    setErrs((e) => ({ ...e, [q.id]: "" })); setBusy(q.id);
    try { await answerDealQuestion(q.id, a, hide); reload(); }
    catch (ex) { setErrs((e) => ({ ...e, [q.id]: ex instanceof Error ? ex.message : String(ex) })); }
    finally { setBusy(""); }
  };
  if (items === null) return <div className="empty">질문 큐를 불러오지 못했어요(0022 마이그레이션 필요 여부 확인).</div>;
  if (items.length === 0) return <div className="empty">대기 중인 매물 질문이 없습니다 ✓</div>;
  return (
    <>
      {items.map((q) => (
        <div className="admin-card" key={q.id}>
          <div className="admin-card-h">
            <b>💬 {q.deal_id}</b>
            <span className="mono" style={{ color: "var(--faint)", fontSize: 11, marginLeft: "auto" }}>{q.created_at.slice(0, 10)}</span>
          </div>
          <p style={{ margin: "6px 0", fontSize: 13 }}>{q.question}</p>
          <div className="frm-note" style={{ marginBottom: 6 }}>매도자에게 확인 후 답변을 입력하세요 — 게시되면 질문·답변만 익명으로 공개됩니다.</div>
          <div className="admin-form">
            <label style={{ flex: 1, minWidth: 260 }}>답변
              <input value={answers[q.id] ?? ""} onChange={(e) => setAnswers((r) => ({ ...r, [q.id]: e.target.value }))} maxLength={400}
                placeholder="예: 매도자 확인 결과, 주요 매출은 자체몰 비중이 높습니다(밴드 표현만)." />
            </label>
          </div>
          {errs[q.id] && <div className="err">{errs[q.id]}</div>}
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button className="btn primary sm" disabled={busy === q.id} onClick={() => act(q, false)}>✓ 답변 게시</button>
            <button className="btn ghost sm" disabled={busy === q.id} onClick={() => act(q, true)}>숨김(게시 안 함)</button>
          </div>
        </div>
      ))}
    </>
  );
}

/* ── ⭐ 리뷰 검수 큐(0025) — pending 후기를 게시(published)/숨김(hidden). 공개는 익명(작성자 비노출). ── */
function ReviewQueue() {
  const [items, setItems] = useState<PendingReview[] | null>(null);
  const [busy, setBusy] = useState("");
  const reload = useCallback(() => {
    listPendingReviews().then(setItems).catch(() => setItems(null));
  }, []);
  useEffect(reload, [reload]);
  const act = async (id: string, publish: boolean) => {
    setBusy(id);
    try { await moderateReview(id, publish); reload(); }
    catch (ex) { alert(ex instanceof Error ? ex.message : String(ex)); }
    finally { setBusy(""); }
  };
  if (items === null) return <div className="empty">리뷰 큐를 불러오지 못했어요(0025 마이그레이션 필요 여부 확인).</div>;
  if (items.length === 0) return <div className="empty">대기 중인 후기가 없습니다 ✓</div>;
  return (
    <>
      {items.map((r) => {
        const p = localPlatforms.find((x) => x.id === r.platform_id);
        const anon = checkAnonymity(r.body);
        return (
          <div className="sub-item" key={r.id} style={{ alignItems: "flex-start" }}>
            <div style={{ minWidth: 0 }}>
              <b>{p?.name ?? r.platform_id}</b>{" "}
              <span style={{ color: "var(--brand)", fontSize: 13 }}>{"★".repeat(r.rating)}{"☆".repeat(5 - r.rating)}</span>{" "}
              <span className="mono" style={{ color: "var(--faint)", fontSize: 11 }}>{r.created_at.slice(0, 10)}</span>
              <p style={{ margin: "4px 0 0", fontSize: 13 }}>{r.body}</p>
              {anon.length > 0 && (
                <div className="frm-note">🕶️ 점검: {anon.map((f) => `"${f.snippet}" (${f.hint})`).join(" · ")} — 연락처·광고성이면 숨김 처리하세요.</div>
              )}
            </div>
            <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
              <button className="btn primary sm" disabled={busy === r.id} onClick={() => act(r.id, true)}>✓ 게시</button>
              <button className="btn ghost sm" disabled={busy === r.id} onClick={() => act(r.id, false)}>숨김</button>
            </div>
          </div>
        );
      })}
    </>
  );
}

/* ── 🚩 신고 큐(0028) — 회원 신고를 확인하고 해결/기각. 조치(숨김·삭제·상태 변경)는 각 큐·패널에서. ── */
const REPORT_TYPE_KO: Record<ReportRow["target_type"], string> = {
  review: "리뷰", partner_post: "제휴 제안", deal: "매물", platform_news: "소식 기사", platform: "플랫폼",
};
function ReportQueue() {
  const go = useNav();
  const [items, setItems] = useState<ReportRow[] | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");
  const reload = useCallback(() => {
    listReports().then(setItems).catch(() => setItems(null));
  }, []);
  useEffect(reload, [reload]);
  const act = async (id: string, status: "resolved" | "dismissed") => {
    setBusy(id);
    try { await resolveReport(id, status, notes[id] ?? ""); reload(); }
    catch (ex) { alert(ex instanceof Error ? ex.message : String(ex)); }
    finally { setBusy(""); }
  };
  /* 대상 내용 미리보기 — admin RLS로 원본 조회(리뷰·제휴는 관리자만 열람 가능) */
  const loadPreview = async (r: ReportRow) => {
    try {
      let text = "(내용 없음)";
      if (r.target_type === "review") {
        const rows = await rest<{ body: string; status: string; platform_id: string }[]>(`reviews?id=eq.${r.target_id}&select=body,status,platform_id`);
        text = rows[0] ? `[${rows[0].status}] ${rows[0].platform_id} — ${rows[0].body}` : "(삭제됨)";
      } else if (r.target_type === "partner_post") {
        const rows = await rest<{ title: string; status: string }[]>(`partner_posts?id=eq.${r.target_id}&select=title,status`);
        text = rows[0] ? `[${rows[0].status}] ${rows[0].title}` : "(삭제됨)";
      } else if (r.target_type === "platform_news") {
        const rows = await rest<{ title: string; url: string }[]>(`platform_news?id=eq.${r.target_id}&select=title,url`);
        text = rows[0] ? `${rows[0].title} (${rows[0].url})` : "(삭제됨)";
      }
      setPreviews((p) => ({ ...p, [r.id]: text }));
    } catch { setPreviews((p) => ({ ...p, [r.id]: "(조회 실패)" })); }
  };
  if (items === null) return <div className="empty">신고 큐를 불러오지 못했어요(0028 마이그레이션 필요 여부 확인).</div>;
  if (items.length === 0) return <div className="empty">대기 중인 신고가 없습니다 ✓</div>;
  return (
    <>
      {items.map((r) => (
        <div className="admin-card" key={r.id}>
          <div className="admin-card-h">
            <b>🚩 {REPORT_TYPE_KO[r.target_type]}</b>
            <span className="mono" style={{ fontSize: 11 }}>{r.target_id}</span>
            <span className="mono" style={{ color: "var(--faint)", fontSize: 11, marginLeft: "auto" }}>{r.created_at.slice(0, 10)}</span>
          </div>
          <p style={{ margin: "6px 0", fontSize: 13 }}><b>신고 사유</b> — {r.reason}</p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 6 }}>
            {(r.target_type === "review" || r.target_type === "partner_post" || r.target_type === "platform_news") && (
              previews[r.id]
                ? <span className="frm-note" style={{ flexBasis: "100%" }}>대상: {previews[r.id]}</span>
                : <button className="linklike" style={{ fontSize: 12.5 }} onClick={() => loadPreview(r)}>대상 내용 보기</button>
            )}
            {r.target_type === "deal" && <button className="linklike" style={{ fontSize: 12.5 }} onClick={() => go("deal", { id: r.target_id })}>매물 페이지 →</button>}
            {r.target_type === "platform" && <button className="linklike" style={{ fontSize: 12.5 }} onClick={() => go("detail", { id: r.target_id })}>플랫폼 상세 →</button>}
          </div>
          <div className="frm-note" style={{ marginBottom: 6 }}>
            조치가 필요하면 해당 큐·패널에서 처리하세요(리뷰 → 게시된 리뷰 관리, 소식 → 소식 관리, 제휴·매물 → 게시 중).
          </div>
          <div className="admin-form">
            <label style={{ flex: 1, minWidth: 260 }}>처리 메모(선택 — 이력 근거)
              <input value={notes[r.id] ?? ""} onChange={(e) => setNotes((n) => ({ ...n, [r.id]: e.target.value }))} maxLength={300}
                placeholder="예: 후기 숨김 처리함 / 확인 결과 문제 없음" />
            </label>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button className="btn primary sm" disabled={busy === r.id} onClick={() => act(r.id, "resolved")}>✓ 해결(조치함)</button>
            <button className="btn ghost sm" disabled={busy === r.id} onClick={() => act(r.id, "dismissed")}>기각(문제 없음)</button>
          </div>
        </div>
      ))}
    </>
  );
}

/* ── 📬 문의 큐(0028) — open 문의에 답변 → answered + 인앱 알림 ── */
function InquiryQueue() {
  const [items, setItems] = useState<Inquiry[] | null>(null);
  const [replies, setReplies] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");
  const [errs, setErrs] = useState<Record<string, string>>({});
  const reload = useCallback(() => {
    listOpenInquiries().then(setItems).catch(() => setItems(null));
  }, []);
  useEffect(reload, [reload]);
  const act = async (i: Inquiry) => {
    const text = (replies[i.id] ?? "").trim();
    if (text.length < 5) { setErrs((e) => ({ ...e, [i.id]: "답변을 5자 이상 입력하세요." })); return; }
    setErrs((e) => ({ ...e, [i.id]: "" })); setBusy(i.id);
    try { await replyInquiry(i.id, i.user_id!, text); reload(); }
    catch (ex) { setErrs((e) => ({ ...e, [i.id]: ex instanceof Error ? ex.message : String(ex) })); }
    finally { setBusy(""); }
  };
  if (items === null) return <div className="empty">문의 큐를 불러오지 못했어요(0028 마이그레이션 필요 여부 확인).</div>;
  if (items.length === 0) return <div className="empty">대기 중인 문의가 없습니다 ✓</div>;
  return (
    <>
      {items.map((i) => (
        <div className="admin-card" key={i.id}>
          <div className="admin-card-h">
            <b>📬 {i.title}</b>
            <span className="mono" style={{ color: "var(--faint)", fontSize: 11, marginLeft: "auto" }}>{i.created_at.slice(0, 10)}</span>
          </div>
          <p style={{ margin: "6px 0", fontSize: 13, whiteSpace: "pre-wrap" }}>{i.body}</p>
          <div className="admin-form">
            <label style={{ flex: 1, minWidth: 260 }}>답변(회원에게 인앱 알림으로 전달)
              <textarea rows={3} value={replies[i.id] ?? ""} onChange={(e) => setReplies((r) => ({ ...r, [i.id]: e.target.value }))} maxLength={2000} />
            </label>
          </div>
          {errs[i.id] && <div className="err">{errs[i.id]}</div>}
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button className="btn primary sm" disabled={busy === i.id} onClick={() => act(i)}>✓ 답변 완료</button>
          </div>
        </div>
      ))}
    </>
  );
}

/* ── 🗞 소식 관리(0027·0028) — 자동 수집된 기사 오탐 삭제(공개 피드라 대응 시급) ── */
function NewsPanel() {
  const [items, setItems] = useState<(PlatformNews & { platform_id: string; created_at: string })[] | null>(null);
  const [busy, setBusy] = useState(0);
  const reload = useCallback(() => {
    listRecentPlatformNews().then(setItems).catch(() => setItems(null));
  }, []);
  useEffect(reload, [reload]);
  if (items === null) return <div className="empty">소식을 불러오지 못했어요(0027 마이그레이션 필요 여부 확인).</div>;
  if (items.length === 0) return <div className="empty">수집된 소식이 아직 없습니다 — 주간 수집기가 채웁니다.</div>;
  return (
    <details>
      <summary style={{ cursor: "pointer", fontSize: 13.5, marginBottom: 8 }}>최근 수집 {items.length}건 펼치기 — 오탐(다른 회사 기사)은 삭제하세요</summary>
      <div className="sub-list">
        {items.map((n) => (
          <div className="sub-item" key={n.id}>
            <div style={{ minWidth: 0 }}>
              <b className="mono" style={{ fontSize: 12 }}>{n.platform_id}</b>{" "}
              <a href={n.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 13 }}>{n.title} ↗</a>
              <div className="frm-note">{n.source} · 수집 {n.created_at.slice(0, 10)}</div>
            </div>
            <button className="btn ghost sm" disabled={busy === n.id} style={{ flexShrink: 0 }}
              onClick={async () => {
                if (!confirm(`이 기사를 ${n.platform_id} 소식에서 삭제할까요?`)) return;
                setBusy(n.id);
                try { await deletePlatformNews(n.id); reload(); }
                catch (ex) { alert(ex instanceof Error ? ex.message : String(ex)); }
                finally { setBusy(0); }
              }}>삭제</button>
          </div>
        ))}
      </div>
    </details>
  );
}

/* ── 🧹 게시된 리뷰 관리(0028) — 사후 문제(신고 등) 발생 시 재숨김(moderateReview 재사용) ── */
function PublishedReviewsPanel() {
  const [items, setItems] = useState<PendingReview[] | null>(null);
  const [busy, setBusy] = useState("");
  const reload = useCallback(() => {
    listPublishedReviews().then(setItems).catch(() => setItems(null));
  }, []);
  useEffect(reload, [reload]);
  if (items === null) return <div className="empty">게시된 리뷰를 불러오지 못했어요.</div>;
  if (items.length === 0) return <div className="empty">게시 중인 리뷰가 없습니다.</div>;
  return (
    <details>
      <summary style={{ cursor: "pointer", fontSize: 13.5, marginBottom: 8 }}>게시 중 {items.length}건 펼치기 — 신고된 후기는 여기서 숨깁니다</summary>
      <div className="sub-list">
        {items.map((r) => (
          <div className="sub-item" key={r.id} style={{ alignItems: "flex-start" }}>
            <div style={{ minWidth: 0 }}>
              <b>{localPlatforms.find((x) => x.id === r.platform_id)?.name ?? r.platform_id}</b>{" "}
              <span style={{ color: "var(--brand)", fontSize: 13 }}>{"★".repeat(r.rating)}</span>{" "}
              <span className="mono" style={{ color: "var(--faint)", fontSize: 11 }}>{r.id.slice(0, 8)} · {r.created_at.slice(0, 10)}</span>
              <p style={{ margin: "4px 0 0", fontSize: 13 }}>{r.body}</p>
            </div>
            <button className="btn ghost sm" disabled={busy === r.id} style={{ flexShrink: 0 }}
              onClick={async () => {
                if (!confirm("이 후기를 숨길까요? (공개 목록·평점에서 제외)")) return;
                setBusy(r.id);
                try { await moderateReview(r.id, false); reload(); }
                catch (ex) { alert(ex instanceof Error ? ex.message : String(ex)); }
                finally { setBusy(""); }
              }}>숨김</button>
          </div>
        ))}
      </div>
    </details>
  );
}

/* ── 👥 회원 관리(0028) — 이메일·이름·ID 검색 + 정지 토글(쓰기만 차단, 읽기·로그인 유지) ── */
function MembersPanel() {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<AdminMember[] | null>(null);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const search = async () => {
    setErr("");
    try { setRows(await searchAdminMembers(q)); }
    catch (ex) { setErr(ex instanceof Error ? ex.message : String(ex)); setRows(null); }
  };
  const toggle = async (m: AdminMember) => {
    const suspend = !m.suspended_at;
    const label = suspend ? "정지" : "정지 해제";
    if (!confirm(`${m.email ?? m.id}\n이 회원을 ${label}할까요?\n(정지 = 새 글·신청·문의 작성만 차단, 열람·로그인은 유지 — 이의 제기 가능)`)) return;
    setBusy(m.id); setErr("");
    try { await setMemberSuspended(m.id, suspend); await search(); }
    catch (ex) { setErr(ex instanceof Error ? ex.message : String(ex)); }
    finally { setBusy(""); }
  };
  return (
    <>
      <div className="admin-form" style={{ marginBottom: 8 }}>
        <label style={{ flex: 1, minWidth: 240 }}>이메일 · 이름 · 회원 ID 검색
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="예: user@example.com"
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void search(); } }} />
        </label>
        <button className="btn sm" onClick={search} style={{ alignSelf: "flex-end" }}>검색</button>
      </div>
      {err && <div className="err">{err}</div>}
      {rows === null ? <div className="frm-note">스팸·악성 계정 대응: 검색 → 콘텐츠 수 확인 → 정지. (0028 마이그레이션 필요)</div>
        : rows.length === 0 ? <div className="empty">검색 결과가 없습니다.</div>
        : (
          <div className="sub-list">
            {rows.map((m) => (
              <div className="sub-item" key={m.id}>
                <div style={{ minWidth: 0 }}>
                  <b>{m.email ?? "(이메일 없음)"}</b>{" "}
                  {m.display_name && <span className="faint">{m.display_name}</span>}{" "}
                  {m.role === "admin" && <Badge kind="verify">admin</Badge>}
                  {m.suspended_at && <Badge kind="muted">⛔ 정지 중 ({m.suspended_at.slice(0, 10)}~)</Badge>}
                  <div className="frm-note">
                    가입 {m.created_at.slice(0, 10)} · 제보 {m.submissions} · 제휴 {m.partner_posts} · 매각 {m.deal_subs} · 리뷰 {m.reviews}
                    {" · "}<span className="mono" style={{ fontSize: 10.5 }}>{m.id}</span>
                  </div>
                </div>
                {m.role !== "admin" && (
                  <button className={`btn sm ${m.suspended_at ? "" : "ghost"}`} disabled={busy === m.id} style={{ flexShrink: 0 }}
                    onClick={() => toggle(m)}>{m.suspended_at ? "정지 해제" : "정지"}</button>
                )}
              </div>
            ))}
          </div>
        )}
    </>
  );
}

/* ── ⚙️ 운영 스위치(app_settings) — SQL 없이 콘솔에서 토글(0011 admin write RLS).
 * boolean 값은 체크박스, 그 외는 JSON 직접 편집(파스 검증 후 저장). */
const SETTING_HINTS: Record<string, string> = {
  billing: "과금 스위치(스폰서·연결료·멤버십·리스팅·bank 계좌) — 켜면 실제 결제 안내가 노출됩니다",
  prices: "가격표(원) — 변경 즉시 반영",
  autolist: "수집기 자동 등재 — collector_id가 봇 uid와 일치할 때만 동작",
  notify_email: "알림 이메일 발송 — Edge Function·SMTP 준비 후에만 켜세요",
  outreach: "제휴 제안 서버 발송 — 발신 도메인 인증 후에만 켜세요",
  pricing_announced_at: "유료화 공지일(YYYY-MM-DD 문자열) — 설정 시 30일 배너 노출",
};
function SettingsPanel() {
  const [rows, setRows] = useState<AppSetting[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState<Record<string, string>>({});
  const reload = useCallback(() => {
    listAppSettings().then(setRows).catch(() => setRows(null));
  }, []);
  useEffect(reload, [reload]);
  if (rows === null) return <div className="empty">설정을 불러오지 못했어요.</div>;
  const saveJson = async (key: string) => {
    const draft = drafts[key];
    if (draft === undefined) return;
    let parsed: unknown;
    try { parsed = JSON.parse(draft); }
    catch { setMsg((m) => ({ ...m, [key]: "JSON 형식이 아니에요 — 저장 취소" })); return; }
    setBusy(key);
    try { await updateAppSetting(key, parsed as Record<string, unknown>); setMsg((m) => ({ ...m, [key]: "저장됨 ✓" })); reload(); }
    catch (ex) { setMsg((m) => ({ ...m, [key]: ex instanceof Error ? ex.message : String(ex) })); }
    finally { setBusy(""); }
  };
  const toggleBool = async (key: string, obj: Record<string, unknown>, sub: string) => {
    const next = { ...obj, [sub]: !obj[sub] };
    setBusy(key);
    try { await updateAppSetting(key, next); reload(); }
    catch (ex) { setMsg((m) => ({ ...m, [key]: ex instanceof Error ? ex.message : String(ex) })); }
    finally { setBusy(""); }
  };
  return (
    <>
      <div className="frm-note" style={{ marginBottom: 8 }}>
        ⚠ 이 스위치들은 <b>실제 과금·발송·자동 등재</b>를 켭니다 — 켜기 전 README의 게이트 체크리스트를 확인하세요.
      </div>
      {rows.map((s) => {
        const isObj = s.value !== null && typeof s.value === "object" && !Array.isArray(s.value);
        const obj = isObj ? (s.value as Record<string, unknown>) : null;
        const bools = obj ? Object.keys(obj).filter((k) => typeof obj[k] === "boolean") : [];
        return (
          <div className="admin-card" key={s.key}>
            <div className="admin-card-h"><b className="mono">{s.key}</b>
              {SETTING_HINTS[s.key] && <span className="faint" style={{ fontSize: 12 }}>{SETTING_HINTS[s.key]}</span>}
            </div>
            {bools.length > 0 && (
              <div style={{ display: "flex", gap: 14, flexWrap: "wrap", margin: "6px 0" }}>
                {bools.map((b) => (
                  <label key={b} className="facet-opt" style={{ fontSize: 13 }}>
                    <input type="checkbox" checked={obj![b] === true} disabled={busy === s.key}
                      onChange={() => toggleBool(s.key, obj!, b)} /> {b}
                  </label>
                ))}
              </div>
            )}
            <details>
              <summary style={{ cursor: "pointer", fontSize: 12.5, color: "var(--faint)" }}>JSON 직접 편집</summary>
              <div className="admin-form" style={{ marginTop: 6 }}>
                <textarea rows={3} className="mono" style={{ flex: 1, fontSize: 12 }}
                  value={drafts[s.key] ?? JSON.stringify(s.value, null, 1)}
                  onChange={(e) => setDrafts((d) => ({ ...d, [s.key]: e.target.value }))} />
              </div>
              <button className="btn sm" style={{ marginTop: 6 }} disabled={busy === s.key} onClick={() => saveJson(s.key)}>저장</button>
            </details>
            {msg[s.key] && <div className="frm-note">{msg[s.key]}</div>}
          </div>
        );
      })}
    </>
  );
}

/* ── 🗂 최근 처리 내역 — 각 큐의 처리분 취합(분쟁·문의 대응 근거, 별도 테이블 없음) ── */
function RecentProcessedPanel() {
  const [items, setItems] = useState<ProcessedItem[] | null>(null);
  useEffect(() => { listRecentProcessed().then(setItems).catch(() => setItems([])); }, []);
  if (items === null) return <div className="empty">불러오는 중…</div>;
  if (items.length === 0) return <div className="empty">아직 처리 내역이 없습니다.</div>;
  const STATUS_KO: Record<string, string> = {
    approved: "승인", rejected: "반려", hold: "보류", published: "게시", hidden: "숨김", closed: "마감", matched: "성사",
  };
  return (
    <details>
      <summary style={{ cursor: "pointer", fontSize: 13.5, marginBottom: 8 }}>최근 처리 {items.length}건 펼치기 (제보·제휴·매각·리뷰)</summary>
      <div className="sub-list">
        {items.map((it) => (
          <div className="sub-item" key={`${it.kind}:${it.id}`}>
            <div style={{ minWidth: 0 }}>
              <Badge kind="muted">{it.kind}</Badge> <b style={{ fontSize: 13 }}>{it.label}</b>{" "}
              <span className="mono" style={{ fontSize: 11, color: "var(--faint)" }}>{it.at ? it.at.slice(0, 10) : ""}</span>
              <span style={{ fontSize: 12.5, marginLeft: 6 }}>→ {STATUS_KO[it.status] ?? it.status}</span>
              {it.reason && <div className="frm-note">사유: {it.reason}</div>}
            </div>
          </div>
        ))}
      </div>
    </details>
  );
}

/* ── 💳 과금 운영(0011·0012) — 전 청구 뷰(v_admin_charges) 기반: 입금 대기·취소·결제 완료·환불.
 * FLAGS와 무관하게 상시 렌더(오픈 전 리허설) — 권한은 RLS is_admin이 강제. */
const chargeKindLabel = (c: { kind: string; fee_tier: string | null }) =>
  c.kind === "boost" ? "스폰서" : c.kind === "subscription" ? "Pro 구독" : `연결료 ${c.fee_tier ?? ""}형`;

/* tick/bump — 입금 확인·슬롯 배정·환불이 서로의 목록(배정 대기·환불 대상)에 즉시 반영되게
 * 하는 형제 패널 간 갱신 신호(새로고침 없이 다음 행동으로 이어지도록). */
function BillingQueuePanel({ tick, bump }: { tick: number; bump: () => void }) {
  const [rows, setRows] = useState<AdminChargeRow[] | null>(null);
  const [loadErr, setLoadErr] = useState(false);
  const [dep, setDep] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");
  const reload = useCallback(() => {
    setLoadErr(false);
    listAdminCharges().then(setRows).catch(() => { setRows(null); setLoadErr(true); });
  }, []);
  useEffect(reload, [reload, tick]);
  if (loadErr) return <div className="empty">청구 목록을 불러오지 못했어요(0012 마이그레이션 필요 여부 확인). <button className="linklike" onClick={reload}>다시 시도</button></div>;
  if (rows === null) return <div className="empty">불러오는 중…</div>;
  const waiting = rows.filter((c) => c.status === "awaiting_deposit");
  if (waiting.length === 0) return <div className="empty">입금 대기 건이 없습니다 ✓</div>;
  return (
    <>
      {waiting.map((c) => {
        const total = c.amount + c.vat;
        const overdue = c.deposit_deadline && c.deposit_deadline < new Date().toISOString().slice(0, 10);
        return (
          <div className="sub-item" key={c.id}>
            <div style={{ minWidth: 0 }}>
              💳 <b>{chargeKindLabel(c)}</b>
              {" — "}{total.toLocaleString()}원(VAT포함) · {c.user_email ?? "이메일 없음"}
              {c.discount_rate != null && <Badge kind="soon">파운더 50%</Badge>}
              <div className="frm-note">
                {c.memo ?? ""}{c.depositor_hint && <> · 안내한 입금자명 <b>{c.depositor_hint}</b></>}
                {" · 기한 "}<span style={overdue ? { color: "var(--danger)" } : undefined}>{c.deposit_deadline ?? "-"}</span>
                {overdue && " ⚠ 기한 초과 — 미입금 취소 검토"}
              </div>
            </div>
            <div style={{ display: "flex", gap: 6, flexShrink: 0, alignItems: "center", flexWrap: "wrap" }}>
              <input style={{ width: 110 }} placeholder="입금자명" value={dep[c.id] ?? ""}
                onChange={(e) => setDep((d) => ({ ...d, [c.id]: e.target.value }))} />
              <button className="btn primary sm" disabled={busy === c.id || !(dep[c.id] ?? "").trim()}
                title="입금자명 대조 후 확인 — 현금영수증·세금계산서는 홈택스 수기 발행 후 메모"
                onClick={async () => {
                  setBusy(c.id);
                  try { await confirmDeposit(c.id, dep[c.id].trim()); bump(); }
                  catch (ex) { alert(ex instanceof Error ? ex.message : String(ex)); }
                  finally { setBusy(""); }
                }}>✓ 입금 확인</button>
              <button className="btn ghost sm" disabled={busy === c.id}
                title="미입금·착오 주문 취소 — 사용자 화면에는 '취소됨'으로 표시"
                onClick={async () => {
                  if (!window.confirm(`${chargeKindLabel(c)} ${total.toLocaleString()}원 주문을 취소할까요?`)) return;
                  setBusy(c.id);
                  try { await cancelCharge(c.id, overdue ? "기한 내 미입금 — 취소" : "운영자 취소"); bump(); }
                  catch (ex) { alert(ex instanceof Error ? ex.message : String(ex)); }
                  finally { setBusy(""); }
                }}>취소</button>
            </div>
          </div>
        );
      })}
    </>
  );
}

function SponsorSlotsPanel({ tick, bump }: { tick: number; bump: () => void }) {
  const [slots, setSlots] = useState<SponsorSlotAdmin[]>([]);
  const [loadErr, setLoadErr] = useState(false);
  const [posts, setPosts] = useState<PartnerPostAdmin[]>([]);
  const [paidBoosts, setPaidBoosts] = useState<AdminChargeRow[]>([]);
  const [form, setForm] = useState({ slot_no: "1", post: "", user: "", charge: "", starts: "", ends: "" });
  const [msg, setMsg] = useState("");
  const reload = useCallback(() => {
    setLoadErr(false);
    listSponsorSlotsAdmin().then(setSlots).catch(() => { setSlots([]); setLoadErr(true); });
    listPartnerPosts(["published", "matched"]).then(setPosts).catch(() => setPosts([]));
    // 입금 확인됐지만 아직 슬롯이 없는 스폰서 청구 — 여기서 선택하면 폼이 자동으로 채워진다
    listAdminCharges().then((cs) => setPaidBoosts(cs.filter((c) => c.kind === "boost" && c.status === "paid" && !c.has_slot))).catch(() => setPaidBoosts([]));
  }, []);
  useEffect(reload, [reload, tick]);
  const today = new Date().toISOString().slice(0, 10);
  const active = slots.filter((sl) => sl.starts_on <= today && sl.ends_on >= today);
  const fillFromCharge = (c: AdminChargeRow) => {
    const postId = c.memo?.startsWith("post:") ? c.memo.slice(5) : "";
    const starts = today;
    const ends = new Date(Date.now() + 29 * 86400000).toISOString().slice(0, 10); // 기본 30일 게재
    setForm({ slot_no: form.slot_no, post: postId, user: c.user_id ?? "", charge: c.id, starts, ends });
    setMsg("");
  };
  return (
    <div className="admin-card">
      {loadErr && <div className="err">슬롯 목록을 불러오지 못했어요 — 아래 현황이 실제와 다를 수 있습니다. <button className="linklike" onClick={reload}>다시 시도</button></div>}
      <div className="frm-note">활성 슬롯 {active.length}/2 — 기간 충돌·3번째 슬롯은 DB 제약이 거부합니다.</div>
      {paidBoosts.map((c) => (
        <div className="sub-item" key={c.id}>
          <div style={{ minWidth: 0 }}>💰 <b>배정 대기</b> — {(c.amount + c.vat).toLocaleString()}원 · {c.user_email ?? "이메일 없음"} · 결제 {c.paid_at?.slice(0, 10)}
            <div className="frm-note">⚠ 결제됐지만 슬롯 미배정 — 게재하거나, 게재 불가 시 아래 환불 패널에서 처리</div>
          </div>
          <button className="btn ghost sm" onClick={() => fillFromCharge(c)}>폼에 채우기 ↓</button>
        </div>
      ))}
      {slots.slice(0, 6).map((sl) => (
        <div className="sub-item" key={sl.id}>
          <div>🪧 슬롯 {sl.slot_no} — {partnerRefCode(sl.partner_post_id)} · {sl.starts_on} ~ {sl.ends_on}</div>
          <Badge kind={sl.starts_on <= today && sl.ends_on >= today ? "good" : "muted"}>
            {sl.starts_on <= today && sl.ends_on >= today ? "게재 중" : sl.starts_on > today ? "예약" : "만료"}</Badge>
        </div>
      ))}
      <div className="admin-form">
        <label>슬롯
          <select value={form.slot_no} onChange={(e) => setForm({ ...form, slot_no: e.target.value })}>
            <option value="1">1</option><option value="2">2</option>
          </select>
        </label>
        <label style={{ flex: 1, minWidth: 160 }}>게시 제안
          <select value={form.post} onChange={(e) => { const p = posts.find((x) => x.id === e.target.value); setForm({ ...form, post: e.target.value }); if (p) setMsg(""); }}>
            <option value="">선택</option>
            {posts.map((p) => <option key={p.id} value={p.id}>{p.title} ({partnerRefCode(p.id)})</option>)}
          </select>
        </label>
        <label>스폰서 user_id <input value={form.user} onChange={(e) => setForm({ ...form, user: e.target.value })} placeholder="위 '폼에 채우기'로 자동 입력" /></label>
        <label>시작 <input type="date" value={form.starts} onChange={(e) => setForm({ ...form, starts: e.target.value })} /></label>
        <label>종료 <input type="date" value={form.ends} onChange={(e) => setForm({ ...form, ends: e.target.value })} /></label>
      </div>
      {msg && <div className="err">{msg}</div>}
      <div style={{ marginTop: 8 }}>
        <button className="btn primary sm" disabled={!form.post || !form.user || !form.starts || !form.ends}
          title={form.charge ? `청구 ${form.charge.slice(0, 8)}와 연결됨` : "청구 미연결 배정(수동)"}
          onClick={async () => {
            setMsg("");
            try {
              await createSponsorSlot({ slot_no: Number(form.slot_no), partner_post_id: form.post, sponsor_user_id: form.user.trim(),
                starts_on: form.starts, ends_on: form.ends, ...(form.charge ? { charge_id: form.charge } : {}) });
              setForm({ slot_no: "1", post: "", user: "", charge: "", starts: "", ends: "" });
              bump();
            } catch (ex) { setMsg(ex instanceof Error ? ex.message : String(ex)); }
          }}>슬롯 배정</button>
      </div>
    </div>
  );
}

function SubsPanel() {
  const [rows, setRows] = useState<SubscriptionAdmin[] | null>(null);
  const [loadErr, setLoadErr] = useState(false);
  const reload = useCallback(() => {
    setLoadErr(false);
    listSubscriptionsAdmin().then(setRows).catch(() => { setRows(null); setLoadErr(true); });
  }, []);
  useEffect(reload, [reload]);
  if (loadErr) return <div className="empty">구독 목록을 불러오지 못했어요. <button className="linklike" onClick={reload}>다시 시도</button></div>;
  if (rows === null) return <div className="empty">불러오는 중…</div>;
  if (rows.length === 0) return <div className="empty">구독이 없습니다.</div>;
  const now = Date.now();
  const soon = (d: string | null) => d && new Date(d).getTime() - now < 7 * 86400000;
  const expired = (r: SubscriptionAdmin) => r.status === "active" && r.current_period_end && new Date(r.current_period_end).getTime() < now;
  return (
    <>
      {rows.map((r) => (
        <div className="sub-item" key={r.id}>
          <div>👑 {r.plan_id} · <span className="mono" style={{ fontSize: 11 }}>{(r.user_id ?? "").slice(0, 8)}</span>
            {" · "}주기말 <span style={soon(r.current_period_end) ? { color: "var(--warn)" } : undefined}>{r.current_period_end?.slice(0, 10) ?? "-"}</span>
            {" · "}{(r.price_snapshot ?? 0).toLocaleString()}원</div>
          <Badge kind={expired(r) ? "muted" : r.status === "active" ? "good" : r.status === "past_due" ? "soon" : "muted"}>
            {expired(r) ? "기간 만료(갱신 대기)" : r.status}</Badge>
        </div>
      ))}
      <div className="frm-note">만료된 구독은 배지·혜택이 자동 중지됩니다(0012 — pro_verified가 주기말을 검사). 갱신 주문이 들어오면 입금 확인 시 기간이 이어집니다.</div>
    </>
  );
}

function RefundPanel({ tick, bump }: { tick: number; bump: () => void }) {
  const [rows, setRows] = useState<AdminChargeRow[] | null>(null);
  const [loadErr, setLoadErr] = useState(false);
  const [busy, setBusy] = useState("");
  const reload = useCallback(() => {
    setLoadErr(false);
    listAdminCharges().then(setRows).catch(() => { setRows(null); setLoadErr(true); });
  }, []);
  useEffect(reload, [reload, tick]);
  if (loadErr) return <div className="empty">청구 목록을 불러오지 못했어요. <button className="linklike" onClick={reload}>다시 시도</button></div>;
  if (rows === null) return <div className="empty">불러오는 중…</div>;
  const paid = rows.filter((c) => c.status === "paid");
  if (paid.length === 0) return <div className="empty">결제 완료(환불 가능) 청구가 없습니다 ✓</div>;
  return (
    <>
      <div className="frm-note">결제 완료 청구 — 미이행·청약철회 시 여기서 환불합니다. 구독 환불은 구독 취소+크레딧 회수, 스폰서 환불은 슬롯 회수가 자동 동반됩니다(0012).</div>
      {paid.map((r) => {
        const total = r.amount + r.vat;
        const unfulfilled = r.kind === "boost" && !r.has_slot;
        return (
          <div className="sub-item" key={r.id}>
            <div style={{ minWidth: 0 }}>↩️ <b>{chargeKindLabel(r)}</b> {total.toLocaleString()}원 · {r.user_email ?? ""} · 결제 {r.paid_at?.slice(0, 10)}
              {unfulfilled && <div className="frm-note" style={{ color: "var(--warn)" }}>⚠ 슬롯 미배정 — 게재 미이행이면 전액 환불 대상(약관 §5)</div>}
            </div>
            <button className="btn ghost sm" disabled={busy === r.id}
              onClick={async () => {
                const reason = window.prompt("환불 사유", unfulfilled ? "게재 미이행 — 전액 환불(약관 §5)" : "서비스 미이행/청약철회 — 전액 환불");
                if (!reason?.trim()) return;
                setBusy(r.id);
                try { await refundCharge(r.id, total, reason.trim()); bump(); }
                catch (ex) { alert(ex instanceof Error ? ex.message : String(ex)); }
                finally { setBusy(""); }
              }}>전액 환불 처리</button>
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
  const [mailed, setMailed] = useState<Set<string>>(new Set()); // 소개 초안을 연 건 표시(참고용)
  const [evid, setEvid] = useState<Record<string, string>>({}); // 발송 증빙 인라인 입력(실패해도 값 유지)
  const [loadErr, setLoadErr] = useState(false);
  const reload = useCallback(() => {
    setLoadErr(false);
    listAdminIntroQueue().then(setRows).catch(() => { setRows(null); setLoadErr(true); });
    listBuyerBriefs().then(setBriefs).catch(() => setBriefs([]));
    listDealsAdmin().then(setDeals).catch(() => setDeals([]));
  }, []);
  useEffect(reload, [reload]);
  /* 소개 완료 = admin_introduce RPC 단일 지점(0011·0012) — 상태·양측 동의 검증 + 이중 실행 방지 + 증빙 필수.
   * connection 스위치가 켜진 경우에만 B/C형 청구가 함께 생성된다(꺼진 지금은 기록만). */
  const done = async (kind: "partner" | "deal", id: string, evidence: string) => {
    try { await adminIntroduce(kind, id, evidence.trim()); reload(); } // 성공 시에만 reload — 실패하면 입력 유지 후 재시도
    catch (ex) { alert(ex instanceof Error ? ex.message : String(ex)); }
  };
  const confirmOwner = async (kind: "partner" | "deal", id: string) => {
    try { await markOwnerConfirmed(kind, id); } catch (ex) { alert(ex instanceof Error ? ex.message : String(ex)); }
    reload();
  };
  /* 진행 불가 정리 — 메일 회신 거절·연락 두절·구버전(동의 없음) 건이 큐에 영구 잔류하지 않게 */
  const declineRow = async (kind: "partner" | "deal", id: string) => {
    if (!window.confirm("이 신청을 '진행 안 함'으로 정리할까요? 신청자에게는 '진행되지 않음'으로 표시됩니다.")) return;
    try { await adminDeclineInterest(kind, id); } catch (ex) { alert(ex instanceof Error ? ex.message : String(ex)); }
    reload();
  };
  const guideUrl = `${location.origin}${import.meta.env.BASE_URL}?view=deal-guide`;
  /* ① 매도자 의사 확인 — 관심자 정보는 익명 요지만, 소개 여부 회신 요청(현황 알림 겸용) */
  const sellerConfirmDraft = (r: IntroQueueRow) => {
    const what = r.kind === "deal" ? `매물 ${r.target_title}에 인수 관심` : `제안 "${r.target_title}"에 매칭 신청`;
    const subject = `[세모플] ${r.target_title} — 소개 진행 여부 회신 요청`;
    const body = `안녕하세요, 세모플입니다.\n\n회원님이 게시하신 ${what} 1건이 접수됐습니다.\n- 신청자 소개(익명 요지): ${r.message}\n\n소개(상호 이메일 공유)를 진행해도 될지 이 메일에 회신으로 알려주세요.\n상대방이 국외 사업자인 경우 별도로 안내드립니다(처리방침 §3).\n진행을 원치 않으시면 사유 없이 "진행하지 않겠습니다"라고만 회신하셔도 됩니다.\n\n세모플 드림`;
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
        const ready = Boolean(r.applicant_email && r.counterpart_email && r.contact_consent_at && r.owner_confirmed_at);
        return (
          <div className="sub-item" key={key}>
            <div style={{ minWidth: 0 }}>
              <b>{r.kind === "partner" ? "🤝 매칭 신청" : "🏦 인수 관심"}</b>
              {" — "}{r.platform_name ? `${r.platform_name} → ` : ""}"{r.target_title}"
              <div className="frm-note">{r.message}</div>
              <div className="mono" style={{ fontSize: 11, color: "var(--faint)" }}>
                {r.applicant_email ?? "이메일 없음"} ↔ {r.counterpart_email ?? "이메일 없음"}
                {r.contact_consent_at ? " · 신청자 동의 ✓" : " · ⚠ 신청자 동의 없음(구버전)"}
                {r.owner_confirmed_at ? " · 제안자 확인 ✓" : " · 제안자 확인 대기"}
              </div>
            </div>
            <div style={{ display: "flex", gap: 6, flexShrink: 0, flexWrap: "wrap" }}>
              {r.counterpart_email && !r.owner_confirmed_at && (
                <a className="btn ghost sm" href={sellerConfirmDraft(r)}
                  title={r.kind === "deal" ? "매도자에게 소개 진행 여부를 확인" : "제안자에게 신청 접수를 알리고 소개 진행 여부를 확인"}>
                  ① {r.kind === "deal" ? "매도자" : "제안자"} 확인
                </a>
              )}
              {!r.owner_confirmed_at && (
                <button className="btn ghost sm" onClick={() => confirmOwner(r.kind, r.id)}
                  title="확인 메일에 '진행' 회신을 받았으면 기록">회신 확인 ✓</button>
              )}
              {ready && (
                <a className="btn primary sm" href={mailDraft(r)} onClick={() => setMailed((s) => new Set(s).add(key))}>
                  {r.kind === "deal" ? "② 소개 초안" : "메일 초안"}{mailed.has(key) ? " ✓" : ""}
                </a>
              )}
              {ready && (
                <input style={{ width: 170 }} placeholder="발송 증빙 — 예: 07-05 발송 P-XXXX"
                  value={evid[key] ?? ""} onChange={(e) => setEvid((s) => ({ ...s, [key]: e.target.value }))} />
              )}
              <button className="btn ghost sm" disabled={!ready || !(evid[key] ?? "").trim()}
                title={!ready ? "양측 이메일·동의가 있어야 소개할 수 있어요" : !(evid[key] ?? "").trim() ? "초안 발송 후 증빙 메모를 입력하세요" : ""}
                onClick={() => done(r.kind, r.id, evid[key])}>소개 완료</button>
              <button className="btn ghost sm" title="회신 거절·연락 두절·구버전(동의 없음) 건 정리 — 신청자에게 '진행되지 않음' 표시"
                onClick={() => declineRow(r.kind, r.id)}>진행 안 함</button>
            </div>
          </div>
        );
      })}
      {briefs.map((b) => {
        // 적합도(scoreBriefDeal) 높은 순 — 소개 우선순위 판단 보조
        const matches = activeDeals.filter((d) => briefMatchesDeal(b, d))
          .map((d) => ({ d, s: scoreBriefDeal(b, d) })).sort((x, y) => y.s - x.s);
        return (
          <div className="sub-item" key={b.id}>
            <div style={{ minWidth: 0 }}>
              <b>📮 인수 브리프</b> — {b.entity} · {b.budget_band} · {b.mode}
              <div className="frm-note">{b.categories.length ? b.categories.join(", ") : "분야 무관"}{b.note ? ` — ${b.note}` : ""}</div>
              <div className="mono" style={{ fontSize: 11, color: matches.length ? "var(--teal)" : "var(--faint)" }}>
                {matches.length ? `맞는 매물(적합도순): ${matches.map((m) => `${m.d.id}(${m.s})`).join(", ")}` : "맞는 매물 없음(게시 중 기준)"}
              </div>
            </div>
            <div style={{ display: "flex", gap: 6, alignItems: "center", flexShrink: 0 }}>
              <span className="mono" style={{ fontSize: 11, color: "var(--faint)" }}>{b.created_at.slice(0, 10)}</span>
              <button className="btn ghost sm" onClick={async () => {
                try { await deactivateBrief(b.id); reload(); }
                catch (ex) { alert(ex instanceof Error ? ex.message : String(ex)); }
              }}>안내 완료</button>
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
  const [loadErr, setLoadErr] = useState(false);
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");
  const reload = useCallback(() => {
    setLoadErr(false);
    listOperatorClaims().then(setItems).catch(() => { setItems(null); setLoadErr(true); });
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
  if (loadErr) return <div className="empty">인증 신청 목록을 불러오지 못했어요. <button className="linklike" onClick={reload}>다시 시도</button></div>;
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
  const [deals, setDeals] = useState<{ id: string; status: string; summary: string; is_demo: boolean; owner_verified?: boolean }[]>([]);
  const [busy, setBusy] = useState("");
  const reload = useCallback(() => {
    listPartnerPosts(["published", "matched"]).then(setPosts).catch(() => setPosts([]));
    listDealsAdmin().then((d) => setDeals(d.filter((x) => !x.is_demo && x.status !== "closed"))).catch(() => setDeals([]));
  }, []);
  useEffect(reload, [reload]);
  const movePost = async (id: string, status: string) => {
    setBusy(id);
    try {
      await reviewPartnerPost(id, { status });
      // 성사·마감 시 남은 pending 신청을 함께 정리(영구 '접수됨' 방치 방지)
      if (status === "matched" || status === "closed") await declinePendingInterests(id).catch(() => { /* noop */ });
      reload();
    } catch (ex) { alert(ex instanceof Error ? ex.message : String(ex)); }
    finally { setBusy(""); }
  };
  const moveDeal = async (id: string, status: "open" | "in_progress" | "closed") => {
    setBusy(id);
    try { await updateDealStatus(id, status); reload(); }
    catch (ex) { alert(ex instanceof Error ? ex.message : String(ex)); }
    finally { setBusy(""); }
  };
  const toggleVerified = async (id: string, verified: boolean) => {
    setBusy(id);
    try { await setDealVerified(id, verified); reload(); }
    catch (ex) { alert(ex instanceof Error ? ex.message : String(ex)); }
    finally { setBusy(""); }
  };
  if (posts.length === 0 && deals.length === 0) return <div className="empty">게시 중인 제안·매물이 없습니다.</div>;
  return (
    <>
      {posts.map((p) => (
        <div className="sub-item" key={p.id}>
          <div style={{ minWidth: 0 }}>
            <b>🤝 {p.title}</b> <span className="mono" style={{ color: "var(--faint)", fontSize: 11 }}>{partnerRefCode(p.id)}</span> <Badge kind={p.status === "matched" ? "good" : "soon"}>{p.status === "matched" ? "성사" : "게시 중"}</Badge>
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
            {d.owner_verified && <Badge kind="verify">운영자 확인 ✓</Badge>}
            <div className="frm-note">{d.summary.slice(0, 60)}</div>
          </div>
          <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
            <button className="btn ghost sm" disabled={busy === d.id} onClick={() => toggleVerified(d.id, !d.owner_verified)}
              title="verify_note(비공개 검증 자료) 확인 후에만 부여하세요">{d.owner_verified ? "확인 해제" : "운영자 확인 ✓"}</button>
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
  const [metrics, setMetrics] = useState<Awaited<ReturnType<typeof fetchAdminMetrics>> | null>(null);
  const [billingTick, setBillingTick] = useState(0); // 과금 3패널(입금·슬롯·환불) 간 갱신 신호
  const bumpBilling = useCallback(() => setBillingTick((t) => t + 1), []);
  const [counts, setCounts] = useState<Awaited<ReturnType<typeof fetchQueueCounts>> | null>(null);

  const reload = useCallback(() => {
    listSubmissions(["pending", "hold"]).then(setQueue).catch(() => setQueue([]));
    getStats().then(setStats).catch(() => { /* noop */ });
    getPendingCount().then(setPending).catch(() => { /* noop */ });
    getPopularSearches().then(setPopular).catch(() => { /* noop */ });
    fetchAdminMetrics().then(setMetrics).catch(() => { /* noop */ });
    fetchQueueCounts().then(setCounts).catch(() => { /* noop */ });
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

      <div className="stats" style={{ marginBottom: 10 }}>
        <StatTile n={stats ? stats.platforms.toLocaleString() : "—"} l="플랫폼" tone="b" />
        <StatTile n={String(pending)} l="검수 대기" tone="t" />
        <StatTile n={stats ? String(stats.newCount) : "—"} l="신규" />
      </div>
      <div className="stats" style={{ marginBottom: 20 }}>
        <StatTile n={metrics ? String(metrics.members) : "—"} l="회원" tone="b" />
        <StatTile n={metrics ? String(metrics.favs) : "—"} l="계정 즐겨찾기" />
        <StatTile n={metrics ? String(metrics.searches7d) : "—"} l="검색(7일)" />
        <StatTile n={metrics ? String(metrics.outbound7d) : "—"} l="외부클릭(7일)" />
        <StatTile n={metrics ? String(metrics.livePosts + metrics.liveDeals) : "—"} l="게시 중(제안+매물)" />
        <StatTile n={metrics ? String(metrics.introduced) : "—"} l="누적 소개" tone="t" />
      </div>

      <FunnelPanel />

      {/* 오늘 처리 대기 — 큐별 건수 요약(제보만 보이던 문제 해소) + 클릭 시 해당 섹션으로 점프 */}
      {counts && (() => {
        const total = counts.submission + counts.partner + counts.deal + counts.operator + counts.deposit + counts.intro + counts.report + counts.inquiry;
        const jump = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
        const items: [string, number, string][] = [
          ["제보", counts.submission, "q-submission"], ["제휴 제안", counts.partner, "q-partner"],
          ["매물", counts.deal, "q-deal"], ["운영자 인증", counts.operator, "q-operator"],
          ["입금 확인", counts.deposit, "q-billing"], ["소개 대기", counts.intro, "q-intro"],
          ["신고", counts.report, "q-report"], ["문의", counts.inquiry, "q-inquiry"],
        ];
        return (
          <div className="banner" style={{ marginBottom: 18, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <b>오늘 처리 대기 {total}건</b>
            {total === 0 ? <span className="ok">모두 처리됨 ✓</span> : items.filter(([, n]) => n > 0).map(([l, n, id]) => (
              <button key={id} className="fchip on" onClick={() => jump(id)}>{l} {n}</button>
            ))}
          </div>
        );
      })()}

      <div className="sec-title" id="q-submission">제보 검수 큐 {queue ? `· ${queue.length}건` : ""}</div>
      {queue === null ? <div className="empty">불러오는 중…</div>
        : queue.length === 0 ? <div className="empty">대기 중인 제보가 없습니다 ✓</div>
        : <>
            <BatchApprovePanel queue={queue} onDone={reload} />
            {queue.map((s) => s.payload.kind === "correction"
              ? <CorrectionCard key={s.id} s={s} onDone={reload} />
              : <ReviewCard key={s.id} s={s} onDone={reload} />)}
          </>}

      <div className="sec-title" id="q-autolist">🤖 자동 등재 사후 검수</div>
      <AutoListedQueue />


      <div className="sec-title" id="q-partner">🤝 제휴 제안 검수{counts?.partner ? ` · ${counts.partner}건` : ""}</div>
      <PartnerPostQueue />

      <div className="sec-title" id="q-deal">🏦 매물 검수 (익명화 → 코드명 게시){counts?.deal ? ` · ${counts.deal}건` : ""}</div>
      <DealSubQueue />

      <div className="sec-title" id="q-dealqa">💬 매물 질문 답변 큐 (익명 Q&A — 검수 후 게시)</div>
      <DealQAQueue />

      <div className="sec-title" id="q-review">⭐ 리뷰 검수 큐 (이용 후기 — 검수 후 익명 게시)</div>
      <ReviewQueue />

      <div className="sec-title" id="q-report">🚩 신고 큐{counts?.report ? ` · ${counts.report}건` : ""}</div>
      <ReportQueue />

      <div className="sec-title" id="q-inquiry">📬 문의 큐{counts?.inquiry ? ` · ${counts.inquiry}건` : ""}</div>
      <InquiryQueue />

      <div className="sec-title">🧹 게시된 리뷰 관리 (사후 재숨김)</div>
      <PublishedReviewsPanel />

      <div className="sec-title">🗞 소식 관리 (자동 수집 — 오탐 삭제)</div>
      <NewsPanel />

      <div className="sec-title" id="q-operator">🏷 운영자 인증 신청{counts?.operator ? ` · ${counts.operator}건` : ""}</div>
      <OperatorClaimQueue />

      <div className="sec-title" id="q-billing">💳 입금 확인 큐 (무통장 — 입금자명 대조 후 확인){counts?.deposit ? ` · ${counts.deposit}건` : ""}</div>
      <BillingQueuePanel tick={billingTick} bump={bumpBilling} />

      <div className="sec-title">🪧 스폰서 슬롯 (보드 상단 2슬롯 · AD 표기)</div>
      <SponsorSlotsPanel tick={billingTick} bump={bumpBilling} />

      <div className="sec-title">👑 구독 현황 (Pro)</div>
      <SubsPanel />

      <div className="sec-title">↩️ 환불 (결제 완료 청구 — 미이행·청약철회)</div>
      <RefundPanel tick={billingTick} bump={bumpBilling} />

      <div className="sec-title" id="q-intro">📮 소개 대기 (매칭 신청 · 인수 관심 · 브리프){counts?.intro ? ` · ${counts.intro}건` : ""}</div>
      <IntroQueue />

      <div className="sec-title">📡 게시 중 (상태 전이 — 성사·진행·마감)</div>
      <LivePanel />

      <div className="sec-title">✏️ 플랫폼 정보 편집 · 보강 큐</div>
      <PlatformEditor />

      <div className="sec-title">👥 회원 관리 (검색 · 정지)</div>
      <MembersPanel />

      <div className="sec-title">⚙️ 운영 스위치 (app_settings)</div>
      <SettingsPanel />

      <div className="sec-title">🗂 최근 처리 내역</div>
      <RecentProcessedPanel />

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
