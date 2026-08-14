/*
 * QCA（A4）と解析結果の保存（A10）の実機検証 — `fw/angio-design.md` §8.5。
 *
 * 実行:  cd automator && npx tsx src/spike/xaQcaCheck.ts
 *
 * ⚠️ **実データに真値は無い**。ここで確かめるのは「動くこと」と「数値が内部整合すること」まで。
 *    精度は bench/ の GNBP-XA ファントム（A4b・未着手）でしか確かめられない。
 */
import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { waitForMainScreenReady } from "../checklist/items/shared/helpers.js";
import { dragOnCanvasHost } from "../common/pointerDrag.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "xa-qca");
const XA_DIR = path.join(AUTOMATOR_ROOT, "fixtures", "xa-angio");
const SAMPLE = "0002.DCM";
const HOST = "viewer2d-canvas-host";
const CATHETER_FR = 6;

const failures: string[] = [];
let passed = 0;
function check(cond: boolean, label: string, detail?: unknown): void {
  if (cond) {
    passed++;
    console.log(`  [ok  ] ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  } else {
    console.log(`  [FAIL] ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
    failures.push(label);
  }
}

interface SeriesDto {
  seriesInstanceUid: string;
  modality: string | null;
  seriesDescription: string | null;
}

async function listSeries(httpPort: number, studyUid: string): Promise<SeriesDto[]> {
  const res = await fetch(`http://127.0.0.1:${httpPort}/api/studies/${encodeURIComponent(studyUid)}/series`);
  if (!res.ok) throw new Error(`series 取得に失敗: ${res.status}`);
  return (await res.json()) as SeriesDto[];
}

async function firstStudyUid(httpPort: number): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${httpPort}/api/studies`);
  const studies = (await res.json()) as { studyInstanceUid: string }[];
  if (!studies.length) throw new Error("スタディがありません");
  return studies[0].studyInstanceUid;
}

/** SR の中身をタグダンプ経由で読む（保存内容が本当に入っているかの確認）。 */
async function dumpTags(httpPort: number, studyUid: string, seriesUid: string, sopUid: string): Promise<string> {
  const url =
    `http://127.0.0.1:${httpPort}/api/studies/${encodeURIComponent(studyUid)}` +
    `/series/${encodeURIComponent(seriesUid)}/instances/${encodeURIComponent(sopUid)}/tags`;
  const res = await fetch(url);
  if (!res.ok) return "";
  const rows = (await res.json()) as { name: string; value: string }[];
  return rows.map((r) => `${r.name}=${r.value}`).join("\n");
}

async function instancesOf(httpPort: number, studyUid: string, seriesUid: string): Promise<string[]> {
  const url =
    `http://127.0.0.1:${httpPort}/api/studies/${encodeURIComponent(studyUid)}` +
    `/series/${encodeURIComponent(seriesUid)}/instances`;
  const res = await fetch(url);
  const rows = (await res.json()) as { sopInstanceUid: string }[];
  return rows.map((r) => r.sopInstanceUid);
}

/** QCA 結果テーブルから数値を拾う。 */
async function qcaNumbers(page: Page): Promise<Record<string, number> | null> {
  return page.evaluate(() => {
    const dialog = document.querySelector('[data-testid="xa-analysis-dialog"]')?.parentElement;
    if (!dialog) return null;
    const cells = Array.from(dialog.querySelectorAll("td")).map((td) => (td.textContent ?? "").trim());
    const out: Record<string, number> = {};
    for (let i = 0; i < cells.length - 1; i++) {
      const key = cells[i];
      const m = /^([\d.]+)/.exec(cells[i + 1]);
      if (!m) continue;
      if (key === "MLD") out.mld = Number(m[1]);
      else if (key === "RVD") out.rvd = Number(m[1]);
      else if (key.includes("% Diameter")) out.pctDs = Number(m[1]);
      else if (key.includes("% Area")) out.pctAs = Number(m[1]);
      else if (key.includes("病変長") || key.includes("Lesion")) out.lesion = Number(m[1]);
      else if (key.includes("計測点数") || key.includes("Sample")) out.points = Number(m[1]);
    }
    return out;
  });
}

/** 結果表の単位（"mm" / "px"）。 */
async function qcaUnit(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const dialog = document.querySelector('[data-testid="xa-analysis-dialog"]')?.parentElement;
    const txt = dialog?.textContent ?? "";
    const m = /単位\s*(mm|px)/.exec(txt);
    return m ? m[1] : null;
  });
}

