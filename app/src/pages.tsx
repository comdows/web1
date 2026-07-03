import { useEffect, useMemo, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { listings, categoryById, groups, categoriesByGroup, partnerGoals, partnerGroups, partnerTypes } from "./data";
import type { PartnerType } from "./data";
import { Badge } from "./components";
import { FLAGS } from "./config";
import { useNav } from "./nav";
import { useSession } from "./lib/auth";
import {
  applyToPartnerPost, createBuyerBrief, createDealSubmission, createPartnerPost,
  fetchDeals, fetchPartnerPosts, registerDealInterest, remoteEnabled,
} from "./lib/api";
import type { PartnerPost, PublicDeal } from "./lib/api";

const ISSUE = (title: string, body: string, labels?: string) =>
  `https://github.com/comdows/web1/issues/new?title=${encodeURIComponent(title)}` +
  `&body=${encodeURIComponent(body + "\n\n(연락처는 적지 마세요 — 운영자가 이슈 댓글로 다음 절차를 안내합니다)")}` +
  (labels ? `&labels=${encodeURIComponent(labels)}` : "");

const SETTLE: Record<PartnerType["settlement"], { label: string; kind: "good" | "soon" | "verify" }> = {
  none:   { label: "정산 없음",       kind: "good" },
  direct: { label: "당사자 직접 정산", kind: "verify" },
  share:  { label: "비용 분담",       kind: "soon" },
};
const EFFORT: Record<PartnerType["effort"], string> = { light: "가볍게 시작", mid: "보통", heavy: "깊은 연동" };

const SIZE_BANDS = ["월 방문 ~1만", "월 방문 1~5만", "월 방문 5~20만", "월 방문 20만+", "밝히지 않음"];
const REVENUE_BANDS = ["연매출 1억 미만", "연매출 1~5억", "연매출 5~20억", "연매출 20억+"];
const DEAL_MODES = ["지분 전량 매각", "지분 일부+운영 승계", "자산 양수도(선별 인수)"];
const BUDGET_BANDS = ["~1억", "1~5억", "5~20억", "20억+"];

function ProcessStrip({ steps }: { steps: { t: string; d: string }[] }) {
  return (
    <div className="process">
      {steps.map((s, i) => (
        <div className="step" key={i}>
          <div className="num mono">{String(i + 1).padStart(2, "0")}</div>
          <h4>{s.t}</h4><p>{s.d}</p>
        </div>
      ))}
    </div>
  );
}

/* 로그인 게이트 — 폼은 로그인 후에만(접수·소개 안내를 계정으로 전달하기 위함) */
function LoginGate({ children, what }: { children: ReactNode; what: string }) {
  const go = useNav();
  const { session } = useSession();
  if (!remoteEnabled) return null;
  if (session) return <>{children}</>;
  return (
    <div className="banner" style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
      <span>🔐 {what}에는 로그인이 필요해요 — 진행 상황을 계정으로 안내드립니다.</span>
      <button className="btn primary sm" onClick={() => go("account")}>로그인 / 회원가입 →</button>
    </div>
  );
}

/* 분야 선택 옵션(그룹별 optgroup) */
function CategoryOptions() {
  return (
    <>
      {groups.map((g) => (
        <optgroup key={g.id} label={`${g.icon} ${g.name}`}>
          {categoriesByGroup(g.id).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </optgroup>
      ))}
    </>
  );
}

/* ─────────────── 2단계: 제휴 매칭 ─────────────── */

/* 제안 등록 폼 */
function PartnerPostForm({ typeId, onDone }: { typeId: string; onDone: () => void }) {
  const [title, setTitle] = useState("");
  const [cat, setCat] = useState("");
  const [type, setType] = useState(typeId);
  const [give, setGive] = useState("");
  const [get, setGet] = useState("");
  const [want, setWant] = useState("");
  const [size, setSize] = useState(SIZE_BANDS[4]);
  const [detail, setDetail] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => { if (typeId) setType(typeId); }, [typeId]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(""); setBusy(true);
    try {
      await createPartnerPost({
        title: title.trim(), category_id: cat, type_id: type,
        give_text: give.trim(), get_text: get.trim(),
        want_categories: want ? [want] : [], size_text: size, detail: detail.trim(),
      });
      onDone();
    } catch (ex) { setErr(ex instanceof Error ? ex.message : String(ex)); }
    finally { setBusy(false); }
  };

  return (
    <form className="frm auth-card" style={{ maxWidth: 620 }} onSubmit={submit}>
      <label>표시 이름 * <span style={{ fontWeight: 400, color: "var(--faint)" }}>(반익명 권장 — 예: "핸드메이드 마켓 A")</span>
        <input required value={title} onChange={(e) => setTitle(e.target.value)} placeholder="보드에 표시될 이름" maxLength={40} />
      </label>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <label style={{ flex: 1, minWidth: 180 }}>우리 분야 *
          <select required value={cat} onChange={(e) => setCat(e.target.value)}>
            <option value="" disabled>선택</option><CategoryOptions />
          </select>
        </label>
        <label style={{ flex: 1, minWidth: 180 }}>제휴 방식 *
          <select required value={type} onChange={(e) => setType(e.target.value)}>
            <option value="" disabled>선택</option>
            {partnerGroups.map((g) => (
              <optgroup key={g.id} label={g.label}>
                {partnerTypes.filter((t) => t.group === g.id).map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
              </optgroup>
            ))}
          </select>
        </label>
      </div>
      <label>상대에게 제공할 것 (Give) *
        <input required value={give} onChange={(e) => setGive(e.target.value)} placeholder="예: 메인 배너 지면 1구좌, 뉴스레터 소개" maxLength={120} />
      </label>
      <label>상대에게 원하는 것 (Get) *
        <input required value={get} onChange={(e) => setGet(e.target.value)} placeholder="예: 동일 규모 배너 교환, 신규 회원 유입" maxLength={120} />
      </label>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <label style={{ flex: 1, minWidth: 180 }}>원하는 상대 분야
          <select value={want} onChange={(e) => setWant(e.target.value)}>
            <option value="">전체(무관)</option><CategoryOptions />
          </select>
        </label>
        <label style={{ flex: 1, minWidth: 180 }}>규모(대략)
          <select value={size} onChange={(e) => setSize(e.target.value)}>
            {SIZE_BANDS.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
      </div>
      <label>한 줄 소개
        <textarea rows={2} value={detail} onChange={(e) => setDetail(e.target.value)} maxLength={200}
          placeholder="어떤 플랫폼이고 왜 이 제휴가 서로에게 좋은지" />
      </label>
      <div className="frm-note">⚠️ 연락처·URL 등 식별 정보는 적지 마세요 — 검수 후 게시되며, 소개는 세모플이 비공개로 진행합니다.</div>
      {err && <div className="err">{err}</div>}
      <button className="btn primary" disabled={busy} type="submit">{busy ? "접수 중…" : "제안 등록"}</button>
    </form>
  );
}

/* 매칭 신청 폼(포스트별 인라인) */
function ApplyForm({ postId, onDone }: { postId: string; onDone: () => void }) {
  const [name, setName] = useState("");
  const [cat, setCat] = useState("");
  const [size, setSize] = useState(SIZE_BANDS[4]);
  const [pitch, setPitch] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(""); setBusy(true);
    try {
      await applyToPartnerPost(postId, { platform_name: name.trim(), category_id: cat || undefined, size_text: size, pitch: pitch.trim() });
      onDone();
    } catch (ex) { setErr(ex instanceof Error ? ex.message : String(ex)); }
    finally { setBusy(false); }
  };
  return (
    <form className="frm" style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--line-soft)" }} onSubmit={submit}>
      <label>우리 플랫폼 이름 * <input required value={name} onChange={(e) => setName(e.target.value)} maxLength={40} placeholder="반익명 가능" /></label>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <label style={{ flex: 1, minWidth: 150 }}>분야
          <select value={cat} onChange={(e) => setCat(e.target.value)}><option value="">선택 안 함</option><CategoryOptions /></select>
        </label>
        <label style={{ flex: 1, minWidth: 150 }}>규모
          <select value={size} onChange={(e) => setSize(e.target.value)}>{SIZE_BANDS.map((s) => <option key={s} value={s}>{s}</option>)}</select>
        </label>
      </div>
      <label>제안 요지 * <textarea required rows={2} value={pitch} onChange={(e) => setPitch(e.target.value)} maxLength={200} placeholder="무엇을 주고받을지 (연락처 금지)" /></label>
      <label className="facet-opt" style={{ fontSize: 12.5 }}>
        <input type="checkbox" required />
        매칭 확인 시 상대에게 <b>내 계정 이메일이 공유</b>되는 데 동의합니다. *
      </label>
      {err && <div className="err">{err}</div>}
      <button className="btn primary sm" disabled={busy} type="submit">{busy ? "신청 중…" : "매칭 신청"}</button>
    </form>
  );
}

export function Partners() {
  const { session } = useSession();
  const go = useNav();
  const [goal, setGoal] = useState("");
  const [openType, setOpenType] = useState<string | null>(null);
  const [formType, setFormType] = useState("");        // 카탈로그 CTA로 선선택된 방식
  const [showForm, setShowForm] = useState(false);
  const [posted, setPosted] = useState(false);
  const [posts, setPosts] = useState<PartnerPost[] | null>(null);
  const [boardType, setBoardType] = useState("");
  const [applyTo, setApplyTo] = useState<string | null>(null);
  const [applied, setApplied] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!remoteEnabled) { setPosts([]); return; }
    fetchPartnerPosts().then(setPosts).catch(() => setPosts([]));
  }, [posted]);

  const visibleTypes = useMemo(
    () => (goal ? partnerTypes.filter((t) => t.goals.includes(goal)) : partnerTypes),
    [goal]
  );

  const openForm = (typeId: string) => {
    setFormType(typeId); setShowForm(true); setPosted(false);
    setTimeout(() => document.getElementById("ppost-form")?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  };

  // 기존 데모 리스팅 라벨 → 카탈로그 방식 매핑
  const legacyMap: Record<string, string> = {
    "회원 상호송출": "cross_signup", "교차 프로모션": "coupon_exchange",
    "공동 이벤트": "joint_event", "광고 지면 교환": "banner_swap", "공동구매·번들": "bundle",
  };
  const realItems = (posts ?? []).filter((p) => !boardType || p.type_id === boardType);
  const demoItems = listings.partnerships.filter((l) => !boardType || legacyMap[l.type] === boardType);
  const typeLabel = (id: string) => partnerTypes.find((t) => t.id === id)?.label ?? id;

  return (
    <div className="page container">
      <h1>🤝 제휴 매칭 <Badge kind="good">오픈 · 무료 베타</Badge></h1>
      <p className="lead">
        플랫폼끼리 배너를 맞바꾸고, 회원을 서로 보내고, 레퍼럴 수수료로 함께 크는 곳.
        세모플은 <b>연결·소개만</b> 하고 정산·계약은 두 플랫폼이 직접 합니다(자금 미보유 원칙).
      </p>

      <ProcessStrip steps={[
        { t: "제휴 방식 고르기", d: "아래 카탈로그에서 우리에게 맞는 방식을 찾습니다" },
        { t: "제안 등록", d: "Give/Get·규모를 적어 제안을 올립니다(검수 후 게시)" },
        { t: "세모플이 확인·소개", d: "상대 실재 확인 후 양측 동의 시에만 소개" },
        { t: "당사자 직접 진행", d: "실행·정산·계약은 두 플랫폼이 직접" },
      ]} />

      {/* ── 제휴 방식 카탈로그 (공개) ── */}
      <div className="sec-title">제휴 방식 카탈로그 · {partnerTypes.length}가지</div>
      <div className="chips-row">
        <button className={`fchip ${goal === "" ? "on" : ""}`} onClick={() => setGoal("")}>전체</button>
        {partnerGoals.map((g) => (
          <button key={g.id} className={`fchip ${goal === g.id ? "on" : ""}`}
            onClick={() => setGoal(goal === g.id ? "" : g.id)}>{g.label}</button>
        ))}
      </div>

      {partnerGroups.map((grp) => {
        const items = visibleTypes.filter((t) => t.group === grp.id);
        if (items.length === 0) return null;
        return (
          <div key={grp.id} style={{ marginBottom: 22 }}>
            <h3 style={{ fontSize: 16, margin: "18px 0 4px" }}>{grp.label}</h3>
            <p className="muted" style={{ fontSize: 13, margin: "0 0 12px" }}>{grp.desc}</p>
            <div className="card-grid">
              {items.map((t) => {
                const open = openType === t.id;
                return (
                  <div className="pcard type-card" key={t.id}>
                    <h4 style={{ marginBottom: 4 }}>{t.label}</h4>
                    <div className="chips-row" style={{ margin: "6px 0" }}>
                      <Badge kind={SETTLE[t.settlement].kind}>{SETTLE[t.settlement].label}</Badge>
                      <Badge kind="muted">{EFFORT[t.effort]}</Badge>
                    </div>
                    <p style={{ margin: "4px 0 0" }}>{t.desc}</p>
                    {open && (
                      <div className="type-detail">
                        <div><span className="k">작동 방식</span>{t.mechanics}</div>
                        <div><span className="k">예시</span>{t.example}</div>
                      </div>
                    )}
                    <div className="pcard-actions">
                      <button className="linklike" onClick={() => setOpenType(open ? null : t.id)}>
                        {open ? "접기 ▴" : "작동 방식·예시 ▾"}
                      </button>
                      <button className="btn primary sm" style={{ marginLeft: "auto" }} onClick={() => openForm(t.id)}>
                        이 방식으로 제안 →
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}

      {/* ── 제안 등록 ── */}
      <div className="sec-title" id="ppost-form">제휴 제안 등록</div>
      {!remoteEnabled ? (
        <div className="banner">백엔드 미연결 빌드 — <a href={ISSUE("[제휴 제안]", "제휴 방식:\n플랫폼 이름:\nGive:\nGet:", "stage2,제휴제안")} target="_blank" rel="noopener noreferrer">GitHub 이슈로 제안</a></div>
      ) : posted ? (
        <div className="empty" style={{ borderColor: "var(--success)", padding: 24 }}>
          접수됐어요 ✓ 검수(중복·연락처 확인) 후 보드에 게시됩니다. 진행 상태는 세모플이 계정 이메일로 안내드려요.
          {FLAGS.contactEmail && <div className="frm-note" style={{ marginTop: 6 }}>문의: <a href={`mailto:${FLAGS.contactEmail}`}>{FLAGS.contactEmail}</a></div>}
          <div style={{ marginTop: 10 }}><button className="btn ghost sm" onClick={() => setPosted(false)}>하나 더 등록</button></div>
        </div>
      ) : !session ? (
        <LoginGate what="제안 등록"><span /></LoginGate>
      ) : showForm || formType ? (
        <PartnerPostForm typeId={formType} onDone={() => { setPosted(true); setShowForm(false); setFormType(""); }} />
      ) : (
        <div className="banner" style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <span>위 카탈로그에서 방식을 고르거나, 바로 등록할 수 있어요.</span>
          <button className="btn primary sm" onClick={() => setShowForm(true)}>+ 제안 등록</button>
        </div>
      )}

      {/* ── 요금 안내 (stage2-monetization-plan.md) ── */}
      <div className="sec-title">요금 안내</div>
      <div className="banner" style={{ marginBottom: 14 }}>
        ✅ <b>지금은 전면 무료(베타)</b>입니다. 유료화는 매칭이 충분히 활발해진 뒤(공개 기준 충족 시) 단계적으로 시작하며,
        진행 중인 제휴는 무료로 마무리됩니다.
      </div>
      <div className="card-grid" style={{ marginBottom: 14 }}>
        <div className="pcard"><h4>무료 <Badge kind="good">현재</Badge></h4>
          <p>등재·제휴 프로필·매칭 신청·배너교환형 제휴 무제한. 소개까지 전 과정 무료.</p></div>
        <div className="pcard"><h4>스폰서 노출 <Badge kind="soon">준비중</Badge></h4>
          <p>매칭 보드 상단 고정 슬롯(월 정액, <b>AD 표기</b>). 디렉토리 검색·비교 결과는 판매하지 않습니다.</p></div>
        <div className="pcard"><h4>연결료 <Badge kind="soon">준비중</Badge></h4>
          <p>양측 동의 후 <b>연락처를 상호 공유하는 순간</b>에만 소액 정액(방식 유형별 차등). 신청·매칭 확인까지는 무료,
            소개가 이행되지 않으면 전액 환불.</p></div>
        <div className="pcard"><h4>멤버십 <Badge kind="soon">예정</Badge></h4>
          <p>파트너 검색 무제한·검증 배지·트래킹 대시보드·매칭 큐레이션(월 정액).</p></div>
      </div>
      <p className="sub faint" style={{ fontSize: 12.5, marginBottom: 6 }}>
        원칙 — ① 세모플은 <b>소개(연결)를 팔지, 성사를 팔지 않습니다</b>(제휴 체결·성과는 당사자 몫).
        ② 디렉토리 정보(검색·비교·순위)는 어떤 경우에도 판매하지 않습니다.
        ③ 제휴 대금·정산에는 일절 관여하지 않습니다 — 세모플 명의의 서비스 이용료만 받습니다.
      </p>

      {/* ── 매칭 보드 ── */}
      <div className="sec-title">제휴 매칭 보드</div>
      <div className="chips-row">
        <button className={`fchip ${boardType === "" ? "on" : ""}`} onClick={() => setBoardType("")}>전체</button>
        {Object.values(legacyMap).map((id) => (
          <button key={id} className={`fchip ${boardType === id ? "on" : ""}`}
            onClick={() => setBoardType(boardType === id ? "" : id)}>{typeLabel(id)}</button>
        ))}
      </div>
      <div className="result-meta">
        제휴 제안 {posts === null ? "…" : realItems.length + demoItems.length}건
        {realItems.length === 0 && demoItems.length > 0 && " (아직 데모 예시 — 첫 제안의 주인공이 되어보세요)"}
      </div>
      <div className="card-grid">
        {realItems.map((p) => (
          <div className="pcard" key={p.id}>
            <div className="top"><div style={{ minWidth: 0 }}>
              <h4>{p.title} {p.status === "matched" && <Badge kind="good">성사</Badge>}</h4>
              <div className="cat">{typeLabel(p.type_id)} · {categoryById(p.category_id)?.name ?? p.category_id}
                {p.want_categories.length > 0 && ` → ${p.want_categories.map((w) => categoryById(w)?.name ?? w).join(", ")}`}</div>
            </div></div>
            {p.detail && <p>{p.detail}</p>}
            <p style={{ fontSize: 12.5 }}><b>Give</b> {p.give_text}<br /><b>Get</b> {p.get_text}<br />
              <span className="faint">{p.size_text}{p.posted ? ` · ${p.posted}` : ""}</span></p>
            {p.status === "published" && (
              applied.has(p.id) ? <div className="ok" style={{ fontSize: 13 }}>신청 완료 ✓ 세모플이 확인 후 안내드립니다</div>
              : applyTo === p.id ? (
                !session
                  ? <div className="frm-note">매칭 신청에는 로그인이 필요해요. <button className="linklike" onClick={() => go("account")}>로그인 →</button></div>
                  : <ApplyForm postId={p.id} onDone={() => { setApplied((s) => new Set(s).add(p.id)); setApplyTo(null); }} />
              ) : (
                <div className="pcard-actions">
                  <button className="btn primary sm" style={{ marginLeft: "auto" }} onClick={() => setApplyTo(p.id)}>이 제안에 매칭 신청 →</button>
                </div>
              )
            )}
          </div>
        ))}
        {demoItems.map((l) => (
          <div className="pcard" key={l.id} style={{ opacity: .82 }}>
            <div className="top"><div style={{ minWidth: 0 }}>
              <h4>{l.title} <Badge kind="muted">데모</Badge>
                {l.status === "matched" && <Badge kind="good">성사</Badge>}</h4>
              <div className="cat">{l.type} · {categoryById(l.from)?.name ?? l.from} → {l.want.map((w) => categoryById(w)?.name ?? w).join(", ")}</div>
            </div></div>
            <p>{l.detail}</p>
            <p style={{ fontSize: 12.5 }}><b>Give</b> {l.give}<br /><b>Get</b> {l.get}<br />
              <span className="faint">규모 {l.size} · {l.posted}</span></p>
            <div className="frm-note">이런 제안이 올라오는 곳이에요 — 예시 카드라 신청은 받지 않습니다.</div>
          </div>
        ))}
      </div>
      <p className="sub faint" style={{ fontSize: 12.5, marginTop: 14 }}>
        🕶️ 보드는 반익명입니다 — 상대의 정확한 이름·연락처는 양측이 동의한 소개 단계에서만 공유됩니다.
      </p>
    </div>
  );
}

/* ─────────────── 3단계: 플랫폼 거래소 ─────────────── */

/* 매각 접수 폼 → deal_submissions(비공개, 검수·익명화 후 코드명 게시) */
function SellForm({ onDone }: { onDone: () => void }) {
  const [cat, setCat] = useState("");
  const [region, setRegion] = useState<"domestic" | "overseas">("domestic");
  const [band, setBand] = useState(REVENUE_BANDS[1]);
  const [mode, setMode] = useState(DEAL_MODES[0]);
  const [summary, setSummary] = useState("");
  const [highlights, setHighlights] = useState("");
  const [reason, setReason] = useState("");
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(""); setBusy(true);
    try {
      await createDealSubmission({
        category_id: cat, region, revenue_band: band, mode,
        summary: summary.trim(), highlights: highlights.trim(), sale_reason: reason.trim(), ack,
      });
      onDone();
    } catch (ex) { setErr(ex instanceof Error ? ex.message : String(ex)); }
    finally { setBusy(false); }
  };
  return (
    <form className="frm auth-card" style={{ maxWidth: 620 }} onSubmit={submit}>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <label style={{ flex: 1, minWidth: 180 }}>분야 *
          <select required value={cat} onChange={(e) => setCat(e.target.value)}><option value="" disabled>선택</option><CategoryOptions /></select>
        </label>
        <label style={{ minWidth: 120 }}>지역
          <select value={region} onChange={(e) => setRegion(e.target.value as "domestic" | "overseas")}>
            <option value="domestic">국내</option><option value="overseas">해외</option>
          </select>
        </label>
      </div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <label style={{ flex: 1, minWidth: 180 }}>연매출 밴드 *
          <select value={band} onChange={(e) => setBand(e.target.value)}>{REVENUE_BANDS.map((b) => <option key={b} value={b}>{b}</option>)}</select>
        </label>
        <label style={{ flex: 1, minWidth: 180 }}>희망 형태 *
          <select value={mode} onChange={(e) => setMode(e.target.value)}>{DEAL_MODES.map((m) => <option key={m} value={m}>{m}</option>)}</select>
        </label>
      </div>
      <label>익명 요약 * <span style={{ fontWeight: 400, color: "var(--faint)" }}>(플랫폼명·URL 유추 표현 금지 — 검수에서 재작성될 수 있음)</span>
        <textarea required rows={3} value={summary} onChange={(e) => setSummary(e.target.value)} maxLength={300}
          placeholder="예: 운영 6년차 수공예 버티컬. 작가 풀과 재방문 회원층 보유." />
      </label>
      <label>하이라이트 <span style={{ fontWeight: 400, color: "var(--faint)" }}>(범주·밴드 표현만, 쉼표 구분)</span>
        <input value={highlights} onChange={(e) => setHighlights(e.target.value)} maxLength={150} placeholder="예: 작가 풀 보유, 재방문율 상위" />
      </label>
      <label>매각 사유(선택)
        <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={100} placeholder="예: 운영자 이직 — 신뢰 재료가 됩니다" />
      </label>
      <div className="frm-note">⚠️ 연락처·정확한 수치·희망 가격은 적지 마세요. 게시는 검수·익명화 후 코드명(D-1xx)으로만 됩니다.</div>
      <label className="facet-opt" style={{ fontSize: 13 }}>
        <input type="checkbox" required checked={ack} onChange={() => setAck((v) => !v)} />
        세모플은 <b>정보 게시와 소개만</b> 하며 중개·자문·가치평가를 하지 않음을 확인했습니다. *
      </label>
      {err && <div className="err">{err}</div>}
      <button className="btn primary" disabled={busy} type="submit">{busy ? "접수 중…" : "매각 접수(비공개)"}</button>
    </form>
  );
}

/* 인수 희망 브리프 폼 → buyer_briefs */
function BriefForm({ onDone }: { onDone: () => void }) {
  const [cat, setCat] = useState("");
  const [budget, setBudget] = useState(BUDGET_BANDS[1]);
  const [mode, setMode] = useState(DEAL_MODES[0]);
  const [entity, setEntity] = useState("개인");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(""); setBusy(true);
    try {
      await createBuyerBrief({ categories: cat ? [cat] : [], budget_band: budget, mode, entity, note: note.trim() });
      onDone();
    } catch (ex) { setErr(ex instanceof Error ? ex.message : String(ex)); }
    finally { setBusy(false); }
  };
  return (
    <form className="frm auth-card" style={{ maxWidth: 620 }} onSubmit={submit}>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <label style={{ flex: 1, minWidth: 180 }}>관심 분야
          <select value={cat} onChange={(e) => setCat(e.target.value)}><option value="">전체(무관)</option><CategoryOptions /></select>
        </label>
        <label style={{ minWidth: 130 }}>예산 밴드
          <select value={budget} onChange={(e) => setBudget(e.target.value)}>{BUDGET_BANDS.map((b) => <option key={b} value={b}>{b}</option>)}</select>
        </label>
      </div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <label style={{ flex: 1, minWidth: 180 }}>희망 형태
          <select value={mode} onChange={(e) => setMode(e.target.value)}>{DEAL_MODES.map((m) => <option key={m} value={m}>{m}</option>)}</select>
        </label>
        <label style={{ minWidth: 130 }}>주체
          <select value={entity} onChange={(e) => setEntity(e.target.value)}><option>개인</option><option>법인</option></select>
        </label>
      </div>
      <label>간단한 소개 <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder="어떤 인수·투자를 찾는지 (연락처 금지)" /></label>
      {err && <div className="err">{err}</div>}
      <button className="btn primary" disabled={busy} type="submit">{busy ? "등록 중…" : "브리프 등록"}</button>
      <div className="frm-note">조건에 맞는 신규 매물이 등록되면 우선 안내드립니다.</div>
    </form>
  );
}

/* 인수 관심 폼(매물별 인라인) */
function InterestForm({ dealId, onDone }: { dealId: string; onDone: () => void }) {
  const [intro, setIntro] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(""); setBusy(true);
    try { await registerDealInterest(dealId, intro.trim()); onDone(); }
    catch (ex) { setErr(ex instanceof Error ? ex.message : String(ex)); }
    finally { setBusy(false); }
  };
  return (
    <form className="frm" style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--line-soft)" }} onSubmit={submit}>
      <label>간단한 소개 * <textarea required rows={2} value={intro} onChange={(e) => setIntro(e.target.value)} maxLength={200}
        placeholder="인수 주체(개인/법인)와 관심 이유 (연락처 금지)" /></label>
      <label className="facet-opt" style={{ fontSize: 12.5 }}>
        <input type="checkbox" required />
        매칭 확인 시 상대에게 <b>내 계정 이메일이 공유</b>되는 데 동의합니다. *
      </label>
      {err && <div className="err">{err}</div>}
      <button className="btn primary sm" disabled={busy} type="submit">{busy ? "등록 중…" : "관심 등록"}</button>
    </form>
  );
}

export function Exchange() {
  const { session } = useSession();
  const go = useNav();
  const [deals, setDeals] = useState<PublicDeal[] | null>(null);
  const [form, setForm] = useState<"" | "sell" | "brief">("");
  const [done, setDone] = useState<"" | "sell" | "brief">("");
  const [interestIn, setInterestIn] = useState<string | null>(null);
  const [interested, setInterested] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!remoteEnabled) { setDeals(null); return; }
    fetchDeals().then(setDeals).catch(() => setDeals(null));
  }, []);

  // 원격 실패/미연결 시 정적 데모로 폴백
  const shown: { id: string; category: string; region: string; revenue: string; mode: string; summary: string; status: string; demo: boolean; posted: string; highlights?: string[]; sale_reason?: string | null }[] =
    deals !== null
      ? deals.map((d) => ({ id: d.id, category: d.category_id, region: d.region === "overseas" ? "해외" : "국내", revenue: d.revenue_band, mode: d.mode, summary: d.summary, status: d.status, demo: d.is_demo, posted: d.posted, highlights: d.highlights, sale_reason: d.sale_reason }))
      : listings.deals.map((d) => ({ ...d, demo: Boolean(d.demo) }));

  return (
    <div className="page container">
      <h1>🏦 플랫폼 거래소 <Badge kind="good">오픈 · 무료 베타</Badge></h1>
      <p className="lead">
        운영하던 플랫폼을 매각·엑시트하려는 분과 인수·투자하려는 분을 <b>익명 리스팅</b>으로 연결합니다.
        세모플은 게시·연결만 하며 중개·자문·실사·가치평가를 하지 않습니다 — 계약은 당사자와 전문 자문사(로펌·회계법인)가 직접.
      </p>

      <ProcessStrip steps={[
        { t: "익명 등록", d: "검수 후 코드명(D-101)으로만 게시 — 실명·연락처 없음" },
        { t: "관심 수집", d: "인수 희망자의 관심 등록 + 브리프 매칭 알림" },
        { t: "양측 확인 후 소개", d: "쌍방 동의 시에만 소개(NDA 양식 안내)" },
        { t: "당사자 직접 협상", d: "가격·실사·계약·정산은 당사자와 자문사가 직접" },
      ]} />

      {/* 왜 중개하지 않는가 (stage3-exchange-plan.md §1) */}
      <div className="sec-title">세모플이 "중개"하지 않는 이유</div>
      <div className="card-grid" style={{ marginBottom: 12 }}>
        <div className="pcard"><h4>⚖️ 법이 그렇게 정합니다</h4>
          <p>플랫폼 매각은 대부분 <b>주식(지분) 양수도</b> — 자본시장법상 증권 거래입니다. 인가 없이 이를
            중개·주선하면 <b>무인가 투자중개업(형사처벌 대상)</b>이 될 수 있어, 세모플은 정보 게시와
            쌍방 동의 소개까지만 합니다.</p></div>
        <div className="pcard"><h4>💰 그래서 수수료도 정액뿐</h4>
          <p>거래액에 연동한 성공보수는 "사실상 중개 보수"로 해석될 수 있습니다. 세모플은
            <b>거래 성사·금액과 무관한 정액 이용료</b>(리스팅·열람)만 받고, 가격 협상에 일절 개입하지 않습니다.</p></div>
        <div className="pcard"><h4>🛡️ 그게 거래자에게도 안전합니다</h4>
          <p>가치평가·실사·계약은 자격 있는 전문가(로펌·회계법인)의 영역입니다. 세모플이 어설프게 개입하지 않는
            구조라서, 책임 소재가 명확하고 거래가 깨끗해집니다.</p></div>
      </div>

      {/* 거래 형태 가이드 */}
      <div className="sec-title">거래 형태 가이드 <span style={{ textTransform: "none", letterSpacing: 0 }}>(일반 정보 — 법률·세무 자문 아님)</span></div>
      <div className="card-grid" style={{ marginBottom: 12 }}>
        <div className="pcard"><h4>지분(주식) 양수도</h4>
          <p>회사를 통째로 넘기는 방식 — 계약·자산·부채·직원이 함께 이전됩니다. 절차가 단순한 대신
            <b>숨은 부채까지 인수</b>하므로 실사가 중요합니다.</p></div>
        <div className="pcard"><h4>자산(사업) 양수도</h4>
          <p>도메인·코드·상표·계약 등 <b>자산을 골라 인수</b>하는 방식. 부채 리스크가 작은 대신 이전 절차가 건별로
            필요하고, <b>회원 DB 이전은 개인정보보호법 §27(영업양도 통지)</b> 절차를 반드시 거쳐야 합니다.</p></div>
      </div>

      <div className="banner" style={{ marginBottom: 12 }}>
        🕶️ <b>익명성 규칙</b> — 게시 전 검수에서 전부 확인합니다:
        플랫폼명·URL 유추 표현 금지 · 정확한 수치 대신 밴드(연매출 1~5억) · 지역은 광역 단위 ·
        <b>희망 가격은 게시하지 않음</b>(소개 후 당사자 협상) · 연락처·개인정보 금지.
      </div>

      <div className="banner" style={{ marginBottom: 18 }}>
        📋 <b>매각 준비 체크리스트</b> — 소개가 빨라집니다:
        ① 최근 12개월 매출·비용 증빙 ② 회원·트래픽 지표(MAU·재방문) ③ 이전 가능한 자산 목록(도메인·코드·계약·회원DB 이전 시 개인정보보호법 검토) ④ 매각 사유와 희망 형태.
      </div>

      {/* ── 등록(매각 접수 · 인수 브리프) ── */}
      <div className="sec-title">등록</div>
      {!remoteEnabled ? (
        <div className="banner">백엔드 미연결 빌드 — <a href={ISSUE("[거래소 등록]", "구분(매각/인수):\n분야:\n밴드:", "stage3")} target="_blank" rel="noopener noreferrer">GitHub 이슈로 등록</a></div>
      ) : done ? (
        <div className="empty" style={{ borderColor: "var(--success)", padding: 24 }}>
          {done === "sell"
            ? "접수됐어요 ✓ 검수·익명화 후 코드명(D-1xx)으로 게시됩니다. 진행 상태는 계정 이메일로 안내드려요."
            : "브리프 등록 완료 ✓ 조건에 맞는 신규 매물이 올라오면 우선 안내드립니다."}
          {FLAGS.contactEmail && <div className="frm-note" style={{ marginTop: 6 }}>문의: <a href={`mailto:${FLAGS.contactEmail}`}>{FLAGS.contactEmail}</a></div>}
          <div style={{ marginTop: 10 }}><button className="btn ghost sm" onClick={() => { setDone(""); setForm(""); }}>확인</button></div>
        </div>
      ) : !session ? (
        <LoginGate what="매각 접수·브리프 등록"><span /></LoginGate>
      ) : form === "sell" ? (
        <SellForm onDone={() => setDone("sell")} />
      ) : form === "brief" ? (
        <BriefForm onDone={() => setDone("brief")} />
      ) : (
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button className="btn primary" onClick={() => setForm("sell")}>매각 접수(비공개) →</button>
          <button className="btn ghost" onClick={() => setForm("brief")}>인수 희망 브리프 등록 →</button>
        </div>
      )}

      {/* 요금 안내 (stage3-exchange-plan.md §3) */}
      <div className="sec-title">요금 안내</div>
      <div className="card-grid" style={{ marginBottom: 6 }}>
        <div className="pcard"><h4>무료 <Badge kind="good">현재</Badge></h4>
          <p>매물 등록(검수·익명화 포함)·인수 브리프·소개까지 전 과정 무료(베타).</p></div>
        <div className="pcard"><h4>매물 리스팅료 <Badge kind="soon">예정</Badge></h4>
          <p>게재 90일 정액(검수·익명화 포함). <b>성사·거래액과 무관</b> — 팔리든 안 팔리든 같은 금액.</p></div>
        <div className="pcard"><h4>인수자 멤버십 <Badge kind="soon">예정</Badge></h4>
          <p>신규 매물 우선 알림·브리프 무제한(월 정액).</p></div>
      </div>
      <p className="sub faint" style={{ fontSize: 12.5, marginBottom: 18 }}>
        금지 원칙 — 성공보수(%)·성사 연동 과금·가격 협상 개입 대가는 받지 않습니다(위 "중개하지 않는 이유" 참조).
      </p>

      {/* ── 매물 보드 ── */}
      <div className="sec-title">매물 보드</div>
      <div className="result-meta">매물 {shown.length}건 (익명 리스팅{shown.every((d) => d.demo) ? " — 아직 데모 예시" : ""})</div>
      <div className="card-grid">
        {shown.map((d) => (
          <div className="pcard" key={d.id}>
            <div className="top"><div><h4>{d.id} {d.demo && <Badge kind="muted">데모</Badge>}
              {d.status === "open" ? <Badge kind="good">모집 중</Badge> : <Badge kind="soon">{d.status === "in_progress" ? "진행 중" : d.status}</Badge>}</h4>
              <div className="cat">{categoryById(d.category)?.name ?? d.category}</div></div></div>
            <p>{d.summary}</p>
            {d.highlights && d.highlights.length > 0 && (
              <div className="chips-row" style={{ margin: "4px 0" }}>{d.highlights.map((h, i) => <span key={i} className="fchip">{h}</span>)}</div>
            )}
            <p style={{ fontSize: 12.5 }} className="faint">{d.region} · {d.revenue} · {d.mode} · {d.posted}
              {d.sale_reason ? ` · 사유: ${d.sale_reason}` : ""}</p>
            {d.status === "open" && !d.demo && (
              interested.has(d.id) ? <div className="ok" style={{ fontSize: 13 }}>관심 등록 완료 ✓ 세모플이 확인 후 안내드립니다</div>
              : interestIn === d.id ? (
                !session
                  ? <div className="frm-note">관심 등록에는 로그인이 필요해요. <button className="linklike" onClick={() => go("account")}>로그인 →</button></div>
                  : <InterestForm dealId={d.id} onDone={() => { setInterested((s) => new Set(s).add(d.id)); setInterestIn(null); }} />
              ) : (
                <div className="pcard-actions">
                  <button className="btn primary sm" style={{ marginLeft: "auto" }} onClick={() => setInterestIn(d.id)}>이 매물에 관심 등록 →</button>
                </div>
              )
            )}
            {d.status === "open" && d.demo && <div className="frm-note">예시 카드입니다 — 실제 매물이 올라오면 여기서 관심 등록할 수 있어요.</div>}
          </div>
        ))}
      </div>
      <p className="sub faint" style={{ fontSize: 12.5, marginTop: 14 }}>
        🕶️ 매물은 코드명으로만 게시됩니다. 소개(연락 연결)는 쌍방 동의 후 세모플이 비공개로 진행하며, 그 이후의 협상·실사·계약에는 관여하지 않습니다.
      </p>
    </div>
  );
}
