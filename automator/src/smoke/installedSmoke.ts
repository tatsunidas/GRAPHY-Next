/*
 * 配布物スモーク: できあがったインストーラを**実際に入れて**起動し、動画を 1 本開いて再生する。
 *
 * 実行:  cd automator && npx tsx src/smoke/installedSmoke.ts [--dist ../desktop/dist] [--out .results/installed-smoke] [--port 18190]
 *          [--linux-package appimage|deb]
 *   Linux は表示が要るので CI では `xvfb-run -a` を付ける。
 *   Linux の deb は `sudo apt-get install` で実際に入れ、`--no-sandbox` を付けずに起動する。Ubuntu 24.04 の
 *   AppArmor（unprivileged userns の制限）の下でも Chromium の sandbox が動くことの検査を兼ねる（v0.4.0 の
 *   AppImage はここで落ちた。2026-10-16）。
 *
 * <h3>なぜ要るのか</h3>
 * check-packaged.js は app.asar の**中身（静的）**しか見ない。次の事故は静的検査も開発版の automator も素通りした
 * （fw/release-checklist.md の冒頭）:
 *   - v0.3.0〜0.3.2: `build.files` の載せ忘れで、インストールした製品版が起動直後に落ちた（開発版は desktop/ を直接読むので動く）
 *   - v0.3.3: 画面の CSP に `media-src` が無く、製品版だけ動画が真っ黒だった（dev の Vite serve は CSP を注入しない）
 *   - v0.2.7: 再生ボタンが効かないまま公開した（押した検査をしていなかった）
 * automator の DesktopDriver は `GRAPHY_DEV=1`＋Vite＋外部 backend の**開発版専用**なので、ここは別に
 * 「インストール → `GRAPHY_DEV` 無しで起動」を持つ。開いた後の操作は videoIn2dViewerCheck と同じ手順。
 *
 * <h3>確かめること</h3>
 *   1. インストーラを無人で入れられる（Windows: NSIS /S、macOS: dmg の .app、Linux: AppImage 展開 / deb を apt で）
 *   2. 製品版が起動して、メイン画面が出る・同梱 backend が /api/status に 200 を返す
 *   3. 画面に **CSP 違反・未捕捉エラーが出ていない**
 *   4. **同梱の ffmpeg が動く**（検査用動画の合成と、非 H.264 動画のトランスコード取込に使う）
 *   5. 動画を取り込み、2D ビューアで開けて、**再生ボタンを押すとフレームが進み、もう一度押すと止まる**
 *
 * ⚠ このスクリプトは**クリーンな環境で起動すること**の保証で、「どの端末でも動く」保証ではない。
 *    見た目・操作感・病院端末固有の事情（AV ソフト・日本語パス・権限）は人が見る。
 * ⚠ ユーザーデータ（DB・設定）は実プロファイルを避けて一時ディレクトリへ向ける（Linux: XDG_CONFIG_HOME、Windows: APPDATA）。
 *    macOS は HOME を変えるとキーチェーンが絡むので向けない。CI 以外（CI=true 無し）では実行を断る。
 */
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";

import { importNonDicomPaths } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { waitForMainScreenReady } from "../checklist/items/shared/helpers.js";
import { seedViewerSettings } from "../backend/seedSettings.js";
import { dismissStartupDialogs } from "../common/dismissDialogs.js";
import { killProcessTree } from "../common/processUtils.js";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const DIST = path.resolve(arg("dist", path.join(AUTOMATOR_ROOT, "..", "desktop", "dist")));
const OUT = path.resolve(arg("out", path.join(AUTOMATOR_ROOT, ".results", "installed-smoke")));
const PORT = Number(arg("port", "18190"));
const LINUX_PACKAGE = arg("linux-package", "appimage");
/** 実際にローカル AI（llama.cpp とモデル、約 2 GB）を取得して動かす節 [7]。時間と通信が要るので指定したときだけ。 */
const LOCAL_AI = process.argv.includes("--local-ai");

const failures: string[] = [];
let passed = 0;
function check(cond: boolean, label: string, detail?: unknown): void {
  const d = detail === undefined ? "" : ` — ${JSON.stringify(detail)}`;
  if (cond) {
    passed++;
    console.log(`  [ok  ] ${label}${d}`);
  } else {
    console.log(`  [FAIL] ${label}${d}`);
    failures.push(label);
  }
}

/** インストール済みアプリの場所。 */
interface Installed {
  exe: string;
  /** `resources/`（extraResources の ffmpeg・jre などがある所） */
  resources: string;
  /** 起動時に足す引数 */
  args: string[];
}

function findInstaller(ext: RegExp, exclude?: RegExp): string {
  const files = fs.readdirSync(DIST).filter((f) => ext.test(f) && !(exclude && exclude.test(f)));
  if (files.length !== 1) {
    throw new Error(`${DIST} にインストーラが 1 つだけある想定ですが ${files.length} 個です: ${JSON.stringify(files)}`);
  }
  return path.join(DIST, files[0]);
}

