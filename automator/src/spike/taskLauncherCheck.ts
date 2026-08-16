/*
 * 解析タスク・ランチャー（A13-2）の実機検証 — `fw/angio-design.md` §21.2。
 *
 * 準備:  cd bench && python3 make_phantom_xa.py --out ./phantom
 *        cd backend && mvn -q -Dfrontend.skip=true -DskipTests package
 * 実行:  cd automator && npx tsx src/spike/taskLauncherCheck.ts
 *
 * <h3>ここで確かめたいこと</h3>
 * ランチャーの本題は**カードが並ぶこと**ではなく、次の 3 つ。
 * 1. **押せないカードに必ず理由が出る**（§21.2「無言で押せないボタンを並べない」）。
 *    未実装かどうか・モダリティ・スタディ選択で理由が変わる。
 * 2. **押すと本当にその解析が開く**。ランチャーはメインウィンドウ、解析ダイアログは
 *    2D ビューアのウィンドウにあるので、**ウィンドウ跨ぎの受け渡し**が要る。
 * 3. 🚨 **依頼が残らない**。依頼を localStorage に置くと、次にビューアを開いただけで
 *    解析ダイアログが勝手に開く。**ビューアを再読込しても開かない**ことで確かめる
 *    （シリーズの再表示＝ビューアのコンテキストは残るので、両者が分かれていることも同時に見る）。
 */
import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT, categoryDir, getCategory, listCategoryFiles } from "../fixtures/manifest.js";
import { waitForMainScreenReady } from "../checklist/items/shared/helpers.js";
import { dismissStartupDialogs, findBlockingOverlay } from "../common/dismissDialogs.js";

const REPO_ROOT = path.resolve(AUTOMATOR_ROOT, "..");
const PHANTOM_DIR = path.join(REPO_ROOT, "bench", "phantom", "GNBP-XA");
const TRUTH_PATH = path.join(PHANTOM_DIR, "truth.json");
const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "task-launcher");

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
  qca: { file: string; studyInstanceUid: string };
}

/** カードの状態を一括で読む。**色や見た目ではなく `data-enabled` / `data-reason` で判定する。** */
async function readCards(page: Page): Promise<Record<string, { enabled: string; reason: string; text: string }>> {
  const raw = (await page.evaluate(`(() => {
    const out = {};
    for (const el of document.querySelectorAll('[data-testid^="task-card-"]')) {
      const id = el.getAttribute('data-testid').replace('task-card-', '');
      const r = el.querySelector('[data-testid^="task-reason-"]');
      out[id] = {
        enabled: el.getAttribute('data-enabled'),
        reason: el.getAttribute('data-reason'),
        text: r ? r.textContent.trim() : '',
      };
    }
    return JSON.stringify(out);
  })()`)) as string;
  return JSON.parse(raw) as Record<string, { enabled: string; reason: string; text: string }>;
}

async function openLauncher(page: Page): Promise<void> {
  await page.getByTestId("mainscreen-menu-function").click();
  await page.getByTestId("menu-item-task-launcher").click();
  await page.getByTestId("task-launcher").waitFor({ state: "visible", timeout: 10_000 });
}

async function closeLauncher(page: Page): Promise<void> {
  await page.getByTestId("task-launcher-close").click();
  await page.getByTestId("task-launcher").waitFor({ state: "detached", timeout: 10_000 });
}

async function search(page: Page): Promise<void> {
  await dismissStartupDialogs(page);
  const blocker = await findBlockingOverlay(page, "search-submit-button");
  if (blocker) throw new Error(`検索ボタンが塞がれています: ${blocker}`);
  const dates = page.locator('input[type="date"]');
  await dates.nth(0).fill("");
  await dates.nth(1).fill("");
  await page.getByTestId("search-submit-button").click();
  await page.waitForTimeout(1_200);
}

async function openStudy(page: Page, studyUid: string): Promise<void> {
  const row = page.locator(`[data-testid="study-row-${studyUid}"]`);
  await row.waitFor({ state: "visible", timeout: 20_000 });
  for (let i = 0; i < 3; i++) {
    await row.click();
    await page.waitForTimeout(800);
    if ((await page.locator('[data-testid^="series-row-"]').count()) > 0) return;
  }
  throw new Error("シリーズ行が出ません");
}

