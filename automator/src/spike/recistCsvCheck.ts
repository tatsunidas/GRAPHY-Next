/*
 * Lesion Evanesco（RECIST 1.1 プラグイン）の **CSV 書き出し**の実機検証。
 *
 * 実行:  cd automator && npx tsx src/spike/recistCsvCheck.ts
 *
 * <p><b>何を確かめるか</b>: 書式そのものはプラグイン側の vitest（`test/csvReport.test.ts`）で
 * 固定してあるので、ここで見るのは**実機の値が実際に紙へ載ること**である。
 *
 *   1. パネルの CSV ボタンから書き出しが起きる（Blob と保存ファイル名が作られる）
 *   2. **CSV の数値が画面の数値と一致する**（プラグインが書き出し時に計算し直していない）
 *   3. 警告・規則違反が CSV にも載る（紙になった時点で消えない）
 *   4. 先頭に BOM が付く（部位名の日本語が Excel で化けない）
 *
 * <p><b>ダウンロードは実行しない。</b> Electron は保存先が未設定だと**ネイティブの保存ダイアログ**
 * を出し、それが出た瞬間に自動操作が固まる。そこで `HTMLAnchorElement.prototype.click` を
 * 差し替えて Blob の中身とファイル名だけを捕まえ、**本物のダウンロードは起こさない**。
 * したがって「OS に実ファイルが保存されること」はこの検証の範囲外
 * （本体の ROI マネージャ・動画解析と同じ経路なので、そちらと同じ挙動になる）。
 *
 * <p>前提: backend jar と、プラグイン側で `npm run build` 済みの ui.js、`npm run phantom` 済み。
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
const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "recist-csv-check");
const PATIENT = "RECIST-PR";
/** ベースラインの回だけを取り込む（どのスタディが開くかを検索結果の順序に委ねない）。 */
const BASELINE_FILE = "TP0_20260105.dcm";

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
    throw new Error(`${uiJs} がありません。先に (cd ${PLUGIN_REPO} && npm run build) を実行してください。`);
  }
  const dst = path.join(DESKTOP_RUN_DATA_DIR, "plugins", PLUGIN_ID);
  fs.mkdirSync(dst, { recursive: true });
  fs.copyFileSync(path.join(PLUGIN_REPO, "plugin.json"), path.join(dst, "plugin.json"));
  fs.copyFileSync(uiJs, path.join(dst, "ui.js"));
  console.log(`プラグインを配置: ${dst}`);
}

async function importPhantom(httpPort: number): Promise<void> {
  const file = path.join(PLUGIN_REPO, "phantom", PATIENT, BASELINE_FILE);
  if (!fs.existsSync(file)) {
    throw new Error(`${file} がありません。(cd ${PLUGIN_REPO} && npm run phantom) を実行してください。`);
  }
  const res = await fetch(`http://127.0.0.1:${httpPort}/api/import/paths`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paths: [file] }),
  });
  if (!res.ok) throw new Error(`import failed: ${res.status}`);
  console.log(`  import: ${JSON.stringify(await res.json())}`);
}

/**
 * プラグインの端末ローカル状態（評価記録・サムネイル）を消す。
 * `resetDb` は backend の DB しか消さないので、前回の実行が「記録」として混ざる。
 */
async function clearPluginStorage(viewer: Page): Promise<number> {
  return (await viewer.evaluate(`
    (function () {
      var keys = [];
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf("lesion-evanesco.") === 0) keys.push(k);
      }
      for (var j = 0; j < keys.length; j++) localStorage.removeItem(keys[j]);
      return keys.length;
    })()
  `)) as number;
}

/**
 * ダウンロードを**起こさずに**捕まえる仕掛けを入れる。
 * `a.click()` を差し替え、`download` 属性と Blob の中身だけを控える。
 */
