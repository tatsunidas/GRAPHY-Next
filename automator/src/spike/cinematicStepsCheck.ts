/*
 * シネマティック（パストレース）の歩数・勾配・不透明度の補正の実アプリ検査。第 2 段（B6〜B8）。
 *
 * 実行:  cd automator && CINE_PY=<numpy・pydicom の入った python> npx tsx src/spike/cinematicStepsCheck.ts [--baseline]
 *   --baseline  導入前のコード（origin/main）用。縞の振幅だけを測る（B6 の比較用。検査用の口が無い）。**先に新コードの実行で stripes-scale.json を作る**
 *
 * 合成の CT を使う（期待値・位置は mm/ボクセルの式で決め、描画側と独立）:
 *   step    128×128×100（市松つきの傾斜）          B8
 *   smooth  288×288×272（市松なしの傾斜＋球）       B7
 *   stripes 512×512×64・0.5 mm（1 ボクセル幅の縞）  B6
 *
 *   B8 中央の画素の一次レイの歩数（シェーダが決めた値を読み戻す）が、z 方向から見るとき ceil(z のテクセル数) に一致（元の解像度・間引いた格子の両方）
 *   B7 平滑な体積を、テクスチャ元の解像度と半分の解像度（予算で下げる）で描き、同じフレーム数の平均輝度の差が雑音の床（種違いの実現の幅）以下。
 *      負例: 補正を切ると同じ比較で差が床を超える
 *   B6 縞（x ≡ phase mod 4。旧コードは各軸 256 に最近傍で間引くので、奇数列は全部落ちる）を z 方向から撮り、縞の周期成分の振幅が、
 *      新コードで旧コードより大きく、その差が雑音の床（新コードの種違いの実現の幅）より大きい。偶数列（旧が拾う位相）も記録する
 *
 * 結果は 合格・失敗・未達 に分けて数える。フレーム数はバッジの「n / 400」だけから読む（画面全体の文字には Info の「W/L 40 / 400」がある）。
 * 400 フレームまでの収束は内蔵 GPU では待たない（CINE_FRAMES。既定 40）。比較は常に同じフレーム数。
 * 前提: backend jar。ポートは GRAPHY_AUTOMATOR_*_PORT で他セッションと分ける。JDK を PATH に足す。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { openFirstSeriesInViewer } from "../checklist/items/shared/helpers.js";
import { createStepRecorder } from "../checklist/types.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";

const BASELINE = process.argv.includes("--baseline");
const LABEL = BASELINE ? "old" : "new";
const PY = process.env.CINE_PY ?? "python3";
const N_FRAMES = Number(process.env.CINE_FRAMES ?? 40);
const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "cinematic-steps");
const RAMP = path.join(AUTOMATOR_ROOT, "scripts", "make-ramp-ct-phantom.py");
const STRIPES = path.join(AUTOMATOR_ROOT, "scripts", "make-stripes-ct-phantom.py");

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

const evalDbg = <T>(page: Page, body: string): Promise<T> => page.evaluate(`(function(){ var d = window.__graphyDebug; return ${body}; })()`) as Promise<T>;
interface TexStats { texDims: [number, number, number]; srcDims: [number, number, number]; textureBytes: number; reason: string }
const stats = (page: Page) => evalDbg<TexStats | null>(page, "d.cine2Stats()");

/** バッジ（cine2-badge）の「n / 400」から蓄積フレーム数を読む。🔴 画面全体の文字では読まない（Info の「W/L 40 / 400」に当たる）。 */
const FRAMES_IN_BADGE = `(function(){ var b = document.querySelector('[data-testid="cine2-badge"]'); var m = b && b.innerText.match(/(\\d+)\\s*\\/\\s*400/); return m ? Number(m[1]) : -1; })()`;
async function waitFrames(page: Page, n: number, timeoutMs = 900_000): Promise<number> {
  const t0 = Date.now();
  await page.waitForFunction(`(${FRAMES_IN_BADGE}) >= ${n}`, undefined, { timeout: timeoutMs });
  return (Date.now() - t0) / 1000;
}

