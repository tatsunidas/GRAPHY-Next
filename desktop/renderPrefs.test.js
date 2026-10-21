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

const drm = (cards) => {
  const d = tmp();
  for (const [name, vendor, boot] of cards) {
    const dev = path.join(d, name, "device");
    fs.mkdirSync(dev, { recursive: true });
    if (vendor) fs.writeFileSync(path.join(dev, "vendor"), `${vendor}\n`);
    if (boot !== undefined) fs.writeFileSync(path.join(dev, "boot_vga"), `${boot}\n`);
  }
  return d;
};

test("amdGpuPresent: 表示を担っていない AMD があれば true", () => {
  assert.equal(rp.amdGpuPresent(drm([["card0", "0x8086", 1], ["card1", "0x1002", 0]])), true, "Intel が表示、AMD の dGPU");
  assert.equal(rp.amdGpuPresent(drm([["card0", "0x1002", 0]])), true, "boot_vga が無いカードも対象");
  assert.equal(rp.amdGpuPresent(drm([["card0", "0x1002"]])), true);
});

test("amdGpuPresent: 負例（AMD が表示側だけ・AMD 無し・読めない・card 以外）", () => {
  assert.equal(rp.amdGpuPresent(drm([["card0", "0x1002", 1]])), false, "AMD が表示を担う側だけ");
  assert.equal(rp.amdGpuPresent(drm([["card0", "0x8086", 1], ["card1", "0x10de", 0]])), false, "Intel と NVIDIA");
  assert.equal(rp.amdGpuPresent(drm([["card0", null, 0]])), false, "vendor が読めない");
  assert.equal(rp.amdGpuPresent(drm([["renderD128", "0x1002", 0], ["card0-DP-1", "0x1002", 0]])), false, "card 以外の名前");
  assert.equal(rp.amdGpuPresent(path.join(tmp(), "none")), false, "場所が無い");
});

test("supported: Linux は AMD だけでも出す。どちらも無ければ出さない", () => {
  const two = [{}, {}];
  assert.equal(rp.supported({ platform: "linux", devices: two, nvidiaGpuCount: 0, amdPresent: true }), true);
  assert.equal(rp.supported({ platform: "linux", devices: two, nvidiaGpuCount: 0, amdPresent: false }), false);
  assert.equal(rp.supported({ platform: "linux", devices: [{}], nvidiaGpuCount: 0, amdPresent: true }), false, "GPU が 1 つ");
});

test("applyPlan: Linux の AMD は DRI_PRIME=1。NVIDIA があれば NVIDIA が優先、どちらも無ければ何も付けない", () => {
  assert.deepEqual(rp.applyPlan({ gpu: "high" }, { platform: "linux", nvidiaPresent: false, amdPresent: true }), { env: { DRI_PRIME: "1" }, switches: [] });
  assert.deepEqual(rp.applyPlan({ gpu: "high" }, { platform: "linux", nvidiaPresent: true, amdPresent: true }), {
    env: { __NV_PRIME_RENDER_OFFLOAD: "1", __GLX_VENDOR_LIBRARY_NAME: "nvidia" },
    switches: [],
  });
  assert.deepEqual(rp.applyPlan({ gpu: "high" }, { platform: "linux", nvidiaPresent: false, amdPresent: false }), { env: {}, switches: [] });
  assert.deepEqual(rp.applyPlan({ gpu: "auto" }, { platform: "linux", nvidiaPresent: false, amdPresent: true }), { env: {}, switches: [] });
});

test("unverifiedGpu: Linux の NVIDIA だけ実測済み。それ以外は検証中", () => {
  assert.equal(rp.unverifiedGpu({ platform: "linux", nvidiaPresent: true }), false);
  assert.equal(rp.unverifiedGpu({ platform: "linux", nvidiaPresent: false }), true);
  assert.equal(rp.unverifiedGpu({ platform: "win32", nvidiaPresent: false }), true);
  assert.equal(rp.unverifiedGpu({ platform: "darwin", nvidiaPresent: false }), true);
});

