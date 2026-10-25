/*
 * Radiomics 特徴量（ROI）の画面の「6 統計・副次量」まとめ欄・プリセット・範囲で除く欄の実機検証スパイク。
 *
 * 実行:  cd automator && npx tsx src/spike/sixStatisticsCheck.ts   （専用ポート 19860〜19862）
 *
 *   1. プリセット「6 統計」で族が 3 つだけオンになり、計算すると「6 統計」「副次量」の欄が出る。
 *   2. 欄の値は API の結果（同じ要求）の同じ列と一致し、Variance は SD² と一致する。
 *   3. 範囲: 下限だけだと警告が出て「計算」を押せない（負例）。両方入れると要求に DOUBLE_rangeMin/Max が載り、
 *      強度マスクのボクセル数が減る（API で確かめ、画面の ROI の大きさの表示と一致）。
 *   4. 補助統計をオフにした通常の計算では、まとめ欄の MPP 等の行が出ず、既存の列は変わらない。
 *
 * 前提: backend jar（今のビルド）・python3 と pydicom。
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

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "six-statistics-check");

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
const SEG1: Box = { r0: 12, r1: 36, c0: 10, c1: 34, z0: 3, z1: 13 }; // 24×24×10 = 5760
const SEG2: Box = { r0: 30, r1: 40, c0: 36, c1: 46, z0: 5, z1: 9 }; // 10×10×4 = 400
const voxels = (b: Box) => (b.r1 - b.r0) * (b.c1 - b.c0) * (b.z1 - b.z0);
/** 合成 CT はスライス間隔 = スライス厚。 */
const volumeOf = (s: Synth, b: Box) => voxels(b) * s.pixelSpacing[0] * s.pixelSpacing[1] * s.sliceThickness;
const VOXEL_COLUMN = "Diagnostics_DiagnosticsInitialROIIntMaskVoxelCount";
const CASE_LABEL = "case-012";

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

const SIX = ["Mean", "SD", "Entropy", "MPP", "Skewness", "Kurtosis"];
const SECONDARY = ["Variance", "Uniformity", "PPP", "nSD", "UPP", "1/(kurtosis+3)"];
const COLUMN: Record<string, string> = {
  Mean: "IntensityBasedStatistical_Mean", SD: "IntensityBasedStatistical_StandardDeviation",
  Entropy: "IntensityHistogram_Entropy", MPP: "AuxiliaryStatistics_MeanOfPositiveIntensities",
  Skewness: "IntensityBasedStatistical_Skewness", Kurtosis: "IntensityBasedStatistical_Kurtosis",
  Variance: "IntensityBasedStatistical_Variance", Uniformity: "IntensityHistogram_Uniformity",
  PPP: "AuxiliaryStatistics_ProportionOfPositiveIntensities", nSD: "AuxiliaryStatistics_NormalisedStandardDeviation",
  UPP: "AuxiliaryStatistics_UniformityOfPositiveIntensities", "1/(kurtosis+3)": "AuxiliaryStatistics_ReciprocalKurtosis",
};

