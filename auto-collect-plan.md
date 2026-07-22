# 신규 플랫폼·AI 도구 자동 수집 계획 v3 (2026-07-22)

> 목표: 최신 출시뿐 아니라 이미 존재하지만 세모플에 없는 플랫폼을 지속 발굴한다.
> 원칙: main 풀에서 직접 URL·중복·분야·신뢰도 게이트를 모두 통과한 후보만 `lifecycle=review`로 자동 공개하고,
> 관리자가 사후 검수해 `verified` 승격 또는 공개 제외한다.

## 1. 구조

```
GitHub Actions (월·수·금 07:00 KST + 수동 실행)
  └ backend/collect/collect.mjs
      ① 26개 소스 수집
         · Product Hunt 6토픽 · HN 3키워드 + 전체 최신 + 과거 백필
         · GitHub SaaS/Marketplace 최신 + 과거 백필 · BetaList
         · 국내 매체 6 · GeekNews · Google News 검색 3
      ② 정규화 — 제목/HTML/지역/실사이트 URL 정리
      ③ 중복 제거 — 운영 DB 호스트·이름 + 봇의 과거 제보를 1,000행씩 끝까지 조회해 대조
      ④ 국가 × 유입 풀 완전 분리 — 버킷 간 남는 예산 이월 없음
         · 국내 main 22 / 국내 ad 8 / 해외 main 22 / 해외 ad 8 (기본 60건)
         · 각 버킷 안에서 소스별 라운드로빈 + 40% 과거 백필 예약
      ⑤ AI 보강 — 실제 플랫폼 여부·45개 분야·한국어 소개문 판정
      ⑥ main 고신뢰 후보만 lifecycle=review 자동등재, ad는 점수와 관계없이 일반 제보 검수 큐
  └ 관리 콘솔 "자동 등재 사후 검수" → URL·분야·소개문 확인 후 확정/내리기
```

- main은 기술·산업 편집/커뮤니티 소스, ad는 Product Hunt·BetaList·국내 스타트업/출시 홍보형 매체·출시 검색 소스다. 같은 후보가 양쪽에 잡히면 전역 중복 제거에서 main을 보존한다.
- 자동등재 서버 RPC가 스위치·수집 봇·`collection_pool=main`·국가 일치·신뢰도·중복·분야를 다시 검증한다(0043).
- 검수 큐 10칸도 국내 main 4 / 국내 ad 1 / 해외 main 4 / 해외 ad 1로 분리하며, 기존 pending 점유량을 버킷별로 먼저 차감한다.
- HN 전체/과거와 GitHub 광역 검색은 `ANTHROPIC_API_KEY`의 실제 플랫폼+분야 판정을 통과해야만 자동등재된다. AI가 없거나 실패하면 신뢰도 79 이하로 제한한다.
- GitHub 후보는 공식 Search API 결과 중 별도 제품 홈페이지가 있는 저장소만 사용한다. 코드·패키지·동영상·앱스토어·Product Hunt 링크는 직접 URL로 인정하지 않는다.
- 과거 백필은 `GITHUB_RUN_NUMBER`를 슬롯으로 사용해 HN 약 5년(30일 창), GitHub 약 5년(90일 창)을 순환한다.
- 소스 실패가 전체의 20% 이상이면 `ops-alert` 이슈를 만든다.
- 2026-07-22 분리 전 운영 DB 읽기 전용 기준선: 외부 항목 885건 수집 → 기존 플랫폼 중복 제거 후 후보 상한 60건 충족, 기존 플랫폼 소식 30건 매칭.

## 2. 운영 설정

필수 Secrets:

| 이름 | 용도 |
|---|---|
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` | 운영 DB·Auth 접속 |
| `BOT_EMAIL` / `BOT_PASSWORD` | 최소 권한 수집 봇 로그인 |

선택 보강:

| 이름 | 용도 |
|---|---|
| `ANTHROPIC_API_KEY` | 광역 검색 안전 게이트·분류·한국어 소개문. 운영 설정 완료 |
| `PH_TOKEN` | Product Hunt 실사이트 URL 해석. 유무와 관계없이 ad 풀·검수 큐 전용 |
| `ADMIN_BOT_EMAIL` / `ADMIN_BOT_PASSWORD` | 기존 플랫폼 소식 연결 |

`GITHUB_TOKEN`은 Actions 기본 토큰을 사용하므로 별도 Secret이 필요 없다.

수동 실행 입력:

- `max_per_run`: 1~100, 기본 60
- `backfill_slot`: 특정 과거 구간 재수집 시 지정. 비우면 실행 번호로 자동 순환

선택 환경변수 `COLLECT_DOMESTIC_SHARE`(기본 0.5), `COLLECT_AD_SHARE`(기본 0.25)로 비율을 조정할 수 있다. 어떤 값에서도 버킷 간 잔여 예산은 재분배하지 않는다.

## 3. 검수 요령

- 자동등재 항목은 이미 공개 상태다. URL이 실제 서비스인지, 분야와 소개문이 맞는지 확인한다.
- 정상: **확정(검증)** → `verified=true`, `lifecycle=verified`.
- 오등재·템플릿·블로그·중복: **내리기** → `lifecycle=rejected`, 공개 제외.
- 일반 제보 큐의 뉴스·디렉토리 링크는 공식 서비스 URL로 교체한 뒤 승인한다.
- 자동등재 정확도와 소스별 반려율이 쌓이기 전까지 임계값 80은 낮추지 않는다.

## 4. 로컬 검증

```powershell
node backend/collect/collect.mjs --dry --fixture backend/collect/fixtures
node --test backend/collect/pool-selection.test.mjs
node backend/collect/collect.mjs --dry
$env:COLLECT_MAX_PER_RUN=100; $env:COLLECT_BACKFILL_SLOT=0; node backend/collect/collect.mjs --dry
```

`--dry`는 외부 소스를 읽지만 DB에는 쓰지 않고 AI 비용도 발생시키지 않는다.

## 5. 소스 정책

- 공식 API·RSS를 우선하고 공개 API가 없는 디렉토리의 무단 스크래핑은 추가하지 않는다.
- 새 소스에는 `region`과 `pool`을 함께 지정한다. `pool` 생략은 main으로 간주되므로 홍보·출시형 소스는 반드시 `pool: "ad"`를 명시한다.
- Product Hunt API 문서는 상업적 사용을 금지하고 별도 문의를 요구한다. 기존 6토픽 이상으로 확대하기 전 사용 허가를 확인하고, 미확인 상태에서는 RSS 폴백을 유지한다.
- 다음 확장은 소스 개수보다 실제 반려율을 기준으로 결정한다. 후보량이 아니라 검증 통과 플랫폼 수가 핵심 지표다.