const OVERLAY_CANVAS_JS = `(function(){
  var b = document.querySelector('[data-testid="cine2-badge"]');
  var el = b; while (el && !(el.style && el.style.zIndex === '12')) el = el.parentElement;
  return el && el.querySelector('canvas');
})()`;

/** オーバーレイの canvas を撮り、列ごとの平均輝度（全行・縞の行帯）と、明るい列・行の範囲を返す。 */
async function analyze(page: Page, png: string, band: [number, number] | null): Promise<{ w: number; h: number; mean: number; colMean: number[]; brightX: [number, number] | null; brightY: [number, number] | null }> {
  const box = await page.evaluate(`(function(){ var c = ${OVERLAY_CANVAS_JS}; if (!c) return null; var r = c.getBoundingClientRect(); return {x: r.left, y: r.top, width: r.width, height: r.height}; })()`) as { x: number; y: number; width: number; height: number } | null;
  if (!box) throw new Error("オーバーレイの canvas が見つかりません");
  await page.evaluate("globalThis.__name = (f) => f");
  const buf = await page.screenshot({ path: png, clip: box });
  return page.evaluate(async ({ b64, band }) => {
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([bin], { type: "image/png" }));
    const cv = document.createElement("canvas");
    cv.width = bmp.width; cv.height = bmp.height;
    const ctx = cv.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
    const w = cv.width, h = cv.height;
    const L = (i: number) => (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
    let sum = 0;
    const colMean = new Array<number>(w).fill(0), colMax = new Array<number>(w).fill(0), rowMax = new Array<number>(h).fill(0);
    const y0 = band ? band[0] : 0, y1 = band ? band[1] : h;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const v = L((y * w + x) * 4);
      sum += v;
      if (v > colMax[x]) colMax[x] = v;
      if (v > rowMax[y]) rowMax[y] = v;
      if (y >= y0 && y < y1) colMean[x] += v;
    }
    for (let x = 0; x < w; x++) colMean[x] /= Math.max(1, y1 - y0);
    const ext = (a: number[]): [number, number] | null => { const i = a.findIndex((v) => v > 0.6); if (i < 0) return null; let j = a.length - 1; while (a[j] <= 0.6) j--; return [i, j]; };
    return { w, h, mean: sum / (w * h), colMean, brightX: ext(colMax), brightY: ext(rowMax) };
  }, { b64: buf.toString("base64"), band });
}

/** 周期 period（px）の成分の振幅（中央の窓 [a,b) の列平均から。周期を ±1% の範囲で探して最大）。 */
function amplitudeAt(profile: number[], a: number, b: number, periodPx: number): { amp: number; periodPx: number } {
  const seg = profile.slice(a, b);
  const mean = seg.reduce((x, y) => x + y, 0) / seg.length;
  let best = 0, bestP = periodPx;
  for (let k = -20; k <= 20; k++) {
    const p = periodPx * (1 + k * 0.0005);
    const f = 1 / p;
    let re = 0, im = 0;
    for (let i = 0; i < seg.length; i++) { const v = seg[i] - mean; re += v * Math.cos(2 * Math.PI * f * i); im -= v * Math.sin(2 * Math.PI * f * i); }
    const amp = (2 / seg.length) * Math.hypot(re, im);
    if (amp > best) { best = amp; bestP = p; }
  }
  return { amp: best, periodPx: bestP };
}

interface Phase { id: "step" | "smooth" | "stripes" | "stripes0"; dims: [number, number, number]; spacing: [number, number, number] }
const ALL: Phase[] = [
  { id: "step", dims: [128, 128, 100], spacing: [0.8, 0.8, 1.0] },
  { id: "smooth", dims: [288, 288, 272], spacing: [0.8, 0.8, 1.0] },
  { id: "stripes", dims: [512, 512, 64], spacing: [0.5, 0.5, 1.0] },
  { id: "stripes0", dims: [512, 512, 64], spacing: [0.5, 0.5, 1.0] },
];

