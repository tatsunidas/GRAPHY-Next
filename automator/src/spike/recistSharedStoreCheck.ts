/*
 * Lesion Evanesco（RECIST 1.1 プラグイン）の**評価記録の共有**（host API H8）の実機検証。
 *
 * 実行:  cd automator && npx tsx src/spike/recistSharedStoreCheck.ts
 *
 * <p><b>何を確かめるか</b>: 記録が端末（localStorage）ではなく**本体の保存領域**に入り、
 * 別の PC で開いても過去の回が見えること。単体テストでは host が作り物なので、
 * 実機で確かめるべきは配線と往復である。
 *
 *   1. 計測すると `/api/plugin-store/lesion-evanesco/{patientKey}` に記録が入る
 *   2. **localStorage を消しても記録が残る**（＝別の PC で開いた状態の再現）
 *   3. アプリを再起動しても残る
 *   4. 「記録を消す」でサーバ側からも消える
 *
 * <p><b>別 PC の再現方法</b>: 端末ローカルの痕跡（`lesion-evanesco.*`）を消してから
 * パネルを開き直す。これで「この端末には何も無いが、サーバには記録がある」状態になる。
 * 記録がサーバに無ければ表は空になるので、**localStorage に頼っていたら必ず落ちる**。
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
const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "recist-shared-store-check");
const PATIENT = "RECIST-PR";
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
 * backend の保存領域を直接覗く（画面の表示と保管の実体を突き合わせる）。
 *
 * <p>**応答が 2xx でなければ落とす。** エラー本文（Spring の `{timestamp,status,...}`）を
 * そのまま読むと `json` が `undefined` になり、「保存はされているが 0 件」に見えてしまう。
 * 実際、H8 を持たない古い jar で検証してしまい、原因の切り分けに時間を取られた。
 */
async function storeDoc(httpPort: number): Promise<{ json: string | null; version: number | null }> {
  const url = `http://127.0.0.1:${httpPort}/api/plugin-store/${PLUGIN_ID}/${encodeURIComponent(PATIENT)}`;
  const res = await fetch(url);
  const body = await res.text();
  if (!res.ok) {
    throw new Error(
      `保存領域を読めません: HTTP ${res.status} ${url}\n${body.slice(0, 300)}\n` +
        `backend jar が H8 より古い可能性があります` +
        `（cd backend && mvn -q -Dfrontend.skip=true -DskipTests clean package）。`,
    );
  }
  const dto = JSON.parse(body) as { json?: string | null; version?: number | null };
  if (!("json" in dto)) throw new Error(`保存領域の応答が想定と違います: ${body.slice(0, 300)}`);
  return { json: dto.json ?? null, version: dto.version ?? null };
}

function timepointCount(json: string | null): number {
  if (!json) return 0;
  try {
    const root = JSON.parse(json) as { record?: { timepoints?: unknown[] } };
    return root.record?.timepoints?.length ?? 0;
  } catch {
    return -1;
  }
}

