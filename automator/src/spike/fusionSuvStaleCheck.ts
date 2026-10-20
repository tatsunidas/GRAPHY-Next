/*
 * Fusion の前景値が、SUV 校正の付与・解除に追従するかの実機検証（Chromium＋実 backend＋合成ファントム）。
 * 以前は、前景スライスのキャッシュに校正（SUV 乗数）を焼き込み、再構成も校正の変更で走らなかったため、
 * Fusion を開いたまま校正しても状態バーの前景値が古いままだった。
 *
 * 実行:  cd automator && npx tsx src/spike/fusionSuvStaleCheck.ts
 *        （ファントムの生成に pydicom のある Python が要る: GRAPHY_TEST_PYTHON、既定は python）
 * 校正はアプリ自身の SUV ストア（suvStore の setSuv）を、ページ内からモジュールとして import して叩く。
 * 校正ダイアログの UI は操作していない（ダイアログは setSuv を呼ぶだけ）。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";

import { resetDb } from "../backend/dbReset.js";
import { WebDriver } from "../driver/webDriver.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { createChecker } from "./computeSpikeShared.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "fusion-suv-stale-check");
const PHANTOM_DIR = path.join(OUT_DIR, "phantom");
const SUV_SCALE = 3;
const { check, summary } = createChecker();

async function setSuv(p: Page, uid: string, scale: number | null): Promise<void> {
  const cal = scale === null ? "null" : `{ scale: ${scale}, unit: "SUVbw", type: "bw" }`;
  await p.evaluate(`import("/src/viewer/suvStore.ts").then((m) => m.setSuv(${JSON.stringify(uid)}, ${cal}))`);
}

/** カーソルを動かして、状態バーの前景値の文字列を読む（値はカーソル移動のときに引き直される）。 */
async function fgValue(p: Page, x: number, y: number): Promise<{ text: string; num: number }> {
  await p.mouse.move(x + 7, y + 7);
  await p.mouse.move(x, y);
  await p.waitForTimeout(500);
  const text = (await p.getByTestId("status-value-fg").first().innerText()).trim();
  return { text, num: parseFloat(text) };
}

async function main(): Promise<void> {
  fs.rmSync(PHANTOM_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const py = process.env.GRAPHY_TEST_PYTHON ?? "python";
  const gen = spawnSync(py, [path.join(AUTOMATOR_ROOT, "scripts", "make-fusion-isoline-phantom.py"), PHANTOM_DIR], { encoding: "utf8" });
  if (gen.status !== 0) throw new Error(`ファントムを作れませんでした: ${gen.stderr}`);
  const truth = JSON.parse(fs.readFileSync(path.join(PHANTOM_DIR, "truth.json"), "utf8"));
  const ptUid: string = truth.pt_series_uid;

  const d = new WebDriver({ http: 18620, scp: 18621, vite: 18623 }, { viewport: { width: 1400, height: 900 }, locale: "ja-JP" });
  await d.start();
  try {
    await resetDb(d.ports.http);
    console.log(`  import: ${JSON.stringify(await importPaths(d.ports.http, [PHANTOM_DIR])).slice(0, 120)}`);
    await d.page.reload();
    await d.page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 30_000 });
    await d.page.getByTestId("search-allperiod-chip").click();
    await d.page.getByTestId("search-submit-button").click();
    await d.page.locator('[data-testid^="study-row-"]').first().click();
    await d.page.locator('[data-testid^="series-row-"]').filter({ hasText: /CT/ }).first().click();
    await d.page.waitForTimeout(2500);
    const v = await d.waitForNewPage(() => d.page.getByTestId("viewer2d-toolbar-button").click(), () => true, 30_000);
    await v.setViewportSize({ width: 1400, height: 900 });
    await v.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 30_000 });
    await v.waitForTimeout(3000);
    const tile = v.getByTestId("series-viewer-root").first();
    const box = (await tile.boundingBox())!;
    await v.getByText(/PT foreground/).first().dragTo(tile, { targetPosition: { x: box.width / 2, y: box.height / 2 } });
    await v.waitForTimeout(4000);
    // 中央のスライス（z = 0）へ。
    await v.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < 12; i++) { await v.mouse.wheel(0, -100); await v.waitForTimeout(80); }
    for (let i = 0; i < 4; i++) { await v.mouse.wheel(0, 100); await v.waitForTimeout(250); }
    await v.waitForTimeout(1500);
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

    console.log("\n[1] 校正なし");
    const v0 = await fgValue(v, cx, cy);
    console.log(`  前景値: ${v0.text}`);
    check(Number.isFinite(v0.num) && v0.num > 0, "前景値が読める", v0.text);
    check(/BQML/i.test(v0.text), "単位は BQML", v0.text);

    console.log("\n[2] Fusion を開いたまま SUV 校正を付ける（乗数 3）");
    await setSuv(v, ptUid, SUV_SCALE);
    await v.waitForTimeout(2500);
    const v1 = await fgValue(v, cx, cy);
    console.log(`  前景値: ${v1.text}`);
    check(/SUV/i.test(v1.text), "単位が SUVbw に変わる", v1.text);
    check(Math.abs(v1.num / v0.num - SUV_SCALE) < 0.02 * SUV_SCALE, `値が乗数の ${SUV_SCALE} 倍になる（SUV 乗数が 1 回だけ掛かる）`, { v0: v0.num, v1: v1.num });

    console.log("\n[3] 校正を解除する");
    await setSuv(v, ptUid, null);
    await v.waitForTimeout(2500);
    const v2 = await fgValue(v, cx, cy);
    console.log(`  前景値: ${v2.text}`);
    check(/BQML/i.test(v2.text), "単位が BQML に戻る", v2.text);
    check(Math.abs(v2.num - v0.num) < 0.005 * v0.num, "値が校正前に戻る", { v0: v0.num, v2: v2.num });
    await v.screenshot({ path: path.join(OUT_DIR, "3-after-clear.png") });
  } finally {
    await d.stop();
  }
}

main()
  .then(() => process.exit(summary() === 0 ? 0 : 1))
  .catch((e) => {
    console.error(e);
    process.exit(2);
  });
