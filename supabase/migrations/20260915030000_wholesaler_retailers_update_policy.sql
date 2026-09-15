-- wholesaler_retailers: 공급사가 자기 거래처 행(여신 한도 등)을 수정할 수 있도록 UPDATE 정책 추가
-- (조회 정책 "Wholesaler retailers viewable by participants or admin"은 이미 존재, UPDATE만 누락되어 있었음)
CREATE POLICY "Wholesaler retailers updatable by owner wholesaler" ON public.wholesaler_retailers
    FOR UPDATE USING (wholesaler_id = public.get_current_wholesaler_id());
