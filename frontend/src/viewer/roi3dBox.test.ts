import { describe, expect, it } from "vitest";
import {
  boxFromDiagonal,
  containsPoint,
  ellipsoidSection,
  sectionOutline,
  solidRadius,
  sphereSolid,
  type Vec3,
  formatMl,
  formulaText,
  outOfBounds,
  resizeEdge,
  sectionAt,
  mergeSolids,
  sanitizeSolid,
  translate,
  volumeMl,
  volumeMm3,
  withSize,
  type Roi3dBox,
} from "./roi3dBox";

const mk = (shape: Roi3dBox["shape"], size: [number, number, number], center: [number, number, number] = [0, 0, 0]): Roi3dBox => ({
  id: "r",
  shape,
  center,
  size,
});

describe("容積（解析式）", () => {
  it("楕円体 20×10×10 mm = π·2000/6 = 1047.2 mm³ = 1.0472 mL", () => {
    const b = mk("ellipsoid", [20, 10, 10]);
    expect(volumeMm3(b)).toBeCloseTo(1047.1976, 3);
    expect(formatMl(volumeMl(b))).toBe("1.0472");
  });
  it("直方体 10×10×10 mm = 1000 mm³ = 1.0000 mL", () => {
    const b = mk("box", [10, 10, 10]);
    expect(volumeMm3(b)).toBe(1000);
    expect(formatMl(volumeMl(b))).toBe("1.0000");
  });
  it("球（全長 d の等方）は π·d³/6（d=12 → 904.78 mm³）", () => {
    expect(volumeMm3(mk("ellipsoid", [12, 12, 12]))).toBeCloseTo(904.7787, 3);
  });
  it("式の文字列は代入済みで、形ごとに式が違う", () => {
    expect(formulaText(mk("box", [10, 20, 30]))).toBe("V = Lx × Ly × Lz = 10.0 × 20.0 × 30.0 = 6000.0 mm³ = 6.0000 mL");
    expect(formulaText(mk("ellipsoid", [20, 10, 10]))).toBe(
      "V = π × Lx × Ly × Lz / 6 = π × 20.0 × 10.0 × 10.0 / 6 = 1047.2 mm³ = 1.0472 mL",
    );
  });
});

describe("断面", () => {
  it("楕円体: 半軸 5、中心から 3 mm の面は √(1−0.36)=0.8 倍（面内半幅 10→8）", () => {
    const s = sectionAt(mk("ellipsoid", [20, 20, 10]), "axial", 3)!;
    expect(s.hu).toBeCloseTo(8, 10);
    expect(s.hv).toBeCloseTo(8, 10);
  });
  it("楕円体: 中心の面は最大、端を越えると null、端ちょうどは半幅 0", () => {
    const b = mk("ellipsoid", [20, 10, 10]);
    expect(sectionAt(b, "sagittal", 0)!.hu).toBe(5); // 矢状の u=Y, 半幅 5
    expect(sectionAt(b, "sagittal", 0)!.hv).toBe(5);
    expect(sectionAt(b, "sagittal", 10.001)).toBeNull();
    expect(sectionAt(b, "sagittal", 10)!.hu).toBe(0);
  });
  it("直方体: 範囲内なら位置に依らず同じ矩形、範囲外は null", () => {
    const b = mk("box", [20, 10, 6], [1, 2, 3]);
    const a = sectionAt(b, "axial", 1)!;
    const c = sectionAt(b, "axial", 5.9)!;
    expect(a).toEqual(c);
    expect(a).toMatchObject({ cu: 1, cv: 2, hu: 10, hv: 5 });
    expect(sectionAt(b, "axial", 6.1)).toBeNull();
  });
  it("面ごとの軸対応: 冠状は (X,Z)、矢状は (Y,Z)", () => {
    const b = mk("box", [2, 4, 6]);
    expect(sectionAt(b, "coronal", 0)).toMatchObject({ hu: 1, hv: 3 });
    expect(sectionAt(b, "sagittal", 0)).toMatchObject({ hu: 2, hv: 3 });
  });
});

