import { describe, expect, it, vi } from "vitest";

let toThrow: unknown = null;
vi.mock("@cornerstonejs/core", () => ({ metaData: { get: () => ({}) } }));
vi.mock("./derivedVolumeSave", () => ({ saveDerivedVolume: vi.fn() }));
vi.mock("./regVolumeLoader", async (orig) => ({
  ...(await orig<typeof import("./regVolumeLoader")>()),
  // 素の関数（reject する vi.fn は spy が結果の Promise を未処理のまま持つ）
  loadRegVolume: () => Promise.reject(toThrow),
}));

import { NonUniformSliceSpacingError } from "./regVolumeLoader";
import { saveCalibratedSeries } from "./calibratedSeriesSaveRun";

const input = {
  cal: { scale: 1, unit: "SUV", type: "bw" }, study: { studyInstanceUid: "1.1" }, series: { seriesInstanceUid: "1.2" },
  instances: [], mode: "standalone", c: 0, t: 0, confirmMemory: () => true,
} as never;

describe("saveCalibratedSeries: 読み込みが等間隔でないシリーズを断ったとき", () => {
  it("NonUniformSliceSpacingError は { ok: false, reason: nonUniform } に変える（従来の文言になる）", async () => {
    toThrow = new NonUniformSliceSpacingError("irregular", 2, 3.5, "x");
    expect(await saveCalibratedSeries(input)).toEqual({ ok: false, reason: "nonUniform" });
  });
  it("それ以外の例外は握りつぶさず投げる", async () => {
    toThrow = new Error("boom");
    await expect(saveCalibratedSeries(input)).rejects.toThrow("boom");
  });
});
