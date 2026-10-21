/*
 * 再実行（1 件・失敗だけ）の実機検証（段 5）。同じ一括の次の試行として、同意を取り直して走る。
 *
 * 実行:  cd backend && mvn -q -Dfrontend.skip=true -DskipTests clean package   （backend jar）
 *        cd automator && GRAPHY_JUPYTER_PYTHON=C:\...\anaconda3\python.exe npx tsx src/spike/computeRerunCheck.ts
 *
 * 本物の Electron ＋ backend jar ＋ jupyter_server（プラグイン compute-runbatch-check）。スクリーンショットは
 * .results/compute-rerun-check:
 *   [1] 3 組のうち 1 組が失敗 → 窓の見出しに［失敗だけ再実行］
 *   [2] 押す → 同意の窓が再び開き、1 行と再実行の注記が出る → 取り消すと走らない（負例）
 *   [3] もう一度押して承認 → 同じ一括の中で 2 回目として完了（見出し『完了 3』・状態バーの失敗が消える・詳細に 1 回目と 2 回目が並び同じ）
 *       プラグインの attach が 2 回目（attempt 2）を受け取る
 *   [4] 記録の計算機を登録から外す → 再実行は理由を出して選び直し → 選んだ計算機が同意画面の送り先になり、走る
 *   [5] シリーズを削除すると、再実行は理由を出して同意の窓も開かない（負例）
 * 未達（ここでは確かめない）: 版違いの警告（backend 単体で確認）、Colab、macOS/Linux。
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

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "compute-rerun-check");
const PLUGIN_ID = "compute-runbatch-check";
const ENDPOINT_ID = "automator-rerun";
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
    // 前の実行の台帳の失敗（まだ確認していないもの）が状態バーに数えられていることがあるので、増減で見る
    const barFailed = async () => {
      const b = page.getByTestId("statusbar-compute-jobs");
      return (await b.count()) === 0 ? 0 : Number(/失敗\s*(\d+)/.exec((await b.textContent()) ?? "")?.[1] ?? 0);
    };
    const failedBase = await barFailed();
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
    check(rows1.filter((j) => j.state === "DONE").length === 2 && failed1?.itemKey === "r2" && failed1?.attempt === 1, "完了 2・失敗 1（r2 が 1 回目で失敗）", rows1.map((j) => [j.itemKey, j.state]));
    const rerunBtn = jobsWin.getByTestId(`computejobs-batch-rerun-${batchId}`);
    await waitFor("見出しに［失敗だけ再実行］", async () => (await rerunBtn.count()) > 0, 20_000);
    check(true, "一括の見出しに［失敗だけ再実行］が出る");
    check((await jobsWin.getByTestId(`computejobs-rerun-${failed1.id}`).count()) === 1, "失敗した行に［再実行］が出る");
    const doneRow = rows1.find((j) => j.state === "DONE") as Row;
    check((await jobsWin.getByTestId(`computejobs-rerun-${doneRow.id}`).count()) === 0, "（負例）完了した行には［再実行］が出ない");
    const bar = page.getByTestId("statusbar-compute-jobs");
    await waitFor("状態バーの失敗が 1 増える", async () => (await barFailed()) === failedBase + 1, 20_000);
    check(true, `状態バーの失敗が 1 増える（${failedBase} → ${failedBase + 1}）`);
    await jobsWin.screenshot({ path: path.join(OUT_DIR, "ui-01-failed.png") });

    // ── [2] 同意の窓が再び開く・取り消すと走らない ──
    console.log("\n[2] 同意を取り直す・取り消し");
    const consentCount = () => consentPages.filter((p) => p.url().endsWith("computeConsent.html")).length;
    const before = consentCount();
    await rerunBtn.click();
    const w2 = await consentWindow(driver);
    const rows2 = await consentRows(w2);
    check(consentCount() === before + 1, "🔴 再実行のたびに同意の窓が新しく開く（前の承認は使わない）", { before, after: consentCount() });
    check(rows2.length === 1 && rows2[0][0] === "r2", "同意の窓には再実行する 1 組（r2）だけの 1 行", rows2.map((r) => r[0]));
    const note = (await w2.getByTestId("consent-rerun").textContent()) ?? "";
    check(/再実行/.test(note) && /2\s*回目/.test(note) && /0\.1\.0/.test(note), "再実行の注記（2 回目・記録の版と今の版）が出る", note);
    check(((await w2.getByTestId("consent-code").textContent()) ?? "") === script, "記録のコードの全文が出る");
    await w2.screenshot({ path: path.join(OUT_DIR, "ui-02-rerun-consent.png") });
    await w2.getByTestId("consent-cancel").click();
    await sleep(3000);
    check((await newRows()).length === 0, "🔴 取り消すと何も走らない（台帳の行が増えない）", (await newRows()).length);
    check((await rerunBtn.count()) > 0, "（取り消しのあとも）［失敗だけ再実行］は残る");

    // ── [3] 承認して走る ──
    console.log("\n[3] 承認して 2 回目として完了");
    await rerunBtn.click();
    const w3 = await consentWindow(driver);
    await w3.getByTestId("consent-ack").check();
    await w3.getByTestId("consent-send").click();
    await waitFor("2 回目が終わる", async () => {
      const r = await newRows();
      return r.length === 1 && ["DONE", "FAILED"].includes(r[0].state);
    }, 120_000);
    const second = (await newRows())[0];
    for (const j of await newRows()) known.add(j.id);
    check(second.itemKey === "r2" && second.attempt === 2 && second.state === "DONE" && second.batchId === batchId, "r2 が同じ一括の 2 回目（attempt 2）として完了", { k: second.itemKey, a: second.attempt, s: second.state, same: second.batchId === batchId });
    await waitFor("見出しが完了 3", async () => {
      const t = (await jobsWin.getByTestId(`computejobs-batch-${batchId}`).textContent()) ?? "";
      return /完了\s*3/.test(t) && /失敗\s*0/.test(t);
    }, 20_000);
    check(true, "窓の見出しが『完了 3・失敗 0』（直した古い失敗は数えない）");
    check((await jobsWin.getByTestId(`computejobs-batch-rerun-${batchId}`).count()) === 0, "失敗が無くなると［失敗だけ再実行］は消える");
    await waitFor("状態バーの失敗が元に戻る", async () => (await barFailed()) === failedBase, 20_000);
    check(true, "状態バーの失敗が 1 減って元に戻る（直した古い失敗は数えない。先に増えたことは確認済み）");
    await jobsWin.getByTestId(`computejobs-row-${second.id}`).click();
    await jobsWin.getByTestId("computejobs-detail-attempts").waitFor({ state: "visible", timeout: 10_000 });
    const same = (await jobsWin.getByTestId("computejobs-detail-same").textContent()) ?? "";
    check((await jobsWin.getByTestId("computejobs-detail-attempt-1").count()) === 1 && (await jobsWin.getByTestId("computejobs-detail-attempt-2").count()) === 1, "詳細に 1 回目と 2 回目が並ぶ");
    check(/同じ/.test(same) && !/違い/.test(same), "コード・プラグインの版・入力が 1 回目と同じと出る", same);
    await jobsWin.screenshot({ path: path.join(OUT_DIR, "ui-03-rerun-done.png") });
    check(events().filter((e) => e.event === "egress-consumed").length === 2, "承認は最初の一括と再実行で 1 回ずつ（監査ログ）");
    check(events().some((e) => e.event === "compute-rerun-requested" && String(e.attempt) === "2" && e.versionChanged === false), "監査: compute-rerun-requested（2 回目・版の違いなし）");
    await launch({ attachBatchId: batchId, collect: true });
    await waitFor("attach が返る", async () => !!(await batchState())?.outcome, 60_000);
    const stA = (await batchState()) as Row;
    check((stA.items as Row[]).length === 1 && stA.items[0].key === "r2" && stA.items[0].attempt === 2 && stA.items[0].ok === true, "プラグインの attach が 2 回目（attempt 2）の結果だけを受け取る", (stA.items as Row[]).map((i) => [i.key, i.attempt, i.ok]));
    check(stA.outcome?.counts?.done === 3 && stA.outcome?.counts?.failed === 0, "件数は組ごとの最新の試行（完了 3・失敗 0）", stA.outcome?.counts);

    // ── [4] 記録の計算機が登録から消えた ──
    console.log("\n[4] 記録の計算機が消えた → 選び直す");
    await launch({ endpointId: ENDPOINT_ID, script: "raise ValueError('always fails')", items: itemsOf(["e1"]), collect: true });
    const w4 = await consentWindow(driver);
    await w4.getByTestId("consent-ack").check();
    await w4.getByTestId("consent-send").click();
    await waitFor("e1 が失敗", async () => (await newRows()).some((j) => j.itemKey === "e1" && j.state === "FAILED"), 120_000);
    const e1 = (await newRows()).find((j) => j.itemKey === "e1") as Row;
    for (const j of await newRows()) known.add(j.id);
    const reg2 = await page.evaluate(
      async ({ id, url, token }) => {
        const d = (window as unknown as { graphyDesktop: any }).graphyDesktop; // eslint-disable-line @typescript-eslint/no-explicit-any
        const a = await d.computeEndpointsSet({ endpoints: [{ id, label: "Second Jupyter", url }] });
        const b = await d.secretSet(`compute.endpoint.${id}.token`, token);
        return { a, b };
      },
      { id: "second", url: jBase.replace("127.0.0.1", "localhost"), token: jToken },
    );
    if (!reg2.a.ok || !reg2.b.ok) throw new Error("2 つ目の計算機を登録できません: " + JSON.stringify(reg2));
    const beforePick = consentCount();
    await jobsWin.getByTestId(`computejobs-rerun-${e1.id}`).click();
    await jobsWin.getByTestId("computejobs-rerun-endpoint").waitFor({ state: "visible", timeout: 20_000 });
    const msg = (await jobsWin.getByTestId("computejobs-rerun-msg").textContent()) ?? "";
    check(/登録されていません/.test(msg), "記録の計算機が無いと理由が出て、選び直しの欄が出る", msg);
    check(consentCount() === beforePick, "（この時点では同意の窓は開いていない）", consentCount());
    await jobsWin.screenshot({ path: path.join(OUT_DIR, "ui-04-pick-endpoint.png") });
    await jobsWin.getByTestId("computejobs-rerun-endpoint-go").click();
    const w5 = await consentWindow(driver);
    const dest = (await w5.getByTestId("consent-url").textContent()) ?? "";
    check(dest.includes("localhost"), "🔴 選び直した計算機が同意画面の送り先になる", dest);
    await w5.getByTestId("consent-ack").check();
    await w5.getByTestId("consent-send").click();
    await waitFor("e1 の 2 回目が走る", async () => (await newRows()).some((j) => j.itemKey === "e1" && j.attempt === 2 && ["DONE", "FAILED"].includes(j.state)), 120_000);
    const e1b = (await newRows()).find((j) => j.itemKey === "e1" && j.attempt === 2) as Row;
    check(e1b.state === "FAILED" && e1b.reason === "code-error", "選んだ計算機で 2 回目が走った（常に失敗するコードなので code-error）", { s: e1b.state, r: e1b.reason });
    for (const j of await newRows()) known.add(j.id);

    // ── [5] シリーズが消えた ──
    console.log("\n[5] シリーズを削除 → 再実行できない");
    const e1c = (await jobs()).find((j) => j.itemKey === "e1" && j.attempt === 2) as Row;
    const del = await fetch(`${base}/api/series/${study.studyInstanceUid}/${ct.seriesInstanceUid}`, { method: "DELETE" });
    check(del.ok, "（前提）シリーズを削除した", del.status);
    await waitFor("台帳の入力が『削除済み』になる", async () => ((await (await fetch(`${base}/api/compute/jobs/${e1c.id}`)).json()) as Row).inputs?.[0]?.deleted === true, 20_000);
    const before5 = consentCount();
    await jobsWin.getByTestId(`computejobs-rerun-${e1c.id}`).click();
    await waitFor("理由が出る", async () => /削除/.test((await jobsWin.getByTestId("computejobs-rerun-msg").count()) ? ((await jobsWin.getByTestId("computejobs-rerun-msg").textContent()) ?? "") : ""), 20_000);
    check(true, "シリーズが消えていると理由（保管庫から削除されたシリーズ）が出る");
    await sleep(1500);
    check(consentCount() === before5, "🔴 同意の窓は開かない（送らない）", { before5, after: consentCount() });
    check((await newRows()).length === 0, "台帳の行も増えない");
    await jobsWin.screenshot({ path: path.join(OUT_DIR, "ui-05-series-deleted.png") });
  } finally {
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
