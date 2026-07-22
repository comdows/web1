# 세모플(Semopl) 제품 기획서

작성: 2026-07 · 용도: **내부 개발 지침** · 짝 문서: `business-plan.md`(사업), `dev-roadmap-v3.md`(개발 계획)
기준: 마이그레이션 0001~0043 배포 완료
운영 상태 기준: `dev-roadmap-v3.md` §0(단일 원천, 2026-07-22)

---

## 1. 아키텍처 요점

- **SPA + 프리렌더 이중 소스**: 런타임은 React(Vite+TS) SPA. 빌드 시 `app/scripts/prerender.mjs`(ko) + `prerender-en.mjs`(en)가 상세 1,719p 정적 HTML + sitemap + robots + feed + llms.txt를 생성한다. 진입 시 `/p/<id>`·`/c/<분야>`·`/news/`·`/guide/<slug>` 정적 경로를 `App.tsx`가 해당 뷰로 흡수한다(크롤러는 정적 본문, 사람은 같은 URL에서 SPA 부팅).
- **RLS-only 보안**: anon(공개) 키만 사용. `service_role`/`sb_secret` 절대 커밋 금지(anon 키는 공개 키라 안전). 권한의 단일 원천은 DB의 RLS(`profiles.role`로 admin 판별). 클라이언트 코드는 신뢰하지 않는다.
- **정적/원격 이중 데이터(폴백)**: 앱은 `app/src/lib/api.ts` rest() 한 지점으로만 접근. 원격(Supabase) 로드 성공 시 정적 시드를 교체하고, 실패하면 로컬 `platforms.json`으로 자동 폴백 → 백엔드가 죽어도 발견 기능은 동작.
- **무료 인프라**: GitHub Pages(호스팅) + Actions(CI/배포/cron). 워크플로 — pages(배포) · collect-candidates(주3회) · sync-seed(수동) · metrics-weekly(주간) · healthcheck(월간) · backup(주간 gpg 암호화, service key 미사용). 이 이중 소스 구조는 "무료 인프라·SEO 근간"으로 동결.
- **CI 게이트**: 배치마다 리셋 → 구현 → PG16(해당 시) → Playwright → 커밋 → PR → CI → squash → Pages. EN 커버리지 어서션이 방화벽으로 빌드를 실패시킨다.
- **EN 방화벽**: `/en/`는 완전 정적(SPA 미부팅) = 제휴·거래소 법적 방화벽. 수수료·정산 영문 게재 금지.

---

## 2. 화면 인벤토리 (25 ViewName)

출처: `app/src/nav.tsx`(타입), `App.tsx`(라우팅·타이틀).

| ViewName | 역할 |
|---|---|
| `home` | 분야별 홈 — 히어로 검색, 인기/추천, 로그인 시 개인화(저장검색·관심분야 가이드) |
| `search` | 검색 결과(분야 필터·인기순 정렬). 프리렌더 `/c/<분야>` 랜딩 |
| `detail` | 플랫폼 상세(판단 팩트·후기·Q&A·정정·운영자 인증). 프리렌더 `/p/<id>` 랜딩 |
| `compare` | 플랫폼 비교(최대 4, `?ids=` URL 공유·복원) |
| `favorites` | 즐겨찾기(관심/검토중/입점예정 컬렉션) |
| `onboarding` | 맞춤 추천(관심 선택 온보딩) |
| `partners` | 제휴 매칭 보드 |
| `exchange` | 거래소(양수도 익명 리스팅) |
| `deal` | 매물 상세 |
| `deal-guide` | 양수도 가이드 |
| `value-check` | 가치 자가 진단(특허 발명 4 실시예 — 단말 내 연산·미저장) |
| `ai-finder` | AI 도구 찾기(요금형태 필터) |
| `weekly` | 새로 나온 플랫폼·AI 아카이브 |
| `packs` | 업종별 시작 조합 |
| `news` | 소식·트렌드. 프리렌더 `/news/` 랜딩 |
| `guide` | 편집 가이드 콘텐츠. 프리렌더 `/guide/<slug>` 랜딩 |
| `account` | 계정/내 활동(저장검색·브리프·매칭 배너·운영자 섹션·게시글 수명) |
| `submit` | 플랫폼 제보 폼 |
| `admin` | 관리 콘솔(검수·소개·신고·리뷰·공지 발행·성장 패널) |
| `notifications` | 알림 센터 |
| `support` | 문의·도움말 |
| `help` | 도움말 허브(가이드 투어 딥링크) |
| `optout` | 이메일 수신거부(정보통신망법 §50) |
| `terms` / `privacy` | 이용약관 / 개인정보처리방침 |

