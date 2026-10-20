/*
 * 設定＞描画環境＞描画の自己診断の実機検証。
 *
 * 実行:  cd automator && npx tsx src/spike/selfTestCheck.ts
 *
 * 何を確かめるか（本物の Electron）:
 *   1. 🧪 のカテゴリは「描画環境」1 つだけで、その中に自己診断の節がある
 *   2. 「診断を実行」で 5 行が pass / fail / pending のどれかになる（数を分けて出す）
 *   3. 3D 描画・左右の向き・画素間隔・距離比が合格する
 *   4. ハードウェア支援の行が、描画環境の表の「描画の種類」と対応する（hardware→合格・software→失敗・unknown→未実施）
 *   5. 描画環境の「結果をコピー」の JSON に selfTest（版・GPU 名・5 行以上）が入る
 *   読み返し画像の縮小はスクリーンショットで目視確認する（目印が右に見えること）。
 */
import fs from "node:fs";
import path from "node:path";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "self-test-check");
const ROWS = ["render", "orientation", "spacing", "distance", "hardware"];
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
    check((await page.getByTestId("settings-cat-selftest").count()) === 0, "自己診断の別カテゴリは無い");
    check((await page.getByTestId("settings-cat-renderEnv").count()) === 1, "描画環境のカテゴリがある");
    await page.getByTestId("settings-cat-renderEnv").click();
    await page.getByTestId("renderenv-panel").waitFor({ state: "visible", timeout: 15_000 });
    check((await page.getByTestId("selftest-run").count()) === 1, "描画環境の中に「診断を実行」がある");
    const kind = (await page.getByTestId("renderenv-row-kind").getAttribute("data-kind")) ?? "";
    console.log(`  描画の種類（描画環境の表）: ${kind}`);

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
    for (const id of ["render", "orientation", "spacing", "distance"]) check(status[id] === "pass", `${id} が合格`, status[id]);
    const expectHw = kind === "hardware" ? "pass" : kind === "software" ? "fail" : "pending";
    check(status.hardware === expectHw, `ハードウェア支援が描画の種類（${kind}）と対応する`, { got: status.hardware, expectHw });
    await page.getByTestId("selftest-preview").scrollIntoViewIfNeeded();
    await page.getByTestId("settings-dialog").screenshot({ path: path.join(OUT_DIR, "1-result.png") });

    console.log("\n[3] 結果をコピー");
    await driver.app.evaluate(({ clipboard }) => clipboard.clear());
    await page.getByTestId("renderenv-copy").click();
    await page.waitForTimeout(500);
    const text = await driver.app.evaluate(({ clipboard }) => clipboard.readText());
    let json: { kind?: string; selfTest?: { version?: string; gpu?: string; rows?: { id: string }[] } } = {};
    try {
      json = JSON.parse(text);
    } catch {
      /* check で落とす */
    }
    check(json.kind === kind, "JSON に描画環境の要約が入る", json.kind);
    const st = json.selfTest;
    const rowsJ = (st?.rows ?? []) as { id: string; status?: string; values?: Record<string, number> }[];
    for (const r of rowsJ) console.log(`  ${r.id} ${r.status} ${JSON.stringify(r.values ?? {})}`);
    // 許容幅（2/s ≈ 4%）より厳しく見る: 平行投影と半値幅で、実機では 0.1% 未満のずれだった
    for (const id of ["spacing", "distance"]) {
      const d = rowsJ.find((r) => r.id === id)?.values?.relDiff;
      check(typeof d === "number" && d < 0.01, `${id} の相対差が 1% 未満`, d);
    }
    check(!!st && Array.isArray(st.rows) && ROWS.every((id) => st.rows!.some((r) => r.id === id)), "JSON の selfTest に 5 行が入る", text.slice(0, 120));
    check(!!st && typeof st.version === "string" && !!st.gpu, "JSON の selfTest に版と GPU 名（不明含む）が入る", { v: st?.version, g: st?.gpu });
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
