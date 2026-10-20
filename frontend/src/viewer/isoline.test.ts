import { describe, expect, it } from "vitest";
import type { BackgroundSliceMeta } from "./fusionEngine";
import { extractIsolines, isolineToWorld, isolinesToPath } from "./isoline";

/** 等方ガウス f(r)=A·exp(−r²/2σ²)+B を、背景スライスの各画素の world 位置で解析的に評価して置く。 */
function gaussianOnGrid(bg: BackgroundSliceMeta, center: [number, number, number], A: number, B: number, sigma: number) {
  const values = new Float32Array(bg.cols * bg.rows);
  for (let by = 0; by < bg.rows; by++) {
    for (let bx = 0; bx < bg.cols; bx++) {
      const u = bx * bg.pixelSpacingCol;
      const v = by * bg.pixelSpacingRow;
      const p = [
        bg.ipp[0] + u * bg.iop[0] + v * bg.iop[3],
        bg.ipp[1] + u * bg.iop[1] + v * bg.iop[4],
        bg.ipp[2] + u * bg.iop[2] + v * bg.iop[5],
      ];
      const r2 = (p[0] - center[0]) ** 2 + (p[1] - center[1]) ** 2 + (p[2] - center[2]) ** 2;
      values[by * bg.cols + bx] = A * Math.exp(-r2 / (2 * sigma * sigma)) + B;
    }
  }
  return values;
}

const A = 100;
const B = 5;
const SIGMA = 12; // mm
const LEVEL = 40;
const r_L = SIGMA * Math.sqrt(2 * Math.log(A / (LEVEL - B)));

/**
 * 辺上の線形補間の位置誤差の上界（半径方向）。辺方向の 2 階微分は Hessian の固有値
 * f''（半径方向）と f'/r（接線方向）の間に収まり、辺と半径方向の角 φ の cosφ は相殺する。
 * ε = (h²/8)·max(|f''|,|f'/r|)/|f'| ＋ 2 次の幾何項 δ²/(2r) ＋ float32 丸め。
 */
function epsilon(h: number): number {
  const ratio = Math.max(Math.abs(r_L * r_L / (SIGMA * SIGMA) - 1), 1) / r_L; // max(|f''|,|f'/r|)/|f'|
  const delta = (h * h / 8) * ratio;
  const fPrime = (A * Math.exp(-r_L * r_L / (2 * SIGMA * SIGMA)) * r_L) / (SIGMA * SIGMA);
  const f32 = (2 ** -23 * (A + B)) / fPrime;
  return delta + (delta * delta) / (2 * r_L) + f32;
}

function bgAxial(): BackgroundSliceMeta {
  return { iop: [1, 0, 0, 0, 1, 0], ipp: [-50, -50, 7], pixelSpacingCol: 0.8, pixelSpacingRow: 1.0, cols: 126, rows: 101 };
}

function bgOblique(): BackgroundSliceMeta {
  const t = (30 * Math.PI) / 180; // 面内で 30° 回し、さらに行軸を z 側へ 30° 倒す
  const row: [number, number, number] = [Math.cos(t), Math.sin(t), 0];
  const col: [number, number, number] = [-Math.sin(t) * Math.cos(t), Math.cos(t) * Math.cos(t), Math.sin(t)];
  return { iop: [...row, ...col], ipp: [-40, -45, -20], pixelSpacingCol: 0.8, pixelSpacingRow: 1.0, cols: 140, rows: 120 };
}

/** 斜位は断面が球の中心を通る位置に置く（中心から断面までの距離 0）。 */
function centerOf(bg: BackgroundSliceMeta): [number, number, number] {
  const u = (bg.cols / 2) * bg.pixelSpacingCol;
  const v = (bg.rows / 2) * bg.pixelSpacingRow;
  return [
    bg.ipp[0] + u * bg.iop[0] + v * bg.iop[3],
    bg.ipp[1] + u * bg.iop[1] + v * bg.iop[4],
    bg.ipp[2] + u * bg.iop[2] + v * bg.iop[5],
  ];
}

function maxRadiusError(bg: BackgroundSliceMeta, lines: ReturnType<typeof extractIsolines>, c: [number, number, number]) {
  let worst = 0;
  for (const ln of isolineToWorld(lines, bg)) {
    for (const p of ln) {
      const r = Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]);
      worst = Math.max(worst, Math.abs(r - r_L));
    }
  }
  return worst;
}

