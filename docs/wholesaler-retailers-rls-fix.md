# wholesaler_retailers RLS 정책 누락 (심각 버그) 수정

## 발견 경위
바이어가 "여러 도매업체 초대장을 받았을 때 어떻게 오가는지" 논의 중, 이동용 "내 거래처" 목록 페이지를 설계하다가 발견. `wholesaler_retailers` 조회가 RLS에 막힌다는 걸 확인하면서, 이 테이블을 참조하는 다른 정책들도 같은 이유로 깨져있었다는 게 드러났다.

## 문제
`public.wholesaler_retailers`(초기 스키마 `20260909000000`)는 `ENABLE ROW LEVEL SECURITY`만 켜졌고 **`CREATE POLICY`가 단 하나도 없었다.** RLS가 켜진 테이블에 정책이 0개면 Postgres 기본 동작은 전원 차단이다. `GRANT SELECT ... TO authenticated`(`20260913000000`)는 테이블 권한일 뿐이라 이 차단을 풀어주지 못한다.

`wholesalers`/`retailers`/`products`/`orders` 정책의 "연결된 거래처면 보임" 조건은 전부 `wholesaler_retailers`를 인라인 서브쿼리로 참조하는데(`SECURITY DEFINER` 함수로 감싸지 않음), 이 서브쿼리도 **현재 쿼리를 실행하는 실제 세션(authenticated 롤)의 RLS를 그대로 적용받는다.** 정책이 0개인 동안 이 서브쿼리는 항상 빈 결과였고, 따라서 이 조건은 항상 거짓이었다.

## 확인된 영향 범위
| 경로 | 증상 |
|---|---|
| `loadShopCatalog()` (`/shop/<token>`) | 연결된 바이어도 `wholesalers` SELECT가 항상 실패 → `status !== 'active'`로 오인 → **실제 카탈로그 대신 항상 데모 카탈로그로 폴백** |
| `submitOrderAction()` (발주 제출) | 위 버그로 `catalog.isDemo === true`가 되어 `buyer`가 항상 `null` → 실제 `orders` INSERT 코드 경로 자체가 실행되지 않음(에러로 드러나지 않고 조용히 데모 모드로만 동작) |
| `app/dashboard/customers/page.tsx` (공급사 본인의 고객 관리) | 같은 서브쿼리 패턴이라 **공급사가 자기 거래처 목록을 조회해도 항상 빈 목록** |

세 번째가 특히 중요 — 바이어 쪽 문제만이 아니라 **공급사가 쓰는 기존 화면도 이미 깨져 있었다.**

## 수정
`supabase/migrations/20260924000000_fix_wholesaler_retailers_rls.sql` — 다른 테이블(`custom_prices`, `orders`)과 동일한 패턴으로 SELECT 정책 추가:
```sql
CREATE POLICY "Wholesaler retailers viewable by participants or admin" ON public.wholesaler_retailers
    FOR SELECT USING (
        wholesaler_id = public.get_current_wholesaler_id()
        OR retailer_id = public.get_current_retailer_id()
        OR public.get_current_role() = 'super_admin'
    );
```
INSERT/UPDATE는 전부 `SECURITY DEFINER` 함수(`claim_shop_access` 등, 테이블 소유자 권한으로 RLS 우회)를 거치고 세션 클라이언트로 직접 쓰는 코드 경로가 없어서 SELECT 정책만 추가했다.

**적용/검증**: SQL Editor 적용 후 `pg_policies`로 정책 등록 확인(`qual` 컬럼 내용 대조) — 완료. 실제 카카오 로그인 단말로 카탈로그/발주/고객관리 화면이 실데이터를 보여주는지는 **아직 라이브 재검증 안 함** — 다음에 실제 계정으로 확인 필요.

**커밋**: `97d0254`.

## 관련 후속 작업
- [내 거래처 목록 페이지](../app/my-shops/page.tsx) (커밋 `d1c88ef`) — 이 수정에 의존해서 동작. 여러 도매업체와 연결된 바이어가 각 미니샵을 오갈 수 있는 화면. 상호명 + 이동 링크만 노출하고 상품/단가는 절대 포함하지 않아, 한 화면에서 여러 도매업체를 동시 로드해 비교 구매하는 것을 구조적으로 차단(명시적 요구사항).
