/*
 * シネマティック（パストレース）の操作中の縮小描画と、ソフトウェア描画での開始前の確認の実機検証。
 * 設計: fw/render-environment-design.md「シネマティックの操作中の縮小描画」
 *
 * 実行:  cd automator && npx tsx src/spike/cinematicProgressiveCheck.ts <hw|sw> <auto|full> [--baseline] [--cancel] [--label <名前>]
 *   hw / sw    ハードウェア描画 / ソフトウェア描画（環境変数 LIBGL_ALWAYS_SOFTWARE=1 で起動）
 *   auto / full  設定「3D の画質」（viewer3d.renderQuality）。full は負例（操作中も全解像度）
 *   --baseline   導入前のコード用（getCinematicStats・確認が無い）。フレーム数と収束画だけを取る
 *   --cancel     ソフトウェア描画で確認の［やめる］を押し、何も始まらないことだけを確かめる
 *   --vtk-only   シネマティックを始めず、vtk だけでドラッグの rAF の数を測る（参照）
 *
 * 確かめること（本物の Electron ＋ 本物の backend、CT 512×512）:
 *   V2  縮小率 k=8・4・2・1 の 1 フレームの実時間。費用のモデル t(k)=固定費+画素分/k² を当てはめ、k=2 の予測と実測を突き合わせる
 *   V4  ドラッグ中に scale>1（遅い機械）・internalWidth=⌈canvas 幅/scale⌉・scale が式の値と一致。離すと scale=1 に戻り蓄積が 0 から
 *       full は負例（ドラッグ中も scale=1）。ドラッグ開始から 2 秒の rAF の数を新旧で比べる（cinematicProgressiveCompare.ts）
 *   V5  ソフトウェア描画の開始前の確認（見積もりの秒数・承認で始まる・やめるで何も始まらない）。ハードウェア描画では出ない（負例）
 *   V3  決まった経路のドラッグの後、収束した画の画素を新旧で比べる（同じ経路・同じカメラ。比較は cinematicProgressiveCompare.ts。
 *       ハードウェア描画だけ。ソフトウェアは 400 フレームに届かないので未達）
 *   🔴 先に 3D が開き、getCinematicStats() が null でないことを確かめる。null なら未達。ソフトウェア描画の指定が効いたか（GPU 名）も先に確かめる
 *
 * 結果は 合格・失敗・未達 に分けて数える。環境変数 CINE_OUT（出力先）・CINE_FIXTURE（CT フォルダ）で場所を変えられる。
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
const CANCEL = process.argv.includes("--cancel");
/** シネマティックを始めず、3D の vtk だけでドラッグの rAF の数を測る（参照。オーバーレイが何を足しているかを見る）。 */
const VTK_ONLY = process.argv.includes("--vtk-only");
const labelIdx = process.argv.indexOf("--label");
const LABEL = labelIdx > 0 ? process.argv[labelIdx + 1] : BASELINE ? "old" : "new";
if (!["hw", "sw"].includes(GPU) || !["auto", "full"].includes(QUALITY)) {
  console.error("使い方: cinematicProgressiveCheck.ts <hw|sw> <auto|full> [--baseline] [--cancel] [--label 名前]");
  process.exit(64);
}
const SOFTWARE = GPU === "sw";
const FIXTURE = process.env.CINE_FIXTURE ?? path.join(AUTOMATOR_ROOT, "fixtures", "ct-basic");
const OUT_ROOT = process.env.CINE_OUT ?? path.join(AUTOMATOR_ROOT, ".results", "cinematic-progressive");
const OUT_DIR = path.join(OUT_ROOT, `${LABEL}-${GPU}-${QUALITY}${CANCEL ? "-cancel" : ""}`);
const MAX_FRAMES = 400;

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
  phase: string; scale: number; internalWidth: number; internalHeight: number; canvasWidth: number; canvasHeight: number;
  frameCount: number; tBudgetMs: number; fixedMs: number; perFullMs: number; tFullMs: number; estimateSeconds: number | null; quality: string; moving: boolean; samples: { k: number; ms: number }[];
}
const readStats = (p: Page) =>
  p.evaluate(() => {
    const g = (window as unknown as { __graphyDebug?: { getCinematicStats?: () => unknown } }).__graphyDebug;
    return g?.getCinematicStats ? (g.getCinematicStats() as Stats | null) : undefined;
  });
const frame = (p: Page) => p.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
const median = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** 期待値。アプリ本体と同じ純関数をアプリのモジュールから読む（式の二重実装を避ける）。 */
const expectedScale = (p: Page, s: Stats) =>
  p.evaluate(
    async ({ mod, s }) => {
      const m = await import(/* @vite-ignore */ mod);
      const model = Number.isFinite(s.perFullMs) ? { fixedMs: s.fixedMs, perFullMs: s.perFullMs } : null;
      return m.cinematicScaleForQuality(s.quality, model, s.tBudgetMs, s.canvasWidth, s.canvasHeight) as number;
    },
    { mod: "/src/viewer/cinematicScale.ts", s },
  );

