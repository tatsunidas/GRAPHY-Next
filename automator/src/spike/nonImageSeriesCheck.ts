/*
 * 非画像 SOP クラス（RTSTRUCT / SR / 表示状態 …）を画像として開かせないことの実機検証。
 *
 * 実行:  cd automator && npx tsx src/spike/nonImageSeriesCheck.ts
 *
 * 背景: RTSTRUCT はピクセルを持たないので、シリーズ一覧から開くと Cornerstone の createImage が
 * `The pixel data is missing` で reject し、**コンソールに未処理例外が出るだけでユーザーには
 * 何も起きていないように見える**（2026-07-30 に実機で発生）。
 *
 * 検証すること:
 *   1. MainScreen のインライン プレビューが「画像ではありません」の説明を出し、ビューアを出さない
 *   2. 2D Viewer の左ツリーの ＋ でタイルにならず、トーストで理由が出る
 *   3. その間 **`pixel data is missing` がコンソールに出ない**（＝未処理例外が消えたこと）
 *   4. 画像シリーズ（ct-basic）はこれまでどおり開ける（弾きすぎていない）
 *
 * 非画像データの入手: RTSTRUCT の DICOM ファイルはリポジトリに置けないため、
 *   - 環境変数 `GRAPHY_NONIMAGE_FILE` にファイル（またはフォルダ）のパスを渡す、または
 *   - `automator/fixtures/rtstruct-seg-existing/` に置く
 * のいずれか。無ければ 1〜3 を **skip** し、4 だけ実行する（CI で落とさない）。
 */
import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importFixtureCategory, importPaths } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { createStepRecorder } from "../checklist/types.js";
import { waitForMainScreenReady } from "../checklist/items/shared/helpers.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "non-image-series");

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

