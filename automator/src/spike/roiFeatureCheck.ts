/*
 * Radiomics 特徴量（ROI）の画面（2D Viewer > 解析 > Radiomics 特徴量（ROI）…）の実機検証スパイク
 * （fw/texture-radiomics-design.md §13）。
 *
 * 実行:  cd automator && npx tsx src/spike/roiFeatureCheck.ts
 *
 *   1. 合成 CT を取り込み、アプリの SEG 書き出し API で 2 セグメントの SEG を作る（利用者と同じ経路のマスク）。
 *   2. メニューから画面を開き、SEG とセグメントを選んで「計算」→ 表（150 行以上）・注記・離散化・IBSI 外。
 *   3. 「CSV に書き出す」の 2 本を横取りし、データ表が同じ設定の API 直呼び（キャッシュを使わない）と全列で差 0。
 *   4. もう一度「計算」→ キャッシュの表示（計算日時）、値は 1 回目と差 0。「計算し直す」→ 新しく計算。
 *   5. 負例: ビン数 16 の CSV は、ビン数 32 の値と GLCM が一致しない（形態は一致する）。
 *   6. 2 つ目のセグメントでボクセル数が理論値に変わる（セグメントの選択が効いている）。
 *   7. 取り消した計算の結果が、次の同じ要求でキャッシュから返る。
 *   3b. 記録: 症例ラベル・版・抽出日時・設定の SHA-256 の列、設定ファイルの書き出しとアプリを通した往復、患者情報が無いこと。
 *   8. ROI の大きさ（ボクセル数・体積が理論値）と小さい ROI の警告（環境設定で基準値を入れる。境界の正例と負例、未設定は空）。
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

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "roi-feature-check");

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
  const r = spawnSync("python3", ["-I", path.join(import.meta.dirname, "roiFeatureSynth.py"), dir, seed], { encoding: "utf8" });
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

/** RFC 4180 の 1 行。 */
function splitRow(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { out.push(cur); cur = ""; } else cur += c;
  }
  out.push(cur);
  return out;
}

/** 先頭の記録の列（症例ラベル・Provenance_* の 5 列と、ROI の大きさ・警告の 6 列）。 */
const NREC = 11;

/** データ表の特徴量の列（先頭の記録の列を除く）。 */
function readData(csv: string): { names: string[]; values: number[] } {
  const [h, v] = csv.split("\r\n");
  return { names: splitRow(h).slice(NREC), values: splitRow(v).slice(NREC).map(Number) };
}

function readRecord(csv: string): Record<string, string> {
  const [h, v] = csv.split("\r\n").map(splitRow);
  return Object.fromEntries(h.slice(0, NREC).map((n, i) => [n, v[i]]));
}

const sha256 = (text: string) => crypto.createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");

/** CSV の値と結果の行が全列で一致する数（Object.is: NaN 同士は一致、-0 と 0 は区別）。 */
function diffCount(csv: string, rows: Row[]): { mismatched: string[]; sameOrder: boolean } {
  const { names, values } = readData(csv);
  const sameOrder = names.length === rows.length && names.every((n, i) => n === rows[i].column);
  const mismatched = rows.filter((r, i) => !Object.is(values[i], r.value ?? NaN)).map((r) => r.column);
  return { mismatched, sameOrder };
}

interface Download { name: string; text: string }

async function takeDownloads(page: Page, n: number): Promise<Download[]> {
  for (let i = 0; i < 50; i++) {
    const got = (await page.evaluate("window.__roiDownloads.length")) as number;
    if (got >= n) break;
    await page.waitForTimeout(200);
  }
  return (await page.evaluate("window.__roiDownloads.splice(0)")) as Download[];
}

/** 画面が受け取った DONE の数（ジョブの問い合わせの応答から数える）。 */
let doneCount = 0;

