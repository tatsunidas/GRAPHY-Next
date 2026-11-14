/*
 * MPR の 3D ROI（軸平行の直方体／楕円体）の実機検証。
 *
 * 実行:  cd automator && npx tsx src/spike/mprRoi3dCheck.ts
 * 前提:  backend jar、frontend の npm ci。専用ポートは GRAPHY_AUTOMATOR_HTTP_PORT / _SCP_PORT / _VITE_PORT。
 *
 * 流れ: 合成の 3D NIfTI（64×64×40・1 mm 等方）を取り込み → MPR を開く → ツールを「楕円体」にして軸位をドラッグ →
 *       3 面に断面が出る → ダイアログで 3 径を 20/10/10 mm にすると容積 = π·2000/6/1000 = 1.0472 mL（手計算）→
 *       「直方体」で 10/10/10 mm = 1.0000 mL → 中心を外へ動かすと警告（内側では出ない＝負例）→
 *       ツール ON 中のドラッグでは十字線が動かず、OFF にするとクリックで動く（排他）。
 * 判定の根拠: 容積は表示中の 3 径からの式、ではなく**入力した既知の径**の手計算値と突き合わせる。
 * 未達: 実 CT での使い勝手（実機確認はユーザー）、段 2（ボクセル数）・段 3（保存）。
 */
import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { openFirstSeriesInViewer } from "../checklist/items/shared/helpers.js";
import { createStepRecorder } from "../checklist/types.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { createChecker } from "./computeSpikeShared.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "mpr-roi3d-check");
const { check, summary } = createChecker();
const NX = 64, NY = 64, NZ = 40;

/** 最小の NIfTI-1（int16、3D、1 mm 等方）。画素 = x + 10。 */
function writeNifti(file: string): void {
  const header = Buffer.alloc(352);
  header.writeInt32LE(348, 0);
  [3, NX, NY, NZ, 1, 1, 1, 1].forEach((v, i) => header.writeInt16LE(v, 40 + i * 2));
  header.writeInt16LE(4, 70);
  header.writeInt16LE(16, 72);
  [1, 1, 1, 1, 1, 0, 0, 0].forEach((v, i) => header.writeFloatLE(v, 76 + i * 4));
  header.writeFloatLE(352, 108);
  header.writeFloatLE(1, 112);
  header.writeFloatLE(0, 116);
  header.writeUInt8(10, 123);
  header.write("n+1\0", 344, "latin1");
  const data = Buffer.alloc(NX * NY * NZ * 2);
  let i = 0;
  for (let z = 0; z < NZ; z++) for (let y = 0; y < NY; y++) for (let x = 0; x < NX; x++) data.writeInt16LE(x + 10, 2 * i++);
  fs.writeFileSync(file, Buffer.concat([header, data]));
}

/** ビューポート要素へ生の PointerEvent と MouseEvent を送る（Playwright のマウスは cornerstone/本機能に届かない。十字線はマウスイベントを読む）。 */
async function drag(page: Page, idx: number, from: [number, number], to: [number, number], steps = 8): Promise<void> {
  await page.evaluate(
    `(function (a) {
      var host = document.querySelectorAll('[data-testid="mpr-viewport"]')[a.idx];
      var r = host.getBoundingClientRect();
      function fire(type, fx, fy, buttons) {
        var mt = type.replace("pointer", "mouse");
        host.dispatchEvent(new MouseEvent(mt, { bubbles: true, cancelable: true, button: 0, buttons: buttons,
          clientX: r.left + r.width * fx, clientY: r.top + r.height * fy }));
        host.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse", isPrimary: true,
          button: 0, buttons: buttons, clientX: r.left + r.width * fx, clientY: r.top + r.height * fy }));
      }
      fire("pointerdown", a.from[0], a.from[1], 1);
      for (var i = 1; i <= a.steps; i++) fire("pointermove", a.from[0] + (a.to[0] - a.from[0]) * i / a.steps, a.from[1] + (a.to[1] - a.from[1]) * i / a.steps, 1);
      fire("pointerup", a.to[0], a.to[1], 0);
    })(${JSON.stringify({ idx, from, to, steps })})`,
  );
}

