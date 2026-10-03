// GRAPHY-Next デスクトップ（Electron）メインプロセス。
//
// 役割:
//   1. backend(Spring Boot) を standalone プロファイルで子プロセス起動
//   2. /api/status のヘルスチェックが通るまで待機
//   3. フロントエンド(React ビルド or dev サーバ)をウィンドウに読み込む
//   4. アプリ終了時に backend を確実に停止
//
// 設定: 既定値は config.json。以下の環境変数で個別に上書きできる。
//   GRAPHY_DEV=1               … フロントを Vite dev(config.devServerUrl) から読む
//   GRAPHY_BACKEND_EXTERNAL=1  … backend を spawn せず、既に起動済みのものに接続
//   GRAPHY_BACKEND_PORT        … backend ポート（既定 config.backend.port）
//   GRAPHY_BACKEND_PROFILE     … backend プロファイル（既定 config.backend.profile）
//   GRAPHY_DEV_SERVER_URL      … Vite dev サーバの URL（既定 config.devServerUrl の 5173）

const { app, BrowserWindow, shell, dialog, ipcMain, nativeImage, screen } = require("electron");
const { spawn } = require("node:child_process");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const https = require("node:https");
const fs = require("node:fs");
const readline = require("node:readline");

const PROGRESS_PREFIX = "__GRAPHY_PROGRESS__";

const cfg = require("./config.json");
const { createWindowStateKeeper } = require("./windowState");
const messages = require("./startupMessages");
const secretStore = require("./secretStore");
const aiGateway = require("./aiGateway");
const aiProviders = require("./aiProviders");
const computeEndpoints = require("./computeEndpoints");
const { ensureDefaultEndpoint } = require("./computeDefault");
const computeBridge = require("./computeBridge");
const computeConsent = require("./computeConsent");
const { createColabAuth, REFRESH_KEY: COLAB_REFRESH_KEY } = require("./colabAuth");
const { createColabApi } = require("./colabApi");
const { createColabRuntimes } = require("./colabRuntimes");

const PORT = process.env.GRAPHY_BACKEND_PORT || String(cfg.backend.port);
const PROFILE = process.env.GRAPHY_BACKEND_PROFILE || cfg.backend.profile;
const HEALTH_PATH = cfg.backend.healthPath;
const HEALTH_TIMEOUT_MS = cfg.backend.healthTimeoutMs;
// backend が「何も出力しないまま」黙り込んだと見なすまでの時間。Spring Boot の起動は
// ログを出し続けるので、これを超える沈黙は必ず何かで詰まっている（過去の実例は H2 の
// AUTO_SERVER が行う DNS 正引き/逆引き＝インターネットが無いと 30〜60 秒ブロックする）。
// 沈黙を検出しても待つのはやめない（backend は遅れて立ち上がることがある）。
// 「どの段階で何秒 止まっているか」をスプラッシュに出して、原因を目に見えるようにするためのもの。
const HEALTH_STALL_MS = Number(cfg.backend.healthStallMs || 15000);
const JAR_NAME = cfg.backend.jarName;
// GRAPHY_DEV_SERVER_URL … Vite dev サーバの URL を上書き（既定 5173 以外のポートで自前起動する
// automator 等、複数の dev サーバを並行稼働させたいツール向け）。GRAPHY_DEV=1 のときのみ参照される。
const DEV_URL = process.env.GRAPHY_DEV_SERVER_URL || cfg.devServerUrl;
const WINDOW = cfg.window;
const API_BASE = `http://localhost:${PORT}`;
// セキュリティ設定（config.json の security セクション、無ければ安全な既定）。
const SECURITY = cfg.security || {};

const DEV = process.env.GRAPHY_DEV === "1";
const EXTERNAL_BACKEND = process.env.GRAPHY_BACKEND_EXTERNAL === "1";
// main だけが backend の内部経路（/api/internal/**）を使うための起動ごとの乱数（fw/remote-compute-design.md §4.1）。
// 🔴 レンダラ・preload には渡さない。backend を別に起動する開発（EXTERNAL_BACKEND）では、
//    両方に同じ GRAPHY_MAIN_SECRET を渡したときだけ内部経路が使える（無ければ外部計算機の機能は使えない）。
const MAIN_SECRET = EXTERNAL_BACKEND
  ? (process.env.GRAPHY_MAIN_SECRET || null)
  : computeBridge.createSecret(process.env.GRAPHY_MAIN_SECRET);

// アプリアイコン（Linux/Windows のウィンドウ・タスクバー用。macOS は .icns を使うため無視される）。
// 単一マスター = frontend/public/icons/app/app_icon.png。dev はそこから直接、packaged は
// build 時に renderer へ同梱されたコピー（desktop/renderer/icons/app/app_icon.png）から読む。
// インストーラ/アプリバンドル本体のアイコンは electron-builder が desktop/build/icon.png から生成する（別経路）。
const APP_ICON = DEV
  ? path.join(__dirname, "..", "frontend", "public", "icons", "app", "app_icon.png")
  : path.join(__dirname, "renderer", "icons", "app", "app_icon.png");

let backendProc = null;
// --- 起動診断（失敗したときに「直接的な原因」を出すための材料）---
// backend の直近出力。原因表示に添える technical detail の供給元（メモリは高々数十行）。
const BACKEND_LOG_TAIL = [];
const BACKEND_LOG_TAIL_MAX = 60;
// backend から最後に 1 行でも受け取った時刻。沈黙の検出に使う。
let lastBackendOutputAt = 0;
// 直近に running になった進捗ステップ（どこで止まったかを名指しするため）。
let lastRunningStep = null;
// backend プロセスがヘルスチェック成功前に落ちた場合の記録。
let backendExit = null;
// spawn 自体が失敗した場合（java が無い等）の記録。
let backendSpawnError = null;
let backendHealthy = false;

/** 起動失敗を「コード＋技術的な詳細」で表現する。コードはスプラッシュ側で ja/en に訳す。 */
class StartupError extends Error {
  constructor(code, detail, params) {
    super(code);
    this.code = code;
    this.detail = detail || "";
    this.params = params || {};
  }
}
// 位置記憶対象ビューアのシングルトン参照（画面キー → BrowserWindow）。
// 既に開いていればフォーカスして再利用し、キーごとに前回位置を 1 つ記憶する。
const viewerWins = new Map();
// QR（Query/Retrieve）ウィンドウのシングルトン参照。常駐させたいので 1 枚を再利用する（位置記憶は対象外）。
let qrWin = null;
// モニター診断（テストパターン）ウィンドウのシングルトン参照（指定モニターにフルスクリーン表示）。
let monitorQcWin = null;

// 位置記憶対象ビューアの既定サイズ（初回/保存なしのとき使う）。
const VIEWER_DEFAULTS = {
  "2dviewer": { width: 1400, height: 900 },
  viewer3d: { width: 1400, height: 900 },
  mpr: { width: 1400, height: 900 },
  slicer: { width: 1400, height: 900 },
  curvedmpr: { width: 1400, height: 900 },
  // ボリュームを持たない 3D（3D QCA の中心線など）。
  geometry3d: { width: 1100, height: 800 },
  // GLAM 解析は図を横に並べるので、やや幅広を既定にする。
  glam: { width: 1250, height: 900 },
};

/** 同梱 / 開発時の backend jar のパスを解決する。 */
function resolveBackendJar() {
  const candidates = [
    // 1) パッケージ版（electron-builder extraResources → Contents/Resources/backend）
    path.join(process.resourcesPath || "", "backend", JAR_NAME),
    // 2) 開発時: 直近ビルドの成果物（dev-desktop が毎回ここを再ビルドする。最優先で参照）
    path.join(__dirname, "..", "backend", "target", JAR_NAME),
    // 3) ステージ済みの同梱用コピー（古い可能性があるので最後のフォールバック）
    path.join(__dirname, "resources", "backend", JAR_NAME),
  ];
  return candidates.find((p) => p && fs.existsSync(p)) || null;
}

