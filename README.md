# 세모플 (SEMOPL) — 세상의 모든 플랫폼

> 사업자용 B2B 인프라: **발견**(플랫폼·AI 도구 디렉토리 1,637개) → **제휴**(매칭 보드) → **거래**(자산·사업 양수도 익명 리스팅).
> 라이브: https://comdows.github.io/web1/ · 스택: React(Vite+TS) SPA + Supabase(PostgREST/RLS) + GitHub Pages/Actions
> 커스텀 도메인 전환: 주소는 `app/site.config.mjs` 단일 설정 — 구매 후 `node scripts/switch-domain.mjs <도메인>` 1회 + [domain-setup.md](domain-setup.md) 절차

## 구조

```
app/                 프론트엔드 (Vite + React + TS)
  src/data/          단일 데이터 소스(platforms.json — 6그룹·45분야·1,637개)
  scripts/prerender.mjs   빌드 시 상세 1,637p 정적 생성 + sitemap + robots (SEO)
backend/
  migrations/        0001 스키마 → 0002 RLS → 0003 시드 → 0004 오픈 → 0005 소개·동의 → 0006 AI (ALL.sql = 전체)
  seed/build-seed.mjs     platforms.json → 0003 재생성 (데이터 변경 시 실행)
  collect/collect.mjs     주간 신규 수집기(5소스·스마트 중복제거) → 제보 검수 큐(기본) / 고신뢰 자동 등재(스위치 on 시)
  collect/healthcheck.mjs 월간 URL 생존 점검 → GitHub 이슈 리포트
.github/workflows/   pages(배포) · collect-candidates(주간) · healthcheck(월간)
```

**영문 레이어(/en/)**: 외국 사업자용 한국 진출 디렉토리 — commerce·trade 604건+분야 허브 14+가이드 3, 완전 정적(SPA 미부팅 = 제휴·거래소 법적 방화벽). 신규 플랫폼 승인 시 `app/src/data/platforms.en.json`에 영문 항목 추가(미번역분은 EN 미노출·빌드는 통과).

주요 화면: 분야별 홈 · 검색 · 비교 · 맞춤 추천 · AI 도구 찾기(`?view=ai-finder`) · 업종별 시작 조합(`?view=packs`) ·
새로 나온 것(`?view=weekly`) · 제휴(`?view=partners`) · 거래소(`?view=exchange`) · 가치 자가 진단(`?view=value-check`) ·
양수도 가이드(`?view=deal-guide`) · 계정/관리 콘솔 · 약관/방침

## 운영 루틴 (1인 기준)

| 주기 | 할 일 | 어디서 |
|---|---|---|
| 주 1회(월) | 자동 수집 후보 검수 — 🤖 배지 확인, 이름·분야 다듬고 승인/반려 | 관리 콘솔 → 제보 검수 큐 |
| 수시 | 제휴 제안·매물 검수(익명성 점검 하이라이트 참고), 운영자 인증 승인 | 관리 콘솔 |
| 수시 | 소개 이행 — 거래소는 ①매도자 확인 → ②소개 초안 → 소개 완료 순서 | 관리 콘솔 → 소개 대기 |
| 월 1회 | 헬스체크 이슈 확인 — 접속 불가 링크 정정/보관 | GitHub Issues (`healthcheck` 라벨) |
| 수시 | EN 인바운드 문의 트리아지 — 지분·펀딩은 즉시 종료, 유효 건만 소개 검토. **국외 상대 소개는 한국 측 의사확인 메일에 상대 국가를 명시하고 회신 동의를 받은 뒤에만 진행**(처리방침 §3) | GitHub Issues (`en-inbound` 라벨) |

### 백업·복원 (backup.yml — 주간 자동)

- 매주 월 04:00 KST, admin 봇(RLS)으로 사용자 생성 데이터 11개 테이블을 JSON 스냅샷 → gpg 암호화 → Actions 아티팩트(90일 보관). service key는 쓰지 않는다.
- **복원**: Actions → 해당 run → `db-backup-*` 아티팩트 다운로드 → `gpg -d backup-*.json.gpg > b.json` (BACKUP_PASSPHRASE) → 테이블별로 Supabase SQL Editor/PostgREST upsert. 순서: profiles → platforms → 나머지(FK 순).
- 백업 실패 시 GitHub 실패 메일이 온다 — **실패 메일은 반드시 확인**(부분 성공 없음, fail-loud 설계).

