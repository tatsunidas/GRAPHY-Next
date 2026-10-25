import { describe, expect, it } from "vitest";
import { extractVesselTree2D, type XaVesselTree2D } from "./xaVesselTree";

const W = 220;
const H = 220;
const MM = 0.3; // mm/px

/** 決定的な乱数（mulberry32）と正規乱数。 */
function rng(seed: number) {
  let a = seed >>> 0;
  const u = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return () => Math.sqrt(-2 * Math.log(u() + 1e-12)) * Math.cos(2 * Math.PI * u());
}

/** 誤差関数（Abramowitz-Stegun 7.1.26。最大誤差 1.5e-7）。 */
function erf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}

type Seg = [[number, number], [number, number]];

const segDist = (px: number, py: number, [[ax, ay], [bx, by]]: Seg): number => {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
};

/** 暗い血管（径 diamMm の円筒を滑らかな縁で）を明るい背景に描く。 */
function render(segs: Seg[], diamMm: number, noiseSd: number, seed = 1): Float32Array {
  const img = new Float32Array(W * H);
  const r = diamMm / MM / 2;
  const n = rng(seed);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const d = Math.min(...segs.map((s) => segDist(x, y, s)));
      // 縁は撮像系のぼけ（ガウス PSF、σ = 1 px）で滑らかにする。折れ線の縁は、実画像に無い角の応答を生む。
      const cover = 0.5 * (1 + erf((r - d) / Math.SQRT2));
      img[y * W + x] = 1000 - 400 * cover + (noiseSd ? noiseSd * n() : 0);
    }
  }
  return img;
}

const run = (img: Float32Array, o: Partial<Parameters<typeof extractVesselTree2D>[3]> = {}): XaVesselTree2D =>
  extractVesselTree2D(img, W, H, { vesselIsDark: true, mmPerPx: MM, ...o });

/** 真値の線分から tol px 以内にある抽出点の割合（適合率）と、真値のサンプル点が抽出点から tol 以内にある割合（再現率）。 */
function score(tree: XaVesselTree2D, segs: Seg[], tol = 2) {
  const pts = tree.branches.flatMap((b) => b.pointsPx);
  const prec = pts.length ? pts.filter(([x, y]) => Math.min(...segs.map((s) => segDist(x, y, s))) <= tol).length / pts.length : 0;
  const truth: [number, number][] = [];
  for (const [[ax, ay], [bx, by]] of segs) {
    const L = Math.hypot(bx - ax, by - ay);
    for (let t = 0; t <= L; t += 1) truth.push([ax + ((bx - ax) * t) / L, ay + ((by - ay) * t) / L]);
  }
  const rec = truth.filter(([x, y]) => pts.some(([px, py]) => Math.hypot(px - x, py - y) <= tol)).length / truth.length;
  return { prec, rec };
}

const LINE: Seg[] = [[[30, 110], [190, 110]]];
const Y_SEGS: Seg[] = [[[30, 110], [110, 110]], [[110, 110], [190, 50]], [[110, 110], [190, 170]]];
const X_SEGS: Seg[] = [[[40, 40], [180, 180]], [[40, 180], [180, 40]]];

