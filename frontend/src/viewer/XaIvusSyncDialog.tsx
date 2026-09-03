/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * IVUS / OCT とアンギオの同期表示（A8）— `fw/angio-design.md` §12。
 *
 * <h3>この画面がやること</h3>
 * 左にアンギオ、右に断層を並べ、**プルバック距離という 1 つの状態**で結ぶ。
 * 断層のフレームを送れば経路上の印が動き、経路をクリックすれば断層のフレームが変わる。
 *
 * <h3>🔴 `sliceSync` は使わない（§12.4.5）</h3>
 * あれは**2 つのスタックの Z 添字**を結ぶ器で、A8 の結合とは形が違う。
 * **アンギオのフレーム（シネの時間軸）はプルバック位置と無関係**なので、当てはめると
 * **アンギオのシネ送りで断層が飛ぶ**という説明のつかない挙動になる。
 *
 * <h3>🔴 シリーズを跨ぐ唯一の解析画面である</h3>
 * 既存の解析（QCA / QLV / 3D QCA / TIMI）は**すべて単一シリーズで完結**しており前例が無い。
 * ここでは**断層のシリーズから開き、中で相手のアンギオを選ぶ**。相手の画素は
 * `fetchSeriesLayout` → `buildLayoutFromDto` で組む（ビューアと同じ経路）。
 *
 * <h3>🚨 出せないときに出さない</h3>
 * 引き抜き速度が無ければ距離を出さない／未校正なら経路上の位置を出さない。
 * そして**対応づけは ±1〜2mm の近似**（§12.3・心拍による縦方向運動を無視している）なので、
 * **ステント端の位置決めに単独で使わない**ことを画面に常時出す。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { fetchSeries, fetchSeriesLayout, type Series } from "../api";
import { useI18n } from "../i18n/i18n";
import { publishIvusSyncSnapshot } from "./debugApi";
import {
  distanceForFrame,
  frameForDistance,
  pathLengthMm,
  pathLengthRatio,
  pointAtDistance,
  pullbackGeometry,
  readPullbackSource,
  PULLBACK_ACCURACY_MM,
  type PullbackGeometry,
  type PullbackLandmark,
} from "./ivusSync";
import { readModalitySlice } from "./pixelCalibration";
import { buildLayoutFromDto } from "./seriesLayout";
import { viewerOverlayProps } from "./viewerOverlay";
import { isXaCalibrated } from "./xaCalibration";
import { calibrationForImageId } from "./xaCalibrationProvider";
import { prewarmXaDataset } from "./xaCine";
import type { ViewerMode } from "./imageId";

const PANE_W = 340;
const PANE_H = 340;

interface Slice {
  values: Float32Array;
  width: number;
  height: number;
}

/** アンギオ側で置く 2 点（プルバックの開始＝カテーテル先端の初期位置、終了）。 */
type PathPoints = { start: [number, number] | null; end: [number, number] | null };

