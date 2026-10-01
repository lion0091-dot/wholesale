import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { detectTraceKind, fetchTraceRecord, MtraceError, MtraceNotConfiguredError } from "./mtrace-client";

const KAPE_URL = "http://data.ekape.or.kr/openapi-data/service/user/animalTrace/traceNoSearch";
const MEATWATCH_URL = "https://www.meatwatch.go.kr/xml/selectDistbHistInfoWsrvDetail.do";

const fetchMock = vi.fn();

/** mtrace(국내산)가 "결과 없음"일 때 — resultCode는 정상(00)이지만 개체 필드가 없다. */
const MTRACE_EMPTY_XML = `<response><header><resultCode>00</resultCode><resultMsg>OK</resultMsg></header></response>`;

/** 실제 meatwatch 응답(2026-10-01 실호출로 확인한 구조, 소고기 샘플 기준 — 값만 테스트용으로 바꿈). */
function meatwatchFoundXml(distbIdntfcNo: string): string {
  return `<root><PARAMS>
    <PARAM id="returnCode">0</PARAM>
    <PARAM id="returnMsg">정상 처리되었습니다.</PARAM>
    <PARAM id="distbIdntfcNo">${distbIdntfcNo}</PARAM>
    <PARAM id="blNo">ZIMUSYD000039188</PARAM>
    <PARAM id="kprodNm">소고기(냉동,정육(뼈없는것),소고기정육/지육)</PARAM>
    <PARAM id="limitFromDt">2028-01-26</PARAM>
    <PARAM id="limitToDt">2028-08-15</PARAM>
    <PARAM id="makeplcNm">호주</PARAM>
    <PARAM id="butchfromDt">2026-02-04</PARAM>
    <PARAM id="butchtoDt">2026-08-25</PARAM>
    <PARAM id="butchNm">JBS AUSTRALIA PTY LTD</PARAM>
    <PARAM id="prcssBeginDe">2026-02-05</PARAM>
    <PARAM id="prcssEndDe">2026-08-26</PARAM>
    <PARAM id="prcssNm">JBS AUSTRALIA PTY LTD</PARAM>
    <PARAM id="senderNm">JBS AUSTRALIA PTY LTD</PARAM>
    <PARAM id="receiverNm">(주)한중푸드</PARAM>
    <PARAM id="rtrvlContent"></PARAM>
    <PARAM id="rtrvlInjryInfoSj"></PARAM>
    <PARAM id="rtrvlInjryInfoCn"></PARAM>
    <PARAM id="occrrnccnName"></PARAM>
    <PARAM id="distbSlePrhibtAt"></PARAM>
    <PARAM id="rtrvlTrgetAt"></PARAM>
    <PARAM id="distbSlePrhibtDe"></PARAM>
    <PARAM id="refrigCnvrsAt">N</PARAM>
    <PARAM id="refrigDistbPdBeginDe"></PARAM>
    <PARAM id="refrigDistbPdEndDe"></PARAM>
    <PARAM id="applyDt">2026-09-28</PARAM>
    <PARAM id="dsuseResnCn">발행</PARAM>
    <PARAM id="regn"><REGNCODE>BF008</REGNCODE></PARAM>
    <PARAM id="regnName"><REGNNAME>양지(BF008)</REGNNAME></PARAM>
  </PARAMS></root>`;
}

const MEATWATCH_NOT_FOUND_XML = `<root><PARAMS>
    <PARAM id="returnCode">-401</PARAM>
    <PARAM id="returnMsg">조회된 데이터가 없습니다.</PARAM>
    <PARAM id="distbIdntfcNo"></PARAM>
  </PARAMS></root>`;

function textResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/xml; charset=UTF-8" } });
}

