// 自動更新（appUpdate.js）。資産の選択・ダウンロードの失敗系・適用の計画・状態遷移を、
// ローカルの偽サーバーと、実際の minisign の署名（testdata/appupdate）で確かめる。
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const au = require("./appUpdate");
const { verifyFile } = require("./minisign");

const FX = path.join(__dirname, "testdata", "appupdate");
const payload = fs.readFileSync(path.join(FX, "payload.bin"));
const sigText = fs.readFileSync(path.join(FX, "payload.bin.minisig"), "utf8");
const testPub = fs.readFileSync(path.join(FX, "test.pub"), "utf8");
const otherPub = fs.readFileSync(path.join(FX, "other.pub"), "utf8");
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const mkTmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "appupdate-test-"));

// ── 資産の選択 ───────────────────────────────────────────────────────────────
const asset = (name, size = 1000, digest = `sha256:${"a".repeat(64)}`) =>
  ({ name, size, digest, browser_download_url: `https://github.com/tatsunidas/GRAPHY-Next/releases/download/v0.7.0/${name}` });
const release = (over = {}) => ({
  tag_name: "v0.7.0",
  assets: [
    asset("GRAPHY-Next.Setup.0.7.0.exe"), asset("GRAPHY-Next.Setup.0.7.0.exe.minisig", 300, "sha256:" + "b".repeat(64)),
    asset("GRAPHY-Next-0.7.0.AppImage"), asset("GRAPHY-Next-0.7.0.AppImage.minisig", 300, "sha256:" + "c".repeat(64)),
    asset("GRAPHY-Next-0.7.0-arm64.dmg"), asset("graphy-next-desktop_0.7.0_amd64.deb"),
  ],
  ...over,
});
const win = { platform: "win32", arch: "x64", currentVersion: "0.6.1" };
const lin = { platform: "linux", arch: "x64", currentVersion: "0.6.1", appImage: "/home/u/GRAPHY-Next-0.6.1.AppImage", appImageDirWritable: true };

test("pickAsset 正例: Windows は NSIS、Linux は AppImage（署名・digest・trusted comment つき）", () => {
  const w = au.pickAsset(release(), win);
  assert.strictEqual(w.supported, true);
  assert.strictEqual(w.kind, "nsis");
  assert.strictEqual(w.asset.name, "GRAPHY-Next.Setup.0.7.0.exe");
  assert.strictEqual(w.asset.sha256, "a".repeat(64));
  assert.strictEqual(w.sig.name, "GRAPHY-Next.Setup.0.7.0.exe.minisig");
  assert.strictEqual(w.expectTrusted, "graphy-next v0.7.0 GRAPHY-Next.Setup.0.7.0.exe");
  const l = au.pickAsset(release(), lin);
  assert.strictEqual(l.kind, "appimage");
  assert.strictEqual(l.asset.name, "GRAPHY-Next-0.7.0.AppImage");
});

test("pickAsset 負例: 対象外・欠落・不正は supported:false と理由", () => {
  const r = (rel, ctx) => au.pickAsset(rel, ctx);
  assert.strictEqual(r(release(), { ...win, platform: "darwin" }).reason, "platform-unsupported");
  assert.strictEqual(r(release(), { ...lin, appImage: null }).reason, "not-appimage"); // deb など
  assert.strictEqual(r(release(), { ...win, arch: "arm64" }).reason, "arch-unsupported");
  assert.strictEqual(r(release(), { ...lin, appImageDirWritable: false }).reason, "appimage-dir-not-writable");
  assert.strictEqual(r(release(), { ...win, currentVersion: "0.7.0" }).reason, "not-newer");
  assert.strictEqual(r(release(), { ...win, currentVersion: "0.8.0" }).reason, "not-newer");
  assert.strictEqual(r(release({ tag_name: "" }), win).reason, "no-version");
  const noSig = release(); noSig.assets = noSig.assets.filter((a) => !a.name.endsWith(".minisig"));
  assert.strictEqual(r(noSig, win).reason, "signature-missing");
  const noAsset = release(); noAsset.assets = noAsset.assets.filter((a) => !a.name.endsWith(".exe"));
  assert.strictEqual(r(noAsset, win).reason, "asset-missing");
  const noDigest = release(); noDigest.assets[0].digest = null;
  assert.strictEqual(r(noDigest, win).reason, "digest-missing");
  const badDigest = release(); badDigest.assets[0].digest = "sha1:abc";
  assert.strictEqual(r(badDigest, win).reason, "digest-missing");
  const noSize = release(); noSize.assets[0].size = 0;
  assert.strictEqual(r(noSize, win).reason, "size-missing");
});