/** 同梱 JRE の java を優先し、無ければ PATH の java にフォールバック（GRAPHY の run.sh と同様）。 */
function resolveJava() {
  const exe = process.platform === "win32" ? "java.exe" : "java";
  const candidates = [
    path.join(process.resourcesPath || "", "jre", "bin", exe), // electron-builder で同梱
    path.join(__dirname, "resources", "jre", "bin", exe),      // 開発時ステージング
  ];
  return candidates.find((p) => p && fs.existsSync(p)) || "java";
}

/**
 * backend の作業ディレクトリ（＝ H2 DB `./data/graphy-index`・DICOM 保管庫 `./data/dicom`・
 * `./plugins` が作られる場所）を解決する。backend は相対パスでこれらを作るため、CWD を固定する。
 *
 * パッケージ版: OS 標準のユーザーデータ領域直下の "GRAPHY-Next" に固定する。
 *   Windows … %APPDATA%\GRAPHY-Next
 *   macOS   … ~/Library/Application Support/GRAPHY-Next
 *   Linux   … ~/.config/GRAPHY-Next
 * これによりインストール先(≒プログラム本体)とユーザーデータが分離され、アンインストーラが
 * データを「巻き添えで消す/取り残す」ことなく、明示的に（確認のうえ）削除できる。
 *
 * ⚠ フォルダ名は electron の app.getName()（= package.json "name"）ではなく、build.productName と
 *   同じ "GRAPHY-Next" を明示指定する。これによりアンインストーラ側の $APPDATA\GRAPHY-Next
 *   （desktop/build/installer.nsh）・Help＞Uninstall・uninstall スクリプトのパスと完全一致させる。
 *   productName を変える場合はこれら 4 箇所を同時に更新すること。
 *
 * 開発時: 従来どおり CWD（通常 desktop/）をそのまま使い、既存の開発用 desktop/data を壊さない。
 */
const APP_DATA_FOLDER = "GRAPHY-Next";
function resolveDataDir() {
  if (!app.isPackaged) return process.cwd();
  const dir = path.join(app.getPath("appData"), APP_DATA_FOLDER);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    console.error("[backend] データディレクトリの作成に失敗:", e);
  }
  return dir;
}

/** 同梱の公式プラグインの置き場を backend に渡す引数（無ければ空）。開発では GRAPHY_BUNDLED_PLUGINS_DIR で試せる。 */
function bundledPluginsArgs() {
  const dir = process.env.GRAPHY_BUNDLED_PLUGINS_DIR
    || (app.isPackaged ? path.join(process.resourcesPath, "bundled-plugins") : null);
  return dir && fs.existsSync(dir) ? [`--graphy.plugins.bundled-dir=${dir}`] : [];
}

function startBackend() {
  // 沈黙の検出はここを起点にする（external モードでは backend の出力が来ないため、
  // 初期化しないと「起動直後に無応答」と誤判定してしまう）。
  lastBackendOutputAt = Date.now();
  if (EXTERNAL_BACKEND) {
    console.log("[backend] external mode — spawn をスキップ");
    return;
  }
  const jar = resolveBackendJar();
  if (!jar) {
    throw new StartupError(
      "jar-missing",
      `${JAR_NAME} (${process.resourcesPath ? path.join(process.resourcesPath, "backend") : "resources/backend"})`,
    );
  }
  const javaCmd = resolveJava();
  // JVM ヒープ上限（config.backend.maxHeapMb、0/未設定なら JVM 既定）。画像処理に向けて調整可能。
  const maxHeapMb = Number(process.env.GRAPHY_MAX_HEAP_MB || cfg.backend.maxHeapMb || 0);
  const jvmArgs = maxHeapMb > 0 ? [`-Xmx${maxHeapMb}m`] : [];
  // stdout/stderr を UTF-8 に固定する。Java 21 は「端末でない出力先」の既定を OS のネイティブ
  // エンコーディングにするため、日本語 Windows では stdout が CP932 で流れてくる。
  // Node 側は UTF-8 で読むので、そのままだと backend のログ行が文字化けする。
  // 進捗行は step で訳すので影響が無かったが、失敗時に backend の最終行を「直接的な原因」として
  // そのまま画面へ出すようになったため、ここで揃える必要がある。
  jvmArgs.push("-Dstdout.encoding=UTF-8", "-Dstderr.encoding=UTF-8");
  // 匿名化の焼き込みで圧縮画素（JPEG 等）を伸長するために要る。dcm4che の OpenCV コーデックは
  // javax.imageio.stream / java.io の private フィールドへリフレクションで触るため。
  // 🔴 **java.base/java.io を忘れると例外では済まず JVM が SIGSEGV で落ちる**（実測）。
  //    片方だけ渡すくらいなら両方渡さないほうが安全なので、必ず 2 つ 1 組で扱うこと。
  //    backend 側は PixelCodec が Module.isOpen で有無を確かめ、無ければ伸長を行わない。
  jvmArgs.push(
    "--add-opens", "java.base/java.io=ALL-UNNAMED",
    "--add-opens", "java.desktop/javax.imageio.stream=ALL-UNNAMED",
  );
  // データ(DB/DICOM/plugins)は CWD 相対で作られるため、CWD を固定する（パッケージ版は userData）。
  const dataDir = resolveDataDir();
  console.log(`[backend] starting: ${jar} (java=${javaCmd}, profile=${PROFILE}, port=${PORT}, maxHeapMb=${maxHeapMb || "default"}, dataDir=${dataDir})`);
  backendProc = spawn(
    javaCmd,
    [
      ...jvmArgs,
      "-jar",
      jar,
      `--spring.profiles.active=${PROFILE}`,
      `--server.port=${PORT}`,
      // 同梱の公式プラグイン（配布物に resources/bundled-plugins があるときだけ。backend が起動時に、
      // 公式鍵の署名を確かめてから入れる。利用者が消したものは入れ直さない）。fw/plugin-manager-design.md §10
      ...bundledPluginsArgs(),
    ],
    { cwd: dataDir, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GRAPHY_MAIN_SECRET: MAIN_SECRET } },
  );
  wireBackendOutput(backendProc);
  // spawn 自体の失敗（java.exe が無い＝ENOENT など）。exit は来ないのでここで拾う。
  backendProc.on("error", (err) => {
    console.error("[backend] spawn failed:", err);
    backendSpawnError = new StartupError(
      err.code === "ENOENT" ? "java-missing" : "spawn-failed",
      `${javaCmd}: ${err.message}`,
    );
    backendProc = null;
  });
  backendProc.on("exit", (code, signal) => {
    console.log(`[backend] exited (code=${code})`);
    // ヘルスチェックが通る前の終了だけを「起動失敗」として記録する
    // （終了時の正常な停止と区別する）。
    if (!backendHealthy) {
      backendExit = { code, signal };
    }
    backendProc = null;
  });
}

/** backend の出力を 1 行受け取ったときの共通処理（沈黙検出用の時刻更新＋末尾バッファ）。 */
function noteBackendOutput(line) {
  lastBackendOutputAt = Date.now();
  BACKEND_LOG_TAIL.push(line);
  if (BACKEND_LOG_TAIL.length > BACKEND_LOG_TAIL_MAX) BACKEND_LOG_TAIL.shift();
}

/**
 * backend の出力から「起動できなかった直接の原因」を読み取る。
 * Spring Boot は失敗理由を最後にまとめて出すので、末尾から既知のパターンを探す。
 * 見つからない場合は最後の非空行をそのまま詳細として返す（生の一次情報の方が
 * 「起動に失敗しました」より遥かに役に立つ）。
 */
function classifyBackendFailure(fallbackCode) {
  const tail = BACKEND_LOG_TAIL.join("\n");
  let m = /Port (\d+) was already in use|Web server failed to start.*port (\d+)/i.exec(tail);
  if (m) {
    return new StartupError("port-in-use", tail.split("\n").filter(Boolean).pop() || "", {
      port: m[1] || m[2] || PORT,
    });
  }
  if (/UnsupportedClassVersionError|class file version|Unsupported class file major version/i.test(tail)) {
    return new StartupError("java-too-old", lastMeaningfulLine());
  }
  if (/Unable to access jarfile|Error: Invalid or corrupt jarfile/i.test(tail)) {
    return new StartupError("jar-broken", lastMeaningfulLine());
  }
  if (/Failed to (?:start|configure) a DataSource|Database may be already in use|Locked by another/i.test(tail)) {
    return new StartupError("db-locked", lastMeaningfulLine());
  }
  return new StartupError(fallbackCode, lastMeaningfulLine());
}

