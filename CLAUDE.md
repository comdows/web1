# 세모플 개발 가이드 (Claude Code용)

한국어 B2B 서비스 — 사용자 대화·커밋 메시지·UI 문구는 한국어. 프로젝트 개요·운영 루틴은 README.md 참고.

## 불변 원칙 (코드로도 지켜야 함)

- **service_role/sb_secret 키 절대 커밋·주입·출력 금지.** anon 키(.env.production)는 공개 키라 커밋 안전.
- **거래소는 자산·사업 양수도만.** 지분·투자유치·주식 관련 접수/게시/소개 경로를 새로 열지 말 것 (약관 §1, 무인가 투자중개 리스크). `isEquityMode()`/admin `isEquitySub()` 가드 유지.
- **성공보수·거래액 연동 과금 금지. 가격·밸류에이션 필드를 매물에 추가하지 말 것.** 가치 진단은 밴드 입력→밴드 출력·미저장 유지(patent-plan.md 발명 4 청구항 구성요소이자 법적 조건).
- **게시물 연락처 차단 유지**: 클라이언트(`lib/anonymity.ts` CONTACT_RE) + DB check(0005) 이중화 — 한쪽만 고치면 안 됨.
- **공개 뷰에 작성자 식별자 노출 금지** (v_deals_public 등 — 익명성이 서비스의 법적 전제).
- 디렉토리(검색·비교·순위)에 유료·광고 요소 넣지 말 것.

## 아키텍처 요점

- SPA 라우팅: 쿼리 파라미터(`?view=...`) + 프리렌더 경로(`/p/<id>/`). 새 화면 = nav.tsx ViewName + App.tsx 라우팅/타이틀 + (필요시) 푸터 링크.
- 데이터: `app/src/data/platforms.json`이 단일 소스. 원격(Supabase)이 로드되면 정적 시드를 교체(`lib/platforms.ts`) — **정적 데이터만 추가하면 라이브에 안 보임**, 멱등 마이그레이션(000N)도 함께 만들 것. 0003은 `node backend/seed/build-seed.mjs`로 재생성(직접 수정 금지), ALL.sql은 0001~000N 연결로 재생성.
- API: `lib/api.ts` rest() 단일 지점 — supabase-js 없음, 권한은 전부 RLS. 관리 기능도 클라이언트 호출 + RLS(is_admin).
- 프리렌더: `app/scripts/prerender.mjs`(ko) + `prerender-en.mjs`(en)가 build에 연결됨 — index.html 구조(title/og/#root) 바꾸면 두 스크립트의 치환 정규식 확인.
- **영문 레이어(/en/) 방화벽**: EN 페이지는 SPA 스크립트를 제거한 완전 정적 HTML. 제휴·거래소·가치진단·약관을 EN에 링크·번역 금지(한국법 전제 — prerender-en.mjs가 금지 링크 grep으로 빌드 차단). EN 데이터는 platforms.en.json만, 수수료·정산 조건 영문 게재 금지.

## 검증 패턴 (필수)

1. `cd app && npx tsc -b && npm run build`
2. Playwright 스모크: `/tmp/serve-root/web1 → app/dist` 심링크 + `python3 -m http.server 42xx`(vite preview 금지 — 좀비 포트).
   모듈은 `/opt/node22/lib/node_modules/playwright/index.mjs`, 브라우저 `executablePath: "/opt/pw-browsers/chromium"`.
   원격 차단: `page.route("**://*.supabase.co/**", r => r.abort())`, 가짜 로그인: localStorage `sm.session.v1`.
3. 마이그레이션은 로컬 Postgres 16으로 검증: `su postgres -c ".../pg_ctl -D /tmp/pgtest/data -o '-p 5433' ..."` + auth 스텁(스키마·auth.uid()·anon/authenticated 롤) 생성 후 ALL.sql 실행 + **재실행(멱등) 확인**.

## Git/PR 플로우

- 브랜치: `claude/platform-discovery-matching-strategy-4izkl5` — 매 작업 전 `git fetch origin master && git checkout -B <branch> origin/master`(스쿼시 머지라 리셋 필수, 아니면 머지 충돌).
- 커밋: heredoc 메시지를 복합 명령에 넣으면 조용히 실패 — `git add` 따로, `git commit -m "..."` 인라인으로.
- PR 생성 후 즉시 squash 머지(사용자 기존 지시) → Pages 배포 확인. 배포 "Deployment failed" 일시 오류 잦음 → `rerun_failed_jobs`, 그래도 실패면 workflow_dispatch.
- `actions_list` MCP 응답이 토큰 초과로 파일 저장됨 → python json으로 추출해 읽을 것.

## 함정 목록

- `.frm label`이 flex-column — 폼 안 체크박스는 `label.facet-opt`(인라인 오버라이드 있음) 사용.
- Playwright `text=` 셀렉터는 페이지 전체에서 첫 매치 — 폼 안 요소는 `form.frm ...`로 한정.
- 이 환경은 외부 네트워크가 프록시로 제한됨(Supabase·GitHub만) — 외부 피드 테스트는 픽스처로.
- 데모 데이터(listings.json)와 실데이터가 보드에 병존 — 상태 로직 수정 시 demo 분기 확인.