describe("extractVesselTree2D", () => {
  it("正例: 直線 1 本 → 枝 1 本、真値に 2 px 以内、長さが 5% 以内", () => {
    const t = run(render(LINE, 2.5, 4));
    expect(t.status).toBe("ok");
    expect(t.branches).toHaveLength(1);
    const s = score(t, LINE);
    expect(s.prec).toBeGreaterThan(0.95);
    expect(s.rec).toBeGreaterThan(0.9);
    expect(Math.abs(t.branches[0].lengthMm - 160 * MM) / (160 * MM)).toBeLessThan(0.05);
  });

  it("正例: Y 分岐 → 枝 3 本・分岐点 1（次数 3）・端点 3", () => {
    const t = run(render(Y_SEGS, 2.5, 4));
    expect(t.branches).toHaveLength(3);
    expect(t.nodes.filter((n) => n.degree === 3)).toHaveLength(1);
    expect(t.nodes.filter((n) => n.degree === 1)).toHaveLength(3);
    const s = score(t, Y_SEGS);
    expect(s.prec).toBeGreaterThan(0.9);
    expect(s.rec).toBeGreaterThan(0.9);
  });

  it("正例: X 交差 → 枝 4 本・交差点 1（次数 4）", () => {
    const t = run(render(X_SEGS, 2.5, 4));
    expect(t.branches).toHaveLength(4);
    expect(t.nodes.filter((n) => n.degree >= 4)).toHaveLength(1);
  });

  it("負例: 血管の無い雑音だけの画像では枝が 0", () => {
    for (const seed of [1, 2, 3]) {
      const t = run(render([], 2.5, 4, seed));
      expect(t.branches).toHaveLength(0);
    }
  });

  it("雑音が量子化雑音以下の画像（雑音ゼロの合成画像を整数に丸めたもの）には警告が付き、通常の雑音画像には付かない", () => {
    const rounded = render(Y_SEGS, 2.5, 0).map(Math.round);
    expect(run(rounded).warnings).toContain("noiseAtQuantizationFloor");
    expect(run(render(Y_SEGS, 2.5, 4).map(Math.round)).warnings).not.toContain("noiseAtQuantizationFloor");
  });

  it("負例: 画素間隔が無いときは抽出しない（既定値で当てにいかない）", () => {
    const t = run(render(Y_SEGS, 2.5, 4), { mmPerPx: null });
    expect(t.status).toBe("noScale");
    expect(t.branches).toHaveLength(0);
    expect(t.warnings).toContain("noPixelSpacing");
  });

  it("負例: 血管の明暗を逆に指定すると、中心線が真値に合わない（縁の線を拾う）", () => {
    const img = render(Y_SEGS, 2.5, 4);
    const right = score(run(img), Y_SEGS);
    const wrong = score(run(img, { vesselIsDark: false }), Y_SEGS);
    expect(right.prec).toBeGreaterThan(0.9);
    expect(wrong.prec).toBeLessThan(0.5);
  });

  it("明暗を反転した画像（DSA 相当）は vesselIsDark=false で同じ木になる", () => {
    const img = render(Y_SEGS, 2.5, 4);
    const inv = img.map((v) => 2000 - v);
    const a = run(img);
    const b = run(inv, { vesselIsDark: false });
    expect(b.branches).toHaveLength(a.branches.length);
  });

  it("しきい値倍率を原理的な範囲で動かしても、枝数・節点数が変わらない", () => {
    const img = render(Y_SEGS, 2.5, 4);
    const base = run(img);
    for (const low of [2.5, 3, 4]) {
      for (const high of [5, 6, 8]) {
        const t = run(img, { sigma: { low, high } });
        expect(t.branches).toHaveLength(base.branches.length);
        expect(t.nodes.length).toBe(base.nodes.length);
      }
    }
  });

  it("雑音（コントラスト 400 に対し σ=2〜16）と径 1.8〜3.5 mm で、枝数 3 が保たれる", () => {
    for (const noiseSd of [2, 4, 8, 16]) {
      for (const diam of [1.8, 2.5, 3.5]) {
        const t = run(render(Y_SEGS, diam, noiseSd, 7));
        expect(t.branches).toHaveLength(3);
      }
    }
  });

  it("径が範囲の両端（1.2 / 5.0 mm）でも血管は見つかる（再現率）。余分な短い枝が出ることがあり、枝数の一致は主張しない", () => {
    for (const noiseSd of [2, 4, 8, 16]) {
      for (const diam of [1.2, 5.0]) {
        const t = run(render(Y_SEGS, diam, noiseSd, 7));
        // 細線化で端が径の半分ほど縮む（5 mm では約 8 px ずつ）ので、再現率は 0.9 に届かない。
        expect(score(t, Y_SEGS).rec).toBeGreaterThan(0.8);
      }
    }
  });
});
