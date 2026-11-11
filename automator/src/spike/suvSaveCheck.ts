/*
 * 校正値の派生シリーズ保存（Parametric Map）の実機検証（Chromium＋実 backend＋合成ファントム）。
 *
 * 実行:  cd automator && timeout 900 npx tsx src/spike/suvSaveCheck.ts
 *        （ファントムの検証に pydicom・numpy のある Python が要る: GRAPHY_TEST_PYTHON、既定は python）
 *
 *  1. 校正を解除した状態では［保存］が押せない（負例）。
 *  2. %ID/cc を適用 → ［保存］→ シリーズが 1 本増える。保存したファイルを**解析式**で照合
 *     （値 = BQML×100/崩壊後投与量、相対 1e-6）・IPP・IOP・枚数・FrameOfReferenceUID が元と一致・Modality=OT・単位。
 *  3. 新しいシリーズを開く: 単位 %ID/cc・3 か所のカーソル値が保存前と一致、矩形 ROI の平均。
 *     「SUV 校正」は PET のみで開かない（二重校正しない）。
 *  4. SUVR（参照 ROI あり）でも同様（値 4.00 / 1.00 / 0.20・単位 SUVR）。
 *  5. 描かれた画面（画素）で目的球が明るく・参照球が中間に見える。
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

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "suv-save-check");
const PHANTOM_DIR = path.join(OUT_DIR, "phantom");
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


const BASE = (d: WebDriver) => `http://127.0.0.1:${d.ports.http}`;
const DATA_DICOM = path.join(AUTOMATOR_ROOT, ".results", "run-data", "web", "data", "dicom");

async function seriesUids(d: WebDriver): Promise<string[]> {
  const studies = (await (await fetch(`${BASE(d)}/api/studies`)).json()) as { studyInstanceUid: string }[];
  const out: string[] = [];
  for (const s of studies) {
    const ser = (await (await fetch(`${BASE(d)}/api/studies/${s.studyInstanceUid}/series`)).json()) as { seriesInstanceUid: string }[];
    out.push(...ser.map((x) => x.seriesInstanceUid));
  }
  return out;
}

async function openSeriesViewer(d: WebDriver, uid: string): Promise<Page> {
  await d.page.reload();
  await d.page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 30_000 });
  await d.page.getByTestId("search-allperiod-chip").click();
  await d.page.getByTestId("search-submit-button").click();
  await d.page.locator('[data-testid^="study-row-"]').first().click();
  await d.page.locator(`[data-testid="series-row-${uid}"]`).click();
  await d.page.waitForTimeout(2000);
  const v = await d.waitForNewPage(() => d.page.getByTestId("viewer2d-toolbar-button").click(), () => true, 30_000);
  await v.setViewportSize({ width: 1400, height: 900 });
  await v.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 30_000 });
  await v.waitForTimeout(3000);
  return v;
}

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

function verify(py: string, uid: string, mode: "pid" | "suvr"): Record<string, unknown> {
  const r = spawnSync(py, [path.join(AUTOMATOR_ROOT, "scripts", "verify-calibrated-series.py"), DATA_DICOM, PHANTOM_DIR, uid, mode], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`verify failed: ${r.stderr}`);
  return JSON.parse(r.stdout.trim());
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

async function main(): Promise<void> {
  fs.rmSync(PHANTOM_DIR, { recursive: true, force: true });
  fs.rmSync(path.join(AUTOMATOR_ROOT, ".results", "run-data", "web"), { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const py = process.env.GRAPHY_TEST_PYTHON ?? "python";
  const gen = spawnSync(py, [path.join(AUTOMATOR_ROOT, "scripts", "make-pet-suv-phantom.py"), PHANTOM_DIR], { encoding: "utf8" });
  if (gen.status !== 0) throw new Error(`ファントムを作れませんでした: ${gen.stderr}`);
  const truth = JSON.parse(fs.readFileSync(path.join(PHANTOM_DIR, "truth.json"), "utf8"));
  const srcUid: string = truth.pt_series_uid;
  const decayed = truth.dose_bq * Math.exp((-Math.LN2 * 3600) / truth.half_life_s);
  const pct = (c: number) => (c * 100) / decayed;
  const want = { pid: { tgt: pct(truth.c_target), ref: pct(truth.c_ref), bg: pct(truth.c_bg) }, suvr: { tgt: 4, ref: 1, bg: 0.2 } };

  const d = new WebDriver({ http: 18660, scp: 18661, vite: 18663 }, { viewport: { width: 1400, height: 900 }, locale: "ja-JP" });
  await d.start();
  try {
    await resetDb(d.ports.http);
    console.log(`  import: ${JSON.stringify(await importPaths(d.ports.http, [PHANTOM_DIR])).slice(0, 100)}`);
    check((await seriesUids(d)).length === 1, "取り込み直後のシリーズは 1 本", null);
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
    const g = await toCenterSlice(v);

    console.log("\n[1] 校正が無い（解除した）状態では保存できない（負例）");
    await openSuvDialog(v);
    check(await v.getByTestId("suv-save-derived").isDisabled(), "［保存］が押せない", null);
    check(/先に校正を適用/.test(await v.getByTestId("suv-save-hint").innerText()), "理由が出る", null);
    await v.getByTestId("suv-dialog").getByRole("button", { name: /キャンセル|Cancel/ }).click();
    await v.waitForTimeout(400);
    check((await seriesUids(d)).length === 1, "何も保存されていない（シリーズは 1 本のまま）", null);

    console.log("\n[2] %ID/cc を適用して保存 → 保存したファイルを解析式で照合");
    await openSuvDialog(v);
    await v.getByTestId("suv-type").selectOption("pid");
    await v.getByTestId("suv-apply").click();
    await v.waitForTimeout(2500);
    const msg1 = await saveFromDialog(v);
    console.log(`  結果: ${msg1}`);
    check(/保存しました（21 枚）/.test(msg1), "21 枚を保存した", msg1);
    const afterPid = await seriesUids(d);
    check(afterPid.length === 2, "シリーズが 1 本増える", afterPid.length);
    const pidUid = afterPid.find((u) => u !== srcUid)!;
    const vp = verify(py, pidUid, "pid");
    console.log(`  verify: ${JSON.stringify(vp)}`);
    check(vp.modality === "OT", "Modality=OT（PET のままではない）", vp.modality);
    check(vp.nFrames === vp.nSrc && vp.nFrames === 21, "枚数が元と同じ", vp);
    check(typeof vp.maxRelErr === "number" && (vp.maxRelErr as number) < 1e-6, "全画素が解析式（BQML×100/崩壊後投与量）と相対 1e-6 で一致", vp.maxRelErr);
    check(typeof vp.maxIppDiffMm === "number" && (vp.maxIppDiffMm as number) < 1e-3 && (vp.iopMaxDiff as number) < 1e-6 && vp.forSame === true, "IPP・IOP・FrameOfReferenceUID が元と一致", vp);
    check(vp.unitMeaning === "%ID/cc" && String(vp.unitCode).length <= 16, "単位が %ID/cc（コードは 16 文字以内）", { c: vp.unitCode, m: vp.unitMeaning });
    check(/PET small animal %ID\/cc/.test(String(vp.seriesDescription)), "シリーズ名に単位が付く", vp.seriesDescription);

    // 保存前（元シリーズ・校正中）の値
    const before: Record<string, number> = {};
    for (const [k, p] of [["tgt", g.tgt], ["ref", g.ref], ["bg", g.bg]] as const) before[k] = (await cursorValue(v, p[0], p[1])).num;


    console.log("\n[4] SUVR（参照 ROI あり）でも保存 → 照合");
    await drawRect(v, g.ref, 8 * g.ppm);
    await openSuvDialog(v);
    await v.getByTestId("suv-type").selectOption("suvr");
    await v.waitForTimeout(2500);
    await v.getByTestId("suv-apply").click();
    await v.waitForTimeout(2500);
    const msg2 = await saveFromDialog(v);
    check(/保存しました（21 枚）/.test(msg2), "21 枚を保存した", msg2);
    const afterSuvr = await seriesUids(d);
    check(afterSuvr.length === 3, "シリーズがもう 1 本増える", afterSuvr.length);
    const suvrUid = afterSuvr.find((u) => u !== srcUid && u !== pidUid)!;
    const vs = verify(py, suvrUid, "suvr");
    console.log(`  verify: ${JSON.stringify(vs)}`);
    check(vs.modality === "OT" && vs.nFrames === 21, "Modality=OT・21 枚", vs);
    check(typeof vs.maxRelErr === "number" && (vs.maxRelErr as number) < 1e-6, "全画素が解析式（BQML÷参照の濃度）と相対 1e-6 で一致", vs.maxRelErr);
    check(typeof vs.maxIppDiffMm === "number" && (vs.maxIppDiffMm as number) < 1e-3 && vs.forSame === true, "IPP・FrameOfReferenceUID が元と一致", vs);
    check(vs.unitMeaning === "SUVR" && /Reference: .* mean 0\.0146\d* %ID\/cc n=25/.test(String(vs.derivation)), "単位 SUVR・参照領域が派生の説明に残る", { m: vs.unitMeaning, d: vs.derivation });
    // 元のビューアが開いたままだと、別シリーズは新しい窓にならない。閉じてから保存した 2 本を順に開く。
    await v.close();
    console.log("\n[3] 新しいシリーズ（%ID/cc）を開く");
    const v2 = await openSeriesViewer(d, pidUid);
    const g2 = await toCenterSlice(v2);
    for (const [k, p] of [["tgt", g2.tgt], ["ref", g2.ref], ["bg", g2.bg]] as const) {
      const r = await cursorValue(v2, p[0], p[1]);
      console.log(`  ${k}: ${r.text}（保存前 ${before[k]}）`);
      check(/%ID\/cc/.test(r.text), `${k}: 単位が %ID/cc`, r.text);
      // 保存したシリーズは小数 6 桁で表示される。解析式と相対 1e-4、保存前（2 桁表示）とは丸めの範囲で一致。
      check(Math.abs(r.num / want.pid[k as "tgt"] - 1) < 1e-4 && Math.abs(r.num - before[k]) <= 0.0051, `${k}: 解析式（相対 1e-4）・保存前の校正値と一致`, { got: r.num, before: before[k], want: want.pid[k as "tgt"] });
    }
    await drawRect(v2, g2.tgt, 8 * g2.ppm);
    const roiMean = meanOf(await roiLines(v2));
    check(Math.abs(roiMean / want.pid.tgt - 1) < 0.005, "矩形 ROI の平均が解析式どおり（表示 3 桁）", { roiMean, want: want.pid.tgt });
    // 「SUV 校正」は PET のみ: ダイアログは開かず、案内が出る
    await v2.getByTestId("viewer2d-menu-image").click();
    await v2.getByTestId("menu-suv").click();
    await v2.waitForTimeout(800);
    check(!(await v2.getByTestId("suv-dialog").isVisible().catch(() => false)), "保存したシリーズでは SUV 校正が開かない（二重校正しない）", null);
    check(/PET（Modality=PT）シリーズでのみ|only available for PET/i.test(await v2.getByTestId("viewer2d-toast").innerText().catch(() => "")), "「PET のみ」の案内が出る", null);
    const shot = path.join(OUT_DIR, "3-saved-viewport.png");
    fs.writeFileSync(shot, await v2.screenshot({ clip: { x: g2.box.x, y: g2.box.y, width: g2.box.width, height: g2.box.height } }));
    await v2.screenshot({ path: path.join(OUT_DIR, "3-saved.png") });
    const lum = spawnSync(py, ["-I", "-c", [
      "import sys, numpy as np; from PIL import Image",
      "a = np.array(Image.open(sys.argv[1]).convert('L')); n = a.size",
      "print(round((a >= 230).sum() / n, 4), round(((a >= 40) & (a < 200)).sum() / n, 4), int(a.max()))",
    ].join("\n"), shot], { encoding: "utf8" });
    const [bright, mid, mx] = lum.stdout.trim().split(" ").map(Number);
    console.log(`  画面: 明るい画素 ${bright} / 中間 ${mid} / 最大 ${mx}`);
    check(bright > 0.003 && mid > 0.003, "保存したシリーズの画面で、目的球が明るく・参照球が中間に見える（画素）", { bright, mid, mx });
    await v2.close();

    console.log("\n[5] 保存した SUVR のシリーズを開く");
    const v3 = await openSeriesViewer(d, suvrUid);
    const g3 = await toCenterSlice(v3);
    for (const [k, p] of [["tgt", g3.tgt], ["ref", g3.ref], ["bg", g3.bg]] as const) {
      const r = await cursorValue(v3, p[0], p[1]);
      check(/SUVR/.test(r.text) && Math.abs(r.num - want.suvr[k as "tgt"]) <= 0.0051, `${k}: SUVR ${want.suvr[k as "tgt"]}`, r.text);
    }
    await v3.close();
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
