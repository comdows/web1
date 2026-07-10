/* 문의·도움말(0028) — FAQ + 인앱 문의 접수·내역. 비로그인은 FAQ + 이메일 폴백.
 * 문의는 본인·admin만 열람(RLS), 답변은 관리 콘솔 문의 큐에서 → 인앱 알림(inquiry_reply). */
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { createInquiry, listMyInquiries, remoteEnabled } from "./lib/api";
import type { Inquiry } from "./lib/api";
import { useSession } from "./lib/auth";
import { FLAGS } from "./config";
import { useNav } from "./nav";

const FAQ: { q: string; a: string }[] = [
  {
    q: "플랫폼 등재는 어떻게 하나요? 정보가 틀렸으면요?",
    a: "\"플랫폼 제보\"에서 이름·주소를 알려주시면 검수 후 등재해 드려요(무료). 이미 등재된 플랫폼의 정보가 틀렸다면 해당 플랫폼 상세 페이지 하단의 \"정정 제안\"으로 알려주세요. 수수료대·정산 주기 등은 공개 정보 기반 추정치라 공식 사이트가 항상 우선입니다.",
  },
  {
    q: "이용 후기는 어떻게 쓰고, 문제가 있는 글은 어떻게 하나요?",
    a: "로그인 후 플랫폼 상세에서 별점과 함께 후기를 남길 수 있어요(1인 1후기, 검수 후 게시). 부적절한 후기·게시물을 발견하면 옆의 🚩 신고 버튼으로 알려주세요 — 운영자가 확인 후 조치합니다. 내 후기는 언제든 수정(재검수)하거나 삭제할 수 있어요.",
  },
  {
    q: "제휴 매칭은 어떤 절차로 진행되나요?",
    a: "제휴 글을 올리면 검수 후 게시되고, 관심 신청이 오면 양쪽 모두 동의할 때만 운영자가 이메일로 소개해 드려요. 세모플은 제휴의 당사자가 아니며, 계약·정산은 당사자 간 직접 진행합니다. 연락처는 소개 전까지 공개되지 않아요.",
  },
  {
    q: "거래소(양수도)는 어떻게 이용하나요?",
    a: "자산·사업 양수도 매물만 다룹니다(지분·투자 유치는 다루지 않아요). 매각 접수 시 익명 코드명으로 게시되고, 인수 희망자가 관심을 등록하면 쌍방 동의 후 소개됩니다. 자세한 절차는 \"양수도 가이드\"를 확인하세요.",
  },
  {
    q: "이용 요금이 있나요?",
    a: "검색·비교·등재·후기 등 디렉토리 기능은 계속 무료입니다. 제휴·거래소의 일부 부가 서비스(스폰서 노출, 연결료 등)는 유료 전환이 예고될 수 있으며, 시행 30일 전에 공지하고 진행 중인 건은 무료로 마무리됩니다.",
  },
  {
    q: "알림·이메일 수신을 끊고 싶어요.",
    a: "인앱 알림은 계정 메뉴에서 확인·읽음 처리할 수 있어요. 이메일 수신 거부는 하단 \"이메일 수신거부\" 페이지에서 주소만 등록하면 즉시 반영됩니다(로그인 불필요).",
  },
  {
    q: "계정을 삭제(탈퇴)하고 싶어요.",
    a: "계정 페이지 하단의 탈퇴 절차를 따르면 제보·신청 이력이 함께 삭제됩니다. 진행 중인 소개·거래가 있다면 마무리 후 탈퇴를 권장해요.",
  },
  {
    q: "우리 플랫폼 운영자인데, 정보를 직접 관리하고 싶어요.",
    a: "플랫폼 상세의 \"운영자 인증\"에서 회사 도메인 이메일로 인증하면 ✓ 검증 배지와 함께 운영자 대시보드(노출·클릭 통계, 받은 제휴 제안)를 쓸 수 있어요.",
  },
];

const STATUS_KO: Record<Inquiry["status"], { label: string; cls: string }> = {
  open: { label: "답변 대기", cls: "soon" },
  answered: { label: "답변 완료", cls: "good" },
  closed: { label: "종료", cls: "muted" },
};

