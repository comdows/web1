# collect.mjs 테스트 픽스처

이 개발환경은 외부 네트워크가 프록시로 제한됨(Supabase·GitHub만) — 실제 소스 피드를 못 부른다.
`node backend/collect/collect.mjs --dry --fixture backend/collect/fixtures` 가 이 파일들을 소스 응답 대신 읽어
파싱·분류·중복제거·신뢰도 로직을 검증한다. 각 파일명은 collect.mjs SOURCES[].fixture 와 일치.

실서비스(GitHub Actions)는 픽스처 없이 실제 URL을 부른다 — 이 파일들은 테스트 전용 샘플이다.
