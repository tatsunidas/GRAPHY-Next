/*
 * Radiomics 特徴量（ROI）の画面の「スケール比較」表・横長の CSV・プリセット「36 特徴」の実機検証スパイク。
 *
 * 実行:  cd automator && npx tsx src/spike/roiScaleTableCheck.ts   （専用ポート 19870〜19872）
 *
 *   1. プリセット「36 特徴」で半径 0, 2, 3, 4, 5, 6 と 3 族が入り、計算するとスケール比較のタブが出る。
 *   2. 表の 36 値＝API のスケールごとの結果の同じ列＝スケールのタブの表＝縦長の CSV の同じセル。6 列は互いに異なる。
 *   3. 横長の CSV を pandas で読むと 36 列が数値型。2 症例を行方向につなぐと列が揃う。
 *   4. 組の割り当てを変えると見出しだけが変わり値は変わらない。割り当てに無い r は「組なし」。重複は書き出せない（負例）。
 *
 * 前提: backend jar（今のビルド）・python3 と pydicom と pandas。
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import type { Page } from "@playwright/test";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { openFirstSeriesInViewer } from "../checklist/items/shared/helpers.js";
import { createStepRecorder } from "../checklist/types.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "scale-table-check");

const failures: string[] = [];
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

interface Synth {
  studyInstanceUid: string;
  seriesInstanceUid: string;
  frameOfReferenceUID: string;
  rows: number;
  columns: number;
  pixelSpacing: number[];
  sliceThickness: number;
  frames: { sopInstanceUid: string; imagePositionPatient: number[] }[];
}

interface Row { column: string; family: string; feature: string; ibsi: string | null; value: number | null; notes: string[] }
interface Result {
  fromCache: boolean;
  computedAt: string;
  rows: Row[];
  provenance: { graphyNextVersion: string; radiomicsjVersion: string; extractedAt: string; settingsSha256: string };
  settingsProperties: string;
  roiSize: { initialVoxels: number; intensityVoxels: number; morphVoxels: number; volumeMm3: number;
    smallRoiWarnVoxels: number | null; smallRoi: boolean | null };
}

/** 箱のセグメント（行・列・スライスの半開区間）。 */
interface Box { r0: number; r1: number; c0: number; c1: number; z0: number; z1: number }
const SEG1: Box = { r0: 12, r1: 36, c0: 10, c1: 34, z0: 3, z1: 13 };
const SEG2: Box = { r0: 28, r1: 44, c0: 34, c1: 50, z0: 4, z1: 11 };

function makeSynth(): Synth & { dir: string } {
  const dir = path.join(OUT_DIR, "synth");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const seed = String(Date.now() % 2_000_000_000);
  const r = spawnSync("python3", ["-I", path.join(import.meta.dirname, "roiFeatureSynth.py"), dir, seed, "-200"], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`合成データを作れません: ${r.stderr}`);
  return { ...(JSON.parse(r.stdout) as Synth), dir };
}

function boxFrames(s: Synth, b: Box) {
  return s.frames.map((f, z) => {
    if (z < b.z0 || z >= b.z1) return { ...f, mask: "" };
    const m = Buffer.alloc(s.rows * s.columns);
    for (let r = b.r0; r < b.r1; r++) for (let c = b.c0; c < b.c1; c++) m[r * s.columns + c] = 1;
    return { ...f, mask: m.toString("base64") };
  });
}

