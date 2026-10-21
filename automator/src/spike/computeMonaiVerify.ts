/*
 * MONAI Bundle の 1 本ずつの検証（fw/monai-verification.md）。本物の Google Colab（GPU T4）で Bundle を走らせ、
 * 「SEG で保存」した DICOM SEG を取り出して、公開データの基準ラベルと採点する（automator/tools/monai_score.py）。
 *
 * 実行:  cd automator && npx tsx src/spike/computeMonaiVerify.ts <bundle> [--cases N|all] [--neg-input <nifti>]
 *   --cases N   検証症例の先頭 N 件だけ（既定 1。all = 全部）。Colab の枠を使うので、まず 1 で配線を確かめる
 *   --dicom     NIfTI を通さない DICOM シリーズ（ct-basic の PRE LIVER）でも走らせ、向きを解剖で確かめる（c）
 *
 * 🔴 前提: Colab にログイン済み。利用者の Colab の枠を使い、最後に解放する。
 * 🔴 検証データ（git に入れない）: ~/monai-verify-data/（置き場の決定は fw/monai-verification.md）。
 *    採点用の venv: ~/monai-verify-data/.venv（automator/tools/requirements.txt）。
 *
 * 数えるもの: 合格／失敗／未達／不明を分ける。閾値が無いので Dice は「不明」（verdict の lower=None）。合格と書かない。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Page } from "@playwright/test";

import { resetDb } from "../backend/dbReset.js";
import { DesktopDriver } from "../driver/desktopDriver.js";
import { importFixtureCategory } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT, categoryDir, getCategory } from "../fixtures/manifest.js";
import { PLUGIN_ID, installOfficialPlugin, openViewer, state } from "./computeMonaiShared.js";
import { consentWindow, createChecker, openAnalysisPlugin } from "./computeSpikeShared.js";

const DATA_ROOT = path.join(os.homedir(), "monai-verify-data");
const PY = path.join(DATA_ROOT, ".venv", "bin", "python");
const ORIENT_PY = path.join(AUTOMATOR_ROOT, "tools", "monai_orient.py");
const SCORE_PY = path.join(AUTOMATOR_ROOT, "tools", "monai_score.py");
const { check, summary } = createChecker();

interface BundleSpec {
  /** 画像と基準ラベルの置き場（imagesTr / labelsTr）。 */
  dataset: string;
  /** 検証症例（辞書順に並べた imagesTr の末尾 N 件など）を選ぶ。名前の配列を返す。 */
  cases(files: string[]): string[];
  /** SEG のセグメント名 → 基準ラベルの値。 */
  labelMap: Record<string, number>;
  /** 向き・位置（c）: 体の重心に対するラベルの期待の側（LPS、+1 = 大きい側）。 */
  orient?: { label: number; expect: string };
  /** 報告された指標（出典は fw/monai-verification/<bundle>.md）。比較は人が見る。 */
  reported: { metric: string; value: number; note: string };
  /** ラベル番号・点を渡すモデル。labels は画面のラベル選択で足す番号、points は --points のとき基準ラベルから選んだ点を入力欄へ入れる */
  prompt?: { labels: number[]; pointValue: number };
  /** 複数チャネル入力: チャネルごとに 1 シリーズ（同じ検査）として取り込み、タイルを開いて選ぶ。 */
  multi?: {
    /** Bundle のチャネル順。取り込むシリーズの説明にもなる */
    channels: string[];
    /** 症例の 4D 画像と基準を Bundle の形（チャネル別 NIfTI と振り直した基準）へ並べ替える */
    prep(caseFile: string, caseId: string, outDir: string): void;
    /** 領域（SEG 名の和）ごとの Dice。キー = 領域名、値 = SEG 名 */
    regions: Record<string, { seg: string[]; ref: number[] }>;
  };
}

