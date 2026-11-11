/*
 * プラグインが CT 由来の血管モデル（kind: "ct-vessel"）を登録し、3D 画面で木として開く経路の実アプリ検査。
 *
 * 検査用プラグイン（plugin.json＋ui.js を一時に置く）が registerVesselModel / openVesselModel3d / putVesselAnalysis /
 * listVesselModels を呼ぶ。3 区間の木（幹＋枝 2）を式で作り、**描かれた画素**で色を判定する
 * （DOM の個数だけでは「値を入れた区間だけが色づく」ことは見えない）。
 *
 * 見るもの:
 *   負例: CT の入力が壊れている（seriesUid 無し・未校正なのに径が数値・parentId が自分自身）→ ok:false、登録簿の件数が増えない
 *   正例: 木を登録 → ok:true → 開く → 物体が 3 つ（区間ごと）・解析前は赤・青の画素が無い（自己検査）
 *   解析: 2 区間だけ値を入れる → 赤（幹）・青（枝 1）・グレー（値なしの枝 2）の画素が揃う。凡例が出て、XA 専用の注記は出ない
 *   負例: 未知の segmentId の putVesselAnalysis → ok:false・色は変わらない
 *   窓の再利用: もう一度開いても窓・物体が増えない
 *   既存: 単一の XA（xa-qca3d）は物体 1 つのまま（従来どおり）・XA の注記が出る
 *
 * 実行:  cd automator && npx tsx src/spike/vesselModelCtPluginCheck.ts
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

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "vessel-model-ct");
const PLUGIN_ID = "vessel-ct-probe";
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

// ---- 入力（式で作る。本体の関数は使わない） ----
type P3 = [number, number, number];
const line = (a: P3, b: P3, n: number): P3[] => Array.from({ length: n }, (_, i) => [a[0] + ((b[0] - a[0]) * i) / (n - 1), a[1] + ((b[1] - a[1]) * i) / (n - 1), a[2] + ((b[2] - a[2]) * i) / (n - 1)] as P3);
const N = 30;
const SEGS = [
  { id: "trunk", name: "幹", points: line([0, 0, 0], [0, 0, 60], N), parentId: null },
  { id: "b1", name: "枝1", points: line([0, 0, 60], [40, 0, 100], N), parentId: "trunk" },
  { id: "b2", name: "枝2", points: line([0, 0, 60], [-40, 0, 100], N), parentId: "trunk" },
].map((s) => ({ ...s, diameterMm: s.points.map(() => 4) }));
const ctModel = (over: Record<string, unknown> = {}) => ({
  runKey: "ct1",
  stableKey: null,
  orientation: { proximalFirst: true, source: "user" },
  kind: "ct-vessel",
  label: "CT 検査木",
  segments: SEGS,
  calibration: { diameterCalibrated: true, sources: [], tiers: [], diameterMethod: "mask-equivalent-area" },
  provenance: { studyUid: "1.2.3", seriesUid: "1.2.3.4", frameOfReferenceUid: "1.2.3.9", voxelSpacingMm: [0.4, 0.4, 0.5], maskOrigin: { type: "plugin" } },
  ...over,
});
const xaModel = () => ({
  runKey: "xa1",
  stableKey: null,
  orientation: { proximalFirst: true, source: "user" },
  kind: "xa-qca3d",
  label: "XA 単一血管",
  segments: [{ id: "main", points: line([0, 0, 0], [0, 0, 60], N), diameterMm: line([0, 0, 0], [0, 0, 60], N).map(() => 3), parentId: null }],
  calibration: { diameterCalibrated: true, sources: [], tiers: ["approximate"], diameterMethod: "half-max" },
  provenance: { studyUid: "1.2.3", seriesUids: ["1.2.3.4", "1.2.3.5"], sopUids: ["a", "b"], angles: [[45, 15], [-40, 30]], angleCorrected: true, visibleFractions: [1, 1], anchorReprojectionPx: 1, separationDeg: 70, frameIndices: [0, 0] },
});
const perPoint = (segmentId: string, v: number) => SEGS.find((s) => s.id === segmentId)!.points.map((_, index) => ({ segmentId, index, value: v }));

function installProbePlugin(): void {
  const dst = path.join(DESKTOP_RUN_DATA_DIR, "plugins", PLUGIN_ID);
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(dst, { recursive: true });
  fs.writeFileSync(path.join(dst, "plugin.json"), JSON.stringify({ id: PLUGIN_ID, name: "Vessel CT Probe", version: "0.0.1", engines: { graphy: ">=0.0.0" }, contributes: ["viewer2d.menu"], ui: "ui.js" }, null, 2));
  // 検査側が window.__vcCase に入れた操作を実行し、戻りを window.__vcResult に置く。
  fs.writeFileSync(path.join(dst, "ui.js"), `export default {
  activate: async (host) => {
    const c = window.__vcCase;
    if (!c) return;
    window.__vcResult = undefined;
    try {
      if (c.op === "register") window.__vcResult = host.registerVesselModel(c.model);
      else if (c.op === "open") window.__vcResult = host.openVesselModel3d(c.runId);
      else if (c.op === "analysis") window.__vcResult = host.putVesselAnalysis(c.runId, c.analysis);
      else if (c.op === "list") window.__vcResult = host.listVesselModels();
    } catch (e) { window.__vcResult = { ok: false, error: "threw: " + String(e) }; }
  },
};
`);
}

async function call(viewer: Page, kase: unknown): Promise<any> {
  await viewer.evaluate((c) => { (window as unknown as Record<string, unknown>).__vcCase = c; }, kase);
  await viewer.getByTestId("viewer2d-menu-plugins").click();
  await viewer.getByTestId(`plugin-item-${PLUGIN_ID}`).click();
  await viewer.waitForFunction(() => (window as unknown as Record<string, unknown>).__vcResult !== undefined, null, { timeout: 15_000 });
  return viewer.evaluate(() => (window as unknown as Record<string, unknown>).__vcResult);
}
const geoPages = (driver: DesktopDriver): Page[] => driver.app.windows().filter((w) => w.url().includes("geometry3d"));

/** 3D 画面を撮り、色の画素数を数える（赤・青・無彩色）。背景は四隅の画素で決める。 */
async function colorStats(page: Page, png: string): Promise<{ red: number; blue: number; cyan: number; grey: number; drawn: number }> {
  await page.evaluate("globalThis.__name = (f) => f");
  const buf = await page.screenshot({ path: png });
  // 3D の描画領域（キャンバス）の下端まで。その下の径プロファイルの帯（折れ線もシアン）は数えない。
  const hostBox = await page.getByTestId("geometry3d-canvas-host").boundingBox();
  const bottom = hostBox ? hostBox.y + hostBox.height : null;
  return page.evaluate(async ({ b64, bottom }) => {
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([bin], { type: "image/png" }));
    const cv = document.createElement("canvas");
    cv.width = bmp.width;
    cv.height = bmp.height;
    const ctx = cv.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
    const at = (x: number, y: number) => { const i = (y * cv.width + x) * 4; return [d[i], d[i + 1], d[i + 2]]; };
    const bg = at(2, 2);
    let red = 0, blue = 0, cyan = 0, grey = 0, drawn = 0;
    // 凡例（右上）・物体一覧（右）・上下の帯は数えない（色ランプの赤・青が混ざる）。
    const x1 = Math.floor(cv.width * 0.72), y0 = 40, y1 = bottom === null ? cv.height - 30 : Math.min(cv.height, Math.floor(bottom) - 2);
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
  }, { b64: buf.toString("base64"), bottom });
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "vessel-ct-"));
  // プラグインのメニューは 2D ビューアにある。開く対象は何でもよいので、最小の合成 CT を使う。
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

    const count = async () => ((await call(viewer, { op: "list" })) as unknown[]).length;

    console.log("\n[1] 負例: 壊れた CT の入力は ok:false で、登録簿が増えない");
    const n0 = await count();
    const pv = ctModel().provenance;
    const bad: [string, unknown, RegExp][] = [
      ["seriesUid 無し", ctModel({ provenance: { ...pv, seriesUid: undefined } }), /seriesUid/],
      ["未校正なのに径が数値", ctModel({ calibration: { diameterCalibrated: false, sources: [], tiers: [], diameterMethod: null } }), /null/],
      ["parentId が自分自身", ctModel({ segments: [{ ...SEGS[0], parentId: "trunk" }] }), /parentId/],
      ["voxelSpacingMm が 0", ctModel({ provenance: { ...pv, voxelSpacingMm: [0.4, 0, 0.5] } }), /voxelSpacingMm/],
    ];
    for (const [label, model, re] of bad) {
      const r = await call(viewer, { op: "register", model });
      check(r?.ok === false && re.test(String(r.error)), `負例（${label}）: ok:false と理由`, r);
    }
    check((await count()) === n0, "負例: 登録簿の件数が増えない", { before: n0, after: await count() });

    console.log("\n[2] 正例: 3 区間の木を登録して 3D 画面で開く");
    const reg = await call(viewer, { op: "register", model: ctModel() });
    check(reg?.ok === true && reg.runId === `plugin:${PLUGIN_ID}:ct1`, "ct-vessel が登録できた", reg);
    const listed = (await call(viewer, { op: "list" })) as { runId: string; kind: string }[];
    check(listed.some((m) => m.runId === reg.runId && m.kind === "ct-vessel"), "listVesselModels に kind=ct-vessel で出る", listed);
    const [geo] = await Promise.all([
      driver.waitForNewPage(async () => {
        const r = await call(viewer, { op: "open", runId: reg.runId });
        check(r?.ok === true, "openVesselModel3d が ok:true", r);
      }, (u) => u.includes("geometry3d")),
    ]);
    geo.on("console", (m) => { if (m.type() === "error") console.log(`  [3d error] ${m.text().slice(0, 200)}`); });
    const objs = geo.getByTestId("geometry3d-objects");
    await objs.waitFor({ state: "visible", timeout: 120_000 });
    await geo.waitForTimeout(3000);
    check((await objs.getAttribute("data-count")) === "3", "物体が 3 つ（区間ごと）", await objs.getAttribute("data-count"));
    const footer = (await geo.getByTestId("geometry3d-footer").textContent()) ?? "";
    check(/CT/.test(footer), "フッターが CT 用の注記", footer);
    const stripText = (await geo.getByTestId("geometry3d-min-diameter").textContent().catch(() => "")) ?? "";
    check(/(最小径|Minimum diameter) 4\.0 mm/.test(stripText), "CT の木では径プロファイルの帯が出て、最小径が入力どおり（4.0 mm）", stripText);
    const s0 = await colorStats(geo, path.join(OUT_DIR, "1-tree-no-analysis.png"));
    console.log(`  解析前: ${JSON.stringify(s0)}`);
    check(s0.drawn > 200, "🔴 画面が真っ黒でない（管が描かれている）", s0);
    check(s0.cyan > 500 && s0.red < 30 && s0.blue < 30 && s0.grey < 30, "（自己検査）解析前は既定のシアンだけで、赤・青・グレーの画素がほぼ無い", s0);

    console.log("\n[3] 解析値: 2 区間だけ（幹=低値、枝1=高値、枝2=値なし）");
    const an = (extra: unknown[]) => ({ kind: "custom", label: "検査値", range: [0, 1], perPoint: extra });
    const bogus = await call(viewer, { op: "analysis", runId: reg.runId, analysis: an([{ segmentId: "nope", index: 0, value: 0.5 }]) });
    check(bogus?.ok === false, "負例: 未知の segmentId は ok:false", bogus);
    await geo.waitForTimeout(800);
    const sBogus = await colorStats(geo, path.join(OUT_DIR, "2-after-bogus.png"));
    check(sBogus.cyan > 500 && sBogus.red < 30 && sBogus.blue < 30, "負例: 拒否された解析で色は変わらない（既定のシアンのまま）", sBogus);
    const ok = await call(viewer, { op: "analysis", runId: reg.runId, analysis: an([...perPoint("trunk", 0), ...perPoint("b1", 1)]) });
    check(ok?.ok === true, "putVesselAnalysis が ok:true", ok);
    await geo.getByTestId("vessel-legend").waitFor({ state: "visible", timeout: 20_000 });
    await geo.waitForTimeout(1500);
    const s1 = await colorStats(geo, path.join(OUT_DIR, "3-tree-analysis.png"));
    console.log(`  解析後: ${JSON.stringify(s1)}`);
    check(s1.red > 500 && s1.blue > 500 && s1.grey > 500 && s1.cyan < 30, "🔴 幹=赤・枝1=青・値なしの枝2=グレーの画素が揃い、既定のシアンは消える", s1);
    check((await geo.getByTestId("vessel-legend-notrefined").count()) === 0, "凡例に XA 専用の注記（補正未了）が出ない");
    check((await objs.getAttribute("data-count")) === "3", "解析後も物体は 3 つ");

    console.log("\n[4] 窓の再利用: もう一度開いても窓・物体が増えない");
    const w0 = driver.app.windows().length;
    const again = await call(viewer, { op: "open", runId: reg.runId });
    await geo.waitForTimeout(2000);
    check(again?.ok === true && driver.app.windows().length === w0 && geoPages(driver).length === 1, "窓が増えない", { before: w0, after: driver.app.windows().length });
    check((await objs.getAttribute("data-count")) === "3", "物体が増えない（置き換わる）");

    console.log("\n[5] 既存: 単一の XA は物体 1 つ・XA の注記つき（従来どおり）");
    const regXa = await call(viewer, { op: "register", model: xaModel() });
    check(regXa?.ok === true, "xa-qca3d が登録できた", regXa);
    await call(viewer, { op: "open", runId: regXa.runId });
    await geo.waitForTimeout(2500);
    check((await objs.getAttribute("data-count")) === "1", "XA 単一血管は物体 1 つ", await objs.getAttribute("data-count"));
    check((await geo.getByTestId("geometry3d-profile-strip").count()) === 0, "🔴 XA 単一血管には径プロファイルの帯が出ない（従来どおり）");
    const footerXa = (await geo.getByTestId("geometry3d-footer").textContent()) ?? "";
    check(!/CT/.test(footerXa) || footerXa !== footer, "フッターは XA 用（CT 用と違う）", footerXa);
    const sx = await colorStats(geo, path.join(OUT_DIR, "4-xa-single.png"));
    check(sx.drawn > 100, "XA 単一血管も描かれている", sx);
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
