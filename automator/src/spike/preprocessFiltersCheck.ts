/*
 * 前処理フィルタのプラグイン（反転・値域クリップ・平滑化）の実機検証。
 *
 * 実行:  cd automator && npx tsx src/spike/preprocessFiltersCheck.ts
 * 前提:  backend jar（`cd backend && mvn -q -Dfrontend.skip=true -DskipTests package`）、fixture ct-basic、frontend の npm ci。
 *        プラグインの場所は環境変数 GRAPHY_PLUGIN_PREPROCESS_FILTERS_DIR（既定は隣の graphy-next-plugin-preprocess-filters）。
 *
 * 何を確かめるか（本物の Electron ＋ 本物の backend ＋ 手置きのプラグイン）:
 *   1. プラグインがメニューに出て、ダイアログから実行できる
 *   2. 本体の確認ダイアログが必ず出て、**拒否すると何も保存されない**（負例）
 *   3. 承諾すると派生シリーズが保管庫に生える。**DICOM を読み直して、元の画素から別に計算した期待値と一致する**
 *        - 反転: 全スライス・全画素で v + v' = lo + hi（lo・hi は元の全体の最小・最大）
 *        - クリップ: 全スライス・全画素で clamp(v, lo, hi)
 *        - ガウシアン（3D, σ mm）: 無作為に選んだ内部の画素で、素朴な 3D の直接計算と一致（量子化 ±0.5 HU）
 *   4. 元シリーズの画素は不変
 *   派生と元の対応は ImagePositionPatient で取る（保存順・sliceIndex に依存しない）。
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { Page } from "@playwright/test";

import { DesktopDriver, DESKTOP_RUN_DATA_DIR } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importFixtureCategory } from "../fixtures/importFixtures.js";
import { openFirstSeriesInViewer } from "../checklist/items/shared/helpers.js";
import { createStepRecorder } from "../checklist/types.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { createChecker } from "./computeSpikeShared.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "preprocess-filters-check");
const PLUGIN_ID = "preprocess-filters";
const PLUGIN_SRC =
  process.env.GRAPHY_PLUGIN_PREPROCESS_FILTERS_DIR ??
  path.join(AUTOMATOR_ROOT, "..", "..", "graphy-next-plugin-preprocess-filters");

const requireFromFrontend = createRequire(path.join(AUTOMATOR_ROOT, "..", "frontend", "package.json"));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dicomParser: any = requireFromFrontend("dicom-parser");

const { check: rawCheck, summary } = createChecker();
const T0 = Date.now();
function check(cond: boolean, label: string, detail?: unknown): void {
  process.stdout.write(`  [+${((Date.now() - T0) / 1000).toFixed(0)}s]`);
  rawCheck(cond, label, detail);
}

interface Slice {
  ipp: string;
  rows: number;
  cols: number;
  /** モダリティ値（HU）。 */
  hu: Float32Array;
  spacing: [number, number, number];
}

/** 無圧縮の DICOM を読み、HU の配列と IPP を返す。圧縮なら例外（この検証は無圧縮のフィクスチャ前提）。 */
async function readInstance(url: string): Promise<Slice & { sop: string }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const ds = dicomParser.parseDicom(bytes);
  const ts = ds.string("x00020010");
  if (ts !== "1.2.840.10008.1.2.1" && ts !== "1.2.840.10008.1.2") throw new Error(`圧縮・未対応の転送構文: ${ts}`);
  const rows = ds.uint16("x00280010");
  const cols = ds.uint16("x00280011");
  const bits = ds.uint16("x00280100");
  const signed = ds.uint16("x00280103") === 1;
  if (bits !== 16) throw new Error(`BitsAllocated=${bits}（16 のみ対応）`);
  const slope = Number(ds.string("x00281053") ?? "1");
  const intercept = Number(ds.string("x00281052") ?? "0");
  const el = ds.elements.x7fe00010;
  const dv = new DataView(bytes.buffer, bytes.byteOffset + el.dataOffset, rows * cols * 2);
  const hu = new Float32Array(rows * cols);
  for (let i = 0; i < hu.length; i++) {
    const raw = signed ? dv.getInt16(i * 2, true) : dv.getUint16(i * 2, true);
    hu[i] = raw * slope + intercept;
  }
  const ps = (ds.string("x00280030") ?? "1\\1").split("\\").map(Number);
  return {
    sop: ds.string("x00080018"),
    ipp: (ds.string("x00200032") ?? "").split("\\").map((s: string) => Number(s).toFixed(3)).join("\\"),
    rows,
    cols,
    hu,
    spacing: [ps[1], ps[0], Number(ds.string("x00180088") ?? ds.string("x00180050") ?? "1")],
  };
}

