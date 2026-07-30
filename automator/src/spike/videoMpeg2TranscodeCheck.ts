/*
 * P4（配信時の ffmpeg 変換）の実機検証 — MPEG2 の DICOM video を再生できることを確かめる。
 *
 * 実行:  cd automator && npx tsx src/spike/videoMpeg2TranscodeCheck.ts
 *
 * 背景: `/rendered` は P1 では無変換配信のみで、MPEG2 等ブラウザ非対応の転送構文は 415 を返していた
 * （`fw/video-viewer-design.md` §4.3 / P4）。P4 で `VideoRenderService` がペイロードの中身を見て
 * 「MP4 はそのまま／H.264・HEVC の基本ストリームは remux／MPEG2 等は再エンコード」に振り分ける。
 *
 * 確かめること:
 *   1. `/video-metadata` が transcodeRequired=true・transcodeAvailable=true を返す
 *   2. `/rendered` が 200 / video/mp4 / 先頭が ftyp（＝変換されて MP4 になっている）＋ Range で 206
 *   3. 変換結果が `<storageDir>/.cache/video/{sop}.mp4` にキャッシュされ、2 回目は再変換しない
 *   4. UI が「ffmpeg が無い」案内ではなく **VideoViewport で再生** できる（ツールバーが出る・フレーム数 30）
 *   5. **変換でフレームが入れ替わっていない**（フレームごとに輝度が飛び飛びの動画なので、
 *      ROI のフレーム統計を符号化レベルへ線形当てはめして残差で判定できる）
 *
 * フィクスチャ: 取込経路は非 H.264 を**取込時に**変換してしまうため、MPEG2 のままの DICOM は
 * `automator/scripts/make-mpeg2-video-dicom.py`（ffmpeg ＋ pydicom）で直接組み立てる。
 * python3 / pydicom が無い環境では skip する。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";

import { DesktopDriver, DESKTOP_RUN_DATA_DIR } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { dragOnCanvasHost } from "../common/pointerDrag.js";
import { waitForMainScreenReady } from "../checklist/items/shared/helpers.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "video-mpeg2-transcode");
const FIXTURE_DIR = path.join(AUTOMATOR_ROOT, "fixtures", "video-mp4-avi", "mpeg2");
const FIXTURE = path.join(FIXTURE_DIR, "mpeg2-video.dcm");
const GENERATOR = path.join(AUTOMATOR_ROOT, "scripts", "make-mpeg2-video-dicom.py");
const HOST = "video-viewport-host";

const N_FRAMES = 30;
/** 生成スクリプトと同じ式。フレーム f（1-based）に符号化した輝度。 */
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

/** MPEG2 の DICOM video を用意する（無ければ python3 + pydicom で生成。作れなければ null）。 */
function ensureFixture(): string | null {
  if (fs.existsSync(FIXTURE)) {
    return FIXTURE;
  }
  try {
    execFileSync("python3", ["-c", "import pydicom"], { stdio: "ignore" });
  } catch {
    return null;
  }
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  console.log(`MPEG2 の DICOM を合成します: ${FIXTURE}`);
  execFileSync("python3", [GENERATOR, FIXTURE, "--frames", String(N_FRAMES), "--fps", "15"], { stdio: "inherit" });
  return FIXTURE;
}

