-- ====================================================================
-- 205: 운영에만 남아 있던 옛 서명(overload) 함수 2개 정리
--
-- get_row_audit_log(uuid,text,uuid) / get_wholesaler_retailer_audit_log(uuid,uuid) —
-- 페이지네이션(p_limit·p_offset)을 붙이면서 새 서명이 추가됐고 옛 서명은 로컬 DB(마이그레이션만으로 만든 DB)에는 없다.
-- 앱은 새 서명만 부른다(app/actions/audit-log.ts, app/dashboard/receivables/actions.ts). 옛 것은 권한 구멍은 아니었으나
-- (SECURITY DEFINER + auth.uid 검사, anon 불가) 점검 대상만 늘리므로 지운다. 로컬은 이미 없어 IF EXISTS.
-- ====================================================================

drop function if exists public.get_row_audit_log(uuid, text, uuid);
drop function if exists public.get_wholesaler_retailer_audit_log(uuid, uuid);
