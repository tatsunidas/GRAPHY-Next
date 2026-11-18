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

test("空き量: 名前・空き・搭載を MiB からバイトにする。名前にカンマがあっても末尾の 2 列から切る。読めない行は捨てる", () => {
  assert.deepEqual(gm.parseNvidiaSmiFree("NVIDIA GeForce GTX 1050 Ti, 3981, 4096\n"), [
    { name: "NVIDIA GeForce GTX 1050 Ti", freeBytes: 3981 * MIB, totalBytes: 4096 * MIB },
  ]);
  assert.deepEqual(gm.parseNvidiaSmiFree("A, B, 100, 200\r\n"), [{ name: "A, B", freeBytes: 100 * MIB, totalBytes: 200 * MIB }]);
  assert.equal(gm.parseNvidiaSmiFree(""), null);
  assert.equal(gm.parseNvidiaSmiFree(undefined), null);
  assert.equal(gm.parseNvidiaSmiFree("X, [N/A], 4096"), null);
  assert.equal(gm.parseNvidiaSmiFree("X, 100, 0"), null);
  assert.equal(gm.parseNvidiaSmiFree("X, 100"), null);
  assert.equal(gm.parseNvidiaSmiFree(", 100, 200"), null);
  assert.equal(gm.parseNvidiaSmiFree("NVIDIA-SMI has failed because it couldn't communicate with the NVIDIA driver."), null);
  assert.equal(gm.parseNvidiaSmiFree("X, 1, 2\nbad\nY, 0, 8192").length, 2); // 空きが 0 の GPU は残す（実際に空きが無い）
});

test("queryFree: Linux 以外は聞かずに null。失敗・例外も null", async () => {
  let called = 0;
  const run = async () => (called++, "A, 100, 200");
  assert.equal(await gm.queryFree({ platform: "win32", run }), null);
  assert.equal(await gm.queryFree({ platform: "darwin", run }), null);
  assert.equal(called, 0);
  assert.equal((await gm.queryFree({ platform: "linux", run }))[0].freeBytes, 100 * MIB);
  assert.equal(await gm.queryFree({ platform: "linux", run: async () => null }), null);
  assert.equal(await gm.queryFree({ platform: "linux", run: async () => { throw new Error("x"); } }), null);
});
