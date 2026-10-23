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
if (process.env.FAKE_ARGV_OUT) require("fs").appendFileSync(process.env.FAKE_ARGV_OUT, JSON.stringify(a.slice(2)) + "\\n");
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

// ── 音声入力（local-stt の枠） ───────────────────────────────────────────

const STT_MAIN = Buffer.concat([Buffer.from("GGUF"), crypto.randomBytes(3000)]);
const STT_MM = Buffer.concat([Buffer.from("GGUF"), crypto.randomBytes(1500)]);
function sttManifest() {
  return {
    ...makeManifest(),
    sttModels: [{
      id: "asr1", label: "ASR", file: "asr1.gguf", url: "https://huggingface.co/asr1.gguf", sha256: sha(STT_MAIN), size: STT_MAIN.length,
      mmproj: { file: "mm1.gguf", url: "https://huggingface.co/mm1.gguf", sha256: sha(STT_MM), size: STT_MM.length },
      license: "Apache-2.0",
    }],
    defaultSttModelId: "asr1",
  };
}
function sttDownload(calls) {
  return async (o) => {
    calls.push(o.url);
    fs.writeFileSync(o.dest, o.url.endsWith("rt.zip") ? RUNTIME_ZIP : o.url.endsWith("mm1.gguf") ? STT_MM : o.url.endsWith("asr1.gguf") ? STT_MAIN : MODEL);
    return { ok: true };
  };
}
function sttSetup(over = {}) {
  const dataDir = tmp();
  aiProviders.init(dataDir);
  assert.equal(aiProviders.save(EXAMPLE_PROVIDERS).ok, true);
  const calls = [];
  const ai = L.createLocalAi({ dataDir, manifest: sttManifest(), aiProviders, emit: () => {}, download: sttDownload(calls), stopWaitMs: 3000, pollMs: 50, idleMs: 0, ...over });
  return { dataDir, ai, calls };
}
const SKIP_WIN = process.platform === "win32" && "偽の実行ファイル(shebang スクリプト)を Windows では直接起動できない。起動は実 OS で別途確認する";

test("serverArgs: mmproj は指定したときだけ付く／音声入力の目印は別の接頭辞", () => {
  const llm = L.serverArgs({ modelPath: "/m.gguf", port: 1, mark: "0123456789abcdef" });
  assert.ok(!llm.includes("--mmproj"));
  const stt = L.serverArgs({ modelPath: "/m.gguf", mmproj: "/mm.gguf", port: 1, mark: "0123456789abcdef", markPrefix: L.STT_MARK_PREFIX, ctx: 4096 });
  assert.equal(stt[stt.indexOf("--mmproj") + 1], "/mm.gguf");
  assert.ok(stt.includes("graphy-local-stt:0123456789abcdef"));
  assert.equal(stt[stt.indexOf("-c") + 1], "4096");
  assert.equal(stt[stt.indexOf("--host") + 1], "127.0.0.1");
  assert.equal(L.cmdlineHasMark("x graphy-local-stt:0123456789abcdef", "0123456789abcdef", L.STT_MARK_PREFIX), true);
  assert.equal(L.cmdlineHasMark("x graphy-local-stt:0123456789abcdef", "0123456789abcdef"), false, "接頭辞が違えば別物");
});

test("pinManaged: local-stt も renderer からは変えられない（負例）", () => {
  const cur = [{ id: "local-stt", kind: "openai", endpoint: "http://127.0.0.1:5000", auth: "none", models: { "speech-to-text": "asr" } }];
  const out = L.pinManaged([{ id: "local-stt", kind: "openai", endpoint: "http://127.0.0.1:9", auth: "none", models: { "speech-to-text": "evil" } }], cur);
  assert.equal(out.find((p) => p.id === "local-stt").endpoint, "http://127.0.0.1:5000");
  assert.equal(L.pinManaged([{ id: "local-stt", endpoint: "http://127.0.0.1:9" }], []).some((p) => p.id === "local-stt"), false);
});

