-- 가입 미완료 계정 자동 정리 대상 조회 (2026-09-30, 사장님 결정: "가입 중단 후 30일 뒤 삭제")
--
-- 개인정보처리방침 3조에 적은 "동의 없이 이탈한 미완료 계정은 30일 뒤 삭제"를 실제로 지키기 위한
-- 대상 조회 함수다. 삭제 자체는 이 함수가 하지 않고, 크론(/api/cron/purge-unconsented-accounts)이
-- Supabase Auth Admin API로 한다 — auth 스키마는 공식 경로로만 만진다(withdraw 설계와 같은 원칙).
--
-- 대상 = 아래를 모두 만족하는 계정:
--   * 이용약관·개인정보 동의를 한 번도 하지 않음 (terms_agreed_at, privacy_agreed_at 둘 다 NULL)
--   * 마지막 로그인(없으면 가입 시각)이 30일 넘게 지남 — 가입 후 돌아와 진행 중인 사람은 건드리지 않는다
--   * 슈퍼관리자·탈퇴 처리된 계정 아님
--   * 업체(wholesalers)·고객(retailers)·조직 직원·관리자 명단·초대장 발부 기록이 전혀 없음
--     → 이 연결이 하나라도 있으면 사업 데이터가 걸려 있으므로 자동 삭제하지 않는다.
--       (일부는 외래키 RESTRICT가 삭제 자체를 막아 이중 안전장치가 된다.)
--
-- ⚠️ 바이어(고객)는 claim_shop_access가 로그인과 동시에 retailers 행을 만들기 때문에 이 조건에서
--    항상 제외된다. 고객 쪽 미완료 계정 정리는 공급사의 거래처 기록을 건드리게 되어 별도 결정이 필요하다.
--
-- service_role(서버) 전용. 일반 세션이 호출하면 계정 목록을 알아낼 수 있으므로 EXECUTE를 회수한다.

CREATE OR REPLACE FUNCTION public.list_stale_unconsented_accounts()
RETURNS TABLE (user_id UUID)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
    SELECT p.id
      FROM public.profiles p
      JOIN auth.users u ON u.id = p.id
     WHERE p.terms_agreed_at IS NULL
       AND p.privacy_agreed_at IS NULL
       AND p.withdrawn_at IS NULL
       AND p.role::text <> 'super_admin'
       AND COALESCE(u.last_sign_in_at, u.created_at) < now() - interval '30 days'
       AND NOT EXISTS (SELECT 1 FROM public.wholesalers w WHERE w.profile_id = p.id)
       AND NOT EXISTS (SELECT 1 FROM public.retailers r WHERE r.profile_id = p.id)
       AND NOT EXISTS (SELECT 1 FROM public.organization_staff s WHERE s.user_id = p.id)
       AND NOT EXISTS (SELECT 1 FROM public.platform_admin_allowlist a WHERE a.user_id = p.id)
       AND NOT EXISTS (SELECT 1 FROM public.retailer_invites i WHERE i.created_by = p.id);
$$;

REVOKE ALL ON FUNCTION public.list_stale_unconsented_accounts() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_stale_unconsented_accounts() TO service_role;

COMMENT ON FUNCTION public.list_stale_unconsented_accounts() IS
    '동의 없이 30일 넘게 이탈한 가입 미완료 계정 중 사업 데이터가 전혀 없는 것. 크론이 Auth Admin API로 삭제한다. service_role 전용.';
