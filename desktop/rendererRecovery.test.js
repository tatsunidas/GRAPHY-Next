const test = require("node:test");
const assert = require("node:assert/strict");
const { createRecovery, describe } = require("./rendererRecovery");

test("clean-exit は何もしない", () => {
  const r = createRecovery();
  assert.equal(r.onGone(1, "clean-exit").action, "ignore");
  assert.equal(r.onGone(1, "clean-exit").action, "ignore");
});

test("crashed・oom・killed などは読み込み直す", () => {
  for (const reason of ["crashed", "oom", "abnormal-exit", "killed", "launch-failed", "integrity-failure"]) {
    assert.equal(createRecovery().onGone(1, reason).action, "reload", reason);
  }
});

test("読み込みを終える前にまた落ちたら諦める（歯止め）。諦めたあとは次の落ちで読み込み直す", () => {
  const r = createRecovery();
  assert.equal(r.onGone(1, "crashed").action, "reload");
  assert.equal(r.onGone(1, "crashed").action, "giveup");
  assert.equal(r.onGone(1, "crashed").action, "reload", "諦めた後に利用者が開き直した場合などは新しい 1 回目");
});

test("読み込みを終えたあとの落ちは、新しい 1 回目として読み込み直す", () => {
  const r = createRecovery();
  assert.equal(r.onGone(1, "oom").action, "reload");
  r.onLoaded(1);
  assert.equal(r.onGone(1, "oom").action, "reload");
});

test("窓ごとに独立。閉じたら忘れる", () => {
  const r = createRecovery();
  assert.equal(r.onGone(1, "crashed").action, "reload");
  assert.equal(r.onGone(2, "crashed").action, "reload", "別の窓の状態を引きずらない");
  r.forget(1);
  assert.equal(r.onGone(1, "crashed").action, "reload");
});

test("clean-exit は読み込み直しの待ちを変えない", () => {
  const r = createRecovery();
  r.onGone(1, "crashed");
  assert.equal(r.onGone(1, "clean-exit").action, "ignore");
  assert.equal(r.onGone(1, "crashed").action, "giveup");
});

test("describe: Colab があれば解放の選択肢が付く（既定は「そのまま」）", () => {
  const a = describe({ giveup: false, colab: true });
  assert.deepEqual(a.buttons, ["そのまま", "GPU を解放する"]);
  assert.equal(a.releaseIndex, 1);
  assert.match(a.detail, /Colab/);
  const b = describe({ giveup: false, colab: false });
  assert.deepEqual(b.buttons, ["OK"]);
  assert.equal(b.releaseIndex, -1);
  assert.doesNotMatch(b.detail, /Colab/);
  assert.match(describe({ giveup: true, colab: false }).message, /続けて/);
});
