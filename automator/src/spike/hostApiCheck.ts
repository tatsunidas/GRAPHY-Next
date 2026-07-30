/*
 * host API H1〜H5（fw/plugin-architecture.md §7）の実機検証スパイク。
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
 *   6. H3 の画素が定量値（HU）である＝ Rescale の二重適用が無い
 *   7. H4a/H4b: 値マップを本体が焼いて重ねる／派生シリーズが本当に DICOM になる
 *   8. H5: canvas 上で実際に計測を描き、getRois() がその mm 値・SOP UID・スライスを返す。
 *      ツール値（Cornerstone の world 計算）と形状からの算出（画素×spacing）が一致すること、
 *      Bidirectional には形状値を出さないこと、ROI 属性の名前空間往復と購読の解除。
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
import { dragOnCanvasHost } from "../common/pointerDrag.js";
import { createStepRecorder } from "../checklist/types.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";

interface Target {
  tileId: string;
  patientKey: string;
  studyUid: string;
  studyDate: string | null;
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
/** ui.js が計算して返す画素の要約（Float32Array 自体は evaluate 越しに運ばない）。 */
interface PixelSummary {
  imageId: string;
  sliceIndex: number;
  rows: number;
  cols: number;
  unit: string;
  spacing: (number | null)[];
  length: number;
  isFloat32: boolean;
  min: number;
  max: number;
  mean: number;
  center: number;
}
interface Payload {
  at: string;
  targets: Target[];
  states: (ViewState | null)[];
  defaultState: ViewState | null;
  unknownTile: ViewState | null;
  pixels: PixelSummary | null;
  pixelsSlice0: PixelSummary | null;
  pixelsOutOfRange: unknown;
  pixelsUnknownTile: unknown;
  overlay?: {
    shown: boolean;
    hit: number;
    mismatchRejected: boolean;
    unknownTileRejected: boolean;
  };
  /** H4b: 保存の結果（プラグインが受け取った戻り）。 */
  save?: { ok: boolean; cancelled?: boolean; seriesInstanceUid?: string; instanceCount?: number; error?: string };
  /** H4b: 幾何を偽装できないこと（格子不一致は拒否）。 */
  saveMismatch?: { ok: boolean; error?: string };
  /** H4b: NaN を含むのに background 未指定なら拒否されること。 */
  saveNoBackground?: { ok: boolean; error?: string };
  /** H5: ROI の読み出し。 */
  rois?: RoiSummary[];
  roisUnknownTile?: RoiSummary[];
  roiEvents?: number;
  roiMeta?: {
    wrote: boolean;
    readBack: Record<string, string>;
    merged: Record<string, string>;
    writeUnknownRoi: boolean;
    readUnknownRoi: Record<string, string>;
    subscribeFired: boolean;
    unsubscribeWorks: boolean;
  };
}

/** ui.js が返す ROI の要約（points 全体は運ばず、件数と検算値だけ返す）。 */
interface RoiSummary {
  roiUid: string;
  tool: string;
  label: string | null;
  tileId: string;
  studyUid: string;
  studyDate: string | null;
  seriesUid: string;
  sopInstanceUid: string | null;
  sliceIndex: number;
  zScope: number | "all" | null;
  c: number;
  t: number;
  pointCount: number;
  spacing: (number | null)[];
  measurements: {
    length?: number;
    shortAxis?: number;
    longAxisMm?: number;
    shortAxisMm?: number;
    longAxisEnds?: [[number, number], [number, number]];
    area?: number;
    mean?: number;
    stdDev?: number;
    min?: number;
    max?: number;
    unit?: string;
  };
  visible: boolean;
  /** プラグインが points×spacing から独立に計算した長径（本体の longAxisMm と一致すべき）。 */
  recomputedLongMm: number | null;
}

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "hostapi-check");
/** 検証用プラグインの原本（リポジトリ管理下）。H1〜H4a 用と H4b（保存）用の 2 本。 */
const PLUGIN_IDS = ["hostapi-check", "hostapi-save"];

/** 検証用プラグインを backend の plugins フォルダへ配置する（第三者プラグインの手置きと同じ形）。 */
function installVerificationPlugins(): void {
  for (const id of PLUGIN_IDS) {
    const src = path.join(AUTOMATOR_ROOT, "plugins", id);
    const dst = path.join(DESKTOP_RUN_DATA_DIR, "plugins", id);
    fs.mkdirSync(dst, { recursive: true });
    for (const name of fs.readdirSync(src)) {
      fs.copyFileSync(path.join(src, name), path.join(dst, name));
    }
    console.log(`検証用プラグインを配置: ${dst}`);
  }
}

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

