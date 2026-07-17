/* 가치 자가진단(lib/valuation.ts) 골든 — 밴드 입력→밴드 출력, 극단·조작값에서도 크래시·음수 없음.
 * 특허(발명 4) 청구항: 밴드 입력→밴드 출력·미저장. 이 성질이 회귀하지 않게 고정한다. */
import { describe, it, expect } from "vitest";
import { estimateValue } from "../src/lib/valuation";
import type { ValueInput } from "../src/lib/valuation";

describe("estimateValue — 밴드 견고성", () => {
  it("정상 입력은 low ≤ high, 양수 배수", () => {
    const r = estimateValue({ group: "commerce", revenueBand: "10~30억", assets: ["brand", "url"], handover: "3개월", years: "3~6년" } as ValueInput);
    expect(r.low).toBeGreaterThan(0);
    expect(r.high).toBeGreaterThanOrEqual(r.low);
    expect(r.multLow).toBeGreaterThanOrEqual(0.1);
  });
  it("미지의 키(조작값)에도 폴백으로 크래시 없음", () => {
    const r = estimateValue({ group: "___none", revenueBand: "zzz", assets: ["___"], handover: "zzz", years: "zzz" } as ValueInput);
    expect(Number.isFinite(r.low)).toBe(true);
    expect(Number.isFinite(r.high)).toBe(true);
    expect(r.multLow).toBeGreaterThanOrEqual(0.1);
  });
  it("빈/누락 필드에도 안전(assets 빈 배열)", () => {
    const r = estimateValue({ group: "", revenueBand: "", assets: [], handover: "", years: "" } as ValueInput);
    expect(Number.isFinite(r.low)).toBe(true);
    expect(r.low).toBeGreaterThanOrEqual(0);
    expect(r.confidence).toBe("낮음");
  });
});
