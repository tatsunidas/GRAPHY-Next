/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// スキル = 入力を尋ね・途中で確認しながら進む、検証済み操作の並び（データであってコードではない）。
// 保存・取り込み・実行のたびに `validateSkill` を通す（ファイルが書き換えられても、許可リストにない操作や範囲外の値は実行されない）。
//
// 🔴 引数に入れられる動的な値は `{"$input": "<入力のキー>"}` だけ。前のステップの結果（プラグイン由来の untrusted な値を含む）を
//    後続の引数に渡す書き方は持たない。式も持たない。
import { isActionId, isWriteAction, validateAction } from "../actions/registry";
import { isPluginToolName, planEligible, validatePluginArgs, type PluginToolEntry } from "../pluginTools";

export const SKILL_SCHEMA_VERSION = 1;
/** desktop/assistantSkills.js と同じ上限（暫定値）。 */
export const MAX_SKILL_STEPS = 40;
export const MAX_SKILL_INPUTS = 8;
export const MAX_SKILL_TITLE = 60;
export const MAX_SKILL_DESC = 300;
export const MAX_SKILL_MESSAGE = 200;
export const MAX_SKILLS = 50;

export type Locale = "ja" | "en";
export interface LocalText {
  ja: string;
  en: string;
}

export type SkillInput =
  | { key: string; label: LocalText; type: "number" | "integer"; min: number; max: number; default?: number }
  | { key: string; label: LocalText; type: "string"; maxLength: number; default?: string }
  | { key: string; label: LocalText; type: "enum"; values: string[]; default?: string };

export interface InputRef {
  $input: string;
}

export type SkillStep =
  | { kind: "tool"; id: string; params: Record<string, unknown> }
  | { kind: "ask"; input: string }
  | { kind: "confirm"; message: LocalText };

export interface Skill {
  schemaVersion: 1;
  id: string;
  title: LocalText;
  description: LocalText;
  inputs: SkillInput[];
  steps: SkillStep[];
}

export type SkillSource = "bundled" | "user";
export interface SkillEntry {
  skill: Skill;
  source: SkillSource;
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const KEY_RE = /^[a-z][A-Za-z0-9]{0,23}$/;

export function pick(t: LocalText, locale: string): string {
  return locale === "en" ? t.en || t.ja : t.ja || t.en;
}

function localText(raw: unknown, max: number): LocalText | null {
  if (!raw || typeof raw !== "object") return null;
  const { ja, en } = raw as { ja?: unknown; en?: unknown };
  if (typeof ja !== "string" || typeof en !== "string") return null;
  if (ja.length > max || en.length > max || !(ja.trim() || en.trim())) return null;
  return { ja, en };
}

export function isInputRef(v: unknown): v is InputRef {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const k = Object.keys(v);
  return k.length === 1 && k[0] === "$input" && typeof (v as InputRef).$input === "string";
}

export type ValueCheck = { ok: true; value: unknown } | { ok: false };

/** 入力 1 つの値の検証（実行時に利用者の入力と既定値へ必ず掛ける）。 */
export function checkInputValue(spec: SkillInput, v: unknown): ValueCheck {
  switch (spec.type) {
    case "number":
    case "integer":
      if (typeof v !== "number" || !Number.isFinite(v)) return { ok: false };
      if (spec.type === "integer" && !Number.isInteger(v)) return { ok: false };
      if (v < spec.min || v > spec.max) return { ok: false };
      return { ok: true, value: v };
    case "string":
      if (typeof v !== "string" || !v.trim() || v.length > spec.maxLength) return { ok: false };
      return { ok: true, value: v };
    case "enum":
      if (typeof v !== "string" || !spec.values.includes(v)) return { ok: false };
      return { ok: true, value: v };
  }
}

function parseInput(raw: unknown): SkillInput | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.key !== "string" || !KEY_RE.test(r.key)) return null;
  const label = localText(r.label, MAX_SKILL_TITLE);
  if (!label) return null;
  let spec: SkillInput;
  if (r.type === "number" || r.type === "integer") {
    if (typeof r.min !== "number" || typeof r.max !== "number" || !Number.isFinite(r.min) || !Number.isFinite(r.max) || r.min > r.max) return null;
    spec = { key: r.key, label, type: r.type, min: r.min, max: r.max };
  } else if (r.type === "string") {
    if (typeof r.maxLength !== "number" || !Number.isInteger(r.maxLength) || r.maxLength < 1 || r.maxLength > 200) return null;
    spec = { key: r.key, label, type: "string", maxLength: r.maxLength };
  } else if (r.type === "enum") {
    if (!Array.isArray(r.values) || r.values.length < 1 || r.values.length > 16) return null;
    if (!r.values.every((v) => typeof v === "string" && v.length >= 1 && v.length <= 40)) return null;
    spec = { key: r.key, label, type: "enum", values: [...(r.values as string[])] };
  } else return null;
  if (r.default !== undefined) {
    const c = checkInputValue(spec, r.default);
    if (!c.ok) return null;
    (spec as { default?: unknown }).default = c.value;
  }
  return spec;
}

