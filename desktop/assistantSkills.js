/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// アシスタントのスキル（利用者が保存・取り込んだもの）の保存。`electron` は import しない（`node --test` が npm install なしで走るため）。
//
// 🔴 ここで見るのは**形と大きさだけ**。操作 id が許可リストにあるか・引数が範囲内かは、実行する側
//    （アシスタント窓の validateSkill → 2D 窓の registry）が毎回検証する。ファイルを書き換えられても、未知の操作は実行されない。
const fs = require("node:fs");
const path = require("node:path");

/** 暫定値（利用実績で見直す）。frontend/src/assistant/skills/skillModel.ts と同じ。 */
const MAX_SKILLS = 50;
const MAX_STEPS = 40;
const MAX_INPUTS = 8;
const MAX_TITLE = 60;
const MAX_DESC = 300;
const MAX_MESSAGE = 200;
const MAX_PARAM_KEYS = 8;
const MAX_POINTS = 64;
const MAX_STRING = 200;

const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const KEY_RE = /^[a-z][A-Za-z0-9]{0,23}$/;
const TOOL_ID_RE = /^[A-Za-z0-9_]{1,64}$/;

function localText(raw, max) {
  if (!raw || typeof raw !== "object") return null;
  const { ja, en } = raw;
  if (typeof ja !== "string" || typeof en !== "string") return null;
  if (ja.length > max || en.length > max || !(ja.trim() || en.trim())) return null;
  return { ja, en };
}

function num(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function sanitizeInput(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.key !== "string" || !KEY_RE.test(raw.key)) return null;
  const label = localText(raw.label, MAX_TITLE);
  if (!label) return null;
  const out = { key: raw.key, label, type: raw.type };
  if (raw.type === "number" || raw.type === "integer") {
    if (!num(raw.min) || !num(raw.max) || raw.min > raw.max) return null;
    out.min = raw.min;
    out.max = raw.max;
    if (raw.default !== undefined) {
      if (!num(raw.default)) return null;
      out.default = raw.default;
    }
  } else if (raw.type === "string") {
    if (!Number.isInteger(raw.maxLength) || raw.maxLength < 1 || raw.maxLength > MAX_STRING) return null;
    out.maxLength = raw.maxLength;
    if (raw.default !== undefined) {
      if (typeof raw.default !== "string" || raw.default.length > MAX_STRING) return null;
      out.default = raw.default;
    }
  } else if (raw.type === "enum") {
    if (!Array.isArray(raw.values) || raw.values.length < 1 || raw.values.length > 16) return null;
    if (!raw.values.every((v) => typeof v === "string" && v.length >= 1 && v.length <= 40)) return null;
    out.values = [...raw.values];
    if (raw.default !== undefined) {
      if (typeof raw.default !== "string" || !out.values.includes(raw.default)) return null;
      out.default = raw.default;
    }
  } else return null;
  return out;
}

/** 引数の値: 数値・真偽・短い文字列・`{"$input": key}`・[u,v] の組の配列。それ以外（式・入れ子）は落とす。 */
function sanitizeParamValue(v) {
  if (num(v) || typeof v === "boolean") return { v };
  if (typeof v === "string") return v.length <= MAX_STRING ? { v } : null;
  if (Array.isArray(v)) {
    if (v.length > MAX_POINTS) return null;
    if (!v.every((p) => Array.isArray(p) && p.length === 2 && num(p[0]) && num(p[1]))) return null;
    return { v: v.map((p) => [p[0], p[1]]) };
  }
  if (v && typeof v === "object") {
    const k = Object.keys(v);
    if (k.length === 1 && k[0] === "$input" && typeof v.$input === "string" && KEY_RE.test(v.$input)) return { v: { $input: v.$input } };
  }
  return null;
}

function sanitizeStep(raw, inputKeys) {
  if (!raw || typeof raw !== "object") return null;
  if (raw.kind === "ask") return typeof raw.input === "string" && inputKeys.has(raw.input) ? { kind: "ask", input: raw.input } : null;
  if (raw.kind === "confirm") {
    const message = localText(raw.message, MAX_MESSAGE);
    return message ? { kind: "confirm", message } : null;
  }
  if (raw.kind === "tool") {
    if (typeof raw.id !== "string" || !TOOL_ID_RE.test(raw.id)) return null;
    const p = raw.params === undefined ? {} : raw.params;
    if (!p || typeof p !== "object" || Array.isArray(p)) return null;
    const entries = Object.entries(p);
    if (entries.length > MAX_PARAM_KEYS) return null;
    const params = {};
    for (const [k, v] of entries) {
      if (k.length > 32) return null;
      const s = sanitizeParamValue(v);
      if (!s) return null;
      if (s.v && typeof s.v === "object" && !Array.isArray(s.v) && !inputKeys.has(s.v.$input)) return null;
      params[k] = s.v;
    }
    return { kind: "tool", id: raw.id, params };
  }
  return null;
}

/** 1 件を検査して整形する。不正なら null。 */
function sanitizeSkill(raw) {
  if (!raw || typeof raw !== "object" || raw.schemaVersion !== 1) return null;
  if (typeof raw.id !== "string" || !ID_RE.test(raw.id)) return null;
  const title = localText(raw.title, MAX_TITLE);
  const description = localText(raw.description, MAX_DESC);
  if (!title || !description) return null;
  const rawInputs = raw.inputs === undefined ? [] : raw.inputs;
  if (!Array.isArray(rawInputs) || rawInputs.length > MAX_INPUTS) return null;
  const inputs = [];
  for (const i of rawInputs) {
    const s = sanitizeInput(i);
    if (!s || inputs.some((x) => x.key === s.key)) return null;
    inputs.push(s);
  }
  if (!Array.isArray(raw.steps) || raw.steps.length < 1 || raw.steps.length > MAX_STEPS) return null;
  const keys = new Set(inputs.map((i) => i.key));
  const steps = [];
  for (const st of raw.steps) {
    const s = sanitizeStep(st, keys);
    if (!s) return null;
    steps.push(s);
  }
  return { schemaVersion: 1, id: raw.id, title, description, inputs, steps };
}

function createStore({ file }) {
  function read() {
    try {
      const j = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!j || !Array.isArray(j.skills)) return [];
      return j.skills.map(sanitizeSkill).filter(Boolean).slice(0, MAX_SKILLS);
    } catch {
      return []; // 無い・壊れている → 空として扱う（次の保存で作り直す）
    }
  }
  function write(skills) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, skills }, null, 2));
    fs.renameSync(tmp, file);
  }
  return {
    list() {
      return { ok: true, skills: read() };
    },
    save(raw) {
      const s = sanitizeSkill(raw);
      if (!s) return { ok: false, error: "bad-skill" };
      const cur = read();
      const i = cur.findIndex((x) => x.id === s.id);
      if (i < 0 && cur.length >= MAX_SKILLS) return { ok: false, error: "too-many" };
      if (i >= 0) cur[i] = s;
      else cur.push(s);
      try {
        write(cur);
      } catch {
        return { ok: false, error: "write-failed" };
      }
      return { ok: true, skill: s };
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

module.exports = { createStore, sanitizeSkill, MAX_SKILLS, MAX_STEPS, MAX_INPUTS };
