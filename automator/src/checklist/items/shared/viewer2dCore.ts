import type { ChecklistItem } from "../../types.js";
import { waitForMainScreenReady } from "./helpers.js";

interface PixelStats {
  viewportId: string;
  nonBlackFraction: number;
}
interface GraphyDebugWindow {
  __graphyDebug?: { getPixelStats(): PixelStats[] };
}

export const viewer2dCoreItems: ChecklistItem[] = [
  {
    id: "10-viewer2d-core.item-07",
    title: "シリーズを開くと画像（非ブランク）が描画される（土台検証）",
    category: "10-viewer2d-core",
    modes: ["desktop", "web"],
    requiresHuman: false,
    dependsOnFixtures: ["ct-basic"],
    async run(ctx) {
      const { driver, recorder } = ctx;
      const page = driver.page;
      await waitForMainScreenReady(page);
      recorder.step("MainScreen の初期マウントを確認");

      page.once("dialog", (d) => void d.accept());
      const dateInputs = page.locator('input[type="date"]');
      await dateInputs.nth(0).fill("");
      await dateInputs.nth(1).fill("");
      await page.getByTestId("search-submit-button").click();
      recorder.step("無条件検索でスタディ一覧を取得");

      const studyRow = page.locator('[data-testid^="study-row-"]').first();
      await studyRow.waitFor({ state: "visible", timeout: 15_000 });
      await studyRow.click();
      recorder.step("先頭のスタディ行をクリック");

      const seriesRow = page.locator('[data-testid^="series-row-"]').first();
      await seriesRow.waitFor({ state: "visible", timeout: 15_000 });
      await seriesRow.click();
      recorder.step("先頭のシリーズ行をクリック");

      const viewerRoot = page.getByTestId("series-viewer-root");
      await viewerRoot.waitFor({ state: "visible", timeout: 15_000 });
      recorder.step("series-viewer-root の表示を確認");

      // cornerstone のレンダリング完了を待つ（初期ロード猶予）。
      await page.waitForTimeout(1500);

      const stats = await page.evaluate(() => (window as unknown as GraphyDebugWindow).__graphyDebug?.getPixelStats() ?? []);
      recorder.step("window.__graphyDebug.getPixelStats() を評価", { stats });

      const rendered = stats.some((s) => s.nonBlackFraction > 0.01);
      if (!rendered) {
        return { status: "fail" as const, error: `非黒ピクセルの割合が閾値未満です: ${JSON.stringify(stats)}` };
      }
      return { status: "pass" as const, notes: `viewports=${stats.length}` };
    },
  },
];
