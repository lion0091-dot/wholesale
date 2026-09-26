import { describe, expect, it } from "vitest";
import { TODO_ITEMS, totalTodo, type TodoCounts } from "./todo-counts";

const counts = (overrides: Partial<TodoCounts> = {}): TodoCounts => ({
  newOrders: 0,
  cancelRequests: 0,
  needsCheckBoxes: 0,
  openDocuments: 0,
  ...overrides,
});

describe("종 배지 합계", () => {
  it("전부 0이면 0", () => {
    expect(totalTodo(counts())).toBe(0);
  });

  it("네 항목을 모두 더한다", () => {
    expect(totalTodo(counts({ newOrders: 3, cancelRequests: 1, needsCheckBoxes: 2, openDocuments: 4 }))).toBe(10);
  });

  it("목록 키가 카운트 키와 하나도 빠지거나 겹치지 않는다", () => {
    const keys = TODO_ITEMS.map((item) => item.key).sort();

    expect(keys).toEqual(Object.keys(counts()).sort());
  });
});

describe("폰 화면의 종 배지", () => {
  it("폰에서는 사무실 전용 항목(대조 중인 전표)을 목록과 합계에서 뺀다", async () => {
    const { visibleTodoItems } = await import("./todo-counts");
    const all = counts({ newOrders: 1, openDocuments: 4 });

    expect(visibleTodoItems(true).map((item) => item.key)).not.toContain("openDocuments");
    expect(visibleTodoItems(false).map((item) => item.key)).toContain("openDocuments");
    expect(totalTodo(all, true)).toBe(1);
    expect(totalTodo(all, false)).toBe(5);
  });
});
