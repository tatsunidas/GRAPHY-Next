/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { useEffect, useState } from "react";
import { useI18n } from "../i18n/i18n";
import { fetchAlbums, fetchAlbumStudies, type Album } from "./albumApi";
import type { AlbumView } from "./albumView";
import { AlbumManageDialog } from "./AlbumManageDialog";
import { RoiFeatureBatchDialog } from "../radiomics/RoiFeatureBatchDialog";

/**
 * 一覧の上のアルバム切り替え。選ぶと一覧をそのアルバムのスタディだけに絞り、「検索条件に戻す」で元に戻る。
 * アルバムの一覧は `version` が変わるたびに取り直す（追加・作成・削除のあと）。
 */
export function AlbumBar({
  view,
  version,
  onOpen,
  onClose,
  onChanged,
  batchEnabled = false,
}: {
  view: AlbumView | null;
  version: number;
  onOpen: (v: AlbumView) => void;
  onClose: () => void;
  onChanged: () => void;
  /** ROI 特徴量の一括抽出を出せるか（standalone 版だけ）。 */
  batchEnabled?: boolean;
}) {
  const { t } = useI18n();
  const [albums, setAlbums] = useState<Album[]>([]);
  const [manageOpen, setManageOpen] = useState(false);
  const [batchOpen, setBatchOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetchAlbums()
      .then((a) => alive && setAlbums(a))
      .catch((e) => alive && setError(t("album.err", { error: String(e instanceof Error ? e.message : e) })));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  const open = async (id: number) => {
    const a = albums.find((x) => x.id === id);
    if (!a) return;
    try {
      onOpen({ id, name: a.name, uids: await fetchAlbumStudies(id) });
      setError(null);
    } catch (e) {
      setError(t("album.err", { error: String(e instanceof Error ? e.message : e) }));
    }
  };

  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
        <span style={{ color: "#5a6672" }}>{t("album.bar.label")}</span>
        <select
          data-testid="album-select"
          value={view?.id ?? ""}
          onChange={(e) => (e.target.value === "" ? onClose() : open(Number(e.target.value)))}
          style={{ padding: "4px 8px", border: "1px solid #cdd5de", borderRadius: 6, fontSize: 13, minWidth: 160 }}
        >
          <option value="">{t("album.bar.choose")}</option>
          {albums.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name} ({a.count})
            </option>
          ))}
        </select>
        <button type="button" data-testid="album-manage-button" onClick={() => setManageOpen(true)} style={btn}>
          {t("album.bar.manage")}
        </button>
        {batchEnabled && (
          <button type="button" data-testid="album-batch-button" disabled={!view} onClick={() => setBatchOpen(true)}
            title={view ? undefined : t("album.bar.batchNeedsAlbum")} style={btn}>
            {t("album.bar.batch")}
          </button>
        )}
      </div>
      {error && (
        <div data-testid="album-error" style={{ color: "#b42318", fontSize: 12, marginTop: 4 }}>
          {error}
        </div>
      )}
      {view && (
        <div style={banner} data-testid="album-view-banner">
          <span>{t("album.bar.showing", { name: view.name, count: view.uids.length })}</span>
          <button type="button" onClick={onClose}>
            {t("album.bar.back")}
          </button>
        </div>
      )}
      {batchOpen && view && (
        <RoiFeatureBatchDialog albumId={view.id} albumName={view.name} uids={view.uids}
          onClose={() => setBatchOpen(false)} />
      )}
      {manageOpen && (
        <AlbumManageDialog
          albums={albums}
          viewId={view?.id ?? null}
          onClose={() => setManageOpen(false)}
          onChanged={onChanged}
          onViewGone={onClose}
        />
      )}
    </div>
  );
}

const btn: React.CSSProperties = {
  padding: "4px 12px",
  border: "1px solid #cdd5de",
  borderRadius: 6,
  background: "#fff",
  cursor: "pointer",
  fontSize: 13,
};
const banner: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "6px 10px",
  marginTop: 6,
  background: "#eaf2fb",
  border: "1px solid #c9dcf0",
  borderRadius: 4,
  fontSize: 13,
  color: "#1a4a80",
};
