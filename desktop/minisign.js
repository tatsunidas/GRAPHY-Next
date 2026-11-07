/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// minisign 署名の検証（Ed25519）。自動更新のインストーラ（.exe / .AppImage）の真正性の確認に使う。
// 鍵生成・署名は行わない（配布側＝リリースの CI の仕事）。backend の plugin/manager/Minisign.java と同じ形式を読む。
//
// 形式: 公開鍵 = base64("Ed" || keyId(8) || pk(32))。署名 .minisig =
//   untrusted comment / base64("ED" || keyId(8) || sig(64)) / trusted comment / base64(globalSig(64))。
//   "ED" は本体の BLAKE2b-512 に署名（prehashed。minisign 0.12 の既定）。global 署名は `sig || trusted comment`。
//
// 🚨 旧形式 "Ed"（本体そのものを署名）は**受け付けない**: Ed25519 は全体をメモリに載せる必要があり、
//    約 290 MB のインストーラには向かない。リリースの CI は既定（prehashed）で署名する。
// 🚨 trusted comment は署名で守られているので、リリース側が「版 + ファイル名」を入れ、アプリが突き合わせる
//    （正規に署名された**古い版**への差し替え＝ダウングレードを防ぐ）。expectTrusted に期待する文字列を渡す。
// 🚨 BLAKE2b は自前実装（blake2b.js。Electron の Node に blake2b512 が無いため）。

const crypto = require("node:crypto");
const path = require("node:path");
const { Worker } = require("node:worker_threads");

const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function lastNonCommentLine(text) {
  const lines = String(text).replace(/\r\n/g, "\n").split("\n").map((l) => l.trim()).filter(Boolean);
  const body = lines.filter((l) => !l.startsWith("untrusted comment:"));
  return body.length ? body[body.length - 1] : "";
}

function decodeBase64Strict(s, what) {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s)) throw new Error(`${what}: base64 ではありません`);
  return Buffer.from(s, "base64");
}

/** 鍵 ID の表示文字列（minisign CLI と同じくバイト逆順・大文字 hex）。blob は先頭 2 バイトが algo、続く 8 バイトが ID。 */
function keyIdOf(blob) {
  return Buffer.from(blob.subarray(2, 10)).reverse().toString("hex").toUpperCase();
}

/** 公開鍵（コメント行は任意）。壊れていれば Error。 */
function parseKey(text) {
  const blob = decodeBase64Strict(lastNonCommentLine(text), "公開鍵");
  if (blob.length !== 42) throw new Error(`公開鍵の長さが不正です: ${blob.length}`);
  const algo = blob.subarray(0, 2).toString("ascii");
  if (algo !== "Ed") throw new Error(`未対応の公開鍵アルゴリズム: ${algo}`);
  return { keyId: keyIdOf(blob), raw: Buffer.from(blob.subarray(10, 42)) };
}

/** .minisig をパースする。壊れていれば Error。 */
function parseSig(text) {
  let sigB64 = null, trusted = null, globalB64 = null;
  for (const raw of String(text).replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("untrusted comment:")) continue;
    if (line.startsWith("trusted comment:")) { trusted = line.slice("trusted comment:".length).trim(); continue; }
    if (sigB64 === null) sigB64 = line;
    else if (globalB64 === null) globalB64 = line;
  }
  if (sigB64 === null) throw new Error("署名行がありません");
  const blob = decodeBase64Strict(sigB64, "署名");
  if (blob.length !== 74) throw new Error(`署名の長さが不正です: ${blob.length}`);
  const algo = blob.subarray(0, 2).toString("ascii");
  if (algo !== "ED" && algo !== "Ed") throw new Error(`未対応の署名アルゴリズム: ${algo}`);
  const globalSignature = globalB64 === null ? null : decodeBase64Strict(globalB64, "global 署名");
  if (globalSignature && globalSignature.length !== 64) throw new Error(`global 署名の長さが不正です: ${globalSignature.length}`);
  return {
    keyId: keyIdOf(blob),
    prehashed: algo === "ED",
    signature: Buffer.from(blob.subarray(10, 74)),
    trustedComment: trusted === null ? "" : trusted,
    globalSignature,
  };
}

