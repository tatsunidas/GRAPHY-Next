/*
 * シネマティック（パストレース）の 3D テクスチャの予算（NVIDIA の空きメモリ）と、GPU メモリ超過の実アプリ検査。第 3 段（B9・B10）。
 *
 * 実行:  cd automator && CINE_PY=<numpy・pydicom の入った python> npx tsx src/spike/cinematicGpuLimitCheck.ts [--only b9|b10]
 *   B10_DIMS=900,900,900   B10 の巨大ファントムの寸法（既定 900×900×900 ≈ 1.5 GB の DICOM。必要量が空きを超えるように大きくする）
 *
 * ハイブリッド GPU（Intel 内蔵 + NVIDIA 単体）の機械で、描画 GPU を切り替えて起動する（`desktop/render-prefs.json` ＝ hybridGpuCheck と同じ。
 * 終了時に消す）。NVIDIA が無い機械では全部「未達」。
 *
 *   B9  正例: 描画 GPU が NVIDIA（WebGL の renderer が NVIDIA）で起動 → 予算の出どころが nvidia-free、値が開始直前の `nvidia-smi` の free − 内部バッファ
 *       （許容 = 開始前に 5 回測った free の変動幅 + 表示の丸め 1 MiB。固定の閾値を置かない）。
 *   B9  負例: 同じ機械を Intel 内蔵で描くように起動 → nvidia-smi には NVIDIA の空きが出ているのに、nvidia-free にしない（shared になる）。
 *   B10 NVIDIA で、元の解像度を強制（cine2ForceFull）して、空きを超える大きさのボリュームでシネマティックを開始 → 結果を記録する:
 *       失敗したなら（案内 cine2-lost が出る）アプリが固まらない・［間引いて再開］で失敗量より小さい予算で描ける・次の自動の開始は失敗量を超えない。
 *       はみ出さずに描けた（ドライバが吸収した）なら、B10 の負例が成立していないので「未達」（合格にしない）。vtk の 3D も失ったか（glLost）を記録する。
 *
 * 結果は 合格・失敗・未達 に分けて数える。🔴 先に 3D が開いてシネマティックが始まることを確かめる。
 * 前提: backend jar（再ビルド済み）。ポートは GRAPHY_AUTOMATOR_HTTP_PORT / _SCP_PORT / _VITE_PORT で他セッションと分ける。JDK を PATH に足す。
 */
import { execFileSync, spawnSync } from "node:child_process";
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

const PY = process.env.CINE_PY ?? "python3";
const ONLY = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : "";
const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "cinematic-gpu-limit");
const MAKE = path.join(AUTOMATOR_ROOT, "scripts", "make-ramp-ct-phantom.py");
const DESKTOP_DIR = path.join(AUTOMATOR_ROOT, "..", "desktop");
const PREFS = path.join(DESKTOP_DIR, "render-prefs.json");
const STATE = path.join(DESKTOP_DIR, "render-gpu-state.json");
const RECORD_KEY = "graphy.cinematic.gpuRecord";
const MIB = 1024 * 1024;

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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** `nvidia-smi` の NVIDIA の空き（MiB・整数）。1 枚目だけ（この検査の機械は NVIDIA が 1 枚）。 */
function smiFreeMib(): { name: string; freeMib: number; totalMib: number } | null {
  try {
    const out = execFileSync("nvidia-smi", ["--query-gpu=name,memory.free,memory.total", "--format=csv,noheader,nounits"], { encoding: "utf8", timeout: 5000 });
    const f = out.trim().split("\n")[0].split(",").map((x) => x.trim());
    if (f.length < 3 || !/^\d+$/.test(f[f.length - 2]) || !/^\d+$/.test(f[f.length - 1])) return null;
    return { name: f.slice(0, -2).join(", "), freeMib: Number(f[f.length - 2]), totalMib: Number(f[f.length - 1]) };
  } catch {
    return null;
  }
}

/** scripts/dev-desktop.sh が Electron の起動前に足すのと同じ環境変数（renderPrefsEnv.js の出力）。 */
const devScriptEnv = (): Record<string, string> => {
  const out = execFileSync("node", ["renderPrefsEnv.js"], { cwd: DESKTOP_DIR, encoding: "utf8" });
  const env: Record<string, string> = {};
  for (const m of out.matchAll(/^export (\w+)=(.*)$/gm)) env[m[1]] = m[2];
  return env;
};

