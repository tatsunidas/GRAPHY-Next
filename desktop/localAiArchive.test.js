const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const A = require("./localAiArchive");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "graphy-arch-"));

// ── 試験用に zip / tar.gz を手で組む（外部コマンドに依存しない） ──
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function makeZip(files) {
  const locals = [];
  const centrals = [];
  let off = 0;
  for (const f of files) {
    const name = Buffer.from(f.name);
    const raw = Buffer.from(f.data || "");
    const method = f.stored ? 0 : 8;
    const comp = method === 0 ? raw : zlib.deflateRawSync(raw);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc32(raw), 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(name.length, 26);
    const local = Buffer.concat([lh, name, comp]);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc32(raw), 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(off, 42);
    centrals.push(Buffer.concat([ch, name]));
    locals.push(local);
    off += local.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}
function tarHeader(name, size, type, link = "") {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100); h.write("0000644\0", 100); h.write(size.toString(8).padStart(11, "0") + "\0", 124);
  h.write(type, 156); h.write(link, 157, 100); h.write("ustar\0", 257);
  return h;
}
function makeTarGz(entries) {
  const parts = [];
  for (const e of entries) {
    const data = Buffer.from(e.data || "");
    parts.push(tarHeader(e.name, data.length, e.type || "0", e.link));
    if (data.length) parts.push(data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(parts));
}

test("safeJoin: 正例は展開先の中、負例は null", () => {
  const d = "/x/dest";
  assert.equal(A.safeJoin(d, "a/b.txt"), path.resolve(d, "a/b.txt"));
  for (const bad of ["../evil", "a/../../evil", "/etc/passwd", "C:\\evil", "a\\..\\..\\evil", "", "a\0b"]) {
    assert.equal(A.safeJoin(d, bad), null, bad);
  }
});

test("zip: 展開できる（deflate と stored）・入れ子の実行ファイルを見つけられる", () => {
  const dest = tmp();
  const zip = makeZip([{ name: "bin/", data: "", stored: true }, { name: "bin/llama-server.exe", data: "A".repeat(5000) }, { name: "LICENSE", data: "mit", stored: true }]);
  const f = path.join(tmp(), "x.zip");
  fs.writeFileSync(f, zip);
  const r = A.extractArchive(f, dest);
  assert.equal(r.files, 2);
  assert.equal(fs.readFileSync(path.join(dest, "bin/llama-server.exe"), "utf8").length, 5000);
  assert.equal(A.findFile(dest, "llama-server.exe"), path.join(dest, "bin/llama-server.exe"));
});

test("zip: 展開先の外へ出る名前が 1 件でもあれば、何も書かずに失敗する（zip-slip）", () => {
  const dest = tmp();
  const f = path.join(tmp(), "evil.zip");
  fs.writeFileSync(f, makeZip([{ name: "ok.txt", data: "ok" }, { name: "../escape.txt", data: "x" }]));
  assert.throws(() => A.extractArchive(f, dest), /unsafe-path/);
  assert.deepEqual(fs.readdirSync(dest), []); // 先頭の ok.txt も書かれていない
  assert.equal(fs.existsSync(path.join(dest, "..", "escape.txt")), false);
});

test("zip: 壊れたもの・暗号化・未知の形式は失敗", () => {
  const d = tmp();
  const f = path.join(tmp(), "bad.zip");
  fs.writeFileSync(f, Buffer.from("not a zip at all"));
  assert.throws(() => A.extractArchive(f, d), /zip-bad-format/);
  const g = path.join(tmp(), "a.rar");
  fs.writeFileSync(g, "x");
  assert.throws(() => A.extractArchive(g, d), /unsupported-archive/);
});

test("tar.gz: 展開できる・相対 symlink は作り、外を指す symlink は作らない", { skip: process.platform === "win32" }, () => {
  const dest = tmp();
  const f = path.join(tmp(), "x.tar.gz");
  fs.writeFileSync(f, makeTarGz([
    { name: "llama/", type: "5" },
    { name: "llama/llama-server", data: "#!bin" },
    { name: "llama/libx.so", type: "2", link: "libx.so.1" },
    { name: "llama/evil", type: "2", link: "/etc/passwd" },
    { name: "llama/evil2", type: "2", link: "../../outside" },
  ]));
  const r = A.extractArchive(f, dest);
  assert.equal(r.files, 1);
  assert.equal(fs.readlinkSync(path.join(dest, "llama/libx.so")), "libx.so.1");
  assert.equal(fs.existsSync(path.join(dest, "llama/evil")), false);
  assert.equal(fs.lstatSync(path.join(dest, "llama/llama-server")).isFile(), true);
});

test("tar.gz: 展開先の外へ出る名前は失敗する", () => {
  const dest = tmp();
  const f = path.join(tmp(), "evil.tar.gz");
  fs.writeFileSync(f, makeTarGz([{ name: "../escape", data: "x" }]));
  assert.throws(() => A.extractArchive(f, dest), /unsafe-path/);
});

test("findFile: 無ければ null", () => {
  const d = tmp();
  assert.equal(A.findFile(d, "llama-server"), null);
});