async function readSeries(http: number, studyUid: string, seriesUid: string): Promise<Map<string, Slice>> {
  const base = `http://localhost:${http}/api/studies/${encodeURIComponent(studyUid)}/series/${encodeURIComponent(seriesUid)}`;
  const insts = (await (await fetch(`${base}/instances`)).json()) as Array<{ sopInstanceUid: string }>;
  const out = new Map<string, Slice>();
  for (const i of insts) {
    const s = await readInstance(`${base}/instances/${encodeURIComponent(i.sopInstanceUid)}/file`);
    out.set(s.ipp, s);
  }
  return out;
}

interface SeriesRow {
  seriesInstanceUid: string;
  seriesDescription?: string;
}
async function listSeries(http: number, studyUid: string): Promise<SeriesRow[]> {
  return (await (await fetch(`http://localhost:${http}/api/studies/${encodeURIComponent(studyUid)}/series`)).json()) as SeriesRow[];
}

function installPlugin(): void {
  const dst = path.join(DESKTOP_RUN_DATA_DIR, "plugins", PLUGIN_ID);
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(dst, { recursive: true });
  for (const name of ["plugin.json", "ui.js", "graphy-plugin.d.ts"]) {
    fs.copyFileSync(path.join(PLUGIN_SRC, name), path.join(dst, name));
  }
  console.log(`プラグインを配置: ${dst}（原本 ${PLUGIN_SRC}）`);
}

