/*
 * 圧縮 DICOM のテクスチャ解析（テクスチャマップ・GLAM 解析・ROI 特徴量表）の実機検証スパイク。
 *
 * 実行:  cd automator && OLD_JAR=<変更前の backend jar> npx tsx src/spike/compressedTextureCheck.ts
 *
 *   A. 今の jar（--add-opens あり＝配布物と同じ）: 同じ画素の非圧縮・可逆 4 種・非可逆 2 種のシリーズで、
 *      3 つの計算が可逆は非圧縮と差 0・警告なし、非可逆は計算できて警告あり（マップは DerivationDescription にも）。
 *   B. 今の jar（--add-opens なし＝伸長の部品が使えない）: 圧縮は理由付きで止まり、非圧縮は計算できる。
 *   C. 変更前の jar（OLD_JAR）: 同じ圧縮データが「スライスをデコードできません」で止まる（変更が効いている負例）。
 *   D. 画面（Electron）: 非可逆のシリーズで 3 画面に警告の帯が出る。可逆では出ない。
 *
 * 前提: backend jar（今のビルド）・python3 と pydicom・同梱 dcm4che（~/dcm4che-*）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { waitForBackendReady } from "../backend/healthcheck.js";
import { openFirstSeriesInViewer } from "../checklist/items/shared/helpers.js";
import { createStepRecorder } from "../checklist/types.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "compressed-texture-check");
const NEW_JAR = path.resolve(AUTOMATOR_ROOT, "..", "backend", "target", "graphy-next-backend.jar");
const HTTP = Number(process.env.GRAPHY_AUTOMATOR_HTTP_PORT ?? 18471);
const SCP = Number(process.env.GRAPHY_AUTOMATOR_SCP_PORT ?? 18472);
const ADD_OPENS = ["--add-opens", "java.base/java.io=ALL-UNNAMED", "--add-opens",
  "java.desktop/javax.imageio.stream=ALL-UNNAMED"];

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

interface SeriesInfo {
  seriesInstanceUid: string;
  transferSyntax: string;
  lossy: boolean;
  dir: string;
  frames: { sopInstanceUid: string; imagePositionPatient: number[] }[];
}
interface Synth {
  studyInstanceUid: string;
  frameOfReferenceUID: string;
  rows: number;
  columns: number;
  pixelSpacing: number[];
  sliceThickness: number;
  series: Record<string, SeriesInfo>;
}
const LOSSLESS = ["jpll", "jlsl", "j2kr", "rle"];
const LOSSY = ["jlsn", "j2ki"];

function findDcm2dcm(): string {
  const home = os.homedir();
  const dir = fs.readdirSync(home).filter((n) => n.startsWith("dcm4che-")).sort().pop();
  if (!dir) throw new Error("同梱 dcm4che（~/dcm4che-*）が見つかりません");
  return path.join(home, dir, "bin", "dcm2dcm");
}

function python(args: string[]): unknown {
  const r = spawnSync("python3", ["-I", ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`python ${args[0]}: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

function makeSynth(): Synth {
  const dir = path.join(OUT_DIR, "synth");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const seed = String(Date.now() % 2_000_000_000);
  return python([path.join(import.meta.dirname, "compressedSynth.py"), dir, seed, findDcm2dcm()]) as Synth;
}

async function api<T>(base: string, p: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${base}${p}`, init);
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${p} → HTTP ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}
const post = (body: unknown): RequestInit => ({
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

/** 失敗を例外ではなく値で返す（止まることを確かめる検査のため）。 */
type Outcome<T> = { ok: true; value: T } | { ok: false; error: string };
async function attempt<T>(f: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await f() };
  } catch (e) {
    return { ok: false, error: String(e instanceof Error ? e.message : e) };
  }
}

