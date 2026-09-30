// インストーラに入れるファイルの検査（テストとリリースの両方で使う）。
//
// 🚨 2026-09-30 の事故: AI 機能で足した secretStore.js などを package.json の build.files に載せ忘れ、
//    v0.3.0〜v0.3.2 のインストーラが起動直後に「Cannot find module './secretStore'」で落ちた。
//    開発起動は desktop/ をそのまま読むので、CI も開発版も緑のまま気付けなかった（fw/release-checklist.md）。
//
// - requiredFiles(): main.js・preload.js・splash-preload.js から相対 require を再帰的にたどった、手元のファイル
// - included(rel):   build.files（electron-builder の書き方のうち、ここで使う完全一致・`**`・`*`・`!`）に入るか

const fs = require("node:fs");
const path = require("node:path");

const root = __dirname;
const ENTRIES = ["main.js", "preload.js", "splash-preload.js"];

function buildFiles() {
  return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).build.files;
}

const toPosix = (p) => p.split(path.sep).join("/");

function included(rel, files = buildFiles()) {
  const p = toPosix(rel);
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

function walk(entry, seen) {
  if (seen.has(entry)) return;
  seen.add(entry);
  const src = fs.readFileSync(path.join(root, entry), "utf8");
  for (const m of src.matchAll(/require\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g)) {
    let target = path.normalize(path.join(path.dirname(entry), m[1]));
    if (!fs.existsSync(path.join(root, target))) target += ".js";
    if (target.endsWith(".js")) walk(target, seen);
    else seen.add(target);
  }
}

/** 起動に要る手元のファイル（posix の相対パス）。 */
function requiredFiles() {
  const seen = new Set();
  for (const e of ENTRIES) walk(e, seen);
  return [...seen].map(toPosix).sort();
}

module.exports = { requiredFiles, included, buildFiles };
