/* 인앱 하이라이트 투어(driver.js) — 화면별 자동 1회 + 명시적 재실행 버튼.
 * driver.js는 시작 시점에 동적 import(부트 페이로드 무증가 — vite tour 청크).
 * 완료 기록은 sm.tour.v1(투어 id → timestamp 맵, store.ts와 동일한 localStorage 방어 패턴).
 * 앵커는 [data-tour="..."] 속성 — 미존재 앵커 스텝은 자동 스킵(lazy 뷰·조건부 렌더 대응). */
import { trackEvent } from "./api";

export interface TourStep { anchor?: string; title: string; text: string }

const KEY = "sm.tour.v1";
function seenMap(): Record<string, number> {
  try {
    const p: unknown = JSON.parse(localStorage.getItem(KEY) || "{}");
    return p && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, number>) : {};
  } catch { return {}; }
}
export function tourSeen(id: string): boolean { return !!seenMap()[id]; }
function markSeen(id: string) {
  try { localStorage.setItem(KEY, JSON.stringify({ ...seenMap(), [id]: Date.now() })); } catch { /* noop */ }
}

/* 투어 실행. auto=true면 이미 본 투어는 재실행하지 않는다(피로 방지 — 재실행은 명시적 버튼만).
 * 시작 즉시 seen 기록: 중도에 닫아도 다음 방문에 다시 튀어나오지 않게. */
export async function startTour(id: string, steps: TourStep[], opts?: { auto?: boolean }): Promise<boolean> {
  if (opts?.auto && tourSeen(id)) return false;
  const present = steps.filter((s) => !s.anchor || document.querySelector(`[data-tour="${s.anchor}"]`));
  if (present.length < 2) return false; // 앵커가 대부분 없는 화면(조건부 렌더)이면 실행하지 않음
  const [{ driver }] = await Promise.all([import("driver.js"), import("driver.js/dist/driver.css")]);
  markSeen(id);
  trackEvent("click", undefined, `tour:${id}:${opts?.auto ? "auto" : "manual"}`, { type: "tour", id });
  let reached = 0; // 완료 계측 — 닫힐 때 어느 스텝까지 봤는지(이탈 지점 분석)
  const d = driver({
    showProgress: true,
    progressText: "{{current}} / {{total}}",
    nextBtnText: "다음", prevBtnText: "이전", doneBtnText: "완료",
    onHighlighted: () => { reached = Math.max(reached, (d.getActiveIndex() ?? 0) + 1); },
    onDestroyed: () => { trackEvent("click", undefined, `tour:${id}:end:${reached}/${present.length}`, { type: "tour", id }); },
    steps: present.map((s) => ({
      element: s.anchor ? `[data-tour="${s.anchor}"]` : undefined,
      popover: { title: s.title, description: s.text },
    })),
  });
  d.drive();
  return true;
}

/* ── 투어 정의 ── */

/* 홈 첫 방문(G1): 검색 → 상황 칩 → 카드 액션 → 분야 그리드 → 도구 → 가입 가치 */
export const HOME_TOUR: TourStep[] = [
  { title: "세모플에 오신 걸 환영해요 👋", text: "세상의 모든 플랫폼을 분야별로 모아둔 디렉토리예요. 30초만에 핵심 사용법을 알려드릴게요." },
  { anchor: "search", title: "① 검색으로 시작", text: "플랫폼 이름(스마트스토어)도, 하려는 일(재능마켓, 크라우드펀딩)도 검색돼요. 자동완성이 분야까지 제안해요." },
  { anchor: "chips", title: "② 상황으로 시작해도 돼요", text: "입점·소싱·홍보처럼 지금 하려는 일을 고르면 맞는 분야로 바로 이동해요." },
  { anchor: "popular", title: "③ 카드에서 바로 저장·비교", text: "카드의 ☆로 즐겨찾기, [+ 비교]로 최대 4개까지 담아 수수료·정산 조건을 나란히 비교할 수 있어요." },
  { anchor: "groups", title: "④ 분야별로 훑어보기", text: "45개 분야를 그룹별로 정리했어요. 분야 카드를 누르면 해당 분야 전체 목록과 필터가 열려요." },
  { anchor: "tools", title: "⑤ 찾는 걸로 끝나지 않아요", text: "제휴 파트너 매칭, 플랫폼(스토어·계정) 양수도 거래소, AI 도구 추천까지 — 사업 단계에 맞게 이용하세요." },
  { anchor: "account", title: "⑥ 가입하면 좋은 점", text: "즐겨찾기가 계정에 보관되고, 저장한 검색 조건에 맞는 새 플랫폼이 오면 알림을 받아요. 언제든 이 투어는 하단 '둘러보기'로 다시 볼 수 있어요." },
];

/* 검색 화면(G2): 필터 → 정렬 → 조건 저장 → 결과 카드 */
export const SEARCH_TOUR: TourStep[] = [
  { anchor: "facets", title: "필터로 좁히기", text: "지역·최근 등록·수수료대(추정)·분야를 겹쳐 걸 수 있어요. 분야를 하나만 고르면 그 분야 비교표 링크도 열려요." },
  { anchor: "sort", title: "정렬 바꾸기", text: "관련도(기본)·인기순·신규 우선·가나다 — 목적에 맞게 바꿔보세요." },
  { anchor: "save-search", title: "🔔 이 조건 저장", text: "지금 조건을 저장하면 조건에 맞는 새 플랫폼이 등재될 때 알림으로 알려드려요(로그인 필요)." },
  { anchor: "results", title: "카드에서 저장·비교", text: "☆로 즐겨찾기, [+ 비교]로 최대 4개까지 담아 수수료·정산을 나란히 비교하세요." },
];

