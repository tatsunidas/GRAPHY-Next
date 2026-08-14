/*
 * XA シネ表示（A1）の実機検証 — `fw/angio-design.md` §5.8 の受け入れ条件 9 項目。
 *
 * 実行:  cd automator && npx tsx src/spike/xaCineCheck.ts
 *
 * 前提:
 *   - backend jar: `cd backend && mvn -q -Dfrontend.skip=true -DskipTests clean package`
 *   - XA サンプル: `bash automator/scripts/fetch-xa-samples.sh`
 *
 * 何を確かめるか（設計 §5.8）:
 *   1. フレーム総数が DICOM の NumberOfFrames と一致する
 *   2. 実時間 1.0x の実測 fps が公称 fps の ±5% 以内
 *   3. 最終フレームが表示できる（先頭固定になっていない）
 *   4. 再生中に W/L・Pan/Zoom が効き、フレーム切替でリセットされない
 *   5. 単一ランの XA で**スライダーが「Frame」1 本だけ**（Z / ThickSlab / Grid 無効ヒントが出ない）
 *   6. ホイールでフレームが送れる（スタック軸が T になっている証拠）
 *   7. フレーム送りで setStack が呼ばれていない（毎フレーム再構築していない）
 *   8. 複数ランの XA で「Run」スライダーが出る（「Z」表記が無い）
 *   9. CT の既存表示に変化が無い（Z スライダーが従来どおり出る＝回帰確認）
 *
 * ⚠️ 判定は**数値で突き合わせる**（[[automator-verification-hygiene]]）。「動いた」で通さない。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importPaths, importFixtureCategory } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { waitForMainScreenReady } from "../checklist/items/shared/helpers.js";
import { dragOnCanvasHost } from "../common/pointerDrag.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "xa-cine");
const XA_DIR = path.join(AUTOMATOR_ROOT, "fixtures", "xa-angio");
/** 多ラン検証用に SeriesInstanceUID を揃えて作り直したコピーの置き場。 */
const MULTIRUN_DIR = path.join(OUT_DIR, "multirun");

const HOST = "viewer2d-canvas-host";

/** 単一ラン検証に使うサンプル（96 フレーム・FrameTime 33ms → 公称 30.30 fps）。 */
const SINGLE = { file: "0002.DCM", frames: 96, frameTimeMs: 33 };
/** 多ラン検証に束ねるサンプル（フレーム数が違う組み合わせにする）。 */
const MULTI = ["0002.DCM", "0012.DCM"];

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

interface XaCineStats {
  measuredFps: number;
  nominalFps: number;
  fpsSource: string;
  framesRendered: number;
  setStackCalls: number;
}

async function cineStats(page: Page): Promise<XaCineStats> {
  return page.evaluate(() => {
    const dbg = (window as unknown as { __graphyDebug?: { getXaCineStats?: () => unknown } }).__graphyDebug;
    return (dbg?.getXaCineStats?.() ?? {}) as XaCineStats;
  });
}

/** `cine-indicator` の "12/96" から現在フレーム（1 origin）と総数を読む。 */
async function frameIndicator(page: Page): Promise<{ index: number; total: number }> {
  const text = (await page.getByTestId("cine-indicator").textContent()) ?? "";
  const m = /(\d+)\s*\/\s*(\d+)/.exec(text);
  if (!m) throw new Error(`cine-indicator を読めません: ${JSON.stringify(text)}`);
  return { index: Number(m[1]), total: Number(m[2]) };
}

/** 表示中ビューポートの画素統計（描画されているかを DOM でなく画素で判定する）。 */
async function pixelStats(page: Page): Promise<{ mean: number; nonBlackFraction: number } | null> {
  return page.evaluate(() => {
    const dbg = (window as unknown as {
      __graphyDebug?: { getPixelStats?: () => { mean: number; nonBlackFraction: number }[] };
    }).__graphyDebug;
    const all = dbg?.getPixelStats?.() ?? [];
    return all.length ? { mean: all[0].mean, nonBlackFraction: all[0].nonBlackFraction } : null;
  });
}

/**
 * ビューポートの表示状態。フレーム切替でリセットされないことの確認に使う。
 *
 * ⚠️ **`getViewportGeometry()` は `zoom`/`pan` を返さない**（`camera.parallelScale` /
 * `focalPoint`）。`getViewportProperties()` も `voiRange` ではなく `windowLevel`（{center,width}）。
 * 存在しないフィールドを読むと **undefined 同士の比較で「変化なし」が常に成立**し、
 * 何も測らずに合格する（実際に一度そうなった）。フィールド名は debugApi.ts に合わせること。
 */
