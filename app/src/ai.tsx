/* AI 도구 찾기 — "내 상황에 필요한 AI가 뭔지 모르겠다"를 푸는 상황 기반 마법사.
 * 목적 → 상황 → 시작 조합(범용 챗봇 1 + 분야 도구) 추천. 원격 미시드 시 정적 데이터로 폴백. */
import { useEffect, useMemo, useState } from "react";
import { platforms as staticPlatforms, categoryById } from "./data";
import type { Platform } from "./data";
import { Badge, PlatformCard, ShareButton } from "./components";
import { useNav } from "./nav";
import { usePlatforms } from "./lib/platforms";

interface Goal { id: string; icon: string; label: string; cats: string[]; tip: string }
const GOALS: Goal[] = [
  { id: "first", icon: "🌱", label: "AI가 처음이에요 — 뭐부터?", cats: ["ai_chat"],
    tip: "범용 챗봇 하나를 골라 2주만 매일 써보세요 — 이메일 다듬기, 요약, 아이디어 정리처럼 매일 하는 일부터 시키는 게 가장 빠른 학습법이에요." },
  { id: "research", icon: "🔍", label: "자료 조사·정리", cats: ["ai_research", "ai_chat"],
    tip: "출처가 달린 답이 필요하면 AI 검색, 내가 가진 자료를 파고들려면 NotebookLM류가 맞아요." },
  { id: "write", icon: "✍️", label: "글·문서·발표자료", cats: ["ai_writing", "ai_chat"],
    tip: "범용 챗봇으로 초안을 만들고, 반복 작성이 많아지면 전용 글쓰기 도구로 넘어가는 순서를 권해요." },
  { id: "image", icon: "🎨", label: "이미지·디자인", cats: ["ai_image"],
    tip: "상세컷·배경 제거는 전용 도구가, 창작 이미지는 생성 AI가 빠릅니다. 상업 사용 라이선스를 꼭 확인하세요." },
  { id: "video", icon: "🎬", label: "영상 만들기", cats: ["ai_video", "ai_audio"],
    tip: "대본(챗봇) → 영상 생성·아바타 → 나레이션(음성 AI) → 자막(편집기) 순서로 조합하면 혼자서도 영상이 나와요." },
  { id: "audio", icon: "🎙️", label: "음성·음악", cats: ["ai_audio"],
    tip: "나레이션은 AI 성우, 배경음악은 음악 생성 AI — 상업 사용 조건은 요금제에 따라 달라요." },
  { id: "meeting", icon: "📝", label: "회의록·기록", cats: ["ai_meeting"],
    tip: "한국어 회의가 많으면 한국어 인식에 강한 국내 도구부터 시도해 보세요." },
  { id: "cs", icon: "📣", label: "고객 응대·마케팅", cats: ["ai_marketing"],
    tip: "문의가 반복된다면 AI 상담봇이 첫 투자처로 좋아요 — 자주 묻는 질문의 70%를 걸러줍니다." },
  { id: "auto", icon: "⚙️", label: "반복 업무 자동화", cats: ["ai_auto"],
    tip: "\"주문 들어오면 시트에 적고 알림\" 같은 흐름을 하나 정해서 자동화 도구로 연결해 보세요." },
  { id: "dev", icon: "💻", label: "개발·서비스 만들기", cats: ["ai_code"],
    tip: "코딩을 모르면 대화형 앱 빌더부터, 개발자라면 AI 에디터·코딩 에이전트가 체감이 커요." },
];

const SITUATIONS = [
  { id: "korean", label: "한국어가 편해요" },
  { id: "solo", label: "혼자 운영해요" },
  { id: "noob", label: "코딩은 몰라요" },
  { id: "biz", label: "쇼핑몰·판매 중" },
] as const;

