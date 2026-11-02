// 一括抽出の無人実行（コマンドライン）。画面を出さずに backend を自前で起動し、保存した処理の定義（複数）を順に実行して
// 表を書き、終了コードで成否を返す。実行の本体は frontend の `npm run build:batch-cli` が作る `batch-cli/run.cjs`。
//
//   node desktop/batchCli.js --album <名前|ID> --spec a.json [--spec b.json …] --out <フォルダ> [--data-dir <フォルダ>] [--recompute] [--report <ファイル>]
//   ELECTRON_RUN_AS_NODE=1 <electron> desktop/batchCli.js …        （同梱の Node で動かすとき）
//
// 終了コード: 0＝全定義が完了／1＝失敗した定義がある／2＝失敗は無いが QC 停止・確認待ちの組などがあった／
//             3＝引数・定義の誤り（何も実行しない）／4＝backend が起動しない・接続できないなどの例外／5＝DB を画面のアプリなどが使用中
//
// 🔴 画面のアプリと同じ DB は同時に開かない。使用中（H2 のロックの宛先に繋がる）なら起動せず 5 で終わる。アプリを閉じて実行する。
// 🔴 DB フォルダを黙って作らない（無い場所を指していたら 4 で止まる。dbFolders.js と同じ方針）。
// 🔴 DICOM 受信（SCP）は無効にして起動する（画面のアプリの 11112 とぶつからず、外へ待ち受けない）。
//
// electron を import しない（CI の Desktop ジョブは npm install しない）。

const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");

const dbFolders = require("./dbFolders");
const { resolveDevDataDir } = require("./devDataDir");
const { portInUse } = require("./portWait");
const config = require("./config.json");

const EXIT_USAGE = 3;
const EXIT_ERROR = 4;
const EXIT_IN_USE = 5;

const APP_DATA_FOLDER = "GRAPHY-Next";
const HEALTH_TIMEOUT_MS = 180_000;

/** `main.js` の backend 起動と同じ JVM 引数（ずれ検査が `main.js` の文字列と突き合わせる）。 */
const JVM_ARGS = [
  "-Dstdout.encoding=UTF-8",
  "-Dstderr.encoding=UTF-8",
  "--add-opens", "java.base/java.io=ALL-UNNAMED",
  "--add-opens", "java.desktop/javax.imageio.stream=ALL-UNNAMED",
];

const USAGE = [
  "使い方: graphy-batch --album <名前|ID> --spec <定義.json> [--spec …] --out <フォルダ>（開発ツリーでは node desktop/batchCli.js）",
  "         [--data-dir <フォルダ>] [--recompute] [--report <ファイル>]",
].join("\n");

/** @returns {{ok: true, opts: object} | {ok: false, error: string, help?: boolean}} */
function parseArgs(argv) {
  const opts = { album: null, specs: [], out: null, dataDir: null, recompute: false, report: null };
  const need = (i, name) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`${name} に値がありません`);
    return v;
  };
  try {
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === "--help" || a === "-h") return { ok: false, error: USAGE, help: true };
      else if (a === "--album") opts.album = need(i++, a);
      else if (a === "--spec") opts.specs.push(need(i++, a));
      else if (a === "--out") opts.out = need(i++, a);
      else if (a === "--data-dir") opts.dataDir = need(i++, a);
      else if (a === "--report") opts.report = need(i++, a);
      else if (a === "--recompute") opts.recompute = true;
      else throw new Error(`知らない引数です: ${a}`);
    }
  } catch (e) {
    return { ok: false, error: e.message };
  }
  if (!opts.album) return { ok: false, error: "--album が要ります" };
  if (opts.specs.length === 0) return { ok: false, error: "--spec が 1 つ以上要ります" };
  if (!opts.out) return { ok: false, error: "--out が要ります" };
  return { ok: true, opts };
}

