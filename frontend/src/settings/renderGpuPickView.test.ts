import { describe, expect, it } from "vitest";
import { highLabelKey, needsRestart, showsUnverifiedNote, visible } from "./renderGpuPickView";

describe("renderGpuPickView", () => {
  it("保存した値と今の起動の食い違いが再起動待ち（両方向）", () => {
    expect(needsRestart("high", false)).toBe(true);
    expect(needsRestart("auto", true)).toBe(true);
    expect(needsRestart("high", true)).toBe(false);
    expect(needsRestart("auto", false)).toBe(false);
  });

  it("文言は Linux だけ NVIDIA 限定。Windows・macOS だけ未確認の注記", () => {
    expect(highLabelKey("linux")).toBe("renderenv.gpuPick.highLinux");
    expect(highLabelKey("win32")).toBe("renderenv.gpuPick.high");
    expect(highLabelKey("darwin")).toBe("renderenv.gpuPick.high");
    expect(showsUnverifiedNote("win32")).toBe(true);
    expect(showsUnverifiedNote("darwin")).toBe(true);
    expect(showsUnverifiedNote("linux")).toBe(false);
  });

  it("対応していない（単一 GPU など）・取れていないときは出さない", () => {
    expect(visible(null)).toBe(false);
    expect(visible({ platform: "linux", prefs: { gpu: "auto" }, supported: false, appliedHigh: false })).toBe(false);
    expect(visible({ platform: "linux", prefs: { gpu: "auto" }, supported: true, appliedHigh: false })).toBe(true);
  });
});
