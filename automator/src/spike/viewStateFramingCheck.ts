/*
 * 「画面に見えている範囲」（host API H2 の `getViewState().visibleRegion`）が、
 * ビューアの**拡大・パン・回転に実際に追従しているか**を実機で測るスパイク。
 *
 * 実行:  cd automator && npx tsx src/spike/viewStateFramingCheck.ts
 *
 * ── なぜ要るか ────────────────────────────────────────────────────────────
 * Art of Imaging の「Image to be sent」は visibleRegion **だけ**を見て切り出す。
 * ここが画面と食い違っても**例外は出ず、送られる絵の構図が違うだけ**なので、
 * 画面を見ても出力を見ても気付けない。
 *
 * 🔴 実際に漏れた: 2026-09-24 に利用者から「拡大・パンニングの状態が Image to sent に
 *    引き継がれていない」と報告された。`artCheck.ts` は AI ゲートの検証しかしておらず、
 *    **表示状態が送信画像に載るかを 1 度も確認していなかった**。
 *    ここは「要素があること」ではなく「**操作して期待どおり動くこと**」を見る。
 *
 * ── 判定 ────────────────────────────────────────────────────────────────
 * `spanCols` = 見えている範囲が元画像の何画素ぶんか。拡大すれば**小さくなる**のが期待。
 * 変わらなければ切り出しが効いていない（＝報告された症状そのもの）。
 *
 * 前提: backend jar（`cd backend && mvn -q -Dfrontend.skip=true -DskipTests package`）と
 *       fixture（`npx tsx src/cli.ts check-fixtures`）。
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

const PLUGIN_ID = "viewstate-check";
/** 実物の Art of Imaging。H2 を**実際に使う側**が追従しているかまで見る。 */
const ART_PLUGIN_ID = "art";
const ART_PLUGIN_SRC = path.join(AUTOMATOR_ROOT, "..", "desktop", "plugins", "art");
/**
 * 検証に使う fixture。**XA も必ず回すこと**——幾何（IPP/IOP）を持たない系列で、
 * 過去に world 座標経由の変換が全滅している（`roiRead.ts` の注記）。
 *   FIXTURE=xa-angio npx tsx src/spike/viewStateFramingCheck.ts
 */
const FIXTURE = (process.env.FIXTURE ?? "ct-basic") as "ct-basic" | "xa-angio" | "xa-no-geometry";
const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "viewstate-framing", FIXTURE);

interface Sample {
  error?: string;
  modality?: string;
  zoom?: number;
  pan?: [number, number];
  rotation?: number;
  hasVisibleRegion?: boolean;
  corners?: [number, number][];
  screenWidth?: number;
  screenHeight?: number;
  spanCols?: number;
  spanRows?: number;
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

function copyPlugin(src: string, id: string): boolean {
  if (!fs.existsSync(src)) {
    console.log(`(スキップ) プラグインが見つかりません: ${src}`);
    return false;
  }
  const dst = path.join(DESKTOP_RUN_DATA_DIR, "plugins", id);
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) fs.copyFileSync(path.join(src, name), path.join(dst, name));
  console.log(`プラグインを配置: ${dst}`);
  return true;
}

function installPlugins(): boolean {
  copyPlugin(path.join(AUTOMATOR_ROOT, "plugins", PLUGIN_ID), PLUGIN_ID);
  // 実物の Art of Imaging は別リポジトリの成果物。導入済みなら一緒に検証する。
  return copyPlugin(ART_PLUGIN_SRC, ART_PLUGIN_ID);
}

/**
 * Art of Imaging の「Image to be sent」の実寸。
 *
 * <p>🔑 **プレビューの画素数そのものが答えになる。** 切り出しが効いていれば、拡大時は
 * 「覆っている画素数 × 画面の縦横比」になり、効いていなければ元画像の寸法のまま
 * （CT なら 512x512）。DOM の見た目ではなく `naturalWidth/Height` を読む。
 */
