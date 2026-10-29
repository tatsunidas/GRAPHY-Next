/*
 * キャッシュの改ざん・劣化の検出（Checkpoints 版 2）の実機検証スパイク。UI は通さず、実際の backend の API と
 * キャッシュのファイルだけで確かめる。
 *
 * 実行:  cd automator && GRAPHY_AUTOMATOR_HTTP_PORT=18290 GRAPHY_AUTOMATOR_SCP_PORT=18291 \
 *          GRAPHY_AUTOMATOR_VITE_PORT=18293 timeout 900 npx tsx src/spike/roiFeatureCacheIntegrityCheck.ts
 *
 *   1. 合成 CT 1 検査＋SEG（2 セグメント）を取り込み、2 つの ROI の特徴量を API で計算する（キャッシュのファイルが 2 つできる）。
 *   2. 保存されたファイルが版 2（ヘッダ 16 バイト＋本体＋SHA-256 32 バイト）であること。
 *   3. 片方の本体の数字を 1 文字、別の数字に書き換える（JSON としては読めたまま）→ 同じ要求を再実行すると、
 *      その組だけが再計算（fromCache=false）され、値は元と全列で一致する。もう片方は fromCache=true のまま。
 *      3 回目は、どちらも fromCache=true（作り直したキャッシュが使える）。
 *   4. もう片方の末尾のチェックサムを 1 ビット反転 → 再計算され、値は元と一致する。
 *
 * 前提: backend jar（今のビルド）・python3 と pydicom。
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { DesktopDriver, DESKTOP_RUN_DATA_DIR } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "roi-feature-cache-integrity-check");

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
interface Row { column: string; value: number | null }
interface Result { fromCache: boolean; rows: Row[] }
interface Box { r0: number; r1: number; c0: number; c1: number; z0: number; z1: number }
const SEG1: Box = { r0: 12, r1: 36, c0: 10, c1: 34, z0: 3, z1: 13 };
const SEG2: Box = { r0: 30, r1: 40, c0: 36, c1: 46, z0: 5, z1: 9 };

function makeSynth(): Synth & { dir: string } {
  const dir = path.join(OUT_DIR, "synth");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const seed = String(Date.now() % 2_000_000_000);
  const r = spawnSync("python3", ["-I", path.join(import.meta.dirname, "roiFeatureSynth.py"), dir, seed], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`合成データを作れません: ${r.stderr}`);
  return { ...(JSON.parse(r.stdout) as Synth), dir };
}

function boxFrames(s: Synth, b: Box) {
  return s.frames.map((f, z) => {
    if (z < b.z0 || z >= b.z1) return { ...f, mask: "" };
    const m = Buffer.alloc(s.rows * s.columns);
    for (let r = b.r0; r < b.r1; r++) for (let c = b.c0; c < b.c1; c++) m[r * s.columns + c] = 1;
    return { ...f, mask: m.toString("base64") };
  });
}

async function api<T>(base: string, p: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${base}${p}`, init);
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${p} → HTTP ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}
const post = <T>(base: string, p: string, body: unknown) =>
  api<T>(base, p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

async function features(base: string, body: Record<string, unknown>): Promise<Result> {
  const s = await post<{ jobId: string }>(base, "/api/radiomics/features/jobs", body);
  for (let i = 0; i < 600; i++) {
    const st = await api<{ state: string; result?: Result; error?: string }>(base, `/api/radiomics/features/jobs/${s.jobId}`);
    if (st.state === "DONE" && st.result) return st.result;
    if (st.state === "FAILED" || st.state === "CANCELLED") throw new Error(`job ${st.state}: ${st.error}`);
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("job timeout");
}

/** 実行用のデータディレクトリの中の .ckpt を、実行時に探す（保存先の既定が相対パスのため）。 */
function ckptFiles(): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".ckpt") && !e.name.startsWith(".tmp-")) out.push(p);
    }
  };
  if (fs.existsSync(DESKTOP_RUN_DATA_DIR)) walk(DESKTOP_RUN_DATA_DIR);
  return out;
}