test("install(stt): 本体と mmproj を取り、local-stt を登録する（会話の local-llm には触らない）", async () => {
  const { ai, calls } = sttSetup();
  assert.equal(ai.status().stt.installed, false);
  assert.deepEqual(await ai.install({ modelId: "asr1" }), { ok: true });
  assert.deepEqual(calls.map((u) => u.split("/").pop()), ["rt.zip", "asr1.gguf", "mm1.gguf"]);
  const st = ai.status();
  assert.equal(st.stt.installed, true);
  assert.equal(st.stt.registered, true);
  assert.equal(st.stt.isDefault, true, "他に音声入力の提供元が無いので既定になる");
  assert.equal(st.registered, false, "会話のローカル LLM は登録していない");
  const p = aiProviders.get().providers.find((x) => x.id === "local-stt");
  assert.equal(p.auth, "none");
  assert.equal(p.models["speech-to-text"], "asr1");
  assert.equal(p.paths["speech-to-text"], "/v1/chat/completions");
  assert.equal(aiProviders.get().defaults["text-to-text"], "gemini", "会話の既定は変わらない");
});

test("install(stt): 片方の download が失敗したら登録しない", async () => {
  const calls = [];
  const { ai } = sttSetup({ download: async (o) => { calls.push(o.url); if (o.url.endsWith("mm1.gguf")) return { ok: false, error: "sha256-mismatch" }; fs.writeFileSync(o.dest, o.url.endsWith("rt.zip") ? RUNTIME_ZIP : STT_MAIN); return { ok: true }; } });
  assert.deepEqual(await ai.install({ modelId: "asr1" }), { ok: false, error: "sha256-mismatch" });
  assert.equal(ai.status().stt.installed, false);
  assert.equal(ai.status().stt.registered, false);
});

