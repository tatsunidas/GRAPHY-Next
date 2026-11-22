// MCP サーバーの設定（userData/mcp.json）。設計: roadmap fw/mcp-server-design.md §4。electron に依存しない純モジュール。
//
// 🔴 6 つとも既定はオフ。`enabled` は外部 AI クライアントからの接続の受け付け、`includePhi` は患者情報を返すこと、
//    `allowAnalysis` は解析の実行（元データは壊さない）、`allowViewerControl` は 2D ビューアの表示操作（利用者が今見ている画面が動く。
//    元に戻せる操作だけ）、`allowViewerEdit` は 2D ビューアの ROI の作成・計測の全削除（データを変える。実行のたびに main が確認）。
//    `allowViewerCapture` は 2D ビューアの表示中の画像（画素）を返すこと（焼き込みの患者情報があり得る。実行のたびに main が画像を見せて確認。責任は利用者）。
//    `pluginTools` は、外部 AI クライアントへツールを公開するプラグインの ID の配列（既定は空。アシスタントの toggle store とは別の一覧）。
//    オンにする・プラグインを足すときの確認は main が描く（ここでは持たない）。
// 壊れていたら既定（すべてオフ）に戻し、理由を返す。黙って別の値を採らない。
const fs = require("node:fs");
const path = require("node:path");

const KEYS = ["enabled", "includePhi", "allowAnalysis", "allowViewerControl", "allowViewerEdit", "allowViewerCapture"];

/** プラグイン ID の形（assistantPluginTools の NAME_RE の部品と同じ字種）と、公開できる件数の上限。 */
const PLUGIN_ID_RE = /^[A-Za-z0-9_.-]{1,80}$/;
const MAX_PLUGINS = 64;
const validPluginIds = (v) => Array.isArray(v) && v.length <= MAX_PLUGINS && v.every((x) => typeof x === "string" && PLUGIN_ID_RE.test(x)) && new Set(v).size === v.length;

function defaults() {
  return { enabled: false, includePhi: false, allowAnalysis: false, allowViewerControl: false, allowViewerEdit: false, allowViewerCapture: false, pluginTools: [] };
}

function createMcpPrefs({ file }) {
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
      if (j.pluginTools !== undefined) {
        if (!validPluginIds(j.pluginTools)) return { prefs: defaults(), error: "corrupt" };
        prefs.pluginTools = [...j.pluginTools];
      }
      return { prefs, error: null };
    } catch {
      return { prefs: defaults(), error: "corrupt" };
    }
  }

  return {
    get: () => read().prefs,
    readError: () => read().error,
    /** 既知のキーの真偽値と、pluginTools（プラグイン ID の配列）だけ受ける。それ以外は例外（黙って捨てない）。 */
    set(patch) {
      if (!patch || typeof patch !== "object") throw new TypeError("patch");
      for (const [k, v] of Object.entries(patch)) {
        if (k === "pluginTools") {
          if (!validPluginIds(v)) throw new TypeError("pluginTools must be an array of plugin ids");
          continue;
        }
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

/**
 * 変更のうち、**オンにする**（false → true）キーを、確認を出す順に返す。オフにする変更は確認しない（安全側へ戻すだけ）。
 * 確認の文面と表示は main が持つ。ここは「何を確認するか」だけを決める純関数。
 */
function confirmationsFor(prev, patch) {
  return KEYS.filter((k) => patch && patch[k] === true && !(prev && prev[k] === true));
}

/** 変更で**足される**プラグイン ID（公開するプラグインが増えるとき、確認を出す対象）。外す変更は確認しない。 */
function pluginAdditions(prev, patch) {
  if (!patch || !Array.isArray(patch.pluginTools)) return [];
  const had = new Set(prev && Array.isArray(prev.pluginTools) ? prev.pluginTools : []);
  return patch.pluginTools.filter((id) => !had.has(id));
}

module.exports = { createMcpPrefs, confirmationsFor, pluginAdditions, KEYS, defaults, PLUGIN_ID_RE, MAX_PLUGINS };
