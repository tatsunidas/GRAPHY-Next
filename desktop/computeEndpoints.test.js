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

test("Colab: URL を持たずランタイムの種類だけ持つ・種類の値の形を確かめる・宛先は Colab で 1 つ", () => {
  const c = fresh(tmp());
  const ok = c.validate({ endpoints: [{ id: "colab", label: "Colab T4", kind: "colab",
    spec: { variant: "VARIANT_GPU", accelerator: "T4", shape: "SHAPE_STANDARD" } }] });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.endpoints[0], { id: "colab", label: "Colab T4", kind: "colab",
    spec: { variant: "VARIANT_GPU", accelerator: "T4", shape: "SHAPE_STANDARD" } });
  const bad = c.validate({ endpoints: [{ id: "colab", kind: "colab", spec: { variant: "../x", accelerator: "T4", shape: "S" } }] });
  assert.deepEqual(bad.problems, ["colab:bad-colab-spec"]);
  const a = { id: "colab", kind: "colab", spec: { variant: "VARIANT_GPU", accelerator: "T4", shape: "SHAPE_STANDARD" } };
  assert.equal(c.destinationOf(a), c.destinationOf({ ...a, spec: { ...a.spec, accelerator: "A100" } }),
    "GPU の種類を変えても送り先（Google の Colab）は同じ");
});

// ── schema 2: 「この PC」の Python の設定（最上位の local）──────────────────────
const readJson = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "compute-endpoints.json"), "utf8"));
const lab = { id: "lab", label: "Lab", kind: "jupyter", url: "https://gpu.example.org/" };

test("v1 のファイル: local は auto として読み、読むだけでは書き換えない・接続先は変わらない", () => {
  const dir = tmp();
  const file = path.join(dir, "compute-endpoints.json");
  const v1 = JSON.stringify({ schemaVersion: 1, endpoints: [{ id: "lab", label: "Lab", kind: "jupyter", url: "https://gpu.example.org/" }] }, null, 2);
  fs.writeFileSync(file, v1);
  const c = fresh(dir);
  const g = c.get();
  assert.deepEqual(g.local, { python: { mode: "auto" } });
  assert.deepEqual(g.endpoints, [lab]);
  assert.deepEqual(g.problems, []);
  assert.equal(fs.readFileSync(file, "utf8"), v1, "読むだけでは書き換えない");
  // schemaVersion が無い古いファイルも同じ
  fs.writeFileSync(file, JSON.stringify({ endpoints: [lab] }));
  assert.deepEqual(fresh(dir).get().local, { python: { mode: "auto" } });
});

test("v2 のファイル: local を読む／不正な local は problems に積んで auto（黙って消さない）", () => {
  const dir = tmp();
  const file = path.join(dir, "compute-endpoints.json");
  const abs = path.resolve("/opt/py/bin/python");
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 2, endpoints: [], local: { python: { mode: "path", path: abs } } }));
  assert.deepEqual(fresh(dir).get().local, { python: { mode: "path", path: abs } });
  for (const [bad, code] of [
    [{ python: { mode: "path", path: "relative/python" } }, "local:bad-python-path"],
    [{ python: { mode: "path" } }, "local:bad-python-path"],
    [{ python: { mode: "path", path: "/a\0b" } }, "local:bad-python-path"],
    [{ python: { mode: "weird" } }, "local:bad-python-mode"],
    [{ python: "x" }, "local:bad-python"],
  ]) {
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 2, endpoints: [lab], local: bad }));
    const g = fresh(dir).get();
    assert.deepEqual(g.problems, [code], JSON.stringify(bad));
    assert.deepEqual(g.local, { python: { mode: "auto" } });
    assert.deepEqual(g.endpoints, [lab], "接続先は影響を受けない");
  }
});