/* 상세 화면(G2): 판단 팩트 읽는 법 → 액션 → 정정 → 운영자 인증 */
export const DETAIL_TOUR: TourStep[] = [
  { anchor: "facts", title: "수수료·정산은 '추정'이에요", text: "공개 정보 기반 추정치예요. 항목 옆 '공식 확인 ↗'으로 원문을 꼭 확인하세요." },
  { anchor: "actions", title: "저장·비교·방문", text: "☆ 즐겨찾기, + 비교 담기(최대 4), 공식 사이트 방문은 여기서 해요." },
  { anchor: "correction", title: "정보가 다르면 정정 제안", text: "수수료·정산·입점 조건이 실제와 다르면 알려주세요 — 검수 후 반영돼요." },
  { anchor: "claim", title: "이 플랫폼 운영자라면", text: "도메인 이메일로 운영자 인증을 하면 검증 배지가 붙고 제휴 제안을 공식으로 받아요." },
];

/* 계정 화면(G2·로그인 후): 프로필 → 관심 분야(온보딩 연결) → 저장 검색 → 내 제보 */
export const ACCOUNT_TOUR: TourStep[] = [
  { anchor: "profile", title: "프로필 관리", text: "표시 이름·비밀번호·이메일을 여기서 바꿔요. 소개·안내 메일이 이 이메일로 가니 최신으로 유지하세요." },
  { anchor: "interests", title: "✨ 관심 분야부터 설정!", text: "관심 분야를 골라두면 홈이 내 분야 추천 중심으로 바뀌고, 주간 신규도 내 분야만 모아볼 수 있어요." },
  { anchor: "saved", title: "저장 검색 관리", text: "검색 화면에서 저장한 조건 목록이에요. 조건에 맞는 새 플랫폼이 오면 알림을 받아요." },
  { anchor: "submits", title: "내 제보 현황", text: "제보한 플랫폼의 검수 상태를 여기서 확인해요." },
];

/* 제휴 매칭 화면(G5): 절차 → 방식 카탈로그 → 보드 → 등록 폼 → 요금 */
export const PARTNERS_TOUR: TourStep[] = [
  { anchor: "p-process", title: "제휴 매칭은 4단계", text: "방식 고르기 → 제안 등록 → 세모플이 양측 확인 후 이메일 소개 → 이후는 당사자 직접 진행. 게시글은 익명(참조번호)이라 무분별한 영업 연락이 오지 않아요." },
  { anchor: "p-catalog", title: "① 제휴 방식부터 고르세요", text: "입점 제휴·공동 프로모션 등 방식 카탈로그예요. 목적 필터로 우리 상황에 맞는 방식을 찾아보세요." },
  { anchor: "p-board", title: "② 보드에서 제안 찾기", text: "이미 올라온 제휴 제안들이에요. 맞는 제안이 있으면 '매칭 신청'으로 우리 소개·왜 맞는지·구체 제안을 보내세요." },
  { anchor: "p-form", title: "③ 우리 제안 올리기", text: "제휴 방식·제목·주는 것(Give)·원하는 것(Get)을 적어 등록하면 보드에 익명으로 게시돼요(로그인 필요)." },
  { anchor: "p-pricing", title: "요금은 지금 전부 무료", text: "스폰서·연결료·Pro는 오픈 예정 상품이에요. 유료 전환은 30일 전 공지 후 시작됩니다. 자세한 건 도움말의 '광고·스폰서 상품 안내'를 보세요." },
];

/* 거래소 화면(G5): 절차 → 매물 보드 → 등록 분기 → 안전 원칙 */
export const EXCHANGE_TOUR: TourStep[] = [
  { anchor: "x-process", title: "거래소는 익명으로 안전하게", text: "익명 등록 → 관심 수집 → 양측 확인 후 이메일 소개 → 협상은 당사자 직접. 스토어·계정 같은 자산·사업 양수도만 다뤄요(지분·투자 아님)." },
  { anchor: "x-board", title: "① 매물 둘러보기", text: "익명 요약으로 게시된 매물들이에요. 마음에 들면 '관심 등록'으로 간단 소개를 보내고, 궁금한 건 익명 Q&A로 물어보세요." },
  { anchor: "x-reg", title: "② 팔거나·사거나 등록", text: "매각은 '매각 접수'(작성 중 자동 저장·익명성 자동 점검), 인수는 '인수 브리프'로 원하는 조건을 남기면 맞는 매물을 우선 안내해요." },
  { anchor: "x-why", title: "가격은 게시되지 않아요", text: "게시물에 가격·연락처는 올라가지 않습니다(익명 원칙). 시세 감이 필요하면 '가치 자가 진단'(밴드 입력→밴드 출력, 저장 안 됨)을 참고하세요." },
];