/** 画面（clip の範囲）の画素を RGBA のバイト列で保存する（PNG のデコーダが無いので、ページ内でデコードする）。 */
async function savePixels(page: Page, name: string, clip: { x: number; y: number; width: number; height: number }): Promise<void> {
  const png = await page.screenshot({ clip });
  fs.writeFileSync(path.join(OUT_DIR, `${name}.png`), png);
  const r = await page.evaluate(async (b64) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const bmp = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = c.getContext("2d")!;
    ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
    let s = "";
    for (let i = 0; i < d.length; i += 0x8000) s += String.fromCharCode(...d.subarray(i, i + 0x8000));
    return { w: bmp.width, h: bmp.height, b64: btoa(s) };
  }, png.toString("base64"));
  fs.writeFileSync(path.join(OUT_DIR, `${name}.rgba`), Buffer.from(r.b64, "base64"));
  fs.writeFileSync(path.join(OUT_DIR, `${name}.rgba.json`), JSON.stringify({ width: r.w, height: r.h }));
}

/** vtk だけ（シネマティックなし）でのドラッグ 3 秒: ドラッグ開始から 2 秒の rAF の数と、メインスレッドの長いタスク。 */
async function measureDragOnly(v3d: Page): Promise<void> {
  const box = await v3d.evaluate(() => {
    let best: { x: number; y: number; width: number; height: number } | null = null;
    for (const c of Array.from(document.querySelectorAll("canvas"))) {
      const r = c.getBoundingClientRect();
      if (!best || r.width * r.height > best.width * best.height) best = { x: r.x, y: r.y, width: r.width, height: r.height };
    }
    return best;
  });
  if (!box) throw new Error("canvas が見つかりません");
  console.log("\n[参照: vtk だけのドラッグ 3 秒]");
  const r = await dragAndCount(v3d, box);
  console.log(`  ドラッグ開始から 2 秒の rAF の数: ${r.first2s}／定常 3 秒の rAF の数: ${r.steady3s}`);
  fs.writeFileSync(path.join(OUT_DIR, "result.json"), JSON.stringify({ label: LABEL, gpu: GPU, vtkOnly: true, framesFirst2s: r.first2s, framesSteady3s: r.steady3s, longTasks: r.longTasks }, null, 2));
}

