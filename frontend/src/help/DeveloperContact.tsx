/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// Help メニューの「Contact to developer」: 開発者への連絡手段を案内するモーダル。
//   - メール（一般の連絡・相談）
//   - バグ報告 → GitHub Issues
//   - スポンサード開発依頼 → GitHub Sponsors
//
// App に <DeveloperContactHost /> を 1 つだけマウントし、各メニューは
// openDeveloperContact() を呼ぶだけでよい（プロップ配線不要）。

import { useEffect, useState } from "react";
import { useI18n } from "../i18n/i18n";
import { HELP_LINKS, openExternal } from "./links";

let openFn: (() => void) | null = null;

/** Contact to developer ダイアログを開く。 */
export function openDeveloperContact(): void {
  openFn?.();
}

/** App に 1 つだけマウントするホスト。 */
export function DeveloperContactHost() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    openFn = () => setOpen(true);
    return () => {
      openFn = null;
    };
  }, []);
  if (!open) return null;
  return <DeveloperContactDialog onClose={() => setOpen(false)} />;
}

function DeveloperContactDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  return (
    <div style={overlay} onClick={onClose}>
      <div style={dialog} onClick={(e) => e.stopPropagation()} role="dialog" aria-label={t("help.contact.title")}>
        <div style={header}>
          <span style={{ fontWeight: 700 }}>{t("help.contact.title")}</span>
          <button style={closeBtn} onClick={onClose} aria-label={t("common.close")}>
            ✕
          </button>
        </div>
        <div style={{ padding: "14px 18px", overflow: "auto" }}>
          <p style={intro}>{t("help.contact.intro")}</p>

          <section style={section}>
            <div style={label}>{t("help.contact.emailLabel")}</div>
            <div style={desc}>{t("help.contact.emailDesc")}</div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <code style={code}>{HELP_LINKS.contactEmail}</code>
              <button style={primaryBtn} onClick={() => openExternal(`mailto:${HELP_LINKS.contactEmail}`)}>
                {t("help.contact.emailBtn")}
              </button>
            </div>
          </section>

          <section style={section}>
            <div style={label}>{t("help.contact.bugLabel")}</div>
            <div style={desc}>{t("help.contact.bugDesc")}</div>
            <button style={linkBtn} onClick={() => openExternal(HELP_LINKS.githubIssues)}>
              {t("help.contact.bugBtn")} ↗
            </button>
          </section>

          <section style={{ ...section, borderBottom: "none" }}>
            <div style={label}>{t("help.contact.sponsorLabel")}</div>
            <div style={desc}>{t("help.contact.sponsorDesc")}</div>
            <button style={linkBtn} onClick={() => openExternal(HELP_LINKS.sponsors)}>
              {t("help.contact.sponsorBtn")} ↗
            </button>
          </section>
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
  width: 480,
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
const intro: React.CSSProperties = { margin: "0 0 14px", fontSize: 13, color: "#465563", lineHeight: 1.6 };
const section: React.CSSProperties = { padding: "12px 0", borderBottom: "1px solid #f1f3f5" };
const label: React.CSSProperties = { fontWeight: 600, fontSize: 13, marginBottom: 3 };
const desc: React.CSSProperties = { fontSize: 12, color: "#6b7783", marginBottom: 8, lineHeight: 1.5 };
const code: React.CSSProperties = {
  fontFamily: "ui-monospace, monospace",
  fontSize: 13,
  background: "#f6f8fa",
  border: "1px solid #e2e7ec",
  borderRadius: 5,
  padding: "3px 8px",
};
const primaryBtn: React.CSSProperties = {
  border: "1px solid #0b5cad",
  borderRadius: 6,
  background: "#0b5cad",
  color: "#fff",
  cursor: "pointer",
  fontSize: 12,
  padding: "5px 14px",
};
const linkBtn: React.CSSProperties = {
  border: "1px solid #cdd5de",
  borderRadius: 6,
  background: "#fff",
  color: "#0b5cad",
  cursor: "pointer",
  fontSize: 12,
  padding: "5px 14px",
};
