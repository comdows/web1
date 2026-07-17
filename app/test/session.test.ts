/* 세션 shape 검증(auth.ts isValidSession) 골든 — 조작된 sm.session.v1 방어(QA-1).
 * 유효 JSON이어도 형태가 어긋나면 무효로 간주해야 이후 session.user.id 참조가 터지지 않는다. */
import { describe, it, expect } from "vitest";
import { isValidSession } from "../src/lib/auth";

describe("isValidSession — 손상·조작 세션 방어", () => {
  it("정상 세션은 통과", () => {
    expect(isValidSession({ access_token: "t", refresh_token: "r", expires_at: 1, user: { id: "u1", email: "a@b.c" } })).toBe(true);
  });
  it.each([
    ["null", null],
    ["문자열", "42"],
    ["숫자", 42],
    ["빈 객체", {}],
    ["user 없음", { access_token: "t" }],
    ["user.id 없음", { access_token: "t", user: {} }],
    ["user.id 빈 문자열", { access_token: "t", user: { id: "" } }],
    ["access_token 없음", { user: { id: "u1" } }],
    ["access_token 비문자열", { access_token: 123, user: { id: "u1" } }],
    ["user가 배열", { access_token: "t", user: [] }],
  ])("무효: %s", (_label, val) => {
    expect(isValidSession(val)).toBe(false);
  });
});
