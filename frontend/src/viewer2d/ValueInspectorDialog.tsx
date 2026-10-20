/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 値の点検ダイアログ（第 1 段: ピクセルの時間曲線）。
 *
 * <p>Probe で置いた 1 点を患者座標 mm で持ち、各時相の画像の幾何で画素へ戻して値を読み、T ごとの曲線と表にする。
 * 時相に同じ断面が無い（画像が無い・面外に外れた）ときは値を出さず、別の断面の値で埋めない。
 * 値は校正済みのモダリティ値（SUV 校正中なら SUV）で、状態バーの値と同じ。フレーム長や減衰の補正は掛けない。
 * 点を動かしたら「再取得」を押す（自動追従しない）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { metaData } from "@cornerstonejs/core";
import { useI18n } from "../i18n/i18n";
import { fetchSeriesLayout, type Instance, type Series, type Study } from "../api";
import { imageIdForInstance, type ViewerMode } from "../viewer/imageId";
import { buildLayoutFromDto, buildSeriesLayout, type SeriesLayout } from "../viewer/seriesLayout";
import { readModalitySlice } from "../viewer/pixelCalibration";
import { pixelToWorld, timeCurveAt, type PlaneMeta, type PlaneSlice, type TimePoint } from "../viewer/pixelTimeCurve";
import type { Vec3 } from "../viewer/regTransform";
import type { ViewerRoi } from "../viewer/viewerCommands";
import { formatNumber } from "../viewer/roiStatsText";
import { LineChart } from "./RoiStatsDialog";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObj = Record<string, any>;

/** Cornerstone の imagePlaneModule から画像の幾何を作る。取れなければ null。 */
function planeOf(imageId: string, cols: number, rows: number): PlaneMeta | null {
  const plane: AnyObj = metaData.get("imagePlaneModule", imageId) ?? {};
  const iop = plane.imageOrientationPatient;
  const ipp = plane.imagePositionPatient;
  if (!Array.isArray(iop) || iop.length < 6 || !Array.isArray(ipp) || ipp.length < 3) return null;
  const col = Number(plane.columnPixelSpacing);
  const row = Number(plane.rowPixelSpacing);
  if (!(col > 0 && row > 0)) return null;
  return {
    iop: iop.slice(0, 6).map(Number) as PlaneMeta["iop"],
    ipp: [Number(ipp[0]), Number(ipp[1]), Number(ipp[2])],
    pixelSpacingCol: col,
    pixelSpacingRow: row,
    cols,
    rows,
  };
}

/** 欠損位置を埋めるブランク画像（実画像ではない）。 */
const isBlank = (id: string | undefined) => !id || id.includes("/blank/file");

/** 面外距離の上限 = スライス間隔の半分 [mm]。隣り合う Z の IPP を法線へ投影して求める。分からなければ null。 */
function halfSliceSpacing(layout: SeriesLayout, z: number, sliceThickness: number | null): number | null {
  const n = layout.normal;
  if (layout.nZ > 1 && n && layout.ippAt) {
    const a = layout.ippAt(z);
    const b = layout.ippAt(z + 1 < layout.nZ ? z + 1 : z - 1);
    if (a && b) {
      const d = Math.abs((b[0] - a[0]) * n[0] + (b[1] - a[1]) * n[1] + (b[2] - a[2]) * n[2]);
      if (d > 0) return d / 2;
    }
  }
  return sliceThickness && sliceThickness > 0 ? sliceThickness / 2 : null;
}

const CHART_W = 520;