function install(root: string): Installed {
  fs.mkdirSync(root, { recursive: true });
  if (process.platform === "win32") {
    const setup = findInstaller(/\.exe$/i, /uninstall/i);
    const dir = path.join(root, "app");
    console.log(`[install] NSIS 無人インストール: ${path.basename(setup)} → ${dir}`);
    // /D= は最後・引用符なし（NSIS の決まり）。perMachine=false なので管理者権限は要らない。
    execFileSync(setup, ["/S", `/D=${dir}`], { stdio: "inherit", timeout: 300_000 });
    return { exe: path.join(dir, "GRAPHY-Next.exe"), resources: path.join(dir, "resources"), args: [] };
  }
  if (process.platform === "darwin") {
    const dmg = findInstaller(/\.dmg$/i);
    const mnt = path.join(root, "mnt");
    fs.mkdirSync(mnt, { recursive: true });
    console.log(`[install] dmg をマウントして .app をコピー: ${path.basename(dmg)}`);
    execFileSync("hdiutil", ["attach", "-nobrowse", "-readonly", "-mountpoint", mnt, dmg], { stdio: "inherit" });
    try {
      const app = fs.readdirSync(mnt).find((f) => f.endsWith(".app"));
      if (!app) throw new Error(`dmg の中に .app がありません: ${JSON.stringify(fs.readdirSync(mnt))}`);
      execFileSync("cp", ["-R", path.join(mnt, app), path.join(root, app)], { stdio: "inherit" });
      const appDir = path.join(root, app);
      return {
        exe: path.join(appDir, "Contents", "MacOS", app.replace(/\.app$/, "")),
        resources: path.join(appDir, "Contents", "Resources"),
        args: [],
      };
    } finally {
      spawnSync("hdiutil", ["detach", mnt, "-force"], { stdio: "ignore" });
    }
  }
  if (LINUX_PACKAGE === "deb") {
    const deb = findInstaller(/\.deb$/i);
    console.log(`[install] deb を apt で入れる: ${path.basename(deb)}`);
    execFileSync("sudo", ["apt-get", "install", "-y", deb], { stdio: "inherit", timeout: 300_000 });
    // 利用者と同じく sandbox を有効にしたまま起動する（--no-sandbox を付けない）。
    const dir = "/opt/GRAPHY-Next";
    return { exe: path.join(dir, "graphy-next-desktop"), resources: path.join(dir, "resources"), args: [] };
  }
  const image = findInstaller(/\.AppImage$/i);
  fs.chmodSync(image, 0o755);
  console.log(`[install] AppImage を展開: ${path.basename(image)}`);
  // FUSE が無い環境（CI）でも動くよう、実行ではなく展開する。
  execFileSync(image, ["--appimage-extract"], { cwd: root, stdio: "inherit" });
  const sq = path.join(root, "squashfs-root");
  // AppRun（シェルのラッパー）ではなく Electron 本体を直接起動する（Playwright が繋げるのは本体）。
  // 本体 = 最上位の実行ファイルのうち、AppRun・chrome-sandbox・crashpad を除いた最大のもの。
  const skip = new Set(["AppRun", "chrome-sandbox", "chrome_crashpad_handler"]);
  const bin = fs
    .readdirSync(sq, { withFileTypes: true })
    .filter((e) => e.isFile() && !skip.has(e.name) && (fs.statSync(path.join(sq, e.name)).mode & 0o111) !== 0)
    .map((e) => ({ name: e.name, size: fs.statSync(path.join(sq, e.name)).size }))
    .sort((a, b) => b.size - a.size)[0];
  if (!bin) throw new Error(`展開結果に Electron 本体が見つかりません: ${JSON.stringify(fs.readdirSync(sq))}`);
  // chrome-sandbox の SUID が付かない環境なので --no-sandbox（ランナー専用。製品の起動オプションではない）。
  return { exe: path.join(sq, bin.name), resources: path.join(sq, "resources"), args: ["--no-sandbox"] };
}

function findFile(dir: string, names: string[]): string | null {
  if (!fs.existsSync(dir)) return null;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      const r = findFile(p, names);
      if (r) return r;
    } else if (names.includes(e.name)) return p;
  }
  return null;
}

/** 画面の異常（CSP 違反・未捕捉エラー）を集める。 */
const pageProblems: string[] = [];
function watchPage(p: Page, tag: string): void {
  p.on("console", (m) => {
    const t = m.text();
    if (m.type() === "error" && /Content Security Policy|Refused to (load|connect|apply|create)/i.test(t)) {
      pageProblems.push(`[${tag}] ${t}`);
    }
  });
  p.on("pageerror", (e) => pageProblems.push(`[${tag}] pageerror: ${e.message}`));
}

