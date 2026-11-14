/*
 * 空間校正（mm への換算）と輝度校正（Rescale・SUV）が、ROI・計測の値に正しく効くかの実アプリ検査。
 *
 * 実行:  cd automator && GRAPHY_AUTOMATOR_HTTP_PORT=18450 GRAPHY_AUTOMATOR_SCP_PORT=18451 GRAPHY_AUTOMATOR_VITE_PORT=18453 \
 *          AUTOMATOR_DATA_DIR=$PWD/.results/run-data/desktop-calib timeout 600 npx tsx src/spike/geomCalibCheck.ts
 *   CALIB_IDS=A1_ps_only,D1_u16_slope037   検査するケース（カンマ区切り。既定は全部）。ID は make-geom-calib-phantom.py。
 *   CALIB_GROUPS=A,B,C,D,E                  グループで絞る
 *   CALIB_NEG=1   負例: 真値を「校正を無視した値」に差し替え、検査が落ちること（= 検査器が効いていること）を確かめる。
 *
 * 真値は合成ファントム（scripts/make-geom-calib-phantom.py → truth.json）の物理量から手計算した値:
 *   A/B  既知の物理長のバー（画素数 = 物理長 ÷ 真の mm/px）。真の mm/px は ImagerPixelSpacing×SOD/SID、PixelSpacing、US 領域の
 *        PhysicalDelta×10 から生成時に決めた値。アプリの校正式・座標変換（imageCoords 等）は使わない。
 *   D    既知の格納値のパッチ。真値 = 格納値 × Slope + Intercept。
 *   E    既知の放射能濃度（格納値 × Slope [Bq/mL]）。真値 = 濃度 × 体重[g] / 減衰補正後の投与量[Bq]。
 * ROI のハンドルは画面（getAnnotationCanvasPoints）から読み、画像全体の外形（getImageCanvasRect）÷ 行数/列数 で画素に直す。
 * 値は ROI 脇の textBox（DOM の svg text）から読む。
 *
 * 結果は 合格 / 失敗 / 未達 に分ける。未達（前提が成り立たず検査できなかった）を合格にしない。
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

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "geom-calib-check");
const HOST = "viewer2d-canvas-host";
const NEG = process.env.CALIB_NEG === "1";
const IDS = (process.env.CALIB_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const GROUPS = (process.env.CALIB_GROUPS ?? "").split(",").map((s) => s.trim()).filter(Boolean);

// ── 結果の数え方（合格 / 失敗 / 未達）──
let passed = 0;
const failures: string[] = [];
const unreached: string[] = [];
const notes: string[] = []; // 実測の記録（合否に数えない）
function check(cond: boolean, label: string, detail?: unknown): void {
  if (cond) {
    passed++;
    console.log(`  [ok  ] ${label}`);
  } else {
    console.log(`  [FAIL] ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
    failures.push(label);
  }
}
function unreach(label: string, why: unknown): void {
  console.log(`  [未達] ${label} — ${typeof why === "string" ? why : JSON.stringify(why)}`);
  unreached.push(`${label} — ${typeof why === "string" ? why : JSON.stringify(why)}`);
}
function note(s: string): void {
  console.log(`  [記録] ${s}`);
  notes.push(s);
}

/** 画面の数値表示（roiStatsText.formatNumber）の丸めの半幅: ≥1000 は整数、≥1 は小数 2 桁、<1 は有効数字 3 桁。 */
function quantHalf(v: number): number {
  const a = Math.abs(v);
  if (a >= 1000) return 0.5;
  if (a >= 1) return 0.005;
  if (a === 0) return 0;
  return 0.5 * 10 ** (Math.floor(Math.log10(a)) - 2);
}
/** 許容 = 表示の丸め + Float32 の相対誤差（Slope 乗算と加算で 2 回）+ 追加の相対誤差。 */
function tolFor(t: number, extraRel = 0): number {
  return quantHalf(t) + 2 * Math.abs(t) * 2 ** -23 + extraRel * Math.abs(t) + 1e-9;
}

// ── truth.json ──
interface Bar { x0: number; y0: number; px: number; mm: number | null; thick: number }
interface Patch { rect: number[]; stored: number; value?: number; conc?: number }
interface Case {
  id: string; group: string; desc: string; dir: string; rows: number; cols: number; sop: string;
  bars?: { h: Bar; v: Bar };
  expect?: { unit: "mm" | "px"; mmPerPxCol: number | null; mmPerPxRow: number | null };
  tags?: { ImagerPixelSpacing: number[] | null; PixelSpacing: number[] | null; SID: number | null; SOD: number | null };
  parVerticalOverHorizontal?: number;
  disc?: { cx: number; cy: number; a: number; b: number };
  pixelSpacing?: number[];
  slope?: number; intercept?: number; bgValue?: number;
  patches?: Record<string, Patch>;
  sexTag?: string | null;
  pet?: {
    doseBq: number; halfLifeS: number; decayS: number; weightKg: number | null; decayCorrectionTag: string;
    doseAtScanBq: number; conc: Record<string, number>;
    suvbw_start: Record<string, number>; suvbw_admin: Record<string, number>;
    height?: number; lbm?: { M: number; F: number };
    suvlbm_james_start?: { M: Record<string, number>; F: Record<string, number> };
  };
}
interface Truth { cases: Case[] }

