import type { Page } from "@playwright/test";
import type { StepRecorder } from "../../types.js";

/**
 * MainScreen の React マウントが完了していることを検地する（driver.start() 直後や reload 直後は
 * `domcontentloaded` が発火していても React が未マウントのことがあり、そこで reload/操作すると
 * 白紙のまま固まる罠を実機で踏んだ。「実際に触れる要素が出るまで待つ」に統一する）。
 */
export async function waitForMainScreenReady(page: Page, timeoutMs = 20_000): Promise<void> {
  await page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: timeoutMs });
}

/**
 * MainScreen で無条件検索 → 先頭スタディ → 先頭シリーズの順にクリックし、series-viewer-root の
 * 表示（＝Viewer2D マウント）まで待つ。`10-viewer2d-core.item-07` で確立した手順の共通化。
 */
export async function openFirstSeriesInViewer(page: Page, recorder: StepRecorder): Promise<void> {
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
}
