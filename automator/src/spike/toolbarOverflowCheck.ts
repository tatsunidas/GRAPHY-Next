/*
 * 狭い窓でツールボタンが隠れたとき「⋯」のポップアップから押せることの実機検証スパイク。
 *
 * 実行:  cd automator && npx tsx src/spike/toolbarOverflowCheck.ts
 *
 * 🔴 押す系は押した検査でしか守れない（CLAUDE.md ルール 9）。ポップアップの中のボタンを実際に押して効果を見る。
 *
 * 何を確かめるか（web driver ＝ headless Chromium ＋ 本物の backend ＋ ct-basic。2D ビューア）:
 *   1. 広い窓（1400px）では「⋯」が出ず、全ボタンが可視（従来と同じ並び）
 *   2. 狭い窓（500px）では上部ツールバーと画像下の行の両方に「⋯」が出て、全ボタンが
 *      「可視の行 ∪ ポップアップ」に過不足なく 1 つずつ揃う（取りこぼし 0・重複なし）。行末に区切り線が残らない
 *   3. ポップアップ内のボタンを押すと実際に効く（拡大で倍率が変わる・ツール切替で選択が変わる）。押すと閉じる
 *   4. Esc・外側クリックで閉じる。ポップアップは窓の内側に収まる
 *   5. 窓を戻すと「⋯」が消えて元の並びに戻る（負例）
 *
 * 前提: backend jar（`cd backend && mvn -q -Dfrontend.skip=true -DskipTests package`）と fixture ct-basic。
 */
import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";

import { WebDriver } from "../driver/webDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importFixtureCategory } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "toolbar-overflow-check");

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

/** 上部ツールバー（Viewer2DToolbar）と画像下の行（Viewer2D）で testid を持つボタン。 */
const TOP_IDS = ["toolbar-tool-wl", "toolbar-tool-pan", "toolbar-tool-zoom", "toolbar-invert", "toolbar-rotate", "toolbar-flip-h", "toolbar-flip-v", "toolbar-fit", "toolbar-reset"];
const TILE_IDS = ["viewer-zoom-out-btn", "viewer-zoom-in-btn", "viewer-lut-button", "viewer-undo-btn", "viewer-redo-btn"];

interface Seen { inRow: number; inPopup: number; total: number }

/** 各 testid が「可視の行」「ポップアップ」に何個あるか。可視 = visibility が hidden でなく窓の内側にある。 */
async function seen(p: Page, ids: string[]): Promise<Record<string, Seen>> {
  return p.evaluate(`(() => {
    const ids = ${JSON.stringify(ids)};
    const out = {};
    for (const id of ids) {
      let inRow = 0, inPopup = 0, total = 0;
      for (const e of document.querySelectorAll('[data-testid="' + id + '"]')) {
        total++;
        const cs = getComputedStyle(e);
        const r = e.getBoundingClientRect();
        const visible = cs.visibility === "visible" && r.width > 0 && r.right <= innerWidth + 1 && r.left >= -1;
        if (!visible) continue;
        if (e.closest('[role="menu"]')) inPopup++; else inRow++;
      }
      out[id] = { inRow, inPopup, total };
    }
    return out;
  })()`);
}

/** 行末（「⋯」の直前）の可視の子が区切り線でないか。 */
async function lastVisibleIsSep(p: Page, moreTestId: string): Promise<boolean> {
  return p.evaluate(`(() => {
    const more = document.querySelector('[data-testid="${moreTestId}"]');
    if (!more) return false;
    const row = more.parentElement;
    const kids = Array.from(row.children).filter((e) => e !== more)
      .map((w) => w.firstElementChild || w)
      .filter((e) => getComputedStyle(e).visibility === "visible");
    const last = kids[kids.length - 1];
    return !!last && last.getAttribute("data-sep") !== null;
  })()`);
}

