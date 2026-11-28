/*
 * 終了したとき、音声入力の llama-server が残らないことの実機検証。
 *
 * 実行:  cd automator && npx tsx src/spike/localAiQuitCheck.ts
 *
 * 前提: desktop/local-ai/ に、音声入力が導入済みであること（state.json・runtime・models。検査中の本体は CWD=desktop を使う）。
 *       worktree では、導入済みの作業コピーの desktop/local-ai/ を `cp -al` で写すと複製せずに済む（server*.json は写さない）。
 *       会話用のモデルは起動しない（＝音声入力の枠だけが動いている状態で終了する）。
 *   1. 設定画面の「起動テスト」と同じ入口（aiLocalCheck("stt")）で音声入力のサーバーを起動する
 *   2. 記録（server-stt.json）の PID が生きていて、llama-server であることを確かめる
 *   3. メニューの終了と同じ入口（requestQuit）で本体を終了する
 *   4. その PID が消えている
 */
import fs from "node:fs";
import path from "node:path";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { createChecker } from "./computeSpikeShared.js";

const LOCAL_AI_DIR = path.join(AUTOMATOR_ROOT, "..", "desktop", "local-ai");
const PORTS = { http: 19350, scp: 19351, vite: 19353 };
const { check, summary } = createChecker();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function cmdline(pid: number): string {
  try { return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " "); } catch { return ""; }
}

async function main() {
  if (process.platform !== "linux") {
    console.log("Linux でだけ実行できます（/proc でプロセスを確かめるため）");
    process.exit(2);
  }
  const record = path.join(LOCAL_AI_DIR, "server-stt.json");
  if (!fs.existsSync(path.join(LOCAL_AI_DIR, "state.json"))) {
    console.log(`音声入力が導入されていません: ${LOCAL_AI_DIR}`);
    process.exit(2);
  }
  const driver = new DesktopDriver(PORTS);
  let pid = 0;
  try {
    await driver.start();
    // 本体の終了は PID で見る（llama-server が残ると出力のパイプが閉じず、Playwright の close が来ない）
    const appPid = driver.app.process().pid ?? 0;
    type Bridge = {
      aiLocalStatus: () => Promise<{ running: boolean; stt: { installed: boolean; running: boolean } }>;
      aiLocalCheck: (role: string) => Promise<{ ok: boolean; error?: string }>;
      requestQuit: () => Promise<{ ok: boolean }>;
    };
    const page = driver.page;
    const before = await page.evaluate(() => (window as unknown as { graphyDesktop: Bridge }).graphyDesktop.aiLocalStatus());
    check(before.stt.installed && !before.stt.running && !before.running, "音声入力は導入済みで、まだ何も起動していない", before);

    const started = await page.evaluate(() => (window as unknown as { graphyDesktop: Bridge }).graphyDesktop.aiLocalCheck("stt"));
    check(started.ok, "音声入力のサーバーが起動する（起動テスト）", started);
    const st = await page.evaluate(() => (window as unknown as { graphyDesktop: Bridge }).graphyDesktop.aiLocalStatus());
    check(st.stt.running && !st.running, "動いているのは音声入力の枠だけ（会話の枠は起動していない）", st);

    pid = (JSON.parse(fs.readFileSync(record, "utf8")) as { pid: number }).pid;
    check(alive(pid) && cmdline(pid).includes("llama-server"), `記録の PID ${pid} が llama-server として生きている`, cmdline(pid).slice(0, 120));

    await page.evaluate(() => { void (window as unknown as { graphyDesktop: Bridge }).graphyDesktop.requestQuit(); }).catch(() => undefined);
    for (let i = 0; i < 60 && alive(appPid); i++) await sleep(500);
    check(appPid > 0 && !alive(appPid), `本体（PID ${appPid}）が終了する`);
    await sleep(1000);
    check(!alive(pid), `🔴 終了後に llama-server（PID ${pid}）が残っていない`);
  } catch (e) {
    console.log(`  [info] 中断: ${(e as Error).message}`);
  } finally {
    // 先に止める（残したまま driver.stop() を呼ぶと、パイプが閉じず戻ってこない）
    if (pid && alive(pid) && cmdline(pid).includes("llama-server")) {
      console.log(`  [info] 残った llama-server（PID ${pid}）を止めます`);
      process.kill(pid, "SIGTERM");
    }
    await driver.stop().catch(() => undefined);
  }
  process.exit(summary() > 0 ? 1 : 0);
}

void main();