/** 端末ローカルの痕跡を消す（＝別の PC で開いた状態にする）。 */
async function wipeLocalStorage(viewer: Page): Promise<number> {
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

/** パネルの表と保存先バッジを読む。 */
async function readPanel(viewer: Page): Promise<{
  rows: { label: string; sld: string }[];
  /** 保存先（shared / local / none）。 */
  store: string;
  record: string;
}> {
  return viewer.evaluate(`
    (function () {
      var rows = [];
      var tbody = document.querySelector('[data-testid="le-timeline"] tbody');
      if (tbody) {
        var trs = tbody.querySelectorAll("tr");
        for (var i = 0; i < trs.length; i++) {
          var tds = trs[i].querySelectorAll("td");
          rows.push({
            label: ((tds[0] || {}).textContent || "").replace("⚠", "").trim(),
            sld: ((tds[2] || {}).textContent || "").trim(),
          });
        }
      }
      var store = "";
      for (var s of ["shared", "local", "none"]) {
        if (document.querySelector('[data-testid="le-store-' + s + '"]')) store = s;
      }
      var rec = document.querySelector('[data-testid="le-record"]');
      return { rows: rows, store: store, record: rec ? (rec.textContent || "").trim() : "" };
    })()
  `) as never;
}

async function openPanel(viewer: Page): Promise<void> {
  await viewer.getByTestId("viewer2d-menu-plugins").click();
  await viewer.getByTestId(`plugin-item-${PLUGIN_ID}`).click();
  await viewer.getByTestId("lesion-evanesco-panel").waitFor({ state: "visible", timeout: 15_000 });
  // 保存領域の読み込み（非同期）が終わるのを待つ。
  await viewer.waitForTimeout(1500);
}

async function closePanel(viewer: Page): Promise<void> {
  await viewer.evaluate(`
    (function () {
      var p = document.getElementById("lesion-evanesco-panel");
      if (p) p.remove();
    })()
  `);
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

async function drawBidirectional(viewer: Page): Promise<void> {
  await viewer.getByTestId("viewer2d-menu-roi").click();
  await viewer.getByRole("button", { name: /長径・短径|Long\/short axis/ }).first().click();
  await viewer.waitForTimeout(300);
  await dragOnCanvasHost(viewer, "viewer2d-canvas-host", 70, 0, 0, 24, { fracX: 0.28, fracY: 0.5 });
  await viewer.waitForTimeout(900);
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  installPlugin();

  let sldFirst = "";
  const d1 = new DesktopDriver();
  await d1.start();
  try {
    console.log(`  reset: ${JSON.stringify(await resetDb(d1.ports.http))}`);
    await importPhantom(d1.ports.http);
    const viewer = await openViewerForPatient(d1);
    console.log(`  端末ローカルを掃除: ${await wipeLocalStorage(viewer)} キー`);

    console.log("\n[1] 計測して、記録が backend の保存領域に入るか");
    await drawBidirectional(viewer);
    await openPanel(viewer);
    let panel = await readPanel(viewer);
    console.log(JSON.stringify(panel, null, 2));
    await viewer.screenshot({ path: path.join(OUT_DIR, "1-measured.png") });

    check(panel.rows.length === 1, "タイムポイントが 1 件出る", panel.rows);
    check(panel.store === "shared", "保存先バッジが「共有」", panel.store);
    sldFirst = panel.rows[0]?.sld ?? "";

    // 自動保存（デバウンス）を待ってから backend を覗く。
    await viewer.waitForTimeout(2500);
    const doc = await storeDoc(d1.ports.http);
    console.log(`  保存領域: version=${doc.version} timepoints=${timepointCount(doc.json)}`);
    console.log(`  保存領域の中身(先頭 600 文字): ${(doc.json ?? "").slice(0, 600)}`);
    check(doc.json !== null && doc.version !== null, "backend の保存領域に記録がある", doc);
    check(timepointCount(doc.json) === 1, "記録に 1 回分入っている", timepointCount(doc.json));

    console.log("\n[2] 端末ローカルを消して開き直す（＝別の PC で開いた状態）");
    const wiped = await wipeLocalStorage(viewer);
    console.log(`  消したキー: ${wiped}`);
    await closePanel(viewer);
    await openPanel(viewer);
    panel = await readPanel(viewer);
    console.log(JSON.stringify(panel, null, 2));
    await viewer.screenshot({ path: path.join(OUT_DIR, "2-after-wipe.png") });

    check(panel.rows.length === 1, "端末ローカルを消しても過去の回が見える", panel.rows);
    check(panel.rows[0]?.sld === sldFirst, "SLD が同じ（記録から復元できている）", {
      before: sldFirst,
      after: panel.rows[0]?.sld,
    });
    check(panel.store === "shared", "保存先は引き続き「共有」", panel.store);

    await viewer.close().catch(() => {});
  } finally {
    await d1.stop();
  }

  console.log("\n[3] アプリを再起動しても残るか");
  const d2 = new DesktopDriver();
  await d2.start();
  try {
    const doc = await storeDoc(d2.ports.http);
    check(timepointCount(doc.json) === 1, "再起動後も backend に記録が残っている", timepointCount(doc.json));

    const viewer = await openViewerForPatient(d2);
    await wipeLocalStorage(viewer);
    await openPanel(viewer);
    const panel = await readPanel(viewer);
    console.log(JSON.stringify(panel, null, 2));
    await viewer.screenshot({ path: path.join(OUT_DIR, "3-restart.png") });
    check(panel.rows.length >= 1, "再起動＋端末ローカル無しでも記録から表が出る", panel.rows);

    console.log("\n[4] 「記録を消す」でサーバ側からも消えるか");
    const before = await storeDoc(d2.ports.http);
    // 確認ダイアログは native。**出す前に握り潰す**（出た瞬間に自動操作が固まるため）。
    await viewer.evaluate("window.confirm = function () { return true; }");
    await viewer.getByTestId("le-clear-record").click();
    await viewer.waitForTimeout(3000);
    const after = await storeDoc(d2.ports.http);
    console.log(`  消去前: version=${before.version} / 消去後: version=${after.version} timepoints=${timepointCount(after.json)}`);
    // **「0 件になる」ではない。** 開いている回は画面の ROI から作り直されるので、
    // 消した直後に 1 件へ戻るのが仕様どおり（消えるのは開いていない回の記録）。
    // 実際に消えたことは**版が振り直される**ことで確かめる（削除→新規作成で 0 に戻る）。
    check(
      after.json === null || (after.version !== null && before.version !== null && after.version < before.version),
      "サーバ側の記録が実際に削除される（版が振り直される）",
      { before: before.version, after: after.version },
    );
    check(
      timepointCount(after.json) <= 1,
      "残るのは画面から作り直された回だけ（開いていない回の記録は消える）",
      timepointCount(after.json),
    );

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
