/*
 * ROI 特徴量の設定欄（ROI 特徴量の画面・一括抽出ダイアログ）の data-testid の集合と見出しの文言の回帰スパイク。
 * 共通の部品に載せ替えても、欄の集合・文言・並びが変わらないことを、実アプリの画面で確かめる。
 *
 * 実行:  cd automator && GRAPHY_AUTOMATOR_HTTP_PORT=18290 GRAPHY_AUTOMATOR_SCP_PORT=18291 \
 *          GRAPHY_AUTOMATOR_VITE_PORT=18293 timeout 600 npx tsx src/spike/roiFeatureSettingsFieldsCheck.ts
 *   既定: roiFeatureSettingsFieldsExpected.json（載せ替え前の画面から得た一覧）と突き合わせる。
 *   SETTINGS_FIELDS_DUMP=<出力先.json> を付けると、比較せずに今の画面の一覧を書き出す（期待値を作り直すとき用）。
 *
 * 取る状態（それぞれ testid の並びと、設定欄の表示文字列の行）:
 *   screen-default / screen-none / screen-radius（ROI 特徴量の画面。既定は等方 1 mm のリサンプリング。「なし」に、フィルタを半径指定に）
 *   batch-default / batch-none（一括抽出ダイアログの設定欄。既定は等方 1 mm、「なし」に変えた状態）
 */
import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { clickDismissing } from "./dismissUpdateDialog.js";
import { openAllGroups } from "./openGroups.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "roi-feature-settings-fields-check");
const EXPECTED = path.join(import.meta.dirname, "roiFeatureSettingsFieldsExpected.json");

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

interface Snapshot { testids: string[]; lines: string[] }

/** root の中の data-testid（出現順）と、表示文字列の行（空行を除く）。 */
async function snapshot(page: Page, rootSelector: string): Promise<Snapshot> {
  return page.locator(rootSelector).first().evaluate((el) => ({
    testids: Array.from(el.querySelectorAll("[data-testid]")).map((e) => e.getAttribute("data-testid") ?? ""),
    lines: (el as HTMLElement).innerText.split("\n").map((s) => s.trim()).filter(Boolean),
  }));
}

/**
 * 項目に意味のツールチップ（title）があるか。入力欄そのもの、または祖先の行のどこかに title が付いていること
 * （行の見出しの span に付けるので、入力欄の祖先の子に title つきの要素があるかも見る）。無い項目の testid を返す。
 */
