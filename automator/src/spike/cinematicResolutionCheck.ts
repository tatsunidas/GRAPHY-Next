/*
 * シネマティック（パストレース）の 3D テクスチャの大きさ（256 固定をやめ、GPU の予算に応じる）の実アプリ検査。第 1 段（B1〜B5）。
 *
 * 実行:  cd automator && CINE_PY=<numpy・pydicom の入った python> npx tsx src/spike/cinematicResolutionCheck.ts [--baseline] [--label <名前>]
 *   --baseline  導入前のコード（origin/main）用。解像度の行・検査用の口が無いので、収束後の平均輝度だけを取る（B5 の比較用）
 *
 * 合成の CT（ボクセルの添字だけで決まる傾斜＋市松の細かい成分＋中央の球。`scripts/make-ramp-ct-phantom.py`）を使う。期待値は
 * 生成側が numpy で別に計算して書き出したもので、描画側の式を写していない。
 *   big   288×288×272（各軸 256 超・間隔 0.8×0.8×1.0）
 *   small 128×128×100（各軸 256 以下。B5）
 *   thick 288×288×60・z 間隔 5 mm（粗い軸が間引かれないこと。B2）
 *
 *   B1 big を既定のまま開始 → 解像度の行（data-tex-dims が元の寸法・reason=full・data-gpu-bytes が tx·ty·tz·2 + 2·W·H·16）
 *   B2 予算を（必要量 − 1 バイト）に下げて開始し直す → reason=budget・間引いた軸の間隔が増える。thick では 5 mm の z は不変
 *   B3 3D テクスチャの層を読み戻して、元の正規化値と半精度の丸め幅の半分以内で一致（間引かないとき）。間引いた状態では上限を超える画素がある（負例）
 *   B4 パストレーサのコンテキストだけを失わせる → フレーム数が止まり、案内（lost）が出て、vtk の 3D は生きている。失わせない起動では出ない。
 *      ［間引いて再開］で失敗した量の半分以下で作り直し、次の自動の開始は失敗した量を超えない
 *   B5 small は元の寸法のまま。N フレーム蓄積後（既定 60。内蔵 GPU では 400 まで待てない）の平均輝度の差（旧コードとその場で）が、乱数の種だけ変えた 2 枚の差（雑音の床）以下。
 *      開閉を 20 回繰り返しても 3D が開く
 *
 * 結果は 合格・失敗・未達 に分けて数える。🔴 先に 3D が開いてシネマティックが始まることを確かめる。
 * 前提: backend jar。ポートは GRAPHY_AUTOMATOR_HTTP_PORT / _SCP_PORT / _VITE_PORT で他セッションと分ける。JDK を PATH に足す。
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
const labelIdx = process.argv.indexOf("--label");
const LABEL = labelIdx > 0 ? process.argv[labelIdx + 1] : BASELINE ? "old" : "new";
const PY = process.env.CINE_PY ?? "python3";
const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "cinematic-resolution");
const MAKE = path.join(AUTOMATOR_ROOT, "scripts", "make-ramp-ct-phantom.py");
const RECORD_KEY = "graphy.cinematic.gpuRecord";

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

interface Phase { id: "big" | "small" | "thick"; dims: [number, number, number]; spacing: [number, number, number] }
const PHASES: Phase[] = [
  { id: "big", dims: [288, 288, 272], spacing: [0.8, 0.8, 1.0] },
  { id: "small", dims: [128, 128, 100], spacing: [0.8, 0.8, 1.0] },
  { id: "thick", dims: [288, 288, 60], spacing: [0.8, 0.8, 5.0] },
];

interface TexStats {
  texDims: [number, number, number]; srcDims: [number, number, number]; spacingMm: [number, number, number];
  gpuBytes: number; textureBytes: number; budgetBytes: number | null; budgetSource: string; reason: string; lost: boolean; failure: string | null;
}
type Dbg = {
  cine2Stats: () => TexStats | null; cine2SetBudget: (b: number | null) => void; cine2ForceFull: (on: boolean) => void;
  cine2LoseContext: () => boolean; cine2ReadTexLayer: (z: number) => number[] | null; cine2SetSeed: (n: number) => void; cine2FrameCount: () => number;
  getViewer3dState: () => unknown;
};
const evalDbg = <T>(page: Page, body: string): Promise<T> => page.evaluate(`(function(){ var d = window.__graphyDebug; return ${body}; })()`) as Promise<T>;
const stats = (page: Page) => evalDbg<TexStats | null>(page, "d.cine2Stats()");

/** half の ulp（刻み）。丸め誤差の上限は ulp/2。 */
const halfUlp = (v: number): number => {
  if (!(v > 0)) return 2 ** -24;
  const e = Math.floor(Math.log2(v));
  return e < -14 ? 2 ** -24 : 2 ** (e - 10);
};

