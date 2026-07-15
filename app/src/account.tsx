/* P2 참여 화면 — 계정(로그인·회원가입·프로필·내 제보) + 플랫폼 제보 폼 */
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { groups, categoriesByGroup, partnerTypes } from "./data";
import { Badge } from "./components";
import { useNav } from "./nav";
import {
  consumeHashNotice, consumeRecoveryPending, requestPasswordReset, resendConfirmation,
  signIn, signInWithGoogle, signOut, signUp, updateEmail, updatePassword, useSession, refreshProfile,
} from "./lib/auth";
import { TERMS_VERSION } from "./legal";
import { FLAGS } from "./config";
import {
  briefMatchesDeal, cancelDealSubmission, cancelSubmission, closeMyPost, createSubmission,
  deactivateBrief, deleteMyAccount, fetchDeals, fetchOperatorStats, listInterestsOnMyPosts, listMyBriefs, listMyCharges, listMyDealInterests,
  listMyDealSubmissions, listMyIntroOutcomes, listMyOperatedPlatforms, listMyPartnerInterests, listMyPartnerPosts, listMySubmissions, listMySubscriptions, fetchMyCreditBalance, listReceivedProposals,
  partnerRefCode, placeOrder, recordIntroOutcome, registerOptout, remoteEnabled, respondToInterest, updateDisplayName, withdrawDealInterest, withdrawPartnerInterest,
  listSavedSearches, deleteSavedSearch,
} from "./lib/api";
import type { SavedSearch } from "./lib/api";
import { bankTransferProvider, fetchBillingSettings } from "./lib/billing";
import { scoreBriefDeal } from "./lib/match";
import { usePlatformIndex } from "./lib/platforms";
import { PRICES, won } from "./lib/pricing";
import type { DepositInstructions } from "./lib/billing";
import type { BuyerBriefRow, DealSubmissionRow, IntroOutcomeKind, MyCharge, MyInterestRow, MyPostInterest, MySubscription, OperatorStats, PartnerPostAdmin, PublicDeal, ReceivedProposal, Submission } from "./lib/api";

