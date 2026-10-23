import { describe, expect, it } from "vitest";
import { parseJumpIndex } from "./jumpIndex";

describe("parseJumpIndex", () => {
  it("1 起点の入力を 0 起点にする", () => {
    expect(parseJumpIndex("1", 93)).toBe(0);
    expect(parseJumpIndex("48", 93)).toBe(47);
    expect(parseJumpIndex("93", 93)).toBe(92);
  });
  it("範囲外は端に丸める", () => {
    expect(parseJumpIndex("0", 93)).toBe(0);
    expect(parseJumpIndex("94", 93)).toBe(92);
    expect(parseJumpIndex("99999", 89)).toBe(88);
  });
  it("前後の空白と全角数字を読む", () => {
    expect(parseJumpIndex(" 12 ", 93)).toBe(11);
    expect(parseJumpIndex("１２", 93)).toBe(11);
  });
  it("数字でない・空は null", () => {
    expect(parseJumpIndex("", 93)).toBeNull();
    expect(parseJumpIndex("abc", 93)).toBeNull();
    expect(parseJumpIndex("-3", 93)).toBeNull();
    expect(parseJumpIndex("1.5", 93)).toBeNull();
  });
  it("移動先が無ければ null", () => {
    expect(parseJumpIndex("1", 0)).toBeNull();
  });
});
