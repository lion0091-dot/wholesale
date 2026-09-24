-- 110. 공급사 외부연동 자격정보 컬럼(알림톡·토스 시크릿키)을 클라이언트 세션에서 읽지 못하게 한다.
--
-- 발견(scripts/db-test-alimtalk-credentials.sql): wholesalers SELECT 정책은 연결 거래처·소속 직원(staff 포함)에게
-- 그 행 전체를 보여주고 컬럼 권한도 열려 있어서, API를 직접 호출하면 공급사의 알림톡 계정·암호화 비밀번호·
-- 발신프로필키·템플릿 코드와 토스 시크릿키(암호문)를 읽을 수 있었다. "owner/manager만"이라는 결정이
-- 화면에서만 지켜지고 있었다.
--
-- 수정: anon·authenticated의 wholesalers 테이블 단위 SELECT를 회수하고, 아래 숨길 컬럼을 뺀 나머지 컬럼에만
-- 컬럼 단위 SELECT를 다시 준다. 서버 액션은 service_role로 읽고 쓴다(lib/security/wholesaler-credentials.ts).
--
-- 주의(유지보수): 앞으로 wholesalers에 컬럼을 추가하면 authenticated가 읽어야 하는 컬럼은
--   GRANT SELECT (새컬럼) ON public.wholesalers TO anon, authenticated;
-- 를 그 마이그레이션에서 같이 줘야 한다(기본은 "안 보임"). 또 세션 클라이언트에서 wholesalers를 select('*')로
-- 읽으면 권한 오류가 나므로 컬럼을 명시할 것.

do $$
declare
    v_cols text;
begin
    select string_agg(format('%I', column_name), ', ' order by ordinal_position)
      into v_cols
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'wholesalers'
       and column_name not like 'alimtalk\_%'
       and column_name <> 'pg_secret_key_encrypted';

    execute 'revoke select on public.wholesalers from anon, authenticated';
    execute format('grant select (%s) on public.wholesalers to anon, authenticated', v_cols);
end $$;