async function pollJob<T>(base: string, p: string): Promise<T> {
  for (let i = 0; i < 1200; i++) {
    const st = await api<{ state: string; result?: T; error?: string }>(base, p);
    if (st.state === "DONE" && st.result) return st.result;
    if (st.state === "FAILED" || st.state === "CANCELLED") throw new Error(`job ${st.state}: ${st.error}`);
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("job timeout");
}

interface Row { column: string; value: number | null }
interface Features { rows: Row[]; lossyCompressed: boolean }
interface Glam { features: Record<string, number | null>; lossyCompressed: boolean }
interface MapResult { seriesInstanceUid: string; sopInstanceUids: string[]; lossyCompressed: boolean }

const roiFeatures = async (base: string, s: Synth, name: string, seg: string) => {
  const job = await api<{ jobId: string }>(base, "/api/radiomics/features/jobs", post({
    studyInstanceUid: s.studyInstanceUid, sourceSeriesUid: s.series[name].seriesInstanceUid,
    maskSeriesUid: seg, maskChannel: 0, channel: 0, timePoint: 0, settings: {}, recompute: true,
  }));
  return pollJob<Features>(base, `/api/radiomics/features/jobs/${job.jobId}`);
};

const glam = (base: string, s: Synth, name: string, seg: string) =>
  api<Glam>(base, "/api/radiomics/glam/analyze", post({
    studyInstanceUid: s.studyInstanceUid, sourceSeriesUid: s.series[name].seriesInstanceUid,
    maskSeriesUid: seg, maskChannel: 0, channel: 0, timePoint: 0, maxRadius: 4, settings: {},
  }));

const textureMap = async (base: string, s: Synth, name: string, seg: string) => {
  const job = await api<{ jobId: string }>(base, "/api/series/texture/jobs", post({
    studyInstanceUid: s.studyInstanceUid, sourceSeriesUid: s.series[name].seriesInstanceUid,
    maskSeriesUid: seg, maskChannel: 0, feature: "GLCM_JointEntropy", filterSize: 3, stride: 1,
    force2D: false, channel: 0, timePoint: 0, settings: {}, margin: null, seriesDescription: `map ${name}`,
    seriesNumber: null,
  }));
  return pollJob<MapResult>(base, `/api/series/texture/jobs/${job.jobId}`);
};

/** 箱の SEG（全シリーズ同じ位置）。シリーズごとに参照先が違うので 1 本ずつ作る。 */
async function makeSeg(base: string, s: Synth, name: string): Promise<string> {
  const info = s.series[name];
  const frames = info.frames.map((f, z) => {
    if (z < 2 || z >= 6) return { ...f, mask: "" };
    const m = Buffer.alloc(s.rows * s.columns);
    for (let r = 16; r < 48; r++) for (let c = 16; c < 48; c++) m[r * s.columns + c] = 1;
    return { ...f, mask: m.toString("base64") };
  });
  const seg = await api<{ seriesInstanceUid: string }>(base, "/api/dicom/seg", post({
    studyInstanceUid: s.studyInstanceUid, seriesInstanceUid: info.seriesInstanceUid, rows: s.rows,
    columns: s.columns, imageOrientationPatient: [1, 0, 0, 0, 1, 0], pixelSpacing: s.pixelSpacing,
    sliceThickness: s.sliceThickness, frameOfReferenceUID: s.frameOfReferenceUID,
    seriesDescription: `box SEG ${name}`,
    segments: [{ number: 1, label: "Box", color: [255, 0, 0], description: null, frames }],
    producer: null,
  }));
  return seg.seriesInstanceUid;
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

/** backend を Electron なしで起動する（画面の要らない段）。 */
async function startBackend(jar: string, addOpens: boolean, label: string): Promise<ChildProcess> {
  if (!fs.existsSync(jar)) throw new Error(`jar がありません: ${jar}`);
  const dataDir = path.join(OUT_DIR, `data-${label}`);
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
  const log = fs.openSync(path.join(OUT_DIR, `backend-${label}.log`), "w");
  const proc = spawn("java", [...(addOpens ? ADD_OPENS : []), "-jar", jar, "--spring.profiles.active=standalone",
    `--server.port=${HTTP}`, `--graphy.dicom.scp.port=${SCP}`], {
    cwd: dataDir, stdio: ["ignore", log, log], env: { ...process.env, GRAPHY_AUTOMATOR: "1" },
  });
  await waitForBackendReady(HTTP, 120_000);
  return proc;
}

async function stopBackend(proc: ChildProcess): Promise<void> {
  if (proc.exitCode != null) return;
  await new Promise<void>((resolve) => {
    proc.once("exit", () => resolve());
    proc.kill("SIGTERM");
    setTimeout(() => { if (proc.exitCode == null) proc.kill("SIGKILL"); }, 15_000);
  });
}

const sameRows = (a: Row[], b: Row[]) =>
  a.length === b.length && a.every((r, i) => r.column === b[i].column && Object.is(r.value, b[i].value));
const sameFeatures = (a: Record<string, number | null>, b: Record<string, number | null>) => {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return ka.length > 0 && ka.join() === kb.join() && ka.every((k) => Object.is(a[k], b[k]));
};

async function phaseNew(s: Synth): Promise<void> {
  console.log("\n[A] 今の jar（伸長の部品あり）");
  const proc = await startBackend(NEW_JAR, true, "new");
  const base = `http://127.0.0.1:${HTTP}`;
  try {
    await resetDb(HTTP);
    await importPaths(HTTP, Object.values(s.series).map((x) => x.dir));
    for (const [name, info] of Object.entries(s.series)) {
      await download(base, [info.frames[0].sopInstanceUid], path.join(OUT_DIR, "stored", name));
      const ts = (python([path.join(import.meta.dirname, "compressedCompare.py"), "ts",
        path.join(OUT_DIR, "stored", name)]) as { transferSyntaxes: string[] }).transferSyntaxes;
      check(ts.length === 1 && ts[0] === info.transferSyntax, `${name}: 保管庫のファイルは ${info.transferSyntax} のまま`, ts);
    }
    const segs: Record<string, string> = {};
    for (const name of Object.keys(s.series)) segs[name] = await makeSeg(base, s, name);

    const ref = {
      features: await roiFeatures(base, s, "raw", segs.raw),
      glam: await glam(base, s, "raw", segs.raw),
      map: await textureMap(base, s, "raw", segs.raw),
    };
    await download(base, ref.map.sopInstanceUids, path.join(OUT_DIR, "maps", "raw"));
    check(!ref.features.lossyCompressed && !ref.glam.lossyCompressed && !ref.map.lossyCompressed,
      "raw: 非圧縮は警告なし");
    check(ref.features.rows.length >= 150 && Object.keys(ref.glam.features).length >= 100, "raw: 基準が計算できる",
      { rows: ref.features.rows.length, glam: Object.keys(ref.glam.features).length });

    for (const name of [...LOSSLESS, ...LOSSY]) {
      const lossy = LOSSY.includes(name);
      const f = await attempt(() => roiFeatures(base, s, name, segs[name]));
      const g = await attempt(() => glam(base, s, name, segs[name]));
      const m = await attempt(() => textureMap(base, s, name, segs[name]));
      if (!f.ok || !g.ok || !m.ok) {
        check(false, `${name}: 3 つとも計算できる`, { f: f.ok || f.error, g: g.ok || g.error, m: m.ok || m.error });
        continue;
      }
      await download(base, m.value.sopInstanceUids, path.join(OUT_DIR, "maps", name));
      const cmp = python([path.join(import.meta.dirname, "compressedCompare.py"), "maps",
        path.join(OUT_DIR, "maps", "raw"), path.join(OUT_DIR, "maps", name)]) as
        { maxDiff: number | null; slices: number; derivation: string };
      const flags = [f.value.lossyCompressed, g.value.lossyCompressed, m.value.lossyCompressed];
      if (!lossy) {
        check(sameRows(ref.features.rows, f.value.rows), `${name}: ROI 特徴量表が非圧縮と全行で差 0`);
        check(sameFeatures(ref.glam.features, g.value.features), `${name}: GLAM 解析が非圧縮と全特徴で差 0`);
        check(cmp.maxDiff === 0 && cmp.slices === s.series.raw.frames.length,
          `${name}: テクスチャマップが非圧縮と全画素で差 0`, cmp);
        check(flags.every((x) => x === false) && !cmp.derivation.includes("lossy"), `${name}: 可逆は警告なし`,
          { flags, derivation: cmp.derivation });
      } else {
        check(flags.every((x) => x === true), `${name}: 非可逆は 3 つとも警告あり`, flags);
        check(cmp.derivation.includes("source: lossy compressed"), `${name}: マップの DerivationDescription に記録`,
          cmp.derivation);
        check(!sameRows(ref.features.rows, f.value.rows), `${name}: 値は非圧縮と違う（本当に非可逆の例になっている）`);
      }
    }
  } finally {
    await stopBackend(proc);
  }
}

async function phaseNoNative(s: Synth): Promise<void> {
  console.log("\n[B] 今の jar（--add-opens なし＝伸長の部品が使えない）");
  const proc = await startBackend(NEW_JAR, false, "nonative");
  const base = `http://127.0.0.1:${HTTP}`;
  try {
    await resetDb(HTTP);
    await importPaths(HTTP, [s.series.raw.dir, s.series.jpll.dir]);
    const segRaw = await makeSeg(base, s, "raw");
    const segJpll = await makeSeg(base, s, "jpll");
    const f = await attempt(() => roiFeatures(base, s, "jpll", segJpll));
    check(!f.ok && f.error.includes("圧縮画像の伸長に必要な部品がありません") && f.error.includes("--add-opens"),
      "部品なし: ROI 特徴量表は理由付きで止まる", f.ok ? "計算できてしまった" : f.error);
    const m = await attempt(() => textureMap(base, s, "jpll", segJpll));
    check(!m.ok && m.error.includes("圧縮画像の伸長に必要な部品がありません"), "部品なし: テクスチャマップも止まる（空のマップを作らない）",
      m.ok ? m.value.seriesInstanceUid : m.error);
    const series = await api<{ seriesInstanceUid: string }[]>(base, `/api/studies/${s.studyInstanceUid}/series`);
    check(!series.some((x) => (x as { seriesDescription?: string }).seriesDescription === "map jpll"),
      "部品なし: 派生シリーズは作られていない");
    const r = await attempt(() => roiFeatures(base, s, "raw", segRaw));
    check(r.ok, "部品なし: 非圧縮は計算できる", r.ok ? undefined : r.error);
  } finally {
    await stopBackend(proc);
  }
}

async function phaseOld(s: Synth): Promise<void> {
  console.log("\n[C] 変更前の jar");
  const jar = process.env.OLD_JAR;
  if (!jar) {
    check(false, "OLD_JAR が指定されていない（未達）");
    return;
  }
  const proc = await startBackend(jar, true, "old");
  const base = `http://127.0.0.1:${HTTP}`;
  try {
    await resetDb(HTTP);
    await importPaths(HTTP, [s.series.raw.dir, s.series.jpll.dir, s.series.rle.dir]);
    for (const name of ["jpll", "rle"]) {
      const seg = await makeSeg(base, s, name);
      const f = await attempt(() => roiFeatures(base, s, name, seg));
      check(!f.ok && f.error.includes("スライスをデコードできません"), `旧コード: ${name} は「スライスをデコードできません」で止まる`,
        f.ok ? "計算できてしまった" : f.error);
    }
    const seg = await makeSeg(base, s, "raw");
    const r = await attempt(() => roiFeatures(base, s, "raw", seg));
    check(r.ok, "旧コード: 非圧縮は計算できる（比べ方が効いている）", r.ok ? undefined : r.error);
  } finally {
    await stopBackend(proc);
  }
}

async function phaseUi(s: Synth): Promise<void> {
  console.log("\n[D] 画面（非可逆のシリーズで 3 画面に警告）");
  const d = new DesktopDriver();
  await d.start();
  const base = `http://127.0.0.1:${d.ports.http}`;
  try {
    await resetDb(d.ports.http);
    // ビューアで開くシリーズ（テクスチャマップの対象）を非可逆にするため、先に非可逆だけを入れる。
    // シリーズ番号順に並ぶので、可逆（番号が小さい）はビューアを開いた後に入れる。
    await importPaths(d.ports.http, [s.series.j2ki.dir]);
    const segLossy = await makeSeg(base, s, "j2ki");

    const mainPage = d.page;
    await mainPage.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    await mainPage.waitForTimeout(2000);
    const later = mainPage.getByRole("button", { name: /^(後で|Later)$/ });
    if (await later.isVisible().catch(() => false)) await later.click();
    await mainPage.evaluate("localStorage.setItem('graphy.locale', 'ja')");
    await openFirstSeriesInViewer(mainPage, createStepRecorder());
    const viewer = await d.waitForNewPage(
      () => mainPage.getByTestId("viewer2d-toolbar-button").click(),
      (url) => url.includes("2dviewer"),
    );
    await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 20_000 });
    await viewer.waitForTimeout(2000);
    await importPaths(d.ports.http, [s.series.jpll.dir]);
    const segLossless = await makeSeg(base, s, "jpll");

    // ROI 特徴量表
    await viewer.getByTestId("viewer2d-menu-analysis").click();
    const feat = await d.waitForNewPage(() => viewer.getByTestId("menu-roi-features").click(),
      (url) => url.includes("#radiomics-features"));
    await feat.getByTestId("roifeat-mask").waitFor({ state: "visible", timeout: 20_000 });
    await feat.waitForTimeout(1500);
    const selectFeat = async (series: string, seg: string) => {
      await feat.locator("select").nth(0).selectOption(series);
      await feat.waitForTimeout(800);
      await feat.getByTestId("roifeat-mask").selectOption(seg);
      await feat.waitForTimeout(800);
      await feat.getByTestId("roifeat-run").click();
      try {
        await feat.getByTestId("roifeat-summary").waitFor({ state: "visible", timeout: 300_000 });
      } catch (e) {
        await feat.screenshot({ path: path.join(OUT_DIR, "ui-fail-roifeat.png") });
        const err = await feat.getByTestId("roifeat-error").innerText().catch(() => "(no error element)");
        throw new Error(`ROI 特徴量表の結果が出ない: ${err}`);
      }
      await feat.waitForTimeout(800);
    };
    await selectFeat(s.series.j2ki.seriesInstanceUid, segLossy);
    check(await feat.getByTestId("roifeat-lossy-warning").isVisible(), "画面: ROI 特徴量表に警告の帯（非可逆）");
    await feat.screenshot({ path: path.join(OUT_DIR, "ui-01-roifeat-lossy.png") });
    await selectFeat(s.series.jpll.seriesInstanceUid, segLossless);
    await feat.waitForTimeout(1500);
    const lossyBandAfter = await feat.getByTestId("roifeat-lossy-warning").count();
    const summary = await feat.getByTestId("roifeat-summary").innerText();
    check(lossyBandAfter === 0 && summary.length > 0, "画面: 可逆のシリーズでは帯が出ない", { lossyBandAfter, summary });
    await feat.screenshot({ path: path.join(OUT_DIR, "ui-02-roifeat-lossless.png") });

    // GLAM 解析
    await viewer.bringToFront();
    await viewer.getByTestId("viewer2d-menu-analysis").click();
    const glamPage = await d.waitForNewPage(() => viewer.getByText(/^GLAM 解析…$|^GLAM analysis…$/).click(),
      (url) => url.includes("#glam"));
    await glamPage.waitForTimeout(2000);
    await glamPage.locator("select").nth(0).selectOption(s.series.j2ki.seriesInstanceUid);
    await glamPage.waitForTimeout(800);
    await glamPage.locator("select").nth(1).selectOption(segLossy);
    await glamPage.waitForTimeout(800);
    await glamPage.getByRole("button", { name: /^(解析|Analyze)$/ }).click();
    await glamPage.getByTestId("glam-lossy-warning").waitFor({ state: "visible", timeout: 300_000 })
      .then(() => check(true, "画面: GLAM 解析に警告（非可逆）"))
      .catch(() => check(false, "画面: GLAM 解析に警告（非可逆）"));
    await glamPage.screenshot({ path: path.join(OUT_DIR, "ui-03-glam-lossy.png") });

    // テクスチャマップ（ダイアログ）
    await viewer.bringToFront();
    await viewer.getByTestId("viewer2d-menu-analysis").click();
    await viewer.getByText(/^テクスチャ…$|^Texture…$/).click();
    await viewer.getByRole("button", { name: /^(マップ生成|Generate map)$/ }).click();
    await viewer.getByTestId("texture-lossy-warning").waitFor({ state: "visible", timeout: 600_000 })
      .then(() => check(true, "画面: テクスチャマップのダイアログに警告（非可逆）"))
      .catch(() => check(false, "画面: テクスチャマップのダイアログに警告（非可逆）"));
    await viewer.screenshot({ path: path.join(OUT_DIR, "ui-04-texture-lossy.png") });
  } finally {
    await d.stop();
  }
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const s = makeSynth();
  console.log(`  synth: ${Object.keys(s.series).join(", ")}`);
  // ONLY_UI=1 で画面の段だけを走らせる（画面の調整用）
  if (process.env.ONLY_UI !== "1") {
    await phaseNew(s);
    await phaseNoNative(s);
    await phaseOld(s);
  }
  await phaseUi(s);
  console.log(`\n  結果: ${passed} ok / ${failures.length} fail`);
  if (failures.length) {
    for (const f of failures) console.log(`   - ${f}`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

