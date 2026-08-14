import { describe, expect, it } from "vitest";
import {
  findEdgesInProfile,
  referenceDiameters,
  runQca,
  sampleBilinear,
  smoothPath,
  tracePath,
} from "./qca";

/**
 * QCA の数値検証（fw/angio-design.md §8）。
 *
 * <p>**真値が既知の合成ファントム**（`bench/` の GNBP-XA-1 の縮小版）で測る。
 * 実データには真値が無いので「それらしく見える」以上の判定ができない — ここを混ぜないこと。
 *
 * <p>ファントム: 水平に走る血管。背景 200、血管内 60（造影＝暗い）。
 * 境界は 1px のランプにしてあり、**ランプ中心が真の境界**になる。
 */
const BG = 200;
const VESSEL = 60;

interface Phantom {
  pixels: Float32Array;
  width: number;
  height: number;
}

/** 直径 d(x) [px] の水平血管。cy は中心線の y 座標。 */
function makeVessel(width: number, height: number, cy: number, radiusAt: (x: number) => number): Phantom {
  const pixels = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const r = radiusAt(x);
      const dist = Math.abs(y - cy);
      // 境界に 1px のランプ（中心 r）。inside=1 → 血管、outside=0 → 背景。
      const inside = Math.max(0, Math.min(1, r + 0.5 - dist));
      pixels[y * width + x] = BG - (BG - VESSEL) * inside;
    }
  }
  return { pixels, width, height };
}

describe("sampleBilinear", () => {
  it("格子点はそのままの値", () => {
    const px = Float32Array.from([1, 2, 3, 4]);
    expect(sampleBilinear(px, 2, 2, 0, 0)).toBe(1);
    expect(sampleBilinear(px, 2, 2, 1, 1)).toBe(4);
  });

  it("中間点は線形補間", () => {
    const px = Float32Array.from([0, 10, 0, 10]);
    expect(sampleBilinear(px, 2, 2, 0.5, 0)).toBeCloseTo(5, 6);
  });

  it("範囲外は端の値（clamp）", () => {
    const px = Float32Array.from([7, 7, 7, 7]);
    expect(sampleBilinear(px, 2, 2, -5, -5)).toBe(7);
    expect(sampleBilinear(px, 2, 2, 99, 99)).toBe(7);
  });
});

describe("findEdgesInProfile — サブピクセル・エッジ", () => {
  it("★真の境界を 0.1px 精度で当てる", () => {
    // 中心 index=40（step 0.25 → 中心から ±10px）。境界を ±3.0px に置く。
    const step = 0.25;
    const half = 40;
    const trueR = 3.0;
    const profile: number[] = [];
    for (let k = -half; k <= half; k++) {
      const d = Math.abs(k * step);
      const inside = Math.max(0, Math.min(1, trueR + 0.5 - d));
      profile.push(BG - (BG - VESSEL) * inside);
    }
    const e = findEdgesInProfile(profile, half, step)!;
    expect(e).not.toBeNull();
    expect(Math.abs(e.left + trueR)).toBeLessThan(0.15);
    expect(Math.abs(e.right - trueR)).toBeLessThan(0.15);
  });

  it("平坦なプロファイル（エッジ無し）では null", () => {
    expect(findEdgesInProfile(new Array(81).fill(100), 40, 0.25)).toBeNull();
  });

  it("短すぎるプロファイルは null", () => {
    expect(findEdgesInProfile([1, 2, 3], 1, 1)).toBeNull();
  });
});

describe("tracePath — 中心線抽出", () => {
  it("暗い血管に沿って経路を引く", () => {
    const p = makeVessel(60, 40, 20, () => 3);
    const path = tracePath(p.pixels, p.width, p.height, [5, 20], [54, 20], true, 15)!;
    expect(path).not.toBeNull();
    expect(path.length).toBeGreaterThan(40);
    // 経路は血管の中（|y-20| <= 3）に収まる。
    for (const [, y] of path) expect(Math.abs(y - 20)).toBeLessThanOrEqual(3);
  });

  it("明るい構造を追う指定（DSA 後）も同じ経路になる", () => {
    // 差分画像相当（血管が明るい）に反転して同じ結果になること。
    const p = makeVessel(60, 40, 20, () => 3);
    const inverted = Float32Array.from(p.pixels, (v) => 255 - v);
    const path = tracePath(inverted, p.width, p.height, [5, 20], [54, 20], false, 15)!;
    for (const [, y] of path) expect(Math.abs(y - 20)).toBeLessThanOrEqual(3);
  });

  it("範囲外の指定は null", () => {
    const p = makeVessel(20, 20, 10, () => 3);
    expect(tracePath(p.pixels, p.width, p.height, [-1, 10], [15, 10], true)).toBeNull();
  });
});

describe("smoothPath", () => {
  it("端点は動かさない（ユーザ指定を尊重）", () => {
    const path: [number, number][] = [[0, 0], [1, 5], [2, 0], [3, 5], [4, 0]];
    const s = smoothPath(path, 3);
    expect(s[0]).toEqual([0, 0]);
    expect(s[4]).toEqual([4, 0]);
  });

  it("ギザギザが減る", () => {
    const path: [number, number][] = [[0, 0], [1, 4], [2, 0], [3, 4], [4, 0], [5, 4], [6, 0]];
    const s = smoothPath(path, 3);
    expect(Math.abs(s[3][1] - 2)).toBeLessThan(1.5);
  });
});

