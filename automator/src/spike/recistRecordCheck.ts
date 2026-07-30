/*
 * Lesion Evanesco の**評価記録**（開いていないタイムポイントを補う仕組み）の実機検証。
 *
 * 実行:  cd automator && npx tsx src/spike/recistRecordCheck.ts
 *
 * <p><b>何を確かめるか</b>: `getRois()` は開いているタイルの ROI しか返さないので、RECIST の
 * nadir と BOR を全期間で出すには、プラグインが各回の内容を記録して開いていない回を補う必要がある。
 * その仕組みが**本物の環境で効いているか**を見る。
 *
 *   1. ベースラインだけを取り込んで計測すると、プラグインがその回を記録する
 *   2. **DB を作り直してフォローアップだけを取り込んでも**、記録からベースラインが補われる
 *   3. 補われたベースラインに対して効果判定（PR）が出る
 *   4. 補った行は出所が「記録」、開いている行は「画面」と区別して見える
 *
 * <p><b>なぜ 1 回分ずつ取り込むか</b>: どのスタディが開くかは検索結果の順序に依存するため
 * （`recistPluginCheck.ts` でこれに引っかかった）、**DB に 1 スタディしか無い状態**にして
 * 開く対象を決定的にする。記録はプラグイン側（レンダラの localStorage）に残るので、
 * DICOM を消しても記録は残る——まさにこの仕組みを試すのに都合がよい。
 *
 * <p>前提: backend jar、プラグインの `npm run build` と `npm run phantom`。
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

const PLUGIN_REPO = path.join(os.homedir(), "graphy-workspace", "graphy-next-plugin-lesion-evanesco");
const PLUGIN_ID = "lesion-evanesco";
const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "recist-record-check");
const PATIENT = "RECIST-PR";
/** ファントムのファイル名（検査日つき）。1 回分ずつ取り込むために直接指す。 */
const TP0 = "TP0_20260105.dcm";
const TP1 = "TP1_20260302.dcm";

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

function installPlugin(): void {
  const uiJs = path.join(PLUGIN_REPO, "ui.js");
  if (!fs.existsSync(uiJs)) {
    throw new Error(`${uiJs} がありません。(cd ${PLUGIN_REPO} && npm run build) を実行してください。`);
  }
  const dst = path.join(DESKTOP_RUN_DATA_DIR, "plugins", PLUGIN_ID);
  fs.mkdirSync(dst, { recursive: true });
  fs.copyFileSync(path.join(PLUGIN_REPO, "plugin.json"), path.join(dst, "plugin.json"));
  fs.copyFileSync(uiJs, path.join(dst, "ui.js"));
}

/** ファントムの 1 スライスだけを取り込む（DB に 1 スタディしか無い状態を作る）。 */
async function importOne(httpPort: number, fileName: string): Promise<void> {
  const file = path.join(PLUGIN_REPO, "phantom", PATIENT, fileName);
  if (!fs.existsSync(file)) {
    throw new Error(`${file} がありません。(cd ${PLUGIN_REPO} && npm run phantom) を実行してください。`);
  }
  const res = await fetch(`http://127.0.0.1:${httpPort}/api/import/paths`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paths: [file] }),
  });
  if (!res.ok) throw new Error(`import failed: ${res.status}`);
  console.log(`  import ${fileName}: ${JSON.stringify(await res.json())}`);
}

interface PanelState {
  rows: { label: string; date: string; sld: string; response: string; source: string }[];
  bor: string;
  confirmedBor: string;
  progressionDate: string;
  warnings: string[];
  record: string;
}

/**
 * パネルを読む。**文字列として評価させる**（関数参照だと tsx の `__name` ヘルパーが
 * ブラウザ側に無く `ReferenceError`。`common/pointerDrag.ts` に記録済みの罠）。
 */
