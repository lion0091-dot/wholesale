/**
 * 공공 이력조회 결과를 공용 캐시(master_livestock)에 적재한다 — 서버 전용.
 *
 * upsert_master_livestock은 20260930000098부터 service_role만 실행할 수 있다.
 * 전 업체 공용 캐시라 브라우저 세션(anon 키 + 사용자 JWT)이 직접 부를 수 있으면
 * 한 업체가 아무 이력번호의 등급·도축일을 덮어써 다른 업체의 거래명세서·라벨에
 * 허위 값이 찍힐 수 있기 때문이다. 정부 API를 실제로 호출하는 건 서버 액션뿐이니
 * 적재도 서버가 service_role 클라이언트로만 한다.
 *
 * 이 모듈은 SUPABASE_SERVICE_ROLE_KEY를 참조하므로 클라이언트 번들에 들어가면 안 된다.
 */

import { createServiceRoleClient } from "@/lib/supabase/service-role-client";
import { MtraceNotConfiguredError, type MtraceRecord } from "@/lib/livestock/mtrace-client";

/**
 * 조회 결과 1건을 캐시에 넣는다(있으면 갱신).
 *
 * service_role 키가 서버에 없으면 MtraceNotConfiguredError를 던진다 — 호출부는
 * 이걸 "재시도해도 안 되는 설정 문제"로 안내한다(이력 조회 인증키 미설정과 같은 취급).
 * 그 밖의 DB 오류는 일반 Error로 올린다.
 */
export async function cacheTraceRecord(record: MtraceRecord): Promise<void> {
  const admin = createServiceRoleClient();

  if (!admin) {
    throw new MtraceNotConfiguredError(
      "서버 환경변수 SUPABASE_SERVICE_ROLE_KEY가 없어 이력 정보를 저장할 수 없습니다. 운영자가 Vercel 환경변수에 설정해야 합니다."
    );
  }

  const { error } = await admin.rpc("upsert_master_livestock", {
    p_trace_no: record.traceNo,
    p_trace_kind: record.traceKind,
    p_source: record.source,
    p_raw_payload: record.rawPayload,
    p_species: record.species,
    p_species_group: record.speciesGroup,
    p_part_name: record.partName,
    p_grade: record.grade,
    p_slaughter_date: record.slaughterDate,
    p_butchery_place: record.butcheryPlace,
    p_farm_name: record.farmName,
    p_origin_country: record.originCountry,
    p_importer_name: record.importerName,
    p_packing_date: record.packingDate,
  });

  if (error) {
    throw new Error(`이력 캐시 저장 실패: ${error.message}`);
  }
}
