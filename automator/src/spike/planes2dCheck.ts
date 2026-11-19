/*
 * 全断面（planes=ALL）の実機検証スパイク（API）。取得面に加えて、Axial・Sagittal・Coronal へ LPS 座標で再スライスした 2D の結果を、
 * 独立の基準（numpy・scipy の map_coordinates。planes2dRef.py）と、断面ごと・位置ごとの ROI の画素数・平均強度で突き合わせる。
 *
 * 実行:  cd automator && GRAPHY_AUTOMATOR_HTTP_PORT=21090 GRAPHY_AUTOMATOR_SCP_PORT=21091 GRAPHY_AUTOMATOR_VITE_PORT=21093 \
 *          timeout 1800 npx tsx src/spike/planes2dCheck.ts
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { PY, PY_FLAGS } from "./pythonCmd.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "planes2d-check");
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
interface Row { column: string; family: string; feature: string; value: number | null }
interface Rec2d { plane?: string | null; tiltDeg?: number | null; provenance?: { recordFlags?: string[] } }
interface SliceRes { rows: { positionMm: number; pixels: number; rows: Row[] }[]; failures: unknown[]; record: Rec2d }
interface SecRes { positionMm: number; pixels: number; rows: Row[]; record: Rec2d }
interface Result {
  provenance: { recordFlags?: string[] };
  section?: SecRes; slices?: SliceRes;
  planeResults?: { plane: string; spacingMm: number | null; section?: SecRes | null; slices?: SliceRes | null; error?: string | null }[];
}
interface Ref { [plane: string]: { spacing: number; slices: { position: number; pixels: number; mean: number }[] } }
const MODES = ["axial", "sagittal", "coronal"] as const;
const near = (a: number, b: number, t = 1e-6) => Math.abs(a - b) < t;
const meanOf = (rows: Row[]): number => rows.find((r) => r.feature === "Mean" || /Mean$/.test(r.column))?.value ?? NaN;

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const synths: Record<string, Synth & { dir: string }> = {};
  for (const [i, mode] of MODES.entries()) {
    const dir = path.join(OUT_DIR, mode);
    fs.rmSync(dir, { recursive: true, force: true });
    const r = spawnSync(PY, [...PY_FLAGS, path.join(import.meta.dirname, "geom2dSynth.py"), dir, String((Date.now() + i * 101) % 1_000_000), mode], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`合成データを作れません(${mode}): ${r.stderr}`);
    synths[mode] = { ...(JSON.parse(r.stdout) as Synth), dir };
    fs.writeFileSync(path.join(OUT_DIR, `${mode}.json`), r.stdout);
    const rf = spawnSync(PY, [...PY_FLAGS, path.join(import.meta.dirname, "planes2dRef.py"), path.join(OUT_DIR, `${mode}_vol.npy`), path.join(OUT_DIR, `${mode}.json`), path.join(OUT_DIR, `${mode}_ref.json`)], { encoding: "utf8" });
    if (rf.status !== 0) throw new Error(`基準を作れません(${mode}): ${rf.stderr}`);
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
        settings, recompute: true, roiModes: ["WHOLE_3D", "MAX_SECTION_2D", "SLICES_2D"], calibration: "auto", planes: "ALL",
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
      const ref = JSON.parse(fs.readFileSync(path.join(OUT_DIR, `${mode}_ref.json`), "utf8")) as Ref;
      if (!r?.section || !r.slices) { check(false, `${mode}: 取得面の 2D の結果がある`); continue; }
      check(Array.isArray(r.planeResults) && r.planeResults.length === 3, `${mode}: planeResults が 3 断面`, r.planeResults?.map((p) => p.plane));
      for (const pr of r.planeResults ?? []) {
        const tag = `${mode}/${pr.plane}`;
        if (pr.error || !pr.slices || !pr.section) { check(false, `${tag}: 断面が作れた`, pr.error); continue; }
        const want = ref[pr.plane].slices.slice().sort((x, y) => x.position - y.position);
        const got = pr.slices.rows.slice().sort((x, y) => x.positionMm - y.positionMm);
        check(near(pr.spacingMm ?? NaN, ref[pr.plane].spacing), `${tag}: 再スライスの間隔 = 元の最小間隔 ${ref[pr.plane].spacing}`, pr.spacingMm);
        check(got.length === want.length && got.every((g, i) => near(g.positionMm, want[i].position, 1e-4)), `${tag}: スライスの位置が基準と一致（${want.length} 枚）`, { got: got.map((g) => g.positionMm), want: want.map((x) => x.position) });
        check(got.length === want.length && got.every((g, i) => g.pixels === want[i].pixels), `${tag}: スライスごとの ROI の画素数が基準と一致`, { got: got.map((g) => g.pixels), want: want.map((x) => x.pixels) });
        const gm = got.map((g) => meanOf(g.rows));
        check(got.length === want.length && gm.every((m, i) => Number.isFinite(m) && near(m, want[i].mean, 1e-2)), `${tag}: スライスごとの平均強度が基準（scipy 三線形）と一致`, { gm, wm: want.map((x) => x.mean) });
        check(pr.slices.record.plane === pr.plane && near(pr.slices.record.tiltDeg ?? NaN, 0) && pr.section.record.plane === pr.plane, `${tag}: 記録の断面名と傾き角 0`, [pr.slices.record.plane, pr.slices.record.tiltDeg]);
        const fl = pr.slices.record.provenance?.recordFlags ?? [];
        check(fl.includes("RESLICED_PLANE"), `${tag}: 旗 RESLICED_PLANE`, fl);
        const maxPix = Math.max(...want.map((x) => x.pixels));
        check(pr.section.pixels === maxPix && want.filter((x) => x.pixels === maxPix).some((x) => near(x.position, pr.section!.positionMm, 1e-4)), `${tag}: 最大断面は基準の最大画素数のスライス`, [pr.section.pixels, pr.section.positionMm, maxPix]);
      }
      // 取得面の 2D は従来どおり（planes を足しても変わらない）
      check(r.slices.record.plane === s.expectedPlane && !(r.slices.record.provenance?.recordFlags ?? []).includes("RESLICED_PLANE"), `${mode}: 取得面の 2D は再スライスではない`, r.slices.record.plane);
    }
  } finally {
    await d.stop();
  }
  console.log(`\n結果: 合格 ${passed} / 失敗 ${failures.length}`);
  if (failures.length) { console.log(failures.map((x) => `  - ${x}`).join("\n")); process.exitCode = 1; }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
