/*
 * 幾何（IPP/IOP）の無い画像（XA）と有る画像（CT）で、Wand のシード画素が「押した位置を含む画素」になるかを測る（実アプリ）。
 * 実行: cd automator && GRAPHY_AUTOMATOR_HTTP_PORT=18510 GRAPHY_AUTOMATOR_SCP_PORT=18511 GRAPHY_AUTOMATOR_VITE_PORT=18513 \
 *        AUTOMATOR_DATA_DIR=$PWD/.results/run-data/desktop-xa npx tsx src/spike/geomXaSeedCheck.ts
 *   XA_IDS  検査する系列（既定 XA_iso,XA_aniso,CT_aniso）
 * 真値: 生成した画素値（背景 50・長方形 200、列 20..49・行 15..39）と画素境界。押す位置は「画像の外形 ÷ 画素数」から出す。
 * Wand の結果（labelmap）が、押した位置を含む画素（真値）を含むかで判定する。アプリのシード式は使わない。
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

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "geom-xa-seed-check");
const HOST = "viewer2d-canvas-host";
const IDS = (process.env.XA_IDS ?? "XA_iso,XA_aniso,CT_aniso").split(",");

const pass: string[] = [], fail: string[] = [], unmetL: string[] = [];
function check(cond: boolean, label: string, detail?: unknown) {
  const d = detail === undefined ? "" : ` — ${JSON.stringify(detail)}`;
  if (cond) { pass.push(label); console.log(`  [ok  ] ${label}${d}`); }
  else { fail.push(label + d); console.log(`  [FAIL] ${label}${d}`); }
}
function unmet(label: string, reason: string) { unmetL.push(`${label} — ${reason}`); console.log(`  [未達] ${label} — ${reason}`); }
const f3 = (v: number) => Math.round(v * 1000) / 1000;
const dbg = <T>(p: Page, fn: string, ...args: unknown[]): Promise<T> =>
  p.evaluate(`window.__graphyDebug.${fn}(...${JSON.stringify(args)})`) as Promise<T>;

async function clickMenuItem(page: Page, menu: string, nameRe: RegExp) {
  const re = new RegExp(nameRe.source.replace(/\^/g, "^(?:✓\\s*)?"), nameRe.flags);
  const item = page.getByRole("button", { name: re }).first();
  if (!(await item.isVisible().catch(() => false))) await page.getByTestId(`viewer2d-menu-${menu}`).click();
  await item.click({ timeout: 8000 });
}
const pickTool = async (p: Page, re: RegExp, menu: string) => { await clickMenuItem(p, menu, re); await p.waitForTimeout(250); };
async function clearRois(page: Page) {
  await clickMenuItem(page, "roi", /^(ROI を全消去|Clear ROIs)$/); await page.waitForTimeout(600);
  await clickMenuItem(page, "measure", /^(計測を全消去|Clear measurements)$/); await page.waitForTimeout(600);
}
async function viewportId(page: Page): Promise<string> {
  const v = await dbg<Array<{ viewportId: string; imageId: string | null }>>(page, "getViewportGeometry");
  return v.find((x) => x.imageId)!.viewportId;
}
interface CG { w: number; h: number; img: number[] }
async function canvasGeometry(page: Page): Promise<CG> {
  const vpid = await viewportId(page);
  return (await page.evaluate(`(function(){var h=document.querySelector('[data-testid="${HOST}"]');var c=h.querySelector("canvas");var r=c.getBoundingClientRect();return {w:r.width,h:r.height,img:window.__graphyDebug.getImageCanvasRect(${JSON.stringify(vpid)})};})()`)) as CG;
}
async function readMask(page: Page) {
  const c = await dbg<{ slices: Array<{ index: number; counts: Record<string, number> }> } | null>(page, "getSegCounts");
  const out: Record<number, number[]> = {};
  if (!c) return out;
  for (const s of c.slices) if ((s.counts["1"] ?? 0) > 0) out[s.index] = (await dbg<number[]>(page, "getSegSlicePixels", s.index, 1)) ?? [];
  return out;
}
async function readTextLines(page: Page): Promise<string[]> {
  return page.evaluate(`(function(){var h=document.querySelector('[data-testid="${HOST}"]');var o=[];h.querySelectorAll("svg text").forEach(function(t){var s=(t.textContent||"").trim();if(s)o.push(s);});return o;})()`) as Promise<string[]>;
}

interface Truth { rows: number; cols: number; bg: number; fg: number; rect: { x0: number; x1: number; y0: number; y1: number }; series: Array<{ id: string; dir: string; sop: string; pixelSpacing: number[]; geometry: boolean }> }

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const dir = path.join(OUT_DIR, "phantom");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const r = spawnSync("python3", ["-I", path.join(AUTOMATOR_ROOT, "scripts", "make-geom-xa-seed-phantom.py"), dir, "--uid-seed", String(Date.now() % 1_000_000_000)], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
  const truth = JSON.parse(fs.readFileSync(path.join(dir, "truth.json"), "utf8")) as Truth;
  const d = new DesktopDriver();
  await d.start();
  try {
    for (const id of IDS) {
      const s = truth.series.find((x) => x.id === id);
      if (!s) { unmet(id, "truth に無い"); continue; }
      console.log(`\n=== ${id}（幾何 ${s.geometry ? "あり" : "なし"}、PixelSpacing 行${s.pixelSpacing[0]}/列${s.pixelSpacing[1]}）===`);
      try { await runOne(d, dir, truth, s); } catch (e) { unmet(`${id}: 例外で中断`, String(e).slice(0, 300)); console.log(e); }
    }
  } finally { await d.stop().catch(() => {}); }
  console.log(`\n==== 集計: 合格 ${pass.length} / 失敗 ${fail.length} / 未達 ${unmetL.length} ====`);
  fail.forEach((f) => console.log(`  [失敗] ${f}`));
  unmetL.forEach((f) => console.log(`  [未達] ${f}`));
}

async function runOne(d: DesktopDriver, dir: string, truth: Truth, s: Truth["series"][number]) {
  await resetDb(d.ports.http);
  const files = fs.readdirSync(path.join(dir, s.dir)).filter((f) => f.endsWith(".dcm")).map((f) => path.join(dir, s.dir, f));
  const imp = await importPaths(d.ports.http, files);
  check(imp.imported === files.length && imp.failed === 0, `${s.id}: 取り込めた`, imp);
  const main = d.page;
  await main.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
  await openFirstSeriesInViewer(main, createStepRecorder());
  const v = await d.waitForNewPage(() => main.getByTestId("viewer2d-toolbar-button").click(), (url) => url.includes("2dviewer"));
  await v.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 20_000 });
  await v.waitForTimeout(3000);
  v.on("dialog", (dlg) => void dlg.accept());

  // ── 原点・間隔の記録 ──
  const vg = await dbg<unknown[]>(v, "getViewportGeometry");
  const probe = await dbg<unknown[]>(v, "getSpacingProbe");
  console.log("  getViewportGeometry:", JSON.stringify(vg));
  console.log("  getSpacingProbe:", JSON.stringify(probe));
  fs.writeFileSync(path.join(OUT_DIR, `${s.id}-geometry.json`), JSON.stringify({ vg, probe }, null, 1));

  let cg = await canvasGeometry(v);
  await v.screenshot({ path: path.join(OUT_DIR, `${s.id}-00.png`) });
  const geo = () => {
    const [ix0, iy0, ix1, iy1] = cg.img;
    return { ix0, iy0, ix1, iy1, pw: (ix1 - ix0) / truth.cols, ph: (iy1 - iy0) / truth.rows };
  };
  let g = geo();
  console.log(`  画像の外形 canvas [${cg.img.map(f3)}] 1 画素 ${f3(g.pw)} x ${f3(g.ph)} CSS px / canvas ${f3(cg.w)} x ${f3(cg.h)}`);
  console.log(`  予測: 画素境界 x=50 は canvas x=${f3(g.ix0 + 50 * g.pw)}、y=40 は canvas y=${f3(g.iy0 + 40 * g.ph)}`);
  const pxCanvas = (i: number, j: number): [number, number] => [g.ix0 + i * g.pw, g.iy0 + j * g.ph];

  // ── Wand ──
  console.log(`  --- Wand のシード（許容差 1。真値 = 押した位置を含む画素の値の側）---`);
  const R = truth.rect;
  const isFg = (i: number, j: number) => i >= R.x0 && i <= R.x1 && j >= R.y0 && j <= R.y1;
  interface Click { name: string; i: number; j: number; fx: number; fy: number; tol: string | null }
  const clicks: Click[] = [];
  const add = (name: string, i: number, j: number, fx: number, fy: number, tol: string | null = "1") => clicks.push({ name, i, j, fx, fy, tol });
  const rj = 27, bi = 35;
  for (const fx of [0.2, 0.5, 0.8, 0.95]) add(`右縁 P(49,${rj}) fx=${fx}`, R.x1, rj, fx, 0.5);
  add(`右縁 P 既定の許容差 fx=0.8`, R.x1, rj, 0.8, 0.5, null);
  for (const fy of [0.2, 0.5, 0.8, 0.95]) add(`下縁 P(${bi},39) fy=${fy}`, bi, R.y1, 0.5, fy);
  add(`右下象限 P(49,39) fx=0.8,fy=0.8`, R.x1, R.y1, 0.8, 0.8);
  add(`右下象限 P(49,39) fx=0.95,fy=0.95`, R.x1, R.y1, 0.95, 0.95);
  add(`左上象限 P(49,39) fx=0.2,fy=0.2`, R.x1, R.y1, 0.2, 0.2);
  add(`左縁 P'(20,${rj}) fx=0.2`, R.x0, rj, 0.2, 0.5);
  add(`左縁 P'(20,${rj}) fx=0.8`, R.x0, rj, 0.8, 0.5);
  add(`左縁の外 Q'(19,${rj}) fx=0.8（暗）`, R.x0 - 1, rj, 0.8, 0.5);
  add(`左縁の外 Q'(19,${rj}) fx=0.5（暗）`, R.x0 - 1, rj, 0.5, 0.5);
  add(`上縁 P'(${bi},15) fy=0.2`, bi, R.y0, 0.5, 0.2);
  add(`上縁の外 Q'(${bi},14) fy=0.8（暗）`, bi, R.y0 - 1, 0.5, 0.8);
  add(`対角の外 Q''(50,40) fx=0.2,fy=0.2（暗）`, R.x1 + 1, R.y1 + 1, 0.2, 0.2);
  add(`右隣 Q(50,${rj}) fx=0.2（暗）`, R.x1 + 1, rj, 0.2, 0.5);
  add(`下隣 Q(${bi},40) fy=0.2（暗）`, bi, R.y1 + 1, 0.5, 0.2);
  add(`負例 右隣 Q(50,${rj}) 中央（暗）`, R.x1 + 1, rj, 0.5, 0.5);
  add(`負例 下隣 Q(${bi},40) 中央（暗）`, bi, R.y1 + 1, 0.5, 0.5);
  const rows: string[] = [];
  for (const c of clicks) {
    cg = await canvasGeometry(v); g = geo();
    const [x, y] = pxCanvas(c.i + c.fx, c.j + c.fy);
    await pickTool(v, /^2D Wand/, "roiTools");
    await dragOnCanvasHost(v, HOST, 0, 0, 0, 1, { fracX: x / cg.w, fracY: y / cg.h });
    try { await v.getByTestId("wand-count").waitFor({ timeout: 30_000 }); } catch { unmet(`${s.id}: ${c.name}`, "wand-count が出ない"); continue; }
    await v.waitForTimeout(1000);
    if (c.tol !== null) {
      const f = v.getByTestId("wand-threshold");
      await f.fill(c.tol); await f.press("Enter"); await v.waitForTimeout(1200);
    }
    const used = await v.getByTestId("wand-threshold").inputValue().catch(() => "?");
    const m = await readMask(v);
    const px = Object.values(m)[0] ?? [];
    const total = Object.values(m).reduce((a, b) => a + b.length, 0);
    const has = (i: number, j: number) => px.includes(j * truth.cols + i);
    const truthHas = has(c.i, c.j);
    // 真値: 押した画素 (c.i,c.j) の値の側のマスク（明: 750 画素、暗: 4050 画素）
    const kind = total === (R.x1 - R.x0 + 1) * (R.y1 - R.y0 + 1) ? "明の長方形" : total === truth.cols * truth.rows - (R.x1 - R.x0 + 1) * (R.y1 - R.y0 + 1) ? "暗の背景" : `?(${total})`;
    const line = `${c.name} | 許容差 ${used} | マスク ${total} 画素（${kind}）| 押した画素を含む ${truthHas}`;
    rows.push(`${isFg(c.i, c.j) ? "明" : "暗"} ${line}`);
    console.log(`    ${line}`);
    check(truthHas, `${s.id}: Wand ${c.name}: シード = 押した画素`, { kind, total });
    if (c.name.startsWith("負例")) { const [pi, pj] = c.name.includes("右隣") ? [R.x1, rj] : [bi, R.y1]; check(!has(pi, pj), `${s.id}: 負例（${c.name}）は P を含まない`, { P: has(pi, pj) }); }
    await v.getByTestId("wand-cancel").click().catch(() => {});
    await v.waitForTimeout(500);
  }

  // ── ROI 統計（矩形）──
  console.log(`  --- ROI 統計（矩形。画素境界に合わせた期待値）---`);
  const rects = [
    { name: "x 44〜54 × y 20〜30（x 方向が縁をまたぐ）", x0: 44, x1: 54, y0: 20, y1: 30, expect: (6 * truth.fg + 4 * truth.bg) / 10, shifted: (5 * truth.fg + 5 * truth.bg) / 10 },
    { name: "x 30〜40 × y 35〜45（y 方向が縁をまたぐ）", x0: 30, x1: 40, y0: 35, y1: 45, expect: (5 * truth.fg + 5 * truth.bg) / 10, shifted: (4 * truth.fg + 6 * truth.bg) / 10 },
  ];
  for (const rc of rects) {
    await clearRois(v);
    cg = await canvasGeometry(v); g = geo();
    const [x0, y0] = pxCanvas(rc.x0, rc.y0), [x1, y1] = pxCanvas(rc.x1, rc.y1);
    await pickTool(v, /矩形 ROI|Rectangle ROI/, "roi");
    await dragOnCanvasHost(v, HOST, x1 - x0, y1 - y0, 0, 10, { fracX: x0 / cg.w, fracY: y0 / cg.h });
    await v.waitForTimeout(1500);
    const pair = await dbg<Array<{ tool: string; byUidMean: number | null; byUidSamples: number | null }>>(v, "getRoiStatsPair");
    const hp = await dbg<Array<{ tool: string; points: number[][] }>>(v, "getAnnotationCanvasPoints");
    const last = hp[hp.length - 1];
    if (!last || !pair.length) { unmet(`${s.id}: 統計 ${rc.name}`, "ROI が取れない"); continue; }
    const xs = last.points.map((p) => p[0]), ys = last.points.map((p) => p[1]);
    const pix = (u: number, o: number, n: number) => f3((u - o) / n);
    console.log(`    ${rc.name}: ハンドルの画素座標（隅=0）x ${pix(Math.min(...xs), g.ix0, g.pw)}〜${pix(Math.max(...xs), g.ix0, g.pw)} y ${pix(Math.min(...ys), g.iy0, g.ph)}〜${pix(Math.max(...ys), g.iy0, g.ph)}`);
    const p0 = pair[pair.length - 1];
    console.log(`    統計 mean=${p0.byUidMean} 標本 ${p0.byUidSamples} / 期待（隅原点・画素境界）${rc.expect} 標本 100 / 半画素ずれた場合 ${rc.shifted} / 文字: ${(await readTextLines(v)).join(" | ")}`);
    check(p0.byUidMean !== null && Math.abs(p0.byUidMean - rc.expect) < 1e-6 && p0.byUidSamples === 100, `${s.id}: ROI 統計 ${rc.name}: mean が画素境界の期待値`, { mean: p0.byUidMean, expect: rc.expect, shifted: rc.shifted, n: p0.byUidSamples });
    await v.screenshot({ path: path.join(OUT_DIR, `${s.id}-stats-${rc.x0}.png`) });
  }
  fs.writeFileSync(path.join(OUT_DIR, `${s.id}-wand-rows.txt`), rows.join("\n"));
  await v.close().catch(() => {});
  await main.waitForTimeout(1500);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
