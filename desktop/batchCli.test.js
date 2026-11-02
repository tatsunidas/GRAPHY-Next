const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const cli = require("./batchCli");

test("parseArgs: 必須の引数と複数の --spec", () => {
  const r = cli.parseArgs(["--album", "lung", "--spec", "a.json", "--spec", "b.json", "--out", "o", "--recompute", "--data-dir", "d", "--report", "r.json"]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.opts, { album: "lung", specs: ["a.json", "b.json"], out: "o", dataDir: "d", recompute: true, report: "r.json" });
});

test("parseArgs: 足りない・不正な引数は断る", () => {
  for (const argv of [
    [], ["--album", "x", "--out", "o"], ["--album", "x", "--spec", "a.json"], ["--spec", "a.json", "--out", "o"],
    ["--album", "x", "--spec", "a.json", "--out", "o", "--nope"], ["--album", "--spec", "a.json", "--out", "o"],
    ["--album", "x", "--spec"],
  ]) {
    const r = cli.parseArgs(argv);
    assert.equal(r.ok, false, JSON.stringify(argv));
    assert.ok(r.error);
  }
  assert.equal(cli.parseArgs(["--help"]).help, true);
});

test("appDataDir: 3 OS の規則（electron の appData と同じ）", () => {
  assert.equal(cli.appDataDir({ platform: "win32", env: { APPDATA: "C:\\Users\\u\\AppData\\Roaming" }, home: "C:\\Users\\u" }),
    path.join("C:\\Users\\u\\AppData\\Roaming", "GRAPHY-Next"));
  assert.equal(cli.appDataDir({ platform: "darwin", env: {}, home: "/Users/u" }), path.join("/Users/u", "Library", "Application Support", "GRAPHY-Next"));
  assert.equal(cli.appDataDir({ platform: "linux", env: {}, home: "/home/u" }), path.join("/home/u", ".config", "GRAPHY-Next"));
  assert.equal(cli.appDataDir({ platform: "linux", env: { XDG_CONFIG_HOME: "/x" }, home: "/home/u" }), path.join("/x", "GRAPHY-Next"));
});

test("resolveDataDir: --data-dir → パッケージ版は appData → 開発は GRAPHY_DEV_DATA_DIR・CWD", () => {
  const abs = path.resolve("some", "dir");
  assert.equal(cli.resolveDataDir({ dataDirArg: abs, packaged: true, env: {}, cwd: "/c" }), abs);
  assert.equal(cli.resolveDataDir({ packaged: true, env: { APPDATA: "/ad", XDG_CONFIG_HOME: "/ad" }, cwd: "/c" }),
    cli.appDataDir({ env: { APPDATA: "/ad", XDG_CONFIG_HOME: "/ad" } }));
  assert.equal(cli.resolveDataDir({ packaged: false, env: {}, cwd: "/c" }), "/c");
  const dev = fs.mkdtempSync(path.join(os.tmpdir(), "bc-dev-"));
  try {
    assert.equal(cli.resolveDataDir({ packaged: false, env: { GRAPHY_DEV_DATA_DIR: dev }, cwd: "/c" }), path.resolve(dev));
    assert.throws(() => cli.resolveDataDir({ packaged: false, env: { GRAPHY_DEV_DATA_DIR: path.join(dev, "none") }, cwd: "/c" }));
  } finally {
    fs.rmSync(dev, { recursive: true, force: true });
  }
});

const net = require("node:net");

/** H2（自動サーバーモード）が書くロックファイルの形（実機で採った実物）。 */
const lockText = (port) => [
  "#FileLock", "#Mon Nov 02 17:17:55 JST 2026", "hostName=localhost", "id=1a19b561a702a64d5afa2b24facf6e149bf7e49c087",
  "method=file", `server=localhost\\:${port}`, "",
].join("\n");

