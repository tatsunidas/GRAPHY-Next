/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// アシスタント窓 → 2D ビューア窓の表示操作の中継（main 側の純ロジック）。`electron` は import しない
// （`node --test` が npm install なしで走るため。窓・IPC は main.js が結線する）。
//
// 🔴 関門は 2 段: ① 送信元がアシスタント窓か（呼び出し側が isAssistantSender で確認）、
//    ② 結果を受け付けるのは**命令を送った窓そのもの**だけ（reqId は乱数。別窓・プラグインが偽の結果を返せない）。
//    操作の中身（許可リスト・引数の範囲）は受信側の 2D 窓が検証する。ここは中身を解釈しない。
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { sanitizeResult } = require("./assistantPluginTools");

/**
 * 応答待ちの上限。2D 窓の実行は同期的で数十 ms のはずなので、数秒で十分という見立ての**暫定値**。
 * 重いスタックで届かないことが分かれば見直す（実測は未取得）。
 */
const DEFAULT_TIMEOUT_MS = 5000;

/** プラグインのツールの実行は、プラグインのコード（外部由来）が動くので表示操作より長く待つ。暫定値。 */
const PLUGIN_TOOL_TIMEOUT_MS = 30000;
const MAX_PLUGIN_ARGS_BYTES = 2000;

const KINDS = new Set(["action", "getState", "getMeasurements", "pluginTool"]);

/** ROI 計測値の結果の上限（バイト）。50 件ぶんが入る大きさ。超えたら切り詰める。暫定値。 */
const MAX_MEASUREMENTS_BYTES = 20000;

/**
 * データを変える操作（frontend/src/assistant/actions/registry.ts の `effect: "write"` と同じ集合）。
 * 🔴 実行のたびに main が利用者の承認を取る。承認の関門は**ここ（main の描くダイアログ）**で、レンダラが渡す値は信用しない:
 *    承認フラグ `approved` は main が承認後にだけ付け、レンダラが付けてきた値は捨てる。
 */
const WRITE_ACTIONS = new Set(["clearMeasurements"]);

/** ジャーナルの上限。1 世代だけ残して上書きする。暫定値（利用実績で見直す）。 */
const DEFAULT_JOURNAL_MAX_BYTES = 1024 * 1024;

/** 引数からジャーナルに残してよい値だけ取る（プリミティブのみ・文字列は短く）。 */
function journalParams(params) {
  if (!params || typeof params !== "object" || Array.isArray(params)) return undefined;
  const out = {};
  for (const [k, v] of Object.entries(params).slice(0, 8)) {
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    else if (typeof v === "boolean") out[k] = v;
    else if (typeof v === "string") out[k] = v.slice(0, 60);
  }
  return out;
}

function createJournal({ file, maxBytes = DEFAULT_JOURNAL_MAX_BYTES, now = Date.now }) {
  return function append(entry) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      try {
        if (fs.statSync(file).size >= maxBytes) fs.renameSync(file, `${file}.1`);
      } catch {
        /* まだ無い */
      }
      fs.appendFileSync(file, JSON.stringify({ ts: new Date(now()).toISOString(), ...entry }) + "\n");
    } catch {
      /* 履歴を書けなくても操作自体は止めない（失敗は呼び出し側に影響させない） */
    }
  };
}

/** 履歴パネル用。新しい順に最大 limit 件。壊れた行は飛ばし、既知のフィールドだけ返す。 */
function readJournal({ file, limit = 50 }) {
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { ok: true, entries: [] };
  }
  const out = [];
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    if (!lines[i]) continue;
    try {
      const e = JSON.parse(lines[i]);
      if (!e || typeof e !== "object" || typeof e.id !== "string") continue;
      out.push({
        ts: typeof e.ts === "string" ? e.ts.slice(0, 40) : "",
        id: e.id.slice(0, 64),
        params: journalParams(e.params),
        ok: e.ok === true,
        error: typeof e.error === "string" ? e.error.slice(0, 80) : undefined,
      });
    } catch {
      /* 壊れた行 */
    }
  }
  return { ok: true, entries: out };
}

/**
 * @param {object} o
 * @param {() => ({send: (ch: string, p: unknown) => void, isDestroyed: () => boolean}|null)} o.resolveTarget 2D 窓の webContents（無ければ null）
 * @param {(entry: object) => void} [o.journal]
 */