function readPanel(viewer: Page): Promise<PanelState> {
  return viewer.evaluate(`
    (function () {
      var tbody = document.querySelector('[data-testid="le-timeline"] tbody');
      var rows = [];
      if (tbody) {
        var trs = tbody.querySelectorAll("tr");
        for (var i = 0; i < trs.length; i++) {
          var tds = trs[i].querySelectorAll("td");
          var c = [];
          for (var j = 0; j < tds.length; j++) c.push((tds[j].textContent || "").trim());
          rows.push({
            label: c[0] || "", date: c[1] || "", sld: c[2] || "",
            response: c[5] || "", source: c[6] || "",
          });
        }
      }
      // 値ごとに testId があるので、連結テキストの正規表現に頼らない
      // （インライン要素が "BORPR確定 BOR…" のように繋がるため脆く、実際に空文字を掴んだ）。
      var borEl = document.querySelector('[data-testid="le-bor"]');
      var cborEl = document.querySelector('[data-testid="le-confirmed-bor"]');
      var pdEl = document.querySelector('[data-testid="le-progression-date"]');
      var warnEl = document.querySelector('[data-testid="le-warnings"]');
      var warnings = [];
      if (warnEl) for (var k = 0; k < warnEl.children.length; k++) warnings.push(warnEl.children[k].textContent || "");
      var rec = document.querySelector('[data-testid="le-record"]');
      return {
        rows: rows,
        bor: borEl ? (borEl.textContent || "").trim() : "",
        confirmedBor: cborEl ? (cborEl.textContent || "").trim() : "",
        progressionDate: pdEl ? (pdEl.textContent || "").trim() : "",
        warnings: warnings,
        record: rec ? (rec.textContent || "") : "",
      };
    })()
  `) as Promise<PanelState>;
}

