import { useEffect, useMemo, useRef, useState } from "react";
import { Viewer2D, type ViewerOverlays } from "./Viewer2D";
import { buildSeriesLayout, buildLayoutFromDto, type SeriesLayout } from "./seriesLayout";
import { imageIdForInstance, type ViewerMode } from "./imageId";
import { fetchSeriesLayout, type Instance } from "../api";
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
}: {
  instances: Instance[];
  mode: ViewerMode;
  studyUid: string;
  seriesUid: string;
}) {
  const { t } = useI18n();
  const imageIds = useMemo(
    () => instances.map((i) => imageIdForInstance(mode, i.sopInstanceUid)),
    [instances, mode],
  );
  const imageIdBySop = useMemo(
    () => new Map(instances.map((i) => [i.sopInstanceUid, imageIdForInstance(mode, i.sopInstanceUid)])),
    [instances, mode],
  );
  const fallback = useMemo(() => buildSeriesLayout(imageIds), [imageIds]);

  // backend の ZCT レイアウト（IPP→Z / Temporal→T / Echo・Bvalue→C）。取得まで/失敗時は単一次元。
  const [layout, setLayout] = useState<SeriesLayout>(fallback);
  useEffect(() => {
    setLayout(fallback);
    let cancelled = false;
    fetchSeriesLayout(studyUid, seriesUid)
      .then((dto) => {
        if (cancelled) return;
        const built = buildLayoutFromDto(dto, imageIdBySop);
        if (built) setLayout(built);
      })
      .catch(() => {
        /* フォールバックのまま */
      });
    return () => {
      cancelled = true;
    };
  }, [studyUid, seriesUid, fallback, imageIdBySop]);

  const [z, setZ] = useState(0);
  const [c, setC] = useState(0);
  const [tIdx, setTIdx] = useState(0);
  const [overlays, setOverlays] = useState<OverlayState>({
    text: true,
    caliper: true,
    orientation: true,
    roi: false,
  });
  const [playing, setPlaying] = useState(false);
  const [fps, setFps] = useState(10);
  const [gridCols, setGridCols] = useState(0); // 0=Slider(SingleGridView), >0=Grid(FilmGrid) 列数
  const [lastCols, setLastCols] = useState(3);

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
    } else {
      setLastCols(cols);
    }
  };

  // シネ再生（Z をループ送り）。
  useEffect(() => {
    if (!playing || nZ <= 1) return;
    const id = window.setInterval(
      () => setZ((p) => (p + 1) % nZ),
      Math.max(16, Math.round(1000 / fps)),
    );
    return () => window.clearInterval(id);
  }, [playing, fps, nZ]);

  // キー操作（↑/→ で次、↓/← で前スライス）とホイール送り。Grid 中は無効（グリッドをスクロール）。
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = rootRef.current;
    if (!el || gridOn) return;
    const step = (d: number) => setZ((p) => Math.max(0, Math.min(nZ - 1, p + d)));
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowUp" || e.key === "ArrowRight") {
        step(1);
        e.preventDefault();
      } else if (e.key === "ArrowDown" || e.key === "ArrowLeft") {
        step(-1);
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

  const toggle = (k: keyof OverlayState) => setOverlays((o) => ({ ...o, [k]: !o[k] }));

  return (
    <div ref={rootRef} tabIndex={0} style={root}>
      {gridOn ? (
        <div style={gridScroll}>
          <div style={{ display: "grid", gridTemplateColumns: `repeat(${gridCols}, minmax(0, 1fr))`, gap: 6 }}>
            {zStack.map((id, i) => (
              <div key={id} style={cellBox}>
                <div style={cellCaption}>{i + 1}</div>
                <Viewer2D imageIds={[id]} imageIndex={0} overlays={overlays} compact height={CELL_HEIGHT} />
              </div>
            ))}
          </div>
        </div>
      ) : (
        <Viewer2D imageIds={zStack} imageIndex={zc} overlays={overlays} />
      )}

      <div style={controls}>
        {/* 表示モード切替（SliderView / FilmGrid 列数）。 */}
        <div style={row}>
          <button
            onClick={() => switchMode(gridOn ? 0 : lastCols)}
            disabled={gridDisabled}
            style={btn}
            title={t("series.view.toggle")}
          >
            {gridOn ? t("series.view.slider") : t("series.view.grid")}
          </button>
          <span style={dimLabel}>{t("series.columns")}</span>
          <select
            value={gridOn ? gridCols : 0}
            disabled={gridDisabled}
            onChange={(e) => switchMode(Number(e.target.value))}
            style={selectBox}
          >
            <option value={0}>{t("series.view.slider")}</option>
            {[2, 3, 4, 5, 6].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          {gridDisabled && <span style={hint}>{t("series.grid.disabled")}</span>}
        </div>

        {/* スライダー/シネは Slider モードのみ表示（Grid 中は非表示）。 */}
        {!gridOn && (
          <>
            <DimSlider label="Z" idx={zc} count={nZ} onChange={setZ} />
            {layout.nC > 1 && <DimSlider label="C" dim={layout.cDimension} idx={cc} count={layout.nC} onChange={setC} />}
            {layout.nT > 1 && <DimSlider label="T" dim={layout.tDimension} idx={tc} count={layout.nT} onChange={setTIdx} />}
            <div style={row}>
              <button onClick={() => setPlaying((p) => !p)} disabled={nZ <= 1} style={btn} title={t("series.cine")}>
                {playing ? "⏸" : "▶"}
              </button>
              <span style={dimLabel}>{t("series.fps")}</span>
              <input
                type="range"
                min={1}
                max={30}
                value={fps}
                onChange={(e) => setFps(Number(e.target.value))}
                style={{ flex: 1 }}
              />
              <span style={{ ...dimLabel, width: 26, textAlign: "right" }}>{fps}</span>
            </div>
          </>
        )}

        {/* オーバーレイ On/Off。 */}
        <div style={row}>
          <Check label={t("series.ov.text")} checked={overlays.text} onChange={() => toggle("text")} />
          <Check label={t("series.ov.caliper")} checked={overlays.caliper} onChange={() => toggle("caliper")} />
          <Check label={t("series.ov.orientation")} checked={overlays.orientation} onChange={() => toggle("orientation")} />
          <Check label={t("series.ov.roi")} checked={overlays.roi} onChange={() => toggle("roi")} disabled />
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
}: {
  label: string;
  dim?: string | null;
  idx: number;
  count: number;
  onChange: (v: number) => void;
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
