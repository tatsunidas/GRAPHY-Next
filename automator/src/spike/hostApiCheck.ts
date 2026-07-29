/*
 * host API H1/H2（fw/plugin-architecture.md §7）の実機検証スパイク。
 *
 * 実行:  cd automator && npx tsx src/spike/hostApiCheck.ts
 *
 * 何を確かめるか（本物の Electron ＋ 本物の backend ＋ 本物のプラグイン配信経路）:
 *   1. plugins/ フォルダに置いた第三者プラグインが /api/plugins から配信され、Plug-ins メニューに出る
 *   2. その ui.js が **DOM を覗かずに** host.getTargets() / getViewState() で表示内容を取得できる
 *   3. 値が実際の表示と一致する（シリーズ/スライス/W/L）
 *   4. **毎回読み直している**こと ＝ スライスを送り W/L を変えて再実行すると値が追従する
 *      （素案の「配列プロパティ（スナップショット）」を関数に変えた理由の検証）
 *   5. 未知の tileId は null（例外にしない）
 *
 * 前提: backend jar（`cd backend && mvn -q -Dfrontend.skip=true -DskipTests package`）と
 *       fixture ct-basic（`npx tsx src/cli.ts check-fixtures`）。
 *       検証用プラグインは `automator/plugins/hostapi-check/` が原本で、実行時に backend の
 *       plugins フォルダ（`.results/run-data/desktop/plugins/`）へコピーされる。
 */
import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";

import { DesktopDriver, DESKTOP_RUN_DATA_DIR } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importFixtureCategory } from "../fixtures/importFixtures.js";
import { openFirstSeriesInViewer } from "../checklist/items/shared/helpers.js";
import { createStepRecorder } from "../checklist/types.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";

interface Target {
  tileId: string;
  studyUid: string;
  seriesUid: string;
  seriesLabel: string;
  imageId: string;
  sliceIndex: number;
  sliceCount: number;
  c: number;
  t: number;
  modality: string;
}
interface ViewState {
  tileId: string;
  windowCenter: number;
  windowWidth: number;
  unit: string;
  colormap: string | null;
  invert: boolean;
  flipH: boolean;
  flipV: boolean;
  rotation: number;
  zoom: number;
  pan: [number, number];
}
interface Payload {
  at: string;
  targets: Target[];
  states: (ViewState | null)[];
  defaultState: ViewState | null;
  unknownTile: ViewState | null;
}

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "hostapi-check");
/** 検証用プラグインの原本（リポジトリ管理下）。 */
const PLUGIN_SRC = path.join(AUTOMATOR_ROOT, "plugins", "hostapi-check");
/** backend が走査する plugins root（= backend の CWD 直下）。 */
const PLUGIN_DST = path.join(DESKTOP_RUN_DATA_DIR, "plugins", "hostapi-check");

/** 検証用プラグインを backend の plugins フォルダへ配置する（第三者プラグインの手置きと同じ形）。 */
function installVerificationPlugin(): void {
  fs.mkdirSync(PLUGIN_DST, { recursive: true });
  for (const name of fs.readdirSync(PLUGIN_SRC)) {
    fs.copyFileSync(path.join(PLUGIN_SRC, name), path.join(PLUGIN_DST, name));
  }
  console.log(`検証用プラグインを配置: ${PLUGIN_DST}`);
}

