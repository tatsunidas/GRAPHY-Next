/*
 * ROI・マスクの書き出し（DICOM SEG・RTSTRUCT・ImageJ ROI・CSV）と取り込みの幾何検証（実アプリ）。
 *
 * 実行:  cd automator && GEOM_IDS=g1_aniso npx tsx src/spike/geomExportCheck.ts
 *   GEOM_IDS   検査する幾何（カンマ区切り。既定 g1_aniso）。make-geom-verify-phantom.py の ID。
 *   GEOM_PARTS 実行する部（既定 ABCDFE。A=SEG 書き出し B=RTSTRUCT C=ImageJ D=CSV F=経路間の同値 E=取り込み）
 *   GEOM_NEG   負例: swap（行/列間隔を入れ替えた真値・読み手）/ flip（読み手の行方向の符号を反転）。検査が落ちること。
 *   GRAPHY_AUTOMATOR_{HTTP,SCP,VITE}_PORT / AUTOMATOR_DATA_DIR  専用ポート・データ置き場。
 *
 * 真値: truth.json（合成ファントムの解析形状・各スライスの IPP/SOP）。読み手は scripts/verify-geom-export.py
 * （pydicom・numpy・標準ライブラリだけ。アプリの読み込みコードは使わない）。
 * 画面側の期待値（描いた ROI の位置・大きさ）は、画像全体が canvas に占める範囲 ÷ 物理 FOV と truth の IPP/IOP/間隔
 * から LPS に直す（geomRoiCheck.ts と同じ。アプリの座標変換は使わない）。
 *
 * 結果は 合格 / 失敗 / 未達 / 参考 を分けて数える。未達（前提が揃わず検査できなかった）を合格に数えない。
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

const OUT_ROOT = path.join(AUTOMATOR_ROOT, ".results", "geom-export-check");
const HOST = "viewer2d-canvas-host";
const NEG = process.env.GEOM_NEG ?? "";
const IDS = (process.env.GEOM_IDS ?? "g1_aniso").split(",").map((s) => s.trim()).filter(Boolean);
const PARTS = (process.env.GEOM_PARTS ?? "ABCDFE").toUpperCase();
const READER = path.join(AUTOMATOR_ROOT, "scripts", "verify-geom-export.py");

// ── 結果の集計 ──
interface Tally { pass: number; fail: string[]; unreached: string[]; info: string[] }
const tallies = new Map<string, Tally>();
let curId = "";
function tally(): Tally {
  let t = tallies.get(curId);
  if (!t) { t = { pass: 0, fail: [], unreached: [], info: [] }; tallies.set(curId, t); }
  return t;
}
function check(cond: boolean, label: string, detail?: unknown): void {
  const t = tally();
  if (cond) { t.pass++; console.log(`  [ok  ] ${label}`); }
  else { t.fail.push(label); console.log(`  [FAIL] ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`); }
}
function unreached(label: string, why: string): void {
  tally().unreached.push(`${label}（${why}）`);
  console.log(`  [未達] ${label} — ${why}`);
}
function info(label: string, detail?: unknown): void {
  tally().info.push(label);
  console.log(`  [参考] ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
}
const log = (s: string) => console.log(`  ${s}`);

// ── truth.json ──
interface SeriesTruth {
  id: string; rows: number; cols: number; pixelSpacing: [number, number];
  iop: number[]; normal: number[]; ipps: number[][]; sops: string[]; dir: string; seriesUid: string;
  normalGapsMm: number[]; rescale: { slope: number; intercept: number };
}
interface Truth {
  field: { A: number; B: number; C: number; D: number };
  sphere: { center: number[]; radiusMm: number; addedValue: number; volumeMm3: number };
  studyUid: string;
  series: SeriesTruth[];
}
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

function makePhantom(): { dir: string; truth: Truth } {
  const dir = path.join(OUT_ROOT, "phantom");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  // UID は実行ごとに変える（同じ SOP UID の再取り込みで古いメタデータを掴まないため）。
  const seed = String(Date.now() % 1_000_000_000);
  const r = spawnSync("python3", ["-I", path.join(AUTOMATOR_ROOT, "scripts", "make-geom-verify-phantom.py"), dir, "--uid-seed", seed], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`ファントム生成に失敗: ${r.stderr}`);
  return { dir, truth: JSON.parse(fs.readFileSync(path.join(dir, "truth.json"), "utf8")) as Truth };
}

function reader(cmd: string, args: string[]): any {
  const r = spawnSync("python3", ["-I", READER, cmd, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`読み手 ${cmd} が失敗: ${r.stderr.slice(0, 800)}`);
  return JSON.parse(r.stdout);
}

// ── 画面・backend ──
async function readTextBoxLines(page: Page): Promise<string[]> {
  return page.evaluate(`
    (function () {
      var host = document.querySelector('[data-testid="${HOST}"]');
      if (!host) return [];
      var out = [];
      host.querySelectorAll("svg text").forEach(function (t) { var s = (t.textContent || "").trim(); if (s) out.push(s); });
      return out;
    })()
  `) as Promise<string[]>;
}
function numberAfter(lines: string[], re: RegExp): number | null {
  const r = new RegExp("(?:" + re.source + ")\\s*[:：]?\\s*(-?\\d+(?:\\.\\d+)?)");
  for (const l of lines) { const m = l.match(r); if (m) return Number(m[1]); }
  return null;
}
async function allHandles(page: Page): Promise<Array<{ uid: string; tool: string; points: number[][]; polyline: number[][] }>> {
  return (await page.evaluate(`window.__graphyDebug.getAnnotationCanvasPoints()`)) as Array<{ uid: string; tool: string; points: number[][]; polyline: number[][] }>;
}
async function clickMenuItem(page: Page, menu: string, nameRe: RegExp): Promise<void> {
  const re = new RegExp(nameRe.source.replace(/\^/g, "^(?:✓\\s*)?"), nameRe.flags);
  const item = page.getByRole("button", { name: re }).first();
  if (!(await item.isVisible().catch(() => false))) await page.getByTestId(`viewer2d-menu-${menu}`).click();
  try {
    await item.click({ timeout: 8000 });
  } catch (e) {
    await page.screenshot({ path: path.join(OUT_ROOT, "menu-fail.png") });
    throw e;
  }
}
async function pickTool(page: Page, labelRe: RegExp, menu: "roi" | "measure" = "roi"): Promise<void> {
  await clickMenuItem(page, menu, labelRe);
  await page.waitForTimeout(250);
}
async function clearRois(page: Page): Promise<void> {
  await clickMenuItem(page, "roi", /^(ROI を全消去|Clear ROIs)$/);
  await page.waitForTimeout(600);
  await clickMenuItem(page, "measure", /^(計測を全消去|Clear measurements)$/);
  await page.waitForTimeout(600);
}
interface VpInfo { viewportId: string; imageId: string | null }
async function viewportInfo(page: Page): Promise<VpInfo | null> {
  const v = (await page.evaluate(`window.__graphyDebug ? window.__graphyDebug.getViewportGeometry() : []`)) as VpInfo[];
  return v.find((x) => x.imageId) ?? null;
}
const sopOf = (imageId: string | null): string | null => imageId?.match(/instances\/([0-9.]+)/)?.[1] ?? null;
async function gotoSlice(page: Page, targetSop: string, sops: string[]): Promise<boolean> {
  const box = await page.locator(`[data-testid="${HOST}"] canvas`).first().boundingBox();
  if (!box) return false;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  let dir = 1, prevIdx = -1;
  for (let n = 0; n < 160; n++) {
    const vp = await viewportInfo(page);
    const cur = sopOf(vp?.imageId ?? null);
    if (cur === targetSop) return true;
    const idx = cur ? sops.indexOf(cur) : -1;
    const tIdx = sops.indexOf(targetSop);
    if (prevIdx >= 0 && idx >= 0 && Math.abs(idx - tIdx) > Math.abs(prevIdx - tIdx)) dir = -dir;
    prevIdx = idx;
    await page.mouse.wheel(0, 100 * dir);
    await page.waitForTimeout(120);
  }
  return false;
}
async function canvasGeometry(page: Page, viewportId: string) {
  return (await page.evaluate(`
    (function () {
      var host = document.querySelector('[data-testid="${HOST}"]');
      var canvas = host && host.querySelector("canvas");
      var r = canvas.getBoundingClientRect();
      var img = window.__graphyDebug.getImageCanvasRect(${JSON.stringify(viewportId)});
      return { w: r.width, h: r.height, dpr: window.devicePixelRatio, img: img };
    })()
  `)) as { w: number; h: number; dpr: number; img: number[] | null };
}

/** a.click() によるダウンロード（blob）を横取りして、ファイルとして受け取る（保存先ダイアログは出ない）。 */
async function installDownloadHook(page: Page): Promise<void> {
  await page.evaluate(`
    (function () {
      if (window.__dlHook) return;
      window.__dlHook = true; window.__dl = [];
      var orig = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () {
        if (this.download && String(this.href).indexOf("blob:") === 0) {
          var name = this.download;
          fetch(this.href).then(function (r) { return r.blob(); }).then(function (b) {
            return new Promise(function (res) {
              var fr = new FileReader();
              fr.onload = function () { window.__dl.push({ name: name, b64: String(fr.result).split(",")[1] }); res(); };
              fr.readAsDataURL(b);
            });
          });
          return;
        }
        return orig.apply(this, arguments);
      };
    })()
  `);
}
async function takeDownload(page: Page, dest: string, timeoutMs = 30_000): Promise<{ name: string; file: string } | null> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const n = (await page.evaluate(`window.__dl.length`)) as number;
    if (n > 0) {
      const d = (await page.evaluate(`window.__dl.shift()`)) as { name: string; b64: string };
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, Buffer.from(d.b64, "base64"));
      return { name: d.name, file: dest };
    }
    await page.waitForTimeout(200);
  }
  return null;
}

