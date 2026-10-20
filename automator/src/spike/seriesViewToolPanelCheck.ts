/*
 * シリーズビューの「画像のみ表示＋ツールパネル開閉」の実機検証スパイク。
 *
 * 実行:  cd automator && npx tsx src/spike/seriesViewToolPanelCheck.ts
 *
 * 🔴 **押す系は押した検査でしか守れない**（CLAUDE.md ルール 9）。実際に開閉ボタンを押し、環境設定
 * `viewer.toolPanelDefault` を書き換えて開き直し、**正例（開く）と負例（閉じる）の両方**で確かめる。
 *
 * 何を確かめるか（web driver＝headless Chromium ＋ 本物の backend ＋ ct-basic）:
 *   1. 設定 OFF（既定）: スライダー群（series-controls）が無く、画像領域が枠いっぱいに広がる
 *   2. 開閉ボタンで series-controls が出る／消える。開閉しても表示ズームは 100% のまま
 *   3. ズーム後（100% でない値）にウィンドウをリサイズ・パネルを開閉しても、その倍率が保たれる
 *   4. 画像領域の幅は、シリーズビューの幅いっぱい（900px 上限に戻っていない）
 *   5. 設定 ON: 開き直すと最初から series-controls が出ている（負例: OFF に戻すと閉に戻る）
 *   6. 2D ビューアで Fusion を作ると、タイルの開閉ボタンに Fusion バーが追従する（閉のとき出ない）
 *   7. XA のシネ再生は、パネルを畳んでも続き、開き直しても再生中のまま。再生ボタンで止まる
 *
 * 前提: backend jar（`cd backend && mvn -q -Dfrontend.skip=true -DskipTests package`）、fixture ct-basic と xa-angio、
 * Fusion 用に同一患者の 2 シリーズ（`~/graphy_sample_images/dicom_samples/3DFLAIR`。無ければ 6 は未達として飛ばす）。
 */
import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";

import { WebDriver } from "../driver/webDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importFixtureCategory, importPaths } from "../fixtures/importFixtures.js";
import { createStepRecorder } from "../checklist/types.js";
import { openFirstSeriesInViewer } from "../checklist/items/shared/helpers.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "series-view-toolpanel-check");

const failures: string[] = [];
const unreached: string[] = [];
let passed = 0;
function check(cond: boolean, label: string, detail?: unknown): void {
  if (cond) {
    passed++;
    console.log(`  [ok  ] ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  } else {
    console.log(`  [FAIL] ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
    failures.push(label);
  }
}

async function putDefault(port: number, on: boolean): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${port}/api/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ "viewer.toolPanelDefault": String(on) }),
  });
  if (!res.ok) throw new Error(`設定を書けません: HTTP ${res.status}`);
}

// 畳んでいる間も DOM に残る（display:none。CineControls の再生を止めないため）ので、「開いている」は可視で見る。
const hasControls = (p: Page) => p.getByTestId("series-controls").first().isVisible();
const zoomText = async (p: Page) => (await p.getByTestId("status-zoom").first().innerText()).trim();

async function geom(p: Page): Promise<{ root: number[]; panel: number[] }> {
  // tsx は関数に __name を差し込み、ブラウザ側で未定義になるので、評価は文字列で渡す。
  return p.evaluate(`(() => {
    function r(e) { const b = e && e.getBoundingClientRect(); return b ? [Math.round(b.width), Math.round(b.height)] : [0, 0]; }
    return {
      root: r(document.querySelector("[data-testid=series-viewer-root]")),
      panel: r(document.querySelector("[data-graphy-image-panel]")),
    };
  })()`);
}

