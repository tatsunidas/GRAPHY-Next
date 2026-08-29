/*
 * `vtkTubeFilter` に点ごとの色を効かせる後始末の回帰テスト。
 *
 * 🚨 **上流の挙動そのものを 1 件目で固定している。** `vtkTubeFilter` は入力の点データを
 * 出力へ運ぶが**アクティブなスカラーにはしない**——この一点だけで A7 の色が丸ごと
 * 効いていなかった（`fw/angio-design.md` §11.4）。上流を上げたとき最初に壊れる場所なので、
 * 「運ばれること」と「アクティブであること」を**別々に**見ている。
 */
import { describe, expect, it } from "vitest";
import vtkPolyData from "@kitware/vtk.js/Common/DataModel/PolyData";
import vtkDataArray from "@kitware/vtk.js/Common/Core/DataArray";
import vtkTubeFilter from "@kitware/vtk.js/Filters/General/TubeFilter";

import { activateTubeColors, TUBE_COLOR_ARRAY } from "./tubeColors";

/* eslint-disable @typescript-eslint/no-explicit-any */

function makeLine(n: number, withColors: boolean): any {
  const flat = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    flat[i * 3] = i;
    flat[i * 3 + 1] = 0;
    flat[i * 3 + 2] = 0;
  }
  const lines = new Uint32Array(n + 1);
  lines[0] = n;
  for (let i = 0; i < n; i++) lines[i + 1] = i;
  const pd: any = vtkPolyData.newInstance();
  pd.getPoints().setData(flat, 3);
  pd.getLines().setData(lines);
  if (withColors) {
    const colors = new Uint8Array(n * 3);
    for (let i = 0; i < n; i++) {
      colors[i * 3] = i * 20;
      colors[i * 3 + 1] = 10;
      colors[i * 3 + 2] = 200;
    }
    pd.getPointData().setScalars(
      vtkDataArray.newInstance({ name: TUBE_COLOR_ARRAY, numberOfComponents: 3, values: colors }),
    );
  }
  return pd;
}

function tubeOf(pd: any): any {
  const tube: any = vtkTubeFilter.newInstance();
  tube.setInputData(pd);
  tube.setRadius(1);
  tube.setNumberOfSides(10);
  tube.setCapping(true);
  return tube.getOutputData();
}

describe("tubeColors", () => {
  it("🚨 vtkTubeFilter は色を運ぶが、アクティブなスカラーにはしない（上流の挙動）", () => {
    const out = tubeOf(makeLine(10, true));
    expect(out.getNumberOfPoints()).toBeGreaterThan(10);
    // 配列は運ばれている
    expect(out.getPointData().getArrayByName(TUBE_COLOR_ARRAY)).toBeTruthy();
    // しかしアクティブではない ← ここが効かなかった原因
    expect(out.getPointData().getScalars()).toBeNull();
  });

  it("activateTubeColors でアクティブなスカラーになる", () => {
    const out = tubeOf(makeLine(10, true));
    expect(activateTubeColors(out)).toBe(true);
    const s = out.getPointData().getScalars();
    expect(s).toBeTruthy();
    expect(s.getName()).toBe(TUBE_COLOR_ARRAY);
    expect(s.getNumberOfComponents()).toBe(3);
    // 管の点の数と揃っている（揃っていない色を立てるとずれた色が乗る）
    expect(s.getNumberOfTuples()).toBe(out.getNumberOfPoints());
  });

  it("色が無ければ false を返す（単色のまま描く）", () => {
    const out = tubeOf(makeLine(10, false));
    expect(activateTubeColors(out)).toBe(false);
    expect(out.getPointData().getScalars()).toBeNull();
  });

  it("点の数と合わない配列は立てない（ずれた色を黙って乗せない）", () => {
    const out = tubeOf(makeLine(10, false));
    const wrong = new Uint8Array(9);
    out.getPointData().addArray(
      vtkDataArray.newInstance({ name: TUBE_COLOR_ARRAY, numberOfComponents: 3, values: wrong }),
    );
    expect(activateTubeColors(out)).toBe(false);
    expect(out.getPointData().getScalars()).toBeNull();
  });

  it("既にアクティブなら何もしない（入力の polydata をそのまま使う経路）", () => {
    const pd = makeLine(10, true);
    expect(activateTubeColors(pd)).toBe(true);
    expect(pd.getPointData().getScalars().getName()).toBe(TUBE_COLOR_ARRAY);
  });
});