/** 「計算」などを押してから、次の DONE が画面に載るまで待ち、表の上の表示を返す。 */
async function runAndWait(page: Page, click: () => Promise<void>, timeoutMs = 300_000): Promise<string> {
  const before = doneCount;
  await click();
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await page.getByTestId("roifeat-error").isVisible().catch(() => false)) {
      throw new Error(`画面のエラー: ${await page.getByTestId("roifeat-error").innerText()}`);
    }
    if (doneCount > before && (await page.getByTestId("roifeat-summary").isVisible().catch(() => false))) {
      await page.waitForTimeout(300);
      return page.getByTestId("roifeat-summary").innerText();
    }
    await page.waitForTimeout(200);
  }
  throw new Error("結果が出ない");
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const synth = makeSynth();
  const d = new DesktopDriver();
  await d.start();
  const base = `http://127.0.0.1:${d.ports.http}`;
  try {
    console.log(`  reset: ${JSON.stringify(await resetDb(d.ports.http))}`);
    console.log(`  import: ${JSON.stringify(await importPaths(d.ports.http, [synth.dir]))}`);

    console.log("\n[1] SEG をアプリの書き出し API で作る（2 セグメント）");
    const seg = await api<{ seriesInstanceUid: string }>(base, "/api/dicom/seg", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        studyInstanceUid: synth.studyInstanceUid,
        seriesInstanceUid: synth.seriesInstanceUid,
        rows: synth.rows,
        columns: synth.columns,
        imageOrientationPatient: [1, 0, 0, 0, 1, 0],
        pixelSpacing: synth.pixelSpacing,
        sliceThickness: synth.sliceThickness,
        frameOfReferenceUID: synth.frameOfReferenceUID,
        seriesDescription: "synthetic two-box SEG",
        segments: [
          { number: 1, label: "BigBox", color: [255, 0, 0], description: null, frames: boxFrames(synth, SEG1) },
          { number: 2, label: "SmallBox", color: [0, 255, 0], description: null, frames: boxFrames(synth, SEG2) },
        ],
        producer: null,
      }),
    });
    check(!!seg.seriesInstanceUid, "SEG ができる", seg);

    const mainPage = d.page;
    await mainPage.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    await mainPage.waitForTimeout(2000);
    const later = mainPage.getByRole("button", { name: /^(後で|Later)$/ });
    if (await later.isVisible().catch(() => false)) {
      await later.click();
      await mainPage.waitForTimeout(500);
    }
    // 新しく開くウィンドウ（ビューア・特徴量の画面）は日本語で表示する（主な利用者の言語で見て判定する）。
    await mainPage.evaluate("localStorage.setItem('graphy.locale', 'ja')");
    await openFirstSeriesInViewer(mainPage, createStepRecorder());
    const viewer = await d.waitForNewPage(
      () => mainPage.getByTestId("viewer2d-toolbar-button").click(),
      (url) => url.includes("2dviewer"),
    );
    await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 20_000 });
    await viewer.waitForTimeout(2000);

    console.log("\n[2] メニューから開いて計算");
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
    await page.getByTestId("roifeat-mask").waitFor({ state: "visible", timeout: 20_000 });
    await page.waitForTimeout(1500);
    await page.getByTestId("roifeat-mask").selectOption(seg.seriesInstanceUid);
    await page.waitForTimeout(1500);
    const segOptions = await page.locator("select").nth(2).locator("option").allInnerTexts().catch(() => []);
    check(segOptions.some((o) => o.includes("BigBox")) && segOptions.some((o) => o.includes("SmallBox")),
      "セグメントが名前で選べる", segOptions);
    await page.getByTestId("roifeat-caselabel").fill(CASE_LABEL);
    await page.screenshot({ path: path.join(OUT_DIR, "01-form.png"), fullPage: true });

    const s1 = await runAndWait(page, async () => {
      await page.getByTestId("roifeat-run").click();
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(OUT_DIR, "02-progress.png") });
    });
    check(!/キャッシュ|Cached/.test(s1), "1 回目は新しく計算した表示", s1);
    const tableText = await page.getByTestId("roifeat-table").innerText();
    const rowCount = await page.getByTestId("roifeat-table").locator("tbody tr td[title]").count();
    check(rowCount / 2 >= 150, "表が 150 行以上", rowCount / 2);
    check(/過剰尖度|Excess kurtosis/.test(tableText), "Kurtosis の注記が出る");
    check(/log2/.test(tableText), "Entropy の注記が出る");
    check(/ビン数 32|32 bins/.test(tableText), "族の見出しに離散化が出る");
    check(/IBSI 外|non-IBSI/i.test(tableText), "IBSI 外の表示が出る");
    await page.screenshot({ path: path.join(OUT_DIR, "03-result.png"), fullPage: true });
    // 全体の 1 枚では縮んで読めないので、判定する行を画面に出して撮る。
    for (const [cell, name] of [["Kurtosis", "03a-ibs-kurtosis"], ["Entropy", "03b-histogram"], ["Capacity", "03c-fractal"]] as const) {
      const c = page.getByTestId("roifeat-table").locator(`td[title$="_${cell}"]`).first();
      await c.evaluate((el) => el.scrollIntoView({ block: "center" })).catch(() => {});
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(OUT_DIR, `${name}.png`) });
    }
    await page.evaluate("window.scrollTo(0, 0)");

    console.log("\n[3] CSV と API 直呼びの比較");
    await page.getByTestId("roifeat-csv").click();
    const dl1 = await takeDownloads(page, 2);
    for (const f of dl1) fs.writeFileSync(path.join(OUT_DIR, f.name), f.text);
    const data1 = dl1.find((f) => !f.name.endsWith("_definitions.csv"));
    const defs1 = dl1.find((f) => f.name.endsWith("_definitions.csv"));
    check(!!data1 && !!defs1, "CSV が 2 本出る", dl1.map((f) => f.name));
    const body32 = posted[0];
    check(!!body32 && body32.recompute === false, "画面の要求は recompute=false", body32);
    const direct32 = await apiFeatures(base, { ...body32, recompute: true });
    check(direct32.fromCache === false, "API 直呼びはキャッシュを使っていない");
    if (data1) {
      const lines = data1.text.split("\r\n");
      check(lines.length === 3 && lines[2] === "", "CSV は 2 行（列名・値）", lines.length);
      check(data1.text.charCodeAt(0) !== 0xfeff, "BOM なし");
      const dc = diffCount(data1.text, direct32.rows);
      check(dc.sameOrder, "列名と並びが API の結果と同じ");
      check(dc.mismatched.length === 0, "全列で値の差 0", dc.mismatched.slice(0, 5));
      const { names, values } = readData(data1.text);
      check(!names.some((n) => n.startsWith("OperationalInfo_")), "OperationalInfo_ の列が無い");
      check(names.some((n) => n.startsWith("Diagnostics_")), "Diagnostics_ の列はある（列の検査が効いている）");
      check(values[names.indexOf(VOXEL_COLUMN)] === voxels(SEG1), "ボクセル数が理論値", values[names.indexOf(VOXEL_COLUMN)]);
    }
    if (defs1) {
      const t = defs1.text.split("\r\n").filter((l) => l).map(splitRow);
      const by = new Map(t.slice(1).map((r) => [r[0], r]));
      check(t[0].join(",") === "column,family,feature,ibsi,notes,discretisation", "定義表の列", t[0]);
      check(!!by.get("IntensityBasedStatistical_Kurtosis")?.[4].includes("EXCESS_KURTOSIS"), "定義表: 一次統計 Kurtosis");
      check(!!by.get("IntensityHistogram_Kurtosis")?.[4].includes("EXCESS_KURTOSIS"), "定義表: ヒストグラム Kurtosis");
      check(!!by.get("IntensityHistogram_Entropy")?.[4].includes("LOG2_DISCRETISED"), "定義表: ヒストグラム Entropy");
      check([...by.values()].some((r) => r[1] === "Fractal" && r[3] === "" && r[4].includes("NON_IBSI")), "定義表: Fractal は IBSI 外");
      check([...by.values()].filter((r) => r[1] === "GLCM").every((r) => r[5] === "fixedBinNumber=32"), "定義表: GLCM の離散化");
      check(by.get("IntensityVolumeHistogram_VolumeAtIntensityFraction10")?.[3] === "BC2M_1"
        && by.get("IntensityVolumeHistogram_VolumeAtIntensityFraction10")?.[4] === "", "定義表: IVH の割合の特徴は枝番付きの IBSI");
    }

    console.log("\n[3b] 記録（症例ラベル・版・設定ファイル）と患者情報");
    await page.getByTestId("roifeat-provenance").scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(OUT_DIR, "03d-provenance.png") });
    const provText = await page.getByTestId("roifeat-provenance").innerText();
    const summaryText = await page.getByTestId("roifeat-settings-summary").innerText();
    await page.getByTestId("roifeat-settings-file").click();
    const [propsDl] = await takeDownloads(page, 1);
    check(!!propsDl && propsDl.name === `${CASE_LABEL}-seg0_radiomicsj.properties`, "設定ファイルの名前", propsDl?.name);
    check(!!data1 && data1.name === `${CASE_LABEL}-seg0.csv`, "CSV の名前に症例ラベル", data1?.name);
    const status = await api<{ version: string }>(base, "/api/status");
    if (propsDl && data1) {
      fs.writeFileSync(path.join(OUT_DIR, propsDl.name), propsDl.text);
      const rec = readRecord(data1.text);
      check(rec.CaseLabel === CASE_LABEL, "CaseLabel 列", rec.CaseLabel);
      check(rec.Provenance_GraphyNextVersion === status.version, "GraphyNext の版が /api/status と同じ",
        { csv: rec.Provenance_GraphyNextVersion, status: status.version });
      check(rec.Provenance_RadiomicsJVersion === "2.4.1", "RadiomicsJ の版が 2.4.1（jar の中で取り違えていない）",
        rec.Provenance_RadiomicsJVersion);
      check(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/.test(rec.Provenance_ExtractedAt), "抽出日時は ISO 8601",
        rec.Provenance_ExtractedAt);
      check(rec.Provenance_SettingsSha256 === sha256(propsDl.text), "CSV のハッシュ = 設定ファイルの SHA-256");
      check(propsDl.text === direct32.settingsProperties, "設定ファイルは API の本文と同じバイト列");
      check(provText.includes(status.version) && provText.includes("2.4.1")
        && provText.includes(rec.Provenance_SettingsSha256.slice(0, 4)), "表の上に版とハッシュ", provText);
      check(/ビン数 32|32 bins/.test(summaryText) && /なし|no resampling/.test(summaryText) && summaryText.includes("12/14"),
        "表の上に設定の要約", summaryText);
      // ROI の大きさ（基準値は未設定）
      check(rec.Roi_InitialVoxels === "5760" && rec.Roi_IntensityMaskVoxels === "5760" && rec.Roi_MorphMaskVoxels === "5760",
        "CSV の ROI のボクセル数が理論値 5760", rec);
      check(Math.abs(Number(rec.Roi_VolumeMm3) - volumeOf(synth, SEG1)) < 1e-6, "CSV の体積 = 5760 × 0.7 × 0.7 × 2.0 mm³",
        { csv: rec.Roi_VolumeMm3, expected: volumeOf(synth, SEG1) });
      check(rec.Warning_SmallRoiThresholdVoxels === "" && rec.Warning_SmallRoi === "",
        "基準値が未設定なら警告の 2 列は空（0 と書かない）", rec);
      check((await page.getByTestId("roifeat-smallroi-warning").count()) === 0, "未設定なら警告の帯は出ない");
      const sizeText = await page.getByTestId("roifeat-roisize").innerText();
      check(sizeText.includes("5,760") && sizeText.includes(volumeOf(synth, SEG1).toFixed(1)), "表の上に大きさ", sizeText);

      // アプリを通した往復: 書き出した設定ファイルをそのまま設定にして計算し直すと、CSV と全列で差 0・同じハッシュ
      const fileSettings = Object.fromEntries(propsDl.text.split("\n").filter((l) => l.includes("="))
        .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
      const viaFile = await apiFeatures(base, { ...body32, settings: fileSettings, recompute: true });
      const dcf = diffCount(data1.text, viaFile.rows);
      check(dcf.sameOrder && dcf.mismatched.length === 0, "設定ファイルで計算し直すと CSV と全列で差 0", dcf.mismatched.slice(0, 5));
      check(viaFile.provenance.settingsSha256 === rec.Provenance_SettingsSha256, "設定ファイルで計算し直しても同じハッシュ");
      const viaFile16 = await apiFeatures(base, { ...body32, settings: { ...fileSettings, INT_binCount: "16" }, recompute: true });
      const glcm16 = diffCount(data1.text, viaFile16.rows).mismatched.filter((c) => c.startsWith("GLCM_"));
      check(glcm16.length > 0, "負例: 設定ファイルのビン数を 16 にすると GLCM が一致しない", glcm16.length);

      // 患者情報: 合成データに患者名・ID が入っていることを先に確かめてから、3 本のファイルに無いことを見る
      const studies = await api<{ studyInstanceUid: string; patientName: string; patientId: string }[]>(
        base, `/api/studies?studyInstanceUid=${encodeURIComponent(synth.studyInstanceUid)}`);
      const st = studies.find((x) => x.studyInstanceUid === synth.studyInstanceUid);
      check(!!st && /SYNTH/.test(st.patientName) && st.patientId === "SYNTHROIFEAT", "取り込んだデータに患者名・ID がある", st);
      const all = [data1.text, defs1?.text ?? "", propsDl.text].join("\n");
      check(all.includes("GLCM_JointEntropy"), "検索の対象にファイルの中身が入っている");
      const found = ["SYNTH", "ROIFEAT", "19010203", "Patient", "Birth", "Sex"].filter((w) => all.includes(w));
      check(found.length === 0, "CSV・定義表・設定ファイルに患者名・ID・生年月日・性別が無い", found);
    }

    console.log("\n[4] もう一度計算（キャッシュ）と計算し直す");
    const s2 = await runAndWait(page, () => page.getByTestId("roifeat-run").click());
    check(/キャッシュ|Cached/.test(s2), "2 回目はキャッシュの結果と計算日時", s2);
    await page.screenshot({ path: path.join(OUT_DIR, "04-cached.png") });
    await page.getByTestId("roifeat-csv").click();
    const dl2 = await takeDownloads(page, 2);
    const data2 = dl2.find((f) => !f.name.endsWith("_definitions.csv"));
    // [3] の API 直呼び（recompute=true）がキャッシュを置き換えているので、抽出日時はその計算のもの。
    if (data2 && data1) {
      fs.writeFileSync(path.join(OUT_DIR, `cached_${data2.name}`), data2.text);
      const r1 = readRecord(data1.text);
      const r2 = readRecord(data2.text);
      check(data2.text.split("\r\n")[0] === data1.text.split("\r\n")[0], "キャッシュの CSV は列名が 1 回目と同じ");
      check(diffCount(data2.text, direct32.rows).mismatched.length === 0, "キャッシュの CSV は値が 1 回目と差 0");
      check(r2.Provenance_SettingsSha256 === r1.Provenance_SettingsSha256 && r2.CaseLabel === r1.CaseLabel,
        "キャッシュの CSV は設定のハッシュ・症例ラベルが同じ");
      check(r2.Provenance_ExtractedAt === direct32.provenance.extractedAt,
        "抽出日時は置き換えた計算（API の recompute）のもの", { csv: r2.Provenance_ExtractedAt, api: direct32.provenance.extractedAt });
    } else check(false, "キャッシュの CSV");
    const s3 = await runAndWait(page, () => page.getByTestId("roifeat-recompute").click());
    check(!/キャッシュ|Cached/.test(s3), "計算し直すと新しく計算した表示", s3);
    check(posted[posted.length - 1]?.recompute === true, "計算し直すは recompute=true");
    await page.screenshot({ path: path.join(OUT_DIR, "05-recomputed.png") });

    console.log("\n[5] 負例: ビン数 16");
    await page.getByTestId("roifeat-bincount").locator("input").fill("16");
    await page.getByTestId("roifeat-bincount").locator("input").blur();
    await runAndWait(page, () => page.getByTestId("roifeat-run").click());
    await page.getByTestId("roifeat-csv").click();
    const dl16 = await takeDownloads(page, 2);
    const data16 = dl16.find((f) => !f.name.endsWith("_definitions.csv"));
    check((posted[posted.length - 1]?.settings as Record<string, string> | undefined)?.INT_binCount === "16",
      "ビン数 16 を送っている");
    if (data16) {
      fs.writeFileSync(path.join(OUT_DIR, `bins16_${data16.name}`), data16.text);
      const dc = diffCount(data16.text, direct32.rows);
      const glcm = dc.mismatched.filter((c) => c.startsWith("GLCM_"));
      const morph = dc.mismatched.filter((c) => c.startsWith("Morphology_"));
      check(glcm.length > 0, "GLCM の値が 32 と一致しない（比較が効いている）", glcm.length);
      check(morph.length === 0, "形態の値は 32 と一致する（離散化に依らない）", morph);
    }
    await page.screenshot({ path: path.join(OUT_DIR, "06-bins16.png"), fullPage: true });

    console.log("\n[6] 2 つ目のセグメント");
    await page.getByTestId("roifeat-bincount").locator("input").fill("32");
    await page.getByTestId("roifeat-bincount").locator("input").blur();
    await page.locator("select").nth(2).selectOption("1");
    await runAndWait(page, () => page.getByTestId("roifeat-run").click());
    await page.getByTestId("roifeat-csv").click();
    const dlSeg2 = await takeDownloads(page, 2);
    const dataSeg2 = dlSeg2.find((f) => !f.name.endsWith("_definitions.csv"));
    if (dataSeg2) {
      const { names, values } = readData(dataSeg2.text);
      check(values[names.indexOf(VOXEL_COLUMN)] === voxels(SEG2), "2 つ目のセグメントのボクセル数が理論値",
        values[names.indexOf(VOXEL_COLUMN)]);
      check(dataSeg2.name.includes("seg1"), "ファイル名にセグメント", dataSeg2.name);
    } else check(false, "2 つ目のセグメントの CSV");

    console.log("\n[7] 取り消した計算がキャッシュに残る");
    await page.locator("select").nth(2).selectOption("0");
    await page.getByTestId("roifeat-bincount").locator("input").fill("24");
    await page.getByTestId("roifeat-bincount").locator("input").blur();
    await page.getByTestId("roifeat-run").click();
    await page.getByTestId("roifeat-progress").waitFor({ state: "visible", timeout: 10_000 });
    await page.getByTestId("roifeat-progress").getByRole("button").click();
    await page.waitForTimeout(800);
    const cancelText = await page.locator("body").innerText();
    check(/取り消しました|Cancelled/.test(cancelText), "取り消しの表示");
    await page.screenshot({ path: path.join(OUT_DIR, "07-cancelled.png") });
    // 取り消しても backend は最後まで計算する。終わるのを API で待ってから同じ要求を画面で出す。
    // 作業スレッドは 1 本なので、次の要求は取り消した計算が終わってから走り、キャッシュを引く。
    const cancelBody = posted[posted.length - 1];
    check((cancelBody?.settings as Record<string, string> | undefined)?.INT_binCount === "24", "取り消したのはビン数 24 の要求");
    const s7 = await runAndWait(page, () => page.getByTestId("roifeat-run").click());
    check(/キャッシュ|Cached/.test(s7), "取り消した計算の結果が次の要求でキャッシュから返る", s7);
    await page.screenshot({ path: path.join(OUT_DIR, "08-after-cancel.png") });

    console.log("\n[8] 小さい ROI の警告（環境設定で基準値を入れる）");
    await mainPage.bringToFront();
    await mainPage.getByTestId("mainscreen-menu-system").click();
    await mainPage.getByTestId("menu-item-settings").click();
    await mainPage.getByTestId("settings-dialog").waitFor({ state: "visible", timeout: 10_000 });
    await mainPage.getByTestId("settings-cat-texture").click();
    const warnLabel = mainPage.getByText(/^(小さい ROI の警告（ボクセル数）|Small-ROI warning \(voxels\))$/);
    const warnInput = warnLabel.locator("xpath=../..").locator("input");
    await warnInput.scrollIntoViewIfNeeded();
    check((await warnInput.inputValue()) === "", "環境設定の既定は空欄");
    await warnInput.fill("401");
    await mainPage.waitForTimeout(800);
    await mainPage.screenshot({ path: path.join(OUT_DIR, "09-settings.png") });
    const saved = await api<Record<string, string>>(base, "/api/settings");
    check(saved["texture.SmallRoiWarnVoxels"] === "401", "環境設定の値が保存される", saved["texture.SmallRoiWarnVoxels"]);
    await mainPage.getByTestId("dialog-close-button").click();

    const runSeg = async (seg: string) => {
      await page.bringToFront();
      await page.locator("select").nth(2).selectOption(seg);
      await page.getByTestId("roifeat-bincount").locator("input").fill("32");
      await page.getByTestId("roifeat-bincount").locator("input").blur();
      await runAndWait(page, () => page.getByTestId("roifeat-run").click());
      await page.getByTestId("roifeat-csv").click();
      const dl = await takeDownloads(page, 2);
      const data = dl.find((f) => !f.name.endsWith("_definitions.csv"));
      return data ? readRecord(data.text) : null;
    };
    const small401 = await runSeg("1");
    const band = page.getByTestId("roifeat-smallroi-warning");
    const bandText = (await band.count()) > 0 ? await band.innerText() : "";
    check(bandText.includes("400") && bandText.includes("401") && /エントロピー/.test(bandText),
      "400 ボクセル < 401 で警告の帯（ボクセル数と基準値）", bandText);
    await band.scrollIntoViewIfNeeded().catch(() => {});
    await page.screenshot({ path: path.join(OUT_DIR, "10-smallroi-warning.png") });
    check(small401?.Warning_SmallRoi === "1" && small401?.Warning_SmallRoiThresholdVoxels === "401",
      "CSV の Warning_SmallRoi が 1・基準値 401", small401);
    check(small401?.Roi_IntensityMaskVoxels === "400"
      && Math.abs(Number(small401?.Roi_VolumeMm3) - volumeOf(synth, SEG2)) < 1e-6,
      "小さい ROI のボクセル数 400・体積が理論値", small401);
    const big401 = await runSeg("0");
    check((await page.getByTestId("roifeat-smallroi-warning").count()) === 0 && big401?.Warning_SmallRoi === "0",
      "5760 ボクセルは警告なし・CSV は 0", big401);

    await api(base, "/api/settings", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ "texture.SmallRoiWarnVoxels": "400" }),
    });
    const small400 = await runSeg("1");
    check((await page.getByTestId("roifeat-smallroi-warning").count()) === 0 && small400?.Warning_SmallRoi === "0"
      && small400?.Warning_SmallRoiThresholdVoxels === "400", "基準値ちょうど（400）は警告なし・CSV は 0", small400);
    await page.screenshot({ path: path.join(OUT_DIR, "11-boundary.png") });
  } finally {
    await d.stop();
  }
  console.log(`\n  結果: ${passed} ok / ${failures.length} fail`);
  if (failures.length) {
    for (const f of failures) console.log(`   - ${f}`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
