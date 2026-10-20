/*
 * 計算ジョブの台帳と計算機ごとの待ち行列（H59 runJob の外側）の実機検証（段 1: backend。窓は段 2）。
 *
 * 実行:  cd backend && mvn -q -Dfrontend.skip=true -DskipTests clean package
 *        cd automator && GRAPHY_JUPYTER_PYTHON=C:\...\anaconda3\python.exe npx tsx src/spike/computeJobsCheck.ts
 *
 * 本物の Electron ＋ backend jar ＋ jupyter_server で、プラグイン（compute-runjob-check）から runJob を何本か投げ、
 * 台帳の REST（/api/compute/jobs）を観察する:
 *   [1] 1 本: 待ち → 実行中 → 完了と移り、環境・後始末・プラグインの素性が台帳にある
 *   [2] 同じ計算機へ 3 本: 2 本目は待ち・3 本目を待ちのまま中止すると計算機へ 1 回も送らない・カーネルは同時に増えない
 *   [3] わざと落ちるコード: code-error と traceback の全文
 *   [4] 実行中の中止: INTERRUPT_GRACE＋ポーリング以内に CANCELLED・計算機に何も残らない
 *   [5] 患者名・患者 ID が台帳（H2 の 2 表）・ジョブのフォルダに 0 件（先に、同じ検索が保管庫の表では見つけることを確かめる）
 *   [6] backend を実行中に落として起動し直す → 「再起動で中断」・接続先の登録で計算機の作業フォルダが消える
 *   [7] web プロファイルでは /api/compute/jobs が 404
 * 未達: 窓・状態バー（段 2）、Colab、macOS/Linux。
 */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";

import { DesktopDriver, DESKTOP_RUN_DATA_DIR } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importFixtureCategory } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { consentWindow, createChecker, launchRunJobPlugin as launchPlugin } from "./computeSpikeShared.js";

const { check, summary } = createChecker();

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "compute-jobs-check");
const PLUGIN_ID = "compute-runjob-check";
const ENDPOINT_ID = "automator-jobs";
const AUDIT = path.join(DESKTOP_RUN_DATA_DIR, "compute-audit.jsonl");
const JAR = path.join(AUTOMATOR_ROOT, "..", "backend", "target", "graphy-next-backend.jar");
const H2_JAR = path.join(os.homedir(), ".m2", "repository", "com", "h2database", "h2", "2.2.224", "h2-2.2.224.jar");

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
    await sleep(100);
  }
  throw new Error(`待っても起きなかった: ${what}`);
}

