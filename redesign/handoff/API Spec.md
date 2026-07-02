# 세모플 — 백엔드 API 스펙 (v0.9 draft)

프론트엔드 프로토타입(`data/platforms.js` 및 각 화면 DC)의 동작을 실제 백엔드로 옮기기 위한 계약 정의서입니다.
프론트는 이미 이 형태를 가정하고 있으므로, 아래 응답 스키마를 맞추면 `fetchPlatforms()` 본문 교체만으로 연동됩니다.

---

## 0. 공통

- **Base URL**: `/api/v1`
- **형식**: 요청·응답 모두 `application/json; charset=utf-8`
- **인증**: `Authorization: Bearer <token>`
- **역할(Role)**: `user`(실사용자) · `operator`(플랫폼 운영자) · `admin`(운영/큐레이션)
- **페이지네이션**: `?page=1&size=20` → 응답에 `page`, `size`, `total`, `items`
- **에러 형식**
  ```json
  { "error": { "code": "NOT_FOUND", "message": "platform not found", "field": null } }
  ```

### 공통 열거형(Enum)

| 이름 | 값 |
|---|---|
| `fee` (수수료대) | `낮음` · `중간` · `높음` |
| `region` | `국내` · `해외` |
| `lifecycle` | `soon`(준비중) · `review`(검증대기) · `verified`(검증됨) · `matched`(성사) · `rejected`(반려) |
| `submissionStatus` | `pending` · `hold` · `approved` · `rejected` |
| `category` | `오픈마켓·종합몰` · `크라우드펀딩` · `패션·편집샵` · `수출입·도매` · `사무·MRO·B2B` · `프리랜서·전문가` … |

---

## 1. 데이터 모델

### Platform  (← `data/platforms.js`의 레코드와 1:1)
```jsonc
{
  "id": "coupang",
  "name": "쿠팡",
  "initial": "쿠",                 // 아바타 이니셜
  "grad": "linear-gradient(...)",  // 아바타 그라디언트 (또는 logoUrl로 대체)
  "category": "오픈마켓·종합몰",
  "region": "국내",
  "fee": "높음",                    // enum
  "feeText": "~4–10.8%",           // 표시용 문자열
  "year": 2024,                    // 디렉토리 등록연도
  "verified": true,
  "isNew": false,
  "desc": "로켓배송 기반 …",
  "settle": "주 / 월 선택",         // 정산주기
  "enter": "사업자등록 필수",        // 입점조건
  "strength": "국내 최대 트래픽·로켓배송",
  "lifecycle": "verified",
  "fees": [                        // 상세 페이지용 (선택)
    { "cat": "가전·디지털", "fee": "~5–8%", "note": "…" }
  ],
  "pros": ["…"], "cons": ["…"],
  "url": "https://coupang.com",
  "updatedAt": "2026-06-01T00:00:00Z"
}
```

### 기타 리소스
- **Submission**(제보): `id, platform:{name,category,region,fee,url,desc}, submitter, status, dupSuspectId?, createdAt`
- **Favorite**: `id, userId, platformId, collection('interest'|'review'|'plan'), memo, alert:boolean`
- **Proposal**(제휴): `id, fromPlatformId, toPlatformId, type, status('검토중'|'수락'|'거절'), createdAt`
- **BoostOrder**: `id, platformId, tier, dailyBudget, days, addons[], estImpressions, estClicks, total, status`

---

## 2. 실사용자 (User)

| Method | Endpoint | 화면 | 설명 |
|---|---|---|---|
| `GET` | `/platforms` | 검색결과·홈 | 검색·필터·정렬·페이지네이션 |
| `GET` | `/platforms/:id` | 상세 | 단건 + `similar[]` 포함 |
| `GET` | `/categories` | 홈 대분류 | 그룹별 분야·플랫폼 수 집계 |
| `GET` | `/stats` | 홈 스탯 | `{ platforms, categories, newThisMonth }` |
| `GET` | `/recommendations` | 온보딩 | 아래 참조 |

