/*
 * PR #178「2D ビューアでも encapsulated 動画を再生する」の実機検証。
 *
 * 実行:  cd automator && npx tsx src/spike/videoIn2dViewerCheck.ts
 *
 * <h3>なぜ要るのか</h3>
 * PR 本文が **「実機での再生確認は未実施。マージ前に実機で 1 度確認してください」**と
 * 明記している。frontend の vitest（`classifySeriesDisplay` の 5 件）が守るのは**振り分けの純関数**で、
 * 「**2D ビューアを開いたら実際に動画が出て再生されるか**」は通っていない。
 *
 * これは「DOM は揃っているのに何も映らない」で過去に何度も踏んでいる形
 * （3D の黒画面・FFR の色が乗らない）。**要素の有無ではなく、動いていることを見る**。
 *
 * <h3>確かめること</h3>
 * 1. 非DICOM 取込した MP4 のシリーズを **2D ビューアのボタンから開ける**（PR 前は何も出なかった）
 * 2. `SeriesViewer` が `VideoViewer` へ振り分けている（`video-viewport-host` が出る）
 * 3. 🚨 **`<video>` が実際に再生される**（`currentTime` が進む・`readyState` が足りている）
 * 4. 従来の画像シリーズが**壊れていない**（回帰）
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
import { dismissStartupDialogs } from "../common/dismissDialogs.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "video-in-2d-viewer");
const FIXTURE_DIR = path.join(AUTOMATOR_ROOT, "fixtures", "video-mp4-avi");

const failures: string[] = [];
let passed = 0;
function check(cond: boolean, label: string, detail?: unknown): void {
  const d = detail === undefined ? "" : ` — ${JSON.stringify(detail)}`;
  if (cond) {
    passed++;
    console.log(`  [ok  ] ${label}${d}`);
  } else {
    console.log(`  [FAIL] ${label}${d}`);
    failures.push(label);
  }
}

/** 検証用の合成動画（`videoRoiFrameModeCheck` と同じもの）。 */
function ensureFixtureVideo(): string {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  const existing = fs
    .readdirSync(FIXTURE_DIR)
    .filter((f) => /\.(mp4|avi)$/i.test(f))
    .map((f) => path.join(FIXTURE_DIR, f));
  if (existing.length > 0) return existing[0];
  const out = path.join(FIXTURE_DIR, "tic-ramp.mp4");
  console.log(`フィクスチャ動画が無いので ffmpeg で合成します: ${out}`);
  execFileSync(
    "ffmpeg",
    [
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "color=c=black:s=320x240:r=15:d=2",
      "-vf", "geq=lum='clip(20 + (X/W)*100 + T*60, 0, 255)':cb=128:cr=128,format=yuv420p",
      "-c:v", "libx264", "-profile:v", "high", "-level:v", "4.1",
      "-g", "1", "-pix_fmt", "yuv420p",
      out,
    ],
    { stdio: "inherit" },
  );
  return out;
}

/**
 * 再生器の状態。
 *
 * 🚨 **`<video>` を数えても意味が無い**（2026-09-06 に踏んだ）。`VideoViewer` の主経路は
 * Cornerstone `VideoViewport` で、**WebGL キャンバスに描く**。`<video>` は
 * VideoViewport の初期化に失敗したときの**フォールバック（方式 B）**でしか出ない。
 * したがって「`<video>` が 0」は正常でもありうる —— 見るべきは
 * **ホストの中に canvas があり、シークバーが尺を知っていて、フレームが進むこと**。
 */
interface PlayerState {
  hostChildren: string[];
  canvasCount: number;
  canvasW: number;
  canvasH: number;
  /** フォールバック（方式 B）の `<video>`。0 なら VideoViewport が立ち上がっている。 */
  fallbackVideos: number;
  seekValue: number;
  seekMax: number;
  frameText: string;
}

