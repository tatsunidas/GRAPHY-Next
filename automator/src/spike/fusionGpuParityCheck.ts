/*
 * Fusion のリサンプルの GPU（WebGL2）経路の実機検証（実際の Electron・実際の GPU・実データ PET/CT）。
 *
 * 見るもの（合格・失敗・未達を分けて数える。GPU が選ばれなかった起動では GPU の検査は「未達」で、合格にしない）:
 *   R1 通常起動（開発機の GPU）: 判定が出る → GPU が選ばれたら C4（全背景スライスで GPU と CPU を両方計算した一致検査、違反 0）・
 *        C7（状態バーの前景値が CPU 固定のときと同じ）・C8（速さ）。選ばれなければ理由を記録（「速くならない」を含む）。
 *   R2 ソフトウェア描画: engine=cpu・理由 software。表示（canvas の画素）が、設定 cpu のときと一致（導入前のコードとの比較は --baseline）。
 *   R3〜R5 負例: dev 用のフラグでシェーダに誤り（半ボクセル・u と v の取り違え・z の選び違い）を入れる →
 *        カナリアで落ちて engine=cpu・parity-failed、それでも表示は出る（画面が空にならない）。
 *
 * 実行:  cd automator && npx tsx src/spike/fusionGpuParityCheck.ts            （新しいコード）
 *        cd automator && npx tsx src/spike/fusionGpuParityCheck.ts --baseline  （導入前のコードで、表示の基準だけ取る。デバッグ API は使わない）
 * 前提: backend/target/graphy-next-backend.jar が今のビルド、~/graphy-demo-samples/PSMA_0198cdca94fbb95f。結果: .results/fusion-gpu-parity-check/
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";

import { resetDb } from "../backend/dbReset.js";
import { dismissStartupDialogs } from "../common/dismissDialogs.js";
import { DesktopDriver } from "../driver/desktopDriver.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { createChecker } from "./computeSpikeShared.js";

const BASELINE = process.argv.includes("--baseline");
const OUT = path.join(AUTOMATOR_ROOT, ".results", "fusion-gpu-parity-check");
const DATA = path.join(process.env.GRAPHY_GUIDE_DATA ?? path.join(os.homedir(), "graphy-demo-samples"), "PSMA_0198cdca94fbb95f");
const PORTS = { http: 18670, scp: 18671, vite: 18673 };
const { check, summary } = createChecker();
const pending: string[] = []; // 未達（前提が満たされず確かめられなかったもの）

interface Decision { engine: string; reason: string | null; parity: { pixels: number; valid: number; violations: number; ambiguous: number; maxRatio: number } | null; cpuMs: number | null; gpuMs: number | null; canary: { ok: boolean; violations: number; maxRatio: number; cases: number } | null }
interface Stats { engine: string; reason: string | null; decision: Decision | null; samples: number[] }

const q = (a: number[], p: number) => { const s = a.slice().sort((x, y) => x - y); const i = (s.length - 1) * p; const lo = Math.floor(i), hi = Math.ceil(i); return s[lo] + (s[hi] - s[lo]) * (i - lo); };
const stats = (p: Page) => p.evaluate("window.__graphyDebug.getFusionResampleStats()") as Promise<Stats>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function launch(extraEnv: Record<string, string> = {}, extraArgs: string[] = []): Promise<DesktopDriver> {
  const d = new DesktopDriver(PORTS, { extraEnv, extraElectronArgs: extraArgs });
  await d.start();
  await dismissStartupDialogs(d.page);
  return d;
}

/** CT を開いて 2D ビューアへ、PET をドロップして Fusion、手動微調整（回転 15°・平行移動 5 mm）まで。 */
async function openFusion(d: DesktopDriver, beforeDrop?: (v: Page) => Promise<void>): Promise<{ v: Page; box: { x: number; y: number; width: number; height: number } }> {
  await resetDb(d.ports.http);
  await importPaths(d.ports.http, [DATA]);
  // Electron のメイン窓は reload するとページが閉じられるので、検索の再実行で一覧を更新する
  await d.page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 30_000 });
  await dismissStartupDialogs(d.page);
  await d.page.getByTestId("search-allperiod-chip").click();
  await d.page.getByTestId("search-submit-button").click();
  await d.page.locator('[data-testid^="study-row-"]').first().click();
  await d.page.locator('[data-testid^="series-row-"]').filter({ hasText: /CT/ }).first().click();
  await d.page.waitForTimeout(2500);
  const v = await d.waitForNewPage(() => d.page.getByTestId("viewer2d-toolbar-button").click(), () => true, 30_000);
  await v.setViewportSize({ width: 1400, height: 900 });
  await v.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 30_000 });
  await v.waitForTimeout(3000);
  // 2D ビューア窓には更新ダイアログが出ない（出るのはメイン窓）。ここで dismissStartupDialogs を呼ぶと、窓の「閉じる」を押して窓が閉じる
  if (beforeDrop) await beforeDrop(v);
  const tile = v.getByTestId("series-viewer-root").first();
  const box = (await tile.boundingBox())!;
  await v.locator('[draggable="true"]').filter({ hasText: /\bPT\b.*PET \(462\)/ }).first().dragTo(tile, { targetPosition: { x: box.width / 2, y: box.height / 2 } });
  await v.waitForTimeout(4000);
  if ((await v.getByTestId("fusion-blend").count()) === 0) { await v.getByTestId("series-controls-toggle").first().click(); await v.waitForTimeout(1500); }
  await v.getByTestId("fusion-adjust-toggle").click();
  await v.getByTestId("fusion-adjust-rz").fill("15");
  await v.getByTestId("fusion-adjust-tx").fill("5");
  await v.waitForTimeout(1500);
  return { v, box };
}