// blurb만으로는 못 거르는 실무 구분을 큐레이션 — 상황 선택 시 맞는 도구를 앞으로 + 배지 표시.
// (id 기준이라 정적/원격 데이터 모두에서 동작. 새 도구는 아래 집합에 추가.)
const NOCODE = new Set([  // 코딩 없이 쓰는 앱 빌더·자동화(개발자용 에디터·자체호스팅 제외)
  "lovable", "bolt-new", "replit", "v0", "base44",  // ai_code: 대화형 앱 빌더
  "zapier", "make-com", "lindy", "manus", "relevance-ai", // ai_auto: 노코드 자동화(n8n·dify 제외)
  "gumloop", "bardeen", "activepieces", "genspark", "browse-ai",
]);
const COMMERCE = new Set([  // 쇼핑몰·판매에 바로 쓰는 도구(상품사진·상세페이지·고객응대·광고)
  "remove-bg", "photoroom", "canva", "clipdrop",    // 상품 사진·상세페이지
  "channeltalk", "tidio", "intercom", "zendesk-ai", "chatbase", "gorgias", "crisp", // 고객 응대
  "adcreative", "predis", "surfer", "wrtn",         // 광고·마케팅 문구
  "vcat", "creatify", "arcads", "looka", "ms-designer", // 광고 소재·브랜딩
]);

/* 도구가 현재 선택된 상황에 특히 맞으면 배지 라벨을 돌려준다(없으면 null).
 * 여러 상황이 켜지면 먼저 맞는 것 하나를 표시(노코드 > 판매 > 한국어 우선순위). */
function fitLabel(p: Platform, sits: Set<string>): string | null {
  if (sits.has("noob") && (p.category === "ai_code" || p.category === "ai_auto") && NOCODE.has(p.id)) return "노코드";
  if (sits.has("biz") && COMMERCE.has(p.id)) return "판매 활용";
  if (sits.has("korean") && p.region === "국내") return "한국어";
  return null;
}

