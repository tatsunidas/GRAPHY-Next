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

test("control: 負例 — 固定リストに無い操作（アシスタント専用・読み取り）は窓へ送らない。write は allowEdit なしでは窓へ送らない。履歴に紛れた偽の逆操作も実行しない", async () => {
  const v = fakeViewer();
  const c = createViewerControl({ relay: v.relay });
  for (const id of ["removeAssistantRoi", "getState", "getMeasurements", "captureView", "pluginTool", "x"]) {
    assert.deepEqual(await c.run("a", act(id), { allowEdit: true, confirm: async () => true }), { ok: false, error: "viewer-failed" }, id);
  }
  for (const id of ["createRoi", "clearMeasurements", "createContourRoi"]) {
    assert.deepEqual(await c.run("a", act(id)), { ok: false, error: "edit-disabled" }, id); // 許可なし
    assert.deepEqual(await c.run("a", act(id), { allowEdit: false, confirm: async () => true }), { ok: false, error: "edit-disabled" }, id);
  }
  assert.equal(v.calls.length, 0);
  // 2D 窓が（想定外に）write の逆操作を返しても、履歴に入れない（実行されない）
  const bad = fakeViewer({ reply: () => ({ ok: true, inverse: [{ id: "clearMeasurements", params: {} }, { id: "createRoi", params: {} }, { id: "getState", params: {} }] }) });
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

// ---- 段 4c-2a: ROI の作成・計測の全削除（allowViewerEdit。実行のたびに利用者へ確認）----
const writeCtx = (confirm, extra = {}) => ({ allowEdit: true, confirm, ...extra });

test("control(write): 承認の閉包が呼ばれ（id と引数）、承認で実行される。逆操作 removeAssistantRoi は履歴に入り、undo でだけ再実行される", async () => {
  const asked = [];
  const v = fakeViewer({ reply: (cmd) => (cmd.id === "createRoi" ? { ok: true, inverse: [{ id: "removeAssistantRoi", params: { roiUid: "roi-1" } }] } : { ok: true }) });
  // viewerRelay の契約: write は opts.confirm(id) が true のときだけ本実行。ここは relay の偽物として confirm を呼んで確かめる
  const relay = async (sid, cmd, opts) => {
    if (opts && typeof opts.confirm === "function" && !(await opts.confirm(cmd.id))) return { ok: false, error: "declined" };
    return v.relay(sid, cmd, opts);
  };
  const c = createViewerControl({ relay });
  const params = { shape: "ellipse", u: 0.5, v: 0.5, radiusXmm: 20, radiusYmm: 10 };
  const r = await c.run("a", act("createRoi", params), writeCtx(async (id, p) => { asked.push({ id, p }); return true; }));
  assert.deepEqual(r, { ok: true, control: { applied: "createRoi", undoDepth: 1 } });
  assert.deepEqual(asked, [{ id: "createRoi", p: params }]);
  assert.equal(JSON.stringify(r).includes("roi-1"), false); // roiUid（逆操作）はクライアントへ返さない
  v.calls.length = 0;
  const u = await c.run("a", { kind: "undo" });
  assert.deepEqual(u, { ok: true, control: { undone: true, undoDepth: 0 } });
  assert.deepEqual(v.calls[0].cmd, { kind: "action", id: "removeAssistantRoi", params: { roiUid: "roi-1" } }); // この ROI だけ消す
  assert.deepEqual(v.calls[0].opts ?? {}, {}); // 消す側に確認は要らない（write ではない）
});

test("control(write): 拒否（declined）・確認の閉包なし・例外は実行されない。履歴も増えない", async () => {
  let executed = 0;
  const relay = async (sid, cmd, opts) => {
    // viewerRelay の契約: 確認が例外でも承認なし（declined）に丸める
    const approved = await Promise.resolve(opts && typeof opts.confirm === "function" ? opts.confirm(cmd.id) : false).then((v) => v === true, () => false);
    if (!approved) return { ok: false, error: "declined" };
    executed++;
    return { ok: true, inverse: [{ id: "removeAssistantRoi", params: { roiUid: "r" } }] };
  };
  const c = createViewerControl({ relay, rate: { max: 1000, windowMs: 1000 } });
  assert.deepEqual(await c.run("a", act("createRoi", {}), writeCtx(async () => false)), { ok: false, error: "declined" });
  assert.deepEqual(await c.run("a", act("createRoi", {}), { allowEdit: true }), { ok: false, error: "declined" }); // 閉包が無ければ取り消し側
  assert.deepEqual(await c.run("a", act("clearMeasurements", {}), writeCtx(async () => { throw new Error("dialog failed"); })), { ok: false, error: "declined" });
  assert.equal(executed, 0);
  assert.equal(c.depth("a"), 0);
});

test("control(write): clearMeasurements は元に戻せない（履歴に積まず irreversible）。ROI の作成の失敗は roi-* の符号で返る", async () => {
  const replies = [{ ok: true }, { ok: false, error: "roi-off-slice" }, { ok: false, error: "self-intersecting:points" }, { ok: false, error: "degenerate:points" }, { ok: false, error: "roi-evil:YAMADA" }, { ok: false, error: "approval-required" }, { ok: false, error: "not-removable" }];
  let i = 0;
  const c = createViewerControl({ relay: async () => replies[i++], rate: { max: 1000, windowMs: 1000 } });
  const ctx = writeCtx(async () => true);
  assert.deepEqual(await c.run("a", act("clearMeasurements"), ctx), { ok: true, control: { applied: "clearMeasurements", undoDepth: 0, irreversible: true } });
  assert.equal(c.depth("a"), 0);
  assert.deepEqual(await c.run("a", act("createRoi", {}), ctx), { ok: false, error: "roi-off-slice" });
  assert.deepEqual(await c.run("a", act("createContourRoi", {}), ctx), { ok: false, error: "self-intersecting:points" });
  assert.deepEqual(await c.run("a", act("createContourRoi", {}), ctx), { ok: false, error: "degenerate:points" });
  assert.deepEqual(await c.run("a", act("createRoi", {}), ctx), { ok: false, error: "viewer-failed" }); // 理由が固定の 10 個に無い → 本文を返さない
  assert.deepEqual(await c.run("a", act("createRoi", {}), ctx), { ok: false, error: "viewer-failed" }); // approval-required は出ないはず（出たら不具合）
  assert.deepEqual(await c.run("a", act("createRoi", {}), ctx), { ok: false, error: "not-removable" });
  assert.deepEqual(await c.run("a", { kind: "undo" }), { ok: false, error: "nothing-to-undo" });
});

test("control(write): 逆操作の履歴に入れてよいのは表示の 10 種と removeAssistantRoi だけ（createRoi など write を undo で再実行しない）", async () => {
  const bad = fakeViewer({ reply: () => ({ ok: true, inverse: [{ id: "createRoi", params: {} }, { id: "clearMeasurements", params: {} }, { id: "removeAssistantRoi", params: { roiUid: "r1" } }, { id: "flipH", params: {} }] }) });
  const c = createViewerControl({ relay: bad.relay });
  await c.run("a", act("flipH"));
  bad.calls.length = 0;
  await c.run("a", { kind: "undo" });
  assert.deepEqual(bad.calls.map((x) => x.cmd.id), ["removeAssistantRoi", "flipH"]);
});
