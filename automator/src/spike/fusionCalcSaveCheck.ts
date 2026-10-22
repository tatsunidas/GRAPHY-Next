/*
 * Fusion の差分・乗算を「画素値どうしの演算」として新規シリーズに保存できるかの実機検証
 * （Chromium＋実 backend＋合成ファントム）。保存結果は backend の保管庫の DICOM を pydicom で直接読んで確かめる。
 *
 * 実行:  cd automator && npx tsx src/spike/fusionCalcSaveCheck.ts
 *        （jar が要る: cd backend && mvn -q -Dfrontend.skip=true -DskipTests clean package）
 *
 * 確かめること:
 *  [1] 差分・乗算を選ぶと Information が出て、通常に戻すと消える。画面の背景の値は変わらない
 *  [2] 背景 CT(40 HU) × 前景 PT: Modality=OT の Parametric Map。値は PT を CT 格子へ補間して × 40（numpy の別実装と照合）
 *  [3] 背景 CT(100 HU) と前景 CT(40 HU) の差分（前景 − 背景）: CT のまま HU で −60（符号の向きの検査）、絶対値で +60
 *  [4] 保存した Parametric Map を本体のビューアで開き、値と単位が出る
 *  [5] 元のシリーズのファイルは保存の前後で 1 バイトも変わらない
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";

import { resetDb } from "../backend/dbReset.js";
import { WebDriver } from "../driver/webDriver.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { createChecker } from "./computeSpikeShared.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "fusion-calc-check");
const PHANTOM_DIR = path.join(OUT_DIR, "phantom");
const STORE_DIR = path.join(AUTOMATOR_ROOT, ".results", "run-data", "web");
const { check, summary } = createChecker();
const py = process.env.GRAPHY_TEST_PYTHON ?? "python3";

function listDcm(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".dcm")) out.push(p);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out.sort();
}

function hashAll(files: string[]): Map<string, string> {
  return new Map(files.map((f) => [f, crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex")]));
}

function verify(desc: string, mode: string): Record<string, any> {
  const r = spawnSync(py, ["-I", path.join(AUTOMATOR_ROOT, "scripts", "verify-fusion-calc-output.py"),
    STORE_DIR, PHANTOM_DIR, desc, mode], { encoding: "utf8", maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`verify failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

async function openViewerWith(d: WebDriver, seriesText: RegExp): Promise<Page> {
  // ビューアを閉じると検索結果が引き直され、選択が外れることがある。シリーズ行が無ければ検査を選び直す。
  if ((await d.page.locator('[data-testid^="series-row-"]').count()) === 0) {
    await d.page.locator('[data-testid^="study-row-"]').first().click();
    await d.page.waitForTimeout(1500);
  }
  await d.page.locator('[data-testid^="series-row-"]').filter({ hasText: seriesText }).first().click();
  await d.page.waitForTimeout(2500);
  const v = await d.waitForNewPage(() => d.page.getByTestId("viewer2d-toolbar-button").click(), () => true, 30_000);
  await v.setViewportSize({ width: 1400, height: 900 });
  await v.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 30_000 });
  await v.waitForTimeout(3000);
  return v;
}

async function dropFusion(v: Page, fgText: RegExp): Promise<void> {
  const tile = v.getByTestId("series-viewer-root").first();
  const box = (await tile.boundingBox())!;
  await v.getByText(fgText).first().dragTo(tile, { targetPosition: { x: box.width / 2, y: box.height / 2 } });
  await v.getByTestId("fusion-blend").waitFor({ state: "visible", timeout: 30_000 });
  await v.waitForTimeout(3000);
}

async function bgValue(v: Page): Promise<string> {
  const tile = v.getByTestId("series-viewer-root").first();
  const box = (await tile.boundingBox())!;
  await v.mouse.move(box.x + box.width / 2 + 7, box.y + box.height / 2 + 7);
  await v.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await v.waitForTimeout(600);
  return (await v.getByTestId("status-value").first().innerText()).trim();
}

/** ダイアログを開き、演算を選んで保存し、完了メッセージを返す。 */
async function saveViaDialog(v: Page, op: "diff" | "absdiff" | "mult", shot: string): Promise<string> {
  await v.getByTestId("fusion-blend-save-image").click();
  const dlg = v.getByTestId("fusion-calc-dialog");
  await dlg.waitFor({ state: "visible", timeout: 10_000 });
  await v.getByTestId("fusion-calc-output").filter({ hasText: /MB/ }).waitFor({ timeout: 60_000 });
  await v.getByTestId(`fusion-calc-op-${op}`).check();
  await v.waitForTimeout(300);
  await v.screenshot({ path: path.join(OUT_DIR, shot) });
  await v.getByTestId("fusion-calc-save").click();
  const msg = v.getByTestId("fusion-calc-message");
  await msg.filter({ hasText: /保存しました/ }).waitFor({ timeout: 120_000 });
  const text = (await msg.innerText()).trim();
  await v.getByTestId("fusion-calc-close").click();
  return text;
}