function createRelay({ resolveTarget, journal = () => {}, timeoutMs = DEFAULT_TIMEOUT_MS, newId = () => crypto.randomBytes(12).toString("hex") }) {
  const pending = new Map();

  /**
   * @param {{confirm?: (id: string) => Promise<boolean>}} [opts] write 操作の承認を取る関数（main が窓を束ねて渡す）。
   */
  async function relay(sessionId, cmd, opts = {}) {
    if (cmd && typeof cmd === "object" && cmd.kind === "pluginTool") return relayPluginTool(sessionId, cmd, opts);
    if (cmd && typeof cmd === "object" && cmd.kind === "getMeasurements") return relayMeasurements(sessionId, cmd, opts);
    if (cmd && typeof cmd === "object" && cmd.kind === "action" && WRITE_ACTIONS.has(cmd.id)) {
      let approved = false;
      try {
        approved = typeof opts.confirm === "function" && (await opts.confirm(cmd.id)) === true;
      } catch {
        approved = false;
      }
      if (!approved) {
        journal({ sessionId: String(sessionId || "").slice(0, 64), kind: "action", id: cmd.id, params: journalParams(cmd.params), ok: false, error: "declined" });
        return { ok: false, error: "declined" };
      }
      return relayInner(sessionId, cmd, true);
    }
    return relayInner(sessionId, cmd, false);
  }

  // 外部宛てのとき、結果を返す前の承認をセッション×プラグインで 1 回だけにするための記録（承認された組だけ）。
  const granted = new Set();

  /**
   * プラグインのツール。**pluginId / tool はレンダラが名乗った値を使わない**: 名前を main の一覧（opts.pluginTools.lookup。
   * 無効・未許可なら null）で引き直した組だけを 2D 窓へ送る。結果は切り詰めて `untrusted` を付け、
   * 送信先が外部なら返す前に利用者の承認を取る。
   * @param {{pluginTools?: {lookup: (name: string) => ({pluginId: string, tool: string}|null), external: boolean, confirmSend: (entry: object, preview: string) => Promise<boolean>}}} opts
   */
  async function relayPluginTool(sessionId, cmd, opts) {
    const sid = String(sessionId || "").slice(0, 64);
    const pt = opts.pluginTools;
    const entry = pt && typeof cmd.name === "string" && cmd.name.length <= 100 ? pt.lookup(cmd.name) : null;
    if (!entry) {
      journal({ sessionId: sid, kind: "pluginTool", id: "unknown", ok: false, error: "unknown-tool" });
      return { ok: false, error: "unknown-tool" };
    }
    const id = `${entry.pluginId}:${entry.tool}`;
    const params = cmd.params === undefined || cmd.params === null ? {} : cmd.params;
    let size = Infinity;
    try {
      size = Buffer.byteLength(JSON.stringify(params));
    } catch {
      /* 循環など */
    }
    if (typeof params !== "object" || Array.isArray(params) || size > MAX_PLUGIN_ARGS_BYTES) {
      journal({ sessionId: sid, kind: "pluginTool", id, ok: false, error: "bad-command" });
      return { ok: false, error: "bad-command" };
    }
    const res = await relayInner(sid, { kind: "pluginTool", pluginId: entry.pluginId, tool: entry.tool, params }, false, PLUGIN_TOOL_TIMEOUT_MS);
    if (!res || res.ok !== true) return { ok: false, error: typeof (res && res.error) === "string" ? res.error.slice(0, 80) : "plugin-error" };
    const r = sanitizeResult(res.data);
    if (pt.external) {
      const key = `${sid}|${entry.pluginId}`;
      if (!granted.has(key)) {
        let ok = false;
        try {
          ok = (await pt.confirmSend(entry, r.preview.slice(0, 200))) === true;
        } catch {
          ok = false;
        }
        if (!ok) {
          journal({ sessionId: sid, kind: "pluginTool", id, ok: false, error: "declined" });
          return { ok: false, error: "declined" };
        }
        granted.add(key);
      }
    }
    return { ok: true, source: `plugin:${entry.pluginId}`, untrusted: true, data: r.data, ...(r.truncated ? { truncated: true } : {}) };
  }

  /**
   * ROI の計測値（患者由来）。2D 窓が許可リストで作った結果を受け、型を洗って切り詰め、`untrusted` を付ける。
   * 送信先が外部なら返す前に利用者の承認を取る（セッションに 1 回）。ジャーナルには ok と error だけ（値は残さない）。
   * @param {{measurements?: {external: boolean, confirmSend: (preview: string) => Promise<boolean>}}} opts
   */
  async function relayMeasurements(sessionId, cmd, opts) {
    const sid = String(sessionId || "").slice(0, 64);
    const res = await relayInner(sid, { kind: "getMeasurements", includeLabels: cmd.includeLabels === true }, false);
    if (!res || res.ok !== true) {
      const error = typeof (res && res.error) === "string" ? res.error.slice(0, 80) : "no-viewer";
      journal({ sessionId: sid, kind: "getMeasurements", id: "getMeasurements", ok: false, error });
      return { ok: false, error };
    }
    const r = sanitizeResult(res.measurements, MAX_MEASUREMENTS_BYTES);
    const m = opts.measurements;
    if (!m || m.external !== false) {
      // 既定は外部扱い（ローカルと判定できたときだけ省く）
      const key = `${sid}|measurements`;
      if (!granted.has(key)) {
        let ok = false;
        try {
          ok = typeof m?.confirmSend === "function" && (await m.confirmSend(r.preview.slice(0, 200))) === true;
        } catch {
          ok = false;
        }
        if (!ok) {
          journal({ sessionId: sid, kind: "getMeasurements", id: "getMeasurements", ok: false, error: "declined" });
          return { ok: false, error: "declined" };
        }
        granted.add(key);
      }
    }
    journal({ sessionId: sid, kind: "getMeasurements", id: "getMeasurements", ok: true });
    return { ok: true, untrusted: true, measurements: r.data, ...(r.truncated ? { truncated: true } : {}) };
  }

  function relayInner(sessionId, cmd, approved, timeout = timeoutMs) {
    if (!cmd || typeof cmd !== "object" || !KINDS.has(cmd.kind)) return Promise.resolve({ ok: false, error: "bad-command" });
    if (cmd.kind === "action" && (typeof cmd.id !== "string" || cmd.id.length > 64)) return Promise.resolve({ ok: false, error: "bad-command" });
    const target = resolveTarget();
    const log = (res) => {
      if (cmd.kind === "action") {
        journal({ sessionId: String(sessionId || "").slice(0, 64), kind: "action", id: cmd.id, params: journalParams(cmd.params), ok: !!(res && res.ok), error: res && res.ok ? undefined : res && res.error });
      } else if (cmd.kind === "pluginTool") {
        // 結果の中身は残さない（ok と error だけ）
        journal({ sessionId: String(sessionId || "").slice(0, 64), kind: "pluginTool", id: `${cmd.pluginId}:${cmd.tool}`, params: journalParams(cmd.params), ok: !!(res && res.ok), error: res && res.ok ? undefined : res && res.error });
      }
      return res;
    };
    if (!target || target.isDestroyed()) return Promise.resolve(log({ ok: false, error: "no-viewer" }));
    const reqId = newId();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(reqId);
        resolve(log({ ok: false, error: "timeout" }));
      }, timeout);
      pending.set(reqId, {
        target,
        done: (res) => {
          clearTimeout(timer);
          resolve(log(res));
        },
      });
      try {
        const payload =
          cmd.kind === "pluginTool"
            ? { reqId, kind: cmd.kind, pluginId: cmd.pluginId, tool: cmd.tool, params: cmd.params }
            : { reqId, kind: cmd.kind, id: cmd.id, params: cmd.params, includeLabels: cmd.includeLabels === true, approved: approved === true };
        target.send("graphy:viewer-cmd", payload);
      } catch {
        pending.delete(reqId);
        clearTimeout(timer);
        resolve(log({ ok: false, error: "no-viewer" }));
      }
    });
  }

  /** 2D 窓からの結果。**命令を送った窓の webContents からのものだけ**受理する。 */
  function handleResult(senderContents, reqId, result) {
    const p = typeof reqId === "string" ? pending.get(reqId) : undefined;
    if (!p || p.target !== senderContents) return false;
    pending.delete(reqId);
    const ok = result && typeof result === "object" && typeof result.ok === "boolean";
    p.done(ok ? result : { ok: false, error: "bad-result" });
    return true;
  }

  return { relay, handleResult, pendingCount: () => pending.size };
}

module.exports = { WRITE_ACTIONS, createRelay, createJournal, journalParams, readJournal, DEFAULT_TIMEOUT_MS };
