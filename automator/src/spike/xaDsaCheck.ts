/*
 * DSA（サブトラクション, A2）の実機検証 — `fw/angio-design.md` §6.6 の受け入れ条件 9 項目。
 *
 * 実行:  cd automator && npx tsx src/spike/xaDsaCheck.ts
 *
 * 前提:
 *   - backend jar: `cd backend && mvn -q -Dfrontend.skip=true -DskipTests clean package`
 *   - XA サンプル: `bash automator/scripts/fetch-xa-samples.sh`
 *
 * 使うデータ: Rubo 0002.DCM（96 フレーム）。実データの性質（§16.2）:
 *   - `PixelIntensityRelationship = LIN` → **対数変換してから差分**する経路
 *   - `MaskSubtractionSequence` は**あるが中身が空**（MaskOperation=NONE / MaskFrameNumbers=0）
 *     → 装置指定なしとして**自動マスク選択**に落ちるのが正しい
 *
 * ⚠️ 判定は数値で突き合わせる。特に「差分が出ている」は**画素統計**で見る
 *    （DOM で ON/OFF を見ても、真っ黒な差分が出ているだけかもしれない）。
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

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "xa-dsa");
const XA_DIR = path.join(AUTOMATOR_ROOT, "fixtures", "xa-angio");
const SAMPLE = "0002.DCM";
const FRAMES = 96;
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

async function pixelStats(page: Page): Promise<{ mean: number; min: number; max: number; nonBlackFraction: number } | null> {
  return page.evaluate(() => {
    const dbg = (window as unknown as {
      __graphyDebug?: { getPixelStats?: () => { mean: number; min: number; max: number; nonBlackFraction: number }[] };
    }).__graphyDebug;
    const all = dbg?.getPixelStats?.() ?? [];
    return all.length ? all[0] : null;
  });
}

/** 実際にビューポートへ適用されている VOI（W/L）。 */
async function appliedVoi(page: Page): Promise<{ center: number; width: number } | null> {
  return page.evaluate(() => {
    const dbg = (window as unknown as {
      __graphyDebug?: { getViewportProperties?: () => { windowLevel: { center: number; width: number } | null }[] };
    }).__graphyDebug;
    const props = dbg?.getViewportProperties?.() ?? [];
    return props.length ? props[0].windowLevel : null;
  });
}

async function setStackCalls(page: Page): Promise<number> {
  return page.evaluate(() => {
    const dbg = (window as unknown as { __graphyDebug?: { getXaCineStats?: () => { setStackCalls: number } } }).__graphyDebug;
    return dbg?.getXaCineStats?.().setStackCalls ?? -1;
  });
}

/** 現在の imageId（DSA 中は graphy-dsa: の合成 ID になる）。 */
async function currentImageId(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const dbg = (window as unknown as {
      __graphyDebug?: { getViewportGeometry?: () => { imageId: string | null }[] };
    }).__graphyDebug;
    const geo = dbg?.getViewportGeometry?.() ?? [];
    return geo.length ? geo[0].imageId : null;
  });
}

async function frameIndicator(page: Page): Promise<{ index: number; total: number }> {
  const text = (await page.getByTestId("cine-indicator").textContent()) ?? "";
  const m = /(\d+)\s*\/\s*(\d+)/.exec(text);
  if (!m) throw new Error(`cine-indicator を読めません: ${JSON.stringify(text)}`);
  return { index: Number(m[1]), total: Number(m[2]) };
}

/** "マスク: フレーム 2, 3, 4" → [2,3,4]（1 origin の表示値をそのまま返す）。 */
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

/** "背景残差 12.3" → 12.3（未表示なら null） */
async function residual(page: Page): Promise<number | null> {
  const el = page.getByTestId("dsa-residual");
  if ((await el.count()) === 0) return null;
  const text = (await el.textContent()) ?? "";
  const m = /([\d.]+)/.exec(text);
  return m ? Number(m[1]) : null;
}


