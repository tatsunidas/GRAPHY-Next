import { describe, expect, it } from "vitest";
import { NO_VALUE_RGB } from "./vesselColorMap";
import { buildSegmentColors } from "./vesselSegmentColors";

const rgbAt = (a: Uint8Array, i: number) => [a[i * 3], a[i * 3 + 1], a[i * 3 + 2]];
const NO = NO_VALUE_RGB.map((v) => Math.round(v * 255));
const SEGS = [
  { id: "trunk", points: [0, 0, 0] },
  { id: "b1", points: [0, 0] },
  { id: "b2", points: [0, 0] },
];
const analysis = (perPoint: { segmentId: string; index: number; value: number }[]) => ({ perPoint, range: [0.5, 1.0] as [number, number] });

describe("buildSegmentColors", () => {
  it("解析値が無ければ空（物体の既定色）", () => {
    expect(buildSegmentColors(SEGS, null).size).toBe(0);
  });

  it("segmentId で区間ごとに値を振り分ける（他の区間の値が混ざらない）", () => {
    const m = buildSegmentColors(SEGS, analysis([
      { segmentId: "trunk", index: 0, value: 0.5 },
      { segmentId: "trunk", index: 1, value: 0.5 },
      { segmentId: "trunk", index: 2, value: 0.5 },
      { segmentId: "b1", index: 0, value: 1.0 },
      { segmentId: "b1", index: 1, value: 1.0 },
    ]));
    const trunk = m.get("trunk")!;
    const b1 = m.get("b1")!;
    expect(trunk.length).toBe(9);
    expect(b1.length).toBe(6);
    // range[0]=赤・range[1]=青。幹は赤側、b1 は青側。
    expect(rgbAt(trunk, 0)[0]).toBeGreaterThan(rgbAt(trunk, 0)[2]);
    expect(rgbAt(b1, 0)[2]).toBeGreaterThan(rgbAt(b1, 0)[0]);
    expect(rgbAt(trunk, 0)).not.toEqual(rgbAt(b1, 0));
  });

  it("値の無い区間は、全点が「値なし」の色（物体の既定色にしない）", () => {
    const m = buildSegmentColors(SEGS, analysis([{ segmentId: "trunk", index: 0, value: 0.7 }]));
    const b2 = m.get("b2")!;
    expect(b2.length).toBe(6);
    expect(rgbAt(b2, 0)).toEqual(NO);
    expect(rgbAt(b2, 1)).toEqual(NO);
    // 値のある区間でも、値の無い点は値なし
    expect(rgbAt(m.get("trunk")!, 1)).toEqual(NO);
    expect(rgbAt(m.get("trunk")!, 0)).not.toEqual(NO);
  });

  it("範囲外の値は端の色ではなく値なしにしない: 範囲外・非有限は値なし（補間しない）", () => {
    const m = buildSegmentColors(SEGS, analysis([{ segmentId: "b1", index: 0, value: NaN }]));
    expect(rgbAt(m.get("b1")!, 0)).toEqual(NO);
  });
});
