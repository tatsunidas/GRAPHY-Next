/*
 * GNBP-XA ファントムによる **QCA 精度**と**空間校正の分岐**の検証（A4b）
 * — `fw/angio-design.md` §16.3。
 *
 * 準備:  cd bench && python3 make_phantom_xa.py --out ./phantom
 * 実行:  cd automator && npx tsx src/spike/xaPhantomCheck.ts
 *
 * ここが他の xa*Check.ts と決定的に違う点: **真値がある**。
 * 実データ（Rubo）には真値が無く、しかも幾何タグも無いので、これまでの実機検証は
 * 「動くこと」「内部整合すること」までしか言えていなかった（設計 §8.5）。
 * このファントムだけが「**測った値が正しいか**」に答えられる。
 *
 * 測るのはアプリを通した値（`getQcaState()`）。純関数を直接叩くのではなく
 * DICOM 読み込み → ローダ → 校正 → QCA の**通し**で測る（bench の既存ハーネスと同じ方針）。
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
import { dragSpanMmOnCanvasHost } from "../common/pointerDrag.js";

const REPO_ROOT = path.resolve(AUTOMATOR_ROOT, "..");
const PHANTOM_DIR = path.join(REPO_ROOT, "bench", "phantom", "GNBP-XA");
const TRUTH_PATH = path.join(PHANTOM_DIR, "truth.json");
const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "xa-phantom");
const HOST = "viewer2d-canvas-host";

/**
 * 設計 §16.3 の**目標**値。**現状は MLD が未達**（下の「既知の系統誤差」を参照）。
 *
 * <p>未達を「合格」に書き換えて隠さない。目標未達は `unmet` として別枠で数え、
 * **退行**（現状より悪化）だけを失敗にする。こうしないと、目標を緩めた瞬間に
 * 「合格だが実は測れていない」状態が固定化する。
 */
const TARGET_DS_CLEAN = 2.0;   // %DS 絶対誤差（ノイズ無し）
const TARGET_DS_NOISY = 5.0;   // %DS 絶対誤差（実用ノイズ）
const TARGET_MLD_MM = 0.1;     // MLD 誤差 [mm]
const TOL_CALIB_REL = 0.01;    // mm/px の相対誤差（P0〜P3）

/**
 * 🚨 **半値法の既知の系統誤差**: 円柱投影に対して直径を約 13% 過小に測る。
 *
 * <p>弱吸収近似では、内側と外側の中間値をよぎるのは d = (√3/2)·r ≈ 0.866·r であって
 * d = r ではない（`bench/make_phantom_xa.py` の冒頭に導出）。実測でも真値 3.000mm の
 * 直管が一貫して 2.609mm（係数 0.870）と出ていた。
 *
 * <p>⚠️ **この係数は円柱に固有**（GNBP-XA-7 では 0.745〜0.918 まで動く）。
 * A4c（§16.5）以降、**報告する径は密度計測**になったので、この係数が期待値になるのは
 * **ノイズで密度計測から退避したフレームだけ**。
 */
const KNOWN_DIAMETER_FACTOR = 0.870;
/**
 * 密度計測（§16.5）の期待係数。**形を仮定しない**ので真値そのものが出るはず。
 * 実測: 健常部 1.000 / 病変部（ノイズ無し）0.996〜1.004。
 */
const DENSITOMETRIC_FACTOR = 1.0;
/**
 * 内腔がこの径を下回ると**ぼけが支配**し、係数 0.870 では説明できない（逆に過大に出る）。
 * 実測で切り分けた境界: 0.9mm（4px）はまだ係数どおり（0.767 ≒ 0.9×0.852）、
 * 0.3mm（1.3px）は 0.408mm と 36% 過大。σ0.6px の FWHM は 1.4px＝0.32mm なので、
 * **内腔がぼけ幅と同程度になったところ**が境界という理解と一致する。
 */
const BLUR_LIMITED_MM = 0.5;
/** 現状値からの許容ぶれ（退行検知）。 */
const REGRESSION_MLD_MM = 0.12;
const REGRESSION_DS = 3.0;

