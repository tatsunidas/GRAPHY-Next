/*
 * 動画 ROI 解析の**フレーム精度**の実機検証（`fw/video-viewer-design.md` §10-3 / §12 残タスク）。
 *
 * 実行:  cd automator && npx tsx src/spike/videoFrameAccuracyCheck.ts
 *
 * 何を確かめるか: 「フレーム f の統計」と言っている値が**本当にフレーム f のもの**か。
 * 解析はオフスクリーン `<video>` の `currentTime` シーク（`videoRoiAnalysis.ts` の `createFrameSampler`）で
 * フレームを取り出すため、設計上は **GOP 近似で 1 フレームずれうる**ことが懸念として挙がっていた。
 *
 * 測り方（ずれを検出できるフィクスチャを作る）:
 *   - `geq=lum='16 + mod(N*13,30)*7'` … **フレーム番号 N ごとに輝度が飛び飛びに変わる**一様グレー動画。
 *     隣接フレームの輝度差が大きい（mod 13 の巡回）ので、1 フレームずれれば値が全く違う。
 *   - **キーフレームは先頭だけ**（`-g 250 -sc_threshold 0`）＝ GOP 近似の影響が最も出る条件。
 *   - 読み取り値は「限定レンジ↔フルレンジ」変換の分だけ符号化値と定数倍ずれるので、**測定値を
 *     符号化レベルへ最小二乗で当てはめ**（2 パラメータ）、残差と「最も近い候補フレーム」で判定する。
 *     フレームがずれていれば候補の巡回列と一致しないため残差が跳ね上がる。
 *   - 一様フレームなので SD が小さいことも確認する（複数フレームの混ざりや途中フレームの合成を検出）。
 *
 * 前提: backend jar（`cd backend && mvn -q -Dfrontend.skip=true -DskipTests package`）。
 * フィクスチャは無ければ ffmpeg で自動生成する（`fixtures/video-mp4-avi/frame-accuracy/`）。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importNonDicomPaths } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { dragOnCanvasHost } from "../common/pointerDrag.js";
import { waitForMainScreenReady } from "../checklist/items/shared/helpers.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "video-frame-accuracy");
const FIXTURE_DIR = path.join(AUTOMATOR_ROOT, "fixtures", "video-mp4-avi", "frame-accuracy");
const HOST = "video-viewport-host";

const N_FRAMES = 30;
const FPS = 15;
/** フレーム f（1-based）に符号化した輝度（Y）。mod 13 の巡回で隣接フレーム差を大きくする。 */
const levelOf = (f: number): number => 16 + ((13 * (f - 1)) % N_FRAMES) * 7;

