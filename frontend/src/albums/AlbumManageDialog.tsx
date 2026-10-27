/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { useState } from "react";
import { useI18n } from "../i18n/i18n";
import { createAlbum, deleteAlbum, renameAlbum, type Album } from "./albumApi";

/**
 * アルバムの作成・名前変更・削除。削除の確認はダイアログの中で行う（`window.confirm` は使わない）。
 * 重複する名前・不正な名前は backend のエラー文をそのまま出す。
 */
export function AlbumManageDialog({
  albums,
  viewId,
  onClose,
  onChanged,
  onViewGone,
}: {
  albums: Album[];
  /** 一覧に表示中のアルバム。これを消したら `onViewGone` で絞り込みを解く。 */
  viewId: number | null;
  onClose: () => void;
  onChanged: () => void;
  onViewGone: () => void;
}) {
  const { t } = useI18n();
  const [names, setNames] = useState<Record<number, string>>({});
  const [newName, setNewName] = useState("");
  const [confirmId, setConfirmId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<unknown>, after?: () => void) => {
    try {
      await fn();
      setError(null);
      after?.();
      onChanged();
    } catch (e) {
      setError(t("album.err", { error: String(e instanceof Error ? e.message : e) }));
    }
  };

  return (
    <div style={overlay} data-testid="album-manage-dialog" onClick={onClose}>
      <div style={dialog} onClick={(e) => e.stopPropagation()}>
        <div style={header}>
          <strong>{t("album.manage.title")}</strong>
          <button type="button" style={closeBtn} onClick={onClose} aria-label={t("common.close")}>
            ✕
          </button>
        </div>
        <div style={{ padding: "10px 16px", overflow: "auto" }}>
          {albums.length === 0 && <div style={{ color: "#666", fontSize: 13 }}>{t("album.manage.empty")}</div>}
          {albums.map((a) => (
            <div key={a.id} style={{ padding: "6px 0", borderBottom: "1px solid #eef1f4" }}>
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input
                  data-testid={`album-name-${a.id}`}
                  value={names[a.id] ?? a.name}
                  onChange={(e) => setNames({ ...names, [a.id]: e.target.value })}
                  style={{ ...inp, flex: 1 }}
                />
                <span style={{ fontSize: 12, color: "#5a6672", whiteSpace: "nowrap" }}>
                  {t("album.manage.count", { n: a.count })}
                </span>
                <button
                  type="button"
                  style={btn}
                  disabled={(names[a.id] ?? a.name) === a.name}
                  onClick={() => run(() => renameAlbum(a.id, names[a.id] ?? a.name), () => setNames({ ...names, [a.id]: undefined as unknown as string }))}
                >
                  {t("album.manage.rename")}
                </button>
                <button type="button" data-testid={`album-delete-${a.id}`} style={btn} onClick={() => setConfirmId(a.id)}>
                  {t("album.manage.delete")}
                </button>
              </div>
              {confirmId === a.id && (
                <div style={confirmBox} data-testid={`album-delete-confirm-${a.id}`}>
                  <span>{t("album.manage.deleteConfirm", { name: a.name })}</span>
                  <button
                    type="button"
                    data-testid={`album-delete-yes-${a.id}`}
                    style={{ ...btn, color: "#b42318" }}
                    onClick={() =>
                      run(
                        () => deleteAlbum(a.id),
                        () => {
                          setConfirmId(null);
                          if (a.id === viewId) onViewGone();
                        },
                      )
                    }
                  >
                    {t("album.manage.deleteYes")}
                  </button>
                  <button type="button" style={btn} onClick={() => setConfirmId(null)}>
                    {t("common.cancel")}
                  </button>
                </div>
              )}
            </div>
          ))}
          <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
            <input
              data-testid="album-new-name-manage"
              value={newName}
              placeholder={t("album.manage.newPlaceholder")}
              onChange={(e) => setNewName(e.target.value)}
              style={{ ...inp, flex: 1 }}
            />
            <button
              type="button"
              data-testid="album-create-manage"
              style={btn}
              onClick={() => run(() => createAlbum(newName), () => setNewName(""))}
            >
              {t("album.manage.create")}
            </button>
          </div>
          {error && (
            <div data-testid="album-manage-error" style={{ color: "#b42318", fontSize: 12, marginTop: 8 }}>
              {error}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const overlay: React.CSSProperties = { position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 };
const dialog: React.CSSProperties = { width: 560, maxWidth: "96vw", maxHeight: "90vh", background: "#fff", borderRadius: 10, boxShadow: "0 12px 40px rgba(0,0,0,0.3)", display: "flex", flexDirection: "column", overflow: "hidden", fontFamily: "system-ui, sans-serif", color: "#1a1a1a" };
const header: React.CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", borderBottom: "1px solid #eee" };
const closeBtn: React.CSSProperties = { border: "none", background: "transparent", fontSize: 16, cursor: "pointer", color: "#666" };
const inp: React.CSSProperties = { padding: "5px 8px", border: "1px solid #cdd5de", borderRadius: 5, fontSize: 13 };
const btn: React.CSSProperties = { padding: "5px 12px", border: "1px solid #cdd5de", borderRadius: 6, background: "#fff", cursor: "pointer", fontSize: 13, whiteSpace: "nowrap" };
const confirmBox: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 6, padding: "6px 8px", background: "#fff6f5", border: "1px solid #f3c9c4", borderRadius: 5, fontSize: 12.5 };