class Backend {
  constructor(private port: number) {}
  private url(p: string) { return `http://127.0.0.1:${this.port}${p}`; }
  async series(study: string): Promise<Array<{ seriesInstanceUid: string; modality: string | null; seriesDescription: string | null; numberOfInstances: number }>> {
    const r = await fetch(this.url(`/api/studies/${study}/series`));
    if (!r.ok) throw new Error(`series ${r.status}`);
    return (await r.json()) as never;
  }
  async instances(study: string, series: string): Promise<Array<{ sopInstanceUid: string }>> {
    const r = await fetch(this.url(`/api/studies/${study}/series/${series}/instances`));
    if (!r.ok) throw new Error(`instances ${r.status}`);
    return (await r.json()) as never;
  }
  async file(study: string, series: string, sop: string, dest: string): Promise<string> {
    const r = await fetch(this.url(`/api/studies/${study}/series/${series}/instances/${sop}/file`));
    if (!r.ok) throw new Error(`file ${r.status}`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
    return dest;
  }
  /** 新しく現れたシリーズ（既知の UID 以外）を待つ。 */
  async waitNew(study: string, known: Set<string>, timeoutMs = 25_000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const s = (await this.series(study)).filter((x) => !known.has(x.seriesInstanceUid));
      if (s.length) return s[0];
      await new Promise((r) => setTimeout(r, 400));
    }
    return null;
  }
}

// ── 1 つの幾何 ──
interface Shape {
  kind: "circle" | "ellipse" | "rect";
  tool: string;
  handles: number[][];      // canvas CSS px
  lps: number[][];          // ハンドルの LPS（truth の幾何から）
  lines: string[];          // この ROI を描いたとき新しく出た文字
  areaTruth: number;        // 解析面積 [mm²]（ハンドルの LPS から）
  perimTruth: number;
  centerLps: number[];
  bboxPxTruth: [number, number, number, number]; // ImageJ 規約（画素 i は [i, i+1]）の外接 [x0, y0, x1, y1]
  screenArea: number | null;
  screenMean: number | null;
}

