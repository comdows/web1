/* 사이트 주소 단일 설정 — 빌드(vite base)·프리렌더(canonical/sitemap/og/CNAME)·프론트 폴백이 전부 여기서 파생.
 *
 * 커스텀 도메인 확정 시: 루트에서 `node scripts/switch-domain.mjs <도메인>` 한 번 실행(이 파일 포함
 * 백엔드·문서까지 일괄 갱신 + 후속 절차 안내). 수동으로 바꾸려면 아래 CUSTOM_DOMAIN 한 줄만.
 * 절차 전체(DNS·GitHub Pages·Supabase Auth·서치콘솔)는 /domain-setup.md 참고. */
export const CUSTOM_DOMAIN = "";   // 예: "semopl.com" — 빈 문자열이면 GitHub Pages 기본 주소

export const SITE_ORIGIN = CUSTOM_DOMAIN ? `https://${CUSTOM_DOMAIN}` : "https://comdows.github.io";
export const SITE_BASE = CUSTOM_DOMAIN ? "/" : "/web1/";
/* origin+base 결합(끝 슬래시 없음) — canonical·sitemap·og:url의 접두어 */
export const SITE_URL = SITE_ORIGIN + (SITE_BASE === "/" ? "" : SITE_BASE.replace(/\/$/, ""));
