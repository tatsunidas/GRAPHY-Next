/*
 * 一括抽出の「VOI 統計」の実機検証スパイク（アルバム ▸ 特徴量を一括抽出… ▸ 種類）。
 *
 * 実行:  cd automator && GRAPHY_AUTOMATOR_HTTP_PORT=18290 GRAPHY_AUTOMATOR_SCP_PORT=18291 GRAPHY_AUTOMATOR_VITE_PORT=18293 \
 *          npx tsx src/spike/voiStatsBatchCheck.ts
 *
 *   1. 種類を VOI 統計にすると族などの欄が隠れ、定義の SHA-256 が変わる。
 *   2. 一括実行の要求に kind=voiStats が載り、設定は一次統計の族だけが有効。
 *   3. 書き出した表は、識別・大きさ・体積(mL)・一次統計 5 列だけ（余計な特徴量が無い）。
 *   4. 値（ボクセル数・体積 mL・平均・SD(母集団)・最小・最大・中央値）が、書き出した DICOM から Python で求めた予測値と一致する。
 *   5. 定義を保存・読込すると種類が復元され、SHA-256 が一致する。
 *
 * 専用ポート（上の環境変数）。前提: backend jar（今のビルド）。合成データ（2 検査 × 箱 2 つ。値は毎回違う乱数）。
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { Page } from "@playwright/test";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "voi-stats-batch-check");
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
  const r = spawnSync("python3", ["-I", path.join(import.meta.dirname, "roiFeatureSynth.py"), dir, seed, "-1000", `SYNTHVOI-${i}`], { encoding: "utf8" });
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
  const r = spawnSync("python3", ["-I", path.join(import.meta.dirname, "voiStatsPredict.py"), dir, JSON.stringify(boxes)], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`予測を作れません: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

const close = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
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
    const album = await post<{ id: number }>(base, "/api/albums", { name: `voi-check-${Date.now()}` });
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
    const posted: Record<string, unknown>[] = [];
    page.on("request", (req) => {
      if (req.method() === "POST" && req.url().includes("/api/radiomics/batch/jobs")) posted.push(JSON.parse(req.postData() ?? "{}"));
    });
    await page.getByTestId("album-select").selectOption(String(album.id));
    await page.waitForTimeout(800);
    await page.getByTestId("album-batch-button").click();
    await page.getByTestId("batch-dialog").waitFor({ state: "visible", timeout: 20_000 });
    await page.getByTestId("batch-row-3").waitFor({ state: "visible", timeout: 30_000 });
    await page.waitForTimeout(1000);

    console.log("\n[1] 種類を選ぶ");
    check(await page.getByTestId("batch-kind-radiomics").isChecked(), "既定は特徴量（radiomics）");
    check((await page.getByTestId("batch-bincount").count()) === 1, "特徴量では離散化の欄が出る");
    const shaRad = await shaTitle(page);
    await page.screenshot({ path: path.join(OUT_DIR, "01-radiomics.png"), fullPage: true });
    await page.getByTestId("batch-kind-voiStats").check();
    const shaVoi = await shaTitle(page, shaRad);
    check(shaVoi !== shaRad && /^[0-9a-f]{64}$/.test(shaVoi), "VOI 統計にすると定義の SHA-256 が変わる", { shaRad, shaVoi });
    check((await page.getByTestId("batch-bincount").count()) === 0 && (await page.getByTestId("batch-preset").count()) === 0
      && (await page.getByTestId("batch-range-min").count()) === 0, "VOI 統計では離散化・プリセット・範囲の欄が隠れる");
    check(await page.getByTestId("batch-kind-voi-help").isVisible(), "VOI 統計の説明が出る");
    check((await page.getByTestId("batch-qc-small").count()) === 1 && (await page.getByTestId("batch-labels").count()) === 1, "QC とセグメント名の欄は残る");
    await page.screenshot({ path: path.join(OUT_DIR, "02-voistats.png"), fullPage: true });

    console.log("\n[2] 一括実行（4 組）");
    await page.getByTestId("batch-run").click();
    await waitText(page, "batch-progress", /完了 — 4\/4 完了/, 300_000);
    await page.screenshot({ path: path.join(OUT_DIR, "03-done.png"), fullPage: true });
    const req = posted[posted.length - 1] as { kind: string; settings: Record<string, string>; pairs: unknown[] };
    check(req.kind === "voiStats" && req.pairs.length === 4, "要求に kind=voiStats、4 組", { kind: req.kind, n: req.pairs.length });
    const on = Object.entries(req.settings).filter(([k, v]) => k.startsWith("BOOL_enable") && v === "1").map(([k]) => k);
    check(on.join() === "BOOL_enableIntensityBasedStatistics", "有効な族は一次統計だけ", on);

    console.log("\n[3] 書き出した表");
    await page.getByTestId("batch-prefix").fill("voicheck");
    await page.getByTestId("batch-write").click();
    const dl = await takeDownloads(page, 5);
    for (const f of dl) fs.writeFileSync(path.join(OUT_DIR, f.name), f.text);
    const csv = dl.find((f) => f.name === "voicheck.csv");
    const defs = dl.find((f) => f.name === "voicheck_definitions.csv");
    check(!!csv && !!defs && dl.length === 5, "表・定義表を含む 5 ファイルが出る", dl.map((f) => f.name));
    if (csv && defs) {
      const lines = csv.text.replace(/^﻿/, "").split("\r\n").filter(Boolean);
      const header = splitRow(lines[0]);
      const rows = lines.slice(1).map(splitRow);
      const col = (n: string) => header.indexOf(n);
      const tail = header.slice(col("Warning_SmallRoi") + 1);
      check(tail.join() === ["Roi_VolumeMl", ...STAT_COLUMNS].join(), "大きさの列の後ろは Roi_VolumeMl と一次統計 5 列だけ", tail);
      check(!header.some((h) => /^(Morphology|GLCM|Diagnostics|IntensityHistogram)_/.test(h)), "他の族の特徴量の列が無い");
      check(rows.length === 4 && rows.every((r) => r[col("RowStatus")] === "DONE"), "4 行すべて DONE", rows.map((r) => r[col("RowStatus")]));
      check(defs.text.split("\r\n").some((l) => l.startsWith("Roi_VolumeMl,Roi,VolumeMl")), "定義表に Roi_VolumeMl の行がある");

      console.log("\n[4] 予測値との照合（書き出した DICOM から Python で求めた値）");
      const predicted = new Map(synths.map((s) => [s.studyInstanceUid, predict(s.dir)]));
      let compared = 0;
      for (const r of rows) {
        const p = predicted.get(r[col("StudyInstanceUID")])![Number(r[col("Roi_MaskChannel")]) === 0 ? "BigBox" : "SmallBox"];
        const num = (n: string) => Number(r[col(n)]);
        const tag = `${r[col("Roi_SegmentLabel")]}`;
        check(num("Roi_IntensityMaskVoxels") === p.n && num("Roi_MorphMaskVoxels") === p.n, `${tag}: ボクセル数が ${p.n}`, num("Roi_IntensityMaskVoxels"));
        check(close(num("Roi_VolumeMl"), (p.n * VOXEL_MM3) / 1000), `${tag}: 体積 mL が ${(p.n * VOXEL_MM3) / 1000}`, num("Roi_VolumeMl"));
        check(close(num("IntensityBasedStatistical_Mean"), p.mean), `${tag}: 平均が予測と一致`, [num("IntensityBasedStatistical_Mean"), p.mean]);
        check(close(num("IntensityBasedStatistical_StandardDeviation"), p.sd), `${tag}: SD（母集団）が予測と一致`, [num("IntensityBasedStatistical_StandardDeviation"), p.sd]);
        check(num("IntensityBasedStatistical_Minimum") === p.min, `${tag}: 最小が予測と一致`, [num("IntensityBasedStatistical_Minimum"), p.min]);
        check(num("IntensityBasedStatistical_Maximum") === p.max, `${tag}: 最大が予測と一致`, [num("IntensityBasedStatistical_Maximum"), p.max]);
        check(close(num("IntensityBasedStatistical_Median"), p.median), `${tag}: 中央値が予測と一致`, [num("IntensityBasedStatistical_Median"), p.median]);
        compared++;
      }
      check(compared === 4, "4 行すべてを予測と照合した", compared);
    }

    console.log("\n[5] 定義の保存・読込");
    await page.getByTestId("batch-spec-save").click();
    const [saved] = await takeDownloads(page, 1);
    fs.writeFileSync(path.join(OUT_DIR, "voi_spec.json"), saved.text);
    const spec = JSON.parse(saved.text) as { kind?: string; sha256: string };
    check(spec.kind === "voiStats" && spec.sha256 === shaVoi, "保存した定義に kind=voiStats、sha256 が画面の表示と一致", spec);
    await page.getByTestId("batch-kind-radiomics").check();
    check((await shaTitle(page, shaVoi)) === shaRad, "特徴量に戻すと SHA-256 が元の値に戻る（種類の無い従来の定義と同じ）");
    await page.getByTestId("batch-spec-file").setInputFiles(path.join(OUT_DIR, "voi_spec.json"));
    await waitText(page, "batch-info", /読み込みました/, 20_000);
    await page.waitForTimeout(400);
    check(await page.getByTestId("batch-kind-voiStats").isChecked(), "定義を読み込むと種類が VOI 統計に復元される");
    check((await shaTitle(page)) === shaVoi, "SHA-256 の表示が保存時と同じ");

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
