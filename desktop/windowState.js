// GRAPHY-Next — ウィンドウ表示位置の記憶（Window Position Memory）
//
// 各ウィンドウ（MainScreen / 2D / 3D / MPR / Slicer / Curved MPR）の前回の
// スクリーン座標・サイズ・最大化状態を記憶し、再オープン時に同じ位置へ復元する。
// 迷子防止（画面構成の変化・OutOfRange）を最優先に検証してから復元する。
//
// 設計: fw/window-position-memory.md
// メインプロセス専用。web モードは対象外（ブラウザがタブ位置を管理する）。
//
// 使い方（どのウィンドウでも共通）:
//   const keeper = createWindowStateKeeper("mpr", { width: 1400, height: 900 });
//   const win = new BrowserWindow({ ...keeper.initialBounds, show: false, webPreferences });
//   keeper.track(win);
//   win.once("ready-to-show", () => {
//     if (keeper.isMaximized) win.maximize();
//     if (keeper.isFullScreen) win.setFullScreen(true);
//     win.show();
//   });

const { app } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const geometry = require("./windowGeometry");

// screen モジュールは app 準備完了後にのみ参照できるため遅延取得する。
function getScreen() {
  return require("electron").screen;
}

// --- 永続化 -------------------------------------------------------------

const APP_DATA_FOLDER = "GRAPHY-Next"; // main.js の APP_DATA_FOLDER と一致させること。

/**
 * 保存先:
 *   packaged … <appData>/GRAPHY-Next/window-state.json（アンインストーラが掃除する既存データ領域）
 *   dev      … <userData>/window-state.dev.json（repo を汚さない）
 */
function stateFilePath() {
  if (app.isPackaged) {
    return path.join(app.getPath("appData"), APP_DATA_FOLDER, "window-state.json");
  }
  return path.join(app.getPath("userData"), "window-state.dev.json");
}

let store = null; // { version:1, windows: { [key]: SavedState } }

function loadStore() {
  if (store) return store;
  store = { version: 1, windows: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFilePath(), "utf8"));
    if (parsed && parsed.windows && typeof parsed.windows === "object") {
      store.windows = parsed.windows;
    }
  } catch {
    // 初回起動 or 破損 → 既定（空）で続行
  }
  return store;
}

let saveTimer = null;

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(writeStore, 400);
}

function writeStore() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (!store) return;
  try {
    const p = stateFilePath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2)); // アトミック書込（tmp→rename）
    fs.renameSync(tmp, p);
  } catch (e) {
    console.error("[windowState] save failed:", e);
  }
}

// --- 幾何ユーティリティ --------------------------------------------------

const isFiniteRect = geometry.isFiniteRect;

/**
 * 迷子防止の中核。保存 bounds を現在のディスプレイ構成に照らして検証し、
 * workArea に収まるよう縮小したうえで、<b>全体が見えていなければ</b>可視域へクランプする。
 *
 * <p>判定そのものは Electron に依存しない {@code windowGeometry.js} にあり、単体テストで守っている。
 * ここは「今のディスプレイ構成を渡す」だけ。
 *
 * @param {any} saved   保存された bounds（不正なら既定にフォールバック）
 * @param {{width:number,height:number}} def
 * @returns {{x?:number,y?:number,width:number,height:number}}
 *          x,y を省略した場合は Electron がプライマリ中央に配置する。
 */
function sanitizeBounds(saved, def) {
  if (!isFiniteRect(saved)) {
    return { width: Math.round(def.width), height: Math.round(def.height) };
  }
  const screen = getScreen();
  // 最も重なるディスプレイ（全画面外なら最近傍/プライマリ）を基準にする。
  const target = screen.getDisplayMatching({
    x: Math.round(saved.x),
    y: Math.round(saved.y),
    width: Math.round(saved.width),
    height: Math.round(saved.height),
  });
  const workAreas = screen.getAllDisplays().map((d) => d.workArea); // タスクバー等を除いた領域（DIP 基準）
  return geometry.sanitizeBounds(saved, def, target.workArea, workAreas);
}

// --- ディスプレイ構成変化への追従 ---------------------------------------