async function armDownloadTrap(viewer: Page): Promise<void> {
  await viewer.evaluate(`
    (function () {
      window.__csvTrap = null;
      var orig = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () {
        var self = this;
        if (!self.download || !/^blob:/.test(self.href)) return orig.call(self);
        // 本物のダウンロード（＝ネイティブ保存ダイアログ）は起こさない。
        window.__csvTrap = { filename: self.download, text: null, head: null, error: null };
        fetch(self.href)
          .then(function (r) { return r.arrayBuffer(); })
          .then(function (buf) {
            var bytes = new Uint8Array(buf);
            // 先頭バイトを生で控える（Response.text() は UTF-8 デコード時に BOM を取り除く
            // 仕様なので、テキストからは BOM の有無を判定できない。実際に誤検出した）。
            window.__csvTrap.head = [bytes[0], bytes[1], bytes[2]];
            window.__csvTrap.text = new TextDecoder("utf-8").decode(bytes);
          })
          .catch(function (e) { window.__csvTrap.error = String(e); });
      };
    })()
  `);
}

async function readTrap(viewer: Page): Promise<{
  filename: string;
  text: string | null;
  /** 先頭 3 バイト（BOM の判定用）。 */
  head: number[] | null;
  error: string | null;
} | null> {
  return (await viewer.evaluate("window.__csvTrap")) as never;
}

/** 画面のタイムポイント表と病変表を読む（CSV と突き合わせる相手）。 */
async function readPanel(viewer: Page): Promise<{
  rows: { label: string; date: string; sld: string; response: string }[];
  lesionSizes: string[];
  eligibility: string[];
}> {
  return viewer.evaluate(`
    (function () {
      var rows = [];
      var tbody = document.querySelector('[data-testid="le-timeline"] tbody');
      if (tbody) {
        var trs = tbody.querySelectorAll("tr");
        for (var i = 0; i < trs.length; i++) {
          var tds = trs[i].querySelectorAll("td");
          var c = [];
          for (var j = 0; j < tds.length; j++) c.push((tds[j].textContent || "").trim());
          rows.push({ label: (c[0] || "").replace("⚠", "").trim(), date: c[1] || "", sld: c[2] || "", response: c[5] || "" });
        }
      }
      var sizes = [];
      var lesionRows = document.querySelectorAll('[data-testid^="le-lesion-"]');
      for (var m = 0; m < lesionRows.length; m++) {
        var tds2 = lesionRows[m].querySelectorAll("td");
        if (tds2.length >= 7) sizes.push((tds2[6].textContent || "").trim());
      }
      var elig = [];
      var box = document.querySelector('[data-testid="le-eligibility"]');
      if (box) {
        var kids = box.querySelectorAll("[data-testid]");
        for (var k = 0; k < kids.length; k++) elig.push(kids[k].textContent || "");
      }
      return { rows: rows, lesionSizes: sizes, eligibility: elig };
    })()
  `) as never;
}

