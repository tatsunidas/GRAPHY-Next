/*
 * Windows の実機（GitHub Actions の windows ランナー）で、「LAN は繋がるが、インターネットには出られない」ときの
 * 起動（スプラッシュ → メイン画面）の待ちを測る。アプリのコードは変えない。公開済みのインストーラを入れて測る。
 *
 * 条件は 3 つ: normal／fw-blocked／dns-dead。
 *   🔴 fw-blocked は**即失敗**する（接続が 7 ms で拒否される。パケットを捨てて待たせるのではない）。DNS は別のサービスが引くので影響しない。
 *   報告の「待たされる」は、応答しない DNS サーバーに対する Windows の名前解決のタイムアウト（1+2+4+8 ≒ 15 秒）の形に近いので、
 *   dns-dead（アダプタの DNS を使われない私設アドレスにする）を足した。測定の前後で必ず元へ戻す。
 *
 * fw-blocked は、Windows ファイアウォールの**プログラム単位の送信ブロック**で作る:
 *   New-NetFirewallRule -Direction Outbound -Program <GRAPHY-Next.exe / 同梱 java.exe> -Action Block -RemoteAddress Internet
 * `Internet` はローカルサブネット以外。LAN には出られるが DNS サーバーやインターネットへのパケットは黙って捨てられ、
 * 接続や名前解決はタイムアウトまで待たされる。ループバックは対象外（アプリ内部の通信・Playwright の制御は影響を受けない）。
 * ランナー全体の送信は止めない（止めると job が GitHub と切れる）。
 *
 * 環境が効いていることを先に確かめる（正例・負例）: 同梱 java.exe で小さな Java（名前解決・外部への接続）を動かし、
 * ブロックなしでは速く、ブロックありでは待たされる／失敗することを数値で出す。効いていなければ測定は無効（未達）。
 *
 * 実行:  cd automator && npx tsx src/smoke/offlineStartupWin.ts --versions v0.5.2,v0.6.1 [--runs 2] [--out .results/offline-startup-win]
 * 前提: windows・gh（GH_TOKEN）・JDK（javac。環境確認の Java を作る）・ネットワーク（インストーラの取得）。
 * 結果: 標準出力と $GITHUB_STEP_SUMMARY に表、--out に各起動の標準出力ログ（JSON）。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "@playwright/test";

import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { renderSummary, type LogLine, type StartupRun } from "./offlineStartupSummary.js";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const VERSIONS = arg("versions", "v0.5.2,v0.6.1").split(",").map((s) => s.trim()).filter(Boolean);
const RUNS = Number(arg("runs", "2"));
const OUT = path.resolve(arg("out", path.join(AUTOMATOR_ROOT, ".results", "offline-startup-win")));
const REPO = "tatsunidas/GRAPHY-Next";
const BASE_PORT = 18200;
const RULE_PREFIX = "gn-offline-probe";

let passed = 0;
const failures: string[] = [];
const pendingNotes: string[] = [];
function check(cond: boolean, label: string, detail?: unknown): void {
  const d = detail === undefined ? "" : ` — ${JSON.stringify(detail)}`;
  if (cond) { passed++; console.log(`  [ok  ] ${label}${d}`); } else { console.log(`  [FAIL] ${label}${d}`); failures.push(label); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function ps(script: string): { out: string; status: number | null } {
  const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" });
  return { out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim(), status: r.status };
}

function addBlockRules(programs: string[]): void {
  programs.forEach((p, i) => {
    const r = ps(`New-NetFirewallRule -DisplayName '${RULE_PREFIX}-${i}' -Direction Outbound -Program '${p.replace(/'/g, "''")}' -Action Block -RemoteAddress Internet -Profile Any | Out-Null`);
    if (r.status !== 0) throw new Error(`ファイアウォール規則を作れません: ${r.out}`);
  });
}
function removeBlockRules(): void {
  ps(`Get-NetFirewallRule -DisplayName '${RULE_PREFIX}-*' -ErrorAction SilentlyContinue | Remove-NetFirewallRule`);
}

/** 既定経路のネットワークアダプタの番号。 */
function primaryInterface(): number {
  const r = ps("(Get-NetRoute -DestinationPrefix '0.0.0.0/0' | Sort-Object RouteMetric | Select-Object -First 1).InterfaceIndex");
  const n = Number(r.out.split(/\s+/).pop());
  if (!Number.isInteger(n) || n <= 0) throw new Error(`既定経路のアダプタを取れません: ${r.out}`);
  return n;
}
/** DNS サーバーを、応答しない宛先（使われない私設アドレス）にする。名前解決は Windows の既定のタイムアウト（約 15 秒）まで待たされる。 */
function deadDns(ifIndex: number): void {
  const r = ps(`Set-DnsClientServerAddress -InterfaceIndex ${ifIndex} -ServerAddresses '10.255.255.1'; Clear-DnsClientCache`);
  if (r.status !== 0) throw new Error(`DNS を切り替えられません: ${r.out}`);
}
/** DNS サーバーを元（DHCP の値）へ戻す。 */
function restoreDns(ifIndex: number): void {
  ps(`Set-DnsClientServerAddress -InterfaceIndex ${ifIndex} -ResetServerAddresses; Clear-DnsClientCache`);
}
/** 起動中に引かれた名前（DNS クライアントのキャッシュ）。直前に `Clear-DnsClientCache` しておくこと。 */
function dnsCacheNames(): string[] {
  const r = ps("Get-DnsClientCache | Select-Object -ExpandProperty Entry | Sort-Object -Unique");
  return r.out.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
}