/** プラグインのダイアログで 1 回実行し、本体の確認ダイアログで承諾／拒否する。ダイアログの状態文を返す。 */
async function runOnce(
  page: Page,
  setup: (dlg: ReturnType<Page["getByTestId"]>) => Promise<void>,
  decision: "accept" | "reject",
  shot: string,
): Promise<string> {
  const overlay = page.getByTestId("preprocess-overlay");
  await setup(overlay);
  await overlay.getByTestId("preprocess-run").click();
  await page.getByTestId("plugin-save-confirm").waitFor({ state: "visible", timeout: 240_000 });
  await page.screenshot({ path: path.join(OUT_DIR, shot) });
  await page.getByTestId(decision === "accept" ? "plugin-save-confirm-button" : "plugin-save-cancel").click();
  const status = overlay.getByTestId("preprocess-status");
  await page.waitForFunction(
    () => /保存しました|キャンセル|失敗/.test(document.querySelector('[data-testid="preprocess-status"]')?.textContent ?? ""),
    undefined,
    { timeout: 60_000 },
  );
  return (await status.textContent()) ?? "";
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  installPlugin();
  const driver = new DesktopDriver();
  const recorder = createStepRecorder();
  await driver.start();
  try {
    const http = driver.ports.http;
    await resetDb(http);
    await importFixtureCategory(http, "ct-basic");
    const mainPage = driver.page;
    try {
      await mainPage.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 30_000 });
    } catch {
      await mainPage.reload({ waitUntil: "domcontentloaded" });
      await mainPage.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    }
    await openFirstSeriesInViewer(mainPage, recorder);
    const viewer = await driver.waitForNewPage(
      () => mainPage.getByTestId("viewer2d-toolbar-button").click(),
      (url) => url.includes("2dviewer"),
    );
    await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 15_000 });
    await viewer.waitForTimeout(2000);

    // 元シリーズ
    const studies = (await (await fetch(`http://localhost:${http}/api/studies`)).json()) as Array<{ studyInstanceUid: string }>;
    const studyUid = studies[0].studyInstanceUid;
    const before = await listSeries(http, studyUid);
    check(before.length === 1, "取り込み直後はシリーズが 1 本", before.length);
    const srcUid = before[0].seriesInstanceUid;
    const src = await readSeries(http, studyUid, srcUid);
    check(src.size === 50, "元シリーズは 50 枚（フィクスチャ）", src.size);
    let lo = Infinity;
    let hi = -Infinity;
    for (const s of src.values()) for (const v of s.hu) { if (v < lo) lo = v; if (v > hi) hi = v; }
    console.log(`  元の値域: [${lo}, ${hi}]`);

    // ── プラグインを開く ──
    await viewer.getByTestId("viewer2d-menu-plugins").click();
    await viewer.getByTestId(`plugin-item-${PLUGIN_ID}`).click();
    const overlay = viewer.getByTestId("preprocess-overlay");
    await overlay.waitFor({ state: "visible", timeout: 10_000 });
    await viewer.screenshot({ path: path.join(OUT_DIR, "1-dialog.png") });
    check((await overlay.getByTestId("pf-op").count()) === 1, "ダイアログが開く");

    // ── 2. 拒否: クリップを実行 → 確認ダイアログで拒否 → 何も増えない ──
    const rejected = await runOnce(viewer, async (d) => {
      await d.getByTestId("pf-op").selectOption("clip");
      await d.getByTestId("pf-lo").fill("-200");
      await d.getByTestId("pf-hi").fill("300");
    }, "reject", "2-confirm-clip.png");
    check(/キャンセル/.test(rejected), "拒否すると「キャンセル」と出る", rejected);
    const afterReject = await listSeries(http, studyUid);
    check(afterReject.length === 1, "拒否したので派生シリーズは増えない", afterReject.length);

    // ── 3a. 反転（承諾）──
    const invStatus = await runOnce(viewer, async (d) => {
      await d.getByTestId("pf-op").selectOption("invert");
      await d.getByTestId("pf-range-mode").selectOption("data");
    }, "accept", "3-confirm-invert.png");
    check(/保存しました/.test(invStatus), "反転を保存できた", invStatus);
    const s1 = await listSeries(http, studyUid);
    const invSeries = s1.find((s) => s.seriesInstanceUid !== srcUid && /Inverted/.test(s.seriesDescription ?? ""));
    check(!!invSeries, "反転の派生シリーズが保管庫に生えた", s1.map((s) => s.seriesDescription));
    if (invSeries) {
      check(invSeries.seriesDescription === `[Plugin] Inverted [${lo}, ${hi}]`, "説明に使った値域が入る", invSeries.seriesDescription);
      const inv = await readSeries(http, studyUid, invSeries.seriesInstanceUid);
      check(inv.size === src.size, "枚数が元と同じ", inv.size);
      let worst = 0;
      let missing = 0;
      for (const [ipp, d] of inv) {
        const o = src.get(ipp);
        if (!o) { missing++; continue; }
        for (let i = 0; i < d.hu.length; i++) worst = Math.max(worst, Math.abs(o.hu[i] + d.hu[i] - (lo + hi)));
      }
      check(missing === 0, "派生の全スライスが元の IPP に対応する（幾何の引き継ぎ）", missing);
      check(worst < 0.01, "全画素で v + v' = lo + hi（最大誤差）", worst);
    }

    // ── 3b. クリップ（承諾）──
    const clipStatus = await runOnce(viewer, async (d) => {
      await d.getByTestId("pf-op").selectOption("clip");
      await d.getByTestId("pf-lo").fill("-200");
      await d.getByTestId("pf-hi").fill("300");
    }, "accept", "4-confirm-clip2.png");
    check(/保存しました/.test(clipStatus), "クリップを保存できた", clipStatus);
    const s2 = await listSeries(http, studyUid);
    const clipSeries = s2.find((s) => /Clipped/.test(s.seriesDescription ?? ""));
    check(!!clipSeries, "クリップの派生シリーズが生えた");
    if (clipSeries) {
      const c = await readSeries(http, studyUid, clipSeries.seriesInstanceUid);
      let worst = 0;
      let cmin = Infinity, cmax = -Infinity;
      for (const d of c.values()) for (const v of d.hu) { if (v < cmin) cmin = v; if (v > cmax) cmax = v; }
      console.log(`  クリップの派生: 説明=${clipSeries.seriesDescription} 値域=[${cmin}, ${cmax}]`);
      for (const [ipp, d] of c) {
        const o = src.get(ipp)!;
        for (let i = 0; i < d.hu.length; i++) {
          const e = Math.abs(d.hu[i] - Math.min(300, Math.max(-200, o.hu[i])));
          if (e > worst) {
            worst = e;
            if (e > 1) console.log(`  [診断] 不一致 ipp=${ipp} i=${i} 元=${o.hu[i]} 派生=${d.hu[i]} 期待=${Math.min(300, Math.max(-200, o.hu[i]))}`);
          }
        }
      }
      check(worst < 0.01, "全画素で clamp(v, -200, 300)（最大誤差）", worst);
    }

    // ── 3c. ガウシアン 3D（承諾）──
    const sigma = 1.0;
    const gStatus = await runOnce(viewer, async (d) => {
      await d.getByTestId("pf-op").selectOption("smooth");
      await d.getByTestId("pf-kind").selectOption("gaussian");
      await d.getByTestId("pf-mm").fill(String(sigma));
      await d.getByTestId("pf-dim").selectOption("3d");
    }, "accept", "5-confirm-gauss.png");
    check(/保存しました/.test(gStatus), "ガウシアンを保存できた", gStatus);
    const s3 = await listSeries(http, studyUid);
    const gSeries = s3.find((s) => /Gaussian/.test(s.seriesDescription ?? ""));
    check(!!gSeries, "ガウシアンの派生シリーズが生えた");
    if (gSeries) {
      const g = await readSeries(http, studyUid, gSeries.seriesInstanceUid);
      // 元を z 順（IPP の z 昇順）に並べて、素朴な 3D の直接計算を無作為の内部画素で行う。
      const ordered = [...src.values()].sort((a, b) => Number(a.ipp.split("\\")[2]) - Number(b.ipp.split("\\")[2]));
      const sx = ordered[0].spacing[0], sy = ordered[0].spacing[1];
      const sz = Math.abs(Number(ordered[1].ipp.split("\\")[2]) - Number(ordered[0].ipp.split("\\")[2]));
      const hx = Math.ceil((3 * sigma) / sx), hy = Math.ceil((3 * sigma) / sy), hz = Math.ceil((3 * sigma) / sz);
      const wf = (d: number, s: number) => Math.exp(-((d * s) ** 2) / (2 * sigma * sigma));
      const { rows, cols } = ordered[0];
      let seed = 12345;
      const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
      let worst = 0;
      const n = 1500;
      for (let t = 0; t < n; t++) {
        const z = hz + Math.floor(rnd() * (ordered.length - 2 * hz));
        const y = hy + Math.floor(rnd() * (rows - 2 * hy));
        const x = hx + Math.floor(rnd() * (cols - 2 * hx));
        let num = 0, den = 0;
        for (let dz = -hz; dz <= hz; dz++) for (let dy = -hy; dy <= hy; dy++) for (let dx = -hx; dx <= hx; dx++) {
          const w = wf(dz, sz) * wf(dy, sy) * wf(dx, sx);
          num += w * ordered[z + dz].hu[(y + dy) * cols + (x + dx)];
          den += w;
        }
        const got = g.get(ordered[z].ipp)!.hu[y * cols + x];
        worst = Math.max(worst, Math.abs(got - num / den));
      }
      console.log(`  ガウシアン: σ=${sigma} mm、間隔 (${sx}, ${sy}, ${sz.toFixed(3)}) mm、窓半幅 (${hx}, ${hy}, ${hz})、${n} 画素`);
      // 保存は整数に量子化されるので ±0.5 HU を許す。
      check(worst <= 0.51, "ガウシアンが直接計算と一致する（最大誤差 HU、量子化 ±0.5 を許容）", worst);
    }

    // ── 4. 元シリーズは不変 ──
    const srcAfter = await readSeries(http, studyUid, srcUid);
    let changed = 0;
    for (const [ipp, o] of src) {
      const a = srcAfter.get(ipp);
      if (!a) { changed++; continue; }
      for (let i = 0; i < o.hu.length; i++) if (a.hu[i] !== o.hu[i]) { changed++; break; }
    }
    check(changed === 0, "元シリーズの画素は不変", changed);
    await viewer.screenshot({ path: path.join(OUT_DIR, "6-after.png") });
  } finally {
    await driver.stop();
  }
}

try {
  await main();
} catch (e) {
  console.error(e);
  process.exitCode = 1;
}
process.exitCode = process.exitCode || (summary() > 0 ? 1 : 0);
