/*
 * リリースごとの操作ガイド（PDF）を作る。fw/release-checklist.md の手順から呼ぶ。
 *
 * 実行:  cd automator && npm run guide -- v0.3.5
 *
 * 1. backend（standalone・認証なし）＋ Vite ＋ headless Chromium を起動し、デモと同じデータ
 *    （既定 ~/graphy-demo-samples/HCC_001）を取り込む
 * 2. src/guide/scenarios/<版>.ts の手順で画面を操作し、docs/release-guides/<版>/shots/ に撮る。
 *    番号を振る要素の位置も shots/marks.js に残し、guide.html がその上に ①② を重ねる
 * 3. docs/release-guides/<版>/guide.html を 1920×1080 のページで PDF にする
 *    → docs/release-guides/<版>.pdf
 *
 * 撮影だけ／PDF だけをやり直すときは --shots-only / --pdf-only。
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Locator, type Page } from "@playwright/test";

import { WebDriver } from "../driver/webDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { waitForMainScreenReady } from "../checklist/items/shared/helpers.js";
import { dismissStartupDialogs } from "../common/dismissDialogs.js";

const GUIDES_DIR = path.resolve(AUTOMATOR_ROOT, "..", "docs", "release-guides");
const DATA_DIR = process.env.GRAPHY_GUIDE_DATA ?? path.join(process.env.HOME ?? "", "graphy-demo-samples");
// 縮小して載せても文字が読めるよう、画面は小さめに撮り、画素は 2 倍で持つ。
const SCREEN = { width: 1280, height: 720 };

export interface Mark {
  x: number;
  y: number;
  w: number;
  h: number;
  /** 番号を枠のどちらに出すか。部品が縦に詰まっている所は left。 */
  side: "top" | "left";
}

/** 番号を振る要素。番号の位置を変えたいときは { at, side } で渡す。 */
export type MarkTarget = Locator | { at: Locator; side: Mark["side"] };

export interface GuideContext {
  main: Page;
  /** 患者 ID のスタディを開き、説明（Series Description）が一致するシリーズを選ぶ。 */
  selectSeries(patientId: string, description: string): Promise<void>;
  /** メイン画面のツールバーからビューアを開く（新しいタブ）。 */
  openViewer(title: "2D Viewer" | "MPR Viewer" | "3D Viewer", hash: string): Promise<Page>;
  /** 画面を撮る。marks の順に ①②… を振る。 */
  shot(page: Page, name: string, marks?: MarkTarget[]): Promise<void>;
}

export type Scenario = (ctx: GuideContext) => Promise<void>;

async function shoot(tag: string): Promise<void> {
  const scenarioFile = path.join(AUTOMATOR_ROOT, "src", "guide", "scenarios", `${tag}.ts`);
  if (!fs.existsSync(scenarioFile)) throw new Error(`シナリオがありません: ${scenarioFile}`);
  const scenario = (await import(pathToFileURL(scenarioFile).href)).default as Scenario;

  const shotsDir = path.join(GUIDES_DIR, tag, "shots");
  fs.rmSync(shotsDir, { recursive: true, force: true });
  fs.mkdirSync(shotsDir, { recursive: true });
  const marks: Record<string, { width: number; height: number; marks: Mark[] }> = {};

  const driver = new WebDriver({}, { viewport: SCREEN, locale: "ja-JP", deviceScaleFactor: 2 });
  try {
    await driver.start();
    await resetDb(driver.ports.http);
    const imported = await importPaths(driver.ports.http, [DATA_DIR]);
    console.log(`取り込み: ${imported.imported} 件（失敗 ${imported.failed}）`);
    const main = driver.page;
    await waitForMainScreenReady(main);

    const ctx: GuideContext = {
      main,
      async selectSeries(patientId, description) {
        const series = main.locator('[data-testid^="series-row-"]', { hasText: description }).first();
        // 2 回目以降はシリーズ一覧が開いたまま。スタディ行を押し直すと一覧が閉じる。
        if (!(await series.isVisible())) {
          await dismissStartupDialogs(main);
          await main.getByTestId("search-patientid-input").fill(patientId);
          await main.getByTestId("search-allperiod-chip").click();
          await main.getByTestId("search-submit-button").click();
          await main.locator('[data-testid^="study-row-"]').first().click({ timeout: 20_000 });
        }
        await series.click({ timeout: 20_000 });
      },
      async openViewer(title, hash) {
        return driver.waitForNewPage(
          () => main.locator(`button[title="${title}"]`).click(),
          (url) => url.includes(hash),
        );
      },
      async shot(page, name, targets = []) {
        await page.screenshot({ path: path.join(shotsDir, `${name}.png`) });
        const boxes: Mark[] = [];
        for (const t of targets) {
          const { at, side } = "at" in t ? t : { at: t, side: "top" as const };
          const b = await at.boundingBox();
          if (!b) throw new Error(`${name}: 番号を振る要素が画面にありません: ${at}`);
          boxes.push({ x: b.x, y: b.y, w: b.width, h: b.height, side });
        }
        const vp = page.viewportSize() ?? SCREEN;
        marks[name] = { width: vp.width, height: vp.height, marks: boxes };
        console.log(`撮影: ${name}.png（番号 ${boxes.length}）`);
      },
    };
    await scenario(ctx);
  } finally {
    await driver.stop();
  }
  fs.writeFileSync(path.join(shotsDir, "marks.js"), `window.GUIDE_MARKS = ${JSON.stringify(marks, null, 2)};\n`);
}

async function renderPdf(tag: string): Promise<void> {
  const html = path.join(GUIDES_DIR, tag, "guide.html");
  if (!fs.existsSync(html)) throw new Error(`本文がありません: ${html}`);
  const out = path.join(GUIDES_DIR, `${tag}.pdf`);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    await page.goto(pathToFileURL(html).href, { waitUntil: "networkidle" });
    await page.evaluate(() => document.fonts.ready);
    await page.pdf({ path: out, width: "1920px", height: "1080px", printBackground: true });
  } finally {
    await browser.close();
  }
  console.log(`PDF: ${path.relative(process.cwd(), out)}`);
}

const [tag, flag] = process.argv.slice(2);
if (!tag || !/^v\d+\.\d+\.\d+$/.test(tag)) {
  console.error("使い方: npm run guide -- vX.Y.Z [--shots-only | --pdf-only]");
  process.exit(2);
}
if (flag !== "--pdf-only") await shoot(tag);
if (flag !== "--shots-only") await renderPdf(tag);