async function playerState(page: Page): Promise<PlayerState> {
  return (await page.evaluate(`(() => {
    const host = document.querySelector('[data-testid="video-viewport-host"]');
    const canvases = host ? Array.from(host.querySelectorAll("canvas")) : [];
    const c = canvases[0];
    const seek = document.querySelector('[data-testid="video-seek"]');
    const ind = document.querySelector('[data-testid="video-frame-indicator"]');
    return JSON.stringify({
      hostChildren: host ? Array.from(host.children).map((e) => e.tagName.toLowerCase()) : [],
      canvasCount: canvases.length,
      canvasW: c ? c.width : 0,
      canvasH: c ? c.height : 0,
      fallbackVideos: document.querySelectorAll("video").length,
      seekValue: seek ? Number(seek.value) : -1,
      seekMax: seek ? Number(seek.max) : -1,
      frameText: ind ? (ind.textContent || "").trim() : "",
    });
  })()`).then((s) => JSON.parse(s as string))) as PlayerState;
}

async function openStudyByRow(page: Page): Promise<void> {
  await dismissStartupDialogs(page);
  const dates = page.locator('input[type="date"]');
  await dates.nth(0).fill("");
  await dates.nth(1).fill("");
  await page.getByTestId("search-submit-button").click();
  await page.waitForTimeout(1_200);
  const row = page.locator('[data-testid^="study-row-"]').first();
  await row.waitFor({ state: "visible", timeout: 20_000 });
  await row.click();
  await page.waitForTimeout(800);
}

