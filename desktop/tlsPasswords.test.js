// `node --test`。DIMSE TLS のパスワードの扱い。
//
// 守りたいのは: キーチェーンに保存できなかったら平文を消さない（パスワードを失わない）、
// キーチェーンが無い環境では平文の経路に切り替える、起動時の環境変数にだけ値を載せる。
//
// 🔴 electron を import しない（CI の Desktop ジョブは npm install しない）。

const test = require("node:test");
const assert = require("node:assert");
const t = require("./tlsPasswords");

function fakeStore({ persist = true } = {}) {
  const m = new Map();
  return {
    m,
    setSecret: (k, v) => (persist ? (m.set(k, v), { ok: true, persisted: true }) : { ok: true, persisted: false, reason: "no-os-keyring" }),
    clearSecret: (k) => m.delete(k),
    getSecret: (k) => m.get(k) ?? null,
    statusOf: (k) => ({ hasValue: m.has(k) }),
  };
}

function fakeCall(responses = {}) {
  const calls = [];
  const fn = async (method, path, body) => {
    calls.push([method, path, body]);
    return responses[`${method} ${path}`] ?? { ok: true, status: 200, body: {} };
  };
  fn.calls = calls;
  return fn;
}

test("起動時の環境変数: キーチェーンにあるものだけ", () => {
  const s = fakeStore();
  s.setSecret(t.KEYS.keyStore, "ks");
  assert.deepEqual(t.envFor(s.getSecret), { GRAPHY_TLS_KEY_STORE_PASSWORD: "ks" });
});

test("保存: キーチェーンに入れてから backend のメモリへ（平文の保存はしない）", async () => {
  const s = fakeStore();
  const call = fakeCall();
  const r = await t.setPassword({ which: "trustStore", value: "pw", encryptionAvailable: true, ...s, call });
  assert.deepEqual(r, { ok: true, persisted: "keychain" });
  assert.equal(s.m.get(t.KEYS.trustStore), "pw");
  assert.deepEqual(call.calls, [["PUT", "/api/internal/dicom/tls-secrets", { trustStorePassword: "pw" }]]);
  assert.deepEqual(await t.setPassword({ which: "other", value: "x", encryptionAvailable: true, ...s, call }),
    { ok: false, reason: "bad-which" });
});

test("キーチェーンが無い環境: 設定に平文で保存する経路に切り替える", async () => {
  const s = fakeStore({ persist: false });
  const call = fakeCall();
  const r = await t.setPassword({ which: "keyStore", value: "pw", encryptionAvailable: false, ...s, call });
  assert.deepEqual(r, { ok: true, persisted: "plaintext" });
  assert.equal(s.m.size, 0);
  assert.deepEqual(call.calls[0][2], { keyStorePassword: "pw", persistPlaintext: true });
});

test("移行: 全部キーチェーンに入ってから平文を消す。入らなければ消さない", async () => {
  const legacy = { "GET /api/internal/dicom/tls-legacy-secrets": { ok: true, status: 200, body: { keyStorePassword: "a", trustStorePassword: "b" } } };
  const s = fakeStore();
  const call = fakeCall(legacy);
  assert.deepEqual(await t.migrateLegacy({ encryptionAvailable: true, setSecret: s.setSecret, call }), { moved: 2, cleared: true });
  assert.deepEqual(call.calls.map((c) => c.slice(0, 2).join(" ")), [
    "GET /api/internal/dicom/tls-legacy-secrets",
    "PUT /api/internal/dicom/tls-secrets",
    "POST /api/internal/dicom/tls-legacy-secrets/clear",
  ]);

  const failing = fakeStore({ persist: false });
  const call2 = fakeCall(legacy);
  const r2 = await t.migrateLegacy({ encryptionAvailable: true, setSecret: failing.setSecret, call: call2 });
  assert.equal(r2.cleared, false);
  assert.ok(!call2.calls.some((c) => c[1].endsWith("/clear")), "保存できなかったら平文を消さない");

  const call3 = fakeCall(legacy);
  assert.equal((await t.migrateLegacy({ encryptionAvailable: false, setSecret: s.setSecret, call: call3 })).reason, "no-keychain");
  assert.equal(call3.calls.length, 0);
});
