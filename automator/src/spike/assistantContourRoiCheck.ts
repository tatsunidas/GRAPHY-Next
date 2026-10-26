/*
 * アシスタント組み込みの createContourRoi（多角形・自由曲線）を実機で検証する。
 *
 * 実行:  cd automator && npx tsx src/spike/assistantContourRoiCheck.ts
 *
 * 本物の Electron ＋ backend ＋ fixture(ct-basic) の #2dviewer 窓。アシスタント窓の中継口（assistantViewerCmd）から命令を送る
 * （main の確認は stub して応答を制御）。結果は実際の注釈（getAnnotationCanvasPoints）と getMeasurements で確かめる。
 *   1. 🔴 拒否: 確認が 1 回出て、拒否すると ROI が増えない
 *   2. 🔴 承認: 非凸（L 字）の多角形 → 面積が「頂点の画面位置の靴ひも公式 × mm/px²」の 2% 以内。頂点の画面位置が指定した割合に一致
 *      （mm/px は楕円 20×10 mm の画面上の半径から求める＝多角形の実装とは独立）。別の形（三角形）でも一致＝定数ではない
 *   3. 🔴 自由曲線: 48 点の閉曲線 → 面積が 48 角形の解析値の 2% 以内、ツールが GraphyFreehandROI
 *   4. 🔴 取り消し: inverse で作った分だけ消え、手描きは残る
 *   5. 🔴 負例: 蝶ネクタイ・共線・点数不足・範囲外は確認ダイアログの前に拒否され、ROI は増えない。メイン窓からは forbidden
 *   6. 保存の往復: 作った ROI が、ビューア窓を閉じて開き直しても同じ形・面積で戻る
 * 未達として残すもの: 実 OS のネイティブ確認の見た目／回転・反転表示での実機確認／実モデルが妥当な頂点を指せるか。
 */
import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright";

import { DesktopDriver, DESKTOP_RUN_DATA_DIR } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importFixtureCategory } from "../fixtures/importFixtures.js";
import { openFirstSeriesInViewer } from "../checklist/items/shared/helpers.js";
import { createStepRecorder } from "../checklist/types.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { createChecker } from "./computeSpikeShared.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "assistant-contour-roi-check");
const PORTS = { http: 19450, scp: 19451, vite: 19453 };
const { check, summary } = createChecker();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function dismissUpdate(page: Page): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await page.evaluate(`(function(){ var b=[].slice.call(document.querySelectorAll("button")).find(function(x){return /^(後で|Later)$/.test((x.textContent||"").trim());}); if(b) b.click(); })()`).catch(() => undefined);
    await sleep(500);
  }
}

type Res = { ok: boolean; error?: string; inverse?: { id: string; params: { roiUid?: string } }[]; measurements?: { rois: Record<string, unknown>[] } };
type Ann = { uid: string; tool: string; points: number[][] };

