/*
 * 描画環境の自己診断（設定）の実機検証。設計: fw/self-test-design.md。
 *
 * 実行:  cd automator && npx tsx src/spike/selfTestCheck.ts
 *
 * 何を確かめるか（本物の Electron）:
 *   1. 設定に自己診断カテゴリがある
 *   2. 「診断を実行」で全行が pass / fail / pending のどれかになる（数を分けて出す）
 *   3. 3D 描画・左右の向き・画素間隔・距離比が合格する
 *   4. 「結果をコピー」で JSON がクリップボードに入る
 *   読み返し画像の縮小はスクリーンショットで目視確認する（目印が右に見えること）。
 */
import fs from "node:fs";
import path from "node:path";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "self-test-check");
const ROWS = ["webgl2", "max3dTex", "render", "orientation", "spacing", "distance", "hardware"];
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

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const driver = new DesktopDriver();
  try {
    await driver.start();
    const page = driver.page;
    await page.getByTestId("mainscreen-menu-system").click();
    await page.getByTestId("menu-item-settings").click();
    await page.getByTestId("settings-dialog").waitFor({ state: "visible", timeout: 10_000 });

    console.log("\n[1] カテゴリ");
    check((await page.getByTestId("settings-cat-selftest").count()) === 1, "settings-cat-selftest がある");
    await page.getByTestId("settings-cat-selftest").click();

    console.log("\n[2] 診断を実行");
    await page.getByTestId("selftest-run").click();
    await page.getByTestId("selftest-row-hardware").waitFor({ state: "visible", timeout: 60_000 });
    const counts = { pass: 0, fail: 0, pending: 0 };
    const status: Record<string, string> = {};
    for (const id of ROWS) {
      const s = (await page.getByTestId(`selftest-row-${id}`).getAttribute("data-status")) ?? "";
      status[id] = s;
      if (s === "pass" || s === "fail" || s === "pending") counts[s]++;
      else check(false, `行 ${id} の data-status が不正`, s);
    }
    console.log(`  合格 ${counts.pass} / 失敗 ${counts.fail} / 未実施 ${counts.pending}`);
    check(status.webgl2 === "pass", "WebGL2 が合格", status.webgl2);
    for (const id of ["render", "orientation", "spacing", "distance"]) check(status[id] === "pass", `${id} が合格`, status[id]);
    check(status.hardware === "pending", "ハードウェア支援は未実施（第 2 段）", status.hardware);
    await page.screenshot({ path: path.join(OUT_DIR, "1-result.png") });

    console.log("\n[3] 結果をコピー");
    await driver.app.evaluate(({ clipboard }) => clipboard.clear());
    await page.getByTestId("selftest-copy").click();
    await page.waitForTimeout(500);
    const text = await driver.app.evaluate(({ clipboard }) => clipboard.readText());
    let json: { version?: string; gpu?: string; rows?: { id: string }[] } = {};
    try {
      json = JSON.parse(text);
    } catch {
      /* check で落とす */
    }
    check(Array.isArray(json.rows) && json.rows.length === ROWS.length, "JSON に全行が入る", text.slice(0, 120));
    check(typeof json.version === "string" && !!json.gpu, "JSON に版と GPU 名（不明含む）が入る", { v: json.version, g: json.gpu });
  } finally {
    await driver.stop();
  }
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
