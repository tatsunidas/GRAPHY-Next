/*
 * 日付・時刻の表示書式（設定 ＞ 一般 ＞ 日付の書式・時刻の書式）の実アプリ検査。
 *
 * 実行:  cd automator && GRAPHY_AUTOMATOR_HTTP_PORT=19610 GRAPHY_AUTOMATOR_SCP_PORT=19611 GRAPHY_AUTOMATOR_VITE_PORT=19613 \
 *          npx tsx src/spike/dateFormatCheck.ts
 *        （合成 CT の生成に pydicom・numpy のある python3 が要る。backend の jar が要る）
 *
 * 合成の 3 検査（StudyDate 20260101〜03、StudyTime 090000）。s3（20260103）で見る。
 *   既定: スタディ一覧・2D の 4 隅は今と同じ「2026-01-03」「09:00:00」
 *   変更: 「DD/MM/YYYY」「12 時間」→ 開き直さずに一覧・開いている 2D ビューア（別ウィンドウ）が「03/01/2026」「9:00:00 AM」
 *   不変: backend の返す StudyDate は 20260103 のまま／日と月が曖昧な書式の日付には YYYY-MM-DD のツールチップ
 *   永続: 再読み込みしても書式が残る
 *   負例: 保存値が壊れていたら既定に戻る（読めない値で壊れた表示にしない）
 * 画面はスクリーンショットを .results/date-format-check に残す（目視用）。
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { Page } from "@playwright/test";

import { resetDb } from "../backend/dbReset.js";
import { dismissStartupDialogs } from "../common/dismissDialogs.js";
import { DesktopDriver } from "../driver/desktopDriver.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { createChecker } from "./computeSpikeShared.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "date-format-check");
const { check, summary } = createChecker();

interface Truth { studyUid: string; seriesUid: string; patientName: string; sops: string[] }

function synth(): { dir: string; truth: Truth[] } {
  const dir = path.join(OUT_DIR, "synth");
  fs.rmSync(dir, { recursive: true, force: true });
  const r = spawnSync("python3", ["-I", path.join(import.meta.dirname, "retentionSynth.py"), dir], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`合成データを作れません: ${r.stderr}`);
  return { dir, truth: JSON.parse(fs.readFileSync(path.join(dir, "truth.json"), "utf8")) as Truth[] };
}

async function setFormat(page: Page, key: "general.dateFormat" | "general.timeFormat", value: string): Promise<void> {
  await page.getByTestId("mainscreen-menu-system").click();
  await page.getByTestId("menu-item-settings").click();
  await page.getByTestId("settings-cat-general").click();
  await page.getByTestId(`settings-field-${key}`).selectOption(value);
  await page.screenshot({ path: path.join(OUT_DIR, `settings-${key}-${value.replace(/\//g, "_")}.png`) });
  await page.getByTestId("dialog-close-button").click();
  await page.getByTestId("settings-dialog").waitFor({ state: "hidden", timeout: 5_000 });
}

async function main(): Promise<void> {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const { dir, truth } = synth();
  const s3 = truth[2];
  const driver = new DesktopDriver();
  const base = `http://127.0.0.1:${driver.ports.http}`;
  const shot = (p: Page, name: string) => p.screenshot({ path: path.join(OUT_DIR, `${name}.png`) });

  try {
    await driver.start();
    const page = driver.page;
    await resetDb(driver.ports.http);
    // 前回の実行が書式を変えたまま落ちていても、既定から始める
    await page.evaluate(() => {
      localStorage.removeItem("graphy.dateFormat");
      localStorage.removeItem("graphy.timeFormat");
      // 4 隅に StudyDate・StudyTime を出す（既定の項目の代わり）
      localStorage.setItem("graphy.overlayConfig", JSON.stringify({
        topLeft: [{ tag: "00080020", keyword: "StudyDate", vr: "DA" }, { tag: "00080030", keyword: "StudyTime", vr: "TM" }],
        topRight: [], bottomLeft: [], bottomRight: [],
      }));
    });
    for (let i = 1; i <= 3; i++) {
      const imp = await importPaths(driver.ports.http, [path.join(dir, `s${i}`)]);
      check(imp.imported === 4, `合成 CT ${i} を 4 枚取り込めた`, imp);
    }
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    await dismissStartupDialogs(page);
    await page.getByTestId("search-allperiod-chip").click(); // 全期間（合成検査は 2026-01 の日付）
    await page.getByTestId("search-submit-button").click();
    const row = page.locator(`[data-testid="study-row-${s3.studyUid}"]`);
    await row.waitFor({ state: "visible", timeout: 20_000 }).catch(async (e) => { await shot(page, "00-no-row"); throw e; });

    console.log("\n[0] 前提（検出器が空振りでないこと）");
    const raw = (await (await fetch(`${base}/api/studies`)).json()) as { studyInstanceUid: string; studyDate: string }[];
    check(raw.find((s) => s.studyInstanceUid === s3.studyUid)?.studyDate === "20260103", "backend の StudyDate は 20260103（生の値）", raw);

    console.log("\n[1] 既定（今の表示と同じ）");
    check((await row.innerText()).includes("2026-01-03"), "一覧は既定で「2026-01-03」", await row.innerText());
    await shot(page, "01-default-list");
    await page.locator(`[data-testid="study-row-${s3.studyUid}"]`).click();
    await page.locator(`[data-testid="series-row-${s3.seriesUid}"]`).click();
    const viewer = await driver.waitForNewPage(() => page.getByTestId("viewer2d-toolbar-button").click(), (u) => u.includes("2dviewer"));
    const tl = viewer.getByTestId("corner-text-tl").first();
    await tl.waitFor({ state: "visible", timeout: 30_000 });
    const tlText = await tl.innerText();
    check(tlText.includes("2026-01-03") && tlText.includes("09:00:00"), "2D の 4 隅は既定で「2026-01-03」「09:00:00」", tlText);
    await shot(viewer, "02-default-overlay");

    console.log("\n[2] 書式を変える（開き直さずに切り替わる）");
    await setFormat(page, "general.dateFormat", "DD/MM/YYYY");
    await setFormat(page, "general.timeFormat", "12h");
    check((await row.innerText()).includes("03/01/2026") && !(await row.innerText()).includes("01/03/2026"), "一覧が「03/01/2026」（日/月/年）に切り替わった", await row.innerText());
    await viewer.waitForFunction(() => /03\/01\/2026/.test(document.querySelector('[data-testid="corner-text-tl"]')?.textContent ?? ""), null, { timeout: 10_000 }).catch(() => undefined);
    const tl2 = await viewer.getByTestId("corner-text-tl").first().innerText();
    check(tl2.includes("03/01/2026") && tl2.includes("9:00:00 AM"), "開いている 2D ビューア（別ウィンドウ）の 4 隅も「03/01/2026」「9:00:00 AM」", tl2);
    const side = await viewer.locator("body").innerText();
    check(!side.includes("2026-01-03"), "2D ビューア左の検査行にも古い書式「2026-01-03」が残っていない", side.match(/.*2026-01-03.*/)?.[0]);
    await shot(page, "03-changed-list");
    await shot(viewer, "04-changed-overlay");
    const title = await row.locator("span[title]").first().getAttribute("title");
    check(title === "2026-01-03", "日と月が曖昧な書式では、日付に YYYY-MM-DD のツールチップが付く", title);
    await setFormat(page, "general.dateFormat", "MM/DD/YYYY");
    check((await row.innerText()).includes("01/03/2026"), "「MM/DD/YYYY」では「01/03/2026」", await row.innerText());
    await setFormat(page, "general.dateFormat", "DD-Mon-YYYY");
    check((await row.innerText()).includes("03-Jan-2026"), "「DD-Mon-YYYY」では「03-Jan-2026」", await row.innerText());

    console.log("\n[3] 値そのものは変わらない");
    const raw2 = (await (await fetch(`${base}/api/studies`)).json()) as { studyInstanceUid: string; studyDate: string }[];
    check(raw2.find((s) => s.studyInstanceUid === s3.studyUid)?.studyDate === "20260103", "書式を変えても backend の StudyDate は 20260103 のまま");

    console.log("\n[4] 再読み込みしても残る／壊れた保存値は既定に戻る（負例）");
    await setFormat(page, "general.dateFormat", "DD/MM/YYYY");
    await viewer.close({ runBeforeUnload: true });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    await dismissStartupDialogs(page);
    await page.getByTestId("search-allperiod-chip").click();
    await page.getByTestId("search-submit-button").click();
    await row.waitFor({ state: "visible", timeout: 20_000 });
    check((await row.innerText()).includes("03/01/2026"), "再読み込み後も「03/01/2026」", await row.innerText());
    await page.evaluate(() => localStorage.setItem("graphy.dateFormat", "bogus"));
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    await dismissStartupDialogs(page);
    await page.getByTestId("search-allperiod-chip").click();
    await page.getByTestId("search-submit-button").click();
    await row.waitFor({ state: "visible", timeout: 20_000 });
    check((await row.innerText()).includes("2026-01-03"), "壊れた保存値（bogus）では既定の「2026-01-03」に戻る", await row.innerText());
    await shot(page, "05-fallback");
  } finally {
    await driver.stop();
  }
  process.exitCode = summary() === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
