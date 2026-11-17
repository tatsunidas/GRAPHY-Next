// `node --test`。電子カルテ連携の main 側のロジック: いつ自動で開くか、トレイからの開き方。
const test = require("node:test");
const assert = require("node:assert");
const { decide, createWatcher, openNow } = require("./emrWatch");

const st = (over = {}) => ({
  enabled: true, valid: true, autoOpen: true, patient: { id: "P1", seq: 1 },
  fetch: { state: "idle", patientId: null, latestReady: false }, ...over,
});

test("decide: 最初の 1 回は基準として覚えるだけで、開かない（起動しただけで患者を開かない）", () => {
  assert.deepStrictEqual(decide(st(), null), { open: null, lastSeq: 1 });
  assert.deepStrictEqual(decide(st({ patient: null }), null), { open: null, lastSeq: 0 });
});

test("decide: 通し番号が進んだときだけ開く。同じ番号では開かない", () => {
  assert.deepStrictEqual(decide(st({ patient: { id: "P2", seq: 2 } }), 1), { open: "P2", lastSeq: 2 });
  assert.deepStrictEqual(decide(st({ patient: { id: "P2", seq: 2 } }), 2), { open: null, lastSeq: 2 });
  // 2 つ飛んで進んでも、いまの患者を 1 回だけ開く（途中の患者は開かない）
  assert.deepStrictEqual(decide(st({ patient: { id: "P4", seq: 4 } }), 1), { open: "P4", lastSeq: 4 });
});

test("decide: 自動で開かない設定・無効・設定の不備では開かない（番号は進める）", () => {
  const next = { patient: { id: "P2", seq: 2 } };
  assert.deepStrictEqual(decide(st({ ...next, autoOpen: false }), 1), { open: null, lastSeq: 2 });
  assert.deepStrictEqual(decide(st({ ...next, enabled: false }), 1), { open: null, lastSeq: 2 });
  assert.deepStrictEqual(decide(st({ ...next, valid: false }), 1), { open: null, lastSeq: 2 });
  assert.deepStrictEqual(decide(st({ patient: { id: "", seq: 2 } }), 1), { open: null, lastSeq: 2 });
});

test("decide: 状態が取れない間は何もしない（基準も変えない）。backend が作り直されて番号が戻ったら、基準を取り直す", () => {
  assert.deepStrictEqual(decide(null, 5), { open: null, lastSeq: 5 });
  assert.deepStrictEqual(decide(undefined, null), { open: null, lastSeq: null });
  assert.deepStrictEqual(decide(st({ patient: { id: "P9", seq: 1 } }), 7), { open: null, lastSeq: 1 });
});

function manualTimers() {
  const q = [];
  return { setTimer: (fn) => { q.push(fn); return q.length; }, clearTimer: () => {}, pending: () => q.length, run: async () => { const fn = q.shift(); if (fn) await fn(); } };
}

test("createWatcher: 患者が変わったときだけ onOpen。応答がない・例外でも止まらない", async () => {
  const timers = manualTimers();
  const responses = [st(), st(), null, "boom", st({ patient: { id: "P2", seq: 2 } }), st({ patient: { id: "P2", seq: 2 } })];
  const opened = [];
  const w = createWatcher({
    fetchStatus: async () => { const r = responses.shift(); if (r === "boom") throw new Error("x"); return r; },
    onOpen: (id) => opened.push(id),
    setTimer: timers.setTimer, clearTimer: timers.clearTimer,
  });
  w.start();
  for (let i = 0; i < 6; i++) await timers.run();
  assert.deepStrictEqual(opened, ["P2"]);
  assert.ok(timers.pending() >= 1, "次の周期が予約されている（止まらない）");
  w.stop();
  const before = opened.length;
  await timers.run();
  assert.strictEqual(opened.length, before);
});

test("createWatcher: onOpen が例外を投げても、監視は続く", async () => {
  const timers = manualTimers();
  const responses = [st(), st({ patient: { id: "P2", seq: 2 } }), st({ patient: { id: "P3", seq: 3 } })];
  const opened = [];
  const w = createWatcher({
    fetchStatus: async () => responses.shift(),
    onOpen: (id) => { opened.push(id); throw new Error("window gone"); },
    setTimer: timers.setTimer, clearTimer: timers.clearTimer,
  });
  w.start();
  for (let i = 0; i < 3; i++) await timers.run();
  assert.deepStrictEqual(opened, ["P2", "P3"]);
});

test("openNow: 取り込みが済んでいれば、取りに行かずに開く要求だけを送る", async () => {
  const calls = [];
  const r = await openNow({
    fetchStatus: async () => st({ fetch: { patientId: "P1", latestReady: true } }),
    postPrefetch: async () => calls.push("prefetch"),
    enqueue: (req) => calls.push(req),
  });
  assert.deepStrictEqual(r, { ok: true });
  assert.deepStrictEqual(calls, [{ ok: true, req: { patientId: "P1", latest: true } }]);
});

test("openNow: まだなら、取りに行かせてから開く要求を送る。別の患者の取り込み済みは、済みとみなさない", async () => {
  const calls = [];
  const r = await openNow({
    fetchStatus: async () => st({ fetch: { patientId: "OTHER", latestReady: true } }),
    postPrefetch: async () => calls.push("prefetch"),
    enqueue: (req) => calls.push(req.req.patientId),
  });
  assert.deepStrictEqual(r, { ok: true });
  assert.deepStrictEqual(calls, ["prefetch", "P1"]);
});

test("openNow: 無効・患者なし・backend に届かないときは、何も送らず理由を返す", async () => {
  const none = { postPrefetch: async () => assert.fail("取りに行かない"), enqueue: () => assert.fail("送らない") };
  assert.deepStrictEqual(await openNow({ ...none, fetchStatus: async () => null }), { ok: false, reason: "unavailable" });
  assert.deepStrictEqual(await openNow({ ...none, fetchStatus: async () => { throw new Error("x"); } }), { ok: false, reason: "unavailable" });
  assert.deepStrictEqual(await openNow({ ...none, fetchStatus: async () => st({ enabled: false }) }), { ok: false, reason: "disabled" });
  assert.deepStrictEqual(await openNow({ ...none, fetchStatus: async () => st({ valid: false }) }), { ok: false, reason: "disabled" });
  assert.deepStrictEqual(await openNow({ ...none, fetchStatus: async () => st({ patient: null }) }), { ok: false, reason: "no-patient" });
});