async function main(): Promise<void> {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const gen = spawnSync(py, [path.join(AUTOMATOR_ROOT, "scripts", "make-fusion-calc-phantom.py"), PHANTOM_DIR], { encoding: "utf8" });
  if (gen.status !== 0) throw new Error(`ファントムを作れませんでした: ${gen.stderr}`);

  const d = new WebDriver({ http: 18630, scp: 18631, vite: 18633 }, { viewport: { width: 1400, height: 900 }, locale: "ja-JP" });
  await d.start();
  try {
    await resetDb(d.ports.http);
    await importPaths(d.ports.http, [PHANTOM_DIR]);
    await d.page.reload();
    await d.page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 30_000 });
    await d.page.getByTestId("search-allperiod-chip").click();
    await d.page.getByTestId("search-submit-button").click();
    await d.page.locator('[data-testid^="study-row-"]').first().click();
    await d.page.waitForTimeout(1500);
    const srcBefore = hashAll(listDcm(STORE_DIR));
    check(srcBefore.size >= 9 + 9 + 21, "取り込んだ元ファイルが保管庫にある", srcBefore.size);

    // ── セッション 1: 背景 CT(40) × 前景 PT ─────────────────────────────
    console.log("\n[1] Information の出入りと、背景の値");
    let v = await openViewerWith(d, /CT background/);
    await dropFusion(v, /PT foreground/);
    const note = v.getByTestId("fusion-blend-info");
    check((await note.count()) === 0, "通常のときは Information が出ない（負例）");
    const bgNormal = await bgValue(v);
    await v.getByTestId("fusion-blend").selectOption("difference");
    await v.waitForTimeout(1500);
    check((await note.count()) === 1 && (await note.innerText()).includes("画素値は元の背景画像のまま"), "差分で Information が出る");
    check(await v.getByTestId("fusion-blend-save-image").isEnabled(), "［画像として保存…］が使える");
    const bgDiff = await bgValue(v);
    check(bgDiff === bgNormal && bgNormal !== "", "差分でも状態バーの背景の値は通常と同じ", { bgNormal, bgDiff });
    await v.screenshot({ path: path.join(OUT_DIR, "1-info-difference.png") });
    await v.getByTestId("fusion-blend").selectOption("multiply");
    await v.waitForTimeout(1000);
    check((await note.count()) === 1, "乗算で Information が出る");
    await v.getByTestId("fusion-blend").selectOption("normal");
    await v.waitForTimeout(1000);
    check((await note.count()) === 0, "通常へ戻すと消える");

    console.log("\n[2] 背景 CT × 前景 PT の乗算 → Parametric Map");
    await v.getByTestId("fusion-blend").selectOption("multiply");
    await v.waitForTimeout(800);
    const m1 = await saveViaDialog(v, "mult", "2-dialog-mult.png");
    console.log(`  メッセージ: ${m1}`);
    check(/100%/.test(m1), "前景が背景全体を覆っている（重なり 100%）", m1);
    const r2 = verify("PT foreground x CT background", "pt-ct-mult");
    console.log(`  ${JSON.stringify(r2)}`);
    check(r2.found === 9, "新規シリーズが 9 枚", r2.found);
    check(r2.is_parametric_map === true && r2.modality === "OT", "Parametric Map・Modality=OT", { sop: r2.sop_class, mod: r2.modality });
    check(!r2.has_rescale && !r2.has_window, "元の CT の Rescale・窓を持ち込まない");
    check(r2.patient_id === "ISOLINE-PHANTOM" && r2.patient_name.startsWith("Isoline"), "患者を引き継ぐ", r2.patient_id);
    check(r2.frame_of_reference !== "" && r2.shape[0] === 9 && r2.shape[1] === 128 && r2.shape[2] === 128, "背景と同じ格子・座標系", r2.shape);
    check(r2.rel_err < 1e-5, "値が numpy の別実装（PT 補間 × 40）と一致", { max_abs_err: r2.max_abs_err, rel: r2.rel_err });
    check(r2.max_expected > 20000, "検査対象の値が実在する（球の中心 ≈ 1100×40）", r2.max_expected);
    check(JSON.stringify(r2.argmax_out) === JSON.stringify(r2.argmax_expected), "球の位置（向き）が一致", { out: r2.argmax_out, exp: r2.argmax_expected });
    check(/BQML/.test(r2.unit_meaning) && /HU/.test(r2.unit_meaning), "単位に式が書かれる", r2.unit_meaning);
    await v.close();

    // ── セッション 2: 背景 CT(100) × 前景 CT(40) ───────────────────────
    console.log("\n[3] 背景 CT100 × 前景 CT40 の差分（前景 − 背景）→ CT のまま");
    v = await openViewerWith(d, /CT100 second/);
    await dropFusion(v, /CT background/);
    await v.getByTestId("fusion-blend").selectOption("difference");
    await v.waitForTimeout(800);
    const m2 = await saveViaDialog(v, "diff", "3-dialog-diff.png");
    console.log(`  メッセージ: ${m2}`);
    const r3 = verify("CT background - CT100 second", "ct-const");
    console.log(`  ${JSON.stringify(r3)}`);
    check(r3.found === 9 && r3.modality === "CT" && !r3.is_parametric_map, "CT のまま 9 枚", { found: r3.found, mod: r3.modality });
    check(Math.abs(r3.min + 60) < 1e-6 && Math.abs(r3.max + 60) < 1e-6, "全画素が −60 HU（前景 40 − 背景 100。符号が逆なら +60 になる）", { min: r3.min, max: r3.max });
    check(r3.has_rescale && r3.rescale_type === "HU", "Rescale あり・RescaleType=HU", r3.rescale_type);
    check(r3.patient_id === "ISOLINE-PHANTOM" && r3.frame_of_reference !== "", "患者・座標系を引き継ぐ");

    console.log("\n[4] 絶対値差分");
    const m3 = await saveViaDialog(v, "absdiff", "4-dialog-absdiff.png");
    console.log(`  メッセージ: ${m3}`);
    const r4 = verify("CT background |-| CT100 second", "ct-const");
    console.log(`  ${JSON.stringify(r4)}`);
    check(r4.found === 9 && Math.abs(r4.min - 60) < 1e-6 && Math.abs(r4.max - 60) < 1e-6, "全画素が +60 HU", { min: r4.min, max: r4.max });
    await v.close();

    console.log("\n[5] 保存した Parametric Map を本体のビューアで開く");
    v = await openViewerWith(d, /PT foreground x CT background/);
    const pmTile = v.getByTestId("series-viewer-root").first();
    const pmBox = (await pmTile.boundingBox())!;
    await v.mouse.move(pmBox.x + pmBox.width / 2, pmBox.y + pmBox.height / 2);
    for (let i = 0; i < 12; i++) { await v.mouse.wheel(0, -100); await v.waitForTimeout(80); }
    for (let i = 0; i < 4; i++) { await v.mouse.wheel(0, 100); await v.waitForTimeout(250); }
    await v.waitForTimeout(1500);
    // カーソルを数か所に置き、状態バーの XY（画像座標）と値を、保存した値の同じ画素の近傍と突き合わせる。
    for (const [fx, fy] of [[0.5, 0.5], [0.42, 0.55], [0.6, 0.4]] as const) {
      const px = pmBox.x + pmBox.width * fx, py_ = pmBox.y + pmBox.height * fy;
      await v.mouse.move(px + 7, py_ + 7);
      await v.mouse.move(px, py_);
      await v.waitForTimeout(800);
      const pmText = (await v.getByTestId("status-value").first().innerText()).trim();
      const body = await v.locator("body").innerText();
      const xy = /XY\s+(-?[\d.]+),\s*(-?[\d.]+)/.exec(body);
      const shown = parseFloat(pmText);
      console.log(`  カーソル (${fx}, ${fy}): 値 ${pmText} / XY ${xy ? `${xy[1]}, ${xy[2]}` : "読めない"}`);
      if (!xy) { check(false, "状態バーの XY が読める"); continue; }
      const sm = verify("PT foreground x CT background", `sample:4:${xy[1]}:${xy[2]}`);
      const near = (sm.neigh as number[]).some((n) => Math.abs(n - shown) < 0.06 * Math.max(1, Math.abs(n) / 1000));
      check(Number.isFinite(shown) && near && /BQML x HU/.test(pmText), "ビューアの読み値＝保存した値（同じ画素の近傍）・単位は BQML x HU", { pmText, neigh: sm.neigh });
    }
    await v.screenshot({ path: path.join(OUT_DIR, "5-open-saved-pm.png") });
    await v.close();

    console.log("\n[6] 元のシリーズは変わらない");
    const after = hashAll(listDcm(STORE_DIR));
    let changed = 0;
    for (const [f, h] of srcBefore) if (after.get(f) !== h) changed++;
    check(changed === 0, "保存前からあったファイルは全て同一", { changed });
    check(after.size === srcBefore.size + 9 * 3, "増えたのは新規シリーズ 3 本分（27 枚）だけ", { before: srcBefore.size, after: after.size });
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
