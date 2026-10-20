/*
 * 4D シリーズの時間軸（セルごとの経過秒と出所）の実起動の確認。
 *
 * 実行:  cd automator && npx tsx src/spike/seriesTimeAxisCheck.ts
 * 前提:  backend jar（`cd backend && mvn -q -Dfrontend.skip=true -DskipTests package`）。
 *
 * 流れ: 合成の NIfTI を Node で書く（既知の TR・既知の次元）→ standalone の jar を専用ポートで起動 →
 *       POST /api/nifti/import → GET .../layout の timeAxis を、TR から別に計算した期待値と突き合わせる。
 *   正例: 4D（5 時相・TR = 2.5 s・3 スライス）は source=TriggerTime、各セルの秒 = 2.5 × t
 *   負例: 3D（時相 1）は timeAxis が null（秒を作り出さない）
 * 未達: 実際の DCE-MRI/灌流の DICOM の AcquisitionTime（公開データの調達は別）。
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import { waitForBackendReady } from "../backend/healthcheck.js";
import { killProcessTree } from "../common/processUtils.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { createChecker } from "./computeSpikeShared.js";

const PORTS = { http: 19690, scp: 19691 };
const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "series-time-axis-check");
const DATA_DIR = path.join(OUT_DIR, "data");
const JAR = path.join(AUTOMATOR_ROOT, "..", "backend", "target", "graphy-next-backend.jar");
const BASE = `http://127.0.0.1:${PORTS.http}`;
const { check, summary } = createChecker();

const NX = 8, NY = 8, NZ = 3;
const TR_SEC = 2.5;

/** 最小の NIfTI-1（int16）。nt > 1 なら 4D。値は (x + y + 10 z + 100 t) の既知の式。 */
function writeNifti(file: string, nt: number): void {
  const header = Buffer.alloc(352);
  header.writeInt32LE(348, 0); // sizeof_hdr
  const dim = nt > 1 ? [4, NX, NY, NZ, nt, 1, 1, 1] : [3, NX, NY, NZ, 1, 1, 1, 1];
  dim.forEach((v, i) => header.writeInt16LE(v, 40 + i * 2));
  header.writeInt16LE(4, 70); // datatype = int16
  header.writeInt16LE(16, 72); // bitpix
  const pixdim = [1, 1, 1, 1, nt > 1 ? TR_SEC : 0, 0, 0, 0];
  pixdim.forEach((v, i) => header.writeFloatLE(v, 76 + i * 4));
  header.writeFloatLE(352, 108); // vox_offset
  header.writeFloatLE(1, 112); // scl_slope
  header.writeFloatLE(0, 116); // scl_inter
  header.writeUInt8(10, 123); // xyzt_units = mm + sec
  header.write("n+1\0", 344, "latin1"); // magic
  const n = NX * NY * NZ * Math.max(nt, 1);
  const data = Buffer.alloc(n * 2);
  let i = 0;
  for (let t = 0; t < Math.max(nt, 1); t++) for (let z = 0; z < NZ; z++) for (let y = 0; y < NY; y++) for (let x = 0; x < NX; x++) {
    data.writeInt16LE(x + y + 10 * z + 100 * t, 2 * i++);
  }
  fs.writeFileSync(file, Buffer.concat([header, data]));
}

function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: "127.0.0.1" });
    s.once("connect", () => { s.destroy(); resolve(true); });
    s.once("error", () => resolve(false));
  });
}

interface Cell { c: number; z: number; t: number; sopInstanceUid: string }
interface Layout { nZ: number; nT: number; tDimension: string | null; cells: Cell[]; timeAxis?: { source: string; secBySop: Record<string, number> } | null }