function mockFetchByUrl(handlers: { kape?: Response | Error; meatwatch?: Response | Error }) {
  fetchMock.mockImplementation(async (input: unknown) => {
    const url = String(input);

    if (url.startsWith(KAPE_URL) && handlers.kape) {
      if (handlers.kape instanceof Error) throw handlers.kape;
      return handlers.kape;
    }

    if (url.startsWith(MEATWATCH_URL) && handlers.meatwatch) {
      if (handlers.meatwatch instanceof Error) throw handlers.meatwatch;
      return handlers.meatwatch;
    }

    throw new Error(`예상하지 못한 URL 호출: ${url}`);
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  process.env.MTRACE_API_KEY = "mtrace-key";
  process.env.MEATWATCH_SYS_ID = "B2BMEAT01";
  delete process.env.POULTRY_TRACE_API_KEY;
  delete process.env.KAPE_MARKET_PRICE_API_KEY;
  delete process.env.NTS_BUSINESS_VERIFY_API_KEY;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.MTRACE_API_KEY;
  delete process.env.MEATWATCH_SYS_ID;
});

describe("detectTraceKind — 12자리 숫자는 국내산·수입 양쪽 다 가능", () => {
  it("12자리 숫자는 individual로 판별된다(실제 수입 유통식별번호도 이 형태)", () => {
    expect(detectTraceKind("801000311592")).toBe("individual");
    expect(detectTraceKind("915169500007")).toBe("individual");
  });
});

describe("12자리 숫자 — mtrace 먼저, 없으면 meatwatch로 폴백", () => {
  it("mtrace에서 못 찾으면 meatwatch를 추가로 시도해 찾아낸다", async () => {
    mockFetchByUrl({
      kape: textResponse(MTRACE_EMPTY_XML),
      meatwatch: textResponse(meatwatchFoundXml("801000311592")),
    });

    const record = await fetchTraceRecord("801000311592");

    expect(record).not.toBeNull();
    expect(record?.source).toBe("meatwatch_imported");
    expect(record?.traceKind).toBe("imported");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("수입육 조회는 암호화된 https로 호출한다(시스템ID가 주소에 실린다)", async () => {
    mockFetchByUrl({
      kape: textResponse(MTRACE_EMPTY_XML),
      meatwatch: textResponse(meatwatchFoundXml("801000311592")),
    });

    await fetchTraceRecord("801000311592");

    const urls = fetchMock.mock.calls.map((call) => String(call[0]));

    expect(urls.some((url) => url.startsWith("https://www.meatwatch.go.kr/"))).toBe(true);
    expect(urls.some((url) => url.startsWith("http://www.meatwatch.go.kr/"))).toBe(false);
  });

  it("앞 조회가 오래 걸렸으면 뒤 조회는 남은 시간만 기다린다(전체 대기가 두 배가 되지 않는다)", async () => {
    mockFetchByUrl({
      kape: textResponse(MTRACE_EMPTY_XML),
      meatwatch: textResponse(meatwatchFoundXml("801000311592")),
    });

    const timeouts: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
      if (typeof ms === "number") timeouts.push(ms);

      return realSetTimeout(fn, ms);
    }) as typeof setTimeout);
    // 시작 시각 0 → 이후 8초가 흐른 것으로 본다.
    const nowSpy = vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(8_000);

    try {
      await fetchTraceRecord("801000311592");
    } finally {
      timeoutSpy.mockRestore();
      nowSpy.mockRestore();
    }

    // 첫 조회(mtrace)는 8초, 뒤 조회(meatwatch)는 남은 시간이 없어 최소 보장 2초.
    expect(timeouts.filter((ms) => ms === 8_000 || ms === 2_000)).toEqual([8_000, 2_000]);
  });

  it("mtrace에서 찾으면 meatwatch는 아예 호출하지 않는다", async () => {
    mockFetchByUrl({
      kape: textResponse(
        `<response><header><resultCode>00</resultCode></header><cattleNo>801000311592</cattleNo></response>`
      ),
    });

    const record = await fetchTraceRecord("801000311592");

    expect(record?.source).toBe("mtrace_livestock");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("둘 다 결과 없으면 null", async () => {
    mockFetchByUrl({
      kape: textResponse(MTRACE_EMPTY_XML),
      meatwatch: textResponse(MEATWATCH_NOT_FOUND_XML),
    });

    const record = await fetchTraceRecord("801000311592");

    expect(record).toBeNull();
  });
});

describe("meatwatch 응답 파싱 — 실제 필드 구조(2026-10-01 실호출 기준)", () => {
  it("품목명에서 축종, regnName에서 부위(코드 제거)를 뽑는다", async () => {
    mockFetchByUrl({
      kape: textResponse(MTRACE_EMPTY_XML),
      meatwatch: textResponse(meatwatchFoundXml("801000311592")),
    });

    const record = await fetchTraceRecord("801000311592");

    expect(record).toMatchObject({
      species: "소고기",
      speciesGroup: "소",
      partName: "양지",
      grade: null,
      sex: null,
      bms: null,
      slaughterDate: "2026-02-04",
      packingDate: "2026-02-05",
      butcheryPlace: "JBS AUSTRALIA PTY LTD",
      farmName: null,
      originCountry: "호주",
      importerName: "(주)한중푸드",
    });
  });

  it("돼지 샘플도 동일 구조로 파싱된다", async () => {
    const pigXml = `<root><PARAMS>
      <PARAM id="returnCode">0</PARAM>
      <PARAM id="returnMsg">정상 처리되었습니다.</PARAM>
      <PARAM id="distbIdntfcNo">915169500007</PARAM>
      <PARAM id="kprodNm">돼지고기(냉동,발,돼지고기부산물)</PARAM>
      <PARAM id="makeplcNm">독일</PARAM>
      <PARAM id="butchfromDt">2026-04-17</PARAM>
      <PARAM id="butchNm">WESTFLEISCH SCE MBH</PARAM>
      <PARAM id="prcssBeginDe">2026-04-18</PARAM>
      <PARAM id="receiverNm">(주)유니푸드시스템</PARAM>
      <PARAM id="regn"><REGNCODE>PK009</REGNCODE></PARAM>
      <PARAM id="regnName"><REGNNAME>부산물(PK009)</REGNNAME></PARAM>
    </PARAMS></root>`;

    mockFetchByUrl({ kape: textResponse(MTRACE_EMPTY_XML), meatwatch: textResponse(pigXml) });

    const record = await fetchTraceRecord("915169500007");

    expect(record).toMatchObject({
      species: "돼지고기",
      speciesGroup: "돼지",
      partName: "부산물",
      originCountry: "독일",
      importerName: "(주)유니푸드시스템",
    });
  });

  it("returnCode가 그 외 오류 코드면 returnMsg와 함께 던진다", async () => {
    const errorXml = `<root><PARAMS>
      <PARAM id="returnCode">-500</PARAM>
      <PARAM id="returnMsg">시스템ID가 올바르지 않습니다.</PARAM>
    </PARAMS></root>`;

    mockFetchByUrl({ kape: textResponse(MTRACE_EMPTY_XML), meatwatch: textResponse(errorXml) });

    await expect(fetchTraceRecord("801000311592")).rejects.toThrow("시스템ID가 올바르지 않습니다");
  });

  it("HTTP 오류면 MtraceError를 던진다", async () => {
    mockFetchByUrl({ kape: textResponse(MTRACE_EMPTY_XML), meatwatch: textResponse("", 500) });

    await expect(fetchTraceRecord("801000311592")).rejects.toThrow(MtraceError);
  });
});

describe("MEATWATCH_SYS_ID 미설정", () => {
  it("mtrace만 설정돼 있으면 meatwatch는 조용히 건너뛴다(오류 아님)", async () => {
    delete process.env.MEATWATCH_SYS_ID;
    mockFetchByUrl({ kape: textResponse(MTRACE_EMPTY_XML) });

    const record = await fetchTraceRecord("801000311592");

    expect(record).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("아무 키도 없으면 MtraceNotConfiguredError", async () => {
    delete process.env.MTRACE_API_KEY;
    delete process.env.MEATWATCH_SYS_ID;

    await expect(fetchTraceRecord("801000311592")).rejects.toThrow(MtraceNotConfiguredError);
  });
});
