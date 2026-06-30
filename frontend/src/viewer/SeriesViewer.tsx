/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { getRenderingEngine, type Types } from "@cornerstonejs/core";
import { ToolGroupManager } from "@cornerstonejs/tools";
import { Viewer2D, ENGINE_ID, type ViewerOverlays, type RenderOverlay } from "./Viewer2D";
import { applyTransform, readTransform, FIT_TRANSFORM } from "./transform";
import { buildSeriesLayout, buildLayoutFromDto, type SeriesLayout } from "./seriesLayout";
import { registerSliceSync, publishSlice, setSliceSyncConfig } from "./sliceSync";
import { imageIdForInstance, type ViewerMode } from "./imageId";
import { matchesCombo } from "../shortcuts/registry";
import { fetchSeriesLayout, type Instance } from "../api";
import { fetchSettings } from "../settings/settingsApi";
import { useI18n } from "../i18n/i18n";

interface OverlayState extends Required<ViewerOverlays> {
  roi: boolean;
}

/** 動画(ビデオ)系 SOP Class。GridView を無効化する。 */
const VIDEO_SOP_CLASSES = new Set([
  "1.2.840.10008.5.1.4.1.1.77.1.1.1", // Video Endoscopic Image Storage
  "1.2.840.10008.5.1.4.1.1.77.1.2.1", // Video Microscopic Image Storage
  "1.2.840.10008.5.1.4.1.1.77.1.4.1", // Video Photographic Image Storage
]);

/** グリッドセルの高さ(px)。 */
const CELL_HEIGHT = 200;
/** これを超えるスライス数で GridView に切替える際は確認する（描画負荷が大きいため）。 */
const GRID_WARN_THRESHOLD = 100;

/**
 * シリーズ管理コントローラ。画像表示パネル(Viewer2D)を内包し、スライス送り（スライダー/キー/
 * ホイール）・シネ再生・オーバーレイ On/Off・5D(ZCT) の次元切替を担う。
 *
 * <p>シリーズ全体での Zoom/Pan/コントラスト(WW/WL)/回転/反転は、同一スタック内では
 * Viewer2D（StackViewport）が自動的に維持する。
 */
