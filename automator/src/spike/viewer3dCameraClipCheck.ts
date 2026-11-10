/*
 * 3D ビューアの「視点を患者座標で当てる」「任意平面でクリップする」の実アプリ検査（本体の内部の土台）。
 *
 * 球だけの合成 CT（空気の立方体・中心が LPS 原点）を取り込み、実際の 3D ビューア（vtk.js の MIP・平行投影）を開いて、
 * dev 用の口 `__graphyDebug.applyViewer3dCamera` / `setViewer3dClipPlanes` で視点とクリップ面を当て、
 * **描かれた画素**（canvas）で判定する。DOM や数値だけでは黒い画面や符号の取り違えを通す。
 *
 * 球の配置は式で置く（本体の関数では作らない）。視線 d=(1,2,−2)/3 は軸に平行でなく、上は d に直交でない (0,0,1)
 * を渡す（本体が直交化する）。画面右 = d × 上。平行投影なので、球の画面位置は (p·右, p·上) になる。
 *
 * 実行:  cd automator && npx tsx src/spike/viewer3dCameraClipCheck.ts
 *   前提: backend jar。専用ポートは GRAPHY_AUTOMATOR_HTTP_PORT / _SCP_PORT / _VITE_PORT で分ける。JDK を PATH に足す。
 * 結果は 合格・失敗・未達 に分けて数える。患者情報を含まない合成データ。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { openFirstSeriesInViewer } from "../checklist/items/shared/helpers.js";
import { createStepRecorder } from "../checklist/types.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "viewer3d-camera-clip");
const failures: string[] = [];
const unreached: string[] = [];
let passed = 0;
function check(cond: boolean, label: string, detail?: unknown): void {
  if (cond) {
    passed++;
    console.log(`  [ok  ] ${label}`);
  } else {
    console.log(`  [FAIL] ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
    failures.push(label);
  }
}
function notReached(label: string, why: string): void {
  console.log(`  [未達] ${label} — ${why}`);
  unreached.push(label);
}

// ---- 真値（式。本体の関数は使わない） ----
type V3 = [number, number, number];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const scale = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const add = (...vs: V3[]): V3 => vs.reduce((s, v) => [s[0] + v[0], s[1] + v[1], s[2] + v[2]] as V3, [0, 0, 0] as V3);
const unit = (a: V3): V3 => scale(a, 1 / Math.hypot(...a));

const D: V3 = unit([1, 2, -2]); // 視線（カメラ→注視点）
const UP_IN: V3 = [0, 0, 1]; // 視線に直交でない上
const UP: V3 = unit(add(UP_IN, scale(D, -dot(UP_IN, D)))); // 直交化した上
const RIGHT: V3 = cross(D, UP); // 画面右
const F: V3 = [0, 0, 0]; // 注視点（立方体の中心）
const PS = 60; // 平行投影の縦の半分（mm）

/** 球。screen は (右, 上) の mm、depth は視線方向（+D が奥＝カメラから遠い）。 */
const sph = (x: number, y: number, depth: number, r: number): { c: V3; r: number; x: number; y: number; depth: number } => ({
  c: add(F, scale(RIGHT, x), scale(UP, y), scale(D, depth)),
  r,
  x,
  y,
  depth,
});
const S_CENTER = sph(0, 0, 0, 3);
const S_BIG = sph(0, 30, 0, 6); // 上に 30 mm の大球
const S_RIGHT = sph(30, 0, 0, 3); // 右に 30 mm の小球
const S_A = sph(-35, -25, 20, 5); // 遠い（奥）
const S_B = sph(35, -25, -20, 5); // 近い（手前）

interface Probe { name: string; x: number; y: number; r: number }
/** 球の画面位置のプローブ（mm）。 */
const probeOf = (s: { x: number; y: number; r: number }, name: string, mirror = false): Probe => ({ name, x: mirror ? -s.x : s.x, y: mirror ? -s.y : s.y, r: s.r });

type CamReq = { direction: V3; up: V3; focalPoint: V3; projection: "parallel"; parallelScaleMm: number };
const CAM: CamReq = { direction: D, up: UP_IN, focalPoint: F, projection: "parallel", parallelScaleMm: PS };
const CAM_UP_FLIPPED: CamReq = { ...CAM, up: scale(UP_IN, -1) };

