import { describe, expect, it } from "vitest";
import type { Instance } from "../api";
import { instanceLabel, instanceWindow, resolveInitialSop, shiftWindow, TREE_WINDOW } from "./tagViewerTree";

const inst = (n: number): Instance => ({ sopInstanceUid: `1.2.${n}`, instanceNumber: n, sopClassUid: null, transferSyntaxUid: null } as Instance);
const many = (n: number) => Array.from({ length: n }, (_, i) => inst(i + 1));

describe("resolveInitialSop", () => {
  it("指定した SOP があればそれを返す", () => expect(resolveInitialSop(many(5), "1.2.3")).toBe("1.2.3"));
  it("指定が無い・見つからないときは先頭", () => {
    expect(resolveInitialSop(many(5))).toBe("1.2.1");
    expect(resolveInitialSop(many(5), null)).toBe("1.2.1");
    expect(resolveInitialSop(many(5), "9.9")).toBe("1.2.1");
  });
  it("インスタンスが無ければ null", () => expect(resolveInitialSop([], "1.2.3")).toBeNull());
});

describe("instanceWindow", () => {
  it("全体が窓以下なら全部", () => expect(instanceWindow(10, 3)).toEqual({ start: 0, end: 10 }));
  it("0 枚は空", () => expect(instanceWindow(0, 0)).toEqual({ start: 0, end: 0 }));
  it("中ほどは focus を中央付近に含む", () => {
    const w = instanceWindow(300, 150);
    expect(w.end - w.start).toBe(TREE_WINDOW);
    expect(w.start).toBeLessThanOrEqual(150);
    expect(w.end).toBeGreaterThan(150);
  });
  it("先頭・末尾では詰める（常に窓の大きさ）", () => {
    expect(instanceWindow(300, 0)).toEqual({ start: 0, end: TREE_WINDOW });
    expect(instanceWindow(300, 299)).toEqual({ start: 300 - TREE_WINDOW, end: 300 });
  });
  it("範囲外・負は先頭の窓", () => {
    expect(instanceWindow(300, -1).start).toBe(0);
    expect(instanceWindow(300, 999).start).toBe(0);
  });
  it("focus は常に窓に入る（全位置）", () => {
    for (let f = 0; f < 137; f++) {
      const w = instanceWindow(137, f);
      expect(f >= w.start && f < w.end).toBe(true);
    }
  });
});

describe("shiftWindow", () => {
  it("端で止まる", () => {
    expect(shiftWindow(300, 0, -50)).toBe(0);
    expect(shiftWindow(300, 240, 50)).toBe(250);
    expect(shiftWindow(300, 0, 50)).toBe(50);
  });
  it("窓より少ない枚数では 0", () => expect(shiftWindow(10, 0, 50)).toBe(0));
});

describe("instanceLabel", () => {
  it("番号と SOP 末尾 8 桁", () => expect(instanceLabel({ ...inst(7), sopInstanceUid: "1.2.840.1234567890" })).toBe("#7 · …34567890"));
  it("番号が無ければ -", () => expect(instanceLabel({ ...inst(1), instanceNumber: null })).toContain("#-"));
});
