/*
 * ハンギングプロトコルの「適用」「元に戻す」・保存と管理・書き出し／取り込み・自動適用を実アプリで測るスパイク。
 *
 * 実行（本番の設定には触れない専用ポート。表示の無い環境では xvfb-run を付ける）:
 *   cd automator
 *   GRAPHY_AUTOMATOR_HTTP_PORT=18290 GRAPHY_AUTOMATOR_SCP_PORT=18291 GRAPHY_AUTOMATOR_VITE_PORT=18293 \
 *     timeout 300 npx tsx src/spike/hangingProtocolCheck.ts
 *
 * 合成データ（tileSoloSynth.py。1 検査・4 シリーズ「synthetic 1〜4」）と、その患者を差し替えた 2 人目を使う。
 * 期待する並びはプロトコルのスロットの順（手で決めた値）で、実装の並べ替えの規則は写さない。
 *
 * 前提: backend jar（`cd backend && mvn -q -Dfrontend.skip=true -DskipTests package`）、
 *       `desktop` と `automator` で `npm ci` 済み。
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { Locator, Page } from "@playwright/test";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { openFirstSeriesInViewer, selectFirstStudy } from "../checklist/items/shared/helpers.js";
import { createStepRecorder } from "../checklist/types.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "hanging-protocol");

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

function python(args: string[]): void {
  const r = spawnSync("python3", ["-I", ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`合成データを作れません: ${r.stderr}`);
}

/** 2 人目: 同じ模様で、患者・検査・シリーズ・インスタンスの UID を差し替える。 */
const SECOND_PATIENT = `
import os, sys, pydicom
from pydicom.uid import generate_uid
src, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)
study, series = generate_uid(), {}
for f in sorted(os.listdir(src)):
    if not f.startswith("s1_"):
        continue
    ds = pydicom.dcmread(os.path.join(src, f))
    ds.PatientID, ds.PatientName = "HANGING2", "HANGING2^SYNTH"
    ds.StudyDescription = "second patient"
    ds.StudyInstanceUID = ds.FrameOfReferenceUID = study
    ds.SeriesInstanceUID = series.setdefault(ds.SeriesInstanceUID, generate_uid())
    ds.SOPInstanceUID = ds.file_meta.MediaStorageSOPInstanceUID = generate_uid()
    ds.save_as(os.path.join(out, f))
`;

const tiles = (page: Page): Locator => page.locator("[data-tile-id]");
const grid = (page: Page): Locator => page.getByTestId("viewer2d-tile-grid");

/** タイルの並びを、ID の末尾（シリーズ UID）で返す。 */
async function tileSeries(page: Page): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < (await tiles(page).count()); i++) {
    out.push((await tiles(page).nth(i).getAttribute("data-tile-id"))!.split("|")[1]);
  }
  return out;
}

async function gridShape(page: Page): Promise<string> {
  return `${await grid(page).getAttribute("data-grid-rows")}x${await grid(page).getAttribute("data-grid-cols")}`;
}

/** 画面上の左→右の順（DOM の順だけでなく、見えている位置でも確かめる）。 */
async function lefts(page: Page): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < (await tiles(page).count()); i++) out.push(Math.round((await tiles(page).nth(i).boundingBox())!.x));
  return out;
}

async function openLayoutMenu(page: Page): Promise<void> {
  await page.getByTestId("viewer2d-menu-view").click();
  await page.getByTestId("viewer2d-menu-layout").click();
  await page.getByTestId("layout-hanging-apply").waitFor({ state: "visible", timeout: 10_000 });
}

async function undoDisabled(page: Page): Promise<boolean> {
  await openLayoutMenu(page);
  const disabled = await page.getByTestId("layout-hanging-undo").isDisabled();
  await page.getByTestId("viewer2d-menu-view").click();
  await page.waitForTimeout(300);
  return disabled;
}

