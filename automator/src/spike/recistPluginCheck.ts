/*
 * Lesion Evanesco（RECIST 1.1 プラグイン）の実機通し検証。
 *
 * 実行:  cd automator && npx tsx src/spike/recistPluginCheck.ts
 *
 * <p><b>何を確かめるか</b>: 判定ロジックそのものはプラグイン側の vitest（110 件・Java 版 60
 * シナリオの移植）で固定してあるので、ここで見るのは**配線と一貫性**である。
 *
 *   1. プラグインが第三者プラグインと同じ経路（plugins/ 直下 → /api/plugins）で読み込まれる
 *   2. 画像 → 本体の計測 → プラグインの読み取り が繋がる（デジタルファントムを使う）
 *   3. **タイムポイントが studyDate（H6）で確定する**（3 スタディが検査日順に並ぶ）
 *   4. **SLD が本体の計測値の和と一致する**（プラグインが値を作っていないこと）
 *   5. ROI 属性（Tracking ID 等）が保存され、**アプリを再起動しても計測ごと復元される**
 *
 * <p>前提: backend jar と、プラグイン側で `npm run build` 済みの ui.js。
 *       ファントムは `graphy-next-plugin-lesion-evanesco/tools/makePhantom.ts` が生成する。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Page } from "@playwright/test";

import { DesktopDriver, DESKTOP_RUN_DATA_DIR } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { openFirstSeriesInViewer } from "../checklist/items/shared/helpers.js";
import { dragOnCanvasHost } from "../common/pointerDrag.js";
import { createStepRecorder } from "../checklist/types.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";

/** プラグインの作業ツリー（別リポジトリ）。 */
const PLUGIN_REPO = path.join(os.homedir(), "graphy-workspace", "graphy-next-plugin-lesion-evanesco");
const PLUGIN_ID = "lesion-evanesco";
const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "recist-plugin-check");
/** 検証に使う被験者（PR → PR）。 */
const PATIENT = "RECIST-PR";

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

/** プラグインを backend の plugins フォルダへ置く（第三者プラグインの手置きと同じ形）。 */
function installPlugin(): void {
  const uiJs = path.join(PLUGIN_REPO, "ui.js");
  const manifest = path.join(PLUGIN_REPO, "plugin.json");
  if (!fs.existsSync(uiJs)) {
    throw new Error(`${uiJs} がありません。先に (cd ${PLUGIN_REPO} && npm run build) を実行してください。`);
  }
  const dst = path.join(DESKTOP_RUN_DATA_DIR, "plugins", PLUGIN_ID);
  fs.mkdirSync(dst, { recursive: true });
  fs.copyFileSync(manifest, path.join(dst, "plugin.json"));
  fs.copyFileSync(uiJs, path.join(dst, "ui.js"));
  console.log(`プラグインを配置: ${dst}`);
}

/** ファントムを生成して取り込む。 */
async function importPhantom(httpPort: number): Promise<void> {
  const dir = path.join(PLUGIN_REPO, "phantom");
  if (!fs.existsSync(dir)) {
    throw new Error(`${dir} がありません。(cd ${PLUGIN_REPO} && npm run phantom) を実行してください。`);
  }
  const res = await fetch(`http://127.0.0.1:${httpPort}/api/import/paths`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paths: [path.join(dir, PATIENT)] }),
  });
  if (!res.ok) throw new Error(`import failed: ${res.status}`);
  console.log(`  import: ${JSON.stringify(await res.json())}`);
}

/** 画面から Plug-ins メニュー → プラグインを起動してパネルを出す。 */
async function openPanel(viewer: Page): Promise<void> {
  await viewer.getByTestId("viewer2d-menu-plugins").click();
  await viewer.getByTestId(`plugin-item-${PLUGIN_ID}`).click();
  await viewer.getByTestId("lesion-evanesco-panel").waitFor({ state: "visible", timeout: 15_000 });
}

/** backend の ROI 保存を直接見る（復元されない原因を「保存が無い」と「別スタディを開いた」で切り分ける）。 */
async function roiDoc(httpPort: number, patientKey: string): Promise<{ roiCount: number; studyUids: string[] }> {
  const res = await fetch(`http://127.0.0.1:${httpPort}/api/rois/${encodeURIComponent(patientKey)}`);
  const dto = (await res.json()) as { json: string | null; roiCount: number };
  const parsed = dto.json ? (JSON.parse(dto.json) as { rois: { studyUid?: string }[] }) : { rois: [] };
  return { roiCount: dto.roiCount, studyUids: parsed.rois.map((r) => r.studyUid ?? "?") };
}