async function runOne(d: DesktopDriver, dir: string, truth: Truth, s: SeriesTruth): Promise<void> {
  const outDir = path.join(OUT_ROOT, s.id);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const be = new Backend(d.ports.http);
  await resetDb(d.ports.http);
  const files = fs.readdirSync(path.join(dir, s.dir)).filter((f) => f.endsWith(".dcm")).sort().map((f) => path.join(dir, s.dir, f));
  const imp = await importPaths(d.ports.http, files);
  check(imp.imported === files.length && imp.failed === 0, `${s.id}: ${files.length} 枚を取り込めた`, imp);

  const main = d.page;
  await main.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 }).catch(async (e) => {
    await main.screenshot({ path: path.join(outDir, "main-fail.png") }).catch(() => {});
    console.log(`  [main] url=${main.url()} body=${(await main.locator("body").innerText().catch(() => "")).slice(0, 300)}`);
    throw e;
  });
  await openFirstSeriesInViewer(main, createStepRecorder());
  const viewer = await d.waitForNewPage(
    () => main.getByTestId("viewer2d-toolbar-button").click(),
    (url) => url.includes("2dviewer"),
  );
  await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 20_000 });
  await viewer.waitForTimeout(3000);
  const dialogs: string[] = [];
  viewer.on("dialog", (dlg) => { dialogs.push(dlg.message()); void dlg.accept(); });
  viewer.on("console", (m) => { if (m.type() === "error") console.log(`  [renderer error] ${m.text().slice(0, 160)}`); });
  await installDownloadHook(viewer);

  // ROI マネージャを先に開く（パネルが出ると canvas の大きさが変わるので、幾何の測定より前）。
  await viewer.getByTestId("viewer2d-menu-roiTools").click();
  await viewer.getByRole("button", { name: /ROI マネージャ|ROI manager/i }).first().click();
  await viewer.waitForTimeout(800);
  await viewer.keyboard.press("Escape").catch(() => {});

  // ── 真値の幾何 ──
  const [rowMm0, colMm0] = s.pixelSpacing;
  const swap = NEG === "swap";
  const [rowMm, colMm] = swap ? [colMm0, rowMm0] : [rowMm0, colMm0];
  const rc = s.iop.slice(0, 3), rr = s.iop.slice(3);
  const c = truth.sphere.center, R = truth.sphere.radiusMm;
  let best = 0, bestD = Infinity;
  s.ipps.forEach((ipp, k) => {
    const dd = Math.abs(dot(sub(c, ipp), s.normal));
    if (dd < bestD) { bestD = dd; best = k; }
  });
  const dN = dot(sub(c, s.ipps[best]), s.normal);
  const rp = Math.sqrt(R * R - dN * dN);
  const pc = [0, 1, 2].map((k) => c[k] - dN * s.normal[k]);
  const rel = sub(pc, s.ipps[best]);
  const colIdx = dot(rel, rc) / colMm0;
  const rowIdx = dot(rel, rr) / rowMm0;

  const gotOk = await gotoSlice(viewer, s.sops[best], s.sops);
  check(gotOk, `${s.id}: 目的のスライス（${best} 番）を表示できた`);
  if (!gotOk) return;
  await viewer.waitForTimeout(600);
  const sliderIdx = Number(await viewer.getByTestId("dim-slider-z").inputValue().catch(() => "NaN"));
  const sliderMin = Number((await viewer.getByTestId("dim-slider-z").getAttribute("min").catch(() => "0")) ?? "0");

  const vp = await viewportInfo(viewer);
  const cg = await canvasGeometry(viewer, vp!.viewportId);
  if (!cg.img) { check(false, `${s.id}: 画像の canvas 上の範囲が取れる`, cg); return; }
  const [ix0, iy0, ix1, iy1] = cg.img;
  const pxPerMmX = (ix1 - ix0) / (s.cols * colMm), pxPerMmY = (iy1 - iy0) / (s.rows * rowMm);
  const pxPerMm = (pxPerMmX + pxPerMmY) / 2;
  log(`canvas ${cg.w.toFixed(0)}×${cg.h.toFixed(0)} px/mm x=${pxPerMmX.toFixed(3)} y=${pxPerMmY.toFixed(3)}`);
  const tolMm = 1.0 / pxPerMm; // ポインタ座標の丸め 1 CSS px
  const cx = ix0 + (colIdx + 0.5) * colMm * pxPerMmX;
  const cy = iy0 + (rowIdx + 0.5) * rowMm * pxPerMmY;
  const rPx = rp * pxPerMm;
  const frac = (x: number, y: number) => ({ fracX: x / cg.w, fracY: y / cg.h });
  const canvasToLps = (x: number, y: number) => {
    const ci = (x - ix0) / (colMm * pxPerMmX) - 0.5;
    const rj = (y - iy0) / (rowMm * pxPerMmY) - 0.5;
    return [0, 1, 2].map((k) => s.ipps[best][k] + ci * colMm0 * rc[k] + rj * rowMm0 * rr[k]);
  };
  const lpsDist = (p: number[], q: number[]) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
  // ImageJ 規約の画素座標（画素 i が [i, i+1]。画像の左上が 0）
  const toIj = (x: number, y: number): [number, number] => [(x - ix0) / (colMm * pxPerMmX), (y - iy0) / (rowMm * pxPerMmY)];
  const mean = (ps: number[][]) => [0, 1, 2].map((k) => ps.reduce((a, p) => a + p[k], 0) / ps.length);

  // ── 2D の ROI を描く（円・楕円・矩形。互いに重ならない位置）──
  await clearRois(viewer);
  const shapes: Shape[] = [];
  const specs: Array<{ kind: Shape["kind"]; re: RegExp; dx: number; dy: number; x0: number; y0: number }> = [
    { kind: "circle", re: /^円 ROI$|^Circle ROI$/, dx: 0.7 * rPx, dy: 0, x0: cx, y0: cy },
    { kind: "ellipse", re: /楕円 ROI|Ellipse ROI/, dx: 1.0 * rPx, dy: 0.6 * rPx, x0: ix0 + (132 + 0.5) * colMm * pxPerMmX, y0: iy0 + (55 + 0.5) * rowMm * pxPerMmY },
    { kind: "rect", re: /矩形 ROI|Rectangle ROI/, dx: 1.2 * rPx, dy: 0.8 * rPx, x0: cx + 1.3 * rPx, y0: cy - 0.5 * rPx },
  ];
  let seenLines: string[] = [];
  for (const sp of specs) {
    const nBefore = (await allHandles(viewer)).length;
    await pickTool(viewer, sp.re, "roi");
    await dragOnCanvasHost(viewer, HOST, sp.dx, sp.dy, 0, 10, frac(sp.x0, sp.y0));
    await viewer.waitForTimeout(1500);
    const hs = await allHandles(viewer);
    const lines = await readTextBoxLines(viewer);
    const fresh = lines.filter((l) => { const i = seenLines.indexOf(l); if (i >= 0) { seenLines.splice(i, 1); return false; } return true; });
    seenLines = [...lines];
    const h = hs.length > nBefore ? hs[hs.length - 1] : null;
    if (!h || h.points.length < 2) { check(false, `${s.id}: ${sp.kind} を描けた`, { nBefore, n: hs.length }); continue; }
    const lps = h.points.map((p) => canvasToLps(p[0], p[1]));
    let area = 0, perim = 0, ctr = mean(lps);
    let ijpts: number[][] = h.points;
    if (sp.kind === "circle") {
      const r = lpsDist(lps[0], lps[1]);
      area = Math.PI * r * r; perim = 2 * Math.PI * r; ctr = lps[0];
      const rpx = Math.hypot(h.points[1][0] - h.points[0][0], h.points[1][1] - h.points[0][1]);
      // mm 空間の真円は、画面（等方）でも真円。外接は中心 ± r（画素単位では列 r/colMm・行 r/rowMm）。
      const e: number[][] = [[h.points[0][0] - rpx, h.points[0][1] - rpx], [h.points[0][0] + rpx, h.points[0][1] + rpx]];
      ijpts = e;
    } else if (sp.kind === "ellipse") {
      const [bt, tp, lf, rt] = lps;
      const a = lpsDist(lf, rt) / 2, b = lpsDist(bt, tp) / 2;
      area = Math.PI * a * b;
      perim = Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b))); // Ramanujan（楕円の周長の近似。相対誤差 ~1e-5 未満の離心率）
    } else {
      const xs = h.points.map((p) => p[0]), ys = h.points.map((p) => p[1]);
      const w = (Math.max(...xs) - Math.min(...xs)) / pxPerMm, hh = (Math.max(...ys) - Math.min(...ys)) / pxPerMm;
      area = w * hh; perim = 2 * (w + hh);
    }
    const xsI = ijpts.map((p) => toIj(p[0], p[1])[0]), ysI = ijpts.map((p) => toIj(p[0], p[1])[1]);
    shapes.push({
      kind: sp.kind, tool: h.tool, handles: h.points, lps, lines: fresh, areaTruth: area, perimTruth: perim, centerLps: ctr,
      bboxPxTruth: [Math.min(...xsI), Math.min(...ysI), Math.max(...xsI), Math.max(...ysI)],
      screenArea: numberAfter(fresh, /面積|Area/), screenMean: numberAfter(fresh, /平均|Mean/),
    });
    log(`${sp.kind}（${h.tool}）: 解析面積 ${area.toFixed(3)} mm² / 画面の面積 ${numberAfter(fresh, /面積|Area/)} mm² / 画面の平均 ${numberAfter(fresh, /平均|Mean/)}`);
  }
  await viewer.screenshot({ path: path.join(outDir, "rois.png") });
  const circleMeanTruth = (() => {
    const f = truth.field;
    const cl = shapes.find((x) => x.kind === "circle");
    if (!cl) return null;
    // 円は球の断面の内側（半径 0.7 rp、中心 = 断面中心の近く）。線形の場の円内平均は中心での値。
    const ctr = cl.centerLps;
    const insideSphere = lpsDist(ctr, c) + 0.7 * rp <= R;
    return { v: f.A * ctr[0] + f.B * ctr[1] + f.C * ctr[2] + f.D + (insideSphere ? truth.sphere.addedValue : 0), insideSphere };
  })();

  // ═══ B. RTSTRUCT ═══
  if (PARTS.includes("B") && shapes.length) {
    console.log(`\n--- B. RTSTRUCT 書き出し（${s.id}）---`);
    const known = new Set((await be.series(truth.studyUid)).map((x) => x.seriesInstanceUid));
    await viewer.getByTestId("roi-mgr-export-rt").click();
    const ns = await be.waitNew(truth.studyUid, known);
    if (!ns) { unreached(`${s.id}: RTSTRUCT 書き出し`, `新しいシリーズが現れない（ダイアログ: ${JSON.stringify(dialogs.slice(-2))}）`); }
    else {
      check(ns.modality === "RTSTRUCT", `${s.id}: 書き出されたシリーズが RTSTRUCT`, ns);
      const ins = await be.instances(truth.studyUid, ns.seriesInstanceUid);
      const f = await be.file(truth.studyUid, ns.seriesInstanceUid, ins[0].sopInstanceUid, path.join(outDir, "export.rtstruct.dcm"));
      const rt = reader("rt", ["--file", f, "--truth", path.join(OUT_ROOT, "phantom", "truth.json"), "--series", s.id, ...(NEG && !swap ? ["--neg", NEG] : swap ? ["--neg", "swap"] : [])]);
      for (const v of rt.verdicts as Array<{ name: string; status: string; detail: unknown }>) check(v.status === "pass", v.name, v.detail);
      check(rt.rois.length === shapes.length, `${s.id}: RTSTRUCT の ROI 数 = 描いた数`, { rt: rt.rois.length, drawn: shapes.length });
      const used = new Set<number>();
      for (const sh of shapes) {
        // 重心が最も近い ROI を対応づける（並び順に頼らない）
        let bi = -1, bd = Infinity;
        rt.rois.forEach((r: any, i: number) => {
          if (used.has(i) || !r.contours.length) return;
          const dd = lpsDist(r.contours[0].centroid_lps, sh.centerLps);
          if (dd < bd) { bd = dd; bi = i; }
        });
        if (bi < 0) { check(false, `${s.id}: ${sh.kind} に対応する RTSTRUCT の ROI がある`); continue; }
        used.add(bi);
        const cont = rt.rois[bi].contours[0];
        const nPoly = cont.n;
        const expectArea = sh.kind === "rect" ? sh.areaTruth : (nPoly / 2) * (sh.areaTruth / Math.PI) * Math.sin((2 * Math.PI) / nPoly) * (sh.kind === "circle" ? 1 : 1);
        // 円・楕円は n 角形の内接近似（面積は π r² の sin(2π/n)·n/(2π) 倍）。楕円も同じ係数（アフィン変換で保たれる）。
        const tolRel = 2.5e-3 + 4 * tolMm / Math.sqrt(sh.areaTruth); // 画素 1 px の丸め由来（辺長 ≈ √面積 に対する）
        const rtA = cont.area_inplane_mm2 as number;
        info(`${s.id}: ${sh.kind} 面積 解析 ${sh.areaTruth.toFixed(3)} / RT(面内射影) ${rtA.toFixed(3)} / RT(3D ベクトル) ${cont.area_vec_mm2.toFixed(3)} / 画面 ${sh.screenArea}`,
          { ratioRtToAnalytic: rtA / sh.areaTruth, ratioScreenToAnalytic: sh.screenArea != null ? sh.screenArea / sh.areaTruth : null });
        check(Math.abs(rtA - expectArea) / expectArea <= tolRel, `${s.id}: RTSTRUCT ${sh.kind} の面積（面内射影のシューレース）が解析面積（n 角形補正）と一致`, { rt: rtA, expect: expectArea, analytic: sh.areaTruth, tolRel });
        check(Math.abs(cont.area_vec_mm2 - rtA) <= 1e-3 * rtA, `${s.id}: RTSTRUCT ${sh.kind} の輪郭が平面（3D ベクトル面積 = 面内射影面積）`, { vec: cont.area_vec_mm2, plane: rtA, offplane: cont.offplane_mm_max });
        check(sh.screenArea == null || Math.abs(rtA - sh.screenArea) / sh.screenArea <= tolRel + 2e-3, `${s.id}: RTSTRUCT ${sh.kind} の面積が画面の統計の面積と一致`, { rt: rtA, screen: sh.screenArea });
        check(lpsDist(cont.centroid_lps, sh.centerLps) <= 2 * tolMm, `${s.id}: RTSTRUCT ${sh.kind} の重心 = ROI の中心（LPS）`, { rt: cont.centroid_lps, truth: sh.centerLps, errMm: lpsDist(cont.centroid_lps, sh.centerLps) });
        check(cont.slice === best, `${s.id}: RTSTRUCT ${sh.kind} の参照 SOP = 描いたスライス`, { slice: cont.slice, best });
        check(cont.type === "CLOSED_PLANAR", `${s.id}: RTSTRUCT ${sh.kind} の ContourGeometricType = CLOSED_PLANAR`, cont.type);
        check(cont.offplane_mm_max <= 1e-3 + 2 * tolMm * 0, `${s.id}: RTSTRUCT ${sh.kind} の全点が参照スライスの面上（法線方向 ≤ 1e-3 mm）`, cont.offplane_mm_max);
      }
    }
  }

  // ═══ C. ImageJ ═══
  let ijPosOk: boolean | null = null;
  if (PARTS.includes("C") && shapes.length) {
    console.log(`\n--- C. ImageJ 書き出し（${s.id}）---`);
    await viewer.getByRole("button", { name: /^IJ ⬇$/ }).click();
    const dl = await takeDownload(viewer, path.join(outDir, "export.RoiSet.zip"));
    if (!dl) unreached(`${s.id}: ImageJ 書き出し`, `ダウンロードが捕捉できない（ダイアログ: ${JSON.stringify(dialogs.slice(-2))}）`);
    else {
      log(`ダウンロード名: ${dl.name}`);
      const ij = reader("ij", ["--file", dl.file]);
      check(ij.rois.length === shapes.length, `${s.id}: ImageJ の ROI 数 = 描いた数`, { ij: ij.rois.length, drawn: shapes.length });
      const wantType: Record<string, string> = { circle: "oval", ellipse: "oval", rect: "rect" };
      const taken = new Set<number>();
      for (const sh of shapes) {
        const cands = ij.rois.map((r: any, i: number) => ({ r, i })).filter((x: any) => !taken.has(x.i) && x.r.type === wantType[sh.kind]);
        // 外接の中心が近いものを対応づける
        const [bx0, by0, bx1, by1] = sh.bboxPxTruth;
        let pick: any = null, pd = Infinity;
        for (const x of cands) {
          const b = x.r.bbox_int;
          const dd = Math.hypot((b.left + b.right) / 2 - (bx0 + bx1) / 2, (b.top + b.bottom) / 2 - (by0 + by1) / 2);
          if (dd < pd) { pd = dd; pick = x; }
        }
        if (!pick) { check(false, `${s.id}: ImageJ に ${sh.kind}（${wantType[sh.kind]}）の ROI がある`, { types: ij.rois.map((r: any) => r.type) }); continue; }
        taken.add(pick.i);
        const b = pick.r.bbox_int;
        // 円は mm 空間の真円なので、画素空間では 列方向 r/colMm0・行方向 r/rowMm0 の楕円。truth の外接は中心 ± r（画素単位）。
        let exp: [number, number, number, number] = sh.bboxPxTruth;
        if (sh.kind === "circle") {
          const r = lpsDist(sh.lps[0], sh.lps[1]);
          const [ccx, ccy] = toIj(sh.handles[0][0], sh.handles[0][1]);
          exp = [ccx - r / colMm, ccy - r / rowMm, ccx + r / colMm, ccy + r / rowMm];
        }
        const tolPx = 1.0 + 1.0 / Math.min(pxPerMmX * colMm, pxPerMmY * rowMm); // 整数への丸め 1 px ＋ ポインタ 1 CSS px
        const got = [b.left, b.top, b.right, b.bottom];
        const errs = got.map((v, i) => Math.abs(v - exp[i]));
        info(`${s.id}: ${sh.kind} の外接 bbox（画素）ImageJ ${JSON.stringify(got)} / 期待 ${JSON.stringify(exp.map((v) => +v.toFixed(2)))}`, { w: b.width, h: b.height, expW: exp[2] - exp[0], expH: exp[3] - exp[1], sub: pick.r.bbox_sub });
        check(Math.max(...errs) <= tolPx, `${s.id}: ImageJ ${sh.kind} の bbox が ROI の外接 bbox と一致（±${tolPx.toFixed(2)} px）`, { got, expect: exp, errs, type: pick.r.type });
        ijPosOk = pick.r.position === sliderIdx - sliderMin + 1;
        check(ijPosOk, `${s.id}: ImageJ ${sh.kind} の position = 表示スタックの何枚目（1 始まり）`, { position: pick.r.position, slider: sliderIdx, sliderMin });
      }
    }
  }

  // ═══ D. CSV ═══
  let csvRows: any[] = [];
  if (PARTS.includes("D") || PARTS.includes("F")) {
    console.log(`\n--- D. 統計 CSV（${s.id}）---`);
    await viewer.getByTestId("roi-mgr-stats-all").click();
    await viewer.getByTestId("roi-stats-dialog").waitFor({ state: "visible", timeout: 15_000 });
    await viewer.waitForTimeout(2500);
    const table = (await viewer.evaluate(`
      (function () {
        var rows = [];
        document.querySelectorAll('[data-testid="roi-stats-dialog"] tbody tr').forEach(function (tr) {
          rows.push(Array.prototype.map.call(tr.querySelectorAll("td"), function (td) { return (td.textContent || "").trim(); }));
        });
        return rows;
      })()
    `)) as string[][];
    await viewer.screenshot({ path: path.join(outDir, "stats-dialog.png") });
    await viewer.getByRole("button", { name: /⬇ CSV/ }).click();
    const dl = await takeDownload(viewer, path.join(outDir, "export.roi-stats.csv"));
    if (!dl) unreached(`${s.id}: CSV 書き出し`, "ダウンロードが捕捉できない");
    else {
      const cv = reader("csv", ["--file", dl.file]);
      csvRows = cv.rows;
      log(`CSV 見出し: ${cv.header.join("|")}`);
      check(csvRows.length === shapes.length, `${s.id}: CSV の行数 = ROI 数`, { csv: csvRows.length, shapes: shapes.length });
      const pxArea = rowMm0 * colMm0;
      csvRows.forEach((row, i) => {
        const sh = shapes.find((x) => x.tool === row.tool) ?? shapes[i];
        const a = Number(row["area[mm2]"]), apx = Number(row["area[px2]"]);
        const meanKey = Object.keys(row).find((k) => k.startsWith("mean")) ?? "mean";
        const mean = Number(row[meanKey]);
        const tolA = 2e-3;
        info(`${s.id}: CSV ${row.tool}: area[mm2]=${row["area[mm2]"]} area[px2]=${row["area[px2]"]} perimeter=${row.perimeter} lengthUnit=${row.lengthUnit} ${meanKey}=${row[meanKey]} / 解析 ${sh.areaTruth.toFixed(3)} mm²`, { ratioCsvToAnalytic: a / sh.areaTruth });
        check(sh.screenArea != null && Math.abs(a - sh.screenArea) <= 0.0051 + 1e-6, `${s.id}: CSV ${row.tool} の area[mm2] = 画面の面積`, { csv: a, screen: sh.screenArea });
        check(Math.abs(a - sh.areaTruth) / sh.areaTruth <= tolA, `${s.id}: CSV ${row.tool} の area[mm2] = 解析面積（ハンドルから）`, { csv: a, truth: sh.areaTruth, ratio: a / sh.areaTruth });
        check(Math.abs(apx - sh.areaTruth / pxArea) / (sh.areaTruth / pxArea) <= tolA, `${s.id}: CSV ${row.tool} の area[px2] = 解析面積 ÷ (行間隔×列間隔)`, { csv: apx, truth: sh.areaTruth / pxArea, ratio: apx / (sh.areaTruth / pxArea) });
        check(sh.screenMean != null && Math.abs(mean - sh.screenMean) <= 0.0051, `${s.id}: CSV ${row.tool} の ${meanKey} = 画面の平均`, { csv: mean, screen: sh.screenMean });
        const per = Number(row.perimeter);
        const perRel = Math.abs(per - sh.perimTruth) / sh.perimTruth;
        info(`${s.id}: CSV ${row.tool} の perimeter ${per}（lengthUnit=${row.lengthUnit}）/ 解析周長 ${sh.perimTruth.toFixed(3)} mm`, { rel: perRel, header: "perimeter" });
        if (row.lengthUnit === "mm") check(perRel <= 5e-3, `${s.id}: CSV ${row.tool} の perimeter（lengthUnit=mm）が解析周長と一致`, { csv: per, truth: sh.perimTruth, ratio: per / sh.perimTruth });
        else check(false, `${s.id}: CSV ${row.tool} の lengthUnit が mm（校正済み画像）`, row.lengthUnit);
        // 画面の表（ダイアログ）の面積と CSV
        const tr = table[i];
        if (tr) log(`ダイアログの表 ${i + 1} 行目: ${JSON.stringify(tr)}`);
        if (sh.kind === "circle" && circleMeanTruth?.insideSphere) {
          const grad = Math.abs(truth.field.A) * colMm0 + Math.abs(truth.field.B) * rowMm0;
          check(Math.abs(mean - circleMeanTruth.v) <= grad + s.rescale.slope / 2 + 0.2, `${s.id}: CSV 円の平均 = 中心での場の値 + 球の加算値（${circleMeanTruth.v.toFixed(2)}）`, { csv: mean, truth: circleMeanTruth.v });
        }
      });
    }
    await closeStats(viewer);
  }

  // ═══ F. 2D ROI → SEG（マスク化）の面積 ═══
  const segAreas: Array<{ kind: string; maskAreaMm2: number; rtArea?: number }> = [];
  if (PARTS.includes("F") && shapes.length) {
    console.log(`\n--- F. 2D ROI の SEG 書き出し（マスク化）の面積（${s.id}）---`);
    const rowsLoc = viewer.locator('[data-testid="roi-row"][data-kind="shape"]');
    const n = await rowsLoc.count();
    log(`ROI 行 ${n}`);
    for (let i = 0; i < n; i++) {
      const known = new Set((await be.series(truth.studyUid)).map((x) => x.seriesInstanceUid));
      const btn = rowsLoc.nth(i).getByTestId("roi-row-export-seg");
      if (!(await btn.count())) { unreached(`${s.id}: ROI 行 ${i} の SEG 書き出し`, "行に SEG ボタンが無い"); continue; }
      await btn.click();
      const ns = await be.waitNew(truth.studyUid, known);
      if (!ns) { unreached(`${s.id}: ROI 行 ${i} の SEG 書き出し`, `新しいシリーズが現れない（${JSON.stringify(dialogs.slice(-1))}）`); continue; }
      const ins = await be.instances(truth.studyUid, ns.seriesInstanceUid);
      const f = await be.file(truth.studyUid, ns.seriesInstanceUid, ins[0].sopInstanceUid, path.join(outDir, `export.roi${i}.seg.dcm`));
      const sc = reader("segcount", ["--file", f, "--truth", path.join(OUT_ROOT, "phantom", "truth.json"), "--series", s.id, ...(NEG ? ["--neg", NEG] : [])]);
      const desc = ns.seriesDescription ?? "";
      const sh = shapes.find((x) => desc.toLowerCase().includes(x.tool.toLowerCase())) ??
        shapes.reduce((a, b) => (sc.centroid_lps && lpsDist(sc.centroid_lps, a.centerLps) < lpsDist(sc.centroid_lps, b.centerLps) ? a : b));
      const per = sh.perimTruth, edge = Math.max(rowMm0, colMm0);
      const bound = (per * edge) / 2;
      info(`${s.id}: ${sh.kind} の SEG（${desc}）画素数 ${sc.count} → 面積 ${sc.area_mm2.toFixed(2)} mm² / 解析 ${sh.areaTruth.toFixed(2)} / 画面 ${sh.screenArea}`, { ratio: sc.area_mm2 / sh.areaTruth, slices: sc.slices });
      check(Math.abs(sc.area_mm2 - sh.areaTruth) <= bound, `${s.id}: ${sh.kind} の SEG（画素数×画素面積）が解析面積と一致（周長×最大辺/2）`, { seg: sc.area_mm2, truth: sh.areaTruth, bound });
      check(sc.centroid_lps && lpsDist(sc.centroid_lps, sh.centerLps) <= edge, `${s.id}: ${sh.kind} の SEG の重心 = ROI の中心（≤ 1 画素）`, { seg: sc.centroid_lps, truth: sh.centerLps });
      check(sc.slices.length === 1 && sc.slices[0] === best, `${s.id}: ${sh.kind} の SEG が描いたスライスだけに前景を持つ`, { slices: sc.slices, best });
      segAreas.push({ kind: sh.kind, maskAreaMm2: sc.area_mm2 });
    }
  }

  // ═══ F. 経路間の同値の表 ═══
  if (PARTS.includes("F") && shapes.length) {
    console.log(`\n--- F. 同じ ROI の面積 [mm²] の経路間比較（${s.id}）---`);
    const rtj = fs.existsSync(path.join(outDir, "export.rtstruct.dcm"))
      ? reader("rt", ["--file", path.join(outDir, "export.rtstruct.dcm"), "--truth", path.join(OUT_ROOT, "phantom", "truth.json"), "--series", s.id]) : null;
    const table: any[] = [];
    for (const sh of shapes) {
      const row: any = { shape: sh.kind, analytic: +sh.areaTruth.toFixed(3), screenStats: sh.screenArea };
      const cr = csvRows.find((r) => r.tool === sh.tool);
      row.csv = cr ? Number(cr["area[mm2]"]) : null;
      row.csvPx2xPixelArea = cr ? +(Number(cr["area[px2]"]) * rowMm0 * colMm0).toFixed(3) : null;
      if (rtj) {
        let bi = -1, bd = Infinity;
        rtj.rois.forEach((r: any, i: number) => { if (!r.contours.length) return; const dd = lpsDist(r.contours[0].centroid_lps, sh.centerLps); if (dd < bd) { bd = dd; bi = i; } });
        row.rtstruct = bi >= 0 ? +rtj.rois[bi].contours[0].area_inplane_mm2.toFixed(3) : null;
      } else row.rtstruct = null;
      row.maskPixelsXarea = segAreas.find((x) => x.kind === sh.kind)?.maskAreaMm2 ?? null;
      for (const k of ["screenStats", "csv", "csvPx2xPixelArea", "rtstruct", "maskPixelsXarea"]) row[`${k}/analytic`] = row[k] != null ? +(row[k] / sh.areaTruth).toFixed(4) : null;
      table.push(row);
    }
    console.table(table);
    fs.writeFileSync(path.join(outDir, "area-equivalence.json"), JSON.stringify(table, null, 1));
    for (const row of table) {
      // 画面の統計・CSV・px2×画素面積は同じ量のはず（同じ計算結果の別の読み口）
      if (row.screenStats != null && row.csv != null) check(Math.abs(row.screenStats - row.csv) <= 0.0051, `${s.id}: ${row.shape} 面積 画面 = CSV`, row);
      if (row.csv != null && row.csvPx2xPixelArea != null) check(Math.abs(row.csv - row.csvPx2xPixelArea) / row.csv <= 2e-3, `${s.id}: ${row.shape} 面積 CSV の mm2 = px2 × 画素面積`, row);
    }
  }

  // ═══ A. SEG 書き出し（3D の球）═══
  if (PARTS.includes("A")) {
    console.log(`\n--- A. SEG 書き出し（球の 3D ROI → 焼き込み → SEG）（${s.id}）---`);
    await clearRois(viewer);
    // 製品の経路: 円 ROI → ◎（球の 3D ROI を作る。scope が入る）。中心・半径は欄に truth の値を打ち直す。
    // （DEV 限定の seedSphere3D は scope（study/series UID）が空文字になり、SEG 書き出しが "scope" で失敗するので使わない）
    await pickTool(viewer, /^円 ROI$|^Circle ROI$/, "roi");
    await dragOnCanvasHost(viewer, HOST, 0.8 * rPx, 0, 0, 10, frac(cx, cy));
    await viewer.waitForTimeout(1200);
    await viewer.getByTestId("roi-mgr-define-sphere").first().click();
    await viewer.waitForTimeout(800);
    const typeVal = async (testid: string, v: number) => {
      const f = viewer.getByTestId(testid);
      await f.fill(String(v));
      await f.press("Enter");
      await viewer.waitForTimeout(300);
    };
    await typeVal("sphere-center-x", c[0]);
    await typeVal("sphere-center-y", c[1]);
    await typeVal("sphere-center-z", c[2]);
    await typeVal("sphere-radius", R);
    log(`球の欄: ${JSON.stringify([await viewer.getByTestId("sphere-center-x").inputValue(), await viewer.getByTestId("sphere-center-y").inputValue(), await viewer.getByTestId("sphere-center-z").inputValue(), await viewer.getByTestId("sphere-radius").inputValue()])} / truth ${JSON.stringify(c)} R=${R}`);
    const sph = viewer.locator('[data-testid="roi-row"][data-kind="sphere"]');
    check((await sph.count()) === 1, `${s.id}: 球の 3D ROI の行ができた`, await sph.count());
    if ((await sph.count()) === 1) {
      await viewer.getByTestId("sphere-bake").click();
      await viewer.waitForTimeout(3500);
      const painted = viewer.locator('[data-testid="roi-row"][data-kind="painted"]');
      log(`焼き込み後の塗り行 ${await painted.count()}: ${JSON.stringify(await painted.evaluateAll((els) => els.map((e) => (e.querySelector("input[type=text]") as HTMLInputElement | null)?.value)))}`);
      const segBtn = painted.last().getByRole("button", { name: /^SEG ⬇$/ });
      if (!(await segBtn.count())) unreached(`${s.id}: 球の SEG 書き出し`, "焼き込み後に SEG ボタンが無い");
      else {
        const known = new Set((await be.series(truth.studyUid)).map((x) => x.seriesInstanceUid));
        await segBtn.click();
        const ns = await be.waitNew(truth.studyUid, known);
        if (!ns) unreached(`${s.id}: 球の SEG 書き出し`, `新しいシリーズが現れない（${JSON.stringify(dialogs.slice(-2))}）`);
        else {
          check(ns.modality === "SEG", `${s.id}: 書き出されたシリーズが SEG`, ns);
          const ins = await be.instances(truth.studyUid, ns.seriesInstanceUid);
          const f = await be.file(truth.studyUid, ns.seriesInstanceUid, ins[0].sopInstanceUid, path.join(outDir, "export.sphere.seg.dcm"));
          const sg = reader("seg", ["--file", f, "--truth", path.join(OUT_ROOT, "phantom", "truth.json"), "--series", s.id, ...(NEG ? ["--neg", NEG] : [])]);
          for (const v of sg.verdicts as Array<{ name: string; status: string; detail: unknown }>) {
            if (v.status === "info") info(`${s.id}: ${v.name}`, v.detail);
            else check(v.status === "pass", `${s.id}: ${v.name}`, v.detail);
          }
          fs.writeFileSync(path.join(outDir, "seg-measure.json"), JSON.stringify(sg, null, 1));
          log(`間隔の記録: ${JSON.stringify(sg.spacing)}`);
          void painted;
        }
      }
    }
  }
  await viewer.screenshot({ path: path.join(outDir, "final.png") }).catch(() => {});

  // ═══ E. 取り込み ═══
  if (PARTS.includes("E")) await partE(d, viewer, be, dir, truth, s, outDir, { shapes, best, sliderIdx, ix0, iy0, colMm, rowMm, pxPerMmX, pxPerMmY, canvasToLps, dialogs });
  await viewer.close().catch(() => {});
}