export function XaIvusSyncDialog({
  imageIds,
  studyUid,
  seriesUid,
  mode,
  currentFrame,
  onClose,
  onGoToFrame,
}: {
  /** 断層（IVUS / OCT）のフレーム列。 */
  imageIds: readonly string[];
  studyUid: string;
  seriesUid: string;
  mode: ViewerMode;
  /** 断層側の表示フレーム（0 origin）。 */
  currentFrame: number;
  onClose: () => void;
  onGoToFrame?: (index: number) => void;
}) {
  const { t } = useI18n();

  const [series, setSeries] = useState<Series[]>([]);
  const [angioUid, setAngioUid] = useState<string>("");
  const [angioIds, setAngioIds] = useState<string[]>([]);
  const [angioFrame, setAngioFrame] = useState(0);
  const [angioSlice, setAngioSlice] = useState<Slice | null>(null);
  const [tomoSlice, setTomoSlice] = useState<Slice | null>(null);
  const [path, setPath] = useState<PathPoints>({ start: null, end: null });
  const [landmarks] = useState<PullbackLandmark[]>([]);
  const [error, setError] = useState<string | null>(null);

  /* ── プルバックの幾何（タグ由来）─────────────────────────────── */
  const [geometry, setGeometry] = useState<PullbackGeometry | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const id = imageIds[0];
    if (!id) return;
    void prewarmXaDataset(id)
      .then(() => {
        if (!alive) return;
        const src = readPullbackSource(id);
        if (!src) {
          setUnavailable("noTags");
          return;
        }
        const r = pullbackGeometry(src);
        if ("unavailable" in r) {
          setGeometry(null);
          setUnavailable(r.unavailable);
        } else {
          setGeometry(r.geometry);
          setUnavailable(null);
        }
      })
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, [imageIds]);

  /* ── 同じスタディのシリーズ一覧（相手のアンギオを選ぶ）───────── */
  useEffect(() => {
    let alive = true;
    void fetchSeries(studyUid)
      .then((list) => {
        if (!alive) return;
        setSeries(list);
        // 既定は「自分以外の XA/XRF で最初のもの」。無ければ選ばせる。
        const angio = list.find(
          (s) => s.seriesInstanceUid !== seriesUid && (s.modality === "XA" || s.modality === "XRF"),
        );
        if (angio) setAngioUid(angio.seriesInstanceUid);
      })
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, [studyUid, seriesUid]);

  /* ── 選んだアンギオのフレーム列を組む（ビューアと同じ経路）───── */
  useEffect(() => {
    let alive = true;
    if (!angioUid) {
      setAngioIds([]);
      return;
    }
    void fetchSeriesLayout(studyUid, angioUid)
      .then((dto) => {
        if (!alive) return;
        const built = buildLayoutFromDto(dto, mode, studyUid, angioUid);
        // アンギオはフレーム軸がスタック（stackAxis="t"）なので、1 ラン目の全フレームを取る。
        // アンギオはフレーム軸がスタック（stackAxis="t"）なので tStack を使う。
        // 通常のシリーズなら zStack。**どちらか一方に決め打ちしない**（相手は XA とは限らない）。
        const ids =
          built?.stackAxis === "t" && built.tStack ? built.tStack(0, 0) : (built?.zStack(0, 0) ?? []);
        setAngioIds(ids);
        setAngioFrame(0);
        // 🚨 経路は**アンギオ 1 本ごとに引き直す**（別の撮影に前の経路を持ち越さない）。
        setPath({ start: null, end: null });
      })
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, [studyUid, angioUid, mode]);

  /* ── 画素 ────────────────────────────────────────────────────── */
  useEffect(() => {
    let alive = true;
    const id = angioIds[angioFrame];
    if (!id) {
      setAngioSlice(null);
      return;
    }
    void readModalitySlice(id).then((s) => {
      if (alive && s) setAngioSlice({ values: s.values, width: s.width, height: s.height });
    });
    return () => {
      alive = false;
    };
  }, [angioIds, angioFrame]);

  useEffect(() => {
    let alive = true;
    const id = imageIds[currentFrame];
    if (!id) return;
    void readModalitySlice(id).then((s) => {
      if (alive && s) setTomoSlice({ values: s.values, width: s.width, height: s.height });
    });
    return () => {
      alive = false;
    };
  }, [imageIds, currentFrame]);

  /* ── 空間校正（アンギオ側）───────────────────────────────────── */
  // 🔴 非等方をそのまま持つ（平均して 1 値に潰さない。`xaCalibration.ts` の方針）。
  const calib = useMemo(() => {
    const id = angioIds[angioFrame];
    if (!id) return { col: null as number | null, row: null as number | null };
    const c = calibrationForImageId(id);
    if (!c || !isXaCalibrated(c)) return { col: null, row: null };
    return { col: c.mmPerPxCol, row: c.mmPerPxRow };
  }, [angioIds, angioFrame]);
  const calibrated = calib.col != null && calib.row != null;

  /** アンギオ上の経路（いまは 2 点の直線。中心線追跡は §12.4.6 の残件）。 */
  const pullbackPath = useMemo(
    () => ({
      pointsPx: path.start && path.end ? [path.start, path.end] : [],
      mmPerPxCol: calib.col,
      mmPerPxRow: calib.row,
    }),
    [path, calib],
  );

  const distanceMm = useMemo(
    () => (geometry ? distanceForFrame(geometry, currentFrame, landmarks) : null),
    [geometry, currentFrame, landmarks],
  );
  const marker = useMemo(
    () => (distanceMm != null ? pointAtDistance(pullbackPath, distanceMm) : null),
    [pullbackPath, distanceMm],
  );
  const lengthRatio = useMemo(
    () => (geometry ? pathLengthRatio(pullbackPath, geometry) : null),
    [pullbackPath, geometry],
  );

  /** 経路をクリック → その位置の距離 → 断層のフレームへ（§12 の「どちらを動かしても追従」）。 */
  const goToDistance = useCallback(
    (mm: number) => {
      if (!geometry || !onGoToFrame) return;
      onGoToFrame(frameForDistance(geometry, mm, imageIds.length, landmarks));
    },
    [geometry, onGoToFrame, imageIds.length, landmarks],
  );

  useEffect(() => {
    publishIvusSyncSnapshot({
      tomoSeriesUid: seriesUid,
      angioSeriesUid: angioUid || null,
      tomoFrame: currentFrame,
      tomoFrameCount: imageIds.length,
      angioFrame,
      angioFrameCount: angioIds.length,
      geometry: geometry ? { ...geometry } : null,
      unavailable,
      mmPerPxCol: calib.col,
      mmPerPxRow: calib.row,
      pathPointsPx: path.start && path.end ? [path.start, path.end] : [],
      pathLengthMm: pathLengthMm(pullbackPath),
      pathLengthRatio: lengthRatio,
      distanceMm,
      markerPx: marker ? { x: marker.x, y: marker.y, clamped: marker.clamped } : null,
      accuracyMm: PULLBACK_ACCURACY_MM,
    });
  });
  useEffect(() => () => publishIvusSyncSnapshot(null), []);

  const fmt = (v: number | null | undefined, d = 2) => (v == null ? "—" : v.toFixed(d));

  return (
    <div style={backdrop} onMouseDown={onClose}>
      <div
        style={panel}
        onMouseDown={(e) => e.stopPropagation()}
        data-testid="xa-ivus-dialog"
        {...viewerOverlayProps}
      >
        <div style={title}>{t("ivus.title")}</div>
        {/* 🔴 精度の限界は常時出す（数値だけ出すと保証されているように読める）。 */}
        <div style={warn} data-testid="ivus-accuracy">
          {t("ivus.accuracy", { mm: String(PULLBACK_ACCURACY_MM) })}
        </div>
        {error && <div style={errorText}>{error}</div>}

        <div style={row}>
          <label style={label}>
            {t("ivus.angioSeries")}
            <select
              value={angioUid}
              data-testid="ivus-angio-select"
              onChange={(e) => setAngioUid(e.target.value)}
              style={{ maxWidth: 320 }}
            >
              <option value="">{t("ivus.angioSeries.pick")}</option>
              {series
                .filter((s) => s.seriesInstanceUid !== seriesUid)
                .map((s) => (
                  <option key={s.seriesInstanceUid} value={s.seriesInstanceUid}>
                    {`#${s.seriesNumber ?? "?"} ${s.modality ?? "?"} ${s.seriesDescription ?? ""}`}
                  </option>
                ))}
            </select>
          </label>
        </div>

        <div style={panes}>
          {/* ── アンギオ ─────────────────────────────────────── */}
          <div>
            <div style={sectionTitle}>{t("ivus.pane.angio")}</div>
            {angioSlice ? (
              <AngioPane
                slice={angioSlice}
                path={path}
                marker={marker}
                onPlace={(p) =>
                  setPath((cur) =>
                    !cur.start || (cur.start && cur.end) ? { start: p, end: null } : { ...cur, end: p },
                  )
                }
                onPickDistance={(mm) => goToDistance(mm)}
                calib={calib}
              />
            ) : (
              <div style={{ ...paneBox, display: "grid", placeItems: "center" }}>
                <span style={hint}>{t("ivus.angioSeries.pick")}</span>
              </div>
            )}
            <div style={row}>
              <button
                type="button"
                style={btn}
                data-testid="ivus-path-clear"
                onClick={() => setPath({ start: null, end: null })}
              >
                {t("ivus.path.clear")}
              </button>
              <span style={hint} data-testid="ivus-path-hint">
                {!path.start
                  ? t("ivus.path.placeStart")
                  : !path.end
                    ? t("ivus.path.placeEnd")
                    : t("ivus.path.done")}
              </span>
            </div>
            {angioIds.length > 1 && (
              <div style={row}>
                <input
                  type="range"
                  min={0}
                  max={angioIds.length - 1}
                  value={angioFrame}
                  data-testid="ivus-angio-frame"
                  onChange={(e) => setAngioFrame(Number(e.target.value))}
                  style={{ flex: 1 }}
                />
                <span style={{ fontSize: 11 }}>
                  {angioFrame + 1}/{angioIds.length}
                </span>
              </div>
            )}
          </div>

          {/* ── 断層 ─────────────────────────────────────────── */}
          <div>
            <div style={sectionTitle}>{t("ivus.pane.tomo")}</div>
            {tomoSlice ? (
              <GreyPane slice={tomoSlice} testId="ivus-tomo-canvas" />
            ) : (
              <div style={paneBox} />
            )}
            <div style={row}>
              <input
                type="range"
                min={0}
                max={Math.max(0, imageIds.length - 1)}
                value={currentFrame}
                data-testid="ivus-tomo-frame"
                onChange={(e) => onGoToFrame?.(Number(e.target.value))}
                style={{ flex: 1 }}
              />
              <span style={{ fontSize: 11 }}>
                {currentFrame + 1}/{imageIds.length}
              </span>
            </div>
            <table style={table}>
              <tbody>
                <tr>
                  <td style={th}>{t("ivus.distance")}</td>
                  <td style={td} data-testid="ivus-distance">
                    {fmt(distanceMm)}
                  </td>
                  <td style={unitCell}>{distanceMm == null ? "" : "mm"}</td>
                </tr>
                <tr>
                  <td style={th}>{t("ivus.pullbackRate")}</td>
                  <td style={td}>{fmt(geometry?.pullbackRateMmPerS ?? null)}</td>
                  <td style={unitCell}>{geometry ? "mm/s" : ""}</td>
                </tr>
                <tr>
                  <td style={th}>{t("ivus.pullbackLength")}</td>
                  <td style={td}>{fmt(geometry?.lengthMm ?? null)}</td>
                  <td style={unitCell}>{geometry ? "mm" : ""}</td>
                </tr>
                <tr>
                  <td style={th}>{t("ivus.pathLength")}</td>
                  <td style={td} data-testid="ivus-path-length">
                    {fmt(pathLengthMm(pullbackPath))}
                  </td>
                  <td style={unitCell}>{pathLengthMm(pullbackPath) == null ? "" : "mm"}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        {/* ── 出せない理由・食い違い ─────────────────────────── */}
        {unavailable && (
          <div style={warn} data-testid="ivus-unavailable">
            {t(`ivus.unavailable.${unavailable}`)}
          </div>
        )}
        {!calibrated && angioIds.length > 0 && (
          <div style={warn} data-testid="ivus-uncalibrated">
            {t("ivus.uncalibrated")}
          </div>
        )}
        {lengthRatio != null && (lengthRatio > 1.25 || lengthRatio < 0.8) && (
          <div style={warn} data-testid="ivus-length-mismatch">
            {t("ivus.lengthMismatch", { ratio: lengthRatio.toFixed(2) })}
          </div>
        )}
        {marker?.clamped && (
          <div style={hint} data-testid="ivus-marker-clamped">
            {t("ivus.markerClamped")}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
          <button type="button" style={btn} onClick={onClose} data-testid="ivus-close">
            {t("common.close")}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function paneView(slice: Slice) {
  const scale = Math.min(PANE_W / slice.width, PANE_H / slice.height);
  return { scale, dw: Math.round(slice.width * scale), dh: Math.round(slice.height * scale) };
}

/** 画素値の範囲で正規化したグレースケール（VOI は持ってこない＝見えればよい）。 */
function drawGrey(canvas: HTMLCanvasElement, slice: Slice): { scale: number } {
  const ctx = canvas.getContext("2d");
  const view = paneView(slice);
  if (!ctx) return { scale: view.scale };
  let min = Infinity;
  let max = -Infinity;
  for (const v of slice.values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const span = max - min || 1;
  const img = ctx.createImageData(slice.width, slice.height);
  for (let i = 0; i < slice.values.length; i++) {
    const g = Math.round(((slice.values[i] - min) / span) * 255);
    img.data[i * 4] = g;
    img.data[i * 4 + 1] = g;
    img.data[i * 4 + 2] = g;
    img.data[i * 4 + 3] = 255;
  }
  const off = document.createElement("canvas");
  off.width = slice.width;
  off.height = slice.height;
  off.getContext("2d")?.putImageData(img, 0, 0);
  canvas.width = view.dw;
  canvas.height = view.dh;
  ctx.clearRect(0, 0, view.dw, view.dh);
  ctx.drawImage(off, 0, 0, view.dw, view.dh);
  return { scale: view.scale };
}

function GreyPane({ slice, testId }: { slice: Slice; testId: string }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    if (ref.current) drawGrey(ref.current, slice);
  }, [slice]);
  return <canvas ref={ref} data-testid={testId} style={paneBox} />;
}

/** アンギオ側。経路の 2 点を置き、現在位置の印を描く。 */
function AngioPane({
  slice,
  path,
  marker,
  onPlace,
  onPickDistance,
  calib,
}: {
  slice: Slice;
  path: PathPoints;
  marker: { x: number; y: number; clamped: boolean } | null;
  onPlace: (p: [number, number]) => void;
  onPickDistance: (mm: number) => void;
  calib: { col: number | null; row: number | null };
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const { scale } = drawGrey(canvas, slice);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    if (path.start && path.end) {
      ctx.strokeStyle = "#6d9be0";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(path.start[0] * scale, path.start[1] * scale);
      ctx.lineTo(path.end[0] * scale, path.end[1] * scale);
      ctx.stroke();
    }
    for (const p of [path.start, path.end]) {
      if (!p) continue;
      ctx.fillStyle = "#6d9be0";
      ctx.beginPath();
      ctx.arc(p[0] * scale, p[1] * scale, 4, 0, Math.PI * 2);
      ctx.fill();
    }
    if (marker) {
      // 現在のプルバック位置。印は経路の色と変える（役割が違うものを同じ色にしない）。
      ctx.fillStyle = marker.clamped ? "#a5642a" : "#e07a5f";
      ctx.beginPath();
      ctx.arc(marker.x * scale, marker.y * scale, 6, 0, Math.PI * 2);
      ctx.fill();
    }
  }, [slice, path, marker]);

  const toImage = (ev: React.MouseEvent): [number, number] | null => {
    const canvas = ref.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return [
      ((ev.clientX - rect.left) / rect.width) * slice.width,
      ((ev.clientY - rect.top) / rect.height) * slice.height,
    ];
  };

  return (
    <canvas
      ref={ref}
      data-testid="ivus-angio-canvas"
      style={{ ...paneBox, cursor: "crosshair" }}
      onClick={(e) => {
        const p = toImage(e);
        if (!p) return;
        // 経路が引けていれば「経路上の最も近い位置へ移動」、まだなら点を置く。
        if (path.start && path.end && calib.col != null && calib.row != null) {
          const ax = path.end[0] - path.start[0];
          const ay = path.end[1] - path.start[1];
          const len2 = ax * ax + ay * ay;
          if (len2 > 0) {
            const tRaw = ((p[0] - path.start[0]) * ax + (p[1] - path.start[1]) * ay) / len2;
            const tt = Math.max(0, Math.min(1, tRaw));
            // 経路の全長 [mm] は非等方の画素ピッチで測る（斜めの経路で潰さない）。
            const fullMm = Math.hypot(ax * calib.col, ay * calib.row);
            onPickDistance(tt * fullMm);
            return;
          }
        }
        onPlace(p);
      }}
    />
  );
}

/* ------------------------------------------------------------------ */

const backdrop: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.5)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
};
const panel: React.CSSProperties = {
  background: "#f4f6f8",
  color: "#22303c",
  borderRadius: 6,
  padding: 16,
  minWidth: 760,
  maxHeight: "90vh",
  display: "flex",
  flexDirection: "column",
  overflowY: "auto",
  boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
};
const panes: React.CSSProperties = { display: "flex", gap: 16, marginTop: 8 };
const paneBox: React.CSSProperties = {
  border: "1px solid #c3ced9",
  display: "block",
  width: PANE_W,
  height: PANE_H,
  background: "#000",
};
const title: React.CSSProperties = { fontWeight: 600, fontSize: 15, marginBottom: 4 };
const sectionTitle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  marginBottom: 4,
  color: "#44586a",
};
const row: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  marginTop: 6,
  flexWrap: "wrap",
};
const label: React.CSSProperties = { display: "flex", alignItems: "center", gap: 4, fontSize: 12 };
const btn: React.CSSProperties = {
  padding: "3px 10px",
  background: "#e6ecf1",
  borderWidth: "1px",
  borderStyle: "solid",
  borderColor: "#c3ced9",
  borderRadius: 4,
  cursor: "pointer",
};
const hint: React.CSSProperties = { fontSize: 11, color: "#66788a" };
const warn: React.CSSProperties = { fontSize: 11, color: "#a5642a", marginTop: 4 };
const errorText: React.CSSProperties = { fontSize: 12, color: "#b3452f", marginBottom: 8 };
const table: React.CSSProperties = { fontSize: 12, borderCollapse: "collapse", marginTop: 6 };
const th: React.CSSProperties = { textAlign: "left", padding: "2px 10px 2px 0", color: "#66788a" };
const td: React.CSSProperties = {
  textAlign: "right",
  padding: "2px 8px 2px 0",
  fontVariantNumeric: "tabular-nums",
};
const unitCell: React.CSSProperties = { fontSize: 11, color: "#66788a", padding: "2px 0" };