function InquiryForm({ onDone }: { onDone: () => void }) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (title.trim().length < 2) { setMsg({ ok: false, text: "제목을 2자 이상 적어 주세요" }); return; }
    if (body.trim().length < 10) { setMsg({ ok: false, text: "내용을 10자 이상 적어 주세요" }); return; }
    setBusy(true); setMsg(null);
    try {
      await createInquiry(title, body);
      setTitle(""); setBody("");
      setMsg({ ok: true, text: "접수됐어요 — 답변이 등록되면 알림으로 알려드려요." });
      onDone();
    } catch (ex) {
      setMsg({ ok: false, text: ex instanceof Error ? ex.message : "접수에 실패했어요" });
    } finally { setBusy(false); }
  };
  return (
    <form className="frm" onSubmit={submit} style={{ maxWidth: 560 }}>
      <label>제목
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={100} placeholder="예: 등재 정보 수정 요청" />
      </label>
      <label>내용
        <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={5} maxLength={2000}
          placeholder="문의 내용을 적어 주세요. 특정 플랫폼·게시물 관련이면 이름이나 링크를 함께 적어 주시면 빨라요." />
      </label>
      <div className="frm-note">답변 대기 문의는 한 번에 3건까지 접수할 수 있어요.</div>
      {msg && <div className="frm-note" style={{ color: msg.ok ? "var(--teal)" : "#c0392b" }}>{msg.text}</div>}
      <button className="btn" disabled={busy}>{busy ? "접수 중…" : "문의 접수"}</button>
    </form>
  );
}

export function Support() {
  const go = useNav();
  const { session } = useSession();
  const [mine, setMine] = useState<Inquiry[]>([]);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (!session) { setMine([]); return; }
    let alive = true;
    listMyInquiries().then((rows) => { if (alive) setMine(rows); });
    return () => { alive = false; };
  }, [session, reload]);

  return (
    <main className="container" style={{ paddingTop: 24, paddingBottom: 48 }}>
      <h1>문의·도움말</h1>
      <p className="sub" style={{ marginBottom: 18 }}>자주 묻는 질문에서 먼저 찾아보고, 없으면 아래로 문의해 주세요.</p>

      <div className="sec-title">자주 묻는 질문</div>
      <div style={{ display: "grid", gap: 8, marginBottom: 26, maxWidth: 720 }}>
        {FAQ.map((f) => (
          <details key={f.q} className="panel" style={{ padding: "10px 14px" }}>
            <summary style={{ cursor: "pointer", fontWeight: 600 }}>{f.q}</summary>
            <p style={{ margin: "8px 0 2px", lineHeight: 1.65 }}>{f.a}</p>
          </details>
        ))}
      </div>

      <div className="sec-title">1:1 문의</div>
      {!remoteEnabled || !session ? (
        <div className="panel" style={{ padding: 16, maxWidth: 560 }}>
          <p style={{ margin: 0 }}>🔐 문의 접수에는 로그인이 필요해요 — 답변을 계정 알림으로 드리기 위해서예요.</p>
          <div style={{ marginTop: 10, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            {remoteEnabled && <button className="btn" onClick={() => go("account")}>로그인 / 가입</button>}
            {FLAGS.contactEmail && <a className="foot-link" href={`mailto:${FLAGS.contactEmail}`}>이메일로 문의 ({FLAGS.contactEmail})</a>}
          </div>
        </div>
      ) : (
        <>
          <InquiryForm onDone={() => setReload((n) => n + 1)} />
          {mine.length > 0 && (
            <>
              <div className="sec-title" style={{ marginTop: 24 }}>내 문의 내역</div>
              <div className="sub-list" style={{ maxWidth: 720 }}>
                {mine.map((i) => (
                  <div className="sub-item" key={i.id}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 600 }}>{i.title} <span className={`badge ${STATUS_KO[i.status].cls}`}>{STATUS_KO[i.status].label}</span></div>
                      <div className="frm-note">{i.created_at.slice(0, 10)} · {i.body.slice(0, 80)}</div>
                      {i.reply && (
                        <div style={{ marginTop: 6, padding: "8px 10px", background: "var(--bg-soft, #f6f8fa)", borderRadius: 8, fontSize: 13.5 }}>
                          <b>운영자 답변{i.replied_at ? ` (${i.replied_at.slice(0, 10)})` : ""}</b><br />{i.reply}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </main>
  );
}