describe("extractIsolines（解析式の真値）", () => {
  for (const [name, mk] of [["軸位", bgAxial], ["斜位（面内 30° ＋ 行軸 30° 傾斜）", bgOblique]] as const) {
    it(`${name}: 閉じた 1 本で、全頂点の半径が r_L に ε 以内で一致する`, () => {
      const bg = mk();
      const c = centerOf(bg);
      const values = gaussianOnGrid(bg, c, A, B, SIGMA);
      const lines = extractIsolines(values, bg.cols, bg.rows, LEVEL);
      expect(lines).toHaveLength(1);
      expect(lines[0].closed).toBe(true);
      const h = Math.max(bg.pixelSpacingCol, bg.pixelSpacingRow);
      const err = maxRadiusError(bg, lines, c);
      expect(err).toBeLessThanOrEqual(epsilon(h));
      // 誤差の上界が自明に緩くない（格子間隔の 1/10 未満）ことも確かめる。
      expect(epsilon(h)).toBeLessThan(h / 10);
    });
  }

  it("負例の識別力: 交点を辺の中点に置く誤実装では ε 照合が落ちる", () => {
    const bg = bgAxial();
    const c = centerOf(bg);
    const values = gaussianOnGrid(bg, c, A, B, SIGMA);
    const lines = extractIsolines(values, bg.cols, bg.rows, LEVEL, () => 0.5);
    const h = Math.max(bg.pixelSpacingCol, bg.pixelSpacingRow);
    expect(maxRadiusError(bg, lines, c)).toBeGreaterThan(epsilon(h));
  });

  it("level が前景の最大値を超えると線は 0 本", () => {
    const bg = bgAxial();
    const values = gaussianOnGrid(bg, centerOf(bg), A, B, SIGMA);
    expect(extractIsolines(values, bg.cols, bg.rows, A + B + 1)).toHaveLength(0);
  });

  it("NaN を含むセルには線が出ない（前景の範囲外の縁に偽の輪郭を作らない）", () => {
    const bg = bgAxial();
    const values = gaussianOnGrid(bg, centerOf(bg), A, B, SIGMA);
    // 左半分を範囲外（NaN）にする。背景 B=5 より低い level=2 では、NaN の縁以外に線は無いはず。
    for (let y = 0; y < bg.rows; y++) for (let x = 0; x < bg.cols / 2; x++) values[y * bg.cols + x] = NaN;
    expect(extractIsolines(values, bg.cols, bg.rows, 2)).toHaveLength(0);
    // 範囲内の線は残る: 球の右半分の弧。NaN 側に頂点は無い。
    const lines = extractIsolines(values, bg.cols, bg.rows, LEVEL);
    expect(lines.length).toBeGreaterThan(0);
    for (const ln of lines) for (let i = 0; i < ln.points.length; i += 2) expect(ln.points[i]).toBeGreaterThanOrEqual(bg.cols / 2 - 1);
  });

  it("鞍点（市松 2×2）: 4 隅の平均で接続が決まる", () => {
    // 00 と 11 が高い。平均 5。
    const v = new Float32Array([10, 0, 0, 10]);
    // level 4（平均 5 ≥ 4 → 中心は内）: 内の 00 と 11 がつながり、外の 10・01 が孤立 → 辺 T-R と L-B。
    const a = extractIsolines(v, 2, 2, 4);
    expect(a).toHaveLength(2);
    for (const ln of a) expect(ln.points.length).toBe(4);
    const pts = (ls: typeof a) => ls.map((l) => Array.from(l.points).map((x) => +x.toFixed(3)).join(",")).sort();
    // T-R: 水平辺(0,0)-(1,0) の交点 (0.6,0)、垂直辺 (1,0)-(1,1) の交点 (1,0.4)。L-B: (0,0.6)・(0.4,1)。
    expect(pts(a)).toEqual(["0,0.6,0.4,1", "0.6,0,1,0.4"].sort());
    // level 6（平均 5 < 6 → 中心は外）: 内の 00 と 11 が孤立 → L-T と R-B。
    const b = extractIsolines(v, 2, 2, 6);
    expect(b).toHaveLength(2);
    expect(pts(b)).toEqual(["0,0.4,0.4,0", "1,0.6,0.6,1"].sort());
  });

  it("開いた線: 格子の端で切れる等値線は closed=false", () => {
    const v = new Float32Array(3 * 3);
    for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) v[y * 3 + x] = x; // x に比例する傾斜
    const ls = extractIsolines(v, 3, 3, 0.5);
    expect(ls).toHaveLength(1);
    expect(ls[0].closed).toBe(false);
    expect(Array.from(ls[0].points).filter((_, i) => i % 2 === 0).every((x) => Math.abs(x - 0.5) < 1e-6)).toBe(true);
  });

  it("isolinesToPath は閉曲線に Z を付ける", () => {
    const bg = bgAxial();
    const values = gaussianOnGrid(bg, centerOf(bg), A, B, SIGMA);
    const d = isolinesToPath(extractIsolines(values, bg.cols, bg.rows, LEVEL));
    expect(d.startsWith("M")).toBe(true);
    expect(d.endsWith("Z")).toBe(true);
  });

  it("512×512 の抽出時間（計測のみ・判定しない）", () => {
    const n = 512;
    const bg: BackgroundSliceMeta = { iop: [1, 0, 0, 0, 1, 0], ipp: [0, 0, 0], pixelSpacingCol: 1, pixelSpacingRow: 1, cols: n, rows: n };
    const values = gaussianOnGrid(bg, [256, 256, 0], A, B, 60);
    const t0 = performance.now();
    const ls = extractIsolines(values, n, n, LEVEL);
    const ms = performance.now() - t0;
    console.log(`isoline 512x512: ${ms.toFixed(1)} ms, ${ls.length} line(s)`);
    expect(ls.length).toBeGreaterThan(0);
  });
});
