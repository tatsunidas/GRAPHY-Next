/*
 * 版違いの警告（再実行の同意画面）の実機検証。GP-JOB-001 の「実機確認待ち」3。
 * 段 5 では backend 単体でしか確かめていなかった「記録の版 x／今の版 y（違います）」が、本物の Electron の同意の窓に出るかを見る。
 *
 * 実行:  cd backend && mvn -q -Dfrontend.skip=true -DskipTests clean package   （backend jar）
 *        cd automator && GRAPHY_JUPYTER_PYTHON=/path/to/python npx tsx src/spike/computeVersionWarnCheck.ts
 *
 * 本物の Electron ＋ backend jar ＋ jupyter_server（プラグイン compute-runbatch-check）。スクリーンショットは
 * .results/compute-version-warn-check:
 *   [1] 3 組のうち 1 組が失敗（r2）
 *   [2] 版を上げない再実行 → 注記は「同じ版」で ⚠ が付かない（負例）。取り消す
 *   [3] プラグインの plugin.json の version を 0.1.0→0.2.0 に上げる（導入先の実体。終了時に戻す）。前提として backend の登録簿が 0.2.0 を返すことを先に確かめる
 *   [4] 再実行 → 同意の窓に「⚠ … 記録の版 0.1.0／今の版 0.2.0（違います）」。送るコードは記録のコード（SHA-256 一致）。監査 versionChanged=true
 */
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import type { Page } from "playwright";

import { DesktopDriver, DESKTOP_RUN_DATA_DIR } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importFixtureCategory } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { consentWindow, createChecker } from "./computeSpikeShared.js";

const { check, summary } = createChecker();

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "compute-version-warn-check");
const PLUGIN_ID = "compute-runbatch-check";
const ENDPOINT_ID = "automator-vwarn";
const AUDIT = path.join(DESKTOP_RUN_DATA_DIR, "compute-audit.jsonl");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
    s.on("error", reject);
  });
}

