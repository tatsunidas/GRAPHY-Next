/*
 * Radiomics 特徴量（形状・一次統計）のマスク対応と値の幾何検証（backend を専用ポートで起動して HTTP で叩く。Electron なし）。
 *
 * 実行:  cd automator && GEOM_PORT=18460 timeout 1500 npx tsx src/spike/geomRadiomicsCheck.ts
 *   GEOM_PORT   backend の HTTP ポート（SCP は +1）。既定 18460。
 *   GEOM_IDS    検査する幾何（カンマ区切り。既定は全 7 本）。
 *   GEOM_DUMP=1 検査せず、特徴量の列名と値を表示して止まる（列名の確認用）。
 * 出力: automator/.results/geom-radiomics-check/（raw.json・report.md・png）
 *
 * 真値は合成ファントム（scripts/make-geom-verify-phantom.py の truth.json）の**解析形状**から手計算する。
 *   球 V=4/3πr³・A=4πr²・Dmax=2r、楕円体 V=4/3πabc・Dmax=2·max(a,b,c)・主軸長 4a/√5（中実の楕円体の慣性）、
 *   線形場の平均 = 形状の重心での場の値 + 加えた値。アプリ・RadiomicsJ の式は写さない。
 * マスクは truth の IOP/IPP/間隔から、**ボクセル中心の点標本**として TS で作る（アプリのラスタ化は使わない）。
 *
 * 許容幅の導出（詳細は report.md の冒頭にも書く）:
 *   - 体積（ボクセル数）: 境界ボクセル（セルの 8 隅が内外にまたがる）の数 Nb から、各境界ボクセルの誤りを
 *     最大 ±Vvox/2・独立とみなした 3σ = 1.5·Vvox·√Nb。
 *   - 最大径: 頂点は境界の内外 1 ボクセル以内 → ±2δ（δ = ボクセルの半対角線の長さ、スライス間隔は実間隔）。
 *   - 表面積（メッシュ）: 厳密な上限が無いので、殻（半幅 δ）に収まる凸体の面積の範囲 A(r±δ) を使う（粗い・原理的）。
 *   - 平均: |∇v|·δ（重心のずれ）+ 0.5 HU（格納の丸め）。
 *   - 軸長: 半軸 ± δ。
 */
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";

import { resetDb } from "../backend/dbReset.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { waitForBackendReady } from "../backend/healthcheck.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "geom-radiomics-check");
const JAR = path.join(AUTOMATOR_ROOT, "..", "backend", "target", "graphy-next-backend.jar");
const PORT = Number(process.env.GEOM_PORT ?? 18460);
const BASE = `http://127.0.0.1:${PORT}`;
const ALL_IDS = ["g0_iso", "g1_aniso", "g2_oblique", "g3_tilt", "g4_missing", "g4_irregular", "g5_reversed"];
const IDS = (process.env.GEOM_IDS ?? ALL_IDS.join(",")).split(",").map((s) => s.trim()).filter(Boolean);
const DUMP = process.env.GEOM_DUMP === "1";

