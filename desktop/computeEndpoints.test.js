// `node --test`。設計: fw/remote-compute-design.md §4.3
//
// 守りたいのは、破れると**匿名化した画像とプラグインのコードの送り先が変わる**もの:
//   1. 平文 http は院内アドレスだけ（規則は aiProviders.allowsPlainHttp と同じ）
//   2. URL にトークン・クエリ・認証情報を入れさせない
//   3. 1 件でも不正なら保存しない（黙って消さない）
//
// 🔴 electron を import しない（CI の Desktop ジョブは npm install しない）。

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function fresh(dir) {
  delete require.cache[require.resolve("./computeEndpoints")];
  const c = require("./computeEndpoints");
  c.init(dir);
  return c;
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "graphy-compute-"));

test("URL: https とパスを許し、末尾を / にそろえる", () => {
  const c = fresh(tmp());
  assert.deepEqual(c.parseUrl("https://hub.example.org/user/a"), {
    ok: true, url: "https://hub.example.org/user/a/", hostname: "hub.example.org", plaintext: false,
  });
  assert.equal(c.parseUrl("https://gpu.example.org:8443").url, "https://gpu.example.org:8443/");
});

test("URL: 平文 http は院内アドレスだけ", () => {
  const c = fresh(tmp());
  for (const ok of ["http://127.0.0.1:8888", "http://192.168.1.20:8888", "http://gpuserver:8888", "http://gpu.lab.local"]) {
    const r = c.parseUrl(ok);
    assert.equal(r.ok, true, ok);
    assert.equal(r.plaintext, true, ok);
  }
  for (const ng of ["http://gpu.example.org", "http://8.8.8.8:8888", "http://[fd00::1]"]) {
    assert.equal(c.parseUrl(ng).reason, "url-plain-http", ng);
  }
});

test("URL: トークン・認証情報・クエリを入れさせない", () => {
  const c = fresh(tmp());
  assert.equal(c.parseUrl("https://x.org/?token=abc").reason, "url-has-query");
  assert.equal(c.parseUrl("https://u:p@x.org/").reason, "url-has-credentials");
  assert.equal(c.parseUrl("https://x.org/#t").reason, "url-has-fragment");
  assert.equal(c.parseUrl("ftp://x.org/").reason, "url-scheme");
  assert.equal(c.parseUrl("").reason, "url-missing");
});

test("保存: 1 件でも不正なら書かない", () => {
  const dir = tmp();
  const c = fresh(dir);
  const r = c.save({ endpoints: [
    { id: "lab", label: "Lab GPU", url: "https://gpu.example.org" },
    { id: "bad", url: "http://gpu.example.org" },
  ] });
  assert.equal(r.ok, false);
  assert.deepEqual(r.problems, ["bad:url-plain-http"]);
  assert.equal(fs.existsSync(path.join(dir, c.FILE_NAME)), false);
});

test("保存: 正規形で書き、読み直せる・トークンは書かない", () => {
  const dir = tmp();
  let c = fresh(dir);
  assert.equal(c.save({ endpoints: [{ id: "lab", label: " Lab ", url: "https://gpu.example.org/j", token: "SECRET" }] }).ok, true);
  const raw = fs.readFileSync(path.join(dir, c.FILE_NAME), "utf8");
  assert.equal(raw.includes("SECRET"), false, "トークンはファイルに書かない");
  c = fresh(dir);
  assert.deepEqual(c.get().endpoints, [{ id: "lab", label: "Lab", kind: "jupyter", url: "https://gpu.example.org/j/" }]);
  assert.equal(c.byId("lab").url, "https://gpu.example.org/j/");
  assert.equal(c.byId("../x"), null);
});

test("id: 形・重複・件数", () => {
  const c = fresh(tmp());
  assert.deepEqual(c.validate({ endpoints: [{ id: "Lab", url: "https://a.org" }] }).problems, ["Lab:bad-id"]);
  assert.deepEqual(
    c.validate({ endpoints: [{ id: "a", url: "https://a.org" }, { id: "a", url: "https://b.org" }] }).problems,
    ["a:duplicate-id"],
  );
  const many = Array.from({ length: c.MAX_ENDPOINTS + 1 }, (_, i) => ({ id: `e${i}`, url: "https://a.org" }));
  assert.equal(c.validate({ endpoints: many }).ok, false);
});

test("壊れたファイルは黙って空にしない（理由を出す）", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "compute-endpoints.json"), "{ // comment\n}");
  const c = fresh(dir);
  assert.match(c.get().problems[0], /^config:parse-error/);
});

test("送信先の同一性は URL で決まる（ラベルの変更では確認を出さない）", () => {
  const c = fresh(tmp());
  const a = { id: "x", label: "A", kind: "jupyter", url: "https://a.org/" };
  assert.equal(c.destinationOf(a), c.destinationOf({ ...a, label: "B" }));
  assert.notEqual(c.destinationOf(a), c.destinationOf({ ...a, url: "https://b.org/" }));
});
