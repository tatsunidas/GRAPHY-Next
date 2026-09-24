// `node --test`（desktop/ で `npm test`）。
//
// secretStore は Electron の safeStorage に依存するが、素の Node からは electron の API を
// 読めない（`require("electron")` が実行ファイルのパス文字列を返す）し、CI では
// **electron 自体が入っていない**。どちらでも成立するよう、モジュールの読み込みを横取りする。
//
// ここで守りたいのは 3 つ。いずれも破れると鍵が漏れる／黙って消える:
//   1. ディスク上で平文にならない・パーミッションが 0600
//   2. **OS のキーチェーンが使えないとき、平文保存に落ちない**（保存を断る）
//   3. 状態問い合わせの戻りに値そのものが混ざらない

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// ── electron スタブ（safeStorage の往復だけ真似る。暗号化は可逆な置換で代用） ──────
let encryptionAvailable = true;
const electronStub = {
  safeStorage: {
    isEncryptionAvailable: () => encryptionAvailable,
    encryptString: (s) => Buffer.from(`ENC:${s}`, "utf8"),
    decryptString: (b) => {
      const s = b.toString("utf8");
      if (!s.startsWith("ENC:")) throw new Error("復号できない");
      return s.slice(4);
    },
  },
};
// 🔴 **`require.resolve("electron")` を使わない。** CI の desktop ジョブは
//    「Electron 非依存の純関数だけを検査する」方針で **npm install をしない**ため、
//    electron が解決できず `Cannot find module 'electron'` でこのファイルごと落ちる
//    （2026-09-24 に実際に CI を赤くした。手元は node_modules があるので通っていた）。
//    モジュールの読み込みを横取りすれば、electron の有無に関係なく成立する。
const Module = require("node:module");
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "electron") return electronStub;
  return originalLoad.call(this, request, ...rest);
};
test.after(() => {
  Module._load = originalLoad;
});

const STORE_PATH = require.resolve("./secretStore");
const KEY = "ai.gemini.apiKey";

/** 毎回まっさらな secretStore を読み直す（＝アプリ再起動の代用）。 */
function freshStore(dir) {
  delete require.cache[STORE_PATH];
  const store = require("./secretStore");
  store.init(dir);
  return store;
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "graphy-secret-test-"));
}

test("保存していなければ未設定", () => {
  const store = freshStore(tmpDir());
  assert.strictEqual(store.statusOf(KEY).hasValue, false);
});

test("保存した値を取り出せる", () => {
  const store = freshStore(tmpDir());
  const r = store.setSecret(KEY, "SECRET-VALUE-123");
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.persisted, true);
  assert.strictEqual(store.getSecret(KEY), "SECRET-VALUE-123");
});

test("statusOf は状態だけを返し、値を含まない", () => {
  const store = freshStore(tmpDir());
  store.setSecret(KEY, "SECRET-VALUE-123");
  const status = store.statusOf(KEY);
  assert.deepStrictEqual(Object.keys(status).sort(), ["encryptionAvailable", "hasValue", "persisted"]);
  assert.ok(!JSON.stringify(status).includes("SECRET-VALUE"));
});

test("ディスク上で平文にならず、パーミッションは 0600", () => {
  const dir = tmpDir();
  const store = freshStore(dir);
  store.setSecret(KEY, "SECRET-VALUE-123");
  const file = path.join(dir, "secrets.enc.json");
  assert.ok(!fs.readFileSync(file, "utf8").includes("SECRET-VALUE-123"));
  // Windows では mode が意味を持たないので、そこでは検査しない（DPAPI がユーザー単位で守る）。
  if (process.platform !== "win32") {
    assert.strictEqual((fs.statSync(file).mode & 0o777).toString(8), "600");
  }
});

test("再起動しても読める", () => {
  const dir = tmpDir();
  freshStore(dir).setSecret(KEY, "SECRET-VALUE-123");
  assert.strictEqual(freshStore(dir).getSecret(KEY), "SECRET-VALUE-123");
});

test("🔴 OS のキーチェーンが使えないときは平文保存に落ちず、保存を断る", () => {
  const dir = tmpDir();
  encryptionAvailable = false;
  try {
    const store = freshStore(dir);
    const r = store.setSecret(KEY, "PLAINTEXT-MUST-NOT-LAND");
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.persisted, false, "永続化したと言ってはいけない");
    assert.strictEqual(r.reason, "no-os-keyring");
    assert.ok(!fs.existsSync(path.join(dir, "secrets.enc.json")), "ファイルを作ってはいけない");
    // この起動中は使える（入れ直しの手間を毎回かけさせない）。
    assert.strictEqual(store.getSecret(KEY), "PLAINTEXT-MUST-NOT-LAND");
  } finally {
    encryptionAvailable = true;
  }
});

test("allowlist 外のキー名は保存しない（平文 KVS への転用を防ぐ）", () => {
  const store = freshStore(tmpDir());
  const r = store.setSecret("some.other.key", "x");
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "unknown-key");
  assert.strictEqual(store.getSecret("some.other.key"), null);
});

test("空・長すぎる値は拒否する", () => {
  const store = freshStore(tmpDir());
  assert.strictEqual(store.setSecret(KEY, "").reason, "empty");
  assert.strictEqual(store.setSecret(KEY, "x".repeat(5000)).reason, "too-long");
});

test("消せる", () => {
  const dir = tmpDir();
  const store = freshStore(dir);
  store.setSecret(KEY, "SECRET-VALUE-123");
  assert.strictEqual(store.clearSecret(KEY), true);
  assert.strictEqual(store.statusOf(KEY).hasValue, false);
  assert.strictEqual(store.getSecret(KEY), null);
  assert.ok(!fs.readFileSync(path.join(dir, "secrets.enc.json"), "utf8").includes("SECRET-VALUE-123"));
});

test("復号できない暗号文は『鍵が無い』として扱う（別マシン・別ユーザーへ持ち込んだ場合）", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "secrets.enc.json"), JSON.stringify({ [KEY]: "bm90LWVuY3J5cHRlZA==" }));
  const store = freshStore(dir);
  assert.strictEqual(store.getSecret(KEY), null);
});

test("壊れたファイルでも起動を止めない", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "secrets.enc.json"), "{ this is not json");
  const store = freshStore(dir);
  assert.strictEqual(store.statusOf(KEY).hasValue, false);
});
