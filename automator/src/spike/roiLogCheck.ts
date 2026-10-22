/*
 * ROI 特徴量の画像フィルタ LoGの実機検証スパイク。
 * 実行:  cd automator && PYTHON=<pydicom のある python> npx tsx src/spike/roiLogCheck.ts
 *
 *   合成 CT（0.7×0.7×2.0 mm＝等方でない格子）＋SEG を取り込み、特徴量の画面で LoG を選んで確かめる。
 *   (1) リサンプリング無しは日本語の理由で止まる（負例）  (2) 等方 1 mm にリサンプリングして計算できる
 *   (3) 表に σ ごとの LoG の塊が出て、各列が API と一致  (4) CSV の LoG 列が API と全列差 0
 *   (5) 設定ファイルに LoG のキー  (6) 同条件はキャッシュ、σ を変えると再計算で LoG 列が変わる  (7) 2D の単位でも出る。
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

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "roi-log-check");

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
  const r = spawnSync(process.env.PYTHON ?? "python3", ["-I", path.join(import.meta.dirname, "roiFeatureSynth.py"), dir, "21"], { encoding: "utf8" });
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
        frameOfReferenceUID: synth.frameOfReferenceUID, seriesDescription: "log SEG",
        segments: [{ number: 1, label: "Box", color: [255, 0, 0], description: null, frames: frames(synth, SEG1) }],
        producer: null,
      }),
    });
    check(!!seg.seriesInstanceUid, "SEG ができる");
    const req = (settings: Record<string, string>, roiModes?: string[]) => ({
      studyInstanceUid: synth.studyInstanceUid, sourceSeriesUid: synth.seriesInstanceUid,
      maskSeriesUid: seg.seriesInstanceUid, maskChannel: 0, channel: 0, timePoint: 0,
      settings, recompute: true, ...(roiModes ? { roiModes } : {}),
    });
    const ISO = { DOUBLEARRAY_resamplingFactorXYZ: "1,1,1", BOOL_USE_FixedBinNumber: "1", INT_binCount: "32" };

    console.log("[1] API");
    const refused = await runJob(base, req({ DOUBLEARRAY_logSigmaMm: "1.5" }));
    check(refused.state === "FAILED" && /リサンプリング/.test(refused.error ?? ""), "負例: 等方でない格子でリサンプリング無しは日本語で止まる", refused.error);
    const plain = await runJob(base, req({ ...ISO }));
    const l1 = await runJob(base, req({ ...ISO, DOUBLEARRAY_logSigmaMm: "1.5,2.5" }));
    check(plain.state === "DONE" && l1.state === "DONE", "リサンプリング後は LoG も計算できる", [plain.state, l1.state, l1.error]);
    const P = plain.result!;
    const L = l1.result!;
    const MEAN = "IntensityBasedStatistical_Mean";
    const logCols = L.rows.filter((x) => x.column.startsWith("log_sigma"));
    check(logCols.length > 0 && L.rows.some((x) => x.column === `log_sigma1.5mm_${MEAN}`) && L.rows.some((x) => x.column === `log_sigma2.5mm_${MEAN}`), "σ 1.5・2.5 の列が出る", logCols.length);
    check(P.rows.every((x) => L.rows.find((y) => y.column === x.column)?.value === x.value), "元の列はフィルタを足しても全列同じ");
    check(!logCols.some((x) => /Morphology|Diagnostics/.test(x.column)), "形態・Diagnostics は繰り返さない");
    check(logCols.every((x) => x.ibsi === null && x.notes.includes("LOG_FILTERED")), "LoG 列は IBSI 識別子なし・注記 LOG_FILTERED");
    check(L.settingsProperties.includes("DOUBLEARRAY_logSigmaMm=1.5,2.5\n"), "設定ファイルに σ");
    const l2 = await runJob(base, req({ ...ISO, DOUBLEARRAY_logSigmaMm: "1.5,3.5" }));
    const a = L.rows.find((x) => x.column === `log_sigma1.5mm_${MEAN}`)!.value;
    const a2 = l2.result!.rows.find((x) => x.column === `log_sigma1.5mm_${MEAN}`)!.value;
    check(a === a2, "σ 1.5 の列は、同時に計算する他の σ に依らない");
    check(l2.result!.rows.some((x) => x.column === `log_sigma3.5mm_${MEAN}`) && !l2.result!.rows.some((x) => x.column === `log_sigma2.5mm_${MEAN}`), "σ を変えると列も変わる");
    const l2d = await runJob(base, req({ ...ISO, DOUBLEARRAY_logSigmaMm: "1.5" }, ["WHOLE_3D", "MAX_SECTION_2D"]));
    const v3 = l2d.result!.rows.find((x) => x.column === `log_sigma1.5mm_${MEAN}`)?.value;
    const v2 = l2d.result!.section?.rows.find((x) => x.column === `log_sigma1.5mm_${MEAN}`)?.value;
    check(v3 != null && v2 != null && v3 !== v2, "2D の単位（面内）と 3D の単位で LoG の値が違う", [v3, v2]);

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
    await page.getByTestId("roifeat-caselabel").fill("log-case");
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
    check((await page.getByTestId("roifeat-log-sigma").count()) === 0, "フィルタなしのときは LoG の入力欄が出ない（負例）");
    await page.getByTestId("roifeat-filter-log").check();
    await page.getByTestId("roifeat-log-sigma").waitFor({ state: "visible" });
    // σ の検査（不正な入力は送らない）
    await page.getByTestId("roifeat-log-sigma").fill("abc");
    await page.getByTestId("roifeat-run").click();
    await page.getByTestId("roifeat-error").waitFor({ state: "visible", timeout: 5000 });
    check(/σ は正の数/.test(await page.getByTestId("roifeat-error").innerText()), "負例: σ が数でなければ送らずに理由を出す");
    // 等方でない格子でリサンプリング無し → backend の日本語の理由
    await page.getByTestId("roifeat-log-sigma").fill("1.5, 2.5");
    await page.getByTestId("roifeat-run").click();
    await page.getByTestId("roifeat-error").filter({ hasText: /リサンプリング/ }).waitFor({ state: "visible", timeout: 60_000 });
    check(true, "負例: リサンプリング無しは画面にも「リサンプリングを指定」と出る");
    await page.screenshot({ path: path.join(OUT_DIR, "01-refused.png"), fullPage: false });
    // 等方 1 mm にして計算
    await page.locator("select").filter({ hasText: "等方" }).first().selectOption("iso");
    await page.getByTestId("roifeat-run").click();
    await page.getByTestId("roifeat-table").waitFor({ state: "visible", timeout: 180_000 });
    await page.waitForTimeout(500);
    const summary = await page.getByTestId("roifeat-settings-summary").innerText();
    check(/LoG σ 1\.5, 2\.5 mm・切り捨て 4(\.0)?σ・MIRROR/.test(summary), "要約に LoG の σ・切り捨て・境界", summary);
    const heads = await page.getByTestId("roifeat-table").locator("td[colspan]").allInnerTexts();
    check(heads.some((h) => h.includes("LoG σ 1.5 mm・一次統計")) && heads.some((h) => h.includes("LoG σ 2.5 mm")), "LoG の塊が σ ごとに別の見出しで出る", heads.slice(0, 40));
    await page.getByTestId("roifeat-table").locator('td[title="log_sigma1.5mm_IntensityBasedStatistical_Mean"]').first().evaluate((el) => el.scrollIntoView({ block: "center" }));
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(OUT_DIR, "02-log-table.png"), fullPage: false });

    // 画面の値 = 同じ設定の API（リサンプリング 1 mm・LoG 1.5,2.5、ビン数 32）
    const ref = await runJob(base, req({ ...ISO, DOUBLEARRAY_logSigmaMm: "1.5,2.5" }));
    const want = ref.result!.rows.find((x) => x.column === `log_sigma1.5mm_${MEAN}`)!.value!;
    const rowText = await page.getByTestId("roifeat-table").locator('td[title="log_sigma1.5mm_IntensityBasedStatistical_Mean"]').first()
      .locator("xpath=..").innerText();
    const shown = Number(rowText.split("\t").map((x) => x.trim()).filter((x) => /^-?[0-9.e+-]+$/.test(x)).pop());
    check(Math.abs(shown - want) <= Math.max(1e-3, Math.abs(want) * 5e-4), "画面の LoG の平均が API の値と一致", [shown, want]);

    await page.evaluate("window.__roiDownloads = []");
    await page.getByTestId("roifeat-csv").click();
    for (let i = 0; i < 100 && ((await page.evaluate("window.__roiDownloads.length")) as number) < 2; i++) await page.waitForTimeout(100);
    const dl = (await page.evaluate("window.__roiDownloads")) as { name: string; text: string }[];
    const by = Object.fromEntries(dl.map((x) => [x.name, x.text]));
    const csv = parseCsv(by["log-case-seg0.csv"] ?? "");
    let worst = 0;
    let n = 0;
    for (const row of ref.result!.rows) {
      const i = csv.header.indexOf(row.column);
      if (i < 0) { worst = Infinity; break; }
      const got = csv.rows[0][i] === "NaN" ? null : Number(csv.rows[0][i]);
      if ((got == null) !== (row.value == null)) { worst = Infinity; break; }
      if (got != null) worst = Math.max(worst, Math.abs(got - row.value!));
      n++;
    }
    check(n > 100 && worst === 0, `CSV は API と全 ${n} 列で差 0（LoG 列を含む）`, worst);
    const defs = by["log-case-seg0_definitions.csv"] ?? "";
    check(/log_sigma1\.5mm_GLCM_[^\n]*fixedBinNumber=32/.test(defs) && /log_sigma1\.5mm_IntensityBasedStatistical_Mean[^\n]*LOG_FILTERED/.test(defs), "定義表: LoG 列に注記と元の族の離散化");
    await page.evaluate("window.__roiDownloads = []");
    await page.getByTestId("roifeat-settings-file").click();
    for (let i = 0; i < 50 && ((await page.evaluate("window.__roiDownloads.length")) as number) < 1; i++) await page.waitForTimeout(100);
    const prop = ((await page.evaluate("window.__roiDownloads")) as { name: string; text: string }[])[0];
    check(prop?.name === "log-case-seg0_radiomicsj.properties" && prop.text.includes("DOUBLEARRAY_logSigmaMm=1.5,2.5")
      && prop.text === ref.result!.settingsProperties, "設定ファイルに LoG のキー（API の設定と一字も違わない）", prop?.name);

    // キャッシュと再計算
    await page.getByTestId("roifeat-run").click();
    await page.getByTestId("roifeat-summary").filter({ hasText: /キャッシュ/ }).waitFor({ timeout: 60_000 });
    check(true, "同条件の 2 回目はキャッシュから返る");
    await page.getByTestId("roifeat-log-sigma").fill("1.5, 4.5");
    await page.getByTestId("roifeat-run").click();
    await page.getByTestId("roifeat-summary").filter({ hasText: /計算/ }).filter({ hasNotText: /キャッシュ/ }).waitFor({ timeout: 180_000 });
    const heads2 = await page.getByTestId("roifeat-table").locator("td[colspan]").allInnerTexts();
    check(heads2.some((h) => h.includes("LoG σ 4.5 mm")) && !heads2.some((h) => h.includes("LoG σ 2.5 mm")), "σ を変えると再計算され、列も変わる");
    await page.screenshot({ path: path.join(OUT_DIR, "03-sigma-changed.png"), fullPage: false });
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
