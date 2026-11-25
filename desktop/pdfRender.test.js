// `node --test`。host.renderPdf の検証・通信の遮断・後始末・直列化（electron は偽物）。
const test = require("node:test");
const assert = require("node:assert");
const { create, validateRequest, isAllowedRequestUrl, MAX_HTML_BYTES, REPORT_URL } = require("./pdfRender");

test("要求の検証: 正例は既定値を補う", () => {
  assert.deepEqual(validateRequest({ html: "<p>x</p>" }), { ok: true, html: "<p>x</p>", pageSize: "A4", landscape: false });
  assert.deepEqual(validateRequest({ html: "x", pageSize: "Letter", landscape: true }), { ok: true, html: "x", pageSize: "Letter", landscape: true });
});

test("要求の検証: 型違い・未知のページ・空・過大は落ちる（負例）", () => {
  for (const bad of [null, undefined, [], "x", 1, {}, { html: "" }, { html: 1 }, { html: "x", pageSize: "A3" }, { html: "x", landscape: "yes" }]) {
    assert.deepEqual(validateRequest(bad), { ok: false, error: "bad-request" }, JSON.stringify(bad));
  }
  assert.deepEqual(validateRequest({ html: "a".repeat(MAX_HTML_BYTES + 1) }), { ok: false, error: "too-large" });
  // UTF-16 では上限以下でも、UTF-8 に直すと超える（日本語は 3 バイト）
  assert.deepEqual(validateRequest({ html: "あ".repeat(Math.ceil(MAX_HTML_BYTES / 3) + 1) }), { ok: false, error: "too-large" });
  assert.equal(validateRequest({ html: "a".repeat(MAX_HTML_BYTES) }).ok, true);
});

test("通信の遮断: 自前の画面と data: の画像だけ通す。http(s)・file・その他は全部止める", () => {
  assert.equal(isAllowedRequestUrl(REPORT_URL), true);
  assert.equal(isAllowedRequestUrl("data:image/png;base64,AAAA"), true);
  for (const u of [
    "http://127.0.0.1:8080/x.png", "https://example.com/a", "file:///etc/hostname", "ftp://x/y", "ws://x",
    "data:text/html;base64,AAAA", "data:image/svg+xml;base64,AAAA", "graphy-pdf://report/other.html",
    "javascript:alert(1)", "", null, undefined, 1,
  ]) {
    assert.equal(isAllowedRequestUrl(u), false, String(u));
  }
});

/** electron の偽物。作った窓・セッションを記録する。 */
function fakes(opts = {}) {
  const log = { windows: [], sessions: [], events: [] };
  const session = {
    fromPartition(name) {
      const s = {
        name, handler: null, hook: null, unhandled: false,
        webRequest: { onBeforeRequest(h) { s.hook = h; } },
        protocol: { handle(_scheme, h) { s.handler = h; }, unhandle() { s.unhandled = true; } },
      };
      log.sessions.push(s);
      return s;
    },
  };
  class BrowserWindow {
    constructor(o) {
      this.opts = o; this.destroyed = false; log.windows.push(this); log.events.push(`new${log.windows.length}`);
      this.webContents = {
        on() {}, setWindowOpenHandler() {},
        printToPDF: async (p) => { this.printOpts = p; if (opts.printFails) throw new Error("boom"); return Buffer.from("%PDF-1.4 fake"); },
      };
    }
    async loadURL(url) { this.url = url; if (opts.loadHangs) await new Promise(() => {}); }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; log.events.push(`destroy${log.windows.indexOf(this) + 1}`); }
  }
  return { deps: { BrowserWindow, session, randomId: (() => { let i = 0; return () => String(++i); })(), timeoutMs: opts.timeoutMs }, log };
}

test("PDF が出る。窓は安全な設定で作られ、終わったら破棄される。セッションは使い捨て", async () => {
  const { deps, log } = fakes();
  const r = await create(deps)({ html: "<p>あ</p>", landscape: true });
  assert.equal(r.ok, true);
  assert.equal(Buffer.from(r.bytes).toString().startsWith("%PDF"), true);
  assert.ok(r.bytes instanceof Uint8Array);
  const w = log.windows[0];
  assert.equal(w.url, REPORT_URL);
  assert.deepEqual(
    { s: w.opts.webPreferences.sandbox, j: w.opts.webPreferences.javascript, n: w.opts.webPreferences.nodeIntegration, c: w.opts.webPreferences.contextIsolation, show: w.opts.show },
    { s: true, j: false, n: false, c: true, show: false });
  assert.equal(w.printOpts.landscape, true);
  assert.equal(w.printOpts.pageSize, "A4");
  assert.equal(w.destroyed, true);
  assert.match(log.sessions[0].name, /^graphy-pdf-/);
  assert.doesNotMatch(log.sessions[0].name, /^persist:/);
  assert.equal(log.sessions[0].unhandled, true);
  // 自前の画面の応答は、渡した HTML そのもの
  const res = await log.sessions[0].handler();
  assert.equal(await res.text(), "<p>あ</p>");
});

test("窓の中から出た外部要求は止め、止めた URL を結果に残す", async () => {
  const { deps, log } = fakes();
  const render = create(deps);
  const p = render({ html: "<img src='http://127.0.0.1:1/x'>" });
  // 描画中に外部要求が来た想定
  await new Promise((r) => setImmediate(r));
  const hook = log.sessions[0].hook;
  const seen = [];
  hook({ url: "http://127.0.0.1:1/x" }, (d) => seen.push(d));
  hook({ url: "file:///etc/hostname" }, (d) => seen.push(d));
  hook({ url: REPORT_URL }, (d) => seen.push(d));
  const r = await p;
  assert.deepEqual(seen, [{ cancel: true }, { cancel: true }, {}]);
  assert.deepEqual(r.blocked, ["http://127.0.0.1:1/x", "file:///etc/hostname"]);
});

test("失敗しても窓は破棄され、次の要求は通る（1 件の失敗で後ろを止めない）", async () => {
  const f1 = fakes({ printFails: true });
  const r1 = await create(f1.deps)({ html: "x" });
  assert.deepEqual(r1, { ok: false, error: "render-failed" });
  assert.equal(f1.log.windows[0].destroyed, true);

  const { deps, log } = fakes();
  const render = create(deps);
  const bad = await render({ html: "" });
  assert.deepEqual(bad, { ok: false, error: "bad-request" });
  assert.equal(log.windows.length, 0);          // 検証で落ちたら窓を作らない
  assert.equal((await render({ html: "ok" })).ok, true);
});

test("読み込みが固まったら timeout で返り、窓を破棄する", async () => {
  const { deps, log } = fakes({ loadHangs: true, timeoutMs: 30 });
  const r = await create(deps)({ html: "x" });
  assert.deepEqual(r, { ok: false, error: "timeout" });
  assert.equal(log.windows[0].destroyed, true);
});

test("同時に走るのは 1 件（2 件目は 1 件目の窓が消えてから作る）", async () => {
  const { deps, log } = fakes();
  const render = create(deps);
  const a = render({ html: "a" });
  const b = render({ html: "b" });
  await Promise.all([a, b]);
  assert.deepEqual(log.events, ["new1", "destroy1", "new2", "destroy2"]);
});