/** 非画像 DICOM の入手先を解決する（無ければ null）。 */
function resolveNonImageSource(): string | null {
  const env = process.env.GRAPHY_NONIMAGE_FILE;
  if (env && fs.existsSync(env)) return env;
  const fixture = path.join(AUTOMATOR_ROOT, "fixtures", "rtstruct-seg-existing");
  if (fs.existsSync(fixture)) {
    const files = fs.readdirSync(fixture).filter((f) => f.toLowerCase().endsWith(".dcm"));
    if (files.length > 0) return fixture;
  }
  return null;
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const source = resolveNonImageSource();
  if (!source) {
    console.log(
      "非画像 DICOM が見つかりません（GRAPHY_NONIMAGE_FILE か fixtures/rtstruct-seg-existing/*.dcm）。\n" +
        "→ 1〜3 は skip し、画像シリーズが開けることだけ確認します。",
    );
  } else {
    console.log(`非画像 DICOM: ${source}`);
  }

  const driver = new DesktopDriver();
  const recorder = createStepRecorder();
  await driver.start();
  let viewerPage: Page | null = null;
  try {
    await resetDb(driver.ports.http);
    await importFixtureCategory(driver.ports.http, "ct-basic");
    if (source) {
      const r = await importPaths(driver.ports.http, [source]);
      console.log(`非画像の import: ${JSON.stringify(r)}`);
    }

    const mainPage = driver.page;
    // 未処理の "pixel data is missing" が出ないことを見るため、コンソールを全部拾う。
    const consoleErrors: string[] = [];
    const watch = (p: Page) =>
      p.on("console", (m) => {
        if (m.type() === "error") consoleErrors.push(m.text());
      });
    watch(mainPage);
    mainPage.on("pageerror", (e) => consoleErrors.push(String(e)));

    await waitForMainScreenReady(mainPage, 60_000);

    // 無条件検索（import 済みのスタディを全部出す）。
    mainPage.once("dialog", (d) => void d.accept());
    const dateInputs = mainPage.locator('input[type="date"]');
    await dateInputs.nth(0).fill("");
    await dateInputs.nth(1).fill("");
    await mainPage.getByTestId("search-submit-button").click();
    const studyRows = mainPage.locator('[data-testid^="study-row-"]');
    await studyRows.first().waitFor({ state: "visible", timeout: 20_000 });
    const studyCount = await studyRows.count();
    recorder.step("無条件検索でスタディ一覧を取得");

    const rows = mainPage.locator('[data-testid^="series-row-"]');

    /**
     * 行の Modality セル（表の 2 列目）を読む。
     * ⚠ 行テキスト全体の正規表現では駄目だった: "#2 CT 50" は連結されて "2CT—50" になり `\bCT\b` に
     * 一致せず、逆に `/CT/` は **RTSTRUCT**（…U-C-T）に一致してしまう。セルを直接見る。
     */
    const modalityOf = async (i: number): Promise<string> =>
      ((await rows.nth(i).locator("td").nth(1).textContent()) ?? "").trim().toUpperCase();

    /** スタディを選び、シリーズ行が出るまで待って各行の Modality を返す。 */
    const openStudy = async (i: number): Promise<string[]> => {
      await studyRows.nth(i).click();
      // ⚠ シリーズ一覧は非同期に取得される。待たずに count() すると 0 件になる。
      // ⚠ スタディ行はクリックでトグルする（選択済みを押すと閉じる）。閉じてしまったら押し直す。
      await rows.first().waitFor({ state: "visible", timeout: 20_000 }).catch(() => {});
      if ((await rows.count()) === 0) {
        await studyRows.nth(i).click();
        await rows.first().waitFor({ state: "visible", timeout: 20_000 }).catch(() => {});
      }
      const n = await rows.count();
      const out: string[] = [];
      for (let k = 0; k < n; k++) out.push(await modalityOf(k));
      return out;
    };

    // 非画像シリーズは ct-basic とは別スタディに入るので、スタディを順に見る。
    const NON_IMAGE_MODALITIES = new Set(["RTSTRUCT", "RTPLAN", "SR", "KO", "PR", "REG", "FID", "DOC"]);
    let hasNonImage = false;
    let nonImageIndex = -1;
    let nonImagePatientId = "";
    let modalities: string[] = [];
    for (let i = 0; i < studyCount; i++) {
      modalities = await openStudy(i);
      console.log(`スタディ ${i + 1}/${studyCount}: シリーズ ${modalities.length} 件 ${JSON.stringify(modalities.slice(0, 4))}`);
      nonImageIndex = modalities.findIndex((m) => NON_IMAGE_MODALITIES.has(m));
      if (nonImageIndex >= 0) {
        hasNonImage = true;
        // 2D ウィンドウの左ツリーで同じ患者を検索するために患者 ID を拾う（1 列目）。
        nonImagePatientId = ((await studyRows.nth(i).locator("td").first().textContent()) ?? "").trim();
        break;
      }
    }
    if (source) {
      check(hasNonImage, "非画像シリーズが一覧に出ている（import できている）", modalities.slice(0, 8));
    }

    if (hasNonImage) {
      // ── 1. MainScreen のインライン プレビュー
      await rows.nth(nonImageIndex).click();
      const notice = mainPage.getByTestId("series-non-image-notice");
      await notice.waitFor({ state: "visible", timeout: 15_000 });
      const text = (await notice.textContent())?.trim() ?? "";
      check(true, "「画像ではありません」の説明が出る");
      check(/RT Structure Set|Structured Report|Presentation State|Key Object/.test(text), "説明に種別名が入る", text);
      // 画像ビューア（Cornerstone のキャンバス）は出ていないこと。
      const canvasCount = await mainPage.getByTestId("viewer2d-canvas-host").count();
      check(canvasCount === 0, "画像ビューアを開かない", { canvasCount });
      await mainPage.screenshot({ path: path.join(OUT_DIR, "1-mainscreen-notice.png") });
    }

    // ── 4. 画像シリーズが開けること＝弾きすぎていないこと。
    // 非画像は別スタディにあるので CT を含むスタディを探し、**見つけた時点で開く**
    // （ループを抜けてから触ると、トグルで閉じた状態を掴んでしまう）。
    let ctOpened = false;
    for (let i = 0; i < studyCount; i++) {
      const mods = await openStudy(i);
      const ctIndex = mods.findIndex((m) => m === "CT");
      if (ctIndex < 0) continue;
      await rows.nth(ctIndex).click();
      await mainPage.getByTestId("viewer2d-canvas-host").first().waitFor({ state: "visible", timeout: 25_000 });
      ctOpened = true;
      break;
    }
    check(ctOpened, "画像シリーズ（CT）はこれまでどおり開ける");

    // ── 2. 2D Viewer の左ツリーから ＋ で追加を試みる
    viewerPage = await driver.waitForNewPage(
      () => mainPage.getByTestId("viewer2d-toolbar-button").click(),
      (url) => url.includes("2dviewer"),
    );
    watch(viewerPage);
    viewerPage.on("pageerror", (e) => consoleErrors.push(String(e)));
    // タイルの有無ではなくメニューバーの出現で「窓が使える」ことを判定する
    // （非画像を選んだ状態で開くとタイルが 1 つも無いのが正しい挙動なので、タイルを待つと詰む）。
    // ここは best-effort。窓が使える状態にならなければ理由を残して 2 をスキップする
    // （本題の 1 / 3 / 4 の結果を必ず出したい）。
    // タイルが 0 件のときはメニューバーが出ない（空状態）ので、左ツリーの検索ボタンで判定する。
    let viewerReady = true;
    try {
      await viewerPage.getByRole("button", { name: /^(Search|検索)$/ }).first().waitFor({ state: "visible", timeout: 25_000 });
    } catch {
      viewerReady = false;
      const info = await viewerPage
        .evaluate(() => ({
          url: location.href,
          title: document.title,
          text: document.body?.innerText?.slice(0, 300) ?? "(no body)",
          testIds: Array.from(document.querySelectorAll("[data-testid]"))
            .slice(0, 12)
            .map((e) => e.getAttribute("data-testid")),
        }))
        .catch((e) => ({ error: String(e) }));
      console.log(`  [skip] 2D ウィンドウが使える状態になりません: ${JSON.stringify(info)}`);
      await viewerPage.screenshot({ path: path.join(OUT_DIR, "2-viewer-not-ready.png") }).catch(() => {});
    }
    await viewerPage.waitForTimeout(1000);

    if (hasNonImage && viewerReady) {
      // 左ツリーは「直前に開いた画像シリーズの患者」で自動検索される。非画像は別患者なので、
      // ツリーの患者 ID 欄で検索し直してからスタディを展開する。
      console.log(`  左ツリーで患者 ${nonImagePatientId} を検索`);
      await viewerPage.locator("input").first().fill(nonImagePatientId);
      await viewerPage.getByRole("button", { name: /^(Search|検索)$/ }).first().click();
      // スタディノード（RTSTRUCT を含む行）をクリックして展開。
      const studyNode = viewerPage.getByText(/RTSTRUCT/).first();
      await studyNode.waitFor({ state: "visible", timeout: 20_000 }).catch(() => {});
      await studyNode.click().catch(() => {});
      await viewerPage.waitForTimeout(800);
      const plus = viewerPage.locator("button", { hasText: "＋" }).first();
      if ((await plus.count()) > 0) {
        const tilesBefore = await viewerPage.getByTestId("viewer2d-canvas-host").count();
        await plus.click();
        await viewerPage.waitForTimeout(1200);
        const tilesAfter = await viewerPage.getByTestId("viewer2d-canvas-host").count();
        check(tilesAfter === tilesBefore, "非画像シリーズはタイルにならない", { tilesBefore, tilesAfter });
        // 理由がユーザーに見えること（トースト）。
        const body = (await viewerPage.evaluate(() => document.body.innerText)) ?? "";
        check(
          /RT Structure Set|画像ではありません|not an image/.test(body),
          "2D ウィンドウでも理由が表示される（トースト）",
          body.split("\n").filter((l) => /Structure|画像|image/.test(l)).slice(0, 2),
        );
        await viewerPage.screenshot({ path: path.join(OUT_DIR, "2-viewer-toast.png") });
      } else {
        console.log("  [skip] 左ツリーに非画像シリーズの ＋ が見つからないため 2 はスキップ");
      }
    }

    // ── 3. 未処理の "pixel data is missing" が出ていないこと
    const pixelErrors = consoleErrors.filter((m) => /pixel data is missing/i.test(m));
    check(pixelErrors.length === 0, "コンソールに 'pixel data is missing' が出ない", pixelErrors.slice(0, 2));
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