async function open3d(driver: DesktopDriver, dir: string, nSlices: number, label: string): Promise<Page> {
  const page = driver.page;
  await resetDb(driver.ports.http);
  const imp = await importPaths(driver.ports.http, [dir]);
  check(imp.imported === nSlices && imp.failed === 0, `（前提）${label}: ${nSlices} 枚の合成 CT を取り込めた`, { imported: imp.imported, failed: imp.failed });
  await page.evaluate("localStorage.setItem('graphy.locale', 'ja')");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
  await openFirstSeriesInViewer(page, createStepRecorder());
  const v3d = await driver.waitForNewPage(() => page.locator('button[title="3D Viewer"]').click(), (url) => url.includes("viewer3d"));
  v3d.on("pageerror", (e) => console.log(`  [3d pageerror] ${String(e).slice(0, 200)}`));
  await v3d.locator('[data-testid="viewer3d-mode-slab"]').waitFor({ timeout: 180_000 });
  await v3d.waitForTimeout(6_000);
  await v3d.evaluate("globalThis.__name = (f) => f");
  await v3d.evaluate("localStorage.removeItem('graphy.cinematic.gpuRecord')");
  return v3d;
}
const toggle = (v3d: Page) => v3d.getByTestId("viewer3d-cinematic-toggle");
async function startCine(v3d: Page): Promise<void> {
  await toggle(v3d).click();
  await v3d.getByTestId("cine2-badge").waitFor({ timeout: 60_000 });
}
async function stopCine(v3d: Page): Promise<void> {
  await toggle(v3d).click();
  await v3d.getByTestId("cine2-badge").waitFor({ state: "detached", timeout: 30_000 });
}
const meanOf = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;

/** 新・旧の縞の振幅の比較（新コードの実行と旧コードの実行が済んでから）。 */
function compareStripes(): number {
  const f = (n: string) => path.join(OUT_DIR, n);
  if (!fs.existsSync(f("amp-stripes-new.json")) || !fs.existsSync(f("amp-stripes-old.json"))) {
    notReached("B6: 旧コードとの縞の振幅の比較", "amp-stripes-new.json / amp-stripes-old.json が揃っていない");
  } else {
    const nw = JSON.parse(fs.readFileSync(f("amp-stripes-new.json"), "utf8")) as { samples: number[]; frames: number };
    const old = JSON.parse(fs.readFileSync(f("amp-stripes-old.json"), "utf8")) as { samples: number[]; frames: number };
    const floor = Math.max(...nw.samples) - Math.min(...nw.samples);
    const aNew = meanOf(nw.samples), aOld = meanOf(old.samples);
    console.log(`  縞（奇数列＝旧コードが落とす位相）の周期成分の振幅: 旧 ${aOld.toFixed(5)}（${old.frames} フレーム）/ 新 ${aNew.toFixed(5)}（${nw.frames} フレーム・実現 ${nw.samples.map((x) => x.toFixed(5)).join(" / ")}）・新の雑音の床 = 幅 ${floor.toExponential(2)}`);
    check(old.frames === nw.frames, "（前提）旧と新で同じフレーム数", { old: old.frames, new: nw.frames });
    check(aNew > aOld && aNew - aOld > floor, "B6: 旧コードが落とす位相の縞の振幅が、新コードで旧より大きく、その差が雑音の床を超える", { aOld, aNew, floor });
    for (const id of ["stripes0"]) {
      const a0 = f(`amp-${id}-old.json`), b0 = f(`amp-${id}-new.json`);
      if (fs.existsSync(a0) && fs.existsSync(b0)) console.log(`  （記録）旧コードが拾う位相（偶数列）の縞の振幅: 旧 ${meanOf(JSON.parse(fs.readFileSync(a0, "utf8")).samples).toFixed(5)} / 新 ${meanOf(JSON.parse(fs.readFileSync(b0, "utf8")).samples).toFixed(5)}`);
    }
  }
  console.log(`\n合格 ${passed} / 失敗 ${failures.length} / 未達 ${unreached.length}`);
  return failures.length > 0 || unreached.length > 0 ? 1 : 0;
}

