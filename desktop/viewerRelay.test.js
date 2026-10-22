const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createRelay, createJournal, journalParams } = require("./viewerRelay");

function fakeTarget() {
  const sent = [];
  return { sent, send: (ch, p) => sent.push([ch, p]), isDestroyed: () => false };
}

test("relay: result from the target window resolves; journal records the action", async () => {
  const t = fakeTarget();
  const log = [];
  const r = createRelay({ resolveTarget: () => t, journal: (e) => log.push(e), newId: () => "r1" });
  const p = r.relay("s1", { kind: "action", id: "setWindowLevel", params: { center: 40, width: 400 } });
  assert.deepStrictEqual(t.sent[0][1], { reqId: "r1", kind: "action", id: "setWindowLevel", params: { center: 40, width: 400 }, includeLabels: false });
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
