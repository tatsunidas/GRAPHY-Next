/*
 * CT 肺結節（公式プラグイン vis-lung-nodule）を本物の Google Colab（GPU T4）で通す。設計: fw/lung-nodule-design.md（N2）。
 *
 * 準備:  LIDC-IDRI-0001（TCIA・CC BY 3.0）の CT と読影医の SEG 1 つを .results/lidc-0001/{ct,seg} に置く
 *        （NBIA の getImage?SeriesInstanceUID=…。手順は fw/lung-nodule-design.md §5）
 * 実行:  cd automator && npx tsx src/spike/computeLungNoduleCheck.ts
 *
 * ⚠ LIDC-IDRI は lung_nodules の学習に一部使われている。ここで確かめるのは動作と経路で、精度ではない。
 *
 * 確かめること:
 *   1. 「解析 ＞ AI」から開き、実行 1 回・同意 1 回で T4 で最後まで走る
 *   2. 計算機が数えた成分ごとのボクセル数と H66 の数が一致（経路で画素が欠けない・ずれない）
 *   3. 読影医の結節（SEG）の重心から、その等価半径以内に重心のある候補がある（向き・位置の取り違えが無い）
 *   4. 一覧の 1 行目を押すと、その結節の重心のスライスに移動する
 *   5. SEG・SR・CSV、監査、解放
 */
import fs from "node:fs";
import path from "node:path";

import type { Page } from "@playwright/test";

import { resetDb } from "../backend/dbReset.js";
import { dismissStartupDialogs } from "../common/dismissDialogs.js";
import { DesktopDriver, DESKTOP_RUN_DATA_DIR } from "../driver/desktopDriver.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { approvedSha, consentWindow, createChecker, openAnalysisPlugin } from "./computeSpikeShared.js";

const PLUGIN_ID = "vis-lung-nodule";
const DATA_DIR = path.join(AUTOMATOR_ROOT, ".results", "lidc-0001");
const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "compute-lung-nodule-check");
const AUDIT = path.join(DESKTOP_RUN_DATA_DIR, "compute-audit.jsonl");
const { check, summary } = createChecker();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const state = (viewer: Page): Promise<any> => viewer.evaluate(() => {
  const s = (window as unknown as { __lungNoduleState?: Record<string, unknown> }).__lungNoduleState;
  if (!s) return null;
  const { labels: _l, ...rest } = s;
  return JSON.parse(JSON.stringify(rest, (_k, v) => (ArrayBuffer.isView(v) ? `[${(v as unknown as ArrayLike<number>).length}]` : v)));
});