### `GET /platforms` 쿼리
```
?q=쿠팡              전문 검색 (name·category·desc)
&category=패션·편집샵  (복수: 콤마 구분)
&region=국내
&fee=낮음,중간       (복수)
&status=new,verified (복수)
&sort=rel|new|name
&page=1&size=20
```
응답: `{ page, size, total, items: Platform[] }`

### `GET /recommendations` (개인화 온보딩)
요청: `{ type, categories[], size, goals[] }` (goals: `fee|settle|traffic|global|validate`)
응답: `{ items: [ { ...Platform, matchScore, reasons[] } ] }` — goals 교집합으로 스코어링·정렬

### 즐겨찾기
| Method | Endpoint | 설명 |
|---|---|---|
| `GET` | `/me/favorites?collection=review` | 컬렉션별 목록 |
| `POST` | `/me/favorites` | `{ platformId, collection }` |
| `PATCH` | `/me/favorites/:id` | `{ collection?, memo?, alert? }` |
| `DELETE` | `/me/favorites/:id` | 제거 |

---

## 3. 관리자 (Admin)

| Method | Endpoint | 화면 | 설명 |
|---|---|---|---|
| `GET` | `/admin/submissions?status=pending` | 검수 큐 | 상태별 제보 목록 + `dupSuspect` |
| `PATCH` | `/admin/submissions/:id` | 검수 큐 | `{ action: "approve"\|"hold"\|"reject", badge?:bool, lifecycle?, reason? }` |
| `GET` | `/admin/metrics` | 대시보드 | 제보량·인기검색·즐겨찾기 상위 |
| `POST` | `/admin/platforms` / `PATCH /admin/platforms/:id` | 편집 | 플랫폼 CRUD |
| `POST` | `/admin/platforms/:id/transition` | 라이프사이클 | `{ to: lifecycle }` — 허용 전이만, 감사 로그 자동 기록 |
| `GET` | `/admin/audit?platformId=` | 라이프사이클 | 전이 감사 로그 |

**허용 전이(상태머신)**
```
soon      → review, rejected
review    → verified, soon, rejected
verified  → matched, review
matched   → verified
rejected  → soon
```

---

## 4. 플랫폼 운영자 (Operator)

| Method | Endpoint | 화면 | 설명 |
|---|---|---|---|
| `POST` | `/operator/claims` | 클레임 | `{ platformId, businessEmail }` → 도메인 인증 |
| `GET`/`PATCH` | `/operator/platforms/:id` | 콘솔 | 소유 플랫폼 프로필 편집(검수 후 반영) |
| `GET` | `/operator/platforms/:id/metrics?range=7d` | 콘솔 | `{ impressions[], clicks, favorites }` |
| `GET` | `/operator/matches?type=logi` | 제휴 매칭 | 후보 + `matchScore`·`reasons[]` |
| `POST` | `/operator/proposals` | 제휴 매칭 | `{ toPlatformId, type }` |
| `GET` | `/operator/proposals?dir=sent\|received` | 제휴 매칭 | 제안 현황 |
| `GET` | `/boost/tiers` | 부스트 | 노출 상품·단가·CTR |
| `POST` | `/boost/estimate` | 부스트 | `{ tier, dailyBudget, days, addons[] }` → `{ estImpressions, estClicks, total }` |
| `POST` | `/boost/orders` | 부스트 | 집행 요청(검수 후 시작) |

---

## 5. 클라이언트 계약 (`data/api.js`) — 확정본

모든 화면은 `data/api.js`를 통해서만 데이터에 접근합니다. 아래 함수 시그니처가 계약의 확정본이며,
각 함수 본문을 해당 REST 호출로 교체하면 정식 백엔드로 전환됩니다. (원본 데이터는 `data/platforms.js`)

