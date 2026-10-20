// `node --test`。この PC の Jupyter Server の起動・停止。設計: fw/remote-compute-design.md §22
// 🔴 electron を import しない（CI の Desktop ジョブは npm install しない）。
//
// 前半は純関数（正例と負例を同じ表に）。後半は本物の Python と jupyter_server を起動する結合試験で、
// jupyter_server の入った Python が無い機（CI など）では skip する——skip は合格に数えない。

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const childProcess = require("node:child_process");

const J = require("./localJupyter");

test("launcher: 目印が先頭のコメントに入り、引用符は単一引用符だけ・バックスラッシュ無し", () => {
  const code = J.launcher("0123456789abcdef");
  assert.ok(code.startsWith("# graphy-local-jupyter:0123456789abcdef\n"));
  assert.ok(!code.includes('"'), "二重引用符を含まない（Windows のコマンド行を通る形）");
  assert.ok(!code.includes("\\"), "バックスラッシュを含まない");
  assert.ok(code.includes("sys.stdin.buffer.read()"), "親が死んだら止まる");
});

test("serverArgs: 127.0.0.1 固定・port_retries=0・端末は無効・トークンは引数に入らない", () => {
  const a = J.serverArgs({ port: 18000, workDir: "/w" });
  assert.deepStrictEqual(a, [
    "--ServerApp.ip=127.0.0.1", "--ServerApp.port=18000", "--ServerApp.port_retries=0",
    "--ServerApp.open_browser=False", "--ServerApp.root_dir=/w", "--ServerApp.terminals_enabled=False",
  ]);
  assert.ok(!a.join(" ").toLowerCase().includes("token"));
});

test("serverEnv: トークンは環境変数・GRAPHY_/ELECTRON_ は渡さない・Jupyter の設定は本体専用のフォルダ", () => {
  const e = J.serverEnv({ PATH: "/bin", GRAPHY_SECRET: "x", ELECTRON_RUN_AS_NODE: "1", JUPYTER_CONFIG_DIR: "/home/u/.jupyter", PYTHONPATH: "/p" },
    { token: "tok", jupyterDir: "/d/jupyter" });
  assert.strictEqual(e.JUPYTER_TOKEN, "tok");
  assert.strictEqual(e.GRAPHY_SECRET, undefined);
  assert.strictEqual(e.ELECTRON_RUN_AS_NODE, undefined);
  assert.strictEqual(e.PYTHONPATH, "/p");
  assert.strictEqual(e.PATH, "/bin");
  assert.ok(e.JUPYTER_CONFIG_DIR.startsWith(path.join("/d/jupyter")), "利用者の JUPYTER_CONFIG_DIR を上書きする");
  assert.ok(e.JUPYTER_DATA_DIR.startsWith(path.join("/d/jupyter")));
  assert.ok(e.JUPYTER_RUNTIME_DIR.startsWith(path.join("/d/jupyter")));
});

test("kernelSpec: 選んだ Python を指す python3（利用者の kernels に勝つ名前）", () => {
  const k = J.kernelSpec("/opt/py/bin/python");
  assert.deepStrictEqual(k.argv, ["/opt/py/bin/python", "-m", "ipykernel_launcher", "-f", "{connection_file}"]);
  assert.strictEqual(k.language, "python");
});

test("newToken / newMark: 64 桁・16 桁の 16 進で、毎回違う", () => {
  assert.match(J.newToken(), /^[0-9a-f]{64}$/);
  assert.match(J.newMark(), /^[0-9a-f]{16}$/);
  assert.notStrictEqual(J.newToken(), J.newToken());
  assert.notStrictEqual(J.newMark(), J.newMark());
});

test("cmdlineHasMark: 同じ目印は真・別の目印／目印なし／形の悪い目印は偽", () => {
  const mark = "0123456789abcdef";
  const cmd = `/usr/bin/python3 -c ${J.launcher(mark)} --ServerApp.ip=127.0.0.1`;
  assert.strictEqual(J.cmdlineHasMark(cmd, mark), true);
  assert.strictEqual(J.cmdlineHasMark(cmd, "fedcba9876543210"), false);
  assert.strictEqual(J.cmdlineHasMark("/usr/bin/python3 -c print(1)", mark), false);
  assert.strictEqual(J.cmdlineHasMark(null, mark), false);
  assert.strictEqual(J.cmdlineHasMark(cmd, "short"), false);
  assert.strictEqual(J.cmdlineHasMark(cmd, ""), false);
});

