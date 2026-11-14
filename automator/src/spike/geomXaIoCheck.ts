/*
 * 幾何（IPP/IOP）の無い画像（XA）と有る画像（CT）で、ROI の ImageJ 書き出し／取り込み／コピー＆貼り付け／プラグイン往復が
 * 「画素の左上隅が 0」の座標で一致するかを測る（実アプリ）。
 * 実行: cd automator && GRAPHY_AUTOMATOR_HTTP_PORT=18560 GRAPHY_AUTOMATOR_SCP_PORT=18561 GRAPHY_AUTOMATOR_VITE_PORT=18563 \
 *        AUTOMATOR_DATA_DIR=$PWD/.results/run-data/desktop-xaio npx tsx src/spike/geomXaIoCheck.ts
 *   XA_IDS  検査する系列（既定 XA_iso,XA_aniso,CT_aniso）
 * 真値: 生成した画素値・画素境界（ファントム 60 行 x 80 列）と、描いた位置（画像の外形 ÷ 画素数で画素座標→画面を決める）。
 * アプリの変換式は真値に使わない。負例: 真値を半画素ずらすと落ちることを毎回示す。
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { Page } from "@playwright/test";
import { DesktopDriver, DESKTOP_RUN_DATA_DIR } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { openFirstSeriesInViewer } from "../checklist/items/shared/helpers.js";
import { dragOnCanvasHost } from "../common/pointerDrag.js";
import { createStepRecorder } from "../checklist/types.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "geom-xa-io-check");
const HOST = "viewer2d-canvas-host";
const IDS = (process.env.XA_IDS ?? "XA_iso,XA_aniso,CT_aniso").split(",");
const READER = path.join(AUTOMATOR_ROOT, "scripts", "verify-geom-export.py");
const PLUGIN_ID = "roi-roundtrip-check";

const pass: string[] = [], fail: string[] = [], unmetL: string[] = [];
let curSeries = "";
const perSeries: Record<string, { pass: number; fail: string[]; unmet: string[] }> = {};
const bucket = () => (perSeries[curSeries] ??= { pass: 0, fail: [], unmet: [] });
function check(cond: boolean, label: string, detail?: unknown) {
  const d = detail === undefined ? "" : ` — ${JSON.stringify(detail)}`;
  if (cond) { pass.push(label); bucket().pass++; console.log(`  [ok  ] ${label}${d}`); }
  else { fail.push(label + d); bucket().fail.push(label + d); console.log(`  [FAIL] ${label}${d}`); }
}
function unmet(label: string, reason: string) { unmetL.push(`${label} — ${reason}`); bucket().unmet.push(`${label} — ${reason}`); console.log(`  [未達] ${label} — ${reason}`); }
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
interface Handle { uid: string; tool: string; points: number[][] }
const allHandles = (p: Page) => dbg<Handle[]>(p, "getAnnotationCanvasPoints");

function reader(args: string[]): any {
  const r = spawnSync("python3", ["-I", READER, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`reader 失敗: ${r.stderr.slice(0, 600)}`);
  return JSON.parse(r.stdout);
}

interface Truth { rows: number; cols: number; bg: number; fg: number; rect: { x0: number; x1: number; y0: number; y1: number }; series: Array<{ id: string; dir: string; sop: string; pixelSpacing: number[]; geometry: boolean }> }

// 検査の許容（画素）。ジェスチャーの丸め（1 画素 ≈ 数 CSS px、座標は実数なので ≪ 0.1）。負例は 0.5 画素ずらす。
const TOL = 0.2;
const NEG = 0.5;

/** 外接 bbox [x0,y0,x1,y1] */
const bboxOf = (pts: number[][]) => {
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
};
const maxErr = (a: number[], b: number[]) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const dir = path.join(OUT_DIR, "phantom");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const r = spawnSync("python3", ["-I", path.join(AUTOMATOR_ROOT, "scripts", "make-geom-xa-seed-phantom.py"), dir, "--uid-seed", String(Date.now() % 1_000_000_000)], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
  const truth = JSON.parse(fs.readFileSync(path.join(dir, "truth.json"), "utf8")) as Truth;
  // 検証プラグインを配置（前回の痕跡を消してから）
  const dst = path.join(DESKTOP_RUN_DATA_DIR, "plugins", PLUGIN_ID);
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(dst, { recursive: true });
  const src = path.join(AUTOMATOR_ROOT, "plugins", PLUGIN_ID);
  for (const n of fs.readdirSync(src)) fs.copyFileSync(path.join(src, n), path.join(dst, n));

  let d: DesktopDriver | null = null;
  for (let a = 0; a < 3; a++) {
    try {
      d = new DesktopDriver();
      await d.start();
      await d.page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
      break;
    } catch (e) {
      console.log(`  起動の再試行 ${a + 1}: ${String(e).slice(0, 120)}`);
      await d?.stop().catch(() => {});
      d = null;
    }
  }
  if (!d) throw new Error("起動できない");
  try {
    for (const id of IDS) {
      curSeries = id;
      const s = truth.series.find((x) => x.id === id);
      if (!s) { unmet(id, "truth に無い"); continue; }
      console.log(`\n=== ${id}（幾何 ${s.geometry ? "あり" : "なし"}、PixelSpacing 行${s.pixelSpacing[0]}/列${s.pixelSpacing[1]}）===`);
      try { await runOne(d, dir, truth, s); } catch (e) { unmet(`${id}: 例外で中断`, String(e).slice(0, 400)); console.log(e); }
    }
  } finally { await d.stop().catch(() => {}); }
  console.log(`\n==== 集計: 合格 ${pass.length} / 失敗 ${fail.length} / 未達 ${unmetL.length} ====`);
  for (const [k, v] of Object.entries(perSeries)) console.log(`  ${k}: 合格 ${v.pass} / 失敗 ${v.fail.length} / 未達 ${v.unmet.length}`);
  fail.forEach((f) => console.log(`  [失敗] ${f}`));
  unmetL.forEach((f) => console.log(`  [未達] ${f}`));
}

