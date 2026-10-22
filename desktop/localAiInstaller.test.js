const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const I = require("./localAiInstaller");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "graphy-inst-"));
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

/** 試験用の配布サーバー。`routes[path]` = (req,res)=>void。fake request が https の URL をここへ張り替える。 */
async function withServer(routes, fn) {
  const hits = [];
  const srv = http.createServer((req, res) => {
    hits.push({ url: req.url, range: req.headers.range });
    const h = routes[req.url];
    if (!h) { res.statusCode = 404; res.end(); return; }
    h(req, res);
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  // https://github.com/<path> を本物の https ではなく、ここへ送る（redirect の Location も同じ規則で解決される）
  const request = (url, headers) => new Promise((resolve, reject) => {
    const u = new URL(url);
    const hit = http.get({ host: "127.0.0.1", port, path: u.pathname + u.search, headers }, (res) => resolve({ statusCode: res.statusCode, headers: res.headers, stream: res }));
    hit.once("error", reject);
  });
  try { return await fn({ request, hits, port }); } finally { await new Promise((r) => srv.close(r)); }
}

const DATA = crypto.randomBytes(200000);

test("isAllowedUrl: 正例（GitHub/HF とその CDN）と負例（http・他ホスト・認証情報・なりすまし）", () => {
  for (const ok of ["https://github.com/a/b", "https://objects.githubusercontent.com/x", "https://huggingface.co/m/resolve/main/f.gguf", "https://cdn-lfs.hf.co/x"]) {
    assert.equal(I.isAllowedUrl(ok), true, ok);
  }
  for (const bad of ["http://github.com/a", "https://evil.example/a", "https://github.com.evil.example/a", "https://notgithub.com/a", "https://u:p@github.com/a", "ftp://github.com/a", "nonsense", "https://127.0.0.1/a"]) {
    assert.equal(I.isAllowedUrl(bad), false, bad);
  }
});

test("validateManifest: 同梱のマニフェストは通る・壊れたものは落ちる", () => {
  const real = JSON.parse(fs.readFileSync(path.join(__dirname, "localAiManifest.json"), "utf8"));
  assert.deepEqual(I.validateManifest(real), []);
  const bad = JSON.parse(JSON.stringify(real));
  const k = Object.keys(bad.runtime.assets)[0];
  bad.runtime.assets[k].url = "https://evil.example/x.zip";
  bad.runtime.assets[k].sha256 = "zz";
  bad.models[0].file = "../x.gguf";
  const p = I.validateManifest(bad);
  assert.ok(p.some((x) => x.endsWith("url-not-allowed")));
  assert.ok(p.some((x) => x.endsWith("bad-sha256")));
  assert.ok(p.some((x) => x.endsWith("bad-file")));
  assert.deepEqual(I.validateManifest(null), ["manifest:bad-schema"]);
});

test("download: sha256 が一致すれば rename され、進捗が出る", async () => {
  await withServer({ "/f": (q, r) => r.end(DATA) }, async ({ request }) => {
    const dest = path.join(tmp(), "f.bin");
    const prog = [];
    const r = await I.download({ url: "https://github.com/f", dest, sha256: sha(DATA), size: DATA.length, request, onProgress: (p) => prog.push(p.received) });
    assert.deepEqual(r, { ok: true });
    assert.equal(sha(fs.readFileSync(dest)), sha(DATA));
    assert.equal(fs.existsSync(dest + ".part"), false);
    assert.ok(prog.length > 0 && prog[prog.length - 1] === DATA.length);
  });
});

test("download: sha256 が違えば捨てて、dest は作られない（負例）", async () => {
  await withServer({ "/f": (q, r) => r.end(DATA) }, async ({ request }) => {
    const dest = path.join(tmp(), "f.bin");
    const r = await I.download({ url: "https://github.com/f", dest, sha256: "0".repeat(64), size: DATA.length, request });
    assert.deepEqual(r, { ok: false, error: "sha256-mismatch" });
    assert.equal(fs.existsSync(dest), false);
    assert.equal(fs.existsSync(dest + ".part"), false);
  });
});

test("download: 宣言より大きい応答は途中で打ち切る", async () => {
  await withServer({ "/f": (q, r) => r.end(DATA) }, async ({ request }) => {
    const dest = path.join(tmp(), "f.bin");
    const r = await I.download({ url: "https://github.com/f", dest, sha256: sha(DATA), size: 1000, request });
    assert.deepEqual(r, { ok: false, error: "size-exceeded" });
    assert.equal(fs.existsSync(dest), false);
  });
});

test("download: 許可ホストの 302 は追い、許可外ホストへの 302 は追わない", async () => {
  await withServer({
    "/start": (q, r) => { r.statusCode = 302; r.setHeader("Location", "https://objects.githubusercontent.com/real"); r.end(); },
    "/real": (q, r) => r.end(DATA),
    "/evil": (q, r) => { r.statusCode = 302; r.setHeader("Location", "https://evil.example/steal"); r.end(); },
    "/http": (q, r) => { r.statusCode = 302; r.setHeader("Location", "http://github.com/plain"); r.end(); },
  }, async ({ request, hits }) => {
    const d = tmp();
    const ok = await I.download({ url: "https://github.com/start", dest: path.join(d, "a"), sha256: sha(DATA), size: DATA.length, request });
    assert.deepEqual(ok, { ok: true });
    const evil = await I.download({ url: "https://github.com/evil", dest: path.join(d, "b"), sha256: sha(DATA), size: DATA.length, request });
    assert.deepEqual(evil, { ok: false, error: "redirect-not-allowed" });
    const plain = await I.download({ url: "https://github.com/http", dest: path.join(d, "c"), sha256: sha(DATA), size: DATA.length, request });
    assert.deepEqual(plain, { ok: false, error: "redirect-not-allowed" });
    assert.ok(!hits.some((h) => h.url === "/steal")); // 許可外ホストへは要求自体を出していない
  });
});

test("download: 無限リダイレクトは上限で止まる", async () => {
  await withServer({ "/loop": (q, r) => { r.statusCode = 302; r.setHeader("Location", "https://github.com/loop"); r.end(); } }, async ({ request }) => {
    const r = await I.download({ url: "https://github.com/loop", dest: path.join(tmp(), "x"), sha256: sha(DATA), size: DATA.length, request });
    assert.deepEqual(r, { ok: false, error: "too-many-redirects" });
  });
});

test("download: URL が許可外なら要求を出さない／HTTP エラーはエラーにする", async () => {
  await withServer({}, async ({ request, hits }) => {
    const d = tmp();
    assert.deepEqual(await I.download({ url: "https://evil.example/x", dest: path.join(d, "a"), sha256: sha(DATA), size: 1, request }), { ok: false, error: "url-not-allowed" });
    assert.deepEqual(await I.download({ url: "https://github.com/missing", dest: path.join(d, "b"), sha256: sha(DATA), size: 1, request }), { ok: false, error: "http-404" });
    assert.equal(hits.length, 1); // 許可外は 0 回、404 は 1 回
  });
});

test("download: 中断後に Range で再開できる（.part から続き）", async () => {
  await withServer({
    "/f": (q, r) => {
      const m = /bytes=(\d+)-/.exec(q.headers.range || "");
      const from = m ? Number(m[1]) : 0;
      r.statusCode = m ? 206 : 200;
      r.end(DATA.subarray(from));
    },
  }, async ({ request, hits }) => {
    const dest = path.join(tmp(), "f.bin");
    fs.writeFileSync(dest + ".part", DATA.subarray(0, 70000));
    const r = await I.download({ url: "https://github.com/f", dest, sha256: sha(DATA), size: DATA.length, request });
    assert.deepEqual(r, { ok: true });
    assert.equal(hits[0].range, "bytes=70000-");
    assert.equal(sha(fs.readFileSync(dest)), sha(DATA));
  });
});

test("download: 再開に対応しないサーバー（200）は最初からやり直す", async () => {
  await withServer({ "/f": (q, r) => r.end(DATA) }, async ({ request }) => {
    const dest = path.join(tmp(), "f.bin");
    fs.writeFileSync(dest + ".part", Buffer.from("garbage-from-old-attempt"));
    const r = await I.download({ url: "https://github.com/f", dest, sha256: sha(DATA), size: DATA.length, request });
    assert.deepEqual(r, { ok: true });
  });
});

test("download: 途中で切れたら incomplete で .part を残す（再開用）", async () => {
  await withServer({ "/f": (q, r) => { r.setHeader("Content-Length", DATA.length); r.write(DATA.subarray(0, 5000)); setTimeout(() => r.destroy(), 30); } }, async ({ request }) => {
    const dest = path.join(tmp(), "f.bin");
    const r = await I.download({ url: "https://github.com/f", dest, sha256: sha(DATA), size: DATA.length, request });
    assert.equal(r.ok, false);
    assert.equal(fs.existsSync(dest), false);
  });
});

test("download: 中止（AbortSignal）は canceled", async () => {
  await withServer({ "/f": (q, r) => { r.write(DATA.subarray(0, 100)); /* 終わらない */ } }, async ({ request }) => {
    const ac = new AbortController();
    const p = I.download({ url: "https://github.com/f", dest: path.join(tmp(), "f.bin"), sha256: sha(DATA), size: DATA.length, request, signal: ac.signal });
    setTimeout(() => ac.abort(), 100);
    assert.deepEqual(await p, { ok: false, error: "canceled" });
  });
});

test("verifyAgainst: 正例と、sha256・サイズ違い・無いファイルの負例", async () => {
  const f = path.join(tmp(), "m.bin");
  fs.writeFileSync(f, DATA);
  assert.deepEqual(await I.verifyAgainst(f, { sha256: sha(DATA), size: DATA.length }), { ok: true });
  assert.deepEqual(await I.verifyAgainst(f, { sha256: "1".repeat(64), size: DATA.length }), { ok: false, error: "sha256-mismatch" });
  assert.deepEqual(await I.verifyAgainst(f, { sha256: sha(DATA), size: 5 }), { ok: false, error: "size-mismatch" });
  assert.deepEqual(await I.verifyAgainst(path.join(tmp(), "none"), { sha256: sha(DATA), size: 1 }), { ok: false, error: "not-found" });
});

test("validateManifest: reasoning は on/off/auto だけ・既定モデルが一覧に無ければ落ちる（負例）", () => {
  const real = JSON.parse(fs.readFileSync(path.join(__dirname, "localAiManifest.json"), "utf8"));
  const bad = JSON.parse(JSON.stringify(real));
  bad.models[0].reasoning = "--evil";
  bad.defaultModelId = "nope";
  const p = I.validateManifest(bad);
  assert.ok(p.some((x) => x.endsWith("bad-reasoning")));
  assert.ok(p.includes("manifest:bad-default-model"));
});
