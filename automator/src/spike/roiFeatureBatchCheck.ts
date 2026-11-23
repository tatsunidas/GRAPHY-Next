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
 *   6. QC: 環境設定の小さい ROI の基準値を 1000 にして「止める」で実行 → 400 ボクセルの組で止まり、許容して続けると完了。
 *      止めた組の値・旗が予測（400 ＜ 1000）と一致。基準値が未設定なら止まらず「判定していません」（負例）。
 *   6d. 小さい ROI の基準値を定義に持たせる: 環境設定が未設定でも定義の 1000 で止まり、環境設定 1000 でも定義の 100 が優先
 *      （旗なし・キャッシュを使い回す）。保存・読込で復元、数字でない入力は反映しない（負例）。
 *   7. 定義: 保存 → 開き直して読み込む → 欄と SHA-256 が復元。書き換えたファイル・SHA-256 の無いファイルは断られ、
 *      欄は変わらない。読み込んで実行した結果の Provenance_SettingsSha256 が、手で同じ設定にして実行した結果と同じ。
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
import { openAllGroups } from "./openGroups.js";
import { dismissUpdateDialog } from "./dismissUpdateDialog.js";
import { PY, PY_FLAGS } from "./pythonCmd.js";

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
/** 検査 0・1 が患者 A、検査 2 が患者 B、検査 3 は既定の患者 ID。 */
const PATIENT_IDS = ["SYNTHBATCH-A", "SYNTHBATCH-A", "SYNTHBATCH-B"];

