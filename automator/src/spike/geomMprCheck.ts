/*
 * MPR（3 断面ビュー）の画像表示の幾何検証（実アプリ。main）。
 *
 * 実行:  cd automator && GEOM_DRIVER=desktop GEOM_IDS=g0_iso,g1_aniso,g2_oblique,g3b_tilt_iop \
 *          MPR_SIZES=default,1280x800,max npx tsx src/spike/geomMprCheck.ts
 *   GEOM_DRIVER  desktop（Electron、既定）| web（chromium + jar 直）
 *   GEOM_IDS     検査する幾何。g3b_tilt_iop は truth.seriesExtra（IOP が傾いた実機型のチルト）
 *   MPR_SIZES    ウィンドウの大きさ（default | WxH | max）。大きさ違いは GEOM_SIZE_IDS の幾何だけ（既定 g0_iso,g1_aniso）
 *   GRAPHY_AUTOMATOR_{HTTP,SCP,VITE}_PORT / AUTOMATOR_DATA_DIR  専用ポート・データ
 *   出力  automator/.results/geom-mpr-check/<driver>/（スクリーンショット・results.json・measurements.json）
 *
 * 真値: scripts/make-geom-verify-phantom.py の truth.json（患者 LPS の解析形状。標識 M0〜M3）。
 * 画面の位置は **スクリーンショットの画素**（標識 = 最も明るい無彩色の小円盤の重心）から測る。アプリのホバー読み出し
 * （X/Y/Z）は「像の位置 → アプリの座標」の写像として使うが、真値にはしない（真値は truth のみ）。
 *   A1 canvas の内部サイズ vs CSS サイズ（M-1）・各要素の高さ
 *   A2 画面縮尺の縦横比: (a) 画像の外形÷物理 FOV（軸平行の g0/g1 のみ）、(b) 標識 2 点の画素差÷mm 差、(c) ホバーの縮尺
 *   A3 標識の像の位置（ホバー読み出し）− truth の LPS。許容 = その軸の 1 ボクセル + 1.5 CSS px（÷縮尺）+ 読み出しの丸め 0.05 mm
 *   A4 チルト補正チップの角 vs truth から求めたせん断角
 *   D  g3/g3b: 標識ごとのずれを、せん断モデル（ΔY = −(Z−z0)tanθ, ΔZ = (Z−z0)(1/cosθ−1)）と「原点一定」モデルに当てる
 * 結果は 合格 / 失敗 / 未達。
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { Page } from "@playwright/test";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { WebDriver } from "../driver/webDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { openFirstSeriesInViewer } from "../checklist/items/shared/helpers.js";
import { createStepRecorder } from "../checklist/types.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";

const DRIVER = (process.env.GEOM_DRIVER ?? "desktop") as "desktop" | "web";
const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "geom-mpr-check", DRIVER);
const IDS = (process.env.GEOM_IDS ?? "g0_iso,g1_aniso,g2_oblique,g3b_tilt_iop").split(",").map((s) => s.trim()).filter(Boolean);
const SIZES = (process.env.MPR_SIZES ?? "default").split(",").map((s) => s.trim()).filter(Boolean);
const SIZE_IDS = (process.env.GEOM_SIZE_IDS ?? "g0_iso,g1_aniso").split(",").map((s) => s.trim());

type Plane = "axial" | "sagittal" | "coronal";
const PLANES: Plane[] = ["axial", "sagittal", "coronal"]; // MprScreen のセルの順
/** 各断面の画面の横・縦に当たる LPS 軸（X=0,Y=1,Z=2）。解剖断面の定義。 */
const UV: Record<Plane, [number, number]> = { axial: [0, 1], coronal: [0, 2], sagittal: [1, 2] };
/** 中心スライスを通る面に乗る標識の組（C0 = (0,0,60) を通る面）。 */
const PAIR: Record<Plane, [string, string]> = { axial: ["M0", "M1"], coronal: ["M0", "M2"], sagittal: ["M1", "M2"] };

interface SeriesTruth {
  id: string; rows: number; cols: number; pixelSpacing: [number, number];
  iop: number[]; normal: number[]; ipps: number[][]; sops: string[]; dir: string; normalGapsMm: number[];
}
interface Truth {
  center: number[];
  markers: Record<string, { center: number[]; radiusMm: number }>;
  series: SeriesTruth[];
  seriesExtra: SeriesTruth[];
}
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const norm = (a: number[]) => Math.hypot(a[0], a[1], a[2]);
const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

// ───────── 検査の記録 ─────────
interface Res { id: string; status: "合格" | "失敗" | "未達"; label: string; expected?: unknown; measured?: unknown; diff?: unknown }
const items: Res[] = [];
const fmt = (x: unknown): unknown => (typeof x === "number" ? Math.round(x * 1000) / 1000 : Array.isArray(x) ? x.map(fmt) : x);
function ok(cond: boolean, id: string, label: string, expected?: unknown, measured?: unknown, diff?: unknown): void {
  items.push({ id, status: cond ? "合格" : "失敗", label, expected: fmt(expected), measured: fmt(measured), diff: fmt(diff) });
  console.log(`  [${cond ? "ok  " : "FAIL"}] ${label}${cond ? "" : ` — 期待 ${JSON.stringify(fmt(expected))} / 実測 ${JSON.stringify(fmt(measured))} / 差 ${JSON.stringify(fmt(diff))}`}`);
}
function skip(id: string, label: string, why: string): void {
  items.push({ id, status: "未達", label, measured: why });
  console.log(`  [未達] ${label} — ${why}`);
}
const info = (s: string) => console.log(`  ${s}`);

// ───────── ファントム ─────────
function makePhantom(): { dir: string; truth: Truth } {
  const dir = path.join(OUT_DIR, "phantom");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const seed = String(Date.now() % 1_000_000_000); // 毎回 UID を変える
  const r = spawnSync("python3", ["-I", path.join(AUTOMATOR_ROOT, "scripts", "make-geom-verify-phantom.py"), dir, "--uid-seed", seed], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`ファントム生成に失敗: ${r.stderr}`);
  return { dir, truth: JSON.parse(fs.readFileSync(path.join(dir, "truth.json"), "utf8")) as Truth };
}

// ───────── 画面から読む ─────────
interface Blob { cx: number; cy: number; area: number } // CSS px（ビューポート要素内）
const VP = `document.querySelectorAll('[data-testid="mpr-viewport"]')`;

