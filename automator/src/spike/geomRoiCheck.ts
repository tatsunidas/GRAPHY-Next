/*
 * 2D ROI・計測の幾何検証（実アプリ。段 3 の縦切り）。
 *
 * 実行:  cd automator && GEOM_IDS=g1_aniso npx tsx src/spike/geomRoiCheck.ts
 *   GEOM_IDS     検査する幾何（カンマ区切り。既定 g0_iso,g1_aniso）。make-geom-verify-phantom.py の ID。
 *   GEOM_NEG=1   負例: 真値の行/列間隔を入れ替えて、検査が落ちること（= 検査器が効いていること）を確かめる。
 *   GRAPHY_AUTOMATOR_{HTTP,SCP,VITE}_PORT  専用ポート（他セッションと衝突させない）。
 *
 * 真値は合成ファントム（scripts/make-geom-verify-phantom.py の truth.json）の解析形状。球 S の断面（円）を
 * 画面上に描き、ROI の値（長さ・面積・平均）を解析解と比べる。
 *
 * 🔴 独立性の取り方
 *   - 描く位置と大きさは、truth.json の IOP/IPP/間隔と、**画像全体が canvas に占める範囲**（画像の外形 ÷ 物理 FOV）
 *     から決める。アプリの ROI 統計・座標変換（imageCoords）は使わない。
 *   - 球の画面上の位置は、描いた後に**スクリーンショットの画素**から重心を測り、予測位置と比べる（表示位置の検査）。
 *   - 表示の縦横比: canvas 上の mm あたり px が x と y で同じか（非正方画素で潰れて見えないか）。
 *   - ROI の値は画面（ROI 脇の textBox）から読む。
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

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "geom-roi-check");
const HOST = "viewer2d-canvas-host";
const NEG = process.env.GEOM_NEG === "1";
const IDS = (process.env.GEOM_IDS ?? "g0_iso,g1_aniso").split(",").map((s) => s.trim()).filter(Boolean);

let passed = 0;
const failures: string[] = [];
function check(cond: boolean, label: string, detail?: unknown): void {
  if (cond) {
    passed++;
    console.log(`  [ok  ] ${label}`);
  } else {
    console.log(`  [FAIL] ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
    failures.push(label);
  }
}

// ── truth.json ──
interface SeriesTruth {
  id: string; rows: number; cols: number; pixelSpacing: [number, number];
  iop: number[]; normal: number[]; ipps: number[][]; sops: string[]; dir: string;
  rescale: { slope: number; intercept: number };
}
interface Truth {
  field: { A: number; B: number; C: number; D: number };
  sphere: { center: number[]; radiusMm: number; addedValue: number };
  series: SeriesTruth[];
}
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

function makePhantom(): { dir: string; truth: Truth } {
  const dir = path.join(OUT_DIR, "phantom");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  // UID は実行ごとに変える（同じ SOP UID の再取り込みで古いメタデータを掴まないため）。
  const seed = String(Date.now() % 1_000_000_000);
  const r = spawnSync(
    "python3",
    ["-I", path.join(AUTOMATOR_ROOT, "scripts", "make-geom-verify-phantom.py"), dir, "--uid-seed", seed],
    { encoding: "utf8" },
  );
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

/** ラベルの直後の数値を取る（1 行に複数の項目が連結されていても、そのラベルの分だけ）。 */
function numberAfter(lines: string[], re: RegExp): number | null {
  const r = new RegExp("(?:" + re.source + ")\\s*[:：]?\\s*(-?\\d+(?:\\.\\d+)?)");
  for (const l of lines) {
    const m = l.match(r);
    if (m) return Number(m[1]);
  }
  return null;
}

/** 画面上の注釈のハンドル（canvas の CSS px）。最後に作られたものを返す。 */
async function lastHandles(page: Page): Promise<{ tool: string; points: number[][] } | null> {
  const all = (await page.evaluate(
    `window.__graphyDebug.getAnnotationCanvasPoints()`,
  )) as Array<{ tool: string; points: number[][] }>;
  return all.length ? all[all.length - 1] : null;
}