describe("対角から作る", () => {
  it("軸位: 20×10 の対角 → 第 3 軸（Z）は短い方 10、中心 Z は描いた面の位置", () => {
    const b = boxFromDiagonal("r", "box", "axial", 7, [-10, -5], [10, 5])!;
    expect(b.size).toEqual([20, 10, 10]);
    expect(b.center).toEqual([0, 0, 7]);
  });
  it("対角の向きが逆でも同じ", () => {
    expect(boxFromDiagonal("r", "box", "axial", 7, [10, 5], [-10, -5])).toEqual(
      boxFromDiagonal("r", "box", "axial", 7, [-10, -5], [10, 5]),
    );
  });
  it("縦長（4×30）では第 3 軸は短い 4（長い方を選ばない）", () => {
    expect(boxFromDiagonal("r", "ellipsoid", "coronal", 0, [0, 0], [4, 30])!.size).toEqual([4, 4, 30]);
  });
  it("面内の径が 0 なら作らない", () => {
    expect(boxFromDiagonal("r", "box", "axial", 0, [1, 1], [1, 9])).toBeNull();
  });
});

describe("調整", () => {
  const b = mk("box", [10, 10, 10]);
  it("端を動かすと反対側は固定（大きい側を 5→8 へ: 長さ 13、中心 +1.5）", () => {
    const r = resizeEdge(b, 0, 1, 8);
    expect(r.size[0]).toBe(13);
    expect(r.center[0]).toBe(1.5);
  });
  it("反対側を越える動きは無視する", () => {
    expect(resizeEdge(b, 0, 1, -6)).toBe(b);
  });
  it("径の入力は正の有限値のみ受ける", () => {
    expect(withSize(b, 1, 0)).toBe(b);
    expect(withSize(b, 1, NaN)).toBe(b);
    expect(withSize(b, 1, 4).size).toEqual([10, 4, 10]);
  });
  it("移動は大きさを変えない", () => {
    const r = translate(b, [1, 2, 3]);
    expect(r.center).toEqual([1, 2, 3]);
    expect(r.size).toEqual([10, 10, 10]);
  });
});

describe("ボリュームからのはみ出し", () => {
  const bounds: [number, number, number, number, number, number] = [-50, 50, -50, 50, -50, 50];
  it("正例: 外へ出る", () => {
    expect(outOfBounds(mk("box", [20, 20, 20], [45, 0, 0]), bounds)).toBe(true);
    expect(outOfBounds(mk("ellipsoid", [20, 20, 20], [0, 0, -45]), bounds)).toBe(true);
  });
  it("負例: 内側・ちょうど接するのは出ない", () => {
    expect(outOfBounds(mk("box", [20, 20, 20], [0, 0, 0]), bounds)).toBe(false);
    expect(outOfBounds(mk("box", [20, 20, 20], [40, 0, 0]), bounds)).toBe(false);
  });
});

describe("sanitizeSolid / mergeSolids", () => {
  const ok = { id: "a", shape: "ellipsoid", center: [1, 2, 3], size: [20, 10, 10], updatedAt: "2026-10-21T00:00:00.000Z" };
  it("正例: 正しい solid はそのまま読める（メタも保つ）", () => {
    expect(sanitizeSolid({ ...ok, label: "L", seriesUid: "s", visible: false })).toMatchObject({ id: "a", shape: "ellipsoid", label: "L", seriesUid: "s", visible: false });
  });
  it.each([
    ["id が無い", { ...ok, id: "" }],
    ["形が未知", { ...ok, shape: "sphere" }],
    ["中心が欠ける", { ...ok, center: [1, 2] }],
    ["径が 0", { ...ok, size: [20, 0, 10] }],
    ["径が負", { ...ok, size: [20, -1, 10] }],
    ["径が NaN", { ...ok, size: [20, NaN, 10] }],
    ["null", null],
  ])("負例: %s は落とす", (_n, v) => {
    expect(sanitizeSolid(v)).toBeNull();
  });
  const s = (id: string, at: string, x = 10): Roi3dBox => ({ id, shape: "box", center: [0, 0, 0], size: [x, 10, 10], updatedAt: at });
  it("同じ id は updatedAt の新しい方（古いローカルが新しいリモートを潰さない）", () => {
    const m = mergeSolids([s("a", "2026-10-21T10:00:00Z", 30)], [s("a", "2026-10-21T09:00:00Z", 10)], new Set());
    expect(m[0].size[0]).toBe(30);
    const m2 = mergeSolids([s("a", "2026-10-21T09:00:00Z", 30)], [s("a", "2026-10-21T10:00:00Z", 10)], new Set());
    expect(m2[0].size[0]).toBe(10);
  });
  it("和を取り、墓標の id は除き、順序は id で決定的", () => {
    const m = mergeSolids([s("z", "t"), s("b", "t")], [s("a", "t"), s("b", "t")], new Set(["z"]));
    expect(m.map((x) => x.id)).toEqual(["a", "b"]);
  });
});