/** ビューポート要素のスクリーンショットから、無彩色の白（l>=245）の連結領域（十字線の有彩色は除外。2px 膨らませて橋渡し）。 */
async function findWhiteBlobs(page: Page, idx: number, shotPath?: string): Promise<{ blobs: Blob[]; outline: { x0: number; x1: number; y0: number; y1: number } | null; cssW: number; cssH: number }> {
  const el = page.getByTestId("mpr-viewport").nth(idx);
  const png = await el.screenshot(shotPath ? { path: shotPath } : {});
  const b64 = png.toString("base64");
  return (await page.evaluate(`(async function(){
    var img=new Image(); img.src="data:image/png;base64,${b64}"; await img.decode();
    var c=document.createElement("canvas"); c.width=img.width; c.height=img.height;
    var ctx=c.getContext("2d"); ctx.drawImage(img,0,0);
    var d=ctx.getImageData(0,0,c.width,c.height).data, W=c.width, H=c.height;
    var r0=${VP}[${idx}].getBoundingClientRect(); var s=W/r0.width;
    var fg=new Uint8Array(W*H), nb=new Uint8Array(W*H);
    for(var i=0;i<W*H;i++){var r=d[i*4],g=d[i*4+1],b=d[i*4+2];
      var mx=Math.max(r,g,b),mn=Math.min(r,g,b),l=0.299*r+0.587*g+0.114*b;
      if(mx-mn<14){ if(l>=245) fg[i]=1; if(l>=1) nb[i]=1; } }
    // 外形: 非黒の画素が多い行・列（最大の半分以上）の範囲。ラベル文字・十字線を除く
    var rc=new Float32Array(H), cc=new Float32Array(W);
    for(var y=0;y<H;y++)for(var x=0;x<W;x++) if(nb[y*W+x]){rc[y]++;cc[x]++;}
    for(var x=0;x<W;x++) if(x<3||x>=W-3) cc[x]=0; for(var y=0;y<H;y++) if(y<3||y>=H-3) rc[y]=0; // セルの枠線
    function pct(a){var v=Array.prototype.filter.call(a,function(q){return q>0}).sort(function(p,q){return p-q});return v.length?v[Math.floor(v.length*0.8)]:0;}
    var mr=pct(rc),mc=pct(cc);
    var y0=-1,y1=-1,x0=-1,x1=-1;
    for(var y=0;y<H;y++) if(rc[y]>=0.5*mr){ if(y0<0)y0=y; y1=y+1; }
    for(var x=0;x<W;x++) if(cc[x]>=0.5*mc){ if(x0<0)x0=x; x1=x+1; }
    var outline = (mr>0&&mc>0)? {x0:x0/s,x1:x1/s,y0:y0/s,y1:y1/s} : null;
    var tmp=new Uint8Array(W*H), dil=new Uint8Array(W*H);
    for(var y=0;y<H;y++)for(var x=0;x<W;x++){var v=0;for(var k=-2;k<=2&&!v;k++){var xx=x+k;if(xx>=0&&xx<W&&fg[y*W+xx])v=1;}tmp[y*W+x]=v;}
    for(var y=0;y<H;y++)for(var x=0;x<W;x++){var v=0;for(var k=-2;k<=2&&!v;k++){var yy=y+k;if(yy>=0&&yy<H&&tmp[yy*W+x])v=1;}dil[y*W+x]=v;}
    var seen=new Uint8Array(W*H), out=[];
    for(var q=0;q<W*H;q++){ if(!dil[q]||seen[q])continue;
      var st=[q],n=0,sx=0,sy=0; seen[q]=1;
      while(st.length){var p=st.pop(),px=p%W,py=(p-px)/W;
        if(fg[p]){n++;sx+=px;sy+=py;}
        var nbs=[p-1,p+1,p-W,p+W];
        for(var k=0;k<4;k++){var m=nbs[k]; if(m<0||m>=W*H||!dil[m]||seen[m])continue; if(k<2&&Math.abs((m%W)-px)>1)continue; seen[m]=1; st.push(m);} }
      if(n>=15) out.push({cx:(sx/n+0.5)/s,cy:(sy/n+0.5)/s,area:n/(s*s)}); }
    return {blobs:out, outline:outline, cssW:r0.width, cssH:r0.height}; })()`)) as { blobs: Blob[]; outline: { x0: number; x1: number; y0: number; y1: number } | null; cssW: number; cssH: number };
}

type V3 = [number, number, number];
/** マウスを (px,py)（ビューポート要素内 CSS px）へ置き、ステータス行の X/Y/Z と値を読む。 */
async function hover(page: Page, idx: number, px: number, py: number): Promise<{ w: V3; value: number | null; raw: string } | null> {
  const box = await page.getByTestId("mpr-viewport").nth(idx).boundingBox();
  if (!box) return null;
  await page.mouse.move(box.x + px - 3, box.y + py - 3);
  await page.mouse.move(box.x + px, box.y + py, { steps: 2 });
  await page.waitForTimeout(220);
  const t = (await page.evaluate(`(function(){var e=Array.from(document.querySelectorAll('div')).filter(function(x){return /IJK/.test(x.innerText)&&x.innerText.length<160});return e.length?e[e.length-1].innerText:null})()`)) as string | null;
  if (!t) return null;
  const m = t.match(/X\s*(-?[\d.]+)\s*Y\s*(-?[\d.]+)\s*Z\s*(-?[\d.]+)/);
  if (!m) return null;
  const v = t.match(/Value\s*(-?[\d.]+)/);
  return { w: [Number(m[1]), Number(m[2]), Number(m[3])], value: v ? Number(v[1]) : null, raw: t.replace(/\s+/g, " ") };
}

interface CanvasInfo { bw: number; bh: number; cssw: number; cssh: number; dpr: number; hostH: number; hostW: number }
async function canvasInfo(page: Page): Promise<CanvasInfo[]> {
  return (await page.evaluate(`Array.from(${VP}).map(function(h){var c=h.querySelector('canvas');var r=c.getBoundingClientRect();var hr=h.getBoundingClientRect();
    return {bw:c.width,bh:c.height,cssw:r.width,cssh:r.height,dpr:devicePixelRatio,hostH:hr.height,hostW:hr.width}})`)) as CanvasInfo[];
}
/** ルート直下の各要素の高さ（ヘッダー・読み出し行・本体）。 */
async function rootHeights(page: Page): Promise<Array<{ h: number; txt: string }>> {
  return (await page.evaluate(`(function(){var cell=${VP}[0].parentElement;var body=cell.parentElement;var root=body.parentElement;
    return Array.from(root.children).map(function(e){return {h:e.getBoundingClientRect().height,txt:(e.innerText||'').slice(0,40).replace(/\\s+/g,' ')}})})()`)) as Array<{ h: number; txt: string }>;
}
async function chipText(page: Page): Promise<string | null> {
  return (await page.evaluate(`(function(){var e=Array.from(document.querySelectorAll('span')).filter(function(x){return /Gantry tilt|ガントリ/i.test(x.innerText)&&x.innerText.length<80});return e.length?e[0].innerText:null})()`)) as string | null;
}
async function crosshairPx(page: Page, idx: number): Promise<{ x: number | null; y: number | null }> {
  return (await page.evaluate(`(function(i){var h=${VP}[i];var xs=[],ys=[];Array.from(h.querySelectorAll('svg line')).forEach(function(l){
    var x1=+l.getAttribute('x1'),y1=+l.getAttribute('y1'),x2=+l.getAttribute('x2'),y2=+l.getAttribute('y2');
    if(Math.abs(x1-x2)<0.5)xs.push(x1); else if(Math.abs(y1-y2)<0.5)ys.push(y1);});
    function avg(a){return a.length?a.reduce(function(p,q){return p+q},0)/a.length:null}
    return {x:avg(xs),y:avg(ys)};})(${idx})`)) as { x: number | null; y: number | null };
}