function makePhantom(): { dir: string; truth: Truth } {
  const dir = path.join(OUT_DIR, "phantom");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const seed = String(Date.now() % 1_000_000_000); // UID は実行ごとに変える
  const r = spawnSync("python3", ["-I", path.join(AUTOMATOR_ROOT, "scripts", "make-geom-calib-phantom.py"), dir, "--uid-seed", seed], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`ファントム生成に失敗: ${r.stderr}`);
  return { dir, truth: JSON.parse(fs.readFileSync(path.join(dir, "truth.json"), "utf8")) as Truth };
}

// ── 画面から読む ──
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

/** ラベルの直後の数値と、直後に続く単位らしい語（mm / px / SUVbw / HU …）を取る。 */
function valueAfter(lines: string[], re: RegExp): { v: number; unit: string } | null {
  const r = new RegExp("(?:" + re.source + ")\\s*[:：]?\\s*(-?\\d+(?:\\.\\d+)?)(?:\\s*\\u00b1\\s*\\d+(?:\\.\\d+)?)?\\s*([^\\s\\d,;:()]*(?:\\u00b2)?)");
  for (const l of lines) {
    const m = l.match(r);
    if (m) {
      // 行が連結されている（"px" + "Mean…"）ことがあるので、既知の単位の先頭だけを取る。
      const u = (m[2] ?? "").match(/^(mm\u00b2|mm|px\u00b2|px|cm|SUV[a-z]*|HU|Bq\/m[lL]|raw)/);
      return { v: Number(m[1]), unit: u ? u[1] : (m[2] ?? "") };
    }
  }
  return null;
}

async function lastHandles(page: Page): Promise<{ tool: string; points: number[][] } | null> {
  const all = (await page.evaluate(`window.__graphyDebug.getAnnotationCanvasPoints()`)) as Array<{ tool: string; points: number[][] }>;
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
    const btns = await page.getByRole("button").allTextContents();
    console.log("  [menu] buttons:", JSON.stringify(btns.map((t) => t.trim()).filter(Boolean).slice(0, 60)));
    throw e;
  }
}
async function pickTool(page: Page, labelRe: RegExp, menu: "roi" | "measure"): Promise<void> {
  await clickMenuItem(page, menu, labelRe);
  await page.waitForTimeout(250);
}
async function clearRois(page: Page): Promise<void> {
  await clickMenuItem(page, "roi", /^(ROI を全消去|Clear ROIs)$/);
  await page.waitForTimeout(500);
  await clickMenuItem(page, "measure", /^(計測を全消去|Clear measurements)$/);
  await page.waitForTimeout(500);
}

interface VpInfo { viewportId: string; imageId: string | null }
async function viewportInfo(page: Page): Promise<VpInfo | null> {
  const v = (await page.evaluate(`window.__graphyDebug ? window.__graphyDebug.getViewportGeometry() : []`)) as VpInfo[];
  return v.find((x) => x.imageId) ?? null;
}

/** 画像全体が canvas に占める範囲（CSS px、canvas 左上原点）と canvas の大きさ。 */
async function canvasGeometry(page: Page, viewportId: string) {
  return (await page.evaluate(`
    (function () {
      var host = document.querySelector('[data-testid="${HOST}"]');
      var canvas = host && host.querySelector("canvas");
      var r = canvas.getBoundingClientRect();
      var img = window.__graphyDebug.getImageCanvasRect(${JSON.stringify(viewportId)});
      return { w: r.width, h: r.height, img: img };
    })()
  `)) as { w: number; h: number; img: number[] | null };
}

/** canvas 内 CSS px へクリック（pointerdown → pointerup）。Angle の第 3 点など。 */
async function clickCanvas(page: Page, x: number, y: number): Promise<void> {
  await page.evaluate(`
    (function () {
      var canvas = document.querySelector('[data-testid="${HOST}"] canvas');
      var r = canvas.getBoundingClientRect();
      var cx = r.left + ${x}, cy = r.top + ${y};
      function fire(type, btns) {
        var common = { bubbles: true, cancelable: true, composed: true, clientX: cx, clientY: cy, button: 0, buttons: btns };
        canvas.dispatchEvent(new PointerEvent(type, Object.assign({}, common, { pointerId: 1, pointerType: "mouse", isPrimary: true })));
        canvas.dispatchEvent(new MouseEvent(type.replace("pointer", "mouse"), common));
      }
      fire("pointermove", 0); fire("pointerdown", 1); fire("pointerup", 0);
    })()
  `);
}

// ── ケースの共通処理 ──
interface Ctx {
  v: Page; c: Case; cg: { w: number; h: number; img: number[] };
  /** canvas の CSS px / 画像の 1 画素。 */
  sx: number; sy: number;
  /** 画素（中心 = 整数）→ canvas CSS px。 */
  toCanvas: (i: number, j: number) => [number, number];
  /** canvas CSS px → 画素（中心 = 整数）。 */
  toPixel: (x: number, y: number) => [number, number];
}

