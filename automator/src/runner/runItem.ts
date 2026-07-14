import fs from "node:fs";
import path from "node:path";
import type { ChecklistItem, ItemResult, RunContext } from "../checklist/types.js";
import { createStepRecorder } from "../checklist/types.js";
import type { Driver } from "../driver/types.js";
import { requireFixtures } from "../fixtures/checkFixtures.js";
import { newRunId, runDir, saveRunResult } from "./resultsStore.js";
import { recordResult } from "./recorder.js";

export interface RunItemOptions {
  driver: Driver;
  /** false のとき checklist/*.md への書き戻しをスキップする（テスト用途）。既定 true。 */
  record?: boolean;
}

/**
 * 1項目を実行する: fixture 前提を確認 → item.run() → 例外時はスクリーンショット保存 →
 * .results/ に結果を保存 → checklist/<category>.md へ手順ログを書き戻す。
 */
export async function runItem(item: ChecklistItem, opts: RunItemOptions): Promise<ItemResult> {
  const runId = newRunId();
  const recorder = createStepRecorder();
  const ctx: RunContext = {
    driver: opts.driver,
    recorder,
    screenshot: async (page, label) => {
      const dir = runDir(runId, item.id);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${label}.png`);
      await page.screenshot({ path: file });
      return file;
    },
  };

  let result: ItemResult;
  try {
    if (item.dependsOnFixtures?.length) {
      requireFixtures(item.dependsOnFixtures);
    }
    result = await item.run(ctx);
  } catch (e) {
    let screenshotPath: string | undefined;
    try {
      screenshotPath = await ctx.screenshot(opts.driver.page, "failure");
    } catch {
      // メイン Page が既に閉じている等、証跡が取れない場合は無しで続行
    }
    result = { status: "fail", error: e instanceof Error ? e.message : String(e), screenshotPath };
  }

  saveRunResult({ runId, itemId: item.id, mode: opts.driver.mode, timestamp: new Date().toISOString(), result, steps: recorder.steps });
  if (opts.record !== false) {
    recordResult(item, opts.driver.mode, runId, result, recorder.steps);
  }
  return result;
}
