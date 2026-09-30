// `node --test`。インストーラに入れるファイル（package.json の build.files）の検査。
//
// 実機で踏んだ不具合の再発防止: AI 機能で secretStore.js などを足したとき build.files に載せ忘れ、
// v0.3.0〜v0.3.2 のインストーラが起動直後に「Cannot find module './secretStore'」で落ちた
// （開発起動では desktop/ をそのまま読むので気付けなかった）。
// ここでは main.js・preload.js から相対 require をたどり、全部が build.files に載っていることを確かめる。

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const root = __dirname;
const files = require("./package.json").build.files;

/** electron-builder の files の書き方のうち、ここで使うもの（完全一致・`dir/**`・`dir/*.js`・`!` の除外）。 */
function included(rel) {
  const p = rel.split(path.sep).join("/");
  let hit = false;
  for (const f of files) {
    const neg = f.startsWith("!");
    const pat = neg ? f.slice(1) : f;
    const re = new RegExp(
      "^" +
        pat
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replace(/\*\*\//g, "(?:.*/)?")
          .replace(/\*\*/g, ".*")
          .replace(/\*/g, "[^/]*") +
        "$",
    );
    if (re.test(p)) hit = !neg;
  }
  return hit;
}

/** 相対 require を再帰的にたどる。 */
function localRequires(entry, seen = new Set()) {
  if (seen.has(entry)) return seen;
  seen.add(entry);
  const src = fs.readFileSync(path.join(root, entry), "utf8");
  for (const m of src.matchAll(/require\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g)) {
    let target = path.normalize(path.join(path.dirname(entry), m[1]));
    if (!fs.existsSync(path.join(root, target))) target += ".js";
    if (target.endsWith(".js")) localRequires(target, seen);
    else seen.add(target);
  }
  return seen;
}

test("main.js・preload.js から読む手元のファイルは全部インストーラに入る", () => {
  const needed = new Set();
  for (const entry of ["main.js", "preload.js", "splash-preload.js"]) {
    for (const f of localRequires(entry)) needed.add(f);
  }
  const missing = [...needed].filter((f) => !included(f));
  assert.deepStrictEqual(missing, [], `build.files に無い: ${missing.join(", ")}`);
});

test("テストのファイルはインストーラに入れない", () => {
  assert.strictEqual(included("aiAdapters/wire.test.js"), false);
  assert.strictEqual(included("secretStore.test.js"), false);
  assert.strictEqual(included("aiAdapters/wire.js"), true);
});
