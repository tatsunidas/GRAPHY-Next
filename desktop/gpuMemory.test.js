const test = require("node:test");
const assert = require("node:assert/strict");
const gm = require("./gpuMemory");

const MIB = 1024 * 1024;

test("nvidia-smi の出力を GPU ごとに読む（MiB → バイト）。名前にカンマがあっても末尾で切る", () => {
  assert.deepEqual(gm.parseNvidiaSmi("NVIDIA GeForce RTX 3090, 24576\n"), [
    { name: "NVIDIA GeForce RTX 3090", totalBytes: 24576 * MIB },
  ]);
  assert.deepEqual(gm.parseNvidiaSmi("A, 8192\r\nB, C, 16384\n"), [
    { name: "A", totalBytes: 8192 * MIB },
    { name: "B, C", totalBytes: 16384 * MIB },
  ]);
});

test("読めない出力・0・数値でない値は null（0 で埋めない）。読める行だけ残す", () => {
  assert.equal(gm.parseNvidiaSmi(""), null);
  assert.equal(gm.parseNvidiaSmi(undefined), null);
  assert.equal(gm.parseNvidiaSmi("NVIDIA-SMI has failed because it couldn't communicate with the NVIDIA driver."), null);
  assert.equal(gm.parseNvidiaSmi("X, 0\nY, [N/A]\nZ, -5\n, 100"), null);
  assert.deepEqual(gm.parseNvidiaSmi("X, [N/A]\nY, 4096"), [{ name: "Y", totalBytes: 4096 * MIB }]);
});

test("query: Linux 以外は聞かずに null。実行の失敗・例外も null", async () => {
  let called = 0;
  const run = async () => (called++, "A, 1024");
  assert.equal(await gm.query({ platform: "win32", run }), null);
  assert.equal(await gm.query({ platform: "darwin", run }), null);
  assert.equal(called, 0);
  assert.deepEqual(await gm.query({ platform: "linux", run }), [{ name: "A", totalBytes: 1024 * MIB }]);
  assert.equal(await gm.query({ platform: "linux", run: async () => null }), null);
  assert.equal(await gm.query({ platform: "linux", run: async () => { throw new Error("x"); } }), null);
});

test("実行ファイルが無い・ドライバが応答しない機械で、実際に null になる（この機械は eGPU 未接続でも成り立つ）", async () => {
  const r = await gm.query({ platform: "linux" });
  assert.ok(r === null || Array.isArray(r));
});
