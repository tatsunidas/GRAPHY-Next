/*
 * アルバムからの ROI 特徴量の一括抽出ダイアログの実機検証スパイク（メイン画面 > アルバムバー > 「特徴量を一括抽出…」）。
 *
 * 実行:  cd automator && GRAPHY_AUTOMATOR_HTTP_PORT=18290 GRAPHY_AUTOMATOR_SCP_PORT=18291 \
 *          GRAPHY_AUTOMATOR_VITE_PORT=18293 timeout 1500 npx tsx src/spike/roiFeatureBatchCheck.ts
 *
 *   1. 合成 CT 4 検査を取り込み、うち 3 検査にアプリの SEG 書き出し API で 2 セグメントの SEG を作る（組は 6）。
 *      4 検査目は SEG が無い（組にならない）。4 検査をアルバムに入れる。
 *   2. アルバム未選択ではボタンが無効、選ぶと有効。
 *   3. 確認表: 自動の組が出る。/plan の応答を書き換えて 1 組を「要確認」にし（画面の動作の検査。実際の /plan の出力ではない）、
 *      選ぶまで対象にならないことを確かめる。「1 組だけ試す」はファイルを書かない。
 *   4. 要確認の組の元画像を選び、一括で実行 → 完了 → 書き出し。download を横取りして 4 ファイルを取り、
 *      行数が組の数に一致し、各行の値が同じ組を既存の API で直接計算した値と全列で差 0。患者情報が無い。
 *   5. 取り消し: 重い設定にして実行し、1 組終わったところで取り消す → 残りが取り消し。同じ設定で実行し直すと、
 *      計算済みの組はキャッシュ表示になる。
 *
 * 前提: backend jar（今のビルド）・python3 と pydicom・automator と desktop の依存。
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { Page } from "@playwright/test";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "roi-feature-batch-check");

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
const PATIENT_NAME = "SYNTH^ROIFEAT";
const PATIENT_ID = "SYNTHROIFEAT";

function makeSynth(i: number): Synth & { dir: string } {
  const dir = path.join(OUT_DIR, `synth${i}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const seed = String((Date.now() + i * 7919) % 2_000_000_000);
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

async function apiFeatures(base: string, body: Record<string, unknown>): Promise<Result> {
  const s = await post<{ jobId: string }>(base, "/api/radiomics/features/jobs", body);
  for (let i = 0; i < 600; i++) {
    const st = await api<{ state: string; result?: Result; error?: string }>(base, `/api/radiomics/features/jobs/${s.jobId}`);
    if (st.state === "DONE" && st.result) return st.result;
    if (st.state === "FAILED" || st.state === "CANCELLED") throw new Error(`job ${st.state}: ${st.error}`);
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("job timeout");
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
/** 先頭の記録の列（症例ラベル・Provenance_* の 5 列と、ROI の大きさ・警告の 6 列）。 */
const NREC = 11;