/** 末尾の「意味のある」1 行（Spring Boot の装飾行・空行を避ける）。 */
function lastMeaningfulLine() {
  for (let i = BACKEND_LOG_TAIL.length - 1; i >= 0; i--) {
    const s = BACKEND_LOG_TAIL[i].trim();
    if (s && !/^[-*_=\s]+$/.test(s) && !/^\*{3}/.test(s)) return s.slice(0, 300);
  }
  return "";
}

/** backend の stdout/stderr を行単位で読み、進捗行はスプラッシュへ、それ以外はログへ。 */
function wireBackendOutput(proc) {
  if (proc.stdout) {
    readline.createInterface({ input: proc.stdout }).on("line", (line) => {
      const i = line.indexOf(PROGRESS_PREFIX);
      if (i >= 0) {
        lastBackendOutputAt = Date.now();
        try {
          const p = JSON.parse(line.slice(i + PROGRESS_PREFIX.length));
          if (p && p.state === "running" && p.step) lastRunningStep = p.step;
          forwardProgress(p);
        } catch {
          // 進捗行のパース失敗は無視
        }
      } else {
        noteBackendOutput(line);
        console.log("[backend]", line);
      }
    });
  }
  if (proc.stderr) {
    readline.createInterface({ input: proc.stderr }).on("line", (line) => {
      noteBackendOutput(line);
      console.error("[backend]", line);
    });
  }
}

/**
 * ヘルスチェックパスが 200 を返すまでポーリングする。
 *
 * 失敗を「起動に失敗しました」で片付けず、原因を切り分けて {@link StartupError} で返す:
 *   - spawn 失敗（java が無い）/ プロセスがヘルス成功前に終了 → 即座に確定。待たない。
 *   - backend が {@link HEALTH_STALL_MS} 以上 沈黙 → どの段階で何秒 止まっているかを
 *     スプラッシュに出す（待つのはやめない。遅れて立ち上がることがあるため）。
 *   - {@link HEALTH_TIMEOUT_MS} 到達 → 「失敗」ではなく「待ちきれなかった」として報告する
 *     （実際この後 backend が立ち上がって普通に使えることがあるため、断定しない）。
 */
function waitForBackend(timeoutMs = HEALTH_TIMEOUT_MS) {
  const start = Date.now();
  let stallReported = false;
  return new Promise((resolve, reject) => {
    const tick = () => {
      // プロセスが死んでいるなら待つ意味が無い。原因は backend の出力から拾う。
      if (backendSpawnError) return reject(backendSpawnError);
      if (backendExit) {
        const err = classifyBackendFailure("backend-exited");
        err.params.code = String(backendExit.code ?? backendExit.signal ?? "?");
        return reject(err);
      }
      const req = http.get(
        { host: "127.0.0.1", port: PORT, path: HEALTH_PATH, timeout: 2000 },
        (res) => {
          if (res.statusCode !== 200) {
            res.resume();
            return retry();
          }
          // 🔴 200 だけでは足りない。ポートを別のアプリが握っていると、その応答で
          // 「backend は健全」と判定してしまい、本当の原因（backend はポート衝突で
          // 起動できていない）が最後まで表に出ない。応答が GRAPHY-Next のものか確かめる。
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (c) => (body += c.length > 4096 ? c.slice(0, 4096) : c));
          res.on("end", () => {
            let ok = false;
            try {
              ok = JSON.parse(body).app === "GRAPHY-Next";
            } catch {
              ok = false;
            }
            if (!ok) return retry();
            backendHealthy = true;
            resolve();
          });
          res.on("error", retry);
        },
      );
      req.on("error", retry);
      // destroy() に Error を渡さないと 'error' が発火せず、ポーリングが静かに止まる。
      req.on("timeout", () => req.destroy(new Error("health check timeout")));
    };
    const retry = () => {
      const elapsed = Date.now() - start;
      const silent = Date.now() - lastBackendOutputAt;
      if (!stallReported && silent > HEALTH_STALL_MS) {
        stallReported = true;
        forwardProgress({
          step: "stall",
          state: "warn",
          code: "backend-stalled",
          params: { step: lastRunningStep || "init", seconds: Math.round(silent / 1000) },
          detail: lastMeaningfulLine(),
        });
      }
      if (elapsed > timeoutMs) {
        return reject(
          new StartupError("backend-timeout", lastMeaningfulLine(), {
            step: lastRunningStep || "init",
            seconds: Math.round(elapsed / 1000),
          }),
        );
      }
      setTimeout(tick, 500);
    };
    tick();
  });
}

// --- スプラッシュ（起動進捗表示）---
let splashWin = null;
let splashReady = false;
const progressQueue = [];