async function openFirstSeries(page: Page): Promise<void> {
  await waitForMainScreenReady(page, 60_000);
  await dismissStartupDialogs(page);
  page.once("dialog", (d) => void d.accept());
  const dateInputs = page.locator('input[type="date"]');
  await dateInputs.nth(0).fill("");
  await dateInputs.nth(1).fill("");
  await page.getByTestId("search-submit-button").click();
  const studyRow = page.locator('[data-testid^="study-row-"]').first();
  await studyRow.waitFor({ state: "visible", timeout: 30_000 });
  await studyRow.click();
  const seriesRow = page.locator('[data-testid^="series-row-"]').first();
  await seriesRow.waitFor({ state: "visible", timeout: 20_000 });
  await seriesRow.click();
  await page.getByTestId(HOST).waitFor({ state: "visible", timeout: 60_000 });
  await page.waitForTimeout(2_500);
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const sample = path.join(XA_DIR, SAMPLE);
  if (!fs.existsSync(sample)) {
    throw new Error(`XA サンプルがありません: ${sample}\n"bash automator/scripts/fetch-xa-samples.sh" を実行してください。`);
  }

  const driver = new DesktopDriver();
  await driver.start();
  try {
    const page = driver.page;
    await resetDb(driver.ports.http);
    const imp = await importPaths(driver.ports.http, [sample]);
    if (imp.imported !== 1) throw new Error(`取込に失敗: ${JSON.stringify(imp)}`);
    await openFirstSeries(page);

    // 造影が乗っているフレームへ移動してから DSA を掛ける（先頭は造影前なので差分がほぼ 0 になる）。
    const seek = page.getByTestId("cine-seek");
    await seek.fill("60");
    await page.waitForTimeout(1_200);
    const nativeStats = await pixelStats(page);
    const nativeImageId = await currentImageId(page);
    check(
      !!nativeStats && nativeStats.nonBlackFraction > 0.05,
      "[前提] DSA 前のフレームが描画されている",
      nativeStats,
    );
    await page.getByTestId("series-controls").screenshot({ path: path.join(OUT_DIR, "0-before-dsa.png") }).catch(() => {});

    // ── DSA ON ──────────────────────────────────────────────────────
    const t0 = Date.now();
    await page.getByTestId("dsa-check").click();
    // マスク平均の計算に全フレームの読み込みが要る（96 フレームの JPEG デコード）。
    await page.getByTestId("dsa-mask").waitFor({ state: "visible", timeout: 120_000 });
    await page.waitForTimeout(2_000);
    console.log(`  DSA セッション構築: ${((Date.now() - t0) / 1000).toFixed(1)} 秒`);

    // ── 条件 1: 装置指定は空 → 自動選択に落ちる ─────────────────────
    const masks = await maskFrames(page);
    check(masks.length > 0, "[1] 装置指定が空でも自動マスク選択でマスクが決まる", { masks });

    // ── 条件 3: マスクが造影到達より前 ───────────────────────────────
    check(
      masks.length > 0 && Math.max(...masks) < 60,
      "[3] 自動選択のマスクが造影到達より前のフレーム",
      { masks, contrastFrame: 60 },
    );

    // ── 条件 2: LIN → 対数変換 ON ───────────────────────────────────
    const logChecked = await page.getByTestId("dsa-log-check").isChecked();
    check(logChecked, "[2] PixelIntensityRelationship=LIN なので対数変換が ON", { logChecked });

    // ── 条件 4: 差分が表示される（真っ黒でない・元と違う）───────────
    const dsaImageId = await currentImageId(page);
    const dsaStats = await pixelStats(page);
    check(
      !!dsaImageId && dsaImageId.startsWith("graphy-dsa:"),
      "[4a] 表示中の imageId が合成（graphy-dsa:）になっている",
      dsaImageId?.slice(0, 40),
    );
    // ⚠️ 「真っ黒でない」だけでは不十分（**真っ白**でも通ってしまう。実際に一度そうなった）。
    //    差分の値域に見合った VOI が当たっているかを**数値で**見る。
    const voi = await appliedVoi(page);
    const range = await page.evaluate(() => {
      const dbg = (window as unknown as { __graphyDebug?: { getImagePixelRange?: () => unknown[] } }).__graphyDebug;
      const r = dbg?.getImagePixelRange?.() ?? [];
      return r.length ? r[0] : null;
    });
    console.log(`  差分画像の実画素値: ${JSON.stringify(range)}`);
    const nativeVoi = { center: 127.5, width: 255 };
    console.log(`  適用中の VOI: ${JSON.stringify(voi)}`);
    check(
      !!dsaStats && dsaStats.nonBlackFraction > 0.05,
      "[4b] 差分画像が真っ黒でない",
      dsaStats,
    );
    check(
      !!voi && voi.width < nativeVoi.width / 10,
      "[4b2] 差分用の VOI が当たっている（元画像の W/L 255 を引き継いでいない）",
      { applied: voi, native: nativeVoi },
    );
    check(
      !!dsaStats && dsaStats.mean > 8 && dsaStats.mean < 247,
      "[4b3] 画面が飽和していない（真っ白でも真っ黒でもない）",
      { mean: dsaStats?.mean },
    );
    check(
      !!nativeStats && !!dsaStats && Math.abs(nativeStats.mean - dsaStats.mean) > 1.0,
      "[4c] 差分画像の画素統計が元画像と有意に異なる",
      { native: nativeStats?.mean, dsa: dsaStats?.mean },
    );
    await page.screenshot({ path: path.join(OUT_DIR, "1-dsa-on.png") }).catch(() => {});
    await page.getByTestId("series-controls").screenshot({ path: path.join(OUT_DIR, "1b-dsa-controls.png") }).catch(() => {});

    // ── 条件 6: ピクセルシフト ──────────────────────────────────────
    const shift0 = await shift(page);
    const res0 = await residual(page);
    await page.getByTestId("dsa-shift-1-0").click(); // → 右へ 1px
    await page.waitForTimeout(1_500);
    const shift1 = await shift(page);
    const res1 = await residual(page);
    check(Math.abs(shift1.dx - shift0.dx - 1) < 1e-6, "[6a] シフトボタンで dx が 1px 変わる", { shift0, shift1 });
    check(
      res0 !== null && res1 !== null && Math.abs(res1 - res0) > 1e-9,
      "[6b] シフトを変えると背景残差の数値も変わる",
      { res0, res1 },
    );

    // ── 条件 7: 自動位置合わせ ──────────────────────────────────────
    await page.getByTestId("dsa-auto-align").click();
    await page.waitForTimeout(20_000);
    const shift2 = await shift(page);
    const res2 = await residual(page);
    check(
      res2 !== null && res1 !== null && res2 <= res1 + 1e-6,
      "[7] 自動位置合わせで背景残差が悪化しない",
      { beforeAuto: res1, afterAuto: res2, shift: shift2 },
    );
    await page.getByTestId("series-controls").screenshot({ path: path.join(OUT_DIR, "2-after-autoalign.png") }).catch(() => {});

    // ── 条件 8/9: DSA 中もシネが動く・setStack が増えない ───────────
    const stackBefore = await setStackCalls(page);
    const indBefore = await frameIndicator(page);
    const host = page.getByTestId(HOST);
    const box = await host.boundingBox();
    if (!box) throw new Error("ビューポートの位置を取得できません");
    for (let i = 0; i < 4; i++) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.wheel(0, 120);
      await page.waitForTimeout(400);
    }
    await page.waitForTimeout(1_000);
    const indAfter = await frameIndicator(page);
    const stackAfter = await setStackCalls(page);
    const dsaImageId2 = await currentImageId(page);
    check(indAfter.index !== indBefore.index, "[8a] DSA 中もホイールでフレームが送れる", { indBefore, indAfter });
    check(
      !!dsaImageId2 && dsaImageId2.startsWith("graphy-dsa:"),
      "[8b] フレーム送り後も合成 imageId のまま",
      dsaImageId2?.slice(0, 40),
    );
    check(
      stackAfter - stackBefore === 0,
      "[9] DSA 中のフレーム送りで setStack が増えない",
      { before: stackBefore, after: stackAfter },
    );

    // ── 条件 5: DSA OFF で元に戻る ──────────────────────────────────
    await seek.fill("60");
    await page.waitForTimeout(1_000);
    await page.getByTestId("dsa-check").click();
    await page.waitForTimeout(2_500);
    const backImageId = await currentImageId(page);
    const backStats = await pixelStats(page);
    check(
      !!backImageId && !backImageId.startsWith("graphy-dsa:"),
      "[5a] DSA OFF で元の imageId に戻る",
      backImageId?.slice(-30),
    );
    check(
      !!nativeStats && !!backStats && Math.abs(nativeStats.mean - backStats.mean) < 0.5,
      "[5b] DSA OFF で画素統計が元に戻る",
      { before: nativeStats?.mean, after: backStats?.mean },
    );
    check(
      !!nativeImageId && backImageId === nativeImageId,
      "[5c] 同じフレームの同じ imageId に戻る",
      { before: nativeImageId?.slice(-24), after: backImageId?.slice(-24) },
    );
    await page.screenshot({ path: path.join(OUT_DIR, "3-dsa-off.png") }).catch(() => {});
  } finally {
    await driver.stop();
  }

  console.log(`\n===== DSA（A2）受け入れ条件 =====`);
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
