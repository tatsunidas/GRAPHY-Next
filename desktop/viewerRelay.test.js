const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { WRITE_ACTIONS, createRelay, createJournal, journalParams, readJournal } = require("./viewerRelay");

function fakeTarget() {
  const sent = [];
  return { sent, send: (ch, p) => sent.push([ch, p]), isDestroyed: () => false };
}

test("relay: result from the target window resolves; journal records the action", async () => {
  const t = fakeTarget();
  const log = [];
  const r = createRelay({ resolveTarget: () => t, journal: (e) => log.push(e), newId: () => "r1" });
  const p = r.relay("s1", { kind: "action", id: "setWindowLevel", params: { center: 40, width: 400 } });
  assert.deepStrictEqual(t.sent[0][1], { reqId: "r1", kind: "action", id: "setWindowLevel", params: { center: 40, width: 400 }, includeLabels: false, approved: false });
  assert.strictEqual(r.handleResult(t, "r1", { ok: true }), true);
  assert.deepStrictEqual(await p, { ok: true });
  assert.strictEqual(log.length, 1);
  assert.deepStrictEqual(log[0].params, { center: 40, width: 400 });
  assert.strictEqual(log[0].ok, true);
  assert.strictEqual(r.pendingCount(), 0);
});

test("relay: no viewer window -> no-viewer (negative)", async () => {
  const r = createRelay({ resolveTarget: () => null });
  assert.deepStrictEqual(await r.relay("s", { kind: "getState" }), { ok: false, error: "no-viewer" });
  const dead = { send() {}, isDestroyed: () => true };
  const r2 = createRelay({ resolveTarget: () => dead });
  assert.deepStrictEqual(await r2.relay("s", { kind: "getState" }), { ok: false, error: "no-viewer" });
});

test("relay: a result from another window is ignored (negative) and the request times out", async () => {
  const t = fakeTarget();
  const other = fakeTarget();
  const r = createRelay({ resolveTarget: () => t, newId: () => "r2", timeoutMs: 40 });
  const p = r.relay("s", { kind: "getState" });
  assert.strictEqual(r.handleResult(other, "r2", { ok: true, state: { fake: 1 } }), false);
  assert.deepStrictEqual(await p, { ok: false, error: "timeout" });
  assert.strictEqual(r.pendingCount(), 0);
  assert.strictEqual(r.handleResult(t, "r2", { ok: true }), false); // 期限後・未知の reqId
});

test("relay: malformed commands and results", async () => {
  const t = fakeTarget();
  const r = createRelay({ resolveTarget: () => t, newId: () => "r3" });
  assert.deepStrictEqual(await r.relay("s", null), { ok: false, error: "bad-command" });
  assert.deepStrictEqual(await r.relay("s", { kind: "evil" }), { ok: false, error: "bad-command" });
  assert.deepStrictEqual(await r.relay("s", { kind: "action", id: 5 }), { ok: false, error: "bad-command" });
  assert.strictEqual(t.sent.length, 0);
  const p = r.relay("s", { kind: "getState" });
  r.handleResult(t, "r3", "garbage");
  assert.deepStrictEqual(await p, { ok: false, error: "bad-result" });
});

test("journalParams keeps primitives only and never objects", () => {
  assert.deepStrictEqual(journalParams({ a: 1, b: "x", c: true, d: { z: 1 }, e: [1], f: NaN }), { a: 1, b: "x", c: true });
  assert.strictEqual(journalParams(null), undefined);
});

test("journal appends jsonl and rotates one generation", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gj-"));
  const file = path.join(dir, "j.jsonl");
  const j = createJournal({ file, maxBytes: 200 });
  for (let i = 0; i < 6; i++) j({ sessionId: "s", kind: "action", id: "flipH", ok: true });
  assert.ok(fs.existsSync(file) && fs.existsSync(`${file}.1`));
  const lines = fs.readFileSync(file, "utf8").trim().split("\n");
  assert.ok(lines.every((l) => JSON.parse(l).id === "flipH"));
  fs.rmSync(dir, { recursive: true });
});