async function artPreviewSize(page: Page): Promise<{ w: number; h: number }> {
  return page.evaluate(() => {
    const img = document.querySelector('[data-testid="art-source-preview"]') as HTMLImageElement | null;
    return { w: img?.naturalWidth ?? 0, h: img?.naturalHeight ?? 0 };
  });
}

async function sample(page: Page, label: string): Promise<Sample> {
  const s = (await page.evaluate(() => {
    const f = (window as unknown as { __viewStateSample?: () => unknown }).__viewStateSample;
    return f ? f() : { error: "sampler not installed" };
  })) as Sample;
  console.log(
    `  [${label}] zoom=${s.zoom?.toFixed(3)} pan=[${s.pan?.map((n) => n.toFixed(1)).join(", ")}] ` +
      `rot=${s.rotation} region=${s.hasVisibleRegion} ` +
      `span=${s.spanCols}x${s.spanRows} screen=${s.screenWidth}x${s.screenHeight}`,
  );
  if (s.corners) console.log(`          corners=${JSON.stringify(s.corners)}`);
  return s;
}

/**
 * ダイアログがビューアの画像中央を覆っているか。
 *
 * <p>🔴 **覆っていたら、この機能は使えない。** 画面で構図を決めて送る機能なので、
 * 画像を掴めなければ拡大もパンもできない（掴んだつもりでパネルを掴む）。
 * 2026-09-24 の「拡大・パンが引き継がれない」という申告の実体がこれだった。
 */
async function dialogCoversImageCenter(page: Page): Promise<boolean> {
  const box = await page.getByTestId("viewer2d-canvas-host").first().boundingBox();
  const dialog = page.getByTestId("art-dialog");
  if (!box || !(await dialog.count())) return false;
  const d = await dialog.boundingBox();
  if (!d) return false;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  return cx >= d.x && cx <= d.x + d.width && cy >= d.y && cy <= d.y + d.height;
}

/**
 * ドラッグの起点。**開いているダイアログを避ける。**
 *
 * <p>⚠ Art of Imaging のパネルは `position: fixed` で画面中央（幅 620px）に出るため、
 * 画像の中心はパネルの下に隠れる。そこを掴むとビューアではなくパネルを掴んでしまい、
 * **拡大も パンも 1 ミリも起きない**——最初の実行でこれを「追従しない不具合」と
 * 読み違えかけた。前提条件（zoom が実際に変わったか）を必ず確認すること。
 */
async function dragAnchor(page: Page): Promise<{ x: number; y: number }> {
  const box = await page.getByTestId("viewer2d-canvas-host").first().boundingBox();
  if (!box) throw new Error("viewer2d-canvas-host の位置が取れません");
  const cy = box.y + box.height / 2;
  const dialog = page.getByTestId("art-dialog");
  if (await dialog.count()) {
    const d = await dialog.boundingBox();
    if (d) {
      // パネルの左側に十分な余白があればそこを、無ければ右側を使う。
      const leftRoom = d.x - box.x;
      const rightRoom = box.x + box.width - (d.x + d.width);
      if (leftRoom > 80) return { x: box.x + leftRoom / 2, y: cy };
      if (rightRoom > 80) return { x: d.x + d.width + rightRoom / 2, y: cy };
    }
  }
  return { x: box.x + box.width / 2, y: cy };
}

/** ビューアをドラッグする（Zoom=右, Pan=中ボタン）。起点はダイアログを避けて選ぶ。 */
async function dragOnImage(
  page: Page,
  button: "right" | "middle",
  dx: number,
  dy: number,
): Promise<void> {
  const { x: cx, y: cy } = await dragAnchor(page);
  await page.mouse.move(cx, cy);
  await page.mouse.down({ button });
  // 何度かに分けて動かす（1 回のジャンプだとツールが取りこぼすことがある）。
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(cx + (dx * i) / 8, cy + (dy * i) / 8);
    await page.waitForTimeout(20);
  }
  await page.mouse.up({ button });
  await page.waitForTimeout(400);
}