async function openSeries(d: WebDriver): Promise<Page> {
  await d.page.reload();
  await openFirstSeriesInViewer(d.page, createStepRecorder());
  await d.page.getByTestId("status-zoom").first().waitFor({ state: "visible", timeout: 15_000 });
  return d.page;
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  // shooting 指定で backend を standalone（取り込んだ保管庫をそのまま検索できる）で起動する。
  const d = new WebDriver({ http: 18590, scp: 18591, vite: 18593 }, { viewport: { width: 1400, height: 900 }, locale: "ja-JP" });
  await d.start();
  try {
    console.log(`  reset: ${JSON.stringify(await resetDb(d.ports.http))}`);
    console.log(`  import: ${JSON.stringify(await importFixtureCategory(d.ports.http, "ct-basic"))}`);
    const port = d.ports.http;
    await d.page.setViewportSize({ width: 1400, height: 900 });

    console.log("\n[1] 設定 OFF（既定）: 画像のみ");
    await putDefault(port, false);
    let p = await openSeries(d);
    check(!(await hasControls(p)), "series-controls が無い（スライダー群は閉）");
    check((await p.getByTestId("series-controls-toggle").count()) === 1, "開閉ボタンがある");
    check((await p.getByTestId("viewer-zoom-in-btn").count()) > 0, "ツールボタン群は常に表示されている");
    check((await zoomText(p)) === "100%", "初期表示のズームは 100%", await zoomText(p));
    const closed = await geom(p);
    await p.screenshot({ path: path.join(OUT_DIR, "1-closed.png") });

    console.log("\n[2] 開閉ボタン: 押すと出る／もう一度で消える。ズームは 100% のまま");
    await p.getByTestId("series-controls-toggle").click();
    await p.waitForTimeout(1200);
    check(await hasControls(p), "押すと series-controls が出る");
    const open = await geom(p);
    check(open.panel[1] < closed.panel[1], "開くと画像領域の高さが縮む", { closed: closed.panel, open: open.panel });
    check(open.panel[0] === closed.panel[0], "画像領域の幅は変わらない", { closed: closed.panel, open: open.panel });
    const ctlW = Math.round((await p.getByTestId("series-controls").boundingBox())?.width ?? 0);
    check(ctlW >= closed.root[0] - 4, "ツールパネルは全幅に広がっている（560px 上限でない）", { ctlW, rootW: closed.root[0] });
    check((await zoomText(p)) === "100%", "開いても 100%", await zoomText(p));
    await p.screenshot({ path: path.join(OUT_DIR, "2-open.png") });
    await p.getByTestId("series-controls-toggle").click();
    await p.waitForTimeout(1200);
    check(!(await hasControls(p)), "もう一度押すと消える");
    check((await zoomText(p)) === "100%", "閉じても 100%", await zoomText(p));

    console.log("\n[3] 拡大してからリサイズ・開閉しても倍率が保たれる");
    const zin = p.getByTestId("viewer-zoom-in-btn").first();
    for (let i = 0; i < 3; i++) await zin.click();
    await p.waitForTimeout(800);
    const zoomed = await zoomText(p);
    check(zoomed !== "100%", "拡大ボタンで 100% 以外になった", zoomed);
    await p.setViewportSize({ width: 900, height: 600 });
    await p.waitForTimeout(1500);
    check((await zoomText(p)) === zoomed, "小さくリサイズしても同じ倍率", { before: zoomed, after: await zoomText(p) });
    await p.setViewportSize({ width: 1600, height: 1000 });
    await p.waitForTimeout(1500);
    check((await zoomText(p)) === zoomed, "大きくリサイズしても同じ倍率", { before: zoomed, after: await zoomText(p) });
    await p.getByTestId("series-controls-toggle").click();
    await p.waitForTimeout(1200);
    check((await zoomText(p)) === zoomed, "パネルを開いても同じ倍率", { before: zoomed, after: await zoomText(p) });

    console.log("\n[4] 画像領域は幅いっぱい（900px 上限でない）");
    await p.setViewportSize({ width: 1600, height: 1000 });
    await p.waitForTimeout(1200);
    const wide = await geom(p);
    check(wide.panel[0] > 900, "広い窓では画像領域が 900px を超える", wide.panel);
    await p.screenshot({ path: path.join(OUT_DIR, "4-wide.png") });
    await p.setViewportSize({ width: 1400, height: 900 });

    console.log("\n[5] 設定 ON: 最初から開く。負例: OFF に戻すと閉に戻る");
    await putDefault(port, true);
    p = await openSeries(d);
    check(await hasControls(p), "設定 ON で開き直すと series-controls が最初から出ている");
    await p.screenshot({ path: path.join(OUT_DIR, "5-default-on.png") });
    await putDefault(port, false);
    p = await openSeries(d);
    check(!(await hasControls(p)), "設定 OFF に戻して開き直すと閉に戻る");

    // ── 6. Fusion バーがタイルの開閉に追従する ──────────────────────────
    console.log("\n[6] 2D ビューア: Fusion バーがタイル個別の開閉に追従する");
    const mrDir = path.join(process.env.HOME ?? "", "graphy_sample_images", "dicom_samples", "3DFLAIR");
    if (!fs.existsSync(mrDir)) {
      console.log(`  [未達] Fusion 用データが無い: ${mrDir}`);
      unreached.push("[6] Fusion（データ無し）");
    } else {
      console.log(`  import: ${JSON.stringify(await importPaths(port, [mrDir]))}`);
      await putDefault(port, false);
      await d.page.reload();
      await d.page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 20_000 });
      await d.page.getByTestId("search-allperiod-chip").click();
      await d.page.getByTestId("search-submit-button").click();
      await d.page.locator('[data-testid^="study-row-"]').filter({ hasText: "MR" }).first().click();
      await d.page.locator('[data-testid^="series-row-"]').first().click();
      await d.page.waitForTimeout(2500);
      const v = await d.waitForNewPage(() => d.page.getByTestId("viewer2d-toolbar-button").click(), () => true, 30_000);
      await v.setViewportSize({ width: 1400, height: 900 });
      await v.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 20_000 });
      await v.waitForTimeout(3000);
      const tile = v.getByTestId("series-viewer-root").first();
      const box = (await tile.boundingBox())!;
      await v.getByText(/T1 COR/).first().dragTo(tile, { targetPosition: { x: box.width / 2, y: box.height / 2 } });
      await v.waitForTimeout(4000);
      const fusionBar = () => v.getByTestId("fusion-blend").count().then((n) => n > 0);
      check(!(await fusionBar()), "既定（閉）では Fusion バーは出ない（負例）");
      await v.getByTestId("series-controls-toggle").first().click();
      await v.waitForTimeout(1500);
      check(await fusionBar(), "タイルの開閉ボタンで開くと Fusion バーが出る（正例）");
      await v.screenshot({ path: path.join(OUT_DIR, "6-fusion-open.png") });
      await v.getByTestId("series-controls-toggle").first().click();
      await v.waitForTimeout(1200);
      check(!(await fusionBar()), "もう一度押して閉じると Fusion バーも消える");
      await v.close();
    }

    // ── 7. XA シネ: 畳んでも再生が続く ───────────────────────────────────
    console.log("\n[7] XA シネ: パネルを畳んでも再生が続く");
    const xaFile = path.join(AUTOMATOR_ROOT, "fixtures", "xa-angio", "0009.DCM");
    if (!fs.existsSync(xaFile)) {
      console.log(`  [未達] XA データが無い: ${xaFile}`);
      unreached.push("[7] XA シネ（データ無し）");
    } else {
      console.log(`  import: ${JSON.stringify(await importPaths(port, [xaFile]))}`);
      await putDefault(port, false);
      await d.page.reload();
      await d.page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 20_000 });
      await d.page.getByTestId("search-allperiod-chip").click();
      await d.page.getByTestId("search-submit-button").click();
      await d.page.locator('[data-testid^="study-row-"]').filter({ hasText: "XA" }).first().click();
      await d.page.locator('[data-testid^="series-row-"]').first().click();
      await d.page.getByTestId("series-viewer-root").waitFor({ state: "visible", timeout: 15_000 });
      await d.page.waitForTimeout(4000);
      const rendered = async () =>
        (await d.page.evaluate(
          "(window.__graphyDebug && window.__graphyDebug.getXaCineStats ? window.__graphyDebug.getXaCineStats().framesRendered : -1)",
        )) as number;
      const frameNow = async () => (await d.page.getByTestId("cine-indicator").textContent())?.trim() ?? "";
      await d.page.getByTestId("series-controls-toggle").click();
      await d.page.waitForTimeout(600);
      await d.page.getByTestId("cine-play").click();
      await d.page.waitForTimeout(2500);
      const n0 = await rendered();
      await d.page.getByTestId("series-controls-toggle").click();
      await d.page.waitForTimeout(500);
      check(!(await hasControls(d.page)), "再生中にパネルを畳んだ");
      check((await d.page.getByTestId("series-controls-playing").count()) === 1, "畳んでいる間は開閉ボタンに「再生中」の印が出る");
      await d.page.waitForTimeout(3000);
      const n1 = await rendered();
      check(n1 > n0 + 20, "畳んだあともフレームが進み続ける", { before: n0, after: n1 });
      await d.page.screenshot({ path: path.join(OUT_DIR, "7-cine-closed-playing.png") });
      await d.page.getByTestId("series-controls-toggle").click();
      await d.page.waitForTimeout(800);
      const f1 = await frameNow();
      await d.page.waitForTimeout(1500);
      const f2 = await frameNow();
      check(f1 !== f2, "開き直しても再生中のまま（コマが進んでいる）", { f1, f2 });
      await d.page.getByTestId("cine-play").click();
      await d.page.waitForTimeout(800);
      const g1 = await frameNow();
      await d.page.waitForTimeout(1500);
      const g2 = await frameNow();
      check(g1 === g2, "再生ボタンで止まる（負例: 止めたあとは進まない）", { g1, g2 });
      await d.page.getByTestId("series-controls-toggle").click();
      await d.page.waitForTimeout(500);
      check((await d.page.getByTestId("series-controls-playing").count()) === 0, "止めたあとは「再生中」の印が消える");
    }
  } finally {
    await d.stop();
  }

  console.log(`\n結果: ${passed} ok / ${failures.length} FAIL / ${unreached.length} 未達`);
  for (const u of unreached) console.log(`  - 未達: ${u}`);
  for (const f of failures) console.log(`  - ${f}`);
  console.log(`スクリーンショット: ${OUT_DIR}`);
  process.exit(failures.length ? 1 : 0);
}

void main();
