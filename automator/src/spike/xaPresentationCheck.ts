/*
 * 表示状態（GSPS）の**書き出し → 読み込み → 適用**と、**空間校正の永続化**の実機検証
 * — `fw/angio-design.md` §14.1.1 / §7.4。
 *
 * 準備:  cd bench && python3 make_phantom_xa.py --out ./phantom --series dsa
 *        cd backend && mvn -q -Dfrontend.skip=true -DskipTests package   ← 古い jar だと偽の失敗
 * 実行:  cd automator && npx tsx src/spike/xaPresentationCheck.ts
 *
 * 🚨 **ここでしか掴めないもの**: JUnit は writer/reader 単体、vitest は「何をどう当てるか」の
 * 純ロジックしか守れない。**フロントが値を送っていない／当てた結果が画面に出ていない**は
 * 実機でしか出ない（QCA の注記で実際に踏んだ形）。だから
 *   ① 保存 → 状態を壊す → 適用 → **壊す前に戻るか**
 *   ② 画面を読み込み直しても**校正が残っているか**
 * の 2 つを、**数値で**突き合わせる。
 *
 * 🔴 ①の「状態を壊す」は **DSA を切る**まで含める。適用側は DSA セッションを張り直してから
 * マスクとシフトを当てる非同期経路になっており、ここが最も壊れやすい。
 */
import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { waitForMainScreenReady } from "../checklist/items/shared/helpers.js";
import { dismissStartupDialogs, findBlockingOverlay } from "../common/dismissDialogs.js";

const REPO_ROOT = path.resolve(AUTOMATOR_ROOT, "..");
const PHANTOM_DIR = path.join(REPO_ROOT, "bench", "phantom", "GNBP-XA");
const TRUTH_PATH = path.join(PHANTOM_DIR, "truth.json");
const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "xa-presentation");
const HOST = "viewer2d-canvas-host";

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

interface DsaTruth {
  file: string;
  studyInstanceUid: string;
  maskFrames: number[];
}

/** "マスク: フレーム 1, 2, 3" → [1,2,3]（表示は 1 origin）。 */
async function maskFrames(page: Page): Promise<number[]> {
  const text = (await page.getByTestId("dsa-mask").textContent()) ?? "";
  return [...text.matchAll(/\d+/g)].map((m) => Number(m[0]));
}

/** "ピクセルシフト: 1.0, -2.0 px" → {dx, dy} */
async function shift(page: Page): Promise<{ dx: number; dy: number }> {
  const text = (await page.getByTestId("dsa-shift").textContent()) ?? "";
  const m = /(-?[\d.]+),\s*(-?[\d.]+)/.exec(text);
  if (!m) throw new Error(`dsa-shift を読めません: ${JSON.stringify(text)}`);
  return { dx: Number(m[1]), dy: Number(m[2]) };
}

/** 解析ダイアログの校正表示（"校正: ... (0.2250 mm/px)"）。 */
async function calibStatus(page: Page): Promise<{ text: string; mmPerPx: number | null }> {
  await page.getByTestId("xa-analysis-open").click();
  await page.getByTestId("xa-analysis-dialog").waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForTimeout(600);
  const text = ((await page.getByTestId("xa-calib-status").textContent()) ?? "").replace(/\s+/g, " ").trim();
  await page.getByTestId("xa-dialog-close").click();
  await page.waitForTimeout(400);
  const m = /([\d.]+)\s*mm\/px/.exec(text);
  return { text, mmPerPx: m ? Number(m[1]) : null };
}

async function openStudy(page: Page, studyUid: string): Promise<void> {
  await dismissStartupDialogs(page);
  const blocker = await findBlockingOverlay(page, "search-submit-button");
  if (blocker) throw new Error(`検索ボタンが別の要素に塞がれています: ${blocker}`);
  page.once("dialog", (d) => void d.accept());
  const dateInputs = page.locator('input[type="date"]');
  await dateInputs.nth(0).fill("");
  await dateInputs.nth(1).fill("");
  await page.getByTestId("search-submit-button").click();
  const row = page.locator(`[data-testid="study-row-${studyUid}"]`);
  await row.waitFor({ state: "visible", timeout: 20_000 });
  for (let i = 0; i < 3; i++) {
    await row.click();
    await page.waitForTimeout(800);
    if ((await page.locator('[data-testid^="series-row-"]').count()) > 0) return;
  }
  throw new Error(`スタディを開いてもシリーズ行が出ません: ${studyUid}`);
}