const frac = (cg: { w: number; h: number }, x: number, y: number) => ({ fracX: x / cg.w, fracY: y / cg.h });

async function drawRoi(cx: Ctx, tool: RegExp, menu: "roi" | "measure", x0: number, y0: number, x1: number, y1: number) {
  await clearRois(cx.v);
  await pickTool(cx.v, tool, menu);
  await dragOnCanvasHost(cx.v, HOST, x1 - x0, y1 - y0, 0, 10, frac(cx.cg, x0, y0));
  await cx.v.waitForTimeout(1500);
  return { lines: await readTextBoxLines(cx.v), h: await lastHandles(cx.v) };
}

async function openCase(d: DesktopDriver, dir: string, c: Case): Promise<Ctx | null> {
  await resetDb(d.ports.http);
  const files = fs.readdirSync(path.join(dir, c.dir)).filter((f) => f.endsWith(".dcm")).map((f) => path.join(dir, c.dir, f));
  const imp = await importPaths(d.ports.http, files);
  if (!(imp.imported === files.length && imp.failed === 0)) {
    unreach(`${c.id}: 取り込み`, imp);
    return null;
  }
  const main = d.page;
  await main.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
  await openFirstSeriesInViewer(main, createStepRecorder());
  const viewer = await d.waitForNewPage(() => main.getByTestId("viewer2d-toolbar-button").click(), (url) => url.includes("2dviewer"));
  await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 20_000 });
  await viewer.waitForTimeout(2500);
  viewer.on("dialog", (dlg) => void dlg.accept());
  if (c.group === "D" || c.group === "E") {
    // 最小・最大は「全項目」表示でしか出ない。ランタイム状態だけ切り替える（設定は書き換えない）。
    await viewer.evaluate(`import("/src/viewer/roiStatsDisplay.ts").then((m) => m.setRoiStatsDisplay({ detail: "full" }))`);
  }
  const vp = await viewportInfo(viewer);
  if (!vp) {
    unreach(`${c.id}: 画像が表示された`, "viewport に imageId が無い");
    await viewer.close().catch(() => {});
    return null;
  }
  let cg = await canvasGeometry(viewer, vp.viewportId);
  for (let n = 0; n < 12 && !cg.img; n++) {
    await viewer.waitForTimeout(1000);
    cg = await canvasGeometry(viewer, vp.viewportId);
  }
  if (!cg.img) {
    unreach(`${c.id}: 画像の外形が取れた`, cg);
    await viewer.close().catch(() => {});
    return null;
  }
  const [ix0, iy0, ix1, iy1] = cg.img;
  const sx = (ix1 - ix0) / c.cols, sy = (iy1 - iy0) / c.rows;
  await viewer.screenshot({ path: path.join(OUT_DIR, `${c.id}-view.png`) });
  return {
    v: viewer, c, cg: { w: cg.w, h: cg.h, img: cg.img }, sx, sy,
    toCanvas: (i, j) => [ix0 + (i + 0.5) * sx, iy0 + (j + 0.5) * sy],
    toPixel: (x, y) => [(x - ix0) / sx - 0.5, (y - iy0) / sy - 0.5],
  };
}

