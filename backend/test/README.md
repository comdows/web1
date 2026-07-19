# QA 회귀 하네스

이 프로젝트의 회귀 방지는 3층으로 구성된다.

## 1. 골든 단위 테스트 (CI 필수 게이트 — 자동)
`app/test/*.test.ts` — vitest. **ci.yml에서 `npm test`로 매 PR 자동 실행.**
- `anonymity.test.ts` — 익명성 CONTACT_RE 차단/통과 경계(특허 핵심). 정규식 수정 시 서버 0009/0037 CHECK 동반 갱신 확인용.
- `session.test.ts` — 조작된 `sm.session.v1` shape 방어(`isValidSession`).
- `valuation.test.ts` — 가치 자가진단 극단·조작값 견고성(음수·크래시 없음).

로컬: `cd app && npm test`

## 2. 적대적 Playwright 스모크 (수동/로컬 — 브라우저 필요)
`backend/test/adversarial-smoke.mjs` — 손상 세션·미존재 뷰·초장문·연락처 제보 차단 등 적대 입력에서 흰 화면·pageerror가 없는지 검증.

실행:
```bash
cd app && npm run build
mkdir -p /tmp/serve-root && ln -sfn "$(pwd)/dist" /tmp/serve-root/web1
( cd /tmp/serve-root && python3 -m http.server 4293 >/dev/null 2>&1 & )
node ../backend/test/adversarial-smoke.mjs
```
모듈은 `/opt/node22/lib/node_modules/playwright`, 브라우저 `executablePath:/opt/pw-browsers/chromium`, 원격은 `page.route`로 차단(Supabase 미접속). CI 미연결 이유: 브라우저 설치가 무겁다 — 릴리스 전 로컬 수동 실행.

### 전 라우트 스모크 (동일 실행 절차)
`backend/test/route-smoke.mjs` — **모든 뷰(24) × 비로그인/로그인/관리자** 정상 진입 경로 전수에서 흰 화면·pageerror가 없는지 검증(35 체크). 적대 스모크와 짝: 그쪽은 비정상 입력, 이쪽은 정상 경로 전수. Supabase·GitHub API는 mock(`profiles`만 역할 주입) — 운영 무영향.
```bash
node ../backend/test/route-smoke.mjs   # 위와 동일하게 dist 서버(4293) 띄운 상태에서
```
새 뷰를 추가하면 `PUBLIC_ROUTES`에 한 줄 추가할 것.

### 기능 교차 스모크 (동일 실행 절차)
`backend/test/feature-smoke.mjs` — 기능 슬라이스의 **기능 시나리오** 층(43 체크): R2 공지 배너(유효/만료·전역), G1 투어(자동 1회·sm.tour.v1 기록·수동 재실행·앵커 하이라이트), 도움말 허브·화면 연결, R4 운영자 답글(권한별 표시/폼), R3 알림 신종 3종(렌더·이동), 관리자 발행 도구, 게시글 수명 관리(0041 — 60일+ 갱신 버튼→RPC·보드 ✓ 확인 표시), 모바일 375px(렌더+가로 오버플로). route-smoke는 "경로 전수", 이쪽은 "기능 동작" — 새 기능 슬라이스를 머지하면 시나리오를 한 블록 추가할 것.
```bash
node ../backend/test/feature-smoke.mjs   # 위와 동일하게 dist 서버(4293) 띄운 상태에서
```

## 3. PG16 적대 시나리오 (수동/로컬 — Postgres 필요)
`backend/test/rls-scenarios.sql` — 마이그레이션을 얹은 로컬 PG16에서 적대적 접근(anon 직격·권한 상승·연락처 CHECK·헬퍼 grant)이 막히는지 검증.

실행(CLAUDE.md §검증패턴 3 참조):
```bash
# authstub + ALL.sql 적용된 로컬 PG16(포트 5433)에 이어서
psql -h /tmp/pgtest/sock -p 5433 -d qa_test -f backend/test/rls-scenarios.sql
```
기대: 각 시나리오가 `PASS`를 출력. 하나라도 `FAIL`이면 서버 방어 회귀.