function sampleOf(spec: SkillInput): unknown {
  if (spec.default !== undefined) return spec.default;
  if (spec.type === "enum") return spec.values[0];
  if (spec.type === "string") return "x";
  return spec.min;
}

/** 動的な値（`$input`）を値に置き換える。置換後の値の検証は呼び出し側（registry / プラグイン仕様）が行う。 */
export function bindParams(params: Record<string, unknown>, values: Record<string, unknown>): { ok: true; params: Record<string, unknown> } | { ok: false; error: string } {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (isInputRef(v)) {
      if (!(v.$input in values)) return { ok: false, error: `unbound-input:${v.$input}` };
      out[k] = values[v.$input];
    } else if (v && typeof v === "object" && !Array.isArray(v)) {
      return { ok: false, error: `bad-param:${k}` }; // `$input` 以外のオブジェクト（式など）は受け付けない
    } else {
      out[k] = v;
    }
  }
  return { ok: true, params: out };
}

export type SkillCheck = { ok: true; skill: Skill } | { ok: false; error: string };

/**
 * スキル 1 件を検証して**作り直す**（余計なキーは捨てる）。
 * 操作 id・引数は registry（built-in）と宣言仕様（プラグイン）で検査する。動的な値は仮の値で検査し、実行時にもう一度検査する。
 * `pluginTools` を渡すと、プラグインのツールが存在し有効であることまで確かめる。省略時は名前の形だけ見る（一覧表示用）。
 */
