// 開発（未パッケージ）のデータ置き場を、環境変数 GRAPHY_DEV_DATA_DIR で 1 か所に固定する。
//
// 既定の開発は CWD（= <worktree>/desktop）にデータを作るので、worktree を作るたびに空の DB になる。
// この変数があれば、DB・保管庫・プラグイン・設定・鍵をそのフォルダにまとめる。
//
// 🔴 パッケージ版では**無視**する（インストール版の $APPDATA\GRAPHY-Next を誤って動かさない）。
// 🔴 フォルダを黙って作らない。無い場所を指していたら止める（外付けディスクを外したまま起動して
//    空の DB ができるのを防ぐ。dbFolders.js と同じ方針）。作成は利用者が明示的に行う。
// 🔴 `;` を含むパスは受け付けない（JDBC URL の区切りと衝突する）。
//
// electron を import しない（CI の Desktop ジョブは npm install しない）。

const fs = require("node:fs");
const path = require("node:path");

/**
 * @param {Record<string, string | undefined>} env
 * @param {boolean} isPackaged
 * @param {string} cwd
 * @param {(p: string) => boolean} [isDir]
 * @returns {string} 使うデータフォルダ
 * @throws {Error} 指定が不正・存在しないとき（メッセージは利用者にそのまま見せられる）
 */
function resolveDevDataDir(env, isPackaged, cwd, isDir = defaultIsDir) {
  if (isPackaged) return cwd;
  const raw = env.GRAPHY_DEV_DATA_DIR;
  if (raw === undefined) return cwd;
  if (raw.trim() === "") throw new Error("GRAPHY_DEV_DATA_DIR が空です。フォルダを指定するか、変数を外してください。");
  if (!path.isAbsolute(raw)) throw new Error(`GRAPHY_DEV_DATA_DIR は絶対パスで指定してください: ${raw}`);
  if (raw.includes(";")) throw new Error(`GRAPHY_DEV_DATA_DIR に ';' は使えません: ${raw}`);
  const dir = path.resolve(raw);
  if (!isDir(dir)) throw new Error(`GRAPHY_DEV_DATA_DIR のフォルダがありません（自動では作りません）: ${dir}`);
  return dir;
}

function defaultIsDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

module.exports = { resolveDevDataDir };