async function waitRunning(page: Page, timeoutMs = 240_000): Promise<void> {
  await page.waitForFunction(() => /\d+\s*\/\s*400/.test(document.body.innerText), undefined, { timeout: timeoutMs });
}

/** オーバーレイの canvas を撮り、平均輝度（0〜1）を返す。 */
async function meanLuma(page: Page, png: string): Promise<number> {
  const box = await page.evaluate(`(function(){
    var b = document.querySelector('[data-testid="cine2-badge"]');
    var c = b && b.parentElement && b.parentElement.parentElement && b.parentElement.parentElement.querySelector('canvas');
    if (!c) return null; var r = c.getBoundingClientRect(); return {x: r.left, y: r.top, width: r.width, height: r.height};
  })()`) as { x: number; y: number; width: number; height: number } | null;
  if (!box) return Number.NaN;
  await page.evaluate("globalThis.__name = (f) => f");
  const buf = await page.screenshot({ path: png, clip: box });
  return page.evaluate(async (b64) => {
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([bin], { type: "image/png" }));
    const cv = document.createElement("canvas");
    cv.width = bmp.width; cv.height = bmp.height;
    const ctx = cv.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
    let s = 0;
    for (let i = 0; i < d.length; i += 4) s += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    return s / (d.length / 4) / 255;
  }, buf.toString("base64"));
}

/** 収束の目安（400）まで待つと内蔵 GPU では数分以上かかるので、B5 の比較は同じ枚数 N で行う（旧・新・種違いとも同じ N）。 */
const N_FRAMES = Number(process.env.CINE_FRAMES ?? 60);

async function waitFrames(page: Page, n: number, timeoutMs = 600_000): Promise<void> {
  await page.waitForFunction((target) => {
    const t = document.body.innerText.match(/(\d+)\s*\/\s*400/);
    return !!t && Number(t[1]) >= target;
  }, n, { timeout: timeoutMs });
}