test("dbInUse: ロックの宛先に繋がるときだけ使用中。閉じている（残っているだけ）・ロックなしは通す", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bc-lock-"));
  const server = net.createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const livePort = server.address().port;
  try {
    assert.equal(await cli.dbInUse(dir), false, "ロックが無い");
    const lock = path.join(dir, "graphy-index.lock.db");
    fs.writeFileSync(lock, lockText(livePort));
    assert.equal(await cli.dbInUse(dir), true, "宛先が待ち受けている");
    // 更新時刻は当てにならない: 古いファイルでも宛先が生きていれば使用中
    const old = new Date(Date.now() - 3600_000);
    fs.utimesSync(lock, old, old);
    assert.equal(await cli.dbInUse(dir), true, "古いファイルでも宛先が生きている");
    await new Promise((r) => server.close(r));
    assert.equal(await cli.dbInUse(dir), false, "宛先が閉じた（異常終了のあとに残ったロック）");
    fs.writeFileSync(lock, "#FileLock\nmethod=file\n");
    assert.equal(await cli.dbInUse(dir), true, "宛先が読めないロックは安全側で使用中");
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("backendArgs: SCP を無効にし、DB フォルダと設定ファイルを渡す", () => {
  const args = cli.backendArgs({ jar: "/j/b.jar", port: 12345, dbFolder: path.resolve("db"), settingsFile: path.resolve("s.json") });
  assert.ok(args.includes("--graphy.dicom.scp.enabled=false"));
  assert.ok(args.includes("--server.port=12345"));
  assert.ok(args.includes("--spring.profiles.active=standalone"));
  assert.ok(args.some((a) => a.startsWith("--spring.datasource.url=jdbc:h2:file:") && a.endsWith(";AUTO_SERVER=TRUE")));
  assert.ok(args.some((a) => a.startsWith("--graphy.db.folder=")));
  assert.ok(args.some((a) => a.startsWith("--graphy.settings.global-file=")));
  assert.equal(args[args.indexOf("-jar") + 1], "/j/b.jar");
});

// main.js の backend 起動と JVM 引数がずれていないか（main.js は変えない方針なので、文字列で突き合わせる）
function mainJsJvmTokens() {
  const src = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");
  const quoted = (s) => [...s.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const enc = quoted(src.match(/jvmArgs\.push\("-Dstdout\.encoding=UTF-8",[^)]*\)/)[0]);
  const opens = quoted(src.match(/jvmArgs\.push\(\s*"--add-opens"[\s\S]*?\);/)[0]);
  return [...enc, ...opens];
}

test("JVM 引数は main.js の backend 起動と一致する（ずれ検査）", () => {
  assert.deepEqual(cli.JVM_ARGS, mainJsJvmTokens());
});

test("ずれ検査の負例: JVM 引数を 1 つ落とすと不一致になる", () => {
  assert.notDeepEqual(cli.JVM_ARGS.slice(0, -1), mainJsJvmTokens());
  assert.notDeepEqual([...cli.JVM_ARGS].reverse(), mainJsJvmTokens());
});

test("freePort は空きポートを返す", async () => {
  const p = await cli.freePort();
  assert.ok(Number.isInteger(p) && p > 0 && p < 65536);
});

test("resourcesPathOf: process.resourcesPath が無いとき実行ファイルの位置から導く（3 OS）", () => {
  assert.equal(cli.resourcesPathOf({ resourcesPath: "/given/resources", execPath: "/x/app", platform: "linux" }), "/given/resources");
  assert.equal(cli.resourcesPathOf({ resourcesPath: undefined, execPath: path.join("C:", "Apps", "GRAPHY-Next", "GRAPHY-Next.exe"), platform: "win32" }),
    path.join("C:", "Apps", "GRAPHY-Next", "resources"));
  assert.equal(cli.resourcesPathOf({ resourcesPath: undefined, execPath: path.join("/opt", "GRAPHY-Next", "graphy-next-desktop"), platform: "linux" }),
    path.join("/opt", "GRAPHY-Next", "resources"));
  assert.equal(path.normalize(cli.resourcesPathOf({ resourcesPath: undefined, execPath: path.join("/Applications", "GRAPHY-Next.app", "Contents", "MacOS", "GRAPHY-Next"), platform: "darwin" })),
    path.normalize(path.join("/Applications", "GRAPHY-Next.app", "Contents", "Resources")));
});

test("resolveJar: 資源フォルダの backend/jar を見つけたらパッケージ版", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bc-res-"));
  try {
    const config = require("./config.json");
    fs.mkdirSync(path.join(dir, "backend"), { recursive: true });
    fs.writeFileSync(path.join(dir, "backend", config.backend.jarName), "x");
    const r = cli.resolveJar(dir);
    assert.equal(r.packaged, true);
    assert.equal(r.jar, path.join(dir, "backend", config.backend.jarName));
    assert.equal(cli.resolveJar(path.join(dir, "none")).packaged, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