async function findWindow(app: ElectronApplication, match: (url: string) => boolean, ms: number): Promise<Page | null> {
  const deadline = Date.now() + ms;
  for (;;) {
    const w = app.windows().find((x) => match(x.url()));
    if (w) return w;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function seekState(p: Page): Promise<{ value: number; max: number; canvasW: number; canvasH: number }> {
  return JSON.parse(
    (await p.evaluate(`(() => {
      const seek = document.querySelector('[data-testid="video-seek"]');
      const c = document.querySelector('[data-testid="video-viewport-host"] canvas');
      return JSON.stringify({
        value: seek ? Number(seek.value) : -1,
        max: seek ? Number(seek.max) : -1,
        canvasW: c ? c.width : 0,
        canvasH: c ? c.height : 0,
      });
    })()`)) as string,
  );
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

type Bridge = Record<string, (...a: unknown[]) => Promise<any>>; // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * [7] ローカル AI: 本物の取得経路（許可ホスト・302・sha256）で導入 → 起動 → 会話 → 終了で残らない、を実 OS で確かめる。
 * アプリ本体は変えない。確認ダイアログ（showMessageBoxSync）だけ、利用者が「ダウンロードする」を押した扱いに差し替える。
 * 返り値は、後で終了を確かめる llama-server の PID（記録が無ければ null）。
 */
async function localAiSection(app: ElectronApplication, main: Page): Promise<{ pid: number | null; sttPid: number | null; dataDir: string }> {
  const call = <T,>(expr: string): Promise<T> => main.evaluate(expr) as Promise<T>;
  const dataDir = await app.evaluate(({ app: a }) => a.getPath("appData") + "/GRAPHY-Next");
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBoxSync = (() => 0) as typeof dialog.showMessageBoxSync;
  });

  const st0 = await call<Record<string, any>>(`window.graphyDesktop.aiLocalStatus()`); // eslint-disable-line @typescript-eslint/no-explicit-any
  check(st0.supported === true, "[7] この OS・CPU でローカル AI が対応している", { platform: st0.platform });
  check(st0.runtime.installed === false && st0.model.installed === false, "[7] 導入前は runtime もモデルも未導入（前提）", { runtime: st0.runtime.installed, model: st0.model.installed });
  if (!st0.supported) return { pid: null, sttPid: null, dataDir };

  // 負例: 確認ダイアログで「取り消す」(1) を返したら、何も取得しない。
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBoxSync = (() => 1) as typeof dialog.showMessageBoxSync;
  });
  const canceled = await call<{ ok: boolean; error?: string }>(`window.graphyDesktop.aiLocalInstall(${JSON.stringify(st0.defaultModelId)})`);
  const st1 = await call<Record<string, any>>(`window.graphyDesktop.aiLocalStatus()`); // eslint-disable-line @typescript-eslint/no-explicit-any
  check(canceled.ok === false && canceled.error === "canceled" && st1.runtime.installed === false, "[7] 負例: 確認で取り消すと取得せず canceled", { canceled, runtime: st1.runtime.installed });
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBoxSync = (() => 0) as typeof dialog.showMessageBoxSync;
  });

  console.log(`  [情報] ローカル AI 導入開始: ${st0.defaultModelId} (${st0.platform})`);
  const t0 = Date.now();
  const inst = await call<{ ok: boolean; error?: string }>(`window.graphyDesktop.aiLocalInstall(${JSON.stringify(st0.defaultModelId)})`);
  console.log(`  [情報] 導入に ${Math.round((Date.now() - t0) / 1000)} 秒: ${JSON.stringify(inst)}`);
  check(inst.ok === true, "[7] ★ローカル AI を取得・検証・展開できる（sha256 一致）", inst);
  if (!inst.ok) return { pid: null, sttPid: null, dataDir };
  const st2 = await call<Record<string, any>>(`window.graphyDesktop.aiLocalStatus()`); // eslint-disable-line @typescript-eslint/no-explicit-any
  check(st2.runtime.installed === true && st2.model.installed === true && st2.model.verified === true, "[7] runtime とモデルが導入済み（モデルは検証済み）", { runtime: st2.runtime.installed, model: st2.model });
  check(st2.registered === true, "[7] 提供元 local-llm が登録された", { registered: st2.registered });

  const chk = await call<{ ok: boolean; error?: string; startedMs?: number; log?: string }>(`window.graphyDesktop.aiLocalCheck()`);
  check(chk.ok === true, "[7] ★llama-server が起動して /health が 200 を返す", { ok: chk.ok, error: chk.error, startedMs: chk.startedMs, log: (chk.log ?? "").slice(-600) });
  console.log(`  [情報] 起動テスト: ${JSON.stringify({ ok: chk.ok, startedMs: chk.startedMs })}`);

  const cfg = await call<{ providers: { id: string; endpoint?: string; auth?: unknown }[] }>(`window.graphyDesktop.aiProvidersGet()`);
  const prov = cfg.providers.find((x) => x.id === "local-llm");
  check(!!prov && /^http:\/\/127\.0\.0\.1:\d+$/.test(String(prov.endpoint)) && (prov.auth === "none" || (prov.auth as { type?: string })?.type === "none" || prov.auth === undefined), "[7] local-llm の宛先は 127.0.0.1 だけ・鍵なし", { endpoint: prov?.endpoint, auth: prov?.auth });

  const role = await call<{ ok: boolean }>(`window.graphyDesktop.aiLocalRole({ fallback: true, makeDefault: true })`);
  check(role.ok === true, "[7] 会話の既定先と縮退先をローカルにできる", role);

  // 実会話: アシスタント窓から。モデルの中身は問わず、空でない応答が返ること。
  await main.evaluate(() => { window.location.hash = "#assistant"; });
  await main.waitForFunction(() => window.location.hash === "#assistant");
  const t1 = Date.now();
  const chat = await main.evaluate(
    (req) => (window as unknown as { graphyDesktop: Bridge }).graphyDesktop.aiChat(req),
    { sessionId: "smoke-local", messages: [{ role: "user", text: "Reply with one short word." }] },
  ) as { ok: boolean; text?: string; error?: string; provenance?: { providerId?: string } };
  console.log(`  [情報] 会話 ${Date.now() - t1} ms: ${JSON.stringify({ ok: chat.ok, textLen: (chat.text ?? "").length, error: chat.error, provider: chat.provenance?.providerId })}`);
  check(chat.ok === true && (chat.text ?? "").trim().length > 0, "[7] ★ローカルモデルが会話に応答する（空でない）", { ok: chat.ok, error: chat.error, textLen: (chat.text ?? "").length });
  check(chat.provenance?.providerId === "local-llm", "[7] 応答の由来が local-llm", chat.provenance);
  await main.screenshot({ path: path.join(OUT, "4-assistant-local.png") }).catch(() => {});

  let pid: number | null = null;
  try {
    pid = (JSON.parse(fs.readFileSync(path.join(dataDir, "local-ai", "server.json"), "utf8")) as { pid: number }).pid;
  } catch { /* 記録が無ければ下の検査で失敗になる */ }
  check(pid !== null && pidAlive(pid), "[7] 会話中は llama-server のプロセスが生きている（記録した PID）", { pid });

  // [7b] 音声入力（任意で導入するローカルの文字起こし）。実モデル(Qwen3-ASR)に実音声を通す。
  const sttPid = await localSttSection(main, st2, dataDir);
  return { pid, sttPid, dataDir };
}

/**
 * 実音声の固定サンプル（ジョン・F・ケネディの演説の一部 11 秒。米国政府の著作物でパブリックドメイン。whisper.cpp の samples/jfk.wav）。
 * 取得元は commit で固定し、sha256 を確かめる。同梱はしない（バイナリをリポジトリに置かない）。
 */
const JFK_URL = "https://raw.githubusercontent.com/ggml-org/whisper.cpp/b0a11594aec50892a02cd8d129eee2dfe93a8bb8/samples/jfk.wav";
const JFK_SHA256 = "59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e";