// ───────── 測定 ─────────
interface MarkerMeas { name: string; px: [number, number]; hover: V3 | null; hoverC: V3 | null; value: number | null; area: number }
interface PlaneMeas {
  plane: Plane; cssW: number; cssH: number;
  markers: MarkerMeas[];
  outline: { wpx: number; hpx: number; cx: number; cy: number } | null;
  hoverScale: { su: number; sv: number } | null; // 画面 px / mm（ホバーから）
  crossPx: { x: number | null; y: number | null };
  blobCount: number;
}
interface StateMeas { label: string; canvas: CanvasInfo[]; planes: PlaneMeas[]; win: { iw: number; ih: number } }

async function measureState(page: Page, label: string, shotPrefix: string): Promise<StateMeas> {
  const canvas = await canvasInfo(page);
  const planes: PlaneMeas[] = [];
  const win = (await page.evaluate(`({iw:innerWidth,ih:innerHeight})`)) as { iw: number; ih: number };
  for (let i = 0; i < 3; i++) {
    const plane = PLANES[i];
    const { blobs, outline, cssW, cssH } = await findWhiteBlobs(page, i, `${shotPrefix}-${label}-${plane}.png`);
    const small = blobs.filter((b) => b.area >= 8 && b.area < 2500).sort((a, b) => b.area - a.area).slice(0, 4);
    const markers: MarkerMeas[] = [];
    const [ua, va] = UV[plane];
    const pair = PAIR[plane];
    const pairTruth = pair.map((k) => [curTruth!.markers[k].center[ua], curTruth!.markers[k].center[va]]);
    for (const b of small) {
      const h = await hover(page, i, b.cx, b.cy);
      if (!h) { markers.push({ name: "?", px: [b.cx, b.cy], hover: null, hoverC: null, value: null, area: b.area }); continue; }
      // 割り当て: 組の標識のうち、読み出しの面内座標が近いほう（標識どうしは 30 mm 以上離れている）
      const dd = pairTruth.map((t) => Math.hypot(h.w[ua] - t[0], h.w[va] - t[1]));
      const k = dd[0] <= dd[1] ? 0 : 1;
      // 伸縮補正: 像（CSS px）= 内部ビットマップ（canvas.width×height）を CSS 寸法へ拡縮したもの。内部座標に直した位置の読み出し
      const cv = canvas[i];
      const ix = b.cx * (cv.bw / cv.dpr / cv.cssw), iy = b.cy * (cv.bh / cv.dpr / cv.cssh);
      const hc = ix < cssW - 1 && iy < cssH - 1 ? await hover(page, i, ix, iy) : null;
      markers.push({ name: pair[k], px: [b.cx, b.cy], hover: h.w, hoverC: hc ? hc.w : null, value: h.value, area: b.area });
    }
    // 同じ標識に 2 つ割り当てられたら、読み出しが近いほうだけ残す
    const best = new Map<string, MarkerMeas>();
    for (const m of markers) {
      if (m.name === "?") continue;
      const t = curTruth!.markers[m.name].center;
      const e = m.hover ? Math.hypot(m.hover[ua] - t[ua], m.hover[va] - t[va]) : 1e9;
      const cur = best.get(m.name);
      const ce = cur && cur.hover ? Math.hypot(cur.hover[ua] - t[ua], cur.hover[va] - t[va]) : 1e9;
      if (!cur || e < ce) best.set(m.name, m);
    }
    // ホバーの縮尺（画面 px / mm）: 中心付近で ±60 px 離した 2 点の面内座標差
    let hoverScale: { su: number; sv: number } | null = null;
    {
      const cx = cssW / 2, cy = cssH / 2;
      const a = await hover(page, i, cx - 60, cy - 60), b = await hover(page, i, cx + 60, cy + 60);
      if (a && b && Math.abs(b.w[ua] - a.w[ua]) > 1 && Math.abs(b.w[va] - a.w[va]) > 1) {
        hoverScale = { su: 120 / (b.w[ua] - a.w[ua]), sv: 120 / (b.w[va] - a.w[va]) };
      }
    }
    planes.push({
      plane, cssW, cssH, markers: [...best.values()],
      outline: outline ? { wpx: outline.x1 - outline.x0, hpx: outline.y1 - outline.y0, cx: (outline.x0 + outline.x1) / 2, cy: (outline.y0 + outline.y1) / 2 } : null,
      hoverScale, crossPx: await crosshairPx(page, i), blobCount: small.length,
    });
  }
  await page.mouse.move(2, 2);
  return { label, canvas, planes, win };
}
let curTruth: Truth | null = null;

// ───────── 評価 ─────────
type Mut = "none" | "swapMarkers" | "shiftV5" | "swapSpacing";
interface Geo { s: SeriesTruth; voxel: number[]; cols: number; rows: number; depth: number; gap: number; axisAligned: boolean }

/** 各 LPS 軸方向のボクセルの大きさ（3 つのボクセル軸の、その軸への射影の最大）。 */
function voxelExtent(s: SeriesTruth): number[] {
  const rc = s.iop.slice(0, 3), rr = s.iop.slice(3);
  const [rowMm, colMm] = s.pixelSpacing;
  const gap = s.normalGapsMm.length ? Math.max(...s.normalGapsMm.map(Math.abs)) : 1;
  const stepDir = sub(s.ipps[1], s.ipps[0]);
  const sl = norm(stepDir);
  const out = [0, 0, 0];
  for (let a = 0; a < 3; a++) out[a] = Math.max(Math.abs(colMm * rc[a]), Math.abs(rowMm * rr[a]), Math.abs(sl * stepDir[a] / (sl || 1)));
  return out.map((v, a) => Math.max(v, 0.3 * (a === 2 ? gap : Math.max(rowMm, colMm)))); // 斜位でも 0 にならない下限
}

