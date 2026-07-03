/* P2 참여 화면 — 계정(로그인·회원가입·프로필·내 제보) + 플랫폼 제보 폼 */
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { groups, categoriesByGroup } from "./data";
import { Badge } from "./components";
import { useNav } from "./nav";
import { signIn, signOut, signUp, useSession, refreshProfile } from "./lib/auth";
import { createSubmission, listMySubmissions, remoteEnabled, updateDisplayName } from "./lib/api";
import type { Submission } from "./lib/api";

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
  const [mode, setMode] = useState<"in" | "up">("in");
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(""); setOk(""); setBusy(true);
    try {
      if (mode === "in") {
        await signIn(email.trim(), pw);
      } else {
        const r = await signUp(email.trim(), pw);
        if (r.needsConfirm) setOk("확인 메일을 보냈어요. 메일의 링크를 누른 뒤 여기서 로그인하세요.");
      }
    } catch (ex) {
      const m = ex instanceof Error ? ex.message : String(ex);
      setErr(/invalid login credentials/i.test(m) ? "이메일 또는 비밀번호가 맞지 않습니다."
        : /already registered/i.test(m) ? "이미 가입된 이메일입니다. 로그인해 주세요."
        : /at least 6/i.test(m) ? "비밀번호는 6자 이상이어야 합니다." : m);
    } finally { setBusy(false); }
  };

  return (
    <div className="auth-card">
      {!compact && (
        <div className="tabbar">
          <button className={`btn ghost sm ${mode === "in" ? "on" : ""}`} onClick={() => { setMode("in"); setErr(""); }}>로그인</button>
          <button className={`btn ghost sm ${mode === "up" ? "on" : ""}`} onClick={() => { setMode("up"); setErr(""); }}>회원가입</button>
        </div>
      )}
      <form className="frm" onSubmit={submit}>
        <label>이메일
          <input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
        </label>
        <label>비밀번호
          <input type="password" required minLength={6} autoComplete={mode === "in" ? "current-password" : "new-password"}
            value={pw} onChange={(e) => setPw(e.target.value)} placeholder="6자 이상" />
        </label>
        {err && <div className="err">{err}</div>}
        {ok && <div className="ok">{ok}</div>}
        <button className="btn primary" disabled={busy} type="submit">
          {busy ? "처리 중…" : mode === "in" ? "로그인" : "가입하기"}
        </button>
        <div className="frm-note">가입하면 즐겨찾기가 계정에 저장되고, 플랫폼 제보를 남길 수 있어요.</div>
      </form>
    </div>
  );
}

/* ── 계정 화면 ────────────────────────────────────────────── */
export function Account() {
  const go = useNav();
  const { session, profile, isAdmin } = useSession();
  const [name, setName] = useState("");
  const [saved, setSaved] = useState(false);
  const [subs, setSubs] = useState<Submission[] | null>(null);

  useEffect(() => { setName(profile?.display_name ?? ""); }, [profile?.display_name]);
  useEffect(() => {
    if (!session) { setSubs(null); return; }
    let alive = true;
    listMySubmissions().then((s) => { if (alive) setSubs(s); }).catch(() => { if (alive) setSubs([]); });
    return () => { alive = false; };
  }, [session]);

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

  const saveName = async (e: FormEvent) => {
    e.preventDefault();
    try { await updateDisplayName(name.trim()); setSaved(true); refreshProfile(); setTimeout(() => setSaved(false), 2000); } catch { /* noop */ }
  };

  return (
    <main className="page container">
      <h1>계정</h1>
      <div className="auth-card">
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
          <span className="mono" style={{ fontSize: 13 }}>{session.user.email}</span>
          {isAdmin && <Badge kind="verify">관리자</Badge>}
        </div>
        <form className="frm" onSubmit={saveName}>
          <label>표시 이름
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="예: 이음 운영자" maxLength={40} />
          </label>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn primary sm" type="submit">저장</button>
            {saved && <span className="ok" style={{ alignSelf: "center" }}>저장됨 ✓</span>}
          </div>
        </form>
        <div className="frm-note" style={{ marginTop: 12 }}>★ 즐겨찾기는 로그인 중 자동으로 계정에 동기화됩니다.</div>
        <div style={{ marginTop: 16, display: "flex", gap: 8 }}>
          {isAdmin && <button className="btn ghost sm" onClick={() => go("admin")}>🛠 관리 콘솔</button>}
          <button className="btn ghost sm" onClick={() => signOut()}>로그아웃</button>
        </div>
      </div>

      <div className="sec-title" style={{ marginTop: 28 }}>내 제보</div>
      {subs === null ? <div className="empty">불러오는 중…</div>
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
        <div className="empty" style={{ borderColor: "var(--success)" }}>
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
