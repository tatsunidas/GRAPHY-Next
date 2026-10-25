/*
 * プラグインから中心線を渡して本体の Curved MPR を開く host API（openCurvedMpr）の実アプリ検査。
 *
 * 実行:  cd automator && GRAPHY_AUTOMATOR_HTTP_PORT=19610 GRAPHY_AUTOMATOR_SCP_PORT=19611 GRAPHY_AUTOMATOR_VITE_PORT=19613 \
 *          npx tsx src/spike/pluginCurvedMprCheck.ts
 *
 * 合成 CT（らせん状の管。式は curvedMprSynth.py の truth.json）に対し、検査用プラグイン（ui.js を一時に置く）が
 * openCurvedMpr を呼ぶ。見るもの:
 *   正例: 窓が開く／制御点数 = N／プレビューの長さ ≈ 解析の長さ／札が出る／管が中央の行に写る（正しい中心線でだけ）
 *   負例: 1 点・NaN・同一点・開いていないシリーズは窓を開かない／ずらした中心線では中央の行に管が写らない
 *   範囲外: 警告は範囲内で出ず、範囲外で出る（先に検出器を確かめる）
 *   編集: 点を足すと「編集済み」・制御点数 +1、［指定に戻す］で戻る
 *   再呼び出し: 窓が増えず、中心線が置き換わる
 * 結果は 合格／失敗 で数える。画面はスクリーンショットを .results/plugin-curved-mpr に残す（目視用）。
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { Page } from "@playwright/test";

import { resetDb } from "../backend/dbReset.js";
import { dismissStartupDialogs } from "../common/dismissDialogs.js";
import { DesktopDriver, DESKTOP_RUN_DATA_DIR } from "../driver/desktopDriver.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { createChecker } from "./computeSpikeShared.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "plugin-curved-mpr");
const PLUGIN_ID = "curved-mpr-probe";
const PLUGINS_DIR = path.join(DESKTOP_RUN_DATA_DIR, "plugins");
const { check, summary } = createChecker();

interface Truth { R: number; turns: number; z0: number; z1: number; originXY: number; dims: [number, number, number]; lengthMm: number }

function synth(): { dir: string; truth: Truth } {
  const dir = path.join(OUT_DIR, "synth");
  fs.rmSync(dir, { recursive: true, force: true });
  const r = spawnSync("python3", ["-I", path.join(import.meta.dirname, "curvedMprSynth.py"), dir], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`合成データを作れません: ${r.stderr}`);
  return { dir, truth: JSON.parse(fs.readFileSync(path.join(dir, "truth.json"), "utf8")) as Truth };
}

function installProbePlugin(): void {
  const dst = path.join(PLUGINS_DIR, PLUGIN_ID);
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(dst, { recursive: true });
  fs.writeFileSync(path.join(dst, "plugin.json"), JSON.stringify({
    id: PLUGIN_ID, name: "Curved MPR Probe", version: "0.0.1", engines: { graphy: ">=0.0.0" },
    contributes: ["viewer2d.menu"], ui: "ui.js",
  }, null, 2));
  // 検査側が window.__cmprCase に入れた仕様で openCurvedMpr を呼び、戻りを window.__cmprResult に置く。
  fs.writeFileSync(path.join(dst, "ui.js"), `export default {
  activate: async (host) => {
    const c = window.__cmprCase;
    if (!c) return;
    const t = host.getTargets()[0];
    const spec = { ...c.spec, source: c.useOpenSeries === false ? { seriesUid: "1.2.3.not.open" } : { seriesUid: t.seriesUid } };
    window.__cmprResult = undefined;
    try { window.__cmprResult = await host.openCurvedMpr(spec); }
    catch (e) { window.__cmprResult = { ok: false, error: "threw: " + String(e) }; }
  },
};
`);
}

/** らせんの制御点（患者 LPS mm）。dx,dy だけ全体をずらせる（負例用）。 */
function helixPoints(t: Truth, n: number, dx = 0, dy = 0): [number, number, number][] {
  const pts: [number, number, number][] = [];
  for (let i = 0; i < n; i++) {
    const z = t.z0 + ((t.z1 - t.z0) * i) / (n - 1);
    const th = (2 * Math.PI * t.turns * (z - t.z0)) / (t.z1 - t.z0);
    pts.push([t.R * Math.cos(th) + dx, t.R * Math.sin(th) + dy, z]);
  }
  return pts;
}

async function callPlugin(viewer: Page, kase: unknown): Promise<{ ok: boolean; error?: string } | undefined> {
  await viewer.evaluate((c) => { (window as unknown as Record<string, unknown>).__cmprCase = c; }, kase);
  await viewer.getByTestId("viewer2d-menu-plugins").click();
  await viewer.getByTestId(`plugin-item-${PLUGIN_ID}`).click();
  await viewer.waitForFunction(() => (window as unknown as Record<string, unknown>).__cmprResult !== undefined, null, { timeout: 15_000 });
  return viewer.evaluate(() => (window as unknown as Record<string, unknown>).__cmprResult as { ok: boolean; error?: string });
}