async function importAndLayout(file: string, desc: string): Promise<Layout> {
  const r = await fetch(`${BASE}/api/nifti/import`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: file, modality: "MR", patientId: "TIMEAXIS", patientName: "TIMEAXIS^TEST", seriesDescription: desc }),
  });
  const res = (await r.json()) as { imported?: number; studyInstanceUid?: string; failed?: number; errors?: string[] };
  if (!r.ok || !(res.imported ?? 0)) throw new Error(`取り込み失敗: HTTP ${r.status} ${JSON.stringify(res)}`);
  const studies = (await (await fetch(`${BASE}/api/studies`)).json()) as Array<{ studyInstanceUid: string }>;
  for (const st of studies) {
    const series = (await (await fetch(`${BASE}/api/studies/${st.studyInstanceUid}/series`)).json()) as Array<{ seriesInstanceUid: string; seriesDescription?: string }>;
    const s = series.find((x) => x.seriesDescription === desc);
    if (s) return (await (await fetch(`${BASE}/api/studies/${st.studyInstanceUid}/series/${s.seriesInstanceUid}/layout`)).json()) as Layout;
  }
  throw new Error(`取り込んだシリーズが見つかりません: ${desc}`);
}

async function main(): Promise<void> {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  for (const p of Object.values(PORTS)) if (await portInUse(p)) throw new Error(`ポート ${p} が使用中です（孤児プロセスを確認）`);
  if (!fs.existsSync(JAR)) throw new Error(`backend jar がありません: ${JAR}`);
  console.log(`jar: ${JAR}（更新 ${fs.statSync(JAR).mtime.toISOString()}）`);
  const f4 = path.join(OUT_DIR, "dyn4d.nii");
  const f3 = path.join(OUT_DIR, "vol3d.nii");
  writeNifti(f4, 5);
  writeNifti(f3, 1);

  const proc: ChildProcess = spawn("java", [
    "--add-opens", "java.base/java.io=ALL-UNNAMED", "--add-opens", "java.desktop/javax.imageio.stream=ALL-UNNAMED",
    "-jar", JAR, "--spring.profiles.active=standalone", `--server.port=${PORTS.http}`, `--graphy.dicom.scp.port=${PORTS.scp}`,
  ], { cwd: DATA_DIR, stdio: ["ignore", "pipe", "pipe"] });
  proc.stdout?.on("data", () => {});
  proc.stderr?.on("data", () => {});
  try {
    await waitForBackendReady(PORTS.http);

    const l4 = await importAndLayout(f4, "dyn4d");
    check(l4.nT === 5 && l4.nZ === NZ, "4D: 時相 5・スライス 3 として取り込まれる", { nT: l4.nT, nZ: l4.nZ });
    check(!!l4.timeAxis, "4D: timeAxis が付く");
    check(l4.timeAxis?.source === "TriggerTime", "4D: 出所は TriggerTime（NIfTI は AcquisitionTime を持たない）", l4.timeAxis?.source);
    let worst = 0;
    let missing = 0;
    for (const cell of l4.cells) {
      const sec = l4.timeAxis?.secBySop?.[cell.sopInstanceUid];
      if (typeof sec !== "number") { missing++; continue; }
      worst = Math.max(worst, Math.abs(sec - TR_SEC * cell.t)); // 期待値は TR から別に計算
    }
    check(l4.cells.length === NZ * 5 && missing === 0, "4D: 全セルに秒がある（欠けを 0 で埋めていない）", { cells: l4.cells.length, missing });
    check(worst < 1e-6, "4D: 各セルの秒 = TR × t（最大誤差）", worst);

    const l3 = await importAndLayout(f3, "vol3d");
    check(l3.nT === 1, "3D: 時相は 1", l3.nT);
    check(l3.timeAxis === null || l3.timeAxis === undefined, "3D: timeAxis は付かない（秒を作り出さない）", l3.timeAxis);
  } finally {
    killProcessTree(proc);
    for (let i = 0; i < 40 && (await portInUse(PORTS.http)); i++) await new Promise((r) => setTimeout(r, 250));
  }
}

try {
  await main();
} catch (e) {
  console.error(e);
  process.exitCode = 1;
}
process.exitCode = process.exitCode || (summary() > 0 ? 1 : 0);
