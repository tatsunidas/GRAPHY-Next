/*
 * 定義の形式まとめ（QC のスキップ・画素間隔の無い画像・詳細設定・リサンプリングの既定 1 mm）の実機検証スパイク（API）。
 *
 * 実行:  cd automator && GRAPHY_AUTOMATOR_HTTP_PORT=20690 GRAPHY_AUTOMATOR_SCP_PORT=20691 GRAPHY_AUTOMATOR_VITE_PORT=20693 \
 *          timeout 1500 npx tsx src/spike/specBundleCheck.ts
 *
 * 合成 CT（画素間隔あり・なし）に箱 2 つ（大・小）の SEG を付け、一括抽出 API を指定を変えて走らせる。
 *   - SKIP: 止めずに最後まで走り、小さい ROI の組は QC_SKIPPED（理由つき）、値は返さず、ほかの組の全列は FLAG のときと差 0。STOP の従来の流れは変わらない。
 *   - 画素間隔なし: 計算でき（失敗しない）、旗 UNCALIBRATED_SPACING が付き、体積は NaN。画素間隔あり: 旗なし・体積あり。
 *   - 詳細設定: INT_deltaGLCM=2 で GLCM だけが変わり、_radiomicsj.properties に残る。知らないキーは理由つきで断る。スキーマの API が既定値を返す。
 *   - リサンプリング: 既定（等方 1 mm）のキーを送ると、なしのときと ROI のボクセル数が変わる。
 * 前提: backend jar（今のビルド）。
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { PY, PY_FLAGS } from "./pythonCmd.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "spec-bundle-check");
const failures: string[] = [];
let passed = 0;
function check(cond: boolean, label: string, detail?: unknown): void {
  if (cond) { passed++; console.log(`  [ok  ] ${label}`); } else { console.log(`  [FAIL] ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`); failures.push(label); }
}
async function call<T>(base: string, p: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(`${base}${p}`, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!res.ok) throw new Error(`${method} ${p} → HTTP ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

interface Frame { sopInstanceUid: string; imagePositionPatient: number[] }
interface Synth { name: string; dir: string; studyInstanceUid: string; seriesInstanceUid: string; frameOfReferenceUID: string; rows: number; columns: number; pixelSpacing: number[]; sliceThickness: number; frames: Frame[] }
interface Box { r0: number; r1: number; c0: number; c1: number; z0: number; z1: number }
const BIG: Box = { r0: 12, r1: 36, c0: 10, c1: 34, z0: 3, z1: 13 }; // 24x24x10 = 5760 ボクセル
const SMALL: Box = { r0: 30, r1: 40, c0: 36, c1: 46, z0: 5, z1: 9 }; // 10x10x4 = 400 ボクセル
const THRESHOLD = 1000; // 小さい ROI の基準値: SmallBox（400）は当たり、BigBox（5760）は当たらない

function boxFrames(s: Synth, b: Box) {
  return s.frames.map((f, z) => {
    if (z < b.z0 || z >= b.z1) return { ...f, mask: "" };
    const m = Buffer.alloc(s.rows * s.columns);
    for (let r = b.r0; r < b.r1; r++) for (let c = b.c0; c < b.c1; c++) m[r * s.columns + c] = 1;
    return { ...f, mask: m.toString("base64") };
  });
}

interface Pair { studyUid: string; sourceSeriesUid: string | null; maskSeriesUid: string; maskChannel: number; segmentLabel: string | null; [k: string]: unknown }
interface Row { column: string; value: number | null }
interface Result { rows: Row[]; provenance: { recordFlags?: string[] }; roiSize: { volumeMm3: number | null; intensityVoxels: number | null; morphVoxels: number | null }; settingsProperties: string }
interface PairStatus { index: number; state: string; error: string | null; qcFlags: string[]; pair: Pair }
interface Status { state: string; stopKind: string | null; stopIndex: number | null; done: number; failed: number; notRun: number; qcSkipped: number; pairs: PairStatus[] }
interface PairResult { index: number; result: Result }

async function runJob(base: string, pairs: Pair[], opts: { qc?: { smallRoi: string; lossy: string } | null; settings?: Record<string, string>; ack?: string[] } = {}): Promise<{ status: Status; results: PairResult[] }> {
  const settings: Record<string, string> = {
    BOOL_USE_FixedBinNumber: "1", INT_binCount: "32", BOOL_enableMorphological: "0", BOOL_enableLocalIntensityFeatures: "0",
    BOOL_enableIntensityBasedStatistics: "1", BOOL_enableIntensityHistogram: "0", BOOL_enableIntensityVolumeHistogram: "0", BOOL_enableShape2D: "0",
    BOOL_enableGLCM: "1", BOOL_enableGLRLM: "0", BOOL_enableGLSZM: "0", BOOL_enableGLDZM: "0", BOOL_enableNGTDM: "0", BOOL_enableNGLDM: "0",
    BOOL_enableFractal: "0", BOOL_enableGLAM: "0", BOOL_enableAuxiliaryStatistics: "0", ...(opts.settings ?? {}),
  };
  const job = await call<{ jobId: string }>(base, "/api/radiomics/batch/jobs", "POST", {
    pairs, settings, roiModes: ["WHOLE_3D"], scales: null, scaleNotation: null, scaleLabels: null, scaleConversion: null, scaleCoefficient: null,
    channel: 0, timePoint: 0, recompute: true, qc: opts.qc ?? null, qcAcknowledged: opts.ack ?? null, smallRoiWarnVoxels: THRESHOLD, kind: null,
    calibration: "auto", valueSpec: null,
  });
  let status: Status;
  for (let i = 0; ; i++) {
    status = await call<Status>(base, `/api/radiomics/batch/jobs/${job.jobId}`, "GET");
    if (["DONE", "STOPPED", "CANCELLED"].includes(status.state)) break;
    if (i > 900) throw new Error("ジョブが終わらない");
    await new Promise((r) => setTimeout(r, 500));
  }
  return { status, results: await call<PairResult[]>(base, `/api/radiomics/batch/jobs/${job.jobId}/results`, "GET") };
}
const val = (r: Result, col: string): number | null => r.rows.find((x) => x.column === col)?.value ?? null;
const sameRows = (a: Result, b: Result): boolean => a.rows.length === b.rows.length && a.rows.every((x, i) => x.column === b.rows[i].column && Object.is(x.value ?? NaN, b.rows[i].value ?? NaN));

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const parent = path.join(OUT_DIR, "synth");
  fs.rmSync(parent, { recursive: true, force: true });
  fs.mkdirSync(parent, { recursive: true });
  const sy = spawnSync(PY, [...PY_FLAGS, path.join(import.meta.dirname, "specBundleSynth.py"), parent, String(Date.now() % 1_000_000)], { encoding: "utf8" });
  if (sy.status !== 0) throw new Error(`合成データを作れません: ${sy.stderr}`);
  const synth = JSON.parse(sy.stdout) as Record<string, Synth>;
  const d = new DesktopDriver();
  await d.start();
  const base = `http://127.0.0.1:${d.ports.http}`;
  try {
    await resetDb(d.ports.http);
    for (const s of Object.values(synth)) await importPaths(d.ports.http, [s.dir]);
    for (const s of Object.values(synth)) {
      await call(base, "/api/dicom/seg", "POST", {
        studyInstanceUid: s.studyInstanceUid, seriesInstanceUid: s.seriesInstanceUid, rows: s.rows, columns: s.columns,
        imageOrientationPatient: [1, 0, 0, 0, 1, 0], pixelSpacing: s.pixelSpacing ?? [0.7, 0.7], sliceThickness: s.sliceThickness,
        frameOfReferenceUID: s.frameOfReferenceUID, seriesDescription: "synthetic two-box SEG",
        segments: [
          { number: 1, label: "BigBox", color: [255, 0, 0], description: null, frames: boxFrames(s, BIG) },
          { number: 2, label: "SmallBox", color: [0, 255, 0], description: null, frames: boxFrames(s, SMALL) },
        ], producer: null,
      });
    }
    const album = await call<{ id: number }>(base, "/api/albums", "POST", { name: `spec-bundle-${Date.now()}` });
    await call(base, `/api/albums/${album.id}/studies`, "POST", { studyUids: Object.values(synth).map((s) => s.studyInstanceUid) });
    const plan = await call<Pair[]>(base, "/api/radiomics/batch/plan", "POST", { albumId: album.id, studyUids: null });
    const pairsOf = (name: string): Pair[] => plan.filter((p) => p.studyUid === synth[name].studyInstanceUid && p.sourceSeriesUid).sort((a, b) => a.maskChannel - b.maskChannel);
    const spaced = pairsOf("spaced");
    const nospacing = pairsOf("nospacing");
    check(spaced.length === 2 && nospacing.length === 2, "組の確認: 画素間隔あり 2 組・なし 2 組（BigBox・SmallBox）", plan.map((p) => `${p.segmentLabel}:${String(p.status)}`));

    console.log("\n[1] QC のスキップ");
    const flag = await runJob(base, spaced, { qc: { smallRoi: "FLAG", lossy: "FLAG" } });
    check(flag.status.state === "DONE" && flag.results.length === 2 && flag.status.pairs[1].qcFlags.includes("SMALL_ROI"), "FLAG: 2 組とも値が出て、SmallBox に旗 SMALL_ROI", flag.status.pairs.map((p) => [p.state, p.qcFlags]));
    const skip = await runJob(base, spaced, { qc: { smallRoi: "SKIP", lossy: "FLAG" } });
    check(skip.status.state === "DONE" && skip.status.stopKind === null, "SKIP: 止まらずに DONE", [skip.status.state, skip.status.stopKind]);
    check(skip.status.pairs[0].state === "DONE" && skip.status.pairs[1].state === "QC_SKIPPED" && skip.status.qcSkipped === 1 && skip.status.failed === 0 && skip.status.notRun === 0,
      "SKIP: BigBox は DONE、SmallBox は QC_SKIPPED（1 件）", skip.status.pairs.map((p) => p.state));
    check(/QC でスキップ: 小さい ROI（400 ボクセル ＜ 基準値 1000）/.test(skip.status.pairs[1].error ?? "") && skip.status.pairs[1].qcFlags.includes("SMALL_ROI"), "SKIP: 理由に ROI の大きさと基準値、旗も残る", skip.status.pairs[1]);
    check(skip.results.length === 1 && skip.results[0].index === 0, "SKIP: 値を返すのは BigBox だけ（スキップした組の値は表に入らない）", skip.results.map((r) => r.index));
    check(sameRows(skip.results[0].result, flag.results[0].result), "SKIP: ほかの組（BigBox）の全列が、FLAG のときと差 0");
    const stop = await runJob(base, spaced, { qc: { smallRoi: "STOP", lossy: "FLAG" } });
    check(stop.status.state === "STOPPED" && stop.status.stopKind === "QC" && stop.status.stopIndex === 1 && stop.status.qcSkipped === 0, "STOP: 従来どおり、SmallBox で止まる（スキップではない）", [stop.status.state, stop.status.stopIndex, stop.status.qcSkipped]);
    const ack = await runJob(base, spaced, { qc: { smallRoi: "SKIP", lossy: "FLAG" }, ack: [`${spaced[1].studyUid}|${spaced[1].maskSeriesUid}|${spaced[1].maskChannel}`] });
    check(ack.status.qcSkipped === 0 && ack.results.length === 2 && ack.status.pairs[1].state === "DONE", "SKIP + 許容した組: スキップしない（値が出る。旗は残る）", ack.status.pairs.map((p) => [p.state, p.qcFlags]));

    console.log("\n[2] 画素間隔の無い画像");
    const ns = await runJob(base, nospacing, { qc: { smallRoi: "FLAG", lossy: "FLAG" } });
    check(ns.status.failed === 0 && ns.results.length === 2, "画素間隔なしでも計算できる（失敗しない）", ns.status.pairs.map((p) => [p.state, p.error]));
    check(ns.results.every((r) => (r.result.provenance.recordFlags ?? []).includes("UNCALIBRATED_SPACING")), "旗 UNCALIBRATED_SPACING が付く（記録）", ns.results.map((r) => r.result.provenance.recordFlags));
    check(ns.status.pairs.every((p) => p.qcFlags.includes("UNCALIBRATED_SPACING")), "旗は QC の旗の列にも出る", ns.status.pairs.map((p) => p.qcFlags));
    check(ns.results.every((r) => r.result.roiSize.volumeMm3 === null), "体積は NaN（mm³ として出さない）", ns.results.map((r) => r.result.roiSize.volumeMm3));
    check(flag.results.every((r) => r.result.roiSize.volumeMm3 !== null && !(r.result.provenance.recordFlags ?? []).includes("UNCALIBRATED_SPACING")), "画素間隔あり: 体積あり・旗なし", flag.results.map((r) => [r.result.roiSize.volumeMm3, r.result.provenance.recordFlags]));
    check(ns.results[0].result.roiSize.intensityVoxels === flag.results[0].result.roiSize.intensityVoxels, "ROI のボクセル数は同じ（画素の値は変わらない）", [ns.results[0].result.roiSize.intensityVoxels, flag.results[0].result.roiSize.intensityVoxels]);

    console.log("\n[3] 詳細設定（RadiomicsJ の設定キーを自由に）");
    const adv = await runJob(base, [spaced[0]], { settings: { INT_deltaGLCM: "2" } });
    const base0 = flag.results[0].result;
    const adv0 = adv.results[0]?.result;
    check(!!adv0, "INT_deltaGLCM=2 で計算できた", adv.status.pairs.map((p) => p.error));
    if (adv0) {
      const glcm = (r: Result) => r.rows.filter((x) => x.column.startsWith("GLCM_")).map((x) => x.value);
      const stat = (r: Result) => r.rows.filter((x) => x.column.startsWith("IntensityBasedStatistical_")).map((x) => x.value);
      check(JSON.stringify(glcm(adv0)) !== JSON.stringify(glcm(base0)), "GLCM の値が変わる（距離 2）");
      check(JSON.stringify(stat(adv0)) === JSON.stringify(stat(base0)), "GLCM に関係しない一次統計は変わらない");
      check(/(^|\n)INT_deltaGLCM=2(\n|$)/.test(adv0.settingsProperties), "結果の _radiomicsj.properties に INT_deltaGLCM=2 が残る");
      check(/(^|\n)INT_deltaGLCM=1(\n|$)/.test(base0.settingsProperties), "指定しなければ RadiomicsJ の既定（1）");
    }
    let refusal = "";
    try {
      await runJob(base, [spaced[0]], { settings: { BOGUS_KEY: "1" } });
    } catch (e) {
      refusal = String((e as Error).message);
    }
    check(/HTTP 400/.test(refusal) && /設定にないキー/.test(refusal) && /BOGUS_KEY/.test(refusal), "負例: 知らないキーは、投入の時点で理由（キー名）つきに断る（400）", refusal);
    const schema = await call<{ key: string; type: string; defaultValue: string | null }[]>(base, "/api/radiomics/features/settings-schema", "GET");
    const e = (k: string) => schema.find((x) => x.key === k);
    check(schema.length > 40 && e("INT_deltaGLCM")?.defaultValue === "1" && e("INT_deltaGLCM")?.type === "int" && e("BOOL_removeOutliers")?.type === "boolean" && e("INT_IVH_binCount")?.defaultValue === "1000",
      "スキーマ API: キーの一覧・型・既定値（INT_deltaGLCM=1、IVH のビン数 1000）", { n: schema.length, glcm: e("INT_deltaGLCM") });

    console.log("\n[4] リサンプリングの既定（等方 1 mm）");
    const none = flag.results[0].result;
    const iso = await runJob(base, [spaced[0]], { settings: { DOUBLEARRAY_resamplingFactorXYZ: "1,1,1" } });
    const isoR = iso.results[0]?.result;
    check(!!isoR && isoR.roiSize.intensityVoxels !== none.roiSize.intensityVoxels, "1 mm 等方のキーを送ると、ROI のボクセル数が、リサンプリングなしと違う（0.7×0.7×2 mm の格子から変わる）", [none.roiSize.intensityVoxels, isoR?.roiSize.intensityVoxels]);
    check(!!isoR && /DOUBLEARRAY_resamplingFactorXYZ=1\.0,1\.0,1\.0/.test(isoR.settingsProperties), "結果の設定に、リサンプリングの値が残る");
  } finally {
    await d.stop();
  }
  console.log(`\n結果: 合格 ${passed} / 失敗 ${failures.length}`);
  if (failures.length) { console.log(failures.map((x) => `  - ${x}`).join("\n")); process.exitCode = 1; }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
