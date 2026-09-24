// API キー等の秘密情報を OS のキーチェーンで保護して保存する。
//
// なぜ backend(H2) ではなくここに置くのか:
//   設定は SettingsService 経由で H2 の平文行として保存され、`GET /api/settings` が
//   全件を丸ごと返す。そこへ API キーを置くと、レンダラ・プラグイン・DB バックアップ・
//   ログの全経路から平文で読めてしまう。OS のキーチェーン（Windows=DPAPI /
//   macOS=Keychain / Linux=libsecret|kwallet）に触れるのは Electron main だけなので、
//   秘密情報の置き場は必然的にここになる。
//
// 設計上の約束:
//   - 復号値をレンダラへ返す IPC は作らない。平文が main プロセスの外へ出る経路を
//     最初から存在させない（使うのは同じ main 内の aiGateway だけ）。
//   - 暗号化が使えない環境では「平文で保存」に黙って落ちない。保存を断り、
//     セッション内のメモリ保持だけにして、その事実を呼び出し側へ返す。
//   - 保存できるキー名は allowlist で固定する。レンダラから任意の名前で
//     書き込めると、ここが素朴な平文 KVS として濫用される。

const { safeStorage } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

/** 保存を許すキー名。増やすときはここに明示的に足す。 */
const ALLOWED_KEYS = new Set(["ai.gemini.apiKey"]);

/** `{ "<key>": "<base64 の暗号文>" }` を収めたファイル。dataDir 直下に置く。 */
const FILE_NAME = "secrets.enc.json";

let filePath = null;
/** ディスク上の暗号文（base64）。読み込み済みなら Map、未読なら null。 */
let stored = null;
/** 暗号化が使えない環境のための、プロセスが生きている間だけの退避先。 */
const session = new Map();

/**
 * 保存先を決める。main.js の resolveDataDir()（backend の CWD と同じ場所）を渡すこと。
 * H2 や DICOM 保管庫と同じディレクトリに置くことで、ユーザーデータの所在が 1 箇所にまとまる。
 */
function init(dataDir) {
  filePath = path.join(dataDir, FILE_NAME);
  stored = null;
}

function encryptionAvailable() {
  try {
    return safeStorage.isEncryptionAvailable() === true;
  } catch {
    // Linux でキーリングのデーモンが居ないと例外になることがある。使えない扱いにする。
    return false;
  }
}

function load() {
  if (stored) return stored;
  stored = new Map();
  if (!filePath) return stored;
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const obj = JSON.parse(raw);
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === "string") stored.set(k, v);
    }
  } catch (e) {
    // 未作成なら普通のこと。壊れている場合も「鍵が無い」として続行する（起動は止めない）。
    if (e && e.code !== "ENOENT") console.error("[secret] 読み込みに失敗:", e.message);
  }
  return stored;
}

function persist() {
  if (!filePath) return false;
  const obj = Object.fromEntries(load());
  const json = JSON.stringify(obj, null, 2);
  try {
    // mode は新規作成時にしか効かないので、既存ファイルには chmod を明示的に掛ける。
    // （Windows では両方とも無視されるが、その環境では DPAPI がユーザー単位で守る）
    fs.writeFileSync(filePath, json, { mode: 0o600 });
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      /* Windows 等。暗号化済みなのでここは致命的ではない */
    }
    return true;
  } catch (e) {
    console.error("[secret] 保存に失敗:", e.message);
    return false;
  }
}

/**
 * 秘密情報を保存する。
 * @returns {{ok: boolean, persisted: boolean, encryptionAvailable: boolean, reason?: string}}
 *   persisted=false は「この起動中しか保持できていない」ことを意味する。UI はこれを隠さず伝える。
 */
function setSecret(key, value) {
  if (!ALLOWED_KEYS.has(key)) return { ok: false, persisted: false, encryptionAvailable: encryptionAvailable(), reason: "unknown-key" };
  if (typeof value !== "string" || value.length === 0) return { ok: false, persisted: false, encryptionAvailable: encryptionAvailable(), reason: "empty" };
  if (value.length > 4096) return { ok: false, persisted: false, encryptionAvailable: encryptionAvailable(), reason: "too-long" };

  const available = encryptionAvailable();
  if (!available) {
    // 平文でディスクに書くくらいなら保存しない。次回起動時は入れ直してもらう。
    session.set(key, value);
    return { ok: true, persisted: false, encryptionAvailable: false, reason: "no-os-keyring" };
  }
  try {
    const cipher = safeStorage.encryptString(value);
    load().set(key, cipher.toString("base64"));
    session.delete(key);
    const persisted = persist();
    return { ok: true, persisted, encryptionAvailable: true, reason: persisted ? undefined : "write-failed" };
  } catch (e) {
    console.error("[secret] 暗号化に失敗:", e.message);
    session.set(key, value);
    return { ok: true, persisted: false, encryptionAvailable: true, reason: "encrypt-failed" };
  }
}

/**
 * 平文を取り出す。**main プロセス内からのみ呼ぶこと。IPC で公開してはいけない。**
 */
function getSecret(key) {
  if (!ALLOWED_KEYS.has(key)) return null;
  if (session.has(key)) return session.get(key);
  const cipher = load().get(key);
  if (!cipher) return null;
  try {
    return safeStorage.decryptString(Buffer.from(cipher, "base64"));
  } catch (e) {
    // OS ユーザーやマシンが変わると復号できない。鍵が無いのと同じ扱いにして入れ直させる。
    console.error("[secret] 復号に失敗（入れ直しが必要）:", e.message);
    return null;
  }
}

/** UI へ返してよい状態だけを返す。値そのものは絶対に含めない。 */
function statusOf(key) {
  if (!ALLOWED_KEYS.has(key)) return { hasValue: false, persisted: false, encryptionAvailable: encryptionAvailable() };
  const inSession = session.has(key);
  const onDisk = load().has(key);
  return { hasValue: inSession || onDisk, persisted: onDisk, encryptionAvailable: encryptionAvailable() };
}

function clearSecret(key) {
  if (!ALLOWED_KEYS.has(key)) return false;
  session.delete(key);
  const had = load().delete(key);
  if (had) persist();
  return true;
}

module.exports = { init, setSecret, getSecret, statusOf, clearSecret, encryptionAvailable, ALLOWED_KEYS };
