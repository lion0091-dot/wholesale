#!/bin/bash
# 마이그레이션 121: 같은 소 상품을 동시에 자동 생성하려 할 때 두 번째 요청이 충돌을 삼키고 첫 번째 상품을 쓰는지.
# 세션 A가 상품을 만든 채 커밋을 미루는 동안 세션 B가 같은 키로 만들려 하면 B는 유니크 인덱스에서 기다렸다가
# A가 커밋한 뒤 unique_violation → 처리 블록이 A의 상품을 찾아 써야 한다(예전엔 소는 상품 없이 진행됐다).
# 실행: bash scripts/db-test-cattle-identity-concurrency.sh   (로컬 Docker DB, 끝에서 자기 데이터를 지운다)
PSQL="docker exec -i supabase_db_wholesale psql -U postgres -v ON_ERROR_STOP=1 -At"
U=22222222-2222-2222-2222-222222222222
W=bbbbbbbb-0000-0000-0000-000000000009

cleanup() {
  # wholesalers 삭제가 상품·스캔·원장을 함께 지운다. profiles의 트리거는 테스트 중에만 끈다.
  $PSQL >/dev/null <<SQL
delete from public.wholesalers where id='$W';
delete from public.master_livestock where trace_no in ('002999900001','002999900002');
alter table public.profiles disable trigger user;
delete from public.profiles where id='$U';
alter table public.profiles enable trigger user;
delete from auth.users where id='$U';
SQL
}
cleanup

$PSQL <<SQL
insert into auth.users (id,email) values ('$U','conc@t.com');
alter table public.profiles disable trigger user;
insert into public.profiles (id,role,name,phone) values ('$U','wholesaler','C','010') on conflict (id) do update set role=excluded.role;
alter table public.profiles enable trigger user;
insert into public.wholesalers (id,profile_id,business_name,business_number,representative_name) values ('$W','$U','동시성축산','1110000099','C');
grant execute on function public.upsert_master_livestock(text,text,text,jsonb,text,text,text,text,date,text,text,text,text,date) to authenticated;
set role authenticated;
set request.jwt.claim.sub = '$U';
select public.upsert_master_livestock('002999900001','individual','mtrace_livestock','{}'::jsonb,'한우','소','등심','1++',current_date-3,'○○도축장');
select public.upsert_master_livestock('002999900002','individual','mtrace_livestock','{}'::jsonb,'한우','소','등심','1++',current_date-3,'○○도축장');
select public.record_inbound_scan('002999900001', 8.2, 'BARCODE_SCAN') -> 'status';
select public.record_inbound_scan('002999900002', 7.5, 'BARCODE_SCAN') -> 'status';
SQL

SCAN1=$($PSQL -c "select id from public.inbound_scans where trace_no='002999900001'")
SCAN2=$($PSQL -c "select id from public.inbound_scans where trace_no='002999900002'")

# 세션 A: 상품을 만들고 4초 뒤 커밋
( $PSQL > /tmp/conc_a.out 2>&1 <<SQL
begin;
set role authenticated;
set request.jwt.claim.sub = '$U';
select public.autocreate_product_for_scan('$SCAN1'::uuid) ->> 'product_id';
select pg_sleep(4);
commit;
SQL
) &
sleep 1.5
# 세션 B: 같은 키로 만들려 함 — A가 커밋할 때까지 기다려야 한다
$PSQL > /tmp/conc_b.out 2>&1 <<SQL
begin;
set role authenticated;
set request.jwt.claim.sub = '$U';
select public.autocreate_product_for_scan('$SCAN2'::uuid) ->> 'product_id';
commit;
SQL
wait

UUID_RE='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
A_PRODUCT=$(grep -m1 -E "$UUID_RE" /tmp/conc_a.out)
B_PRODUCT=$(grep -m1 -E "$UUID_RE" /tmp/conc_b.out)
COUNT=$($PSQL -c "select count(*) from public.products where wholesaler_id='$W'")

echo "A product: $A_PRODUCT"
echo "B product: $B_PRODUCT"
echo "products created: $COUNT"
grep -i error /tmp/conc_a.out /tmp/conc_b.out

FAIL=0
[ -n "$A_PRODUCT" ] && [ "$A_PRODUCT" = "$B_PRODUCT" ] && echo "PASS 두 번째 요청이 첫 번째 상품을 사용" || { echo "FAIL 두 요청의 상품이 다름/없음"; FAIL=1; }
[ "$COUNT" = "1" ] && echo "PASS 상품은 1개만 생성" || { echo "FAIL 상품 수 $COUNT"; FAIL=1; }
cleanup
exit $FAIL