interface ViewState {
  imageId: string | null;
  parallelScale: number | null;
  focalPoint: number[] | null;
  windowLevel: { center: number; width: number } | null;
}

async function viewportState(page: Page): Promise<ViewState | null> {
  return page.evaluate(() => {
    const dbg = (window as unknown as {
      __graphyDebug?: {
        getViewportGeometry?: () => {
          imageId: string | null;
          camera: { parallelScale: number | null; focalPoint: number[] | null };
        }[];
        getViewportProperties?: () => { windowLevel: { center: number; width: number } | null }[];
      };
    }).__graphyDebug;
    const geo = dbg?.getViewportGeometry?.() ?? [];
    const props = dbg?.getViewportProperties?.() ?? [];
    if (!geo.length) return null;
    return {
      imageId: geo[0].imageId ?? null,
      parallelScale: geo[0].camera?.parallelScale ?? null,
      focalPoint: geo[0].camera?.focalPoint ?? null,
      windowLevel: props[0]?.windowLevel ?? null,
    };
  });
}

/**
 * 起動時に前面へ出るダイアログを閉じる。
 *
 * <p>この環境では**アプリ内更新通知**（v0.1.12 → v0.1.16）が起動直後に出て、
 * 半透明オーバーレイ（z-index 1001）が検索ボタンのクリックを奪う。検証内容とは無関係なので閉じる。
 */
async function dismissStartupDialogs(page: Page): Promise<void> {
  for (let i = 0; i < 3; i++) {
    const dialog = page.locator('[role="dialog"]');
    if ((await dialog.count()) === 0) return;
    const close = dialog.first().getByRole("button", { name: /閉じる|Close/ });
    if ((await close.count()) > 0) {
      await close.first().click().catch(() => {});
    } else {
      // 「あとで」等のボタンが無ければオーバーレイの外側クリックで閉じる。
      await page.mouse.click(5, 5).catch(() => {});
    }
    await page.waitForTimeout(400);
  }
}

/** 検査一覧から最初のスタディ→最初のシリーズを開く。 */
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
  // レイアウト解決＋プリウォーム（dataSet の先読み）を待つ。
  await page.waitForTimeout(2_500);
}

/**
 * 複数ランのシリーズを合成する。
 *
 * <p>Rubo のサンプルは 1 ファイル = 1 検査なので、そのままでは「同一シリーズに複数ラン」に
 * ならない。Study/Series の UID を揃えたコピーを作って多ラン構成を再現する
 * （**ピクセルは触らない**。UID と InstanceNumber だけ書き換える）。
 */