/** メニューは開いたままのことがある（再度押すと閉じる）。目的のボタンが見えなければメニューを開く。 */
async function clickMenuItem(page: Page, menu: string, nameRe: RegExp): Promise<void> {
  // 選択中のツールは名前の先頭に「✓ 」が付く。アンカー付きの正規表現でも一致させる。
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
  const v = (await page.evaluate(
    `window.__graphyDebug ? window.__graphyDebug.getViewportGeometry() : []`,
  )) as VpInfo[];
  return v.find((x) => x.imageId) ?? null;
}

/** imageId（…/instances/<sop>/…）から SOP UID を取る。 */
const sopOf = (imageId: string | null): string | null => imageId?.match(/instances\/([0-9.]+)/)?.[1] ?? null;

/** 目的のスライス（SOP）が表示されるまでホイールで送る。向きは試して決める。 */
async function gotoSlice(page: Page, targetSop: string, sops: string[]): Promise<boolean> {
  const box = await page.locator(`[data-testid="${HOST}"] canvas`).first().boundingBox();
  if (!box) return false;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  let dir = 1;
  let prevIdx = -1;
  for (let n = 0; n < 160; n++) {
    const vp = await viewportInfo(page);
    const cur = sopOf(vp?.imageId ?? null);
    if (cur === targetSop) return true;
    const idx = cur ? sops.indexOf(cur) : -1;
    const tIdx = sops.indexOf(targetSop);
    // 進めた結果が目的から遠ざかったら向きを反転する。
    if (prevIdx >= 0 && idx >= 0 && Math.abs(idx - tIdx) > Math.abs(prevIdx - tIdx)) dir = -dir;
    prevIdx = idx;
    await page.mouse.wheel(0, 100 * dir);
    await page.waitForTimeout(120);
  }
  return false;
}

/** canvas の CSS px 矩形（page 座標）と、画像全体が canvas に占める範囲（canvas 左上原点の CSS px）。 */
async function canvasGeometry(page: Page, viewportId: string) {
  const g = (await page.evaluate(`
    (function () {
      var host = document.querySelector('[data-testid="${HOST}"]');
      var canvas = host && host.querySelector("canvas");
      var r = canvas.getBoundingClientRect();
      var img = window.__graphyDebug.getImageCanvasRect(${JSON.stringify(viewportId)});
      return { w: r.width, h: r.height, dpr: window.devicePixelRatio, img: img };
    })()
  `)) as { w: number; h: number; dpr: number; img: number[] | null };
  return g;
}

/**
 * canvas のスクリーンショットから、予測位置の近くで「球の明るさ」の連結領域の重心（CSS px）と面積を測る。
 * 明るさは背景と標識の間（球は中間のグレー）。予測位置の明るさを球の基準にする。
 */