function evalPositions(st: StateMeas, g: Geo, tag: string, mut: Mut, quiet: boolean, which: "hover" | "hoverC" = "hover"): { fails: number; rows: string[] } {
  let fails = 0;
  const rows: string[] = [];
  const ext = voxelExtent(g.s);
  for (const p of st.planes) {
    const [ua, va] = UV[p.plane];
    const scalePx = p.hoverScale ? Math.min(Math.abs(p.hoverScale.su), Math.abs(p.hoverScale.sv)) : 3;
    for (const m of p.markers) {
      let tk = m.name;
      if (mut === "swapMarkers") tk = m.name === PAIR[p.plane][0] ? PAIR[p.plane][1] : PAIR[p.plane][0];
      const t = curTruth!.markers[tk].center;
      const tu = t[ua], tv = t[va] + (mut === "shiftV5" ? 5 : 0);
      const hv = m[which];
      if (!hv) continue;
      const eu = hv[ua] - tu, ev = hv[va] - tv;
      const tolU = ext[ua] + 1.5 / scalePx + 0.05, tolV = ext[va] + 1.5 / scalePx + 0.05;
      const pass = Math.abs(eu) <= tolU && Math.abs(ev) <= tolV;
      if (!pass) fails++;
      rows.push(`${p.plane} ${m.name}: 真値(${tu.toFixed(1)},${tv.toFixed(1)}) 像→読み出し(${hv[ua].toFixed(2)},${hv[va].toFixed(2)}) 差(${eu.toFixed(2)},${ev.toFixed(2)}) 許容(${tolU.toFixed(2)},${tolV.toFixed(2)})`);
      if (!quiet) ok(pass, `${tag}:pos${which === "hoverC" ? "C" : ""}-${p.plane}-${m.name}`, `${tag}: ${p.plane} で標識 ${m.name} の像の位置（${which === "hoverC" ? "伸縮補正したホバー読み出し" : "ホバー読み出し"}）が truth の LPS (${tu.toFixed(1)}, ${tv.toFixed(1)}) と一致（1 ボクセル + 1.5 CSS px）`, [tu, tv], [hv[ua], hv[va]], [eu, ev]);
    }
  }
  return { fails, rows };
}

/** 標識 2 点の画素差 ÷ mm 差 から画面縮尺（px/mm）の縦横比。 */
function markerAspect(p: PlaneMeas): { su: number; sv: number; aspect: number; tol: number } | null {
  const [ua, va] = UV[p.plane];
  const [n0, n1] = PAIR[p.plane];
  const a = p.markers.find((m) => m.name === n0), b = p.markers.find((m) => m.name === n1);
  if (!a || !b) return null;
  const t0 = curTruth!.markers[n0].center, t1 = curTruth!.markers[n1].center;
  const du = Math.abs(t1[ua] - t0[ua]), dv = Math.abs(t1[va] - t0[va]);
  const dpu = Math.abs(b.px[0] - a.px[0]), dpv = Math.abs(b.px[1] - a.px[1]);
  const su = dpu / du, sv = dpv / dv;
  // 重心の誤差: 標識の離散化 0.5 ボクセル相当（約 1 mm）+ 1.5 CSS px を各端に
  const px = (su + sv) / 2;
  const e = 1.5 + 0.5 * px; // CSS px
  return { su, sv, aspect: sv / su, tol: Math.SQRT2 * e * (1 / dpu + 1 / dpv) };
}