const BRATS_PREP = path.join(AUTOMATOR_ROOT, "tools", "monai_brats_prep.py");
// SEG のセグメント名は計算機側の LABEL_NAMES（ui.js）に合わせる
const BRATS_CORE = "腫瘍コア（壊死・非造影。BraTS の 1）";
const BRATS_EDEMA = "浮腫（全腫瘍のうちコア以外。BraTS の 2）";
const BRATS_ET = "造影される腫瘍（BraTS の 4）";

const BUNDLES: Record<string, BundleSpec> = {
  spleen_ct_segmentation: {
    dataset: path.join(DATA_ROOT, "msd", "x", "Task09_Spleen"),
    // train.json の検証 = sorted(glob(imagesTr/*.nii.gz))[-9:]。辞書順（spleen_6 は spleen_60 の前）
    cases: (files) => [...files].sort().slice(-9),
    labelMap: { spleen: 1 },
    orient: { label: 1, expect: "x=+1,y=+1" }, // 脾臓: 患者の左（x 大）・体の重心より後ろ（y 大）
    reported: { metric: "mean Dice", value: 0.961, note: "検証 9 例の平均（学習中の検証に使用。独立性は限定的）" },
  },
  // vista3d: ラベル 3 = 脾臓（metadata の channel_def）。基準は MSD の脾臓（値 1）。学習データに MSD が入るので独立ではない（スパイク）
  vista3d: {
    dataset: path.join(DATA_ROOT, "msd", "x", "Task09_Spleen"),
    cases: (files) => [...files].sort().slice(-9),
    labelMap: { spleen: 1 },
    reported: { metric: "（スパイク）", value: NaN, note: "動作の確認だけ。報告値との比較は段 4" },
    prompt: { labels: [3], pointValue: 1 },
  },
  // DeepEdit: 陽性・陰性の点だけを渡す（ラベル番号は無い）
  spleen_deepedit_annotation: {
    dataset: path.join(DATA_ROOT, "msd", "x", "Task09_Spleen"),
    cases: (files) => [...files].sort().slice(-9),
    labelMap: { spleen: 1 },
    reported: { metric: "（スパイク）", value: NaN, note: "動作の確認だけ。Bundle の README は点の数による Dice 0.97 を報告（独立ではない）" },
    prompt: { labels: [], pointValue: 1 },
  },
  brats_mri_segmentation: {
    dataset: path.join(DATA_ROOT, "msd", "x", "Task01_BrainTumour_ex", "Task01_BrainTumour"),
    cases: (files) => [...files].sort(),
    labelMap: { [BRATS_CORE]: 1, [BRATS_EDEMA]: 2, [BRATS_ET]: 4 },
    reported: { metric: "mean Dice（TC / WT / ET）", value: 0.8518, note: "TC 0.8559・WT 0.9026・ET 0.7905。学習は BraTS 2018 で MSD Task01 と重なるため独立ではない" },
    multi: {
      channels: ["T1c", "T1", "T2", "FLAIR"],
      prep(caseFile, caseId, outDir) {
        const r = spawnSync(PY, ["-I", BRATS_PREP, "--image", caseFile, "--label", caseFile.replace("imagesTr", "labelsTr"), "--out-dir", outDir, "--case", caseId], { encoding: "utf8" });
        if (r.status !== 0) throw new Error(`症例の並べ替えに失敗: ${r.stderr || r.stdout}`);
      },
      regions: {
        WT: { seg: [BRATS_CORE, BRATS_EDEMA, BRATS_ET], ref: [1, 2, 4] },
        TC: { seg: [BRATS_CORE, BRATS_ET], ref: [1, 4] },
        ET: { seg: [BRATS_ET], ref: [4] },
      },
    },
  },
};

const POINT_PY = path.join(AUTOMATOR_ROOT, "tools", "monai_point_pick.py");

