/*
 * 配布物スモーク: できあがったインストーラを**実際に入れて**起動し、動画を 1 本開いて再生する。
 *
 * 実行:  cd automator && npx tsx src/smoke/installedSmoke.ts [--dist ../desktop/dist] [--out .results/installed-smoke] [--port 18190]
 *   Linux は表示が要るので CI では `xvfb-run -a` を付ける。
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
 *   1. インストーラを無人で入れられる（Windows: NSIS /S、macOS: dmg の .app、Linux: AppImage 展開）
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
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";

import { importNonDicomPaths } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { waitForMainScreenReady } from "../checklist/items/shared/helpers.js";
import { dismissStartupDialogs } from "../common/dismissDialogs.js";
import { killProcessTree } from "../common/processUtils.js";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const DIST = path.resolve(arg("dist", path.join(AUTOMATOR_ROOT, "..", "desktop", "dist")));
const OUT = path.resolve(arg("out", path.join(AUTOMATOR_ROOT, ".results", "installed-smoke")));
const PORT = Number(arg("port", "18190"));

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
  if (process.platform !== "win32") fs.chmodSync(ffmpeg, 0o755);
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
  const app = await electron.launch({ executablePath: inst.exe, args: inst.args, env, timeout: 120_000 });
  const proc = app.process();
  app.on("window", (w) => watchPage(w, "window"));
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
    await main.screenshot({ path: path.join(OUT, "1-main.png") }).catch(() => {});

    // ── 5. 動画を取り込んで開く ─────────────────────────────
    const imp1 = await importNonDicomPaths(PORT, [h264], { patientId: "SMOKE", patientName: "SMOKE^H264", seriesDescription: "h264 mp4" });
    check(imp1.imported === 1, "[5] H.264 MP4 を取り込める", imp1);
    // 非 H.264 は backend が同梱 ffmpeg でトランスコードする経路。
    const imp2 = await importNonDicomPaths(PORT, [mpeg4], { patientId: "SMOKE2", patientName: "SMOKE^MPEG4", seriesDescription: "mpeg4 avi" });
    check(imp2.imported === 1, "[4] 非 H.264 動画（MPEG-4 AVI）を、同梱 ffmpeg のトランスコードで取り込める", imp2);

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w: { maximize(): void }) => w.maximize())).catch(() => {});
    await dismissStartupDialogs(main);
    const dates = main.locator('input[type="date"]');
    await dates.nth(0).fill("");
    await dates.nth(1).fill("");
    // 起動直後は backend との接続中（画面下部の「Connecting…」）で、最初の検索が空振りすることがあるので数回やり直す。
    const row = main.locator('[data-testid^="study-row-"]').first();
    let found = false;
    let attempts = 0;
    for (; attempts < 6 && !found; attempts++) {
      await main.getByTestId("search-submit-button").click();
      found = await row.waitFor({ state: "visible", timeout: 10_000 }).then(() => true, () => false);
    }
    console.log(`  [情報] 検索の試行回数: ${attempts}`);
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
    await Promise.race([app.close().catch(() => {}), new Promise((r) => setTimeout(r, 20_000))]);
    if (proc && proc.exitCode === null) killProcessTree(proc);
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