async function seekToFrame(page: Page, frame: number): Promise<number> {
  await page.evaluate(`
    (function (f) {
      var el = document.querySelector('[data-testid="video-seek"]');
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

/** 「フレーム統計」の平均を読む（開いたままだと前の値を掴むので必ず閉じてから開く）。 */
async function frameMean(page: Page, frame: number): Promise<number> {
  await seekToFrame(page, frame);
  const close = page.getByTestId("video-frame-stats-close");
  if ((await close.count()) > 0) {
    await close.click();
    await page.getByTestId("video-frame-stats-panel").waitFor({ state: "detached", timeout: 10_000 }).catch(() => {});
  }
  await page.getByTestId("video-frame-stats").click();
  await page.getByTestId("video-frame-stats-panel").waitFor({ state: "visible", timeout: 30_000 });
  const txt = ((await page.getByTestId("video-frame-stats-summary").textContent()) ?? "").trim();
  const nums = (txt.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
  console.log(`    frame ${frame}: level=${levelOf(frame)} → ${txt}`);
  return nums[1];
}

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
  return { a: sxx === 0 ? 0 : sxy / sxx, b: my - (sxx === 0 ? 0 : sxy / sxx) * mx };
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const fixture = ensureFixture();
  if (!fixture) {
    console.log("python3 + pydicom が無いため MPEG2 の DICOM を用意できません。skip します。");
    return;
  }

  const driver = new DesktopDriver();
  await driver.start();
  try {
    await resetDb(driver.ports.http);
    const imp = await importPaths(driver.ports.http, [fixture]);
    console.log(`取込結果: ${JSON.stringify(imp)}`);
    check(imp.imported === 1, "MPEG2 の DICOM を取り込める", imp);

    const base = `http://127.0.0.1:${driver.ports.http}`;
    const studies = (await (await fetch(`${base}/api/studies`)).json()) as { studyInstanceUid: string }[];
    const series = (await (
      await fetch(`${base}/api/studies/${studies[0].studyInstanceUid}/series`)
    ).json()) as { seriesInstanceUid: string }[];
    const instances = (await (
      await fetch(
        `${base}/api/studies/${studies[0].studyInstanceUid}/series/${series[0].seriesInstanceUid}/instances`,
      )
    ).json()) as { sopInstanceUid: string }[];
    const sop = instances[0].sopInstanceUid;

    // ── 1. メタデータ
    const meta = (await (await fetch(`${base}/api/instances/${sop}/video-metadata`)).json()) as {
      numberOfFrames: number;
      fps: number;
      transferSyntaxUid: string;
      transcodeRequired: boolean;
      transcodeAvailable: boolean;
    };
    console.log(`video-metadata: ${JSON.stringify(meta)}`);
    check(meta.transferSyntaxUid === "1.2.840.10008.1.2.4.100", "転送構文が MPEG2 MP@ML のまま", meta.transferSyntaxUid);
    check(meta.transcodeRequired, "transcodeRequired=true（サーバ側変換が要る）");
    check(meta.transcodeAvailable, "transcodeAvailable=true（ffmpeg があるので変換できる）");
    check(meta.numberOfFrames === N_FRAMES && Math.round(meta.fps) === 15, "フレーム数/fps を読めている", meta);

    // ── 2. /rendered が変換済み MP4 を返す（＋ Range）
    const res = await fetch(`${base}/api/instances/${sop}/rendered`);
    const body = Buffer.from(await res.arrayBuffer());
    check(res.status === 200, "/rendered が 200（415 ではない）", res.status);
    check((res.headers.get("content-type") ?? "").includes("video/mp4"), "Content-Type が video/mp4", res.headers.get("content-type"));
    check(body.subarray(4, 8).toString("ascii") === "ftyp", "先頭が ftyp＝MP4 に変換されている", body.subarray(0, 12).toString("hex"));
    check(body.length > 1000, "十分なサイズがある", body.length);
    const ranged = await fetch(`${base}/api/instances/${sop}/rendered`, { headers: { Range: "bytes=0-99" } });
    check(ranged.status === 206, "Range 要求に 206 で応じる（シーク可）", ranged.status);

    // ── 3. キャッシュ
    // キャッシュ名には版が入る（変換コマンドを変えたら版を上げて古い成果物を捨てる）。
    const cache = path.join(DESKTOP_RUN_DATA_DIR, "data", "dicom", ".cache", "video", `${sop}.v2.mp4`);
    check(fs.existsSync(cache), "変換結果がキャッシュされている", cache);
    const mtime1 = fs.existsSync(cache) ? fs.statSync(cache).mtimeMs : 0;
    await fetch(`${base}/api/instances/${sop}/rendered`);
    const mtime2 = fs.existsSync(cache) ? fs.statSync(cache).mtimeMs : 0;
    check(mtime1 === mtime2 && mtime1 !== 0, "2 回目は再変換しない（キャッシュを返す）", { mtime1, mtime2 });

    // ── 4. UI で再生できる（案内表示ではない）
    const page = driver.page;
    await waitForMainScreenReady(page, 60_000);
    page.once("dialog", (d) => void d.accept());
    const dates = page.locator('input[type="date"]');
    await dates.nth(0).fill("");
    await dates.nth(1).fill("");
    await page.getByTestId("search-submit-button").click();
    await page.locator('[data-testid^="study-row-"]').first().waitFor({ state: "visible", timeout: 30_000 });
    await page.locator('[data-testid^="study-row-"]').first().click();
    await page.locator('[data-testid^="series-row-"]').first().waitFor({ state: "visible", timeout: 20_000 });
    await page.locator('[data-testid^="series-row-"]').first().click();

    const playable = await page
      .getByTestId("video-tool-rectangle")
      .waitFor({ state: "visible", timeout: 60_000 })
      .then(() => true)
      .catch(() => false);
    check(playable, "MPEG2 でも VideoViewport で開く（ffmpeg 案内ではない）");
    const bodyText = await page.evaluate(() => document.body.innerText);
    check(!/ffmpeg/i.test(bodyText), "「ffmpeg が無い」案内が出ていない");
    if (!playable) {
      throw new Error("VideoViewport で開けなかったため以降の検証ができません");
    }
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(OUT_DIR, "0-mpeg2-playing.png") }).catch(() => {});
    const uiState = await page.evaluate(`
      (function () {
        return {
          testIds: Array.from(document.querySelectorAll("[data-testid^='video-']")).map(function (e) { return e.getAttribute("data-testid"); }),
          videos: document.querySelectorAll("video").length,
          ranges: document.querySelectorAll("input[type=range]").length,
          text: (document.body.innerText || "").slice(0, 400),
        };
      })()
    `);
    console.log(`UI 状態: ${JSON.stringify(uiState)}`);
    const seekMax = await page.getByTestId("video-seek").getAttribute("max", { timeout: 10_000 }).catch(() => null);
    check(Number(seekMax) === N_FRAMES, `シークバーが ${N_FRAMES} フレームを持つ`, { seekMax });

    // ── 5. 変換でフレームが入れ替わっていない
    await page.getByTestId("video-tool-rectangle").click();
    await page.waitForTimeout(200);
    await dragOnCanvasHost(page, HOST, 80, 60, 0, 12, { fracX: 0.35, fracY: 0.35 });
    await page.waitForTimeout(600);
    check((await page.getByTestId("video-roi-chip").count()) === 1, "ROI を描ける");

    const probe = [1, 2, 9, 16, 23, 30];
    const means: number[] = [];
    for (const f of probe) {
      means.push(await frameMean(page, f));
    }
    const xs = probe.map(levelOf);
    const { a, b } = fitLinear(xs, means);
    const resid = means.map((m, i) => m - (a * xs[i] + b));
    const maxResid = Math.max(...resid.map(Math.abs));
    console.log(`    当てはめ: measured ≈ ${a.toFixed(3)} * level + ${b.toFixed(2)}、最大残差 ${maxResid.toFixed(2)}`);
    check(a > 0.5, "測定値が符号化レベルに比例している（フレームが保たれている）", { a, b });
    // MPEG2 → H.264 の再エンコードで多少の劣化が乗るため、フレーム精度検証（残差 < 5）より緩く見る。
    // 1 フレームずれれば残差は ~90 になるので、これでも十分に検出できる。
    check(maxResid < 12, "全フレームで残差 < 12（1 フレームずれれば ~90 になる）", {
      maxResid,
      resid: resid.map((r) => Number(r.toFixed(2))),
    });
    await page.screenshot({ path: path.join(OUT_DIR, "1-frame-stats.png") }).catch(() => {});
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
