/*
 * Computed DWI / vMRE プラグイン v1.0.0 の操作ガイド。撮影は _cdwiShots.ts（本体 v0.6.1 のガイドと共有）。
 * 成果物はプラグインのリポジトリに置く: GRAPHY_GUIDE_OUT=<プラグインの docs/guide> で実行する。
 *   cd automator && GRAPHY_GUIDE_OUT=../../graphy-next-plugin-computed-dwi/docs/guide GRAPHY_GUIDE_DATA=<任意の小さなフォルダ> \
 *     npm run guide -- computed-dwi-v1.0.0
 */
import path from "node:path";

import { AUTOMATOR_ROOT } from "../../fixtures/manifest.js";
import type { Scenario } from "../run.js";
import { captureCdwiGuide } from "./_cdwiShots.js";

const ALL = ["menu", "panel-input", "panel-cdwi", "tiles-cdwi", "panel-vmre-real", "panel-vmre-error", "tiles-vmre", "panel-decay", "tiles-roi", "panel-stats", "save-confirm", "saved-list", "saved-adc", "panel-vmre-mixed"];

const scenario: Scenario = async ({ shot }) => {
  const r = await captureCdwiGuide(shot, new Set(ALL), path.join(AUTOMATOR_ROOT, ".results", "guide-computed-dwi-v1.0.0"));
  console.log(`撮れた: ${r.captured.join(", ")}`);
  if (r.failed.length > 0) console.log(`🔴 撮れなかった（ガイドに載せない）:\n  ${r.failed.join("\n  ")}`);
};
export default scenario;
