const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const rp = require("./renderPrefs");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "render-prefs-"));

test("壊れた JSON・知らない値・無いファイルは既定（auto）に倒れる", () => {
  assert.deepEqual(rp.parse("{"), { gpu: "auto" });
  assert.deepEqual(rp.parse(""), { gpu: "auto" });
  assert.deepEqual(rp.parse('{"gpu":"nvidia"}'), { gpu: "auto" });
  assert.deepEqual(rp.parse('{"gpu":42}'), { gpu: "auto" });
  assert.deepEqual(rp.parse("null"), { gpu: "auto" });
  assert.deepEqual(rp.load(path.join(tmp(), "none")), { gpu: "auto" });
});

test("保存して読み戻せる。知らない値は保存しない", () => {
  const d = tmp();
  assert.equal(rp.save(d, { gpu: "high" }), true);
  assert.deepEqual(rp.load(d), { gpu: "high" });
  assert.equal(rp.save(d, { gpu: "bogus" }), false);
  assert.deepEqual(rp.load(d), { gpu: "high" }, "不正な値で上書きされない");
  assert.equal(rp.save(d, { gpu: "auto" }), true);
  assert.deepEqual(rp.load(d), { gpu: "auto" });
  assert.deepEqual(fs.readdirSync(d), [rp.FILE], "一時ファイルが残らない");
});

test("書けないフォルダでは false を返し、例外を投げない", () => {
  assert.equal(rp.save(path.join(tmp(), "no", "such", "dir"), { gpu: "high" }), false);
});

test("supported: GPU が 2 つ未満なら全 OS で出さない（単一 GPU の負例）", () => {
  for (const platform of ["linux", "win32", "darwin"]) {
    assert.equal(rp.supported({ platform, devices: [{}], nvidiaGpuCount: 1 }), false, platform);
    assert.equal(rp.supported({ platform, devices: [], nvidiaGpuCount: 1 }), false, platform);
  }
});

test("supported: 2 つ以上なら出す。Linux は NVIDIA が GPU を持つときだけ", () => {
  const two = [{}, {}];
  assert.equal(rp.supported({ platform: "win32", devices: two, nvidiaGpuCount: 0 }), true);
  assert.equal(rp.supported({ platform: "darwin", devices: two, nvidiaGpuCount: 0 }), true);
  assert.equal(rp.supported({ platform: "linux", devices: two, nvidiaGpuCount: 1 }), true);
  assert.equal(rp.supported({ platform: "linux", devices: two, nvidiaGpuCount: 0 }), false, "外付け GPU を外した起動");
  assert.equal(rp.supported({ platform: "freebsd", devices: two, nvidiaGpuCount: 1 }), false);
});

test("applyPlan: auto では何も付けない", () => {
  for (const platform of ["linux", "win32", "darwin"]) {
    assert.deepEqual(rp.applyPlan({ gpu: "auto" }, { platform, nvidiaPresent: true }), { env: {}, switches: [] });
  }
});

test("applyPlan: Linux は PRIME オフロードの環境変数 2 つ。NVIDIA が無ければ付けない", () => {
  assert.deepEqual(rp.applyPlan({ gpu: "high" }, { platform: "linux", nvidiaPresent: true }), {
    env: { __NV_PRIME_RENDER_OFFLOAD: "1", __GLX_VENDOR_LIBRARY_NAME: "nvidia" },
    switches: [],
  });
  assert.deepEqual(rp.applyPlan({ gpu: "high" }, { platform: "linux", nvidiaPresent: false }), { env: {}, switches: [] });
});

test("applyPlan: Windows・macOS は force_high_performance_gpu のスイッチ（環境変数は付けない）", () => {
  for (const platform of ["win32", "darwin"]) {
    assert.deepEqual(rp.applyPlan({ gpu: "high" }, { platform, nvidiaPresent: false }), { env: {}, switches: ["force_high_performance_gpu"] }, platform);
  }
});

test("applyPlan: 知らない OS・prefs が無いときは何も付けない", () => {
  assert.deepEqual(rp.applyPlan({ gpu: "high" }, { platform: "freebsd", nvidiaPresent: true }), { env: {}, switches: [] });
  assert.deepEqual(rp.applyPlan(null, { platform: "linux", nvidiaPresent: true }), { env: {}, switches: [] });
});

test("nvidiaGpuCount: ある場所の数を数え、無い場所は 0", () => {
  const d = tmp();
  assert.equal(rp.nvidiaGpuCount(path.join(d, "none")), 0);
  fs.mkdirSync(path.join(d, "0000:05:00.0"));
  assert.equal(rp.nvidiaGpuCount(d), 1);
});
