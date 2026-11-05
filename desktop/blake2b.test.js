// BLAKE2b-512 の純 JS 実装を、通常の node の OpenSSL の `blake2b512`（正解）と突き合わせる。
// 製品（Electron）の Node には blake2b512 が無いので、実装が OpenSSL に頼っていないことも確かめる。
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const { createBlake2b512, blake2b512 } = require("./blake2b");

const hasOracle = crypto.getHashes().includes("blake2b512");
const oracle = (buf) => crypto.createHash("blake2b512").update(buf).digest();

test("RFC 7693 付録 A の既知ベクトル（'abc'）", () => {
  assert.strictEqual(
    blake2b512(Buffer.from("abc")).toString("hex"),
    "ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923",
  );
});

test("空入力の既知ベクトル", () => {
  assert.strictEqual(
    blake2b512(Buffer.alloc(0)).toString("hex"),
    "786a02f742015903c6c6fd852552d272912f4740e15847618a86e217f71f5419d25e1031afee585313896444934eb04b903a685b1448b755d56f701afe9be2ce",
  );
});

test("OpenSSL の blake2b512 と一致（ブロック境界の前後・大きなサイズ）", { skip: !hasOracle && "この node に blake2b512 が無い" }, () => {
  const sizes = [0, 1, 2, 63, 64, 127, 128, 129, 255, 256, 257, 1000, 4096, 100_003, 1_048_576 + 5];
  for (const n of sizes) {
    const b = crypto.randomBytes(n);
    assert.strictEqual(blake2b512(b).toString("hex"), oracle(b).toString("hex"), `size ${n}`);
  }
});

test("分割して update しても同じ（いろいろな刻み幅）", { skip: !hasOracle && "この node に blake2b512 が無い" }, () => {
  const b = crypto.randomBytes(50_000);
  const want = oracle(b).toString("hex");
  for (const step of [1, 7, 127, 128, 129, 300, 4096, 65_536]) {
    const h = createBlake2b512();
    for (let i = 0; i < b.length; i += step) h.update(b.subarray(i, i + step));
    assert.strictEqual(h.digest().toString("hex"), want, `step ${step}`);
  }
});

test("負例: 1 バイト違えば別のダイジェスト／digest 後の update は拒否", () => {
  const a = Buffer.from("hello world");
  const b = Buffer.from("hello worle");
  assert.notStrictEqual(blake2b512(a).toString("hex"), blake2b512(b).toString("hex"));
  const h = createBlake2b512().update(a);
  h.digest();
  assert.throws(() => h.update(a));
});

test("速度の記録（64 MB）。インストーラ 220〜290 MB で現実的な時間に収まる", () => {
  const b = crypto.randomBytes(1 << 20);
  const t0 = process.hrtime.bigint();
  const h = createBlake2b512();
  for (let i = 0; i < 64; i++) h.update(b);
  h.digest();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`  blake2b 64 MB: ${ms.toFixed(0)} ms（${((64 / ms) * 1000).toFixed(0)} MB/s）`);
  assert.ok(ms < 20_000, `遅すぎる: ${ms} ms`);
});
