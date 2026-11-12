/*
 * 3D ビューアの色の凡例が、3D のボリュームの**実際の値の単位**を出すことの実機検証（Chromium＋実 backend＋合成ファントム）。
 *
 * 以前は「PT なら SUV」とモダリティだけで決めていて、Bq/mL のままの数値に SUV と付いていた。3D 窓は別の窓で
 * 2D の SUV 校正を共有せず、値は常にモダリティ値。校正値を 3D で見るには、校正値を保存したシリーズ（OT）を開く。
 *
 * 実行:  cd automator && timeout 1200 npx tsx src/spike/viewer3dLegendUnitCheck.ts
 *        （ファントムの生成・検証に pydicom・numpy・PIL のある Python が要る: GRAPHY_TEST_PYTHON、既定は python）
 *
 *  1. 合成 PET（BQML）の 3D 凡例: SUV ではなく BQML。目盛りの最大が Bq/mL の桁（1000 以上）。
 *  2. 合成 CT の 3D 凡例: HU（回帰が無いこと）。
 *  3. 2D で %ID/cc・SUVR を適用して保存した OT シリーズを 3D で開く: %ID/cc・SUVR。目盛りは校正値の桁。
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

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "viewer3d-legend-unit");
const PET_DIR = path.join(OUT_DIR, "pet");
const CT_DIR = path.join(OUT_DIR, "ct");
const { check, summary } = createChecker();

async function cursorValue(p: Page, x: number, y: number): Promise<{ text: string; num: number }> {
  await p.mouse.move(x + 7, y + 7);
  await p.mouse.move(x, y);
  await p.waitForTimeout(500);
  const text = (await p.getByTestId("status-value").first().innerText()).trim();
  return { text, num: parseFloat(text) };
}

async function openSuvDialog(v: Page): Promise<void> {
  await v.getByTestId("viewer2d-menu-image").click();
  await v.getByTestId("menu-suv").click();
  await v.getByTestId("suv-dialog").waitFor({ state: "visible", timeout: 10_000 });
}

async function drawRect(v: Page, c: readonly [number, number], halfPx: number): Promise<void> {
  await v.getByTestId("viewer2d-menu-roi").click();
  await v.getByRole("button", { name: /矩形 ROI|Rectangle ROI/ }).first().click();
  await v.waitForTimeout(300);
  await v.mouse.move(c[0] - halfPx, c[1] - halfPx);
  await v.mouse.down();
  await v.mouse.move(c[0], c[1], { steps: 6 });
  await v.mouse.move(c[0] + halfPx, c[1] + halfPx, { steps: 6 });
  await v.mouse.up();
  await v.waitForTimeout(1500);
}

async function roiLines(v: Page): Promise<string[]> {
  return (await v.evaluate(`(function () {
    var host = document.querySelector('[data-testid="viewer2d-canvas-host"]'); var out = [];
    host.querySelectorAll("svg text").forEach(function (t) {
      var sp = t.querySelectorAll("tspan");
      if (sp.length) sp.forEach(function (x) { out.push((x.textContent || "").trim()); }); else out.push((t.textContent || "").trim());
    });
    return out.filter(function (x) { return x.length > 0; });
  })()`)) as string[];
}

const meanOf = (lines: string[]): number => {
  const l = [...lines].reverse().find((x) => /平均|Mean/.test(x)) ?? ""; // 最後に描いた ROI
  const m = /(-?\d+(?:\.\d+)?)/.exec(l.replace(/^[^:：]*[:：]\s*/, ""));
  return m ? Number(m[1]) : NaN;
};



async function toCenterSlice(v: Page): Promise<{ tgt: readonly [number, number]; ref: readonly [number, number]; bg: readonly [number, number]; ppm: number; box: { x: number; y: number; width: number; height: number } }> {
  const tile = v.getByTestId("series-viewer-root").first();
  const tileBox = (await tile.boundingBox())!;
  const box = (await v.locator('[data-testid="viewer2d-canvas-host"] canvas').first().boundingBox())!;
  await v.mouse.move(tileBox.x + tileBox.width / 2, tileBox.y + tileBox.height / 2);
  for (let i = 0; i < 25; i++) { await v.mouse.wheel(0, -100); await v.waitForTimeout(60); }
  for (let i = 0; i < 10; i++) { await v.mouse.wheel(0, 100); await v.waitForTimeout(200); }
  await v.waitForTimeout(1200);
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const ppm = Math.min(box.width, box.height) / 256;
  // 右＝目的球（2000）、左＝参照球（500）、中央＝背景（100）。合成ファントムは x = ±40 mm に球を置く（段 1・2 で確認済み）。
  return { tgt: [cx + 40 * ppm, cy], ref: [cx - 40 * ppm, cy], bg: [cx, cy], ppm, box };
}