async function main(): Promise<number> {
  if (process.argv.includes("--compare")) return compareStripes();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const probe = spawnSync(PY, ["-I", "-c", "import numpy, pydicom"], { encoding: "utf8" });
  if (probe.status !== 0) {
    console.log(`【未達】numpy / pydicom が使えません（CINE_PY=${PY}）。合格にしません。\n${probe.stderr}`);
    return 2;
  }
  const phases = BASELINE ? ALL.filter((p) => p.id === "stripes" || p.id === "stripes0") : ALL;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "cine-steps-"));
  const dirs: Record<string, string> = {};
  for (const p of phases) {
    dirs[p.id] = path.join(work, p.id);
    const args = p.id === "step" ? [RAMP, dirs[p.id], "--dims", p.dims.join(","), "--spacing", p.spacing.join(",")]
      : p.id === "smooth" ? [RAMP, dirs[p.id], "--dims", p.dims.join(","), "--spacing", p.spacing.join(","), "--smooth"]
      : [STRIPES, dirs[p.id], "--dims", p.dims.join(","), "--spacing", p.spacing.join(","), "--phase", p.id === "stripes" ? "1" : "0"];
    const r = spawnSync(PY, ["-I", ...args], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`ファントムを作れませんでした: ${r.stderr}`);
  }

  const driver = new DesktopDriver();
  await driver.start();
  try {
    const gpuName = await driver.page.evaluate(() => {
      const gl = document.createElement("canvas").getContext("webgl2");
      const dbg = gl?.getExtension("WEBGL_debug_renderer_info");
      const r = gl && dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : null;
      gl?.getExtension("WEBGL_lose_context")?.loseContext();
      return r;
    });
    console.log(`label=${LABEL} frames=${N_FRAMES} GPU 名: ${gpuName}`);
    if (gpuName && /llvmpipe|swiftshader/i.test(gpuName)) {
      notReached("ハードウェア描画で起動した", `GPU 名は "${gpuName}"（ソフトウェア描画）。以降は行わない`);
      return 2;
    }
    const scalePath = path.join(OUT_DIR, "stripes-scale.json");

    for (const phase of phases) {
      console.log(`\n===== ${phase.id}: ${phase.dims.join("×")} 間隔 ${phase.spacing.join("×")} mm =====`);
      const v3d = await open3d(driver, dirs[phase.id], phase.dims[2], phase.id);
      await startCine(v3d);

      if (!BASELINE && phase.id === "step") {
        await v3d.getByTestId("cine2-resolution").waitFor({ timeout: 60_000 });
        await waitFrames(v3d, 3);
        const st = (await stats(v3d))!;
        const steps = await evalDbg<number | null>(v3d, "d.cine2PrimarySteps()");
        check(steps !== null, "🔴 シェーダが決めた一次レイの歩数を読み戻せる", steps);
        check(steps === st.texDims[2], `B8: 元の解像度で、z 方向の視線の歩数が ceil(z のテクセル数) = ${st.texDims[2]} に一致`, { steps, texDims: st.texDims });
        await stopCine(v3d);
        const fullBytes = phase.dims[0] * phase.dims[1] * phase.dims[2] * 2;
        await evalDbg<void>(v3d, `d.cine2SetBudget(${Math.floor(fullBytes / 8)})`);
        await startCine(v3d);
        await v3d.getByTestId("cine2-resolution").waitFor({ timeout: 60_000 });
        await waitFrames(v3d, 3);
        const st2 = (await stats(v3d))!;
        const steps2 = await evalDbg<number | null>(v3d, "d.cine2PrimarySteps()");
        check(st2.reason === "budget" && st2.texDims[2] < phase.dims[2], "（前提）予算を 1/8 に下げると間引かれる", st2);
        check(steps2 === st2.texDims[2], `B8: 間引いた格子（z = ${st2.texDims[2]}）でも、歩数が間引き後のテクセル数に一致（歩数はテクスチャの解像度に従う）`, { steps2, texDims: st2.texDims });
        await evalDbg<void>(v3d, "d.cine2SetBudget(null)");
        await stopCine(v3d);
      }

      if (!BASELINE && phase.id === "smooth") {
        const measure = async (tag: string, seed: number) => {
          if (seed) await evalDbg<void>(v3d, `d.cine2SetSeed(${seed})`);
          const sec = await waitFrames(v3d, N_FRAMES);
          await v3d.waitForTimeout(400);
          const a = await analyze(v3d, path.join(OUT_DIR, `smooth-${tag}.png`), null);
          return { mean: a.mean, sec };
        };
        await v3d.getByTestId("cine2-resolution").waitFor({ timeout: 60_000 });
        const full: number[] = [];
        let fullSec = 0;
        for (const seed of [0, 100003, 200003, 300007]) {
          const r = await measure(`full-${seed}`, seed);
          full.push(r.mean);
          if (seed === 0) fullSec = r.sec;
        }
        const floor = Math.max(...full) - Math.min(...full);
        console.log(`  元の解像度 ${N_FRAMES} フレームの平均輝度 ${full.map((x) => x.toFixed(5)).join(" / ")}（雑音の床 = 幅 ${floor.toExponential(2)}）。0 → ${N_FRAMES} フレームの時間 ${fullSec.toFixed(1)} 秒`);
        const stFull = (await stats(v3d))!;
        const stepsFull = await evalDbg<number | null>(v3d, "d.cine2PrimarySteps()");
        check(stFull.reason === "full" && stepsFull === stFull.texDims[2], "（前提）元の解像度で描いている（歩数 = z のテクセル数）", { reason: stFull.reason, stepsFull });
        await stopCine(v3d);

        const fullBytes = phase.dims[0] * phase.dims[1] * phase.dims[2] * 2;
        await evalDbg<void>(v3d, `d.cine2SetBudget(${Math.floor(fullBytes / 8)})`);
        await startCine(v3d);
        await v3d.getByTestId("cine2-resolution").waitFor({ timeout: 60_000 });
        const stHalf = (await stats(v3d))!;
        check(stHalf.reason === "budget" && stHalf.texDims.every((d, i) => d <= Math.ceil(phase.dims[i] / 2) + 1), "（前提）予算 1/8 で各軸おおむね半分の解像度に間引かれる", stHalf.texDims);
        const half = await measure("half-0", 0);
        const diff = Math.abs(half.mean - meanOf(full));
        console.log(`  半分の解像度（補正あり）の平均輝度 ${half.mean.toFixed(5)}（元の解像度の平均 ${meanOf(full).toFixed(5)}・差 ${diff.toExponential(2)}・${N_FRAMES} フレームの時間 ${half.sec.toFixed(1)} 秒）`);
        check(diff <= floor, `B7: 解像度を半分にしても平均輝度が変わらない（差 ${diff.toExponential(2)} ≤ 雑音の床 ${floor.toExponential(2)}）`, { diff, floor });

        // 負例: 補正を切ると、同じ比較で差が床を超える
        await evalDbg<void>(v3d, "d.cine2OpacityCorrection(false)");
        const halfOff = await measure("half-nocorr", 0);
        await stopCine(v3d);
        await evalDbg<void>(v3d, "d.cine2SetBudget(null)");
        await startCine(v3d);
        await v3d.getByTestId("cine2-resolution").waitFor({ timeout: 60_000 });
        await evalDbg<void>(v3d, "d.cine2OpacityCorrection(false)");
        const fullOff = await measure("full-nocorr", 0);
        const diffOff = Math.abs(halfOff.mean - fullOff.mean);
        console.log(`  補正なし: 元 ${fullOff.mean.toFixed(5)} / 半分 ${halfOff.mean.toFixed(5)}（差 ${diffOff.toExponential(2)}）`);
        check(diffOff > floor, `B7（負例）: 補正を切ると、解像度を変えたときの平均輝度の差（${diffOff.toExponential(2)}）が雑音の床（${floor.toExponential(2)}）を超える`, { diffOff, floor });
        await evalDbg<void>(v3d, "d.cine2OpacityCorrection(true)");
      }

      if (phase.id === "stripes" || phase.id === "stripes0") {
        const exp = { period: 4 };
        const samples: number[] = [];
        const nSeeds = BASELINE || phase.id === "stripes0" ? 1 : 4;
        let scale: { x0: number; pxPerVoxel: number; y0: number; y1: number } | null = null;
        for (let i = 0; i < nSeeds; i++) {
          if (!BASELINE && i > 0) await evalDbg<void>(v3d, `d.cine2SetSeed(${100003 * i})`);
          await waitFrames(v3d, N_FRAMES);
          await v3d.waitForTimeout(400);
          if (fs.existsSync(scalePath)) scale = JSON.parse(fs.readFileSync(scalePath, "utf8"));
          const a = await analyze(v3d, path.join(OUT_DIR, `${phase.id}-${LABEL}-${i}.png`), scale ? [scale.y0, scale.y1] : null);
          if (!BASELINE && phase.id === "stripes" && i === 0) {
            if (!a.brightX || !a.brightY) { notReached("B6: 縞の位置（画面）を検出", "明るい列・行が見つからない"); break; }
            // 縞は x = 65 … 445（phase 1）。両端の明るい列の間が 380 ボクセル。
            const pxPerVoxel = (a.brightX[1] - a.brightX[0]) / 380;
            const yMid = Math.round((a.brightY[0] + a.brightY[1]) / 2);
            scale = { x0: a.brightX[0] - 1 * pxPerVoxel, pxPerVoxel, y0: yMid - 40, y1: yMid + 40 };
            fs.writeFileSync(scalePath, JSON.stringify(scale));
            const again = await analyze(v3d, path.join(OUT_DIR, `${phase.id}-${LABEL}-${i}.png`), [scale.y0, scale.y1]);
            a.colMean = again.colMean;
            console.log(`  縞の位置: 画面 x ${a.brightX.join("〜")}（${scale.pxPerVoxel.toFixed(3)} px/ボクセル）・行 ${scale.y0}〜${scale.y1}`);
          }
          if (!scale) { notReached(`B6: 縞の周期成分の振幅（${phase.id}）`, "stripes-scale.json が無い（先に新コードで実行する）"); break; }
          // 中央の窓（ボクセル 192〜320）の縞の周期成分
          // 画面の x = x0 + (ボクセル − 64)·pxPerVoxel（x0 は縞の始まり＝ボクセル 64）
          const wa = Math.round(scale.x0 + (192 - 64) * scale.pxPerVoxel), wb = Math.round(scale.x0 + (320 - 64) * scale.pxPerVoxel);
          const r = amplitudeAt(a.colMean, wa, wb, exp.period * scale.pxPerVoxel);
          samples.push(r.amp);
          console.log(`  ${phase.id} ${LABEL} 実現 ${i}: 縞の周期成分の振幅 ${r.amp.toFixed(5)}（周期 ${r.periodPx.toFixed(3)} px）・平均輝度 ${a.mean.toFixed(5)}`);
        }
        if (samples.length > 0) {
          fs.writeFileSync(path.join(OUT_DIR, `amp-${phase.id}-${LABEL}.json`), JSON.stringify({ label: LABEL, phase: phase.id, frames: N_FRAMES, samples }));
          if (!BASELINE && phase.id === "stripes0") {
            const old0 = path.join(OUT_DIR, "amp-stripes0-old.json");
            if (fs.existsSync(old0)) console.log(`  （記録）旧コードが拾う位相（偶数列）の縞の振幅 旧 ${meanOf(JSON.parse(fs.readFileSync(old0, "utf8")).samples).toFixed(5)} / 新 ${meanOf(samples).toFixed(5)}`);
          }
        }
      }
    }
    console.log(`\n出力: ${OUT_DIR}`);
  } finally {
    await driver.stop().catch(() => undefined);
    fs.rmSync(work, { recursive: true, force: true });
  }
  console.log("");
  console.log(`合格 ${passed} / 失敗 ${failures.length} / 未達 ${unreached.length}`);
  for (const f of failures) console.log(` - 失敗: ${f}`);
  for (const f of unreached) console.log(` - 未達: ${f}`);
  return failures.length > 0 || unreached.length > 0 ? 1 : 0;
}

main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(1); });