describe("球・断面・包含（G0b）", () => {
  const X: Vec3 = [1, 0, 0];
  const Y: Vec3 = [0, 1, 0];
  const sphere = (c: Vec3, r: number) => sphereSolid("s", c, r);
  const halves = (e: NonNullable<ReturnType<typeof ellipsoidSection>>) => e.axes.map((a) => a.half).sort((a, b) => a - b);

  it("sphereSolid / solidRadius: 等軸の楕円体だけが半径を持つ", () => {
    const s = sphere([1, 2, 3], 7);
    expect(s.size).toEqual([14, 14, 14]);
    expect(solidRadius(s)).toBe(7);
    expect(solidRadius({ shape: "ellipsoid", size: [20, 10, 10] })).toBeNull();
    expect(solidRadius({ shape: "box", size: [10, 10, 10] })).toBeNull();
  });

  it("球の断面は半径 √(r²−d²) の円（r=10, d=6 → 8）", () => {
    const e = ellipsoidSection(sphere([0, 0, 0], 10), [0, 0, 6], X, Y)!;
    expect(halves(e)[0]).toBeCloseTo(8, 9);
    expect(halves(e)[1]).toBeCloseTo(8, 9);
    expect(e.center).toEqual([0, 0, 6]);
  });

  it("面が中心から外れていても断面の中心は ROI 中心の射影（中心 (5,5,5), z=8, r=10 → (5,5,8), 半径 √91）", () => {
    const e = ellipsoidSection(sphere([5, 5, 5], 10), [0, 0, 8], X, Y)!;
    expect(e.center[0]).toBeCloseTo(5, 9);
    expect(e.center[1]).toBeCloseTo(5, 9);
    expect(e.center[2]).toBeCloseTo(8, 9);
    expect(halves(e)[1]).toBeCloseTo(Math.sqrt(91), 9);
  });

  it("負例: 接する（d=r）・離れる（d>r）は null", () => {
    expect(ellipsoidSection(sphere([0, 0, 0], 10), [0, 0, 10], X, Y)).toBeNull();
    expect(ellipsoidSection(sphere([0, 0, 0], 10), [0, 0, 11], X, Y)).toBeNull();
    expect(ellipsoidSection(sphere([0, 0, 0], 10), [0, 0, -10.5], X, Y)).toBeNull();
  });

  it("非等軸（半軸 10/5/5）: z=0 で 10×5、z=3 で 0.8 倍の 8×4", () => {
    const b = { center: [0, 0, 0] as Vec3, size: [20, 10, 10] as Vec3 };
    expect(halves(ellipsoidSection(b, [0, 0, 0], X, Y)!)).toEqual([expect.closeTo(5, 9), expect.closeTo(10, 9)]);
    expect(halves(ellipsoidSection(b, [0, 0, 3], X, Y)!)).toEqual([expect.closeTo(4, 9), expect.closeTo(8, 9)]);
  });

  it("斜めの面: 半軸 10/5/5 を y 軸のまわりに 30° 傾けた面 → 半長 5 と 1/√(0.0175)", () => {
    const c = Math.cos(Math.PI / 6);
    const s = Math.sin(Math.PI / 6);
    const e = ellipsoidSection({ center: [0, 0, 0], size: [20, 10, 10] }, [0, 0, 0], [c, 0, s], Y)!;
    expect(halves(e)[0]).toBeCloseTo(5, 9);
    expect(halves(e)[1]).toBeCloseTo(1 / Math.sqrt(0.0175), 9);
    // 主軸の方向は単位ベクトルで、面内にある（法線 (−s,0,c) と直交）
    for (const a of e.axes) {
      expect(Math.hypot(...a.dir)).toBeCloseTo(1, 9);
      expect(-s * a.dir[0] + c * a.dir[2]).toBeCloseTo(0, 9);
    }
  });

  it("輪郭点は楕円体の表面上にある（全点で Σ((p−c)/半軸)² = 1）", () => {
    const b = { shape: "ellipsoid" as const, center: [3, -2, 4] as Vec3, size: [20, 10, 14] as Vec3 };
    const c = Math.cos(0.4);
    const s = Math.sin(0.4);
    const pts = sectionOutline(b, [3, -2, 5], [c, s, 0], [-s, c, 0], 32)!;
    expect(pts).toHaveLength(32);
    for (const p of pts) {
      const f = ((p[0] - 3) / 10) ** 2 + ((p[1] + 2) / 5) ** 2 + ((p[2] - 4) / 7) ** 2;
      expect(f).toBeCloseTo(1, 9);
    }
  });

  it("直方体の断面: 軸平行なら 4 点の矩形、体対角に垂直な面は正六角形、離れれば null", () => {
    const b = { shape: "box" as const, center: [0, 0, 0] as Vec3, size: [10, 10, 10] as Vec3 };
    const sq = sectionOutline(b, [0, 0, 2], X, Y)!;
    expect(sq).toHaveLength(4);
    for (const p of sq) {
      expect(Math.abs(p[0])).toBeCloseTo(5, 9);
      expect(Math.abs(p[1])).toBeCloseTo(5, 9);
      expect(p[2]).toBeCloseTo(2, 9);
    }
    const k = 1 / Math.sqrt(2);
    const kk = 1 / Math.sqrt(6);
    const hex = sectionOutline(b, [0, 0, 0], [k, -k, 0], [kk, kk, -2 * kk])!; // 面の法線 ∝ (1,1,1)
    expect(hex).toHaveLength(6);
    const radii = hex.map((p) => Math.hypot(...p));
    for (const r of radii) expect(r).toBeCloseTo(5 * Math.SQRT2, 9); // 頂点は辺の中点（例 (5,−5,0)）= 中心から 5√2
    expect(sectionOutline(b, [0, 0, 6], X, Y)).toBeNull();
  });

  it("containsPoint: 楕円体と直方体の境界（内側・境界は真、外は偽）", () => {
    const e = { shape: "ellipsoid" as const, center: [0, 0, 0] as Vec3, size: [20, 10, 10] as Vec3 };
    expect(containsPoint(e, [10, 0, 0])).toBe(true);
    expect(containsPoint(e, [10.001, 0, 0])).toBe(false);
    expect(containsPoint(e, [7, 3.5, 0])).toBe(true); // 0.49 + 0.49 = 0.98
    expect(containsPoint(e, [7.5, 3.5, 0])).toBe(false); // 0.5625 + 0.49 > 1
    const b = { shape: "box" as const, center: [1, 1, 1] as Vec3, size: [4, 4, 4] as Vec3 };
    expect(containsPoint(b, [3, 3, 3])).toBe(true);
    expect(containsPoint(b, [3.001, 1, 1])).toBe(false);
  });

  it("sanitizeSolid の c/t/refImageId: 'all'・0 以上の整数は通り、負・小数・文字列は落ちる（他の項目は無傷）", () => {
    const base = { id: "a", shape: "ellipsoid", center: [0, 0, 0], size: [2, 2, 2] };
    expect(sanitizeSolid({ ...base, c: "all", t: 3, refImageId: "x", seriesLabel: "L" })).toMatchObject({ c: "all", t: 3, refImageId: "x", seriesLabel: "L" });
    const bad = sanitizeSolid({ ...base, c: -1, t: 1.5 })!;
    expect(bad.c).toBeUndefined();
    expect(bad.t).toBeUndefined();
    expect(sanitizeSolid({ ...base, c: "0" })!.c).toBeUndefined();
    expect(bad.id).toBe("a");
  });
});
