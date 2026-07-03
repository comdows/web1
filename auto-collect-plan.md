# 신규 플랫폼·AI 도구 자동 수집 계획 v1 (2026-07)

> 목표: 매주 새로 나오는 플랫폼·AI 도구를 사람이 찾아다니지 않아도 되게 한다.
> 원칙: **자동 등재는 하지 않는다** — 수집기는 후보를 "제보 검수 큐"에 넣을 뿐이고,
> 등재는 언제나 관리자 승인(중립·중복·품질 기준)을 거친다.

## 1. 구조

```
GitHub Actions (매주 월 07:00 KST + 수동 실행)
  └ backend/collect/collect.mjs
      ① 소스 수집 — Product Hunt AI 피드 · Hacker News Show HN · 플래텀(국내, 출시 소식만)
      ② 정규화 — 제목에서 부제 제거, HTML 제거, 지역 태깅(해외/국내)
      ③ 중복 제거 — 기존 등재 1,637개(호스트·이름) + 봇의 과거 제보와 대조, 회차당 최대 15건
      ④ 봇 계정 로그인(anon 키 + 비밀번호 — 서비스 키 불사용) → submissions 테이블에 후보 투입
  └ 관리 콘솔 "제보 검수 큐"에 🤖 자동 수집 배지로 표시 → 이름·분야 다듬고 ✓ 승인·등재
```

- 새 테이블·정책 없음: 기존 `submissions` RLS("본인 제보 insert / 본인+admin select")를 그대로 사용.
- 봇은 일반 회원이라 권한이 최소(자기 제보만 가능) — 비밀번호가 새어도 등재는 불가능.
- 회차당 15건 상한: 1인 검수 부담 제한. 소스·상한은 collect.mjs 상단에서 조정.

## 2. 사용자 설정 (최초 1회, ~5분)

1. **봇 계정 만들기** — 사이트에서 회원가입(예: `semopl.bot@본인도메인` 또는 별도 지메일),
   확인 메일 클릭까지 완료. 관리자 지정 불필요(일반 회원이면 됨).
2. **GitHub Secrets 등록** — 리포 Settings → Secrets and variables → Actions → New repository secret:
   | 이름 | 값 |
   |---|---|
   | `SUPABASE_URL` | `https://yoibyjexxtiopmxjxihf.supabase.co` |
   | `SUPABASE_ANON_KEY` | 사이트 빌드에 쓰는 공개 anon 키(.env.production과 동일) |
   | `BOT_EMAIL` | 봇 계정 이메일 |
   | `BOT_PASSWORD` | 봇 계정 비밀번호 |
3. **수동 실행으로 테스트** — Actions 탭 → `collect-candidates` → Run workflow.
   성공하면 관리 콘솔 검수 큐에 🤖 후보가 보인다. 이후 매주 월요일 아침 자동 실행.

## 3. 검수 요령

- 🤖 배지 카드의 출처(producthunt/hn/platum)를 보고 공식 사이트를 열어 실체 확인
- 이름을 한국 사용자 기준으로 다듬고(부제 제거), 분야 선택(AI 도구면 ai_* 분야), 소개 한 줄 재작성
- 뉴스 링크(플래텀 아카이브 등)가 딸려온 경우 공식 URL로 교체 후 승인, 실체 없으면 반려
- 반려해도 다음 회차에 다시 오지 않는다(봇의 과거 제보와 dedup — 상태 무관)

## 4. 로컬 검증

```
node backend/collect/collect.mjs --dry --fixture <픽스처 디렉토리>   # 네트워크 없이 파서 검증
node backend/collect/collect.mjs --dry                               # 실제 소스 수집까지(투입 없음)
```

## 5. 확장 여지 (필요해지면)

- 소스 추가: GitHub Trending(AI 리포), 벤처스퀘어 RSS, There's An AI For That 신규 목록
- 기존 등재 정보 갱신 감지(도메인 사망·리브랜딩) — 주기적 URL 헬스체크 잡
- 후보 사전 분류: 제목 키워드로 category_id 추정해 검수 시간 단축
