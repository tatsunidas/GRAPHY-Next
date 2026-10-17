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
 *
 * 前提: backend jar（`cd backend && mvn -q -Dfrontend.skip=true -DskipTests package`）と fixture ct-basic。
 */
import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";

import { WebDriver } from "../driver/webDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importFixtureCategory } from "../fixtures/importFixtures.js";
import { createStepRecorder } from "../checklist/types.js";
import { openFirstSeriesInViewer } from "../checklist/items/shared/helpers.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "series-view-toolpanel-check");

const failures: string[] = [];
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

const hasControls = (p: Page) => p.getByTestId("series-controls").count().then((n) => n > 0);
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
  } finally {
    await d.stop();
  }

  console.log(`\n結果: ${passed} ok / ${failures.length} FAIL`);
  for (const f of failures) console.log(`  - ${f}`);
  console.log(`スクリーンショット: ${OUT_DIR}`);
  process.exit(failures.length ? 1 : 0);
}

void main();
