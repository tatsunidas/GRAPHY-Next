/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { useCallback, useEffect, useState } from "react";
import { useI18n } from "../i18n/i18n";
import { AlbumManageDialog } from "./AlbumManageDialog";
import {
  addToAlbum, albumStudyUids, createAlbum, listAlbums, removeFromAlbum, type Album,
} from "./albumApi";
import { albumView, type AlbumView } from "./albumView";

const NEW_ALBUM = "__new__";

/**
 * 一覧の上のアルバムのバー。アルバムの選択（表示）、選んだスタディのアルバムへの追加・アルバムから外す、管理。
 * アルバムから外しても、スタディ本体（画像・索引）は消えない。
 */
export function AlbumBar({
  view,
  checked,
  missing,
  reloadKey,
  onOpen,
  onClose,
  onClearChecked,
}: {
  view: AlbumView | null;
  checked: ReadonlySet<string>;
  /** アルバム表示中、一覧に出てこなかった（見つからない）メンバーの UID */
  missing: readonly string[];
  reloadKey: number;
  onOpen: (v: AlbumView) => void;
  onClose: () => void;
  onClearChecked: () => void;
}) {
  const { t } = useI18n();
  const [albums, setAlbums] = useState<Album[]>([]);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [manageOpen, setManageOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [newName, setNewName] = useState("");

  const refresh = useCallback(async () => {
    try {
      setAlbums(await listAlbums());
      setError("");
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh, reloadKey]);

  // アルバムを開く（メンバーを取り直して一覧の条件にする）。
  const open = useCallback(async (a: { id: number; name: string }) => {
    try {
      onOpen(albumView(a, await albumStudyUids(a.id)));
      setError("");
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  }, [onOpen]);

  const run = async (fn: () => Promise<void>) => {
    setError("");
    setMsg("");
    try {
      await fn();
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  };

  const addChecked = (target: Album) =>
    run(async () => {
      const r = await addToAlbum(target.id, Array.from(checked));
      setMsg(t("album.added", { name: target.name, added: r.added, already: r.alreadyIn }));
      onClearChecked();
      await refresh();
      if (view?.id === target.id) await open(target);
    });

  const createAndAdd = () =>
    run(async () => {
      const a = await createAlbum(newName.trim());
      setNewName("");
      setNewOpen(false);
      await refresh();
      if (checked.size > 0) {
        const r = await addToAlbum(a.id, Array.from(checked));
        setMsg(t("album.createdAdded", { name: a.name, added: r.added }));
        onClearChecked();
        await refresh();
        if (view?.id === a.id) await open(a);
      } else {
        setMsg(t("album.created", { name: a.name }));
      }
    });

  const removeChecked = () =>
    run(async () => {
      if (!view) return;
      const n = await removeFromAlbum(view.id, Array.from(checked));
      setMsg(t("album.removed", { name: view.name, n }));
      onClearChecked();
      await refresh();
      await open(view);
    });

  const cleanMissing = () =>
    run(async () => {
      if (!view) return;
      const n = await removeFromAlbum(view.id, missing);
      setMsg(t("album.cleaned", { n }));
      await refresh();
      await open(view);
    });

  return (
    <div data-testid="album-bar" style={bar}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <label style={{ fontSize: 13, color: "#334" }}>{t("album.label")}</label>
        <select
          data-testid="album-select"
          value={view ? String(view.id) : ""}
          onChange={(e) => {
            const id = e.target.value;
            setMsg("");
            if (!id) {
              onClose();
              return;
            }
            const a = albums.find((x) => String(x.id) === id);
            if (a) void open(a);
          }}
          style={sel}
        >
          <option value="">{t("album.none")}</option>
          {albums.map((a) => (
            <option key={a.id} value={String(a.id)}>{`${a.name} (${a.count})`}</option>
          ))}
        </select>
        <button type="button" data-testid="album-new-open" style={btn} onClick={() => setNewOpen((v) => !v)}>
          {t("album.new")}
        </button>
        <button type="button" data-testid="album-manage" style={btn} onClick={() => setManageOpen(true)}>
          {t("album.manage")}
        </button>

        {checked.size > 0 && (
          <span data-testid="album-checked" style={{ display: "inline-flex", alignItems: "center", gap: 6, marginLeft: 12 }}>
            <span style={{ fontSize: 13 }}>{t("album.checked", { n: checked.size })}</span>
            <select
              data-testid="album-add-select"
              value=""
              onChange={(e) => {
                const id = e.target.value;
                if (id === NEW_ALBUM) {
                  setNewOpen(true);
                } else {
                  const a = albums.find((x) => String(x.id) === id);
                  if (a) void addChecked(a);
                }
              }}
              style={sel}
            >
              <option value="">{t("album.addTo")}</option>
              {albums.map((a) => (
                <option key={a.id} value={String(a.id)}>{a.name}</option>
              ))}
              <option value={NEW_ALBUM}>{t("album.addToNew")}</option>
            </select>
            {view && (
              <button type="button" data-testid="album-remove-checked" style={btn} onClick={removeChecked} title={t("album.removeHint")}>
                {t("album.remove")}
              </button>
            )}
          </span>
        )}
      </div>

      {newOpen && (
        <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
          <input
            data-testid="album-new-name"
            value={newName}
            maxLength={100}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && newName.trim() && void createAndAdd()}
            placeholder={t("album.name")}
            style={{ ...sel, width: 220 }}
          />
          <button type="button" data-testid="album-new-create" style={btn} disabled={!newName.trim()} onClick={createAndAdd}>
            {checked.size > 0 ? t("album.createAdd", { n: checked.size }) : t("album.create")}
          </button>
          <button type="button" style={btn} onClick={() => setNewOpen(false)}>{t("common.cancel")}</button>
        </div>
      )}

      {view && (
        <div data-testid="album-view-banner" style={banner}>
          <span>{t("album.viewing", { name: view.name, n: view.uids.length })}</span>
          <button type="button" style={btn} onClick={onClose}>{t("main.import.backToSearch")}</button>
        </div>
      )}
      {view && missing.length > 0 && (
        <div data-testid="album-missing" style={{ ...banner, background: "#fff6e5", borderColor: "#f0d9a8", color: "#7a4b00" }}>
          <span>{t("album.missing", { n: missing.length })}</span>
          <button type="button" data-testid="album-clean" style={btn} onClick={cleanMissing}>{t("album.clean")}</button>
        </div>
      )}
      {msg && <div data-testid="album-msg" style={{ fontSize: 12, color: "#1a6b2e", marginTop: 4 }}>{msg}</div>}
      {error && <div data-testid="album-error" style={{ fontSize: 12, color: "#b42318", marginTop: 4 }}>{error}</div>}

      <AlbumManageDialog
        open={manageOpen}
        albums={albums}
        onClose={() => setManageOpen(false)}
        onChanged={async () => {
          await refresh();
          // 表示中のアルバムが消えた・名前が変わったときは、表示を合わせる
          if (view) {
            const list = await listAlbums().catch(() => null);
            const cur = list?.find((a) => a.id === view.id);
            if (!cur) onClose();
            else if (cur.name !== view.name) await open(cur);
          }
        }}
      />
    </div>
  );
}

const bar: React.CSSProperties = { marginBottom: 8 };
const sel: React.CSSProperties = { padding: "4px 8px", border: "1px solid #cdd5de", borderRadius: 6, fontSize: 13, background: "#fff" };
const btn: React.CSSProperties = { padding: "4px 10px", border: "1px solid #cdd5de", borderRadius: 6, background: "#fff", cursor: "pointer", fontSize: 13 };
const banner: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 12, padding: "6px 10px", marginTop: 6,
  background: "#eaf2fb", border: "1px solid #c9dcf0", borderRadius: 4, fontSize: 13, color: "#1a4a80",
};