---

## 3. 기능 인벤토리 (0001~0043, 기능군별)

| 기능군 | 내용 (근거 마이그레이션) |
|---|---|
| **기반** | 스키마·enum·상태머신·인덱스(0001) / RLS 4역할(0002) / 시드 1,719(0003) / 데이터 정정(0007) |
| **발견·검색** | 인기 집계 뷰 `v_platform_popularity`(0019) / 링크 신선도 배지(0020) / 판단필드 1,637행(0014)+2차 25건(0035 운영 반영) |
| **제휴** | 매칭 보드 `partner_posts`+interests(0004) / 아웃리치 제안·수신거부·게이트, 서버발송 off(0015) |
| **거래소** | 매각접수+익명뷰 `v_deals_public`(0004) / 소개 상태머신·쌍방동의(0005) / 자기신청 차단(0013) / 성사·후기 회수(0021) / 신뢰 배지·증빙태그·익명 Q&A(0022) |
| **AI 도구** | 시드 163개(0006+0029) / 요금형태 축 `ai_pricing`(0032, 금액 미게재) |
| **계정·개인화** | 자기결정권·상한·연락처패턴(0009) / 저장검색+알림(0030) / 관심 프로필 서버화(0031) / 브리프 지역선호(0033) |
| **알림·리텐션** | 인앱 알림 `notifications`(0018) / 이메일 레이어 게이트 off(0024) |
| **리뷰** | 후기+평점(표시전용, 랭킹 미반영)(0025) / 운영자 답글(0040) |
| **운영자** | 대시보드 30일 집계 RPC·받은제안(0023) |
| **관리자·운영** | 운영통지·90일 purge(0010) / RLS 하드닝(0008·0012·0037) / 신고·모더레이션·문의·정지(0028) / 헬퍼 grant 재부여(0036 운영 반영) |
| **수집** | 자동등재 **on**, 임계값 80·사후 검수(0016) / 국가×main/ad 독립 예산·ad 수동검수 전용·서버 경계 운영 반영(0043) / 26소스·HN/GitHub 5년 순환 백필 / 광역 검색 AI 안전 게이트 / 소식 피드(0027) / sync-seed·healthcheck |
| **계측** | 유입경로·퍼널 뷰(0017) / 성장 스냅샷·주간 운영(0034, Phase 1 완료) / 인덱스(0038) / 오류수집 운영 반영(0039) |
| **과금** | 제휴 3상품(0011) / 거래소 리스팅·멤버십·크레딧, 스위치 off(0026) |
| **최근 슬라이스** | 관리자 공지 발행·소식 추가(R2) / 게시글 수명(0041) / 플랫폼 Q&A(0042) / 국가별 수집 풀 서버 경계(0043) |

---

## 4. 데이터·권한 모델

- **4역할**: anon / user / operator / admin. `operator`는 `profiles.role`이 아니라 `platform_operators` 조인으로 판별한다(role='operator'는 어디서도 부여되지 않음 — dead branch).
- **공개는 익명 definer 뷰로만**: `v_deals_public`·`v_reviews_public`·`v_platform_questions_public`·`v_partner_posts_public`에 작성자 식별자 컬럼이 없다(익명성이 법적 전제).
- **SECURITY DEFINER RPC 패턴**: 쓰기 자격이 admin의 status 갱신과 얽히는 경우, UPDATE 정책+컬럼 grant 대신 RPC로 자격(본인·인증 운영자·published 등)을 함수 안에서 강제한다 — `operator_reply_review`·`operator_answer_platform_question`·`refresh_my_partner_post`·`refresh_my_deal`·`close_my_deal`·`close_my_post`.
- **이중 방어**: 연락처 차단·접수 상한을 클라(`lib/anonymity.ts` CONTACT_RE + `my_pending_count`)와 DB(CHECK·RLS) 양쪽에서 강제. 한쪽만 고치면 안 됨.
- **회귀 하네스 3층**: vitest 골든(anonymity·session·valuation, CI 게이트) / Playwright 스모크(route 37·feature 52·adversarial 6) / PG16 rls-scenarios 10.

---

## 5. 특허 4건 실시예 매핑

2026-07-03 머지 공개 → **공지예외 12개월 시한(2027-07) 내 출원 필요**. 모두 발명 설명서 초안 단계(변리사 선행조사·출원 전).