async function boxInWindow(p: Page, testId: string): Promise<{ ok: boolean; box: number[] }> {
  const b = await p.getByTestId(testId).boundingBox();
  const vp = p.viewportSize()!;
  if (!b) return { ok: false, box: [] };
  return { ok: b.x >= 0 && b.y >= 0 && b.x + b.width <= vp.width && b.y + b.height <= vp.height, box: [b.x, b.y, b.width, b.height].map(Math.round) };
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const d = new WebDriver({ http: 18690, scp: 18691, vite: 18693 }, { viewport: { width: 1400, height: 900 }, locale: "ja-JP" });
  await d.start();
  try {
    console.log(`  reset: ${JSON.stringify(await resetDb(d.ports.http))}`);
    console.log(`  import: ${JSON.stringify(await importFixtureCategory(d.ports.http, "ct-basic"))}`);
    const m = d.page;
    await m.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 20_000 });
    await m.getByTestId("search-allperiod-chip").click();
    await m.getByTestId("search-submit-button").click();
    await m.locator('[data-testid^="study-row-"]').first().click();
    await m.locator('[data-testid^="series-row-"]').first().click();
    await m.waitForTimeout(2500);
    const v = await d.waitForNewPage(() => m.getByTestId("viewer2d-toolbar-button").click(), () => true, 30_000);
    await v.setViewportSize({ width: 1400, height: 900 });
    await v.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 20_000 });
    await v.waitForTimeout(3500);
    const zoomText = async () => (await v.getByTestId("status-zoom").first().innerText()).trim();

    console.log("\n[1] 広い窓（1400px）: 「⋯」は出ない・全ボタンが可視");
    check((await v.getByTestId("viewer2d-toolbar-more").count()) === 0, "上部ツールバーに「⋯」は出ない");
    check((await v.getByTestId("viewer-toolbar-more").count()) === 0, "画像下の行に「⋯」は出ない");
    let top = await seen(v, TOP_IDS);
    let tile = await seen(v, TILE_IDS);
    check(TOP_IDS.every((i) => top[i].inRow === 1 && top[i].total === 1), "上部ツールバーの全ボタンが 1 つずつ可視", top);
    check(TILE_IDS.every((i) => tile[i].inRow === 1 && tile[i].total === 1), "画像下の行の全ボタンが 1 つずつ可視", tile);
    await v.screenshot({ path: path.join(OUT_DIR, "1-wide.png") });

    console.log("\n[2] 狭い窓（500px）: 「⋯」が出て、全ボタンが過不足なく揃う");
    await v.setViewportSize({ width: 500, height: 800 });
    await v.waitForTimeout(1500);
    check((await v.getByTestId("viewer2d-toolbar-more").count()) === 1, "上部ツールバーに「⋯」が出る");
    check((await v.getByTestId("viewer-toolbar-more").count()) === 1, "画像下の行に「⋯」が出る");
    top = await seen(v, TOP_IDS);
    tile = await seen(v, TILE_IDS);
    check(TOP_IDS.some((i) => top[i].inRow === 0), "上部ツールバーは一部が行に収まらない（前提）", top);
    check(TILE_IDS.some((i) => tile[i].inRow === 0), "画像下の行は一部が行に収まらない（前提）", tile);
    check(!(await lastVisibleIsSep(v, "viewer2d-toolbar-more")), "上部ツールバーの行末に区切り線が残らない");
    check(!(await lastVisibleIsSep(v, "viewer-toolbar-more")), "画像下の行の行末に区切り線が残らない");
    await v.screenshot({ path: path.join(OUT_DIR, "2-narrow.png") });

    await v.getByTestId("viewer-toolbar-more").click();
    await v.waitForTimeout(500);
    tile = await seen(v, TILE_IDS);
    check(TILE_IDS.every((i) => tile[i].inRow + tile[i].inPopup === 1), "画像下: 「可視の行 ∪ ポップアップ」に全ボタンが 1 つずつ（取りこぼし・重複なし）", tile);
    const pop1 = await boxInWindow(v, "viewer-toolbar-more-popup");
    check(pop1.ok, "ポップアップが窓の内側に収まる", pop1.box);
    await v.screenshot({ path: path.join(OUT_DIR, "2-popup-tile.png") });

    console.log("\n[3] ポップアップ内のボタンを押すと効く（押すと閉じる）");
    const zoomBtn = tile["viewer-zoom-in-btn"].inPopup === 1
      ? v.getByTestId("viewer-toolbar-more-popup").getByTestId("viewer-zoom-in-btn")
      : null;
    if (zoomBtn) {
      const z0 = await zoomText();
      await zoomBtn.click();
      await v.waitForTimeout(800);
      const z1 = await zoomText();
      check(z0 !== z1, "ポップアップ内の拡大ボタンで倍率が変わった", { z0, z1 });
      check((await v.getByTestId("viewer-toolbar-more-popup").count()) === 0, "ボタンを押すとポップアップが閉じる");
    } else {
      console.log("  （拡大ボタンは行に収まっているため、ポップアップ経由の拡大は省略。500px では通常ここに来ない）");
      check(false, "拡大ボタンがポップアップ側にある（前提）", tile["viewer-zoom-in-btn"]);
    }

    await v.getByTestId("viewer2d-toolbar-more").click();
    await v.waitForTimeout(500);
    top = await seen(v, TOP_IDS);
    check(TOP_IDS.every((i) => top[i].inRow + top[i].inPopup === 1), "上部: 「可視の行 ∪ ポップアップ」に全ボタンが 1 つずつ（取りこぼし・重複なし）", top);
    const pop2 = await boxInWindow(v, "viewer2d-toolbar-more-popup");
    check(pop2.ok, "上部のポップアップが窓の内側に収まる", pop2.box);
    await v.screenshot({ path: path.join(OUT_DIR, "3-popup-top.png") });
    const panInPopup = top["toolbar-tool-pan"].inPopup === 1;
    const bg = (id: string) =>
      v.evaluate(`(() => { const e = Array.from(document.querySelectorAll('[data-testid="${id}"]')).find((x) => getComputedStyle(x).visibility === "visible"); return e ? getComputedStyle(e).backgroundColor : null; })()`);
    // 行に収まらないボタンは押すとポップアップが閉じて見えなくなるので、開き直してポップアップ内の見た目で判定する。
    const popBg = (id: string) =>
      v.evaluate(`(() => { const e = document.querySelector('[role="menu"] [data-testid="${id}"]'); return e ? getComputedStyle(e).backgroundColor : null; })()`);
    const pickId = "toolbar-tool-pan";
    check(top[pickId].inPopup === 1, "パンはポップアップ側にある（前提）", top[pickId]);
    const bgBefore = await popBg(pickId);
    await v.getByTestId("viewer2d-toolbar-more-popup").getByTestId(pickId).click();
    await v.waitForTimeout(600);
    await v.getByTestId("viewer2d-toolbar-more").click();
    await v.waitForTimeout(500);
    const bgAfter = await popBg(pickId);
    const wlBg = await popBg("toolbar-tool-wl");
    check(bgBefore !== null && bgAfter !== null && bgBefore !== bgAfter, "ポップアップ内のパンを押すと選択状態（背景色）が変わった", { bgBefore, bgAfter });
    check(wlBg !== bgAfter, "選択が W/L からパンへ移った（W/L の背景はパンと別）", { wlBg, bgAfter });
    await v.screenshot({ path: path.join(OUT_DIR, "3-popup-top-pan-on.png") });
    await v.keyboard.press("Escape");
    await v.waitForTimeout(300);

    console.log("\n[4] Esc・外側クリックで閉じる");
    await v.getByTestId("viewer2d-toolbar-more").click();
    await v.waitForTimeout(400);
    check((await v.getByTestId("viewer2d-toolbar-more-popup").count()) === 1, "「⋯」で開く");
    await v.keyboard.press("Escape");
    await v.waitForTimeout(400);
    check((await v.getByTestId("viewer2d-toolbar-more-popup").count()) === 0, "Esc で閉じる");
    await v.getByTestId("viewer2d-toolbar-more").click();
    await v.waitForTimeout(400);
    await v.mouse.click(250, 600);
    await v.waitForTimeout(400);
    check((await v.getByTestId("viewer2d-toolbar-more-popup").count()) === 0, "外側クリックで閉じる");

    console.log("\n[5] 窓を戻すと「⋯」が消えて元の並びに戻る（負例）");
    await v.setViewportSize({ width: 1400, height: 900 });
    await v.waitForTimeout(1500);
    check((await v.getByTestId("viewer2d-toolbar-more").count()) === 0, "上部ツールバーの「⋯」が消えた");
    check((await v.getByTestId("viewer-toolbar-more").count()) === 0, "画像下の行の「⋯」が消えた");
    top = await seen(v, TOP_IDS);
    tile = await seen(v, TILE_IDS);
    check(TOP_IDS.every((i) => top[i].inRow === 1 && top[i].total === 1), "上部ツールバーの全ボタンが元の並びで可視", top);
    check(TILE_IDS.every((i) => tile[i].inRow === 1 && tile[i].total === 1), "画像下の行の全ボタンが元の並びで可視", tile);
  } finally {
    await d.stop();
  }

  console.log(`\n結果: ${passed} ok / ${failures.length} FAIL`);
  for (const f of failures) console.log(`  - ${f}`);
  console.log(`スクリーンショット: ${OUT_DIR}`);
  process.exit(failures.length ? 1 : 0);
}

void main();