function killApp(dir: string): void {
  spawnSync("taskkill", ["/F", "/T", "/IM", "GRAPHY-Next.exe"], { stdio: "ignore" });
  const d = dir.replace(/'/g, "''");
  ps(`Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'java.exe' -and $_.ExecutablePath -and $_.ExecutablePath.StartsWith('${d}', [System.StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`);
}

function installVersion(tag: string, work: string): { dir: string; exe: string; java: string } {
  const dl = path.join(work, "dl", tag);
  fs.mkdirSync(dl, { recursive: true });
  const g = spawnSync("gh", ["release", "download", tag, "--repo", REPO, "-p", "GRAPHY-Next.Setup.*.exe", "-D", dl], { encoding: "utf8" });
  if (g.status !== 0) throw new Error(`${tag} のインストーラを取得できません: ${g.stderr}`);
  const setup = path.join(dl, fs.readdirSync(dl).find((f) => /\.exe$/i.test(f))!);
  const dir = path.join(fs.realpathSync.native(work), `app-${tag}`);
  for (let attempt = 1; ; attempt++) {
    const r = spawnSync(setup, ["/S", `/D=${dir}`], { stdio: "inherit", timeout: 300_000 });
    if (r.status === 0) break;
    console.log(`  [情報] ${tag} のインストーラが失敗（${attempt} 回目）status=${r.status}`);
    if (attempt >= 2) throw new Error(`${tag} のインストールに失敗`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5_000);
  }
  return { dir, exe: path.join(dir, "GRAPHY-Next.exe"), java: path.join(dir, "resources", "jre", "bin", "java.exe") };
}

/** 環境の確認用の Java（名前解決・外部への接続の所要時間）を、ランナーの javac で作り、同梱 java.exe で動かす。 */
function buildNetProbe(work: string): string {
  const d = path.join(work, "netprobe");
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "NetProbe.java"), `
import java.net.*;
public class NetProbe {
  static long ms(long t0) { return (System.nanoTime() - t0) / 1_000_000; }
  public static void main(String[] a) {
    long t = System.nanoTime();
    try { InetAddress.getLocalHost().getHostName(); System.out.println("getLocalHost_ms=" + ms(t)); } catch (Exception e) { System.out.println("getLocalHost_ms=" + ms(t) + " ERR"); }
    t = System.nanoTime();
    try { InetAddress.getByName("api.github.com"); System.out.println("resolve_ms=" + ms(t)); } catch (Exception e) { System.out.println("resolve_ms=" + ms(t) + " ERR"); }
    t = System.nanoTime();
    try (Socket s = new Socket()) { s.connect(new InetSocketAddress("140.82.112.5", 443), 20000); System.out.println("connect_ms=" + ms(t)); } catch (Exception e) { System.out.println("connect_ms=" + ms(t) + " ERR"); }
  }
}
`);
  const c = spawnSync("javac", ["--release", "17", "-d", d, path.join(d, "NetProbe.java")], { encoding: "utf8" });
  if (c.status !== 0) throw new Error(`javac に失敗: ${c.stderr}${c.error?.message ?? ""}`);
  return d;
}
function runNetProbe(java: string, classDir: string): Record<string, number> {
  const r = spawnSync(java, ["-cp", classDir, "NetProbe"], { encoding: "utf8", timeout: 120_000 });
  const out: Record<string, number> = {};
  for (const m of String(r.stdout).matchAll(/(\w+)_ms=(\d+)(?: (ERR))?/g)) out[m[1] + (m[3] ? "_err" : "")] = Number(m[2]);
  return out;
}

