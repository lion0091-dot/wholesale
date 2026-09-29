-- ====================================================================
-- organizations.business_number를 선택 항목으로 완화 (사장님 지적, 2026-09-30)
--
-- "2단계 조직 생성"(app/onboarding의 레거시 경로, 1단계 온보딩 이전 계정·슈퍼관리자
-- 전용)에서 사업자등록번호가 필수였는데, 정작 현재 기본 가입 경로인 1단계
-- (complete_supplier_signup, wholesalers.business_number)는 이미 2026-09-14부터
-- 선택 항목이었다(마이그레이션 20260914000000). "사업자 번호 없는 경우도 있을 수
-- 있다"는 사장님 지적으로 organizations 쪽도 wholesalers와 같은 규칙으로 맞춘다.
-- UNIQUE 제약은 그대로 둔다 — Postgres는 NULL끼리 유니크 충돌로 안 본다.
-- ====================================================================

ALTER TABLE public.organizations ALTER COLUMN business_number DROP NOT NULL;