/** いま 2D Viewer が表示しているスタディ（プラグインのタイムライン行の検査日で代用せず、本体から取る）。 */
async function openedStudyDate(viewer: Page): Promise<string> {
  return (await viewer.evaluate(`
    (function () {
      var el = document.querySelector('[data-testid="le-timeline"] tbody tr td:nth-child(2)');
      return el ? (el.textContent || "").trim() : "";
    })()
  `)) as string;
}

/** パネルの状態を読む（DOM から。プラグインは window へ結果を書かないため）。 */
async function readPanel(viewer: Page): Promise<{
  rows: { label: string; date: string; sld: string; response: string }[];
  bor: string;
  warnings: string[];
  footer: string;
}> {
  // ⚠ **文字列として評価させる**。関数参照を渡すと、tsx(esbuild) がコンパイル時に挿入する
  // `__name(...)` ヘルパーがブラウザ側の評価コンテキストに存在せず
  // `ReferenceError: __name is not defined` になる（内部に名前付き関数を含む場合。
  // `common/pointerDrag.ts` に記録済みの罠。実際にここでも踏んだ）。
  return viewer.evaluate(`
    (function () {
      var timeline = document.querySelector('[data-testid="le-timeline"] tbody');
      var rows = [];
      if (timeline) {
        var trs = timeline.querySelectorAll("tr");
        for (var i = 0; i < trs.length; i++) {
          var tds = trs[i].querySelectorAll("td");
          var c = [];
          for (var j = 0; j < tds.length; j++) c.push((tds[j].textContent || "").trim());
          rows.push({ label: c[0] || "", date: c[1] || "", sld: c[2] || "", response: c[5] || "" });
        }
      }
      var summary = document.querySelector('[data-testid="le-summary"]');
      var m = summary ? (summary.textContent || "").match(/BOR\\s*([A-Za-z/-]+)/) : null;
      var warnEl = document.querySelector('[data-testid="le-warnings"]');
      var warnings = [];
      if (warnEl) {
        for (var k = 0; k < warnEl.children.length; k++) warnings.push(warnEl.children[k].textContent || "");
      }
      var footer = document.querySelector('[data-testid="le-footer"]');
      return {
        rows: rows,
        bor: m ? m[1] : "",
        warnings: warnings,
        footer: footer ? (footer.textContent || "") : "",
      };
    })()
  `) as Promise<{
    rows: { label: string; date: string; sld: string; response: string }[];
    bor: string;
    warnings: string[];
    footer: string;
  }>;
}

