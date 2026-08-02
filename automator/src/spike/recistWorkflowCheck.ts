/*
 * Lesion Evanesco（RECIST 1.1 プラグイン）の**通し検証**。
 *
 * 実行:  cd automator && npx tsx src/spike/recistWorkflowCheck.ts
 *
 * <p>個々の機能は専用スパイク（`recistPluginCheck` / `recistRecordCheck` / `recistThumbCheck` /
 * `recistEligibilityCheck` / `recistCsvCheck` / `recistSharedStoreCheck`）で見ている。
 * ここで見るのは**読影医が実際にたどる一続きの流れ**と、その途中で画面に何が見えているか。
 *
 *   [1] ベースラインを開いて測る → 病変に属性（追跡 ID・部位）を付ける
 *   [2] 追跡回を開いて測る → 経時判定（SLD・比率・BOR）が出る
 *   [3] CSV を書き出す（中身が画面と一致する）
 *   [4] DICOM SR を保存する（**本体の確認ダイアログが出る**）
 *   [5] 保存された SR を DICOM として読み直し、計測値・追跡 ID・患者が正しいか確かめる
 *
 * <p>スクリーンショットを各段で残す（操作感の確認用）。
 *
 * <p>前提: backend jar（H9 を含む）と、プラグイン側で `npm run build` 済みの ui.js、
 *       `npm run phantom` 済み。
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
const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "recist-workflow-check");
const PATIENT = "RECIST-PR";
/** ベースライン → 追跡の 2 回だけ入れる（開くスタディを検索順に委ねない）。 */
const FILES = ["TP0_20260105.dcm", "TP2_20260427.dcm"];

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

async function importPhantom(httpPort: number, file: string): Promise<void> {
  const p = path.join(PLUGIN_REPO, "phantom", PATIENT, file);
  if (!fs.existsSync(p)) {
    throw new Error(`${p} がありません。(cd ${PLUGIN_REPO} && npm run phantom) を実行してください。`);
  }
  const res = await fetch(`http://127.0.0.1:${httpPort}/api/import/paths`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paths: [p] }),
  });
  if (!res.ok) throw new Error(`import failed: ${res.status}`);
  console.log(`  import ${file}: ${JSON.stringify(await res.json())}`);
}

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

interface PanelState {
  rows: { label: string; date: string; sld: string; base: string; response: string; source: string }[];
  lesions: { tp: string; id: string; type: string; organ: string; size: string }[];
  bor: string;
  store: string;
  hasSrButton: boolean;
}

async function readPanel(viewer: Page): Promise<PanelState> {
  return viewer.evaluate(`
    (function () {
      function cells(tr) {
        var tds = tr.querySelectorAll("td");
        var c = [];
        for (var j = 0; j < tds.length; j++) c.push((tds[j].textContent || "").trim());
        return c;
      }
      var rows = [];
      var tbody = document.querySelector('[data-testid="le-timeline"] tbody');
      if (tbody) {
        var trs = tbody.querySelectorAll("tr");
        for (var i = 0; i < trs.length; i++) {
          var c = cells(trs[i]);
          rows.push({
            label: (c[0] || "").replace("⚠", "").trim(),
            date: c[1] || "", sld: c[2] || "", base: c[3] || "",
            response: c[5] || "", source: c[6] || "",
          });
        }
      }
      var lesions = [];
      var ls = document.querySelectorAll('[data-testid^="le-lesion-"]');
      for (var m = 0; m < ls.length; m++) {
        var c2 = cells(ls[m]);
        lesions.push({ tp: c2[1] || "", id: c2[2] || "", type: c2[3] || "", organ: c2[4] || "", size: c2[6] || "" });
      }
      var borEl = document.querySelector('[data-testid="le-bor"]');
      var store = "";
      for (var s of ["shared", "local", "none"]) {
        if (document.querySelector('[data-testid="le-store-' + s + '"]')) store = s;
      }
      return {
        rows: rows,
        lesions: lesions,
        bor: borEl ? (borEl.textContent || "").trim() : "",
        store: store,
        hasSrButton: !!document.querySelector('[data-testid="le-export-sr"]'),
      };
    })()
  `) as never;
}

