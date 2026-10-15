import { describe, it, expect } from "vitest";
import { traceMaskContours, fillPolygonsEvenOdd, type Pt } from "./maskContour";
import { rasterizeStructure } from "./rtstructRaster";
import { fillSliceEvenOdd } from "./rtstructToLabelVolume";
import { formatScope } from "./roiMaskStore";
import type { RtStructImportContour } from "../api";

const W = 12;
const H = 12;

function donut(): Uint8Array {
  const m = new Uint8Array(W * H);
  for (let y = 1; y < 11; y++) for (let x = 1; x < 11; x++) m[y * W + x] = 1;
  for (let y = 4; y < 8; y++) for (let x = 4; x < 8; x++) m[y * W + x] = 0; // 穴
  return m;
}

// 画素座標 (x,y) ↔ world: x=列*0.7, y=行*0.7 (z は SOP ごとに別の値)。画素の角 (0,0) を world 原点に置く。
const SP = 0.7;
const toWorld = (p: Pt, z: number): number[] => [p[0] * SP, p[1] * SP, z];
const toImage = (_z: number, w: [number, number, number]): Pt => [w[0] / SP, w[1] / SP];

function ringsOf(m: Uint8Array, sop: string, z: number): RtStructImportContour[] {
  const out: RtStructImportContour[] = [];
  for (const c of traceMaskContours(m, W, H)) {
    for (const ring of [c.outer, ...c.holes]) {
      out.push({
        referencedSopInstanceUid: sop,
        points: ring.flatMap((p) => toWorld(p, z)),
        geometricType: "CLOSED_PLANAR",
      });
    }
  }
  return out;
}

describe("RTSTRUCT 取り込みの塗り", () => {
  it("ドーナツ型マスクの外周と穴を別輪郭で戻すと、元の画素に戻る（穴が残る）", () => {
    const m = donut();
    const contours = ringsOf(m, "S1", 3);
    expect(contours.length).toBe(2); // 外周 + 穴
    const r = rasterizeStructure(contours, new Map([["S1", 3]]), toImage, W, H);
    const got = r.slices.get(3)!;
    expect(Array.from(got)).toEqual(Array.from(m));
    expect(got[5 * W + 5]).toBe(0);
    expect(r.skippedNoSlice).toBe(0);
  });

  it("参照 SOP が表示中スタックに無い輪郭は読み飛ばして数える（別スライスに置かない）", () => {
    const m = donut();
    const contours = [...ringsOf(m, "S1", 0), ...ringsOf(m, "UNKNOWN", 0)];
    const r = rasterizeStructure(contours, new Map([["S1", 0]]), toImage, W, H);
    expect(r.slices.size).toBe(1);
    expect(r.skippedNoSlice).toBe(2);
    expect(Array.from(r.slices.get(0)!)).toEqual(Array.from(m));
  });

  it("閉輪郭でないもの（POINT / OPEN_PLANAR）は塗らずに数える", () => {
    const sq = ringsOf(donut(), "S1", 0);
    const extra: RtStructImportContour[] = [
      { referencedSopInstanceUid: "S1", points: [1, 1, 0], geometricType: "POINT" },
      { referencedSopInstanceUid: "S1", points: [1, 1, 0, 2, 2, 0], geometricType: "OPEN_PLANAR" },
    ];
    const r = rasterizeStructure([...sq, ...extra], new Map([["S1", 0]]), toImage, W, H);
    expect(r.skippedNotClosed).toBe(2);
    expect(Array.from(r.slices.get(0)!)).toEqual(Array.from(donut()));
  });

  it("3D の +0.5 換算は 2D（角原点）と同じ画素集合になる", () => {
    const m = donut();
    // 角原点の輪郭を、ピクセル中心が整数になる voxel 座標（-0.5）へ直したものを 3D 側へ渡す。
    const cornerPolys: Pt[][] = [];
    for (const c of traceMaskContours(m, W, H)) for (const ring of [c.outer, ...c.holes]) cornerPolys.push(ring);
    const voxelPolys = cornerPolys.map((p) => p.map(([x, y]): [number, number] => [x - 0.5, y - 0.5]));
    const a = fillSliceEvenOdd(voxelPolys, W, H);
    const b = fillPolygonsEvenOdd(cornerPolys, W, H);
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(Array.from(a)).toEqual(Array.from(m));
  });
});

describe("formatScope（1 始まり表示）", () => {
  it("保存の 0 始まりを +1 で表示し、all はそのまま", () => {
    expect(formatScope({ z: 0, c: 0, t: 0 })).toBe("z1 c1 t1");
    expect(formatScope({ z: 4, c: "all", t: 2 })).toBe("z5 C:all t3");
    expect(formatScope({ z: "all", c: 0, t: "all" })).toBe("Z:all c1 T:all");
    expect(formatScope(undefined)).toBe("");
  });
});
