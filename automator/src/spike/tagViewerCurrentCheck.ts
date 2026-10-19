/*
 * タグビューアが「表示中の画像」のタグを出すことの実機検証スパイク。
 *
 * 実行:  cd automator && npx tsx src/spike/tagViewerCurrentCheck.ts <ファントムのフォルダ> [組の名前=a]
 *   ファントムは automator/scripts/make-stitch-phantom.py で作る（スライスごとに IPP が違う 2 シリーズ）。
 *
 * 真値は backend のタグ API（/tags）が返す、各インスタンスの InstanceNumber と IPP。
 * 画面で「いま表示している」スライスは、ビューアの重ね表示の文字（InstanceNumber など）から読む。
 */
import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { createStepRecorder } from "../checklist/types.js";
import { openFirstSeriesInViewer } from "../checklist/items/shared/helpers.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "tag-viewer-current-check");
const [root, setName = "a"] = process.argv.slice(2);
if (!root) throw new Error("使い方はファイル先頭を参照");

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

async function getJson<T>(http: number, p: string): Promise<T> {
  const r = await fetch(`http://127.0.0.1:${http}${p}`);
  if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`);
  return (await r.json()) as T;
}

interface Row { tag: string; value: string; depth: number }
const tagValue = (rows: Row[], tag: string): string => rows.find((r) => r.tag === tag && r.depth === 0)?.value ?? "";

async function addSeries(v: Page, n: number): Promise<void> {
  const btns = v.locator("xpath=//span[starts-with(normalize-space(),'#')]/following-sibling::button[not(@disabled)]");
  for (let guard = 0; guard < 40 && (await v.getByTestId("series-viewer-root").count()) < n; guard++) {
    if ((await btns.count()) === 0) break;
    await btns.first().click();
    await v.waitForTimeout(1500);
  }
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const d = new DesktopDriver({ http: 18190, scp: 18191 });
  await d.start();
  try {
    const http = d.ports.http;
    await resetDb(http);
    const imp = await importPaths(http, [path.join(root, setName)]);
    const studyUid = (imp as any).studyInstanceUids[0] as string;
    const series = (await getJson<any[]>(http, `/api/studies/${studyUid}/series`)).sort((a, b) => (a.seriesNumber ?? 0) - (b.seriesNumber ?? 0));
    check(series.length >= 2, `シリーズが 2 本以上（${series.length}）`);
    // 真値: シリーズごとの {sop, instanceNumber, ipp}
    const truth: Record<string, Array<{ sop: string; n: number; ipp: string }>> = {};
    for (const s of series) {
      const insts = await getJson<Array<{ sopInstanceUid: string; instanceNumber: number | null }>>(http, `/api/studies/${studyUid}/series/${s.seriesInstanceUid}/instances`);
      truth[s.seriesInstanceUid] = [];
      for (const i of insts) {
        const rows = await getJson<Row[]>(http, `/api/studies/${studyUid}/series/${s.seriesInstanceUid}/instances/${i.sopInstanceUid}/tags`);
        truth[s.seriesInstanceUid].push({ sop: i.sopInstanceUid, n: Number(tagValue(rows, "(0020,0013)")), ipp: tagValue(rows, "(0020,0032)") });
      }
      truth[s.seriesInstanceUid].sort((a, b) => a.n - b.n);
    }
    const ipps = new Set(truth[series[0].seriesInstanceUid].map((x) => x.ipp));
    check(ipps.size === truth[series[0].seriesInstanceUid].length, "真値: シリーズ内で IPP がスライスごとに違う（取り違えが検出できる）");

    const main = d.page;
    await main.reload();
    await main.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    await openFirstSeriesInViewer(main, createStepRecorder());
    const v = await d.waitForNewPage(
      () => main.getByTestId("viewer2d-toolbar-button").click(),
      (url) => url.includes("2dviewer"),
    );
    await v.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 30_000 });
    await v.waitForTimeout(1500);
    await addSeries(v, 2);
    const tiles = v.getByTestId("series-viewer-root");
    check((await tiles.count()) === 2, "タイルが 2 枚");
    await v.waitForTimeout(1500);
    await v.screenshot({ path: path.join(OUT_DIR, "0-two-tiles.png") });

    const uidOf = (i: number) => series[i].seriesInstanceUid as string;
    // ビューアの並び（法線方向の位置の昇順）で n 枚目の真値。軸位のファントムなので IPP の z。
    const byZ = (uid: string) => [...truth[uid]].sort((x, y) => Number(x.ipp.split("\\")[2]) - Number(y.ipp.split("\\")[2]));
    const zOf = async (i: number): Promise<number> => {
      const m = /Z\s+(\d+)\s*\/\s*(\d+)/.exec(await tiles.nth(i).innerText());
      return m ? Number(m[1]) : -1;
    };
    const host = (i: number) => tiles.nth(i).locator('[data-testid="viewer2d-canvas-host"]').first();
    const scrollTo = async (i: number, target: number) => {
      const box = (await host(i).boundingBox())!;
      await v.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      for (let g = 0; g < 60 && (await zOf(i)) !== target; g++) {
        await v.mouse.wheel(0, (await zOf(i)) < target ? 120 : -120);
        await v.waitForTimeout(250);
      }
    };
    const rightClick = async (i: number) => {
      const box = (await host(i).boundingBox())!;
      await v.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.3, { button: "right" });
    };
    const dlg = v.getByTestId("tag-viewer-dialog");
    const shown = async () => {
      await dlg.getByTestId("tag-viewer-table").waitFor({ state: "visible", timeout: 30_000 });
      await v.waitForTimeout(400);
      const sop = (await dlg.getByTestId("tag-current").getAttribute("data-sop")) ?? "";
      const ipp = (await dlg.locator('[data-testid="tag-row-(0020,0032)"]').first().innerText()).replace(/\s+/g, " ");
      return { sop, ipp };
    };
    const ippMatches = (shownIpp: string, expect: string) => expect.split("\\").every((c) => shownIpp.includes(String(Number(c))) || shownIpp.includes(c));
    const closeDlg = async () => { await dlg.getByText("閉じる").last().click(); await dlg.waitFor({ state: "detached", timeout: 5000 }); };

    // 1) タイル 2 を 4 枚目へ → 右クリック → そのタイルの 4 枚目のタグ
    await scrollTo(1, 4);
    check((await zOf(1)) === 4 && (await zOf(0)) === 1, "タイル 2 は Z 4、タイル 1 は Z 1", [await zOf(0), await zOf(1)]);
    await rightClick(1);
    await v.getByTestId("frame-ctx-tags").waitFor({ state: "visible", timeout: 5000 });
    await v.screenshot({ path: path.join(OUT_DIR, "1-menu.png") });
    await v.getByTestId("frame-ctx-tags").click();
    let g = await shown();
    const exp1 = byZ(uidOf(1))[3];
    check(g.sop === exp1.sop, "右クリックしたタイル 2 の表示中（Z 4）の画像のタグが出る", { got: g.sop.slice(-6), exp: exp1.sop.slice(-6) });
    check(ippMatches(g.ipp, exp1.ipp), "表示された IPP が、その画像の IPP と一致", { shown: g.ipp, exp: exp1.ipp });
    check(g.sop !== byZ(uidOf(1))[0].sop, "先頭の画像ではない（先頭固定のときは落ちる）");
    await v.screenshot({ path: path.join(OUT_DIR, "2-tags-tile2-z4.png") });
    // ツリー: 現在の行が強調され、別の画像を選ぶと IPP が変わる
    const cur = dlg.locator('[data-testid="tag-tree-instance"][data-current="1"]');
    check((await cur.count()) === 1 && (await cur.getAttribute("data-sop")) === exp1.sop, "ツリーの現在行が表示中の画像");
    const other = byZ(uidOf(1))[7];
    await dlg.locator(`[data-testid="tag-tree-instance"][data-sop="${other.sop}"]`).click();
    g = await shown();
    check(g.sop === other.sop && ippMatches(g.ipp, other.ipp), "ツリーで 8 枚目を選ぶとそのタグに切り替わる", g);
    // 別のシリーズへ
    await dlg.locator(`[data-testid="tag-tree-series"][data-series="${uidOf(0)}"]`).click();
    const first0 = byZ(uidOf(0))[0];
    await dlg.locator(`[data-testid="tag-tree-instance"][data-sop="${first0.sop}"]`).click();
    g = await shown();
    check(g.sop === first0.sop && ippMatches(g.ipp, first0.ipp), "ツリーで別シリーズの画像を選ぶとそのタグに切り替わる", g);
    await v.screenshot({ path: path.join(OUT_DIR, "3-tree-other-series.png") });
    await closeDlg();

    // 2) 複数タイル: タイル 1 を 7 枚目にしても、タイル 2 を右クリックすればタイル 2 の 4 枚目
    await scrollTo(0, 7);
    await rightClick(1);
    await v.getByTestId("frame-ctx-tags").click();
    g = await shown();
    check(g.sop === exp1.sop, "タイル 1 を動かしても、右クリックしたタイル 2 のタグが出る", { got: g.sop.slice(-6) });
    await closeDlg();
    await rightClick(0);
    await v.getByTestId("frame-ctx-tags").click();
    g = await shown();
    const exp0 = byZ(uidOf(0))[6];
    check(g.sop === exp0.sop && ippMatches(g.ipp, exp0.ipp), "タイル 1（Z 7）を右クリックするとタイル 1 の 7 枚目", { got: g.sop.slice(-6), exp: exp0.sop.slice(-6) });
    await closeDlg();

    // 3) 右ドラッグ（Zoom）ではメニューが出ない
    const box = (await host(1).boundingBox())!;
    const zoomBefore = await tiles.nth(1).innerText().then((t) => /ズーム\s*(\d+)%/.exec(t)?.[1]);
    await v.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await v.mouse.down({ button: "right" });
    await v.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 60, { steps: 8 });
    await v.mouse.up({ button: "right" });
    await v.waitForTimeout(500);
    check((await v.getByTestId("frame-ctx-tags").count()) === 0, "右ドラッグではメニューが出ない");
    const zoomAfter = await tiles.nth(1).innerText().then((t) => /ズーム\s*(\d+)%/.exec(t)?.[1]);
    check(zoomBefore !== zoomAfter, "右ドラッグでズームが効く", { zoomBefore, zoomAfter });

    // 4) メニュー（ツール > タグ表示）から: 対象タイル（先頭）の表示中の画像
    await v.getByTestId("viewer2d-menu-tools").click();
    await v.getByText("タグ表示", { exact: true }).first().click();
    g = await shown();
    check(g.sop === exp0.sop, "メニューから開くと先頭タイルの表示中（Z 7）の画像", { got: g.sop.slice(-6) });
    await v.screenshot({ path: path.join(OUT_DIR, "4-menu-open.png") });
    const curM = dlg.locator('[data-testid="tag-tree-instance"][data-current="1"]');
    check((await curM.count()) === 1 && (await curM.getAttribute("data-sop")) === exp0.sop, "メニュー起動でもツリーの現在行が表示中の画像");
    await closeDlg();
  } finally {
    await d.stop();
  }
  console.log(`\n合格 ${passed} / 失敗 ${failures.length}`);
  if (failures.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
