import { describe, expect, it } from "vitest";
import { fitLongEdge, visibleRoiCount } from "./tileCapture";

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
