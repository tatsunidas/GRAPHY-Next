/*
 * 「この PC」で計算する経路の実機検証。設計: fw/remote-compute-design.md §22
 *
 * 実行:  cd automator && GRAPHY_AUTOMATOR_HTTP_PORT=18890 GRAPHY_AUTOMATOR_SCP_PORT=18891 GRAPHY_AUTOMATOR_VITE_PORT=18893 \
 *          npx tsx src/spike/computeLocalRunCheck.ts
 *   起動前に frontend/node_modules/.vite を消すこと。Linux 専用（/proc を読む）。
 *   前提: backend jar・fixture ct-basic・jupyter_server と ipykernel の入った Python が PATH 上にあること。
 *
 * 本物の Electron ＋ 本物の backend ＋ 本物の Python で、プラグインの ui.js から endpointId:"local" を名指しして:
 *   A  1. 同意の窓が「この PC」になり、コードが動くことの注意が出る（スクリーンショットで目視）
 *      2. 承認 → 実行 → 届いたバイト列の SHA-256 が同意画面の値と一致・npz に患者 ID が無い
 *      3. 監査に endpointKind:"local"・送り先は 127.0.0.1
 *      4. サーバ: トークン無しは 403・正しいトークンは 200（トークンはプロセスの環境から読む）・
 *         コマンド行にトークンが無い・LAN 側の IP からは繋がらない
 *      5. 取り消すと何も送られない
 *   B  アプリを閉じる → Jupyter のプロセスが残らない・server.json が消える
 *   C  Electron を SIGKILL → Jupyter が自分で止まる（止まるまでの時間を記録）
 *   未達にするもの（この機では測れない）: NVIDIA の GPU での実行、Windows・macOS、配布物
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DesktopDriver, DESKTOP_RUN_DATA_DIR } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importFixtureCategory } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { approvedSha as readApprovedSha, consentWindow, createChecker, launchRunJobPlugin as launchPlugin, runJobOutcome as outcome } from "./computeSpikeShared.js";

const { check, summary } = createChecker();
const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "compute-local-run-check");
const PLUGIN_ID = "compute-runjob-check";
const AUDIT = path.join(DESKTOP_RUN_DATA_DIR, "compute-audit.jsonl");
const unreached: string[] = [];
const skip = (label: string, why: string) => {
  console.log(`  [未達] ${label} — ${why}`);
  unreached.push(`${label}（${why}）`);
};

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function waitGone(pid: number, ms: number): Promise<number | null> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (!alive(pid)) return Date.now() - t0;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}
const readRecord = (dataDir: string): { pid: number; port: number; mark: string } | null => {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, "compute-local", "server.json"), "utf8"));
  } catch {
    return null;
  }
};
const procEnv = (pid: number): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const kv of fs.readFileSync(`/proc/${pid}/environ`, "utf8").split("\0")) {
    const i = kv.indexOf("=");
    if (i > 0) out[kv.slice(0, i)] = kv.slice(i + 1);
  }
  return out;
};

async function prepare(driver: DesktopDriver) {
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
  const base = `http://localhost:${driver.ports.http}`;
  const studies = (await (await fetch(`${base}/api/studies`)).json()) as { studyInstanceUid: string; patientId: string }[];
  const series = (await (await fetch(`${base}/api/studies/${studies[0].studyInstanceUid}/series`)).json()) as {
    seriesInstanceUid: string; modality: string; numberOfInstances: number;
  }[];
  const ct = series.find((s) => s.modality === "CT") ?? series[0];
  return { page, cwd, study: studies[0], ct };
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const dst = path.join(DESKTOP_RUN_DATA_DIR, "plugins", PLUGIN_ID);
  fs.mkdirSync(dst, { recursive: true });
  for (const n of ["plugin.json", "ui.js"]) fs.copyFileSync(path.join(AUTOMATOR_ROOT, "plugins", PLUGIN_ID, n), path.join(dst, n));
  fs.rmSync(AUDIT, { force: true });

  // ── A, B ──
  let driver = new DesktopDriver();
  let recordA: { pid: number; port: number; mark: string } | null = null;
  try {
    const { page, cwd, study, ct } = await prepare(driver);
    const input = { studyUid: study.studyInstanceUid, seriesUid: ct.seriesInstanceUid, endpointId: "local" };

    console.log("\n[A1] 同意の窓（この PC）");
    const t0 = Date.now();
    await launchPlugin(page, input);
    const win = await consentWindow(driver, 180_000);
    console.log(`  起動して同意の窓が開くまで ${Date.now() - t0} ms（Jupyter の起動と匿名化を含む）`);
    const title = (await win.locator("#title").textContent()) ?? "";
    const note = (await win.getByTestId("consent-note").textContent()) ?? "";
    const url = (await win.getByTestId("consent-url").textContent()) ?? "";
    check(/この PC|this PC/.test(title), "題が『この PC でコードを実行します』（ja/en）", title);
    check(/^http:\/\/127\.0\.0\.1:\d+\/$/.test(url.trim()), "送り先は 127.0.0.1 のポート", url);
    check(/権限|permissions/.test(note) && !/暗号化されない|unencrypted/.test(note), "注意は『コードはこの PC で動く』（平文 http の警告ではない）", note);
    check(!/外に出ない|never leaves/i.test(note), "『外に出ない』と言い切っていない", note);
    await win.screenshot({ path: path.join(OUT_DIR, "consent-local.png") });

    const approvedSha = await readApprovedSha(win);
    await win.getByTestId("consent-ack").check();
    await win.getByTestId("consent-send").click();
    const run = await outcome(page, 240_000);
    const o = run.outcome;
    fs.writeFileSync(path.join(OUT_DIR, "outcome.json"), JSON.stringify(run, null, 2));

    console.log("\n[A2] 実行と結果");
    check(o.ok === true && o.status === "ok", "実行が最後まで走る", { error: o.error, stderr: o.stderr, ev: o.errorValue });
    const s = o.summary ?? {};
    check(s.sha256 === approvedSha && approvedSha.length === 64, "🔴 届いたバイト列の SHA-256 が同意画面の値と一致する", { received: s.sha256, approved: approvedSha });
    const metaText = JSON.stringify(s.meta ?? {});
    check(!metaText.includes(study.patientId) && !metaText.includes(ct.seriesInstanceUid), "🔴 届いたデータに患者 ID・元の UID が無い", s.meta);

    console.log("\n[A3] 監査");
    const events = fs.readFileSync(AUDIT, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const req = events.find((e: { event: string }) => e.event === "egress-requested");
    check(req?.endpointKind === "local" && /^127\.0\.0\.1(:\d+)?$/.test(req?.host ?? ""), "監査: endpointKind=local・host=127.0.0.1", req);
    check(events.find((e: { event: string }) => e.event === "compute-finished")?.outcome === "ok", "監査: 結果 ok");

    console.log("\n[A4] サーバの守り");
    recordA = readRecord(cwd);
    check(!!recordA, "server.json がある", recordA);
    if (recordA) {
      const env = procEnv(recordA.pid);
      const token = env.JUPYTER_TOKEN ?? "";
      check(token.length === 64, "トークンはプロセスの環境変数にある（64 桁）");
      const cmd = fs.readFileSync(`/proc/${recordA.pid}/cmdline`, "utf8").split("\0").join(" ");
      check(!cmd.includes(token) && token.length > 0, "🔴 コマンド行にトークンが無い");
      check(cmd.includes(`graphy-local-jupyter:${recordA.mark}`), "コマンド行に目印がある");
      check(!("GRAPHY_MAIN_SECRET" in env) && !Object.keys(env).some((k) => /^(GRAPHY_|ELECTRON_)/.test(k)), "子の環境に GRAPHY_*・ELECTRON_* が無い");
      check(env.JUPYTER_CONFIG_DIR?.startsWith(path.join(cwd, "compute-local")) === true, "Jupyter の設定は本体専用のフォルダ", env.JUPYTER_CONFIG_DIR);
      const st = async (u: string, h?: Record<string, string>) => (await fetch(u, { headers: h }).catch(() => null))?.status ?? 0;
      check((await st(`http://127.0.0.1:${recordA.port}/api/status`)) === 403, "トークン無しは 403");
      check((await st(`http://127.0.0.1:${recordA.port}/api/status`, { Authorization: `token ${token}` })) === 200, "正しいトークンは 200");
      const lan = Object.values(os.networkInterfaces()).flat().find((i) => i && !i.internal && i.family === "IPv4");
      if (lan) check((await st(`http://${lan.address}:${recordA.port}/api/status`, { Authorization: `token ${token}` })) === 0, `🔴 LAN 側 IP（${lan.address}）からは繋がらない`);
      else skip("LAN 側 IP からの接続拒否", "この機に非ループバックの IPv4 が無い");
    }

    console.log("\n[A5] 取り消す");
    const before = fs.readFileSync(AUDIT, "utf8").split("\n").length;
    await launchPlugin(page, input);
    const win2 = await consentWindow(driver, 180_000);
    await win2.getByTestId("consent-cancel").click();
    const run2 = await outcome(page, 30_000);
    check(run2.outcome.ok === false && run2.outcome.cancelled === true, "取り消すと cancelled が返る", run2.outcome);
    const after = fs.readFileSync(AUDIT, "utf8").trim().split("\n").slice(before - 1).map((l) => JSON.parse(l).event);
    check(!after.includes("compute-uploaded"), "🔴 取り消したら何も送らない", after);
  } finally {
    await driver.stop();
  }

  console.log("\n[B] アプリを閉じる");
  if (recordA) {
    const ms = await waitGone(recordA.pid, 20_000);
    check(ms !== null, "アプリを閉じたら Jupyter のプロセスが残らない", ms);
    if (ms !== null) console.log(`  閉じてから消えるまで ${ms} ms`);
    check(readRecord(path.dirname(DESKTOP_RUN_DATA_DIR)) === null && !fs.existsSync(path.join(DESKTOP_RUN_DATA_DIR, "compute-local", "server.json")), "server.json が消える");
  }

  // ── C ──
  console.log("\n[C] Electron を SIGKILL");
  driver = new DesktopDriver();
  let pidC: number | null = null;
  let electronPid: number | null = null;
  try {
    const { page, cwd } = await prepare(driver);
    electronPid = await driver.app.evaluate(() => process.pid);
    const ens = await page.evaluate(async () => (window as unknown as { graphyDesktop: { computeLocalEnsure: () => Promise<{ ok: boolean; error?: string }> } }).graphyDesktop.computeLocalEnsure());
    check(ens.ok === true, "computeLocalEnsure で Jupyter が起動する", ens);
    const rec = readRecord(cwd);
    pidC = rec ? rec.pid : null;
    check(!!pidC && alive(pidC), "起動したプロセスが生きている（強制終了の前＝負例の前提）", rec);
    if (pidC && electronPid) {
      process.kill(electronPid, "SIGKILL");
      const ms = await waitGone(pidC, 30_000);
      check(ms !== null, "🔴 Electron を強制終了しても Jupyter は自分で止まる", ms);
      if (ms !== null) console.log(`  強制終了から停止まで ${ms} ms`);
    }
  } finally {
    try { await driver.stop(); } catch { /* Electron が既に死んでいる */ }
    if (pidC && alive(pidC)) { try { process.kill(pidC, "SIGKILL"); } catch { /* 済み */ } }
  }

  skip("NVIDIA の GPU 上での実行", "この機は nvidia-smi が通らない（外付け GPU が PCI に出ていない）");
  skip("Windows・macOS 実機と配布物", "Linux の開発機のみ");
  console.log(`\n未達 ${unreached.length} 件: ${unreached.join(" / ")}`);
  if (summary() > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
