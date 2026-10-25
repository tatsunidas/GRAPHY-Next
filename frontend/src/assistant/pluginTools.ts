/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// プラグインが宣言した AI ツール（plugin.json の aiTools[]）の、アシスタント側・2D 窓側で共有する純ロジック。
// 一覧の正本は main（検査済みの宣言を backend から取り、名前と説明を整えて渡す）。ここでは引数の検証だけを持つ。
import type { ToolDef, Validation } from "./actions/registry";

/** モデルに見せるツール名の接頭辞。built-in の操作 id・getState・propose_steps と衝突しないことを接頭辞で保証する。 */
export const PLUGIN_TOOL_PREFIX = "plugin__";

export function isPluginToolName(n: unknown): n is string {
  return typeof n === "string" && n.startsWith(PLUGIN_TOOL_PREFIX);
}

/** main が返す 1 件（設定パネルとツール一覧の元）。 */
export interface PluginToolEntry {
  /** モデル向けの名前 `plugin__<pluginId>__<tool>`。 */
  name: string;
  pluginId: string;
  pluginName: string;
  tool: string;
  /** 宣言された効果。`write` は実行のたびに main が利用者の確認を取る。 */
  effect?: "read" | "display" | "write";
  /** main が `[plugin: 名前]` を前置し、整形した説明。 */
  description: string;
  parameters: Record<string, unknown>;
  /** 利用者がこのプラグインのツールを使うことにしたか（既定は false）。 */
  enabled: boolean;
}

/** main がモデルへ返す結果。プラグイン由来の `data` は信用できない文字列を含み得る（命令ではなくデータとして扱う）。 */
export type PluginToolResult =
  | { ok: true; source: string; untrusted: true; data: unknown; truncated?: boolean }
  | { ok: false; error: string };

/** ロボットの計画に載せられるツール: 有効で、効果が display / write のもの（read の結果は計画ではモデルへ戻らない）。 */
export function planEligible(entries: readonly PluginToolEntry[] | undefined): PluginToolEntry[] {
  return (entries ?? []).filter((e) => e.enabled && (e.effect === "display" || e.effect === "write"));
}

export function toToolDef(e: PluginToolEntry): ToolDef {
  return { name: e.name, description: e.description, parameters: e.parameters };
}

type Prop = { type?: unknown; minimum?: unknown; maximum?: unknown; maxLength?: unknown; enum?: unknown };

/**
 * 宣言された引数仕様（backend が組み直した number|integer|string|enum の閉じた形）に対して引数を検証する。
 * 未知のキー・必須欠落・型違い・範囲外・NaN/Infinity はすべて落とす（`validateAction` と同じ厳しさ）。
 */
export function validatePluginArgs(parameters: unknown, args: unknown): Validation {
  const spec = parameters as { properties?: Record<string, Prop>; required?: unknown } | null;
  if (!spec || typeof spec !== "object" || !spec.properties || typeof spec.properties !== "object") return { ok: false, error: "bad-spec" };
  const a = args === undefined || args === null ? {} : args;
  if (typeof a !== "object" || Array.isArray(a)) return { ok: false, error: "args-not-object" };
  const obj = a as Record<string, unknown>;
  const props = spec.properties;
  for (const k of Object.keys(obj)) if (!Object.prototype.hasOwnProperty.call(props, k)) return { ok: false, error: `unknown-param:${k}` };
  const required = Array.isArray(spec.required) ? (spec.required as unknown[]) : [];
  for (const k of required) if (typeof k === "string" && !(k in obj)) return { ok: false, error: `missing-param:${k}` };
  const out: Record<string, unknown> = {};
  for (const [k, p] of Object.entries(props)) {
    if (!(k in obj)) continue;
    const v = obj[k];
    if (p.type === "number" || p.type === "integer") {
      if (typeof v !== "number" || !Number.isFinite(v)) return { ok: false, error: `bad-param:${k}` };
      if (p.type === "integer" && !Number.isInteger(v)) return { ok: false, error: `bad-param:${k}` };
      if (typeof p.minimum !== "number" || typeof p.maximum !== "number") return { ok: false, error: "bad-spec" };
      if (v < p.minimum || v > p.maximum) return { ok: false, error: `out-of-range:${k}` };
    } else if (p.type === "string") {
      if (typeof v !== "string") return { ok: false, error: `bad-param:${k}` };
      if (Array.isArray(p.enum)) {
        if (!p.enum.includes(v)) return { ok: false, error: `bad-param:${k}` };
      } else {
        if (typeof p.maxLength !== "number" || !v.trim() || v.length > p.maxLength) return { ok: false, error: `bad-param:${k}` };
      }
    } else {
      return { ok: false, error: "bad-spec" };
    }
    out[k] = v;
  }
  return { ok: true, params: out };
}