async function saveFromDialog(v: Page): Promise<string> {
  await openSuvDialog(v);
  await v.getByTestId("suv-save-derived").waitFor({ state: "visible" });
  await v.getByTestId("suv-save-derived").click();
  await v.getByTestId("suv-save-msg").filter({ hasText: /保存しました|失敗|できません/ }).waitFor({ timeout: 60_000 });
  const msg = await v.getByTestId("suv-save-msg").innerText();
  await v.getByTestId("suv-dialog").getByRole("button", { name: /キャンセル|Cancel/ }).click();
  await v.waitForTimeout(400);
  return msg;
}


const BASE = (d: WebDriver) => `http://127.0.0.1:${d.ports.http}`;

async function seriesIndex(d: WebDriver): Promise<Array<{ study: string; series: string; modality: string }>> {
  const studies = (await (await fetch(`${BASE(d)}/api/studies`)).json()) as { studyInstanceUid: string }[];
  const out: Array<{ study: string; series: string; modality: string }> = [];
  for (const s of studies) {
    const ser = (await (await fetch(`${BASE(d)}/api/studies/${s.studyInstanceUid}/series`)).json()) as { seriesInstanceUid: string; modality: string }[];
    out.push(...ser.map((x) => ({ study: s.studyInstanceUid, series: x.seriesInstanceUid, modality: x.modality })));
  }
  return out;
}

/** 一覧から対象シリーズを選び、3D ビューアを開いて凡例を出し、凡例の文字を返す。 */
async function legendOf(d: WebDriver, study: string, series: string, shot: string): Promise<{ title: string; text: string; nums: number[] }> {
  await d.page.reload();
  await d.page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 30_000 });
  await d.page.getByTestId("search-allperiod-chip").click();
  await d.page.getByTestId("search-submit-button").click();
  await d.page.locator(`[data-testid="study-row-${study}"]`).click();
  await d.page.locator(`[data-testid="series-row-${series}"]`).click();
  await d.page.waitForTimeout(2000);
  const v3d = await d.waitForNewPage(() => d.page.locator('button[title="3D Viewer"]').click(), (url) => url.includes("viewer3d"), 60_000);
  await v3d.setViewportSize({ width: 1400, height: 900 });
  await v3d.locator('[data-testid="viewer3d-mode-mip"]').waitFor({ timeout: 120_000 });
  await v3d.waitForTimeout(3000);
  await v3d.getByRole("button", { name: /レジェンド表示|Show legend/i }).first().click();
  const title = v3d.getByText(/^値( \(.*\))?$/).first();
  await title.waitFor({ state: "visible", timeout: 20_000 });
  await v3d.waitForTimeout(800);
  const titleText = (await title.innerText()).trim();
  const box = title.locator("xpath=ancestor::div[2]");
  const text = (await box.innerText()).replace(/\s+/g, " ").trim();
  const nums = [...text.replace(titleText, "").matchAll(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi)].map((m) => Number(m[0]));
  await v3d.screenshot({ path: shot });
  await v3d.close();
  return { title: titleText, text, nums };
}

