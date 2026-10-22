// ローカル AI の実行ファイル（llama.cpp の配布 zip / tar.gz）を展開する。設計: fw/ai-routing-design.md §18
//
// 🔴 外部コマンド（tar・unzip・PowerShell）を呼ばず、Node 標準（zlib）だけで展開する。
//    理由: ① 展開前に全エントリのパスを自分で検査できる（zip-slip）、② OS ごとの tar の違いに依存しない。
// 🔴 展開先の外へ出るパス（絶対パス・`..`・ドライブ名）は 1 件でもあれば何も書かずに失敗する。
// 🔴 シンボリックリンクは「展開先の中の相対パスを指すもの」だけ作る。それ以外は無視する（書かない）。
// 🔴 electron を import しない（CI の Desktop ジョブは npm install しない）。

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

/** 展開後の合計の上限。llama.cpp の CPU 版は数十 MB。想定の十数倍で止める（zip 爆弾の対策）。 */
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
const MAX_ENTRIES = 5000;

/** エントリ名が展開先の中に収まるか。収まらなければ null。 */
function safeJoin(destDir, name) {
  if (typeof name !== "string" || name === "" || name.includes("\0")) return null;
  const norm = name.replace(/\\/g, "/");
  if (norm.startsWith("/") || /^[A-Za-z]:/.test(norm)) return null;
  if (norm.split("/").includes("..")) return null;
  const full = path.resolve(destDir, norm);
  const root = path.resolve(destDir);
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  return full;
}

/** リンク先が展開先の中の相対パスか。 */
function safeLinkTarget(destDir, linkFull, target) {
  if (typeof target !== "string" || target === "" || target.includes("\0")) return false;
  const t = target.replace(/\\/g, "/");
  if (t.startsWith("/") || /^[A-Za-z]:/.test(t)) return false;
  const resolved = path.resolve(path.dirname(linkFull), t);
  const root = path.resolve(destDir);
  return resolved === root || resolved.startsWith(root + path.sep);
}

// ── zip ────────────────────────────────────────────────────────────────

/** 中央ディレクトリを読む。ZIP64・暗号化・分割は扱わない（扱えないものは失敗にする）。 */
function readZipEntries(buf) {
  const minEnd = Math.max(0, buf.length - 22 - 65535);
  let eocd = -1;
  for (let i = buf.length - 22; i >= minEnd; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("zip-bad-format");
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || off === 0xffffffff) throw new Error("zip-unsupported:zip64");
  if (count > MAX_ENTRIES) throw new Error("zip-too-many-entries");
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) throw new Error("zip-bad-format");
    const flags = buf.readUInt16LE(off + 8);
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const usize = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString("utf8", off + 46, off + 46 + nameLen);
    if (flags & 1) throw new Error("zip-unsupported:encrypted");
    if (csize === 0xffffffff || usize === 0xffffffff) throw new Error("zip-unsupported:zip64");
    entries.push({ name, method, csize, usize, localOff });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function extractZipBuffer(buf, destDir) {
  const entries = readZipEntries(buf);
  let total = 0;
  const plan = [];
  // 先に全部検査してから書く（途中まで展開したものを残さない）
  for (const e of entries) {
    const full = safeJoin(destDir, e.name);
    if (!full) throw new Error(`unsafe-path:${e.name}`);
    total += e.usize;
    if (total > MAX_TOTAL_BYTES) throw new Error("archive-too-large");
    if (e.method !== 0 && e.method !== 8) throw new Error(`zip-unsupported:method-${e.method}`);
    plan.push({ ...e, full, isDir: e.name.endsWith("/") });
  }
  let files = 0;
  for (const e of plan) {
    if (e.isDir) { fs.mkdirSync(e.full, { recursive: true }); continue; }
    const lo = e.localOff;
    if (lo + 30 > buf.length || buf.readUInt32LE(lo) !== 0x04034b50) throw new Error("zip-bad-format");
    const start = lo + 30 + buf.readUInt16LE(lo + 26) + buf.readUInt16LE(lo + 28);
    const raw = buf.subarray(start, start + e.csize);
    const data = e.method === 0 ? raw : zlib.inflateRawSync(raw, { maxOutputLength: e.usize + 1 });
    if (data.length !== e.usize) throw new Error(`zip-size-mismatch:${e.name}`);
    fs.mkdirSync(path.dirname(e.full), { recursive: true });
    fs.writeFileSync(e.full, data);
    files++;
  }
  return { files };
}

