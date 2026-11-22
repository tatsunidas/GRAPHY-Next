/*
 * 2D（最大断面・スライス別）の位置・断面名・傾き角・取り直しの旗の実機検証スパイク（API）。FINDINGS 27 の再現を含む。
 *
 * 実行:  cd automator && GRAPHY_AUTOMATOR_HTTP_PORT=21090 GRAPHY_AUTOMATOR_SCP_PORT=21091 GRAPHY_AUTOMATOR_VITE_PORT=21093 \
 *          timeout 1800 npx tsx src/spike/geom2dCheck.ts
 *
 * 向きの違う合成 CT（軸位・足向き・矢状・冠状）と、欠損 1 枚・ガントリーチルトのシリーズで、2D の単位を投入する。
 *   - 位置（Section_/Slice_PositionMm）は、固定の患者軸の座標（Axial=z・Sagittal=x・Coronal=y）。IOP の法線の向きで符号が変わらない。
 *   - 断面名と傾き角が記録される。
 *   - 欠損・チルトの体積（取り直した格子）でも、ジョブが失敗せず、位置は取り直した格子の位置で、旗 RECTIFIED_GRID が付く。
 * 基準は、合成データを作る Python が持つ「箱のスライスの患者軸の座標」。本体の実装は使わない。
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { PY, PY_FLAGS } from "./pythonCmd.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "geom2d-check");
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
  mode: string; studyInstanceUid: string; seriesInstanceUid: string; frameOfReferenceUID: string; rows: number; columns: number;
  pixelSpacing: number[]; sliceThickness: number; iop: number[]; frames: { k: number; sopInstanceUid: string; imagePositionPatient: number[] }[];
  box: { r0: number; r1: number; c0: number; c1: number; k0: number; k1: number }; expectedPositionsMm: number[]; expectedPlane: string; boxPixels: number;
}
interface Rec2d { plane?: string | null; tiltDeg?: number | null; provenance?: { recordFlags?: string[] } }
interface Result {
  provenance: { recordFlags?: string[] };
  section?: { positionMm: number; pixels: number; record: Rec2d };
  slices?: { rows: { positionMm: number; pixels: number }[]; failures: unknown[]; foregroundSlices: number; record: Rec2d };
}
const MODES = ["axial", "feetfirst", "sagittal", "coronal", "missing", "tilt"] as const;
const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const synths: Record<string, Synth & { dir: string }> = {};
  for (const [i, mode] of MODES.entries()) {
    const dir = path.join(OUT_DIR, mode);
    fs.rmSync(dir, { recursive: true, force: true });
    const r = spawnSync(PY, [...PY_FLAGS, path.join(import.meta.dirname, "geom2dSynth.py"), dir, String((Date.now() + i * 101) % 1_000_000), mode], { encoding: "utf8" });
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
        frameOfReferenceUID: s.frameOfReferenceUID, seriesDescription: "geom2d SEG",
        segments: [{ number: 1, label: "Box", color: [255, 0, 0], description: null, frames }], producer: null,
      });
    }
    const album = await call<{ id: number }>(base, "/api/albums", "POST", { name: `geom2d-${Date.now()}` });
    await call(base, `/api/albums/${album.id}/studies`, "POST", { studyUids: Object.values(synths).map((s) => s.studyInstanceUid) });
    const plan = await call<{ studyUid: string; sourceSeriesUid: string | null; maskSeriesUid: string; maskChannel: number }[]>(base, "/api/radiomics/batch/plan", "POST", { albumId: album.id, studyUids: null });
    const settings = {
      BOOL_USE_FixedBinNumber: "1", INT_binCount: "32", BOOL_enableGLCM: "0", BOOL_enableGLRLM: "0", BOOL_enableGLSZM: "0", BOOL_enableGLDZM: "0",
      BOOL_enableNGTDM: "0", BOOL_enableNGLDM: "0", BOOL_enableFractal: "0", BOOL_enableIntensityVolumeHistogram: "0", BOOL_enableLocalIntensityFeatures: "0",
      BOOL_enableMorphological: "0",
    };
    for (const mode of MODES) {
      const s = synths[mode];
      console.log(`\n[${mode}]`);
      const p = plan.find((x) => x.studyUid === s.studyInstanceUid && x.sourceSeriesUid);
      if (!p) { check(false, `${mode}: 組が作れた`, plan.length); continue; }
      const job = await call<{ jobId: string }>(base, "/api/radiomics/features/jobs", "POST", {
        studyInstanceUid: p.studyUid, sourceSeriesUid: p.sourceSeriesUid, maskSeriesUid: p.maskSeriesUid, maskChannel: p.maskChannel, channel: 0, timePoint: 0,
        settings, recompute: true, roiModes: ["WHOLE_3D", "MAX_SECTION_2D", "SLICES_2D"], calibration: "auto",
      });
      let st: { state: string; error?: string; result?: Result };
      for (let i = 0; ; i++) {
        st = await call(base, `/api/radiomics/features/jobs/${job.jobId}`, "GET");
        if (["DONE", "FAILED", "CANCELLED"].includes(st.state)) break;
        if (i > 600) throw new Error("ジョブが終わらない");
        await new Promise((r) => setTimeout(r, 500));
      }
      check(st.state === "DONE", `${mode}: ジョブが DONE（3D と 2D が出る）`, { state: st.state, error: st.error });
      const r = st.result;
      if (!r?.section || !r.slices) { check(false, `${mode}: 2D の結果がある`); continue; }
      const got = r.slices.rows.map((x) => x.positionMm).sort((a, b) => a - b);
      check(got.length === s.expectedPositionsMm.length && got.every((v, i) => near(v, s.expectedPositionsMm[i])),
        `${mode}: スライス別の位置が、箱のスライスの患者軸の座標と一致（昇順）`, { got, expected: s.expectedPositionsMm });
      check(r.slices.rows.every((x) => x.pixels === s.boxPixels) && r.slices.failures.length === 0, `${mode}: 各スライスの画素数が箱の面積（${s.boxPixels}）`, r.slices.rows.map((x) => x.pixels));
      check(s.expectedPositionsMm.some((v) => near(v, r.section!.positionMm)) && r.section.pixels === s.boxPixels, `${mode}: 最大断面の位置は箱のスライスのどれか（患者軸の座標）`, [r.section.positionMm, r.section.pixels]);
      check(r.section.record.plane === s.expectedPlane && r.slices.record.plane === s.expectedPlane, `${mode}: 断面名 = ${s.expectedPlane}`, [r.section.record.plane, r.slices.record.plane]);
      check(near(r.section.record.tiltDeg ?? NaN, 0), `${mode}: 傾き角 0（IOP は軸に揃っている）`, r.section.record.tiltDeg);
      const rect = (r.provenance.recordFlags ?? []).includes("RECTIFIED_GRID");
      const rect2 = (r.section.record.provenance?.recordFlags ?? []).includes("RECTIFIED_GRID") && (r.slices.record.provenance?.recordFlags ?? []).includes("RECTIFIED_GRID");
      const wantRect = mode === "missing" || mode === "tilt";
      check(rect === wantRect && rect2 === wantRect, `${mode}: 旗 RECTIFIED_GRID は ${wantRect ? "付く（3D と 2D の記録）" : "付かない"}`, [rect, rect2, r.provenance.recordFlags]);
    }
  } finally {
    await d.stop();
  }
  console.log(`\n結果: 合格 ${passed} / 失敗 ${failures.length}`);
  if (failures.length) { console.log(failures.map((x) => `  - ${x}`).join("\n")); process.exitCode = 1; }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
