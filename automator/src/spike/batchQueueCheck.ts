/*
 * 一括抽出の「定義の一覧（順に実行）」の実機検証スパイク（アルバム ▸ 特徴量を一括抽出… ▸ 定義の一覧）。
 *
 * 実行:  cd automator && GRAPHY_AUTOMATOR_HTTP_PORT=18290 GRAPHY_AUTOMATOR_SCP_PORT=18291 GRAPHY_AUTOMATOR_VITE_PORT=18293 \
 *          npx tsx src/spike/batchQueueCheck.ts
 *
 *   1. 3 つの定義（VOI 統計／存在しないセグメント名／特徴量）を画面から保存し、一覧に追加する。改変した定義は追加を断る（負例）。
 *   2. 一覧を順に実行すると、真ん中の定義が失敗（対象の組なし）でも、前後は完了し、送信は 2 回（失敗した定義は送らない）。
 *   3. 失敗した定義は表を書かない。完了した 2 つの表は、各定義の SHA-256 と Provenance_SpecSha256 が一致する。
 *   4. VOI 統計の値が、書き出した DICOM から Python で求めた予測値と一致する。
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

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "batch-queue-check");
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
    const album = await post<{ id: number }>(base, "/api/albums", { name: `queue-check-${Date.now()}` });
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
    await dismissUpdateDialog(page);
    await page.getByTestId("album-batch-button").click();
    await page.getByTestId("batch-dialog").waitFor({ state: "visible", timeout: 20_000 });
    await page.getByTestId("batch-row-3").waitFor({ state: "visible", timeout: 30_000 });
    await page.waitForTimeout(1000);

    console.log("\n[1] 3 つの定義を保存して、一覧に追加する");
    const saveSpec = async (file: string): Promise<{ kind?: string; sha256: string }> => {
      await page.getByTestId("batch-spec-save").click();
      const [saved] = await takeDownloads(page, 1);
      fs.writeFileSync(path.join(OUT_DIR, file), saved.text);
      return JSON.parse(saved.text) as { kind?: string; sha256: string };
    };
    await page.getByTestId("batch-prefix").fill("q1voi");
    await page.getByTestId("batch-kind-voiStats").check();
    const s1 = await saveSpec("q1_spec.json");
    await page.getByTestId("batch-kind-radiomics").check();
    await page.getByTestId("batch-labels").fill("Nothing");
    await page.getByTestId("batch-prefix").fill("q2none");
    const s2 = await saveSpec("q2_spec.json");
    await page.getByTestId("batch-labels").fill("");
    await page.getByTestId("batch-prefix").fill("q3rad");
    const s3 = await saveSpec("q3_spec.json");
    check(new Set([s1.sha256, s2.sha256, s3.sha256]).size === 3 && s1.kind === "voiStats", "3 つの定義は SHA-256 が互いに違う", [s1, s2, s3].map((s) => s.sha256.slice(0, 8)));

    // 改変した定義（SHA-256 が合わない）は追加を断る
    const tampered = JSON.parse(fs.readFileSync(path.join(OUT_DIR, "q3_spec.json"), "utf8")) as { form: { binCount: number } };
    tampered.form.binCount += 1;
    fs.writeFileSync(path.join(OUT_DIR, "q_tampered_spec.json"), JSON.stringify(tampered));
    await page.getByTestId("batch-queue-file").setInputFiles(path.join(OUT_DIR, "q_tampered_spec.json"));
    await waitText(page, "batch-error", /SHA-256 が一致しません/, 20_000);
    check((await page.getByTestId("batch-queue-empty").count()) === 1, "改変した定義は一覧に入らない（負例）");

    await page.getByTestId("batch-queue-file").setInputFiles(["q1_spec.json", "q2_spec.json", "q3_spec.json"].map((f) => path.join(OUT_DIR, f)));
    await page.getByTestId("batch-queue-row-2").waitFor({ state: "visible", timeout: 20_000 });
    check((await page.getByTestId("batch-queue-row-0").innerText()).includes("q1voi")
      && (await page.getByTestId("batch-queue-row-1").innerText()).includes("q2none")
      && (await page.getByTestId("batch-queue-row-2").innerText()).includes("q3rad"), "一覧に 3 つが追加した順で並ぶ");
    await page.screenshot({ path: path.join(OUT_DIR, "01-queue-added.png"), fullPage: true });

    console.log("\n[2] 一覧を順に実行");
    const before = posted.length;
    await page.getByTestId("batch-queue-run").click();
    await waitText(page, "batch-queue-state-0", /実行中|完了/, 30_000);
    check(await page.getByTestId("batch-run").isDisabled(), "一覧の実行中は、単独実行のボタンが押せない");
    await waitText(page, "batch-queue-state-2", /完了（5 ファイル）/, 300_000);
    await page.screenshot({ path: path.join(OUT_DIR, "02-queue-done.png"), fullPage: true });
    const states = await Promise.all([0, 1, 2].map((i) => page.getByTestId(`batch-queue-state-${i}`).innerText()));
    check(/完了（5 ファイル）/.test(states[0]), "1 つ目（VOI 統計）は完了", states[0]);
    check(/失敗/.test(states[1]) && /対象の組がありません/.test(states[1]), "2 つ目（存在しないセグメント名）は失敗、理由が出る", states[1]);
    check(/完了（5 ファイル）/.test(states[2]), "3 つ目（特徴量）は 2 つ目の失敗に関わらず完了", states[2]);
    const summary = await page.getByTestId("batch-queue-summary").innerText();
    check(/2 完了・1 失敗/.test(summary), "集計が 2 完了・1 失敗", summary);
    const sent = posted.slice(before) as { kind: string | null; pairs: unknown[] }[];
    check(sent.length === 2 && sent[0].kind === "voiStats" && sent[1].kind === null && sent.every((r) => r.pairs.length === 4),
      "サーバーへの送信は 2 回（失敗した定義は送らない）、各 4 組", sent.map((r) => [r.kind, r.pairs.length]));
    check(!(await page.getByTestId("batch-run").isDisabled()), "終わると単独実行のボタンが戻る");

    console.log("\n[3] 書き出した表");
    const dl = await takeDownloads(page, 10);
    for (const f of dl) fs.writeFileSync(path.join(OUT_DIR, f.name), f.text);
    const names = dl.map((f) => f.name).sort();
    check(dl.length === 10 && names.filter((n) => n.startsWith("q1voi")).length === 5 && names.filter((n) => n.startsWith("q3rad")).length === 5,
      "q1voi と q3rad が 5 ファイルずつ", names);
    check(!names.some((n) => n.startsWith("q2none")), "失敗した定義の表は書かれない（負例）");
    const tableOf = (name: string) => {
      const f = dl.find((x) => x.name === name)!;
      const lines = f.text.replace(/^﻿/, "").split("\r\n").filter(Boolean);
      return { header: splitRow(lines[0]), rows: lines.slice(1).map(splitRow) };
    };
    const t1 = tableOf("q1voi.csv");
    const t3 = tableOf("q3rad.csv");
    const shaCol = (t: { header: string[]; rows: string[][] }) => new Set(t.rows.map((r) => r[t.header.indexOf("Provenance_SpecSha256")]));
    check([...shaCol(t1)].join() === s1.sha256, "q1voi の全行の Provenance_SpecSha256 が定義 1 の SHA-256", [...shaCol(t1)]);
    check([...shaCol(t3)].join() === s3.sha256, "q3rad の全行の Provenance_SpecSha256 が定義 3 の SHA-256", [...shaCol(t3)]);
    const allDone = (t: { header: string[]; rows: string[][] }) => t.rows.length === 4 && t.rows.every((r) => r[t.header.indexOf("RowStatus")] === "DONE");
    check(allDone(t1) && allDone(t3), "どちらも 4 行すべて DONE");
    check(t3.header.length > t1.header.length + 20, "q3rad は特徴量の全列、q1voi は一次統計だけ", [t1.header.length, t3.header.length]);

    console.log("\n[4] VOI 統計の値の予測との照合");
    const predicted = new Map(synths.map((s) => [s.studyInstanceUid, predict(s.dir)]));
    const col = (n: string) => t1.header.indexOf(n);
    for (const r of t1.rows) {
      const p = predicted.get(r[col("StudyInstanceUID")])![Number(r[col("Roi_MaskChannel")]) === 0 ? "BigBox" : "SmallBox"];
      const num = (n: string) => Number(r[col(n)]);
      const tag = r[col("Roi_SegmentLabel")];
      check(num("Roi_IntensityMaskVoxels") === p.n, `${tag}: ボクセル数が ${p.n}`, num("Roi_IntensityMaskVoxels"));
      check(close(num("Roi_VolumeMl"), (p.n * VOXEL_MM3) / 1000), `${tag}: 体積 mL が予測と一致`, num("Roi_VolumeMl"));
      check(close(num("IntensityBasedStatistical_Mean"), p.mean), `${tag}: 平均が予測と一致`, [num("IntensityBasedStatistical_Mean"), p.mean]);
      check(close(num("IntensityBasedStatistical_Median"), p.median), `${tag}: 中央値が予測と一致`, [num("IntensityBasedStatistical_Median"), p.median]);
      check(STAT_COLUMNS.every((c) => col(c) >= 0), `${tag}: 一次統計 5 列がある`);
    }

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