## 원칙 (바꾸면 안 되는 것)

1. **성공보수·거래액 연동 과금 금지** — 정액 이용료만 (pricing-policy.md)
2. **거래소는 자산·사업 양수도만** — 지분·투자유치는 게시·소개 없이 자문 안내 분기 (약관 §1)
3. **자금 미보유** — 대금이 세모플 계좌를 스치지 않는다
4. **디렉토리 비판매** — 검색·비교·순위에 유료 개입 없음, 유료 노출은 보드 한정+AD 표기
5. **개인정보 최소** — 연락처는 게시물에 금지(클라이언트+DB 이중 차단), 소개는 쌍방 동의 후에만
6. **service_role/sb_secret 키 절대 커밋·노출 금지** — anon 키만 사용(공개 키)

## 설정 상태 / 대기 항목

- [x] Supabase 마이그레이션 **0001~0011 전체 실행 완료(2026-07-05)** — 신규 SQL은 `backend/migrations/`에 추가 후 SQL Editor에서 실행
- [x] `0012_billing_hardening.sql` 실행 완료(2026-07-05 — 종합 QA 수정)
- [x] **`0013_qa3.sql` 실행 완료**(3차 QA — 본인 게시물 자기 신청 RLS 차단. 실행 전에도 클라이언트 가드로 버튼은 숨겨짐)
- [x] **`0014_judgment_seed.sql` 실행 완료**(판단 필드 시드 — 수수료대·정산·입점조건·강점 1,637행 UPDATE. 정적 빌드엔 이미 반영, 원격 DB 반영용)
- [x] **`0015_outreach.sql` 실행 완료**(제휴 제안 아웃리치 — 발송 기록·수신거부·게이트. 실행 후에도 서버 발송은 off, 회원 본인 메일로 발송)
- [x] **`0016_autolist.sql` 실행 완료**(자동 수집 고신뢰 자동 등재 + 사후 검수 — `auto_listed` 컬럼·`auto_list_candidate`/`review_auto_listed` RPC·`app_settings 'autolist'`. **스위치 기본 off** → 실행해도 수집기는 전부 검수 큐로. 자동 수집 소스 확장(벤처스퀘어·스타트업레시피)과 스마트 중복제거(호스트 정규화·이름 퍼지)는 이 마이그레이션 없이도 동작)
- [ ] (선택) **자동 등재 켜기**(수집 신뢰도를 몇 주 지켜본 뒤에만 — "자동 등재 없음" 원칙을 부분 개방):
  ① 검수 큐의 🤖 자동 수집 카드 신뢰도 배지를 관찰(고신뢰=80↑가 실제로 정확한지 확인)
  ② `app_settings 'autolist'` → `{"enabled": true, "min_confidence": 80, "collector_id": "<봇 계정 uid>"}` (uid는 `select id from profiles where display_name...` 또는 auth.users에서 확인)
  ③ 이후 수집기는 directUrl 소스(HN 등) + 분야추정 + 신뢰도≥80만 lifecycle=review로 자동 등재 → 관리 콘솔 "🤖 자동 등재 사후 검수"에서 확정/내리기 스팟체크(국내 뉴스는 기사 URL이라 자동 등재 대상 아님 → 일괄 승인으로)