export function SeriesViewer({
  instances,
  mode,
  studyUid,
  seriesUid,
  fillHeight = false,
  syncEnabled = false,
  referenceLinesEnabled = false,
  referenceLabel,
  commandKey,
  onDimChange,
  renderFusionOverlay,
}: {
  instances: Instance[];
  mode: ViewerMode;
  studyUid: string;
  seriesUid: string;
  /** タイル表示用: 親コンテナの高さに追従する（flex:1 レイアウト）。 */
  fillHeight?: boolean;
  /** シリーズ Sync: このタイルの Sync トグルが ON か。ON かつ SliderView 時のみ同期に参加。 */
  syncEnabled?: boolean;
  /** リファレンスライン: 他シリーズの現在スライス面の交差線をこのビューに描画する。 */
  referenceLinesEnabled?: boolean;
  /** リファレンスラインの凡例に使うシリーズ名。 */
  referenceLabel?: string;
  /** 画面メニュー/ツールバーからの一括コマンドのキー（= tileId）。 */
  commandKey?: string;
  /** 現在表示中の C/T インデックス変化を上位に通知（Fusion の初期 C/T 引き継ぎ用）。 */
  onDimChange?: (c: number, t: number) => void;
  /** Fusion オーバーレイ。スライダー表示時に base 画像へ重ねて描画する（GridView では無効）。 */
  renderFusionOverlay?: RenderOverlay;
}) {
  const { t } = useI18n();
  const imageIds = useMemo(
    () => instances.map((i) => imageIdForInstance(mode, i.sopInstanceUid)),
    [instances, mode],
  );
  const fallback = useMemo(() => buildSeriesLayout(imageIds), [imageIds]);

  // backend の ZCT レイアウト（IPP→Z / Temporal→T / Echo・Bvalue→C / モザイク Z×T）。
  // 取得まで/失敗時は単一次元。
  const [layout, setLayout] = useState<SeriesLayout>(fallback);
  useEffect(() => {
    setLayout(fallback);
    let cancelled = false;
    fetchSeriesLayout(studyUid, seriesUid)
      .then((dto) => {
        if (cancelled) return;
        const built = buildLayoutFromDto(dto, mode, studyUid, seriesUid);
        if (built) setLayout(built);
      })
      .catch(() => {
        /* フォールバックのまま */
      });
    return () => {
      cancelled = true;
    };
  }, [studyUid, seriesUid, fallback, mode]);

  const [z, setZ] = useState(0);
  const [c, setC] = useState(0);
  const [tIdx, setTIdx] = useState(0);
  const [overlays, setOverlays] = useState<OverlayState>({
    text: true,
    caliper: true,
    orientation: true,
    roi: false,
  });
  // シネ再生は Z/C/T それぞれ独立。各次元のインデックスをループ送りする。
  const [playZ, setPlayZ] = useState(false);
  const [playC, setPlayC] = useState(false);
  const [playT, setPlayT] = useState(false);
  // シネ速度は環境設定 viewer.cineFps から（既定 10）。
  const [fps, setFps] = useState(10);
  useEffect(() => {
    fetchSettings()
      .then((m) => {
        const v = Number(m["viewer.cineFps"]);
        if (Number.isFinite(v) && v >= 1) setFps(v);
        // シリーズ Sync の方式（座標/単純）と許容半径(mm)をグローバル coordinator に反映。
        const coord = m["viewer.coordinateSync"] !== "false"; // 既定 true
        const margin = Number(m["viewer.coordinateSyncMargin"]);
        setSliceSyncConfig(coord ? "coordinate" : "simple", Number.isFinite(margin) ? margin : 2.5);
      })
      .catch(() => {
        /* 既定のまま */
      });
  }, []);
  const [gridCols, setGridCols] = useState(0); // 0=Slider(SingleGridView), >0=Grid(FilmGrid) 列数

  const cc = Math.min(Math.max(0, c), layout.nC - 1);
  const tc = Math.min(Math.max(0, tIdx), layout.nT - 1);
  const zStack = layout.zStack(cc, tc);
  const nZ = zStack.length;
  const zc = Math.min(Math.max(0, z), nZ - 1);

  // マルチチャンネル / 動画(ビデオ UID) / スライス1枚 では GridView を無効化。
  const hasVideo = useMemo(
    () => instances.some((i) => i.sopClassUid && VIDEO_SOP_CLASSES.has(i.sopClassUid)),
    [instances],
  );
  const gridDisabled = layout.nC > 1 || hasVideo || nZ <= 1;
  const gridOn = gridCols > 0 && !gridDisabled;

  // 無効条件になったら Slider に戻し 1 枚目へ。
  useEffect(() => {
    if (gridDisabled && gridCols !== 0) {
      setGridCols(0);
      setZ(0);
    }
  }, [gridDisabled, gridCols]);

  const switchMode = (cols: number) => {
    // 100 枚超で Grid に切替える場合は確認。キャンセルなら SliderView のまま変更しない。
    if (cols > 0 && nZ > GRID_WARN_THRESHOLD) {
      if (!window.confirm(t("series.grid.warnMany", { n: nZ }))) {
        return;
      }
    }
    setGridCols(cols);
    if (cols === 0) {
      setZ(0); // Slider に戻ったら 1 枚目を表示
    }
  };

  // GridView リンク用の同期グループ ID（このシリーズビューア内で一意）。
  const rawId = useId();
  const syncGroupId = useMemo(() => `graphy-grid-${rawId.replace(/[^a-zA-Z0-9]/g, "")}`, [rawId]);

  // 先頭ビューポートに変換を適用 → camera/VOI 同期で全セルへ波及（シリーズ全体リンク）。
  const firstLinkedViewport = (): Types.IStackViewport | undefined => {
    const ids = ToolGroupManager.getToolGroup(syncGroupId)?.getViewportIds() ?? [];
    const engine = getRenderingEngine(ENGINE_ID);
    for (const id of ids) {
      const vp = engine?.getViewport(id) as Types.IStackViewport | undefined;
      if (vp) return vp;
    }
    return undefined;
  };
  const linkApply = (patch: Parameters<typeof applyTransform>[1]) => {
    const vp = firstLinkedViewport();
    if (vp) applyTransform(vp, patch);
  };
  const gRotate = () => {
    const vp = firstLinkedViewport();
    if (vp) applyTransform(vp, { rotation: (readTransform(vp).rotation + 90) % 360 });
  };
  const gFlipH = () => {
    const vp = firstLinkedViewport();
    if (vp) applyTransform(vp, { flipHorizontal: !readTransform(vp).flipHorizontal });
  };
  const gFlipV = () => {
    const vp = firstLinkedViewport();
    if (vp) applyTransform(vp, { flipVertical: !readTransform(vp).flipVertical });
  };
  const gZoom = (f: number) => {
    const vp = firstLinkedViewport();
    if (vp) applyTransform(vp, { zoom: readTransform(vp).zoom * f });
  };

  // シネ再生（各次元を独立してループ送り）。
  const cineInterval = Math.max(16, Math.round(1000 / fps));
  useEffect(() => {
    if (!playZ || nZ <= 1) return;
    const id = window.setInterval(() => setZ((p) => (p + 1) % nZ), cineInterval);
    return () => window.clearInterval(id);
  }, [playZ, cineInterval, nZ]);
  useEffect(() => {
    if (!playC || layout.nC <= 1) return;
    const id = window.setInterval(() => setC((p) => (p + 1) % layout.nC), cineInterval);
    return () => window.clearInterval(id);
  }, [playC, cineInterval, layout.nC]);
  useEffect(() => {
    if (!playT || layout.nT <= 1) return;
    const id = window.setInterval(() => setTIdx((p) => (p + 1) % layout.nT), cineInterval);
    return () => window.clearInterval(id);
  }, [playT, cineInterval, layout.nT]);

  // キー操作（↑/→ で次、↓/← で前スライス）とホイール送り。Grid 中は無効（グリッドをスクロール）。
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = rootRef.current;
    if (!el || gridOn) return;
    const step = (d: number) => setZ((p) => Math.max(0, Math.min(nZ - 1, p + d)));
    // 既定ショートカット（registry）に従う。ArrowUp=前, ArrowDown=次, Home/End=先頭/末尾,
    // Space=シネ, O=テキストオーバーレイ切替。
    const onKey = (e: KeyboardEvent) => {
      // コントロール（スライダー/ボタン/セレクト）操作中は誤爆させない。
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || tag === "BUTTON") return;
      if (matchesCombo("ArrowUp", e)) {
        step(-1);
        e.preventDefault();
      } else if (matchesCombo("ArrowDown", e)) {
        step(1);
        e.preventDefault();
      } else if (matchesCombo("Home", e)) {
        setZ(0);
        e.preventDefault();
      } else if (matchesCombo("End", e)) {
        setZ(nZ - 1);
        e.preventDefault();
      } else if (matchesCombo("Space", e)) {
        setPlayZ((p) => !p);
        e.preventDefault();
      } else if (matchesCombo("O", e)) {
        setOverlays((o) => ({ ...o, text: !o.text }));
        e.preventDefault();
      }
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      step(e.deltaY > 0 ? 1 : -1);
    };
    el.addEventListener("keydown", onKey);
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("keydown", onKey);
      el.removeEventListener("wheel", onWheel);
    };
  }, [nZ, gridOn]);

  // ── シリーズ Sync ─────────────────────────────────────────
  //
  // SliderView かつ Sync ON のとき、グローバル coordinator（sliceSync）に参加する。
  // ユーザー操作でスライスが動いたら publishSlice し、他タイルへ座標/単純同期で伝播する。
  // coordinator からの移動（applyIndex）は syncDrivenRef で再 publish を抑止（ループ防止）。

  const syncDrivenRef = useRef(false);
  const sliceSyncId = useMemo(() => `slicesync-${rawId.replace(/[^a-zA-Z0-9]/g, "")}`, [rawId]);
  // getState/applyIndex が常に最新値を参照するためのリーフ。
  const nZRef = useRef(nZ); nZRef.current = nZ;
  const zcRef = useRef(zc); zcRef.current = zc;
  const layoutRef = useRef(layout); layoutRef.current = layout;

  const syncOn = syncEnabled && !gridOn;
  useEffect(() => {
    if (!syncOn) return;
    const unregister = registerSliceSync({
      id: sliceSyncId,
      getState: () => {
        const n = nZRef.current;
        const lay = layoutRef.current;
        const ipps = Array.from({ length: n }, (_, z) => lay.ippAt?.(z) ?? null);
        return { index: zcRef.current, nZ: n, ipps, normal: lay.normal ?? null };
      },
      applyIndex: (z) => {
        syncDrivenRef.current = true;
        setZ(z);
      },
    });
    return unregister;
  }, [syncOn, sliceSyncId]);

  // スライス変化を coordinator に publish。Sync 受信由来（syncDrivenRef）は再 publish しない。
  useEffect(() => {
    if (syncDrivenRef.current) {
      syncDrivenRef.current = false;
      return;
    }
    if (syncOn) publishSlice(sliceSyncId);
  }, [zc, nZ, syncOn, sliceSyncId]);

  // 現在表示中の C/T を上位へ通知（Fusion の初期 C/T 引き継ぎ用）。
  useEffect(() => {
    onDimChange?.(cc, tc);
  }, [cc, tc, onDimChange]);

  const toggle = (k: keyof OverlayState) => setOverlays((o) => ({ ...o, [k]: !o[k] }));

  // 各次元スライダー横のシネ再生ボタン（▶/⏸）。
  const cinePlayBtn = (on: boolean, onToggle: () => void, disabled: boolean) => (
    <button onClick={onToggle} disabled={disabled} style={btn} title={t("series.cine")}>
      {on ? "⏸" : "▶"}
    </button>
  );

  return (
    <div ref={rootRef} tabIndex={0} style={fillHeight ? { ...root, flex: 1, display: "flex", flexDirection: "column", minHeight: 0 } : root}>
      {gridOn ? (
        <div style={gridScroll}>
          <div style={{ display: "grid", gridTemplateColumns: `repeat(${gridCols}, minmax(0, 1fr))`, gap: 6 }}>
            {zStack.map((id, i) => (
              <div key={id} style={cellBox}>
                <div style={cellCaption}>{i + 1}</div>
                <Viewer2D
                  imageIds={[id]}
                  imageIndex={0}
                  overlays={overlays}
                  compact
                  height={CELL_HEIGHT}
                  syncGroupId={syncGroupId}
                />
              </div>
            ))}
          </div>
        </div>
      ) : (
        <Viewer2D imageIds={zStack} imageIndex={zc} overlays={overlays} fill={fillHeight} viewSyncEnabled={syncOn} referenceLinesEnabled={referenceLinesEnabled} referenceLabel={referenceLabel} commandKey={commandKey} renderOverlay={renderFusionOverlay} />
      )}

      <div style={controls}>
        {/* GridView の操作バー（W/L・Pan・Zoom はドラッグ、回転/反転/Fit はボタン。全セルにリンク）。 */}
        {gridOn && (
          <div style={row}>
            <button onClick={() => linkApply({ zoom: 1, pan: [0, 0] })} style={btn} title={t("viewer.fit")}>
              {t("viewer.fit")}
            </button>
            <button onClick={() => gZoom(1 / 1.2)} style={btn} title={t("viewer.zoomOut")}>−</button>
            <button onClick={() => gZoom(1.2)} style={btn} title={t("viewer.zoomIn")}>＋</button>
            <button onClick={gRotate} style={btn} title={t("viewer.rotate")}>⟳</button>
            <button onClick={gFlipH} style={btn} title={t("viewer.flipH")}>⇄</button>
            <button onClick={gFlipV} style={btn} title={t("viewer.flipV")}>⇅</button>
            <button onClick={() => linkApply(FIT_TRANSFORM)} style={btn} title={t("viewer.reset")}>
              {t("viewer.reset")}
            </button>
            <span style={hint}>{t("series.grid.linked")}</span>
          </div>
        )}

        {/* スライダー/シネは Slider モードのみ表示（Grid 中は非表示）。各次元に独立した再生ボタン。 */}
        {!gridOn && (
          <>
            <DimSlider
              label="Z"
              idx={zc}
              count={nZ}
              onChange={setZ}
              trailing={cinePlayBtn(playZ, () => setPlayZ((p) => !p), nZ <= 1)}
            />
            {layout.nC > 1 && (
              <DimSlider
                label="C"
                dim={layout.cDimension}
                idx={cc}
                count={layout.nC}
                onChange={setC}
                trailing={cinePlayBtn(playC, () => setPlayC((p) => !p), layout.nC <= 1)}
              />
            )}
            {layout.nT > 1 && (
              <DimSlider
                label="T"
                dim={layout.tDimension}
                idx={tc}
                count={layout.nT}
                onChange={setTIdx}
                trailing={cinePlayBtn(playT, () => setPlayT((p) => !p), layout.nT <= 1)}
              />
            )}
          </>
        )}

        {/* オーバーレイ On/Off。列数ドロップダウン（Reset=SliderView, 1〜7=GridView）。 */}
        <div style={row}>
          <Check label={t("series.ov.text")} checked={overlays.text} onChange={() => toggle("text")} />
          <Check label={t("series.ov.caliper")} checked={overlays.caliper} onChange={() => toggle("caliper")} />
          <Check label={t("series.ov.orientation")} checked={overlays.orientation} onChange={() => toggle("orientation")} />
          <Check label={t("series.ov.roi")} checked={overlays.roi} onChange={() => toggle("roi")} disabled />
          <select
            value={gridOn ? gridCols : 0}
            disabled={gridDisabled}
            onChange={(e) => switchMode(Number(e.target.value))}
            style={selectBox}
          >
            <option value={0}>{t("series.grid.reset")}</option>
            {[1, 2, 3, 4, 5, 6, 7].map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
          {gridDisabled && <span style={hint}>{t("series.grid.disabled")}</span>}
        </div>
      </div>
    </div>
  );
}

