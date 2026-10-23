import { describe, expect, it } from "vitest";
import { clampDockHeight, DOCK_MIN_HEIGHT, parseDockState } from "./dockSize";

describe("clampDockHeight", () => {
  it("範囲内はそのまま", () => expect(clampDockHeight(300, 800)).toBe(300));
  it("最小より小さければ最小", () => expect(clampDockHeight(50, 800)).toBe(DOCK_MIN_HEIGHT));
  it("領域 − 120 を超えない", () => expect(clampDockHeight(9999, 800)).toBe(680));
  it("領域が小さいときは最小を優先", () => expect(clampDockHeight(300, 200)).toBe(DOCK_MIN_HEIGHT));
  it("数でなければ領域の 40%", () => {
    expect(clampDockHeight(NaN, 800)).toBe(320);
    expect(clampDockHeight(Infinity, 800)).toBe(320);
  });
});

describe("parseDockState", () => {
  it("未保存・壊れた値は既定（表示・高さ未保存）", () => {
    for (const raw of [null, undefined, "", "{", "abc"]) expect(parseDockState(raw)).toEqual({ open: true, height: null });
  });
  it("保存値を読む", () => expect(parseDockState('{"open":false,"height":350}')).toEqual({ open: false, height: 350 }));
  it("不正な型・負数は捨てる", () => {
    expect(parseDockState('{"open":"no","height":-5}')).toEqual({ open: true, height: null });
    expect(parseDockState('{"height":"300"}')).toEqual({ open: true, height: null });
  });
});