test("pickAsset 負例: GitHub 以外・http の URL は拒否（任意の URL を実行させない）", () => {
  for (const url of ["http://github.com/x.exe", "https://evil.example.com/x.exe", "https://github.com.evil.example/x.exe", "file:///tmp/x.exe", "not a url"]) {
    const rel = release(); rel.assets[0].browser_download_url = url;
    assert.strictEqual(au.pickAsset(rel, win).reason, "bad-url", url);
  }
  const ok = release(); ok.assets[0].browser_download_url = "https://release-assets.githubusercontent.com/github-production-release-asset/x.exe";
  assert.strictEqual(au.pickAsset(ok, win).supported, true);
});

test("開発の上書き: 偽サーバーを指した未パッケージのときだけ、ローカルの資産 URL と追加の鍵を許す（パッケージ版は無効）", () => {
  const env = { GRAPHY_UPDATE_API_BASE: "http://127.0.0.1:9", GRAPHY_UPDATE_TRUSTED_KEY: "RWxxxx" };
  assert.deepStrictEqual(au.devOverrides(env, false), { allowLocal: true, extraKey: ["RWxxxx"] });
  assert.deepStrictEqual(au.devOverrides(env, true), { allowLocal: false, extraKey: [] }); // 負例: パッケージ版
  assert.deepStrictEqual(au.devOverrides({ GRAPHY_UPDATE_TRUSTED_KEY: "RWxxxx" }, false), { allowLocal: false, extraKey: [] }); // 偽サーバー無しでは鍵だけ足せない
  const local = release(); for (const a of local.assets) a.browser_download_url = `http://127.0.0.1:9/${a.name}`;
  assert.strictEqual(au.pickAsset(local, win).reason, "bad-url"); // 既定（パッケージ版相当）は拒否
  assert.strictEqual(au.pickAsset(local, { ...win, allowLocalAssets: true }).supported, true);
  const evil = release(); for (const a of evil.assets) a.browser_download_url = `http://evil.example.com/${a.name}`;
  assert.strictEqual(au.pickAsset(evil, { ...win, allowLocalAssets: true }).reason, "bad-url"); // 許すのはローカルだけ
});

test("describePlan はレンダラへ URL を渡さない", () => {
  const d = au.describePlan(au.pickAsset(release(), win));
  assert.deepStrictEqual(Object.keys(d).sort(), ["assetName", "kind", "size", "supported", "version"]);
  assert.strictEqual(JSON.stringify(d).includes("http"), false);
  assert.deepStrictEqual(au.describePlan(au.pickAsset(release(), { ...win, platform: "darwin" })), { supported: false, reason: "platform-unsupported" });
});

test("isNewer", () => {
  assert.strictEqual(au.isNewer("0.6.2", "0.6.1"), true);
  assert.strictEqual(au.isNewer("v0.10.0", "0.9.9"), true);
  assert.strictEqual(au.isNewer("0.6.1", "0.6.1"), false);
  assert.strictEqual(au.isNewer("0.6.0", "0.6.1"), false);
});

test("releaseApiUrl: 開発のときだけ環境変数で更新元を差し替えられる（パッケージ版は無視）", () => {
  const env = { GRAPHY_UPDATE_API_BASE: "http://127.0.0.1:9999/" };
  assert.strictEqual(au.releaseApiUrl("o/r", env, false), "http://127.0.0.1:9999/repos/o/r/releases/latest");
  assert.strictEqual(au.releaseApiUrl("o/r", env, true), "https://api.github.com/repos/o/r/releases/latest"); // 負例
  assert.strictEqual(au.releaseApiUrl("o/r", {}, false), "https://api.github.com/repos/o/r/releases/latest");
});

