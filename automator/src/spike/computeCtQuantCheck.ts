/*
 * CT 臓器体積・体組成（公式プラグイン vis-ct-quant）を本物の Google Colab（GPU T4）で通す。
 * 設計: fw/ct-quant-design.md（Q3）。
 *
 * 実行:  cd automator && npx tsx src/spike/computeCtQuantCheck.ts
 *
 * 🔴 前提: Colab にログイン済み（computeColabCheck を一度通してある）。利用者の Colab の枠を十数分使い、最後に解放する。
 *
 * 確かめること:
 *   1. 「解析 ＞ AI」から開き、「実行」1 回・同意 1 回で TotalSegmentator（total）が T4 で最後まで走る
 *   2. H66 のボクセル数が、計算機が数えたラベルごとの数と一致する（経路で画素が欠けない・ずれない）
 *   3. 体積 = ボクセル数 × ボクセル体積（本体の格子から）、肝は患者の右・脾は左（左右の取り違えが無い）
 *   4. ROI マネージャに全構造が読み込まれる（H65）
 *   5. SEG・SR・CSV が保存される。SR に面積・平均値が入る
 *   6. 監査（送信 1 回・ok）、窓を閉じると解放を聞かれる
 */
import fs from "node:fs";
import path from "node:path";

import type { Page } from "@playwright/test";

import { resetDb } from "../backend/dbReset.js";
import { dismissStartupDialogs } from "../common/dismissDialogs.js";
import { DesktopDriver, DESKTOP_RUN_DATA_DIR } from "../driver/desktopDriver.js";
import { importFixtureCategory } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { approvedSha, consentWindow, createChecker, openAnalysisPlugin } from "./computeSpikeShared.js";

const PLUGIN_ID = "vis-ct-quant";
const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "compute-ct-quant-check");
const AUDIT = path.join(DESKTOP_RUN_DATA_DIR, "compute-audit.jsonl");
const { check, summary } = createChecker();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const state = (viewer: Page): Promise<any> => viewer.evaluate(() => {
  // 大きい配列（ラベル・ボリューム）は返さない
  const s = (window as unknown as { __ctQuantState?: Record<string, unknown> }).__ctQuantState;
  if (!s) return null;
  const { labels: _l, ...rest } = s;
  return JSON.parse(JSON.stringify(rest, (_k, v) => (ArrayBuffer.isView(v) ? `[${(v as unknown as ArrayLike<number>).length}]` : v)));
});

async function waitPhaseIdle(viewer: Page, timeoutMs: number): Promise<void> {
  await viewer.waitForFunction(() => (window as unknown as { __ctQuantState?: { phase: string } }).__ctQuantState?.phase === "idle", null, { timeout: timeoutMs });
}

/** 公式プラグインの作業コピーを検証用の置き場へ入れる（engines は開発版でも読めるように外す）。 */
function installOfficialPlugin(): void {
  const src = process.env.GRAPHY_CT_QUANT_PLUGIN_DIR ?? path.join(AUTOMATOR_ROOT, "..", "..", "graphy-workspace", "graphy-next-plugin-ct-quant");
  if (!fs.existsSync(path.join(src, "ui.js"))) throw new Error(`公式プラグインの作業コピーがありません: ${src}（GRAPHY_CT_QUANT_PLUGIN_DIR で指定）`);
  const dst = path.join(DESKTOP_RUN_DATA_DIR, "plugins", PLUGIN_ID);
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(dst, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(src, "plugin.json"), "utf8"));
  manifest.engines = { ...manifest.engines, graphy: ">=0.0.0" };
  fs.writeFileSync(path.join(dst, "plugin.json"), JSON.stringify(manifest, null, 2));
  fs.copyFileSync(path.join(src, "ui.js"), path.join(dst, "ui.js"));
}

