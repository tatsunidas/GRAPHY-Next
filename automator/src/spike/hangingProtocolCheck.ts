/*
 * ハンギングプロトコルの「適用」「元に戻す」を実アプリで測るスパイク。
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
import { openFirstSeriesInViewer } from "../checklist/items/shared/helpers.js";
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

    const mainPage = driver.page;
    await mainPage.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 30_000 });
    await openFirstSeriesInViewer(mainPage, recorder);
    const page = await driver.waitForNewPage(
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