type V3 = [number, number, number];
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: number[], b: number[]): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const norm = (a: number[]) => Math.sqrt(dot(a, a));
const cross = (a: number[], b: number[]): V3 => [
  a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

interface SeriesTruth {
  id: string; seriesUid: string; rows: number; cols: number; pixelSpacing: [number, number];
  iop: number[]; normal: number[]; stepDir: number[]; ipps: number[][]; sops: string[];
  normalGapsMm: number[]; reversed: boolean;
}
interface Truth {
  field: { A: number; B: number; C: number; D: number };
  sphere: { center: number[]; radiusMm: number; addedValue: number; volumeMm3: number };
  ellipsoid: { center: number[]; semiAxesMm: number[]; addedValue: number; volumeMm3: number };
  studyUid: string;
  series: SeriesTruth[];
}

// ── 結果の記録 ──
type Verdict = "合格" | "失敗" | "未達";
interface Rec { geom: string; group: string; label: string; verdict: Verdict; expected?: string; measured?: string; ratio?: string; note?: string }
const recs: Rec[] = [];
function rec(r: Rec): void {
  recs.push(r);
  console.log(`  [${r.verdict}] ${r.geom} ${r.group} ${r.label}` +
    (r.expected !== undefined ? ` — 期待 ${r.expected} / 実測 ${r.measured} / 比 ${r.ratio}` : "") + (r.note ? ` (${r.note})` : ""));
}
const f = (x: number, d = 3) => (Number.isFinite(x) ? x.toFixed(d) : String(x));

// ── 形状（解析）──
interface Shape {
  name: "S" | "E"; center: number[]; abc: number[]; added: number;
  inside: (p: number[]) => boolean;
  volume: number; area: number; dmax: number;
}
function ellipsoidArea(abc: number[]): number {
  // 表面積 = ∬ |r_θ × r_φ| dθ dφ（中点則。解析形の数値積分。式は楕円体の媒介変数表示のみ）
  const [a, b, c] = abc;
  const nt = 600, np = 1200;
  let s = 0;
  for (let i = 0; i < nt; i++) {
    const t = ((i + 0.5) / nt) * Math.PI;
    for (let j = 0; j < np; j++) {
      const p = ((j + 0.5) / np) * 2 * Math.PI;
      const rt: V3 = [a * Math.cos(t) * Math.cos(p), b * Math.cos(t) * Math.sin(p), -c * Math.sin(t)];
      const rp: V3 = [-a * Math.sin(t) * Math.sin(p), b * Math.sin(t) * Math.cos(p), 0];
      s += norm(cross(rt, rp));
    }
  }
  return (s * (Math.PI / nt) * (2 * Math.PI / np));
}
function shapes(t: Truth): Shape[] {
  const sph = t.sphere, ell = t.ellipsoid;
  const r = sph.radiusMm;
  const S: Shape = {
    name: "S", center: sph.center, abc: [r, r, r], added: sph.addedValue,
    inside: (p) => dot(sub(p, sph.center), sub(p, sph.center)) <= r * r,
    volume: (4 / 3) * Math.PI * r ** 3, area: 4 * Math.PI * r * r, dmax: 2 * r,
  };
  const abc = ell.semiAxesMm;
  const E: Shape = {
    name: "E", center: ell.center, abc, added: ell.addedValue,
    inside: (p) => {
      const q = sub(p, ell.center);
      return (q[0] / abc[0]) ** 2 + (q[1] / abc[1]) ** 2 + (q[2] / abc[2]) ** 2 <= 1;
    },
    volume: (4 / 3) * Math.PI * abc[0] * abc[1] * abc[2], area: ellipsoidArea(abc), dmax: 2 * Math.max(...abc),
  };
  return [S, E];
}

/** 解析の場: v0 = A·x+B·y+C·z+D に、球・楕円体の内側で加えた値（標識は S・E と重ならないので入れない） */
function fieldAt(t: Truth, p: number[], S: Shape, E: Shape): number {
  const F = t.field;
  return F.A * p[0] + F.B * p[1] + F.C * p[2] + F.D + (S.inside(p) ? S.added : 0) + (E.inside(p) ? E.added : 0);
}

// ── 格子 ──
interface Grid {
  s: SeriesTruth; rc: V3; rr: V3; rowMm: number; colMm: number;
  /** 各スライスの（法線方向の）真の位置 */
  nPos: number[];
}
function gridOf(s: SeriesTruth): Grid {
  const rc: V3 = [s.iop[0], s.iop[1], s.iop[2]];
  const rr: V3 = [s.iop[3], s.iop[4], s.iop[5]];
  return { s, rc, rr, rowMm: s.pixelSpacing[0], colMm: s.pixelSpacing[1], nPos: s.ipps.map((p) => dot(p, s.normal)) };
}
function pos(g: Grid, k: number, j: number, i: number): V3 {
  const o = g.s.ipps[k];
  return [
    o[0] + i * g.colMm * g.rc[0] + j * g.rowMm * g.rr[0],
    o[1] + i * g.colMm * g.rc[1] + j * g.rowMm * g.rr[1],
    o[2] + i * g.colMm * g.rc[2] + j * g.rowMm * g.rr[2],
  ];
}
/** 位置順に並べたときの、スライス k の隣との実間隔（法線方向）の最小・最大 */
function gapRange(g: Grid): { min: number; max: number } {
  const sorted = [...g.nPos].sort((a, b) => a - b);
  let mn = Infinity, mx = 0;
  for (let k = 0; k + 1 < sorted.length; k++) {
    const d = sorted[k + 1] - sorted[k];
    mn = Math.min(mn, d); mx = Math.max(mx, d);
  }
  return { min: mn, max: mx };
}

interface Sampled {
  /** スライス（IPP の並び）ごとの 0/1 マスク。rows*cols */
  planes: Uint8Array[];
  nIn: number; nBoundary: number;
}
/**
 * ボクセル中心の点標本。マスクの面内格子 R×C は画像（rows×cols）と同じか、粗い（別サイズ）。
 * マスクのセル (j,i) の中心は、画像の画素の添字で ((j+0.5)·rows/R − 0.5, (i+0.5)·cols/C − 0.5) の位置。
 */
function sample(g: Grid, sh: Shape, R = g.s.rows, Cc = g.s.cols): Sampled {
  const sj = g.s.rows / R, si = g.s.cols / Cc;
  const planes: Uint8Array[] = [];
  let nIn = 0, nB = 0;
  const gap = gapRange(g);
  const hz = 0.5 * gap.min;
  for (let k = 0; k < g.s.ipps.length; k++) {
    const plane = new Uint8Array(R * Cc);
    for (let j = 0; j < R; j++) {
      for (let i = 0; i < Cc; i++) {
        const cj = (j + 0.5) * sj - 0.5, ci = (i + 0.5) * si - 0.5;
        const p = pos(g, k, cj, ci);
        if (sh.inside(p)) { plane[j * Cc + i] = 1; nIn++; }
        // 境界セル: 8 隅（面内はマスクのセルの半幅、z は法線方向の半間隔）が内外にまたがる
        let nin = 0;
        for (const sy of [-1, 1]) for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
          const q: V3 = [
            p[0] + sx * 0.5 * si * g.colMm * g.rc[0] + sy * 0.5 * sj * g.rowMm * g.rr[0] + sz * hz * g.s.normal[0],
            p[1] + sx * 0.5 * si * g.colMm * g.rc[1] + sy * 0.5 * sj * g.rowMm * g.rr[1] + sz * hz * g.s.normal[1],
            p[2] + sx * 0.5 * si * g.colMm * g.rc[2] + sy * 0.5 * sj * g.rowMm * g.rr[2] + sz * hz * g.s.normal[2],
          ];
          if (sh.inside(q)) nin++;
        }
        if (nin > 0 && nin < 8) nB++;
      }
    }
    planes.push(plane);
  }
  return { planes, nIn, nBoundary: nB };
}

// ── backend ──
let proc: ChildProcess | null = null;
async function startBackend(): Promise<void> {
  if (!fs.existsSync(JAR)) throw new Error(`jar がありません: ${JAR}`);
  const dataDir = path.join(OUT_DIR, "run-data");
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
  const logFd = fs.openSync(path.join(OUT_DIR, "backend.log"), "w");
  proc = spawn("java", ["-Djava.awt.headless=true", "-jar", JAR, "--spring.profiles.active=standalone",
    `--server.port=${PORT}`, `--graphy.dicom.scp.port=${PORT + 1}`], {
    cwd: dataDir, stdio: ["ignore", logFd, logFd], env: { ...process.env, GRAPHY_AUTOMATOR: "1" },
  });
  await waitForBackendReady(PORT, 120_000);
}
function stopBackend(): void {
  if (proc && proc.exitCode === null) proc.kill("SIGTERM");
}

