# 세모플 백엔드 계획 (v1)

> 기준 문서: `redesign/handoff/API Spec.md` (프론트-백엔드 계약 v0.9)
> 원칙: **정적 프론트(GitHub Pages) 유지 + 서버리스 백엔드**. 앱은 `app/src/lib/api.ts` 한 곳으로만 데이터에 접근하며,
> 환경변수만 넣으면 로컬(JSON) → 원격(백엔드)으로 전환된다. 백엔드가 죽어도 디렉토리 발견 기능은 로컬 데이터로 동작(폴백).

## 1. 스택 결정

| 선택 | 이유 |
|---|---|
| **Supabase (Postgres + Auth + RLS + PostgREST + Edge Functions)** | 정적 호스팅과 궁합 최적(서버 상시 운영 불필요), 무료 티어로 시작, Postgres라 아래 전체 스키마·상태머신·감사로그를 그대로 표현, Row Level Security로 역할(user/operator/admin) 접근 제어를 DB 계층에서 강제 |
| 대안(비교) | Cloudflare Workers+D1: 저렴하지만 Auth·RLS 직접 구현 필요 / 자체 서버(NestJS 등): 운영 부담이 현 단계 과잉 |

- 읽기(공개 데이터)는 **PostgREST 직접 호출**(익명 키 + RLS), 쓰기·복잡 로직(추천 스코어링, 부스트 견적, 라이프사이클 전이)은 **Postgres 함수(RPC)** 로 노출.
- API Spec의 `/api/v1/...` REST 경로가 꼭 필요해지면(외부 공개 API 등) Edge Function으로 동일 계약을 씌운다 — 스키마는 그대로.

## 2. DB 설계 원칙 (미래 기능 선반영)

1. **모든 로드맵 기능의 테이블을 지금 확정** — 제보 검수, 라이프사이클 상태머신+감사로그, 즐겨찾기 컬렉션(관심/검토중/입점예정), 운영자 소유권 클레임, 제휴 제안, 거래소 매물·관심, 부스트 상품·주문, 이벤트 분석(노출/클릭/검색). 프론트가 단계적으로 켜도 스키마 마이그레이션 없이 진행.
2. **enum은 영문 코드, 라벨은 프론트에서** — `fee_band('low','mid','high')` 등. 한국어 라벨 변경이 DB 마이그레이션이 되지 않게.
3. **플랫폼 리치 필드는 nullable로 지금 추가** — `fee_band, fee_text, settle_text, enter_text, strength, pros[], cons[], year, logo_url`. 현재 1,559개 데이터에 없어도 자리 확보(핸드오프 상세/비교 화면이 요구).
4. **파괴적 삭제 금지** — 플랫폼은 `lifecycle='rejected'`+`archived_at`로 숨김. 감사로그가 이력 보존.
5. **분석은 append-only 이벤트 테이블** 하나로 시작(노출·클릭·검색·즐겨찾기·아웃바운드). 집계는 뷰/머티리얼라이즈드 뷰. 트래픽 커지면 파티셔닝.
6. **RLS가 권한의 원천** — admin 판별은 `profiles.role`. 클라이언트 코드는 신뢰하지 않는다.

## 3. 파일

| 파일 | 내용 |
|---|---|
| `migrations/0001_schema.sql` | 전체 스키마(enum·테이블·인덱스·트리거·상태머신 검증·뷰) |
| `migrations/0002_policies.sql` | RLS 정책 + 역할 헬퍼 함수 |
| `migrations/0003_seed.sql` | 현행 데이터 시드(그룹 5·분야 35·플랫폼 1,559 + 제휴 유형·부스트 상품·데모 매물) — `seed/build-seed.mjs`가 생성 |
| `migrations/0004_open.sql` | **2·3단계 오픈**: 제휴 보드(partner_posts+interests), 매각 접수(deal_submissions), admin 매물 게시 정책, 익명 공개 뷰 — **이미 0001~0003을 실행한 DB는 이 파일만 추가 실행** |
| `migrations/ALL.sql` | **0001~0004 합본** — 새 DB에 한 번에 붙여넣고 Run 하는 용도(아래 절차 2번) |
| `seed/build-seed.mjs` | `app/src/data/*.json` → 시드 SQL 생성기(데이터 갱신 시 재실행) |

> **검증 완료**: 세 마이그레이션(및 합본 `ALL.sql`)을 로컬 Postgres 16에서 실제 실행해 무오류를 확인했다.
> anon(비로그인) 역할로 접근 시 공개 데이터(플랫폼 1,559·분야 35·제휴유형·플랜·`v_stats`·`v_deals_public`)는
> 읽히고, 민감 테이블(`deals` 원본·`favorites`·`charges`·`buyer_briefs`·`proposals`)은 **전부 0건(RLS 차단)** 임을 확인.
> 검증 중 발견한 **거래소 익명성 누수**(anon이 `deals` 원본에서 `owner_id`로 매도자 역추적 가능)를
> 수정함 — 원본은 소유자/admin만 읽고 공개는 익명 뷰 `v_deals_public`로만 나간다.

## 4. 적용 절차 (님이 하는 것 — 약 10분)

