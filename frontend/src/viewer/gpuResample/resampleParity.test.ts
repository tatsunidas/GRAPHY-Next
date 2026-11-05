/*
 * 一致検査器の正例・負例。
 * 正例: 実際に float32 で計算した結果（Math.fround のエミュレーション）と、CPU の結果を 1 ulp 揺らしたもの。
 * 負例: 実際に起きる種類の 6 つの誤り。すべて不合格になり、違反画素数と |差|/E の最大が出ること。
 * 先に「対象が実在すること」（有効画素が十分ある）を確かめてから比べる。
 */
import { describe, it, expect } from "vitest";
import { computeFusionSlice } from "../fusionEngine";
import { boundsForSlice, checkResampleParity, ulp32 } from "./resampleParity";
import { computeFusionSliceF32 } from "./parityEmulation.testutil";
import { computeFusionSliceWithFault, FAULTS } from "./parityFaults.testutil";
import {
  fusionFixtureTransforms, makeFusionFixtureBg, makeFusionFixtureFg, rng,
} from "./parityFixtures.testutil";
import { composeTransforms, linearTransform, mat4FromEulerDeg } from "../regTransform";

const fg = makeFusionFixtureFg();
const ZS = [-14, -6, 0, 5, 12];

describe("ulp32", () => {
  it("float32 の隣の値との間隔に等しい", () => {
    for (const v of [1, 1.5, 100, 12345.678, 0.001, -77.7]) {
      const a = Math.fround(v);
      const next = new Float32Array(new Uint32Array([new Uint32Array(new Float32Array([Math.abs(a)]).buffer)[0] + 1]).buffer)[0];
      expect(ulp32(v)).toBe(next - Math.abs(a));
    }
  });
});

describe("正例", () => {
  for (const { name, xf } of fusionFixtureTransforms()) {
    it(`float32 の実計算が E 以内: ${name}`, () => {
      let valid = 0, amb = 0, maxRatio = 0;
      for (const z of ZS) {
        const bg = makeFusionFixtureBg(z);
        const cpu = computeFusionSlice(fg, bg, xf);
        const f32 = computeFusionSliceF32(fg, bg, xf);
        const r = checkResampleParity(cpu, f32, boundsForSlice(fg, bg, xf));
        expect(r.violations, `z=${z} worst=${JSON.stringify(r.worst)}`).toBe(0);
        valid += r.valid; amb += r.ambiguous; maxRatio = Math.max(maxRatio, r.maxRatio);
      }
      console.info(`[正例 f32] ${name}: 有効 ${valid}, 境界の曖昧 ${amb}, |差|/E の最大 ${maxRatio.toExponential(2)}`);
      expect(valid).toBeGreaterThan(2000); // 対象が実在する
      expect(maxRatio).toBeGreaterThan(0); // 差が 0 だけ（同じ計算を比べている）ではない
    });

    it(`CPU の結果を 1 ulp 揺らしたものが合格: ${name}`, () => {
      const r = rng(5);
      for (const z of ZS) {
        const bg = makeFusionFixtureBg(z);
        const cpu = computeFusionSlice(fg, bg, xf);
        const j = new Float32Array(cpu.length);
        for (let i = 0; i < cpu.length; i++) j[i] = Number.isNaN(cpu[i]) ? NaN : cpu[i] + (r() < 0.5 ? -1 : 1) * ulp32(cpu[i]);
        const res = checkResampleParity(cpu, j, boundsForSlice(fg, bg, xf));
        expect(res.violations).toBe(0);
        expect(res.maxRatio).toBeGreaterThan(0);
      }
    });
  }
});

describe("負例: 6 種の誤りがすべて不合格になる", () => {
  for (const fault of FAULTS) {
    it(fault, () => {
      let applied = 0, detected = 0;
      for (const { name, xf } of fusionFixtureTransforms()) {
        // 誤りが効く画素（z が前景の内側）が、変換によって背景の位置の一部にしか無いので複数の位置で試す
        let viol = 0, ratio = 0, isApplied = true;
        for (const z of [-6, -3, -1, 0, 1, 3, 6]) {
          const bg = makeFusionFixtureBg(z);
          const bad = computeFusionSliceWithFault(fg, bg, xf, fault);
          if (bad === "n/a") { isApplied = false; break; } // その誤りの対象を含まない変換（例: 逆向きは剛体だけ）
          const cpu = computeFusionSlice(fg, bg, xf);
          const r = checkResampleParity(cpu, bad, boundsForSlice(fg, bg, xf));
          viol += r.violations; ratio = Math.max(ratio, r.maxRatio);
        }
        if (!isApplied) continue;
        applied++;
        console.info(`[負例 ${fault}] ${name}: 違反 ${viol} 画素（7 位置の合計）, |差|/E の最大 ${ratio.toExponential(2)}`);
        if (viol > 0 && ratio > 1) detected++;
      }
      expect(applied).toBeGreaterThan(0);
      expect(detected, `${fault}: 適用 ${applied} 件のうち検出 ${detected} 件`).toBe(applied);
    });
  }

  it("誤りを入れていない写しは CPU と一致する（写し自体が正しい計算であることの確認）", () => {
    for (const { name, xf } of fusionFixtureTransforms()) {
      for (const z of [-6, 0, 5]) {
        const bg = makeFusionFixtureBg(z);
        const same = computeFusionSliceWithFault(fg, bg, xf, "none");
        expect(same, name).not.toBe("n/a");
        const r = checkResampleParity(computeFusionSlice(fg, bg, xf), same as Float32Array, boundsForSlice(fg, bg, xf));
        expect(r.violations, name).toBe(0);
        expect(r.valid, name).toBeGreaterThan(0);
      }
    }
  });

  it("適用できない組合せは n/a（逆向きは剛体 1 つのときだけ、DVF の並びは DVF を含むときだけ）", () => {
    const bg = makeFusionFixtureBg(0);
    expect(computeFusionSliceWithFault(fg, bg, null, "pushForward")).toBe("n/a");
    expect(computeFusionSliceWithFault(fg, bg, fusionFixtureTransforms()[1].xf, "dvfAxisOrder")).toBe("n/a");
  });
});

describe("検査の感度の記録（要求ではない）", () => {
  it("平行移動の誤りを小さくしていき、検出されなくなる最小のずれ", () => {
    const bg = makeFusionFixtureBg(0);
    const base = linearTransform(mat4FromEulerDeg(0, 0, 0), { dof: 6 });
    const cpu = computeFusionSlice(fg, bg, base);
    const bounds = boundsForSlice(fg, bg, base);
    let lastDetected = Infinity;
    const out: string[] = [];
    for (const eps of [1, 1e-1, 1e-2, 1e-3, 1e-4, 1e-5, 1e-6, 1e-7]) {
      const m = mat4FromEulerDeg(0, 0, 0);
      m[3] = eps; // x に eps mm のずれ
      const shifted = computeFusionSlice(fg, bg, linearTransform(m, { dof: 6 }));
      const r = checkResampleParity(cpu, shifted, bounds);
      out.push(`${eps} mm: 違反 ${r.violations}`);
      if (r.violations > 0) lastDetected = eps;
    }
    console.info(`[感度] 平行移動 x: ${out.join(" / ")} → 検出できた最小 ${lastDetected} mm`);
    expect(lastDetected).toBeLessThanOrEqual(1e-1); // 0.1 mm（前景の画素間隔の 1/25）のずれは検出できる
    void composeTransforms;
  });
});