const numArg = (flag: string): string | undefined => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
/** 標本標準偏差（n−1）。n=1 のときは null。 */
function sd(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

function score(segPath: string, refPath: string, labelMap: Record<string, number>, outPath: string, regions?: Record<string, unknown>): Record<string, any> {
  const mapPath = `${outPath}.labelmap.json`;
  fs.writeFileSync(mapPath, JSON.stringify(labelMap));
  const extra: string[] = [];
  if (regions) {
    const regPath = `${outPath}.regions.json`;
    fs.writeFileSync(regPath, JSON.stringify(regions));
    extra.push("--regions", regPath);
  }
  const r = spawnSync(PY, ["-I", SCORE_PY, "--seg", segPath, "--reference", refPath, "--label-map", mapPath, "--out", outPath, ...extra], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`採点に失敗: ${r.stderr || r.stdout}`);
  return JSON.parse(fs.readFileSync(outPath, "utf8"));
}

async function main(): Promise<void> {
  const bundle = process.argv[2];
  const spec = BUNDLES[bundle ?? ""];
  if (!spec) throw new Error(`使い方: computeMonaiVerify.ts <bundle>（対応: ${Object.keys(BUNDLES).join(", ")}）`);
  const casesArg = numArg("--cases") ?? "1";
  const withDicom = process.argv.includes("--dicom");
  for (const p of [PY, SCORE_PY, ORIENT_PY]) if (!fs.existsSync(p)) throw new Error(`見つかりません: ${p}`);

  const imagesDir = path.join(spec.dataset, "imagesTr");
  const files = fs.readdirSync(imagesDir).filter((f) => f.endsWith(".nii.gz") && !f.startsWith("._"));
  let cases = spec.cases(files);
  if (casesArg !== "all") cases = cases.slice(0, Number(casesArg));
  console.log(`[${bundle}] 症例 ${cases.length} 件: ${cases.join(", ")}`);

  const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "compute-monai-verify", bundle);
  const runTag = ["--swap-channels:swap", "--points-swap-roles:roleswap", "--points:points", "--points-positive-only:posonly", "--no-labels:nolabel"].filter((f) => process.argv.includes(f.split(":")[0])).map((f) => f.split(":")[1]).join("-");
  const RES_DIR = path.join(DATA_ROOT, "results", runTag ? `${bundle}-${runTag}` : bundle);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(RES_DIR, { recursive: true });
  installOfficialPlugin();

  const driver = new DesktopDriver();
  let endpointsFile: string | null = null;
  let endpointsBackup: string | null = null;
  const endpointId = "colab-t4";
  const rows: Record<string, unknown>[] = [];
  try {
    await driver.start();
    const page = driver.page;
    page.on("dialog", (d) => void d.accept());
    await resetDb(driver.ports.http);
    if (withDicom) await importFixtureCategory(driver.ports.http, "ct-basic");
    const base = `http://localhost:${driver.ports.http}`;

    // 症例を NIfTI で取り込む（取り込みの向きの誤りは画像と基準が同じ誤りになり Dice に出ない。向きは DICOM の c で見る）
    const series: Record<string, { studyUid: string; seriesUid: string; ref?: string }> = {};
    for (const c of cases) {
      const id = c.replace(/\.nii\.gz$/, "");
      if (spec.multi) {
        // 4D → チャネル別の 3D（Bundle の順）。同じ検査（study）に 4 シリーズとして入れる
        const prepDir = path.join(RES_DIR, "prep");
        spec.multi.prep(path.join(imagesDir, c), id, prepDir);
        let studyUid: string | undefined;
        let first = "";
        for (const [k, ch] of spec.multi.channels.entries()) {
          const r = await fetch(`${base}/api/nifti/import`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: path.join(prepDir, `${id}_${ch}.nii.gz`), modality: "MR", patientId: `VERIFY-${id}`, patientName: `VERIFY^${id}`, seriesDescription: `${id}_${ch}`, seriesNumber: k + 1, ...(studyUid ? { studyInstanceUid: studyUid } : {}) }),
          });
          const j = (await r.json()) as { studyInstanceUid: string; seriesInstanceUid: string; error?: string };
          if (!r.ok || j.error) throw new Error(`NIfTI の取り込みに失敗: ${id}_${ch} ${JSON.stringify(j)}`);
          studyUid = j.studyInstanceUid;
          if (k === 0) first = j.seriesInstanceUid;
        }
        series[id] = { studyUid: studyUid!, seriesUid: first, ref: path.join(prepDir, `${id}_label.nii.gz`) };
        continue;
      }
      const r = await fetch(`${base}/api/nifti/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: path.join(imagesDir, c), modality: "CT", patientId: `VERIFY-${id}`, patientName: `VERIFY^${id}`, seriesDescription: id }),
      });
      const j = (await r.json()) as { studyInstanceUid: string; seriesInstanceUid: string; error?: string };
      if (!r.ok || j.error) throw new Error(`NIfTI の取り込みに失敗: ${c} ${JSON.stringify(j)}`);
      series[id] = { studyUid: j.studyInstanceUid, seriesUid: j.seriesInstanceUid };
    }
    if (withDicom) {
      // ct-basic は 1 シリーズ（SeriesDescription なし）。取り込まれたものの中から、フィクスチャの SeriesInstanceUID で特定する
      const ctUid = spawnSync(PY, ["-I", "-c", "import sys,glob,pydicom;print(pydicom.dcmread(sorted(glob.glob(sys.argv[1]+'/*.dcm'))[0],stop_before_pixels=True).SeriesInstanceUID)", categoryDir(getCategory("ct-basic"))], { encoding: "utf8" }).stdout.trim();
      const studies = (await (await fetch(`${base}/api/studies`)).json()) as { studyInstanceUid: string }[];
      for (const st of studies) {
        const ss = (await (await fetch(`${base}/api/studies/${st.studyInstanceUid}/series`)).json()) as { seriesInstanceUid: string }[];
        if (ss.some((x) => x.seriesInstanceUid === ctUid)) series["DICOM-ct-basic"] = { studyUid: st.studyInstanceUid, seriesUid: ctUid };
      }
      check(!!series["DICOM-ct-basic"], "DICOM シリーズ（ct-basic）が見つかる");
    }
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });

    const cwd = await driver.app.evaluate(({ dialog }) => {
      dialog.showMessageBoxSync = (() => 0) as typeof dialog.showMessageBoxSync;
      return process.cwd();
    });
    endpointsFile = path.join(cwd, "compute-endpoints.json");
    endpointsBackup = fs.existsSync(endpointsFile) ? fs.readFileSync(endpointsFile, "utf8") : null;
    if (endpointsBackup !== null) fs.rmSync(endpointsFile);

    // 未ログインなら、既定のブラウザで Google のログインを開いて待つ（ログインは利用者本人が行う。保存先は OS のキーチェーン）
    type ColabStatus = { signedIn?: boolean; ok?: boolean; error?: string };
    const colab = (fn: "computeColabStatus" | "computeColabSignIn"): Promise<ColabStatus> =>
      page.evaluate((f) => (window as unknown as { graphyDesktop: Record<string, () => Promise<ColabStatus>> }).graphyDesktop[f](), fn);
    const status = await colab("computeColabStatus");
    console.log(`Colab 状態: ${JSON.stringify(status)}`);
    if (!status.signedIn) {
      console.log("Google のログインを開きます。ブラウザで完了してください（最大 5 分）");
      const r = await colab("computeColabSignIn");
      if (!r.ok) throw new Error(`Google のログインに失敗: ${JSON.stringify(r)}`);
      console.log("ログイン完了");
    }

    let shotsTaken = 0; // 01 は最初の症例の実行前の 1 枚だけ
    for (const [id, s] of Object.entries(series)) {
      console.log(`\n[${bundle}] ${id}`);
      const v: Page = await openViewer(driver, page, s.studyUid, s.seriesUid);
      await v.getByTestId("monai-bundle").selectOption(bundle);
      if (spec.prompt) {
        const note = v.getByTestId("monai-prompt-note");
        if (!process.argv.includes("--no-labels")) {
          for (const l of spec.prompt.labels) {
            await v.getByTestId("monai-prompt-label").selectOption(String(l));
            await v.getByTestId("monai-prompt-add").click();
          }
        }
        if (process.argv.includes("--points")) {
          const r = spawnSync(PY, ["-I", POINT_PY, "--image", path.join(imagesDir, `${id}.nii.gz`), "--label", path.join(spec.dataset, "labelsTr", `${id}.nii.gz`), "--value", String(spec.prompt.pointValue)], { encoding: "utf8" });
          if (r.status !== 0) throw new Error(`点の選択に失敗: ${r.stderr || r.stdout}`);
          const only = process.argv.includes("--points-positive-only");
          // 負例（対照）: 役割を入れ替える。陽性が脾臓の外、陰性が脾臓の中になる
          const roleSwap = process.argv.includes("--points-swap-roles");
          const text = roleSwap ? r.stdout.replace(/positive/g, "TMP").replace(/negative/g, "positive").replace(/TMP/g, "negative") : r.stdout;
          await v.getByTestId("monai-points").fill(only ? text.split("\n").filter((l) => l.includes("positive")).join("\n") : text);
          console.log(`  点: ${r.stdout.trim().replace(/\n/g, " / ")}`);
        }
        console.log(`  入力の状態: ${await note.textContent()}`);
        await v.screenshot({ path: path.join(OUT_DIR, `01b-prompt-${runTag || "plain"}.png`) });
      }
      if (spec.multi) {
        // 残りのシリーズをタイルに足し、チャネルごとにシリーズを選ぶ
        for (let k = 1; k < spec.multi.channels.length; k++) {
          console.log(`  追加ボタン ${await v.locator("button[title='タイルに追加']").count()} 個`);
          await v.locator("button[title='タイルに追加']").first().click();
          await v.waitForTimeout(1500);
        }
        // 🔴 プラグインは開いた時点のタイル一覧を持つ（後から足したタイルは見えない）ので、閉じて開き直す
        await v.getByTestId("monai-bundle").waitFor({ state: "visible" });
        await v.locator("div", { has: v.getByTestId("monai-bundle") }).getByText("×", { exact: true }).last().click();
        await v.getByTestId("monai-bundle").waitFor({ state: "detached", timeout: 10_000 });
        await openAnalysisPlugin(v, PLUGIN_ID);
        await v.getByTestId("monai-bundle").selectOption(bundle);
        await v.waitForTimeout(2_000);
        const nOpt = await v.getByTestId("monai-channel-0").evaluate((sel) => (sel as HTMLSelectElement).options.length);
        check(nOpt === spec.multi.channels.length + 1, `${id}: チャネルの選択肢に 4 シリーズが出る`, nOpt);
        // 負例: --swap-channels はチャネル 0 と 1 のシリーズを入れ替えて渡す（順序の取り違えを採点が見分けられるかを見る）
        const swap = process.argv.includes("--swap-channels");
        for (const [k, ch0] of spec.multi.channels.entries()) {
          const ch = swap && k < 2 ? spec.multi.channels[1 - k] : ch0;
          const val = await v.getByTestId(`monai-channel-${k}`).evaluate((sel, re) => {
            const o = Array.from((sel as HTMLSelectElement).options).find((x) => x.value && new RegExp(re).test(x.textContent ?? ""));
            return o?.value ?? null;
          }, `_${ch}(?![A-Za-z0-9])`);
          if (!val) console.log("  ", await v.locator("#root, body").first().evaluate(() => Array.from(document.querySelectorAll("div")).map((d) => d.textContent ?? "").filter((t) => t.startsWith("シリーズは、同じ患者")).slice(0, 1).join()));
          if (!val) await v.screenshot({ path: path.join(OUT_DIR, "debug-tiles.png") });
          if (!val) throw new Error(`チャネル ${k}（${ch}）のタイルが見つかりません: ${JSON.stringify(await v.getByTestId(`monai-channel-${k}`).evaluate((sel) => Array.from((sel as HTMLSelectElement).options).map((o) => o.textContent)))}`);
          await v.getByTestId(`monai-channel-${k}`).selectOption(val);
        }
        check(await v.getByTestId("monai-run").isEnabled(), `${id}: 4 チャネルが揃うと実行できる`);
      }
      if (shotsTaken === 0) { await v.screenshot({ path: path.join(OUT_DIR, "01-before-run.png") }); shotsTaken++; }
      const t0 = Date.now();
      await v.getByTestId("monai-run").click();
      // 同意の窓が出る前にプラグインが止まったとき（計算機が未登録・未ログインなど）は、その理由をそのまま出す
      const w = await Promise.race([
        consentWindow(driver, 300_000),
        v.waitForFunction(() => {
          const s = (window as unknown as { __monaiState?: { phase: string; error?: string } }).__monaiState;
          return s?.error ? s : null;
        }, null, { timeout: 300_000 }).then(async (h) => { throw new Error(`同意の窓の前に止まりました: ${JSON.stringify(await h.jsonValue())}`); }),
      ]);
      await w.getByTestId("consent-ack").check();
      await w.getByTestId("consent-send").click();
      await v.waitForFunction(() => (window as unknown as { __monaiState?: { phase: string } }).__monaiState?.phase === "idle", null, { timeout: 3_600_000 });
      const st = await state(v);
      const sec = Math.round((Date.now() - t0) / 1000);
      const fg = Object.keys(st.summary?.labels ?? {}).filter((k) => k !== "0").length;
      const ok = !!st.summary && !st.error;
      check(ok, `${id}: 最後まで走る（${sec} 秒）`, st.error);
      if (!ok) {
        rows.push({ id, ok, error: st.error, traceback: st.traceback, stderr: String(st.stderr ?? "").slice(-6000) });
        console.log(`  traceback: ${String(st.traceback ?? "").slice(-2500)}\n  stderr: ${String(st.stderr ?? "").slice(-2500)}`);
        await v.close();
        continue;
      }
      check(/T4/.test(st.summary?.gpu?.name ?? ""), `${id}: GPU T4`, st.summary?.gpu);
      check(fg > 0, `${id}: 前景のあるラベルが返る（${fg}）`, st.summary?.labels);
      check(st.shown?.ok === true && st.shown.segmentCount === fg, `${id}: ROI マネージャに読み込まれる`, st.shown);
      if (id === Object.keys(series)[0]) await v.screenshot({ path: path.join(OUT_DIR, "02-result.png") });

      // 保存（SEG）→ 実ファイルを取り出す
      await v.getByTestId("monai-save").click();
      await v.getByTestId("plugin-save-confirm").waitFor({ state: "visible", timeout: 60_000 });
      await v.getByTestId("plugin-save-confirm-button").click();
      await v.waitForFunction(() => !!(window as unknown as { __monaiState?: { saved?: unknown } }).__monaiState?.saved, null, { timeout: 600_000 });
      const saved = (await state(v)).saved;
      check(saved?.ok === true, `${id}: SEG が保存される`, saved);
      if (id === Object.keys(series)[0]) await v.screenshot({ path: path.join(OUT_DIR, "03-after-save.png") });
      const row: Record<string, unknown> = { id, ok: true, seconds: sec, gpu: st.summary?.gpu, labels: fg, prompt: st.summary?.prompt };
      if (saved?.ok) {
        const insts = (await (await fetch(`${base}/api/studies/${s.studyUid}/series/${saved.seriesInstanceUid}/instances`)).json()) as { sopInstanceUid: string }[];
        check(insts.length === 1, `${id}: 保存した SEG のインスタンスが 1 つ`, insts.length);
        const bytes = Buffer.from(await (await fetch(`${base}/api/instances/${insts[0].sopInstanceUid}/file`)).arrayBuffer());
        check(bytes.length > 1000 && bytes.subarray(128, 132).toString("latin1") === "DICM", `${id}: SEG の実ファイルを取得（${bytes.length} B）`);
        const segPath = path.join(RES_DIR, `${id}.dcm`);
        fs.writeFileSync(segPath, bytes);
        row.seg = segPath;
        if (id === "DICOM-ct-basic" && spec.orient) {
          const outPath = path.join(RES_DIR, `${id}.orient.json`);
          const r = spawnSync(PY, ["-I", ORIENT_PY, "--seg", segPath, "--dicom-dir", categoryDir(getCategory("ct-basic")), "--label-value", String(spec.orient.label), "--expect", spec.orient.expect, "--out", outPath], { encoding: "utf8" });
          if (!fs.existsSync(outPath)) throw new Error(`向きの検査に失敗: ${r.stderr || r.stdout}`);
          const o = JSON.parse(fs.readFileSync(outPath, "utf8"));
          row.orient = o;
          for (const ax of Object.keys(spec.orient.expect.split(",").reduce((a, kv) => ({ ...a, [kv.split("=")[0]]: 1 }), {}))) {
            check(o[ax].ok, `${id}: c 向き ${ax} 軸が期待の側（${o[ax].expected_side}）にある（体の重心から ${o[ax].offset_mm} mm）`, o[ax]);
          }
        }
        if (id !== "DICOM-ct-basic") {
          const refPath = s.ref ?? path.join(spec.dataset, "labelsTr", `${id}.nii.gz`);
          const sc = score(segPath, refPath, spec.labelMap, path.join(RES_DIR, `${id}.score.json`), spec.multi?.regions);
          for (const [name, r] of Object.entries((sc.regions ?? {}) as Record<string, any>)) {
            check(r.dice !== null, `${id}: 領域 ${name} の Dice が出る（${r.dice}${r.reason ? `・${r.reason}` : ""}）`, r);
          }
          row.score = sc;
          for (const [name, r] of Object.entries(sc.labels as Record<string, any>)) {
            check(r.dice !== null, `${id}: ${name} の Dice が出る（${r.dice}${r.reason ? `・${r.reason}` : ""}）`, r);
          }
          const extra = sc.seg_names_not_in_map as string[];
          // 全自動（vista3d のラベル指定なし）は基準に無い臓器も返すのが仕様。件数だけ記録し、検査にしない
          if (spec.prompt && process.argv.includes("--no-labels")) console.log(`  基準に無いラベル ${extra.length} 個（全自動のため検査にしない）`);
          else check(extra.length === 0, `${id}: SEG に基準の表にない名前が無い`, extra);
        }
      }
      rows.push(row);
      await v.close();
    }

    // 症例別 Dice の分布（閾値は無いので「不明」。報告値と並べるだけ）
    for (const name of Object.keys(spec.labelMap)) {
      const ds = rows.map((r) => (r.score as any)?.labels?.[name]?.dice).filter((d): d is number => typeof d === "number");
      if (ds.length) {
        const m = mean(ds);
        console.log(`\n${name}: 症例 ${ds.length} 件 平均 ${m.toFixed(4)}  SD ${sd(ds)?.toFixed(4) ?? "n/a"}  最小 ${Math.min(...ds).toFixed(4)}  最大 ${Math.max(...ds).toFixed(4)}`);
        console.log(`  報告値（${spec.reported.metric}）: ${spec.reported.value}（${spec.reported.note}）  判定: 不明（閾値なし）`);
      }
    }
  } finally {
    fs.writeFileSync(path.join(OUT_DIR, "results.json"), JSON.stringify(rows, null, 2));
    await driver.page.evaluate((id) => (window as unknown as { graphyDesktop: any }).graphyDesktop.computeColabRelease(id), endpointId).catch(() => undefined);
    await driver.stop();
    if (endpointsFile) {
      if (endpointsBackup !== null) fs.writeFileSync(endpointsFile, endpointsBackup);
      else fs.rmSync(endpointsFile, { force: true });
    }
  }
  if (summary() > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
