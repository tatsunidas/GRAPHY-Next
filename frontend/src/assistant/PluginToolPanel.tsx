/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// 「プラグインのツール」の設定パネル（アシスタント窓）。プラグインが宣言した AI ツールを、プラグイン単位でオン/オフする。
// 既定は全部オフ。説明文はプラグインが書いた信用できない文字列なので、短く切って表示だけする（main が整形済み）。
import type { CSSProperties } from "react";
import type { PluginToolEntry } from "./pluginTools";

type T = (k: string, v?: Record<string, string | number>) => string;

export interface PluginToolApi {
  list: () => Promise<{ ok: boolean; tools?: PluginToolEntry[]; error?: string }>;
  set: (pluginId: string, on: boolean) => Promise<{ ok: boolean; tools?: PluginToolEntry[]; error?: string }>;
}

export function PluginToolPanel({ tools, onToggle, busy, t }: { tools: PluginToolEntry[]; onToggle: (pluginId: string, on: boolean) => void; busy: boolean; t: T }) {
  const byPlugin = new Map<string, PluginToolEntry[]>();
  for (const e of tools) byPlugin.set(e.pluginId, [...(byPlugin.get(e.pluginId) ?? []), e]);
  return (
    <div style={S.panel} data-testid="assistant-plugintools-panel">
      <div style={S.title}>{t("assistant.plugintools.title")}</div>
      {byPlugin.size === 0 ? (
        <div style={S.dim} data-testid="assistant-plugintools-empty">{t("assistant.plugintools.empty")}</div>
      ) : (
        [...byPlugin.entries()].map(([pluginId, list]) => (
          <div key={pluginId} style={S.group} data-testid={`assistant-plugintools-${pluginId}`}>
            <label style={S.row}>
              <input
                type="checkbox"
                checked={list[0].enabled}
                disabled={busy}
                onChange={(e) => onToggle(pluginId, e.target.checked)}
                data-testid={`assistant-plugintools-toggle-${pluginId}`}
              />
              <strong>{list[0].pluginName}</strong>
            </label>
            {list.map((e) => (
              <div key={e.name} style={S.tool}>
                <code>{e.tool}</code>{" "}
                {e.effect === "write" && <span style={S.write} data-testid={`assistant-plugintools-write-${e.pluginId}-${e.tool}`} title={t("assistant.plugintools.writeHelp")}>{t("assistant.plugintools.write")}</span>}{" "}
                <span style={S.dim}>{e.description.replace(/^\[plugin: [^\]]*\] (\(writes data\) )?/, "").slice(0, 120)}</span>
              </div>
            ))}
          </div>
        ))
      )}
      <div style={S.dim}>{t("assistant.plugintools.note")}</div>
    </div>
  );
}

const S: Record<string, CSSProperties> = {
  panel: { padding: "8px 12px", borderTop: "1px solid #3a3b3f", fontSize: 12, display: "flex", flexDirection: "column", gap: 6, maxHeight: 220, overflowY: "auto" },
  title: { fontWeight: 700 },
  group: { display: "flex", flexDirection: "column", gap: 2 },
  row: { display: "flex", alignItems: "center", gap: 6 },
  tool: { marginLeft: 22, overflowWrap: "anywhere" },
  dim: { color: "#9aa0a6" },
  write: { color: "#fdd663", border: "1px solid #fdd663", borderRadius: 3, padding: "0 4px", fontSize: 11 },
};
