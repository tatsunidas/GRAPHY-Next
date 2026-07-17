import type { ChecklistItem } from "../../types.js";
import { selectFirstStudy, openFirstSeriesInViewer } from "./helpers.js";

export const tagToolsItems: ChecklistItem[] = [
  {
    id: "08-tag-extractor-viewer-series-extractor.item-01",
    title: "TagExtractor: タグ/シーケンス(パス)/Privateを指定して検索リスト全体をCSV/テーブル抽出",
    category: "08-tag-extractor-viewer-series-extractor",
    modes: ["desktop", "web"],
    requiresHuman: false,
    dependsOnFixtures: ["ct-basic"],
    async run(ctx) {
      const { driver, recorder } = ctx;
      const page = driver.page;
      await selectFirstStudy(page, recorder);

      await page.getByTestId("toolbar-tag-extractor-btn").click();
      const dialog = page.getByTestId("tag-extractor-dialog");
      await dialog.waitFor({ state: "visible", timeout: 10_000 });
      recorder.step("TagExtractorダイアログを開く");

      // PatientID プリセットを選択済みタグに追加。
      await page.getByTestId("tagext-preset-00100010").click();
      recorder.step("PatientIDタグをプリセットから追加");

      await page.getByTestId("tag-extractor-run-btn").click();
      const table = page.getByTestId("tag-extractor-result-table");
      await table.waitFor({ state: "visible", timeout: 15_000 });
      const rowCount = await table.locator("tbody tr").count();
      recorder.step("抽出結果テーブルの行数を確認", { rowCount });

      if (rowCount < 1) {
        return { status: "fail" as const, error: "抽出結果テーブルに行がありません" };
      }
      return { status: "pass" as const, notes: `PatientIDタグで抽出、${rowCount}行取得` };
    },
  },
  {
    id: "08-tag-extractor-viewer-series-extractor.item-02",
    title: "TagViewer: 現在画像のDICOM属性ダンプ表示（SQネスト・検索ハイライト）",
    category: "08-tag-extractor-viewer-series-extractor",
    modes: ["desktop", "web"],
    requiresHuman: false,
    dependsOnFixtures: ["ct-basic"],
    async run(ctx) {
      const { driver, recorder } = ctx;
      const page = driver.page;
      await openFirstSeriesInViewer(page, recorder);

      await page.getByTestId("toolbar-tag-viewer-btn").click();
      const dialog = page.getByTestId("tag-viewer-dialog");
      await dialog.waitFor({ state: "visible", timeout: 10_000 });
      const table = page.getByTestId("tag-viewer-table");
      await table.waitFor({ state: "visible", timeout: 15_000 });
      const totalRows = await table.locator("tbody tr").count();
      recorder.step("TagViewerダイアログを開き、DICOM属性ダンプの行数を確認", { totalRows });

      await page.getByTestId("tag-viewer-search-input").fill("PatientID");
      await page.waitForTimeout(300);
      const highlighted = await table.locator("tbody tr mark").count();
      recorder.step("PatientIDで検索しハイライト件数を確認", { highlighted });

      if (totalRows < 1) {
        return { status: "fail" as const, error: "DICOM属性ダンプに行がありません" };
      }
      if (highlighted < 1) {
        return { status: "fail" as const, error: "PatientID検索でハイライトされた行がありません" };
      }
      return { status: "pass" as const, notes: `全${totalRows}行、PatientID検索で${highlighted}件ハイライト` };
    },
  },
];
