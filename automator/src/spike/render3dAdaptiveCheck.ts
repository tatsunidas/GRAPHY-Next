/*
 * 3D の操作中の縮小描画（描画環境 段 2）の実機検証。
 * 設計: fw/render-environment-design.md「操作中の縮小描画」
 *
 * 実行:  cd automator && npx tsx src/spike/render3dAdaptiveCheck.ts <hw|sw> <auto|full> [--baseline] [--label <名前>]
 *   hw / sw    ハードウェア描画 / ソフトウェア描画（環境変数 LIBGL_ALWAYS_SOFTWARE=1 で起動）
 *   auto / full  設定「3D の画質」（viewer3d.renderQuality）。full は負例（操作中も縮小しない）
 *   --baseline   導入前のコード用。`getRender3dStats` が無いので、スクリーンショットとフレーム時間だけを取る
 *
 * 何を確かめるか（本物の Electron ＋ 本物の backend、CT 512×512×308）:
 *   A5  ドラッグ直後の interactionScale が interactionScaleFor(stillMs, 30) と一致 ／ ソフトウェア描画では 1.5 超 ／
 *       離して 500 ms 後に smallViewport=false。静止画の画素一致は結果ファイルを別の比較（新旧を同じ条件で撮る）で行う
 *   A6  full ではドラッグ中も smallViewport=false。シネ（SLAB の自動回転）の開始・停止でも同じことを見る
 *   A7  5 秒ドラッグ中の 1 フレームの時間（rAF の間隔）の中央値と四分位範囲を結果ファイルへ書く（新旧の比較は別）
 *   🔴 先に 3D が開いて getRender3dStats() が null でないことを確かめる。null なら「未達」に数える。
 *   🔴 ソフトウェア描画の指定が実際に効いたか（GPU 名が llvmpipe / SwiftShader）も先に確かめる。効いていなければ未達。
 *
 * 結果は 合格・失敗・未達 に分けて数える。患者情報は出力しない（件数・寸法・数値だけを書く）。
 * 環境変数 RENDER3D_OUT（出力先）・RENDER3D_FIXTURE（CT フォルダ）で場所を変えられる。
 * 前提: backend jar。ポートは GRAPHY_AUTOMATOR_HTTP_PORT / _SCP_PORT / _VITE_PORT で他セッションと分けること。
 */
import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";

import { DesktopDriver, type DesktopLaunchOptions } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { openFirstSeriesInViewer } from "../checklist/items/shared/helpers.js";
import { createStepRecorder } from "../checklist/types.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";

const GPU = process.argv[2] as "hw" | "sw";
const QUALITY = process.argv[3] as "auto" | "full";
const BASELINE = process.argv.includes("--baseline");
const labelIdx = process.argv.indexOf("--label");
const LABEL = labelIdx > 0 ? process.argv[labelIdx + 1] : BASELINE ? "old" : "new";
if (!["hw", "sw"].includes(GPU) || !["auto", "full"].includes(QUALITY)) {
  console.error("使い方: render3dAdaptiveCheck.ts <hw|sw> <auto|full> [--baseline] [--label 名前]");
  process.exit(64);
}
const SOFTWARE = GPU === "sw";
/** vtk の既定の目標更新率（interactor.getDesiredUpdateRate()）。アプリは実行時に読むので、ここは検査側の期待値。 */
const VTK_DESIRED_RATE = 30;

const FIXTURE = process.env.RENDER3D_FIXTURE ?? path.join(AUTOMATOR_ROOT, "fixtures", "ct-wholebody-512");
const OUT_ROOT = process.env.RENDER3D_OUT ?? path.join(AUTOMATOR_ROOT, ".results", "render-3d-adaptive");
const OUT_DIR = path.join(OUT_ROOT, `${LABEL}-${GPU}-${QUALITY}`);

const failures: string[] = [];
const unreached: string[] = [];
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
function notReached(label: string, why: string): void {
  console.log(`  [未達] ${label} — ${why}`);
  unreached.push(label);
}

interface Stats {
  stillMs: number;
  interactionScale: number;
  smallViewport: boolean;
  quality: string;
}

const readStats = (p: Page) =>
  p.evaluate(() => {
    const g = (window as unknown as { __graphyDebug?: { getRender3dStats?: () => unknown } }).__graphyDebug;
    return g?.getRender3dStats ? (g.getRender3dStats() as Stats | null) : undefined;
  });

