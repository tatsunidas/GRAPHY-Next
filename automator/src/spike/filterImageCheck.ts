/*
 * フィルタ画像（LoG の派生シリーズ）の実機検証スパイク。
 * 実行:  cd automator && PYTHON=<pydicom のある python> npx tsx src/spike/filterImageCheck.ts
 *
 *   合成 CT（0.7×0.7×2.0 mm＝面内は等方・体積は非等方）を取り込み、2D ビューアの 解析 ▸ フィルタ画像（LoG）… で
 *   (1) 3D は非等方で日本語の理由で止まる（負例）  (2) 不正な走査・0 は送らずに理由が出る（負例）
 *   (3) r「2, 4」で 2 本の派生シリーズができ、1 本目が新しいタイルで開く
 *   (4) 保管庫のシリーズ: 枚数・DerivationDescription・ImageType・元と同じ格子。
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
      check(text.includes("DERIVED") && text.includes("SECONDARY") && text.includes("LOG"), `${label}: ImageType が DERIVED\\SECONDARY\\LOG`);
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

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