function createSplash() {
  splashWin = new BrowserWindow({
    width: 520,
    // 段階ごとの経過秒と、失敗時の一次情報（backend の最後のログ行）を出す余白を持たせている。
    // 400 だと「原因」の最終行がちょうど切れる（実測して 430 にした）。
    height: 430,
    frame: false,
    resizable: false,
    center: true,
    show: true,
    backgroundColor: "#0b1b2b",
    icon: APP_ICON,
    webPreferences: {
      preload: path.join(__dirname, "splash-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  splashWin.loadFile(path.join(__dirname, "splash.html"));
  splashWin.webContents.on("did-finish-load", () => {
    splashReady = true;
    for (const p of progressQueue) {
      splashWin.webContents.send("progress", p);
    }
    progressQueue.length = 0;
  });
}

function forwardProgress(obj) {
  if (splashReady && splashWin && !splashWin.isDestroyed()) {
    splashWin.webContents.send("progress", obj);
  } else {
    progressQueue.push(obj);
  }
}

function closeSplash() {
  if (splashWin && !splashWin.isDestroyed()) {
    splashWin.close();
  }
  splashWin = null;
}

function createWindow() {
  const keeper = createWindowStateKeeper("main", {
    width: WINDOW.width,
    height: WINDOW.height,
  });
  const win = new BrowserWindow({
    ...keeper.initialBounds, // 前回位置を復元（迷子防止の検証済み）
    show: false, // ロード完了まで隠す（スプラッシュからの切替えを滑らかに）
    icon: APP_ICON,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      // --- セキュリティ（安全な値に固定。無効化しない）---
      contextIsolation: true, // レンダラと preload の world を分離
      nodeIntegration: false, // レンダラに Node を露出しない
      sandbox: true, // レンダラをサンドボックス化（preload は process.argv で API ベースを受領）
      webSecurity: true,
      additionalArguments: [`--graphy-api-base=${API_BASE}`],
    },
  });
  keeper.track(win); // 移動/リサイズ/最大化/閉じるを追従して位置を保存

  // 外部 URL は既定ブラウザで開き、新規ウィンドウは生成しない。
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  // アプリ内（トップフレーム）の外部ナビゲーションを禁止。
  win.webContents.on("will-navigate", (e, url) => {
    if (url !== win.webContents.getURL()) {
      e.preventDefault();
      if (/^https?:\/\//.test(url)) shell.openExternal(url);
    }
  });

  win.once("ready-to-show", () => {
    if (keeper.isMaximized) win.maximize();
    if (keeper.isFullScreen) win.setFullScreen(true);
    win.show();
    closeSplash(); // メイン表示と同時にスプラッシュを閉じる
  });

  if (DEV) {
    win.loadURL(DEV_URL);
  } else {
    win.loadFile(path.join(__dirname, "renderer", "index.html"));
  }

  // DevTools は dev か、明示的に許可した場合のみ（本番は既定で無効）。
  if (DEV || SECURITY.devTools) {
    win.webContents.openDevTools();
  }
}

// 2D/3D/MPR/Slicer 等の独立ビューアを新規ウィンドウで開く（マルチモニタ運用）。
// 同じフロントを `#<screen>` のハッシュ付きで読み込み、React 側でルーティングする。
// keeper を渡すと前回位置を復元し、以後の移動/リサイズ/最大化を追従保存する（QR 等は未指定＝記憶なし）。
function createViewerWindow(screen, keeper) {
  const bounds = keeper ? keeper.initialBounds : { width: 1400, height: 900 };
  const win = new BrowserWindow({
    ...bounds,
    show: keeper ? false : true, // keeper 有りは最大化復元後に表示（ちらつき防止）
    icon: APP_ICON,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      additionalArguments: [`--graphy-api-base=${API_BASE}`],
    },
  });
  if (keeper) {
    keeper.track(win);
    win.once("ready-to-show", () => {
      if (keeper.isMaximized) win.maximize();
      if (keeper.isFullScreen) win.setFullScreen(true);
      win.show();
    });
  }
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    // ハッシュ変更（同一ドキュメント）は許可。別ドキュメントへの遷移のみ禁止。
    const current = win.webContents.getURL();
    if (url.split("#")[0] !== current.split("#")[0]) {
      e.preventDefault();
      if (/^https?:\/\//.test(url)) shell.openExternal(url);
    }
  });
  if (DEV) {
    win.loadURL(`${DEV_URL}#${screen}`);
  } else {
    win.loadFile(path.join(__dirname, "renderer", "index.html"), { hash: screen });
  }
  if (DEV || SECURITY.devTools) {
    win.webContents.openDevTools();
  }
  return win;
}

ipcMain.handle("graphy:open-viewer", (_e, screen) => {
  const s = String(screen || "2dviewer");

  // QR ウィンドウは常駐想定のシングルトン（位置記憶は対象外）。
  if (s === "qr") {
    if (qrWin && !qrWin.isDestroyed()) {
      qrWin.focus();
      return;
    }
    qrWin = createViewerWindow("qr");
    qrWin.on("closed", () => { qrWin = null; });
    return;
  }

  // 位置記憶対象ビューアは「1 画面キー = 1 ウィンドウ」のシングルトン。
  // 既に開いていればフォーカスして再利用する。
  const existing = viewerWins.get(s);
  if (existing && !existing.isDestroyed()) {
    existing.focus();
    return;
  }

  const keeper = createWindowStateKeeper(s, VIEWER_DEFAULTS[s] || { width: 1400, height: 900 });
  const win = createViewerWindow(s, keeper);
  viewerWins.set(s, win);
  win.on("closed", () => {
    if (viewerWins.get(s) === win) viewerWins.delete(s);
  });
});

// --- モニター診断（Monitor QC）---
// 目的: 外部センサーを使わない簡易 QC。接続モニターの表示環境を可視化し、
//       選んだモニターにフルスクリーンで目視テストパターンを表示する。
//       絶対輝度/GSDF の定量測定は行わない（フォトメータ必須）。renderer 側 UI に明示する。

// 接続中の全ディスプレイの情報を返す（Settings＞モニター診断パネル用）。
ipcMain.handle("graphy:list-displays", () => {
  const primaryId = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((d) => ({
    id: d.id,
    label: d.label || "",
    primary: d.id === primaryId,
    internal: !!d.internal,
    bounds: d.bounds,
    workArea: d.workArea,
    size: d.size, // 論理サイズ（DIP）
    scaleFactor: d.scaleFactor,
    rotation: d.rotation,
    colorDepth: d.colorDepth,
    colorSpace: d.colorSpace,
    depthPerComponent: d.depthPerComponent,
    displayFrequency: d.displayFrequency,
    monochrome: d.monochrome,
  }));
});

// 指定モニターにテストパターン用ウィンドウをフルスクリーン表示（シングルトン）。
ipcMain.handle("graphy:open-monitor-qc", (_e, displayId) => {
  const id = Number(displayId);
  const target = screen.getAllDisplays().find((d) => d.id === id) || screen.getPrimaryDisplay();
  const b = target.bounds;

  if (monitorQcWin && !monitorQcWin.isDestroyed()) {
    monitorQcWin.setFullScreen(false);
    monitorQcWin.setBounds(b);
    monitorQcWin.setFullScreen(true);
    monitorQcWin.focus();
    return;
  }

  monitorQcWin = new BrowserWindow({
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    frame: false,
    show: false, // フルスクリーン確定後に表示（ちらつき防止）
    backgroundColor: "#000000",
    icon: APP_ICON,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      additionalArguments: [`--graphy-api-base=${API_BASE}`],
    },
  });
  monitorQcWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  monitorQcWin.once("ready-to-show", () => {
    monitorQcWin.setFullScreen(true);
    monitorQcWin.show();
    monitorQcWin.focus();
  });
  if (DEV) {
    monitorQcWin.loadURL(`${DEV_URL}#monitorqc`);
  } else {
    monitorQcWin.loadFile(path.join(__dirname, "renderer", "index.html"), { hash: "monitorqc" });
  }
  monitorQcWin.on("closed", () => { monitorQcWin = null; });
});

// ビューアのタイル画像を外部（デスクトップ/他アプリ）へネイティブドラッグする。
// renderer から PNG dataURL を受け取り、一時ファイルに書き出して startDrag を発火。
// これにより OS が「本物のファイルドラッグ」として扱い、禁止カーソルが出ない。
ipcMain.on("graphy:start-drag", (e, payload) => {
  try {
    const dataUrl = payload && payload.dataUrl;
    if (typeof dataUrl !== "string") return;
    const m = /^data:image\/png;base64,([\s\S]+)$/.exec(dataUrl);
    if (!m) return;
    const buf = Buffer.from(m[1], "base64");
    const safeName = String((payload && payload.filename) || "graphy-capture.png")
      .replace(/[^\w.\-]+/g, "_");
    const filePath = path.join(os.tmpdir(), `graphy-drag-${Date.now()}-${safeName}`);
    fs.writeFileSync(filePath, buf);
    const icon = nativeImage.createFromBuffer(buf).resize({ width: 96 });
    e.sender.startDrag({ file: filePath, icon });
  } catch (err) {
    console.error("[start-drag]", err);
  }
});

// OS 標準のメモリ/システムモニタを起動する（System メニューの MemoryMonitor）。
//   Windows … タスクマネージャ (taskmgr)
//   macOS   … アクティビティモニタ (Activity Monitor)
//   Linux   … 代表的なシステムモニタを順に試す
// 子プロセスは detached + unref で親（Electron）から切り離す。
function launchFirstAvailable(cmds) {
  const [head, ...rest] = cmds;
  if (!head) {
    console.error("[memory-monitor] 起動可能なシステムモニタが見つかりません");
    return;
  }
  const child = spawn(head, [], { detached: true, stdio: "ignore" });
  child.on("error", () => launchFirstAvailable(rest)); // 未インストール(ENOENT)なら次候補へ
  child.unref();
}

ipcMain.handle("graphy:open-memory-monitor", () => {
  const opts = { detached: true, stdio: "ignore" };
  if (process.platform === "win32") {
    spawn("taskmgr.exe", [], opts).unref();
  } else if (process.platform === "darwin") {
    spawn("open", ["-a", "Activity Monitor"], opts).unref();
  } else {
    launchFirstAvailable([
      "gnome-system-monitor",
      "plasma-systemmonitor",
      "ksysguard",
      "mate-system-monitor",
      "xfce4-taskmanager",
      "lxtask",
    ]);
  }
});

// OS の物理メモリ量を返す（ボリューム構築のバジェット決定用。fw/volume-memory-guard.md V3）。
// ブラウザからは実搭載量を取る API が無いため、standalone ではここから受け取る。
// process.getSystemMemoryInfo() は KB 単位・32bit 環境で頭打ちになることがあるので os を優先し、
// os が 0 を返した場合だけフォールバックする。
ipcMain.handle("graphy:get-memory-info", () => {
  let totalBytes = os.totalmem();
  let freeBytes = os.freemem();
  if (!totalBytes) {
    try {
      const info = process.getSystemMemoryInfo();
      totalBytes = (info.total || 0) * 1024;
      freeBytes = (info.free || 0) * 1024;
    } catch {
      /* 取れなければ 0 のまま返す（renderer 側でフォールバックする） */
    }
  }
  return { totalBytes, freeBytes };
});

// 外部 URL / mailto を OS の既定アプリ（ブラウザ・メーラ）で開く（Help メニューのリンク等）。
// URL スキームは http(s) / mailto のみ許可（任意コマンド実行を避ける）。
ipcMain.on("graphy:open-external", (_e, url) => {
  if (typeof url === "string" && /^(https?:|mailto:)/i.test(url)) {
    shell.openExternal(url);
  }
});

// HTTPS GET → JSON（リダイレクト追従・タイムアウト付き）。更新確認用の最小実装。
function httpsGetJson(url, redirects = 3) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { "User-Agent": "GRAPHY-Next", Accept: "application/vnd.github+json" }, timeout: 8000 },
      (res) => {
        const { statusCode, headers } = res;
        if (statusCode >= 300 && statusCode < 400 && headers.location && redirects > 0) {
          res.resume();
          return resolve(httpsGetJson(headers.location, redirects - 1));
        }
        if (statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${statusCode}`));
        }
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
  });
}

// GitHub Releases の最新版情報を取得（Help＞更新を確認 / 起動時チェック）。
// レンダラは CSP（connect-src が localhost のみ）で api.github.com を叩けないため、
// main プロセスで取得して返す。バージョン比較・UI はレンダラ側で行う。失敗時 null。
ipcMain.handle("graphy:check-update", async () => {
  const repo = (cfg.update && cfg.update.repo) || "";
  if (!repo) return null;
  try {
    const rel = await httpsGetJson(`https://api.github.com/repos/${repo}/releases/latest`);
    if (!rel || !rel.tag_name) return null;
    return {
      tagName: String(rel.tag_name),
      name: rel.name ? String(rel.name) : String(rel.tag_name),
      body: rel.body ? String(rel.body) : "",
      htmlUrl: rel.html_url ? String(rel.html_url) : `https://github.com/${repo}/releases/latest`,
      publishedAt: rel.published_at ? String(rel.published_at) : null,
    };
  } catch (e) {
    console.error("[update] check failed:", e && e.message);
    return null;
  }
});

