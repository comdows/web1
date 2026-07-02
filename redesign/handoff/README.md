# Handoff: 세모플(SEMOPL) — 플랫폼 디렉토리

## Overview
세모플("세상의 모든 플랫폼")은 오픈마켓·크라우드펀딩·수출·B2B 등 국내외 판매·거래 플랫폼 1,559개를 분야별로 정리한 **디렉토리 서비스**입니다. 세 페르소나를 지원합니다:
- **실사용자(셀러)** — 어디서 팔지 탐색·비교·결정
- **관리자(운영팀)** — 제보 검수·데이터 큐레이션·라이프사이클 관리
- **플랫폼 운영자** — 자사 노출 관리·제휴 매칭·유료 부스트

## About the Design Files
이 번들의 파일들은 **HTML로 만든 디자인 레퍼런스(프로토타입)** 입니다 — 의도한 룩앤필과 동작을 보여주는 참고물이며, 그대로 프로덕션에 복사할 코드가 아닙니다.
작업 목표는 이 디자인을 **대상 코드베이스의 기존 환경(React/Vue/Next 등)과 패턴·라이브러리로 재현**하는 것입니다. 환경이 아직 없다면 프로젝트에 가장 적합한 프레임워크를 선택해 구현하세요.

각 화면은 **Design Component(`.dc.html`)** 형식입니다. 한 파일에 마크업(템플릿)과 로직(클래스)이 함께 들어 있으며, 데이터는 전부 `data/api.js`(목 API) 한 곳을 거칩니다. 프레임워크로 옮길 때는 **템플릿 → 컴포넌트 JSX/SFC**, **로직 클래스 → 컴포넌트 상태/핸들러**, **`data/api.js` → 실제 API 클라이언트**로 매핑하면 1:1로 대응됩니다.

## Fidelity
**High-fidelity (hifi).** 최종 색상·타이포·간격·인터랙션이 확정된 픽셀 단위 목업입니다. 아래 디자인 토큰과 각 화면 스펙을 그대로 재현하세요. (다크 테마 기준)

---

## Design Tokens

### Surfaces (다크, 기본)
| 토큰 | 값 | 용도 |
|---|---|---|
| `--bg` | `#0A0E1A` | 앱 배경 |
| `--surface` | `#111725` | 카드·패널 |
| `--surface-2` | `#161E30` | hover/raised |
| `--surface-3` | `#1B2540` | active/selected, 칩 배경 |
| `--line` | `#25314C` | 테두리 |
| `--line-soft` | `#1B2334` | 옅은 구분선 |

### Text
| 토큰 | 값 |
|---|---|
| primary `--text` | `#E8EEFC` |
| secondary `--muted` | `#97A6C8` |
| tertiary `--faint` | `#5E6C8C` |

### Brand & Accent
| 토큰 | 값 |
|---|---|
| brand | `#3D63FF` (그라디언트 쌍 `#2445D4`) |
| brand-soft(링크/강조) | `#7C97FF` |
| cyan | `#38BDF8` (tint `rgba(56,189,248,.14)`) |
| teal | `#22D3B8` (tint `rgba(34,211,184,.15)`) |
| success | `#2CC08A` · warn `#F5B544` · danger `#F2695F` |

수수료대 배지: 낮음 = teal/`#2CC08A`, 중간 = warn/`#F5B544`, 높음 = danger/`#F2695F` (각 배경은 해당 색 15% 알파).

### Typography
- Sans: **Pretendard Variable** (Pretendard, system-ui 폴백)
- Mono: **IBM Plex Mono** — 수치·라벨·eyebrow·메타에 사용 (tabular-nums)
- 스케일(px): display 40/52, h1 28, h2 22, 본문 15, sm 13, cap 12. 헤딩 letter-spacing `-0.02em`, eyebrow/라벨 letter-spacing `.08~.14em` 대문자.

### 간격 / 반경 / 그림자
- 8px 베이스 스케일 (4·8·12·16·24·32·48·64)
- radius: 6/8/10/12/16/999(pill)
- 그림자(브랜드 글로우): `0 0 0 1px rgba(61,99,255,.14), 0 10px 30px rgba(61,99,255,.16)`
- 포커스 링: `0 0 0 3px rgba(61,99,255,.40)`

### 블루프린트 그래픽 언어(브랜드 시그니처)
- 8px 그리드 배경 오버레이: `linear-gradient(rgba(124,151,255,.05) 1px,transparent 1px)` 가로·세로, `background-size:8px 8px`
- 패널 코너 틱: 8px L자 마크 `border-color:rgba(124,151,255,.28)`
- 섹션 헤더 앞 45° 회전 사각형 마커(테두리만)
- 로고: 삼각형(△) 아웃라인 SVG + "세모**플**"(플 = brand-soft)

