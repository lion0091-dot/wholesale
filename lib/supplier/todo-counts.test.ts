import { INBOUND_ANCHORS } from "@/lib/livestock/inbound-next-step";
import { describe, expect, it } from "vitest";
import { TODO_ITEMS, totalTodo, visibleTodoItems, type TodoCounts } from "./todo-counts";

const counts = (overrides: Partial<TodoCounts> = {}): TodoCounts => ({
  newOrders: 0,
  cancelRequests: 0,
  needsCheckBoxes: 0,
  openDocuments: 0,
  lateBoxes: 0,
  ...overrides,
});

describe("종 배지 합계", () => {
  it("전부 0이면 0", () => {
    expect(totalTodo(counts())).toBe(0);
  });

  it("모든 항목을 더한다", () => {
    expect(totalTodo(counts({ newOrders: 3, cancelRequests: 1, needsCheckBoxes: 2, openDocuments: 4, lateBoxes: 2 }))).toBe(12);
  });

  it("목록 키가 카운트 키와 하나도 빠지거나 겹치지 않는다", () => {
    const keys = TODO_ITEMS.map((item) => item.key).sort();

    expect(keys).toEqual(Object.keys(counts()).sort());
  });
});

describe("폰 화면의 종 배지", () => {
  it("폰에서는 사무실 전용 항목(대조 중인 전표)을 목록과 합계에서 뺀다", async () => {
    const { visibleTodoItems } = await import("./todo-counts");
    const all = counts({ newOrders: 1, openDocuments: 4, lateBoxes: 2 });

    expect(visibleTodoItems(true).map((item) => item.key)).not.toContain("openDocuments");
    expect(visibleTodoItems(true).map((item) => item.key)).not.toContain("lateBoxes");
    expect(visibleTodoItems(false).map((item) => item.key)).toContain("openDocuments");
    expect(totalTodo(all, true)).toBe(1);
    expect(totalTodo(all, false)).toBe(7);
  });
});

describe("종 배지 링크 — 눌렀을 때 도착하는 자리", () => {
  it("확인 필요 박스는 입고 스캔 화면 맨 위 '지금 할 일' 카드로 간다(그 카드가 확인 필요 박스를 먼저 처리하라고 말한다)", () => {
    const item = TODO_ITEMS.find((entry) => entry.key === "needsCheckBoxes");

    expect(item?.href).toBe(`/dashboard/inbound${INBOUND_ANCHORS.nextStep}`);
  });

  it("어느 화면·기기(PC·폰)에서 알림을 눌러도 도착 자리는 항목마다 하나로 같다(링크가 상황에 따라 달라지지 않는다)", () => {
    const pc = visibleTodoItems(false);
    const phone = visibleTodoItems(true);

    for (const item of phone) {
      expect(pc.find((entry) => entry.key === item.key)?.href, item.key).toBe(item.href);
    }

    // 항목의 링크는 고정 문자열이고, 같은 링크를 쓰는 항목은 발주 관리처럼 같은 화면을 가리키는 경우뿐이다.
    expect(new Set(TODO_ITEMS.map((item) => item.href)).size).toBeGreaterThanOrEqual(3);
    expect(TODO_ITEMS.every((item) => item.href.startsWith("/dashboard/"))).toBe(true);
  });
});

