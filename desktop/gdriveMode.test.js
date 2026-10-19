// `node --test`。モード A の切替・解除の条件と、復元の見守り。
const test = require("node:test");
const assert = require("node:assert");
const { canSwitchMode, canDisable, watchRestore } = require("./gdriveMode");

const synced = { state: "CONNECTED", pending: 0, blocked: 0, evictedCount: 0, mode: "backup" };

test("backup → cache: 同期が済んでいるときだけ。未送信・止まった項目・接続状態が悪いときは断る（負例）", () => {
  assert.deepEqual(canSwitchMode("backup", "cache", synced), { ok: true });
  for (const [label, st] of [
    ["未送信", { ...synced, pending: 1 }],
    ["止まった項目", { ...synced, blocked: 1 }],
    ["同期中", { ...synced, state: "SYNCING" }],
    ["オフライン", { ...synced, state: "OFFLINE" }],
    ["要ログイン", { ...synced, state: "NEEDS_LOGIN" }],
  ]) {
    assert.deepEqual(canSwitchMode("backup", "cache", st), { ok: false, error: "not-synced" }, label);
  }
});

test("cache → backup: 追い出し済みが 0 件のときだけ（負例: 1 件でもあれば断る）", () => {
  assert.deepEqual(canSwitchMode("cache", "backup", { ...synced, mode: "cache", evictedCount: 0 }), { ok: true });
  assert.deepEqual(canSwitchMode("cache", "backup", { ...synced, mode: "cache", evictedCount: 1 }), { ok: false, error: "not-all-local" });
  assert.deepEqual(canSwitchMode("cache", "backup", { ...synced, mode: "cache", evictedCount: 4000 }), { ok: false, error: "not-all-local" });
});

test("状態が取れない・不明なモード・同じモードへの切替", () => {
  assert.deepEqual(canSwitchMode("backup", "cache", null), { ok: false, error: "backend-unavailable" });
  assert.deepEqual(canSwitchMode("cache", "backup", undefined), { ok: false, error: "backend-unavailable" });
  assert.deepEqual(canSwitchMode("backup", "mirror", synced), { ok: false, error: "invalid-mode" });
  assert.deepEqual(canSwitchMode("backup", "backup", null), { ok: true, noop: true }, "同じなら何もしない（状態を見ない）");
});

test("解除: モード B はいつでも。モード A は手元に無いファイルがあれば断り、状態が取れなくても断る", () => {
  assert.deepEqual(canDisable("backup", null), { ok: true });
  assert.deepEqual(canDisable("cache", { evictedCount: 0 }), { ok: true });
  assert.deepEqual(canDisable("cache", { evictedCount: 2 }), { ok: false, error: "not-all-local" });
  assert.deepEqual(canDisable("cache", null), { ok: false, error: "backend-unavailable" });
});

const noSleep = async () => {};

test("復元の見守り: DONE なら外さない／FAILED なら紐付けを外す（負例）／IDLE（入れ替わった）なら何もしない", async () => {
  let failed = 0;
  const seq = (...phases) => {
    let i = 0;
    return async () => ({ phase: phases[Math.min(i++, phases.length - 1)] });
  };
  assert.equal(await watchRestore({ getProgress: seq("RUNNING", "RUNNING", "DONE"), onFailed: () => failed++, sleep: noSleep }), "DONE");
  assert.equal(failed, 0, "完了したら外さない");
  assert.equal(await watchRestore({ getProgress: seq("RUNNING", "FAILED"), onFailed: () => failed++, sleep: noSleep }), "FAILED");
  assert.equal(failed, 1, "失敗したら外す");
  assert.equal(await watchRestore({ getProgress: seq("RUNNING", "IDLE"), onFailed: () => failed++, sleep: noSleep }), "STOPPED");
  assert.equal(failed, 1, "判断できないときは外さない");
});

test("復元の見守り: 一時的に取れなくても続け、上限回数で諦める（無限に見ない）", async () => {
  let n = 0;
  const flaky = async () => {
    n++;
    if (n < 3) throw new Error("backend 再起動中");
    if (n === 3) return null;
    return { phase: "DONE" };
  };
  assert.equal(await watchRestore({ getProgress: flaky, onFailed: () => {}, sleep: noSleep }), "DONE");
  let calls = 0;
  const never = async () => {
    calls++;
    return { phase: "RUNNING" };
  };
  assert.equal(await watchRestore({ getProgress: never, onFailed: () => {}, sleep: noSleep, maxPolls: 5 }), "STOPPED");
  assert.equal(calls, 5);
});
