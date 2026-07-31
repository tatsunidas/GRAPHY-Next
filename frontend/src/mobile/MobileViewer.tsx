/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * モバイル 2D ビューア（`fw/mobile-ui-design.md` M3・§4.1）。
 *
 * <p>**描画コアはそのまま再利用する。** `viewer/SeriesViewer.tsx`（＋内包する `viewer/Viewer2D.tsx`）に
 * 手を入れず、シェルとツールバーだけ差し替える。タイルは **1×1 固定**
 * （マルチタイル比較は狭幅で成立しない）。
 *
 * <p>デスクトップの `viewer2d/Viewer2DScreen.tsx` にある左ツリー（`width: 280` 固定）は、
 * モバイルではシリーズ一覧画面が担うので**ドロワー**に落とす（ビューアを離れずに切り替えたい場合用）。
 *
 * <p>3D / MPR タブは M5、Fusion は M6、レポートは M8。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Series, Study } from "../api";
import { useInstances } from "../hooks/useInstances";
import { useSeries } from "../hooks/useSeries";
import { useI18n } from "../i18n/i18n";
import { SeriesViewer } from "../viewer/SeriesViewer";
import { TOOL_IDS } from "../viewer/toolIds";
import type { ViewerMode } from "../viewer/imageId";
import { MOBILE_TILE_ID, MobileToolbar } from "./MobileToolbar";

export function MobileViewer({
  study,
  series,
  mode,
  onChangeSeries,
}: {
  study: Study;
  series: Series;
  mode: ViewerMode;
  onChangeSeries: (s: Series) => void;
}) {
  const { t } = useI18n();
  const { instances, error, loading } = useInstances(study.studyInstanceUid, series.seriesInstanceUid);
  const [activeTool, setActiveTool] = useState<string>(TOOL_IDS.windowLevel);
  const [drawerOpen, setDrawerOpen] = useState(false);

  // シリーズを切り替えたらドロワーを閉じ、ツール選択は既定（W/L）へ戻す。
  useEffect(() => {
    setDrawerOpen(false);
    setActiveTool(TOOL_IDS.windowLevel);
  }, [series.seriesInstanceUid]);

  const seriesLabel = useMemo(
    () => series.seriesDescription || `#${series.seriesNumber ?? "—"}`,
    [series],
  );

  const closeDrawer = useCallback(() => setDrawerOpen(false), []);

  return (
    <div style={wrap}>
      <div style={stage}>
        {error && <p style={errorText}>{t("common.fetchError", { error })}</p>}
        {loading && <p style={hintText}>{t("common.loading")}</p>}
        {instances && instances.length === 0 && <p style={hintText}>{t("common.noData")}</p>}
        {instances && instances.length > 0 && (
          <SeriesViewer
            // シリーズを跨いで内部状態（Z/C/T・ソート）を引きずらないよう作り直す。
            key={series.seriesInstanceUid}
            instances={instances}
            mode={mode}
            studyUid={study.studyInstanceUid}
            seriesUid={series.seriesInstanceUid}
            fillHeight
            // スライス送り（スライダー＋シネ）は既存パネルをそのまま使う（§3.4）。
            // モバイル専用ツールバーは下に別途出す。
            showControls
            commandKey={MOBILE_TILE_ID}
            seriesLabel={seriesLabel}
            patientKey={study.patientId || study.patientName || study.studyInstanceUid}
          />
        )}
      </div>

      <MobileToolbar
        activeTool={activeTool}
        onChangeTool={setActiveTool}
        onOpenSeriesDrawer={() => setDrawerOpen(true)}
      />

      {drawerOpen && (
        <SeriesDrawer
          study={study}
          currentUid={series.seriesInstanceUid}
          onSelect={(s) => {
            onChangeSeries(s);
            closeDrawer();
          }}
          onClose={closeDrawer}
        />
      )}
    </div>
  );
}

/**
 * シリーズ切替のドロワー（下からせり上がるシート）。
 * デスクトップの左ツリー（`Viewer2DScreen` の `width: 280` 固定）に相当する。
 */
function SeriesDrawer({
  study,
  currentUid,
  onSelect,
  onClose,
}: {
  study: Study;
  currentUid: string;
  onSelect: (s: Series) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const { series, loading } = useSeries(study.studyInstanceUid);

  return (
    // 背面タップで閉じる。シート側は onClick を伝播させない。
    <div style={scrim} onClick={onClose} data-testid="mobile-series-drawer">
      <div style={sheet} onClick={(e) => e.stopPropagation()}>
        <div style={sheetHead}>
          <span style={{ fontSize: 15, fontWeight: 600 }}>{t("mobile.title.series")}</span>
          <button style={closeBtn} onClick={onClose} aria-label={t("common.close")}>
            ✕
          </button>
        </div>
        <div style={sheetBody}>
          {loading && <p style={hintText}>{t("common.loading")}</p>}
          {series
            ?.slice()
            .sort((a, b) => (a.seriesNumber ?? 0) - (b.seriesNumber ?? 0))
            .map((s) => {
              const on = s.seriesInstanceUid === currentUid;
              return (
                <button
                  key={s.seriesInstanceUid}
                  style={on ? drawerItemOn : drawerItem}
                  onClick={() => onSelect(s)}
                  data-testid={`mobile-drawer-series-${s.seriesInstanceUid}`}
                >
                  <span style={{ fontSize: 14 }}>{s.seriesDescription || `#${s.seriesNumber ?? "—"}`}</span>
                  <span style={{ fontSize: 12, color: "#8b9bb0" }}>
                    {[s.seriesNumber != null ? `#${s.seriesNumber}` : null, s.modality, s.numberOfInstances]
                      .filter((v) => v != null && v !== "")
                      .join(" · ")}
                  </span>
                </button>
              );
            })}
        </div>
      </div>
    </div>
  );
}

// ── スタイル ──

const wrap: React.CSSProperties = { display: "flex", flexDirection: "column", height: "100%", minHeight: 0 };

/** 画像領域。`minHeight: 0` が無いと flex 子が縮まず、ツールバーが画面外へ出る。 */
const stage: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflow: "auto",
  WebkitOverflowScrolling: "touch",
  background: "#000",
};

const hintText: React.CSSProperties = { margin: 0, padding: 16, fontSize: 13, color: "#8b9bb0" };
const errorText: React.CSSProperties = { margin: 0, padding: 16, fontSize: 13, color: "#ff8a8a" };

const scrim: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 50,
  display: "flex",
  alignItems: "flex-end",
  background: "rgba(0,0,0,0.55)",
};

const sheet: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  width: "100%",
  maxHeight: "70%",
  borderTopLeftRadius: 14,
  borderTopRightRadius: 14,
  background: "#171b22",
  color: "#e8ecf1",
  paddingBottom: "env(safe-area-inset-bottom, 0px)",
};

const sheetHead: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "10px 14px",
  borderBottom: "1px solid #262c35",
};

const sheetBody: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
  padding: 12,
  overflowY: "auto",
  WebkitOverflowScrolling: "touch",
};

const closeBtn: React.CSSProperties = {
  minWidth: 44,
  minHeight: 44,
  border: "none",
  background: "transparent",
  color: "#9fb2c9",
  fontSize: 16,
  cursor: "pointer",
};

const drawerItem: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-start",
  gap: 3,
  minHeight: 44,
  padding: "10px 12px",
  border: "1px solid #262c35",
  borderRadius: 8,
  background: "transparent",
  color: "#e8ecf1",
  textAlign: "left",
  cursor: "pointer",
};

const drawerItemOn: React.CSSProperties = { ...drawerItem, background: "#12253a", borderColor: "#2f6db5" };
