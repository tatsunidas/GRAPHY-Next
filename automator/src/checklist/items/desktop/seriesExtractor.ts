import fs from "node:fs";
import path from "node:path";
import type { ChecklistItem } from "../../types.js";
import { selectFirstStudy } from "../shared/helpers.js";
import { AUTOMATOR_ROOT } from "../../../fixtures/manifest.js";
import { waitForAnyFile } from "../../../common/waitForFile.js";

export const seriesExtractorItems: ChecklistItem[] = [
  {
    id: "08-tag-extractor-viewer-series-extractor.item-03",
    title: "SeriesExtractor: 条件（Include/Exclude・平面）で一致シリーズをフォルダコピー/ZIP抽出",
    category: "08-tag-extractor-viewer-series-extractor",
    // standalone専用のネイティブフォルダ選択(pickDirectory IPC)をモックする必要があるためdesktopのみ。
    modes: ["desktop"],
    requiresHuman: false,
    dependsOnFixtures: ["ct-basic"],
    async run(ctx) {
      const { driver, recorder } = ctx;
      const page = driver.page;
      await selectFirstStudy(page, recorder);

      const destDir = path.join(AUTOMATOR_ROOT, ".results", `series-extract-out-${Date.now()}`);
      fs.mkdirSync(destDir, { recursive: true });
      if (!driver.mockNativeDirectoryPicker) {
        return { status: "fail" as const, error: "driver.mockNativeDirectoryPicker が利用できません（desktop driver専用機能）" };
      }
      await driver.mockNativeDirectoryPicker(destDir);
      recorder.step("ネイティブフォルダ選択ダイアログをモック", { destDir });

      await page.getByTestId("toolbar-series-extractor-btn").click();
      const dialog = page.getByTestId("series-extractor-dialog");
      await dialog.waitFor({ state: "visible", timeout: 10_000 });
      recorder.step("SeriesExtractorダイアログを開く");

      // 条件なし（全シリーズ一致）でVerify。
      await page.getByTestId("series-extractor-verify-btn").click();
      const table = page.getByTestId("series-extractor-result-table");
      await table.waitFor({ state: "visible", timeout: 15_000 });
      const matchedCount = await table.locator("tbody tr").count();
      recorder.step("条件なしでVerifyし、一致シリーズ数を確認", { matchedCount });
      if (matchedCount < 1) {
        return { status: "fail" as const, error: "Verifyで一致するシリーズがありませんでした" };
      }

      await page.getByTestId("series-extractor-pick-dest-btn").click();
      await page.getByTestId("series-extractor-dest-label").filter({ hasText: destDir }).waitFor({ state: "visible", timeout: 5_000 });
      recorder.step("モックしたフォルダを出力先として選択");

      await page.getByTestId("series-extractor-extract-btn").click();
      recorder.step("コピー実行（standalone: 親フォルダへコピー）");

      const filesAppeared = await waitForAnyFile(destDir);
      recorder.step("出力先フォルダにファイルが現れるのを確認", { filesAppeared, destDir });

      if (!filesAppeared) {
        return { status: "fail" as const, error: `出力先フォルダ ${destDir} にファイルが生成されませんでした` };
      }
      return { status: "pass" as const, notes: `${matchedCount}シリーズを ${destDir} へコピー` };
    },
  },
];
