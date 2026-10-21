/*
 * 計算ジョブの窓・メニュー・状態バー（段 2: frontend＋desktop）の実機検証。
 *
 * 実行:  cd backend && mvn -q -Dfrontend.skip=true -DskipTests clean package   （backend jar）
 *        cd automator && GRAPHY_JUPYTER_PYTHON=C:\...\anaconda3\python.exe npx tsx src/spike/computeJobsWindowCheck.ts
 *
 * 本物の Electron ＋ backend jar ＋ jupyter_server で、プラグイン（compute-runjob-check）から runJob を投げ、
 * システム ＞「計算ジョブ…」の別窓と、メイン画面の状態バーを画面で見る（スクリーンショットは .results/compute-jobs-window-check）:
 *   [1] メニューから別窓が開く（再度押しても 1 枚）
 *   [2] 2 本続けて投げる → 1 本目は実行中（進み具合の棒）・2 本目は待ち → どちらも完了
 *   [3] 状態バーの数と窓の数が一致し、状態バーを押すと窓が前に出る
 *   [4] わざと落とす（OutOfMemoryError）→ 理由「コードのエラー: OutOfMemoryError」・stderr/traceback の全文・
 *       開くと状態バーの失敗が 1 減る（確認済み）
 *   [5] 実行中のジョブを窓の［中止］で止める → 「中止」
 *   [6] 窓を閉じても計算は続き、開き直すと完了の行がある
 *   [7] 患者名が窓に出る・［この行を消す］で行と台帳から消える
 * 未達（このスパイクでは確かめない）: web モードでメニュー・状態バーが出ないこと、Colab、macOS/Linux、AWAITING_USER。
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
import { consentWindow, createChecker, launchRunJobPlugin as launchPlugin } from "./computeSpikeShared.js";

const { check, summary } = createChecker();

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "compute-jobs-window-check");
const PLUGIN_ID = "compute-runjob-check";
const ENDPOINT_ID = "automator-jobs-window";

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

  const jPort = await freePort();
  const jToken = crypto.randomBytes(16).toString("hex");
  const jRoot = fs.mkdtempSync(path.join(OUT_DIR, "jroot-"));
  const jupyter = await startJupyter(python, jPort, jToken, jRoot);
  const jBase = `http://127.0.0.1:${jPort}`;

  const driver = new DesktopDriver();
  let endpointsFile: string | null = null;
  let endpointsBackup: string | null = null;
  try {
    await driver.start();
    const page = driver.page;
    page.on("console", (m) => {
      if (m.type() === "error") console.log(`  [renderer error] ${m.text()} ${m.location().url}`);
    });
    await resetDb(driver.ports.http);
    await importFixtureCategory(driver.ports.http, "ct-basic");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
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
      { id: ENDPOINT_ID, url: `${jBase}/`, token: jToken },
    );
    if (!reg.a.ok || !reg.b.ok) throw new Error("接続先を登録できません: " + JSON.stringify(reg));

    const base = `http://localhost:${driver.ports.http}`;
    const jobs = async (): Promise<Row[]> => (await (await fetch(`${base}/api/compute/jobs`)).json()) as Row[];
    const jobBy = async (id: string): Promise<Row> => (await (await fetch(`${base}/api/compute/jobs/${id}`)).json()) as Row;
    const studies = (await (await fetch(`${base}/api/studies`)).json()) as { studyInstanceUid: string; patientName: string | null }[];
    const study = studies[0];
    const series = (await (await fetch(`${base}/api/studies/${study.studyInstanceUid}/series`)).json()) as {
      seriesInstanceUid: string; modality: string;
    }[];
    const ct = series.find((s) => s.modality === "CT") ?? series[0];

    const known = new Set<string>((await jobs()).map((j) => j.id));
    const launch = async (script?: string): Promise<Row> => {
      await launchPlugin(page, { studyUid: study.studyInstanceUid, seriesUid: ct.seriesInstanceUid, endpointId: ENDPOINT_ID, ...(script ? { script } : {}) });
      const win = await consentWindow(driver);
      await win.getByTestId("consent-ack").check();
      await win.getByTestId("consent-send").click();
      const row = await waitFor("台帳に行が増える", async () => (await jobs()).find((j) => !known.has(j.id)));
      known.add(row.id);
      return row;
    };
    const openWindow = (): Promise<Page> =>
      driver.waitForNewPage(async () => {
        await page.getByTestId("mainscreen-menu-system").click();
        await page.getByTestId("menu-item-compute-jobs").click();
      }, (url) => url.includes("#computejobs"));
    const statusText = async (w: Page, id: string) => (await w.getByTestId(`computejobs-status-${id}`).textContent()) ?? "";
    const windows = () => driver.app.windows().filter((w) => w.url().includes("#computejobs"));

    // ── [1] メニューから別窓 ──
    console.log("\n[1] メニュー ＞ システム ＞ 計算ジョブ…");
    let win = await openWindow();
    await win.getByTestId("computejobs-screen").waitFor({ state: "visible", timeout: 20_000 });
    check(windows().length === 1, "別窓が 1 枚開く");
    await page.getByTestId("mainscreen-menu-system").click();
    await page.getByTestId("menu-item-compute-jobs").click();
    await sleep(1500);
    check(windows().length === 1, "もう一度押しても窓は増えない（シングルトン）", windows().length);
    await win.getByTestId("computejobs-endpoint-" + ENDPOINT_ID).waitFor({ state: "visible", timeout: 15_000 });
    check(true, "計算機の帯に登録した計算機が出る");

    // ── [2] 2 本続けて ──
    console.log("\n[2] 実行中と待ち");
    const a = await launch("import time\nfor i in range(25):\n    print('__progress__', i / 25, 'a')\n    time.sleep(1)\nprint('a done')");
    const aRow = win.getByTestId(`computejobs-row-${a.id}`);
    await aRow.waitFor({ state: "visible", timeout: 30_000 });
    await waitFor("A が実行中の表示", async () => (await statusText(win, a.id)).includes("実行中"));
    const b = await launch("print('b done')");
    await waitFor("B の行", async () => (await win.getByTestId(`computejobs-row-${b.id}`).count()) > 0);
    const bText = await statusText(win, b.id);
    check(bText.includes("待ち"), "2 本目は「待ち」と画面に出る", bText);
    await waitFor("進み具合の % が出る", async () => /\d+%/.test(await statusText(win, a.id)));
    check(/\d+%/.test(await statusText(win, a.id)), "1 本目に進み具合（%）が出る", await statusText(win, a.id));
    await win.screenshot({ path: path.join(OUT_DIR, "ui-01-running-queued.png") });

    // ── [3] 状態バーと窓の数 ──
    console.log("\n[3] 状態バー");
    const bar = page.getByTestId("statusbar-compute-jobs");
    await bar.waitFor({ state: "visible", timeout: 15_000 });
    const countsOf = async () => ({
      win: ((await win.getByTestId("computejobs-counts").textContent()) ?? "").replace(/\s/g, ""),
      // 数えるものが無いときは状態バーの欄ごと消える（= 失敗 0・実行中 0・待ち 0）
      bar: (await bar.count()) === 0 ? "" : ((await bar.textContent()) ?? "").replace(/\s/g, ""),
    });
    await waitFor("状態バーと窓の数が一致", async () => {
      const c = await countsOf();
      return c.win === c.bar;
    }, 15_000);
    const c1 = await countsOf();
    check(c1.win === c1.bar && /実行中[1-9]/.test(c1.bar) && /待ち[1-9]/.test(c1.bar), "状態バーの数が窓の数と一致（実行中・待ちとも 1 以上）", c1);
    await page.screenshot({ path: path.join(OUT_DIR, "ui-02-statusbar.png") });
    await page.bringToFront();
    await bar.click();
    await sleep(800);
    check(windows().length === 1, "状態バーを押しても窓は 1 枚のまま（前に出る）", windows().length);
    await waitFor("A・B が完了", async () => (await statusText(win, a.id)).includes("完了") && (await statusText(win, b.id)).includes("完了"), 120_000);
    check(true, "A・B とも画面で「完了」になる");
    const aEnd = await jobBy(a.id);
    const bEnd = await jobBy(b.id);
    check(new Date(bEnd.startedAt) >= new Date(aEnd.finishedAt), "（対照）B は A が終わってから始まった", { aEnd: aEnd.finishedAt, bStart: bEnd.startedAt });

    // ── [4] 失敗 ──
    console.log("\n[4] 失敗の理由とログ・確認済み");
    const f = await launch("class OutOfMemoryError(RuntimeError):\n    pass\nraise OutOfMemoryError('CUDA out of memory')");
    await waitFor("F が失敗の表示", async () => (await win.getByTestId(`computejobs-status-${f.id}`).count()) > 0 && (await statusText(win, f.id)).includes("失敗"), 90_000);
    const fText = await statusText(win, f.id);
    check(fText.includes("コードのエラー") && fText.includes("OutOfMemoryError"), "行に「コードのエラー: OutOfMemoryError」", fText);
    const failedOf = (s: string) => Number(/失敗(\d+)/.exec(s)?.[1] ?? 0);
    await waitFor("状態バーの失敗に反映", async () => {
      const c = await countsOf();
      return failedOf(c.bar) >= 1 && failedOf(c.win) === failedOf(c.bar);
    }, 15_000);
    const before = failedOf((await countsOf()).bar);
    await win.getByTestId(`computejobs-row-${f.id}`).click();
    await win.getByTestId("computejobs-detail").waitFor({ state: "visible", timeout: 10_000 });
    await win.getByTestId("computejobs-log-traceback").click();
    await waitFor("traceback が出る", async () => ((await win.getByTestId("computejobs-log-text").textContent()) ?? "").includes("OutOfMemoryError"));
    check(true, "traceback の全文が窓に出る");
    await win.getByTestId("computejobs-log-stderr").click();
    // Python の例外は traceback に入り、stderr は空のことがある。REST が返す中身と窓の表示が一致することを見る。
    const errRes = await fetch(`${base}/api/compute/jobs/${f.id}/log/stderr`);
    const errBody = errRes.ok ? await errRes.text() : null;
    if (errBody) {
      await waitFor("stderr が出る", async () => ((await win.getByTestId("computejobs-log-text").textContent()) ?? "").includes(errBody.slice(0, 20)));
    } else {
      try {
        await waitFor("stderr が無いと出る", async () => ((await win.getByTestId("computejobs-log-text").textContent()) ?? "").includes("ログはありません"), 15_000);
      } catch (e) {
        console.log("  [debug] log-text =", JSON.stringify(((await win.getByTestId("computejobs-log-text").textContent().catch(() => null)) ?? "").slice(0, 200)), "disabled?", await win.getByTestId("computejobs-log-stderr").isDisabled());
        throw e;
      }
    }
    check(true, "stderr の表示が REST の中身と一致（無ければ「ログはありません」）", { status: errRes.status, len: errBody?.length ?? 0 });
    const reasonText = (await win.getByTestId("computejobs-detail-reason").textContent()) ?? "";
    check(reasonText.includes("コードのエラー"), "詳細に理由が出る", reasonText);
    await win.screenshot({ path: path.join(OUT_DIR, "ui-03-failed-detail.png") });
    await waitFor("開いた失敗は確認済みとして状態バーから減る", async () => {
      return failedOf((await countsOf()).bar) === before - 1;
    }, 15_000);
    const afterBar = (await countsOf()).bar;
    check(failedOf(afterBar) === before - 1, "🔴 開いた失敗は状態バーの失敗数から 1 減る（他は変わらない）", { before, afterBar });

    // ── [5] 実行中の中止 ──
    console.log("\n[5] 窓の［中止］");
    const r = await launch("import time\nfor i in range(600):\n    print('__progress__', i / 600, 'loop')\n    time.sleep(0.1)");
    await waitFor("R が実行中", async () => (await win.getByTestId(`computejobs-status-${r.id}`).count()) > 0 && (await statusText(win, r.id)).includes("実行中"), 60_000);
    await win.getByTestId(`computejobs-cancel-${r.id}`).click();
    await waitFor("画面が「中止」になる", async () => (await statusText(win, r.id)).includes("中止"), 30_000);
    check((await jobBy(r.id)).state === "CANCELLED", "画面の［中止］で台帳も CANCELLED", (await jobBy(r.id)).state);
    await win.screenshot({ path: path.join(OUT_DIR, "ui-04-cancelled.png") });

    // ── [6] 窓を閉じても続く ──
    console.log("\n[6] 窓を閉じても計算は続く");
    const x = await launch("import time\nfor i in range(12):\n    print('__progress__', i / 12, 'x')\n    time.sleep(1)\nprint('x done')");
    await waitFor("X が実行中", async () => (await jobBy(x.id)).state === "RUNNING");
    await win.close();
    await sleep(500);
    check(windows().length === 0, "窓を閉じた");
    await waitFor("閉じている間に X が完了", async () => (await jobBy(x.id)).state === "DONE", 120_000);
    check(true, "窓を閉じていても X は完了した（台帳）");
    win = await openWindow();
    await win.getByTestId(`computejobs-row-${x.id}`).waitFor({ state: "visible", timeout: 20_000 });
    check((await statusText(win, x.id)).includes("完了"), "開き直すと X が「完了」で並ぶ", await statusText(win, x.id));

    // ── [7] 患者名・行を消す ──
    console.log("\n[7] 患者名・行を消す");
    if (study.patientName) {
      await waitFor("患者名が出る", async () => ((await win.getByTestId(`computejobs-row-${x.id}`).textContent()) ?? "").includes(study.patientName as string), 15_000);
      check(true, "行に患者名が出る（保管庫から引く）");
    } else {
      console.log("  [skip] 取り込んだ検査に患者名が無い（未達）");
    }
    await win.getByTestId(`computejobs-delete-${x.id}`).click();
    await waitFor("行が消える", async () => (await win.getByTestId(`computejobs-row-${x.id}`).count()) === 0, 15_000);
    const gone = await fetch(`${base}/api/compute/jobs/${x.id}`);
    check(gone.status === 404, "［この行を消す］で台帳からも消える", gone.status);
    await win.screenshot({ path: path.join(OUT_DIR, "ui-05-final.png") });
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
