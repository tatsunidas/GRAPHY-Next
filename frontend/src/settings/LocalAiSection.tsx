/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 環境設定 ＞ 外部 AI ＞ ローカル AI（この PC の軽量 LLM の導入）。設計: `fw/ai-routing-design.md` §18
 *
 * 🔴 ダウンロードと削除は main が確認ダイアログを出す。ここは操作の入口と状態の表示だけ。
 * 🔴 取得先 URL は画面から渡さない（モデルの id だけ渡す）。
 */
import React, { useCallback, useEffect, useState } from "react";
import { useI18n } from "../i18n/i18n";
import { desktop, type AiLocalStatus } from "../desktopBridge";
import { errorKey, formatBytes, percentOf, phaseOf, reduceProgress, type LocalAiProgress } from "./localAiView";

export function LocalAiSection({ onChanged }: { onChanged?: () => void }) {
  const { t } = useI18n();
  const d = desktop();
  const [status, setStatus] = useState<AiLocalStatus | null>(null);
  const [progress, setProgress] = useState<LocalAiProgress | null>(null);
  const [modelId, setModelId] = useState<string>("");
  const [sttModelId, setSttModelId] = useState<string>("");
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [working, setWorking] = useState(false);

  const refresh = useCallback(async () => {
    if (!d?.aiLocalStatus) return;
    const s = await d.aiLocalStatus();
    setStatus(s);
    setModelId((cur) => cur || s.defaultModelId || s.models?.[0]?.id || "");
    setSttModelId((cur) => cur || s.stt?.defaultModelId || s.stt?.models?.[0]?.id || "");
    onChanged?.();
  }, [d, onChanged]);

  useEffect(() => {
    void refresh();
    if (!d?.onAiLocalEvent) return undefined;
    return d.onAiLocalEvent((ev) => {
      setProgress((p) => reduceProgress(p, ev));
      if (ev.type !== "progress" || ev.phase === "done") void refresh();
    });
  }, [d, refresh]);

  if (!d?.aiLocalStatus) return null;

  const show = (r: { ok: boolean; error?: string }, okText: string) => {
    if (r.ok) setMsg({ kind: "ok", text: okText });
    else if (r.error === "canceled") setMsg(null);
    else setMsg({ kind: "err", text: `${t(errorKey(r.error ?? ""))} (${r.error ?? "?"})` });
  };
  const run = async (fn: () => Promise<{ ok: boolean; error?: string }>, okText: string) => {
    setWorking(true);
    setMsg(null);
    try {
      show(await fn(), okText);
    } catch (e) {
      setMsg({ kind: "err", text: String(e) });
    } finally {
      setProgress(null);
      setWorking(false);
      await refresh();
    }
  };

  const phase = phaseOf(status, progress);
  const pct = percentOf(progress);
  const selected = status?.models?.find((m) => m.id === modelId);
  const stt = status?.stt;
  const sttSelected = stt?.models?.find((m) => m.id === sttModelId);

  return (
    <section style={{ marginBottom: 22 }} data-testid="ai-local">
      <h3 style={title}>{t("settings.ai.local.title")}</h3>
      <p style={help}>{t("settings.ai.local.help")}</p>

      {phase === "unsupported" ? <p style={warn} data-testid="ai-local-unsupported">{t("settings.ai.local.unsupported")}</p> : null}

      {phase === "notInstalled" && status?.models ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <label style={{ fontSize: 12 }}>
            {t("settings.ai.local.model")}{" "}
            <select value={modelId} onChange={(e) => setModelId(e.target.value)} data-testid="ai-local-model" style={{ fontSize: 12 }}>
              {status.models.map((m) => (
                <option key={m.id} value={m.id}>{`${m.label} — ${formatBytes(m.size)} — ${m.license}`}</option>
              ))}
            </select>
          </label>
          {selected?.note ? <span style={help}>{selected.note}</span> : null}
          <span style={help}>{t("settings.ai.local.sizeNote", { runtime: formatBytes(status.runtime?.size ?? 0), model: formatBytes(selected?.size ?? 0) })}</span>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button style={btnPrimary} disabled={working || !modelId} onClick={() => void run(() => d.aiLocalInstall!(modelId), t("settings.ai.local.installed"))} data-testid="ai-local-install">
              {t("settings.ai.local.install")}
            </button>
            <button style={btn} disabled={working} onClick={() => void run(() => d.aiLocalImport!(false), t("settings.ai.local.imported"))} data-testid="ai-local-import">
              {t("settings.ai.local.import")}
            </button>
          </div>
          <span style={help}>{t("settings.ai.local.importHelp")}</span>
        </div>
      ) : null}

      {phase === "installing" ? (
        <div data-testid="ai-local-progress" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={{ fontSize: 12 }}>
            {t(`settings.ai.local.phase.${progress?.phase ?? "runtime-download"}`)}
            {pct != null ? ` ${pct}%` : ""}
          </span>
          <progress value={pct ?? undefined} max={100} style={{ width: 260 }} />
          <div>
            <button style={btn} onClick={() => void d.aiLocalCancel?.()} data-testid="ai-local-cancel">{t("settings.ai.local.cancel")}</button>
          </div>
        </div>
      ) : null}

      {phase === "ready" || phase === "running" ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }} data-testid="ai-local-ready">
          <span style={{ fontSize: 12 }}>
            {t("settings.ai.local.state", { model: status?.model?.id ?? "?", running: phase === "running" ? t("settings.ai.local.running") : t("settings.ai.local.stopped") })}
          </span>
          {status?.model && !status.model.verified ? <span style={warn} data-testid="ai-local-unverified">{t("settings.ai.local.unverified")}</span> : null}
          <label style={{ fontSize: 12 }}>
            <input type="checkbox" checked={!!status?.isFallback} disabled={working}
              onChange={(e) => void run(() => d.aiLocalRole!({ fallback: e.target.checked }), t("settings.ai.local.saved"))} data-testid="ai-local-fallback" />{" "}
            {t("settings.ai.local.fallback")}
          </label>
          <label style={{ fontSize: 12 }}>
            <input type="checkbox" checked={!!status?.isDefault} disabled={working}
              onChange={(e) => void run(() => d.aiLocalRole!({ makeDefault: e.target.checked }), t("settings.ai.local.saved"))} data-testid="ai-local-default" />{" "}
            {t("settings.ai.local.makeDefault")}
          </label>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button style={btn} disabled={working} data-testid="ai-local-check"
              onClick={() => void run(async () => {
                const r = await d.aiLocalCheck!();
                return r.ok ? { ok: true } : { ok: false, error: r.error };
              }, t("settings.ai.local.checkOk"))}>
              {t("settings.ai.local.check")}
            </button>
            <button style={btn} disabled={working} onClick={() => void run(() => d.aiLocalRemove!(), t("settings.ai.local.removed"))} data-testid="ai-local-remove">
              {t("settings.ai.local.remove")}
            </button>
          </div>
        </div>
      ) : null}

      {stt && stt.models.length > 0 && phase !== "unsupported" && phase !== "installing" ? (
        <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 6 }} data-testid="ai-local-stt">
          <h4 style={{ fontSize: 12, margin: 0 }}>{t("settings.ai.local.stt.title")}</h4>
          <span style={help}>{t("settings.ai.local.stt.help")}</span>
          {!stt.installed ? (
            <>
              <label style={{ fontSize: 12 }}>
                {t("settings.ai.local.stt.model")}{" "}
                <select value={sttModelId} onChange={(e) => setSttModelId(e.target.value)} data-testid="ai-local-stt-model" style={{ fontSize: 12 }}>
                  {stt.models.map((m) => (
                    <option key={m.id} value={m.id}>{`${m.label} — ${formatBytes(m.size)} — ${m.license}`}</option>
                  ))}
                </select>
              </label>
              {sttSelected?.note ? <span style={help}>{sttSelected.note}</span> : null}
              <span style={help}>{t("settings.ai.local.stt.sizeNote", { model: formatBytes(sttSelected?.size ?? 0), runtime: formatBytes(status?.runtime?.installed ? 0 : (status?.runtime?.size ?? 0)) })}</span>
              <div>
                <button style={btnPrimary} disabled={working || !sttModelId} onClick={() => void run(() => d.aiLocalInstall!(sttModelId), t("settings.ai.local.installed"))} data-testid="ai-local-stt-install">
                  {t("settings.ai.local.stt.install")}
                </button>
              </div>
            </>
          ) : (
            <>
              <span style={{ fontSize: 12 }} data-testid="ai-local-stt-state">
                {t("settings.ai.local.stt.state", { model: stt.id ?? "?", running: stt.running ? t("settings.ai.local.running") : t("settings.ai.local.stopped") })}
              </span>
              <span style={help}>{stt.isDefault ? t("settings.ai.local.stt.isDefault") : t("settings.ai.local.stt.notDefault")}</span>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button style={btn} disabled={working} data-testid="ai-local-stt-check"
                  onClick={() => void run(async () => {
                    const r = await d.aiLocalCheck!("stt");
                    return r.ok ? { ok: true } : { ok: false, error: r.error };
                  }, t("settings.ai.local.checkOk"))}>
                  {t("settings.ai.local.check")}
                </button>
                <button style={btn} disabled={working} onClick={() => void run(() => d.aiLocalRemoveStt!(), t("settings.ai.local.removed"))} data-testid="ai-local-stt-remove">
                  {t("settings.ai.local.stt.remove")}
                </button>
              </div>
            </>
          )}
        </div>
      ) : null}

      {phase === "notInstalled" || phase === "ready" || phase === "running" ? (
        <details style={{ marginTop: 8 }}>
          <summary style={{ fontSize: 12, cursor: "pointer" }}>{t("settings.ai.local.advanced")}</summary>
          <p style={help}>{t("settings.ai.local.advancedHelp")}</p>
          <button style={btn} disabled={working} onClick={() => void run(() => d.aiLocalImport!(true), t("settings.ai.local.imported"))} data-testid="ai-local-import-unverified">
            {t("settings.ai.local.importUnverified")}
          </button>
        </details>
      ) : null}

      {msg ? (
        <p style={{ fontSize: 12, color: msg.kind === "ok" ? "#2e7d32" : "#b00020" }} data-testid={msg.kind === "ok" ? "ai-local-message" : "ai-local-error"}>{msg.text}</p>
      ) : null}
    </section>
  );
}

const title: React.CSSProperties = { fontSize: 13, margin: "0 0 6px" };
const help: React.CSSProperties = { fontSize: 11, color: "#6b7785", margin: "2px 0" };
const warn: React.CSSProperties = { fontSize: 12, color: "#8a4b00", margin: "4px 0" };
const btn: React.CSSProperties = { padding: "3px 10px", border: "1px solid #cdd5de", borderRadius: 4, background: "#fff", fontSize: 12, cursor: "pointer" };
const btnPrimary: React.CSSProperties = { ...btn, background: "#0b5cad", color: "#fff", borderColor: "#0b5cad" };
