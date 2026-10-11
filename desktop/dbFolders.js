// DB フォルダ（索引の H2 と DICOM 保管庫をまとめたフォルダ）の選択と記録。
//
// 既定の DB は従来どおり `<dataDir>/data`。利用者が別のフォルダを選ぶと `<dataDir>/db-folders.json` に
// 記録し、次の起動から backend へ datasource と保管庫の場所を引数で渡す（切り替え＝再起動）。
//
// 🔴 フォルダを黙って作らない。外付けディスクを外したまま起動すると、マウント先に空の DB が
//    できてしまう（backend は無い場所を作る）。存在の確認は spawn の前にここで行う。
// 🔴 `;` を含むパスは受け付けない。JDBC URL の区切り（`;AUTO_SERVER=TRUE`）と衝突する。
//
// electron を import しない（CI の Desktop ジョブは npm install しない）。

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const STATE_FILE = "db-folders.json";
const MARKER = "graphy-db.json";
const INDEX_FILE = "graphy-index.mv.db";
const MAX_RECENT = 10;

let dataDir = null;

function init(dir) {
  dataDir = dir;
}

function defaultFolder() {
  return path.join(dataDir, "data");
}

function norm(p) {
  return path.resolve(p);
}

/** 同じフォルダか（Windows・macOS の既定は大文字小文字を区別しない）。 */
function samePath(a, b, platform = process.platform) {
  const x = norm(a);
  const y = norm(b);
  return platform === "linux" ? x === y : x.toLowerCase() === y.toLowerCase();
}

function isDefault(folder) {
  return samePath(folder, defaultFolder());
}

/** `\\server\share` 形式。H2 のファイルロックが安定しないので、選ぶときに警告する。 */
function isNetworkPath(p) {
  return /^\\\\|^\/\//.test(p);
}

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(dataDir, STATE_FILE), "utf8"));
    const recent = Array.isArray(s.recent) ? s.recent.filter((p) => typeof p === "string" && path.isAbsolute(p)) : [];
    const current = typeof s.current === "string" && path.isAbsolute(s.current) ? s.current : null;
    return { current, recent };
  } catch {
    // 無い・壊れている → 既定の DB で起動する（データは失わない: 各 DB フォルダはそのまま）
    return { current: null, recent: [] };
  }
}

