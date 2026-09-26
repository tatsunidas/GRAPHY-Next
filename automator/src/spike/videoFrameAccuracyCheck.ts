/*
 * 動画ビューアの**フレーム精度**の実機検証（`fw/video-viewer-design.md` §10-3）。
 *
 * 実行:  cd automator && npx tsx src/spike/videoFrameAccuracyCheck.ts
 *
 * 何を確かめるか: 「フレーム f」と表示しているとき、**画面に描かれている絵が本当にフレーム f か**。
 * シークバー（任意のフレームへ飛ぶ）と ▶（1 フレームずつ送る）の両方で確かめる。
 *
 * ⚠ 2026-09-26（段 A3）: 以前は動画ビューア独自の「フレーム統計」「グローバル ROI 解析」の値で測っていた。
 *   ROI の UI を 2D ビューアの ROI 機能へ一本化したので、**画面の描画面（canvas）の画素**で測る形に
 *   置き換えた。全フレームの時系列解析（旧 TIC）の判定は、グローバル ROI（段 C）の検査へ移す。
 *
 * 測り方（ずれを検出できるフィクスチャを作る）:
 *   - `geq=lum='16 + mod(N*13,30)*7'` … **フレーム番号 N ごとに輝度が飛び飛びに変わる**一様グレー動画。
 *     隣接フレームの輝度差が大きい（mod 13 の巡回）ので、1 フレームずれれば値が全く違う。
 *   - **キーフレームは先頭だけ**（`-g 250 -sc_threshold 0`）＝ GOP 近似の影響が最も出る条件。
 *   - 読み取り値は「限定レンジ↔フルレンジ」変換の分だけ符号化値と定数倍ずれるので、**測定値を
 *     符号化レベルへ最小二乗で当てはめ**（2 パラメータ）、残差と「最も近い候補フレーム」で判定する。
 *     フレームがずれていれば候補の巡回列と一致しないため残差が跳ね上がる。
 *   - 一様フレームなので、中央の区画の SD が小さいことも確認する（途中フレームの合成を検出）。
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

/** 画面の描画面（canvas）の中央 16×16 の区画の輝度の平均と SD。ROI の枠などは SVG なので乗らない。 */
async function readCenterPatch(page: Page): Promise<{ mean: number; sd: number }> {
  return page.evaluate(() => {
    const c = document.querySelector('[data-testid="video-viewport-host"] canvas') as HTMLCanvasElement | null;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return { mean: Number.NaN, sd: Number.NaN };
    const d = ctx.getImageData(Math.floor(c.width / 2) - 8, Math.floor(c.height / 2) - 8, 16, 16).data;
    const ys: number[] = [];
    for (let i = 0; i < d.length; i += 4) ys.push((d[i] + d[i + 1] + d[i + 2]) / 3);
    const mean = ys.reduce((a, v) => a + v, 0) / ys.length;
    const sd = Math.sqrt(ys.reduce((a, v) => a + (v - mean) ** 2, 0) / ys.length);
    return { mean, sd };
  });
}

