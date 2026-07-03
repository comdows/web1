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
    "구분: 매각 희망\n분야:\n지역(광역 단위):\n연매출 밴드(예: 1~5억):\n희망 형태(지분 전량/지분 일부+운영승계/자산 양수도):\n익명 요약(1~2줄 — 플랫폼명·URL 유추 표현 금지):\n하이라이트(범주·밴드 표현만, 예: 재방문율 상위):\n매각 사유(선택):", "stage3,사전등록,매각");
  const buyReg = ISSUE("[인수 희망 브리프 등록]",
    "구분: 인수·투자 희망\n관심 분야(복수 가능):\n예산 밴드(예: ~1억 / 1~5억):\n희망 형태(지분/자산 등):\n인수 주체(개인/법인):\n간단한 소개:", "stage3,인수브리프");

  return (
    <div className="page container">
      <h1>🏦 플랫폼 거래소</h1>
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

      {!boardOn ? (
        <div className="banner" style={{ padding: 22 }}>
          <h2 style={{ margin: "0 0 8px" }}>🚧 매물 보드 — 오픈 준비 중</h2>
          <p className="muted" style={{ margin: "0 0 14px" }}>
            매물·인수 수요가 모이면 보드를 엽니다. 사전등록 시 오픈 알림과 첫 매물 리스트를 먼저 받습니다.
          </p>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <a className="btn primary" target="_blank" rel="noopener noreferrer" href={sellReg}>매각 사전등록</a>
            <a className="btn ghost" target="_blank" rel="noopener noreferrer" href={buyReg}>인수 희망 브리프 등록</a>
          </div>
        </div>
      ) : (
        <>
          {isLocalAdmin() && !FLAGS.stage3 && <AdminBanner label="이 매물 보드" />}
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 10 }}>
            <div className="result-meta" style={{ margin: 0 }}>매물 {listings.deals.length}건 (익명 리스팅)</div>
            <a className="btn primary sm" style={{ marginLeft: "auto" }} target="_blank" rel="noopener noreferrer" href={sellReg}>+ 매물 등록</a>
            <a className="btn ghost sm" target="_blank" rel="noopener noreferrer" href={buyReg}>인수 희망 브리프 등록</a>
          </div>
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
