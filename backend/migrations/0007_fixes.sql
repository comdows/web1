-- 0007 — 데이터 정정 (재실행 안전)
-- 올웨이즈: URL이 노트폴리오(notefolio.net)로 잘못 배정돼 있던 확정 오류 정정
update public.platforms set url = 'https://alwayz.co' where id = 'allways';
