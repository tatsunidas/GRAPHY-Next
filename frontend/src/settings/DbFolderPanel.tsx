/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 環境設定 ＞ データ管理 ＞ DB フォルダ（デスクトップのみ）。
 *
 * <p>フォルダの選択・検査・切り替えの確認は main（`desktop/dbFolders.js`）が行う。
 * この画面は一覧を出し、操作を main に頼むだけ（切り替えると main がアプリを再起動する）。
 */
import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { useI18n } from "../i18n/i18n";
import { desktop, type DbFolderList, type DbFolderPickResult } from "../desktopBridge";
import { badgeKeys, canForget, canSwitch, reasonKey } from "./dbFolderView";

export function DbFolderPanel() {
  const { t } = useI18n();
  const d = desktop();
  const [list, setList] = useState<DbFolderList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!d?.dbFoldersList) return;
    try {
      setList(await d.dbFoldersList());
    } catch (e) {
      setError(t("common.fetchError", { error: String(e) }));
    }
  }, [d, t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!d?.dbFoldersList) {
    return <p style={note}>{t("settings.dbFolder.notDesktop")}</p>;
  }

  const showResult = (r: DbFolderPickResult) => {
    if (r.ok || r.canceled) return;
    setError(t("settings.dbFolder.error", { reason: t(reasonKey(r.reason)), code: r.reason ?? "?" }));
  };

  const run = async (op: () => Promise<DbFolderPickResult | undefined>) => {
    setBusy(true);
    setError(null);
    try {
      const r = await op();
      if (r) showResult(r);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
      void refresh();
    }
  };

  const switchTo = (folder: string) => run(() => d.dbFoldersSwitch!(folder));

  const pickThenSwitch = (pick: () => Promise<DbFolderPickResult>) =>
    run(async () => {
      const r = await pick();
      if (!r.ok || !r.folder) return r;
      return d.dbFoldersSwitch!(r.folder);
    });

  const forget = (folder: string) =>
    run(async () => {
      const r = await d.dbFoldersForget!(folder);
      return r.ok ? { ok: true } : { ok: false, reason: r.reason };
    });

  return (
    <section data-testid="db-folder-panel" style={{ marginBottom: 22 }}>
      <h3 style={sectionTitle}>{t("settings.dbFolder.title")}</h3>
      <p style={note}>{t("settings.dbFolder.help")}</p>
      {list?.active && <div style={{ marginBottom: 6 }}>{t("settings.dbFolder.active", { path: list.active })}</div>}
      {list && list.active && list.next !== list.active && (
        <div style={{ ...note, color: "#8a5a00" }}>{t("settings.dbFolder.nextDiffers", { path: list.next })}</div>
      )}
      {error && <div style={{ color: "#b00020", margin: "6px 0" }}>{error}</div>}

      <table style={{ width: "100%", borderCollapse: "collapse", margin: "8px 0" }}>
        <tbody>
          {(list?.folders ?? []).map((row) => (
            <tr key={row.path} data-testid="db-folder-row" style={{ borderBottom: "1px solid #eee" }}>
              <td style={{ padding: "6px 4px", wordBreak: "break-all", color: row.exists ? "#222" : "#999" }}>
                {row.path}
                {badgeKeys(row).map((k) => (
                  <span key={k} style={badge}>
                    {t(k)}
                  </span>
                ))}
              </td>
              <td style={{ padding: "6px 4px", whiteSpace: "nowrap", textAlign: "right" }}>
                <button style={btn} disabled={busy || !canSwitch(row)} onClick={() => switchTo(row.path)}>
                  {t("settings.dbFolder.switch")}
                </button>
                {canForget(row) && (
                  <button
                    style={btn}
                    disabled={busy}
                    title={t("settings.dbFolder.forgetHelp")}
                    onClick={() => forget(row.path)}
                  >
                    {t("settings.dbFolder.forget")}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div style={{ display: "flex", gap: 8 }}>
        <button
          style={btn}
          disabled={busy}
          onClick={() => pickThenSwitch(() => d.dbFoldersCreate!(t("settings.dbFolder.createTitle")))}
        >
          {t("settings.dbFolder.create")}
        </button>
        <button
          style={btn}
          disabled={busy}
          onClick={() => pickThenSwitch(() => d.dbFoldersPick!(t("settings.dbFolder.openTitle")))}
        >
          {t("settings.dbFolder.open")}
        </button>
      </div>
    </section>
  );
}

const sectionTitle: CSSProperties = { fontSize: 14, margin: "0 0 8px", color: "#444" };
const note: CSSProperties = { fontSize: 12, color: "#666", margin: "0 0 8px" };
const badge: CSSProperties = {
  marginLeft: 6,
  padding: "1px 6px",
  fontSize: 11,
  borderRadius: 8,
  background: "#e6effa",
  color: "#0b5cad",
};
const btn: CSSProperties = { marginLeft: 6, padding: "4px 10px", fontSize: 12, cursor: "pointer" };
