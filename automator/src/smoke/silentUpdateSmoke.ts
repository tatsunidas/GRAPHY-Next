/*
 * Windows の「アプリ内の自動更新」が使うサイレント更新の実機確認（GitHub Actions の windows ランナー用）。
 * アプリは更新のとき、ダウンロードして署名を確かめたインストーラを `Setup.exe --updated /S [--force-run]` で起動して終了する
 * （desktop/appUpdate.js の buildApplyPlan）。その経路を、できたインストーラで実際に通す:
 *
 *   1. インストーラを無人で入れる（/S /D=<dir>）
 *   2. 旧い版の印（インストール先の目印ファイル）と、利用者データの印（%APPDATA%\GRAPHY-Next の目印ファイル）を置く
 *   3. 同じインストーラを `--updated /S --force-run` で起動する（アプリは動いていない＝更新のために終了したあとと同じ状態）
 *   4. 旧い版の印が消えている（同じ場所に入れ替わった）／利用者データの印が残っている／
 *      --force-run でアプリが起動し、backend が応答する
 *
 * 実行（windows のみ）:  cd automator && npx tsx src/smoke/silentUpdateSmoke.ts --dist ../desktop/dist
 * 同じ版の上書きなので「版が上がる」ことは見ない（旧アンインストーラ→新インストール→force-run の経路を見る）。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const DIST = path.resolve(arg("dist", path.join(AUTOMATOR_ROOT, "..", "desktop", "dist")));
const CONFIG = JSON.parse(fs.readFileSync(path.join(AUTOMATOR_ROOT, "..", "desktop", "config.json"), "utf8"));
const PORT = Number(CONFIG.backend.port);

let passed = 0;
const failures: string[] = [];
function check(cond: boolean, label: string, detail?: unknown): void {
  const d = detail === undefined ? "" : ` — ${JSON.stringify(detail)}`;
  if (cond) { passed++; console.log(`  [ok  ] ${label}${d}`); } else { console.log(`  [FAIL] ${label}${d}`); failures.push(label); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function ps(script: string): string {
  const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" });
  return (r.stdout ?? "").trim();
}

/** 指定フォルダ配下から起動している GRAPHY-Next.exe の PID。 */
function appPids(dir: string): number[] {
  const out = ps(`Get-Process -Name 'GRAPHY-Next' -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith('${dir.replace(/'/g, "''")}', [System.StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { $_.Id }`);
  return out.split(/\s+/).filter(Boolean).map(Number);
}

function stopAll(dir: string): void {
  spawnSync("taskkill", ["/F", "/T", "/IM", "GRAPHY-Next.exe"], { stdio: "ignore" });
  // この install の同梱 java（backend）
  ps(`Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'java.exe' -and $_.ExecutablePath -and $_.ExecutablePath.StartsWith('${dir.replace(/'/g, "''")}', [System.StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`);
}

function runInstaller(setup: string, args: string[], label: string): number {
  // 稀にインストーラが短時間で非 0 終了する（installedSmoke の記録）。1 回だけやり直し、やり直したことは出す
  for (let attempt = 1; ; attempt++) {
    const r = spawnSync(setup, args, { stdio: "inherit", timeout: 300_000 });
    if (r.status === 0) return 0;
    console.log(`  [情報] ${label}: 失敗（${attempt} 回目）status=${r.status} signal=${r.signal} error=${r.error?.message ?? "-"}`);
    if (attempt >= 2) return r.status ?? -1;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5_000);
  }
}

async function backendUp(ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/api/status`); if (r.ok) return true; } catch { /* まだ */ }
    await sleep(2000);
  }
  return false;
}

async function main(): Promise<void> {
  if (process.platform !== "win32") { console.log("  [未達] Windows 専用"); process.exitCode = 2; return; }
  const setups = fs.readdirSync(DIST).filter((f) => /\.exe$/i.test(f) && !/uninstall/i.test(f));
  if (setups.length !== 1) throw new Error(`${DIST} にインストーラが 1 つだけある想定ですが ${setups.length} 個です`);
  const setup = path.join(DIST, setups[0]);
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "silent-update-")), "app");
  const appData = process.env.APPDATA;
  if (!appData) throw new Error("APPDATA が未設定です");
  const userMarker = path.join(appData, "GRAPHY-Next", "update-smoke-marker.txt");

  try {
    console.log(`\n[1] 無人インストール: ${setups[0]} → ${dir}`);
    check(runInstaller(setup, ["/S", `/D=${dir}`], "初回インストール") === 0, "NSIS の無人インストールが成功した");
    check(fs.existsSync(path.join(dir, "GRAPHY-Next.exe")), "GRAPHY-Next.exe がインストールされた");

    console.log("\n[2] 旧い版の印と、利用者データの印を置く");
    const oldSentinel = path.join(dir, "resources", "old-version-sentinel.txt");
    fs.writeFileSync(oldSentinel, "old");
    fs.mkdirSync(path.dirname(userMarker), { recursive: true });
    fs.writeFileSync(userMarker, "user data must survive the update");
    check(appPids(dir).length === 0, "更新の前にアプリは動いていない（更新のために終了したあとと同じ状態）");

    console.log("\n[3] サイレント更新: Setup.exe --updated /S --force-run（アプリが使う引数と同じ）");
    check(runInstaller(setup, ["--updated", "/S", "--force-run"], "サイレント更新") === 0, "サイレント更新のインストーラが成功した");

    console.log("\n[4] 結果");
    check(!fs.existsSync(oldSentinel), "旧い版の印が消えた（同じ場所に新しく入れ替わった）");
    check(fs.existsSync(path.join(dir, "GRAPHY-Next.exe")), "インストール先に GRAPHY-Next.exe がある");
    check(fs.existsSync(userMarker) && fs.readFileSync(userMarker, "utf8") === "user data must survive the update", "利用者データ（%APPDATA%\\GRAPHY-Next）が残っている");
    let up = false;
    for (let i = 0; i < 60 && !up; i++) { up = appPids(dir).length > 0; if (!up) await sleep(2000); }
    check(up, "--force-run で、更新後のアプリが起動した（このインストール先の GRAPHY-Next.exe）");
    check(await backendUp(120_000), `更新後のアプリの backend が応答する（127.0.0.1:${PORT}）`);
  } finally {
    stopAll(dir);
    try { fs.rmSync(userMarker, { force: true }); } catch { /* 無視 */ }
  }
}

main()
  .then(() => { console.log(`\n${passed} passed, ${failures.length} failed`); process.exit(process.exitCode || (failures.length === 0 ? 0 : 1)); })
  .catch((e) => { console.error(e); process.exit(2); });