/** 十字線の位置: 軸位ビューポートの SVG の線の座標（スライス番号の表示は十字線の移動で更新されないので使えない）。 */
const sliceLabels = async (p: Page): Promise<string[]> =>
  p.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid="mpr-viewport"]')[0].querySelectorAll("svg line"))
      .map((l) => [l.getAttribute("x1"), l.getAttribute("y1"), l.getAttribute("x2"), l.getAttribute("y2")].join(","))
      .sort(),
  );

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const nifti = path.join(OUT_DIR, "vol3d.nii");
  writeNifti(nifti);
  const driver = new DesktopDriver();
  const recorder = createStepRecorder();
  await driver.start();
  try {
    await resetDb(driver.ports.http);
    const r = await fetch(`http://127.0.0.1:${driver.ports.http}/api/nifti/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: nifti, modality: "CT", patientId: "ROI3D", patientName: "ROI3D^TEST", seriesDescription: "vol3d" }),
    });
    const imp = (await r.json()) as { imported?: number };
    check(r.ok && (imp.imported ?? 0) > 0, "3D NIfTI の取り込み", imp);
    const main = driver.page;
    try {
      await main.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 30_000 });
    } catch {
      await main.reload({ waitUntil: "domcontentloaded" });
      await main.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    }
    await openFirstSeriesInViewer(main, recorder);
    const mpr = await driver.waitForNewPage(() => main.locator('button[title="MPR Viewer"]').click(), (url) => url.includes("mpr"));
    await mpr.getByTestId("mpr-roi3d-tool").waitFor({ timeout: 90_000 });
    await mpr.waitForTimeout(4_000);

    // ── 排他の前半: ツール ON 中のドラッグで十字線（他面のスライス）が動かない ──
    // 対照（ツールを使う前）: 実マウスの主ボタンのクリックで十字線が動くこと。動かなければ「動かない」検査は無意味。
    const base0 = await sliceLabels(mpr);
    const cb = await mpr.getByTestId("mpr-viewport").first().boundingBox();
    if (cb) {
      await mpr.mouse.move(cb.x + cb.width * 0.5, cb.y + cb.height * 0.5);
      await mpr.mouse.down();
      await mpr.mouse.move(cb.x + cb.width * 0.53, cb.y + cb.height * 0.53, { steps: 4 });
      await mpr.mouse.up();
    }
    await mpr.waitForTimeout(600);
    const base1 = await sliceLabels(mpr);
    await mpr.screenshot({ path: path.join(OUT_DIR, "00-baseline-after-drag.png") });
    check(JSON.stringify(base0) !== JSON.stringify(base1), "対照: ツール未使用なら主ボタンのドラッグで十字線が動く", { base0, base1 });
    const before = await sliceLabels(mpr);
    await mpr.getByTestId("mpr-roi3d-tool").selectOption("ellipsoid");
    await mpr.waitForTimeout(300);
    await drag(mpr, 0, [0.4, 0.4], [0.6, 0.6]);
    await mpr.waitForTimeout(800);
    const afterDraw = await sliceLabels(mpr);
    check(JSON.stringify(before) === JSON.stringify(afterDraw), "ツール ON 中のドラッグでは十字線が動かない（軸位の十字線の座標が変わらない）", { before, afterDraw });

    // ── 3 面に断面が出る ──
    for (const plane of ["axial", "sagittal", "coronal"]) {
      const n = await mpr.getByTestId(`mpr-roi3d-overlay-${plane}`).getByTestId("mpr-roi3d-section").count();
      check(n === 1, `${plane} に断面が 1 つ出る`, n);
    }
    await mpr.screenshot({ path: path.join(OUT_DIR, "01-drawn.png") });

    // ── ダイアログ: 既知の径 20/10/10 mm → 1.0472 mL（手計算 π·2000/6/1000）──
    await mpr.getByTestId("mpr-roi3d-measure").click();
    const dlg = mpr.getByTestId("mpr-roi3d-dialog");
    await dlg.waitFor({ timeout: 5_000 });
    check((await dlg.getByTestId("mpr-roi3d-row").count()) === 1, "一覧に ROI が 1 件");
    if ((await dlg.getByTestId("mpr-roi3d-detail").count()) === 0) await dlg.getByTestId("mpr-roi3d-row").first().click();
    await dlg.getByTestId("mpr-roi3d-detail").waitFor({ timeout: 5_000 });
    check((await dlg.getByTestId("mpr-roi3d-warn").count()) === 0, "負例: ボリュームの内側にある間は警告が出ない");
    for (const [axis, v] of [["X", 20], ["Y", 10], ["Z", 10]] as const) {
      const f = dlg.getByTestId(`mpr-roi3d-size-${axis}`);
      await f.fill(String(v));
      await f.press("Enter");
      await mpr.waitForTimeout(150);
    }
    const vol1 = ((await dlg.getByTestId("mpr-roi3d-volume").first().textContent()) ?? "").trim();
    check(vol1 === "1.0472 mL", `楕円体 20×10×10 mm の容積 = 1.0472 mL（手計算 π·2000/6/1000）`, vol1);
    const formula = (await dlg.getByTestId("mpr-roi3d-formula").textContent()) ?? "";
    check(formula.includes("π") && formula.includes("1047.2 mm³"), "式（代入済み）が出る", formula);
    await mpr.screenshot({ path: path.join(OUT_DIR, "02-dialog-ellipsoid.png") });

    // 径を変えると断面（画面）も変わる: 軸位の断面ポリゴンの点列が変わる。
    const pts20 = await mpr.getByTestId("mpr-roi3d-overlay-axial").locator("polygon").first().getAttribute("points");
    const fx = dlg.getByTestId("mpr-roi3d-size-X");
    await fx.fill("30");
    await fx.press("Enter");
    await mpr.waitForTimeout(300);
    const pts30 = await mpr.getByTestId("mpr-roi3d-overlay-axial").locator("polygon").first().getAttribute("points");
    check(!!pts20 && !!pts30 && pts20 !== pts30, "径（X）を変えると軸位の断面の輪郭が変わる");
    await fx.fill("20");
    await fx.press("Enter");

    // ── はみ出し: 中心 X を体積の外へ。警告が出る（正例）──
    const cx = dlg.getByTestId("mpr-roi3d-center-X");
    const cx0 = await cx.inputValue();
    await cx.fill("1000");
    await cx.press("Enter");
    await mpr.waitForTimeout(300);
    check((await dlg.getByTestId("mpr-roi3d-warn").count()) === 1, "正例: ボリュームの外へ出すと警告が出る");
    const vOut = ((await dlg.getByTestId("mpr-roi3d-volume").first().textContent()) ?? "").trim();
    check(vOut === "1.0472 mL", "はみ出しても容積はクランプしない（1.0472 mL のまま）", vOut);
    await cx.fill(cx0);
    await cx.press("Enter");
    await mpr.waitForTimeout(300);
    check((await dlg.getByTestId("mpr-roi3d-warn").count()) === 0, "元に戻すと警告が消える");
    await dlg.getByRole("button", { name: "×" }).click();

    // ── 直方体: 10/10/10 → 1.0000 mL ──
    await mpr.getByTestId("mpr-roi3d-tool").selectOption("box");
    await drag(mpr, 0, [0.2, 0.2], [0.3, 0.3]);
    await mpr.waitForTimeout(600);
    await mpr.getByTestId("mpr-roi3d-measure").click();
    const dlg2 = mpr.getByTestId("mpr-roi3d-dialog");
    await dlg2.waitFor({ timeout: 5_000 });
    check((await dlg2.getByTestId("mpr-roi3d-row").count()) === 2, "直方体を描いて 2 件になる");
    await dlg2.getByTestId("mpr-roi3d-detail").waitFor({ timeout: 5_000 });
    for (const axis of ["X", "Y", "Z"]) {
      const f = dlg2.getByTestId(`mpr-roi3d-size-${axis}`);
      await f.fill("10");
      await f.press("Enter");
      await mpr.waitForTimeout(150);
    }
    const vols = await dlg2.getByTestId("mpr-roi3d-volume").allTextContents();
    check(vols[1]?.trim() === "1.0000 mL", `直方体 10×10×10 mm の容積 = 1.0000 mL`, vols);
    check(vols[0]?.trim() === "1.0472 mL", "先の楕円体は影響を受けない", vols);
    await mpr.screenshot({ path: path.join(OUT_DIR, "03-two-rois.png") });
    await dlg2.getByRole("button", { name: "×" }).click();

    // ── 排他の後半: ツール OFF にすると、クリックで十字線が動く（操作が効いている対照）──
    await mpr.getByTestId("mpr-roi3d-tool").selectOption("OFF");
    await mpr.waitForTimeout(300);
    const b2 = await sliceLabels(mpr);
    const vbox = await mpr.getByTestId("mpr-viewport").first().boundingBox();
    if (vbox) {
      await mpr.mouse.move(vbox.x + vbox.width * 0.7, vbox.y + vbox.height * 0.7);
      await mpr.mouse.down();
      await mpr.mouse.move(vbox.x + vbox.width * 0.75, vbox.y + vbox.height * 0.75, { steps: 6 });
      await mpr.mouse.up();
    }
    await mpr.waitForTimeout(600);
    const a2 = await sliceLabels(mpr);
    check(JSON.stringify(b2) !== JSON.stringify(a2), "ツール OFF ではクリックで十字線が動く（対照）", { b2, a2 });
    await mpr.screenshot({ path: path.join(OUT_DIR, "04-tool-off.png") });
  } finally {
    await driver.stop().catch(() => undefined);
  }
  process.exit(summary() === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