// ═══════════ A/B: 長さ（mm / px）═══════════
async function runSpatial(cx: Ctx): Promise<void> {
  const c = cx.c;
  const ex = c.expect!;
  console.log(`  canvas px/画素: x=${cx.sx.toFixed(3)} y=${cx.sy.toFixed(3)}（${c.desc}）`);
  // 負例: 校正を無視した真値（常に「画素 × 1 を mm とみなす」= 検出器面/生の値）に差し替える。
  const mmCol = NEG ? (ex.unit === "mm" ? 1 : 1) : ex.mmPerPxCol;
  const mmRow = NEG ? 1 : ex.mmPerPxRow;
  for (const dir of ["h", "v"] as const) {
    const b = c.bars![dir];
    // 水平: 左端 → 右端。垂直: 上端 → 下端。バーの端（画素の縁）に置く。
    const a0 = dir === "h" ? cx.toCanvas(b.x0 - 0.5, b.y0 + (b.thick - 1) / 2) : cx.toCanvas(b.x0 + (b.thick - 1) / 2, b.y0 - 0.5);
    const a1 = dir === "h" ? cx.toCanvas(b.x0 + b.px - 0.5, b.y0 + (b.thick - 1) / 2) : cx.toCanvas(b.x0 + (b.thick - 1) / 2, b.y0 + b.px - 0.5);
    const { lines, h } = await drawRoi(cx, /^長さ$|^Length$/, "measure", a0[0], a0[1], a1[0], a1[1]);
    const val = valueAfter(lines, /長さ|Length/);
    if (!val || !h || h.points.length < 2) {
      unreach(`${c.id}: Length（${dir === "h" ? "水平" : "垂直"}）の値とハンドルが取れた`, { lines, h });
      continue;
    }
    // ハンドル → 画素。真値（画素数）は、ハンドルの画素距離 × 手計算の mm/px。
    const [u0, v0] = cx.toPixel(h.points[0][0], h.points[0][1]);
    const [u1, v1] = cx.toPixel(h.points[1][0], h.points[1][1]);
    const du = Math.abs(u1 - u0), dv = Math.abs(v1 - v0);
    const pxLen = Math.hypot(du, dv);
    const name = dir === "h" ? "水平" : "垂直";
    // 前提: ハンドルがバーの両端にある（±1 CSS px の丸め）。
    const tolPx = 1.5 / (dir === "h" ? cx.sx : cx.sy);
    check(Math.abs((dir === "h" ? du : dv) - b.px) <= tolPx, `${c.id}: Length（${name}）のハンドルがバーの両端にある（前提）`, { handlesPx: dir === "h" ? du : dv, barPx: b.px });
    const expectedUnit = ex.unit;
    const truthLen = expectedUnit === "mm" && mmCol && mmRow ? Math.hypot(du * mmCol, dv * mmRow) : pxLen;
    const unitOk = val.unit.toLowerCase().startsWith(expectedUnit);
    console.log(`  Length（${name}）: 表示 ${val.v} ${val.unit} / 期待 ${truthLen.toFixed(3)} ${expectedUnit}（バー ${b.px} px${b.mm ? ` = ${b.mm} mm` : ""}）`);
    check(unitOk, `${c.id}: Length（${name}）の単位が ${expectedUnit}`, { unit: val.unit, lines });
    const tol = 0.011 + 0.0005 * truthLen;
    check(Math.abs(val.v - truthLen) <= tol, `${c.id}: Length（${name}）の値 = ハンドルの画素距離 × 真の mm/px${expectedUnit === "px" ? "（px のまま）" : ""}`, { read: val.v, truth: truthLen, ratio: val.v / truthLen, lines });
    // 物理量そのものとの突き合わせ（バーの既知の物理長）。
    if (!NEG && b.mm !== null && expectedUnit === "mm") {
      const tolPhys = tolPx * (dir === "h" ? mmCol! : mmRow!) + 0.05;
      check(Math.abs(val.v - b.mm) <= tolPhys, `${c.id}: Length（${name}）= バーの物理長 ${b.mm} mm`, { read: val.v, barMm: b.mm, ratio: val.v / b.mm });
    }
  }
  await cx.v.screenshot({ path: path.join(OUT_DIR, `${c.id}-rois.png`) });
}

