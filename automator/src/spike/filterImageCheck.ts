/*
 * フィルタ画像（LoG の派生シリーズ）の実機検証スパイク。
 * 実行:  cd automator && PYTHON=<pydicom のある python> npx tsx src/spike/filterImageCheck.ts
 *
 *   合成 CT（0.7×0.7×2.0 mm＝面内は等方・体積は非等方）を取り込み、2D ビューアの 解析 ▸ フィルタ画像（LoG）… で
 *   (1) 3D は非等方で日本語の理由で止まる（負例）  (2) 不正な走査・0 は送らずに理由が出る（負例）
 *   (3) r「2, 4」で 2 本の派生シリーズができ、1 本目が新しいタイルで開く
 *   (4) 保管庫のシリーズ: 枚数・DerivationDescription・ImageType・元と同じ格子。
 *
 * 実 PET の場合（PET を SUVbw に校正してからフィルタを掛け、出力の単位が g/ml{SUVbw} になる。課題 29）:
 *   cd automator && FILTER_CHECK_CASE=pet GRAPHY_AUTOMATOR_HTTP_PORT=21590 GRAPHY_AUTOMATOR_SCP_PORT=21591 GRAPHY_AUTOMATOR_VITE_PORT=21593 \
 *     AUTOMATOR_DATA_DIR=$PWD/.results/run-data/filter-image-pet timeout 1800 npx tsx src/spike/filterImageCheck.ts
 *   前提: backend jar を今のコードで作り直してある。frontend/node_modules/.vite と AUTOMATOR_DATA_DIR は実行のたびに消す。
 *   実データ ~/graphy-demo-samples/PSMA_...（PET 462 枚・BQML・腫瘍の SEG）。参照は filterPetSuvRef.py（pydicom・numpy・scipy だけ。
 *   textureMapSuvRef.py の独立の SUV の式を使う）。
 *     A. 画面で既定のまま（校正の欄は auto）実行 → 出力の実値が「SUVbw にした PET に 2D の LoG（scipy）」と、16 bit 量子化の誤差
 *        （RWVM の傾きの半分）の範囲で一致。単位 g/ml{SUVbw}・DerivationDescription に校正。ビューアの読み値に SUVbw が出る。
 *     B. none（API）→ Bq/mL の参照と一致・単位 Bq/ml。校正した出力 = 係数 × none の出力。
 *     C. 負例: 誤った係数（体重を取り違えた・係数 1）の参照とは一致しない。不正な calibration は HTTP 400。CT に bw は失敗。
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
import os from "node:os";
import { PY, PY_FLAGS } from "./pythonCmd.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "filter-image-check");

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
interface Result { fromCache: boolean; rows: Row[]; settingsProperties: string; section?: { rows: Row[] } }
interface Job { jobId: string; state: string; result?: Result; error?: string }

const SEG1: Record<number, [number, number]> = { 4: [14, 14], 5: [16, 16], 6: [14, 14], 7: [12, 12], 8: [10, 10] };

function frames(s: Synth, per: Record<number, [number, number]>) {
  return s.frames.map((f, z) => {
    const b = per[z];
    if (!b) return { ...f, mask: "" };
    const m = Buffer.alloc(s.rows * s.columns);
    for (let r = 14; r < 14 + b[0]; r++) for (let c = 14; c < 14 + b[1]; c++) m[r * s.columns + c] = 1;
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
  for (let i = 0; i < 900 && !["DONE", "FAILED", "CANCELLED"].includes(job.state); i++) {
    await new Promise((r) => setTimeout(r, 500));
    job = await api<Job>(base, `/api/radiomics/features/jobs/${job.jobId}`);
  }
  return job;
}

function parseCsv(text: string): { header: string[]; rows: string[][] } {
  const lines = text.trim().split(/\r?\n/).map((l) => l.split(","));
  return { header: lines[0], rows: lines.slice(1) };
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const dir = path.join(OUT_DIR, "synth");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const r = spawnSync(process.env.PYTHON ?? "python3", ["-I", path.join(import.meta.dirname, "roiFeatureSynth.py"), dir, String(Date.now() % 100000)], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`合成データを作れません: ${r.stderr}`);
  const synth = JSON.parse(r.stdout) as Synth;
  const d = new DesktopDriver();
  await d.start();
  const base = `http://127.0.0.1:${d.ports.http}`;
  try {
    console.log(`  reset: ${JSON.stringify(await resetDb(d.ports.http))}`);
    console.log(`  import: ${JSON.stringify(await importPaths(d.ports.http, [dir]))}`);
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
    const tilesBefore = await viewer.getByTestId("series-viewer-root").count();
    const seriesBefore = await api<{ seriesInstanceUid: string; seriesDescription?: string }[]>(base, `/api/studies/${synth.studyInstanceUid}/series`);

    await viewer.getByTestId("viewer2d-menu-analysis").click();
    await viewer.getByTestId("menu-filter-image").click();
    const dlg = viewer.getByTestId("filter-image-dialog");
    await dlg.waitFor({ state: "visible", timeout: 10_000 });
    check(true, "解析 ▸ フィルタ画像（LoG）… でダイアログが開く");
    check((await dlg.getByTestId("filterimg-scales").inputValue()) === "2, 4, 6", "既定のスケールは 2, 4, 6（0 は入らない）");

    // 不正な入力は送らずに理由が出る
    await dlg.getByTestId("filterimg-scales").fill("1:3:0");
    check(/刻みは 0 より大きく/.test(await dlg.getByTestId("filterimg-list").innerText()), "負例: 刻み 0 は一覧のところで理由が出る");
    await dlg.getByTestId("filterimg-scales").fill("0, 2");
    await dlg.getByTestId("filterimg-run").click();
    await dlg.getByTestId("filterimg-error").waitFor({ timeout: 5000 });
    check(/0 はフィルタなし/.test(await dlg.getByTestId("filterimg-error").innerText()), "負例: 0 は送らずに理由が出る");

    // 3D は非等方の格子（0.7×0.7×2.0）で日本語の理由で止まる
    await dlg.getByTestId("filterimg-scales").fill("2");
    await dlg.getByTestId("filterimg-dim").selectOption("3d");
    await dlg.getByTestId("filterimg-run").click();
    await dlg.getByTestId("filterimg-error").filter({ hasText: /リサンプリング/ }).waitFor({ timeout: 60_000 });
    check(true, "負例: 非等方の格子で 3D は「リサンプリングを指定」と日本語で止まる");
    const afterRefuse = await api<unknown[]>(base, `/api/studies/${synth.studyInstanceUid}/series`);
    check(afterRefuse.length === seriesBefore.length, "拒否されたときはシリーズが増えない");
    await dlg.getByTestId("filterimg-dim").selectOption("2d");

    // 2D（面内）で 2, 4
    await dlg.getByTestId("filterimg-scales").fill("2, 4");
    await dlg.getByTestId("filterimg-list").filter({ hasText: "計算するスケール（2 個）" }).waitFor({ timeout: 5000 });
    const listText = await dlg.getByTestId("filterimg-list").innerText();
    check(/r 2 mm → σ 1\.4142 mm/.test(listText) && /r 4 mm → σ 2\.8284 mm/.test(listText), "一覧に σ（2D は r/√2）が出る", listText);
    await viewer.screenshot({ path: path.join(OUT_DIR, "01-dialog.png"), fullPage: false });
    const progress: string[] = [];
    await dlg.getByTestId("filterimg-run").click();
    for (let i = 0; i < 1200 && (await dlg.count()) > 0; i++) {
      if (await dlg.getByTestId("filterimg-progress").count()) progress.push(await dlg.getByTestId("filterimg-progress").innerText().catch(() => ""));
      await viewer.waitForTimeout(100);
    }
    await viewer.waitForTimeout(1500);
    check((await dlg.count()) === 0, "作成が終わるとダイアログが閉じる");
    console.log(`  進み具合の表示: ${JSON.stringify([...new Set(progress)])}`);
    if (progress.some((x) => /スケール \d \/ 2（r [24] mm）/.test(x))) check(true, "進み具合に「スケール i / 2（r mm）」が出る");
    else console.log("  [未達] 進み具合は計算が速く、表示を捉えられなかった（合格には数えない）");

    // 保管庫のシリーズ
    const seriesAfter = await api<{ seriesInstanceUid: string; seriesDescription?: string }[]>(base, `/api/studies/${synth.studyInstanceUid}/series`);
    const made = seriesAfter.filter((s) => !seriesBefore.some((b) => b.seriesInstanceUid === s.seriesInstanceUid));
    check(made.length === 2, "派生シリーズが 2 本できる", made.map((m) => m.seriesDescription));
    const byDesc = (re: RegExp) => made.find((m) => re.test(m.seriesDescription ?? ""));
    const s2 = byDesc(/^LoG r2 /);
    const s4 = byDesc(/^LoG r4 /);
    check(!!s2 && !!s4, "シリーズの説明が「LoG r2 …」「LoG r4 …」", made.map((m) => m.seriesDescription));
    const srcInst = await api<{ sopInstanceUid: string }[]>(base, `/api/studies/${synth.studyInstanceUid}/series/${synth.seriesInstanceUid}/instances`);
    for (const [s, label, sigma] of [[s2, "r2", "1.4142"], [s4, "r4", "2.8284"]] as const) {
      if (!s) continue;
      const inst = await api<{ sopInstanceUid: string }[]>(base, `/api/studies/${synth.studyInstanceUid}/series/${s.seriesInstanceUid}/instances`);
      check(inst.length === srcInst.length, `${label}: 枚数が元と同じ（${srcInst.length}）`, inst.length);
      const file = await fetch(`${base}/api/studies/${synth.studyInstanceUid}/series/${s.seriesInstanceUid}/instances/${inst[0].sopInstanceUid}/file`);
      const bytes = Buffer.from(await file.arrayBuffer());
      const text = bytes.toString("latin1");
      check(text.includes(`filter=LoG; r_mm=${label.slice(1)}; sigma_mm=${sigma}; scale_to_sigma=SQRT_D; dim=2D; truncate_sigma=4.0; boundary=MIRROR; radiomicsj=`), `${label}: DerivationDescription に条件が key=value で入る`);
      check(text.includes("DERIVED") && text.includes("PRIMARY") && text.includes("LOG") && text.includes("FILTERED") && !text.includes("SECONDARY"), `${label}: ImageType が DERIVED\\PRIMARY\\LOG\\FILTERED（Parametric Map）`);
    }

    // 1 本目が新しいタイルで開く
    check((await viewer.getByTestId("series-viewer-root").count()) === tilesBefore + 1, "1 本目が新しいタイルで開く", await viewer.getByTestId("series-viewer-root").count());
    await viewer.screenshot({ path: path.join(OUT_DIR, "02-tiles.png"), fullPage: false });
  } finally {
    await d.stop();
  }
  console.log(`結果: ${passed} ok / ${failures.length} fail`);
  if (failures.length) {
    for (const f of failures) console.log(`   - ${f}`);
    process.exitCode = 1;
  }
}


// ── 実 PET の場合 ───────────────────────────────────────────────────────────
const PSMA = path.join(os.homedir(), "graphy-demo-samples", "PSMA_0198cdca94fbb95f", "PET", "CT whole-body PSMA");
const TM_REF = path.join(import.meta.dirname, "textureMapSuvRef.py");
const PET_REF = path.join(import.meta.dirname, "filterPetSuvRef.py");
const JAR = path.resolve(AUTOMATOR_ROOT, "..", "backend", "target", "graphy-next-backend.jar");
const PET_OUT = path.join(AUTOMATOR_ROOT, ".results", "filter-image-pet-check");

const pyRun = (script: string, args: string[]): any => {
  const r = spawnSync(PY, [...PY_FLAGS, script, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`python ${args[0]}: ${r.stderr}`);
  return JSON.parse(r.stdout);
};
async function http(base: string, p: string, method: string, body?: unknown): Promise<{ status: number; text: string }> {
  const res = await fetch(`${base}${p}`, { method, headers: JSON_HEADERS, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, text: await res.text() };
}
async function jobDone(base: string, jobId: string): Promise<{ state: string; error?: string; result?: { series: { seriesInstanceUid: string; sopInstanceUids: string[] }[] } }> {
  for (let i = 0; i < 1800; i++) {
    const st = JSON.parse((await http(base, `/api/series/filtered/jobs/${jobId}`, "GET")).text);
    if (["DONE", "FAILED", "CANCELLED"].includes(st.state)) return st;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("ジョブが終わらない");
}
async function downloadSeries(base: string, studyUid: string, seriesUid: string, dir: string): Promise<number> {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const inst = JSON.parse((await http(base, `/api/studies/${studyUid}/series/${seriesUid}/instances`, "GET")).text) as { sopInstanceUid: string }[];
  for (const i of inst) {
    const res = await fetch(`${base}/api/instances/${i.sopInstanceUid}/file`);
    if (!res.ok) throw new Error(`download ${i.sopInstanceUid}: HTTP ${res.status}`);
    fs.writeFileSync(path.join(dir, `${i.sopInstanceUid}.dcm`), Buffer.from(await res.arrayBuffer()));
  }
  return inst.length;
}

async function petMain(): Promise<void> {
  fs.mkdirSync(PET_OUT, { recursive: true });
  if (!fs.existsSync(PSMA)) {
    console.log(`  [未達] 実データが無い: ${PSMA}`);
    process.exitCode = 2;
    return;
  }
  const jarHas = spawnSync("unzip", ["-p", JAR, "BOOT-INF/classes/com/vis/graphynext/radiomics/FilteredSeriesRequest.class"], { maxBuffer: 16 * 1024 * 1024 });
  check(jarHas.status === 0 && jarHas.stdout.includes("calibration"), "jar は今のコード（FilteredSeriesRequest に calibration がある）", { mtime: fs.statSync(JAR).mtime });

  const stats = pyRun(TM_REF, ["stats", PSMA]);
  console.log(`  参照: SUVbw の係数 ${stats.scale}（体重・投与量・時刻から独立に計算）、Series Time を使用=${stats.usedSeriesTime}`);
  const R_MM = 8; // r 8 mm → σ = r/√2 = 5.657 mm（画素 4.07 mm で約 1.39 画素。核が潰れない）
  const SIGMA_MM = Number((R_MM / Math.SQRT2).toFixed(4)); // 本体が出力に記録する σ（小数 4 桁。DerivationDescription の sigma_mm）

  const d = new DesktopDriver();
  await d.start();
  const base = `http://127.0.0.1:${d.ports.http}`;
  try {
    console.log(`  reset: ${JSON.stringify(await resetDb(d.ports.http))}`);
    console.log(`  import: ${JSON.stringify(await importPaths(d.ports.http, [PSMA]))}`);
    const studies = JSON.parse((await http(base, "/api/studies", "GET")).text) as { studyInstanceUid: string }[];
    const studyUid = studies[0].studyInstanceUid;
    type S = { seriesInstanceUid: string; modality: string | null; seriesDescription?: string };
    const series = JSON.parse((await http(base, `/api/studies/${studyUid}/series`, "GET")).text) as S[];
    const pet = series.find((s) => s.modality === "PT");
    const ct = series.find((s) => s.modality === "CT");
    check(!!pet && !!ct, "PET・CT のシリーズがある", series.map((s) => s.modality));
    if (!pet || !ct) throw new Error("シリーズが足りない");
    const before = series.map((s) => s.seriesInstanceUid);
    const req = (extra: Record<string, unknown>) => ({
      studyInstanceUid: studyUid, sourceSeriesUid: pet.seriesInstanceUid, channel: 0, timePoint: 0, scales: [R_MM],
      scaleNotation: "RADIUS_MM", dimension: "2D", ...extra,
    });

    // C（先に）: 入口の検査。不正な calibration は HTTP 400（ジョブの FAILED ではない）
    const bad = await http(base, "/api/series/filtered/jobs", "POST", req({ calibration: "suv" }));
    check(bad.status === 400 && bad.text.includes("calibration"), "負例: 不正な calibration は HTTP 400（入口で断る）", { s: bad.status, t: bad.text.slice(0, 120) });
    const ctJob = JSON.parse((await http(base, "/api/series/filtered/jobs", "POST", { ...req({ calibration: "bw" }), sourceSeriesUid: ct.seriesInstanceUid })).text);
    const ctDone = await jobDone(base, ctJob.jobId);
    check(ctDone.state === "FAILED" && /PET/.test(ctDone.error ?? ""), "負例: CT に SUV の校正を指定するとジョブは理由つきで失敗", ctDone.error);

    // 画面（A）
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
    const tilesBefore = await viewer.getByTestId("series-viewer-root").count();
    await viewer.getByTestId("viewer2d-menu-analysis").click();
    await viewer.getByTestId("menu-filter-image").click();
    const dlg = viewer.getByTestId("filter-image-dialog");
    await dlg.waitFor({ state: "visible", timeout: 10_000 });
    await dlg.locator(`select:has(option[value="${pet.seriesInstanceUid}"])`).first().selectOption(pet.seriesInstanceUid);
    await viewer.waitForTimeout(800);
    const field = dlg.getByTestId("filterimg-calibration");
    check(await field.isVisible(), "画面: PET のとき「校正（PET）」の欄が出る");
    check((await field.inputValue()) === "auto", "画面: 欄の既定は auto");
    await dlg.getByTestId("filterimg-scales").fill(String(R_MM));
    await viewer.screenshot({ path: path.join(PET_OUT, "01-dialog-pet.png") });
    await field.selectOption("none");
    await viewer.waitForTimeout(400);
    check(await dlg.getByTestId("filterimg-calibration-none-warn").isVisible(), "画面: 校正しないを選ぶと注意文が出る");
    await viewer.screenshot({ path: path.join(PET_OUT, "02-dialog-pet-none.png") });
    await field.selectOption("auto");
    await dlg.locator(`select:has(option[value="${ct.seriesInstanceUid}"])`).first().selectOption(ct.seriesInstanceUid);
    await viewer.waitForTimeout(500);
    check((await dlg.getByTestId("filterimg-calibration").count()) === 0, "画面: CT のとき欄が出ない");
    await dlg.locator(`select:has(option[value="${pet.seriesInstanceUid}"])`).first().selectOption(pet.seriesInstanceUid);
    await viewer.waitForTimeout(500);
    check((await dlg.getByTestId("filterimg-calibration").inputValue()) === "auto", "画面: PET に戻すと欄は auto（既定のまま通す経路）");
    await dlg.getByTestId("filterimg-run").click();
    for (let i = 0; i < 1800 && (await dlg.count()) > 0; i++) await viewer.waitForTimeout(500);
    await viewer.waitForTimeout(2500);
    check((await dlg.count()) === 0, "画面: 既定のまま作成が終わりダイアログが閉じる");
    const after = JSON.parse((await http(base, `/api/studies/${studyUid}/series`, "GET")).text) as S[];
    const made = after.filter((s) => !before.includes(s.seriesInstanceUid));
    check(made.length === 1, "画面: 派生シリーズが 1 本できる", made.map((m) => m.seriesDescription));
    const autoUid = made[0].seriesInstanceUid;

    console.log("\n[A] 既定（画面・auto）: 実値 = SUVbw にした PET への 2D LoG（scipy）");
    const nAuto = await downloadSeries(base, studyUid, autoUid, path.join(PET_OUT, "auto"));
    const a = pyRun(PET_REF, ["filter", PSMA, path.join(PET_OUT, "auto"), String(SIGMA_MM), String(stats.scale)]);
    console.log(`  ${JSON.stringify({ ...a, derivation: undefined })}`);
    console.log(`  derivation: ${a.derivation}`);
    check(nAuto === stats.volumeShape[0], `枚数が元と同じ（${stats.volumeShape[0]}）`, nAuto);
    check(a.noValue === 0, "値なし（NaN）が無い", a.noValue);
    // 許容: 参照は scipy の LoG で、本体は RadiomicsJ の LoG。核の離散化の違いが値域に対し約 1e-5 ずつ出る（none も同じ割合）ので、
    // 校正が足す誤差かの判定は、下の「校正した出力 = 係数 × none の出力」（量子化の半幅だけで一致）で厳密に行う。
    // ここでは課題で決めた相対 1e-3（値域に対し）を上限にし、量子化の半幅（0.51 × 傾き）も別に報告する。
    const tolA = 1e-3 * a.refRange;
    check(a.maxAbsDiff <= tolA, `実値が参照と一致（最大差 ${a.maxAbsDiff.toExponential(3)} ≦ 値域 ${a.refRange.toFixed(2)} の 1e-3＝${tolA.toExponential(3)}。値域に対し ${a.maxDiffOverRange.toExponential(2)}、傾き ${a.slope.toExponential(3)} の ${a.maxAbsDiffOverSlope.toFixed(2)} 倍）`, { maxAbsDiff: a.maxAbsDiff, slope: a.slope, overSlope: a.maxAbsDiffOverSlope });
    check(a.unitCode === "g/ml{SUVbw}" && a.unitMeaning === "SUVbw", "RWVM の単位が UCUM g/ml{SUVbw}", { u: a.unitCode, m: a.unitMeaning });
    const m = /input_calibration=bw;scale=([0-9.eE+-]+)/.exec(a.derivation ?? "");
    check(!!m && Math.abs(Number(m[1]) - stats.scale) < stats.scale * 1e-9, "DerivationDescription に校正（bw・係数）が残り、係数が独立の計算と一致", a.derivation);
    check(/input_unit=SUVbw/.test(a.derivation ?? ""), "DerivationDescription に入力の単位 SUVbw");
    const wrongW = pyRun(PET_REF, ["filter", PSMA, path.join(PET_OUT, "auto"), String(SIGMA_MM), String(stats.scale * 70 / 120)]);
    check(wrongW.maxAbsDiff > 10 * tolA, "負例: 体重を 70 kg と取り違えた係数の参照とは一致しない", { maxAbsDiff: wrongW.maxAbsDiff });
    const wrongBq = pyRun(PET_REF, ["filter", PSMA, path.join(PET_OUT, "auto"), String(SIGMA_MM), "1.0"]);
    check(wrongBq.maxAbsDiff > 10 * tolA, "負例: Bq/mL（係数 1）の参照とは一致しない", { maxAbsDiff: wrongBq.maxAbsDiff });

    console.log("\n[B] none（API）: Bq/mL のまま。校正した出力 = 係数 × none の出力");
    const nj = JSON.parse((await http(base, "/api/series/filtered/jobs", "POST", req({ calibration: "none" }))).text);
    const nDone = await jobDone(base, nj.jobId);
    check(nDone.state === "DONE", "none のジョブが終わる", nDone.error);
    const noneUid = nDone.result!.series[0].seriesInstanceUid;
    await downloadSeries(base, studyUid, noneUid, path.join(PET_OUT, "none"));
    const n = pyRun(PET_REF, ["filter", PSMA, path.join(PET_OUT, "none"), String(SIGMA_MM), "1.0"]);
    console.log(`  derivation: ${n.derivation}`);
    check(n.maxAbsDiff <= 1e-3 * n.refRange, `none の実値が Bq/mL の参照と一致（最大差 ${n.maxAbsDiff.toExponential(3)}、値域 ${n.refRange.toFixed(0)} に対し ${n.maxDiffOverRange.toExponential(2)} ≦ 1e-3。auto は ${a.maxDiffOverRange.toExponential(2)}＝同じ割合）`, { maxAbsDiff: n.maxAbsDiff, slope: n.slope });
    check(Math.abs(n.maxDiffOverRange - a.maxDiffOverRange) <= 0.2 * a.maxDiffOverRange + 1e-7, "校正の有無で参照との相対誤差が変わらない（誤差は校正でなくフィルタの実装差）", { auto: a.maxDiffOverRange, none: n.maxDiffOverRange });
    check(n.unitCode === "Bq/ml", "none の単位は UCUM Bq/ml（SUV とは書かない）", n.unitCode);
    check(/input_calibration=none;scale=1(\.0)?;uncalibratedPet/.test(n.derivation ?? ""), "none: DerivationDescription に「校正なし」が残る", n.derivation);
    const wrongN = pyRun(PET_REF, ["filter", PSMA, path.join(PET_OUT, "none"), String(SIGMA_MM), String(stats.scale)]);
    check(wrongN.maxAbsDiff > 100 * 1e-3 * n.refRange, "負例: none の出力を SUV の参照と比べると一致しない", { maxAbsDiff: wrongN.maxAbsDiff });
    const pair = pyRun(PET_REF, ["pair", path.join(PET_OUT, "auto"), path.join(PET_OUT, "none"), String(stats.scale)]);
    check(pair.maxAbsDiff <= pair.tolerance, `校正した出力 = 係数 × none の出力（最大差 ${pair.maxAbsDiff.toExponential(3)} ≦ 許容 ${pair.tolerance.toExponential(3)}＝両者の量子化の半幅の和）`, pair);

    console.log("\n[V] ビューア: 既定の出力が新しいタイルで開き、読み値に単位 SUV が出る");
    check((await viewer.getByTestId("series-viewer-root").count()) === tilesBefore + 1, "1 本目が新しいタイルで開く", await viewer.getByTestId("series-viewer-root").count());
    const tile = viewer.getByTestId("series-viewer-root").last();
    const zInput = tile.locator('input[placeholder="#"]').first();
    await zInput.fill(String(a.bestSlice + 1));
    await zInput.press("Enter");
    await viewer.waitForTimeout(2500);
    const canvas = tile.locator("canvas").first();
    const box = (await canvas.boundingBox())!;
    const sc = Math.min(box.width / a.cols, box.height / a.rows);
    const cx = box.x + box.width / 2 + (a.bestRC[1] + 0.5 - a.cols / 2) * sc;
    const cy = box.y + box.height / 2 + (a.bestRC[0] + 0.5 - a.rows / 2) * sc;
    // 表示の位置合わせの誤差を許し、周りの数点を読む。読み値は「腫瘍の最大点の周り 15×15 画素の PM の実値」のどれかと表示の桁（小数 3 桁）で一致する
    let readM: RegExpExecArray | null = null;
    let matched = false;
    for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [2, 0], [-2, 0], [0, 2], [0, -2]]) {
      await viewer.mouse.move(cx + dx * sc, cy + dy * sc);
      await viewer.waitForTimeout(500);
      const tileText = await tile.innerText();
      readM = /値\s*(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)\s*([^\s\n]*)/.exec(tileText);
      if (readM && (a.window as number[]).some((v) => Math.abs(v - Number(readM![1])) <= 0.0006 + 0.51 * a.slope)) { matched = true; break; }
    }
    console.log(`  読み値: ${JSON.stringify(readM?.[0])}（PM の実値の周り: ${(a.window as number[]).length} 点、最大点 ${a.pmAtBest}）`);
    check(!!readM && /SUV/.test(readM[2] ?? ""), "ビューアの読み値の単位表示に SUV が出る", { text: readM?.[0] });
    check(matched, "読み値が PM の実値（RWVM を掛けた値）のどれかと表示の桁で一致する", { shown: readM?.[1] });
    await viewer.screenshot({ path: path.join(PET_OUT, "03-viewer-tumor-slice.png") });
    const png = path.join(PET_OUT, "03a-canvas.png");
    await viewer.screenshot({ path: png, clip: { x: box.x, y: box.y, width: box.width, height: box.height } });
    const vis = pyRun(TM_REF, ["visible", png]);
    console.log(`  見える画素: ${JSON.stringify(vis)}`);
    check(vis.visible >= 1000, "タイルが空・真っ黒でない（黒でない画素が千個以上）", vis);
  } finally {
    await d.stop();
  }
  console.log(`\n結果（実 PET）: 合格 ${passed} / 失敗 ${failures.length} / 未達 0`);
  if (failures.length) {
    for (const f of failures) console.log(`   - ${f}`);
    process.exitCode = 1;
  }
}

if (process.env.FILTER_CHECK_CASE === "pet") {
  petMain().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
} else {
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
}
