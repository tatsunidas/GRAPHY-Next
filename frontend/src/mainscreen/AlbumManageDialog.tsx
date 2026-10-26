/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { useState } from "react";
import { useI18n } from "../i18n/i18n";
import { deleteAlbum, renameAlbum, type Album } from "./albumApi";

/** アルバムの名前変更と削除。アルバムを消しても、スタディ本体（画像・索引）は消えない。 */
export function AlbumManageDialog({
  open,
  albums,
  onClose,
  onChanged,
}: {
  open: boolean;
  albums: Album[];
  onClose: () => void;
  onChanged: () => Promise<void> | void;
}) {
  const { t } = useI18n();
  const [editId, setEditId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [confirmId, setConfirmId] = useState<number | null>(null);
  const [error, setError] = useState("");

  if (!open) return null;

  const run = async (fn: () => Promise<void>) => {
    setError("");
    try {
      await fn();
      await onChanged();
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  };

  return (
    <div style={overlay} data-testid="album-manage-dialog" onClick={onClose}>
      <div style={dialog} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <strong>{t("album.manage.title")}</strong>
          <button type="button" style={btn} onClick={onClose} aria-label={t("common.close")}>✕</button>
        </div>
        <div style={{ fontSize: 12, color: "#667", margin: "6px 0 10px" }}>{t("album.manage.hint")}</div>
        {albums.length === 0 && <div style={{ color: "#778", fontSize: 13 }}>{t("album.manage.empty")}</div>}
        {albums.map((a) => (
          <div key={a.id} data-testid="album-manage-row" style={row}>
            {editId === a.id ? (
              <>
                <input
                  data-testid="album-rename-input"
                  value={editName}
                  maxLength={100}
                  onChange={(e) => setEditName(e.target.value)}
                  style={{ ...btn, flex: 1, cursor: "text" }}
                />
                <button
                  type="button"
                  data-testid="album-rename-save"
                  style={btn}
                  disabled={!editName.trim()}
                  onClick={() => run(async () => { await renameAlbum(a.id, editName.trim()); setEditId(null); })}
                >
                  {t("common.save")}
                </button>
                <button type="button" style={btn} onClick={() => setEditId(null)}>{t("common.cancel")}</button>
              </>
            ) : confirmId === a.id ? (
              <>
                <span style={{ flex: 1, fontSize: 13, color: "#7a1f1f" }}>{t("album.manage.confirm", { name: a.name })}</span>
                <button
                  type="button"
                  data-testid="album-delete-confirm"
                  style={{ ...btn, color: "#b42318" }}
                  onClick={() => run(async () => { await deleteAlbum(a.id); setConfirmId(null); })}
                >
                  {t("common.delete")}
                </button>
                <button type="button" style={btn} onClick={() => setConfirmId(null)}>{t("common.cancel")}</button>
              </>
            ) : (
              <>
                <span style={{ flex: 1, fontSize: 13 }}>{a.name}</span>
                <span style={{ fontSize: 12, color: "#778" }}>{t("album.manage.count", { n: a.count })}</span>
                <button
                  type="button"
                  data-testid="album-rename"
                  style={btn}
                  onClick={() => { setEditId(a.id); setEditName(a.name); setConfirmId(null); }}
                >
                  {t("album.manage.rename")}
                </button>
                <button type="button" data-testid="album-delete" style={btn} onClick={() => { setConfirmId(a.id); setEditId(null); }}>
                  {t("common.delete")}
                </button>
              </>
            )}
          </div>
        ))}
        {error && <div data-testid="album-manage-error" style={{ fontSize: 12, color: "#b42318", marginTop: 8 }}>{error}</div>}
      </div>
    </div>
  );
}

const overlay: React.CSSProperties = {
  position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000,
};
const dialog: React.CSSProperties = { background: "#fff", borderRadius: 8, padding: 16, width: 520, maxHeight: "80vh", overflow: "auto", boxShadow: "0 8px 30px rgba(0,0,0,0.25)" };
const row: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, padding: "6px 0", borderBottom: "1px solid #eee" };
const btn: React.CSSProperties = { padding: "4px 10px", border: "1px solid #cdd5de", borderRadius: 6, background: "#fff", cursor: "pointer", fontSize: 13 };
