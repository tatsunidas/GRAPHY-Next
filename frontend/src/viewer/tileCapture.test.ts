import { describe, expect, it } from "vitest";
import { visibleRoiCount } from "./tileCapture";

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
