import { describe, expect, it } from "vitest";
import { parseToolPanelDefault } from "./toolPanelDefault";

describe("parseToolPanelDefault", () => {
  it("true と保存されているときだけ開く", () => {
    expect(parseToolPanelDefault({ "viewer.toolPanelDefault": "true" })).toBe(true);
  });
  it("未設定・false・不正値・取得前は閉", () => {
    expect(parseToolPanelDefault({})).toBe(false);
    expect(parseToolPanelDefault({ "viewer.toolPanelDefault": "false" })).toBe(false);
    expect(parseToolPanelDefault({ "viewer.toolPanelDefault": "TRUE" })).toBe(false);
    expect(parseToolPanelDefault(null)).toBe(false);
    expect(parseToolPanelDefault(undefined)).toBe(false);
  });
});
