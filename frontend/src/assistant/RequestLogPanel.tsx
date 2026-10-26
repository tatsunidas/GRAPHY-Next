/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// 「要求の記録」パネル（アシスタント窓）。AI への要求ごとの本文なしの記録（モデル・版・トークン数・ツール名）を見て、消す。
// 読み取りと消去は main の IPC だけ（記録ファイルを直接読まない）。消去は利用者が押したときだけで、画面内の 2 段階（ダイアログは使わない）。
import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { modelRows, recentRows, shortText, tokenText, totalIsPartial, type RequestLogSummary } from "./requestLogView";

type T = (k: string, v?: Record<string, string | number>) => string;

export interface RequestLogApi {
  summary: () => Promise<({ ok: boolean; error?: string } & RequestLogSummary) | undefined>;
  clear: () => Promise<{ ok: boolean; error?: string } | undefined>;
}

export function RequestLogPanel({ api, busy, t }: { api: RequestLogApi; busy: boolean; t: T }) {
  const [data, setData] = useState<RequestLogSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const load = useCallback(async () => {
    const r = await api.summary();
    if (r?.ok) {
      setData(r);
      setError(null);
    } else {
      setData(null);
      setError(shortText(r?.error, 40) || "unavailable");
    }
  }, [api]);
  useEffect(() => {
    void load();
  }, [load]);

  const clear = async () => {
    setConfirming(false);
    const r = await api.clear();
    if (!r?.ok) setError(shortText(r?.error, 40) || "unavailable");
    await load();
  };

  const models = modelRows(data?.byModel);
  const recent = recentRows(data?.recent);
  const unknown = t("assistant.requestlog.unknown");
  const count = typeof data?.count === "number" ? data.count : 0;
  return (
    <div style={S.panel} data-testid="assistant-requestlog-panel">
      <div style={S.title}>{t("assistant.requestlog.title")}</div>
      <div style={S.dim}>{t("assistant.requestlog.note")}</div>
      {error ? (
        <div style={S.err} data-testid="assistant-requestlog-error">{t("assistant.requestlog.error", { code: error })}</div>
      ) : (
        <>
          <div data-testid="assistant-requestlog-count">{t("assistant.requestlog.count", { n: count })}</div>
          {models.length > 0 && (
            <table style={S.table} data-testid="assistant-requestlog-models">
              <thead>
                <tr>
                  <th style={S.th}>{t("assistant.requestlog.model")}</th>
                  <th style={S.thNum}>{t("assistant.requestlog.requests")}</th>
                  <th style={S.thNum}>{t("assistant.requestlog.tokensIn")}</th>
                  <th style={S.thNum}>{t("assistant.requestlog.tokensOut")}</th>
                  <th style={S.thNum}>{t("assistant.requestlog.unknownUsage")}</th>
                </tr>
              </thead>
              <tbody>
                {models.map((m, i) => (
                  <tr key={`${m.provider}/${m.model}/${i}`} data-testid="assistant-requestlog-model-row">
                    <td style={S.td}>{m.model ?? unknown}<span style={S.dim}> · {m.provider ?? unknown}</span></td>
                    <td style={S.tdNum}>{m.requests}</td>
                    <td style={S.tdNum}>{m.requests === m.unknownUsage ? unknown : m.tokensIn}</td>
                    <td style={S.tdNum}>{m.requests === m.unknownUsage ? unknown : m.tokensOut}</td>
                    <td style={S.tdNum}>{m.unknownUsage}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {totalIsPartial(models) && <div style={S.dim} data-testid="assistant-requestlog-partial">{t("assistant.requestlog.partial")}</div>}
          {recent.length > 0 && (
            <div style={S.recent} data-testid="assistant-requestlog-recent">
              <div style={S.title}>{t("assistant.requestlog.recent")}</div>
              {recent.map((r) => (
                <div key={r.key} style={S.recentRow} data-testid="assistant-requestlog-recent-row">
                  <span style={S.dim}>{r.ts.replace("T", " ").slice(0, 19)}</span> {r.model}{" "}
                  <span style={S.dim}>
                    {t(r.destination === "local" ? "assistant.requestlog.local" : "assistant.requestlog.external")} · {r.outcome} ·{" "}
                    {t("assistant.requestlog.tokens", { in: tokenText(r.tokensIn, unknown), out: tokenText(r.tokensOut, unknown) })}
                    {r.latencyMs !== null ? ` · ${r.latencyMs} ms` : ""}
                    {r.tools.length > 0 ? ` · ${r.tools.join(", ")}` : ""}
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
      <div style={S.row}>
        <button style={S.btn} disabled={busy} onClick={() => void load()} data-testid="assistant-requestlog-refresh">{t("assistant.requestlog.refresh")}</button>
        {!confirming ? (
          <button style={S.btn} disabled={busy || count === 0} onClick={() => setConfirming(true)} data-testid="assistant-requestlog-clear">{t("assistant.requestlog.clear")}</button>
        ) : (
          <>
            <span>{t("assistant.requestlog.clearAsk")}</span>
            <button style={S.btnDanger} onClick={() => void clear()} data-testid="assistant-requestlog-clear-yes">{t("assistant.requestlog.clearYes")}</button>
            <button style={S.btn} onClick={() => setConfirming(false)} data-testid="assistant-requestlog-clear-no">{t("assistant.requestlog.clearNo")}</button>
          </>
        )}
      </div>
    </div>
  );
}

const S: Record<string, CSSProperties> = {
  panel: { padding: "8px 12px", borderTop: "1px solid #3a3b3f", fontSize: 12, display: "flex", flexDirection: "column", gap: 6, maxHeight: 260, overflowY: "auto" },
  title: { fontWeight: 700 },
  dim: { color: "#9aa0a6" },
  err: { color: "#f28b82" },
  table: { borderCollapse: "collapse", width: "100%" },
  th: { textAlign: "left", fontWeight: 600, borderBottom: "1px solid #3a3b3f", padding: "2px 4px" },
  thNum: { textAlign: "right", fontWeight: 600, borderBottom: "1px solid #3a3b3f", padding: "2px 4px" },
  td: { padding: "2px 4px", overflowWrap: "anywhere" },
  tdNum: { padding: "2px 4px", textAlign: "right" },
  recent: { display: "flex", flexDirection: "column", gap: 2 },
  recentRow: { overflowWrap: "anywhere" },
  row: { display: "flex", alignItems: "center", gap: 8 },
  btn: { fontSize: 12, padding: "2px 8px", cursor: "pointer" },
  btnDanger: { fontSize: 12, padding: "2px 8px", cursor: "pointer", color: "#f28b82" },
};
