/*
 * 解析結果のレポート差し込み（A14）の実機検証 — `fw/angio-design.md` §21.5。
 *
 * 準備:  cd bench && python3 make_phantom_xa.py --out ./phantom
 *        cd backend && mvn -q -Dfrontend.skip=true -DskipTests package
 * 実行:  cd automator && npx tsx src/spike/reportAnalysisCheck.ts
 *
 * <h3>ここで確かめたいこと</h3>
 * **数値だけが差し込まれていないこと。** レポートは人が読んで判断する最終成果物なので、
 * 出自（校正・手修正）と限界（系統誤差・研究用）が**数値と同じブロック**に入っていなければ
 * 意味が無い。DOM に何か入ったかではなく、**本文の中身**を読んで確かめる。
 *
 * <p>もう 1 つの要点は**ウィンドウ跨ぎ**。解析はビューアのウィンドウで走り、レポートは
 * メインウィンドウで書く。中継が効いていなければ、そもそも候補に出ない。
 */
import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { waitForMainScreenReady } from "../checklist/items/shared/helpers.js";
import { dismissStartupDialogs, findBlockingOverlay } from "../common/dismissDialogs.js";
import { dragOnCanvasHost } from "../common/pointerDrag.js";

const REPO_ROOT = path.resolve(AUTOMATOR_ROOT, "..");
const PHANTOM_DIR = path.join(REPO_ROOT, "bench", "phantom", "GNBP-XA");
const TRUTH_PATH = path.join(PHANTOM_DIR, "truth.json");
const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "report-analysis");
const HOST = "viewer2d-canvas-host";

let pass = 0;
let fail = 0;
const lines: string[] = [];

function check(cond: boolean, label: string, detail?: unknown): void {
  if (cond) pass++;
  else fail++;
  const d = detail === undefined ? "" : ` ${JSON.stringify(detail)}`;
  lines.push(`  [${cond ? "ok  " : "FAIL"}] ${label}${d}`);
  console.log(lines[lines.length - 1]);
}

interface Truth {
  qca: { file: string; studyInstanceUid: string; frames: { frame: number; percentDiameterStenosis: number }[] };
}

async function openStudy(page: Page, studyUid: string): Promise<void> {
  await dismissStartupDialogs(page);
  const blocker = await findBlockingOverlay(page, "search-submit-button");
  if (blocker) throw new Error(`検索ボタンが塞がれています: ${blocker}`);
  const dates = page.locator('input[type="date"]');
  await dates.nth(0).fill("");
  await dates.nth(1).fill("");
  await page.getByTestId("search-submit-button").click();
  const row = page.locator(`[data-testid="study-row-${studyUid}"]`);
  await row.waitFor({ state: "visible", timeout: 20_000 });
  for (let i = 0; i < 3; i++) {
    await row.click();
    await page.waitForTimeout(800);
    if ((await page.locator('[data-testid^="series-row-"]').count()) > 0) return;
  }
  throw new Error("シリーズ行が出ません");
}

/** 画像中央を中心に、血管軸（水平）へ ±`halfSpanMm` の計測を引く。 */
async function drawSegmentMm(viewer: Page, halfSpanMm: number): Promise<void> {
  const raw = (await viewer.evaluate(`(() => {
    const g = window.__graphyDebug;
    const geo = g && g.getViewportGeometry ? g.getViewportGeometry() : null;
    if (!geo || !geo.length) return null;
    const v = geo[0];
    return JSON.stringify({ h: v.canvas.height, w: v.canvas.width, ps: v.camera.parallelScale });
  })()`)) as string | null;
  if (!raw) throw new Error("ビューポートの幾何を取得できませんでした");
  const { h, w, ps } = JSON.parse(raw) as { h: number; w: number; ps: number };
  const mmPerCanvasPx = (2 * ps) / h;
  const halfPx = halfSpanMm / mmPerCanvasPx;
  if (halfPx * 2 < 20) throw new Error(`表示が小さすぎます（${(halfPx * 2).toFixed(1)}px）`);
  await dragOnCanvasHost(viewer, HOST, Math.round(halfPx * 2), 0, 0, 12, {
    fracX: 0.5 - halfPx / w,
    fracY: 0.5,
  });
  await viewer.waitForTimeout(800);
}