export function AiFinder() {
  const go = useNav();
  const remote = usePlatforms();
  // 공유 링크(?goal=…&sit=…) 복원 → 선택 상태를 URL에 유지
  const sp0 = new URLSearchParams(location.search);
  const [goalId, setGoalId] = useState<string | null>(sp0.get("goal"));
  const [sits, setSits] = useState<Set<string>>(new Set((sp0.get("sit") ?? "").split(",").filter(Boolean)));
  useEffect(() => {
    const p = new URLSearchParams(location.search);
    if (goalId) p.set("goal", goalId); else p.delete("goal");
    if (sits.size) p.set("sit", [...sits].join(",")); else p.delete("sit");
    history.replaceState(null, "", `?${p}`);
  }, [goalId, sits]);
  const goal = GOALS.find((g) => g.id === goalId) ?? null;

  // 원격 데이터에 AI 분야가 아직 없으면(시드 전) 정적 데이터로 폴백
  const source: Platform[] = useMemo(() => {
    const hasAi = remote.some((p) => p.category.startsWith("ai_"));
    return hasAi ? remote : staticPlatforms;
  }, [remote]);

  const toggleSit = (id: string) => setSits((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const byCat = (cat: string): Platform[] => {
    const list = source.filter((p) => p.category === cat);
    if (sits.size === 0) return list;
    // 선택한 상황에 맞는 도구를 앞으로(안정 정렬 — 나머지 순서는 유지)
    return [...list].sort((a, b) => (fitLabel(b, sits) ? 1 : 0) - (fitLabel(a, sits) ? 1 : 0));
  };
  // 혼자 운영하면 조합을 넓히기보다 핵심만 — 분야당 표시 개수를 줄여 "시작 조합"에 집중
  const cap = sits.has("solo") ? 4 : 8;

  const extraTips: string[] = [];
  if (goal) {
    if (sits.has("korean")) extraTips.push("한국어가 편하면 국내 도구(뤼튼·클로바 계열)를 먼저 앞에 보여드려요 — 해외 도구도 대부분 한국어 입력은 잘 알아듣습니다.");
    if (sits.has("solo")) extraTips.push("혼자라면 도구를 늘리기보다 범용 챗봇 1개 + 분야 도구 1개로 시작하세요 — 조합이 많아질수록 관리가 일이 됩니다.");
    if (sits.has("noob") && goal.id === "dev") extraTips.push("코딩을 몰라도 대화형 앱 빌더(Lovable·Replit·Bolt.new)로 시작할 수 있어요 — 코드 대신 요구사항을 말로 다듬는 연습이 핵심.");
    if (sits.has("noob") && goal.id === "auto") extraTips.push("자동화가 처음이면 노코드형(Zapier·Make)부터 — n8n·Dify는 직접 설치가 필요해요.");
    if (sits.has("biz")) extraTips.push("판매 중이라면 상품 사진(배경 제거)·상세페이지 문구·고객 응대 순서로 AI를 붙이면 체감이 가장 빠릅니다.");
  }

  return (
    <main className="page container">
      <h1>🧠 AI 도구 찾기 <Badge kind="good">무료</Badge></h1>
      <p className="lead" style={{ maxWidth: 640 }}>
        전 세계 AI 도구 {source.filter((p) => p.category.startsWith("ai_")).length || 163}개를 같은 기준으로 정리했어요.
        무엇을 해결하고 싶은지 고르면 <b>시작 조합</b>을 추천해 드립니다 — 도구 이름을 몰라도 됩니다.
      </p>

      <div className="sec-title">① 지금 가장 해결하고 싶은 일은?</div>
      <div className="chips-row" style={{ marginBottom: 14 }}>
        {GOALS.map((g) => (
          <button key={g.id} className={`fchip ${goalId === g.id ? "on" : ""}`}
            onClick={() => setGoalId(goalId === g.id ? null : g.id)}>{g.icon} {g.label}</button>
        ))}
      </div>

      <div className="sec-title">② 내 상황 (선택)</div>
      <div className="chips-row" style={{ marginBottom: 18 }}>
        {SITUATIONS.map((s) => (
          <button key={s.id} className={`fchip ${sits.has(s.id) ? "on" : ""}`} onClick={() => toggleSit(s.id)}>{s.label}</button>
        ))}
      </div>

      {!goal ? (
        <div className="empty">위에서 해결하고 싶은 일을 고르면 추천이 나타나요.</div>
      ) : (
        <>
          <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 6 }}>
            <ShareButton title={`AI 도구 추천 — ${goal.label} | 세모플`} />
          </div>
          <div className="banner" style={{ marginBottom: 14 }}>
            💡 <b>시작 팁</b> — {goal.tip}
            {extraTips.map((t) => <div key={t} style={{ marginTop: 6 }}>{t}</div>)}
          </div>
          {goal.cats.map((cat) => {
            const c = categoryById(cat);
            const list = byCat(cat);
            if (list.length === 0) return null;
            const shown = list.slice(0, cap);
            const fitCount = shown.filter((p) => fitLabel(p, sits)).length;
            return (
              <div key={cat} style={{ marginBottom: 20 }}>
                <div className="sec-title">{c?.icon} {c?.name}{" "}
                  <span style={{ textTransform: "none", letterSpacing: 0 }}>
                    · {list.length}개{sits.has("solo") && list.length > cap ? ` 중 핵심 ${cap}개` : ""}
                    {fitCount > 0 ? ` · 내 상황에 맞는 ${fitCount}개 먼저` : ""}
                  </span>
                </div>
                <div className="card-grid">
                  {shown.map((p) => <PlatformCard key={p.id} p={p} showCat={false} fit={fitLabel(p, sits)} />)}
                </div>
              </div>
            );
          })}
          <p className="sub faint" style={{ fontSize: 12.5 }}>
            ★로 저장하면 계정에 동기화돼요. 각 도구의 요금·상업 사용 조건은 공식 사이트에서 확인하세요 —
            세모플은 중립 소개만 하고 어떤 도구의 대가도 받지 않습니다.
          </p>
        </>
      )}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 16 }}>
        <button className="btn ghost sm" onClick={() => go("home")}>전체 디렉토리에서 보기 →</button>
        <button className="btn ghost sm" onClick={() => go("submit")}>+ 빠진 AI 도구 제보</button>
      </div>
    </main>
  );
}
