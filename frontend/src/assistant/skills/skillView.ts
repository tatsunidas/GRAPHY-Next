/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// スキルパネルの表示用の純関数（React 無し）。
import { isPluginToolName, type PluginToolEntry } from "../pluginTools";
import { checkInputValue, pick, type PluginSkillEntry, type Skill, type SkillEntry, type SkillInput, type SkillStep } from "./skillModel";
import { BUNDLED_SKILLS } from "./bundled";

type T = (k: string, v?: Record<string, string | number>) => string;

/** 同梱 + プラグイン + 利用者。同じ id は 同梱 > プラグイン > 利用者 の順に勝つ（下のものは隠れる）。 */
export function mergeSkills(user: readonly Skill[], plugin: readonly PluginSkillEntry[] = []): SkillEntry[] {
  const seen = new Set<string>();
  const out: SkillEntry[] = [];
  const add = (e: SkillEntry) => {
    if (seen.has(e.skill.id)) return;
    seen.add(e.skill.id);
    out.push(e);
  };
  for (const skill of BUNDLED_SKILLS) add({ skill, source: "bundled" });
  for (const p of plugin) add({ skill: p.skill, source: "plugin", pluginName: p.pluginName });
  for (const skill of user) add({ skill, source: "user" });
  return out;
}

export function stepSummary(t: T, s: SkillStep, skill: Skill, locale: string, pluginTools?: readonly PluginToolEntry[]): string {
  if (s.kind === "ask") {
    const spec = skill.inputs.find((i) => i.key === s.input);
    return t("assistant.skill.stepAsk", { name: spec ? pick(spec.label, locale) : s.input });
  }
  if (s.kind === "confirm") return t("assistant.skill.stepConfirm", { message: pick(s.message, locale) });
  const p = Object.entries(s.params)
    .map(([k, v]) => `${k}=${v && typeof v === "object" && !Array.isArray(v) ? `<${(v as { $input: string }).$input}>` : Array.isArray(v) ? `[${v.length}]` : String(v)}`)
    .join(" ");
  const plugin = isPluginToolName(s.id) ? pluginTools?.find((e) => e.name === s.id) : undefined;
  const name = isPluginToolName(s.id) ? (plugin ? `${plugin.pluginName}: ${plugin.tool}` : s.id) : t(`assistant.act.${s.id}`);
  return `${name}${p ? ` ${p}` : ""}`;
}

/** 開始前の入力欄の初期値（文字列）。既定値が無ければ空（数値の最小値などを黙って入れない）。 */
export function initialText(spec: SkillInput): string {
  return spec.default === undefined ? "" : String(spec.default);
}

/** 入力欄の文字列を値にして検証する。数値は空文字・非数を落とす。 */
export function parseFieldText(spec: SkillInput, text: string): { ok: true; value: unknown } | { ok: false } {
  if (spec.type === "number" || spec.type === "integer") {
    if (!text.trim()) return { ok: false };
    return checkInputValue(spec, Number(text));
  }
  return checkInputValue(spec, text);
}
