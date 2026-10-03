/*
 * 段 6: MONAI Bundle のサンプルプラグイン（examples/remote-compute-monai）を本物の Google Colab（GPU T4）で通す。
 * 設計: fw/remote-compute-design.md §16。
 *
 * 実行:  cd automator && npx tsx src/spike/computeMonaiCheck.ts [bundle名]（既定 spleen_ct_segmentation）
 *
 * 🔴 前提: Colab にログイン済み（computeColabCheck を一度通してある）。利用者の Colab の枠を数分〜十数分使い、最後に解放する。
 *
 * 確かめること:
 *   1. 「実行」1 回・同意 1 回で、計算機の上でモデルの説明を読み、判定し、推論まで走る
 *   2. ラベル名・ライセンスが返る・CT に「使える」と判定される・GPU T4 で走る
 *   3. SEG（H22）で保存され、ラベル名どおりのセグメントが DB にある・脾臓が患者の左側にある（向きの確認）
 *   4. 監査ログ: 送信 1 回・実行 ok
 *   5. 窓を閉じると本体が「解放しますか」を聞き、「解放する」でランタイムが解放される（H61）
 */
import fs from "node:fs";
import path from "node:path";

import type { Page } from "@playwright/test";

import { resetDb } from "../backend/dbReset.js";
import { dismissStartupDialogs } from "../common/dismissDialogs.js";
import { DesktopDriver, DESKTOP_RUN_DATA_DIR } from "../driver/desktopDriver.js";
import { importFixtureCategory } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { approvedSha, consentWindow, createChecker } from "./computeSpikeShared.js";

const PLUGIN_ID = "remote-compute-monai";
const PLUGIN_SRC = path.join(AUTOMATOR_ROOT, "..", "examples", PLUGIN_ID);
const BUNDLE = process.argv[2] ?? "spleen_ct_segmentation";
const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "compute-monai-check");
const AUDIT = path.join(DESKTOP_RUN_DATA_DIR, "compute-audit.jsonl");
const { check, summary } = createChecker();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const state = (viewer: Page): Promise<any> => viewer.evaluate(() => (window as unknown as { __monaiState?: unknown }).__monaiState ?? null);

async function approve(driver: DesktopDriver, shot: string): Promise<Page> {
  const win = await consentWindow(driver, 300_000);
  await win.screenshot({ path: path.join(OUT_DIR, shot) });
  await win.getByTestId("consent-ack").check();
  await win.getByTestId("consent-send").click();
  return win;
}

