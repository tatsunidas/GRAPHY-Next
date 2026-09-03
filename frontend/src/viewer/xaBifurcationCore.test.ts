/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import { findPointOfBifurcation, nearestOnTube, type TubeBranch } from "./xaBifurcationCore";
import type { Vec3 } from "./xaGeometry";

/** 等間隔に点を打った直線の枝。半径は両端で線形に変える（テーパー）。 */
function straight(
  id: string,
  from: Vec3,
  to: Vec3,
  rFrom: number,
  rTo: number,
  n = 40,
): TubeBranch {
  const points: Vec3[] = [];
  const radiiMm: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    points.push([
      from[0] + (to[0] - from[0]) * t,
      from[1] + (to[1] - from[1]) * t,
      from[2] + (to[2] - from[2]) * t,
    ]);
    radiiMm.push(rFrom + (rTo - rFrom) * t);
  }
  return { id, points, radiiMm };
}

/**
 * Y 字の分岐。原点で分かれ、近位が −X から来て、遠位が +X、側枝が斜めへ抜ける。
 * `trimMm` はカリーナ側の端を削る長さ（＝**利用者がどこで描き終えたか**の違い）。
 */
function yBifurcation(trimMm = 0): TubeBranch[] {
  const s = trimMm;
  return [
    straight("proximal", [-30, 0, 0], [-s, 0, 0], 2.0, 2.0),
    straight("distal", [s, 0, 0], [30, 0, 0], 1.6, 1.6),
    straight(
      "side",
      [s * 0.707, s * 0.707, 0],
      [21.2, 21.2, 0],
      1.2,
      1.2,
    ),
  ];
}

describe("nearestOnTube", () => {
  const tube = straight("t", [0, 0, 0], [10, 0, 0], 1.0, 3.0, 11);

  it("線分上へ落として距離を出す", () => {
    const near = nearestOnTube([5, 2, 0], tube)!;
    expect(near.distanceMm).toBeCloseTo(2, 6);
  });

  it("半径は線分上の位置で内挿する（テーパーで段を作らない）", () => {
    // 中央 (x=5) の半径は 1.0 と 3.0 の中間 = 2.0。
    expect(nearestOnTube([5, 0, 0], tube)!.radiusMm).toBeCloseTo(2.0, 6);
    // 点と点の間 (x=5.5) でも段にならない。
    expect(nearestOnTube([5.5, 0, 0], tube)!.radiusMm).toBeCloseTo(2.1, 6);
  });

  it("端より外へ出た点は端に落ちる", () => {
    const near = nearestOnTube([-4, 0, 0], tube)!;
    expect(near.distanceMm).toBeCloseTo(4, 6);
    expect(near.radiusMm).toBeCloseTo(1.0, 6);
  });
});

describe("findPointOfBifurcation", () => {
  it("Y 字の分岐で、3 本すべての管に入る点を返す", () => {
    const pob = findPointOfBifurcation(yBifurcation())!;
    expect(pob.overlapping).toBe(true);
    // 3 本が交わるのは原点のまわりだけ。
    expect(Math.hypot(...pob.point)).toBeLessThan(2.0);
    // 内接球はいちばん細い枝（側枝 r=1.2）より大きくなれない。
    expect(pob.radiusMm).toBeGreaterThan(0);
    expect(pob.radiusMm).toBeLessThanOrEqual(1.2 + 1e-6);
  });

  it("枝ごとの余裕を返し、その最小が半径になる", () => {
    const pob = findPointOfBifurcation(yBifurcation())!;
    expect(pob.clearanceMm.map((c) => c.id).sort()).toEqual(["distal", "proximal", "side"]);
    expect(Math.min(...pob.clearanceMm.map((c) => c.value))).toBeCloseTo(pob.radiusMm, 6);
  });

  it("🔴 端をどこで描き終えても位置が動かない（これが端点の重心をやめた理由）", () => {
    // 🚨 2026-09-02 に踏んだ失敗の再発防止。カリーナを「端点の重心」で決めていたときは、
    //    カリーナ側の点を削るとカリーナ自体が動き、除外域も角度の窓も別の場所を指した。
    //    幾何から決めるなら、**どこで描き終えたかは答えを変えない**。
    const base = findPointOfBifurcation(yBifurcation(0))!;
    for (const trim of [1, 2, 3]) {
      const moved = findPointOfBifurcation(yBifurcation(trim))!;
      const shift = Math.hypot(
        moved.point[0] - base.point[0],
        moved.point[1] - base.point[1],
        moved.point[2] - base.point[2],
      );
      // 実測: 延長ありで 0.02mm 以下。延長を入れる前は 2mm 削るだけで 0.60mm 動いていた。
      expect(shift, `trim=${trim}mm`).toBeLessThan(0.1);
    }
  });

  it("🚨 3 本が交わっていなければ overlapping=false（分岐だと言い張らない）", () => {
    const apart: TubeBranch[] = [
      straight("proximal", [-30, 0, 0], [-10, 0, 0], 2.0, 2.0),
      straight("distal", [10, 0, 0], [30, 0, 0], 1.6, 1.6),
      straight("side", [0, 20, 0], [20, 40, 0], 1.2, 1.2),
    ];
    const pob = findPointOfBifurcation(apart)!;
    expect(pob.overlapping).toBe(false);
    expect(pob.radiusMm).toBeLessThan(0);
  });

  it("半径が 1 つも無い枝があっても落ちない（束縛にしない）", () => {
    const b = yBifurcation();
    const noRadius: TubeBranch = { ...b[2], radiiMm: b[2].points.map(() => null) };
    const pob = findPointOfBifurcation([b[0], b[1], noRadius]);
    expect(pob).not.toBeNull();
    expect(pob!.clearanceMm.map((c) => c.id).sort()).toEqual(["distal", "proximal"]);
  });

  it("端の延長は「核の位置決め」専用で、測定には使わせない長さに留める", () => {
    // 延長を 0 にすると端点への依存が戻る（＝延長が効いていることの裏取り）。
    const base = findPointOfBifurcation(yBifurcation(0), { extensionMm: 0 })!;
    const trimmed = findPointOfBifurcation(yBifurcation(2), { extensionMm: 0 })!;
    const shift = Math.hypot(
      trimmed.point[0] - base.point[0],
      trimmed.point[1] - base.point[1],
      trimmed.point[2] - base.point[2],
    );
    expect(shift).toBeGreaterThan(0.3);
  });

  it("枝が 3 本未満なら null（分岐ではない）", () => {
    expect(findPointOfBifurcation(yBifurcation().slice(0, 2))).toBeNull();
  });

  it("🔴 母血管の真ん中を返さない（min を max にすると起きる間違い）", () => {
    // 母血管は側枝の 2 倍近く太いので、「どれか 1 本の中でいちばん太いところ」を探すと
    // 近位の中央 (−15, 0, 0) あたりが答えになってしまう。
    const pob = findPointOfBifurcation(yBifurcation())!;
    expect(pob.point[0]).toBeGreaterThan(-5);
  });
});
