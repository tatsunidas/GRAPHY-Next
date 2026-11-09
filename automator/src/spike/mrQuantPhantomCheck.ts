/*
 * MR Quant（T2 マップ）プラグイン: 合成のマルチエコー MR ファントム（既知の T2）が実アプリで通るかの検査。
 * 4 つの場面を、同じ起動の中で DB を作り直して順に通す。
 *   A. 1 シリーズに全エコー（EchoNumbers で C 分割）・雑音なし: 「表示中のシリーズを追加」→ 既定のまま計算 → 保存（2 巡）
 *   B. TE ごとに別シリーズ・雑音あり（SNR 30）: 保管庫から追加 → 既定のまま計算 → 保存（2 巡）。測れない円柱（T2=5000）がデータ無し
 *   C. TE を消したシリーズ（負例）: TE が読めず、計算が無効で理由が出る
 *   D. 位置が減る順で書いたシリーズ・体の T2 が位置で変わる: 保存したスライスの位置と値の対応
 * 保存したファイルを `automator/.results/mr-quant-phantom-check/<場面>/saved/{r1,r2}/` に取り出し、
 * `scripts/check-t2-saved.py`（真値との突き合わせ）を通す。SeriesNumber の重なりは、取り出したファイルで別途検査する。
 *
 * 実行:  cd automator && MRQ_PHANTOM=<A/ B/ C/ D/ を持つフォルダ> npx tsx src/spike/mrQuantPhantomCheck.ts
 *        （プラグインの ui.js を先にビルドしておく。JDK を PATH に足す。MRQ_PORT_BASE で専用ポート）
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
const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "mr-quant-phantom-check");
const PLUGIN_ID = "vis-mr-quant";
const PLUGIN_DIR = process.env.MRQ_PLUGIN_DIR ?? path.join(os.homedir(), "graphy-workspace", "graphy-next-plugin-mr-quant");
const PH = process.env.MRQ_PHANTOM;
const P0 = Number(process.env.MRQ_PORT_BASE ?? 28781);
const PORTS = { http: P0, scp: P0 + 1, vite: P0 + 2 };
const SAVED_CHECK = path.join(AUTOMATOR_ROOT, "scripts", "check-t2-saved.py");
const TE = [10, 20, 40, 80, 160];

interface Phase {
  id: "A" | "B" | "C" | "D";
  title: string;
  /** channels: 1 シリーズ C 分割 / series: TE ごとに別シリーズ */
  form: "channels" | "series";
  /** 追加のしかた。default = 表示中を追加、library = 保管庫から全部選ぶ */
  add: "current" | "library";
  /** true = TE が読めない負例（保存まで進まない） */
  noTe?: boolean;
  tol?: number;
  padDisks?: string;
  zT2?: boolean;
  /** 保存の説明（画面の σ）から読んだ σ̂ を、データ無しの割合の予測に渡す。 */
  needsSigma?: boolean;
}
const PHASES: Phase[] = [
  { id: "A", title: "1 シリーズ C 分割・雑音なし・表示中を追加", form: "channels", add: "current", tol: 0.01 },
  { id: "B", title: "TE 別シリーズ・SNR 30・保管庫から追加（測れない円柱）", form: "series", add: "library", tol: 0.05, padDisks: "5000", needsSigma: true },
  { id: "C", title: "TE を消した負例", form: "series", add: "library", noTe: true },
  { id: "D", title: "位置が減る順・体の T2 が位置で変わる", form: "series", add: "library", tol: 0.02, zT2: true },
];

type Series = { seriesInstanceUid: string; seriesDescription?: string; numberOfInstances?: number };

