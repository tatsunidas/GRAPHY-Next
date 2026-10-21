import { describe, expect, it } from "vitest";
import { canRetry, fallbackKey, needsRestart, showsUnverifiedNote, visible } from "./renderGpuPickView";

describe("renderGpuPickView", () => {
  it("保存した値と今の起動の食い違いが再起動待ち（両方向）", () => {
    expect(needsRestart("high", false)).toBe(true);
    expect(needsRestart("auto", true)).toBe(true);
    expect(needsRestart("high", true)).toBe(false);
    expect(needsRestart("auto", false)).toBe(false);
  });

  it("検証中の注記は、サーバーが unverified と言うときだけ（Linux の NVIDIA は実測済みなので出さない）", () => {
    const st = (unverified: boolean) => ({ platform: "linux", prefs: { gpu: "high" as const }, supported: true, unverified, fallback: null, fallbackReason: null, appliedHigh: true });
    expect(showsUnverifiedNote(st(true))).toBe(true);
    expect(showsUnverifiedNote(st(false))).toBe(false);
  });

  it("対応していない（単一 GPU など）・取れていないときは出さない", () => {
    expect(visible(null)).toBe(false);
    expect(visible({ platform: "linux", prefs: { gpu: "auto" }, supported: false, unverified: false, fallback: null, fallbackReason: null, appliedHigh: false })).toBe(false);
    expect(visible({ platform: "linux", prefs: { gpu: "auto" }, supported: true, unverified: false, fallback: null, fallbackReason: null, appliedHigh: false })).toBe(true);
  });

  it("GPU が見つからない起動でも、選択が高性能か理由があれば節を出す（隠さない）", () => {
    const base = { platform: "linux", unverified: false, fallbackReason: null, appliedHigh: false };
    expect(visible({ ...base, prefs: { gpu: "high" }, supported: false, fallback: "missing" })).toBe(true);
    expect(visible({ ...base, prefs: { gpu: "high" }, supported: false, fallback: null })).toBe(true);
    expect(visible({ ...base, prefs: { gpu: "auto" }, supported: false, fallback: null })).toBe(false);
  });

  it("理由別の文言と、［もう一度試す］が出るのは未確定・失敗のときだけ", () => {
    expect(fallbackKey(null)).toBeNull();
    expect(fallbackKey("missing")).toBe("renderenv.gpuPick.fallback.missing");
    expect(fallbackKey("unconfirmed")).toBe("renderenv.gpuPick.fallback.unconfirmed");
    expect(fallbackKey("failed")).toBe("renderenv.gpuPick.fallback.failed");
    expect(canRetry("missing")).toBe(false);
    expect(canRetry("unconfirmed")).toBe(true);
    expect(canRetry("failed")).toBe(true);
    expect(canRetry(null)).toBe(false);
  });
});
