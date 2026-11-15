/*
 * マスク（塗り ROI）の位置・体積・画素数・重心の幾何検証（実アプリ。geomRoiCheck.ts の続き）。
 *
 * 実行:  cd automator && GEOM_IDS=g1_aniso npx tsx src/spike/geomMaskCheck.ts
 *   GEOM_IDS     検査する幾何（カンマ区切り。既定 g1_aniso）。make-geom-verify-phantom.py の ID。
 *   GEOM_ONLY    検査の絞り込み（A,B,C,D のカンマ区切り。既定 全部）。
 *   GEOM_NEG     負例。"1" = 真値の行/列間隔を入れ替える。"uniform" = スライス間隔を一様と仮定した体積を期待値にする。
 *                どちらも「落ちること」が合格（検査器が効いていること）。
 *   GRAPHY_AUTOMATOR_{HTTP,SCP,VITE}_PORT  専用ポート。
 *
 * 真値はすべて合成ファントム（truth.json）の解析形状（球 S: 中心・半径）と、各スライスの IPP/IOP から出す。
 * アプリの統計・座標変換・ラスタ化の式は使わない。画面上の位置は「画像の外形 ÷ 物理 FOV」の縮尺で決める。
 * 値は画面（ROI 脇の文字・ROI マネージャの Σ³ の行）か debugApi（labelmap の画素）から読む。
 *
 * 検査内容:
 *   A. ROI → マスク（円・楕円・矩形。ROI マネージャの ▦ = roiToMask）
 *      A1 画素集合: 画素中心が ROI（ハンドルから読んだ形）の内側にある画素 = マスク（境界 ±δ は判定しない）
 *      A2 面積: 画素数 × 画素面積 = ROI の解析面積（π r², π a b, 幅×高さ）。許容 = 周長 × 最大画素辺 / 2 + 画素面積
 *         （矩形は 中心サンプリングの各軸 ±1 画素 → 幅×dy + 高さ×dx + dx·dy）
 *      A3 面積: 画素数 × 画素面積 = 同じ ROI の統計（ROI 脇の「面積」）。許容は A2 と同じ
 *      A4 ROI マネージャ（Σ³）の画素数 = labelmap の画素数
 *   B. Wand のシード: 球の断面の縁の画素 P（内側）の右半分／下半分を押す → シードが P か（P がマスクに入るか）
 *      既定のまま（許容差の既定）と、許容差 1 の両方。対照（P の左半分、外側の隣 Q の中央）で検出器を確かめる。
 *      B2: 3D Wand で球の中心を押したマスクを、下の analyseMask で測る。
 *   C. 3D 球 ROI（seedSphere3D → 「塗りにする」= rasterizeSphereToMask）
 *   D. しきい値（全スライス）でできたマスク
 *      C・D・B2 のマスクに共通の判定（analyseMask）:
 *        - 画素数: スライスごとに、解析の球に中心が入る画素数（中心が R±ε の帯は判定しない）の範囲に入る
 *        - 体積: Σ N_k × 画素面積 × w_k（w_k = スライスの幅。docs の規則: 前後の間隔の半分ずつ、端は最小間隔の半分）
 *          を (4/3)π R³ と比べる。許容 = 表面積 × 最大ボクセル辺 / 2（離散化の上限）
 *        - 体積: ROI マネージャの Σ³ の mm³ 表示 = 上の Σ N_k A w_k（表示の丸め ±0.5 mm³ だけ許す）
 *        - 重心（LPS）: マスクの画素中心の重み付き平均 = 球の中心。許容 = 最大ボクセル辺 / 2
 *
 * 結果は 合格 / 失敗 / 未達 に分ける。未達（前提が作れない・UI が見つからない）を合格にしない。
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { Page } from "@playwright/test";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { openFirstSeriesInViewer } from "../checklist/items/shared/helpers.js";
import { dragOnCanvasHost } from "../common/pointerDrag.js";
import { createStepRecorder } from "../checklist/types.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "geom-mask-check");
const HOST = "viewer2d-canvas-host";
const NEG = process.env.GEOM_NEG ?? "";
const IDS = (process.env.GEOM_IDS ?? "g1_aniso").split(",").map((s) => s.trim()).filter(Boolean);
const ONLY = new Set((process.env.GEOM_ONLY ?? "A,B,C,D").split(",").map((s) => s.trim().toUpperCase()));

// ── 結果の集計 ──
interface Tally { pass: number; fail: string[]; unmet: string[] }
const tallies = new Map<string, Tally>();
let curGeom = "";
const tally = (): Tally => {
  let t = tallies.get(curGeom);
  if (!t) { t = { pass: 0, fail: [], unmet: [] }; tallies.set(curGeom, t); }
  return t;
};
function check(cond: boolean, label: string, detail?: unknown): void {
  if (cond) {
    tally().pass++;
    console.log(`  [ok  ] ${label}`);
  } else {
    console.log(`  [FAIL] ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
    tally().fail.push(`${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}
function unmet(label: string, reason: string): void {
  console.log(`  [未達] ${label} — ${reason}`);
  tally().unmet.push(`${label} — ${reason}`);
}
const f3 = (v: number) => Math.round(v * 1000) / 1000;
/** 期待値と実測値を並べ、許容内か判定する。 */
function cmp(label: string, expected: number, measured: number, tol: number, unit = ""): void {
  const diff = measured - expected;
  console.log(`    ${label}: 期待 ${f3(expected)}${unit} / 実測 ${f3(measured)}${unit} / 比 ${f3(measured / expected)} / 差 ${f3(diff)} / 許容 ±${f3(tol)}`);
  check(Math.abs(diff) <= tol, label, { expected: f3(expected), measured: f3(measured), ratio: f3(measured / expected), tol: f3(tol) });
}