interface SampleOut { lit: Record<string, boolean>; mean: Record<string, number>; max: number; bg: number; png: string; lost: boolean; w: number; h: number }

/** 視点とクリップ面を当て、同じ実行単位で canvas の画素を読む（描画バッファが消える前に）。 */
async function sample(page: Page, cam: CamReq, planes: { origin: V3; normal: V3 }[], probes: Probe[]): Promise<SampleOut & { camRes: unknown; clipRes: unknown }> {
  return page.evaluate(
    ({ cam, planes, probes, ps }) => {
      const dbg = (window as unknown as { __graphyDebug: { applyViewer3dCamera: (r: unknown) => unknown; setViewer3dClipPlanes: (p: unknown) => unknown } }).__graphyDebug;
      const camRes = dbg.applyViewer3dCamera(cam);
      const clipRes = dbg.setViewer3dClipPlanes(planes);
      let best: HTMLCanvasElement | null = null;
      for (const c of Array.from(document.querySelectorAll("canvas"))) {
        if (!best || c.width * c.height > best.width * best.height) best = c;
      }
      if (!best) throw new Error("canvas が無い");
      const w = best.width;
      const h = best.height;
      const gl = (best.getContext("webgl2") ?? best.getContext("webgl")) as WebGL2RenderingContext | null;
      const lost = gl ? gl.isContextLost() : false;
      const copy = document.createElement("canvas");
      copy.width = w;
      copy.height = h;
      const ctx = copy.getContext("2d", { willReadFrequently: true })!;
      ctx.drawImage(best, 0, 0);
      const img = ctx.getImageData(0, 0, w, h).data;
      const pxPerMm = h / (2 * ps);
      const meanOf = (xmm: number, ymm: number, rmm: number) => {
        const cx = w / 2 + xmm * pxPerMm;
        const cy = h / 2 - ymm * pxPerMm;
        const rad = Math.max(2, rmm * pxPerMm * 0.6);
        let sum = 0;
        let n = 0;
        for (let y = Math.floor(cy - rad); y <= Math.ceil(cy + rad); y++) {
          for (let x = Math.floor(cx - rad); x <= Math.ceil(cx + rad); x++) {
            if (x < 0 || y < 0 || x >= w || y >= h) continue;
            if ((x - cx) ** 2 + (y - cy) ** 2 > rad * rad) continue;
            const i = (y * w + x) * 4;
            sum += 0.2126 * img[i] + 0.7152 * img[i + 1] + 0.0722 * img[i + 2];
            n++;
          }
        }
        return n ? sum / n : 0;
      };
      const mean: Record<string, number> = {};
      for (const p of probes) mean[p.name] = meanOf(p.x, p.y, p.r);
      const bg = meanOf(0, -50, 4); // 何も置かない位置
      const max = Math.max(...Object.values(mean));
      const thr = bg + 0.5 * (max - bg);
      const lit: Record<string, boolean> = {};
      for (const p of probes) lit[p.name] = max - bg > 30 && mean[p.name] > thr;
      return { camRes, clipRes, lit, mean, max, bg, png: copy.toDataURL("image/png"), lost, w, h };
    },
    { cam, planes, probes, ps: PS },
  );
}

