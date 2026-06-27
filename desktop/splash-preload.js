// スプラッシュ用 preload: メインプロセスからの進捗イベントをレンダラへ橋渡しする。
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("graphySplash", {
  onProgress: (cb) => ipcRenderer.on("progress", (_e, data) => cb(data)),
});