// インポート: ネイティブのファイル/フォルダ選択ダイアログ。選んだパスを返す。
ipcMain.handle("graphy:pick-import", async () => {
  const result = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow(), {
    title: "DICOM のインポート（ファイル / フォルダ）",
    properties: ["openFile", "openDirectory", "multiSelections"],
  });
  return result.canceled ? [] : result.filePaths;
});

// プラグイン向けの「開く」ダイアログ（H43 file.pickFiles）。**ファイルだけ**選ばせる（フォルダは不可）。
// 題と拡張子のフィルタはプラグインが渡す。選んだ絶対パスを返す（取り消しは canceled）。
ipcMain.handle("graphy:pick-files", async (e, payload) => {
  const title = (payload && typeof payload.title === "string" && payload.title) || "ファイルを選択";
  const filters = (payload && Array.isArray(payload.filters) && payload.filters.length > 0 && payload.filters) || undefined;
  const properties = ["openFile"];
  if (payload && payload.multiple) properties.push("multiSelections");
  const win = BrowserWindow.fromWebContents(e.sender) || BrowserWindow.getFocusedWindow();
  const result = await dialog.showOpenDialog(win, { title, filters, properties });
  if (result.canceled || result.filePaths.length === 0) return { ok: false, canceled: true };
  return { ok: true, paths: result.filePaths };
});

// 単一フォルダ選択（SeriesExtractor のコピー先など）。選んだ絶対パス（無ければ null）。
ipcMain.handle("graphy:pick-directory", async () => {
  const result = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow(), {
    title: "出力先フォルダを選択",
    properties: ["openDirectory", "createDirectory"],
  });
  return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
});

// ─────────────────────────────────────────────────────────────────────────────
// H56: プラグインのフォルダ（バッチの入力・出力先）
//
// 🔴 プラグインが書けるのは、**利用者がこの起動中にフォルダ選択で選んだフォルダの中だけ**。
//   選ばれたフォルダを main が覚え、書き込みの要求はその直下に限る（ファイル名に区切りを許さない・
//   既にあれば「名前 (2).拡張子」にして上書きしない）。
// ─────────────────────────────────────────────────────────────────────────────
const pluginPickedDirs = new Set();

ipcMain.handle("graphy:plugin-pick-directory", async (e, payload) => {
  const title = (payload && typeof payload.title === "string" && payload.title) || "フォルダを選択";
  const win = BrowserWindow.fromWebContents(e.sender) || BrowserWindow.getFocusedWindow();
  const result = await dialog.showOpenDialog(win, { title, properties: ["openDirectory", "createDirectory"] });
  if (result.canceled || result.filePaths.length === 0) return { ok: false, canceled: true };
  const dir = path.resolve(result.filePaths[0]);
  pluginPickedDirs.add(dir);
  return { ok: true, path: dir };
});

/** 選ばれたフォルダの直下の、上書きしないファイルのパス。書けなければ null。 */
function pluginTargetIn(dir, name) {
  const d = path.resolve(String(dir || ""));
  if (!pluginPickedDirs.has(d)) return null;
  const base = path.basename(String(name || ""));
  if (!base || base !== String(name) || base === "." || base === "..") return null;
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  let target = path.join(d, base);
  for (let i = 2; fs.existsSync(target) && i < 10000; i++) target = path.join(d, `${stem} (${i})${ext}`);
  return target;
}

ipcMain.handle("graphy:plugin-write-into-directory", async (_e, payload) => {
  const target = pluginTargetIn(payload && payload.dir, payload && payload.name);
  if (!target) return { ok: false, error: "directory-not-picked-or-bad-name" };
  const bytes = payload && payload.bytes;
  if (!bytes || typeof bytes.byteLength !== "number") return { ok: false, error: "empty" };
  try {
    fs.writeFileSync(target, Buffer.from(bytes));
    return { ok: true, filePath: target };
  } catch (err) {
    return { ok: false, error: String(err.message) };
  }
});

// ジョブの成果物（H53）を backend から直接フォルダへ落とす（大きな動画をレンダラのメモリに載せない）
ipcMain.handle("graphy:plugin-download-into-directory", async (_e, payload) => {
  const target = pluginTargetIn(payload && payload.dir, payload && payload.name);
  if (!target) return { ok: false, error: "directory-not-picked-or-bad-name" };
  let url;
  try {
    url = new URL(String(payload && payload.url));
  } catch {
    return { ok: false, error: "bad-url" };
  }
  // 自分の backend の成果物だけ
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname) ||
      !/^\/api\/plugin-jobs\/[A-Za-z0-9-]+\/artifact$/.test(url.pathname)) {
    return { ok: false, error: "bad-url" };
  }
  return await new Promise((resolve) => {
    const req = http.get(url, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        resolve({ ok: false, error: `artifact-${res.statusCode}` });
        return;
      }
      const out = fs.createWriteStream(target);
      res.pipe(out);
      out.on("finish", () => out.close(() => resolve({ ok: true, filePath: target })));
      out.on("error", (err) => resolve({ ok: false, error: String(err.message) }));
    });
    req.on("error", (err) => resolve({ ok: false, error: String(err.message) }));
  });
});

// アプリ全体を再起動する（DICOM 自局設定など、SCP リスナー起動時にしか反映されない設定の変更後に使う）。
// before-quit で stopBackend が走るため、次回起動時に新しい設定で backend が立ち上がる。
ipcMain.handle("graphy:relaunch", () => {
  app.relaunch();
  app.quit();
});

