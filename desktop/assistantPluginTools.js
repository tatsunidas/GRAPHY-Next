/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// プラグインが宣言した AI ツール（plugin.json の aiTools[]）の main 側の純ロジック。`electron` は import しない
// （`node --test` が npm install なしで走るため）。
//
// 🔴 ツールの一覧の正本は main。backend の GET /api/plugins（検査済み）から**ここで組み直す**。レンダラ・2D 窓が
//    名乗る pluginId / tool は信用せず、ここにある（かつ利用者がオンにした）組だけを 2D 窓へ中継する。
// 🔴 プラグインの結果は信用できない文字列。大きさと形をここで切り詰め、モデルへは `untrusted` を付けて返す。
const fs = require("node:fs");
const path = require("node:path");

const PREFIX = "plugin__";
/** 全プラグイン合計のツール数。暫定値（利用実績で見直す）。 */
const MAX_TOTAL_TOOLS = 32;
const MAX_DESCRIPTION = 300;
/** 結果の大きさの上限（直列化後）。暫定値。 */
const MAX_RESULT_BYTES = 4096;
const MAX_DEPTH = 3;
const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** 説明・表示名を 1 行に畳む（制御文字を除き、空白を詰めて長さを切る）。モデルと設定画面に出る信用できない文字列。 */
function oneLine(s, max) {
  return String(s ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/**
 * backend の /api/plugins の本文からツール一覧を作る。名前がモデル向けの規則に収まらない・合計の上限を超えるものは捨てる。
 * @returns {{name: string, pluginId: string, pluginName: string, tool: string, effect: string, description: string, parameters: object}[]}
 */
function buildEntries(plugins) {
  const out = [];
  if (!Array.isArray(plugins)) return out;
  for (const p of plugins) {
    if (!p || typeof p.id !== "string" || !Array.isArray(p.aiTools) || !Array.isArray(p.permissions) || !p.permissions.includes("ai-tools")) continue;
    const pluginName = oneLine(p.name || p.id, 60);
    for (const t of p.aiTools) {
      if (!t || typeof t.name !== "string" || !t.parameters || typeof t.parameters !== "object") continue;
      if (t.effect !== "read" && t.effect !== "display" && t.effect !== "write") continue;
      const name = `${PREFIX}${p.id}__${t.name}`;
      if (!NAME_RE.test(name)) continue;
      // 名乗りは main が付ける（プラグインの説明文が別のプラグイン・本体を名乗れない）
      const description = `[plugin: ${pluginName}] ${t.effect === "write" ? "(writes data) " : ""}${oneLine(t.description, MAX_DESCRIPTION)}`;
      // 待ち時間は backend が範囲を検査した値。ここでも整数・範囲だけを通す（無ければ既定のまま）
      const timeoutMs = Number.isInteger(t.timeoutSec) && t.timeoutSec >= 5 && t.timeoutSec <= 900 ? t.timeoutSec * 1000 : undefined;
      out.push({ name, pluginId: p.id, pluginName, tool: t.name, effect: t.effect, description, parameters: t.parameters, ...(timeoutMs ? { timeoutMs } : {}) });
      if (out.length >= MAX_TOTAL_TOOLS) return out;
    }
  }
  return out;
}

/**
 * 結果をモデルへ返せる形に切り詰める。関数・バイナリ・循環・深すぎる入れ子は落とし、直列化が MAX_RESULT_BYTES を超えたら
 * 切り捨てて `truncated:true` を付ける。
 */
function sanitizeResult(value, maxBytes = MAX_RESULT_BYTES) {
  const clean = (v, depth) => {
    if (v === null) return null;
    if (typeof v === "string") return v;
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return Number.isFinite(v) ? v : null;
    if (depth >= MAX_DEPTH) return undefined;
    if (Array.isArray(v)) return v.slice(0, 200).map((x) => {
      const c = clean(x, depth + 1);
      return c === undefined ? null : c;
    });
    if (typeof v === "object" && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)) {
      const o = {};
      for (const [k, x] of Object.entries(v).slice(0, 100)) {
        const c = clean(x, depth + 1);
        if (c !== undefined) o[k.slice(0, 64)] = c;
      }
      return o;
    }
    return undefined; // 関数・Symbol・bigint・クラスのインスタンス（バイナリ含む）
  };
  const c = clean(value, 0);
  let text = JSON.stringify(c === undefined ? null : c);
  if (Buffer.byteLength(text) <= maxBytes) return { data: c === undefined ? null : c, truncated: false, preview: text };
  // 超過: 文字列として切る（途中で切れた JSON をデータとして返さない）
  text = text.slice(0, Math.max(0, maxBytes - 16));
  return { data: text, truncated: true, preview: text };
}

/** 利用者がオンにしたプラグイン id の保存（userData/assistant-plugin-tools.json）。既定は全部オフ。 */
function createToggleStore({ file }) {
  function read() {
    try {
      const j = JSON.parse(fs.readFileSync(file, "utf8"));
      return new Set(Array.isArray(j.enabled) ? j.enabled.filter((x) => typeof x === "string" && x.length <= 80).slice(0, 200) : []);
    } catch {
      return new Set(); // 無い・壊れている → 全部オフ
    }
  }
  return {
    enabled: read,
    set(pluginId, on) {
      if (typeof pluginId !== "string" || !pluginId || pluginId.length > 80) return { ok: false, error: "bad-plugin" };
      const s = read();
      if (on === true) s.add(pluginId);
      else s.delete(pluginId);
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ enabled: [...s] }, null, 2));
      } catch {
        return { ok: false, error: "write-failed" };
      }
      return { ok: true };
    },
  };
}

module.exports = { PREFIX, MAX_TOTAL_TOOLS, MAX_RESULT_BYTES, oneLine, buildEntries, sanitizeResult, createToggleStore };
