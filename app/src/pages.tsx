import { listings, categoryById } from "./data";
import { Badge } from "./components";
import { FLAGS, isLocalAdmin } from "./config";

const ISSUE = (title: string, body: string, labels?: string) =>
  `https://github.com/comdows/web1/issues/new?title=${encodeURIComponent(title)}` +
  `&body=${encodeURIComponent(body + "\n\n(연락처는 적지 마세요 — 운영자가 이슈 댓글로 다음 절차를 안내합니다)")}` +
  (labels ? `&labels=${encodeURIComponent(labels)}` : "");

function Teaser({ title, desc, reg }: { title: string; desc: string; reg: string }) {
  return (
    <div className="banner" style={{ padding: 22 }}>
      <h2 style={{ margin: "0 0 8px" }}>🚧 {title} — 준비 중</h2>
      <p className="muted" style={{ margin: "0 0 14px" }}>{desc}</p>
      <a className="btn primary" target="_blank" rel="noopener noreferrer" href={reg}>✋ 사전등록하기</a>
    </div>
  );
}

function AdminBanner({ label }: { label: string }) {
  return (
    <div className="banner admin" style={{ marginBottom: 16 }}>
      🔒 <b>관리자 로컬 열람 모드</b> — {label}은(는) <b>내 PC(localhost)에서만</b> 보입니다.
      공개 사이트 방문자에게는 "준비 중"만 노출됩니다.
    </div>
  );
}

export function Partners() {
  const on = FLAGS.stage2 || isLocalAdmin();
  const reg = ISSUE("[제휴 사전등록]", "플랫폼 이름:\n분야:\n제휴 유형:\n원하는 상대 분야:\n제공할 것(Give):\n원하는 것(Get):\n규모:", "stage2,사전등록");
  if (!on) return (
    <div className="page container">
      <h1>🤝 제휴 매칭</h1>
      <p className="lead">플랫폼끼리 회원을 상호 송출하고, 교차 프로모션·공동 이벤트를 함께합니다. 자금은 각 플랫폼이 직접 정산하며, 세모플은 연결·소개만 합니다.</p>
      <Teaser title="제휴 매칭" desc="제휴 수요가 일정 수 모이면 오픈합니다. 사전등록 시 오픈 알림과 첫 매칭 후보를 먼저 받습니다." reg={reg} />
    </div>
  );
  return (
    <div className="page container">
      <h1>🤝 제휴 매칭</h1>
      <p className="lead">상호송출·교차프로모션·공동이벤트를 잇습니다. 자금 미보유 원칙 — 정산은 당사자 직접.</p>
      {isLocalAdmin() && !FLAGS.stage2 && <AdminBanner label="이 매칭 보드" />}
      <div className="result-meta">제휴 제안 {listings.partnerships.length}건</div>
      <div className="card-grid">
        {listings.partnerships.map((l) => (
          <div className="pcard" key={l.id}>
            <div className="top">
              <div style={{ minWidth: 0 }}>
                <h4>{l.title} {l.verified && <Badge kind="verify">검증</Badge>}
                  {l.status === "matched" && <Badge kind="good">성사</Badge>}
                  {l.demo && <Badge kind="muted">데모</Badge>}</h4>
                <div className="cat">{l.type} · {categoryById(l.from)?.name ?? l.from} → {l.want.map((w) => categoryById(w)?.name ?? w).join(", ")}</div>
              </div>
            </div>
            <p>{l.detail}</p>
            <p style={{ fontSize: 12.5 }}><b>Give</b> {l.give}<br /><b>Get</b> {l.get}<br /><span className="faint">규모 {l.size} · {l.posted}</span></p>
          </div>
        ))}
      </div>
    </div>
  );
}

export function Exchange() {
  const on = FLAGS.stage3 || isLocalAdmin();
  const reg = ISSUE("[거래소 사전등록]", "구분(매각/인수·투자):\n분야:\n규모(연매출 밴드):", "stage3,사전등록");
  if (!on) return (
    <div className="page container">
      <h1>🏦 플랫폼 거래소</h1>
      <p className="lead">운영하던 플랫폼을 매각·엑시트하려는 분과 인수·투자하려는 분을 익명 리스팅으로 연결합니다. 중개·자문·실사·가치평가는 하지 않으며 계약은 당사자·전문 자문사가 직접 진행합니다.</p>
      <Teaser title="플랫폼 거래소" desc="매물·인수 수요가 모이면 오픈합니다. 사전등록 시 오픈 알림과 첫 매물 리스트를 먼저 받습니다." reg={reg} />
    </div>
  );
  return (
    <div className="page container">
      <h1>🏦 플랫폼 거래소</h1>
      <p className="lead">익명 리스팅으로 연결만 제공합니다. 중개·자문·실사·가치평가 아님.</p>
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
          </div>
        ))}
      </div>
    </div>
  );
}
