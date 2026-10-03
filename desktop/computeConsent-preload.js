// 同意画面（computeConsent.html）専用の preload。出せるのは「表示する内容を受け取る」と「決定を返す」だけ。
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("graphyConsent", {
  onShow: (cb) => {
    ipcRenderer.on("compute-consent:show", (_e, payload) => cb(payload));
    ipcRenderer.send("compute-consent:ready");
  },
  decide: (approve) => ipcRenderer.send("compute-consent:decide", approve === true),
});
