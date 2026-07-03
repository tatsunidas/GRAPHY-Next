// Electron preload（sandbox 互換）。レンダラ(React)が backend を叩けるよう API ベース URL を注入する。
// sandbox 下では require が制限されるため、config.json を読まず process.argv（main.js が
// additionalArguments で渡す --graphy-api-base）から受け取る。
const { contextBridge, ipcRenderer } = require("electron");

function argValue(name) {
  const prefix = `--${name}=`;
  const found = process.argv.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

const apiBase = argValue("graphy-api-base") || "http://localhost:8080";
contextBridge.exposeInMainWorld("__GRAPHY_API_BASE__", apiBase);

// セキュリティ状態（環境設定での確認用）。preload で実値を読める。
contextBridge.exposeInMainWorld("__GRAPHY_SECURITY__", {
  contextIsolation: process.contextIsolated === true,
  sandbox: process.sandboxed === true,
});

// デスクトップ専用 API（ネイティブダイアログ等）。main プロセスへ橋渡し。
contextBridge.exposeInMainWorld("graphyDesktop", {
  pickImportPaths: () => ipcRenderer.invoke("graphy:pick-import"),
  // 単一の出力先フォルダを選ぶ（SeriesExtractor のコピー先など）。
  pickDirectory: () => ipcRenderer.invoke("graphy:pick-directory"),
  openViewer: (screen) => ipcRenderer.invoke("graphy:open-viewer", screen),
  // PNG dataURL を OS のネイティブドラッグに乗せて外部へ書き出す。
  startDrag: (dataUrl, filename) => ipcRenderer.send("graphy:start-drag", { dataUrl, filename }),
  // OS 標準のメモリ/システムモニタを起動する。
  openMemoryMonitor: () => ipcRenderer.invoke("graphy:open-memory-monitor"),
  // 外部 URL / mailto を OS の既定アプリで開く。
  openExternal: (url) => ipcRenderer.send("graphy:open-external", url),
  // GitHub Releases の最新版情報を取得（更新確認）。失敗時 null。
  checkForUpdate: () => ipcRenderer.invoke("graphy:check-update"),
});
