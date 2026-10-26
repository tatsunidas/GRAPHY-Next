import { describe, expect, it } from "vitest";
import { cropRect, fitLongEdge, roiBoundsFromCanvasPoints, visibleRoiCount } from "./tileCapture";

const roi = (uid: string, imageId: string, extra: Record<string, unknown> = {}) => ({
  annotationUID: uid,
  metadata: { referencedImageId: imageId },
  ...extra,
});

describe("visibleRoiCount", () => {
  const all = () => true;

  it("counts only ROIs on the displayed image", () => {
    const anns = [roi("a", "img1"), roi("b", "img2"), roi("c", "img1")];
    expect(visibleRoiCount(anns, "img1", all)).toBe(2);
    expect(visibleRoiCount(anns, "img3", all)).toBe(0);
  });

  it("skips hidden ROIs", () => {
    const anns = [roi("a", "img1"), roi("b", "img1", { isVisible: false }), roi("c", "img1")];
    expect(visibleRoiCount(anns, "img1", (uid) => uid !== "c")).toBe(1);
  });

  it("is zero without a displayed image or annotations", () => {
    expect(visibleRoiCount([roi("a", "img1")], undefined, all)).toBe(0);
    expect(visibleRoiCount([], "img1", all)).toBe(0);
  });
});

describe("fitLongEdge", () => {
  it("shrinks the long edge to max and keeps the aspect ratio", () => {
    expect(fitLongEdge(2048, 1024, 1024)).toEqual({ w: 1024, h: 512 });
    expect(fitLongEdge(512, 2000, 1000)).toEqual({ w: 256, h: 1000 });
  });

  it("never enlarges an image that already fits", () => {
    expect(fitLongEdge(512, 256, 1024)).toEqual({ w: 512, h: 256 });
    expect(fitLongEdge(1024, 1024, 1024)).toEqual({ w: 1024, h: 1024 });
  });

  it("keeps at least 1 px per side", () => {
    expect(fitLongEdge(10000, 1, 1024)).toEqual({ w: 1024, h: 1 });
  });

  it("rejects zero, negative and non-finite sizes", () => {
    for (const [w, h, m] of [[0, 10, 1024], [10, 0, 1024], [-1, 10, 1024], [NaN, 10, 1024], [10, Infinity, 1024], [10, 10, 0]]) {
      expect(fitLongEdge(w, h, m)).toBeNull();
    }
  });
});

describe("roiBoundsFromCanvasPoints", () => {
  it("複数 ROI の和。有限でない点は捨てる", () => {
    expect(roiBoundsFromCanvasPoints([[[10, 20], [30, 40]], [[5, 60], [NaN, 1], [Infinity, 2]]])).toEqual([5, 20, 30, 60]);
  });
  it("点が無い・全部不正なら null", () => {
    expect(roiBoundsFromCanvasPoints([])).toBeNull();
    expect(roiBoundsFromCanvasPoints([[[NaN, 1]], []])).toBeNull();
  });
});

describe("cropRect", () => {
  it("余白 10%（最小 8 px）を足し、dpr 倍の整数矩形にする", () => {
    // 幅 100・高さ 50 の ROI: 余白 x=10, y=8（最小）
    expect(cropRect([100, 100, 200, 150], 1000, 800, 1)).toEqual({ x: 90, y: 92, w: 120, h: 66 });
    expect(cropRect([100, 100, 200, 150], 1000, 800, 2)).toEqual({ x: 180, y: 184, w: 240, h: 132 });
  });
  it("画像の外へはみ出す分は画像の範囲に収める（端の ROI）", () => {
    expect(cropRect([0, 0, 100, 100], 1000, 800, 1)).toEqual({ x: 0, y: 0, w: 110, h: 110 });
    expect(cropRect([950, 750, 1000, 800], 1000, 800, 1)?.x).toBeGreaterThanOrEqual(0);
    const r = cropRect([950, 750, 1000, 800], 1000, 800, 1)!;
    expect(r.x + r.w).toBeLessThanOrEqual(1000);
    expect(r.y + r.h).toBeLessThanOrEqual(800);
  });
  it("点に近い ROI は最小辺 64 px まで中心を保って広げる", () => {
    expect(cropRect([500, 400, 500, 400], 1000, 800, 1)).toEqual({ x: 468, y: 368, w: 64, h: 64 });
  });
  it("位置が変われば矩形も追従する（定数でない）", () => {
    const a = cropRect([100, 100, 200, 150], 1000, 800, 1)!;
    const b = cropRect([400, 300, 500, 350], 1000, 800, 1)!;
    expect(b.x - a.x).toBe(300);
    expect(b.y - a.y).toBe(200);
  });
  it("負例: 画像の外・不正な値は null", () => {
    expect(cropRect([2000, 2000, 2100, 2100], 1000, 800, 1)).toBeNull();
    expect(cropRect([NaN, 0, 1, 1], 1000, 800, 1)).toBeNull();
    expect(cropRect([0, 0, 10, 10], 0, 800, 1)).toBeNull();
    expect(cropRect([0, 0, 10, 10], 1000, 800, 0)).toBeNull();
  });
});