interface SeriesRow {
  seriesInstanceUid: string;
  seriesDescription?: string;
  modality?: string;
  /** SeriesDto のフィールド名（枚数）。 */
  numberOfInstances?: number;
}

/** backend の保管庫を直接見る（UI 越しではなく「本当に DICOM になったか」を確かめるため）。 */
async function listSeries(httpPort: number, studyUid: string): Promise<SeriesRow[]> {
  const res = await fetch(`http://localhost:${httpPort}/api/studies/${encodeURIComponent(studyUid)}/series`);
  if (!res.ok) throw new Error(`series list failed: ${res.status}`);
  return (await res.json()) as SeriesRow[];
}

/** 生成シリーズの先頭インスタンスのタグダンプ。 */
async function instanceTags(
  httpPort: number,
  studyUid: string,
  seriesUid: string,
): Promise<Array<{ name?: string; value?: string }>> {
  const base = `http://localhost:${httpPort}/api/studies/${encodeURIComponent(studyUid)}/series/${encodeURIComponent(seriesUid)}`;
  const insts = (await (await fetch(`${base}/instances`)).json()) as Array<{ sopInstanceUid: string }>;
  const sop = insts[0]?.sopInstanceUid;
  if (!sop) throw new Error("no instance in created series");
  return (await (await fetch(`${base}/instances/${encodeURIComponent(sop)}/tags`)).json()) as Array<{
    name?: string;
    value?: string;
  }>;
}