interface TexStats {
  texDims: [number, number, number]; srcDims: [number, number, number]; spacingMm: [number, number, number];
  gpuBytes: number; textureBytes: number; budgetBytes: number | null; budgetSource: string; reason: string; lost: boolean; failure: string | null;
}
const evalDbg = <T>(page: Page, body: string): Promise<T> => page.evaluate(`(function(){ var d = window.__graphyDebug; return ${body}; })()`) as Promise<T>;
const stats = (page: Page) => evalDbg<TexStats | null>(page, "d.cine2Stats()");

/** 実際に WebGL が描いている GPU（UNMASKED_RENDERER）。🔴 Chromium の getGPUInfo の active は、内蔵 GPU で描いていても NVIDIA を指すことがあるので使わない。 */
async function renderer(page: Page): Promise<string> {
  return (await page.evaluate(`(function(){
    var gl = document.createElement('canvas').getContext('webgl2'); if (!gl) return '';
    var x = gl.getExtension('WEBGL_debug_renderer_info'); var r = x ? String(gl.getParameter(x.UNMASKED_RENDERER_WEBGL)) : '';
    var l = gl.getExtension('WEBGL_lose_context'); if (l) l.loseContext(); return r;
  })()`)) as string;
}
const smiNameMatches = (rend: string, smiName: string): boolean => rend.toLowerCase().includes(smiName.replace(/^NVIDIA\s+/i, "").toLowerCase());

async function open3d(driver: DesktopDriver, fixture: string, expectCount: number, waitMs: number): Promise<Page> {
  const page = driver.page;
  await resetDb(driver.ports.http);
  const imp = await importPaths(driver.ports.http, [fixture]);
  check(imp.imported === expectCount && imp.failed === 0, `（前提）${expectCount} 枚の合成 CT を取り込めた`, { imported: imp.imported, failed: imp.failed });
  await page.evaluate("localStorage.setItem('graphy.locale', 'ja')");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
  await openFirstSeriesInViewer(page, createStepRecorder());
  const v3d = await driver.waitForNewPage(() => page.locator('button[title="3D Viewer"]').click(), (url) => url.includes("viewer3d"));
  v3d.on("pageerror", (e) => console.log(`  [3d pageerror] ${String(e).slice(0, 200)}`));
  await v3d.locator('[data-testid="viewer3d-mode-slab"]').waitFor({ timeout: waitMs });
  await v3d.waitForTimeout(6_000);
  await v3d.evaluate("globalThis.__name = (f) => f");
  await v3d.evaluate(`localStorage.removeItem(${JSON.stringify(RECORD_KEY)})`); // 前回の失敗の記録が予算に混ざらないよう、開始時に消す
  return v3d;
}

const toggle = (v3d: Page) => v3d.getByTestId("viewer3d-cinematic-toggle");
async function startCine(v3d: Page): Promise<void> {
  await toggle(v3d).click();
  await v3d.getByTestId("cine2-badge").waitFor({ timeout: 120_000 });
}

async function launch(nvidia: boolean, run: (d: DesktopDriver) => Promise<void>): Promise<void> {
  fs.rmSync(PREFS, { force: true });
  fs.rmSync(STATE, { force: true });
  if (nvidia) fs.writeFileSync(PREFS, JSON.stringify({ gpu: "high" }), "utf8");
  const driver = new DesktopDriver({}, { extraEnv: devScriptEnv() });
  try {
    await driver.start();
    await run(driver);
  } finally {
    await driver.stop().catch(() => undefined);
    fs.rmSync(PREFS, { force: true });
    fs.rmSync(STATE, { force: true });
  }
}

