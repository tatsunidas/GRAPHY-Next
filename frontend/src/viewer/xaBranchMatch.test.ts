import { describe, expect, it } from "vitest";
import { matchBranches, type MatchBranch } from "./xaBranchMatch";
import { projectToPixel, type Vec3, type XaViewGeometry } from "./xaGeometry";

const geom = (primary: number, secondary: number, sid: number, sod: number, sp: number): XaViewGeometry => ({
  primaryAngleDeg: primary, secondaryAngleDeg: secondary, sidMm: sid, sodMm: sod, imagerSpacingMm: [sp, sp], principalPoint: [256, 256],
});
// 原型の検証で使った幾何（case2: 感度軸が決まりやすい）。
const GA = geom(0, 25, 1001, 730.66, 0.214);
const GB = geom(-30, 20, 1011, 732.61, 0.212);

/** 患者 LPS の 3 本の曲線（互いに交わらない。mm）。 */
function tree3d(): Vec3[][] {
  const t = (n: number, f: (u: number) => Vec3): Vec3[] => Array.from({ length: n }, (_, i) => f(-30 + (60 * i) / (n - 1)));
  return [
    t(220, (u) => [u, 12 * Math.sin(u / 12), 10 * Math.cos(u / 15)]),
    t(160, (u) => [8 + 0.6 * u, -0.8 * u, 15 * Math.sin(u / 20)]),
    t(120, (u) => [-10 + 0.3 * u, 20 + 0.5 * u, -8 + 0.4 * u]),
  ];
}

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

/** 3D の枝を投影し、雑音（σ=0.5 px）と位置ずれ δ を載せる。画像の外は捨てる。 */
function project(branches: Vec3[][], g: XaViewGeometry, shift: [number, number], seed: number, idPrefix: string): MatchBranch[] {
  const n = rng(seed);
  return branches.map((b, i) => ({
    id: `${idPrefix}${i}`,
    pointsPx: b
      .map((p) => projectToPixel(p, g))
      .filter((q): q is [number, number] => !!q && q[0] >= 0 && q[0] < 512 && q[1] >= 0 && q[1] < 512)
      .map((q) => [q[0] + shift[0] + 0.5 * n(), q[1] + shift[1] + 0.5 * n()] as [number, number]),
  }));
}

const TREE = tree3d();

describe("matchBranches", () => {
  it("正例: 感度軸方向の位置ずれを 2 px 以内で回収し、枝が真の相手と対応する", () => {
    const A = project(TREE, GA, [0, 0], 1, "a");
    const probe = matchBranches(GA, GB, A, project(TREE, GB, [0, 0], 2, "b"));
    const ax = probe.sensitiveAxis;
    for (const mag of [8, -12]) {
      const delta: [number, number] = [ax[0] * mag, ax[1] * mag];
      const r = matchBranches(GA, GB, A, project(TREE, GB, delta, 3, "b"));
      expect(r.status).toBe("ok");
      expect(Math.abs(r.sensitiveShiftPx - mag)).toBeLessThanOrEqual(2);
      expect(r.pairings).toHaveLength(3);
      for (const p of r.pairings) expect(p.bId).toBe(p.aId.replace("a", "b"));
      expect(r.correctionPx).not.toBeNull();
      // 補正後の残差が補正前より小さい。
      expect(r.residualAfterPx!).toBeLessThan(r.residualBeforePx!);
      expect(r.residualAfterPx!).toBeLessThanOrEqual(1.5);
    }
  });

  it("負例: 位置ずれ 0 のとき、補正量は雑音程度（偽の補正をしない）", () => {
    const r = matchBranches(GA, GB, project(TREE, GA, [0, 0], 1, "a"), project(TREE, GB, [0, 0], 2, "b"));
    expect(Math.abs(r.sensitiveShiftPx)).toBeLessThanOrEqual(2);
  });

  it("感度軸に直交する（エピポーラ線に平行な）位置ずれは補正されない", () => {
    const A = project(TREE, GA, [0, 0], 1, "a");
    const ax = matchBranches(GA, GB, A, project(TREE, GB, [0, 0], 2, "b")).sensitiveAxis;
    const par: [number, number] = [-ax[1] * 12, ax[0] * 12];
    const r = matchBranches(GA, GB, A, project(TREE, GB, par, 3, "b"));
    expect(Math.abs(r.sensitiveShiftPx)).toBeLessThanOrEqual(2);
  });

  it("負例: 誤った幾何は正しい幾何と違って結果が汚れる（補正量が上限を超える、または対応が重複する）", () => {
    const A = project(TREE, GA, [0, 0], 1, "a");
    // 正しい幾何: 警告なし。
    expect(matchBranches(GA, GB, A, project(TREE, GB, [0, 0], 2, "b")).warnings).toEqual([]);
    // B の secondary の符号を反転: 補正量が上限を超えて適用されない。
    const wrongSecondary = geom(-30, -20, 1011, 732.61, 0.212);
    const r1 = matchBranches(GA, GB, A, project(TREE, wrongSecondary, [0, 0], 2, "b"));
    expect(r1.warnings).toContain("correctionOverCap");
    expect(r1.correctionPx).toBeNull();
    // B の primary の符号を反転: この木では補正量は小さいが、2 本の A 枝が同じ B 枝を指す（得点も下がる）。
    // ⚠️ 上限だけでは誤った幾何を検出できない場合がある（原型の測定でも 90% 検出で、100% ではない）。
    const wrongPrimary = geom(30, 20, 1011, 732.61, 0.212);
    const r2 = matchBranches(GA, GB, A, project(TREE, wrongPrimary, [0, 0], 2, "b"));
    expect(r2.warnings).toContain("manyToOne");
  });

  it("上限は設定で変えられる（既定の暫定値 15 px を直書きしていない）", () => {
    const A = project(TREE, GA, [0, 0], 1, "a");
    const ax = matchBranches(GA, GB, A, project(TREE, GB, [0, 0], 2, "b")).sensitiveAxis;
    const B = project(TREE, GB, [ax[0] * 12, ax[1] * 12], 3, "b");
    expect(matchBranches(GA, GB, A, B, { correctionCapPx: 10 }).warnings).toContain("correctionOverCap");
    expect(matchBranches(GA, GB, A, B, { correctionCapPx: 20 }).warnings).not.toContain("correctionOverCap");
  });

  it("枝を 30% 欠落させても、感度軸の位置ずれを回収できる", () => {
    const A = project(TREE, GA, [0, 0], 1, "a");
    const ax = matchBranches(GA, GB, A, project(TREE, GB, [0, 0], 2, "b")).sensitiveAxis;
    const B = project(TREE, GB, [ax[0] * 8, ax[1] * 8], 3, "b").map((b) => {
      const cut = Math.floor(b.pointsPx.length * 0.3);
      const start = Math.floor(b.pointsPx.length * 0.2);
      return { ...b, pointsPx: [...b.pointsPx.slice(0, start), ...b.pointsPx.slice(start + cut)] };
    });
    const r = matchBranches(GA, GB, A, B);
    expect(Math.abs(r.sensitiveShiftPx - 8)).toBeLessThanOrEqual(2);
  });

  it("負例: 枝が無い・短すぎる入力では何も返さない", () => {
    const A = project(TREE, GA, [0, 0], 1, "a");
    expect(matchBranches(GA, GB, A, []).status).toBe("noBranches");
    expect(matchBranches(GA, GB, [], A).status).toBe("noBranches");
    expect(matchBranches(GA, GB, [{ id: "x", pointsPx: [[1, 1]] }], A).status).toBe("noBranches");
  });
});
