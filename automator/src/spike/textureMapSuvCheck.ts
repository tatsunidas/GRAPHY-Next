/*
 * テクスチャのマップと GLAM 解析が、PET を SUVbw に校正してから計算することの実機検証スパイク（実データの PET）。
 *
 * 実行:  cd automator && GRAPHY_AUTOMATOR_HTTP_PORT=21090 GRAPHY_AUTOMATOR_SCP_PORT=21091 GRAPHY_AUTOMATOR_VITE_PORT=21093 \
 *          AUTOMATOR_DATA_DIR=$PWD/.results/run-data/texture-map-suv timeout 1800 npx tsx src/spike/textureMapSuvCheck.ts
 *   前提: backend jar を今のコードで作り直してある（mvn clean package）。~/graphy-demo-samples/PSMA_...（実 PET と腫瘍の SEG）。
 *
 * 参照は textureMapSuvRef.py（pydicom + numpy だけ。本体のコードを使わない）。
 *   A. 既定のまま（calibration を送らない）で FIRSTORDER_Mean のマップ（カーネル 3・3D・margin 0・腫瘍の SEG）を作り、
 *      保存された派生シリーズの画素（保存値 × RescaleSlope + RescaleIntercept）が、DICOM から読み直した SUVbw の画素の
 *      「窓 ∩ ROI」の平均と、16 bit 量子化の誤差（slope の半分）の範囲で一致する。係数は Python の式の値と一致する。
 *   B. none のマップは Bq/mL の参照と一致する。負例: 誤った係数の参照（auto に 1.0、none に SUV の係数）では一致しない。
 *   C. GLAM 解析（API）: 固定ビン数は auto と none で同じ離散化、固定ビン幅は同じ数値なら違い、単位を換算した幅なら同じ。
 *      ビン数・ビンごとのボクセル数は Python の予想と突き合わせる。
 *   D. 不正な calibration は断られる（API は 400、ジョブは FAILED）。
 *   E. 画面: PET のとき「校正（PET）」の欄が出て、CT のとき出ない（スクリーンショット）。GLAM 解析の画面は既定のまま通し、値の単位が出る。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { openFirstSeriesInViewer } from "../checklist/items/shared/helpers.js";
import { createStepRecorder } from "../checklist/types.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { PY, PY_FLAGS } from "./pythonCmd.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "texture-map-suv-check");
const PSMA = path.join(os.homedir(), "graphy-demo-samples", "PSMA_0198cdca94fbb95f", "PET", "CT whole-body PSMA");
const REF = path.join(import.meta.dirname, "textureMapSuvRef.py");
const JAR = path.resolve(AUTOMATOR_ROOT, "..", "backend", "target", "graphy-next-backend.jar");

const failures: string[] = [];
let passed = 0;
function check(cond: boolean, label: string, detail?: unknown): void {
  if (cond) { passed++; console.log(`  [ok  ] ${label}`); } else { console.log(`  [FAIL] ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`); failures.push(label); }
}
const py = (args: string[]): any => {
  const r = spawnSync(PY, [...PY_FLAGS, REF, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`python ${args[0]}: ${r.stderr}`);
  return JSON.parse(r.stdout);
};
async function call<T>(base: string, p: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(`${base}${p}`, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!res.ok) throw new Error(`${method} ${p} → HTTP ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}
async function status(base: string, p: string, body: unknown): Promise<{ status: number; text: string }> {
  const res = await fetch(`${base}${p}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, text: await res.text() };
}

interface Series { seriesInstanceUid: string; modality: string | null; seriesDescription: string | null }
interface MapDone { seriesInstanceUid: string; sopInstanceUids: string[] }
interface Glam { nBins: number; binOccupancy: number[]; features: Record<string, number | null>; valueUnit?: string | null; calibration?: string | null }

async function runMap(base: string, req: Record<string, unknown>): Promise<MapDone> {
  const job = await call<{ jobId: string }>(base, "/api/series/texture/jobs", "POST", req);
  for (let i = 0; i < 1800; i++) {
    const st = await call<{ state: string; result?: MapDone; error?: string }>(base, `/api/series/texture/jobs/${job.jobId}`, "GET");
    if (st.state === "DONE" && st.result) return st.result;
    if (st.state === "FAILED" || st.state === "CANCELLED") throw new Error(`job ${st.state}: ${st.error}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("ジョブが終わらない");
}
async function download(base: string, sops: string[], dir: string): Promise<void> {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const sop of sops) {
    const res = await fetch(`${base}/api/instances/${sop}/file`);
    if (!res.ok) throw new Error(`download ${sop}: HTTP ${res.status}`);
    fs.writeFileSync(path.join(dir, `${sop}.dcm`), Buffer.from(await res.arrayBuffer()));
  }
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  if (!fs.existsSync(PSMA)) {
    console.log(`  [未達] 実データが無い: ${PSMA}`);
    process.exitCode = 2;
    return;
  }
  // jar が今のコードか（変更前の jar を掴んでいないか）
  const jarHas = spawnSync("unzip", ["-p", JAR, "BOOT-INF/classes/com/vis/graphynext/radiomics/TextureSeriesRequest.class"], { maxBuffer: 16 * 1024 * 1024 });
  check(jarHas.status === 0 && jarHas.stdout.includes("calibrationOrAuto"), "jar は今のコード（TextureSeriesRequest に calibrationOrAuto がある）", { mtime: fs.statSync(JAR).mtime });

  const stats = py(["stats", PSMA]);
  console.log(`  参照: SUVbw の係数 ${stats.scale}、ROI ${stats.roiVoxels} ボクセル、Bq/mL ${stats.bqMin}〜${stats.bqMax.toFixed(1)}、Series Time を使用=${stats.usedSeriesTime}`);
  check(Math.abs(stats.scale - 0.0006863604463884588) < 0.0006863604463884588 * 1e-12, "参照の係数は SUV の golden の値と一致");

  const d = new DesktopDriver();
  await d.start();
  const base = `http://127.0.0.1:${d.ports.http}`;
  try {
    await resetDb(d.ports.http);
    await importPaths(d.ports.http, [PSMA]);
    const studies = await call<{ studyInstanceUid: string }[]>(base, "/api/studies", "GET");
    const studyUid = studies[0].studyInstanceUid;
    const series = await call<Series[]>(base, `/api/studies/${studyUid}/series`, "GET");
    console.log(`  シリーズ: ${series.map((s) => `${s.modality}`).join(", ")}`);
    const pet = series.find((s) => s.modality === "PT");
    const seg = series.find((s) => s.modality === "SEG");
    const ct = series.find((s) => s.modality === "CT");
    check(!!pet && !!seg && !!ct, "PET・SEG・CT のシリーズがある", series.map((s) => s.modality));
    if (!pet || !seg || !ct) throw new Error("シリーズが足りない");

    const mapReq = (extra: Record<string, unknown>, description: string) => ({
      studyInstanceUid: studyUid, sourceSeriesUid: pet.seriesInstanceUid, maskSeriesUid: seg.seriesInstanceUid, maskChannel: 0,
      feature: "FIRSTORDER_Mean", filterSize: 3, stride: 1, force2D: false, channel: 0, timePoint: 0, settings: { MASK_LABEL_INT: "1" },
      margin: 0, seriesDescription: description, seriesNumber: null, ...extra,
    });

    console.log("\n[A] 既定のまま（calibration を送らない）: マップの値が、独立に計算した SUVbw の窓平均と一致");
    const auto = await runMap(base, mapReq({}, "map default"));
    await download(base, auto.sopInstanceUids, path.join(OUT_DIR, "map-auto"));
    const a = py(["map", PSMA, path.join(OUT_DIR, "map-auto"), "3", String(stats.scale)]);
    console.log(`  ${JSON.stringify(a)}`);
    check(a.instances === stats.volumeShape[0] && a.roiVoxels === stats.roiVoxels, "派生シリーズの枚数と ROI のボクセル数", { instances: a.instances });
    check(a.maxAbsDiff <= 0.51 * a.slope + 2e-7 * a.refMax, "既定のマップ = SUVbw の窓平均（誤差は slope の半分以内）", { maxAbsDiff: a.maxAbsDiff, slope: a.slope, over: a.maxAbsDiffOverSlope });
    check(a.refMax > 1 && a.refMax < 100, "値の桁が SUV（Bq/mL の桁ではない）", a.refMax);
    const m = /calibration=bw;scale=([0-9.eE+-]+)/.exec(a.derivation ?? "");
    check(!!m && Math.abs(Number(m[1]) - stats.scale) < stats.scale * 1e-9, "DerivationDescription に校正（bw・係数）が残る", a.derivation);
    check(a.outsideRoiNonZero === 0, "ROI の外は 0");
    const wrongA = py(["map", PSMA, path.join(OUT_DIR, "map-auto"), "3", "1.0"]);
    check(wrongA.maxAbsDiff > 100 * (0.51 * a.slope), "負例: 既定のマップを Bq/mL の参照（係数 1）と比べると一致しない", { maxAbsDiff: wrongA.maxAbsDiff });

    console.log("\n[B] none のマップは Bq/mL の参照と一致し、auto とは係数だけ違う");
    const none = await runMap(base, mapReq({ calibration: "none" }, "map none"));
    await download(base, none.sopInstanceUids, path.join(OUT_DIR, "map-none"));
    const n = py(["map", PSMA, path.join(OUT_DIR, "map-none"), "3", "1.0"]);
    console.log(`  ${JSON.stringify(n)}`);
    check(n.maxAbsDiff <= 0.51 * n.slope + 2e-7 * n.refMax, "none のマップ = Bq/mL の窓平均（従来と同じ値）", { maxAbsDiff: n.maxAbsDiff, slope: n.slope });
    check(/calibration=none;scale=1(\.0)?;uncalibratedPet/.test(n.derivation ?? ""), "DerivationDescription に「校正なし」が残る", n.derivation);
    const wrongN = py(["map", PSMA, path.join(OUT_DIR, "map-none"), "3", String(stats.scale)]);
    check(wrongN.maxAbsDiff > 100 * (0.51 * n.slope), "負例: none のマップを SUV の参照と比べると一致しない", { maxAbsDiff: wrongN.maxAbsDiff });
    check(Math.abs(n.gotMean * stats.scale - a.gotMean) <= 0.01 * a.gotMean, "ROI 平均の比 auto/none = 係数（1% 以内）", { ratio: a.gotMean / n.gotMean, scale: stats.scale });

    console.log("\n[C] GLAM 解析（API）: 固定ビン数は同じ、固定ビン幅は単位で変わる");
    const glam = (settings: Record<string, string>, calibration?: string) => call<Glam>(base, "/api/radiomics/glam/analyze", "POST", {
      studyInstanceUid: studyUid, sourceSeriesUid: pet.seriesInstanceUid, maskSeriesUid: seg.seriesInstanceUid, maskChannel: 0, channel: 0, timePoint: 0,
      maxRadius: 3, settings: { MASK_LABEL_INT: "1", ...settings }, ...(calibration === undefined ? {} : { calibration }),
    });
    const cnt = { BINCOUNT_GLAM_BOOL: "true", BINCOUNT_GLAM_INT: "16" };
    const refCnt = py(["glam", PSMA, String(stats.scale), "16", "SUV", "1"]);
    const gAuto = await glam(cnt);
    const gNone = await glam(cnt, "none");
    check(gAuto.valueUnit === "SUVbw" && /^bw;scale=/.test(gAuto.calibration ?? ""), "既定: 値の単位 SUVbw・校正の記録あり", { u: gAuto.valueUnit, c: gAuto.calibration });
    check(gNone.valueUnit === "BQML（未校正）", "none: 値の単位 BQML（未校正）", gNone.valueUnit);
    check(gAuto.nBins === 16 && gNone.nBins === 16, "固定ビン数 16: auto・none とも 16 ビン", { a: gAuto.nBins, n: gNone.nBins });
    const occDiff = (x: number[], y: number[]) => x.reduce((s, v, i) => s + Math.abs(v - (y[i] ?? 0)), 0);
    check(occDiff(gAuto.binOccupancy, refCnt.occCount) === 0 && occDiff(gNone.binOccupancy, refCnt.occCount) === 0,
      "固定ビン数: ビンごとのボクセル数が auto・none とも Python の予想と同じ", { auto: gAuto.binOccupancy, none: gNone.binOccupancy, ref: refCnt.occCount });
    const featDiff = Object.entries(gNone.features).filter(([k, v]) => v !== null && gAuto.features[k] !== null &&
      Math.abs((gAuto.features[k] as number) - (v as number)) > 1e-9 * Math.max(1e-12, Math.abs(v as number))).length;
    check(featDiff === 0, "固定ビン数: 特徴量が auto と none で全て同じ（1e-9）", { differing: featDiff });

    const widthBq = Math.ceil((stats.bqMax - stats.bqMin) / 18);
    const widthSuv = widthBq * stats.scale;
    const refW = py(["glam", PSMA, String(stats.scale), "16", "Bq", String(widthBq)]);
    const wNone = await glam({ BINCOUNT_GLAM_BOOL: "false", BINWIDTH_GLAM_DOUBLE: String(widthBq) }, "none");
    const wAutoEquiv = await glam({ BINCOUNT_GLAM_BOOL: "false", BINWIDTH_GLAM_DOUBLE: String(widthSuv) });
    const wAutoSame = await glam({ BINCOUNT_GLAM_BOOL: "false", BINWIDTH_GLAM_DOUBLE: String(widthBq) });
    console.log(`  幅 ${widthBq} Bq/mL（= ${widthSuv.toFixed(6)} SUV）: 予想 ${refW.nBinsWidth} ビン。none=${wNone.nBins}・auto（換算した幅）=${wAutoEquiv.nBins}・auto（同じ数値の幅）=${wAutoSame.nBins}`);
    check(wNone.nBins === refW.nBinsWidth && occDiff(wNone.binOccupancy, refW.occWidth) === 0, "固定ビン幅（none）: ビン数・ビンごとのボクセル数が Python の予想と同じ", { got: wNone.binOccupancy, ref: refW.occWidth });
    check(wAutoEquiv.nBins === wNone.nBins && occDiff(wAutoEquiv.binOccupancy, wNone.binOccupancy) === 0, "固定ビン幅: 単位を換算した幅なら auto と none は同じ離散化", { a: wAutoEquiv.binOccupancy, n: wNone.binOccupancy });
    check(wAutoSame.nBins !== wNone.nBins, "負例: 同じ数値の幅は auto（SUV）と none（Bq/mL）で別の離散化になる", { auto: wAutoSame.nBins, none: wNone.nBins });

    console.log("\n[D] 不正な calibration は断られる");
    const badGlam = await status(base, "/api/radiomics/glam/analyze", { studyInstanceUid: studyUid, sourceSeriesUid: pet.seriesInstanceUid, maskSeriesUid: seg.seriesInstanceUid, maskChannel: 0, channel: 0, timePoint: 0, maxRadius: 3, settings: {}, calibration: "suv" });
    check(badGlam.status === 400 && badGlam.text.includes("calibration"), "GLAM 解析: HTTP 400", { s: badGlam.status, t: badGlam.text.slice(0, 120) });
    const badMap = await status(base, "/api/series/texture", mapReq({ calibration: "suv" }, "bad"));
    check(badMap.status === 400, "マップ（同期）: HTTP 400", { s: badMap.status, t: badMap.text.slice(0, 120) });
    const badJob = await runMap(base, mapReq({ calibration: "suv" }, "bad")).then(() => "DONE", (e: Error) => String(e.message));
    check(badJob.startsWith("job FAILED") && badJob.includes("calibration"), "マップ（ジョブ）: FAILED と理由", badJob);

    console.log("\n[E] 画面（Electron）");
    const mainPage = d.page;
    await mainPage.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    await mainPage.waitForTimeout(2000);
    const later = mainPage.getByRole("button", { name: /^(後で|Later)$/ });
    if (await later.isVisible().catch(() => false)) await later.click();
    await mainPage.evaluate("localStorage.setItem('graphy.locale', 'ja')");
    await openFirstSeriesInViewer(mainPage, createStepRecorder());
    const viewer = await d.waitForNewPage(() => mainPage.getByTestId("viewer2d-toolbar-button").click(), (url) => url.includes("2dviewer"));
    await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 20_000 });
    await viewer.waitForTimeout(2000);
    await viewer.getByTestId("viewer2d-menu-analysis").click();
    await viewer.getByText(/^テクスチャ…$|^Texture…$/).click();
    // ダイアログのターゲット欄（ビューアの他の select にも同じシリーズが載るので、DOM の最後＝重なっているダイアログ）
    const target = viewer.locator(`select:has(option[value="${pet.seriesInstanceUid}"])`).last();
    await target.waitFor({ state: "visible", timeout: 10_000 });
    await viewer.waitForTimeout(1500);
    await target.selectOption(pet.seriesInstanceUid);
    await viewer.waitForTimeout(800);
    const field = viewer.getByTestId("texture-calibration");
    check(await field.isVisible(), "画面: PET のとき「校正（PET）」の欄が出る");
    check((await field.inputValue()) === "auto", "画面: 欄の既定は auto");
    check((await viewer.getByTestId("texture-calibration-none-warn").count()) === 0, "画面: 既定では注意文は出ない");
    await viewer.screenshot({ path: path.join(OUT_DIR, "ui-01-texture-pet.png") });
    await field.selectOption("none");
    await viewer.waitForTimeout(500);
    check(await viewer.getByTestId("texture-calibration-none-warn").isVisible(), "画面: 校正しないを選ぶと注意文が出る");
    await viewer.screenshot({ path: path.join(OUT_DIR, "ui-02-texture-pet-none.png") });
    await target.selectOption(ct.seriesInstanceUid);
    await viewer.waitForTimeout(800);
    check((await viewer.getByTestId("texture-calibration").count()) === 0, "画面: CT のとき欄が出ない");
    await viewer.screenshot({ path: path.join(OUT_DIR, "ui-03-texture-ct.png") });

    await viewer.keyboard.press("Escape");
    await viewer.getByRole("button", { name: /^(キャンセル|Cancel)$/ }).click().catch(() => {});
    await viewer.bringToFront();
    await viewer.getByTestId("viewer2d-menu-analysis").click();
    const glamPage = await d.waitForNewPage(() => viewer.getByText(/^GLAM 解析…$|^GLAM analysis…$/).click(), (url) => url.includes("#glam"));
    await glamPage.waitForTimeout(2000);
    await glamPage.locator("select").nth(0).selectOption(pet.seriesInstanceUid);
    await glamPage.waitForTimeout(800);
    check(await glamPage.getByTestId("glam-calibration").isVisible(), "画面（GLAM）: PET のとき校正の欄が出る");
    check((await glamPage.getByTestId("glam-calibration").inputValue()) === "auto", "画面（GLAM）: 欄の既定は auto（以降、欄は操作しない）");
    await glamPage.locator("select").nth(2).selectOption(seg.seriesInstanceUid); // 0=ターゲット・1=校正・2=マスク
    await glamPage.waitForTimeout(800);
    await glamPage.getByRole("button", { name: /^(解析|Analyze)$/ }).click();
    await glamPage.getByTestId("glam-value-unit").waitFor({ state: "visible", timeout: 300_000 });
    const unitText = await glamPage.getByTestId("glam-value-unit").innerText();
    check(unitText.includes("SUVbw"), "画面（GLAM）: 結果に値の単位 SUVbw が出る", unitText);
    await glamPage.screenshot({ path: path.join(OUT_DIR, "ui-04-glam-pet.png") });
  } finally {
    await d.stop();
  }
  console.log(`\n結果: 合格 ${passed} / 失敗 ${failures.length} / 未達 0`);
  if (failures.length) { console.log(failures.map((x) => `  - ${x}`).join("\n")); process.exitCode = 1; }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