// ═══════════ C: PixelAspectRatio ═══════════
async function runPar(cx: Ctx): Promise<void> {
  const c = cx.c;
  const r = c.parVerticalOverHorizontal!; // 縦画素寸法 / 横画素寸法 = 1.2
  const aspect = cx.sy / cx.sx;
  note(`${c.id}: 表示の縦横比（画面上の 1 画素の高さ / 幅）= ${aspect.toFixed(4)}（PAR 6:5 を反映するなら ${r}）`);
  check(Math.abs(aspect / r - 1) < 0.01, `${c.id}: 画面上で画素が PixelAspectRatio（縦/横 = ${r}）で表示される`, { aspect, expected: r });
  // 円盤の画面上の形（実測: スクリーンショットでなく、横・縦の直径を画面上の canvas px で）。
  const d = c.disc!;
  const wScreen = 2 * d.a * cx.sx, hScreen = 2 * d.b * cx.sy;
  note(`${c.id}: 円盤（患者内では円）の画面上の縦横比 高さ/幅 = ${(hScreen / wScreen).toFixed(4)}（円なら 1）`);
  check(Math.abs(hScreen / wScreen - 1) < 0.01, `${c.id}: 円盤が円として表示される（高さ/幅 = 1）`, { ratio: hScreen / wScreen });
  // 長さ（水平直径・垂直直径）。真値: 水平 = 横画素 × 1、垂直 = 縦画素 × 1.2（横の画素寸法を 1 単位とする）。
  for (const dir of ["h", "v"] as const) {
    const b = c.bars![dir];
    const a0 = dir === "h" ? cx.toCanvas(b.x0 - 0.5, b.y0 + (b.thick - 1) / 2) : cx.toCanvas(b.x0 + (b.thick - 1) / 2, b.y0 - 0.5);
    const a1 = dir === "h" ? cx.toCanvas(b.x0 + b.px - 0.5, b.y0 + (b.thick - 1) / 2) : cx.toCanvas(b.x0 + (b.thick - 1) / 2, b.y0 + b.px - 0.5);
    const { lines, h } = await drawRoi(cx, /^長さ$|^Length$/, "measure", a0[0], a0[1], a1[0], a1[1]);
    const val = valueAfter(lines, /長さ|Length/);
    if (!val || !h) { unreach(`${c.id}: Length ${dir}`, { lines, h }); continue; }
    const [u0, v0] = cx.toPixel(h.points[0][0], h.points[0][1]);
    const [u1, v1] = cx.toPixel(h.points[1][0], h.points[1][1]);
    const trueLen = Math.hypot(Math.abs(u1 - u0), Math.abs(v1 - v0) * r); // 横画素寸法 = 1 の単位
    const pxLen = Math.hypot(Math.abs(u1 - u0), Math.abs(v1 - v0));
    note(`${c.id}: Length（${dir === "h" ? "水平" : "垂直"}直径）表示 ${val.v} ${val.unit} / 画素のまま ${pxLen.toFixed(2)} / PAR 補正した真値 ${trueLen.toFixed(2)}（単位: 横画素寸法）→ 比 ${(val.v / trueLen).toFixed(4)}`);
    check(Math.abs(val.v - trueLen) <= 0.011 + 0.0005 * trueLen, `${c.id}: Length（${dir === "h" ? "水平" : "垂直"}）が PAR 補正した長さ`, { read: val.v, truth: trueLen, ratio: val.v / trueLen });
  }
  // 角度: 頂点 = 円盤中心、腕 1 = +x へ 100 画素、腕 2 = (+100, -100) 画素。真値（PAR 補正）= atan2(100*1.2, 100)、画素のまま = 45°。
  {
    await clearRois(cx.v);
    await pickTool(cx.v, /^角度$|^Angle$/, "measure");
    const vtx = cx.toCanvas(d.cx, d.cy);
    const p1 = cx.toCanvas(d.cx + 100, d.cy);
    const p2 = cx.toCanvas(d.cx + 100, d.cy - 100);
    // 点 0 = p1（腕 1 の端）、点 1 = 頂点、点 2 = p2。最初の線分をドラッグで引き、第 3 点をクリック。
    await dragOnCanvasHost(cx.v, HOST, vtx[0] - p1[0], vtx[1] - p1[1], 0, 8, frac(cx.cg, p1[0], p1[1]));
    await cx.v.waitForTimeout(300);
    await clickCanvas(cx.v, p2[0], p2[1]);
    await cx.v.waitForTimeout(1500);
    const lines = await readTextBoxLines(cx.v);
    const h = await lastHandles(cx.v);
    const am = lines.join(" ").match(/(-?\d+(?:\.\d+)?)\s*\u00b0/);
    const val = am ? { v: Number(am[1]), unit: "deg" } : null;
    if (!val || !h || h.points.length < 3) {
      unreach(`${c.id}: Angle の値とハンドルが取れた`, { lines, h });
    } else {
      // ハンドルから、画素 → 患者内（縦 × r）の角度を手計算
      const px = h.points.map((p) => cx.toPixel(p[0], p[1]));
      const [A, V, B] = px; // A=腕 1 端, V=頂点, B=腕 2 端
      const ang = (k: number) => {
        const a = [A[0] - V[0], (A[1] - V[1]) * k], b = [B[0] - V[0], (B[1] - V[1]) * k];
        return (Math.acos((a[0] * b[0] + a[1] * b[1]) / (Math.hypot(a[0], a[1]) * Math.hypot(b[0], b[1]))) * 180) / Math.PI;
      };
      const truth = ang(r), asPx = ang(1);
      note(`${c.id}: Angle 表示 ${val.v}° / 画素のまま ${asPx.toFixed(2)}° / PAR 補正した真値 ${truth.toFixed(2)}°（差 ${(val.v - truth).toFixed(2)}°）`);
      check(Math.abs(val.v - truth) <= 0.15, `${c.id}: Angle が PAR 補正した角度`, { read: val.v, truth, asPx });
    }
  }
  // 円 ROI: 円盤の外接（横半径 90 px）。面積の真値（PAR 補正）= π r² × 1.2（横画素寸法²）。
  {
    const ctr = cx.toCanvas(d.cx, d.cy);
    const rEdge = cx.toCanvas(d.cx + d.a, d.cy);
    const { lines, h } = await drawRoi(cx, /円 ROI|Circle ROI/, "roi", ctr[0], ctr[1], rEdge[0], rEdge[1]);
    const a = valueAfter(lines, /面積|Area/);
    if (!a || !h || h.points.length < 2) { unreach(`${c.id}: Circle ROI の面積`, { lines, h }); return; }
    const [u0, v0] = cx.toPixel(h.points[0][0], h.points[0][1]);
    const [u1, v1] = cx.toPixel(h.points[1][0], h.points[1][1]);
    const rpx = Math.hypot(u1 - u0, v1 - v0);
    const truth = Math.PI * rpx * rpx; // 円盤内の画素数ではなく、ROI の円の面積（円の形は画面上の円）
    note(`${c.id}: Circle ROI 面積 表示 ${a.v} ${a.unit}（半径 ${rpx.toFixed(2)} 画素）。画面上の円 → 画素 ${truth.toFixed(1)}。PAR を反映する表示なら円は縦につぶれた楕円（面積 ×${r}）`);
  }
  await cx.v.screenshot({ path: path.join(OUT_DIR, `${c.id}-rois.png`) });
}

// ═══════════ D/E: 矩形 ROI の統計・Probe ═══════════
/** パッチ内の矩形 ROI（パッチの内側 8 割）。平均・最小・最大・単位を返す。 */
async function rectOnPatch(cx: Ctx, p: Patch) {
  const [x0, y0, x1, y1] = p.rect;
  const mx = 0.1 * (x1 - x0 + 1), my = 0.1 * (y1 - y0 + 1);
  const a = cx.toCanvas(x0 + mx - 0.5, y0 + my - 0.5);
  const b = cx.toCanvas(x1 - mx + 0.5, y1 - my + 0.5);
  // toCanvas は画素中心なので、縁を指定するために -0.5 だけ戻した値を渡している（左上・右下の頂点）
  return drawRoi(cx, /矩形 ROI|Rectangle ROI/, "roi", a[0], a[1], b[0], b[1]);
}

