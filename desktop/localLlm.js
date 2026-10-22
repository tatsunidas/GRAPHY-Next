// この PC のローカル LLM（llama.cpp の llama-server + 小型 GGUF）の導入・起動・登録。
// 設計: fw/ai-routing-design.md §18
//
// 🔴 取得は localAiInstaller（許可ホスト・sha256）だけを通す。ここに URL は書かない（マニフェストから引く）。
// 🔴 llama-server は 127.0.0.1 にだけ bind する。0.0.0.0 にしない。
// 🔴 登録する提供元は固定 id `local-llm`・auth:"none"・loopback。endpoint（ポート）は起動のたびに main がここで書き換える。
//    renderer 経由の保存では endpoint を変えさせない（pinManaged）。
// 🔴 起動したのは「コマンド行に目印（--alias）がある自分のプロセス」だけ。他人のプロセスは止めない。
// 🔴 electron を import しない（CI の Desktop ジョブは npm install しない）。引数は配列で spawn に渡し、shell は使わない。

const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const childProcess = require("node:child_process");
const installer = require("./localAiInstaller");
const archive = require("./localAiArchive");
const { childEnv } = require("./localPython");
const { defaultReadCmdline } = require("./localJupyter");

const PROVIDER_ID = "local-llm";
const PROVIDER_LABEL = "Local LLM (this PC)";
const MARK_PREFIX = "graphy-local-llm:";
/** 未起動のときの endpoint。何も待ち受けない予約ポート(tcpmux)——古いポートが別のものに当たらないように。 */
const PARKED_ENDPOINT = "http://127.0.0.1:1";
/** 文脈長。暫定（モデルと RAM に依存する。実測で見直す）。 */
const CONTEXT_TOKENS = 8192;
/** 使われなくなってから止めるまでの時間。暫定（実測で見直す）。 */
const IDLE_STOP_MS = 10 * 60 * 1000;
/** 起動（モデルの読み込み）を待つ上限。暫定。大きいモデル＋遅いディスクを想定して長めに取る。 */
const HEALTH_WAIT_MS = 5 * 60 * 1000;
const STOP_WAIT_MS = 8000;
const POLL_MS = 300;

// ── 純関数 ───────────────────────────────────────────────────────────────

function newMark() {
  return crypto.randomBytes(8).toString("hex");
}

function cmdlineHasMark(cmdline, mark) {
  return typeof cmdline === "string" && /^[0-9a-f]{16}$/.test(String(mark)) && cmdline.includes(MARK_PREFIX + mark);
}

function parseRecord(text) {
  try {
    const r = JSON.parse(text);
    if (!r || !Number.isInteger(r.pid) || r.pid <= 1 || !Number.isInteger(r.port)) return null;
    if (typeof r.mark !== "string" || !/^[0-9a-f]{16}$/.test(r.mark)) return null;
    return { pid: r.pid, port: r.port, mark: r.mark };
  } catch {
    return null;
  }
}

/**
 * 生成に使うスレッド数。論理 CPU の半分(最低 2)。
 * 根拠は 1 台の実測だけ(Core Ultra 7 255H・16 コア・SMT 無し・Qwen3 4B Q4_K_M):
 * llama.cpp の既定は 3 スレッドで 9.4 tok/s、8 で 17.9、16 で 8.6。トークン生成はメモリ帯域律速で、
 * 論理 CPU 全部を使うと逆に遅くなる。SMT 有りの CPU では物理コア数に当たるはず。他の CPU は未計測(暫定)。
 */
function defaultThreads(logicalCpus) {
  return Math.max(2, Math.floor((Number(logicalCpus) || 4) / 2));
}

/** llama-server の引数。host は 127.0.0.1 固定。 */
function serverArgs({ modelPath, port, mark, ctx = CONTEXT_TOKENS, jinja = false, reasoning = null, threads = null }) {
  return [
    "-m", modelPath,
    "--host", "127.0.0.1",
    "--port", String(port),
    "-c", String(ctx),
    "--alias", MARK_PREFIX + mark,
    ...(Number.isInteger(threads) && threads > 0 ? ["-t", String(threads)] : []),
    "--no-webui", // 同じ loopback に別のアプリ・ページから触られる面を減らす（API だけ使う）
    ...(jinja ? ["--jinja"] : []),
    // 思考(<think>)付きのモデルは、応答が数倍遅くなる。画面操作の補助には不要なので、マニフェストで "off" にできる
    ...(["on", "off", "auto"].includes(reasoning) ? ["--reasoning", reasoning] : []),
  ];
}