| `api.js` 함수 | REST 매핑 | 반환 | 사용 화면 |
|---|---|---|---|
| `fetchPlatforms()` | `GET /platforms` | `Platform[]` | 홈·비교 |
| `searchPlatforms({ q, category[], region[], fee[], status[], sort, page, size })` | `GET /platforms?…` | `{ page, size, total, items }` | 검색결과 |
| `getPlatform(id)` | `GET /platforms/:id` | `Platform & { similar: Platform[] }` | 상세 |
| `getCategories()` | `GET /categories` | `{ category, count }[]` | 홈 대분류 |
| `getStats()` | `GET /stats` | `{ platforms, categories, newThisMonth, commerce }` | 홈 스탯 |
| `getRecommendations({ goals[] })` | `GET /recommendations` | `{ items: (Platform & { matchScore, reasons[] })[] }` | 온보딩 |
| `listFavorites(collection?)` | `GET /me/favorites` | `Favorite[]`(플랫폼 조인) | 즐겨찾기 |
| `addFavorite(platformId, collection?)` | `POST /me/favorites` | `Favorite` | 즐겨찾기 |
| `updateFavorite(id, { collection?, memo?, alert? })` | `PATCH /me/favorites/:id` | `Favorite` | 즐겨찾기 |
| `removeFavorite(id)` | `DELETE /me/favorites/:id` | `{ ok }` | 즐겨찾기 |
| `getSubmissions(status?)` | `GET /admin/submissions` | `Submission[]` | 검수 큐 |
| `updateSubmission(id, { action })` | `PATCH /admin/submissions/:id` | `Submission` | 검수 큐 |
| `LIFECYCLE` (상수) | `GET /admin/lifecycle` | `{ [state]: { label, allow[] } }` | 라이프사이클 |
| `canTransition(from, to)` | — (클라 검증) | `boolean` | 라이프사이클 |
| `getMatches(type?)` | `GET /operator/matches` | `Match[]` | 제휴 매칭 |
| `getProposals()` | `GET /operator/proposals` | `{ sent[], received[] }` | 제휴 매칭 |
| `sendProposal(toPlatformId, type)` | `POST /operator/proposals` | `Proposal` | 제휴 매칭 |
| `getBoostTiers()` | `GET /boost/tiers` | `Tier[]` | 부스트 |
| `estimateBoost({ tier, dailyBudget, days, addons[] })` | `POST /boost/estimate` | `{ estImpressions, estClicks, total }` | 부스트 |
| `getMetrics(platformId, range?)` | `GET /operator/platforms/:id/metrics` | `{ spark[], impressionsLabel, clicksLabel, favoritesLabel }` | 운영자 콘솔 |

### 화면 연동 패턴 (확정)
```js
async componentDidMount() {
  const { searchPlatforms } = await import('./data/api.js');
  const { items } = await searchPlatforms({ category: ['패션·편집샵'] });
  this.setState({ pool: items, loaded: true });
}
```
- 모든 화면이 `componentDidMount` → `import('./data/api.js')` → `setState` 패턴을 따릅니다(로딩 가드 포함).
- 현재 `api.js`는 실제 지연(120ms)을 시뮬레이션해 로딩 상태까지 검증됩니다.
- 낙관적 UI(즐겨찾기 메모·컬렉션, 검수 승인/반려, 라이프사이클 전이, 제안 보내기)는 로컬 state에서 즉시 반영 후 서버 확정 시 유지, 실패 시 롤백합니다.

### 정식 전환 체크리스트
1. `api.js`의 각 함수 본문을 `fetch('/api/v1/…')`로 교체 (시그니처 유지 → 화면 무수정)
2. 인증 토큰 주입(`Authorization` 헤더) 공통 래퍼 추가
3. `platforms.js`는 시드/폴백 데이터로만 유지하거나 제거
4. 에러 처리: 위 §0 에러 형식으로 통일, 화면 로딩 가드에 에러 상태 추가
