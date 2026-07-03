/* 성장 화면 — ① 주간 새로 나온 것(?view=weekly): 자동 수집→검수→등재된 신규를 주 단위 아카이브로
 *            ② 업종별 스타터 팩(?view=packs): "이 일을 시작하면 이 조합" 레시피(공유·SEO 콘텐츠) */
import { useEffect, useMemo, useState } from "react";
import { platforms as staticPlatforms } from "./data";
import type { Platform } from "./data";
import { Badge, PlatformCard, ShareButton } from "./components";
import { useNav } from "./nav";
import { fetchRecentPlatforms, remoteEnabled } from "./lib/api";
import { usePlatformIndex } from "./lib/platforms";

/* ── ① 주간 다이제스트 ─────────────────────────────────────── */
function weekLabel(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "최근 등록";
  return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${Math.ceil(d.getDate() / 7)}주차`;
}

export function Weekly() {
  const go = useNav();
  const [rows, setRows] = useState<{ p: Platform; created: string }[] | null>(null);
  useEffect(() => {
    fetchRecentPlatforms(60).then(setRows).catch(() => setRows(staticPlatforms.filter((x) => x.new).slice(0, 60).map((p) => ({ p, created: "" }))));
  }, []);
  const groups = useMemo(() => {
    const m = new Map<string, Platform[]>();
    for (const r of rows ?? []) {
      const k = r.created ? weekLabel(r.created) : "최근 등록";
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(r.p);
    }
    return [...m.entries()];
  }, [rows]);
  return (
    <main className="page container">
      <h1>🗞️ 새로 나온 플랫폼·AI <Badge kind="new">매주 갱신</Badge> <ShareButton title="새로 나온 플랫폼·AI — 세모플" /></h1>
      <p className="lead" style={{ maxWidth: 640 }}>
        매주 전 세계 신규 플랫폼·AI 도구를 수집해 검수를 거쳐 등재합니다. 이 페이지만 가끔 들러도
        "요즘 뭐가 나왔는지"를 놓치지 않아요. 빠진 게 있으면 <button className="linklike" onClick={() => go("submit")}>제보</button>해 주세요.
      </p>
      {rows === null ? <div className="empty">불러오는 중…</div>
        : groups.length === 0 ? <div className="empty">아직 신규 등재가 없어요.</div>
        : groups.map(([label, list]) => (
          <div key={label} style={{ marginBottom: 22 }}>
            <div className="sec-title">{label} <span style={{ textTransform: "none", letterSpacing: 0 }}>· {list.length}개</span></div>
            <div className="card-grid">{list.map((p) => <PlatformCard key={p.id} p={p} />)}</div>
          </div>
        ))}
      {!remoteEnabled && <div className="frm-note">백엔드 미연결 빌드 — 정적 데이터의 신규 항목을 표시 중입니다.</div>}
    </main>
  );
}

/* ── ② 업종별 스타터 팩 ────────────────────────────────────── */
interface Pack {
  id: string; icon: string; title: string; desc: string;
  steps: { role: string; ids: string[]; why: string }[];
}
const PACKS: Pack[] = [
  {
    id: "handmade", icon: "🎁", title: "핸드메이드 작가로 시작",
    desc: "수공예·디자인 굿즈를 만들어 파는 1인 작가의 기본 조합.",
    steps: [
      { role: "판매채널", ids: ["idus", "smartstore", "marpple2"], why: "작가 마켓(아이디어스)로 시작하고, 스마트스토어로 검색 유입을 받고, 마플샵으로 굿즈를 무재고 제작·판매." },
      { role: "자금·홍보", ids: ["tumblbug", "wadiz"], why: "신제품은 펀딩으로 선주문을 받아 재고 리스크를 줄이는 게 정석." },
      { role: "AI 도구", ids: ["canva", "photoroom", "chatgpt"], why: "상품컷 배경 제거(포토룸), 상세페이지 디자인(캔바), 소개글 초안(챗봇)." },
    ],
  },
  {
    id: "shop", icon: "🛒", title: "온라인 쇼핑몰 시작",
    desc: "상품을 정하고 처음 온라인 판매를 여는 사장님의 조합.",
    steps: [
      { role: "판매채널", ids: ["smartstore", "coupang", "cafe242"], why: "입점형(스마트스토어·쿠팡)으로 수요 검증 후, 단골이 생기면 자사몰(카페24)로 마진을 지킨다." },
      { role: "AI 도구", ids: ["photoroom", "channeltalk", "chatgpt"], why: "상품 사진 → 문의 응대 자동화 → 상세페이지 문구 순서로 붙이면 체감이 가장 빠르다." },
    ],
  },
  {
    id: "freelance", icon: "🧑‍💻", title: "프리랜서·전문가로 시작",
    desc: "재능·기술을 파는 1인 전문가의 일감 확보 조합.",
    steps: [
      { role: "일감 채널", ids: ["kmong", "soomgo", "wishket"], why: "재능마켓(크몽)·견적 매칭(숨고)·IT 외주(위시켓)를 병행해 초기 레퍼런스를 쌓는다." },
      { role: "AI 도구", ids: ["chatgpt", "notion-ai", "gamma-app"], why: "제안서 초안, 포트폴리오 문서, 발표자료를 AI로 빠르게." },
    ],
  },
  {
    id: "creator", icon: "🎨", title: "콘텐츠 크리에이터로 시작",
    desc: "지식·창작 콘텐츠로 수익을 만드는 조합.",
    steps: [
      { role: "수익화 채널", ids: ["youtube", "class101", "postype", "brunch"], why: "영상(유튜브)·강의(클래스101)·연재(포스타입·브런치)로 콘텐츠 자산을 여러 형태로 판다." },
      { role: "AI 도구", ids: ["capcut", "vrew", "suno", "chatgpt"], why: "편집·자막은 AI로 줄이고, 기획과 얼굴에 시간을 쓴다." },
    ],
  },
  {
    id: "food", icon: "🥬", title: "식품·먹거리 판매 시작",
    desc: "농수산물·가공식품을 온라인으로 파는 조합.",
    steps: [
      { role: "판매채널", ids: ["kurly", "smartstore", "coupang"], why: "프리미엄 신선(컬리 입점)과 검색 수요(스마트스토어·쿠팡)를 함께 잡는다." },
      { role: "AI 도구", ids: ["photoroom", "predis", "chatgpt"], why: "음식 사진 연출, SNS 게시물 자동 생성, 상품 소개 문구." },
    ],
  },
  {
    id: "global", icon: "🚢", title: "해외 판매(수출) 시작",
    desc: "국내 상품을 해외 소비자·바이어에게 파는 조합.",
    steps: [
      { role: "판매채널", ids: ["amazongs", "shopee", "qoo10", "alibaba"], why: "B2C(아마존·쇼피·큐텐)와 B2B(알리바바)를 시장별로 골라 진입." },
      { role: "AI 도구", ids: ["deepl", "chatgpt", "grammarly"], why: "리스팅 번역·바이어 이메일을 AI로 — 언어 장벽이 절반은 사라진다." },
    ],
  },
];

export function Packs() {
  const go = useNav();
  const index = usePlatformIndex();
  const [open, setOpen] = useState<string | null>(() => {
    const q = new URLSearchParams(location.search).get("id");
    return PACKS.some((pk) => pk.id === q) ? q : PACKS[0].id;
  });
  useEffect(() => {
    const p = new URLSearchParams(location.search);
    if (open) p.set("id", open); else p.delete("id");
    history.replaceState(null, "", `?${p}`);
  }, [open]);
  return (
    <main className="page container">
      <h1>🧰 업종별 시작 조합 <Badge kind="good">무료</Badge></h1>
      <p className="lead" style={{ maxWidth: 640 }}>
        "이 일을 시작하면 어디에 붙어야 하지?"의 답을 조합으로 정리했어요. 각 조합은 판매채널 → 부가 채널 →
        AI 도구 순서로, <b>적게 시작해서 검증되면 늘리는</b> 구성입니다. 세모플은 어떤 플랫폼의 대가도 받지 않습니다.
      </p>
      <div className="chips-row" style={{ marginBottom: 16 }}>
        {PACKS.map((pk) => (
          <button key={pk.id} className={`fchip ${open === pk.id ? "on" : ""}`} onClick={() => setOpen(pk.id)}>{pk.icon} {pk.title}</button>
        ))}
      </div>
      {PACKS.filter((pk) => pk.id === open).map((pk) => (
        <div key={pk.id}>
          <div className="sec-title">{pk.icon} {pk.title} <ShareButton title={`${pk.title} — 시작 조합 | 세모플`} /></div>
          <p className="lead" style={{ marginTop: -6, maxWidth: 640 }}>{pk.desc}</p>
          {pk.steps.map((st, i) => {
            const list = st.ids.map((id) => index.get(id)).filter(Boolean) as Platform[];
            if (list.length === 0) return null;
            return (
              <div key={i} style={{ marginBottom: 18 }}>
                <h3 style={{ fontSize: 15, margin: "14px 0 4px" }}>{String(i + 1).padStart(2, "0")} · {st.role}</h3>
                <p className="muted" style={{ fontSize: 13, margin: "0 0 10px" }}>{st.why}</p>
                <div className="card-grid">{list.map((p) => <PlatformCard key={p.id} p={p} />)}</div>
              </div>
            );
          })}
        </div>
      ))}
      <p className="sub faint" style={{ fontSize: 12.5, marginTop: 10 }}>
        각 카드의 조건(수수료·입점)은 공식 사이트 기준으로 확인하세요. 다른 업종 조합이 필요하면{" "}
        <button className="linklike" onClick={() => go("onboarding")}>맞춤 추천</button>도 있어요.
      </p>
    </main>
  );
}
