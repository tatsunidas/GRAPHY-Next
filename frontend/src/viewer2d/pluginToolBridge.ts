/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// 2D 窓でプラグインの AI ツールを実行する薄い実行器。main が中継してきた命令を**もう一度検証**する
// （送信側の検証は信用しない）。manifest（backend が検査した宣言）に無いツール・権限の無いプラグイン・
// 実装の無いツールは実行しない。例外の本文はモデルに返さない（`plugin-error` 固定）。
import { validatePluginArgs } from "../assistant/pluginTools";
import type { PluginManifest } from "../plugins/pluginTypes";

/** プラグインのコードの実行待ちの上限。暫定値（中継の 5 秒とは別枠）。 */
export const PLUGIN_TOOL_TIMEOUT_MS = 30000;

export interface PluginToolDeps {
  manifests(): Promise<PluginManifest[]>;
  /** 実装を取り出して host を束ねた関数を返す（無ければ null）。 */
  load(m: PluginManifest, tool: string): Promise<((args: Record<string, unknown>) => unknown) | null>;
  timeoutMs?: number;
}

export type PluginToolOutcome = { ok: true; data: unknown } | { ok: false; error: string };

export async function executePluginTool(deps: PluginToolDeps, cmd: { pluginId?: unknown; tool?: unknown; params?: unknown }): Promise<PluginToolOutcome> {
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
  if (!spec || (spec.effect !== "read" && spec.effect !== "display")) return { ok: false, error: "unknown-tool" };
  const v = validatePluginArgs(spec.parameters, cmd.params);
  if (!v.ok) return v;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const fn = await deps.load(m, spec.name);
    if (!fn) return { ok: false, error: "no-function" };
    const data = await Promise.race([
      Promise.resolve().then(() => fn(v.params)),
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new Error("timeout")), deps.timeoutMs ?? PLUGIN_TOOL_TIMEOUT_MS);
      }),
    ]);
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e instanceof Error && e.message === "timeout" ? "timeout" : "plugin-error" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