async function scroll(v: Page, box: { x: number; y: number; width: number; height: number }, steps: number, dir: 1 | -1, waitMs = 160): Promise<void> {
  await v.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < steps; i++) { await v.mouse.wheel(0, 100 * dir); await v.waitForTimeout(waitMs); }
}

/** 判定（decision）が出るまで待つ（前景の全スライスを読む時間を含む）。 */
async function waitDecision(v: Page, box: { x: number; y: number; width: number; height: number }, ms = 150_000): Promise<Decision | null> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const s = await stats(v);
    if (s.decision) return s.decision;
    await scroll(v, box, 1, 1, 300); // 描き直しを促す（判定は裏で進む）
  }
  return null;
}

/** 重ねた前景の canvas（背景の画素格子 512×512）の RGBA を base64 で。 */
async function overlayRgba(v: Page): Promise<string | null> {
  return v.evaluate(`(() => {
    const c = Array.from(document.querySelectorAll("canvas")).find((x) => x.width === 512 && x.height === 512);
    if (!c) return null;
    const d = c.getContext("2d").getImageData(0, 0, 512, 512).data;
    let s = ""; const CH = 32768;
    for (let i = 0; i < d.length; i += CH) s += String.fromCharCode.apply(null, d.subarray(i, i + CH));
    return btoa(s);
  })()`) as Promise<string | null>;
}
const diffPixels = (a: string, b: string) => {
  const x = Buffer.from(a, "base64"), y = Buffer.from(b, "base64");
  let n = 0, mx = 0;
  for (let i = 0; i < x.length; i += 4) {
    const dd = Math.max(Math.abs(x[i] - y[i]), Math.abs(x[i + 1] - y[i + 1]), Math.abs(x[i + 2] - y[i + 2]), Math.abs(x[i + 3] - y[i + 3]));
    if (dd > 0) n++;
    if (dd > mx) mx = dd;
  }
  return { differing: n, maxDiff: mx, total: x.length / 4 };
};
const nonEmpty = (b64: string | null) => !!b64 && Buffer.from(b64, "base64").some((x, i) => i % 4 === 3 && x > 0);