// ── ダウンロード（ローカルの偽サーバー）──────────────────────────────────────
function serve(handler) {
  const hits = [];
  const srv = http.createServer((req, res) => { hits.push(req.url); handler(req, res); });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({
    base: `http://127.0.0.1:${srv.address().port}`, hits, close: () => new Promise((r) => { srv.closeAllConnections(); srv.close(r); }),
  })));
}
const LOCAL = { insecureLocal: true, stallMs: 400 };
const expectOf = (buf) => ({ size: buf.length, sha256: sha(buf) });
const noPart = (f) => assert.strictEqual(fs.existsSync(`${f}.part`), false, ".part が残っている");

test("download 正例: サイズ・SHA-256 が合えば保存され、進捗が出て、.part は残らない", async () => {
  const body = crypto.randomBytes(300_000);
  const s = await serve((q, r) => { r.writeHead(200, { "content-length": body.length }); r.end(body); });
  const d = mkTmp(); const f = path.join(d, "a.bin"); const prog = [];
  try {
    const r = await au.downloadToFile(`${s.base}/a`, f, expectOf(body), LOCAL, (n) => prog.push(n));
    assert.strictEqual(r.bytes, body.length);
    assert.ok(fs.readFileSync(f).equals(body));
    noPart(f);
    assert.ok(prog.length > 0 && prog[prog.length - 1] === body.length);
  } finally { await s.close(); fs.rmSync(d, { recursive: true, force: true }); }
});

test("download 負例: SHA-256 違い（同じサイズの別の中身）→ digest-mismatch・ファイルを残さない", async () => {
  const body = crypto.randomBytes(5000);
  const other = Buffer.from(body); other[10] ^= 1;
  const s = await serve((q, r) => { r.writeHead(200, { "content-length": other.length }); r.end(other); });
  const d = mkTmp(); const f = path.join(d, "a.bin");
  try {
    await assert.rejects(() => au.downloadToFile(`${s.base}/a`, f, expectOf(body), LOCAL), { code: "digest-mismatch" });
    assert.strictEqual(fs.existsSync(f), false); noPart(f);
  } finally { await s.close(); fs.rmSync(d, { recursive: true, force: true }); }
});

test("download 負例: サイズ違い（content-length・本体が期待より長い／短い）→ size-mismatch", async () => {
  const body = crypto.randomBytes(5000);
  for (const make of [() => Buffer.concat([body, Buffer.from("x")]), () => body.subarray(0, 4000)]) {
    const served = make();
    const s = await serve((q, r) => { r.writeHead(200, { "content-length": served.length }); r.end(served); });
    const d = mkTmp(); const f = path.join(d, "a.bin");
    try {
      await assert.rejects(() => au.downloadToFile(`${s.base}/a`, f, expectOf(body), LOCAL), { code: "size-mismatch" });
      assert.strictEqual(fs.existsSync(f), false); noPart(f);
    } finally { await s.close(); fs.rmSync(d, { recursive: true, force: true }); }
  }
  // content-length を偽って多く送る
  const s = await serve((q, r) => { r.writeHead(200, { "content-length": body.length }); r.write(body); r.write(Buffer.alloc(100)); r.end(); });
  const d = mkTmp(); const f = path.join(d, "a.bin");
  try {
    await assert.rejects(() => au.downloadToFile(`${s.base}/a`, f, expectOf(body), LOCAL));
    noPart(f);
  } finally { await s.close(); fs.rmSync(d, { recursive: true, force: true }); }
});

test("download 負例: 途中で接続が切れる → network・部分ファイルを残さない（ネットワーク断を失敗として扱う）", async () => {
  const body = crypto.randomBytes(200_000);
  const s = await serve((q, r) => { r.writeHead(200, { "content-length": body.length }); r.write(body.subarray(0, 50_000)); setTimeout(() => r.socket.destroy(), 50); });
  const d = mkTmp(); const f = path.join(d, "a.bin");
  try {
    await assert.rejects(() => au.downloadToFile(`${s.base}/a`, f, expectOf(body), LOCAL), (e) => e.code === "network");
    assert.strictEqual(fs.existsSync(f), false); noPart(f);
  } finally { await s.close(); fs.rmSync(d, { recursive: true, force: true }); }
});

