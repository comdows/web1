-- ============================================================
-- 세모플 0037 — QA 하드닝(적대적 표면 방어 보강)
-- (0001~0036 실행된 DB에 이어 실행 · 멱등)
-- 배경: QA 라운드에서 확정된 서버측 방어 공백 2건 수정.
--   ① 0036이 재부여한 정책 헬퍼 grant에서 is_own_post/is_own_deal이 빠져 있었다.
--      이 둘은 partner_post_interests/deal_interests INSERT with check에 인라인되므로,
--      grant 유실 시 authenticated의 관심 등록이 "permission denied for function"으로 전건 실패한다
--      (collect.mjs와 동일 계열 장애 — 관심 등록 경로에서 재발 가능). 방어적 재부여.
--   ② reviews.body·deal_questions(question/answer)에 연락처 차단 CHECK가 없어,
--      공개 뷰(v_reviews_public·v_deal_questions_public)로 연락처가 노출될 수 있었다.
--      익명성 불변 원칙(클라 anonymity.ts + DB check 이중화)에 맞춰 서버 CHECK 추가.
--      패턴은 0009와 동일 기준(클라 CONTACT_RE와 동시 갱신 규칙 유지). NOT VALID — 신규 행만 검사.
-- ============================================================

-- ── 1) 정책 헬퍼 grant 재부여(0036 누락분 — is_own_*) ──
grant execute on function public.is_own_post(uuid) to authenticated;
grant execute on function public.is_own_deal(text) to authenticated;

-- ── 2) 연락처 차단 CHECK 확대(reviews·deal_questions) — 0009 패턴과 동일 기준 ──
alter table public.reviews drop constraint if exists chk_review_nocontact;
alter table public.reviews add constraint chk_review_nocontact
  check ( body !~* '(@|https?://|www\.|0\d{1,2}[-. ]?\d{3,4}[-. ]?\d{4}|공일공|카카오톡|카톡|kakao|텔레그램|텔레그람|telegram|인스타|\yinsta(gram)?\y|디스코드|discord|(^|[^가-힣])라인\s?아이디|\yline[ -]?id\y|위챗|wechat|지메일)' ) not valid;

alter table public.deal_questions drop constraint if exists chk_dq_question_nocontact;
alter table public.deal_questions add constraint chk_dq_question_nocontact
  check ( question !~* '(@|https?://|www\.|0\d{1,2}[-. ]?\d{3,4}[-. ]?\d{4}|공일공|카카오톡|카톡|kakao|텔레그램|텔레그람|telegram|인스타|\yinsta(gram)?\y|디스코드|discord|(^|[^가-힣])라인\s?아이디|\yline[ -]?id\y|위챗|wechat|지메일)' ) not valid;

alter table public.deal_questions drop constraint if exists chk_dq_answer_nocontact;
alter table public.deal_questions add constraint chk_dq_answer_nocontact
  check ( answer is null or answer !~* '(@|https?://|www\.|0\d{1,2}[-. ]?\d{3,4}[-. ]?\d{4}|공일공|카카오톡|카톡|kakao|텔레그램|텔레그람|telegram|인스타|\yinsta(gram)?\y|디스코드|discord|(^|[^가-힣])라인\s?아이디|\yline[ -]?id\y|위챗|wechat|지메일)' ) not valid;
