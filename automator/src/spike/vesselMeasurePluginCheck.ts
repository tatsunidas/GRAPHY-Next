/*
 * プラグインが「マスク → 中心線 → 木の向き付け → 断面の径 → 血管モデルの登録 → 3D 表示 → 径で色付け」を
 * host API だけで通せることの実アプリ検査（measureMaskCrossSections / orientCenterlineGraph）。
 *
 * 検査用プラグインが、解析式の Y 字マスク（幹 直径 4.0 mm、枝 2 本 直径 3.0 mm）をページ内で作り、
 * extractCenterline → orientCenterlineGraph → measureMaskCrossSections → registerVesselModel →
 * openVesselModel3d → putVesselAnalysis（値 = 径）を呼ぶ。真値は式（本体の関数は使わない）。画素で色を判定する。
 *
 * 見るもの:
 *   正例: 径が真値と一致（幹 4.0・枝 3.0、等価径±0.5）、木が 3 区間・幹の parentId が null、登録できる、3D 窓で物体 3 つ、
 *         径で色付け → 幹（高値）= 青・枝（低値）= 赤が画素で揃い、既定のシアンは残らない
 *   負例: 分岐点を根に → ok:false／走査半径不足 → touchesBoundary・値 null／分岐近傍は excludeNear なしで過大・ありで外れる
 *
 * 実行:  cd automator && npx tsx src/spike/vesselMeasurePluginCheck.ts
 *   前提: backend jar。専用ポートは GRAPHY_AUTOMATOR_HTTP_PORT / _SCP_PORT / _VITE_PORT で分ける。JDK を PATH に足す。
 * 結果は 合格・失敗・未達 に分けて数える。患者情報を含まない合成データ。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";

import { resetDb } from "../backend/dbReset.js";
import { dismissStartupDialogs } from "../common/dismissDialogs.js";
import { DesktopDriver, DESKTOP_RUN_DATA_DIR } from "../driver/desktopDriver.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "vessel-measure");
const PLUGIN_ID = "vessel-measure-probe";
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

// 真値（式）: 幹 z=2..22 の直径 4.0、枝は (15,15,22) から ±x へ 12 mm 進み z=34 まで、直径 3.0。ボクセル 0.5 mm 等方。
const TRUNK_D = 4.0;
const BRANCH_D = 3.0;

function installProbePlugin(): void {
  const dst = path.join(DESKTOP_RUN_DATA_DIR, "plugins", PLUGIN_ID);
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(dst, { recursive: true });
  fs.writeFileSync(path.join(dst, "plugin.json"), JSON.stringify({ id: PLUGIN_ID, name: "Vessel Measure Probe", version: "0.0.1", engines: { graphy: ">=0.0.0" }, contributes: ["viewer2d.menu"], ui: "ui.js" }, null, 2));
  fs.writeFileSync(path.join(dst, "ui.js"), `
function cylinder(a, b, r) {
  const ax = [b[0]-a[0], b[1]-a[1], b[2]-a[2]];
  const len = Math.hypot(ax[0], ax[1], ax[2]);
  const u = [ax[0]/len, ax[1]/len, ax[2]/len];
  return (w) => {
    const d = [w[0]-a[0], w[1]-a[1], w[2]-a[2]];
    const s = d[0]*u[0] + d[1]*u[1] + d[2]*u[2];
    if (s < 0 || s > len) return 0;
    const perp = Math.hypot(d[0]-s*u[0], d[1]-s*u[1], d[2]-s*u[2]);
    return perp <= r ? 1 : 0;
  };
}
function buildMask(trunkD, branchD) {
  const sp = 0.5, dims = [60, 60, 80];
  const t = cylinder([15,15,2], [15,15,22], trunkD/2);
  const b1 = cylinder([15,15,22], [27,15,34], branchD/2);
  const b2 = cylinder([15,15,22], [3,15,34], branchD/2);
  const data = new Uint8Array(dims[0]*dims[1]*dims[2]);
  for (let k = 0; k < dims[2]; k++) for (let j = 0; j < dims[1]; j++) for (let i = 0; i < dims[0]; i++) {
    const w = [i*sp, j*sp, k*sp];
    data[k*dims[0]*dims[1] + j*dims[0] + i] = (t(w) || b1(w) || b2(w)) ? 1 : 0;
  }
  return { data, dims, indexToWorld: [sp,0,0,0, 0,sp,0,0, 0,0,sp,0, 0,0,0,1] };
}
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;

export default {
  activate: async (host) => {
    const c = window.__vmCase;
    if (!c) return;
    window.__vmResult = undefined;
    try {
      if (c.op === "pipeline") {
        const mask = buildMask(c.trunkD, c.branchD);
        const g = host.extractCenterline(mask, { pruneMinLengthMm: 3 });
        if (!g) { window.__vmResult = { ok: false, error: "no graph" }; return; }
        const leaves = g.nodes.filter((n) => n.degree === 1).sort((a, b) => a.world[2] - b.world[2]);
        const root = leaves[0];
        const junctions = g.nodes.filter((n) => n.degree >= 3);
        const badRoot = host.orientCenterlineGraph(g, junctions[0].id);
        const o = host.orientCenterlineGraph(g, root.id);
        if (!o.ok) { window.__vmResult = { ok: false, error: o.error }; return; }
        const exclude = { points: junctions.map((n) => n.world), radiusMm: 4 };
        const measureSeg = (seg, extra) => host.measureMaskCrossSections(mask, seg.points, { spacingMm: 1, maxRadiusMm: 5, ...extra });
        const segments = o.segments.map((s) => {
          const m = measureSeg(s, { excludeNear: exclude });
          if (!m.ok) throw new Error(m.error);
          const valid = m.frames.filter((f) => f.equivalentDiameterMm !== null);
          // 断面フレームの位置をそのまま区間の点列にし、径は 1 対 1（測れない断面は null）。
          const pts = m.frames.map((f) => f.positionWorld);
          const diam = m.frames.map((f) => f.equivalentDiameterMm);
          return { id: s.id, name: s.parentId === null ? "trunk" : "branch " + s.id, points: pts, parentId: s.parentId, diameterMm: diam, mean: mean(valid.map((f) => f.equivalentDiameterMm)), nValid: valid.length, nFrames: m.frames.length };
        });
        const trunk = o.segments.find((s) => s.parentId === null);
        const branch = o.segments.find((s) => s.parentId !== null);
        // 節点をまたぐ経路（根 → 枝）。分岐の近傍では他枝の内腔が断面に入る。
        const crossing = [...trunk.points, ...branch.points.slice(1)];
        const jw = junctions[0].world;
        const near = (f) => Math.hypot(f.positionWorld[0]-jw[0], f.positionWorld[1]-jw[1], f.positionWorld[2]-jw[2]);
        const bare = host.measureMaskCrossSections(mask, crossing, { spacingMm: 1, maxRadiusMm: 6 });
        const withEx = host.measureMaskCrossSections(mask, crossing, { spacingMm: 1, maxRadiusMm: 6, excludeNear: exclude });
        const tooSmall = host.measureMaskCrossSections(mask, trunk.points, { spacingMm: 3, maxRadiusMm: 1.5 });
        const reg = host.registerVesselModel({
          runKey: "vm1", stableKey: null, orientation: { proximalFirst: true, source: "user" }, kind: "ct-vessel", label: "測定した木",
          segments: segments.map((s) => ({ id: s.id, name: s.name, points: s.points, parentId: s.parentId, diameterMm: s.diameterMm })),
          calibration: { diameterCalibrated: true, sources: [], tiers: [], diameterMethod: "mask-equivalent-area" },
          provenance: { studyUid: "1.2.3", seriesUid: "1.2.3.4", frameOfReferenceUid: null, voxelSpacingMm: [0.5, 0.5, 0.5], maskOrigin: { type: "plugin" } },
        });
        window.__vmResult = {
          ok: true, reg, badRootOk: badRoot.ok, badRootError: badRoot.ok ? null : badRoot.error,
          segs: segments.map((s) => ({ id: s.id, parentId: s.parentId, mean: s.mean, nValid: s.nValid, nFrames: s.nFrames, nPoints: s.points.length })),
          // 節点から 2 mm 以内の断面の（値, 節点までの距離）。真値は幹 4.0・枝 3.0。
          bareNear: bare.frames.filter((f) => near(f) <= 2).map((f) => ({ d: f.equivalentDiameterMm, dist: near(f), boundary: f.touchesBoundary })),
          // 除外ありで、節点から 4 mm 以内に値が残っていないか／残りの断面が真値のどちらかに合うか。
          exLeftNear: withEx.frames.filter((f) => near(f) <= 4 && f.equivalentDiameterMm !== null).length,
          exFar: withEx.frames.filter((f) => f.equivalentDiameterMm !== null).map((f) => f.equivalentDiameterMm),
          exExcluded: withEx.frames.filter((f) => f.excluded).length,
          tooSmallBoundary: tooSmall.ok && tooSmall.frames.slice(1, -1).every((f) => f.touchesBoundary && f.equivalentDiameterMm === null),
          values: segments.map((s) => ({ segmentId: s.id, d: s.diameterMm })),
        };
      } else if (c.op === "open") window.__vmResult = host.openVesselModel3d(c.runId);
      else if (c.op === "analysis") window.__vmResult = host.putVesselAnalysis(c.runId, c.analysis);
      else if (c.op === "has") window.__vmResult = { measure: typeof host.measureMaskCrossSections, orient: typeof host.orientCenterlineGraph };
    } catch (e) { window.__vmResult = { ok: false, error: "threw: " + String(e) }; }
  },
};
`);
}

async function call(viewer: Page, kase: unknown): Promise<any> {
  await viewer.evaluate((c) => { (window as unknown as Record<string, unknown>).__vmCase = c; }, kase);
  await viewer.getByTestId("viewer2d-menu-plugins").click();
  await viewer.getByTestId(`plugin-item-${PLUGIN_ID}`).click();
  await viewer.waitForFunction(() => (window as unknown as Record<string, unknown>).__vmResult !== undefined, null, { timeout: 60_000 });
  return viewer.evaluate(() => (window as unknown as Record<string, unknown>).__vmResult);
}

/** 3D 画面を撮り、色の画素数を数える。凡例（右上）・物体一覧（右）・上下の帯は数えない。 */
async function colorStats(page: Page, png: string): Promise<{ red: number; blue: number; cyan: number; grey: number; drawn: number }> {
  await page.evaluate("globalThis.__name = (f) => f");
  const buf = await page.screenshot({ path: png });
  return page.evaluate(async (b64) => {
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([bin], { type: "image/png" }));
    const cv = document.createElement("canvas");
    cv.width = bmp.width;
    cv.height = bmp.height;
    const ctx = cv.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
    const bgi = (2 * cv.width + 2) * 4;
    const bg = [d[bgi], d[bgi + 1], d[bgi + 2]];
    let red = 0, blue = 0, cyan = 0, grey = 0, drawn = 0;
    const x1 = Math.floor(cv.width * 0.72), y0 = 40, y1 = cv.height - 30;
    for (let y = y0; y < y1; y++) for (let x = 0; x < x1; x++) {
      const i = (y * cv.width + x) * 4;
      const r = d[i], g = d[i + 1], b = d[i + 2];
      if (Math.abs(r - bg[0]) + Math.abs(g - bg[1]) + Math.abs(b - bg[2]) < 60) continue;
      drawn++;
      if (r > g + 60 && r > b + 60) red++;
      else if (b > r + 50 && g > r + 80 && g > b - 60) cyan++;
      else if (b > r + 50 && b > g + 40) blue++;
      else if (Math.max(r, g, b) - Math.min(r, g, b) < 40 && Math.max(r, g, b) > 90) grey++;
    }
    return { red, blue, cyan, grey, drawn };
  }, buf.toString("base64"));
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "vessel-measure-"));
  execFileSync("python3", ["-I", path.join(AUTOMATOR_ROOT, "scripts", "make-sphere-ct-phantom.py"), path.join(work, "ct"), "--spheres", JSON.stringify([{ c: [0, 0, 0], r: 5 }])], { stdio: "inherit" });
  installProbePlugin();

  const driver = new DesktopDriver();
  await driver.start();
  try {
    const page = driver.page;
    page.on("dialog", (d) => void d.accept());
    await resetDb(driver.ports.http);
    await page.evaluate("localStorage.setItem('graphy.update.skipVersion', '0.6.2')");
    const imp = await importPaths(driver.ports.http, [path.join(work, "ct")]);
    check(imp.failed === 0 && imp.imported > 0, "（前提）合成 CT を取り込めた", imp);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    await dismissStartupDialogs(page);
    const base = `http://localhost:${driver.ports.http}`;
    const mf = (await (await fetch(`${base}/api/plugins`)).json()) as { id: string }[];
    check(mf.some((m) => m.id === PLUGIN_ID), "検査用プラグインが読み込まれた", mf.map((m) => m.id));
    const study = ((await (await fetch(`${base}/api/studies`)).json()) as { studyInstanceUid: string }[])[0];
    const series = ((await (await fetch(`${base}/api/studies/${study.studyInstanceUid}/series`)).json()) as { seriesInstanceUid: string }[])[0];
    const dates = page.locator('input[type="date"]');
    await dates.nth(0).fill("");
    await dates.nth(1).fill("");
    await page.getByTestId("search-submit-button").click();
    await page.locator(`[data-testid="study-row-${study.studyInstanceUid}"]`).click();
    await page.locator(`[data-testid="series-row-${series.seriesInstanceUid}"]`).click();
    const viewer = await driver.waitForNewPage(() => page.getByTestId("viewer2d-toolbar-button").click(), (u) => u.includes("2dviewer"));
    await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 30_000 });
    await viewer.waitForTimeout(2_000);

    console.log("\n[1] host に新しい API が生えている");
    const has = await call(viewer, { op: "has" });
    check(has?.measure === "function" && has?.orient === "function", "measureMaskCrossSections / orientCenterlineGraph が関数", has);

    console.log("\n[2] 通し（マスク → 中心線 → 向き付け → 径 → 登録）");
    const t0 = Date.now();
    const r = await call(viewer, { op: "pipeline", trunkD: TRUNK_D, branchD: BRANCH_D });
    console.log(`  実行時間（プラグイン内・マスク生成を含む）: ${Date.now() - t0} ms`);
    check(r?.ok === true, "通しが最後まで通った", r);
    if (r?.ok !== true) throw new Error("pipeline failed: " + JSON.stringify(r));
    check(r.segs.length === 3, "木が 3 区間", r.segs);
    const trunk = r.segs.find((s: any) => s.parentId === null);
    const branches = r.segs.filter((s: any) => s.parentId !== null);
    check(!!trunk && branches.length === 2 && branches.every((b: any) => b.parentId === trunk.id), "幹の parentId が null、枝 2 本の parentId が幹", r.segs);
    check(!!trunk && Math.abs(trunk.mean - TRUNK_D) < 0.5, `幹の径が真値 ${TRUNK_D} mm（±0.5）`, trunk);
    check(branches.every((b: any) => Math.abs(b.mean - BRANCH_D) < 0.5), `枝の径が真値 ${BRANCH_D} mm（±0.5）`, branches);
    check(r.segs.every((s: any) => s.nValid > 3), "各区間で測れた断面が複数ある", r.segs.map((s: any) => [s.id, s.nValid, s.nFrames]));
    check(r.reg?.ok === true, "registerVesselModel（ct-vessel・径つき）が通る", r.reg);
    const trueOk = (d: number) => Math.abs(d - TRUNK_D) <= 0.25 || Math.abs(d - BRANCH_D) <= 0.25;
    console.log(`  節点から 2 mm 以内（除外なし）: ${JSON.stringify(r.bareNear.map((x: any) => [x.d === null ? null : +x.d.toFixed(2), +x.dist.toFixed(1)]))}`);
    check(r.bareNear.some((x: any) => x.d === null || !trueOk(x.d)), "🔴 （自己検査）excludeNear なしだと、節点の近傍に真値（幹 4.0・枝 3.0 ±0.25）から外れた値か測れない断面（null）が出る", r.bareNear);
    check(r.exLeftNear === 0 && r.exExcluded > 0, "excludeNear を渡すと、節点から 4 mm 以内に値が残らない", { exLeftNear: r.exLeftNear, exExcluded: r.exExcluded });
    check(r.exFar.every((d: number) => Math.abs(d - TRUNK_D) <= 0.5 || Math.abs(d - BRANCH_D) <= 0.5), "除外した経路の残りの断面は、すべて真値（幹 4.0・枝 3.0 ±0.5）に合う", r.exFar);
    check(r.badRootOk === false && /end point/.test(String(r.badRootError)), "負例: 分岐点を根にすると ok:false（理由つき）", { ok: r.badRootOk, error: r.badRootError });
    check(r.tooSmallBoundary === true, "負例: 走査半径が足りない断面は touchesBoundary・値 null", r.tooSmallBoundary);

    console.log("\n[3] 3D 画面で開き、径で色付けする（値 = 径。範囲 3〜4 mm: 枝=赤・幹=青）");
    const runId = r.reg.runId as string;
    const [geo] = await Promise.all([
      driver.waitForNewPage(async () => {
        const o = await call(viewer, { op: "open", runId });
        check(o?.ok === true, "openVesselModel3d が ok:true", o);
      }, (u) => u.includes("geometry3d")),
    ]);
    geo.on("console", (m) => { if (m.type() === "error") console.log(`  [3d error] ${m.text().slice(0, 200)}`); });
    const objs = geo.getByTestId("geometry3d-objects");
    await objs.waitFor({ state: "visible", timeout: 120_000 });
    await geo.waitForTimeout(3000);
    check((await objs.getAttribute("data-count")) === "3", "物体が 3 つ", await objs.getAttribute("data-count"));
    const s0 = await colorStats(geo, path.join(OUT_DIR, "1-tree-measured.png"));
    check(s0.cyan > 500 && s0.red < 30 && s0.blue < 30, "（自己検査）色付け前は既定のシアンだけ", s0);
    const perPoint: { segmentId: string; index: number; value: number }[] = [];
    for (const v of r.values as { segmentId: string; d: (number | null)[] }[]) v.d.forEach((d, index) => { if (d !== null) perPoint.push({ segmentId: v.segmentId, index, value: d }); });
    const an = await call(viewer, { op: "analysis", runId, analysis: { kind: "custom", label: "径 [mm]", range: [3, 4], perPoint } });
    check(an?.ok === true, "putVesselAnalysis（値 = 測った径）が ok:true", an);
    await geo.getByTestId("vessel-legend").waitFor({ state: "visible", timeout: 20_000 });
    await geo.waitForTimeout(1500);
    const s1 = await colorStats(geo, path.join(OUT_DIR, "2-tree-colored-by-diameter.png"));
    console.log(`  色付け後: ${JSON.stringify(s1)}`);
    check(s1.red > 500 && s1.blue > 300 && s1.cyan < 30, "🔴 細い枝=赤・太い幹=青の画素が揃い、既定のシアンは消える", s1);
    notReached("実 CT（冠動脈 CTA）での径の妥当性", "手元に実データが無い（公開データはライセンス確認後）。この検査は解析式の合成マスクのみ");
  } finally {
    await driver.stop().catch(() => undefined);
    fs.rmSync(work, { recursive: true, force: true });
  }
  console.log("");
  console.log(`合格 ${passed} / 失敗 ${failures.length} / 未達 ${unreached.length}`);
  for (const f of failures) console.log(` - 失敗: ${f}`);
  for (const f of unreached) console.log(` - 未達: ${f}`);
  console.log(`出力: ${OUT_DIR}`);
  if (failures.length > 0) process.exit(1);
}

await main();
