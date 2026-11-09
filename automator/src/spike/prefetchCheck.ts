/*
 * 事前取得（予約一覧 CSV → PACS の過去検査を C-MOVE で自局へ）の実アプリ検査。
 *
 * 実行:  cd automator && GRAPHY_TEST_PYTHON=<pydicom・numpy のある python> \
 *          GRAPHY_AUTOMATOR_HTTP_PORT=19640 GRAPHY_AUTOMATOR_SCP_PORT=19641 GRAPHY_AUTOMATOR_VITE_PORT=19643 \
 *          npx tsx src/spike/prefetchCheck.ts
 *        （JDK を PATH に。backend の jar が要る。dcm4che-tools は ~/dcm4che-* に）
 *
 * 偽の PACS は実機の dcm4che dcmqrscp（ポート 19644）。合成 CT の 3 検査（RETSYN1〜3）を storescu で入れる。
 * アプリ側は「DICOM 通信先」にその PACS を登録し、**画面から**事前取得を設定する。
 *   負例: CSV の列名が違う → 何も取得せず、理由が画面に出る（検査 0 件）
 *         PACS の AE が登録に無い → 実行できず、理由が出る
 *   正例: 明日の予約が RETSYN1・RETSYN3（RETSYN2 は予約なし）→ 2 検査だけが取り込まれる
 *         再実行 → 取得済みなので 0 件取得、2 件が「取得済み」
 *   既定のまま通す経路: 「遡る年数」「モダリティ」「患者ごとの件数」は空のまま
 * 見るもの: 取り込まれた検査の UID が PACS 側の UID と一致する（件数だけでなく中身）。画面はスクリーンショットを
 *   .results/prefetch-check に残す（目視用）。
 * 範囲外: MWL（backend の統合試験で、実機の findscu -M MWL と偽の MWL SCP を通している）、Shift_JIS（同）。
 */
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import type { Page } from "@playwright/test";

import { resetDb } from "../backend/dbReset.js";
import { killProcessTree } from "../common/processUtils.js";
import { dismissStartupDialogs } from "../common/dismissDialogs.js";
import { DesktopDriver } from "../driver/desktopDriver.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { createChecker } from "./computeSpikeShared.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "prefetch-check");
const PACS_PORT = 19644;
const { check, summary } = createChecker();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Truth { studyUid: string; patientName: string }

function dcm4cheTool(name: string): string {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
  const dir = fs.readdirSync(home).find((d) => /^dcm4che-\d/.test(d));
  if (!dir) throw new Error("~/dcm4che-* が見つかりません");
  return path.join(home, dir, "bin", process.platform === "win32" ? `${name}.bat` : name);
}

function pad(n: number): string { return String(n).padStart(2, "0"); }
function tomorrow(): { slash: string } {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return { slash: `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}` };
}

async function waitPort(port: number, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const ok = await new Promise<boolean>((res) => {
      import("node:net").then(({ default: net }) => {
        const s = net.connect(port, "127.0.0.1");
        s.once("connect", () => { s.destroy(); res(true); });
        s.once("error", () => res(false));
      });
    });
    if (ok) return true;
    await sleep(300);
  }
  return false;
}

async function openPanel(page: Page): Promise<void> {
  await page.getByTestId("mainscreen-menu-system").click();
  await page.getByTestId("menu-item-settings").click();
  await page.getByTestId("settings-cat-prefetch").click();
  await page.getByTestId("prefetch-panel").waitFor({ state: "visible", timeout: 10_000 });
}

