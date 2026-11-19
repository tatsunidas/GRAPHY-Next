/*
 * 値の種類（離散の校正値・連続の校正値・任意単位）で IVH のモードと補間後の丸めを切り替える機能の実機検証スパイク（API）。
 *
 * 実行:  cd automator && GRAPHY_AUTOMATOR_HTTP_PORT=20690 GRAPHY_AUTOMATOR_SCP_PORT=20691 GRAPHY_AUTOMATOR_VITE_PORT=20693 \
 *          timeout 1500 npx tsx src/spike/valueKindCheck.ts
 *
 * 合成の 5 シリーズ（CT 原画像・派生 CT・MR・ADC 相当・PET）を取り込み、一括抽出 API（IVH と一次統計だけ）を、指定を変えて走らせる。
 * 基準は、書き出した DICOM から読み直して IBSI の式だけで求めた IVH（valueKindReference.py。本体の実装は使わない）。
 * 負例: ADC に離散化しない（mode 0）を明示すると値が潰れる（自動の種類の判定が守っているもの）。
 * 前提: backend jar（今のビルド。RadiomicsJ 2.7.3 以降）。
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { PY, PY_FLAGS } from "./pythonCmd.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "value-kind-check");
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

interface Frame { sopInstanceUid: string; imagePositionPatient: number[] }
interface Synth {
  name: string; dir: string; studyInstanceUid: string; seriesInstanceUid: string; frameOfReferenceUID: string;
  rows: number; columns: number; pixelSpacing: number[]; sliceThickness: number; frames: Frame[];
}
interface Box { r0: number; r1: number; c0: number; c1: number; z0: number; z1: number }
const IVH = [
  "VolumeAtIntensityFraction10", "VolumeAtIntensityFraction90", "IntensityAtVolumeFraction10",
  "IntensityAtVolumeFraction90", "VolumeFractionDifferenceBetweenIntensityFractions",
  "IntensityFractionDifferenceBetweenVolumeFractions",
].map((f) => `IntensityVolumeHistogram_${f}`);
const ADC_W = 0.000137137; // 保存値の単位（1e-6）の整数倍の境界に乗らない幅

async function call<T>(base: string, p: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(`${base}${p}`, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!res.ok) throw new Error(`${method} ${p} → HTTP ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

function reference(parent: string, box: Box, cfg: Record<string, unknown>): { features: (number | null)[]; edgeRisk: number; n: number } {
  const r = spawnSync(PY, [...PY_FLAGS, path.join(import.meta.dirname, "valueKindReference.py"), JSON.stringify({ dir: parent, box, ...cfg })], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`基準を作れません: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

function makeSynth(parent: string): { box: Box; series: Synth[] } {
  for (let seed = Date.now() % 1_000_000; ; seed += 7919) {
    fs.rmSync(parent, { recursive: true, force: true });
    fs.mkdirSync(parent, { recursive: true });
    const r = spawnSync(PY, [...PY_FLAGS, path.join(import.meta.dirname, "valueKindSynth.py"), parent, String(seed)], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`合成データを作れません: ${r.stderr}`);
    const s = JSON.parse(r.stdout) as { box: Box; series: Synth[] };
    // ビンの境界に乗るボクセルがあると、浮動小数の誤差で 1 ビンずれうる（本体と基準のどちらが正しいとも言えない）。無い乱数を選ぶ
    const risks = [
      reference(parent, s.box, { name: "adc", mode: 1, w: ADC_W }).edgeRisk,
      reference(parent, s.box, { name: "pet", mode: 1, w: 0.1, suv: true }).edgeRisk,
      reference(parent, s.box, { name: "adc", mode: 2 }).edgeRisk,
      reference(parent, s.box, { name: "mr", mode: 2 }).edgeRisk,
      reference(parent, s.box, { name: "ct_derived", mode: 2 }).edgeRisk,
    ];
    if (risks.every((x) => x === 0)) return s;
    console.log(`  (乱数 ${seed}: 境界に乗るボクセル ${JSON.stringify(risks)} → 別の乱数で作り直す)`);
  }
}

const SETTINGS: Record<string, string> = {
  BOOL_USE_FixedBinNumber: "1", INT_binCount: "32",
  BOOL_enableMorphological: "0", BOOL_enableLocalIntensityFeatures: "0", BOOL_enableIntensityBasedStatistics: "1",
  BOOL_enableIntensityHistogram: "0", BOOL_enableIntensityVolumeHistogram: "1", BOOL_enableShape2D: "0",
  BOOL_enableGLCM: "0", BOOL_enableGLRLM: "0", BOOL_enableGLSZM: "0", BOOL_enableGLDZM: "0", BOOL_enableNGTDM: "0",
  BOOL_enableNGLDM: "0", BOOL_enableFractal: "0", BOOL_enableGLAM: "0", BOOL_enableAuxiliaryStatistics: "0",
};

interface Pair { studyUid: string; sourceSeriesUid: string | null; maskSeriesUid: string; maskChannel: number; [k: string]: unknown }
interface Row { column: string; value: number | null }
interface PairResult {
  pair: Pair;
  result: {
    rows: Row[]; provenance: { valueUnit?: string; calibration?: string; valueKind?: string | null; valueKindBasis?: string | null; recordFlags?: string[] };
    discretisation: { ivhMode: number; ivhBinWidth: number };
  };
}
interface Status { state: string; pairs: { pair: Pair; state: string; error: string | null; qcFlags: string[] }[] }

async function runJob(base: string, pairs: Pair[], valueSpec: unknown, extra: Record<string, string> = {}): Promise<{ status: Status; results: PairResult[] }> {
  const req = {
    pairs, settings: { ...SETTINGS, ...extra }, roiModes: ["WHOLE_3D"], scales: null, scaleNotation: null, scaleLabels: null,
    scaleConversion: null, scaleCoefficient: null, channel: 0, timePoint: 0, recompute: true, qc: null, qcAcknowledged: null,
    smallRoiWarnVoxels: null, kind: null, calibration: "auto", valueSpec,
  };
  const job = await call<{ jobId: string }>(base, "/api/radiomics/batch/jobs", "POST", req);
  let status: Status;
  for (let i = 0; ; i++) {
    status = await call<Status>(base, `/api/radiomics/batch/jobs/${job.jobId}`, "GET");
    if (["DONE", "STOPPED", "CANCELLED"].includes(status.state)) break;
    if (i > 600) throw new Error("ジョブが終わらない");
    await new Promise((r) => setTimeout(r, 500));
  }
  const results = await call<PairResult[]>(base, `/api/radiomics/batch/jobs/${job.jobId}/results`, "GET");
  return { status, results };
}

const ivhOf = (r: PairResult): (number | null)[] => IVH.map((c) => r.result.rows.find((x) => x.column === c)?.value ?? null);
const near = (a: number | null, b: number | null): boolean =>
  a === null || b === null ? a === b : Math.abs(a - b) <= 1e-7 * Math.max(1e-12, Math.abs(a), Math.abs(b)) + 1e-12;
const sameVec = (a: (number | null)[], b: (number | null)[]): boolean => a.length === b.length && a.every((v, i) => near(v, b[i]));

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const parent = path.join(OUT_DIR, "synth");
  const { box, series } = makeSynth(parent);
  const byName = Object.fromEntries(series.map((s) => [s.name, s]));
  const d = new DesktopDriver();
  await d.start();
  const base = `http://127.0.0.1:${d.ports.http}`;
  try {
    await resetDb(d.ports.http);
    for (const s of series) await importPaths(d.ports.http, [s.dir]);
    for (const s of series) {
      const frames = s.frames.map((f, z) => {
        if (z < box.z0 || z >= box.z1) return { ...f, mask: "" };
        const m = Buffer.alloc(s.rows * s.columns);
        for (let r = box.r0; r < box.r1; r++) for (let c = box.c0; c < box.c1; c++) m[r * s.columns + c] = 1;
        return { ...f, mask: m.toString("base64") };
      });
      await call(base, "/api/dicom/seg", "POST", {
        studyInstanceUid: s.studyInstanceUid, seriesInstanceUid: s.seriesInstanceUid, rows: s.rows, columns: s.columns,
        imageOrientationPatient: [1, 0, 0, 0, 1, 0], pixelSpacing: s.pixelSpacing, sliceThickness: s.sliceThickness,
        frameOfReferenceUID: s.frameOfReferenceUID, seriesDescription: "synthetic box SEG",
        segments: [{ number: 1, label: "Box", color: [255, 0, 0], description: null, frames }], producer: null,
      });
    }
    const album = await call<{ id: number }>(base, "/api/albums", "POST", { name: `value-kind-${Date.now()}` });
    await call(base, `/api/albums/${album.id}/studies`, "POST", { studyUids: series.map((s) => s.studyInstanceUid) });
    const plan = await call<Pair[]>(base, "/api/radiomics/batch/plan", "POST", { albumId: album.id, studyUids: null });
    const pairOf = (name: string): Pair => {
      const p = plan.find((x) => x.studyUid === byName[name].studyInstanceUid);
      if (!p || !p.sourceSeriesUid) throw new Error(`組が作れていない: ${name}`);
      return p;
    };
    check(plan.length === 6 && plan.every((p) => p.sourceSeriesUid), "組の確認: 6 組（シリーズごとに 1 組、元画像が決まる）", plan.map((p) => p.status));

    const auto = { valueKind: "auto", ivhBinWidth: null, intensityRounding: false };
    const names = ["ct_hu", "ct_notype", "ct_derived", "mr", "adc", "pet"];

    console.log("\n[1] 自動（既定のまま）: 種類・モード・旗・値");
    const a = await runJob(base, names.map(pairOf), auto);
    check(a.results.length === 6, "6 組とも計算できた", a.status.pairs.map((p) => `${p.state}:${p.error ?? ""}`));
    const R = (name: string) => a.results.find((r) => r.pair.studyUid === byName[name].studyInstanceUid)!;
    const F = (name: string) => a.status.pairs.find((p) => p.pair.studyUid === byName[name].studyInstanceUid)!.qcFlags;
    const expectAuto: Record<string, { kind: string; mode: number; flags: string[]; ref: Record<string, unknown> }> = {
      ct_hu: { kind: "discrete", mode: 0, flags: [], ref: { name: "ct_hu", mode: 0 } },
      ct_notype: { kind: "discrete", mode: 0, flags: [], ref: { name: "ct_notype", mode: 0 } },
      ct_derived: { kind: "arbitrary", mode: 2, flags: ["IVH_BINWIDTH_UNSET"], ref: { name: "ct_derived", mode: 2 } },
      mr: { kind: "arbitrary", mode: 2, flags: [], ref: { name: "mr", mode: 2 } },
      adc: { kind: "arbitrary", mode: 2, flags: ["IVH_BINWIDTH_UNSET"], ref: { name: "adc", mode: 2 } },
      pet: { kind: "continuous", mode: 1, flags: [], ref: { name: "pet", mode: 1, w: 0.1, suv: true } },
    };
    for (const n of names) {
      const e = expectAuto[n];
      const r = R(n);
      check(r.result.provenance.valueKind === e.kind, `${n}: 値の種類 = ${e.kind}`, r.result.provenance);
      check(r.result.discretisation.ivhMode === e.mode, `${n}: IVH のモード = ${e.mode}`, r.result.discretisation);
      check(JSON.stringify(F(n).filter((f) => ["IVH_BINWIDTH_UNSET", "VALUEKIND_OVERRIDDEN", "ROUNDING_IGNORED"].includes(f))) === JSON.stringify(e.flags), `${n}: 旗 = [${e.flags}]`, F(n));
      const ref = reference(parent, box, e.ref);
      check(sameVec(ref.features, ivhOf(r)), `${n}: IVH の 6 特徴量が、独立の基準（IBSI の式）と一致`, { ref: ref.features, got: ivhOf(r) });
    }
    check(R("pet").result.provenance.valueUnit === "SUVbw" && R("pet").result.discretisation.ivhBinWidth === 0.1, "pet: SUVbw に校正され、ビン幅は既定の 0.10 SUV", [R("pet").result.provenance.valueUnit, R("pet").result.discretisation.ivhBinWidth]);
    check((R("ct_hu").result.provenance.valueKindBasis ?? "").includes("RescaleType=HU") && (R("adc").result.provenance.valueKindBasis ?? "").includes("unit=mm2/s"), "判定の根拠が記録される", [R("ct_hu").result.provenance.valueKindBasis, R("adc").result.provenance.valueKindBasis]);

    console.log("\n[2] 連続の校正値のビン幅を指定する（ADC 相当）");
    const b = await runJob(base, [pairOf("adc")], { valueKind: "auto", ivhBinWidth: ADC_W, intensityRounding: false });
    const rb = b.results[0];
    check(rb?.result.provenance.valueKind === "continuous" && rb.result.discretisation.ivhMode === 1, "adc + ビン幅: 連続・mode 1", rb?.result.provenance);
    check(b.status.pairs[0].qcFlags.length === 0, "adc + ビン幅: 旗なし", b.status.pairs[0].qcFlags);
    const refB = reference(parent, box, { name: "adc", mode: 1, w: ADC_W });
    check(sameVec(refB.features, ivhOf(rb)), "adc + ビン幅: IVH が独立の基準と一致", { ref: refB.features, got: ivhOf(rb) });

    console.log("\n[3] 負例: ADC に離散化しない（mode 0）を明示すると値が潰れる（自動の判定が守っているもの）");
    const c = await runJob(base, [pairOf("adc")], auto, { INT_IVH_MODE: "0" });
    const rc = c.results[0];
    check(rc?.result.discretisation.ivhMode === 0, "明示した mode 0 が優先される", rc?.result.discretisation);
    check(c.status.pairs[0].qcFlags.includes("IVH_SETTING_EXPLICIT"), "明示した設定の旗 IVH_SETTING_EXPLICIT", c.status.pairs[0].qcFlags);
    check(!sameVec(ivhOf(rc), ivhOf(R("adc"))), "自動の値（mode 2）とは違う", { explicit0: ivhOf(rc), auto: ivhOf(R("adc")) });
    check(ivhOf(rc)[0] === null && ivhOf(rc)[1] === null, "ADC の全ボクセルが 1 つの値に潰れ、強度分率が定義できない（V10・V90 が NaN）", ivhOf(rc));
    const d0 = await runJob(base, [pairOf("adc")], null);
    check(sameVec(ivhOf(d0.results[0]), ivhOf(rc)), "分類しない（従来）の ADC も同じく潰れる（従来の挙動の再現）", ivhOf(d0.results[0]));
    check(d0.results[0].result.provenance.valueKind == null, "分類しない（従来）は、値の種類の記録が空", d0.results[0].result.provenance);

    console.log("\n[4] 従来との同値・上書き・断り");
    const l = await runJob(base, [pairOf("ct_hu")], null);
    check(sameVec(ivhOf(l.results[0]), ivhOf(R("ct_hu"))), "CT 原画像: 分類しない（従来）と自動は、IVH の値が同じ（mode 0 は従来と同じ）", [ivhOf(l.results[0]), ivhOf(R("ct_hu"))]);
    const o = await runJob(base, [pairOf("mr")], { valueKind: "discrete", ivhBinWidth: null, intensityRounding: false });
    check(o.status.pairs[0].qcFlags.includes("VALUEKIND_OVERRIDDEN") && o.results[0]?.result.discretisation.ivhMode === 0, "MR を離散と上書き: 旗 VALUEKIND_OVERRIDDEN・mode 0", [o.status.pairs[0].qcFlags, o.results[0]?.result.discretisation]);
    check(sameVec(ivhOf(o.results[0]), reference(parent, box, { name: "mr", mode: 0 }).features), "MR を離散と上書き: IVH が mode 0 の基準と一致", ivhOf(o.results[0]));
    const f = await runJob(base, [pairOf("mr")], { valueKind: "continuous", ivhBinWidth: null, intensityRounding: false });
    check(f.status.pairs[0].state === "FAILED" && /ビン幅/.test(f.status.pairs[0].error ?? ""), "連続を指定したがビン幅が決まらない: 値を作らずに断る（理由にビン幅）", f.status.pairs[0]);

    console.log("\n[5] 補間後の丸め（1 mm 等方に補間）");
    const iso = { DOUBLEARRAY_resamplingFactorXYZ: "1,1,1" };
    const off = await runJob(base, [pairOf("ct_hu")], auto, iso);
    const on = await runJob(base, [pairOf("ct_hu")], { valueKind: "auto", ivhBinWidth: null, intensityRounding: true }, iso);
    const col = (r: PairResult, name: string) => r.result.rows.find((x) => x.column === `IntensityBasedStatistical_${name}`)?.value ?? NaN;
    const isInt = (v: number) => Math.abs(v - Math.round(v)) < 1e-9;
    check(isInt(col(on.results[0], "Maximum")) && isInt(col(on.results[0], "Minimum")), "CT 原画像 + 丸め on: 補間後の最大・最小が整数", [col(on.results[0], "Maximum"), col(on.results[0], "Minimum")]);
    check(!isInt(col(off.results[0], "Maximum")) || !isInt(col(off.results[0], "Minimum")), "丸め off: 補間後の最大・最小は小数（丸めが効いたのは on のときだけ）", [col(off.results[0], "Maximum"), col(off.results[0], "Minimum")]);
    check(on.status.pairs[0].qcFlags.every((x) => x !== "ROUNDING_IGNORED"), "離散の CT では丸めは無視されない", on.status.pairs[0].qcFlags);
    const rn = await runJob(base, [pairOf("mr")], { valueKind: "auto", ivhBinWidth: null, intensityRounding: true }, iso);
    const rf = await runJob(base, [pairOf("mr")], auto, iso);
    check(rn.status.pairs[0].qcFlags.includes("ROUNDING_IGNORED"), "MR に丸めを指定: 旗 ROUNDING_IGNORED", rn.status.pairs[0].qcFlags);
    check(sameVec(rn.results[0].result.rows.map((r) => r.value), rf.results[0].result.rows.map((r) => r.value)), "MR に丸めを指定: 値は丸めなしと同じ（掛けない）");
    const ra = await runJob(base, [pairOf("adc")], { valueKind: "auto", ivhBinWidth: ADC_W, intensityRounding: true }, iso);
    const rb2 = await runJob(base, [pairOf("adc")], { valueKind: "auto", ivhBinWidth: ADC_W, intensityRounding: false }, iso);
    check(sameVec(ra.results[0].result.rows.map((r) => r.value), rb2.results[0].result.rows.map((r) => r.value)), "ADC に丸めを指定: 値は丸めなしと同じ（小数の校正値を壊さない）");
  } finally {
    await d.stop();
  }
  console.log(`\n結果: 合格 ${passed} / 失敗 ${failures.length}`);
  if (failures.length) {
    console.log(failures.map((x) => `  - ${x}`).join("\n"));
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