async function runOne(d: DesktopDriver, dir: string, truth: Truth, s: Truth["series"][number]) {
  const id = s.id;
  await resetDb(d.ports.http);
  const files = fs.readdirSync(path.join(dir, s.dir)).filter((f) => f.endsWith(".dcm")).map((f) => path.join(dir, s.dir, f));
  const imp = await importPaths(d.ports.http, files);
  check(imp.imported === files.length && imp.failed === 0, `${id}: 取り込めた`, imp);
  const main = d.page;
  await main.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
  await openFirstSeriesInViewer(main, createStepRecorder());
  const v = await d.waitForNewPage(() => main.getByTestId("viewer2d-toolbar-button").click(), (url) => url.includes("2dviewer"));
  await v.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 20_000 });
  await v.waitForTimeout(3000);
  const dialogs: string[] = [];
  v.on("dialog", (dlg) => { dialogs.push(dlg.message()); void dlg.accept(); });
  v.on("console", (m) => { if (m.type() === "error") console.log(`  [renderer error] ${m.text().slice(0, 160)}`); });
  await v.evaluate(`(function () {
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
    })()`);

  // ROI マネージャを開く（パネルが出ると canvas の大きさが変わるので、幾何の測定より前）
  await v.getByTestId("viewer2d-menu-roiTools").click();
  await v.getByRole("button", { name: /ROI マネージャ|ROI manager/i }).first().click();
  await v.waitForTimeout(800);
  await v.keyboard.press("Escape").catch(() => {});
  // プラグインを起動して host を掴む
  await v.getByTestId("viewer2d-menu-plugins").click();
  await v.getByTestId(`plugin-item-${PLUGIN_ID}`).click();
  await v.waitForTimeout(800);
  await v.keyboard.press("Escape").catch(() => {});
  const hasHost = (await v.evaluate(`!!window.__rtHost`)) as boolean;
  if (!hasHost) unmet(`${id}: プラグインの host`, "window.__rtHost が無い（項目 4 は実施できない）");

  const [rowMm, colMm] = s.pixelSpacing;
  let cg = await canvasGeometry(v);
  const geo = () => { const [ix0, iy0, ix1, iy1] = cg.img; return { ix0, iy0, pw: (ix1 - ix0) / truth.cols, ph: (iy1 - iy0) / truth.rows }; };
  let g = geo();
  console.log(`  画像の外形 canvas [${cg.img.map(f3)}] 1 画素 ${f3(g.pw)} x ${f3(g.ph)} CSS px / canvas ${f3(cg.w)} x ${f3(cg.h)}`);
  await v.screenshot({ path: path.join(OUT_DIR, `${id}-00.png`) });
  const pxCanvas = (i: number, j: number): [number, number] => [g.ix0 + i * g.pw, g.iy0 + j * g.ph];
  const toPx = (p: number[]): [number, number] => [(p[0] - g.ix0) / g.pw, (p[1] - g.iy0) / g.ph];
  const frac = (x: number, y: number) => ({ fracX: x / cg.w, fracY: y / cg.h });

  // ── ROI を描く（画素境界に合わせる）──
  await clearRois(v);
  cg = await canvasGeometry(v); g = geo();
  interface Shape { kind: "rect" | "circle" | "ellipse"; tool: string; uid: string; px: number[][]; truthBbox: number[] }
  const shapes: Shape[] = [];
  // 真値（画素境界。ジェスチャーから決める。アプリの変換は使わない）
  // 矩形: 列 44〜54 × 行 20〜30。円: 中心 (22,45)、半径 = 6 列分の表示長（列方向 6 画素、行方向は 6*colMm/rowMm 画素）。
  // 楕円: 始点 (60,35) から 10 列 × 8 行ぶんドラッグ（描き方は読み戻したハンドルで確かめる）。
  const circleRowR = 6 * colMm / rowMm;
  const specs = [
    { kind: "rect" as const, re: /矩形 ROI|Rectangle ROI/, x0: 44, y0: 20, dx: 10 * g.pw, dy: 10 * g.ph, truthBbox: [44, 20, 54, 30] },
    { kind: "circle" as const, re: /^円 ROI$|^Circle ROI$/, x0: 22, y0: 45, dx: 6 * g.pw, dy: 0, truthBbox: [16, 45 - circleRowR, 28, 45 + circleRowR] },
    { kind: "ellipse" as const, re: /楕円 ROI|Ellipse ROI/, x0: 60, y0: 35, dx: 10 * g.pw, dy: 8 * g.ph, truthBbox: [60, 35, 70, 43] },
  ];
  for (const sp of specs) {
    const nBefore = (await allHandles(v)).length;
    await pickTool(v, sp.re, "roi");
    const [x0, y0] = pxCanvas(sp.x0, sp.y0);
    await dragOnCanvasHost(v, HOST, sp.dx, sp.dy, 0, 10, frac(x0, y0));
    await v.waitForTimeout(1500);
    const hs = await allHandles(v);
    const h = hs.length > nBefore ? hs[hs.length - 1] : null;
    if (!h) { check(false, `${id}: ${sp.kind} を描けた`, { nBefore, n: hs.length }); continue; }
    const px = h.points.map(toPx);
    shapes.push({ kind: sp.kind, tool: h.tool, uid: h.uid, px, truthBbox: sp.truthBbox });
    console.log(`  ${sp.kind}（${h.tool}）: ハンドルの画素座標（画面から。隅=0）${JSON.stringify(px.map((p) => p.map(f3)))}`);
  }
  await v.screenshot({ path: path.join(OUT_DIR, `${id}-01-rois.png`) });
  // 楕円の描き方（始点＝隅か中心か）を、読み戻したハンドルから確定して真値を補正する
  const ell = shapes.find((x) => x.kind === "ellipse");
  if (ell) {
    const bb = bboxOf(ell.px);
    if (maxErr(bb, ell.truthBbox) > TOL) {
      const cen = [60 - 10, 35 - 8, 60 + 10, 35 + 8];
      if (maxErr(bb, cen) <= TOL) { ell.truthBbox = cen; console.log("  楕円は始点が中心の描き方（真値を補正）"); }
      else console.log(`  楕円の bbox が想定の 2 通りのどちらとも違う: ${JSON.stringify(bb.map(f3))}`);
    }
  }
  for (const sh of shapes) {
    const bb = bboxOf(sh.px);
    const circle = sh.kind === "circle";
    // 円のハンドルは [中心, 縁]。画面の円の bbox は中心 ± 縁までの表示長
    const gb = circle ? [sh.px[0][0] - 6, 0, sh.px[0][0] + 6, 0] : bb;
    if (circle) console.log(`  円: 中心 ${JSON.stringify(sh.px[0].map(f3))}（真値 (22,45)）縁 ${JSON.stringify(sh.px[1].map(f3))}`);
    else check(maxErr(bb, sh.truthBbox) <= TOL, `${id}: ${sh.kind} を画素境界に描けた（自分の手順の確認）`, { got: bb.map(f3), truth: sh.truthBbox });
    void gb;
  }
  const rect = shapes.find((x) => x.kind === "rect");
  const circ = shapes.find((x) => x.kind === "circle");
  if (circ) check(Math.abs(circ.px[0][0] - 22) <= TOL && Math.abs(circ.px[0][1] - 45) <= TOL, `${id}: 円の中心を (22,45) に描けた（自分の手順の確認）`, circ.px[0].map(f3));
  if (!rect) { unmet(`${id}: 以降`, "矩形が描けない"); return; }

  // ═══ 項目 4a: getRois().points ═══
  console.log(`  --- 項目 4: プラグイン getRois / createRoi ---`);
  interface PRoi { roiUid: string; tool: string; points: number[][]; sliceIndex: number }
  const getPluginRois = () => v.evaluate(`window.__rtHost.getRois().map(function(r){return {roiUid:r.roiUid,tool:r.tool,points:r.points,sliceIndex:r.sliceIndex};})`) as Promise<PRoi[]>;
  if (hasHost) {
    const pr = await getPluginRois();
    const find = (uid: string) => pr.find((r) => r.roiUid === uid);
    const rr = find(rect.uid) ?? pr.find((r) => /rect/i.test(r.tool));
    check(pr.length === shapes.length, `${id}: 項目4 getRois の件数 = 描いた数`, { got: pr.length, drawn: shapes.length });
    if (!rr) unmet(`${id}: 項目4 getRois の矩形`, `見つからない ${JSON.stringify(pr.map((r) => r.tool))}`);
    else {
      const bb = bboxOf(rr.points);
      const truthB = [44, 20, 54, 30];
      check(maxErr(bb, truthB) <= TOL, `${id}: 項目4 getRois の矩形 points が画素境界（整数）`, { got: bb.map(f3), truth: truthB, points: rr.points.map((p) => p.map(f3)) });
      check(maxErr(bb, truthB.map((x) => x + NEG)) > TOL, `${id}: 項目4 [負例] 真値を半画素ずらすと不一致になる`, { got: bb.map(f3) });
      // 円・楕円
      const cc = pr.find((r) => /circle/i.test(r.tool));
      if (cc && circ) check(Math.abs(cc.points[0][0] - 22) <= TOL && Math.abs(cc.points[0][1] - 45) <= TOL, `${id}: 項目4 getRois の円の中心 = (22,45)`, cc.points.map((p) => p.map(f3)));
      const ee = pr.find((r) => /ellip/i.test(r.tool));
      if (ee && ell) check(maxErr(bboxOf(ee.points), ell.truthBbox) <= TOL, `${id}: 項目4 getRois の楕円 bbox が画素境界`, { got: bboxOf(ee.points).map(f3), truth: ell.truthBbox });

      // createRoi（矩形: centerPx + radiiMm、多角形: verticesPx）。getRois().points から作り直して元に重なるか
      const cxp = (bb[0] + bb[2]) / 2, cyp = (bb[1] + bb[3]) / 2;
      const rx = ((bb[2] - bb[0]) / 2) * colMm, ry = ((bb[3] - bb[1]) / 2) * rowMm;
      const cr1 = (await v.evaluate(`window.__rtHost.createRoi(undefined, ${JSON.stringify({ tool: "RectangleROI", centerPx: [cxp, cyp], radiiMm: [rx, ry], label: "rt-rect" })})`)) as { ok: boolean; roiUid?: string; reason?: string };
      // getRois の矩形の points は [左上, 右上, 左下, 右下] の順。多角形には周回順（0,1,3,2）で渡す
      const corners = [0, 1, 3, 2].map((i) => [rr.points[i][0], rr.points[i][1]]);
      const cr2 = (await v.evaluate(`window.__rtHost.createRoi(undefined, ${JSON.stringify({ tool: "PolygonROI", verticesPx: corners, label: "rt-poly" })})`)) as { ok: boolean; roiUid?: string; reason?: string };
      await v.waitForTimeout(1200);
      console.log(`  createRoi 矩形: ${JSON.stringify(cr1)} / 多角形: ${JSON.stringify(cr2)}`);
      const pr2 = await getPluginRois();
      for (const [nm, cr] of [["矩形（centerPx+radiiMm）", cr1], ["多角形（verticesPx）", cr2]] as const) {
        if (!cr.ok || !cr.roiUid) { check(false, `${id}: 項目4 createRoi ${nm} が成功`, cr); continue; }
        const nr = pr2.find((r) => r.roiUid === cr.roiUid);
        if (!nr) { unmet(`${id}: 項目4 createRoi ${nm}`, "作った ROI が getRois に無い"); continue; }
        const nb = bboxOf(nr.points);
        check(maxErr(nb, bb) <= 0.02, `${id}: 項目4 createRoi ${nm} が元と同じ位置（往復で半画素ずれない）`, { got: nb.map(f3), orig: bb.map(f3) });
        check(maxErr(nb, bb.map((x) => x + NEG)) > 0.02, `${id}: 項目4 [負例] ${nm} 真値を半画素ずらすと不一致`, {});
        // 画面のハンドル（getRois を介さない）でも確認
        const hs = (await allHandles(v)).find((h) => h.uid === cr.roiUid);
        if (hs) { const sb = bboxOf(hs.points.map(toPx)); check(maxErr(sb, truthB) <= TOL, `${id}: 項目4 createRoi ${nm} の画面のハンドルが画素境界`, { screen: sb.map(f3), truth: truthB }); }
      }
      for (const cr of [cr1, cr2]) if (cr.ok && cr.roiUid) await v.evaluate(`window.__rtHost.removeCreatedRoi(${JSON.stringify(cr.roiUid)})`);
      await v.waitForTimeout(600);
    }
  }

  // ═══ 項目 1: ImageJ 書き出し ═══
  console.log(`  --- 項目 1: ImageJ 書き出し ---`);
  const nShapes = (await allHandles(v)).length;
  console.log(`  書き出し前の ROI 数 ${nShapes}`);
  await v.evaluate(`window.__dl.length = 0`);
  await v.getByRole("button", { name: /^IJ ⬇$/ }).click();
  let dlFile: string | null = null;
  for (let t = 0; t < 100 && !dlFile; t++) {
    if (((await v.evaluate(`window.__dl.length`)) as number) > 0) {
      const dd = (await v.evaluate(`window.__dl.shift()`)) as { name: string; b64: string };
      dlFile = path.join(OUT_DIR, `${id}.RoiSet.zip`);
      fs.writeFileSync(dlFile, Buffer.from(dd.b64, "base64"));
      console.log(`  ダウンロード名: ${dd.name}（${fs.statSync(dlFile).size} バイト）`);
    } else await v.waitForTimeout(200);
  }
  let ijRois: any[] = [];
  if (!dlFile) unmet(`${id}: 項目1 ImageJ 書き出し`, `ダウンロードが捕捉できない（ダイアログ: ${JSON.stringify(dialogs.slice(-2))}）`);
  else {
    const ij = reader(["ij", "--file", dlFile]);
    ijRois = ij.rois;
    console.log(`  .roi: ${JSON.stringify(ijRois.map((r: any) => ({ type: r.type, bbox: r.bbox_int, sub: r.bbox_sub, n: r.n })))}`);
    check(ijRois.length === shapes.length, `${id}: 項目1 ImageJ の ROI 数 = 描いた数`, { ij: ijRois.length, drawn: shapes.length });
    const taken = new Set<number>();
    for (const sh of shapes) {
      const want = sh.kind === "rect" ? "rect" : "oval";
      const idx = ijRois.findIndex((r: any, i: number) => !taken.has(i) && r.type === want && (sh.kind === "rect" || true) &&
        Math.abs(r.bbox_int.left - Math.round(sh.truthBbox[0])) <= 3 && Math.abs(r.bbox_int.top - Math.round(sh.truthBbox[1])) <= 3);
      if (idx < 0) { check(false, `${id}: 項目1 ImageJ に ${sh.kind}（${want}）がある`, { types: ijRois.map((r: any) => [r.type, r.bbox_int]) }); continue; }
      taken.add(idx);
      const b = ijRois[idx].bbox_int;
      const got = [b.left, b.top, b.right, b.bottom];
      if (sh.kind === "rect") {
        check(got[0] === 44 && got[1] === 20 && b.width === 10 && b.height === 10, `${id}: 項目1 ImageJ 矩形 bbox = x44,y20,w10,h10`, { got: { x: b.left, y: b.top, w: b.width, h: b.height } });
        check(!(got[0] === 44.5 || got[0] === 45), `${id}: 項目1 [負例] 半画素ずらした真値 (x44.5) とは一致しない`, got);
      } else {
        const t = sh.truthBbox;
        const exp = [Math.round(t[0]), Math.round(t[1]), Math.round(t[2]), Math.round(t[3])];
        // 円は行方向が非整数（異方性）なので ±1 を許す。それ以外は整数一致。
        const tol = sh.kind === "circle" && Math.abs(circleRowR - Math.round(circleRowR)) > 1e-6 ? 1 : 0;
        check(maxErr(got, exp) <= tol, `${id}: 項目1 ImageJ ${sh.kind} bbox が画素境界の真値`, { got, truth: t.map(f3), expRounded: exp, tol, sub: ijRois[idx].bbox_sub });
        const shifted = t.map((x) => x + NEG);
        check(maxErr(got, shifted) > tol, `${id}: 項目1 [負例] ${sh.kind} 半画素ずらした真値とは一致しない`, { got, shifted });
      }
    }
  }

  // ═══ 項目 2: ImageJ 取り込み（往復）═══
  console.log(`  --- 項目 2: ImageJ 取り込み ---`);
  if (!dlFile) unmet(`${id}: 項目2 ImageJ 取り込み`, "書き出しの zip が無い");
  else {
    await clearRois(v);
    check((await allHandles(v)).length === 0, `${id}: 項目2 取り込み前に ROI が 0`, undefined);
    await v.locator('input[type="file"][accept=".roi,.zip"]').setInputFiles(dlFile);
    await v.waitForTimeout(2500);
    cg = await canvasGeometry(v); g = geo();
    const hs = await allHandles(v);
    console.log(`  取り込み後の ROI: ${JSON.stringify(hs.map((h) => [h.tool, bboxOf(h.points.map(toPx)).map(f3)]))}（ダイアログ: ${JSON.stringify(dialogs.slice(-2))}）`);
    check(hs.length === shapes.length, `${id}: 項目2 取り込み後の ROI 数 = 元の数`, { got: hs.length, orig: shapes.length });
    const taken = new Set<number>();
    for (const sh of shapes) {
      const bbOrig = sh.kind === "circle" ? sh.truthBbox : bboxOf(sh.px);
      // 取り込みは bbox から作るので、円は楕円になる。bbox どうしを比べる（整数丸めを許す: 円の行方向）
      const tolC = sh.kind === "circle" && Math.abs(circleRowR - Math.round(circleRowR)) > 1e-6 ? 0.5 + TOL : TOL;
      let bi = -1, bd = Infinity;
      hs.forEach((h, i) => {
        if (taken.has(i)) return;
        const bb = bboxOf(h.points.map(toPx));
        const dd = maxErr(bb, bbOrig);
        if (dd < bd) { bd = dd; bi = i; }
      });
      if (bi < 0) { check(false, `${id}: 項目2 ${sh.kind} に対応する ROI がある`); continue; }
      taken.add(bi);
      const bb = bboxOf(hs[bi].points.map(toPx));
      check(bd <= tolC, `${id}: 項目2 取り込んだ ${sh.kind}（${hs[bi].tool}）が元と同じ位置`, { got: bb.map(f3), orig: bbOrig.map(f3), tol: tolC });
      check(maxErr(bb, bbOrig.map((x) => x + NEG)) > tolC, `${id}: 項目2 [負例] ${sh.kind} 半画素ずらした真値とは一致しない`, {});
    }
    await v.screenshot({ path: path.join(OUT_DIR, `${id}-02-imported.png`) });
  }

  // ═══ 項目 3: コピー＆貼り付け・複製 ═══
  console.log(`  --- 項目 3: コピー＆貼り付け ---`);
  await clearRois(v);
  cg = await canvasGeometry(v); g = geo();
  {
    await pickTool(v, /矩形 ROI|Rectangle ROI/, "roi");
    const [x0, y0] = pxCanvas(44, 20);
    await dragOnCanvasHost(v, HOST, 10 * g.pw, 10 * g.ph, 0, 10, frac(x0, y0));
    await v.waitForTimeout(1200);
    const h0 = await allHandles(v);
    const src = h0[h0.length - 1];
    const srcBb = src ? bboxOf(src.points.map(toPx)) : null;
    const sel0 = await dbg<string[]>(v, "getSelectedAnnotations");
    console.log(`  元の矩形 ${JSON.stringify(srcBb?.map(f3))}、選択中 ${JSON.stringify(sel0)}（元 uid ${src?.uid}）`);
    if (!src) unmet(`${id}: 項目3`, "矩形が描けない");
    else {
      check(!!srcBb && maxErr(srcBb, [44, 20, 54, 30]) <= TOL, `${id}: 項目3 元の矩形が画素境界（自分の手順の確認）`, srcBb?.map(f3));
      // 貼り付け先タイルを 1 度選ぶ（画像をクリック。矩形の外側＝選択を外さないよう、ROI ツールでなく選択状態を保つ）
      // Copy → Paste
      let copyOk = true;
      try { await clickMenuItem(v, "roiTools", /^(ROI をコピー|Copy ROI)$/); } catch (e) { copyOk = false; unmet(`${id}: 項目3 コピー`, `メニュー項目が押せない ${String(e).slice(0, 120)}`); }
      if (copyOk) {
        await v.waitForTimeout(500);
        try { await clickMenuItem(v, "roiTools", /^(ROI を貼り付け|Paste ROI)$/); } catch (e) { copyOk = false; unmet(`${id}: 項目3 貼り付け`, `メニュー項目が押せない ${String(e).slice(0, 120)}`); }
        await v.waitForTimeout(1200);
        const h1 = await allHandles(v);
        console.log(`  貼り付け後の ROI 数 ${h1.length}（ダイアログ ${JSON.stringify(dialogs.slice(-2))}）`);
        const pasted = h1.filter((h) => h.uid !== src.uid);
        if (copyOk && pasted.length === 0) unmet(`${id}: 項目3 貼り付け`, "新しい ROI が現れない（貼り付け先タイル未選択の可能性。自分の手順を要確認）");
        else if (pasted.length) {
          const pb = bboxOf(pasted[pasted.length - 1].points.map(toPx));
          check(maxErr(pb, srcBb!) <= 0.02, `${id}: 項目3 貼り付けた ROI のハンドルがコピー元と同じ画素位置`, { pasted: pb.map(f3), src: srcBb!.map(f3) });
          check(maxErr(pb, srcBb!.map((x) => x + NEG)) > 0.02, `${id}: 項目3 [負例] 半画素ずらした真値とは一致しない`, {});
          check(maxErr(pb, [44, 20, 54, 30]) <= TOL, `${id}: 項目3 貼り付けた ROI が画素境界（真値）`, pb.map(f3));
        }
      }
      // 複製（Duplicate）
      const before = (await allHandles(v)).length;
      try {
        await v.getByTestId("roi-mgr-duplicate").first().click({ timeout: 8000 });
        await v.waitForTimeout(1200);
        const h2 = await allHandles(v);
        if (h2.length === before) unmet(`${id}: 項目3 複製`, "ROI が増えない（選択が無いか、複製が押せていない）");
        else {
          const known = new Set([src.uid]);
          const fresh = h2.slice(before);
          const pb = bboxOf(fresh[fresh.length - 1].points.map(toPx));
          known.size;
          check(maxErr(pb, srcBb!) <= 0.02, `${id}: 項目3 複製した ROI がコピー元と同じ画素位置`, { dup: pb.map(f3), src: srcBb!.map(f3) });
        }
      } catch (e) { unmet(`${id}: 項目3 複製`, `メニュー項目が押せない ${String(e).slice(0, 120)}`); }
      await v.screenshot({ path: path.join(OUT_DIR, `${id}-03-paste.png`) });
    }
  }
  await v.close().catch(() => {});
  await main.waitForTimeout(1500);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
