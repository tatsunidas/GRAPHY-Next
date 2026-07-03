/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// Help メニューの「更新を確認」／起動時チェックの UI（レベル0: 通知のみ）。
//   - 新版あり → 現在→最新・リリースノート・「ダウンロードページを開く」を表示。
//     入れ替え自体は既存インストーラの上書きで行う（アプリ内自動更新はしない）。
//   - 手動確認では「最新版です」「確認できません」も表示。自動（起動時）は新版時のみ表示。
//
// App に <UpdateNoticeHost /> を 1 つだけマウントし、runUpdateCheck() を呼ぶだけでよい。

import { useEffect, useState } from "react";
import { useI18n } from "../i18n/i18n";
import { fetchStatus } from "../api";
import { openExternal } from "./links";
import { checkForUpdate, isSkipped, skipVersion, type UpdateResult } from "./update";

let showFn: ((r: UpdateResult, manual: boolean) => void) | null = null;

/**
 * 更新を確認し、必要なら通知ダイアログを開く。
 * @param manual 手動（Help メニュー）なら true。true のときは「最新/失敗」も表示し、スキップ設定は無視する。
 */
export async function runUpdateCheck(manual: boolean): Promise<void> {
  let current = "";
  try {
    current = (await fetchStatus()).version;
  } catch {
    if (manual) showFn?.({ kind: "error" }, true);
    return;
  }
  const r = await checkForUpdate(current);
  if (r.kind === "update") {
    if (!manual && isSkipped(r.latest)) return; // 自動時はスキップ済みを尊重
    showFn?.(r, manual);
  } else if (manual) {
    showFn?.(r, manual); // 最新/失敗/不可は手動確認のときだけ知らせる
  }
}

/** App に 1 つだけマウントするホスト。 */
export function UpdateNoticeHost() {
  const [state, setState] = useState<{ r: UpdateResult; manual: boolean } | null>(null);
  useEffect(() => {
    showFn = (r, manual) => setState({ r, manual });
    return () => {
      showFn = null;
    };
  }, []);
  if (!state) return null;
  return <UpdateNoticeDialog state={state} onClose={() => setState(null)} />;
}

function UpdateNoticeDialog({
  state,
  onClose,
}: {
  state: { r: UpdateResult; manual: boolean };
  onClose: () => void;
}) {
  const { t } = useI18n();
  const { r } = state;

  let title = t("help.update.title");
  let bodyNode: React.ReactNode;
  let actions: React.ReactNode;

  if (r.kind === "update") {
    title = t("help.update.available");
    bodyNode = (
      <>
        <div style={versions}>
          <span>{t("help.update.current")}</span>
          <code style={code}>v{r.current}</code>
          <span style={{ opacity: 0.6 }}>→</span>
          <span>{t("help.update.latest")}</span>
          <code style={{ ...code, borderColor: "#bcd6f0", color: "#0b5cad" }}>v{r.latest}</code>
        </div>
        {r.info.name && <div style={relName}>{r.info.name}</div>}
        {r.info.body && <pre style={notes}>{r.info.body}</pre>}
        <p style={hint}>{t("help.update.hint")}</p>
      </>
    );
    actions = (
      <>
        <button
          style={ghostBtn}
          onClick={() => {
            skipVersion(r.latest);
            onClose();
          }}
        >
          {t("help.update.skip")}
        </button>
        <div style={{ flex: 1 }} />
        <button style={ghostBtn} onClick={onClose}>
          {t("help.update.later")}
        </button>
        <button style={primaryBtn} onClick={() => openExternal(r.info.htmlUrl)}>
          {t("help.update.download")} ↗
        </button>
      </>
    );
  } else if (r.kind === "latest") {
    bodyNode = (
      <p style={{ ...hint, margin: 0 }}>
        {t("help.update.upToDate")} <code style={code}>v{r.latest}</code>
      </p>
    );
    actions = (
      <>
        <div style={{ flex: 1 }} />
        <button style={primaryBtn} onClick={onClose}>
          {t("common.close")}
        </button>
      </>
    );
  } else {
    // unavailable / error
    bodyNode = <p style={{ ...hint, margin: 0 }}>{t("help.update.failed")}</p>;
    actions = (
      <>
        <div style={{ flex: 1 }} />
        <button style={primaryBtn} onClick={onClose}>
          {t("common.close")}
        </button>
      </>
    );
  }

  return (
    <div style={overlay} onClick={onClose}>
      <div style={dialog} onClick={(e) => e.stopPropagation()} role="dialog" aria-label={title}>
        <div style={header}>
          <span style={{ fontWeight: 700 }}>{title}</span>
          <button style={closeBtn} onClick={onClose} aria-label={t("common.close")}>
            ✕
          </button>
        </div>
        <div style={{ padding: "14px 18px", overflow: "auto" }}>{bodyNode}</div>
        <div style={footer}>{actions}</div>
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
const versions: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "#465563", marginBottom: 10, flexWrap: "wrap" };
const relName: React.CSSProperties = { fontWeight: 600, fontSize: 14, marginBottom: 6 };
const notes: React.CSSProperties = {
  margin: "0 0 10px",
  fontSize: 12,
  color: "#3a4652",
  background: "#f6f8fa",
  border: "1px solid #e2e7ec",
  borderRadius: 6,
  padding: "10px 12px",
  maxHeight: 220,
  overflow: "auto",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  fontFamily: "ui-monospace, monospace",
  lineHeight: 1.5,
};
const hint: React.CSSProperties = { fontSize: 12, color: "#6b7783", lineHeight: 1.6 };
const code: React.CSSProperties = {
  fontFamily: "ui-monospace, monospace",
  fontSize: 12,
  background: "#f6f8fa",
  border: "1px solid #e2e7ec",
  borderRadius: 5,
  padding: "2px 7px",
};
const primaryBtn: React.CSSProperties = {
  border: "1px solid #0b5cad",
  borderRadius: 6,
  background: "#0b5cad",
  color: "#fff",
  cursor: "pointer",
  fontSize: 12,
  padding: "6px 14px",
};
const ghostBtn: React.CSSProperties = {
  border: "1px solid #cdd5de",
  borderRadius: 6,
  background: "#fff",
  color: "#465563",
  cursor: "pointer",
  fontSize: 12,
  padding: "6px 14px",
};
