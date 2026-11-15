import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchSeriesLayout = vi.fn();
vi.mock("../api", () => ({ fetchSeriesLayout: (...a: unknown[]) => fetchSeriesLayout(...a) }));

/** zStack は layout.zStack(c, t) が返す imageId の列（z 昇順の並びとは限らない）。 */
let imageIds: string[] = [];
vi.mock("./seriesLayout", () => ({
  buildLayoutFromDto: () => ({ nC: 1, nT: 1, zStack: () => imageIds }),
  buildSeriesLayout: () => ({ nC: 1, nT: 1, zStack: () => imageIds }),
}));
vi.mock("./imageId", () => ({ imageIdForInstance: (_m: string, sop: string) => `img:${sop}` }));
vi.mock("./pixelCalibration", () => ({ getModalityCalibration: () => ({ scale: 1, offset: 0 }) }));

/** imageId → IPP（法線 (0,0,1) 方向の z）。 */
const zOf = new Map<string, number>();
vi.mock("@cornerstonejs/core", () => ({
  imageLoader: {
    loadAndCacheImage: vi.fn(async (id: string) => ({ columns: 2, rows: 2, getPixelData: () => new Int16Array([1, 2, 3, 4]), id })),
  },
  metaData: {
    get: (module: string, id: string) =>
      module === "imagePlaneModule" ? { imagePositionPatient: [0, 0, zOf.get(id) ?? 0], frameOfReferenceUID: "1.9" } : { modality: "CT" },
  },
}));

import { loadRegVolume, NonUniformSliceSpacingError, regLoadErrorText } from "./regVolumeLoader";

const dto = { imageOrientationPatient: [1, 0, 0, 0, 1, 0], zSpatial: [0], imageWidth: 2, imageHeight: 2, pixelSpacingCol: 1, pixelSpacingRow: 1 };

async function run(zs: number[]) {
  imageIds = zs.map((_, i) => `img:${i}`);
  zOf.clear();
  zs.forEach((z, i) => zOf.set(`img:${i}`, z));
  fetchSeriesLayout.mockResolvedValue(dto);
  const inst = zs.map((_, i) => ({ sopInstanceUid: String(i) }));
  return loadRegVolume("standalone", "1.1", "1.2", inst as never, 0, 0);
}
const range = (n: number, d = 2.5) => Array.from({ length: n }, (_, k) => k * d);

describe("loadRegVolume: 等間隔でないシリーズを断る", () => {
  beforeEach(() => fetchSeriesLayout.mockReset());

  it("等間隔なら体積を返す", async () => {
    const v = await run(range(20));
    expect(v?.volume.dims).toEqual([2, 2, 20]);
  });
  it("1 枚だけなら返す", async () => {
    expect((await run([0]))?.volume.dims[2]).toBe(1);
  });
  it("間隔の 0.5% の揺らぎ（IPP の丸め相当）は返す", async () => {
    expect(await run(range(20).map((z, k) => z + (k % 2 ? 0.005 : -0.005) * 2.5))).not.toBeNull();
  });
  it("1 枚欠損は NonUniformSliceSpacingError（missing・欠けた枚数・間隔の範囲）", async () => {
    const e = await run(range(20).filter((_, k) => k !== 10)).catch((x) => x);
    expect(e).toBeInstanceOf(NonUniformSliceSpacingError);
    expect(e.kind).toBe("missing");
    expect(e.message).toBe("Series slices are not evenly spaced (missing, 1 slice(s) missing; spacing 2.500–5.000 mm).");
    expect([e.minStepMm, e.maxStepMm]).toEqual([2.5, 5]);
  });
  it("不等間隔は irregular", async () => {
    const zs = [0]; const pat = [2, 3.5, 2.5, 3];
    for (let k = 0; k < 19; k++) zs.push(zs[k] + pat[k % 4]);
    await expect(run(zs)).rejects.toMatchObject({ name: "NonUniformSliceSpacingError", kind: "irregular" });
  });
  it("重複は duplicates", async () => {
    const zs = range(20); zs.splice(5, 0, zs[5]);
    await expect(run(zs)).rejects.toMatchObject({ kind: "duplicates" });
  });
  it("幾何が無ければ null（例外にしない）", async () => {
    fetchSeriesLayout.mockResolvedValue({ imageWidth: 2 });
    expect(await loadRegVolume("standalone", "1.1", "1.2", [] as never, 0, 0)).toBeNull();
  });
});

describe("regLoadErrorText", () => {
  const t = (k: string, v?: Record<string, string | number>) => `${k}|${JSON.stringify(v)}`;
  it("NonUniformSliceSpacingError は i18n の文言に kind と範囲を差し込む", () => {
    const e = new NonUniformSliceSpacingError("missing", 2.5, 5, "x");
    expect(regLoadErrorText(e, t)).toBe('regvolume.nonUniform|{"kind":"missing","min":"2.50","max":"5.00"}');
  });
  it("それ以外は String(e)", () => {
    expect(regLoadErrorText(new Error("boom"), t)).toBe("Error: boom");
  });
});
