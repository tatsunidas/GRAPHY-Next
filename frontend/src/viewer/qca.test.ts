import { describe, expect, it } from "vitest";
import {
  centerlineToken,
  findEdgesInProfile,
  lesionBounds,
  profileNoiseScale,
  referenceDiameters,
  referenceDiametersFit,
  referenceFromEndsFit,
  runQca,
  toRanges,
  sampleBilinear,
  smoothPath,
  traceCenterline,
  tracePath,
  type QcaManualEdits,
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

/**
 * 🚨 **このファイルのファントムでは密度計測（§16.5）を必ず切る。**
 *
 * <p>密度計測はビール則（`I = I₀·exp(−μ·L)`）を前提に **−ln I を積分して断面積**を出す。
 * ここのファントムは**透過画像ではなく**、内外を線形に混ぜただけの箱型なので、
 * −ln を取っても物理的な意味が無い（μ も定義できない）。切らずに回すと、
 * 「箱型の幅」と「面積等価直径」という**別の量**を比べることになる。
 *
 * <p>これは §16.4 が名指しした罠そのもの——**ファントムが物理的に正しくないと、
 * テストは「実装がファントムに合っていること」しか保証しない**。
 * 密度計測の正しさは、ビール則で作った断面（下の「★密度計測」）と
 * `bench/` の GNBP-XA-7 でだけ測る。
 */
const SLAB = { densitometry: false } as const;

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

/**
 * 🚨 **このファントムは箱型（スラブ）断面**であって円柱ではない。
 *
 * <p>幅方向の減弱が一様なのでエッジは直線ランプになり、**半値法が厳密に正しく**なる。
 * だからここでは「半値法が真値ちょうど」と出る。**実際の血管は円柱**で、投影プロファイルは
 * p(d) ∝ −√(r²−d²) の形になり、半値をよぎるのは d = (√3/2)·r ≈ 0.866·r
 * ——**真の半径ではない**。`bench/` の GNBP-XA（円柱・ビール則）で実測したところ、
 * 径は一貫して 13% 過小に出た（設計 §16.4）。
 *
 * <p>つまり**このファイルの数値は「箱型断面に対する正しさ」しか保証しない**。
 * 円柱に対する精度は bench 側でしか測れない。ここを混同しないこと
 * （半値法を採用した判断そのものが、箱型ファントムの上でだけ正しかった）。
 */

/** 点と線分の距離。 */
function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const vx = bx - ax;
  const vy = by - ay;
  const len2 = vx * vx + vy * vy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / len2)) : 0;
  return Math.hypot(px - (ax + vx * t), py - (ay + vy * t));
}

/** 折れ線の管（半径 r・値 value）を重ねる。暗い方（＝造影の濃い方）が勝つ。 */
function drawTube(
  p: Phantom,
  polyline: readonly (readonly [number, number])[],
  r: number,
  value: number,
): void {
  for (let y = 0; y < p.height; y++) {
    for (let x = 0; x < p.width; x++) {
      let d = Infinity;
      for (let i = 0; i + 1 < polyline.length; i++) {
        const dd = distToSegment(x, y, polyline[i][0], polyline[i][1], polyline[i + 1][0], polyline[i + 1][1]);
        if (dd < d) d = dd;
      }
      const inside = Math.max(0, Math.min(1, r + 0.5 - d));
      if (inside <= 0) continue;
      const v = BG - (BG - value) * inside;
      const idx = y * p.width + x;
      if (v < p.pixels[idx]) p.pixels[idx] = v;
    }
  }
}

function blank(width: number, height: number): Phantom {
  return { pixels: new Float32Array(width * height).fill(BG), width, height };
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

  // 🔴 3D QCA で病変長が 33.7mm / 真値 15.8mm と出た原因（§10.2.8）。
  //    「当てはめ以上の点だけ残す」反復は片側の選別なので、雑音があるだけで
  //    参照径が散布の**上包絡**へ寄り、健常部の大半が「参照径を下回る」ことになる。
  it("★荒れたプロファイルでも参照径が健常部の真ん中を通る（上包絡へ寄らない）", () => {
    // 一定径 3.0 ＋ 決定的な鋸歯状の雑音（±0.3）。狭窄は無い。
    const pos = Array.from({ length: 40 }, (_, i) => i * 0.5);
    const dia = pos.map((_, i) => 3 + (i % 2 ? 0.3 : -0.3));
    const ref = referenceDiameters(pos, dia);
    // 参照径は真ん中（3.0）付近にいること。上包絡なら 3.3 に寄る。
    const mid = ref[Math.floor(ref.length / 2)];
    expect(Math.abs(mid - 3)).toBeLessThan(0.1);
    // ★ 参照径を下回る点は半分程度（上包絡だとほぼ全点が下回る）。
    const below = dia.filter((d, i) => d < ref[i]).length;
    expect(below).toBeLessThan(dia.length * 0.75);
  });

  // 🔴 実データで実際に踏んだ壊れ方（§10.2.8）。357 点のうち端の 6 点だけが太く出ており、
  //    片側の選別（当てはめ以上の点だけ残す）だとその 6 点に当てはめが乗り上げていた。
  it("★解析区間の端の数点が太くても参照径が持ち上がらない", () => {
    const pos = Array.from({ length: 60 }, (_, i) => i * 0.22);
    const dia = pos.map((_, i) => {
      if (i < 3 || i >= 57) return 2.82; // 端の膨らみ（実測と同じ 2.61 → 2.82）
      if (i >= 28 && i <= 32) return 1.3; // 狭窄
      return 2.61;
    });
    const ref = referenceDiameters(pos, dia);
    // 参照径は健常部の 2.61 に乗る（端に乗り上げると 2.7 以上になる）。
    expect(Math.abs(ref[30] - 2.61)).toBeLessThan(0.02);
    // ★ 病変として拾われるのは狭窄の 5 点だけ（端に乗り上げていると区間全部になる）。
    expect(lesionBounds(dia, ref, 30)).toEqual({ lo: 28, hi: 32 });
  });

  it("径をすべて k 倍すると参照径も k 倍になる（1 次同次・%DS が系統誤差に依らない根拠）", () => {
    const pos = Array.from({ length: 30 }, (_, i) => i);
    const dia = pos.map((p, i) => (p > 10 && p < 20 ? 1.5 : 3) + (i % 3 === 0 ? 0.12 : -0.06));
    const k = 1.37;
    const a = referenceDiameters(pos, dia);
    const b = referenceDiameters(pos, dia.map((d) => d * k));
    for (let i = 0; i < a.length; i++) expect(b[i]).toBeCloseTo(a[i] * k, 9);
  });
});

