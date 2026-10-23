/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// アシスタントのマクロ（表示操作の並び）の保存。`electron` は import しない（`node --test` が npm install なしで走るため）。
//
// 🔴 ここで見るのは**形と大きさだけ**。操作 id が許可リストにあるか・引数が範囲内かは、実行する側
//    （アシスタント窓 → 2D 窓）が毎回検証する。ファイルを書き換えられても、未知の操作は実行されない。
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

/** 暫定値（利用実績で見直す）。 */
const MAX_MACROS = 50;
const MAX_STEPS = 30;
const MAX_NAME = 60;

function sanitizeParams(params) {
  if (params === undefined || params === null) return {};
  if (typeof params !== "object" || Array.isArray(params)) return null;
  const entries = Object.entries(params);
  if (entries.length > 8) return null;
  const out = {};
  for (const [k, v] of entries) {
    if (k.length > 32) return null;
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    else if (typeof v === "boolean") out[k] = v;
    else if (typeof v === "string" && v.length <= 60) out[k] = v;
    else return null;
  }
  return out;
}

/** 1 件を検証して整形する。不正なら null。id と createdAt が無ければ付ける。 */
function sanitizeMacro(raw, { newId = () => crypto.randomBytes(8).toString("hex"), now = Date.now } = {}) {
  if (!raw || typeof raw !== "object") return null;
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name || name.length > MAX_NAME) return null;
  if (!Array.isArray(raw.steps) || raw.steps.length < 1 || raw.steps.length > MAX_STEPS) return null;
  const steps = [];
  for (const s of raw.steps) {
    if (!s || typeof s !== "object" || typeof s.id !== "string" || !s.id || s.id.length > 64) return null;
    const params = sanitizeParams(s.params);
    if (!params) return null;
    steps.push({ id: s.id, params });
  }
  const id = typeof raw.id === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(raw.id) ? raw.id : newId();
  const createdAt = typeof raw.createdAt === "string" && raw.createdAt.length <= 40 ? raw.createdAt : new Date(now()).toISOString();
  return { id, name, steps, createdAt };
}

function createStore({ file, newId, now }) {
  function read() {
    try {
      const j = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!j || !Array.isArray(j.macros)) return [];
      return j.macros.map((m) => sanitizeMacro(m, { newId, now })).filter(Boolean).slice(0, MAX_MACROS);
    } catch {
      return []; // 無い・壊れている → 空として扱う（次の保存で作り直す）
    }
  }
  function write(macros) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, macros }, null, 2));
    fs.renameSync(tmp, file);
  }
  return {
    list() {
      return { ok: true, macros: read() };
    },
    save(raw) {
      const m = sanitizeMacro(raw, { newId, now });
      if (!m) return { ok: false, error: "bad-macro" };
      const cur = read();
      const i = cur.findIndex((x) => x.id === m.id);
      if (i < 0 && cur.length >= MAX_MACROS) return { ok: false, error: "too-many" };
      if (i >= 0) cur[i] = m;
      else cur.push(m);
      try {
        write(cur);
      } catch {
        return { ok: false, error: "write-failed" };
      }
      return { ok: true, macro: m };
    },
    remove(id) {
      if (typeof id !== "string") return { ok: false, error: "bad-id" };
      const cur = read();
      const next = cur.filter((x) => x.id !== id);
      if (next.length === cur.length) return { ok: false, error: "not-found" };
      try {
        write(next);
      } catch {
        return { ok: false, error: "write-failed" };
      }
      return { ok: true };
    },
  };
}

module.exports = { createStore, sanitizeMacro, MAX_MACROS, MAX_STEPS, MAX_NAME };
