/*
 * カテーテル校正の精度（GNBP-XA-4 の校正用ファントム）。設計: fw/angio-design.md・fw/viewer-2d-architecture.md「画素間隔の縦横と…」
 *
 * 実行:  cd automator && npx tsx src/spike/xaCatheterCalibCheck.ts
 * 準備:  cd bench && python3 make_phantom_xa.py --out ./phantom（bench/phantom/GNBP-XA/truth.json と DICOM）
 *
 * ファントム: 6Fr（外径 2.0 mm）のカテーテルが 316 行目、径 3.0 mm の血管が 196 行目に横向きに走る。真の mm/px は 0.225。
 * - 解析区間（血管に沿う長い線）と、校正の線（カテーテルを横切る短い線）を**別々に**画素の座標で引く
 *   （xaQcaCheck の [4c] が落ちていた原因は、解析区間の 275 px の線をそのままカテーテルとして校正したこと＝0.0073 mm/px）
 * - 2 つの読み込み時の状態で確かめる:
 *     e-nothing        … 校正情報なし（読み込み時の world は px）。Rubo の実画像と同じ
 *     d-geometry-only  … SID/SOD だけ（読み込み時に world が mm になる。PR #204 で直した経路）
 * - 確かめること: 校正値 ≈ 0.225 mm/px（線を画面で引く誤差があるので ±8%）・血管の径（RVD・MLD）≈ 3.0 mm（±15%）
 */
import fs from "node:fs";
import path from "node:path";

import type { Page } from "@playwright/test";

import { resetDb } from "../backend/dbReset.js";
import { waitForMainScreenReady } from "../checklist/items/shared/helpers.js";
import { dismissStartupDialogs } from "../common/dismissDialogs.js";
import { dragOnCanvasHost } from "../common/pointerDrag.js";
import { DesktopDriver } from "../driver/desktopDriver.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";

const REPO_ROOT = path.resolve(AUTOMATOR_ROOT, "..");
const PHANTOM_DIR = path.join(REPO_ROOT, "bench", "phantom", "GNBP-XA");
const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "xa-catheter-calib");
const HOST = "viewer2d-canvas-host";
const VARIANTS = ["e-nothing", "d-geometry-only"];

