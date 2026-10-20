/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 環境設定 ＞ 計算機 ＞ 「この PC」。この PC の Python と GPU を**見て出すだけ**（計算はまだ自機に向かない）。
 *
 * - 判定は main の `localPython.js` にあり、表示の組み立ては `localComputeView.ts`。ここは描画だけ。
 * - 本体は pip・conda を実行しない。足りないものは名前とコピー用のコマンドで案内する。
 * - Python の指定は main のファイル選択と確認を通る（このコンポーネントはパスの文字列を渡せない）。
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { useI18n, type TFn } from "../i18n/i18n";
import { desktop, type ComputeEndpointsConfig, type LocalDetectResult } from "../desktopBridge";
import { buildLocalView, type Msg, type Tone } from "./localComputeView";

const tr = (t: TFn, m: Msg) => t(m.key, m.params);

const TONE: Record<Tone, string> = { ok: "#1b7a3a", warn: "#8a4b00", error: "#b00020", off: "#6b7785" };

export function LocalComputeSection({ config }: { config: ComputeEndpointsConfig | null }) {
  const { t } = useI18n();
  const d = desktop();
  const [result, setResult] = useState<LocalDetectResult | null>(null);
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const startedAt = useRef(0);
  const [setting, setSetting] = useState<ComputeEndpointsConfig["local"]>(undefined);

  // 設定（自動／指定）は endpoints-get が返す。検出の結果（python.mode）が来ればそちらを優先
  useEffect(() => {
    if (config?.local) setSetting(config.local);
  }, [config]);

  const detect = useCallback(
    async (force: boolean) => {
      if (!d?.computeLocalDetect) return;
      setRunning(true);
      setError(null);
      startedAt.current = Date.now();
      setElapsed(0);
      try {
        setResult(await d.computeLocalDetect({ force }));
      } catch (e) {
        setError(String(e));
      } finally {
        setRunning(false);
      }
    },
    [d],
  );

  // 開いたら（覚えている結果があればそれを、無ければ）確認する
  useEffect(() => {
    void detect(false);
  }, [detect]);

  // 経過秒は renderer が開始時刻から数える（main から逐次通知しない）
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => setElapsed(Math.floor((Date.now() - startedAt.current) / 1000)), 500);
    return () => window.clearInterval(id);
  }, [running]);

  if (!d?.computeLocalDetect) return null;

  const mode = result?.python.mode ?? setting?.python.mode ?? "auto";
  const pickedPath = result?.python.path ?? setting?.python.path;

  const afterChange = async () => {
    if (d.computeEndpointsGet) setSetting((await d.computeEndpointsGet()).local);
    await detect(true);
  };
  const pick = async () => {
    setError(null);
    const r = await d.computeLocalPickPython!();
    if (r.ok) await afterChange();
    else if (!r.canceled) setError(t(`settings.compute.local.err.${r.error ?? "unknown"}`));
  };
  const useAuto = async () => {
    setError(null);
    const r = await d.computeLocalUseAuto!();
    if (r.ok) await afterChange();
    else if (!r.canceled) setError(t(`settings.compute.local.err.${r.error ?? "unknown"}`));
  };
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(text);
    } catch {
      setCopied(null);
    }
  };

  const view = result && result.state !== "canceled" ? buildLocalView(result) : null;

  return (
    <section style={{ marginBottom: 22 }} data-testid="compute-local">
      <h3 style={sectionTitle}>{t("settings.compute.local.title")}</h3>
      <p style={notice} data-testid="compute-local-preparing">{t("settings.compute.local.preparing")}</p>

      <div style={row}>
        <span style={label}>Python</span>
        <label style={{ fontSize: 12 }}>
          <input type="radio" checked={mode === "auto"} disabled={running || mode === "auto"} onChange={() => void useAuto()} data-testid="compute-local-auto" />{" "}
          {t("settings.compute.local.mode.auto")}
        </label>
        <label style={{ fontSize: 12 }}>
          <input type="radio" checked={mode === "path"} readOnly disabled={running} onChange={() => void pick()} data-testid="compute-local-mode-path" />{" "}
          {t("settings.compute.local.mode.path")}
        </label>
        <button style={smallBtn} disabled={running} onClick={() => void pick()} data-testid="compute-local-pick">
          {t("settings.compute.local.pick")}
        </button>
        {running ? (
          <>
            <span style={{ fontSize: 12, color: TONE.off }} data-testid="compute-local-running">
              {t("settings.compute.local.running", { sec: String(elapsed) })}
            </span>
            <button style={smallBtn} onClick={() => void d.computeLocalCancel?.()} data-testid="compute-local-cancel">
              {t("settings.compute.local.cancel")}
            </button>
          </>
        ) : (
          <button style={smallBtn} onClick={() => void detect(true)} data-testid="compute-local-detect">
            {t("settings.compute.local.redetect")}
          </button>
        )}
      </div>
      {mode === "path" && pickedPath ? <div style={{ ...mono, margin: "0 0 6px 118px" }}>{pickedPath}</div> : null}
      {error ? <p style={{ fontSize: 12, color: "#b00020" }}>{error}</p> : null}

      {result && result.state === "canceled" ? (
        <p style={notice} data-testid="compute-local-canceled">{t("settings.compute.local.headline.canceled")}</p>
      ) : null}

      {view ? (
        <div style={box}>
          <div style={{ fontSize: 12, color: TONE[view.headline.tone], fontWeight: 600 }} data-testid="compute-local-headline">
            {tr(t, view.headline)}
          </div>

          {view.python ? (
            <div style={{ margin: "6px 0" }} data-testid="compute-local-python">
              <span style={label}>{t("settings.compute.local.inUse")}</span>
              <span style={mono}>{view.python.path}</span>
              {view.python.kind ? <span style={{ fontSize: 11, color: TONE.off }}> ({tr(t, view.python.kind)})</span> : null}
              <div style={{ ...mono, marginLeft: 118 }}>{view.python.versions}</div>
            </div>
          ) : null}

          <div style={{ margin: "6px 0" }} data-testid="compute-local-gpu">
            <span style={label}>GPU</span>
            {view.gpus.map((g, i) => (
              <div key={i} style={{ marginLeft: 118, fontSize: 12 }} data-testid={`compute-local-gpu-${i}`}>
                <b>{g.name}</b>
                {g.vram ? <span> {g.vram}</span> : null}
                <span style={{ color: TONE[g.tone] }}> — {tr(t, g.verdict)}</span>
              </div>
            ))}
            {view.gpuNote ? <div style={{ marginLeft: 118, fontSize: 12, color: TONE.off }}>{tr(t, view.gpuNote)}</div> : null}
          </div>

          {view.notes.length > 0 ? (
            <ul style={noticeList} data-testid="compute-local-notes">
              {view.notes.map((m, i) => (
                <li key={i}>{tr(t, m)}</li>
              ))}
            </ul>
          ) : null}

          {view.missing.length > 0 || view.commands.length > 0 || view.links.length > 0 ? (
            <div style={{ margin: "6px 0" }} data-testid="compute-local-missing">
              {view.missing.length > 0 ? (
                <div style={{ fontSize: 12, color: TONE.warn }}>
                  {t("settings.compute.local.missing", { names: view.missing.join(", ") })}
                </div>
              ) : null}
              {view.commands.length > 0 ? <div style={{ fontSize: 11, color: TONE.off }}>{t("settings.compute.local.commandsHelp")}</div> : null}
              {view.commands.map((c, i) => (
                <div key={i} style={{ display: "flex", gap: 6, alignItems: "center", margin: "3px 0" }}>
                  <span style={{ fontSize: 10, color: TONE.off, width: 70 }}>{c.shell}</span>
                  <code style={{ ...mono, flex: 1, userSelect: "all" }} data-testid="compute-local-command">{c.text}</code>
                  <button style={smallBtn} onClick={() => void copy(c.text)}>
                    {copied === c.text ? t("settings.compute.local.copied") : t("settings.compute.local.copy")}
                  </button>
                </div>
              ))}
              {view.links.map((u) => (
                <div key={u}>
                  <button style={linkBtn} onClick={() => d.openExternal?.(u)} data-testid="compute-local-link">
                    {t("settings.compute.local.pytorchLink")}
                  </button>
                </div>
              ))}
              <div style={{ fontSize: 11, color: TONE.off }}>{t("settings.compute.local.noInstall")}</div>
              <div style={{ fontSize: 11, color: TONE.off }}>{t("settings.compute.local.redetectHint")}</div>
            </div>
          ) : null}

          <details style={{ marginTop: 6 }}>
            <summary style={{ fontSize: 12, cursor: "pointer" }} data-testid="compute-local-candidates-summary">
              {t("settings.compute.local.candidates", { n: String(view.candidates.length) })}
            </summary>
            {view.candidates.length === 0 ? (
              <div style={{ fontSize: 12, color: TONE.off }}>{t("settings.compute.local.noCandidates")}</div>
            ) : null}
            {view.candidates.map((c, i) => (
              <div key={i} style={{ margin: "4px 0" }} data-testid={`compute-local-candidate-${i}`}>
                <span style={mono}>{c.path}</span>
                <span style={{ fontSize: 11, color: TONE[c.tone] }}> — {tr(t, c.status)}</span>
                <span style={{ fontSize: 10, color: TONE.off }}> [{tr(t, c.source)}]</span>
                {c.versions ? <div style={{ ...mono, marginLeft: 12 }}>{c.versions}</div> : null}
                {c.reasons.map((m, j) => (
                  <div key={j} style={{ fontSize: 11, color: TONE.off, marginLeft: 12 }}>{tr(t, m)}</div>
                ))}
              </div>
            ))}
            {result && result.state === "none" ? (
              <>
                <div style={{ fontSize: 12, marginTop: 4 }}>{t("settings.compute.local.searched")}</div>
                <ul style={{ ...mono, margin: "2px 0", paddingLeft: 18 }} data-testid="compute-local-searched">
                  {view.searched.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ul>
              </>
            ) : null}
          </details>
          <div style={{ fontSize: 10, color: TONE.off, marginTop: 4 }}>
            {t("settings.compute.local.elapsed", { ms: String(result?.elapsedMs ?? 0) })}
          </div>
        </div>
      ) : null}
    </section>
  );
}

const sectionTitle: React.CSSProperties = { fontSize: 13, margin: "0 0 8px", color: "#334" };
const notice: React.CSSProperties = { fontSize: 12, color: "#6b7785" };
const noticeList: React.CSSProperties = { fontSize: 12, color: "#8a4b00", margin: "6px 0", paddingLeft: 18 };
const row: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, margin: "6px 0", flexWrap: "wrap" };
const label: React.CSSProperties = { display: "inline-block", width: 110, fontSize: 12, color: "#42505f" };
const mono: React.CSSProperties = { fontFamily: "monospace", fontSize: 11, color: "#42505f", wordBreak: "break-all" };
const box: React.CSSProperties = { border: "1px solid #dfe6ee", borderRadius: 4, padding: "8px 10px", marginBottom: 10 };
const smallBtn: React.CSSProperties = { padding: "1px 8px", border: "1px solid #cdd5de", borderRadius: 3, background: "#fff", fontSize: 11, cursor: "pointer" };
const linkBtn: React.CSSProperties = { border: "none", background: "none", color: "#0b5cad", fontSize: 12, cursor: "pointer", padding: 0, textDecoration: "underline" };