function savePng(name: string, dataUrl: string): void {
  fs.writeFileSync(path.join(OUT_DIR, name), Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ""), "base64"));
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "v3d-sph-"));
  const spheres = [S_CENTER, S_BIG, S_RIGHT, S_A, S_B].map((s) => ({ c: s.c, r: s.r }));
  execFileSync("python3", ["-I", path.join(AUTOMATOR_ROOT, "scripts", "make-sphere-ct-phantom.py"), path.join(work, "ct"), "--spheres", JSON.stringify(spheres)], { stdio: "inherit" });
  console.log(`真値: d=${D.map((x) => x.toFixed(4))} up=${UP.map((x) => x.toFixed(4))} right=${RIGHT.map((x) => x.toFixed(4))}`);

  const driver = new DesktopDriver();
  await driver.start();
  try {
    const page = driver.page;
    await resetDb(driver.ports.http);
    // 公開済みの最新版がこのビルドより新しいと「新しい版があります」が操作を塞ぐ。この検査では更新を見ないのでスキップ済みにする。
    await page.evaluate("localStorage.setItem('graphy.update.skipVersion', '0.6.2')");
    await page.reload({ waitUntil: "domcontentloaded" });
    const imp = await importPaths(driver.ports.http, [path.join(work, "ct")]);
    check(imp.imported === 160 && imp.failed === 0, "（前提）合成 CT の 160 枚を取り込めた", imp);
    await page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    await openFirstSeriesInViewer(page, createStepRecorder());
    const v3d = await driver.waitForNewPage(() => page.locator('button[title="3D Viewer"]').click(), (url) => url.includes("viewer3d"));
    v3d.on("console", (m) => { if (m.type() === "error") console.log(`  [3d error] ${m.text().slice(0, 200)}`); });
    await v3d.locator('[data-testid="viewer3d-mode-mip"]').waitFor({ timeout: 120_000 });
    await v3d.locator('[data-testid="viewer3d-mode-mip"]').click();
    await v3d.waitForTimeout(4000);
    const ready = await v3d.evaluate(() => {
      try {
        return !!(window as unknown as { __graphyDebug: { getViewer3dState: () => unknown } }).__graphyDebug.getViewer3dState();
      } catch {
        return false;
      }
    });
    if (!ready) {
      notReached("3D が開き dev の口が使える", "getViewer3dState が null／例外。以降は行わない");
      return;
    }
    check(true, "3D が開き、dev の視点の口が使える（MIP）");
    // tsx（esbuild）は関数に __name を差し込む。page.evaluate に渡した関数がそれを参照できるようにしておく。
    await v3d.evaluate("globalThis.__name = (f) => f");

    const P_CENTER = probeOf(S_CENTER, "center");
    const P_BIG = probeOf(S_BIG, "big");
    const P_BIG_M = probeOf(S_BIG, "bigMirror", true);
    const P_RIGHT = probeOf(S_RIGHT, "right");
    const P_RIGHT_M = probeOf(S_RIGHT, "rightMirror", true);
    const P_A = probeOf(S_A, "A");
    const P_B = probeOf(S_B, "B");
    const ALL = [P_CENTER, P_BIG, P_BIG_M, P_RIGHT, P_RIGHT_M, P_A, P_B];

    console.log("\n[0] 視点を当てる（クリップ面なし）。検出器の自己検査を兼ねる");
    const base = await sample(v3d, CAM, [], ALL);
    savePng("0-base.png", base.png);
    console.log(`  canvas ${base.w}×${base.h}  最大=${base.max.toFixed(1)} 背景=${base.bg.toFixed(1)}  lit=${JSON.stringify(base.lit)}`);
    check((base.camRes as { ok: boolean }).ok === true, "applyCamera が受理される", base.camRes);
    check(!base.lost, "WebGL コンテキストが失われていない");
    check(base.max - base.bg > 30, "🔴 画面が真っ黒でない（球が描かれている）", { max: base.max, bg: base.bg });
    check(base.lit.center && base.lit.big && base.lit.right && base.lit.A && base.lit.B, "（自己検査）クリップ面なしで 5 つの球がすべて写る", base.lit);
    check(!base.lit.bigMirror && !base.lit.rightMirror, "（自己検査）反対側の位置には何も写らない", base.lit);

    const st = (await v3d.evaluate(() => (window as unknown as { __graphyDebug: { getViewer3dState: () => unknown } }).__graphyDebug.getViewer3dState())) as {
      direction: number[]; viewUp: number[]; focalPoint: number[];
    };
    const near = (a: number[], b: number[], tol: number) => a.every((x, i) => Math.abs(x - b[i]) < tol);
    check(near(st.direction, D, 1e-6), "視線が指定どおり（1e-6）", { got: st.direction, want: D });
    check(near(st.viewUp, UP, 1e-6), "上が直交化した値で当たる（1e-6）", { got: st.viewUp, want: UP });
    check(near(st.focalPoint, F, 1e-6), "注視点が指定どおり（1e-6）", st.focalPoint);

    console.log("\n[1] 符号・向きの取り違えの検出（013-5 相当）");
    check(base.lit.big, "上に 30 mm の大球は画面の上側に写る");
    check(base.lit.right, "右に 30 mm の小球は画面の右側に写る（画面右 = 視線 × 上）");
    const flipped = await sample(v3d, CAM_UP_FLIPPED, [], ALL);
    savePng("1-up-flipped.png", flipped.png);
    console.log(`  up 反転: lit=${JSON.stringify(flipped.lit)}`);
    check(flipped.lit.bigMirror && !flipped.lit.big, "🔴 up を反転すると大球が画面の下側へ移る（検出器が反転を見分ける）", flipped.lit);
    check(flipped.lit.rightMirror && !flipped.lit.right, "up を反転すると小球が画面の左側へ移る（右 = 視線 × 上）", flipped.lit);
    const back = await sample(v3d, { ...CAM, direction: scale(D, -1) }, [], ALL);
    savePng("1-direction-reversed.png", back.png);
    console.log(`  視線反転: lit=${JSON.stringify(back.lit)}`);
    check(back.lit.bigMirror === false && back.lit.big && back.lit.rightMirror && !back.lit.right, "視線を反転すると（上は同じ）大球は上のまま、小球は左へ移る（反対側から見る）", back.lit);

    console.log("\n[2] 任意平面のクリップ（013-4 相当）。法線の向く側を残す");
    const planeD = { origin: F, normal: D };
    const c1 = await sample(v3d, CAM, [planeD], ALL);
    savePng("2-clip-keep-far.png", c1.png);
    console.log(`  法線 +d: lit=${JSON.stringify(c1.lit)} 面数=${JSON.stringify((c1.clipRes as unknown))}`);
    check(!c1.lost && c1.max - c1.bg > 30, "🔴 クリップ面 1 枚でも黒画面・コンテキスト喪失にならない", { lost: c1.lost, max: c1.max, bg: c1.bg });
    check(c1.lit.A && !c1.lit.B, "🔴 法線 +d（奥を向く）: 手前の球 B が消え、奥の球 A は残る", c1.lit);
    const c2 = await sample(v3d, CAM, [{ origin: F, normal: scale(D, -1) }], ALL);
    savePng("2-clip-keep-near.png", c2.png);
    console.log(`  法線 −d: lit=${JSON.stringify(c2.lit)}`);
    check(c2.lit.B && !c2.lit.A, "🔴 法線 −d: 奥の球 A が消え、手前の球 B は残る（法線を反転すると反転する）", c2.lit);
    const c3 = await sample(v3d, CAM, [], ALL);
    check(c3.lit.A && c3.lit.B, "クリップ面を [] にすると両方戻る", c3.lit);
    // 2 枚: 手前 −10 mm より奥だけ残す + 奥 +10 mm より手前だけ残す → 球 A・B のどちらも消える（深さ ±20 の外）
    const c4 = await sample(v3d, CAM, [{ origin: scale(D, -10), normal: D }, { origin: scale(D, 10), normal: scale(D, -1) }], ALL);
    savePng("2-clip-slab.png", c4.png);
    check(!c4.lit.A && !c4.lit.B && c4.lit.center, "2 枚の面で厚さ 20 mm の板だけ残る（深さ ±20 の球 A・B は消え、深さ 0 の球は残る）", c4.lit);
    // 不正な面は拒否され、直前の状態（c4 の 2 枚の板）が変わらない。直前と同じ画になることで見る。
    const bad = await sample(v3d, CAM, [{ origin: F, normal: [0, 0, 0] }], ALL);
    check((bad.clipRes as { ok: boolean }).ok === false, "法線 0 のクリップ面は拒否される", bad.clipRes);
    check(JSON.stringify(bad.lit) === JSON.stringify(c4.lit), "拒否した後も直前の状態（2 枚の板）のまま変わらない", { bad: bad.lit, before: c4.lit });
    const planesNow = (await v3d.evaluate(() => (window as unknown as { __graphyDebug: { getViewer3dState: () => { clipPlanes: unknown[] } } }).__graphyDebug.getViewer3dState().clipPlanes)) as unknown[];
    check(planesNow.length === 2, "適用中のクリップ面は 2 枚のまま", planesNow.length);
  } finally {
    await driver.stop().catch(() => undefined);
    fs.rmSync(work, { recursive: true, force: true });
  }
  console.log("");
  console.log(`合格 ${passed} / 失敗 ${failures.length} / 未達 ${unreached.length}`);
  for (const f of failures) console.log(` - 失敗: ${f}`);
  for (const f of unreached) console.log(` - 未達: ${f}`);
  console.log(`出力: ${OUT_DIR}`);
  if (failures.length > 0 || unreached.length > 0) process.exit(1);
}

await main();