const OUTCOME_LABEL: Record<IntroOutcomeKind, string> = { progressing: "진행 중", success: "성사됨 🎉", no: "성사 안 됨" };
/* 소개 후 성사·후기 회수(0021) — 성공보수 아닌 품질 신호. 응답하면 갱신 가능. */
function OutcomePrompt({ refType, refId, current, onDone }: { refType: "partner" | "deal"; refId: string; current?: IntroOutcomeKind; onDone: (o: IntroOutcomeKind) => void }) {
  const [busy, setBusy] = useState(false);
  const set = async (o: IntroOutcomeKind) => { setBusy(true); try { await recordIntroOutcome(refType, refId, o); onDone(o); } catch { /* noop */ } finally { setBusy(false); } };
  if (current) return (
    <div className="frm-note" style={{ marginTop: 4 }}>응답 감사합니다 — <b>{OUTCOME_LABEL[current]}</b>.
      {current !== "success" && <> <button className="linklike" disabled={busy} onClick={() => set("success")}>성사로 변경</button></>}</div>
  );
  return (
    <div className="frm-note" style={{ marginTop: 4, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
      이 소개, 어떻게 됐나요?
      {(["progressing", "success", "no"] as IntroOutcomeKind[]).map((o) => (
        <button key={o} className="btn ghost sm" disabled={busy} onClick={() => set(o)}>{OUTCOME_LABEL[o]}</button>
      ))}
    </div>
  );
}

const REPORT_URL = "https://github.com/comdows/web1/issues/new?title=" + encodeURIComponent("[플랫폼 제보]");

const STATUS_BADGE: Record<Submission["status"], { kind: "new" | "good" | "soon" | "muted" | "verify"; label: string }> = {
  pending: { kind: "soon", label: "검수 대기" },
  hold: { kind: "muted", label: "보류" },
  approved: { kind: "verify", label: "등재 완료" },
  rejected: { kind: "muted", label: "반려" },
};

function RemoteOffNotice() {
  return (
    <div className="empty">
      백엔드가 연결되지 않은 빌드입니다(로컬 데이터 모드).<br />
      플랫폼 제보는 <a href={REPORT_URL} target="_blank" rel="noopener noreferrer">GitHub 이슈</a>로 받고 있어요.
    </div>
  );
}

/* 미매핑 인증 오류의 한국어 폴백 — 영문/기술 문자열("Failed to fetch", "AUTH 500")이 그대로 노출되지 않게 */
const authErrKo = (m: string) =>
  /failed to fetch|network|load failed/i.test(m) ? "연결에 실패했어요. 네트워크 상태를 확인해 주세요."
  : /rate limit|too many/i.test(m) ? "요청이 많아요. 잠시 후 다시 시도해 주세요."
  : /[가-힣]/.test(m) ? m
  : "요청을 처리하지 못했어요. 잠시 후 다시 시도해 주세요.";

/* ── 로그인 / 회원가입 ─────────────────────────────────────── */
export function AuthPanel({ compact = false }: { compact?: boolean }) {
  const [mode, setMode] = useState<"in" | "up" | "forgot">("in");
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");
  const [needsConfirm, setNeedsConfirm] = useState(false); // 확인 메일 재발송 노출 여부
  const [agreeTerms, setAgreeTerms] = useState(false);      // [필수] 만 14세 이상 + 약관
  const [agreePrivacy, setAgreePrivacy] = useState(false);  // [필수] 개인정보 수집·이용

  // 확인 메일 링크로 돌아온 경우의 안내(완료/만료)를 1회 표시
  useEffect(() => { const n = consumeHashNotice(); if (n) setOk(n); }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(""); setOk(""); setNeedsConfirm(false); setBusy(true);
    try {
      if (mode === "forgot") {
        await requestPasswordReset(email.trim());
        setOk("재설정 메일을 보냈어요. 메일의 링크를 누르면 새 비밀번호를 설정할 수 있어요.");
      } else if (mode === "in") {
        await signIn(email.trim(), pw);
      } else {
        const r = await signUp(email.trim(), pw, TERMS_VERSION);
        if (r.needsConfirm) { setOk("확인 메일을 보냈어요. 메일의 링크를 누른 뒤 여기서 로그인하세요."); setNeedsConfirm(true); }
      }
    } catch (ex) {
      const m = ex instanceof Error ? ex.message : String(ex);
      if (/email not confirmed/i.test(m)) { setErr("이메일 확인이 필요해요. 받은 메일의 링크를 먼저 눌러주세요."); setNeedsConfirm(true); }
      else setErr(/invalid login credentials/i.test(m) ? "이메일 또는 비밀번호가 맞지 않습니다."
        : /already registered/i.test(m) ? "이미 가입된 이메일입니다. 로그인해 주세요."
        : /at least 6/i.test(m) ? "비밀번호는 6자 이상이어야 합니다." : authErrKo(m));
    } finally { setBusy(false); }
  };

  const resend = async () => {
    setErr(""); setBusy(true);
    try { await resendConfirmation(email.trim()); setOk("확인 메일을 다시 보냈어요. 메일함(스팸함 포함)을 확인해 주세요."); }
    catch (ex) { setErr(authErrKo(ex instanceof Error ? ex.message : String(ex))); }
    finally { setBusy(false); }
  };

  return (
    <div className="auth-card">
      {!compact && (
        <div className="tabbar">
          <button className={`btn ghost sm ${mode === "in" ? "on" : ""}`} onClick={() => { setMode("in"); setErr(""); }}>로그인</button>
          <button className={`btn ghost sm ${mode === "up" ? "on" : ""}`} onClick={() => { setMode("up"); setErr(""); }}>회원가입</button>
        </div>
      )}
      {FLAGS.googleAuth && (
        <div style={{ marginBottom: 14 }}>
          <button type="button" className="btn ghost" style={{ width: "100%" }} onClick={() => signInWithGoogle()}>
            G · Google로 계속하기
          </button>
          <div className="frm-note" style={{ textAlign: "center", marginTop: 8 }}>또는 이메일로</div>
        </div>
      )}
      <form className="frm" onSubmit={submit}>
        <label>이메일
          <input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
        </label>
        {mode !== "forgot" && (
          <label>비밀번호
            <input type="password" required minLength={6} autoComplete={mode === "in" ? "current-password" : "new-password"}
              value={pw} onChange={(e) => setPw(e.target.value)} placeholder="6자 이상" />
          </label>
        )}
        {mode === "up" && (
          <div style={{ display: "grid", gap: 6 }}>
            <label className="facet-opt" style={{ fontSize: 12.5 }}>
              <input type="checkbox" checked={agreeTerms} onChange={() => setAgreeTerms((v) => !v)} />
              [필수] 만 14세 이상이며 <TermsLink />에 동의합니다.
            </label>
            <label className="facet-opt" style={{ fontSize: 12.5 }}>
              <input type="checkbox" checked={agreePrivacy} onChange={() => setAgreePrivacy((v) => !v)} />
              [필수] <PrivacyLink />(개인정보 수집·이용, 국외 이전 고지 포함)에 동의합니다.
            </label>
          </div>
        )}
        {err && <div className="err">{err}</div>}
        {ok && <div className="ok">{ok}</div>}
        <button className="btn primary" disabled={busy || (mode === "up" && (!agreeTerms || !agreePrivacy))} type="submit">
          {busy ? "처리 중…" : mode === "in" ? "로그인" : mode === "up" ? "가입하기" : "재설정 메일 보내기"}
        </button>
        {mode === "in" && (
          <button type="button" className="linklike" onClick={() => { setMode("forgot"); setErr(""); setOk(""); }}>비밀번호를 잊으셨나요?</button>
        )}
        {mode === "forgot" && (
          <button type="button" className="linklike" onClick={() => { setMode("in"); setErr(""); setOk(""); }}>← 로그인으로 돌아가기</button>
        )}
        {needsConfirm && (
          <button type="button" className="btn ghost sm" disabled={busy || !email.trim()} onClick={resend}>
            확인 메일 재발송
          </button>
        )}
        {mode === "up" ? (
          <div className="frm-note">가입하면 즐겨찾기가 계정에 저장되고, 플랫폼 제보·제휴 제안을 남길 수 있어요.</div>
        ) : (
          <div className="frm-note">가입하면 즐겨찾기가 계정에 저장되고, 플랫폼 제보를 남길 수 있어요.</div>
        )}
      </form>
    </div>
  );
}

function TermsLink() {
  const go = useNav();
  return <button type="button" className="linklike" style={{ textDecoration: "underline" }} onClick={() => go("terms")}>이용약관</button>;
}
function PrivacyLink() {
  const go = useNav();
  return <button type="button" className="linklike" style={{ textDecoration: "underline" }} onClick={() => go("privacy")}>개인정보처리방침</button>;
}

/* ── 계정 화면 ────────────────────────────────────────────── */
/* ── 내 구독·크레딧(수익화 v2 셀프서브) — 만료 D-7부터 갱신 주문, 크레딧 잔액·충전.
 * 스위치 off(FLAGS.billing) 동안엔 안내만 — 주문 자격·가격 판정은 전부 서버(place_order). */
const PLAN_LABEL: Record<string, string> = { pro: "Pro 멤버십", buyer: "인수자 멤버십" };
function BillingSelfServe() {
  const { session } = useSession();
  const [subs, setSubs] = useState<MySubscription[]>([]);
  const [credit, setCredit] = useState(0);
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState("");
  useEffect(() => {
    if (!session) return;
    let alive = true;
    listMySubscriptions().then((r) => { if (alive) setSubs(r); }).catch(() => { /* noop */ });
    fetchMyCreditBalance().then((n) => { if (alive) setCredit(n); }).catch(() => { /* noop */ });
    return () => { alive = false; };
  }, [session]);
  if (subs.length === 0 && credit === 0 && !FLAGS.billing.membership && !FLAGS.billing.connection) return null;
  const order = async (key: string, fn: () => ReturnType<typeof placeOrder>) => {
    if (busy) return;
    setBusy(key); setNote("");
    try {
      const o = await fn();
      const d = await bankTransferProvider.instruct(o.id, o.total, "");
      setNote(`주문 접수 ✓ ${d.bank} · ${won(o.total)} · 기한 ${d.deadlineDays}일 — 상세는 아래 결제 내역에서 확인하세요.`);
    } catch (ex) { setNote(ex instanceof Error ? ex.message : String(ex)); }
    finally { setBusy(""); }
  };
  const d7 = (end: string | null) => end !== null && new Date(end).getTime() - Date.now() < 7 * 24 * 3600 * 1000;
  return (
    <>
      <div className="sec-title" style={{ marginTop: 28 }}>내 구독 · 크레딧</div>
      <div className="sub-list">
        {subs.map((sb) => (
          <div className="sub-item" key={sb.plan_id}>
            <div style={{ minWidth: 0 }}>
              <b>{PLAN_LABEL[sb.plan_id] ?? sb.plan_id}</b> <Badge kind="good">이용 중</Badge>
              <div className="frm-note">만료 {sb.current_period_end?.slice(0, 10) ?? "—"} · 자동결제 없음 — 만료 7일 전부터 갱신 주문할 수 있어요.</div>
            </div>
            {d7(sb.current_period_end) && (
              <button className="btn primary sm" style={{ flexShrink: 0 }} disabled={busy !== ""}
                onClick={() => order(sb.plan_id, () => placeOrder("subscription", sb.plan_id))}>갱신 주문 →</button>
            )}
          </div>
        ))}
        <div className="sub-item">
          <div style={{ minWidth: 0 }}>
            <b>연결료 크레딧</b> <span className="mono" style={{ fontSize: 13 }}>{won(credit)}</span>
            <div className="frm-note">소개(연락처 공유) 실행 시 연결료가 잔액에서 먼저 차감돼요.
              {!FLAGS.billing.connection && " 충전은 유료화 오픈 시 제공됩니다."}</div>
          </div>
          {FLAGS.billing.connection && (
            <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
              <button className="btn ghost sm" disabled={busy !== ""}
                onClick={() => order("c50", () => placeOrder("credit", undefined, undefined, undefined, "50"))}>
                {won(PRICES.credit50.pay)} 충전(+{won(PRICES.credit50.get - PRICES.credit50.pay)})</button>
              <button className="btn ghost sm" disabled={busy !== ""}
                onClick={() => order("c100", () => placeOrder("credit", undefined, undefined, undefined, "100"))}>
                {won(PRICES.credit100.pay)} 충전(+{won(PRICES.credit100.get - PRICES.credit100.pay)})</button>
            </div>
          )}
        </div>
      </div>
      {note && <div className="frm-note">{note}</div>}
    </>
  );
}

/* ── 이메일 수신거부(정보통신망법 §50 — 0015 outreach_optout 공개 등록) ──
 * 제휴 제안 메일·알림 요약 메일의 수신거부 링크가 도착하는 공개 페이지(로그인 불요).
 * 등록만 가능하고 목록 조회는 관리자·서버 전용 — 주소 존재 여부가 새어나가지 않는다. */
export function Optout() {
  const [email, setEmail] = useState("");
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(""); setBusy(true);
    try { await registerOptout(email); setDone(true); }
    catch (ex) { setErr(ex instanceof Error ? ex.message : String(ex)); }
    finally { setBusy(false); }
  };
  return (
    <main className="page container">
      <h1>이메일 수신거부</h1>
      <p className="lead" style={{ maxWidth: 560 }}>
        입력한 주소로는 세모플이 보내는 <b>제휴 제안 메일과 알림 요약 메일</b>을 더 이상 발송하지 않습니다.
        (가입 확인·비밀번호 재설정 등 계정 필수 메일은 계속 발송됩니다.)
      </p>
      {!remoteEnabled ? <RemoteOffNotice />
        : done ? <div className="ok">수신거부가 등록됐어요 — 앞으로 이 주소로는 발송하지 않습니다.</div>
        : (
          <form className="frm auth-card" style={{ maxWidth: 420 }} onSubmit={submit}>
            <label>이메일
              <input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
            </label>
            {err && <div className="err">{err}</div>}
            <button className="btn primary" disabled={busy} type="submit">수신거부 등록</button>
          </form>
        )}
    </main>
  );
}

/* ── 내 플랫폼(운영자) 대시보드(0023) — 인증 운영자에게만 렌더(목록 비면 숨김).
 * 스탯은 definer RPC(운영자 본인 플랫폼만·30일 집계값만), 받은 제안은 0023 운영자 read 정책. */
function OperatorDash() {
  const go = useNav();
  const idx = usePlatformIndex();
  const [ops, setOps] = useState<{ platform_id: string; granted_at: string }[]>([]);
  const [stats, setStats] = useState<Record<string, OperatorStats | null>>({});
  const [received, setReceived] = useState<ReceivedProposal[]>([]);
  useEffect(() => {
    let alive = true;
    listMyOperatedPlatforms().then((rows) => {
      if (!alive) return;
      setOps(rows);
      rows.forEach((r) => {
        fetchOperatorStats(r.platform_id)
          .then((s) => { if (alive) setStats((m) => ({ ...m, [r.platform_id]: s })); })
          .catch(() => { if (alive) setStats((m) => ({ ...m, [r.platform_id]: null })); });
      });
      if (rows.length > 0) {
        listReceivedProposals(rows.map((r) => r.platform_id))
          .then((p) => { if (alive) setReceived(p); }).catch(() => { /* noop — 0023 미실행 시 */ });
      }
    }).catch(() => { /* noop */ });
    return () => { alive = false; };
  }, []);
  if (ops.length === 0) return null;
  const typeName = (id: string) => partnerTypes.find((t) => t.id === id)?.label ?? id;
  return (
    <>
      <div className="sec-title" style={{ marginTop: 28 }}>내 플랫폼 (운영자)</div>
      <div className="sub-list">
        {ops.map((o) => {
          const p = idx.get(o.platform_id);
          const s = stats[o.platform_id];
          const recv = received.filter((r) => r.target_platform_id === o.platform_id);
          return (
            <div className="sub-item" key={o.platform_id} style={{ alignItems: "flex-start" }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <b>{p?.name ?? o.platform_id}</b> <Badge kind="verify">운영자 ✓</Badge>
                <div className="frm-note" style={{ marginTop: 4 }}>
                  최근 30일 — {s === undefined ? "집계 불러오는 중…"
                    : s === null ? "집계를 불러오지 못했어요 (0023 마이그레이션 필요 여부 확인)"
                    : <>노출 <b>{s.impressions}</b> · 클릭 <b>{s.clicks}</b> · 공식 사이트 방문 <b>{s.outbounds}</b> · 즐겨찾기 <b>{s.favorites}</b> <span className="faint">(세션 기준 — 개인 식별 없음)</span></>}
                </div>
                {recv.length > 0 && (
                  <div style={{ marginTop: 6 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 600 }}>받은 제휴 제안 {recv.length}건</div>
                    {recv.slice(0, 5).map((r) => (
                      <div key={r.id} className="frm-note">
                        🤝 {typeName(r.type_id)} · {r.sender_name} · {r.created_at.slice(0, 10)} — {r.subject}
                      </div>
                    ))}
                    <div className="frm-note">💡 Pro 멤버십({won(PRICES.pro)}/월 예정)에는 레퍼럴형 소개 월 3건이 포함돼요. <button className="linklike" onClick={() => go("partners")}>요금 안내 →</button></div>
                  </div>
                )}
              </div>
              <button className="btn ghost sm" style={{ flexShrink: 0 }} onClick={() => go("detail", { id: o.platform_id })}>
                정보 채우기·정정 →
              </button>
            </div>
          );
        })}
      </div>
      <p className="sub faint" style={{ fontSize: 12.5 }}>
        수치가 궁금한 만큼, 상세 정보가 채워진 플랫폼일수록 클릭·제휴 제안이 늘어요 — 상세 페이지의 "정정·보강 제안"으로 직접 채울 수 있습니다.
      </p>
    </>
  );
}

/* 내 저장 검색(0030) — 저장한 조건 목록·삭제·검색 열기. 신규 매칭은 인앱 알림(search_match)으로. */
function savedSearchUrl(c: SavedSearch["criteria"]): string {
  const p = new URLSearchParams({ view: "search" });
  if (c.q) p.set("q", c.q);
  if (c.cats?.length) p.set("cats", c.cats.join(","));
  if (c.region && c.region !== "all") p.set("region", c.region);
  if (c.onlyNew) p.set("new", "1");
  if (c.fees?.length) p.set("fee", c.fees.join(","));
  return `${import.meta.env.BASE_URL}?${p}`;
}
function SavedSearchesPanel() {
  const { session } = useSession();
  const [rows, setRows] = useState<SavedSearch[] | null>(null);
  const reload = () => { listSavedSearches().then(setRows).catch(() => setRows([])); };
  useEffect(() => { if (session) reload(); else setRows(null); }, [session]);
  if (!session || rows === null) return null;
  return (
    <>
      <div className="sec-title" style={{ marginTop: 28 }}>내 저장 검색 <span className="faint" style={{ fontWeight: 400, fontSize: 13 }}>· 조건에 맞는 새 플랫폼이 등재되면 알림</span></div>
      {rows.length === 0 ? (
        <div className="empty">저장한 검색이 없어요 — 검색 결과 화면에서 <b>🔔 이 조건 저장</b>을 누르면 조건에 맞는 신규 등재를 알림으로 받아요.</div>
      ) : (
        <div className="sub-list">
          {rows.map((s) => (
            <div className="sub-item" key={s.id}>
              <div style={{ minWidth: 0 }}>
                <a href={savedSearchUrl(s.criteria)} style={{ fontWeight: 600 }}>{s.label}</a>
                <div className="frm-note">저장 {s.created_at.slice(0, 10)}</div>
              </div>
              <button className="btn ghost sm" style={{ flexShrink: 0 }}
                onClick={async () => { if (!confirm(`저장 검색 "${s.label}"을(를) 삭제할까요?`)) return; await deleteSavedSearch(s.id); reload(); }}>삭제</button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

export function Account() {
  const go = useNav();
  const { session, profile, isAdmin } = useSession();
  const [name, setName] = useState("");
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [checked, setChecked] = useState(false);
  const [err, setErr] = useState("");
  const [subs, setSubs] = useState<Submission[] | null>(null);
  const [subsError, setSubsError] = useState(false);
  const [reload, setReload] = useState(0);
  const [newPw, setNewPw] = useState("");
  const [pwBusy, setPwBusy] = useState(false);
  const [pwMsg, setPwMsg] = useState<{ ok?: string; err?: string }>({});
  const [recovery] = useState(() => consumeRecoveryPending()); // 재설정 링크로 복귀한 경우
  const [newEmail, setNewEmail] = useState("");
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailMsg, setEmailMsg] = useState<{ ok?: string; err?: string }>({});
  const [delConfirm, setDelConfirm] = useState("");   // '탈퇴' 타이핑 확인
  const [delBusy, setDelBusy] = useState(false);
  const [delErr, setDelErr] = useState("");
  const [showDel, setShowDel] = useState(false);
  const [actBusy, setActBusy] = useState("");         // 취소·마감 진행 중인 항목 id
  const [inbox, setInbox] = useState<MyPostInterest[]>([]);              // 내 제안에 달린 신청(익명)
  const [deposit, setDeposit] = useState<DepositInstructions | null>(null); // 스폰서 주문 무통장 안내
  const [charges, setCharges] = useState<MyCharge[]>([]);                // 내 결제·청구 내역(입금 안내 재확인)
  const [bank, setBank] = useState("");                                  // 입금 계좌(app_settings)
  const [acts, setActs] = useState<{ pp: PartnerPostAdmin[]; ds: DealSubmissionRow[]; pi: MyInterestRow[]; di: MyInterestRow[]; br: BuyerBriefRow[] } | null>(null);
  const [actsErr, setActsErr] = useState(false);
  const [briefDeals, setBriefDeals] = useState<PublicDeal[]>([]); // 브리프 조건 대조용(공개 뷰)
  const [outcomes, setOutcomes] = useState<Map<string, IntroOutcomeKind>>(new Map()); // 소개 후 성사 응답(0021)

  useEffect(() => { setName(profile?.display_name ?? ""); }, [profile?.display_name]);
  useEffect(() => {
    if (!session) { setSubs(null); return; }
    let alive = true;
    setSubsError(false); setSubs(null);
    listMySubmissions()
      .then((s) => { if (alive) setSubs(s); })
      .catch(() => { if (alive) { setSubsError(true); setSubs(null); } });
    setActsErr(false);
    listInterestsOnMyPosts().then((r) => { if (alive) setInbox(r); }).catch(() => { /* noop */ });
    listMyIntroOutcomes().then((m) => { if (alive) setOutcomes(m); }).catch(() => { /* noop */ });
    listMyCharges().then((r) => { if (alive) setCharges(r); }).catch(() => { /* noop */ });
    fetchBillingSettings().then((s) => { if (alive) setBank(s?.bank ?? ""); });
    Promise.all([listMyPartnerPosts(), listMyDealSubmissions(), listMyPartnerInterests(), listMyDealInterests(), listMyBriefs()])
      .then(([pp, ds, pi, di, br]) => {
        if (!alive) return;
        setActs({ pp, ds, pi, di, br });
        // 활성 브리프가 있으면 공개 매물과 조건 대조("우선 안내" 약속의 인앱 이행)
        if (br.some((b) => b.active)) fetchDeals().then((d) => { if (alive) setBriefDeals(d.filter((x) => !x.is_demo)); }).catch(() => { /* noop */ });
      })
      .catch(() => { if (alive) { setActsErr(true); setActs(null); } });
    return () => { alive = false; };
  }, [session, reload]);

  if (!remoteEnabled) return <main className="page container"><h1>계정</h1><RemoteOffNotice /></main>;

  if (!session) {
    return (
      <main className="page container">
        <h1>계정</h1>
        <p className="lead" style={{ maxWidth: 520 }}>로그인하면 ★ 즐겨찾기가 계정에 저장되어 어느 기기에서나 이어지고, 빠진 플랫폼을 제보할 수 있습니다.</p>
        <AuthPanel />
      </main>
    );
  }

  const role = profile?.role ?? "user";
  const roleInfo = role === "admin" ? { kind: "verify" as const, label: "관리자" }
    : role === "operator" ? { kind: "good" as const, label: "운영자" }
    : { kind: "muted" as const, label: "일반 회원" };

  /* 셀프 취소·마감·철회 — 권한은 0009 RLS/RPC가 판정(pending만 삭제 가능 등) */
  const doAct = async (id: string, fn: () => Promise<void>) => {
    if (actBusy) return;
    setActBusy(id);
    try { await fn(); setReload((n) => n + 1); }
    catch (ex) { alert(ex instanceof Error ? ex.message : String(ex)); }
    finally { setActBusy(""); }
  };

  const saveName = async (e: FormEvent) => {
    e.preventDefault();
    if (saving) return;
    setErr(""); setSaving(true);
    try { await updateDisplayName(name.trim()); setSaved(true); refreshProfile(); }
    catch (ex) { setErr(ex instanceof Error ? ex.message : String(ex)); }
    finally { setSaving(false); }
  };

  return (
    <main className="page container">
      <h1>계정</h1>
      <div className="auth-card">
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
          <span className="mono" style={{ fontSize: 13 }}>{session.user.email}</span>
          <Badge kind={roleInfo.kind}>{roleInfo.label}</Badge>
        </div>
        <form className="frm" onSubmit={saveName}>
          <label>표시 이름
            <input value={name} onChange={(e) => { setName(e.target.value); setSaved(false); }} placeholder="예: 이음 운영자" maxLength={40} />
          </label>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn primary sm" type="submit" disabled={saving}>{saving ? "저장 중…" : "저장"}</button>
            {saved && <span className="ok" style={{ alignSelf: "center" }}>저장됐어요 ✓</span>}
            {err && <span className="err" style={{ alignSelf: "center" }}>{err}</span>}
          </div>
        </form>
        <form className="frm" style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--line-soft)" }}
          onSubmit={async (e) => {
            e.preventDefault();
            if (pwBusy) return;
            setPwMsg({}); setPwBusy(true);
            try { await updatePassword(newPw); setPwMsg({ ok: "비밀번호가 변경됐어요 ✓" }); setNewPw(""); }
            catch (ex) { setPwMsg({ err: ex instanceof Error ? ex.message : String(ex) }); }
            finally { setPwBusy(false); }
          }}>
          {recovery && <div className="ok">본인 확인 완료 — 새 비밀번호를 설정해 주세요.</div>}
          <label>비밀번호 변경
            <input type="password" required minLength={6} autoComplete="new-password"
              value={newPw} onChange={(e) => setNewPw(e.target.value)} placeholder="새 비밀번호 (6자 이상)" />
          </label>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn ghost sm" type="submit" disabled={pwBusy}>{pwBusy ? "변경 중…" : "비밀번호 변경"}</button>
            {pwMsg.ok && <span className="ok" style={{ alignSelf: "center" }}>{pwMsg.ok}</span>}
            {pwMsg.err && <span className="err" style={{ alignSelf: "center" }}>{pwMsg.err}</span>}
          </div>
        </form>
        <form className="frm" style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--line-soft)" }}
          onSubmit={async (e) => {
            e.preventDefault();
            if (emailBusy) return;
            setEmailMsg({}); setEmailBusy(true);
            try { await updateEmail(newEmail.trim()); setEmailMsg({ ok: "변경 메일을 보냈어요 — 새 이메일의 확인 링크를 눌러야 완료됩니다." }); setNewEmail(""); }
            catch (ex) { setEmailMsg({ err: ex instanceof Error ? ex.message : String(ex) }); }
            finally { setEmailBusy(false); }
          }}>
          <label>이메일 변경 <span style={{ fontWeight: 400, color: "var(--faint)" }}>(소개·안내가 이 주소로 갑니다 — 이직·메일 폐기 전에 꼭 갱신)</span>
            <input type="email" required value={newEmail} onChange={(e) => setNewEmail(e.target.value)} placeholder="새 이메일 주소" />
          </label>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="btn ghost sm" type="submit" disabled={emailBusy}>{emailBusy ? "발송 중…" : "변경 메일 발송"}</button>
            {emailMsg.ok && <span className="ok" style={{ alignSelf: "center" }}>{emailMsg.ok}</span>}
            {emailMsg.err && <span className="err" style={{ alignSelf: "center" }}>{emailMsg.err}</span>}
          </div>
        </form>
        <div className="frm-note" style={{ marginTop: 12 }}>★ 즐겨찾기는 로그인 중 자동으로 계정에 동기화됩니다.</div>
        <div style={{ marginTop: 16, display: "flex", gap: 8, flexWrap: "wrap" }}>
          {isAdmin && <button className="btn primary sm" onClick={() => go("admin")}>🛠 관리 콘솔</button>}
          <button className="btn ghost sm" onClick={() => { refreshProfile(); setChecked(true); setTimeout(() => setChecked(false), 2500); }}>권한 새로고침</button>
          <button className="btn ghost sm" onClick={() => signOut()}>로그아웃</button>
          {checked && !isAdmin && <span className="frm-note" style={{ alignSelf: "center" }}>아직 일반 회원이에요. Supabase에서 admin 지정 후 눌러보세요.</span>}
        </div>
        <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--line-soft)" }}>
          {!showDel ? (
            <button className="linklike" style={{ fontSize: 12.5, color: "var(--faint)" }} onClick={() => setShowDel(true)}>
              회원 탈퇴(개인정보 전체 삭제) →
            </button>
          ) : (
            <div className="frm" style={{ display: "grid", gap: 8 }}>
              <div className="frm-note">
                ⚠️ 탈퇴하면 계정·즐겨찾기·접수 내역이 <b>즉시 영구 삭제</b>됩니다(게시된 익명 정보는 익명 기록으로만 남음).
                되돌릴 수 없어요. 계속하려면 아래에 <b>탈퇴</b>라고 입력하세요.
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <input style={{ width: 120 }} value={delConfirm} onChange={(e) => setDelConfirm(e.target.value)} placeholder="탈퇴" />
                <button className="btn ghost sm" disabled={delBusy || delConfirm.trim() !== "탈퇴"}
                  onClick={async () => {
                    setDelErr(""); setDelBusy(true);
                    try { await deleteMyAccount(); signOut(); alert("탈퇴가 완료됐습니다. 이용해 주셔서 감사합니다."); }
                    catch (ex) { setDelErr(ex instanceof Error ? ex.message : String(ex)); setDelBusy(false); }
                  }}>
                  {delBusy ? "삭제 중…" : "영구 삭제 실행"}
                </button>
                <button className="linklike" onClick={() => { setShowDel(false); setDelConfirm(""); setDelErr(""); }}>취소</button>
              </div>
              {delErr && <div className="err">{delErr}</div>}
              {FLAGS.contactEmail && (
                <div className="frm-note">문제가 있으면 <a href={`mailto:${FLAGS.contactEmail}?subject=${encodeURIComponent("[세모플] 회원 탈퇴 요청")}`}>{FLAGS.contactEmail}</a>로 요청해도 됩니다 — 지체 없이 처리합니다.</div>
              )}
            </div>
          )}
        </div>
      </div>

      <OperatorDash />

      <SavedSearchesPanel />

      <div className="sec-title" style={{ marginTop: 28 }}>내 제보</div>
      {subsError ? (
          <div className="empty">목록을 불러오지 못했어요. <button className="linklike" onClick={() => setReload((n) => n + 1)}>다시 시도</button></div>
        ) : subs === null ? <div className="empty">불러오는 중…</div>
        : subs.length === 0 ? (
          <div className="empty">아직 제보한 플랫폼이 없어요. <a onClick={() => go("submit")} style={{ cursor: "pointer" }}>+ 플랫폼 제보하기</a></div>
        ) : (
          <div className="sub-list">
            {subs.map((s) => {
              const b = STATUS_BADGE[s.status];
              return (
                <div className="sub-item" key={s.id}>
                  <div>
                    <b>{s.payload.name}</b> <span className="mono" style={{ color: "var(--faint)", fontSize: 12 }}>{s.payload.url}</span>
                    {s.status === "rejected" && s.review_reason && <div className="frm-note">반려 사유: {s.review_reason}</div>}
                  </div>
                  <div style={{ display: "flex", gap: 6, alignItems: "center", flexShrink: 0 }}>
                    {s.status === "pending" && (
                      <button className="linklike" style={{ fontSize: 12 }} disabled={actBusy === s.id}
                        onClick={() => doAct(s.id, () => cancelSubmission(s.id))}>취소</button>
                    )}
                    <Badge kind={b.kind}>{b.label}</Badge>
                  </div>
                </div>
              );
            })}
          </div>
        )}

      {deposit && (
        <div className="banner" id="deposit-banner" style={{ marginTop: 20 }}>
          🧾 <b>스폰서 주문 접수 — 무통장 입금 안내</b>: {deposit.bank} · <b>{deposit.totalKrw.toLocaleString()}원</b>(VAT 포함) ·
          입금자명(보내는 분) <b>{deposit.depositorRule}</b> · 기한 {deposit.deadlineDays}일.
          입금 확인 후 게재가 시작되며 미이행 시 전액 환불됩니다. 이 안내는 아래 <b>결제 내역</b>에서 언제든 다시 볼 수 있어요.
        </div>
      )}

      {inbox.length > 0 && (
        <>
          <div className="sec-title" style={{ marginTop: 28 }}>받은 매칭 신청 (내 제안에 대한 응답)</div>
          <div className="sub-list">
            {inbox.map((i) => (
              <div className="sub-item" key={i.id}>
                <div style={{ minWidth: 0 }}>
                  📥 <b>"{i.post_title}"</b>에 신청 — {i.platform_name} {i.size_text && <span className="faint">({i.size_text})</span>}
                  <div className="frm-note">{i.pitch}</div>
                </div>
                <div style={{ display: "flex", gap: 6, alignItems: "center", flexShrink: 0, flexWrap: "wrap" }}>
                  {i.status === "pending" && !i.owner_confirmed_at && (
                    <>
                      <button className="btn primary sm" disabled={actBusy === i.id}
                        title="동의하면 세모플이 양측 이메일로 소개를 진행합니다"
                        onClick={() => doAct(i.id, () => respondToInterest(i.id, true))}>소개 진행 동의</button>
                      <button className="btn ghost sm" disabled={actBusy === i.id}
                        onClick={() => doAct(i.id, () => respondToInterest(i.id, false))}>거절</button>
                    </>
                  )}
                  {/* declined는 본인 거절 외에 운영자 정리·마감으로도 기록됨 — 주체를 단정하지 않는 중립 문구 */}
                  <Badge kind={i.status === "introduced" ? "verify" : i.status === "declined" ? "muted" : i.owner_confirmed_at ? "good" : "soon"}>
                    {i.status === "introduced" ? "소개 완료" : i.status === "declined" ? "진행되지 않음" : i.owner_confirmed_at ? "동의함 — 소개 대기" : "응답 대기"}
                  </Badge>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      <BillingSelfServe />

      {charges.length > 0 && (
        <>
          <div className="sec-title" style={{ marginTop: 28 }}>결제 내역</div>
          <div className="sub-list">
            {charges.map((c) => {
              const total = c.amount + c.vat;
              const kindLabel = c.kind === "boost" ? "스폰서 노출" : c.kind === "subscription" ? "Pro 멤버십"
                : c.kind === "connection_fee" ? `연결료${c.fee_tier ? ` ${c.fee_tier}형` : ""}`
                : c.kind === "listing_fee" ? "매물 리스팅" : c.kind === "credit_topup" ? "크레딧 충전" : c.kind;
              const overdue = c.status === "awaiting_deposit" && c.deposit_deadline && c.deposit_deadline < new Date().toISOString().slice(0, 10);
              const badge = c.status === "awaiting_deposit" ? { k: "soon" as const, l: overdue ? "기한 경과" : "입금 대기" }
                : c.status === "paid" ? { k: "good" as const, l: "결제 완료" }
                : c.status === "refunded" ? { k: "muted" as const, l: `환불됨${c.refund_amount != null ? ` · ${c.refund_amount.toLocaleString()}원` : ""}` }
                : c.status === "canceled" ? { k: "muted" as const, l: "취소됨" } : { k: "muted" as const, l: c.status };
              return (
                <div className="sub-item" key={c.id}>
                  <div style={{ minWidth: 0 }}>
                    🧾 <b>{kindLabel}</b> — {total.toLocaleString()}원(VAT 포함)
                    {c.discount_rate != null && <span className="faint"> · 파운더 할인 적용</span>}
                    <span className="mono" style={{ fontSize: 11, color: "var(--faint)" }}> · {c.created_at.slice(0, 10)} · {c.id.slice(0, 8)}</span>
                    {c.status === "awaiting_deposit" && (
                      <div className="frm-note">
                        입금 계좌 <b>{bank || "(계좌 안내 준비 중 — 운영자에게 문의)"}</b>
                        {c.depositor_hint && <> · 입금자명 <b>{c.depositor_hint}</b></>}
                        {c.deposit_deadline && <> · 기한 <span style={overdue ? { color: "var(--danger)" } : undefined}>{c.deposit_deadline}</span></>}
                        {overdue && " — 기한이 지나 취소 처리돼요. 계속 원하시면 다시 주문해 주세요."}
                      </div>
                    )}
                  </div>
                  <Badge kind={badge.k}>{badge.l}</Badge>
                </div>
              );
            })}
          </div>
        </>
      )}

      <div className="sec-title" style={{ marginTop: 28 }}>내 활동 (제휴·거래소)</div>
      {actsErr ? (
        <div className="empty">활동 내역을 불러오지 못했어요. <button className="linklike" onClick={() => setReload((n) => n + 1)}>다시 시도</button></div>
      ) : acts === null ? <div className="empty">불러오는 중…</div>
      : (acts.pp.length + acts.ds.length + acts.pi.length + acts.di.length + acts.br.length) === 0 ? (
        <div className="empty">제휴 제안·매각 접수·매칭 신청·관심 등록이 여기에 표시됩니다.</div>
      ) : (() => {
        // 매칭된 매물을 적합도(scoreBriefDeal) 순으로 — 여러 브리프에 걸리면 최고 점수 채택
        const matchScore = new Map<string, number>();
        for (const b of acts.br.filter((x) => x.active)) {
          for (const d of briefDeals) {
            if (!briefMatchesDeal(b, d)) continue;
            const s = scoreBriefDeal(b, d);
            if (s > (matchScore.get(d.id) ?? -1)) matchScore.set(d.id, s);
          }
        }
        const matchedIds = [...matchScore.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
        return (
        <>
        {matchedIds.length > 0 && (
          <div className="banner" style={{ marginBottom: 10 }}>
            📮 브리프 조건과 맞는 매물 <b>{matchedIds.length}건</b>({matchedIds.slice(0, 5).join(", ")}) —{" "}
            <button className="linklike" onClick={() => go("exchange")}>거래소에서 확인 →</button>
          </div>
        )}
        <div className="sub-list">
          {acts.pp.map((p) => {
            const b = p.status === "pending" ? { k: "soon" as const, l: "검수 중" }
              : p.status === "published" ? { k: "good" as const, l: "게시 중" }
              : p.status === "matched" ? { k: "verify" as const, l: "성사" }
              : p.status === "rejected" ? { k: "muted" as const, l: "반려" } : { k: "muted" as const, l: "마감" };
            return (
              <div className="sub-item" key={p.id}>
                <div style={{ minWidth: 0 }}>🤝 <b>{p.title}</b> <span className="mono" style={{ fontSize: 11, color: "var(--faint)" }}>{p.created_at.slice(0, 10)}</span>
                  {p.status === "rejected" && p.review_reason && <div className="frm-note">반려 사유: {p.review_reason}</div>}
                </div>
                <div style={{ display: "flex", gap: 6, alignItems: "center", flexShrink: 0, flexWrap: "wrap" }}>
                  {FLAGS.billing.sponsor && p.status === "published" && (
                    <button className="linklike" style={{ fontSize: 12 }} disabled={actBusy === p.id}
                      title="보드 상단 고정(월 99,000원 · AD 표기) — 무통장 입금 후 게재"
                      onClick={() => doAct(p.id, async () => {
                        // 입금자명은 은행 표기 한도(6~12자) 안의 대조 코드로 — 제목 조각은 잘리거나 변형돼 대조가 어긋남
                        const rule = `SP${partnerRefCode(p.id).slice(2)}`;
                        const o = await placeOrder("boost", undefined, p.id, rule);
                        // 금액은 서버 산정액(할인 반영) — 클라이언트 상수와의 불일치 방지
                        setDeposit(await bankTransferProvider.instruct(o.id, o.total, rule));
                        // 안내 배너는 화면 위쪽에 렌더됨 — 클릭 지점에서 안 보이면 주문이 안 된 걸로 오인
                        setTimeout(() => document.getElementById("deposit-banner")?.scrollIntoView({ behavior: "smooth", block: "center" }), 80);
                      })}>🪧 상단 고정 신청</button>
                  )}
                  {(p.status === "pending" || p.status === "published") && (
                    <button className="linklike" style={{ fontSize: 12 }} disabled={actBusy === p.id}
                      onClick={() => doAct(p.id, () => closeMyPost(p.id))}>{p.status === "pending" ? "철회" : "마감"}</button>
                  )}
                  <Badge kind={b.k}>{b.l}</Badge>
                </div>
              </div>
            );
          })}
          {acts.ds.map((s) => {
            const b = s.status === "pending" ? { k: "soon" as const, l: "검수 중" }
              : s.status === "hold" ? { k: "muted" as const, l: "보류" }
              : s.status === "approved" ? { k: "verify" as const, l: `게시됨${s.approved_deal_id ? ` · ${s.approved_deal_id}` : ""}` }
              : { k: "muted" as const, l: "반려" };
            const days = Math.floor((Date.now() - new Date(s.created_at).getTime()) / 86400000);
            return (
              <div className="sub-item" key={s.id}>
                <div style={{ minWidth: 0 }}>🏦 <b>매각 접수</b> — {s.payload.revenue_band ?? ""} {s.payload.mode ?? ""}
                  {s.status === "pending" && (
                    <div className="frm-note">
                      {days === 0 ? "오늘 접수" : `접수 ${days}일 경과`} — 검수는 보통 3영업일 이내(1인 운영 · 순차 검수)예요.
                      {days >= 5 && FLAGS.contactEmail && <> 오래 걸리면 <a href={`mailto:${FLAGS.contactEmail}?subject=${encodeURIComponent("[세모플] 매각 접수 검수 문의")}`}>문의</a>해 주세요.</>}
                    </div>
                  )}
                  {s.status === "approved" && <div className="frm-note">관심이 들어오면 세모플이 이메일로 소개 진행 여부를 확인드려요 — 메일함을 확인해 주세요.</div>}
                  {s.status === "rejected" && s.review_reason && <div className="frm-note">반려 사유: {s.review_reason}</div>}
                </div>
                <div style={{ display: "flex", gap: 6, alignItems: "center", flexShrink: 0 }}>
                  {s.status === "pending" && (
                    <button className="linklike" style={{ fontSize: 12 }} disabled={actBusy === s.id}
                      onClick={() => doAct(s.id, () => cancelDealSubmission(s.id))}>취소</button>
                  )}
                  <Badge kind={b.k}>{b.l}</Badge>
                </div>
              </div>
            );
          })}
          {acts.pi.map((i) => (
            <div className="sub-item" key={i.id}>
              <div style={{ minWidth: 0 }}>🤝 <b>매칭 신청</b> — "{i.partner_posts?.title ?? i.post_id}"
                {i.status === "declined" && <div className="frm-note">제안자가 다른 상대와 진행했거나 모집을 마감했어요 — 보드의 다른 제안도 살펴보세요.</div>}
                {i.status === "introduced" && (
                  <>
                    <div className="frm-note">
                      소개 메일이 발송됐어요 — 메일함(스팸함 포함)을 확인하세요.
                      {FLAGS.contactEmail && <> 24시간 내 미도착 시 <a href={`mailto:${FLAGS.contactEmail}?subject=${encodeURIComponent(`[세모플] 소개 메일 미도착 — ${i.partner_posts?.title ?? ""}`)}`}>문의</a>.</>}
                    </div>
                    <OutcomePrompt refType="partner" refId={i.id} current={outcomes.get(`partner:${i.id}`)}
                      onDone={(o) => setOutcomes((m) => new Map(m).set(`partner:${i.id}`, o))} />
                  </>
                )}
              </div>
              <div style={{ display: "flex", gap: 6, alignItems: "center", flexShrink: 0 }}>
                {i.status === "pending" && (
                  <button className="linklike" style={{ fontSize: 12 }} disabled={actBusy === i.id}
                    onClick={() => doAct(i.id, () => withdrawPartnerInterest(i.id))}>철회</button>
                )}
                <Badge kind={i.status === "introduced" ? "verify" : i.status === "declined" ? "muted" : "soon"}>
                  {i.status === "introduced" ? "소개 완료" : i.status === "declined" ? "진행되지 않음" : "접수됨"}</Badge>
              </div>
            </div>
          ))}
          {acts.di.map((i) => (
            <div className="sub-item" key={i.id}>
              <div style={{ minWidth: 0 }}>🏦 <b>인수 관심</b> — 매물 {i.deal_id}
                {i.status === "introduced" && (
                  <>
                    <div className="frm-note">
                      소개 메일이 발송됐어요 — 메일함(스팸함 포함)을 확인하세요.
                      {FLAGS.contactEmail && <> 24시간 내 미도착 시 <a href={`mailto:${FLAGS.contactEmail}?subject=${encodeURIComponent(`[세모플] 소개 메일 미도착 — ${i.deal_id ?? ""}`)}`}>문의</a>.</>}
                    </div>
                    <OutcomePrompt refType="deal" refId={i.id} current={outcomes.get(`deal:${i.id}`)}
                      onDone={(o) => setOutcomes((m) => new Map(m).set(`deal:${i.id}`, o))} />
                  </>
                )}
              </div>
              <div style={{ display: "flex", gap: 6, alignItems: "center", flexShrink: 0 }}>
                {i.status === "pending" && (
                  <button className="linklike" style={{ fontSize: 12 }} disabled={actBusy === i.id}
                    onClick={() => doAct(i.id, () => withdrawDealInterest(i.id))}>철회</button>
                )}
                <Badge kind={i.status === "introduced" ? "verify" : i.status === "declined" ? "muted" : "soon"}>
                  {i.status === "introduced" ? "소개 완료" : i.status === "declined" ? "진행되지 않음" : "접수됨"}</Badge>
              </div>
            </div>
          ))}
          {acts.br.map((b) => (
            <div className="sub-item" key={b.id}>
              <div style={{ minWidth: 0 }}>📮 <b>인수 브리프</b> — {b.budget_band} · {b.mode}{b.region_pref ? ` · ${b.region_pref === "overseas" ? "해외" : "국내"}` : ""}</div>
              <div style={{ display: "flex", gap: 6, alignItems: "center", flexShrink: 0 }}>
                {b.active && (
                  <button className="linklike" style={{ fontSize: 12 }} disabled={actBusy === b.id}
                    onClick={() => doAct(b.id, () => deactivateBrief(b.id))}>중단</button>
                )}
                <Badge kind={b.active ? "soon" : "muted"}>{b.active ? "대기 중" : "안내 완료"}</Badge>
              </div>
            </div>
          ))}
        </div>
        </>
        );
      })()}
    </main>
  );
}

/* ── 플랫폼 제보 ──────────────────────────────────────────── */
export function Submit() {
  const go = useNav();
  const { session } = useSession();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [cat, setCat] = useState("");
  const [region, setRegion] = useState<"domestic" | "overseas">("domestic");
  const [desc, setDesc] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState(false);

  if (!remoteEnabled) return <main className="page container"><h1>플랫폼 제보</h1><RemoteOffNotice /></main>;

  if (!session) {
    return (
      <main className="page container">
        <h1>플랫폼 제보</h1>
        <p className="lead" style={{ maxWidth: 520 }}>빠진 플랫폼을 알려주세요. 검수 후 디렉토리에 등재됩니다. 제보에는 로그인이 필요해요(처리 결과를 계정에서 확인할 수 있게).</p>
        <AuthPanel />
      </main>
    );
  }

  if (done) {
    return (
      <main className="page container">
        <h1>플랫폼 제보</h1>
        <div className="done-card">
          접수됐어요 ✓ 검수 후 등재되며, 진행 상태는 <a onClick={() => go("account")} style={{ cursor: "pointer" }}>계정 → 내 제보</a>에서 볼 수 있어요.
          <div style={{ marginTop: 12 }}><button className="btn ghost sm" onClick={() => { setDone(false); setName(""); setUrl(""); setDesc(""); }}>하나 더 제보</button></div>
        </div>
      </main>
    );
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(""); setBusy(true);
    try {
      await createSubmission({ name: name.trim(), url: url.trim(), category_id: cat, region, desc: desc.trim() });
      setDone(true);
    } catch (ex) { setErr(ex instanceof Error ? ex.message : String(ex)); }
    finally { setBusy(false); }
  };

  return (
    <main className="page container">
      <h1>플랫폼 제보</h1>
      <p className="lead" style={{ maxWidth: 560 }}>사업자가 입점·판매·홍보할 수 있는 온라인 플랫폼이면 무엇이든 좋아요. 검수(중복·기준 확인) 후 등재됩니다.</p>
      <form className="frm auth-card" style={{ maxWidth: 560 }} onSubmit={submit}>
        <label>플랫폼 이름 *
          <input required value={name} onChange={(e) => setName(e.target.value)} placeholder="예: 이음" maxLength={60} />
        </label>
        <label>대표 URL *
          <input required type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />
        </label>
        <label>분야 *
          <select required value={cat} onChange={(e) => setCat(e.target.value)}>
            <option value="" disabled>분야 선택</option>
            {groups.map((g) => (
              <optgroup key={g.id} label={`${g.icon} ${g.name}`}>
                {categoriesByGroup(g.id).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </optgroup>
            ))}
          </select>
        </label>
        <label>지역
          <select value={region} onChange={(e) => setRegion(e.target.value as "domestic" | "overseas")}>
            <option value="domestic">국내</option><option value="overseas">해외</option>
          </select>
        </label>
        <label>한 줄 소개
          <textarea rows={3} value={desc} onChange={(e) => setDesc(e.target.value)} maxLength={200}
            placeholder="어떤 사업자가 무엇을 할 수 있는 곳인지 (중립·사실 위주)" />
        </label>
        <div className="frm-note">⚠️ 연락처·개인정보는 적지 마세요 — 검수 시 삭제됩니다.</div>
        {err && <div className="err">{err}</div>}
        <button className="btn primary" disabled={busy} type="submit">{busy ? "접수 중…" : "제보하기"}</button>
      </form>
    </main>
  );
}
