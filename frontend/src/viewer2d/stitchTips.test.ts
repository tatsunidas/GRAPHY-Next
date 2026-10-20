/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { en } from "../i18n/en";
import { ja } from "../i18n/ja";
import { ALIGN_LIMITS, MARGIN_SLICES, MIN_NCC_GAIN, NULL_SIGMAS } from "../viewer/stitchAutoAlign";

const dir = __dirname;
const src = ["StitchDialog.tsx", "StitchAlignPanel.tsx"].map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("\n");
// 条件の説明は t(`stitch.tip.cond.${k}`) で引く（k は VIOLATIONS）
const COND = ["tooFew", "patient", "orientation", "modality", "petReference"].map((k) => `stitch.tip.cond.${k}`);
const used = new Set<string>([...[...src.matchAll(/t\("((?:stitch|align)\.tip\.[\w.]+)"\)/g)].map((m) => m[1]), ...COND]);
const tipKeys = (d: Record<string, string>) => Object.keys(d).filter((k) => /^(stitch|align)\.tip\./.test(k));

describe("つなぎ合わせのツールチップ", () => {
  it("使っている説明が ja・en の両方にあり、空でない", () => {
    expect(used.size).toBeGreaterThan(30);
    for (const k of used) {
      expect(ja[k], `ja ${k}`).toBeTruthy();
      expect(en[k], `en ${k}`).toBeTruthy();
    }
  });

  it("定義した説明は、どれも画面で使われている（孤児が無い）", () => {
    for (const k of tipKeys(ja)) expect(used.has(k), `未使用 ${k}`).toBe(true);
  });

  it("ja と en のキーとプレースホルダが一致する", () => {
    expect(tipKeys(en).sort()).toEqual(tipKeys(ja).sort());
    const ph = (s: string) => [...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();
    for (const k of tipKeys(ja)) expect(ph(en[k]), k).toEqual(ph(ja[k]));
  });

  it("自動位置合わせの説明が、対象・方法・採用の条件を含む", () => {
    const j = ja["align.tip.auto"];
    for (const w of ["対象", "方法", "採用の条件", "NCC"]) expect(j, w).toContain(w);
    const e = en["align.tip.auto"];
    for (const w of ["Target", "Method", "Acceptance", "NCC"]) expect(e, w).toContain(w);
  });

  it("自動位置合わせの説明の数値が、実装の定数と一致する", () => {
    for (const txt of [ja["align.tip.auto"], en["align.tip.auto"]]) {
      expect(txt).toContain(`${ALIGN_LIMITS.sameFrame.translationMm} mm`);
      expect(txt).toContain(`${ALIGN_LIMITS.sameFrame.rotationDeg}°`);
      expect(txt).toContain(`${ALIGN_LIMITS.otherFrame.translationMm} mm`);
      expect(txt).toContain(`${ALIGN_LIMITS.otherFrame.rotationDeg}°`);
      expect(txt).toContain(String(MIN_NCC_GAIN));
      expect(txt).toContain(`${NULL_SIGMAS}/√`);
      expect(txt).toContain(`${MARGIN_SLICES} `);
    }
  });
});
