#!/usr/bin/env node
// できあがったインストーラの中身（app.asar）に、起動に要るファイルが全部入っているかを確かめる。
// リリースのワークフロー（.github/workflows/release.yml）が `npm run dist` の直後・公開の前に走らせる。
// 足りなければ exit 1＝そのリリースは公開されない。
//
// 🚨 2026-09-30: v0.3.0〜v0.3.2 は secretStore.js 等が入っておらず起動直後に落ちた（fw/release-checklist.md）。
//
// 使い方: node scripts/check-packaged.js [dist ディレクトリ（既定 desktop/dist）]

const fs = require("node:fs");
const path = require("node:path");
const asar = require("@electron/asar");
const { requiredFiles } = require("../packagedFiles");

const dist = path.resolve(process.argv[2] ?? path.join(__dirname, "..", "dist"));

function findAsars(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) findAsars(p, out);
    else if (e.name === "app.asar") out.push(p);
  }
  return out;
}

const asars = findAsars(dist);
if (asars.length === 0) {
  console.error(`::error::app.asar が見つかりません: ${dist}（electron-builder の出力を確かめてください）`);
  process.exit(1);
}
const need = requiredFiles();
let failed = false;
for (const a of asars) {
  const inside = new Set(asar.listPackage(a).map((f) => f.replace(/\\/g, "/").replace(/^\//, "")));
  const missing = need.filter((f) => !inside.has(f));
  const tests = [...inside].filter((f) => f.endsWith(".test.js"));
  if (missing.length) {
    failed = true;
    console.error(`::error::${a} に起動に要るファイルがありません: ${missing.join(", ")}`);
    console.error("  → desktop/package.json の build.files に足してください（fw/release-checklist.md）");
  }
  if (tests.length) console.warn(`::warning::${a} にテストのファイルが入っています: ${tests.join(", ")}`);
  // 🚨 画面の CSP（2026-09-30: media-src が無く、製品版だけ動画が真っ黒だった）
  const cspProblems = checkCsp(a, inside);
  if (cspProblems.length) {
    failed = true;
    for (const p of cspProblems) console.error(`::error::${a} の画面の CSP: ${p}（frontend/vite.config.ts）`);
  }
  if (!missing.length && !cspProblems.length) console.log(`OK: ${a}（${need.length} ファイル・画面の CSP）`);

}
process.exit(failed ? 1 : 0);

/** 製品版の画面（renderer/index.html）の CSP に、動いていないと困る許可があるか。 */
function checkCsp(asarPath, inside) {
  if (!inside.has("renderer/index.html")) return ["renderer/index.html がありません"];
  const html = asar.extractFile(asarPath, "renderer/index.html").toString("utf8");
  const m = html.match(/Content-Security-Policy"\s+content="([^"]+)"/);
  if (!m) return ["CSP がありません"];
  const dir = Object.fromEntries(m[1].split(";").map((d) => d.trim().split(/\s+/)).filter((x) => x[0]).map(([k, ...v]) => [k, v]));
  const need = {
    // 動画ビューア・プラグインの <video>（/rendered と blob:）
    "media-src": ["blob:", "http://127.0.0.1:*", "http://localhost:*"],
    // backend への接続・プラグインの ui.js の import()
    "connect-src": ["http://127.0.0.1:*", "http://localhost:*"],
    "script-src": ["http://127.0.0.1:*", "http://localhost:*"],
    "img-src": ["blob:", "data:"],
  };
  const problems = [];
  for (const [k, vals] of Object.entries(need)) {
    const have = dir[k];
    if (!have) problems.push(`${k} がありません（default-src 'self' にフォールバックして止まる）`);
    else for (const v of vals) if (!have.includes(v)) problems.push(`${k} に ${v} がありません`);
  }
  return problems;
}