describe("profileNoiseScale — プロファイルの雑音尺度", () => {
  it("滑らかなプロファイルではほぼ 0（＝ 2D の実測値を動かさない）", () => {
    const dia = Array.from({ length: 30 }, (_, i) => 3 - 0.002 * i);
    expect(profileNoiseScale(dia)).toBeLessThan(0.01);
  });

  it("荒れるほど大きくなる", () => {
    const smooth = Array.from({ length: 30 }, () => 3);
    const rough = Array.from({ length: 30 }, (_, i) => 3 + (i % 2 ? 0.4 : -0.4));
    expect(profileNoiseScale(rough)).toBeGreaterThan(profileNoiseScale(smooth) + 0.3);
  });

  it("病変（少数の大きな段差）には引っ張られない", () => {
    const flat = Array.from({ length: 40 }, () => 3);
    const withLesion = flat.map((d, i) => (i >= 18 && i <= 22 ? 1 : d));
    expect(profileNoiseScale(withLesion)).toBeLessThan(0.05);
  });

  it("点が少なければ 0", () => {
    expect(profileNoiseScale([])).toBe(0);
    expect(profileNoiseScale([3, 3])).toBe(0);
  });
});

describe("lesionBounds — 病変の範囲（2D と 3D で共有する 1 本）", () => {
  it("MLD を含む「参照径を下回る」連続区間を返す", () => {
    const dia = [3, 3, 2, 1, 2, 3, 3, 2.9, 3];
    const ref = dia.map(() => 3);
    const b = lesionBounds(dia, ref, 3);
    expect(b).toEqual({ lo: 2, hi: 4 });
  });

  it("参照径を下回る点が MLD だけなら 1 点の区間", () => {
    const dia = [3, 3, 1, 3, 3];
    const ref = dia.map(() => 3);
    expect(lesionBounds(dia, ref, 2)).toEqual({ lo: 2, hi: 2 });
  });

  it("全点が参照径を下回れば全区間（＝参照径が上に寄ったときの壊れ方）", () => {
    const dia = [2.9, 2.8, 1, 2.8, 2.9];
    const ref = dia.map(() => 3);
    expect(lesionBounds(dia, ref, 2)).toEqual({ lo: 0, hi: 4 });
  });
});