function ed25519Verify(rawPublicKey, message, signature) {
  try {
    const key = crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, rawPublicKey]), format: "der", type: "spki" });
    return crypto.verify(null, message, key, signature);
  } catch {
    return false; // 壊れた鍵・署名は「検証できなかった」＝不正扱い
  }
}

/**
 * 本体の BLAKE2b-512（digest）に対する署名を検証する。
 * @param {Buffer} digest 本体の BLAKE2b-512（64 バイト）
 * @param {string} sigText .minisig の中身
 * @param {string[]} trustedKeys 信頼する公開鍵（base64 行 or 公開鍵ファイルの中身）
 * @param {{expectTrusted?: string}} [opts] 署名の trusted comment が完全一致すべき文字列
 * @returns {{ok:true,keyId:string,trustedComment:string}|{ok:false,reason:string}}
 */
function verifyDigest(digest, sigText, trustedKeys, opts = {}) {
  let sig;
  try { sig = parseSig(sigText); } catch (e) { return { ok: false, reason: "bad-signature-format", detail: e.message }; }
  if (!sig.prehashed) return { ok: false, reason: "unsupported-algorithm" };
  if (!Buffer.isBuffer(digest) || digest.length !== 64) return { ok: false, reason: "bad-digest" };

  let key = null;
  for (const k of trustedKeys || []) {
    let parsed;
    try { parsed = parseKey(k); } catch { continue; } // 壊れた鍵は無視（他の鍵で照合を続ける）
    if (parsed.keyId === sig.keyId) { key = parsed; break; }
  }
  if (!key) return { ok: false, reason: "unknown-key" };

  if (!ed25519Verify(key.raw, digest, sig.signature)) return { ok: false, reason: "bad-signature" };
  if (!sig.globalSignature) return { ok: false, reason: "bad-trusted-comment" };
  const global = Buffer.concat([sig.signature, Buffer.from(sig.trustedComment, "utf8")]);
  if (!ed25519Verify(key.raw, global, sig.globalSignature)) return { ok: false, reason: "bad-trusted-comment" };
  if (opts.expectTrusted !== undefined && sig.trustedComment !== opts.expectTrusted) {
    return { ok: false, reason: "trusted-comment-mismatch", detail: sig.trustedComment };
  }
  return { ok: true, keyId: key.keyId, trustedComment: sig.trustedComment };
}

/** ファイルの BLAKE2b-512 を Worker スレッドで計算する（main を塞がない）。 */
function blake2bFile(file, onProgress) {
  return new Promise((resolve, reject) => {
    const w = new Worker(path.join(__dirname, "blake2bWorker.js"), { workerData: { file } });
    let settled = false;
    const done = (fn, v) => { if (!settled) { settled = true; fn(v); } };
    w.on("message", (m) => {
      if (m.progress !== undefined) { if (onProgress) onProgress(m.progress); return; }
      if (m.error) { done(reject, new Error(m.error)); return; }
      if (m.digest) { done(resolve, Buffer.from(m.digest, "hex")); w.terminate(); }
    });
    w.on("error", (e) => done(reject, e));
    w.on("exit", (code) => { if (code !== 0) done(reject, new Error(`worker exit ${code}`)); else done(reject, new Error("digest が返りませんでした")); });
  });
}

/** ファイルの署名を検証する（BLAKE2b は Worker で計算）。IO の失敗は reject、署名の不正は {ok:false}。 */
async function verifyFile(file, sigText, trustedKeys, opts = {}) {
  const digest = await blake2bFile(file, opts.onProgress);
  return verifyDigest(digest, sigText, trustedKeys, opts);
}

module.exports = { parseKey, parseSig, verifyDigest, verifyFile, blake2bFile, keyIdOf };
