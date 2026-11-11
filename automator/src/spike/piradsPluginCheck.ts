/*
 * PI-RADS プラグイン（vis-pirads）: 実アプリで、ROI → 入力 → 総合カテゴリ → SR 保存 → 読み直し、が通るかの検査。
 * 合成の MR ファントム（円柱 5 本。前立腺ではなく、病変の ROI を描く足場）に楕円 ROI を 2 つ描き、
 *   1. 窓を開く: 免責・病変 2 行・何も選ばない既定のまま（未入力・保存ボタン無効）
 *   2. 病変 1 だけ入力（TZ・T2W 2・DWI 4）→ 総合 3（病変 2 は既定のまま＝未完成）
 *   3. 窓をもう 1 枚開く → 入力が ROI の属性から復元される
 *   4. SR に保存（本体の確認ダイアログ）→ 取り出して pydicom で検査（groups は完成した 1 件だけ）
 *   5. 病変 2 を入力（PZ・DWI 3・DCE 陽性）→ 総合 4 → もう一度 SR 保存（groups 2 件）・レポートへ差し込み
 * を通す。保存した SR は `.results/pirads-plugin-check/saved/` に取り出し、`scripts/check-structured-report.py` で読む。
 *
 * 実行:  cd automator && PIRADS_PHANTOM=<b400 を持つフォルダ> npx tsx src/spike/piradsPluginCheck.ts
 *        （プラグインの ui.js を先にビルドしておく。JDK を PATH に足す。PIRADS_PORT_BASE で専用ポート、PIRADS_UI_JS で別の ui.js）
 */
import { execFileSync } from "node:child_process";
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
const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "pirads-plugin-check");
const PLUGIN_ID = "vis-pirads";
const PLUGIN_DIR = process.env.PIRADS_PLUGIN_DIR ?? path.join(os.homedir(), "graphy-workspace", "graphy-next-plugin-pirads");
const UI_JS = process.env.PIRADS_UI_JS ?? path.join(PLUGIN_DIR, "ui.js");
const PH = process.env.PIRADS_PHANTOM;
const P0 = Number(process.env.PIRADS_PORT_BASE ?? 28791);
const PORTS = { http: P0, scp: P0 + 1, vite: P0 + 2 };
const SR_READER = path.join(AUTOMATOR_ROOT, "scripts", "check-structured-report.py");

interface SrSummary {
  modality: string;
  description: string;
  seriesNumber: number;
  groups: { trackingId: string; findingText: string; nums: { name: string | null; value: number; unit: string; meaning: string; scheme: string }[]; refs: string[] }[];
  findings: { label: string; text: string }[];
}
type Series = { seriesInstanceUid: string; seriesDescription?: string; modality?: string };

async function dragOnCanvas(page: Page, hostIndex: number, sx: number, sy: number, dx: number, dy: number): Promise<void> {
  await page.evaluate(`(function(){
    var host = document.querySelectorAll('[data-testid="viewer2d-canvas-host"]')[${hostIndex}];
    var canvas = host.querySelector('canvas');
    var x0 = ${sx}, y0 = ${sy};
    function fire(type, x, y, buttons){
      var common = {bubbles:true, cancelable:true, composed:true, clientX:x, clientY:y, button:0, buttons:buttons};
      canvas.dispatchEvent(new PointerEvent(type, Object.assign({}, common, {pointerId:1, pointerType:'mouse', isPrimary:true})));
      canvas.dispatchEvent(new MouseEvent(type.replace('pointer','mouse'), common));
    }
    fire('pointermove', x0, y0, 0);
    fire('pointerdown', x0, y0, 1);
    for (var i=1;i<=10;i++) fire('pointermove', x0+${dx}*i/10, y0+${dy}*i/10, 1);
    fire('pointerup', x0+${dx}, y0+${dy}, 0);
  })()`);
}

async function drawEllipseAt(page: Page, fx: number, fy: number, dx: number, dy: number): Promise<void> {
  const r = (await page.evaluate(`(function(){
    var host = document.querySelectorAll('[data-testid="viewer2d-canvas-host"]')[0];
    var rc = host.querySelector('canvas').getBoundingClientRect();
    return {x: rc.left + rc.width*${fx}, y: rc.top + rc.height*${fy}};
  })()`)) as { x: number; y: number };
  await dragOnCanvas(page, 0, r.x, r.y, dx, dy);
}