async function confirmSave(viewer: Page): Promise<void> {
  await viewer.getByTestId("plugin-save-confirm").waitFor({ state: "visible", timeout: 60_000 });
  await viewer.getByTestId("plugin-save-confirm-button").click();
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  installOfficialPlugin();
  fs.rmSync(AUDIT, { force: true });

  const driver = new DesktopDriver();
  let endpointsFile: string | null = null;
  let endpointsBackup: string | null = null;
  const endpointId = "colab-t4";
  try {
    await driver.start();
    const page = driver.page;
    page.on("dialog", (d) => void d.accept());
    await resetDb(driver.ports.http);
    await importFixtureCategory(driver.ports.http, "ct-basic");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });

    const cwd = await driver.app.evaluate(({ dialog }, dir) => {
      dialog.showMessageBoxSync = (() => 0) as typeof dialog.showMessageBoxSync;
      // CSV の保存ダイアログは自動では押せないので差し替える（保存先は OUT_DIR）
      (dialog as unknown as { showSaveDialog: unknown }).showSaveDialog = async (_w: unknown, o: { defaultPath?: string }) => ({
        canceled: false,
        filePath: `${dir}\\${(o?.defaultPath ?? "out.bin").replace(/[\\/]/g, "_")}`,
      });
      return process.cwd();
    }, OUT_DIR);
    endpointsFile = path.join(cwd, "compute-endpoints.json");
    endpointsBackup = fs.existsSync(endpointsFile) ? fs.readFileSync(endpointsFile, "utf8") : null;
    if (endpointsBackup !== null) fs.rmSync(endpointsFile);

    // --- 0. Colab の計算機（GPU T4）を足す ---
    console.log("\n[0] Colab の GPU T4 を用意");
    await page.getByTestId("mainscreen-menu-system").click();
    await page.getByTestId("menu-item-settings").click();
    await page.getByTestId("settings-cat-compute").click();
    await page.getByTestId("compute-colab").waitFor({ state: "visible", timeout: 10_000 });
    if ((await page.getByTestId("compute-colab-account").count()) === 0) {
      console.log("    → ブラウザが開きます。テストユーザーの Google アカウントでログインしてください（5 分待ちます）");
      await page.getByTestId("compute-colab-signin").click();
      await page.getByTestId("compute-colab-account").waitFor({ state: "visible", timeout: 300_000 });
    }
    await page.getByTestId("compute-colab-spec").selectOption("VARIANT_GPU/T4/SHAPE_STANDARD");
    await page.getByTestId("compute-colab-add").click();
    await page.getByTestId(`compute-endpoint-${endpointId}`).waitFor({ state: "visible", timeout: 10_000 });
    await page.getByTestId("dialog-close-button").click();

    // --- 1. 2D ビューアで PRE LIVER を開き、「解析 ＞ AI」から起動 ---
    console.log("\n[1] 2D ビューアでプラグインを起動");
    const base = `http://localhost:${driver.ports.http}`;
    const study = ((await (await fetch(`${base}/api/studies`)).json()) as { studyInstanceUid: string }[])[0];
    const series = (await (await fetch(`${base}/api/studies/${study.studyInstanceUid}/series`)).json()) as {
      seriesInstanceUid: string; modality: string; numberOfInstances: number; seriesDescription?: string;
    }[];
    // C-A-P は撮影 2 回ぶんが同じ位置で重なっていて npz にできない（npz-duplicate-positions）
    const ct = series.find((s) => s.modality === "CT" && /LIVER/i.test(s.seriesDescription ?? ""))!;
    console.log(`    シリーズ: ${ct.seriesDescription ?? ""}（${ct.numberOfInstances} 枚）`);
    await dismissStartupDialogs(page);
    const dates = page.locator('input[type="date"]');
    await dates.nth(0).fill("");
    await dates.nth(1).fill("");
    await page.getByTestId("search-submit-button").click();
    await page.locator(`[data-testid="study-row-${study.studyInstanceUid}"]`).click();
    await page.locator(`[data-testid="series-row-${ct.seriesInstanceUid}"]`).click();
    const viewer = await driver.waitForNewPage(
      () => page.getByTestId("viewer2d-toolbar-button").click(),
      (url) => url.includes("2dviewer"),
    );
    await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 30_000 });
    await viewer.waitForTimeout(3_000);
    await openAnalysisPlugin(viewer, PLUGIN_ID);
    await viewer.getByTestId("ctq-run").waitFor({ state: "visible", timeout: 10_000 });

    // --- 2. 実行 ---
    console.log("\n[2] 実行（Colab の T4）");
    const t1 = Date.now();
    await viewer.getByTestId("ctq-run").click();
    const w = await consentWindow(driver, 300_000);
    const sha = await approvedSha(w);
    check(sha.length === 64, "同意画面は 1 回だけ・npz 1 件と SHA-256", sha);
    await w.screenshot({ path: path.join(OUT_DIR, "1-consent.png") });
    await w.getByTestId("consent-ack").check();
    await w.getByTestId("consent-send").click();
    await waitPhaseIdle(viewer, 3_600_000);
    let s = await state(viewer);
    const sec = Math.round((Date.now() - t1) / 1000);
    check(!!s.summary && !s.error, `最後まで走る（${sec} 秒）`, s.error);
    if (!s.summary) {
      const tb = (s.traceback ?? []).join("\n").replace(/\u001b\[[0-9;]*m/g, "");
      fs.writeFileSync(path.join(OUT_DIR, "run-error.txt"), `${s.error}\n\n${tb}\n\nstderr:\n${s.stderr ?? ""}`);
      console.log(tb.split("\n").slice(-40).join("\n"));
      throw new Error("実行に失敗したので中断します");
    }
    console.log(`    ${JSON.stringify({ version: s.summary.version, stages: s.summary.stages, gpu: s.summary.gpu, resampled: s.summary.resampled })}`);
    check(/T4/.test(s.summary.gpu?.name ?? ""), "GPU T4 で走った", s.summary.gpu);
    check(s.summary.version === "2.18.0", "TotalSegmentator は固定した版（2.18.0）", s.summary.version);
    check(Object.keys(s.summary.classMap ?? {}).length === 117, "class map が 117 構造", Object.keys(s.summary.classMap ?? {}).length);

    // --- 3. H66 の数値の整合 ---
    console.log("\n[3] H66 の数値");
    const counted = Object.entries(s.summary.labels as Record<string, number>).filter(([k]) => k !== "0");
    const byLabel = new Map<number, { voxelCount: number; volumeMl: number; centroidLps: number[]; stats: { mean: number } | null }>(
      (s.measurements as { label: number; voxelCount: number; volumeMl: number; centroidLps: number[]; stats: { mean: number } | null }[]).map((m) => [m.label, m]));
    const mismatch = counted.filter(([k, c]) => byLabel.get(Number(k))?.voxelCount !== c);
    check(counted.length > 0 && byLabel.size === counted.length && mismatch.length === 0,
      `H66 のボクセル数が計算機の数え上げと一致（${counted.length} 構造）`, mismatch.slice(0, 5));
    const voxelMl = await viewer.evaluate(async ({ studyUid, seriesUid }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const st = (window as any).__ctQuantState;
      const v = st.labels.vol;
      return { studyUid, seriesUid, spacing: v.spacing as number[] };
    }, { studyUid: study.studyInstanceUid, seriesUid: ct.seriesInstanceUid });
    const perVoxelMl = voxelMl.spacing[0] * voxelMl.spacing[1] * voxelMl.spacing[2] / 1000;
    const volErr = [...byLabel.values()].map((m) => Math.abs(m.volumeMl - m.voxelCount * perVoxelMl) / Math.max(m.volumeMl, 1e-9));
    check(Math.max(...volErr) < 1e-6, "体積 = ボクセル数 × 間隔の積（本体の格子から）", { spacing: voxelMl.spacing, maxRelErr: Math.max(...volErr) });
    const ids = new Map(Object.entries(s.summary.classMap as Record<string, string>).map(([k, v]) => [v, Number(k)]));
    const liver = byLabel.get(ids.get("liver")!);
    const spleen = byLabel.get(ids.get("spleen")!);
    check(!!liver && !!spleen && liver.centroidLps[0] < spleen.centroidLps[0],
      "🔴 肝は患者の右・脾は左（LPS の x：肝 < 脾）", { liver: liver?.centroidLps, spleen: spleen?.centroidLps });
    console.log(`    肝 ${liver?.volumeMl.toFixed(0)} mL・${liver?.stats?.mean.toFixed(1)} HU／脾 ${spleen?.volumeMl.toFixed(0)} mL・${spleen?.stats?.mean.toFixed(1)} HU／L3: ${JSON.stringify(s.l3)}`);
    check(s.shown?.ok === true && s.shown.segmentCount === counted.length, "H65: 全構造が ROI マネージャに読み込まれる", s.shown);
    // 椎骨ラベルのスライスごとの画素数（L3 の判定を見直すための記録）
    // tsx は名前付きの関数に __name を差し込むので、ブラウザ側では名前付きの関数を作らない
    const perSlice = await viewer.evaluate((names: string[]) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const st = (window as any).__ctQuantState;
      const { data, vol } = st.labels;
      const [nx, ny, nz] = vol.dims;
      const ids: Record<string, number> = {};
      for (const [k, v] of Object.entries(st.classMap)) ids[v as string] = Number(k);
      const out: Record<string, number[]> = {};
      const kRange: Array<[string, number[]]> = [];
      for (const n of names) {
        const counts = new Array(nz).fill(0);
        for (let k = 0; k < nz; k++) for (let p = 0; p < nx * ny; p++) if (data[k * nx * ny + p] === ids[n]) counts[k]++;
        out[n] = counts;
        for (const m of st.measurements) if (m.label === ids[n]) kRange.push([n, m.kRange]);
      }
      return { nz, out, kRange };
    }, ["vertebrae_L2", "vertebrae_L3", "vertebrae_L4", "vertebrae_L5"]);
    fs.writeFileSync(path.join(OUT_DIR, "vertebrae-per-slice.json"), JSON.stringify(perSlice, null, 1));

    // PRE LIVER は L2〜L5 が写っている（L3 の下関節突起が端の 2 枚に出る＝2026-10-05 に判定を直した例）
    check(s.l3?.ok === true, "L3: L2・L4 が写っているので測れる（端に関節突起が出ていても弾かない）", s.l3);
    if (s.l3?.ok) {
      await viewer.getByTestId("ctq-tab-l3").click();
      await viewer.getByTestId("ctq-height").fill("170");
      await viewer.waitForTimeout(300);
      s = await state(viewer);
      const psoas = s.l3Rows?.[0];
      check(psoas?.areaCm2 > 0 && Number.isFinite(psoas?.meanHu), "L3: 大腰筋の面積と平均 CT 値が出る", psoas);
      check(Math.abs(psoas.indexCm2PerM2 - psoas.areaCm2 / 1.7 ** 2) < 1e-9, "L3: 身長 170 cm で 面積 ÷ 身長² になる", psoas);
      check(psoas.muscleRangeAreaCm2 <= psoas.areaCm2 + 1e-9, "L3: 筋の CT 値の範囲の面積は全体の面積以下", psoas);
      check(await viewer.getByTestId("ctq-l3-preview").isVisible(), "L3: 重ね表示の画像が出る");
      console.log(`    L3 k=${s.l3.k}: ${JSON.stringify(s.l3Rows)}`);
    }
    for (const tab of ["organs", "liver", "l3"]) {
      await viewer.getByTestId(`ctq-tab-${tab}`).click();
      await viewer.waitForTimeout(300);
      await viewer.screenshot({ path: path.join(OUT_DIR, `2-tab-${tab}.png`) });
    }

    // --- 4. 保存 ---
    console.log("\n[4] 保存（SEG・SR・CSV）");
    await viewer.getByTestId("ctq-save-seg").click();
    await confirmSave(viewer);
    await viewer.waitForFunction(() => !!(window as unknown as { __ctQuantState?: { savedSeg?: unknown } }).__ctQuantState?.savedSeg, null, { timeout: 600_000 });
    await viewer.getByTestId("ctq-save-sr").click();
    await confirmSave(viewer);
    await viewer.waitForFunction(() => !!(window as unknown as { __ctQuantState?: { savedSr?: unknown } }).__ctQuantState?.savedSr, null, { timeout: 120_000 });
    await viewer.getByTestId("ctq-save-csv").click();
    await viewer.waitForFunction(() => !!(window as unknown as { __ctQuantState?: { savedCsv?: unknown } }).__ctQuantState?.savedCsv, null, { timeout: 60_000 });
    s = await state(viewer);
    check(s.savedSeg?.ok === true, "SEG が保存される", s.savedSeg);
    check(s.savedSr?.ok === true, "SR が保存される", s.savedSr);
    check(s.savedCsv?.ok === true && fs.existsSync(s.savedCsv.filePath), "CSV が保存される", s.savedCsv);
    if (s.savedSeg?.ok) {
      const seg = (await (await fetch(`${base}/api/dicom/seg?study=${study.studyInstanceUid}&series=${s.savedSeg.seriesInstanceUid}`)).json()) as { segments: { label: string }[] };
      check(seg.segments.length === counted.length && seg.segments.some((x) => x.label === "liver"), "DB の SEG に全構造が名前つきで入る", seg.segments.length);
    }
    if (s.savedSr?.ok) {
      const bytes = Buffer.from(await (await fetch(`${base}/api/instances/${s.savedSr.sopInstanceUid}/file`)).arrayBuffer()).toString("latin1");
      check(/MEAN_VALUE/.test(bytes) && /\[hnsf'U\]/.test(bytes) && /VOLUME/.test(bytes) && (!s.l3?.ok || /AREA/.test(bytes)),
        "SR に体積・平均 CT 値（[hnsf'U]）・L3 の面積が入る", { len: bytes.length });
    }
    if (s.savedCsv?.ok) {
      const csv = fs.readFileSync(s.savedCsv.filePath, "utf8");
      check(csv.charCodeAt(0) === 0xfeff && /TotalSegmentator 2\.18\.0/.test(csv) && /"肝臓"/.test(csv), "CSV に版と肝臓の行がある");
    }

    // --- 5. 監査 ---
    console.log("\n[5] 監査");
    const events = fs.readFileSync(AUDIT, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const fin = events.filter((e: { event: string }) => e.event === "compute-finished");
    check(fin.length === 1 && fin[0].outcome === "ok", "監査: 実行が ok", fin);
    const consumed = events.filter((e: { event: string }) => e.event === "egress-consumed");
    check(consumed.length === 1 && consumed[0]?.datasets?.length === 1, "監査: 送信は 1 回（npz 1 件）", consumed.length);

    // --- 6. 閉じると解放を聞かれる（H61） ---
    console.log("\n[6] 閉じて解放");
    await viewer.locator(".graphy-plugin-window__close").click();
    await viewer.getByTestId("compute-release-confirm").waitFor({ state: "visible", timeout: 30_000 });
    await viewer.getByTestId("compute-release-ok").click();
    await viewer.waitForFunction(() => !!(window as unknown as { __ctQuantState?: { release?: unknown } }).__ctQuantState?.release, null, { timeout: 120_000 });
    s = await state(viewer);
    check(s.release?.ok === true && s.release?.released === true, "「解放する」で解放される", s.release);

    fs.writeFileSync(path.join(OUT_DIR, "state.json"), JSON.stringify({ summary: s.summary, organs: s.organs, ls: s.ls, l3: s.l3, l3Rows: s.l3Rows }, null, 2));
  } finally {
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
