/* =============================================================
 * YOU&I 목재 안내판 디자인 시스템 (시드 설정)
 * -------------------------------------------------------------
 * 이 파일은 우리 목재 안내판에 "공통적으로 적용되는 규칙"을 코드화한
 * 단일 출처(single source of truth)입니다.
 *
 * 일러스트(.ai) 원본을 SVG로 내보내 편집기에 올려보면서,
 * 실제로 반복되는 규칙(색/폰트/여백/픽토그램 스타일/레이아웃)을
 * 이 파일에 계속 채워 넣으면 됩니다. 편집기는 이 값들을
 * 프리셋으로 그대로 사용합니다.
 *
 * ※ 현재 값은 참고 이미지(design.jpg)에서 뽑은 임시 시드입니다.
 *   실제 자료가 들어오면 교체/확장하세요.
 * ============================================================= */

const DESIGN_SYSTEM = {
  meta: {
    brand: "YOU&I Sign",
    version: "0.1.0",
    note: "임시 시드 값 — 일러스트 원본(SVG)으로 검증 후 갱신 필요",
  },

  /* 색상 팔레트 — 목재/패널/포인트 색
   * (참고 이미지의 차콜 패널 + 오크 우드 + 테라코타 포인트 기반) */
  palette: {
    woodOak:    { name: "오크 우드",   value: "#b6803e" },
    woodLight:  { name: "라이트 우드", value: "#d8b483" },
    woodWalnut: { name: "월넛",        value: "#5c3b22" },
    charcoal:   { name: "차콜 패널",   value: "#26272b" },
    cream:      { name: "크림",        value: "#f3ede1" },
    terracotta: { name: "테라코타",    value: "#c77b5a" },
    ink:        { name: "잉크(본문)",  value: "#1c1c1c" },
    white:      { name: "화이트",      value: "#ffffff" },
  },

  /* 폰트 — 안내판은 가독성이 최우선. 굵고 넓은 산세리프 권장.
   * (웹 기본 폰트로 매핑. 실제 제작 폰트가 정해지면 교체) */
  fonts: {
    heading: { name: "제목", stack: "'Pretendard','Noto Sans KR','Malgun Gothic',sans-serif", weight: 800 },
    body:    { name: "본문", stack: "'Pretendard','Noto Sans KR','Malgun Gothic',sans-serif", weight: 500 },
    label:   { name: "라벨", stack: "'Pretendard','Noto Sans KR','Malgun Gothic',sans-serif", weight: 700 },
  },

  /* 보드(안내판 판) 규격 프리셋 — 실제 제작 치수(mm) 기준 */
  boards: [
    { id: "a-stand",   name: "A형 입식 (600×900)",  widthMm: 600,  heightMm: 900,  marginMm: 40, radiusMm: 30, bg: "charcoal" },
    { id: "wall-wide", name: "벽부형 가로 (900×600)", widthMm: 900,  heightMm: 600,  marginMm: 40, radiusMm: 20, bg: "charcoal" },
    { id: "post-tall", name: "기둥형 세로 (450×1200)", widthMm: 450,  heightMm: 1200, marginMm: 35, radiusMm: 40, bg: "woodWalnut" },
    { id: "map-large", name: "지도 대형 (1200×900)", widthMm: 1200, heightMm: 900,  marginMm: 50, radiusMm: 20, bg: "cream" },
  ],

  /* 레이아웃 규칙 — 안내판 안에서 요소가 어떻게 배치되는가
   * (모든 값은 보드 기준 비율 0~1, 또는 mm) */
  layout: {
    safeMargin: 0.06,          // 가장자리 안전 여백(보드 짧은 변 대비 비율)
    titleZone:  { top: 0.06, height: 0.18 }, // 상단 제목 영역
    bodyZone:   { top: 0.26, height: 0.5 },  // 중앙 본문/지도 영역
    footerZone: { top: 0.82, height: 0.12 }, // 하단 라벨/QR 영역
    minTitlePt: 60,            // 제목 최소 크기(시인성 확보)
    minBodyPt:  28,
    gridGutterMm: 12,
  },

  /* 픽토그램 — 안내판 공통 아이콘 (SVG path, 24×24 viewBox 기준)
   * 단색 라인/면 스타일로 통일 */
  pictograms: [
    { id: "arrow",    name: "화살표",  path: "M4 12h12M12 6l6 6-6 6", style: "stroke" },
    { id: "info",     name: "안내(i)", path: "M12 2a10 10 0 100 20 10 10 0 000-20zm0 4a1.3 1.3 0 110 2.6 1.3 1.3 0 010-2.6zm1.5 12h-3v-1.2h.9V11h-.9V9.8h2.1v6.8h.9z", style: "fill" },
    { id: "wc",       name: "화장실",  path: "M7 4a1.6 1.6 0 110 3.2A1.6 1.6 0 017 4zm-1.4 4h2.8l1.4 5H8.4v7H5.6v-7H4.2zM16.5 4a1.6 1.6 0 110 3.2 1.6 1.6 0 010-3.2zM15 8h3l1.6 5h-1.4l-.7 7h-2l-.7-7h-1.4z", style: "fill" },
    { id: "parking",  name: "주차",    path: "M6 3h7a5 5 0 010 10H9v8H6V3zm3 3v4h4a2 2 0 000-4H9z", style: "fill" },
    { id: "pin",      name: "위치핀",  path: "M12 2a7 7 0 00-7 7c0 5 7 13 7 13s7-8 7-13a7 7 0 00-7-7zm0 9.5A2.5 2.5 0 1112 6.5a2.5 2.5 0 010 5z", style: "fill" },
    { id: "tree",     name: "나무",    path: "M12 2l5 8h-3l4 6h-4v6h-4v-6H6l4-6H7z", style: "fill" },
    { id: "no-entry", name: "출입금지",path: "M12 2a10 10 0 100 20 10 10 0 000-20zM5.6 7L17 18.4A8 8 0 005.6 7z", style: "fill" },
    { id: "stairs",   name: "계단",    path: "M4 20v-3h4v-3h4v-3h4v-3h4V4", style: "stroke" },
  ],

  /* QR/라벨 기본 규칙 */
  components: {
    qr:    { sizeMm: 80, position: "footer-right" },
    plate: { radiusMm: 12, color: "terracotta" }, // 참고 이미지의 컵홀더형 플레이트
  },
};

// 색 헬퍼: 팔레트 키 → hex
DESIGN_SYSTEM.color = function (key) {
  const c = DESIGN_SYSTEM.palette[key];
  return c ? c.value : key; // 키가 아니면 그대로(직접 hex 입력 허용)
};

if (typeof window !== "undefined") window.DESIGN_SYSTEM = DESIGN_SYSTEM;
