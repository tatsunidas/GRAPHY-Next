/*
 * ROI 特徴量の「LoG（構造の半径）」と複数スケールの実機検証スパイク。
 * 実行:  cd automator && PYTHON=<pydicom のある python> npx tsx src/spike/roiScaleCheck.ts
 *
 *   合成 CT＋SEG を取り込み、特徴量の画面で半径の並び「0, 2, 3」を計算して確かめる。
 *   (1) API: r=0 はフィルタなしと全列一致、σ=r/√3、半径と σ の併用は止まる（負例）
 *   (2) 画面: スケールのタブ・各タブの表と換算の説明・仮定の注記・進み具合
 *   (3) CSV がスケールごとに 1 行で API と全列差 0、設定ファイルがスケールごとに 1 本で API と一字も違わない
 *   (4) 「0, 2, 3」の後の「0, 2, 3, 4」で 0・2・3 はキャッシュ、4 だけ新規。
 *   (5) 走査「1:2:0.5」の一覧と不正な走査の拒否  (6) 幅（画素）・名札: 一覧・タブ・CSV の入力の列・API との差 0。
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

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "roi-scale-check");

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
    const plain = await runJob(base, req({ ...ISO }));
    const sc = await runJob(base, { ...req({ ...ISO }), scales: [0, 2, 3] });
    check(plain.state === "DONE" && sc.state === "DONE", "スケール 0, 2, 3 が計算できる", [plain.state, sc.state, sc.error]);
    const S = (sc.result as unknown as { scales: { scaleMm: number; sigma3dMm: number | null; result: Result }[] }).scales;
    check(S.length === 3 && S.map((x) => x.scaleMm).join() === "0,2,3", "結果にスケールが 3 つ並ぶ");
    check(S[0].sigma3dMm === null && S[1].sigma3dMm === 1.1547 && S[2].sigma3dMm === 1.7321, "σ = r/√3（0 は σ なし）", S.map((x) => x.sigma3dMm));
    check(plain.result!.rows.length === S[0].result.rows.length
      && plain.result!.rows.every((x, i) => S[0].result.rows[i].column === x.column && S[0].result.rows[i].value === x.value),
      "r=0 の行はフィルタなしの表と全列同じ");
    check(S[2].result.rows.some((x) => x.column.startsWith("log_sigma1.7321mm_")) && !S[0].result.rows.some((x) => x.column.startsWith("log_sigma")), "r=3 だけ LoG の列がある");
    const both = await runJob(base, { ...req({ ...ISO, DOUBLEARRAY_logSigmaMm: "1.5" }), scales: [2] });
    check(both.state === "FAILED" && /同時/.test(both.error ?? ""), "負例: 半径と σ の併用は止まる", both.error);
    // 画面の 1 回目を「初回の計算」にするため、ここのキャッシュは捨てて UI 側で recompute させる
    const refScales = S;

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
    check((await page.getByTestId("roifeat-scales").count()) === 0, "半径の入力欄は、選ぶまで出ない（負例）");
    await page.getByTestId("roifeat-filter-radius").check();
    await page.getByTestId("roifeat-scales").waitFor({ state: "visible" });
    check((await page.getByTestId("roifeat-scales").inputValue()) === "0, 2, 3, 4, 5, 6", "半径の初期値は 0, 2, 3, 4, 5, 6");
    const note = await page.getByTestId("roifeat-scale-note").innerText();
    check(/仮定/.test(note) && /同名の設定と同じ値になるとは限りません/.test(note), "仮定の注記が出る", note);
    await page.getByTestId("roifeat-scales").fill("0, -1");
    await page.getByTestId("roifeat-run").click();
    await page.getByTestId("roifeat-error").waitFor({ state: "visible", timeout: 5000 });
    check(/0 以上の数として読めません/.test(await page.getByTestId("roifeat-error").innerText()), "負例: 負の値は送らずに理由を出す");
    await page.getByTestId("roifeat-scales").fill("0, 2, 3");
    await page.locator("select").filter({ hasText: "等方" }).first().selectOption("iso");
    await page.getByTestId("roifeat-run").click();
    const seen: string[] = [];
    for (let i = 0; i < 600 && (await page.getByTestId("roifeat-table").count()) === 0; i++) {
      if (await page.getByTestId("roifeat-scale-progress").count()) seen.push(await page.getByTestId("roifeat-scale-progress").innerText());
      await page.waitForTimeout(100);
    }
    await page.getByTestId("roifeat-table").waitFor({ state: "visible", timeout: 180_000 });
    console.log(`  進み具合の表示: ${JSON.stringify([...new Set(seen)])}`);
    if (seen.length > 0) check(seen.some((x) => /スケール \d \/ 3（r [023] mm）/.test(x)), "進み具合に「スケール i / 3（r mm）」が出る", seen);
    else console.log("  [未達] 進み具合は計算が速く、表示を捉えられなかった（合格には数えない）");
    check((await page.getByTestId("roifeat-scale-tabs").locator("button").count()) === 3, "スケールのタブが 3 つ");
    await page.waitForTimeout(500);
    await page.getByTestId("roifeat-scale-tabs").evaluate((el) => el.scrollIntoView({ block: "start" }));
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT_DIR, "01-tab-r0.png"), fullPage: false });
    const info0 = await page.getByTestId("roifeat-scale-info").innerText();
    check(/r 0 mm・フィルタなし/.test(info0), "r=0 のタブの説明", info0);
    check((await page.getByTestId("roifeat-table").locator('td[title^="log_sigma"]').count()) === 0, "r=0 のタブに LoG の列は無い");
    await page.getByTestId("roifeat-scale-tab-2").click();
    await page.waitForTimeout(500);
    const info2 = await page.getByTestId("roifeat-scale-info").innerText();
    check(/LoG r 3 mm → σ 1\.7321 mm（3D の単位）・2\.1213 mm（2D の単位）・σ = r\/√d/.test(info2), "r=3 のタブの換算の説明", info2);
    const heads = await page.getByTestId("roifeat-table").locator("td[colspan]").allInnerTexts();
    check(heads.some((h) => h.includes("LoG σ 1.7321 mm")), "r=3 のタブに LoG σ 1.7321 mm の塊", heads.slice(0, 40));
    await page.getByTestId("roifeat-table").locator('td[title="log_sigma1.7321mm_IntensityBasedStatistical_Mean"]').first().evaluate((el) => el.scrollIntoView({ block: "center" }));
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(OUT_DIR, "02-tab-r3.png"), fullPage: false });

    await page.evaluate("window.__roiDownloads = []");
    await page.getByTestId("roifeat-csv").click();
    for (let i = 0; i < 100 && ((await page.evaluate("window.__roiDownloads.length")) as number) < 2; i++) await page.waitForTimeout(100);
    const by = Object.fromEntries(((await page.evaluate("window.__roiDownloads")) as { name: string; text: string }[]).map((x) => [x.name, x.text]));
    const csv = parseCsv(by["log-case-seg0.csv"] ?? "");
    check(csv.rows.length === 3, "CSV はスケールごとに 1 行（3 行）", csv.rows.length);
    const col = (name: string, r: number) => csv.rows[r][csv.header.indexOf(name)];
    check(csv.header.includes("Filter_Kind") && [0, 1, 2].map((r) => col("Filter_Kind", r)).join() === "none,LoG,LoG", "Filter_Kind が none, LoG, LoG");
    check([0, 1, 2].map((r) => col("Filter_ScaleMm", r)).join() === "0,2,3" && col("Filter_SigmaMm", 2) === "1.7321" && col("Filter_Dimension", 2) === "3D"
      && col("Filter_Boundary", 2) === "MIRROR" && col("Filter_SigmaMm", 0) === "", "フィルタの列（r=0 は σ なしで空）");
    let worst = 0;
    let n = 0;
    for (let r = 0; r < 3; r++) {
      for (const row of refScales[r].result.rows) {
        const i = csv.header.indexOf(row.column);
        if (i < 0) { worst = Infinity; break; }
        const got = csv.rows[r][i] === "NaN" ? null : Number(csv.rows[r][i]);
        if ((got == null) !== (row.value == null)) { worst = Infinity; break; }
        if (got != null) worst = Math.max(worst, Math.abs(got - row.value!));
        n++;
      }
    }
    check(n > 300 && worst === 0, `CSV は API と全 ${n} 値で差 0（3 スケール）`, worst);
    check([0, 1, 2].every((r) => col("Provenance_SettingsSha256", r) === (refScales[r].result as unknown as { provenance: { settingsSha256: string } }).provenance.settingsSha256),
      "各行の設定のハッシュが API のスケールごとの値と一致");
    check(csv.rows[0][csv.header.indexOf("log_sigma1.7321mm_IntensityBasedStatistical_Mean")] === "", "そのスケールに無い列は空（0 ではない）");
    await page.evaluate("window.__roiDownloads = []");
    await page.getByTestId("roifeat-settings-file").click();
    for (let i = 0; i < 50 && ((await page.evaluate("window.__roiDownloads.length")) as number) < 3; i++) await page.waitForTimeout(100);
    const props = (await page.evaluate("window.__roiDownloads")) as { name: string; text: string }[];
    check(props.map((p) => p.name).sort().join() === "log-case-seg0-r0_radiomicsj.properties,log-case-seg0-r2_radiomicsj.properties,log-case-seg0-r3_radiomicsj.properties", "設定ファイルがスケールごとに 3 本", props.map((p) => p.name));
    check([0, 1, 2].every((r) => props.find((p) => p.name === `log-case-seg0-r${[0, 2, 3][r]}_radiomicsj.properties`)?.text === refScales[r].result.settingsProperties), "設定ファイルは API の設定と一字も違わない");

    // キャッシュ: 「0, 2, 3」の直後の「0, 2, 3, 4」
    // 前回の実行のキャッシュ（ディスクに残る）に当たらないよう、4 番目の半径は実行ごとに変える
    const fresh = (4 + (Date.now() % 1000) / 1000).toFixed(3).replace(/0+$/, "");
    console.log(`  4 番目の半径: ${fresh}`);
    await page.getByTestId("roifeat-scales").fill(`0, 2, 3, ${fresh}`);
    await page.getByTestId("roifeat-run").click();
    await page.getByTestId("roifeat-scale-tabs").locator("button").nth(3).waitFor({ state: "visible", timeout: 180_000 });
    await page.waitForTimeout(500);
    const pills: string[] = [];
    for (let i = 0; i < 4; i++) {
      await page.getByTestId(`roifeat-scale-tab-${i}`).click();
      await page.waitForTimeout(300);
      pills.push((await page.getByTestId("roifeat-summary").innerText()).includes("キャッシュ") ? "cache" : "new");
    }
    check(pills.join() === "cache,cache,cache,new", "0・2・3 はキャッシュから、4 だけ新しく計算", pills);
    await page.screenshot({ path: path.join(OUT_DIR, "03-cache.png"), fullPage: false });

    // ── 走査・幅（画素）・名札 ──
    console.log("[3] 走査と幅（画素）");
    const list = page.getByTestId("roifeat-scale-list");
    await page.getByTestId("roifeat-scales").fill("1:2:0.5");
    await list.filter({ hasText: "計算するスケール（3 個）" }).waitFor({ timeout: 5000 });
    const listText = await list.innerText();
    check(/r 1 mm → σ 0\.5774 mm/.test(listText) && /r 1\.5 mm/.test(listText) && /r 2 mm → σ 1\.1547 mm（3D の単位）・1\.4142 mm（2D の単位）/.test(listText),
      "走査 1:2:0.5 の一覧に 3 個と σ（3D・2D）が計算の前に出る", listText);
    await page.getByTestId("roifeat-scales").fill("1:3:0");
    await page.getByTestId("roifeat-scale-spec-error").waitFor({ timeout: 5000 });
    check(/刻みは 0 より大きく/.test(await page.getByTestId("roifeat-scale-spec-error").innerText()), "負例: 刻み 0 は一覧のところで理由が出る");
    await page.getByTestId("roifeat-scales").fill("3:1:0.5");
    check(/終了が開始より小さく/.test(await page.getByTestId("roifeat-scale-spec-error").innerText()), "負例: 終了 < 開始は理由が出る");
    await page.getByTestId("roifeat-run").click();
    await page.getByTestId("roifeat-error").filter({ hasText: /終了が開始より小さく/ }).waitFor({ timeout: 5000 });
    check(true, "負例: 不正な走査は計算を始めずにエラーで止まる");

    await page.getByTestId("roifeat-scale-notation").selectOption("WIDTH_PX");
    await page.getByTestId("roifeat-scales").fill("4, 6, 12");
    await page.getByTestId("roifeat-scale-labels").fill("1.0, 1.5, 2.5");
    await list.filter({ hasText: "計算するスケール（3 個）" }).waitFor({ timeout: 5000 });
    const wl = await list.innerText();
    check(/幅 4 画素/.test(wl) && /（名札 1\.0）/.test(wl) && /（名札 2\.5）/.test(wl), "幅（画素）の一覧に名札が出る", wl);
    check(/画素の大きさが違う画像どうしでは同じ長さになりません/.test(await page.getByTestId("roifeat-scale-width-note").innerText()), "幅（画素）の注記が出る");
    await page.getByTestId("roifeat-scale-labels").fill("1.0");
    await page.getByTestId("roifeat-run").click();
    await page.getByTestId("roifeat-error").filter({ hasText: /名札の数が値の数（3）と合いません/ }).waitFor({ timeout: 5000 });
    check(true, "負例: 名札の数が合わなければ送らずに理由を出す");
    await page.getByTestId("roifeat-scale-labels").fill("1.0, 1.5, 2.5");
    await page.getByTestId("roifeat-run").click();
    await page.getByTestId("roifeat-scale-tabs").locator("button").nth(2).waitFor({ state: "visible", timeout: 180_000 });
    await page.waitForTimeout(500);
    const tabs = await page.getByTestId("roifeat-scale-tabs").locator("button").allInnerTexts();
    check(tabs.join("|") === "幅 4（r 1.4）（名札 1.0）|幅 6（r 2.1）（名札 1.5）|幅 12（r 4.2）（名札 2.5）", "タブに幅・換算後の r・名札（0.7 mm × 幅 / 2）", tabs);
    const infoW = await page.getByTestId("roifeat-scale-info").innerText();
    check(/指定: 幅 4 画素 × 画素間隔 0\.7 mm \/ 2 = r 1\.4 mm/.test(infoW), "タブの説明に画素間隔と換算", infoW);
    await page.getByTestId("roifeat-scale-tabs").evaluate((el) => el.scrollIntoView({ block: "start" }));
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT_DIR, "04-width-tabs.png"), fullPage: false });

    const wApi = await runJob(base, { ...req({ ...ISO }), scales: [4, 6, 12], scaleNotation: "WIDTH_PX", scaleLabels: ["1.0", "1.5", "2.5"] });
    const WS = (wApi.result as unknown as { scales: { scaleMm: number; inputNotation: string; inputValue: number; pixelSpacingMm: number | null; legacyLabel: string | null; result: Result }[] }).scales;
    check(WS.map((x) => x.scaleMm).join() === "1.4,2.1,4.2" && WS.every((x) => x.inputNotation === "width_px" && x.pixelSpacingMm === 0.7), "API: 幅 4・6・12 画素 → r 1.4・2.1・4.2 mm", WS.map((x) => x.scaleMm));
    // 同じ r を半径（mm）で直接指定した計算と全特徴ビット一致（別の recompute で計算し直す）
    const rApi = await runJob(base, { ...req({ ...ISO }), scales: [1.4, 2.1, 4.2] });
    const RS = (rApi.result as unknown as { scales: { result: Result }[] }).scales;
    let same = true;
    for (let i = 0; i < 3; i++) {
      same = same && WS[i].result.rows.length === RS[i].result.rows.length
        && WS[i].result.rows.every((x, j) => RS[i].result.rows[j].column === x.column && RS[i].result.rows[j].value === x.value);
    }
    check(same, "幅で指定した計算が、同じ r の直接指定と全特徴一致（recompute で別々に計算）");

    await page.evaluate("window.__roiDownloads = []");
    await page.getByTestId("roifeat-csv").click();
    for (let i = 0; i < 100 && ((await page.evaluate("window.__roiDownloads.length")) as number) < 2; i++) await page.waitForTimeout(100);
    const by2 = Object.fromEntries(((await page.evaluate("window.__roiDownloads")) as { name: string; text: string }[]).map((x) => [x.name, x.text]));
    const csv2 = parseCsv(by2["log-case-seg0.csv"] ?? "");
    const c2 = (name: string, r: number) => csv2.rows[r][csv2.header.indexOf(name)];
    check([0, 1, 2].map((r) => c2("Filter_InputNotation", r)).join() === "width_px,width_px,width_px"
      && [0, 1, 2].map((r) => c2("Filter_InputValue", r)).join() === "4,6,12"
      && [0, 1, 2].map((r) => c2("Filter_PixelSpacingMm", r)).join() === "0.7,0.7,0.7"
      && [0, 1, 2].map((r) => c2("Filter_LegacyLabel", r)).join() === "1.0,1.5,2.5"
      && [0, 1, 2].map((r) => c2("Filter_ScaleMm", r)).join() === "1.4,2.1,4.2", "CSV: 入力の書き方・値・画素間隔・名札・換算後の r");
    let worst2 = 0;
    let n2 = 0;
    for (let r = 0; r < 3; r++) {
      for (const row of WS[r].result.rows) {
        const i = csv2.header.indexOf(row.column);
        const got = csv2.rows[r][i] === "NaN" ? null : Number(csv2.rows[r][i]);
        if (i < 0 || (got == null) !== (row.value == null)) { worst2 = Infinity; break; }
        if (got != null) worst2 = Math.max(worst2, Math.abs(got - row.value!));
        n2++;
      }
    }
    check(n2 > 300 && worst2 === 0, `幅（画素）の CSV は API と全 ${n2} 値で差 0`, worst2);
    console.log("  [未達] 縦横の画素間隔が違う画像での幅の拒否は実機では確かめていない（合成 CT は正方画素。backend の単体試験で確認）");
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
