/*
 * GNBP-XA-8 による **「病変の形は問わない」の実機検証**（A4c・`fw/angio-design.md` §16.5.2）。
 *
 * 準備:  cd bench && python3 make_phantom_xa.py --out ./phantom --series lesionshapes
 *        cd backend && mvn -q -Dfrontend.skip=true -DskipTests package
 * 実行:  cd automator && npx tsx src/spike/xaLesionShapeCheck.ts
 *
 * <h3>🔴 なぜ GNBP-XA-7 では足りなかったのか</h3>
 * XA-7 は各フレームが**一様な非円形断面**なので、アプリの運用（健常部に円柱を当てはめて μ を
 * 得る）だと**健常部の当てはめが必ず外れる**。実測でも μ を自分自身から取ると比 0.694〜1.410 と
 * 大きく外れた。つまり **XA-7 では密度計測の利点を実機で示せない**（§16.5.2）。
 *
 * <p>この系列は**健常部を円柱に保ち、病変部だけ形を変える**。アプリを一切変えずに
 * 「病変の形は問わない／健常部は円形とみなす」という契約そのものを測れる。
 *
 * <h3>検査の要</h3>
 * 5 フレームとも**病変の断面積は同じ**（健常部の 50%＝等価直径での %DS は 29.3%）で、
 * **シルエットの幅だけが 1.50〜3.00mm と 2 倍違う**。したがって:
 * - 密度計測なら **5 本とも同じ %DS** になるはず。
 * - 半値法はシルエットを追うので **%DS が 0.1%〜50%** に散るはず
 *   （**ellipse-wide と d-shape は「狭窄なし」に見える**——面積は半分なのに）。
 *
 * **同じ画像・同じ操作で両方式を回して比べる**ので、差は方式だけに帰せられる。
 */
import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { waitForMainScreenReady } from "../checklist/items/shared/helpers.js";
import { dismissStartupDialogs, findBlockingOverlay } from "../common/dismissDialogs.js";
import { dragSpanMmOnCanvasHost } from "../common/pointerDrag.js";

const REPO_ROOT = path.resolve(AUTOMATOR_ROOT, "..");
const PHANTOM_DIR = path.join(REPO_ROOT, "bench", "phantom", "GNBP-XA");
const TRUTH_PATH = path.join(PHANTOM_DIR, "truth.json");
const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "xa-lesion-shape");
const HOST = "viewer2d-canvas-host";

/** 【目標】密度計測の %DS の絶対誤差 [%pt]。 */
const TARGET_DS_PT = 4.0;
/** 【目標】密度計測の MLD の絶対誤差 [mm]。 */
const TARGET_MLD_MM = 0.15;
/**
 * 【目標】**形が違っても MLD がそろう**幅 [mm]。
 * 5 本の断面積は同じなので、密度計測ならここに収まるはず。
 */
const TARGET_SPREAD_MM = 0.2;

interface FrameTruth {
  frame: number;
  shape: string;
  note: string;
  lesionAreaMm2: number;
  equivalentDiameterMm: number;
  silhouetteWidthMm: number;
  referenceDiameterMm: number;
  percentAreaStenosis: number;
  percentDiameterStenosis: number;
  percentDiameterStenosisBySilhouette: number;
}

interface Truth {
  lesionshapes: {
    file: string;
    studyInstanceUid: string;
    healthyAreaMm2: number;
    frames: FrameTruth[];
  };
}

interface QcaState {
  imageId: string;
  mld: number;
  rvd: number;
  percentDiameterStenosis: number;
  percentAreaStenosis: number;
  unit: string;
  diameterMethod: "half-max" | "densitometric";
  muPerMm: number | null;
  densitometryFallback: string | null;
}

let pass = 0;
let fail = 0;
let unmet = 0;
const lines: string[] = [];

function check(cond: boolean, label: string, detail?: unknown): void {
  if (cond) pass++;
  else fail++;
  const d = detail === undefined ? "" : ` ${JSON.stringify(detail)}`;
  lines.push(`  [${cond ? "ok  " : "FAIL"}] ${label}${d}`);
  console.log(lines[lines.length - 1]);
}

function target(cond: boolean, label: string, detail?: unknown): void {
  if (cond) pass++;
  else unmet++;
  const d = detail === undefined ? "" : ` ${JSON.stringify(detail)}`;
  lines.push(`  [${cond ? "ok  " : "UNMET"}] ${label}${d}`);
  console.log(lines[lines.length - 1]);
}

