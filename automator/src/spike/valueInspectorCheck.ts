/*
 * 値の点検（ピクセルの時間曲線）の実機検証。合成の動態シリーズ（時相 8 × スライス 10、線形場）を取り込み、
 * 2D ビューアで Probe を置いて 解析 > 値の点検 を開き、各時相の値を解析的な真値 f = A + B·t + G·x と突き合わせる。
 *
 * 実行:  cd automator && npx tsx src/spike/valueInspectorCheck.ts
 *        （ファントムの生成に pydicom のある Python が要る: GRAPHY_TEST_PYTHON、既定は python）
 *        VI_BASELINE=1 を付けると、値の点検には触れず、既存の Probe の座標表示だけ読んで終わる（導入前ビルドの回帰比較用）。
 *
 * 許容は保存値の量子化 slope/2 に、ダイアログが表示する座標・値の丸め（2 桁）を足したもの。
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

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "value-inspector-check");
const PHANTOM_DIR = path.join(OUT_DIR, "phantom");
const HOST = "viewer2d-canvas-host";
const BASELINE = process.env.VI_BASELINE === "1";
const { check, summary } = createChecker();

interface Truth { A: number; B: number; G: number; slope: number; nT: number; nZ: number }

async function pickProbe(page: Page): Promise<void> {
  await page.getByTestId("viewer2d-menu-measure").click();
  await page.getByRole("button", { name: /プローブ|^Probe$/ }).first().click();
  await page.waitForTimeout(250);
}

/** canvas の割合位置を「押して離す」（Probe を置く）。tsx の __name 問題を避けるため文字列で評価する。 */
async function clickCanvas(page: Page, fracX: number, fracY: number): Promise<void> {
  await page.evaluate(`
    (function (a) {
      var host = document.querySelector('[data-testid="${HOST}"]');
      var canvas = host && host.querySelector("canvas");
      if (!canvas) throw new Error("canvas not found");
      var r = canvas.getBoundingClientRect();
      var x = r.left + r.width * a.fx, y = r.top + r.height * a.fy;
      function fire(type, btns) {
        var common = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, buttons: btns };
        canvas.dispatchEvent(new PointerEvent(type, Object.assign({}, common, { pointerId: 1, pointerType: "mouse", isPrimary: true })));
        canvas.dispatchEvent(new MouseEvent(type.replace("pointer", "mouse"), common));
      }
      fire("pointermove", 0); fire("pointerdown", 1); fire("pointerup", 0);
    })(${JSON.stringify({ fx: fracX, fy: fracY })})
  `);
  await page.waitForTimeout(800);
}

async function openInspector(page: Page): Promise<void> {
  await page.getByTestId("viewer2d-menu-analysis").click();
  await page.getByTestId("menu-value-inspector").click();
  await page.getByTestId("value-inspector").waitFor({ state: "visible", timeout: 15_000 });
}

/** ダイアログの点（LPS mm）と、各時相の値（数値化できないものは NaN）を読む。 */
async function readDialog(page: Page, nT: number): Promise<{ lps: number[]; values: number[] }> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const values: number[] = [];
    for (let t = 0; t < nT; t++) {
      const el = page.getByTestId(`vi-value-${t}`);
      values.push((await el.count()) ? parseFloat((await el.innerText()).replace("—", "NaN")) : NaN);
    }
    const ptEl = page.getByTestId("vi-point");
    const txt = (await ptEl.count()) ? await ptEl.innerText() : "";
    const m = /LPS\s+(-?[\d.]+),\s*(-?[\d.]+),\s*(-?[\d.]+)/.exec(txt);
    if (m && values.every((v) => Number.isFinite(v))) return { lps: [Number(m[1]), Number(m[2]), Number(m[3])], values };
    if (Date.now() > deadline) return { lps: m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [], values };
    await page.waitForTimeout(300);
  }
}

