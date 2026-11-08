/*
 * アプリ内の自動更新の「本物」の通し確認（GitHub Actions の実 OS 用）。アプリのコードは変えない。
 * 製品のコード（desktop/appUpdate.js・minisign.js）を require して、実際の GitHub のリリースで通す。
 *
 *   --mode published  本物の `releases/latest` を、製品のコード（pickAsset・fetchText・downloadToFile・verifyFile）で
 *                     取得・検証する（API の digest・資産名・署名・リダイレクト先のホスト検査まで）。
 *   --mode draft      下書きの新版（未認証では見えない）を `gh release download`（ジョブのトークン）で取得し、
 *                     SHA-256（API の digest）と署名（製品の minisign.js・公式鍵・trusted comment）を検証する。
 *                     ※ 製品のダウンロード経路（ホスト検査・リダイレクト）は通らない。それは published で。
 *
 * Windows: 旧版（公開済み）を入れて起動し版を確かめる → 旧い版の印と利用者データの印 → 新版を取得・検証 →
 *          アプリが使う引数のとおり `Setup.exe --updated /S --force-run` → 旧い版の印が消えた・利用者データが残った・
 *          起動した新しいアプリの backend が新しい版を返す。
 * Linux（published のみ）: 旧版の AppImage → 新版を取得・検証 → `buildApplyPlan`/`executeApplyPlan`（今すぐ）で置き換え・再起動 →
 *          新しい版を返す。
 * 負例（published）: 署名を 1 文字壊す／別の版の trusted comment を期待する／信頼していない鍵 → 製品のコードが拒否する。
 *
 * 実行:  cd automator && npx tsx src/smoke/updateE2e.ts --mode draft|published --old v0.6.1 --new v0.6.2
 * 前提: gh（GH_TOKEN）。Linux は xvfb-run の下で、kernel.apparmor_restrict_unprivileged_userns=0（CI のみ）。
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { assetNameFor, renderChecks, tally, tamperSignature, versionOfTag, type Check } from "./updateE2eLogic.js";

const require = createRequire(import.meta.url);
const au = require("../../../desktop/appUpdate.js");
const ms = require("../../../desktop/minisign.js");
const KEYS: string[] = require("../../../desktop/update-trusted-keys.json").keys;
const OTHER_PUB = fs.readFileSync(path.resolve(import.meta.dirname, "../../../desktop/testdata/appupdate/other.pub"), "utf8");

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const MODE = arg("mode", "draft") as "draft" | "published";
const OLD_TAG = arg("old", "v0.6.1");
const NEW_TAG = arg("new", "v0.6.2");
const OLD_VER = versionOfTag(OLD_TAG);
const NEW_VER = versionOfTag(NEW_TAG);
const REPO = "tatsunidas/GRAPHY-Next";
const PORT = 8080; // 製品版の既定（desktop/config.json）
const PLATFORM = process.platform as "win32" | "linux";
const checks: Check[] = [];
const ck = (label: string, ok: boolean | null, detail?: unknown) => {
  checks.push({ label, ok, detail });
  console.log(`  [${ok === true ? "ok  " : ok === false ? "FAIL" : "未達"}] ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail).slice(0, 200)}`}`);
};
const sleep = (n: number) => new Promise((r) => setTimeout(r, n));

function gh(args: string[]): string {
  const r = spawnSync("gh", args, { encoding: "utf8", maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error(`gh ${args.join(" ")} に失敗: ${r.stderr}`);
  return r.stdout;
}

async function apiLatest(): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = { "User-Agent": "GRAPHY-Next-e2e", Accept: "application/vnd.github+json" };
  if (process.env.GH_TOKEN) headers.Authorization = `Bearer ${process.env.GH_TOKEN}`; // API の呼び出しだけ（共有 IP のレート制限を避ける）。資産の取得は未認証の製品のコード
  const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers });
  if (!r.ok) throw new Error(`releases/latest: HTTP ${r.status}`);
  return (await r.json()) as Record<string, unknown>;
}

async function statusVersion(): Promise<string | null> {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/status`);
    if (!r.ok) return null;
    return String(((await r.json()) as { version?: string }).version ?? "");
  } catch { return null; }
}
async function waitVersion(expect: string, timeoutMs: number): Promise<string | null> {
  const end = Date.now() + timeoutMs;
  let last: string | null = null;
  while (Date.now() < end) {
    last = await statusVersion();
    if (last === expect) return last;
    await sleep(2000);
  }
  return last;
}

function sha256File(f: string): string {
  const h = crypto.createHash("sha256");
  h.update(fs.readFileSync(f));
  return h.digest("hex");
}

/** 取得した新版を、製品のコードで検証する（正例）＋ 負例。published は製品の取得経路、draft は gh で取った実ファイル。 */
async function fetchAndVerifyNew(dir: string): Promise<{ file: string; plan?: Record<string, any> } | null> {
  const name = assetNameFor(PLATFORM, NEW_VER);
  const expectTrusted = `graphy-next v${NEW_VER} ${name}`;
  let file = path.join(dir, name);
  let sigText = "";
  let plan: Record<string, any> | undefined;

  if (MODE === "published") {
    const rel = await apiLatest();
    ck(`releases/latest が ${NEW_TAG}`, rel.tag_name === NEW_TAG, rel.tag_name);
    plan = au.pickAsset(rel, {
      platform: PLATFORM, arch: process.arch, currentVersion: OLD_VER,
      appImage: PLATFORM === "linux" ? path.join(dir, "old", assetNameFor("linux", OLD_VER)) : null,
      appImageDirWritable: true,
    });
    ck("製品の pickAsset が自動更新できる資産を選ぶ", plan?.supported === true, plan?.supported ? { asset: plan.asset.name, size: plan.asset.size, hasDigest: !!plan.asset.sha256 } : plan);
    if (!plan?.supported) return null;
    ck("資産名・trusted comment が期待どおり", plan.asset.name === name && plan.expectTrusted === expectTrusted, { name: plan.asset.name, expectTrusted: plan.expectTrusted });
    const t0 = Date.now();
    sigText = await au.fetchText(plan.sig.url, {});
    ck("製品の fetchText で .minisig を取得できた", sigText.includes("trusted comment"), { bytes: sigText.length });
    try {
      await au.downloadToFile(plan.asset.url, file, { size: plan.asset.size, sha256: plan.asset.sha256 }, { stallMs: 60_000 });
      ck("製品の downloadToFile で本体を取得（GitHub のホスト検査・リダイレクト・サイズ・SHA-256〔API の digest〕）", true, { seconds: Math.round((Date.now() - t0) / 1000), bytes: fs.statSync(file).size });
    } catch (e) {
      ck("製品の downloadToFile で本体を取得", false, String((e as Error).message));
      return null;
    }
  } else {
    gh(["release", "download", NEW_TAG, "--repo", REPO, "-p", `${name}*`, "-D", dir]);
    sigText = fs.readFileSync(`${file}.minisig`, "utf8");
    const assets = JSON.parse(gh(["release", "view", NEW_TAG, "--repo", REPO, "--json", "assets"])) as { assets: { name: string; digest?: string; size: number }[] };
    const a = assets.assets.find((x) => x.name === name);
    ck("下書きの資産と署名が揃っている", !!a && fs.existsSync(`${file}.minisig`), { name });
    const digest = /^sha256:([0-9a-f]{64})$/i.exec(a?.digest ?? "")?.[1];
    ck("API の digest（sha256）が付いている", !!digest);
    ck("取得した本体のサイズ・SHA-256 が API と一致", !!a && fs.statSync(file).size === a.size && sha256File(file) === digest, { size: fs.statSync(file).size });
  }

  // 署名: 製品の minisign.js（公式鍵・trusted comment）
  const digest: Buffer = await ms.blake2bFile(file);
  const good = ms.verifyDigest(digest, sigText, KEYS, { expectTrusted });
  ck("公式鍵の署名が通る（製品の minisign.js。trusted comment が版・ファイル名と一致）", good.ok === true, good);
  if (good.ok !== true) return null;
  // 負例（取得物の署名を壊す／別の版を期待する／信頼していない鍵）→ 製品のコードが拒否する
  const bad1 = ms.verifyDigest(digest, tamperSignature(sigText), KEYS, { expectTrusted });
  ck("負例: 署名を 1 文字壊すと拒否される（bad-signature）", bad1.reason === "bad-signature", bad1);
  const bad2 = ms.verifyDigest(digest, sigText, KEYS, { expectTrusted: `graphy-next v${OLD_VER} ${assetNameFor(PLATFORM, OLD_VER)}` });
  ck("負例: 別の版を期待すると拒否される（trusted-comment-mismatch。ダウングレード対策）", bad2.reason === "trusted-comment-mismatch", bad2);
  const bad3 = ms.verifyDigest(digest, sigText, [OTHER_PUB], { expectTrusted });
  ck("負例: 信頼していない鍵では拒否される（unknown-key）", bad3.reason === "unknown-key", bad3);
  const flipped = Buffer.from(digest); flipped[0] ^= 1;
  const bad4 = ms.verifyDigest(flipped, sigText, KEYS, { expectTrusted });
  ck("負例: 本体のダイジェストが違うと拒否される（bad-signature）", bad4.reason === "bad-signature", bad4);
  return { file, plan };
}

