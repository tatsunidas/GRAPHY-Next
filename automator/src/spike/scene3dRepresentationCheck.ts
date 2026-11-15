/*
 * 3D シーンの物体ごとの「描き方」（面・線・点）の実アプリ検査。
 *
 * 検査用プラグイン（plugin.json＋ui.js を一時に置く）が合成の 3 区間の木（CT 由来の血管モデル）を登録して 3D 画面で開く。
 * 区間ごとに管の物体ができる。物体を選び、［線］［点］［面］を押して、
 *   - dev の口 `__graphyDebug.getScene3dState()`（アクターの property から読んだ値）が 1・0・2 になる
 *   - 選んでいない物体の描き方・色・不透明度・可視は変わらない
 *   - **描かれた画素**で、物体の色の画素数が［線］・［点］で減る（正例）／［面］→［面］では変わらない（負例＝検出器の自己検査）
 *   - ↶ で戻る・↷ でやり直せる。物体の詳細欄の数値は切替の前後で変わらない
 * を確かめる。値の判定は DOM の個数ではなく画素で行い、スクリーンショットも目で見る。
 *
 * 実行:  cd automator && npx tsx src/spike/scene3dRepresentationCheck.ts
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

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "scene3d-representation");
const PLUGIN_ID = "scene3d-repr-probe";
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
function installProbePlugin(): void {
  const dst = path.join(DESKTOP_RUN_DATA_DIR, "plugins", PLUGIN_ID);
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(dst, { recursive: true });
  fs.writeFileSync(path.join(dst, "plugin.json"), JSON.stringify({ id: PLUGIN_ID, name: "Scene3D Repr Probe", version: "0.0.1", engines: { graphy: ">=0.0.0" }, contributes: ["viewer2d.menu"], ui: "ui.js" }, null, 2));
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

type ObjState = { id: string; kind: string; storeRepresentation: string; actorRepresentation: number | null; color: number[] | null; opacity: number | null; visible: boolean | null };
const sceneState = (page: Page) => page.evaluate(() => (window as unknown as { __graphyDebug: { getScene3dState: () => unknown } }).__graphyDebug.getScene3dState()) as Promise<ObjState[]>;
const near = (a: number, b: number, rel: number) => Math.abs(a - b) <= rel * Math.max(1, b);

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "scene3d-repr-"));
  execFileSync("python3", ["-I", path.join(AUTOMATOR_ROOT, "scripts", "make-sphere-ct-phantom.py"), path.join(work, "ct"), "--spheres", JSON.stringify([{ c: [0, 0, 0], r: 5 }])], { stdio: "inherit" });
  installProbePlugin();

  const driver = new DesktopDriver();
  await driver.start();
  try {
    const page = driver.page;
    page.on("dialog", (d) => void d.accept());
    await resetDb(driver.ports.http);
    await page.evaluate("localStorage.setItem('graphy.update.skipVersion', '0.6.2'); localStorage.setItem('graphy.locale', 'ja')");
    const imp = await importPaths(driver.ports.http, [path.join(work, "ct")]);
    check(imp.failed === 0 && imp.imported > 0, "（前提）合成 CT を取り込めた", imp);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    await dismissStartupDialogs(page);
    const base = `http://localhost:${driver.ports.http}`;
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

    const reg = await call(viewer, { op: "register", model: ctModel() });
    check(reg?.ok === true, "（前提）3 区間の木を登録できた", reg);
    const geo = await driver.waitForNewPage(async () => {
      const r = await call(viewer, { op: "open", runId: reg.runId });
      check(r?.ok === true, "（前提）3D 画面で開く", r);
    }, (u) => u.includes("geometry3d"));
    geo.on("console", (m) => { if (m.type() === "error") console.log(`  [3d error] ${m.text().slice(0, 200)}`); });
    const objs = geo.getByTestId("geometry3d-objects");
    await objs.waitFor({ state: "visible", timeout: 120_000 });
    await geo.waitForTimeout(3000);
    await geo.evaluate("globalThis.__name = (f) => f");
    check((await objs.getAttribute("data-count")) === "3", "（前提）物体が 3 つ（区間ごとの管）", await objs.getAttribute("data-count"));
    const rows = geo.locator('[data-testid^="scene3d-row-"]');
    check((await rows.count()) === 3, "物体の一覧の行が 3 つ（行の testid が付いている）", await rows.count());

    // 管は細い（既定の拡大では太さが数画素で、面と線が画素で区別できない）。同じ拡大のまま全部を撮るので、先に大きく寄せる。
    const box = (await geo.getByTestId("geometry3d-canvas-host").boundingBox())!;
    await geo.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.75);
    for (let i = 0; i < 12; i++) { await geo.mouse.wheel(0, -300); await geo.waitForTimeout(80); }
    await geo.waitForTimeout(800);

    console.log("\n[0] 既定のまま: 全物体が面（2）。検出器の自己検査");
    const st0 = await sceneState(geo);
    check(st0.length === 3 && st0.every((s) => s.actorRepresentation === 2 && s.storeRepresentation === "surface"), "全物体で、アクターが面（2）・store も surface", st0);
    check(st0.every((s) => s.kind === "centerline"), "物体は中心線（管）の種別", st0.map((s) => s.kind));
    const s0 = await colorStats(geo, path.join(OUT_DIR, "0-surface.png"));
    console.log(`  既定: ${JSON.stringify(s0)}`);
    check(s0.drawn > 200 && s0.cyan > 500, "🔴 画面が真っ黒でない（シアンの管が描かれている）", s0);
    const sControl = await colorStats(geo, path.join(OUT_DIR, "0-surface-again.png"));
    check(near(sControl.cyan, s0.cyan, 0.01), "（自己検査）何も変えずに撮り直すとシアンの画素数が同じ（±1%）", { a: s0.cyan, b: sControl.cyan });

    const ids = st0.map((s) => s.id);
    await geo.getByTestId(`scene3d-row-${ids[0]}`).click();
    await geo.getByTestId("scene3d-repr-surface").waitFor({ state: "visible", timeout: 10_000 });
    check(true, "物体を選ぶと「描き方」の［面］［線］［点］が出る");
    const detail0 = await objs.innerText();

    console.log("\n[1] 対照（負例）: ［面］を押し直しても（すでに面）、画素・状態は変わらない");
    await geo.getByTestId("scene3d-repr-surface").click();
    await geo.waitForTimeout(800);
    const sSame = await colorStats(geo, path.join(OUT_DIR, "1-surface-to-surface.png"));
    check(near(sSame.cyan, s0.cyan, 0.01), "［面］→［面］でシアンの画素数が変わらない（±1%）", { before: s0.cyan, after: sSame.cyan });
    check((await sceneState(geo)).every((s) => s.actorRepresentation === 2), "［面］→［面］で状態も変わらない");

    console.log("\n[2] ［線］: 1 つ目の物体だけがアクター 1（WIREFRAME）。画素で見えるのは辺だけ");
    await geo.getByTestId("scene3d-repr-wireframe").click();
    await geo.waitForTimeout(1200);
    const st1 = await sceneState(geo);
    check(st1[0].actorRepresentation === 1 && st1[0].storeRepresentation === "wireframe", "🔴 選んだ物体: アクター 1・store wireframe", st1[0]);
    check(st1[1].actorRepresentation === 2 && st1[2].actorRepresentation === 2, "🔴 選んでいない 2 物体は面（2）のまま", [st1[1], st1[2]]);
    check(st1.every((s, i) => JSON.stringify([s.color, s.opacity, s.visible]) === JSON.stringify([st0[i].color, st0[i].opacity, st0[i].visible])), "全物体の色・不透明度・可視が変わらない");
    const sWire = await colorStats(geo, path.join(OUT_DIR, "2-wireframe.png"));
    console.log(`  線: ${JSON.stringify(sWire)}`);
    check(sWire.cyan > 100 && sWire.cyan < s0.cyan * 0.85, "🔴 画素: シアンが減る（幹が辺だけになる）が、残りの 2 物体と辺は写っている", { surface: s0.cyan, wire: sWire.cyan });
    check((await objs.innerText()) === detail0, "詳細欄の数値（長さなど）は切替の前後で変わらない");

    console.log("\n[3] ［点］");
    await geo.getByTestId("scene3d-repr-points").click();
    await geo.waitForTimeout(1200);
    const st2 = await sceneState(geo);
    check(st2[0].actorRepresentation === 0 && st2[1].actorRepresentation === 2, "［点］: 選んだ物体が 0（POINTS）・他は 2", st2.map((s) => s.actorRepresentation));
    const sPts = await colorStats(geo, path.join(OUT_DIR, "3-points.png"));
    console.log(`  点: ${JSON.stringify(sPts)}`);
    check(sPts.cyan > 100 && sPts.cyan < s0.cyan * 0.85, "画素: 点ではシアンが面より減る", { surface: s0.cyan, points: sPts.cyan });

    console.log("\n[4] 2 つ目の物体を選んで［線］→ 1 つ目の［点］は保たれる（物体ごと）");
    await geo.getByTestId(`scene3d-row-${ids[1]}`).click();
    await geo.getByTestId("scene3d-repr-wireframe").click();
    await geo.waitForTimeout(800);
    const st3 = await sceneState(geo);
    check(st3[0].actorRepresentation === 0 && st3[1].actorRepresentation === 1 && st3[2].actorRepresentation === 2, "1 つ目 0・2 つ目 1・3 つ目 2", st3.map((s) => s.actorRepresentation));

    console.log("\n[5] 元に戻す／やり直す（↶↷）");
    const undoBtn = geo.locator('button[title*="描き方"]').first();
    check((await undoBtn.getAttribute("title"))?.includes("描き方: 線") === true, "↶ のラベルが「描き方: 線」", await undoBtn.getAttribute("title"));
    await undoBtn.click();
    await geo.waitForTimeout(600);
    const st4 = await sceneState(geo);
    check(st4[1].actorRepresentation === 2 && st4[0].actorRepresentation === 0, "↶ で 2 つ目が面（2）に戻り、1 つ目の［点］は変わらない", st4.map((s) => s.actorRepresentation));
    await geo.locator('button[title*="描き方"]').nth(1).click().catch(() => undefined);
    await geo.waitForTimeout(600);
    check((await sceneState(geo))[1].actorRepresentation === 1, "↷ で 2 つ目が線（1）に戻る");
    // 記録は 3 つ（1 つ目の線・点、2 つ目の線）。3 回戻すと全部が面。
    for (let i = 0; i < 3; i++) { await geo.locator("button", { hasText: "↶" }).click(); await geo.waitForTimeout(300); }
    const st5 = await sceneState(geo);
    check(st5.every((s) => s.actorRepresentation === 2), "↶ を重ねると全物体が面に戻る", st5.map((s) => s.actorRepresentation));
    const sBack = await colorStats(geo, path.join(OUT_DIR, "5-back-to-surface.png"));
    check(near(sBack.cyan, s0.cyan, 0.01), "🔴 面に戻した画素が、最初の画素と一致（±1%）", { first: s0.cyan, back: sBack.cyan });
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