function evalState(st: StateMeas, g: Geo, tag: string): void {
  const [rowMm, colMm] = g.s.pixelSpacing;
  // A1
  st.canvas.forEach((c, i) => {
    const dw = c.bw - c.cssw * c.dpr, dh = c.bh - c.cssh * c.dpr;
    ok(Math.abs(dw) <= 1.5 && Math.abs(dh) <= 1.5, `${tag}:A1-${PLANES[i]}`, `${tag}: ${PLANES[i]} の canvas の内部サイズ = CSS 寸法×DPR`, [Math.round(c.cssw * c.dpr), Math.round(c.cssh * c.dpr)], [c.bw, c.bh], [dw, dh]);
  });
  // A2
  for (const p of st.planes) {
    const ma = markerAspect(p);
    if (!ma) { skip(`${tag}:A2m-${p.plane}`, `${tag}: ${p.plane} の標識 2 点から縦横比を求める`, `標識の像が組（${PAIR[p.plane].join(",")}）で揃わない（見つかった: ${p.markers.map((m) => m.name).join(",") || "なし"}）`); }
    else {
      info(`${p.plane} 標識の画面縮尺 su=${ma.su.toFixed(3)} sv=${ma.sv.toFixed(3)} px/mm 縦横比 ${ma.aspect.toFixed(4)}（許容 ±${ma.tol.toFixed(4)}）`);
      ok(Math.abs(ma.aspect - 1) <= ma.tol, `${tag}:A2m-${p.plane}`, `${tag}: ${p.plane} の画面縮尺の縦横比（標識 2 点の画素差÷mm 差）= 1`, 1, ma.aspect, ma.aspect - 1);
    }
    if (p.hoverScale) {
      const r = Math.abs(p.hoverScale.sv / p.hoverScale.su);
      info(`${p.plane} ホバーの縮尺 su=${p.hoverScale.su.toFixed(3)} sv=${p.hoverScale.sv.toFixed(3)} px/mm（符号付き）縦横比 ${r.toFixed(4)}`);
      ok(Math.abs(r - 1) < 0.01, `${tag}:A2h-${p.plane}`, `${tag}: ${p.plane} のホバーの座標写像の縦横比 = 1（< 1%）`, 1, r, r - 1);
      if (ma) {
        const ri = ma.su / Math.abs(p.hoverScale.su), rj = ma.sv / Math.abs(p.hoverScale.sv);
        const tolC = Math.max(0.02, ma.tol); // 標識 2 点の重心の精度（1 ボクセル + 1.5 px ÷ 標識間の距離）から導いた許容。斜めの断面では 2% より広い
        ok(Math.abs(ri - 1) <= tolC && Math.abs(rj - 1) <= tolC, `${tag}:A2c-${p.plane}`, `${tag}: ${p.plane} の像の縮尺（標識）= ホバー写像の縮尺（標識の重心の精度から導いた許容。最小 2%）。ずれていれば像とホバーの写像が食い違う`, [1, 1], [ri, rj], [ri - 1, rj - 1]);
      }
    }
    // 外形（軸平行の g0/g1 のみ）
    // ウィンドウを ready の後に縮めた状態（default 以外）は、カメラを保つので画像が窓より大きくなって外形が欠けうる。外形に頼る検査は default だけ。
    if (p.outline && (g.s.id === "g0_iso" || g.s.id === "g1_aniso") && tag.endsWith("/default")) {
      const [W1, H1, W2, H2] = outlineMm(p.plane, g, colMm, rowMm);
      const r1 = p.outline.hpx / H1 / (p.outline.wpx / W1), r2 = p.outline.hpx / H2 / (p.outline.wpx / W2);
      const tol = Math.abs(r1 - r2) + 2 / p.outline.wpx + 2 / p.outline.hpx;
      const r = (r1 + r2) / 2;
      info(`${p.plane} 外形 ${p.outline.wpx.toFixed(1)}×${p.outline.hpx.toFixed(1)} px、縦横比 ${r1.toFixed(4)}（辺の数え方 n）/ ${r2.toFixed(4)}（n−1）許容 ±${tol.toFixed(4)}`);
      ok(Math.abs(r - 1) <= tol, `${tag}:A2o-${p.plane}`, `${tag}: ${p.plane} の画像の外形の縦横比（外形÷物理 FOV）= 1`, 1, r, r - 1);
      // A3i: 像の位置を、画像の外形（物理 FOV と対応）だけから求めた画面縮尺で mm に直し、truth の LPS と比べる（ホバー読み出しを使わない）
      if (p.hoverScale) {
        const [ua, va] = UV[p.plane];
        const C = curTruth!.center;
        const ext = voxelExtent(g.s);
        const su = p.outline.wpx / ((W1 + W2) / 2), sv = p.outline.hpx / ((H1 + H2) / 2);
        const sgnU = Math.sign(p.hoverScale.su), sgnV = Math.sign(p.hoverScale.sv); // 向きだけ表示（R/L・H/F ラベル）に従う
        for (const m of p.markers) {
          const t = curTruth!.markers[m.name].center;
          const mu = C[ua] + sgnU * (m.px[0] - p.outline.cx) / su, mv = C[va] + sgnV * (m.px[1] - p.outline.cy) / sv;
          const eu = mu - t[ua], ev = mv - t[va];
          const tolU = ext[ua] + (3 / su) + Math.abs(W1 - W2) / 2, tolV = ext[va] + (3 / sv) + Math.abs(H1 - H2) / 2;
          ok(Math.abs(eu) <= tolU && Math.abs(ev) <= tolV, `${tag}:A3i-${p.plane}-${m.name}`, `${tag}: ${p.plane} で標識 ${m.name} の像の位置（画像の外形から求めた縮尺・中心。ホバー不使用）が truth の LPS (${t[ua].toFixed(1)}, ${t[va].toFixed(1)}) と一致`, [t[ua], t[va]], [mu, mv], [eu, ev]);
        }
      }
    }
  }
  // A3
  evalPositions(st, g, tag, "none", false);
  evalPositions(st, g, tag, "none", false, "hoverC");
  // 十字線と像（標識から求めた C0 の画面位置）の一致（軸位）
  const ax = st.planes[0];
  const ma = markerAspect(ax);
  const a = ax.markers.find((m) => m.name === "M0"), b = ax.markers.find((m) => m.name === "M1");
  if (ma && a && b && ax.crossPx.x !== null && ax.crossPx.y !== null) {
    const t0 = curTruth!.markers.M0.center, t1 = curTruth!.markers.M1.center, C = curTruth!.center;
    const sx = (b.px[0] - a.px[0]) / (t1[0] - t0[0]), sy = (b.px[1] - a.px[1]) / (t1[1] - t0[1]);
    const cx = a.px[0] + sx * (C[0] - t0[0]), cy = a.px[1] + sy * (C[1] - t0[1]);
    const e = Math.hypot(cx - ax.crossPx.x, cy - ax.crossPx.y);
    ok(e <= 1.5 + 0.5 * (Math.abs(sx) + Math.abs(sy)) / 2 + 1.5, `${tag}:A3x`, `${tag}: 軸位の十字線の交点 = 像から求めた C0 の画面位置（標識 M0・M1 の像で外挿）`, [cx, cy], [ax.crossPx.x, ax.crossPx.y], [cx - ax.crossPx.x, cy - ax.crossPx.y]);
  } else skip(`${tag}:A3x`, `${tag}: 軸位の十字線の交点 = 像から求めた C0 の画面位置`, "標識 M0・M1 の像か十字線の svg line が取れない");
}

function outlineMm(plane: Plane, g: Geo, colMm: number, rowMm: number): [number, number, number, number] {
  const gap = g.s.normalGapsMm[0];
  const nz = g.depth;
  if (plane === "axial") return [g.cols * colMm, g.rows * rowMm, (g.cols - 1) * colMm, (g.rows - 1) * rowMm];
  if (plane === "coronal") return [g.cols * colMm, nz * gap, (g.cols - 1) * colMm, (nz - 1) * gap];
  return [g.rows * rowMm, nz * gap, (g.rows - 1) * rowMm, (nz - 1) * gap];
}

// ───────── ウィンドウ操作 ─────────
type Win = { type: "default" } | { type: "max" } | { type: "size"; w: number; h: number };
const parseSize = (s: string): Win => (s === "default" ? { type: "default" } : s === "max" ? { type: "max" } : { type: "size", w: Number(s.split("x")[0]), h: Number(s.split("x")[1]) });

let drv: DesktopDriver | WebDriver;
async function setWindow(page: Page, w: Win): Promise<void> {
  if (w.type === "default") return;
  if (DRIVER === "web") {
    const vs = w.type === "max" ? { width: 1920, height: 1080 } : { width: w.w, height: w.h };
    await page.setViewportSize(vs);
    return;
  }
  await (drv as DesktopDriver).app.evaluate(({ BrowserWindow }, a) => {
    for (const bw of BrowserWindow.getAllWindows()) {
      if (!bw.webContents.getURL().includes("mpr")) continue;
      if (a.max) bw.maximize();
      else { if (bw.isMaximized()) bw.unmaximize(); bw.setSize(a.w, a.h); }
    }
  }, { max: w.type === "max", w: w.type === "size" ? w.w : 0, h: w.type === "size" ? w.h : 0 });
  await page.waitForTimeout(600);
}
/** 内側の高さを dh だけ変える（ready 後の変更）。 */
async function resizeBy(page: Page, dw: number, dh: number): Promise<void> {
  const cur = (await page.evaluate(`({w:innerWidth,h:innerHeight})`)) as { w: number; h: number };
  if (DRIVER === "web") { await page.setViewportSize({ width: cur.w + dw, height: cur.h + dh }); return; }
  await (drv as DesktopDriver).app.evaluate(({ BrowserWindow }, a) => {
    for (const bw of BrowserWindow.getAllWindows()) {
      if (!bw.webContents.getURL().includes("mpr")) continue;
      if (bw.isMaximized()) bw.unmaximize();
      const s = bw.getContentSize();
      bw.setContentSize(s[0] + a.dw, s[1] + a.dh);
    }
  }, { dw, dh });
  await page.waitForTimeout(800);
}

// ───────── 1 回の MPR ─────────
const allMeas: Record<string, unknown> = {};

