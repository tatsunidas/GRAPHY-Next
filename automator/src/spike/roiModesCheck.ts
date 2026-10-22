/*
 * ROI 特徴量の計算の単位（TR-ROI-003: 全腫瘍 3D／最大断面 2D／スライス別 2D）の実機検証スパイク。
 * 実行:  cd automator && PYTHON=<pydicom のある python> npx tsx src/spike/roiModesCheck.ts
 *
 *   合成 CT＋SEG（スライスごとに前景の大きさが違う）を取り込み、特徴量の画面で 3 単位を 1 回で計算して、
 *   (1) 並べた表の各列が API の値と一致  (2) 書き出した 2D の CSV が API と全列差 0
 *   (3) スライス別の行数＝前景のスライス数  (4) 3D だけの CSV は 2D を選んでも変わらない  を確かめる。
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { openFirstSeriesInViewer } from "../checklist/items/shared/helpers.js";
import { createStepRecorder } from "../checklist/types.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "roi-modes-check");

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
interface SliceRow { positionMm: number; pixels: number; areaMm2: number; rows: Row[] }
interface Result {
  fromCache: boolean;
  rows: Row[];
  section?: { positionMm: number; areaMm2: number; pixels: number; rows: Row[]; fromCache: boolean };
  slices?: {
    rows: SliceRow[]; failures: { positionMm: number }[]; mean: Row[]; pixelWeightedMean: Row[];
    slicesUsed: Record<string, number>; foregroundSlices: number;
  };
}
interface Job { jobId: string; state: string; result?: Result; error?: string; sliceDone?: number; sliceTotal?: number }

/** スライスごとの前景（縦×横）。z=5 の 15×15 が最大。前景のあるスライスは 4 枚。 */
const SEG1: Record<number, [number, number]> = { 2: [10, 10], 3: [20, 10], 5: [15, 15], 7: [12, 12] };

function frames(s: Synth, per: Record<number, [number, number]>) {
  return s.frames.map((f, z) => {
    const b = per[z];
    if (!b) return { ...f, mask: "" };
    const m = Buffer.alloc(s.rows * s.columns);
    for (let r = 5; r < 5 + b[0]; r++) for (let c = 5; c < 5 + b[1]; c++) m[r * s.columns + c] = 1;
    return { ...f, mask: m.toString("base64") };
  });
}