test("journal write failure does not throw", () => {
  // 親がファイルなので mkdir できない（/proc 配下などは mkdir が戻らないことがあるので使わない）
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gj-"));
  const blocker = path.join(dir, "blocker");
  fs.writeFileSync(blocker, "x");
  const j = createJournal({ file: path.join(blocker, "sub", "j.jsonl") });
  assert.doesNotThrow(() => j({ a: 1 }));
  fs.rmSync(dir, { recursive: true });
});

test("readJournal: 新しい順・件数上限・壊れた行と未知のフィールドは落とす。ファイル無しは空", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "jr-")), "j.jsonl");
  assert.deepStrictEqual(readJournal({ file }), { ok: true, entries: [] });
  const lines = [
    JSON.stringify({ ts: "t1", id: "invert", params: {}, ok: true }),
    "{ broken",
    JSON.stringify({ ts: "t2", id: "goToSlice", params: { index: 3, o: { x: 1 } }, ok: false, error: "out-of-range", sessionId: "secret-session" }),
    JSON.stringify({ ts: "t3", noId: true }),
  ];
  fs.writeFileSync(file, lines.join("\n") + "\n");
  const r = readJournal({ file });
  assert.deepStrictEqual(r.entries.map((e) => e.id), ["goToSlice", "invert"]);
  assert.deepStrictEqual(r.entries[0], { ts: "t2", id: "goToSlice", params: { index: 3 }, ok: false, error: "out-of-range" });
  assert.equal("sessionId" in r.entries[0], false);
  assert.equal(readJournal({ file, limit: 1 }).entries.length, 1);
});

test("write 操作: 承認すると approved:true で 2D 窓へ届く。承認の関数が無い・拒否・例外では 2D 窓へ送らない", async () => {
  assert.ok(WRITE_ACTIONS.has("clearMeasurements"));
  const cmd = { kind: "action", id: "clearMeasurements", params: {}, approved: true /* レンダラが付けてきた値は無視される */ };
  // 正例
  const t = fakeTarget();
  const log = [];
  const r = createRelay({ resolveTarget: () => t, journal: (e) => log.push(e), newId: () => "w1" });
  const p = r.relay("s", cmd, { confirm: async (id) => id === "clearMeasurements" });
  await new Promise((res) => setImmediate(res));
  assert.deepStrictEqual(t.sent[0][1], { reqId: "w1", kind: "action", id: "clearMeasurements", params: {}, includeLabels: false, approved: true });
  r.handleResult(t, "w1", { ok: true });
  assert.deepStrictEqual(await p, { ok: true });
  // 負例: 拒否 / 関数なし / 例外 / true 以外の値
  for (const opts of [{ confirm: async () => false }, {}, { confirm: async () => { throw new Error("x"); } }, { confirm: async () => "yes" }]) {
    const t2 = fakeTarget();
    const log2 = [];
    const r2 = createRelay({ resolveTarget: () => t2, journal: (e) => log2.push(e) });
    assert.deepStrictEqual(await r2.relay("s", cmd, opts), { ok: false, error: "declined" });
    assert.strictEqual(t2.sent.length, 0, "承認されなければ 2D 窓へ送らない");
    assert.strictEqual(log2[0].error, "declined");
  }
});

test("表示操作は承認を求めず approved:false で届く（レンダラが approved を付けても捨てる）", async () => {
  const t = fakeTarget();
  let asked = 0;
  const r = createRelay({ resolveTarget: () => t, newId: () => "d1" });
  const p = r.relay("s", { kind: "action", id: "flipH", params: {}, approved: true }, { confirm: async () => { asked++; return true; } });
  assert.strictEqual(t.sent[0][1].approved, false);
  assert.strictEqual(asked, 0);
  r.handleResult(t, "d1", { ok: true });
  await p;
});

// ---- プラグインのツール ----
const ENTRY = { name: "plugin__demo__measure", pluginId: "demo", pluginName: "DEMO", tool: "measure" };
const ptOpts = (over = {}) => ({ pluginTools: { lookup: (n) => (n === ENTRY.name ? ENTRY : null), external: false, confirmSend: async () => true, ...over } });

