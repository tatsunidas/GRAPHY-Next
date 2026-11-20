import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { en } from "../i18n/en";
import { ja } from "../i18n/ja";
import { ROI_FEATURE_FAMILIES } from "./roiFeatureSettings";

const FILES = ["RoiFeatureScreen.tsx", "RoiFeatureSettingsFields.tsx", "BatchSettingsPanel.tsx", "RoiFeatureBatchDialog.tsx"];
const here = import.meta.dirname;

/** 画面のソースが参照する roiFeat.tip.* のキー（族ごとのキーは、族の一覧から作る）。 */
function usedKeys(): Set<string> {
  const keys = new Set<string>();
  for (const f of FILES) {
    const src = readFileSync(path.join(here, f), "utf8");
    for (const m of src.matchAll(/roiFeat\.tip\.([A-Za-z]+)/g)) keys.add(`roiFeat.tip.${m[1]}`);
  }
  keys.delete("roiFeat.tip.fam"); // 動的な `roiFeat.tip.fam.${key}` の前半
  for (const fam of ROI_FEATURE_FAMILIES) keys.add(`roiFeat.tip.fam.${fam.key}`);
  return keys;
}

describe("ROI 特徴量の画面のツールチップ", () => {
  it("使っているキーが、日本語・英語の両方にあり、空でない", () => {
    const keys = [...usedKeys()];
    expect(keys.length).toBeGreaterThan(50);
    for (const k of keys) {
      expect((ja[k] ?? "").trim(), `ja ${k}`).not.toBe("");
      expect((en[k] ?? "").trim(), `en ${k}`).not.toBe("");
    }
  });
  it("定義だけあって使っていないキーが無い（付け忘れ・消し忘れの検出）", () => {
    const used = usedKeys();
    const defined = Object.keys(ja).filter((k) => k.startsWith("roiFeat.tip."));
    expect(defined.filter((k) => !used.has(k))).toEqual([]);
    expect(Object.keys(en).filter((k) => k.startsWith("roiFeat.tip.")).sort()).toEqual(defined.sort());
  });
  it("族のツールチップは、族の一覧の全部にある（族を足したら説明も要る）", () => {
    for (const fam of ROI_FEATURE_FAMILIES) expect(ja[`roiFeat.tip.fam.${fam.key}`], fam.key).toBeTruthy();
  });
});
