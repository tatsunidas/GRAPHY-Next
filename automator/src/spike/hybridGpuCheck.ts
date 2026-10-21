/*
 * 「描画に使う GPU」の選択（設定＞描画環境）の実機検証。設計: fw/render-environment-design.md
 * ハイブリッド GPU（内蔵 Intel ＋ NVIDIA）の Linux 機で、選ぶ → 再起動 → GPU が変わる → 戻す、を通す。
 *
 * 実行:  cd automator && npx tsx src/spike/hybridGpuCheck.ts
 *   前提: backend jar・nvidia-smi・内蔵＋NVIDIA の 2 GPU。ポートは GRAPHY_AUTOMATOR_HTTP_PORT / _SCP_PORT / _VITE_PORT で分ける。
 *   開発起動の保存先は desktop/render-prefs.json（終了時に消す）。Windows・macOS の経路はここでは見ない（単体テストと実機の手順）。
 *
 *   [1] 既定（auto）で起動: 節が出る・選択は「OS の既定」・再起動待ちなし・GPU は NVIDIA 以外・Electron の GPU プロセスは nvidia-smi に出ない（基準）
 *   [2] 「NVIDIA GPU を使う」を選ぶ: ファイルが high・再起動待ちが出る・GPU 名はまだ変わらない
 *   [3] 再起動（起動し直し。開発起動と同じく、scripts/dev-desktop.sh が起動前に足す環境変数を renderPrefsEnv.js から取って渡す）:
 *       GPU が NVIDIA・再起動待ちなし・Electron の GPU プロセスが nvidia-smi に出る
 *   [3b] 環境変数なしの直接起動（配布版と同じ経路）: main が環境変数を足して 1 回だけ起動し直し、起動し直した側の GPU プロセスの
 *        環境に PRIME オフロードの変数が付き、nvidia-smi に出る。auto に戻すと起動し直さない（負例）
 *   [4] 「OS の既定」に戻して再起動: GPU が NVIDIA 以外に戻り、nvidia-smi から消える（負例）
 *   [5] 壊れた render-prefs.json: 起動でき、auto として扱う
 * 🔴 先に、基準の起動（[1]）で Electron が nvidia-smi に出ていないことを確かめてから、[3] の「出る」を判定する。
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import type { Page } from "@playwright/test";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { createChecker } from "./computeSpikeShared.js";

const { check, summary } = createChecker();
const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "hybrid-gpu-check");
const PREFS = path.join(AUTOMATOR_ROOT, "..", "desktop", "render-prefs.json");

/** scripts/dev-desktop.sh が Electron の起動前に足すのと同じ環境変数（renderPrefsEnv.js の出力）。 */
const devScriptEnv = (): Record<string, string> => {
  const out = execFileSync("node", ["renderPrefsEnv.js"], { cwd: path.join(AUTOMATOR_ROOT, "..", "desktop"), encoding: "utf8" });
  const env: Record<string, string> = {};
  for (const m of out.matchAll(/^export (\w+)=(.*)$/gm)) env[m[1]] = m[2];
  return env;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pidsByMarker = (marker: string): number[] =>
  execFileSync("ps", ["-eo", "pid,args"], { encoding: "utf8" })
    .split("\n")
    .filter((l) => l.includes(marker) && !l.includes("ps -eo"))
    .map((l) => Number(l.trim().split(/\s+/)[0]))
    .filter((n) => n > 0);
const envOf = (pid: number): string => {
  try {
    return fs.readFileSync(`/proc/${pid}/environ`, "utf8");
  } catch {
    return "";
  }
};

const ppidOf = (pid: number): number => {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
  } catch {
    return 0;
  }
};
const isDescendant = (pid: number, root: number): boolean => {
  for (let p = pid, n = 0; p > 1 && n < 20; p = ppidOf(p), n++) if (p === root) return true;
  return false;
};
/** nvidia-smi に出ている（描画・計算の）プロセスの PID。 */
const smiPids = (): number[] => {
  const out = execFileSync("nvidia-smi", ["pmon", "-c", "1", "-s", "u"], { encoding: "utf8" });
  return out
    .split("\n")
    .filter((l) => !l.startsWith("#"))
    .map((l) => Number(l.trim().split(/\s+/)[1]))
    .filter((n) => Number.isFinite(n) && n > 0);
};

async function openRenderEnv(page: Page): Promise<void> {
  await page.getByTestId("mainscreen-menu-system").click();
  await page.getByTestId("menu-item-settings").click();
  await page.getByTestId("settings-dialog").waitFor({ state: "visible", timeout: 10_000 });
  await page.getByTestId("settings-cat-renderEnv").click();
  await page.getByTestId("renderenv-panel").waitFor({ state: "visible", timeout: 15_000 });
}