async function main(): Promise<void> {
  if (!fs.existsSync(TRUTH_PATH)) throw new Error(`ファントムがありません: ${PHANTOM_DIR}`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const truth = JSON.parse(fs.readFileSync(TRUTH_PATH, "utf8")) as Truth;

  // モダリティで落ちることを**実データで**見るために CT を 1 枚だけ足す。
  const ctFiles = listCategoryFiles(getCategory("ct-basic"));
  if (ctFiles.length === 0) throw new Error(`ct-basic の fixture がありません: ${categoryDir(getCategory("ct-basic"))}`);

  const driver = new DesktopDriver();
  await driver.start();
  try {
    const mainPage = driver.page;
    mainPage.on("dialog", (d) => void d.accept().catch(() => {}));
    await resetDb(driver.ports.http);
    const imp = await importPaths(driver.ports.http, [
      path.join(PHANTOM_DIR, truth.qca.file),
      ctFiles[0],
    ]);
    check(imp.imported === 2, "[準備] XA ファントムと CT を取り込めた", imp);

    await waitForMainScreenReady(mainPage, 60_000);
    await dismissStartupDialogs(mainPage);

    // ── ① スタディ未選択でも開く（「何ができるか」の一覧としての価値）───────────
    await openLauncher(mainPage);
    const idle = await readCards(mainPage);
    check(Object.keys(idle).length === 7, "[一覧] タスクが 7 枚並ぶ", Object.keys(idle));
    check(
      idle.qca?.enabled === "0" && idle.qca?.reason === "xa.task.reason.noStudy",
      "[一覧] スタディ未選択なら実装済みタスクも押せず、理由が『スタディを選べ』",
      idle.qca,
    );
    check(
      idle.qlvBiplane?.enabled === "0" && idle.qlvBiplane?.reason === "xa.task.reason.notImplemented",
      "[一覧] ★未実装かつスタディ未選択でも『未実装』を出す（直せない理由が先）",
      idle.qlvBiplane,
    );
    // 🚨 理由の文言が空だと、結局「無言で押せないボタン」に戻る。**表示されている文字**を見る。
    const empty = Object.entries(idle).filter(([, v]) => v.enabled === "0" && v.text.length === 0);
    check(empty.length === 0, "[一覧] ★押せないカードには必ず理由の文言が出ている", empty.map(([k]) => k));
    check(
      (idle.qlvBiplane?.text ?? "").includes("A5c"),
      "[一覧] 未実装カードは担当フェーズを名指しする",
      { biplane: idle.qlvBiplane?.text },
    );
    await mainPage.screenshot({ path: path.join(OUT_DIR, "1-launcher-idle.png") }).catch(() => {});
    await closeLauncher(mainPage);

    // ── ② XA を選ぶと解析タスクが押せる ───────────────────────────
    await search(mainPage);
    await openStudy(mainPage, truth.qca.studyInstanceUid);
    await mainPage.locator('[data-testid^="series-row-"]').first().click();
    await mainPage.waitForTimeout(400);
    await openLauncher(mainPage);
    const xa = await readCards(mainPage);
    for (const id of ["qca", "qva", "qca3d", "qca3dBifurcation", "qlv", "report"]) {
      check(xa[id]?.enabled === "1", `[XA] ${id} が押せる`, xa[id]);
    }
    check(xa.qlvBiplane?.enabled === "0", "[XA] 未実装タスクは XA を選んでも押せないまま", xa.qlvBiplane);
    await mainPage.screenshot({ path: path.join(OUT_DIR, "2-launcher-xa.png") }).catch(() => {});

    // ── ③ 押すと 2D ビューアが開き、その解析ダイアログが開く（本題）──────────
    const viewer = await driver.waitForNewPage(
      () => mainPage.getByTestId("task-card-qca").click(),
      (url) => url.includes("2dviewer"),
    );
    await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 30_000 });
    const opened = await viewer
      .getByTestId("xa-analysis-dialog")
      .waitFor({ state: "visible", timeout: 20_000 })
      .then(() => true)
      .catch(() => false);
    check(opened, "[起動] ★カードを押すとビューアが開き QCA のダイアログまで開く");
    if (!opened) return;
    const tiles = await viewer.getByTestId("series-viewer-root").count();
    check(tiles === 1, "[起動] 依頼したシリーズだけが開いている", tiles);
    // 既存の導線を消していないこと（ランチャーは*追加*の入口・§21.2）。
    check(
      (await viewer.getByTestId("xa-analysis-open").count()) === 1,
      "[起動] ★ビューア側の既存ボタンも残っている",
    );
    await viewer.screenshot({ path: path.join(OUT_DIR, "3-viewer-qca.png") }).catch(() => {});
    await viewer.getByTestId("xa-dialog-close").click();
    await viewer.getByTestId("xa-analysis-dialog").waitFor({ state: "detached", timeout: 10_000 });

    // ── ④ 依頼が残らない（★ localStorage に置かない設計の検査）──────────────
    // ビューアを再読込する。**シリーズは復帰する**（＝ビューアのコンテキストは localStorage で残る）が、
    // **解析ダイアログは開かない**（＝依頼は引き取られて消えている）。
    await viewer.reload();
    await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 30_000 });
    await viewer.waitForTimeout(3_000);
    const reopened = await viewer.getByTestId("xa-analysis-dialog").count();
    check(reopened === 0, "[残留] ★再読込しても解析ダイアログが勝手に開かない", reopened);
    check(
      (await viewer.getByTestId("series-viewer-root").count()) === 1,
      "[残留] シリーズの表示は復帰する（依頼だけが消えている）",
    );

    // ── ⑤ CT を選ぶと XA の解析タスクが落ちる（実データのモダリティで判定）────────
    await mainPage.bringToFront();
    await search(mainPage);
    const ctRow = mainPage.locator('[data-testid^="study-row-"]').filter({ hasText: "CT" }).first();
    const hasCt = (await ctRow.count()) > 0;
    check(hasCt, "[CT] CT のスタディが一覧にある");
    if (hasCt) {
      await ctRow.click();
      await mainPage.waitForTimeout(900);
      await mainPage.locator('[data-testid^="series-row-"]').first().click();
      await mainPage.waitForTimeout(400);
      await openLauncher(mainPage);
      const ct = await readCards(mainPage);
      check(
        ct.qca?.enabled === "0" && ct.qca?.reason === "xa.task.reason.noXaSeries",
        "[CT] ★XA 以外のシリーズでは QCA が落ち、理由がモダリティ",
        ct.qca,
      );
      check(ct.report?.enabled === "1", "[CT] 報告書はシリーズを問わず押せる", ct.report);
      await mainPage.screenshot({ path: path.join(OUT_DIR, "4-launcher-ct.png") }).catch(() => {});
      await closeLauncher(mainPage);
    }
  } finally {
    await driver.stop().catch(() => {});
    const summary = `\n===== タスク・ランチャー（A13-2）実機検証 =====\n合格 ${pass} / 失敗 ${fail}`;
    console.log(summary);
    fs.writeFileSync(path.join(OUT_DIR, "log.txt"), lines.join("\n") + summary + "\n");
  }
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