test("download 負例: 途中から無通信（回線は繋がったまま届かない）→ stall で失敗。長く待たない", async () => {
  const body = crypto.randomBytes(200_000);
  const s = await serve((q, r) => { r.writeHead(200, { "content-length": body.length }); r.write(body.subarray(0, 10_000)); /* 以後は何も送らない */ });
  const d = mkTmp(); const f = path.join(d, "a.bin");
  const t0 = Date.now();
  try {
    await assert.rejects(() => au.downloadToFile(`${s.base}/a`, f, expectOf(body), LOCAL), { code: "stall" });
    assert.ok(Date.now() - t0 < 3000, `待ちすぎ: ${Date.now() - t0} ms`);
    noPart(f);
  } finally { await s.close(); fs.rmSync(d, { recursive: true, force: true }); }
});

test("download 負例: 中止（signal）→ cancelled・部分ファイルを残さない", async () => {
  const body = crypto.randomBytes(200_000);
  const s = await serve((q, r) => { r.writeHead(200, { "content-length": body.length }); r.write(body.subarray(0, 10_000)); });
  const d = mkTmp(); const f = path.join(d, "a.bin");
  const ac = new AbortController();
  try {
    const p = au.downloadToFile(`${s.base}/a`, f, expectOf(body), { ...LOCAL, stallMs: 5000, signal: ac.signal });
    setTimeout(() => ac.abort(), 100);
    await assert.rejects(() => p, { code: "cancelled" });
    noPart(f);
  } finally { await s.close(); fs.rmSync(d, { recursive: true, force: true }); }
});

test("download 負例: HTTP エラー・許可しないホストへのリダイレクト・リダイレクトの輪・本番での http", async () => {
  const body = Buffer.from("x");
  const s = await serve((q, r) => {
    if (q.url === "/404") { r.writeHead(404); r.end(); }
    else if (q.url === "/evil") { r.writeHead(302, { location: "https://evil.example.com/x.exe" }); r.end(); }
    else if (q.url === "/loop") { r.writeHead(302, { location: "/loop" }); r.end(); }
    else { r.writeHead(200); r.end(body); }
  });
  const d = mkTmp(); const f = path.join(d, "a.bin");
  try {
    await assert.rejects(() => au.downloadToFile(`${s.base}/404`, f, expectOf(body), LOCAL), { code: "http-404" });
    await assert.rejects(() => au.downloadToFile(`${s.base}/evil`, f, expectOf(body), LOCAL), { code: "bad-host" });
    await assert.rejects(() => au.downloadToFile(`${s.base}/loop`, f, expectOf(body), LOCAL), { code: "too-many-redirects" });
    // 本番相当（insecureLocal なし）: http のローカルは拒否。サーバーには 1 回も届かない
    const before = s.hits.length;
    await assert.rejects(() => au.downloadToFile(`${s.base}/ok`, f, expectOf(body), { stallMs: 400 }), { code: "bad-url" });
    assert.strictEqual(s.hits.length, before);
    // 許可する形のリダイレクトは追う（同じローカルへ）
  } finally { await s.close(); fs.rmSync(d, { recursive: true, force: true }); }
});

test("fetchText: 取得でき、上限を超える応答は拒否", async () => {
  const s = await serve((q, r) => { r.writeHead(200); r.end(q.url === "/big" ? Buffer.alloc(100_000, 65) : "hello"); });
  try {
    assert.strictEqual(await au.fetchText(`${s.base}/s`, LOCAL), "hello");
    await assert.rejects(() => au.fetchText(`${s.base}/big`, LOCAL), { code: "too-large" });
  } finally { await s.close(); }
});

// ── 適用の計画 ───────────────────────────────────────────────────────────────
test("buildApplyPlan: NSIS は今すぐのときだけ --force-run、AppImage は今すぐのときだけ再起動", () => {
  assert.deepStrictEqual(au.buildApplyPlan("nsis", "C:/u/Setup.exe", "now", {}), { kind: "spawn", command: "C:/u/Setup.exe", args: ["--updated", "/S", "--force-run"] });
  assert.deepStrictEqual(au.buildApplyPlan("nsis", "C:/u/Setup.exe", "onQuit", {}), { kind: "spawn", command: "C:/u/Setup.exe", args: ["--updated", "/S"] });
  assert.deepStrictEqual(au.buildApplyPlan("appimage", "/t/new", "now", { appImage: "/h/app" }), { kind: "replace-appimage", from: "/t/new", to: "/h/app", relaunch: true });
  assert.strictEqual(au.buildApplyPlan("appimage", "/t/new", "onQuit", { appImage: "/h/app" }).relaunch, false);
  assert.throws(() => au.buildApplyPlan("dmg", "x", "now", {}), { code: "unknown-kind" });
});

