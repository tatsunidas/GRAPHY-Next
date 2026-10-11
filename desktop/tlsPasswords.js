// DIMSE TLS のパスワード（キーストア・トラストストア）。OS のキーチェーン（secretStore）に預ける。
//
// TLS の受信（SCP）は backend の起動の途中でキーストアを開くので、main は backend を起動するときに
// 環境変数で渡す（envFor）。起動中に変えたときは main だけが通れる口でメモリに入れ直す。
// キーチェーンが使えない環境（キーリングの無い Linux など）は、TLS の受信を止めないために
// 従来どおり backend の設定に平文で保存する（画面で警告する）。
//
// electron を import しない（CI の Desktop ジョブは npm install しない）。依存は引数で受ける。

const KEYS = Object.freeze({
  keyStore: "dicom.tls.keyStorePassword",
  trustStore: "dicom.tls.trustStorePassword",
});
const FIELDS = Object.freeze({ keyStore: "keyStorePassword", trustStore: "trustStorePassword" });
const ENV = Object.freeze({ keyStore: "GRAPHY_TLS_KEY_STORE_PASSWORD", trustStore: "GRAPHY_TLS_TRUST_STORE_PASSWORD" });

/** backend を起動するときの環境変数（キーチェーンにあるものだけ）。 */
function envFor(getSecret) {
  const env = {};
  for (const w of Object.keys(KEYS)) {
    const v = getSecret(KEYS[w]);
    if (typeof v === "string" && v.length > 0) env[ENV[w]] = v;
  }
  return env;
}

/**
 * 画面から入力されたパスワードを保存する。value が空文字なら消す。
 * @returns {Promise<{ok: boolean, persisted?: "keychain"|"plaintext", reason?: string}>}
 */
async function setPassword({ which, value, encryptionAvailable, setSecret, clearSecret, call }) {
  if (!Object.prototype.hasOwnProperty.call(KEYS, which)) return { ok: false, reason: "bad-which" };
  if (typeof value !== "string" || value.length > 4096) return { ok: false, reason: "bad-value" };
  const field = FIELDS[which];
  if (encryptionAvailable) {
    if (value === "") {
      clearSecret(KEYS[which]);
    } else {
      const r = setSecret(KEYS[which], value);
      if (!r || !r.ok || !r.persisted) return { ok: false, reason: (r && r.reason) || "keychain-failed" };
    }
    const b = await call("PUT", "/api/internal/dicom/tls-secrets", { [field]: value });
    return b.ok ? { ok: true, persisted: "keychain" } : { ok: false, reason: b.error || `backend-${b.status}` };
  }
  const b = await call("PUT", "/api/internal/dicom/tls-secrets", { [field]: value, persistPlaintext: true });
  return b.ok ? { ok: true, persisted: "plaintext" } : { ok: false, reason: b.error || `backend-${b.status}` };
}

/**
 * 設定に平文で残っているパスワードをキーチェーンへ移す。キーチェーンに保存できたものだけを
 * backend へ渡し、すべて移せたときだけ平文を消す（途中で失敗してもパスワードを失わない）。
 * @returns {Promise<{moved: number, cleared: boolean, reason?: string}>}
 */
async function migrateLegacy({ encryptionAvailable, setSecret, call }) {
  if (!encryptionAvailable) return { moved: 0, cleared: false, reason: "no-keychain" };
  const got = await call("GET", "/api/internal/dicom/tls-legacy-secrets");
  if (!got.ok || !got.body) return { moved: 0, cleared: false, reason: got.error || `backend-${got.status}` };
  const found = Object.keys(KEYS).filter((w) => typeof got.body[FIELDS[w]] === "string" && got.body[FIELDS[w]]);
  if (found.length === 0) return { moved: 0, cleared: false };
  const mem = {};
  for (const w of found) {
    const r = setSecret(KEYS[w], got.body[FIELDS[w]]);
    if (!r || !r.ok || !r.persisted) return { moved: 0, cleared: false, reason: (r && r.reason) || "keychain-failed" };
    mem[FIELDS[w]] = got.body[FIELDS[w]];
  }
  const put = await call("PUT", "/api/internal/dicom/tls-secrets", mem);
  if (!put.ok) return { moved: found.length, cleared: false, reason: `backend-${put.status}` };
  const clr = await call("POST", "/api/internal/dicom/tls-legacy-secrets/clear");
  return { moved: found.length, cleared: !!clr.ok };
}

/** 画面に出す状態（値は返さない）。 */
function status({ statusOf, encryptionAvailable }) {
  return {
    encryptionAvailable: !!encryptionAvailable,
    keyStore: !!statusOf(KEYS.keyStore).hasValue,
    trustStore: !!statusOf(KEYS.trustStore).hasValue,
  };
}

module.exports = { KEYS, envFor, setPassword, migrateLegacy, status };
