/*
 * 一括抽出の無人実行 CLI（desktop/batchCli.js）の実プロセス検査。
 *
 * 実行:  cd automator && GRAPHY_AUTOMATOR_HTTP_PORT=18290 GRAPHY_AUTOMATOR_SCP_PORT=18291 GRAPHY_AUTOMATOR_VITE_PORT=18293 \
 *          npx tsx src/spike/batchCliRealCheck.ts          （Windows で pydicom が利用者領域なら GRAPHY_SPIKE_PYTHON_USERSITE=1）
 *
 *   1. 画面（実アプリ）で合成データと定義 2 つ（VOI 統計・特徴量）の表を作る（比較の基準）。
 *   2. 画面が同じ DB を開いている間に CLI を動かすと、backend を起動せず終了コード 5（使用中）で終わる。
 *   3. 画面を閉じて（backend を止めて）から、CLI（node と Electron 同梱の Node）が自前で backend を起動して
 *      定義を順に実行する。失敗する定義が混ざっても残りは続き（終了コード 1）、完了した定義の 5 ファイルは画面の出力とバイト一致。
 *      --recompute（キャッシュを使わない初回計算）でも、抽出時刻の列を除いて画面の出力と一致し、VOI 統計は予測値と一致する。
 *   4. 負例: 改変した定義→3（backend を起動する前に断り、何も書かない）、存在しないアルバム→3。終了後に CLI の backend のポートが空く。
 *
 * 専用ポート（上の環境変数）。前提: backend jar（今のビルド）、frontend の npm run build:batch-cli。合成データ（2 検査 × 箱 2 つ）。
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { Page } from "@playwright/test";

import { DesktopDriver, DESKTOP_RUN_DATA_DIR } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { dismissUpdateDialog } from "./dismissUpdateDialog.js";
import { PY, PY_FLAGS } from "./pythonCmd.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "batch-cli-real-check");
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
  studyInstanceUid: string; seriesInstanceUid: string; frameOfReferenceUID: string;
  rows: number; columns: number; pixelSpacing: number[]; sliceThickness: number;
  frames: { sopInstanceUid: string; imagePositionPatient: number[] }[];
}
interface Box { r0: number; r1: number; c0: number; c1: number; z0: number; z1: number }
const BIG: Box = { r0: 12, r1: 36, c0: 10, c1: 34, z0: 3, z1: 13 };
const SMALL: Box = { r0: 30, r1: 40, c0: 36, c1: 46, z0: 5, z1: 9 };
const VOXEL_MM3 = 0.7 * 0.7 * 2.0;
const STAT_COLUMNS = [
  "IntensityBasedStatistical_Mean", "IntensityBasedStatistical_StandardDeviation", "IntensityBasedStatistical_Minimum",
  "IntensityBasedStatistical_Maximum", "IntensityBasedStatistical_Median",
];

function makeSynth(i: number): Synth & { dir: string } {
  const dir = path.join(OUT_DIR, `synth${i}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const seed = String((Date.now() + i * 7919) % 2_000_000_000);
  const r = spawnSync(PY, [...PY_FLAGS, path.join(import.meta.dirname, "roiFeatureSynth.py"), dir, seed, "-1000", `SYNTHVOI-${i}`], { encoding: "utf8" });
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

async function post<T>(base: string, p: string, body: unknown): Promise<T> {
  const res = await fetch(`${base}${p}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`POST ${p} → HTTP ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

function splitRow(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { out.push(cur); cur = ""; } else cur += c;
  }
  out.push(cur);
  return out;
}

interface Download { name: string; text: string }
async function takeDownloads(page: Page, n: number): Promise<Download[]> {
  for (let i = 0; i < 50; i++) {
    if (((await page.evaluate("window.__roiDownloads.length")) as number) >= n) break;
    await page.waitForTimeout(200);
  }
  return (await page.evaluate("window.__roiDownloads.splice(0)")) as Download[];
}

async function waitText(page: Page, testId: string, re: RegExp, timeoutMs: number): Promise<string> {
  const t0 = Date.now();
  let last = "";
  while (Date.now() - t0 < timeoutMs) {
    last = await page.getByTestId(testId).innerText().catch(() => "");
    if (re.test(last)) return last;
    const err = await page.getByTestId("batch-error").innerText().catch(() => "");
    if (err) {
      await page.screenshot({ path: path.join(OUT_DIR, "99-error.png"), fullPage: true }).catch(() => {});
      throw new Error(`画面のエラー: ${err}`);
    }
    await page.waitForTimeout(250);
  }
  await page.screenshot({ path: path.join(OUT_DIR, "99-timeout.png"), fullPage: true }).catch(() => {});
  throw new Error(`「${re}」にならない: ${last}`);
}

/** 定義の SHA-256 の表示は非同期のハッシュ計算の後で更新されるので、変わるまで（最大 5 秒）待つ。 */
async function shaTitle(page: Page, notEqual?: string): Promise<string> {
  let v = "";
  for (let i = 0; i < 100; i++) {
    v = (await page.getByTestId("batch-spec-sha").getAttribute("title")) ?? "";
    if (v && v !== notEqual) return v;
    await page.waitForTimeout(50);
  }
  return v;
}