async function api<T>(base: string, p: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${base}${p}`, init);
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${p} → HTTP ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

const JSON_HEADERS = { "Content-Type": "application/json" };

async function runJob(base: string, body: unknown): Promise<Job> {
  let job = await api<Job>(base, "/api/radiomics/features/jobs", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });
  for (let i = 0; i < 600 && !["DONE", "FAILED", "CANCELLED"].includes(job.state); i++) {
    await new Promise((r) => setTimeout(r, 500));
    job = await api<Job>(base, `/api/radiomics/features/jobs/${job.jobId}`);
  }
  return job;
}

/** CSV（ヘッダ 1 行＋データ行）を、列名→値の配列に読む。値にカンマは含まれない前提（症例ラベルは英数字）。 */
function parseCsv(text: string): { header: string[]; rows: string[][] } {
  const lines = text.trim().split(/\r?\n/).map((l) => l.split(","));
  return { header: lines[0], rows: lines.slice(1) };
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const dir = path.join(OUT_DIR, "synth");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const r = spawnSync(process.env.PYTHON ?? "python3", ["-I", path.join(import.meta.dirname, "roiFeatureSynth.py"), dir, "11"], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`合成データを作れません: ${r.stderr}`);
  const synth = JSON.parse(r.stdout) as Synth;
  const d = new DesktopDriver();
  await d.start();
  const base = `http://127.0.0.1:${d.ports.http}`;
  try {
    console.log(`  reset: ${JSON.stringify(await resetDb(d.ports.http))}`);
    console.log(`  import: ${JSON.stringify(await importPaths(d.ports.http, [dir]))}`);
    const seg = await api<{ seriesInstanceUid: string }>(base, "/api/dicom/seg", {
      method: "POST", headers: JSON_HEADERS,
      body: JSON.stringify({
        studyInstanceUid: synth.studyInstanceUid, seriesInstanceUid: synth.seriesInstanceUid,
        rows: synth.rows, columns: synth.columns, imageOrientationPatient: [1, 0, 0, 0, 1, 0],
        pixelSpacing: synth.pixelSpacing, sliceThickness: synth.sliceThickness,
        frameOfReferenceUID: synth.frameOfReferenceUID, seriesDescription: "modes SEG",
        segments: [{ number: 1, label: "Unique", color: [255, 0, 0], description: null, frames: frames(synth, SEG1) }],
        producer: null,
      }),
    });
    check(!!seg.seriesInstanceUid, "SEG ができる");
    const req = (roiModes?: string[]) => ({
      studyInstanceUid: synth.studyInstanceUid, sourceSeriesUid: synth.seriesInstanceUid,
      maskSeriesUid: seg.seriesInstanceUid, maskChannel: 0, channel: 0, timePoint: 0,
      settings: {}, recompute: true, ...(roiModes ? { roiModes } : {}),
    });

    console.log("[1] API");
    const only3d = await runJob(base, req());
    check(only3d.state === "DONE" && !only3d.result?.section && !only3d.result?.slices, "単位を指定しない＝3D だけ（従来どおり）", only3d.state);
    const all = await runJob(base, req(["WHOLE_3D", "MAX_SECTION_2D", "SLICES_2D"]));
    check(all.state === "DONE", "3 単位の計算が終わる", all.error);
    const A = all.result!;
    check(A.slices?.rows.length === 4 && A.slices.foregroundSlices === 4 && A.slices.failures.length === 0, "スライス別: 前景 4 枚に 4 行・失敗 0", A.slices?.foregroundSlices);
    check((all.sliceTotal ?? 0) === 4 && (all.sliceDone ?? 0) === 4, "進み 4/4", [all.sliceDone, all.sliceTotal]);
    check(A.section?.pixels === 225 && Math.abs((A.section?.positionMm ?? 1e9) - synth.frames[5].imagePositionPatient[2]) < 1e-3, "最大断面 2D は z=5（225 画素）", A.section);
    const area = synth.pixelSpacing[0] * synth.pixelSpacing[1];
    const surf = A.section?.rows.find((x) => x.column === "Shape2D_PixelSurface")?.value;
    check(surf != null && Math.abs(surf - 225 * area) < 1e-6, "Shape2D_PixelSurface＝最大断面の面積", surf);
    check(!A.section!.rows.some((x) => x.family === "Morphology" || x.family === "GLAM"), "2D に Morphology・GLAM の列は無い");
    check(A.rows.some((x) => x.family === "Morphology") && !A.rows.some((x) => x.family === "Shape2D"), "3D は従来どおり（Morphology あり・Shape2D なし）");
    const same3d = JSON.stringify(only3d.result!.rows.map((x) => [x.column, x.value])) === JSON.stringify(A.rows.map((x) => [x.column, x.value]));
    check(same3d, "3D の値は 2D の単位を足しても全列同じ");
    const neg = await fetch(`${base}/api/radiomics/features/jobs`, {
      method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ ...req(), settings: { BOOL_force2D: "1" } }),
    });
    check(neg.status === 400, "負例: BOOL_force2D の直接指定は 400", neg.status);

    console.log("[2] 画面");
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
    await page.getByTestId("roifeat-mask").waitFor({ state: "visible", timeout: 20_000 });
    await page.waitForTimeout(1500);
    await page.getByTestId("roifeat-mask").selectOption(seg.seriesInstanceUid);
    await page.getByTestId("roifeat-caselabel").fill("modes-case");
    check(await page.getByTestId("roifeat-mode-whole").isDisabled(), "3D のチェックは外せない（常に計算）");
    check(!(await page.getByTestId("roifeat-mode-section").isChecked()) && !(await page.getByTestId("roifeat-mode-slices").isChecked()), "既定は 2D の単位がオフ");

    // 3D だけで計算 → 従来の表（比較表ではない）
    await page.getByTestId("roifeat-run").click();
    await page.getByTestId("roifeat-table").waitFor({ state: "visible", timeout: 120_000 });
    check((await page.getByTestId("roifeat-modes2d").count()) === 0, "3D だけのときは 2D の要約が出ない（負例）");
    const dl3: { name: string; text: string }[] = [];
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
    const grab = async (p: typeof page, click: () => Promise<void>, n: number) => {
      await p.evaluate("window.__roiDownloads = []");
      await click();
      for (let i = 0; i < 100; i++) {
        const c = (await p.evaluate("window.__roiDownloads.length")) as number;
        if (c >= n) break;
        await p.waitForTimeout(100);
      }
      return (await p.evaluate("window.__roiDownloads")) as { name: string; text: string }[];
    };
    dl3.push(...(await grab(page, () => page.getByTestId("roifeat-csv").click(), 2)));
    check(dl3.length === 2, "3D だけ: CSV は従来の 2 本", dl3.map((x) => x.name));
    const csv3dBefore = dl3.find((x) => x.name === "modes-case-seg0.csv")?.text ?? "";
    check(csv3dBefore.length > 1000, "3D の CSV に中身がある（空どうしの比較にしない）", csv3dBefore.length);

    // 2 単位をオン → 3 単位を並べる
    await page.getByTestId("roifeat-mode-section").check();
    await page.getByTestId("roifeat-mode-slices").check();
    await page.getByTestId("roifeat-run").click();
    await page.getByTestId("roifeat-modes2d").waitFor({ state: "visible", timeout: 120_000 });
    await page.waitForTimeout(500);
    const sum1 = await page.getByTestId("roifeat-section-summary").innerText();
    const sum2 = await page.getByTestId("roifeat-slices-summary").innerText();
    const wantPos = (Math.round(synth.frames[5].imagePositionPatient[2] * 10) / 10).toFixed(1);
    check(sum1.includes(`位置 ${wantPos} mm`) && sum1.includes("225 画素"), "最大断面の要約が API と一致", sum1);
    check(sum2.includes("4 枚のうち 4 枚") && sum2.includes("失敗 0 枚"), "スライス別の要約（前景 4 枚・失敗 0）", sum2);
    await page.getByTestId("roifeat-slices-details").locator("summary").click();
    check((await page.getByTestId("roifeat-slices-table").locator("tbody tr").count()) === 4, "スライス別の表は前景のスライス数（4 行）");

    // 並べた表の各列 = 画面を押して出た結果と同じ要求の API の値
    const ref = await runJob(base, req(["WHOLE_3D", "MAX_SECTION_2D", "SLICES_2D"]));
    const R = ref.result!;
    const cell = async (column: string, col: string) =>
      (await page.getByTestId(`roifeat-cmp-${column}`).locator(`[data-col="${col}"]`).innerText()).trim();
    const MEAN = "IntensityBasedStatistical_Mean";
    const fmtLike = (v: number | null | undefined) => (v == null ? "NaN" : v);
    const num = (s: string) => Number(s.replace(/,/g, ""));
    const m3 = R.rows.find((x) => x.column === MEAN)!.value!;
    const m2 = R.section!.rows.find((x) => x.column === MEAN)!.value!;
    const mm = R.slices!.mean.find((x) => x.column === MEAN)!.value!;
    const mw = R.slices!.pixelWeightedMean.find((x) => x.column === MEAN)!.value!;
    const close = (s: string, want: number) => Math.abs(num(s) - want) <= Math.max(1e-3, Math.abs(want) * 5e-4);
    check(close(await cell(MEAN, "whole"), m3), "並べた表: 3D 列の平均が API と一致", [await cell(MEAN, "whole"), m3]);
    check(close(await cell(MEAN, "section"), m2), "並べた表: 最大断面列の平均が API と一致", [await cell(MEAN, "section"), m2]);
    check(close(await cell(MEAN, "sliceMean"), mm), "並べた表: スライス平均列が API と一致", [await cell(MEAN, "sliceMean"), mm]);
    check(close(await cell(MEAN, "sliceWeighted"), mw), "並べた表: 画素数重み付き列が API と一致", [await cell(MEAN, "sliceWeighted"), mw]);
    check(Math.abs(mm - mw) > 1e-6, "単純平均と画素数重み付きは食い違う（重みが効いている）", { mm, mw });
    check((await cell("Morphology_VolumeMesh", "section")) === "—" && (await cell("Morphology_VolumeMesh", "sliceMean")) === "—", "2D で計算しない特徴は「—」");
    check((await cell("Shape2D_PixelSurface", "whole")) === "—" && num(await cell("Shape2D_PixelSurface", "section")) > 0, "Shape2D は 2D の列だけ");
    void fmtLike;
    await page.screenshot({ path: path.join(OUT_DIR, "01-form.png"), fullPage: false });
    await page.getByTestId("roifeat-slices-details").evaluate((el) => el.scrollIntoView({ block: "start" }));
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT_DIR, "02-slices-and-table.png"), fullPage: false });
    await page.getByTestId(`roifeat-cmp-${MEAN}`).evaluate((el) => el.scrollIntoView({ block: "center" }));
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT_DIR, "03-compare-table.png"), fullPage: false });

    // 書き出し: 3D の 2 本 + 2D の 7 本
    const dl = await grab(page, () => page.getByTestId("roifeat-csv").click(), 9);
    check(dl.length === 9, "CSV: 3D の 2 本＋2D の 7 本", dl.map((x) => x.name));
    const by = Object.fromEntries(dl.map((x) => [x.name, x.text]));
    check((by["modes-case-seg0.csv"] ?? "").length > 1000 && stripVolatile(by["modes-case-seg0.csv"]) === stripVolatile(csv3dBefore),
      "3D の CSV は 2D を選んでも変わらない（記録の時刻を除く）");
    const sec = parseCsv(by["modes-case-seg0_maxsection2d.csv"] ?? "");
    const hdr = sec.header;
    const maxDiff = (names: string[], vals: string[], hdrs: string[], ref2: Row[]) => {
      let worst = 0;
      let n = 0;
      for (const r2 of ref2) {
        const i = hdrs.indexOf(r2.column);
        if (i < 0) return { worst: Infinity, n, missing: r2.column };
        const got = vals[i] === "NaN" ? null : Number(vals[i]);
        if ((got == null) !== (r2.value == null)) return { worst: Infinity, n, missing: `${r2.column} NaN 不一致` };
        if (got != null) worst = Math.max(worst, Math.abs(got - r2.value!));
        n++;
      }
      void names;
      return { worst, n, missing: null as string | null };
    };
    const d1 = maxDiff([], sec.rows[0] ?? [], hdr, R.section!.rows);
    check(hdr.length > 20 && sec.rows.length === 1, "最大断面の CSV に中身がある", [hdr.length, sec.rows.length]);
    check(sec.rows.length === 1 && d1.missing == null && d1.worst === 0, `最大断面の CSV は API と全 ${d1.n} 列で差 0`, d1);
    check(!hdr.some((h) => h.startsWith("Morphology_") || h.startsWith("GLAM_")), "最大断面の CSV に Morphology・GLAM の列が無い");
    check(hdr.slice(0, 5).join(",") === "CaseLabel,Provenance_GraphyNextVersion,Provenance_RadiomicsJVersion,Provenance_ExtractedAt,Provenance_SettingsSha256", "記録 5 列が 3D と同じ並び");
    const sl = parseCsv(by["modes-case-seg0_slices2d.csv"] ?? "");
    check(sl.rows.length === 4, "スライス別の CSV は前景のスライス数と同じ 4 行", sl.rows.length);
    let slWorst = 0;
    sl.rows.forEach((row, k) => {
      const ref2 = R.slices!.rows[k];
      slWorst = Math.max(slWorst, maxDiff([], row, sl.header, ref2.rows).worst);
      slWorst = Math.max(slWorst, Math.abs(Number(row[sl.header.indexOf("Slice_PositionMm")]) - ref2.positionMm));
    });
    check(sl.rows.length === 4 && slWorst === 0, "スライス別の CSV は API と全列差 0", slWorst);
    const ag = parseCsv(by["modes-case-seg0_slices2d_aggregate.csv"] ?? "");
    const aggName = (row: string[]) => row[ag.header.indexOf("Aggregate")];
    const meanRow = ag.rows.find((r3) => aggName(r3) === "mean")!;
    const wRow = ag.rows.find((r3) => aggName(r3) === "pixelWeightedMean")!;
    check(maxDiff([], meanRow, ag.header, R.slices!.mean).worst === 0 && maxDiff([], wRow, ag.header, R.slices!.pixelWeightedMean).worst === 0, "集約の CSV は API と全列差 0");
    check(ag.rows.length === 3, "集約の CSV は mean・pixelWeightedMean・slicesUsed の 3 行");
    const defs = by["modes-case-seg0_slices2d_definitions.csv"] ?? "";
    check(/GLCM_[^\n]*per-slice/.test(defs), "2D の定義表の離散化に per-slice が付く");
    check((by["modes-case-seg0_maxsection2d_radiomicsj.properties"] ?? "").includes("BOOL_force2D=1"), "2D の設定ファイルに BOOL_force2D=1");
    check(!(by["modes-case-seg0_radiomicsj.properties"] ?? "").includes("BOOL_force2D=1"), "3D の設定ファイルには force2D が無い（負例）");
    check(dl.every((x) => !/PatientName|PatientID|Patient/.test(x.text)), "患者情報の列が出力に無い");
  } finally {
    await d.stop();
  }
  console.log(`結果: ${passed} ok / ${failures.length} fail`);
  if (failures.length) {
    for (const f of failures) console.log(`   - ${f}`);
    process.exitCode = 1;
  }
}

/** 記録の時刻（Provenance_ExtractedAt）の列を空にして比べる。 */
function stripVolatile(csv: string): string {
  const { header, rows } = parseCsv(csv);
  const i = header.indexOf("Provenance_ExtractedAt");
  return [header.join(","), ...rows.map((r) => r.map((v, k) => (k === i ? "" : v)).join(","))].join("\n");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
