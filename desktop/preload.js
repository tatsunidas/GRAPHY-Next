// Electron preload: レンダラ(React)が backend を叩けるよう、API ベース URL を注入する。
// file:// で読み込まれるため相対パスでは backend に届かないので、絶対 URL を渡す。
// ポートは config.json（環境変数 GRAPHY_BACKEND_PORT で上書き可）から解決する。
const { contextBridge } = require("electron");
const cfg = require("./config.json");

const PORT = process.env.GRAPHY_BACKEND_PORT || String(cfg.backend.port);

contextBridge.exposeInMainWorld("__GRAPHY_API_BASE__", `http://localhost:${PORT}`);