/** 保存済みの構成を normalize に通せる形へ（実行時だけの `plaintext` を落とす）。 */
function toRaw(cfg) {
  return {
    providers: cfg.providers.map(({ plaintext, ...rest }) => rest),
    defaults: { ...cfg.defaults },
    fallbacks: { ...(cfg.fallbacks || {}) },
  };
}

/**
 * renderer から来た保存要求の `local-llm` を、main が持っている値に差し戻す。
 * 🔴 endpoint を renderer（＝プラグインも同じ realm）に変えさせない。無ければ（未導入）要求側の `local-llm` は捨てる。
 */
function pinManaged(incomingProviders, currentProviders) {
  const cur = currentProviders.find((p) => p.id === PROVIDER_ID);
  const rest = incomingProviders.filter((p) => !(p && p.id === PROVIDER_ID));
  return cur ? [...rest, (({ plaintext, ...r }) => r)(cur)] : rest;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === "EPERM"); }
}

function defaultKill(pid, { platform = process.platform, force = false } = {}) {
  try {
    if (platform === "win32") childProcess.execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    else process.kill(pid, force ? "SIGKILL" : "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

// ── 本体 ─────────────────────────────────────────────────────────────────

/**
 * @param deps.dataDir      データ置き場（<dataDir>/local-ai/ の下を使う）
 * @param deps.manifest     検査済みのマニフェスト
 * @param deps.aiProviders  { get, save }（aiProviders.js）
 * @param deps.emit         進捗・状態の通知 (event) => void
 * 試験では download・spawn・fetch・kill などを差し替える。
 */
function createLocalAi(deps) {
  const platform = deps.platform || process.platform;
  const arch = deps.arch || process.arch;
  const env = deps.env || process.env;
  const manifest = deps.manifest;
  const ai = deps.aiProviders;
  const emit = deps.emit || (() => {});
  const spawn = deps.spawn || childProcess.spawn;
  const doFetch = deps.fetch || globalThis.fetch;
  const kill = deps.kill || ((pid, o) => defaultKill(pid, { platform, ...o }));
  const alive = deps.isAlive || isAlive;
  const readCmdline = deps.readCmdline || ((pid) => defaultReadCmdline(pid, platform));
  const pickPort = deps.freePort || freePort;
  const download = deps.download || installer.download;
  const idleMs = deps.idleMs ?? IDLE_STOP_MS;
  const healthWaitMs = deps.healthWaitMs ?? HEALTH_WAIT_MS;

  const root = path.join(deps.dataDir, "local-ai");
  const runtimeRoot = path.join(root, "runtime");
  const modelsDir = path.join(root, "models");
  const stateFile = path.join(root, "state.json");
  const recordFile = path.join(root, "server.json");
  const key = installer.platformKey(platform, arch);
  const asset = manifest.runtime.assets[key] || null;

  let current = null; // { child, port, mark, exited, log }
  let starting = null;
  let installing = null; // { abort }
  let idleTimer = null;

  // ── 状態 ──
  function readState() {
    try {
      const s = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      return s && typeof s === "object" ? s : {};
    } catch {
      return {};
    }
  }
  function writeState(s) {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(s, null, 1), { mode: 0o600 });
  }
  function runtimeExe(s = readState()) {
    if (!s.runtime || !s.runtime.exe) return null;
    const p = path.join(runtimeRoot, s.runtime.exe);
    // state.json が改ざんされても runtime 配下の外は実行しない
    if (!archive.safeJoin(runtimeRoot, s.runtime.exe)) return null;
    return fs.existsSync(p) ? p : null;
  }
  function modelPath(s = readState()) {
    if (!s.model || !s.model.file) return null;
    if (!archive.safeJoin(modelsDir, s.model.file)) return null;
    const p = path.join(modelsDir, s.model.file);
    return fs.existsSync(p) ? p : null;
  }
  function manifestModel(id) {
    return manifest.models.find((m) => m.id === id) || null;
  }

  function status() {
    const s = readState();
    const cfg = ai.get();
    const prov = cfg.providers.find((p) => p.id === PROVIDER_ID);
    const exe = runtimeExe(s);
    const mp = modelPath(s);
    return {
      supported: !!asset,
      platform: key,
      models: manifest.models.map(({ id, label, size, license, licenseUrl, note }) => ({ id, label, size, license, licenseUrl, note })),
      runtime: { installed: !!exe, build: s.runtime ? s.runtime.build : null, size: asset ? asset.size : null },
      model: { installed: !!mp, id: s.model ? s.model.id : null, verified: s.model ? !!s.model.verified : false, file: s.model ? s.model.file : null },
      running: !!(current && !current.exited),
      busy: !!installing,
      registered: !!prov,
      isDefault: cfg.defaults["text-to-text"] === PROVIDER_ID,
      isFallback: ((cfg.fallbacks || {})["text-to-text"] || []).includes(PROVIDER_ID),
    };
  }

  // ── 提供元の登録 ──
  function registerProvider({ endpoint, model, toolMode }) {
    const cfg = ai.get();
    const raw = toRaw(cfg);
    const entry = {
      id: PROVIDER_ID, label: PROVIDER_LABEL, kind: "openai", endpoint, auth: "none",
      models: { "text-to-text": model }, toolMode: toolMode === "native" ? "native" : "none",
    };
    const i = raw.providers.findIndex((p) => p.id === PROVIDER_ID);
    if (i >= 0) raw.providers[i] = entry;
    else raw.providers.push(entry);
    return ai.save(raw);
  }
  function unregisterProvider() {
    const cfg = ai.get();
    if (!cfg.providers.some((p) => p.id === PROVIDER_ID)) return { ok: true, problems: [] };
    const raw = toRaw(cfg);
    raw.providers = raw.providers.filter((p) => p.id !== PROVIDER_ID);
    for (const cap of Object.keys(raw.fallbacks)) raw.fallbacks[cap] = raw.fallbacks[cap].filter((id) => id !== PROVIDER_ID);
    const s = readState();
    for (const cap of Object.keys(raw.defaults)) {
      if (raw.defaults[cap] === PROVIDER_ID) delete raw.defaults[cap];
    }
    // 既定だった用途は、元の既定へ戻す（残っていれば）
    if (s.previousDefault && raw.providers.some((p) => p.id === s.previousDefault)) raw.defaults["text-to-text"] = s.previousDefault;
    if (raw.providers.length === 0) return { ok: false, problems: ["config:no-usable-provider"] };
    return ai.save(raw);
  }

  /** 「縮退先にする」「既定にする」の切り替え。 */
  function setRole({ fallback, makeDefault }) {
    const cfg = ai.get();
    if (!cfg.providers.some((p) => p.id === PROVIDER_ID)) return { ok: false, error: "not-registered" };
    const raw = toRaw(cfg);
    const list = new Set(raw.fallbacks["text-to-text"] || []);
    if (typeof fallback === "boolean") {
      if (fallback) list.add(PROVIDER_ID);
      else list.delete(PROVIDER_ID);
      if (list.size) raw.fallbacks["text-to-text"] = [...list];
      else delete raw.fallbacks["text-to-text"];
    }
    if (typeof makeDefault === "boolean") {
      const s = readState();
      if (makeDefault) {
        if (raw.defaults["text-to-text"] !== PROVIDER_ID) s.previousDefault = raw.defaults["text-to-text"] || null;
        raw.defaults["text-to-text"] = PROVIDER_ID;
        writeState(s);
      } else if (raw.defaults["text-to-text"] === PROVIDER_ID) {
        const prev = s.previousDefault;
        if (prev && raw.providers.some((p) => p.id === prev && p.models["text-to-text"])) raw.defaults["text-to-text"] = prev;
        else delete raw.defaults["text-to-text"]; // normalize が使える最初の提供元へ落とす
      }
    }
    const r = ai.save(raw);
    return r.ok ? { ok: true } : { ok: false, error: r.problems[0] || "save-failed" };
  }

  // ── 導入 ──
  function progress(phase, extra = {}) {
    emit({ type: "progress", phase, ...extra });
  }

  /** 実行ファイルを展開して state に記録する。archiveFile は検証済みであること。 */
  function installRuntimeFrom(archiveFile) {
    const dest = path.join(runtimeRoot, `build-${manifest.runtime.build}`);
    const tmpDest = `${dest}.tmp-${process.pid}`;
    fs.rmSync(tmpDest, { recursive: true, force: true });
    try {
      archive.extractArchive(archiveFile, tmpDest);
      const found = archive.findFile(tmpDest, asset.exe);
      if (!found) throw new Error("exe-not-found");
      if (platform !== "win32") fs.chmodSync(found, 0o755);
      fs.rmSync(dest, { recursive: true, force: true });
      fs.renameSync(tmpDest, dest);
      const rel = path.relative(runtimeRoot, path.join(dest, path.relative(tmpDest, found)));
      const s = readState();
      s.runtime = { build: manifest.runtime.build, exe: rel.split(path.sep).join("/") };
      writeState(s);
      return { ok: true };
    } catch (e) {
      fs.rmSync(tmpDest, { recursive: true, force: true });
      return { ok: false, error: `extract-failed:${e.message}` };
    }
  }

  async function install({ modelId } = {}) {
    if (!asset) return { ok: false, error: "unsupported-platform" };
    const md = manifestModel(modelId);
    if (!md) return { ok: false, error: "unknown-model" };
    if (installing) return { ok: false, error: "busy" };
    const ac = new AbortController();
    installing = { abort: ac };
    fs.mkdirSync(path.join(root, "downloads"), { recursive: true });
    fs.mkdirSync(modelsDir, { recursive: true });
    try {
      const s0 = readState();
      if (!runtimeExe(s0) || (s0.runtime && s0.runtime.build !== manifest.runtime.build)) {
        const arc = path.join(root, "downloads", asset.file);
        progress("runtime-download", { received: 0, total: asset.size });
        const r = await download({ url: asset.url, dest: arc, sha256: asset.sha256, size: asset.size, signal: ac.signal,
          onProgress: (p) => progress("runtime-download", p) });
        if (!r.ok) return r;
        progress("runtime-extract");
        const x = installRuntimeFrom(arc);
        fs.rmSync(arc, { force: true });
        if (!x.ok) return x;
      }
      const dest = path.join(modelsDir, md.file);
      if (!fs.existsSync(dest)) {
        progress("model-download", { received: 0, total: md.size });
        const r = await download({ url: md.url, dest, sha256: md.sha256, size: md.size, signal: ac.signal,
          onProgress: (p) => progress("model-download", p) });
        if (!r.ok) return r;
      }
      const s = readState();
      s.model = { id: md.id, file: md.file, verified: true, toolMode: md.toolMode === "native" ? "native" : "none" };
      writeState(s);
      const reg = registerProvider({ endpoint: PARKED_ENDPOINT, model: md.id, toolMode: s.model.toolMode });
      if (!reg.ok) return { ok: false, error: `register-failed:${reg.problems[0] || ""}` };
      progress("done");
      return { ok: true };
    } finally {
      installing = null;
    }
  }

  function cancelInstall() {
    if (installing) installing.abort.abort();
  }

  /**
   * オフライン手動導入。利用者が選んだファイルを sha256 でマニフェストと突き合わせる。
   * 🔴 一致しないものは受け付けない。ただし GGUF だけは `allowUnverified` のとき「検証なし」と記録して受け付ける
   *    （自分で用意したモデルを使いたい上級者向け。画面で明示する）。
   */
  async function importFile({ file, allowUnverified = false }) {
    if (!asset) return { ok: false, error: "unsupported-platform" };
    if (typeof file !== "string" || !path.isAbsolute(file)) return { ok: false, error: "bad-path" };
    if (installing) return { ok: false, error: "busy" };
    installing = { abort: new AbortController() };
    try {
      let st;
      try { st = fs.statSync(file); } catch { return { ok: false, error: "not-found" }; }
      if (!st.isFile()) return { ok: false, error: "not-a-file" };
      const digest = await installer.sha256File(file);
      if (digest === asset.sha256 && st.size === asset.size) {
        const x = installRuntimeFrom(file);
        return x.ok ? { ok: true, kind: "runtime" } : x;
      }
      const md = manifest.models.find((m) => m.sha256 === digest && m.size === st.size);
      fs.mkdirSync(modelsDir, { recursive: true });
      if (md) {
        const dest = path.join(modelsDir, md.file);
        fs.copyFileSync(file, dest);
        const s = readState();
        s.model = { id: md.id, file: md.file, verified: true, toolMode: md.toolMode === "native" ? "native" : "none" };
        writeState(s);
        const reg = registerProvider({ endpoint: PARKED_ENDPOINT, model: md.id, toolMode: s.model.toolMode });
        return reg.ok ? { ok: true, kind: "model", id: md.id, verified: true } : { ok: false, error: `register-failed:${reg.problems[0] || ""}` };
      }
      if (allowUnverified && /\.gguf$/i.test(file)) {
        const head = Buffer.alloc(4);
        const fd = fs.openSync(file, "r");
        try { fs.readSync(fd, head, 0, 4, 0); } finally { fs.closeSync(fd); }
        if (head.toString("latin1") !== "GGUF") return { ok: false, error: "not-gguf" };
        const name = `custom-${digest.slice(0, 12)}.gguf`;
        fs.copyFileSync(file, path.join(modelsDir, name));
        const s = readState();
        s.model = { id: "custom", file: name, verified: false, toolMode: "none" };
        writeState(s);
        const reg = registerProvider({ endpoint: PARKED_ENDPOINT, model: "custom", toolMode: "none" });
        return reg.ok ? { ok: true, kind: "model", id: "custom", verified: false } : { ok: false, error: `register-failed:${reg.problems[0] || ""}` };
      }
      return { ok: false, error: "unknown-file" };
    } finally {
      installing = null;
    }
  }

  // ── 起動・停止 ──
  function writeRecord(r) {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(recordFile, JSON.stringify(r), { mode: 0o600 });
  }
  function removeRecord() {
    try { fs.unlinkSync(recordFile); } catch { /* 無ければよい */ }
  }

  async function health(port, signal) {
    try {
      const res = await doFetch(`http://127.0.0.1:${port}/health`, { signal });
      return res.status;
    } catch {
      return 0;
    }
  }

  async function terminate(st) {
    if (!st || st.exited) return;
    if (st.child.pid) kill(st.child.pid, { force: false });
    const t0 = Date.now();
    while (!st.exited && Date.now() - t0 < (deps.stopWaitMs ?? STOP_WAIT_MS)) await sleep(100);
    if (!st.exited && st.child.pid) kill(st.child.pid, { force: true });
    const t1 = Date.now();
    while (!st.exited && Date.now() - t1 < 2000) await sleep(50);
  }

  function armIdle() {
    clearTimeout(idleTimer);
    if (idleMs > 0) {
      idleTimer = setTimeout(() => { stop().catch(() => undefined); }, idleMs);
      if (idleTimer.unref) idleTimer.unref();
    }
  }

  async function startServer(signal) {
    const s = readState();
    const exe = runtimeExe(s);
    const mp = modelPath(s);
    if (!exe || !mp) return { ok: false, error: "not-installed" };
    const port = await pickPort();
    const mark = newMark();
    const child = spawn(exe, serverArgs({ modelPath: mp, port, mark, jinja: !!(s.model && s.model.toolMode === "native"), reasoning: (manifestModel(s.model && s.model.id) || {}).reasoning, threads: defaultThreads(deps.cpuCount ?? os.availableParallelism()) }), {
      env: childEnv(env), cwd: path.dirname(exe), stdio: ["ignore", "pipe", "pipe"], shell: false, windowsHide: true, detached: false,
    });
    const st = { child, port, mark, exited: false, log: "" };
    const onData = (b) => { st.log = (st.log + String(b)).slice(-4000); };
    child.stdout && child.stdout.on("data", onData);
    child.stderr && child.stderr.on("data", onData);
    let spawnError = null;
    child.once("error", (e) => { spawnError = e; st.exited = true; });
    child.once("exit", () => { st.exited = true; if (current === st) { current = null; removeRecord(); emit({ type: "state" }); } });
    if (child.pid) writeRecord({ pid: child.pid, port, mark });
    const t0 = Date.now();
    for (;;) {
      if (signal && signal.aborted) { await terminate(st); removeRecord(); return { ok: false, error: "canceled" }; }
      if (st.exited) break;
      if ((await health(port, signal)) === 200) { current = st; return { ok: true, st }; }
      if (Date.now() - t0 > healthWaitMs) { await terminate(st); removeRecord(); return { ok: false, error: "start-timeout", log: st.log }; }
      await sleep(deps.pollMs ?? POLL_MS);
    }
    removeRecord();
    return { ok: false, error: spawnError ? `spawn-failed:${spawnError.code || spawnError.message}` : "server-exited", log: st.log };
  }

  /** 動いていなければ起動し、提供元の endpoint を実ポートに更新する。同時に呼ばれても起動は 1 回。 */
  function ensure(signal) {
    if (current && !current.exited) { armIdle(); return Promise.resolve({ ok: true, port: current.port }); }
    if (starting) return starting;
    starting = (async () => {
      emit({ type: "starting" });
      const r = await startServer(signal);
      if (!r.ok) { emit({ type: "state" }); return r; }
      const s = readState();
      const reg = registerProvider({ endpoint: `http://127.0.0.1:${r.st.port}`, model: (s.model && s.model.id) || "local", toolMode: s.model && s.model.toolMode });
      if (!reg.ok) { await terminate(r.st); return { ok: false, error: `register-failed:${reg.problems[0] || ""}` }; }
      armIdle();
      emit({ type: "state" });
      return { ok: true, port: r.st.port };
    })().finally(() => { starting = null; });
    return starting;
  }

  /** ゲートウェイが送る直前に呼ぶ。local-llm 以外は何もしない。 */
  async function prepare(provider, signal) {
    if (!provider || provider.id !== PROVIDER_ID) return { ok: true };
    const r = await ensure(signal);
    return r.ok ? { ok: true } : { ok: false, error: `local-llm:${r.error}` };
  }

  async function stop() {
    clearTimeout(idleTimer);
    if (starting) await starting.catch(() => undefined);
    const st = current;
    current = null;
    await terminate(st);
    removeRecord();
    // 止めたら、古いポートが残らないように予約ポートへ戻す
    const prov = ai.get().providers.find((p) => p.id === PROVIDER_ID);
    if (prov && prov.endpoint !== PARKED_ENDPOINT) {
      const s = readState();
      registerProvider({ endpoint: PARKED_ENDPOINT, model: (s.model && s.model.id) || "local", toolMode: s.model && s.model.toolMode });
    }
    emit({ type: "state" });
  }

  function sweepStale() {
    let text;
    try { text = fs.readFileSync(recordFile, "utf8"); } catch { return { swept: false, reason: "no-record" }; }
    const rec = parseRecord(text);
    if (!rec) { removeRecord(); return { swept: false, reason: "bad-record" }; }
    if (!alive(rec.pid)) { removeRecord(); return { swept: false, reason: "not-running" }; }
    if (!cmdlineHasMark(readCmdline(rec.pid), rec.mark)) { removeRecord(); return { swept: false, reason: "not-ours" }; }
    kill(rec.pid, { force: false });
    removeRecord();
    return { swept: true, pid: rec.pid };
  }

  /** 起動して /health を確かめる（設定画面の「起動テスト」）。起動に掛かった時間も返す。 */
  async function check() {
    const t0 = Date.now();
    const wasRunning = !!(current && !current.exited);
    const r = await ensure();
    if (!r.ok) return { ok: false, error: r.error, log: r.log };
    const code = await health(r.port);
    return code === 200 ? { ok: true, startedMs: wasRunning ? 0 : Date.now() - t0 } : { ok: false, error: `health-${code}` };
  }

  async function remove() {
    if (installing) { cancelInstall(); return { ok: false, error: "busy" }; }
    await stop();
    const r = unregisterProvider();
    fs.rmSync(root, { recursive: true, force: true });
    emit({ type: "state" });
    return r.ok ? { ok: true } : { ok: false, error: r.problems[0] || "save-failed" };
  }

  return { status, install, cancelInstall, importFile, ensure, check, prepare, stop, sweepStale, remove, setRole };
}

let instance = null;

function init(deps) {
  instance = createLocalAi(deps);
  return instance;
}

module.exports = {
  PROVIDER_ID,
  PROVIDER_LABEL,
  MARK_PREFIX,
  PARKED_ENDPOINT,
  newMark,
  cmdlineHasMark,
  parseRecord,
  serverArgs,
  defaultThreads,
  pinManaged,
  createLocalAi,
  init,
  get: () => instance,
};
