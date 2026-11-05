/*
 * Fusion のリサンプル（CPU）の実測。実データ（PET/CT 全身、背景 CT 512²）で、背景スライスを送りながら
 * dev ビルドのデバッグ API `__graphyDebug.getFusionResampleStats()` から computeFusionSlice の所要時間を集め、
 * 画面の更新間隔（requestAnimationFrame の間隔の中央値）と比べる。
 *
 * 実行:  cd automator && npx tsx src/spike/fusionResampleTimingCheck.ts
 *        （前景のデータは GRAPHY_GUIDE_DATA、既定 ~/graphy-demo-samples の PSMA_0198cdca94fbb95f）
 *
 * 前提: backend/target/graphy-next-backend.jar が今のビルドであること。
 *
 * 判定（合否ではなく記録）: CPU の中央値が更新間隔より短いか。短ければ GPU 化（次の段）に進む理由が薄い。
 * 合否は「時間が取れたこと」（対象が実在し、操作が効いていること）で数える。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";

import { resetDb } from "../backend/dbReset.js";
import { WebDriver } from "../driver/webDriver.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { createChecker } from "./computeSpikeShared.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "fusion-resample-timing-check");
const DATA = path.join(
  process.env.GRAPHY_GUIDE_DATA ?? path.join(os.homedir(), "graphy-demo-samples"),
  "PSMA_0198cdca94fbb95f",
);
const { check, summary } = createChecker();

interface Stats { engine: string; reason: string; lastMs: number | null; samples: number[]; cols: number; rows: number; fgSlices: number; hasTransform: boolean }

const stats = (p: Page): Promise<Stats> => p.evaluate("window.__graphyDebug.getFusionResampleStats()") as Promise<Stats>;
const resetStats = (p: Page) => p.evaluate("window.__graphyDebug.resetFusionResampleStats()");

function quantile(a: number[], q: number): number {
  const s = a.slice().sort((x, y) => x - y);
  const i = (s.length - 1) * q;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
}

function summarize(a: number[]) {
  return { n: a.length, median: quantile(a, 0.5), q1: quantile(a, 0.25), q3: quantile(a, 0.75), max: Math.max(...a) };
}

/** 画面の更新間隔: 何もしない 2 秒間の requestAnimationFrame の間隔。 */
async function rafIntervals(p: Page): Promise<number[]> {
  return p.evaluate(`new Promise((resolve) => {
    const t = []; let last = performance.now(); const end = last + 2000;
    const loop = (n) => { t.push(n - last); last = n; if (n < end) requestAnimationFrame(loop); else resolve(t.slice(1)); };
    requestAnimationFrame(loop);
  })`) as Promise<number[]>;
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  if (!fs.existsSync(DATA)) {
    console.log(`  [未達] 実データが無い: ${DATA}`);
    process.exitCode = 2;
    return;
  }
  const result: Record<string, unknown> = { data: "PSMA PET/CT（CT 512×512×308 / PET 200×200×462）" };

  const d = new WebDriver({ http: 18640, scp: 18641, vite: 18643 }, { viewport: { width: 1400, height: 900 }, locale: "ja-JP" });
  await d.start();
  try {
    console.log(`  reset: ${JSON.stringify(await resetDb(d.ports.http))}`);
    const imp = await importPaths(d.ports.http, [DATA]);
    console.log(`  import: ${JSON.stringify(imp)}`);
    await d.page.reload();
    await d.page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 30_000 });
    await d.page.getByTestId("search-allperiod-chip").click();
    await d.page.getByTestId("search-submit-button").click();
    await d.page.locator('[data-testid^="study-row-"]').first().click();
    await d.page.locator('[data-testid^="series-row-"]').filter({ hasText: /CT/ }).first().click();
    await d.page.waitForTimeout(2500);
    const v = await d.waitForNewPage(() => d.page.getByTestId("viewer2d-toolbar-button").click(), () => true, 30_000);
    await v.setViewportSize({ width: 1400, height: 900 });
    await v.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 30_000 });
    await v.waitForTimeout(3000);

    console.log("\n[1] CT に PT をドロップして Fusion");
    const tile = v.getByTestId("series-viewer-root").first();
    const box = (await tile.boundingBox())!;
    await v.locator('[draggable="true"]').filter({ hasText: /\bPT\b.*PET \(462\)/ }).first().dragTo(tile, { targetPosition: { x: box.width / 2, y: box.height / 2 } });
    await v.waitForTimeout(4000);
    if ((await v.getByTestId("fusion-blend").count()) === 0) {
      await v.getByTestId("series-controls-toggle").first().click();
      await v.waitForTimeout(1500);
    }
    check((await v.getByTestId("fusion-blend").count()) > 0, "Fusion バーが出た（ドロップが効いた）");
    await v.screenshot({ path: path.join(OUT_DIR, "1-fusion.png") });

    // 対象が実在し操作が効いていること: 背景を送ると computeFusionSlice の記録が増える
    await v.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await resetStats(v);
    for (let i = 0; i < 10; i++) { await v.mouse.wheel(0, 100); await v.waitForTimeout(300); }
    const s0 = await stats(v);
    console.log(`  スライスを 10 枚送ったあとの記録: ${s0.samples.length} 件、${s0.cols}×${s0.rows}、前景 ${s0.fgSlices} 枚`);
    check(s0.engine === "cpu", "engine が cpu（段 1 は CPU だけ）", s0.engine);
    check(s0.samples.length >= 3, "スライス送りで記録が増える（操作が効いている）", s0.samples.length);
    check(s0.cols === 512 && s0.rows === 512, "背景の画素格子が 512×512", [s0.cols, s0.rows]);

    // 計算結果が実在すること: 状態バーの前景値（CPU の補間値）が有限の数値で、複数の点で違う値になる
    const fgValueAt = async (fx: number, fy: number): Promise<number | null> => {
      await v.mouse.move(box.x + box.width * fx, box.y + box.height * fy);
      await v.waitForTimeout(500);
      const txt = (await v.evaluate("document.body.innerText")) as string;
      const m = txt.match(/前景\s*(-?\d+(?:\.\d+)?)/);
      return m ? Number(m[1]) : null;
    };
    const probes = [await fgValueAt(0.5, 0.35), await fgValueAt(0.45, 0.4), await fgValueAt(0.55, 0.3), await fgValueAt(0.5, 0.45)];
    console.log(`  状態バーの前景値（4 点）: ${JSON.stringify(probes)}`);
    result.foregroundProbe = probes;
    check(probes.every((x) => x !== null && Number.isFinite(x)), "前景値が 4 点とも有限の数値（補間結果が実在する）", probes);
    check(new Set(probes).size >= 2, "4 点の前景値が互いに異なる（一様な値ではない）", probes);

    // 画面の更新間隔（何もしていない間）
    console.log("\n[2] 画面の更新間隔");
    const raf = await rafIntervals(v);
    const rafS = summarize(raf);
    result.rafInterval = rafS;
    console.log(`  rAF 間隔: 中央値 ${rafS.median.toFixed(2)} ms（四分位 ${rafS.q1.toFixed(2)}〜${rafS.q3.toFixed(2)}、${rafS.n} 回）`);
    check(rafS.n > 30 && rafS.median > 1, "rAF の間隔が取れた", rafS);

    // 条件ごとに: 背景を 1 枚ずつ送り、記録を集める
    const collect = async (label: string, steps: number, dir: 1 | -1): Promise<number[]> => {
      await resetStats(v);
      await v.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      for (let i = 0; i < steps; i++) { await v.mouse.wheel(0, 100 * dir); await v.waitForTimeout(160); }
      await v.waitForTimeout(600);
      const s = await stats(v);
      const ok = s.samples.filter((x) => Number.isFinite(x));
      console.log(`  ${label}: ${ok.length} 件（送り ${steps} 回）`);
      return ok;
    };

    // 条件を交互に 3 回ずつ（1 回の中央値は他の負荷でぶれる: 手動微調整が 20.7 と 11.05 ms だった）
    console.log("\n[3] 変換なし／手動微調整（回転 15° + 平行移動 5 mm）を交互に 3 回ずつ");
    await v.getByTestId("fusion-adjust-toggle").click();
    await v.waitForTimeout(500);
    const setAdjust = async (on: boolean) => {
      await v.getByTestId("fusion-adjust-rz").fill(on ? "15" : "0");
      await v.getByTestId("fusion-adjust-tx").fill(on ? "5" : "0");
      await v.waitForTimeout(1500);
    };
    const none: number[] = [], rigid: number[] = [];
    const rounds: { none: number[]; rigid: number[] } = { none: [], rigid: [] };
    let dir: 1 | -1 = 1;
    for (let r = 0; r < 3; r++) {
      await setAdjust(false);
      const a = await collect(`変換なし #${r + 1}`, 100, dir); dir = (dir === 1 ? -1 : 1);
      check((await stats(v)).hasTransform === false, `変換なし #${r + 1}: 変換なしとして記録された`);
      await setAdjust(true);
      if (r === 0) await v.screenshot({ path: path.join(OUT_DIR, "3-adjusted.png") });
      const b = await collect(`手動微調整 #${r + 1}`, 100, dir); dir = (dir === 1 ? -1 : 1);
      check((await stats(v)).hasTransform === true, `手動微調整 #${r + 1}: 変換ありとして記録された（操作が効いている）`);
      none.push(...a); rigid.push(...b);
      rounds.none.push(a.length ? summarize(a).median : NaN);
      rounds.rigid.push(b.length ? summarize(b).median : NaN);
    }
    check(none.length >= 150, "変換なしで 150 件以上取れた", none.length);
    check(rigid.length >= 150, "手動微調整で 150 件以上取れた", rigid.length);
    const noneS = none.length ? summarize(none) : null;
    const rigidS = rigid.length ? summarize(rigid) : null;
    result.noTransform = noneS; result.manualRigid = rigidS; result.roundMedians = rounds;
    const fmt = (x: ReturnType<typeof summarize> | null) => x ? `中央値 ${x.median.toFixed(2)} ms（四分位 ${x.q1.toFixed(2)}〜${x.q3.toFixed(2)}、最大 ${x.max.toFixed(2)}、${x.n} 件）` : "未取得";
    console.log(`  変換なし: ${fmt(noneS)}；回ごとの中央値 ${rounds.none.map((x) => x.toFixed(2)).join(" / ")}`);
    console.log(`  手動微調整: ${fmt(rigidS)}；回ごとの中央値 ${rounds.rigid.map((x) => x.toFixed(2)).join(" / ")}`);
    const over = (a: number[]) => a.filter((x) => x > rafS.median).length / Math.max(1, a.length);
    result.fractionOverRaf = { noTransform: over(none), manualRigid: over(rigid) };
    console.log(`  更新間隔 ${rafS.median.toFixed(1)} ms を超えた割合: 変換なし ${(over(none) * 100).toFixed(0)}% / 手動微調整 ${(over(rigid) * 100).toFixed(0)}%`);

    // 判定（記録）
    const verdict = (s: ReturnType<typeof summarize> | null) =>
      s ? (s.median < rafS.median ? "CPU の中央値は更新間隔より短い" : "CPU の中央値は更新間隔より長い") : "未取得";
    result.verdict = { noTransform: verdict(noneS), manualRigid: verdict(rigidS) };
    console.log(`\n  判定（記録）: 変換なし = ${verdict(noneS)} / 手動微調整 = ${verdict(rigidS)}`);
    result.cpuSamplesNoTransform = none;
    result.cpuSamplesManualRigid = rigid;
  } finally {
    fs.writeFileSync(path.join(OUT_DIR, "timing.json"), JSON.stringify(result, null, 2));
    await d.stop();
  }
}

main()
  .then(() => { process.exitCode = process.exitCode || (summary() === 0 ? 0 : 1); })
  .catch((e) => { console.error(e); process.exitCode = 1; });