test("executeApplyPlan: NSIS は分離して起動／AppImage は同じ場所に置き換え（権限 755・一時ファイルを残さない）", () => {
  const calls = [];
  const sp = (cmd, args, opt) => { calls.push({ cmd, args, opt }); return { unref() {} }; };
  au.executeApplyPlan({ kind: "spawn", command: "S.exe", args: ["/S"] }, { spawn: sp });
  assert.strictEqual(calls[0].opt.detached, true);
  assert.strictEqual(calls[0].opt.stdio, "ignore");

  const d = mkTmp();
  try {
    const dest = path.join(d, "GRAPHY-Next-0.6.1.AppImage"); const src = path.join(d, "new.bin");
    fs.writeFileSync(dest, "OLD"); fs.writeFileSync(src, "NEW", { mode: 0o600 });
    au.executeApplyPlan({ kind: "replace-appimage", from: src, to: dest, relaunch: true }, { spawn: sp });
    assert.strictEqual(fs.readFileSync(dest, "utf8"), "NEW");
    // 実行権限は POSIX だけ（Windows のファイルは 0o666 相当で表せない。AppImage の入れ替えは Linux 専用）
    if (process.platform !== "win32") assert.strictEqual(fs.statSync(dest).mode & 0o777, 0o755);
    assert.deepStrictEqual(fs.readdirSync(d).sort(), ["GRAPHY-Next-0.6.1.AppImage", "new.bin"]); // .new が残らない
    assert.strictEqual(calls[1].cmd, dest);
    assert.strictEqual(calls[1].opt.env.GRAPHY_RELAUNCHED, "1");
    fs.writeFileSync(dest, "OLD2");
    au.executeApplyPlan({ kind: "replace-appimage", from: src, to: dest, relaunch: false }, { spawn: sp });
    assert.strictEqual(calls.length, 2); // 再起動しない
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
  assert.throws(() => au.executeApplyPlan({ kind: "x" }), { code: "unknown-plan" });
});

// ── 状態遷移（偽の依存）──────────────────────────────────────────────────────
const plan = () => au.pickAsset(release(), win);
function ctl(overrides = {}) {
  const dir = mkTmp();
  const executed = []; let quit = 0;
  const deps = {
    fetchText: async () => "sig",
    download: async (url, file, exp, opts, onP) => { onP(10); fs.writeFileSync(file, "installer"); return { bytes: 9, sha256: exp.sha256 }; },
    verifyFile: async () => ({ ok: true, keyId: "K", trustedComment: "tc" }),
    quit: () => { quit++; },
    execute: (ap) => executed.push(ap),
    ...overrides,
  };
  const c = new au.UpdateController({ dir, trustedKeys: [testPub], ctx: { appImage: null }, deps });
  const phases = []; c.on("state", (s) => phases.push(s.phase));
  return { c, dir, executed, phases, quitCount: () => quit, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("状態遷移 正例（終了時）: downloading → verifying → ready。終了時に 1 回だけ適用し、--force-run は付かない", async () => {
  const t = ctl();
  await t.c.start(plan(), "onQuit");
  assert.deepStrictEqual([...new Set(t.phases)], ["downloading", "verifying", "ready"]);
  assert.strictEqual(t.c.getState().phase, "ready");
  assert.strictEqual(t.quitCount(), 0); // 終了時: 勝手に終了しない
  assert.ok(fs.existsSync(path.join(t.dir, "pending.json")));
  assert.strictEqual(t.c.applyOnQuit(), true);
  assert.strictEqual(t.c.applyOnQuit(), false); // 1 回だけ
  assert.deepStrictEqual(t.executed[0].args, ["--updated", "/S"]);
  t.done();
});

test("状態遷移 正例（今すぐ）: applying になり quit を呼ぶ。終了時の適用は --force-run つき", async () => {
  const t = ctl();
  await t.c.start(plan(), "now");
  assert.strictEqual(t.c.getState().phase, "applying");
  assert.strictEqual(t.quitCount(), 1);
  assert.strictEqual(t.c.applyOnQuit(), true);
  assert.deepStrictEqual(t.executed[0].args, ["--updated", "/S", "--force-run"]);
  t.done();
});

test("状態遷移 負例: 署名が不正 → failed(signature-…)。残骸を消し、適用されない", async () => {
  const t = ctl({ verifyFile: async () => ({ ok: false, reason: "bad-signature" }) });
  await t.c.start(plan(), "now");
  assert.strictEqual(t.c.getState().phase, "failed");
  assert.strictEqual(t.c.getState().reason, "signature-bad-signature");
  assert.strictEqual(t.quitCount(), 0);
  assert.strictEqual(fs.existsSync(t.dir), false);
  assert.strictEqual(t.c.applyOnQuit(), false);
  t.done();
});

test("状態遷移 負例: ダウンロード失敗（ネットワーク断）→ failed。再試行せず、適用されない", async () => {
  let n = 0;
  const t = ctl({ download: async () => { n++; throw new au.UpdateError("network", "reset"); } });
  await t.c.start(plan(), "onQuit");
  assert.strictEqual(t.c.getState().phase, "failed");
  assert.strictEqual(t.c.getState().reason, "network");
  assert.strictEqual(n, 1); // 再試行しない
  assert.strictEqual(t.c.applyOnQuit(), false);
  t.done();
});

test("状態遷移: 中止 → cancelled。非対応の計画・不正な mode・実行中の二重開始は拒否", async () => {
  let release_;
  const t = ctl({ download: (u, f, e, opts) => new Promise((_, rej) => { release_ = () => rej(new au.UpdateError("cancelled")); opts.signal.addEventListener("abort", release_, { once: true }); }) });
  const p = t.c.start(plan(), "onQuit");
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(t.c.isBusy(), true);
  await assert.rejects(() => t.c.start(plan(), "onQuit"), { code: "busy" });
  t.c.cancel();
  await p;
  assert.strictEqual(t.c.getState().phase, "cancelled");
  await assert.rejects(() => t.c.start(au.pickAsset(release(), { ...win, platform: "darwin" }), "now"), { code: "unsupported" });
  await assert.rejects(() => t.c.start(plan(), "later"), { code: "bad-mode" });
  t.done();
});

test("適用を試みたら印を残し、版が上がらなくても次の起動で再び保留にしない（インストーラの失敗で毎回の終了に再試行し続けない）", async () => {
  const t = ctl();
  await t.c.start(plan(), "onQuit");
  assert.strictEqual(t.c.applyOnQuit(), true);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(t.dir, "pending.json"), "utf8")).applied, true);
  // 次の起動（版は上がらなかった＝インストーラが失敗した想定）
  const executed2 = [];
  const c2 = new au.UpdateController({ dir: t.dir, trustedKeys: [], ctx: {}, deps: { execute: (ap) => executed2.push(ap) } });
  c2.reconcile("0.6.1");
  assert.strictEqual(c2.getState().phase, "idle");
  assert.strictEqual(c2.applyOnQuit(), false);
  assert.strictEqual(executed2.length, 0);
  assert.strictEqual(fs.existsSync(t.dir), false); // 残骸も消える
  t.done();
});