const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(5e-5, Math.abs(b) * 5e-4);

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const synth = makeSynth();
  const d = new DesktopDriver({ http: 19860, scp: 19861, vite: 19862 });
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
      () => mainPage.getByTestId("viewer2d-toolbar-button").click(),
      (url) => url.includes("2dviewer"),
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
    await page.getByTestId("roifeat-mask").waitFor({ state: "visible", timeout: 20_000 });
    await page.waitForTimeout(1500);
    await page.getByTestId("roifeat-mask").selectOption(seg.seriesInstanceUid);
    await page.waitForTimeout(1500);

    console.log("\n[1] プリセット「6 統計」で計算");
    check((await page.getByTestId("roifeat-six").count()) === 0, "計算の前は 6 統計の欄が無い");
    await page.getByTestId("roifeat-preset").selectOption("six");
    await runAndWait(page, () => page.getByTestId("roifeat-run").click());
    await page.getByTestId("roifeat-six").waitFor({ state: "visible", timeout: 10_000 });
    const sent = (posted[0].settings ?? {}) as Record<string, string>;
    const on = Object.entries(sent).filter(([k, v]) => k.startsWith("BOOL_enable") && v === "1").map(([k]) => k).sort();
    check(on.length === 3 && sent.BOOL_enableAuxiliaryStatistics === "1" && sent.BOOL_enableGLCM === "0",
      "プリセットで族が 3 つだけオン（要求に載る）", on);
    check(sent.DOUBLE_rangeMin === undefined, "範囲を入れないと範囲は送らない");

    console.log("\n[2] 欄の値は API の同じ列と一致");
    const ref = await apiFeatures(base, posted[0]);
    const byCol = new Map(ref.rows.map((r) => [r.column, r.value]));
    const shown: Record<string, number> = {};
    for (const [panel, labels] of [["roifeat-six", SIX], ["roifeat-secondary", SECONDARY]] as const) {
      for (const label of labels) {
        const txt = (await page.getByTestId(`${panel}-${label}`).innerText()).trim();
        const v = Number(txt.replace(/,/g, ""));
        shown[label] = v;
        const want = byCol.get(COLUMN[label]);
        check(want != null && near(v, want), `${label} = ${txt}（API ${want}）`);
      }
    }
    check(near(shown.Variance, shown.SD * shown.SD), "Variance = SD²（画面の値）");
    check(shown.PPP > 0 && shown.PPP < 1 && shown.MPP > 0 && shown.UPP > 0 && shown.UPP <= 1, "PPP は 0〜1 の間、MPP・UPP は正の値で定義される", shown);
    await page.getByTestId("roifeat-six").scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(OUT_DIR, "01-six.png") });

    console.log("\n[3] 範囲で除く");
    const baseline = ref.roiSize.intensityVoxels;
    await page.getByTestId("roifeat-range-min").fill(String(shown.Mean));
    check(await page.getByTestId("roifeat-range-problem").isVisible(), "下限だけだと警告が出る");
    check(await page.getByTestId("roifeat-run").isDisabled(), "下限だけだと「計算」は押せない（負例）");
    await page.getByTestId("roifeat-range-max").fill("1000000000");
    check(!(await page.getByTestId("roifeat-range-problem").isVisible().catch(() => false)), "両方入れると警告は消える");
    await runAndWait(page, () => page.getByTestId("roifeat-run").click());
    const sent2 = (posted[posted.length - 1].settings ?? {}) as Record<string, string>;
    check(Number(sent2.DOUBLE_rangeMin) === shown.Mean && sent2.DOUBLE_rangeMax === "1000000000", "要求に範囲が載る", sent2);
    const ref2 = await apiFeatures(base, posted[posted.length - 1]);
    check(ref2.roiSize.intensityVoxels < baseline && ref2.roiSize.intensityVoxels > 0,
      `強度マスクのボクセル数が減る（${baseline} → ${ref2.roiSize.intensityVoxels}）`);
    const sizeText = await page.getByTestId("roifeat-roisize").innerText();
    check(sizeText.includes(ref2.roiSize.intensityVoxels.toLocaleString("en-US")), "画面の ROI の大きさが API と一致", sizeText);

    console.log("\n[4] 補助統計をオフにすると MPP の行は出ない");
    await page.getByTestId("roifeat-range-min").fill("");
    await page.getByTestId("roifeat-range-max").fill("");
    await page.locator("label", { hasText: /補助統計/ }).locator("input").uncheck();
    await runAndWait(page, () => page.getByTestId("roifeat-run").click());
    check((await page.getByTestId("roifeat-six-MPP").count()) === 0, "MPP の行が出ない");
    check((await page.getByTestId("roifeat-six-Mean").count()) === 1, "一次統計の行は出る");
    await page.screenshot({ path: path.join(OUT_DIR, "02-off.png") });

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
