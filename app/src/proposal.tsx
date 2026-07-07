/* 제휴 제안 작성기 — 회원이 디렉토리의 특정 플랫폼에 제휴 방식별 제안을 보낸다.
 * AI 기본 양식(proposal-templates)을 방식별로 채워 보여주고, 회원이 검토·수정 후 발송.
 * 발송 게이트: FLAGS.outreach + app_settings 'outreach'.server_send 둘 다 on이면 세모플 서버(Edge Function)가
 * 대표 이메일로 발송, off면 회원 본인 메일(mailto)로 발송(세모플은 발신자 아님 → 정보통신망법 발신 책임 회피). */
import { useMemo, useState } from "react";
import type { Platform } from "./data";
import { partnerGroups, partnerTypes } from "./data";
import { Badge } from "./components";
import { useNav } from "./nav";
import { useSession } from "./lib/auth";
import { FLAGS } from "./config";
import { fetchOutreachConfig, recordOutreach, sendProposalServer } from "./lib/api";
import type { OutreachInput } from "./lib/api";
import { proposalSubject, proposalBody, GENERIC_MECHANICS } from "./data/proposal-templates";
import { checkAnonymity } from "./lib/anonymity";

const SITE = typeof location !== "undefined" ? `${location.origin}${import.meta.env.BASE_URL}` : "https://comdows.github.io/web1/";