async function launch(label: string, run: (d: DesktopDriver, page: Page, electronPid: number) => Promise<void>): Promise<void> {
  const driver = new DesktopDriver({}, { extraEnv: devScriptEnv() });
  try {
    await driver.start();
    const page = driver.page;
    await page.evaluate("localStorage.setItem('graphy.locale', 'ja')");
    await page.reload({ waitUntil: "domcontentloaded" });
    const later = page.getByRole("button", { name: /^(後で|Later)$/ });
    if (await later.isVisible({ timeout: 3000 }).catch(() => false)) await later.click();
    const pid = (await driver.app.evaluate(() => process.pid)) as number;
    await openRenderEnv(page);
    await page.screenshot({ path: path.join(OUT_DIR, `${label}.png`) });
    await run(driver, page, pid);
  } finally {
    await driver.stop().catch(() => undefined);
  }
}

const gpuName = (page: Page) => page.getByTestId("renderenv-row-gpu").getAttribute("data-value");
const pick = (page: Page) => page.getByTestId("renderenv-gpupick");

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.rmSync(PREFS, { force: true });
  const smi = execFileSync("nvidia-smi", ["--query-gpu=name", "--format=csv,noheader"], { encoding: "utf8" }).trim();
  console.log(`  （前提）nvidia-smi: ${smi}`);
  let baselineNvidiaFree = false;
  try {
    // ── [1] 既定 ──
    console.log("\n[1] 既定（auto）で起動");
    await launch("1-auto", async (_d, page, pid) => {
      check((await pick(page).count()) === 1, "🔴 ハイブリッド GPU の機械では「描画に使う GPU」の節が出る");
      check((await pick(page).getAttribute("data-selected")) === "auto", "選択は「OS の既定」");
      check((await pick(page).getAttribute("data-pending")) === "false", "再起動待ちは出ない");
      const name = (await gpuName(page)) ?? "";
      check(name.length > 0 && !/NVIDIA/i.test(name), "（基準）描画の GPU は NVIDIA ではない", name);
      const mine = smiPids().filter((p) => isDescendant(p, pid));
      baselineNvidiaFree = mine.length === 0;
      check(baselineNvidiaFree, "（基準）Electron の GPU プロセスは nvidia-smi に出ていない", mine);
    });

    // ── [2] 選ぶ ──
    console.log("\n[2] 「NVIDIA GPU を使う」を選ぶ");
    await launch("2-pick", async (_d, page) => {
      await page.getByTestId("renderenv-gpupick-high").check();
      await pick(page).and(page.locator('[data-selected="high"]')).waitFor({ timeout: 10_000 });
      check(true, "選択が「NVIDIA GPU を使う」に変わる");
      check((await pick(page).getAttribute("data-pending")) === "true", "再起動待ちが出る（［今すぐ再起動］つき）");
      check((await page.getByTestId("renderenv-gpupick-restart").count()) === 1, "［今すぐ再起動］が出る");
      check(!/NVIDIA/i.test((await gpuName(page)) ?? ""), "この時点の描画の GPU はまだ変わらない（再起動まで）");
      check(fs.existsSync(PREFS) && JSON.parse(fs.readFileSync(PREFS, "utf8")).gpu === "high", "保存ファイルが high になる", fs.existsSync(PREFS) ? fs.readFileSync(PREFS, "utf8") : "無い");
      await page.screenshot({ path: path.join(OUT_DIR, "2-pick-pending.png") });
    });

    // ── [3] 再起動 ──
    console.log("\n[3] 起動し直す（high）");
    await launch("3-high", async (_d, page, pid) => {
      check((await pick(page).getAttribute("data-selected")) === "high", "選択は「NVIDIA GPU を使う」のまま");
      check((await pick(page).getAttribute("data-pending")) === "false", "再起動待ちが消える");
      const name = (await gpuName(page)) ?? "";
      check(/NVIDIA/i.test(name), "🔴 描画の GPU が NVIDIA になる", name);
      // 先に基準（[1]）で出ていなかったことを確かめてある場合だけ、「出る」を判定する
      if (!baselineNvidiaFree) console.log("  [未達] nvidia-smi の判定: 基準の起動で Electron が既に出ていた");
      else {
        const mine = smiPids().filter((p) => isDescendant(p, pid));
        check(mine.length > 0, "🔴 Electron の GPU プロセスが nvidia-smi に出る", mine);
      }
    });

    // ── [3b] 環境変数なしの直接起動（配布版と同じ経路） ──
    console.log("\n[3b] 環境変数なしの直接起動（high）→ main が足して 1 回起動し直す");
    {
      const desktopDir = path.join(AUTOMATOR_ROOT, "..", "desktop");
      const electronBin = path.join(desktopDir, "node_modules", "electron", "dist", "electron");
      const direct = async (marker: string) => {
        const env: Record<string, string> = { ...(process.env as Record<string, string>), GRAPHY_BACKEND_EXTERNAL: "1", GRAPHY_BACKEND_PORT: "48599" };
        delete env.__NV_PRIME_RENDER_OFFLOAD;
        delete env.__GLX_VENDOR_LIBRARY_NAME;
        delete env.GRAPHY_RENDER_REEXEC;
        delete env.GRAPHY_DEV_DATA_DIR;
        const first = spawn(electronBin, [desktopDir, `--graphy-spike-marker=${marker}`], { cwd: desktopDir, env, stdio: "ignore", detached: true });
        first.unref();
        await sleep(15_000);
        return first.pid ?? 0;
      };
      const killMarked = (marker: string) => {
        for (const p of pidsByMarker(marker)) {
          try {
            process.kill(p, "SIGTERM");
          } catch {
            /* もう無い */
          }
        }
      };
      fs.writeFileSync(PREFS, JSON.stringify({ gpu: "high" }), "utf8");
      const mHigh = `hgc-high-${Date.now()}`;
      const firstPid = await direct(mHigh);
      const alive = pidsByMarker(mHigh);
      check(firstPid > 0 && !alive.includes(firstPid), "最初に起動したプロセスは、環境変数を足して終わっている（起動し直した）", { firstPid, alive: alive.length });
      check(alive.length > 0, "起動し直した側のプロセスが動いている", alive.length);
      const gpuProcs = alive.filter((p) => /--type=gpu-process/.test(execFileSync("ps", ["-o", "args=", "-p", String(p)], { encoding: "utf8" })));
      check(gpuProcs.length > 0, "（前提）起動し直した側に GPU プロセスがある", gpuProcs);
      check(gpuProcs.length > 0 && gpuProcs.every((p) => envOf(p).includes("__NV_PRIME_RENDER_OFFLOAD=1") && envOf(p).includes("__GLX_VENDOR_LIBRARY_NAME=nvidia")), "🔴 GPU プロセスの環境に PRIME オフロードの変数が付いている", gpuProcs);
      check(smiPids().some((p) => alive.includes(p)), "🔴 起動し直した側が nvidia-smi に出る");
      killMarked(mHigh);
      await sleep(3000);
      // 負例: auto は起動し直さない・環境変数を付けない
      fs.writeFileSync(PREFS, JSON.stringify({ gpu: "auto" }), "utf8");
      const mAuto = `hgc-auto-${Date.now()}`;
      const autoPid = await direct(mAuto);
      const aliveAuto = pidsByMarker(mAuto);
      check(aliveAuto.includes(autoPid), "（負例）auto では起動し直さない（最初のプロセスがそのまま動く）", { autoPid, aliveAuto: aliveAuto.length });
      check(aliveAuto.every((p) => !envOf(p).includes("__NV_PRIME_RENDER_OFFLOAD")), "（負例）auto では PRIME オフロードの変数が付かない");
      check(smiPids().every((p) => !aliveAuto.includes(p)), "（負例）auto の Electron は nvidia-smi に出ない");
      killMarked(mAuto);
      await sleep(2000);
      fs.writeFileSync(PREFS, JSON.stringify({ gpu: "high" }), "utf8");
    }

    // ── [4] 戻す ──
    console.log("\n[4] 「OS の既定」に戻して起動し直す");
    await launch("4-back-select", async (_d, page) => {
      await page.getByTestId("renderenv-gpupick-auto").check();
      await pick(page).and(page.locator('[data-selected="auto"]')).waitFor({ timeout: 10_000 });
      check((await pick(page).getAttribute("data-pending")) === "true", "戻すときも再起動待ちが出る（今の起動は high のまま）");
    });
    await launch("4-auto-again", async (_d, page, pid) => {
      const name = (await gpuName(page)) ?? "";
      check(!/NVIDIA/i.test(name), "🔴 描画の GPU が NVIDIA 以外に戻る", name);
      check((await pick(page).getAttribute("data-pending")) === "false", "再起動待ちなし");
      check(smiPids().filter((p) => isDescendant(p, pid)).length === 0, "Electron の GPU プロセスが nvidia-smi から消える（負例）");
    });

    // ── [5] 壊れたファイル ──
    console.log("\n[5] 壊れた render-prefs.json");
    fs.writeFileSync(PREFS, "{ not json", "utf8");
    await launch("5-corrupt", async (_d, page) => {
      check((await pick(page).getAttribute("data-selected")) === "auto", "起動でき、「OS の既定」として扱う");
      check(!/NVIDIA/i.test((await gpuName(page)) ?? ""), "GPU は変わらない");
    });
  } finally {
    fs.rmSync(PREFS, { force: true });
  }
  if (summary() > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
