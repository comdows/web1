/* 익명성 자동 검증(lib/anonymity.ts) 골든 테스트 — 특허 핵심 모듈의 회귀 자동 차단.
 * CONTACT_RE(0009 서버 check와 동시 갱신 대상)의 차단/통과 경계를 고정한다.
 * 정규식을 손댔는데 이 테스트가 깨지면: 서버 0009 CHECK도 함께 바뀌었는지 반드시 확인. */
import { describe, it, expect } from "vitest";
import { hasContact, checkAnonymity, hasBlocking } from "../src/lib/anonymity";

describe("hasContact — 연락처 차단(block 기준)", () => {
  // 반드시 잡아야 하는 것(회귀 시 연락처가 공개 노출됨)
  it.each([
    ["이메일", "문의는 seller@gmail.com 으로"],
    ["http URL", "자세한 건 http://myshop.example.com 참고"],
    ["https URL", "https://open.kakao.com/o/abc"],
    ["www 도메인", "www.myshop.com 에서 보세요"],
    ["휴대폰 010", "010-1234-5678 로 연락주세요"],
    ["일반 국번 02", "02-123-4567 사무실"],
    ["국번 070", "070 1234 5678"],
    ["공일공(한글)", "공일공 일이삼사"],
    ["카카오톡", "카카오톡 아이디 shop123"],
    ["카톡", "카톡 주세요"],
    ["텔레그램", "텔레그램으로 연락"],
    ["인스타", "인스타 @myshop"],
    ["디스코드", "discord 서버로"],
    ["라인 아이디", "라인 아이디 abc"],
    ["위챗", "위챗 wechat123"],
    ["지메일", "제 지메일로"],
  ])("차단: %s", (_label, text) => {
    expect(hasContact(text)).toBe(true);
  });

  // 정상 사업 서술은 통과해야(과탐 회귀 방지 — insta→instant/airline 오탐 등)
  it.each([
    ["평범한 후기", "배송이 빠르고 정산도 투명한 편입니다"],
    ["instant 단어", "instant noodle 카테고리 판매"],
    ["airline 단어", "airline ticket 예약 대행"],
    ["밴드 표현", "월 거래액 중간 밴드, 흑자 전환"],
    ["빈 문자열", ""],
    ["undefined", undefined],
  ])("통과: %s", (_label, text) => {
    expect(hasContact(text as string | undefined)).toBe(false);
  });
});

describe("checkAnonymity — 2계층(block/warn)", () => {
  it("연락처는 block 레벨로 잡는다", () => {
    const f = checkAnonymity("카톡 abc 로 연락");
    expect(hasBlocking(f)).toBe(true);
    expect(f.some((x) => x.type === "contact")).toBe(true);
  });
  it("도메인 표기는 warn(차단 아님)", () => {
    const f = checkAnonymity("저희는 myshop.shop 브랜드예요");
    expect(f.some((x) => x.type === "domain")).toBe(true);
    expect(hasBlocking(f)).toBe(false);
  });
  it("단위 붙은 정확 수치는 warn", () => {
    const f = checkAnonymity("연 매출 12억 원 규모");
    expect(f.some((x) => x.type === "number")).toBe(true);
  });
  it("디렉토리 등재 플랫폼명 일치는 warn(신원 유추) — 3자 이상만 사전 등재", () => {
    const f = checkAnonymity("인터파크쇼핑 출신 팀이 만든 서비스");
    expect(f.some((x) => x.type === "platform-name")).toBe(true);
  });
  it("정상 서술은 아무 findings 없음", () => {
    expect(checkAnonymity("중립적이고 사실 위주의 소개 문장입니다")).toHaveLength(0);
  });
  it("여러 텍스트를 한 번에 검사(폼 다중 필드)", () => {
    const f = checkAnonymity("정상 제목", "카톡 id abc", undefined);
    expect(hasBlocking(f)).toBe(true);
  });
});