async function openMpr(main: Page, win: Win): Promise<{ mpr: Page; trace: Array<Record<string, number>> }> {
  const d = drv;
  const mpr = await d.waitForNewPage(() => main.locator('button[title="MPR Viewer"]').click(), (url) => url.includes("mpr"));
  mpr.on("dialog", (dlg) => void dlg.accept().catch(() => {}));
  // ready までの canvas とセルの高さの推移（M-1 の由来の確認）
  await mpr.evaluate(`(function(){window.__tr=[];var t0=performance.now();window.__trT=setInterval(function(){
    var v=document.querySelector('[data-testid="mpr-viewport"]'); if(!v)return; var c=v.querySelector('canvas'); var r=v.getBoundingClientRect();
    window.__tr.push({t:Math.round(performance.now()-t0),cellH:r.height,bh:c?c.height:0,ch:c?c.getBoundingClientRect().height:0,ready:document.querySelector('[data-testid="mpr-slab-projection"]')?1:0});},40);})()`).catch(() => {});
  await setWindow(mpr, win);
  await mpr.getByTestId("mpr-slab-projection").waitFor({ state: "visible", timeout: 120_000 });
  await mpr.waitForTimeout(4000);
  const trace = (await mpr.evaluate(`(function(){clearInterval(window.__trT);return window.__tr})()`)) as Array<Record<string, number>>;
  return { mpr, trace };
}

async function nudgeUntilFixed(page: Page): Promise<string> {
  const fixed = async () => (await canvasInfo(page)).every((c) => Math.abs(c.bw - c.cssw * c.dpr) <= 1.5 && Math.abs(c.bh - c.cssh * c.dpr) <= 1.5);
  await page.evaluate(`window.dispatchEvent(new Event('resize'))`);
  await page.waitForTimeout(1500);
  if (await fixed()) return "window の resize イベント";
  await page.evaluate(`(function(){Array.from(${VP}).forEach(function(h){var p=h.parentElement;var o=p.style.width;var r=p.getBoundingClientRect();p.style.width=(r.width-3)+"px";setTimeout(function(){p.style.width=o;},500);});})()`);
  await page.waitForTimeout(1800);
  if (await fixed()) return "セルの幅の一時変更";
  await resizeBy(page, 0, 1); await resizeBy(page, 0, -1);
  await page.waitForTimeout(1500);
  if (await fixed()) return "ウィンドウ高さ +1/−1 px";
  return "解消せず";
}