interface EEnv {
  shapes: Shape[]; best: number; sliderIdx: number; ix0: number; iy0: number; colMm: number; rowMm: number; pxPerMmX: number; pxPerMmY: number;
  canvasToLps: (x: number, y: number) => number[]; dialogs: string[];
}

async function partE(d: DesktopDriver, viewer: Page, be: Backend, dir: string, truth: Truth, s: SeriesTruth, outDir: string, env: EEnv): Promise<void> {
  console.log(`\n--- E. 取り込み（${s.id}）---`);
  const tj = path.join(OUT_ROOT, "phantom", "truth.json");
  const seed = Number(Date.now() % 1_000_000_000);
  const other = "g2_oblique";
  const [rowMm0, colMm0] = s.pixelSpacing;
  const lpsDist = (p: number[], q: number[]) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
  const cases: Array<{ name: string; mode: string; extra: string[]; expectOk: "place" | "reject" }> = [
    { name: "correct", mode: "correct", extra: [], expectOk: "place" },
    { name: "shift4", mode: "shift", extra: ["--shift", "4"], expectOk: "reject" },
  ];
  if (s.id !== other) cases.push({ name: "wrongseries", mode: "wrongseries", extra: ["--other", other], expectOk: "reject" });
  const made: string[] = [];
  cases.forEach((cs, i) => {
    const out = path.join(outDir, `in-${cs.name}.seg.dcm`);
    const r = reader("make-seg", ["--truth", tj, "--series", s.id, "--out", out, "--mode", cs.mode, "--desc", `E-${cs.name}`, "--uid-seed", String(seed + i), "--source-dir", dir, ...cs.extra]);
    made.push(out);
    log(`入力 SEG ${cs.name}: ${JSON.stringify(r)}`);
  });
  const rtOut = path.join(outDir, "in-circle.rtstruct.dcm");
  const rm = reader("make-rt", ["--truth", tj, "--series", s.id, "--out", rtOut, "--desc", "E-rt", "--uid-seed", String(seed + 77), "--source-dir", dir]);
  log(`入力 RTSTRUCT: ${JSON.stringify(rm)}`);
  const imp = await importPaths(d.ports.http, [...made, rtOut]);
  check(imp.imported === made.length + 1 && imp.failed === 0, `${s.id}: 入力 SEG ${made.length} 件・RTSTRUCT 1 件を DB へ取り込めた`, imp);
  const modal = (await be.series(truth.studyUid)).map((x) => `${x.modality}:${x.seriesDescription}`);
  log(`DB のシリーズ: ${JSON.stringify(modal)}`);

  // 既定のまま（SEG ⬆ → RT ⬆）。ダイアログ・トーストの文言も記録する。
  const before = (await viewer.evaluate(`window.__graphyDebug.getSegmentationIds()`)) as string[];
  env.dialogs.length = 0;
  await viewer.getByRole("button", { name: /^SEG ⬆$/ }).click();
  // トースト（取り込み完了・拒否の通知）は dialog ではなく DOM に出る。消える前に読む。
  let toastText = "";
  for (let k = 0; k < 28 && !toastText; k++) {
    await viewer.waitForTimeout(250);
    toastText = (await viewer.evaluate(`(function(){var t=document.body.innerText||"";var m=t.match(/[^\\n]*(取り込めませんでした|was not imported|were not imported)[^\\n]*/);return m?m[0]:"";})()`)) as string;
  }
  await viewer.waitForTimeout(6000);
  const mid = (await viewer.evaluate(`window.__graphyDebug.getSegmentationIds()`)) as string[];
  const dSeg = [...env.dialogs, ...(toastText ? [`toast: ${toastText}`] : [])];
  log(`SEG 取り込みで増えたマスク ${mid.filter((x) => !before.includes(x)).length} 件 / ダイアログ ${JSON.stringify(dSeg)}`);
  env.dialogs.length = 0;
  await viewer.getByRole("button", { name: /^RT ⬆$/ }).click();
  await viewer.waitForTimeout(7000);
  const aft = (await viewer.evaluate(`window.__graphyDebug.getSegmentationIds()`)) as string[];
  const dRt = [...env.dialogs];
  log(`RT 取り込みで増えたマスク ${aft.filter((x) => !mid.includes(x)).length} 件 / ダイアログ ${JSON.stringify(dRt)}`);
  await viewer.screenshot({ path: path.join(outDir, "import.png") });

  // 取り込まれた各マスクを ROI 統計のダイアログからボクセル CSV として取り出し、truth の格子で位置を測る。
  await viewer.getByTestId("roi-mgr-stats-all").click();
  await viewer.getByTestId("roi-stats-dialog").waitFor({ state: "visible", timeout: 15_000 });
  await viewer.waitForTimeout(3500);
  const trs = viewer.locator('[data-testid="roi-stats-dialog"] tbody tr');
  const nTr = await trs.count();
  const labels: string[] = [];
  for (let i = 0; i < nTr; i++) labels.push(((await trs.nth(i).locator("td").nth(1).textContent()) ?? "").trim());
  log(`統計ダイアログの行: ${JSON.stringify(labels)}`);
  const results: Record<string, any> = {};
  for (let i = 0; i < nTr; i++) {
    const lab = labels[i];
    if (!lab || lab === "Sphere") continue;
    await trs.nth(i).click();
    await viewer.waitForTimeout(700);
    const dumpBtn = viewer.getByTestId("roi-stats-dump");
    if (await dumpBtn.isDisabled().catch(() => true)) { results[lab] = { empty: true }; continue; }
    await dumpBtn.click();
    const dl = await takeDownload(viewer, path.join(outDir, `import-${lab.replace(/[^A-Za-z0-9_-]/g, "_")}.voxels.csv`));
    results[lab] = dl ? reader("maskdump", ["--file", dl.file, "--truth", tj, "--series", s.id]) : { noDump: true };
  }
  await closeStats(viewer);
  fs.writeFileSync(path.join(outDir, "import-results.json"), JSON.stringify({ labels, results, dialogsSeg: dSeg, dialogsRt: dRt }, null, 1));

  const maxEdge = Math.max(s.pixelSpacing[0], s.pixelSpacing[1], ...s.normalGapsMm);
  const px = rowMm0 * colMm0;
  // ── E1 SEG: 取り込み ──
  for (const cs of cases) {
    const r = results[`E-${cs.name}`];
    const what = `E 入力 SEG「${cs.name}」`;
    if (!r || r.empty || r.noDump) {
      const note = `${what}: マスクとして取り込まれなかった（ユーザーへの通知: ${JSON.stringify(dSeg)}）`;
      if (cs.expectOk === "reject") { check(true, note); info(`${s.id}: ${note}`); } else check(false, `${s.id}: ${what}: 正しい SEG がマスクとして取り込まれた`, { labels, r });
      continue;
    }
    const dist = r.dist_from_sphere_center_mm as number;
    log(`${what}: 取り込まれたマスクの重心 ${JSON.stringify(r.centroid_lps)} / 球の中心からのずれ ${dist.toFixed(2)} mm / ボクセル ${r.voxels}（解析格子 ${r.analytic_N}, 一致 ${r.in_analytic}）/ オフセット ${JSON.stringify(r.offset_from_sphere_mm)}`);
    if (cs.expectOk === "place") {
      check(dist <= maxEdge / 2, `${s.id}: ${what}が位置を保って入る（重心のずれ ≤ 最大辺/2 = ${(maxEdge / 2).toFixed(2)} mm）`, { dist, offset: r.offset_from_sphere_mm });
      check(r.in_analytic === r.analytic_N && r.voxels === r.analytic_N, `${s.id}: ${what}のボクセル集合が解析格子と一致`, { voxels: r.voxels, analytic: r.analytic_N, inAnalytic: r.in_analytic });
    } else {
      // 宣言された幾何どおりなら球に重なる位置に置くか、拒否する。黙って別の位置に受理するのは不合格。
      check(dist <= maxEdge / 2, `${s.id}: ${what}を黙って誤った位置に受理しない（受理されたなら球の位置。実測のずれ ${dist.toFixed(2)} mm / 期待 ≤ ${(maxEdge / 2).toFixed(2)} mm）`, { dist, offset: r.offset_from_sphere_mm, voxels: r.voxels, notice: dSeg });
    }
  }
  // ── E2 往復: F の SEG（2D ROI のマスク）を再取り込みしたものと、書き出した画素集合が同じ ──
  for (const sh of env.shapes) {
    const seg = results[`SEG: ${sh.tool}`];
    const f = fs.existsSync(path.join(outDir, "export.roi0.seg.dcm")) ? [0, 1, 2].map((i) => path.join(outDir, `export.roi${i}.seg.dcm`)) : [];
    const cnt = f.map((p) => (fs.existsSync(p) ? reader("segcount", ["--file", p, "--truth", tj, "--series", s.id]) : null));
    const mine = cnt.find((c) => c && c.centroid_lps && lpsDist(c.centroid_lps, sh.centerLps) < 8);
    if (!seg || seg.empty || seg.noDump || !mine) { unreached(`${s.id}: E2 往復（SEG 書き出し→再取り込み）${sh.kind}`, "再取り込みしたマスクまたは書き出し SEG が無い"); continue; }
    check(seg.voxels === mine.count && lpsDist(seg.centroid_lps, mine.centroid_lps) < 1e-3, `${s.id}: E2 ${sh.kind} の SEG を書き出して再取り込みしても画素集合が同じ（個数・重心）`, { imported: seg.voxels, exported: mine.count, c1: seg.centroid_lps, c2: mine.centroid_lps });
  }
  // ── E3 RTSTRUCT: B の書き出し → 取り込み（マスク化）の面積・位置 ──
  for (const sh of env.shapes) {
    const r = results[sh.tool];
    if (!r || r.empty || r.noDump) { unreached(`${s.id}: E3 往復（RTSTRUCT 書き出し→取り込み）${sh.kind}`, `取り込んだマスク「${sh.tool}」が無い（行: ${JSON.stringify(labels)}）`); continue; }
    const area = r.voxels * px;
    const bound = (sh.perimTruth * Math.max(rowMm0, colMm0)) / 2;
    info(`${s.id}: E3 ${sh.kind} RTSTRUCT→マスク 画素数 ${r.voxels} → ${area.toFixed(2)} mm² / 解析 ${sh.areaTruth.toFixed(2)}（比 ${(area / sh.areaTruth).toFixed(4)}）`, { slices: r.slices });
    check(Math.abs(area - sh.areaTruth) <= bound, `${s.id}: E3 ${sh.kind} の RTSTRUCT を取り込んだマスクの面積（画素数×画素面積）が解析面積と一致（周長×最大辺/2）`, { area, truth: sh.areaTruth, bound });
    check(lpsDist(r.centroid_lps, sh.centerLps) <= Math.max(rowMm0, colMm0), `${s.id}: E3 ${sh.kind} の RTSTRUCT を取り込んだマスクの重心 = ROI の中心（≤ 1 画素）`, { got: r.centroid_lps, truth: sh.centerLps });
  }
  // ── E4 RTSTRUCT: Python で作った円 / 参照 SOP の無い輪郭 ──
  const rc = results["E_circle"];
  if (!rc || rc.empty || rc.noDump) check(false, `${s.id}: E4 入力 RTSTRUCT の円がマスクとして取り込まれた`, { labels, dRt });
  else {
    const area = rc.voxels * px;
    const n = 72, r0 = rm.radius_mm;
    const polyA = (n / 2) * r0 * r0 * Math.sin((2 * Math.PI) / n);
    const bound = (2 * Math.PI * r0 * Math.max(rowMm0, colMm0)) / 2;
    const err = lpsDist(rc.centroid_lps, rm.center_lps);
    log(`E4 円: 画素数 ${rc.voxels} → ${area.toFixed(2)} mm² / n 角形の面積 ${polyA.toFixed(2)} / 重心のずれ ${err.toFixed(3)} mm`);
    check(err <= Math.max(rowMm0, colMm0), `${s.id}: E4 入力 RTSTRUCT の円が位置を保って入る（重心のずれ ≤ 1 画素）`, { err, centroid: rc.centroid_lps, truth: rm.center_lps });
    check(Math.abs(area - polyA) <= bound, `${s.id}: E4 入力 RTSTRUCT の円の面積（画素数×画素面積）が輪郭の面積と一致（周長×最大辺/2）`, { area, polyA, bound });
  }
  const bad = results["E_badref"];
  const badAccepted = bad && !bad.empty && !bad.noDump;
  check(!badAccepted, `${s.id}: E4 参照 SOP が元シリーズに無い輪郭を黙って受理しない`, { bad, notice: dRt });
  info(`${s.id}: E4 参照 SOP の無い輪郭に対するユーザーへの通知: ${JSON.stringify(dRt)}`);
}
async function closeStats(page: Page): Promise<void> {
  await page.locator('[data-testid="roi-stats-dialog"] button', { hasText: "×" }).first().click({ timeout: 5000 }).catch(() => {});
  await page.getByTestId("roi-stats-dialog").waitFor({ state: "hidden", timeout: 5000 }).catch(async () => {
    await page.screenshot({ path: path.join(OUT_ROOT, "stats-not-closed.png") }).catch(() => {});
    console.log("  [warn] 統計ダイアログが閉じない");
  });
}
function dialogsReset(a: string[]) { a.length = 0; }