// ── Windows ──────────────────────────────────────────────────────────────
function ps(script: string): string {
  const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" });
  return `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
}
function winKill(dir: string): void {
  spawnSync("taskkill", ["/F", "/T", "/IM", "GRAPHY-Next.exe"], { stdio: "ignore" });
  const d = dir.replace(/'/g, "''");
  ps(`Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'java.exe' -and $_.ExecutablePath -and $_.ExecutablePath.StartsWith('${d}', [System.StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`);
}
function runInstaller(setup: string, args: string[]): number {
  for (let attempt = 1; ; attempt++) {
    const r = spawnSync(setup, args, { stdio: "inherit", timeout: 300_000 });
    if (r.status === 0) return 0;
    console.log(`  [情報] インストーラが失敗（${attempt} 回目）status=${r.status}`);
    if (attempt >= 2) return r.status ?? -1;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5_000);
  }
}

async function windowsFlow(): Promise<void> {
  const work = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "update-e2e-")));
  const dir = path.join(work, "app");
  const appData = process.env.APPDATA!;
  const userMarker = path.join(appData, "GRAPHY-Next", "update-e2e-marker.txt");
  try {
    console.log(`\n[1] 旧版（公開済み ${OLD_TAG}）を入れて起動し、版を確かめる`);
    const oldDl = path.join(work, "old");
    fs.mkdirSync(oldDl, { recursive: true });
    gh(["release", "download", OLD_TAG, "--repo", REPO, "-p", assetNameFor("win32", OLD_VER), "-D", oldDl]);
    ck("旧版のインストーラが無人で入った", runInstaller(path.join(oldDl, assetNameFor("win32", OLD_VER)), ["/S", `/D=${dir}`]) === 0);
    const exe = path.join(dir, "GRAPHY-Next.exe");
    ck("旧版の GRAPHY-Next.exe がある", fs.existsSync(exe));
    ck("更新の前に、ポートは空いている", (await statusVersion()) === null);
    const old: ChildProcess = spawn(exe, [], { detached: true, stdio: "ignore" });
    old.unref();
    const v0 = await waitVersion(OLD_VER, 180_000);
    ck(`旧版が起動して backend が旧い版（${OLD_VER}）を返す`, v0 === OLD_VER, v0);
    winKill(dir);
    await sleep(4000);

    console.log("\n[2] 旧い版の印と利用者データの印を置く");
    const sentinel = path.join(dir, "resources", "old-version-sentinel.txt");
    fs.writeFileSync(sentinel, "old");
    fs.mkdirSync(path.dirname(userMarker), { recursive: true });
    fs.writeFileSync(userMarker, "user data must survive");

    console.log(`\n[3] 新版（${NEW_TAG}、${MODE}）を取得・検証する`);
    const got = await fetchAndVerifyNew(work);
    if (!got) { ck("新版の取得・検証が完了した", false); return; }

    console.log("\n[4] アプリが使う引数のとおり: Setup.exe --updated /S --force-run");
    ck("サイレント更新のインストーラが成功した", runInstaller(got.file, ["--updated", "/S", "--force-run"]) === 0);
    ck("旧い版の印が消えた（同じ場所に入れ替わった）", !fs.existsSync(sentinel));
    ck("利用者データが残っている", fs.existsSync(userMarker) && fs.readFileSync(userMarker, "utf8") === "user data must survive");
    ck("インストール先は同じ", fs.existsSync(exe));
    const v1 = await waitVersion(NEW_VER, 180_000);
    ck(`--force-run で起動した新しいアプリの backend が新しい版（${NEW_VER}）を返す（版が上がった）`, v1 === NEW_VER, v1);
  } finally {
    winKill(work);
    try { fs.rmSync(userMarker, { force: true }); } catch { /* 無視 */ }
  }
}

// ── Linux（published のみ）────────────────────────────────────────────────
async function linuxFlow(): Promise<void> {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "update-e2e-"));
  const appDir = path.join(work, "old");
  fs.mkdirSync(appDir, { recursive: true });
  const appImage = path.join(appDir, assetNameFor("linux", OLD_VER));
  const env = { ...process.env, APPIMAGE_EXTRACT_AND_RUN: "1" };
  let proc: ChildProcess | null = null;
  const stop = () => { if (proc?.pid) { try { process.kill(-proc.pid, "SIGKILL"); } catch { /* 既に終了 */ } } };
  try {
    console.log(`\n[1] 旧版の AppImage（公開済み ${OLD_TAG}）を置いて起動し、版を確かめる`);
    gh(["release", "download", OLD_TAG, "--repo", REPO, "-p", assetNameFor("linux", OLD_VER), "-D", appDir]);
    fs.chmodSync(appImage, 0o755);
    ck("更新の前に、ポートは空いている", (await statusVersion()) === null);
    proc = spawn(appImage, [], { detached: true, stdio: "ignore", env });
    const v0 = await waitVersion(OLD_VER, 240_000);
    ck(`旧版が起動して backend が旧い版（${OLD_VER}）を返す`, v0 === OLD_VER, v0);
    stop();
    spawnSync("pkill", ["-f", "graphy-next-backend.jar"], { stdio: "ignore" });
    await sleep(5000);

    console.log(`\n[2] 新版（${NEW_TAG}、${MODE}）を製品のコードで取得・検証する`);
    const got = await fetchAndVerifyNew(work);
    if (!got) { ck("新版の取得・検証が完了した", false); return; }

    console.log("\n[3] 製品の適用（今すぐ）: AppImage を置き換えて新しいものを起動する");
    const ap = au.buildApplyPlan("appimage", got.file, "now", { appImage });
    ck("適用の計画が置き換え＋再起動", ap.kind === "replace-appimage" && ap.relaunch === true, ap);
    const before = fs.statSync(appImage).size;
    // 製品の再起動は process.env を引き継ぐ。CI には FUSE が無いので、旧版の起動と同じ指定を親の環境に置く
    process.env.APPIMAGE_EXTRACT_AND_RUN = "1";
    au.executeApplyPlan(ap);
    ck("旧い AppImage が新しい中身に入れ替わった", fs.statSync(appImage).size === fs.statSync(got.file).size && fs.statSync(appImage).size !== before, { before, after: fs.statSync(appImage).size });
    ck("実行権限が付いている", (fs.statSync(appImage).mode & 0o111) !== 0);
    ck("一時ファイル（.new）が残っていない", fs.readdirSync(appDir).filter((f) => f.endsWith(".new")).length === 0);
    const v1 = await waitVersion(NEW_VER, 240_000);
    ck(`再起動された新しいアプリの backend が新しい版（${NEW_VER}）を返す（版が上がった）`, v1 === NEW_VER, v1);
  } finally {
    stop();
    spawnSync("pkill", ["-f", "graphy-next-backend.jar"], { stdio: "ignore" });
  }
}

async function main(): Promise<void> {
  console.log(`[設定] mode=${MODE} old=${OLD_TAG} new=${NEW_TAG} os=${PLATFORM}`);
  try {
    if (PLATFORM === "win32") await windowsFlow();
    else if (PLATFORM === "linux") {
      if (MODE !== "published") ck("Linux の通し（published のみ。下書きの AppImage は製品の取得経路で通せない）", null, "draft モードでは実施しない");
      else await linuxFlow();
    } else ck("この OS は対象外", null, PLATFORM);
  } catch (e) {
    ck("通しが完走した", false, String((e as Error).stack ?? e).slice(0, 400));
  }
  const md = renderChecks(checks);
  console.log(`\n${md}`);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## 自動更新の通し確認（${PLATFORM}・${MODE}・${OLD_TAG} → ${NEW_TAG}）\n\n${md}\n`);
  const t = tally(checks);
  process.exit(t.fail === 0 ? 0 : 1);
}

void main();
