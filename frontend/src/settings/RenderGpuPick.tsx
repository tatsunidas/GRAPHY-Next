/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// Settings＞描画環境「描画に使う GPU」。ハイブリッド GPU の機械（内蔵＋高性能）だけに出る。反映は再起動。
// 判断は renderGpuPickView.ts の純関数。ここは表示と保存だけ（設計: fw/render-environment-design.md）。
import { useEffect, useState } from "react";
import { desktop, type RenderGpuChoice, type RenderPrefsState } from "../desktopBridge";
import { useI18n } from "../i18n/i18n";
import { highLabelKey, needsRestart, showsUnverifiedNote, visible } from "./renderGpuPickView";

export function RenderGpuPick() {
  const { t } = useI18n();
  const [state, setState] = useState<RenderPrefsState | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let alive = true;
    void desktop()
      ?.getRenderPrefs?.()
      .then((s) => {
        if (alive) setState(s);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  if (!visible(state)) return null;

  const choose = async (gpu: RenderGpuChoice) => {
    setError(false);
    const r = await desktop()?.setRenderPrefs?.({ gpu });
    if (r?.ok) setState({ ...state, prefs: { gpu } });
    else setError(true);
  };

  const pending = needsRestart(state.prefs.gpu, state.appliedHigh);
  const options: { value: RenderGpuChoice; label: string }[] = [
    { value: "auto", label: t("renderenv.gpuPick.auto") },
    { value: "high", label: t(highLabelKey(state.platform)) },
  ];

  return (
    <div data-testid="renderenv-gpupick" data-selected={state.prefs.gpu} data-pending={String(pending)}>
      <h4 style={head}>{t("renderenv.gpuPick.title")}</h4>
      <p style={note}>{t("renderenv.gpuPick.intro")}</p>
      {options.map((o) => (
        <label key={o.value} style={{ display: "block", fontSize: 13, margin: "3px 0" }}>
          <input
            type="radio"
            name="renderenv-gpupick"
            checked={state.prefs.gpu === o.value}
            onChange={() => void choose(o.value)}
            data-testid={`renderenv-gpupick-${o.value}`}
          />{" "}
          {o.label}
        </label>
      ))}
      {showsUnverifiedNote(state.platform) && <p style={muted}>{t("renderenv.gpuPick.unverified")}</p>}
      {error && (
        <p style={{ ...muted, color: "#b00020" }} data-testid="renderenv-gpupick-error">
          {t("renderenv.gpuPick.saveFailed")}
        </p>
      )}
      {pending && (
        <p style={{ ...muted, color: "#8a5a00" }} data-testid="renderenv-gpupick-pending">
          {t("renderenv.gpuPick.pending")}{" "}
          <button style={btn} onClick={() => void desktop()?.relaunch?.()} data-testid="renderenv-gpupick-restart">
            {t("renderenv.gpuPick.restart")}
          </button>
        </p>
      )}
    </div>
  );
}

const head: React.CSSProperties = { margin: "22px 0 4px", fontSize: 14 };
const note: React.CSSProperties = { color: "#445", fontSize: 13, margin: "0 0 6px" };
const muted: React.CSSProperties = { color: "#889", fontSize: 12, margin: "4px 0" };
const btn: React.CSSProperties = { background: "#0b5cad", color: "#fff", border: "none", borderRadius: 6, padding: "3px 10px", cursor: "pointer", fontSize: 12 };
