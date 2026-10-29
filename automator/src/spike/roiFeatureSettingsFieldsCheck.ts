/*
 * ROI 特徴量の設定欄（ROI 特徴量の画面・一括抽出ダイアログ）の data-testid の集合と見出しの文言の回帰スパイク。
 * 共通の部品に載せ替えても、欄の集合・文言・並びが変わらないことを、実アプリの画面で確かめる。
 *
 * 実行:  cd automator && GRAPHY_AUTOMATOR_HTTP_PORT=18290 GRAPHY_AUTOMATOR_SCP_PORT=18291 \
 *          GRAPHY_AUTOMATOR_VITE_PORT=18293 timeout 600 npx tsx src/spike/roiFeatureSettingsFieldsCheck.ts
 *   既定: roiFeatureSettingsFieldsExpected.json（載せ替え前の画面から得た一覧）と突き合わせる。
 *   SETTINGS_FIELDS_DUMP=<出力先.json> を付けると、比較せずに今の画面の一覧を書き出す（期待値を作り直すとき用）。
 *
 * 取る状態（それぞれ testid の並びと、設定欄の表示文字列の行）:
 *   screen-default / screen-iso / screen-radius（ROI 特徴量の画面。リサンプリングを等方に、フィルタを半径指定に）
 *   batch-default / batch-iso（一括抽出ダイアログの設定欄）
 */
import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "roi-feature-settings-fields-check");
const EXPECTED = path.join(import.meta.dirname, "roiFeatureSettingsFieldsExpected.json");

const failures: string[] = [];
let passed = 0;
function check(cond: boolean, label: string, detail?: unknown): void {
  if (cond) {
    passed++;
    console.log(`  [ok  ] ${label}`);
  } else {
    console.log(`  [FAIL] ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
    failures.push(label);
  }
}

interface Snapshot { testids: string[]; lines: string[] }

/** root の中の data-testid（出現順）と、表示文字列の行（空行を除く）。 */
async function snapshot(page: Page, rootSelector: string): Promise<Snapshot> {
  return page.locator(rootSelector).first().evaluate((el) => ({
    testids: Array.from(el.querySelectorAll("[data-testid]")).map((e) => e.getAttribute("data-testid") ?? ""),
    lines: (el as HTMLElement).innerText.split("\n").map((s) => s.trim()).filter(Boolean),
  }));
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const d = new DesktopDriver();
  await d.start();
  const base = `http://127.0.0.1:${d.ports.http}`;
  const got: Record<string, Snapshot> = {};
  try {
    console.log(`  reset: ${JSON.stringify(await resetDb(d.ports.http))}`);
    const page = d.page;
    page.on("console", (m) => {
      if (m.type() === "error") console.log(`  [renderer error] ${m.text()}`);
    });
    await page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    await page.waitForTimeout(2000);
    const later = page.getByRole("button", { name: /^(後で|Later)$/ });
    if (await later.isVisible().catch(() => false)) {
      await later.click();
      await page.waitForTimeout(500);
    }
    await page.evaluate("localStorage.setItem('graphy.locale', 'ja')");
    await page.reload();
    await page.getByTestId("album-select").waitFor({ state: "visible", timeout: 60_000 });

    console.log("\n[1] ROI 特徴量の画面（文脈なしで開く）");
    await page.evaluate("window.location.hash = 'radiomics-features'");
    await page.getByTestId("roifeat-bincount").waitFor({ state: "visible", timeout: 20_000 });
    got["screen-default"] = await snapshot(page, "body");
    await page.screenshot({ path: path.join(OUT_DIR, "01-screen-default.png"), fullPage: true });
    await page.getByTestId("roifeat-resampling").selectOption("iso");
    await page.waitForTimeout(300);
    got["screen-iso"] = await snapshot(page, "body");
    await page.getByTestId("roifeat-filter-radius").check();
    await page.waitForTimeout(300);
    got["screen-radius"] = await snapshot(page, "body");
    await page.screenshot({ path: path.join(OUT_DIR, "02-screen-radius.png"), fullPage: true });

    console.log("\n[2] 一括抽出ダイアログの設定欄");
    await page.evaluate("window.location.hash = ''");
    await page.reload();
    await page.getByTestId("album-select").waitFor({ state: "visible", timeout: 60_000 });
    const resp = await fetch(`${base}/api/albums`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: `settings-fields-${Date.now()}` }),
    });
    const album = (await resp.json()) as { id: number };
    await page.reload();
    await page.getByTestId("album-select").waitFor({ state: "visible", timeout: 60_000 });
    await page.getByTestId("album-select").selectOption(String(album.id));
    await page.waitForTimeout(800);
    await page.getByTestId("album-batch-button").click();
    await page.getByTestId("batch-settings").waitFor({ state: "visible", timeout: 30_000 });
    got["batch-default"] = await snapshot(page, '[data-testid="batch-settings"]');
    await page.screenshot({ path: path.join(OUT_DIR, "03-batch-default.png"), fullPage: true });
    await page.getByTestId("batch-resampling").selectOption("iso");
    await page.waitForTimeout(300);
    got["batch-iso"] = await snapshot(page, '[data-testid="batch-settings"]');
    await page.screenshot({ path: path.join(OUT_DIR, "04-batch-iso.png"), fullPage: true });

    const dump = process.env.SETTINGS_FIELDS_DUMP;
    if (dump) {
      fs.writeFileSync(dump, JSON.stringify(got, null, 2) + "\n");
      console.log(`\n  dump: ${dump}（比較はしない）`);
      return;
    }

    console.log("\n[3] 期待値（載せ替え前の一覧 + 段 1 で足す 3 つ）との突き合わせ");
    const expected = JSON.parse(fs.readFileSync(EXPECTED, "utf8")) as Record<string, Snapshot>;
    check(Object.keys(expected).length === 5, "期待値は 5 状態", Object.keys(expected));
    for (const key of Object.keys(expected)) {
      const g = got[key];
      const e = expected[key];
      check(!!g && g.testids.length > 0, `${key}: 欄が実在する（空でない）`, g?.testids.length);
      if (!g) continue;
      const missing = e.testids.filter((t) => !g.testids.includes(t));
      const extra = g.testids.filter((t) => !e.testids.includes(t));
      check(missing.length === 0 && extra.length === 0, `${key}: data-testid の集合が一致`, { missing, extra });
      check(g.testids.join("|") === e.testids.join("|"), `${key}: data-testid の並びが一致`);
      const lineDiff = e.lines.filter((l, i) => g.lines[i] !== l);
      check(g.lines.length === e.lines.length && lineDiff.length === 0, `${key}: 表示文字列の行（見出し・選択肢・注記）が一致`,
        { expected: e.lines.length, got: g.lines.length, diff: lineDiff.slice(0, 5) });
    }
  } finally {
    await d.stop();
  }
}

main()
  .then(() => {
    console.log(`\n結果: 合格 ${passed} / 失敗 ${failures.length}`);
    if (failures.length) {
      for (const f of failures) console.log(`  FAIL: ${f}`);
      process.exit(1);
    }
  })
  .catch((e) => {
    console.error(e);
    process.exit(2);
  });