const failures: string[] = [];
function check(cond: boolean, label: string, detail?: unknown): void {
  if (cond) {
    console.log(`  [ok  ] ${label}`);
  } else {
    console.log(`  [FAIL] ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
    failures.push(label);
  }
}

/** Plug-ins メニュー → hostapi-check を実行し、プラグインが書いた結果を読む。 */
async function runPlugin(viewerPage: Page): Promise<Payload> {
  await viewerPage.evaluate(() => {
    delete (window as unknown as { __hostApiCheck?: unknown }).__hostApiCheck;
  });
  await viewerPage.getByTestId("viewer2d-menu-plugins").click();
  await viewerPage.getByTestId("plugin-item-hostapi-check").click();
  await viewerPage.getByTestId("hostapi-check-panel").waitFor({ state: "visible", timeout: 10_000 });
  return viewerPage.evaluate(
    () => (window as unknown as { __hostApiCheck: Payload }).__hostApiCheck,
  ) as Promise<Payload>;
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  // backend 起動前に置く（plugins は起動後も走査されるが、初回の /api/plugins に載せるため）。
  installVerificationPlugin();
  const driver = new DesktopDriver();
  const recorder = createStepRecorder();
  await driver.start();
  let viewerPage: Page | null = null;
  try {
    await resetDb(driver.ports.http);
    const imported = await importFixtureCategory(driver.ports.http, "ct-basic");
    console.log(`fixture import: ${JSON.stringify(imported)}`);
    // reload はしない: React 未マウントのまま白紙で固まることがある（helpers.ts の注意書き参照）。
    // 検索はその場で backend を叩くので、import 後の再読込は不要。

    // MainScreen で先頭シリーズを選び、別ウィンドウの 2D Viewer を開く。
    const mainPage = driver.page;
    // Vite の初回 optimizeDeps が遅く、Electron 側が先に load を終えて白紙のままになることがある
    // （実際に 2 回踏んだ）。1 度だけ reload して待ち直す。
    mainPage.on("console", (m) => {
      if (m.type() === "error") console.log(`  [renderer error] ${m.text()}`);
    });
    try {
      await mainPage.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 30_000 });
    } catch {
      console.log(`  MainScreen が出ないので reload して待ち直す（url=${mainPage.url()}）`);
      await mainPage.reload({ waitUntil: "domcontentloaded" });
      await mainPage.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    }
    await openFirstSeriesInViewer(mainPage, recorder);
    viewerPage = await driver.waitForNewPage(
      () => mainPage.getByTestId("viewer2d-toolbar-button").click(),
      (url) => url.includes("2dviewer"),
    );
    await viewerPage.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 15_000 });
    await viewerPage.waitForTimeout(2000);

    // --- 1 回目 ---
    console.log("\n[1] 既定表示で getTargets() / getViewState()");
    const first = await runPlugin(viewerPage);
    console.log(JSON.stringify(first, null, 2));
    await viewerPage.screenshot({ path: path.join(OUT_DIR, "1-initial.png") });

    check(first.targets.length === 1, "対象タイルが 1 件（単一タイル表示）", first.targets.length);
    const t0 = first.targets[0];
    check(!!t0?.tileId, "tileId が空でない", t0?.tileId);
    check(/^\d+(\.\d+)+$/.test(t0?.studyUid ?? ""), "studyUid が DICOM UID 形式", t0?.studyUid);
    check(/^\d+(\.\d+)+$/.test(t0?.seriesUid ?? ""), "seriesUid が DICOM UID 形式", t0?.seriesUid);
    check(t0?.modality === "CT", "modality が CT（ct-basic fixture）", t0?.modality);
    check(t0?.sliceCount === 50, "sliceCount が 50（fixture の枚数）", t0?.sliceCount);
    check(t0?.sliceIndex === 0, "初期 sliceIndex が 0", t0?.sliceIndex);
    check(!!t0?.imageId, "imageId を返す", t0?.imageId);
    check(t0?.c === 0 && t0?.t === 0, "単純シリーズは c=t=0", { c: t0?.c, t: t0?.t });
    check(!!t0?.seriesLabel, "seriesLabel が空でない", t0?.seriesLabel);

    const s0 = first.states[0];
    check(!!s0, "getViewState(tileId) が値を返す");
    check(s0?.unit === "HU", "CT の unit が HU", s0?.unit);
    check((s0?.windowWidth ?? 0) > 0, "windowWidth > 0", s0?.windowWidth);
    check(s0?.colormap === null, "LUT 未適用は colormap=null", s0?.colormap);
    check(s0?.invert === false, "初期 invert=false", s0?.invert);
    check(Math.abs((s0?.zoom ?? 0) - 1) < 0.05, "Fit 直後の zoom ≒ 1.0", s0?.zoom);
    check(first.defaultState?.tileId === t0?.tileId, "tileId 省略時は対象の先頭タイル", first.defaultState?.tileId);
    check(first.unknownTile === null, "未知の tileId は null（例外にしない）", first.unknownTile);

    // --- 表示を変える: スライス送り ＋ W/L プリセット ＋ 階調反転 ---
    // （invert / LUT のメニュー項目には testId が無いのでラベル文字列で掴む＝ja ロケール前提）
    console.log("\n[2] スライス送り・W/L プリセット・階調反転を適用してから再実行");
    const slider = viewerPage.getByTestId("dim-slider-z");
    await slider.fill("12");
    await viewerPage.waitForTimeout(400);

    await viewerPage.getByTestId("viewer2d-menu-image").click();
    await viewerPage.getByTestId("viewer2d-menu-wl-preset").hover();
    const presetIds = await viewerPage
      .locator('[data-testid^="wl-preset-"]')
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));
    const targetPreset = presetIds.find((id) => id && id !== "wl-preset-default") ?? "wl-preset-default";
    await viewerPage.getByTestId(targetPreset).click();
    await viewerPage.waitForTimeout(400);
    console.log(`  W/L プリセット: ${targetPreset}（候補 ${presetIds.length} 件）`);

    await viewerPage.getByTestId("viewer2d-menu-image").click();
    // ロケール（ja/en）どちらでも掴めるように両方の表記を許す。
    const invertItem = viewerPage.getByRole("button", { name: /^(階調反転|Invert)$/ });
    let invertApplied = false;
    if (await invertItem.count()) {
      await invertItem.first().click();
      invertApplied = true;
    } else {
      const names = await viewerPage
        .getByRole("button")
        .evaluateAll((els) => els.map((e) => e.textContent?.trim()).filter(Boolean));
      console.log(`  [skip] 階調反転の項目が見つかりません。見えているボタン: ${JSON.stringify(names)}`);
      await viewerPage.keyboard.press("Escape");
    }
    await viewerPage.waitForTimeout(400);

    const second = await runPlugin(viewerPage);
    console.log(JSON.stringify(second, null, 2));
    await viewerPage.screenshot({ path: path.join(OUT_DIR, "2-after-change.png") });

    const t1 = second.targets[0];
    const s1 = second.states[0];
    check(t1?.sliceIndex === 12, "送った先の sliceIndex を返す（毎回読み直している）", t1?.sliceIndex);
    check(t1?.imageId !== t0?.imageId, "imageId も追従して変わる", { before: t0?.imageId, after: t1?.imageId });
    check(t1?.seriesUid === t0?.seriesUid, "シリーズは変わらない", t1?.seriesUid);
    check(
      s1?.windowWidth !== s0?.windowWidth || s1?.windowCenter !== s0?.windowCenter,
      "W/L プリセット適用後の W/L を返す",
      { before: [s0?.windowWidth, s0?.windowCenter], after: [s1?.windowWidth, s1?.windowCenter], preset: targetPreset },
    );
    check(s1?.unit === "HU", "unit は HU のまま", s1?.unit);
    if (invertApplied) check(s1?.invert === true, "階調反転が invert=true として見える", s1?.invert);

    // --- LUT を当てて colormap を確認（LUT ダイアログ: 行を選択 → 適用） ---
    console.log("\n[3] LUT を適用してから再実行");
    await viewerPage.getByTestId("viewer2d-menu-image").click();
    await viewerPage.getByRole("button", { name: /^LUT/ }).first().click();
    await viewerPage.getByTestId("lut-dialog").waitFor({ state: "visible", timeout: 10_000 });
    // LutRow は data-lut 属性を持つ（"__gray__" がグレースケール行）。最初の実 LUT を選ぶ。
    const lutRows = viewerPage.locator('[data-testid="lut-dialog"] [data-lut]:not([data-lut="__gray__"])');
    await lutRows.first().waitFor({ state: "visible", timeout: 15_000 });
    const lutName = await lutRows.first().getAttribute("data-lut");
    console.log(`  選んだ LUT: ${lutName}`);
    await lutRows.first().click();
    await viewerPage.getByTestId("lut-apply-button").click();
    await viewerPage.waitForTimeout(800);
    const third = await runPlugin(viewerPage);
    await viewerPage.screenshot({ path: path.join(OUT_DIR, "3-after-lut.png") });
    console.log(JSON.stringify(third.states[0], null, 2));
    check(!!third.states[0]?.colormap, "LUT 適用後は colormap 名を返す", third.states[0]?.colormap);
    check(
      third.states[0]?.colormap === lutName,
      "内部登録名（graphy-lut- 接頭辞）ではなくユーザーが選んだ LUT 名を返す",
      { expected: lutName, actual: third.states[0]?.colormap },
    );
  } finally {
    await viewerPage?.close().catch(() => {});
    await driver.stop();
  }

  console.log("\n=== 結果 ===");
  if (failures.length === 0) {
    console.log(`すべて OK。スクリーンショット: ${OUT_DIR}`);
  } else {
    console.log(`FAIL ${failures.length} 件:`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  }
}

await main();