export function ValueInspectorDialog({
  study,
  series,
  instances,
  mode,
  getProbes,
  onClose,
}: {
  study: Study;
  series: Series;
  instances: Instance[];
  mode: ViewerMode;
  /** このタイルの Probe（点 ROI）を読む。呼ぶたびに現在値。 */
  getProbes: () => ViewerRoi[];
  onClose: () => void;
}) {
  const { t } = useI18n();

  const fallback = useMemo(
    () =>
      buildSeriesLayout(
        instances.map((i) => imageIdForInstance(mode, i.sopInstanceUid, study.studyInstanceUid, series.seriesInstanceUid)),
      ),
    [instances, mode, study.studyInstanceUid, series.seriesInstanceUid],
  );
  const [layout, setLayout] = useState<SeriesLayout>(fallback);
  const [layoutReady, setLayoutReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setLayout(fallback);
    fetchSeriesLayout(study.studyInstanceUid, series.seriesInstanceUid)
      .then((dto) => {
        if (cancelled) return;
        const built = buildLayoutFromDto(dto, mode, study.studyInstanceUid, series.seriesInstanceUid);
        if (built) setLayout(built);
      })
      .catch(() => {
        /* フォールバックのまま */
      })
      .finally(() => {
        if (!cancelled) setLayoutReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [fallback, study.studyInstanceUid, series.seriesInstanceUid, mode]);

  const [probes, setProbes] = useState<ViewerRoi[]>([]);
  const [pick, setPick] = useState(0);
  const [point, setPoint] = useState<{ world: Vec3; x: number; y: number; z: number } | null>(null);
  const [curve, setCurve] = useState<TimePoint[]>([]);
  const [ids, setIds] = useState<string[]>([]);
  const [unit, setUnit] = useState("");
  const [halfSp, setHalfSp] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const token = useRef(0);

  // 親は毎レンダ別の関数を渡すので、ref 経由で呼ぶ（refresh を安定させ、親の再レンダで選択が戻らないようにする）。
  const getProbesRef = useRef(getProbes);
  getProbesRef.current = getProbes;
  const refresh = useCallback(() => {
    const list = getProbesRef.current().filter((r) => r.tool === "Probe" && r.points.length > 0);
    setProbes(list);
    setPick(Math.max(0, list.length - 1)); // 最後に置いた点を既定にする
  }, []);
  useEffect(refresh, [refresh]);

  const probe = probes[Math.min(pick, probes.length - 1)] ?? null;
  const nT = Math.max(1, layout.nT);
  const unsupported = layout.stackAxis === "t";

  // 取得（Probe・レイアウトが決まったとき／「再取得」）。
  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => {
    const my = ++token.current;
    setCurve([]);
    setPoint(null);
    if (!layoutReady || !probe || unsupported) return;
    setBusy(true);
    (async () => {
      const z = probe.sliceIndex;
      const refId = layout.zStack(probe.c, probe.t)[z];
      const ref = refId ? await readModalitySlice(refId) : null;
      const refPlane = ref ? planeOf(refId, ref.width, ref.height) : null;
      if (my !== token.current) return;
      if (!ref || !refPlane) {
        setBusy(false);
        return;
      }
      const [px, py] = probe.points[0];
      const world = pixelToWorld(refPlane, px, py);
      const th = Number((metaData.get("imagePlaneModule", refId) as AnyObj | undefined)?.sliceThickness);
      const half = halfSliceSpacing(layout, z, Number.isFinite(th) ? th : null);
      setPoint({ world, x: px, y: py, z });
      setHalfSp(half);
      setUnit(ref.unit);
      const slices: Array<PlaneSlice | null> = [];
      const used: string[] = [];
      for (let tt = 0; tt < nT; tt++) {
        const id = layout.zStack(probe.c, tt)[z];
        used.push(isBlank(id) ? "" : id);
        let s: PlaneSlice | null = null;
        if (!isBlank(id)) {
          const img = await readModalitySlice(id);
          const plane = img ? planeOf(id, img.width, img.height) : null;
          if (img && plane) s = { plane, values: img.values };
        }
        slices.push(s);
        if (my !== token.current) return;
        setCurve(timeCurveAt(world, slices, half)); // 途中経過も描く
        setIds([...used]);
      }
      setBusy(false);
    })();
    return () => {
      /* 古い取得は token で捨てる */
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutReady, layout, probe, unsupported, nT, reloadKey]);

  const finite = curve.filter((c) => Number.isFinite(c.value));
  // 横軸は表の T と同じ 1 始まり。
  const xs = useMemo(() => Float32Array.from(finite.map((c) => c.t + 1)), [curve]); // eslint-disable-line react-hooks/exhaustive-deps
  const ys = useMemo(() => Float32Array.from(finite.map((c) => c.value)), [curve]); // eslint-disable-line react-hooks/exhaustive-deps

  const copyCsv = () => {
    const lines = ["t,value,unit,outOfPlaneMm,imageId"];
    curve.forEach((c, i) => lines.push([c.t, Number.isFinite(c.value) ? c.value : "", unit, Number.isFinite(c.outOfPlaneMm) ? c.outOfPlaneMm : "", ids[i] ?? ""].join(",")));
    void navigator.clipboard?.writeText(lines.join("\n"));
  };

  return (
    <div style={backdrop}>
      <div style={panel} data-testid="value-inspector">
        <div style={header}>
          <span>{t("vi.title")}</span>
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 11, color: "#8a98a6", fontWeight: 400 }}>{series.seriesDescription || series.seriesInstanceUid}</span>
          <button style={btn} onClick={onClose} data-testid="vi-close">×</button>
        </div>
        <div style={tabs}>
          <span style={tabOn}>{t("vi.tab.time")}</span>
          <span style={{ flex: 1 }} />
          <button style={btn} onClick={() => { refresh(); setReloadKey((k) => k + 1); }} data-testid="vi-refresh">{t("vi.refresh")}</button>
        </div>

        {unsupported ? (
          <div style={msg} data-testid="vi-unsupported">{t("vi.unsupportedAxis")}</div>
        ) : !probe ? (
          <div style={msg} data-testid="vi-no-probe">{t("vi.noProbe")}</div>
        ) : (
          <>
            {probes.length > 1 && (
              <div style={row}>
                <span>{t("vi.probePick")}</span>
                <select value={pick} onChange={(e) => setPick(Number(e.target.value))} data-testid="vi-probe-pick">
                  {probes.map((p, i) => (
                    <option key={p.roiUid} value={i}>{`#${i + 1}  Z ${p.sliceIndex + 1}  T ${p.t + 1}  (${formatNumber(p.points[0][0])}, ${formatNumber(p.points[0][1])})`}</option>
                  ))}
                </select>
              </div>
            )}
            {point && (
              <div style={row} data-testid="vi-point">
                {`LPS ${point.world.map((v) => formatNumber(v)).join(", ")} mm   (col ${formatNumber(point.x)}, row ${formatNumber(point.y)}, Z ${point.z + 1})`}
              </div>
            )}
            <div style={{ padding: "4px 12px" }}>
              {finite.length > 0 ? (
                <LineChart xs={xs} ys={ys} xLabel={`T${layout.tDimension ? ` (${layout.tDimension})` : ""}`} yLabel={unit} />
              ) : (
                <div style={{ ...msg, width: CHART_W }}>{busy ? t("vi.loading") : t("vi.noValues")}</div>
              )}
            </div>
            <div style={tableWrap}>
              <table style={table}>
                <thead>
                  <tr>
                    <th style={th}>T</th>
                    <th style={thNum}>{unit ? `${t("vi.col.value")} [${unit}]` : t("vi.col.value")}</th>
                    <th style={thNum}>{t("vi.col.offPlane")}</th>
                    <th style={th}>{t("vi.col.image")}</th>
                  </tr>
                </thead>
                <tbody>
                  {curve.map((c, i) => (
                    <tr key={c.t} data-testid={`vi-row-${c.t}`}>
                      <td style={td}>{c.t + 1}</td>
                      <td style={tdNum} data-testid={`vi-value-${c.t}`}>{Number.isFinite(c.value) ? formatNumber(c.value) : "—"}</td>
                      <td style={tdNum}>{Number.isFinite(c.outOfPlaneMm) ? c.outOfPlaneMm.toFixed(2) : "—"}</td>
                      <td style={{ ...td, color: "#8a95a1" }}>{shortId(ids[i])}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ ...row, justifyContent: "space-between" }}>
              <span style={{ color: "#8a95a1", lineHeight: 1.5 }}>
                {t("vi.note")}
                {halfSp === null && ` ${t("vi.noSpacing")}`}
              </span>
              <button style={btn} onClick={copyCsv} data-testid="vi-copy-csv">{t("vi.copyCsv")}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function shortId(id: string | undefined): string {
  if (!id) return "—";
  const m = /instances\/([^/?&]+)/.exec(id);
  const frame = /frame=(\d+)/.exec(id);
  const sop = m ? m[1] : id.slice(-24);
  return frame ? `${sop} (frame ${frame[1]})` : sop;
}

// 画像を見ながら Probe を動かして「再取得」できるよう、背景は透明で操作を通す（パネルだけが操作を受ける）。
const backdrop: React.CSSProperties = {
  position: "fixed", inset: 0, zIndex: 1000, pointerEvents: "none",
  display: "flex", alignItems: "flex-start", justifyContent: "flex-end", padding: "64px 24px",
};
const panel: React.CSSProperties = {
  width: 620, maxHeight: "88vh", overflowY: "auto", background: "#fff", borderRadius: 8, pointerEvents: "auto",
  boxShadow: "0 8px 32px rgba(0,0,0,0.25)", fontSize: 12, display: "flex", flexDirection: "column",
};
const header: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 6, padding: "8px 12px", borderBottom: "1px solid #e6eaee", fontWeight: 600,
};
const tabs: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6, padding: "6px 12px", borderBottom: "1px solid #eef1f4" };
const tabOn: React.CSSProperties = { borderBottom: "2px solid #2d7ff9", color: "#0b5cad", padding: "2px 6px", fontWeight: 600 };
const btn: React.CSSProperties = { border: "1px solid #cdd5de", borderRadius: 5, background: "#fff", cursor: "pointer", fontSize: 12, padding: "1px 8px" };
const row: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, padding: "4px 12px", color: "#33404d" };
const msg: React.CSSProperties = { padding: "18px 12px", color: "#5a6672" };
const tableWrap: React.CSSProperties = { maxHeight: 200, overflow: "auto", margin: "0 12px" };
const table: React.CSSProperties = { width: "100%", borderCollapse: "collapse", fontSize: 12 };
const th: React.CSSProperties = { textAlign: "left", padding: "4px 6px", borderBottom: "1px solid #e6eaee", color: "#5a6672", position: "sticky", top: 0, background: "#fff" };
const thNum: React.CSSProperties = { ...th, textAlign: "right" };
const td: React.CSSProperties = { padding: "3px 6px", borderBottom: "1px solid #f1f4f7", whiteSpace: "nowrap" };
const tdNum: React.CSSProperties = { ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" };
