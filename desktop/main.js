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

const PORT = process.env.GRAPHY_BACKEND_PORT || String(cfg.backend.port);
const PROFILE = process.env.GRAPHY_BACKEND_PROFILE || cfg.backend.profile;
const HEALTH_PATH = cfg.backend.healthPath;
const HEALTH_TIMEOUT_MS = cfg.backend.healthTimeoutMs;
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

// アプリアイコン（Linux/Windows のウィンドウ・タスクバー用。macOS は .icns を使うため無視される）。
// 単一マスター = frontend/public/icons/app/app_icon.png。dev はそこから直接、packaged は
// build 時に renderer へ同梱されたコピー（desktop/renderer/icons/app/app_icon.png）から読む。
// インストーラ/アプリバンドル本体のアイコンは electron-builder が desktop/build/icon.png から生成する（別経路）。
const APP_ICON = DEV
  ? path.join(__dirname, "..", "frontend", "public", "icons", "app", "app_icon.png")
  : path.join(__dirname, "renderer", "icons", "app", "app_icon.png");

let backendProc = null;
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
    ],
    { cwd: dataDir, stdio: ["ignore", "pipe", "pipe"] },
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

// 単一フォルダ選択（SeriesExtractor のコピー先など）。選んだ絶対パス（無ければ null）。
ipcMain.handle("graphy:pick-directory", async () => {
  const result = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow(), {
    title: "出力先フォルダを選択",
    properties: ["openDirectory", "createDirectory"],
  });
  return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
});

// アプリ全体を再起動する（DICOM 自局設定など、SCP リスナー起動時にしか反映されない設定の変更後に使う）。
// before-quit で stopBackend が走るため、次回起動時に新しい設定で backend が立ち上がる。
ipcMain.handle("graphy:relaunch", () => {
  app.relaunch();
  app.quit();
});

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