**A. Supabase 프로젝트 만들기** *(계정·결제는 본인만 가능 — 대행 불가)*
1. [supabase.com](https://supabase.com) 가입 → **New Project**
   - Region: **Northeast Asia (Seoul)** 권장 · Database Password는 안전하게 보관
   - 무료 티어로 충분(초기)

**B. DB 켜기 — SQL 한 번 실행**
2. 좌측 **SQL Editor** → New query → `backend/migrations/ALL.sql` 내용을 통째로 붙여넣고 **Run**
   - (또는 `0001_schema.sql` → `0002_policies.sql` → `0003_seed.sql`을 순서대로 실행해도 동일)
   - `auth.users`·`auth.uid()`는 Supabase가 기본 제공 → 별도 준비 불필요
   - 성공하면 Table Editor에 `platforms`(1,559행) 등이 보인다

**C. 로그인 활성화**
3. **Authentication → Providers**에서 이메일(또는 카카오/구글 OAuth) 활성화
   - 지금은 발견 기능만 켤 거면 이 단계는 나중에 해도 됨(공개 읽기는 로그인 불필요)

**D. 키 복사**
4. **Project Settings → API**에서 두 값 복사:
   - `Project URL` (예: `https://xxxx.supabase.co`)
   - `anon` `public` 키 (`eyJ...` — **anon 키만**, `service_role` 키는 절대 쓰지 말 것)

**E. 프론트에 연결 — `app/.env.production`** *(이미 배선됨 · 기본 방식)*
5. 연결값은 **`app/.env.production`** 에 커밋해 둔다(anon 키는 공개 키라 안전 — §아래 박스):
   ```
   VITE_SUPABASE_URL=https://xxxx.supabase.co
   VITE_SUPABASE_ANON_KEY=eyJ...
   ```
   - Vite가 빌드 시 이 파일을 읽어 번들에 넣는다(코드 수정 불필요). 파일이 없으면 **로컬 JSON 모드**.
   - **본인 프로젝트로 바꾸려면** 이 두 값을 본인 것으로 교체 후 커밋하면 된다.
6. `master`에 push(또는 Actions에서 **Run workflow**) → 배포 워크플로우가 빌드·게시 → 앱이 원격 모드로 전환
   - 확인: 브라우저 콘솔에 API 호출(`/rest/v1/platforms...`)이 보이면 연결 성공. 실패 시 자동 로컬 폴백.

> **대안 — 키를 git에 두기 싫으면 GitHub Secrets 사용**: `app/.env.production`을 삭제하고,
> 저장소 **Settings → Secrets and variables → Actions**에 `VITE_SUPABASE_URL`·`VITE_SUPABASE_ANON_KEY`를
> 등록한 뒤 `.github/workflows/pages.yml` 빌드 스텝의 주석 처리된 `env:` 블록을 활성화한다.
> (두 방식은 **택일** — `.env.production`이 있으면 빈 Secrets가 이를 덮어써 깨지므로 동시에 쓰지 말 것.)

**F. 나를 관리자로 지정** *(로그인 1회 후)*
7. 앱에서 한 번 로그인 → SQL Editor에서:
   ```sql
   update public.profiles set role='admin'
   where id = (select id from auth.users where email = '<내 이메일>');
   ```
   - 이후 제보 검수·라이프사이클·부스트 관리 등 admin 기능이 열린다

> **anon 키를 정적 번들에 넣어도 안전한 이유**: anon 키는 설계상 공개 키다. 실제 접근 권한은
> 전적으로 RLS(§6)가 DB 계층에서 강제하며, 위 검증에서 anon이 민감 데이터에 닿지 못함을 확인했다.
> 반대로 `service_role` 키는 RLS를 우회하므로 프론트·워크플로우·저장소 어디에도 두면 안 된다.

## 5. 단계별 로드맵 (프론트 연동 순서)

| 단계 | 켜는 것 | 필요한 것 |
|---|---|---|
| **P1 읽기 전환** | 디렉토리·검색·상세를 DB에서 읽기(선택적 — 로컬 폴백 유지) | 시드 완료 |
| **P2 참여** | 로그인, 즐겨찾기 서버 동기화(컬렉션·메모·알림), 플랫폼 제보 폼 → `submissions` | Auth 활성화 |
| **P3 운영** | 관리자 검수 큐·라이프사이클 칸반(감사로그), 데이터 품질 대시보드 | admin 지정 |
| **P4 수익화** | 운영자 클레임 → 콘솔(프로필 편집·지표), 제휴 제안(stage2 정식 오픈), 부스트 주문 | 도메인 이메일 인증(Edge Function 1개) |
| **P5 분석** | 이벤트 수집(노출/클릭/검색) → 인기 검색어·운영자 지표·부스트 정산 근거 | 없음(익명 insert 허용) |

## 6. 보안·법적 설계 반영

- **자금 미보유 원칙**: `boost_orders`는 주문·집행 기록만(결제는 외부 링크/수동 정산으로 시작). `deals`는 익명 코드명만 저장, 연락처 컬럼 자체가 없음(상호 동의 후 별도 채널) — 기획서 §10·§12 준수.
- **개인정보 최소화**: `submissions.payload`에 연락처 금지(프론트 안내 + 검수 체크리스트). `profiles`는 auth 최소 필드만.
- **명예훼손 방지**: 플랫폼 `pros/cons`는 admin만 쓰기(RLS) — 근거 검수 후 게시.