/** シークバーでフレーム f へ飛び、画面に描かれた絵と「フレーム n / N」の表示を読む。 */
async function screenStats(
  page: Page,
  frame: number,
): Promise<{ mean: number; sd: number; landedFrame: number; shownFrame: number }> {
  const landedFrame = await seekToFrame(page, frame);
  await page.waitForTimeout(400); // シーク後の描画を待つ
  const { mean, sd } = await readCenterPatch(page);
  const shown = ((await page.getByTestId("video-frame-number").textContent()) ?? "").trim();
  const shownFrame = Number((shown.match(/(\d+)\s*\//) ?? [])[1] ?? NaN);
  console.log(`    frame ${frame}: level=${levelOf(frame)} / シーク後=${landedFrame} / 表示=${shown} → 平均 ${mean.toFixed(1)} SD ${sd.toFixed(1)}`);
  return { mean, sd, landedFrame, shownFrame };
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
      .getByTestId("video-display-bar")
      .waitFor({ state: "visible", timeout: 60_000 })
      .then(() => true)
      .catch(() => false);
    check(ok, "VideoViewport（方式 A）で開く");
    if (!ok) {
      throw new Error("方式 B フォールバックのため画面の絵の検証ができません");
    }
    await page.waitForTimeout(800);
    check(
      Number(await page.getByTestId("video-seek").getAttribute("max")) === N_FRAMES,
      `フレーム数が ${N_FRAMES} と認識される`,
      await page.getByTestId("video-seek").getAttribute("max"),
    );

    // ── シークバーで飛んだ先の絵を読む（先頭・末尾・中間・隣接ペアを含める）。
    const probeFrames = [1, 2, 3, 8, 15, 16, 23, 29, 30];
    const measured: { frame: number; mean: number; sd: number; landedFrame: number; shownFrame: number }[] = [];
    for (const f of probeFrames) {
      const s = await screenStats(page, f);
      measured.push({ frame: f, mean: s.mean, sd: s.sd, landedFrame: s.landedFrame, shownFrame: s.shownFrame });
    }
    check(
      measured.every((m) => m.landedFrame === m.frame),
      "要求したフレームへ実際に移動できる（末尾フレームも含む）",
      measured.filter((m) => m.landedFrame !== m.frame).map((m) => ({ req: m.frame, landed: m.landedFrame })),
    );
    check(
      measured.every((m) => m.shownFrame === m.frame),
      "「フレーム n / N」の表示が要求フレームと一致する",
      measured.filter((m) => m.shownFrame !== m.frame).map((m) => ({ req: m.frame, shown: m.shownFrame })),
    );
    await page.screenshot({ path: path.join(OUT_DIR, "1-last-frame.png") }).catch(() => {});

    check(
      measured.every((m) => Number.isFinite(m.mean)),
      "全ての測定フレームで画面の絵が読める",
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

    // ── 画面に出ている絵そのもので「1 フレームずつ進む」を確かめる（2026-09-25）
    // ここではシークバーではなく ▶ を 1 回ずつ押し、描画面の中央の画素と「フレーム n / N」の表示を読む。
    const readCenter = async (): Promise<number> => (await readCenterPatch(page)).mean;
    await seekToFrame(page, 1);
    await page.waitForTimeout(400);
    const drawn: { frame: number; shown: string; value: number }[] = [];
    for (let n = 1; n <= N_FRAMES; n++) {
      if (n > 1) {
        await page.getByTestId("video-frame-next").click();
        await page.waitForTimeout(250);
      }
      drawn.push({
        frame: n,
        shown: ((await page.getByTestId("video-frame-number").textContent()) ?? "").trim(),
        value: await readCenter(),
      });
    }
    const badNumber = drawn.filter((d) => !d.shown.includes(`${d.frame} / ${N_FRAMES}`));
    check(badNumber.length === 0, "▶ を 1 回押すごとに「フレーム n / N」が 1 ずつ進む（1〜30）", badNumber.slice(0, 5));
    const fitDrawn = fitLinear(drawn.map((d) => levelOf(d.frame)), drawn.map((d) => d.value));
    const drawnMismatch = drawn
      .map((d) => {
        let best = 1;
        let bestErr = Number.POSITIVE_INFINITY;
        for (let f = 1; f <= N_FRAMES; f++) {
          const err = Math.abs(fitDrawn.a * levelOf(f) + fitDrawn.b - d.value);
          if (err < bestErr) {
            bestErr = err;
            best = f;
          }
        }
        return { requested: d.frame, nearest: best, value: Number(d.value.toFixed(1)) };
      })
      .filter((m) => m.nearest !== m.requested);
    check(
      fitDrawn.a > 0.5 && drawnMismatch.length === 0,
      "★★画面に描かれた絵そのものが、各フレームに符号化した輝度と一致する（末尾の 30 も含む）",
      { a: Number(fitDrawn.a.toFixed(3)), mismatches: drawnMismatch.slice(0, 5) },
    );

    // ── 表示領域の幅を変えても絵が引き伸ばされない（描画面の解像度が表示の大きさに追従する）
    const canvasFit = (): Promise<{ w: number; h: number; cw: number; ch: number }> =>
      page.evaluate(() => {
        const c = document.querySelector('[data-testid="video-viewport-host"] canvas') as HTMLCanvasElement;
        return { w: c.width, h: c.height, cw: c.clientWidth, ch: c.clientHeight };
      });
    const before = await canvasFit();
    await page.evaluate(() => {
      const host = document.querySelector('[data-testid="video-viewport-host"]') as HTMLElement;
      host.style.width = "55%";
    });
    await page.waitForTimeout(800);
    const after = await canvasFit();
    check(
      before.w === before.cw && before.h === before.ch && after.w === after.cw && after.h === after.ch && after.cw < before.cw,
      "★表示の幅を変えても、描画面の解像度が表示の大きさに合っている（縦横比が崩れない）",
      { before, after },
    );
    await page.screenshot({ path: path.join(OUT_DIR, "3-resized.png") }).catch(() => {});
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
