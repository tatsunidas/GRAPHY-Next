import { useEffect, useMemo, useRef, useState } from "react";
import { Viewer2D, type ViewerOverlays } from "./Viewer2D";
import { buildSeriesLayout } from "./seriesLayout";
import { imageIdForInstance, type ViewerMode } from "./imageId";
import { type Instance } from "../api";
import { useI18n } from "../i18n/i18n";

interface OverlayState extends Required<ViewerOverlays> {
  roi: boolean;
}

/**
 * シリーズ管理コントローラ。画像表示パネル(Viewer2D)を内包し、スライス送り（スライダー/キー/
 * ホイール）・シネ再生・オーバーレイ On/Off・5D(ZCT) の次元切替を担う。
 *
 * <p>シリーズ全体での Zoom/Pan/コントラスト(WW/WL)/回転/反転は、同一スタック内では
 * Viewer2D（StackViewport）が自動的に維持する。
 */
export function SeriesViewer({ instances, mode }: { instances: Instance[]; mode: ViewerMode }) {
  const { t } = useI18n();
  const imageIds = useMemo(
    () => instances.map((i) => imageIdForInstance(mode, i.sopInstanceUid)),
    [instances, mode],
  );
  const layout = useMemo(() => buildSeriesLayout(imageIds), [imageIds]);

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

  const zStack = layout.zStack(c, tIdx);
  const nZ = zStack.length;
  const zc = Math.min(Math.max(0, z), nZ - 1);

  // シネ再生（Z をループ送り）。
  useEffect(() => {
    if (!playing || nZ <= 1) return;
    const id = window.setInterval(
      () => setZ((p) => (p + 1) % nZ),
      Math.max(16, Math.round(1000 / fps)),
    );
    return () => window.clearInterval(id);
  }, [playing, fps, nZ]);

  // キー操作（↑/→ で次、↓/← で前スライス）とホイール送り。
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
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
  }, [nZ]);

  const toggle = (k: keyof OverlayState) => setOverlays((o) => ({ ...o, [k]: !o[k] }));

  return (
    <div ref={rootRef} tabIndex={0} style={root}>
      <Viewer2D imageIds={zStack} imageIndex={zc} overlays={overlays} />

      <div style={controls}>
        {/* 次元スライダー（5D 時は C/T も表示）。 */}
        <DimSlider label="Z" idx={zc} count={nZ} onChange={setZ} />
        {layout.nC > 1 && <DimSlider label="C" idx={c} count={layout.nC} onChange={setC} />}
        {layout.nT > 1 && <DimSlider label="T" idx={tIdx} count={layout.nT} onChange={setTIdx} />}

        {/* シネ再生。 */}
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
  idx,
  count,
  onChange,
}: {
  label: string;
  idx: number;
  count: number;
  onChange: (v: number) => void;
}) {
  return (
    <div style={row}>
      <span style={dimLabel}>
        {label} {idx + 1}/{count}
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