- [x] **`0017_measurement.sql` 실행 완료**(계측 보강 — `events.ref`(유입경로) 컬럼 + 퍼널·유입 admin 뷰 `v_funnel_7d`/`v_referrers_7d`. 멱등. 실행 후 방문이 쌓이면 관리 콘솔 "퍼널·유입" 패널에 노출→클릭→외부방문 전환율·유입경로가 채워짐)
- [x] **`0018_notifications.sql` 실행 완료**(인앱 알림 — `notifications` 테이블 + RLS(본인만 열람·읽음, 생성은 admin 봇). 멱등. 실행 후 `match-notify` 워크플로가 ①인수 브리프↔신규 매물 ②관심 분야(즐겨찾기 유도) 신규 플랫폼 알림을 넣고, 헬스체크는 관심 플랫폼 죽은 링크를 알림 → 회원 헤더 🔔에 표시. 기존 `ADMIN_BOT_*` Secrets 재사용 — 추가 설정 불필요)
- [ ] **`backend/migrations/0030_saved_searches.sql` 실행**(저장된 검색 + 조건 알림 — `saved_searches` 테이블(본인 CRUD·admin 조회, 사용자당 20). 멱등. 실행 후 검색 결과 화면 "🔔 이 조건 저장" → 계정 "내 저장 검색" 관리, 주간 `match-notify`가 조건에 맞는 신규 플랫폼을 `search_match` 인앱 알림으로 발송. 기존 `ADMIN_BOT_*` Secrets 재사용 — 추가 설정 불필요. 실행 전에도 사이트 정상(저장 버튼만 접수 실패 안내))
- [x] **`backend/migrations/0029_ai_expand.sql` 실행 완료(2026-07-11)**(AI 도구 확장 — 82종 추가로 80→163개, AI스튜디오스 분야 이동(assets→영상 AI). 멱등. 라이브 반영됨 — URL은 월간 헬스체크가 검증)
- [x] **`backend/migrations/0028_ops_moderation.sql` 실행 완료(2026-07-11)**(실운용 준비 — ①신고 `reports`(회원 신고→콘솔 🚩 신고 큐) ②인앱 문의 `inquiries`(문의·도움말 페이지→📬 문의 큐) ③회원 정지 `suspended_at`+`admin_set_suspended`(쓰기만 차단) ④리뷰 본인 삭제 정책 ⑤리뷰·질문·관심 사용자당 상한 ⑥알림 보존 정리 `purge_old_notifications`. 멱등. 실행됨 — 신고·문의 접수가 동작하고 주간 백업·다이제스트에 신설 테이블이 포함됩니다)
- [x] **`backend/migrations/0027_platform_news.sql` 실행 완료(2026-07-11)**(플랫폼 소식 피드 — `platform_news` 테이블(공개 read·admin insert). 멱등. 실행 후 주간 수집기가 국내 뉴스 중 기존 등재 플랫폼 관련 기사를 자동 연결 → 상세 "최근 소식" 섹션 + 즐겨찾기 회원 fav_news 알림. 소식 연결을 켜려면 collect-candidates 워크플로 Secrets에 `ADMIN_BOT_EMAIL`/`ADMIN_BOT_PASSWORD`가 필요한데 **저장소 Secrets에 이미 있어 추가 설정 불필요**(미설정이어도 후보 수집은 정상))
- [x] **`0026_billing_exchange.sql` 실행 완료(2026-07-10)**(수익화 v2 — 거래소 리스팅료·연장·인수자 멤버십·크레딧 충전을 place_order가 처리, 가격을 `app_settings 'prices'`로 단일화(변경 시 SQL 수정 불필요), 구독 플랜별 공존(uq_subs_active→user+plan), 만료 임박 뷰 `v_expiring_subs`(match-notify가 D-7 인앱 알림), buyer 48시간 선공개(스위치 off면 무효). 멱등. **실행해도 아무것도 켜지지 않음** — listing/buyer_membership/buyer_early 스위치 기본 false)
- [x] **`0025_reviews.sql` 실행 완료(2026-07-10)**(플랫폼 이용 후기 — `reviews` 테이블(1인 1리뷰·검수 후 게시·본인 수정은 재검수 강제 RLS) + 공개 뷰 `v_reviews_public`(익명)·평점 집계 `v_review_stats`(표시 전용 — 정렬 랭킹 미반영). 멱등. 실행 후 상세 "이용 후기" 섹션·카드 ★평점·관리 콘솔 "⭐ 리뷰 검수 큐"가 동작)
- [x] **`0024_notify_email.sql` 실행 완료(2026-07-10)**(알림 이메일 레이어 — `app_settings 'notify_email'`(기본 **enabled:false**) + `notify_email_log`(사용자당 하루 1통을 unique로 DB에서 강제). 멱등. **실행해도 아무것도 발송되지 않음** — 코드·스위치만 준비되고, 켜는 절차는 아래)
- [ ] (선택) **알림 이메일 켜기**(인앱 알림 요약을 하루 1통 이메일로 — 인프라·법적 준비 후에만):
  ① 이메일 발송 서비스 계정(Resend 등) + 발신 도메인 SPF/DKIM/DMARC 인증(아웃리치 발송과 동일 스택)
  ② `supabase functions deploy send-notify-email` + `supabase secrets set RESEND_API_KEY=... NOTIFY_EMAIL_FROM="세모플 알림 <notify@도메인>" CRON_SECRET=<임의 문자열>`
  ③ 정보통신망법 §50 대응: 수신거부 링크(`?view=optout` — 앱에 내장, outreach_optout 등록) 실동작 확인 + 처리방침에 알림 메일 항목 반영
  ④ `app_settings 'notify_email'` → `{"enabled": true, "daily_cap": 1, "from_name": "세모플 알림"}`
  ⑤ 스케줄: Supabase cron(대시보드 → Integrations → Cron) 또는 notify.yml 마지막에 `curl -X POST <함수URL> -H "x-cron-secret: $CRON_SECRET"` 스텝 추가 — 스위치 off면 호출돼도 skip(무해)
  발송 정책: 사용자당 하루 1통·최근 7일 미읽음만·본문은 "미읽음 N건" 요약뿐(알림 원문 비포함, 링크는 알림 센터)·수신거부 대조 후 제외