---

## Screens / Views

> 진입점: **Index.dc.html** (전체 화면 맵, 페르소나 레인별 링크). 아래는 화면별 요약. 정확한 마크업·치수·색은 각 `.dc.html` 파일이 소스 오브 트루스입니다.

### 사용자
1. **Home.dc.html** — 스티키 헤더(로고+내비+즐겨찾기 카운트+플랫폼 제보 CTA), 히어로(검색바+분야 칩+스탯 4타일), 안내 배너, 대분류 GroupCard 5, 신규·추천 PlatformCard(별표 즐겨찾기 토글), 최근 등록 Table, 사이드바 분야 아코디언 + 관리자 로컬 모드 배너. 2단은 `flex-wrap`으로 반응형. Tweaks: `showGrid`·`showDisclaimer`·`showDirectory`.
2. **Search Results.dc.html** — 좌측 필터 패싯(분야 다중·지역 단일·수수료대 다중·상태), 정렬(관련도/신규/이름), 활성 필터 칩, 결과 그리드, 빈 상태, 로딩 상태.
3. **Platform Detail.dc.html** — 히어로(아바타·검증/성사 배지·공식사이트 CTA·즐겨찾기/비교 토글), 핵심 팩트 6칸, 수수료·정산 표, 강점/유의점, 신뢰·검증 사이드카드, 운영자 클레임 배너, 유사 플랫폼.
4. **Compare.dc.html** — 최대 4개 나란히 비교(8개 속성 행), 컬럼 추가/삭제 picker, 수수료대 색상 칩.
5. **Favorites.dc.html** — 컬렉션 탭(관심/검토중/입점예정), 카드별 메모 편집·변경 알림 토글·컬렉션 이동·제거, 비교 선택 체크박스.
6. **Onboarding.dc.html** — 4단계 위저드(판매유형→카테고리→규모→우선순위)+진행바, 결과 화면에 맞춤 추천(적합도·매칭 이유 칩).

### 관리자
7. **Admin Dashboard.dc.html** — 운영 허브. KPI 4(총 플랫폼·검수 대기·이번주 승인·데이터 이슈), 검수 대기 요약(→ 검수 큐), 데이터 품질(중복 의심·죽은 링크·노후 항목), 인기 검색어(추세), 최근 활동, 관리자 로컬 모드 배너. `getAdminDashboard`+`getSubmissions` 호출.
8. **Admin Review Queue.dc.html** — 스탯 4, 상태 탭(대기/보류/승인/반려/전체), 마스터-디테일: 큐 리스트 + 상세(제보 정보·중복 의심 경고·라이프사이클 지정·검증 배지·승인/보류/반려·최근 처리).
8. **Lifecycle.dc.html** — 상태머신 다이어그램(준비중→검증대기→검증됨→성사, +반려), 5열 칸반, 카드 선택 → 허용된 전이 실행 → 감사 로그.

### 운영자
9. **Operator Claim.dc.html** — 소유권 클레임 4단계 위저드(플랫폼 확인 → 인증 방법[도메인 이메일·메타태그/DNS·사업자등록증] → 이메일 코드 인증 → 완료) + 단계 인디케이터. `submitClaim` 호출. 상세 페이지 배너·운영자 콘솔 '인증 관리'에서 진입.
10. **Operator Console.dc.html** — 소유권 인증 배너, 성과 스트립(7일 스파크라인·노출·클릭·즐겨찾기), 프로필 편집 폼 ↔ 우측 라이브 디렉토리 미리보기(입력 실시간 반영)·프로모션 배너·CTA·브랜드 색 스와치.
10. **Partner Match.dc.html** — 매칭 유형 필터, 후보 카드(매칭도%·이유 칩·제안/관심/패스), 보낸/받은 제안 사이드바.
11. **Boost.dc.html** — 노출 위치 선택(라디오 카드), 예산 슬라이더+기간+추가옵션 토글, 배치 미리보기(AD 배지), 예상 노출/클릭·주문 요약(실시간 계산).

### 모바일 / 기타
12. **Mobile.dc.html** — 다크 iPhone 프레임 3개(홈·검색+바텀시트 필터·상세). 단일 컬럼·하단 탭바·44px+ 터치 타깃·sticky 하단 CTA.
13. **Index.dc.html** — 프로토타입 맵 허브. **Product Plan.dc.html** — 3-관점 UX 감사(성숙도 매트릭스·로드맵). **Design System.dc.html** — 동기화된 13개 컴포넌트 갤러리(`ds/`).

---