function statsOf(lines: string[]) {
  return {
    mean: valueAfter(lines, /平均|Mean/),
    min: valueAfter(lines, /最小|Min/),
    max: valueAfter(lines, /最大|Max/),
  };
}

async function runCt(cx: Ctx): Promise<void> {
  const c = cx.c;
  const slope = NEG ? 1 : c.slope!, icpt = NEG ? 0 : c.intercept!; // 負例: Rescale を無視した真値
  const val = (stored: number) => stored * slope + icpt;
  console.log(`  ${c.desc}: Slope ${c.slope} Intercept ${c.intercept}`);
  for (const k of ["P1", "P2", "P3"]) {
    const p = c.patches![k];
    const { lines, h } = await rectOnPatch(cx, p);
    const s = statsOf(lines);
    if (!s.mean || !s.min || !s.max) { unreach(`${c.id}: ${k} の矩形 ROI の統計が読めた`, { lines, h }); continue; }
    const t = val(p.stored);
    // 許容: 表示の丸め（2 桁なら 0.005）+ Float32 の相対誤差 2^-24 × |値| × 2（Slope 乗算と加算）
    const tol = tolFor(t);
    console.log(`  ${k}: 平均 ${s.mean.v} 最小 ${s.min.v} 最大 ${s.max.v} ${s.mean.unit} / 真値 ${t}`);
    check(Math.abs(s.mean.v - t) <= tol, `${c.id}: ${k}（格納値 ${p.stored}）の ROI 平均 = ${t.toFixed(4)}`, { mean: s.mean.v, truth: t, lines });
    check(Math.abs(s.min.v - t) <= tol && Math.abs(s.max.v - t) <= tol, `${c.id}: ${k} の最小・最大 = ${t.toFixed(4)}（一様領域）`, { min: s.min.v, max: s.max.v, truth: t });
    if (k === "P1") {
      const unitLabel = s.mean.unit;
      note(`${c.id}: 統計の単位表示 = "${unitLabel}"（textBox の行: ${JSON.stringify(lines)}）`);
    }
  }
  // 境界をまたぐ ROI: 最小 = 左の値、最大 = 右の値（拾う画素数に依らない）
  {
    const a = c.patches!.P4a, b = c.patches!.P4b;
    const lo = cx.toCanvas(a.rect[0] + 5 - 0.5, a.rect[1] + 10 - 0.5);
    const hi = cx.toCanvas(b.rect[2] - 5 + 0.5, a.rect[3] - 10 + 0.5);
    const { lines } = await drawRoi(cx, /矩形 ROI|Rectangle ROI/, "roi", lo[0], lo[1], hi[0], hi[1]);
    const s = statsOf(lines);
    if (!s.min || !s.max) unreach(`${c.id}: 境界 ROI の統計が読めた`, lines);
    else {
      const tmin = Math.min(val(a.stored), val(b.stored)), tmax = Math.max(val(a.stored), val(b.stored));
      const tol = Math.max(tolFor(tmin), tolFor(tmax));
      console.log(`  境界: 最小 ${s.min.v} 最大 ${s.max.v} / 真値 ${tmin} ${tmax}`);
      check(Math.abs(s.min.v - tmin) <= tol && Math.abs(s.max.v - tmax) <= tol, `${c.id}: 境界をまたぐ ROI の最小 = ${tmin.toFixed(4)}・最大 = ${tmax.toFixed(4)}`, { min: s.min.v, max: s.max.v, tmin, tmax, lines });
    }
  }
  // Probe（点）
  {
    const p = c.patches!.P2;
    const ctr = cx.toCanvas((p.rect[0] + p.rect[2]) / 2, (p.rect[1] + p.rect[3]) / 2);
    await clearRois(cx.v);
    await pickTool(cx.v, /^Probe$|^プローブ$/, "measure");
    await clickCanvas(cx.v, ctr[0], ctr[1]);
    await cx.v.waitForTimeout(1200);
    const lines = await readTextBoxLines(cx.v);
    const pv = valueAfter(lines, /値|Value|Probe|SUV|HU|^/);
    const nums = lines.join(" ").match(/-?\d+(?:\.\d+)?/g);
    note(`${c.id}: Probe の textBox = ${JSON.stringify(lines)}`);
    const t = val(p.stored);
    const hit = (nums ?? []).map(Number).some((n) => Math.abs(n - t) <= tolFor(t));
    check(hit, `${c.id}: Probe（P2）の値 = ${t.toFixed(4)}`, { lines, truth: t, pv });
  }
  await cx.v.screenshot({ path: path.join(OUT_DIR, `${c.id}-rois.png`) });
}

// ── SUV ──
async function openSuvDialog(v: Page): Promise<void> {
  await v.getByTestId("viewer2d-menu-image").click();
  await v.getByTestId("menu-suv").click();
  await v.getByTestId("suv-dialog").waitFor({ state: "visible", timeout: 8000 });
}

