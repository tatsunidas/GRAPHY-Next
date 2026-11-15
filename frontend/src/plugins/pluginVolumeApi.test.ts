import { beforeEach, describe, expect, it, vi } from "vitest";

const loadRegVolume = vi.fn();
vi.mock("../viewer/regVolumeLoader", () => ({ loadRegVolume: (...a: unknown[]) => loadRegVolume(...a), estimateRegVolume: vi.fn() }));
vi.mock("../api", () => ({ fetchInstances: vi.fn(async () => [{ sopInstanceUid: "1.2.3" }]) }));
vi.mock("@cornerstonejs/core", () => ({
  imageLoader: { loadAndCacheImage: vi.fn(async () => ({})) },
  metaData: { get: vi.fn(() => ({ sliceThickness: 2.5 })) },
}));
vi.mock("../viewer/pixelCalibration", () => ({ getModalityCalibration: () => ({ unit: "HU", scale: 1, offset: 0 }) }));
vi.mock("../viewer/regWorkerClient", () => ({ runRigidInWorker: vi.fn(), toPayload: vi.fn() }));
vi.mock("../viewer/regResult", () => ({ registrationToTransform: vi.fn() }));

import { loadPluginVolume, NonUniformSliceSpacingError } from "./pluginVolumeApi";

const IOP = [1, 0, 0, 0, 1, 0];
/** loadRegVolume の返り値の形（実装の型どおり）。z は法線 (0,0,1) 方向の IPP。 */
function fakeLoaded(zs: number[]) {
  const step = zs.length > 1 ? zs[1] - zs[0] : 1;
  return {
    volume: {
      data: new Float32Array(4 * zs.length),
      dims: [2, 2, zs.length],
      spacing: [1, 1, step],
      indexToWorld: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, step, zs[0], 0, 0, 0, 1],
      worldToIndex: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1 / step, -zs[0] / step, 0, 0, 0, 1],
    },
    iop: IOP,
    sliceStep: [0, 0, step],
    frameOfReferenceUid: "1.9",
    modality: "CT",
    slices: zs.map((z, i) => ({ sopInstanceUid: `1.2.${i}`, ipp: [0, 0, z] })),
    firstImageId: "wadouri:x",
  };
}
const ref = { seriesUid: "1.2.9", studyUid: "1.2.8" };
const run = (zs: number[]) => {
  loadRegVolume.mockResolvedValue(fakeLoaded(zs));
  return loadPluginVolume("standalone", () => "1.2.8", ref);
};
const range = (n: number, d = 2.5) => Array.from({ length: n }, (_, k) => k * d);

describe("loadPluginVolume: 等間隔でないシリーズを断る", () => {
  beforeEach(() => loadRegVolume.mockReset());

  it("等間隔なら体積を返す", async () => {
    const v = await run(range(20));
    expect(v?.dims).toEqual([2, 2, 20]);
    expect(v?.unit).toBe("HU");
  });
  it("1 枚欠損は NonUniformSliceSpacingError（kind と欠けた枚数）", async () => {
    const zs = range(20).filter((_, k) => k !== 10);
    const e = await run(zs).catch((x) => x);
    expect(e).toBeInstanceOf(NonUniformSliceSpacingError);
    expect(e.name).toBe("NonUniformSliceSpacingError");
    expect(e.message).toMatch(/missing/);
    expect(e.message).toMatch(/1 slice\(s\) missing/);
    expect(e.message).toMatch(/2\.500–5\.000 mm/);
  });
  it("不等間隔は NonUniformSliceSpacingError（irregular）", async () => {
    const zs = [0]; const pat = [2, 3.5, 2.5, 3];
    for (let k = 0; k < 19; k++) zs.push(zs[k] + pat[k % 4]);
    await expect(run(zs)).rejects.toThrow(/irregular/);
    await expect(run(zs)).rejects.toMatchObject({ name: "NonUniformSliceSpacingError", kind: "irregular" });
  });
  it("重複（同じ位置の 2 枚）は NonUniformSliceSpacingError（duplicates）", async () => {
    const zs = range(20); zs.splice(5, 0, zs[5]);
    await expect(run(zs)).rejects.toMatchObject({ name: "NonUniformSliceSpacingError", kind: "duplicates" });
  });
  it("間隔の 0.5% の揺らぎ（IPP の丸め相当）は等間隔として返す", async () => {
    const zs = range(20).map((z, k) => z + (k % 2 ? 0.005 : -0.005) * 2.5);
    expect(await run(zs)).not.toBeNull();
  });
  it("1 枚だけのシリーズは返す", async () => {
    const v = await run([0]);
    expect(v?.dims[2]).toBe(1);
  });
  it("loadRegVolume が null なら null（幾何が無い・読めない）", async () => {
    loadRegVolume.mockResolvedValue(null);
    expect(await loadPluginVolume("standalone", () => "1.2.8", ref)).toBeNull();
  });
});