test("reconcile: 版が追いついた・ファイルが無い・壊れた保留は整理し、新しい保留は「終了時」として引き継ぐ", async () => {
  const mk = (pending, withFile) => {
    const dir = mkTmp(); const f = path.join(dir, "0.7.0", "Setup.exe");
    fs.mkdirSync(path.dirname(f), { recursive: true });
    if (withFile) fs.writeFileSync(f, "x");
    if (pending) fs.writeFileSync(path.join(dir, "pending.json"), typeof pending === "string" ? pending : JSON.stringify({ ...pending, file: f }));
    const executed = [];
    return { dir, executed, c: new au.UpdateController({ dir, trustedKeys: [], ctx: {}, deps: { execute: (ap) => executed.push(ap) } }) };
  };
  let t = mk({ kind: "nsis", version: "0.7.0", mode: "now" }, true);
  t.c.reconcile("0.6.1");
  assert.strictEqual(t.c.getState().phase, "ready"); assert.strictEqual(t.c.getState().mode, "onQuit");
  assert.strictEqual(t.c.applyOnQuit(), true); // 引き継いだ保留は終了時に適用される（今すぐではなかったので --force-run なし）
  assert.deepStrictEqual(t.executed[0].args, ["--updated", "/S"]);
  fs.rmSync(t.dir, { recursive: true, force: true });
  t = mk({ kind: "nsis", version: "0.7.0" }, true);
  t.c.reconcile("0.7.0"); // 版が追いついた
  assert.strictEqual(fs.existsSync(t.dir), false); assert.strictEqual(t.c.getState().phase, "idle");
  t = mk({ kind: "nsis", version: "0.7.0" }, false); // ファイルが無い
  t.c.reconcile("0.6.1"); assert.strictEqual(fs.existsSync(t.dir), false);
  t = mk("{壊れた json", true);
  t.c.reconcile("0.6.1"); assert.strictEqual(fs.existsSync(t.dir), false);
});