/** シリーズを開いて DSA を ON にする（画像の表示待ちまで）。 */
async function openSeriesWithDsa(page: Page, studyUid: string): Promise<void> {
  await waitForMainScreenReady(page, 60_000);
  await openStudy(page, studyUid);
  await page.locator('[data-testid^="series-row-"]').first().click();
  await page.getByTestId(HOST).waitFor({ state: "visible", timeout: 60_000 });
  await page.waitForTimeout(2_500);
  await page.getByTestId("dsa-check").click();
  await page.getByTestId("dsa-mask").waitFor({ state: "visible", timeout: 120_000 });
  await page.waitForTimeout(2_000);
}

async function main(): Promise<void> {
  if (!fs.existsSync(TRUTH_PATH)) {
    throw new Error(
      `ファントムがありません: ${PHANTOM_DIR}\n` +
        `先に "cd bench && python3 make_phantom_xa.py --out ./phantom" を実行してください。`,
    );
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const truth = (JSON.parse(fs.readFileSync(TRUTH_PATH, "utf8")) as { dsa: DsaTruth }).dsa;
  const file = path.join(PHANTOM_DIR, truth.file);

  const driver = new DesktopDriver();
  await driver.start();
  try {
    const page = driver.page;
    await resetDb(driver.ports.http);
    const imp = await importPaths(driver.ports.http, [file]);
    if (imp.imported !== 1) throw new Error(`取込に失敗: ${JSON.stringify(imp)}`);

    await openSeriesWithDsa(page, truth.studyInstanceUid);

    // ── ① 保存する状態を作る（既定と違う値にしておく）──────────────────
    // シフトを 2 回ずらす。既定 (0,0) のまま保存すると「戻ったのか、元から 0 なのか」が
    // 区別できない——**変わったことが見える状態**にしてから保存する。
    await page.getByTestId("dsa-shift-1-0").click();
    await page.waitForTimeout(600);
    await page.getByTestId("dsa-shift-0-1").click();
    await page.waitForTimeout(1_200);
    const savedShift = await shift(page);
    const savedMask = await maskFrames(page);
    check(
      savedShift.dx !== 0 || savedShift.dy !== 0,
      "[前提] 保存前にシフトを既定から動かした（戻ったことが見える状態にする）",
      savedShift,
    );

    // ── GSPS 保存 ────────────────────────────────────────────────────
    await page.getByTestId("xa-analysis-open").click();
    await page.getByTestId("xa-analysis-dialog").waitFor({ state: "visible", timeout: 30_000 });
    await page.waitForTimeout(800);
    await page.getByTestId("xa-save-gsps").click();
    await page.waitForTimeout(3_000);
    const savedMsg = ((await page.getByTestId("xa-analysis-dialog").locator("..").textContent()) ?? "")
      .replace(/\s+/g, " ");
    check(/GSPS|表示状態|保存/.test(savedMsg), "[保存] 表示状態を GSPS として保存できた", savedMsg.slice(-120));
    await page.getByTestId("xa-dialog-close").click();
    await page.waitForTimeout(600);

    const prSeries = await fetch(
      `http://127.0.0.1:${driver.ports.http}/api/studies/${encodeURIComponent(truth.studyInstanceUid)}/series`,
    ).then((r) => r.json() as Promise<{ modality: string | null }[]>);
    check(
      prSeries.some((s) => s.modality === "PR"),
      "[保存] PR（表示状態）シリーズが保管庫に入る",
      prSeries.map((s) => s.modality),
    );

    // ── ② 状態を壊す（DSA を切る。適用側はセッションを張り直す経路になる）────
    await page.getByTestId("dsa-check").click();
    await page.waitForTimeout(2_000);
    check(
      (await page.getByTestId("dsa-mask").count()) === 0,
      "[前提] DSA を切った（適用でセッションを張り直す経路を通す）",
    );

    // ── ③ 適用 ──────────────────────────────────────────────────────
    await page.getByTestId("xa-pr-open").click();
    await page.getByTestId("xa-pr-dialog").waitFor({ state: "visible", timeout: 30_000 });
    await page.waitForTimeout(2_500);
    const itemCount = await page.getByTestId("xa-pr-item").count();
    check(itemCount >= 1, "[適用] この画像を参照する表示状態が一覧に出る", itemCount);
    const itemText = ((await page.getByTestId("xa-pr-item").first().textContent()) ?? "")
      .replace(/\s+/g, " ")
      .trim();
    // 🚨 「何が当たるか」を押す前に出しているか。押してから知るのでは遅い。
    check(/DSA/.test(itemText), "[適用] 押す前に「DSA が当たる」と出ている", itemText.slice(0, 160));
    check(
      /適用されないもの|Not applied/.test(itemText) === /図形|graphics|LUT|シャッター/.test(itemText),
      "[適用] 当てられないものがあるときだけ理由を出す（毎回警告して麻痺させない）",
      itemText.slice(0, 200),
    );
    await page.locator('[data-testid^="xa-pr-apply-"]').first().click();
    await page.waitForTimeout(1_000);
    await page.getByTestId("xa-pr-close").click();
    // DSA セッションの張り直し → マスク再合成まで待つ。
    await page.getByTestId("dsa-mask").waitFor({ state: "visible", timeout: 120_000 });
    await page.waitForTimeout(3_000);

    const afterShift = await shift(page);
    const afterMask = await maskFrames(page);
    check(
      Math.abs(afterShift.dx - savedShift.dx) < 1e-6 && Math.abs(afterShift.dy - savedShift.dy) < 1e-6,
      "[適用] ★ピクセルシフトが保存した値に戻る（row/column の取り違えがあれば dx/dy が入れ替わる）",
      { saved: savedShift, after: afterShift },
    );
    check(
      JSON.stringify(afterMask) === JSON.stringify(savedMask),
      "[適用] マスクフレームが保存した値に戻る",
      { saved: savedMask, after: afterMask },
    );

    // ── ④ 校正: GSPS から取り込まれ、出自が "GSPS" になる ──────────────
    const applied = await calibStatus(page);
    check(applied.mmPerPx != null, "[校正] 適用後に mm/px が出ている", applied.text);
    check(
      /GSPS/i.test(applied.text),
      "[校正] ★出自が GSPS になる（人が測った校正と混ぜない）",
      applied.text,
    );

    // ── ⑤ 永続化: 画面を読み込み直しても校正が残る ─────────────────────
    // 🚨 メモリ上の Map だけなら、ここで消える（それが今回直した不具合そのもの）。
    await page.reload();
    await waitForMainScreenReady(page, 60_000);
    await openStudy(page, truth.studyInstanceUid);
    await page.locator('[data-testid^="series-row-"]').first().click();
    await page.getByTestId(HOST).waitFor({ state: "visible", timeout: 60_000 });
    await page.waitForTimeout(3_000);
    const reloaded = await calibStatus(page);
    check(
      reloaded.mmPerPx != null && applied.mmPerPx != null
        && Math.abs(reloaded.mmPerPx - applied.mmPerPx) < 1e-6,
      "[永続化] ★読み込み直しても校正値が残る（同じ mm/px）",
      { before: applied.mmPerPx, after: reloaded.mmPerPx },
    );
    check(
      /GSPS/i.test(reloaded.text),
      "[永続化] 出自も残る（残ったが由来不明、にしない）",
      reloaded.text,
    );

    // ── ⑥ 解除も残る（消したはずの校正が次に開いたとき戻らない）──────────
    await page.getByTestId("xa-analysis-open").click();
    await page.getByTestId("xa-analysis-dialog").waitFor({ state: "visible", timeout: 30_000 });
    await page.waitForTimeout(600);
    if ((await page.getByTestId("xa-clear-calibration").count()) > 0) {
      await page.getByTestId("xa-clear-calibration").click();
      await page.waitForTimeout(1_500);
      await page.getByTestId("xa-dialog-close").click();
      await page.waitForTimeout(600);
      await page.reload();
      await waitForMainScreenReady(page, 60_000);
      await openStudy(page, truth.studyInstanceUid);
      await page.locator('[data-testid^="series-row-"]').first().click();
      await page.getByTestId(HOST).waitFor({ state: "visible", timeout: 60_000 });
      await page.waitForTimeout(3_000);
      const cleared = await calibStatus(page);
      check(
        !/GSPS/i.test(cleared.text),
        "[永続化] ★解除も残る（消した校正が読み込み直しで戻らない）",
        cleared.text,
      );
    } else {
      check(false, "[永続化] 校正の解除ボタンが見つからない（検査できていない）");
    }

    fs.writeFileSync(
      path.join(OUT_DIR, "result.json"),
      JSON.stringify({ savedShift, savedMask, afterShift, afterMask, applied, reloaded }, null, 2),
    );
  } finally {
    await driver.stop();
  }

  console.log(`\n===== 表示状態（GSPS）の適用と校正の永続化 =====`);
  console.log(`合格 ${passed} / 失敗 ${failures.length}`);
  if (failures.length) {
    console.log("失敗:");
    failures.forEach((f) => console.log(`  - ${f}`));
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
