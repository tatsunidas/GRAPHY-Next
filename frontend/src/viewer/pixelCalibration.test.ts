import { beforeEach, describe, expect, it, vi } from "vitest";
import { metaData } from "@cornerstonejs/core";
import { getModalityCalibration } from "./pixelCalibration";
import { suvForImageId } from "./suvStore";

// Cornerstone のメタデータプロバイダと SUV ストアを差し替える。getModalityCalibration の
// 判断（preScale 済みか / Rescale を掛けるか / SUV を合成するか）だけを検証したいため。
vi.mock("@cornerstonejs/core", () => ({
  metaData: { get: vi.fn() },
  imageLoader: { loadAndCacheImage: vi.fn() },
  cache: { getImage: vi.fn() },
}));
vi.mock("./suvStore", () => ({ suvForImageId: vi.fn() }));

const metaGet = metaData.get as unknown as ReturnType<typeof vi.fn>;
const suvOf = suvForImageId as unknown as ReturnType<typeof vi.fn>;

const IMAGE_ID = "wadouri:http://localhost:8080/api/instances/1.2.3/file";

describe("getModalityCalibration", () => {
  beforeEach(() => {
    metaGet.mockReset();
    suvOf.mockReset();
    metaGet.mockReturnValue(undefined);
    suvOf.mockReturnValue(undefined);
  });

  it("preScale 済みなら Rescale を掛けない（HU 二重適用の防止）", () => {
    // dicom-image-loader の preScale が有効なとき getPixelData() は既に HU を返す。
    // ここで Rescale をもう一度掛けると CT が約 -1024 ずれる（過去に実際に発生）。
    metaGet.mockReturnValue({ rescaleSlope: 1, rescaleIntercept: -1024, rescaleType: "HU" });
    expect(getModalityCalibration({ preScale: { scaled: true } }, IMAGE_ID)).toEqual({
      scale: 1,
      offset: 0,
      preScaled: true,
      unit: "HU",
    });
  });

  it("preScale 未適用なら Rescale Slope/Intercept をそのまま返す", () => {
    metaGet.mockReturnValue({ rescaleSlope: 2, rescaleIntercept: -1024, rescaleType: "HU" });
    expect(getModalityCalibration({ preScale: { scaled: false } }, IMAGE_ID)).toEqual({
      scale: 2,
      offset: -1024,
      preScaled: false,
      unit: "HU",
    });
  });

  it("校正情報がまったく無ければ raw（恒等変換）", () => {
    expect(getModalityCalibration(null, IMAGE_ID)).toEqual({
      scale: 1,
      offset: 0,
      preScaled: false,
      unit: "raw",
    });
  });

  it("メタデータが無くても画像側の slope/intercept があれば使う", () => {
    expect(
      getModalityCalibration({ preScale: { scaled: false }, slope: 3, intercept: 7 }, IMAGE_ID),
    ).toMatchObject({ scale: 3, offset: 7, preScaled: false });
  });

  it("RescaleType が空白のみなら単位は空文字（raw ではない＝校正済み扱い）", () => {
    metaGet.mockReturnValue({ rescaleSlope: 1, rescaleIntercept: 0, rescaleType: "   " });
    expect(getModalityCalibration(null, IMAGE_ID).unit).toBe("");
  });

  it("SUV 校正済みなら scale と offset の両方に SUV 乗数を合成する", () => {
    // SUV = (px * scale + offset) * suvScale なので offset にも掛ける必要がある。
    metaGet.mockReturnValue({ rescaleSlope: 2, rescaleIntercept: -1024, rescaleType: "BQML" });
    suvOf.mockReturnValue({ scale: 3, unit: "SUVbw", type: "bw" });
    expect(getModalityCalibration({ preScale: { scaled: false } }, IMAGE_ID)).toEqual({
      scale: 6,
      offset: -3072,
      preScaled: false,
      unit: "SUVbw",
    });
  });

  it("preScale 済み＋SUV でも Rescale は二重適用しない", () => {
    metaGet.mockReturnValue({ rescaleSlope: 2, rescaleIntercept: -1024 });
    suvOf.mockReturnValue({ scale: 3, unit: "SUVbw", type: "bw" });
    expect(getModalityCalibration({ preScale: { scaled: true } }, IMAGE_ID)).toEqual({
      scale: 3,
      offset: 0,
      preScaled: true,
      unit: "SUVbw",
    });
  });

  it("SUV 校正が無ければ単位を書き換えない", () => {
    metaGet.mockReturnValue({ rescaleSlope: 1, rescaleIntercept: 0, rescaleType: "BQML" });
    expect(getModalityCalibration(null, IMAGE_ID).unit).toBe("BQML");
  });
});