function saveState(state) {
  const file = path.join(dataDir, STATE_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
}

/** 次の起動で使う DB フォルダ。 */
function currentFolder() {
  return loadState().current || defaultFolder();
}

/**
 * パスそのものの検査。問題があれば理由のコード、無ければ null。
 * @returns {null|"not-absolute"|"has-semicolon"|"not-found"|"not-directory"|"not-writable"}
 */
function checkPath(p) {
  if (typeof p !== "string" || !path.isAbsolute(p)) return "not-absolute";
  if (p.includes(";")) return "has-semicolon";
  let st;
  try {
    st = fs.statSync(p);
  } catch {
    return "not-found";
  }
  if (!st.isDirectory()) return "not-directory";
  try {
    fs.accessSync(p, fs.constants.W_OK);
  } catch {
    return "not-writable";
  }
  return null;
}

/** "db"（目印か索引がある）/ "empty" / "other"（関係の無いファイルがある）。 */
function inspect(p) {
  if (fs.existsSync(path.join(p, MARKER)) || fs.existsSync(path.join(p, INDEX_FILE))) return "db";
  const entries = fs.readdirSync(p).filter((n) => n !== ".DS_Store" && n !== "Thumbs.db" && n !== "desktop.ini");
  return entries.length === 0 ? "empty" : "other";
}

function writeMarker(folder) {
  const file = path.join(folder, MARKER);
  if (fs.existsSync(file)) return;
  fs.writeFileSync(
    file,
    JSON.stringify({ formatVersion: 1, dbId: crypto.randomUUID(), createdAt: new Date().toISOString() }, null, 2),
  );
}

/**
 * 開けるか。DB フォルダ（目印か索引がある）か空のフォルダなら開ける。
 * @returns {{ok:true, folder:string, kind:"db"|"empty", network:boolean}|{ok:false, reason:string}}
 */
function validateOpen(p) {
  const reason = checkPath(p);
  if (reason) return { ok: false, reason };
  const kind = inspect(p);
  if (kind === "other") return { ok: false, reason: "not-a-db-folder" };
  return { ok: true, folder: norm(p), kind, network: isNetworkPath(p) };
}

/** 新規 DB フォルダ。空のフォルダだけを受け付け、目印を書く。 */
function create(p) {
  const reason = checkPath(p);
  if (reason) return { ok: false, reason };
  if (inspect(p) !== "empty") return { ok: false, reason: "not-empty" };
  writeMarker(p);
  return { ok: true, folder: norm(p), network: isNetworkPath(p) };
}

/** 次の起動で使う DB として記録する（既定の DB は current=null で表す）。 */
function select(folder) {
  const s = loadState();
  const f = norm(folder);
  s.current = isDefault(f) ? null : f;
  if (!isDefault(f)) {
    s.recent = [f, ...s.recent.filter((r) => !samePath(r, f))].slice(0, MAX_RECENT);
  }
  saveState(s);
  return s;
}

/** 最近使った一覧から外す（フォルダ自体には触れない）。今使っている DB は外さない。 */
function forget(folder) {
  const s = loadState();
  if (s.current && samePath(s.current, folder)) return { ok: false, reason: "in-use" };
  s.recent = s.recent.filter((r) => !samePath(r, folder));
  saveState(s);
  return { ok: true };
}

/** 画面に出す一覧。active は今 backend が使っている DB。 */
function list(active) {
  const s = loadState();
  const exists = (p) => checkPath(p) === null;
  const seen = [];
  const rows = [];
  for (const p of [defaultFolder(), ...s.recent]) {
    if (seen.some((q) => samePath(q, p))) continue;
    seen.push(p);
    rows.push({ path: p, isDefault: isDefault(p), exists: isDefault(p) || exists(p), active: samePath(p, active) });
  }
  return { active, next: s.current || defaultFolder(), folders: rows };
}

/** backend に渡す引数。H2 の URL は区切りを `/` にそろえる（Windows でも H2 は受け付ける）。 */
function springArgs(folder, settingsFile) {
  const f = norm(folder);
  const h2 = path.join(f, "graphy-index").split(path.sep).join("/");
  return [
    `--spring.datasource.url=jdbc:h2:file:${h2};AUTO_SERVER=TRUE`,
    `--graphy.dicom.storage-dir=${path.join(f, "dicom")}`,
    `--graphy.db.folder=${f}`,
    `--graphy.settings.global-file=${settingsFile}`,
  ];
}

const MESSAGES = {
  ja: {
    missingTitle: "DB フォルダが見つかりません",
    missingMessage: "前回使っていた DB フォルダを開けません。外付けディスクやネットワークドライブが外れていないか確かめてください。",
    retry: "再試行",
    useDefault: "既定の DB で起動",
    quit: "終了",
    failedTitle: "選んだ DB フォルダで起動できませんでした",
    failedMessage: "既定の DB に切り替えて起動し直しますか？（選んだフォルダの中身には触れません）",
    switchDefault: "既定の DB で起動し直す",
    close: "閉じる",
  },
  en: {
    missingTitle: "Database folder not found",
    missingMessage: "The database folder used last time cannot be opened. Check that the external or network drive is connected.",
    retry: "Retry",
    useDefault: "Start with the default database",
    quit: "Quit",
    failedTitle: "Could not start with the selected database folder",
    failedMessage: "Switch to the default database and restart? (The selected folder is left untouched.)",
    switchDefault: "Restart with the default database",
    close: "Close",
  },
};

function messages(locale) {
  return String(locale || "").startsWith("ja") ? MESSAGES.ja : MESSAGES.en;
}

module.exports = {
  init,
  defaultFolder,
  currentFolder,
  isDefault,
  isNetworkPath,
  samePath,
  checkPath,
  inspect,
  writeMarker,
  validateOpen,
  create,
  select,
  forget,
  list,
  springArgs,
  loadState,
  messages,
  MARKER,
};
