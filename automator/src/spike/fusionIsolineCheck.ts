/*
 * Fusion の等値線の実機検証（受入条件 A3〜A6）。合成ファントム（背景 CT 0.8 mm 格子・前景 PT 4 mm 格子の
 * ガウス球）を取り込み、2D ビューアで CT に PT をドロップして Fusion し、等値線の SVG を解析的な真値と突き合わせる。
 *
 * 実行:  cd automator && npx tsx src/spike/fusionIsolineCheck.ts
 *        （ファントムの生成に pydicom のある Python が要る: GRAPHY_TEST_PYTHON、既定は python）
 *        ISOLINE_BASELINE=1 を付けると等値線の UI には触れず、Fusion の canvas の画素ハッシュだけを
 *        .results/fusion-isoline-check/baseline-canvas.json に書く（等値線導入前のビルドで実行する用）。
 *
 * 前提: backend/target/graphy-next-backend.jar があること（WebDriver が起動する）。
 *
 * 真値は解析式: 値 L の等値面は半径 r_L = σ·√(2·ln(A/(L−B))) の球。z = z0 の断面では円の半径が √(r_L² − z0²)。
 * 測る側（marching squares）と同じ計算をしない。許容幅 ε_s は下で導く（マジックナンバーを置かない）。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";

import { resetDb } from "../backend/dbReset.js";
import { WebDriver } from "../driver/webDriver.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { createChecker } from "./computeSpikeShared.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "fusion-isoline-check");
const PHANTOM_DIR = path.join(OUT_DIR, "phantom");
const BASELINE = process.env.ISOLINE_BASELINE === "1";
const { check, summary } = createChecker();

interface Truth {
  A: number; B: number; sigma: number; level: number; r_L: number;
  bg: { spacing: number; origin_xy: number; cols: number; rows: number };
  fg: { spacing: number; slope: number };
}

/** Fusion の canvas の画素ハッシュ（FNV-1a）。文字列で評価する（tsx の __name がブラウザ側で未定義になるため）。 */
/** 前景の canvas は背景スライスの画素格子（cols×rows）の大きさで、表示用の canvas とは大きさで区別する。 */
async function canvasHash(p: Page, cols: number, rows: number): Promise<string> {
  return p.evaluate(`(() => {
    const c = Array.from(document.querySelectorAll("canvas")).find((x) => x.width === ${cols} && x.height === ${rows});
    if (!c) return "no-canvas";
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    let h = 2166136261;
    for (let i = 0; i < d.length; i++) { h ^= d[i]; h = Math.imul(h, 16777619) >>> 0; }
    return c.width + "x" + c.height + ":" + h.toString(16);
  })()`);
}

const isoPaths = (p: Page) => p.locator('[data-testid="fusion-isoline-svg"] path[stroke="#ffffff"]').count();
const isoSvg = (p: Page) => p.locator('[data-testid="fusion-isoline-svg"]').count();
const isoD = async (p: Page) => (await p.locator('[data-testid="fusion-isoline-svg"] path[stroke="#ffffff"]').first().getAttribute("d")) ?? "";

/** path の d（index 座標）を背景の mm へ。背景は標準 axial なので mm = origin + index·間隔。 */
function verticesMm(d: string, t: Truth): [number, number][] {
  const nums = (d.match(/-?\d+(?:\.\d+)?(?:e-?\d+)?/g) ?? []).map(Number);
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) {
    out.push([t.bg.origin_xy + nums[i] * t.bg.spacing, t.bg.origin_xy + nums[i + 1] * t.bg.spacing]);
  }
  return out;
}

