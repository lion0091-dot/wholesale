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