// ネイティブダイアログ（window.confirm/alert/prompt）を閉じた後、レンダラのキーボード
// フォーカスが失われて入力できなくなる Electron の既知挙動への対処（特に Linux/GTK ダイアログ）。
// クローズ直後の即時 focus はダイアログの終了処理に上書きされがちなので、
//   (1) blur→focus サイクルで WM にフォーカスを明示的に戻す
//   (2) ダイアログのクローズ完了後にも効かせるため次tick でリトライ
// を行う。DOM の activeElement は保持されるため、これで入力欄への打鍵が復帰する。
ipcMain.on("graphy:refocus", (e) => {
  const wc = e.sender;
  if (!wc || wc.isDestroyed()) return;
  const win = BrowserWindow.fromWebContents(wc);
  const apply = () => {
    if (win && !win.isDestroyed()) {
      win.blur();
      win.focus();
    }
    if (!wc.isDestroyed()) wc.focus();
  };
  apply();
  setTimeout(apply, 60); // GTK ダイアログのクローズ完了後に再適用
});

// ─────────────────────────────────────────────────────────────────────────────
// 秘密情報（API キー）— fw/art-of-imaging-design.md §2
//
// 意図的に「取り出す」IPC を持たない。平文が main プロセスの外へ出る経路を作らないため、
// レンダラが知れるのは statusOf が返す「入っているか否か」だけである。
// ─────────────────────────────────────────────────────────────────────────────
/**
 * main だけが書く鍵。🔴 **レンダラ（＝同じ realm のプラグイン）から書かせない。**
 * Colab の refresh token を差し替えられると、ランタイムが**別人の Google アカウント**に作られ、
 * 匿名化したデータとコードがそこへ送られる。書くのはログインの流れ（colabAuth）だけ。
 */
const MAIN_ONLY_SECRET_KEYS = new Set([COLAB_REFRESH_KEY]);

ipcMain.handle("graphy:secret-set", async (_e, payload) => {
  const key = payload && payload.key;
  const value = payload && payload.value;
  if (MAIN_ONLY_SECRET_KEYS.has(String(key))) return { ok: false, persisted: false, reason: "unknown-key" };
  const r = secretStore.setSecret(String(key || ""), String(value == null ? "" : value));
  if (r.ok && isComputeKey(key)) await pushComputeEndpoints();
  return r;
});

ipcMain.handle("graphy:secret-status", (_e, key) => secretStore.statusOf(String(key || "")));

ipcMain.handle("graphy:secret-clear", async (_e, key) => {
  if (MAIN_ONLY_SECRET_KEYS.has(String(key))) return false; // ログアウトは compute-colab-signout で
  const ok = secretStore.clearSecret(String(key || ""));
  if (ok && isComputeKey(key)) await pushComputeEndpoints();
  return ok;
});

// AI 中継。CSP によりレンダラからは外部 API を叩けないため main が肩代わりする。
// 用途 → 提供元の解決と応答の正規化は aiGateway / aiAdapters が行う（fw/ai-routing-design.md）。
ipcMain.handle("graphy:ai-generate", async (_e, req) => aiGateway.generate(req || {}));

// 用途 → どこへ何で送るか。**同意ダイアログに出す宛先をレンダラが知るため**に要る。
// 🔑 解決の権限は main に 1 つだけ置く（レンダラ側に同じ計算を持つと、同意画面に出す宛先と
//    実際の宛先がずれる余地ができる）。
ipcMain.handle("graphy:ai-resolve", (_e, capability) =>
  aiGateway.resolveCapability(String(capability || "")),
);

// 提供元の一覧と用途ごとの既定。**鍵は含まない**（secretStore が持ち、値は返らない）。
ipcMain.handle("graphy:ai-providers-get", () => {
  const c = aiProviders.get();
  return {
    providers: c.providers.map((p) => ({
      id: p.id,
      label: p.label,
      kind: p.kind,
      endpoint: p.endpoint,
      models: p.models,
      // 設定で差を吸収する項目（段 5）。**鍵は含まれない。**
      ...(p.auth !== undefined ? { auth: p.auth } : {}),
      ...(p.pathStyle ? { pathStyle: p.pathStyle } : {}),
      ...(p.apiVersion ? { apiVersion: p.apiVersion } : {}),
      ...(p.paths ? { paths: p.paths } : {}),
      ...(p.headers ? { headers: p.headers } : {}),
      // 平文 http の宛先。画面が印を出す（院内アドレスのみ許される）。
      ...(p.plaintext ? { plaintext: true } : {}),
      // 鍵が入っているかだけを返す。**値は返さない。**
      hasApiKey: !!aiProviders.secretKeyCandidates(p.id).find((k) => secretStore.statusOf(k).hasValue),
      secretKey: aiProviders.secretKeyFor(p.id),
    })),
    defaults: c.defaults,
    problems: c.problems,
    capabilities: aiProviders.CAPABILITIES,
  };
});
/**
 * 用途ごとの既定だけを差し替える。**確認は出さない**（日常操作を重くしない）。
 *
 * <p>🔑 提供元の一覧を渡させないので、**この口からは新しい送信先が生えない**。
 */
ipcMain.handle("graphy:ai-defaults-set", (_e, defaults) => {
  const current = aiProviders.get();
  return aiProviders.save({
    providers: current.providers,
    defaults: { ...current.defaults, ...(defaults || {}) },
  });
});

/** 提供元 1 件の「送信先としての同一性」。ここが変わったら利用者に聞く。 */
function destinationOf(p) {
  return JSON.stringify({
    endpoint: p.endpoint,
    paths: p.paths || null,
    auth: p.auth || null,
    pathStyle: p.pathStyle || null,
    headers: p.headers || null,
  });
}

/**
 * 提供元の一覧を保存する。
 *
 * <p>🔴 **新しい送信先が増える／変わるときは main が利用者に聞く。** この口はレンダラに
 * 公開されており、プラグインも同じ realm に居るので呼べてしまう——**悪意やバグのある
 * プラグインが「自分のサーバを提供元として追加し、既定にする」ことを防ぐ唯一の実効的な手段が
 * これ**（ダイアログは main が描くのでレンダラから偽装・迂回できない）。
 */
ipcMain.handle("graphy:ai-providers-set", async (e, cfg) => {
  const incoming = (cfg && Array.isArray(cfg.providers) ? cfg.providers : []);
  const before = new Map(aiProviders.get().providers.map((p) => [p.id, destinationOf(p)]));
  const added = [];
  for (const p of incoming) {
    if (!p || typeof p.endpoint !== "string") continue;
    const prev = before.get(p.id);
    if (prev === undefined || prev !== destinationOf(p)) added.push(`${p.id}: ${p.endpoint}`);
  }
  if (added.length > 0) {
    const win = BrowserWindow.fromWebContents(e.sender) || BrowserWindow.getFocusedWindow();
    const choice = dialog.showMessageBoxSync(win, {
      type: "warning",
      buttons: ["許可する", "取り消す"],
      defaultId: 1,
      cancelId: 1,
      title: "外部 AI の送信先を変更します",
      message: "以下の送信先を追加・変更しようとしています。",
      detail: `${added.join("\n")}\n\nここへ画像と指示が送られます。心当たりがない場合は取り消してください。`,
    });
    if (choice !== 0) return { ok: false, canceled: true, problems: [] };
  }
  const result = aiProviders.save(cfg || {});
  if (result.ok && added.length > 0) {
    console.log(`[ai] registry change: ${added.join(" / ")}`);
  }
  return result;
});

// 検査だけ（**書かない**）。設定画面が入力中に叩く。
// 🔴 検査規則をレンダラ側に書き写さないため（二重に持つと必ずずれる）。
ipcMain.handle("graphy:ai-providers-validate", (_e, cfg) => aiProviders.validate(cfg || {}));

/**
 * 接続テスト（疎通確認）。
 *
 * <p>🔑 **私たちが全社を事前検証することはできない**ので、利用者が自分で確かめる手段を持つ。
 * 送るのは 1×1 の白画像と固定の指示だけ（`aiGateway` 内の定数）。**患者画像は使わない。**
 *
 * <p>🔴 **画像生成の疎通は 1 枚生成＝課金が発生する**ので、ここで確認を取る。
 * `dialog` は main が描くので、レンダラ（＝プラグイン）からは迂回できない。
 */