async function main(): Promise<number> {
  if (!PH || !fs.existsSync(path.join(PH, "b400")) || !fs.existsSync(UI_JS) || !fs.existsSync(path.join(PLUGIN_DIR, "plugin.json"))) {
    console.log("【未達】入力が足りません（PIRADS_PHANTOM の b400 / プラグインの ui.js・plugin.json）。合格ではありません。");
    return 2;
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const dst = path.join(DESKTOP_RUN_DATA_DIR, "plugins", PLUGIN_ID);
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(dst, { recursive: true });
  fs.copyFileSync(path.join(PLUGIN_DIR, "plugin.json"), path.join(dst, "plugin.json"));
  fs.copyFileSync(UI_JS, path.join(dst, "ui.js"));

  const driver = new DesktopDriver(PORTS);
  try {
    await driver.start();
    await resetDb(driver.ports.http);
    const imp = await importPaths(driver.ports.http, [path.join(PH, "b400")]);
    check(imp.failed === 0 && imp.imported === 8, "（前提）ファントム 8 枚を取り込めた", imp);

    const base = `http://localhost:${driver.ports.http}`;
    const studies = (await (await fetch(`${base}/api/studies`)).json()) as { studyInstanceUid: string }[];
    const studyUid = studies[0].studyInstanceUid;
    const listSeries = async () => (await (await fetch(`${base}/api/studies/${studyUid}/series`)).json()) as Series[];
    const series = await listSeries();
    const src = series.find((s) => s.modality === "MR")!;
    check(!!src, "（前提）MR のシリーズがある", series);

    const mainPage = driver.page;
    await mainPage.evaluate("localStorage.setItem('graphy.locale', 'ja'); localStorage.setItem('graphy.update.skipVersion', '0.6.2')");
    await mainPage.reload({ waitUntil: "domcontentloaded" });
    await mainPage.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    await selectFirstStudy(mainPage, createStepRecorder());
    await mainPage.locator(`[data-testid="series-row-${src.seriesInstanceUid}"]`).click();
    await mainPage.getByTestId("series-viewer-root").waitFor({ state: "visible", timeout: 15_000 });
    await mainPage.waitForTimeout(1500);
    const viewer: Page = await driver.waitForNewPage(
      () => mainPage.getByTestId("viewer2d-toolbar-button").click(),
      (url) => url.includes("2dviewer"),
    );
    await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 30_000 });
    await viewer.waitForTimeout(2500);
    await viewer.setViewportSize({ width: 1500, height: 1000 });
    await viewer.waitForTimeout(1000);
    viewer.on("console", (m) => { if (m.type() === "error") console.log(`  [viewer error] ${m.text().slice(0, 300)}`); });

    // 病変の ROI（楕円）を 2 つ。窓を開く前に描く（窓が canvas に被らないように）。
    const pickEllipse = async () => {
      await viewer.keyboard.press("Escape");
      await viewer.getByTestId("viewer2d-menu-roi").click();
      await viewer.getByRole("button", { name: /^(✓ )?楕円 ROI/ }).first().click({ timeout: 8000 });
      await viewer.waitForTimeout(300);
    };
    await pickEllipse();
    await drawEllipseAt(viewer, 0.34, 0.33, 40, 36);
    await viewer.waitForTimeout(700);
    await pickEllipse();
    await drawEllipseAt(viewer, 0.64, 0.64, 44, 40);
    await viewer.waitForTimeout(900);
    await viewer.keyboard.press("Escape");

    const openPlugin = async () => {
      // 開いている窓がメニューに被るので、先に画面の隅へ退避する（閉じない＝2 枚目を開いたときに前の入力が残る前提は変えない）。
      await viewer.evaluate(`document.querySelectorAll('.graphy-plugin-window').forEach(function(w){ w.style.left = (window.innerWidth - 40) + 'px'; w.style.top = (window.innerHeight - 40) + 'px'; })`);
      await viewer.getByTestId("viewer2d-menu-analysis").click();
      await viewer.getByTestId(`plugin-analysis-item-${PLUGIN_ID}`).click();
      await viewer.getByTestId("disclaimer").last().waitFor({ state: "visible", timeout: 15_000 });
      await viewer.waitForTimeout(500);
    };
    const win = () => viewer.locator(".graphy-plugin-window").last();
    const lesions = () => win().getByTestId("lesion");
    const pick = async (n: number, id: string, value: string) => { await lesions().nth(n).getByTestId(id).selectOption(value); };

    // ---- 1. 開く・既定のまま ----
    await openPlugin();
    check(/診断機器ではありません/.test((await win().getByTestId("disclaimer").textContent()) ?? ""), "免責が画面の先頭に出る");
    check(/二次資料/.test((await win().getByTestId("disclaimer").textContent()) ?? "") && /CZ/.test((await win().getByTestId("disclaimer").textContent()) ?? ""), "免責に PZ（二次資料）・CZ（非対応）の限界が出る");
    const nLes = await lesions().count();
    check(nLes === 2, "描いた ROI が病変 2 行として出る", { nLes });
    const states0 = await win().getByTestId("result").evaluateAll((els) => els.map((e) => e.getAttribute("data-state")));
    check(states0.length === 2 && states0.every((s) => s === "empty"), "何も選ばない既定のままでは、2 行とも「未入力」", states0);
    check(await win().getByTestId("save").isDisabled(), "既定のままでは SR 保存ボタンが無効");
    await viewer.screenshot({ path: path.join(OUT_DIR, "1-default.png") });

    // ---- 2. 病変 1 だけ入力 ----
    await pick(0, "zone", "TZ");
    await pick(0, "t2w", "2");
    check((await lesions().nth(0).getByTestId("result").getAttribute("data-state")) === "incomplete", "TZ・T2W だけではカテゴリを出さず、足りない項目を示す");
    await pick(0, "dwi", "4");
    await pick(0, "sector", "R-mid-TZa");
    const cat1 = await lesions().nth(0).getByTestId("result").getAttribute("data-category");
    check(cat1 === "3", "TZ・T2W 2・DWI 4 → 総合 3（v2.1 で足された行）", { cat1 });
    check((await lesions().nth(1).getByTestId("result").getAttribute("data-state")) === "empty", "病変 2 は触らないので未入力のまま");
    check(await win().getByTestId("save").isEnabled(), "完成した病変があれば保存ボタンが有効");
    check(/完成 1 件 \/ 未完成 1 件/.test((await win().getByTestId("summary").textContent()) ?? ""), "件数表示「完成 1 件 / 未完成 1 件」");
    await viewer.screenshot({ path: path.join(OUT_DIR, "2-lesion1-scored.png") });

    // ---- 3. 窓をもう 1 枚開く → 入力が復元される ----
    await openPlugin();
    check((await lesions().count()) === 2, "開き直しても病変 2 行");
    const zone = await lesions().nth(0).getByTestId("zone").inputValue();
    const cat1b = await lesions().nth(0).getByTestId("result").getAttribute("data-category");
    check(zone === "TZ" && cat1b === "3", "開き直すと入力が ROI の属性から復元される（TZ・総合 3）", { zone, cat1b });

    // ---- 4. SR に保存（本体の確認ダイアログ） ----
    const before = new Set((await listSeries()).map((s) => s.seriesInstanceUid));
    const saveOnce = async () => {
      await win().getByTestId("save").click();
      const dlg = viewer.getByTestId("plugin-save-confirm");
      await dlg.waitFor({ state: "visible", timeout: 15_000 });
      check(true, "SR 保存で本体の確認ダイアログが出る（プラグインは確認を省けない）");
      await viewer.screenshot({ path: path.join(OUT_DIR, "confirm-dialog.png") });
      await viewer.getByTestId("plugin-save-confirm-button").click();
      await win().getByTestId("status").and(viewer.locator('[data-state="saved"]')).waitFor({ timeout: 20_000 });
    };
    const waitNewSr = async (known: Set<string>) => {
      for (let i = 0; i < 40; i++) {
        const nw = (await listSeries()).filter((s) => !known.has(s.seriesInstanceUid) && s.modality === "SR");
        if (nw.length) return nw;
        await new Promise((r) => setTimeout(r, 500));
      }
      return [];
    };
    await saveOnce();
    check(/SR を保存しました（病変 1 件、未完成の 1 件は除外）/.test((await win().getByTestId("status").textContent()) ?? ""), "保存の表示に「病変 1 件、未完成の 1 件は除外」", await win().getByTestId("status").textContent());
    const sr1 = await waitNewSr(before);
    check(sr1.length === 1, "SR シリーズが 1 本増える（1 回目）", sr1);

    // ---- 5. 病変 2 を入力 → 2 回目の保存・レポート差し込み ----
    await pick(1, "zone", "PZ");
    await pick(1, "dwi", "3");
    const r2a = await lesions().nth(1).getByTestId("result").textContent();
    check(/DCE 未入力/.test(r2a ?? ""), "PZ・DWI 3・DCE 未入力は 3 に注記が付く（決め打ちで格上げしない）", r2a);
    await pick(1, "dce", "positive");
    check((await lesions().nth(1).getByTestId("result").getAttribute("data-category")) === "4", "PZ・DWI 3・DCE 陽性 → 総合 4");
    await viewer.screenshot({ path: path.join(OUT_DIR, "3-both-scored.png") });
    const known2 = new Set([...before, ...sr1.map((s) => s.seriesInstanceUid)]);
    await saveOnce();
    check(/病変 2 件/.test((await win().getByTestId("status").textContent()) ?? ""), "2 回目の保存は病変 2 件", await win().getByTestId("status").textContent());
    const sr2 = await waitNewSr(known2);
    check(sr2.length === 1, "SR シリーズがさらに 1 本増える（2 回目）", sr2);
    await win().getByTestId("publish").click();
    await win().getByTestId("status").and(viewer.locator('[data-state="published"]')).waitFor({ timeout: 10_000 });
    check(true, "レポートへの差し込みが ok を返す");

    // ---- 保存した SR を取り出して読む ----
    const SAVED = path.join(OUT_DIR, "saved");
    fs.rmSync(SAVED, { recursive: true, force: true });
    fs.mkdirSync(SAVED, { recursive: true });
    const read = async (s: Series, tag: string): Promise<SrSummary> => {
      const inst = (await (await fetch(`${base}/api/studies/${studyUid}/series/${s.seriesInstanceUid}/instances`)).json()) as { sopInstanceUid: string }[];
      const r = await fetch(`${base}/api/studies/${studyUid}/series/${s.seriesInstanceUid}/instances/${inst[0].sopInstanceUid}/file`);
      check(r.ok, `${tag}: SR のファイルを取り出せる（HTTP ${r.status}）`);
      const f = path.join(SAVED, `${tag}.dcm`);
      fs.writeFileSync(f, Buffer.from(await r.arrayBuffer()));
      return JSON.parse(execFileSync("python3", ["-I", SR_READER, f], { encoding: "utf8" })) as SrSummary;
    };
    const a = await read(sr1[0], "sr1");
    const b = await read(sr2[0], "sr2");
    fs.writeFileSync(path.join(SAVED, "summary.json"), JSON.stringify({ sr1: a, sr2: b }, null, 2));
    const nm = (g: SrSummary["groups"][number], n: string) => g.nums.find((x) => x.name === n);
    const CAT = "PI-RADS v2.1 overall category";

    check(a.modality === "SR" && /PI-RADS v2\.1 assessment/.test(a.description ?? ""), "1 回目: SR で、説明に版が入る", a.description);
    check(a.groups.length === 1, "1 回目: groups は完成した 1 件だけ（未完成の病変 2 は入らない）", a.groups.map((g) => g.trackingId));
    const g1 = a.groups[0];
    check(g1?.trackingId === "lesion-1", "1 回目: 追跡 ID lesion-1", g1?.trackingId);
    check(nm(g1, CAT)?.value === 3 && nm(g1, CAT)?.unit === "{score}", "1 回目: 総合カテゴリが NUM（{score}）で 3", nm(g1, CAT));
    check(nm(g1, "PI-RADS v2.1 T2W score")?.value === 2 && nm(g1, "PI-RADS v2.1 DWI score")?.value === 4, "1 回目: T2W 2・DWI 4 が量の名前つきで入る", g1.nums);
    check(g1.nums.every((x) => x.meaning !== "score" || x.name), "1 回目: score にはすべて Quantity Name の修飾が付く");
    check(g1.nums.some((x) => x.unit === "mm" && /Long/i.test(x.meaning ?? "")), "1 回目: ROI の長径（mm）が入る", g1.nums.map((x) => [x.meaning, x.value, x.unit]));
    check(g1.refs.length === 1, "1 回目: 画像参照が 1 つ（ROI の SOP）", g1.refs);
    check(/領域 TZ/.test(g1.findingText ?? "") && /右 中部 TZa/.test(g1.findingText ?? ""), "1 回目: 所見に領域・セクタが入る", g1.findingText);
    const notes = a.findings.map((f) => f.text).join(" ");
    check(/診断機器ではありません/.test(notes) && /二次資料/.test(notes) && /CZ/.test(notes), "1 回目: 免責と PZ・CZ の限界が SR の所見に入る", notes.slice(0, 160));
    check(/除外した病変: 1/.test(notes), "1 回目: 除外した病変の件数が SR に残る");

    check(b.groups.length === 2, "2 回目: groups は 2 件", b.groups.map((g) => g.trackingId));
    const g2 = b.groups[1];
    check(nm(g2, CAT)?.value === 4, "2 回目: 病変 2（PZ・DWI 3・DCE 陽性）の総合は 4", nm(g2, CAT));
    check(/領域 PZ/.test(g2?.findingText ?? "") && /DCE 陽性/.test(g2?.findingText ?? ""), "2 回目: 病変 2 の所見に領域・DCE が入る", g2?.findingText);
    // 本体の既知の挙動（MeasurementReportService が SR の SeriesNumber を常に 9000 にする）。プラグインの合否に数えず、事実として残す。
    console.log(`  [本体の挙動・合否に数えない] 同じスタディの SR 2 本の SeriesNumber: ${JSON.stringify([a.seriesNumber, b.seriesNumber])}`);

    await viewer.screenshot({ path: path.join(OUT_DIR, "4-after-save.png") });
    console.log(`  保存した SR の出力先: ${SAVED}`);
    return summary();
  } finally {
    await driver.stop().catch(() => undefined);
  }
}

main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(1); });
