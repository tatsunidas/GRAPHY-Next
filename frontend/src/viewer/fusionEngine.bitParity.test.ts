/*
 * 画素関数の切り出し（computeFusionPixel）が、切り出す前の computeFusionSlice と
 * 全画素ビット一致であることを、旧コード（fusionEngineLegacy.testutil.ts に固定）との
 * その場の比較で確かめる。NaN の位置も Object.is で一致させる。
 */
import { describe, it, expect } from "vitest";
import { computeFusionPixel, computeFusionSlice, prepareFusionSlice } from "./fusionEngine";
import { computeFusionSliceLegacy } from "./fusionEngineLegacy.testutil";
import {
  fusionFixtureTransforms, makeFusionFixtureBg, makeFusionFixtureFg, BG_COLS, BG_ROWS,
} from "./gpuResample/parityFixtures.testutil";

describe("computeFusionSlice の切り出し: 旧コードとビット一致", () => {
  const fg = makeFusionFixtureFg();
  // 背景は前景の内側・端・z 範囲外（NaN にならず端でクランプされる側）を通る 5 枚
  const zs = [-14, -6, 0, 5, 12];
  for (const { name, xf } of fusionFixtureTransforms()) {
    it(`${name}`, () => {
      let finite = 0, nan = 0;
      for (const z of zs) {
        const bg = makeFusionFixtureBg(z);
        const a = computeFusionSliceLegacy(fg, bg, xf);
        const b = computeFusionSlice(fg, bg, xf);
        expect(b.length).toBe(BG_COLS * BG_ROWS);
        let diff = 0;
        for (let i = 0; i < a.length; i++) {
          if (!Object.is(a[i], b[i])) diff++;
          if (Number.isNaN(a[i])) nan++; else finite++;
        }
        expect(diff, `z=${z}`).toBe(0);
      }
      // 対象が実在すること（全部 NaN／全部有効で通さない）
      expect(finite).toBeGreaterThan(500);
      expect(nan).toBeGreaterThan(50);
    });
  }

  // 1 点版（カーソル値・一致検査が使う）は、スライス版と同じ式の二重実装。全画素でビット一致を縛る
  for (const { name, xf } of fusionFixtureTransforms()) {
    it(`1 点版 computeFusionPixel がスライス版と全画素ビット一致: ${name}`, () => {
      let finite = 0;
      for (const z of zs) {
        const bg = makeFusionFixtureBg(z);
        const slice = computeFusionSlice(fg, bg, xf);
        const ctx = prepareFusionSlice(fg, bg, xf)!;
        let diff = 0;
        // 行の走査順に依らないことも見るため、列優先で走らせる
        for (let bx = 0; bx < bg.cols; bx++) for (let by = 0; by < bg.rows; by++) {
          const v = computeFusionPixel(ctx, bx, by);
          const w = slice[by * bg.cols + bx];
          // スライス版は Float32Array に入れるので fround して比べる
          if (!Object.is(Math.fround(v), w)) diff++;
          if (!Number.isNaN(w)) finite++;
        }
        expect(diff, `z=${z}`).toBe(0);
      }
      expect(finite).toBeGreaterThan(500);
    });
  }

  it("前景 0 枚は全 NaN（旧コードと同じ）", () => {
    const bg = makeFusionFixtureBg(0);
    const empty = { ...fg, slices: [] };
    const a = computeFusionSliceLegacy(empty, bg, null);
    const b = computeFusionSlice(empty, bg, null);
    expect(a.every(Number.isNaN)).toBe(true);
    expect(b.every(Number.isNaN)).toBe(true);
  });
});
