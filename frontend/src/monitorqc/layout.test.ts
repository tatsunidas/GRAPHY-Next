import { describe, expect, it } from "vitest";
import { describeDisplayLayout, layoutMap, type LayoutDisplayInput } from "./layout";

const D = (id: number, x: number, y: number, w: number, h: number, scaleFactor = 1): LayoutDisplayInput => ({ id, bounds: { x, y, width: w, height: h }, scaleFactor });
const byId = (rows: ReturnType<typeof describeDisplayLayout>, id: number) => rows.find((r) => r.id === id)!;

describe("describeDisplayLayout", () => {
  it("左右に 縦・縦・横: 並びは 1・2・3、向きは 縦・縦・横（入力の順が逆でも、x で決まる）", () => {
    const rows = describeDisplayLayout([D(30, 2400, 0, 1920, 1080), D(10, 0, 0, 1200, 1920), D(20, 1200, 0, 1200, 1920)]);
    expect(byId(rows, 10)).toMatchObject({ order: 1, orientation: "portrait" });
    expect(byId(rows, 20)).toMatchObject({ order: 2, orientation: "portrait" });
    expect(byId(rows, 30)).toMatchObject({ order: 3, orientation: "landscape" });
  });

  it("x が負（左に置いた副モニター）でも、左端が 1 番", () => {
    const rows = describeDisplayLayout([D(1, 0, 0, 1920, 1080), D(2, -1200, -300, 1200, 1920)]);
    expect(byId(rows, 2).order).toBe(1);
    expect(byId(rows, 1).order).toBe(2);
  });

  it("縦に積んだ配置（x が同じ）は、y の小さい方が先", () => {
    const rows = describeDisplayLayout([D(1, 0, 1080, 1920, 1080), D(2, 0, 0, 1920, 1080)]);
    expect(byId(rows, 2).order).toBe(1);
    expect(byId(rows, 1).order).toBe(2);
  });

  it("正方形は square", () => {
    expect(describeDisplayLayout([D(1, 0, 0, 1000, 1000)])[0].orientation).toBe("square");
  });

  it("拡大率 1.25: 1920×1200 → 物理 2400×1500（丸めなし・exact）。メガピクセル 3.6", () => {
    const r = describeDisplayLayout([D(1, 0, 0, 1920, 1200, 1.25)])[0];
    expect([r.physicalW, r.physicalH, r.physicalExact]).toEqual([2400, 1500, true]);
    expect(r.megapixels).toBeCloseTo(3.6, 9);
    expect([r.width, r.height]).toEqual([1920, 1200]);
  });

  it("割り切れない値: 1366×768 × 1.25 = 1707.5×960 → 物理 1708×960 に丸め、exact=false", () => {
    const r = describeDisplayLayout([D(1, 0, 0, 1366, 768, 1.25)])[0];
    expect([r.physicalW, r.physicalH, r.physicalExact]).toEqual([1708, 960, false]);
  });

  it("メガピクセル: 3000×2000（拡大率 1）は 6.0", () => {
    expect(describeDisplayLayout([D(1, 0, 0, 3000, 2000)])[0].megapixels).toBeCloseTo(6, 9);
  });

  it("壊れた入力は例外にならず、0 で埋めない（bounds 欠落・幅 0・NaN）", () => {
    const rows = describeDisplayLayout([
      { id: 1 },
      { id: 2, bounds: null },
      D(3, 0, 0, 0, 1080),
      D(4, 0, 0, Number.NaN, 1080),
      D(5, 0, 0, 1920, 1080),
    ]);
    for (const id of [1, 2, 3, 4]) {
      expect(byId(rows, id)).toMatchObject({ known: false, order: null, orientation: null, width: null, physicalW: null, megapixels: null });
    }
    expect(byId(rows, 5)).toMatchObject({ known: true, order: 1 }); // 壊れたものは並びの番号を取らない
  });

  it("拡大率が壊れていても、向きと大きさは出し、物理画素・メガピクセルだけ null（1 で埋めない）", () => {
    for (const s of [undefined, null, 0, -1, Number.NaN]) {
      const r = describeDisplayLayout([{ id: 1, bounds: { x: 0, y: 0, width: 1200, height: 1920 }, scaleFactor: s as number }])[0];
      expect(r).toMatchObject({ known: true, orientation: "portrait", width: 1200, height: 1920, physicalW: null, physicalH: null, physicalExact: null, megapixels: null });
    }
  });

  it("id が JavaScript の安全な整数を超えて同じ値になっても（Linux の実例 25442431418447940）、位置で正しく並びが決まる", () => {
    const big = 25442431418447940;
    const rows = describeDisplayLayout([D(big, 1200, 0, 1200, 1920), D(big + 1, 0, 0, 1920, 1080)]);
    expect(big + 1).toBe(big); // 前提: 2 つの id は同じ数値になる
    expect(rows.map((r) => r.order)).toEqual([2, 1]);
    expect(rows.map((r) => r.orientation)).toEqual(["portrait", "landscape"]);
    expect(layoutMap([D(big, 1200, 0, 1200, 1920), D(big + 1, 0, 0, 1920, 1080)], 300, 100).map((b) => [b.index, b.order])).toEqual([[0, 2], [1, 1]]);
  });

  it("モニターが 0 枚・1 枚", () => {
    expect(describeDisplayLayout([])).toEqual([]);
    expect(describeDisplayLayout([D(7, 0, 0, 2560, 1440)])[0]).toMatchObject({ order: 1, orientation: "landscape" });
  });
});

describe("layoutMap", () => {
  it("外接矩形が枠に収まり、相対位置と縦横比が保たれる（縦・縦・横の並び）", () => {
    const ds = [D(1, 0, 0, 1200, 1920), D(2, 1200, 0, 1200, 1920), D(3, 2400, 400, 1920, 1080)];
    const boxes = layoutMap(ds, 360, 200);
    expect(boxes.map((b) => b.order)).toEqual([1, 2, 3]);
    // 外接矩形は 4320 × 1920。k = min(360/4320, 200/1920) = 1/12
    const k = Math.min(360 / 4320, 200 / 1920);
    expect(boxes[0]).toMatchObject({ left: 0, top: 0 });
    expect(boxes[0].width).toBeCloseTo(1200 * k, 9);
    expect(boxes[0].height).toBeCloseTo(1920 * k, 9);
    expect(boxes[2].left).toBeCloseTo(2400 * k, 9);
    expect(boxes[2].top).toBeCloseTo(400 * k, 9);
    for (const b of boxes) {
      expect(b.left).toBeGreaterThanOrEqual(0);
      expect(b.top).toBeGreaterThanOrEqual(0);
      expect(b.left + b.width).toBeLessThanOrEqual(360 + 1e-9);
      expect(b.top + b.height).toBeLessThanOrEqual(200 + 1e-9);
    }
  });

  it("負の座標は外接矩形の左上に合わせて 0 から始まる。壊れたモニターは含めない・0 枚は空", () => {
    const boxes = layoutMap([D(1, -1200, -300, 1200, 1920), D(2, 0, 0, 1920, 1080), { id: 3 }], 300, 300);
    expect(boxes).toHaveLength(2);
    expect(boxes.find((b) => b.id === 1)).toMatchObject({ left: 0, order: 1 });
    expect(boxes.find((b) => b.id === 1)!.top).toBeCloseTo(0, 9);
    expect(layoutMap([], 300, 300)).toEqual([]);
    expect(layoutMap([{ id: 1 }], 300, 300)).toEqual([]);
  });
});
