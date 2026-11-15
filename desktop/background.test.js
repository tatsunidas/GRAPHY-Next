// `node --test`。常駐の設定の読み書きと、判定の純関数。
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  HIDDEN_ARG,
  createBackgroundPrefs,
  shouldHideOnClose,
  shouldQuitWhenAllClosed,
  startsHidden,
  loginItemSettings,
} = require("./background");

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "graphy-bg-")), "background.json");
}

test("保存が無ければ既定（どちらもオフ）", () => {
  const p = createBackgroundPrefs({ file: tmpFile() });
  assert.deepStrictEqual(p.get(), { keepInTray: false, launchAtLogin: false });
  assert.strictEqual(p.readError(), null);
});

test("書いた値を読み戻せる。片方だけの更新で、もう片方は変わらない", () => {
  const file = tmpFile();
  const p = createBackgroundPrefs({ file });
  p.set({ keepInTray: true });
  assert.deepStrictEqual(createBackgroundPrefs({ file }).get(), { keepInTray: true, launchAtLogin: false });
  p.set({ launchAtLogin: true });
  assert.deepStrictEqual(createBackgroundPrefs({ file }).get(), { keepInTray: true, launchAtLogin: true });
  assert.ok(!fs.existsSync(`${file}.tmp`), "一時ファイルが残らない");
});

test("負例: 壊れた保存値は既定（常駐しない）に戻し、理由を返す", () => {
  const file = tmpFile();
  fs.writeFileSync(file, "{not json");
  const p = createBackgroundPrefs({ file });
  assert.deepStrictEqual(p.get(), { keepInTray: false, launchAtLogin: false });
  assert.strictEqual(p.readError(), "corrupt");
  fs.writeFileSync(file, JSON.stringify({ keepInTray: "yes" }));
  assert.strictEqual(p.readError(), "corrupt");
});

test("負例: 未知のキーや真偽値でない値は書かない", () => {
  const file = tmpFile();
  const p = createBackgroundPrefs({ file });
  assert.throws(() => p.set({ keepInTray: "true" }), TypeError);
  assert.throws(() => p.set({ other: true }), TypeError);
  assert.throws(() => p.set(null), TypeError);
  assert.ok(!fs.existsSync(file), "不正な要求では何も書かない");
});

test("閉じる: 常駐オンなら隠す。終了の最中は隠さない", () => {
  assert.strictEqual(shouldHideOnClose({ keepInTray: true, quitting: false }), true);
  assert.strictEqual(shouldHideOnClose({ keepInTray: true, quitting: true }), false);
  assert.strictEqual(shouldHideOnClose({ keepInTray: false, quitting: false }), false);
  assert.strictEqual(shouldHideOnClose({ keepInTray: undefined, quitting: false }), false);
});

test("すべての窓が閉じたとき: 常駐中は終えない。オフなら従来どおり（macOS 以外は終える）", () => {
  assert.strictEqual(shouldQuitWhenAllClosed({ keepInTray: true, platform: "win32" }), false);
  assert.strictEqual(shouldQuitWhenAllClosed({ keepInTray: false, platform: "win32" }), true);
  assert.strictEqual(shouldQuitWhenAllClosed({ keepInTray: false, platform: "linux" }), true);
  assert.strictEqual(shouldQuitWhenAllClosed({ keepInTray: false, platform: "darwin" }), false);
});

test("起動時に窓を出さないのは、常駐オンで --hidden のときだけ", () => {
  assert.strictEqual(startsHidden({ argv: ["app.exe", HIDDEN_ARG], keepInTray: true }), true);
  assert.strictEqual(startsHidden({ argv: ["app.exe", HIDDEN_ARG], keepInTray: false }), false); // 戻れなくなる
  assert.strictEqual(startsHidden({ argv: ["app.exe"], keepInTray: true }), false);
  assert.strictEqual(startsHidden({ argv: undefined, keepInTray: true }), false);
});

test("ログイン時の起動: オフなら登録しない。オンでも常駐がオフなら窓を出して起動する", () => {
  assert.deepStrictEqual(loginItemSettings({ launchAtLogin: false, keepInTray: true }), { openAtLogin: false, args: [] });
  assert.deepStrictEqual(loginItemSettings({ launchAtLogin: true, keepInTray: true }), { openAtLogin: true, args: [HIDDEN_ARG] });
  assert.deepStrictEqual(loginItemSettings({ launchAtLogin: true, keepInTray: false }), { openAtLogin: true, args: [] });
});
