/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// 2D 窓でプラグインの AI ツールを実行する薄い実行器。main が中継してきた命令を**もう一度検証**する
// （送信側の検証は信用しない）。manifest（backend が検査した宣言）に無いツール・権限の無いプラグイン・
// 実装の無いツール・承認の無い書き込みツールは実行しない。例外の本文はモデルに返さない（`plugin-error` 固定）。
import { validatePluginArgs } from "../assistant/pluginTools";
import { EffectViolation, type ToolEffect } from "../plugins/hostEffects";
import type { PluginManifest } from "../plugins/pluginTypes";

/** プラグインのコードの実行待ちの上限。暫定値（中継の 5 秒とは別枠）。 */
export const PLUGIN_TOOL_TIMEOUT_MS = 30000;
/** ツール別の待ち時間（`aiTools[].timeoutSec`）の範囲。backend の検査と同じ（manifest が壊れていても超えない）。 */
export const MIN_TOOL_TIMEOUT_MS = 5000;
export const MAX_TOOL_TIMEOUT_MS = 900000;

export function toolTimeoutMs(timeoutSec: unknown): number {
  return typeof timeoutSec === "number" && Number.isFinite(timeoutSec)
    ? Math.min(MAX_TOOL_TIMEOUT_MS, Math.max(MIN_TOOL_TIMEOUT_MS, Math.round(timeoutSec * 1000)))
    : PLUGIN_TOOL_TIMEOUT_MS;
}

export interface PluginToolDeps {
  manifests(): Promise<PluginManifest[]>;
  /** 実装を取り出して host を束ねた関数を返す（無ければ null）。 */
  load(m: PluginManifest, tool: string, effect: ToolEffect): Promise<((args: Record<string, unknown>) => unknown) | null>;
  timeoutMs?: number;
}

export type PluginToolOutcome = { ok: true; data: unknown } | { ok: false; error: string };

export async function executePluginTool(deps: PluginToolDeps, cmd: { pluginId?: unknown; tool?: unknown; params?: unknown; approved?: unknown }): Promise<PluginToolOutcome> {
  if (typeof cmd.pluginId !== "string" || typeof cmd.tool !== "string") return { ok: false, error: "bad-command" };
  let manifests: PluginManifest[];
  try {
    manifests = await deps.manifests();
  } catch {
    return { ok: false, error: "plugin-error" };
  }
  const m = manifests.find((x) => x.id === cmd.pluginId);
  if (!m || !m.permissions?.includes("ai-tools")) return { ok: false, error: "unknown-tool" };
  const spec = m.aiTools?.find((t) => t.name === cmd.tool);
  if (!spec || (spec.effect !== "read" && spec.effect !== "display" && spec.effect !== "write")) return { ok: false, error: "unknown-tool" };
  // 🔴 データを書くツールは、main が利用者の承認を取ったあとにだけ付ける `approved` が無ければ実行しない（送信側の検証は信用しない）。
  if (spec.effect === "write" && cmd.approved !== true) return { ok: false, error: "approval-required" };
  const v = validatePluginArgs(spec.parameters, cmd.params);
  if (!v.ok) return v;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const fn = await deps.load(m, spec.name, spec.effect);
    if (!fn) return { ok: false, error: "no-function" };
    const data = await Promise.race([
      Promise.resolve().then(() => fn(v.params)),
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new Error("timeout")), deps.timeoutMs ?? toolTimeoutMs(spec.timeoutSec));
      }),
    ]);
    return { ok: true, data };
  } catch (e) {
    if (e instanceof EffectViolation) return { ok: false, error: "effect-violation" };
    return { ok: false, error: e instanceof Error && e.message === "timeout" ? "timeout" : "plugin-error" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
