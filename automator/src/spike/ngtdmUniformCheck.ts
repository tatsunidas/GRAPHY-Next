/*
 * RadiomicsJ 2.7.4 が効いていることの実機検証スパイク（API）。NGTDM の一様な ROI。
 *
 * 実行:  cd automator && GRAPHY_AUTOMATOR_HTTP_PORT=21090 GRAPHY_AUTOMATOR_SCP_PORT=21091 GRAPHY_AUTOMATOR_VITE_PORT=21093 \
 *          timeout 900 npx tsx src/spike/ngtdmUniformCheck.ts
 * 前提: backend jar が RadiomicsJ 2.7.4 以降（今のビルド）。
 *
 * 一様な値の合成 CT の箱の ROI で、NGTDM だけを計算する。IBSI の定義どおり Coarseness = 1e6、Contrast・Busyness・
 * Complexity・Strength = 0 になる（2.7.3 は Infinity・NaN・NaN だった）。負例は、乱数の画像の同じ箱で、Coarseness が 1e6 でない有限の正の値。
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { PY, PY_FLAGS } from "./pythonCmd.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "ngtdm-uniform-check");
const failures: string[] = [];
let passed = 0;
function check(cond: boolean, label: string, detail?: unknown): void {
  if (cond) { passed++; console.log(`  [ok  ] ${label}`); } else { console.log(`  [FAIL] ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`); failures.push(label); }
}
async function call<T>(base: string, p: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(`${base}${p}`, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${p} → HTTP ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

interface Synth {
  studyInstanceUid: string; seriesInstanceUid: string; frameOfReferenceUID: string; rows: number; columns: number;
  pixelSpacing: number[]; sliceThickness: number; iop: number[]; frames: { k: number; sopInstanceUid: string; imagePositionPatient: number[] }[];
  box: { r0: number; r1: number; c0: number; c1: number; k0: number; k1: number };
}
interface Row { column: string; value: number | null }
const MODES = ["uniform", "random"] as const;

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const synths: Record<string, Synth & { dir: string }> = {};
  for (const [i, mode] of MODES.entries()) {
    const dir = path.join(OUT_DIR, mode);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const r = spawnSync(PY, [...PY_FLAGS, path.join(import.meta.dirname, "ngtdmUniformSynth.py"), dir, mode, String((Date.now() + i * 101) % 1_000_000)], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`合成データを作れません(${mode}): ${r.stderr}`);
    synths[mode] = { ...(JSON.parse(r.stdout) as Synth), dir };
  }
  const d = new DesktopDriver();
  await d.start();
  const base = `http://127.0.0.1:${d.ports.http}`;
  try {
    await resetDb(d.ports.http);
    for (const s of Object.values(synths)) await importPaths(d.ports.http, [s.dir]);
    for (const s of Object.values(synths)) {
      const frames = s.frames.map((f) => {
        if (f.k < s.box.k0 || f.k >= s.box.k1) return { sopInstanceUid: f.sopInstanceUid, imagePositionPatient: f.imagePositionPatient, mask: "" };
        const m = Buffer.alloc(s.rows * s.columns);
        for (let r = s.box.r0; r < s.box.r1; r++) for (let c = s.box.c0; c < s.box.c1; c++) m[r * s.columns + c] = 1;
        return { sopInstanceUid: f.sopInstanceUid, imagePositionPatient: f.imagePositionPatient, mask: m.toString("base64") };
      });
      await call(base, "/api/dicom/seg", "POST", {
        studyInstanceUid: s.studyInstanceUid, seriesInstanceUid: s.seriesInstanceUid, rows: s.rows, columns: s.columns,
        imageOrientationPatient: s.iop, pixelSpacing: s.pixelSpacing, sliceThickness: s.sliceThickness,
        frameOfReferenceUID: s.frameOfReferenceUID, seriesDescription: "ngtdm SEG",
        segments: [{ number: 1, label: "Box", color: [255, 0, 0], description: null, frames }], producer: null,
      });
    }
    const album = await call<{ id: number }>(base, "/api/albums", "POST", { name: `ngtdm-${Date.now()}` });
    await call(base, `/api/albums/${album.id}/studies`, "POST", { studyUids: Object.values(synths).map((s) => s.studyInstanceUid) });
    const plan = await call<{ studyUid: string; sourceSeriesUid: string | null; maskSeriesUid: string; maskChannel: number }[]>(base, "/api/radiomics/batch/plan", "POST", { albumId: album.id, studyUids: null });
    const settings = {
      BOOL_USE_FixedBinNumber: "1", INT_binCount: "32", BOOL_enableGLCM: "0", BOOL_enableGLRLM: "0", BOOL_enableGLSZM: "0", BOOL_enableGLDZM: "0",
      BOOL_enableNGTDM: "1", BOOL_enableNGLDM: "0", BOOL_enableFractal: "0", BOOL_enableIntensityVolumeHistogram: "0", BOOL_enableLocalIntensityFeatures: "0",
      BOOL_enableMorphological: "0",
    };
    const vals: Record<string, Record<string, number | null>> = {};
    for (const mode of MODES) {
      const s = synths[mode];
      console.log(`\n[${mode}]`);
      const p = plan.find((x) => x.studyUid === s.studyInstanceUid && x.sourceSeriesUid);
      if (!p) { check(false, `${mode}: 組が作れた`, plan.length); continue; }
      const job = await call<{ jobId: string }>(base, "/api/radiomics/features/jobs", "POST", {
        studyInstanceUid: p.studyUid, sourceSeriesUid: p.sourceSeriesUid, maskSeriesUid: p.maskSeriesUid, maskChannel: p.maskChannel, channel: 0, timePoint: 0,
        settings, recompute: true, roiModes: ["WHOLE_3D"], calibration: "auto",
      });
      let st: { state: string; error?: string; result?: { rows: Row[] } };
      let raw = "";
      for (let i = 0; ; i++) {
        const res = await fetch(`${base}/api/radiomics/features/jobs/${job.jobId}`);
        raw = await res.text();
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${raw.slice(0, 300)}`);
        st = JSON.parse(raw);
        if (["DONE", "FAILED", "CANCELLED"].includes(st.state)) break;
        if (i > 600) throw new Error("ジョブが終わらない");
        await new Promise((r) => setTimeout(r, 500));
      }
      check(st.state === "DONE", `${mode}: ジョブが DONE`, { state: st.state, error: st.error });
      const rows = st.result?.rows ?? [];
      const ng = rows.filter((x) => x.column.startsWith("NGTDM_"));
      check(ng.length >= 5, `${mode}: NGTDM の行が実在する（${ng.length} 行）`, rows.length);
      vals[mode] = Object.fromEntries(ng.map((x) => [x.column, x.value]));
      // 生の JSON で NaN・Infinity がどう返るか
      const m = /"NGTDM_(Coarseness|Contrast|Busyness)"[^}]*/.exec(raw);
      console.log(`  生の JSON（NGTDM の先頭付近）: ${m ? m[0].slice(0, 160) : "(なし)"}`);
      console.log(`  NGTDM 値: ${JSON.stringify(vals[mode])}`);
    }
    const u = vals.uniform ?? {};
    check(u.NGTDM_Coarseness === 1_000_000, "一様: Coarseness = 1000000", u.NGTDM_Coarseness);
    for (const k of ["Contrast", "Busyness", "Complexity", "Strength"]) check(u[`NGTDM_${k}`] === 0, `一様: ${k} = 0`, u[`NGTDM_${k}`]);
    check(Object.values(u).every((v) => v !== null), "一様: NGTDM の値に null が無い（NaN・Infinity が欠損に化けていない）", u);
    const rd = vals.random ?? {};
    const c = rd.NGTDM_Coarseness;
    check(typeof c === "number" && Number.isFinite(c) && c > 0 && c !== 1_000_000, "乱数（負例）: Coarseness は 1e6 でない有限の正の値", c);
    check(typeof rd.NGTDM_Contrast === "number" && rd.NGTDM_Contrast > 0, "乱数（負例）: Contrast は正", rd.NGTDM_Contrast);
  } finally {
    await d.stop();
  }
  console.log(`\n結果: 合格 ${passed} / 失敗 ${failures.length}`);
  if (failures.length) { console.log(failures.map((x) => `  - ${x}`).join("\n")); process.exitCode = 1; }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