async function main(): Promise<void> {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  const csvDir = path.join(OUT_DIR, "ris");
  fs.mkdirSync(csvDir, { recursive: true });
  const synthDir = path.join(OUT_DIR, "synth");
  const py = process.env.GRAPHY_TEST_PYTHON ?? "python";
  const gen = spawnSync(py, [path.join(import.meta.dirname, "retentionSynth.py"), synthDir], { encoding: "utf8" });
  if (gen.status !== 0) throw new Error(`合成データを作れません: ${gen.stderr}`);
  const truth = JSON.parse(fs.readFileSync(path.join(synthDir, "truth.json"), "utf8")) as Truth[];
  const [s1, s2, s3] = truth;

  const driver = new DesktopDriver();
  const base = `http://127.0.0.1:${driver.ports.http}`;
  const shot = (p: Page, name: string) => p.screenshot({ path: path.join(OUT_DIR, `${name}.png`) });
  const putSettings = (kv: Record<string, string>) =>
    fetch(`${base}/api/settings`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(kv) });
  const studyUids = async (): Promise<string[]> =>
    ((await (await fetch(`${base}/api/studies`)).json()) as { studyInstanceUid: string }[]).map((s) => s.studyInstanceUid);

  let pacs: ChildProcess | null = null;
  try {
    // --- 偽の PACS ---
    const aeCfg = path.join(OUT_DIR, "ae.properties");
    fs.writeFileSync(aeCfg, `GRAPHYNEXT=127.0.0.1:${driver.ports.scp}\n`);
    pacs = spawn(dcm4cheTool("dcmqrscp"), ["-b", `DCMQRSCP:${PACS_PORT}`, "--dicomdir", path.join(OUT_DIR, "pacs", "DICOMDIR"),
      "--filepath", "{00100020}/{0020000D}/{0020000E}/{00080018}", "--ae-config", aeCfg], { shell: process.platform === "win32", stdio: "ignore" });
    check(await waitPort(PACS_PORT, 30_000), "偽の PACS（dcmqrscp）が待ち受けている");
    for (const d of ["s1", "s2", "s3"]) {
      const r = spawnSync(dcm4cheTool("storescu"), ["-c", `DCMQRSCP@127.0.0.1:${PACS_PORT}`, path.join(synthDir, d)], { encoding: "utf8", shell: process.platform === "win32" });
      check(r.status === 0, `PACS に ${d} を入れた`, r.stderr?.slice(-200));
    }

    await driver.start();
    const page = driver.page;
    await resetDb(driver.ports.http);
    // 設定は DB のリセットでは消えない。前の実行の事前取得の設定が残っていると「何も入れていない状態」から始まらない
    const keys = Object.keys((await (await fetch(`${base}/api/settings`)).json()) as Record<string, string>).filter((k) => k.startsWith("prefetch."));
    await putSettings(Object.fromEntries(keys.map((k) => [k, ""])));
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    await dismissStartupDialogs(page);
    check((await studyUids()).length === 0, "最初は自局に検査が無い");
    await putSettings({ "dicom.remoteAes": JSON.stringify([{ aeTitle: "DCMQRSCP", host: "127.0.0.1", port: PACS_PORT, tls: false }]) });

    // 予約: 明日の RETSYN1・RETSYN3（RETSYN2 は無し）。列名は 患者ID／予約日
    const day = tomorrow().slash;
    const csvFile = path.join(csvDir, "list.csv");
    fs.writeFileSync(csvFile, `予約日,患者ID,氏名\n${day},RETSYN1,山田\n${day},RETSYN3,鈴木\n`, "utf8");

    console.log("\n[1] 画面から設定する（負例: 列名を間違えて実行 → 何も取得せず理由が出る）");
    await openPanel(page);
    await page.getByTestId("prefetch-enabled").check();
    check(await page.getByTestId("prefetch-save").isDisabled(), "有効にしただけでは（必須が欠けて）保存できない");
    await page.getByTestId("prefetch-source").selectOption("csv");
    await page.getByTestId("prefetch-csv-folder").fill(csvDir);
    await page.getByTestId("prefetch-csv-charset").selectOption("UTF-8");
    await page.getByTestId("prefetch-csv-col-id").fill("患者番号"); // 実際の列名は 患者ID
    await page.getByTestId("prefetch-csv-col-date").fill("予約日");
    await page.getByTestId("prefetch-target-day").selectOption("tomorrow");
    await page.getByTestId("prefetch-times").fill("07:00");
    await page.getByTestId("prefetch-pacs-ae").selectOption("DCMQRSCP");
    await page.getByTestId("prefetch-retrieve").selectOption("move");
    await page.getByTestId("prefetch-timeout").fill("120");
    await page.getByTestId("prefetch-save").click();
    await page.getByTestId("prefetch-preview").waitFor({ state: "visible" });
    await page.waitForFunction(() => !(document.querySelector('[data-testid="prefetch-preview"]') as HTMLButtonElement | null)?.disabled, null, { timeout: 15_000 });
    await page.getByTestId("prefetch-run-now").click();
    await page.getByTestId("prefetch-last-error").waitFor({ state: "visible", timeout: 30_000 });
    const err1 = await page.getByTestId("prefetch-last-error").innerText();
    check(/患者 ID の列がありません/.test(err1), "理由「CSV に患者 ID の列がありません」が出る", err1);
    check((await studyUids()).length === 0, "何も取得されていない");
    await shot(page, "01-wrong-column");

    console.log("\n[2] 負例: 取得元 PACS が登録に無い → 実行できず理由が出る");
    // 画面の入力は保存するまで backend に届かないので、設定 API で列名を直し、取得元を存在しない AE にする
    await putSettings({ "prefetch.csv.colPatientId": "患者ID", "prefetch.pacs.ae": "NOSUCH" });
    await page.reload({ waitUntil: "domcontentloaded" });
    await dismissStartupDialogs(page);
    await openPanel(page);
    await page.waitForFunction(() => !(document.querySelector('[data-testid="prefetch-run-now"]') as HTMLButtonElement | null)?.disabled, null, { timeout: 15_000 });
    await page.getByTestId("prefetch-run-now").click();
    await page.waitForFunction(() => /見つかりません|not in|ありません/.test(document.querySelector('[data-testid="prefetch-last-error"]')?.textContent ?? "") && /PACS/.test(document.querySelector('[data-testid="prefetch-last-error"]')?.textContent ?? ""), null, { timeout: 30_000 }).catch(() => undefined);
    const err2 = await page.getByTestId("prefetch-last-error").innerText().catch(() => "");
    check(/取得元 PACS が/.test(err2), "理由「取得元 PACS が『DICOM 通信先』にありません」が出る", err2);
    check((await studyUids()).length === 0, "何も取得されていない");
    await putSettings({ "prefetch.pacs.ae": "DCMQRSCP" });

    console.log("\n[3] 正例: 予約の 2 人分だけが取り込まれる（絞り込みの欄は空のまま）");
    await page.reload({ waitUntil: "domcontentloaded" });
    await dismissStartupDialogs(page);
    await openPanel(page);
    check((await page.getByTestId("prefetch-years").inputValue()) === "" && (await page.getByTestId("prefetch-modalities").inputValue()) === "", "絞り込みは空のまま（既定）");
    await page.waitForFunction(() => !(document.querySelector('[data-testid="prefetch-preview"]') as HTMLButtonElement | null)?.disabled, null, { timeout: 15_000 });
    await page.getByTestId("prefetch-preview").click();
    await page.getByTestId("prefetch-preview-result").waitFor({ state: "visible", timeout: 20_000 });
    const pv = await page.getByTestId("prefetch-preview-result").innerText();
    check(/2 人/.test(pv), "予約一覧の確認で「2 人」と出る（取得はまだしない）", pv);
    check((await studyUids()).length === 0, "確認だけでは取得されない");
    await page.getByTestId("prefetch-run-now").click();
    const t0 = Date.now();
    let got: string[] = [];
    while (Date.now() - t0 < 90_000) {
      got = await studyUids();
      const running = await page.getByTestId("prefetch-running").innerText().catch(() => "");
      if (got.length >= 2 && /いいえ|No/.test(running)) break;
      await sleep(1000);
    }
    check(got.length === 2, "検査が 2 件だけ取り込まれた", got);
    check(got.includes(s1.studyUid) && got.includes(s3.studyUid), "取り込まれたのは RETSYN1・RETSYN3 の検査（UID が PACS と一致）");
    check(!got.includes(s2.studyUid), "予約の無い RETSYN2 は取り込まれない");
    await page.waitForFunction(() => /完了|Complete/.test(document.querySelector('[data-testid="prefetch-last"]')?.textContent ?? ""), null, { timeout: 30_000 });
    check((await page.getByTestId("prefetch-retrieved").innerText()) === "2", "画面の「取得」が 2");
    await shot(page, "03-retrieved");

    console.log("\n[4] 再実行: 取得済みなので取得は 0、記録に 2 件が「取得済み」");
    await page.getByTestId("prefetch-run-now").click();
    await page.waitForFunction(() => /^0$/.test(document.querySelector('[data-testid="prefetch-retrieved"]')?.textContent ?? "") , null, { timeout: 60_000 });
    await sleep(2500);
    await page.getByTestId("prefetch-log-open").click();
    const rows = await page.getByTestId("prefetch-log-table").locator("tbody tr").count();
    check(rows >= 2, "実行の記録が 2 回分以上ある", rows);
    await shot(page, "04-log");
    check((await studyUids()).length === 2, "検査は 2 件のまま（重複して取り込まない）");
  } finally {
    if (pacs) killProcessTree(pacs);
    await driver.stop();
  }
  process.exitCode = summary() === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