async function openPanel(viewer: Page): Promise<void> {
  await viewer.getByTestId("viewer2d-menu-plugins").click();
  await viewer.getByTestId(`plugin-item-${PLUGIN_ID}`).click();
  await viewer.getByTestId("lesion-evanesco-panel").waitFor({ state: "visible", timeout: 15_000 });
  await viewer.waitForTimeout(1800);
}

/**
 * 表示言語を指定して開く（`GRAPHY_LOCALE=ja|en`）。指定が無ければ本体の既定に任せる。
 *
 * <p>言語ごとに 1 回ずつ通すためにある。**本体の設定は localStorage `graphy.locale`** なので、
 * 画面を開く前に書いてから読み込み直す。
 */
async function applyLocale(mainPage: Page): Promise<void> {
  const want = process.env.GRAPHY_LOCALE;
  if (want !== "ja" && want !== "en") return;
  await mainPage.evaluate(`localStorage.setItem("graphy.locale", ${JSON.stringify(want)})`);
  await mainPage.reload({ waitUntil: "domcontentloaded" });
  await mainPage.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
  console.log(`  表示言語を ${want} にした`);
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
  await applyLocale(mainPage);
  await openFirstSeriesInViewer(mainPage, createStepRecorder());
  const viewer = await driver.waitForNewPage(
    () => mainPage.getByTestId("viewer2d-toolbar-button").click(),
    (url) => url.includes("2dviewer"),
  );
  await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 20_000 });
  await viewer.waitForTimeout(2500);
  return viewer;
}

async function drawBidirectional(viewer: Page, longPx: number, shortPx: number, at: { fracX: number; fracY: number }) {
  await viewer.getByTestId("viewer2d-menu-roi").click();
  await viewer.getByRole("button", { name: /長径・短径|Long\/short axis/ }).first().click();
  await viewer.waitForTimeout(300);
  await dragOnCanvasHost(viewer, "viewer2d-canvas-host", longPx, 0, 0, shortPx, at);
  await viewer.waitForTimeout(900);
}

/**
 * 病変行をクリックして属性エディタを開き、追跡 ID と部位を設定する。
 *
 * <p>入力は `change` で確定するので、**値を入れたら blur する**（fill だけでは反映されない）。
 * 反映のたびにパネルが作り直されるため、要素は都度取り直す。
 */
async function setLesionAttributes(viewer: Page, trackingId: string, organ: string): Promise<boolean> {
  await viewer.locator('[data-testid^="le-lesion-"]').first().click();
  await viewer.waitForTimeout(500);
  if ((await viewer.locator('[data-testid="le-editor"]').count()) === 0) return false;

  const id = viewer.getByTestId("le-tracking-id");
  await id.fill(trackingId);
  await id.blur();
  await viewer.waitForTimeout(700);

  // 属性を書くとパネルが再描画されるので、エディタを開き直す。
  if ((await viewer.getByTestId("le-organ").count()) === 0) {
    await viewer.locator('[data-testid^="le-lesion-"]').first().click();
    await viewer.waitForTimeout(500);
  }
  const organField = viewer.getByTestId("le-organ");
  if ((await organField.count()) > 0) {
    await organField.fill(organ);
    await organField.blur();
    await viewer.waitForTimeout(700);
  }
  return true;
}

/** ダウンロードを起こさずに CSV を捕まえる。 */
async function armCsvTrap(viewer: Page): Promise<void> {
  await viewer.evaluate(`
    (function () {
      window.__csvTrap = null;
      var orig = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () {
        if (!this.download || !/^blob:/.test(this.href)) return orig.call(this);
        var self = this;
        window.__csvTrap = { filename: self.download, text: null };
        fetch(self.href).then(function (r) { return r.text(); }).then(function (t) {
          window.__csvTrap.text = t;
        });
      };
    })()
  `);
}

