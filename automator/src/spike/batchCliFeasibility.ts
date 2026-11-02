/*
 * 一括抽出の「Node から動かす CLI」が成り立つかの実測（段 2b-0。製品の CLI ではなく、方式の確認）。
 *
 * 実行:  cd automator && GRAPHY_AUTOMATOR_HTTP_PORT=18290 GRAPHY_AUTOMATOR_SCP_PORT=18291 GRAPHY_AUTOMATOR_VITE_PORT=18293 \
 *          npx tsx src/spike/batchCliFeasibility.ts          （Windows で pydicom が利用者領域なら GRAPHY_SPIKE_PYTHON_USERSITE=1）
 *
 *   1. フロントの TS（batchApi・batchQueue・batchSpec・batchPairs・datasetCsv）を、http.ts だけ Node 用の代役に差し替えて esbuild で
 *      1 ファイルに束ねる（警告なし）。
 *   2. 束ねたファイルを ①システムの node ②Electron 同梱の Node（ELECTRON_RUN_AS_NODE）で動かし、実アプリの backend へ繋いで
 *      1 つの定義 × 1 アルバムを実行する。定義の SHA-256 は Node 側で再計算して埋め込みの値（画面が計算）と一致する。
 *   3. 画面（実アプリ）が同じ定義・同じアルバムで書いた 5 ファイルと、CLI が書いた 5 ファイルを比べる（実行時刻の列だけ除く）。
 *   4. 負例: 改変した定義は断る（終了コード 3）、繋がらないサーバーは非 0（4）で落ちる。
 *
 * 専用ポート（上の環境変数）。前提: backend jar（今のビルド）。合成データ（2 検査 × 箱 2 つ）。
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { Page } from "@playwright/test";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { dismissUpdateDialog } from "./dismissUpdateDialog.js";
import { PY, PY_FLAGS } from "./pythonCmd.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "batch-cli-feasibility");
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



const FRONTEND_SRC = path.resolve(AUTOMATOR_ROOT, "..", "frontend", "src");
const ELECTRON_EXE = path.resolve(AUTOMATOR_ROOT, "..", "desktop", "node_modules", "electron", "dist", process.platform === "win32" ? "electron.exe" : "electron");

/** `frontend/src/http.ts`（window・log・DOMException に依存する）だけを、Node 用の代役に差し替える。 */
const HTTP_SHIM = `
export class HttpError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}
const base = () => globalThis.__GRAPHY_CLI_BASE__ ?? "";
async function request(path, init) {
  const res = await fetch(base() + path, init);
  if (!res.ok) throw new HttpError((await res.text()) || res.statusText, res.status);
  if (res.status === 204) return undefined;
  const text = await res.text();
  return text ? JSON.parse(text) : undefined;
}
export const httpGet = (path) => request(path);
export const httpSend = (path, method, body) =>
  request(path, { method, headers: body === undefined ? {} : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
`;

async function bundle(): Promise<{ file: string; warnings: number; inputs: string[]; bytes: number }> {
  const { build } = await import("esbuild");
  const file = path.join(OUT_DIR, "graphy-batch-cli.cjs");
  const r = await build({
    entryPoints: [path.join(import.meta.dirname, "batchCliEntry.mts")],
    bundle: true, platform: "node", format: "cjs", outfile: file, logLevel: "silent", metafile: true, target: "node20",
    plugins: [{
      name: "http-shim",
      setup(b) {
        b.onResolve({ filter: /(^|\/)http$/ }, (a) => {
          const resolved = path.resolve(a.resolveDir, a.path);
          return resolved === path.join(FRONTEND_SRC, "http") ? { path: "http-shim", namespace: "shim" } : undefined;
        });
        b.onLoad({ filter: /.*/, namespace: "shim" }, () => ({ contents: HTTP_SHIM, loader: "js" }));
      },
    }],
  });
  return { file, warnings: r.warnings.length, inputs: Object.keys(r.metafile.inputs), bytes: fs.statSync(file).size };
}

