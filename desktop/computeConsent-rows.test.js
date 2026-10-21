const test = require("node:test");
const assert = require("node:assert/strict");
const { buildRows } = require("./computeConsent-rows.js");

const ds = (n, bytes = 1000) => ({ handle: "dsh_" + n, format: "npz", bytes, sha256: String(n).repeat(64).slice(0, 64), instances: 3, burnedInstances: 0, modality: "CT" });

test("対話の 1 回（組なし）は今までと同じ平らな行で、組の列は付かない", () => {
  const r = buildRows({ datasets: [ds(1), ds(2)], items: null });
  assert.equal(r.batch, false);
  assert.equal(r.rows.length, 2);
  assert.ok(r.rows.every((x) => x.key === null && !x.noInput));
  assert.equal(r.totalBytes, 2000);
  assert.deepEqual(r.refused, []);
});

test("データが 0 件の対話の 1 回は行なし（画面は『なし』を出す）", () => {
  const r = buildRows({ datasets: [], items: null });
  assert.equal(r.rows.length, 0);
  assert.equal(r.batch, false);
});

test("一括は組ごとにまとめ、組名は組の最初の行にだけ付く", () => {
  const items = [
    { key: "a", datasets: [ds(1), ds(2)] },
    { key: "b", datasets: [ds(3)] },
  ];
  const r = buildRows({ datasets: items.flatMap((i) => i.datasets), items });
  assert.equal(r.batch, true);
  assert.equal(r.itemCount, 2);
  assert.equal(r.datasetCount, 3);
  assert.deepEqual(r.rows.map((x) => x.key), ["a", "", "b"]);
  assert.equal(r.totalBytes, 3000);
});

test("入力が無い組も 1 行出す（黙って消さない）", () => {
  const items = [{ key: "a", datasets: [ds(1)] }, { key: "empty", datasets: [] }];
  const r = buildRows({ datasets: [ds(1)], items });
  assert.equal(r.rows.length, 2);
  assert.deepEqual(r.rows[1], { key: "empty", noInput: true, d: null });
  assert.equal(r.itemCount, 2);
});

test("送らなかった組は理由つきで返す", () => {
  const items = [{ key: "a", datasets: [ds(1)] }];
  const r = buildRows({ datasets: [ds(1)], items, refused: [{ key: "x", reason: "burned-in-unremovable", extra: "無視される" }] });
  assert.deepEqual(r.refused, [{ key: "x", reason: "burned-in-unremovable" }]);
});

test("refused が無い一括でも落ちない", () => {
  const r = buildRows({ datasets: [], items: [{ key: "a", datasets: [] }] });
  assert.deepEqual(r.refused, []);
});
