import { describe, expect, it } from "vitest";
import { reconcileSolo, toggleSolo } from "./soloTile";

describe("toggleSolo", () => {
  it("通常表示から、押したタイルの単独表示にする", () => {
    expect(toggleSolo(null, "a", 3)).toBe("a");
  });
  it("同じタイルをもう一度押すと通常表示に戻る", () => {
    expect(toggleSolo("a", "a", 3)).toBeNull();
  });
  it("単独表示中に別のタイルのヘッダを押したら、そのタイルに替わる", () => {
    expect(toggleSolo("a", "b", 3)).toBe("b");
  });
  it("タイルが 1 枚だけなら何も変えない（負例）", () => {
    expect(toggleSolo(null, "a", 1)).toBeNull();
    expect(toggleSolo("a", "a", 1)).toBe("a");
  });
});

describe("reconcileSolo", () => {
  it("一覧にあるタイルはそのまま", () => {
    expect(reconcileSolo("a", ["a", "b"])).toBe("a");
  });
  it("消されたタイルなら通常表示に戻す（負例）", () => {
    expect(reconcileSolo("c", ["a", "b"])).toBeNull();
  });
  it("未設定・空は null", () => {
    expect(reconcileSolo(undefined, ["a"])).toBeNull();
    expect(reconcileSolo(null, ["a"])).toBeNull();
    expect(reconcileSolo("", ["a"])).toBeNull();
  });
});