/** [7b] ローカル音声入力: 導入 → 起動 → 実音声の文字起こし。返り値は stt の llama-server の PID（記録が無ければ null）。 */
async function localSttSection(main: Page, st: Record<string, any>, dataDir: string): Promise<number | null> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const call = <T,>(expr: string): Promise<T> => main.evaluate(expr) as Promise<T>;
  const sttId = st.stt?.defaultModelId as string | undefined;
  check(!!sttId && st.stt.installed === false, "[7b] 音声入力のモデルが一覧にあり、導入前は未導入（前提）", { sttId, installed: st.stt?.installed });
  if (!sttId) return null;
  const t0 = Date.now();
  const inst = await call<{ ok: boolean; error?: string }>(`window.graphyDesktop.aiLocalInstall(${JSON.stringify(sttId)})`);
  console.log(`  [情報] 音声入力の導入に ${Math.round((Date.now() - t0) / 1000)} 秒: ${JSON.stringify(inst)}`);
  check(inst.ok === true, "[7b] ★音声入力のモデル(本体＋mmproj)を取得・検証できる（sha256 一致）", inst);
  if (!inst.ok) return null;
  const st2 = await call<Record<string, any>>(`window.graphyDesktop.aiLocalStatus()`); // eslint-disable-line @typescript-eslint/no-explicit-any
  check(st2.stt.installed === true && st2.stt.registered === true, "[7b] 音声入力が導入済み・提供元 local-stt が登録された", st2.stt);
  check(st2.model.installed === true, "[7b] 会話のローカルモデルは残っている（音声入力の導入で壊れない）", st2.model);
  const chk = await call<{ ok: boolean; error?: string; log?: string }>(`window.graphyDesktop.aiLocalCheck("stt")`);
  check(chk.ok === true, "[7b] ★音声入力の llama-server が起動して /health が 200 を返す", { ok: chk.ok, error: chk.error, log: (chk.log ?? "").slice(-600) });
  const cfg = await call<{ providers: { id: string; endpoint?: string }[] }>(`window.graphyDesktop.aiProvidersGet()`);
  const prov = cfg.providers.find((x) => x.id === "local-stt");
  check(!!prov && /^http:\/\/127\.0\.0\.1:\d+$/.test(String(prov.endpoint)), "[7b] local-stt の宛先は 127.0.0.1 だけ", prov?.endpoint);

  const wav = Buffer.from(await (await fetch(JFK_URL)).arrayBuffer());
  const digest = crypto.createHash("sha256").update(wav).digest("hex");
  check(digest === JFK_SHA256, "[7b] 検査用の音声サンプルが固定した版と一致する（sha256）", { digest });
  const t1 = Date.now();
  const r = await main.evaluate(
    (req) => (window as unknown as { graphyDesktop: Bridge }).graphyDesktop.aiTranscribe(req),
    { audio: { base64: wav.toString("base64"), mimeType: "audio/wav" } },
  ) as { ok: boolean; text?: string; error?: string; provenance?: { providerId?: string; local?: boolean } };
  const text = (r.text ?? "").toLowerCase();
  console.log(`  [情報] 文字起こし ${Date.now() - t1} ms: ${JSON.stringify({ ok: r.ok, text: r.text, error: r.error })}`);
  check(r.ok === true && text.includes("fellow americans") && text.includes("country"), "[7b] ★実モデルが実音声を文字にできる（'fellow Americans' と 'country' を含む）", { ok: r.ok, text: r.text, error: r.error });
  check(r.provenance?.providerId === "local-stt" && r.provenance?.local === true, "[7b] 由来が local-stt（この PC の中）", r.provenance);
  let sttPid: number | null = null;
  try {
    sttPid = (JSON.parse(fs.readFileSync(path.join(dataDir, "local-ai", "server-stt.json"), "utf8")) as { pid: number }).pid;
  } catch { /* 記録が無ければ下の検査で失敗になる */ }
  check(sttPid !== null && pidAlive(sttPid), "[7b] 文字起こし中は音声入力の llama-server が生きている（会話用とは別プロセス）", { sttPid });
  return sttPid;
}

/**
 * [8] アシスタントへの PDF 添付: 同梱された pdfjs の worker が配布物の CSP（worker-src 'self' blob:）と asar の下で動くか。
 * 開発サーバーでは通っても、配布物でだけ worker が読めず添付が失敗することがあるため、実物で確かめる。
 * 送信はしない（宛先を立てない）。チップに本文の文字数が出れば、抽出まで通っている。
 */
async function attachmentSection(app: ElectronApplication, main: Page): Promise<void> {
  type B = {
    aiProvidersGet: () => Promise<{ providers: unknown[]; defaults: Record<string, string>; fallbacks?: Record<string, string[]> }>;
    aiProvidersSet: (c: unknown) => Promise<{ ok: boolean }>;
  };
  // 提供元の宛先を足すと main がネイティブの確認ダイアログ（showMessageBoxSync）を出して止まる。アプリ本体は変えず、差し替えて「許可」を返す。
  await app.evaluate(({ dialog }) => { dialog.showMessageBoxSync = (() => 0) as typeof dialog.showMessageBoxSync; });
  const orig = await main.evaluate(() => (window as unknown as { graphyDesktop: B }).graphyDesktop.aiProvidersGet());
  const prov = { id: "smoke-att", label: "smoke", kind: "openai", endpoint: "http://127.0.0.1:9", auth: "none", toolMode: "none", models: { "text-to-text": "x" } };
  const set = await main.evaluate((c) => (window as unknown as { graphyDesktop: B }).graphyDesktop.aiProvidersSet(c), { providers: [prov], defaults: { "text-to-text": "smoke-att" } });
  check(set.ok === true, "[8] 添付検査用の提供元を保存できる", set);
  let win: Page | null = null;
  try {
    // 実 OS（Linux・macOS）ではボタンが「安定」と判定されず Playwright のクリックが待ち続けたため、DOM のクリックで押す。
    const domClick = (tid: string) => main.waitForSelector(`[data-testid="${tid}"]`, { timeout: 20_000 }).then((h) => h.evaluate((el) => (el as HTMLElement).click()));
    await domClick("mainscreen-menu-system");
    await domClick("menu-item-assistant");
    win = await findWindow(app, (u) => u.includes("#assistant"), 30_000);
    check(!!win, "[8] アシスタント窓が開く");
    if (!win) return;
    await win.getByTestId("assistant-input").waitFor({ state: "visible", timeout: 20_000 });
    const objs = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
      "<< /Length 44 >>\nstream\nBT /F1 18 Tf 10 50 Td (Hello PDFTEXT) Tj ET\nendstream",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ];
    let pdf = "%PDF-1.4\n";
    const offs: number[] = [];
    objs.forEach((o, i) => { offs[i] = pdf.length; pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
    const xref = pdf.length;
    pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("")}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    await win.locator('input[type="file"]').setInputFiles({ name: "a.pdf", mimeType: "application/pdf", buffer: Buffer.from(pdf) }, { timeout: 20_000 });
    const chip = win.getByTestId("assistant-attach-chip").first();
    const ok = await chip.waitFor({ state: "visible", timeout: 30_000 }).then(() => true, () => false);
    const txt = ok ? ((await chip.textContent()) ?? "") : ((await win.locator("body").innerText()).slice(0, 300));
    check(ok && txt.includes("a.pdf") && /(文字|chars)/.test(txt), "[8] ★PDF を添付すると配布物でも本文が取り出せる（pdfjs の worker が動く）", txt);
    await win.screenshot({ path: path.join(OUT, "5-assistant-pdf.png") }).catch(() => undefined);
  } finally {
    await win?.close().catch(() => undefined);
    await main.evaluate((c) => (window as unknown as { graphyDesktop: B }).graphyDesktop.aiProvidersSet(c), { providers: orig.providers, defaults: orig.defaults, fallbacks: orig.fallbacks })
      .catch((e) => console.log(`  [情報] 提供元の設定を元に戻せなかった: ${String(e).slice(0, 120)}`));
  }
}