function installOfficialPlugin(): void {
  const src = process.env.GRAPHY_LUNG_NODULE_PLUGIN_DIR ?? path.join(AUTOMATOR_ROOT, "..", "..", "graphy-workspace", "graphy-next-plugin-lung-nodule");
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
  if (!fs.existsSync(path.join(DATA_DIR, "ct"))) throw new Error(`${DATA_DIR}/ct がありません`);
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
    const imp = await importPaths(driver.ports.http, [path.join(DATA_DIR, "ct"), path.join(DATA_DIR, "seg")]);
    check(imp.failed === 0, `LIDC-IDRI-0001 を取り込む（${imp.imported} 件）`, imp);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    const cwd = await driver.app.evaluate(({ dialog }, dir) => {
      dialog.showMessageBoxSync = (() => 0) as typeof dialog.showMessageBoxSync;
      (dialog as unknown as { showSaveDialog: unknown }).showSaveDialog = async (_w: unknown, o: { defaultPath?: string }) => ({
        canceled: false, filePath: `${dir}\\${(o?.defaultPath ?? "out.bin").replace(/[\\/]/g, "_")}`,
      });
      return process.cwd();
    }, OUT_DIR);
    endpointsFile = path.join(cwd, "compute-endpoints.json");
    endpointsBackup = fs.existsSync(endpointsFile) ? fs.readFileSync(endpointsFile, "utf8") : null;
    if (endpointsBackup !== null) fs.rmSync(endpointsFile);
    await page.getByTestId("mainscreen-menu-system").click();
    await page.getByTestId("menu-item-settings").click();
    await page.getByTestId("settings-cat-compute").click();
    await page.getByTestId("compute-colab").waitFor({ state: "visible", timeout: 10_000 });
    if ((await page.getByTestId("compute-colab-account").count()) === 0) throw new Error("Colab にログインしていません（computeColabCheck を先に）");
    await page.getByTestId("compute-colab-spec").selectOption("VARIANT_GPU/T4/SHAPE_STANDARD");
    await page.getByTestId("compute-colab-add").click();
    await page.getByTestId(`compute-endpoint-${endpointId}`).waitFor({ state: "visible", timeout: 10_000 });
    await page.getByTestId("dialog-close-button").click();

    const base = `http://localhost:${driver.ports.http}`;
    const study = ((await (await fetch(`${base}/api/studies`)).json()) as { studyInstanceUid: string }[])[0];
    const series = (await (await fetch(`${base}/api/studies/${study.studyInstanceUid}/series`)).json()) as { seriesInstanceUid: string; modality: string }[];
    const ct = series.find((s) => s.modality === "CT")!;
    const segSeries = series.find((s) => s.modality === "SEG")!;
    await dismissStartupDialogs(page);
    const dates = page.locator('input[type="date"]');
    await dates.nth(0).fill("");
    await dates.nth(1).fill("");
    await page.getByTestId("search-submit-button").click();
    await page.locator(`[data-testid="study-row-${study.studyInstanceUid}"]`).click();
    await page.locator(`[data-testid="series-row-${ct.seriesInstanceUid}"]`).click();
    const viewer = await driver.waitForNewPage(() => page.getByTestId("viewer2d-toolbar-button").click(), (url) => url.includes("2dviewer"));
    await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 60_000 });
    await viewer.waitForTimeout(3_000);
    await openAnalysisPlugin(viewer, PLUGIN_ID);

    console.log("\n[1] 実行（Colab の T4）");
    const t1 = Date.now();
    await viewer.getByTestId("lnd-run").click();
    const w = await consentWindow(driver, 300_000);
    check((await approvedSha(w)).length === 64, "同意画面は 1 回・npz 1 件");
    await w.getByTestId("consent-ack").check();
    await w.getByTestId("consent-send").click();
    await viewer.waitForFunction(() => (window as unknown as { __lungNoduleState?: { phase: string } }).__lungNoduleState?.phase === "idle", null, { timeout: 3_600_000 });
    let s = await state(viewer);
    check(!!s.summary && !s.error, `最後まで走る（${Math.round((Date.now() - t1) / 1000)} 秒）`, s.error);
    if (!s.summary) {
      fs.writeFileSync(path.join(OUT_DIR, "run-error.txt"), `${s.error}\n\n${(s.traceback ?? []).join("\n").replace(/\u001b\[[0-9;]*m/g, "")}\n\n${s.stderr ?? ""}`);
      throw new Error("実行に失敗したので中断します");
    }
    console.log(`    ${JSON.stringify({ version: s.summary.version, stages: s.summary.stages, gpu: s.summary.gpu, nodules: s.summary.nodules.length, resampled: s.summary.resampled })}`);
    check(/T4/.test(s.summary.gpu?.name ?? ""), "GPU T4 で走った", s.summary.gpu);

    console.log("\n[2] 経路");
    const vox = new Map<number, number>(s.summary.nodules.map((x: { id: number; voxels: number }) => [x.id, x.voxels]));
    const h66 = new Map<number, number>(s.h66.map((m: { label: number; voxelCount: number }) => [m.label, m.voxelCount]));
    const bad = [...vox.entries()].filter(([id, n]) => h66.get(id) !== n);
    check(vox.size > 0 && h66.size === vox.size && bad.length === 0, `H66 のボクセル数が計算機の数え上げと一致（${vox.size} 個）`, bad.slice(0, 5));
    const meshBad = s.mesh.filter((m: { id: number; voxelCount: number }) => vox.get(m.id) !== m.voxelCount);
    check(s.mesh.length === vox.size && meshBad.length === 0, "H33（切り出したマスク）のボクセル数も一致", meshBad.slice(0, 5));
    console.log(`    上位: ${JSON.stringify(s.rows.slice(0, 5).map((r: any) => ({ no: r.no, lobe: r.lobe, ml: +r.volumeMl.toFixed(3), d: +r.equivalentDiameterMm.toFixed(1), d3: r.diameters3dMm?.map((x: number) => +x.toFixed(1)), hu: +r.meanHu.toFixed(0) })))}`);
    check(s.shown?.ok === true && s.shown.segmentCount === vox.size, "H65: 候補が ROI マネージャに読み込まれる", s.shown);

    console.log("\n[3] 読影医の結節（SEG）と照らし合わせる");
    const geo = await viewer.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const v = (window as any).__lungNoduleState.labels.vol;
      return { spacing: v.spacing as number[], iop: v.iop as number[] };
    });
    const seg = (await (await fetch(`${base}/api/dicom/seg?study=${study.studyInstanceUid}&series=${segSeries.seriesInstanceUid}`)).json()) as {
      rows: number; columns: number; segments: { label: string; frames: { mask: string; imagePositionPatient: number[] | null }[] }[];
    };
    const [r0, r1, r2, c0, c1, c2] = geo.iop;
    let sx = 0, sy = 0, sz = 0, n = 0;
    for (const f of seg.segments[0].frames) {
      if (!f.imagePositionPatient) continue;
      const b = Buffer.from(f.mask, "base64");
      for (let i = 0; i < b.length; i++) {
        if (!b[i]) continue;
        const col = i % seg.columns, row = Math.floor(i / seg.columns);
        const p = f.imagePositionPatient;
        sx += p[0] + col * geo.spacing[0] * r0 + row * geo.spacing[1] * c0;
        sy += p[1] + col * geo.spacing[0] * r1 + row * geo.spacing[1] * c1;
        sz += p[2] + col * geo.spacing[0] * r2 + row * geo.spacing[1] * c2;
        n++;
      }
    }
    const reader = [sx / n, sy / n, sz / n];
    // 読影医の結節の体積（画素数 × 画素面積 × スライス間隔）から等価半径
    const readerMl = (n * geo.spacing[0] * geo.spacing[1] * geo.spacing[2]) / 1000;
    const readerR = Math.cbrt((3 * readerMl * 1000) / (4 * Math.PI));
    const dist = s.rows.map((r: { no: number; centroidLps: number[] }) => ({ no: r.no, d: Math.hypot(r.centroidLps[0] - reader[0], r.centroidLps[1] - reader[1], r.centroidLps[2] - reader[2]) }))
      .sort((a: { d: number }, b: { d: number }) => a.d - b.d);
    console.log(`    読影医の結節: 重心 ${reader.map((x) => x.toFixed(1)).join(", ")}・${readerMl.toFixed(3)} mL・等価半径 ${readerR.toFixed(1)} mm／最も近い候補 #${dist[0]?.no} ${dist[0]?.d.toFixed(1)} mm`);
    check(dist.length > 0 && dist[0].d <= readerR, "🔴 読影医の結節の等価半径以内に候補の重心がある（位置・向きの取り違えが無い）", { reader, readerR, nearest: dist[0] });
    fs.writeFileSync(path.join(OUT_DIR, "reader-match.json"), JSON.stringify({ reader, readerMl, readerR, nearest: dist.slice(0, 3) }, null, 1));

    console.log("\n[4] 一覧から移動");
    check(s.orient === "forward" || s.orient === "reverse", "表示中のスタックと k の向きを決められる", s.orient);
    const no = dist[0]?.no ?? 1;
    await viewer.getByTestId(`lnd-row-${no}`).click();
    await viewer.waitForTimeout(800);
    s = await state(viewer);
    check(s.lastGoTo?.shown === s.lastGoTo?.sliceIndex, `#${no} を押すと重心のスライス（${s.lastGoTo?.sliceIndex}）へ移動する`, s.lastGoTo);
    await viewer.screenshot({ path: path.join(OUT_DIR, "list.png") });
    // 窓が画像を覆うので、いったん見えなくして移動先のスライス（ROI の重ね表示）を撮る
    const hide = (v: string) => viewer.locator(".graphy-plugin-window__close").evaluate((e, vis) => {
      const w = (e as HTMLElement).closest(".graphy-plugin-window") as HTMLElement | null;
      if (w) w.style.visibility = vis;
    }, v);
    await hide("hidden");
    await viewer.screenshot({ path: path.join(OUT_DIR, "goto-nodule.png") });
    await hide("");

    console.log("\n[5] 保存");
    await viewer.getByTestId("lnd-save-seg").click();
    await confirmSave(viewer);
    await viewer.waitForFunction(() => !!(window as unknown as { __lungNoduleState?: { savedSeg?: unknown } }).__lungNoduleState?.savedSeg, null, { timeout: 600_000 });
    await viewer.getByTestId("lnd-save-sr").click();
    await confirmSave(viewer);
    await viewer.waitForFunction(() => !!(window as unknown as { __lungNoduleState?: { savedSr?: unknown } }).__lungNoduleState?.savedSr, null, { timeout: 120_000 });
    await viewer.getByTestId("lnd-save-csv").click();
    await viewer.waitForFunction(() => !!(window as unknown as { __lungNoduleState?: { savedCsv?: unknown } }).__lungNoduleState?.savedCsv, null, { timeout: 60_000 });
    s = await state(viewer);
    check(s.savedSeg?.ok === true, "SEG が保存される", s.savedSeg);
    check(s.savedSr?.ok === true, "SR が保存される", s.savedSr);
    check(s.savedCsv?.ok === true && fs.existsSync(s.savedCsv.filePath), "CSV が保存される", s.savedCsv);
    if (s.savedSeg?.ok) {
      const out = (await (await fetch(`${base}/api/dicom/seg?study=${study.studyInstanceUid}&series=${s.savedSeg.seriesInstanceUid}`)).json()) as { segments: { label: string }[] };
      check(out.segments.length === vox.size && out.segments.every((x) => /^nodule \d+$/.test(x.label)), "SEG は結節だけ（肺葉は入らない）", out.segments.map((x) => x.label).slice(0, 5));
    }
    if (s.savedSr?.ok) {
      const bytes = Buffer.from(await (await fetch(`${base}/api/instances/${s.savedSr.sopInstanceUid}/file`)).arrayBuffer()).toString("latin1");
      check(/VOLUME/.test(bytes) && /MEAN_VALUE/.test(bytes) && !/G-A185/.test(bytes), "SR に体積・平均 CT 値が入り、標準の長径コード（G-A185）は使わない");
    }

    console.log("\n[6] 監査と解放");
    const events = fs.readFileSync(AUDIT, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const fin = events.filter((e: { event: string }) => e.event === "compute-finished");
    check(fin.length === 1 && fin[0].outcome === "ok", "監査: 実行が ok", fin.length);
    await viewer.locator(".graphy-plugin-window__close").click();
    await viewer.getByTestId("compute-release-confirm").waitFor({ state: "visible", timeout: 30_000 });
    await viewer.getByTestId("compute-release-ok").click();
    await viewer.waitForFunction(() => !!(window as unknown as { __lungNoduleState?: { release?: unknown } }).__lungNoduleState?.release, null, { timeout: 120_000 });
    s = await state(viewer);
    check(s.release?.ok === true && s.release?.released === true, "「解放する」で解放される", s.release);
    fs.writeFileSync(path.join(OUT_DIR, "state.json"), JSON.stringify({ summary: s.summary, rows: s.rows, orient: s.orient, lastGoTo: s.lastGoTo }, null, 1));
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
