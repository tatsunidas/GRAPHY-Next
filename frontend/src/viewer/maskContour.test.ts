/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, it, expect } from "vitest";
import { fillPolygonsEvenOdd, signedArea, traceMaskContours, type Pt } from "./maskContour";

function grid(rows: string[]): { labels: Uint8Array; w: number; h: number } {
  const h = rows.length, w = rows[0].length;
  const labels = new Uint8Array(w * h);
  rows.forEach((r, y) => [...r].forEach((ch, x) => (labels[y * w + x] = ch === "." ? 0 : Number(ch) || 1)));
  return { labels, w, h };
}

/** マスク → 輪郭 → 偶奇で塗り直し。元の前景と同じになるか。 */
function roundTrip(labels: ArrayLike<number>, w: number, h: number, segment?: number) {
  const cs = traceMaskContours(labels, w, h, segment);
  const polys: Pt[][] = cs.flatMap((c) => [c.outer, ...c.holes]);
  const back = fillPolygonsEvenOdd(polys, w, h);
  const want = Array.from(labels, (v) => (segment === undefined ? (v > 0 ? 1 : 0) : v === segment ? 1 : 0));
  return { cs, back: Array.from(back), want };
}

describe("traceMaskContours", () => {
  it("1 画素は、画素の 4 隅を時計回りに回る正方形", () => {
    const { labels, w, h } = grid(["...", ".#.", "..."]);
    const cs = traceMaskContours(labels, w, h);
    expect(cs).toHaveLength(1);
    expect(cs[0].outer).toEqual([[1, 1], [2, 1], [2, 2], [1, 2]]);
    expect(signedArea(cs[0].outer)).toBe(1);
    expect(cs[0].holes).toEqual([]);
  });

  it("矩形は曲がり角の 4 点だけになる", () => {
    const { labels, w, h } = grid(["......", ".####.", ".####.", "......"]);
    const cs = traceMaskContours(labels, w, h);
    expect(cs[0].outer).toEqual([[1, 1], [5, 1], [5, 3], [1, 3]]);
  });

  it("ドーナツは外周 1 本と穴 1 本（穴は反時計回り）", () => {
    const { labels, w, h } = grid([".....", ".###.", ".#.#.", ".###.", "....."]);
    const cs = traceMaskContours(labels, w, h);
    expect(cs).toHaveLength(1);
    expect(cs[0].holes).toHaveLength(1);
    expect(signedArea(cs[0].outer)).toBe(9);
    expect(signedArea(cs[0].holes[0])).toBe(-1);
  });

  it("穴の中の島は、別の成分（外周）になる", () => {
    const { labels, w, h } = grid([
      ".......",
      ".#####.",
      ".#...#.",
      ".#.#.#.",
      ".#...#.",
      ".#####.",
      ".......",
    ]);
    const cs = traceMaskContours(labels, w, h);
    expect(cs).toHaveLength(2);
    expect(cs.map((c) => c.holes.length).sort()).toEqual([0, 1]);
  });

  it("角だけで接する 2 画素は、別々の外周になる（4 近傍）", () => {
    const { labels, w, h } = grid(["#.", ".#"]);
    const cs = traceMaskContours(labels, w, h);
    expect(cs).toHaveLength(2);
    expect(cs.every((c) => signedArea(c.outer) === 1)).toBe(true);
  });

  it("segment を指定すると、その番号だけをなぞる", () => {
    const { labels, w, h } = grid(["11.22", "11.22"]);
    expect(traceMaskContours(labels, w, h, 2)[0].outer).toEqual([[3, 0], [5, 0], [5, 2], [3, 2]]);
  });

  it("空なら何も返さない", () => {
    expect(traceMaskContours(new Uint8Array(9), 3, 3)).toEqual([]);
  });
});

describe("往復（マスク→輪郭→塗り直し）で画素が 1 つも変わらない", () => {
  const cases: Record<string, string[]> = {
    矩形: ["......", ".####.", ".####.", "......"],
    円: [
      "..###..",
      ".#####.",
      "#######",
      "#######",
      "#######",
      ".#####.",
      "..###..",
    ],
    ドーナツ: [".....", ".###.", ".#.#.", ".###.", "....."],
    穴の中の島: [".......", ".#####.", ".#...#.", ".#.#.#.", ".#...#.", ".#####.", "......."],
    角だけで接する: ["#.#", ".#.", "#.#"],
    画像の端: ["##..", "#...", "...#", "..##"],
    "1 画素": ["#"],
    全面: ["###", "###"],
    市松: ["#.#.", ".#.#", "#.#.", ".#.#"],
  };
  for (const [name, rows] of Object.entries(cases)) {
    it(name, () => {
      const { labels, w, h } = grid(rows);
      const r = roundTrip(labels, w, h);
      expect(r.back).toEqual(r.want);
    });
  }

  it("乱数で作った形 100 通り（シード固定・複数 segment）", () => {
    let seed = 12345;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let t = 0; t < 100; t++) {
      const w = 3 + Math.floor(rand() * 14), h = 3 + Math.floor(rand() * 14);
      const p = 0.2 + rand() * 0.6;
      const labels = new Uint8Array(w * h);
      for (let i = 0; i < labels.length; i++) labels[i] = rand() < p ? 1 + Math.floor(rand() * 3) : 0;
      for (const seg of [undefined, 1, 2, 3]) {
        const r = roundTrip(labels, w, h, seg);
        expect(r.back, `case ${t} seg ${seg}`).toEqual(r.want);
      }
    }
  });
});

describe("fillPolygonsEvenOdd", () => {
  // 参照: 画素中心での半開区間のレイキャスト（roiBooleanOps の点の内外判定と同じ式）。
  const inside = (px: number, py: number, polys: Pt[][]) => {
    let c = false;
    for (const poly of polys)
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, yi] = poly[i], [xj, yj] = poly[j];
        if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) c = !c;
      }
    return c;
  };
  it("端数のある多角形（重なり・自己交差を含む）でも、画素中心のレイキャストと一致する", () => {
    let seed = 99;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let t = 0; t < 60; t++) {
      const w = 12, h = 10;
      const polys: Pt[][] = Array.from({ length: 1 + Math.floor(rand() * 3) }, () =>
        Array.from({ length: 3 + Math.floor(rand() * 5) }, () => [rand() * (w + 2) - 1, rand() * (h + 2) - 1] as Pt),
      );
      const got = Array.from(fillPolygonsEvenOdd(polys, w, h));
      const want: number[] = [];
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) want.push(inside(x + 0.5, y + 0.5, polys) ? 1 : 0);
      expect(got, `case ${t}`).toEqual(want);
    }
  });
});
