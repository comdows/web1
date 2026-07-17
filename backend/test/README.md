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

## 3. PG16 적대 시나리오 (수동/로컬 — Postgres 필요)
`backend/test/rls-scenarios.sql` — 마이그레이션을 얹은 로컬 PG16에서 적대적 접근(anon 직격·권한 상승·연락처 CHECK·헬퍼 grant)이 막히는지 검증.

실행(CLAUDE.md §검증패턴 3 참조):
```bash
# authstub + ALL.sql 적용된 로컬 PG16(포트 5433)에 이어서
psql -h /tmp/pgtest/sock -p 5433 -d qa_test -f backend/test/rls-scenarios.sql
```
기대: 각 시나리오가 `PASS`를 출력. 하나라도 `FAIL`이면 서버 방어 회귀.