async function launchOnce(tag: string, exe: string, appData: string, port: number, condition: StartupRun["condition"], index: number): Promise<StartupRun> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), GRAPHY_BACKEND_PORT: String(port), APPDATA: appData };
  delete env.GRAPHY_DEV;
  delete env.GRAPHY_BACKEND_EXTERNAL;
  const lines: LogLine[] = [];
  const t0 = Date.now();
  const rel = () => (Date.now() - t0) / 1000;
  const app = await electron.launch({ executablePath: exe, args: [], env, timeout: 120_000 });
  const onData = (b: Buffer) => { for (const l of b.toString("utf8").split(/\r?\n/)) if (l.trim()) lines.push({ t: rel(), text: l.trim() }); };
  app.process().stdout?.on("data", onData);
  app.process().stderr?.on("data", onData);
  let splashAt: number | null = null, mainAt: number | null = null, readyAt: number | null = null;
  const deadline = Date.now() + 150_000;
  while (Date.now() < deadline && (readyAt === null || mainAt === null)) {
    const wins = (await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((w: { webContents: { getURL(): string }; isVisible(): boolean }) => ({ url: w.webContents.getURL(), visible: w.isVisible() })),
    ).catch(() => [])) as { url: string; visible: boolean }[];
    if (splashAt === null && wins.some((w) => /splash\.html/.test(w.url) && w.visible)) splashAt = rel();
    if (mainAt === null && wins.some((w) => /renderer[\\/]index\.html/.test(w.url) && w.visible)) mainAt = rel();
    if (readyAt === null) {
      const ok = await fetch(`http://127.0.0.1:${port}/api/status`).then((r) => r.ok).catch(() => false);
      if (ok) readyAt = rel();
    }
    await sleep(250);
  }
  const timedOut = readyAt === null || mainAt === null;
  await app.close().catch(() => undefined);
  return { version: tag, condition, index, splashAt, backendReadyAt: readyAt, mainAt, timedOut, lines };
}