async function main(): Promise<void> {
  fs.rmSync(PHANTOM_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const py = process.env.GRAPHY_TEST_PYTHON ?? "python";
  const gen = spawnSync(py, [path.join(AUTOMATOR_ROOT, "scripts", "make-dynamic-phantom.py"), PHANTOM_DIR], { encoding: "utf8" });
  if (gen.status !== 0) throw new Error(`ファントムを作れませんでした: ${gen.stderr}`);
  const truth: Truth = JSON.parse(fs.readFileSync(path.join(PHANTOM_DIR, "truth.json"), "utf8"));
  fs.renameSync(path.join(PHANTOM_DIR, "truth.json"), path.join(OUT_DIR, "truth.json"));
  const f = (x: number, t: number) => truth.A + truth.B * t + truth.G * x;
  // 保存値の量子化 slope/2 ＋ 座標の表示丸め（0.005 mm）× 傾き ＋ 値の表示丸め 0.005 ＋ 余裕の float32 分
  const tol = truth.slope / 2 + truth.G * 0.005 + 0.005 + 1e-3;

  const d = new WebDriver({ http: 18640, scp: 18641, vite: 18643 }, { viewport: { width: 1400, height: 900 }, locale: "ja-JP" });
  await d.start();
  try {
    await resetDb(d.ports.http);
    console.log(`  import: ${JSON.stringify(await importPaths(d.ports.http, [PHANTOM_DIR])).slice(0, 110)}`);
    await d.page.reload();
    await d.page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 30_000 });
    await d.page.getByTestId("search-allperiod-chip").click();
    await d.page.getByTestId("search-submit-button").click();
    await d.page.locator('[data-testid^="study-row-"]').first().click();
    await d.page.locator('[data-testid^="series-row-"]').first().click();
    await d.page.waitForTimeout(2500);
    const v = await d.waitForNewPage(() => d.page.getByTestId("viewer2d-toolbar-button").click(), () => true, 30_000);
    await v.setViewportSize({ width: 1400, height: 900 });
    await v.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 30_000 });
    await v.waitForTimeout(3000);
    v.on("dialog", (dlg) => void dlg.accept());

    if (BASELINE) {
      await pickProbe(v);
      await clickCanvas(v, 0.55, 0.45);
      const lines = await v.evaluate(`Array.from(document.querySelectorAll("svg text, [data-graphy-image-panel] *")).map(function(e){return e.textContent||""}).filter(function(s){return /\\(\\d+/.test(s)}).slice(0,6)`);
      console.log(`  baseline probe text: ${JSON.stringify(lines)}`);
      return;
    }

    console.log("\n[1] Probe が無いときは案内が出て、曲線は出ない（負例）");
    await openInspector(v);
    check((await v.getByTestId("vi-no-probe").count()) === 1, "案内文が出る");
    check((await v.getByTestId("vi-row-0").count()) === 0, "時相の行は出ない");
    await v.getByTestId("vi-close").click();

    console.log("\n[2] Probe を置いて開くと、時相ごとの値が真値と一致する");
    await pickProbe(v);
    await clickCanvas(v, 0.55, 0.45);
    const t0 = Date.now();
    await openInspector(v);
    check((await v.getByTestId("vi-no-probe").count()) === 0, "案内文が消える");
    const r1 = await readDialog(v, truth.nT);
    console.log(`  取得時間（nT=${truth.nT}）: ${Date.now() - t0} ms、LPS ${JSON.stringify(r1.lps)}`);
    check(r1.lps.length === 3, "点の LPS が表示される", r1.lps);
    check((await v.locator('[data-testid^="vi-row-"]').count()) === truth.nT, `行数が時相数（${truth.nT}）に一致する`);
    let worst = 0;
    r1.values.forEach((val, t) => { worst = Math.max(worst, Math.abs(val - f(r1.lps[0], t))); });
    console.log(`  最大の差 ${worst.toFixed(4)}（許容 ${tol.toFixed(4)}）`);
    check(worst <= tol, "全時相の値が真値 A+B·t+G·x に許容内で一致する", { worst, tol });
    check(worst < truth.B / 4, "許容が時間の刻み B より十分小さい（検査に識別力がある）", { tol, B: truth.B });
    check(r1.values.every((x, t) => t === 0 || x > r1.values[t - 1]), "時間とともに単調増加する");
    await v.screenshot({ path: path.join(OUT_DIR, "2-curve.png") });

    console.log("\n[3] 開いたまま別の点に Probe を置いて「再取得」すると、点と値が変わる");
    await clickCanvas(v, 0.35, 0.62);
    await v.getByTestId("vi-refresh").click();
    await v.waitForTimeout(1500);
    const r2 = await readDialog(v, truth.nT);
    check(r2.lps.length === 3 && Math.abs(r2.lps[0] - r1.lps[0]) > 0.5, "点の x が変わる", { before: r1.lps, after: r2.lps });
    let worst2 = 0;
    r2.values.forEach((val, t) => { worst2 = Math.max(worst2, Math.abs(val - f(r2.lps[0], t))); });
    check(worst2 <= tol, "新しい点でも真値に一致する", { worst2, tol });
    check(Math.abs(r2.values[0] - r1.values[0]) > 0.5, "t=0 の値が変わる（x の傾き G による）", { a: r1.values[0], b: r2.values[0] });
    check((await v.getByTestId("vi-probe-pick").count()) === 1, "Probe が 2 つあるので選択欄が出る");
    await v.screenshot({ path: path.join(OUT_DIR, "3-moved.png") });
    await v.getByTestId("vi-close").click();
  } finally {
    await d.stop();
  }
}

main().then(() => process.exit(summary() === 0 ? 0 : 1)).catch((e) => { console.error(e); process.exit(2); });
