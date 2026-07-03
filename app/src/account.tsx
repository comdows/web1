/* P2 참여 화면 — 계정(로그인·회원가입·프로필·내 제보) + 플랫폼 제보 폼 */
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { groups, categoriesByGroup } from "./data";
import { Badge } from "./components";
import { useNav } from "./nav";
import {
  consumeHashNotice, consumeRecoveryPending, requestPasswordReset, resendConfirmation,
  signIn, signInWithGoogle, signOut, signUp, updatePassword, useSession, refreshProfile,
} from "./lib/auth";
import { TERMS_VERSION } from "./legal";
import { FLAGS } from "./config";
import {
  briefMatchesDeal, createSubmission, fetchDeals, listMyBriefs, listMyDealInterests,
  listMyDealSubmissions, listMyPartnerInterests, listMyPartnerPosts, listMySubmissions,
  remoteEnabled, updateDisplayName,
} from "./lib/api";
import type { BuyerBriefRow, DealSubmissionRow, MyInterestRow, PartnerPostAdmin, PublicDeal, Submission } from "./lib/api";

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

/* ── 로그인 / 회원가입 ─────────────────────────────────────── */
export function AuthPanel({ compact = false }: { compact?: boolean }) {
  const [mode, setMode] = useState<"in" | "up" | "forgot">("in");
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");
  const [needsConfirm, setNeedsConfirm] = useState(false); // 확인 메일 재발송 노출 여부

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
        : /at least 6/i.test(m) ? "비밀번호는 6자 이상이어야 합니다." : m);
    } finally { setBusy(false); }
  };

  const resend = async () => {
    setErr(""); setBusy(true);
    try { await resendConfirmation(email.trim()); setOk("확인 메일을 다시 보냈어요. 메일함(스팸함 포함)을 확인해 주세요."); }
    catch (ex) { setErr(ex instanceof Error ? ex.message : String(ex)); }
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
        {err && <div className="err">{err}</div>}
        {ok && <div className="ok">{ok}</div>}
        <button className="btn primary" disabled={busy} type="submit">
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
          <div className="frm-note">
            <b>가입하기</b>를 누르면 세모플 <ConsentLinks />에 동의하는 것으로 봅니다.
            가입하면 즐겨찾기가 계정에 저장되고, 플랫폼 제보·제휴 제안을 남길 수 있어요.
          </div>
        ) : (
          <div className="frm-note">가입하면 즐겨찾기가 계정에 저장되고, 플랫폼 제보를 남길 수 있어요.</div>
        )}
      </form>
    </div>
  );
}

function ConsentLinks() {
  const go = useNav();
  return (
    <>
      <button type="button" className="linklike" style={{ textDecoration: "underline" }} onClick={() => go("terms")}>이용약관</button>과{" "}
      <button type="button" className="linklike" style={{ textDecoration: "underline" }} onClick={() => go("privacy")}>개인정보처리방침</button>
    </>
  );
}