describe("★runQca — 真値既知ファントムでの精度", () => {
  const mmPerPx = 0.2; // 1px = 0.2mm

  it("狭窄なし: 径が真値どおり（誤差 < 0.1mm）", () => {
    const trueDiameterMm = 3.0;
    const rPx = trueDiameterMm / 2 / mmPerPx; // 7.5px
    const p = makeVessel(120, 60, 30, () => rPx);
    const r = runQca({
      ...SLAB,
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
      ...SLAB,
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
      ...SLAB,
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
      ...SLAB,
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
      runQca({ ...SLAB, pixels: flat, width: 60, height: 40, start: [5, 20], end: [54, 20] }),
    ).toBeNull();
  });
});

/**
 * 手修正（`fw/angio-design.md` §8.6）。
 *
 * <p>ここの狙いは「手修正の API が動くこと」ではなく、**自動が外れる状況を作って、
 * 手修正で真値に戻ることを数値で示す**こと。実データでは真値が無いのでこれができない
 * （実機検証 §8.5 が「内部整合まで」で止まっているのはそのため）。
 */
/**
 * 円柱断面に対する半値法の系統誤差を**数式として**固定する（設計 §16.4）。
 *
 * <p>bench の実機測定（GNBP-XA、係数 0.870）と同じ現象を、画像を作らずプロファイル 1 本で
 * 押さえておく。エッジ判定を作り直すときに「何がどう変わったか」を比較する基準になる。
 */
describe("★半値法の系統誤差（円柱断面）", () => {
  /** 半径 rTrue の円柱をビール則で投影したプロファイル（背景 1.0）。 */
  function cylinderProfile(rTrue: number, mu: number, half: number, step: number): number[] {
    const out: number[] = [];
    for (let k = -half; k <= half; k++) {
      const d = Math.abs(k * step);
      const path = d < rTrue ? 2 * Math.sqrt(rTrue * rTrue - d * d) : 0;
      out.push(1000 * Math.exp(-mu * path));
    }
    return out;
  }

  /** 半値点の解析解 d/r。μ→0 で √3/2 = 0.8660 に収束する。 */
  function halfMaxRatio(rTrue: number, mu: number): number {
    const threshold = (Math.exp(-2 * mu * rTrue) + 1) / 2;
    const chord = -Math.log(threshold) / (2 * mu); // = √(r²−d²)
    return Math.sqrt(1 - (chord / rTrue) ** 2);
  }

  it.each([
    [0.001, "弱吸収（√3/2 の極限に近い）"],
    [0.02, "実用的な吸収"],
  ])("円柱投影では半値点が真の半径に**ならない**（μ=%f, %s）", (mu) => {
    const step = 0.25;
    const half = 60;
    const rTrue = 7.5;
    const e = findEdgesInProfile(cylinderProfile(rTrue, mu, half, step), half, step)!;
    expect(e).not.toBeNull();
    const measured = (e.right - e.left) / 2 / rTrue;
    // 解析解と一致すること（＝実装が理屈どおりに振る舞っていること）。
    expect(Math.abs(measured - halfMaxRatio(rTrue, mu))).toBeLessThan(0.01);
    // そして真の半径より**必ず小さい**。
    expect(measured).toBeLessThan(0.95);
  });

  it("μ→0 の極限は √3/2 = 0.866（設計 §16.4 の導出）", () => {
    expect(halfMaxRatio(7.5, 1e-6)).toBeCloseTo(Math.sqrt(3) / 2, 4);
  });

  it("箱型（スラブ）断面なら半値法は真値ちょうど — ファントム次第で結論が変わる", () => {
    const step = 0.25;
    const half = 60;
    const rTrue = 7.5;
    const profile: number[] = [];
    for (let k = -half; k <= half; k++) {
      const d = Math.abs(k * step);
      const inside = Math.max(0, Math.min(1, rTrue + 0.5 - d));
      profile.push(BG - (BG - VESSEL) * inside);
    }
    const e = findEdgesInProfile(profile, half, step)!;
    expect(Math.abs((e.right - e.left) / 2 - rTrue)).toBeLessThan(0.15);
  });
});

describe("★手修正 — 自動が外れる状況を作って真値に戻す", () => {
  const mmPerPx = 0.2;

  /**
   * 「隣の、もっと暗い血管」に経路を取られるファントム。
   *
   * <p>目的の血管（y=40 の水平・直径 15px＝**3.0mm**・値 60）と、その上を並走する
   * **より暗い別の血管**（y=12・直径 12px＝2.4mm・値 20）を、始終点の近くで細い首でつなぐ。
   * 暗い方がコストが安いので、自動の最小経路は遠回りしてでも隣の血管を通り、
   * **別の血管の径を測ってしまう**。
   *
   * <p>2 本を「首」以外で重ねていないのが要点。重なっていると経路が逸れても同じ内腔を
   * 測るだけで、径の誤りとして現れない（最初に作ったファントムがそれで、
   * 中心線が蛇行して径が 16% 過大になるという**別の**現象しか出なかった）。
   */
  function decoyPhantom(): Phantom {
    const p = blank(120, 60);
    drawTube(p, [[5, 40], [114, 40]], 7.5, VESSEL);
    drawTube(p, [[18, 12], [101, 12]], 6, 20);
    drawTube(p, [[10, 40], [18, 12]], 2, 20);
    drawTube(p, [[101, 12], [109, 40]], 2, 20);
    return p;
  }

  const decoyInput = (edits?: QcaManualEdits) => {
    const p = decoyPhantom();
    return runQca({
      ...SLAB,
      pixels: p.pixels,
      width: p.width,
      height: p.height,
      start: [10, 40],
      end: [109, 40],
      mmPerPxRow: mmPerPx,
      mmPerPxCol: mmPerPx,
      vesselIsDark: true,
      profileRadiusPx: 20,
      edits,
    });
  };

  const median = (a: readonly number[]) => [...a].sort((x, y) => x - y)[a.length >> 1];

  it("前提: 自動は隣の暗い血管に取られて径を誤る（この誤りが無いと以下の検証は無意味）", () => {
    const auto = decoyInput()!;
    expect(auto).not.toBeNull();
    // 経路が y=40 の血管から外れて隣（y=12）へ乗り移っている。実測 maxDev 23px。
    expect(Math.min(...auto.centerline.map((c) => c[1]))).toBeLessThan(20);
    // 径の中央値は隣の血管の 2.4mm 側に寄り、真値 3.0mm から外れる。実測 2.274mm。
    expect(Math.abs(median(auto.diameters) - 3.0)).toBeGreaterThan(0.5);
    expect(auto.provenance.edited).toBe(false);
  });

  it("★中間点を 1 つ置くと真値 3.0mm に戻る", () => {
    const fixed = decoyInput({ waypoints: [[60, 40]] })!;
    expect(fixed).not.toBeNull();
    // 経路が目的の血管の中心に載る（実測 maxDev 1.2px）。
    for (const [, y] of fixed.centerline) expect(Math.abs(y - 40)).toBeLessThan(2);
    // 径の中央値は真値ちょうど（実測 3.000mm）。
    expect(Math.abs(median(fixed.diameters) - 3.0)).toBeLessThan(0.05);
    // 平均は始終点近くの「首」の影響でわずかに過大（実測 3.124mm）。ここは切り詰めで外す。
    const mean = fixed.diameters.reduce((a, b) => a + b, 0) / fixed.diameters.length;
    expect(Math.abs(mean - 3.0)).toBeLessThan(0.2);
    expect(fixed.provenance.waypoints).toBe(1);
    expect(fixed.provenance.edited).toBe(true);
  });

  it("中間点はユーザの指定位置を通る（平滑化で動かさない）", () => {
    const fixed = decoyInput({ waypoints: [[60, 40]] })!;
    const near = fixed.centerline.reduce(
      (best, c) => Math.min(best, Math.hypot(c[0] - 60, c[1] - 40)),
      Infinity,
    );
    expect(near).toBeLessThan(1.5);
  });

  it("traceCenterline は脚の継ぎ目を重複させない", () => {
    const p = makeVessel(120, 60, 30, () => 7.5);
    const one = traceCenterline(p.pixels, p.width, p.height, [[10, 30], [109, 30]], true, 40)!;
    const two = traceCenterline(p.pixels, p.width, p.height, [[10, 30], [60, 30], [109, 30]], true, 40)!;
    expect(one).not.toBeNull();
    expect(two).not.toBeNull();
    // 継ぎ目で同じ点が 2 回入っていたら、長さが 1 だけ増える。
    expect(two.length).toBe(one.length);
  });
});

describe("★手修正 — エッジ", () => {
  const mmPerPx = 0.2;

  function cleanRun(edits?: QcaManualEdits) {
    const p = makeVessel(120, 60, 30, () => 7.5);
    return runQca({
      ...SLAB,
      pixels: p.pixels,
      width: p.width,
      height: p.height,
      start: [10, 30],
      end: [109, 30],
      mmPerPxRow: mmPerPx,
      mmPerPxCol: mmPerPx,
      vesselIsDark: true,
      edits,
    });
  }

  it("指定した点の径だけが手の値になる（他は変わらない）", () => {
    const auto = cleanRun()!;
    const i = Math.floor(auto.centerline.length / 2);
    const pathIndex = auto.pathIndices[i];
    const edited = cleanRun({
      edges: { token: auto.centerlineToken, byPathIndex: { [pathIndex]: { left: -2, right: 2 } } },
    })!;
    // 直径 4px × 0.2mm = 0.8mm になっている。
    const j = edited.pathIndices.indexOf(pathIndex);
    expect(j).toBeGreaterThanOrEqual(0);
    expect(edited.diameters[j]).toBeCloseTo(0.8, 3);
    expect(edited.provenance.editedEdges).toContain(j);
    // 隣の点は自動のまま。
    expect(edited.diameters[j - 3]).toBeCloseTo(auto.diameters[j - 3], 6);
    // 最小径が手で入れた値になる。
    expect(edited.mld).toBeCloseTo(0.8, 3);
  });

  it("片側だけの修正もできる", () => {
    const auto = cleanRun()!;
    const pathIndex = auto.pathIndices[10];
    const edited = cleanRun({
      edges: { token: auto.centerlineToken, byPathIndex: { [pathIndex]: { right: 3 } } },
    })!;
    const j = edited.pathIndices.indexOf(pathIndex);
    expect(edited.edgeOffsets[j].right).toBe(3);
    // 左側は自動の値のまま。
    expect(edited.edgeOffsets[j].left).toBeCloseTo(auto.edgeOffsets[j].left, 6);
  });

  it("符号の約束（left<0<right）を破る指定は黙って無視する", () => {
    const auto = cleanRun()!;
    const pathIndex = auto.pathIndices[10];
    const edited = cleanRun({
      edges: { token: auto.centerlineToken, byPathIndex: { [pathIndex]: { left: 5, right: -5 } } },
    })!;
    const j = edited.pathIndices.indexOf(pathIndex);
    expect(edited.edgeOffsets[j].left).toBeCloseTo(auto.edgeOffsets[j].left, 6);
    expect(edited.provenance.editedEdges).not.toContain(j);
  });

  it("★中心線が変わったらエッジ修正を捨てる（範囲内のまま別の場所を指すのを防ぐ）", () => {
    // これが効いていないと「手で直したはずの点が違う場所に効く」という気づけない壊れ方をする。
    const p = makeVessel(120, 60, 30, () => 7.5);
    const auto = runQca({
      ...SLAB,
      pixels: p.pixels,
      width: p.width,
      height: p.height,
      start: [10, 30],
      end: [109, 30],
      mmPerPxRow: mmPerPx,
      mmPerPxCol: mmPerPx,
    })!;
    const stale = {
      token: auto.centerlineToken,
      byPathIndex: { [auto.pathIndices[10]]: { left: -2, right: 2 } },
    };
    // 中間点を足す＝中心線が変わる。
    const moved = runQca({
      ...SLAB,
      pixels: p.pixels,
      width: p.width,
      height: p.height,
      start: [10, 30],
      end: [109, 30],
      mmPerPxRow: mmPerPx,
      mmPerPxCol: mmPerPx,
      edits: { waypoints: [[60, 34]], edges: stale },
    })!;
    expect(moved.warnings).toContain("edgeEditsDropped");
    expect(moved.provenance.editedEdges).toEqual([]);
  });

  it("centerlineToken は座標が変われば変わる", () => {
    expect(centerlineToken([[0, 0], [1, 1]])).toBe(centerlineToken([[0, 0], [1, 1]]));
    expect(centerlineToken([[0, 0], [1, 1]])).not.toBe(centerlineToken([[0, 0], [1, 2]]));
    expect(centerlineToken([[0, 0], [1, 1]])).not.toBe(centerlineToken([[0, 0], [1, 1], [2, 2]]));
  });
});

describe("★手修正 — 区間の切り詰めと参照径", () => {
  const mmPerPx = 0.2;

  /** 4.0mm → 2.5mm に段差で細くなり、遠位側に 50% 狭窄がある血管（分岐の下流を模した形）。 */
  function steppedPhantom(): Phantom {
    const refProx = 4.0 / 2 / mmPerPx; // 10px
    const refDist = 2.5 / 2 / mmPerPx; // 6.25px
    return makeVessel(120, 60, 30, (x) => {
      // 段差（x=55..65 で線形に細くなる）
      const base =
        x <= 55 ? refProx : x >= 65 ? refDist : refProx + ((refDist - refProx) * (x - 55)) / 10;
      // 遠位の狭窄（中心 x=88、半幅 12px、遠位参照径の 50%）
      const d = Math.abs(x - 88);
      if (d >= 12) return base;
      const f = 0.5 * (1 + Math.cos((Math.PI * d) / 12));
      return base - (base - refDist * 0.5) * f;
    });
  }

  function run(edits?: QcaManualEdits) {
    const p = steppedPhantom();
    return runQca({
      ...SLAB,
      pixels: p.pixels,
      width: p.width,
      height: p.height,
      start: [10, 30],
      end: [109, 30],
      mmPerPxRow: mmPerPx,
      mmPerPxCol: mmPerPx,
      vesselIsDark: true,
      edits,
    })!;
  }

  // 段差のある血管は**1 本の直線では表せない**（近位 4.0mm / 遠位 2.5mm）。自動の参照径が
  // どちらへ外すかは当てはめ方で変わる（上包絡だった頃は過大、外れ値を落とす回帰では過小）。
  // **どちらに外れるかではなく「外れること」がこの機能（健常区間の手指定）の前提**。
  it("前提: 段差があると自動の参照径が真値から外れ、%DS を誤る", () => {
    const auto = run();
    // 真値: RVD 2.5mm / MLD 1.25mm / %DS 50%
    expect(auto.mld).toBeCloseTo(1.25, 1);
    expect(Math.abs(auto.rvd - 2.5)).toBeGreaterThan(0.1);
    expect(Math.abs(auto.percentDiameterStenosis - 50)).toBeGreaterThan(3);
  });

  it("★健常区間を指定すると真値（RVD 2.5 / %DS 50%）に戻る", () => {
    const auto = run();
    // 遠位の健常部（狭窄の手前と奥）を計測点インデックスで指定する。
    const n = auto.centerline.length;
    const idxOf = (x: number) => {
      let best = 0;
      let bd = Infinity;
      for (let i = 0; i < n; i++) {
        const d = Math.abs(auto.centerline[i][0] - x);
        if (d < bd) {
          bd = d;
          best = i;
        }
      }
      return best;
    };
    const fixed = run({ reference: { kind: "segments", ranges: [[idxOf(68), idxOf(74)], [idxOf(102), idxOf(108)]] } });
    expect(fixed.rvd).toBeGreaterThan(2.35);
    expect(fixed.rvd).toBeLessThan(2.65);
    expect(Math.abs(fixed.percentDiameterStenosis - 50)).toBeLessThan(3);
    expect(fixed.provenance.reference).toBe("segments");
    expect(fixed.provenance.edited).toBe(true);
  });

  it("★健常区間が 1 つだけなら定数にする（短い窓の傾きを外挿しない）", () => {
    // 実機で「左端だけを健常と指定したら、参照径が右へ向かって上り坂になった」形で出た。
    // 短い窓で当てた傾きを区間の外へ延長すると、遠位で現実離れした参照径になる。
    const auto = run();
    const fixed = run({ reference: { kind: "segments", ranges: [[2, 12]] } });
    const first = fixed.reference[0];
    for (const r of fixed.reference) expect(r).toBeCloseTo(first, 9);
    // 指定した区間の実測径の平均になっている。
    const mean = auto.diameters.slice(2, 13).reduce((a, b) => a + b, 0) / 11;
    expect(first).toBeCloseTo(mean, 6);
  });

  it("健常区間が 2 つならテーパーを線形で結ぶ", () => {
    const auto = run();
    const n = auto.centerline.length;
    const fixed = run({ reference: { kind: "segments", ranges: [[2, 10], [n - 11, n - 3]] } });
    // 近位（太い 4.0mm 側）と遠位（細い 2.5mm 側）を結ぶので、右下がりになる。
    expect(fixed.reference[0]).toBeGreaterThan(fixed.reference[n - 1] + 0.5);
  });

  it("参照径を直接与えられる", () => {
    const fixed = run({ reference: { kind: "fixed", diameter: 2.5 } });
    expect(fixed.rvd).toBeCloseTo(2.5, 6);
    expect(Math.abs(fixed.percentDiameterStenosis - 50)).toBeLessThan(3);
    expect(fixed.provenance.reference).toBe("fixed");
  });

  it("★区間を切り詰めると段差を外して自動の参照径でも真値に近づく", () => {
    const auto = run();
    const n = auto.centerline.length;
    const idxOf = (x: number) => {
      let best = 0;
      let bd = Infinity;
      for (let i = 0; i < n; i++) {
        const d = Math.abs(auto.centerline[i][0] - x);
        if (d < bd) {
          bd = d;
          best = i;
        }
      }
      return best;
    };
    const trimmed = run({ trim: { from: idxOf(68), to: idxOf(108) } });
    expect(trimmed.provenance.trimmed).toBe(true);
    expect(Math.abs(trimmed.percentDiameterStenosis - 50)).toBeLessThan(3);
    // 切り詰めた区間の距離は 0 から数え直す。
    expect(trimmed.positions[0]).toBe(0);
    expect(trimmed.centerline[0][0]).toBeGreaterThan(60);
  });

  it("短すぎる切り詰めは無視して警告する（結果を消さない）", () => {
    const r = run({ trim: { from: 5, to: 6 } });
    expect(r.warnings).toContain("trimTooShort");
    expect(r.provenance.trimmed).toBe(false);
    expect(r.diameters.length).toBeGreaterThan(10);
  });

  it("手を入れていなければ provenance.edited は false", () => {
    expect(run().provenance.edited).toBe(false);
    expect(run({ reference: { kind: "auto" } }).provenance.edited).toBe(false);
  });
});

/* ── ★密度計測（A4c・§16.5）──────────────────────────────────────────
 *
 * 🚨 上のファントムは箱型なのでここでは使えない（`SLAB` のコメント）。
 * ここだけは**ビール則で作った透過画像**を使う——`I = I₀·exp(−μ·L(d))`。
 * L(d) は視線が内腔を横切る長さで、断面の形から決まる。
 *
 * 🔑 検査の要は「**断面積を一定に保ったまま、シルエットだけを 4 倍動かす**」こと。
 * 面積が同じなら密度計測は同じ径を返し、半値法はシルエットに追随して**大きく振れる**はず。
 * これが GNBP-XA-7 で見つかった性質そのもので、箱型では原理的に作れない。
 */

const MU = 0.05;
const I0 = 1000;

/** 断面（軸からの距離 d における弦の長さ）。 */
type Chord = (d: number) => number;

const circleChord = (r: number): Chord => (d) => 2 * Math.sqrt(Math.max(0, r * r - d * d));
/** 半軸 a（画面内＝シルエット方向）・b（視線方向）の楕円。面積 = πab。 */
const ellipseChord = (a: number, b: number): Chord => (d) =>
  Math.abs(d) >= a ? 0 : 2 * b * Math.sqrt(Math.max(0, 1 - (d / a) ** 2));

/**
 * 水平に走る血管の**透過画像**。区間 [x1,x2) だけ断面を差し替える。
 * `domain="attenuation"` なら DSA の出力（＝すでに減弱）を模す。
 */
function makeBeerLambert(opts: {
  width: number;
  height: number;
  cy: number;
  healthy: Chord;
  middle?: { from: number; to: number; chord: Chord };
  domain?: "intensity" | "attenuation";
  blurSigma?: number;
  noiseSigma?: number;
}): Phantom {
  const { width, height, cy, healthy, middle, domain = "intensity", blurSigma = 0.6 } = opts;
  const raw = new Float32Array(width * height);
  // 🔑 画素は**面積平均**で作る（点サンプルにしない）。実際の検出器は画素の中で積分するし、
  //    点サンプルだと指数関数の凸性のぶんだけ減弱が系統的にずれる（実測で径が 4% ずれた）。
  //    `bench/make_phantom_xa.py` も同じ理由で超サンプリングしている。
  const SUB = 8;
  for (let x = 0; x < width; x++) {
    const chord = middle && x >= middle.from && x < middle.to ? middle.chord : healthy;
    for (let y = 0; y < height; y++) {
      let acc = 0;
      for (let s = 0; s < SUB; s++) {
        const d = y - cy + (s + 0.5) / SUB - 0.5;
        const a = MU * chord(d);
        acc += domain === "intensity" ? I0 * Math.exp(-a) : a;
      }
      raw[y * width + x] = acc / SUB;
    }
  }
  // 🔑 ぼけは**強度に**掛かる（減弱に掛けるのは別物）。列方向だけで足りる。
  const pixels = new Float32Array(width * height);
  const r = Math.max(1, Math.ceil(3 * blurSigma));
  const k: number[] = [];
  let ksum = 0;
  for (let i = -r; i <= r; i++) {
    const w = blurSigma > 0 ? Math.exp(-0.5 * (i / blurSigma) ** 2) : i === 0 ? 1 : 0;
    k.push(w);
    ksum += w;
  }
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      let acc = 0;
      for (let i = -r; i <= r; i++) {
        const yy = Math.min(height - 1, Math.max(0, y + i));
        acc += raw[yy * width + x] * k[i + r];
      }
      pixels[y * width + x] = acc / ksum;
    }
  }
  if (opts.noiseSigma) {
    // 決定的な擬似乱数（テストを揺らさない）。
    let seed = 12345;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let i = 0; i < pixels.length; i++) {
      const u = Math.max(1e-9, rnd());
      const g = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
      pixels[i] += g * opts.noiseSigma;
    }
  }
  return { pixels, width, height };
}