- [x] **`0019_popularity.sql` 실행 완료**(검색·추천 행동신호 — 공개 인기 집계 뷰 `v_platform_popularity`. 멱등. platform_id·score만 노출(개인 행동로그 비노출)·세션 distinct 집계. 실행 후 방문이 쌓이면 검색 "인기순" 정렬·관련도 2차 보정·추천이 자동 반영. 데이터 적을 땐 효과 미미)
- [x] **`0020_freshness.sql` 실행 완료**(링크 신선도 — `platforms.link_status`/`link_checked_at`. 멱등. 실행 후 월간 헬스체크가 링크 생존을 기록 → 카드/상세에 "⚠ 링크 확인"·"검증" 배지 노출. 죽은 링크 관심 등록자 알림은 기존 대로)
- [x] **`0021_intro_outcomes.sql` 실행 완료**(소개 후 성사·후기 — `intro_outcomes` 테이블 + RLS(본인만) + `v_intro_success` 관리 요약. 멱등. 실행 후 소개 완료된 매칭에 계정 "내 활동"에서 성사 응답을 받고 관리 콘솔에 성사율 표시)
- [x] **`0022_deal_trust.sql` 실행 완료(2026-07-10)**(거래소 신뢰 — `deals.owner_verified`(운영자 확인 ✓ 배지, 검증 자료 확인 후 관리 콘솔에서 토글)·`proofs`(준비 증빙 유무 태그 — 수치·가격 아님) + 매물 익명 Q&A `deal_questions`+공개 뷰(answered만·질문자 신원 컬럼 없음). 멱등. 실행 후 매각폼 증빙 체크·매물 카드 배지/Q&A·관리 콘솔 "💬 매물 질문 답변 큐"가 동작)
- [x] **`0023_operator_dash.sql` 실행 완료(2026-07-10)**(운영자 대시보드 — `operator_platform_stats` definer RPC(운영자 본인 플랫폼만·30일 노출/클릭/외부방문/즐겨찾기 집계값만, 개별 행동로그 비노출) + `outreach_proposals` 운영자 read 정책(내 플랫폼이 받은 제휴 제안 열람). 멱등. 실행 후 계정 페이지에 "내 플랫폼 (운영자)" 섹션이 동작 — 인증 운영자에게만 표시)
- [ ] (선택) **제휴 제안 서버 발송 켜기**(세모플이 대표 이메일로 직접 발송 — 법적·인프라 준비 후에만):
  ① 이메일 발송 서비스 계정(Resend 등) + 발신 도메인 SPF/DKIM/DMARC 인증
  ② `supabase functions deploy send-proposal` + `supabase secrets set RESEND_API_KEY=... EMAIL_FROM="세모플 제휴 <partner@도메인>"`
  ③ 정보통신망법 §50 대응: 수신거부 링크 실동작·광고성 정보 표기·대표 이메일 수집 근거, 처리방침 반영 + TERMS_VERSION 상향
  ④ `app_settings 'outreach'` → `server_send: true` + `config.ts FLAGS.outreach = true` + 재배포(**둘 다 켜야 열림**)