## Interactions & Behavior
- **네비게이션**: 화면 간 상대 링크(`<a href="X.dc.html">`). 사용자 플로우 홈→검색→상세→비교; 페르소나별 헤더 내비.
- **즐겨찾기 토글**: 별 클릭 → 로컬 상태 즉시 반영 + `addFavorite` 호출(낙관적). 헤더 카운트 연동.
- **필터/정렬/검색**: 전부 클라이언트 상태로 실시간 반영, 결과 카운트·활성 칩 갱신, 빈 결과 상태 분기.
- **검수/전이/제안**: 낙관적 UI — 로컬 상태 즉시 변경 후 API mutation 호출(`updateSubmission`/`transitionPlatform`/`sendProposal`). 라이프사이클 전이는 `canTransition`으로 사전 검증.
- **바텀시트/아코디언**: 열림/닫힘 토글 상태.
- **애니메이션**: 진입 애니메이션은 사용하지 않음(카드는 rest 상태로 즉시 표시). hover는 border-color/transform `translateY(-2px)` transition ~200ms `cubic-bezier(.2,.7,.2,1)`.
- **로딩 상태**: 목 API가 120ms 지연을 시뮬레이션 → 각 화면에 로딩 가드(스켈레톤/“불러오는 중…”). 실제 API에서는 에러 상태도 추가 필요.
- **반응형**: 고정 2단 레이아웃은 `display:flex;flex-wrap:wrap` + 자식 `flex:1 1 <basis>`로 좁은 폭에서 세로 스택. 카드 그리드는 `repeat(auto-fill,minmax(…,1fr))`. 헤더 내비는 `flex-wrap`.

## State Management
화면별 로컬 상태 예시(로직 클래스의 `state`):
- Search: `{ query, cats{}, regions{}, fees{}, status{}, sort, pool[], categories[], loaded }`
- Favorites: `{ tab, selected{}, items[], loaded }`
- Admin: `{ subs[], selectedId, filter, lastAction, loaded }`
- Lifecycle: `{ machine, cards[], selectedId, log[], step }`
- Boost: `{ tier, dailyBudget, days, addons{}, tiersMap{}, loaded }`
- Onboarding: `{ step, type, cats{}, size, goals{}, recs[] }`

데이터 페칭 패턴(모든 화면 공통):
```js
async componentDidMount() {
  const api = await import('./data/api.js');
  const data = await api.searchPlatforms({ category: ['패션·편집샵'] });
  this.setState({ ...data, loaded: true });
}
```

## Data & API
- **`data/platforms.js`** — 플랫폼 데이터 단일 소스(원본). 레코드 스키마·헬퍼 포함.
- **`data/api.js`** — 목 API 클라이언트(12+ 함수). 실제 서버 연동 시 각 함수 본문만 `fetch`로 교체(시그니처 유지 → 화면 무수정).
- **`API Spec.md`** — 확정된 REST 계약: 공통 규약·열거형, 데이터 모델(Platform/Submission/Favorite/Proposal/BoostOrder), 역할별 엔드포인트, 상태머신 전이 규칙, `api.js` 함수↔엔드포인트 매핑표, 정식 전환 체크리스트. **이 문서가 백엔드/프론트 계약의 기준입니다.**

## Assets
- 이미지 없음. 아바타는 이니셜 + CSS 그라디언트로 표현(실제 구현 시 로고 URL 필드 `logoUrl`로 대체 가능 — 스키마에 자리 있음).
- 아이콘은 이모지 + 인라인 SVG(삼각형 로고). 프로덕션에서는 코드베이스의 아이콘 세트로 대체 권장.
- 폰트: Pretendard Variable, IBM Plex Mono (CDN `<link>` — 프로덕션은 self-host 권장).

## Files
- 화면: `Home.dc.html`, `Search Results.dc.html`, `Platform Detail.dc.html`, `Compare.dc.html`, `Favorites.dc.html`, `Onboarding.dc.html`, `Admin Dashboard.dc.html`, `Admin Review Queue.dc.html`, `Lifecycle.dc.html`, `Operator Claim.dc.html`, `Operatorr Console.dc.html`, `Partner Match.dc.html`, `Boost.dc.html`, `Mobile.dc.html`, `Index.dc.html`, `Product Plan.dc.html`, `Design System.dc.html`
- 데이터/계약: `data/platforms.js`, `data/api.js`, `API Spec.md`
- 원본 컴포넌트 레퍼런스(디자인 토큰·컴포넌트 CSS 확인용): `ds/` (13개 HTML + `_index.json`)

> DC 파일을 브라우저에서 바로 열면 동작합니다(런타임 `support.js` 필요 — 디자인 확인용, 이식 대상 아님). 정확한 색/치수/카피는 항상 해당 `.dc.html` 소스를 기준으로 하세요.