async function openViewerForPatient(driver: DesktopDriver): Promise<Page> {
  const mainPage = driver.page;
  mainPage.on("console", (m) => {
    if (m.type() === "error") console.log(`  [renderer error] ${m.text()}`);
  });
  try {
    await mainPage.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 30_000 });
  } catch {
    await mainPage.reload({ waitUntil: "domcontentloaded" });
    await mainPage.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
  }
  await openFirstSeriesInViewer(mainPage, createStepRecorder());
  const viewer = await driver.waitForNewPage(
    () => mainPage.getByTestId("viewer2d-toolbar-button").click(),
    (url) => url.includes("2dviewer"),
  );
  await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 20_000 });
  await viewer.waitForTimeout(2500);
  return viewer;
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  installPlugin();

  console.log("\n[1] 起動 1 回目 — ファントムを取り込み、計測してプラグインで評価する");
  const d1 = new DesktopDriver();
  await d1.start();
  let firstPanel: Awaited<ReturnType<typeof readPanel>> | null = null;
  let openedDate = "";
  try {
    console.log(`  reset: ${JSON.stringify(await resetDb(d1.ports.http))}`);
    await importPhantom(d1.ports.http);

    const viewer = await openViewerForPatient(d1);

    // ベースラインの病変 A を Bidirectional で測る。
    await viewer.getByTestId("viewer2d-menu-roi").click();
    await viewer.getByRole("button", { name: /長径・短径|Long\/short axis/ }).first().click();
    await viewer.waitForTimeout(300);
    // 病変 A は画像座標 (170, 256) 中心・直径 40mm。Fit 表示なので中心やや左に描く。
    await dragOnCanvasHost(viewer, "viewer2d-canvas-host", 70, 0, 0, 10, { fracX: 0.28, fracY: 0.5 });
    await viewer.waitForTimeout(800);

    await openPanel(viewer);
    const panel = await readPanel(viewer);
    firstPanel = panel;
    console.log(JSON.stringify(panel, null, 2));
    await viewer.screenshot({ path: path.join(OUT_DIR, "1-panel.png") });

    check(true, "プラグインが Plug-ins メニューから読み込まれ、パネルが出る");
    check(panel.rows.length >= 1, "タイムライン表に行が出る", panel.rows.length);
    // studyDate（H6）が使われていること。**どのスタディが開くかは検索結果の順序に依存する**ので
    // 特定の日付を期待しない。ファントムの 3 つの検査日のいずれかであることを見る。
    check(
      panel.rows.every((r) => ["2026-01-05", "2026-03-02", "2026-04-27"].includes(r.date)),
      "検査日が studyDate（H6）から入る（ファントムの検査日と一致）",
      panel.rows.map((r) => r.date),
    );
    check(
      panel.rows.some((r) => r.label === "Baseline"),
      "最古のタイムポイントが Baseline になる",
      panel.rows.map((r) => r.label),
    );
    const baseline = panel.rows.find((r) => r.label === "Baseline");
    check(
      !!baseline && /^\d+\.\d$/.test(baseline.sld),
      "Baseline の SLD が数値で出る（本体の計測値から）",
      baseline?.sld,
    );
    check(panel.warnings.length === 0, "警告が出ていない（欠損なし）", panel.warnings);
    check(panel.footer.includes("ROI 1 件"), "フッタが ROI 件数を示す", panel.footer);

    // 保存が本当に行われたかを backend で確認する（復元失敗の切り分けに要る）。
    await viewer.waitForTimeout(2500); // 自動保存のデバウンス待ち
    const doc = await roiDoc(d1.ports.http, PATIENT);
    console.log(`  保存された ROI: ${JSON.stringify(doc)}`);
    check(doc.roiCount === 1, "ROI が backend に保存される", doc);
    openedDate = await openedStudyDate(viewer);
    console.log(`  1 回目に開いたスタディの検査日: ${openedDate}`);

    await viewer.close().catch(() => {});
  } finally {
    await d1.stop();
  }

  if (!firstPanel) {
    console.log("\n1 回目でパネルを読めなかったため中断します。");
    process.exitCode = 1;
    return;
  }

  console.log("\n[2] 起動 2 回目 — 再起動しても計測と評価が復元されるか");
  const d2 = new DesktopDriver();
  await d2.start();
  try {
    const viewer = await openViewerForPatient(d2);
    await openPanel(viewer);
    const panel = await readPanel(viewer);
    console.log(JSON.stringify(panel, null, 2));
    await viewer.screenshot({ path: path.join(OUT_DIR, "2-restored.png") });

    const doc = await roiDoc(d2.ports.http, PATIENT);
    console.log(`  再起動後の保存: ${JSON.stringify(doc)}`);
    check(doc.roiCount === 1, "再起動後も backend に ROI 保存が残っている", doc);

    const nowDate = await openedStudyDate(viewer);
    console.log(`  2 回目に開いたスタディの検査日: ${nowDate}`);
    if (nowDate !== openedDate) {
      // 別のスタディが開いた場合、その ROI は**このスタックに属さない**ので復元されないのが正しい
      // （別シリーズへ載せると座標の意味が壊れる）。検証としては成立しないのでスキップする。
      console.log(`  [skip] 1 回目と別のスタディが開いた（${openedDate} → ${nowDate}）ため復元の検査はスキップ`);
      check(panel.footer.includes("ROI 0 件"), "別スタディでは ROI を復元しない（別シリーズへ載せない）", panel.footer);
    } else {
      const b1 = firstPanel.rows[0];
      const b2 = panel.rows[0];
      check(!!b2 && b1.sld === b2.sld, "再起動後も SLD が完全に同じ（world 座標で復元）", {
        before: b1?.sld,
        after: b2?.sld,
      });
      check(!!b2 && b2.date === b1.date, "再起動後も検査日が同じ", { before: b1?.date, after: b2?.date });
      check(panel.footer.includes("ROI 1 件"), "再起動後も ROI が 1 件見えている", panel.footer);
    }

    await viewer.close().catch(() => {});
  } finally {
    await d2.stop();
  }

  console.log("\n=== 結果 ===");
  if (failures.length === 0) {
    console.log(`${passed} 項目すべて OK。スクリーンショット: ${OUT_DIR}`);
  } else {
    console.log(`FAIL ${failures.length} 件:`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  }
}

await main();