- [x] 자동 수집 Secrets + 봇 계정 (2026-07-05 설정 완료)
- [x] 일일 다이제스트 Secrets(ADMIN_BOT — admin 롤 지정 완료)
- [x] 주간 백업 Secret `BACKUP_PASSPHRASE` (수동 실행 1회 성공 확인 — 패스프레이즈는 비밀번호 관리자에 보관)
- [ ] (선택) Google 로그인: Supabase 대시보드 Authentication → Providers → Google 설정 후 `app/src/config.ts`의 `googleAuth: true`
- [ ] **검색엔진 등록**(유입의 선행 조건 — 인증 파일은 각 콘솔에서 발급):
  ① Google Search Console → 속성 추가(URL 접두어 `https://comdows.github.io/web1/`) → HTML 파일 인증 선택 → 받은 `google*.html`을 `app/public/`에 넣고 커밋 → 배포 후 확인 → `sitemap.xml` 제출
  ② Bing 웹마스터 도구 — GSC 가져오기 지원(가장 쉬움). Bing은 ChatGPT 검색의 소스라 중요
  ③ 네이버 서치어드바이저 → 사이트 등록 → HTML 파일 인증(`naver*.html`을 `app/public/`에) → 사이트맵 제출
- [ ] 특허 출원 — 발명 4건, 공지예외 12개월 시한 (patent-plan.md)
- [ ] 유료화 게이트 도달 시(0011·0012·0026으로 시스템 준비 완료 — 제휴 G1~G3 + **거래소 X1(활성 매물 10건↑·브리프 20건↑ → listing 스위치)·X2(월 소개 5건↑ → buyer_membership·buyer_early 스위치)**, 상세 조건은 pricing-policy.md §3 — 스위치만 꺼져 있음. 파운더 50%는 `profiles.founder_discount_until` 수동 부여 시 서버가 자동 적용): ① 통신판매업 신고 ② pricing-policy.md §6-2 무통장 한시 허용 단서 개정 ③ 처리방침 §1 증빙 발행 정보 추가+TERMS_VERSION 상향 ④ app_settings 'pricing_announced_at' 설정(30일 공지 — 사이트 배너 자동 노출) ⑤ 30일 후 app_settings 'billing' 상품별 true + config.ts FLAGS.billing true + 재배포(**둘 다 켜야 열림**). 운영: 입금 확인 시 현금영수증/세금계산서 홈택스 수기 발행 후 승인번호 메모

## 문서 인덱스

| 문서 | 내용 |
|---|---|
| ops-checklist.md | 운영자 액션 체크리스트 — 검색엔진 등록·이메일 켜기·특허 시한·운영 루틴 |
| pricing-policy.md | 가격정책 v1 — 확정 예정가·게이트·환불·결제 운영 |
| patent-plan.md | 발명 명세서 초안 4건 + 출원 전략(공지예외 시한) |
| stage2-monetization-plan.md / stage3-exchange-plan.md | 제휴 수익화 · 거래소 법적 구조 기획 |
| ai-tools-plan.md / auto-collect-plan.md | AI 도구 영역 · 자동 수집 설정 가이드 |
| platform-of-platforms-strategy*.md | 초기 전략 문서 |

## 개발

```bash
cd app && npm install
npm run dev        # 개발 서버
npm run build      # tsc + vite + 프리렌더(1,637p) — Pages가 master 푸시마다 자동 배포
```

데이터 추가/수정: `app/src/data/platforms.json` 수정 → `node backend/seed/build-seed.mjs`로 0003 재생성 →
새 항목만 담은 000N 마이그레이션 작성(멱등: on conflict do nothing) → Supabase에서 실행.