async function missingTips(page: Page, testIds: string[]): Promise<string[]> {
  return (await page.evaluate((ids) => {
    const missing: string[] = [];
    for (const id of ids) {
      const el = document.querySelector(`[data-testid="${id}"]`);
      if (!el) { missing.push(`${id}(無い)`); continue; }
      let ok = false;
      // 入力欄・ボタン・チェックボックスの label 自身の title、または行（先頭の子が見出し）の見出しの title。兄弟の行の title は数えない
      // （tsx が名前つきの関数に __name を足し、ページ内で未定義になるので、関数にせず書く）
      if ((el.getAttribute("title") ?? "").trim() !== "" || (el.closest("label")?.getAttribute("title") ?? "").trim() !== "") ok = true;
      for (let n: Element | null = el, depth = 0; n && depth < 6 && !ok && !id.includes("-family-"); n = n.parentElement, depth++) {
        const head = n.firstElementChild;
        if (head && !head.contains(el) && (head.getAttribute("title") ?? "").trim() !== "" && n.tagName === "DIV") ok = true;
      }
      if (!ok) missing.push(id);
    }
    return missing;
  }, testIds)) as string[];
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const d = new DesktopDriver();
  await d.start();
  const base = `http://127.0.0.1:${d.ports.http}`;
  const got: Record<string, Snapshot> = {};
  try {
    console.log(`  reset: ${JSON.stringify(await resetDb(d.ports.http))}`);
    const page = d.page;
    page.on("console", (m) => {
      if (m.type() === "error") console.log(`  [renderer error] ${m.text()}`);
    });
    await page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    await page.waitForTimeout(2000);
    const later = page.getByRole("button", { name: /^(後で|Later)$/ });
    if (await later.isVisible().catch(() => false)) {
      await later.click();
      await page.waitForTimeout(500);
    }
    await page.evaluate("localStorage.setItem('graphy.locale', 'ja')");
    await page.reload();
    await page.getByTestId("album-select").waitFor({ state: "visible", timeout: 60_000 });

    console.log("\n[1] ROI 特徴量の画面（文脈なしで開く）");
    // 前の実行が残した文脈（localStorage）があると「対象のスタディがありません」の注記が出ない。文脈なしで開くために消す
    await page.evaluate("localStorage.removeItem('graphy-roifeat-ctx')");
    await page.evaluate("window.location.hash = 'radiomics-features'");
    await page.getByTestId("roifeat-bincount").waitFor({ state: "visible", timeout: 20_000 });
    // 群の既定: ① 計算する内容・② 前処理は開き、③ 値の扱いは閉じる（閉じた群の中の入力は DOM に残る）。スナップショットは全部開いて取る
    const openState = async (pre: string) => (await page.evaluate(`["content","preprocess","values","qc"].map(function(g){var d=document.querySelector('[data-testid="${pre}-group-'+g+'"]');return d?(d.open?"open":"closed"):"none"}).join()`)) as string;
    check((await openState("roifeat")) === "open,open,closed,none", "画面の群の既定: 計算する内容・前処理は開き、値の扱いは閉じる（④ は無い）", await openState("roifeat"));
    check((await page.locator('[data-testid="roifeat-calibration"]').count()) === 1 && !(await page.locator('[data-testid="roifeat-calibration"]').isVisible()), "閉じた「値の扱い」の入力は DOM にあり、見えない");
    check(/校正 自動・値の種類 自動・丸め なし/.test(await page.getByTestId("roifeat-group-values-summary").innerText()), "閉じた「値の扱い」の見出しに、いまの値の要約が出る");
    await page.screenshot({ path: path.join(OUT_DIR, "00-screen-groups-default.png"), fullPage: true });
    await openAllGroups(page);
    got["screen-default"] = await snapshot(page, "body");
    const FAMS = ["Morphology", "LocalIntensity", "IntensityBasedStatistical", "IntensityHistogram", "IntensityVolumeHistogram", "Shape2D", "GLCM", "GLRLM", "GLSZM", "GLDZM", "NGTDM", "NGLDM", "Fractal", "GLAM", "AuxiliaryStatistics"];
    const screenIds = ["roifeat-mask", "roifeat-caselabel", "roifeat-mode-section", "roifeat-planes-all", "roifeat-calibration", "roifeat-valuekind", "roifeat-bincount", "roifeat-resampling", "roifeat-preset", "roifeat-filter-radius",
      ...FAMS.map((f) => `roifeat-family-${f}`)];
    const miss1 = await missingTips(page, screenIds);
    check(miss1.length === 0, "画面の主要な項目と族 15 個に、ツールチップがある", miss1);
    check((await missingTips(page, ["no-such-testid"])).join() === "no-such-testid(無い)", "負例: 存在しない項目は検出される");
    await page.evaluate("document.querySelector('[data-testid=\"roifeat-family-GLCM\"]').closest('label').removeAttribute('title')");
    check((await missingTips(page, ["roifeat-family-GLCM"])).join() === "roifeat-family-GLCM", "負例: title を外した族は検出される");
    // 負例（行の見出し）: リサンプリング行の見出しの title を外すと、その行は検出される（兄弟の行の title では通らない）
    await page.evaluate("(function(){var e=document.querySelector('[data-testid=\"roifeat-resampling\"]');while(e){var h=e.firstElementChild;if(h&&!h.contains(document.querySelector('[data-testid=\"roifeat-resampling\"]'))&&h.getAttribute('title')){h.removeAttribute('title');return;}e=e.parentElement;}})()");
    check((await missingTips(page, ["roifeat-resampling"])).join() === "roifeat-resampling", "負例: 行の見出しの title を外した項目は検出される");
    await page.reload();
    await page.evaluate("window.location.hash = 'radiomics-features'");
    await page.getByTestId("roifeat-bincount").waitFor({ state: "visible", timeout: 20_000 });

    await page.screenshot({ path: path.join(OUT_DIR, "01-screen-default.png"), fullPage: true });
    await page.getByTestId("roifeat-resampling").selectOption("none");
    await page.waitForTimeout(300);
    await openAllGroups(page); // 前の手順で再読み込みしたので、群は既定の開閉に戻っている
    got["screen-none"] = await snapshot(page, "body");
    await page.getByTestId("roifeat-filter-radius").check();
    await page.waitForTimeout(300);
    got["screen-radius"] = await snapshot(page, "body");
    await page.screenshot({ path: path.join(OUT_DIR, "02-screen-radius.png"), fullPage: true });

    console.log("\n[2] 一括抽出ダイアログの設定欄");
    await page.evaluate("window.location.hash = ''");
    await page.reload();
    await page.getByTestId("album-select").waitFor({ state: "visible", timeout: 60_000 });
    const resp = await fetch(`${base}/api/albums`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: `settings-fields-${Date.now()}` }),
    });
    const album = (await resp.json()) as { id: number };
    await page.reload();
    await page.getByTestId("album-select").waitFor({ state: "visible", timeout: 60_000 });
    await page.getByTestId("album-select").selectOption(String(album.id));
    await page.waitForTimeout(800);
    await clickDismissing(page, page.getByTestId("album-batch-button")); // 新版の窓がリロードのたびに出て、クリックを遮る
    await page.getByTestId("batch-settings").waitFor({ state: "visible", timeout: 30_000 });
    check((await openState("batch")) === "open,open,closed,closed", "一括抽出の群の既定: 計算する内容・前処理は開き、値の扱い・QC は閉じる", await openState("batch"));
    await page.screenshot({ path: path.join(OUT_DIR, "03a-batch-groups-default.png"), fullPage: true });
    await openAllGroups(page);
    got["batch-default"] = await snapshot(page, '[data-testid="batch-settings"]');
    const miss2 = await missingTips(page, ["batch-kind", "batch-units", "batch-labels", "batch-qc", "batch-bincount", "batch-resampling", "batch-preset", "batch-calibration", "batch-valuekind", "batch-spec-save", "batch-spec-load", "batch-prefix", "batch-out-subjects", "batch-out-patientid", "batch-out-bom", "batch-run", "batch-trial", "batch-write", ...FAMS.map((f) => `batch-family-${f}`)]);
    check(miss2.length === 0, "一括抽出の主要な項目・ボタン・族 15 個に、ツールチップがある", miss2);
    await page.screenshot({ path: path.join(OUT_DIR, "03-batch-default.png"), fullPage: true });
    await page.getByTestId("batch-resampling").selectOption("none");
    await page.waitForTimeout(300);
    got["batch-none"] = await snapshot(page, '[data-testid="batch-settings"]');
    await page.screenshot({ path: path.join(OUT_DIR, "04-batch-none.png"), fullPage: true });

    // 詳細設定（上級者向け）: 他の欄のキー・形の誤りを書くと、理由つきのエラーが出る（撮影して見る。スナップショットの比較には含めない）
    await page.getByTestId("batch-advanced").locator("summary").first().click();
    await page.getByTestId("batch-advanced-text").fill("INT_deltaGLCM=2\nINT_binCount=5\nbad line\nBOGUS_KEY=1");
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(OUT_DIR, "05-batch-advanced-errors.png"), fullPage: true });
    check(await page.getByTestId("batch-advanced-errors").isVisible(), "詳細設定に誤りを書くと、エラーの一覧が出る");
    const dump = process.env.SETTINGS_FIELDS_DUMP;
    if (dump) {
      fs.writeFileSync(dump, JSON.stringify(got, null, 2) + "\n");
      console.log(`\n  dump: ${dump}（比較はしない）`);
      return;
    }

    console.log("\n[3] 期待値（載せ替え前の一覧 + 段 1 で足す 3 つ + 種類の欄の 3 つ + PET の校正・値の種類の欄）との突き合わせ");
    const expected = JSON.parse(fs.readFileSync(EXPECTED, "utf8")) as Record<string, Snapshot>;
    check(Object.keys(expected).length === 5, "期待値は 5 状態", Object.keys(expected));
    for (const key of Object.keys(expected)) {
      const g = got[key];
      const e = expected[key];
      check(!!g && g.testids.length > 0, `${key}: 欄が実在する（空でない）`, g?.testids.length);
      if (!g) continue;
      const missing = e.testids.filter((t) => !g.testids.includes(t));
      const extra = g.testids.filter((t) => !e.testids.includes(t));
      check(missing.length === 0 && extra.length === 0, `${key}: data-testid の集合が一致`, { missing, extra });
      check(g.testids.join("|") === e.testids.join("|"), `${key}: data-testid の並びが一致`);
      const lineDiff = e.lines.filter((l, i) => g.lines[i] !== l);
      check(g.lines.length === e.lines.length && lineDiff.length === 0, `${key}: 表示文字列の行（見出し・選択肢・注記）が一致`,
        { expected: e.lines.length, got: g.lines.length, diff: lineDiff.slice(0, 5) });
    }
  } finally {
    await d.stop();
  }
}

main()
  .then(() => {
    console.log(`\n結果: 合格 ${passed} / 失敗 ${failures.length}`);
    if (failures.length) {
      for (const f of failures) console.log(`  FAIL: ${f}`);
      process.exit(1);
    }
  })
  .catch((e) => {
    console.error(e);
    process.exit(2);
  });
