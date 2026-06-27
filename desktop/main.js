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

const { app, BrowserWindow } = require("electron");
const { spawn } = require("node:child_process");
const path = require("node:path");
const http = require("node:http");
const fs = require("node:fs");

const cfg = require("./config.json");

const PORT = process.env.GRAPHY_BACKEND_PORT || String(cfg.backend.port);
const PROFILE = process.env.GRAPHY_BACKEND_PROFILE || cfg.backend.profile;
const HEALTH_PATH = cfg.backend.healthPath;
const HEALTH_TIMEOUT_MS = cfg.backend.healthTimeoutMs;
const JAR_NAME = cfg.backend.jarName;
const DEV_URL = cfg.devServerUrl;
const WINDOW = cfg.window;

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
  console.log(`[backend] starting: ${jar} (profile=${PROFILE}, port=${PORT})`);
  backendProc = spawn(
    "java",
    [
      "-jar",
      jar,
      `--spring.profiles.active=${PROFILE}`,
      `--server.port=${PORT}`,
    ],
    { stdio: "inherit" },
  );
  backendProc.on("exit", (code) => {
    console.log(`[backend] exited (code=${code})`);
    backendProc = null;
  });
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

function createWindow() {
  const win = new BrowserWindow({
    width: WINDOW.width,
    height: WINDOW.height,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (DEV) {
    win.loadURL(DEV_URL);
    win.webContents.openDevTools();
  } else {
    win.loadFile(path.join(__dirname, "renderer", "index.html"));
  }
}

app.whenReady().then(async () => {
  try {
    startBackend();
    await waitForBackend();
  } catch (e) {
    console.error("[startup]", e);
  }
  createWindow();

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
