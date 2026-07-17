import type { ChecklistItem } from "../../types.js";
import { openFirstSeriesInViewer } from "./helpers.js";

interface ViewportProperties {
  viewportId: string;
  colormapName: string | null;
  windowLevel: { center: number; width: number } | null;
}
interface GraphyDebugWindow {
  __graphyDebug?: { getViewportProperties(): ViewportProperties[] };
}

async function readViewportProperties(ctx: { driver: { page: import("@playwright/test").Page } }) {
  return ctx.driver.page.evaluate(
    () => (window as unknown as GraphyDebugWindow).__graphyDebug?.getViewportProperties() ?? [],
  );
}

export const lutItems: ChecklistItem[] = [
  {
    id: "11-lut.item-01",
    title: "LUTダイアログから106種のLUTを選択・即時適用できる",
    category: "11-lut",
    modes: ["desktop", "web"],
    requiresHuman: false,
    dependsOnFixtures: ["ct-basic"],
    async run(ctx) {
      const { driver, recorder } = ctx;
      const page = driver.page;
      await openFirstSeriesInViewer(page, recorder);

      await page.getByTestId("viewer-lut-button").click();
      const dialog = page.getByTestId("lut-dialog");
      await dialog.waitFor({ state: "visible", timeout: 10_000 });
      recorder.step("LUTダイアログを表示");

      const lutRow = page.locator('[data-lut]:not([data-lut="__gray__"])').first();
      await lutRow.waitFor({ state: "visible", timeout: 15_000 });
      const lutName = await lutRow.getAttribute("data-lut");
      if (!lutName) {
        return { status: "fail" as const, error: "LUT一覧から選択可能な data-lut が見つかりませんでした" };
      }
      await lutRow.click();
      recorder.step(`LUT行を選択: ${lutName}`);

      await page.getByTestId("lut-apply-button").click();
      await dialog.waitFor({ state: "hidden", timeout: 10_000 });
      recorder.step("Applyでダイアログを閉じ、LUTを適用");

      // colormap登録・render の反映猶予。
      await page.waitForTimeout(500);
      const props = await readViewportProperties(ctx);
      recorder.step("window.__graphyDebug.getViewportProperties() を評価", { props });

      const expected = `graphy-lut-${lutName}`;
      const applied = props.some((p) => p.colormapName === expected);
      if (!applied) {
        return {
          status: "fail" as const,
          error: `適用後の colormapName が期待値と一致しません: expected=${expected}, actual=${JSON.stringify(props)}`,
        };
      }
      return { status: "pass" as const, notes: `適用LUT=${lutName}` };
    },
  },
  {
    id: "11-lut.item-02",
    title: "グレースケールへのリセットができる",
    category: "11-lut",
    modes: ["desktop", "web"],
    requiresHuman: false,
    dependsOnFixtures: ["ct-basic"],
    async run(ctx) {
      const { driver, recorder } = ctx;
      const page = driver.page;
      await openFirstSeriesInViewer(page, recorder);

      // まず非グレースケールのLUTを適用し、リセットが実際に状態を変えることを確認できるようにする。
      await page.getByTestId("viewer-lut-button").click();
      const dialog = page.getByTestId("lut-dialog");
      await dialog.waitFor({ state: "visible", timeout: 10_000 });
      const lutRow = page.locator('[data-lut]:not([data-lut="__gray__"])').first();
      await lutRow.waitFor({ state: "visible", timeout: 15_000 });
      await lutRow.click();
      await page.getByTestId("lut-apply-button").click();
      await dialog.waitFor({ state: "hidden", timeout: 10_000 });
      await page.waitForTimeout(500);
      recorder.step("事前準備: 非グレースケールLUTを適用");

      // グレースケール（リセット）行を選んでリセットする。
      await page.getByTestId("viewer-lut-button").click();
      await dialog.waitFor({ state: "visible", timeout: 10_000 });
      const grayRow = page.locator('[data-lut="__gray__"]');
      await grayRow.waitFor({ state: "visible", timeout: 10_000 });
      await grayRow.click();
      recorder.step("グレースケール（リセット）行を選択");

      await page.getByTestId("lut-apply-button").click();
      await dialog.waitFor({ state: "hidden", timeout: 10_000 });
      recorder.step("Applyでダイアログを閉じ、グレースケールへリセット");

      await page.waitForTimeout(500);
      const props = await readViewportProperties(ctx);
      recorder.step("window.__graphyDebug.getViewportProperties() を評価", { props });

      const reset = props.some((p) => p.colormapName === "graphy-gray");
      if (!reset) {
        return {
          status: "fail" as const,
          error: `リセット後の colormapName が graphy-gray ではありません: ${JSON.stringify(props)}`,
        };
      }
      return { status: "pass" as const };
    },
  },
];