async function api<T>(base: string, p: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${base}${p}`, init);
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${p} → HTTP ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

/** API を直接呼んで結果を待つ（画面を通さない比較の基準）。 */
async function apiFeatures(base: string, body: Record<string, unknown>): Promise<Result> {
  const s = await api<{ jobId: string }>(base, "/api/radiomics/features/jobs", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  for (let i = 0; i < 600; i++) {
    const st = await api<{ state: string; result?: Result; error?: string }>(base, `/api/radiomics/features/jobs/${s.jobId}`);
    if (st.state === "DONE" && st.result) return st.result;
    if (st.state === "FAILED" || st.state === "CANCELLED") throw new Error(`job ${st.state}: ${st.error}`);
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("job timeout");
}


let doneCount = 0;

async function runAndWait(page: Page, click: () => Promise<void>, timeoutMs = 300_000): Promise<void> {
  const before = doneCount;
  await click();
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await page.getByTestId("roifeat-error").isVisible().catch(() => false)) {
      throw new Error(`画面のエラー: ${await page.getByTestId("roifeat-error").innerText()}`);
    }
    if (doneCount > before && (await page.getByTestId("roifeat-summary").isVisible().catch(() => false))) {
      await page.waitForTimeout(400);
      return;
    }
    await page.waitForTimeout(200);
  }
  throw new Error("結果が出ない");
}


const STATS: [string, string][] = [
  ["Mean", "IntensityBasedStatistical_Mean"], ["SD", "IntensityBasedStatistical_StandardDeviation"],
  ["Entropy", "IntensityHistogram_Entropy"], ["MPP", "AuxiliaryStatistics_MeanOfPositiveIntensities"],
  ["Skewness", "IntensityBasedStatistical_Skewness"], ["Kurtosis", "IntensityBasedStatistical_Kurtosis"],
];
const RADII = [0, 2, 3, 4, 5, 6];
const num = (txt: string) => Number(txt.trim().replace(/,/g, ""));
const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(5e-5, Math.abs(b) * 5e-4);

function parseCsv(text: string): { header: string[]; rows: string[][] } {
  const lines = text.trim().split(/\r?\n/).map((l) => l.split(","));
  return { header: lines[0], rows: lines.slice(1) };
}

interface ScaleResult { scaleMm: number; sigma3dMm: number | null; result: Result }
interface Full extends Result { scales: ScaleResult[] }

const colOf = (e: ScaleResult, base: string) => {
  if (e.sigma3dMm == null) return base;
  const hit = e.result.rows.find((r) => /^log_sigma[^_]+_/.test(r.column) && r.column.endsWith(`_${base}`));
  return hit?.column ?? `?${base}`;
};

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const synth = makeSynth();
  const d = new DesktopDriver({ http: 19870, scp: 19871, vite: 19872 });
  await d.start();
  const base = `http://127.0.0.1:${d.ports.http}`;
  try {
    await resetDb(d.ports.http);
    await importPaths(d.ports.http, [synth.dir]);
    const seg = await api<{ seriesInstanceUid: string }>(base, "/api/dicom/seg", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        studyInstanceUid: synth.studyInstanceUid, seriesInstanceUid: synth.seriesInstanceUid,
        rows: synth.rows, columns: synth.columns, imageOrientationPatient: [1, 0, 0, 0, 1, 0],
        pixelSpacing: synth.pixelSpacing, sliceThickness: synth.sliceThickness,
        frameOfReferenceUID: synth.frameOfReferenceUID, seriesDescription: "synthetic two-box SEG",
        segments: [
          { number: 1, label: "BigBox", color: [255, 0, 0], description: null, frames: boxFrames(synth, SEG1) },
          { number: 2, label: "SmallBox", color: [0, 255, 0], description: null, frames: boxFrames(synth, SEG2) },
        ],
        producer: null,
      }),
    });
    check(!!seg.seriesInstanceUid, "SEG ができる");

    const mainPage = d.page;
    await mainPage.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    await mainPage.waitForTimeout(2000);
    const later = mainPage.getByRole("button", { name: /^(後で|Later)$/ });
    if (await later.isVisible().catch(() => false)) {
      await later.click();
      await mainPage.waitForTimeout(500);
    }
    await mainPage.evaluate("localStorage.setItem('graphy.locale', 'ja')");
    await openFirstSeriesInViewer(mainPage, createStepRecorder());
    const viewer = await d.waitForNewPage(
      () => mainPage.getByTestId("viewer2d-toolbar-button").click({ timeout: 170_000 }),
      (url) => url.includes("2dviewer"),
      180_000,
    );
    await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 20_000 });
    await viewer.waitForTimeout(2000);
    await viewer.getByTestId("viewer2d-menu-analysis").click();
    const page = await d.waitForNewPage(
      () => viewer.getByTestId("menu-roi-features").click(),
      (url) => url.includes("#radiomics-features"),
    );
    page.on("console", (m) => {
      if (m.type() === "error") console.log(`  [renderer error] ${m.text()}`);
    });
    page.on("response", (res) => {
      if (res.request().method() !== "GET" || !res.url().includes("/api/radiomics/features/jobs/")) return;
      void res.json().then((j: { state?: string }) => {
        if (j.state === "DONE") doneCount++;
      }).catch(() => {});
    });
    const posted: Record<string, unknown>[] = [];
    page.on("request", (req) => {
      if (req.method() === "POST" && req.url().includes("/api/radiomics/features/jobs")) {
        posted.push(JSON.parse(req.postData() ?? "{}") as Record<string, unknown>);
      }
    });
    await page.evaluate(`
      (function () {
        window.__roiDownloads = [];
        var orig = HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click = function () {
          var a = this;
          if (a.download && a.href.indexOf("blob:") === 0) {
            var name = a.download;
            fetch(a.href).then(function (r) { return r.text(); }).then(function (t) {
              window.__roiDownloads.push({ name: name, text: t });
            });
            return;
          }
          return orig.call(this);
        };
      })()
    `);
    const downloads = async (n: number) => {
      for (let i = 0; i < 100 && ((await page.evaluate("window.__roiDownloads.length")) as number) < n; i++) await page.waitForTimeout(100);
      return Object.fromEntries(((await page.evaluate("window.__roiDownloads")) as { name: string; text: string }[]).map((x) => [x.name, x.text]));
    };
    await page.getByTestId("roifeat-mask").waitFor({ state: "visible", timeout: 20_000 });
    await page.waitForTimeout(1500);
    await page.getByTestId("roifeat-mask").selectOption(seg.seriesInstanceUid);
    await page.waitForTimeout(1500);

    console.log("\n[1] プリセット「36 特徴」で計算（症例 A＝BigBox）");
    await page.getByTestId("roifeat-caselabel").fill("case-A");
    await page.getByTestId("roifeat-preset").selectOption("scale36");
    check((await page.getByTestId("roifeat-scales").inputValue()) === "0, 2, 3, 4, 5, 6", "半径の欄が 0, 2, 3, 4, 5, 6");
    await page.getByTestId("roifeat-resampling").selectOption("iso"); // LoG は等方の格子が前提（1 mm）
    await runAndWait(page, () => page.getByTestId("roifeat-run").click());
    const sent = posted[0] as { scales?: number[]; settings?: Record<string, string> };
    const on = Object.entries(sent.settings ?? {}).filter(([k, v]) => k.startsWith("BOOL_enable") && v === "1").map(([k]) => k).sort();
    check(JSON.stringify(sent.scales) === JSON.stringify(RADII) && on.length === 3 && sent.settings?.BOOL_enableAuxiliaryStatistics === "1",
      "要求に半径 6 個と族 3 つだけが載る", { scales: sent.scales, on });
    await page.getByTestId("roifeat-scale-tab-compare").waitFor({ state: "visible", timeout: 10_000 });
    check(true, "スケール比較のタブが出る");

    console.log("\n[2] 表の 36 値");
    const ref = (await apiFeatures(base, posted[0])) as Full;
    check(ref.scales.length === 6, "API の結果にスケールが 6 つ", ref.scales.length);
    await page.getByTestId("roifeat-scale-tab-compare").click();
    await page.getByTestId("roifeat-compare-table").waitFor({ state: "visible" });
    const cell = async (label: string, r: number) => num(await page.getByTestId(`roifeat-compare-${label}-${r}`).innerText());
    const shown = new Map<string, number>();
    let worst = 0;
    for (const e of ref.scales) {
      for (const [label, baseCol] of STATS) {
        const want = e.result.rows.find((r) => r.column === colOf(e, baseCol))?.value;
        const got = await cell(label, e.scaleMm);
        shown.set(`${label}@${e.scaleMm}`, got);
        if (want == null || !near(got, want)) worst++;
      }
    }
    check(worst === 0, `36 個の値が API のスケールごとの結果の同じ列と一致（不一致 ${worst}）`);
    for (const [label] of STATS) {
      const vs = new Set(RADII.map((r) => shown.get(`${label}@${r}`)));
      check(vs.size > 1, `${label} の 6 つの値は互いに同じではない（同じ列を並べていない）`, [...vs]);
    }
    const heads = await page.locator('[data-testid^="roifeat-compare-group-"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-group")));
    check(heads.join() === "none,fine,medium,medium,medium,coarse", "見出しの組が none, fine, medium×3, coarse", heads);
    await page.setViewportSize({ width: 1200, height: 900 });
    await page.waitForTimeout(500);
    await page.getByTestId("roifeat-compare").screenshot({ path: path.join(OUT_DIR, "01-compare.png") });

    console.log("\n[3] スケールのタブの表（r 3）と縦長 CSV の同じセル");
    const i3 = ref.scales.findIndex((e) => e.scaleMm === 3);
    await page.getByTestId(`roifeat-scale-tab-${i3}`).click();
    const e3 = ref.scales[i3];
    let tabBad = 0;
    for (const [label, baseCol] of STATS) {
      const col = colOf(e3, baseCol);
      const txt = await page.getByTestId("roifeat-table").locator(`td[title="${col}"]`).first().locator("xpath=following-sibling::td[2]").innerText();
      if (!near(num(txt), shown.get(`${label}@3`)!)) tabBad++;
    }
    check(tabBad === 0, `r 3 のタブの表の 6 値が比較表と一致（不一致 ${tabBad}）`);
    await page.getByTestId("roifeat-csv").click();
    const by1 = await downloads(2);
    const longCsv = parseCsv(by1["case-A-seg0.csv"] ?? "");
    check(longCsv.rows.length === 6, "縦長 CSV はスケールごとに 1 行", longCsv.rows.length);

    console.log("\n[4] 横長の CSV");
    await page.evaluate("window.__roiDownloads = []");
    await page.getByTestId("roifeat-scale-tab-compare").click();
    await page.getByTestId("roifeat-compare-csv").click();
    const by2 = await downloads(2);
    const wide = parseCsv(by2["case-A-seg0_wide.csv"] ?? "");
    check(wide.rows.length === 1, "横長の CSV は 1 行");
    let csvBad = 0;
    for (const e of ref.scales) {
      const li = longCsv.rows.findIndex((r) => r[longCsv.header.indexOf("Filter_ScaleMm")] === String(e.scaleMm));
      for (const [, baseCol] of STATS) {
        const w = wide.rows[0][wide.header.indexOf(`Scale${e.scaleMm}mm_${baseCol}`)];
        const l = longCsv.rows[li][longCsv.header.indexOf(colOf(e, baseCol))];
        if (w === undefined || w !== l) csvBad++;
      }
    }
    check(csvBad === 0, `横長の 36 セルが縦長 CSV の同じセルと文字列まで一致（不一致 ${csvBad}）`);
    const defs = parseCsv(by2["case-A-seg0_wide_definitions.csv"] ?? "");
    check(defs.header.slice(-3).join() === "scale_mm,sigma_mm,group" && defs.rows.length === wide.header.length,
      "定義表に scale_mm・sigma_mm・group の欄があり、列と 1 対 1");
    const dg = (c: string) => defs.rows.find((r) => r[0] === c)?.slice(-3).join();
    check(dg("Scale2mm_IntensityBasedStatistical_Mean")?.endsWith(",fine") === true
      && dg("Scale4mm_IntensityBasedStatistical_Mean")?.endsWith(",medium") === true, "定義表の group が fine・medium", dg("Scale2mm_IntensityBasedStatistical_Mean"));
    fs.writeFileSync(path.join(OUT_DIR, "case-A_wide.csv"), by2["case-A-seg0_wide.csv"]);
    const featCols = (h: string[]) => h.filter((c) => /^Scale[0-9.]+mm_(Intensity|Auxiliary)/.test(c));
    check(featCols(wide.header).length === 36, "既定の横長の CSV は特徴の列がちょうど 36", featCols(wide.header).length);
    await page.getByTestId("roifeat-compare-others").check();
    await page.evaluate("window.__roiDownloads = []");
    await page.getByTestId("roifeat-compare-csv").click();
    const byAll = parseCsv((await downloads(2))["case-A-seg0_wide.csv"] ?? "");
    const all36 = new Set(featCols(byAll.header));
    check(all36.size > 36 && featCols(wide.header).every((c) => all36.has(c)), `「ほかの特徴も」を付けると 36 列を含んだまま増える（${all36.size} 列）`);
    await page.getByTestId("roifeat-compare-others").uncheck();

    console.log("\n[5] 組の割り当てを変える・負例");
    await page.getByTestId("roifeat-compare-input-fine").fill("");
    await page.getByTestId("roifeat-compare-input-medium").fill("3, 4");
    await page.getByTestId("roifeat-compare-input-coarse").fill("5, 6");
    const heads2 = await page.locator('[data-testid^="roifeat-compare-group-"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-group")));
    check(heads2.join() === "none,ungrouped,medium,medium,coarse,coarse", "割り当てを変えると見出しが変わり、r 2 は組なし", heads2);
    let after = 0;
    for (const [label] of STATS) for (const r of RADII) if ((await cell(label, r)) !== shown.get(`${label}@${r}`)) after++;
    check(after === 0, "組を変えても値は 1 つも変わらない");
    await page.getByTestId("roifeat-compare").screenshot({ path: path.join(OUT_DIR, "02-groups.png") });
    await page.getByTestId("roifeat-compare-input-fine").fill("2, 3");
    check(await page.getByTestId("roifeat-compare-problem").isVisible(), "r 3 が 2 つの組に入ると警告が出る（負例）");
    check(await page.getByTestId("roifeat-compare-csv").isDisabled(), "そのときは書き出せない（負例）");
    await page.getByTestId("roifeat-compare-reset").click();
    check(!(await page.getByTestId("roifeat-compare-problem").isVisible().catch(() => false)), "既定に戻すと警告が消える");

    console.log("\n[6] 症例 B（SmallBox）と 2 症例の結合");
    await page.getByTestId("roifeat-mask-channel").selectOption("1");
    await page.getByTestId("roifeat-caselabel").fill("case-B");
    await runAndWait(page, () => page.getByTestId("roifeat-run").click());
    await page.getByTestId("roifeat-scale-tab-compare").click();
    await page.evaluate("window.__roiDownloads = []");
    await page.getByTestId("roifeat-compare-csv").click();
    const by3 = await downloads(2);
    const wideB = parseCsv(by3["case-B-seg1_wide.csv"] ?? "");
    check(wideB.header.join() === wide.header.join(), "症例 B の列名と並びが症例 A と同じ");
    fs.writeFileSync(path.join(OUT_DIR, "case-B_wide.csv"), by3["case-B-seg1_wide.csv"]);
    const idx = wideB.header.indexOf("Roi_InitialVoxels");
    check(wideB.rows[0][idx] !== wide.rows[0][idx], "症例 B の ROI の大きさは A と違う（別の ROI を計算している）");

    console.log("\n[7] pandas で読む");
    const py = spawnSync("python3", ["-I", "-c", `
import sys, pandas as pd
a = pd.read_csv(sys.argv[1]); b = pd.read_csv(sys.argv[2])
f = [c for c in a.columns if c.startswith("Scale") and ("Intensity" in c or "Auxiliary" in c)]
num = [c for c in f if pd.api.types.is_numeric_dtype(a[c])]
c = pd.concat([a, b], ignore_index=True)
print(len(f), len(num), c.shape[0], c.shape[1] == a.shape[1], int(c[f].isna().sum().sum()), list(a.columns) == list(b.columns))
`, path.join(OUT_DIR, "case-A_wide.csv"), path.join(OUT_DIR, "case-B_wide.csv")], { encoding: "utf8" });
    const [nf, nn, nrows, same, nan, order] = py.stdout.trim().split(" ");
    check(py.status === 0 && nf === "36" && nn === "36", "pandas で 36 列がすべて数値型", { out: py.stdout, err: py.stderr });
    check(nrows === "2" && same === "True" && order === "True" && nan === "0", "2 症例を pd.concat でつなぐと 2 行・列が揃い、欠損 0", py.stdout);

    console.log(`\n合格 ${passed} ／ 失敗 ${failures.length}`);
  } finally {
    await d.stop();
  }
  if (failures.length > 0) {
    console.log(`失敗: ${failures.join(" / ")}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
