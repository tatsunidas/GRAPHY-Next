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
  openViewer: (screen) => ipcRenderer.invoke("graphy:open-viewer", screen),
});
