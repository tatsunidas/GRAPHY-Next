/*
 * H59 host.compute.runJob の実機検証（通し）。設計: fw/remote-compute-design.md（段 5）。
 *
 * 実行:  cd automator && GRAPHY_JUPYTER_PYTHON=C:\...\anaconda3\python.exe npx tsx src/spike/computeRunJobCheck.ts
 *
 * 本物の Electron ＋ 本物の backend ＋ 本物の jupyter_server で、プラグインの ui.js から:
 *   1. host.compute.runJob を呼ぶ → 本体が既存の匿名化で npz を作る
 *   2. main の窓で同意（送信する）
 *   3. 計算機へアップロード → 実行 → 進み具合が届く → outputs を回収
 *   4. readFile で mask.npy・summary.json を取り出せる
 *   5. **届いたバイト列の SHA-256 が、同意画面に出た値と一致する**（承認したものがそのまま届いた）
 *   6. 届いた npz に患者名・ID が無い／元の UID が置き換わっている
 *   7. 終わったら計算機に何も残らない（graphy/ が空）・監査ログに送信と終了が残る
 *   8. 同意で取り消すと cancelled が返り、何も送られない
 *
 * 前提: backend jar・fixture ct-basic・jupyter_server の入った python（GRAPHY_JUPYTER_PYTHON）。
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import type { Page } from "@playwright/test";

import { DesktopDriver, DESKTOP_RUN_DATA_DIR } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importFixtureCategory } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "compute-runjob-check");
const PLUGIN_ID = "compute-runjob-check";
const ENDPOINT_ID = "automator-runjob";
const AUDIT = path.join(DESKTOP_RUN_DATA_DIR, "compute-audit.jsonl");

const failures: string[] = [];
let passed = 0;
function check(cond: boolean, label: string, detail?: unknown): void {
  if (cond) {
    passed++;
    console.log(`  [ok  ] ${label}`);
  } else {
    console.log(`  [FAIL] ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
    failures.push(label);
  }
}

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
    await new Promise((r) => setTimeout(r, 300));
  }
  proc.kill();
  throw new Error("jupyter_server did not start");
}

async function consentWindow(driver: DesktopDriver): Promise<Page> {
  const deadline = Date.now() + 60_000; // 匿名化（CT 43 枚）が終わってから開く
  while (Date.now() < deadline) {
    const win = driver.app.windows().find((w) => w.url().endsWith("computeConsent.html"));
    if (win) {
      await win.waitForFunction(() => (document.getElementById("code")?.textContent ?? "").length > 0);
      return win;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("同意の窓が開きません");
}

async function launchPlugin(page: Page, input: Record<string, string>): Promise<void> {
  await page.evaluate((i) => {
    const w = window as unknown as Record<string, unknown>;
    w.__computeInput = i;
    w.__computeRun = undefined;
  }, input);
  await page.getByTestId("mainscreen-menu-plugins").click();
  await page.getByTestId(`plugin-item-${PLUGIN_ID}`).click();
}

async function outcome(page: Page, timeoutMs: number): Promise<any> {
  await page.waitForFunction(
    () => !!(window as unknown as { __computeRun?: { outcome?: unknown } }).__computeRun?.outcome,
    null,
    { timeout: timeoutMs },
  );
  return page.evaluate(() => (window as unknown as { __computeRun: unknown }).__computeRun);
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
  const jupyter = await startJupyter(python, jPort, jToken, jRoot);

  const driver = new DesktopDriver();
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
    await page.reload({ waitUntil: "domcontentloaded" }); // 取り込んだプラグインをメニューに出す
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
      { id: ENDPOINT_ID, url: `http://127.0.0.1:${jPort}/`, token: jToken },
    );
    if (!reg.a.ok || !reg.b.ok) throw new Error("接続先を登録できません: " + JSON.stringify(reg));

    const base = `http://localhost:${driver.ports.http}`;
    const studies = (await (await fetch(`${base}/api/studies`)).json()) as { studyInstanceUid: string; patientName: string; patientId: string }[];
    const study = studies[0];
    const series = (await (await fetch(`${base}/api/studies/${study.studyInstanceUid}/series`)).json()) as {
      seriesInstanceUid: string; modality: string; numberOfInstances: number;
    }[];
    const ct = series.find((s) => s.modality === "CT") ?? series[0];
    const input = { studyUid: study.studyInstanceUid, seriesUid: ct.seriesInstanceUid, endpointId: ENDPOINT_ID };

    // --- 1. 送信する ---
    console.log("\n[1] runJob（送信する）");
    await launchPlugin(page, input);
    const win = await consentWindow(driver);
    // SHA-256 の欄だけを読む（表全体の文字列だと隣の欄の数字がくっつく）
    const approvedSha = ((await win.locator("#data-body td.mono").first().textContent()) ?? "").trim();
    await win.getByTestId("consent-ack").check();
    await win.getByTestId("consent-send").click();
    const run = await outcome(page, 180_000);
    const o = run.outcome;
    fs.writeFileSync(path.join(OUT_DIR, "outcome.json"), JSON.stringify(run, null, 2));
    check(run.hasCompute === true, "プラグインに host.compute.runJob が渡る");
    check(o.ok === true && o.status === "ok", "実行が最後まで走る", { error: o.error, stderr: o.stderr, ev: o.errorValue });
    check(String(o.stdout).includes("shape ("), "stdout が返る", o.stdout);
    check(
      JSON.stringify((o.files ?? []).map((f: { name: string }) => f.name).sort()) === JSON.stringify(["mask.npy", "summary.json"]),
      "outputs の一覧が返る", o.files,
    );
    check(o.maskBytes > 128, "readFile で mask.npy を取り出せる", o.maskBytes);
    check(o.missing === null, "無い名前は null");
    const s = o.summary ?? {};
    check(s.sha256 === approvedSha && approvedSha.length === 64, "🔴 届いたバイト列の SHA-256 が同意画面の値と一致する",
      { received: s.sha256, approved: approvedSha });
    check(s.dtype === "float32" && s.shape?.[0] === ct.numberOfInstances, "volume は float32・枚数どおり", { shape: s.shape, n: ct.numberOfInstances });
    const metaText = JSON.stringify(s.meta ?? {});
    check(!metaText.includes(study.patientId) && !metaText.includes(ct.seriesInstanceUid), "🔴 届いたデータに患者 ID・元の UID が無い", s.meta);
    check(JSON.stringify(s.inputs) === JSON.stringify(["0.npz"]), "計算機の inputs/ には承認したものだけ", s.inputs);
    const ps: number[] = (run.progress ?? []).map((x: [number, string]) => x[0]);
    check(ps.some((p) => p > 0.2 && p < 0.95), "コードの進み具合（__progress__）が届く", run.progress?.slice(-6));
    check(ps.every((p, i) => i === 0 || p >= ps[i - 1] - 1e-9), "進み具合は戻らない");

    // --- 2. 後片付けと監査 ---
    console.log("\n[2] 後片付けと監査");
    // Jupyter はフォルダを消すと空の .ipynb_checkpoints を残すことがある。見るのは「ファイルが残っていないか」
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
    check(left.length === 0, "🔴 計算機にファイルが何も残らない（入力も出力も）", left);
    const events = fs.readFileSync(AUDIT, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const names = events.map((e: { event: string }) => e.event);
    for (const ev of ["egress-requested", "egress-approved", "egress-consumed", "compute-uploaded", "compute-finished"]) {
      check(names.includes(ev), `監査: ${ev}`, names);
    }
    check(events.find((e: { event: string }) => e.event === "compute-finished")?.outcome === "ok", "監査: 結果 ok");

    // --- 3. 取り消す ---
    console.log("\n[3] runJob（取り消す）");
    const before = fs.readFileSync(AUDIT, "utf8").split("\n").length;
    await launchPlugin(page, input);
    const win2 = await consentWindow(driver);
    await win2.getByTestId("consent-cancel").click();
    const run2 = await outcome(page, 30_000);
    check(run2.outcome.ok === false && run2.outcome.cancelled === true, "取り消すと cancelled が返る", run2.outcome);
    const after = fs.readFileSync(AUDIT, "utf8").trim().split("\n").slice(before - 1).map((l) => JSON.parse(l).event);
    check(!after.includes("compute-uploaded"), "🔴 取り消したら何も送らない", after);
  } finally {
    await driver.stop();
    jupyter.kill();
    if (endpointsFile) {
      if (endpointsBackup !== null) fs.writeFileSync(endpointsFile, endpointsBackup);
      else fs.rmSync(endpointsFile, { force: true });
    }
  }
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