/** 期待値。アプリ本体と同じ純関数をアプリのモジュールから読む（式の二重実装を避ける）。 */
const expectedScale = (p: Page, stillMs: number, quality: string) =>
  p.evaluate(
    async ({ mod, stillMs, rate, quality }) => {
      const m = await import(/* @vite-ignore */ mod);
      return m.interactionScaleForQuality(quality, stillMs, rate) as number;
    },
    { mod: "/src/viewer/renderEnv.ts", stillMs, rate: VTK_DESIRED_RATE, quality },
  );

const canvasBox = (p: Page) =>
  p.evaluate(() => {
    let best: { x: number; y: number; width: number; height: number } | null = null;
    for (const c of Array.from(document.querySelectorAll("canvas"))) {
      const r = c.getBoundingClientRect();
      if (!best || r.width * r.height > best.width * best.height) best = { x: r.x, y: r.y, width: r.width, height: r.height };
    }
    return best;
  });

const frame = (p: Page) => p.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));

function quartiles(a: number[]): { median: number; q1: number; q3: number; iqr: number; n: number } {
  const s = [...a].sort((x, y) => x - y);
  const at = (q: number) => {
    const i = (s.length - 1) * q;
    const lo = Math.floor(i);
    return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (i - lo);
  };
  return { median: at(0.5), q1: at(0.25), q3: at(0.75), iqr: at(0.75) - at(0.25), n: s.length };
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  if (!fs.existsSync(FIXTURE)) throw new Error(`CT のフォルダが見つかりません: ${FIXTURE}`);
  const launch: DesktopLaunchOptions = SOFTWARE ? { extraEnv: { LIBGL_ALWAYS_SOFTWARE: "1" } } : {};
  console.log(`label=${LABEL} gpu=${GPU} quality=${QUALITY} baseline=${BASELINE} 起動指定=${JSON.stringify(launch)}`);

  const driver = new DesktopDriver({}, launch);
  const recorder = createStepRecorder();
  const result: Record<string, unknown> = { label: LABEL, gpu: GPU, quality: QUALITY, baseline: BASELINE };
  await driver.start();
  try {
    const page = driver.page;
    // 🔴 vtk は VR のレイの開始位置をずらす「ジッター」の乱数テクスチャを Math.random で作る（OpenGL/VolumeMapper.js）。
    //    そのままだと起動のたびに静止画の画素が変わり（同じコードを 2 回回しても最大 58 / 255 の差）、新旧の画素一致を
    //    測れない。3D を開く前に Math.random を種つきの擬似乱数に差し替えて、起動をまたいで同じ画にする。
    //    メイン画面には適用しない（再読み込みで乱数が固定されると画面が白くなることがあった）。
    await driver.app.context().addInitScript(`(() => {
      if (!location.href.includes("viewer3d")) return;
      let s = 0x12345678;
      Math.random = () => {
        s = (s + 0x6D2B79F5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    })();`);
    page.on("requestfailed", (r) => console.log(`  [main requestfailed] ${r.url().slice(0, 120)} ${r.failure()?.errorText}`));
    page.on("response", (r) => { if (r.status() >= 400) console.log(`  [main http ${r.status()}] ${r.url().slice(0, 120)}`); });
    page.on("pageerror", (e) => console.log(`  [main pageerror] ${String(e).slice(0, 300)}`));
    page.on("console", (m) => {
      if (m.type() === "error") console.log(`  [main error] ${m.text().slice(0, 200)}`);
    });
    await resetDb(driver.ports.http);
    // 画質の設定（旧コードはこの設定を読まない）
    const put = await fetch(`http://127.0.0.1:${driver.ports.http}/api/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ "viewer3d.renderQuality": QUALITY }),
    });
    check(put.ok, "設定 viewer3d.renderQuality を入れられた", put.status);

    const imp = await importPaths(driver.ports.http, [FIXTURE]);
    console.log(`取り込み: imported=${imp.imported} skipped=${imp.skipped} failed=${imp.failed}`);
    check(imp.imported > 0 && imp.failed === 0, "CT を取り込めた", { imported: imp.imported, failed: imp.failed });
    await page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });

    // --- 前提: 起動指定が効いたか ---
    const gpuName = await page.evaluate(() => {
      const gl = document.createElement("canvas").getContext("webgl2", { powerPreference: "high-performance" });
      const dbg = gl?.getExtension("WEBGL_debug_renderer_info");
      const r = gl && dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : null;
      gl?.getExtension("WEBGL_lose_context")?.loseContext();
      return r;
    });
    const isSoftName = !!gpuName && /llvmpipe|swiftshader/i.test(gpuName);
    console.log(`GPU 名: ${gpuName}`);
    result.gpuName = gpuName;
    if (SOFTWARE && !isSoftName) {
      notReached("ソフトウェア描画の指定が効いた（GPU 名が llvmpipe / SwiftShader）", `実際の GPU 名は "${gpuName}"。以降は行わない`);
      return;
    }
    if (!SOFTWARE && isSoftName) {
      notReached("ハードウェア描画で起動した", `GPU 名が ${gpuName}（ソフトウェア）だった。以降は行わない`);
      return;
    }
    check(true, SOFTWARE ? "ソフトウェア描画で起動した" : "ハードウェア描画で起動した");

    // --- 3D を開く ---
    await openFirstSeriesInViewer(page, recorder);
    const v3d = await driver.waitForNewPage(() => page.locator('button[title="3D Viewer"]').click(), (url) => url.includes("viewer3d"));
    v3d.on("console", (m) => {
      if (m.type() === "error") console.log(`  [3d error] ${m.text().slice(0, 160)}`);
    });
    await v3d.locator('[data-testid="viewer3d-mode-slab"]').waitFor({ timeout: 180_000 });
    await v3d.waitForTimeout(SOFTWARE ? 15_000 : 6_000);
    const opened = !/再試行|Retry/.test(await v3d.evaluate(() => document.body.innerText));
    check(opened, "3D がエラーなく開く");

    // --- 前提: getRender3dStats ---
    const apiPresent = await v3d.evaluate(() => {
      const g = (window as unknown as { __graphyDebug?: { getRender3dStats?: unknown } }).__graphyDebug;
      return { debug: !!g, fn: typeof g?.getRender3dStats === "function" };
    });
    console.log(`__graphyDebug=${apiPresent.debug} getRender3dStats=${apiPresent.fn}`);
    result.hasGetRender3dStats = apiPresent.fn;
    let hasStats = false;
    let rest: Stats | null = null;
    if (BASELINE) {
      check(!apiPresent.fn, "旧コードには getRender3dStats が無い（スクリーンショットとフレーム時間だけを取る）");
    } else {
      check(apiPresent.fn, "getRender3dStats が公開されている");
      for (let i = 0; i < 30 && !rest; i++) {
        rest = (await readStats(v3d)) ?? null;
        if (!rest) await v3d.waitForTimeout(1000);
      }
      hasStats = rest !== null;
      if (!hasStats) notReached("getRender3dStats() が null でない", "30 秒待っても null（view node が取れていない）。stats の検査は行わない");
      else check(true, "getRender3dStats() が null でない");
    }
    if (rest) {
      console.log(`  静止: stillMs=${rest.stillMs.toFixed(1)} interactionScale=${rest.interactionScale} smallViewport=${rest.smallViewport} quality=${rest.quality}`);
      result.rest = rest;
      check(rest.quality === QUALITY, "stats の quality が設定と一致する", { stats: rest.quality, want: QUALITY });
      const want = await expectedScale(v3d, rest.stillMs, QUALITY);
      result.expectedScale = want;
      check(Math.abs(rest.interactionScale - want) < 1e-9, "静止中の interactionScale が interactionScaleFor(stillMs, 30) と一致する", { got: rest.interactionScale, want });
      check(!rest.smallViewport, "静止中は smallViewport=false");
    }

    const box = await canvasBox(v3d);
    if (!box) throw new Error("canvas が見つかりません");
    result.canvas = { width: Math.round(box.width), height: Math.round(box.height) };
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const shot = async (name: string) => {
      const p = path.join(OUT_DIR, `${name}.png`);
      await v3d.screenshot({ path: p, clip: { x: box.x, y: box.y, width: box.width, height: box.height } });
      return p;
    };
    await v3d.mouse.move(box.x + 5, box.y + 5); // 画面外の影響（ホバー）を避ける
    await frame(v3d);
    await v3d.waitForTimeout(500);
    console.log(`\n[静止画] ${await shot("still0")}`);

    // --- 5 秒ドラッグ（A5 の直後の値・A6・A7 のフレーム時間）---
    // 🔴 最初のドラッグで測る。vtk は 1 秒ごとに倍率を学習して残すので、先に別のドラッグをすると初期値の検査にならない。
    console.log("\n[ドラッグ 5 秒]");
    // tsx が関数式へ __name を差し込み、ページ内で未定義になるので、文字列で渡す。
    await v3d.evaluate(`(() => {
      window.__ft = { t: [], on: true };
      const loop = (n) => { if (!window.__ft.on) return; window.__ft.t.push(n); requestAnimationFrame(loop); };
      requestAnimationFrame(loop);
    })()`);
    const R = 90;
    let at150: Stats | null | undefined;
    let during: Stats[] = [];
    await v3d.mouse.move(cx - R, cy);
    const t0 = Date.now();
    await v3d.mouse.down();
    let i = 0;
    let readAt = 0;
    while (Date.now() - t0 < 5000) {
      i++;
      await v3d.mouse.move(cx + R * Math.sin(i * 0.12), cy + (R / 2) * Math.sin(i * 0.05));
      await v3d.waitForTimeout(10);
      if (!at150 && Date.now() - t0 >= 150) {
        at150 = await readStats(v3d);
        readAt = Date.now() - t0;
      } else if (at150 !== undefined && i % 15 === 0 && !BASELINE) {
        const s = await readStats(v3d);
        if (s) during.push(s);
      }
    }
    const lastDuring = BASELINE ? undefined : await readStats(v3d);
    await v3d.mouse.up();
    const tUp = Date.now();
    const ft = await v3d.evaluate(() => {
      const w = window as unknown as { __ft?: { t: number[]; on: boolean } };
      if (w.__ft) w.__ft.on = false;
      return w.__ft?.t ?? [];
    });
    await v3d.waitForTimeout(500);
    const afterRelease = BASELINE ? undefined : await readStats(v3d);
    console.log(`  mouse up から ${Date.now() - tUp} ms 後`);
    await shot("after-drag5s");

    const intervals: number[] = [];
    for (let k = 1; k < ft.length; k++) intervals.push(ft[k] - ft[k - 1]);
    const q = quartiles(intervals);
    const half = quartiles(intervals.slice(Math.floor(intervals.length / 2)));
    result.frameMs = q;
    result.frameMsLastHalf = half;
    console.log(`  フレーム間隔(ms): 中央値=${q.median.toFixed(1)} Q1=${q.q1.toFixed(1)} Q3=${q.q3.toFixed(1)} IQR=${q.iqr.toFixed(1)} n=${q.n}  （後半: 中央値=${half.median.toFixed(1)} IQR=${half.iqr.toFixed(1)}）`);
    check(q.n >= 3, "フレーム間隔を 3 点以上取れた", q.n);

    if (hasStats && rest) {
      result.atDragStart = at150 ?? null;
      result.dragStartReadMs = readAt;
      console.log(`  ドラッグ ${readAt} ms 時点: ${JSON.stringify(at150)}`);
      console.log(`  ドラッグ 5 秒時点: ${JSON.stringify(lastDuring)}`);
      console.log(`  離して 500 ms 後: ${JSON.stringify(afterRelease)}`);
      if (QUALITY === "full" && at150) {
        // full は倍率が 1 のまま動かない（学習も働かない）ので、読む時刻が遅れても判定できる。
        check(at150.interactionScale === 1, "A6 full ではドラッグ中も interactionScale=1", at150.interactionScale);
        check(at150.smallViewport === false, "A6 full ではドラッグ中も smallViewport=false", at150);
        check(lastDuring?.smallViewport === false && lastDuring.interactionScale === 1, "A6 full ではドラッグの最後まで smallViewport=false・倍率 1", lastDuring);
      } else if (!at150 || readAt >= 900) {
        notReached("A5 ドラッグ直後の interactionScale", `読めなかった、または 900 ms 以降（${readAt} ms）で vtk の自動調整が入りうる`);
      } else {
        const want = await expectedScale(v3d, rest.stillMs, QUALITY);
        check(Math.abs(at150.interactionScale - want) < 1e-9, `A5 ドラッグ直後の interactionScale が式の値と一致する（${at150.interactionScale} / 期待 ${want}）`, { got: at150.interactionScale, want });
        if (QUALITY === "full") {
          /* 上で判定済み */
        } else if (want > 1.5) {
          check(at150.smallViewport === true, "A5 auto でドラッグ直後に smallViewport=true（縮小描画が効く）", at150);
          if (SOFTWARE) check(at150.interactionScale > 1.5, "A5 ソフトウェア描画では interactionScale が 1.5 を超える", at150.interactionScale);
        } else {
          check(at150.smallViewport === false, "A5 縮小が要らない速さ（倍率 1）では smallViewport=false", at150);
          if (SOFTWARE) check(false, "A5 ソフトウェア描画では interactionScale が 1.5 を超える", at150.interactionScale);
        }
      }
      check(afterRelease?.smallViewport === false, "A5 離して 500 ms 後に smallViewport=false", afterRelease);
    }

    // --- 決まった経路のドラッグ（毎回同じ回転になるよう、1 回動かすごとに描画の完了を待つ）→ 離す → 静止画 ---
    // 🔴 5 秒ドラッグ（経路が時間で変わる）の後なので、先に「視点リセット」で初期カメラへ戻す。
    //    5 秒ドラッグは vtk の倍率の学習（動かし始めて 1 秒以降）を使い切る最初のドラッグとして先に行う（A5 の初期値の検査）。
    await v3d.getByRole("button", { name: /表示リセット|Reset display/i }).first().click();
    await frame(v3d);
    await v3d.waitForTimeout(SOFTWARE ? 3000 : 1000);
    await v3d.mouse.move(cx - 60, cy);
    await v3d.mouse.down();
    for (let i = 1; i <= 3; i++) {
      await v3d.mouse.move(cx - 60 + i * 40, cy + i * 16);
      await frame(v3d);
      if (SOFTWARE) await v3d.waitForTimeout(1500); // 1 フレームが 0.5 秒かかる環境でも、動かした分が描かれ終わるのを待つ
    }
    await v3d.mouse.up();
    await frame(v3d);
    await v3d.waitForTimeout(SOFTWARE ? 3000 : 1000);
    console.log(`[決まった経路のドラッグ後の静止画] ${await shot("still1")}`);
    await v3d.mouse.move(box.x + 5, box.y + 5);

    // --- シネ（SLAB の自動回転）---
    console.log("\n[シネ（SLAB の自動回転）]");
    await v3d.getByTestId("viewer3d-mode-slab").click();
    await v3d.waitForTimeout(SOFTWARE ? 4000 : 1500);
    const spinBtn = v3d.getByTestId("viewer3d-slab-spin");
    await spinBtn.waitFor({ state: "visible", timeout: 20_000 });
    await spinBtn.click();
    await v3d.waitForTimeout(SOFTWARE ? 3000 : 1500);
    const spinning = BASELINE ? undefined : await readStats(v3d);
    await v3d.screenshot({ path: path.join(OUT_DIR, "spin.png") });
    await spinBtn.click(); // 停止
    await v3d.waitForTimeout(SOFTWARE ? 2500 : 1000);
    const spinStopped = BASELINE ? undefined : await readStats(v3d);
    result.spinning = spinning ?? null;
    result.spinStopped = spinStopped ?? null;
    if (hasStats && rest) {
      console.log(`  シネ中: ${JSON.stringify(spinning)}`);
      console.log(`  停止後: ${JSON.stringify(spinStopped)}`);
      const want = await expectedScale(v3d, rest.stillMs, QUALITY);
      if (QUALITY === "full") check(spinning?.smallViewport === false, "A6 full ではシネ中も smallViewport=false", spinning);
      else if (want > 1.5) check(spinning?.smallViewport === true, "A6 auto ではシネ中に縮小描画が効く（smallViewport=true）", spinning);
      else check(spinning?.smallViewport === false, "A6 縮小が要らない速さではシネ中も smallViewport=false", spinning);
      check(spinStopped?.smallViewport === false, "A6 シネを止めると smallViewport=false（精細に戻る）", spinStopped);
    }
    await v3d.screenshot({ path: path.join(OUT_DIR, "after-spin.png") });
    fs.writeFileSync(path.join(OUT_DIR, "frames.json"), JSON.stringify({ intervals }));
    await v3d.close().catch(() => {});
  } catch (e) {
    await driver.page.screenshot({ path: path.join(OUT_DIR, "failure-main.png") }).catch(() => undefined);
    console.log(`  [failure] main url=${driver.page.url()} html=${(await driver.page.evaluate(() => document.documentElement.outerHTML.slice(0, 400)).catch(() => "?")).replace(/\s+/g, " ")}`);
    throw e;
  } finally {
    fs.writeFileSync(path.join(OUT_DIR, "result.json"), JSON.stringify({ ...result, passed, failed: failures.length, unreached: unreached.length }, null, 2));
    await driver.stop();
  }
}

main()
  .catch((e) => {
    console.log(`\n[FAIL] 例外: ${String(e).slice(0, 600)}`);
    failures.push(`例外: ${String(e).slice(0, 200)}`);
  })
  .finally(() => {
    console.log(`\n結果 (${LABEL} ${GPU} ${QUALITY}): 合格 ${passed} / 失敗 ${failures.length} / 未達 ${unreached.length}`);
    if (failures.length) console.log(`失敗:\n  - ${failures.join("\n  - ")}`);
    if (unreached.length) console.log(`未達:\n  - ${unreached.join("\n  - ")}`);
    console.log(`出力: ${OUT_DIR}`);
    process.exit(failures.length > 0 ? 1 : 0);
  });