const sameValues = (a: Result, b: Result) =>
  a.rows.length === b.rows.length && a.rows.every((r, i) => r.column === b.rows[i].column && Object.is(r.value ?? NaN, b.rows[i].value ?? NaN));

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const synth = makeSynth();
  const d = new DesktopDriver();
  await d.start();
  const base = `http://127.0.0.1:${d.ports.http}`;
  try {
    console.log(`  reset: ${JSON.stringify(await resetDb(d.ports.http))}`);
    console.log(`  import: ${JSON.stringify(await importPaths(d.ports.http, [synth.dir]))}`);
    const seg = await post<{ seriesInstanceUid: string }>(base, "/api/dicom/seg", {
      studyInstanceUid: synth.studyInstanceUid, seriesInstanceUid: synth.seriesInstanceUid, rows: synth.rows, columns: synth.columns,
      imageOrientationPatient: [1, 0, 0, 0, 1, 0], pixelSpacing: synth.pixelSpacing, sliceThickness: synth.sliceThickness,
      frameOfReferenceUID: synth.frameOfReferenceUID, seriesDescription: "synthetic two-box SEG",
      segments: [
        { number: 1, label: "BigBox", color: [255, 0, 0], description: null, frames: boxFrames(synth, SEG1) },
        { number: 2, label: "SmallBox", color: [0, 255, 0], description: null, frames: boxFrames(synth, SEG2) },
      ],
      producer: null,
    });
    const req = (maskChannel: number) => ({
      studyInstanceUid: synth.studyInstanceUid, sourceSeriesUid: synth.seriesInstanceUid, maskSeriesUid: seg.seriesInstanceUid,
      maskChannel, channel: 0, timePoint: 0, settings: { INT_binCount: "16" }, recompute: false,
    });

    console.log("\n[1] 2 つの ROI を計算（キャッシュのファイルが 2 つできる）");
    const before = new Set(ckptFiles());
    const a1 = await features(base, req(0));
    const afterA = ckptFiles().filter((f) => !before.has(f));
    const b1 = await features(base, req(1));
    const afterB = ckptFiles().filter((f) => !before.has(f) && !afterA.includes(f));
    check(!a1.fromCache && !b1.fromCache, "1 回目はどちらも新しく計算");
    check(afterA.length === 1 && afterB.length === 1, "キャッシュのファイルが 1 つずつできる", { a: afterA.length, b: afterB.length });
    const [fileA] = afterA;
    const [fileB] = afterB;

    console.log("\n[2] 保存されたファイルの形（版 2）");
    for (const [name, f] of [["A", fileA], ["B", fileB]] as const) {
      const raw = fs.readFileSync(f);
      const len = Number(raw.readBigInt64BE(8));
      check(raw.readInt32BE(0) === 0x47434b50 && raw.readInt32BE(4) === 2 && raw.length === 16 + len + 32,
        `${name}: ヘッダ（GCKP・版 2）・本体の長さ・末尾の 32 バイト`, { size: raw.length, len });
    }

    console.log("\n[3] 本体の数字を 1 文字書き換える（JSON として読めたまま）");
    const rawA = fs.readFileSync(fileA);
    const bodyA = rawA.subarray(16, rawA.length - 32).toString("utf8");
    const at = bodyA.indexOf('"value":');
    let digit = -1;
    for (let i = at + 8; i < bodyA.length; i++) if (/[0-9]/.test(bodyA[i])) { digit = i; break; }
    check(at >= 0 && digit > 0, "本体に値の数字がある");
    const before1 = bodyA[digit];
    rawA[16 + digit] = (before1 === "7" ? "3" : "7").charCodeAt(0);
    fs.writeFileSync(fileA, rawA);
    const parsed = (() => { try { JSON.parse(rawA.subarray(16, rawA.length - 32).toString("utf8")); return true; } catch { return false; } })();
    check(parsed, "書き換えたあとも JSON として読める（長さ・ヘッダの検査だけでは見つからない化け）");

    const a2 = await features(base, req(0));
    const b2 = await features(base, req(1));
    check(!a2.fromCache, "書き換えた組は、キャッシュを使わず再計算された（fromCache=false）");
    check(sameValues(a1, a2), "再計算した値は、元と全列で一致する");
    check(b2.fromCache && sameValues(b1, b2), "書き換えていない組は、キャッシュのまま（fromCache=true）で値も同じ");
    const a3 = await features(base, req(0));
    check(a3.fromCache && sameValues(a1, a3), "3 回目は、作り直したキャッシュが使える（fromCache=true）");
    check(fs.readFileSync(fileA).readInt32BE(4) === 2, "作り直したファイルも版 2");

    console.log("\n[4] 末尾のチェックサムを 1 ビット反転");
    const rawB = fs.readFileSync(fileB);
    rawB[rawB.length - 1] ^= 0x01;
    fs.writeFileSync(fileB, rawB);
    const b3 = await features(base, req(1));
    check(!b3.fromCache && sameValues(b1, b3), "チェックサムが化けた組も再計算され、値は元と一致する");
    const b4 = await features(base, req(1));
    check(b4.fromCache, "そのあとはキャッシュが使える");
  } finally {
    await d.stop();
  }
  console.log(`\n合格 ${passed} / 失敗 ${failures.length}${failures.length ? `\n  失敗: ${failures.join(" / ")}` : ""}`);
  process.exitCode = failures.length ? 1 : 0;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
