// この PC の Python で Jupyter Server を起動・停止する（接続先 id "local"）。
// 設計: fw/remote-compute-design.md §22（この PC の Jupyter の起動・停止）
//
// 🔴 本体は pip・conda を呼ばない。起動するのは利用者の Python（localPython が選んだもの）だけ。
// 🔴 トークンは引数に載せず環境変数 JUPYTER_TOKEN で渡す（引数は ps・タスクマネージャで他の利用者に見える）。メモリにだけ持つ。
// 🔴 electron を import しない（CI の Desktop ジョブは npm install しない）。
// 🔴 引数は配列で spawn に渡し、shell は使わない。renderer から来た文字列は引数に入らない。
//
// 後始末は三重: ① 正常終了は POST /api/shutdown → 待ち → 強制終了、② 親（Electron）が死ぬと
// LAUNCHER が stdin の EOF を見て自分で止まる、③ 起動時に server.json の PID を目印つきで探して止める。

const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const crypto = require("node:crypto");
const childProcess = require("node:child_process");
const { childEnv } = require("./localPython");

const ENDPOINT_ID = "local";
/** サーバが止まるのを待つ時間。ComputeJobRunner の「interrupt → 10 秒で止まらなければ shutdown」と同じ値。 */
const STOP_WAIT_MS = 10000;
const POLL_MS = 300;

/**
 * Jupyter Server を起動する固定コード（`python -c`）。.py を別に置かない＝配布物の載せ忘れを起こさない。
 * 目印（MARK_PREFIX + 乱数）はこのコードの先頭のコメントに入り、プロセスのコマンド行に残る（③で自分のものか見分ける）。
 * 親が死んで stdin が閉じたら、サーバを止める（止まらなければ 10 秒後に自分を終える）。
 * 引用符は単一引用符だけ・バックスラッシュ無し。
 */
const MARK_PREFIX = "graphy-local-jupyter:";
function launcher(mark) {
  return [
    `# ${MARK_PREFIX}${mark}`,
    "import sys, os, threading, time",
    "from jupyter_server.serverapp import ServerApp",
    "def _watch():",
    "    try:",
    "        sys.stdin.buffer.read()",
    "    except Exception:",
    "        pass",
    "    try:",
    "        app = ServerApp.instance()",
    "        app.io_loop.add_callback(app.stop)",
    "    except Exception:",
    `        os._exit(0)`,
    `    time.sleep(${Math.round(STOP_WAIT_MS / 1000)})`,
    "    os._exit(0)",
    "threading.Thread(target=_watch, daemon=True).start()",
    "ServerApp.launch_instance()",
  ].join("\n");
}

// ── 純関数 ───────────────────────────────────────────────────────────────

/** 起動の引数（Python の後ろ）。ip は 127.0.0.1 固定・ポートは使えなければ失敗（選び直さない）。 */
function serverArgs({ port, workDir }) {
  return [
    "--ServerApp.ip=127.0.0.1",
    `--ServerApp.port=${port}`,
    "--ServerApp.port_retries=0",
    "--ServerApp.open_browser=False",
    `--ServerApp.root_dir=${workDir}`,
    "--ServerApp.terminals_enabled=False",
  ];
}

/**
 * 子プロセスの環境。GRAPHY_*・ELECTRON_* を除き（localPython.childEnv）、
 * 利用者の Jupyter 設定を読ませない（ip=0.0.0.0 などを効かせない）ためにフォルダを本体専用にする。
 */
function serverEnv(env, { token, jupyterDir }) {
  return {
    ...childEnv(env),
    JUPYTER_TOKEN: token,
    JUPYTER_CONFIG_DIR: path.join(jupyterDir, "config"),
    JUPYTER_DATA_DIR: path.join(jupyterDir, "data"),
    JUPYTER_RUNTIME_DIR: path.join(jupyterDir, "runtime"),
    PYTHONUNBUFFERED: "1",
  };
}

/**
 * 専用の `python3` カーネル仕様。🔴 JUPYTER_DATA_DIR を専用フォルダにしても、利用者の
 * `~/.local/share/jupyter/kernels` は検索パスに残る（実測: そこの python3 が別の環境を指していて、
 * カーネルが選んだ Python と別の Python で動いた）。専用フォルダは検索パスの先頭なので、
 * ここに同じ名前（python3）で置けば、バックエンドが選ぶ python3 は必ずこちらに解決される。
 */
function kernelSpec(python) {
  return {
    argv: [python, "-m", "ipykernel_launcher", "-f", "{connection_file}"],
    display_name: "Python 3 (GRAPHY)",
    language: "python",
  };
}

/** 起動のたびに変わる目印（秘密ではない。トークンとは別の乱数）。 */
function newMark() {
  return crypto.randomBytes(8).toString("hex");
}

function newToken() {
  return crypto.randomBytes(32).toString("hex");
}