async function fgValue(v: Page, box: { x: number; y: number; width: number; height: number }): Promise<string | null> {
  await v.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.35);
  await v.waitForTimeout(600);
  const txt = (await v.evaluate("document.body.innerText")) as string;
  const m = txt.match(/(?:前景|FG)\s*(-?\d+(?:\.\d+)?)/);
  return m ? m[1] : null;
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT, { recursive: true });
  if (!fs.existsSync(DATA)) { console.log(`  [未達] 実データが無い: ${DATA}`); process.exitCode = 2; return; }

  if (BASELINE) {
    // 導入前のコード: 表示の基準だけ（固定のスライス・固定の微調整）
    const d = await launch();
    try {
      const { v, box } = await openFusion(d);
      await scroll(v, box, 60, 1);
      await v.waitForTimeout(1500);
      const rgba = await overlayRgba(v);
      check(nonEmpty(rgba), "基準: Fusion の canvas に画素がある");
      fs.writeFileSync(path.join(OUT, "baseline-rgba.b64"), rgba ?? "");
      await v.screenshot({ path: path.join(OUT, "baseline.png") });
    } finally { await d.stop(); }
    return;
  }
  const baseline = fs.existsSync(path.join(OUT, "baseline-rgba.b64")) ? fs.readFileSync(path.join(OUT, "baseline-rgba.b64"), "utf8") : null;
  const result: Record<string, unknown> = {};

  // ── R1 通常起動 ──
  console.log("\n[R1] 通常起動（開発機の GPU）: 判定を待つ");
  let d = await launch();
  try {
    const { v, box } = await openFusion(d);
    const dec = await waitDecision(v, box);
    result.decision = dec;
    console.log(`  判定: ${JSON.stringify(dec)}`);
    check(dec !== null, "判定が出た（前景の全スライスを読んだ）");
    await v.screenshot({ path: path.join(OUT, "R1-fusion.png") });
    const gpu = dec?.engine === "gpu-webgl2";
    if (dec && dec.canary) check(dec.canary.cases > 0, "カナリアが実行された", dec.canary);
    if (!gpu) {
      console.log(`  GPU は選ばれなかった: 理由 ${dec?.reason}（CPU ${dec?.cpuMs?.toFixed?.(2)} ms / GPU ${dec?.gpuMs?.toFixed?.(2)} ms、一致検査 ${JSON.stringify(dec?.parity)}）`);
      pending.push(`C4 全スライスの一致検査（GPU が選ばれなかった: ${dec?.reason}）`, "C7 GPU で描いているときの状態バー", "C8 全スライス送りの速さ比較");
      check((await stats(v)).engine === "cpu", "CPU で描いている（表示は導入前と同じ経路）");
      check(nonEmpty(await overlayRgba(v)), "表示が空でない（CPU の結果が出ている）");
      if (dec?.reason === "slower") {
        check(dec.parity !== null && dec.parity.violations === 0, "「速くならない」でも、GPU と CPU の結果は一致していた（違反 0）", dec.parity);
        console.log("  → 実装案 §6 の止める条件: 速くならないと記録し、第 3 段（DVF）に進まず報告する");
      }
    } else {
      check((await stats(v)).engine === "gpu-webgl2", "engine が gpu-webgl2");
      check(dec!.parity !== null && dec!.parity.violations === 0, "実データの最初のスライスの一致検査: 違反 0", dec!.parity);
      check(dec!.gpuMs! < dec!.cpuMs!, "GPU は CPU より速い（選ばれた条件）", { cpuMs: dec!.cpuMs, gpuMs: dec!.gpuMs });

      console.log("\n[C4] 全背景スライスを送りながら、各スライスで GPU と CPU を両方計算して一致検査");
      let violations = 0, ambiguous = 0, maxRatio = 0, slices = 0, noFinite = 0;
      const gpuMs: number[] = [], cpuMs: number[] = [];
      for (let i = 0; i < 100; i++) {
        await scroll(v, box, 1, 1, 220);
        const p = (await v.evaluate("window.__graphyDebug.probeFusionParity()")) as { violations: number; ambiguous: number; maxRatio: number; gpuMs: number; cpuMs: number; finiteGpu: number } | null;
        if (!p) continue;
        slices++; violations += p.violations; ambiguous += p.ambiguous; maxRatio = Math.max(maxRatio, p.maxRatio);
        if (p.finiteGpu === 0) noFinite++;
        gpuMs.push(p.gpuMs); cpuMs.push(p.cpuMs);
      }
      console.log(`  検査したスライス ${slices} 枚、違反 ${violations}、境界の曖昧 ${ambiguous}、|差|/E の最大 ${maxRatio.toExponential(2)}`);
      check(slices >= 60, "対象が実在する（検査できたスライス ≥ 60）", slices);
      check(slices - noFinite >= 30, "GPU の値に有限値を含むスライスが十分ある（空の配列で「違反 0」にしていない）", { slices, noFinite });
      check(violations === 0, "全スライスで違反 0", violations);
      result.c4 = { slices, violations, ambiguous, maxRatio };

      console.log("\n[C7] 状態バーの前景値: GPU で描いているときと CPU 固定のときで同じ（内部の値）");
      const vGpu = await fgValue(v, box);
      await v.evaluate("window.__graphyDebug.setFusionResampleMode('cpu')");
      await scroll(v, box, 1, 1, 400); await scroll(v, box, 1, -1, 600); // 描き直す（同じスライスに戻す）
      const vCpu = await fgValue(v, box);
      console.log(`  GPU: ${vGpu} / CPU: ${vCpu}`);
      check(vGpu !== null && vGpu === vCpu, "状態バーの前景値が一致（表示文字列。内部の値は CPU の 1 画素の再計算）", { vGpu, vCpu });
      await v.evaluate("window.__graphyDebug.setFusionResampleMode('auto')");
      await scroll(v, box, 1, 1, 400); await scroll(v, box, 1, -1, 600);

      console.log("\n[C8] 速さ: 全スライス送りの所要時間（GPU 経路 / CPU 固定）");
      const run = async (mode: "auto" | "cpu"): Promise<number[]> => {
        await v.evaluate(`window.__graphyDebug.setFusionResampleMode('${mode}')`);
        await v.evaluate("window.__graphyDebug.resetFusionResampleStats()");
        await scroll(v, box, 100, mode === "auto" ? -1 : 1, 160);
        await v.waitForTimeout(600);
        return (await stats(v)).samples;
      };
      const sg = await run("auto");
      const sc = await run("cpu");
      console.log(`  GPU 経路: 中央値 ${q(sg, 0.5).toFixed(2)} ms（四分位 ${q(sg, 0.25).toFixed(2)}〜${q(sg, 0.75).toFixed(2)}、${sg.length} 件）／ CPU 固定: 中央値 ${q(sc, 0.5).toFixed(2)} ms（${q(sc, 0.25).toFixed(2)}〜${q(sc, 0.75).toFixed(2)}、${sc.length} 件）`);
      result.c8 = { gpu: { median: q(sg, 0.5), q1: q(sg, 0.25), q3: q(sg, 0.75), n: sg.length }, cpu: { median: q(sc, 0.5), q1: q(sc, 0.25), q3: q(sc, 0.75), n: sc.length } };
      const iqr = Math.max(q(sg, 0.75) - q(sg, 0.25), q(sc, 0.75) - q(sc, 0.25));
      const faster = q(sg, 0.5) < q(sc, 0.5) && q(sc, 0.5) - q(sg, 0.5) > iqr;
      console.log(`  判定（記録）: ${faster ? "GPU が速い（差 > 四分位範囲）" : "速くならない（差 ≤ 四分位範囲、または GPU が遅い）"}`);
      result.c8Verdict = faster ? "faster" : "not-faster";
      check(sg.length >= 60 && sc.length >= 60, "両方で時間が取れた", { gpu: sg.length, cpu: sc.length });

      // 表示: GPU 経路の画素と CPU の画素の差（8 bit 化後）。導入前の表示は CPU と同じ
      await v.evaluate("window.__graphyDebug.setFusionResampleMode('auto')");
      await scroll(v, box, 100, 1, 100);
      await v.waitForTimeout(1500);
    }
    result.screenshots = ["R1-fusion.png"];
  } finally { await d.stop(); }

  // ── R2 ソフトウェア描画 ──
  console.log("\n[R2] ソフトウェア描画: engine=cpu・理由 software。表示は CPU 固定・導入前と一致");
  d = await launch({ LIBGL_ALWAYS_SOFTWARE: "1" }, ["--disable-gpu"]);
  try {
    const { v, box } = await openFusion(d);
    const dec = await waitDecision(v, box, 90_000);
    check(dec?.engine === "cpu" && dec.reason === "software", "ソフトウェア描画では engine=cpu・理由 software", dec);
    await scroll(v, box, 60, 1);
    await v.waitForTimeout(1500);
    const swRgba = await overlayRgba(v);
    check(nonEmpty(swRgba), "表示が空でない");
    await v.evaluate("window.__graphyDebug.setFusionResampleMode('cpu')");
    await scroll(v, box, 1, 1, 400); await scroll(v, box, 1, -1, 700);
    const cpuRgba = await overlayRgba(v);
    check(!!swRgba && !!cpuRgba && diffPixels(swRgba, cpuRgba).differing === 0, "ソフトウェア描画の画素 = 設定 cpu の画素（同じ起動・同じスライス）", swRgba && cpuRgba ? diffPixels(swRgba, cpuRgba) : null);
    if (baseline && swRgba) {
      const df = diffPixels(swRgba, baseline);
      check(df.differing === 0, "導入前のコード（--baseline）の画素と一致", df);
    } else pending.push("C6 導入前のコードとの画素比較（--baseline の結果が無い）");
    await v.screenshot({ path: path.join(OUT, "R2-software.png") });
  } finally { await d.stop(); }

  // ── R3〜R5 負例: シェーダに誤りを入れる ──
  for (const fault of ["halfVoxel", "swapUV", "zOffByOne"]) {
    console.log(`\n[R-${fault}] シェーダに誤り（${fault}）→ カナリアで落ちて CPU に戻る。表示は出る`);
    d = await launch();
    try {
      const { v, box } = await openFusion(d, async (vv) => { await vv.evaluate(`window.__graphyDebug.setFusionGpuFault('${fault}')`); });
      const dec = await waitDecision(v, box, 120_000);
      console.log(`  判定: ${JSON.stringify(dec)}`);
      if (dec?.reason === "software" || dec?.reason === "no-webgl2" || dec?.reason === "no-float-rt") {
        pending.push(`負例 ${fault}（この GPU は使えず、カナリアまで進まなかった: ${dec.reason}）`);
        continue;
      }
      check(dec?.engine === "cpu" && dec.reason === "parity-failed", `${fault}: engine=cpu・parity-failed`, dec);
      check(dec?.canary?.ok === false && (dec.canary.violations > 0 || dec.canary.violations === -1), `${fault}: カナリアが不合格（違反あり）`, dec?.canary);
      check(nonEmpty(await overlayRgba(v)), `${fault}: それでも表示は出る（画面が空にならない）`);
      const rgba = await overlayRgba(v);
      if (fault === "halfVoxel") await v.screenshot({ path: path.join(OUT, "R-fault-halfVoxel.png") });
      void rgba;
    } finally { await d.stop(); }
  }

  fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify(result, null, 2));
  for (const p of pending) console.log(`  [未達] ${p}`);
  console.log(`\n  未達 ${pending.length} 件`);
}

main()
  .then(() => process.exit(process.exitCode || (summary() === 0 ? 0 : 1)))
  .catch((e) => { console.error(e); process.exit(2); });
