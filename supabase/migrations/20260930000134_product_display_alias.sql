-- 고객에게 보이는 상품 별칭 (2026-09-27, 사장님 결정).
--
-- products.name은 정체성 키에서 조합된 이름(소: "부위 등급", 돼지·닭·오리: "삼겹살 (농장 400770)")이라
-- 등록 후 바꿀 수 없다. 공급사가 고객에게 보일 이름을 따로 정할 수 있게 별칭 칸을 둔다.
-- 별칭이 있으면 고객 화면·발주 품목 스냅샷에 별칭을, 없으면 조합된 이름을 쓴다(앱 레이어).
-- 정체성 키·중복 검사·입고 매핑은 계속 name·부위·등급·원산지를 쓰고 별칭은 보지 않는다.

ALTER TABLE public.products
    ADD COLUMN IF NOT EXISTS display_alias TEXT
        CHECK (display_alias IS NULL OR char_length(btrim(display_alias)) BETWEEN 1 AND 40);

COMMENT ON COLUMN public.products.display_alias IS
    '고객에게 보이는 상품명(공급사 설정). NULL이면 name(조합된 이름)을 그대로 보인다. 정체성 키가 아니다.';