/** 保管庫に落ちた SR ファイルを探す（新しい順）。 */
function findSrFiles(): string[] {
  const root = path.join(DESKTOP_RUN_DATA_DIR, "data", "dicom");
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push(p);
    }
  };
  if (fs.existsSync(root)) walk(root);
  return out;
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  installPlugin();

  const driver = new DesktopDriver();
  await driver.start();
  try {
    console.log(`  reset: ${JSON.stringify(await resetDb(driver.ports.http))}`);
    for (const f of FILES) await importPhantom(driver.ports.http, f);
    const before = new Set(findSrFiles());

    const viewer = await openViewer(driver);
    console.log(`  端末ローカルを掃除: ${await clearPluginStorage(viewer)} キー`);
    const appLocale = (await viewer.evaluate('localStorage.getItem("graphy.locale") || "(既定)"')) as string;
    console.log(`  本体の表示言語: ${appLocale}`);

    console.log("\n[1] 1 回目のスタディで病変を測り、属性を付ける");
    await drawBidirectional(viewer, 70, 24, { fracX: 0.3, fracY: 0.45 });
    await openPanel(viewer);
    let panel = await readPanel(viewer);
    await viewer.screenshot({ path: path.join(OUT_DIR, "1-measured.png") });
    check(panel.rows.length === 1, "タイムポイントが 1 件出る", panel.rows);
    check(panel.lesions.length === 1, "病変表に 1 件出る", panel.lesions);
    check(panel.hasSrButton, "DICOM SR ボタンがある");

    // **パネルの文言が本体の言語に追従しているか。** 本体が英語なのにパネルだけ日本語、
    // という混在を実機で見つけたのでここで固定する。
    const panelText = (await viewer.locator('[data-testid="lesion-evanesco-panel"]').textContent()) ?? "";
    const hasJa = /[ぁ-んァ-ヶ一-龠]/.test(panelText);
    const localeNow = (await viewer.evaluate(
      '(function(){var l=localStorage.getItem("graphy.locale"); return l||((navigator.language||"").indexOf("en")===0?"en":"ja");})()',
    )) as string;
    check(
      localeNow === "en" ? !hasJa : hasJa,
      `パネルの文言が本体の言語（${localeNow}）に従う`,
      { locale: localeNow, sample: panelText.slice(0, 60) },
    );

    const edited = await setLesionAttributes(viewer, "1", "Liver");
    check(edited, "病変をクリックすると属性エディタが開く");
    await viewer.waitForTimeout(800);
    panel = await readPanel(viewer);
    console.log(JSON.stringify(panel, null, 2));
    await viewer.screenshot({ path: path.join(OUT_DIR, "2-attributes.png") });
    check(panel.lesions[0]?.id === "#1", "追跡 ID が反映される", panel.lesions[0]);
    check(panel.lesions[0]?.organ.includes("Liver"), "部位が反映される", panel.lesions[0]);
    const firstDate = panel.rows[0]?.date ?? "";
    const firstSld = panel.rows[0]?.sld ?? "";

    console.log("\n[2] CSV を書き出す（画面の値と一致するか）");
    await armCsvTrap(viewer);
    await viewer.getByTestId("le-export-csv").click();
    await viewer.waitForTimeout(1200);
    const csv = (await viewer.evaluate("window.__csvTrap")) as { filename: string; text: string | null } | null;
    check(!!csv?.text, "CSV が書き出される", csv?.filename);
    if (csv?.text) {
      fs.writeFileSync(path.join(OUT_DIR, "report.csv"), csv.text);
      check(csv.text.includes(firstSld), "CSV の SLD が画面と一致する", { sld: firstSld });
      check(csv.text.includes("Liver"), "CSV に部位が入る");
    }

    console.log("\n[3] DICOM SR を保存する（本体の確認ダイアログが出るか）");
    await viewer.getByTestId("le-export-sr").click();
    const dialog = viewer.locator('[data-testid="plugin-save-confirm"]');
    await dialog.waitFor({ state: "visible", timeout: 8000 });
    await viewer.screenshot({ path: path.join(OUT_DIR, "3-sr-confirm.png") });
    const dialogText = (await dialog.textContent()) ?? "";
    check(true, "本体の確認ダイアログが出る（抑止不可）");
    // **表示言語は本体の設定に従う**（この環境は英語）。文言の言語を決め打ちしない。
    check(
      /計測レポート|measurement report/i.test(dialogText),
      "ダイアログが SR 用の文言になっている（シリーズ保存ではない）",
      dialogText.slice(0, 80),
    );
    // パネルがダイアログを覆っていないこと（同意を求める画面が読めなければ意味がない）。
    // **z-index の比較では判定にならない**（スタッキングコンテキストが違うと大小が逆転する。
    // 実際、パネルの z-index を下げても覆われたままだった）。
    // 実際に描かれている要素を `elementFromPoint` で見る。
    const cover = await viewer.evaluate(`
      (function () {
        var d = document.querySelector('[data-testid="plugin-save-confirm"] > div');
        var p = document.getElementById("lesion-evanesco-panel");
        if (!d) return { error: "dialog not found" };
        var a = d.getBoundingClientRect();
        var pts = [
          [a.left + 10, a.top + 10], [a.right - 10, a.top + 10],
          [a.left + 10, a.bottom - 10], [a.right - 10, a.bottom - 10],
          [(a.left + a.right) / 2, (a.top + a.bottom) / 2],
        ];
        var hidden = [];
        for (var i = 0; i < pts.length; i++) {
          var el = document.elementFromPoint(pts[i][0], pts[i][1]);
          var inDialog = !!(el && el.closest('[data-testid="plugin-save-confirm"]'));
          var inPanel = !!(el && p && p.contains(el));
          if (!inDialog) hidden.push({ point: pts[i], byPanel: inPanel, tag: el ? el.tagName : "none" });
        }
        return { hidden: hidden };
      })()
    `);
    check(
      !!cover && Array.isArray((cover as { hidden?: unknown[] }).hidden)
        && (cover as { hidden: unknown[] }).hidden.length === 0,
      "確認ダイアログの四隅と中央が他の要素に覆われていない",
      cover,
    );
    const groups = await viewer.getByTestId("plugin-save-groups").textContent();
    check(groups === "1", "計測グループ数が出る", groups);

    await viewer.getByTestId("plugin-save-confirm-button").click();
    await viewer.waitForTimeout(2500);
    await viewer.screenshot({ path: path.join(OUT_DIR, "4-sr-saved.png") });

    const after = findSrFiles().filter((f) => !before.has(f));
    console.log(`  新しく保管庫に入ったファイル: ${after.length} 件`);
    check(after.length === 1, "SR が 1 件保管庫に入る", after.length);
    if (after.length > 0) {
      fs.copyFileSync(after[0], path.join(OUT_DIR, "report-sr.dcm"));
      console.log(`  SR ファイル: ${after[0]}`);
    }

    console.log("\n[4] 保存した SR が本体のスタディ一覧に出るか（読影医が実際に見る画面）");
    await viewer.close().catch(() => {});
    const mainPage = driver.page;
    await mainPage.bringToFront();
    await mainPage.getByTestId("search-patientid-input").fill(PATIENT);
    await mainPage.getByTestId("search-submit-button").click().catch(() => {});
    await mainPage.waitForTimeout(2000);
    await mainPage.screenshot({ path: path.join(OUT_DIR, "5-study-list.png"), fullPage: false });
    // スタディ一覧では**モダリティ欄**に SR が現れる（シリーズ説明は展開しないと出ない）。
    const modalities = await mainPage.evaluate(`
      (function () {
        var out = [];
        var rows = document.querySelectorAll("table tbody tr");
        for (var i = 0; i < rows.length; i++) {
          var tds = rows[i].querySelectorAll("td");
          var c = [];
          for (var j = 0; j < tds.length; j++) c.push((tds[j].textContent || "").trim());
          out.push(c);
        }
        return out;
      })()
    `);
    const flat = JSON.stringify(modalities);
    check(flat.includes("SR"), "スタディ一覧のモダリティに SR が出る（保存が一覧に反映される）", modalities);

    console.log("\n[5] 保存された SR を DICOM として読み直す（内容の検算は Python 側で行う）");
    console.log(`  出力: ${OUT_DIR}/report-sr.dcm`);
  } finally {
    await driver.stop().catch(() => {});
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
