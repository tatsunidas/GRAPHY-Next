/*
 * ROI・計測値の読み取りツール（getMeasurements）の実機検証。
 *
 * 実行:  cd automator && npx tsx src/spike/assistantMeasurementsCheck.ts
 *
 * 本物の Electron ＋ backend ＋ fixture(ct-basic) の #2dviewer 窓。main の確認ダイアログ（dialog.showMessageBox）はスタブして
 * 回数と応答を制御する。確かめること:
 *   1. 前提: ROI が 0 件のとき rois が空（先に ROI が実在しないことを確かめる）
 *   2. 前提: 楕円 ROI を実際に描き、画面の ROI 脇に「面積」「平均」が出ている
 *   3. 🔴 ローカル宛て: 確認なしで返り、面積・平均が**画面の表示と一致**（同じ値）。識別子・座標が含まれない
 *   4. 🔴 外部宛て(非ループバック): 初回だけ確認が出る。拒否では declined で値が返らない。承認で返り、2 回目は聞かない
 *   5. 🔴 書き込みが起きない（読み取りの前後で ROI の件数が同じ）
 *   6. 負例: メイン窓からの中継は forbidden
 * 未達として残すもの: 実 OS のネイティブ確認ダイアログの見た目／実クラウド提供元への実送信／ROI 50 件の所要時間。
 */
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import type { Page } from "playwright";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importFixtureCategory } from "../fixtures/importFixtures.js";
import { openFirstSeriesInViewer } from "../checklist/items/shared/helpers.js";
import { createStepRecorder } from "../checklist/types.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { createChecker } from "./computeSpikeShared.js";


const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "assistant-measurements-check");
const PORTS = { http: 19380, scp: 19381, vite: 19383 };
const { check, summary } = createChecker();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function dismissUpdate(page: Page): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await page.evaluate(`(function(){ var b=[].slice.call(document.querySelectorAll("button")).find(function(x){return /^(後で|Later)$/.test((x.textContent||"").trim());}); if(b) b.click(); })()`).catch(() => undefined);
    await sleep(500);
  }
}

/** ROI 脇に「いま描かれている文字」（画面の表示）。 */
async function readTextBoxLines(viewer: Page): Promise<string[]> {
  return viewer.evaluate(`
    (function () {
      var host = document.querySelector('[data-testid="viewer2d-canvas-host"]');
      if (!host) return [];
      var out = [];
      host.querySelectorAll("svg text").forEach(function (t) {
        var spans = t.querySelectorAll("tspan");
        if (spans.length) spans.forEach(function (s) { out.push((s.textContent || "").trim()); });
        else out.push((t.textContent || "").trim());
      });
      return out.filter(function (s) { return s.length > 0; });
    })()
  `) as Promise<string[]>;
}

/** 「平均: 55.3 HU」のような行から最初の数値。 */
const numAfter = (lines: string[], re: RegExp): number | null => {
  const l = lines.find((x) => re.test(x));
  const m = l?.match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
};