const failures: string[] = [];
let passed = 0;
function check(cond: boolean, label: string, detail?: unknown): void {
  if (cond) {
    passed++;
    console.log(`  [ok  ] ${label}`);
  } else {
    console.log(`  [FAIL] ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
    failures.push(label);
  }
}

function ensureFixtureVideo(): string {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  const out = path.join(FIXTURE_DIR, "frame-steps.mp4");
  if (fs.existsSync(out)) {
    return out;
  }
  console.log(`フィクスチャ動画を ffmpeg で合成します: ${out}`);
  execFileSync(
    "ffmpeg",
    [
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", `color=c=black:s=320x240:r=${FPS}:d=${N_FRAMES / FPS}`,
      "-vf", `geq=lum='16 + mod(N*13,${N_FRAMES})*7':cb=128:cr=128,format=yuv420p`,
      "-c:v", "libx264", "-profile:v", "high", "-level:v", "4.1",
      // キーフレームは先頭だけ（GOP 近似の影響が最大になる条件で測る）。
      "-g", "250", "-sc_threshold", "0",
      "-pix_fmt", "yuv420p",
      out,
    ],
    { stdio: "inherit" },
  );
  return out;
}

/** シークバーでフレームを移動して、実際に落ち着いたフレームを返す。 */
async function seekToFrame(page: Page, frame: number): Promise<number> {
  await page.evaluate(`
    (function (f) {
      var el = document.querySelector('[data-testid="video-seek"]');
      if (!el) throw new Error("video-seek が見つかりません");
      var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      setter.call(el, String(f));
      el.dispatchEvent(new Event("input", { bubbles: true }));
    })(${frame})
  `);
  const seek = page.getByTestId("video-seek");
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(100);
    if (Number(await seek.inputValue()) === frame) {
      return frame;
    }
  }
  return Number(await seek.inputValue());
}

/** 「フレーム統計」を実行して要約テキストの数値（平均・最小・最大・SD）を読む。 */
async function frameStats(
  page: Page,
  frame: number,
): Promise<{ mean: number; min: number; max: number; sd: number; landedFrame: number; titleFrame: number }> {
  const landedFrame = await seekToFrame(page, frame);
  // ⚠ 前回のパネルを必ず閉じてから実行する。開いたままだと**前のフレームの値**を読んでしまう。
  const close = page.getByTestId("video-frame-stats-close");
  if ((await close.count()) > 0) {
    await close.click();
    await page.getByTestId("video-frame-stats-panel").waitFor({ state: "detached", timeout: 10_000 }).catch(() => {});
  }
  await page.getByTestId("video-frame-stats").click();
  await page.getByTestId("video-frame-stats-panel").waitFor({ state: "visible", timeout: 30_000 });
  const txt = ((await page.getByTestId("video-frame-stats-summary").textContent()) ?? "").trim();
  // "Area 4152 px² · Mean 85.7 · Range 71–101 · SD 7.6" / ja も数値の並びは同じ順。
  const nums = (txt.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
  // [area, mean, min, max, sd]
  const [, mean, min, max, sd] = nums;
  // パネル見出しは「ROI statistics — frame N」。**解析されたフレーム**を確かめる（要求と食い違えばそれが原因）。
  const title = ((await page.getByTestId("video-frame-stats-panel").locator("strong").first().textContent()) ?? "").trim();
  const titleFrame = Number((title.match(/(\d+)/) ?? [])[1] ?? NaN);
  console.log(`    frame ${frame}: level=${levelOf(frame)} / シーク後=${landedFrame} / パネル=${titleFrame} → ${txt}`);
  return { mean, min, max, sd, landedFrame, titleFrame };
}

/** y ≈ a*x + b を最小二乗で当てはめる。 */
function fitLinear(xs: number[], ys: number[]): { a: number; b: number } {
  const n = xs.length;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
  }
  const a = sxx === 0 ? 0 : sxy / sxx;
  return { a, b: my - a * mx };
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const video = ensureFixtureVideo();
  console.log(`検証に使う動画: ${video}（${N_FRAMES} フレーム / キーフレームは先頭のみ）`);

  const driver = new DesktopDriver();
  await driver.start();
  try {
    await resetDb(driver.ports.http);
    const imp = await importNonDicomPaths(driver.ports.http, [video], {
      patientId: "VIDEO-ACC",
      patientName: "VIDEO^ACCURACY",
      seriesDescription: "frame accuracy",
    });
    console.log(`取込結果: ${JSON.stringify(imp)}`);
    if (imp.imported !== 1) {
      throw new Error(`動画の DICOM 化取込に失敗しました: ${JSON.stringify(imp)}`);
    }

    const page = driver.page;
    await waitForMainScreenReady(page, 60_000);
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
    const ok = await page
      .getByTestId("video-tool-rectangle")
      .waitFor({ state: "visible", timeout: 60_000 })
      .then(() => true)
      .catch(() => false);
    check(ok, "VideoViewport（方式 A）で開く");
    if (!ok) {
      throw new Error("方式 B フォールバックのため ROI 解析の検証ができません");
    }
    await page.waitForTimeout(800);
    check(
      Number(await page.getByTestId("video-seek").getAttribute("max")) === N_FRAMES,
      `フレーム数が ${N_FRAMES} と認識される`,
      await page.getByTestId("video-seek").getAttribute("max"),
    );

    // グローバル ROI（矩形）を中央に置く。一様フレームなので位置は問わない。
    await page.getByTestId("video-tool-rectangle").click();
    await page.waitForTimeout(200);
    await dragOnCanvasHost(page, HOST, 80, 60, 0, 12, { fracX: 0.35, fracY: 0.35 });
    await page.waitForTimeout(600);
    check((await page.getByTestId("video-roi-chip").count()) === 1, "ROI を 1 つ描けた");
    await page.screenshot({ path: path.join(OUT_DIR, "0-roi.png") }).catch(() => {});

    // ── 各フレームの統計を読む（先頭・末尾・中間・隣接ペアを含める）。
    const probeFrames = [1, 2, 3, 8, 15, 16, 23, 29, 30];
    const measured: { frame: number; mean: number; sd: number; landedFrame: number; titleFrame: number }[] = [];
    for (const f of probeFrames) {
      const s = await frameStats(page, f);
      measured.push({ frame: f, mean: s.mean, sd: s.sd, landedFrame: s.landedFrame, titleFrame: s.titleFrame });
    }
    check(
      measured.every((m) => m.landedFrame === m.frame),
      "要求したフレームへ実際に移動できる（末尾フレームも含む）",
      measured.filter((m) => m.landedFrame !== m.frame).map((m) => ({ req: m.frame, landed: m.landedFrame })),
    );
    check(
      measured.every((m) => m.titleFrame === m.frame),
      "解析されたフレームが要求フレームと一致する（パネル見出し）",
      measured.filter((m) => m.titleFrame !== m.frame).map((m) => ({ req: m.frame, panel: m.titleFrame })),
    );
    await page.screenshot({ path: path.join(OUT_DIR, "1-last-frame-stats.png") }).catch(() => {});

    check(
      measured.every((m) => Number.isFinite(m.mean)),
      "全ての測定フレームで平均が読める",
      measured,
    );
    check(
      measured.every((m) => m.sd < 4),
      "一様フレームなので SD が小さい（複数フレームの混合ではない）",
      measured.map((m) => ({ f: m.frame, sd: m.sd })),
    );

    // ── 符号化レベル → 測定値 の線形当てはめ（限定レンジ変換の定数倍を吸収する）。
    const xs = measured.map((m) => levelOf(m.frame));
    const ys = measured.map((m) => m.mean);
    const { a, b } = fitLinear(xs, ys);
    const resid = measured.map((m, i) => ys[i] - (a * xs[i] + b));
    const maxResid = Math.max(...resid.map(Math.abs));
    console.log(`    当てはめ: measured ≈ ${a.toFixed(3)} * level + ${b.toFixed(2)}、最大残差 ${maxResid.toFixed(2)}`);
    check(a > 0.5, "測定値が符号化レベルに比例している", { a, b });
    // 1 フレームずれると level は 7*13 = 91 以上変わる（＝測定値で 90 前後）。残差 5 以内なら「ずれ無し」。
    check(maxResid < 5, "全フレームで残差 < 5（1 フレームのずれがあれば ~90 になる）", {
      maxResid,
      resid: resid.map((r) => Number(r.toFixed(2))),
    });

    // ── 「最も近い候補フレーム」が要求フレームと一致すること（絶対的な同定）。
    const misidentified: { requested: number; nearest: number }[] = [];
    for (const m of measured) {
      let best = 1;
      let bestErr = Infinity;
      for (let f = 1; f <= N_FRAMES; f++) {
        const err = Math.abs(m.mean - (a * levelOf(f) + b));
        if (err < bestErr) {
          bestErr = err;
          best = f;
        }
      }
      if (best !== m.frame) {
        misidentified.push({ requested: m.frame, nearest: best });
      }
    }
    check(misidentified.length === 0, "測定値から同定されるフレームが要求フレームと一致する", misidentified);

    // ── 時系列解析（全 30 フレーム）でも同じ巡回パターンが出ること。
    await page.getByTestId("video-analyze-run").click();
    await page.getByTestId("video-analyze-summary").waitFor({ state: "visible", timeout: 120_000 });
    const summary = ((await page.getByTestId("video-analyze-summary").textContent()) ?? "").trim();
    console.log(`    TIC 要約: ${summary}`);
    const ticNums = (summary.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
    // [mean, min, max, sd]。全レベルを走るので min/max は端のフレームの値に近いはず。
    const loExpect = a * levelOf(1) + b;
    const hiExpect = a * Math.max(...Array.from({ length: N_FRAMES }, (_, i) => levelOf(i + 1))) + b;
    check(
      ticNums.length >= 3 && Math.abs(ticNums[1] - loExpect) < 8 && Math.abs(ticNums[2] - hiExpect) < 8,
      "時系列解析の min/max が符号化レベルの端と一致する（全フレームを正しく走査している）",
      { ticNums, loExpect: Number(loExpect.toFixed(1)), hiExpect: Number(hiExpect.toFixed(1)) },
    );
    await page.screenshot({ path: path.join(OUT_DIR, "2-tic.png") }).catch(() => {});
  } finally {
    await driver.stop();
  }

  console.log("\n=== 結果 ===");
  if (failures.length === 0) {
    console.log(`${passed} 項目すべて OK。スクリーンショット: ${OUT_DIR}`);
  } else {
    console.log(`${passed} 項目 OK / FAIL ${failures.length} 件:`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  }
}

await main();