test("文字起こしの枠は会話の枠と独立に起動・停止する／音声入力は --mmproj 付きで起動する", { skip: SKIP_WIN }, async () => {
  const argvOut = path.join(tmp(), "argv.log");
  const { ai, dataDir } = sttSetup({ env: { ...process.env, FAKE_ARGV_OUT: argvOut } });
  await ai.install({ modelId: "asr1" });
  await ai.install({ modelId: "m1" });
  const before = aiProviders.get().providers.find((x) => x.id === "local-stt").endpoint;
  assert.equal(before, L.PARKED_ENDPOINT);
  try {
    assert.deepEqual(await ai.prepare({ id: "local-stt" }), { ok: true });
    let s = ai.status();
    assert.equal(s.stt.running, true);
    assert.equal(s.running, false, "会話の枠は起動していない");
    const sttEndpoint = aiProviders.get().providers.find((x) => x.id === "local-stt").endpoint;
    assert.match(sttEndpoint, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.notEqual(sttEndpoint, L.PARKED_ENDPOINT);
    assert.equal(aiProviders.get().providers.find((x) => x.id === "local-llm").endpoint, L.PARKED_ENDPOINT);

    assert.deepEqual(await ai.prepare({ id: "local-llm" }), { ok: true });
    s = ai.status();
    assert.equal(s.stt.running && s.running, true, "2 つ同時に動く");
    const lines = fs.readFileSync(argvOut, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const sttArgs = lines.find((a) => a.some((x) => String(x).startsWith("graphy-local-stt:")));
    const llmArgs = lines.find((a) => a.some((x) => String(x).startsWith("graphy-local-llm:")));
    assert.ok(sttArgs.includes("--mmproj") && sttArgs.includes("asr1.gguf") === false && sttArgs.some((x) => x.endsWith("asr1.gguf")));
    assert.ok(!llmArgs.includes("--mmproj"));
    assert.ok(fs.existsSync(path.join(dataDir, "local-ai", "server-stt.json")) && fs.existsSync(path.join(dataDir, "local-ai", "server.json")));

    await ai.stop(); // 全部止める
    s = ai.status();
    assert.equal(s.stt.running || s.running, false);
    assert.equal(aiProviders.get().providers.find((x) => x.id === "local-stt").endpoint, L.PARKED_ENDPOINT, "止めたら予約ポートへ戻る");
    assert.equal(fs.existsSync(path.join(dataDir, "local-ai", "server-stt.json")), false);
  } finally { await ai.stop(); }
});

test("removeStt: 音声入力だけ外す（会話のモデル・runtime・他の提供元は残る）", async () => {
  const { ai, dataDir } = sttSetup();
  await ai.install({ modelId: "m1" });
  await ai.install({ modelId: "asr1" });
  assert.deepEqual(await ai.removeStt(), { ok: true });
  const st = ai.status();
  assert.equal(st.stt.installed, false);
  assert.equal(st.stt.registered, false);
  assert.equal(st.model.installed, true);
  assert.equal(st.runtime.installed, true);
  assert.equal(fs.existsSync(path.join(dataDir, "local-ai", "models", "asr1.gguf")), false);
  assert.equal(fs.existsSync(path.join(dataDir, "local-ai", "models", "mm1.gguf")), false);
  assert.ok(aiProviders.get().providers.some((p) => p.id === "gemini"));
  assert.equal(aiProviders.get().providers.some((p) => p.id === "local-stt"), false);
});

test("importFile(stt): 本体と mmproj を 1 つずつ選ぶ。2 つ揃うまで登録しない／別のファイルは拒否", async () => {
  const { ai } = sttSetup();
  const dir = tmp();
  const f1 = path.join(dir, "a.gguf"), f2 = path.join(dir, "b.gguf"), bad = path.join(dir, "c.gguf");
  fs.writeFileSync(f1, STT_MAIN); fs.writeFileSync(f2, STT_MM); fs.writeFileSync(bad, Buffer.concat([Buffer.from("GGUF"), crypto.randomBytes(40)]));
  assert.deepEqual(await ai.importFile({ file: f1 }), { ok: true, kind: "stt-part", id: "asr1", complete: false });
  assert.equal(ai.status().stt.registered, false, "片方だけでは登録しない");
  assert.equal((await ai.importFile({ file: bad })).ok, false);
  assert.deepEqual(await ai.importFile({ file: f2 }), { ok: true, kind: "stt-model", id: "asr1", complete: true });
  assert.equal(ai.status().stt.registered, true);
});

test("sweepStale: 音声入力の残骸も、目印の接頭辞が合うものだけ止める", () => {
  const killed = [];
  const dataDir = tmp();
  aiProviders.init(dataDir);
  aiProviders.save(EXAMPLE_PROVIDERS);
  const mark = "0123456789abcdef";
  const rec = path.join(dataDir, "local-ai", "server-stt.json");
  fs.mkdirSync(path.dirname(rec), { recursive: true });
  fs.writeFileSync(rec, JSON.stringify({ pid: 5151, port: 5000, mark }));
  let ai = L.createLocalAi({ dataDir, manifest: sttManifest(), aiProviders, kill: (pid) => killed.push(pid), isAlive: () => true, readCmdline: () => `llama-server --alias graphy-local-llm:${mark}` });
  ai.sweepStale();
  assert.deepEqual(killed, [], "会話用の目印では音声入力の残骸を止めない");
  fs.writeFileSync(rec, JSON.stringify({ pid: 5151, port: 5000, mark }));
  ai = L.createLocalAi({ dataDir, manifest: sttManifest(), aiProviders, kill: (pid) => killed.push(pid), isAlive: () => true, readCmdline: () => `llama-server --alias graphy-local-stt:${mark}` });
  ai.sweepStale();
  assert.deepEqual(killed, [5151]);
  assert.equal(fs.existsSync(rec), false);
});