/** パッケージ版のデータ置き場。electron の `app.getPath("appData")` と同じ規則（`main.js` の resolveDataDir）。 */
function appDataDir({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  let base;
  if (platform === "win32") base = env.APPDATA || path.join(home, "AppData", "Roaming");
  else if (platform === "darwin") base = path.join(home, "Library", "Application Support");
  else base = env.XDG_CONFIG_HOME || path.join(home, ".config");
  return path.join(base, APP_DATA_FOLDER);
}

/**
 * インストール先の `resources`。`ELECTRON_RUN_AS_NODE=1` で動かすとき `process.resourcesPath` が定義されている保証が無いので、
 * 無ければ実行ファイルの位置から導く（Windows・Linux は実行ファイルの隣の `resources`、macOS は `Contents/MacOS/<app>` の `../Resources`）。
 */
function resourcesPathOf({ resourcesPath = process.resourcesPath, execPath = process.execPath, platform = process.platform } = {}) {
  if (resourcesPath) return resourcesPath;
  if (platform === "darwin") return path.join(path.dirname(execPath), "..", "Resources");
  return path.join(path.dirname(execPath), "resources");
}

/** backend の jar（`main.js` の resolveBackendJar と同じ候補の順）。 */
function resolveJar(resourcesPath = resourcesPathOf()) {
  const jarName = config.backend.jarName;
  const candidates = [
    path.join(resourcesPath || "", "backend", jarName),
    path.join(__dirname, "..", "backend", "target", jarName),
    path.join(__dirname, "resources", "backend", jarName),
  ];
  const found = candidates.find((p) => p && fs.existsSync(p)) || null;
  return { jar: found, packaged: !!found && !!resourcesPath && found === candidates[0] };
}

/** 同梱 JRE → PATH の java（`main.js` の resolveJava と同じ）。 */
function resolveJava(resourcesPath = resourcesPathOf()) {
  const exe = process.platform === "win32" ? "java.exe" : "java";
  const candidates = [path.join(resourcesPath || "", "jre", "bin", exe), path.join(__dirname, "resources", "jre", "bin", exe)];
  return candidates.find((p) => p && fs.existsSync(p)) || "java";
}

/** データ置き場。`--data-dir` → パッケージ版は appData → 開発は `GRAPHY_DEV_DATA_DIR` または CWD。 */
function resolveDataDir({ dataDirArg, packaged, env = process.env, cwd = process.cwd() }) {
  if (dataDirArg) return path.resolve(dataDirArg);
  if (packaged) return appDataDir({ env });
  return resolveDevDataDir(env, false, cwd);
}

/**
 * DB フォルダを別のプロセス（画面のアプリ・別の実行）が使用中か。
 * H2 の自動サーバーモードは、開いている間 `<DB 名>.lock.db` に自分のサーバーの宛先（`server=host\:port`）を書く。
 * ロックファイルの更新時刻は当てにならない（実測: 開いている間も書き直されない）。異常終了のあとにファイルが残っても
 * 宛先は閉じているので、**宛先に繋がるか**で生きているかを見る。宛先が読めないロックは、安全側で使用中とする。
 * @returns {Promise<boolean>}
 */
async function dbInUse(folder, probe = portInUse, readFile = fs.readFileSync) {
  let text;
  try {
    text = readFile(path.join(folder, "graphy-index.lock.db"), "utf8");
  } catch {
    return false;
  }
  const m = /^server=(.+)$/m.exec(text);
  const addr = m ? m[1].trim().replaceAll("\\:", ":") : "";
  const i = addr.lastIndexOf(":");
  const port = i > 0 ? Number(addr.slice(i + 1)) : NaN;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return true;
  return probe(port, "127.0.0.1");
}

function backendArgs({ jar, port, dbFolder, settingsFile }) {
  return [
    ...JVM_ARGS,
    "-jar", jar,
    "--spring.profiles.active=standalone",
    `--server.port=${port}`,
    "--graphy.dicom.scp.enabled=false",
    ...dbFolders.springArgs(dbFolder, settingsFile),
  ];
}

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

async function waitHealthy(port, child, exited) {
  const t0 = Date.now();
  while (Date.now() - t0 < HEALTH_TIMEOUT_MS) {
    if (exited()) throw new Error("backend が起動の途中で終了しました");
    try {
      const res = await fetch(`http://127.0.0.1:${port}${config.backend.healthPath}`);
      if (res.ok) return;
    } catch {
      /* まだ待ち受けていない */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`backend が ${HEALTH_TIMEOUT_MS / 1000} 秒以内に応答しませんでした`);
}

/** backend を止める（子プロセスごと）。止まるまで待つ。 */
function stopBackend(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolve();
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* 既に終了 */ }
    }, 15_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else child.kill("SIGTERM");
  });
}