async function openPanel(viewer: Page): Promise<void> {
  await viewer.getByTestId("viewer2d-menu-plugins").click();
  await viewer.getByTestId(`plugin-item-${PLUGIN_ID}`).click();
  await viewer.getByTestId("lesion-evanesco-panel").waitFor({ state: "visible", timeout: 15_000 });
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

async function drawBidirectional(
  viewer: Page,
  longPx: number,
  shortPx: number,
  at: { fracX: number; fracY: number },
): Promise<void> {
  await viewer.getByTestId("viewer2d-menu-roi").click();
  await viewer.getByRole("button", { name: /長径・短径|Long\/short axis/ }).first().click();
  await viewer.waitForTimeout(300);
  await dragOnCanvasHost(viewer, "viewer2d-canvas-host", longPx, 0, 0, shortPx, at);
  await viewer.waitForTimeout(900);
}

/** CSV を区画（空行区切り）へ切り分ける。 */
function sections(csv: string): string[][] {
  return csv.split("\r\n\r\n").map((b) => b.split("\r\n"));
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  installPlugin();

  const driver = new DesktopDriver();
  await driver.start();
  try {
    console.log(`  reset: ${JSON.stringify(await resetDb(driver.ports.http))}`);
    await importPhantom(driver.ports.http);
    const viewer = await openViewerForPatient(driver);
    console.log(`  プラグインの端末ローカル状態を消去: ${await clearPluginStorage(viewer)} キー`);

    console.log("\n[1] 病変を 2 つ測る（片方は 10mm 未満＝規則違反が出る状態にする）");
    await drawBidirectional(viewer, 6, 4, { fracX: 0.28, fracY: 0.5 });
    await drawBidirectional(viewer, 70, 24, { fracX: 0.55, fracY: 0.35 });
    await openPanel(viewer);
    const panel = await readPanel(viewer);
    console.log(JSON.stringify(panel, null, 2));
    await viewer.screenshot({ path: path.join(OUT_DIR, "1-panel.png") });
    check(panel.rows.length === 1, "タイムポイントが 1 件（ベースライン）", panel.rows.length);
    check(panel.lesionSizes.length === 2, "病変が 2 件測れている", panel.lesionSizes);
    check(panel.eligibility.length >= 1, "規則違反が画面に出ている（CSV へ載る対象がある）", panel.eligibility);

    console.log("\n[2] CSV ボタンを押して書き出しを捕まえる（実ダウンロードはしない）");
    await armDownloadTrap(viewer);
    await viewer.getByTestId("le-export-csv").click();
    await viewer.waitForTimeout(1200);
    const trap = await readTrap(viewer);
    check(!!trap, "CSV ボタンで書き出しが起きる", trap);
    if (!trap?.text) {
      failures.push("CSV の中身を取得できなかった");
      console.log(`  [FAIL] CSV の中身を取得できなかった — ${JSON.stringify(trap)}`);
    } else {
      const csv = trap.text;
      fs.writeFileSync(path.join(OUT_DIR, "report.csv"), csv);
      console.log(`  ファイル名: ${trap.filename}`);
      console.log(csv);

      check(/^recist-.*\.csv$/.test(trap.filename), "ファイル名に患者と時刻が入る", trap.filename);
      check(
        JSON.stringify(trap.head) === JSON.stringify([0xef, 0xbb, 0xbf]),
        "先頭に BOM が付く（Excel で日本語が化けない）",
        trap.head,
      );

      const body = csv.replace(/^﻿/, "");
      const blocks = sections(body);
      check(blocks.length === 3, "3 区画（メタ・タイムポイント・病変）", blocks.length);

      // **画面の数値と CSV の数値が一致する**（書き出し時に計算し直していない）。
      const tpRow = blocks[1].find((l) => l.startsWith("Baseline,"));
      const cells = (tpRow ?? "").split(",");
      check(cells[3] === panel.rows[0]?.sld, "SLD が画面と一致する", { csv: cells[3], panel: panel.rows[0]?.sld });
      check(cells[6] === panel.rows[0]?.response, "判定が画面と一致する", {
        csv: cells[6],
        panel: panel.rows[0]?.response,
      });
      check(cells[1] === panel.rows[0]?.date, "検査日が画面と一致する", { csv: cells[1], panel: panel.rows[0]?.date });

      const lesionLines = blocks[2].slice(1).filter((l) => l.trim().length > 0);
      const csvSizes = lesionLines.map((l) => l.split(",")[8]).sort();
      check(
        JSON.stringify(csvSizes) === JSON.stringify([...panel.lesionSizes].sort()),
        "病変のサイズが画面と一致する（件数・値とも）",
        { csv: csvSizes, panel: panel.lesionSizes },
      );

      // 警告・規則違反が紙にも載ること。
      const eligLines = blocks[0].filter((l) => l.startsWith("Eligibility,"));
      check(eligLines.length >= 1, "規則違反が CSV にも載る", eligLines);
      check(
        eligLines.some((l) => l.includes("測定可能病変の要件")),
        "規則違反の文面がそのまま載る",
        eligLines,
      );
      check(
        blocks[0].some((l) => l.startsWith("Plugin version,")),
        "どの版が計算したかが残る",
        blocks[0],
      );
    }

    await viewer.close().catch(() => {});
  } finally {
    await driver.stop();
  }

  console.log("\n=== 結果 ===");
  if (failures.length === 0) {
    console.log(`${passed} 項目すべて OK。出力: ${OUT_DIR}`);
  } else {
    console.log(`FAIL ${failures.length} 件:`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  }
}

await main();
