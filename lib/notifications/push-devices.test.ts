import { describe, expect, it } from "vitest";
import { describeDevice, isAlertGap, type PushDevice } from "./push-devices";

const IPHONE_SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
const ANDROID_CHROME = "Mozilla/5.0 (Linux; Android 14; SM-S918N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36";
const ANDROID_SAMSUNG = "Mozilla/5.0 (Linux; Android 14; SM-S918N) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0 Mobile Safari/537.36";
const WINDOWS_EDGE = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 Edg/124.0";
const WINDOWS_CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

describe("describeDevice", () => {
  it("기기와 브라우저를 사람이 읽는 말로 줄인다", () => {
    expect(describeDevice(IPHONE_SAFARI)).toBe("아이폰 · 사파리");
    expect(describeDevice(ANDROID_CHROME)).toBe("안드로이드 · 크롬");
    expect(describeDevice(WINDOWS_CHROME)).toBe("윈도우 PC · 크롬");
  });

  it("UA에 Chrome이 같이 들어 있는 엣지·삼성 인터넷을 크롬으로 잘못 부르지 않는다", () => {
    expect(describeDevice(WINDOWS_EDGE)).toBe("윈도우 PC · 엣지");
    expect(describeDevice(ANDROID_SAMSUNG)).toBe("안드로이드 · 삼성 인터넷");
  });

  it("비었거나 모르는 값은 알 수 없는 기기", () => {
    expect(describeDevice(null)).toBe("알 수 없는 기기");
    expect(describeDevice("")).toBe("알 수 없는 기기");
    expect(describeDevice("curl/8.0")).toBe("알 수 없는 기기");
  });
});

describe("isAlertGap", () => {
  const device: PushDevice = { id: "d1", userName: "김대표", label: "아이폰 · 사파리", createdAt: "2026-10-03T00:00:00Z", lastUsedAt: null };

  it("알림톡 폴백이 꺼져 있고 알림을 켠 기기가 0대일 때만 경고한다", () => {
    expect(isAlertGap(false, [])).toBe(true);
    expect(isAlertGap(false, [device])).toBe(false);
    expect(isAlertGap(true, [])).toBe(false);
  });

  it("기기 목록을 못 읽었으면(null) 모르는 것이라 경고하지 않는다", () => {
    expect(isAlertGap(false, null)).toBe(false);
  });
});