async function main(argv) {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    console.error(parsed.error);
    if (!parsed.help) console.error(USAGE);
    return parsed.help ? 0 : EXIT_USAGE;
  }
  const { opts } = parsed;

  const runModule = path.join(__dirname, "batch-cli", "run.cjs");
  if (!fs.existsSync(runModule)) {
    console.error("実行部分（desktop/batch-cli/run.cjs）がありません。frontend で npm run build:batch-cli を実行してください");
    return EXIT_ERROR;
  }
  // 定義の誤りは、backend の起動（約 30 秒）の前に断る
  const { checkSpecFiles, runCli } = require(runModule);
  const specFiles = opts.specs.map((s) => path.resolve(s));
  const preCheck = await checkSpecFiles(specFiles);
  if (preCheck !== 0) return preCheck;

  const { jar, packaged } = resolveJar();
  if (!jar) {
    console.error(`backend の jar（${config.backend.jarName}）が見つかりません`);
    return EXIT_ERROR;
  }
  let dataDir;
  try {
    dataDir = resolveDataDir({ dataDirArg: opts.dataDir, packaged });
  } catch (e) {
    console.error(e.message);
    return EXIT_USAGE;
  }
  dbFolders.init(dataDir);
  const dbFolder = dbFolders.currentFolder();
  const pathProblem = dbFolders.checkPath(dbFolder);
  if (pathProblem) {
    console.error(`DB フォルダを使えません（${pathProblem}）: ${dbFolder}（自動では作りません）`);
    return EXIT_ERROR;
  }
  if (await dbInUse(dbFolder)) {
    console.error(`DB（${dbFolder}）を画面のアプリなどが使用中です。アプリを閉じてから実行してください`);
    return EXIT_IN_USE;
  }

  const port = await freePort();
  const tail = [];
  const keep = (b) => {
    for (const l of String(b).split(/\r?\n/)) if (l) tail.push(l);
    while (tail.length > 40) tail.shift();
  };
  console.log(`backend を起動します（port ${port}、DB ${dbFolder}）`);
  const child = spawn(resolveJava(), backendArgs({ jar, port, dbFolder, settingsFile: path.join(dataDir, "settings.json") }), {
    cwd: dataDir,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GRAPHY_MAIN_SECRET: crypto.randomBytes(32).toString("hex") },
  });
  child.stdout.on("data", keep);
  child.stderr.on("data", keep);
  let spawnError = null;
  child.on("error", (e) => { spawnError = e; });
  const onSignal = (sig) => {
    stopBackend(child).then(() => process.exit(128 + (sig === "SIGINT" ? 2 : 15)));
  };
  process.once("SIGINT", () => onSignal("SIGINT"));
  process.once("SIGTERM", () => onSignal("SIGTERM"));

  try {
    await waitHealthy(port, child, () => spawnError !== null || child.exitCode !== null);
    return await runCli({
      server: `http://127.0.0.1:${port}`, album: opts.album, specFiles,
      outDir: path.resolve(opts.out), recompute: opts.recompute,
      reportFile: opts.report ? path.resolve(opts.report) : undefined,
    });
  } catch (e) {
    console.error(`error: ${spawnError ? spawnError.message : e instanceof Error ? e.message : String(e)}`);
    if (tail.length > 0) console.error(`--- backend の出力の末尾 ---\n${tail.slice(-15).join("\n")}`);
    return EXIT_ERROR;
  } finally {
    await stopBackend(child);
  }
}

module.exports = {
  EXIT_USAGE, EXIT_ERROR, EXIT_IN_USE, JVM_ARGS,
  parseArgs, appDataDir, resourcesPathOf, resolveJar, resolveDataDir, dbInUse, backendArgs, freePort, stopBackend, main,
};

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(EXIT_ERROR);
  });
}