async function clickUndo(page: Page): Promise<void> {
  await openLayoutMenu(page);
  await page.getByTestId("layout-hanging-undo").click();
  await page.waitForTimeout(2500);
}

const protocol = (nums: number[], rows: number, cols: number, extra: object = {}): string =>
  JSON.stringify({
    id: "spike", name: "spike protocol", version: 1, match: { modality: ["CT"] },
    slots: nums.map((n) => ({ series: { descriptionContains: `synthetic ${n}` } })),
    grid: { rows, cols }, ...extra,
  }, null, 2);

async function checkProtocol(page: Page, json: string): Promise<void> {
  await openLayoutMenu(page);
  await page.getByTestId("layout-hanging-apply").click();
  await page.getByTestId("hanging-apply-dialog").waitFor({ state: "visible", timeout: 10_000 });
  await page.getByTestId("hanging-json").fill(json);
  await page.getByTestId("hanging-check").click();
  await page.waitForTimeout(1500);
}

const dialogText = (page: Page): Promise<string> => page.getByTestId("hanging-apply-dialog").innerText();

/** 画像領域に中身があること（明るさの異なる画素の割合）。真っ黒のタイルを「並んだ」と数えないため。 */
async function litRatio(page: Page, i: number): Promise<number> {
  const buf = await tiles(page).nth(i).getByTestId("viewer2d-canvas-host").first().screenshot();
  const expr = `(async () => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = "data:image/png;base64,${buf.toString("base64")}"; });
    const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
    const ctx = c.getContext("2d"); ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, img.width, img.height).data;
    let n = 0; for (let k = 0; k < d.length; k += 4) if (d[k] > 60) n++;
    return n / (d.length / 4);
  })()`;
  return (await page.evaluate(expr)) as number;
}

async function openViewerWindow(driver: DesktopDriver, trigger: () => Promise<unknown>): Promise<Page> {
  const page = await driver.waitForNewPage(async () => { await trigger(); }, (url) => url.includes("2dviewer"));
  page.on("console", (m) => {
    if (m.type() === "error") console.log(`  [viewer error] ${m.text()}`);
  });
  await page.waitForTimeout(1500);
  await driver.app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (w.webContents.getURL().includes("2dviewer")) w.setBounds({ x: 0, y: 0, width: 1700, height: 1000 });
    }
  });
  await page.waitForTimeout(4000);
  return page;
}

async function closeViewerWindow(driver: DesktopDriver, page: Page): Promise<void> {
  const closed = page.waitForEvent("close");
  await driver.app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) if (w.webContents.getURL().includes("2dviewer")) w.close();
  });
  await closed;
}

/** メイン画面で検査（シリーズなし）または検査とシリーズを書いて、2D ビューアを開く。MainScreen と同じ受け渡し。 */
async function openWithContext(driver: DesktopDriver, mainPage: Page, ctx: object): Promise<Page> {
  await mainPage.evaluate((c) => localStorage.setItem("graphy-viewer-ctx", JSON.stringify(c)), { ...ctx, ts: Date.now() });
  return openViewerWindow(driver, () => mainPage.evaluate("window.graphyDesktop.openViewer('2dviewer')"));
}

async function openManage(page: Page): Promise<void> {
  await openLayoutMenu(page);
  await page.getByTestId("layout-hanging-manage").click();
  await page.getByTestId("hanging-manage-dialog").waitFor({ state: "visible", timeout: 10_000 });
  await page.waitForTimeout(800);
}

const manageIds = (page: Page): Promise<(string | null)[]> =>
  page.getByTestId("hanging-manage-row").evaluateAll((els) => els.map((e) => e.getAttribute("data-protocol-id")));

