/**
 * 재고 재설계 1단계(마이그 191) — 로트 구성 순회·박스 꼬리표. 실제 로컬 DB로
 * (1) 로트 원문 → 구성 개체 요약(같으면 값·다르면 혼합·BMS는 전원 1++일 때만)
 * (2) 박스를 찍으면 꼬리표가 조회 값으로 채워지고, 상품이 정해지면 부위·냉장/냉동이 상품에서 채워지는지
 * (3) 조회가 늦게 들어와도(캐시 갱신) 그 번호 박스의 꼬리표가 따라잡는지
 * (4) 전환 미리보기(혼합 로트가 특정 등급 상품에 꽂힌 박스)가 잡히는지 본다.
 * 원문 모양은 2026-10-01 실조회 L02011163016114의 필드명 그대로다.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actAs, adminClient, getActorClient, seedWorld, type World } from "./harness";

let world: World;

function member(no: string, grade: string, slaughter: string, insfat?: string) {
  return {
    butcheryPlaceNm: "농협음성축산물공판장",
    butcheryYmd: slaughter,
    cattleNo: no,
    corpNo: "1258124125",
    farmAddr: "경상북도 예천군",
    gradeNm: grade,
    ...(insfat ? { insfat } : {}),
    infoType: "9",
    lotNo: "L0TEST",
    lsTypeNm: "한우",
    processPlaceNm: "(주)가공장",
    traceNoType: "CATTLE|LOT_NO",
  };
}

function lotPayload(lotNo: string, members: Array<Record<string, unknown>>) {
  return {
    response: {
      header: { resultCode: "00", resultMsg: "NORMAL SERVICE." },
      body: { items: { item: [{ corpNo: "1258124125", infoType: "8", lotNo, processPlaceNm: "(주)가공장", traceNoType: "CATTLE|LOT_NO" }, ...members] } },
    },
  };
}

beforeAll(async () => {
  world = await seedWorld();
});

afterAll(async () => {
  await world?.cleanup();
});

describe("로트 구성 요약", () => {
  it("등급이 섞이면 혼합 + 구성표, 도축일은 범위, BMS·성별은 없음", async () => {
    const admin = adminClient();
    const { data } = await admin.rpc("lot_summary", {
      p_members: (
        await admin.rpc("lot_members", {
          p_payload: lotPayload("L0MIX", [
            member("410000000000001", "1+", "20201103"),
            member("410000000000002", "1", "20201110"),
            member("410000000000003", "1++", "20201111", "9"),
            member("410000000000004", "1++", "20201112", "9"),
          ]),
        })
      ).data,
    });

    expect(data).toEqual({
      member_count: 4,
      grade: "혼합",
      grade_mix: { "1": 1, "1+": 1, "1++": 2 },
      breed: "한우",
      slaughter_from: "2020-11-03",
      slaughter_to: "2020-11-12",
    });
  });

  it("전부 같은 등급이면 그 값, 전원 1++이고 BMS가 같으면 BMS도", async () => {
    const admin = adminClient();
    const same = await admin.rpc("lot_summary", {
      p_members: (
        await admin.rpc("lot_members", {
          p_payload: lotPayload("L0SAME", [member("410000000000011", "1++", "20201103", "8"), member("410000000000012", "1++", "20201104", "8")]),
        })
      ).data,
    });

    expect(same.data).toMatchObject({ member_count: 2, grade: "1++", bms: "8", grade_mix: { "1++": 2 } });

    const bmsDiffers = await admin.rpc("lot_summary", {
      p_members: (
        await admin.rpc("lot_members", {
          p_payload: lotPayload("L0BMS", [member("410000000000021", "1++", "20201103", "8"), member("410000000000022", "1++", "20201104", "9")]),
        })
      ).data,
    });

    expect(bmsDiffers.data).toMatchObject({ grade: "1++" });
    expect((bmsDiffers.data as { bms?: string }).bms).toBeUndefined();
  });

  it("로트 머리 항목(개체번호 없음)은 구성원으로 세지 않고, 빈 원문은 빈 목록", async () => {
    const admin = adminClient();

    expect((await admin.rpc("lot_members", { p_payload: lotPayload("L0EMPTY", []) })).data).toEqual([]);
    expect((await admin.rpc("lot_summary", { p_members: [] })).data).toEqual({ member_count: 0 });
  });
});

describe("박스 꼬리표", () => {
  it("로트 박스는 혼합 등급·구성표·도축일 범위를 갖고 성별은 비며, 상품이 정해지면 부위·냉장/냉동은 상품에서 온다", async () => {
    const admin = adminClient();
    const lotNo = `L0${String(Date.now()).slice(-9)}${String(Math.floor(Math.random() * 1e5)).padStart(5, "0")}`;

    await world.seedTrace(lotNo, {
      traceKind: "group",
      grade: "1+", // 옛 대표값(첫 개체) — 꼬리표는 이걸 쓰면 안 된다
      rawPayload: lotPayload(lotNo, [
        member("410000000000031", "1+", "20201103"),
        member("410000000000032", "1", "20201110"),
        member("410000000000033", "1++", "20201111", "9"),
      ]),
    });

    const { data: master } = await admin.from("master_livestock").select("member_count, grade_mix, slaughter_from, slaughter_to").eq("trace_no", lotNo).single();

    expect(master).toEqual({ member_count: 3, grade_mix: { "1": 1, "1+": 1, "1++": 1 }, slaughter_from: "2020-11-03", slaughter_to: "2020-11-11" });

    const scanId = randomUUID();

    expect(
      (
        await admin.from("inbound_scans").insert({
          id: scanId,
          wholesaler_id: world.wholesalerA,
          trace_no: lotNo,
          weight: 20,
          unit: "kg",
          scan_type: "MANUAL",
          status: "PENDING_MAPPING",
        })
      ).error
    ).toBeNull();

    const tags = () => admin.from("inbound_scans").select("tag_species, tag_part, tag_origin, tag_grade, tag_grade_mix, tag_sex, tag_bms, tag_breed, tag_storage_state, slaughter_from, slaughter_to, tag_source").eq("id", scanId).single();

    let { data: box } = await tags();

    expect(box).toMatchObject({
      tag_species: "소",
      tag_part: "등심", // 시드 master가 부위를 준 경우(조회 값)
      tag_origin: "국내산",
      tag_grade: "혼합",
      tag_grade_mix: { "1": 1, "1+": 1, "1++": 1 },
      tag_sex: null,
      tag_bms: null,
      tag_breed: "한우",
      tag_storage_state: null,
      slaughter_from: "2020-11-03",
      slaughter_to: "2020-11-11",
    });
    expect(box?.tag_source).toMatchObject({ grade: "lookup", part: "lookup" });

    // 상품(냉동 등심)을 꽂으면 냉장/냉동은 상품에서, 등급은 여전히 조회(혼합)
    const product = await world.createProduct({ category: "소", subcategory: "등심", grade: "1+", origin: "국내산", breed: "한우", storage_state: "냉동" });

    expect((await admin.from("inbound_scans").update({ product_id: product.id, status: "NORMAL", remaining_weight: 20 }).eq("id", scanId)).error).toBeNull();

    ({ data: box } = await tags());
    expect(box).toMatchObject({ tag_grade: "혼합", tag_storage_state: "냉동", tag_part: "등심" });
    expect(box?.tag_source).toMatchObject({ storage: "product" });

    // 전환 미리보기: 혼합 로트가 '1+' 상품에 꽂혀 있는 박스가 잡힌다.
    await actAs(world.users.ownerA);
    const { data: preview } = await getActorClient().rpc("preview_mixed_lot_boxes", { p_wholesaler_id: world.wholesalerA });

    expect((preview as Array<{ scan_id: string; product_grade: string }>).map((row) => [row.scan_id, row.product_grade])).toContainEqual([scanId, "1+"]);

    await admin.from("inbound_scans").delete().eq("id", scanId);
  });

  it("개체번호 박스는 등급·성별·BMS를 그대로 갖고, 조회가 늦게 들어와도 꼬리표가 따라잡는다", async () => {
    const admin = adminClient();
    const traceNo = world.newTraceNo("0");
    const scanId = randomUUID();

    // 조회 전(EXCEPTION)에는 꼬리표가 비어 있다.
    expect(
      (
        await admin.from("inbound_scans").insert({
          id: scanId,
          wholesaler_id: world.wholesalerA,
          trace_no: traceNo,
          weight: 10,
          unit: "kg",
          scan_type: "MANUAL",
          status: "EXCEPTION",
        })
      ).error
    ).toBeNull();

    let { data: box } = await admin.from("inbound_scans").select("tag_grade, tag_sex, tag_species").eq("id", scanId).single();

    expect(box).toEqual({ tag_grade: null, tag_sex: null, tag_species: null });

    // 조회가 나중에 성공해 캐시에 들어오면(upsert) 박스 꼬리표가 채워진다.
    expect(
      (
        await admin.rpc("upsert_master_livestock", {
          p_trace_no: traceNo,
          p_trace_kind: "individual",
          p_source: "mtrace_livestock",
          p_raw_payload: { cattleNo: traceNo, gradeNm: "1++", insfat: "8", sexNm: "암", lsTypeNm: "한우" },
          p_species: "한우",
          p_species_group: "소",
          p_grade: "1++",
          p_sex: "암",
          p_bms: "8",
          p_slaughter_date: "2026-09-20",
        })
      ).error
    ).toBeNull();

    ({ data: box } = await admin.from("inbound_scans").select("tag_grade, tag_sex, tag_bms, tag_breed, tag_species, slaughter_from, slaughter_to").eq("id", scanId).single());

    expect(box).toEqual({ tag_grade: "1++", tag_sex: "암", tag_bms: "8", tag_breed: "한우", tag_species: "소", slaughter_from: "2026-09-20", slaughter_to: "2026-09-20" });

    await admin.from("inbound_scans").delete().eq("id", scanId);
  });
});