async function qcaState(page: Page): Promise<QcaState | null> {
  return page.evaluate(() => {
    const dbg = (window as unknown as { __graphyDebug?: { getQcaState?: () => unknown } }).__graphyDebug;
    return (dbg?.getQcaState?.() ?? null) as unknown;
  }) as Promise<QcaState | null>;
}

async function openStudy(page: Page, studyUid: string): Promise<void> {
  await dismissStartupDialogs(page);
  const blocker = await findBlockingOverlay(page, "search-submit-button");
  if (blocker) throw new Error(`検索ボタンが別の要素に塞がれています: ${blocker}`);
  const dateInputs = page.locator('input[type="date"]');
  await dateInputs.nth(0).fill("");
  await dateInputs.nth(1).fill("");
  await page.getByTestId("search-submit-button").click();
  const row = page.locator(`[data-testid="study-row-${studyUid}"]`);
  await row.waitFor({ state: "visible", timeout: 20_000 });
  for (let i = 0; i < 3; i++) {
    await row.click();
    await page.waitForTimeout(800);
    if ((await page.locator('[data-testid^="series-row-"]').count()) > 0) return;
  }
  throw new Error("シリーズ行が出ません");
}

async function selectLengthTool(viewer: Page): Promise<void> {
  await viewer.getByTestId("viewer2d-menu-roi").click();
  await viewer.waitForTimeout(250);
  await viewer.getByText("長さ", { exact: true }).first().click();
  await viewer.waitForTimeout(300);
}