async function run(): Promise<void> {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const dir = path.join(OUT_DIR, "synth");
  const dir2 = path.join(OUT_DIR, "synth2");
  python([path.join(import.meta.dirname, "tileSoloSynth.py"), dir]);
  python(["-c", SECOND_PATIENT, dir, dir2]);

  const driver = new DesktopDriver();
  const recorder = createStepRecorder();
  await driver.start();
  try {
    await resetDb(driver.ports.http);
    const imp = await importPaths(driver.ports.http, [dir]);
    check(imp.imported === 64 && imp.failed === 0, "1 人目を取り込めた（64 枚）", imp);

    const api = async (p: string): Promise<any> => {
      const r = await fetch(`http://localhost:${driver.ports.http}${p}`);
      if (!r.ok) throw new Error(`${p}: ${r.status}`);
      return r.json();
    };

    // 前の実行の保存と設定を消し、既定（保存なし・自動適用は未設定と同じ）から始める。
    const putSettings = async (u: Record<string, string>): Promise<void> => {
      const r = await fetch(`http://localhost:${driver.ports.http}/api/settings`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(u),
      });
      if (!r.ok) throw new Error(`PUT /api/settings: ${r.status}`);
    };
    const left = Object.keys(await api("/api/settings")).filter((k) => k.startsWith("hanging.protocol."));
    await putSettings({ ...Object.fromEntries(left.map((k) => [k, ""])), "viewer.hangingAutoApply": "" });

    let mainPage = driver.page;
    await mainPage.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 30_000 });
    await openFirstSeriesInViewer(mainPage, recorder);
    let page = await driver.waitForNewPage(
      () => mainPage.getByTestId("viewer2d-toolbar-button").click(),
      (url) => url.includes("2dviewer"),
    );
    page.on("console", (m) => {
      if (m.type() === "error") console.log(`  [viewer error] ${m.text()}`);
    });
    await page.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 15_000 });
    await driver.app.evaluate(({ BrowserWindow }) => {
      for (const w of BrowserWindow.getAllWindows()) {
        if (w.webContents.getURL().includes("2dviewer")) w.setBounds({ x: 0, y: 0, width: 1700, height: 1000 });
      }
    });
    await page.waitForTimeout(2500);

    const studyUid = (await tiles(page).first().getAttribute("data-tile-id"))!.split("|")[0];
    const list: { seriesInstanceUid: string; seriesDescription: string }[] = await api(`/api/studies/${studyUid}/series`);
    const uid = (n: number): string => list.find((s) => s.seriesDescription === `synthetic ${n}`)!.seriesInstanceUid;
    check(list.length === 4, "検査のシリーズは 4 本", list.length);

    console.log("\n[0] 既定のまま: 何もしなければ 1 枚のまま。元に戻すは押せない");
    const start = await tileSeries(page);
    const startShape = await gridShape(page);
    check(start.length === 1 && start[0] === uid(1), "開いた直後は synthetic 1 の 1 枚", start);
    check(await undoDisabled(page), "適用前は「元に戻す」が無効");

    console.log("\n[1] 壊れた入力は理由を出し、適用できない");
    await checkProtocol(page, '{"id":"x","name":"x","version":2,"slots":[]}');
    check((await page.getByTestId("hanging-errors").innerText()).includes("version"), "理由に version が出る");
    check(await page.getByTestId("hanging-apply").isDisabled(), "適用は無効");
    await page.getByTestId("hanging-cancel").click();

    console.log("\n[2] 確認してキャンセル → 何も変わらない");
    await checkProtocol(page, protocol([3, 1], 1, 2));
    const preview = await dialogText(page);
    check(!preview.includes("{{") && !preview.includes("viewer2d."), "文言に差し込み漏れ・訳の抜けが無い", preview);
    const order = await page.getByTestId("hanging-preview-series").evaluateAll((els) => els.map((e) => e.getAttribute("data-series-uid")));
    check(JSON.stringify(order) === JSON.stringify([uid(3), uid(1)]), "プレビューの順は 3 → 1", order);
    await page.screenshot({ path: path.join(OUT_DIR, "2-preview.png") });
    await page.getByTestId("hanging-cancel").click();
    await page.waitForTimeout(800);
    check(JSON.stringify(await tileSeries(page)) === JSON.stringify(start) && (await gridShape(page)) === startShape, "タイルと行×列は変わらない");
    check(await undoDisabled(page), "キャンセルの後も「元に戻す」は無効");

    for (const mode of ["global", "tabs"] as const) {
      console.log(`\n[3-${mode}] 適用 → 元に戻す`);
      await page.getByTestId(`viewer2d-mode-${mode}`).click();
      await page.waitForTimeout(1000);
      const before = await tileSeries(page);
      const beforeShape = await gridShape(page);
      await checkProtocol(page, protocol([3, 1], 1, 2));
      await page.getByTestId("hanging-apply").click();
      await page.waitForTimeout(4000);
      const after = await tileSeries(page);
      check(JSON.stringify(after) === JSON.stringify([uid(3), uid(1)]), "タイルの順は 3 → 1（開いていた 1 も新しい順に従う）", after);
      check((await gridShape(page)) === "1x2", "行×列は 1x2", await gridShape(page));
      const xs = await lefts(page);
      check(xs.length === 2 && xs[0] < xs[1], "画面上も左右に並ぶ", xs);
      check((await tiles(page).nth(0).innerText()).includes("synthetic 3"), "左のタイルの見出しは synthetic 3");
      const lit = [await litRatio(page, 0), await litRatio(page, 1)];
      check(lit.every((r) => r > 0.02), "両方のタイルに画像が写っている", lit);
      await page.screenshot({ path: path.join(OUT_DIR, `3-${mode}-applied.png`) });

      await clickUndo(page);
      check(JSON.stringify(await tileSeries(page)) === JSON.stringify(before), "元に戻すで直前のタイルに戻る", { before, now: await tileSeries(page) });
      check((await gridShape(page)) === beforeShape, "行×列も直前に戻る", { beforeShape, now: await gridShape(page) });
      check((await litRatio(page, 0)) > 0.02, "戻したタイルに画像が写っている");
      await page.screenshot({ path: path.join(OUT_DIR, `3-${mode}-undone.png`) });
      check(await undoDisabled(page), "戻せるのは 1 世代だけ");
    }

    console.log("\n[4] 条件に合わない・並ぶものが無い");
    await checkProtocol(page, protocol([1], 1, 1, { match: { modality: ["MR"] } }));
    check((await page.getByTestId("hanging-reject").count()) === 1 && (await page.getByTestId("hanging-apply").isDisabled()), "match に合わなければ適用できない");
    await page.getByTestId("hanging-cancel").click();
    await checkProtocol(page, protocol([9], 1, 1));
    check((await page.getByTestId("hanging-reject").count()) === 1 && (await page.getByTestId("hanging-apply").isDisabled()), "合うシリーズが無ければ適用できない");
    await page.getByTestId("hanging-cancel").click();

    console.log("\n[5] 全患者の表示に 2 人いるときは断る。患者タブなら表示中の患者だけが置き換わる");
    await page.getByTestId("viewer2d-mode-global").click();
    const imp2 = await importPaths(driver.ports.http, [dir2]);
    check(imp2.imported === 16 && imp2.failed === 0, "2 人目を取り込めた（16 枚）", imp2);
    const study2 = (await api("/api/studies")).find((s: any) => s.patientId === "HANGING2");
    const series2 = (await api(`/api/studies/${study2.studyInstanceUid}/series`))[0];
    await mainPage.evaluate((ctx) => localStorage.setItem("graphy-viewer-ctx", JSON.stringify(ctx)), { study: study2, series: series2, ts: Date.now() });
    await page.waitForTimeout(3000);
    const both = await tileSeries(page);
    check(both.length === 2 && both.includes(series2.seriesInstanceUid), "2 人分のタイルがある（この検査の前提）", both);
    await openLayoutMenu(page);
    await page.getByTestId("layout-hanging-apply").click();
    await page.waitForTimeout(500);
    check((await page.getByTestId("hanging-apply-dialog").count()) === 0, "ダイアログは開かない");
    check((await page.locator("body").innerText()).includes("患者タブに切り替えてから") || (await page.locator("body").innerText()).includes("Switch to patient tabs"), "理由の通知が出る");
    await page.getByTestId("viewer2d-mode-tabs").click();
    await page.waitForTimeout(1500);
    // 直前に追加した 2 人目のタブが選ばれている。
    check(JSON.stringify(await tileSeries(page)) === JSON.stringify([series2.seriesInstanceUid]), "2 人目のタブが表示されている", await tileSeries(page));
    await checkProtocol(page, protocol([1], 1, 1));
    await page.getByTestId("hanging-apply").click();
    await page.waitForTimeout(3000);
    await page.getByTestId("viewer2d-mode-global").click();
    await page.waitForTimeout(2000);
    const afterTab = await tileSeries(page);
    check(afterTab.includes(uid(1)) && afterTab.includes(series2.seriesInstanceUid) && afterTab.length === 2, "他の患者のタイルは消えない", afterTab);

    const settingsOf = async (): Promise<Record<string, string>> => api("/api/settings");
    const study1 = (await api("/api/studies")).find((s: any) => s.patientId === "TILESOLO");
    const series1 = list.find((s) => s.seriesDescription === "synthetic 1")!;

    console.log("\n[6] 保存・書き出し・削除・取り込み");
    await closeViewerWindow(driver, page);
    page = await openWithContext(driver, mainPage, { study: study1, series: series1 });
    check((await tiles(page).count()) === 1, "シリーズを指定して開くと 1 枚", await tiles(page).count());
    await openManage(page);
    check((await manageIds(page)).length === 0, "保存は 0 件から始まる（この検査の前提）", await manageIds(page));
    check(!(await page.getByTestId("hanging-auto").isChecked()), "自動適用は既定で切");
    await page.getByTestId("hanging-new").click();
    await page.getByTestId("hanging-editor").fill(protocol([3, 1], 1, 2, { note: "keep-me" }));
    await page.getByTestId("hanging-save").click();
    await page.waitForTimeout(1500);
    check(JSON.stringify(await manageIds(page)) === JSON.stringify(["spike"]), "新規で保存すると一覧に出る", await manageIds(page));
    const savedValue = (await settingsOf())["hanging.protocol.spike"];
    check(!!savedValue && JSON.parse(savedValue).note === "keep-me", "設定に 1 件 1 キーで入り、知らないキーも残る", savedValue);
    await page.screenshot({ path: path.join(OUT_DIR, "6-manage.png") });
    // 書き出し: ダウンロードされる中身を、押す直前に横取りして読む。
    await page.evaluate(`(() => {
      window.__exported = null;
      HTMLAnchorElement.prototype.click = function () { const href = this.href, name = this.download;
        window.__exported = fetch(href).then((r) => r.text()).then((text) => ({ name, text })); };
    })()`);
    await page.getByTestId("hanging-export").click();
    await page.waitForTimeout(1500);
    const exported = (await page.evaluate("window.__exported")) as { name: string; text: string } | null;
    check(!!exported && exported.name === "hanging-protocols.json", "書き出しのファイル名", exported?.name);
    await page.getByTestId("hanging-delete").click();
    await page.getByTestId("hanging-delete-yes").click();
    await page.waitForTimeout(1500);
    check((await manageIds(page)).length === 0 && (await settingsOf())["hanging.protocol.spike"] === "", "削除で一覧から消え、値は空になる");
    const file = path.join(OUT_DIR, "exported.json");
    fs.writeFileSync(file, exported?.text ?? "");
    await page.getByTestId("hanging-import-file").setInputFiles(file);
    await page.getByTestId("hanging-import-preview").waitFor({ state: "visible", timeout: 10_000 });
    check((await settingsOf())["hanging.protocol.spike"] === "", "取り込みは確認するまで保存しない");
    const importText = await page.getByTestId("hanging-manage-dialog").innerText();
    check(/追加 1 件・上書き 0 件・不正 0 件|New: 1 \/ overwrite: 0 \/ invalid: 0/.test(importText), "取り込みの件数の表示", importText);
    await page.screenshot({ path: path.join(OUT_DIR, "6-import.png") });
    await page.getByTestId("hanging-import-commit").click();
    await page.waitForTimeout(1500);
    const restored = (await settingsOf())["hanging.protocol.spike"];
    check(!!restored && JSON.stringify(JSON.parse(restored)) === JSON.stringify(JSON.parse(savedValue)), "取り込むと書き出す前と同じ内容", restored);
    await page.getByTestId("hanging-manage-close").click();

    console.log("\n[7] 別の窓・アプリの再起動でも同じ一覧。保存済みを選んで適用できる");
    await closeViewerWindow(driver, page);
    await driver.stop();
    await driver.start();
    mainPage = driver.page;
    await mainPage.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 30_000 });
    page = await openWithContext(driver, mainPage, { study: study1, series: series1 });
    await openManage(page);
    check(JSON.stringify(await manageIds(page)) === JSON.stringify(["spike"]), "再起動後の新しい窓に同じ一覧が出る", await manageIds(page));
    await page.getByTestId("hanging-manage-close").click();
    await openLayoutMenu(page);
    await page.getByTestId("layout-hanging-apply").click();
    await page.getByTestId("hanging-saved").selectOption("spike");
    await page.getByTestId("hanging-preview").waitFor({ state: "visible", timeout: 10_000 });
    await page.getByTestId("hanging-apply").click();
    await page.waitForTimeout(3000);
    check(JSON.stringify(await tileSeries(page)) === JSON.stringify([uid(3), uid(1)]), "保存済みを選んで適用できる", await tileSeries(page));
    await closeViewerWindow(driver, page);

    /** メイン画面で検査の行だけを選んで 2D ビューアを開く（実際の画面操作）。 */
    const openStudyOnly = async (): Promise<Page> => {
      // 前の受け渡しが残っていると、何も渡らなくても開けてしまう。
      await mainPage.evaluate("localStorage.removeItem('graphy-viewer-ctx')");
      await selectFirstStudy(mainPage, recorder);
      await mainPage.waitForTimeout(1000);
      // 行はもう一度押すと選択が外れるので、シリーズ一覧の中身で「TILESOLO が選ばれている」ことを見て、違えば押し直す。
      const chosen = async () => (await mainPage.getByTestId("series-panel").count()) === 1
        && (await mainPage.getByTestId("series-panel").innerText()).includes("synthetic 4");
      if (!(await chosen())) {
        await mainPage.locator('[data-testid^="study-row-"]').filter({ hasText: "TILESOLO" }).first().click();
        await mainPage.waitForTimeout(1500);
      }
      check(await chosen(), "検査 TILESOLO が選ばれている（この検査の前提）");
      const opened = await openViewerWindow(driver, () => mainPage.getByTestId("viewer2d-toolbar-button").click());
      const ctx = JSON.parse(((await mainPage.evaluate("localStorage.getItem('graphy-viewer-ctx')")) as string | null) ?? "{\"study\":{}}");
      check(ctx.study.patientId === "TILESOLO" && !ctx.series, "渡ったのは検査だけ（この検査の前提）", ctx);
      return opened;
    };

    console.log("\n[8] 自動適用が切（既定）: 合う保存があっても、検査だけを開くと 0 枚のまま");
    check((await settingsOf())["viewer.hangingAutoApply"] === "", "設定は未設定のまま（この検査の前提）", (await settingsOf())["viewer.hangingAutoApply"]);
    page = await openStudyOnly();
    check((await tiles(page).count()) === 0, "タイルは 0 枚", await tiles(page).count());
    check((await page.getByTestId("hanging-notice").count()) === 0, "知らせも出ない");
    await closeViewerWindow(driver, page);

    console.log("\n[9] 自動適用を入れる");
    page = await openWithContext(driver, mainPage, { study: study1, series: series1 });
    await openManage(page);
    // 表示は保存が終わってから変わる（check() は直後の変化を求めるので使わない）。
    await page.getByTestId("hanging-auto").click();
    await page.waitForTimeout(1500);
    check((await settingsOf())["viewer.hangingAutoApply"] === "true", "チェックで設定が保存される", (await settingsOf())["viewer.hangingAutoApply"]);
    check(await page.getByTestId("hanging-auto").isChecked(), "保存の後はチェックが入っている");
    await page.getByTestId("hanging-manage-close").click();
    await closeViewerWindow(driver, page);
    page = await openStudyOnly();
    check(JSON.stringify(await tileSeries(page)) === JSON.stringify([uid(3), uid(1)]), "検査だけを開くと規則の順で並ぶ", await tileSeries(page));
    check((await gridShape(page)) === "1x2", "行×列は規則どおり", await gridShape(page));
    check((await page.getByTestId("hanging-notice").innerText()).includes("spike protocol"), "適用した規則の名前を知らせる");
    const autoLit = [await litRatio(page, 0), await litRatio(page, 1)];
    check(autoLit.every((r) => r > 0.02), "両方のタイルに画像が写っている", autoLit);
    await page.screenshot({ path: path.join(OUT_DIR, "9-auto-applied.png") });
    check(await undoDisabled(page), "自動適用の後に「元に戻す」は出ない");

    console.log("\n[10] タイルがある患者は変えない。シリーズを指定して開けば従来どおり");
    await tiles(page).nth(1).locator("div[draggable='true'] button").last().click();
    await page.waitForTimeout(800);
    const kept = await tileSeries(page);
    check(kept.length === 1, "1 枚に減らした（この検査の前提）", kept);
    await mainPage.evaluate((c) => localStorage.setItem("graphy-viewer-ctx", JSON.stringify(c)), { study: study1, ts: Date.now() });
    await page.waitForTimeout(4000);
    check(JSON.stringify(await tileSeries(page)) === JSON.stringify(kept), "タイルがあるときは適用しない", await tileSeries(page));
    const hasTiles = await page.getByTestId("hanging-notice").innerText();
    check(hasTiles.includes("spike protocol") && /自動では適用していません|Not applied automatically/.test(hasTiles), "手動で適用できると知らせる", hasTiles);
    await closeViewerWindow(driver, page);
    page = await openWithContext(driver, mainPage, { study: study1, series: list.find((s) => s.seriesDescription === "synthetic 2") });
    check(JSON.stringify(await tileSeries(page)) === JSON.stringify([uid(2)]), "自動適用が入でも、シリーズ指定はその 1 枚", await tileSeries(page));
    console.log("\n[11] 環境設定の画面にも同じ項目が出る");
    await mainPage.bringToFront();
    await mainPage.getByTestId("mainscreen-menu-system").click();
    await mainPage.getByTestId("menu-item-settings").click();
    const dlg = mainPage.getByTestId("settings-dialog");
    await dlg.waitFor({ state: "visible", timeout: 10_000 });
    await dlg.getByTestId("settings-cat-viewer").click();
    const row = dlg.getByText(/ハンギングプロトコルを自動で適用する|Apply a hanging protocol automatically/);
    await row.first().scrollIntoViewIfNeeded();
    check((await row.count()) === 1, "ビューアの設定に自動適用の項目がある", await row.count());
    await mainPage.screenshot({ path: path.join(OUT_DIR, "11-settings.png") });
    await putSettings({ "viewer.hangingAutoApply": "", "hanging.protocol.spike": "" });
  } finally {
    await driver.stop();
  }

  console.log(`\n合格 ${passed} / 失敗 ${failures.length}`);
  if (failures.length > 0) {
    console.log(failures.map((f) => ` - ${f}`).join("\n"));
    process.exit(1);
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
