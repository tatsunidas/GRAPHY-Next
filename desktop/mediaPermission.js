// マイク・カメラ（`media` 権限）を、どの窓に許すかの判定。
//
// 🔴 **なぜ要るのか。** Electron は許可ハンドラが無いと全権限を黙って許可する。音声入力で
//    マイクを使い始めると、プラグイン（viewer / main 窓の同じ realm で動く）も同じ許可で
//    マイクを開けてしまう。録音できるのは**アシスタント窓のメインフレームだけ**、かつ**音声だけ**にする。
// 🔑 `media` 以外の権限は従来どおり（許可）。ここで挙動を変えるのはマイク・カメラだけ。
//
// 🔴 `electron` を import しない（`node --test` が npm install 無しで走る）。

const { isAssistantUrl } = require("./assistantSender");

/**
 * 許可要求（setPermissionRequestHandler）。
 *
 * @param {{permission: string, mediaTypes?: string[], pageUrl: string, isMainFrame?: boolean}} a
 *   `pageUrl` は要求元の窓のメインフレームの URL（`webContents.getURL()`）
 */
function allowRequest({ permission, mediaTypes, pageUrl, isMainFrame }) {
  if (permission !== "media") return true;
  const audioOnly = Array.isArray(mediaTypes) && mediaTypes.length === 1 && mediaTypes[0] === "audio";
  return audioOnly && isMainFrame !== false && isAssistantUrl(pageUrl);
}

/**
 * 許可の確認（setPermissionCheckHandler）。`enumerateDevices` のラベル取得などで呼ばれる。
 * `mediaType` は "audio" | "video" | "unknown"。映像は常に拒否。
 */
function allowCheck({ permission, mediaType, pageUrl }) {
  if (permission !== "media") return true;
  return (mediaType === "audio" || mediaType === "unknown") && isAssistantUrl(pageUrl);
}

/** session に結線する。webContents が null のとき（確認ハンドラで起こりうる）は拒否側に倒す。 */
function install(session) {
  session.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(allowRequest({
      permission,
      mediaTypes: details && details.mediaTypes,
      pageUrl: webContents ? webContents.getURL() : "",
      isMainFrame: details ? details.isMainFrame : undefined,
    }));
  });
  session.setPermissionCheckHandler((webContents, permission, _origin, details) =>
    allowCheck({ permission, mediaType: details && details.mediaType, pageUrl: webContents ? webContents.getURL() : "" }));
}

module.exports = { allowRequest, allowCheck, install };
