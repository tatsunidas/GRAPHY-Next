const test = require("node:test");
const assert = require("node:assert/strict");
const { create } = require("./computeKeepAwake");

function fakeBlocker() {
  const started = new Set();
  let next = 1;
  return {
    started,
    start: (type) => { assert.equal(type, "prevent-app-suspension"); const id = next++; started.add(id); return id; },
    stop: (id) => { started.delete(id); },
    isStarted: (id) => started.has(id),
  };
}

test("止めるとブロッカーが 1 つ立ち、解除すると外れる", () => {
  const b = fakeBlocker();
  const k = create(b);
  assert.equal(k.active(), false);
  assert.equal(k.set(true), true);
  assert.equal(b.started.size, 1);
  assert.equal(k.set(false), false);
  assert.equal(b.started.size, 0);
});

test("🔴 何度止めても重ねて立てない（解除 1 回で必ず外れる）", () => {
  const b = fakeBlocker();
  const k = create(b);
  k.set(true); k.set(true); k.set(true);
  assert.equal(b.started.size, 1);
  k.set(false);
  assert.equal(b.started.size, 0);
  assert.equal(k.active(), false);
});

test("解除を何度呼んでも害は無い・立てる前の解除も安全", () => {
  const b = fakeBlocker();
  const k = create(b);
  assert.equal(k.set(false), false);
  k.set(true);
  k.set(false); k.set(false);
  assert.equal(b.started.size, 0);
});

test("OS 側で外れていたら、立て直す（active が嘘をつかない）", () => {
  const b = fakeBlocker();
  const k = create(b);
  k.set(true);
  b.started.clear(); // 外から外された
  assert.equal(k.active(), false);
  assert.equal(k.set(true), true);
  assert.equal(b.started.size, 1);
});