/** 偽マイクに流す 440 Hz の音（48 kHz mono 16 bit WAV）。Chromium の --use-file-for-fake-audio-capture 用。 */
function writeToneWav(file: string, seconds: number): void {
  const rate = 48000;
  const n = rate * seconds;
  const b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n * 2, 4); b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write("data", 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(12000 * Math.sin((2 * Math.PI * 440 * i) / rate)), 44 + i * 2);
  fs.writeFileSync(file, b);
}

/**
 * [9] アシスタントの音声入力: 配布物の中で マイク(getUserMedia) → MediaRecorder → decodeAudioData → 16 kHz WAV → main → 文字起こしの要求 が通るか。
 * 偽マイク(Chromium の --use-fake-device-for-media-stream)と、loopback の偽の音声認識サーバーを使う。実マイク・実モデルは検査しない。
 * 権限: アシスタント窓の音声だけ許され、映像は拒否される（mediaPermission.js が配布物でも効いている）。
 * macOS は OS の許可ダイアログに答える人が CI にいないので、許可済みの扱いに差し替える（OS の許可の挙動自体は人が確かめる）。
 */
async function voiceSection(app: ElectronApplication, main: Page): Promise<void> {
  type B = {
    aiProvidersGet: () => Promise<{ providers: unknown[]; defaults: Record<string, string>; fallbacks?: Record<string, string[]> }>;
    aiProvidersSet: (c: unknown) => Promise<{ ok: boolean }>;
  };
  await app.evaluate(({ dialog, systemPreferences }) => {
    dialog.showMessageBoxSync = (() => 0) as typeof dialog.showMessageBoxSync;
    systemPreferences.getMediaAccessStatus = (() => "granted") as typeof systemPreferences.getMediaAccessStatus;
  });
  const received: Buffer[] = [];
  const srv = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      if (body.includes('"input_audio"')) {
        received.push(Buffer.from(JSON.parse(body).messages[0].content[0].input_audio.data, "base64"));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "language Japanese<asr_text>スモーク音声" } }] }));
      } else { res.writeHead(200); res.end("{}"); }
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as { port: number }).port;
  const orig = await main.evaluate(() => (window as unknown as { graphyDesktop: B }).graphyDesktop.aiProvidersGet());
  const chat = { id: "smoke-chat", label: "smoke", kind: "openai", endpoint: `http://127.0.0.1:${port}`, auth: "none", toolMode: "none", models: { "text-to-text": "x" } };
  const stt = { id: "smoke-stt", label: "smoke-stt", kind: "openai", endpoint: `http://127.0.0.1:${port}`, auth: "none", toolMode: "none", models: { "speech-to-text": "asr" }, paths: { "speech-to-text": "/v1/chat/completions" } };
  const set = await main.evaluate((c) => (window as unknown as { graphyDesktop: B }).graphyDesktop.aiProvidersSet(c), { providers: [chat, stt], defaults: { "text-to-text": "smoke-chat", "speech-to-text": "smoke-stt" } });
  check(set.ok === true, "[9] 音声入力検査用の提供元を保存できる", set);
  let win: Page | null = null;
  try {
    const domClick = (tid: string) => main.waitForSelector(`[data-testid="${tid}"]`, { timeout: 20_000 }).then((h) => h.evaluate((el) => (el as HTMLElement).click()));
    await domClick("mainscreen-menu-system");
    await domClick("menu-item-assistant");
    win = await findWindow(app, (u) => u.includes("#assistant"), 30_000);
    check(!!win, "[9] アシスタント窓が開く");
    if (!win) return;
    await win.getByTestId("assistant-input").waitFor({ state: "visible", timeout: 20_000 });
    const mic = win.getByTestId("assistant-voice");
    await mic.waitFor({ state: "visible", timeout: 20_000 });
    await win.getByTestId("assistant-voice-dest").waitFor({ state: "visible", timeout: 20_000 });
    check(await mic.isEnabled(), "[9] マイクボタンが使える（音声入力の提供元が解決できている）");
    // 切り分け用: 偽マイク自体が音を出しているか（OS によって --use-file-for-fake-audio-capture の挙動が違いうる）。
    const probe = await win.evaluate(async () => {
      try {
        const st = await navigator.mediaDevices.getUserMedia({ audio: true });
        const ctx = new AudioContext();
        const an = ctx.createAnalyser();
        ctx.createMediaStreamSource(st).connect(an);
        const buf = new Float32Array(an.fftSize);
        let peak = 0;
        for (let i = 0; i < 10; i++) { await new Promise((r) => setTimeout(r, 150)); an.getFloatTimeDomainData(buf); for (const v of buf) peak = Math.max(peak, Math.abs(v)); }
        st.getTracks().forEach((t) => t.stop());
        void ctx.close();
        return { peak: Number(peak.toFixed(4)), state: ctx.state };
      } catch (e) { return { error: (e as Error).name }; }
    });
    console.log(`  [情報] 偽マイクの入力レベル(AnalyserNode): ${JSON.stringify(probe)}`);
    await mic.evaluate((el) => (el as HTMLElement).click());
    const rec = await win.getByTestId("assistant-voice-recording").waitFor({ state: "visible", timeout: 20_000 }).then(() => true, () => false);
    check(rec, "[9] ★配布物でマイクの録音が始まる（getUserMedia と許可ハンドラが通る）");
    if (rec) {
      await new Promise((r) => setTimeout(r, 2000));
      await win.getByTestId("assistant-voice-stop").evaluate((el) => (el as HTMLElement).click());
      const input = win.getByTestId("assistant-input");
      const fakeSilent = "peak" in probe && probe.peak === 0;
      if (fakeSilent) {
        // macOS ランナーでは Chromium の偽マイク(ファイル入力)が無音で、アプリの外側(AnalyserNode)でも peak 0 だった（2026-10-23 の dry run）。
        // 音の中身の検査はできないので、合格にせず未達として記録し、代わりに「無音は送らず理由を出す」アプリ側の挙動を確かめる。
        console.log("  [未達] [9] 偽マイクが無音の OS のため、録音内容(16 kHz WAV・440 Hz)の検査は実行していない（Linux・Windows では実行済み）");
        const said = await win.getByText(/No speech was recognized|音声が聞き取れませんでした/).first().waitFor({ state: "visible", timeout: 30_000 }).then(() => true, () => false);
        check(said && received.length === 0, "[9] 🔴 無音の録音は文字起こしへ送らず、理由が画面に出る（無音ガード）", { said, requests: received.length });
      } else {
        const got = await win.waitForFunction(() => (document.querySelector('[data-testid="assistant-input"]') as HTMLTextAreaElement | null)?.value.includes("スモーク音声"), undefined, { timeout: 30_000 }).then(() => true, () => false);
        if (!got) console.log(`  [情報] 画面の文言: ${JSON.stringify((await win.locator("body").innerText().catch(() => "")).slice(0, 400))}`);
        check(got, "[9] ★録音 → 16 kHz WAV → 文字起こしの要求 → 入力欄に文字が入る（配布物）", (await input.inputValue().catch(() => "")).slice(0, 80));
        const w = received[0];
        const ok = !!w && w.subarray(0, 4).toString() === "RIFF" && w.readUInt32LE(24) === 16000 && w.readUInt16LE(22) === 1 && w.readUInt16LE(34) === 16;
        let peak = 0;
        if (w) for (let i = 44; i + 1 < w.length; i += 2) peak = Math.max(peak, Math.abs(w.readInt16LE(i)));
        check(ok && peak > 2000, "[9] 送られた音声は 16 kHz・mono・16 bit の WAV で、無音ではない", { bytes: w?.length, peak });
      }
    }
    const perm = await win.evaluate(async () => {
      try { (await navigator.mediaDevices.getUserMedia({ video: true })).getTracks().forEach((t) => t.stop()); return "granted"; } catch (e) { return (e as Error).name; }
    });
    check(perm === "NotAllowedError", "[9] 🔴 映像の要求は配布物でも拒否される（mediaPermission.js）", perm);
    await win.screenshot({ path: path.join(OUT, "6-assistant-voice.png") }).catch(() => undefined);
  } finally {
    await win?.close().catch(() => undefined);
    srv.close();
    await main.evaluate((c) => (window as unknown as { graphyDesktop: B }).graphyDesktop.aiProvidersSet(c), { providers: orig.providers, defaults: orig.defaults, fallbacks: orig.fallbacks })
      .catch((e) => console.log(`  [情報] 提供元の設定を元に戻せなかった: ${String(e).slice(0, 120)}`));
  }
}