const failures: string[] = [];
const unmet: string[] = [];
let passed = 0;

/** 設計目標に届いていない項目。**失敗にはしないが必ず出す**（黙って緩めない）。 */
function target(cond: boolean, label: string, detail?: unknown): void {
  if (cond) {
    passed++;
    console.log(`  [ok  ] ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  } else {
    console.log(`  [未達] ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
    unmet.push(label);
  }
}
function check(cond: boolean, label: string, detail?: unknown): void {
  if (cond) {
    passed++;
    console.log(`  [ok  ] ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  } else {
    console.log(`  [FAIL] ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
    failures.push(label);
  }
}

interface Truth {
  qcaStudyUid?: string;
  geometry: { rows: number; columns: number; mmPerPxAtIsocenter: number };
  qca: {
    file: string;
    studyInstanceUid: string;
    vesselAxisRow: number;
    frames: {
      frame: number;
      percentDiameterStenosis: number;
      percentAreaStenosis: number;
      referenceDiameterMm: number;
      mldMm: number;
      lesionLengthMm: number;
      blurSigmaPx: number;
      photonsPerPixel: number | null;
    }[];
  };
  calibration: {
    studyInstanceUid: string;
    mmPerPx: number;
    variants: {
      key: string;
      file: string;
      seriesInstanceUid: string;
      expectedSource: string;
      expectedMmPerPx: number | null;
    }[];
  };
}

interface QcaState {
  /** どの画像を解析したか。狙ったフレームかを**数値ではなく出自で**確かめる。 */
  imageId: string;
  provenance: { edited: boolean };
  mld: number;
  rvd: number;
  percentDiameterStenosis: number;
  percentAreaStenosis: number;
  lesionLength: number;
  /** 径プロファイルの雑音尺度 σ̂（病変長の当てはめが効く量。単位は径と同じ）。 */
  profileNoise: number;
  /** 径を何で測ったか（§16.5）。期待値をこれで切り替える。 */
  diameterMethod: "half-max" | "densitometric";
  muPerMm: number | null;
  densitometryFallback: string | null;
  points: number;
  unit: string;
}

async function qcaState(page: Page): Promise<QcaState | null> {
  return page.evaluate(() => {
    const dbg = (window as unknown as { __graphyDebug?: { getQcaState?: () => unknown } }).__graphyDebug;
    return (dbg?.getQcaState?.() ?? null) as unknown;
  }) as Promise<QcaState | null>;
}


/**
 * 検索して**指定した StudyInstanceUID の**スタディを開き、シリーズ一覧を出す。
 *
 * <p>⚠️ 「1 件目のスタディ」を掴んではいけない。DB を入れ替えても一覧は自動更新されないので、
 * 1 件目が**前の検査の残骸**のことがある。それを開いてもシリーズは 0 件で、
 * 「シリーズを開けない」という無関係な失敗になる（実際に XA-4 が全滅した）。
 *
 * <p>スタディ行は開閉のトグルなので、既に開いていると 1 回目のクリックで**閉じる**。
 * 「シリーズ行が出ている」ことを条件に押し直す。
 */
async function openStudy(page: Page, studyUid: string): Promise<void> {
  await dismissStartupDialogs(page);
  // 塞がれたまま進むと 30 秒待たされたうえ「クリックできない」としか分からない。
  const blocker = await findBlockingOverlay(page, "search-submit-button");
  if (blocker) throw new Error(`検索ボタンが別の要素に塞がれています: ${blocker}`);
  page.once("dialog", (d) => void d.accept());
  const dateInputs = page.locator('input[type="date"]');
  await dateInputs.nth(0).fill("");
  await dateInputs.nth(1).fill("");
  await page.getByTestId("search-submit-button").click();
  const row = page.locator(`[data-testid="study-row-${studyUid}"]`);
  await row.waitFor({ state: "visible", timeout: 20_000 }).catch(async () => {
    const present = await page.evaluate(
      `Array.from(document.querySelectorAll('[data-testid^="study-row-"]')).map(e => e.getAttribute("data-testid")).join(",")`,
    );
    throw new Error(`スタディが一覧に出ません。want=${studyUid} present=[${present}]`);
  });
  for (let i = 0; i < 3; i++) {
    await row.click();
    await page.waitForTimeout(800);
    if ((await page.locator('[data-testid^="series-row-"]').count()) > 0) return;
  }
  throw new Error(`スタディを開いてもシリーズ行が出ません: ${studyUid}`);
}

/**
 * 血管軸に沿って解析区間を引く。
 *
 * <p>ファントムの血管は画像中央行に横一直線なので、キャンバスの中央を水平に
 * ドラッグすれば必ず血管の上に乗る。狭窄は中央 ±5mm（±22px）にあり、
 * 区間は ±40mm 取るので参照径を当てる健常部が両側に十分残る。
 */
async function selectLengthTool(viewer: Page): Promise<void> {
  await viewer.getByTestId("viewer2d-menu-roi").click();
  await viewer.waitForTimeout(250);
  await viewer.getByText("長さ", { exact: true }).first().click();
  await viewer.waitForTimeout(300);
}

/**
 * 血管軸に沿って解析区間を引く（画像中央 ±``halfSpanMm``）。
 *
 * <p>🚨 ドラッグの座標は**キャンバスの割合**であって画像の割合ではない。画像はキャンバスに
 * fit されるので、実測ではキャンバス 776×212 に対して画像は中央の 193px しか占めていなかった。
 * キャンバス割合 0.3〜0.7 で引くと**画像の外**に始終点が落ち、`tracePath` が null を返して
 * 「解析できない」になる（最初にこれを踏んだ。しかも画面上は線が引けているように見える）。
 *
 * <p>そこで **mm で長さを決める**（`dragSpanMmOnCanvasHost`）。CSS px と描画バッファ px を
 * 取り違えると DPR≠1 の環境で同じ壊れ方をするので、変換はヘルパー側に閉じてある。
 */
async function drawSegment(viewer: Page, halfSpanMm: number): Promise<void> {
  await dragSpanMmOnCanvasHost(viewer, HOST, halfSpanMm);
}

/** ダイアログに出ているエラー文（解析できなかった理由の切り分け用）。 */
async function dialogError(viewer: Page): Promise<string> {
  return viewer.evaluate(() => {
    const panel = document.querySelector('[data-testid="xa-analysis-dialog"]')?.parentElement;
    // 末尾にエラー文が出るので、先頭ではなく**末尾**を残す。
    const t = (panel?.textContent ?? "").replace(/\s+/g, " ");
    return t.slice(-220);
  });
}

async function main(): Promise<void> {
  if (!fs.existsSync(TRUTH_PATH)) {
    throw new Error(
      `ファントムがありません: ${PHANTOM_DIR}\n` +
        `先に "cd bench && python3 make_phantom_xa.py --out ./phantom" を実行してください。`,
    );
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const truth = JSON.parse(fs.readFileSync(TRUTH_PATH, "utf8")) as Truth;
  const qcaFile = path.join(PHANTOM_DIR, truth.qca.file);
  const calibFiles = truth.calibration.variants.map((v) => path.join(PHANTOM_DIR, v.file));

  const rows: Record<string, unknown>[] = [];

  const driver = new DesktopDriver();
  await driver.start();
  try {
    const mainPage = driver.page;
    await resetDb(driver.ports.http);

    // ══ GNBP-XA-1: QCA 精度 ═══════════════════════════════════════
    const imp = await importPaths(driver.ports.http, [qcaFile]);
    if (imp.imported !== 1) throw new Error(`取込に失敗: ${JSON.stringify(imp)}`);

    await waitForMainScreenReady(mainPage, 60_000);
    await dismissStartupDialogs(mainPage);
    await openStudy(mainPage, truth.qca.studyInstanceUid);
    await mainPage.locator('[data-testid^="series-row-"]').first().click();

    const viewer = await driver.waitForNewPage(
      () => mainPage.getByTestId("viewer2d-toolbar-button").click(),
      (url) => url.includes("2dviewer"),
    );
    await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 30_000 });
    await viewer.waitForTimeout(3_000);

    await selectLengthTool(viewer);

    // 装置校正済み（PixelSpacing = 0.225 GEOMETRY）なので、そのまま mm が出るはず。
    for (const t of truth.qca.frames) {
      const frameIndex = t.frame - 1;
      await viewer.getByTestId("cine-seek").fill(String(frameIndex));
      await viewer.waitForTimeout(900);
      // 計測は imageId（＝フレーム）ごとなので、解析するフレームで引き直す。
      await drawSegment(viewer, 40);
      await viewer.getByTestId("xa-analysis-open").click();
      await viewer.getByTestId("xa-analysis-dialog").waitFor({ state: "visible", timeout: 10_000 });
      await viewer.getByTestId("xa-qca-run").click();
      await viewer.waitForTimeout(3_500);
      const st = await qcaState(viewer);
      const diagnosis = st ? undefined : await dialogError(viewer);
      // 🚨 別フレームの結果でも「もっともらしい数値」が出るので、結果の数値ではなく
      //    **解析した imageId** で狙ったフレームかを確かめる。DICOM のフレーム番号は 1 origin。
      const analyzedFrame = /[?&]frame=(\d+)/.exec(st?.imageId ?? "")?.[1];
      await viewer.getByTestId("xa-dialog-close").click();
      await viewer.waitForTimeout(400);

      const noisy = t.photonsPerPixel != null;
      const targetDs = noisy ? TARGET_DS_NOISY : TARGET_DS_CLEAN;
      const label =
        `frame ${t.frame} (%DS ${t.percentDiameterStenosis}, 長 ${t.lesionLengthMm}mm, ` +
        `σ${t.blurSigmaPx}px, ${noisy ? `I0=${t.photonsPerPixel}` : "ノイズ無し"})`;
      if (!st) {
        check(false, `[XA-1] ${label} — 解析できた`, diagnosis);
        continue;
      }
      const dsErr = st.percentDiameterStenosis - t.percentDiameterStenosis;
      const mldErr = st.mld - t.mldMm;
      const rvdErr = st.rvd - t.referenceDiameterMm;
      rows.push({
        frame: t.frame,
        truthDs: t.percentDiameterStenosis,
        measuredDs: Number(st.percentDiameterStenosis.toFixed(2)),
        dsError: Number(dsErr.toFixed(2)),
        truthMld: t.mldMm,
        measuredMld: Number(st.mld.toFixed(3)),
        mldError: Number(mldErr.toFixed(3)),
        truthRvd: t.referenceDiameterMm,
        measuredRvd: Number(st.rvd.toFixed(3)),
        rvdError: Number(rvdErr.toFixed(3)),
        truthLesionLength: t.lesionLengthMm,
        measuredLesionLength: Number(st.lesionLength.toFixed(2)),
        profileNoise: Number((st.profileNoise ?? 0).toFixed(4)),
        unit: st.unit,
        blurSigmaPx: t.blurSigmaPx,
        photons: t.photonsPerPixel,
      });
      check(analyzedFrame === String(t.frame), `[XA-1] ${label} — ★狙ったフレームを解析している`, {
        want: t.frame,
        analyzed: analyzedFrame,
      });
      check(st.unit === "mm", `[XA-1] ${label} — 単位が mm（装置校正済みタグを読めている）`, st.unit);
      // ── 設計目標（未達は隠さず別枠で数える）─────────────────────
      target(Math.abs(dsErr) < targetDs, `[XA-1] ${label} — 【目標】%DS 誤差 < ${targetDs}`, {
        truth: t.percentDiameterStenosis,
        measured: Number(st.percentDiameterStenosis.toFixed(2)),
        error: Number(dsErr.toFixed(2)),
      });
      target(Math.abs(mldErr) < TARGET_MLD_MM, `[XA-1] ${label} — 【目標】MLD 誤差 < ${TARGET_MLD_MM}mm`, {
        truth: t.mldMm,
        measured: Number(st.mld.toFixed(3)),
        error: Number(mldErr.toFixed(3)),
      });
      // ── 退行検知 ──────────────────────────────────────────────
      // 🔑 **期待値はアプリが「どちらで測った」と言っているかで切り替える**。
      //    密度計測なら真値そのもの、ノイズで退避した半値法なら真値 × 0.870。
      //    方式を見ずに 1 つの期待値で突き合わせると、退避が起きた瞬間に
      //    嘘の失敗（または嘘の合格）になる。
      const densito = st.diameterMethod === "densitometric";
      check(
        st.diameterMethod === "densitometric" || st.diameterMethod === "half-max",
        `[XA-1] ${label} — 径をどちらで測ったかを申告している`,
        { method: st.diameterMethod, mu: st.muPerMm, fallback: st.densitometryFallback },
      );
      const factor = densito ? DENSITOMETRIC_FACTOR : KNOWN_DIAMETER_FACTOR;
      const expectedRvd = t.referenceDiameterMm * factor;
      check(
        Math.abs(st.rvd - expectedRvd) < REGRESSION_MLD_MM,
        `[XA-1] ${label} — 参照径が測り方どおり（${densito ? "密度計測＝真値" : `半値法＝真値 × ${KNOWN_DIAMETER_FACTOR}`}）`,
        { expected: Number(expectedRvd.toFixed(3)), measured: Number(st.rvd.toFixed(3)) },
      );
      // 内腔がぼけの幅に近づくと、係数 0.870 では説明できなくなる（ぼけが支配して**過大**に出る）。
      // 実測: 真値 0.3mm（=1.3px）の 90% 狭窄で 0.408mm と、逆に 36% 過大。
      // 「細いほど過小になる」と思い込まないための境界なので、**上限としても**確かめる。
      if (!noisy && t.mldMm >= BLUR_LIMITED_MM) {
        const expectedMld = t.mldMm * factor;
        check(
          Math.abs(st.mld - expectedMld) < REGRESSION_MLD_MM,
          `[XA-1] ${label} — MLD も同じ係数で説明できる`,
          { expected: Number(expectedMld.toFixed(3)), measured: Number(st.mld.toFixed(3)) },
        );
      } else if (!noisy && densito) {
        // ★ A4c の最大の利得。**ぼけ幅以下の内腔でも面積が残る**（畳み込みは積分を保存する）。
        //   半値法はここで内腔を 36% 過大に測っていた（下の else 節）。
        check(
          Math.abs(st.mld - t.mldMm) < 0.1,
          `[XA-1] ${label} — ★ぼけ幅以下の内腔でも密度計測なら真値どおり（半値法は 36% 過大だった）`,
          { truth: t.mldMm, measured: Number(st.mld.toFixed(3)) },
        );
      } else if (!noisy) {
        check(
          st.mld > t.mldMm,
          `[XA-1] ${label} — ぼけ幅以下の内腔は半値法だと**過大**に出る（過小と思い込まない）`,
          { truth: t.mldMm, measured: Number(st.mld.toFixed(3)) },
        );
      }
      if (t.lesionLengthMm > 0) {
        check(
          Math.abs(st.lesionLength - t.lesionLengthMm) < 1.0,
          `[XA-1] ${label} — 病変長 誤差 < 1.0mm`,
          { truth: t.lesionLengthMm, measured: Number(st.lesionLength.toFixed(2)) },
        );
      }
    }
    fs.writeFileSync(path.join(OUT_DIR, "qca-accuracy.json"), JSON.stringify(rows, null, 2));
    console.table(rows);
    await viewer.screenshot({ path: path.join(OUT_DIR, "1-qca-phantom.png") }).catch(() => {});
    await viewer.close().catch(() => {});

    // ══ GNBP-XA-4: 空間校正の分岐（§7.2）══════════════════════════
    // 実データ（Rubo）は P6 しか踏めない。P1〜P4 を通すのはこのファントムだけ。
    await resetDb(driver.ports.http);
    const impCalib = await importPaths(driver.ports.http, calibFiles);
    check(
      impCalib.imported === calibFiles.length,
      `[XA-4] 校正変種 ${calibFiles.length} 本を取り込める`,
      impCalib,
    );
    // DB を入れ替えたので画面を作り直す。⚠️ 再読み込み直後は**アプリ内更新通知**が前面に出て
    //    クリックを吸うので、`dismissStartupDialogs`（✕ にも対応）を必ず通す。
    await mainPage.reload();
    await waitForMainScreenReady(mainPage, 60_000);
    await mainPage.waitForTimeout(1_500);
    await openStudy(mainPage, truth.calibration.studyInstanceUid);

    for (const v of truth.calibration.variants) {
      const row = mainPage.locator(`[data-testid="series-row-${v.seriesInstanceUid}"]`);
      await row.waitFor({ state: "visible", timeout: 10_000 }).catch(() => {});
      if ((await row.count()) === 0) {
        const present = await mainPage.evaluate(
          `Array.from(document.querySelectorAll('[data-testid^="series-row-"]')).map(e => e.getAttribute("data-testid")).join(",")`,
        );
        check(false, `[XA-4] ${v.key} — シリーズを開ける`, { want: v.seriesInstanceUid, present });
        continue;
      }
      await row.click();
      await mainPage.waitForTimeout(400);
      const vp = await driver.waitForNewPage(
        () => mainPage.getByTestId("viewer2d-toolbar-button").click(),
        (url) => url.includes("2dviewer"),
      );
      await vp.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 30_000 });
      await vp.waitForTimeout(2_500);
      await vp.getByTestId("xa-analysis-open").click();
      await vp.getByTestId("xa-analysis-dialog").waitFor({ state: "visible", timeout: 10_000 });
      const statusText = (await vp.getByTestId("xa-calib-status").textContent()) ?? "";
      const mmMatch = /([\d.]+)\s*mm\/px/.exec(statusText);
      const measured = mmMatch ? Number(mmMatch[1]) : null;
      await vp.screenshot({ path: path.join(OUT_DIR, `2-calib-${v.key}.png`) }).catch(() => {});
      await vp.close().catch(() => {});

      // 画面には日本語ラベルが出るので、期待する source のラベルで突き合わせる。
      const labels: Record<string, RegExp> = {
        "dicom-fiducial": /FIDUCIAL/,
        "dicom-geometry": /GEOMETRY/,
        "geometric-sid-sod": /SID\/SOD/,
        "detector-plane": /検出器面|Detector plane/,
      };
      const want = labels[v.expectedSource];
      check(
        !!want && want.test(statusText),
        `[XA-4] ${v.key} — §7.2 が期待した経路（${v.expectedSource}）に解決する`,
        statusText.trim(),
      );
      if (v.expectedMmPerPx == null) {
        // P6: mm を出さないのが正しい挙動。
        check(measured == null, `[XA-4] ${v.key} — 校正できないので mm/px を出さない`, measured);
      } else {
        const rel = measured == null ? 1 : Math.abs(measured - v.expectedMmPerPx) / v.expectedMmPerPx;
        check(rel < TOL_CALIB_REL, `[XA-4] ${v.key} — mm/px の相対誤差 < ${TOL_CALIB_REL}`, {
          expected: v.expectedMmPerPx,
          measured,
          rel: Number(rel.toFixed(5)),
        });
      }
    }
  } finally {
    await driver.stop();
  }

  console.log(`\n===== GNBP-XA（A4b）精度検証 =====`);
  console.log(`合格 ${passed} / 退行 ${failures.length} / 設計目標に未達 ${unmet.length}`);
  if (failures.length) {
    console.log("★退行（現状より悪化。直すこと）:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  }
  if (unmet.length) {
    console.log("設計目標に未達（既知。半値法の系統誤差 — 設計 §16.4）:");
    for (const f of unmet) console.log(`  - ${f}`);
  }
  console.log(`結果: ${OUT_DIR}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
