import type { Page } from "@playwright/test";

/**
 * MainScreen の React マウントが完了していることを検地する（driver.start() 直後や reload 直後は
 * `domcontentloaded` が発火していても React が未マウントのことがあり、そこで reload/操作すると
 * 白紙のまま固まる罠を実機で踏んだ。「実際に触れる要素が出るまで待つ」に統一する）。
 */
export async function waitForMainScreenReady(page: Page, timeoutMs = 20_000): Promise<void> {
  await page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: timeoutMs });
}
