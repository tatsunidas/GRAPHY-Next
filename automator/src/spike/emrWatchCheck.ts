/*
 * 電子カルテ連携（監視するファイルの「いまの患者」が変わったら、過去検査を PACS から取り込み、2D ビューアで直近の検査を開く）の実アプリ検査。
 *
 * 実行:  cd automator && GRAPHY_TEST_PYTHON=<pydicom・numpy のある python> \
 *          GRAPHY_AUTOMATOR_HTTP_PORT=19650 GRAPHY_AUTOMATOR_SCP_PORT=19651 GRAPHY_AUTOMATOR_VITE_PORT=19653 \
 *          npx tsx src/spike/emrWatchCheck.ts
 *        （backend の jar を先に再ビルド。dcm4che-tools は ~/dcm4che-* に。デスクトップ版の Electron が要る）
 *
 * 偽の PACS は実機の dcmqrscp（ポート 19654）。EMRPT1 は検査日の違う 3 検査、EMRPT2 は 1 検査。
 * 設定は**実際の設定画面から**行う（CSV）。電子カルテの出力は、フォルダにファイルを書いて再現する。
 *   基準: 有効にした直後に読めた ID（EMRPT2）は、覚えるだけ。ビューアは開かず、PACS からも取らない
 *   正例: CSV に EMRPT1 を書く → 3 検査が手元に入り、2D ビューアに**直近（2025-03-01）の検査**が出る（UID が PACS の値と一致）
 *         EMRPT2 を書く → 同じ窓が EMRPT2 に差し替わる（窓は増えない）
 *         同じ ID の書き直し → 開き直さない
 *         bat（set PID=…）に切り替え → EMRPT1 の直近に切り替わる
 *   負例: PACS に無い患者 → 開かず、理由が出る／ID として使えない内容（a&calc）→ 開かず、ファイルの異常が出る
 *   既定のまま通す経路: CSV の「1 行目は見出し」は既定のまま。自動で開くをオフにすると開かず、［開く］で開く
 * 画面はスクリーンショットを .results/emr-watch-check に残す（目視用）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import type { Page } from "@playwright/test";

import { resetDb } from "../backend/dbReset.js";
import { killProcessTree } from "../common/processUtils.js";
import { dismissStartupDialogs } from "../common/dismissDialogs.js";
import { DesktopDriver } from "../driver/desktopDriver.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { createChecker } from "./computeSpikeShared.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "emr-watch-check");
const PACS_PORT = 19654;
const { check, summary } = createChecker();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Truth { patientId: string; patientName: string; studyDate: string; studyUid: string }

function dcm4cheTool(name: string): string {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
  const dir = fs.readdirSync(home).find((d) => /^dcm4che-\d/.test(d));
  if (!dir) throw new Error("~/dcm4che-* が見つかりません");
  return path.join(home, dir, "bin", process.platform === "win32" ? `${name}.bat` : name);
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

async function until(cond: () => Promise<boolean> | boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if (await cond()) return true; } catch { /* 続行 */ }
    await sleep(250);
  }
  try { return await cond(); } catch { return false; }
}