let passed = 0;
const failures: string[] = [];
function check(cond: boolean, label: string, detail?: unknown): void {
  if (cond) passed++;
  else failures.push(label);
  console.log(`  [${cond ? "ok  " : "FAIL"}] ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
}

/** 画像の画素座標 p0 → p1 に Length を引く（qfrPluginCheck と同じ手順）。 */
async function drawBetweenImagePixels(viewer: Page, p0: [number, number], p1: [number, number]): Promise<void> {
  const raw = (await viewer.evaluate(`(() => {
    const g = window.__graphyDebug;
    const f = g && g.imagePixelsToCanvasFraction ? g.imagePixelsToCanvasFraction(${JSON.stringify([p0, p1])}) : null;
    const host = document.querySelector('[data-testid="${HOST}"]');
    const canvas = host && host.querySelector("canvas");
    if (!f || !canvas) return null;
    const r = canvas.getBoundingClientRect();
    return JSON.stringify({ f: f, w: r.width, h: r.height });
  })()`)) as string | null;
  if (!raw) throw new Error("画素→キャンバスの変換ができませんでした");
  const { f, w, h } = JSON.parse(raw) as { f: { fx: number; fy: number }[]; w: number; h: number };
  const dx = Math.round((f[1].fx - f[0].fx) * w);
  const dy = Math.round((f[1].fy - f[0].fy) * h);
  await dragOnCanvasHost(viewer, HOST, dx, dy, 0, 14, { fracX: f[0].fx, fracY: f[0].fy });
  await viewer.waitForTimeout(800);
}

/** QCA 結果テーブルから数値を拾う（xaQcaCheck と同じ）。 */
async function qcaNumbers(page: Page): Promise<Record<string, number> | null> {
  return page.evaluate(() => {
    const dialog = document.querySelector('[data-testid="xa-analysis-dialog"]')?.parentElement;
    if (!dialog) return null;
    const cells = Array.from(dialog.querySelectorAll("td")).map((td) => (td.textContent ?? "").trim());
    const out: Record<string, number> = {};
    for (let i = 0; i < cells.length - 1; i++) {
      const m = /^([\d.]+)/.exec(cells[i + 1]);
      if (!m) continue;
      if (cells[i] === "MLD") out.mld = Number(m[1]);
      else if (cells[i] === "RVD") out.rvd = Number(m[1]);
    }
    return out;
  });
}

async function main(): Promise<void> {
  const truth = JSON.parse(fs.readFileSync(path.join(PHANTOM_DIR, "truth.json"), "utf8")).calibration as {
    catheterFr: number; catheterOuterDiameterMm: number; catheterAxisRow: number; vesselDiameterMm: number; vesselAxisRow: number; mmPerPx: number;
    variants: { key: string; file: string; seriesInstanceUid: string; studyInstanceUid?: string }[];
  };
  const catheterPx = truth.catheterOuterDiameterMm / truth.mmPerPx; // 約 8.9 px
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const driver = new DesktopDriver();
  try {
    await driver.start();
    const page = driver.page;
    page.on("dialog", (d) => void d.accept());
    await resetDb(driver.ports.http);
    const files = truth.variants.filter((v) => VARIANTS.includes(v.key)).map((v) => path.join(PHANTOM_DIR, v.file));
    const imp = await importPaths(driver.ports.http, files);
    if (imp.imported !== files.length) throw new Error(`取込に失敗: ${JSON.stringify(imp)}`);
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForMainScreenReady(page, 60_000);

    for (const key of VARIANTS) {
      const v = truth.variants.find((x) => x.key === key)!;
      console.log(`\n[${key}]`);
      await dismissStartupDialogs(page);
      const dates = page.locator('input[type="date"]');
      await dates.nth(0).fill("");
      await dates.nth(1).fill("");
      await page.getByTestId("search-submit-button").click();
      // シリーズが属する検査を API で引いて選ぶ（変種ごとに検査が分かれていることがある）
      const base = `http://127.0.0.1:${driver.ports.http}`;
      const studies = (await (await fetch(`${base}/api/studies`)).json()) as { studyInstanceUid: string }[];
      let studyUid = studies[0].studyInstanceUid;
      for (const st of studies) {
        const ss = (await (await fetch(`${base}/api/studies/${st.studyInstanceUid}/series`)).json()) as { seriesInstanceUid: string }[];
        if (ss.some((x) => x.seriesInstanceUid === v.seriesInstanceUid)) studyUid = st.studyInstanceUid;
      }
      // すでに選んでいる検査をもう一度押すと選択が外れてシリーズの一覧が閉じる。見えていなければ押す
      const seriesRow = page.locator(`[data-testid="series-row-${v.seriesInstanceUid}"]`);
      if (!(await seriesRow.isVisible().catch(() => false))) await page.locator(`[data-testid="study-row-${studyUid}"]`).click();
      await page.locator(`[data-testid="series-row-${v.seriesInstanceUid}"]`).click();
      const viewer = await driver.waitForNewPage(
        () => page.getByTestId("viewer2d-toolbar-button").click(),
        (url) => url.includes("2dviewer"),
      );
      await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 30_000 });
      await viewer.waitForTimeout(3_000);

      // 長さツールで 2 本引く: #1 血管に沿う解析区間（横）、#2 カテーテルを横切る校正の線（縦・外径ちょうど）
      await viewer.getByTestId("viewer2d-menu-roi").click();
      await viewer.waitForTimeout(250);
      await viewer.getByText("長さ", { exact: true }).first().click();
      await viewer.waitForTimeout(300);
      await drawBetweenImagePixels(viewer, [110, truth.vesselAxisRow], [400, truth.vesselAxisRow]);
      const half = catheterPx / 2;
      await drawBetweenImagePixels(viewer, [256, truth.catheterAxisRow - half], [256, truth.catheterAxisRow + half]);

      await viewer.getByTestId("xa-analysis-open").click();
      await viewer.getByTestId("xa-analysis-dialog").waitFor({ state: "visible", timeout: 10_000 });
      await viewer.getByTestId("xa-analysis-pick").selectOption("0");
      // 校正の候補は直線だけ。ラベル（#2）で選ぶ
      const calibOpts = await viewer.getByTestId("xa-calib-pick").locator("option").allTextContents();
      const idx = calibOpts.findIndex((o) => o.trim().startsWith("#2"));
      check(idx >= 0, `${key}: 校正の候補にカテーテルの線（#2）がある`, calibOpts);
      await viewer.getByTestId("xa-calib-pick").selectOption(String(idx));
      check((await viewer.getByTestId("xa-calib-same-as-analysis").count()) === 0, `${key}: 「解析区間と同じ線」の警告が出ない`);
      await viewer.getByTestId("xa-catheter-fr").fill(String(truth.catheterFr));
      await viewer.getByTestId("xa-calibrate-catheter").click();
      await viewer.waitForTimeout(1_500);
      const status = (await viewer.getByTestId("xa-calib-status").textContent()) ?? "";
      const mmPerPx = Number(/\(([\d.]+) mm\/px\)/.exec(status)?.[1] ?? NaN);
      check(Math.abs(mmPerPx / truth.mmPerPx - 1) < 0.08, `${key}: 校正値が真値 ${truth.mmPerPx} mm/px に合う（±8%）`, { status, mmPerPx });

      await viewer.getByRole("button", { name: /解析する|Analyze/ }).click();
      await viewer.waitForTimeout(6_000);
      const n = await qcaNumbers(viewer);
      check(!!n && Math.abs((n.rvd ?? 0) / truth.vesselDiameterMm - 1) < 0.15, `${key}: RVD が真値 ${truth.vesselDiameterMm} mm に合う（±15%）`, n);
      check(!!n && Math.abs((n.mld ?? 0) / truth.vesselDiameterMm - 1) < 0.15, `${key}: MLD が真値 ${truth.vesselDiameterMm} mm に合う（狭窄なし・±15%）`, n);
      await viewer.screenshot({ path: path.join(OUT_DIR, `${key}.png`) }).catch(() => {});
      await viewer.close();
    }
  } finally {
    await driver.stop();
  }
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