// ── tar.gz ─────────────────────────────────────────────────────────────

function readTarString(buf, off, len) {
  const end = buf.indexOf(0, off);
  return buf.toString("utf8", off, end >= 0 && end < off + len ? end : off + len);
}

function parseTarEntries(tar) {
  const out = [];
  let off = 0;
  let longName = null;
  while (off + 512 <= tar.length) {
    const hdr = tar.subarray(off, off + 512);
    if (hdr.every((b) => b === 0)) break;
    let name = readTarString(hdr, 0, 100);
    const size = parseInt(readTarString(hdr, 124, 12).trim() || "0", 8);
    const type = String.fromCharCode(hdr[156] || 48);
    const linkName = readTarString(hdr, 157, 100);
    const mode = parseInt(readTarString(hdr, 100, 8).trim() || "0", 8);
    if (readTarString(hdr, 257, 6).startsWith("ustar")) {
      const prefix = readTarString(hdr, 345, 155);
      if (prefix) name = `${prefix}/${name}`;
    }
    if (!Number.isFinite(size) || size < 0) throw new Error("tar-bad-format");
    const dataStart = off + 512;
    const data = tar.subarray(dataStart, dataStart + size);
    off = dataStart + Math.ceil(size / 512) * 512;
    if (type === "L") { longName = readTarString(data, 0, data.length); continue; }
    if (type === "x" || type === "g") continue; // pax ヘッダは使わない（パスは通常のヘッダで足りる）
    if (longName) { name = longName; longName = null; }
    out.push({ name, type, size, data, linkName, mode });
    if (out.length > MAX_ENTRIES) throw new Error("tar-too-many-entries");
  }
  return out;
}

function extractTarGzBuffer(buf, destDir) {
  const tar = zlib.gunzipSync(buf, { maxOutputLength: MAX_TOTAL_BYTES });
  const entries = parseTarEntries(tar);
  const plan = [];
  for (const e of entries) {
    const full = safeJoin(destDir, e.name);
    if (!full) throw new Error(`unsafe-path:${e.name}`);
    if (e.type === "2" && !safeLinkTarget(destDir, full, e.linkName)) { plan.push({ ...e, full, skip: true }); continue; }
    if (e.type === "1") { plan.push({ ...e, full, skip: true }); continue; } // ハードリンクは作らない
    plan.push({ ...e, full });
  }
  let files = 0;
  for (const e of plan) {
    if (e.skip) continue;
    if (e.type === "5") { fs.mkdirSync(e.full, { recursive: true }); continue; }
    if (e.type === "2") {
      fs.mkdirSync(path.dirname(e.full), { recursive: true });
      try { fs.rmSync(e.full, { force: true }); fs.symlinkSync(e.linkName, e.full); } catch { /* Windows など作れない環境では飛ばす */ }
      continue;
    }
    if (e.type !== "0" && e.type !== "\0") continue;
    fs.mkdirSync(path.dirname(e.full), { recursive: true });
    fs.writeFileSync(e.full, e.data, { mode: (e.mode & 0o777) | 0o600 });
    files++;
  }
  return { files };
}

/** 拡張子で zip / tar.gz を選んで展開する。壊れた・危ないものは例外（書いたものは呼び出し側が消す）。 */
function extractArchive(file, destDir) {
  const stat = fs.statSync(file);
  if (stat.size > MAX_TOTAL_BYTES) throw new Error("archive-too-large");
  const buf = fs.readFileSync(file);
  fs.mkdirSync(destDir, { recursive: true });
  if (/\.zip$/i.test(file)) return extractZipBuffer(buf, destDir);
  if (/\.(tar\.gz|tgz)$/i.test(file)) return extractTarGzBuffer(buf, destDir);
  throw new Error("unsupported-archive");
}

/** 展開した木の中から名前で実行ファイルを探す（配布物の入れ子の深さに依存しない）。 */
function findFile(root, baseName) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const d of ents) {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) stack.push(p);
      else if (d.name === baseName) return p;
    }
  }
  return null;
}

module.exports = {
  MAX_TOTAL_BYTES,
  safeJoin,
  safeLinkTarget,
  readZipEntries,
  extractZipBuffer,
  extractTarGzBuffer,
  extractArchive,
  findFile,
};