const cmprPages = (driver: DesktopDriver): Page[] => driver.app.windows().filter((w) => w.url().includes("curvedmpr"));

/** プレビュー画像（窓の 2 枚目の canvas）の、行ごとの平均明るさ。 */
async function previewRows(win: Page): Promise<{ w: number; h: number; rows: number[] }> {
  return win.evaluate(() => {
    const cs = Array.from(document.querySelectorAll("canvas"));
    const c = cs[cs.length - 1] as HTMLCanvasElement;
    const ctx = c.getContext("2d")!;
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const rows: number[] = [];
    for (let y = 0; y < c.height; y++) {
      let s = 0;
      for (let x = 0; x < c.width; x++) s += d[(y * c.width + x) * 4];
      rows.push(s / c.width);
    }
    return { w: c.width, h: c.height, rows };
  });
}

const textOf = async (win: Page, id: string): Promise<string> => (await win.getByTestId(id).count()) ? ((await win.getByTestId(id).first().innerText()).replace(/\s+/g, " ")) : "";

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const { dir, truth } = synth();
  installProbePlugin();
  const driver = new DesktopDriver();
  try {
    await driver.start();
    const page = driver.page;
    page.on("dialog", (d) => void d.accept());
    await resetDb(driver.ports.http);
    const imp = await importPaths(driver.ports.http, [dir]);
    check(!!imp, "合成 CT を取り込めた", imp);
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

    // ── 負例（窓は開かない） ──
    const before = cmprPages(driver).length;
    const bad: [string, unknown][] = [
      ["1 点", { spec: { centerline: [[0, 0, 10]] } }],
      ["NaN を含む", { spec: { centerline: [[0, 0, 10], [null, 0, 20]] } }],
      ["隣り合う点が同一", { spec: { centerline: [[0, 0, 10], [1, 1, 20], [1, 1, 20]] } }],
      ["開いていないシリーズ", { spec: { centerline: helixPoints(truth, 20) }, useOpenSeries: false }],
    ];
    for (const [label, c] of bad) {
      const r = await callPlugin(viewer, c);
      check(r?.ok === false && !!r.error, `負例（${label}）: ok:false と理由が返る`, r);
    }
    await viewer.waitForTimeout(1_500);
    check(cmprPages(driver).length === before, "負例: Curved MPR の窓は 1 つも開いていない", { before, after: cmprPages(driver).length });

    // ── 正例: 正しい中心線 ──
    const N = 60;
    const good = helixPoints(truth, N);
    let win: Page;
    {
      const [w] = await Promise.all([
        driver.waitForNewPage(async () => {
          const r = await callPlugin(viewer, { spec: { centerline: good, title: "synthetic helix" } });
          check(r?.ok === true, "正例: openCurvedMpr が ok:true", r);
        }, (u) => u.includes("curvedmpr")),
      ]);
      win = w;
    }
    await win.getByTestId("curvedmpr-plugin-banner").waitFor({ state: "visible", timeout: 90_000 });
    await win.waitForTimeout(2_500);
    const banner = await textOf(win, "curvedmpr-plugin-banner");
    check(banner.includes("Curved MPR Probe") && new RegExp(`\\(${N} |（${N} `).test(banner) && banner.includes("synthetic helix"), "札: プラグイン名・点数・title が出る", banner);
    check((await textOf(win, "curvedmpr-point-count")).includes(`${N}`), `制御点数 = ${N}`, await textOf(win, "curvedmpr-point-count"));
    check((await win.getByTestId("curvedmpr-outofbounds-warning").count()) === 0, "範囲内の中心線では範囲外の警告が出ない（検出器の正例）");
    // 長さ: プレビュー幅（列数）× 画素間隔。画素間隔は窓の既定（面内画素間隔 1.0 mm）
    const pv = await previewRows(win);
    const lenMm = pv.w * 1.0;
    check(Math.abs(lenMm - truth.lengthMm) <= 2.0, `プレビューの長さ ${lenMm.toFixed(1)} mm ≈ 解析 ${truth.lengthMm.toFixed(1)} mm（許容 2 mm）`, { w: pv.w });
    // 管が中央の行に写る（中心線が管に乗っているとき、中央付近の行は明るく、離れた行は暗い）
    const mid = Math.floor(pv.h / 2);
    const near = Math.max(...pv.rows.slice(mid - 1, mid + 2));
    const far = Math.min(pv.rows[Math.max(0, mid - 12)], pv.rows[Math.min(pv.h - 1, mid + 12)]);
    check(near - far > 30, `正しい中心線: 中央の行(${near.toFixed(0)})が離れた行(${far.toFixed(0)})より明るい（管が写る）`);
    await win.screenshot({ path: path.join(OUT_DIR, "01-good.png") });

    // ── 編集と指定に戻す ──
    const canvas = win.locator("canvas").first();
    const box = (await canvas.boundingBox())!;
    await win.mouse.dblclick(box.x + box.width * 0.2, box.y + box.height * 0.2);
    await win.waitForTimeout(500);
    check((await textOf(win, "curvedmpr-point-count")).includes(`${N + 1}`), `点を足すと制御点数 ${N + 1}`, await textOf(win, "curvedmpr-point-count"));
    check(/edited|編集済み/.test(await textOf(win, "curvedmpr-plugin-banner")), "札が「編集済み」になる", await textOf(win, "curvedmpr-plugin-banner"));
    await win.getByTestId("curvedmpr-plugin-reset").click();
    await win.waitForTimeout(500);
    check((await textOf(win, "curvedmpr-point-count")).includes(`${N}`) && !/edited|編集済み/.test(await textOf(win, "curvedmpr-plugin-banner")), "［指定に戻す］で点数が戻り「編集済み」が消える", await textOf(win, "curvedmpr-point-count"));

    // ── 再呼び出し: 窓が増えず、中心線が置き換わる（管から 8 mm ずらした中心線 → 管が写らない） ──
    const nWin = cmprPages(driver).length;
    const shifted = helixPoints(truth, 40, 8, 0);
    const r2 = await callPlugin(viewer, { spec: { centerline: shifted, title: "shifted" } });
    check(r2?.ok === true, "再呼び出し: ok:true", r2);
    await win.waitForFunction(() => document.querySelector('[data-testid="curvedmpr-point-count"]')?.textContent?.includes("40"), null, { timeout: 30_000 }).then(
      () => check(true, "再呼び出し: 同じ窓の制御点数が 40 に置き換わる"),
      () => check(false, "再呼び出し: 同じ窓の制御点数が 40 に置き換わる", "40 にならない"),
    );
    await win.waitForTimeout(1_500);
    check(cmprPages(driver).length === nWin, "再呼び出し: 窓が増えていない", { nWin, now: cmprPages(driver).length });
    const pv2 = await previewRows(win);
    const mid2 = Math.floor(pv2.h / 2);
    const near2 = Math.max(...pv2.rows.slice(mid2 - 1, mid2 + 2));
    const far2 = Math.min(pv2.rows[Math.max(0, mid2 - 12)], pv2.rows[Math.min(pv2.h - 1, mid2 + 12)]);
    check(near2 - far2 < 15, `ずらした中心線（負例）: 中央の行(${near2.toFixed(0)})は離れた行(${far2.toFixed(0)})より明るくない（管が写らない）`);
    await win.screenshot({ path: path.join(OUT_DIR, "02-shifted.png") });

    // ── 範囲外 ──
    const oob = helixPoints(truth, 30).map((p, i) => (i >= 25 ? ([p[0], p[1], p[2] + 400] as [number, number, number]) : p));
    const r3 = await callPlugin(viewer, { spec: { centerline: oob, title: "out of volume" } });
    check(r3?.ok === true, "範囲外の中心線も要求としては受理される（検証は窓側の警告）", r3);
    await win.getByTestId("curvedmpr-outofbounds-warning").waitFor({ state: "visible", timeout: 30_000 }).then(
      () => check(true, "範囲外: 警告が出る（検出器の負例）"),
      () => check(false, "範囲外: 警告が出る（検出器の負例）"),
    );
    const w = await textOf(win, "curvedmpr-outofbounds-warning");
    check(/5 of 30|30 点中 5 点/.test(w), "範囲外: 件数が 30 点中 5 点", w);
    await win.screenshot({ path: path.join(OUT_DIR, "03-out-of-bounds.png") });

    // ── 回帰: 中心線も出所も無い起動情報（手動起動と同じ形）では、札・警告が消え、点は 0 のまま ──
    await viewer.evaluate(([st, se]) => {
      localStorage.setItem("graphy-curvedmpr-ctx", JSON.stringify({ study: { studyInstanceUid: st }, series: { seriesInstanceUid: se }, ts: Date.now() }));
      const bc = new BroadcastChannel("graphy-curvedmpr");
      bc.postMessage({ type: "updated" });
      bc.close();
    }, [study.studyInstanceUid, series.seriesInstanceUid]);
    await win.waitForFunction(() => !document.querySelector('[data-testid="curvedmpr-plugin-banner"]'), null, { timeout: 30_000 }).then(
      () => check(true, "回帰: 出所の無い起動情報で札が消える"),
      () => check(false, "回帰: 出所の無い起動情報で札が消える"),
    );
    check((await win.getByTestId("curvedmpr-outofbounds-warning").count()) === 0, "回帰: 範囲外の警告も消える");
    check((await textOf(win, "curvedmpr-point-count")).includes("0"), "回帰: 制御点数は 0（手動で引く状態）", await textOf(win, "curvedmpr-point-count"));
  } finally {
    await driver.stop();
    fs.rmSync(path.join(PLUGINS_DIR, PLUGIN_ID), { recursive: true, force: true });
  }
  process.exitCode = summary() === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
