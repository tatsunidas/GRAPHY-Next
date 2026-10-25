/*
 * IBSI 照合の画面（2D Viewer > 解析 > IBSI 照合…）の実機検証スパイク。
 *
 * 実行:  cd automator && npx tsx src/spike/ibsiCheckCheck.ts
 *
 *   1. メニューから別ウィンドウを開き、「照合する」→ 件数（168 照合・不合格 0）。画面の件数は API の本文と一致。
 *   2. 書き出した CSV・JSON が API の本文（csv・report）と一致する。
 *   3. 絞り込み: 「不合格だけ」は不合格の数、「不合格と計算されず」は不合格＋計算されずの数、
 *      検索は件数を減らす（絞り込みが効いていることを、すべて表示との差で確かめる）。
 *   4. CT ファントム（構成 C・D）は「リリース時の記録」として出て、構成 C の不合格 1 件が見える。
 *   5. スクリーンショット（out/）で見た目を人が判定する。
 *
 * 専用ポート 19850〜19852。前提: backend jar（今のビルド）。
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DesktopDriver } from "../driver/desktopDriver.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { resetDb } from "../backend/dbReset.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { openFirstSeriesInViewer } from "../checklist/items/shared/helpers.js";
import { createStepRecorder } from "../checklist/types.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "ibsi-check");
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

interface Row { verdict: string; imageBiomarker: string | null }
interface Report { dataSet: string; checked: number; counts: Record<string, number>; rows: Row[] }
interface Result { graphyVersion: string; radiomicsjVersion: string; ranAt: string; report: Report; csv: string }

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const d = new DesktopDriver({ http: 19850, scp: 19851, vite: 19852 });
  await d.start();
  const base = `http://127.0.0.1:${d.ports.http}`;
  try {
    // 画面を開く入口（2D ビューアのメニュー）を出すため、合成 CT を 1 本取り込む（照合そのものはデータを使わない）
    const synthDir = path.join(OUT_DIR, "synth");
    fs.rmSync(synthDir, { recursive: true, force: true });
    fs.mkdirSync(synthDir, { recursive: true });
    const r = spawnSync("python3", ["-I", path.join(import.meta.dirname, "roiFeatureSynth.py"), synthDir, "1"], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`合成データを作れません: ${r.stderr}`);
    await resetDb(d.ports.http);
    await importPaths(d.ports.http, [synthDir]);

    const mainPage = d.page;
    await mainPage.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    await mainPage.waitForTimeout(2000);
    const later = mainPage.getByRole("button", { name: /^(後で|Later)$/ });
    if (await later.isVisible().catch(() => false)) {
      await later.click();
      await mainPage.waitForTimeout(500);
    }
    await mainPage.evaluate("localStorage.setItem('graphy.locale', 'ja')");

    console.log("\n[1] メニューから開いて照合");
    await openFirstSeriesInViewer(mainPage, createStepRecorder());
    const viewer = await d.waitForNewPage(
      () => mainPage.getByTestId("viewer2d-toolbar-button").click(),
      (url) => url.includes("2dviewer"),
    );
    await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 20_000 });
    await viewer.waitForTimeout(2000);
    await viewer.getByTestId("viewer2d-menu-analysis").click();
    const page = await d.waitForNewPage(
      () => viewer.getByTestId("menu-ibsi-check").click(),
      (url) => url.includes("#ibsi-check"),
    );
    page.on("console", (m) => {
      if (m.type() === "error") console.log(`  [renderer error] ${m.text()}`);
    });
    await page.evaluate(`
      (function () {
        window.__dl = [];
        var orig = HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click = function () {
          var a = this;
          if (a.download && a.href.indexOf("blob:") === 0) {
            var name = a.download;
            fetch(a.href).then(function (r) { return r.text(); }).then(function (t) { window.__dl.push({ name: name, text: t }); });
            return;
          }
          return orig.call(this);
        };
      })()
    `);
    await page.getByTestId("ibsi-check").waitFor({ state: "visible", timeout: 20_000 });
    check((await page.getByTestId("ibsi-table").count()) === 0, "照合の前は結果の表が無い");
    await page.getByTestId("ibsi-run").click();
    await page.getByTestId("ibsi-summary").waitFor({ state: "visible", timeout: 180_000 });

    const api = (await (await fetch(`${base}/api/radiomics/ibsi-check`)).json()) as Result;
    const rep = api.report;
    check(rep.checked === 168, "API: デジタルファントムで 168 特徴を照合", rep.checked);
    check(rep.counts.FAIL === 0, "API: 不合格 0", rep.counts);
    const passedText = (await page.getByTestId("ibsi-passed").innerText()).replace(/\s+/g, " ");
    check(passedText.includes("168") && passedText.includes("合格"), "画面の件数が API と一致（合格 168 ／ 照合 168）", passedText);
    const versions = await page.getByTestId("ibsi-versions").innerText();
    check(versions.includes(api.radiomicsjVersion) && versions.includes(api.graphyVersion), "版の行が API の版と一致", versions);
    const allRows = rep.rows.length;
    check((await page.getByTestId("ibsi-table").locator("tbody tr").count()) === allRows, `表の行数が API の行数（${allRows}）と一致`);
    await page.screenshot({ path: path.join(OUT_DIR, "01-result.png") });

    console.log("\n[2] 書き出し");
    const grab = async (testId: string): Promise<{ name: string; text: string }> => {
      const before = (await page.evaluate("window.__dl.length")) as number;
      await page.getByTestId(testId).click();
      await page.waitForFunction(`window.__dl.length > ${before}`, undefined, { timeout: 15_000 });
      return (await page.evaluate(`window.__dl[${before}]`)) as { name: string; text: string };
    };
    const csvDl = await grab("ibsi-csv");
    check(csvDl.text === api.csv, "CSV が API の csv と一致");
    const jsonDl = await grab("ibsi-json");
    const jsonObj = JSON.parse(jsonDl.text) as { graphyNextVersion: string; report: Report };
    check(JSON.stringify(jsonObj.report) === JSON.stringify(rep), "JSON の report が API の report と一致");
    check(jsonObj.graphyNextVersion === api.graphyVersion, "JSON に本体の版が入る");
    check(csvDl.name.includes(`RadiomicsJ-${api.radiomicsjVersion}`), "ファイル名に RadiomicsJ の版", csvDl.name);

    console.log("\n[3] 絞り込み（すべて表示との差で確かめる）");
    const rows = () => page.getByTestId("ibsi-table").locator("tbody tr").count();
    const nFail = rep.counts.FAIL;
    const nNotComputed = rep.counts.NOT_COMPUTED;
    await page.getByTestId("ibsi-filter").selectOption("FAIL");
    check((await rows()) === nFail, `不合格だけ: ${nFail} 行`, await rows());
    await page.getByTestId("ibsi-filter").selectOption("PROBLEM");
    check((await rows()) === nFail + nNotComputed && nNotComputed > 0, `不合格と計算されず: ${nFail + nNotComputed} 行`, await rows());
    await page.getByTestId("ibsi-filter").selectOption("NOT_JUDGED");
    const notJudged = rep.counts.NOT_SUPPORTED + rep.counts.NO_MANUAL_REFERENCE;
    check((await rows()) === notJudged, `判定の対象外: ${notJudged} 行`, await rows());
    await page.getByTestId("ibsi-filter").selectOption("ALL");
    await page.getByTestId("ibsi-search").fill("Volume");
    const n1 = await rows();
    check(n1 > 0 && n1 < allRows, `検索 "Volume" で行が減る（${n1} / ${allRows}）`);
    await page.getByTestId("ibsi-search").fill("zzzz-no-such-feature");
    check((await rows()) === 0, "該当しない検索語で 0 行");
    await page.getByTestId("ibsi-search").fill("");
    check((await rows()) === allRows, "検索を空にすると全行に戻る");

    console.log("\n[4] CT ファントムの記録");
    const c = page.getByTestId("ibsi-record-configuration-C");
    const dd = page.getByTestId("ibsi-record-configuration-D");
    await c.waitFor({ state: "visible", timeout: 10_000 });
    check((await dd.count()) === 1, "構成 D の記録が出る");
    const cText = await c.innerText();
    check(cText.includes("不合格") && cText.includes("IntensityAtVolumeFraction") || cText.includes("Intensity at"), "構成 C の不合格 1 件の行が見える", cText);
    check((await page.getByText("この PC では実行していません").count()) >= 1, "「この PC では実行していない」と明記");
    await c.scrollIntoViewIfNeeded();
    await page.evaluate("window.scrollBy(0, 250)");
    await page.screenshot({ path: path.join(OUT_DIR, "02-ct-records.png") });

    console.log(`\n合格 ${passed} ／ 失敗 ${failures.length}`);
  } finally {
    await d.stop();
  }
  if (failures.length > 0) {
    console.log(`失敗: ${failures.join(" / ")}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
