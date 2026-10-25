/*
 * 自動削除（設定 ＞ 自動削除・DB 管理のロック・開いている検査の保護・メイン画面の知らせ）の実アプリ検査。
 *
 * 実行:  cd automator && GRAPHY_AUTOMATOR_HTTP_PORT=19610 GRAPHY_AUTOMATOR_SCP_PORT=19611 GRAPHY_AUTOMATOR_VITE_PORT=19613 \
 *          npx tsx src/spike/retentionCheck.ts
 *        （合成 CT の生成に pydicom・numpy のある python3 が要る。backend の jar が要る）
 *
 * 合成の 3 検査（古い順 s1 → s2 → s3、受信の間に 1 秒以上あける）。保管庫の上限を「s2 を 1 件消せば満たせる」値にする。
 *   s1: 画面でロック → 条件に当たっても消えない（保護）
 *   s2: 消える検査。ビューアで開いている間は試算に入らない（開いている検査の保護）→ 閉じると試算に戻り、実行で消える
 *   s3: 新しいので残る
 * 見るもの:
 *   負例: 試算の前は「有効にする」が無い／条件を変えると試算が消える／確認で取り消すと有効にならない／
 *         有効にする前の「今すぐ実行」は押せない／条件の誤り（0・空）は保存できない
 *   正例: 試算の一覧は s2 だけ（ロックは除外に数えられる）／有効化の確認 → 有効／
 *         開いている間は試算から外れ、閉じると戻る／実行で s2 だけが ファイル・索引とも消える／
 *         削除の記録に残る／再読み込み後に知らせが出て、閉じると二度と出ない
 *   検出器の確認: 削除の前に s1・s2 のファイルが実在することを先に確かめる
 * 画面はスクリーンショットを .results/retention-check に残す（目視用）。
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { Page } from "@playwright/test";

import { resetDb } from "../backend/dbReset.js";
import { dismissStartupDialogs } from "../common/dismissDialogs.js";
import { DesktopDriver, DESKTOP_RUN_DATA_DIR } from "../driver/desktopDriver.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { createChecker } from "./computeSpikeShared.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "retention-check");
const { check, summary } = createChecker();
const GB = 1024 ** 3;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Truth { studyUid: string; seriesUid: string; patientName: string; sops: string[] }

function synth(): { dir: string; truth: Truth[] } {
  const dir = path.join(OUT_DIR, "synth");
  fs.rmSync(dir, { recursive: true, force: true });
  const r = spawnSync("python3", ["-I", path.join(import.meta.dirname, "retentionSynth.py"), dir], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`合成データを作れません: ${r.stderr}`);
  return { dir, truth: JSON.parse(fs.readFileSync(path.join(dir, "truth.json"), "utf8")) as Truth[] };
}

/** DB フォルダの下で、ファイル名に SOP UID を含むものの数。 */
function filesOnDisk(sops: string[]): number {
  let n = 0;
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (sops.some((s) => e.name.includes(s))) n++;
    }
  };
  if (fs.existsSync(DESKTOP_RUN_DATA_DIR)) walk(DESKTOP_RUN_DATA_DIR);
  return n;
}

async function openSettingsPanel(page: Page): Promise<void> {
  await page.getByTestId("mainscreen-menu-system").click();
  await page.getByTestId("menu-item-settings").click();
  await page.getByTestId("settings-cat-retention").click();
  await page.getByTestId("retention-panel").waitFor({ state: "visible", timeout: 10_000 });
}

