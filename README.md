# 세모플 (SEMOPL) — 세상의 모든 플랫폼

> 사업자용 B2B 인프라: **발견**(플랫폼·AI 도구 디렉토리 1,637개) → **제휴**(매칭 보드) → **거래**(자산·사업 양수도 익명 리스팅).
> 라이브: https://comdows.github.io/web1/ · 스택: React(Vite+TS) SPA + Supabase(PostgREST/RLS) + GitHub Pages/Actions

## 구조

```
app/                 프론트엔드 (Vite + React + TS)
  src/data/          단일 데이터 소스(platforms.json — 6그룹·45분야·1,637개)
  scripts/prerender.mjs   빌드 시 상세 1,637p 정적 생성 + sitemap + robots (SEO)
backend/
  migrations/        0001 스키마 → 0002 RLS → 0003 시드 → 0004 오픈 → 0005 소개·동의 → 0006 AI (ALL.sql = 전체)
  seed/build-seed.mjs     platforms.json → 0003 재생성 (데이터 변경 시 실행)
  collect/collect.mjs     주간 신규 수집기 → 제보 검수 큐 (자동 등재 없음)
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

- [x] Supabase 마이그레이션 0001~0006 (신규 SQL은 `backend/migrations/`에 추가 후 SQL Editor에서 실행)
- [ ] **마이그레이션 0007~0010 실행** — SQL Editor에서 `0007_fixes.sql` → `0008_hardening.sql` → `0009_account.sql` → `0010_ops.sql` 순서대로 (0008은 검수 우회 게시·상태 위조를 막는 보안 패치라 최우선. 0009는 탈퇴·취소 기능, 0010은 검수 메일 안내·events 정리의 전제)
- [ ] 자동 수집 Secrets: `SUPABASE_URL` `SUPABASE_ANON_KEY` `BOT_EMAIL` `BOT_PASSWORD` + 봇 계정 가입 (auto-collect-plan.md §2)
- [ ] 일일 다이제스트 Secrets: `ADMIN_BOT_EMAIL` `ADMIN_BOT_PASSWORD` — admin 롤 전용 봇 계정(가입 후 backend/README.md §4-F로 admin 지정)
- [ ] 주간 백업 Secret: `BACKUP_PASSPHRASE`(임의 긴 문자열 — 비밀번호 관리자에 보관, 분실 시 백업 복호화 불가) — 다이제스트와 같은 ADMIN_BOT 계정 사용
- [ ] (선택) Google 로그인: Supabase 대시보드 Authentication → Providers → Google 설정 후 `app/src/config.ts`의 `googleAuth: true`
- [ ] **검색엔진 등록**(유입의 선행 조건 — 인증 파일은 각 콘솔에서 발급):
  ① Google Search Console → 속성 추가(URL 접두어 `https://comdows.github.io/web1/`) → HTML 파일 인증 선택 → 받은 `google*.html`을 `app/public/`에 넣고 커밋 → 배포 후 확인 → `sitemap.xml` 제출
  ② Bing 웹마스터 도구 — GSC 가져오기 지원(가장 쉬움). Bing은 ChatGPT 검색의 소스라 중요
  ③ 네이버 서치어드바이저 → 사이트 등록 → HTML 파일 인증(`naver*.html`을 `app/public/`에) → 사이트맵 제출
- [ ] 특허 출원 — 발명 4건, 공지예외 12개월 시한 (patent-plan.md)
- [ ] 유료화 게이트 도달 시: 통신판매업 신고 → PG → 세금계산서 자동발행 → 약관 개정 → 전문가 검토 (pricing-policy.md §6)

## 문서 인덱스

| 문서 | 내용 |
|---|---|
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