/** ドラッグ 3 秒。開始から 2 秒の rAF の数と、メインスレッドの長いタスク（50 ms 超）の数・最大・合計を返す。 */
async function dragAndCount(v3d: Page, box: { x: number; y: number; width: number; height: number }): Promise<{ first2s: number; steady3s: number; longTasks: { n: number; maxMs: number; totalMs: number } }> {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await v3d.mouse.move(box.x + 5, box.y + 5);
  await v3d.evaluate(`(() => {
    window.__ft = { t: [], on: true, down: null, lt: [] };
    window.addEventListener("pointerdown", (e) => { if (window.__ft.down === null) window.__ft.down = e.timeStamp; }, { capture: true });
    try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__ft.lt.push(e.duration); }).observe({ type: "longtask", buffered: false }); } catch (e) {}
    const loop = (n) => { if (!window.__ft.on) return; window.__ft.t.push(n); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  })()`);
  const R = 90;
  await v3d.mouse.move(cx - R, cy);
  const t0 = Date.now();
  await v3d.mouse.down();
  let i = 0;
  while (Date.now() - t0 < (SOFTWARE ? 12_000 : 3000)) {
    i++;
    await v3d.mouse.move(cx + R * Math.sin(i * 0.12), cy + (R / 2) * Math.sin(i * 0.05));
    await v3d.waitForTimeout(10);
  }
  await v3d.mouse.up();
  const ft = await v3d.evaluate(() => {
    const w = window as unknown as { __ft?: { t: number[]; on: boolean; down: number | null; lt: number[] } };
    if (w.__ft) w.__ft.on = false;
    return { t: w.__ft?.t ?? [], down: w.__ft?.down ?? null, lt: w.__ft?.lt ?? [] };
  });
  const first2s = ft.down === null ? -1 : ft.t.filter((x) => x > ft.down! && x <= ft.down! + 2000).length;
  const from = SOFTWARE ? 5000 : 1000;
  const steady3s = ft.down === null ? -1 : ft.t.filter((x) => x > ft.down! + from && x <= ft.down! + from + 3000).length;
  return { first2s, steady3s, longTasks: { n: ft.lt.length, maxMs: Math.max(0, ...ft.lt), totalMs: ft.lt.reduce((a, b) => a + b, 0) } };
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  if (!fs.existsSync(FIXTURE)) throw new Error(`CT のフォルダが見つかりません: ${FIXTURE}`);
  const launch: DesktopLaunchOptions = SOFTWARE ? { extraEnv: { LIBGL_ALWAYS_SOFTWARE: "1" } } : {};
  console.log(`label=${LABEL} gpu=${GPU} quality=${QUALITY} baseline=${BASELINE} cancel=${CANCEL} 起動指定=${JSON.stringify(launch)}`);

  const driver = new DesktopDriver({}, launch);
  const recorder = createStepRecorder();
  const result: Record<string, unknown> = { label: LABEL, gpu: GPU, quality: QUALITY, baseline: BASELINE };
  await driver.start();
  try {
    const page = driver.page;
    page.on("pageerror", (e) => console.log(`  [main pageerror] ${String(e).slice(0, 300)}`));
    await resetDb(driver.ports.http);
    const put = await fetch(`http://127.0.0.1:${driver.ports.http}/api/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ "viewer3d.renderQuality": QUALITY }),
    });
    check(put.ok, "設定 viewer3d.renderQuality を入れられた", put.status);
    const imp = await importPaths(driver.ports.http, [FIXTURE]);
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
    if (SOFTWARE !== isSoftName) {
      notReached(SOFTWARE ? "ソフトウェア描画の指定が効いた" : "ハードウェア描画で起動した", `実際の GPU 名は "${gpuName}"。以降は行わない`);
      return;
    }
    check(true, SOFTWARE ? "ソフトウェア描画で起動した" : "ハードウェア描画で起動した");

    // --- 3D を開く ---
    await openFirstSeriesInViewer(page, recorder);
    const v3d = await driver.waitForNewPage(() => page.locator('button[title="3D Viewer"]').click(), (url) => url.includes("viewer3d"));
    v3d.on("pageerror", (e) => console.log(`  [3d pageerror] ${String(e).slice(0, 300)}`));
    await v3d.locator('[data-testid="viewer3d-mode-slab"]').waitFor({ timeout: 180_000 });
    await v3d.waitForTimeout(SOFTWARE ? 15_000 : 6_000);
    check(!/再試行|Retry/.test(await v3d.evaluate(() => document.body.innerText)), "3D がエラーなく開く");

    // --- シネマティックを始める ---
    // 旧コードのボタンには testid が無い（文言で探す）
    const toggle = BASELINE ? v3d.getByRole("button", { name: /Cinematic mode: On|シネマティックモード: オン/ }) : v3d.getByTestId("viewer3d-cinematic-toggle");
    await toggle.waitFor({ state: "visible", timeout: 30_000 });
    if (VTK_ONLY) {
      await measureDragOnly(v3d);
      return;
    }
    await toggle.click();

    if (!BASELINE) {
      const apiPresent = await v3d.evaluate(() => typeof (window as unknown as { __graphyDebug?: { getCinematicStats?: unknown } }).__graphyDebug?.getCinematicStats === "function");
      check(apiPresent, "getCinematicStats が公開されている");
    }

    // V5 確認
    if (!BASELINE && SOFTWARE) {
      console.log("\n[V5 ソフトウェア描画の開始前の確認]");
      const card = v3d.getByTestId("cine2-confirm");
      await card.waitFor({ state: "visible", timeout: 180_000 });
      const body = (await v3d.getByTestId("cine2-confirm-body").textContent()) ?? "";
      const sec = Number(/([0-9]+(?:\.[0-9]+)?)\s*(?:秒|s )/.exec(body)?.[1] ?? Number.NaN);
      console.log(`  文言: ${body}`);
      result.confirmBody = body;
      result.estimateSec = sec;
      check(Number.isFinite(sec) && sec > 0, "確認に見積もりの秒数が出る", body);
      const st = await readStats(v3d);
      check(!!st && st.phase === "confirm" && st.estimateSeconds !== null && Math.abs(st.estimateSeconds - sec) < 0.06, "stats の見積もりが画面の秒数と一致する", st);
      await v3d.screenshot({ path: path.join(OUT_DIR, "confirm.png") });
      if (CANCEL) {
        await v3d.getByTestId("cine2-confirm-cancel").click();
        await v3d.waitForTimeout(1500);
        check((await v3d.getByTestId("cine2-confirm").count()) === 0 && (await v3d.getByTestId("cine2-badge").count()) === 0, "🔴 やめる → 確認もバッジも消え、何も始まらない");
        check((await readStats(v3d)) === null, "🔴 やめる → エンジンが破棄されている（stats が null）");
        check(/On|オン/.test((await toggle.textContent()) ?? ""), "やめる → ボタンが「オン」に戻る", await toggle.textContent());
        return;
      }
      await v3d.getByTestId("cine2-confirm-start").click();
    } else if (!BASELINE) {
      // 負例: ハードウェア描画では確認を出さない
      await v3d.waitForTimeout(3000);
      check((await v3d.getByTestId("cine2-confirm").count()) === 0, "V5 負例: ハードウェア描画では確認が出ない");
    }
    if (CANCEL) {
      notReached("確認の［やめる］", "ハードウェア描画では確認が出ない（--cancel は sw 用）");
      return;
    }

    // running になるまで
    let st0: Stats | null | undefined = null;
    if (BASELINE) {
      await v3d.waitForFunction(() => /\d+\s*\/\s*400/.test(document.body.innerText), undefined, { timeout: 240_000 });
    } else {
      for (let i = 0; i < 240 && !(st0 && st0.phase === "running"); i++) {
        st0 = await readStats(v3d);
        if (!(st0 && st0.phase === "running")) await v3d.waitForTimeout(1000);
      }
      if (!st0 || st0.phase !== "running") {
        notReached("getCinematicStats() が running になる", `240 秒待っても phase=${st0?.phase ?? "null"}。以降の stats の検査は行わない`);
        return;
      }
      check(true, "getCinematicStats() が running になる");
      console.log(`  開始時: ${JSON.stringify(st0)}`);
      result.start = st0;
      check(Number.isFinite(st0.tBudgetMs) && st0.tBudgetMs > 5 && st0.tBudgetMs < 100, "画面の更新間隔（rAF の中央値）が測れている", st0.tBudgetMs);
      check(st0.quality === QUALITY, "stats の quality が設定と一致する", st0.quality);
    }

    const box = await v3d.evaluate(() => {
      const el = document.querySelector('[data-testid="cine2-badge"]')?.parentElement ?? null;
      const c = el?.querySelector("canvas") ?? null;
      const r = c?.getBoundingClientRect();
      return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
    });
    // 旧コードにはバッジの testid が無いので、一番大きい canvas で代用
    const canvasBox =
      box ??
      (await v3d.evaluate(() => {
        let best: { x: number; y: number; width: number; height: number } | null = null;
        for (const c of Array.from(document.querySelectorAll("canvas"))) {
          const r = c.getBoundingClientRect();
          if (!best || r.width * r.height > best.width * best.height) best = { x: r.x, y: r.y, width: r.width, height: r.height };
        }
        return best;
      }));
    if (!canvasBox) throw new Error("canvas が見つかりません");
    result.canvas = { width: Math.round(canvasBox.width), height: Math.round(canvasBox.height) };
    const cx = canvasBox.x + canvasBox.width / 2;
    const cy = canvasBox.y + canvasBox.height / 2;
    await v3d.mouse.move(canvasBox.x + 5, canvasBox.y + 5);

    // V4 ドラッグ 3 秒（最初のドラッグ）
    console.log("\n[V4 ドラッグ 3 秒]");
    await v3d.evaluate(`(() => {
      window.__ft = { t: [], on: true, down: null, lt: [] };
      window.addEventListener("pointerdown", (e) => { if (window.__ft.down === null) window.__ft.down = e.timeStamp; }, { capture: true });
      try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__ft.lt.push(e.duration); }).observe({ type: "longtask", buffered: false }); } catch (e) {}
      const loop = (n) => { if (!window.__ft.on) return; window.__ft.t.push(n); requestAnimationFrame(loop); };
      requestAnimationFrame(loop);
    })()`);
    const R = 90;
    const during: Stats[] = [];
    await v3d.mouse.move(cx - R, cy);
    const t0 = Date.now();
    await v3d.mouse.down();
    let i = 0;
    // 遅い機械では 1 回動かすのに秒単位かかる（最初の 1 回は、静止中に積んでいた全解像度のフレームが終わるまで待つ）ので、長く動かす
    const DRAG_MS = SOFTWARE ? 12_000 : 3000;
    while (Date.now() - t0 < DRAG_MS) {
      i++;
      await v3d.mouse.move(cx + R * Math.sin(i * 0.12), cy + (R / 2) * Math.sin(i * 0.05));
      await v3d.waitForTimeout(10);
      // 遅い機械では 1 回動かすのに秒単位かかるので、毎回読む（速い機械は 10 回に 1 回）
      if (!BASELINE && (SOFTWARE || (i % 10 === 0 && Date.now() - t0 > 600))) {
        const s = await readStats(v3d);
        if (s) {
          during.push(s);
          if (SOFTWARE) console.log(`    t=${Date.now() - t0} ms move#${i}: phase=${s.phase} scale=${s.scale} moving=${s.moving} frame=${s.frameCount} fixed=${s.fixedMs.toFixed(1)} perFull=${s.perFullMs.toFixed(1)} samples=${JSON.stringify(s.samples.map((x) => [x.k, x.ms]))}`);
        }
      }
      // 動かしている最中の画（縮小して描いている）。撮っている間は止まるので、1 回だけ
      if (!BASELINE && i === (SOFTWARE ? 40 : 100)) await v3d.screenshot({ path: path.join(OUT_DIR, "during-drag.png") });
    }
    // 最後に動かした直後から、止まる様子を細かく読む（スクリーンショットなどで間を空けない）
    const seq: (Stats & { at: number })[] = [];
    if (!BASELINE) {
      for (let k = 0; k < 40; k++) {
        const s = await readStats(v3d);
        if (s) seq.push({ ...s, at: Date.now() });
        await v3d.waitForTimeout(30);
      }
    }
    await v3d.mouse.up();
    const ft = await v3d.evaluate(() => {
      const w = window as unknown as { __ft?: { t: number[]; on: boolean; down: number | null; lt: number[] } };
      if (w.__ft) w.__ft.on = false;
      return { t: w.__ft?.t ?? [], down: w.__ft?.down ?? null, lt: w.__ft?.lt ?? [] };
    });
    result.longTasks = { n: ft.lt.length, maxMs: Math.max(0, ...ft.lt), totalMs: ft.lt.reduce((a, b) => a + b, 0) };
    console.log(`  メインスレッドの長いタスク（50 ms 超）: ${JSON.stringify(result.longTasks)}`);
    if (ft.down !== null) {
      const first2s = ft.t.filter((x) => x > ft.down! && x <= ft.down! + 2000).length;
      result.framesFirst2s = first2s;
      // 遅い機械は最初の 1 回が遅れるので、立ち上がりを除いた定常（開始から STEADY_FROM 後の 3 秒）の数も測る
      const STEADY_FROM = SOFTWARE ? 5000 : 1000;
      const steady = ft.t.filter((x) => x > ft.down! + STEADY_FROM && x <= ft.down! + STEADY_FROM + 3000).length;
      result.framesSteady3s = steady;
      console.log(`  開始から ${STEADY_FROM / 1000} 秒後からの 3 秒の rAF の数: ${steady}`);
      console.log(`  ドラッグ開始から 2 秒の rAF の数: ${first2s}`);
    } else notReached("ドラッグ開始から 2 秒のフレーム数", "pointerdown を捕まえられなかった");

    if (!BASELINE) {
      console.log(`  ドラッグ中の stats（${during.length} 点）: scale=${JSON.stringify([...new Set(during.map((s) => s.scale))])}`);
      result.during = during.slice(-3);
      check(during.length >= 3, "ドラッグ中の stats を 3 点以上読めた", during.length);
      if (QUALITY === "full") {
        check(during.every((s) => s.scale === 1 && s.internalWidth === s.canvasWidth), "V4 full（負例）: ドラッグ中も scale=1・内部解像度が canvas と同じ", during.map((s) => s.scale));
      } else {
        check(during.every((s) => s.internalWidth === Math.ceil(s.canvasWidth / s.scale) && s.internalHeight === Math.ceil(s.canvasHeight / s.scale)), "V4 内部解像度が ⌈canvas/scale⌉ と一致する", during.slice(-1));
        // 操作中（moving=true）の読み取りだけが対象。止まっている間は設計どおり scale=1（読み取りと tick の前後でずれうる）
        const movingReads = during.filter((s) => s.moving);
        result.movingReads = movingReads.length;
        // scale は tick の時点のモデルで決まり、読む時点のモデルはそのあとの実測で更新済み（遅い機械では 1 tick が数百 ms で、k が大きいほど差が出る）。
        // そこで「読んだ scale が、その読み取りと直前 2 回の読み取りのモデルから式で出る値のどれかと一致する」で見る（定数の許容幅は置かない）。
        const wants: number[] = [];
        for (const s of movingReads) wants.push(await expectedScale(v3d, s));
        const exp = movingReads.slice(-5).map((s, n, arr) => {
          const i = movingReads.length - arr.length + n;
          const cand = wants.slice(Math.max(0, i - 2), i + 1);
          return { got: s.scale, want: wants[i], cand, tFullMs: s.tFullMs, tBudgetMs: s.tBudgetMs };
        });
        result.expected = exp;
        console.log(`  scale と式の値（直近 5 点）: ${JSON.stringify(exp)}`);
        if (movingReads.length === 0) notReached("V4 scale が式の値と一致する", "操作中（moving=true）の状態を 1 度も読めなかった（遅い機械は tick がまばらで、読み取りが tick の合間に当たる）");
        else check(exp.every((e) => e.cand.includes(e.got)), "V4 操作中の scale が cinematicScaleForModel の値（その読み取りと直前 2 回のモデル）と一致する", exp);
        const last = movingReads[movingReads.length - 1] ?? during[during.length - 1];
        if (movingReads.length === 0) notReached("V4 1 フレームが更新間隔より遅い機械では、操作中に scale>1 になる", "操作中の状態を読めなかった");
        else if (last.tFullMs > last.tBudgetMs) check(Math.max(...movingReads.map((s) => s.scale)) > 1, "V4 1 フレームが更新間隔より遅い機械では、操作中に scale>1 になる", { tFullMs: last.tFullMs, tBudgetMs: last.tBudgetMs, scales: movingReads.map((s) => s.scale) });
        else notReached("V4 操作中に scale>1", `この環境は全解像度で間に合う（tFull ${last.tFullMs.toFixed(1)} ms ≤ tBudget ${last.tBudgetMs.toFixed(1)} ms）`);
      }
      // 止まったあと: scale=1 に戻り、蓄積が 0 から
      const sawBig = during.some((s) => s.scale > 1);
      console.log(`  止まった直後（約 1.2 秒）: scale 列=${JSON.stringify(seq.map((s) => s.scale))} frameCount 列=${JSON.stringify(seq.map((s) => s.frameCount))}`);
      const back = seq.find((s) => s.scale === 1 && !s.moving);
      check(!!back, "V4 止めると scale=1・moving=false に戻る", seq.slice(0, 5));
      if (QUALITY === "auto") {
        // scale>1 → 1 に変わった最初の点。その間（前の点から今の点まで）に積めるフレーム数 + 1 以内なら、変わった時点で 0 からやり直している
        const idx = seq.findIndex((s, n) => n > 0 && seq[n - 1].scale > 1 && s.scale === 1);
        if (idx < 0) notReached("🔴 V4 縮小→全解像度に戻った時点で蓄積を 0 からやり直す", sawBig ? "scale が 1 に戻る瞬間を読めなかった" : "ドラッグ中に scale>1 にならなかった（全解像度で間に合う）");
        else {
          const dt = seq[idx].at - seq[idx - 1].at;
          const bound = Math.ceil(dt / seq[idx].tBudgetMs) + 1;
          result.restart = { frameCountAtTransition: seq[idx].frameCount, bound, sampleGapMs: dt, frameCountBefore: seq[idx - 1].frameCount };
          check(seq[idx].frameCount <= bound, "🔴 V4 縮小→全解像度に戻った時点で蓄積を 0 からやり直す（n/400 が 0 から数え直す）", result.restart);
        }
      }
      await v3d.waitForTimeout(500);
      await v3d.screenshot({ path: path.join(OUT_DIR, "after-release.png") });
    }

    // V2 縮小率ごとの 1 フレームの実時間
    if (!BASELINE) {
      console.log("\n[V2 縮小率ごとの 1 フレームの実時間（費用は画素数に比例するか）]");
      const rounds: Record<number, number[]> = { 8: [], 4: [], 2: [], 1: [] };
      for (let r = 0; r < 3; r++) {
        const out = await v3d.evaluate(() => (window as unknown as { __graphyDebug: { benchCinematicFrames(k: number[]): { k: number; ms: number }[] | null } }).__graphyDebug.benchCinematicFrames([8, 4, 2, 1]));
        if (!out) {
          notReached("V2 縮小率ごとの実時間", "benchCinematicFrames が null");
          break;
        }
        for (const o of out) rounds[o.k]?.push(o.ms);
      }
      if (rounds[1].length === 3) {
        const t = (k: number) => median(rounds[k]);
        for (const k of [8, 4, 2, 1]) console.log(`  k=${k}: ${t(k).toFixed(1)} ms  → t·k²/t(1) = ${((t(k) * k * k) / t(1)).toFixed(2)}`);
        // t(k) = fixed + perFull/k²（k=1 と k=4 の 2 点で当てはめ、測っていない k=2 を予測する）
        const perFull = (t(1) - t(4)) / (1 - 1 / 16);
        const fixed = t(1) - perFull;
        const pred2 = fixed + perFull / 4;
        console.log(`  当てはめ（k=1・4）: fixed=${fixed.toFixed(2)} ms perFull=${perFull.toFixed(2)} ms → k=2 の予測 ${pred2.toFixed(2)} ms（実測 ${t(2).toFixed(2)} ms）`);
        result.scaling = { t1: t(1), t2: t(2), t4: t(4), t8: t(8), fixed, perFull, pred2 };
        check(t(1) > t(2) && t(2) > t(4) * 0.9, "k=1 > k=2 ≳ k=4（縮小すると速い。k が大きい側は固定費で頭打ちになりうる）", result.scaling);
        // 実装の fitCostModel は k=1 と最大の k の 2 点で当てはめる。ソフトウェア描画は k=1 が画素数比例より遅く（t·k²/t(1)=0.79 @k=2）、
        // 2 点の当てはめは中間の k を実測より高く見積もる（縮めすぎる側＝安全側）。危ないのは低く見積もる側なので、そちらを 25% で縛る。
        check(pred2 >= 0.75 * t(2), "V2 モデルの k=2 の予測が実測を 25% を超えて下回らない（低く見積もると選んだ k で更新間隔に間に合わない）", { pred2, measured: t(2), overPct: Math.round((100 * (pred2 - t(2))) / t(2)) });
        // 直接の検査: 実装の当てはめ（k=1 と 8 の 2 点）で選ばれる k で、実測が更新間隔に収まる（遅い機械だけ。k=1 で間に合うなら選ぶ k は 1 で自明）
        const budget = (await readStats(v3d))?.tBudgetMs ?? Number.NaN;
        if (Number.isFinite(budget) && t(1) > budget) {
          const kPick = await v3d.evaluate(
            async ({ mod, t1, t8, budget }) => {
              const m = await import(/* @vite-ignore */ mod);
              const model = m.fitCostModel([{ k: 1, ms: t1 }, { k: 8, ms: t8 }]);
              const canvas = document.querySelector("canvas") as HTMLCanvasElement;
              return m.cinematicScaleForModel(model, budget, canvas.width, canvas.height) as number;
            },
            { mod: "/src/viewer/cinematicScale.ts", t1: t(1), t8: t(8), budget },
          );
          const meas = await v3d.evaluate((k) => (window as unknown as { __graphyDebug: { benchCinematicFrames(k: number[]): { k: number; ms: number }[] | null } }).__graphyDebug.benchCinematicFrames([k, k, k]), kPick);
          const tPick = meas ? median(meas.map((o) => o.ms)) : Number.NaN;
          result.pick = { kPick, tPick, budget };
          console.log(`  選ばれる k=${kPick} の実測 ${tPick.toFixed(1)} ms（更新間隔 ${budget.toFixed(1)} ms）`);
          check(tPick <= budget * 1.25, "V2 モデルが選ぶ k の実測が更新間隔の 1.25 倍以内", result.pick);
        } else notReached("V2 モデルが選ぶ k の実測", `k=1 の実測 ${t(1).toFixed(1)} ms が更新間隔 ${Number.isFinite(budget) ? budget.toFixed(1) : "不明"} ms に収まる（選ぶ k は 1 で自明）`);
      }
    }

    // V4b 縮小→全解像度の切り替えで蓄積が 0 から数え直される（forceCinematicScale で、どの機械でも決まった瞬間に起こす）
    if (!BASELINE && QUALITY === "auto") {
      console.log("\n[V4b 縮小率を固定 → 解除したとき、蓄積が 0 から数え直されるか]");
      const forced = await v3d.evaluate(() => (window as unknown as { __graphyDebug: { forceCinematicScale(k: number | null): boolean } }).__graphyDebug.forceCinematicScale(4));
      if (!forced) notReached("🔴 V4b 縮小→全解像度で蓄積が 0 から", "forceCinematicScale が効かない（オーバーレイが動いていない）");
      else {
        // tsx が関数に付ける補助（__name）はページに無いので、ページで動かす部分は文字列で渡す
        const sampleSeq = (ms: number) =>
          v3d.evaluate(`new Promise((resolve) => {
            const g = window.__graphyDebug;
            const out = [];
            const t0 = performance.now();
            const step = () => {
              const s = g.getCinematicStats();
              if (s) out.push({ scale: s.scale, frameCount: s.frameCount, at: performance.now(), tBudgetMs: s.tBudgetMs });
              if (performance.now() - t0 < ${ms}) requestAnimationFrame(step);
              else resolve(out);
            };
            step();
          })`) as Promise<{ scale: number; frameCount: number; at: number; tBudgetMs: number }[]>;
        // 前提: scale=4 になり、フレームが 5 以上積まれる（積まれていないと「0 に戻った」が見分けられない）
        let ready: Stats | null | undefined = null;
        for (let i = 0; i < 300; i++) {
          ready = await readStats(v3d);
          if (ready && ready.scale === 4 && ready.frameCount >= 5) break;
          await v3d.waitForTimeout(100);
        }
        if (!ready || ready.scale !== 4 || ready.frameCount < 5) notReached("🔴 V4b 縮小→全解像度で蓄積が 0 から", `固定した scale=4 で 5 フレーム積めなかった（${JSON.stringify(ready && { scale: ready.scale, frameCount: ready.frameCount })}）`);
        else {
          // 対照: scale を変えないあいだは数え直されず、フレーム数が増え続ける
          const hold = await sampleSeq(600);
          check(hold.every((x) => x.scale === 4) && hold[hold.length - 1].frameCount > hold[0].frameCount, "V4b 対照: scale=4 のままならフレーム数が増える（数え直されない）", { first: hold[0], last: hold[hold.length - 1] });
          const before = hold[hold.length - 1].frameCount;
          await v3d.evaluate(() => (window as unknown as { __graphyDebug: { forceCinematicScale(k: number | null): boolean } }).__graphyDebug.forceCinematicScale(null));
          // 遅い機械は解除の評価が最初の読み取りより前に起きる（1 フレーム数百 ms でメインスレッドが塞がる）ので、解除前の最後の読み取りを先頭に付ける
          const seq2 = [hold[hold.length - 1], ...(await sampleSeq(SOFTWARE ? 12000 : 4000))];
          console.log(`  解除後の列（${seq2.length} 点）: scale=${JSON.stringify(seq2.filter((_, n) => n % Math.ceil(seq2.length / 20) === 0).map((x) => [Math.round(x.at - seq2[0].at), x.scale, x.frameCount]))}`);
          const i2 = seq2.findIndex((x, n) => n > 0 && seq2[n - 1].scale > 1 && x.scale === 1);
          if (i2 < 0) notReached("🔴 V4b 縮小→全解像度で蓄積が 0 から", "解除しても scale が 1 に戻らなかった");
          else {
            const dt = seq2[i2].at - seq2[i2 - 1].at;
            const bound = Math.ceil(dt / seq2[i2].tBudgetMs) + 1;
            result.restartForced = { frameCountBefore: before, frameCountAtSwitch: seq2[i2].frameCount, bound, sampleGapMs: dt };
            check(seq2[i2].frameCount <= bound && seq2[i2].frameCount < before, "🔴 V4b 縮小→全解像度に戻った時点で蓄積を 0 から数え直す", result.restartForced);
          }
        }
      }
      await v3d.evaluate(() => (window as unknown as { __graphyDebug: { forceCinematicScale(k: number | null): boolean } }).__graphyDebug.forceCinematicScale(null));
    }

    // V3 決まった経路のドラッグ → 収束した画
    console.log("\n[V3 決まった経路のドラッグ → 収束画]");
    await v3d.getByRole("button", { name: /表示リセット|Reset display/i }).first().click();
    await frame(v3d);
    await v3d.waitForTimeout(SOFTWARE ? 3000 : 1000);
    await v3d.mouse.move(cx - 60, cy);
    await v3d.mouse.down();
    for (let n = 1; n <= 3; n++) {
      await v3d.mouse.move(cx - 60 + n * 40, cy + n * 16);
      await frame(v3d);
      await v3d.waitForTimeout(SOFTWARE ? 1500 : 300);
    }
    await v3d.mouse.up();
    await v3d.mouse.move(canvasBox.x + 5, canvasBox.y + 5);
    if (SOFTWARE) {
      notReached("V3 収束画の新旧の画素一致", `ソフトウェア描画は ${MAX_FRAMES} フレームに届かない（1 フレームが数秒）。ハードウェア描画で行う`);
      await v3d.waitForTimeout(5000);
      await v3d.screenshot({ path: path.join(OUT_DIR, "after-fixed-path.png") });
    } else {
      // 収束（400 フレーム）まで待つ
      let n = 0;
      const tConv0 = Date.now();
      for (let k = 0; k < 600 && n < MAX_FRAMES; k++) {
        if (BASELINE) {
          const txt = await v3d.evaluate(() => /(?:Cinematic mode|シネマティックモード):\s*(\d+)\s*\/\s*400/.exec(document.body.innerText)?.[1] ?? "0");
          n = Number(txt);
        } else {
          n = (await readStats(v3d))?.frameCount ?? 0;
        }
        if (n < MAX_FRAMES) await v3d.waitForTimeout(500);
      }
      if (n < MAX_FRAMES) notReached("V3 収束（400 フレーム）に達する", `300 秒待って ${n} フレーム`);
      else {
        result.convergeMs = Date.now() - tConv0;
        console.log(`  決まった経路のドラッグを離してから 400 フレームに達するまで: ${result.convergeMs} ms（0.5 秒刻みの確認を含む）`);
        await v3d.waitForTimeout(500);
        await savePixels(v3d, "converged", canvasBox);
        check(true, "V3 400 フレームで収束した画を保存した（新旧の比較は cinematicProgressiveCompare.ts）");
      }
    }
    await v3d.close().catch(() => {});
  } catch (e) {
    await driver.page.screenshot({ path: path.join(OUT_DIR, "failure-main.png") }).catch(() => undefined);
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
    console.log(`\n結果 (${LABEL} ${GPU} ${QUALITY}${CANCEL ? " cancel" : ""}): 合格 ${passed} / 失敗 ${failures.length} / 未達 ${unreached.length}`);
    if (failures.length) console.log(`失敗:\n  - ${failures.join("\n  - ")}`);
    if (unreached.length) console.log(`未達:\n  - ${unreached.join("\n  - ")}`);
    console.log(`出力: ${OUT_DIR}`);
    process.exit(failures.length > 0 ? 1 : 0);
  });