async function main(): Promise<void> {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const { dir, truth } = synth();
  const [s1, s2, s3] = truth;
  const driver = new DesktopDriver();
  const base = `http://127.0.0.1:${driver.ports.http}`;
  const R = `${base}/api/dbadmin/retention`;
  const studies = async (): Promise<string[]> =>
    ((await (await fetch(`${base}/api/studies`)).json()) as { studyInstanceUid: string }[]).map((s) => s.studyInstanceUid);
  const shot = (page: Page, name: string) => page.screenshot({ path: path.join(OUT_DIR, `${name}.png`) });

  try {
    await driver.start();
    const page = driver.page;
    page.on("dialog", (d) => void d.accept());
    await resetDb(driver.ports.http);
    // 🔴 DB のリセットは自動削除の設定・ロックを消さない（前回の実行が途中で落ちると有効のまま残り、取り込んだ検査を消す）
    await fetch(`${R}/disable`, { method: "POST" });
    await fetch(`${R}/config`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ days: null, maxGb: null, minFreeGb: null }) });
    for (const h of (await (await fetch(`${R}/holds`)).json()) as { studyUid: string }[]) {
      await fetch(`${R}/holds/${encodeURIComponent(h.studyUid)}`, { method: "DELETE" });
    }
    const st00 = (await (await fetch(`${R}/status`)).json()) as { enabled: boolean };
    check(st00.enabled === false, "開始時に自動削除は無効（前回の残りを片付けた）");
    for (const t of truth) {
      const imp = await importPaths(driver.ports.http, [path.join(dir, `s${truth.indexOf(t) + 1}`)]);
      check(imp.imported === 4, `合成 CT ${truth.indexOf(t) + 1} を 4 枚取り込めた`, imp);
      await sleep(1300); // 受信日時の順序をはっきりさせる
    }
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    await dismissStartupDialogs(page);

    console.log("\n[0] 前提（検出器が空振りでないこと）");
    check((await studies()).length === 3, "3 検査が索引にある");
    check(filesOnDisk(s1.sops) === 4 && filesOnDisk(s2.sops) === 4 && filesOnDisk(s3.sops) === 4,
      "3 検査とも画像ファイルがディスクにある", [filesOnDisk(s1.sops), filesOnDisk(s2.sops), filesOnDisk(s3.sops)]);
    const st0 = (await (await fetch(`${R}/status`)).json()) as { storeBytes: number; enabled: boolean };
    check(st0.enabled === false, "既定は無効");
    const maxGb = ((st0.storeBytes - st0.storeBytes / 6) / GB).toFixed(10);

    console.log("\n[1] DB 管理でロック（s1）");
    await page.getByTestId("mainscreen-menu-system").click();
    await page.getByTestId("menu-item-dbadmin").click();
    await page.getByTestId("dbadmin-dialog").waitFor({ state: "visible", timeout: 10_000 });
    await page.getByTestId("dbadmin-search-input").fill("RETSYN");
    await page.getByTestId("dbadmin-search-button").click();
    await page.getByTestId("dbadmin-patient-expand-RETSYN1").click();
    const lock1 = page.getByTestId(`dbadmin-study-lock-${s1.studyUid}`);
    await lock1.waitFor({ state: "visible", timeout: 10_000 });
    check((await lock1.getAttribute("data-locked")) === "false", "最初はロックされていない");
    await lock1.click();
    await page.waitForFunction((id) => document.querySelector(`[data-testid="dbadmin-study-lock-${id}"]`)?.getAttribute("data-locked") === "true", s1.studyUid, { timeout: 5_000 });
    check((await lock1.innerText()).includes("🔒"), "ロックの印（🔒）が出る");
    const holds = (await (await fetch(`${R}/holds`)).json()) as { studyUid: string }[];
    check(holds.some((h) => h.studyUid === s1.studyUid), "backend にロックが記録された", holds);
    await shot(page, "01-lock");
    await page.keyboard.press("Escape");
    await page.getByTestId("dbadmin-dialog").waitFor({ state: "hidden", timeout: 5_000 }).catch(() => undefined);

    console.log("\n[2] 設定 ＞ 自動削除（条件・試算）");
    await openSettingsPanel(page);
    await shot(page, "02-panel-initial");
    check((await page.getByTestId("retention-state").getAttribute("data-enabled")) === "false", "状態はオフ");
    check((await page.getByTestId("retention-preview-result").count()) === 0, "試算の前は「有効にする」の欄が無い（負例）");
    check(!(await page.getByTestId("retention-run-now").isEnabled()), "有効にする前は「今すぐ実行」を押せない（負例）");
    check(!(await page.getByTestId("retention-save").isEnabled()), "条件が空のままでは保存できない（負例）");
    check(!(await page.getByTestId("retention-preview").isEnabled()), "保存前は試算できない（負例）");
    // 期間の単位（日・週・ヶ月）。1 週間 = 7 日、1 ヶ月 = 30 日に換算して保存する
    await page.getByTestId("retention-days-on").check();
    await page.getByTestId("retention-days-unit").selectOption("month");
    await page.getByTestId("retention-days").fill("3");
    check((await page.getByTestId("retention-days-equiv").innerText()).includes("90"), "3 ヶ月は「90 日」と換算表示される", await page.getByTestId("retention-days-equiv").innerText());
    await page.getByTestId("retention-days-unit").selectOption("week");
    check((await page.getByTestId("retention-days-equiv").innerText()).includes("21"), "3 週間は「21 日」と換算表示される");
    await page.getByTestId("retention-days-unit").selectOption("day");
    check((await page.getByTestId("retention-days-equiv").count()) === 0, "単位が日のときは換算を出さない");
    await page.getByTestId("retention-days-unit").selectOption("month");
    await page.getByTestId("retention-days").fill("1.5");
    check(!(await page.getByTestId("retention-save").isEnabled()), "小数は保存できない（負例）");
    await page.getByTestId("retention-days").fill("0");
    check(!(await page.getByTestId("retention-save").isEnabled()), "0 ヶ月は保存できない（負例）");
    await page.getByTestId("retention-days").fill("3");
    await shot(page, "02b-days-unit");
    await page.getByTestId("retention-save").click();
    await page.getByTestId("retention-message").waitFor({ state: "visible", timeout: 5_000 });
    const cfgDays = (await (await fetch(`${R}/config`)).json()) as { days: number | null };
    check(cfgDays.days === 90, "3 ヶ月は backend に 90 日で保存された（API）", cfgDays);
    await page.getByTestId("retention-preview").click();
    await page.getByTestId("retention-preview-result").waitFor({ state: "visible", timeout: 10_000 });
    check((await page.getByTestId("retention-preview-table").count()) === 0 && (await studies()).length === 3,
      "受信直後の検査は 3 ヶ月条件では消えない（試算は該当なし・索引 3）");
    await page.keyboard.press("Escape");
    await openSettingsPanel(page);
    check((await page.getByTestId("retention-days-unit").inputValue()) === "month" && (await page.getByTestId("retention-days").inputValue()) === "3",
      "開き直すと「3 ヶ月」で表示される（保存は 90 日）");
    await page.getByTestId("retention-days-on").uncheck();
    await page.getByTestId("retention-max-on").check();
    check(!(await page.getByTestId("retention-save").isEnabled()), "オンの欄が空だと保存できない（負例）");
    await page.getByTestId("retention-max").fill("0");
    check(!(await page.getByTestId("retention-save").isEnabled()), "0 は保存できない（負例）");
    await page.getByTestId("retention-max").fill(maxGb);
    await page.getByTestId("retention-save").click();
    await page.getByTestId("retention-message").waitFor({ state: "visible", timeout: 5_000 });
    await page.getByTestId("retention-preview").click();
    await page.getByTestId("retention-preview-table").waitFor({ state: "visible", timeout: 10_000 });
    const rows = page.locator('[data-testid="retention-preview-table"] tbody tr');
    check((await rows.count()) === 1, "試算の一覧は 1 検査だけ", await rows.count());
    const rowText = await rows.first().innerText();
    check(rowText.includes(s2.patientName) && !rowText.includes(s1.patientName), "一覧は s2 で、ロックした s1 は入らない", rowText);
    const summaryText = await page.getByTestId("retention-preview-summary").innerText();
    check(/1/.test(summaryText) && summaryText.length > 0, "合計と、保護で除外した内訳が出る", summaryText);
    check((await studies()).length === 3 && filesOnDisk(s2.sops) === 4, "試算では何も消えない（索引 3・ファイル 4）");
    await shot(page, "03-preview");

    console.log("\n[3] 条件を変えると試算が消える");
    await page.getByTestId("retention-max").fill(maxGb + "1");
    check((await page.getByTestId("retention-preview-result").count()) === 0, "条件を編集すると試算の結果が消える（古い試算で有効にできない）");
    await page.getByTestId("retention-max").fill(maxGb);
    check(await page.getByTestId("retention-preview").isEnabled(), "保存済みと同じ条件に戻すと試算できる");
    await page.keyboard.press("Escape");

    console.log("\n[4] 開いている検査（s2）は試算に入らず、閉じると入る");
    const dates = page.locator('input[type="date"]');
    await dates.nth(0).fill("");
    await dates.nth(1).fill("");
    await page.getByTestId("search-submit-button").click();
    await page.locator(`[data-testid="study-row-${s2.studyUid}"]`).click();
    await page.locator(`[data-testid="series-row-${s2.seriesUid}"]`).click();
    const viewer = await driver.waitForNewPage(() => page.getByTestId("viewer2d-toolbar-button").click(), (u) => u.includes("2dviewer"));
    await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 30_000 });
    await viewer.waitForTimeout(1_500); // 使用中の登録が backend に届くのを待つ
    await openSettingsPanel(page);
    await page.getByTestId("retention-preview").click();
    await page.getByTestId("retention-preview-table").waitFor({ state: "visible", timeout: 10_000 });
    const openRows = await page.locator('[data-testid="retention-preview-table"] tbody tr').allInnerTexts();
    check(openRows.length === 1 && openRows[0].includes(s3.patientName) && !openRows[0].includes(s2.patientName),
      "ビューアで開いている s2 は試算に入らない（代わりに s3）", openRows);
    await shot(page, "03-preview-while-open");
    await page.keyboard.press("Escape");
    await viewer.close({ runBeforeUnload: true });
    await sleep(1_500); // 解放が届くのを待つ
    await openSettingsPanel(page);
    await page.getByTestId("retention-preview").click();
    await page.getByTestId("retention-preview-table").waitFor({ state: "visible", timeout: 10_000 });
    const closedRows = await page.locator('[data-testid="retention-preview-table"] tbody tr').allInnerTexts();
    check(closedRows.length === 1 && closedRows[0].includes(s2.patientName), "ビューアを閉じると s2 が試算に戻る（解放された）", closedRows);

    console.log("\n[5] 有効化（確認の取り消し → 有効）");
    await page.getByTestId("retention-enable").click();
    await page.getByTestId("retention-confirm").waitFor({ state: "visible", timeout: 5_000 });
    await shot(page, "04-confirm");
    await page.getByTestId("retention-confirm-cancel").click();
    check((await page.getByTestId("retention-state").getAttribute("data-enabled")) === "false", "確認で取り消すと有効にならない（負例）");
    check((await (await fetch(`${R}/status`)).json() as { enabled: boolean }).enabled === false, "backend も無効のまま");
    await page.getByTestId("retention-enable").click();
    await page.getByTestId("retention-confirm-ok").click();
    await page.waitForFunction(() => document.querySelector('[data-testid="retention-state"]')?.getAttribute("data-enabled") === "true", null, { timeout: 10_000 });
    check(true, "確認のあとに有効になった");
    await shot(page, "05-enabled");

    console.log("\n[6] 今すぐ実行 → s2 だけが消える");
    await page.getByTestId("retention-run-now").click();
    let gone = false;
    for (let i = 0; i < 30 && !gone; i++) {
      gone = !(await studies()).includes(s2.studyUid);
      if (!gone) await sleep(500);
    }
    check(gone, "実行で s2 が索引から消えた", await studies());
    check(filesOnDisk(s2.sops) === 0, "s2 のファイルもディスクから消えた", filesOnDisk(s2.sops));
    const left = await studies();
    check(left.includes(s1.studyUid) && left.includes(s3.studyUid) && left.length === 2, "ロックした s1 と新しい s3 は残る", left);
    check(filesOnDisk(s1.sops) === 4 && filesOnDisk(s3.sops) === 4, "s1・s3 のファイルは残る");
    await shot(page, "07-after-run");

    console.log("\n[7] 削除の記録");
    await page.getByTestId("retention-log-open").click();
    await page.getByTestId("retention-log-table").waitFor({ state: "visible", timeout: 10_000 });
    const logText = await page.getByTestId("retention-log-table").innerText();
    check(logText.includes(s2.patientName), "記録に s2 の患者が出る", logText);
    const evs = (await (await fetch(`${R}/events?limit=1000`)).json()) as { studyUid: string; result: string }[];
    check(evs.filter((e) => e.studyUid === s2.studyUid && e.result === "deleted").length === 1, "s2 の「削除」の記録がちょうど 1 件（API）");
    check(evs.filter((e) => e.studyUid === s1.studyUid).length === 0, "ロックした s1 の記録は無い（API）");
    check(await page.locator('[data-testid="retention-log-table"] tbody tr[data-result="deleted"]', { hasText: s2.patientName }).count() >= 1, "画面の記録にも s2 の「削除」の行がある（過去の実行の分も並ぶので 1 行以上）");
    await shot(page, "08-log");
    await page.getByTestId("retention-log-close").click();
    await page.keyboard.press("Escape");

    console.log("\n[8] メイン画面の知らせ（再読み込みで出て、閉じると二度と出ない）");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    // 🔴 ここで dismissStartupDialogs を呼ばない（「閉じる」を押して知らせを閉じ、見たことにしてしまう）
    await page.getByTestId("retention-notice").waitFor({ state: "visible", timeout: 20_000 });
    check((await page.getByTestId("retention-notice").getAttribute("data-kind")) === "deleted", "削除した知らせが出る");
    await shot(page, "09-notice");
    await page.getByTestId("retention-notice-close").click();
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    await dismissStartupDialogs(page);
    await sleep(3_000);
    check((await page.getByTestId("retention-notice").count()) === 0, "閉じたあとは再読み込みしても出ない");

    console.log("\n[9] 無効にする");
    await openSettingsPanel(page);
    await page.getByTestId("retention-disable").click();
    await page.waitForFunction(() => document.querySelector('[data-testid="retention-state"]')?.getAttribute("data-enabled") === "false", null, { timeout: 10_000 });
    check(true, "無効に戻せる");
  } finally {
    await driver.stop();
  }
  process.exitCode = summary() === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
