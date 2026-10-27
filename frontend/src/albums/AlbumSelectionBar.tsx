/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { useEffect, useState } from "react";
import { useI18n } from "../i18n/i18n";
import { addToAlbum, chunkUids, createAlbum, fetchAlbums, removeFromAlbum, type Album } from "./albumApi";
import type { AlbumView } from "./albumView";

const NEW = "__new__";

const errText = (e: unknown) => String(e instanceof Error ? e.message : e);

/**
 * 一覧でチェックしたスタディを、アルバムに入れる・（アルバム表示中は）アルバムから外す。
 * 外してもスタディ本体（画像・索引）は消えない。
 */
export function AlbumSelectionBar({
  selected,
  view,
  version,
  onChanged,
}: {
  selected: string[];
  view: AlbumView | null;
  version: number;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const [albums, setAlbums] = useState<Album[]>([]);
  const [newOpen, setNewOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [msg, setMsg] = useState<{ text: string; error: boolean } | null>(null);

  useEffect(() => {
    let alive = true;
    fetchAlbums()
      .then((a) => alive && setAlbums(a))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [version]);

  // 操作の結果は数秒で消す。表示するアルバムを切り替えたときも消す（前の操作の結果が残らないように）。
  useEffect(() => {
    if (!msg) return;
    const id = setTimeout(() => setMsg(null), 8000);
    return () => clearTimeout(id);
  }, [msg]);
  useEffect(() => {
    setMsg(null);
  }, [view?.id]);

  const addAll =async (id: number, name: string) => {
    let added = 0;
    let already = 0;
    try {
      for (const part of chunkUids(selected)) {
        const r = await addToAlbum(id, part);
        added += r.added;
        already += r.alreadyIn;
      }
      setMsg({ text: t("album.add.result", { name, added, already }), error: false });
      onChanged();
    } catch (e) {
      setMsg({ text: t("album.err", { error: errText(e) }), error: true });
    }
  };

  const createAndAdd = async () => {
    try {
      const a = await createAlbum(newName);
      setNewOpen(false);
      setNewName("");
      await addAll(a.id, a.name);
    } catch (e) {
      setMsg({ text: t("album.err", { error: errText(e) }), error: true });
    }
  };

  const removeSelected = async () => {
    if (!view) return;
    try {
      let removed = 0;
      for (const part of chunkUids(selected)) removed += (await removeFromAlbum(view.id, part)).removed;
      setMsg({ text: t("album.remove.result", { n: removed }), error: false });
      onChanged();
    } catch (e) {
      setMsg({ text: t("album.err", { error: errText(e) }), error: true });
    }
  };

  if (selected.length === 0 && !msg) return null;

  return (
    <div style={bar} data-testid="album-selection-bar">
      {selected.length > 0 && <span style={{ fontSize: 13 }}>{t("album.add.selected", { n: selected.length })}</span>}
      {selected.length > 0 && (
        <>
          <select
            data-testid="album-add-select"
            value=""
            onChange={(e) => {
              const v = e.target.value;
              if (v === NEW) setNewOpen(true);
              else if (v) addAll(Number(v), albums.find((a) => a.id === Number(v))?.name ?? "");
            }}
            style={sel}
          >
            <option value="">{t("album.add.placeholder")}</option>
            {albums.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
            <option value={NEW}>{t("album.add.new")}</option>
          </select>
          {view && (
            <button type="button" data-testid="album-remove-selected" onClick={removeSelected} style={btn} title={t("album.remove.note")}>
              {t("album.remove.selected")}
            </button>
          )}
        </>
      )}
      {newOpen && (
        <span style={{ display: "inline-flex", gap: 6 }}>
          <input
            data-testid="album-new-name"
            value={newName}
            placeholder={t("album.new.name")}
            onChange={(e) => setNewName(e.target.value)}
            style={{ ...sel, minWidth: 160 }}
          />
          <button type="button" data-testid="album-new-create" onClick={createAndAdd} style={btn}>
            {t("album.new.create")}
          </button>
          <button type="button" onClick={() => setNewOpen(false)} style={btn}>
            {t("common.cancel")}
          </button>
        </span>
      )}
      {msg && (
        <span data-testid="album-result" style={{ fontSize: 12.5, color: msg.error ? "#b42318" : "#2e5d27" }}>
          {msg.text}
        </span>
      )}
    </div>
  );
}

/** アルバムにあるのに存在しないスタディ（削除された）。ほかのスタディの表示は妨げない。 */
export function AlbumMissing({
  view,
  missing,
  onChanged,
}: {
  view: AlbumView;
  missing: string[];
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const [error, setError] = useState<string | null>(null);
  if (missing.length === 0) return null;

  const remove = async (uids: string[]) => {
    try {
      for (const part of chunkUids(uids)) await removeFromAlbum(view.id, part);
      setError(null);
      onChanged();
    } catch (e) {
      setError(t("album.err", { error: errText(e) }));
    }
  };

  return (
    <div style={missingBox} data-testid="album-missing">
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <strong style={{ fontSize: 13 }}>{t("album.missing.title", { n: missing.length })}</strong>
        <button type="button" data-testid="album-missing-clear" style={btn} onClick={() => remove(missing)}>
          {t("album.missing.clear")}
        </button>
      </div>
      {missing.map((uid) => (
        <div key={uid} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, marginTop: 4 }}>
          <span style={{ color: "#8a5a00" }}>{t("album.missing.row")}</span>
          <code style={{ color: "#555" }}>{uid}</code>
          <button type="button" data-testid={`album-missing-remove-${uid}`} style={btn} onClick={() => remove([uid])}>
            {t("album.missing.remove")}
          </button>
        </div>
      ))}
      {error && <div style={{ color: "#b42318", fontSize: 12, marginTop: 4 }}>{error}</div>}
    </div>
  );
}

const bar: React.CSSProperties = { display: "flex", alignItems: "center", flexWrap: "wrap", gap: 10, margin: "6px 0 8px" };
const sel: React.CSSProperties = { padding: "4px 8px", border: "1px solid #cdd5de", borderRadius: 6, fontSize: 13 };
const btn: React.CSSProperties = { padding: "4px 10px", border: "1px solid #cdd5de", borderRadius: 6, background: "#fff", cursor: "pointer", fontSize: 12.5 };
const missingBox: React.CSSProperties = { margin: "10px 0", padding: "8px 12px", background: "#fff8e8", border: "1px solid #f0dca8", borderRadius: 6 };