async function openViewer(driver: DesktopDriver): Promise<Page> {
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

/**
 * プラグインの評価記録を消す（検証の独立性のため）。
 *
 * <p>記録は**レンダラの localStorage** にあり、Electron のユーザーデータとして
 * 実行を跨いで残る（それが機能の目的）。消さないと前回の記録が混ざり、1 回目から
 * 2 行出てしまう（実際に踏んだ）。`resetDb` は backend の DB を消すだけで、ここには効かない。
 */
async function clearPluginRecord(viewer: Page): Promise<void> {
  await viewer.evaluate(`
    (function () {
      var drop = [];
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf("lesion-evanesco.record.") === 0) drop.push(k);
      }
      for (var j = 0; j < drop.length; j++) localStorage.removeItem(drop[j]);
      return drop.length;
    })()
  `);
}

/** Bidirectional で 1 本測る（`dx` を変えると測定値が変わる＝判定を作れる）。 */
async function measure(viewer: Page, dx: number): Promise<void> {
  await viewer.getByTestId("viewer2d-menu-roi").click();
  await viewer.getByRole("button", { name: /長径・短径|Long\/short axis/ }).first().click();
  await viewer.waitForTimeout(300);
  await dragOnCanvasHost(viewer, "viewer2d-canvas-host", dx, 0, 0, 10, { fracX: 0.28, fracY: 0.5 });
  await viewer.waitForTimeout(800);
}

async function openPanel(viewer: Page): Promise<void> {
  await viewer.getByTestId("viewer2d-menu-plugins").click();
  await viewer.getByTestId(`plugin-item-${PLUGIN_ID}`).click();
  await viewer.getByTestId("lesion-evanesco-panel").waitFor({ state: "visible", timeout: 15_000 });
  // 記録の書き込み → 再評価が終わるのを待つ。
  await viewer.waitForTimeout(1200);
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  installPlugin();

  // ============ 1 回目: ベースラインだけを取り込んで測る ============
  console.log("\n[1] ベースライン（2026-01-05）だけを取り込んで計測する");
  const d1 = new DesktopDriver();
  await d1.start();
  let baselineSld = "";
  try {
    await resetDb(d1.ports.http);
    await importOne(d1.ports.http, TP0);
    const viewer = await openViewer(d1);
    // 前回実行の記録を消してから始める（記録は実行を跨いで残るので、消さないと 1 回目から 2 行出る）。
    await clearPluginRecord(viewer);
    await measure(viewer, 70);
    await openPanel(viewer);
    const panel = await readPanel(viewer);
    console.log(JSON.stringify(panel, null, 2));
    await viewer.screenshot({ path: path.join(OUT_DIR, "1-baseline.png") });

    check(panel.rows.length === 1, "ベースラインだけなので 1 行", panel.rows.length);
    check(panel.rows[0]?.date === "2026-01-05", "検査日がベースラインのもの", panel.rows[0]?.date);
    check(panel.rows[0]?.source === "画面", "出所は「画面」（開いている回）", panel.rows[0]?.source);
    check(/^\d+\.\d$/.test(panel.rows[0]?.sld ?? ""), "SLD が数値で出る", panel.rows[0]?.sld);
    baselineSld = panel.rows[0]?.sld ?? "";
    check(panel.record.includes("1 回分"), "評価記録が 1 回分になる", panel.record.trim().slice(0, 40));

    await viewer.close().catch(() => {});
  } finally {
    await d1.stop();
  }

  if (!baselineSld) {
    console.log("\nベースラインを計測できなかったため中断します。");
    process.exitCode = 1;
    return;
  }

  // ============ 2 回目: DB を作り直し、フォローアップだけを取り込む ============
  // **ここが本題**。DICOM もベースラインの ROI も無い状態で、記録だけからベースラインが補われるか。
  console.log("\n[2] DB を作り直し、フォローアップ（2026-03-02）だけを取り込む");
  const d2 = new DesktopDriver();
  await d2.start();
  try {
    console.log(`  reset: ${JSON.stringify(await resetDb(d2.ports.http))}`);
    await importOne(d2.ports.http, TP1);
    const viewer = await openViewer(d2);
    // ベースラインより短く測る（-40% 程度 → PR になるはず）。
    await measure(viewer, 40);
    await openPanel(viewer);
    const panel = await readPanel(viewer);
    console.log(JSON.stringify(panel, null, 2));
    await viewer.screenshot({ path: path.join(OUT_DIR, "2-record-filled.png") });

    check(panel.rows.length === 2, "記録から補われて 2 行になる", panel.rows.map((r) => `${r.date}/${r.source}`));
    const base = panel.rows.find((r) => r.date === "2026-01-05");
    const fu = panel.rows.find((r) => r.date === "2026-03-02");
    check(!!base, "ベースラインが記録から現れる（DICOM も ROI も無い状態で）", panel.rows.map((r) => r.date));
    check(base?.source === "記録", "補った行の出所が「記録」", base?.source);
    check(base?.sld === baselineSld, "記録された SLD が 1 回目と一致する", { before: baselineSld, after: base?.sld });
    check(fu?.source === "画面", "開いている行の出所は「画面」", fu?.source);
    check(base?.label === "Baseline", "記録の回がベースラインになる（日付順）", base?.label);
    check(fu?.label === "Follow-up 1", "開いている回が Follow-up 1 になる", fu?.label);
    // **記録に対して効果判定が出ること**がこの検証の核心。
    check(
      fu?.response === "PR",
      "補ったベースラインに対して PR と判定される（-30% 以上の縮小）",
      { response: fu?.response, baselineSld, fuSld: fu?.sld },
    );
    check(panel.bor === "PR", "BOR も PR", panel.bor);
    // 確定 BOR は PR が 1 回しか無いので確定できない → 8 週経過しているので SD へフォールバック。
    // ここが PR になっていたら確認（confirmation）ロジックが効いていない。
    check(
      panel.confirmedBor === "SD",
      "確認が取れないので確定 BOR は SD へフォールバック（PR は 1 回のみ）",
      panel.confirmedBor,
    );
    check(panel.progressionDate === "—", "PD が無いので増悪日は空", panel.progressionDate);
    check(
      panel.warnings.some((w) => w.includes("記録から補って")),
      "記録から補っていることが警告として出る（人が区別できる）",
      panel.warnings,
    );
    check(panel.record.includes("2 回分"), "評価記録が 2 回分になる", panel.record.trim().slice(0, 40));

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
