-- CREATE OR REPLACE FUNCTION은 매개변수 개수가 다른 기존 오버로드를 지우지 않는다.
-- 20260928000000에서 submit_supplier_business_number(TEXT, DATE)를 새로 만들었지만
-- 구버전 submit_supplier_business_number(TEXT)가 그대로 남아 애플리케이션이 쓰지 않는
-- 죽은 코드로 방치된다. 정리한다.
DROP FUNCTION IF EXISTS public.submit_supplier_business_number(TEXT);