// ── 実物の組み合わせ（実際のダウンロード + 実際の minisign の署名）───────────
async function realFlow(servedPayload, { keys = [testPub], digestOf = payload, expectTrusted } = {}) {
  const s = await serve((q, r) => {
    if (q.url === "/Setup.exe") { r.writeHead(200, { "content-length": servedPayload.length }); r.end(servedPayload); }
    else if (q.url === "/Setup.exe.minisig") { r.writeHead(200); r.end(sigText); }
    else { r.writeHead(404); r.end(); }
  });
  const dir = mkTmp();
  const executed = [];
  const c = new au.UpdateController({
    dir, trustedKeys: keys, ctx: {}, netOpts: LOCAL,
    deps: { quit: () => {}, execute: (ap) => executed.push(ap), verifyFile },
  });
  const p = {
    supported: true, kind: "nsis", version: "0.7.0",
    asset: { name: "Setup.exe", size: payload.length, url: `${s.base}/Setup.exe`, sha256: sha(digestOf) },
    sig: { name: "Setup.exe.minisig", url: `${s.base}/Setup.exe.minisig` },
    expectTrusted: expectTrusted || "file:payload.bin synthetic-test",
  };
  await c.start(p, "onQuit");
  const out = { state: c.getState(), executed, applied: c.applyOnQuit(), exists: fs.existsSync(path.join(dir, "0.7.0", "Setup.exe")) };
  await s.close(); fs.rmSync(dir, { recursive: true, force: true });
  return out;
}

test("実物 正例: 本物の署名つきの資産を落として検証し、終了時に適用される", async () => {
  const r = await realFlow(payload);
  assert.strictEqual(r.state.phase, "ready");
  assert.strictEqual(r.applied, true);
  assert.strictEqual(r.executed[0].kind, "spawn");
  assert.strictEqual(r.exists, true);
});

test("実物 負例: 信頼していない鍵の署名 → failed(signature-unknown-key)・ファイルを残さず適用なし", async () => {
  const r = await realFlow(payload, { keys: [otherPub] });
  assert.strictEqual(r.state.phase, "failed");
  assert.strictEqual(r.state.reason, "signature-unknown-key");
  assert.strictEqual(r.applied, false); assert.strictEqual(r.exists, false);
});

test("実物 負例: 中身を差し替え、API 側の digest も差し替え後に合わせた（GitHub 側の改ざん）→ 署名が不正で拒否", async () => {
  const tampered = Buffer.from(payload); tampered[500] ^= 1;
  const r = await realFlow(tampered, { digestOf: tampered });
  assert.strictEqual(r.state.phase, "failed");
  assert.strictEqual(r.state.reason, "signature-bad-signature");
  assert.strictEqual(r.applied, false);
});

test("実物 負例: 中身だけ差し替え（digest はそのまま）→ digest-mismatch", async () => {
  const tampered = Buffer.from(payload); tampered[500] ^= 1;
  const r = await realFlow(tampered, { digestOf: payload });
  assert.strictEqual(r.state.reason, "digest-mismatch");
  assert.strictEqual(r.applied, false);
});

test("実物 負例（ダウングレード防止）: 正規の署名でも trusted comment が期待する版・ファイルと違えば拒否", async () => {
  const r = await realFlow(payload, { expectTrusted: "graphy-next v0.7.0 Setup.exe" });
  assert.strictEqual(r.state.phase, "failed");
  assert.strictEqual(r.state.reason, "signature-trusted-comment-mismatch");
  assert.strictEqual(r.applied, false);
});
