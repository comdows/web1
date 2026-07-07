/* 제휴 제안 기본 양식 — 회원이 특정 플랫폼에 보낼 제안서의 초안.
 * "AI가 미리 써둔" 개념: 방식(그룹)별 잘 쓰인 골격을 두고, 회원 입력(발신·수신 플랫폼·Give/Get)을 끼워 완성한다.
 * 회원이 검토·수정 후 발송한다(발송은 게이트: 서버 발송 스위치 on이면 세모플이, off면 회원 본인 메일). */

export interface ProposalCtx {
  senderName: string;   // 제안하는 회원의 플랫폼 이름
  targetName: string;   // 제안받는 플랫폼 이름
  methodLabel: string;  // 제휴 방식 이름(예: 배너 맞교환)
  methodGroup: string;  // 방식 그룹(traffic/growth/…) — 가치 훅 선택용
  mechanics: string;    // 방식 작동 방식(partnerTypes.json)
  give: string;         // 내가 줄 것
  get: string;          // 받고 싶은 것
  inviteLink: string;   // 세모플에서 이 제안을 보고 답하는 링크(비회원 가입 유도)
}

/* 그룹별 가치 훅 — 왜 이 방식이 서로에게 이득인지 한 문장(제안의 설득 포인트) */
const HOOK: Record<string, string> = {
  traffic: "두 서비스의 이용자층이 겹치지 않는 만큼, 서로의 지면을 나눠 쓰면 광고비 없이 새 방문자를 얻을 수 있다고 봅니다.",
  growth: "이미 활성화된 서로의 회원에게 자연스러운 다음 단계를 제안하는 형태라, 신규 획득 비용 대비 전환이 높습니다.",
  commerce: "상품·혜택을 함께 묶으면 각자 고객에게 '한 번에 해결'되는 경험을 줄 수 있어 객단가와 만족도가 함께 올라갑니다.",
  comarketing: "각자 콘텐츠·채널을 합쳐 한 번의 기획으로 두 배의 도달을 만드는 방식이라, 마케팅 리소스를 아낄 수 있습니다.",
  infra: "기능·데이터를 잇는 제휴라 한 번 연동하면 지속적으로 서로의 가치를 키우는 구조가 됩니다.",
  trust: "서로를 검증된 파트너로 소개하면, 각자 고객에게 신뢰 신호를 더하면서 양질의 리드를 주고받을 수 있습니다.",
};

/* 제목 */
export function proposalSubject(c: ProposalCtx): string {
  return `[제휴 제안] ${c.senderName} → ${c.targetName}: ${c.methodLabel}`;
}

/* 본문 — 담백한 B2B 제안체. 발신자를 명확히 밝히고(콜드 아웃리치의 기본 예의),
 * Give/Get을 구체화하고, 다음 단계(세모플에서 확인·회신)로 이어준다. 수신거부 안내 포함. */
export function proposalBody(c: ProposalCtx): string {
  const hook = HOOK[c.methodGroup] ?? HOOK.traffic;
  return `${c.targetName} 담당자님께,

안녕하세요. 저는 ${c.senderName}를 운영하고 있습니다.
${c.targetName}와 "${c.methodLabel}" 방식의 제휴를 제안드리고 싶어 연락드립니다.

■ 제안하는 방식 — ${c.methodLabel}
${c.mechanics}

■ 제가 드릴 수 있는 것(Give)
${c.give || "(제안자가 작성)"}

■ 받고 싶은 것(Get)
${c.get || "(제안자가 작성)"}

■ 왜 서로에게 좋은지
${hook}

부담 없이 검토해 보시고, 관심 있으시면 아래에서 바로 답을 주실 수 있습니다.
${c.inviteLink}

이 제안은 세모플(세상의 모든 플랫폼) 제휴 매칭을 통해 전달됐습니다.
더 이상 제휴 제안 수신을 원치 않으시면 위 링크에서 수신거부하실 수 있습니다.

감사합니다.
${c.senderName} 드림`;
}

/* mechanics 없이 방식만 아는 경우의 폴백(카탈로그에서 mechanics를 못 넘길 때) */
export const GENERIC_MECHANICS = "서로 동일한 가치 기준으로 조건을 맞춰 진행합니다. 구체 조건은 협의로 정합니다.";