test("v3 以上は schema-too-new を出し、保存で上書きしない", () => {
  const dir = tmp();
  const file = path.join(dir, "compute-endpoints.json");
  const v3 = JSON.stringify({ schemaVersion: 3, endpoints: [lab], future: true });
  fs.writeFileSync(file, v3);
  const c = fresh(dir);
  assert.deepEqual(c.get().problems, ["config:schema-too-new:3"]);
  assert.deepEqual(c.save({ endpoints: [lab] }), { ok: false, problems: ["config:schema-too-new:3"] });
  assert.deepEqual(c.setLocalPython({ mode: "auto" }), { ok: false, problems: ["config:schema-too-new:3"] });
  assert.equal(fs.readFileSync(file, "utf8"), v3);
});

test("接続先を保存しても local が残る（旧実装の save は渡されなかった local を捨てる）", () => {
  const dir = tmp();
  const c = fresh(dir);
  const abs = path.resolve("/opt/py/bin/python");
  assert.equal(c.setLocalPython({ mode: "path", path: abs }).ok, true);
  assert.equal(c.save({ endpoints: [lab] }).ok, true, "local を渡さない保存");
  assert.deepEqual(readJson(dir).local, { python: { mode: "path", path: abs } });
  assert.deepEqual(fresh(dir).get().local, { python: { mode: "path", path: abs } });
  assert.equal(readJson(dir).schemaVersion, 2);
  // 接続先をもう一度編集しても残る
  assert.equal(c.save({ endpoints: [{ ...lab, label: "Lab2" }] }).ok, true);
  assert.deepEqual(readJson(dir).local.python.path, abs);
});

test("Python の設定を変えても、接続先の件数・URL は変わらない（トークンは secretStore でここには無い）", () => {
  const dir = tmp();
  const c = fresh(dir);
  c.save({ endpoints: [lab, { id: "colab", label: "C", kind: "colab", spec: { variant: "VARIANT_GPU", accelerator: "T4", shape: "SHAPE_STANDARD" } }] });
  const before = JSON.stringify(readJson(dir).endpoints);
  c.setLocalPython({ mode: "path", path: path.resolve("/opt/py/bin/python") });
  assert.equal(JSON.stringify(readJson(dir).endpoints), before);
  c.setLocalPython({ mode: "auto" });
  assert.deepEqual(readJson(dir).local, { python: { mode: "auto" } });
  assert.equal(JSON.stringify(readJson(dir).endpoints), before);
});

test("setLocalPython: 不正な設定・読めないファイルには書かない", () => {
  const dir = tmp();
  const c = fresh(dir);
  assert.deepEqual(c.setLocalPython({ mode: "path", path: "rel" }).problems, ["local:bad-python-path"]);
  assert.equal(fs.existsSync(path.join(dir, "compute-endpoints.json")), false);
  fs.writeFileSync(path.join(dir, "compute-endpoints.json"), "{ broken");
  const c2 = fresh(dir);
  assert.match(c2.setLocalPython({ mode: "auto" }).problems[0], /^config:parse-error/);
  assert.equal(fs.readFileSync(path.join(dir, "compute-endpoints.json"), "utf8"), "{ broken");
});

test("local を渡した save: 検査して書く／不正なら何も書かない。接続先の検査は local の影響を受けない", () => {
  const dir = tmp();
  const c = fresh(dir);
  assert.equal(c.save({ endpoints: [lab], local: { python: { mode: "path", path: "rel" } } }).ok, false);
  assert.equal(fs.existsSync(path.join(dir, "compute-endpoints.json")), false);
  assert.equal(c.validate({ endpoints: [lab], local: "ignored" }).ok, true);
});

// ── defaultId（既定の計算機）の保存と移行 ───────────────────────────────
const LAB = { id: "lab", label: "Lab", kind: "jupyter", url: "https://lab.example/" };
const T4 = { id: "colab-t4", label: "Colab T4", kind: "colab", spec: { variant: "VARIANT_GPU", accelerator: "T4", shape: "SHAPE_STANDARD" } };
const writeFile = (dir, obj) => fs.writeFileSync(path.join(dir, "compute-endpoints.json"), typeof obj === "string" ? obj : JSON.stringify(obj));
const readRaw = (dir) => fs.readFileSync(path.join(dir, "compute-endpoints.json"), "utf8");

