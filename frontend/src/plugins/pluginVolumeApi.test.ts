import { beforeEach, describe, expect, it, vi } from "vitest";

const loadRegVolume = vi.fn();
// vi.fn に reject する実装を置くと、spy が結果の Promise を未処理のまま持ち、テストが失敗扱いになる。素の関数で投げる。
let throwNext: unknown = null;
vi.mock("../viewer/regVolumeLoader", async (orig) => ({
  ...(await orig<typeof import("../viewer/regVolumeLoader")>()),
  loadRegVolume: (...a: unknown[]) => (throwNext ? Promise.reject(throwNext) : loadRegVolume(...a)),
  estimateRegVolume: vi.fn(),
}));
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

describe("loadPluginVolume: 等間隔でないシリーズの断りは loadRegVolume が行い、そのまま通す", () => {
  beforeEach(() => { loadRegVolume.mockReset(); throwNext = null; });

  it("loadRegVolume が体積を返せば、体積を返す", async () => {
    const v = await run(range(20));
    expect(v?.dims).toEqual([2, 2, 20]);
    expect(v?.unit).toBe("HU");
  });
  it("1 枚だけのシリーズも返す", async () => {
    expect((await run([0]))?.dims[2]).toBe(1);
  });
  it("loadRegVolume の NonUniformSliceSpacingError を握りつぶさず、そのまま投げる（null にしない）", async () => {
    const err = new NonUniformSliceSpacingError("missing", 2.5, 5, "Series slices are not evenly spaced (missing, 1 slice(s) missing; spacing 2.500–5.000 mm).");
    throwNext = err;
    const got = await loadPluginVolume("standalone", () => "1.2.8", ref).then(() => null, (x: unknown) => x);
    expect(got === err).toBe(true);
  });
  it("loadRegVolume が null なら null（幾何が無い・読めない）", async () => {
    loadRegVolume.mockResolvedValue(null);
    expect(await loadPluginVolume("standalone", () => "1.2.8", ref)).toBeNull();
  });
});