/* ── 계정 화면 ────────────────────────────────────────────── */
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
  const [acts, setActs] = useState<{ pp: PartnerPostAdmin[]; ds: DealSubmissionRow[]; pi: MyInterestRow[]; di: MyInterestRow[]; br: BuyerBriefRow[] } | null>(null);
  const [actsErr, setActsErr] = useState(false);
  const [briefDeals, setBriefDeals] = useState<PublicDeal[]>([]); // 브리프 조건 대조용(공개 뷰)

  useEffect(() => { setName(profile?.display_name ?? ""); }, [profile?.display_name]);
  useEffect(() => {
    if (!session) { setSubs(null); return; }
    let alive = true;
    setSubsError(false); setSubs(null);
    listMySubmissions()
      .then((s) => { if (alive) setSubs(s); })
      .catch(() => { if (alive) { setSubsError(true); setSubs(null); } });
    setActsErr(false);
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
        <div className="frm-note" style={{ marginTop: 12 }}>★ 즐겨찾기는 로그인 중 자동으로 계정에 동기화됩니다.</div>
        <div style={{ marginTop: 16, display: "flex", gap: 8, flexWrap: "wrap" }}>
          {isAdmin && <button className="btn primary sm" onClick={() => go("admin")}>🛠 관리 콘솔</button>}
          <button className="btn ghost sm" onClick={() => { refreshProfile(); setChecked(true); setTimeout(() => setChecked(false), 2500); }}>권한 새로고침</button>
          <button className="btn ghost sm" onClick={() => signOut()}>로그아웃</button>
          {checked && !isAdmin && <span className="frm-note" style={{ alignSelf: "center" }}>아직 일반 회원이에요. Supabase에서 admin 지정 후 눌러보세요.</span>}
        </div>
        {FLAGS.contactEmail && (
          <div className="frm-note" style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--line-soft)" }}>
            회원 탈퇴(개인정보 전체 삭제)를 원하시면{" "}
            <a href={`mailto:${FLAGS.contactEmail}?subject=${encodeURIComponent("[세모플] 회원 탈퇴 요청")}&body=${encodeURIComponent(`가입 이메일: ${session.user.email ?? ""}\n탈퇴 및 개인정보 삭제를 요청합니다.`)}`}>
              {FLAGS.contactEmail}
            </a>
            로 요청해 주세요 — 지체 없이 처리합니다.
          </div>
        )}
      </div>

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
                  <Badge kind={b.kind}>{b.label}</Badge>
                </div>
              );
            })}
          </div>
        )}

      <div className="sec-title" style={{ marginTop: 28 }}>내 활동 (제휴·거래소)</div>
      {actsErr ? (
        <div className="empty">활동 내역을 불러오지 못했어요. <button className="linklike" onClick={() => setReload((n) => n + 1)}>다시 시도</button></div>
      ) : acts === null ? <div className="empty">불러오는 중…</div>
      : (acts.pp.length + acts.ds.length + acts.pi.length + acts.di.length + acts.br.length) === 0 ? (
        <div className="empty">제휴 제안·매각 접수·매칭 신청·관심 등록이 여기에 표시됩니다.</div>
      ) : (() => {
        const matchedIds = [...new Set(
          acts.br.filter((b) => b.active).flatMap((b) => briefDeals.filter((d) => briefMatchesDeal(b, d)).map((d) => d.id))
        )];
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
                <Badge kind={b.k}>{b.l}</Badge>
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
                <Badge kind={b.k}>{b.l}</Badge>
              </div>
            );
          })}
          {acts.pi.map((i) => (
            <div className="sub-item" key={i.id}>
              <div style={{ minWidth: 0 }}>🤝 <b>매칭 신청</b> — "{i.partner_posts?.title ?? i.post_id}"</div>
              <Badge kind={i.status === "introduced" ? "verify" : "soon"}>{i.status === "introduced" ? "소개 완료" : "접수됨"}</Badge>
            </div>
          ))}
          {acts.di.map((i) => (
            <div className="sub-item" key={i.id}>
              <div style={{ minWidth: 0 }}>🏦 <b>인수 관심</b> — 매물 {i.deal_id}
                {i.status === "introduced" && (
                  <div className="frm-note">
                    소개 메일이 발송됐어요 — 메일함(스팸함 포함)을 확인하세요.
                    {FLAGS.contactEmail && <> 24시간 내 미도착 시 <a href={`mailto:${FLAGS.contactEmail}?subject=${encodeURIComponent(`[세모플] 소개 메일 미도착 — ${i.deal_id ?? ""}`)}`}>문의</a>.</>}
                  </div>
                )}
              </div>
              <Badge kind={i.status === "introduced" ? "verify" : "soon"}>{i.status === "introduced" ? "소개 완료" : "접수됨"}</Badge>
            </div>
          ))}
          {acts.br.map((b) => (
            <div className="sub-item" key={b.id}>
              <div style={{ minWidth: 0 }}>📮 <b>인수 브리프</b> — {b.budget_band} · {b.mode}</div>
              <Badge kind={b.active ? "soon" : "muted"}>{b.active ? "대기 중" : "안내 완료"}</Badge>
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
