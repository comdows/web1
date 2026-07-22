# 커스텀 도메인 연결 절차 (도메인 구매 → 라이브까지)

코드는 이미 준비돼 있습니다 — 사이트 주소는 `app/site.config.mjs` 한 곳에서 파생되고,
`node scripts/switch-domain.mjs <도메인>` 한 번이면 코드 쪽 전환이 끝납니다.
아래는 구매 후 실제 순서입니다(총 30분~반나절, 대부분 DNS 전파 대기).

## 0. 도메인 선택 팁 (짧게)
- `.com` > `.kr`/`.co.kr` > 신생 TLD 순으로 무난(신뢰·기억성). 한글 브랜드면 `semopl.com`처럼 로마자 표기 일치 권장.
- 등록처는 어디든 무방(가비아·후이즈·Cloudflare·Namecheap 등) — DNS 레코드만 설정할 수 있으면 됩니다.

## 1. DNS 설정 (등록처 관리 콘솔에서)
| 유형 | 호스트 | 값 |
|---|---|---|
| A | @ (apex) | 185.199.108.153 |
| A | @ | 185.199.109.153 |
| A | @ | 185.199.110.153 |
| A | @ | 185.199.111.153 |
| CNAME | www | `comdows.github.io` |

- (선택) AAAA 4개: `2606:50c0:8000::153` ~ `8003::153` — IPv6, 없어도 동작.
- 전파 확인: `dig +short <도메인>` 이 위 IP들을 반환하면 됨(보통 수 분~1시간).

## 2. GitHub Pages 설정
1. 리포 **Settings → Pages → Custom domain**에 도메인 입력(예: `semopl.com`) → Save
2. DNS check 통과 대기 → **Enforce HTTPS** 체크(인증서 발급 수 분~수십 분)
- www를 주 도메인으로 쓰려면 www를 입력 — GitHub이 apex↔www 상호 리다이렉트를 처리합니다.

## 3. 코드 전환 (1회 실행)
```bash
node scripts/switch-domain.mjs semopl.com   # 실제 도메인으로
```
- 자동 처리: `app/site.config.mjs`(base `/semopl/`→`/`, canonical·sitemap·og·hreflang·EN 레이어·CNAME 파일 전부 파생),
  배치·이메일의 주소 폴백, README·ops-checklist 표기, 옛 주소 잔존 검사.
- 커밋 → PR → 머지 → Pages 배포. 배포되면 dist에 `CNAME`이 포함돼 바인딩이 유지됩니다.
- 되돌리기: `node scripts/switch-domain.mjs --revert`

## 4. 배포 후 확인 (5분)
- `https://<도메인>/` 접속 + 자물쇠(HTTPS) 확인
- `https://<도메인>/sitemap.xml` — 모든 URL이 새 도메인인지
- `view-source:` 홈·상세 1곳 — `<link rel="canonical">`·`og:url`이 새 도메인인지
- 옛 주소 `https://comdows.github.io/semopl/` 접속 → 새 도메인으로 **301 자동 리다이렉트**되는지(GitHub 제공 — 기존 색인·링크 자산이 이어집니다)

## 5. Supabase Auth 갱신 (로그인 메일 복귀 주소)
Supabase 대시보드 → **Authentication → URL Configuration**:
- Site URL: `https://<도메인>/`
- Redirect URLs: `https://<도메인>/**` 추가 (기존 github.io 항목은 전환 과도기 동안 유지 후 제거)
- (미루면 가입 확인·비밀번호 재설정 메일이 옛 주소로 복귀합니다)

## 6. 검색엔진 등록·이관
- **Google Search Console**: 새 "도메인" 속성 등록(DNS TXT 인증) → Sitemaps에 `https://<도메인>/sitemap.xml` 제출.
  기존 github.io URL은 301이 승계 신호 — 별도 주소 변경 도구는 도메인 속성 간 지원되지 않으므로 301+sitemap이 정석.
- **네이버 서치어드바이저**: 사이트 등록(HTML 파일 인증 — 받은 `naver*.html`을 `app/public/`에 넣고 배포하면 루트에 서빙됨) → 사이트맵 제출
- **Bing 웹마스터**: GSC 가져오기(가장 쉬움)
- 소셜 카드 캐시: 카카오 디버거·페이스북 Sharing Debugger에서 새 주소 1회 조회(og 캐시 갱신)

## 7. 유의
- 전환 직후 2~4주는 색인이 출렁이는 게 정상(구글이 301을 따라 재평가). 콘텐츠·사이트맵을 바꾸지 말고 기다리기.
- 이후 신규 유입 계측은 관리 콘솔 퍼널 패널과 GSC 새 속성에서 그대로 이어집니다.
- (선택) GitHub Actions 워크플로에 `SITE_URL` env를 추가하면 배치 로그·이메일 링크도 env로 통일되지만, 폴백이 이미 새 주소로 교체되므로 필수 아님.