async function runPhase(driver: DesktopDriver, ph: Phase): Promise<void> {
  console.log(`\n===== 場面 ${ph.id}: ${ph.title} =====`);
  const dir = path.join(PH!, ph.id);
  const outDir = path.join(OUT_DIR, ph.id);
  fs.mkdirSync(outDir, { recursive: true });
  await resetDb(driver.ports.http);
  const roots = ph.form === "channels" ? [path.join(dir, "echoes")] : TE.map((t) => path.join(dir, `te${t}`));
  const imp = await importPaths(driver.ports.http, roots);
  const nFiles = ph.form === "channels" ? 40 : 40;
  check(imp.failed === 0 && imp.imported === nFiles, `（前提）${ph.id}: ${nFiles} 枚を取り込めた`, imp);

  const base = `http://localhost:${driver.ports.http}`;
  const studies = (await (await fetch(`${base}/api/studies`)).json()) as { studyInstanceUid: string }[];
  const studyUid = studies[0].studyInstanceUid;
  const listSeries = async () => (await (await fetch(`${base}/api/studies/${studyUid}/series`)).json()) as Series[];
  const series = await listSeries();
  const input = series.filter((s) => !/\[Plugin\]/.test(s.seriesDescription ?? ""));
  check(input.length === (ph.form === "channels" ? 1 : 5), `（前提）入力のシリーズ数 ${ph.form === "channels" ? 1 : 5}`, input.map((s) => s.seriesDescription));
  const first = ph.form === "channels" ? input[0] : input.find((s) => /TE10$/.test(s.seriesDescription ?? ""))!;

  const mainPage = driver.page;
  await mainPage.evaluate("localStorage.setItem('graphy.locale', 'ja')");
  await mainPage.reload({ waitUntil: "domcontentloaded" });
  await mainPage.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
  await selectFirstStudy(mainPage, createStepRecorder());
  await mainPage.locator(`[data-testid="series-row-${first.seriesInstanceUid}"]`).click();
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
  await viewer.getByTestId("run").waitFor({ state: "visible", timeout: 15_000 });
  check(/診断機器ではありません/.test((await viewer.getByTestId("disclaimer").textContent()) ?? ""), "免責が画面の先頭に出る");
  check(await viewer.getByTestId("run").isDisabled(), "入力が無いうちは計算ボタンが無効");

  if (ph.add === "current") {
    await viewer.getByTestId("add-current").click();
  } else {
    await viewer.getByTestId("add-library").click();
    await viewer.getByTestId("pickseries-dialog").last().waitFor({ state: "visible", timeout: 20_000 });
    const top = (id: string) => viewer.getByTestId(id).last();
    await top(`pickseries-study-${studyUid}`).waitFor({ state: "visible", timeout: 20_000 });
    if ((await top(`pickseries-series-check-${input[0].seriesInstanceUid}`).count()) === 0) await top(`pickseries-expand-${studyUid}`).click();
    for (const s of input) await top(`pickseries-series-check-${s.seriesInstanceUid}`).check();
    await top("pickseries-ok").click();
  }
  await viewer.waitForFunction(() => document.querySelectorAll('[data-testid="input-row"]').length >= 5, undefined, { timeout: 30_000 });
  const tes = (await viewer.evaluate(`Array.from(document.querySelectorAll('[data-testid="te-input"]')).map(function(i){return i.value})`)) as string[];
  console.log(`  入力の TE（DICOM (0018,0081) から読み取り）: ${JSON.stringify(tes)}`);

  if (ph.noTe) {
    check(tes.every((v) => v === ""), "🔴 負例: TE を消したシリーズでは TE が読めない（既定値を置かない）", tes);
    check((await viewer.getByTestId("use-input").evaluateAll((es) => es.every((e) => !(e as HTMLInputElement).checked))), "TE が読めない入力は既定で選ばれない");
    const run = viewer.getByTestId("run");
    check(await run.isDisabled(), "🔴 負例: 計算ボタンが無効");
    const reason = (await run.getAttribute("title")) ?? "";
    check(/エコー|TE/.test(reason), "無効の理由がツールチップに出る", reason);
    const shown = (await viewer.getByTestId("run-reason").textContent()) ?? "";
    check(/計算できません: .*TE/.test(shown) && (await viewer.getByTestId("run-reason").isVisible()), "無効の理由が画面にも出る", shown);
    await viewer.screenshot({ path: path.join(outDir, "no-te.png") });
    await viewer.close();
    return;
  }
  check(tes.slice().sort((a, b) => Number(a) - Number(b)).join() === TE.join(), "TE が DICOM から 10・20・40・80・160 と読める", tes);
  check(await viewer.getByTestId("use-input").evaluateAll((es) => es.length === 5 && es.every((e) => (e as HTMLInputElement).checked)), "既定のまま 5 つとも使う");

  const waitDone = () => viewer.waitForFunction(
    () => /計算しました|できません|ません|ください/.test(document.querySelector('[data-testid="status-box"]')?.textContent ?? "") && !document.querySelector('[data-testid="run"]')?.hasAttribute("disabled"),
    undefined, { timeout: 240_000 });
  console.log("\n[計算] 条件は触らない（σ は空 = 画像から推定。p は既定 0.01）");
  await viewer.getByTestId("run").click();
  await waitDone();
  await viewer.waitForTimeout(3500);
  const status = (await viewer.getByTestId("status-box").textContent()) ?? "";
  console.log(`  status: ${status}`);
  check(/計算しました（5 エコー、TE 10, 20, 40, 80, 160 ms）/.test(status), "🔴 計算が通り、5 エコーとして扱われる", status);
  check((await hostCount()) === 2, "T2 マップのタイルが 1 つ開く（元の画像と 2 タイル）", await hostCount());
  await viewer.screenshot({ path: path.join(outDir, "1-computed.png") });
  await viewer.evaluate(`document.querySelectorAll('.graphy-plugin-window').forEach(function(w){ w.style.display = 'none'; })`);
  await viewer.waitForTimeout(1200);
  await viewer.screenshot({ path: path.join(outDir, "1-computed-tiles.png") });
  await viewer.evaluate(`document.querySelectorAll('.graphy-plugin-window').forEach(function(w){ w.style.display = ''; })`);

  console.log("\n[保存] 2 巡");
  const before = new Set((await listSeries()).map((x) => x.seriesInstanceUid));
  const saveOnce = async (label: string) => {
    await viewer.getByTestId("save").click();
    await viewer.waitForTimeout(1500);
    const dlg = viewer.getByTestId("plugin-save-confirm");
    const shown = await dlg.isVisible().catch(() => false);
    console.log(`  ${label}: consent dialog visible = ${shown}`);
    if (shown) await viewer.getByTestId("plugin-save-confirm-button").click();
    await viewer.waitForFunction(() => /保存しました|保存できません|キャンセル|保存しません/.test(document.querySelector('[data-testid="status-box"]')?.textContent ?? ""), undefined, { timeout: 60_000 });
    const t = (await viewer.getByTestId("status-box").textContent()) ?? "";
    console.log(`  ${label}: ${t}`);
    check(/保存しました（8 枚）/.test(t), `🔴 ${label}: 保存できた（8 枚）`, t);
  };
  await saveOnce("1 巡目");
  const waitNew = async (exclude: Set<string>): Promise<Series[]> => {
    let last: Series[] = [];
    for (let i = 0; i < 40; i++) {
      last = (await listSeries()).filter((x) => !exclude.has(x.seriesInstanceUid));
      if (last.length === 1 && last[0].numberOfInstances === 8) break;
      await viewer.waitForTimeout(500);
    }
    return last;
  };
  const round1 = await waitNew(before);
  check(round1.length === 1, "派生シリーズが 1 本増える（1 巡目）", round1);
  await saveOnce("2 巡目");
  const ids1 = new Set([...before, ...round1.map((x) => x.seriesInstanceUid)]);
  const round2 = await waitNew(ids1);
  check(round2.length === 1, "派生シリーズがさらに 1 本増える（2 巡目）", round2);

  const SAVED = path.join(outDir, "saved");
  fs.rmSync(SAVED, { recursive: true, force: true });
  const dirs: string[] = [];
  for (const [round, list] of [["r1", round1], ["r2", round2]] as const) {
    for (const a of list) {
      const dd = path.join(SAVED, round, (a.seriesDescription ?? a.seriesInstanceUid).replace(/[^\w.-]+/g, "_"));
      fs.mkdirSync(dd, { recursive: true });
      const sops = (await (await fetch(`${base}/api/studies/${studyUid}/series/${a.seriesInstanceUid}/instances`)).json()) as { sopInstanceUid: string }[];
      for (const [i, o] of sops.entries()) {
        const r = await fetch(`${base}/api/studies/${studyUid}/series/${a.seriesInstanceUid}/instances/${o.sopInstanceUid}/file`);
        fs.writeFileSync(path.join(dd, `${String(i + 1).padStart(2, "0")}.dcm`), Buffer.from(await r.arrayBuffer()));
      }
      dirs.push(dd);
    }
  }
  console.log(`  保存ファイルの出力先: ${SAVED}`);
  console.log(`  保存した説明: ${JSON.stringify([...round1, ...round2].map((x) => x.seriesDescription))}`);

  console.log("\n[真値との突き合わせ] scripts/check-t2-saved.py（保存した DICOM を pydicom で読む）");
  for (const dd of dirs) {
    const args = ["-I", SAVED_CHECK, dd, path.join(dir, "truth.json"), "--tol", String(ph.tol ?? 0.05), "--expect-instances", "8"];
    if (ph.padDisks) args.push("--padding-disks", ph.padDisks);
    if (ph.needsSigma) {
      const m = /σ=([\d.]+)（画像から推定）/.exec(status);
      check(!!m, "画面の状況表示から σ̂ を読める", status.slice(0, 200));
      if (m) args.push("--sigma-est", m[1]);
    }
    if (ph.zT2) args.push("--z-t2");
    let out = "";
    let code = 0;
    try {
      out = execFileSync("python3", args, { encoding: "utf8" });
    } catch (e) {
      const err = e as { stdout?: string; status?: number };
      out = err.stdout ?? "";
      code = err.status ?? 1;
    }
    console.log(out.split("\n").map((l) => "    " + l).join("\n"));
    check(code === 0, `🔴 ${path.relative(SAVED, dd)}: 保存した T2 が真値と一致する`, out.split("\n").filter((l) => /FAIL/.test(l)));
  }

  console.log("\n[保存したシリーズを 2D ビューアで開いて目で見る]");
  await viewer.close();
  await mainPage.reload({ waitUntil: "domcontentloaded" });
  await mainPage.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
  await selectFirstStudy(mainPage, createStepRecorder());
  await mainPage.waitForTimeout(1500);
  const row = mainPage.locator(`[data-testid="series-row-${round2[0]?.seriesInstanceUid}"]`);
  if (round2[0] && (await row.count()) > 0) {
    await row.click();
    await mainPage.getByTestId("series-viewer-root").waitFor({ state: "visible", timeout: 15_000 });
    await mainPage.waitForTimeout(2500);
    const v2: Page = await driver.waitForNewPage(
      () => mainPage.getByTestId("viewer2d-toolbar-button").click(),
      (url) => url.includes("2dviewer"),
    );
    await v2.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 30_000 });
    await v2.waitForTimeout(3000);
    await v2.setViewportSize({ width: 1900, height: 1150 });
    await v2.waitForTimeout(1500);
    await v2.screenshot({ path: path.join(outDir, "3-saved-in-viewer.png") });
    await v2.close();
  } else console.log("  【未達】保存済みシリーズを一覧から開けなかった");
}

async function main(): Promise<number> {
  if (!PH || !fs.existsSync(path.join(PH, "A", "truth.json")) || !fs.existsSync(path.join(PLUGIN_DIR, "ui.js"))) {
    console.log("【未達】入力が足りません（MRQ_PHANTOM に A/ B/ C/ D/ と truth.json、プラグインの ui.js）。合格ではありません。");
    return 2;
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const dst = path.join(DESKTOP_RUN_DATA_DIR, "plugins", PLUGIN_ID);
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(dst, { recursive: true });
  for (const n of ["plugin.json", "ui.js"]) fs.copyFileSync(path.join(PLUGIN_DIR, n), path.join(dst, n));

  const driver = new DesktopDriver(PORTS);
  try {
    await driver.start();
    const only = process.env.MRQ_ONLY;
    for (const ph of PHASES) if (!only || only.includes(ph.id)) await runPhase(driver, ph);
  } finally {
    await driver.stop().catch(() => undefined);
  }
  return summary();
}

main().then((n) => process.exit(n)).catch((e) => { console.error(e); process.exit(1); });
