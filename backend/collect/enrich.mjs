/* AI 보강(선택) — ANTHROPIC_API_KEY가 있으면 수집 후보 배치를 Claude Haiku에 보내
 * 45개 분야 분류·한국어 소개문·"제품 여부" 판정을 받는다. 키 부재·API 오류·파싱 실패 시
 * null/부분 결과를 돌려주고 수집기는 기존 정규식 분류로 폴백한다(현행 동작 보존).
 *
 * 안전장치:
 *   · category_id는 platforms.json의 실제 분야 화이트리스트로 검증(불일치 → "")
 *   · blurb는 길이 상한 + URL·이메일·전화 패턴 제거(연락처 차단 원칙과 정합)
 *   · 호출은 런당 1회·후보 MAX_ENRICH건 상한 — 비용 고정적(주간 실행 기준 월 수백 원 수준)
 *   · 키는 GitHub Actions secret(ANTHROPIC_API_KEY)로만 주입 — 코드·로그 출력 금지
 */

const MAX_ENRICH = 60;                 // 런당 보강 상한(비용 가드)
const MODEL = "claude-haiku-4-5-20251001";
const CONTACT_RE = /(https?:\/\/\S+|[\w.+-]+@[\w-]+\.[a-z]{2,}|0\d{1,2}[- ]?\d{3,4}[- ]?\d{4})/gi;

/** 후보 배열 + 분야 목록 → Map(index → {is_platform, category_id, blurb_ko, region}) | null */
export async function enrich(candidates, categories) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || !candidates.length) return null;

  const batch = candidates.slice(0, MAX_ENRICH);
  const catIds = new Set(categories.map((c) => c.id));
  const catList = categories.map((c) => `${c.id}: ${c.name}`).join("\n");
  const items = batch.map((c, i) => ({ i, name: c.name, desc: c.desc || "", url: c.url, region: c.region }));

  const prompt = `당신은 한국 B2B 플랫폼 디렉토리의 데이터 검수원입니다. 아래 "수집 후보" 각각에 대해 판정하세요.

## 분야 목록 (id: 이름)
${catList}

## 판정 규칙
- is_platform: 이 항목이 "사업자가 이용할 수 있는 서비스/플랫폼/도구 자체"이면 true. 뉴스 기사 일반 소식, 투자 유치 소식만 있는 경우, 오픈소스 라이브러리 조각, 개인 블로그, 이벤트/행사면 false.
- category_id: 분야 목록의 id 중 정확히 하나. 확신이 없으면 빈 문자열 "".
- blurb_ko: 그 서비스가 무엇인지 한국어 한 문장(40~80자, 명사형 종결, 예: "소상공인 대상 주문중개 플랫폼."). 가격·수수료·연락처·과장 표현 금지. 뉴스 제목이면 제목에서 서비스명과 기능만 추출해 서술.
- region: "domestic"(한국 서비스) 또는 "overseas"(해외 서비스). 판단 근거가 없으면 입력값 유지.

## 수집 후보
${JSON.stringify(items, null, 0)}

## 출력
JSON 배열만 출력하세요(설명·마크다운 금지):
[{"i":0,"is_platform":true,"category_id":"...","blurb_ko":"...","region":"domestic"}, ...]`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 90_000);
  let res;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: ctrl.signal,
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 8000,
        messages: [{ role: "user", content: prompt }],
      }),
    });
  } finally { clearTimeout(timer); }
  if (!res.ok) throw new Error(`Anthropic API HTTP ${res.status}`);
  const text = (await res.json()).content?.map((b) => b.text ?? "").join("") ?? "";

  const m = text.match(/\[[\s\S]*\]/);
  if (!m) throw new Error("응답에서 JSON 배열을 찾지 못함");
  const rows = JSON.parse(m[0]);
  if (!Array.isArray(rows)) throw new Error("JSON 배열이 아님");

  const out = new Map();
  for (const r of rows) {
    const i = Number(r?.i);
    if (!Number.isInteger(i) || i < 0 || i >= batch.length || out.has(i)) continue;
    const cat = catIds.has(r.category_id) ? r.category_id : "";
    let blurb = typeof r.blurb_ko === "string" ? r.blurb_ko.replace(CONTACT_RE, "").replace(/\s+/g, " ").trim() : "";
    if (blurb.length > 120) blurb = blurb.slice(0, 120);
    if (blurb.length < 8) blurb = "";                       // 너무 짧으면 원문 desc 유지가 낫다
    const region = r.region === "domestic" || r.region === "overseas" ? r.region : null;
    out.set(i, { is_platform: r.is_platform !== false, category_id: cat, blurb_ko: blurb, region });
  }
  return out;
}
