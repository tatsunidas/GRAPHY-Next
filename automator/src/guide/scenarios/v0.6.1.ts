/*
 * v0.6.1 操作ガイド: v0.6.0 以降の変更（一時タイル・スケールバー・点 ROI・派生シリーズの窓と番号）を、
 * Computed DWI / vMRE プラグイン（合成のデジタルファントム）で見せる。撮影は _cdwiShots.ts（プラグインのガイドと共有）。
 * 撮る画面だけを名前で絞る。
 */
import path from "node:path";

import { AUTOMATOR_ROOT } from "../../fixtures/manifest.js";
import type { Scenario } from "../run.js";
import { captureCdwiGuide } from "./_cdwiShots.js";

/** v0.6.1 のガイドに載せる画面（撮影の名前）。 */
const WANT = ["tiles-vmre", "save-confirm", "saved-list", "saved-adc"];

const scenario: Scenario = async ({ shot }) => {
  const r = await captureCdwiGuide(shot, new Set(WANT), path.join(AUTOMATOR_ROOT, ".results", "guide-v0.6.1"));
  console.log(`撮れた: ${r.captured.join(", ")}`);
  if (r.failed.length > 0) console.log(`🔴 撮れなかった（ガイドに載せない）:\n  ${r.failed.join("\n  ")}`);
};
export default scenario;