function predict(dir: string): Record<string, { n: number; mean: number; sd: number; min: number; max: number; median: number }> {
  const boxes = { BigBox: [BIG.r0, BIG.r1, BIG.c0, BIG.c1, BIG.z0, BIG.z1], SmallBox: [SMALL.r0, SMALL.r1, SMALL.c0, SMALL.c1, SMALL.z0, SMALL.z1] };
  const r = spawnSync(PY, [...PY_FLAGS, path.join(import.meta.dirname, "voiStatsPredict.py"), dir, JSON.stringify(boxes)], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`予測を作れません: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

const close = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));




const REPO = path.resolve(AUTOMATOR_ROOT, "..");
const CLI = path.join(REPO, "desktop", "batchCli.js");
const ELECTRON_EXE = path.join(REPO, "desktop", "node_modules", "electron", "dist", process.platform === "win32" ? "electron.exe" : "electron");
const DATA_DIR = DESKTOP_RUN_DATA_DIR;
const LOCK = path.join(DATA_DIR, "data", "graphy-index.lock.db");

interface Run { code: number; stdout: string; stderr: string }
function runCli(mode: "node" | "electron", args: string[]): Run {
  const exe = mode === "node" ? process.execPath : ELECTRON_EXE;
  const env = mode === "node" ? { ...process.env } : { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
  const r = spawnSync(exe, [CLI, ...args], { encoding: "utf8", env, timeout: 420_000 });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function portOf(stdout: string): number | null {
  const m = /port (\d+)/.exec(stdout);
  return m ? Number(m[1]) : null;
}
async function portFree(port: number): Promise<boolean> {
  for (let i = 0; i < 20; i++) {
    const up = await fetch(`http://127.0.0.1:${port}/api/status`).then(() => true, () => false);
    if (!up) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function maskedCsv(text: string): string[][] {
  const lines = text.replace(/^﻿/, "").split("\r\n").filter(Boolean).map(splitRow);
  const skip = lines[0].map((h, i) => (/ExtractedAt/.test(h) ? i : -1)).filter((i) => i >= 0);
  return lines.map((r) => r.map((c, i) => (skip.includes(i) ? "" : c)));
}
function sameFile(name: string, a: string, b: string): boolean {
  if (a === b) return true;
  return name.endsWith(".csv") && JSON.stringify(maskedCsv(a)) === JSON.stringify(maskedCsv(b));
}
const readDir = (dir: string): Map<string, string> =>
  new Map((fs.existsSync(dir) ? fs.readdirSync(dir) : []).map((n) => [n, fs.readFileSync(path.join(dir, n), "utf8")]));

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  // 前回の出力が残っていると「何も書かない」の検査が前回の物を見てしまう
  for (const n of fs.readdirSync(OUT_DIR)) if (n.startsWith("cli-")) fs.rmSync(path.join(OUT_DIR, n), { recursive: true, force: true });
  const built = spawnSync("npm", ["run", "build:batch-cli"], { cwd: path.join(REPO, "frontend"), encoding: "utf8", shell: true });
  check(built.status === 0 && fs.existsSync(path.join(REPO, "desktop", "batch-cli", "run.cjs")), "frontend の npm run build:batch-cli が通る", built.stderr.slice(0, 200));

  const synths = [0, 1].map(makeSynth);
  const d = new DesktopDriver();
  await d.start();
  const base = `http://127.0.0.1:${d.ports.http}`;
  const gui: Record<string, Download[]> = {};
  const specSha: Record<string, string> = {};
  let albumName = "";
  try {
    await resetDb(d.ports.http);
    for (const s of synths) await importPaths(d.ports.http, [s.dir]);
    for (const s of synths) {
      await post(base, "/api/dicom/seg", {
        studyInstanceUid: s.studyInstanceUid, seriesInstanceUid: s.seriesInstanceUid, rows: s.rows, columns: s.columns,
        imageOrientationPatient: [1, 0, 0, 0, 1, 0], pixelSpacing: s.pixelSpacing, sliceThickness: s.sliceThickness,
        frameOfReferenceUID: s.frameOfReferenceUID, seriesDescription: "synthetic two-box SEG",
        segments: [
          { number: 1, label: "BigBox", color: [255, 0, 0], description: null, frames: boxFrames(s, BIG) },
          { number: 2, label: "SmallBox", color: [0, 255, 0], description: null, frames: boxFrames(s, SMALL) },
        ],
        producer: null,
      });
    }
    albumName = `cli-real-${Date.now()}`;
    const album = await post<{ id: number }>(base, "/api/albums", { name: albumName });
    await post(base, `/api/albums/${album.id}/studies`, { studyUids: synths.map((s) => s.studyInstanceUid) });

    const page = d.page;
    page.on("console", (m) => {
      if (m.type() === "error") console.log(`  [renderer error] ${m.text()}`);
    });
    await page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    await page.waitForTimeout(2000);
    const later = page.getByRole("button", { name: /^(後で|Later)$/ });
    if (await later.isVisible().catch(() => false)) {
      await later.click();
      await page.waitForTimeout(500);
    }
    await page.evaluate("localStorage.setItem('graphy.locale', 'ja')");
    await page.reload();
    await page.getByTestId("album-select").waitFor({ state: "visible", timeout: 60_000 });
    await page.evaluate(`
      (function () {
        window.__roiDownloads = [];
        var orig = HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click = function () {
          var a = this;
          if (a.download && a.href.indexOf("blob:") === 0) {
            var name = a.download;
            fetch(a.href).then(function (r) { return r.arrayBuffer(); }).then(function (buf) {
              window.__roiDownloads.push({ name: name, text: new TextDecoder("utf-8", { ignoreBOM: true }).decode(buf) });
            });
            return;
          }
          return orig.call(this);
        };
      })()
    `);
    await page.getByTestId("album-select").selectOption(String(album.id));
    await page.waitForTimeout(800);
    await dismissUpdateDialog(page);
    await page.getByTestId("album-batch-button").click();
    await page.getByTestId("batch-dialog").waitFor({ state: "visible", timeout: 20_000 });
    await page.getByTestId("batch-row-3").waitFor({ state: "visible", timeout: 30_000 });
    await page.waitForTimeout(1000);

    console.log("\n[1] 画面で定義を保存し、同じ定義で画面の単独実行の表を作る（比較の基準）");
    const saveSpec = async (file: string): Promise<string> => {
      await page.getByTestId("batch-spec-save").click();
      const [saved] = await takeDownloads(page, 1);
      fs.writeFileSync(path.join(OUT_DIR, file), saved.text);
      return (JSON.parse(saved.text) as { sha256: string }).sha256;
    };
    await page.getByTestId("batch-prefix").fill("r1voi");
    await page.getByTestId("batch-kind-voiStats").check();
    specSha.r1voi = await saveSpec("r1_spec.json");
    await page.getByTestId("batch-kind-radiomics").check();
    await page.getByTestId("batch-prefix").fill("r2rad");
    specSha.r2rad = await saveSpec("r2_spec.json");
    await page.getByTestId("batch-labels").fill("Nothing");
    await page.getByTestId("batch-prefix").fill("r3none");
    specSha.r3none = await saveSpec("r3_spec.json");
    await page.getByTestId("batch-labels").fill("");
    for (const [name, file] of [["r1voi", "r1_spec.json"], ["r2rad", "r2_spec.json"]] as const) {
      await page.getByTestId("batch-spec-file").setInputFiles(path.join(OUT_DIR, file));
      await waitText(page, "batch-info", /読み込みました/, 20_000);
      await page.getByTestId("batch-run").click();
      await waitText(page, "batch-progress", /完了 — 4\/4 完了/, 300_000);
      await page.getByTestId("batch-write").click();
      gui[name] = await takeDownloads(page, 5);
      check(gui[name].length === 5, `${name}: 画面の書き出しが 5 ファイル`, gui[name].map((f) => f.name));
    }
    const tampered = JSON.parse(fs.readFileSync(path.join(OUT_DIR, "r2_spec.json"), "utf8")) as { form: { binCount: number } };
    tampered.form.binCount += 1;
    fs.writeFileSync(path.join(OUT_DIR, "r_tampered_spec.json"), JSON.stringify(tampered));

    console.log("\n[2] 画面が同じ DB を開いている間は、CLI は起動せず終了コード 5");
    check(fs.existsSync(LOCK), "画面の backend が動いている間、H2 のロックファイルがある", LOCK);
    const busy = runCli("node", ["--album", albumName, "--spec", path.join(OUT_DIR, "r1_spec.json"), "--out", path.join(OUT_DIR, "cli-busy"), "--data-dir", DATA_DIR]);
    check(busy.code === 5 && /使用中/.test(busy.stderr), "使用中は終了コード 5（アプリを閉じるよう案内）", { code: busy.code, stderr: busy.stderr.slice(0, 200) });
    check(!busy.stdout.includes("backend を起動します") && !fs.existsSync(path.join(OUT_DIR, "cli-busy")), "使用中のときは backend を起動せず、何も書かない");
  } finally {
    await d.stop();
  }

  // 画面の backend を強制終了したので、ロックファイルは残っているが、宛先は閉じている（残っているだけ＝使用中ではない）
  console.log("\n[3] 画面を閉じたあと、CLI が自前で backend を起動して実行する");
  check(fs.existsSync(LOCK), "強制終了のあともロックファイルは残っている（残っているだけのロックでも CLI は通る、の前提）");
  await new Promise((r) => setTimeout(r, 1_000));
  const predicted = new Map(synths.map((s) => [s.studyInstanceUid, predict(s.dir)]));
  const args = (specs: string[], out: string, extra: string[] = [], album = albumName) =>
    ["--album", album, ...specs.flatMap((s) => ["--spec", path.join(OUT_DIR, s)]), "--out", path.join(OUT_DIR, out), "--data-dir", DATA_DIR, ...extra];

  // A: node、失敗する定義（存在しないセグメント名）が真ん中
  const outA = path.join(OUT_DIR, "cli-node-a");
  fs.rmSync(outA, { recursive: true, force: true });
  const A = runCli("node", args(["r1_spec.json", "r3_spec.json", "r2_spec.json"], "cli-node-a"));
  check(A.code === 1, "node: 失敗する定義が混ざると終了コード 1", { code: A.code, stderr: A.stderr.slice(0, 300), stdout: A.stdout.slice(-300) });
  const filesA = readDir(outA);
  for (const name of ["r1voi", "r2rad"] as const) {
    const ref = gui[name];
    check(ref.every((f) => filesA.has(f.name) && sameFile(f.name, f.text, filesA.get(f.name)!)), `node: ${name} の 5 ファイルが画面の出力と一致`);
    check(ref.every((f) => filesA.get(f.name) === f.text), `node: ${name} は（キャッシュに当たるので）バイトまで一致`);
  }
  check(![...filesA.keys()].some((n) => n.startsWith("r3none")), "失敗した定義の表は書かれない");
  const repA = JSON.parse(filesA.get("batch-cli-report.json") ?? "{}") as { exitCode: number; specs: { prefix: string; state: string; sha256: string; files: string[] }[]; album: { name: string } };
  check(repA.exitCode === 1 && repA.specs.map((s) => s.state).join() === "done,failed,done", "報告 JSON: 状態が done,failed,done・終了コード 1", repA.specs?.map((s) => s.state));
  check(repA.specs.every((s) => s.sha256 === specSha[s.prefix]) && repA.album.name === albumName, "報告 JSON: 定義の SHA-256 とアルバム名が正しい");
  const portA = portOf(A.stdout);
  check(portA !== null && (await portFree(portA)), "終了後に CLI の backend のポートが空く（失敗を含む実行）", portA);
  const runtimeA = A.stdout.split("\n").find((l) => l.startsWith("backend を起動します")) ?? "";
  console.log(`  [info] ${runtimeA}`);

  // B: Electron 同梱の Node、--recompute（キャッシュを使わない計算）
  const outB = path.join(OUT_DIR, "cli-electron-b");
  fs.rmSync(outB, { recursive: true, force: true });
  const B = runCli("electron", args(["r1_spec.json", "r2_spec.json"], "cli-electron-b", ["--recompute"]));
  check(B.code === 0, "electron: --recompute の実行は終了コード 0", { code: B.code, stderr: B.stderr.slice(0, 300), stdout: B.stdout.slice(-300) });
  const filesB = readDir(outB);
  for (const name of ["r1voi", "r2rad"] as const) {
    check(gui[name].every((f) => filesB.has(f.name) && sameFile(f.name, f.text, filesB.get(f.name)!)),
      `electron(--recompute): ${name} の 5 ファイルが画面の出力と一致（抽出時刻の列を除く）`);
  }
  const t1 = maskedCsv(filesB.get("r1voi.csv") ?? "");
  const col = (n: string) => t1[0]?.indexOf(n) ?? -1;
  let compared = 0;
  for (const r of t1.slice(1)) {
    const p = predicted.get(r[col("StudyInstanceUID")])![Number(r[col("Roi_MaskChannel")]) === 0 ? "BigBox" : "SmallBox"];
    if (Number(r[col("Roi_IntensityMaskVoxels")]) === p.n && close(Number(r[col("IntensityBasedStatistical_Mean")]), p.mean)
      && close(Number(r[col("IntensityBasedStatistical_Median")]), p.median)) compared++;
  }
  check(compared === 4, "electron(--recompute): VOI 統計の値が予測（DICOM から Python）と 4 行すべて一致", compared);
  const portB = portOf(B.stdout);
  check(portB !== null && (await portFree(portB)), "終了後に CLI の backend のポートが空く（正常終了）", portB);

  console.log("\n[4] 負例");
  const C = runCli("node", args(["r1_spec.json", "r_tampered_spec.json"], "cli-tampered"));
  check(C.code === 3 && /sha_mismatch/.test(C.stderr), "改変した定義が 1 つでもあれば終了コード 3", { code: C.code, stderr: C.stderr.slice(0, 200) });
  check(!fs.existsSync(path.join(OUT_DIR, "cli-tampered")), "終了コード 3 のときは何も書かない");
  check(!C.stdout.includes("backend を起動します"), "定義の誤りは backend の起動前に断る（起動に約 30 秒かけない）");
  const D = runCli("node", args(["r1_spec.json"], "cli-noalbum", [], "no-such-album"));
  check(D.code === 3 && /アルバム/.test(D.stderr), "存在しないアルバムは終了コード 3", { code: D.code, stderr: D.stderr.slice(0, 200) });
  const E = runCli("node", ["--album", albumName, "--out", path.join(OUT_DIR, "x")]);
  check(E.code === 3, "--spec が無い引数は終了コード 3（backend を起動しない）", E.code);
  check(!E.stdout.includes("backend を起動します"), "引数の誤りでは backend を起動しない");

  console.log(`\n合格 ${passed} ／ 失敗 ${failures.length}`);
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
