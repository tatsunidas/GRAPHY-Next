/*
 * Computed DWI プラグイン: b=400 / b=800 のデジタルファントム（DICOM。既知の ADC から S=S0·exp(-b·ADC) で作成）が
 * 実アプリで通るかの検査。既定のまま vMRE に切り替え、L=400・H=800 の実測の組で sADC・μdiff が真値と一致するかを見る。
 * さらに cDWI・ADC・sADC・μdiff を 2 巡（2 巡目は画面で窓を変えて）保存し、保存したファイルを
 * `automator/.results/cdwi-phantom-check/saved/{r1,r2}/` に取り出す。SeriesNumber が既存と重ならず連番になること、
 * 窓（WindowCenter/Width）がプラグインの指定（画面で変えた窓を含む）で書かれることは、取り出したファイルを pydicom で検査する
 * （この検査は保存と索引が揃うまで待つだけで、タグの検査はしない）。患者情報を含まない合成データ。
 *
 * 実行:  cd automator && CDWI_PHANTOM=<b400/ b800/ truth.json を持つフォルダ> npx tsx src/spike/cdwiPhantomCheck.ts
 *        （プラグインの ui.js を先にビルドしておく。JDK を PATH に足す。CDWI_PORT_BASE で専用ポート）
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Page } from "playwright";

import { DesktopDriver, DESKTOP_RUN_DATA_DIR } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { selectFirstStudy } from "../checklist/items/shared/helpers.js";
import { createStepRecorder } from "../checklist/types.js";
import { createChecker } from "./computeSpikeShared.js";

const { check, summary } = createChecker();
const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "cdwi-phantom-check");
const PLUGIN_ID = "vis-computed-dwi";
const PLUGIN_DIR = process.env.CDWI_PLUGIN_DIR ?? path.join(os.homedir(), "graphy-next-plugin-computed-dwi");
const PH = process.env.CDWI_PHANTOM;
const P0 = Number(process.env.CDWI_PORT_BASE ?? 28761);
const PORTS = { http: P0, scp: P0 + 1, vite: P0 + 2 };

interface Truth { nx: number; ny: number; nz: number; S0: number; adc: number[][] }

async function main(): Promise<number> {
  if (!PH || !fs.existsSync(path.join(PH, "b400")) || !fs.existsSync(path.join(PH, "truth.json")) || !fs.existsSync(path.join(PLUGIN_DIR, "ui.js"))) {
    console.log("【未達】入力が足りません（CDWI_PHANTOM / プラグインの ui.js）。合格ではありません。");
    return 2;
  }
  const truth = JSON.parse(fs.readFileSync(path.join(PH, "truth.json"), "utf8")) as Truth;
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const dst = path.join(DESKTOP_RUN_DATA_DIR, "plugins", PLUGIN_ID);
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(dst, { recursive: true });
  for (const n of ["plugin.json", "ui.js"]) fs.copyFileSync(path.join(PLUGIN_DIR, n), path.join(dst, n));

  const driver = new DesktopDriver(PORTS);
  try {
    await driver.start();
    await resetDb(driver.ports.http);
    const imp = await importPaths(driver.ports.http, [path.join(PH, "b400"), path.join(PH, "b800")]);
    check(imp.failed === 0 && imp.imported === 16, "（前提）b400・b800 の 16 枚を取り込めた", imp);

    const base = `http://localhost:${driver.ports.http}`;
    const studies = (await (await fetch(`${base}/api/studies`)).json()) as { studyInstanceUid: string }[];
    const studyUid = studies[0].studyInstanceUid;
    const series = (await (await fetch(`${base}/api/studies/${studyUid}/series`)).json()) as { seriesInstanceUid: string; seriesDescription?: string }[];
    const uid400 = series.find((s) => /b400/.test(s.seriesDescription ?? ""))?.seriesInstanceUid;
    const uid800 = series.find((s) => /b800/.test(s.seriesDescription ?? ""))?.seriesInstanceUid;
    check(!!uid400 && !!uid800, "（前提）b400・b800 の 2 系列がある", series);

    const mainPage = driver.page;
    await mainPage.evaluate("localStorage.setItem('graphy.locale', 'ja')");
    await mainPage.reload({ waitUntil: "domcontentloaded" });
    await mainPage.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    await selectFirstStudy(mainPage, createStepRecorder());
    await mainPage.locator(`[data-testid="series-row-${uid800}"]`).click();
    await mainPage.getByTestId("series-viewer-root").waitFor({ state: "visible", timeout: 15_000 });
    await mainPage.waitForTimeout(1500);
    const viewer: Page = await driver.waitForNewPage(
      () => mainPage.getByTestId("viewer2d-toolbar-button").click(),
      (url) => url.includes("2dviewer"),
    );
    await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 30_000 });
    await viewer.waitForTimeout(2500);
    await viewer.setViewportSize({ width: 1900, height: 1150 });
    await viewer.waitForTimeout(1000);
    viewer.on("console", (m) => { if (m.type() === "error") console.log(`  [viewer error] ${m.text().slice(0, 300)}`); });
    const hostCount = () => viewer.locator('[data-testid="viewer2d-canvas-host"]').count();

    await viewer.getByTestId("viewer2d-menu-analysis").click();
    await viewer.getByTestId(`plugin-analysis-item-${PLUGIN_ID}`).click();
    await viewer.locator("#cdwi-run").waitFor({ state: "visible", timeout: 15_000 });
    await viewer.locator('[data-testid="input-row"]').first().waitFor({ state: "visible", timeout: 20_000 });
    await viewer.getByRole("button", { name: /保管庫から追加/ }).click();
    await viewer.getByTestId("pickseries-dialog").last().waitFor({ state: "visible", timeout: 20_000 });
    const top = (id: string) => viewer.getByTestId(id).last();
    await top(`pickseries-study-${studyUid}`).waitFor({ state: "visible", timeout: 20_000 });
    if ((await top(`pickseries-series-check-${uid400}`).count()) === 0) await top(`pickseries-expand-${studyUid}`).click();
    await top(`pickseries-series-check-${uid400}`).check();
    await top("pickseries-ok").click();
    await viewer.waitForFunction(() => document.querySelectorAll('[data-testid="input-row"]').length >= 2, undefined, { timeout: 30_000 });

    const bs = (await viewer.evaluate(`Array.from(document.querySelectorAll('[data-testid="input-row"] input')).map(function(i){return i.value})`)) as string[];
    console.log(`  入力の b 値（DICOM (0018,9087) から読み取り）: ${JSON.stringify(bs)}`);
    check(bs.slice().sort().join() === "400,800", "b 値が DICOM から 400・800 と読める", bs);

    const waitDone = () => viewer.waitForFunction(
      () => /計算しました|表示を切り替えました|開けません|ください|必要|できません|置けません/.test(document.querySelector('[data-testid="status"]')?.textContent ?? "") && !document.querySelector("#cdwi-run")?.hasAttribute("disabled"),
      undefined, { timeout: 240_000 });
    const tableRows = async () => viewer.evaluate(`Array.from(document.querySelectorAll('[data-testid="stats-table"] tbody tr')).map(function(tr){return Array.from(tr.children).map(function(td){return (td.textContent||'').trim()})})`) as Promise<string[][]>;

    console.log("\n[1] vMRE に切り替え（選択欄・L/H 欄は触らない）");
    await viewer.getByTestId("mode-vmre").click();
    await viewer.waitForTimeout(500);
    check((await viewer.getByTestId("lowB").inputValue()) === "400" && (await viewer.getByTestId("highB").inputValue()) === "800", "既定の L・H が 400・800 になる（範囲内の実測から）");
    const note = (await viewer.getByTestId("source-note").textContent()) ?? "";
    check(/L = b400 → 入力のシリーズ.*実測/.test(note) && /H = b800 → 入力のシリーズ.*実測/.test(note), "L・H とも実測と表示される", note);
    check(!(await viewer.getByTestId("base-low").isVisible()), "両方実測なので基準の欄は隠れる");
    check(!(await viewer.getByTestId("run").isDisabled()), "計算ボタンは有効");
    await viewer.getByTestId("run").click();
    await waitDone();
    await viewer.waitForTimeout(3500);
    const status = (await viewer.getByTestId("status").textContent()) ?? "";
    console.log(`  status: ${status}`);
    check(/計算しました（実測: 実測 b=400 \/ 実測 b=800）/.test(status), "🔴 計算が通り、実測 b=400 / b=800 の組として扱われる", status);
    check((await hostCount()) === 3, "sADC・μdiff の 2 タイル + 元 DWI = 3 タイル", await hostCount());
    const warn = ((await viewer.getByTestId("warning").allInnerTexts().catch(() => [])) as string[]).join(" / ");
    console.log(`  警告: ${warn}`);
    check(/b=400\/800/.test(warn), "L・H が論文の b200/800 でないことが警告される", warn);

    const rows = await tableRows();
    const head = (await viewer.evaluate(`Array.from(document.querySelectorAll('[data-testid="stats-table"] thead th')).map(function(t){return t.textContent})`)) as string[];
    console.log(`  表の見出し: ${JSON.stringify(head)}`);
    console.log(`  表: ${JSON.stringify(rows)}`);
    const iMu = head.findIndex((h) => /μdiff/.test(h));
    check(rows.length === 5 && iMu >= 0, "点が 5 つ、μdiff の列がある", { n: rows.length, iMu });
    let ok = 0;
    for (const r of rows) {
      const m = /\((\d+), (\d+)\) z(\d+)/.exec(r[1]);
      if (!m) continue;
      const adc = truth.adc[Number(m[2])][Number(m[1])];
      // 真値: S400/S800 = exp(400·ADC) → μdiff = α·400·ADC + β（DICOM は整数に丸めた値なので 0.3% の余裕）
      const e = 4.91 * 400 * adc + 0.92;
      const v = Number(r[iMu]);
      const good = adc > 0 && Math.abs(v - e) <= 0.003 * e + 0.01;
      if (good) ok++;
      else console.log(`  不一致 ${r[0]} (${m[1]},${m[2]}) ADC真値=${adc} 表=${v} 期待=${e.toFixed(3)}`);
    }
    check(ok === 5, "🔴 5 点すべての μdiff が、ファントムの真の ADC から求めた 4.91·400·ADC+0.92 と一致する", ok);
    await viewer.screenshot({ path: path.join(OUT_DIR, "1-vmre-400-800.png") });

    console.log("\n[2] cDWI モードも通る（基準 b400/b800）");
    await viewer.getByTestId("mode-cdwi").click();
    await waitDone();
    await viewer.waitForTimeout(2500);
    const st2 = (await viewer.getByTestId("status").textContent()) ?? "";
    console.log(`  status: ${st2}`);
    check(/計算しました|表示を切り替えました/.test(st2) && (await hostCount()) === 3, "cDWI（ADC・cDWI）も計算でき、3 タイルになる", { st2, n: await hostCount() });
    await viewer.screenshot({ path: path.join(OUT_DIR, "2-cdwi.png") });

    console.log("\n[3] 派生シリーズの保存（cDWI・ADC・sADC・μdiff）。保存したファイルを取り出して別途 pydicom で検査する");
    const listSeries = async () => (await (await fetch(`${base}/api/studies/${studyUid}/series`)).json()) as { seriesInstanceUid: string; seriesDescription?: string }[];
    const before = new Set((await listSeries()).map((x) => x.seriesInstanceUid));
    const saveOne = async (kind: string) => {
      await viewer.getByTestId(`save-${kind}`).click();
      await viewer.waitForTimeout(1500);
      await viewer.screenshot({ path: path.join(OUT_DIR, `3-save-${kind}.png`) });
      const dlg = viewer.getByTestId("plugin-save-confirm");
      const shown = await dlg.isVisible().catch(() => false);
      console.log(`  save-${kind}: consent dialog visible = ${shown}`);
      if (shown) await viewer.getByTestId("plugin-save-confirm-button").click();
      await viewer.waitForFunction(() => /保存しました|保存できません|キャンセル/.test(document.querySelector('[data-testid="status"]')?.textContent ?? ""), undefined, { timeout: 60_000 });
      const t = (await viewer.getByTestId("status").textContent()) ?? "";
      console.log(`  save-${kind}: ${t}`);
      check(/保存しました（8 枚）/.test(t), `🔴 ${kind} を保存できた（8 枚）`, t);
    };
    await saveOne("cdwi");
    await saveOne("adc");
    await viewer.getByTestId("mode-vmre").click();
    await waitDone();
    await viewer.waitForTimeout(1500);
    await saveOne("sadc");
    await saveOne("mudiff");
    // 保存完了の直後は一覧の索引が追いついていないことがある（最後の系列が 3 枚だけ見えた）。揃うまで待つ。
    const waitNew = async (exclude: Set<string>): Promise<{ seriesInstanceUid: string; seriesDescription?: string }[]> => {
      let last: { seriesInstanceUid: string; seriesDescription?: string; numberOfInstances?: number }[] = [];
      for (let i = 0; i < 40; i++) {
        last = ((await listSeries()) as typeof last).filter((x) => !exclude.has(x.seriesInstanceUid));
        if (last.length === 4 && last.every((x) => x.numberOfInstances === 8)) break;
        await viewer.waitForTimeout(500);
      }
      return last;
    };
    const round1 = await waitNew(before);
    console.log(`  1 巡目で増えたシリーズ: ${JSON.stringify(round1.map((a) => a.seriesDescription))}`);
    check(round1.length === 4, "派生シリーズが 4 本増える（1 巡目）", round1);

    console.log("\n[3b] 窓を変えて、もう一度 4 本保存する（SeriesNumber が既存と重ならず連番になるか／変えた窓が保存に反映されるか）");
    const ids1 = new Set([...before, ...round1.map((x) => x.seriesInstanceUid)]);
    // ADC の窓 0〜2、μdiff の窓 0〜8 に変える（change イベントで本体のタイルにも反映される）
    await viewer.getByTestId("adc-min").fill(process.env.CDWI_ADC_MIN ?? "0");
    await viewer.getByTestId("adc-max").fill(process.env.CDWI_ADC_MAX ?? "2");
    await viewer.getByTestId("adc-max").dispatchEvent("change");
    await viewer.getByTestId("par-min").fill("0");
    await viewer.getByTestId("par-max").fill("8");
    await viewer.getByTestId("par-max").dispatchEvent("change");
    await viewer.waitForTimeout(1500);
    await saveOne("sadc");
    await saveOne("mudiff");
    await viewer.getByTestId("mode-cdwi").click();
    await waitDone();
    await viewer.waitForTimeout(1500);
    await saveOne("cdwi");
    await saveOne("adc");
    const round2 = await waitNew(ids1);
    check(round2.length === 4, "派生シリーズがさらに 4 本増える（2 巡目）", round2);
    const SAVED = path.join(OUT_DIR, "saved");
    fs.rmSync(SAVED, { recursive: true, force: true });
    for (const [round, list] of [["r1", round1], ["r2", round2]] as const) {
      for (const a of list) {
        const dir = path.join(SAVED, round, (a.seriesDescription ?? a.seriesInstanceUid).replace(/[^\w.-]+/g, "_"));
        fs.mkdirSync(dir, { recursive: true });
        const sops = (await (await fetch(`${base}/api/studies/${studyUid}/series/${a.seriesInstanceUid}/instances`)).json()) as { sopInstanceUid: string }[];
        for (const [i, o] of sops.entries()) {
          const r = await fetch(`${base}/api/studies/${studyUid}/series/${a.seriesInstanceUid}/instances/${o.sopInstanceUid}/file`);
          fs.writeFileSync(path.join(dir, `${String(i + 1).padStart(2, "0")}.dcm`), Buffer.from(await r.arrayBuffer()));
        }
      }
    }
    console.log(`  保存ファイルの出力先: ${SAVED}`);

    console.log("\n[3c] 保存した ADC（2 巡目）を 2D ビューアで開いて、窓が値域に合っているか目で見る");
    await mainPage.reload({ waitUntil: "domcontentloaded" });
    await mainPage.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    await selectFirstStudy(mainPage, createStepRecorder());
    await mainPage.waitForTimeout(1500);
    for (const key of ["ADC", "mu_diff"]) {
      const target = round2.find((x) => new RegExp(key).test(x.seriesDescription ?? "") && !/sADC/.test(x.seriesDescription ?? ""));
      const row = target ? mainPage.locator(`[data-testid="series-row-${target.seriesInstanceUid}"]`) : null;
      if (row && (await row.count()) > 0) {
        await row.click();
        await mainPage.getByTestId("series-viewer-root").waitFor({ state: "visible", timeout: 15_000 });
        await mainPage.waitForTimeout(2500);
        const wl = ((await mainPage.getByTestId("series-viewer-root").innerText().catch(() => "")) ?? "").match(/W\/L\s*([^\s]+)/)?.[1] ?? "";
        console.log(`  ${key}（2 巡目）のプレビューの W/L = ${wl}`);
        // 2D ビューアで開いて、画像が見えるか（窓が値域に合っているか）をスクリーンショットで見る
        const v2: Page = await driver.waitForNewPage(
          () => mainPage.getByTestId("viewer2d-toolbar-button").click(),
          (url) => url.includes("2dviewer"),
        );
        await v2.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 30_000 });
        await v2.waitForTimeout(3000);
        await v2.setViewportSize({ width: 1900, height: 1150 });
        await v2.evaluate(`document.querySelectorAll('.graphy-plugin-window').forEach(function(w){ w.style.display = 'none'; })`);
        await v2.waitForTimeout(1500);
        await v2.screenshot({ path: path.join(OUT_DIR, `3c-saved-${key}.png`) });
      } else console.log(`  【未達】${key} の保存済みシリーズを一覧から開けなかった`);
    }
  } finally {
    await driver.stop().catch(() => undefined);
  }
  return summary();
}

main().then((n) => process.exit(n)).catch((e) => { console.error(e); process.exit(1); });