async function main(): Promise<void> {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.rmSync(path.join(AUTOMATOR_ROOT, ".results", "run-data", "web"), { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const py = process.env.GRAPHY_TEST_PYTHON ?? "python";
  for (const [script, args] of [
    ["make-pet-suv-phantom.py", [PET_DIR]],
    ["make-sphere-ct-phantom.py", [CT_DIR, "--spheres", '[{"c":[0,0,0],"r":10}]', "--n", "48", "--patient-id", "LEG-CT"]],
  ] as const) {
    const g = spawnSync(py, [path.join(AUTOMATOR_ROOT, "scripts", script), ...args], { encoding: "utf8" });
    if (g.status !== 0) throw new Error(`${script} 失敗: ${g.stderr}`);
  }
  const truth = JSON.parse(fs.readFileSync(path.join(PET_DIR, "truth.json"), "utf8"));
  const petUid: string = truth.pt_series_uid;

  const d = new WebDriver({ http: 18670, scp: 18671, vite: 18673 }, { viewport: { width: 1400, height: 900 }, locale: "ja-JP" });
  await d.start();
  try {
    await resetDb(d.ports.http);
    console.log(`  import PET: ${JSON.stringify(await importPaths(d.ports.http, [PET_DIR])).slice(0, 80)}`);
    console.log(`  import CT: ${JSON.stringify(await importPaths(d.ports.http, [CT_DIR])).slice(0, 80)}`);
    const idx0 = await seriesIndex(d);
    const pet = idx0.find((s) => s.series === petUid)!;
    const ct = idx0.find((s) => s.modality === "CT")!;
    check(!!pet && !!ct, "前提: PET と CT のシリーズが取り込まれている", idx0);

    console.log("\n[1] 合成 PET（BQML）の 3D 凡例");
    const lp = await legendOf(d, pet.study, pet.series, path.join(OUT_DIR, "1-pet.png"));
    console.log(`  凡例: ${JSON.stringify(lp.text)}`);
    check(!/SUV/.test(lp.title), "🔴 単位が SUV ではない（Bq/mL の数値に SUV と付かない）", lp.title);
    check(/\((BQML|Bq\/ml)\)/.test(lp.title), "単位が BQML（Bq/ml）", lp.title);
    // 3D の既定の窓は分布から決まる（球は小さいので上端は 2000 まで届かない）。背景 100・球 500〜2000 Bq/mL の桁。
    // 校正値（%ID/cc で 0.06 以下）の桁ではないこと＝数値は Bq/mL で、単位もそれに合っている。
    check(lp.nums.length >= 2 && Math.max(...lp.nums) >= 100 && Math.max(...lp.nums) <= 2500, "目盛りが Bq/mL の桁（最大が 100 以上。校正値の桁ではない）", lp.nums);

    console.log("\n[2] 合成 CT の 3D 凡例（回帰）");
    const lc = await legendOf(d, ct.study, ct.series, path.join(OUT_DIR, "2-ct.png"));
    console.log(`  凡例: ${JSON.stringify(lc.text)}`);
    check(/\(HU\)/.test(lc.title), "CT は HU のまま", lc.title);
    check(lc.nums.length >= 2 && lc.nums.some((n) => Math.abs(n) >= 100), "目盛りが HU の桁（数十〜数百）", lc.nums);

    console.log("\n[3] 2D で %ID/cc・SUVR を適用して保存 → 保存した OT シリーズを 3D で開く");
    await d.page.reload();
    await d.page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 30_000 });
    await d.page.getByTestId("search-allperiod-chip").click();
    await d.page.getByTestId("search-submit-button").click();
    await d.page.locator(`[data-testid="study-row-${pet.study}"]`).click();
    await d.page.locator(`[data-testid="series-row-${pet.series}"]`).click();
    await d.page.waitForTimeout(2500);
    const v = await d.waitForNewPage(() => d.page.getByTestId("viewer2d-toolbar-button").click(), () => true, 30_000);
    await v.setViewportSize({ width: 1400, height: 900 });
    await v.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 30_000 });
    await v.waitForTimeout(3000);
    const g = await toCenterSlice(v);
    await openSuvDialog(v);
    await v.getByTestId("suv-type").selectOption("pid");
    await v.getByTestId("suv-apply").click();
    await v.waitForTimeout(2500);
    check(/保存しました（21 枚）/.test(await saveFromDialog(v)), "%ID/cc の校正値を 21 枚保存した", null);
    await drawRect(v, g.ref, 8 * g.ppm);
    await openSuvDialog(v);
    await v.getByTestId("suv-type").selectOption("suvr");
    await v.waitForTimeout(2500);
    await v.getByTestId("suv-apply").click();
    await v.waitForTimeout(2500);
    check(/保存しました（21 枚）/.test(await saveFromDialog(v)), "SUVR の校正値を 21 枚保存した", null);
    await v.close();
    const idx1 = await seriesIndex(d);
    const saved = idx1.filter((s) => s.modality === "OT");
    check(saved.length === 2, "OT のシリーズが 2 本できた", saved.length);
    const units: string[] = [];
    for (const s of saved) {
      const l = await legendOf(d, s.study, s.series, path.join(OUT_DIR, `3-saved-${units.length}.png`));
      console.log(`  凡例: ${JSON.stringify(l.text)}`);
      units.push(l.title);
      const isPid = /%ID\/cc/.test(l.title);
      const isSuvr = /\(SUVR\)/.test(l.title);
      check(isPid || isSuvr, "校正値のシリーズの単位（%ID/cc または SUVR）が凡例に出る", l.title);
      const mx = Math.max(...l.nums);
      check(isPid ? mx > 0 && mx < 1 : mx > 0.5 && mx < 20, `目盛りが校正値の桁（${isPid ? "%ID/cc は 1 未満" : "SUVR は 0.5〜20"}）`, l.nums);
      check(!/Bq|BQML/.test(l.text), "元の Bq/mL の単位は出ない", l.text);
    }
    check(units.some((u) => /%ID\/cc/.test(u)) && units.some((u) => /SUVR/.test(u)), "%ID/cc と SUVR の両方が確認できた", units);
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
