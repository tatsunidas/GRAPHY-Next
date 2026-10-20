/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// 起動時の利用条件（研究用・非診断）への同意ダイアログと、Help メニューの「利用条件」（読み取り専用）。
//   - 未同意（記録なし／古い版）なら、閉じられないダイアログを出す。背景クリック・Esc では閉じない。
//   - backend がまだ起動していない間は判定できないので、出さずに待つ（「同意済み」とは見なさない）。
//   - 公開デモ機は設定を書けないため、sessionStorage に持つ。
//
// App と 2D ビューア（別ウィンドウ）に <ResearchUseConsentHost /> を 1 つずつマウントする。

import { useEffect, useState } from "react";
import { fetchStatus } from "../api";
import { useI18n } from "../i18n/i18n";
import { fetchSettings, saveSettings } from "../settings/settingsApi";
import {
  CONSENT_KEY,
  consentRecord,
  needsConsent,
  readSessionConsent,
  writeSessionConsent,
} from "./consent";

let openTermsFn: (() => void) | null = null;

/** Help メニューの「利用条件」。同意済みでも文面を読み返せる。 */
export function openResearchUseTerms(): void {
  openTermsFn?.();
}

const RETRY_MS = 3000;

export function ResearchUseConsentHost() {
  const [mode, setMode] = useState<"consent" | "terms" | null>(null);
  const [demo, setDemo] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    openTermsFn = () => setMode((m) => m ?? "terms");
    return () => {
      openTermsFn = null;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = async () => {
      try {
        const status = await fetchStatus();
        const raw = status.demo ? readSessionConsent() : (await fetchSettings())[CONSENT_KEY];
        if (cancelled) return;
        setDemo(!!status.demo);
        if (needsConsent(raw)) setMode((m) => m ?? "consent");
      } catch {
        if (!cancelled) timer = setTimeout(() => void check(), RETRY_MS);
      }
    };
    void check();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  if (!mode) return null;

  const accept = async () => {
    const raw = consentRecord();
    try {
      if (demo) writeSessionConsent(raw);
      else await saveSettings({ [CONSENT_KEY]: raw });
      setFailed(false);
      setMode(null);
    } catch {
      setFailed(true); // 記録できなかったときは閉じない（次回また出るのに通したことになる）
    }
  };
  return <ConsentDialog mode={mode} failed={failed} onAccept={accept} onClose={() => setMode(null)} />;
}

function ConsentDialog({
  mode,
  failed,
  onAccept,
  onClose,
}: {
  mode: "consent" | "terms";
  failed: boolean;
  onAccept: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [declined, setDeclined] = useState(false);
  const readOnly = mode === "terms";
  const points = ["consent.point1", "consent.point2", "consent.point3", "consent.point4"] as const;

  const decline = () => {
    // デスクトップ版ではウィンドウを閉じる。ブラウザが閉じさせないときは、同意が要る旨を出して待つ。
    setDeclined(true);
    window.close();
  };

  return (
    <div style={overlay} onKeyDown={(e) => e.stopPropagation()}>
      <div style={dialog} role="dialog" aria-modal="true" aria-label={t("consent.title")} data-testid="research-use-consent">
        <div style={header}>
          <span style={{ fontWeight: 700 }}>{t("consent.title")}</span>
          {readOnly && (
            <button style={closeBtn} onClick={onClose} aria-label={t("common.close")}>
              ✕
            </button>
          )}
        </div>
        <div style={{ padding: "14px 18px", overflow: "auto" }}>
          <p style={{ margin: "0 0 8px", fontSize: 14 }}>{t("consent.intro")}</p>
          <ul style={{ margin: 0, paddingLeft: 20, fontSize: 14, lineHeight: 1.7 }}>
            {points.map((k) => (
              <li key={k}>{t(k)}</li>
            ))}
          </ul>
          {!readOnly && <p style={{ margin: "10px 0 0", fontSize: 12, color: "#6b7785" }}>{t("consent.hint")}</p>}
          {failed && <p style={{ margin: "10px 0 0", fontSize: 13, color: "#b00020" }}>{t("consent.saveFailed")}</p>}
          {declined && <p style={{ margin: "10px 0 0", fontSize: 13, color: "#b00020" }}>{t("consent.declined")}</p>}
        </div>
        <div style={footer}>
          <div style={{ flex: 1 }} />
          {readOnly ? (
            <button style={primaryBtn} onClick={onClose}>
              {t("common.close")}
            </button>
          ) : (
            <>
              <button style={ghostBtn} onClick={decline}>
                {t("consent.decline")}
              </button>
              <button style={primaryBtn} onClick={onAccept} data-testid="research-use-consent-accept">
                {t("consent.accept")}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

const overlay: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.45)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 2000,
};
const dialog: React.CSSProperties = {
  width: 520,
  maxWidth: "92vw",
  maxHeight: "84vh",
  background: "#fff",
  borderRadius: 10,
  boxShadow: "0 12px 40px rgba(0,0,0,0.3)",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
  fontFamily: "system-ui, sans-serif",
  color: "#1a1a1a",
};
const header: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "12px 16px",
  borderBottom: "1px solid #eee",
};
const footer: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "12px 16px",
  borderTop: "1px solid #eee",
};
const closeBtn: React.CSSProperties = { border: "none", background: "transparent", fontSize: 16, cursor: "pointer", color: "#666" };
const ghostBtn: React.CSSProperties = { padding: "6px 14px", border: "1px solid #c9d1d9", borderRadius: 6, background: "#fff", cursor: "pointer" };
const primaryBtn: React.CSSProperties = { padding: "6px 14px", border: "1px solid #0b5cad", borderRadius: 6, background: "#0b5cad", color: "#fff", cursor: "pointer" };
