import { describe, expect, it, vi } from "vitest";

let toThrow: unknown = null;
vi.mock("@cornerstonejs/core", () => ({ volumeLoader: {} }));
vi.mock("../api", () => ({ fetchInstances: async () => [] }));
vi.mock("./mpr", () => ({ buildCorrectedMetadata: vi.fn() }));
vi.mock("./regVolumeLoader", async (orig) => ({
  ...(await orig<typeof import("./regVolumeLoader")>()),
  // 素の関数（reject する vi.fn は spy が結果の Promise を未処理のまま持つ）
  loadRegVolume: () => Promise.reject(toThrow),
}));

import { buildConcatResampledVolume, ConcatResampleError, concatResampleErrorMessage } from "./concatResample";
import { NonUniformSliceSpacingError } from "./regVolumeLoader";

const args = {
  mode: "standalone", volumeId: "v", plan: {}, parts: [{}],
  sources: [{ study: { studyInstanceUid: "1.1" }, series: { seriesInstanceUid: "1.2" } }],
} as never;

describe("buildConcatResampledVolume: 読み込みが等間隔でないシリーズを断ったとき", () => {
  it("ConcatResampleError('nonUniform') に包み、連結ダイアログ用の文言が出る", async () => {
    toThrow = new NonUniformSliceSpacingError("missing", 2.5, 5, "Series slices are not evenly spaced (missing).");
    const e = await buildConcatResampledVolume(args).catch((x) => x);
    expect(e).toBeInstanceOf(ConcatResampleError);
    expect(e.reason).toBe("nonUniform");
    expect(concatResampleErrorMessage(e, (k) => k)).toBe("series.concat.fail.resampleRun.nonUniform");
  });
  it("それ以外の例外は包まずそのまま投げる", async () => {
    toThrow = new Error("boom");
    const e = await buildConcatResampledVolume(args).catch((x) => x);
    expect(e).not.toBeInstanceOf(ConcatResampleError);
    expect(e.message).toBe("boom");
  });
});
