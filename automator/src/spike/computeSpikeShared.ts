/*
 * 外部の計算機（fw/remote-compute-design.md）の実機検証で共有する部品。
 * computeRunJobCheck（ローカルの Jupyter）と computeColabCheck（Google Colab）が使う。
 */
import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";

import type { DesktopDriver } from "../driver/desktopDriver.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";

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

// ── 幾何検証（geom*Check.ts）の終わり方の統一 ──
// 失敗 > 0 または例外 → 終了コード 1、それ以外 0。未達は終了コードに入れず、標準出力と結果 JSON に出す。

export const GEOM_RESULTS_DIR = path.join(AUTOMATOR_ROOT, ".results", "geom-verify");

export interface GeomSummaryOpts {
  /** 検査名（Roi・Mask・Export・Calib・Radiomics・Mpr・XaSeed・XaIo）。結果 JSON のファイル名。 */
  name: string;
  passed: number;
  failures: string[];
  unreached: string[];
  /** 参考（情報）の件数。合否にも未達にも入れない。 */
  info?: number;
  /** 負例の実行（落ちることが合格）。結果 JSON は書かない。 */
  neg?: boolean;
}

function writeGeomResult(name: string, body: Record<string, unknown>): void {
  fs.mkdirSync(GEOM_RESULTS_DIR, { recursive: true });
  fs.writeFileSync(path.join(GEOM_RESULTS_DIR, `${name}.json`), JSON.stringify(body, null, 1));
}

/** 集計を出して終了コード（process.exitCode）を決め、結果 JSON を書く。 */
export function exitWithSummary(o: GeomSummaryOpts): number {
  const nFail = o.failures.length;
  console.log(`\n[geom-verify:${o.name}] 合格 ${o.passed} / 失敗 ${nFail} / 未達 ${o.unreached.length}${o.info ? ` / 参考 ${o.info}` : ""}`);
  if (o.neg) {
    // 負例では「落ちること」が合格。
    process.exitCode = nFail > 0 ? 0 : 1;
    return process.exitCode;
  }
  const code = nFail > 0 ? 1 : 0;
  writeGeomResult(o.name, {
    name: o.name, passed: o.passed, failed: nFail, unreached: o.unreached.length, info: o.info ?? 0,
    failures: o.failures, unreachedNames: o.unreached, exitCode: code, finishedAt: new Date().toISOString(),
  });
  process.exitCode = code;
  return code;
}

/** 例外で終わるとき: 結果 JSON に error を残し、終了コード 1。 */
export function exitWithGeomError(name: string, e: unknown): never {
  console.error(e);
  try {
    writeGeomResult(name, {
      name, error: String((e as Error)?.stack ?? e).slice(0, 2000), exitCode: 1, finishedAt: new Date().toISOString(),
    });
  } catch (w) {
    console.error(w);
  }
  process.exit(1);
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

/**
 * 2D ビューアの「解析」メニューからプラグインを起動する。`category: "ai"` のプラグインは
 * 「解析 ＞ AI ▸」の中に、それ以外は解析メニューに平置きで出る（fw/plugin-architecture.md）。
 */
export async function openAnalysisPlugin(viewer: Page, pluginId: string): Promise<void> {
  await viewer.getByTestId("viewer2d-menu-analysis").click();
  const flat = viewer.getByTestId(`plugin-analysis-item-${pluginId}`);
  if ((await flat.count()) > 0) {
    await flat.click();
    return;
  }
  await viewer.getByTestId("viewer2d-menu-ai").hover();
  await viewer.getByTestId(`plugin-ai-item-${pluginId}`).click();
}
