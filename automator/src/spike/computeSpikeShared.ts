/*
 * 外部の計算機（fw/remote-compute-design.md）の実機検証で共有する部品。
 * computeRunJobCheck（ローカルの Jupyter）と computeColabCheck（Google Colab）が使う。
 */
import type { Page } from "@playwright/test";

import type { DesktopDriver } from "../driver/desktopDriver.js";

export const RUNJOB_PLUGIN_ID = "compute-runjob-check";

/** 合否の記録。 */
export function createChecker() {
  const failures: string[] = [];
  let passed = 0;
  return {
    check(cond: boolean, label: string, detail?: unknown): void {
      if (cond) {
        passed++;
        console.log(`  [ok  ] ${label}`);
      } else {
        console.log(`  [FAIL] ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
        failures.push(label);
      }
    },
    summary(): number {
      console.log(`\n${passed} passed, ${failures.length} failed`);
      return failures.length;
    },
  };
}

/** main が描く同意の窓を掴む（匿名化が終わってから開くので待つ）。 */
export async function consentWindow(driver: DesktopDriver, timeoutMs = 60_000): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const win = driver.app.windows().find((w) => w.url().endsWith("computeConsent.html"));
    if (win) {
      await win.waitForFunction(() => (document.getElementById("code")?.textContent ?? "").length > 0);
      return win;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("同意の窓が開きません");
}

/** 同意の窓に出た SHA-256（表全体ではなく SHA の欄だけを読む）。 */
export async function approvedSha(win: Page): Promise<string> {
  return ((await win.locator("#data-body td.mono").first().textContent()) ?? "").trim();
}

/** 検証用プラグイン（compute-runjob-check）を入力つきで起動する。 */
export async function launchRunJobPlugin(page: Page, input: Record<string, string>): Promise<void> {
  await page.evaluate((i) => {
    const w = window as unknown as Record<string, unknown>;
    w.__computeInput = i;
    w.__computeRun = undefined;
  }, input);
  await page.getByTestId("mainscreen-menu-plugins").click();
  await page.getByTestId(`plugin-item-${RUNJOB_PLUGIN_ID}`).click();
}

/** プラグインが window.__computeRun.outcome に結果を置くまで待つ。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function runJobOutcome(page: Page, timeoutMs: number): Promise<any> {
  await page.waitForFunction(
    () => !!(window as unknown as { __computeRun?: { outcome?: unknown } }).__computeRun?.outcome,
    null,
    { timeout: timeoutMs },
  );
  return page.evaluate(() => (window as unknown as { __computeRun: unknown }).__computeRun);
}