test("defaultId: キーが無い（未移行）は undefined のまま読み、読むだけではファイルを書き換えない", () => {
  const dir = tmp();
  writeFile(dir, { schemaVersion: 1, endpoints: [LAB] });
  const before = readRaw(dir);
  const c = fresh(dir);
  assert.equal(c.get().defaultId, undefined);
  assert.equal(c.get().endpoints.length, 1);
  assert.equal(readRaw(dir), before, "読んだだけで書いていない（バイト列が同じ）");
});

test("defaultId: null（自動）・id・\"local\" を読む／形が不正なら自動にして理由を残す", () => {
  for (const [v, want] of [[null, null], ["lab", "lab"], ["local", "local"]]) {
    const dir = tmp();
    writeFile(dir, { schemaVersion: 2, endpoints: [LAB], defaultId: v });
    assert.equal(fresh(dir).get().defaultId, want);
  }
  const dir = tmp();
  writeFile(dir, { schemaVersion: 2, endpoints: [LAB], defaultId: 42 });
  const c = fresh(dir);
  assert.equal(c.get().defaultId, null);
  assert.ok(c.get().problems.includes("default:bad-id"));
});

test("defaultId: save は渡されなければ今の値を引き継ぎ、未移行なら書かないまま（移行を勝手に確定させない）", () => {
  const dir = tmp();
  writeFile(dir, { schemaVersion: 1, endpoints: [LAB] });
  const c = fresh(dir);
  assert.equal(c.save({ endpoints: [LAB, T4] }).ok, true);
  assert.equal("defaultId" in JSON.parse(readRaw(dir)), false);
  assert.equal(c.save({ endpoints: [LAB, T4], defaultId: "lab" }).ok, true);
  assert.equal(JSON.parse(readRaw(dir)).defaultId, "lab");
  assert.equal(c.save({ endpoints: [LAB] }).ok, true);
  assert.equal(JSON.parse(readRaw(dir)).defaultId, "lab", "渡さなければ保たれる");
});

test("defaultId: 選んだ接続先を消すと null（自動）になる。\"local\" は消えない", () => {
  const dir = tmp();
  writeFile(dir, { schemaVersion: 2, endpoints: [LAB, T4], defaultId: "lab" });
  const c = fresh(dir);
  assert.equal(c.save({ endpoints: [T4] }).ok, true);
  assert.equal(JSON.parse(readRaw(dir)).defaultId, null);
  assert.equal(c.setDefaultId("local").ok, true);
  assert.equal(c.save({ endpoints: [] }).ok, true);
  assert.equal(JSON.parse(readRaw(dir)).defaultId, "local");
});

test("setDefaultId: 登録に在る id・local・null だけ。知らない id・不正な形は書かない／接続先と Python の設定は保つ", () => {
  const dir = tmp();
  writeFile(dir, { schemaVersion: 2, endpoints: [LAB], local: { python: { mode: "path", path: path.resolve("/opt/py/bin/python") } } });
  const c = fresh(dir);
  assert.deepEqual(c.setDefaultId("nope"), { ok: false, problems: ["default:unknown-endpoint"] });
  assert.equal(c.setDefaultId("../x").ok, false);
  assert.equal(c.setDefaultId("lab").ok, true);
  const f = JSON.parse(readRaw(dir));
  assert.equal(f.defaultId, "lab");
  assert.equal(f.endpoints.length, 1);
  assert.equal(f.local.python.mode, "path");
  assert.equal(c.setDefaultId(null).ok, true);
  assert.equal(JSON.parse(readRaw(dir)).defaultId, null);
});

test("setDefaultId: 読めないファイル・新しい版は書かない（負例）", () => {
  const dir = tmp();
  writeFile(dir, "{ broken");
  const c = fresh(dir);
  assert.equal(c.setDefaultId(null).ok, false);
  assert.equal(readRaw(dir), "{ broken");
  const dir2 = tmp();
  writeFile(dir2, { schemaVersion: 3, endpoints: [] });
  assert.equal(fresh(dir2).setDefaultId(null).ok, false);
});