test("状態ファイル: 読み書き・消去。壊れた・知らない値は状態なし", () => {
  const d = tmp();
  assert.equal(rp.loadState(d), null);
  assert.equal(rp.saveState(d, { status: "trying" }), true);
  assert.deepEqual(rp.loadState(d), { status: "trying" });
  assert.equal(rp.saveState(d, { status: "failed", reason: "crashed" }), true);
  assert.deepEqual(rp.loadState(d), { status: "failed", reason: "crashed" });
  assert.equal(rp.saveState(d, null), true);
  assert.equal(rp.loadState(d), null);
  for (const bad of ["{", "null", '{"status":"done"}', ""]) assert.equal(rp.parseState(bad), null, bad);
  assert.equal(rp.saveState(path.join(d, "no", "such"), { status: "trying" }), false, "書けなければ false");
});

test("isGpuFailure: 落ちた扱いは 5 つ。clean-exit・killed・知らない値は除く", () => {
  for (const r of ["crashed", "abnormal-exit", "launch-failed", "oom", "integrity-failure"]) assert.equal(rp.isGpuFailure(r), true, r);
  for (const r of ["clean-exit", "killed", "memory-eviction", undefined, ""]) assert.equal(rp.isGpuFailure(r), false, String(r));
});

const base = { platform: "linux", nvidiaPresent: true, amdPresent: false };
const none = { env: {}, switches: [] };

test("decideStartup: auto は何も付けず、状態の残りも消す", () => {
  const r = rp.decideStartup({ ...base, prefs: { gpu: "auto" }, state: { status: "failed", reason: "crashed" } });
  assert.deepEqual(r, { plan: none, fallback: null, nextState: null });
});

test("decideStartup: high で GPU があり状態が無ければ付けて trying を書く", () => {
  const r = rp.decideStartup({ ...base, prefs: { gpu: "high" }, state: null });
  assert.equal(r.fallback, null);
  assert.equal(r.plan.env.__NV_PRIME_RENDER_OFFLOAD, "1");
  assert.deepEqual(r.nextState, { status: "trying" });
});

test("decideStartup: GPU が見つからなければ付けず missing（選択は触らない）", () => {
  const r = rp.decideStartup({ ...base, nvidiaPresent: false, prefs: { gpu: "high" }, state: null });
  assert.deepEqual(r, { plan: none, fallback: "missing", nextState: null });
});

test("decideStartup: 前回の起動が確定しなかった（trying の残り）なら付けず unconfirmed を failed に倒す", () => {
  const r = rp.decideStartup({ ...base, prefs: { gpu: "high" }, state: { status: "trying" } });
  assert.deepEqual(r, { plan: none, fallback: "unconfirmed", reason: "unconfirmed", nextState: { status: "failed", reason: "unconfirmed" } });
});

test("decideStartup: 自分で起動し直した直後（continuing）の trying は未確定と見なさない", () => {
  const r = rp.decideStartup({ ...base, prefs: { gpu: "high" }, state: { status: "trying" }, continuing: true });
  assert.equal(r.fallback, null);
  assert.deepEqual(r.nextState, { status: "trying" });
});

test("decideStartup: failed が残っている間は付けない（落ちる起動を繰り返さない）。状態は触らない", () => {
  const r = rp.decideStartup({ ...base, prefs: { gpu: "high" }, state: { status: "failed", reason: "oom" }, continuing: true });
  assert.deepEqual(r, { plan: none, fallback: "failed", reason: "oom", nextState: "keep" });
});

test("decideStartup: Windows・macOS（スイッチ）と Linux の AMD でも同じ判断", () => {
  const w = rp.decideStartup({ platform: "win32", nvidiaPresent: false, prefs: { gpu: "high" }, state: null });
  assert.deepEqual(w.plan.switches, ["force_high_performance_gpu"]);
  assert.deepEqual(w.nextState, { status: "trying" });
  const a = rp.decideStartup({ platform: "linux", nvidiaPresent: false, amdPresent: true, prefs: { gpu: "high" }, state: null });
  assert.deepEqual(a.plan.env, { DRI_PRIME: "1" });
  assert.equal(rp.decideStartup({ platform: "win32", nvidiaPresent: false, prefs: { gpu: "high" }, state: { status: "trying" } }).fallback, "unconfirmed");
});