const shoelace = (p: number[][]): number => Math.abs(p.reduce((s, a, i) => { const b = p[(i + 1) % p.length]; return s + a[0] * b[1] - b[0] * a[1]; }, 0)) / 2;

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  let dataDir = "";
  const driver = new DesktopDriver(PORTS);
  try {
    await driver.start();
    const info = await driver.app.evaluate(({ dialog }) => {
      dialog.showMessageBoxSync = (() => 0) as typeof dialog.showMessageBoxSync;
      return { cwd: process.cwd() };
    });
    dataDir = info.cwd;
    for (const f of ["ai-providers.json", "secrets.enc.json"]) fs.rmSync(path.join(dataDir, f), { force: true });
    const main: Page = driver.page;
    await resetDb(driver.ports.http);
    await importFixtureCategory(driver.ports.http, "ct-basic");
    await main.reload({ waitUntil: "domcontentloaded" });
    await main.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 30_000 });
    await dismissUpdate(main);
    await openFirstSeriesInViewer(main, createStepRecorder());
    await dismissUpdate(main);
    const openViewer = () => driver.waitForNewPage(() => main.getByTestId("viewer2d-toolbar-button").click(), (u) => u.includes("2dviewer"));
    let viewer = await openViewer();
    await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 20_000 });
    await viewer.waitForTimeout(2500);

    const prov = await main.evaluate(
      (cfg) => (window as unknown as { graphyDesktop: { aiProvidersSet: (c: unknown) => Promise<{ ok: boolean }> } }).graphyDesktop.aiProvidersSet(cfg),
      { providers: [{ id: "local", label: "ローカル", kind: "openai", endpoint: "http://127.0.0.1:9", auth: "none", models: { "text-to-text": "tiny" } }], defaults: { "text-to-text": "local" } },
    );
    check(prov.ok === true, "ローカル提供元を保存できる", prov);

    await driver.app.evaluate(({ dialog }) => {
      const g = globalThis as unknown as { __dlg: { n: number; orig: unknown; response: number } };
      g.__dlg = { n: 0, orig: dialog.showMessageBox, response: 1 };
      (dialog as unknown as { showMessageBox: unknown }).showMessageBox = async () => {
        g.__dlg.n++;
        return { response: g.__dlg.response, checkboxChecked: false };
      };
    });
    const dlgCount = () => driver.app.evaluate(() => (globalThis as unknown as { __dlg: { n: number } }).__dlg.n);
    const setResponse = (r: number) => driver.app.evaluate((_a, v) => { (globalThis as unknown as { __dlg: { response: number } }).__dlg.response = v; }, r);

    const win = await driver.waitForNewPage(async () => {
      await main.getByTestId("mainscreen-menu-system").click();
      await main.getByTestId("menu-item-assistant").click();
    }, (u) => u.includes("#assistant"));
    await win.getByTestId("assistant-root").waitFor({ state: "visible", timeout: 20_000 });
    await sleep(800);
    const cmd = (page: Page, c: unknown) =>
      page.evaluate((c) => (window as unknown as { graphyDesktop: { assistantViewerCmd: (s: string, c: unknown) => Promise<unknown> } }).graphyDesktop.assistantViewerCmd("contour-roi", c), c) as Promise<Res>;
    const act = (id: string, params: unknown) => cmd(win, { kind: "action", id, params });
    const measure = async () => ((await cmd(win, { kind: "getMeasurements" })).measurements?.rois ?? []);
    const anns = () => viewer.evaluate(`(function(){ return window.__graphyDebug.getAnnotationCanvasPoints(); })()`) as Promise<Ann[]>;
    const canvasSize = () => viewer.evaluate(`(function(){ var r=document.querySelector('[data-testid="series-viewer-root"] canvas'); return [r.clientWidth, r.clientHeight]; })()`) as Promise<[number, number]>;

    // --- 手描き（バイスタンダー）---
    console.log("\n[0] 手で楕円 ROI を描く（取り消しで残ることの確認用）");
    check((await anns()).length === 0, "前提: ROI が 0 件から始まる");
    await viewer.getByTestId("viewer2d-menu-roi").click();
    await viewer.getByRole("button", { name: /^(楕円 ROI|Ellipse ROI)$/ }).first().click();
    await viewer.waitForTimeout(250);
    const box = await viewer.getByTestId("series-viewer-root").first().boundingBox();
    if (!box) throw new Error("viewer box");
    await viewer.mouse.move(box.x + box.width * 0.1, box.y + box.height * 0.1);
    await viewer.mouse.down();
    await viewer.mouse.move(box.x + box.width * 0.18, box.y + box.height * 0.18, { steps: 10 });
    await viewer.mouse.up();
    await viewer.waitForTimeout(1500);
    const base = await anns();
    check(base.length === 1, "前提: 手描きの楕円 ROI が 1 件", base.length);
    const handUid = base[0]?.uid ?? "";

    // mm/px の基準: 半径 20×10 mm の楕円（createRoi）の画面上の半径から求める（多角形の実装とは独立）
    await setResponse(0);
    const ref = await act("createRoi", { shape: "ellipse", u: 0.5, v: 0.5, radiusXmm: 20, radiusYmm: 10 });
    check(ref.ok === true, "前提: 基準の楕円を作れる", ref);
    await viewer.waitForTimeout(1200);
    const [cw, ch] = await canvasSize();
    const refAnn = (await anns()).find((a) => a.uid === ref.inverse?.[0]?.params.roiUid);
    // 楕円のハンドルは [bottom, top, left, right]
    const rxPx = refAnn ? Math.abs(refAnn.points[3][0] - refAnn.points[2][0]) / 2 : NaN;
    const ryPx = refAnn ? Math.abs(refAnn.points[0][1] - refAnn.points[1][1]) / 2 : NaN;
    const sx = 20 / rxPx;
    const sy = 10 / ryPx;
    console.log(`  mm/px: x=${sx.toFixed(4)} y=${sy.toFixed(4)}（canvas ${cw}×${ch}）`);
    check(Number.isFinite(sx) && Number.isFinite(sy) && sx > 0 && sy > 0, "前提: mm/px が求まる", { sx, sy });
    if (ref.inverse?.[0]) await act(ref.inverse[0].id, ref.inverse[0].params);
    await viewer.waitForTimeout(600);
    check((await anns()).length === 1, "前提: 基準の楕円を消して手描きだけに戻った", (await anns()).length);

    // --- 1. 拒否 ---
    console.log("\n[1] 拒否");
    const L = [[0.15, 0.15], [0.55, 0.15], [0.55, 0.4], [0.3, 0.4], [0.3, 0.7], [0.15, 0.7]]; // 非凸
    await setResponse(1);
    const d0 = await dlgCount();
    const refused = await act("createContourRoi", { shape: "polygon", points: L });
    check((await dlgCount()) === d0 + 1, "🔴 createContourRoi は確認が 1 回出る", (await dlgCount()) - d0);
    check(refused.ok === false && refused.error === "declined", "🔴 拒否すると declined", refused);
    check((await anns()).length === 1, "🔴 拒否したら ROI は増えない（前提: 承認なら増える＝次の節）", (await anns()).length);

    // --- 2. 承認: 多角形 ---
    console.log("\n[2] 承認（非凸の多角形）");
    await setResponse(0);
    const made = await act("createContourRoi", { shape: "polygon", points: L });
    check(made.ok === true, "承認すると作れる", made);
    const inv = made.inverse ?? [];
    check(inv.length === 1 && inv[0].id === "removeAssistantRoi" && typeof inv[0].params.roiUid === "string", "取り消し用の inverse が返る", inv);
    await viewer.waitForTimeout(1500);
    const a2 = await anns();
    check(a2.length === 2, "🔴 ROI が 2 件になった", a2.length);
    const poly = a2.find((a) => a.uid === inv[0]?.params.roiUid);
    check(poly?.tool === "GraphyPolygonROI", "ツールは本体の手描きと同じ GraphyPolygonROI", poly?.tool);
    const px = poly?.points ?? [];
    const posErr = px.length === L.length ? Math.max(...px.map((p, i) => Math.hypot(p[0] / cw - L[i][0], p[1] / ch - L[i][1]))) : NaN;
    check(px.length === L.length && posErr < 0.01, "🔴 頂点の画面位置が指定した割合どおり（順序も一致）", { n: px.length, posErr });
    const polyArea = Number((await measure()).find((r) => r.tool === "GraphyPolygonROI")?.areaMm2);
    const expPoly = shoelace(L.map(([u, v]) => [u * cw, v * ch])) * sx * sy;
    console.log(`  多角形の面積: ${polyArea}（解析値 ${expPoly.toFixed(1)}）`);
    check(Math.abs(polyArea - expPoly) / expPoly < 0.02, "🔴 面積が解析値（靴ひも公式 × mm/px²）の 2% 以内", { polyArea, expPoly });
    await viewer.screenshot({ path: path.join(OUT_DIR, "1-polygon.png") });

    const T = [[0.6, 0.6], [0.9, 0.65], [0.7, 0.9]];
    const tri = await act("createContourRoi", { shape: "polygon", points: T });
    check(tri.ok === true, "三角形も作れる", tri);
    await viewer.waitForTimeout(1200);
    const triArea = Number((await measure()).filter((r) => r.tool === "GraphyPolygonROI").map((r) => Number(r.areaMm2)).find((a) => Math.abs(a - polyArea) / polyArea > 0.05));
    const expTri = shoelace(T.map(([u, v]) => [u * cw, v * ch])) * sx * sy;
    check(Math.abs(triArea - expTri) / expTri < 0.02, "🔴 別の形（三角形）でも面積が解析値の 2% 以内＝定数ではない", { triArea, expTri });

    // --- 3. 自由曲線 ---
    console.log("\n[3] 自由曲線（48 点の閉曲線）");
    const circ = Array.from({ length: 48 }, (_, i) => [0.75 + 0.1 * Math.cos((2 * Math.PI * i) / 48), 0.3 + 0.15 * Math.sin((2 * Math.PI * i) / 48)]);
    const free = await act("createContourRoi", { shape: "freehand", points: circ });
    check(free.ok === true, "自由曲線を作れる", free);
    await viewer.waitForTimeout(1500);
    const a3 = await anns();
    const fAnn = a3.find((a) => a.uid === free.inverse?.[0]?.params.roiUid);
    check(fAnn?.tool === "GraphyFreehandROI", "ツールは本体の手描きと同じ GraphyFreehandROI", fAnn?.tool);
    const fArea = Number((await measure()).find((r) => r.tool === "GraphyFreehandROI")?.areaMm2);
    const expFree = shoelace(circ.map(([u, v]) => [u * cw, v * ch])) * sx * sy;
    console.log(`  自由曲線の面積: ${fArea}（解析値 ${expFree.toFixed(1)}）`);
    check(Math.abs(fArea - expFree) / expFree < 0.02, "🔴 面積が 48 角形の解析値の 2% 以内", { fArea, expFree });
    await viewer.screenshot({ path: path.join(OUT_DIR, "2-freehand.png") });

    // --- 6. 保存の往復（ビューア窓を閉じて開き直す）---
    console.log("\n[6] 保存の往復");
    const before = (await measure()).map((r) => `${String(r.tool)}:${Number(r.areaMm2).toFixed(1)}`).sort();
    await sleep(3000); // 自動保存の待ち
    await viewer.close();
    viewer = await openViewer();
    await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 20_000 });
    await viewer.waitForTimeout(3500);
    const reopened = await anns();
    const after = (await measure()).map((r) => `${String(r.tool)}:${Number(r.areaMm2).toFixed(1)}`).sort();
    console.log(`  前: ${JSON.stringify(before)}\n  後: ${JSON.stringify(after)}`);
    check(reopened.length === 4 && before.length === 4, "🔴 開き直しても 4 件（手描き 1・多角形 2・自由曲線 1）が戻る（前提: 開く前も 4 件）", { before: before.length, after: reopened.length });
    check(JSON.stringify(before) === JSON.stringify(after), "🔴 ツール名と面積が開く前と一致", { before, after });
    await viewer.screenshot({ path: path.join(OUT_DIR, "3-reopened.png") });

    // --- 4. 取り消し ---
    console.log("\n[4] 取り消し");
    const rmHand = await act("removeAssistantRoi", { roiUid: handUid });
    check(rmHand.ok === false && rmHand.error === "not-removable" && (await anns()).length === 4, "🔴 手描きの ROI は uid を直接指定しても消えない（前提: 4 件ある）", { rmHand, n: (await anns()).length });
    const dlgBefore = await dlgCount();
    for (const step of [...(free.inverse ?? []), ...(tri.inverse ?? []), ...inv]) {
      const r = await act(step.id, step.params);
      check(r.ok === true, "inverse を実行できる（開き直したあとの ROI も消せる）", r);
    }
    check((await dlgCount()) === dlgBefore, "取り消しは確認を出さない", (await dlgCount()) - dlgBefore);
    await viewer.waitForTimeout(800);
    const a4 = await anns();
    check(a4.length === 1 && a4[0].uid === handUid, "🔴 作った 3 件だけ消え、手描きが残る", a4.map((a) => a.uid));

    // --- 5. 負例 ---
    console.log("\n[5] 負例");
    const n0 = await dlgCount();
    const cases: [string, unknown][] = [
      ["蝶ネクタイ（自己交差）", { shape: "polygon", points: [[0.2, 0.2], [0.8, 0.8], [0.8, 0.2], [0.2, 0.8]] }],
      ["共線", { shape: "polygon", points: [[0.1, 0.1], [0.5, 0.5], [0.9, 0.9]] }],
      ["点数不足", { shape: "polygon", points: [[0.1, 0.1], [0.9, 0.9]] }],
      ["範囲外の u", { shape: "freehand", points: [[0.1, 0.1], [1.2, 0.5], [0.5, 0.9]] }],
      ["未知の形", { shape: "ellipse", points: L }],
      ["未知キー", { shape: "polygon", points: L, radiusXmm: 5 }],
    ];
    for (const [label, p] of cases) {
      const r = await act("createContourRoi", p);
      check(r.ok === false, `🔴 ${label} は拒否`, r);
    }
    check((await anns()).length === 1, "🔴 拒否された作成で ROI は増えない（対象は実在する）", (await anns()).length);
    check((await dlgCount()) - n0 === 0, "🔴 不正な形では確認ダイアログが出ない（6 回で 0 回。対照: 正しい形では [1][2] で毎回出ている）", (await dlgCount()) - n0);
    const fromMain = await cmd(main, { kind: "action", id: "createContourRoi", params: { shape: "polygon", points: L } });
    check(fromMain.ok === false && fromMain.error === "forbidden", "🔴 メイン窓からの中継は forbidden", fromMain);
    check((await anns()).length === 1, "メイン窓の命令でも ROI は増えない", (await anns()).length);
  } finally {
    await driver.app
      .evaluate(({ dialog }) => {
        const g = globalThis as unknown as { __dlg?: { orig: unknown } };
        if (g.__dlg) (dialog as unknown as { showMessageBox: unknown }).showMessageBox = g.__dlg.orig;
      })
      .catch(() => undefined);
    await driver.stop();
    for (const f of ["ai-providers.json", "secrets.enc.json"]) fs.rmSync(path.join(dataDir, f), { force: true });
    void DESKTOP_RUN_DATA_DIR;
  }
  const failed = summary();
  fs.writeFileSync(path.join(OUT_DIR, "result.json"), JSON.stringify({ failed }, null, 2));
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