/** コマンド行が、この目印で起動したもの（＝本体が起動したもの）か。PID の再利用で他人のプロセスを止めないための判定。 */
function cmdlineHasMark(cmdline, mark) {
  return typeof cmdline === "string" && typeof mark === "string" && /^[0-9a-f]{16}$/.test(mark) && cmdline.includes(MARK_PREFIX + mark);
}

/** server.json（前回の記録）を読む。壊れていれば null。 */
function parseRecord(text) {
  try {
    const r = JSON.parse(text);
    if (!r || typeof r !== "object") return null;
    if (!Number.isInteger(r.pid) || r.pid <= 1 || !Number.isInteger(r.port)) return null;
    if (typeof r.mark !== "string" || !/^[0-9a-f]{16}$/.test(r.mark)) return null;
    return { pid: r.pid, port: r.port, mark: r.mark, startedAt: Number(r.startedAt) || 0 };
  } catch {
    return null;
  }
}

// ── 副作用 ───────────────────────────────────────────────────────────────

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 既定のコマンド行の読み出し（OS ごと）。読めなければ null。 */
function defaultReadCmdline(pid, platform = process.platform, deps = {}) {
  const execFileSync = deps.execFileSync || childProcess.execFileSync;
  try {
    if (platform === "linux") return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ");
    if (platform === "win32") {
      return String(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`], { encoding: "utf8", windowsHide: true, timeout: 15000 }));
    }
    return String(execFileSync("ps", ["-p", String(Number(pid)), "-o", "command="], { encoding: "utf8", timeout: 15000 }));
  } catch {
    return null;
  }
}

function defaultKill(pid, { platform = process.platform, force = false } = {}) {
  try {
    if (platform === "win32") {
      // 子孫ごと止める（npm が spawn した子と同じで、/T が無いとカーネルが残る）
      childProcess.execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    } else {
      process.kill(pid, force ? "SIGKILL" : "SIGTERM");
    }
    return true;
  } catch {
    return false;
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return !!(e && e.code === "EPERM");
  }
}

/**
 * @param deps.dataDir   データ置き場（<dataDir>/compute-local/ の下を使う）
 * 試験では spawn・fetch・kill などを差し替える。
 */
function createJupyter(deps) {
  const platform = deps.platform || process.platform;
  const env = deps.env || process.env;
  const spawn = deps.spawn || childProcess.spawn;
  const doFetch = deps.fetch || globalThis.fetch;
  const kill = deps.kill || ((pid, o) => defaultKill(pid, { platform, ...o }));
  const alive = deps.isAlive || isAlive;
  const readCmdline = deps.readCmdline || ((pid) => defaultReadCmdline(pid, platform));
  const pickPort = deps.freePort || freePort;
  const root = path.join(deps.dataDir, "compute-local");
  const jupyterDir = path.join(root, "jupyter");
  const workDir = path.join(root, "work");
  const recordFile = path.join(root, "server.json");

  let current = null; // { child, port, token, url, mark, python, exited }
  let starting = null;
  let abort = null;

  function writeRecord(r) {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(recordFile, JSON.stringify(r), { mode: 0o600 });
  }
  function removeRecord() {
    try { fs.unlinkSync(recordFile); } catch { /* 無ければよい */ }
  }

  async function status(port, token, signal) {
    try {
      const res = await doFetch(`http://127.0.0.1:${port}/api/status`, { headers: { Authorization: `token ${token}` }, signal });
      return res.status;
    } catch {
      return 0;
    }
  }

  /** 起動し直す。取り消し・プロセス終了で打ち切る（待ち時間に上限の数字は置かない）。 */
  async function start(python, signal) {
    for (const d of ["config", "data", "runtime"]) fs.mkdirSync(path.join(jupyterDir, d), { recursive: true });
    fs.mkdirSync(workDir, { recursive: true });
    const kernelDir = path.join(jupyterDir, "data", "kernels", "python3");
    fs.mkdirSync(kernelDir, { recursive: true });
    fs.writeFileSync(path.join(kernelDir, "kernel.json"), JSON.stringify(kernelSpec(python), null, 1));
    let lastFail = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const port = await pickPort();
      const token = newToken();
      const mark = newMark();
      const child = spawn(python, ["-c", launcher(mark), ...serverArgs({ port, workDir })], {
        env: serverEnv(env, { token, jupyterDir }),
        cwd: root,
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
        detached: false,
      });
      const st = { child, port, token, mark, python, url: `http://127.0.0.1:${port}/`, exited: false, log: "" };
      const onData = (b) => { st.log = (st.log + String(b)).slice(-4000); };
      child.stdout && child.stdout.on("data", onData);
      child.stderr && child.stderr.on("data", onData);
      child.stdin && child.stdin.on("error", () => { /* 子が先に終わったとき */ });
      let spawnError = null;
      child.once("error", (e) => { spawnError = e; st.exited = true; });
      child.once("exit", () => { st.exited = true; if (current === st) { current = null; removeRecord(); } });
      if (child.pid) writeRecord({ pid: child.pid, port, mark, startedAt: Date.now() });
      for (;;) {
        if (signal && signal.aborted) {
          await terminate(st);
          return { ok: false, aborted: true };
        }
        if (st.exited) break;
        if ((await status(port, token, signal)) === 200) {
          current = st;
          return { ok: true, st };
        }
        await sleep(POLL_MS);
      }
      removeRecord();
      lastFail = { reason: spawnError ? `spawn-failed:${spawnError.code || spawnError.message}` : "server-exited", log: st.log };
      // ポートを取られた（閉じてから使うまでの間）ときだけ選び直す。同じ失敗が 2 回続いたら別の原因とみて止める
      if (!/address already in use|port .* in use/i.test(st.log)) break;
    }
    return { ok: false, reason: lastFail ? lastFail.reason : "server-exited", log: lastFail ? lastFail.log : "" };
  }

  /** 正常終了を促し、待っても終わらなければ強制終了。 */
  async function terminate(st) {
    if (!st || st.exited) return;
    try { await doFetch(`http://127.0.0.1:${st.port}/api/shutdown`, { method: "POST", headers: { Authorization: `token ${st.token}` } }); } catch { /* 下で止める */ }
    try { st.child.stdin && st.child.stdin.end(); } catch { /* 閉じていれば足りる */ }
    const t0 = Date.now();
    while (!st.exited && Date.now() - t0 < (deps.stopWaitMs ?? STOP_WAIT_MS)) await sleep(100);
    if (!st.exited && st.child.pid) kill(st.child.pid, { force: true });
    const t1 = Date.now();
    while (!st.exited && Date.now() - t1 < 2000) await sleep(50);
  }

  /** 動いていなければ起動し、接続先として登録簿に入れる形を返す。同時に呼ばれても起動は 1 回。 */
  function ensure(python) {
    if (current && !current.exited && current.python === python) {
      return Promise.resolve({ ok: true, id: ENDPOINT_ID, url: current.url, port: current.port, token: current.token, python });
    }
    if (starting) return starting;
    abort = new AbortController();
    const signal = abort.signal;
    starting = (async () => {
      if (current) await terminate(current);
      const r = await start(python, signal);
      if (!r.ok) return r.aborted ? { ok: false, error: "canceled" } : { ok: false, error: r.reason, log: r.log };
      return { ok: true, id: ENDPOINT_ID, url: r.st.url, port: r.st.port, token: r.st.token, python };
    })().finally(() => { starting = null; abort = null; });
    return starting;
  }

  /** 起動中のものの接続先（登録簿へ入れる形）。無ければ null。トークンを含むので renderer へ返さない。 */
  function endpoint() {
    if (!current || current.exited) return null;
    return { id: ENDPOINT_ID, label: "this-pc", url: current.url, kind: "local", token: current.token, expectedExecutable: current.python };
  }

  function cancelStart() {
    if (abort) abort.abort();
  }

  async function stop() {
    cancelStart();
    if (starting) await starting.catch(() => undefined);
    const st = current;
    current = null;
    await terminate(st);
    removeRecord();
  }

  /** ③ 前回のものが残っていれば止める。PID が生きていて、コマンド行に同じ目印があるときだけ。 */
  function sweepStale() {
    let text;
    try { text = fs.readFileSync(recordFile, "utf8"); } catch { return { swept: false, reason: "no-record" }; }
    const rec = parseRecord(text);
    if (!rec) { removeRecord(); return { swept: false, reason: "bad-record" }; }
    if (!alive(rec.pid)) { removeRecord(); return { swept: false, reason: "not-running" }; }
    const cmd = readCmdline(rec.pid);
    if (!cmdlineHasMark(cmd, rec.mark)) { removeRecord(); return { swept: false, reason: "not-ours" }; }
    kill(rec.pid, { force: false });
    removeRecord();
    return { swept: true, pid: rec.pid };
  }

  return { ensure, endpoint, stop, cancelStart, sweepStale };
}

let instance = null;

function init({ dataDir }) {
  instance = createJupyter({ dataDir });
}

const need = () => {
  if (!instance) throw new Error("localJupyter is not initialized");
  return instance;
};

module.exports = {
  ENDPOINT_ID,
  MARK_PREFIX,
  STOP_WAIT_MS,
  launcher,
  serverArgs,
  serverEnv,
  kernelSpec,
  newMark,
  newToken,
  cmdlineHasMark,
  parseRecord,
  defaultReadCmdline,
  createJupyter,
  init,
  ensure: (python) => need().ensure(python),
  endpoint: () => (instance ? instance.endpoint() : null),
  stop: () => (instance ? instance.stop() : Promise.resolve()),
  cancelStart: () => instance && instance.cancelStart(),
  sweepStale: () => need().sweepStale(),
};
