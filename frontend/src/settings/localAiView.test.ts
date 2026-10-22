import { describe, expect, it } from "vitest";
import type { AiLocalStatus } from "../desktopBridge";
import { errorKey, formatBytes, percentOf, phaseOf, reduceProgress } from "./localAiView";

const base: AiLocalStatus = {
  supported: true,
  runtime: { installed: false, build: null, size: 1 },
  model: { installed: false, id: null, verified: false, file: null },
  running: false,
  busy: false,
};

describe("phaseOf", () => {
  it("未対応・未取得は unsupported", () => {
    expect(phaseOf(null, null)).toBe("unsupported");
    expect(phaseOf({ supported: false }, null)).toBe("unsupported");
  });
  it("実行ファイルかモデルのどちらかが欠ければ notInstalled", () => {
    expect(phaseOf(base, null)).toBe("notInstalled");
    expect(phaseOf({ ...base, runtime: { installed: true, build: "b", size: 1 } }, null)).toBe("notInstalled");
  });
  it("両方あれば ready、起動中なら running", () => {
    const ok = { ...base, runtime: { installed: true, build: "b", size: 1 }, model: { installed: true, id: "m", verified: true, file: "m.gguf" } };
    expect(phaseOf(ok, null)).toBe("ready");
    expect(phaseOf({ ...ok, running: true }, null)).toBe("running");
  });
  it("導入中（busy・進捗あり）は他より優先。done の進捗は導入中にしない", () => {
    const ok = { ...base, runtime: { installed: true, build: "b", size: 1 }, model: { installed: true, id: "m", verified: true, file: "m.gguf" } };
    expect(phaseOf({ ...ok, busy: true }, null)).toBe("installing");
    expect(phaseOf(base, { phase: "model-download", received: 1, total: 2 })).toBe("installing");
    expect(phaseOf(ok, { phase: "done" })).toBe("ready");
  });
});

describe("percentOf / formatBytes", () => {
  it("正例: 割合を 0〜100 に丸める", () => {
    expect(percentOf({ phase: "model-download", received: 50, total: 200 })).toBe(25);
    expect(percentOf({ phase: "model-download", received: 999, total: 100 })).toBe(100);
  });
  it("負例: 総量が不明・0・進捗なしは null（嘘の値を出さない）", () => {
    expect(percentOf(null)).toBeNull();
    expect(percentOf({ phase: "runtime-extract" })).toBeNull();
    expect(percentOf({ phase: "model-download", received: 1, total: 0 })).toBeNull();
  });
  it("サイズの表記", () => {
    expect(formatBytes(2_497_280_256)).toBe("2.5 GB");
    expect(formatBytes(22_331_121)).toBe("22 MB");
    expect(formatBytes(-1)).toBe("—");
    expect(formatBytes(Number.NaN)).toBe("—");
  });
});

describe("reduceProgress", () => {
  it("progress は上書き、done は消す、他のイベントは変えない", () => {
    const p = reduceProgress(null, { type: "progress", phase: "runtime-download", received: 1, total: 4 });
    expect(p).toEqual({ phase: "runtime-download", received: 1, total: 4 });
    expect(reduceProgress(p, { type: "state" })).toBe(p);
    expect(reduceProgress(p, { type: "starting" })).toBe(p);
    expect(reduceProgress(p, { type: "progress", phase: "done" })).toBeNull();
  });
});

describe("errorKey", () => {
  it("既知のコードは専用の文、未知は汎用", () => {
    expect(errorKey("sha256-mismatch")).toBe("settings.ai.local.err.sha256");
    expect(errorKey("network:ENOTFOUND")).toBe("settings.ai.local.err.network");
    expect(errorKey("http-404")).toBe("settings.ai.local.err.network");
    expect(errorKey("zzz")).toBe("settings.ai.local.err.generic");
  });
});