async function main(): Promise<void> {
  if (!fs.existsSync(TRUTH_PATH)) {
    throw new Error(`ファントムがありません: ${PHANTOM_DIR}`);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const truth = JSON.parse(fs.readFileSync(TRUTH_PATH, "utf8")) as Truth;

  const driver = new DesktopDriver();
  await driver.start();
  try {
    const mainPage = driver.page;
    // ⚠️ ネイティブの確認ダイアログは**常設のハンドラ 1 つ**で受ける。
    //    `once` を場所ごとに登録すると、同じダイアログに 2 つ反応して
    //    「Cannot accept dialog which is already handled」で落ちる（実際に踏んだ）。
    mainPage.on("dialog", (d) => void d.accept().catch(() => {}));
    await resetDb(driver.ports.http);
    const imp = await importPaths(driver.ports.http, [path.join(PHANTOM_DIR, truth.qca.file)]);
    check(imp.imported === 1, "[準備] ファントムを取り込めた", imp);

    await waitForMainScreenReady(mainPage, 60_000);
    await dismissStartupDialogs(mainPage);
    await openStudy(mainPage, truth.qca.studyInstanceUid);

    // ── レポートを開き、まだ差し込めるものが無いことを確かめる ──
    // 🚨 「差し込めた」だけを見ると、**最初から候補があった**場合と区別が付かない。
    await mainPage.getByTestId("report-toolbar-button").click();
    await mainPage.getByTestId("report-body").waitFor({ state: "visible", timeout: 20_000 });
    const before = await mainPage.getByTestId("report-analysis-select").locator("option").allTextContents();
    check(
      before.length === 1,
      "[前提] 解析前は差し込む候補が無い（『無い』状態を先に固定する）",
      before,
    );
    // ダイアログを閉じる。⚠️ Esc では閉じない（下書きの破棄確認があるため）ので、閉じるボタンを押す。
    await mainPage.getByTestId("report-close").click();
    await mainPage.getByTestId("report-body").waitFor({ state: "detached", timeout: 15_000 });
    await mainPage.waitForTimeout(600);

    // ── ビューアで QCA を走らせる ─────────────────────────────
    // ⚠️ レポートを閉じると一覧が再取得されてスタディの選択が外れる。選び直す。
    await openStudy(mainPage, truth.qca.studyInstanceUid);
    await mainPage.locator('[data-testid^="series-row-"]').first().click();
    const viewer = await driver.waitForNewPage(
      () => mainPage.getByTestId("viewer2d-toolbar-button").click(),
      (url) => url.includes("2dviewer"),
    );
    await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 30_000 });
    await viewer.waitForTimeout(3_000);
    await viewer.getByTestId("viewer2d-menu-roi").click();
    await viewer.waitForTimeout(250);
    await viewer.getByText("長さ", { exact: true }).first().click();
    await viewer.waitForTimeout(300);
    // 🚨 ドラッグの座標は**キャンバスの割合**であって画像の割合ではない。画像はキャンバスに
    //    fit されるので、割合を決め打ちすると始終点が**画像の外**へ落ちて解析が失敗する
    //    （`xaPhantomCheck.ts` と同じ罠。実際にここで踏んだ）。カメラから mm/px を求めて
    //    **mm で長さを決める**。
    await drawSegmentMm(viewer, 40);
    await viewer.getByTestId("xa-analysis-open").click();
    await viewer.getByTestId("xa-analysis-dialog").waitFor({ state: "visible", timeout: 10_000 });
    await viewer.getByTestId("xa-qca-run").click();
    await viewer.waitForTimeout(3_500);
    const qca = (await viewer.evaluate(`(() => {
      const g = window.__graphyDebug;
      const s = g && g.getQcaState ? g.getQcaState() : null;
      return s ? JSON.stringify({ mld: s.mld, rvd: s.rvd, ds: s.percentDiameterStenosis, unit: s.unit }) : null;
    })()`)) as string | null;
    check(!!qca, "[解析] QCA が走った", qca);
    if (!qca) return;
    const q = JSON.parse(qca) as { mld: number; rvd: number; ds: number; unit: string };
    await viewer.getByTestId("xa-dialog-close").click();
    await viewer.waitForTimeout(400);
    await viewer.screenshot({ path: path.join(OUT_DIR, "1-qca.png") }).catch(() => {});

    // ── メインウィンドウのレポートに差し込む ───────────────────
    // 🚨 解析はビューアのウィンドウで走った。ここに候補が出れば**ウィンドウ跨ぎの中継**が効いている。
    await mainPage.bringToFront();
    await mainPage.getByTestId("report-toolbar-button").click();
    await mainPage.getByTestId("report-body").waitFor({ state: "visible", timeout: 20_000 });
    const options = await mainPage.getByTestId("report-analysis-select").locator("option").allTextContents();
    check(options.length >= 2, "[中継] ビューアで走らせた解析がレポート側の候補に出る", options);
    if (options.length < 2) return;

    const values = (await mainPage.evaluate(`(() => {
      const sel = document.querySelector('[data-testid="report-analysis-select"]');
      return JSON.stringify(Array.from(sel.options).map((o) => o.value).filter(Boolean));
    })()`)) as string;
    const ids = JSON.parse(values) as string[];
    await mainPage.selectOption('[data-testid="report-analysis-select"]', ids[0]);
    await mainPage.waitForTimeout(300);

    // 差し込む前の本文を控える（**置き換えていない**ことを確かめるため）。
    const bodyBefore = (await mainPage.getByTestId("report-body").inputValue()) ?? "";
    await mainPage.getByTestId("report-analysis-insert").click();
    await mainPage.getByTestId("report-analysis-inserted").waitFor({ state: "visible", timeout: 10_000 });
    const body = (await mainPage.getByTestId("report-body").inputValue()) ?? "";

    check(body.length > bodyBefore.length, "[差し込み] 本文が伸びた", {
      before: bodyBefore.length,
      after: body.length,
    });
    // 🚨 **元の本文を消していない**（人が書いた所見を解析結果で上書きしない）。
    check(
      bodyBefore.trim().length === 0 || body.includes(bodyBefore.trim()),
      "[差し込み] ★元の本文を置き換えていない",
      { before: bodyBefore.slice(0, 40) },
    );

    // ── 中身の検査（ここが本題）────────────────────────────
    check(body.includes("QCA"), "[内容] 見出しが入る", body.slice(0, 60));
    check(body.includes(q.mld.toFixed(2)), "[内容] MLD が画面と同じ値で入る", {
      want: q.mld.toFixed(2),
    });
    check(body.includes(q.ds.toFixed(1)), "[内容] %DS が画面と同じ値で入る", { want: q.ds.toFixed(1) });
    // 🔴 **出自と限界が同じブロックに入っていること**。数値だけの差し込みを許さない。
    check(/空間校正|Spatial calibration/.test(body), "[内容] ★空間校正の出自が入る");
    check(/手修正|Manual correction/.test(body), "[内容] ★手修正の有無が入る");
    check(/13%/.test(body), "[内容] ★系統誤差（径 13% 過小）の注記が入る");
    check(/研究用|Research analysis/.test(body), "[内容] ★研究用である旨が入る");
    // 注意書きは引用ブロックで、計測表より後ろに出る。
    const table = body.indexOf("| MLD |");
    const caveat = body.search(/^> /m);
    check(table >= 0 && caveat > table, "[内容] 注意書きが計測表の直後にある（末尾へ追いやらない）", {
      table,
      caveat,
    });

    // 2 回差し込んでも前のブロックが消えないこと。
    await mainPage.getByTestId("report-analysis-insert").click();
    await mainPage.waitForTimeout(500);
    const twice = (await mainPage.getByTestId("report-body").inputValue()) ?? "";
    const occurrences = twice.split("| MLD |").length - 1;
    check(occurrences === 2, "[差し込み] 2 回押すと 2 ブロックになる（上書きしない）", occurrences);

    await mainPage.screenshot({ path: path.join(OUT_DIR, "2-report.png") }).catch(() => {});
    fs.writeFileSync(path.join(OUT_DIR, "body.md"), twice);
  } finally {
    await driver.stop().catch(() => {});
    const summary = `\n===== レポートへの解析結果の差し込み（A14）実機検証 =====\n合格 ${pass} / 失敗 ${fail}`;
    console.log(summary);
    fs.writeFileSync(path.join(OUT_DIR, "log.txt"), lines.join("\n") + summary + "\n");
  }
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