async function main(): Promise<void> {
  if (!fs.existsSync(TRUTH_PATH)) throw new Error(`ファントムがありません: ${PHANTOM_DIR}`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const truth = JSON.parse(fs.readFileSync(TRUTH_PATH, "utf8")) as Truth;
  const t8 = truth.lesionshapes;
  if (!t8) {
    throw new Error("truth.json に lesionshapes がありません（--series lesionshapes で生成する）");
  }

  const rows: Record<string, unknown>[] = [];
  const driver = new DesktopDriver();
  await driver.start();
  try {
    const mainPage = driver.page;
    mainPage.on("dialog", (d) => void d.accept().catch(() => {}));
    await resetDb(driver.ports.http);
    const imp = await importPaths(driver.ports.http, [path.join(PHANTOM_DIR, t8.file)]);
    check(imp.imported === 1, "[準備] GNBP-XA-8 を取り込めた", imp);

    await waitForMainScreenReady(mainPage, 60_000);
    await dismissStartupDialogs(mainPage);
    await openStudy(mainPage, t8.studyInstanceUid);
    await mainPage.locator('[data-testid^="series-row-"]').first().click();

    const viewer = await driver.waitForNewPage(
      () => mainPage.getByTestId("viewer2d-toolbar-button").click(),
      (url) => url.includes("2dviewer"),
    );
    await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 30_000 });
    await viewer.waitForTimeout(3_000);
    await selectLengthTool(viewer);

    const densMlds: number[] = [];

    for (const f of t8.frames) {
      await viewer.getByTestId("cine-seek").fill(String(f.frame - 1));
      await viewer.waitForTimeout(900);
      // 計測は imageId（＝フレーム）ごと。解析するフレームで引き直す。
      await dragSpanMmOnCanvasHost(viewer, HOST, 20);
      await viewer.getByTestId("xa-analysis-open").click();
      await viewer.getByTestId("xa-analysis-dialog").waitFor({ state: "visible", timeout: 10_000 });
      await viewer.getByTestId("xa-qca-run").click();
      await viewer.waitForTimeout(3_500);
      const st = await qcaState(viewer);
      const label = `frame ${f.frame} (${f.shape})`;
      // 🚨 別フレームの結果でも「もっともらしい数値」が出る。**解析した imageId** で確かめる。
      const analyzedFrame = /[?&]frame=(\d+)/.exec(st?.imageId ?? "")?.[1];
      await viewer.getByTestId("xa-dialog-close").click();
      await viewer.waitForTimeout(400);

      if (!st) {
        check(false, `[XA-8] ${label} — 解析できた`);
        continue;
      }
      check(analyzedFrame === String(f.frame), `[XA-8] ${label} — ★狙ったフレームを解析している`, {
        want: f.frame,
        got: analyzedFrame,
      });
      check(st.unit === "mm", `[XA-8] ${label} — 装置校正済みなので mm で出る`, st.unit);
      check(
        st.diameterMethod === "densitometric",
        `[XA-8] ${label} — 密度計測が働いている（退避していない）`,
        { method: st.diameterMethod, fallback: st.densitometryFallback, mu: st.muPerMm },
      );

      // ── ★ 病変の形が変わっても、面積が同じなら同じ値になる ──────────
      target(
        Math.abs(st.percentDiameterStenosis - f.percentDiameterStenosis) < TARGET_DS_PT,
        `[XA-8] ${label} — ★【目標】%DS が真値 ±${TARGET_DS_PT}pt（形に依らない）`,
        {
          truth: Number(f.percentDiameterStenosis.toFixed(1)),
          measured: Number(st.percentDiameterStenosis.toFixed(1)),
          シルエットで測ったら: Number(f.percentDiameterStenosisBySilhouette.toFixed(1)),
        },
      );
      target(
        Math.abs(st.mld - f.equivalentDiameterMm) < TARGET_MLD_MM,
        `[XA-8] ${label} — 【目標】MLD が面積等価直径 ±${TARGET_MLD_MM}mm`,
        { truth: Number(f.equivalentDiameterMm.toFixed(3)), measured: Number(st.mld.toFixed(3)) },
      );
      // 参照径（健常部＝円柱）は真値どおりのはず。ここが崩れたら μ の当てはめが壊れている。
      check(
        Math.abs(st.rvd - f.referenceDiameterMm) < 0.2,
        `[XA-8] ${label} — 健常部（円柱）の参照径が真値どおり`,
        { truth: f.referenceDiameterMm, measured: Number(st.rvd.toFixed(3)) },
      );
      densMlds.push(st.mld);

      // ⚠️ **半値法での再実行はアプリに口を作らない**。そのためだけのデバッグ関数は
      //    製品コードを検証のために曲げることになる。半値法がどう出るかは
      //    真値（シルエット）と、同じ画像を純関数へ直接通したオフライン実測で分かる:
      //    circle 30.0 / ellipse-wide **1.7** / ellipse-tall 51.7 / crescent 46.7 /
      //    d-shape **1.7** ——**同じ 50% 面積狭窄が 1.7%〜51.7% に散る**（§16.5.2）。

      rows.push({
        shape: f.shape,
        真値面積mm2: Number(f.lesionAreaMm2.toFixed(3)),
        真値等価D: Number(f.equivalentDiameterMm.toFixed(3)),
        真値シルエット: Number(f.silhouetteWidthMm.toFixed(3)),
        密度MLD: Number(st.mld.toFixed(3)),
        密度DS: Number(st.percentDiameterStenosis.toFixed(1)),
        シルエットDS: Number(f.percentDiameterStenosisBySilhouette.toFixed(1)),
      });
    }

    // ══ ★ この系列の核心 ═══════════════════════════════════════════
    const spread = (v: number[]) => (v.length ? Math.max(...v) - Math.min(...v) : NaN);
    const truthSilhouetteSpread =
      Math.max(...t8.frames.map((f) => f.silhouetteWidthMm)) -
      Math.min(...t8.frames.map((f) => f.silhouetteWidthMm));
    target(
      spread(densMlds) < TARGET_SPREAD_MM,
      `[XA-8] ★【目標】断面積が同じなら、形が違っても MLD がそろう（幅 < ${TARGET_SPREAD_MM}mm）`,
      {
        密度計測の幅: Number(spread(densMlds).toFixed(3)),
        真値シルエットの幅: Number(truthSilhouetteSpread.toFixed(3)),
      },
    );
    // ★ ファントムが**弁別力を持っている**ことを同時に示す。これが無いと
    //   「そろった」という結果が「そもそも差が出ない系列だった」と区別できない。
    check(
      truthSilhouetteSpread > 1.4,
      "[XA-8] ★この系列は形で 2 倍のシルエット差がある（そろったことに意味がある）",
      {
        シルエットの幅mm: Number(truthSilhouetteSpread.toFixed(3)),
        半値法なら: "%DS 1.7〜51.7 に散る（オフライン実測・§16.5.2）",
      },
    );

    fs.writeFileSync(path.join(OUT_DIR, "lesion-shape.json"), JSON.stringify(rows, null, 2));
    console.table(rows);
    await viewer.screenshot({ path: path.join(OUT_DIR, "1-lesion-shape.png") }).catch(() => {});
  } finally {
    await driver.stop().catch(() => {});
    const summary =
      `\n===== 病変の形と径の測り方（A4c・GNBP-XA-8）=====\n` +
      `合格 ${pass} / 失敗 ${fail} / 設計目標に未達 ${unmet}`;
    console.log(summary);
    fs.writeFileSync(path.join(OUT_DIR, "log.txt"), lines.join("\n") + summary + "\n");
  }
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