async function main(): Promise<void> {
  if (process.platform === "darwin" && process.env.CI !== "true") {
    throw new Error("macOS は実プロファイルを隔離できないので、CI（CI=true）以外では実行しません。");
  }
  if (!fs.existsSync(DIST)) throw new Error(`インストーラのディレクトリがありません: ${DIST}`);
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "gn-smoke-"));
  console.log(`作業ディレクトリ: ${work}\n出力: ${OUT}\nport: ${PORT}`);

  // ── 1. インストール ───────────────────────────────────────
  const inst = install(path.join(work, "install"));
  check(fs.existsSync(inst.exe), "[1] インストールできて、実行ファイルがある", { exe: inst.exe });
  if (!fs.existsSync(inst.exe)) return;

  // ── 4. 同梱 ffmpeg で検査用の動画を作る（作れること自体が「同梱 ffmpeg が動く」の確認）──
  const ffmpeg = findFile(path.join(inst.resources, "ffmpeg"), ["ffmpeg", "ffmpeg.exe"]);
  check(!!ffmpeg, "[4] 同梱の ffmpeg がインストール先にある", { ffmpeg });
  if (!ffmpeg) return;
  // deb の /opt は root 所有で chmod できないので、実行ビットが無いときだけ付ける。
  if (process.platform !== "win32" && (fs.statSync(ffmpeg).mode & 0o111) === 0) fs.chmodSync(ffmpeg, 0o755);
  const media = path.join(work, "media");
  fs.mkdirSync(media, { recursive: true });
  const synth = (out: string, codec: string[]): void => {
    execFileSync(
      ffmpeg,
      [
        "-y", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", "color=c=black:s=320x240:r=15:d=3",
        "-vf", "geq=lum='clip(20 + (X/W)*100 + T*60, 0, 255)':cb=128:cr=128,format=yuv420p",
        ...codec, out,
      ],
      { stdio: "inherit", timeout: 120_000 },
    );
  };
  const h264 = path.join(media, "ramp-h264.mp4");
  const mpeg4 = path.join(media, "ramp-mpeg4.avi");
  synth(h264, ["-c:v", "libx264", "-profile:v", "high", "-g", "1", "-pix_fmt", "yuv420p"]);
  synth(mpeg4, ["-c:v", "mpeg4", "-q:v", "3"]);
  check(fs.statSync(h264).size > 0 && fs.statSync(mpeg4).size > 0, "[4] 同梱 ffmpeg で検査用動画（H.264 MP4・MPEG-4 AVI）を作れた");

  // ── 2. 起動 ───────────────────────────────────────────────
  // ユーザーデータを実プロファイルから離す（backend の DB・設定は appData/GRAPHY-Next に作られる）。
  const profile = path.join(work, "profile");
  fs.mkdirSync(profile, { recursive: true });
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    GRAPHY_BACKEND_PORT: String(PORT),
    ...(process.platform === "win32" ? { APPDATA: profile } : {}),
    ...(process.platform === "linux" ? { XDG_CONFIG_HOME: profile } : {}),
  };
  delete env.GRAPHY_DEV; // 製品版として起動する（dev 経路に入らない）
  delete env.GRAPHY_BACKEND_EXTERNAL;

  console.log(`[launch] ${inst.exe}`);
  // 偽マイク（[9]）。マイクの無い runner でも getUserMedia が通るように。本体の挙動は変えない（Chromium のフラグ）。
  const toneFile = path.join(OUT, "tone.wav");
  writeToneWav(toneFile, 30);
  const mediaArgs = ["--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${toneFile}`];
  const app = await electron.launch({ executablePath: inst.exe, args: [...inst.args, ...mediaArgs], env, timeout: 120_000 });
  const proc = app.process();
  // main の console.log と backend の出力（"[backend] ..."）は main の stdout/stderr に出る。失敗の原因調査用に残す。
  const appLog = fs.createWriteStream(path.join(OUT, "app-output.log"));
  proc.stdout?.on("data", (d) => appLog.write(d));
  proc.stderr?.on("data", (d) => appLog.write(d));
  app.on("window", (w) => watchPage(w, "window"));
  let localAi: { pid: number | null; sttPid: number | null; dataDir: string } | null = null;
  try {
    const main = await findWindow(app, (u) => /renderer[\\/]index\.html/.test(u) && !u.includes("2dviewer"), 120_000);
    check(!!main, "[2] ★製品版のメイン画面が開く（splash のまま・起動直後の落下ではない）", {
      windows: app.windows().map((w) => w.url()),
    });
    if (!main) return;
    watchPage(main, "main");
    await main.waitForLoadState("domcontentloaded");

    await waitForMainScreenReady(main, 120_000).then(
      () => check(true, "[2] ★メイン画面の React がマウントされ、操作できる（検索欄が出る）"),
      (e) => check(false, "[2] ★メイン画面の React がマウントされ、操作できる（検索欄が出る）", String(e).slice(0, 200)),
    );
    const st = await fetch(`http://127.0.0.1:${PORT}/api/status`).catch((e) => e as Error);
    check(st instanceof Response && st.ok, "[2] 同梱 backend が /api/status に 200 を返す", st instanceof Response ? st.status : String(st));
    // メニューの操作はメイン画面が出ている今のうちに行う（後の節で設定画面などへ遷移する）。
    await attachmentSection(app, main).catch((e) => check(false, "[8] PDF 添付の検査が完走しなかった", String(e).slice(0, 300)));
    await voiceSection(app, main).catch((e) => check(false, "[9] 音声入力の検査が完走しなかった", String(e).slice(0, 300)));
    await main.screenshot({ path: path.join(OUT, "1-main.png") }).catch(() => {});

    // ── 5. 動画を取り込んで開く ─────────────────────────────
    const imp1 = await importNonDicomPaths(PORT, [h264], { patientId: "SMOKE", patientName: "SMOKE^H264", seriesDescription: "h264 mp4" });
    check(imp1.imported === 1, "[5] H.264 MP4 を取り込める", imp1);
    // 非 H.264 は backend が同梱 ffmpeg でトランスコードする経路。
    const imp2 = await importNonDicomPaths(PORT, [mpeg4], { patientId: "SMOKE2", patientName: "SMOKE^MPEG4", seriesDescription: "mpeg4 avi" });
    check(imp2.imported === 1, "[4] 非 H.264 動画（MPEG-4 AVI）を、同梱 ffmpeg のトランスコードで取り込める", imp2);

    // 画面の前に backend 自体が取り込みを一覧に持っているかを見る（画面と backend のどちらの不具合かを切り分ける）。
    const listed = await fetch(`http://127.0.0.1:${PORT}/api/studies`).then((r) => r.json() as Promise<unknown[]>, () => null);
    check(Array.isArray(listed) && listed.length >= 2, "[5] backend の /api/studies に取り込んだ 2 スタディがある", { count: Array.isArray(listed) ? listed.length : listed });

    // 起動時の利用条件の同意ダイアログ（#354）は全操作を塞ぐ。他の検査と同じく同意済みにして読み直す。
    await seedViewerSettings(PORT);
    await main.reload();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w: { maximize(): void }) => w.maximize())).catch(() => {});
    await dismissStartupDialogs(main);
    // 日付の絞り込みは「All」ボタンで外す（利用者と同じ操作。入力欄を空にするだけだと、状態が反映される前に
    // 検索が走って空振りすることがあった）。
    const dates = main.locator('input[type="date"]');
    await main.getByRole("button", { name: "All", exact: true }).click();
    await main.waitForTimeout(500);
    console.log(`  [情報] 日付欄: ${JSON.stringify([await dates.nth(0).inputValue(), await dates.nth(1).inputValue()])}`);
    // 起動直後は backend との接続中（画面下部の「Connecting…」）で、最初の検索が空振りすることがあるので数回やり直す。
    const row = main.locator('[data-testid^="study-row-"]').first();
    // 画面が backend へ投げる検索の URL と応答（一覧が空のとき、画面の問い合わせ側かを見る）。
    const searchCalls: string[] = [];
    main.on("response", (r) => {
      if (/\/api\/studies(\?|$)/.test(r.url())) searchCalls.push(`${r.status()} ${r.url()}`);
    });
    let found = false;
    let attempts = 0;
    for (; attempts < 6 && !found; attempts++) {
      await main.getByTestId("search-submit-button").click();
      found = await row.waitFor({ state: "visible", timeout: 10_000 }).then(() => true, () => false);
    }
    console.log(`  [情報] 検索の試行回数: ${attempts}\n  [情報] 画面の検索リクエスト: ${JSON.stringify(searchCalls.slice(0, 4))}`);
    if (!found) {
      // 画面（renderer）から backend へ届いているか。localhost は macOS で ::1 を先に引く。
      for (const host of ["localhost", "127.0.0.1"]) {
        const r = await main
          .evaluate(`fetch("http://${host}:${PORT}/api/studies").then(async (r) => r.status + " len=" + (await r.text()).length, (e) => "ERR " + e)`)
          .catch((e) => `evaluate失敗 ${e}`);
        console.log(`  [情報] 画面から http://${host}:${PORT}/api/studies → ${r}`);
      }
    }
    if (!found) throw new Error("取り込んだスタディが一覧に出ない（検索を 6 回やり直した）");
    check(true, "[5] 取り込んだスタディが一覧に出る", { attempts });
    await row.click();
    const seriesRow = main.locator('[data-testid^="series-row-"]').first();
    await seriesRow.waitFor({ state: "visible", timeout: 30_000 });
    await seriesRow.click();
    await main.getByTestId("viewer2d-toolbar-button").click();

    const viewer = await findWindow(app, (u) => u.includes("2dviewer"), 30_000);
    check(!!viewer, "[5] 2D ビューアが開く");
    if (!viewer) return;
    watchPage(viewer, "viewer");
    await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 30_000 });
    await viewer.getByTestId("video-viewport-host").waitFor({ state: "attached", timeout: 30_000 });

    let s0 = await seekState(viewer);
    for (let i = 0; i < 80 && !(s0.max > 0); i++) {
      await viewer.waitForTimeout(250);
      s0 = await seekState(viewer);
    }
    check(s0.canvasW > 0 && s0.canvasH > 0, "[5] ★動画の描画キャンバスに寸法がある（0×0 の張りぼてではない）", s0);
    check(s0.max > 0, "[5] ★動画の尺を取得できている（v0.3.3 は CSP で読めず「読み込み中」のままだった）", s0);

    // 🚨 押した検査。描画が出ていることは、操作が効くことの証拠にならない（v0.2.7）。
    const playBtn = viewer.getByTestId("video-play");
    await playBtn.waitFor({ state: "visible", timeout: 10_000 });
    await viewer.getByTestId("video-seek").evaluate((el: HTMLInputElement) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(el, "1");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await viewer.waitForTimeout(500);
    const before = (await seekState(viewer)).value;
    check((await playBtn.getAttribute("data-playing")) === "0", "[5] 押す前は停止状態");
    await playBtn.click();
    await viewer.waitForTimeout(1_200);
    const after = (await seekState(viewer)).value;
    check((await playBtn.getAttribute("data-playing")) === "1", "[5] ★★押すと「再生中」に切り替わる");
    check(after > before, "[5] ★★実際にフレームが進む", { before, after });
    await viewer.screenshot({ path: path.join(OUT, "2-viewer-playing.png") }).catch(() => {});
    await playBtn.click();
    await viewer.waitForTimeout(300);
    const p2 = (await seekState(viewer)).value;
    await viewer.waitForTimeout(900);
    const p3 = (await seekState(viewer)).value;
    check((await playBtn.getAttribute("data-playing")) === "0" && p2 === p3, "[5] もう一度押すと止まり、フレームが進まない", { p2, p3 });

    // ── 6. 設定＞計算機＞この PC（Python と GPU の検出）────────────
    // 3 OS の実ランナーで「節が開き、結果が返る（落ちない）」を見る。結果の JSON（候補ごとの所要時間つき）を記録する。
    // 偽物は使わない: ランナーに Python が無ければ state は none になりうる（それも正常な結果として記録する）。
    await main.bringToFront();
    await main.getByTestId("mainscreen-menu-system").click();
    await main.getByTestId("menu-item-settings").click();
    await main.getByTestId("settings-dialog").waitFor({ state: "visible", timeout: 30_000 });
    await main.getByTestId("settings-cat-compute").click();
    await main.getByTestId("compute-local").waitFor({ state: "visible", timeout: 30_000 });
    const localShown = await main
      .getByTestId("compute-local-headline")
      .waitFor({ state: "visible", timeout: 180_000 })
      .then(() => true, () => false);
    check(localShown, "[6] ★設定＞計算機＞この PC が開き、確認の結果（見出し）が出る");
    const local = (await main.evaluate(
      `window.graphyDesktop.computeLocalDetect({ force: false }).then((r) => JSON.stringify(r))`,
    )) as string;
    const localJson = JSON.parse(local) as { state: string; candidates: { path: string; status: string; elapsedMs?: number }[]; elapsedMs: number; reasons: string[] };
    check(localJson.state === "ok" || localJson.state === "none", "[6] 検出がエラーにならずに結果を返す", { state: localJson.state, reasons: localJson.reasons });
    console.log(`  [情報] この PC の検出: state=${localJson.state} candidates=${localJson.candidates.length} elapsedMs=${localJson.elapsedMs}`);
    // ホームのパスは記録に残さない（公開の CI ログ・Artifact に載るため）
    const scrub = (v: string): string => v.split(os.homedir()).join("<home>");
    fs.writeFileSync(path.join(OUT, "local-detect.json"), scrub(JSON.stringify(localJson, null, 2)));
    await main.screenshot({ path: path.join(OUT, "3-compute-local.png") }).catch(() => {});

    // ── 7. ローカル AI（--local-ai のとき）──────────────────
    if (LOCAL_AI) localAi = await localAiSection(app, main);

    // ── 3. 画面の異常 ───────────────────────────────────────
    check(pageProblems.length === 0, "[3] ★★画面に CSP 違反・未捕捉エラーが出ていない", pageProblems.slice(0, 5));
  } catch (e) {
    // 失敗したときの画面を残す（CI の Artifact で目視できる）。
    let n = 0;
    for (const w of app.windows()) {
      n++;
      await w.screenshot({ path: path.join(OUT, `failure-window-${n}.png`) }).catch(() => {});
      const txt = await w.evaluate("document.body ? document.body.innerText.slice(0, 2000) : ''").catch(() => "");
      fs.writeFileSync(path.join(OUT, `failure-window-${n}.txt`), `${w.url()}\n${txt}`);
    }
    throw e;
  } finally {
    fs.writeFileSync(path.join(OUT, "page-problems.txt"), pageProblems.join("\n"));
    appLog.end();
    await Promise.race([app.close().catch(() => {}), new Promise((r) => setTimeout(r, 20_000))]);
    if (proc && proc.exitCode === null) killProcessTree(proc);
  }

  if (localAi && localAi.pid !== null) {
    // アプリを閉じたら llama-server も終わる（孤児を残さない）。終了処理は最大 10 秒待つ。
    const pid = localAi.pid;
    for (let i = 0; i < 40 && pidAlive(pid); i++) await new Promise((r) => setTimeout(r, 500));
    check(!pidAlive(pid), "[7] ★アプリを閉じると llama-server も終了している（孤児が残らない）", { pid });
    if (pidAlive(pid)) process.kill(pid); // 検査は失敗として記録済み。runner に残さない
    if (localAi.sttPid !== null) {
      const sp = localAi.sttPid;
      for (let i = 0; i < 40 && pidAlive(sp); i++) await new Promise((r) => setTimeout(r, 500));
      check(!pidAlive(sp), "[7b] ★アプリを閉じると音声入力の llama-server も終了している（孤児が残らない）", { sp });
      if (pidAlive(sp)) process.kill(sp);
    }

    // 初回導入の提案フラグは、起動時に消費される（ダイアログ自体は導入済みなので出ない）。
    const flag = path.join(localAi.dataDir, "first-run-local-llm.flag");
    fs.writeFileSync(flag, "");
    const app2 = await electron.launch({ executablePath: inst.exe, args: inst.args, env, timeout: 120_000 });
    try {
      let gone = false;
      for (let i = 0; i < 60 && !gone; i++) {
        gone = !fs.existsSync(flag);
        if (!gone) await new Promise((r) => setTimeout(r, 500));
      }
      check(gone, "[7] 初回導入フラグ(first-run-local-llm.flag)が起動時に消費される", { flag: path.basename(flag) });
    } finally {
      await Promise.race([app2.close().catch(() => {}), new Promise((r) => setTimeout(r, 20_000))]);
    }
  }
}

main()
  .catch((e) => {
    console.log(`  [FAIL] 例外: ${String(e?.stack ?? e).slice(0, 800)}`);
    failures.push(`例外: ${String(e?.message ?? e)}`);
  })
  .finally(() => {
    console.log(`\n合格 ${passed} / 失敗 ${failures.length}`);
    if (failures.length) {
      console.log(`失敗: ${JSON.stringify(failures)}`);
      process.exit(1);
    }
    process.exit(0);
  });