async function main(): Promise<void> {
  const python = process.env.GRAPHY_JUPYTER_PYTHON;
  if (!python || !fs.existsSync(python)) throw new Error("GRAPHY_JUPYTER_PYTHON を設定してください");
  if (!fs.existsSync(JAR)) throw new Error("backend jar がありません: " + JAR);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const dst = path.join(DESKTOP_RUN_DATA_DIR, "plugins", PLUGIN_ID);
  fs.mkdirSync(dst, { recursive: true });
  for (const n of ["plugin.json", "ui.js"]) fs.copyFileSync(path.join(AUTOMATOR_ROOT, "plugins", PLUGIN_ID, n), path.join(dst, n));
  fs.rmSync(AUDIT, { force: true });

  const jPort = await freePort();
  const jToken = crypto.randomBytes(16).toString("hex");
  const jRoot = fs.mkdtempSync(path.join(OUT_DIR, "jroot-"));
  const jupyter = await startJupyter(python, jPort, jToken, jRoot);
  const jBase = `http://127.0.0.1:${jPort}`;
  const kernelCount = async (): Promise<number> => {
    for (let i = 0; i < 20; i++) {
      const r = await fetch(`${jBase}/api/kernels`, { headers: { Authorization: `token ${jToken}` } });
      if (r.ok) return ((await r.json()) as unknown[]).length;
      await sleep(100); // 起動の最中は 500 を返すことがある
    }
    throw new Error("kernel list failed");
  };
  const remoteLeft = (): string[] => {
    const left: string[] = [];
    const walk = (d: string) => {
      if (!fs.existsSync(d)) return;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else left.push(path.relative(jRoot, p));
      }
    };
    walk(path.join(jRoot, "graphy"));
    return left;
  };

  const driver = new DesktopDriver();
  const procs: ChildProcess[] = [];
  let endpointsFile: string | null = null;
  let endpointsBackup: string | null = null;
  try {
    await driver.start();
    const page = driver.page;
    page.on("console", (m) => {
      if (m.type() === "error") console.log(`  [renderer error] ${m.text()}`);
    });
    await resetDb(driver.ports.http);
    await importFixtureCategory(driver.ports.http, "ct-basic");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    const cwd = await driver.app.evaluate(({ dialog }) => {
      dialog.showMessageBoxSync = (() => 0) as typeof dialog.showMessageBoxSync;
      return process.cwd();
    });
    endpointsFile = path.join(cwd, "compute-endpoints.json");
    endpointsBackup = fs.existsSync(endpointsFile) ? fs.readFileSync(endpointsFile, "utf8") : null;
    const reg = await page.evaluate(
      async ({ id, url, token }) => {
        const d = (window as unknown as { graphyDesktop: any }).graphyDesktop;
        const a = await d.computeEndpointsSet({ endpoints: [{ id, label: "Local Jupyter", url }] });
        const b = await d.secretSet(`compute.endpoint.${id}.token`, token);
        return { a, b };
      },
      { id: ENDPOINT_ID, url: `${jBase}/`, token: jToken },
    );
    if (!reg.a.ok || !reg.b.ok) throw new Error("接続先を登録できません: " + JSON.stringify(reg));

    const base = `http://localhost:${driver.ports.http}`;
    const jobs = async (): Promise<Row[]> => (await (await fetch(`${base}/api/compute/jobs`)).json()) as Row[];
    const jobBy = async (id: string): Promise<Row> => (await (await fetch(`${base}/api/compute/jobs/${id}`)).json()) as Row;
    const studies = (await (await fetch(`${base}/api/studies`)).json()) as { studyInstanceUid: string; patientName: string; patientId: string }[];
    const study = studies[0];
    const series = (await (await fetch(`${base}/api/studies/${study.studyInstanceUid}/series`)).json()) as {
      seriesInstanceUid: string; modality: string;
    }[];
    const ct = series.find((s) => s.modality === "CT") ?? series[0];

    /** プラグインを起動して同意の窓で「送信する」。投げた行（台帳）の id を返す。 */
    // 前回までの行（台帳は resetDb では消えない）は数えない
    const known = new Set<string>((await jobs()).map((j) => j.id));
    const launch = async (script?: string): Promise<{ run: number; row: Row }> => {
      const run = await page.evaluate(() => ((window as unknown as { __computeRuns?: unknown[] }).__computeRuns ?? []).length);
      await launchPlugin(page, { studyUid: study.studyInstanceUid, seriesUid: ct.seriesInstanceUid, endpointId: ENDPOINT_ID, ...(script ? { script } : {}) });
      const win = await consentWindow(driver);
      await win.getByTestId("consent-ack").check();
      await win.getByTestId("consent-send").click();
      const row = await waitFor("台帳に行が増える", async () => (await jobs()).find((j) => !known.has(j.id)));
      known.add(row.id);
      return { run, row };
    };
    const outcomeOf = async (run: number, timeoutMs = 180_000): Promise<Row> => {
      await page.waitForFunction((i) => !!(window as unknown as { __computeRuns: Row[] }).__computeRuns?.[i]?.outcome, run, { timeout: timeoutMs });
      return page.evaluate((i) => (window as unknown as { __computeRuns: Row[] }).__computeRuns[i], run);
    };
    const events = (): Row[] => fs.readFileSync(AUDIT, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const uploadsOf = (requestId: string) => events().filter((e) => e.event === "compute-uploaded" && e.requestId === requestId).length;

    // ── [1] 1 本 ──
    console.log("\n[1] 1 本の runJob");
    const seen: string[] = [];
    const first = await launch();
    let stop = false;
    const watcher = (async () => {
      while (!stop) {
        const st = (await jobBy(first.row.id)).state as string;
        if (seen[seen.length - 1] !== st) seen.push(st);
        await sleep(80);
      }
    })();
    const out1 = await outcomeOf(first.run);
    await sleep(500);
    stop = true;
    await watcher;
    const j1 = await jobBy(first.row.id);
    fs.writeFileSync(path.join(OUT_DIR, "row-1.json"), JSON.stringify(j1, null, 2));
    check(out1.outcome.ok === true && out1.outcome.status === "ok", "プラグインに結果が返る（H59 は今のまま）", out1.outcome.error);
    check(seen.includes("RUNNING") && seen[seen.length - 1] === "DONE", "状態が実行中 → 完了と移る", seen);
    check(j1.pluginId === PLUGIN_ID && !!j1.pluginName && j1.endpointId === ENDPOINT_ID && j1.codeSha256?.length === 64, "プラグイン・計算機・コードの SHA-256 が台帳にある", { p: j1.pluginId, e: j1.endpointId });
    check(j1.progress === 1 && j1.remoteCleanup === "ok", "進み具合 1・計算機の作業フォルダの後始末 ok", { progress: j1.progress, c: j1.remoteCleanup });
    check(!!j1.env?.python, "計算機の環境（Python）が台帳にある", j1.env);
    check(j1.requestId?.startsWith("egr_") && j1.outputsBytes > 0, "監査ログへのつなぎ（requestId）と結果の大きさ", { r: j1.requestId, b: j1.outputsBytes });
    const log1 = await (await fetch(`${base}/api/compute/jobs/${j1.id}/log/stdout`)).text();
    check(log1.includes("shape ("), "stdout の全文が取れる", log1.slice(0, 80));
    check(remoteLeft().length === 0, "🔴 計算機にファイルが何も残らない", remoteLeft());

    // ── [2] 同じ計算機へ 3 本 ──
    console.log("\n[2] 同じ計算機へ 3 本（待ち・待ちの中止・カーネル）");
    const a = await launch("import time\nprint('__progress__', 0.3, 'a')\ntime.sleep(25)\nprint('a done')");
    await waitFor("A が実行中", async () => (await jobBy(a.row.id)).state === "RUNNING");
    const b = await launch("print('b done')");
    check((await jobBy(b.row.id)).state === "QUEUED", "2 本目は 1 本目が終わるまで「待ち」", (await jobBy(b.row.id)).state);
    const c = await launch("print('c never')");
    check((await jobBy(c.row.id)).state === "QUEUED", "3 本目も「待ち」");
    const cancelC = await fetch(`${base}/api/compute/jobs/${c.row.id}/cancel`, { method: "POST" });
    const cRow = await jobBy(c.row.id);
    check(cancelC.status === 202 && cRow.state === "CANCELLED", "待ちのジョブを窓の中止で止めると、その場で「中止」", { st: cancelC.status, state: cRow.state });
    let maxKernels = 0;
    while (!["DONE", "FAILED", "CANCELLED"].includes((await jobBy(b.row.id)).state)) {
      maxKernels = Math.max(maxKernels, await kernelCount());
      await sleep(150);
    }
    const aEnd = await jobBy(a.row.id);
    const bEnd = await jobBy(b.row.id);
    check(aEnd.state === "DONE" && bEnd.state === "DONE", "A・B は完了", { a: aEnd.state, b: bEnd.state });
    check(maxKernels <= 1, "🔴 計算機のカーネルが同時に 2 つ立たない", maxKernels);
    check(new Date(bEnd.startedAt) >= new Date(aEnd.finishedAt), "🔴 B は A が終わってから始まる", { aEnd: aEnd.finishedAt, bStart: bEnd.startedAt });
    check(uploadsOf(cRow.requestId) === 0, "🔴 待ちのうちに中止した C は計算機へ 1 回もアップロードしていない", uploadsOf(cRow.requestId));
    check(uploadsOf(aEnd.requestId) === 1 && uploadsOf(bEnd.requestId) === 1, "（対照）A・B は 1 回ずつアップロード");
    check(events().some((e) => e.event === "compute-job-cancelled" && e.requestId === cRow.requestId), "監査: compute-job-cancelled");
    const cOut = await outcomeOf(c.run, 30_000);
    check(cOut.outcome.ok === false, "プラグインには中止として返る", cOut.outcome);

    // ── [3] わざと落ちる ──
    console.log("\n[3] コードのエラー");
    const f = await launch("import numpy as np\nraise ValueError('boom from code')");
    await outcomeOf(f.run, 120_000);
    const fRow = await jobBy(f.row.id);
    check(fRow.state === "FAILED" && fRow.reason === "code-error" && fRow.errorName === "ValueError" && fRow.errorValue === "boom from code", "FAILED / code-error / ValueError / 値", fRow);
    const tb = await (await fetch(`${base}/api/compute/jobs/${f.row.id}/log/traceback`)).text();
    check(tb.includes("ValueError") && tb.includes("boom from code"), "traceback の全文が取れる", tb.slice(0, 120));

    // ── [4] 実行中の中止 ──
    console.log("\n[4] 実行中の中止");
    const r = await launch("import time\nfor i in range(600):\n    print('__progress__', i / 600, 'loop')\n    time.sleep(0.1)");
    await waitFor("実行中で進んでいる", async () => {
      const j = await jobBy(r.row.id);
      return j.state === "RUNNING" && j.progress > 0.2;
    });
    check((await kernelCount()) >= 1 && remoteLeft().length > 0, "（前提）中止の前は計算機にカーネルと作業ファイルがある");
    const t0 = Date.now();
    await fetch(`${base}/api/compute/jobs/${r.row.id}/cancel`, { method: "POST" });
    await waitFor("中止になる", async () => (await jobBy(r.row.id)).state === "CANCELLED", 30_000);
    const took = Date.now() - t0;
    check(took < 10_000 + 3_000, "INTERRUPT_GRACE（10 秒）＋ポーリング 1 回以内に「中止」", `${took} ms`);
    await sleep(500);
    check((await kernelCount()) === 0, "🔴 計算機にそのカーネルが無い", await kernelCount());
    check(remoteLeft().length === 0, "🔴 作業フォルダにファイルが 1 つも残らない", remoteLeft());
    check((await jobBy(r.row.id)).remoteCleanup === "ok", "後始末 ok が台帳にある");
    const done409 = await fetch(`${base}/api/compute/jobs/${r.row.id}/cancel`, { method: "POST" });
    check(done409.status === 409, "終わった行の中止は 409", done409.status);

    // ── [5] 患者情報 ──
    console.log("\n[5] 患者名・患者 ID が台帳に無い");
    const dataDir = path.join(DESKTOP_RUN_DATA_DIR, "data");
    const h2 = (sql: string): string => {
      const res = spawnSync("java", ["-cp", H2_JAR, "org.h2.tools.Shell", "-url",
        `jdbc:h2:file:${path.join(DESKTOP_RUN_DATA_DIR, "data", "graphy-index").replace(/\\/g, "/")};AUTO_SERVER=TRUE`,
        "-user", "sa", "-password", "", "-sql", sql], { encoding: "utf8" });
      return (res.stdout ?? "") + (res.stderr ?? "");
    };
    const dicomDump = h2("SELECT * FROM dicom_instance");
    check(dicomDump.includes(study.patientId) || dicomDump.includes(study.patientName), "（前提）同じ検索が保管庫の表では患者名・患者 ID を見つける", dicomDump.slice(0, 200));
    const ledgerDump = h2("SELECT * FROM compute_batch") + h2("SELECT * FROM compute_job");
    check(ledgerDump.includes("COMPUTE_JOB") || ledgerDump.includes(PLUGIN_ID), "（前提）台帳の 2 表が読めている", ledgerDump.slice(0, 200));
    check(!ledgerDump.includes(study.patientId) && !ledgerDump.includes(study.patientName), "🔴 台帳の 2 表の全列に患者名・患者 ID が 0 件");
    let folderText = "";
    const walkJobs = (d: string) => {
      for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walkJobs(p);
        else if (!p.endsWith(".zip")) folderText += fs.readFileSync(p, "utf8");
      }
    };
    walkJobs(path.join(DESKTOP_RUN_DATA_DIR, "compute-jobs"));
    check(folderText.length > 0 && !folderText.includes(study.patientId) && !folderText.includes(study.patientName), "🔴 compute-jobs/ のログに患者名・患者 ID が 0 件", folderText.length);
    const apiText = JSON.stringify(await jobs());
    check(!apiText.includes(study.patientId) && !apiText.includes(study.patientName), "🔴 REST の応答にも患者名・患者 ID が無い");
    void dataDir;

    // ── [6] backend を落として起動し直す ──
    console.log("\n[6] 実行中に backend を落とす → 起動し直す");
    const long = await launch("import time\nfor i in range(1200):\n    print('__progress__', i / 1200, 'loop')\n    time.sleep(0.1)");
    await waitFor("実行中でデータが届いている", async () => {
      const j = await jobBy(long.row.id);
      return j.state === "RUNNING" && j.progress > 0.2;
    });
    const leftBefore = remoteLeft();
    await driver.stop();
    check(leftBefore.length > 0, "（前提）落とした時点で計算機に作業ファイルがある", leftBefore);
    const secret = crypto.randomBytes(32).toString("hex");
    const b2Port = await freePort();
    const startBackend = async (profile: string, port: number): Promise<ChildProcess> => {
      const scp = await freePort();
      const p = spawn("java", [
        "--add-opens", "java.base/java.io=ALL-UNNAMED", "--add-opens", "java.desktop/javax.imageio.stream=ALL-UNNAMED",
        "-jar", JAR, `--spring.profiles.active=${profile}`, `--server.port=${port}`, `--graphy.dicom.scp.port=${scp}`,
      ], { cwd: DESKTOP_RUN_DATA_DIR, stdio: "ignore", env: { ...process.env, GRAPHY_MAIN_SECRET: secret } });
      procs.push(p);
      return p;
    };
    await startBackend("standalone", b2Port);
    const b2 = `http://localhost:${b2Port}`;
    await waitFor("新しい backend が応答", async () => {
      try {
        return (await fetch(`${b2}/api/status`)).ok;
      } catch {
        return false;
      }
    }, 90_000);
    // 起動の回復は ApplicationReadyEvent で走る（status が応答してもまだのことがある）ので、中断になるまで待つ
    const longRow = await waitFor("再起動で中断になる", async () => {
      const j = (await (await fetch(`${b2}/api/compute/jobs/${long.row.id}`)).json()) as Row;
      return j.state === "INTERRUPTED" ? j : null;
    }, 30_000);
    check(longRow.state === "INTERRUPTED" && longRow.reason === "interrupted", "履歴の行が残り、実行中だったものは「再起動で中断」", { s: longRow.state, r: longRow.reason });
    check(longRow.remoteCleanup === "pending", "計算機の後始末は「待ち」", longRow.remoteCleanup);
    const put = await fetch(`${b2}/api/internal/compute/endpoints`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ endpoints: [{ id: ENDPOINT_ID, label: "Local Jupyter", url: `${jBase}/`, token: jToken, kind: "jupyter" }] }),
    });
    check(put.ok, "接続先を登録し直す", put.status);
    const cleaned = await waitFor("後始末が済む", async () => {
      const j = (await (await fetch(`${b2}/api/compute/jobs/${long.row.id}`)).json()) as Row;
      return j.remoteCleanup === "ok" ? j : null;
    }, 30_000);
    check(!!cleaned, "後始末が済んだと台帳に出る（remote-cleanup）");
    await sleep(500);
    check(remoteLeft().length === 0, "🔴 接続先の登録し直しの後、計算機の作業ファイルが消えている", remoteLeft());
    check(events().some((e) => e.event === "compute-remote-cleanup" && e.result === "ok"), "監査: compute-remote-cleanup");
    check((await kernelCount()) === 0, "🔴 落とした backend が起動したカーネル（コードは走り続けていた）も止まっている", await kernelCount());

    // ── [7] web プロファイル ──
    console.log("\n[7] web プロファイルでは 404");
    const wPort = await freePort();
    await startBackend("web", wPort);
    const wBase = `http://localhost:${wPort}`;
    await waitFor("web の backend が応答", async () => {
      try {
        return (await fetch(`${wBase}/api/status`)).ok;
      } catch {
        return false;
      }
    }, 90_000);
    const w = await fetch(`${wBase}/api/compute/jobs`);
    check(w.status === 404 || w.status === 501, "web では /api/compute/jobs が 404 か 501", w.status);
  } finally {
    await driver.stop().catch(() => undefined);
    for (const p of procs) p.kill();
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