async function runPt(cx: Ctx): Promise<void> {
  const c = cx.c;
  const pet = c.pet!;
  const v = cx.v;
  const james = c.id.endsWith("_james");
  // 1) 校正前: ROI は Bq/mL（モダリティ値）。
  const p1 = c.patches!.P1, p2 = c.patches!.P2;
  {
    const { lines } = await rectOnPatch(cx, p1);
    const s = statsOf(lines);
    note(`${c.id}: SUV 校正前の P1 平均 = ${s.mean?.v} ${s.mean?.unit}（濃度の真値 ${p1.conc} Bq/mL）`);
    if (!s.mean) unreach(`${c.id}: 校正前の ROI 平均が読めた`, lines);
    else check(Math.abs(s.mean.v - p1.conc!) <= tolFor(p1.conc!), `${c.id}: SUV 校正前の ROI 平均 = 濃度（Rescale のみ）${p1.conc} Bq/mL`, { read: s.mean.v, truth: p1.conc, lines });
  }
  // 2) SUV ダイアログ（実 UI）。既定のまま通す。
  await openSuvDialog(v);
  const dlg = v.getByTestId("suv-dialog");
  if (james) await v.getByTestId("suv-type").selectOption("sul-james");
  const fields = {
    weight: await v.getByTestId("suv-weight").inputValue(),
    dose: await v.getByTestId("suv-dose").inputValue(),
    half: await v.getByTestId("suv-half-life").inputValue(),
    inj: await v.getByTestId("suv-inj-time").inputValue(),
    ser: await v.getByTestId("suv-ser-time").inputValue(),
    sex: await dlg.locator("select").nth(1).inputValue(),
    height: await dlg.locator("input").nth(1).inputValue(),
  };
  console.log(`  ダイアログの既定値: ${JSON.stringify(fields)}`);
  await v.screenshot({ path: path.join(OUT_DIR, `${c.id}-suv-dialog.png`) });
  const noWeight = pet.weightKg === null || pet.weightKg === 0;
  await v.getByTestId("suv-apply").click();
  await v.waitForTimeout(800);
  const stillOpen = await v.getByTestId("suv-dialog").isVisible().catch(() => false);
  if (noWeight) {
    const errText = stillOpen ? (await dlg.innerText()).replace(/\s+/g, " ").slice(0, 400) : "";
    check(stillOpen, `${c.id}: 体重 ${pet.weightKg === 0 ? "0" : "欠損"} → SUV を適用せず、ダイアログにエラーを出す`, { weightField: fields.weight, errText });
    note(`${c.id}: 体重なしのダイアログ: 体重欄 = "${fields.weight}"、エラー = ${errText}`);
    await v.getByRole("button", { name: /^Cancel$|キャンセル/ }).first().click().catch(() => {});
    await v.waitForTimeout(500);
    // 適用されていないことを、ROI の値（Bq/mL のまま・SUV の値や 0 が出ない）で確かめる。
    const { lines } = await rectOnPatch(cx, p1);
    const s = statsOf(lines);
    check(!!s.mean && Math.abs(s.mean.v - p1.conc!) <= tolFor(p1.conc!) && !/suv/i.test(s.mean.unit), `${c.id}: 体重なし → ROI は SUV 値を出さず Bq/mL のまま`, { mean: s.mean, lines });
    await v.screenshot({ path: path.join(OUT_DIR, `${c.id}-rois.png`) });
    return;
  }
  let effSex: "M" | "F" = (c.sexTag ?? "M") === "F" ? "F" : "M";
  if (james && !c.sexTag) {
    // PatientSex 欠損: 既定のまま適用すると計算不可（男性扱いで値を出さない）。性別を選べば計算できる。
    const errText = stillOpen ? (await dlg.innerText()).replace(/\s+/g, " ").slice(0, 400) : "";
    check(stillOpen && /性別|sex/i.test(errText), `${c.id}: 性別欠損 → SUL を適用せず、性別が必要とのエラーを出す`, { stillOpen, errText, sexField: fields.sex });
    await v.screenshot({ path: path.join(OUT_DIR, `${c.id}-suv-dialog-error.png`) });
    if (!stillOpen) return;
    await dlg.locator("select").nth(1).selectOption("F");
    await v.getByTestId("suv-apply").click();
    await v.waitForTimeout(800);
    if (await v.getByTestId("suv-dialog").isVisible().catch(() => false)) {
      unreach(`${c.id}: 性別を F にして SUL が適用できた`, (await dlg.innerText()).replace(/\s+/g, " ").slice(0, 400));
      return;
    }
    effSex = "F";
  } else if (stillOpen) {
    const errText = (await dlg.innerText()).replace(/\s+/g, " ").slice(0, 400);
    unreach(`${c.id}: SUV が適用できた`, errText);
    return;
  }
  // 3) SUV 適用後の ROI 平均と、期待値（手計算）を比べる。
  const truthFor = (k: string): { v: number; label: string } => {
    if (james) {
      return { v: pet.suvlbm_james_start![effSex][k], label: `SUVlbm(James, ${c.sexTag ?? "欠損→利用者が F を選択"})` };
    }
    // ADMIN は「濃度が投与時刻に補正済み」の想定の真値（decay 無し）。START は走査時刻の投与量。
    const t = pet.decayCorrectionTag === "ADMIN" ? pet.suvbw_admin[k] : pet.suvbw_start[k];
    return { v: t, label: `SUVbw(${pet.decayCorrectionTag})` };
  };
  for (const [k, p] of [["P1", p1], ["P2", p2]] as Array<[string, Patch]>) {
    const { lines } = await rectOnPatch(cx, p);
    const s = statsOf(lines);
    if (!s.mean) { unreach(`${c.id}: ${k} の SUV 平均が読めた`, lines); continue; }
    let t = truthFor(k);
    // 負例: 減衰補正を無視した真値（濃度 × 体重 / 投与量）に差し替える
    if (NEG && !james) t = { v: pet.suvbw_admin[k], label: "減衰を無視した SUVbw（負例）" };
    // 許容: 表示の丸め（2 桁 → 0.005）+ ダイアログの入力丸め（体重・投与量・半減期 2 桁、時刻は秒）+ Float32 相対 2^-23
    const tol = tolFor(t.v, 1e-4);
    console.log(`  ${k}: 平均 ${s.mean.v} ${s.mean.unit} / 真値 ${t.label} = ${t.v.toFixed(5)} / 比 ${(s.mean.v / t.v).toFixed(4)}`);
    const isAdmin = pet.decayCorrectionTag === "ADMIN";
    check(Math.abs(s.mean.v - t.v) <= tol, `${c.id}: ${k} の ROI 平均 = ${t.label} 期待 ${t.v.toFixed(4)}`, { read: s.mean.v, truth: t.v, ratio: s.mean.v / t.v, unit: s.mean.unit, isAdmin });
    if (k === "P1") {
      note(`${c.id}: SUV 適用後の単位表示 = "${s.mean.unit}"`);
      if (james) {
        const m = pet.suvlbm_james_start!.M[k], f = pet.suvlbm_james_start!.F[k];
        note(`${c.id}: PatientSex タグ=${c.sexTag ?? "欠損"} / ダイアログの性別欄 = ${fields.sex} / 表示 ${s.mean.v} / 手計算 M ${m.toFixed(4)} F ${f.toFixed(4)}（LBM M ${pet.lbm!.M.toFixed(3)} kg, F ${pet.lbm!.F.toFixed(3)} kg）`);
      }
      if (isAdmin) {
        note(`${c.id}: DecayCorrection=ADMIN: 表示 ${s.mean.v} / START 想定 ${pet.suvbw_start[k].toFixed(4)} / ADMIN 想定 ${pet.suvbw_admin[k].toFixed(4)}`);
      }
    }
  }
  // Probe（点）: SUV 値が出るか
  {
    const ctr = cx.toCanvas((p2.rect[0] + p2.rect[2]) / 2, (p2.rect[1] + p2.rect[3]) / 2);
    await clearRois(v);
    await pickTool(v, /^Probe$|^プローブ$/, "measure");
    await clickCanvas(v, ctr[0], ctr[1]);
    await v.waitForTimeout(1200);
    const lines = await readTextBoxLines(v);
    note(`${c.id}: SUV 適用後の Probe textBox = ${JSON.stringify(lines)}`);
  }
  await v.screenshot({ path: path.join(OUT_DIR, `${c.id}-rois.png`) });
}