ipcMain.handle("graphy:ai-test-connection", async (e, payload) => {
  const providerId = String((payload && payload.providerId) || "");
  const capability = String((payload && payload.capability) || "");
  if (capability === "image-to-image") {
    const win = BrowserWindow.fromWebContents(e.sender) || BrowserWindow.getFocusedWindow();
    const choice = dialog.showMessageBoxSync(win, {
      type: "warning",
      buttons: ["実行する", "取り消す"],
      defaultId: 1,
      cancelId: 1,
      title: "接続を確かめる（画像生成）",
      message: "画像を 1 枚生成するため、提供元に課金されます。",
      detail: `提供元: ${providerId}\n1×1 の白い画像と短い指示だけを送ります（患者の画像は送りません）。`,
    });
    if (choice !== 0) return { ok: false, verdict: "canceled", error: "canceled" };
  }
  return aiGateway.testConnection({ providerId, capability });
});

// ─────────────────────────────────────────────────────────────────────────────
// 外部の計算機（Jupyter Server）— fw/remote-compute-design.md
//
// 接続先は compute-endpoints.json、トークンは secretStore（compute.endpoint.<id>.token）。
// backend にはトークン込みで内部経路から入れる（backend はメモリにだけ持つ）。
// ─────────────────────────────────────────────────────────────────────────────
function isComputeKey(key) {
  return typeof key === "string" && /^compute\.endpoint\.[a-z0-9-]{1,32}\.token$/.test(key);
}

/** 接続先をトークン込みで backend へ入れ直す（起動時・保存時・トークン変更時）。 */
async function pushComputeEndpoints() {
  if (!computeBridge.enabled()) return { ok: false, error: "main-channel-disabled" };
  const all = computeEndpoints.get().endpoints;
  const jupyter = all
    .filter((e) => e.kind !== "colab")
    .map((e) => ({ id: e.id, label: e.label, url: e.url, kind: "jupyter",
      token: secretStore.getSecret(computeEndpoints.secretKeyFor(e.id)) || null }));
  // Colab は確保したランタイムだけ（URL とトークンはランタイムごとに Colab が決める）
  const colabIds = new Set(all.filter((e) => e.kind === "colab").map((e) => e.id));
  const colab = colabRuntimes ? colabRuntimes.endpoints().filter((e) => colabIds.has(e.id)) : [];
  return computeBridge.pushEndpoints([...jupyter, ...colab]);
}

// ── Colab（fw/remote-compute-design.md §15）──────────────────────────────────
// ログインは colabAuth（refresh token は secretStore・main だけ）、API は colabApi（公式 v1beta だけ）、
// ランタイムは colabRuntimes（確保・トークン更新・解放）。backend からは普通の Jupyter に見える。
let colabAuth = null;
let colabApi = null;
let colabRuntimes = null;

function initColab() {
  colabAuth = createColabAuth({
    // 開発時は desktop/、配布物はアプリの中かデータの置き場（.gitignore 済み・配布物にはビルド時に入れる）
    dirs: [__dirname, resolveDataDir()],
    secrets: secretStore,
    openExternal: (url) => shell.openExternal(url),
  });
  colabApi = createColabApi(() => colabAuth.accessToken());
  colabRuntimes = createColabRuntimes(colabApi, () => pushComputeEndpoints().then(() => undefined));
}

/** 画面へ返す Colab の状態（トークンは返さない）。 */
ipcMain.handle("graphy:compute-colab-status", async () => ({
  configured: !!colabAuth && colabAuth.configured(),
  signedIn: !!colabAuth && colabAuth.signedIn(),
  email: colabAuth ? await colabAuth.ensureEmail() : null,
}));

// Google でログイン（利用者のブラウザで）
ipcMain.handle("graphy:compute-colab-signin", async () => (colabAuth ? colabAuth.signIn() : { ok: false, error: "not-ready" }));

// ログアウト（確保したランタイムを解放してから、Google 側の許可も取り消す）
ipcMain.handle("graphy:compute-colab-signout", async () => {
  if (!colabAuth) return { ok: false, error: "not-ready" };
  await colabRuntimes.releaseAll();
  return colabAuth.signOut();
});

/** プランと、選べるランタイムの種類（eligible のものに印）。 */
ipcMain.handle("graphy:compute-colab-specs", async () => {
  try {
    const [sub, specs] = await Promise.all([colabApi.subscription(), colabApi.runtimeSpecs()]);
    return { ok: true, tier: sub.tier || null, specs };
  } catch (e) {
    return { ok: false, error: (e && e.code) || String(e && e.message) };
  }
});

/**
 * その Colab 接続先のランタイムを確保する（済んでいれば何もしない）。
 * <p>確保だけでは患者のデータは出ない（データとコードは同意のあとで送る）。利用者の Colab の利用枠は使う。
 */
ipcMain.handle("graphy:compute-colab-ensure", async (_e, id) => {
  const ep = computeEndpoints.byId(String(id || ""));
  if (!ep || ep.kind !== "colab") return { ok: false, error: "not-a-colab-endpoint" };
  if (!colabAuth.signedIn()) return { ok: false, error: "not-signed-in" };
  try {
    return { ok: true, ...(await colabRuntimes.ensure(ep.id, ep.label, ep.spec)) };
  } catch (e) {
    return { ok: false, error: (e && e.code) || String(e && e.message) };
  }
});

ipcMain.handle("graphy:compute-colab-release", async (_e, id) => colabRuntimes.release(String(id || "")));

/**
 * 既定の計算機を用意する（計算機が 1 つも無く、Google にログイン済みなら Colab の T4 を 1 本だけ足す）。
 * <p>確認ダイアログは出さない: 送り先は利用者自身の Google アカウントの Colab に固定で、足しただけでは何も送らない
 * （毎回の実行で同意画面に送り先が出る）。任意の URL を足せる口ではないので、compute-endpoints-set の確認とは別に扱う。
 */
ipcMain.handle("graphy:compute-ensure-default", async () => {
  const r = await ensureDefaultEndpoint({ endpoints: computeEndpoints, colabAuth, colabApi });
  if (r.ok && r.added) {
    console.log(`[compute] default endpoint added: ${r.endpointId}`);
    await pushComputeEndpoints();
  }
  return r;
});

// 接続先の一覧。**トークンは含まない**（入っているかだけ）。
ipcMain.handle("graphy:compute-endpoints-get", () => {
  const c = computeEndpoints.get();
  return {
    endpoints: c.endpoints.map((e) =>
      e.kind === "colab"
        ? { ...e, hasToken: !!colabAuth && colabAuth.signedIn(), runtime: colabRuntimes ? colabRuntimes.status(e.id) : { allocated: false } }
        : {
            ...e,
            secretKey: computeEndpoints.secretKeyFor(e.id),
            hasToken: secretStore.statusOf(computeEndpoints.secretKeyFor(e.id)).hasValue,
          },
    ),
    problems: c.problems,
    // 内部経路が使えない（backend を別に起動した開発など）ときは画面が理由を出す
    available: computeBridge.enabled(),
  };
});

// 検査だけ（書かない）。🔴 検査規則をレンダラ側に書き写さない。
ipcMain.handle("graphy:compute-endpoints-validate", (_e, cfg) => computeEndpoints.validate(cfg || {}));

/**
 * 接続先の一覧を保存する。
 *
 * <p>🔴 **送信先が増える／変わるときは main が利用者に聞く**（AI の提供元と同じ。プラグインも
 * レンダラと同じ realm に居てこの口を呼べるので、「自分のサーバを計算機として足す」のを防ぐ手段がこれ）。
 * ここへは匿名化した画像と、プラグインのコードが送られる。
 */