function buildMultiRunSeries(): string[] {
  fs.mkdirSync(MULTIRUN_DIR, { recursive: true });
  const out = MULTI.map((f, i) => path.join(MULTIRUN_DIR, `run${i + 1}.dcm`));
  if (out.every((p) => fs.existsSync(p))) return out;
  const script = `
import pydicom, sys
study, series = "1.2.826.0.1.3680043.9.7.9001.1", "1.2.826.0.1.3680043.9.7.9001.2"
for i, (src, dst) in enumerate(zip(sys.argv[1::2], sys.argv[2::2])):
    ds = pydicom.dcmread(src)
    ds.StudyInstanceUID = study
    ds.SeriesInstanceUID = series
    ds.SOPInstanceUID = f"1.2.826.0.1.3680043.9.7.9001.3.{i+1}"
    ds.InstanceNumber = i + 1
    ds.PatientID = "XA-MULTIRUN"
    ds.PatientName = "XA^MULTIRUN"
    ds.SeriesDescription = "multi-run"
    ds.save_as(dst, enforce_file_format=True)
    print(dst, ds.NumberOfFrames)
`;
  const args: string[] = [];
  MULTI.forEach((f, i) => args.push(path.join(XA_DIR, f), out[i]));
  execFileSync("python3", ["-c", script, ...args], { stdio: "inherit" });
  return out;
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const single = path.join(XA_DIR, SINGLE.file);
  if (!fs.existsSync(single)) {
    throw new Error(
      `XA サンプルがありません: ${single}\n` +
      `先に "bash automator/scripts/fetch-xa-samples.sh" を実行してください。`,
    );
  }
  const nominalFps = 1000 / SINGLE.frameTimeMs;

  const driver = new DesktopDriver();
  await driver.start();
  try {
    const page = driver.page;

    // ══ 単一ラン（0002.DCM, 96 フレーム）════════════════════════════════
    await resetDb(driver.ports.http);
    const imp = await importPaths(driver.ports.http, [single]);
    console.log(`取込結果: ${JSON.stringify(imp)}`);
    if (imp.imported !== 1) throw new Error(`XA の取込に失敗: ${JSON.stringify(imp)}`);

    await openFirstSeries(page);
    await page.screenshot({ path: path.join(OUT_DIR, "1-single-run.png") }).catch(() => {});

    // ── 条件 1: フレーム総数 ─────────────────────────────────────────
    // 条件 5/8 の根拠は「何が出ていないか」なので、**操作パネルを要素単位で撮る**
    // （ウィンドウが短くスライダーが画面外に出るため、全画面 PNG では確認できない）。
    await page.getByTestId("series-controls").screenshot({
      path: path.join(OUT_DIR, "1b-single-run-controls.png"),
    }).catch(() => {});

    const ind0 = await frameIndicator(page);
    check(ind0.total === SINGLE.frames, `[1] フレーム総数が NumberOfFrames と一致（${SINGLE.frames}）`, ind0);

    // ── 条件 5: スライダーが「Frame」1 本だけ ────────────────────────
    const zSlider = await page.getByTestId("dim-slider-z").count();
    const otherSlider = await page.getByTestId("dim-slider-other").count();
    const cineSeek = await page.getByTestId("cine-seek").count();
    check(zSlider === 0, "[5a] Z スライダーが出ていない", { zSlider });
    check(otherSlider === 0, "[5b] もう 1 本の軸スライダーも出ていない（単一ラン）", { otherSlider });
    check(cineSeek === 1, "[5c] シネコントロールが 1 つ出ている", { cineSeek });
    const bodyText = (await page.getByTestId("series-viewer-root").textContent()) ?? "";
    check(!bodyText.includes("ThickSlab"), "[5d] ThickSlab の行が出ていない");
    check(
      !bodyText.includes("グリッド表示は使用できません") && !bodyText.includes("Grid view is unavailable"),
      "[5e] Grid「無効」のヒントが出ていない（フレーム一覧として有効なはず）",
    );

    // ── 条件 3: 最終フレームが表示できる ─────────────────────────────
    const seek = page.getByTestId("cine-seek");
    const firstStats = await pixelStats(page);
    await seek.fill(String(SINGLE.frames - 1));
    await page.waitForTimeout(1_200);
    const lastInd = await frameIndicator(page);
    const lastStats = await pixelStats(page);
    check(lastInd.index === SINGLE.frames, "[3a] 最終フレームまでシークできる", lastInd);
    check(
      !!lastStats && lastStats.nonBlackFraction > 0.05,
      "[3b] 最終フレームに画素が描かれている（真っ黒でない）",
      lastStats,
    );
    check(
      !!firstStats && !!lastStats && Math.abs(firstStats.mean - lastStats.mean) > 0.5,
      "[3c] 先頭フレームと最終フレームの画素が異なる（先頭固定になっていない）",
      { first: firstStats?.mean, last: lastStats?.mean },
    );
    await page.screenshot({ path: path.join(OUT_DIR, "2-last-frame.png") }).catch(() => {});

    // ── 条件 6/7: ホイール送りと setStack ───────────────────────────
    await seek.fill("0");
    await page.waitForTimeout(600);
    const before = await cineStats(page);
    const beforeInd = await frameIndicator(page);
    const host = page.getByTestId(HOST);
    const box = await host.boundingBox();
    if (!box) throw new Error("ビューポートの位置を取得できません");
    for (let i = 0; i < 5; i++) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.wheel(0, 120);
      await page.waitForTimeout(120);
    }
    await page.waitForTimeout(500);
    const afterInd = await frameIndicator(page);
    const after = await cineStats(page);
    check(afterInd.index !== beforeInd.index, "[6] ホイールでフレームが送れる", { beforeInd, afterInd });
    check(
      after.setStackCalls - before.setStackCalls === 0,
      "[7] フレーム送りで setStack が呼ばれていない（毎フレーム再構築していない）",
      { before: before.setStackCalls, after: after.setStackCalls },
    );

    // ── 条件 4: W/L・Pan/Zoom がフレーム切替で維持される ────────────
    // ⚠️ 「変化なし」を確かめる前に、**まず操作が効いていること**を確かめる。
    //    効いていない状態で「変わらなかった」を見ても何も検証したことにならない。
    const stateInitial = await viewportState(page);
    check(
      !!stateInitial && stateInitial.parallelScale !== null && stateInitial.windowLevel !== null,
      "[4-pre] 表示状態（parallelScale / windowLevel）を読めている",
      stateInitial,
    );
    await page.getByTestId("viewer-zoom-in-btn").click();
    await page.waitForTimeout(300);
    await page.getByTestId("viewer-zoom-in-btn").click();
    await page.waitForTimeout(600);
    // W/L と Pan も実際に動かす。バインドは **左=W/L・中ボタン=Pan・右=Zoom**
    // （Viewer2D.tsx の setToolActive。左=Pan と書いてある古い記述に釣られないこと）。
    await dragOnCanvasHost(page, HOST, 60, 40, 0); // 左ドラッグ = W/L
    await page.waitForTimeout(400);
    await dragOnCanvasHost(page, HOST, 40, 30, 1); // 中ボタンドラッグ = Pan
    await page.waitForTimeout(600);
    const stateBefore = await viewportState(page);
    check(
      !!stateInitial?.parallelScale && !!stateBefore?.parallelScale &&
        Math.abs(stateInitial.parallelScale - stateBefore.parallelScale) > 1e-6,
      "[4-pre2] Zoom 操作が実際に効いている（parallelScale が変わった）",
      { initial: stateInitial?.parallelScale, zoomed: stateBefore?.parallelScale },
    );
    check(
      JSON.stringify(stateInitial?.focalPoint) !== JSON.stringify(stateBefore?.focalPoint),
      "[4-pre3] Pan 操作が実際に効いている（focalPoint が変わった）",
      { initial: stateInitial?.focalPoint, panned: stateBefore?.focalPoint },
    );
    check(
      !!stateInitial?.windowLevel && !!stateBefore?.windowLevel &&
        (Math.abs(stateInitial.windowLevel.center - stateBefore.windowLevel.center) > 1e-6 ||
         Math.abs(stateInitial.windowLevel.width - stateBefore.windowLevel.width) > 1e-6),
      "[4-pre3b] W/L 操作が実際に効いている（windowLevel が変わった）",
      { initial: stateInitial?.windowLevel, adjusted: stateBefore?.windowLevel },
    );

    await seek.fill("40");
    await page.waitForTimeout(1_000);
    const stateAfter = await viewportState(page);
    // フレームが本当に変わったこと（変わっていなければ「維持された」は無意味）。
    check(
      !!stateBefore?.imageId && !!stateAfter?.imageId && stateBefore.imageId !== stateAfter.imageId,
      "[4-pre4] フレームが実際に切り替わった（imageId が変わった）",
      { before: stateBefore?.imageId?.slice(-24), after: stateAfter?.imageId?.slice(-24) },
    );
    check(
      !!stateBefore?.parallelScale && !!stateAfter?.parallelScale &&
        Math.abs(stateBefore.parallelScale - stateAfter.parallelScale) < 1e-6,
      "[4a] フレーム切替で Zoom（parallelScale）がリセットされない",
      { before: stateBefore?.parallelScale, after: stateAfter?.parallelScale },
    );
    check(
      !!stateBefore?.windowLevel && !!stateAfter?.windowLevel &&
        Math.abs(stateBefore.windowLevel.center - stateAfter.windowLevel.center) < 1e-6 &&
        Math.abs(stateBefore.windowLevel.width - stateAfter.windowLevel.width) < 1e-6,
      "[4b] フレーム切替で VOI（W/L）がリセットされない",
      { before: stateBefore?.windowLevel, after: stateAfter?.windowLevel },
    );
    // ⚠️ focalPoint は Float32Array を経由するため **1e-5 程度の丸めが必ず乗る**。
    //    厳密一致で比較すると「リセットされた」と誤判定する（実際に一度そうなった）。
    //    Pan のリセットは 10px 単位で効くので、1e-3 の許容差で十分に区別できる。
    const panDrift = !stateBefore?.focalPoint || !stateAfter?.focalPoint
      ? Number.POSITIVE_INFINITY
      : Math.max(...stateBefore.focalPoint.map((v, i) => Math.abs(v - (stateAfter.focalPoint as number[])[i])));
    check(
      panDrift < 1e-3,
      "[4c] フレーム切替で Pan（focalPoint）がリセットされない",
      { before: stateBefore?.focalPoint, after: stateAfter?.focalPoint, drift: panDrift },
    );

    // ── 条件 2: 実測 fps ────────────────────────────────────────────
    await seek.fill("0");
    await page.waitForTimeout(400);
    await page.getByTestId("cine-play").click();
    // 実測 fps は 1 秒窓で更新されるので、数窓ぶん回す。
    await page.waitForTimeout(4_000);
    const playing = await cineStats(page);
    await page.getByTestId("cine-play").click();
    const fpsError = playing.nominalFps > 0 ? Math.abs(playing.measuredFps - playing.nominalFps) / playing.nominalFps : 1;
    check(
      Math.abs(playing.nominalFps - nominalFps) < 0.1,
      `[2a] 公称 fps が FrameTime から決まる（${nominalFps.toFixed(2)}）`,
      { nominalFps: playing.nominalFps, source: playing.fpsSource },
    );
    check(playing.fpsSource === "frameTime", "[2b] fps の決定根拠が FrameTime", playing.fpsSource);
    check(fpsError <= 0.05, "[2c] 実測 fps が公称の ±5% 以内", {
      measured: Number(playing.measuredFps.toFixed(2)),
      nominal: Number(playing.nominalFps.toFixed(2)),
      errorPct: Number((fpsError * 100).toFixed(2)),
    });
    check(playing.framesRendered > 30, "[2d] 再生でフレームが実際に進んでいる", playing.framesRendered);
    await page.screenshot({ path: path.join(OUT_DIR, "3-after-play.png") }).catch(() => {});

    // ══ 複数ラン ═══════════════════════════════════════════════════════
    const multi = buildMultiRunSeries();
    await resetDb(driver.ports.http);
    const impMulti = await importPaths(driver.ports.http, multi);
    console.log(`多ラン取込: ${JSON.stringify(impMulti)}`);
    check(impMulti.imported === multi.length, "[8a] 多ランのシリーズを取り込めた", impMulti);
    await page.reload();
    await openFirstSeries(page);
    const runSlider = page.getByTestId("dim-slider-other");
    const hasRun = (await runSlider.count()) === 1;
    check(hasRun, "[8b] 複数ランで「もう 1 本」のスライダーが出る");
    if (hasRun) {
      const label = (await runSlider.locator("xpath=../span").first().textContent()) ?? "";
      check(!/^\s*Z\s/.test(label), "[8c] ラベルが「Z」ではない（Run 表記）", label);
    }
    const multiInd = await frameIndicator(page);
    check(multiInd.total === SINGLE.frames, "[8d] フレーム軸は最大フレーム数（96）", multiInd);
    await page.screenshot({ path: path.join(OUT_DIR, "4-multi-run.png") }).catch(() => {});
    await page.getByTestId("series-controls").screenshot({
      path: path.join(OUT_DIR, "4b-multi-run-controls.png"),
    }).catch(() => {});

    // ══ 回帰: CT が従来どおりか ════════════════════════════════════════
    await resetDb(driver.ports.http);
    const impCt = await importFixtureCategory(driver.ports.http, "ct-basic");
    console.log(`CT 取込: ${JSON.stringify(impCt)}`);
    await page.reload();
    await openFirstSeries(page);
    const ctZ = await page.getByTestId("dim-slider-z").count();
    const ctCine = await page.getByTestId("cine-seek").count();
    const ctText = (await page.getByTestId("series-viewer-root").textContent()) ?? "";
    check(ctZ === 1, "[9a] CT では Z スライダーが従来どおり出る", { ctZ });
    check(ctCine === 0, "[9b] CT ではシネコントロールが出ない（XA 専用）", { ctCine });
    check(ctText.includes("ThickSlab"), "[9c] CT では ThickSlab の行が従来どおり出る");
    const ctStats = await pixelStats(page);
    check(!!ctStats && ctStats.nonBlackFraction > 0.05, "[9d] CT の画像が描画されている", ctStats);
    await page.screenshot({ path: path.join(OUT_DIR, "5-ct-regression.png") }).catch(() => {});
    await page.getByTestId("series-controls").screenshot({
      path: path.join(OUT_DIR, "5b-ct-controls.png"),
    }).catch(() => {});
  } finally {
    await driver.stop();
  }

  console.log(`\n===== XA シネ（A1）受け入れ条件 =====`);
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