async function main(): Promise<void> {
  if (process.platform !== "win32") { console.log("  [未達] Windows 専用"); process.exitCode = 2; return; }
  fs.mkdirSync(OUT, { recursive: true });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "offline-start-"));
  const runs: StartupRun[] = [];
  const envChecks: Record<string, unknown> = {};
  const dnsNames: Record<string, string[]> = {};
  removeBlockRules();
  try {
    const probeDir = buildNetProbe(work);
    let portN = 0;
    for (const tag of VERSIONS) {
      console.log(`\n[${tag}] インストール`);
      const inst = installVersion(tag, work);
      check(fs.existsSync(inst.exe) && fs.existsSync(inst.java), `${tag}: インストールできた（GRAPHY-Next.exe と同梱 java.exe）`);

      console.log(`[${tag}] 環境の確認: 同梱 java.exe で名前解決・外部への接続（ブロックなし／あり）`);
      const free = runNetProbe(inst.java, probeDir);
      addBlockRules([inst.exe, inst.java]);
      const blocked = runNetProbe(inst.java, probeDir);
      removeBlockRules();
      console.log(`  ブロックなし: ${JSON.stringify(free)}`);
      console.log(`  ブロックあり: ${JSON.stringify(blocked)}`);
      envChecks[tag] = { free, blocked };
      const slowBlocked = (blocked.resolve ?? 0) >= 2000 || (blocked.connect ?? 0) >= 2000 || "resolve_err" in blocked || "connect_err" in blocked;
      const fastFree = (free.connect ?? 99999) < 2000 && !("connect_err" in free);
      check(fastFree, `${tag}: ブロックなしでは外部へ速く接続できる（環境の正例）`, free);
      check(slowBlocked, `${tag}: ブロックありでは待たされる／失敗する（環境の負例。効いていなければ測定は無効）`, blocked);
      if (!(fastFree && slowBlocked)) { pendingNotes.push(`${tag}: ブロックが効いていない（またはランナーが外へ出られない）ため、測定は無効`); continue; }

      const appData = path.join(work, `profile-${tag}`);
      fs.mkdirSync(appData, { recursive: true });
      killApp(inst.dir);
      console.log(`[${tag}] ウォームアップ（DB の初回作成。測定には使わない）`);
      const warm = await launchOnce(tag, inst.exe, appData, BASE_PORT + portN++, "normal", 0);
      killApp(inst.dir);
      check(!warm.timedOut, `${tag}: ウォームアップの起動が完了した`, { ready: warm.backendReadyAt, main: warm.mainAt });

      const ifIndex = primaryInterface();
      // DNS が応答しない状態の確認（環境の正例・負例）: 同梱 java.exe で、名前解決・getLocalHost が待たされること
      deadDns(ifIndex);
      let dead: Record<string, number> = {};
      try { dead = runNetProbe(inst.java, probeDir); } finally { restoreDns(ifIndex); }
      console.log(`  DNS 応答なし: ${JSON.stringify(dead)}`);
      (envChecks[tag] as Record<string, unknown>).dnsDead = dead;
      const dnsSlow = (dead.resolve ?? 0) >= 3000 || (dead.resolve_err ?? 0) >= 3000 || (dead.getLocalHost ?? 0) >= 3000;
      check(dnsSlow, `${tag}: DNS が応答しないと名前解決が待たされる（環境の負例。効いていなければ dns-dead の測定は無効）`, dead);
      if (!dnsSlow) pendingNotes.push(`${tag}: DNS を応答しない状態にできなかった（dns-dead の測定は無効）`);

      for (const condition of ["normal", "fw-blocked", ...(dnsSlow ? ["dns-dead" as const] : [])] as const) {
        if (condition === "fw-blocked") addBlockRules([inst.exe, inst.java]);
        if (condition === "dns-dead") deadDns(ifIndex);
        try {
          for (let i = 1; i <= RUNS; i++) {
            if (condition === "normal" && i === 1) ps("Clear-DnsClientCache");
            const run = await launchOnce(tag, inst.exe, appData, BASE_PORT + portN++, condition, i);
            if (condition === "normal" && i === 1) {
              dnsNames[tag] = dnsCacheNames(); // 通常の起動 1 回目に引かれた名前（キャッシュ）
              console.log(`  ${tag} 起動中に引かれた名前: ${JSON.stringify(dnsNames[tag])}`);
            }
            killApp(inst.dir);
            runs.push(run);
            console.log(`  ${tag} ${condition} #${i}: splash=${run.splashAt?.toFixed(1)} backend=${run.backendReadyAt?.toFixed(1)} main=${run.mainAt?.toFixed(1)}${run.timedOut ? " 時間切れ" : ""}`);
            check(!run.timedOut, `${tag} ${condition} #${i}: 起動が完了した（スプラッシュ → メイン画面・backend 応答）`);
            await sleep(3000);
          }
        } finally {
          if (condition === "fw-blocked") removeBlockRules();
          if (condition === "dns-dead") restoreDns(ifIndex);
        }
      }
    }
  } finally {
    removeBlockRules();
    try { restoreDns(primaryInterface()); } catch { /* 取れなければ戻す対象も無い */ }
    killApp(fs.realpathSync.native(work));
  }

  const md = renderSummary(runs);
  console.log(`\n${md}\n`);
  fs.writeFileSync(path.join(OUT, "runs.json"), JSON.stringify({ runs, envChecks, dnsNames }, null, 2));
  fs.writeFileSync(path.join(OUT, "summary.md"), md);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## 起動の待ち（Windows 実機・インターネットだけ遮断）\n\n${md}\n\n環境の確認: \`${JSON.stringify(envChecks)}\`\n\n起動中に引かれた名前: \`${JSON.stringify(dnsNames)}\`\n`);
  }
  for (const n of pendingNotes) console.log(`  [未達] ${n}`);
}

main()
  .then(() => { console.log(`\n${passed} passed, ${failures.length} failed, 未達 ${pendingNotes.length}`); process.exit(process.exitCode || (failures.length === 0 ? 0 : 1)); })
  .catch((e) => { console.error(e); try { removeBlockRules(); } catch { /* 無視 */ } process.exit(2); });