test("parseRecord: 正しい記録は読め、壊れたもの・PID が小さすぎるもの・目印の形が悪いものは null", () => {
  const ok = { pid: 1234, port: 18000, mark: "0123456789abcdef", startedAt: 5 };
  assert.deepStrictEqual(J.parseRecord(JSON.stringify(ok)), ok);
  assert.strictEqual(J.parseRecord("{"), null);
  assert.strictEqual(J.parseRecord("null"), null);
  assert.strictEqual(J.parseRecord(JSON.stringify({ ...ok, pid: 1 })), null);
  assert.strictEqual(J.parseRecord(JSON.stringify({ ...ok, pid: "1234" })), null);
  assert.strictEqual(J.parseRecord(JSON.stringify({ ...ok, mark: "../x" })), null);
});

// ── sweepStale（差し替え）─────────────────────────────────────────────────

function sweepFixture({ record, alive, cmdline }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gj-"));
  fs.mkdirSync(path.join(dir, "compute-local"), { recursive: true });
  const file = path.join(dir, "compute-local", "server.json");
  if (record !== undefined) fs.writeFileSync(file, typeof record === "string" ? record : JSON.stringify(record));
  const killed = [];
  const j = J.createJupyter({
    dataDir: dir, platform: "linux", isAlive: () => alive, readCmdline: () => cmdline,
    kill: (pid, o) => { killed.push([pid, o]); return true; },
  });
  return { j, killed, file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const REC = { pid: 4242, port: 18000, mark: "0123456789abcdef", startedAt: 1 };

test("sweepStale: 生きていて目印が一致 → 止める（正例）", () => {
  const f = sweepFixture({ record: REC, alive: true, cmdline: `python -c ${J.launcher(REC.mark)}` });
  const r = f.j.sweepStale();
  assert.deepStrictEqual(r, { swept: true, pid: 4242 });
  assert.strictEqual(f.killed.length, 1);
  assert.strictEqual(fs.existsSync(f.file), false, "記録は消す");
  f.cleanup();
});

test("sweepStale: PID が別のプロセスに再利用されている（目印なし）→ 止めない（負例）", () => {
  const f = sweepFixture({ record: REC, alive: true, cmdline: "/usr/bin/firefox --new-window" });
  const r = f.j.sweepStale();
  assert.deepStrictEqual(r, { swept: false, reason: "not-ours" });
  assert.strictEqual(f.killed.length, 0);
  f.cleanup();
});

test("sweepStale: 別の目印 → 止めない／もう動いていない → 止めない／記録なし・壊れた記録 → 止めない", () => {
  let f = sweepFixture({ record: REC, alive: true, cmdline: `python -c ${J.launcher("fedcba9876543210")}` });
  assert.strictEqual(f.j.sweepStale().swept, false);
  assert.strictEqual(f.killed.length, 0);
  f.cleanup();
  f = sweepFixture({ record: REC, alive: false, cmdline: null });
  assert.deepStrictEqual(f.j.sweepStale(), { swept: false, reason: "not-running" });
  f.cleanup();
  f = sweepFixture({ alive: true, cmdline: null });
  assert.deepStrictEqual(f.j.sweepStale(), { swept: false, reason: "no-record" });
  f.cleanup();
  f = sweepFixture({ record: "{broken", alive: true, cmdline: null });
  assert.deepStrictEqual(f.j.sweepStale(), { swept: false, reason: "bad-record" });
  assert.strictEqual(f.killed.length, 0);
  f.cleanup();
});

// ── 本物の Python（結合）──────────────────────────────────────────────────

function findPython() {
  const cands = [process.env.GRAPHY_TEST_PYTHON, "python3", "python"].filter(Boolean);
  for (const p of cands) {
    try {
      // 実際の起動では localPython が選んだ絶対パスを渡す。試験でも絶対パスにする
      return childProcess.execFileSync(p, ["-c", "import jupyter_server, ipykernel, sys; print(sys.executable)"], { encoding: "utf8", timeout: 60000 }).trim();
    } catch { /* 次へ */ }
  }
  return null;
}
const PY = findPython();
const real = { skip: PY ? false : "jupyter_server の入った Python が無い（未達。合格に数えない）" };

const http = async (url, init) => {
  try { return (await fetch(url, init)).status; } catch { return 0; }
};
const gone = async (pid, ms = 15000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { process.kill(pid, 0); } catch { return true; }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
};

test("結合: 起動 → 正しいトークンで 200・誤り／無しで 403・コマンド行にトークンが無い → 停止でプロセスが消える", real, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gj-real-"));
  const j = J.createJupyter({ dataDir: dir });
  try {
    const r = await j.ensure(PY);
    assert.ok(r.ok, JSON.stringify(r));
    assert.match(r.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    assert.strictEqual(await http(`${r.url}api/status`, { headers: { Authorization: `token ${r.token}` } }), 200);
    assert.strictEqual(await http(`${r.url}api/status`, { headers: { Authorization: "token wrong" } }), 403);
    assert.strictEqual(await http(`${r.url}api/status`), 403);
    const rec = J.parseRecord(fs.readFileSync(path.join(dir, "compute-local", "server.json"), "utf8"));
    assert.ok(rec, "server.json が書かれる");
    const cmd = J.defaultReadCmdline(rec.pid);
    if (cmd !== null) {
      assert.ok(J.cmdlineHasMark(cmd, rec.mark), "コマンド行に目印がある");
      assert.ok(!cmd.includes(r.token), "コマンド行にトークンが無い");
    }
    assert.deepStrictEqual(j.endpoint(), { id: "local", label: "this-pc", url: r.url, kind: "local", token: r.token, expectedExecutable: PY });
    // 同じ Python を続けて頼んでも起動し直さない
    const again = await j.ensure(PY);
    assert.strictEqual(again.port, r.port);
    await j.stop();
    assert.strictEqual(await gone(rec.pid), true, "停止でプロセスが消える");
    assert.strictEqual(fs.existsSync(path.join(dir, "compute-local", "server.json")), false);
    assert.strictEqual(j.endpoint(), null);
  } finally {
    await j.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("結合: 利用者の kernels に別の python3 があっても、カーネル仕様は選んだ Python を指す", real, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gj-real-ks-"));
  const j = J.createJupyter({ dataDir: dir });
  try {
    const r = await j.ensure(PY);
    assert.ok(r.ok, JSON.stringify(r));
    const res = await fetch(`${r.url}api/kernelspecs`, { headers: { Authorization: `token ${r.token}` } });
    assert.strictEqual(res.status, 200);
    const specs = await res.json();
    const argv0 = specs.kernelspecs[specs.default].spec.argv[0];
    assert.strictEqual(specs.default, "python3");
    assert.strictEqual(argv0, PY, "python3 の仕様は選んだ Python を指す");
    // この機のように利用者の ~/.local/share/jupyter/kernels/python3 が別の環境を指していても、こちらが勝つ
    assert.deepStrictEqual(Object.keys(specs.kernelspecs).includes("python3"), true);
  } finally {
    await j.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("結合: 親が死んだ（stdin が閉じた）ら自分で止まる／起動時の掃除は目印のあるものだけ止める", real, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gj-real2-"));
  const a = J.createJupyter({ dataDir: dir });
  let decoy = null;
  try {
    const r = await a.ensure(PY);
    assert.ok(r.ok, JSON.stringify(r));
    const recFile = path.join(dir, "compute-local", "server.json");
    const rec = J.parseRecord(fs.readFileSync(recFile, "utf8"));

    // 負例: 記録の PID が目印の無い無関係なプロセスなら止めない
    decoy = childProcess.spawn(PY, ["-c", "import time; time.sleep(60)"], { stdio: "ignore" });
    fs.writeFileSync(recFile, JSON.stringify({ ...rec, pid: decoy.pid }));
    const b = J.createJupyter({ dataDir: dir });
    assert.deepStrictEqual(b.sweepStale(), { swept: false, reason: "not-ours" });
    assert.strictEqual(await gone(decoy.pid, 500), false, "無関係なプロセスは生きている");
    decoy.kill();

    // 正例: 本物の記録なら止める（Electron が落ちて残った場合に次の起動で片付く）
    fs.writeFileSync(recFile, JSON.stringify(rec));
    const swept = b.sweepStale();
    assert.strictEqual(swept.swept, true);
    assert.strictEqual(await gone(rec.pid), true, "掃除でプロセスが消える");
  } finally {
    if (decoy) decoy.kill();
    await a.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("結合: 親の stdin が閉じるとサーバが自分で止まる（Electron が落ちたとき）", real, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gj-real3-"));
  let child = null;
  try {
    const port = await new Promise((res) => { const s = require("node:net").createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
    const token = J.newToken();
    fs.mkdirSync(path.join(dir, "w"), { recursive: true });
    child = childProcess.spawn(PY, ["-c", J.launcher(J.newMark()), ...J.serverArgs({ port, workDir: path.join(dir, "w") })], {
      env: J.serverEnv(process.env, { token, jupyterDir: path.join(dir, "j") }), cwd: dir, stdio: ["pipe", "ignore", "ignore"],
    });
    const t0 = Date.now();
    while (Date.now() - t0 < 60000 && (await http(`http://127.0.0.1:${port}/api/status`, { headers: { Authorization: `token ${token}` } })) !== 200) {
      await new Promise((r) => setTimeout(r, 300));
    }
    assert.strictEqual(await http(`http://127.0.0.1:${port}/api/status`, { headers: { Authorization: `token ${token}` } }), 200, "先に起動していること");
    const t1 = Date.now();
    child.stdin.end(); // 親の死＝パイプが閉じる
    assert.strictEqual(await gone(child.pid, 20000), true, "stdin が閉じたら止まる");
    console.log(`# stdin 切断から停止まで ${Date.now() - t1} ms`);
  } finally {
    if (child) child.kill("SIGKILL");
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
