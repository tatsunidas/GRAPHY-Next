import { beforeEach, describe, expect, it, vi } from "vitest";
import { metaData } from "@cornerstonejs/core";
import { getModalityCalibration } from "./pixelCalibration";
import { sampleFusionValue } from "./fusionProbe";
import { probeMetaOf } from "./fusionProbeMeta";
import { suvForImageId } from "./suvStore";

vi.mock("@cornerstonejs/core", () => ({
  metaData: { get: vi.fn() },
  imageLoader: { loadAndCacheImage: vi.fn() },
  cache: { getImage: vi.fn() },
}));
vi.mock("./suvStore", () => ({ suvForImageId: vi.fn() }));
vi.mock("./xaCalibrationProvider", () => ({ calibrationForImageId: () => undefined }));
vi.mock("@cornerstonejs/dicom-image-loader", () => ({ default: {} }));

const metaGet = metaData.get as unknown as ReturnType<typeof vi.fn>;
const suvOf = suvForImageId as unknown as ReturnType<typeof vi.fn>;
const IMAGE_ID = "wadouri:http://localhost:8080/api/instances/1.2.3/file";

describe("Fusion 前景の値と状態バーの SUV（二重掛けの検査）", () => {
  beforeEach(() => {
    metaGet.mockReset();
    suvOf.mockReset();
  });

  it("SUV 校正済み PET: 状態バーの値は (px×slope+intercept)×SUV 乗数の 1 回分", () => {
    metaGet.mockReturnValue({ rescaleSlope: 2, rescaleIntercept: 10, rescaleType: "BQML", modality: "PT" });
    suvOf.mockReturnValue({ scale: 3, unit: "SUVbw", type: "bw" });
    const px = 100;
    // loadFusionSlice／非空間枝と同じ: 校正（SUV 合成済み）で前景値を作る。
    const cal = getModalityCalibration({ preScale: { scaled: false } }, IMAGE_ID);
    const fused = px * cal.scale + cal.offset;
    const data = { values: new Float32Array([fused]), cols: 1, rows: 1, ...probeMetaOf(IMAGE_ID) };
    const s = sampleFusionValue(data, 0, 0, 1, 1);
    expect(s?.value).toBe((px * 2 + 10) * 3); // 630（SUV の真値）
    expect(s?.unit).toBe("SUVbw");
  });

  it("SUV 未校正: 乗数は 1、単位はモダリティ値の単位", () => {
    metaGet.mockReturnValue({ rescaleSlope: 1, rescaleIntercept: -1024, rescaleType: "HU", modality: "CT" });
    suvOf.mockReturnValue(undefined);
    const cal = getModalityCalibration({ preScale: { scaled: false } }, IMAGE_ID);
    const fused = 1100 * cal.scale + cal.offset;
    const data = { values: new Float32Array([fused]), cols: 1, rows: 1, ...probeMetaOf(IMAGE_ID) };
    expect(sampleFusionValue(data, 0, 0, 1, 1)?.value).toBe(76);
  });
});
