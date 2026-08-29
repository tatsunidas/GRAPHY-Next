/*
 * ストレート像（§8.9）の純ロジック。
 *
 * 🔴 ここで守りたいのは「絵が出る」ことではなく、**帯の座標が本画面の量と同じ意味を持つ**こと。
 * 縦は `edgeOffsets` と同じ符号付きオフセット、横は**弧長**（添字ではない）。
 * どちらかがずれると、帯の上で掴んだエッジが**別の場所へ効く**（値は出るので気付けない）。
 */
import { describe, expect, it } from "vitest";
import {
  buildStraightened,
  cumulativeLength,
  sampleAlong,
  straightenHalfWidth,
} from "./qcaStraighten";

/** 水平な血管: 太さ 6px の明るい帯を、暗い背景に置く。 */
function horizontalVessel(w: number, h: number, cy: number, halfThick: number): Float32Array {
  const px = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      px[y * w + x] = Math.abs(y - cy) <= halfThick ? 100 : 0;
    }
  }
  return px;
}

describe("cumulativeLength", () => {
  it("斜めの区間は √2 で数える（添字で数えない）", () => {
    const cum = cumulativeLength([
      [0, 0],
      [1, 0],
      [2, 1],
    ]);
    expect(cum[0]).toBe(0);
    expect(cum[1]).toBeCloseTo(1, 10);
    expect(cum[2]).toBeCloseTo(1 + Math.SQRT2, 10);
  });
});

describe("sampleAlong", () => {
  const centerline: [number, number][] = [
    [0, 0],
    [10, 0],
    [20, 0],
  ];
  const normals: [number, number][] = [
    [0, 1],
    [0, 1],
    [0, 1],
  ];
  const cum = cumulativeLength(centerline);

  it("端より外は端に張り付く", () => {
    expect(sampleAlong(centerline, normals, cum, -5).x).toBe(0);
    expect(sampleAlong(centerline, normals, cum, 999).x).toBe(20);
  });

  it("弧長から連続添字を返す", () => {
    const p = sampleAlong(centerline, normals, cum, 15);
    expect(p.x).toBeCloseTo(15, 10);
    expect(p.index).toBeCloseTo(1.5, 10);
  });

  it("🔴 補間した法線は正規化される（単位ベクトルの中点は単位ベクトルではない）", () => {
    const turn: [number, number][] = [
      [0, 0],
      [10, 0],
    ];
    const ns: [number, number][] = [
      [0, 1],
      [1, 0],
    ];
    const c2 = cumulativeLength(turn);
    const p = sampleAlong(turn, ns, c2, 5);
    expect(Math.hypot(p.nx, p.ny)).toBeCloseTo(1, 10);
  });
});

describe("straightenHalfWidth", () => {
  it("いちばん外へ出ているエッジより外側まで取る", () => {
    const half = straightenHalfWidth([
      { left: -3, right: 3 },
      { left: -5, right: 4 },
    ]);
    expect(half).toBeGreaterThan(5);
  });

  it("下限と上限で頭打ちにする（細すぎ／縦に伸びすぎを避ける）", () => {
    expect(straightenHalfWidth([{ left: -0.3, right: 0.3 }])).toBe(8);
    expect(straightenHalfWidth([{ left: -500, right: 500 }])).toBe(48);
  });
});

describe("buildStraightened", () => {
  const width = 60;
  const height = 40;
  const cy = 20;
  const pixels = horizontalVessel(width, height, cy, 3);
  const centerline: [number, number][] = [];
  const normals: [number, number][] = [];
  for (let x = 5; x <= 50; x++) {
    centerline.push([x, cy]);
    normals.push([0, 1]);
  }

  it("計測点が足りなければ null", () => {
    expect(buildStraightened({ centerline: [[0, 0]], normals: [[0, 1]], pixels, width, height, halfWidthPx: 8, lo: 0, hi: 100 })).toBeNull();
  });

  it("帯の中心行が中心線・上下が法線方向のオフセットになる", () => {
    const st = buildStraightened({ centerline, normals, pixels, width, height, halfWidthPx: 8, lo: 0, hi: 100 })!;
    expect(st.rows).toBe(17);
    expect(st.halfWidthPx).toBe(8);
    // 中心行は血管の中（明るい）
    expect(st.gray[10 * st.rows + st.halfWidthPx]).toBeGreaterThan(200);
    // ±3px は内腔の縁、±6px は外（暗い）
    expect(st.gray[10 * st.rows + (st.halfWidthPx + 6)]).toBeLessThan(40);
    expect(st.gray[10 * st.rows + (st.halfWidthPx - 6)]).toBeLessThan(40);
  });

  it("横は弧長で等間隔（列数が全長と一致する）", () => {
    const st = buildStraightened({ centerline, normals, pixels, width, height, halfWidthPx: 8, lo: 0, hi: 100 })!;
    expect(st.lengthPx).toBeCloseTo(45, 10);
    expect(st.cols).toBe(46);
    // 計測点 → 列は 1:1（この血管は 1px 間隔なので）
    expect(st.indexToCol[0]).toBeCloseTo(0, 6);
    expect(st.indexToCol[45]).toBeCloseTo(45, 6);
  });

  it("🔴 斜めの血管でも列は弧長で刻む（添字で刻むと縮む）", () => {
    const diag: [number, number][] = [];
    const dn: [number, number][] = [];
    for (let k = 0; k < 20; k++) {
      diag.push([5 + k, 5 + k]);
      dn.push([-Math.SQRT1_2, Math.SQRT1_2]);
    }
    const st = buildStraightened({ centerline: diag, normals: dn, pixels, width, height, halfWidthPx: 6, lo: 0, hi: 100 })!;
    // 19 区間 × √2 ≒ 26.87px。添字で刻んでいたら 20 列になる。
    expect(st.lengthPx).toBeCloseTo(19 * Math.SQRT2, 6);
    expect(st.cols).toBe(28);
  });

  it("窓（lo/hi）は渡されたものを使う（本画面と同じ見え方にするため）", () => {
    const dark = buildStraightened({ centerline, normals, pixels, width, height, halfWidthPx: 8, lo: 0, hi: 1000 })!;
    const bright = buildStraightened({ centerline, normals, pixels, width, height, halfWidthPx: 8, lo: 0, hi: 100 })!;
    const at = (st: typeof dark) => st.gray[10 * st.rows + st.halfWidthPx];
    expect(at(dark)).toBeLessThan(at(bright));
  });
});