function makeSynth(i: number, patientId?: string): Synth & { dir: string } {
  const dir = path.join(OUT_DIR, `synth${i}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const seed = String((Date.now() + i * 7919) % 2_000_000_000);
  const r = spawnSync(PY, [...PY_FLAGS, path.join(import.meta.dirname, "roiFeatureSynth.py"), dir, seed, "-1000", ...(patientId ? [patientId] : [])], { encoding: "utf8" });
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
/** 先頭の記録の列（症例ラベル・Provenance_* の 5 列と、ROI の大きさ・警告の 6 列）。旧い書き出し用で、今は使わない。 */
const NREC = 11;

/** 表を見出しと行に分ける（BOM は無視）。 */
function parseFeatures(csv: string): { header: string[]; rows: string[][] } {
  const lines = csv.replace(/^\uFEFF/, "").split("\r\n").filter(Boolean);
  return { header: splitRow(lines[0]), rows: lines.slice(1).map(splitRow) };
}
/** 特徴量の列の始まり（`Warning_SmallRoi` の次）。識別・記録・大きさの列は列名で引き、位置を決め打ちしない。 */
const featureStart = (header: string[]): number => header.indexOf("Warning_SmallRoi") + 1;

interface Download { name: string; text: string; head: number[] }
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

async function caseLabelInputsOf(page: Page): Promise<{ value: string; placeholder: string }[]> {
  return page.locator('[data-testid^="batch-caselabel-"]').evaluateAll((els) =>
    els.map((e) => ({ value: (e as HTMLInputElement).value, placeholder: (e as HTMLInputElement).placeholder })));
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const synths = [0, 1, 2, 3].map((i) => makeSynth(i, PATIENT_IDS[i]));
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
            fetch(a.href).then(function (r) { return r.arrayBuffer(); }).then(function (buf) {
              var head = Array.prototype.slice.call(new Uint8Array(buf).slice(0, 3));
              var text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(buf);
              window.__roiDownloads.push({ name: name, text: text, head: head });
            });
            return;
          }
          return orig.call(this);
        };
      })()
    `);

    console.log("\n[2] ボタンの有効・無効");
    await dismissUpdateDialog(page);
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
    // 表を開いた直後（どの行も未入力）: 欄は空のまま、行ごとに違う「予定のラベル」を placeholder に出す（全行が C001 に見えない）
    const firstInputs = await caseLabelInputsOf(page);
    check(firstInputs.length === 5 && firstInputs.every((x) => x.value === ""), "症例ラベルの欄は、開いた直後は 5 行とも空", firstInputs);
    check(new Set(firstInputs.map((x) => x.placeholder)).size === 5
      && firstInputs.map((x) => x.placeholder).join(",") === "C001,C002,C003,C004,C005", "予定のラベル（placeholder）は行ごとに違い、C001 から並ぶ", firstInputs.map((x) => x.placeholder));
    await page.screenshot({ path: path.join(OUT_DIR, "01b-planned-labels.png"), fullPage: true });

    let plannedLabels: string[] = [];
    console.log("\n[3b] 1 組だけ試す（ファイルは書かない）");
    await page.getByTestId("batch-trial").click();
    const trialText = await waitText(page, "batch-trial-result", /特徴量を計算しました/, 180_000);
    const nCols = Number(/(\d+) 列/.exec(trialText)?.[1] ?? 0);
    check(nCols >= 150, "試行で 150 列以上の特徴量を計算", trialText);
    check(((await page.evaluate("window.__roiDownloads.length")) as number) === 0, "試行ではファイルを書かない");
    check(posted.length === 1 && (posted[0].pairs as unknown[]).length === 1, "試行は 1 組だけ送る", posted[0]?.pairs);
    check((posted[0].settings as Record<string, string>).DOUBLEARRAY_resamplingFactorXYZ === "1,1,1", "既定のまま送った設定は、等方 1 mm のリサンプリング", posted[0]?.settings);

    console.log("\n[4] 要確認の組を選んで一括実行 → 書き出し");
    await page.getByTestId(`batch-source-${swapped}`).selectOption(trueSource);
    await page.waitForTimeout(300);
    check(await page.getByTestId(`batch-include-${swapped}`).isChecked(), "元画像を選ぶと対象に入る");
    const sum1 = await page.getByTestId("batch-summary").innerText();
    check(/対象 6/.test(sum1), "対象 6", sum1);
    // 実行前の症例ラベル（入力済み・振り済みの値があればそれ、空なら予定のラベル＝placeholder）。書き出しの CaseLabel と比べる
    plannedLabels = (await caseLabelInputsOf(page)).map((x) => x.value || x.placeholder);
    await page.getByTestId("batch-run").click();
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(OUT_DIR, "02-progress.png"), fullPage: true });
    {
      const footerEl = page.getByTestId("batch-progress-footer");
      check(await footerEl.isVisible(), "実行中、下端の帯に進捗の要約が出る");
      const inside = await page.evaluate(() => {
        const f = document.querySelector('[data-testid="batch-progress-footer"]')?.getBoundingClientRect();
        const d = document.querySelector('[data-testid="batch-dialog"]')?.getBoundingClientRect();
        if (!f || !d) return null;
        return { f: { t: f.top, b: f.bottom, l: f.left, r: f.right, h: f.height }, d: { t: d.top, b: d.bottom, l: d.left, r: d.right } };
      });
      check(!!inside && inside.f.h > 0 && inside.f.t >= inside.d.t && inside.f.b <= inside.d.b && inside.f.l >= inside.d.l && inside.f.r <= inside.d.r,
        "帯の要約は、スクロールせずにダイアログの矩形の内側に見える", inside);
    }
    const prog = await waitText(page, "batch-progress", /完了 — 6\/6 完了/, 600_000);
    {
      const ft = await page.getByTestId("batch-progress-footer").innerText();
      console.log(`  footer(done): ${ft}`);
      check(/^完了 — 6\/6・失敗 0・経過 (\d+:)?\d+:\d{2}$/.test(ft.trim()), "終了後の帯に「完了 — 6/6・失敗 0・経過 …」が出る", ft);
      const st = await page.locator('[data-testid^="batch-state-"]').allInnerTexts();
      check(st.filter((x) => /^完了 \d+:\d{2}/.test(x)).length + st.filter((x) => /キャッシュ/.test(x)).length >= 6, "計算済みの組の状態に、かかった時間（完了 m:ss）が出る", st);
    }
    console.log(`  progress: ${prog.replace(/\n/g, " ")}`);
    // この合成データは全検査が同じ間隔（0.7×0.7×2 mm）なので、間隔の注意は出ない（負例。出る側は mixedSpacingCheck）
    check((await page.getByTestId("batch-spacing-warn").count()) === 0 && (await page.getByTestId("batch-spacing-info").count()) === 0, "間隔がそろっているので、間隔の注意は出ない");
    await page.screenshot({ path: path.join(OUT_DIR, "03-done.png"), fullPage: true });
    const req = posted[posted.length - 1];
    check((req.pairs as unknown[]).length === 6 && (req.roiModes as string[]).join() === "WHOLE_3D", "全件実行は 6 組・3D だけ", req.roiModes);
    check(req.scales == null, "スケールは送らない");
    check(await page.getByTestId("batch-write").isEnabled(), "書き出しボタンが有効");
    await page.getByTestId("batch-prefix").fill("batchcheck");
    await page.getByTestId("batch-write").click();
    const dl = await takeDownloads(page, 5);
    for (const f of dl) fs.writeFileSync(path.join(OUT_DIR, f.name), f.text);
    check(dl.length === 5, "5 ファイルが出る（定義を含む）", dl.map((f) => f.name));
    const features = dl.find((f) => f.name === "batchcheck.csv");
    const subjectsPrivate = dl.find((f) => f.name === "batchcheck_subjects_private.csv");
    check(dl.map((f) => f.name).sort().join() === ["batchcheck.csv", "batchcheck_definitions.csv", "batchcheck_radiomicsj.properties", "batchcheck_spec.json", "batchcheck_subjects_private.csv"].sort().join(),
      "5 ファイルの名前（表・定義表・設定・定義・被験者の対応表）", dl.map((f) => f.name));
    check(!!features && !!subjectsPrivate, "表と被験者の対応表がある");
    check(!dl.some((f) => f.text.includes(PATIENT_NAME)), "どのファイルにも患者名が無い");
    // 患者 ID は既定で表にも入る（利用者の要望。画面に警告を常に出す）。定義表・設定・定義には入らない
    check(!dl.filter((f) => f !== subjectsPrivate && f !== features).some((f) => f.text.includes("SYNTHBATCH")), "患者 ID は、被験者の対応表と結果の表だけに入る（定義表・設定・定義には入らない）");
    check(!!features && features.text.includes("SYNTHBATCH"), "既定では、結果の表にも患者 ID が入る");
    if (features && subjectsPrivate) {
      const feat = parseFeatures(features.text);
      const col = (n: string) => feat.header.indexOf(n);
      check(feat.rows.length === 6, "表は 6 行（送った組の数）", feat.rows.length);
      check(features.head.join() !== "239,187,191", "BOM なし");
      check(feat.header[1] === "PatientID" && feat.rows.every((r) => r[1].startsWith("SYNTHBATCH")), "既定では PatientID の列が表の 2 列目にある", feat.header.slice(0, 3));
      check(feat.rows.every((r) => r[col("RowStatus")] === "DONE"), "状態はすべて DONE");
      check(feat.rows.map((r) => r[col("SubjectCode")]).join() === "S001,S001,S001,S001,S002,S002",
        "SubjectCode: 患者 A の 4 組が S001、患者 B の 2 組が S002", feat.rows.map((r) => r[col("SubjectCode")]));
      check(feat.rows.every((r) => r[col("Album")].startsWith("batch-check-")), "Album の列にアルバム名が入る");
      const subj = subjectsPrivate.text.split("\r\n").filter(Boolean).map(splitRow);
      check(subj[0].join() === "SubjectCode,PatientID,StudyInstanceUID" && subj.length === 4, "被験者の対応表: 見出し + 検査 3 件（SEG のある検査だけ）", subj);
      check(subj[1].join() === `S001,SYNTHBATCH-A,${synths[0].studyInstanceUid}` && subj[2].join() === `S001,SYNTHBATCH-A,${synths[1].studyInstanceUid}`
        && subj[3].join() === `S002,SYNTHBATCH-B,${synths[2].studyInstanceUid}`, "対応表: 患者 A の 2 検査が S001、患者 B の検査が S002");
      const specObj0 = JSON.parse(dl.find((f) => f.name === "batchcheck_spec.json")!.text) as { sha256: string };
      check(feat.rows.every((r) => r[col("Provenance_SpecSha256")] === specObj0.sha256), "全行の Provenance_SpecSha256 が定義の sha256 と一致");
      let mismatched = 0;
      let compared = 0;
      const start = featureStart(feat.header);
      for (const r of feat.rows) {
        const direct = await apiFeatures(base, {
          studyInstanceUid: r[col("StudyInstanceUID")], sourceSeriesUid: r[col("SourceSeriesUID")], maskSeriesUid: r[col("MaskSeriesUID")],
          maskChannel: Number(r[col("Roi_MaskChannel")]), channel: 0, timePoint: 0, settings: req.settings, valueSpec: req.valueSpec, recompute: true,
        });
        const names = feat.header.slice(start);
        const values = r.slice(start).map(Number);
        const same = names.length === direct.rows.length && names.every((n, k) => n === direct.rows[k].column)
          && direct.rows.every((x, k) => Object.is(values[k], x.value ?? NaN));
        compared++;
        if (!same) mismatched++;
      }
      check(compared === 6 && mismatched === 0, "6 行すべてで、同じ組の API 直呼び（キャッシュなし）と全列の差 0", { compared, mismatched });
      const labels = feat.rows.map((r) => r[0]);
      check(new Set(labels).size === 6 && labels[0] === "C001", "症例ラベルが C001… と重複なしで振られる", labels);
      check(JSON.stringify([...plannedLabels].sort()) === JSON.stringify([...labels].sort()), "実行前に表示した予定のラベルと、書き出した CSV の症例ラベルが同じ集合", { plannedLabels, labels });
    }

    console.log("\n[5] 取り消しと続きからの再実行（重い設定）");
    await page.getByTestId("batch-bincount").locator("input").fill("16");
    await page.getByTestId("batch-bincount").locator("input").press("Enter");
    await page.getByTestId("batch-resampling").selectOption("iso");
    await page.getByTestId("batch-resample-mm").locator("input").fill("0.35");
    await page.getByTestId("batch-resample-mm").locator("input").press("Enter");
    await page.waitForTimeout(300);
    await page.getByTestId("batch-run").click();
    // 途中の状態を観測できるだけ重い設定にしてある。観測できずに終わったら、検査できていないので失敗にする（合格にしない）
    const running = await waitText(page, "batch-progress", /実行中 — [1-5]\/6 完了/, 600_000)
      .catch((e: Error) => { check(false, "取り消しを試せる途中の状態を観測できた", e.message); throw e; });
    console.log(`  running: ${running.replace(/\n/g, " ")}`);
    {
      // 重い設定で実行中のまま読める。1 回目は計算中の組が見えるまで待つ（組の切り替わりの合間は「待機」形式になる）
      const footerEl = page.getByTestId("batch-progress-footer");
      const secOf = (x: string): number => {
        const m = /経過 (?:(\d+):)?(\d+):(\d{2})/.exec(x);
        return m ? Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) : -1;
      };
      await footerEl.filter({ hasText: /^計算中 / }).waitFor({ state: "visible", timeout: 60_000 });
      const t1 = await footerEl.innerText();
      const bodyProg = await page.getByTestId("batch-progress").innerText();
      const doneBody = Number(/(\d+)\/\d+ 完了/.exec(bodyProg)?.[1] ?? -1);
      const m1 = /^計算中 (\d+)\/6（(C\d{3})）・完了 (\d+)・失敗 0・経過 \d+:\d{2}$/.exec(t1.trim());
      console.log(`  footer(running 1): ${t1} / body: ${bodyProg.replace(/\n/g, " ")}`);
      check(!!m1 && Number(m1[1]) === Number(m1[3]) + 1, "実行中の帯は「計算中 n/6（ラベル）・完了 N・失敗 0・経過 m:ss」で、n は完了 N の次の組", t1);
      check(!!m1 && Math.abs(doneBody - Number(m1[3])) <= 1, "帯の「完了 N」が本文の件数と矛盾しない", { t1, bodyProg });
      check(await footerEl.isVisible(), "重い設定の実行中も帯が見える");
      await page.screenshot({ path: path.join(OUT_DIR, "04a-running-footer.png"), fullPage: true });
      await page.waitForTimeout(3000);
      const t2 = await footerEl.innerText();
      console.log(`  footer(running 2): ${t2}`);
      check(/計算中|待機中|実行中/.test(t2) && secOf(t1) >= 0 && secOf(t2) > secOf(t1), "経過時間を（実行中のまま）2 回読んで、後の方が大きい", { t1, t2 });
    }
    await page.getByTestId("batch-cancel").click();
    const cancelledText = await waitText(page, "batch-progress", /取り消し —/, 600_000);
    console.log(`  cancelled: ${cancelledText.replace(/\n/g, " ")}`);
    await page.screenshot({ path: path.join(OUT_DIR, "04-cancelled.png"), fullPage: true });
    const doneBefore = Number(/(\d+)\/6 完了/.exec(cancelledText)?.[1] ?? 0);
    check(doneBefore >= 1 && doneBefore < 6, "取り消し時点で一部だけ完了している", cancelledText);
    check(await page.getByTestId("batch-write").isEnabled(), "取り消し後も、計算できた分は書き出せる");
    // 取り消した途中で書き出す: 取り消した組も行に残り、特徴量・記録は空欄（0 でも NaN でもない）
    await page.getByTestId("batch-prefix").fill("cancelcheck");
    await page.getByTestId("batch-write").click();
    const dlC = await takeDownloads(page, 5);
    for (const f of dlC) fs.writeFileSync(path.join(OUT_DIR, f.name), f.text);
    const featC = parseFeatures(dlC.find((f) => f.name === "cancelcheck.csv")!.text);
    const cC = (n: string) => featC.header.indexOf(n);
    const cancelledRows = featC.rows.filter((r) => r[cC("RowStatus")] === "CANCELLED");
    check(featC.rows.length === 6, "取り消しの途中でも表は 6 行（送った組の数）", featC.rows.length);
    check(featC.rows.filter((r) => r[cC("RowStatus")] === "DONE").length === doneBefore && cancelledRows.length === 6 - doneBefore,
      "完了と取り消しの行数が画面の表示と一致", { doneBefore, cancelled: cancelledRows.length });
    check(cancelledRows.every((r) => r.slice(featureStart(featC.header)).every((c) => c === "") && r[cC("Provenance_ExtractedAt")] === ""),
      "取り消した行は、特徴量と記録が空欄（0 でも NaN でもない）");
    check(cancelledRows.every((r) => r[cC("StudyInstanceUID")] !== "" && r[cC("SubjectCode")] !== "" && r[cC("CaseLabel")] !== ""),
      "取り消した行にも、症例ラベル・被験者・UID が残る");
    await page.getByTestId("batch-prefix").fill("");
    await page.getByTestId("batch-run").click();
    await waitText(page, "batch-progress", /完了 — 6\/6 完了/, 900_000);
    await page.screenshot({ path: path.join(OUT_DIR, "05-resumed.png"), fullPage: true });
    const cached = await page.locator('[data-testid^="batch-state-"]', { hasText: "キャッシュ" }).count();
    check(cached >= doneBefore, "同じ設定の再実行で、計算済みの組はキャッシュ表示", { cached, doneBefore });

    // ---- 6. QC ----
    console.log("\n[6] QC: 小さい ROI で止める");
    const put = (v: string) => api(base, "/api/settings", {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ "texture.SmallRoiWarnVoxels": v }),
    });
    // 既定は等方 1 mm のリサンプリング。この検査の QC の予測値（ROI のボクセル数）は元の格子のものなので、開き直したら「なし」にする
    // （既定のままの経路は、最初の実行と、既定の定義の SHA-256 の確認で通す）
    const reopen = async (keepDefaults = false) => {
      await page.getByTestId("batch-close").click();
      await page.waitForTimeout(500);
      await btn.click();
      await page.getByTestId("batch-row-5").waitFor({ state: "visible", timeout: 30_000 });
      await page.waitForTimeout(1500);
      await openAllGroups(page); // ③ 値の扱い・④ QC は既定で閉じている。中の入力を触るので開く
      if (!keepDefaults) {
        await page.getByTestId("batch-resampling").selectOption("none");
        await page.waitForTimeout(300);
      }
    };
    const bincount = page.getByTestId("batch-bincount").locator("input");
    const radio = (id: string, n: number) => page.getByTestId(id).locator('input[type="radio"]').nth(n);

    /** 停止（QC）のたびに「許容して続ける」を押し、完了まで進める。押したあとは停止の表示が消えるのを待つ。 */
    const acceptUntilDone = async (done: RegExp, total?: number): Promise<string> => {
      // 総数を渡すと、その総数の新しいジョブの表示だけを待つ（開き直さないときに、直前のジョブの表示を取り違えない）
      const shown = total ? new RegExp(`^(停止|完了|取り消し) — \\d+/${total} 完了`) : /^(停止|完了|取り消し)/;
      for (let i = 0; i < 10; i++) {
        const txt = await waitText(page, "batch-progress", shown, 300_000);
        if (done.test(txt)) return txt;
        await page.getByTestId("batch-qc-hold").waitFor({ state: "visible", timeout: 30_000 });
        await page.getByTestId("batch-qc-continue").click();
        await page.getByTestId("batch-qc-hold").waitFor({ state: "hidden", timeout: 60_000 }).catch(() => {});
      }
      throw new Error("完了しない");
    };

    await put("1000");
    await reopen();
    check(await bincount.inputValue() === "32", "開き直すと設定は既定に戻る");
    await radio("batch-qc-small", 1).check();
    await page.getByTestId("batch-run").click();
    await page.getByTestId("batch-qc-hold").waitFor({ state: "visible", timeout: 300_000 });
    const hold1 = await page.getByTestId("batch-qc-hold").innerText();
    console.log(`  hold1: ${hold1.replace(/\n/g, " ")}`);
    check(/C002/.test(hold1) && /小さい ROI/.test(hold1), "最初の小さい ROI の組（C002）で止まる", hold1);
    check(/400 ボクセル/.test(hold1) && /1000/.test(hold1), "400 ボクセル ＜ 基準値 1000 が出る（予測値と一致）", hold1);
    const prog1 = await page.getByTestId("batch-progress").innerText();
    check(/停止 — 2\/5 完了/.test(prog1) && /未実行 3/.test(prog1), "2 組完了・3 組は未実行で停止", prog1);
    check(/小さい ROI/.test(await page.getByTestId("batch-flags-1").innerText()), "止めた組に旗が付く");
    check(!(await page.getByTestId("batch-error").isVisible().catch(() => false)), "QC の停止はエラーではない");
    await page.screenshot({ path: path.join(OUT_DIR, "06-qc-hold.png"), fullPage: true });

    await page.getByTestId("batch-qc-continue").click();
    // 止めた組の結果は残るので、最後の組で止まったときも「5/5 完了」と数える
    await waitText(page, "batch-progress", /停止 — 5\/5 完了/, 300_000);
    await page.getByTestId("batch-qc-hold").waitFor({ state: "visible", timeout: 60_000 });
    const hold2 = await page.getByTestId("batch-qc-hold").innerText();
    check(/C005/.test(hold2), "許容した組では止まらず、次の小さい ROI の組（C005）で止まる", hold2);
    await page.getByTestId("batch-qc-continue").click();
    const doneQc = await waitText(page, "batch-progress", /完了 — 5\/5 完了/, 300_000);
    console.log(`  qc done: ${doneQc.replace(/\n/g, " ")}`);
    await page.screenshot({ path: path.join(OUT_DIR, "07-qc-done.png"), fullPage: true });
    await page.getByTestId("batch-prefix").fill("qccheck");
    await page.getByTestId("batch-write").click();
    const dlQc = await takeDownloads(page, 5);
    const qcFeatures = dlQc.find((f) => f.name === "qccheck.csv");
    const qcSpec = dlQc.find((f) => f.name === "qccheck_spec.json");
    check(!!qcFeatures && !!qcSpec, "QC の実行でも 5 ファイルが出る", dlQc.map((f) => f.name));
    if (qcFeatures && qcSpec) {
      const feat = parseFeatures(qcFeatures.text);
      const iVox = feat.header.indexOf("Roi_IntensityMaskVoxels");
      const iWarn = feat.header.indexOf("Warning_SmallRoi");
      const small = feat.rows.filter((r) => r[iVox] === "400");
      const big = feat.rows.filter((r) => r[iVox] === "5760");
      check(feat.rows.length === 5 && small.length === 2 && big.length === 3, "5 行（400 ボクセル 2・5760 ボクセル 3）", feat.rows.map((r) => r[iVox]));
      check(small.every((r) => r[iWarn] === "1") && big.every((r) => r[iWarn] === "0"), "Warning_SmallRoi が 400→1・5760→0（予測どおり）");
      const iFlags = feat.header.indexOf("Provenance_QcFlags");
      const flagged = feat.rows.filter((r) => r[iFlags].includes("SMALL_ROI"));
      check(feat.rows.length === 5 && flagged.length === 2 && flagged.every((r) => r[iVox] === "400"),
        "表の Provenance_QcFlags: 小さい 2 組（400 ボクセル）だけに SMALL_ROI", feat.rows.map((r) => r[iFlags]));
      const specObj = JSON.parse(qcSpec.text) as { sha256: string; qc: { smallRoi: string } };
      check(feat.rows.every((r) => r[feat.header.indexOf("Provenance_SpecSha256")] === specObj.sha256), "表の Provenance_SpecSha256 が書き出した定義の sha256 と一致", specObj.sha256);
      check(specObj.qc.smallRoi === "STOP", "書き出した定義に QC の設定（止める）が残る");
      // 止まって続けた組の値が、止まらずに直接計算した値と全列で一致する
      const reqNow = posted[posted.length - 1];
      let mismatched = 0;
      for (let i = 0; i < feat.rows.length; i++) {
        const fc = (n: string) => feat.rows[i][feat.header.indexOf(n)];
        const direct = await apiFeatures(base, {
          studyInstanceUid: fc("StudyInstanceUID"), sourceSeriesUid: fc("SourceSeriesUID"), maskSeriesUid: fc("MaskSeriesUID"),
          maskChannel: Number(fc("Roi_MaskChannel")), channel: 0, timePoint: 0, settings: reqNow.settings, valueSpec: reqNow.valueSpec, recompute: true,
        });
        const names = feat.header.slice(featureStart(feat.header));
        const values = feat.rows[i].slice(featureStart(feat.header)).map(Number);
        const same = names.length === direct.rows.length && names.every((n, k) => n === direct.rows[k].column)
          && direct.rows.every((r, k) => Object.is(values[k], r.value ?? NaN));
        if (!same) mismatched++;
      }
      check(mismatched === 0, "止めて許容して続けた結果が、直接計算した値と全列で差 0（5 行）", mismatched);
    }

    console.log("\n[6b] 負例: 基準値が未設定なら判定せず、止めない");
    await put("");
    await reopen();
    await radio("batch-qc-small", 1).check();
    await page.getByTestId("batch-run").click();
    await waitText(page, "batch-progress", /完了 — 5\/5 完了/, 300_000);
    check(!(await page.getByTestId("batch-qc-hold").isVisible().catch(() => false)), "基準値が未設定なら「止める」でも止まらない");
    const unset = await page.getByTestId("batch-unset-threshold").innerText().catch(() => "");
    check(/判定していません/.test(unset), "「小さい ROI は判定していません」と出る（警告なしとは書かない）", unset);
    check((await page.locator('[data-testid^="batch-flags-"]').count()) === 0, "旗は 1 つも付かない");
    await page.screenshot({ path: path.join(OUT_DIR, "08-unset.png"), fullPage: true });
    await put("1000");

    console.log("\n[6c] 「対象から外して続ける」");
    await reopen();
    await radio("batch-qc-small", 1).check();
    await page.getByTestId("batch-run").click();
    await page.getByTestId("batch-qc-hold").waitFor({ state: "visible", timeout: 300_000 });
    check(/C002/.test(await page.getByTestId("batch-qc-hold").innerText()), "C002 で止まる");
    await page.getByTestId("batch-qc-exclude").click();
    // 押した直後は古い停止の表示が残る。消えてから、次の停止を待つ
    await page.getByTestId("batch-qc-hold").waitFor({ state: "hidden", timeout: 60_000 });
    await page.getByTestId("batch-qc-hold").waitFor({ state: "visible", timeout: 300_000 });
    const holdEx = await page.getByTestId("batch-qc-hold").innerText();
    check(/C005/.test(holdEx), "C002 を外して続けると、次の小さい ROI の組（C005）で止まる", holdEx);
    check(!(await page.getByTestId("batch-include-1").isChecked()), "外した組は対象から外れている");
    await page.getByTestId("batch-qc-exclude").click();
    const doneEx = await waitText(page, "batch-progress", /完了 — 3\/3 完了/, 300_000);
    check(/3\/3 完了/.test(doneEx), "両方を外すと、残りの 3 組で完了", doneEx);
    await page.screenshot({ path: path.join(OUT_DIR, "08b-qc-excluded.png"), fullPage: true });

    // ---- 6d. 基準値を定義に持たせる ----
    console.log("\n[6d] 基準値を定義に持たせる（環境設定が未設定でも効く・環境設定より優先・キャッシュは使い回す）");
    const voxels = page.getByTestId("batch-qc-voxels");
    await put("");
    await reopen();
    check((await voxels.inputValue()) === "", "基準値の欄は既定で空（環境設定の値を使う）");
    await radio("batch-qc-small", 1).check();
    await voxels.fill("1000");
    await page.getByTestId("batch-run").click();
    await page.getByTestId("batch-qc-hold").waitFor({ state: "visible", timeout: 300_000 });
    const holdV = await page.getByTestId("batch-qc-hold").innerText();
    console.log(`  holdV: ${holdV.replace(/\n/g, " ")}`);
    check(/C002/.test(holdV) && /400 ボクセル/.test(holdV) && /1000/.test(holdV),
      "環境設定が未設定でも、定義の基準値 1000 で C002（400 ボクセル）が止まる（予測 400 ＜ 1000 と一致）", holdV);
    check((await page.getByTestId("batch-unset-threshold").count()) === 0, "基準値があるので「判定していません」は出ない");
    check(/キャッシュ/.test(await page.getByTestId("batch-state-0").innerText()), "基準値を足しても計算し直さず、キャッシュを使う");
    await page.screenshot({ path: path.join(OUT_DIR, "08c-qc-voxels-hold.png"), fullPage: true });
    await acceptUntilDone(/^完了 — 5\/5 完了/, 5);

    await put("1000");
    await reopen();
    await radio("batch-qc-small", 1).check();
    await voxels.fill("100");
    await page.getByTestId("batch-run").click();
    await waitText(page, "batch-progress", /完了 — 5\/5 完了/, 300_000);
    check(!(await page.getByTestId("batch-qc-hold").isVisible().catch(() => false)), "環境設定 1000・定義の基準値 100 → 止まらない（定義が優先）");
    check((await page.locator('[data-testid^="batch-flags-"]').count()) === 0, "小さい ROI の旗は 1 つも付かない（400 ≧ 100）");
    const states = (await page.locator('[data-testid^="batch-state-"]').allInnerTexts()).filter((x) => x.startsWith("完了"));
    check(states.length === 5 && states.every((x) => /キャッシュ/.test(x)), "基準値を変えても 5 組すべてキャッシュから（再計算しない）", states);
    await page.screenshot({ path: path.join(OUT_DIR, "08d-qc-voxels-override.png"), fullPage: true });
    const shownV = await page.getByTestId("batch-spec-sha").getAttribute("title");
    await page.getByTestId("batch-spec-save").click();
    const [savedV] = await takeDownloads(page, 1);
    fs.writeFileSync(path.join(OUT_DIR, "voxels_spec.json"), savedV.text);
    const specV = JSON.parse(savedV.text) as { sha256: string; qc: { smallRoiVoxels?: number } };
    check(specV.qc.smallRoiVoxels === 100 && specV.sha256 === shownV, "保存した定義に基準値が入り、sha256 が画面の表示と一致", { v: specV.qc.smallRoiVoxels, file: specV.sha256, shown: shownV });
    await reopen();
    check((await voxels.inputValue()) === "", "開き直すと基準値の欄は空に戻る");
    await page.getByTestId("batch-spec-file").setInputFiles(path.join(OUT_DIR, "voxels_spec.json"));
    await waitText(page, "batch-info", /読み込みました/, 20_000);
    await page.waitForTimeout(400);
    check((await voxels.inputValue()) === "100", "定義を読み込むと基準値が復元される");
    check((await page.getByTestId("batch-spec-sha").getAttribute("title")) === shownV, "SHA-256 の表示が保存時と同じ");
    // 数字でない値は確定せず、定義は変わらない（赤枠）
    // 定義の SHA-256 の表示は、非同期のハッシュ計算（crypto.subtle.digest）のあとで更新される。入力の直後に読むと、
    // 「変わっていない」のか「まだ更新されていない」のか区別できないので、変わる側は変わるまで待ち、変わらない側は十分待ってから見る
    await voxels.fill("12a");
    await page.waitForTimeout(800);
    check((await page.getByTestId("batch-spec-sha").getAttribute("title")) === shownV, "数字でない入力は定義に反映されない（負例）");
    await page.screenshot({ path: path.join(OUT_DIR, "08e-qc-voxels-invalid.png"), fullPage: true });
    await voxels.fill("");
    const shaImmediate = await page.getByTestId("batch-spec-sha").getAttribute("title");
    const tFill = Date.now();
    let shaAfter = shaImmediate;
    while (shaAfter === shownV && Date.now() - tFill < 5000) {
      await page.waitForTimeout(50);
      shaAfter = await page.getByTestId("batch-spec-sha").getAttribute("title");
    }
    console.log(`  sha: 入力の直後=${shaImmediate === shownV ? "変更前のまま" : "更新済み"}、${Date.now() - tFill} ms 待って=${shaAfter === shownV ? "変更前のまま" : "更新済み"}`);
    check(shaAfter !== shownV, "空欄にすると基準値なしの定義になる（SHA-256 が変わる。ハッシュの更新を待って確かめる）");
    await put("1000");

    // ---- 7. 定義 ----
    console.log("\n[7] 定義の保存・読込・改ざんの拒否・SHA-256");
    await reopen();
    await bincount.fill("16");
    await bincount.press("Enter");
    await page.getByTestId("batch-labels").fill("smallbox");
    await radio("batch-qc-small", 1).check();
    await page.getByTestId("batch-prefix").fill("speccheck");
    await page.waitForTimeout(500);
    const shownA = await page.getByTestId("batch-spec-sha").getAttribute("title");
    await page.getByTestId("batch-spec-save").click();
    const [savedSpec] = await takeDownloads(page, 1);
    fs.writeFileSync(path.join(OUT_DIR, savedSpec.name), savedSpec.text);
    const specA = JSON.parse(savedSpec.text) as { sha256: string; form: { binCount: number }; selection: { segmentLabels: string[] } };
    check(savedSpec.name === "speccheck_spec.json", "定義のファイル名は接頭辞つき", savedSpec.name);
    check(specA.sha256 === shownA, "保存した定義の sha256 が画面の表示と一致", { file: specA.sha256, shown: shownA });
    check(specA.form.binCount === 16 && specA.selection.segmentLabels[0] === "smallbox", "定義に設定と絞り込みが入る");
    // 手で同じ設定にして実行 → 出力の Provenance_SettingsSha256 を控える
    const sel = await page.getByTestId("batch-summary").innerText();
    check(/対象 2/.test(sel), "絞り込み（SmallBox）で対象は 2 組（BigBox は絞り込み外）", sel);
    check((await page.locator('[data-testid^="batch-state-"]', { hasText: "絞り込み外" }).count()) >= 3, "絞り込み外の組が表に残って表示される");
    await page.getByTestId("batch-run").click();
    await acceptUntilDone(/^完了 — 2\/2 完了/);
    await page.getByTestId("batch-write").click();
    const dlA = await takeDownloads(page, 5);
    const featA = parseFeatures(dlA.find((f) => f.name === "speccheck.csv")!.text);
    const shaCol = featA.header.indexOf("Provenance_SettingsSha256");
    const provA = featA.rows[0][shaCol];
    check(featA.rows.length === 2 && /^[0-9a-f]{64}$/.test(provA), "手で設定して実行: 2 行・設定の SHA-256 が出る", provA);

    // 開き直す → 既定に戻る → 定義を読み込む
    await reopen(true);
    check(await bincount.inputValue() === "32" && (await page.getByTestId("batch-labels").inputValue()) === "", "開き直すと欄は既定");
    check(await page.getByTestId("batch-resampling").inputValue() === "iso" && await page.getByTestId("batch-resample-mm").locator("input").inputValue() === "1",
      "既定のリサンプリングは等方 1 mm");
    check(await page.getByTestId("batch-out-patientid").isChecked() && await page.getByTestId("batch-out-patientid-warn").isVisible(),
      "既定では「患者 ID を表に含める」がオンで、警告が見える");
    await page.screenshot({ path: path.join(OUT_DIR, "10-defaults.png"), fullPage: true });
    const shaDefault = await page.getByTestId("batch-spec-sha").getAttribute("title");
    check(shaDefault !== shownA, "既定の定義の SHA-256 は保存した定義と違う");
    // 校正（PET）と値の種類の項目が増えたので、新しい既定の定義は calibration=auto と valueKind=auto を含む。
    // 正準 JSON のキーを足し引きして別（Python の hashlib）で求めた SHA-256 と同じ。校正も値の種類も無い従来の定義の値 9e08bec6…、
    // 校正だけがある定義の値 f54302dd… は、batchSpec.test.ts が固定値で守る（読み込んでも変わらない）。
    check(shaDefault === "f0f8273683f4304a247ca1ccad7d54687be5fa5ab313c4ce2613feb1776de81c", "既定の定義の SHA-256 は、校正（auto）・値の種類（auto）・リサンプリング 1 mm を含む正準 JSON を独立に求めた値と同じ（実アプリ）", shaDefault);
    await page.getByTestId("batch-spec-file").setInputFiles(path.join(OUT_DIR, savedSpec.name));
    await waitText(page, "batch-info", /読み込みました/, 20_000);
    await page.waitForTimeout(400);
    check(await bincount.inputValue() === "16", "読み込むとビン数が復元される");
    check((await page.getByTestId("batch-labels").inputValue()) === "smallbox", "絞り込みが復元される");
    check(await radio("batch-qc-small", 1).isChecked(), "QC の設定（止める）が復元される");
    check((await page.getByTestId("batch-prefix").inputValue()) === "speccheck", "接頭辞が復元される");
    check((await page.getByTestId("batch-spec-sha").getAttribute("title")) === shownA, "SHA-256 の表示が保存時と同じ");
    await page.screenshot({ path: path.join(OUT_DIR, "09-spec-loaded.png"), fullPage: true });

    // 改ざん・SHA-256 なしは断られ、欄は変わらない
    const tamperPath = path.join(OUT_DIR, "tampered_spec.json");
    const tampered = JSON.parse(savedSpec.text) as Record<string, any>;
    tampered.form.binCount = 64;
    fs.writeFileSync(tamperPath, JSON.stringify(tampered));
    await page.getByTestId("batch-spec-file").setInputFiles(tamperPath);
    await page.getByTestId("batch-error").waitFor({ state: "visible", timeout: 10_000 });
    check(/一致しません/.test(await page.getByTestId("batch-error").innerText()), "書き換えた定義は断られる（SHA-256 が一致しない）");
    check(await bincount.inputValue() === "16", "断られたとき、欄は変わらない（64 にならない）");
    await page.screenshot({ path: path.join(OUT_DIR, "10-spec-tampered.png"), fullPage: true });
    const noShaPath = path.join(OUT_DIR, "nosha_spec.json");
    const noSha = JSON.parse(savedSpec.text) as Record<string, any>;
    delete noSha.sha256;
    fs.writeFileSync(noShaPath, JSON.stringify(noSha));
    await page.getByTestId("batch-spec-file").setInputFiles(noShaPath);
    await page.waitForTimeout(500);
    check(/SHA-256 がありません/.test(await page.getByTestId("batch-error").innerText()), "SHA-256 の無い定義は断られる");

    // 読み込んだ定義で実行 → 手で設定した実行と同じ設定の SHA-256
    await page.getByTestId("batch-spec-file").setInputFiles(path.join(OUT_DIR, savedSpec.name));
    await waitText(page, "batch-info", /読み込みました/, 20_000);
    await page.waitForTimeout(400);
    await page.getByTestId("batch-run").click();
    await acceptUntilDone(/^完了 — 2\/2 完了/);
    await page.getByTestId("batch-write").click();
    const dlB = await takeDownloads(page, 5);
    const featB = parseFeatures(dlB.find((f) => f.name === "speccheck.csv")!.text);
    check(featB.rows[0][shaCol] === provA, "定義を読み込んで実行した結果の設定 SHA-256 が、手で設定した実行と同じ", { a: provA, b: featB.rows[0][shaCol] });
    const specB = JSON.parse(dlB.find((f) => f.name === "speccheck_spec.json")!.text) as { sha256: string };
    check(specB.sha256 === specA.sha256, "書き出した定義の sha256 が保存した定義と同じ");
    check(featB.rows.every((r) => r[featB.header.indexOf("Provenance_SpecSha256")] === specA.sha256), "表の Provenance_SpecSha256 が定義の sha256 と一致");

    // ---- 8. 出力の選択 ----
    console.log("\n[8] 出力の選択: 1 人だけ選んでも SubjectCode は動かない・PatientID を含める・BOM・対応表なし");
    // 患者 B の検査（検査 2）の SmallBox だけを対象にする（絞り込みで対象は 検査 0 と 検査 2 の SmallBox）
    await page.getByTestId("batch-include-1").uncheck();
    await page.getByTestId("batch-out-subjects").uncheck();
    await page.getByTestId("batch-out-patientid").check();
    await page.getByTestId("batch-out-bom").check();
    check(await page.getByTestId("batch-out-patientid-warn").isVisible(), "患者 ID を含めると警告が出る");
    await page.getByTestId("batch-prefix").fill("optcheck");
    await page.screenshot({ path: path.join(OUT_DIR, "11-output-options.png"), fullPage: true });
    await page.getByTestId("batch-run").click();
    await acceptUntilDone(/^完了 — 1\/1 完了/, 1);
    await page.getByTestId("batch-write").click();
    const dlO = await takeDownloads(page, 4);
    check(dlO.map((f) => f.name).sort().join() === ["optcheck.csv", "optcheck_definitions.csv", "optcheck_radiomicsj.properties", "optcheck_spec.json"].sort().join(),
      "対応表を外すと、4 ファイルだけ書く（被験者の対応表は書かない）", dlO.map((f) => f.name));
    for (const f of dlO) fs.writeFileSync(path.join(OUT_DIR, f.name), f.text);
    check(dlO.filter((f) => f.name.endsWith(".csv")).every((f) => f.head.join() === "239,187,191"), "BOM 付き: CSV の先頭 3 バイトが EF BB BF");
    check(dlO.filter((f) => !f.name.endsWith(".csv")).every((f) => f.head.join() !== "239,187,191"), "設定ファイル・定義の JSON には BOM を付けない");
    const featO = parseFeatures(dlO.find((f) => f.name === "optcheck.csv")!.text);
    const cO = (n: string) => featO.header.indexOf(n);
    check(featO.header[0] === "CaseLabel" && featO.header[1] === "PatientID" && featO.header[2] === "SubjectCode", "PatientID を選ぶと、表の 2 列目に入る", featO.header.slice(0, 4));
    check(featO.rows.length === 1 && featO.rows[0][cO("PatientID")] === "SYNTHBATCH-B" && featO.rows[0][cO("StudyInstanceUID")] === synths[2].studyInstanceUid,
      "患者 B の 1 行だけが出る", featO.rows[0]?.slice(0, 6));
    check(featO.rows[0][cO("SubjectCode")] === "S002", "患者 B だけを選んでも SubjectCode は S002（アルバムの並びで決まり、選択では動かない）", featO.rows[0][cO("SubjectCode")]);
    const defsO = dlO.find((f) => f.name === "optcheck_definitions.csv")!.text.replace(/^\uFEFF/, "").split("\r\n").filter(Boolean).slice(1).map((l) => splitRow(l)[0]);
    check(defsO.join() === featO.header.join(), "定義表の行が、表の列と 1 対 1（PatientID の行を含む）");
    await page.screenshot({ path: path.join(OUT_DIR, "12-output-written.png"), fullPage: true });

    // ---- 9. 範囲で除く・6 統計のプリセット ----
    console.log("\n[9] 範囲で除く（片側可）・6 統計のプリセット・定義に範囲");
    const settingsOf = (r: Record<string, unknown>) => (r.settings ?? {}) as Record<string, string>;
    // 定義の SHA-256 は非同期のハッシュ計算の後で更新される。直前の入力の値を読まないよう、値が落ち着く（100 ms ごとに 3 回同じ）まで待つ
    const shaOf = async () => {
      let prev = "";
      let same = 0;
      for (let i = 0; i < 100 && same < 3; i++) {
        await page.waitForTimeout(100);
        const cur = (await page.getByTestId("batch-spec-sha").getAttribute("title")) ?? "";
        same = cur === prev ? same + 1 : 0;
        prev = cur;
      }
      return prev;
    };
    const rangeMin = page.getByTestId("batch-range-min");
    const rangeMax = page.getByTestId("batch-range-max");
    // 族のチェックボックスだけ（計算の単位の欄の「全腫瘍（3D）」などは含めない）
    const familyBoxes = page.getByTestId("batch-settings").locator('input[type="checkbox"][data-testid^="batch-family-"]');
    await reopen();
    await page.getByTestId("batch-prefix").fill("rangecheck");
    check((await page.getByTestId("batch-preset").inputValue()) === "custom", "プリセットは既定で「自分で選ぶ」");
    const presetValues = await page.getByTestId("batch-preset").locator("option").evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
    check(presetValues.join() === "custom,six,texture,all", "一括抽出のプリセットは 6 統計・テクスチャ・すべての族で、「36 特徴」は出ない（LoG が前提のため）", presetValues);
    check((await rangeMin.inputValue()) === "" && (await rangeMax.inputValue()) === "", "範囲の欄は既定で空");

    console.log("  -- 9a. プリセット「6 統計」");
    await page.getByTestId("batch-preset").selectOption("six");
    await page.waitForTimeout(300);
    const checkedLabels = (await familyBoxes.evaluateAll((els) => els.filter((e) => (e as HTMLInputElement).checked).map((e) => e.closest("label")?.textContent?.trim() ?? "")));
    check(checkedLabels.length === 3 && /一次統計/.test(checkedLabels.join()) && /強度ヒストグラム/.test(checkedLabels.join()) && /補助統計/.test(checkedLabels.join()),
      "族がちょうど 3 つ（一次統計・強度ヒストグラム・補助統計）だけオンになる", checkedLabels);
    check((await page.getByTestId("batch-preset").inputValue()) === "six", "選択欄が「6 統計」を示す");
    await page.screenshot({ path: path.join(OUT_DIR, "13-preset-six.png"), fullPage: true });
    await page.getByTestId("batch-trial").click();
    await page.getByTestId("batch-trial-result").waitFor({ state: "visible", timeout: 120_000 });
    const sentSix = settingsOf(posted[posted.length - 1]);
    const onKeys = Object.entries(sentSix).filter(([k, v]) => k.startsWith("BOOL_enable") && v === "1").map(([k]) => k).sort();
    check(onKeys.length === 3 && sentSix.BOOL_enableAuxiliaryStatistics === "1" && sentSix.BOOL_enableGLCM === "0",
      "試行の要求に族が 3 つだけオンで載る", onKeys);
    check(sentSix.DOUBLE_rangeMin === undefined && sentSix.DOUBLE_rangeMax === undefined, "範囲を入れないと範囲は送らない");
    const shaNoRange = await shaOf();

    console.log("  -- 9b. 負例: 下限が上限より大きい");
    await rangeMin.fill("-700");
    await rangeMax.fill("-900");
    check(await page.getByTestId("batch-range-problem").isVisible(), "下限が上限より大きいと警告が出る");
    check(await page.getByTestId("batch-run").isDisabled() && await page.getByTestId("batch-trial").isDisabled()
      && await page.getByTestId("batch-spec-save").isDisabled(), "そのときは「一括で実行」「1 組だけ試す」「定義を保存」を押せない");
    await page.screenshot({ path: path.join(OUT_DIR, "14-range-problem.png"), fullPage: true });
    await rangeMax.fill("");
    check(!(await page.getByTestId("batch-range-problem").isVisible().catch(() => false)), "上限を空にすると警告が消える（下限だけは有効）");
    check(await page.getByTestId("batch-run").isEnabled() && await page.getByTestId("batch-trial").isEnabled()
      && await page.getByTestId("batch-spec-save").isEnabled(), "3 つのボタンが押せる");

    console.log("  -- 9c. 下限だけで一括実行（予測値・直接計算との比較）");
    await rangeMin.fill("-850.5");
    const shaRange = await shaOf();
    check(shaRange !== "" && shaRange !== shaNoRange, "範囲を入れると定義の SHA-256 が変わる");
    await page.getByTestId("batch-run").click();
    await waitText(page, "batch-progress", /^完了 — 5\/5 完了/, 300_000);
    const reqR = posted[posted.length - 1];
    check(settingsOf(reqR).DOUBLE_rangeMin === "-850.5" && settingsOf(reqR).DOUBLE_rangeMax === undefined, "要求に下限だけが載る", settingsOf(reqR));
    await page.getByTestId("batch-write").click();
    const dlR = await takeDownloads(page, 5);
    for (const f of dlR) fs.writeFileSync(path.join(OUT_DIR, f.name), f.text);
    const featR = parseFeatures(dlR.find((f) => f.name === "rangecheck.csv")!.text);
    const cR = (n: string) => featR.header.indexOf(n);
    const VOX = "Diagnostics_DiagnosticsResegmentedROIIntMaskVoxelCount";
    check(cR(VOX) > 0 && featR.rows.length === 5, "表は 5 行（要確認の 1 組は元画像を選ばないので対象外）で、再セグメント後のボクセル数の列がある", { vox: cR(VOX), rows: featR.rows.length });
    const boxVoxels = (b: Box) => (b.r1 - b.r0) * (b.c1 - b.c0) * (b.z1 - b.z0);
    const boxes = { BigBox: [SEG1.r0, SEG1.r1, SEG1.c0, SEG1.c1, SEG1.z0, SEG1.z1], SmallBox: [SEG2.r0, SEG2.r1, SEG2.c0, SEG2.c1, SEG2.z0, SEG2.z1] };
    const predicted = synths.slice(0, 3).map((s) => {
      const r = spawnSync(PY, [...PY_FLAGS, path.join(import.meta.dirname, "roiFeatureRangeCount.py"), s.dir, "-850.5", JSON.stringify(boxes)], { encoding: "utf8" });
      if (r.status !== 0) throw new Error(`予測値を数えられません: ${r.stderr}`);
      return JSON.parse(r.stdout) as { BigBox: number; SmallBox: number };
    });
    let voxOk = 0;
    const voxDetail: unknown[] = [];
    for (const r of featR.rows) {
      const si = synths.findIndex((s) => s.studyInstanceUid === r[cR("StudyInstanceUID")]);
      const name = Number(r[cR("Roi_MaskChannel")]) === 0 ? "BigBox" : "SmallBox";
      const want = predicted[si]?.[name as "BigBox" | "SmallBox"];
      const got = Number(r[cR(VOX)]);
      voxDetail.push({ study: si, name, got, want });
      if (want !== undefined && got === want) voxOk++;
    }
    check(voxOk === 5, "対象の 5 組すべてで、再セグメント後のボクセル数が予測値（合成 CT の箱の中で ≥ -850.5 の画素数）と一致", voxDetail);
    check(predicted.every((p) => p.BigBox < boxVoxels(SEG1) && p.BigBox > 0 && p.SmallBox < boxVoxels(SEG2) && p.SmallBox > 0),
      "予測値は箱の全体より小さく 0 でもない（範囲が実際に効く条件）", predicted);
    let diffR = 0;
    const startR = featureStart(featR.header);
    for (const r of featR.rows) {
      const direct = await apiFeatures(base, {
        studyInstanceUid: r[cR("StudyInstanceUID")], sourceSeriesUid: r[cR("SourceSeriesUID")], maskSeriesUid: r[cR("MaskSeriesUID")],
        maskChannel: Number(r[cR("Roi_MaskChannel")]), channel: 0, timePoint: 0, settings: reqR.settings, valueSpec: reqR.valueSpec, recompute: true,
      });
      const names = featR.header.slice(startR);
      const values = r.slice(startR).map(Number);
      const same = names.length === direct.rows.length && names.every((n, k) => n === direct.rows[k].column)
        && direct.rows.every((x, k) => Object.is(values[k], x.value ?? NaN));
      if (!same) diffR++;
    }
    check(diffR === 0, "5 行すべてで、同じ組の API 直呼び（同じ範囲・キャッシュなし）と全列の差 0", { diffR });
    const specR = JSON.parse(dlR.find((f) => f.name === "rangecheck_spec.json")!.text) as { sha256: string; form: Record<string, unknown> };
    check(specR.form.rangeMin === -850.5 && !("rangeMax" in specR.form), "書き出した定義に下限だけが入る（上限のキーは無い）", specR.form);
    check(specR.sha256 === shaRange && featR.rows.every((r) => r[cR("Provenance_SpecSha256")] === shaRange), "定義と全行の Provenance_SpecSha256 が画面の SHA-256 と一致");

    console.log("  -- 9d. 定義の保存・読込・拒否");
    await page.getByTestId("batch-spec-save").click();
    const [savedR] = await takeDownloads(page, 1);
    fs.writeFileSync(path.join(OUT_DIR, "range_spec.json"), savedR.text);
    const specSaved = JSON.parse(savedR.text) as { sha256: string; form: Record<string, unknown> };
    check(specSaved.form.rangeMin === -850.5 && !("rangeMax" in specSaved.form) && specSaved.sha256 === shaRange, "保存した定義に下限だけが入り、sha256 が画面の表示と一致");
    await reopen();
    check((await rangeMin.inputValue()) === "" && (await shaOf()) !== shaRange, "開き直すと範囲の欄は空に戻る");
    await page.getByTestId("batch-spec-file").setInputFiles(path.join(OUT_DIR, "range_spec.json"));
    await waitText(page, "batch-info", /読み込みました/, 20_000);
    await page.waitForTimeout(400);
    check((await rangeMin.inputValue()) === "-850.5" && (await rangeMax.inputValue()) === "", "定義を読み込むと範囲が復元される（下限 -850.5・上限は空）");
    check((await page.getByTestId("batch-preset").inputValue()) === "six" && (await shaOf()) === shaRange, "プリセット表示も戻り、SHA-256 が保存時と同じ");
    await page.screenshot({ path: path.join(OUT_DIR, "15-range-loaded.png"), fullPage: true });
    const tamperedR = JSON.parse(savedR.text) as { form: Record<string, unknown> };
    tamperedR.form.rangeMin = -800;
    fs.writeFileSync(path.join(OUT_DIR, "range_tampered.json"), JSON.stringify(tamperedR));
    await page.getByTestId("batch-spec-file").setInputFiles(path.join(OUT_DIR, "range_tampered.json"));
    await waitText(page, "batch-error", /SHA-256 が一致しません/, 20_000);
    check((await rangeMin.inputValue()) === "-850.5" && (await shaOf()) === shaRange, "範囲を書き換えた定義は断られ、欄は変わらない（負例）");
    const reversed = JSON.parse(savedR.text) as { form: Record<string, unknown> };
    reversed.form.rangeMin = 400;
    reversed.form.rangeMax = 300;
    fs.writeFileSync(path.join(OUT_DIR, "range_reversed.json"), JSON.stringify(reversed));
    await page.getByTestId("batch-spec-file").setInputFiles(path.join(OUT_DIR, "range_reversed.json"));
    await waitText(page, "batch-error", /範囲外.*form\.range/, 20_000);
    check((await rangeMin.inputValue()) === "-850.5" && (await rangeMax.inputValue()) === "", "下限が上限より大きい定義は範囲外として断られ、欄は変わらない（負例）");

    console.log("  -- 10. 2D の単位・全断面（一括抽出の縦長の 1 表）");
    await reopen();
    await page.getByTestId("batch-preset").selectOption("six");
    await page.waitForTimeout(300);
    check(await page.getByTestId("batch-family-Shape2D").isDisabled() && !(await page.getByTestId("batch-family-Shape2D").isChecked()), "2D の単位が無いと Shape2D は選べない");
    check((await page.getByTestId("batch-planes").count()) === 0, "2D の単位が無いと断面の選択は出ない");
    await page.getByTestId("batch-unit-MAX_SECTION_2D").check();
    await page.getByTestId("batch-unit-SLICES_2D").check();
    await page.getByTestId("batch-planes-all").check();
    check(!(await page.getByTestId("batch-family-Shape2D").isDisabled()), "2D の単位を選ぶと Shape2D が選べる");
    await page.getByTestId("batch-family-Shape2D").check();
    check(/RowKey/.test(await page.getByTestId("batch-units-help").innerText()), "RowKey の使い方の説明が出る");
    const opts10 = await page.getByTestId("batch-preset").locator("option").allInnerTexts();
    check(opts10.some((t) => /^テクスチャ/.test(t)) && opts10.some((t) => /^すべての族/.test(t)), "プリセットにテクスチャとすべての族がある", opts10);
    const sha10 = await shaOf();
    await page.screenshot({ path: path.join(OUT_DIR, "16-units-form.png"), fullPage: true });
    await page.getByTestId("batch-run").click();
    await waitText(page, "batch-progress", /完了 — 5\/5 完了/, 900_000);
    const req10 = posted[posted.length - 1];
    check((req10.roiModes as string[]).join() === "WHOLE_3D,MAX_SECTION_2D,SLICES_2D" && req10.planes === "ALL", "送った要求: 3 単位・断面 ALL", [req10.roiModes, req10.planes]);
    await page.getByTestId("batch-prefix").fill("units2d");
    await page.getByTestId("batch-write").click();
    const dl10 = await takeDownloads(page, 6);
    for (const f of dl10) fs.writeFileSync(path.join(OUT_DIR, f.name), f.text);
    check(dl10.map((f) => f.name).sort().join() === ["units2d.csv", "units2d_definitions.csv", "units2d_radiomicsj.properties", "units2d_radiomicsj_2d.properties", "units2d_spec.json", "units2d_subjects_private.csv"].sort().join(), "6 ファイル（2D の設定ファイルが増える）", dl10.map((f) => f.name));
    const t10 = parseFeatures(dl10.find((f) => f.name === "units2d.csv")!.text);
    const c10 = (n: string) => t10.header.indexOf(n);
    check(["Unit", "PlaneSource", "Plane", "RowKey", "Roi_PlaneTiltDeg", "Roi_PositionMm", "Roi_AreaMm2", "Roi_Pixels"].every((n) => c10(n) > 0), "単位の列がある");
    const keys10 = t10.rows.map((r) => r[c10("RowKey")]);
    check(new Set(keys10).size === keys10.length, "RowKey は全行で一意", keys10.length);
    const spec10 = JSON.parse(dl10.find((f) => f.name === "units2d_spec.json")!.text) as { sha256: string; form: { units: string[]; planes: string } };
    check(spec10.sha256 === sha10 && spec10.form.units.join() === "MAX_SECTION_2D,SLICES_2D" && spec10.form.planes === "ALL" && t10.rows.every((r) => r[c10("Provenance_SpecSha256")] === sha10), "定義の units・planes・SHA-256 が画面・全行と一致");
    // 基準: 同じ組を API 直呼び（同じ設定・3 単位・全断面）で計算し、期待する行（単位・断面・位置・画素数・平均）を作る
    const MEAN10 = "IntensityBasedStatistical_Mean";
    interface Sec10 { positionMm: number; pixels: number; rows: Row[]; record: { plane?: string } }
    interface Sl10 { rows: { positionMm: number; pixels: number; rows: Row[] }[]; record: { plane?: string } }
    interface Res10 { rows: Row[]; section?: Sec10; slices?: Sl10; planeResults?: { plane: string; section?: Sec10 | null; slices?: Sl10 | null; error?: string | null }[] }
    const pairsDone = [...new Set(t10.rows.map((r) => `${r[c10("StudyInstanceUID")]}|${r[c10("MaskSeriesUID")]}|${r[c10("Roi_MaskChannel")]}`))];
    check(pairsDone.length === 5, "5 組", pairsDone.length);
    let rowsWant = 0;
    let rowsOk = 0;
    let meanDiff = 0;
    const planesCovered = new Set<string>();
    for (const key of pairsDone) {
      const [study, mask, ch] = key.split("|");
      const mine = t10.rows.filter((r) => r[c10("StudyInstanceUID")] === study && r[c10("MaskSeriesUID")] === mask && r[c10("Roi_MaskChannel")] === ch);
      const src = mine[0][c10("SourceSeriesUID")];
      const direct = (await apiFeatures(base, { studyInstanceUid: study, sourceSeriesUid: src, maskSeriesUid: mask, maskChannel: Number(ch), channel: 0, timePoint: 0,
        settings: req10.settings, valueSpec: req10.valueSpec, calibration: req10.calibration, recompute: true, roiModes: ["WHOLE_3D", "MAX_SECTION_2D", "SLICES_2D"], planes: "ALL" })) as unknown as Res10;
      const want: { unit: string; src: string; plane: string; pos: number; pixels: number; mean: number | null }[] = [
        { unit: "WHOLE_3D", src: "", plane: "", pos: NaN, pixels: NaN, mean: direct.rows.find((x) => x.column === MEAN10)?.value ?? null }];
      const addU = (source: string, sec?: Sec10 | null, sl?: Sl10 | null) => {
        if (sec) want.push({ unit: "MAX_SECTION_2D", src: source, plane: sec.record.plane ?? "", pos: sec.positionMm, pixels: sec.pixels, mean: sec.rows.find((x) => x.column === MEAN10)?.value ?? null });
        for (const r of sl?.rows ?? []) want.push({ unit: "SLICE_2D", src: source, plane: sl!.record.plane ?? "", pos: r.positionMm, pixels: r.pixels, mean: r.rows.find((x) => x.column === MEAN10)?.value ?? null });
      };
      addU("ACQUISITION", direct.section, direct.slices);
      for (const p of direct.planeResults ?? []) { addU("RESLICED", p.section, p.slices); if (p.section) planesCovered.add(p.plane); }
      rowsWant += want.length;
      const fmt = (u: string, s: string, pl: string, pos: number, px: number) => `${u}|${s}|${pl}|${Number.isNaN(pos) ? "" : pos.toFixed(4)}|${Number.isNaN(px) ? "" : px}`;
      const gotKeys = new Map(mine.map((r) => [fmt(r[c10("Unit")], r[c10("PlaneSource")], r[c10("Plane")], r[c10("Roi_PositionMm")] === "" ? NaN : Number(r[c10("Roi_PositionMm")]), r[c10("Roi_Pixels")] === "" ? NaN : Number(r[c10("Roi_Pixels")])), r]));
      for (const w of want) {
        const g = gotKeys.get(fmt(w.unit, w.src, w.plane, w.pos, w.pixels));
        if (g) {
          rowsOk++;
          const gv = g[c10(MEAN10)] === "" ? null : Number(g[c10(MEAN10)]);
          if (w.mean == null ? gv != null : gv == null || Math.abs(gv - w.mean) > 1e-9) meanDiff++;
        }
      }
      if (mine.length !== want.length) console.log(`  [info] ${key}: 行数 表 ${mine.length} / 基準 ${want.length}`);
    }
    check(rowsWant > 40 && rowsOk === rowsWant, "全 5 組の全行（単位・取得面/再スライス・断面・位置・画素数）が、API 直呼びの結果と一致", { rowsWant, rowsOk });
    check(meanDiff === 0, "全行の平均強度が API 直呼びと一致（2D の行は 2D の値、3D の行は 3D の値）", { meanDiff });
    check(t10.rows.length === rowsWant, "表の行数 = 基準の行数（余計な行・欠けた行が無い）", [t10.rows.length, rowsWant]);
    check(["AXIAL", "SAGITTAL", "CORONAL"].every((p) => planesCovered.has(p)), "再スライスした 3 断面が計算されている", [...planesCovered]);
    const sh2d = t10.rows.filter((r) => r[c10("Unit")] !== "WHOLE_3D" && c10("Shape2D_PixelSurface") > 0 && r[c10("Shape2D_PixelSurface")] !== "");
    check(c10("Shape2D_PixelSurface") > 0 && sh2d.length > 0 && t10.rows.filter((r) => r[c10("Unit")] === "WHOLE_3D").every((r) => r[c10("Shape2D_PixelSurface")] === ""), "Shape2D は 2D の行だけに値があり、3D の行は空欄");
    const defs10 = dl10.find((f) => f.name === "units2d_definitions.csv")!.text;
    check(/Shape2D_PixelSurface[^\n]*MAX_SECTION_2D;SLICE_2D/.test(defs10) && /IntensityBasedStatistical_Mean[^\n]*WHOLE_3D;MAX_SECTION_2D;SLICE_2D/.test(defs10), "定義表に、列ごとの計算した単位が付く");
    check(!dl10.some((f) => f.text.includes(PATIENT_NAME)), "どのファイルにも患者名が無い");

    console.log("  -- 11. 2D の小さい ROI の QC（基準値を定義に入れる）");
    // 合成 CT の箱（独立の予測値）: BigBox は各スライス 24×24=576 画素、SmallBox は 10×10=100 画素。基準値 150 画素なら SmallBox だけが小さい
    await reopen();
    await page.getByTestId("batch-preset").selectOption("six");
    await page.getByTestId("batch-unit-MAX_SECTION_2D").check();
    await page.getByTestId("batch-unit-SLICES_2D").check();
    // 3D の基準値は、前の節で環境設定に入れた 1000 ボクセルが残っていて 3D の旗が立つ。この節は 2D だけを見るので、画面の値で 1 ボクセルにして 3D を外す
    await page.getByTestId("batch-qc-voxels").fill("1");
    // 負例: 2D の基準値が未設定（画面の値も環境設定も無い）なら、止める指定でも止まらず、「判定していない」の注記が出る
    await radio("batch-qc-small", 1).check();
    await page.getByTestId("batch-run").click();
    await waitText(page, "batch-progress", /完了 — 5\/5 完了/, 900_000);
    check(!(await page.getByTestId("batch-qc-hold").isVisible().catch(() => false)), "2D の基準値が未設定なら、止める指定でも止まらない");
    check(await page.getByTestId("batch-unset-threshold-2d").isVisible().catch(() => false), "未設定のときは「2D の小さい ROI は判定していません」の注記が出る");
    // 基準値 150 画素を入れて「止める」
    await page.getByTestId("batch-qc-pixels").fill("150");
    await page.waitForTimeout(300);
    const sha11 = await shaOf();
    await page.getByTestId("batch-run").click();
    await page.getByTestId("batch-qc-hold").waitFor({ state: "visible", timeout: 600_000 });
    const holdA = await page.getByTestId("batch-qc-hold").innerText();
    check(/C002/.test(holdA) && /小さい ROI（2D）/.test(holdA) && /2D/.test(holdA), "最初の小さい組（C002）で、2D の旗で止まる", holdA);
    const progA = await page.getByTestId("batch-progress").innerText();
    check(/停止 — 2\/5 完了/.test(progA), "C001（BigBox）は通って、C002 で止まる（大きい 2D は旗なし）", progA);
    check(/小さい ROI（2D）/.test(await page.getByTestId("batch-flags-1").innerText()), "止めた組に 2D の旗が付く");
    await page.screenshot({ path: path.join(OUT_DIR, "17-qc-2d-hold.png"), fullPage: true });
    await page.getByTestId("batch-qc-continue").click();
    await waitText(page, "batch-progress", /停止 — 5\/5 完了/, 600_000);
    await page.getByTestId("batch-qc-continue").click();
    await waitText(page, "batch-progress", /完了 — 5\/5 完了/, 600_000);
    await page.getByTestId("batch-prefix").fill("qc2d");
    await page.getByTestId("batch-write").click();
    const dl11 = await takeDownloads(page, 6);
    const t11 = parseFeatures(dl11.find((f) => f.name === "qc2d.csv")!.text);
    const c11 = (n: string) => t11.header.indexOf(n);
    const flagsOf = (label: string) => t11.rows.filter((r) => r[c11("CaseLabel")] === label).map((r) => r[c11("Provenance_QcFlags")]);
    const bigLabels = ["C001", "C003", "C004"];
    check(flagsOf("C002").length > 1 && flagsOf("C002").every((f) => f.includes("SMALL_ROI_2D")) && flagsOf("C005").every((f) => f.includes("SMALL_ROI_2D")),
      "SmallBox の組（C002・C005）の全行に SMALL_ROI_2D が記録される（正例）", [flagsOf("C002")[0], flagsOf("C005")[0]]);
    check(bigLabels.every((l) => flagsOf(l).length > 1 && flagsOf(l).every((f) => !f.includes("SMALL_ROI_2D"))), "BigBox の組には SMALL_ROI_2D が付かない（負例）", bigLabels.map((l) => flagsOf(l)[0]));
    const spec11 = JSON.parse(dl11.find((f) => f.name === "qc2d_spec.json")!.text) as { sha256: string; qc: Record<string, unknown> };
    check(spec11.qc.smallRoiPixels === 150 && spec11.qc.smallRoiVoxels === 1 && spec11.sha256 === sha11, "定義に smallRoiPixels=150（と、3D を外すための smallRoiVoxels=1）が入り、SHA-256 が画面と一致", spec11.qc);
    // 定義の保存 → 開き直し → 読み込みで、基準値が復元される
    await page.getByTestId("batch-spec-save").click();
    const [saved11] = await takeDownloads(page, 1);
    fs.writeFileSync(path.join(OUT_DIR, "qc2d_spec.json"), saved11.text);
    await reopen();
    check((await page.getByTestId("batch-qc-pixels").inputValue()) === "" && (await page.getByTestId("batch-qc-voxels").inputValue()) === "", "開き直すと基準値は空に戻る");
    await page.getByTestId("batch-spec-file").setInputFiles(path.join(OUT_DIR, "qc2d_spec.json"));
    await waitText(page, "batch-info", /読み込みました/, 20_000);
    await page.waitForTimeout(400);
    check((await page.getByTestId("batch-qc-pixels").inputValue()) === "150" && (await shaOf()) === sha11, "定義を読み込むと 2D の基準値が復元され、SHA-256 が保存時と同じ");
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