type Res = { ok: boolean; error?: string; untrusted?: boolean; measurements?: { rois: Record<string, unknown>[] } };

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const driver = new DesktopDriver(PORTS);
  let dataDir = "";
  const clean = () => {
    for (const f of ["ai-providers.json", "secrets.enc.json"]) {
      if (dataDir && fs.existsSync(path.join(dataDir, f))) fs.rmSync(path.join(dataDir, f));
    }
  };
  try {
    await driver.start();
    const info = await driver.app.evaluate(({ dialog }) => {
      dialog.showMessageBoxSync = (() => 0) as typeof dialog.showMessageBoxSync;
      return { cwd: process.cwd() };
    });
    dataDir = info.cwd;
    clean();
    const main: Page = driver.page;
    await resetDb(driver.ports.http);
    await importFixtureCategory(driver.ports.http, "ct-basic");
    await main.reload({ waitUntil: "domcontentloaded" });
    await main.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 30_000 });
    await dismissUpdate(main);
    await openFirstSeriesInViewer(main, createStepRecorder());
    await dismissUpdate(main);
    const viewer = await driver.waitForNewPage(() => main.getByTestId("viewer2d-toolbar-button").click(), (u) => u.includes("2dviewer"));
    await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 20_000 });
    await viewer.waitForTimeout(2500);

    // main の確認ダイアログをスタブ（0=送る / 1=取り消す）
    await driver.app.evaluate(({ dialog }) => {
      const g = globalThis as unknown as { __dlg: { n: number; response: number; last: unknown } };
      g.__dlg = { n: 0, response: 0, last: null };
      (dialog as unknown as { showMessageBox: unknown }).showMessageBox = async (_w: unknown, o: unknown) => {
        g.__dlg.n++;
        g.__dlg.last = o;
        return { response: g.__dlg.response, checkboxChecked: false };
      };
    });
    const dlg = () => driver.app.evaluate(() => (globalThis as unknown as { __dlg: { n: number; last: { message?: string } | null } }).__dlg);
    const setResponse = (r: number) => driver.app.evaluate((_a, v) => { (globalThis as unknown as { __dlg: { response: number } }).__dlg.response = v; }, r);
    const setProvider = async (endpoint: string, label: string, auth: "none" | "api-key") => {
      const p = { id: "p1", label, kind: "openai", endpoint, auth, models: { "text-to-text": "tiny" } };
      const r = await main.evaluate(
        (cfg) => (window as unknown as { graphyDesktop: { aiProvidersSet: (c: unknown) => Promise<{ ok: boolean; error?: string }> } }).graphyDesktop.aiProvidersSet(cfg),
        { providers: [p], defaults: { "text-to-text": "p1" } },
      );
      return r;
    };

    const win = await driver.waitForNewPage(async () => {
      await main.getByTestId("mainscreen-menu-system").click();
      await main.getByTestId("menu-item-assistant").click();
    }, (u) => u.includes("#assistant"));
    await win.getByTestId("assistant-root").waitFor({ state: "visible", timeout: 20_000 });
    await win.setViewportSize({ width: 520, height: 780 });
    await sleep(600);
    const cmd = (sid: string) => win.evaluate((s) => (window as unknown as { graphyDesktop: { assistantViewerCmd: (s: string, c: unknown) => Promise<Res> } }).graphyDesktop.assistantViewerCmd(s, { kind: "getMeasurements" }), sid);
    const annCount = () => viewer.evaluate(`(function(){ return window.__graphyDebug.getAnnotationCanvasPoints().length; })()`) as Promise<number>;

    // --- 1. ROI 0 件 ---
    console.log("\n[1] ROI 0 件");
    check((await annCount()) === 0, "前提: ROI が 0 件", await annCount());
    const s1 = await setProvider("http://127.0.0.1:9", "ローカル", "none");
    check(s1.ok === true, "ローカル提供元を保存できる", s1);
    const empty = await cmd("e");
    check(empty.ok === true && Array.isArray(empty.measurements?.rois) && empty.measurements!.rois.length === 0, "ROI 0 件なら rois が空配列", empty);

    // --- 2. 楕円 ROI を描く ---
    console.log("\n[2] 楕円 ROI を描く");
    await viewer.getByTestId("viewer2d-menu-roi").click();
    await viewer.getByRole("button", { name: /^(楕円 ROI|Ellipse ROI)$/ }).first().click();
    await viewer.waitForTimeout(250);
    const box = await viewer.getByTestId("series-viewer-root").first().boundingBox();
    if (!box) throw new Error("viewer box");
    await viewer.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.35);
    await viewer.mouse.down();
    await viewer.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.5, { steps: 10 });
    await viewer.mouse.up();
    await viewer.waitForTimeout(1500);
    const n1 = await annCount();
    check(n1 === 1, "前提: 楕円 ROI が 1 件描けた", n1);
    const lines = await readTextBoxLines(viewer);
    console.log(`  画面の ROI 脇: ${JSON.stringify(lines)}`);
    const shownMean = numAfter(lines, /平均|Mean/);
    const shownArea = numAfter(lines, /面積|Area/);
    check(shownMean !== null && shownArea !== null, "前提: 画面に平均と面積が出ている", lines);
    await viewer.screenshot({ path: path.join(OUT_DIR, "2-roi.png") });

    // --- 3. ローカル宛て ---
    console.log("\n[3] ローカル宛て");
    const d0 = (await dlg()).n;
    const local = await cmd("l");
    check(local.ok === true && local.untrusted === true, "ローカル宛てで返り、untrusted が付く", local);
    check((await dlg()).n === d0, "🔴 ローカル宛てでは確認が出ない");
    const r0 = local.measurements?.rois?.[0] ?? {};
    check(local.measurements?.rois?.length === 1 && r0.tool === "EllipticalROI", "ROI 1 件・ツール種別が楕円", local.measurements);
    check(Math.abs(Number(r0.areaMm2) - (shownArea ?? NaN)) <= 0.5, "🔴 面積が画面の表示と一致（表示は整数に丸め）", { tool: r0.areaMm2, shown: shownArea });
    check(Math.abs(Number(r0.mean) - (shownMean ?? NaN)) <= 0.051, "🔴 平均が画面の表示と一致（表示の丸めの範囲）", { tool: r0.mean, shown: shownMean });
    check(r0.unit === "HU", "単位が HU", r0.unit);
    const text = JSON.stringify(local);
    for (const k of ["roiUid", "patientKey", "studyUid", "seriesUid", "sopInstanceUid", "points", "spacing"]) check(!text.includes(k), `🔴 結果に ${k} が含まれない`);

    // --- 4. 外部宛て ---
    console.log("\n[4] 外部宛て（非ループバック）");
    const s4 = await setProvider("https://ai.example.invalid", "外部AI", "api-key");
    check(s4.ok === true, "外部提供元を保存できる", s4);
    await setResponse(1);
    const d1 = (await dlg()).n;
    const refused = await cmd("x");
    check((await dlg()).n === d1 + 1, "🔴 外部宛て初回に確認が 1 回出る", await dlg());
    check(refused.ok === false && refused.error === "declined" && !refused.measurements, "🔴 取り消すと declined で値が返らない", refused);
    await setResponse(0);
    const approved = await cmd("x");
    check(approved.ok === true && (approved.measurements?.rois?.length ?? 0) === 1, "承認すると値が返る", approved);
    check(/外部の AI/.test((await dlg()).last?.message ?? ""), "確認の文面は main が持つもの（外部の AI へ送る）", (await dlg()).last);
    const d2 = (await dlg()).n;
    const again = await cmd("x");
    check(again.ok === true && (await dlg()).n === d2, "同じセッションでは 2 回目から聞かない");

    // --- 5. 書き込みなし ---
    check((await annCount()) === n1, "🔴 読み取りの前後で ROI の件数が変わらない（対象は実在する）", { before: n1, after: await annCount() });

    // --- 6. 他の窓 ---
    console.log("\n[6] 他の窓から");
    const r6 = await main.evaluate(() => (window as unknown as { graphyDesktop: { assistantViewerCmd: (s: string, c: unknown) => Promise<Res> } }).graphyDesktop.assistantViewerCmd("x", { kind: "getMeasurements" }));
    check(r6.ok === false && (r6 as { error?: string }).error === "forbidden", "🔴 メイン窓からの中継は forbidden", r6);
  } finally {
    await driver.stop();
    clean();
  }
  const failed = summary();
  fs.writeFileSync(path.join(OUT_DIR, "result.json"), JSON.stringify({ failed }, null, 2));
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
