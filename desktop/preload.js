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
  // PNG dataURL をクリップボードへ書く。成否を返す。
  copyImage: (dataUrl) => ipcRenderer.invoke("graphy:copy-image", dataUrl),
  // OS 標準のメモリ/システムモニタを起動する。
  openMemoryMonitor: () => ipcRenderer.invoke("graphy:open-memory-monitor"),
  // OS の物理メモリ量を取得（ボリューム構築のバジェット決定用）。
  getMemoryInfo: () => ipcRenderer.invoke("graphy:get-memory-info"),
  // Chromium の GPU 機能状態と GPU 一覧（描画環境の自己診断用）。
  getGpuStatus: () => ipcRenderer.invoke("graphy:gpu-status"),
  // GPU の搭載メモリ（設定＞描画環境）。取れなければ null。
  getGpuMemory: () => ipcRenderer.invoke("graphy:gpu-memory"),
  // 描画に使う GPU の選択（設定＞描画環境。反映は再起動）。
  getRenderPrefs: () => ipcRenderer.invoke("graphy:render-prefs-get"),
  setRenderPrefs: (prefs) => ipcRenderer.invoke("graphy:render-prefs-set", prefs),
  retryRenderPrefs: () => ipcRenderer.invoke("graphy:render-prefs-retry"),
  // 外部 URL / mailto を OS の既定アプリで開く。
  openExternal: (url) => ipcRenderer.send("graphy:open-external", url),
  // GitHub Releases の最新版情報を取得（更新確認）。失敗時 null。
  checkForUpdate: () => ipcRenderer.invoke("graphy:check-update"),
  // アプリ全体を再起動する（DICOM 自局設定などの反映用）。
  relaunch: () => ipcRenderer.invoke("graphy:relaunch"),
  // DB フォルダ（索引と DICOM 保管庫）。選択と最終確認のダイアログは main が出す。
  // DIMSE TLS のパスワード（OS のキーチェーンに預ける。値は返らない）
  tlsPasswordSet: (which, value) => ipcRenderer.invoke("graphy:tls-password-set", { which, value }),
  tlsPasswordStatus: () => ipcRenderer.invoke("graphy:tls-password-status"),
  // プラグイン導入の同意（有効にする前に main が確認ダイアログを出す）
  pluginInstallOptIn: (enabled) => ipcRenderer.invoke("graphy:plugin-install-opt-in", { enabled: enabled === true }),
  dbFoldersList: () => ipcRenderer.invoke("graphy:db-folders-list"),
  dbFoldersCreate: (title) => ipcRenderer.invoke("graphy:db-folders-create", { title }),
  dbFoldersPick: (title) => ipcRenderer.invoke("graphy:db-folders-pick", { title }),
  dbFoldersSwitch: (folder) => ipcRenderer.invoke("graphy:db-folders-switch", { folder }),
  dbFoldersForget: (folder) => ipcRenderer.invoke("graphy:db-folders-forget", { folder }),
  // ネイティブダイアログ後にレンダラのキーボードフォーカスを復帰させる。
  refocus: () => ipcRenderer.send("graphy:refocus"),
  // API キー等の秘密情報。**取り出す口は無い**（平文を main の外へ出さないため）。
  // 分かるのは「入っているか」「OS のキーチェーンが使えるか」だけ。
  secretSet: (key, value) => ipcRenderer.invoke("graphy:secret-set", { key, value }),
  secretStatus: (key) => ipcRenderer.invoke("graphy:secret-status", key),
  secretClear: (key) => ipcRenderer.invoke("graphy:secret-clear", key),
  // Gemini への中継（CSP でレンダラからは外部 API に届かないため main が肩代わりする）。
  aiGenerate: (req) => ipcRenderer.invoke("graphy:ai-generate", req),
  // 用途 → どこへ何で送るか（同意ダイアログの宛先表示に使う）。
  aiResolve: (capability) => ipcRenderer.invoke("graphy:ai-resolve", capability),
  // 会話。アシスタント窓（#assistant）以外から呼ぶと main が forbidden を返す。
  aiChat: (req) => ipcRenderer.invoke("graphy:ai-chat", req),
  assistantMicAccess: () => ipcRenderer.invoke("graphy:assistant-mic-access"),
  aiTranscribe: (req) => ipcRenderer.invoke("graphy:ai-transcribe", req),
  aiChatCancel: (sessionId) => ipcRenderer.invoke("graphy:ai-chat-cancel", sessionId),
  // ストリームの差分。購読解除の関数を返す。
  onAiChatEvent: (cb) => {
    const handler = (_e, ev) => cb(ev);
    ipcRenderer.on("graphy:ai-chat-event", handler);
    return () => ipcRenderer.removeListener("graphy:ai-chat-event", handler);
  },
  // アシスタント窓から 2D ビューアへの表示操作（アシスタント窓以外は main が forbidden）。
  assistantViewerCmd: (sessionId, cmd) => ipcRenderer.invoke("graphy:assistant-viewer-cmd", sessionId, cmd),
  // マクロの保存（アシスタント窓以外は main が forbidden）。
  assistantMacrosList: () => ipcRenderer.invoke("graphy:assistant-macros-list"),
  assistantMacrosSave: (macro) => ipcRenderer.invoke("graphy:assistant-macros-save", macro),
  assistantMacrosDelete: (id) => ipcRenderer.invoke("graphy:assistant-macros-delete", id),
  // 2D ビューア窓側: main が中継してきた命令を受け、結果を返す。受けた命令は 2D 窓が許可リストで再検証する。
  onViewerCmd: (cb) => {
    const handler = (_e, cmd) => cb(cmd);
    ipcRenderer.on("graphy:viewer-cmd", handler);
    return () => ipcRenderer.removeListener("graphy:viewer-cmd", handler);
  },
  viewerCmdResult: (reqId, result) => ipcRenderer.send("graphy:viewer-cmd-result", reqId, result),
  // ローカル AI（この PC の軽量 LLM）の導入・状態。ダウンロードと削除は main が確認ダイアログを出す。
  aiLocalStatus: () => ipcRenderer.invoke("graphy:ai-local-status"),
  aiLocalInstall: (modelId) => ipcRenderer.invoke("graphy:ai-local-install", { modelId }),
  aiLocalCancel: () => ipcRenderer.invoke("graphy:ai-local-cancel"),
  aiLocalImport: (allowUnverified) => ipcRenderer.invoke("graphy:ai-local-import", { allowUnverified: !!allowUnverified }),
  aiLocalCheck: (role) => ipcRenderer.invoke("graphy:ai-local-check", role),
  aiLocalRemoveStt: () => ipcRenderer.invoke("graphy:ai-local-remove-stt"),
  aiLocalRole: (role) => ipcRenderer.invoke("graphy:ai-local-role", role),
  aiLocalRemove: () => ipcRenderer.invoke("graphy:ai-local-remove"),
  onAiLocalEvent: (cb) => {
    const handler = (_e, ev) => cb(ev);
    ipcRenderer.on("graphy:ai-local-event", handler);
    return () => ipcRenderer.removeListener("graphy:ai-local-event", handler);
  },
  // 提供元の一覧と既定。鍵の値は返らない（有無だけ）。
  aiProvidersGet: () => ipcRenderer.invoke("graphy:ai-providers-get"),
  aiProvidersSet: (cfg) => ipcRenderer.invoke("graphy:ai-providers-set", cfg),
  // 既定の切り替えだけ。**この口からは新しい送信先が生えない**ので確認を出さない。
  aiDefaultsSet: (defaults) => ipcRenderer.invoke("graphy:ai-defaults-set", defaults),
  // 検査だけ（書かない）。検査規則をレンダラに二重化しないための口。
  aiProvidersValidate: (cfg) => ipcRenderer.invoke("graphy:ai-providers-validate", cfg),
  // 疎通確認。送る内容は main が決める（呼び出し側は提供元と用途だけ）。
  aiTestConnection: (providerId, capability) =>
    ipcRenderer.invoke("graphy:ai-test-connection", { providerId, capability }),
  // モデル名の一覧。保存済みなら providerId、追加フォームなら { kind, endpoint, apiKey }（公式ホストだけ通る）。
  aiListModels: (args) => ipcRenderer.invoke("graphy:ai-list-models", args),
  // 外部の計算機（Jupyter Server）。トークンの値は返らない（有無だけ）。fw/remote-compute-design.md
  computeEndpointsGet: () => ipcRenderer.invoke("graphy:compute-endpoints-get"),
  // 送信先が増える・変わる保存は main が確認ダイアログを出す
  computeEndpointsSet: (cfg) => ipcRenderer.invoke("graphy:compute-endpoints-set", cfg),
  computeEndpointsValidate: (cfg) => ipcRenderer.invoke("graphy:compute-endpoints-validate", cfg),
  // 接続テスト。渡せるのは id だけ（実行するコードは backend の定数）
  computeTestConnection: (id) => ipcRenderer.invoke("graphy:compute-test-connection", id),
  // 送る前の同意。渡せるのは要求の id だけ（見せる内容は main が backend から取り直し、main の窓で聞く）
  computeConfirm: (requestId) => ipcRenderer.invoke("graphy:compute-confirm", requestId),
  // 一括の計算の間、OS の眠りを止める（true/false）。返すのは「いま実際に止めているか」
  computeKeepAwake: (on) => ipcRenderer.invoke("graphy:compute-keep-awake", on),
  computeKeepAwakeStatus: () => ipcRenderer.invoke("graphy:compute-keep-awake-status"),
  // Colab（Google でログイン・ランタイムの確保と解放）。トークンは返らない
  computeColabStatus: () => ipcRenderer.invoke("graphy:compute-colab-status"),
  computeColabSignIn: () => ipcRenderer.invoke("graphy:compute-colab-signin"),
  computeColabSignOut: () => ipcRenderer.invoke("graphy:compute-colab-signout"),
  computeColabSpecs: () => ipcRenderer.invoke("graphy:compute-colab-specs"),
  computeColabEnsure: (id) => ipcRenderer.invoke("graphy:compute-colab-ensure", id),
  computeColabRelease: (id) => ipcRenderer.invoke("graphy:compute-colab-release", id),
  // この PC: 検出した Python で Jupyter Server を起動して計算機に入れる（データは送らない）
  computeLocalEnsure: () => ipcRenderer.invoke("graphy:compute-local-ensure"),
  // Drive バックアップ（Google でログイン・保存先を Picker で選ぶ・解除）。トークンは返らない
  gdriveStatus: () => ipcRenderer.invoke("graphy:gdrive-status"),
  gdriveSignIn: () => ipcRenderer.invoke("graphy:gdrive-signin"),
  gdriveSignOut: () => ipcRenderer.invoke("graphy:gdrive-signout"),
  gdriveEnable: (mode) => ipcRenderer.invoke("graphy:gdrive-enable", { mode }),
  gdriveSetCacheLimit: (bytes) => ipcRenderer.invoke("graphy:gdrive-set-cache-limit", { bytes }),
  gdriveDisable: () => ipcRenderer.invoke("graphy:gdrive-disable"),
  gdriveRestore: (title, mode) => ipcRenderer.invoke("graphy:gdrive-restore", { title, mode }),
  gdriveSetMode: (mode) => ipcRenderer.invoke("graphy:gdrive-set-mode", { mode }),
  // この PC の Python と GPU（見て出すだけ）。Python のパスを文字列で渡す口は無い——指定は main のファイル選択と確認を通る
  computeLocalDetect: (opts) => ipcRenderer.invoke("graphy:compute-local-detect", { force: !!(opts && opts.force) }),
  computeLocalCancel: () => ipcRenderer.invoke("graphy:compute-local-cancel"),
  computeLocalPickPython: () => ipcRenderer.invoke("graphy:compute-local-pick-python"),
  computeLocalUseAuto: () => ipcRenderer.invoke("graphy:compute-local-use-auto"),
  // 既定の計算機（未登録で Google にログイン済みなら Colab の T4 を足す。足すのは main）
  computeDefaultSet: (id) => ipcRenderer.invoke("graphy:compute-default-set", id ?? null),
  computeEnsureDefault: () => ipcRenderer.invoke("graphy:compute-ensure-default"),
  // 名前を付けて保存。上書き確認は OS のダイアログが出す。
  saveFile: (payload) => ipcRenderer.invoke("graphy:save-file", payload),
  // 開くダイアログ（プラグインの H43 file.pickFiles）。ファイルだけ。選んだ絶対パスを返す。
  pickFiles: (payload) => ipcRenderer.invoke("graphy:pick-files", payload),
  // H56: プラグインのフォルダ（選んだフォルダの中にだけ書ける）
  pluginPickDirectory: (payload) => ipcRenderer.invoke("graphy:plugin-pick-directory", payload),
  pluginWriteIntoDirectory: (payload) => ipcRenderer.invoke("graphy:plugin-write-into-directory", payload),
  pluginDownloadIntoDirectory: (payload) => ipcRenderer.invoke("graphy:plugin-download-into-directory", payload),
});
