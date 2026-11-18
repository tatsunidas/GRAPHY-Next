// `node --test`。2D ビューアの表示操作の履歴（元に戻す）・符号の許可リスト・連打の上限。設計: roadmap fw/mcp-server-design.md §6（段 4c-1）。
const test = require("node:test");
const assert = require("node:assert/strict");

const { createViewerControl, safeError, RATE, MAX_HISTORY } = require("./mcpViewerControl");

/** 2D 窓の偽物。操作ごとに逆操作を返し、呼ばれた命令を記録する。 */
function fakeViewer(over = {}) {
  const calls = [];
  const relay = async (sid, cmd) => {
    calls.push({ sid, cmd });
    if (over.reply) return over.reply(cmd, calls.length);
    return { ok: true, inverse: [{ id: "setWindowLevel", params: { center: 1, width: 2 } }] };
  };
  return { relay, calls };
}
const act = (id, params = {}) => ({ kind: "action", id, params });

test("control: 操作は 2D 窓へ mcp:<client> の action として渡り、結果に inverse は含まれない（履歴は main が持つ）", async () => {
  const v = fakeViewer();
  const c = createViewerControl({ relay: v.relay });
  const r = await c.run("claude-a", act("setWindowLevel", { center: 40, width: 400 }));
  assert.deepEqual(r, { ok: true, control: { applied: "setWindowLevel", undoDepth: 1 } });
  assert.equal(JSON.stringify(r).includes("inverse"), false);
  assert.deepEqual(v.calls[0], { sid: "mcp:claude-a", cmd: { kind: "action", id: "setWindowLevel", params: { center: 40, width: 400 } } });
});

test("control: undo は履歴を新しい順に戻し、逆操作を同じ口で再実行する。空なら nothing-to-undo", async () => {
  let n = 0;
  const v = fakeViewer({ reply: () => ({ ok: true, inverse: [{ id: "goToSlice", params: { index: n++ } }] }) });
  const c = createViewerControl({ relay: v.relay });
  await c.run("a", act("goToSlice", { index: 5 }));
  await c.run("a", act("goToSlice", { index: 9 }));
  v.calls.length = 0;
  const u1 = await c.run("a", { kind: "undo" });
  assert.deepEqual(u1, { ok: true, control: { undone: true, undoDepth: 1 } });
  assert.deepEqual(v.calls[0].cmd, { kind: "action", id: "goToSlice", params: { index: 1 } }); // 2 つ目の操作の逆（新しい順）
  await c.run("a", { kind: "undo" });
  assert.deepEqual(await c.run("a", { kind: "undo" }), { ok: false, error: "nothing-to-undo" });
});

test("control: 履歴は接続ごとに独立。上限を超えたら古いものから捨てる", async () => {
  const v = fakeViewer();
  const c = createViewerControl({ relay: v.relay, maxHistory: 3, rate: { max: 1000, windowMs: 1000 } });
  for (let i = 0; i < 5; i++) await c.run("a", act("flipH"));
  assert.equal(c.depth("a"), 3);
  assert.equal(c.depth("b"), 0);
  assert.deepEqual(await c.run("b", { kind: "undo" }), { ok: false, error: "nothing-to-undo" }); // 他の接続の操作は戻せない
  assert.equal(MAX_HISTORY, 20);
});

test("control: 負例 — 固定リストに無い操作（write・アシスタント専用）は窓へ送らない。履歴に紛れた偽の逆操作も実行しない", async () => {
  const v = fakeViewer();
  const c = createViewerControl({ relay: v.relay });
  for (const id of ["createRoi", "clearMeasurements", "createContourRoi", "removeAssistantRoi", "getState", "x"]) {
    assert.deepEqual(await c.run("a", act(id)), { ok: false, error: "viewer-failed" }, id);
  }
  assert.equal(v.calls.length, 0);
  // 2D 窓が（想定外に）write の逆操作を返しても、履歴に入れない（実行されない）
  const bad = fakeViewer({ reply: () => ({ ok: true, inverse: [{ id: "clearMeasurements", params: {} }, { id: "removeAssistantRoi", params: { roiUid: "x" } }] }) });
  const c2 = createViewerControl({ relay: bad.relay });
  const r = await c2.run("a", act("flipH"));
  assert.deepEqual(r, { ok: true, control: { applied: "flipH", undoDepth: 0 } });
  assert.deepEqual(await c2.run("a", { kind: "undo" }), { ok: false, error: "nothing-to-undo" });
});

