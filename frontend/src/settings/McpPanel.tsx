/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 環境設定 ＞ 外部 AI クライアント（MCP）。外部 AI クライアント（Claude Desktop など）が、起動中のこのアプリを道具として使えるようにする設定。
 * 設定は main の userData/mcp.json（backend に載せない）。**オンにするときの確認は main が描く**ので、この画面は確認を重ねない。
 * 読み書きできるのはメインの窓だけ（main が送信元を確かめる。他の窓では getMcp() が null）。設計: roadmap fw/mcp-server-design.md。
 */
import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { desktop, type McpPrefs, type McpState } from "../desktopBridge";
import { useI18n } from "../i18n/i18n";

type Load = "loading" | "unsupported" | "forbidden" | "ready";

export function McpPanel() {
  const { t } = useI18n();
  const [load, setLoad] = useState<Load>("loading");
  const [state, setState] = useState<McpState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const d = desktop();
    if (!d?.getMcp) return setLoad("unsupported");
    const s = await d.getMcp().catch(() => null);
    if (!s) return setLoad("forbidden");
    setState(s);
    setLoad("ready");
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function toggle(key: keyof McpPrefs, value: boolean) {
    const d = desktop();
    if (!d?.setMcp || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await d.setMcp({ [key]: value });
      if (r.state) setState(r.state);
      // キャンセルは利用者の選択なので、エラーにしない（チェックは state のまま＝元に戻る）
      if (!r.ok && r.error !== "cancelled") setError(r.error === "listen-failed" ? "listenFailed" : "generic");
    } catch {
      setError("generic");
    } finally {
      setBusy(false);
    }
  }

  if (load === "loading") return null;
  if (load !== "ready" || !state) {
    return (
      <p style={notice} data-testid={load === "unsupported" ? "mcp-desktop-only" : "mcp-main-only"}>
        {t(load === "unsupported" ? "settings.mcp.desktopOnly" : "settings.mcp.mainOnly")}
      </p>
    );
  }

  const { prefs } = state;
  const box = (key: keyof McpPrefs, labelKey: string, helpKey?: string) => (
    <div style={{ margin: "10px 0" }}>
      <label style={row}>
        <input type="checkbox" data-testid={`mcp-${key}`} checked={prefs[key]} disabled={busy} onChange={(e) => void toggle(key, e.target.checked)} />
        <span>{t(labelKey)}</span>
      </label>
      {helpKey && <p style={muted}>{t(helpKey)}</p>}
    </div>
  );

  return (
    <div>
      <p style={{ fontSize: 13, color: "#445", margin: "0 0 10px" }}>{t("settings.mcp.intro")}</p>
      {state.readError && (
        <div style={warnBox} data-testid="mcp-read-error">
          {t("settings.mcp.readError")}
        </div>
      )}
      {error && (
        <div style={errBox} data-testid="mcp-error" data-code={error}>
          {t(`settings.mcp.error.${error}`)}
        </div>
      )}

      {box("enabled", "settings.mcp.enabled")}
      <p style={{ ...muted, margin: "0 0 10px 24px" }} data-testid="mcp-status" data-listening={String(state.listening)}>
        {t(state.listening ? "settings.mcp.status.listening" : "settings.mcp.status.off")}
      </p>
      {box("includePhi", "settings.mcp.includePhi", "settings.mcp.includePhiHelp")}
      {box("allowAnalysis", "settings.mcp.allowAnalysis", "settings.mcp.allowAnalysisHelp")}
      {box("allowViewerControl", "settings.mcp.allowViewerControl", "settings.mcp.allowViewerControlHelp")}
      {box("allowViewerEdit", "settings.mcp.allowViewerEdit", "settings.mcp.allowViewerEditHelp")}

      {state.relayCommand && (
        <section>
          <h3 style={h3}>{t("settings.mcp.relayCommand")}</h3>
          <input readOnly style={{ ...input, width: "100%", boxSizing: "border-box" }} value={state.relayCommand} data-testid="mcp-relay-command" onFocus={(e) => e.currentTarget.select()} />
          <p style={muted}>{t("settings.mcp.relayCommandHelp")}</p>
        </section>
      )}

      {/* 🔴 ここは畳まない・隠さない。外部の送信先へ患者情報が渡り得る機能の設定なので、注意書きは設定そのものと同じ高さに置く。 */}
      <section>
        <h3 style={h3}>{t("settings.mcp.sec.privacy")}</h3>
        <ul style={noticeList} data-testid="mcp-privacy-notice">
          <li>{t("settings.mcp.privacy.egress")}</li>
          <li>{t("settings.mcp.privacy.confirm")}</li>
          <li>{t("settings.mcp.privacy.noPixels")}</li>
          <li>{t("settings.mcp.privacy.readOnly")}</li>
          <li>{t("settings.mcp.privacy.audit")}</li>
        </ul>
      </section>
    </div>
  );
}

const notice: CSSProperties = { fontSize: 12, color: "#6b7785" };
const muted: CSSProperties = { color: "#889", fontSize: 12, margin: "4px 0 0 24px" };
const row: CSSProperties = { display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "#223" };
const h3: CSSProperties = { fontSize: 14, margin: "18px 0 8px", color: "#223" };
const input: CSSProperties = { border: "1px solid #c5ccd6", borderRadius: 6, padding: "4px 8px", fontSize: 13 };
const errBox: CSSProperties = { color: "#b00020", background: "#fdecea", border: "1px solid #f3b8b0", borderRadius: 6, padding: "6px 10px", fontSize: 12.5, margin: "0 0 8px" };
const warnBox: CSSProperties = { ...errBox, color: "#8a5a00", background: "#fff6e0", border: "1px solid #f0d9a0" };
const noticeList: CSSProperties = { fontSize: 12, color: "#8a4b00", margin: "6px 0 0", paddingLeft: 18, lineHeight: 1.7 };