| # | 발명 | 실시예 |
|---|---|---|
| 1 | 디렉토리 사전 기반 익명 게시물 식별정보 누출 자동검증(2계층 판정·2단 제출·검수 하이라이트·서버 이중화) | `app/src/lib/anonymity.ts`, `pages.tsx` SellForm, `admin.tsx` DealSubQueue, 0005 chk_*_nocontact |
| 2 | 쌍방 동의 상태머신 기반 단계적 연락처 공개(2단 소개) | 0004/0005, `admin.tsx` IntroQueue |
| 3 | 익명 리스팅↔조건 프로파일 자동 대조·인앱 통지(대조를 클라이언트에서 수행 — 개인정보 최소화) | `lib/api.ts` briefMatchesDeal, `v_deals_public` |
| 4 | 범주형 밴드 기반 비식별 가치구간 추정(밴드입력→밴드출력·단말 내 연산·미저장·게시 분리) | `app/src/lib/valuation.ts`, `?view=value-check` |

발명 4는 **법적 조건이자 청구항 구성요소** — 가치 진단은 밴드 입력→밴드 출력·미저장을 유지해야 한다(가격 필드 매물 추가 금지와 짝).

---

## 6. 미착수·운영 게이트 (개발 백로그 소스)

**운영 DB 상태**
- 0001~0043 운영 반영 완료. 대기 중 사용자 SQL 없음.
- `0043_collect_pool_isolation.sql` 적용 완료: 광고 풀 및 국가 불일치 payload를 자동등재 RPC가 서버에서 거절한다.
- 2026-07-22 읽기 전용 재검증: 0035 대상 데이터 25/25건 일치, 0039 `event_t.error` 인식 확인.
- 0034 주간 스냅샷은 [2026-07-20 실행](https://github.com/comdows/semopl/actions/runs/29717870523) 성공(세션 1·WAU 1·검색 0·외부방문 4).

**게이트 off** (코드·스위치 준비됨, 이중 게이트)
- **알림 이메일 레이어**(0024) — `app_settings 'notify_email'` 기본 `enabled:false`. 켜기: Resend 등 계정 + SPF/DKIM/DMARC + Edge Function 배포 + 정보통신망법 §50 수신거부(`?view=optout`) + true.
- **제휴 서버 발송**(0015) — 현재 회원 본인 메일로 발송. `app_settings 'outreach'.server_send:true` + `config.ts FLAGS.outreach:true` 둘 다 필요.
- **수익화 스위치** — 제휴 3상품·거래소 리스팅/멤버십/buyer_early 기본 false. 서버(`app_settings 'billing'`) + 프론트(`FLAGS.billing`) 둘 다 켜야 열림. 도달: 통신판매업 신고 등 컴플라이언스 완료 후.
- **Google 로그인** — `config.ts googleAuth:false`.

**게이트 on — 즉시 운영 확인**
- **자동 등재**(0016) — 2026-07-22 활성 유지 결정. `app_settings 'autolist'`는 `enabled:true`, `min_confidence:80`. [2026-07-21 실행](https://github.com/comdows/semopl/actions/runs/29874744086)에서 23건 자동등재, 현재 44건이 공개 `lifecycle=review` 상태로 사후 검수 대기. 관리 콘솔에서 URL·분야·소개문을 확인한 뒤 검증 승격 또는 공개 제외한다.

**부분 미구현·트리거 대기**
- Phase 2 실제 도메인 전환, Phase 4 나머지 38개 분야 콘텐츠, Phase 5 유동성 트랙.
- L2 크라우드펀딩 전용 판단필드·비교표, L3 운영자 소식 등록·응답률 통계.
- L6 특허는 설명서 초안 단계이며 2027-07 전에 출원 필요.

**미설정(선택) 인프라**: PH_TOKEN·ANTHROPIC_API_KEY(없으면 폴백) · GSC·Bing·네이버 등록(유입 선행) · 커스텀 도메인·이메일 발송 인프라.

---

## 부록 — 설계 원칙 요약(코드 리뷰 체크리스트)

거래소 자산·사업 양수도만(지분 3중 가드 유지) · 성공보수·거래액 연동 금지 · 가격·밸류에이션 필드 매물 추가 금지 · 연락처 클라+DB 이중 차단 · 공개 뷰 작성자 비노출 · 디렉토리 중립(유료·광고 개입 없음) · EN 방화벽 · RLS-only·anon 키 · service_role 커밋 금지.
