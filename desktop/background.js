// 常駐（閉じてもトレイに残る・ログイン時に起動する）の設定と、判定の純関数。
//
// 既定はどちらもオフ（今までどおり、窓を閉じるとアプリも終わる）。診察室のように、予約日の前に事前取得を
// 走らせたい PC で、利用者が設定画面からオンにする。設定は userData の JSON（main だけが読み書きする）。
const fs = require("fs");
const path = require("path");

const KEYS = ["keepInTray", "launchAtLogin"];
/** ログイン時の起動で付ける引数。窓を出さずにトレイから始める。 */
const HIDDEN_ARG = "--hidden";

function defaults() {
  return { keepInTray: false, launchAtLogin: false };
}

/** 保存値を読む。無いときは既定。壊れていたら既定（常駐しない＝今までの動き）に戻し、理由を返す。 */
function createBackgroundPrefs({ file }) {
  function read() {
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (e) {
      if (e && e.code === "ENOENT") return { prefs: defaults(), error: null };
      return { prefs: defaults(), error: "unreadable" };
    }
    try {
      const j = JSON.parse(text);
      const prefs = defaults();
      for (const k of KEYS) {
        if (j[k] !== undefined && typeof j[k] !== "boolean") return { prefs: defaults(), error: "corrupt" };
        if (typeof j[k] === "boolean") prefs[k] = j[k];
      }
      return { prefs, error: null };
    } catch {
      return { prefs: defaults(), error: "corrupt" };
    }
  }

  return {
    get: () => read().prefs,
    readError: () => read().error,
    /** 既知のキーの真偽値だけ受ける。それ以外は例外（黙って捨てない）。 */
    set(patch) {
      if (!patch || typeof patch !== "object") throw new TypeError("patch");
      for (const [k, v] of Object.entries(patch)) {
        if (!KEYS.includes(k)) throw new TypeError(`unknown key: ${k}`);
        if (typeof v !== "boolean") throw new TypeError(`${k} must be boolean`);
      }
      const next = { ...read().prefs, ...patch };
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
      fs.renameSync(tmp, file);
      return next;
    },
  };
}

/** メインの窓の「閉じる」を、閉じずに隠すか。終了の最中（トレイの［終了］・更新・OS の終了）は隠さない。 */
function shouldHideOnClose({ keepInTray, quitting }) {
  return keepInTray === true && quitting !== true;
}

/** すべての窓が閉じたときにアプリを終えるか（常駐中は終えない。macOS は従来どおり終えない）。 */
function shouldQuitWhenAllClosed({ keepInTray, platform }) {
  return keepInTray !== true && platform !== "darwin";
}

/** 起動時に窓を出さないか。トレイが無いと戻れないので、常駐オンのときだけ。 */
function startsHidden({ argv, keepInTray }) {
  return keepInTray === true && Array.isArray(argv) && argv.includes(HIDDEN_ARG);
}

/** `app.setLoginItemSettings` に渡す値。常駐がオフなら、ログイン時も窓を出して起動する。 */
function loginItemSettings({ launchAtLogin, keepInTray }) {
  return launchAtLogin === true
    ? { openAtLogin: true, args: keepInTray === true ? [HIDDEN_ARG] : [] }
    : { openAtLogin: false, args: [] };
}

module.exports = {
  HIDDEN_ARG,
  createBackgroundPrefs,
  shouldHideOnClose,
  shouldQuitWhenAllClosed,
  startsHidden,
  loginItemSettings,
};