async function main(): Promise<void> {
  fs.rmSync(PHANTOM_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const py = process.env.GRAPHY_TEST_PYTHON ?? "python";
  const gen = spawnSync(py, [path.join(AUTOMATOR_ROOT, "scripts", "make-fusion-isoline-phantom.py"), PHANTOM_DIR], { encoding: "utf8" });
  if (gen.status !== 0) throw new Error(`ファントムを作れませんでした: ${gen.stderr}`);
  const truth: Truth = JSON.parse(fs.readFileSync(path.join(PHANTOM_DIR, "truth.json"), "utf8"));
  fs.renameSync(path.join(PHANTOM_DIR, "truth.json"), path.join(OUT_DIR, "truth.json"));

  const d = new WebDriver({ http: 18610, scp: 18611, vite: 18613 }, { viewport: { width: 1400, height: 900 }, locale: "ja-JP" });
  await d.start();
  try {
    console.log(`  reset: ${JSON.stringify(await resetDb(d.ports.http))}`);
    console.log(`  import: ${JSON.stringify(await importPaths(d.ports.http, [PHANTOM_DIR]))}`);
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

    console.log("\n[1] CT に PT をドロップして Fusion（タイルヘッダの中央ドロップが Playwright で動くか）");
    const tile = v.getByTestId("series-viewer-root").first();
    const box = (await tile.boundingBox())!;
    await v.getByText(/PT foreground/).first().dragTo(tile, { targetPosition: { x: box.width / 2, y: box.height / 2 } });
    await v.waitForTimeout(4000);
    const fusionBarOpen = () => v.getByTestId("fusion-blend").count().then((n) => n > 0);
    console.log(`  ドロップ後（開閉ボタンを押す前）の Fusion バー: ${await fusionBarOpen() ? "開" : "閉"}`);
    if (!(await fusionBarOpen())) {
      await v.getByTestId("series-controls-toggle").first().click();
      await v.waitForTimeout(1500);
    }
    check(await fusionBarOpen(), "Fusion バーが出た（ドロップが効いた）");
    await v.screenshot({ path: path.join(OUT_DIR, "0-bar.png") });
    // 中央のスライス（z = 0）へ: いったん端へ寄せてから 4 枚送る（9 枚で左右対称なので向きに依らない）。
    await v.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < 12; i++) { await v.mouse.wheel(0, -100); await v.waitForTimeout(80); }
    for (let i = 0; i < 4; i++) { await v.mouse.wheel(0, 100); await v.waitForTimeout(250); }
    await v.waitForTimeout(1500);
    const hashOff = await canvasHash(v, truth.bg.cols, truth.bg.rows);
    console.log(`  canvas hash（等値線 OFF・中央スライス）: ${hashOff}`);
    await v.screenshot({ path: path.join(OUT_DIR, "1-fusion.png") });
    if (BASELINE) {
      fs.writeFileSync(path.join(OUT_DIR, "baseline-canvas.json"), JSON.stringify({ hashOff }));
      console.log("  ISOLINE_BASELINE: ハッシュを書いて終了");
      return;
    }
    check(hashOff !== "no-canvas", "Fusion の canvas がある");

    console.log("\n[2] 既定は OFF（負例）。ON にして値を入れると線が出る（A3）");
    check((await isoSvg(v)) === 0, "既定（OFF）では等値線の SVG が無い");
    await v.getByTestId("fusion-isoline-toggle").check();
    await v.waitForTimeout(500);
    const valueBox = v.getByTestId("fusion-isoline-value");
    await valueBox.fill(String(truth.level));
    await valueBox.press("Enter");
    await v.waitForTimeout(1500);
    check((await isoPaths(v)) >= 1, "path が 1 本以上出た", await isoPaths(v));
    await v.screenshot({ path: path.join(OUT_DIR, "2-isoline.png") });

    console.log("\n[3] 真値照合（A4）: 中央断面（z = 0）で全頂点の半径が r_L に ε_s 以内");
    const dMid = await isoD(v);
    const verts = verticesMm(dMid, truth);
    const rErr = Math.max(...verts.map(([x, y]) => Math.abs(Math.hypot(x, y) - truth.r_L)));
    // ε_s = 背景の線形補間の誤差 ＋ 前景の trilinear 再サンプル誤差 ＋ 保存値の量子化
    //   線形補間: (h²/8)·max(|f''|,|f'/r|)/|f'| ＋ 2 次項。trilinear: 3·(h_f²/8)·max|∂²f|/|f'|。量子化: (slope/2)/|f'|。
    const { A, B, sigma, level, r_L } = truth;
    const fPrime = ((level - B) * r_L) / (sigma * sigma);
    const hb = truth.bg.spacing;
    const lin = ((hb * hb) / 8) * Math.max(Math.abs((r_L * r_L) / (sigma * sigma) - 1), 1) / r_L;
    const tri = (3 * (truth.fg.spacing ** 2) / 8) * (A / (sigma * sigma)) / fPrime;
    const quant = (truth.fg.slope / 2) / fPrime;
    const epsS = lin + (lin * lin) / (2 * r_L) + tri + quant;
    console.log(`  頂点 ${verts.length} 個、最大の半径誤差 ${rErr.toFixed(4)} mm、ε_s ${epsS.toFixed(4)} mm（線形 ${lin.toFixed(4)} ＋ trilinear ${tri.toFixed(4)} ＋ 量子化 ${quant.toFixed(4)}）`);
    check(verts.length > 20, "頂点が十分ある", verts.length);
    check(rErr <= epsS, "最大の半径誤差が ε_s 以内", { rErr, epsS });
    check(epsS < truth.bg.spacing * 20, "ε_s が自明に緩くない（背景の画素間隔の 20 倍未満）", epsS);
    check(Math.abs(Math.hypot(...verts.reduce(([a, b], [x, y]) => [a + x, b + y], [0, 0] as number[]).map((s) => s / verts.length) as [number, number])) < 0.5, "円の中心が (0,0) mm（平均位置）");

    console.log("\n[4] 値が最大値を超えると線は 0 本、スライスを送ると形が変わる（A5）");
    await valueBox.fill(String(A + B + 500));
    await valueBox.press("Enter");
    await v.waitForTimeout(1200);
    check((await isoPaths(v)) === 0, "最大値より上では path が 0 本", await isoPaths(v));
    await valueBox.fill(String(truth.level));
    await valueBox.press("Enter");
    await v.waitForTimeout(1200);
    check((await isoPaths(v)) >= 1, "値を戻すと線が戻る");
    await v.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await v.mouse.wheel(0, 100);
    await v.waitForTimeout(1500);
    const dNext = await isoD(v);
    check(dNext !== "" && dNext !== dMid, "1 枚送ると path の形が変わる");
    // 隣のスライス（z = ±4 mm）の円の半径は √(r_L² − 4²)
    const vNext = verticesMm(dNext, truth);
    const rNext = vNext.map(([x, y]) => Math.hypot(x, y));
    const expNext = Math.sqrt(r_L * r_L - 16);
    const exps = [Math.sqrt(r_L * r_L - 16)];
    console.log(`  隣の断面: 半径 ${Math.min(...rNext).toFixed(3)}〜${Math.max(...rNext).toFixed(3)}、期待 ${expNext.toFixed(3)}`);
    check(rNext.length > 0 && Math.max(...rNext.map((r) => Math.min(...exps.map((e) => Math.abs(r - e))))) <= epsS * 3,
      "隣の断面の円の半径が √(r_L²−z²) に一致する（許容は ε_s の 3 倍＝勾配が小さい分）");
    await v.screenshot({ path: path.join(OUT_DIR, "4-next-slice.png") });
    check((await canvasHash(v, truth.bg.cols, truth.bg.rows)) !== hashOff, "負例: 別スライスでは canvas のハッシュが変わる（ハッシュに検出力がある）");

    console.log("\n[5] OFF に戻すと線が消え、Fusion の canvas は等値線を入れる前と同一（A6 の一部）");
    await v.mouse.wheel(0, -100);
    await v.waitForTimeout(1500);
    await v.getByTestId("fusion-isoline-toggle").uncheck();
    await v.waitForTimeout(800);
    check((await isoSvg(v)) === 0, "OFF で SVG が消える");
    const hashAfter = await canvasHash(v, truth.bg.cols, truth.bg.rows);
    check(hashAfter === hashOff, "OFF の canvas 画素が ON/OFF の前後で同一", { hashOff, hashAfter });
    const baselineFile = path.join(OUT_DIR, "baseline-canvas.json");
    if (fs.existsSync(baselineFile)) {
      const base = JSON.parse(fs.readFileSync(baselineFile, "utf8")).hashOff;
      check(base === hashOff, "等値線導入前のビルドの canvas 画素と同一", { base, hashOff });
    } else {
      console.log("  [未達] 導入前のビルドの baseline-canvas.json が無い（ISOLINE_BASELINE=1 で旧ビルドを先に実行する）");
    }

    console.log("\n[6] 前景を解除すると等値線の UI も消える");
    await v.getByTestId("fusion-isoline-toggle").check();
    await v.waitForTimeout(500);
    await v.locator('button[title="Fusion 解除"]').click();
    await v.waitForTimeout(1500);
    check((await v.getByTestId("fusion-isoline-toggle").count()) === 0, "解除で等値線の UI が消える");
    check((await isoSvg(v)) === 0, "解除で等値線の SVG が消える");
  } finally {
    await d.stop();
  }
}

main()
  .then(() => process.exit(summary() === 0 ? 0 : 1))
  .catch((e) => {
    console.error(e);
    process.exit(2);
  });