async function waitPhaseIdle(viewer: Page, timeoutMs: number): Promise<void> {
  await viewer.waitForFunction(() => (window as unknown as { __monaiState?: { phase: string } }).__monaiState?.phase === "idle", null, { timeout: timeoutMs });
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const dst = path.join(DESKTOP_RUN_DATA_DIR, "plugins", PLUGIN_ID);
  fs.mkdirSync(dst, { recursive: true });
  for (const n of ["plugin.json", "ui.js"]) fs.copyFileSync(path.join(PLUGIN_SRC, n), path.join(dst, n));
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

    const cwd = await driver.app.evaluate(({ dialog }) => {
      dialog.showMessageBoxSync = (() => 0) as typeof dialog.showMessageBoxSync;
      return process.cwd();
    });
    endpointsFile = path.join(cwd, "compute-endpoints.json");
    endpointsBackup = fs.existsSync(endpointsFile) ? fs.readFileSync(endpointsFile, "utf8") : null;
    if (endpointsBackup !== null) fs.rmSync(endpointsFile);

    // --- 0. Colab の計算機（GPU T4）を足して確保する ---
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

    // --- 1. 2D ビューアで C-A-P を開き、プラグインを起動 ---
    console.log("\n[1] 2D ビューアでプラグインを起動");
    const base = `http://localhost:${driver.ports.http}`;
    const study = ((await (await fetch(`${base}/api/studies`)).json()) as { studyInstanceUid: string; patientId: string }[])[0];
    const series = (await (await fetch(`${base}/api/studies/${study.studyInstanceUid}/series`)).json()) as {
      seriesInstanceUid: string; modality: string; numberOfInstances: number; seriesDescription?: string;
    }[];
    // C-A-P は撮影 2 回ぶんが同じ位置で重なっていて npz にできない（npz-duplicate-positions）。間隔の揃った PRE LIVER を使う
    const cts = series.filter((s) => s.modality === "CT");
    const ct = cts.find((s) => /LIVER/i.test(s.seriesDescription ?? "")) ?? cts.sort((a, b) => b.numberOfInstances - a.numberOfInstances)[0];
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
    await viewer.getByTestId("viewer2d-menu-analysis").click();
    await viewer.getByTestId(`plugin-analysis-item-${PLUGIN_ID}`).click();
    await viewer.getByTestId("monai-bundle").waitFor({ state: "visible", timeout: 10_000 });
    await viewer.getByTestId("monai-bundle").selectOption(BUNDLE);

    // --- 2. 実行（1 回のクリック・同意 1 回。判定は計算機の上） ---
    console.log(`\n[2] 実行: ${BUNDLE}（Colab の T4）`);
    const t1 = Date.now();
    await viewer.getByTestId("monai-run").click();
    const w = await consentWindow(driver, 300_000);
    const sha = await approvedSha(w);
    check(sha.length === 64, "同意画面は 1 回だけ・npz 1 件と SHA-256", sha);
    await approve(driver, "1-consent.png");
    await waitPhaseIdle(viewer, 3_600_000);
    let s = await state(viewer);
    const sec = Math.round((Date.now() - t1) / 1000);
    check(!!s.summary && !s.error, `最後まで走る（${sec} 秒）`, s.error);
    if (!s.summary) {
      // Jupyter の traceback は ANSI の色付き
      const tb = (s.traceback ?? []).join("\n").replace(/\u001b\[[0-9;]*m/g, "");
      fs.writeFileSync(path.join(OUT_DIR, "run-error.txt"), `${s.error}\n\n${tb}\n\nstderr:\n${s.stderr ?? ""}`);
      console.log(tb.split("\n").slice(-40).join("\n"));
      throw new Error("実行に失敗したので中断します");
    }
    const labels = s.verdict?.labels ?? [];
    console.log(`    ラベル ${labels.length} 個: ${labels.slice(0, 8).map((l: { name: string }) => l.name).join(", ")}`);
    check(labels.length > 0 && s.verdict?.ok === true, "モデルの説明（ラベル名）が返り、CT に使えると判定される", s.verdict);
    check(typeof s.bundle?.license === "string" && s.bundle.license.length > 0, "ライセンスが返る");
    console.log(`    ${JSON.stringify({ stages: s.summary?.stages, gpu: s.summary?.gpu, labels: Object.keys(s.summary?.labels ?? {}).length, resampled: s.summary?.resampled })}`);
    check(/T4/.test(s.summary?.gpu?.name ?? ""), "GPU T4 で走った", s.summary?.gpu);
    check(s.shown?.ok === true && s.shown.segmentCount === Object.keys(s.summary?.labels ?? {}).filter((k) => k !== "0").length,
      "H63: 結果がそのまま ROI マネージャに読み込まれる（ラベルの数が一致）", s.shown);
    const fg = Object.entries(s.summary?.labels ?? {}).filter(([k]) => k !== "0").reduce((a, [, c]) => a + Number(c), 0);
    check(fg > 100, "前景のラベルが返る", s.summary?.labels);
    check(await viewer.getByTestId("monai-preview").isVisible(), "下見の画像が出る");
    await viewer.screenshot({ path: path.join(OUT_DIR, "4-result.png") });

    // --- 4. SEG で保存 ---
    console.log("\n[4] SEG で保存");
    await viewer.getByTestId("monai-save").click();
    await viewer.getByTestId("plugin-save-confirm").waitFor({ state: "visible", timeout: 60_000 });
    await viewer.getByTestId("plugin-save-confirm-button").click();
    await viewer.waitForFunction(() => !!(window as unknown as { __monaiState?: { saved?: unknown } }).__monaiState?.saved, null, { timeout: 300_000 });
    s = await state(viewer);
    check(s.saved?.ok === true, "SEG が保存される", s.saved);
    const segUid = s.saved?.seriesInstanceUid as string;
    const seg = (await (await fetch(`${base}/api/dicom/seg?study=${study.studyInstanceUid}&series=${segUid}`)).json()) as {
      rows: number; columns: number; segments: { label: string; frames: { mask: string; imagePositionPatient: number[] | null }[] }[];
    };
    const names = seg.segments.map((x) => x.label);
    check(names.length > 0 && names.every((n) => labels.some((l: { name: string }) => l.name === n)), "DB の SEG のセグメント名が Bundle のラベル名", names);
    // 向き: 脾臓は患者の左（LPS の +x）。画像の列は +x へ進む（標準の axial）ので、重心の列は中央より右に来る
    if (BUNDLE.includes("spleen")) {
      let sum = 0, n = 0;
      for (const f of seg.segments[0].frames) {
        const b = Buffer.from(f.mask, "base64");
        for (let i = 0; i < b.length; i++) if (b[i]) { sum += i % seg.columns; n++; }
      }
      const col = sum / Math.max(n, 1);
      check(n > 0 && col > seg.columns / 2, "🔴 脾臓が患者の左側にある（左右の取り違えが無い）", { centroidColumn: Math.round(col), columns: seg.columns, voxels: n });
    }

    // --- 5. 監査 ---
    console.log("\n[5] 監査");
    const events = fs.readFileSync(AUDIT, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const fin = events.filter((e: { event: string }) => e.event === "compute-finished");
    check(fin.length === 1 && fin[0].outcome === "ok", "監査: 実行が ok", fin);
    const consumed = events.filter((e: { event: string }) => e.event === "egress-consumed");
    check(consumed.length === 1 && consumed[0]?.datasets?.length === 1, "監査: 送信は 1 回（npz 1 件）", consumed.map((e: { datasets: unknown[] }) => e.datasets.length));
    // --- 6. 窓を閉じると、本体が「解放しますか」を聞く（H61） ---
    console.log("\n[6] 閉じて解放");
    const runtimeOf = () => viewer.evaluate(async (id) => {
      const c = await (window as unknown as { graphyDesktop: any }).graphyDesktop.computeEndpointsGet();
      return c.endpoints.find((e: { id: string }) => e.id === id)?.runtime;
    }, endpointId);
    check((await runtimeOf())?.allocated === true, "閉じる前はランタイムを確保している");
    await viewer.locator(".graphy-plugin-window__close").click();
    await viewer.getByTestId("compute-release-confirm").waitFor({ state: "visible", timeout: 30_000 });
    const msg = ((await viewer.getByTestId("compute-release-confirm").textContent()) ?? "").replace(/\s+/g, " ");
    check(/T4/.test(msg) && /解放/.test(msg), "本体の確認に「T4 ランタイムを解放しますか」と出る", msg);
    await viewer.screenshot({ path: path.join(OUT_DIR, "5-release-confirm.png") });
    await viewer.getByTestId("compute-release-ok").click();
    await viewer.waitForFunction(() => !!(window as unknown as { __monaiState?: { release?: unknown } }).__monaiState?.release, null, { timeout: 120_000 });
    s = await state(viewer);
    check(s.release?.ok === true && s.release?.released === true, "「解放する」で解放される", s.release);
    check((await runtimeOf())?.allocated === false, "解放後は未確保", await runtimeOf());

    fs.writeFileSync(path.join(OUT_DIR, "state.json"), JSON.stringify({ bundle: s.bundle?.name, verdict: s.verdict, summary: s.summary, saved: s.saved }, null, 2));
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
