/*
 * 一括実行（同じコードを組ごとに走らせる。同意は 1 回）の実機検証（段 3b: 同意の窓・host API・窓の再開と中止・眠り止め）。
 *
 * 実行:  cd backend && mvn -q -Dfrontend.skip=true -DskipTests clean package   （backend jar）
 *        cd automator && GRAPHY_JUPYTER_PYTHON=C:\...\anaconda3\python.exe npx tsx src/spike/computeBatchCheck.ts
 *
 * 本物の Electron ＋ backend jar ＋ jupyter_server で、プラグイン（compute-runbatch-check）から runBatch を投げる。
 * スクリーンショットは .results/compute-batch-check:
 *   [1] 5 組を投げる → 同意の窓が 1 回だけ開き、5 行（種類・枚数・形式・大きさ・塗った枚数・SHA-256）と合計・コード全文が出る。
 *       承認後、計算機に届いた 5 つのファイルの SHA-256（コードが計算機の上で出力）が同意画面の 5 行と一致する。
 *       1 組をコードのエラーにして「完了 4・失敗 1」。承認の札は 1 回（監査ログ）。
 *   [2] 実行中は状態バー・窓の数が一致し、眠り止めの表示が出て、終わると消える（先に出ていることを確かめてから）。
 *   [3] 計算機（jupyter）を止める → 一時停止（残りは失敗にならない）・眠り止めが外れる → 起動し直して［再開］で残りが完了。
 *   [4] 画面を作り直して（メイン画面を再読み込み）attach で未受け取りの結果を受け取り、受け取り済みの印が窓に出る。
 * 未達（ここでは確かめない）: 承認後にデータを差し替える負例（backend の統合テストで確認済み）、Colab、macOS/Linux。
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

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "compute-batch-check");
const PLUGIN_ID = "compute-runbatch-check";
const ENDPOINT_ID = "automator-batch";
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

    // ── [1] 5 組・1 回の同意 ──
    console.log("\n[1] 5 組を 1 回の同意で");
    const keys5 = ["p1", "p2", "p3", "p4", "p5"];
    const script1 = scriptOf(cnt("c1.txt"), 2, 2);
    await launch({ endpointId: ENDPOINT_ID, script: script1, items: itemsOf(keys5), collect: true });
    const win = await consentWindow(driver);
    const rows = await consentRows(win);
    const shas = rows.map((r) => r[r.length - 1]);
    check(rows.length === 5, "同意の窓に 5 行（組ごとに 1 行）", rows.length);
    check(rows.map((r) => r[0]).join(",") === keys5.join(","), "先頭の列に組名が並ぶ", rows.map((r) => r[0]));
    check(shas.every((s) => /^[0-9a-f]{64}$/.test(s)), "各行に SHA-256（64 桁）", shas);
    const sumText = (await win.getByTestId("consent-summary").textContent()) ?? "";
    check(/5\s*(組|items)/.test(sumText) && /5\s*(件|datasets)/.test(sumText), "合計（組の数・データの件数・大きさ）が出る", sumText);
    check(((await win.getByTestId("consent-code").textContent()) ?? "") === script1, "コードの全文が 1 つ出る");
    check(await win.getByTestId("consent-send").isDisabled(), "（前提）確認するまで［送信する］は押せない");
    await win.screenshot({ path: path.join(OUT_DIR, "ui-01-consent-5.png") });
    await win.getByTestId("consent-ack").check();
    await win.getByTestId("consent-send").click();

    // 実行中
    const jobsWin = await openWindow();
    await jobsWin.getByTestId("computejobs-screen").waitFor({ state: "visible", timeout: 20_000 });
    await waitFor("一括の見出しが出る", async () => (await jobsWin.locator("[data-testid^=computejobs-batch-cb_]").count()) > 0, 60_000);
    // ── [2] 状態バーと眠り止め ──
    console.log("\n[2] 状態バー・眠り止め（実行中）");
    const bar = page.getByTestId("statusbar-compute-jobs");
    await bar.waitFor({ state: "visible", timeout: 20_000 });
    await waitFor("眠り止めの表示（状態バー）", async () => (await page.getByTestId("statusbar-keep-awake").count()) > 0, 20_000);
    check(true, "実行中は状態バーに『計算中のため眠りを止めています』が出る（main の返答に基づく）");
    await waitFor("眠り止めの表示（窓）", async () => (await jobsWin.getByTestId("computejobs-awake").count()) > 0, 20_000);
    check(true, "計算ジョブの窓にも同じ表示が出る");
    const counts = async () => ({
      win: ((await jobsWin.getByTestId("computejobs-counts").textContent()) ?? "").replace(/\s/g, ""),
      bar: (await bar.count()) === 0 ? "" : ((await bar.textContent()) ?? "").replace(/\s/g, ""),
    });
    await waitFor("状態バーと窓の数が一致", async () => {
      const c = await counts();
      return c.bar !== "" && c.win === c.bar;
    }, 20_000);
    const c1 = await counts();
    check(/実行中[1-9]/.test(c1.bar) && /待ち[1-9]/.test(c1.bar), "一括の分を含めた数が状態バーと窓で一致（実行中・待ちとも 1 以上）", c1);
    await jobsWin.screenshot({ path: path.join(OUT_DIR, "ui-02-running.png") });
    await page.screenshot({ path: path.join(OUT_DIR, "ui-02-statusbar.png") });

    // 完了
    await waitFor("5 組が終わる", async () => {
      const r = (await newRows()).filter((j) => j.batchId);
      return r.length === 5 && r.every((j) => ["DONE", "FAILED", "CANCELLED", "INTERRUPTED"].includes(j.state));
    }, 180_000);
    const batch1 = (await newRows()).filter((j) => j.batchId);
    for (const j of batch1) known.add(j.id);
    const states = batch1.map((j) => j.state).sort();
    check(states.filter((s) => s === "DONE").length === 4 && states.filter((s) => s === "FAILED").length === 1, "完了 4・失敗 1（1 組のコードのエラーで残りは止まらない）", states);
    const failed = batch1.find((j) => j.state === "FAILED");
    check(failed?.reason === "code-error" && failed?.errorName === "ValueError", "失敗は code-error / ValueError", { reason: failed?.reason, name: failed?.errorName });
    check(new Set(batch1.map((j) => j.batchId)).size === 1 && batch1.every((j) => j.interactive === false), "5 行が 1 つの一括（interactive=false）");
    const batchId1 = batch1[0].batchId as string;
    await waitFor("見出しが完了 4・失敗 1 になる", async () => {
      const t = (await jobsWin.getByTestId(`computejobs-batch-${batchId1}`).textContent()) ?? "";
      return /完了\s*4/.test(t) && /失敗\s*1/.test(t);
    }, 20_000);
    check(true, "窓の見出しが『完了 4・失敗 1』");
    await jobsWin.screenshot({ path: path.join(OUT_DIR, "ui-03-batch-done.png") });
    // 眠り止めは終わると消える（先に出ていたことは確認済み）
    await waitFor("眠り止めが外れる", async () => (await page.getByTestId("statusbar-keep-awake").count()) === 0, 20_000);
    check(true, "一括が終わると眠り止めの表示が消える");

    // プラグインに届いた結果と、同意画面の SHA-256 の突き合わせ
    await waitFor("プラグインが 5 組を受け取る", async () => ((await batchState())?.items?.length ?? 0) === 5 && !!(await batchState())?.outcome, 60_000);
    const st = (await batchState()) as Row;
    const byKey = new Map<string, Row>((st.items as Row[]).map((i) => [i.key, i]));
    check(keys5.every((k) => byKey.has(k)), "onItem が 5 組すべてに届いた", [...byKey.keys()]);
    check(keys5.every((k, idx) => byKey.get(k)?.summary?.sha256 === shas[idx]), "🔴 計算機に届いた 5 つのファイルの SHA-256 が、同意画面の 5 行と一致する（承認したバイト列がそのまま届いた）",
      keys5.map((k, i) => [byKey.get(k)?.summary?.sha256?.slice(0, 8), shas[i].slice(0, 8)]));
    check(byKey.get("p3")?.status === "error" && byKey.get("p3")?.errorName === "ValueError" && keys5.filter((k) => k !== "p3").every((k) => byKey.get(k)?.status === "ok"), "コードのエラーの組は status:error（runJob と同じ形）・他は ok");
    check(st.outcome?.ok === true && st.outcome?.counts?.done === 4 && st.outcome?.counts?.failed === 1, "runBatch は件数つきで返る", st.outcome?.counts);
    check((st.collected as string[]).length === 5, "markCollected が 5 組分通った");
    const consentOpens = consentPages.filter((p) => p.url().endsWith("computeConsent.html")).length;
    check(consentOpens === 1, "🔴 同意の窓は一括を投げて 1 回だけ開いた（組ごとに開かない）", consentOpens);
    check(events().filter((e) => e.event === "egress-consumed").length === 1, "🔴 承認の札は 1 回だけ使われた（監査ログ）");
    check(events().filter((e) => e.event === "compute-uploaded").length === 5, "アップロードは 5 組で 5 回");
    check(events().some((e) => e.event === "compute-batch-requested" && e.items === 5), "監査: compute-batch-requested（組 5）");

    // ── [3] 計算機が止まる → 一時停止 → 再開 ──
    console.log("\n[3] 計算機を止める → 一時停止 → 起動し直して再開");
    const keys3 = ["q1", "q2", "q3"];
    await launch({ endpointId: ENDPOINT_ID, script: scriptOf(cnt("c3.txt"), 6, null), items: itemsOf(keys3), collect: true });
    const w2 = await consentWindow(driver);
    await w2.getByTestId("consent-ack").check();
    await w2.getByTestId("consent-send").click();
    await waitFor("q1 が実行中", async () => (await newRows()).some((j) => j.itemKey === "q1" && j.state === "RUNNING"), 90_000);
    jupyter.kill(); // 計算機に届かなくなる
    await waitFor("一括が一時停止になる", async () => (await newRows()).some((j) => j.pausedReason), 120_000);
    const r3 = await newRows();
    const q1 = r3.find((j) => j.itemKey === "q1") as Row;
    check(q1.state === "FAILED" && q1.reason === "endpoint-unreachable", "実行中だった組は endpoint-unreachable", { s: q1.state, r: q1.reason });
    check(r3.filter((j) => j.itemKey !== "q1").every((j) => j.state === "QUEUED"), "🔴 残りは失敗にせず待ちのまま", r3.map((j) => [j.itemKey, j.state]));
    const batchId3 = q1.batchId as string;
    await waitFor("窓に『一時停止』と［再開］が出る", async () => (await jobsWin.getByTestId(`computejobs-batch-resume-${batchId3}`).count()) > 0, 30_000);
    const pausedText = (await jobsWin.getByTestId(`computejobs-batch-paused-${batchId3}`).textContent()) ?? "";
    check(/一時停止/.test(pausedText) && /計算機に届かない/.test(pausedText), "窓に『一時停止: 計算機に届かない』", pausedText);
    await jobsWin.screenshot({ path: path.join(OUT_DIR, "ui-04-paused.png") });
    await waitFor("一時停止の間は眠り止めが外れる", async () => (await page.getByTestId("statusbar-keep-awake").count()) === 0, 20_000);
    check(true, "一時停止の間は眠り止めの表示が出ない（動いていないので眠ってよい）");
    const stP = (await batchState()) as Row;
    check(stP?.outcome?.paused === true, "プラグインの runBatch は paused:true で返る（固まらない）", stP?.outcome);

    jupyter = await startJupyter(python, jPort, jToken, jRoot); // 計算機が戻る
    await jobsWin.getByTestId(`computejobs-batch-resume-${batchId3}`).click();
    await waitFor("残りが完了する", async () => {
      const r = (await newRows()).filter((j) => j.batchId === batchId3);
      return r.length === 3 && r.every((j) => ["DONE", "FAILED", "CANCELLED", "INTERRUPTED"].includes(j.state));
    }, 180_000);
    const r3b = (await newRows()).filter((j) => j.batchId === batchId3);
    check(r3b.find((j) => j.itemKey === "q2")?.state === "DONE" && r3b.find((j) => j.itemKey === "q3")?.state === "DONE", "再開で残りの 2 組が完了（入力を捨てていない）", r3b.map((j) => [j.itemKey, j.state]));
    check(r3b.find((j) => j.itemKey === "q1")?.state === "FAILED", "失敗した q1 は再開でもやり直さない（再実行は別の操作）");
    await jobsWin.screenshot({ path: path.join(OUT_DIR, "ui-05-resumed.png") });
    for (const j of r3b) known.add(j.id);

    // ── [4] 画面を作り直して attach ──
    console.log("\n[4] 画面を閉じても計算は続き、attach で受け取れる");
    const keys4 = ["r1", "r2"];
    await launch({ endpointId: ENDPOINT_ID, script: scriptOf(cnt("c4.txt"), 1, null), items: itemsOf(keys4) }); // collect しない
    const w3 = await consentWindow(driver);
    await w3.getByTestId("consent-ack").check();
    await w3.getByTestId("consent-send").click();
    await waitFor("一括が投入される", async () => (await newRows()).filter((j) => j.batchId).length === 2, 60_000);
    await page.reload({ waitUntil: "domcontentloaded" }); // プラグインの画面（受け取る側）を作り直す
    await page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    await waitFor("計算が続いて終わる", async () => {
      const r = (await newRows()).filter((j) => j.batchId);
      return r.length === 2 && r.every((j) => j.state === "DONE");
    }, 120_000);
    const r4 = (await newRows()).filter((j) => j.batchId);
    const batchId4 = r4[0].batchId as string;
    check(r4.every((j) => j.collectedAt == null), "（前提）画面を作り直した間に終わった結果は、まだ受け取られていない");
    await launch({ attachBatchId: batchId4, collect: true });
    await waitFor("attach で 2 組を受け取る", async () => ((await batchState())?.items?.length ?? 0) === 2 && !!(await batchState())?.outcome, 60_000);
    const st4 = (await batchState()) as Row;
    check((st4.items as Row[]).map((i) => i.key).sort().join(",") === keys4.join(","), "attach で未受け取りの 2 組が届いた", (st4.items as Row[]).map((i) => i.key));
    check((st4.items as Row[]).every((i) => i.ok && i.summary?.sha256), "届いた結果の中身（summary.json）が読める");
    await waitFor("窓に『受け取り済み』", async () => (await jobsWin.locator("[data-testid^=computejobs-collected-]").count()) >= 2, 20_000);
    check(true, "markCollected で窓の行が『受け取り済み』になる");
    await jobsWin.screenshot({ path: path.join(OUT_DIR, "ui-06-collected.png") });
    await launch({ attachBatchId: batchId4, collect: true });
    await waitFor("2 回目の attach が返る", async () => !!(await batchState())?.outcome, 60_000);
    const st4b = (await batchState()) as Row;
    check((st4b.items as Row[]).length === 0 && st4b.outcome?.ok === true, "🔴 受け取り済みの組は 2 回目の attach で届かない（先に 1 回目で届いたことを確認済み）");
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