export function validateSkill(raw: unknown, pluginTools?: readonly PluginToolEntry[]): SkillCheck {
  if (!raw || typeof raw !== "object") return { ok: false, error: "not-object" };
  const r = raw as Record<string, unknown>;
  if (r.schemaVersion !== SKILL_SCHEMA_VERSION) return { ok: false, error: "bad-version" };
  if (typeof r.id !== "string" || !ID_RE.test(r.id)) return { ok: false, error: "bad-id" };
  const title = localText(r.title, MAX_SKILL_TITLE);
  if (!title) return { ok: false, error: "bad-title" };
  const description = localText(r.description, MAX_SKILL_DESC);
  if (!description) return { ok: false, error: "bad-description" };
  const rawInputs = r.inputs === undefined ? [] : r.inputs;
  if (!Array.isArray(rawInputs) || rawInputs.length > MAX_SKILL_INPUTS) return { ok: false, error: "bad-inputs" };
  const inputs: SkillInput[] = [];
  for (const i of rawInputs) {
    const p = parseInput(i);
    if (!p || inputs.some((x) => x.key === p.key)) return { ok: false, error: "bad-inputs" };
    inputs.push(p);
  }
  if (!Array.isArray(r.steps) || r.steps.length < 1 || r.steps.length > MAX_SKILL_STEPS) return { ok: false, error: "bad-steps-length" };

  const askedAt = new Map<string, number>();
  const steps: SkillStep[] = [];
  for (let i = 0; i < r.steps.length; i++) {
    const s = r.steps[i] as Record<string, unknown> | null;
    const at = (e: string) => ({ ok: false as const, error: `step-${i + 1}:${e}` });
    if (!s || typeof s !== "object") return at("not-object");
    if (s.kind === "ask") {
      if (typeof s.input !== "string" || !inputs.some((x) => x.key === s.input)) return at("unknown-input");
      if (askedAt.has(s.input)) return at("duplicate-ask");
      askedAt.set(s.input, i);
      steps.push({ kind: "ask", input: s.input });
    } else if (s.kind === "confirm") {
      const message = localText(s.message, MAX_SKILL_MESSAGE);
      if (!message) return at("bad-message");
      steps.push({ kind: "confirm", message });
    } else if (s.kind === "tool") {
      if (typeof s.id !== "string") return at("bad-id");
      const params = s.params === undefined ? {} : s.params;
      if (!params || typeof params !== "object" || Array.isArray(params)) return at("args-not-object");
      const pr = params as Record<string, unknown>;
      // 参照する入力は、定義済みで、(ask の入力なら) その ask より後でなければならない。
      for (const v of Object.values(pr)) {
        if (!isInputRef(v)) continue;
        if (!inputs.some((x) => x.key === v.$input)) return at(`unknown-input:${v.$input}`);
        const a = askedAt.get(v.$input);
        const hasAsk = r.steps.some((x) => (x as { kind?: unknown; input?: unknown } | null)?.kind === "ask" && (x as { input?: unknown }).input === v.$input);
        if (hasAsk && a === undefined) return at(`input-before-ask:${v.$input}`);
      }
      const sample: Record<string, unknown> = {};
      for (const x of inputs) sample[x.key] = sampleOf(x);
      const bound = bindParams(pr, sample);
      if (!bound.ok) return at(bound.error);
      if (isPluginToolName(s.id)) {
        if (pluginTools) {
          const entry = planEligible(pluginTools).find((e) => e.name === s.id);
          if (!entry) return at("unknown-tool");
          const v = validatePluginArgs(entry.parameters, bound.params);
          if (!v.ok) return at(v.error);
        }
      } else {
        if (!isActionId(s.id)) return at("unknown-action");
        const v = validateAction(s.id, bound.params);
        if (!v.ok) return at(v.error);
      }
      steps.push({ kind: "tool", id: s.id, params: pr });
    } else return at("bad-kind");
  }
  return { ok: true, skill: { schemaVersion: 1, id: r.id, title, description, inputs, steps } };
}

/** 開始前の入力欄に出すもの（ask のステップが無い入力）。 */
export function upFrontInputs(skill: Skill): SkillInput[] {
  const asked = new Set(skill.steps.filter((s): s is Extract<SkillStep, { kind: "ask" }> => s.kind === "ask").map((s) => s.input));
  return skill.inputs.filter((i) => !asked.has(i.key));
}

/** スキル全体の効果: write のツールを 1 つでも含めば write。 */
export function skillEffect(skill: Skill, pluginTools?: readonly PluginToolEntry[]): "display" | "write" {
  for (const s of skill.steps) {
    if (s.kind !== "tool") continue;
    if (isPluginToolName(s.id)) {
      if (pluginTools?.find((e) => e.name === s.id)?.effect === "write") return "write";
    } else if (isWriteAction(s.id)) return "write";
  }
  return "display";
}

/** 書き出し（JSON 文字列）。 */
export function exportSkill(skill: Skill): string {
  return JSON.stringify(skill, null, 2);
}

/** 取り込み（JSON 文字列 → 検証済みスキル）。大きすぎる・壊れている・検証に通らないものは受け付けない。 */
export function parseSkillText(text: string, pluginTools?: readonly PluginToolEntry[]): SkillCheck {
  if (typeof text !== "string" || text.length > 64 * 1024) return { ok: false, error: "too-large" };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: "bad-json" };
  }
  return validateSkill(raw, pluginTools);
}
