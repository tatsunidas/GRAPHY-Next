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
import { fetchInstances, type Instance, type Series, type Study } from "../api";
import { useInstances } from "../hooks/useInstances";
import { useSeries } from "../hooks/useSeries";
import { useI18n } from "../i18n/i18n";
import { SeriesViewer } from "../viewer/SeriesViewer";
import { FusionImageViewer } from "../viewer/FusionOverlayViewer";
import type { RenderOverlay } from "../viewer/Viewer2D";
import { TOOL_IDS } from "../viewer/toolIds";
import type { ViewerMode } from "../viewer/imageId";
import { launchMobileVolumeViewer } from "./launchViewer";
import { MOBILE_TILE_ID, MobileToolbar } from "./MobileToolbar";

/** モバイルの Fusion 状態。デスクトップの `FusionOverlay` から、狭幅で使わない項目を落としたもの。 */
interface MobileFusion {
  series: Series;
  instances: Instance[];
  /** 0.0–1.0。 */
  opacity: number;
}

/** 重ね初期不透明度。デスクトップのセンタードロップ（`Viewer2DScreen`）と同じ 0.5。 */
const DEFAULT_FUSION_OPACITY = 0.5;

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
  const [fusion, setFusion] = useState<MobileFusion | null>(null);

  // シリーズを切り替えたらドロワーを閉じ、ツール選択は既定（W/L）へ戻し、Fusion も解除する
  // （base が変われば重ね合わせの意味が変わるため）。
  useEffect(() => {
    setDrawerOpen(false);
    setActiveTool(TOOL_IDS.windowLevel);
    setFusion(null);
  }, [series.seriesInstanceUid]);

  /**
   * Fusion オーバーレイ描画（`fw/mobile-ui-design.md` §4.3）。
   *
   * <p>**Fusion は 2 ボリューム同時ロードではなく 2D canvas のオーバレイ**なので MPR/3D より
   * 桁違いに軽く、モバイルに最も向いている。背景スライス位置の近傍数枚だけを遅延ロードするため、
   * 全スライスの画素は読まない。
   *
   * <p>`useMemo` で安定化するのは必須。毎レンダ別関数だと `Viewer2D` 側の rect 初期計算 effect が
   * ループする（`Viewer2DScreen` の同等箇所に同じ注意書きがある）。
   */
  const renderFusionOverlay = useMemo<RenderOverlay | undefined>(() => {
    if (!fusion) return undefined;
    const f = fusion;
    return (ctx) => (
      <FusionImageViewer
        rect={ctx.rect}
        baseImageId={ctx.imageId}
        baseIndex={ctx.index}
        baseCount={ctx.count}
        instances={f.instances}
        mode={mode}
        studyUid={study.studyInstanceUid}
        seriesUid={f.series.seriesInstanceUid}
        // モバイルは C/T 切替 UI を持たないので常に先頭。
        overlayC={0}
        overlayT={0}
        opacity={f.opacity}
      />
    );
  }, [fusion, mode, study.studyInstanceUid]);

  /** ドロワーから「重ねる」を選んだとき。インスタンスが取れなくても解除はできる状態にする。 */
  const applyFusion = useCallback(async (s: Series) => {
    const list = await fetchInstances(study.studyInstanceUid, s.seriesInstanceUid).catch(
      () => [] as Instance[],
    );
    setFusion({ series: s, instances: list, opacity: DEFAULT_FUSION_OPACITY });
    setDrawerOpen(false);
  }, [study.studyInstanceUid]);

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
            renderFusionOverlay={renderFusionOverlay}
          />
        )}
      </div>

      {fusion && (
        <div style={fusionBar} data-testid="mobile-fusion-bar">
          <span style={fusionLabel}>
            {fusion.series.seriesDescription || `#${fusion.series.seriesNumber ?? "—"}`}
          </span>
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round(fusion.opacity * 100)}
            onChange={(e) => setFusion((f) => (f ? { ...f, opacity: Number(e.target.value) / 100 } : f))}
            style={{ flex: 1 }}
            aria-label={t("viewer2d.fusion.opacity")}
            data-testid="mobile-fusion-opacity"
          />
          <button
            style={fusionClearBtn}
            onClick={() => setFusion(null)}
            aria-label={t("common.close")}
            data-testid="mobile-fusion-clear"
          >
            ✕
          </button>
        </div>
      )}

      <MobileToolbar
        activeTool={activeTool}
        onChangeTool={setActiveTool}
        onOpenSeriesDrawer={() => setDrawerOpen(true)}
        onLaunchVolumeViewer={(kind) => launchMobileVolumeViewer(kind, study, series, Date.now())}
      />

      {drawerOpen && (
        <SeriesDrawer
          study={study}
          currentUid={series.seriesInstanceUid}
          fusionUid={fusion?.series.seriesInstanceUid ?? null}
          onSelect={(s) => {
            onChangeSeries(s);
            closeDrawer();
          }}
          onFuse={(s) => void applyFusion(s)}
          onClose={closeDrawer}
        />
      )}
    </div>
  );
}

/**
 * シリーズ切替のドロワー（下からせり上がるシート）。
 * デスクトップの左ツリー（`Viewer2DScreen` の `width: 280` 固定）に相当する。
 *
 * <p>**Fusion の導線もここに置く**（`fw/mobile-ui-design.md` §4.3）。デスクトップはタイル中央への
 * ドラッグ＆ドロップで重ねるが、タッチでは成立しないため「このシリーズを重ねる」ボタンにする。
 */
function SeriesDrawer({
  study,
  currentUid,
  fusionUid,
  onSelect,
  onFuse,
  onClose,
}: {
  study: Study;
  currentUid: string;
  /** いま重ねているシリーズ（あれば）。 */
  fusionUid: string | null;
  onSelect: (s: Series) => void;
  onFuse: (s: Series) => void;
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
              const fused = s.seriesInstanceUid === fusionUid;
              return (
                <div key={s.seriesInstanceUid} style={drawerRow}>
                  <button
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
                  {/* 表示中のシリーズを自分自身に重ねても意味が無いので出さない。 */}
                  {!on && (
                    <button
                      style={fused ? fuseBtnOn : fuseBtn}
                      onClick={() => onFuse(s)}
                      data-testid={`mobile-drawer-fuse-${s.seriesInstanceUid}`}
                    >
                      {t("mobile.fuse")}
                    </button>
                  )}
                </div>
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

const drawerRow: React.CSSProperties = { display: "flex", alignItems: "stretch", gap: 6 };

const fuseBtn: React.CSSProperties = {
  flex: "0 0 auto",
  minWidth: 64,
  minHeight: 44,
  border: "1px solid #39414d",
  borderRadius: 8,
  background: "transparent",
  color: "#9fb2c9",
  fontSize: 12,
  cursor: "pointer",
};
const fuseBtnOn: React.CSSProperties = { ...fuseBtn, background: "#0b5cad", borderColor: "#2f6db5", color: "#fff" };

const fusionBar: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "6px 10px",
  borderTop: "1px solid #262c35",
  background: "#12253a",
};
const fusionLabel: React.CSSProperties = {
  flex: "0 1 auto",
  maxWidth: "40%",
  fontSize: 12,
  color: "#c3cddb",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const fusionClearBtn: React.CSSProperties = {
  flex: "0 0 auto",
  minWidth: 44,
  minHeight: 44,
  border: "none",
  background: "transparent",
  color: "#9fb2c9",
  fontSize: 15,
  cursor: "pointer",
};