/** Fit へ戻す（ビューアのリセット。ツールの向きに依存しない）。 */
async function zoomOutToFit(page: Page): Promise<void> {
  await page.getByTestId("viewer2d-menu-image").click();
  const fit = page.getByTestId("menu-item-fit");
  if (await fit.count()) {
    await fit.click();
  } else {
    await page.keyboard.press("Escape");
  }
  await page.waitForTimeout(500);
}

/** 倍率が上がるまで引く（ドラッグの向きは環境依存なので両方試す）。 */
async function zoomIn(page: Page, baseZoom: number): Promise<void> {
  for (const dy of [220, -440, 440]) {
    await dragOnImage(page, "right", 0, dy);
    const z = (await page.evaluate(() => {
      const f = (window as unknown as { __viewStateSample?: () => { zoom?: number } }).__viewStateSample;
      return f ? f().zoom ?? 0 : 0;
    })) as number;
    if (z > baseZoom * 2) return;
  }
}

async function run(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const hasArt = installPlugins();

  const driver = new DesktopDriver();
  const recorder = createStepRecorder();
  await driver.start();
  let viewerPage: Page | null = null;
  try {
    await resetDb(driver.ports.http);
    console.log(`fixture = ${FIXTURE}`);
    await importFixtureCategory(driver.ports.http, FIXTURE);

    const mainPage = driver.page;
    mainPage.on("console", (m) => {
      if (m.type() === "error") console.log(`  [renderer error] ${m.text()}`);
    });
    await mainPage.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 30_000 });

    await openFirstSeriesInViewer(mainPage, recorder);
    viewerPage = await driver.waitForNewPage(
      () => mainPage.getByTestId("viewer2d-toolbar-button").click(),
      (url) => url.includes("2dviewer"),
    );
    viewerPage.on("console", (m) => {
      if (m.type() === "error") console.log(`  [viewer error] ${m.text()}`);
    });
    await viewerPage.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 15_000 });
    await viewerPage.waitForTimeout(2500);

    // サンプラーを仕込む（以降は page.evaluate でいつでも測れる）。
    await viewerPage.getByTestId("viewer2d-menu-plugins").click();
    await viewerPage.getByTestId(`plugin-item-${PLUGIN_ID}`).click();
    await viewerPage.waitForFunction(
      () => !!(window as unknown as { __viewStateSample?: unknown }).__viewStateSample,
      undefined,
      { timeout: 15_000 },
    );

    console.log("\n[1] 無操作（Fit）");
    const fit = await sample(viewerPage, "fit");
    await viewerPage.screenshot({ path: path.join(OUT_DIR, "1-fit.png") });
    check(fit.hasVisibleRegion === true, "🔴 本体が visibleRegion を出している", fit.error ?? fit);
    check(
      (fit.spanCols ?? 0) > 0 && (fit.spanRows ?? 0) > 0,
      "Fit で覆っている画素数が取れる",
      { spanCols: fit.spanCols, spanRows: fit.spanRows },
    );

    // 🔑 **Fit のうちに Art of Imaging を開く。** 利用者の申告は「開いたあとに拡大・パンしても
    //    反映されない」なので、**開いてから操作する**順序で測らないと再現しない
    //    （開く前に拡大しておくと、開いた時点の 1 回で正しく切り出されてしまう）。
    let fitPreview = { w: 0, h: 0 };
    if (hasArt) {
      console.log("\n[2] Art of Imaging を Fit の状態で開く");
      await viewerPage.getByTestId("viewer2d-menu-analysis").click();
      await viewerPage.getByTestId(`plugin-analysis-item-${ART_PLUGIN_ID}`).click();
      await viewerPage.getByTestId("art-dialog").waitFor({ state: "visible", timeout: 20_000 });
      await viewerPage.waitForTimeout(2500);
      fitPreview = await artPreviewSize(viewerPage);
      console.log(`  プレビュー実寸: ${fitPreview.w}x${fitPreview.h}`);
      await viewerPage.screenshot({ path: path.join(OUT_DIR, "2-art-fit.png") });
      check(fitPreview.w > 0 && fitPreview.h > 0, "Image to be sent が出ている", fitPreview);
      check(
        !(await dialogCoversImageCenter(viewerPage)),
        "🔴 ダイアログが画像の中央を覆っていない（覆うと構図を決める操作ができない）",
      );
    }

    console.log("\n[3] 開いたまま拡大（右ドラッグ＝ZoomTool）");
    await zoomIn(viewerPage, fit.zoom ?? 1);
    const zoomed = await sample(viewerPage, "zoomed");
    await viewerPage.screenshot({ path: path.join(OUT_DIR, "3-zoomed.png") });
    check(
      (zoomed.zoom ?? 0) > (fit.zoom ?? 0) * 1.5,
      "ビューアが実際に拡大している（前提条件）",
      { before: fit.zoom, after: zoomed.zoom },
    );
    check(
      (zoomed.spanCols ?? 0) < (fit.spanCols ?? 0) * 0.9,
      "本体: 拡大すると、見えている範囲（覆う画素数）が狭くなる",
      { before: fit.spanCols, after: zoomed.spanCols },
    );

    let zoomedPreview = { w: 0, h: 0 };
    if (hasArt) {
      // 追従は 300ms ポーリング。余裕をみて待つ。
      await viewerPage.waitForTimeout(2500);
      zoomedPreview = await artPreviewSize(viewerPage);
      console.log(`  プレビュー実寸: ${zoomedPreview.w}x${zoomedPreview.h}`);
      await viewerPage.screenshot({ path: path.join(OUT_DIR, "4-art-zoomed.png") });
      check(
        zoomedPreview.w !== fitPreview.w || zoomedPreview.h !== fitPreview.h,
        "🔴 開いたまま拡大すると Image to be sent が追従する",
        { fit: fitPreview, zoomed: zoomedPreview },
      );
      const screenAspect = (zoomed.screenWidth ?? 1) / (zoomed.screenHeight ?? 1);
      const previewAspect = zoomedPreview.w / Math.max(1, zoomedPreview.h);
      check(
        Math.abs(previewAspect - screenAspect) < 0.15,
        "🔴 プレビューが画面に見えている範囲の縦横比になっている",
        { previewAspect: Number(previewAspect.toFixed(3)), screenAspect: Number(screenAspect.toFixed(3)) },
      );
    }

    console.log("\n[4] 開いたままパン（中ボタンドラッグ＝PanTool）");
    const beforePan = zoomed;
    await dragOnImage(viewerPage, "middle", 140, 0);
    const panned = await sample(viewerPage, "panned");
    await viewerPage.screenshot({ path: path.join(OUT_DIR, "5-panned.png") });
    check(
      Math.abs((panned.pan?.[0] ?? 0) - (beforePan.pan?.[0] ?? 0)) > 1,
      "ビューアが実際にパンしている（前提条件）",
      { before: beforePan.pan, after: panned.pan },
    );
    // ⚠ 端まで寄せると左端が画像の外形に張り付く（corners[0] が -0.5 のまま）。
    //    位置ではなく**中心**で見る——張り付いていても中心は動く。
    const centerX = (s: Sample) =>
      s.corners ? (s.corners[0][0] + s.corners[1][0]) / 2 : NaN;
    check(
      Math.abs(centerX(panned) - centerX(beforePan)) > 1,
      "本体: パンすると、見えている範囲の中心が動く",
      { before: centerX(beforePan), after: centerX(panned) },
    );

    fs.writeFileSync(
      path.join(OUT_DIR, "samples.json"),
      JSON.stringify({ fit, zoomed, panned }, null, 2),
      "utf8",
    );
  } finally {
    await driver.stop();
  }

  console.log(`\n結果: ${passed} ok / ${failures.length} fail`);
  for (const f of failures) console.log(`  - ${f}`);
  if (failures.length) process.exitCode = 1;
}

run().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
