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
  // 接続中の全ディスプレイ情報を取得（モニター診断パネル用）。
  listDisplays: () => ipcRenderer.invoke("graphy:list-displays"),
  // 指定モニターに目視テストパターンをフルスクリーン表示する。
  openMonitorQc: (displayId) => ipcRenderer.invoke("graphy:open-monitor-qc", displayId),
  // PNG dataURL を OS のネイティブドラッグに乗せて外部へ書き出す。
  startDrag: (dataUrl, filename) => ipcRenderer.send("graphy:start-drag", { dataUrl, filename }),
  // OS 標準のメモリ/システムモニタを起動する。
  openMemoryMonitor: () => ipcRenderer.invoke("graphy:open-memory-monitor"),
  // OS の物理メモリ量を取得（ボリューム構築のバジェット決定用）。
  getMemoryInfo: () => ipcRenderer.invoke("graphy:get-memory-info"),
  // 外部 URL / mailto を OS の既定アプリで開く。
  openExternal: (url) => ipcRenderer.send("graphy:open-external", url),
  // GitHub Releases の最新版情報を取得（更新確認）。失敗時 null。
  checkForUpdate: () => ipcRenderer.invoke("graphy:check-update"),
  // アプリ全体を再起動する（DICOM 自局設定などの反映用）。
  relaunch: () => ipcRenderer.invoke("graphy:relaunch"),
  // ネイティブダイアログ後にレンダラのキーボードフォーカスを復帰させる。
  refocus: () => ipcRenderer.send("graphy:refocus"),
  // API キー等の秘密情報。**取り出す口は無い**（平文を main の外へ出さないため）。
  // 分かるのは「入っているか」「OS のキーチェーンが使えるか」だけ。
  secretSet: (key, value) => ipcRenderer.invoke("graphy:secret-set", { key, value }),
  secretStatus: (key) => ipcRenderer.invoke("graphy:secret-status", key),
  secretClear: (key) => ipcRenderer.invoke("graphy:secret-clear", key),
  // Gemini への中継（CSP でレンダラからは外部 API に届かないため main が肩代わりする）。
  aiGenerate: (req) => ipcRenderer.invoke("graphy:ai-generate", req),
  // 名前を付けて保存。上書き確認は OS のダイアログが出す。
  saveFile: (payload) => ipcRenderer.invoke("graphy:save-file", payload),
  // 開くダイアログ（プラグインの H43 file.pickFiles）。ファイルだけ。選んだ絶対パスを返す。
  pickFiles: (payload) => ipcRenderer.invoke("graphy:pick-files", payload),
});
