/*
 * 2D ビューアのウィンドウから host.db.pickSeries を呼んだときの窓の実機検証。GP-JOB-001 の「実機確認待ち」4。
 * 段 4 の pickSeriesCheck.ts は main 画面から呼ぶ経路だけだった（Host は main と 2D の両方に置いてある）。
 *
 * 実行:  cd backend && mvn -q -Dfrontend.skip=true -DskipTests clean package   （backend jar）
 *        cd automator && npx tsx src/spike/pickSeriesFromViewerCheck.ts
 *
 * 本物の Electron ＋ backend jar（jupyter_server は要らない）。テスト用プラグイン pickseries-viewer-check（viewer2d.menu）。
 * スクリーンショットは .results/pick-series-viewer-check:
 *   [1] 2D ビューアのメニューからプラグインを呼ぶ → 2D ビューアに窓が出る。main 側には窓が出ない（二重に出ない）
 *   [2] 選んで決定 → プラグインが受け取るのは選んだ順の UID だけ（患者名なし）。窓は閉じる
 *   [3] Esc → 空配列
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Page } from "playwright";

import { DesktopDriver, DESKTOP_RUN_DATA_DIR } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importFixtureCategory, importPaths } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { openFirstSeriesInViewer } from "../checklist/items/shared/helpers.js";
import { createStepRecorder } from "../checklist/types.js";
import { createChecker } from "./computeSpikeShared.js";

const { check, summary } = createChecker();
const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "pick-series-viewer-check");
const PLUGIN_ID = "pickseries-viewer-check";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(what: string, f: () => Promise<T | null | undefined | false>, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await f();
    if (v) return v;
    await sleep(150);
  }
  throw new Error(`待っても起きなかった: ${what}`);
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const dst = path.join(DESKTOP_RUN_DATA_DIR, "plugins", PLUGIN_ID);
  fs.mkdirSync(dst, { recursive: true });
  for (const n of ["plugin.json", "ui.js"]) fs.copyFileSync(path.join(AUTOMATOR_ROOT, "plugins", PLUGIN_ID, n), path.join(dst, n));

  const driver = new DesktopDriver();
  try {
    await driver.start();
    const main = driver.page;
    await resetDb(driver.ports.http);
    // ct-basic は CT が 1 シリーズだけなので、別の CT の検査（環境変数 PICK_EXTRA_DIR。既定は ~/graphy-demo-samples/HCC_001）も足して「選べる CT が 2 つ以上」にする
    await importFixtureCategory(driver.ports.http, "ct-basic");
    const extra = process.env.PICK_EXTRA_DIR ?? path.join(os.homedir(), "graphy-demo-samples", "HCC_001");
    if (fs.existsSync(extra)) await importPaths(driver.ports.http, [extra]);
    else console.log(`  [skip] 追加の CT の場所が無い: ${extra}`);
    await main.evaluate("localStorage.setItem('graphy.locale', 'ja')");
    await main.reload({ waitUntil: "domcontentloaded" });
    await main.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    const later = main.getByRole("button", { name: /^(後で|Later)$/ });
    if (await later.isVisible().catch(() => false)) await later.click();

    const base = `http://localhost:${driver.ports.http}`;
    const studies = (await (await fetch(`${base}/api/studies`)).json()) as { studyInstanceUid: string; patientName: string | null }[];
    const cts: { studyUid: string; seriesUid: string; patientName: string | null }[] = [];
    for (const st of studies) {
      const ser = (await (await fetch(`${base}/api/studies/${st.studyInstanceUid}/series`)).json()) as { seriesInstanceUid: string; modality: string }[];
      for (const x of ser.filter((q) => q.modality === "CT")) cts.push({ studyUid: st.studyInstanceUid, seriesUid: x.seriesInstanceUid, patientName: st.patientName });
    }
    console.log(`  （前提）検査 ${studies.length} 件・CT シリーズ ${cts.length} 件`);
    if (cts.length < 2) throw new Error("検証には CT のシリーズが 2 つ以上要ります（fixtures を確認）");
    const [pa, pb] = [cts[1], cts[0]];
    const names = [...new Set(cts.map((c) => c.patientName).filter((n): n is string => !!n))];

    // 2D ビューアを開く
    await openFirstSeriesInViewer(main, createStepRecorder());
    const viewer = await driver.waitForNewPage(
      () => main.getByTestId("viewer2d-toolbar-button").click(),
      (url) => url.includes("2dviewer"),
    );
    await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 30_000 });
    await viewer.waitForTimeout(2500);

    const call = async (input: Record<string, unknown>) => {
      await viewer.evaluate((i) => {
        (window as unknown as Record<string, unknown>).__pickInput = i;
        (window as unknown as Record<string, unknown>).__pickState = undefined;
      }, input);
      // メニューが開いたままのことがあるので、項目が見えなければ開く（押すたびに開閉が入れ替わる）
      if ((await viewer.getByTestId(`plugin-item-${PLUGIN_ID}`).count()) === 0) await viewer.getByTestId("viewer2d-menu-plugins").click();
      await viewer.getByTestId(`plugin-item-${PLUGIN_ID}`).click();
    };
    const state = (): Promise<Row | undefined> => viewer.evaluate(() => (window as unknown as { __pickState?: Row }).__pickState);
    const dialogIn = (p: Page) => p.getByTestId("pickseries-dialog");
    // 窓が重なって複数あるときも先へ進めるよう、操作は DOM で最後（＝いちばん手前）のものに対して行う。1 枚だけかは別の検査で見る
    const top = (id: string) => viewer.getByTestId(id).last();

    // ── [1] 2D ビューアから呼ぶ ──
    console.log("\n[1] 2D ビューアのメニューから呼ぶ");
    check(viewer.url().includes("2dviewer"), "（前提）呼ぶ側は 2D ビューアのウィンドウ（main ではない）", viewer.url());
    await viewer.getByTestId("viewer2d-menu-plugins").click();
    check((await viewer.getByTestId(`plugin-item-${PLUGIN_ID}`).count()) === 1, "（前提）2D ビューアの Plugins メニューにテスト用プラグインがある");
    await call({ title: "CT を選ぶ（2D から）", modalities: ["CT"] });
    await top("pickseries-dialog").waitFor({ state: "visible", timeout: 20_000 });
    check(true, "🔴 2D ビューアのウィンドウに窓が出る");
    check((await dialogIn(viewer).count()) === 1, "🔴 2D ビューアの窓は 1 枚だけ（Host が重ねて置かれていない）", { dialogs: await dialogIn(viewer).count(), titles: await viewer.getByTestId("pickseries-title").allTextContents() });
    check(((await top("pickseries-title").textContent()) ?? "") === "CT を選ぶ（2D から）", "プラグインのタイトルが出る");
    check((await dialogIn(main).count()) === 0, "🔴 main の画面には窓が出ない（二重に出ない）");
    await top(`pickseries-study-${pa.studyUid}`).waitFor({ state: "visible", timeout: 20_000 });
    check(names.length > 0 && ((await top("pickseries-list").textContent()) ?? "").includes(names[0]), "（前提）窓には患者名が出ている（プラグインには渡らないことを、このあと確かめる）", names);
    for (const c of [pa, pb]) {
      await top(`pickseries-study-${c.studyUid}`).waitFor({ state: "visible", timeout: 20_000 });
      const chk = top(`pickseries-series-check-${c.seriesUid}`);
      if ((await chk.count()) === 0) await top(`pickseries-expand-${c.studyUid}`).click();
      await chk.check();
    }
    await viewer.screenshot({ path: path.join(OUT_DIR, "ui-01-viewer-pick.png") });

    // ── [2] 決定 ──
    console.log("\n[2] 決定");
    await top("pickseries-ok").click();
    const st = await waitFor("プラグインが結果を受け取る", async () => (await state())?.picked ?? (await state())?.error, 20_000).then(async () => (await state()) as Row);
    check(st.error === null, "（前提）プラグインの呼び出しが例外にならない", st.error);
    check(JSON.stringify(st.picked) === JSON.stringify([{ studyUid: pa.studyUid, seriesUid: pa.seriesUid }, { studyUid: pb.studyUid, seriesUid: pb.seriesUid }]), "プラグインが受け取ったのは、選んだ順の UID（studyUid・seriesUid）", st.picked);
    check(names.length > 0 && names.every((n) => !JSON.stringify(st.picked).includes(n)), "🔴 返り値に患者名が含まれない");
    check((await dialogIn(viewer).count()) === 0, "決定すると窓は閉じる");

    // ── [3] Esc ──
    console.log("\n[3] 取り消し");
    await call({ modalities: ["CT"] });
    await top("pickseries-dialog").waitFor({ state: "visible", timeout: 20_000 });
    await top(`pickseries-study-${pb.studyUid}`).waitFor({ state: "visible", timeout: 20_000 });
    if ((await top(`pickseries-series-check-${pb.seriesUid}`).count()) === 0) await top(`pickseries-expand-${pb.studyUid}`).click();
    await top(`pickseries-series-check-${pb.seriesUid}`).check();
    await viewer.keyboard.press("Escape");
    await waitFor("取り消しの結果", async () => (await state())?.picked != null, 20_000);
    check(JSON.stringify(((await state()) as Row).picked) === "[]", "🔴 Esc で取り消すと空配列（選んでいても返さない）");
    check((await dialogIn(viewer).count()) === 0, "窓は閉じる");
  } finally {
    await driver.stop().catch(() => undefined);
  }
  if (summary() > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