interface Run { code: number; stdout: string; stderr: string }
function runCli(mode: "node" | "electron", bundleFile: string, args: string[]): Run {
  const exe = mode === "node" ? process.execPath : ELECTRON_EXE;
  const env = mode === "node" ? { ...process.env } : { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
  const r = spawnSync(exe, [bundleFile, ...args], { encoding: "utf8", env, timeout: 280_000 });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** CSV の実行ごとに変わる列（抽出時刻）を空にして、行ごとの配列にする。 */
function maskedCsv(text: string): string[][] {
  const lines = text.replace(/^﻿/, "").split("\r\n").filter(Boolean).map(splitRow);
  const skip = lines[0].map((h, i) => (/ExtractedAt/.test(h) ? i : -1)).filter((i) => i >= 0);
  return lines.map((r) => r.map((c, i) => (skip.includes(i) ? "" : c)));
}

function sameFile(name: string, a: string, b: string): boolean {
  if (a === b) return true;
  if (!name.endsWith(".csv")) return false;
  return JSON.stringify(maskedCsv(a)) === JSON.stringify(maskedCsv(b));
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log("[1] 束ねる");
  const b = await bundle();
  check(b.warnings === 0, "esbuild の警告が 0", b.warnings);
  const rel = b.inputs.map((p) => p.replace(/\\/g, "/"));
  check(!rel.some((p) => /frontend\/src\/http\.ts$/.test(p)) && !rel.some((p) => /frontend\/src\/log\.ts$/.test(p)),
    "http.ts・log.ts（window 依存）は束に入っていない");
  const react = rel.some((p) => /node_modules\/react\//.test(p));
  console.log(`  [info] 束ねたファイル ${(b.bytes / 1024).toFixed(0)} KB、入力 ${rel.length} 件、react を含む: ${react}`);

  const synths = [0, 1].map(makeSynth);
  const d = new DesktopDriver();
  await d.start();
  const base = `http://127.0.0.1:${d.ports.http}`;
  let albumId = 0;
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
    const album = await post<{ id: number }>(base, "/api/albums", { name: `cli-check-${Date.now()}` });
    albumId = album.id;
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

    console.log("\n[2] 画面で定義を保存し、同じ定義で画面の単独実行の表を作る（比較の基準）");
    const saveSpec = async (file: string): Promise<{ kind?: string; sha256: string }> => {
      await page.getByTestId("batch-spec-save").click();
      const [saved] = await takeDownloads(page, 1);
      fs.writeFileSync(path.join(OUT_DIR, file), saved.text);
      return JSON.parse(saved.text) as { kind?: string; sha256: string };
    };
    await page.getByTestId("batch-prefix").fill("c1voi");
    await page.getByTestId("batch-kind-voiStats").check();
    const specs = { c1voi: await saveSpec("c1_spec.json") } as Record<string, { kind?: string; sha256: string }>;
    await page.getByTestId("batch-kind-radiomics").check();
    await page.getByTestId("batch-prefix").fill("c2rad");
    specs.c2rad = await saveSpec("c2_spec.json");
    check(specs.c1voi.sha256 !== specs.c2rad.sha256 && /^[0-9a-f]{64}$/.test(specs.c1voi.sha256), "2 つの定義の SHA-256 は違う（64 桁の 16 進）");

    const gui: Record<string, Download[]> = {};
    for (const [name, file] of [["c1voi", "c1_spec.json"], ["c2rad", "c2_spec.json"]] as const) {
      await page.getByTestId("batch-spec-file").setInputFiles(path.join(OUT_DIR, file));
      await waitText(page, "batch-info", /読み込みました/, 20_000);
      await page.getByTestId("batch-run").click();
      await waitText(page, "batch-progress", /完了 — 4\/4 完了/, 300_000);
      await page.getByTestId("batch-write").click();
      gui[name] = await takeDownloads(page, 5);
      check(gui[name].length === 5, `${name}: 画面の書き出しが 5 ファイル`, gui[name].map((f) => f.name));
    }
    await page.screenshot({ path: path.join(OUT_DIR, "01-gui-done.png"), fullPage: true });

    console.log("\n[3] CLI（束ねた 1 ファイル）を 2 つの実行環境で動かす");
    const predicted = new Map(synths.map((s) => [s.studyInstanceUid, predict(s.dir)]));
    for (const mode of ["node", "electron"] as const) {
      for (const name of ["c1voi", "c2rad"] as const) {
        const out = path.join(OUT_DIR, `cli-${mode}-${name}`);
        fs.rmSync(out, { recursive: true, force: true });
        const r = runCli(mode, b.file, ["--server", base, "--spec", path.join(OUT_DIR, name === "c1voi" ? "c1_spec.json" : "c2_spec.json"), "--album", String(album.id), "--out", out]);
        const tag = `${mode}/${name}`;
        check(r.code === 0, `${tag}: 終了コード 0`, { code: r.code, stderr: r.stderr.slice(0, 300), stdout: r.stdout.slice(0, 300) });
        if (name === "c1voi") console.log(`  [info] ${r.stdout.split("\n").find((l) => l.startsWith("runtime")) ?? ""}`);
        check(r.stdout.includes(`sha256=${specs[name].sha256}`), `${tag}: Node 側で検査した SHA-256 が画面の値と一致`);
        const written = fs.existsSync(out) ? fs.readdirSync(out).sort() : [];
        const guiNames = gui[name].map((f) => f.name).sort();
        check(JSON.stringify(written) === JSON.stringify(guiNames), `${tag}: 書き出したファイル名が画面と同じ`, { written, guiNames });
        for (const f of gui[name]) {
          const got = fs.existsSync(path.join(out, f.name)) ? fs.readFileSync(path.join(out, f.name), "utf8") : "";
          check(sameFile(f.name, f.text, got), `${tag}: ${f.name} が画面の出力と一致（抽出時刻の列を除く）`);
          if (f.text !== got) console.log(`  [info] ${tag}: ${f.name} は抽出時刻の列を除いて一致（バイトでは違う）`);
          // 比較器が差を見つけられること（負例）: 画面の出力の数字を 1 つ変えると不一致になる
          if (f.name === `${name}.csv`) {
            const m = maskedCsv(f.text);
            const v = m[1][m[0].indexOf("Roi_IntensityMaskVoxels")];
            const altered = f.text.replace(`,${v},`, `,${Number(v) + 1},`);
            check(altered !== f.text && !sameFile(f.name, altered, got), `${tag}: 比較器は値を 1 つ変えた表を不一致と判定する（負例）`);
          }
        }
        if (name === "c1voi") {
          const t = maskedCsv(fs.readFileSync(path.join(out, "c1voi.csv"), "utf8"));
          const col = (n: string) => t[0].indexOf(n);
          let compared = 0;
          for (const row of t.slice(1)) {
            const p = predicted.get(row[col("StudyInstanceUID")])![Number(row[col("Roi_MaskChannel")]) === 0 ? "BigBox" : "SmallBox"];
            const ok = Number(row[col("Roi_IntensityMaskVoxels")]) === p.n && close(Number(row[col("IntensityBasedStatistical_Mean")]), p.mean);
            if (ok) compared++;
          }
          check(compared === 4, `${tag}: VOI 統計の値が予測（DICOM から Python）と 4 行すべて一致`, compared);
        }
      }
    }

    console.log("\n[4] 負例");
    const tampered = JSON.parse(fs.readFileSync(path.join(OUT_DIR, "c2_spec.json"), "utf8")) as { form: { binCount: number } };
    tampered.form.binCount += 1;
    fs.writeFileSync(path.join(OUT_DIR, "c_tampered_spec.json"), JSON.stringify(tampered));
    for (const mode of ["node", "electron"] as const) {
      const r = runCli(mode, b.file, ["--server", base, "--spec", path.join(OUT_DIR, "c_tampered_spec.json"), "--album", String(album.id), "--out", path.join(OUT_DIR, `cli-${mode}-tampered`)]);
      check(r.code === 3 && /sha_mismatch/.test(r.stderr), `${mode}: 改変した定義は断る（終了コード 3、sha_mismatch）`, { code: r.code, stderr: r.stderr.slice(0, 200) });
      check(!fs.existsSync(path.join(OUT_DIR, `cli-${mode}-tampered`)), `${mode}: 断った定義では何も書かない`);
    }
    const dead = runCli("node", b.file, ["--server", "http://127.0.0.1:18299", "--spec", path.join(OUT_DIR, "c1_spec.json"), "--album", "1", "--out", path.join(OUT_DIR, "cli-dead")]);
    check(dead.code === 4, "繋がらないサーバーは終了コード 4（成功を返さない）", { code: dead.code, stderr: dead.stderr.slice(0, 200) });

    console.log(`\n合格 ${passed} ／ 失敗 ${failures.length}`);
    if (failures.length > 0) process.exitCode = 1;
  } finally {
    if (albumId) await fetch(`${base}/api/albums/${albumId}`, { method: "DELETE" }).catch(() => {});
    await d.stop();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
