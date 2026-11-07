/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// BLAKE2b-512（RFC 7693）の純 JS 実装。ストリーミング（大きなインストーラを 1 回の読み取りで）。
//
// 🚨 Node 標準の `crypto.createHash("blake2b512")` を使わない理由: Electron 同梱の Node は BoringSSL で、
//    `blake2b512` が**無い**（`Digest method not supported`。通常の node には有る）。通常の node で書いたテストだけだと
//    通ってしまい、製品（Electron）でだけ落ちる。minisign の prehash（"ED"）はこれを使うので自前で持つ。
//    テストは通常の node の `blake2b512` を正解として突き合わせる（blake2b.test.js）。
//
// 64 ビット整数は JS の number では足りないので、32 ビットの下位・上位の対（Uint32Array）で持つ。

const IV = [
  0xf3bcc908, 0x6a09e667, 0x84caa73b, 0xbb67ae85, 0xfe94f82b, 0x3c6ef372, 0x5f1d36f1, 0xa54ff53a,
  0xade682d1, 0x510e527f, 0x2b3e6c1f, 0x9b05688c, 0xfb41bd6b, 0x1f83d9ab, 0x137e2179, 0x5be0cd19,
]; // [lo0, hi0, lo1, hi1, ...]

const SIGMA = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
];

const BLOCK = 128;
const OUT_LEN = 64;

class Blake2b512 {
  constructor() {
    this.h = new Uint32Array(IV);
    this.h[0] ^= 0x01010000 ^ OUT_LEN; // パラメータブロック: 鍵なし・出力 64 バイト・fanout=1・depth=1
    this.buf = Buffer.alloc(BLOCK);
    this.fill = 0; // buf に溜まっているバイト数
    this.t = 0; // 処理済みバイト数（2^53 まで。インストーラには十分）
    this.v = new Uint32Array(32);
    this.m = new Uint32Array(32);
    this.done = false;
  }

  update(chunk) {
    if (this.done) throw new Error("blake2b: digest 済みです");
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let off = 0;
    // 最後のブロックは digest まで保留する（満杯でも、後続が来るまで圧縮しない）。
    while (off < data.length) {
      if (this.fill === BLOCK) {
        this.t += BLOCK;
        this._compress(this.buf, 0, false);
        this.fill = 0;
      }
      if (this.fill === 0 && data.length - off > BLOCK) {
        // 満杯のブロックを直接処理（コピーしない）。直後にまだデータが続くので最後のブロックではない
        this.t += BLOCK;
        this._compress(data, off, false);
        off += BLOCK;
        continue;
      }
      const n = Math.min(BLOCK - this.fill, data.length - off);
      data.copy(this.buf, this.fill, off, off + n);
      this.fill += n;
      off += n;
    }
    return this;
  }

  /** 64 バイトのダイジェスト（Buffer）。 */
  digest() {
    if (this.done) throw new Error("blake2b: digest 済みです");
    this.done = true;
    this.t += this.fill;
    this.buf.fill(0, this.fill);
    this._compress(this.buf, 0, true);
    const out = Buffer.alloc(OUT_LEN);
    for (let i = 0; i < 16; i++) out.writeUInt32LE(this.h[i], i * 4);
    return out;
  }

  _compress(src, off, last) {
    const v = this.v;
    const m = this.m;
    const h = this.h;
    for (let i = 0; i < 32; i++) m[i] = src.readUInt32LE(off + i * 4);
    for (let i = 0; i < 16; i++) { v[i] = h[i]; v[16 + i] = IV[i]; }
    // カウンタ t（下位 64 ビット）: 2^32 を超える分は上位へ
    v[24] ^= this.t >>> 0;
    v[25] ^= Math.floor(this.t / 4294967296) >>> 0;
    if (last) { v[28] = ~v[28]; v[29] = ~v[29]; }

    for (let r = 0; r < 12; r++) {
      const s = SIGMA[r];
      G(v, 0, 4, 8, 12, m, s[0], s[1]);
      G(v, 1, 5, 9, 13, m, s[2], s[3]);
      G(v, 2, 6, 10, 14, m, s[4], s[5]);
      G(v, 3, 7, 11, 15, m, s[6], s[7]);
      G(v, 0, 5, 10, 15, m, s[8], s[9]);
      G(v, 1, 6, 11, 12, m, s[10], s[11]);
      G(v, 2, 7, 8, 13, m, s[12], s[13]);
      G(v, 3, 4, 9, 14, m, s[14], s[15]);
    }
    for (let i = 0; i < 16; i++) h[i] ^= v[i] ^ v[16 + i];
  }
}

/** 64 ビットの a += b + x（下位・上位の対）。 */
function G(v, a, b, c, d, m, ix, iy) {
  const A = a * 2, B = b * 2, C = c * 2, D = d * 2;
  let lo, hi, t;

  // a = a + b + m[x]
  lo = v[A] + v[B]; hi = v[A + 1] + v[B + 1] + (lo > 0xffffffff ? 1 : 0);
  lo = (lo >>> 0) + m[ix * 2]; hi = hi + m[ix * 2 + 1] + (lo > 0xffffffff ? 1 : 0);
  v[A] = lo >>> 0; v[A + 1] = hi >>> 0;
  // d = rotr64(d ^ a, 32)
  lo = v[D] ^ v[A]; hi = v[D + 1] ^ v[A + 1];
  v[D] = hi; v[D + 1] = lo;
  // c = c + d
  lo = v[C] + v[D]; hi = v[C + 1] + v[D + 1] + (lo > 0xffffffff ? 1 : 0);
  v[C] = lo >>> 0; v[C + 1] = hi >>> 0;
  // b = rotr64(b ^ c, 24)
  lo = v[B] ^ v[C]; hi = v[B + 1] ^ v[C + 1];
  v[B] = ((lo >>> 24) | (hi << 8)) >>> 0; v[B + 1] = ((hi >>> 24) | (lo << 8)) >>> 0;

  // a = a + b + m[y]
  lo = v[A] + v[B]; hi = v[A + 1] + v[B + 1] + (lo > 0xffffffff ? 1 : 0);
  lo = (lo >>> 0) + m[iy * 2]; hi = hi + m[iy * 2 + 1] + (lo > 0xffffffff ? 1 : 0);
  v[A] = lo >>> 0; v[A + 1] = hi >>> 0;
  // d = rotr64(d ^ a, 16)
  lo = v[D] ^ v[A]; hi = v[D + 1] ^ v[A + 1];
  v[D] = ((lo >>> 16) | (hi << 16)) >>> 0; v[D + 1] = ((hi >>> 16) | (lo << 16)) >>> 0;
  // c = c + d
  lo = v[C] + v[D]; hi = v[C + 1] + v[D + 1] + (lo > 0xffffffff ? 1 : 0);
  v[C] = lo >>> 0; v[C + 1] = hi >>> 0;
  // b = rotr64(b ^ c, 63) = rotl64(b ^ c, 1)
  lo = v[B] ^ v[C]; hi = v[B + 1] ^ v[C + 1];
  t = lo;
  v[B] = ((lo << 1) | (hi >>> 31)) >>> 0; v[B + 1] = ((hi << 1) | (t >>> 31)) >>> 0;
}

function createBlake2b512() {
  return new Blake2b512();
}

/** まとめて 1 回で（テスト・小さなデータ用）。 */
function blake2b512(data) {
  return new Blake2b512().update(data).digest();
}

module.exports = { createBlake2b512, blake2b512 };
