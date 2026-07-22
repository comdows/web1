/* 커스텀 도메인 전환 스크립트 — 도메인 구매 후 루트에서 1회 실행:
 *   node scripts/switch-domain.mjs semopl.com
 *
 * 하는 일: ① app/site.config.mjs의 CUSTOM_DOMAIN 설정(빌드 base·canonical·sitemap·CNAME이 전부 파생)
 *   ② 백엔드 배치·Edge Function의 SITE_URL 폴백 문자열 교체 ③ README·ops-checklist 표기 교체
 *   ④ 옛 주소 잔존 검사 리포트 ⑤ 남은 수동 절차 안내(전체 절차: domain-setup.md)
 * 되돌리기: node scripts/switch-domain.mjs --revert  (GitHub Pages 기본 주소로 복귀) */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = process.argv[2];
if (!arg) {
  console.error("사용법: node scripts/switch-domain.mjs <도메인>   (예: semopl.com)\n        node scripts/switch-domain.mjs --revert   (기본 주소로 복귀)");
  process.exit(1);
}
const revert = arg === "--revert";
const domain = revert ? "" : arg.replace(/^https?:\/\//, "").replace(/\/$/, "");
if (!revert && !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) {
  console.error(`도메인 형식이 이상해요: "${domain}" — 프로토콜 없이 semopl.com 형태로 입력하세요.`);
  process.exit(1);
}
const NEW_URL = revert ? "https://comdows.github.io/web1" : `https://${domain}`;

const edits = [];
function patch(file, replacer) {
  const p = path.join(ROOT, file);
  const before = fs.readFileSync(p, "utf8");
  const after = replacer(before);
  if (after !== before) { fs.writeFileSync(p, after); edits.push(file); }
}

// ① 단일 설정 — 이하 빌드 산출물(base·canonical·sitemap·og·CNAME·EN 레이어)은 전부 여기서 파생
patch("app/site.config.mjs", (s) => s.replace(/export const CUSTOM_DOMAIN = "[^"]*";/, `export const CUSTOM_DOMAIN = "${revert ? "" : domain}";`));

// ② 배치·Edge의 SITE_URL 폴백(env 미설정 환경에서도 새 주소로 동작)
for (const f of ["backend/collect/digest.mjs", "backend/collect/collect.mjs", "backend/collect/healthcheck.mjs", "supabase/functions/send-notify-email/index.ts"]) {
  patch(f, (s) => s.replace(/(process\.env\.SITE_URL \?\? "|Deno\.env\.get\("SITE_URL"\) \?\? ")https:\/\/[^"]+(")/g, `$1${NEW_URL}$2`));
}

// ③ index.html og 원본 + 문서 표기 — revert는 어떤 도메인이었는지 알 수 없어 수동(안내만)
if (!revert) {
  patch("app/index.html", (s) => s.replaceAll("https://comdows.github.io/web1", NEW_URL));
  for (const f of ["README.md", "ops-checklist.md"]) {
    patch(f, (s) => s.replaceAll("https://comdows.github.io/web1", NEW_URL));
  }
} else {
  console.log("※ revert: README·ops-checklist의 도메인 표기는 수동으로 되돌려 주세요.");
}

console.log(`✔ 갱신된 파일 (${edits.length}):\n${edits.map((f) => `  - ${f}`).join("\n") || "  (변경 없음 — 이미 반영됨)"}`);

// ④ 잔존 검사(코드 경로만 — mvp/ 구 사이트·git 이력은 제외)
if (!revert) {
  const scan = ["app/src", "app/scripts", "app/index.html", "app/site.config.mjs", "backend/collect", "supabase/functions"];
  const left = [];
  const walk = (p) => {
    const st = fs.statSync(p);
    if (st.isDirectory()) { for (const f of fs.readdirSync(p)) walk(path.join(p, f)); return; }
    if (!/\.(mjs|ts|tsx|html|json)$/.test(p)) return;
    const src = fs.readFileSync(p, "utf8");
    // 폴백 패턴("?? "https://...")은 env 미설정 대비 잔존이 정상 — 그 외 하드코딩만 잡는다
    for (const [i, line] of src.split("\n").entries()) {
      if (line.includes("comdows.github.io") && !line.includes('?? "') && !line.includes("CUSTOM_DOMAIN ?")) left.push(`${path.relative(ROOT, p)}:${i + 1}`);
    }
  };
  for (const s of scan) walk(path.join(ROOT, s));
  console.log(left.length ? `⚠ 옛 주소 잔존(확인 필요):\n${left.map((l) => `  - ${l}`).join("\n")}` : "✔ 옛 주소 하드코딩 잔존 없음");
}

console.log(`
다음 수동 단계 (자세한 순서·확인법: domain-setup.md):
 1. DNS: apex A 레코드 4개(185.199.108.153 / .109 / .110 / .111) + www CNAME → comdows.github.io
 2. GitHub 리포 Settings → Pages → Custom domain에 "${revert ? "(비우기)" : domain}" 입력 → Enforce HTTPS 체크
 3. 이 변경 커밋·머지 → Pages 배포(dist에 CNAME 자동 포함)
 4. Supabase → Authentication → URL Configuration: Site URL·Redirect URLs에 ${NEW_URL} 추가
 5. 서치콘솔: GSC 새 속성 등록 + ${NEW_URL}/sitemap.xml 제출, 네이버·Bing 재등록
`);
