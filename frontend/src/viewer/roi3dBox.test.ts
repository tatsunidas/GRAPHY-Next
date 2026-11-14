import { describe, expect, it } from "vitest";
import {
  boxFromDiagonal,
  formatMl,
  formulaText,
  outOfBounds,
  resizeEdge,
  sectionAt,
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