async function dismissStartupDialogs(page: Page): Promise<void> {
  for (let i = 0; i < 3; i++) {
    const dialog = page.locator('[role="dialog"]');
    if ((await dialog.count()) === 0) return;
    const close = dialog.first().getByRole("button", { name: /閉じる|Close/ });
    if ((await close.count()) > 0) await close.first().click().catch(() => {});
    else await page.mouse.click(5, 5).catch(() => {});
    await page.waitForTimeout(400);
  }
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const sample = path.join(XA_DIR, SAMPLE);
  if (!fs.existsSync(sample)) throw new Error(`XA サンプルがありません: ${sample}`);

  const driver = new DesktopDriver();
  await driver.start();
  try {
    const mainPage = driver.page;
    await resetDb(driver.ports.http);
    const imp = await importPaths(driver.ports.http, [sample]);
    if (imp.imported !== 1) throw new Error(`取込に失敗: ${JSON.stringify(imp)}`);
    const studyUid = await firstStudyUid(driver.ports.http);
    const seriesBefore = await listSeries(driver.ports.http, studyUid);

    await waitForMainScreenReady(mainPage, 60_000);
    await dismissStartupDialogs(mainPage);
    mainPage.once("dialog", (d) => void d.accept());
    const dateInputs = mainPage.locator('input[type="date"]');
    await dateInputs.nth(0).fill("");
    await dateInputs.nth(1).fill("");
    await mainPage.getByTestId("search-submit-button").click();
    await mainPage.locator('[data-testid^="study-row-"]').first().click();
    await mainPage.locator('[data-testid^="series-row-"]').first().click();

    const viewer = await driver.waitForNewPage(
      () => mainPage.getByTestId("viewer2d-toolbar-button").click(),
      (url) => url.includes("2dviewer"),
    );
    await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 30_000 });
    await viewer.waitForTimeout(3_000);

    // 造影が乗っているフレームへ。
    await viewer.getByTestId("cine-seek").fill("55");
    await viewer.waitForTimeout(1_500);

    // 血管に沿って Length を引く（QCA の解析区間）。
    await viewer.getByTestId("viewer2d-menu-roi").click();
    await viewer.waitForTimeout(300);
    await viewer.getByText("長さ", { exact: true }).first().click();
    await viewer.waitForTimeout(400);
    await dragOnCanvasHost(viewer, HOST, 90, 60, 0, 12, { fracX: 0.42, fracY: 0.35 });
    await viewer.waitForTimeout(1_200);
    await viewer.screenshot({ path: path.join(OUT_DIR, "0-segment.png") }).catch(() => {});

    // ── 条件 1: 解析 ────────────────────────────────────────────────
    await viewer.getByTestId("xa-analysis-open").click();
    await viewer.getByTestId("xa-analysis-dialog").waitFor({ state: "visible", timeout: 10_000 });
    await viewer.getByRole("button", { name: /解析する|Analyze/ }).click();
    await viewer.waitForTimeout(6_000);
    const nums = await qcaNumbers(viewer);
    check(!!nums && nums.mld !== undefined && nums.rvd !== undefined, "[1] QCA が結果を返す", nums);
    await viewer.screenshot({ path: path.join(OUT_DIR, "1-qca-uncalibrated.png") }).catch(() => {});

    // ── 条件 2/3: 内部整合 ──────────────────────────────────────────
    if (nums) {
      check(nums.mld <= nums.rvd + 1e-6, "[2a] MLD ≤ RVD", { mld: nums.mld, rvd: nums.rvd });
      const expectedDs = (1 - nums.mld / nums.rvd) * 100;
      check(
        Math.abs(expectedDs - nums.pctDs) < 0.2,
        "[2b] %DS = (1 − MLD/RVD)×100 と一致",
        { shown: nums.pctDs, computed: Number(expectedDs.toFixed(2)) },
      );
      check(nums.pctDs >= 0 && nums.pctDs < 100, "[2c] %DS が 0〜100 の範囲", nums.pctDs);
      const ratio = 1 - nums.pctDs / 100;
      const expectedAs = (1 - ratio * ratio) * 100;
      check(
        Math.abs(expectedAs - nums.pctAs) < 0.5,
        "[3] %面積狭窄 = (1 −(1−%DS/100)²)×100 と一致（円形断面の仮定）",
        { shown: nums.pctAs, computed: Number(expectedAs.toFixed(2)) },
      );
      check((nums.points ?? 0) > 10, "[5] 径プロファイルの計測点数 > 10", nums.points);
    }

    // ── 条件 4: 単位が校正に従う（未校正 → px）────────────────────
    const unit0 = await qcaUnit(viewer);
    check(unit0 === "px", "[4a] 未校正の解析は px 単位", unit0);

    // ── 条件 6: 研究用の断り ────────────────────────────────────────
    const dialogText = (await viewer.getByTestId("xa-analysis-dialog").locator("xpath=..").textContent()) ?? "";
    check(/Research Use Only|研究用/.test(dialogText), "[6] 研究用（Research Use Only）が出ている");

    // ── 校正してから再解析（条件 4b）────────────────────────────────
    await viewer.getByTestId("xa-catheter-fr").fill(String(CATHETER_FR));
    await viewer.getByTestId("xa-calibrate-catheter").click();
    await viewer.waitForTimeout(1_500);
    await viewer.getByRole("button", { name: /解析する|Analyze/ }).click();
    await viewer.waitForTimeout(6_000);
    const unit1 = await qcaUnit(viewer);
    const nums1 = await qcaNumbers(viewer);
    check(unit1 === "mm", "[4b] 校正後の解析は mm 単位", unit1);
    check(!!nums1 && nums1.mld > 0, "[4c] 校正後も MLD が出る", nums1);
    await viewer.screenshot({ path: path.join(OUT_DIR, "2-qca-calibrated.png") }).catch(() => {});

    // ── 条件 7/8: 保存（GSPS / SR）─────────────────────────────────
    await viewer.getByRole("button", { name: /表示状態を保存|Save presentation state/ }).click();
    await viewer.waitForTimeout(2_500);
    await viewer.getByRole("button", { name: /計測値を保存|Save measurements/ }).click();
    await viewer.waitForTimeout(2_500);
    await viewer.screenshot({ path: path.join(OUT_DIR, "3-saved.png") }).catch(() => {});

    const seriesAfter = await listSeries(driver.ports.http, studyUid);
    const added = seriesAfter.filter(
      (s) => !seriesBefore.some((b) => b.seriesInstanceUid === s.seriesInstanceUid),
    );
    console.log(`  追加されたシリーズ: ${JSON.stringify(added.map((a) => ({ m: a.modality, d: a.seriesDescription })))}`);
    const pr = added.find((a) => a.modality === "PR");
    const sr = added.find((a) => a.modality === "SR");
    check(!!pr, "[7] GSPS（PR シリーズ）が保管庫に増える", pr?.seriesDescription);
    check(!!sr, "[8] QCA SR（SR シリーズ）が保管庫に増える", sr?.seriesDescription);

    // ── 条件 9: SR の中身 ──────────────────────────────────────────
    if (sr) {
      const sops = await instancesOf(driver.ports.http, studyUid, sr.seriesInstanceUid);
      const dump = sops.length ? await dumpTags(driver.ports.http, studyUid, sr.seriesInstanceUid, sops[0]) : "";
      check(/Minimum Lumen Diameter/.test(dump), "[9a] SR に MLD の概念が入っている");
      check(/Percent Diameter Stenosis/.test(dump), "[9b] SR に %DS の概念が入っている");
      check(/99GRAPHYNEXT/.test(dump), "[9c] private コード体系で書かれている（標準コードを騙らない）");
      check(/catheter calibration|カテーテル/.test(dump), "[9d] 校正の出自が SR に残っている");
      check(/research use only/i.test(dump), "[9e] 研究用の断りが SR に残っている");
      fs.writeFileSync(path.join(OUT_DIR, "qca-sr-tags.txt"), dump);
    }
    if (pr) {
      const sops = await instancesOf(driver.ports.http, studyUid, pr.seriesInstanceUid);
      const dump = sops.length ? await dumpTags(driver.ports.http, studyUid, pr.seriesInstanceUid, sops[0]) : "";
      check(
        /1\.2\.840\.10008\.5\.1\.4\.1\.1\.11\.5/.test(dump),
        "[7b] GSPS が XA/XRF 用（11.5）で書かれている",
      );
      check(/PresentationPixelSpacing/.test(dump), "[7c] 空間校正が Presentation Pixel Spacing に入っている");
      check(/GraphicObjectSequence/.test(dump), "[7d] QCA の描画（図形）が入っている");
      fs.writeFileSync(path.join(OUT_DIR, "gsps-tags.txt"), dump);
    }
  } finally {
    await driver.stop();
  }

  console.log(`\n===== QCA（A4）・保存（A10）受け入れ条件 =====`);
  console.log(`合格 ${passed} / 失敗 ${failures.length}`);
  if (failures.length) {
    console.log("失敗した項目:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  }
  console.log(`スクリーンショット: ${OUT_DIR}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