async function measureBlob(page: Page, predicted: [number, number]): Promise<{ cx: number; cy: number; area: number } | null> {
  const png = await page.locator(`[data-testid="${HOST}"] canvas`).first().screenshot();
  const b64 = png.toString("base64");
  const res = await page.evaluate(`
    (async function () {
      var img = new Image();
      img.src = "data:image/png;base64,${b64}";
      await img.decode();
      var c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
      var ctx = c.getContext("2d"); ctx.drawImage(img, 0, 0);
      var d = ctx.getImageData(0, 0, c.width, c.height).data;
      var W = c.width, H = c.height;
      var cssW = document.querySelector('[data-testid="${HOST}"] canvas').getBoundingClientRect().width;
      var s = W / cssW; // screenshot px per CSS px
      function lum(x, y) { var i = (y * W + x) * 4; return 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; }
      var px = Math.round(${predicted[0]} * s), py = Math.round(${predicted[1]} * s);
      var ref = lum(px, py);
      var tol = 18; // 球の内部は一様。縁の補間は含めない
      var seen = new Uint8Array(W * H), stack = [[px, py]], n = 0, sx = 0, sy = 0;
      while (stack.length) {
        var p = stack.pop(), x = p[0], y = p[1];
        if (x < 0 || y < 0 || x >= W || y >= H || seen[y * W + x]) continue;
        seen[y * W + x] = 1;
        if (Math.abs(lum(x, y) - ref) > tol) continue;
        n++; sx += x; sy += y;
        stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
        if (n > 400000) break;
      }
      return n ? { cx: sx / n / s, cy: sy / n / s, area: n / (s * s), ref: ref } : null;
    })()
  `);
  return res as { cx: number; cy: number; area: number } | null;
}

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
      if (!s) { console.log(`  [skip] ${id}: truth に無い`); continue; }
      console.log(`\n=== ${id}${NEG ? "（負例: 行/列間隔を入れ替えた真値）" : ""} ===`);
      await runOne(d, dir, truth, s);
    }
  } finally {
    await d.stop().catch(() => {});
  }
  console.log(`\n合格 ${passed} / 失敗 ${failures.length}`);
  if (failures.length) {
    console.log("失敗:\n  - " + failures.join("\n  - "));
  }
  // 負例では「落ちること」が合格。
  process.exitCode = NEG ? (failures.length > 0 ? 0 : 1) : failures.length ? 1 : 0;
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
  const viewer = await d.waitForNewPage(
    () => main.getByTestId("viewer2d-toolbar-button").click(),
    (url) => url.includes("2dviewer"),
  );
  await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 20_000 });
  await viewer.waitForTimeout(3000);
  viewer.on("dialog", (dlg) => void dlg.accept());

  // ── 真値の幾何（truth.json のみから。アプリの座標変換は使わない）──
  const [rowMm0, colMm0] = s.pixelSpacing;
  const [rowMm, colMm] = NEG ? [colMm0, rowMm0] : [rowMm0, colMm0]; // 負例: 行/列を入れ替えた真値
  const rc = s.iop.slice(0, 3), rr = s.iop.slice(3);
  const c = truth.sphere.center, R = truth.sphere.radiusMm;
  // 球の中心に最も近いスライス
  let best = 0, bestD = Infinity;
  s.ipps.forEach((ipp, k) => {
    const dd = Math.abs(dot(sub(c, ipp), s.normal));
    if (dd < bestD) { bestD = dd; best = k; }
  });
  const dN = dot(sub(c, s.ipps[best]), s.normal);
  const rp = Math.sqrt(R * R - dN * dN); // 断面の半径 [mm]
  const pc = [c[0] - dN * s.normal[0], c[1] - dN * s.normal[1], c[2] - dN * s.normal[2]]; // 断面の中心 LPS
  const rel = sub(pc, s.ipps[best]);
  const colIdx = dot(rel, rc) / colMm0; // 列方向の画素 index（画素中心 = 整数）。表示の検査は NEG でも実間隔
  const rowIdx = dot(rel, rr) / rowMm0;

  const ok = await gotoSlice(viewer, s.sops[best], s.sops);
  check(ok, `${s.id}: 目的のスライス（${best} 番）を表示できた`);
  if (!ok) return;
  await viewer.waitForTimeout(600);

  const vp = await viewportInfo(viewer);
  const cg = await canvasGeometry(viewer, vp!.viewportId);
  check(!!cg.img, `${s.id}: 画像の canvas 上の範囲が取れる`, cg);
  if (!cg.img) return;
  const [ix0, iy0, ix1, iy1] = cg.img;
  // 画像全体の外形は物理 FOV（cols*列間隔, rows*行間隔）に対応する。
  const fovX = s.cols * colMm, fovY = s.rows * rowMm;
  const pxPerMmX = (ix1 - ix0) / fovX, pxPerMmY = (iy1 - iy0) / fovY;
  console.log(`  canvas: ${cg.w.toFixed(0)}×${cg.h.toFixed(0)} CSS px, DPR ${cg.dpr}, px/mm x=${pxPerMmX.toFixed(3)} y=${pxPerMmY.toFixed(3)}`);
  // 表示の縦横比（非正方画素で潰れて見えない）
  check(
    Math.abs(pxPerMmX / pxPerMmY - 1) < 0.01,
    `${s.id}: 画面上の mm あたり px が x と y で等しい（縦横比）`,
    { pxPerMmX, pxPerMmY },
  );
  const pxPerMm = (pxPerMmX + pxPerMmY) / 2;
  // 球の断面中心の予測 canvas 位置（画素 index → canvas。画素中心は index+0.5 の位置）
  const cx = ix0 + (colIdx + 0.5) * colMm * pxPerMmX;
  const cy = iy0 + (rowIdx + 0.5) * rowMm * pxPerMmY;
  await viewer.screenshot({ path: path.join(OUT_DIR, `${s.id}-slice.png`) });
  const blob = await measureBlob(viewer, [cx, cy]);
  if (blob) {
    const e = Math.hypot(blob.cx - cx, blob.cy - cy);
    const rBlobMm = Math.sqrt(blob.area / Math.PI) / pxPerMm;
    console.log(`  球の断面: 予測中心 (${cx.toFixed(1)},${cy.toFixed(1)}) 実測 (${blob.cx.toFixed(1)},${blob.cy.toFixed(1)}) 差 ${e.toFixed(2)} CSS px = ${(e / pxPerMm).toFixed(2)} mm / 半径 予測 ${rp.toFixed(2)} 実測 ${rBlobMm.toFixed(2)} mm`);
    check(e / pxPerMm < 1.0, `${s.id}: 球の断面の表示位置が予測（truth の LPS）と一致（< 1 mm）`, { errMm: e / pxPerMm });
    check(Math.abs(rBlobMm - rp) < 1.0, `${s.id}: 球の断面の表示サイズが予測と一致（半径 < 1 mm）`, { rBlobMm, rp });
  } else {
    check(false, `${s.id}: 球の断面が画面から測れた`);
  }

  // ── ツール別の検査 ──
  // 真値は「ハンドルが画面のどこにあるか」を、画像の外形 ÷ 物理 FOV の縮尺（pxPerMm）で mm に直したもの。
  // 描いた位置の意図（球の断面）とは別に、ツールごとの描き方（始点が中心か角か）の違いに依らず検査できる。
  const tolPx = 1.0; // ポインタ座標の丸め（CSS px）
  const tolMm = tolPx / pxPerMm;
  const rPx = rp * pxPerMm;
  const frac = (x: number, y: number) => ({ fracX: x / cg.w, fracY: y / cg.h });
  const dist = (p: number[], q: number[]) => Math.hypot(p[0] - q[0], p[1] - q[1]) / pxPerMm;
  const canvasToLps = (x: number, y: number) => {
    const ci = (x - ix0) / (colMm * pxPerMmX) - 0.5;
    const rj = (y - iy0) / (rowMm * pxPerMmY) - 0.5;
    return [0, 1, 2].map((k) => s.ipps[best][k] + ci * colMm0 * rc[k] + rj * rowMm0 * rr[k]);
  };
  const dirs: Array<[string, number, number]> = [["水平", 1, 0], ["垂直", 0, 1], ["斜め 45°", Math.SQRT1_2, Math.SQRT1_2]];
  const draw = async (tool: RegExp, menu: "roi" | "measure", dx: number, dy: number, x0: number, y0: number) => {
    await clearRois(viewer);
    await pickTool(viewer, tool, menu);
    await dragOnCanvasHost(viewer, HOST, dx, dy, 0, 10, frac(x0, y0));
    await viewer.waitForTimeout(1500);
    return { lines: await readTextBoxLines(viewer), h: await lastHandles(viewer) };
  };

  // Length: 水平・垂直・斜めの直径（意図 = 2 rp）。真値 = 2 つのハンドルの間の距離。
  for (const [name, ux, uy] of dirs) {
    const { lines, h } = await draw(/^長さ$|^Length$/, "measure", 2 * rPx * ux, 2 * rPx * uy, cx - rPx * ux, cy - rPx * uy);
    const v = numberAfter(lines, /長さ|Length/);
    const t = h && h.points.length >= 2 ? dist(h.points[0], h.points[1]) : null;
    console.log(`  Length（${name}）: 表示 ${v} mm / ハンドル間 ${t?.toFixed(3)} mm / 意図 ${(2 * rp).toFixed(3)} mm`);
    check(v !== null && t !== null && Math.abs(v - t) <= 0.011 + 0.0005 * t, `${s.id}: Length（${name}）の表示 = ハンドル間の距離（画面の縮尺 ÷ 物理 FOV）`, { read: v, handles: t, lines });
    check(t !== null && Math.abs(t - 2 * rp) <= 2 * tolMm + 0.05, `${s.id}: Length（${name}）を意図の長さに置けた（前提の確認）`, { handles: t, intent: 2 * rp });
  }

  // Circle: 中心から縁へ rp。真値 = π r²（r = 中心〜縁ハンドルの距離）。
  for (const [name, ux, uy] of dirs) {
    const { lines, h } = await draw(/^円 ROI$|^Circle ROI$/, "roi", rPx * ux, rPx * uy, cx, cy);
    const a = numberAfter(lines, /面積|Area/);
    await viewer.screenshot({ path: path.join(OUT_DIR, `${s.id}-circle-${name.replace(/[^a-z0-9]/gi, "_")}.png`) });
    const nAnn = ((await viewer.evaluate(`window.__graphyDebug.getAnnotationCanvasPoints().length`)) as number);
    console.log(`  [diag] 注釈数 ${nAnn}, handles ${JSON.stringify(h?.points)}`);
    const r = h && h.points.length >= 2 ? dist(h.points[0], h.points[1]) : null;
    const t = r !== null ? Math.PI * r * r : null;
    console.log(`  Circle（縁が${name}）: 表示 ${a} mm² / π r² = ${t?.toFixed(2)} mm²（r = ${r?.toFixed(3)} mm, 意図 rp = ${rp.toFixed(3)}）`);
    // 半径の表示丸め（面積は小数 2 桁）以外の許容は置かない。
    check(a !== null && t !== null && Math.abs(a - t) / t <= 2e-3, `${s.id}: Circle（縁が${name}）の面積 = π r²（r はハンドル間の距離）`, { read: a, truth: t, lines });
  }

  // Ellipse: 4 ハンドル [下, 上, 左, 右]。真値 = π a b。
  {
    const { lines, h } = await draw(/楕円 ROI|Ellipse ROI/, "roi", 1.0 * rPx, 0.6 * rPx, cx, cy);
    const a = numberAfter(lines, /面積|Area/);
    let t: number | null = null;
    if (h && h.points.length >= 4) {
      const [bt, tp, lf, rt] = h.points;
      t = Math.PI * (dist(lf, rt) / 2) * (dist(bt, tp) / 2);
      console.log(`  Ellipse: 表示 ${a} mm² / π a b = ${t.toFixed(2)} mm²（a=${(dist(lf, rt) / 2).toFixed(3)}, b=${(dist(bt, tp) / 2).toFixed(3)} mm）`);
    }
    check(a !== null && t !== null && Math.abs(a - t) / t <= 2e-3, `${s.id}: Ellipse の面積 = π a b（a, b はハンドル間の距離）`, { read: a, truth: t, lines, handles: h?.points });
  }

  // Rectangle: 外接 bbox の辺 × 辺。平均は、矩形が球の断面の内側なら 場(中心) + 球の加算値。
  {
    const { lines, h } = await draw(/矩形 ROI|Rectangle ROI/, "roi", 1.2 * rPx, 0.8 * rPx, cx - 0.6 * rPx, cy - 0.4 * rPx);
    const a = numberAfter(lines, /面積|Area/);
    if (h && h.points.length >= 4) {
      const xs = h.points.map((p) => p[0]), ys = h.points.map((p) => p[1]);
      const w = (Math.max(...xs) - Math.min(...xs)) / pxPerMm, hh = (Math.max(...ys) - Math.min(...ys)) / pxPerMm;
      console.log(`  Rectangle: 表示 ${a} mm² / w×h = ${(w * hh).toFixed(2)} mm²（${w.toFixed(3)} × ${hh.toFixed(3)}）`);
      check(a !== null && Math.abs(a - w * hh) / (w * hh) <= 2e-3, `${s.id}: Rectangle の面積 = 幅 × 高さ（ハンドルから）`, { read: a, truth: w * hh, lines });
      const ctr = canvasToLps((Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2);
      const f = truth.field;
      const fc = f.A * ctr[0] + f.B * ctr[1] + f.C * ctr[2] + f.D + truth.sphere.addedValue;
      const mean = numberAfter(lines, /平均|Mean/);
      // 画素の拾い方（±1 画素）で平均が動く上限 = 場の勾配 × 画素寸法 + 格納の丸め
      const grad = Math.abs(f.A) * colMm0 + Math.abs(f.B) * rowMm0 + Math.abs(f.C) * 2.5;
      check(mean !== null && Math.abs(mean - fc) <= grad + s.rescale.slope / 2 + 0.05, `${s.id}: Rectangle 平均 = 矩形の中心（LPS）での場の値 ${fc.toFixed(2)}（球の内側）`, { read: mean, truth: fc, grad });
    } else {
      check(false, `${s.id}: Rectangle のハンドルが取れた`, h);
    }
  }
  await viewer.screenshot({ path: path.join(OUT_DIR, `${s.id}-rois.png`) });
  await viewer.close().catch(() => {});
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