async function main(): Promise<void> {
  fs.mkdirSync(OUT_ROOT, { recursive: true });
  const { dir, truth } = makePhantom();
  // 負荷の高い機械では起動が遅く、DesktopDriver.start() が時間切れになることがある。作り直して再試行する。
  let d = new DesktopDriver();
  for (let attempt = 1; ; attempt++) {
    try { await d.start(); break; } catch (e) {
      console.log(`  [起動] ${attempt} 回目が失敗: ${(e as Error).message.slice(0, 120)}`);
      await d.stop().catch(() => {});
      if (attempt >= 3) throw e;
      await new Promise((r) => setTimeout(r, 5000));
      d = new DesktopDriver();
    }
  }
  try {
    for (const id of IDS) {
      const s = truth.series.find((x) => x.id === id);
      if (!s) { console.log(`  [skip] ${id}: truth に無い`); continue; }
      curId = id;
      console.log(`\n=== ${id}${NEG ? `（負例: ${NEG}）` : ""} ===`);
      try {
        await runOne(d, dir, truth, s);
      } catch (e) {
        console.log(`  [未達] ${id}: 例外で中断 — ${(e as Error).message.slice(0, 500)}`);
        tally().unreached.push(`${id}: 例外で中断（${(e as Error).message.slice(0, 200)}）`);
      }
    }
  } finally {
    await d.stop().catch(() => {});
  }
  console.log("\n════ 集計 ════");
  let totalFail = 0, totalUnreached = 0;
  for (const [id, t] of tallies) {
    console.log(`${id}: 合格 ${t.pass} / 失敗 ${t.fail.length} / 未達 ${t.unreached.length} / 参考 ${t.info.length}`);
    for (const f of t.fail) console.log(`   失敗: ${f}`);
    for (const u of t.unreached) console.log(`   未達: ${u}`);
    totalFail += t.fail.length; totalUnreached += t.unreached.length;
  }
  fs.writeFileSync(path.join(OUT_ROOT, `summary${NEG ? "-neg-" + NEG : ""}.json`), JSON.stringify([...tallies.entries()], null, 1));
  // 負例では「落ちること」が合格。
  process.exitCode = NEG ? (totalFail > 0 ? 0 : 1) : totalFail || totalUnreached ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exit(2); });