function DimSlider({
  label,
  dim,
  idx,
  count,
  onChange,
  trailing,
}: {
  label: string;
  dim?: string | null;
  idx: number;
  count: number;
  onChange: (v: number) => void;
  trailing?: React.ReactNode;
}) {
  return (
    <div style={row}>
      <span style={dimLabel}>
        {label} {idx + 1}/{count}
        {dim ? ` (${dim})` : ""}
      </span>
      <input
        type="range"
        min={0}
        max={Math.max(0, count - 1)}
        value={idx}
        disabled={count <= 1}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ flex: 1 }}
      />
      {trailing}
    </div>
  );
}

function Check({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
}) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: disabled ? "#9aa6b2" : "#33404d" }}>
      <input type="checkbox" checked={checked} onChange={onChange} disabled={disabled} />
      {label}
    </label>
  );
}

const root: React.CSSProperties = { outline: "none" };
const controls: React.CSSProperties = {
  marginTop: 8,
  padding: "10px 12px",
  background: "#f7f9fb",
  border: "1px solid #e1e7ee",
  borderRadius: 6,
  display: "flex",
  flexDirection: "column",
  gap: 8,
  maxWidth: 560,
};
const row: React.CSSProperties = { display: "flex", alignItems: "center", gap: 10 };
const dimLabel: React.CSSProperties = {
  fontSize: 12,
  color: "#5a6672",
  fontVariantNumeric: "tabular-nums",
  minWidth: 52,
};
const btn: React.CSSProperties = {
  minWidth: 34,
  padding: "3px 8px",
  border: "1px solid #cdd5de",
  borderRadius: 6,
  background: "#fff",
  cursor: "pointer",
  fontSize: 13,
};
const selectBox: React.CSSProperties = {
  padding: "3px 6px",
  border: "1px solid #cdd5de",
  borderRadius: 6,
  background: "#fff",
  fontSize: 13,
};
const hint: React.CSSProperties = { fontSize: 12, color: "#9aa6b2" };
const gridScroll: React.CSSProperties = {
  maxHeight: "72vh",
  overflowY: "auto",
  padding: 6,
  background: "#0c0f12",
  border: "1px solid #2a2f35",
  borderRadius: 6,
};
const cellBox: React.CSSProperties = { display: "flex", flexDirection: "column" };
const cellCaption: React.CSSProperties = {
  fontSize: 11,
  color: "#9aa6b2",
  padding: "0 2px 2px",
  fontVariantNumeric: "tabular-nums",
};