describe("★密度計測 — 断面の形に依らず面積を測る（§16.5）", () => {
  const W = 200;
  const H = 60;
  const CY = 30;
  const R = 5; // 健常部は半径 5（＝直径 10・面積 78.54）

  /** 中央だけ断面を差し替えた血管を解析する。 */
  const analyze = (middleChord: Chord | null, over?: Partial<Parameters<typeof runQca>[0]>) => {
    const ph = makeBeerLambert({
      width: W,
      height: H,
      cy: CY,
      healthy: circleChord(R),
      middle: middleChord ? { from: 80, to: 120, chord: middleChord } : undefined,
      ...(over?.profileDomain === "attenuation" ? { domain: "attenuation" as const } : {}),
      ...(over && "noiseSigma" in over ? {} : {}),
    });
    return runQca({
      pixels: ph.pixels,
      width: W,
      height: H,
      start: [10, CY],
      end: [W - 11, CY],
      mmPerPxRow: 1,
      mmPerPxCol: 1,
      ...over,
    })!;
  };

  it("健常部（円）の径を真値どおりに返す", () => {
    const r = analyze(null);
    expect(r.provenance.diameterMethod).toBe("densitometric");
    expect(r.provenance.muPerMm).toBeGreaterThan(0);
    // 面積等価直径 = 2R = 10
    expect(Math.abs(median(r.diameters) - 2 * R)).toBeLessThan(0.3);
  });

  it("★断面積が同じならシルエットが 2 倍でも同じ径を返す（半値法は追随して外す）", () => {
    // 半軸 a=10（シルエット 20px）・b=2.5 → 面積 π·10·2.5 = 78.54 ＝ 健常部と同じ
    const mid = ellipseChord(10, 2.5);
    const dens = analyze(mid);
    const half = analyze(mid, { densitometry: false });
    const at = (r: typeof dens) => r.diameters[Math.round(r.diameters.length / 2)];
    // 密度計測は面積等価直径（＝10）を返す
    expect(Math.abs(at(dens) - 2 * R)).toBeLessThan(0.8);
    // 半値法はシルエット（20px の 0.87 倍前後）を返す＝真の面積の 1.7 倍以上に見える
    expect(at(half)).toBeGreaterThan(15);
  });

  it("★断面積が同じならシルエットが半分でも同じ径を返す（半値法は狭窄に見せる）", () => {
    // 半軸 a=2.5（シルエット 5px）・b=10 → 面積は同じ 78.54
    const mid = ellipseChord(2.5, 10);
    const dens = analyze(mid);
    const half = analyze(mid, { densitometry: false });
    const at = (r: typeof dens) => r.diameters[Math.round(r.diameters.length / 2)];
    expect(Math.abs(at(dens) - 2 * R)).toBeLessThan(0.8);
    expect(at(half)).toBeLessThan(6);
    // 🔴 半値法だと「50% 以上の狭窄」に見えるが、断面積は一定＝狭窄していない。
    expect(half.percentDiameterStenosis).toBeGreaterThan(40);
    expect(dens.percentDiameterStenosis).toBeLessThan(15);
  });

  it("★本当に細い内腔は密度計測でも細いと出る（形の違いと狭窄を取り違えない）", () => {
    // 半径 2（面積 12.57 ＝ 健常の 16%）。%AS ≒ 84%、%DS ≒ 60%。
    const r = analyze(circleChord(2));
    expect(r.percentDiameterStenosis).toBeGreaterThan(50);
    expect(r.percentDiameterStenosis).toBeLessThan(70);
  });

  it("🚨 DSA（すでに減弱）で二重に対数を取らない", () => {
    const ph = makeBeerLambert({
      width: W, height: H, cy: CY, healthy: circleChord(R), domain: "attenuation",
    });
    const r = runQca({
      pixels: ph.pixels, width: W, height: H, start: [10, CY], end: [W - 11, CY],
      mmPerPxRow: 1, mmPerPxCol: 1,
      // DSA 後は血管が明るい。ドメインは既定でも attenuation になる。
      vesselIsDark: false,
    })!;
    expect(r.provenance.diameterMethod).toBe("densitometric");
    expect(Math.abs(median(r.diameters) - 2 * R)).toBeLessThan(0.5);
  });

  it("🚨 ノイズが大きいと半値法へ落として、落ちたことを出自に残す", () => {
    const ph = makeBeerLambert({
      width: W, height: H, cy: CY, healthy: circleChord(R), noiseSigma: 90,
    });
    const r = runQca({
      pixels: ph.pixels, width: W, height: H, start: [10, CY], end: [W - 11, CY],
      mmPerPxRow: 1, mmPerPxCol: 1,
    })!;
    expect(r.provenance.diameterMethod).toBe("half-max");
    expect(r.provenance.densitometryFallback).toBe("noisy");
    expect(r.provenance.muPerMm).toBeNull();
    expect(r.warnings).toContain("densitometryFallback:noisy");
  });

  it("🔴 健常部が円形でないと形の独立性は失われる（μ を自分自身から取るため）", () => {
    // 🚨 **「形を仮定しない」は病変部についてだけ**。基準の μ は健常部に円柱を当てはめて
    //    得るので、**血管全体が非円形**だとその仮定が全体に及ぶ。
    //    実測（GNBP-XA-7 のプロファイルで確認）: μ を円形から取れば比 0.997〜1.001、
    //    自分自身（楕円・三日月・D 型）から取ると 1.410 / 0.712 / 0.694 / 1.171 まで外れる。
    //    UI とレポートの注意書きはこの線引きで書いてある。ここを緩めないこと。
    const ph = makeBeerLambert({
      width: W, height: H, cy: CY,
      // 区間の全体が「横に広い楕円」＝健常部も円形でない
      healthy: ellipseChord(10, 2.5),
    });
    const r = runQca({
      pixels: ph.pixels, width: W, height: H, start: [10, CY], end: [W - 11, CY],
      mmPerPxRow: 1, mmPerPxCol: 1,
    })!;
    expect(r.provenance.diameterMethod).toBe("densitometric");
    // 面積等価直径は 10 だが、μ が楕円から出るので大きく外れる（＝この仮定の証拠）。
    expect(Math.abs(median(r.diameters) - 2 * R)).toBeGreaterThan(1.5);
  });

  it("densitometry:false なら常に半値法（出自にも残る）", () => {
    const r = analyze(null, { densitometry: false });
    expect(r.provenance.diameterMethod).toBe("half-max");
    expect(r.provenance.densitometryFallback).toBe("disabled");
    // 🚨 明示的に切った場合は警告にしない（利用者が選んだのだから異常ではない）。
    expect(r.warnings.some((w) => w.startsWith("densitometryFallback"))).toBe(false);
  });
});

