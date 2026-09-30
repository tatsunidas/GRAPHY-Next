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
  if (!missing.length) console.log(`OK: ${a}（${need.length} ファイル）`);
}
process.exit(failed ? 1 : 0);