async function runOne(main: Page, dir: string, truth: Truth, s: SeriesTruth, win: Win, winLabel: string, full: boolean): Promise<void> {
  const tag = `${DRIVER}/${s.id}/${winLabel}`;
  console.log(`\n=== ${tag} ===`);
  curTruth = truth;
  const [rowMm, colMm] = s.pixelSpacing;
  const g: Geo = { s, voxel: voxelExtent(s), cols: s.cols, rows: s.rows, depth: s.ipps.length, gap: s.normalGapsMm[0], axisAligned: s.id === "g0_iso" || s.id === "g1_aniso" };
  void rowMm; void colMm;
  const shot = path.join(OUT_DIR, `${s.id}-${winLabel}`);

  const { mpr, trace } = await openMpr(main, win);
  try {
    // ready 前後のセルの高さと canvas の内部高さの推移
    const pre = trace.filter((r) => !r.ready && r.bh > 0);
    const post = trace.filter((r) => r.ready);
    const rh = await rootHeights(mpr);
    info(`ルート直下の高さ: ${rh.map((r) => `${r.h.toFixed(0)}(${r.txt.slice(0, 14)})`).join(" | ")}`);
    if (pre.length && post.length) {
      const preCell = pre[pre.length - 1].cellH, postCell = post[post.length - 1].cellH;
      info(`ready 前（canvas 生成後）のセル高さ ${preCell.toFixed(1)} → ready 後 ${postCell.toFixed(1)}（縮み ${(preCell - postCell).toFixed(1)} px）。canvas 内部高さ ${pre[pre.length - 1].bh}`);
    } else info(`推移の記録が足りない（前 ${pre.length} / 後 ${post.length} 点）`);
    allMeas[`${tag}:trace`] = { pre: pre.slice(-3), post: post.slice(0, 3), rootHeights: rh };

    const st0 = await measureState(mpr, "asis", shot);
    allMeas[`${tag}:asis`] = st0;
    const c0 = st0.canvas[0];
    info(`canvas ${c0.bw}×${c0.bh}（内部）/ CSS ${c0.cssw.toFixed(1)}×${c0.cssh.toFixed(1)}、DPR ${c0.dpr}、差 ${(c0.bh - c0.cssh * c0.dpr).toFixed(1)} px、ウィンドウ内側 ${st0.win.iw}×${st0.win.ih}`);
    if (full || g.axisAligned) {
      console.log(`  -- 既定のまま --`);
      evalState(st0, g, `${tag}:asis`);
    } else {
      // サイズ違いの実行では A1 だけ
      st0.canvas.forEach((c, i) => ok(Math.abs(c.bh - c.cssh * c.dpr) <= 1.5 && Math.abs(c.bw - c.cssw * c.dpr) <= 1.5, `${tag}:asis:A1-${PLANES[i]}`, `${tag}: ${PLANES[i]} の canvas の内部サイズ = CSS×DPR`, [c.cssw * c.dpr, c.cssh * c.dpr], [c.bw, c.bh]));
    }
    // A4 チップ
    const chip = await chipText(mpr);
    const shear = shearDeg(s);
    info(`チルト補正チップ: ${JSON.stringify(chip)}（truth のせん断角 ${shear.toFixed(2)}°）`);
    if (shear > 0.5) {
      const m = chip?.match(/(-?[\d.]+)°/);
      ok(!!chip && !!m && Math.abs(Math.abs(Number(m[1])) - shear) <= 0.1, `${tag}:A4`, `${tag}: チルト補正チップの角 = truth から求めたせん断角`, shear, m ? Number(m[1]) : chip, m ? Math.abs(Number(m[1])) - shear : null);
    } else ok(chip === null, `${tag}:A4`, `${tag}: チルトの無い幾何ではチップが出ない`, null, chip);

    if (full) {
      // 負例（検査器が効くこと）: 既定のままの測定を、真値を壊して突き合わせ直す。正例が通る状態でだけ意味がある。
      const base = evalPositions(st0, g, tag, "none", true, "hoverC");
      if (base.fails === 0 && st0.planes.some((p) => p.markers.length)) {
        for (const mut of ["swapMarkers", "shiftV5"] as Mut[]) {
          const r = evalPositions(st0, g, tag, mut, true, "hoverC");
          ok(r.fails > 0, `${tag}:neg-${mut}`, `${tag}: 負例（真値を壊す: ${mut}）で位置の検査が落ちる`, "失敗が出る", `失敗 ${r.fails} 件`);
        }
      } else skip(`${tag}:neg`, `${tag}: 負例（位置の検査の検出力）`, `既定のままの位置の検査が既に落ちている/標識が無い（正例が通らないので負例は意味がない）`);
      // 外形の負例（g1 の行/列間隔の入れ替え）
      const ax = st0.planes[0];
      if (s.id === "g1_aniso" && ax.outline) {
        const [W1, H1] = outlineMm("axial", g, rowMm, colMm); // 入れ替えた真値
        const r1 = ax.outline.hpx / H1 / (ax.outline.wpx / W1);
        const tol = 2 / ax.outline.wpx + 2 / ax.outline.hpx + 0.01;
        ok(Math.abs(r1 - 1) > tol, `${tag}:neg-swapSpacing`, `${tag}: 負例（行/列間隔を入れ替えた真値）で外形の縦横比の検査が落ちる`, "|縦横比−1| > 許容", r1);
      }
    }

    // ready 後にウィンドウ高さを変える（差が一定か、変えた量だけ動くか）
    if (full || g.axisAligned) {
      await resizeBy(mpr, 0, -100);
      const cs1 = await canvasInfo(mpr);
      const w1 = (await mpr.evaluate(`({iw:innerWidth,ih:innerHeight})`)) as { iw: number; ih: number };
      info(`ready 後に内側高さを ${st0.win.ih}→${w1.ih} へ: canvas 内部 ${cs1[0].bh}（変化 ${cs1[0].bh - c0.bh}）/ CSS ${cs1[0].cssh.toFixed(1)}（変化 ${(cs1[0].cssh - c0.cssh).toFixed(1)}）/ 差 ${(cs1[0].bh - cs1[0].cssh * cs1[0].dpr).toFixed(1)}`);
      allMeas[`${tag}:afterShrink`] = { win: w1, canvas: cs1 };
      const grew = (cs1[0].bh - cs1[0].cssh * cs1[0].dpr) - (c0.bh - c0.cssh * c0.dpr);
      ok(Math.abs(cs1[0].bh - cs1[0].cssh * cs1[0].dpr) <= 1.5, `${tag}:neg-A1-resize`, `${tag}: （ready 後に高さを変えた状態）canvas の内部サイズ = CSS×DPR。変えた量だけ差が動くなら落ちる（リサイズ未対応の証拠）`, 0, cs1[0].bh - cs1[0].cssh * cs1[0].dpr, grew);
      await resizeBy(mpr, 0, 100);
    }

    // M-1 の由来の仮説試験: 読み出し行を隠す → さらにヘッダーの操作部（select 等）を隠す（= ready 前と同じレイアウト）。
    // 差（canvas 内部高さ − CSS 高さ）が 36 → 7 → 0 へ減れば、差は「ready 後に増えた行の高さ」で説明できる。
    {
      const diff = async () => { const c = (await canvasInfo(mpr))[0]; return { d: c.bh - c.cssh * c.dpr, css: c.cssh }; };
      const d0 = await diff();
      const rhs = await rootHeights(mpr);
      await mpr.evaluate(`(function(){var root=${VP}[0].parentElement.parentElement.parentElement;window.__hid=[];
        var ro=root.children[1]; if(ro && /Hover|X /.test(ro.innerText)){window.__hid.push([ro,ro.style.display]);ro.style.display='none';}})()`);
      await mpr.waitForTimeout(500);
      const d1 = await diff();
      await mpr.evaluate(`(function(){var root=${VP}[0].parentElement.parentElement.parentElement;var hd=root.children[0];
        Array.from(hd.querySelectorAll('label')).forEach(function(l){window.__hid.push([l,l.style.display]);l.style.display='none';});})()`);
      await mpr.waitForTimeout(500);
      const d2 = await diff();
      await mpr.evaluate(`(function(){(window.__hid||[]).forEach(function(p){p[0].style.display=p[1];});})()`);
      await mpr.waitForTimeout(400);
      info(`[M-1 仮説試験] 差 ${d0.d.toFixed(1)} px（ルート直下の高さ ${rhs.map((r) => r.h.toFixed(0)).join("/")}）→ 読み出し行を隠す ${d1.d.toFixed(1)} → ヘッダーの操作部も隠す ${d2.d.toFixed(1)}`);
      allMeas[`${tag}:m1-hypothesis`] = { before: d0, noReadout: d1, noReadoutNoControls: d2, rootHeights: rhs };
      ok(Math.abs(d2.d) <= 1.5, `${tag}:M1-hyp`, `${tag}: ready 後に増えた行（読み出し行・ヘッダーの操作部）を隠すと canvas の内部高さ = CSS 高さ（差の由来の仮説）`, 0, d2.d, [d0.d, d1.d, d2.d]);
    }

    // M-1 の解消を促して測り直す
    const stale = (await canvasInfo(mpr)).some((c) => Math.abs(c.bh - c.cssh * c.dpr) > 1.5 || Math.abs(c.bw - c.cssw * c.dpr) > 1.5);
    if (stale) {
      const how = await nudgeUntilFixed(mpr);
      info(`[M-1 解消を促す] ${how}`);
      allMeas[`${tag}:nudge`] = how;
      if (how !== "解消せず" && full) {
        const st1 = await measureState(mpr, "resolved", shot);
        allMeas[`${tag}:resolved`] = st1;
        console.log(`  -- リサイズを促して canvas が一致した後 --`);
        evalState(st1, g, `${tag}:resolved`);
      } else if (how === "解消せず") {
        skip(`${tag}:resolved`, `${tag}: M-1 を解消した状態での位置の検査`, "リサイズを促しても canvas が一致しない");
      }
    } else info("canvas は最初から一致しており、解消の操作は不要");

    // D: チルトのずれ
    if (full && shear > 0.5) await tiltAnalysis(st0, g, tag, shear);
    await mpr.screenshot({ path: path.join(OUT_DIR, `${s.id}-${winLabel}-page.png`) });
  } finally {
    await mpr.close().catch(() => {});
  }
}

function shearDeg(s: SeriesTruth): number {
  const n = cross(s.iop.slice(0, 3), s.iop.slice(3));
  const v = sub(s.ipps[s.ipps.length - 1], s.ipps[0]);
  const c = Math.abs(dot(n, v)) / (norm(n) * norm(v));
  return (Math.acos(Math.min(1, c)) * 180) / Math.PI;
}

