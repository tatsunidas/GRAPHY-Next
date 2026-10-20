import { beforeEach, describe, expect, it, vi } from "vitest";
import { metaData } from "@cornerstonejs/core";
import { suvForImageId } from "./suvStore";
import { toFusionSlice, type RawFusionSlice } from "./fusionSlice";

vi.mock("@cornerstonejs/core", () => ({
  metaData: { get: vi.fn() },
  imageLoader: { loadAndCacheImage: vi.fn() },
  cache: { getImage: vi.fn() },
}));
vi.mock("./suvStore", () => ({ suvForImageId: vi.fn() }));

const metaGet = metaData.get as unknown as ReturnType<typeof vi.fn>;
const suvOf = suvForImageId as unknown as ReturnType<typeof vi.fn>;
const IMAGE_ID = "wadouri:http://localhost:8080/api/instances/1.2.3/file";

describe("toFusionSlice（SUV 校正の変更に追従する）", () => {
  beforeEach(() => {
    metaGet.mockReset();
    suvOf.mockReset();
    metaGet.mockReturnValue({ rescaleSlope: 2, rescaleIntercept: 10, rescaleType: "BQML" });
  });
  const raw: RawFusionSlice = { ipp: [0, 0, 0], pixels: new Uint16Array([100]), preScale: { scaled: false } };
  const value = (s: { pixels: ArrayLike<number>; slope: number; intercept: number }) => s.pixels[0] * s.slope + s.intercept;

  it("校正なし → あり → 解除 の順に、同じ生スライスから値が追従する", () => {
    suvOf.mockReturnValue(undefined);
    expect(value(toFusionSlice(raw, IMAGE_ID))).toBe(210);
    suvOf.mockReturnValue({ scale: 3, unit: "SUVbw", type: "bw" });
    expect(value(toFusionSlice(raw, IMAGE_ID))).toBe(630);
    suvOf.mockReturnValue(undefined);
    expect(value(toFusionSlice(raw, IMAGE_ID))).toBe(210);
  });

  it("【負例】校正を 1 回だけ焼き込んで使い回すと、校正を付けた後も古い値のまま（旧実装の症状）", () => {
    suvOf.mockReturnValue(undefined);
    const baked = toFusionSlice(raw, IMAGE_ID); // 旧実装: 初回に校正を焼き込んでキャッシュ
    suvOf.mockReturnValue({ scale: 3, unit: "SUVbw", type: "bw" });
    expect(value(baked)).toBe(210);
    expect(value(baked)).not.toBe(value(toFusionSlice(raw, IMAGE_ID)));
  });
});
