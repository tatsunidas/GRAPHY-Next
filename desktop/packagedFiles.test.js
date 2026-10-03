// `node --test`。インストーラに入れるファイル（package.json の build.files）の検査。
//
// 🚨 再発防止（2026-09-30）: AI 機能で secretStore.js などを足したとき build.files に載せ忘れ、
// v0.3.0〜v0.3.2 のインストーラが起動直後に「Cannot find module './secretStore'」で落ちた
// （開発起動では desktop/ をそのまま読むので気付けなかった）。fw/release-checklist.md。
// リリースではさらに、できたインストーラの app.asar を scripts/check-packaged.js で確かめる。

const test = require("node:test");
const assert = require("node:assert");
const { requiredFiles, included } = require("./packagedFiles");

test("main.js・preload.js から読む手元のファイルは全部インストーラに入る", () => {
  const missing = requiredFiles().filter((f) => !included(f));
  assert.deepStrictEqual(missing, [], `build.files に無い: ${missing.join(", ")}`);
});

test("たどれていること（secretStore と AI のアダプタまで）", () => {
  const req = requiredFiles();
  for (const f of ["main.js", "secretStore.js", "aiGateway.js", "aiAdapters/wire.js", "config.json"]) assert.ok(req.includes(f), f);
});

test("テストのファイルはインストーラに入れない", () => {
  assert.strictEqual(included("aiAdapters/wire.test.js"), false);
  assert.strictEqual(included("secretStore.test.js"), false);
  assert.strictEqual(included("aiAdapters/wire.js"), true);
});

test("require 以外で読むファイル（loadFile の html・preload・html の script）もたどる", () => {
  const req = requiredFiles();
  for (const f of ["splash.html", "splash-preload.js", "computeConsent.html", "computeConsent-preload.js",
                   "computeConsent-view.js"]) assert.ok(req.includes(f), f);
});