async function main(): Promise<void> {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const video = ensureFixtureVideo();
  console.log(`フィクスチャ: ${video}`);

  const driver = new DesktopDriver();
  await driver.start();
  try {
    const mainPage = driver.page;
    mainPage.on("dialog", (d) => void d.accept().catch(() => {}));
    await resetDb(driver.ports.http);

    const imp = await importNonDicomPaths(driver.ports.http, [video], {
      patientId: "VIDEO2D",
      patientName: "VIDEO^IN2D",
      seriesDescription: "encapsulated mp4",
    });
    check(
      (imp as { imported?: number }).imported === 1,
      "[準備] MP4 を非DICOM取込できた（encapsulated 動画として包まれる）",
      imp,
    );

    await waitForMainScreenReady(mainPage, 60_000);
    await openStudyByRow(mainPage);

    const seriesRow = mainPage.locator('[data-testid^="series-row-"]').first();
    await seriesRow.waitFor({ state: "visible", timeout: 30_000 });
    await seriesRow.click();
    await mainPage.waitForTimeout(500);

    // ── 🔴 ここが PR の本題: 2D ビューアのボタンから開く ─────────
    //    PR 前は SeriesViewer に振り分けが無く、Viewer2D（wadouri）が
    //    "The pixel data is missing" で開けず**何も表示されなかった**。
    const viewer = await driver.waitForNewPage(
      () => mainPage.getByTestId("viewer2d-toolbar-button").click(),
      (url) => url.includes("2dviewer"),
    );
    await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 30_000 });
    check(true, "[1] ★2D ビューアが開く（PR 前はここで何も出なかった）");
    await viewer.waitForTimeout(3_000);

    // ── 振り分け ─────────────────────────────────────────────
    const hasVideoHost = (await viewer.getByTestId("video-viewport-host").count()) > 0;
    check(hasVideoHost, "[2] ★SeriesViewer が VideoViewer へ振り分けている（video-viewport-host が出る）");

    // 画像用の描画ホストは出ていないこと（動画では意味を持たないので出さない設計）。
    const imageHost = await viewer.getByTestId("viewer2d-canvas-host").count();
    check(imageHost === 0, "[2] 画像用の描画ホストは出ていない（設計どおり）", { imageHost });

    // ── 🚨 動いていることを見る ───────────────────────────────
    //    ホストの div があることは「映っている」証拠にならない。
    let s0 = await playerState(viewer);
    // メタ取得は非同期なので、尺が入るまで待つ。
    for (let i = 0; i < 40 && !(s0.seekMax > 0); i++) {
      await viewer.waitForTimeout(250);
      s0 = await playerState(viewer);
    }
    fs.writeFileSync(path.join(OUT_DIR, "player-0.json"), JSON.stringify(s0, null, 2));
    console.log(`  [情報] 再生器: ${JSON.stringify(s0)}`);

    check(s0.canvasCount > 0, "[3] ★ホストの中に描画キャンバスがある", {
      children: s0.hostChildren,
      canvasCount: s0.canvasCount,
    });
    check(
      s0.canvasW > 0 && s0.canvasH > 0,
      "[3] ★★キャンバスに寸法がある（0×0 の張りぼてではない）",
      { w: s0.canvasW, h: s0.canvasH },
    );
    check(
      s0.seekMax > 0,
      "[3] ★★尺を取得できている（シークバーが総フレーム数を知っている）",
      { seekMax: s0.seekMax, frameText: s0.frameText },
    );
    console.log(
      `  [情報] 経路: ${s0.fallbackVideos > 0 ? "方式 B（<video> フォールバック）" : "方式 A（Cornerstone VideoViewport）"}`,
    );

    // シークしてフレームが動くこと＝描画パイプラインが生きていること。
    const target = Math.max(1, Math.floor(s0.seekMax / 2));
    await viewer.evaluate(`(() => {
      const el = document.querySelector('[data-testid="video-seek"]');
      if (!el) return;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      setter.call(el, String(${target}));
      el.dispatchEvent(new Event("input", { bubbles: true }));
    })()`);
    let s1 = await playerState(viewer);
    for (let i = 0; i < 40 && s1.seekValue === s0.seekValue; i++) {
      await viewer.waitForTimeout(150);
      s1 = await playerState(viewer);
    }
    fs.writeFileSync(path.join(OUT_DIR, "player-1.json"), JSON.stringify(s1, null, 2));
    check(
      s1.seekValue !== s0.seekValue,
      "[3] ★★★フレームを動かせる（シークが効く＝描画パイプラインが生きている）",
      { before: s0.seekValue, after: s1.seekValue, frameText: s1.frameText },
    );
    // 🚨 **フレーム表示の「変化」を条件にしない**（2026-09-06 に踏んだ）。
    //    表示は `fmtTime` の**秒単位**なので、2 秒 30 フレームのフィクスチャで半分まで
    //    シークしても "0:00 / 0:01" のまま変わらないことがある。
    //    フレームが進んだことは seekValue で既に見ているので、ここは**形が壊れていないか**だけ見る。
    check(
      /^\d+:\d{2} \/ \d+:\d{2}$/.test(s1.frameText) || /^\d+ \/ \d+$/.test(s1.frameText),
      "[3] 画面のフレーム表示が読める形で出ている",
      { before: s0.frameText, after: s1.frameText },
    );

    // ── 🚨 再生コントロールを「押して」確かめる ────────────────
    //    v0.2.7 はここを見ていなかったので、**再生ボタンが動かないまま公開した**。
    //    描画が出ていることは、操作が効くことの証拠にならない。
    const playBtn = viewer.getByTestId("video-play");
    check(await playBtn.isVisible().catch(() => false), "[5] 再生ボタンがある");
    const playingAttr = async (): Promise<string> =>
      (await playBtn.getAttribute("data-playing")) ?? "?";
    const seekNow = async (): Promise<number> => (await playerState(viewer)).seekValue;

    await viewer.getByTestId("video-seek").evaluate((el: HTMLInputElement) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(el, "1");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await viewer.waitForTimeout(500);
    const p0 = await seekNow();
    check((await playingAttr()) === "0", "[5] 押す前は停止状態", { playing: await playingAttr() });

    await playBtn.click();
    await viewer.waitForTimeout(1_200);
    const p1 = await seekNow();
    check(
      (await playingAttr()) === "1",
      "[5] ★★★押すと「再生中」に切り替わる（v0.2.7 はここが切り替わらなかった）",
      { playing: await playingAttr() },
    );
    check(p1 > p0, "[5] ★★★実際にフレームが進む（v0.2.7 は 1 のまま動かなかった）", { before: p0, after: p1 });

    await playBtn.click();
    await viewer.waitForTimeout(300);
    const p2 = await seekNow();
    await viewer.waitForTimeout(900);
    const p3 = await seekNow();
    check((await playingAttr()) === "0", "[5] ★もう一度押すと停止に戻る");
    check(p3 === p2, "[5] ★停止したらフレームが進まない", { p2, p3 });

    // ── ループの向き ─────────────────────────────────────────
    //    🔴 Cornerstone には loop が 2 つある（videoElement.loop と内部フィールド）。
    //    setProperties は前者しか更新しないので、**チェックの意味が逆になっていた**。
    const loopBox = viewer.getByTestId("video-loop");
    check(await loopBox.isChecked(), "[6] ループは既定で有効");
    await loopBox.uncheck();
    await viewer.waitForTimeout(300);
    const total = (await playerState(viewer)).seekMax;
    await viewer.getByTestId("video-seek").evaluate((el: HTMLInputElement, v: number) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(el, String(v));
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }, Math.max(1, total - 3));
    await viewer.waitForTimeout(400);
    await playBtn.click();
    await viewer.waitForTimeout(2_500);
    const endNoLoop = await seekNow();
    check(
      endNoLoop >= total - 1,
      "[6] ★★ループ無効なら最終フレームで止まる（v0.2.7 は逆にループしていた）",
      { total, endNoLoop },
    );

    await viewer.screenshot({ path: path.join(OUT_DIR, "1-video-in-2d-viewer.png") }).catch(() => {});
    await viewer.close();
    await mainPage.waitForTimeout(500);

    // ── 回帰: 画像シリーズが従来どおり開くか ────────────────────
    //    振り分けを足したので、**画像側を壊していないこと**を必ず見る。
    const dcm = path.join(AUTOMATOR_ROOT, "..", "bench", "phantom", "GNBP-XA", "GNBP-XA-1.dcm");
    if (fs.existsSync(dcm)) {
      const { importPaths } = await import("../fixtures/importFixtures.js");
      const imp2 = await importPaths(driver.ports.http, [dcm]);
      check(imp2.imported === 1, "[4] 画像シリーズを取り込めた（回帰の材料）", imp2);
      await mainPage.reload();
      await waitForMainScreenReady(mainPage, 60_000);
      await dismissStartupDialogs(mainPage);
      const dates = mainPage.locator('input[type="date"]');
      await dates.nth(0).fill("");
      await dates.nth(1).fill("");
      await mainPage.getByTestId("search-submit-button").click();
      await mainPage.waitForTimeout(1_500);
      const rows = mainPage.locator('[data-testid^="study-row-"]');
      const n = await rows.count();
      let opened = false;
      for (let i = 0; i < n && !opened; i++) {
        await rows.nth(i).click();
        await mainPage.waitForTimeout(700);
        const sr = mainPage.locator('[data-testid^="series-row-"]');
        if ((await sr.count()) === 0) continue;
        await sr.first().click();
        await mainPage.waitForTimeout(400);
        const v2 = await driver.waitForNewPage(
          () => mainPage.getByTestId("viewer2d-toolbar-button").click(),
          (url) => url.includes("2dviewer"),
        );
        await v2.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 30_000 });
        await v2.waitForTimeout(2_500);
        const canvasHost = await v2.getByTestId("viewer2d-canvas-host").count();
        const vids = (await playerState(v2)).canvasCount;
        if (canvasHost > 0) {
          check(true, "[4] ★画像シリーズは従来どおり Viewer2D で開く（回帰なし）");
          check(vids === 0, "[4] 画像シリーズに再生器は出ない", { videoCanvases: vids });
          await v2.screenshot({ path: path.join(OUT_DIR, "2-image-regression.png") }).catch(() => {});
          opened = true;
        }
        await v2.close();
        await mainPage.waitForTimeout(400);
      }
      check(opened, "[4] 画像シリーズを開いて確かめられた");
    } else {
      console.log("  [skip] 画像の回帰確認: ファントムが無い");
    }
  } finally {
    await driver.stop().catch(() => {});
  }

  console.log(`\n===== PR #178 2D ビューアの動画再生 実機検証 =====`);
  console.log(`合格 ${passed} / 失敗 ${failures.length}`);
  for (const f of failures) console.log(`  - ${f}`);
  console.log(`成果物: ${OUT_DIR}`);
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
