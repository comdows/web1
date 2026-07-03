/* 익명 게시물 식별정보 누출 자동 탐지 — 특허 출원 대상 핵심 모듈(patent-plan.md 발명 1).
 * 디렉토리 데이터베이스(플랫폼명 사전)를 익명성 검증 사전으로 재사용하는 것이 구성의 핵심:
 * 게시물 텍스트를 ① 차단 패턴(연락처·메신저·URL — 0005 서버 check와 동일 기준)과
 * ② 경고 패턴(도메인 표기·정확한 수치·디렉토리 등재 플랫폼명 일치)의 2계층으로 판정하고,
 * 경고는 제출자 재확인(2단 제출) 후 접수, 검수자 화면에는 위험 근거를 하이라이트한다. */
import { platforms } from "../data";

export interface AnonFinding {
  level: "block" | "warn";
  type: "contact" | "domain" | "number" | "platform-name";
  snippet: string;
  hint: string;
}

/* 연락처·식별정보 패턴(0005 서버 check와 동일) — 폼에서 선차단해 친절히 안내 */
export const CONTACT_RE = /(@|https?:\/\/|www\.|010[- ]?\d{3,4}[- ]?\d{4}|카카오톡|카톡|kakao|텔레그램|telegram)/i;
export const hasContact = (...texts: (string | undefined)[]) => texts.some((t) => t && CONTACT_RE.test(t));

const DOMAIN_RE = /\b[a-z0-9][a-z0-9-]{1,30}\.(com|net|kr|io|co|shop|store|me|app)\b/i;
/* 밴드 권장 위반 의심 — 단위 붙은 수치(억·천만·만 원·만 명·%)나 5자리 이상 원수치 */
const NUMBER_RE = /\d+(,\d{3})*(\.\d+)?\s*(억|천만|백만|만\s?원|만\s?명|%|퍼센트)|\d{5,}/;

/* 플랫폼명 사전 — 디렉토리 등재명 중 3자 이상(짧은 일반어 오탐 방지), 최초 1회 구성 */
let dict: string[] | null = null;
function nameDict(): string[] {
  if (!dict) dict = [...new Set(platforms.map((p) => p.name.trim()).filter((n) => n.length >= 3))];
  return dict;
}

export function checkAnonymity(...texts: (string | undefined)[]): AnonFinding[] {
  const out: AnonFinding[] = [];
  const seen = new Set<string>();
  const push = (f: AnonFinding) => { const k = f.type + f.snippet; if (!seen.has(k)) { seen.add(k); out.push(f); } };
  for (const t of texts) {
    if (!t) continue;
    const contact = t.match(CONTACT_RE);
    if (contact) push({ level: "block", type: "contact", snippet: contact[0], hint: "연락처·메신저·URL은 적을 수 없어요 — 소개는 세모플이 비공개로 진행합니다" });
    const domain = t.match(DOMAIN_RE);
    if (domain) push({ level: "warn", type: "domain", snippet: domain[0], hint: "도메인 표기는 플랫폼을 특정하게 해요" });
    const num = t.match(NUMBER_RE);
    if (num) push({ level: "warn", type: "number", snippet: num[0].trim(), hint: "정확한 수치 대신 밴드(범위) 표현을 권장해요" });
    const low = t.toLowerCase();
    for (const n of nameDict()) {
      if (low.includes(n.toLowerCase())) {
        push({ level: "warn", type: "platform-name", snippet: n, hint: "디렉토리 등재 플랫폼명과 일치 — 신원이 유추될 수 있어요" });
        break; // 텍스트당 대표 1건만(경고 폭주 방지)
      }
    }
  }
  return out;
}

export const hasBlocking = (findings: AnonFinding[]) => findings.some((f) => f.level === "block");