// ── main ──
async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const { dir, truth } = makePhantom();
  const d = new DesktopDriver();
  await d.start();
  try {
    d.page.on("console", (m) => {
      if (m.type() === "error") console.log(`  [renderer error] ${m.text().slice(0, 200)}`);
    });
    for (const c of truth.cases) {
      if (IDS.length && !IDS.includes(c.id)) continue;
      if (GROUPS.length && !GROUPS.includes(c.group)) continue;
      console.log(`\n=== ${c.id}${NEG ? "（負例: 校正を無視した真値）" : ""} — ${c.desc} ===`);
      let cx: Ctx | null = null;
      try {
        cx = await openCase(d, dir, c);
        if (!cx) continue;
        if (c.group === "A" || c.group === "B") await runSpatial(cx);
        else if (c.group === "C") await runPar(cx);
        else if (c.group === "D") await runCt(cx);
        else if (c.group === "E") await runPt(cx);
      } catch (e) {
        unreach(`${c.id}: 実行中の例外`, String((e as Error).stack ?? e).slice(0, 600));
      } finally {
        await cx?.v.close().catch(() => {});
      }
    }
  } finally {
    await d.stop().catch(() => {});
  }
  console.log(`\n合格 ${passed} / 失敗 ${failures.length} / 未達 ${unreached.length}`);
  if (failures.length) console.log("失敗:\n  - " + failures.join("\n  - "));
  if (unreached.length) console.log("未達:\n  - " + unreached.join("\n  - "));
  if (notes.length) console.log("記録:\n  - " + notes.join("\n  - "));
  fs.writeFileSync(path.join(OUT_DIR, NEG ? "summary-neg.json" : "summary.json"), JSON.stringify({ passed, failures, unreached, notes }, null, 1));
  // 負例では「落ちること」が合格。
  process.exitCode = NEG ? (failures.length > 0 ? 0 : 1) : failures.length || unreached.length ? 1 : 0;
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