test("control: 失敗は符号の許可リストだけ返す（例外の文・窓の本文は返さない）。no-viewer なら履歴を捨てる", async () => {
  const replies = [{ ok: false, error: "no-tile" }, { ok: false, error: "unknown-preset" }, { ok: false, error: "out-of-range:width" }, { ok: false, error: "exec-failed:YAMADA^TARO" }, { ok: false, error: "approval-required" }, null];
  let i = 0;
  const v = fakeViewer({ reply: () => replies[i++] });
  const c = createViewerControl({ relay: v.relay, rate: { max: 1000, windowMs: 1000 } });
  assert.deepEqual(await c.run("a", act("flipH")), { ok: false, error: "no-tile" });
  assert.deepEqual(await c.run("a", act("applyWlPreset", { name: "x" })), { ok: false, error: "unknown-preset" });
  assert.deepEqual(await c.run("a", act("setWindowLevel", { center: 1, width: 1 })), { ok: false, error: "out-of-range:width" });
  assert.deepEqual(await c.run("a", act("flipH")), { ok: false, error: "viewer-failed" }); // 本文を含み得る符号は丸める
  assert.deepEqual(await c.run("a", act("flipH")), { ok: false, error: "viewer-failed" });
  assert.deepEqual(await c.run("a", act("flipH")), { ok: false, error: "viewer-failed" });
  const thrower = createViewerControl({ relay: async () => { throw new Error("boom YAMADA"); } });
  assert.deepEqual(await thrower.run("a", act("flipH")), { ok: false, error: "viewer-failed" });
  // 窓が閉じたら、その接続の履歴は今の画面と合わないので捨てる
  let closed = false;
  const w = fakeViewer({ reply: () => (closed ? { ok: false, error: "no-viewer" } : { ok: true, inverse: [{ id: "flipH", params: {} }] }) });
  const c2 = createViewerControl({ relay: w.relay });
  await c2.run("a", act("flipH"));
  assert.equal(c2.depth("a"), 1);
  closed = true;
  assert.deepEqual(await c2.run("a", act("flipH")), { ok: false, error: "no-viewer" });
  assert.equal(c2.depth("a"), 0);
  assert.equal(safeError("exec-failed:x"), "viewer-failed");
  assert.equal(safeError("rate-limited"), "rate-limited");
});

test("control: 連打の上限（接続ごと）。窓が過ぎれば再び通る。別の接続には影響しない", async () => {
  let t = 1_000_000;
  const v = fakeViewer();
  const c = createViewerControl({ relay: v.relay, now: () => t });
  for (let i = 0; i < RATE.max; i++) assert.equal((await c.run("a", act("flipH"))).ok, true, `#${i}`);
  assert.deepEqual(await c.run("a", act("flipH")), { ok: false, error: "rate-limited" });
  assert.deepEqual(await c.run("a", { kind: "undo" }), { ok: false, error: "rate-limited" }); // undo も数える
  assert.equal((await c.run("b", act("flipH"))).ok, true);
  t += RATE.windowMs + 1;
  assert.equal((await c.run("a", act("flipH"))).ok, true);
  assert.equal(v.calls.length, RATE.max + 2);
});

test("control: clear — 受け口を止めたとき履歴を捨てる", async () => {
  const c = createViewerControl({ relay: fakeViewer().relay });
  await c.run("a", act("flipH"));
  await c.run("b", act("flipH"));
  c.clear("a");
  assert.equal(c.depth("a"), 0);
  assert.equal(c.depth("b"), 1);
  c.clear();
  assert.equal(c.depth("b"), 0);
});