interface Download { name: string; text: string }
async function takeDownloads(page: Page, n: number): Promise<Download[]> {
  for (let i = 0; i < 50; i++) {
    const got = (await page.evaluate("window.__roiDownloads.length")) as number;
    if (got >= n) break;
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
  const prog = await page.getByTestId("batch-progress").innerText().catch(() => "(進みの表示なし)");
  throw new Error(`「${re}」にならない: ${last} / 進み: ${prog}`);
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const synths = [0, 1, 2, 3].map(makeSynth);
  const d = new DesktopDriver();
  await d.start();
  const base = `http://127.0.0.1:${d.ports.http}`;
  let albumId = 0;
  try {
    console.log(`  reset: ${JSON.stringify(await resetDb(d.ports.http))}`);
    for (const s of synths) console.log(`  import: ${JSON.stringify(await importPaths(d.ports.http, [s.dir]))}`);

    console.log("\n[1] SEG（3 検査 × 2 セグメント）とアルバム");
    const segUids: string[] = [];
    for (const s of synths.slice(0, 3)) {
      const seg = await post<{ seriesInstanceUid: string }>(base, "/api/dicom/seg", {
        studyInstanceUid: s.studyInstanceUid, seriesInstanceUid: s.seriesInstanceUid, rows: s.rows, columns: s.columns,
        imageOrientationPatient: [1, 0, 0, 0, 1, 0], pixelSpacing: s.pixelSpacing, sliceThickness: s.sliceThickness,
        frameOfReferenceUID: s.frameOfReferenceUID, seriesDescription: "synthetic two-box SEG",
        segments: [
          { number: 1, label: "BigBox", color: [255, 0, 0], description: null, frames: boxFrames(s, SEG1) },
          { number: 2, label: "SmallBox", color: [0, 255, 0], description: null, frames: boxFrames(s, SEG2) },
        ],
        producer: null,
      });
      segUids.push(seg.seriesInstanceUid);
    }
    check(segUids.length === 3 && segUids.every(Boolean), "SEG が 3 つできる", segUids);
    const album = await post<{ id: number }>(base, "/api/albums", { name: `batch-check-${Date.now()}` });
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
            fetch(a.href).then(function (r) { return r.text(); }).then(function (t) {
              window.__roiDownloads.push({ name: name, text: t });
            });
            return;
          }
          return orig.call(this);
        };
      })()
    `);

    console.log("\n[2] ボタンの有効・無効");
    const btn = page.getByTestId("album-batch-button");
    check(await btn.isVisible(), "standalone ではボタンが出る");
    check(await btn.isDisabled(), "アルバム未選択では無効");
    await page.getByTestId("album-select").selectOption(String(album.id));
    await page.waitForTimeout(800);
    check(await btn.isEnabled(), "アルバムを選ぶと有効");

    console.log("\n[3] 確認表（/plan の 1 組を要確認に書き換える）");
    let trueSource = "";
    let swapped = -1;
    await page.route("**/api/radiomics/batch/plan", async (route) => {
      const res = await route.fetch();
      const pairs = (await res.json()) as Record<string, unknown>[];
      swapped = 3;
      trueSource = String(pairs[swapped].sourceSeriesUid);
      pairs[swapped] = {
        ...pairs[swapped], status: "NEEDS_CONFIRMATION", sourceSeriesUid: null, reason: "スパイクで書き換え",
        sourceCandidates: ["1.2.826.0.1.3680043.9.9999.1", trueSource],
      };
      await route.fulfill({ response: res, json: pairs });
    });
    const posted: Record<string, unknown>[] = [];
    page.on("request", (req) => {
      if (req.method() === "POST" && req.url().includes("/api/radiomics/batch/jobs")) {
        posted.push(JSON.parse(req.postData() ?? "{}") as Record<string, unknown>);
      }
    });
    await btn.click();
    await page.getByTestId("batch-dialog").waitFor({ state: "visible", timeout: 20_000 });
    await page.getByTestId("batch-row-5").waitFor({ state: "visible", timeout: 30_000 });
    await page.waitForTimeout(1500);
    const rowCount = await page.locator('[data-testid^="batch-row-"]').count();
    check(rowCount === 6, "確認表に 6 組", rowCount);
    const sum0 = await page.getByTestId("batch-summary").innerText();
    check(/自動 5/.test(sum0) && /要確認 1/.test(sum0) && /対象 5/.test(sum0), "自動 5・要確認 1・対象 5", sum0);
    check(!(await page.getByTestId(`batch-include-${swapped}`).isChecked()), "要確認の組は選ぶまで対象に入らない");
    check(await page.getByTestId(`batch-source-${swapped}`).isVisible(), "要確認の組に元画像の選択が出る");
    await page.screenshot({ path: path.join(OUT_DIR, "01-review.png"), fullPage: true });

    console.log("\n[3b] 1 組だけ試す（ファイルは書かない）");
    await page.getByTestId("batch-trial").click();
    const trialText = await waitText(page, "batch-trial-result", /特徴量を計算しました/, 180_000);
    const nCols = Number(/(\d+) 列/.exec(trialText)?.[1] ?? 0);
    check(nCols >= 150, "試行で 150 列以上の特徴量を計算", trialText);
    check(((await page.evaluate("window.__roiDownloads.length")) as number) === 0, "試行ではファイルを書かない");
    check(posted.length === 1 && (posted[0].pairs as unknown[]).length === 1, "試行は 1 組だけ送る", posted[0]?.pairs);

    console.log("\n[4] 要確認の組を選んで一括実行 → 書き出し");
    await page.getByTestId(`batch-source-${swapped}`).selectOption(trueSource);
    await page.waitForTimeout(300);
    check(await page.getByTestId(`batch-include-${swapped}`).isChecked(), "元画像を選ぶと対象に入る");
    const sum1 = await page.getByTestId("batch-summary").innerText();
    check(/対象 6/.test(sum1), "対象 6", sum1);
    await page.getByTestId("batch-run").click();
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(OUT_DIR, "02-progress.png"), fullPage: true });
    const prog = await waitText(page, "batch-progress", /完了 — 6\/6 完了/, 600_000);
    console.log(`  progress: ${prog.replace(/\n/g, " ")}`);
    await page.screenshot({ path: path.join(OUT_DIR, "03-done.png"), fullPage: true });
    const req = posted[posted.length - 1];
    check((req.pairs as unknown[]).length === 6 && (req.roiModes as string[]).join() === "WHOLE_3D", "全件実行は 6 組・3D だけ", req.roiModes);
    check(req.scales == null, "スケールは送らない");
    check(await page.getByTestId("batch-write").isEnabled(), "書き出しボタンが有効");
    await page.getByTestId("batch-prefix").fill("batchcheck");
    await page.getByTestId("batch-write").click();
    const dl = await takeDownloads(page, 4);
    for (const f of dl) fs.writeFileSync(path.join(OUT_DIR, f.name), f.text);
    check(dl.length === 4, "4 ファイルが出る", dl.map((f) => f.name));
    const features = dl.find((f) => f.name === "batchcheck.csv");
    const pairsCsv = dl.find((f) => f.name === "batchcheck_pairs.csv");
    check(!!features && !!pairsCsv, "特徴量 CSV と対応表がある");
    check(!dl.some((f) => f.text.includes(PATIENT_NAME) || f.text.includes(PATIENT_ID)), "どのファイルにも患者名・患者 ID が無い");
    if (features && pairsCsv) {
      const lines = features.text.split("\r\n");
      check(lines.length === 8 && lines[7] === "", "特徴量 CSV は見出し + 6 行", lines.length);
      check(features.text.charCodeAt(0) !== 0xfeff, "BOM なし");
      const header = splitRow(lines[0]);
      const pairRows = pairsCsv.text.split("\r\n").filter(Boolean).slice(1).map(splitRow);
      check(pairRows.length === 6, "対応表は 6 行", pairRows.length);
      check(pairRows.every((r) => r[7] === "DONE"), "対応表の状態はすべて DONE", pairRows.map((r) => r[7]));
      let mismatched = 0;
      let compared = 0;
      for (let i = 1; i <= 6; i++) {
        const cells = splitRow(lines[i]);
        const label = cells[0];
        const pr = pairRows.find((r) => r[0] === label);
        if (!pr) { check(false, `症例 ${label} が対応表にある`); continue; }
        // 対応表: CaseLabel, Study, Source, Mask, SegNo, SegLabel, MaskChannel, ...
        const direct = await apiFeatures(base, {
          studyInstanceUid: pr[1], sourceSeriesUid: pr[2], maskSeriesUid: pr[3], maskChannel: Number(pr[6]),
          channel: 0, timePoint: 0, settings: req.settings, recompute: true,
        });
        const names = header.slice(NREC);
        const values = cells.slice(NREC).map(Number);
        const same = names.length === direct.rows.length && names.every((n, k) => n === direct.rows[k].column)
          && direct.rows.every((r, k) => Object.is(values[k], r.value ?? NaN));
        compared++;
        if (!same) mismatched++;
      }
      check(compared === 6 && mismatched === 0, "6 行すべてで、同じ組の API 直呼び（キャッシュなし）と全列の差 0", { compared, mismatched });
      const labels = lines.slice(1, 7).map((l) => splitRow(l)[0]);
      check(new Set(labels).size === 6 && labels[0] === "C001", "症例ラベルが C001… と重複なしで振られる", labels);
    }

    console.log("\n[5] 取り消しと続きからの再実行（重い設定）");
    await page.getByTestId("batch-bincount").locator("input").fill("16");
    await page.getByTestId("batch-bincount").locator("input").press("Enter");
    await page.locator('[data-testid="batch-settings"] select').selectOption("iso");
    await page.locator('[data-testid="batch-settings"] input[type="number"]').last().fill("0.5");
    await page.locator('[data-testid="batch-settings"] input[type="number"]').last().press("Enter");
    await page.waitForTimeout(300);
    await page.getByTestId("batch-run").click();
    await waitText(page, "batch-progress", /実行中 — [1-5]\/6 完了/, 600_000);
    await page.getByTestId("batch-cancel").click();
    const cancelledText = await waitText(page, "batch-progress", /取り消し —/, 600_000);
    console.log(`  cancelled: ${cancelledText.replace(/\n/g, " ")}`);
    await page.screenshot({ path: path.join(OUT_DIR, "04-cancelled.png"), fullPage: true });
    const doneBefore = Number(/(\d+)\/6 完了/.exec(cancelledText)?.[1] ?? 0);
    check(doneBefore >= 1 && doneBefore < 6, "取り消し時点で一部だけ完了している", cancelledText);
    check(await page.getByTestId("batch-write").isEnabled(), "取り消し後も、計算できた分は書き出せる");
    await page.getByTestId("batch-run").click();
    await waitText(page, "batch-progress", /完了 — 6\/6 完了/, 900_000);
    await page.screenshot({ path: path.join(OUT_DIR, "05-resumed.png"), fullPage: true });
    const cached = await page.locator('[data-testid^="batch-state-"]', { hasText: "キャッシュ" }).count();
    check(cached >= doneBefore, "同じ設定の再実行で、計算済みの組はキャッシュ表示", { cached, doneBefore });
  } finally {
    // resetDb はアルバムを消さないので、自分で作ったものは自分で消す
    if (albumId) await fetch(`${base}/api/albums/${albumId}`, { method: "DELETE" }).catch(() => {});
    await d.stop();
  }
  console.log(`\n合格 ${passed} / 失敗 ${failures.length}${failures.length ? `\n  失敗: ${failures.join(" / ")}` : ""}`);
  process.exitCode = failures.length ? 1 : 0;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
