const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { resolveDevDataDir } = require("./devDataDir");

const CWD = path.resolve("/work/desktop");
const abs = path.resolve("/central/dev-data");
const exists = () => true;
const missing = () => false;

test("未設定なら従来どおり CWD", () => {
  assert.strictEqual(resolveDevDataDir({}, false, CWD, exists), CWD);
});

test("設定があればそのフォルダ（開発）", () => {
  assert.strictEqual(resolveDevDataDir({ GRAPHY_DEV_DATA_DIR: abs }, false, CWD, exists), abs);
});

test("パッケージ版では環境変数を無視する（インストール版のデータを動かさない）", () => {
  assert.strictEqual(resolveDevDataDir({ GRAPHY_DEV_DATA_DIR: abs }, true, CWD, exists), CWD);
  // 不正な値でも、パッケージ版は何も検査せず無視する
  assert.strictEqual(resolveDevDataDir({ GRAPHY_DEV_DATA_DIR: "relative;x" }, true, CWD, missing), CWD);
});

test("空・空白は拒否", () => {
  assert.throws(() => resolveDevDataDir({ GRAPHY_DEV_DATA_DIR: "" }, false, CWD, exists), /空/);
  assert.throws(() => resolveDevDataDir({ GRAPHY_DEV_DATA_DIR: "   " }, false, CWD, exists), /空/);
});

test("相対パスは拒否", () => {
  assert.throws(() => resolveDevDataDir({ GRAPHY_DEV_DATA_DIR: "data" }, false, CWD, exists), /絶対パス/);
});

test("; を含むパスは拒否", () => {
  assert.throws(() => resolveDevDataDir({ GRAPHY_DEV_DATA_DIR: path.resolve("/a;b") }, false, CWD, exists), /;/);
});

test("存在しないフォルダは作らずに拒否", () => {
  assert.throws(() => resolveDevDataDir({ GRAPHY_DEV_DATA_DIR: abs }, false, CWD, missing), /ありません/);
});

test("実ファイルシステム: 実在するフォルダは通り、ファイルは拒否", () => {
  const dir = require("node:fs").mkdtempSync(path.join(require("node:os").tmpdir(), "devdata-"));
  assert.strictEqual(resolveDevDataDir({ GRAPHY_DEV_DATA_DIR: dir }, false, CWD), dir);
  const f = path.join(dir, "f.txt");
  require("node:fs").writeFileSync(f, "x");
  assert.throws(() => resolveDevDataDir({ GRAPHY_DEV_DATA_DIR: f }, false, CWD), /ありません/);
  require("node:fs").rmSync(dir, { recursive: true, force: true });
});
