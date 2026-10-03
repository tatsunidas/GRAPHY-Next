// `node --test`。設計: fw/remote-compute-design.md §4.1
//
// 守りたいのは: 内部経路の secret が自分の backend（loopback）にしか送られないこと、
// トークン込みの一覧が正しい形で届くこと。

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");

function fresh() {
  delete require.cache[require.resolve("./computeBridge")];
  return require("./computeBridge");
}

test("secret: 起動ごとに 64 桁の乱数・短い値は使わない", () => {
  const b = fresh();
  const s1 = b.createSecret();
  assert.match(s1, /^[0-9a-f]{64}$/);
  assert.notEqual(s1, b.createSecret());
  assert.notEqual(b.createSecret("short"), "short");
  const given = "x".repeat(40);
  assert.equal(b.createSecret(given), given);
});

test("loopback 以外の backend には繋がない", () => {
  const b = fresh();
  assert.throws(() => b.init({ secret: "s".repeat(64), apiBase: "http://example.org:8080" }));
  assert.throws(() => b.init({ secret: "s".repeat(64), apiBase: "https://localhost:8080" }));
  b.init({ secret: "s".repeat(64), apiBase: "http://localhost:8080" });
  assert.equal(b.enabled(), true);
});

test("secret が無ければ何も送らない", async () => {
  const b = fresh();
  b.init({ secret: null, apiBase: "http://localhost:1" });
  assert.equal(b.enabled(), false);
  const r = await b.pushEndpoints([{ id: "a", label: "A", url: "https://a.org/", token: "t" }]);
  assert.equal(r.error, "main-channel-disabled");
});

test("一覧はトークン込み・Bearer 付き・Origin 無しで届く", async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, origin: req.headers.origin, body });
      res.setHeader("Content-Type", "application/json");
      res.end(req.url.endsWith("/test") ? '{"ok":true,"stage":"done"}' : '{"ok":true,"count":1}');
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try {
    const b = fresh();
    const secret = "k".repeat(64);
    b.init({ secret, apiBase: `http://127.0.0.1:${port}` });
    const r = await b.pushEndpoints([{ id: "lab", label: "Lab", url: "https://gpu.example.org/", token: "TOKEN" }]);
    assert.equal(r.ok, true);
    assert.equal(seen[0].method, "PUT");
    assert.equal(seen[0].url, "/api/internal/compute/endpoints");
    assert.equal(seen[0].auth, `Bearer ${secret}`);
    assert.equal(seen[0].origin, undefined, "Origin を付けない（backend は Origin 付きを弾く）");
    assert.deepEqual(JSON.parse(seen[0].body), {
      endpoints: [{ id: "lab", label: "Lab", url: "https://gpu.example.org/", token: "TOKEN" }],
    });
    const t = await b.testEndpoint("lab");
    assert.equal(t.stage, "done");
    assert.equal(seen[1].url, "/api/internal/compute/endpoints/lab/test");
  } finally {
    server.close();
  }
});
