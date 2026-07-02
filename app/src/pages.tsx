import { useMemo, useState } from "react";
import { listings, categoryById, partnerGoals, partnerGroups, partnerTypes } from "./data";
import type { PartnerType } from "./data";
import { Badge } from "./components";
import { FLAGS, isLocalAdmin } from "./config";

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

function AdminBanner({ label }: { label: string }) {
  return (
    <div className="banner admin" style={{ marginBottom: 16 }}>
      🔒 <b>관리자 로컬 열람 모드</b> — {label}은(는) <b>내 PC(localhost)에서만</b> 보입니다.
      공개 사이트 방문자에게는 "준비 중"만 노출됩니다.
    </div>
  );
}

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

/* ─────────────── 2단계: 제휴 매칭 ─────────────── */
export function Partners() {
  const boardOn = FLAGS.stage2 || isLocalAdmin();
  const [goal, setGoal] = useState("");
  const [openType, setOpenType] = useState<string | null>(null);

  const visibleTypes = useMemo(
    () => (goal ? partnerTypes.filter((t) => t.goals.includes(goal)) : partnerTypes),
    [goal]
  );

  const proposeUrl = (t: PartnerType) =>
    ISSUE(`[제휴 제안] ${t.label}`,
      `제휴 방식: ${t.label}\n플랫폼 이름:\n분야:\n상대에게 제공할 것(Give):\n상대에게 원하는 것(Get):\n원하는 상대 분야:\n규모(대략):`,
      "stage2,제휴제안");
  const preRegUrl = ISSUE("[제휴 사전등록]",
    "플랫폼 이름:\n분야:\n관심 있는 제휴 방식(카탈로그 참고):\n원하는 상대 분야:\n규모(대략):", "stage2,사전등록");

  // 기존 데모 리스팅 라벨 → 카탈로그 방식 매핑
  const legacyMap: Record<string, string> = {
    "회원 상호송출": "cross_signup", "교차 프로모션": "coupon_exchange",
    "공동 이벤트": "joint_event", "광고 지면 교환": "banner_swap", "공동구매·번들": "bundle",
  };
  const [boardType, setBoardType] = useState("");
  const boardItems = listings.partnerships.filter(
    (l) => !boardType || legacyMap[l.type] === boardType
  );

  return (
    <div className="page container">
      <h1>🤝 제휴 매칭</h1>
      <p className="lead">
        플랫폼끼리 배너를 맞바꾸고, 회원을 서로 보내고, 레퍼럴 수수료로 함께 크는 곳.
        세모플은 <b>연결·소개만</b> 하고 정산·계약은 두 플랫폼이 직접 합니다(자금 미보유 원칙).
      </p>

      <ProcessStrip steps={[
        { t: "제휴 방식 고르기", d: "아래 카탈로그에서 우리에게 맞는 방식을 찾습니다" },
        { t: "제안 등록", d: "Give/Get·규모를 적어 제안을 올립니다" },
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
                      <a className="cmp-btn" style={{ marginLeft: "auto" }} target="_blank" rel="noopener noreferrer"
                        href={proposeUrl(t)}>이 방식으로 제안 →</a>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}

      {/* ── 매칭 보드 ── */}
      <div className="sec-title">제휴 매칭 보드</div>
      {!boardOn ? (
        <div className="banner" style={{ padding: 22 }}>
          <h2 style={{ margin: "0 0 8px" }}>🚧 매칭 보드 — 오픈 준비 중</h2>
          <p className="muted" style={{ margin: "0 0 14px" }}>
            제휴 수요가 일정 수 모이면 보드를 엽니다. 지금 사전등록하면 오픈 알림과 첫 매칭 후보를 먼저 받습니다.
            (위 카탈로그의 방식 이름을 적어주시면 매칭이 빨라집니다)
          </p>
          <a className="btn primary" target="_blank" rel="noopener noreferrer" href={preRegUrl}>✋ 사전등록하기</a>
        </div>
      ) : (
        <>
          {isLocalAdmin() && !FLAGS.stage2 && <AdminBanner label="이 매칭 보드" />}
          <div className="chips-row">
            <button className={`fchip ${boardType === "" ? "on" : ""}`} onClick={() => setBoardType("")}>전체</button>
            {Object.entries(legacyMap).map(([label, id]) => (
              <button key={id} className={`fchip ${boardType === id ? "on" : ""}`}
                onClick={() => setBoardType(boardType === id ? "" : id)}>{label}</button>
            ))}
          </div>
          <div className="result-meta">제휴 제안 {boardItems.length}건</div>
          <div className="card-grid">
            {boardItems.map((l) => (
              <div className="pcard" key={l.id}>
                <div className="top"><div style={{ minWidth: 0 }}>
                  <h4>{l.title} {l.verified && <Badge kind="verify">검증</Badge>}
                    {l.status === "matched" && <Badge kind="good">성사</Badge>}
                    {l.demo && <Badge kind="muted">데모</Badge>}</h4>
                  <div className="cat">{l.type} · {categoryById(l.from)?.name ?? l.from} → {l.want.map((w) => categoryById(w)?.name ?? w).join(", ")}</div>
                </div></div>
                <p>{l.detail}</p>
                <p style={{ fontSize: 12.5 }}><b>Give</b> {l.give}<br /><b>Get</b> {l.get}<br />
                  <span className="faint">규모 {l.size} · {l.posted}</span></p>
                {l.status === "open" && (
                  <div className="pcard-actions">
                    <a className="cmp-btn" target="_blank" rel="noopener noreferrer"
                      href={ISSUE(`[매칭 신청] ${l.id}`, `신청 대상: ${l.id} ${l.title}\n우리 플랫폼 이름:\n분야:\n규모(대략):\n제안 요지(무엇을 주고받을지):`, "stage2,매칭신청")}>
                      이 제안에 매칭 신청 →</a>
                  </div>
                )}
              </div>
            ))}
          </div>
          <p className="sub faint" style={{ fontSize: 12.5, marginTop: 14 }}>
            ⚠️ GitHub 이슈는 공개 게시판입니다. 이슈에 연락처·개인정보를 적지 마세요 — 접수 후 운영자가 비공개 절차를 안내합니다.
          </p>
        </>
      )}
    </div>
  );
}

/* ─────────────── 3단계: 플랫폼 거래소 ─────────────── */
export function Exchange() {
  const boardOn = FLAGS.stage3 || isLocalAdmin();
  const sellReg = ISSUE("[거래소 사전등록 — 매각]",
    "구분: 매각 희망\n분야:\n규모(연매출 밴드):\n희망 형태(지분매각/자산양수도 등):\n익명 요약(1~2줄):", "stage3,사전등록");
  const buyReg = ISSUE("[거래소 사전등록 — 인수·투자]",
    "구분: 인수·투자 희망\n관심 분야:\n예산 규모(대략):\n인수 주체(개인/법인):", "stage3,사전등록");

  return (
    <div className="page container">
      <h1>🏦 플랫폼 거래소</h1>
      <p className="lead">
        운영하던 플랫폼을 매각·엑시트하려는 분과 인수·투자하려는 분을 <b>익명 리스팅</b>으로 연결합니다.
        세모플은 게시·연결만 하며 중개·자문·실사·가치평가를 하지 않습니다 — 계약은 당사자와 전문 자문사(로펌·회계법인)가 직접.
      </p>

      <ProcessStrip steps={[
        { t: "익명 등록", d: "매물은 코드명(D-101)으로만 게시 — 실명·연락처 없음" },
        { t: "관심 수집", d: "인수 희망자가 관심을 등록합니다" },
        { t: "양측 확인 후 소개", d: "쌍방 동의 시에만 세모플이 소개" },
        { t: "당사자 직접 협상", d: "실사·계약·정산은 당사자와 자문사가 직접" },
      ]} />

      <div className="banner" style={{ marginBottom: 18 }}>
        📋 <b>매각 준비 체크리스트</b> — 소개가 빨라집니다:
        ① 최근 12개월 매출·비용 증빙 ② 회원·트래픽 지표(MAU·재방문) ③ 이전 가능한 자산 목록(도메인·코드·계약·회원DB 이전 시 개인정보보호법 검토) ④ 매각 사유와 희망 형태.
      </div>

      {!boardOn ? (
        <div className="banner" style={{ padding: 22 }}>
          <h2 style={{ margin: "0 0 8px" }}>🚧 매물 보드 — 오픈 준비 중</h2>
          <p className="muted" style={{ margin: "0 0 14px" }}>
            매물·인수 수요가 모이면 보드를 엽니다. 사전등록 시 오픈 알림과 첫 매물 리스트를 먼저 받습니다.
          </p>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <a className="btn primary" target="_blank" rel="noopener noreferrer" href={sellReg}>매각 사전등록</a>
            <a className="btn ghost" target="_blank" rel="noopener noreferrer" href={buyReg}>인수·투자 사전등록</a>
          </div>
        </div>
      ) : (
        <>
          {isLocalAdmin() && !FLAGS.stage3 && <AdminBanner label="이 매물 보드" />}
          <div className="result-meta">매물 {listings.deals.length}건 (익명 리스팅)</div>
          <div className="card-grid">
            {listings.deals.map((d) => (
              <div className="pcard" key={d.id}>
                <div className="top"><div><h4>{d.id} {d.demo && <Badge kind="muted">데모</Badge>}
                  {d.status === "open" ? <Badge kind="good">모집 중</Badge> : <Badge kind="soon">{d.status}</Badge>}</h4>
                  <div className="cat">{categoryById(d.category)?.name ?? d.category}</div></div></div>
                <p>{d.summary}</p>
                <p style={{ fontSize: 12.5 }} className="faint">{d.region} · {d.revenue} · {d.mode} · {d.posted}</p>
                {d.status === "open" && (
                  <div className="pcard-actions">
                    <a className="cmp-btn" target="_blank" rel="noopener noreferrer"
                      href={ISSUE(`[인수 관심] ${d.id}`, `관심 매물: ${d.id}\n인수 주체(개인/법인):\n간단한 소개:`, "stage3,인수관심")}>
                      이 매물에 관심 등록 →</a>
                  </div>
                )}
              </div>
            ))}
          </div>
          <p className="sub faint" style={{ fontSize: 12.5, marginTop: 14 }}>
            ⚠️ GitHub 이슈는 공개 게시판입니다. 이슈에 연락처·개인정보를 적지 마세요 — 접수 후 운영자가 비공개 절차를 안내합니다.
          </p>
        </>
      )}
    </div>
  );
}
