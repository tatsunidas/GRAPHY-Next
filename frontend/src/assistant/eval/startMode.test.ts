import { describe, expect, it } from "vitest";
import { evalStartMode } from "../EvalSection";

describe("evalStartMode", () => {
  it("外部へ出る宛先は先に確認する（送る前に止まる）", () => {
    expect(evalStartMode({ host: "api.example.com" })).toBe("ask");
  });
  it("ローカルは確認なしで実行する（正例）", () => {
    expect(evalStartMode(null)).toBe("run");
  });
  it("ツール呼び出しに対応しない・未解決の提供元では実行できない（負例）", () => {
    expect(evalStartMode(undefined)).toBe("unavailable");
  });
});
