# collect.mjs 테스트 픽스처

이 개발환경은 외부 네트워크가 프록시로 제한됨(Supabase·GitHub만) — 실제 소스 피드를 못 부른다.
`node backend/collect/collect.mjs --dry --fixture backend/collect/fixtures` 가 이 파일들을 소스 응답 대신 읽어
파싱·분류·중복제거·신뢰도 로직을 검증한다. 각 파일명은 collect.mjs SOURCES[].fixture 와 일치.

HN 전체 최신/과거 백필과 GitHub Search API 픽스처도 포함하며, 광역 소스가 AI 판정 없이는
자동등재 임계값에 도달하지 않는지 함께 검증한다.

국가×main/ad 독립 예산·빈 버킷 비이월·main 중복 우선·ad 자동등재 차단은
`node --test backend/collect/pool-selection.test.mjs`로 결정적으로 검증한다.

실서비스(GitHub Actions)는 픽스처 없이 실제 URL을 부른다 — 이 파일들은 테스트 전용 샘플이다.
