/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */

/**
 * ハイパーパラメータとプリセットのテスト。
 *
 * <p>この一式は**そのままレシピとして結果に保存される**ので、値の同一性判定と
 * 入出力の往復が壊れると「同じ設定で再実行したはずなのに違う」が起きる。
 */
import { describe, it, expect } from "vitest";
import {
  PRESETS, STANDARD_PARAMS, SMOOTH_PARAMS, ACCURATE_PARAMS,
  matchingPreset, sameParams, parseSpacings, formatSpacings,
} from "./regParams";

describe("regParams — プリセット", () => {
  it("標準は既定値そのもの", () => {
    expect(matchingPreset(STANDARD_PARAMS)).toBe("standard");
  });

  it("滑らか重視は後平滑が強い（Jacobian に効くレバー）", () => {
    expect(SMOOTH_PARAMS.smoothingSigma).toBeGreaterThan(STANDARD_PARAMS.smoothingSigma);
    expect(matchingPreset(SMOOTH_PARAMS)).toBe("smooth");
  });

  it("精度重視は記述子が細かく段が多い（そのぶん遅い）", () => {
    expect(ACCURATE_PARAMS.descriptorSpacingMm).toBeLessThan(STANDARD_PARAMS.descriptorSpacingMm);
    expect(ACCURATE_PARAMS.controlSpacingsMm.length)
      .toBeGreaterThan(STANDARD_PARAMS.controlSpacingsMm.length);
    expect(matchingPreset(ACCURATE_PARAMS)).toBe("accurate");
  });

  it("★どのプリセットも後平滑を 0 にしない", () => {
    // σ=0 はファントム実測で Jacobian 負値（折り返し）を出した。
    // 滑らかさは見た目の問題ではなく、変形が物理的に成立するための条件。
    for (const p of Object.values(PRESETS)) expect(p.smoothingSigma).toBeGreaterThan(0);
  });

  it("プリセットから外れた値は「カスタム」になる", () => {
    expect(matchingPreset({ ...STANDARD_PARAMS, seed: 1 })).toBeNull();
    expect(matchingPreset({ ...STANDARD_PARAMS, controlSpacingsMm: [24, 12] })).toBeNull();
  });

  it("制御点間隔の配列は要素まで比較する（長さだけでは足りない）", () => {
    expect(sameParams(STANDARD_PARAMS, { ...STANDARD_PARAMS, controlSpacingsMm: [48, 24, 13] }))
      .toBe(false);
  });
});

describe("regParams — 制御点間隔の入出力", () => {
  it("往復して同じ値になる", () => {
    const v = [48, 24, 12];
    expect(parseSpacings(formatSpacings(v), [])).toEqual(v);
  });

  it("区切りは カンマ・読点・空白 のどれでもよい", () => {
    expect(parseSpacings("48, 24 12", [])).toEqual([48, 24, 12]);
    expect(parseSpacings("48、24、12", [])).toEqual([48, 24, 12]);
  });

  it("解釈できなければ元の値を保つ（入力途中で消さない）", () => {
    expect(parseSpacings("", [48, 24])).toEqual([48, 24]);
    expect(parseSpacings("abc", [48, 24])).toEqual([48, 24]);
    // 負や 0 は捨てる
    expect(parseSpacings("48, -1, 0, 12", [99])).toEqual([48, 12]);
  });
});