async function api<T>(p: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${p}`, init);
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${p} → HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
  return (await res.json()) as T;
}
const post = (p: string, body: unknown) => api<{ seriesInstanceUid: string }>(p, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

interface Row { column: string; value: number | null }
interface Result { rows: Row[]; roiSize: { initialVoxels: number; morphVoxels: number; volumeMm3: number } }
async function features(studyUid: string, srcUid: string, maskUid: string, ch: number): Promise<Result> {
  const settings: Record<string, string> = {};
  for (const k of ["IntensityVolumeHistogram", "LocalIntensityFeatures", "Shape2D", "GLCM", "GLRLM", "GLSZM", "GLDZM", "GLAM",
    "NGTDM", "NGLDM", "Homological", "Fractal", "IntensityHistogram"]) settings[`BOOL_enable${k}`] = "0";
  settings.BOOL_enableMorphological = "1";
  settings.BOOL_enableIntensityBasedStatistics = "1";
  const s = await post("/api/radiomics/features/jobs", {
    studyInstanceUid: studyUid, sourceSeriesUid: srcUid, maskSeriesUid: maskUid, maskChannel: ch, channel: 0, timePoint: 0,
    settings, recompute: true }) as unknown as { jobId: string };
  for (let i = 0; i < 1200; i++) {
    const st = await api<{ state: string; result?: Result; error?: string }>(`/api/radiomics/features/jobs/${s.jobId}`);
    if (st.state === "DONE" && st.result) return st.result;
    if (st.state === "FAILED" || st.state === "CANCELLED") throw new Error(`job ${st.state}: ${st.error}`);
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("job timeout");
}
const col = (r: Result, suffix: string): number => {
  const hit = r.rows.filter((x) => x.column.endsWith("_" + suffix));
  if (hit.length !== 1) throw new Error(`列 *_${suffix} が ${hit.length} 件: ${hit.map((h) => h.column).join(",")}`);
  return hit[0].value ?? NaN;
};

/** 平面群 → SEG の frames（truth の SOP・IPP の並びのまま。reorder で IPP だけ別スライスのものを付ける負例に使う）。 */
function framesOf(g: Grid, planes: Uint8Array[], rows: number, cols: number, ippOrder?: number[]) {
  return g.s.sops.map((sop, k) => {
    const ipp = g.s.ipps[ippOrder ? ippOrder[k] : k];
    const pl = planes[k];
    return { sopInstanceUid: sop, imagePositionPatient: ipp, mask: pl.some((v) => v) ? Buffer.from(pl).toString("base64") : "" };
  }).filter(() => true).map((fr) => ({ ...fr, _r: rows, _c: cols }));
}

async function makeSeg(t: Truth, g: Grid, desc: string, S: Uint8Array[], E: Uint8Array[], rows: number, cols: number,
                       ippOrder?: number[]): Promise<string> {
  const gaps = [...g.nPos].sort((a, b) => a - b).map((v, i, a) => (i ? v - a[i - 1] : 0)).slice(1);
  const strip = (fr: ReturnType<typeof framesOf>) => fr.map(({ _r, _c, ...rest }) => rest);
  const r = await post("/api/dicom/seg", {
    studyInstanceUid: t.studyUid, seriesInstanceUid: g.s.seriesUid, rows, columns: cols,
    imageOrientationPatient: g.s.iop, pixelSpacing: g.s.pixelSpacing,
    sliceThickness: gaps.length ? Math.min(...gaps) : 1, frameOfReferenceUID: null,
    seriesDescription: desc,
    segments: [
      { number: 1, label: "S", color: [255, 0, 0], description: null, frames: strip(framesOf(g, S, rows, cols, ippOrder)) },
      { number: 2, label: "E", color: [0, 255, 0], description: null, frames: strip(framesOf(g, E, rows, cols, ippOrder)) },
    ],
    producer: null,
  });
  return r.seriesInstanceUid;
}

// ── 画像（目視用）: ボクセル中心標本の断面を PGM→PNG にする ──
function drawMask(g: Grid, sh: Shape, file: string): void {
  // 球・楕円体の中心を通るスライス（法線位置が中心に最も近い）の標本を描く
  const c = dot(sh.center, g.s.normal);
  let best = 0;
  g.nPos.forEach((p, k) => { if (Math.abs(p - c) < Math.abs(g.nPos[best] - c)) best = k; });
  const { rows, cols } = g.s;
  const S = sample(g, sh);
  const pl = S.planes[best];
  const scale = 3;
  const W = cols * scale, H = rows * scale;
  const buf = Buffer.alloc(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) buf[y * W + x] = pl[Math.floor(y / scale) * cols + Math.floor(x / scale)] ? 255 : 40;
  const pgm = path.join(OUT_DIR, "tmp.pgm");
  fs.writeFileSync(pgm, Buffer.concat([Buffer.from(`P5 ${W} ${H} 255\n`), buf]));
  spawnSync("python3", ["-I", "-c",
    `import sys\nfrom PIL import Image\nImage.open(sys.argv[1]).save(sys.argv[2])`, pgm, file]);
  fs.rmSync(pgm, { force: true });
}

function parseBool(x: string | undefined) { return x === "1"; }
void parseBool;

// ───────────────────────────── 検査 ─────────────────────────────
interface CellScale { sj: number; si: number }
interface Case { geom: string; shape: Shape; samp: Sampled; res: Result; g: Grid; cell?: CellScale }
interface MeshRef { volume: number; area: number; dmax: number; sphericity: number }

/** 3×3 行列の最大特異値（べき乗法。解析モデル用） */
function sigmaMax(M: number[][]): number {
  const MtM = [0, 1, 2].map((i) => [0, 1, 2].map((j) => M[0][i] * M[0][j] + M[1][i] * M[1][j] + M[2][i] * M[2][j]));
  let v = [1, 1, 1];
  for (let it = 0; it < 200; it++) {
    const w = MtM.map((row) => dot(row, v));
    const n = norm(w);
    v = w.map((x) => x / n);
  }
  const w = MtM.map((row) => dot(row, v));
  return Math.sqrt(dot(w, v));
}

const isRectified = (geom: string) => /g3_tilt|g4_/.test(geom);

/**
 * 取り直し（直交・等間隔の格子へ。dz = 最小間隔）後のマスクのボクセル数の期待値。画像側の補間とは独立に、
 * 「各出力スライスは、半間隔以内で最も近いソースのマスク面を取る（最近傍）」を数える。
 */
function replicatedCount(g: Grid, samp: Sampled): number {
  return replicatedRange(g, samp).hi;
}

/**
 * 同じ数え方で、「ちょうど中間（同じ距離）のとき、どちらの面を取るか」の両方を数えた下限・上限。
 * 中間の取り方は仕様の外（どちらも正しい）なので、実測が [lo, hi] に入ることを期待する。
 */
function replicatedRange(g: Grid, samp: Sampled): { lo: number; hi: number } {
  const n = g.nPos.length;
  const order = g.nPos.map((p, k) => ({ p, k })).sort((a, b) => a.p - b.p);
  const gr = gapRange(g);
  const dz = gr.min;
  const nOut = Math.floor((order[n - 1].p - order[0].p) / dz + 1e-6) + 1;
  const cnt = (i: number) => samp.planes[order[i].k].reduce((a, v) => a + (v ? 1 : 0), 0);
  let lo = 0, hi = 0;
  for (let m = 0; m < nOut; m++) {
    const tm = order[0].p + m * dz;
    let best = Infinity;
    order.forEach((o) => { best = Math.min(best, Math.abs(o.p - tm)); });
    const cands: number[] = [];
    order.forEach((o, i) => { if (Math.abs(Math.abs(o.p - tm) - best) < 1e-6) cands.push(i); });
    const counts = cands.map((i) => {
      const half = 0.5 * Math.max(i > 0 ? order[i].p - order[i - 1].p : 0, i < n - 1 ? order[i + 1].p - order[i].p : 0);
      return best <= half + 1e-9 ? cnt(i) : 0;
    });
    lo += Math.min(...counts);
    hi += Math.max(...counts);
  }
  return { lo, hi };
}

function analyticChecks(c: Case, t: Truth, tag?: string, skipMean = false): Rec[] {
  const out: Rec[] = [];
  const { g, shape: sh, samp, res } = c;
  const geom = c.geom + (tag ? `[${tag}]` : "");
  const sj = c.cell?.sj ?? 1, si = c.cell?.si ?? 1;
  const gap = gapRange(g);
  const vox = sj * g.rowMm * si * g.colMm * gap.min;
  const delta = 0.5 * Math.sqrt((sj * g.rowMm) ** 2 + (si * g.colMm) ** 2 + gap.max ** 2);
  const nm = sh.name === "S" ? "球" : "楕円体";
  const push = (group: string, label: string, expected: number, measured: number, tol: number, unit: string, note?: string) => {
    const ok = Math.abs(measured - expected) <= tol;
    out.push({ geom, group, label: `${nm} ${label}`, verdict: ok ? "合格" : "失敗",
      expected: `${f(expected)}${unit}`, measured: `${f(measured)}${unit}`, ratio: f(measured / expected, 4),
      note: `許容 ±${f(tol)}${unit}${note ? "; " + note : ""}` });
  };
  // A. 形状
  const volTol = 1.5 * vox * Math.sqrt(samp.nBoundary);
  const rect = isRectified(c.geom) && !c.cell;
  // 取り直した格子では、各出力スライスが最も近いソースのマスク面を取る。体積の期待値は、その規則を独立に数えた値。
  const repR = rect ? replicatedRange(g, samp) : { lo: 0, hi: 0 };
  const repN = (repR.lo + repR.hi) / 2; // 中間の取り方の違いは [lo, hi] で許す
  const volExp = rect ? repN * vox : sh.volume;
  const volNote = rect ? "取り直し後の期待値 = 最近傍で各出力スライスが取るマスク面のボクセル数 × ボクセル体積" : "3σ 格子点誤差";
  const tieTol = rect ? ((repR.hi - repR.lo) / 2) * vox : 0;
  push("A", "体積(ボクセル数) YEKZ", volExp, col(res, "VolumeVoxelCounting"), volTol + tieTol, " mm3", volNote + (rect ? `（同じ距離のときの取り方で ±${f(tieTol)}）` : ""));
  push("A", "体積(メッシュ) RNU0", volExp, col(res, "VolumeMesh"), volTol + tieTol + 0.125 * vox * samp.nBoundary, " mm3",
    rect ? volNote + " + 境界ボクセルの 1/8" : "3σ + 境界ボクセルの 1/8 ボクセル分（メッシュの角切り）");
  if (rect) {
    const mv = col(res, "VolumeVoxelCounting");
    out.push({ geom, group: "A", label: `${nm} 体積(ボクセル数)の解析体積との比（参考。欠けた/不規則な間隔のマスクは最近傍の推定）`, verdict: "未達",
      expected: f(sh.volume), measured: f(mv), ratio: f(mv / sh.volume, 4), note: "判定しない。取り直し前は不等間隔で 0.73 倍・欠損で 0.93 倍だった" });
  }
  push("A", "最大3D径 L0JK", sh.dmax, col(res, "Maximum3DDiameter"), 2 * delta, " mm", `2δ, δ=${f(delta)}`);
  for (const [name, sfx, an] of [["表面積(メッシュ) C0JK", "SurfaceAreaMesh", sh.area], ["球形度 QCFX", "Sphericity",
    Math.cbrt(36 * Math.PI * sh.volume ** 2) / sh.area]] as const) {
    const m = col(res, sfx);
    out.push({ geom, group: "A", label: `${nm} ${name}（解析値との比は参考）`, verdict: "未達",
      expected: f(an, 4), measured: f(m, 4), ratio: f(m / an, 4),
      note: "二値マスクの Marching Cubes は面積を系統的に過大にする（IBSI 定義）。原理的な許容を導けないので解析値では判定しない。実装一致は parity 検査" });
  }
  if (sh.name === "E") {
    const lam = sh.abc.slice().sort((a, b) => b - a);
    const ax = (a: number) => (4 * a) / Math.sqrt(5);
    const tolAx = (4 / Math.sqrt(5)) * delta;
    push("D", "主軸長 TDIC", ax(lam[0]), col(res, "MajorAxisLength"), tolAx, " mm", "4a/√5 ± 4δ/√5");
    push("D", "副軸長 P9VJ", ax(lam[1]), col(res, "MinorAxisLength"), tolAx, " mm");
    push("D", "最小軸長 7J51", ax(lam[2]), col(res, "LeastAxisLength"), tolAx, " mm");
  }
  // B. 平均（線形場）
  const F = t.field, c0 = sh.center;
  const mean0 = F.A * c0[0] + F.B * c0[1] + F.C * c0[2] + F.D + sh.added;
  // 取り直した画像は線形補間なので、境界のボクセルには内外の値が混ざる。平均の偏りは、境界の割合 × 内外の差が上限。
  const meanTol = Math.sqrt(F.A ** 2 + F.B ** 2 + F.C ** 2) * delta + 0.5 + (rect ? (samp.nBoundary / Math.max(1, samp.nIn)) * sh.added : 0);
  if (!skipMean) push("B", "平均強度", mean0, col(res, "Mean"), meanTol, " HU", rect ? "|∇v|·δ + 0.5 + 境界の割合 × 内外の差（補間）" : "|∇v|·δ + 0.5");
  // C. マスクとスライスの対応: ボクセル数と外接箱は添字レベルで**完全一致**するはず（メッシュ・許容に頼らない）
  if (!c.cell) {
    const rr = isRectified(c.geom) ? replicatedRange(g, samp) : { lo: samp.nIn, hi: samp.nIn };
    const nIn = rr.hi;
    const got = col(res, "DiagnosticsInitialROIIntMaskVoxelCount");
    out.push({ geom, group: "C", label: `${nm} マスクのボクセル数（取り込み後）`, verdict: got >= rr.lo && got <= rr.hi ? "合格" : "失敗",
      expected: rr.lo === rr.hi ? `${nIn}` : `${rr.lo}〜${rr.hi}`, measured: `${got}`, ratio: f(got / nIn, 4),
      note: rr.lo === rr.hi ? "完全一致" : "取り直し後: 最近傍で取るマスク面のボクセル数（中間のときの取り方の両方を許す）" });
    const { rows, cols } = g.s;
    let kMin = 1e9, kMax = -1, jMin = 1e9, jMax = -1, iMin = 1e9, iMax = -1;
    samp.planes.forEach((pl, k) => {
      for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) if (pl[j * cols + i]) {
        kMin = Math.min(kMin, k); kMax = Math.max(kMax, k); jMin = Math.min(jMin, j); jMax = Math.max(jMax, j);
        iMin = Math.min(iMin, i); iMax = Math.max(iMax, i);
      }
    });
    const exp = { X: iMax - iMin + 1, Y: jMax - jMin + 1, Z: kMax - kMin + 1 };
    for (const ax of ["X", "Y", "Z"] as const) {
      if (isRectified(c.geom) && ax === "Z" && !/g3_tilt/.test(c.geom)) continue; // 取り直しで Z の枚数が変わる
      const m = col(res, `DiagnosticsInitialROIMaskBoundingBoxDimension${ax}`);
      out.push({ geom, group: "C", label: `${nm} 外接箱 ${ax}（ボクセル数）`, verdict: m === exp[ax] ? "合格" : "失敗",
        expected: `${exp[ax]}`, measured: `${m}`, ratio: f(m / exp[ax], 4), note: "完全一致" });
    }
  }
  return out;
}

/** 同じマスク（添字空間）に独立実装（skimage）の Marching Cubes をかけた値との一致。メッシュの定義・実装の一致を見る。 */
function parityChecks(c: Case, ref: MeshRef, tag?: string): Rec[] {
  const out: Rec[] = [];
  const geom = c.geom + (tag ? `[${tag}]` : "");
  const nm = c.shape.name === "S" ? "球" : "楕円体";
  const items: [string, number, number, number][] = [
    ["メッシュ体積", ref.volume, col(c.res, "VolumeMesh"), 0.01],
    ["メッシュ表面積", ref.area, col(c.res, "SurfaceAreaMesh"), 0.01],
    ["メッシュ最大径", ref.dmax, col(c.res, "Maximum3DDiameter"), 0.005],
    ["球形度", ref.sphericity, col(c.res, "Sphericity"), 0.01],
  ];
  for (const [label, e, m, rt] of items) {
    out.push({ geom, group: "P", label: `${nm} ${label}（skimage MC と同じ入力）`, verdict: Math.abs(m / e - 1) <= rt ? "合格" : "失敗",
      expected: f(e, 3), measured: f(m, 3), ratio: f(m / e, 4), note: `許容 相対 ±${rt * 100}%（三角形分割の曖昧な立方体の差のみ）` });
  }
  return out;
}

function refMeshes(items: { key: string; planes: Uint8Array[]; rows: number; cols: number; spacing: [number, number, number] }[]): Record<string, MeshRef> {
  const spec = items.map((it) => {
    const file = path.join(OUT_DIR, `mesh-${it.key}.raw`);
    fs.writeFileSync(file, Buffer.concat(it.planes.map((p) => Buffer.from(p))));
    return { key: it.key, file, shape: [it.planes.length, it.rows, it.cols], spacing: it.spacing };
  });
  const sp = path.join(OUT_DIR, "mesh-spec.json"), op = path.join(OUT_DIR, "mesh-out.json");
  fs.writeFileSync(sp, JSON.stringify(spec));
  const r = spawnSync("python3", ["-I", path.join(AUTOMATOR_ROOT, "src", "spike", "geomMeshReference.py"), sp, op], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`mesh 参照の計算に失敗: ${r.stderr}`);
  for (const it of spec) fs.rmSync(it.file, { force: true });
  return JSON.parse(fs.readFileSync(op, "utf8")) as Record<string, MeshRef>;
}

function dimsChecks(id: string, g: Grid, res: Result): Rec[] {
  const dx = col(res, "DiagnosticsInterpolatedImageVoxelDimensionX");
  const dy = col(res, "DiagnosticsInterpolatedImageVoxelDimensionY");
  const dz = col(res, "DiagnosticsInterpolatedImageVoxelDimensionZ");
  const gr = gapRange(g);
  const uniform = gr.max - gr.min < 1e-3;
  const meanGap = (Math.max(...g.nPos) - Math.min(...g.nPos)) / (g.nPos.length - 1);
  const out: Rec[] = [
    { geom: id, group: "D", label: "面内間隔 X（列方向）", verdict: Math.abs(dx - g.colMm) < 1e-3 ? "合格" : "失敗",
      expected: `${g.colMm} mm`, measured: `${f(dx, 4)} mm`, ratio: f(dx / g.colMm, 4) },
    { geom: id, group: "D", label: "面内間隔 Y（行方向）", verdict: Math.abs(dy - g.rowMm) < 1e-3 ? "合格" : "失敗",
      expected: `${g.rowMm} mm`, measured: `${f(dy, 4)} mm`, ratio: f(dy / g.rowMm, 4) },
  ];
  out.push(isRectified(id)
    ? { geom: id, group: "C", label: "取り直し後のスライス間隔 Z = 最小間隔（直交・等間隔の格子）", verdict: Math.abs(dz - gr.min) < 1e-3 ? "合格" : "失敗",
        expected: `${f(gr.min, 4)} mm`, measured: `${f(dz, 4)} mm`, ratio: f(dz / gr.min, 4), note: "不等間隔・欠損は最小間隔の格子へ、チルトは法線方向の間隔へ取り直す" }
    : { geom: id, group: "C", label: "スライス間隔 Z（pixelDepth = 法線方向の実間隔）", verdict: Math.abs(dz - gr.min) < 1e-3 ? "合格" : "失敗",
        expected: `${f(gr.min, 4)} mm`, measured: `${f(dz, 4)} mm`, ratio: f(dz / gr.min, 4) });
  return out;
}

async function runShapes(truth: Truth, g: Grid, srcUid: string, label: string, S: Shape, E: Shape,
                         opts: { segMasks?: { S: Sampled; E: Sampled; R: number; C: number }; ippOrder?: number[]; id?: string } = {}) {
  const sS = opts.segMasks?.S ?? sample(g, S), sE = opts.segMasks?.E ?? sample(g, E);
  const R = opts.segMasks?.R ?? g.s.rows, C = opts.segMasks?.C ?? g.s.cols;
  const seg = await makeSegFor(truth, g, srcUid, `GEOMR ${label}`, sS.planes, sE.planes, R, C, opts.ippOrder);
  const resS = await features(truth.studyUid, srcUid, seg, 0);
  const resE = await features(truth.studyUid, srcUid, seg, 1);
  return { sS, sE, resS, resE };
}

async function makeSegFor(t: Truth, g: Grid, srcUid: string, desc: string, S: Uint8Array[], E: Uint8Array[], rows: number, cols: number,
                          ippOrder?: number[]): Promise<string> {
  return makeSeg(t, { ...g, s: { ...g.s, seriesUid: srcUid } }, desc, S, E, rows, cols, ippOrder);
}

const asRec = (rs: Rec[]) => { for (const r of rs) rec(r); return rs; };

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const n of fs.readdirSync(OUT_DIR)) if (n.endsWith(".png") || n === "phantom" || n === "swapped") fs.rmSync(path.join(OUT_DIR, n), { recursive: true, force: true });
  const dir = path.join(OUT_DIR, "phantom");
  fs.mkdirSync(dir, { recursive: true });
  const seed = Date.now() % 1_000_000_000;
  const mk = spawnSync("python3", ["-I", path.join(AUTOMATOR_ROOT, "scripts", "make-geom-verify-phantom.py"), dir, "--uid-seed", String(seed)], { encoding: "utf8" });
  if (mk.status !== 0) throw new Error(`ファントム生成に失敗: ${mk.stderr}`);
  const truth = JSON.parse(fs.readFileSync(path.join(dir, "truth.json"), "utf8")) as Truth;
  // 負例用: g1 の行/列間隔を入れ替えた複製（新 UID）
  const swapDir = path.join(OUT_DIR, "swapped");
  const sw = spawnSync("python3", ["-I", path.join(AUTOMATOR_ROOT, "src", "spike", "geomMakeSwapped.py"), path.join(dir, "g1_aniso"), swapDir, String(seed + 7)], { encoding: "utf8" });
  if (sw.status !== 0) throw new Error(`負例の複製に失敗: ${sw.stderr}`);
  const swapped = JSON.parse(sw.stdout) as { seriesUid: string; sops: string[] };
  const [S, E] = shapes(truth);
  console.log(`phantom seed=${seed} 球 V=${f(S.volume)} A=${f(S.area)} / 楕円体 V=${f(E.volume)} A=${f(E.area)} Dmax=${f(E.dmax)}`);

  await startBackend();
  const raw: Record<string, unknown> = { seed };
  const negatives: { name: string; expectFailGroups: string[]; recs: Rec[] }[] = [];
  try {
    console.log("reset:", JSON.stringify(await resetDb(PORT)));
    console.log("import:", JSON.stringify(await importPaths(PORT, [dir, swapDir])));

    for (const id of IDS) {
      const s = truth.series.find((x) => x.id === id);
      if (!s) throw new Error(`truth に ${id} がありません`);
      const g = gridOf(s);
      const gr = gapRange(g);
      console.log(`\n=== ${id}: ${s.ipps.length} 枚, 実間隔 ${f(gr.min)}〜${f(gr.max)} mm ===`);
      drawMask(g, S, path.join(OUT_DIR, `mask-${id}-S.png`));
      drawMask(g, E, path.join(OUT_DIR, `mask-${id}-E.png`));
      let shapes: Awaited<ReturnType<typeof runShapes>>;
      try {
        shapes = await runShapes(truth, g, s.seriesUid, id, S, E);
      } catch (e) {
        // 一様でない間隔・チルトのシリーズは、誤った値を黙って出さず、理由を添えて断る（期待どおり）。
        const msg = String((e as Error).message ?? e);
        const refused = /ガントリーチルト|不規則|欠け|重複/.test(msg);
        const expectRefuse = /g3_tilt|g4_/.test(id);
        rec({ geom: id, group: "R", label: "不等間隔・欠損・チルトは、誤った値を出さず理由を添えて断る",
          verdict: expectRefuse && refused ? "合格" : "失敗", note: msg.slice(0, 200) });
        continue;
      }
      const { sS, sE, resS, resE } = shapes;
      console.log(`  標本: 球 ${sS.nIn} voxel (境界 ${sS.nBoundary}) / 楕円体 ${sE.nIn} (境界 ${sE.nBoundary})`);
      raw[id] = { S: resS.rows, E: resE.rows };
      if (DUMP) {
        for (const r of resS.rows) if (/Morph|IntensityBased|Diagnostics/.test(r.column)) console.log(`   ${r.column} = ${r.value}`);
        break;
      }
      const cases: Case[] = [{ geom: id, shape: S, samp: sS, res: resS, g }, { geom: id, shape: E, samp: sE, res: resE, g }];
      // 独立 MC の参照: アプリが仮定する格子（直交・dz は先頭 2 枚の法線間隔・面内は行/列間隔）に同じマスクを置く
      const dzApp = Math.abs(g.nPos[0] - g.nPos[1]);
      const refs = refMeshes(cases.map((c) => ({ key: `${id}-${c.shape.name}`, planes: c.samp.planes, rows: s.rows, cols: s.cols,
        spacing: [dzApp, g.rowMm, g.colMm] as [number, number, number] })));
      for (const c of cases) {
        asRec(analyticChecks(c, truth));
        if (!isRectified(id)) asRec(parityChecks(c, refs[`${id}-${c.shape.name}`])); // 取り直した格子は skimage の参照の仮定（元の格子）と違う
      }
      asRec(dimsChecks(id, g, resS));
      if (false as boolean && id === "g3_tilt") {
        // 原因の確認（取り直し前の挙動の確認。取り直し後は適用しない）: アプリの格子は直交（チルトのずれを戻さない）。真の座標 → アプリの座標は y' = y − z·tanθ のせん断。
        const t = Math.tan(Math.atan2(s.stepDir[1], s.stepDir[2]));
        for (const c of cases) {
          const T = [[1, 0, 0], [0, 1, -t], [0, 0, 1]];
          const D = [[c.shape.abc[0], 0, 0], [0, c.shape.abc[1], 0], [0, 0, c.shape.abc[2]]];
          const TD = T.map((row) => [0, 1, 2].map((j) => row[0] * D[0][j] + row[1] * D[1][j] + row[2] * D[2][j]));
          const exp = 2 * sigmaMax(TD);
          const delta = 0.5 * Math.sqrt(g.rowMm ** 2 + g.colMm ** 2 + gr.max ** 2);
          const m = col(c.shape.name === "S" ? resS : resE, "Maximum3DDiameter");
          rec({ geom: id, group: "C", label: `${c.shape.name === "S" ? "球" : "楕円体"} 最大径（せん断を戻さない格子の予測）`,
            verdict: Math.abs(m - exp) <= 2 * delta ? "合格" : "失敗", expected: `${f(exp)} mm（tanθ=${f(t, 4)} のせん断で 2σmax）`,
            measured: `${f(m)} mm`, ratio: f(m / exp, 4), note: `許容 ±2δ=${f(2 * delta)}。解析値 ${f(c.shape.dmax)} とは合わない原因の確認` });
        }
      }

      if (id === "g1_aniso") {
        // C2（一様な系列だけ。不等間隔・欠損は取り直しでスライスの枚数が変わるので、画像のスライスごとの期待値は立てない）. マスクが画像と別のスライス格子（一様な間隔・位置もずらす）のとき、画像の各スライスが最近のマスク面を受け取るか。
        // 期待値は「各画像スライスは最も近いマスク面を取る（マスク面の半間隔以内なら）」で数える。アプリの許容差の実装は見ない。
        const spM = 3.0; // g1_aniso（間隔 2.5）に対して粗い 3.0 mm のマスク
        const lo = Math.min(...g.nPos), hi = Math.max(...g.nPos);
        const nM = Math.floor((hi - lo) / spM);
        const mPos = Array.from({ length: nM }, (_, m) => lo + 0.7 + m * spM);
        const nrm = s.normal;
        const ippM = mPos.map((zp) => {
          const o = g.s.ipps[g.nPos.indexOf(lo)];
          return [0, 1, 2].map((a) => o[a] + (zp - lo) * nrm[a]);
        });
        const nearestSop = mPos.map((zp) => g.s.sops[g.nPos.reduce((b, v, k) => (Math.abs(v - zp) < Math.abs(g.nPos[b] - zp) ? k : b), 0)]);
        const gm: Grid = { ...g, s: { ...g.s, ipps: ippM, sops: nearestSop }, nPos: mPos };
        const mS = sample(gm, S), mE = sample(gm, E);
        const seg = await makeSeg(truth, gm, `GEOMR ${id} maskgrid`, mS.planes, mE.planes, s.rows, s.cols);
        for (const [sh, ms, ch] of [[S, mS, 0], [E, mE, 1]] as const) {
          const rs = await features(truth.studyUid, s.seriesUid, seg, ch);
          let exp = 0, within = 0, hyp = 0;
          const tolApp = Math.abs(g.nPos[0] - g.nPos[1]) / 2;
          g.nPos.forEach((zi) => {
            let b = 0;
            mPos.forEach((zm, m) => { if (Math.abs(zm - zi) < Math.abs(mPos[b] - zi)) b = m; });
            const pc = ms.planes[b].reduce((a, v) => a + v, 0);
            if (Math.abs(mPos[b] - zi) <= spM / 2) { exp += pc; within++; }
            if (Math.abs(mPos[b] - zi) <= tolApp) hyp += pc;
          });
          const got = col(rs, "DiagnosticsInitialROIIntMaskVoxelCount");
          rec({ geom: `${id}[マスクは別格子 ${spM} mm 間隔]`, group: "C", label: `${sh.name === "S" ? "球" : "楕円体"} 画像の各スライスが最も近いマスク面を受け取る（ボクセル数）`,
            verdict: got === exp ? "合格" : "失敗", expected: `${exp}（${within}/${g.nPos.length} スライスが覆われる）`, measured: `${got}`, ratio: f(got / exp, 4),
            note: `許容 = 0.5 × max(画像の間隔, マスクの間隔) = ${f(Math.max(Math.abs(g.nPos[0] - g.nPos[1]), spM) / 2)} mm。マスク面の半間隔 ${f(spM / 2)} mm 以内を期待（修正前は画像の先頭 2 枚の半分 ${f(Math.abs(g.nPos[0] - g.nPos[1]) / 2)} mm）` });
          raw[`${id}-maskgrid-${sh.name}`] = { got, exp, hyp };
        }
      }

      if (id === "g1_aniso") {
        // E. 面内サイズの異なるマスク（nearest での拡縮）
        for (const [R, C] of [[55, 80], [77, 112]] as const) {
          const mS = sample(g, S, R, C), mE = sample(g, E, R, C);
          const sj = s.rows / R, si = s.cols / C;
          const r = await runShapes(truth, g, s.seriesUid, `${id} mask${R}x${C}`, S, E, { segMasks: { S: mS, E: mE, R, C } });
          const tag = `マスク ${R}×${C}`;
          for (const [sh, ms, rs] of [[S, mS, r.resS], [E, mE, r.resE]] as const) {
            asRec(analyticChecks({ geom: id, shape: sh, samp: ms, res: rs, g, cell: { sj, si } }, truth, tag, true).filter((x) => x.group !== "D" || sh.name === "E"));
            // 最近傍の拡縮の定義: 画像の画素 (y,x) は マスクの (floor(y·R/rows), floor(x·C/cols)) を取る。
            // 期待値は、その定義で拡大したマスクが覆う画像の画素について、解析の場（球・楕円体を加えたもの）から直接数える
            const { rows, cols } = s;
            let n = 0, sum = 0;
            for (let k = 0; k < s.ipps.length; k++) for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
              if (!ms.planes[k][Math.floor((y * R) / rows) * C + Math.floor((x * C) / cols)]) continue;
              n++; sum += fieldAt(truth, pos(g, k, y, x), S, E);
            }
            const nm = sh.name === "S" ? "球" : "楕円体";
            const got = col(rs, "DiagnosticsInitialROIIntMaskVoxelCount");
            rec({ geom: `${id}[${tag}]`, group: "E", label: `${nm} 拡大後のボクセル数（最近傍の定義で数えた値）`,
              verdict: got === n ? "合格" : "失敗", expected: `${n}`, measured: `${got}`, ratio: f(got / n, 4) });
            const mean = col(rs, "Mean");
            rec({ geom: `${id}[${tag}]`, group: "E", label: `${nm} 拡大後の平均強度（拡大後のマスクが覆う画素の解析の場の平均）`,
              verdict: Math.abs(mean - sum / n) <= 0.5 ? "合格" : "失敗", expected: `${f(sum / n)} HU`, measured: `${f(mean)} HU`,
              ratio: f(mean / (sum / n), 4), note: "許容 ±0.5 HU（格納の丸め）。粗いマスクは境界で形状の外の画素を含むため、形状の平均とは一致しない" });
          }
          raw[`${id}-mask${R}x${C}`] = { S: r.resS.rows, E: r.resE.rows };
        }

        // 負例 N1: 行/列の間隔を取り違えた画像（アプリが取り違えたのと同じ入力）に、同じ真値の検査を通す
        const gs: Grid = { ...g, s: { ...g.s, seriesUid: swapped.seriesUid, sops: swapped.sops, pixelSpacing: [s.pixelSpacing[1], s.pixelSpacing[0]] } };
        // マスクの位置（IPP・IOP）は真のまま。SEG の画素間隔も真のまま渡すが、アプリは元画像の PixelSpacing を使う
        const seg = await makeSeg(truth, gs, "GEOMR neg swapped", sS.planes, sE.planes, s.rows, s.cols);
        const nS = await features(truth.studyUid, swapped.seriesUid, seg, 0);
        const nE = await features(truth.studyUid, swapped.seriesUid, seg, 1);
        const cs: Case[] = [{ geom: id, shape: S, samp: sS, res: nS, g }, { geom: id, shape: E, samp: sE, res: nE, g }];
        const nr: Rec[] = [];
        for (const c of cs) nr.push(...analyticChecks(c, truth, "負例N1 行列間隔を入れ替えた画像"));
        nr.push(...dimsChecks(`${id}[負例N1 行列間隔を入れ替えた画像]`, g, nS));
        negatives.push({ name: "N1 行/列の画素間隔を入れ替えた画像", expectFailGroups: ["D", "A"], recs: nr });

        // 負例 N2: マスクの IPP を z 方向に反転して付ける（k 枚目に n-1-k 枚目の位置を付ける）
        const rev = g.s.ipps.map((_, k) => g.s.ipps.length - 1 - k);
        const rn = await runShapes(truth, g, s.seriesUid, `${id} neg zflip`, S, E, { ippOrder: rev });
        const cn: Case[] = [{ geom: id, shape: S, samp: sS, res: rn.resS, g }, { geom: id, shape: E, samp: sE, res: rn.resE, g }];
        const nr2: Rec[] = [];
        for (const c of cn) nr2.push(...analyticChecks(c, truth, "負例N2 マスクの z 位置を反転"));
        // 負例 N3: parity の基準に、間隔を取り違えた入力（行/列を入れ替え）で作った参照を使う → parity 検査が落ちること
        const badRefs = refMeshes(cases.map((c) => ({ key: `${id}-bad-${c.shape.name}`, planes: c.samp.planes, rows: s.rows, cols: s.cols,
          spacing: [g.nPos[1] - g.nPos[0], g.colMm, g.rowMm] as [number, number, number] })));
        const nr3: Rec[] = [];
        for (const c of cases) nr3.push(...parityChecks(c, badRefs[`${id}-bad-${c.shape.name}`], "負例N3 参照の間隔を入れ替え"));
        negatives.push({ name: "N3 独立 MC 参照の行/列間隔を入れ替え（parity 検査の感度）", expectFailGroups: ["P"], recs: nr3 });
        negatives.push({ name: "N2 マスクの IPP を z 反転", expectFailGroups: ["B"], recs: nr2 });
      }
    }
  } finally {
    fs.writeFileSync(path.join(OUT_DIR, "raw.json"), JSON.stringify(raw, null, 1));
    stopBackend();
  }
  // 負例の集計: 本番の数には入れない
  console.log("\n--- 負例（検査器が落ちること）---");
  const negSummary: string[] = [];
  for (const n of negatives) {
    const failed = n.recs.filter((r) => r.verdict === "失敗");
    const hitGroups = new Set(failed.map((r) => r.group));
    const ok = n.expectFailGroups.every((gp) => hitGroups.has(gp));
    console.log(`  [${ok ? "検出" : "検出できず"}] ${n.name}: 失敗 ${failed.length} / ${n.recs.length}（期待する群 ${n.expectFailGroups.join(",")} / 実際 ${[...hitGroups].join(",")}）`);
    for (const r of failed) console.log(`      ${r.group} ${r.label} 期待 ${r.expected} / 実測 ${r.measured} / 比 ${r.ratio}`);
    negSummary.push(`${ok ? "検出" : "検出できず"}: ${n.name}: 失敗 ${failed.length}/${n.recs.length}`);
  }
  const count = (v: Verdict) => recs.filter((r) => r.verdict === v).length;
  console.log(`\n合格 ${count("合格")} / 失敗 ${count("失敗")} / 未達 ${count("未達")}`);
  fs.writeFileSync(path.join(OUT_DIR, "recs.json"), JSON.stringify({ recs, negatives, negSummary }, null, 1));
  writeReport(negatives);
}

function writeReport(negatives: { name: string; recs: Rec[] }[]): void {
  const L: string[] = ["# geomRadiomicsCheck 結果", "", `実行: ${new Date().toISOString()}`, ""];
  const count = (v: Verdict) => recs.filter((r) => r.verdict === v).length;
  L.push(`合格 ${count("合格")} / 失敗 ${count("失敗")} / 未達 ${count("未達")}`, "");
  L.push("群: A 形状 / B 一次統計(平均) / C マスク・スライス対応 / D 面内間隔・軸 / E 面内サイズ違いのマスク / P 独立 MC との一致", "");
  for (const id of [...new Set(recs.map((r) => r.geom.replace(/\[.*$/, "")))]) {
    const rs = recs.filter((r) => r.geom.replace(/\[.*$/, "") === id);
    L.push(`## ${id}  合格 ${rs.filter((r) => r.verdict === "合格").length} / 失敗 ${rs.filter((r) => r.verdict === "失敗").length} / 未達 ${rs.filter((r) => r.verdict === "未達").length}`, "");
    L.push("| 判定 | 群 | 検査 | 期待 | 実測 | 比 | 備考 |", "|---|---|---|---|---|---|---|");
    for (const r of rs) L.push(`| ${r.verdict} | ${r.group} | ${r.geom !== id ? r.geom.replace(id, "") + " " : ""}${r.label} | ${r.expected ?? ""} | ${r.measured ?? ""} | ${r.ratio ?? ""} | ${r.note ?? ""} |`);
    L.push("");
  }
  L.push("## 負例（本番の数に入れない）", "");
  for (const n of negatives) {
    L.push(`### ${n.name}`, "", "| 判定 | 群 | 検査 | 期待 | 実測 | 比 |", "|---|---|---|---|---|---|");
    for (const r of n.recs) L.push(`| ${r.verdict} | ${r.group} | ${r.label} | ${r.expected ?? ""} | ${r.measured ?? ""} | ${r.ratio ?? ""} |`);
    L.push("");
  }
  fs.writeFileSync(path.join(OUT_DIR, "report.md"), L.join("\n"));
}

main().catch((e) => { console.error(e); stopBackend(); process.exitCode = 1; });
