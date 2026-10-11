// `node --test`。DB フォルダの選択と backend への引数。
//
// 守りたいのは、破れると**利用者のデータが別の場所に散る・空の DB ができる**もの:
//   1. 無いフォルダ・関係の無いファイルがあるフォルダは開かない（黙って作らない）
//   2. `;` を含むパスは拒否（JDBC URL が壊れる）
//   3. 状態ファイルが壊れていたら既定の DB（従来の場所）に戻る
//
// 🔴 electron を import しない（CI の Desktop ジョブは npm install しない）。

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function fresh(dir) {
  delete require.cache[require.resolve("./dbFolders")];
  const d = require("./dbFolders");
  d.init(dir);
  return d;
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "graphy-dbf-"));

test("既定は <dataDir>/data。状態ファイルが無い・壊れていても既定に戻る", () => {
  const dir = tmp();
  const d = fresh(dir);
  assert.equal(d.currentFolder(), path.join(dir, "data"));
  fs.writeFileSync(path.join(dir, "db-folders.json"), "{ broken");
  assert.equal(d.currentFolder(), path.join(dir, "data"));
});

test("新規: 空のフォルダだけ。目印を書き、日本語と空白のパスでも引数が組める", () => {
  const dir = tmp();
  const d = fresh(dir);
  const f = path.join(dir, "日本語 フォルダ");
  fs.mkdirSync(f);
  const r = d.create(f);
  assert.equal(r.ok, true);
  assert.ok(fs.existsSync(path.join(f, d.MARKER)));
  assert.deepEqual(d.create(f), { ok: false, reason: "not-empty" });

  const args = d.springArgs(f, path.join(dir, "settings.json"));
  assert.equal(args[0], `--spring.datasource.url=jdbc:h2:file:${path.join(f, "graphy-index").split(path.sep).join("/")};AUTO_SERVER=TRUE`);
  assert.equal(args[1], `--graphy.dicom.storage-dir=${path.join(f, "dicom")}`);
  assert.equal(args[3], `--graphy.settings.global-file=${path.join(dir, "settings.json")}`);
});

test("開く: DB フォルダか空のフォルダだけ。無いフォルダ・関係の無いフォルダ・; は拒否", () => {
  const dir = tmp();
  const d = fresh(dir);
  const legacy = path.join(dir, "old");
  fs.mkdirSync(legacy);
  fs.writeFileSync(path.join(legacy, "graphy-index.mv.db"), "");
  assert.equal(d.validateOpen(legacy).kind, "db", "目印の無い従来の DB（索引だけ）も開ける");

  const empty = path.join(dir, "empty");
  fs.mkdirSync(empty);
  assert.equal(d.validateOpen(empty).kind, "empty");

  const other = path.join(dir, "docs");
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, "memo.txt"), "x");
  assert.deepEqual(d.validateOpen(other), { ok: false, reason: "not-a-db-folder" });

  assert.deepEqual(d.validateOpen(path.join(dir, "gone")), { ok: false, reason: "not-found" });
  assert.deepEqual(d.validateOpen("relative/x"), { ok: false, reason: "not-absolute" });
  const semi = path.join(dir, "a;b");
  fs.mkdirSync(semi);
  assert.deepEqual(d.validateOpen(semi), { ok: false, reason: "has-semicolon" });
  assert.deepEqual(d.create(semi), { ok: false, reason: "has-semicolon" });
});

test("選択: 次の起動の DB を記録し、最近使った一覧の先頭に置く。既定は current=null", () => {
  const dir = tmp();
  const d = fresh(dir);
  const a = path.join(dir, "A");
  const b = path.join(dir, "B");
  fs.mkdirSync(a);
  fs.mkdirSync(b);
  d.select(a);
  d.select(b);
  d.select(a);
  assert.equal(d.currentFolder(), a);
  assert.deepEqual(d.loadState().recent, [a, b]);

  d.select(d.defaultFolder());
  assert.equal(d.loadState().current, null);
  assert.equal(d.currentFolder(), path.join(dir, "data"));
  assert.deepEqual(d.loadState().recent, [a, b], "既定に戻しても一覧は残す");
});

test("一覧: 既定を先頭に、無いフォルダは exists=false。使用中の DB は外せない", () => {
  const dir = tmp();
  const d = fresh(dir);
  const a = path.join(dir, "A");
  fs.mkdirSync(a);
  d.select(a);
  const gone = path.join(dir, "gone");
  fs.mkdirSync(gone);
  d.select(gone);
  fs.rmdirSync(gone);
  d.select(a);

  const l = d.list(a);
  assert.deepEqual(
    l.folders.map((r) => [path.basename(r.path), r.isDefault, r.exists, r.active]),
    [["data", true, true, false], ["A", false, true, true], ["gone", false, false, false]],
  );
  assert.deepEqual(d.forget(a), { ok: false, reason: "in-use" });
  assert.deepEqual(d.forget(gone), { ok: true });
  assert.equal(d.list(a).folders.length, 2);
});

test("同じフォルダの判定: linux は大文字小文字を区別、Windows・macOS は区別しない", () => {
  const d = fresh(tmp());
  assert.equal(d.samePath("/x/DB", "/x/db", "linux"), false);
  assert.equal(d.samePath("/x/DB", "/x/db", "win32"), true);
  assert.equal(d.samePath("/x/DB", "/x/db", "darwin"), true);
  assert.equal(d.isNetworkPath("\\\\server\\share\\db"), true);
  assert.equal(d.isNetworkPath("C:\\db"), false);
});