/** テスト内で使う中央値。 */
function median(v: readonly number[]): number {
  const s = [...v].sort((a, b) => a - b);
  return s.length % 2 ? s[s.length >> 1] : (s[(s.length >> 1) - 1] + s[s.length >> 1]) / 2;
}


/**
 * 「どこを測って参照径としたか」を返せること（2026-08-31・利用者の要望で追加）。
 * 画面はこの支持点を帯として描くので、**中身が正しくないと嘘の帯が出る**。
 */
describe("参照径の支持点（どの計測点を健常として使ったか）", () => {
  it("自動当てはめでは病変の点が支持から外れる", () => {
    const n = 40;
    const pos = Array.from({ length: n }, (_, i) => i * 0.5);
    // 中央の 6 点だけ深い狭窄。ほかは 3.0mm 一定。
    const dia = Array.from({ length: n }, (_, i) => (i >= 17 && i <= 22 ? 1.5 : 3.0));
    const fit = referenceDiametersFit(pos, dia);
    expect(fit.kind).toBe("auto");
    // 病変の点は 1 つも使われていない。
    for (let i = 17; i <= 22; i++) expect(fit.support).not.toContain(i);
    // 健常部はほぼ全部使われている。
    expect(fit.support.length).toBeGreaterThan(n - 10);
    // 参照径そのものは健常部の値のまま。
    expect(fit.reference[19]).toBeCloseTo(3.0, 3);
  });

  it("人が指定した区間は、その点だけが支持になる", () => {
    const pos = Array.from({ length: 20 }, (_, i) => i);
    const dia = Array.from({ length: 20 }, () => 3.0);
    const fit = referenceDiametersFit(pos, dia, [[2, 5], [14, 17]]);
    expect(fit.kind).toBe("user");
    expect(fit.support).toEqual([2, 3, 4, 5, 14, 15, 16, 17]);
  });

  it("QVA（両端）では中央は 1 点も使わない", () => {
    const n = 20;
    const pos = Array.from({ length: n }, (_, i) => i);
    const dia = Array.from({ length: n }, () => 3.0);
    const fit = referenceFromEndsFit(pos, dia, 0.25);
    expect(fit.kind).toBe("ends");
    // 前後 5 点ずつ（25%）。真ん中は瘤が占めていても参照径を動かさない、の根拠。
    expect(fit.support).toEqual([0, 1, 2, 3, 4, 15, 16, 17, 18, 19]);
  });

  it("連続区間へまとめられる（画面の帯はこれで描く）", () => {
    expect(toRanges([0, 1, 2, 5, 6, 9])).toEqual([[0, 2], [5, 6], [9, 9]]);
    expect(toRanges([])).toEqual([]);
  });
});