/** @type {Set<{win: import('electron').BrowserWindow, def: any}>} */
const tracked = new Set();
let screenListenersBound = false;

function ensureScreenListeners() {
  if (screenListenersBound) return;
  const screen = getScreen();
  const onChange = () => reclampTrackedWindows();
  screen.on("display-removed", onChange);
  screen.on("display-added", onChange);
  screen.on("display-metrics-changed", onChange);
  screenListenersBound = true;
}

// 動作中にモニタ構成が変わった場合、生きているウィンドウを可視域へ引き戻す。
// 解像度が下がった場合も（ディスプレイの増減が無くても）ここで収まり直す。
function reclampTrackedWindows() {
  for (const entry of tracked) {
    const win = entry.win;
    if (win.isDestroyed() || win.isMaximized() || win.isFullScreen()) continue;
    const cur = win.getBounds();
    const safe = sanitizeBounds(cur, entry.def);
    if (
      Number.isFinite(safe.x) &&
      Number.isFinite(safe.y) &&
      (safe.x !== cur.x || safe.y !== cur.y || safe.width !== cur.width || safe.height !== cur.height)
    ) {
      win.setBounds({ x: safe.x, y: safe.y, width: safe.width, height: safe.height });
    }
  }
}

// --- keeper --------------------------------------------------------------

function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => {
      t = null;
      fn(...args);
    }, ms);
  };
}

/**
 * @typedef WindowDefaults
 * @property {number}  width
 * @property {number}  height
 * @property {boolean} [rememberMaximize=true]
 */

/**
 * @param {string} key   画面キー（"main" / "2dviewer" / "mpr" ...）
 * @param {WindowDefaults} defaults
 * @returns {{
 *   key: string,
 *   initialBounds: {x?:number,y?:number,width:number,height:number},
 *   isMaximized: boolean,
 *   isFullScreen: boolean,
 *   track: (win: import('electron').BrowserWindow) => void,
 *   untrack: () => void,
 * }}
 */
function createWindowStateKeeper(key, defaults) {
  ensureScreenListeners();

  const def = {
    width: defaults.width,
    height: defaults.height,
    rememberMaximize: defaults.rememberMaximize !== false,
  };

  const s = loadStore();
  const saved = s.windows[key];
  const initialBounds = sanitizeBounds(saved, def);

  let entry = null;

  const keeper = {
    key,
    initialBounds,
    isMaximized: def.rememberMaximize && !!(saved && saved.isMaximized),
    isFullScreen: def.rememberMaximize && !!(saved && saved.isFullScreen),

    track(win) {
      entry = { win, def };
      tracked.add(entry);

      const capture = (flush) => {
        if (win.isDestroyed()) return;
        // 最大化/フルスクリーン中は通常サイズ（getNormalBounds）を保存する。
        const b = win.getNormalBounds();
        if (!isFiniteRect(b)) return;
        let displayId = 0;
        try {
          displayId = getScreen().getDisplayMatching(b).id;
        } catch {
          /* ignore */
        }
        loadStore().windows[key] = {
          x: b.x,
          y: b.y,
          width: b.width,
          height: b.height,
          isMaximized: def.rememberMaximize && win.isMaximized(),
          isFullScreen: def.rememberMaximize && win.isFullScreen(),
          displayId,
        };
        if (flush) writeStore();
        else scheduleSave();
      };

      const onChange = debounce(() => capture(false), 400);
      win.on("move", onChange);
      win.on("resize", onChange);
      win.on("maximize", () => capture(false));
      win.on("unmaximize", () => capture(false));
      win.on("enter-full-screen", () => capture(false));
      win.on("leave-full-screen", () => capture(false));
      // 終了直前に確実に書き出す（この後すぐ app.quit する場合に備え同期 flush）。
      win.on("close", () => capture(true));
      win.on("closed", () => {
        if (entry) tracked.delete(entry);
        entry = null;
      });
    },

    untrack() {
      if (entry) tracked.delete(entry);
      entry = null;
    },
  };

  return keeper;
}

module.exports = { createWindowStateKeeper };