async function open3d(driver: DesktopDriver, phase: Phase, fixture: string): Promise<Page> {
  const page = driver.page;
  await resetDb(driver.ports.http);
  const imp = await importPaths(driver.ports.http, [fixture]);
  check(imp.imported === phase.dims[2] && imp.failed === 0, `（前提）${phase.id}: ${phase.dims.join("×")} の合成 CT を取り込めた`, { imported: imp.imported, failed: imp.failed });
  await page.evaluate("localStorage.setItem('graphy.locale', 'ja')");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
  await openFirstSeriesInViewer(page, createStepRecorder());
  const v3d = await driver.waitForNewPage(() => page.locator('button[title="3D Viewer"]').click(), (url) => url.includes("viewer3d"));
  v3d.on("pageerror", (e) => console.log(`  [3d pageerror] ${String(e).slice(0, 200)}`));
  await v3d.locator('[data-testid="viewer3d-mode-slab"]').waitFor({ timeout: 180_000 });
  await v3d.waitForTimeout(6_000);
  await v3d.evaluate("globalThis.__name = (f) => f");
  await v3d.evaluate(`localStorage.removeItem(${JSON.stringify(RECORD_KEY)})`); // 前回の失敗の記録が予算に混ざらないよう、開始時に消す
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

async function main(): Promise<number> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const probe = spawnSync(PY, ["-I", "-c", "import numpy, pydicom"], { encoding: "utf8" });
  if (probe.status !== 0) {
    console.log(`【未達】numpy / pydicom が使えません（CINE_PY=${PY}）。合格にしません。\n${probe.stderr}`);
    return 2;
  }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "cine-res-"));
  const phases = BASELINE ? PHASES.filter((p) => p.id === "small") : PHASES;
  const dirs: Record<string, string> = {};
  const expected: Record<string, { min: number; max: number; layers: Record<string, number[]> }> = {};
  for (const p of phases) {
    dirs[p.id] = path.join(work, p.id);
    const r = spawnSync(PY, ["-I", MAKE, dirs[p.id], "--dims", p.dims.join(","), "--spacing", p.spacing.join(",")], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`ファントムを作れませんでした: ${r.stderr}`);
    expected[p.id] = JSON.parse(fs.readFileSync(path.join(dirs[p.id], "expected.json"), "utf8"));
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
    console.log(`label=${LABEL} baseline=${BASELINE} GPU 名: ${gpuName}`);
    if (gpuName && /llvmpipe|swiftshader/i.test(gpuName)) {
      notReached("ハードウェア描画で起動した", `GPU 名は "${gpuName}"（ソフトウェア描画）。以降は行わない`);
      return 2;
    }

    for (const phase of phases) {
      console.log(`\n===== ${phase.id}: ${phase.dims.join("×")} 間隔 ${phase.spacing.join("×")} mm =====`);
      const v3d = await open3d(driver, phase, dirs[phase.id]);
      const srcVox = phase.dims[0] * phase.dims[1] * phase.dims[2];

      if (BASELINE) {
        await startCine(v3d);
        await waitFrames(v3d, N_FRAMES);
        const mean = await meanLuma(v3d, path.join(OUT_DIR, `${LABEL}-small.png`));
        check(Number.isFinite(mean) && mean > 0.02, `（前提）${N_FRAMES} フレーム蓄積後の画が真っ黒でない（平均輝度）`, mean);
        fs.writeFileSync(path.join(OUT_DIR, `mean-${LABEL}.json`), JSON.stringify({ label: LABEL, mean }));
        console.log(`  収束後の平均輝度 ${mean.toFixed(5)}（${LABEL}）`);
        continue;
      }

      // ---- 既定のまま（検査用の上書きなし）で開始 ----
      await startCine(v3d);
      await v3d.getByTestId("cine2-resolution").waitFor({ timeout: 60_000 });
      const st = (await stats(v3d))!;
      check(st !== null, "🔴 シネマティックが始まり、検査用の口 cine2Stats が使える");
      const row = v3d.getByTestId("cine2-resolution");
      const attr = async (n: string) => (await row.getAttribute(n)) ?? "";
      const texDims = (await attr("data-tex-dims")).split(",").map(Number);
      const canvasWH = (await v3d.evaluate(`(function(){ var b = document.querySelector('[data-testid="cine2-badge"]'); var c = b.parentElement.parentElement.querySelector('canvas'); return [c.width, c.height]; })()`)) as number[];
      console.log(`  解像度の行: tex=${texDims.join("×")} reason=${await attr("data-reason")} source=${await attr("data-budget-source")} gpuBytes=${await attr("data-gpu-bytes")}（canvas ${canvasWH.join("×")}）`);

      if (phase.id === "big") {
        check(JSON.stringify(texDims) === JSON.stringify(phase.dims) && (await attr("data-reason")) === "full", "B1: 既定のまま、元の寸法・reason=full", { texDims, reason: await attr("data-reason") });
        const want = texDims[0] * texDims[1] * texDims[2] * 2 + 2 * canvasWH[0] * canvasWH[1] * 16;
        check(Number(await attr("data-gpu-bytes")) === want, "B1: data-gpu-bytes = tx·ty·tz·2 + 2·W·H·16", { got: await attr("data-gpu-bytes"), want });
        check((await attr("data-src-dims")) === phase.dims.join(","), "B1: data-src-dims が元の寸法");
        await v3d.screenshot({ path: path.join(OUT_DIR, "big-full.png") });

        // B3: 間引かないときの 3D テクスチャの値（層を読み戻して、元の正規化値と半精度の丸め幅の半分以内）
        // 許容は 1 ulp: float→半精度の変換は最近接丸めか切り捨てかが実装まかせ（WebGL2/ES 3.0）。実機（Mesa）は切り捨て相当で、
        // 丸め幅の半分（ulp/2）を超える値が半数ほど出る。1 ulp ≤ 2^-11 は LUT の 1 段（1/255）の 1/7 以下で、見た目には効かない。
        let worst = 0, over = 0, overHalf = 0, n = 0, nullRead = 0;
        for (const kStr of Object.keys(expected.big.layers)) {
          const got = await evalDbg<number[] | null>(v3d, `d.cine2ReadTexLayer(${Number(kStr)})`);
          if (!got) { nullRead++; continue; }
          const exp = expected.big.layers[kStr];
          for (let i = 0; i < exp.length; i++) {
            const e = Math.abs(got[i] - exp[i]);
            const tol = halfUlp(exp[i]) + 1e-7;
            if (e > tol) over++;
            if (e > halfUlp(exp[i]) / 2 + 1e-7) overHalf++;
            worst = Math.max(worst, e / Math.max(tol, 1e-12));
            n++;
          }
        }
        if (nullRead > 0) notReached("B3: 3D テクスチャの層の読み戻し", `${nullRead} 層が読めなかった（R16F が描画先にできない GPU か）`);
        else {
          console.log(`  B3 の実測: ${n} 値のうち 1 ulp 超 ${over}、ulp/2 超 ${overHalf}（最大誤差は 1 ulp の ${worst.toFixed(3)} 倍）`);
          check(over === 0 && n > 0, `B3: 間引かないとき、全 ${n} 値が元の正規化値と 1 ulp（半精度の刻み）以内（超過 ${over}）`, { over, n, worstRatio: worst });
        }

        // B4 の正例: 失わせない起動では案内が出ない（先に確かめる）
        check((await v3d.getByTestId("cine2-lost").count()) === 0, "B4（正例）: 失わせないときは案内が出ない");
        await waitFrames(v3d, 5);
        const f0 = await evalDbg<number>(v3d, "d.cine2FrameCount()");
        await v3d.waitForTimeout(1500);
        const f1 = await evalDbg<number>(v3d, "d.cine2FrameCount()");
        check(f1 > f0, "B4（前提）: フレーム数が増えている（描いている）", { f0, f1 });

        // B4: パストレーサのコンテキストだけを失わせる
        const lostOk = await evalDbg<boolean>(v3d, "d.cine2LoseContext()");
        check(lostOk, "B4: パストレーサのコンテキストを失わせた");
        await v3d.getByTestId("cine2-lost").waitFor({ timeout: 15_000 }).catch(() => undefined);
        const card = v3d.getByTestId("cine2-lost");
        check((await card.count()) === 1 && (await card.getAttribute("data-kind")) === "lost", "B4: 案内 cine2-lost（kind=lost）が出る");
        const g0 = await evalDbg<number>(v3d, "d.cine2FrameCount()");
        await v3d.waitForTimeout(1500);
        const g1 = await evalDbg<number>(v3d, "d.cine2FrameCount()");
        check(g1 === g0, "B4: フレーム数が止まる（n/400 が増えない）", { g0, g1 });
        const vtkAlive = await evalDbg<unknown>(v3d, "d.getViewer3dState()");
        check(vtkAlive !== null && typeof vtkAlive === "object", "B4: 下の vtk の 3D は生きている（getViewer3dState が返る）");
        await v3d.screenshot({ path: path.join(OUT_DIR, "big-lost.png") });
        const body = (await v3d.getByTestId("cine2-lost-body").textContent()) ?? "";
        console.log(`  案内: ${body}`);
        const rec = JSON.parse((await v3d.evaluate(`localStorage.getItem(${JSON.stringify(RECORD_KEY)})`)) as string);
        const failMin = Object.values(rec as Record<string, { failMinBytes?: number }>)[0]?.failMinBytes ?? 0;
        check(failMin === st.textureBytes, "B4: 失敗した量（テクスチャのバイト数）が GPU ごとに記録される", { failMin, tex: st.textureBytes });

        // ［間引いて再開］
        await v3d.getByTestId("cine2-retry-downsampled").click();
        await v3d.waitForFunction(() => !!(window as unknown as { __graphyDebug: { cine2Stats: () => unknown } }).__graphyDebug.cine2Stats(), undefined, { timeout: 60_000 });
        await v3d.getByTestId("cine2-resolution").waitFor({ timeout: 60_000 });
        const st2 = (await stats(v3d))!;
        check(st2.reason === "budget" && st2.textureBytes <= Math.floor(failMin / 2), "B4: ［間引いて再開］は失敗した量の半分以下で作り直す", { reason: st2.reason, tex: st2.textureBytes, failMin });
        await waitFrames(v3d, 3);
        check((await v3d.getByTestId("cine2-lost").count()) === 0, "B4: 再開後は案内が消えて描いている");
        // 次の自動の開始は、失敗した量を超えない
        await stopCine(v3d);
        await startCine(v3d);
        await v3d.getByTestId("cine2-resolution").waitFor({ timeout: 60_000 });
        const st3 = (await stats(v3d))!;
        check(st3.textureBytes < failMin, "B4: 次の自動の開始は失敗した量を超えない（記録で予算が下がる）", { tex: st3.textureBytes, failMin, source: st3.budgetSource });
        await v3d.evaluate(`localStorage.removeItem(${JSON.stringify(RECORD_KEY)})`);
        await stopCine(v3d);

        // ---- B2: 予算を（必要量 − 1 バイト）に下げて開始し直す ----
        const fullBytes = phase.dims[0] * phase.dims[1] * phase.dims[2] * 2;
        await evalDbg<void>(v3d, `d.cine2SetBudget(${fullBytes - 1})`);
        await startCine(v3d);
        await v3d.getByTestId("cine2-resolution").waitFor({ timeout: 60_000 });
        const sb = (await stats(v3d))!;
        check(sb.reason === "budget" && sb.textureBytes <= fullBytes - 1 && sb.textureBytes > 0, "B2: 予算 −1 バイトで reason=budget・テクスチャが予算以下", { reason: sb.reason, tex: sb.textureBytes, budget: fullBytes - 1 });
        check(sb.spacingMm.some((s, i) => s > phase.spacing[i] + 1e-6), "B2: 間引いた軸の間隔が元より大きい", { spacing: sb.spacingMm });
        check((await row.textContent())?.includes("間引き") === true, "B2: 画面の行に「間引き」と元・間引き後の間隔が出る", await row.textContent());
        await v3d.screenshot({ path: path.join(OUT_DIR, "big-reduced.png") });
        // B3 の負例: 間引いた状態で「同じ添字どうし」を比べると、上限を超える画素がある（検査が差を拾える）
        const got = await evalDbg<number[] | null>(v3d, "d.cine2ReadTexLayer(0)");
        if (!got) notReached("B3（負例）: 間引いた状態の層の読み戻し", "読めなかった");
        else {
          const [tx, ty] = sb.texDims;
          const e0 = expected.big.layers["0"];
          let ov = 0;
          for (let y = 0; y < ty; y++) for (let x = 0; x < tx; x++) {
            const ox = Math.min(phase.dims[0] - 1, Math.floor((x * phase.dims[0]) / tx));
            const oy = Math.min(phase.dims[1] - 1, Math.floor((y * phase.dims[1]) / ty));
            const ex = e0[oy * phase.dims[0] + ox];
            if (Math.abs(got[y * tx + x] - ex) > halfUlp(ex) + 1e-7) ov++;
          }
          check(ov > 0, `B3（負例）: 間引いた状態では、元の画素との差が丸め幅を超える画素がある（${ov} 画素）`, ov);
        }
        await stopCine(v3d);
        await evalDbg<void>(v3d, "d.cine2SetBudget(null)");
      }

      if (phase.id === "thick") {
        check(JSON.stringify(texDims) === JSON.stringify(phase.dims), "thick: 既定では元の寸法", texDims);
        await stopCine(v3d);
        const fullBytes = phase.dims[0] * phase.dims[1] * phase.dims[2] * 2;
        await evalDbg<void>(v3d, `d.cine2SetBudget(${fullBytes - 1})`);
        await startCine(v3d);
        await v3d.getByTestId("cine2-resolution").waitFor({ timeout: 60_000 });
        const sb = (await stats(v3d))!;
        check(sb.reason === "budget" && sb.texDims[2] === phase.dims[2], "B2: 元の間隔が粗い軸（5 mm の z）は間引かれない（寸法が元のまま）", { texDims: sb.texDims });
        check(sb.texDims[0] < phase.dims[0] || sb.texDims[1] < phase.dims[1], "B2: 細かい面内の軸から間引かれる", { texDims: sb.texDims });
        await v3d.screenshot({ path: path.join(OUT_DIR, "thick-reduced.png") });
        await evalDbg<void>(v3d, "d.cine2SetBudget(null)");
      }

      if (phase.id === "small") {
        check(JSON.stringify(texDims) === JSON.stringify(phase.dims) && (await attr("data-reason")) === "full", "B5: 各軸 256 以下のボリュームは元の寸法のまま・reason=full", { texDims, reason: await attr("data-reason") });
        await waitFrames(v3d, N_FRAMES);
        await v3d.waitForTimeout(500);
        const meanA = await meanLuma(v3d, path.join(OUT_DIR, `${LABEL}-small.png`));
        check(Number.isFinite(meanA) && meanA > 0.02, `（前提）${N_FRAMES} フレーム蓄積後の画が真っ黒でない（平均輝度）`, meanA);
        // 雑音の床: 同じコードで乱数の種だけ変えて、もう一度 400 フレーム蓄積する
        await evalDbg<void>(v3d, "d.cine2SetSeed(100003)");
        await waitFrames(v3d, N_FRAMES);
        await v3d.waitForTimeout(500);
        const meanB = await meanLuma(v3d, path.join(OUT_DIR, `${LABEL}-small-seed.png`));
        const floor = Math.abs(meanA - meanB);
        console.log(`  収束後の平均輝度 A=${meanA.toFixed(5)} B(種違い)=${meanB.toFixed(5)} 雑音の床=${floor.toExponential(2)}`);
        fs.writeFileSync(path.join(OUT_DIR, `mean-${LABEL}.json`), JSON.stringify({ label: LABEL, mean: meanA, floor }));
        const oldPath = path.join(OUT_DIR, "mean-old.json");
        if (fs.existsSync(oldPath)) {
          const old = JSON.parse(fs.readFileSync(oldPath, "utf8")) as { mean: number };
          const diff = Math.abs(meanA - old.mean);
          check(diff <= floor, `B5: 旧コードと新コードの ${N_FRAMES} フレーム蓄積後の平均輝度の差（${diff.toExponential(2)}）が、乱数の種だけ変えた差（雑音の床 ${floor.toExponential(2)}）以下`, { diff, floor, old: old.mean, new: meanA });
        } else notReached("B5: 旧コードとの平均輝度の比較", "mean-old.json が無い（先に --baseline を origin/main のコードで実行する）");
        // 開閉を 20 回繰り返しても 3D が開く（作ったコンテキストを残さない）
        await stopCine(v3d);
        for (let i = 0; i < 20; i++) {
          await toggle(v3d).click();
          await v3d.getByTestId("cine2-badge").waitFor({ timeout: 30_000 });
          await v3d.waitForTimeout(150);
          await toggle(v3d).click();
          await v3d.getByTestId("cine2-badge").waitFor({ state: "detached", timeout: 30_000 });
        }
        await startCine(v3d);
        await v3d.getByTestId("cine2-resolution").waitFor({ timeout: 60_000 });
        check((await stats(v3d)) !== null && (await v3d.getByTestId("cine2-lost").count()) === 0, "B5: 開閉 20 回のあとも 3D（シネマティック）が開く");
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
