/*
 * 実データの PET（PSMA の PET/CT、腫瘍の SEG つき）で、値の種類の判定と IVH を確かめる実機検証スパイク（API）。
 *
 * 実行:  cd automator && GRAPHY_AUTOMATOR_HTTP_PORT=20890 GRAPHY_AUTOMATOR_SCP_PORT=20891 GRAPHY_AUTOMATOR_VITE_PORT=20893 \
 *          timeout 1800 npx tsx src/spike/valueKindRealPetCheck.ts
 *
 * 自動 → 連続（SUVbw）・mode 1・ビン幅 0.10 SUV。ビン幅を 0.25 に指定すると値が変わる。どちらも、DICOM から読み直した SUVbw の画素値に
 * IBSI の式だけを当てた独立の値（valueKindReference.py）と一致する。分類しない（従来）は mode 0（SUV を 1 刻みへ丸める）で、値が違う。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { PY, PY_FLAGS } from "./pythonCmd.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "value-kind-real-pet-check");
const PSMA = path.join(os.homedir(), "graphy-demo-samples", "PSMA_0198cdca94fbb95f", "PET", "CT whole-body PSMA");
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
const IVH = ["VolumeAtIntensityFraction10", "VolumeAtIntensityFraction90", "IntensityAtVolumeFraction10", "IntensityAtVolumeFraction90",
  "VolumeFractionDifferenceBetweenIntensityFractions", "IntensityFractionDifferenceBetweenVolumeFractions"].map((f) => `IntensityVolumeHistogram_${f}`);
const SETTINGS: Record<string, string> = {
  BOOL_USE_FixedBinNumber: "1", INT_binCount: "32",
  BOOL_enableMorphological: "0", BOOL_enableLocalIntensityFeatures: "0", BOOL_enableIntensityBasedStatistics: "0",
  BOOL_enableIntensityHistogram: "0", BOOL_enableIntensityVolumeHistogram: "1", BOOL_enableShape2D: "0",
  BOOL_enableGLCM: "0", BOOL_enableGLRLM: "0", BOOL_enableGLSZM: "0", BOOL_enableGLDZM: "0", BOOL_enableNGTDM: "0",
  BOOL_enableNGLDM: "0", BOOL_enableFractal: "0", BOOL_enableGLAM: "0", BOOL_enableAuxiliaryStatistics: "0",
};
interface Pair { studyUid: string; sourceSeriesUid: string | null; maskSeriesUid: string; maskChannel: number; status: string; [k: string]: unknown }
interface PairResult { result: { rows: { column: string; value: number | null }[]; provenance: { valueUnit?: string; calibration?: string; valueKind?: string | null; valueKindBasis?: string | null }; discretisation: { ivhMode: number; ivhBinWidth: number } } }
interface Status { state: string; pairs: { state: string; error: string | null; qcFlags: string[] }[] }

async function runJob(base: string, pair: Pair, valueSpec: unknown): Promise<{ status: Status; r: PairResult | undefined }> {
  const job = await call<{ jobId: string }>(base, "/api/radiomics/batch/jobs", "POST", {
    pairs: [pair], settings: SETTINGS, roiModes: ["WHOLE_3D"], scales: null, scaleNotation: null, scaleLabels: null, scaleConversion: null,
    scaleCoefficient: null, channel: 0, timePoint: 0, recompute: true, qc: null, qcAcknowledged: null, smallRoiWarnVoxels: null,
    kind: null, calibration: "auto", valueSpec,
  });
  let status: Status;
  for (let i = 0; ; i++) {
    status = await call<Status>(base, `/api/radiomics/batch/jobs/${job.jobId}`, "GET");
    if (["DONE", "STOPPED", "CANCELLED"].includes(status.state)) break;
    if (i > 1800) throw new Error("ジョブが終わらない");
    await new Promise((x) => setTimeout(x, 1000));
  }
  const res = await call<PairResult[]>(base, `/api/radiomics/batch/jobs/${job.jobId}/results`, "GET");
  return { status, r: res[0] };
}
const ivhOf = (r: PairResult): (number | null)[] => IVH.map((c) => r.result.rows.find((x) => x.column === c)?.value ?? null);
const near = (a: number | null, b: number | null) => (a === null || b === null ? a === b : Math.abs(a - b) <= 1e-7 * Math.max(1e-12, Math.abs(a), Math.abs(b)) + 1e-12);
const sameVec = (a: (number | null)[], b: (number | null)[]) => a.length === b.length && a.every((v, i) => near(v, b[i]));

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const d = new DesktopDriver();
  await d.start();
  const base = `http://127.0.0.1:${d.ports.http}`;
  try {
    await resetDb(d.ports.http);
    await importPaths(d.ports.http, [PSMA]);
    const studies = await call<{ studyInstanceUid: string }[]>(base, "/api/studies", "GET").catch(() => []);
    const album = await call<{ id: number }>(base, "/api/albums", "POST", { name: `value-kind-pet-${Date.now()}` });
    const uids = Array.isArray(studies) && studies.length ? studies.map((s) => s.studyInstanceUid) : null;
    if (!uids) throw new Error("取り込んだスタディを取れない");
    await call(base, `/api/albums/${album.id}/studies`, "POST", { studyUids: uids });
    const plan = await call<Pair[]>(base, "/api/radiomics/batch/plan", "POST", { albumId: album.id, studyUids: null });
    console.log(`  組: ${plan.map((p) => `${p.status}(${(p.sourceCandidates as string[] | undefined)?.length ?? 0})`).join(", ")}`);
    const pair = plan.find((p) => p.sourceSeriesUid) ?? plan[0];
    check(!!pair && !!pair.sourceSeriesUid, "組の確認: SEG の元画像が決まる", plan.map((p) => p.status));

    console.log("\n[1] 自動（既定のまま）: PET は連続（SUVbw）・mode 1・0.10 SUV");
    const auto = await runJob(base, pair, { valueKind: "auto", ivhBinWidth: null, intensityRounding: false });
    check(!!auto.r, "計算できた", auto.status.pairs);
    if (!auto.r) throw new Error("計算できない");
    const prov = auto.r.result.provenance;
    check(prov.valueKind === "continuous" && auto.r.result.discretisation.ivhMode === 1 && auto.r.result.discretisation.ivhBinWidth === 0.1, "連続・mode 1・ビン幅 0.10", { prov, disc: auto.r.result.discretisation });
    check(prov.valueUnit === "SUVbw" && /^bw;scale=/.test(prov.calibration ?? ""), "単位は SUVbw（校正の記録あり）", prov);
    console.log(`  判定の根拠: ${prov.valueKindBasis}`);
    const scale = Number((prov.calibration ?? "").match(/scale=([0-9.eE+-]+)/)?.[1]);
    check(Math.abs(scale - 0.0006863604463884588) < 0.0006863604463884588 * 1e-9, "SUV の係数は、SUV の golden テストで検証済みの値と一致", scale);
    const npy = path.join(OUT_DIR, "roi_suv.npy");
    const v = spawnSync(PY, [...PY_FLAGS, path.join(import.meta.dirname, "valueKindRealPetVoxels.py"), PSMA, String(scale), npy], { encoding: "utf8" });
    if (v.status !== 0) throw new Error(`画素値を読み直せない: ${v.stderr}`);
    console.log(`  ROI の画素数・SUV の範囲: ${v.stdout.trim()}`);
    const refAuto = JSON.parse(spawnSync(PY, [...PY_FLAGS, path.join(import.meta.dirname, "valueKindReference.py"), JSON.stringify({ voxelsFile: npy, mode: 1, w: 0.1 })], { encoding: "utf8" }).stdout);
    console.log(`  基準: 境界のボクセル ${refAuto.edgeRisk}、${JSON.stringify(refAuto.features)}`);
    check(sameVec(refAuto.features, ivhOf(auto.r)), "IVH の 6 特徴量が、独立の基準（IBSI の式）と一致", { ref: refAuto.features, got: ivhOf(auto.r) });

    console.log("\n[2] ビン幅を 0.25 SUV に指定すると値が変わり、その値も基準と一致");
    const w25 = await runJob(base, pair, { valueKind: "auto", ivhBinWidth: 0.25, intensityRounding: false });
    const refW = JSON.parse(spawnSync(PY, [...PY_FLAGS, path.join(import.meta.dirname, "valueKindReference.py"), JSON.stringify({ voxelsFile: npy, mode: 1, w: 0.25 })], { encoding: "utf8" }).stdout);
    check(!!w25.r && w25.r.result.discretisation.ivhBinWidth === 0.25 && !sameVec(ivhOf(w25.r), ivhOf(auto.r)), "ビン幅 0.25: 記録され、値が 0.10 と違う", w25.r?.result.discretisation);
    check(!!w25.r && sameVec(refW.features, ivhOf(w25.r)), "ビン幅 0.25: IVH が基準と一致", { ref: refW.features, got: w25.r ? ivhOf(w25.r) : null });

    console.log("\n[3] 従来（分類しない）は mode 0。SUV を 1 刻みへ丸めるので、値が違う");
    const legacy = await runJob(base, pair, null);
    check(!!legacy.r && legacy.r.result.discretisation.ivhMode === 0 && !sameVec(ivhOf(legacy.r), ivhOf(auto.r)), "従来: mode 0、自動の値とは違う", legacy.r ? { mode: legacy.r.result.discretisation.ivhMode, ivh: ivhOf(legacy.r) } : null);
  } finally {
    await d.stop();
  }
  console.log(`\n結果: 合格 ${passed} / 失敗 ${failures.length}`);
  if (failures.length) { console.log(failures.map((x) => `  - ${x}`).join("\n")); process.exitCode = 1; }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