export function ProposalComposer({ target, onClose }: { target: Platform; onClose: () => void }) {
  const go = useNav();
  const { session, profile } = useSession();
  const [typeId, setTypeId] = useState(partnerTypes[0]?.id ?? "");
  const [senderName, setSenderName] = useState(profile?.display_name ?? "");
  const [give, setGive] = useState("");
  const [get, setGet] = useState("");
  const [email, setEmail] = useState("");
  const [body, setBody] = useState("");
  const [edited, setEdited] = useState(false); // 회원이 본문을 직접 고쳤으면 자동 재생성 안 함
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<"self" | "server" | null>(null);
  const [err, setErr] = useState("");

  const type = partnerTypes.find((t) => t.id === typeId);
  const inviteLink = `${SITE}?view=partners  (세모플에서 "${target.name}"로 검색해 답하실 수 있어요)`;

  // 입력이 바뀌면(회원이 직접 편집하기 전까지) 기본 양식을 자동 채움
  const draft = useMemo(() => {
    if (!type) return "";
    return proposalBody({
      senderName: senderName || "(내 플랫폼 이름)", targetName: target.name,
      methodLabel: type.label, methodGroup: type.group,
      mechanics: type.mechanics || GENERIC_MECHANICS, give, get, inviteLink,
    });
  }, [type, senderName, give, get, target.name, inviteLink]);
  const shownBody = edited ? body : draft;
  const subject = type ? proposalSubject({ senderName: senderName || "내 플랫폼", targetName: target.name, methodLabel: type.label, methodGroup: type.group, mechanics: "", give: "", get: "", inviteLink: "" }) : "";

  // Give/Get에 연락처가 들어가면 안내(연락은 상대가 답하며 시작).
  const giveWarn = checkAnonymity(give, get).some((f) => f.type === "contact");

  const send = async () => {
    setErr("");
    if (!type) return;
    if (!senderName.trim()) { setErr("제안하는 내 플랫폼 이름을 입력해 주세요."); return; }
    if (!email.trim() || !/.+@.+\..+/.test(email.trim())) { setErr(`${target.name}의 대표 이메일을 입력해 주세요.`); return; }
    const input: OutreachInput = {
      target_platform_id: target.id, target_name: target.name, target_email: email.trim(),
      type_id: typeId, subject, body: shownBody, sender_name: senderName.trim(),
    };
    setBusy(true);
    try {
      const cfg = FLAGS.outreach ? await fetchOutreachConfig() : null;
      if (FLAGS.outreach && cfg?.server_send) {
        // 서버 발송(세모플 명의) — 스위치 on일 때만
        await sendProposalServer(input);
        setDone("server");
      } else {
        // 기본: 회원 본인 메일로 발송(mailto) + 기록
        await recordOutreach(input).catch(() => { /* 기록 실패해도 발송은 진행 */ });
        const href = `mailto:${encodeURIComponent(email.trim())}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(shownBody)}`;
        window.location.href = href;
        setDone("self");
      }
    } catch (ex) { setErr(ex instanceof Error ? ex.message : String(ex)); }
    finally { setBusy(false); }
  };

  if (!session) {
    return (
      <div className="banner" style={{ marginTop: 16 }}>
        제휴 제안에는 로그인이 필요해요. <button className="linklike" onClick={() => go("account")}>로그인/회원가입 →</button>
      </div>
    );
  }
  if (done) {
    return (
      <div className="done-card" style={{ marginTop: 16 }}>
        {done === "server"
          ? <>제안을 발송했어요 ✓ {target.name}가 세모플 회원이 아니면 가입 안내와 함께 전달됩니다. 진행 상태는 계정에서 확인할 수 있어요.</>
          : <>메일 앱이 열렸어요 — 내용을 확인하고 <b>보내기</b>를 누르면 {target.name}에게 전달됩니다. (세모플이 아닌 내 이메일로 발송됩니다.)</>}
        <div style={{ marginTop: 10 }}><button className="btn ghost sm" onClick={onClose}>닫기</button></div>
      </div>
    );
  }

  return (
    <div className="proposal-composer" style={{ marginTop: 16 }}>
      <div className="sec-title" style={{ marginTop: 0 }}>🤝 {target.name}에 제휴 제안</div>
      <p className="frm-note">아래 기본 양식을 검토·수정한 뒤 보내세요. {FLAGS.outreach ? "" : "현재는 내 이메일 앱으로 발송됩니다."}</p>
      <div className="frm">
        <label>제휴 방식
          <select value={typeId} onChange={(e) => { setTypeId(e.target.value); setEdited(false); }}>
            {partnerGroups.map((g) => (
              <optgroup key={g.id} label={g.label}>
                {partnerTypes.filter((t) => t.group === g.id).map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
              </optgroup>
            ))}
          </select>
        </label>
        <label>제안하는 내 플랫폼 이름
          <input value={senderName} onChange={(e) => { setSenderName(e.target.value); setEdited(false); }} placeholder="예: 이음" maxLength={40} />
        </label>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <label style={{ flex: 1, minWidth: 180 }}>내가 줄 것 (Give)
            <input value={give} onChange={(e) => { setGive(e.target.value); setEdited(false); }} placeholder="예: 메인 배너 1달 게재" maxLength={120} />
          </label>
          <label style={{ flex: 1, minWidth: 180 }}>받고 싶은 것 (Get)
            <input value={get} onChange={(e) => { setGet(e.target.value); setEdited(false); }} placeholder="예: 뉴스레터 1회 소개" maxLength={120} />
          </label>
        </div>
        {giveWarn && <div className="frm-note" style={{ color: "var(--warn)" }}>ⓘ Give/Get엔 연락처를 넣지 마세요 — 연락은 상대가 답하면서 시작됩니다.</div>}
        <label>{target.name} 대표 이메일
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="상대 플랫폼의 공개 제휴·대표 이메일" />
          <span className="frm-note">공식 사이트의 제휴/제휴문의/대표 이메일을 확인해 입력하세요.</span>
        </label>
        <label>제안 내용 (검토·수정 가능)
          <textarea value={shownBody} onChange={(e) => { setBody(e.target.value); setEdited(true); }} rows={14} style={{ fontSize: 13, lineHeight: 1.6 }} />
        </label>
        {err && <div className="err">{err}</div>}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button className="btn primary" disabled={busy} onClick={send}>{busy ? "발송 중…" : (FLAGS.outreach ? "제안 보내기 →" : "내 메일로 제안 보내기 →")}</button>
          <button className="btn ghost" onClick={onClose}>취소</button>
          {!FLAGS.outreach && <Badge kind="soon">세모플 직접 발송 준비 중</Badge>}
        </div>
        <p className="sub faint" style={{ fontSize: 12 }}>
          제안은 상대 플랫폼에 전달되며, 상대가 세모플 회원이 아니면 가입 안내가 함께 갑니다.
          무리한 반복 발송은 스팸이 될 수 있어요 — 정말 맞는 상대에게만 보내주세요.
        </p>
      </div>
    </div>
  );
}