async function startJupyter(python: string, port: number, token: string, root: string): Promise<ChildProcess> {
  const proc = spawn(python, [
    "-m", "jupyter_server",
    "--ServerApp.ip=127.0.0.1", `--ServerApp.port=${port}`, "--ServerApp.port_retries=0",
    "--ServerApp.open_browser=False", `--IdentityProvider.token=${token}`, `--ServerApp.root_dir=${root}`,
  ], { stdio: ["ignore", "ignore", "ignore"] });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/status`, { headers: { Authorization: `token ${token}` } })).ok) return proc;
    } catch {
      /* まだ */
    }
    await sleep(300);
  }
  proc.kill();
  throw new Error("jupyter_server did not start");
}

async function waitFor<T>(what: string, f: () => Promise<T | null | undefined | false>, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await f();
    if (v) return v;
    await sleep(150);
  }
  throw new Error(`待っても起きなかった: ${what}`);
}

async function main(): Promise<void> {
  const python = process.env.GRAPHY_JUPYTER_PYTHON;
  if (!python || !fs.existsSync(python)) throw new Error("GRAPHY_JUPYTER_PYTHON を設定してください");
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const dst = path.join(DESKTOP_RUN_DATA_DIR, "plugins", PLUGIN_ID);
  fs.mkdirSync(dst, { recursive: true });
  for (const n of ["plugin.json", "ui.js"]) fs.copyFileSync(path.join(AUTOMATOR_ROOT, "plugins", PLUGIN_ID, n), path.join(dst, n));
  fs.rmSync(AUDIT, { force: true });

  const jPort = await freePort();
  const jToken = crypto.randomBytes(16).toString("hex");
  const jRoot = fs.mkdtempSync(path.join(OUT_DIR, "jroot-"));
  let jupyter = await startJupyter(python, jPort, jToken, jRoot);
  const jBase = `http://127.0.0.1:${jPort}/`;
  const counterDir = fs.mkdtempSync(path.join(OUT_DIR, "counters-"));
  const cnt = (name: string) => path.join(counterDir, name).replace(/\\/g, "/");

  const driver = new DesktopDriver();
  let endpointsFile: string | null = null;
  let endpointsBackup: string | null = null;
  let manifestRestore: (() => void) | null = null;
  const consentPages: Page[] = [];
  try {
    await driver.start();
    driver.app.on("window", (p) => consentPages.push(p));
    const page = driver.page;
    page.on("console", (m) => {
      if (m.type() === "error" && !/404|Failed to load resource|network error/.test(m.text())) console.log(`  [renderer error] ${m.text().slice(0, 200)}`);
    });
    await resetDb(driver.ports.http);
    await importFixtureCategory(driver.ports.http, "ct-basic");
    await page.evaluate("localStorage.setItem('graphy.locale', 'ja')");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    const later = page.getByRole("button", { name: /^(後で|Later)$/ });
    if (await later.isVisible().catch(() => false)) await later.click();
    const cwd = await driver.app.evaluate(({ dialog }) => {
      dialog.showMessageBoxSync = (() => 0) as typeof dialog.showMessageBoxSync;
      return process.cwd();
    });
    endpointsFile = path.join(cwd, "compute-endpoints.json");
    endpointsBackup = fs.existsSync(endpointsFile) ? fs.readFileSync(endpointsFile, "utf8") : null;
    const reg = await page.evaluate(
      async ({ id, url, token }) => {
        const d = (window as unknown as { graphyDesktop: any }).graphyDesktop; // eslint-disable-line @typescript-eslint/no-explicit-any
        const a = await d.computeEndpointsSet({ endpoints: [{ id, label: "Local Jupyter", url }] });
        const b = await d.secretSet(`compute.endpoint.${id}.token`, token);
        return { a, b };
      },
      { id: ENDPOINT_ID, url: jBase, token: jToken },
    );
    if (!reg.a.ok || !reg.b.ok) throw new Error("接続先を登録できません: " + JSON.stringify(reg));

    const base = `http://localhost:${driver.ports.http}`;
    const jobs = async (): Promise<Row[]> => (await (await fetch(`${base}/api/compute/jobs`)).json()) as Row[];
    const studies = (await (await fetch(`${base}/api/studies`)).json()) as { studyInstanceUid: string; patientName: string | null }[];
    const study = studies[0];
    const series = (await (await fetch(`${base}/api/studies/${study.studyInstanceUid}/series`)).json()) as { seriesInstanceUid: string; modality: string }[];
    const ct = series.find((s) => s.modality === "CT") ?? series[0];
    const known = new Set<string>((await jobs()).map((j) => j.id));
    const newRows = async (): Promise<Row[]> => (await jobs()).filter((j) => !known.has(j.id));
    const events = (): Row[] => fs.readFileSync(AUDIT, "utf8").trim().split("\n").map((l) => JSON.parse(l));

    const scriptOf = (counterFile: string, sleepSec: number, failAt: number | null) => [
      "import os, json, hashlib, time",
      `p = r'${counterFile}'`,
      "n = int(open(p).read()) if os.path.exists(p) else 0",
      "open(p, 'w').write(str(n + 1))",
      "raw = open('inputs/0.npz', 'rb').read()",
      "os.makedirs('outputs', exist_ok=True)",
      "json.dump({'sha256': hashlib.sha256(raw).hexdigest(), 'n': n}, open('outputs/summary.json', 'w'))",
      `time.sleep(${sleepSec})`,
      ...(failAt == null ? [] : [`if n == ${failAt}:`, "    raise ValueError('third fails')"]),
    ].join("\n");
    const itemsOf = (keys: string[]) => keys.map((key) => ({ key, studyUid: study.studyInstanceUid, seriesUid: ct.seriesInstanceUid }));

    const launch = async (input: Record<string, unknown>) => {
      await page.evaluate((i) => {
        (window as unknown as Record<string, unknown>).__batchInput = i;
        (window as unknown as Record<string, unknown>).__batch = undefined;
      }, input);
      await page.getByTestId("mainscreen-menu-plugins").click();
      await page.getByTestId(`plugin-item-${PLUGIN_ID}`).click();
    };
    const batchState = (): Promise<Row | undefined> => page.evaluate(() => (window as unknown as { __batch?: Row }).__batch);
    const openWindow = (): Promise<Page> =>
      driver.waitForNewPage(async () => {
        await page.getByTestId("mainscreen-menu-system").click();
        await page.getByTestId("menu-item-compute-jobs").click();
      }, (url) => url.includes("#computejobs"));
    const consentRows = async (win: Page) =>
      win.locator("#data-body tr").evaluateAll((trs) => trs.map((tr) => Array.from(tr.querySelectorAll("td")).map((td) => (td.textContent ?? "").trim())));

    // ── [1] 3 組のうち 1 組が失敗 ──
    console.log("\n[1] 3 組のうち 1 組が失敗する一括");
    const script = scriptOf(cnt("c1.txt"), 1, 1);
    await launch({ endpointId: ENDPOINT_ID, script, items: itemsOf(["r1", "r2", "r3"]), collect: true });
    const w1 = await consentWindow(driver);
    await w1.getByTestId("consent-ack").check();
    await w1.getByTestId("consent-send").click();
    const jobsWin = await openWindow();
    await waitFor("3 組が終わる", async () => {
      const r = (await newRows()).filter((j) => j.batchId);
      return r.length === 3 && r.every((j) => ["DONE", "FAILED"].includes(j.state));
    }, 180_000);
    const rows1 = await newRows();
    const batchId = rows1[0].batchId as string;
    for (const j of rows1) known.add(j.id);
    const failed1 = rows1.find((j) => j.state === "FAILED") as Row;
    check(rows1.filter((j) => j.state === "DONE").length === 2 && failed1?.itemKey === "r2", "（前提）完了 2・失敗 1（r2）", rows1.map((j) => [j.itemKey, j.state]));
    const rerunBtn = jobsWin.getByTestId(`computejobs-batch-rerun-${batchId}`);
    await waitFor("見出しに［失敗だけ再実行］", async () => (await rerunBtn.count()) > 0, 20_000);

    // ── [2] 版が同じ → ⚠ なし（負例） ──
    console.log("\n[2] 版が同じ再実行（負例）");
    const rerunNote = async (w: Page) => (await w.getByTestId("consent-rerun").textContent()) ?? "";
    await rerunBtn.click();
    const w2 = await consentWindow(driver);
    await w2.getByTestId("consent-rerun").waitFor({ state: "visible", timeout: 10_000 });
    const note2 = await rerunNote(w2);
    check(/再実行（2 回目）|re-run \(attempt 2\)/.test(note2), "（前提）再実行の同意の窓が開き、注記が出ている", note2);
    check(/記録の版 0\.1\.0・今の版 0\.1\.0（同じ版）|Recorded version 0\.1\.0, current version 0\.1\.0 \(same\)/.test(note2) && !/⚠|違います|different/.test(note2), "🔴 版が同じなら『同じ版』で、⚠・『違います』は出ない", note2);
    await w2.screenshot({ path: path.join(OUT_DIR, "ui-02-same-version.png") });
    await w2.getByTestId("consent-cancel").click();
    await sleep(2000);

    // ── [3] 版を上げる ──
    console.log("\n[3] プラグインの版を 0.1.0 → 0.2.0 に上げる");
    const manifestPath = path.join(dst, "plugin.json");
    const manifestOrig = fs.readFileSync(manifestPath, "utf8");
    manifestRestore = () => fs.writeFileSync(manifestPath, manifestOrig);
    const m = JSON.parse(manifestOrig) as Row;
    check(m.version === "0.1.0", "（前提）導入先の plugin.json は 0.1.0", m.version);
    m.version = "0.2.0";
    fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2));
    // 登録簿が読み直すか（読み直さなければ警告は出ようがない＝検査の前提）
    const regVersion = async () => ((await (await fetch(`${base}/api/plugins`)).json()) as Row[]).find((p) => p.id === PLUGIN_ID)?.version;
    let seen: unknown = await regVersion();
    for (let i = 0; i < 40 && seen !== "0.2.0"; i++) {
      await sleep(250);
      seen = await regVersion();
    }
    check(seen === "0.2.0", "（前提）backend の登録簿が 0.2.0 を返す（GET /api/plugins）", seen);

    // ── [4] 版が違う → ⚠ ──
    console.log("\n[4] 版が違う再実行");
    const consentsBefore = consentPages.length;
    await rerunBtn.click();
    const w4 = await consentWindow(driver);
    await w4.getByTestId("consent-rerun").waitFor({ state: "visible", timeout: 10_000 });
    const note4 = await rerunNote(w4);
    check(consentPages.length > consentsBefore, "（前提）同意の窓が新しく開いた", consentPages.length);
    check(/⚠/.test(note4) && /記録の版 0\.1\.0／今の版 0\.2\.0（違います）|Recorded version 0\.1\.0 \/ current version 0\.2\.0 \(different\)/.test(note4), "🔴 『⚠ 記録の版 0.1.0／今の版 0.2.0（違います）』が同意の窓に出る", note4);
    check(/記録のコードを実行します|The recorded code runs, not the current plugin/.test(note4), "『今のプラグインではなく、記録のコードを実行します』と出る", note4);
    check(((await w4.getByTestId("consent-code").textContent()) ?? "") === script, "送るコードの全文は記録のコード（今の版のものではない）");
    await w4.screenshot({ path: path.join(OUT_DIR, "ui-04-version-warning.png") });
    await w4.getByTestId("consent-ack").check();
    await w4.getByTestId("consent-send").click();
    await waitFor("2 回目が終わる", async () => {
      const r = await newRows();
      return r.length === 1 && ["DONE", "FAILED"].includes(r[0].state);
    }, 120_000);
    const second = (await newRows())[0];
    check(second.itemKey === "r2" && second.attempt === 2 && second.state === "DONE", "記録のコードで r2 が 2 回目として完了（コードは常に記録のもの）", { k: second.itemKey, a: second.attempt, s: second.state });
    check(events().some((e) => e.event === "compute-rerun-requested" && String(e.attempt) === "2" && e.versionChanged === true), "監査: compute-rerun-requested（2 回目・versionChanged=true）");
    check(events().filter((e) => e.event === "compute-rerun-requested" && e.versionChanged === false).length === 1 && events().filter((e) => e.event === "compute-rerun-requested" && e.versionChanged === true).length === 1, "（負例）監査の versionChanged は、版が同じ要求［2］で false が 1 件・版が違う要求［4］で true が 1 件（要求は取り消しても記録される）")
    const detail = (await (await fetch(`${base}/api/compute/jobs/${second.id}`)).json()) as Row;
    await jobsWin.getByTestId(`computejobs-row-${second.id}`).click();
    await jobsWin.getByTestId("computejobs-detail-attempts").waitFor({ state: "visible", timeout: 10_000 });
    const same = (await jobsWin.getByTestId("computejobs-detail-same").textContent()) ?? "";
    const a1 = (await jobsWin.getByTestId("computejobs-detail-attempt-1").textContent()) ?? "";
    const a2 = (await jobsWin.getByTestId("computejobs-detail-attempt-2").textContent()) ?? "";
    check(/プラグインの版[^·]*0\.1\.0/.test(a1) || /0\.1\.0/.test(a1), "詳細: 1 回目の行に版 0.1.0", a1);
    check(/0\.2\.0/.test(a2), "詳細: 2 回目の行に版 0.2.0（実行時の今の版）", a2);
    check(/⚠/.test(same) && /違います/.test(same), "🔴 詳細は『試行のあいだで版が違う』と警告し、『同じです』とは言わない", same);
    await jobsWin.screenshot({ path: path.join(OUT_DIR, "ui-05-detail-after-version-change.png") });
    void detail;
  } finally {
    manifestRestore?.();
    await driver.stop().catch(() => undefined);
    jupyter.kill();
    if (endpointsFile) {
      if (endpointsBackup !== null) fs.writeFileSync(endpointsFile, endpointsBackup);
      else fs.rmSync(endpointsFile, { force: true });
    }
  }
  if (summary() > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