async function tiltAnalysis(st: StateMeas, g: Geo, tag: string, shearDegV: number): Promise<void> {
  console.log(`  -- D: チルトのずれ（既定のまま。伸縮補正したホバー読み出しで。素の値も併記）--`);
  const th = (shearDegV * Math.PI) / 180;
  const z0 = g.s.ipps[0][2];
  const rowsOut: string[] = [];
  const pts: Array<{ k: string; plane: Plane; dY: number | null; dZ: number | null; dX: number | null; trueZ: number }> = [];
  for (const p of st.planes) {
    const [ua, va] = UV[p.plane];
    for (const m of p.markers) {
      if (!m.hoverC) continue;
      const t = curTruth!.markers[m.name].center;
      const d = [0, 0, 0].map((_, a) => (a === ua || a === va) ? m.hoverC![a] - t[a] : NaN);
      const raw = m.hover ? [0, 0, 0].map((_, a) => (a === ua || a === va) ? m.hover![a] - t[a] : NaN) : null;
      if (raw) rowsOut.push(`  （素のホバー読み出し ${p.plane} ${m.name}: ΔX=${isNaN(raw[0]) ? "-" : raw[0].toFixed(2)} ΔY=${isNaN(raw[1]) ? "-" : raw[1].toFixed(2)} ΔZ=${isNaN(raw[2]) ? "-" : raw[2].toFixed(2)}）`);
      pts.push({ k: m.name, plane: p.plane, dX: isNaN(d[0]) ? null : d[0], dY: isNaN(d[1]) ? null : d[1], dZ: isNaN(d[2]) ? null : d[2], trueZ: t[2] });
      rowsOut.push(`${p.plane} ${m.name}（真値 Z=${t[2]}）: ΔX=${isNaN(d[0]) ? "-" : d[0].toFixed(2)} ΔY=${isNaN(d[1]) ? "-" : d[1].toFixed(2)} ΔZ=${isNaN(d[2]) ? "-" : d[2].toFixed(2)}`);
    }
  }
  rowsOut.forEach((r) => info(r));
  allMeas[`${tag}:tilt-points`] = pts;
  const yPts = pts.filter((q) => q.dY !== null);
  if (yPts.length < 2) { skip(`${tag}:D-model`, `${tag}: チルトのずれをせん断モデルと原点一定モデルに当てる`, `ΔY が取れた標識が ${yPts.length} 個（中心スライスに乗る標識が足りない）`); return; }
  // モデル
  const shearY = (Z: number) => -(Z - z0) * Math.tan(th);
  const shearZ = (Z: number) => (Z - z0) * (1 / Math.cos(th) - 1);
  const resShear = yPts.map((q) => q.dY! - shearY(q.trueZ));
  const meanY = yPts.reduce((a, q) => a + q.dY!, 0) / yPts.length;
  const resConst = yPts.map((q) => q.dY! - meanY);
  const rms = (a: number[]) => Math.sqrt(a.reduce((s, x) => s + x * x, 0) / a.length);
  info(`ΔY の残差 rms: せん断モデル ${rms(resShear).toFixed(2)} mm / 原点一定モデル（平均 ${meanY.toFixed(2)}）${rms(resConst).toFixed(2)} mm / ずれ無し（0）${rms(yPts.map((q) => q.dY!)).toFixed(2)} mm`);
  const zPts = pts.filter((q) => q.dZ !== null);
  if (zPts.length) {
    const rz = zPts.map((q) => q.dZ! - shearZ(q.trueZ));
    info(`ΔZ: せん断モデルの予測との残差 rms ${rms(rz).toFixed(2)} mm / ずれ無し ${rms(zPts.map((q) => q.dZ!)).toFixed(2)} mm`);
  }
  const noShift = rms(yPts.map((q) => q.dY!));
  ok(noShift <= 1.5, `${tag}:D-zero`, `${tag}: 標識の像のずれ（ΔY）が 1.5 mm 以内（補正が正しければ 0）`, 0, noShift);
  skip(`${tag}:D-model-info`, `${tag}: モデルの当てはめ（情報）`, `せん断 rms ${rms(resShear).toFixed(2)} / 原点一定 rms ${rms(resConst).toFixed(2)} / 0 rms ${noShift.toFixed(2)}（合否ではなく切り分けの数値）`);
}

// ───────── main ─────────
async function startDriver(): Promise<void> {
  for (let n = 1; n <= 3; n++) {
    try {
      // web: インポート API（standalone プロファイル）が要るので shooting 指定で standalone で起動。画面 1280×720・英語
      drv = DRIVER === "web" ? new WebDriver({}, { viewport: { width: 1280, height: 720 }, locale: "en-US" }) : new DesktopDriver();
      await drv.start();
      return;
    } catch (e) {
      console.log(`  [start] 失敗（${n}/3）: ${String(e).slice(0, 160)}`);
      await drv!.stop().catch(() => {});
      if (n === 3) throw e;
    }
  }
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const { dir, truth } = makePhantom();
  await startDriver();
  try {
    drv.page.on("console", (m) => { if (m.type() === "error") console.log(`  [renderer error] ${m.text().slice(0, 160)}`); });
    for (const id of IDS) {
      const s = truth.series.find((x) => x.id === id) ?? truth.seriesExtra.find((x) => x.id === id);
      if (!s) { skip(`${id}:truth`, `${id}: truth にある`, "truth に無い"); continue; }
      await resetDb(drv.ports.http);
      const files = fs.readdirSync(path.join(dir, s.dir)).filter((f) => f.endsWith(".dcm")).sort().map((f) => path.join(dir, s.dir, f));
      const imp = await importPaths(drv.ports.http, files);
      ok(imp.imported === files.length && imp.failed === 0, `${id}:import`, `${id}: ${files.length} 枚を取り込めた`, files.length, imp.imported);
      const main = drv.page;
      for (let n = 1; n <= 3; n++) {
        await main.reload().catch(() => {});
        try { await main.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 40_000 }); break; } catch (e) { if (n === 3) throw e; info(`[main] 再読み込み後に検索欄が出ない（${n}/3）。再試行`); }
      }
      await openFirstSeriesInViewer(main, createStepRecorder());
      const sizes = SIZES.filter((sz, i) => i === 0 || SIZE_IDS.includes(id));
      for (const sz of sizes) {
        const win = parseSize(sz);
        await runOne(main, dir, truth, s, win, sz, sz === SIZES[0]);
      }
    }
  } finally {
    await drv.stop().catch(() => {});
    fs.writeFileSync(path.join(OUT_DIR, "results.json"), JSON.stringify(items, null, 1));
    fs.writeFileSync(path.join(OUT_DIR, "measurements.json"), JSON.stringify(allMeas, null, 1));
  }
  const n = (s: string) => items.filter((i) => i.status === s).length;
  console.log(`\n合格 ${n("合格")} / 失敗 ${n("失敗")} / 未達 ${n("未達")}`);
  for (const i of items.filter((x) => x.status === "失敗")) console.log(`  失敗: ${i.label} — 期待 ${JSON.stringify(i.expected)} 実測 ${JSON.stringify(i.measured)} 差 ${JSON.stringify(i.diff)}`);
  for (const i of items.filter((x) => x.status === "未達")) console.log(`  未達: ${i.label} — ${JSON.stringify(i.measured)}`);
}

main().catch((e) => { console.error(e); process.exit(2); });