test("pluginTool: main の一覧にある名前だけ 2D 窓へ届き、pluginId/tool は main の値。結果は untrusted で包まれ、ジャーナルに内容が残らない", async () => {
  const t = fakeTarget();
  const log = [];
  const r = createRelay({ resolveTarget: () => t, journal: (e) => log.push(e), newId: () => "p1" });
  // レンダラが偽の pluginId/tool を付けても使われない
  const p = r.relay("s", { kind: "pluginTool", name: ENTRY.name, pluginId: "evil", tool: "x", params: { label: "a" } }, ptOpts());
  await new Promise((res) => setImmediate(res));
  assert.deepStrictEqual(t.sent[0][1], { reqId: "p1", kind: "pluginTool", pluginId: "demo", tool: "measure", params: { label: "a" } });
  r.handleResult(t, "p1", { ok: true, data: { patientName: "SECRET^NAME", n: 3 } });
  const res = await p;
  assert.deepStrictEqual(res, { ok: true, source: "plugin:demo", untrusted: true, data: { patientName: "SECRET^NAME", n: 3 } });
  assert.strictEqual(log.length, 1);
  assert.strictEqual(log[0].kind, "pluginTool");
  assert.strictEqual(log[0].id, "demo:measure");
  assert.ok(!JSON.stringify(log).includes("SECRET"), "ジャーナルに結果の中身を残さない");
});

test("pluginTool: 一覧に無い名前・一覧関数なし・引数が大きすぎる・配列は 2D 窓へ送らない（負例）", async () => {
  for (const [cmd, opts] of [
    [{ kind: "pluginTool", name: "plugin__other__x", params: {} }, ptOpts()],
    [{ kind: "pluginTool", name: ENTRY.name, params: {} }, {}],
    [{ kind: "pluginTool", name: ENTRY.name, params: { s: "x".repeat(3000) } }, ptOpts()],
    [{ kind: "pluginTool", name: ENTRY.name, params: [1] }, ptOpts()],
    [{ kind: "pluginTool", name: 5, params: {} }, ptOpts()],
  ]) {
    const t = fakeTarget();
    const r = createRelay({ resolveTarget: () => t });
    const res = await r.relay("s", cmd, opts);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(t.sent.length, 0);
  }
});

test("pluginTool: 外部宛ては承認が要る。拒否・例外・true 以外・関数なしでは結果を返さない。承認は session×plugin で 1 回", async () => {
  const run = async (confirmSend, extra = {}) => {
    const t = fakeTarget();
    let n = 0;
    const r = createRelay({ resolveTarget: () => t, newId: () => `q${++n}` });
    const call = async () => {
      const p = r.relay("s", { kind: "pluginTool", name: ENTRY.name, params: {} }, ptOpts({ external: true, confirmSend, ...extra }));
      await new Promise((res) => setImmediate(res));
      r.handleResult(t, `q${n}`, { ok: true, data: { v: 1 } });
      return p;
    };
    return { call };
  };
  for (const bad of [async () => false, async () => { throw new Error("x"); }, async () => "yes", undefined]) {
    const { call } = await run(bad);
    assert.deepStrictEqual(await call(), { ok: false, error: "declined" });
  }
  let asked = 0;
  const { call } = await run(async (_e, preview) => { asked++; assert.ok(preview.length <= 200); return true; });
  assert.strictEqual((await call()).ok, true);
  assert.strictEqual((await call()).ok, true);
  assert.strictEqual(asked, 1, "同じセッション×プラグインでは 2 回目から聞かない");
});

test("pluginTool: 2D 窓のエラーは data を持たず ok:false で返る。他窓の結果は無視", async () => {
  const t = fakeTarget();
  const other = fakeTarget();
  const r = createRelay({ resolveTarget: () => t, newId: () => "e1" });
  const p = r.relay("s", { kind: "pluginTool", name: ENTRY.name, params: {} }, ptOpts());
  await new Promise((res) => setImmediate(res));
  assert.strictEqual(r.handleResult(other, "e1", { ok: true, data: { fake: 1 } }), false);
  r.handleResult(t, "e1", { ok: false, error: "plugin-error" });
  assert.deepStrictEqual(await p, { ok: false, error: "plugin-error" });
});
