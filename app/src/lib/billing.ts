/* 결제 계층 — PG 연동 "직전"까지의 준비.
 * 현재 구현은 무통장 입금(bank_transfer)뿐이며, PG(토스페이먼츠/포트원)는 인터페이스 자리만 둔다.
 * 유료화 스위치는 이중: FLAGS.billing(프론트 렌더) + app_settings 'billing'(서버 — place_order가 검사).
 * 금액 산출·상태 전이는 전부 서버 RPC(0011)가 수행한다 — 클라이언트는 주문 요청과 안내만. */
import { rest } from "./api";

export interface DepositInstructions {
  method: "bank_transfer";
  bank: string;            // app_settings 'billing'.bank — "은행 계좌번호 (예금주)"
  depositorRule: string;   // 입금자명 규칙(대조용)
  deadlineDays: number;
  chargeId: string;
  totalKrw: number;        // VAT 포함 표시가
}

export interface PaymentProvider {
  /** 주문 생성 후 사용자에게 보여줄 결제 안내를 반환 */
  instruct(chargeId: string, totalKrw: number, depositorRule: string): Promise<DepositInstructions>;
}

interface BillingSettings { sponsor: boolean; connection: boolean; membership: boolean; bank: string; deposit_deadline_days: number }

export async function fetchBillingSettings(): Promise<BillingSettings | null> {
  try {
    const rows = await rest<{ value: BillingSettings }[]>("app_settings?key=eq.billing&select=value");
    return rows[0]?.value ?? null;
  } catch { return null; }
}

export const bankTransferProvider: PaymentProvider = {
  async instruct(chargeId, totalKrw, depositorRule) {
    const s = await fetchBillingSettings();
    return {
      method: "bank_transfer",
      bank: s?.bank || "(계좌 미설정 — 운영자에게 문의)",
      depositorRule,
      deadlineDays: s?.deposit_deadline_days ?? 7,
      chargeId, totalKrw,
    };
  },
};

/* PG 스텁 — 실제 연동(결제창·웹훅) 전까지 사용 금지. 유료화 게이트 §6 참조. */
export const pgProvider: PaymentProvider = {
  async instruct(): Promise<DepositInstructions> {
    throw new Error("PG 결제는 아직 연동 전입니다 — 무통장 입금을 이용해 주세요.");
  },
};