function makePhantom(dir: string, dims: number[], spacing: number[]): void {
  const r = spawnSync(PY, ["-I", MAKE, dir, "--dims", dims.join(","), "--spacing", spacing.join(",")], { encoding: "utf8", maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`ファントムを作れませんでした: ${r.stderr}`);
}

async function b9(work: string): Promise<void> {
  const dims = [288, 288, 272];
  const dir = path.join(work, "b9");
  makePhantom(dir, dims, [0.8, 0.8, 1.0]);

  // ── 負例: Intel 内蔵で描く ──
  console.log("\n===== B9 負例: Intel 内蔵で描く（nvidia-smi には NVIDIA の空きが出ている） =====");
  await launch(false, async (driver) => {
    const v3d = await open3d(driver, dir, dims[2], 180_000);
    const rend = await renderer(v3d);
    console.log(`  描画の GPU（WebGL の renderer）: ${rend}`);
    check(rend !== "" && !/NVIDIA/i.test(rend), "（前提）WebGL が描いている GPU は NVIDIA ではない", rend);
    const smi0 = smiFreeMib();
    check(smi0 !== null, "（前提）nvidia-smi には NVIDIA の空きが出ている（負例が意味を持つ）", smi0);
    await startCine(v3d);
    await v3d.getByTestId("cine2-resolution").waitFor({ timeout: 60_000 });
    const st = (await stats(v3d))!;
    check(st !== null, "🔴 シネマティックが始まり、検査用の口 cine2Stats が使える");
    check(st.budgetSource !== "nvidia-free", `B9（負例）: 内蔵 GPU で描くとき、予算の出どころは nvidia-free にならない（${st.budgetSource}）`, st.budgetSource);
    await v3d.screenshot({ path: path.join(OUT_DIR, "b9-intel.png") });
  });

  // ── 正例: NVIDIA で描く ──
  console.log("\n===== B9 正例: NVIDIA で描く =====");
  await launch(true, async (driver) => {
    const v3d = await open3d(driver, dir, dims[2], 180_000);
    const rend = await renderer(v3d);
    console.log(`  描画の GPU（WebGL の renderer）: ${rend}`);
    const smi = smiFreeMib();
    if (!smi || !/NVIDIA/i.test(rend) || !smiNameMatches(rend, smi.name)) {
      notReached("B9（正例）: NVIDIA で描いて起動した", `renderer=${rend} smi=${JSON.stringify(smi)}`);
      return;
    }
    check(true, `（前提）WebGL が描いている GPU は NVIDIA で、nvidia-smi の行（${smi.name}）と名前が一致`);
    const samples: number[] = [];
    for (let i = 0; i < 5; i++) {
      samples.push(smiFreeMib()!.freeMib);
      await sleep(200);
    }
    const lo = Math.min(...samples), hi = Math.max(...samples);
    await startCine(v3d);
    await v3d.getByTestId("cine2-resolution").waitFor({ timeout: 60_000 });
    const st = (await stats(v3d))!;
    check(st !== null, "🔴 シネマティックが始まり、検査用の口 cine2Stats が使える");
    const row = v3d.getByTestId("cine2-resolution");
    check((await row.getAttribute("data-budget-source")) === "nvidia-free", "B9（正例）: 予算の出どころが nvidia-free（data-budget-source）", await row.getAttribute("data-budget-source"));
    check(st.budgetSource === "nvidia-free", "B9（正例）: cine2Stats の budgetSource も nvidia-free", st.budgetSource);
    // 予算 + 内部バッファ = 開始の瞬間の free。押す前に測った free（lo〜hi）との差は、
    //   上側: 測定の変動幅（+ 表示の丸め 1 MiB）、下側: 押した直後にオーバーレイの canvas の裏面（W·H·4 B × 3 面）が先に確保される分。
    // 総量（totalMiB）や別の値を使っていれば、この幅に入らない。
    const canvasWH = (await v3d.evaluate(`(function(){ var b = document.querySelector('[data-testid="cine2-badge"]'); var el = b; while (el && !(el.style && el.style.zIndex === '12')) el = el.parentElement; var c = el.querySelector('canvas'); return [c.width, c.height]; })()`)) as number[];
    const internal = 2 * canvasWH[0] * canvasWH[1] * 16 + 1024;
    const freeFromBudget = ((st.budgetBytes ?? Number.NaN) + internal) / MIB;
    const slackUp = hi - lo + 1;
    const slackDown = (3 * canvasWH[0] * canvasWH[1] * 4) / MIB;
    console.log(`  押す前の nvidia-smi free: ${lo}〜${hi} MiB（5 回）／予算 + 内部バッファ = ${freeFromBudget.toFixed(1)} MiB（許容: 上 +${slackUp.toFixed(1)}・下 −${slackDown.toFixed(1)} MiB）／total ${smi.totalMib} MiB`);
    check(Number.isFinite(freeFromBudget) && freeFromBudget <= hi + slackUp && freeFromBudget >= lo - slackDown, "B9（正例）: 予算 + 内部バッファ が開始直前の nvidia-smi の free と一致する", { freeFromBudget, lo, hi, slackUp, slackDown });
    check(st.reason === "full", "（情報）この大きさのボリュームは空きに収まり、間引かない（reason=full）", st.reason);
    await v3d.screenshot({ path: path.join(OUT_DIR, "b9-nvidia.png") });
  });
}

async function b10(work: string): Promise<void> {
  const dims = (process.env.B10_DIMS ?? "900,900,900").split(",").map(Number);
  const dir = path.join(work, "b10");
  const du = spawnSync("df", ["-Pm", work], { encoding: "utf8" }).stdout.trim().split("\n")[1].split(/\s+/);
  const needMb = Math.ceil((dims[0] * dims[1] * dims[2] * 2) / MIB) + 512;
  if (Number(du[3]) < needMb * 2) {
    notReached("B10: 巨大ファントムの生成", `空き ${du[3]} MB < 必要 ${needMb * 2} MB`);
    return;
  }
  console.log(`\n===== B10: ${dims.join("×")}（DICOM 約 ${Math.round(needMb)} MB）を NVIDIA で・元の解像度を強制 =====`);
  makePhantom(dir, dims, [0.8, 0.8, 0.8]);
  const texBytes = dims[0] * dims[1] * dims[2] * 2;
  await launch(true, async (driver) => {
    const v3d = await open3d(driver, dir, dims[2], 900_000);
    const rend = await renderer(v3d);
    const smi = smiFreeMib();
    if (!smi || !/NVIDIA/i.test(rend)) {
      notReached("B10: NVIDIA で描いて起動した", `renderer=${rend}`);
      return;
    }
    console.log(`  3D を開いた後の nvidia-smi: free ${smi.freeMib} / total ${smi.totalMib} MiB。パストレーサのテクスチャ（R16F）の必要量 ${(texBytes / MIB).toFixed(0)} MiB`);
    const need = texBytes / MIB;
    if (need <= smi.freeMib) notReached("B10: 必要量が空きを超える", `必要 ${need.toFixed(0)} MiB ≤ 空き ${smi.freeMib} MiB。B10_DIMS を大きくする`);
    await evalDbg<void>(v3d, "d.cine2ForceFull(true)");
    await toggle(v3d).click();
    // 描けた（cine2-resolution）か、失敗の案内（cine2-lost）かのどちらか
    const outcome = await Promise.race([
      v3d.getByTestId("cine2-resolution").waitFor({ timeout: 240_000 }).then(() => "resolution" as const),
      v3d.getByTestId("cine2-lost").waitFor({ timeout: 240_000 }).then(() => "lost" as const),
    ]).catch(() => "timeout" as const);
    console.log(`  結果: ${outcome}`);
    await v3d.screenshot({ path: path.join(OUT_DIR, "b10-after-start.png") }).catch(() => undefined);
    const responsive = await Promise.race([v3d.evaluate("1+1").then((x) => x === 2), sleep(30_000).then(() => false)]).catch(() => false);
    check(responsive, "B10: 画面が固まらない（renderer が 30 秒以内に応答する）");
    const bodyText = (await v3d.evaluate("document.body.innerText").catch(() => "")) as string;
    const vtkLost = bodyText.includes("GPU（WebGL）コンテキストが失われたため 3D 表示を継続できません");
    console.log(`  記録: vtk の 3D も失ったか（viewer3d.glLost の文言）= ${vtkLost}`);
    const smi2 = smiFreeMib();
    console.log(`  nvidia-smi: free ${smi2?.freeMib} MiB（開始後）`);
    if (outcome === "timeout") {
      check(false, "B10: 開始が 240 秒以内に「描けた」か「案内」のどちらかに決着する");
      return;
    }
    if (outcome === "resolution") {
      // 「描けた」と言う前に、本当に描いているか（フレームが進むか・画が真っ黒でないか）を見る。getError を見ない失敗は黙って黒くなる。
      await v3d.waitForTimeout(3_000);
      const f0 = await evalDbg<number>(v3d, "d.cine2FrameCount()");
      await v3d.waitForTimeout(20_000);
      const f1 = await evalDbg<number>(v3d, "d.cine2FrameCount()");
      const lostNow = (await stats(v3d))?.lost ?? null;
      const smi3 = smiFreeMib();
      console.log(`  20 秒間のフレーム: ${f0} → ${f1}（lost=${lostNow}）／nvidia-smi free ${smi3?.freeMib} MiB（total ${smi3?.totalMib}）`);
      await v3d.screenshot({ path: path.join(OUT_DIR, "b10-after-20s.png") }).catch(() => undefined);
      const st = await stats(v3d);
      notReached("B10（負例）: 空きを超える元の解像度で失敗する", `はみ出さずに描けた（ドライバが吸収したか、他に原因）。tex ${st?.texDims.join("×")} 必要 ${need.toFixed(0)} MiB 空き ${smi.freeMib} MiB。合格にしない`);
      return;
    }
    // 失敗した（案内が出た）
    const card = v3d.getByTestId("cine2-lost");
    const kind = await card.getAttribute("data-kind");
    console.log(`  案内: kind=${kind} 「${((await v3d.getByTestId("cine2-lost-body").textContent()) ?? "").slice(0, 200)}」`);
    check(kind === "create" || kind === "lost", "B10: 失敗の案内（cine2-lost）が出る", kind);
    const rec = JSON.parse(((await v3d.evaluate(`localStorage.getItem(${JSON.stringify(RECORD_KEY)})`)) as string) ?? "{}") as Record<string, { failMinBytes?: number }>;
    const failMin = Object.values(rec)[0]?.failMinBytes ?? 0;
    check(failMin > 0, "B10: 失敗した量が GPU ごとに記録される", { failMin });
    if (vtkLost) {
      notReached("B10: ［間引いて再開］以降", "vtk の 3D も失われた（glLost）。この機械ではパストレーサの失敗が 3D 全体の喪失になる");
      return;
    }
    check(true, "B10: 喪失はパストレーサだけで済み、vtk の 3D は残った（glLost が出ていない）");
    const vtkAlive = await evalDbg<unknown>(v3d, "d.getViewer3dState()");
    check(vtkAlive !== null && typeof vtkAlive === "object", "B10: 下の vtk の 3D は生きている（getViewer3dState が返る）");
    await v3d.getByTestId("cine2-retry-downsampled").click();
    await v3d.getByTestId("cine2-resolution").waitFor({ timeout: 240_000 });
    const st2 = (await stats(v3d))!;
    check(st2.textureBytes < failMin, "B10: ［間引いて再開］は失敗した量より小さいテクスチャで描ける", { tex: st2.textureBytes, failMin });
    const f0 = await evalDbg<number>(v3d, "d.cine2FrameCount()");
    await v3d.waitForTimeout(5_000);
    const f1 = await evalDbg<number>(v3d, "d.cine2FrameCount()");
    check(f1 > f0, "B10: 再開後は描いている（フレーム数が増える）", { f0, f1 });
    await v3d.screenshot({ path: path.join(OUT_DIR, "b10-retry.png") });
    await toggle(v3d).click();
    await v3d.getByTestId("cine2-badge").waitFor({ state: "detached", timeout: 60_000 });
    await evalDbg<void>(v3d, "d.cine2ForceFull(false)");
    await startCine(v3d);
    await v3d.getByTestId("cine2-resolution").waitFor({ timeout: 240_000 });
    const st3 = (await stats(v3d))!;
    check(st3.textureBytes < failMin, "B10: 次の自動の開始は失敗した量を超えない", { tex: st3.textureBytes, failMin, source: st3.budgetSource });
  });
}

async function main(): Promise<number> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  if (!smiFreeMib()) {
    notReached("B9・B10", "nvidia-smi が使えない（NVIDIA の機械ではない）");
  } else {
    const probe = spawnSync(PY, ["-I", "-c", "import numpy, pydicom"], { encoding: "utf8" });
    if (probe.status !== 0) {
      console.log(`【未達】numpy / pydicom が使えません（CINE_PY=${PY}）。合格にしません。\n${probe.stderr}`);
      return 2;
    }
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "cine-gpu-"));
    try {
      if (ONLY !== "b10") await b9(work);
      if (ONLY !== "b9") await b10(work);
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
      fs.rmSync(PREFS, { force: true });
      fs.rmSync(STATE, { force: true });
    }
  }
  console.log(`\n出力: ${OUT_DIR}`);
  console.log(`合格 ${passed} / 失敗 ${failures.length} / 未達 ${unreached.length}`);
  for (const f of failures) console.log(` - 失敗: ${f}`);
  for (const f of unreached) console.log(` - 未達: ${f}`);
  return failures.length > 0 || unreached.length > 0 ? 1 : 0;
}

main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(1); });
