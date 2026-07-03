/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// Help メニューの「Uninstall」: アンインストーラの場所と手順を OS 別に案内するモーダル。
//   - Windows … NSIS アンインストーラ（設定＞アプリ、または Uninstall GRAPHY-Next.exe）
//   - macOS   … アプリを削除 ＋ 同梱スクリプト uninstall-macos.command
//   - Linux   … AppImage を削除 ＋ 同梱スクリプト uninstall-linux.sh
// 保存データ（DICOM/DB/plugins）は既定で保持され、削除は確認のうえ任意（main.js resolveDataDir）。
//
// App に <UninstallGuideHost /> を 1 つだけマウントし、メニューは openUninstallGuide() を呼ぶだけ。

import { useEffect, useState } from "react";
import { useI18n } from "../i18n/i18n";

let openFn: (() => void) | null = null;

/** Uninstall ガイドのダイアログを開く。 */
export function openUninstallGuide(): void {
  openFn?.();
}

/** App に 1 つだけマウントするホスト。 */
export function UninstallGuideHost() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    openFn = () => setOpen(true);
    return () => {
      openFn = null;
    };
  }, []);
  if (!open) return null;
  return <UninstallGuideDialog onClose={() => setOpen(false)} />;
}

type OsId = "win" | "mac" | "linux" | "other";

function detectOs(): OsId {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  if (/Windows/i.test(ua)) return "win";
  if (/Mac OS X|Macintosh/i.test(ua)) return "mac";
  if (/Linux|X11/i.test(ua)) return "linux";
  return "other";
}

function UninstallGuideDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const current = detectOs();

  // 各 OS の「アンインストーラの場所」と「保存データの場所」。パス類は非翻訳（コード表示）。
  const platforms: {
    id: Exclude<OsId, "other">;
    title: string;
    body: string;
    loc: string;
    locPath?: string;
    dataPath: string;
  }[] = [
    {
      id: "win",
      title: "Windows",
      body: t("help.uninstall.win.body"),
      loc: t("help.uninstall.win.loc"),
      locPath: "%LOCALAPPDATA%\\Programs\\GRAPHY-Next\\Uninstall GRAPHY-Next.exe",
      dataPath: "%APPDATA%\\GRAPHY-Next",
    },
    {
      id: "mac",
      title: "macOS",
      body: t("help.uninstall.mac.body"),
      loc: t("help.uninstall.mac.loc"),
      locPath: "GRAPHY-Next.app › Contents/Resources/uninstall/uninstall-macos.command",
      dataPath: "~/Library/Application Support/GRAPHY-Next",
    },
    {
      id: "linux",
      title: "Linux (AppImage)",
      body: t("help.uninstall.linux.body"),
      loc: t("help.uninstall.linux.loc"),
      locPath: "…/resources/uninstall/uninstall-linux.sh",
      dataPath: "~/.config/GRAPHY-Next",
    },
  ];
  // 現在の OS を先頭に並べる。
  platforms.sort((a, b) => (a.id === current ? -1 : b.id === current ? 1 : 0));

  return (
    <div style={overlay} onClick={onClose}>
      <div style={dialog} onClick={(e) => e.stopPropagation()} role="dialog" aria-label={t("help.uninstall.title")}>
        <div style={header}>
          <span style={{ fontWeight: 700 }}>{t("help.uninstall.title")}</span>
          <button style={closeBtn} onClick={onClose} aria-label={t("common.close")}>
            ✕
          </button>
        </div>
        <div style={{ padding: "14px 18px", overflow: "auto" }}>
          <p style={intro}>{t("help.uninstall.intro")}</p>
          <p style={note}>{t("help.uninstall.dataNote")}</p>

          {platforms.map((p, i) => (
            <section key={p.id} style={{ ...section, borderBottom: i === platforms.length - 1 ? "none" : section.borderBottom }}>
              <div style={label}>
                {p.title}
                {p.id === current && <span style={badge}>{t("help.uninstall.yourSystem")}</span>}
              </div>
              <div style={desc}>{p.body}</div>
              <div style={kv}>
                <span style={kvKey}>{t("help.uninstall.locLabel")}</span>
                <span>{p.loc}</span>
              </div>
              {p.locPath && <code style={code}>{p.locPath}</code>}
              <div style={{ ...kv, marginTop: 8 }}>
                <span style={kvKey}>{t("help.uninstall.dataLabel")}</span>
                <code style={code}>{p.dataPath}</code>
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

const overlay: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.35)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1001,
};
const dialog: React.CSSProperties = {
  width: 560,
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
const closeBtn: React.CSSProperties = { border: "none", background: "transparent", fontSize: 16, cursor: "pointer", color: "#666" };
const intro: React.CSSProperties = { margin: "0 0 10px", fontSize: 13, color: "#465563", lineHeight: 1.6 };
const note: React.CSSProperties = {
  margin: "0 0 14px",
  fontSize: 12,
  color: "#7a5b00",
  background: "#fff8e1",
  border: "1px solid #f2e2a8",
  borderRadius: 6,
  padding: "8px 10px",
  lineHeight: 1.55,
};
const section: React.CSSProperties = { padding: "12px 0", borderBottom: "1px solid #f1f3f5" };
const label: React.CSSProperties = { fontWeight: 600, fontSize: 13, marginBottom: 4, display: "flex", alignItems: "center", gap: 8 };
const badge: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: "#0b5cad",
  background: "#e6effa",
  border: "1px solid #bcd6f0",
  borderRadius: 10,
  padding: "1px 8px",
};
const desc: React.CSSProperties = { fontSize: 12, color: "#465563", marginBottom: 8, lineHeight: 1.6 };
const kv: React.CSSProperties = { display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap", fontSize: 12, color: "#465563" };
const kvKey: React.CSSProperties = { fontWeight: 600, color: "#6b7783", minWidth: 96 };
const code: React.CSSProperties = {
  display: "inline-block",
  fontFamily: "ui-monospace, monospace",
  fontSize: 12,
  background: "#f6f8fa",
  border: "1px solid #e2e7ec",
  borderRadius: 5,
  padding: "3px 8px",
  marginTop: 4,
  wordBreak: "break-all",
};
