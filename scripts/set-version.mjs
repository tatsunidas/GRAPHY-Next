/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// バージョンを一括更新するスクリプト。
//   実行: npm run set-version 1.2.3
//
// 唯一のソースは backend/pom.xml の <version>。application.yml は '@project.version@'
// フィルタで pom に自動追従するため、ここでは触らない。
// このスクリプトは pom.xml と、pom を参照しない frontend/desktop/root の package.json を揃える。
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const v = process.argv[2];

if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(v ?? "")) {
  console.error("usage: npm run set-version <x.y.z[-suffix]>");
  console.error("  例: npm run set-version 1.2.3");
  process.exit(1);
}

/** package.json のトップレベル "version" だけを置換（既存の整形を保つ）。 */
function setJson(rel) {
  const f = resolve(root, rel);
  const src = readFileSync(f, "utf8");
  // 最初に現れる "version": "x" を対象（トップレベルの version はファイル先頭付近にある）。
  const re = /("version"\s*:\s*")[^"]*(")/;
  if (!re.test(src)) {
    console.error(`  ✗ ${rel} に "version" フィールドが見つかりませんでした`);
    process.exit(1);
  }
  writeFileSync(f, src.replace(re, `$1${v}$2`));
  console.log(`  ✓ ${rel} -> ${v}`);
}

/**
 * package-lock.json の「自分自身の版」だけを更新する。
 * 依存ツリーには触らないので `npm install` の再実行は不要。
 * version フィールドを持たない lock（依存の無いルート）は何もしない。
 */
function setLockVersion(rel) {
  const f = resolve(root, rel);
  let src;
  try {
    src = readFileSync(f, "utf8");
  } catch {
    console.log(`  - ${rel} は無いので飛ばします`);
    return;
  }
  const lock = JSON.parse(src);
  if (lock.version === undefined && lock.packages?.[""]?.version === undefined) {
    console.log(`  - ${rel} は版を持たないので飛ばします`);
    return;
  }
  if (lock.version !== undefined) lock.version = v;
  if (lock.packages?.[""]?.version !== undefined) lock.packages[""].version = v;
  writeFileSync(f, `${JSON.stringify(lock, null, 2)}\n`);
  console.log(`  ✓ ${rel} -> ${v}`);
}

// pom.xml は artifact 直下の <version> のみ置換（親 spring-boot の version は触らない）。
const pomPath = resolve(root, "backend/pom.xml");
const pom = readFileSync(pomPath, "utf8");
const pomRe = /(<artifactId>graphy-next-backend<\/artifactId>\s*<version>)[^<]+(<\/version>)/;
if (!pomRe.test(pom)) {
  console.error("  ✗ backend/pom.xml で artifact の <version> が見つかりませんでした（artifactId が変わっていませんか）");
  process.exit(1);
}
writeFileSync(pomPath, pom.replace(pomRe, `$1${v}$2`));
console.log(`  ✓ backend/pom.xml -> ${v}`);

setJson("package.json");
setJson("frontend/package.json");
setJson("desktop/package.json");

// package-lock.json も揃える。**放っておくと版が置いていかれる**
// （実際 desktop の lock は 0.1.8、frontend は 0.1.9 のまま取り残されていた）。
// 触るのは自分自身の版を表す 2 箇所（トップレベルと packages[""]）だけで、依存は変えない。
setLockVersion("frontend/package-lock.json");
setLockVersion("desktop/package-lock.json");

console.log(`\nバージョンを ${v} に更新しました。'npm run build' で全体に反映されます。`);