// ── truth.json ──
interface SeriesTruth {
  id: string; rows: number; cols: number; pixelSpacing: [number, number];
  iop: number[]; normal: number[]; ipps: number[][]; sops: string[]; dir: string;
  rescale: { slope: number; intercept: number };
}
interface Truth {
  field: { A: number; B: number; C: number; D: number };
  sphere: { center: number[]; radiusMm: number; addedValue: number; volumeMm3: number };
  series: SeriesTruth[];
}
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

function makePhantom(): { dir: string; truth: Truth } {
  const dir = path.join(OUT_DIR, "phantom");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const seed = String(Date.now() % 1_000_000_000); // UID は実行ごとに変える
  const r = spawnSync(
    "python3",
    ["-I", path.join(AUTOMATOR_ROOT, "scripts", "make-geom-verify-phantom.py"), dir, "--uid-seed", seed],
    { encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(`ファントム生成に失敗: ${r.stderr}`);
  return { dir, truth: JSON.parse(fs.readFileSync(path.join(dir, "truth.json"), "utf8")) as Truth };
}

// ── 画面・debugApi から読む ──
const dbg = <T>(p: Page, fn: string, ...args: unknown[]): Promise<T> =>
  p.evaluate(`window.__graphyDebug.${fn}(...${JSON.stringify(args)})`) as Promise<T>;

async function readTextBoxLines(page: Page): Promise<string[]> {
  return page.evaluate(`
    (function () {
      var host = document.querySelector('[data-testid="${HOST}"]');
      if (!host) return [];
      var out = [];
      host.querySelectorAll("svg text").forEach(function (t) {
        var s = (t.textContent || "").trim();
        if (s) out.push(s);
      });
      return out;
    })()
  `) as Promise<string[]>;
}
function numberAfter(lines: string[], re: RegExp): number | null {
  const r = new RegExp("(?:" + re.source + ")\\s*[:：]?\\s*(-?\\d+(?:\\.\\d+)?)");
  for (const l of lines) {
    const m = l.match(r);
    if (m) return Number(m[1]);
  }
  return null;
}
async function lastHandles(page: Page): Promise<{ tool: string; points: number[][] } | null> {
  const all = (await dbg<Array<{ tool: string; points: number[][] }>>(page, "getAnnotationCanvasPoints"));
  return all.length ? all[all.length - 1] : null;
}

async function clickMenuItem(page: Page, menu: string, nameRe: RegExp): Promise<void> {
  const re = new RegExp(nameRe.source.replace(/\^/g, "^(?:✓\\s*)?"), nameRe.flags);
  const item = page.getByRole("button", { name: re }).first();
  if (!(await item.isVisible().catch(() => false))) {
    await page.getByTestId(`viewer2d-menu-${menu}`).click();
  }
  try {
    await item.click({ timeout: 8000 });
  } catch (e) {
    await page.screenshot({ path: path.join(OUT_DIR, "menu-fail.png") });
    throw e;
  }
}
async function pickTool(page: Page, labelRe: RegExp, menu: string): Promise<void> {
  await clickMenuItem(page, menu, labelRe);
  await page.waitForTimeout(250);
}
async function clearRois(page: Page): Promise<void> {
  await clickMenuItem(page, "roi", /^(ROI を全消去|Clear ROIs)$/);
  await page.waitForTimeout(600);
  await clickMenuItem(page, "measure", /^(計測を全消去|Clear measurements)$/);
  await page.waitForTimeout(600);
}

const sopOf = (imageId: string | null): string | null => imageId?.match(/instances\/([0-9.]+)/)?.[1] ?? null;
async function currentSop(page: Page): Promise<string | null> {
  const v = await dbg<Array<{ imageId: string | null }>>(page, "getViewportGeometry");
  return sopOf(v.find((x) => x.imageId)?.imageId ?? null);
}
async function viewportId(page: Page): Promise<string> {
  const v = await dbg<Array<{ viewportId: string; imageId: string | null }>>(page, "getViewportGeometry");
  return v.find((x) => x.imageId)!.viewportId;
}
async function setSlice(page: Page, k: number): Promise<void> {
  await page.getByTestId("dim-slider-z").fill(String(k));
  await page.waitForTimeout(250);
}

interface CanvasGeo { w: number; h: number; img: number[] }
async function canvasGeometry(page: Page): Promise<CanvasGeo | null> {
  const vpid = await viewportId(page);
  const g = (await page.evaluate(`
    (function () {
      var host = document.querySelector('[data-testid="${HOST}"]');
      var canvas = host && host.querySelector("canvas");
      var r = canvas.getBoundingClientRect();
      var img = window.__graphyDebug.getImageCanvasRect(${JSON.stringify(vpid)});
      return { w: r.width, h: r.height, img: img };
    })()
  `)) as { w: number; h: number; img: number[] | null };
  return g.img ? { w: g.w, h: g.h, img: g.img } : null;
}

/** canvas 上の 1 点を押す（pointerdown → pointerup。ドラッグしない）。 */
async function clickCanvas(page: Page, cg: CanvasGeo, x: number, y: number): Promise<void> {
  await dragOnCanvasHost(page, HOST, 0, 0, 0, 1, { fracX: x / cg.w, fracY: y / cg.h });
}

// ── ROI マネージャ ──
async function openRoiManager(page: Page): Promise<boolean> {
  if (await page.getByTestId("roi-mgr-save").isVisible().catch(() => false)) return true;
  await clickMenuItem(page, "roiTools", /ROI マネージャ|ROI manager/i);
  try {
    await page.getByTestId("roi-mgr-save").waitFor({ state: "visible", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}
const paintedRows = (page: Page) => page.locator('[data-testid="roi-row"][data-kind="painted"]');
async function deleteAllPainted(page: Page): Promise<void> {
  for (let n = 0; n < 20; n++) {
    const rows = paintedRows(page);
    if ((await rows.count()) === 0) return;
    await rows.first().getByTestId("roi-row-delete").click();
    await page.waitForTimeout(500);
  }
}
async function cleanAll(page: Page): Promise<void> {
  await clearRois(page);
  await deleteAllPainted(page);
}

interface Mask {
  counts: Record<number, number>; // 画素数（labelmap の添字 = スタック順）
  pixels: Record<number, number[]>; // 画素の添字（j*cols+i）
  total: number;
}
async function readMask(page: Page, value = 1): Promise<Mask> {
  const c = await dbg<{ slices: Array<{ index: number; counts: Record<string, number> }>; total: Record<string, number> } | null>(page, "getSegCounts");
  const out: Mask = { counts: {}, pixels: {}, total: 0 };
  if (!c) return out;
  for (const s of c.slices) {
    const n = s.counts[String(value)] ?? 0;
    if (n > 0) {
      out.counts[s.index] = n;
      out.pixels[s.index] = (await dbg<number[]>(page, "getSegSlicePixels", s.index, value)) ?? [];
    }
  }
  out.total = Object.values(out.counts).reduce((a, b) => a + b, 0);
  return out;
}
/** 最後の塗り行を編集対象にしてから、その Σ³（体積統計）を ROI マネージャから読む。 */
async function readSigma3(page: Page): Promise<{ voxels: number; mm3: number | null; text: string } | null> {
  const rows = paintedRows(page);
  const n = await rows.count();
  if (n === 0) return null;
  const row = rows.nth(n - 1);
  await row.locator('input[type="radio"]').first().click().catch(() => {});
  await page.waitForTimeout(300);
  const stats = row.getByTestId("mask-stats");
  if (!(await stats.isVisible().catch(() => false))) {
    await row.getByTestId("mask-stats-run").click();
  }
  try {
    await stats.waitFor({ state: "visible", timeout: 30_000 });
  } catch {
    return null;
  }
  const text = ((await stats.textContent()) ?? "").replace(/\s+/g, " ");
  const vox = /(?:Voxels|ボクセル[^\d:：]*)\s*[:：]\s*([\d,]+)/.exec(text);
  const mm3 = /\(([\d,]+)\s*mm³\)/.exec(text);
  return { voxels: vox ? Number(vox[1].replace(/,/g, "")) : NaN, mm3: mm3 ? Number(mm3[1].replace(/,/g, "")) : null, text };
}

// ── メイン ──
async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const { dir, truth } = makePhantom();
  const d = new DesktopDriver();
  await d.start();
  try {
    d.page.on("console", (m) => {
      if (m.type() === "error") console.log(`  [renderer error] ${m.text().slice(0, 200)}`);
    });
    for (const id of IDS) {
      const s = truth.series.find((x) => x.id === id);
      curGeom = id;
      if (!s) { unmet(`${id}`, "truth に無い"); continue; }
      console.log(`\n=== ${id}${NEG ? `（負例 GEOM_NEG=${NEG}）` : ""} ===`);
      try {
        await runOne(d, dir, truth, s);
      } catch (e) {
        unmet(`${id}: 例外で中断`, String(e).slice(0, 300));
        console.log(e);
      }
    }
  } finally {
    await d.stop().catch(() => {});
  }
  let nf = 0;
  console.log("\n==== 集計（幾何: 合格 / 失敗 / 未達）====");
  for (const [g, t] of tallies) {
    console.log(`${g}: 合格 ${t.pass} / 失敗 ${t.fail.length} / 未達 ${t.unmet.length}`);
    nf += t.fail.length;
    for (const f of t.fail) console.log(`  [失敗] ${f}`);
    for (const u of t.unmet) console.log(`  [未達] ${u}`);
  }
  // 負例では「落ちること」が合格。
  process.exitCode = NEG ? (nf > 0 ? 0 : 1) : nf ? 1 : 0;
}

async function runOne(d: DesktopDriver, dir: string, truth: Truth, s: SeriesTruth): Promise<void> {
  await resetDb(d.ports.http);
  const files = fs.readdirSync(path.join(dir, s.dir)).filter((f) => f.endsWith(".dcm")).sort()
    .map((f) => path.join(dir, s.dir, f));
  const imp = await importPaths(d.ports.http, files);
  check(imp.imported === files.length && imp.failed === 0, `${s.id}: ${files.length} 枚を取り込めた`, imp);

  const main = d.page;
  await main.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
  await openFirstSeriesInViewer(main, createStepRecorder());
  const v = await d.waitForNewPage(
    () => main.getByTestId("viewer2d-toolbar-button").click(),
    (url) => url.includes("2dviewer"),
  );
  await v.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 20_000 });
  await v.waitForTimeout(3000);
  v.on("dialog", (dlg) => void dlg.accept());

  // ── 真値の幾何（truth.json のみ）──
  const [rowMm0, colMm0] = s.pixelSpacing;
  const swap = NEG === "1";
  const [rowMm, colMm] = swap ? [colMm0, rowMm0] : [rowMm0, colMm0]; // 負例: 行/列を入れ替えた真値
  const rc = s.iop.slice(0, 3), rr = s.iop.slice(3);
  const nrm = s.normal;
  const C = truth.sphere.center, R = truth.sphere.radiusMm;
  const Apx = rowMm * colMm; // 画素面積
  // スライスの法線位置と幅（docs/slice-depth-policy.md の規則を、truth の IPP から独立に計算）
  const posOf = s.ipps.map((p) => dot(p, nrm));
  const order = s.ipps.map((_, k) => k).sort((a, b) => posOf[a] - posOf[b]);
  const gaps = order.slice(1).map((k, i) => posOf[k] - posOf[order[i]]);
  const minGap = Math.min(...gaps);
  const widthOf: number[] = new Array(s.ipps.length).fill(0);
  order.forEach((k, i) => {
    const gl = i > 0 ? gaps[i - 1] : minGap;
    const gr = i < gaps.length ? gaps[i] : minGap;
    widthOf[k] = (gl + gr) / 2;
  });
  if (NEG === "uniform") {
    // 負例: 間隔は一様（先頭〜末尾の平均）と仮定し、法線ではなく進む向きの長さを使う（チルト・不等間隔・欠損で外れる）
    const first = s.ipps[order[0]], last = s.ipps[order[order.length - 1]];
    const mean = Math.hypot(...(sub(last, first) as [number, number, number])) / (order.length - 1);
    widthOf.fill(mean);
  }
  const maxGap = Math.max(...gaps);
  const hMax = Math.max(rowMm, colMm, maxGap); // 最大ボクセル辺
  const sphereVol = (4 / 3) * Math.PI * R ** 3;
  const volBound = (4 * Math.PI * R * R) * hMax / 2;
  console.log(`  真値: 球 R=${R} mm（解析体積 ${f3(sphereVol)} mm³）画素 ${rowMm}×${colMm} mm 間隔 ${f3(minGap)}〜${f3(maxGap)} mm 体積の離散化の上限 ±${f3(volBound)} mm³`);

  // 球の中心に最も近いスライス
  let best = 0, bestD = Infinity;
  s.ipps.forEach((ipp, k) => {
    const dd = Math.abs(dot(sub(C, ipp), nrm));
    if (dd < bestD) { bestD = dd; best = k; }
  });
  const dN = dot(sub(C, s.ipps[best]), nrm);
  const rp = Math.sqrt(R * R - dN * dN); // その断面の半径 [mm]
  const rel = sub(sub(C, nrm.map((x) => x * dN)), s.ipps[best]);
  const colIdx = dot(rel, rc) / colMm0; // 画素 index（実間隔。画素中心 = 整数）
  const rowIdx = dot(rel, rr) / rowMm0;

  // ── 解析の球に中心が入る画素数（スライスごと。truth の SOP をキーに）──
  const eps = 1e-3; // mm。中心が球面から ±eps の画素は判定しない（浮動小数の境界）
  const centerOf = (k: number, i: number, j: number) => [0, 1, 2].map((a) => s.ipps[k][a] + i * colMm * rc[a] + j * rowMm * rr[a]);
  const analytic = new Map<string, { lo: number; hi: number }>();
  for (let k = 0; k < s.ipps.length; k++) {
    let lo = 0, hi = 0;
    for (let j = 0; j < s.rows; j++) for (let i = 0; i < s.cols; i++) {
      const p = centerOf(k, i, j);
      const dd = Math.hypot(p[0] - C[0], p[1] - C[1], p[2] - C[2]);
      if (dd <= R - eps) lo++;
      if (dd <= R + eps) hi++;
    }
    analytic.set(s.sops[k], { lo, hi });
  }
  const totalLo = [...analytic.values()].reduce((a, b) => a + b.lo, 0);
  const totalHi = [...analytic.values()].reduce((a, b) => a + b.hi, 0);
  console.log(`  解析の球に中心が入る画素数（全スライス）: ${totalLo}〜${totalHi}`);

  // ── スタックの並び（スライダー → SOP）と表示 ──
  const slider = v.getByTestId("dim-slider-z");
  const kMin = Number((await slider.getAttribute("min")) ?? "0");
  const kMax = Number((await slider.getAttribute("max")) ?? "0");
  const stackSops: string[] = [];
  for (let k = kMin; k <= kMax; k++) {
    await setSlice(v, k);
    stackSops[k - kMin] = (await currentSop(v)) ?? "";
  }
  check(stackSops.length === s.sops.length && stackSops.every((x) => s.sops.includes(x)), `${s.id}: スライダーが全 ${s.sops.length} 枚を巡る`, { n: stackSops.length });
  const gotoSop = async (sop: string): Promise<boolean> => {
    const k = stackSops.indexOf(sop);
    if (k < 0) return false;
    await setSlice(v, k + kMin);
    await v.waitForTimeout(400);
    return (await currentSop(v)) === sop;
  };
  const okSlice = await gotoSop(s.sops[best]);
  check(okSlice, `${s.id}: 目的のスライス（${best} 番）を表示できた`);
  if (!okSlice) return;

  const mgr = await openRoiManager(v);
  if (!mgr) { unmet(`${s.id}: ROI マネージャ`, "開けなかった（ROI マネージャのメニュー項目が見つからない）"); return; }
  await v.waitForTimeout(500);

  // 画面の縮尺（ROI マネージャを開いた後で測る。パネルで canvas が変わるため）
  let cg = (await canvasGeometry(v))!;
  const geo = () => {
    const [ix0, iy0, ix1, iy1] = cg.img;
    const pxPerMmX = (ix1 - ix0) / (s.cols * colMm), pxPerMmY = (iy1 - iy0) / (s.rows * rowMm);
    return { ix0, iy0, ix1, iy1, pxPerMmX, pxPerMmY, pxPerMm: (pxPerMmX + pxPerMmY) / 2 };
  };
  let g = geo();
  check(Math.abs(g.pxPerMmX / g.pxPerMmY - 1) < 0.01, `${s.id}: 画面の mm あたり px が x と y で等しい（縦横比）`, { x: g.pxPerMmX, y: g.pxPerMmY });
  // 画素 (i, j)（小数可。画素の左上端 = 整数）の canvas 位置
  const pxCanvas = (i: number, j: number): [number, number] => [g.ix0 + i * (g.ix1 - g.ix0) / s.cols, g.iy0 + j * (g.iy1 - g.iy0) / s.rows];
  const pixelCenter = (i: number, j: number) => pxCanvas(i + 0.5, j + 0.5);
  const cx = g.ix0 + (colIdx + 0.5) * colMm * g.pxPerMmX;
  const cy = g.iy0 + (rowIdx + 0.5) * rowMm * g.pxPerMmY;
  await v.screenshot({ path: path.join(OUT_DIR, `${s.id}-00-slice.png`) });

  // ── マスクの解析（C・D・B2 共通）──
  async function analyseMask(tag: string): Promise<void> {
    const m = await readMask(v);
    check(m.total > 0, `${tag}: マスクに画素がある（前提）`, { total: m.total });
    if (m.total === 0) return;
    // 画素数: スライスごと
    let outOfRange = 0;
    const bad: unknown[] = [];
    const nk: Record<string, number> = {};
    for (const [kk, n] of Object.entries(m.counts)) nk[stackSops[Number(kk)]] = n;
    for (const [sop, a] of analytic) {
      const n = nk[sop] ?? 0;
      if (n < a.lo || n > a.hi) { outOfRange++; if (bad.length < 4) bad.push({ sop: sop.slice(-6), n, lo: a.lo, hi: a.hi }); }
    }
    for (const sop of Object.keys(nk)) if (!analytic.has(sop)) outOfRange++;
    check(outOfRange === 0, `${tag}: スライスごとの画素数が、解析の球に中心が入る画素数の範囲内（外れ ${outOfRange} 枚）`, { total: m.total, expected: [totalLo, totalHi], bad });
    // 体積と重心
    let vref = 0;
    let wsum = 0, sx = 0, sy = 0, sz = 0;
    for (const [kk, px] of Object.entries(m.pixels)) {
      const sop = stackSops[Number(kk)];
      const t = s.sops.indexOf(sop);
      const w = widthOf[t];
      vref += px.length * Apx * w;
      for (const idx of px) {
        const i = idx % s.cols, j = Math.floor(idx / s.cols);
        const p = centerOf(t, i, j);
        sx += p[0] * w; sy += p[1] * w; sz += p[2] * w; wsum += w;
      }
    }
    cmp(`${tag}: 体積 Σ N·A·w（画素数から）vs 解析 (4/3)πR³`, sphereVol, vref, volBound, " mm³");
    const cen = [sx / wsum, sy / wsum, sz / wsum];
    const cerr = Math.hypot(cen[0] - C[0], cen[1] - C[1], cen[2] - C[2]);
    console.log(`    重心 LPS ${cen.map(f3).join(", ")} / 球の中心 ${C.map(f3).join(", ")} / 差 ${f3(cerr)} mm`);
    check(cerr <= hMax / 2, `${tag}: マスクの重心（LPS）= 球の中心（許容 最大ボクセル辺/2 = ${f3(hMax / 2)} mm）`, { cen: cen.map(f3), center: C, errMm: f3(cerr) });
    // ROI マネージャの Σ³
    const sg = await readSigma3(v);
    if (!sg) { unmet(`${tag}: ROI マネージャの Σ³ の体積`, "Σ³ の表示を読めなかった（塗り行が無い／統計が出ない）"); return; }
    console.log(`    Σ³ 表示: ${sg.text}`);
    check(sg.voxels === m.total, `${tag}: Σ³ の画素数 = labelmap の画素数`, { sigma: sg.voxels, labelmap: m.total });
    if (sg.mm3 === null) unmet(`${tag}: Σ³ の体積（mm³）`, "体積が表示されなかった（—）");
    else {
      cmp(`${tag}: ROI マネージャの体積 vs Σ N·A·w（スライス幅の規則）`, vref, sg.mm3, 0.5 + 1e-4 * vref, " mm³");
      cmp(`${tag}: ROI マネージャの体積 vs 解析 (4/3)πR³`, sphereVol, sg.mm3, volBound, " mm³");
    }
  }

  // ── A. ROI → マスク ──
  if (ONLY.has("A")) {
    console.log(`\n--- A. ROI → マスク ---`);
    const rPx = rp * g.pxPerMm;
    const frac = (x: number, y: number) => ({ fracX: x / cg.w, fracY: y / cg.h });
    const draw = async (tool: RegExp, dx: number, dy: number, x0: number, y0: number) => {
      await cleanAll(v);
      await pickTool(v, tool, "roi");
      await dragOnCanvasHost(v, HOST, dx, dy, 0, 10, frac(x0, y0));
      await v.waitForTimeout(1500);
      return { lines: await readTextBoxLines(v), h: await lastHandles(v) };
    };
    /** ▦（ROI → マスク）を押し、マスクを読む。 */
    const toMask = async (tag: string): Promise<Mask | null> => {
      const btn = v.locator('[data-testid="roi-mgr-row"] button[title*="painted ROI you can edit"], [data-testid="roi-mgr-row"] button[title*="塗り足せる"]').first();
      if (!(await btn.isVisible().catch(() => false))) { unmet(`${tag}: ▦（ROI → マスク）`, "ボタンが見つからない"); return null; }
      await btn.click();
      await v.waitForTimeout(1500);
      if ((await paintedRows(v).count()) === 0) { unmet(`${tag}: ▦ の後に塗り行ができない`, "マスク化に失敗（opFailed か）"); return null; }
      await paintedRows(v).last().locator('input[type="radio"]').first().click().catch(() => {});
      await v.waitForTimeout(500);
      return readMask(v);
    };
    // 判定: 画素中心の canvas 位置が、形の内側／外側（境界 ±δ は判定しない）
    const delta = 0.05; // CSS px。浮動小数の境界だけ
    const setCheck = (tag: string, m: Mask, signedDist: (x: number, y: number) => number) => {
      // signedDist(x,y) は境界までの符号付き距離（内側が負、CSS px）
      const painted = new Set<number>();
      for (const px of Object.values(m.pixels)) for (const p of px) painted.add(p);
      let missing = 0, extra = 0, nIn = 0;
      for (let j = 0; j < s.rows; j++) for (let i = 0; i < s.cols; i++) {
        const [x, y] = pixelCenter(i, j);
        const sd = signedDist(x, y);
        const has = painted.has(j * s.cols + i);
        if (sd < -delta) { nIn++; if (!has) missing++; }
        else if (sd > delta && has) extra++;
      }
      check(missing === 0 && extra === 0, `${tag}: 画素中心が形の内側 = マスク（内側なのに未塗り ${missing} / 外側なのに塗り ${extra} / 内側の期待 ${nIn}）`, { missing, extra, nIn, painted: painted.size });
    };
    const areaChecks = async (tag: string, m: Mask, trueArea: number, perimMm: number, statArea: number | null) => {
      const n = m.total;
      const tol = perimMm * Math.max(rowMm, colMm) / 2 + Apx;
      cmp(`${tag}: マスクの画素数 × 画素面積 vs ROI の解析面積`, trueArea, n * Apx, tol, " mm²");
      if (statArea === null) unmet(`${tag}: マスク面積 vs ROI 統計の面積`, "画面から面積が読めなかった");
      else cmp(`${tag}: マスクの画素数 × 画素面積 vs 同じ ROI の統計（画面の面積）`, statArea, n * Apx, tol, " mm²");
      const sg = await readSigma3(v);
      if (sg) check(sg.voxels === n, `${tag}: ROI マネージャ Σ³ の画素数 = labelmap の画素数`, { sigma: sg.voxels, labelmap: n });
      else unmet(`${tag}: Σ³ の画素数`, "読めなかった");
    };

    // 円: 水平・垂直の縁
    for (const [name, ux, uy] of [["縁が水平", 1, 0], ["縁が垂直", 0, 1]] as Array<[string, number, number]>) {
      const tag = `${s.id}: Circle（${name}）`;
      const { lines, h } = await draw(/^円 ROI$|^Circle ROI$/, rPx * ux, rPx * uy, cx, cy);
      if (!h || h.points.length < 2) { unmet(`${tag}: ハンドル`, "取れない"); continue; }
      const [c0, c1] = h.points;
      const rpx = Math.hypot(c1[0] - c0[0], c1[1] - c0[1]);
      const r = rpx / g.pxPerMm;
      const stat = numberAfter(lines, /面積|Area/);
      const m = await toMask(tag);
      await v.screenshot({ path: path.join(OUT_DIR, `${s.id}-A-circle-${ux ? "h" : "v"}.png`) });
      if (!m) continue;
      setCheck(tag, m, (x, y) => Math.hypot(x - c0[0], y - c0[1]) - rpx);
      await areaChecks(tag, m, Math.PI * r * r, 2 * Math.PI * r, stat);
    }
    // 楕円
    {
      const tag = `${s.id}: Ellipse`;
      const { lines, h } = await draw(/楕円 ROI|Ellipse ROI/, 1.0 * rPx, 0.6 * rPx, cx, cy);
      if (!h || h.points.length < 4) unmet(`${tag}: ハンドル`, "取れない");
      else {
        const [bt, tp, lf, rt] = h.points;
        const ex = (lf[0] + rt[0]) / 2, ey = (bt[1] + tp[1]) / 2;
        const ax = Math.abs(rt[0] - lf[0]) / 2, by = Math.abs(bt[1] - tp[1]) / 2;
        const a = ax / g.pxPerMm, b = by / g.pxPerMm;
        const stat = numberAfter(lines, /面積|Area/);
        const m = await toMask(tag);
        await v.screenshot({ path: path.join(OUT_DIR, `${s.id}-A-ellipse.png`) });
        if (m) {
          setCheck(tag, m, (x, y) => (Math.hypot((x - ex) / ax, (y - ey) / by) - 1) * Math.min(ax, by));
          const perim = Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b))); // Ramanujan
          await areaChecks(tag, m, Math.PI * a * b, perim, stat);
        }
      }
    }
    // 矩形: 辺が画素境界に乗らないように置く（始点・終点を画素の 0.3 / 0.7 の位置に）
    {
      const tag = `${s.id}: Rectangle`;
      const i0 = Math.floor(colIdx - 0.6 * rp / colMm0), j0 = Math.floor(rowIdx - 0.4 * rp / rowMm0);
      const [x0, y0] = pxCanvas(i0 + 0.3, j0 + 0.3);
      const nw = Math.round(1.2 * rp / colMm0), nh = Math.round(0.8 * rp / rowMm0);
      const [x1, y1] = pxCanvas(i0 + nw + 0.7, j0 + nh + 0.7);
      const { lines, h } = await draw(/矩形 ROI|Rectangle ROI/, x1 - x0, y1 - y0, x0, y0);
      if (!h || h.points.length < 4) unmet(`${tag}: ハンドル`, "取れない");
      else {
        const xs = h.points.map((p) => p[0]), ys = h.points.map((p) => p[1]);
        const xl = Math.min(...xs), xr = Math.max(...xs), yt = Math.min(...ys), yb = Math.max(...ys);
        const w = (xr - xl) / g.pxPerMm, hh = (yb - yt) / g.pxPerMm;
        // 辺が画素境界に乗っていない（画素内の位置 0.05〜0.95）ことを、画面の縮尺から確かめる（前提）
        const fx = (u: number) => { const q = (u - g.ix0) / ((g.ix1 - g.ix0) / s.cols); return q - Math.floor(q); };
        const fy = (u: number) => { const q = (u - g.iy0) / ((g.iy1 - g.iy0) / s.rows); return q - Math.floor(q); };
        const offB = [fx(xl), fx(xr), fy(yt), fy(yb)].every((f) => f > 0.05 && f < 0.95);
        check(offB, `${tag}: 辺が画素境界に乗っていない（前提）`, [fx(xl), fx(xr), fy(yt), fy(yb)].map(f3));
        const stat = numberAfter(lines, /面積|Area/);
        const m = await toMask(tag);
        await v.screenshot({ path: path.join(OUT_DIR, `${s.id}-A-rect.png`) });
        if (m) {
          setCheck(tag, m, (x, y) => Math.max(xl - x, x - xr, yt - y, y - yb));
          // 矩形の離散化の上限: 中心サンプリングで各軸 ±1 画素 → w·dy + h·dx + dx·dy（周長 × 最大辺 / 2 と同じ桁）
          const tol = w * rowMm + hh * colMm + Apx;
          cmp(`${tag}: マスクの画素数 × 画素面積 vs 矩形の面積（幅×高さ）`, w * hh, m.total * Apx, tol, " mm²");
          if (stat === null) unmet(`${tag}: マスク面積 vs ROI 統計の面積`, "読めなかった");
          else cmp(`${tag}: マスクの画素数 × 画素面積 vs 同じ ROI の統計（画面の面積）`, stat, m.total * Apx, tol, " mm²");
          const sg = await readSigma3(v);
          if (sg) check(sg.voxels === m.total, `${tag}: Σ³ の画素数 = labelmap の画素数`, { sigma: sg.voxels, labelmap: m.total });
        }
      }
    }
    await cleanAll(v);
    await v.waitForTimeout(500);
  }

  // ── B. Wand のシード ──
  let wandSetupOk = false;
  if (ONLY.has("B")) {
    console.log(`\n--- B. Wand のシード ---`);
    await cleanAll(v);
    await gotoSop(s.sops[best]);
    cg = (await canvasGeometry(v))!;
    g = geo();
    // 球の断面の縁の画素 P（中心が球の内側）と、その右隣／下隣 Q（外側）を、解析で探す
    const dist3 = (k: number, i: number, j: number) => {
      const p = centerOf(k, i, j);
      return Math.hypot(p[0] - C[0], p[1] - C[1], p[2] - C[2]);
    };
    // 球の中心の行・列の近くで、縁をまたぐ画素対を探す（中心に近いものを優先。縁が画素の列・行に当たらない位置もあるため）
    const margin = 0.01; // mm。画素中心の球面からの距離。点標本なので値は完全に 2 値（内側 / 外側）
    const jc = Math.round(rowIdx), ic = Math.round(colIdx);
    let iP = -1, j0 = jc;
    for (const dj of [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5]) {
      const jj = jc + dj;
      for (let i = s.cols - 2; i >= 0; i--) if (dist3(best, i, jj) <= R - margin && dist3(best, i + 1, jj) >= R + margin) { iP = i; break; }
      if (iP >= 0) { j0 = jj; break; }
    }
    let jP = -1, i0 = ic;
    for (const di of [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6, -6, 8, -8, 10, -10]) {
      const ii = ic + di;
      for (let j = s.rows - 2; j >= 0; j--) if (dist3(best, ii, j) <= R - margin && dist3(best, ii, j + 1) >= R + margin) { jP = j; break; }
      if (jP >= 0) { i0 = ii; break; }
    }
    if (iP < 0 || jP < 0) {
      unmet(`${s.id}: Wand のシード`, `縁をまたぐ画素対が見つからない（iP=${iP}, jP=${jP}）`);
    } else {
      wandSetupOk = true;
      console.log(`  右縁: P=(${iP},${j0}) 内側 d=${f3(dist3(best, iP, j0))}, 右隣 Q d=${f3(dist3(best, iP + 1, j0))} / 下縁: P=(${i0},${jP}) d=${f3(dist3(best, i0, jP))}, 下隣 d=${f3(dist3(best, i0, jP + 1))}`);
      const pw = (g.ix1 - g.ix0) / s.cols, ph = (g.iy1 - g.iy0) / s.rows;
      console.log(`  画素の画面上の大きさ ${f3(pw)} × ${f3(ph)} CSS px`);
      type Tool = "2D" | "3D";
      const wandRun = async (tool: Tool, label: string, i: number, j: number, fi: number, fj: number, tol: string | null, expectP: boolean, pI: number, pJ: number) => {
        const [x, y] = pxCanvas(i + fi, j + fj);
        await pickTool(v, tool === "2D" ? /^2D Wand/ : /^3D Wand/, "roiTools");
        await clickCanvas(v, cg, x, y);
        try {
          await v.getByTestId("wand-count").waitFor({ timeout: 30_000 });
        } catch {
          unmet(`${s.id}: Wand ${tool} ${label}`, "wand-count が出ない（ダイアログが開かない）");
          return;
        }
        await v.waitForTimeout(1200);
        if (tol !== null) {
          const f = v.getByTestId("wand-threshold");
          await f.fill(tol);
          await f.press("Enter");
          await v.waitForTimeout(1500);
        }
        const used = await v.getByTestId("wand-threshold").inputValue().catch(() => "?");
        const seedTxt = await v.getByTestId("wand-count").innerText().catch(() => "?");
        const m = await readMask(v);
        const sliceK = stackSops.indexOf(s.sops[best]);
        const px = m.pixels[sliceK] ?? [];
        const hasP = px.includes(pJ * s.cols + pI);
        const fracInSlice = (m.counts[sliceK] ?? 0) / (s.cols * s.rows);
        console.log(`    Wand ${tool} ${label}: 許容差 ${used} / 押した画素 (${i},${j}) の位置 (${fi},${fj}) / シード面のマスク ${m.counts[sliceK] ?? 0} 画素（スライスの ${f3(fracInSlice * 100)}%）/ P を含む ${hasP} / 表示 count=${seedTxt}`);
        check(hasP === expectP, `${s.id}: Wand ${tool} ${label}: シードは ${expectP ? "P（内側の画素）" : "外側の画素"}（P ${expectP ? "を含む" : "を含まない"}）`, { hasP, count: m.counts[sliceK] ?? 0, tolerance: used });
        await v.screenshot({ path: path.join(OUT_DIR, `${s.id}-B-${tool}-${label.replace(/[^A-Za-z0-9]+/g, "_")}.png`) });
        // 次の押下のために取り消す（結果を戻す）
        await v.getByTestId("wand-cancel").click().catch(() => {});
        await v.waitForTimeout(500);
      };
      // 既定のまま（許容差の既定）: 右縁の P の右半分 → P のはず
      await wandRun("2D", "default_right_half", iP, j0, 0.8, 0.5, null, true, iP, j0);
      await wandRun("2D", "default_bottom_half", i0, jP, 0.5, 0.8, null, true, i0, jP);
      // 許容差 1（シードの値が違えば結果が変わる）
      await wandRun("2D", "tol1_right_half", iP, j0, 0.8, 0.5, "1", true, iP, j0);
      await wandRun("2D", "tol1_bottom_half", i0, jP, 0.5, 0.8, "1", true, i0, jP);
      await wandRun("2D", "tol1_right_edge", iP, j0, 0.95, 0.5, "1", true, iP, j0);
      // 対照: 左半分は丸めでもずれない（正例）。外側の隣 Q の中央は P を含まない（検出器の負例）
      await wandRun("2D", "control_tol1_left_half", iP, j0, 0.2, 0.5, "1", true, iP, j0);
      await wandRun("2D", "control_tol1_outside_Q_center", iP + 1, j0, 0.5, 0.5, "1", false, iP, j0);
      // 3D Wand: 同じシードの判定
      await wandRun("3D", "default_right_half", iP, j0, 0.8, 0.5, null, true, iP, j0);
      await wandRun("3D", "tol1_bottom_half", i0, jP, 0.5, 0.8, "1", true, i0, jP);
    }
  }

  // ── C. 3D 球 ROI → マスク ──
  if (ONLY.has("C")) {
    console.log(`\n--- C. 3D 球 ROI（seedSphere3D → 塗りにする）---`);
    await cleanAll(v);
    await gotoSop(s.sops[best]);
    const sid = await dbg<string | null>(v, "seedSphere3D", C, R);
    await v.waitForTimeout(800);
    const row = v.locator('[data-testid="roi-row"][data-kind="sphere"]');
    if (!sid || (await row.count()) === 0) unmet(`${s.id}: 球の行`, "seedSphere3D が球を作れない / ROI マネージャに行が出ない");
    else {
      // 球の行の入力値（中心・半径）を画面から読み、truth と比べる（表示の確認）
      const shown: number[] = [];
      for (const a of ["x", "y", "z"]) shown.push(Number(await v.getByTestId(`sphere-center-${a}`).inputValue()));
      const shownR = Number(await v.getByTestId("sphere-radius").inputValue());
      console.log(`    球の行の表示: 中心 ${shown.join(", ")} 半径 ${shownR}（真値 ${C.map(f3).join(", ")} / ${R}）`);
      check(shown.every((x, i) => Math.abs(x - C[i]) <= 0.005) && Math.abs(shownR - R) <= 0.05, `${s.id}: 球の行の中心・半径の表示 = 与えた値（表示の丸め内）`, { shown, shownR });
      await v.getByTestId("sphere-bake").click();
      await v.waitForTimeout(3000);
      if ((await paintedRows(v).count()) === 0) unmet(`${s.id}: 塗りにする`, "塗り行ができない");
      else {
        await v.screenshot({ path: path.join(OUT_DIR, `${s.id}-C-bake.png`) });
        await analyseMask(`${s.id}: 球 ROI → マスク`);
      }
    }
    // 3D 窓の体積（ROI の体積 mL）は、3D 窓を開く経路を自動化していない。
    unmet(`${s.id}: 3D 窓の ROI 体積 vs 2D の体積`, "3D 窓を開いて ROI 体積を読む操作は未実装（このスパイクの範囲外）");
  }

  // ── D. しきい値 ──
  if (ONLY.has("D")) {
    console.log(`\n--- D. しきい値でできたマスク ---`);
    await cleanAll(v);
    await gotoSop(s.sops[best]);
    await pickTool(v, /^(Threshold|しきい値)/, "roiTools");
    if (!(await v.getByTestId("threshold-dialog").isVisible().catch(() => false))) {
      unmet(`${s.id}: しきい値ダイアログ`, "開かない");
    } else {
      // 球 = 場(約 70〜145) + 400 ≈ 470〜545。ほかの物体は 870 以上（楕円体・標識）。[300, 700] は球だけを取る。
      // 値は Rescale 適用値で指定する。
      const setF = async (id: string, val: string) => {
        const f = v.getByTestId(id);
        await f.fill(val);
        await f.press("Enter");
        await v.waitForTimeout(1200);
      };
      await setF("threshold-lower", "300");
      await setF("threshold-upper", "700");
      await v.getByTestId("threshold-scope-all").click();
      await v.waitForTimeout(4000);
      await v.screenshot({ path: path.join(OUT_DIR, `${s.id}-D-threshold.png`) });
      await v.getByTestId("threshold-commit").click().catch(() => {});
      await v.waitForTimeout(1500);
      if ((await paintedRows(v).count()) === 0) unmet(`${s.id}: しきい値のマスク行`, "ROI マネージャに塗り行が出ない");
      await analyseMask(`${s.id}: しきい値 [300,700]`);
    }
  }

  // ── B2. 3D Wand の球（球の中心を押す）──
  if (ONLY.has("B") && wandSetupOk) {
    console.log(`\n--- B2. 3D Wand（球の中心を押す）---`);
    await cleanAll(v);
    await gotoSop(s.sops[best]);
    cg = (await canvasGeometry(v))!;
    g = geo();
    await pickTool(v, /^3D Wand/, "roiTools");
    await clickCanvas(v, cg, cx, cy);
    try {
      await v.getByTestId("wand-count").waitFor({ timeout: 30_000 });
      await v.waitForTimeout(1500);
      // 球の内部の変化（場の勾配 ±約 20 HU）より大きく、球と背景の差（約 400）より小さい許容差
      const f = v.getByTestId("wand-threshold");
      await f.fill("100");
      await f.press("Enter");
      await v.waitForTimeout(3000);
      await v.screenshot({ path: path.join(OUT_DIR, `${s.id}-B2-wand3d.png`) });
      await v.getByTestId("wand-commit").click().catch(() => {});
      await v.waitForTimeout(1500);
      await analyseMask(`${s.id}: 3D Wand（中心・許容差 100）`);
    } catch {
      unmet(`${s.id}: 3D Wand の体積`, "wand-count が出ない");
    }
  }
  await v.close().catch(() => {});
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