describe("referenceDiameters — 参照径の当てはめ", () => {
  it("狭窄部に引っ張られない（健常部の傾向を保つ）", () => {
    const pos = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    // 一定径 3.0 のうち中央 3 点だけ 1.0（狭窄）。
    const dia = [3, 3, 3, 1, 1, 1, 3, 3, 3, 3];
    const ref = referenceDiameters(pos, dia);
    for (const r of ref) expect(Math.abs(r - 3)).toBeLessThan(0.3);
  });

  it("テーパー（先細り）を線形で追える", () => {
    const pos = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    const dia = pos.map((p) => 4 - 0.2 * p);
    const ref = referenceDiameters(pos, dia);
    expect(ref[0]).toBeCloseTo(4, 1);
    expect(ref[9]).toBeCloseTo(2.2, 1);
  });

  it("点が少なくても壊れない", () => {
    expect(referenceDiameters([], [])).toEqual([]);
    expect(referenceDiameters([0, 1], [3, 3])).toEqual([3, 3]);
  });
});

describe("★runQca — 真値既知ファントムでの精度", () => {
  const mmPerPx = 0.2; // 1px = 0.2mm

  it("狭窄なし: 径が真値どおり（誤差 < 0.1mm）", () => {
    const trueDiameterMm = 3.0;
    const rPx = trueDiameterMm / 2 / mmPerPx; // 7.5px
    const p = makeVessel(120, 60, 30, () => rPx);
    const r = runQca({
      pixels: p.pixels,
      width: p.width,
      height: p.height,
      start: [10, 30],
      end: [109, 30],
      mmPerPxRow: mmPerPx,
      mmPerPxCol: mmPerPx,
      vesselIsDark: true,
      profileRadiusPx: 20,
    })!;
    expect(r).not.toBeNull();
    expect(r.unit).toBe("mm");
    const mean = r.diameters.reduce((a, b) => a + b, 0) / r.diameters.length;
    expect(Math.abs(mean - trueDiameterMm)).toBeLessThan(0.1);
    // 狭窄が無いので %DS はほぼ 0。
    expect(r.percentDiameterStenosis).toBeLessThan(5);
  });

  // 設計 §16.3 の合否基準「ノイズ無しで %DS の絶対誤差 < 2%」を満たすこと。
  it.each([
    [30, 2],
    [50, 2],
    [70, 2],
  ])("★%DS %i%% を絶対誤差 < %i%% で当てる", (truePercent, tol) => {
    const refDiameterMm = 3.0;
    const refRpx = refDiameterMm / 2 / mmPerPx;
    const minRpx = refRpx * (1 - truePercent / 100);
    const center = 60;
    const lesionHalf = 15; // px
    const p = makeVessel(120, 60, 30, (x) => {
      const d = Math.abs(x - center);
      if (d >= lesionHalf) return refRpx;
      // 余弦テーパーで滑らかに絞る（実病変に近く、エッジ検出の当て込みも安定する）。
      const f = 0.5 * (1 + Math.cos((Math.PI * d) / lesionHalf));
      return refRpx - (refRpx - minRpx) * f;
    });
    const r = runQca({
      pixels: p.pixels,
      width: p.width,
      height: p.height,
      start: [10, 30],
      end: [109, 30],
      mmPerPxRow: mmPerPx,
      mmPerPxCol: mmPerPx,
      vesselIsDark: true,
      profileRadiusPx: 20,
    })!;
    expect(r).not.toBeNull();
    expect(Math.abs(r.percentDiameterStenosis - truePercent)).toBeLessThan(tol);
    // MLD の真値は refDiameterMm * (1 - %DS/100)。
    const trueMld = refDiameterMm * (1 - truePercent / 100);
    expect(Math.abs(r.mld - trueMld)).toBeLessThan(0.1);
    // 参照径は 3.0mm 付近。
    expect(Math.abs(r.rvd - refDiameterMm)).toBeLessThan(0.15);
    // 面積狭窄率は円形断面の仮定どおり。
    const expectedArea = (1 - (1 - truePercent / 100) ** 2) * 100;
    expect(Math.abs(r.percentAreaStenosis - expectedArea)).toBeLessThan(5);
  });

  it("MLD は狭窄の中心付近に来る", () => {
    const refRpx = 7.5;
    const center = 60;
    const p = makeVessel(120, 60, 30, (x) => {
      const d = Math.abs(x - center);
      return d >= 15 ? refRpx : refRpx * (1 - 0.5 * 0.5 * (1 + Math.cos((Math.PI * d) / 15)));
    });
    const r = runQca({
      pixels: p.pixels,
      width: p.width,
      height: p.height,
      start: [10, 30],
      end: [109, 30],
      mmPerPxRow: 0.2,
      mmPerPxCol: 0.2,
    })!;
    const mldX = r.centerline[r.mldIndex][0];
    expect(Math.abs(mldX - center)).toBeLessThan(6);
  });

  it("未校正なら px 単位で返す（mm を騙らない）", () => {
    const p = makeVessel(120, 60, 30, () => 7.5);
    const r = runQca({
      pixels: p.pixels,
      width: p.width,
      height: p.height,
      start: [10, 30],
      end: [109, 30],
      mmPerPxRow: null,
      mmPerPxCol: null,
    })!;
    expect(r.unit).toBe("px");
    expect(r.warnings).toContain("uncalibrated");
    expect(r.mld).toBeGreaterThan(14); // 直径 15px 相当
  });

  it("血管が無い（平坦な）画像では null", () => {
    const flat = new Float32Array(60 * 40).fill(100);
    expect(
      runQca({ pixels: flat, width: 60, height: 40, start: [5, 20], end: [54, 20] }),
    ).toBeNull();
  });
});