/** 保存デモを起動する（ダイアログの応答は呼び出し側が行う）。戻りは payload。 */
function runSavePlugin(viewerPage: Page): Promise<Payload> {
  return (async () => {
    await viewerPage.evaluate(() => {
      delete (window as unknown as { __hostApiCheck?: unknown }).__hostApiCheck;
    });
    await viewerPage.getByTestId("viewer2d-menu-plugins").click();
    await viewerPage.getByTestId("plugin-item-hostapi-save").click();
    await viewerPage.waitForFunction(
      () => (window as unknown as { __hostApiCheck?: { save?: unknown } }).__hostApiCheck?.save !== undefined,
      undefined,
      { timeout: 30_000 },
    );
    return viewerPage.evaluate(
      () => (window as unknown as { __hostApiCheck: Payload }).__hostApiCheck,
    ) as Promise<Payload>;
  })();
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  // backend 起動前に置く（plugins は起動後も走査されるが、初回の /api/plugins に載せるため）。
  installVerificationPlugins();
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
    // H7: 患者キー（患者単位の記録を持つプラグインの鍵）。
    check(!!t0?.patientKey, "patientKey が空でない", t0?.patientKey);
    // H6: スタディの検査日。ISO の日付として解釈できる形で返ること。
    check(
      /^\d{4}-\d{2}-\d{2}$/.test(t0?.studyDate ?? ""),
      "studyDate が ISO 日付（YYYY-MM-DD）で返る",
      t0?.studyDate,
    );
    check(
      !Number.isNaN(Date.parse(t0?.studyDate ?? "")),
      "studyDate が実在する日付として解釈できる",
      t0?.studyDate,
    );

    const s0 = first.states[0];
    check(!!s0, "getViewState(tileId) が値を返す");
    check(s0?.unit === "HU", "CT の unit が HU", s0?.unit);
    check((s0?.windowWidth ?? 0) > 0, "windowWidth > 0", s0?.windowWidth);
    check(s0?.colormap === null, "LUT 未適用は colormap=null", s0?.colormap);
    check(s0?.invert === false, "初期 invert=false", s0?.invert);
    check(Math.abs((s0?.zoom ?? 0) - 1) < 0.05, "Fit 直後の zoom ≒ 1.0", s0?.zoom);
    check(first.defaultState?.tileId === t0?.tileId, "tileId 省略時は対象の先頭タイル", first.defaultState?.tileId);
    check(first.unknownTile === null, "未知の tileId は null（例外にしない）", first.unknownTile);

    // --- H3: 校正済み画素 ---
    console.log("\n[1-b] getPixelData()（H3）");
    const px = first.pixels;
    check(!!px, "getPixelData() が値を返す");
    check(px?.isFloat32 === true, "data が Float32Array", px?.isFloat32);
    check(px?.rows === 512 && px?.cols === 512, "rows/cols が 512×512（fixture）", { rows: px?.rows, cols: px?.cols });
    check(px?.length === (px?.rows ?? 0) * (px?.cols ?? 0), "length === rows*cols", px?.length);
    check(px?.unit === "HU", "unit が HU（校正済み＝表示 8bit ではない）", px?.unit);
    // 二重適用（preScale 済みに Rescale を再適用＝約 −1024 のずれ）の検出は**軟部組織の値**で行う。
    // 空気側で見ないのは、この fixture が GE の画素パディング（raw −2000 ＋ intercept −1024 =
    // −3024）を持ち、min が空気(−1000)ではなくパディング値になるため。
    check((px?.min ?? 0) <= -900, "min が空気/パディングの HU（≦ −900）", px?.min);
    check((px?.max ?? 0) > 200, "max が骨/造影域の HU（>200）", px?.max);
    check(
      (px?.center ?? -9999) > -200 && (px?.center ?? 9999) < 300,
      "腹部中央が軟部組織の HU（−200〜300）＝ Rescale の二重適用が無い",
      px?.center,
    );
    check(
      (px?.spacing?.[0] ?? 0) > 0 && (px?.spacing?.[1] ?? 0) > 0 && (px?.spacing?.[2] ?? 0) === 5,
      "spacing が [x, y, 5mm]（fixture は 5mm 等間隔）",
      px?.spacing,
    );
    check(px?.sliceIndex === 0, "既定は表示中スライス（index 0）", px?.sliceIndex);
    check(first.pixelsOutOfRange === null, "範囲外 sliceIndex は null（末尾へ丸めない）", first.pixelsOutOfRange);
    check(first.pixelsUnknownTile === null, "未知の tileId は null", first.pixelsUnknownTile);

    // --- H4a: オーバーレイ ---
    console.log("\n[1-c] showOverlay()（H4a）");
    check(first.overlay?.shown === true, "showOverlay() が受理される", first.overlay?.shown);
    check((first.overlay?.hit ?? 0) > 0, "閾値マスクに該当画素がある（骨/造影 >=300 HU）", first.overlay?.hit);
    check(first.overlay?.mismatchRejected === true, "格子が合わないマップは拒否（勝手に伸縮しない）", first.overlay?.mismatchRejected);
    check(first.overlay?.unknownTileRejected === true, "未知の tileId への showOverlay は false", first.overlay?.unknownTileRejected);
    const overlayCanvas = viewerPage.getByTestId("plugin-overlay-canvas");
    const overlayLabel = viewerPage.getByTestId("plugin-overlay-label");
    await overlayCanvas.waitFor({ state: "visible", timeout: 10_000 });
    check(await overlayCanvas.isVisible(), "オーバーレイのキャンバスが実際に描画されている");
    const labelText = (await overlayLabel.textContent())?.trim() ?? "";
    check(
      labelText.includes("Host API Check"),
      "出所ラベルにプラグイン名（マニフェストの表示名）が出る",
      labelText,
    );
    // キャンバスの中身を直接読む: 本体が本当にラスタライズしたか（可視要素の有無だけでは
    // 「透明なキャンバスが乗っているだけ」を見逃す）。α>0 の画素数がマスク該当数と一致するはず。
    const rasterized = await viewerPage.evaluate(() => {
      const c = document.querySelector('[data-testid="plugin-overlay-canvas"]') as HTMLCanvasElement | null;
      const ctx = c?.getContext("2d");
      if (!c || !ctx) return null;
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let opaque = 0;
      let colored = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] > 0) {
          opaque++;
          // Hot_Iron を当てているので、灰色（R=G=B）ではない画素があるはず。
          if (d[i] !== d[i + 1] || d[i + 1] !== d[i + 2]) colored++;
        }
      }
      return { width: c.width, height: c.height, opaque, colored };
    });
    check(rasterized?.width === 512 && rasterized?.height === 512, "オーバーレイのキャンバスがマップの格子サイズ", rasterized);
    check(
      rasterized?.opaque === first.overlay?.hit,
      "α>0 の画素数が閾値マスクの該当数と一致（本体が値マップを焼いている）",
      { canvasOpaque: rasterized?.opaque, maskHit: first.overlay?.hit },
    );
    check((rasterized?.colored ?? 0) > 0, "指定した LUT（Hot_Iron）で色が付いている", rasterized?.colored);

    // 画像矩形に重なっているか（base 画像より小さくなく、画面外でもない）。
    const canvasBox = await overlayCanvas.boundingBox();
    check((canvasBox?.width ?? 0) > 100 && (canvasBox?.height ?? 0) > 100, "オーバーレイが画像矩形の大きさで配置される", canvasBox);
    await viewerPage.screenshot({ path: path.join(OUT_DIR, "1c-overlay.png") });

    // --- 表示を変える: スライス送り ＋ W/L プリセット ＋ 階調反転 ---
    // （invert / LUT のメニュー項目には testId が無いのでラベル文字列で掴む＝ja ロケール前提）
    console.log("\n[2] スライス送り・W/L プリセット・階調反転を適用してから再実行");
    const slider = viewerPage.getByTestId("dim-slider-z");
    await slider.fill("12");
    await viewerPage.waitForTimeout(400);
    // オーバーレイは「出したスライス」に紐付く: 送った先では隠れる。
    const afterMoveVisible = await viewerPage.getByTestId("plugin-overlay-canvas").isVisible();
    check(afterMoveVisible === false, "別スライスへ送るとオーバーレイは隠れる", afterMoveVisible);
    await slider.fill("0");
    await viewerPage.waitForTimeout(400);
    const backVisible = await viewerPage.getByTestId("plugin-overlay-canvas").isVisible();
    check(backVisible === true, "元のスライスへ戻すとオーバーレイが再表示される", backVisible);
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
    // H3 も表示中スライスに追従し、明示指定なら別スライスを読める。
    check(second.pixels?.sliceIndex === 12, "getPixelData() も送った先のスライスを読む", second.pixels?.sliceIndex);
    // 出したスライスに紐付くので、別スライスでは隠れていること（送った先に他スライスの
    // 計算結果が重なって見えるのが最悪なので、そこを構造で防いでいることの確認）。
    // ※ この時点では 2 回目の実行で slice 12 のオーバーレイが出ているため、
    //   「隠れる」検証は slice 送り直後・再実行前に済ませてある（下の afterMoveVisible）。
    check(
      second.pixelsSlice0?.sliceIndex === 0 && second.pixelsSlice0?.imageId === px?.imageId,
      "sliceIndex 明示指定で別スライス（0 枚目）を読める",
      { sliceIndex: second.pixelsSlice0?.sliceIndex, sameImageIdAsFirstRun: second.pixelsSlice0?.imageId === px?.imageId },
    );
    check(
      second.pixels?.mean !== px?.mean,
      "別スライスなので画素統計も変わる",
      { slice0Mean: px?.mean, slice12Mean: second.pixels?.mean },
    );
    // W/L を変えても画素は変わらない（表示 8bit ではないことの確認）。
    check(
      second.pixelsSlice0?.mean === px?.mean,
      "W/L・階調反転を変えても同一スライスの画素値は不変（表示に影響されない）",
      { before: px?.mean, after: second.pixelsSlice0?.mean },
    );
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
    // --- H4b: 派生シリーズ保存（確認ダイアログ → 保管庫に実在するか） ---
    console.log("\n[4] saveDerivedSeries()（H4b）");
    const seriesBefore = await listSeries(driver.ports.http, t0!.studyUid);

    // 1) まず「拒否」を確認する（プラグインは黙って保存できない）。
    const cancelledPromise = runSavePlugin(viewerPage);
    await viewerPage.getByTestId("plugin-save-confirm").waitFor({ state: "visible", timeout: 10_000 });
    check(true, "保存前に確認ダイアログが出る（抑止不可）");
    const dlgText = (await viewerPage.getByTestId("plugin-save-confirm").textContent())?.replace(/\s+/g, " ") ?? "";
    // 保存を行うのは hostapi-save プラグイン（版 0.2.0）。host がマニフェストから注入する。
    check(
      dlgText.includes("Host API Save") && dlgText.includes("0.2.0"),
      "ダイアログにプラグイン名と版が出る",
      dlgText.slice(0, 160),
    );
    const shownDesc = (await viewerPage.getByTestId("plugin-save-description").textContent())?.trim() ?? "";
    check(shownDesc.startsWith("[Plugin] "), "ダイアログが保存後の接頭辞付き説明を見せる", shownDesc);
    await viewerPage.getByTestId("plugin-save-cancel").click();
    const cancelled = await cancelledPromise;
    check(cancelled.save?.cancelled === true, "拒否すると cancelled が返る", cancelled.save);
    const seriesAfterCancel = await listSeries(driver.ports.http, t0!.studyUid);
    check(
      seriesAfterCancel.length === seriesBefore.length,
      "拒否したときシリーズは作られない",
      { before: seriesBefore.length, after: seriesAfterCancel.length },
    );

    // 2) 承諾して保存する。
    const savedPromise = runSavePlugin(viewerPage);
    await viewerPage.getByTestId("plugin-save-confirm").waitFor({ state: "visible", timeout: 10_000 });
    await viewerPage.screenshot({ path: path.join(OUT_DIR, "4-save-confirm.png") });
    await viewerPage.getByTestId("plugin-save-confirm-button").click();
    const saved = await savedPromise;
    console.log(JSON.stringify(saved.save, null, 2));
    check(saved.save?.ok === true, "承諾すると保存が成功する", saved.save);
    check(saved.save?.instanceCount === 1, "保存された枚数が要求どおり", saved.save?.instanceCount);
    check(saved.saveMismatch?.ok === false, "格子が合わないフレームは拒否（幾何を偽装できない）", saved.saveMismatch);
    check(
      saved.saveNoBackground?.ok === false && /background/.test(saved.saveNoBackground?.error ?? ""),
      "NaN を含むのに background 未指定なら拒否（背景を勝手に決めない）",
      saved.saveNoBackground,
    );

    // 3) 保管庫に実在するか（＝本当に DICOM になったか）を backend の一覧で確認する。
    const seriesAfter = await listSeries(driver.ports.http, t0!.studyUid);
    const created = seriesAfter.find((x) => x.seriesInstanceUid === saved.save?.seriesInstanceUid);
    check(!!created, "保管庫のシリーズ一覧に現れる", { uid: saved.save?.seriesInstanceUid, count: seriesAfter.length });
    check(
      (created?.seriesDescription ?? "").startsWith("[Plugin] "),
      "SeriesDescription に [Plugin] 接頭辞が付く（一覧で人が気付ける）",
      created?.seriesDescription,
    );
    check(created?.numberOfInstances === 1, "インスタンス数が 1", created?.numberOfInstances);
    check(created?.modality === "CT", "モダリティは元シリーズを維持", created?.modality);

    // 4) DICOM タグを読み、出所と Rescale が残っているか確認する。
    const tags = await instanceTags(driver.ports.http, t0!.studyUid, created!.seriesInstanceUid);
    const tagValue = (keyword: string) => tags.find((r) => r.name === keyword)?.value ?? "";
    check(/DERIVED/.test(tagValue("ImageType")), "ImageType が DERIVED", tagValue("ImageType"));
    check(
      /hostapi-save/.test(tagValue("DerivationDescription")),
      "DerivationDescription にプラグイン id が入る",
      tagValue("DerivationDescription"),
    );
    check(
      tags.some((r) => /ContributingEquipment/.test(r.name ?? "")),
      "ContributingEquipmentSequence が書かれている",
    );
    // マスクは HU（整数）なので恒等 Rescale のはず（量子化誤差を足していない）。
    check(Number(tagValue("RescaleSlope")) === 1, "整数マスクは Rescale 恒等（量子化誤差を足さない）", tagValue("RescaleSlope"));
    check(Number(tagValue("RescaleIntercept")) === 0, "Rescale Intercept も恒等", tagValue("RescaleIntercept"));
    // 回帰: 背景（NaN 埋め）が「有効値の最小値」＝閾値の値に化けていた事故の検証。
    check(
      Number(tagValue("PixelPaddingValue")) === -1000,
      "背景がプラグイン指定の値（−1000）で、PixelPaddingValue にも書かれる",
      tagValue("PixelPaddingValue"),
    );
    // プラグイン出力はリスライスではないので RESLICE を付けない。
    check(
      tagValue("ImageType") === "DERIVED\\SECONDARY",
      "ImageType は DERIVED\\SECONDARY（RESLICE を付けない）",
      tagValue("ImageType"),
    );
    check(tagValue("RescaleType") === "HU", "RescaleType にプラグインが申告した単位が入る", tagValue("RescaleType"));
    // 元シリーズは変更されない（プラグインは新シリーズを足すだけ）。
    check(
      seriesAfter.length === seriesBefore.length + 1,
      "元シリーズは残り、新シリーズが 1 本増える",
      { before: seriesBefore.length, after: seriesAfter.length },
    );

    // --- H5: ユーザーが描いた ROI（計測）の読み出し ---
    // 実際に canvas 上でドラッグして注釈を作る（プラグインから ROI は作れない＝作らせない設計なので、
    // 読影医の操作をそのまま再現するしかない。これが本番と同じ経路）。
    console.log("\n[5] getRois()（H5）");

    // ROI が無い状態: 空配列を返すこと（null や例外ではない）。
    const beforeDraw = await runPlugin(viewerPage);
    check(Array.isArray(beforeDraw.rois) && beforeDraw.rois.length === 0, "ROI が無ければ空配列", beforeDraw.rois);
    check(beforeDraw.roiMeta === undefined, "ROI が無ければ属性の検証はスキップされる");

    // 現在のスライス（[2] で 12 に送ってある）と画素間隔を記録しておく。
    const drawSlice = beforeDraw.targets[0]?.sliceIndex ?? 0;
    const spX = beforeDraw.pixels?.spacing?.[0] ?? 0;
    const spY = beforeDraw.pixels?.spacing?.[1] ?? 0;

    // 1) Bidirectional（ROI メニューの「長径・短径（RECIST）」）— ユーザーが 2 軸を引く RECIST の標準計測。
    await viewerPage.getByTestId("viewer2d-menu-roi").click();
    const biItem = viewerPage.getByRole("button", { name: /長径・短径|Long\/short axis/ });
    const biFound = (await biItem.count()) > 0;
    check(biFound, "ROI メニューに「長径・短径（RECIST）」が出る（BidirectionalTool の登録）");
    if (biFound) {
      await biItem.first().click();
      await viewerPage.waitForTimeout(300);
      // 中央から水平に 120px ドラッグ（画面座標。画像画素との比は zoom 依存なので mm の期待値は
      // 決め打ちにせず、後段で「本体の値」と「プラグインの再計算」の一致で検証する）。
      // 始点を左上寄りにずらす（既定の中央から引くと、後続のドラッグが既存注釈のハンドルを掴む）。
      await dragOnCanvasHost(viewerPage, "viewer2d-canvas-host", 120, 0, 0, 10, { fracX: 0.25, fracY: 0.3 });
      await viewerPage.waitForTimeout(600);
    }

    // 2) 楕円 ROI — 形状から長径・短径を算出する側の経路。
    await viewerPage.getByTestId("viewer2d-menu-roi").click();
    const ellipseItem = viewerPage.getByRole("button", { name: /^(楕円 ROI|Ellipse ROI)$/ });
    if (await ellipseItem.count()) {
      await ellipseItem.first().click();
      await viewerPage.waitForTimeout(300);
      // Bidirectional から離れた位置に引く。
      await dragOnCanvasHost(viewerPage, "viewer2d-canvas-host", 80, 60, 0, 10, { fracX: 0.3, fracY: 0.6 });
      await viewerPage.waitForTimeout(600);
    }

    const drawn = await runPlugin(viewerPage);
    console.log(JSON.stringify(drawn.rois, null, 2));
    await viewerPage.screenshot({ path: path.join(OUT_DIR, "5-rois.png") });

    const rois = drawn.rois ?? [];
    check(rois.length === 2, "描いた 2 本の ROI が getRois() に現れる", rois.map((r) => r.tool));
    check((drawn.roiEvents ?? 0) > 0, "subscribeRois() が ROI 作成で発火した", drawn.roiEvents);
    check(
      Array.isArray(drawn.roisUnknownTile) && drawn.roisUnknownTile.length === 0,
      "未知の tileId は空配列（例外にしない）",
      drawn.roisUnknownTile,
    );

    for (const r of rois) {
      const tag = `[${r.tool}]`;
      check(!!r.roiUid, `${tag} roiUid が空でない`, r.roiUid);
      check(r.tileId === t0!.tileId, `${tag} tileId が対象タイル`, r.tileId);
      check(r.studyUid === t0!.studyUid, `${tag} studyUid が一致`, r.studyUid);
      check(r.seriesUid === t0!.seriesUid, `${tag} seriesUid が一致`, r.seriesUid);
      check(
        r.studyDate === t0!.studyDate,
        `${tag} ROI にもスタディの検査日が付く（getTargets と一致）`,
        { roi: r.studyDate, target: t0!.studyDate },
      );
      check(
        /^\d+(\.\d+)+$/.test(r.sopInstanceUid ?? ""),
        `${tag} sopInstanceUid が DICOM UID（時系列で ROI を再同定する鍵）`,
        r.sopInstanceUid,
      );
      check(r.sliceIndex === drawSlice, `${tag} 描いたスライスの index を返す`, { got: r.sliceIndex, expected: drawSlice });
      check(r.c === 0 && r.t === 0, `${tag} c=t=0`, { c: r.c, t: r.t });
      check(r.pointCount >= 2, `${tag} 頂点が 2 点以上`, r.pointCount);
      check(r.visible === true, `${tag} visible=true`, r.visible);
      check(
        Math.abs((r.spacing[0] ?? 0) - spX) < 1e-9 && Math.abs((r.spacing[1] ?? 0) - spY) < 1e-9,
        `${tag} spacing が getPixelData() と同じ面内間隔`,
        { roi: r.spacing, pixels: [spX, spY] },
      );
    }

    // Bidirectional: **ツール値だけ**が正しい。形状からの長径・短径は出さない
    // （交差する 2 線分なので、短軸を長軸の端に寄せるとハンドル間の最遠距離が長軸を超える）。
    const bi0 = rois.find((r) => /bidirectional/i.test(r.tool));
    if (bi0) {
      check(
        bi0.measurements.longAxisMm === undefined && bi0.measurements.shortAxisMm === undefined,
        "Bidirectional には形状からの長径・短径を出さない（ツール値だけが正しい）",
        { long: bi0.measurements.longAxisMm, short: bi0.measurements.shortAxisMm },
      );
    }

    // 輪郭ツール（楕円）: 形状からの長径・短径が返り、プラグイン側の再計算と一致する。
    // **部分一致で絞らない**: Bidi**rect**ional が `rect` に一致してしまう（本体側でも同じ罠を踏んだ）。
    const OUTLINE_TOOL_NAMES = new Set([
      "Length",
      "EllipticalROI",
      "RectangleROI",
      "CircleROI",
      "PlanarFreehandROI",
      "SplineROI",
    ]);
    for (const r of rois.filter((x) => OUTLINE_TOOL_NAMES.has(x.tool))) {
      const tag = `[${r.tool}]`;
      check((r.measurements.longAxisMm ?? 0) > 0, `${tag} longAxisMm > 0`, r.measurements.longAxisMm);
      check(
        (r.measurements.shortAxisMm ?? -1) >= 0 &&
          (r.measurements.shortAxisMm ?? 9e9) <= (r.measurements.longAxisMm ?? 0) + 1e-6,
        `${tag} shortAxisMm は 0 以上で longAxisMm 以下`,
        { long: r.measurements.longAxisMm, short: r.measurements.shortAxisMm },
      );
      // **本体の算出とプラグインの再計算が一致する**＝ points（画素座標）と spacing の意味が合っている。
      check(
        r.recomputedLongMm !== null &&
          Math.abs(r.recomputedLongMm - (r.measurements.longAxisMm ?? 0)) < 1e-6,
        `${tag} longAxisMm が points×spacing の再計算と一致（座標系の意味が合っている）`,
        { host: r.measurements.longAxisMm, recomputed: r.recomputedLongMm },
      );
      check(!!r.measurements.longAxisEnds, `${tag} longAxisEnds を返す`, r.measurements.longAxisEnds);
    }

    // Bidirectional は**ツール自身の 2 軸**を持ち、それが形状からの算出値と概ね一致するはず
    // （長軸はユーザーが引いた線＝形状の最遠 2 点でもあるため）。2 系統が別物として返ることの確認。
    const bi = rois.find((r) => /bidirectional/i.test(r.tool));
    if (bi) {
      check((bi.measurements.length ?? 0) > 0, "Bidirectional はツール値 length を持つ", bi.measurements.length);
      check((bi.measurements.shortAxis ?? 0) > 0, "Bidirectional はツール値 shortAxis を持つ", bi.measurements.shortAxis);
      check(
        (bi.measurements.shortAxis ?? 9e9) <= (bi.measurements.length ?? 0) + 1e-6,
        "Bidirectional の短軸は長軸以下",
        { length: bi.measurements.length, shortAxis: bi.measurements.shortAxis },
      );
      // 統計の単位欄に**長さの単位 mm が漏れていない**こと（実機で踏んだ）。
      check(
        bi.measurements.unit === undefined || bi.measurements.unit === "HU",
        "統計の単位欄に長さの単位（mm）が入らない",
        bi.measurements.unit,
      );
    } else {
      check(false, "Bidirectional の ROI が読めた", rois.map((r) => r.tool));
    }

    check(
      rois.filter((x) => OUTLINE_TOOL_NAMES.has(x.tool)).length === 1,
      "輪郭ツールの ROI が 1 本読めている（フィルタが空振りしていない）",
      rois.map((r) => r.tool),
    );

    const ell = rois.find((r) => r.tool === "EllipticalROI");
    if (ell) {
      check((ell.measurements.area ?? 0) > 0, "楕円 ROI は面積 (mm²) を返す", ell.measurements.area);
      check(ell.measurements.mean !== undefined, "楕円 ROI は ROI 内の平均値を返す", ell.measurements.mean);
      check(ell.measurements.unit === "HU", "統計の単位が HU（モダリティ値）", ell.measurements.unit);
      check(
        ell.measurements.length === undefined,
        "面 ROI にツール値の length は無い（0 で埋めない）",
        ell.measurements.length,
      );
    }

    // ROI 属性（プラグイン名前空間）の往復と購読解除。
    check(drawn.roiMeta?.wrote === true, "setRoiMeta() が受理される", drawn.roiMeta?.wrote);
    check(
      drawn.roiMeta?.readBack?.trackingId === "1" && drawn.roiMeta?.readBack?.lymphNode === "true",
      "getRoiMeta() が書いた値をそのまま返す（接頭辞は剥がれる）",
      drawn.roiMeta?.readBack,
    );
    check(
      drawn.roiMeta?.merged?.trackingId === "2" && drawn.roiMeta?.merged?.lymphNode === "true",
      "setRoiMeta はマージ更新（指定キーだけ変わり、他は残る）",
      drawn.roiMeta?.merged,
    );
    check(drawn.roiMeta?.writeUnknownRoi === false, "存在しない ROI への setRoiMeta は false", drawn.roiMeta?.writeUnknownRoi);
    check(
      JSON.stringify(drawn.roiMeta?.readUnknownRoi ?? null) === "{}",
      "存在しない ROI の getRoiMeta は空オブジェクト",
      drawn.roiMeta?.readUnknownRoi,
    );
    check(drawn.roiMeta?.subscribeFired === true, "属性の書き込みでも購読が発火する", drawn.roiMeta?.subscribeFired);
    check(drawn.roiMeta?.unsubscribeWorks === true, "解除すると以後発火しない", drawn.roiMeta?.unsubscribeWorks);

    // 別スライスへ送っても、ROI は**描いたスライス**を指し続けること（local ROI は追従しない）。
    await slider.fill("20");
    await viewerPage.waitForTimeout(500);
    const moved = await runPlugin(viewerPage);
    check(moved.targets[0]?.sliceIndex === 20, "スライスを 20 へ送った", moved.targets[0]?.sliceIndex);
    const movedRois = moved.rois ?? [];
    check(movedRois.length === rois.length, "別スライスでも ROI は列挙される（スタック単位）", movedRois.length);
    check(
      movedRois.every((r) => r.sliceIndex === drawSlice),
      "ROI の sliceIndex は描いたスライスのまま（表示スライスに追従しない）",
      movedRois.map((r) => r.sliceIndex),
    );
    check(
      movedRois.every((r) => r.zScope !== "all"),
      "既定はローカル ROI（zScope !== 'all'）",
      movedRois.map((r) => r.zScope),
    );
    await viewerPage.screenshot({ path: path.join(OUT_DIR, "5b-rois-other-slice.png") });
  } finally {
    await viewerPage?.close().catch(() => {});
    await driver.stop();
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
