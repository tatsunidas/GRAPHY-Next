// MCP サーバーの設定（userData/mcp.json）。設計: roadmap fw/mcp-server-design.md §4。electron に依存しない純モジュール。
//
// 🔴 3 つとも既定はオフ。`enabled` は外部 AI クライアントからの接続の受け付け、`includePhi` は患者情報を返すこと、
//    `allowAnalysis` は解析の実行（元データは壊さない）。オンにするときの確認は main が描く（ここでは持たない）。
// 壊れていたら既定（すべてオフ）に戻し、理由を返す。黙って別の値を採らない。
const fs = require("node:fs");
const path = require("node:path");

const KEYS = ["enabled", "includePhi", "allowAnalysis"];

function defaults() {
  return { enabled: false, includePhi: false, allowAnalysis: false };
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

module.exports = { createMcpPrefs, KEYS, defaults };
