// 実行: cd automator && npx tsx --test src/smoke/updateE2eLogic.test.ts
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { assetNameFor, renderChecks, tally, tamperSignature, versionOfTag } from "./updateE2eLogic.js";

const require = createRequire(import.meta.url);
const { verifyDigest } = require("../../../desktop/minisign.js");
const { blake2b512 } = require("../../../desktop/blake2b.js");
const FX = path.resolve(import.meta.dirname, "../../../desktop/testdata/appupdate");

test("versionOfTag / assetNameFor", () => {
  assert.strictEqual(versionOfTag("v0.6.2"), "0.6.2");
  assert.strictEqual(versionOfTag("0.10.0"), "0.10.0");
  assert.throws(() => versionOfTag("latest"));
  assert.strictEqual(assetNameFor("win32", "0.6.2"), "GRAPHY-Next.Setup.0.6.2.exe");
  assert.strictEqual(assetNameFor("linux", "0.6.2"), "GRAPHY-Next-0.6.2.AppImage");
});

test("tamperSignature: 形式を保ったまま、製品の検証が bad-signature で拒否する（正例の署名は通る）", () => {
  const payload = fs.readFileSync(path.join(FX, "payload.bin"));
  const sig = fs.readFileSync(path.join(FX, "payload.bin.minisig"), "utf8");
  const pub = fs.readFileSync(path.join(FX, "test.pub"), "utf8");
  const digest = blake2b512(payload);
  assert.strictEqual(verifyDigest(digest, sig, [pub]).ok, true);
  const bad = tamperSignature(sig);
  assert.notStrictEqual(bad, sig);
  assert.strictEqual(bad.split("\n").length, sig.split("\n").length);
  assert.strictEqual(verifyDigest(digest, bad, [pub]).reason, "bad-signature");
  // 鍵 ID・アルゴリズム部分は変えていない（unknown-key・unsupported-algorithm にならない）
  assert.strictEqual(sig.split("\n")[1].slice(0, 14), bad.split("\n")[1].slice(0, 14));
});

test("tally / renderChecks: 合格・失敗・未達を分けて数える", () => {
  const cs = [{ label: "a", ok: true }, { label: "b", ok: false, detail: { x: 1 } }, { label: "c", ok: null }];
  assert.deepStrictEqual(tally(cs), { pass: 1, fail: 1, pending: 1 });
  const md = renderChecks(cs);
  assert.match(md, /\*\*失敗\*\*/);
  assert.match(md, /合格 1・失敗 1・未達 1/);
});
