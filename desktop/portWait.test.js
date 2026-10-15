// `node --test`。再起動のあと、前の backend がポートを離すのを待つ。
const test = require("node:test");
const assert = require("node:assert");
const net = require("node:net");
const { waitPortFree, portInUse } = require("./portWait");

const listen = () => new Promise((r) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => r(s)); });

test("空いているポートではすぐ返る", async () => {
  const s = await listen();
  const port = s.address().port;
  await new Promise((r) => s.close(r));
  const t0 = Date.now();
  assert.equal(await waitPortFree(port, { timeoutMs: 2000, intervalMs: 50 }), true);
  assert.ok(Date.now() - t0 < 1000);
});

test("使われているポートが途中で空けば、そこで返る", async () => {
  const s = await listen();
  const port = s.address().port;
  assert.equal(await portInUse(port), true);
  setTimeout(() => s.close(), 300);
  const t0 = Date.now();
  assert.equal(await waitPortFree(port, { timeoutMs: 5000, intervalMs: 50 }), true);
  assert.ok(Date.now() - t0 >= 250);
});

test("空かなければ時間切れで false", async () => {
  const s = await listen();
  try {
    assert.equal(await waitPortFree(s.address().port, { timeoutMs: 300, intervalMs: 50 }), false);
  } finally {
    s.close();
  }
});
