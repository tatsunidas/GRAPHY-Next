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

const { app, BrowserWindow, shell } = require("electron");
const { spawn } = require("node:child_process");
const path = require("node:path");
const http = require("node:http");
const fs = require("node:fs");
const readline = require("node:readline");

const PROGRESS_PREFIX = "__GRAPHY_PROGRESS__";

const cfg = require("./config.json");

const PORT = process.env.GRAPHY_BACKEND_PORT || String(cfg.backend.port);
const PROFILE = process.env.GRAPHY_BACKEND_PROFILE || cfg.backend.profile;
const HEALTH_PATH = cfg.backend.healthPath;
const HEALTH_TIMEOUT_MS = cfg.backend.healthTimeoutMs;
const JAR_NAME = cfg.backend.jarName;
const DEV_URL = cfg.devServerUrl;
const WINDOW = cfg.window;
const API_BASE = `http://localhost:${PORT}`;
// セキュリティ設定（config.json の security セクション、無ければ安全な既定）。
const SECURITY = cfg.security || {};

const DEV = process.env.GRAPHY_DEV === "1";
const EXTERNAL_BACKEND = process.env.GRAPHY_BACKEND_EXTERNAL === "1";

let backendProc = null;

/** 同梱 / 開発時の backend jar のパスを解決する。 */
function resolveBackendJar() {
  const candidates = [
    // electron-builder で同梱した場合（extraResources → resources/backend）
    path.join(process.resourcesPath || "", "backend", JAR_NAME),
    // 開発時: リポジトリ内のビルド成果物
    path.join(__dirname, "resources", "backend", JAR_NAME),
    path.join(__dirname, "..", "backend", "target", JAR_NAME),
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

function startBackend() {
  if (EXTERNAL_BACKEND) {
    console.log("[backend] external mode — spawn をスキップ");
    return;
  }
  const jar = resolveBackendJar();
  if (!jar) {
    throw new Error(
      "backend jar が見つかりません。`make build` で backend をビルドしてください。",
    );
  }
  const javaCmd = resolveJava();
  // JVM ヒープ上限（config.backend.maxHeapMb、0/未設定なら JVM 既定）。画像処理に向けて調整可能。
  const maxHeapMb = Number(process.env.GRAPHY_MAX_HEAP_MB || cfg.backend.maxHeapMb || 0);
  const jvmArgs = maxHeapMb > 0 ? [`-Xmx${maxHeapMb}m`] : [];
  console.log(`[backend] starting: ${jar} (java=${javaCmd}, profile=${PROFILE}, port=${PORT}, maxHeapMb=${maxHeapMb || "default"})`);
  backendProc = spawn(
    javaCmd,
    [
      ...jvmArgs,
      "-jar",
      jar,
      `--spring.profiles.active=${PROFILE}`,
      `--server.port=${PORT}`,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  wireBackendOutput(backendProc);
  backendProc.on("exit", (code) => {
    console.log(`[backend] exited (code=${code})`);
    backendProc = null;
  });
}

/** backend の stdout/stderr を行単位で読み、進捗行はスプラッシュへ、それ以外はログへ。 */
function wireBackendOutput(proc) {
  if (proc.stdout) {
    readline.createInterface({ input: proc.stdout }).on("line", (line) => {
      const i = line.indexOf(PROGRESS_PREFIX);
      if (i >= 0) {
        try {
          forwardProgress(JSON.parse(line.slice(i + PROGRESS_PREFIX.length)));
        } catch {
          // 進捗行のパース失敗は無視
        }
      } else {
        console.log("[backend]", line);
      }
    });
  }
  if (proc.stderr) {
    readline.createInterface({ input: proc.stderr }).on("line", (line) => {
      console.error("[backend]", line);
    });
  }
}

/** ヘルスチェックパスが 200 を返すまでポーリングする。 */
function waitForBackend(timeoutMs = HEALTH_TIMEOUT_MS) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(
        { host: "127.0.0.1", port: PORT, path: HEALTH_PATH, timeout: 2000 },
        (res) => {
          res.resume();
          if (res.statusCode === 200) return resolve();
          retry();
        },
      );
      req.on("error", retry);
      req.on("timeout", () => req.destroy());
    };
    const retry = () => {
      if (Date.now() - start > timeoutMs) {
        return reject(new Error("backend のヘルスチェックがタイムアウトしました"));
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
    width: 480,
    height: 340,
    frame: false,
    resizable: false,
    center: true,
    show: true,
    backgroundColor: "#0b1b2b",
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
  const win = new BrowserWindow({
    width: WINDOW.width,
    height: WINDOW.height,
    show: false, // ロード完了まで隠す（スプラッシュからの切替えを滑らかに）
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

app.whenReady().then(async () => {
  createSplash();
  try {
    startBackend();
    await waitForBackend();
  } catch (e) {
    console.error("[startup]", e);
    forwardProgress({ step: "error", state: "error", message: "起動に失敗しました: " + (e.message || e) });
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

app.on("before-quit", stopBackend);
process.on("exit", stopBackend);
