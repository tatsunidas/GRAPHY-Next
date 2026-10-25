import { describe, expect, it } from "vitest";
import { proposeBranches, CONTRAST_FRACTION } from "./xaBranchProposal";

const W = 260;
const H = 260;
const MM = 0.3;

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
/** 各線分に径（mm）を持たせて描く。暗い血管、縁は σ=1 px のぼけ。 */
function render(segs: { s: Seg; diam: number }[], noiseSd: number, seed = 1): Float32Array {
  const img = new Float32Array(W * H);
  const n = rng(seed);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let cover = 0;
      for (const { s, diam } of segs) cover = Math.max(cover, 0.5 * (1 + erf((diam / MM / 2 - segDist(x, y, s)) / Math.SQRT2)));
      img[y * W + x] = 1000 - 400 * cover + (noiseSd ? noiseSd * n() : 0);
    }
  }
  return img;
}

const MAIN: Seg = [[20, 130], [240, 130]];
const SIDE: Seg = [[100, 130], [190, 50]]; // 主枝から 42° で上へ
const TREE = [{ s: MAIN, diam: 3 }, { s: SIDE, diam: 2 }];
const mainPath = (m: Seg): [number, number][] => {
  const L = Math.hypot(m[1][0] - m[0][0], m[1][1] - m[0][1]);
  return Array.from({ length: Math.floor(L) + 1 }, (_, i) => [m[0][0] + ((m[1][0] - m[0][0]) * i) / L, m[0][1] + ((m[1][1] - m[0][1]) * i) / L] as [number, number]);
};
const run = (img: Float32Array, o: Partial<Parameters<typeof proposeBranches>[3]> = {}) =>
  proposeBranches(img, W, H, { vesselIsDark: true, mmPerPx: MM, mainPath: mainPath(MAIN), ...o });

/** 提案点のうち側枝の真値から 2 px 以内の割合と、真値のうち提案から 2 px 以内の割合。 */
function score(props: { pointsPx: [number, number][] }[], truth: Seg, tol = 2) {
  const pts = props.flatMap((p) => p.pointsPx);
  const prec = pts.length ? pts.filter(([x, y]) => segDist(x, y, truth) <= tol).length / pts.length : 0;
  const L = Math.hypot(truth[1][0] - truth[0][0], truth[1][1] - truth[0][1]);
  let hit = 0, tot = 0;
  for (let t = 0; t <= L; t++) {
    const x = truth[0][0] + ((truth[1][0] - truth[0][0]) * t) / L, y = truth[0][1] + ((truth[1][1] - truth[0][1]) * t) / L;
    tot++;
    if (pts.some(([px, py]) => Math.hypot(px - x, py - y) <= tol)) hit++;
  }
  return { prec, rec: hit / tot };
}

describe("proposeBranches", () => {
  it("正例: 主枝から出る側枝を 1 本提案し、真値に 2 px 以内で重なる", () => {
    const r = run(render(TREE, 4));
    expect(r.status).toBe("ok");
    expect(r.proposals).toHaveLength(1);
    const s = score(r.proposals, SIDE);
    expect(s.prec).toBeGreaterThan(0.9);
    expect(s.rec).toBeGreaterThan(0.85); // 分岐点の重なり区間と端の縮みを含む
  });

  it("負例: 側枝の無い画像（主枝だけ）では提案が 0", () => {
    for (const noiseSd of [0, 4, 16]) {
      expect(run(render([{ s: MAIN, diam: 3 }], noiseSd)).proposals).toHaveLength(0);
    }
  });

  it("負例: 画素間隔が無いときは提案しない", () => {
    const r = run(render(TREE, 4), { mmPerPx: null });
    expect(r.status).toBe("noScale");
    expect(r.proposals).toHaveLength(0);
  });

  it("負例: 血管の明暗を逆に指定すると、側枝を提案できない（正例と同じ入力で落ちる）", () => {
    const r = run(render(TREE, 4), { vesselIsDark: false });
    expect(score(r.proposals, SIDE).rec).toBeLessThan(0.5);
  });

  it("明暗を反転した画像（DSA 相当）は vesselIsDark=false で同じ提案になる", () => {
    const img = render(TREE, 4);
    const a = run(img);
    const b = run(img.map((v) => 2000 - v), { vesselIsDark: false });
    expect(b.proposals).toHaveLength(a.proposals.length);
    expect(score(b.proposals, SIDE).rec).toBeGreaterThan(0.85);
  });

  it("雑音が小さいほど悪化しない: σ=0〜16（コントラスト 400）で提案 1 本・適合率 0.9 超（P2.5a の破綻の再発確認）", () => {
    for (const noiseSd of [0, 2, 4, 8, 16]) {
      const r = run(render(TREE, noiseSd, 3));
      expect(r.proposals).toHaveLength(1);
      expect(score(r.proposals, SIDE).prec).toBeGreaterThan(0.9);
    }
  });

  it("コントラスト割合を原理的な範囲（0.15〜0.4）で動かしても提案数が変わらない", () => {
    const img = render(TREE, 4);
    for (const f of [0.15, CONTRAST_FRACTION, 0.4]) expect(run(img, { contrastFraction: f }).proposals).toHaveLength(1);
  });

  it("コントラストが主枝の割合未満の淡い線は提案しない（主枝の 15% の線は出ない）", () => {
    const img = render(TREE, 4);
    // 側枝だけコントラストを 15% に落とす（背景 1000 へ寄せる）
    const faint = img.map((v, i) => {
      const x = i % W, y = Math.floor(i / W);
      return segDist(x, y, SIDE) < 6 && Math.abs(y - 130) > 8 ? 1000 + (v - 1000) * 0.15 : v;
    });
    expect(run(faint).proposals).toHaveLength(0);
  });
});