ipcMain.handle("graphy:compute-endpoints-set", async (e, cfg) => {
  const checked = computeEndpoints.validate(cfg || {});
  if (!checked.ok) return { ok: false, problems: checked.problems };
  const before = new Map(computeEndpoints.get().endpoints.map((x) => [x.id, computeEndpoints.destinationOf(x)]));
  const added = checked.endpoints
    .filter((x) => before.get(x.id) !== computeEndpoints.destinationOf(x))
    .map((x) =>
      x.kind === "colab"
        ? `${x.id}: Google Colab（${x.spec.variant.replace(/^VARIANT_/, "")} ${x.spec.accelerator}・あなたの Google アカウント）`
        : `${x.id}: ${x.url}${x.plaintext ? "  (http・暗号化なし)" : ""}`,
    );
  if (added.length > 0) {
    const win = BrowserWindow.fromWebContents(e.sender) || BrowserWindow.getFocusedWindow();
    const choice = dialog.showMessageBoxSync(win, {
      type: "warning",
      buttons: ["許可する", "取り消す"],
      defaultId: 1,
      cancelId: 1,
      title: "外部の計算機を追加・変更します",
      message: "以下の計算機を登録しようとしています。",
      detail: `${added.join("\n")}\n\nここへ匿名化した画像と、プラグインが実行するコードが送られます。心当たりがない場合は取り消してください。`,
    });
    if (choice !== 0) return { ok: false, canceled: true, problems: [] };
  }
  // 消した接続先のトークンは残さない
  const keep = new Set(checked.endpoints.map((x) => x.id));
  const removed = computeEndpoints.get().endpoints.filter((x) => !keep.has(x.id));
  const result = computeEndpoints.save({ endpoints: checked.endpoints });
  if (result.ok) {
    for (const x of removed) {
      if (x.kind === "colab") await colabRuntimes.release(x.id);
      else secretStore.clearSecret(computeEndpoints.secretKeyFor(x.id));
    }
    if (added.length > 0) console.log(`[compute] registry change: ${added.join(" / ")}`);
    await pushComputeEndpoints();
  }
  return result;
});

/**
 * 接続テスト。渡せるのは接続先の id だけ——実行するコードは backend の定数
 * （ComputeConnectionTester.PROBE）で、患者のデータもプラグインのコードも送らない。
 */
ipcMain.handle("graphy:compute-test-connection", async (_e, id) => {
  if (!computeEndpoints.byId(String(id || ""))) return { ok: false, stage: "bridge", error: "unknown-endpoint" };
  await pushComputeEndpoints(); // backend が再起動していても最新を入れてから試す
  return computeBridge.testEndpoint(String(id));
});

/**
 * 外部の計算機へ送る前の同意（fw/remote-compute-design.md §4.2）。
 *
 * <p>🔴 **レンダラが渡せるのは要求の id だけ。** 見せる内容（宛先・データ・コード全文）は main が backend から
 * 取り直し、main の窓（computeConsent）で聞く。承認は見せた内容のハッシュ付きで backend へ返す。
 * 同時に開く同意画面は 1 つだけ（プラグインが要求を連打しても窓が積み上がらない）。
 */
ipcMain.handle("graphy:compute-confirm", async (e, requestId) => {
  if (!computeBridge.enabled()) return { ok: false, error: "main-channel-disabled" };
  const id = String(requestId || "");
  if (!/^egr_[0-9a-f-]{36}$/.test(id)) return { ok: false, error: "bad-request-id" };
  if (computeConsent.busy()) return { ok: false, error: "consent-busy" };
  const d = await computeBridge.getEgress(id);
  if (!d.ok || !d.body) return { ok: false, error: "not-pending" };
  const parent = BrowserWindow.fromWebContents(e.sender);
  const locale = String(app.getLocale() || "").startsWith("ja") ? "ja" : "en";
  const approve = await computeConsent.ask(parent, d.body, locale);
  const r = await computeBridge.decideEgress(id, approve, d.body.contentHash);
  console.log(`[compute] consent ${id} plugin=${d.body.pluginId} endpoint=${d.body.endpointId} approve=${approve} ok=${r.ok}`);
  if (!approve) return { ok: true, approved: false };
  return r.ok ? { ok: true, approved: true } : { ok: false, error: "decision-rejected" };
});

// 名前を付けて保存。OS ネイティブのダイアログを使うので、**同名ファイルの上書き確認は
// OS が標準で出す**（アプリ側で自前実装しない）。保存したパスを返す。取り消しなら null。
ipcMain.handle("graphy:save-file", async (e, payload) => {
  const defaultName = (payload && payload.defaultName) || "untitled";
  const filters = (payload && Array.isArray(payload.filters) && payload.filters) || [{ name: "PNG", extensions: ["png"] }];
  const bytes = payload && payload.bytes;
  if (!bytes || typeof bytes.byteLength !== "number" || bytes.byteLength === 0) {
    return { ok: false, error: "empty" };
  }
  const win = BrowserWindow.fromWebContents(e.sender) || BrowserWindow.getFocusedWindow();
  const result = await dialog.showSaveDialog(win, { title: "名前を付けて保存", defaultPath: defaultName, filters });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };
  try {
    fs.writeFileSync(result.filePath, Buffer.from(bytes));
    return { ok: true, filePath: result.filePath };
  } catch (err) {
    console.error("[save] 書き込みに失敗:", err.message);
    return { ok: false, error: String(err.message) };
  }
});

// 起動を続けても意味が無い（backend が動かない）失敗。スプラッシュは一瞬で閉じてしまうので、
// これらだけは OS のダイアログでも出して、原因が読める状態で残す。
const FATAL_CODES = new Set([
  "jar-missing",
  "jar-broken",
  "java-missing",
  "java-too-old",
  "spawn-failed",
  "port-in-use",
  "db-locked",
  "backend-exited",
]);

/** 起動失敗を「直接的な原因」としてスプラッシュ（と、致命的ならダイアログ）へ出す。 */
function reportStartupFailure(e) {
  console.error("[startup]", e);
  const err = e instanceof StartupError ? e : new StartupError("unknown", String(e && e.message ? e.message : e));
  forwardProgress({
    step: "error",
    state: "error",
    code: err.code,
    params: err.params,
    detail: err.detail,
  });
  if (FATAL_CODES.has(err.code)) {
    const locale = String(app.getLocale() || "").startsWith("ja") ? "ja" : "en";
    const text = messages.format(locale, err.code, err.params);
    // ダイアログは createWindow の後に出す（メインウィンドウの背後に残さない）。
    setTimeout(() => {
      dialog.showErrorBox("GRAPHY-Next", err.detail ? `${text}\n\n${err.detail}` : text);
    }, 0);
  }
}

app.whenReady().then(async () => {
  // 秘密情報の置き場は backend の CWD（H2・DICOM 保管庫と同じ場所）に揃える。
  secretStore.init(resolveDataDir());
  aiProviders.init(resolveDataDir());
  computeEndpoints.init(resolveDataDir());
  initColab();
  if (MAIN_SECRET) computeBridge.init({ secret: MAIN_SECRET, apiBase: API_BASE });
  createSplash();
  try {
    startBackend();
    await waitForBackend();
    // 外部の計算機の接続先を backend へ（失敗してもアプリの起動は止めない）
    pushComputeEndpoints().catch((err) => console.error("[compute] push failed:", err));
  } catch (e) {
    reportStartupFailure(e);
  }
  createWindow(); // スプラッシュは createWindow の ready-to-show で閉じる

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

function stopBackend() {
  if (backendProc) {
    console.log("[backend] stopping");
    backendProc.kill();
    backendProc = null;
  }
}

app.on("window-all-closed", () => {
  stopBackend();
  if (process.platform !== "darwin") app.quit();
});

// 確保した Colab のランタイムは閉じる前に解放する（利用者の Colab の利用枠を使い続けない）。
// 解放は非同期なので一度だけ終了を止めて待つ（最大 10 秒）。
let colabReleasedOnQuit = false;
app.on("before-quit", (event) => {
  if (colabReleasedOnQuit || !colabRuntimes || colabRuntimes.endpoints().length === 0) return;
  event.preventDefault();
  colabReleasedOnQuit = true;
  Promise.race([colabRuntimes.releaseAll(), new Promise((r) => setTimeout(r, 10000))]).finally(() => app.quit());
});
app.on("before-quit", stopBackend);
process.on("exit", stopBackend);
