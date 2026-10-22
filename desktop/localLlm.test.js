const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const crypto = require("node:crypto");
const L = require("./localLlm");
const aiProviders = require("./aiProviders");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "graphy-llm-"));
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

/** 偽の llama-server（Node スクリプト）。--port を読み、/health を返す。起動を遅らせる・すぐ落ちる試験用の引数も持つ。 */
const FAKE_SERVER = `#!/usr/bin/env node
const http = require("http");
const a = process.argv;
const port = Number(a[a.indexOf("--port") + 1]);
const host = a[a.indexOf("--host") + 1];
if (process.env.FAKE_EXIT) process.exit(3);
const delay = Number(process.env.FAKE_LOAD_MS || 0);
const t0 = Date.now();
http.createServer((q, r) => {
  if (q.url === "/health") { r.statusCode = Date.now() - t0 < delay ? 503 : 200; r.end("{}"); return; }
  r.end("{}");
}).listen(port, host);
process.on("SIGTERM", () => process.exit(0));
`;

/** zip を手で組む（stored のみ）。 */
function makeZip(files) {
  const locals = [], centrals = [];
  let off = 0;
  for (const f of files) {
    const name = Buffer.from(f.name), raw = Buffer.from(f.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt32LE(raw.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(name.length, 26);
    const local = Buffer.concat([lh, name, raw]);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt32LE(raw.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(off, 42);
    centrals.push(Buffer.concat([ch, name])); locals.push(local); off += local.length;
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}

const RUNTIME_ZIP = makeZip([{ name: "bin/llama-server", data: FAKE_SERVER }, { name: "LICENSE", data: "MIT" }]);
const MODEL = Buffer.concat([Buffer.from("GGUF"), crypto.randomBytes(5000)]);

function makeManifest() {
  return {
    schema: 1,
    runtime: { build: "bTEST", assets: { [`${process.platform}-${process.arch}`]: {
      file: "rt.zip", url: "https://github.com/x/rt.zip", sha256: sha(RUNTIME_ZIP), size: RUNTIME_ZIP.length, exe: "llama-server",
    } } },
    models: [{ id: "m1", label: "M1", file: "m1.gguf", url: "https://huggingface.co/m1.gguf", sha256: sha(MODEL), size: MODEL.length, license: "Apache-2.0", toolMode: "none" }],
  };
}

/** 偽のダウンロード: URL ごとの中身をそのまま dest へ置く。 */
function fakeDownload(calls) {
  return async (o) => {
    calls.push(o.url);
    const body = o.url.endsWith("rt.zip") ? RUNTIME_ZIP : MODEL;
    if (o.onProgress) o.onProgress({ received: body.length, total: body.length });
    fs.writeFileSync(o.dest, body);
    return { ok: true };
  };
}

const EXAMPLE_PROVIDERS = {
  providers: [{ id: "gemini", label: "Gemini", kind: "gemini", endpoint: "https://generativelanguage.googleapis.com", models: { "image-to-image": "g-img", "text-to-text": "g-txt" } }],
  defaults: { "text-to-text": "gemini", "image-to-image": "gemini" },
};

function setup(over = {}) {
  const dataDir = tmp();
  aiProviders.init(dataDir);
  assert.equal(aiProviders.save(EXAMPLE_PROVIDERS).ok, true);
  const calls = [];
  const events = [];
  const ai = L.createLocalAi({
    dataDir, manifest: makeManifest(), aiProviders, emit: (e) => events.push(e),
    download: fakeDownload(calls), stopWaitMs: 3000, pollMs: 50, idleMs: 0, ...over,
  });
  return { dataDir, ai, calls, events };
}

test("serverArgs: host は 127.0.0.1 固定・目印が --alias に入る", () => {
  const a = L.serverArgs({ modelPath: "/m.gguf", port: 4321, mark: "0123456789abcdef" });
  assert.equal(a[a.indexOf("--host") + 1], "127.0.0.1");
  assert.ok(!a.includes("0.0.0.0"));
  assert.ok(a.includes("graphy-local-llm:0123456789abcdef"));
  assert.ok(!a.includes("--jinja"));
  assert.ok(L.serverArgs({ modelPath: "/m", port: 1, mark: "0123456789abcdef", jinja: true }).includes("--jinja"));
});

test("cmdlineHasMark / parseRecord: 正例と負例", () => {
  assert.equal(L.cmdlineHasMark("x --alias graphy-local-llm:0123456789abcdef y", "0123456789abcdef"), true);
  assert.equal(L.cmdlineHasMark("x --alias other", "0123456789abcdef"), false);
  assert.equal(L.cmdlineHasMark("graphy-local-llm:zz", "zz"), false); // 目印の形でない
  assert.deepEqual(L.parseRecord('{"pid":123,"port":4000,"mark":"0123456789abcdef"}'), { pid: 123, port: 4000, mark: "0123456789abcdef" });
  for (const bad of ["", "{}", '{"pid":1,"port":1,"mark":"0123456789abcdef"}', '{"pid":5,"port":1,"mark":"xyz"}', "not json"]) assert.equal(L.parseRecord(bad), null, bad);
});

test("pinManaged: renderer が local-llm の endpoint を変えられない／未導入なら local-llm は捨てる", () => {
  const cur = [{ id: "local-llm", kind: "openai", endpoint: "http://127.0.0.1:5000", auth: "none", models: { "text-to-text": "m" } }, { id: "a", kind: "openai", endpoint: "https://a.example", models: { "text-to-text": "x" } }];
  const incoming = [{ id: "a", endpoint: "https://a.example" }, { id: "local-llm", kind: "openai", endpoint: "http://127.0.0.1:9", auth: "none", models: { "text-to-text": "evil" } }];
  const out = L.pinManaged(incoming, cur);
  assert.equal(out.find((p) => p.id === "local-llm").endpoint, "http://127.0.0.1:5000");
  assert.equal(out.find((p) => p.id === "local-llm").models["text-to-text"], "m");
  assert.equal(L.pinManaged(incoming, [cur[1]]).some((p) => p.id === "local-llm"), false);
});

test("status: 未導入", () => {
  const { ai } = setup();
  const s = ai.status();
  assert.equal(s.supported, true);
  assert.equal(s.runtime.installed, false);
  assert.equal(s.model.installed, false);
  assert.equal(s.registered, false);
});

test("install → ensure → 会話宛の endpoint が実ポートへ → stop で予約ポートへ戻る", { skip: process.platform === "win32" && "偽の実行ファイル(shebang スクリプト)を Windows では直接起動できない。起動は実 OS で別途確認する" }, async () => {
  const { ai, calls, events } = setup();
  const r = await ai.install({ modelId: "m1" });
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(calls.map((u) => u.split("/").pop()), ["rt.zip", "m1.gguf"]);
  assert.ok(events.some((e) => e.phase === "runtime-extract"));
  let st = ai.status();
  assert.equal(st.runtime.installed, true);
  assert.equal(st.model.installed, true);
  assert.equal(st.model.verified, true);
  assert.equal(st.registered, true);
  assert.equal(aiProviders.byId("local-llm").endpoint, L.PARKED_ENDPOINT);
  assert.equal(aiProviders.byId("local-llm").auth, "none");
  assert.equal(aiProviders.get().defaults["text-to-text"], "gemini"); // 導入しただけでは既定を変えない

  const e = await ai.ensure();
  assert.equal(e.ok, true);
  const res = await fetch(`http://127.0.0.1:${e.port}/health`);
  assert.equal(res.status, 200);
  assert.equal(aiProviders.byId("local-llm").endpoint, `http://127.0.0.1:${e.port}`);
  assert.equal(ai.status().running, true);

  await ai.stop();
  assert.equal(ai.status().running, false);
  assert.equal(aiProviders.byId("local-llm").endpoint, L.PARKED_ENDPOINT);
  await assert.rejects(fetch(`http://127.0.0.1:${e.port}/health`)); // 本当に止まっている
});

test("ensure: 同時に呼んでも起動は 1 回・モデル読み込み中(503)は待つ", { skip: process.platform === "win32" && "偽の実行ファイル(shebang スクリプト)を Windows では直接起動できない。起動は実 OS で別途確認する" }, async () => {
  const { ai } = setup({ env: { ...process.env, FAKE_LOAD_MS: "400" } });
  await ai.install({ modelId: "m1" });
  const [a, b] = await Promise.all([ai.ensure(), ai.ensure()]);
  assert.equal(a.ok && b.ok, true);
  assert.equal(a.port, b.port);
  await ai.stop();
});

test("ensure: プロセスがすぐ落ちたら server-exited（成功と言わない）", { skip: process.platform === "win32" && "偽の実行ファイル(shebang スクリプト)を Windows では直接起動できない。起動は実 OS で別途確認する" }, async () => {
  const { ai } = setup({ env: { ...process.env, FAKE_EXIT: "1" } });
  await ai.install({ modelId: "m1" });
  const e = await ai.ensure();
  assert.equal(e.ok, false);
  assert.equal(e.error, "server-exited");
  assert.equal(ai.status().running, false);
});

test("ensure: 未導入なら not-installed", async () => {
  const { ai } = setup();
  assert.equal((await ai.ensure()).error, "not-installed");
});

test("prepare: local-llm 以外は何もしない／local-llm なら起動する", { skip: process.platform === "win32" && "偽の実行ファイル(shebang スクリプト)を Windows では直接起動できない。起動は実 OS で別途確認する" }, async () => {
  const { ai } = setup();
  await ai.install({ modelId: "m1" });
  assert.deepEqual(await ai.prepare({ id: "gemini" }), { ok: true });
  assert.equal(ai.status().running, false);
  assert.deepEqual(await ai.prepare({ id: "local-llm" }), { ok: true });
  assert.equal(ai.status().running, true);
  await ai.stop();
});

test("install: sha256 不一致（download が失敗）なら提供元を登録しない", async () => {
  const { ai } = setup({ download: async () => ({ ok: false, error: "sha256-mismatch" }) });
  const r = await ai.install({ modelId: "m1" });
  assert.deepEqual(r, { ok: false, error: "sha256-mismatch" });
  assert.equal(ai.status().registered, false);
  assert.equal(ai.status().runtime.installed, false);
});

test("install: 未知のモデル id・未対応 OS は拒否", async () => {
  const { ai } = setup();
  assert.equal((await ai.install({ modelId: "nope" })).error, "unknown-model");
  const un = L.createLocalAi({ dataDir: tmp(), manifest: makeManifest(), aiProviders, platform: "plan9", arch: "x1" });
  assert.equal(un.status().supported, false);
  assert.equal((await un.install({ modelId: "m1" })).error, "unsupported-platform");
});

test("setRole: 縮退先・既定の切り替えと元の既定への復帰", async () => {
  const { ai } = setup();
  assert.equal(ai.setRole({ fallback: true }).error, "not-registered");
  await ai.install({ modelId: "m1" });
  assert.equal(ai.setRole({ fallback: true }).ok, true);
  assert.deepEqual(aiProviders.get().fallbacks["text-to-text"], ["local-llm"]);
  assert.deepEqual(aiProviders.resolveChain("text-to-text").chain.map((c) => c.provider.id), ["gemini", "local-llm"]);
  assert.equal(ai.setRole({ makeDefault: true }).ok, true);
  assert.equal(aiProviders.get().defaults["text-to-text"], "local-llm");
  assert.equal(aiProviders.get().defaults["image-to-image"], "gemini"); // text-to-text 以外は触らない
  assert.equal(ai.setRole({ makeDefault: false }).ok, true);
  assert.equal(aiProviders.get().defaults["text-to-text"], "gemini");
  assert.equal(ai.setRole({ fallback: false }).ok, true);
  assert.equal((aiProviders.get().fallbacks || {})["text-to-text"], undefined);
});

test("remove: 停止・登録解除・ファイル削除。他の提供元と既定は残る", { skip: process.platform === "win32" && "偽の実行ファイル(shebang スクリプト)を Windows では直接起動できない。起動は実 OS で別途確認する" }, async () => {
  const { ai, dataDir } = setup();
  await ai.install({ modelId: "m1" });
  ai.setRole({ fallback: true, makeDefault: true });
  await ai.ensure();
  const r = await ai.remove();
  assert.deepEqual(r, { ok: true });
  assert.equal(fs.existsSync(path.join(dataDir, "local-ai")), false);
  assert.equal(aiProviders.byId("local-llm"), null);
  assert.equal(aiProviders.byId("gemini") != null, true);
  assert.equal(aiProviders.get().defaults["text-to-text"], "gemini");
  assert.equal((aiProviders.get().fallbacks || {})["text-to-text"], undefined);
});

test("importFile: 正しい runtime/モデルは受理・違うファイルは拒否・検証なし GGUF は明示したときだけ", async () => {
  const { ai } = setup();
  const d = tmp();
  const rt = path.join(d, "whatever.zip");
  const md = path.join(d, "x.gguf");
  const other = path.join(d, "other.gguf");
  const junk = path.join(d, "junk.bin");
  fs.writeFileSync(rt, RUNTIME_ZIP);
  fs.writeFileSync(md, MODEL);
  fs.writeFileSync(other, Buffer.concat([Buffer.from("GGUF"), Buffer.from("different")]));
  fs.writeFileSync(junk, "hello");

  assert.deepEqual(await ai.importFile({ file: rt }), { ok: true, kind: "runtime" });
  assert.equal(ai.status().runtime.installed, true);
  assert.deepEqual(await ai.importFile({ file: md }), { ok: true, kind: "model", id: "m1", verified: true });
  assert.equal(ai.status().registered, true);

  assert.equal((await ai.importFile({ file: junk })).error, "unknown-file");
  assert.equal((await ai.importFile({ file: other })).error, "unknown-file"); // 既定では未検証のモデルを受けない
  assert.equal((await ai.importFile({ file: junk, allowUnverified: true })).error, "unknown-file"); // .gguf でない
  assert.equal((await ai.importFile({ file: "relative/x.gguf" })).error, "bad-path");
  assert.equal((await ai.importFile({ file: path.join(d, "none.gguf") })).error, "not-found");
  const un = await ai.importFile({ file: other, allowUnverified: true });
  assert.deepEqual(un, { ok: true, kind: "model", id: "custom", verified: false });
  assert.equal(ai.status().model.verified, false);
});

test("importFile: GGUF の見出しが無いファイルは allowUnverified でも拒否", async () => {
  const { ai } = setup();
  const f = path.join(tmp(), "fake.gguf");
  fs.writeFileSync(f, "this is not a gguf file");
  assert.equal((await ai.importFile({ file: f, allowUnverified: true })).error, "not-gguf");
});

test("sweepStale: 目印が合う残骸だけ止める／他人のプロセス・死んだ PID・壊れた記録は止めない", () => {
  const killed = [];
  const mk = (over) => {
    const { dataDir } = setup();
    const ai = L.createLocalAi({ dataDir, manifest: makeManifest(), aiProviders, kill: (pid) => killed.push(pid), ...over });
    return { ai, rec: path.join(dataDir, "local-ai", "server.json"), dataDir };
  };
  const write = (rec, obj) => { fs.mkdirSync(path.dirname(rec), { recursive: true }); fs.writeFileSync(rec, typeof obj === "string" ? obj : JSON.stringify(obj)); };
  const mark = "0123456789abcdef";

  let c = mk({ isAlive: () => true, readCmdline: () => `llama-server --alias graphy-local-llm:${mark}` });
  write(c.rec, { pid: 4242, port: 5000, mark });
  assert.deepEqual(c.ai.sweepStale(), { swept: true, pid: 4242 });
  assert.deepEqual(killed, [4242]);
  assert.equal(fs.existsSync(c.rec), false);

  killed.length = 0;
  c = mk({ isAlive: () => true, readCmdline: () => "/usr/bin/some-other-program" });
  write(c.rec, { pid: 4243, port: 5000, mark });
  assert.deepEqual(c.ai.sweepStale(), { swept: false, reason: "not-ours" });
  c = mk({ isAlive: () => false });
  write(c.rec, { pid: 4244, port: 5000, mark });
  assert.equal(c.ai.sweepStale().reason, "not-running");
  c = mk({});
  write(c.rec, "garbage");
  assert.equal(c.ai.sweepStale().reason, "bad-record");
  assert.deepEqual(killed, []); // 一度も kill していない
});

test("serverArgs: reasoning・threads・no-webui は指定したときだけ／既定で付く", () => {
  const base = { modelPath: "/m", port: 1, mark: "0123456789abcdef" };
  const a = L.serverArgs(base);
  assert.ok(a.includes("--no-webui"));
  assert.ok(!a.includes("--reasoning") && !a.includes("-t"));
  const b = L.serverArgs({ ...base, reasoning: "off", threads: 8 });
  assert.equal(b[b.indexOf("--reasoning") + 1], "off");
  assert.equal(b[b.indexOf("-t") + 1], "8");
  // 負例: 不正な値は渡さない（コマンド行へ未検証の文字列を入れない）
  const c = L.serverArgs({ ...base, reasoning: "rm -rf", threads: -3 });
  assert.ok(!c.includes("--reasoning") && !c.includes("-t"));
});

test("defaultThreads: 論理 CPU の半分・最低 2", () => {
  assert.equal(L.defaultThreads(16), 8);
  assert.equal(L.defaultThreads(8), 4);
  assert.equal(L.defaultThreads(2), 2);
  assert.equal(L.defaultThreads(1), 2);
  assert.equal(L.defaultThreads(undefined), 2);
});