async function main(): Promise<void> {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const synthDir = path.join(OUT_DIR, "synth");
  const py = process.env.GRAPHY_TEST_PYTHON ?? "python3";
  const gen = spawnSync(py, ["-I", path.join(import.meta.dirname, "emrSynth.py"), synthDir], { encoding: "utf8" });
  if (gen.status !== 0) throw new Error(`合成データを作れません: ${gen.stderr}`);
  const truth = JSON.parse(fs.readFileSync(path.join(synthDir, "truth.json"), "utf8")) as Truth[];
  const [a1, a2, a3, b1] = truth; // a3 が EMRPT1 の直近（2025-03-01）、b1 が EMRPT2

  const csvDir = path.join(OUT_DIR, "emr-csv");
  const batDir = path.join(OUT_DIR, "emr-bat");
  fs.mkdirSync(csvDir, { recursive: true });
  fs.mkdirSync(batDir, { recursive: true });
  const csvFile = path.join(csvDir, "pid.csv");
  const batFile = path.join(batDir, "pid.bat");
  const writeCsv = (id: string) => fs.writeFileSync(csvFile, `患者ID,氏名\n${id},テスト\n`, "utf8");
  const writeBat = (id: string) => fs.writeFileSync(batFile, `@echo off\nset PID=${id}\n`, "utf8");

  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "graphy-emr-"));
  const driver = new DesktopDriver(undefined, { extraElectronArgs: [`--user-data-dir=${userData}`] });
  const base = `http://127.0.0.1:${driver.ports.http}`;
  const shot = (p: Page, name: string) => p.screenshot({ path: path.join(OUT_DIR, `${name}.png`) });
  const putSettings = (kv: Record<string, string>) =>
    fetch(`${base}/api/settings`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(kv) });
  const getStatus = async () => (await (await fetch(`${base}/api/emr/status`)).json()) as {
    enabled: boolean; valid: boolean; autoOpen: boolean;
    file: { state: string; error: string | null };
    patient: { id: string; seq: number } | null;
    fetch: { state: string; patientId: string | null; found: number; retrieved: number; latestStudyUid: string | null; latestReady: boolean; error: string | null };
  };
  const studyUids = async (): Promise<string[]> =>
    ((await (await fetch(`${base}/api/studies`)).json()) as { studyInstanceUid: string }[]).map((s) => s.studyInstanceUid);
  const viewers = () => driver.app.windows().filter((w) => w.url().includes("2dviewer"));
  const ctx = async (page: Page) => {
    const raw = await page.evaluate(() => localStorage.getItem("graphy-viewer-ctx"));
    return raw ? (JSON.parse(raw) as { study: { studyInstanceUid: string }; ts: number }) : null;
  };

  let pacs: ChildProcess | null = null;
  try {
    // --- 偽の PACS ---
    await driver.start();
    const aeCfg = path.join(OUT_DIR, "ae.properties");
    fs.writeFileSync(aeCfg, `GRAPHYNEXT=127.0.0.1:${driver.ports.scp}\n`);
    pacs = spawn(dcm4cheTool("dcmqrscp"), ["-b", `DCMQRSCP:${PACS_PORT}`, "--dicomdir", path.join(OUT_DIR, "pacs", "DICOMDIR"),
      "--filepath", "{00100020}/{0020000D}/{0020000E}/{00080018}", "--ae-config", aeCfg], { shell: process.platform === "win32", stdio: "ignore" });
    check(await waitPort(PACS_PORT, 30_000), "偽の PACS（dcmqrscp）が待ち受けている");
    for (const d of ["s1", "s2", "s3", "s4"]) {
      const r = spawnSync(dcm4cheTool("storescu"), ["-c", `DCMQRSCP@127.0.0.1:${PACS_PORT}`, path.join(synthDir, d)], { encoding: "utf8", shell: process.platform === "win32" });
      check(r.status === 0, `PACS に ${d} を入れた`, r.stderr?.slice(-200));
    }

    const page = driver.page;
    await resetDb(driver.ports.http);
    // 設定は DB のリセットでは消えない。前の実行の電子カルテ連携の設定が残っていると、基準が狂う
    const stale = Object.keys((await (await fetch(`${base}/api/settings`)).json()) as Record<string, string>)
      .filter((k) => k.startsWith("emr.") || k.startsWith("prefetch."));
    await putSettings(Object.fromEntries(stale.map((k) => [k, ""])));
    await page.evaluate(() => localStorage.setItem("graphy.locale", "ja")); // 文言は日本語で確かめる
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    await dismissStartupDialogs(page);
    await putSettings({ "dicom.remoteAes": JSON.stringify([{ aeTitle: "DCMQRSCP", host: "127.0.0.1", port: PACS_PORT, tls: false }]) });
    check((await studyUids()).length === 0, "最初は自局に検査が無い");
    check(viewers().length === 0, "最初は 2D ビューアが開いていない");

    console.log("\n[0] 実際の設定画面から設定する（既定のまま: CSV の 1 行目は見出し）。有効にした直後の ID は、基準として覚えるだけ");
    writeCsv("EMRPT2"); // 有効にする前に書いてある ID（前の日の患者のつもり）
    await page.getByTestId("mainscreen-menu-system").click();
    await page.getByTestId("menu-item-settings").click();
    await page.getByTestId("settings-cat-emr").click();
    await page.getByTestId("emr-panel").waitFor({ state: "visible", timeout: 10_000 });
    check((await page.getByTestId("emr-save").isDisabled()), "最初は保存できない（変更なし）");
    await page.getByTestId("emr-enabled").check();
    check(await page.getByTestId("emr-save").isDisabled(), "有効にしただけでは（必須が空で）保存できない");
    check(await page.getByTestId("emr-form-errors").isVisible(), "足りない項目が表示される");
    await page.getByTestId("emr-path").fill(csvDir);
    await page.getByTestId("emr-format").selectOption("csv");
    await page.getByTestId("emr-charset").selectOption("UTF-8");
    check(await page.getByTestId("emr-csv-header").isChecked(), "「1 行目は見出し」は既定でオン");
    await page.getByTestId("emr-csv-column").fill("患者ID");
    await page.getByTestId("emr-pacs-ae").selectOption("DCMQRSCP");
    await page.getByTestId("emr-retrieve").selectOption("move");
    await page.getByTestId("emr-timeout").fill("120");
    await page.getByTestId("emr-auto-open").check();
    check(!(await page.getByTestId("emr-save").isDisabled()), "必須を入れると保存できる");
    await page.getByTestId("emr-save").click();
    check(await until(async () => (await getStatus()).patient?.id === "EMRPT2", 20_000), "有効にした直後に、ファイルの ID（EMRPT2）を読めた");
    const st0 = await getStatus();
    check(st0.patient?.seq === 0 && st0.fetch.state === "idle", "基準として覚えただけ（通し番号 0・取り込みなし）", st0);
    await page.getByTestId("emr-check").click();
    await page.getByTestId("emr-check-result").waitFor({ state: "visible", timeout: 10_000 });
    const chk = await page.getByTestId("emr-check-result").innerText();
    check(/読めました/.test(chk) && !chk.includes("EMRPT2"), "［読めるか確認］: 読めた旨が出て、ID の全文は出ない", chk);
    await shot(page, "00-settings");
    await sleep(5000); // 基準なら、開かない・取らないことを、時間を置いて確かめる
    check(viewers().length === 0, "基準の ID（EMRPT2）では、2D ビューアは開かない");
    check((await studyUids()).length === 0, "基準の ID では、PACS から取り込まない");
    await dismissStartupDialogs(page); // 設定の窓を閉じる

    console.log("\n[1] CSV に EMRPT1 を書く → 先取り → 2D ビューアに直近（2025-03-01）の検査");
    writeCsv("EMRPT1");
    check(await until(async () => viewers().length === 1, 60_000), "2D ビューアの窓が 1 つ開いた");
    check(await until(async () => (await ctx(page))?.study.studyInstanceUid === a3.studyUid, 30_000),
      "開いた検査は、EMRPT1 の直近（2025-03-01）で、UID が PACS の値と一致する");
    check(await until(async () => { const s = await getStatus(); return s.fetch.state === "done" && s.fetch.found === 3; }, 60_000), "PACS の 3 検査を見つけて取り込み終えた");
    const uids1 = await studyUids();
    check([a1, a2, a3].every((s) => uids1.includes(s.studyUid)), "過去の 3 検査がすべて手元に入った（直近だけでなく、過去も）", uids1.length);
    check(!uids1.includes(b1.studyUid), "別の患者（EMRPT2）の検査は取り込まない");
    const v = viewers()[0];
    await v.waitForFunction((n) => document.body.innerText.includes(n), a3.patientName, { timeout: 30_000 }).catch(() => undefined);
    check((await v.locator("body").innerText()).includes(a3.patientName), `ビューアに患者（${a3.patientName}）が出ている`);
    await sleep(1500);
    await shot(v, "01-viewer-emrpt1");
    check(await page.getByTestId("statusbar-emr").isVisible(), "状態バーに電子カルテの欄が出る");
    const bar = await page.getByTestId("statusbar-emr").innerText();
    check(!bar.includes("EMRPT1"), "状態バーに患者 ID の全文は出ない", bar);
    await shot(page, "01-main-statusbar");

    console.log("\n[2] EMRPT2 を書く → 同じ窓が差し替わる（窓は増えない）");
    const before2 = await ctx(page);
    writeCsv("EMRPT2");
    check(await until(async () => (await ctx(page))?.study.studyInstanceUid === b1.studyUid, 60_000), "ビューアの検査が EMRPT2 のものに切り替わった（UID 一致）");
    check(viewers().length === 1, "窓は 1 つのまま", viewers().length);
    await v.waitForFunction((n) => document.body.innerText.includes(n), b1.patientName, { timeout: 30_000 }).catch(() => undefined);
    check((await v.locator("body").innerText()).includes(b1.patientName), `ビューアの患者が ${b1.patientName} に変わった`);
    check((await ctx(page))!.ts > before2!.ts, "新しい要求として渡された（時刻が進んだ）");
    await shot(v, "02-viewer-emrpt2");

    console.log("\n[3] 負例: 同じ ID の書き直しでは、開き直さない");
    const ts3 = (await ctx(page))!.ts;
    writeCsv("EMRPT2");
    await sleep(6000);
    check((await ctx(page))!.ts === ts3, "ビューアに新しい要求が渡されていない");
    check((await getStatus()).patient?.id === "EMRPT2", "いまの患者は EMRPT2 のまま");

    console.log("\n[4] bat（set PID=ID）に切り替え → EMRPT1 の直近に切り替わる");
    await putSettings({ "emr.watch.path": batDir, "emr.watch.format": "bat", "emr.watch.bat.var": "PID" });
    writeBat("EMRPT2"); // 読み方を変えた直後に読めた ID は、基準（開かない）
    check(await until(async () => { const s = await getStatus(); return s.file.state === "ok" && s.patient?.id === "EMRPT2"; }, 20_000), "bat を読めた（基準）");
    const ts4 = (await ctx(page))!.ts;
    await sleep(3000);
    check((await ctx(page))!.ts === ts4, "読み方を変えただけでは、ビューアは動かない");
    writeBat("EMRPT1");
    check(await until(async () => (await ctx(page))?.study.studyInstanceUid === a3.studyUid, 60_000), "bat の ID の変化で、EMRPT1 の直近の検査に切り替わった");
    check(viewers().length === 1, "窓は 1 つのまま", viewers().length);

    console.log("\n[5] 負例: PACS にも手元にも無い患者 → 開かず、理由が出る");
    const ts5 = (await ctx(page))!.ts;
    writeBat("NOSUCH");
    const dlg = page.getByTestId("external-open-dialog");
    check(await until(async () => await dlg.isVisible(), 60_000), "理由のダイアログが出た");
    const t5 = await dlg.innerText();
    check(/PACS にも手元にもありません/.test(t5), "「PACS にも手元にもありません」と出る", t5);
    await shot(page, "05-not-found");
    await dlg.getByRole("button").last().click();
    check((await ctx(page))!.ts === ts5 && viewers().length === 1, "ビューアは変わらない");

    console.log("\n[6] 負例: ID として使えない内容 → 開かず、ファイルの異常が出る（患者は変わらない）");
    writeBat("a&calc");
    check(await until(async () => (await getStatus()).file.state === "error", 20_000), "ファイルの状態が異常になった");
    const st6 = await getStatus();
    check(st6.file.error === "id-invalid", "理由は id-invalid（内容は出ない）", st6.file);
    check(st6.patient?.id === "NOSUCH", "いまの患者は直前の ID のまま（読めない内容で変えない）", st6.patient);
    check((await ctx(page))!.ts === ts5, "ビューアは動かない");
    check(await until(async () => (await page.getByTestId("statusbar-emr").getAttribute("data-tone")) === "error", 10_000), "状態バーが異常を示す");
    await shot(page, "06-file-error");

    console.log("\n[7] 自動で開くをオフ → 取り込みだけ。［開く］ボタンで開く");
    await putSettings({ "emr.watch.autoOpen": "false" });
    writeBat("EMRPT2");
    check(await until(async () => { const s = await getStatus(); return s.patient?.id === "EMRPT2" && s.fetch.state === "done"; }, 60_000), "患者が変わり、取り込みは済んだ");
    const ts7 = (await ctx(page))!.ts;
    await sleep(4000);
    check((await ctx(page))!.ts === ts7, "自動で開かない設定では、ビューアは動かない");
    check(await until(async () => await page.getByTestId("emr-open-button").isVisible(), 10_000), "メイン画面に［電子カルテの患者を開く］が出ている");
    await page.getByTestId("emr-open-button").click();
    check(await until(async () => (await ctx(page))?.study.studyInstanceUid === b1.studyUid, 60_000), "［開く］で、EMRPT2 の検査が開いた（UID 一致）");
    await v.waitForFunction((n) => document.body.innerText.includes(n), b1.patientName, { timeout: 30_000 }).catch(() => undefined);
    check((await v.locator("body").innerText()).includes(b1.patientName), `ビューアの患者が ${b1.patientName}`);
    await shot(v, "07-viewer-after-button");

    console.log("\n[8] 負例: 監視するファイルが無い → 状態に出る");
    await putSettings({ "emr.watch.path": path.join(OUT_DIR, "nowhere") });
    check(await until(async () => (await getStatus()).file.state === "missing", 20_000), "ファイルの状態が「見つからない」になる");
  } finally {
    if (pacs) killProcessTree(pacs);
    await driver.stop();
    fs.rmSync(userData, { recursive: true, force: true });
  }
  process.exitCode = summary() === 0 ? 0 : 1;
}

main().catch((e) => { console.error(e); process.exit(2); });
