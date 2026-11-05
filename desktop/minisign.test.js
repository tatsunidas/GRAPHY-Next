// minisign の検証。正例は本物の minisign 0.12 で使い捨て鍵で署名したフィクスチャ（testdata/appupdate）。
// 負例（改ざん・別鍵・旧形式・壊れた署名・trusted comment の差し替え・版違い）はすべて拒否されること。
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { parseKey, parseSig, verifyDigest, verifyFile } = require("./minisign");
const { blake2b512 } = require("./blake2b");

const FX = path.join(__dirname, "testdata", "appupdate");
const read = (n) => fs.readFileSync(path.join(FX, n));
const payload = read("payload.bin");
const sig = read("payload.bin.minisig").toString("utf8");
const testPub = read("test.pub").toString("utf8");
const otherPub = read("other.pub").toString("utf8");
const TC = "file:payload.bin synthetic-test";

test("公開鍵・署名のパース（鍵 ID は minisign CLI の表記）", () => {
  assert.strictEqual(parseKey(testPub).keyId, "63741BD20CE5887A");
  const s = parseSig(sig);
  assert.strictEqual(s.keyId, "63741BD20CE5887A");
  assert.strictEqual(s.prehashed, true);
  assert.strictEqual(s.trustedComment, TC);
});

test("正例: 実際の minisign の署名が通り、trusted comment が返る", () => {
  const r = verifyDigest(blake2b512(payload), sig, [testPub]);
  assert.deepStrictEqual(r, { ok: true, keyId: "63741BD20CE5887A", trustedComment: TC });
});

test("正例: 鍵は base64 行だけでも・複数の鍵のうち 1 つが合えば通る", () => {
  const line = testPub.trim().split("\n").pop();
  assert.strictEqual(verifyDigest(blake2b512(payload), sig, [otherPub, line]).ok, true);
});

test("正例: 期待する trusted comment と一致すれば通る", () => {
  assert.strictEqual(verifyDigest(blake2b512(payload), sig, [testPub], { expectTrusted: TC }).ok, true);
});

test("負例: 本体を 1 バイト改ざん → bad-signature", () => {
  const t = Buffer.from(payload); t[100] ^= 1;
  assert.deepStrictEqual(verifyDigest(blake2b512(t), sig, [testPub]), { ok: false, reason: "bad-signature" });
});

test("負例: 別の鍵しか信頼していない／鍵が空 → unknown-key", () => {
  assert.strictEqual(verifyDigest(blake2b512(payload), sig, [otherPub]).reason, "unknown-key");
  assert.strictEqual(verifyDigest(blake2b512(payload), sig, []).reason, "unknown-key");
  assert.strictEqual(verifyDigest(blake2b512(payload), sig, ["これは鍵ではない"]).reason, "unknown-key");
});

test("負例: 旧形式（Ed・本体そのものを署名）は受け付けない → unsupported-algorithm", () => {
  const legacy = read("payload.legacy.minisig").toString("utf8");
  assert.strictEqual(verifyDigest(blake2b512(payload), legacy, [testPub]).reason, "unsupported-algorithm");
});

test("負例: 壊れた署名（欠損・長さ違い・base64 でない・空）→ bad-signature-format", () => {
  for (const bad of ["", "untrusted comment: x\n", "untrusted comment: x\n!!!not-base64!!!\n", "untrusted comment: x\nRUR6iOUM0ht0\n"]) {
    assert.strictEqual(verifyDigest(blake2b512(payload), bad, [testPub]).reason, "bad-signature-format", JSON.stringify(bad));
  }
});

test("負例: 署名のバイトを 1 つ変える → bad-signature（鍵 ID は同じ）", () => {
  const lines = sig.split("\n");
  const blob = Buffer.from(lines[1], "base64");
  blob[20] ^= 1;
  lines[1] = blob.toString("base64");
  assert.strictEqual(verifyDigest(blake2b512(payload), lines.join("\n"), [testPub]).reason, "bad-signature");
});

test("負例: trusted comment の差し替え → bad-trusted-comment", () => {
  const swapped = sig.replace(TC, "file:payload.bin evil");
  assert.strictEqual(verifyDigest(blake2b512(payload), swapped, [testPub]).reason, "bad-trusted-comment");
});

test("負例: global 署名が無い → bad-trusted-comment", () => {
  const noGlobal = sig.split("\n").slice(0, 3).join("\n");
  assert.strictEqual(verifyDigest(blake2b512(payload), noGlobal, [testPub]).reason, "bad-trusted-comment");
});

test("負例（ダウングレード防止）: 正規の署名でも trusted comment が期待と違えば拒否 → trusted-comment-mismatch", () => {
  const r = verifyDigest(blake2b512(payload), sig, [testPub], { expectTrusted: "graphy-next v9.9.9 GRAPHY-Next.Setup.9.9.9.exe" });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "trusted-comment-mismatch");
});

test("負例: ダイジェストが 64 バイトでない → bad-digest", () => {
  assert.strictEqual(verifyDigest(Buffer.alloc(32), sig, [testPub]).reason, "bad-digest");
});

test("ファイルの検証（Worker で BLAKE2b）: 正例・改ざんの負例・存在しないファイル", async () => {
  const seen = [];
  const ok = await verifyFile(path.join(FX, "payload.bin"), sig, [testPub], { expectTrusted: TC, onProgress: (n) => seen.push(n) });
  assert.strictEqual(ok.ok, true);
  const tmp = path.join(require("node:os").tmpdir(), `minisign-test-${process.pid}.bin`);
  const t = Buffer.from(payload); t[4000] ^= 0x80;
  fs.writeFileSync(tmp, t);
  try {
    assert.strictEqual((await verifyFile(tmp, sig, [testPub])).reason, "bad-signature");
  } finally { fs.rmSync(tmp, { force: true }); }
  await assert.rejects(() => verifyFile(path.join(FX, "no-such-file.bin"), sig, [testPub]));
});

test("信頼鍵: update-trusted-keys.json は公式鍵 98EA7C6BA2D50118 だけで、backend の trusted-keys と一致する", () => {
  const keys = JSON.parse(fs.readFileSync(path.join(__dirname, "update-trusted-keys.json"), "utf8")).keys;
  assert.deepStrictEqual(keys.map((k) => parseKey(k).keyId), ["98EA7C6BA2D50118"]);
  const yml = fs.readFileSync(path.join(__dirname, "..", "backend", "src", "main", "resources", "application.yml"), "utf8");
  const m = yml.match(/trusted-keys:\s*\n(?:\s*#.*\n)*\s*-\s*"([^"]+)"/);
  assert.ok(m, "application.yml の trusted-keys が読めない");
  assert.strictEqual(keys[0], m[1], "desktop の信頼鍵が backend の公式鍵と食い違っている");
});
