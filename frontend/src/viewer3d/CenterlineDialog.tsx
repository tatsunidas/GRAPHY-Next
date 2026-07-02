/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 中心線解析ダイアログ（`fw/3d-viewer-design.md` §10, §12 P6, §15 #4/#5）。旧 GRAPHY
 * `CenterlineAnalysisDialog` の移植・拡充。選択した 3D ROI / メッシュ / 中心線オブジェクトに対し:
 *
 * - **グラフ抽出**: `extractCenterlineGraph`（骨格化→26 近傍歩行→Douglas-Peucker→prune）。
 *   サマリ（ノード/分枝/端点/分岐点/総長）＋**分枝リスト**を表示。
 * - **分枝/経路選択**: 分枝単体、最長路（グラフ直径）、2 ノード間最短路（Dijkstra）を
 *   `Centerline3D` として取得し、シーンにチューブとして追加（`addCenterlineObject`）。
 * - **CPR（曲面平面再構成）**: アクティブ中心線に沿って `reformat`（`curvedReformat.ts`）でプレビュー、
 *   派生シリーズ（単一フレーム）として保存。
 * - **ストレート化 3D**: `buildStraightenedVolume`（`straightenedVolume.ts`）でまっすぐ伸ばした
 *   ボリュームを生成し、派生シリーズ（積層）として保存。**合成空間のため IPP/IOP は付けない**。
 *
 * 全計算は**患者 LPS mm**、確定サンプリングは 3D ビューア自身の `ResliceVolume`
 * （`resliceVolumeFromCache(volumeId)`）で行う（チルト補正済み volume と幾何整合＝要件 11）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../i18n/i18n";
import { httpSend } from "../http";
import { emitDbChanged } from "../dbEvents";
import { getSceneObject } from "./scene3dStore";
import {
  addCenterlineObject,
  getObjectCenterline,
  getObjectLabelVolume,
  getObjectPolyData,
} from "./scene3d";
import { meshToLabelVolume } from "../viewer/roiMesh";
import type { VolumeGeom } from "../viewer/labelVolume";
import {
  extractCenterlineGraph,
  graphSummary,
  type CenterlineGraph,
} from "../viewer/centerlineGraph";
import { Centerline3D, type FrameMode } from "../viewer/centerline";
import {
  reformat,
  defaultCurvedParams,
  unfoldReformat,
  defaultUnfoldParams,
  type ProjectionMode,
  type CurvedResult,
  type UnfoldResult,
} from "../viewer/curvedReformat";
import {
  buildStraightenedVolume,
  defaultStraightenParams,
  straightenedFrame,
} from "../viewer/straightenedVolume";
import { resliceVolumeFromCache, volumeDefaultVoi } from "../viewer/slicer";
import type { VtkVolumeView } from "../viewer/vtkVolumeView";
import { createGraphOverlay, type GraphOverlay } from "./centerlineAnalysis";

const FRAME_MODES: FrameMode[] = ["FIXED_Z", "ROTATION_MINIMIZING"];
const PROJECTION_MODES: ProjectionMode[] = ["CENTERLINE_ONLY", "AVERAGE", "MIP", "MINIP"];

interface WL {
  center: number;
  width: number;
}

/** Int16Array を Int16LE バイト列とみなして Base64 化。 */
function framePixelsBase64(frame: Int16Array): string {
  const bytes = new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength);
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(bin);
}

function defaultWL(modality: string | null): WL {
  if ((modality ?? "").toUpperCase() === "CT") return { center: 40, width: 400 };
  return { center: 128, width: 256 };
}

export function CenterlineDialog({
  view,
  objectId,
  volumeId,
  geom,
  studyUid,
  seriesUid,
  seriesDesc,
  modality,
  onClose,
}: {
  view: VtkVolumeView;
  objectId: string;
  volumeId: string;
  geom: VolumeGeom | null;
  studyUid: string;
  seriesUid: string;
  seriesDesc: string;
  modality: string | null;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const obj = getSceneObject(objectId);
  const objKind = obj?.kind ?? null;
  const isCenterlineObj = objKind === "centerline";

  // ── グラフ抽出パラメータ ──
  const [epsilon, setEpsilon] = useState(0.5);
  const [pruneMm, setPruneMm] = useState(5);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const graphRef = useRef<CenterlineGraph | null>(null);
  // 全グラフ 3D オーバーレイ（分枝チューブ＋ノード球）。抽出時に生成、アンマウントで破棄。
  const overlayRef = useRef<GraphOverlay | null>(null);
  useEffect(
    () => () => {
      overlayRef.current?.destroy();
      overlayRef.current = null;
    },
    [],
  );
  const [summary, setSummary] = useState<ReturnType<typeof graphSummary> | null>(null);
  const [branchList, setBranchList] = useState<{ id: number; lengthMm: number }[]>([]);
  const [nodeList, setNodeList] = useState<{ id: number; kind: "leaf" | "bifurcation" }[]>([]);

  // ── アクティブ中心線（分枝/最長路/最短路 or 中心線オブジェクト自身）──
  const activeRef = useRef<Centerline3D | null>(null);
  const [activeLabel, setActiveLabel] = useState("");
  const [selBranch, setSelBranch] = useState<number | "">("");
  const [nodeA, setNodeA] = useState<number | "">("");
  const [nodeB, setNodeB] = useState<number | "">("");

  // 中心線オブジェクトから開いた場合は、その中心線を即アクティブに。
  useEffect(() => {
    if (isCenterlineObj) {
      const cl = getObjectCenterline(objectId);
      if (cl && cl.size() >= 2) {
        activeRef.current = cl;
        setActiveLabel(t("centerline.activeFromObject"));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [objectId]);

  const setActive = useCallback((cl: Centerline3D | null, label: string) => {
    activeRef.current = cl && cl.size() >= 2 ? cl : null;
    setActiveLabel(activeRef.current ? label : "");
    // 3D オーバーレイで選択中心線を明るくハイライト。
    overlayRef.current?.setHighlight(
      activeRef.current ? (activeRef.current.getControlPointsSnapshot() as [number, number, number][]) : null,
    );
  }, []);

  // ── グラフ抽出 ──
  const runExtract = useCallback(() => {
    if (isCenterlineObj) return;
    setBusy(true);
    setStatus("");
    setTimeout(() => {
      try {
        let lv = getObjectLabelVolume(objectId);
        if (!lv) {
          const pd = getObjectPolyData(objectId);
          if (pd && geom) lv = meshToLabelVolume(pd, geom);
        }
        if (!lv) {
          setStatus(t("centerline.noVolume"));
          return;
        }
        const g = extractCenterlineGraph(lv, {
          simplifyEpsilonMm: epsilon,
          pruneMinLengthMm: pruneMm,
        });
        if (!g) {
          setStatus(t("centerline.extractFailed"));
          return;
        }
        graphRef.current = g;
        // 全グラフを 3D に重畳（分枝＝暗いシアン / ノード＝端点緑・分岐橙）。
        try {
          overlayRef.current?.destroy();
          const parts = view.getSceneParts();
          overlayRef.current = createGraphOverlay({ renderer: parts.renderer, render: parts.render }, g);
        } catch {
          /* オーバーレイ無しでも解析は継続 */
        }
        setSummary(graphSummary(g));
        const branches = [...g.branches.values()]
          .map((b) => ({ id: b.id, lengthMm: b.lengthMm }))
          .sort((a, b) => b.lengthMm - a.lengthMm);
        setBranchList(branches);
        const leaves = g.getLeafNodes().map((n) => ({ id: n.id, kind: "leaf" as const }));
        const bifs = g.getBranchPointNodes().map((n) => ({ id: n.id, kind: "bifurcation" as const }));
        setNodeList([...leaves, ...bifs].sort((a, b) => a.id - b.id));
        // 既定で最長路をアクティブに。
        const lp = g.longestPath();
        setActive(lp, t("centerline.longestPath"));
        setSelBranch("");
        setNodeA("");
        setNodeB("");
      } catch (e) {
        setStatus(`${t("centerline.error")}: ${String(e)}`);
      } finally {
        setBusy(false);
      }
    }, 16);
  }, [isCenterlineObj, objectId, geom, epsilon, pruneMm, setActive, t, view]);

  const onSelectBranch = useCallback(
    (id: number) => {
      const g = graphRef.current;
      if (!g) return;
      setSelBranch(id);
      setActive(g.extractBranch(id), t("centerline.branchN", { n: String(id) }));
    },
    [setActive, t],
  );

  const onLongest = useCallback(() => {
    const g = graphRef.current;
    if (!g) return;
    setSelBranch("");
    setActive(g.longestPath(), t("centerline.longestPath"));
  }, [setActive, t]);

  const onShortestPath = useCallback(() => {
    const g = graphRef.current;
    if (!g || nodeA === "" || nodeB === "" || nodeA === nodeB) return;
    setSelBranch("");
    setActive(g.extractPath(Number(nodeA), Number(nodeB)), t("centerline.pathAB", { a: String(nodeA), b: String(nodeB) }));
  }, [nodeA, nodeB, setActive, t]);

  const onAddToScene = useCallback(() => {
    const cl = activeRef.current;
    if (!cl) return;
    const id = addCenterlineObject(cl, { name: `${obj?.name ?? "Object"} · ${activeLabel}` });
    if (id) setStatus(t("centerline.added"));
    else setStatus(t("centerline.addFailed"));
  }, [activeLabel, obj?.name, t]);

  // ── CPR プレビュー ──
  const cprCanvasRef = useRef<HTMLCanvasElement>(null);
  const cprResultRef = useRef<CurvedResult | null>(null);
  const [cprFrame, setCprFrame] = useState<FrameMode>("ROTATION_MINIMIZING");
  const [cprProj, setCprProj] = useState<ProjectionMode>("CENTERLINE_ONLY");
  const [cprBand, setCprBand] = useState(0);
  const [cprHalf, setCprHalf] = useState(30);
  const [wl, setWl] = useState<WL>(defaultWL(modality));
  const [cprInfo, setCprInfo] = useState("");
  const [saving, setSaving] = useState(false);

  // ── 展開図（アンフォールド CPR）──
  const ufCanvasRef = useRef<HTMLCanvasElement>(null);
  const ufResultRef = useRef<UnfoldResult | null>(null);
  const [ufFrame, setUfFrame] = useState<FrameMode>("ROTATION_MINIMIZING");
  const [ufProj, setUfProj] = useState<ProjectionMode>("CENTERLINE_ONLY");
  const [ufAngle, setUfAngle] = useState(2);
  const [ufRMin, setUfRMin] = useState(0);
  const [ufRMax, setUfRMax] = useState(10);
  const [ufCount, setUfCount] = useState(8);
  const [ufInfo, setUfInfo] = useState("");

  const drawCpr = useCallback(() => {
    const result = cprResultRef.current;
    const canvas = cprCanvasRef.current;
    if (!result || !canvas) return;
    const lower = wl.center - wl.width / 2;
    const range = Math.max(1e-6, wl.width);
    const img = new ImageData(result.width, result.height);
    for (let i = 0; i < result.pixels.length; i++) {
      let v = (result.pixels[i] - lower) / range;
      v = v < 0 ? 0 : v > 1 ? 1 : v;
      const g = Math.round(v * 255);
      const o = i * 4;
      img.data[o] = g;
      img.data[o + 1] = g;
      img.data[o + 2] = g;
      img.data[o + 3] = 255;
    }
    canvas.width = result.width;
    canvas.height = result.height;
    canvas.getContext("2d")?.putImageData(img, 0, 0);
  }, [wl]);

  const runCpr = useCallback(() => {
    const cl = activeRef.current;
    if (!cl) {
      setCprInfo(t("centerline.needActive"));
      return;
    }
    const vol = resliceVolumeFromCache(volumeId);
    if (!vol) {
      setCprInfo(t("centerline.noVolume"));
      return;
    }
    const inPlane = (vol.spacing[0] + vol.spacing[1]) / 2;
    const step = Math.max(0.1, inPlane);
    const cp = defaultCurvedParams();
    cp.arcStepMm = step;
    cp.secondAxisStepMm = step;
    cp.secondAxisMinMm = -cprHalf;
    cp.secondAxisMaxMm = cprHalf;
    cp.frameMode = cprFrame;
    cp.projectionMode = cprProj;
    cp.bandHalfWidthMm = cprBand;
    cp.bandSampleCount = 9;
    cp.outOfBoundsValue = vol.airValue ?? 0;
    try {
      const result = reformat(cl, vol, cp);
      cprResultRef.current = result;
      setCprInfo(t("centerline.cprInfo", { w: String(result.width), h: String(result.height), px: step.toFixed(2) }));
      requestAnimationFrame(drawCpr);
    } catch (e) {
      setCprInfo(`${t("centerline.error")}: ${String(e)}`);
    }
  }, [volumeId, cprFrame, cprProj, cprBand, cprHalf, drawCpr, t]);

  // W/L 変更 → 階調のみ再描画。
  useEffect(() => {
    if (cprResultRef.current) drawCpr();
  }, [wl, drawCpr]);

  // ── 展開図（アンフォールド CPR）描画・実行・保存 ──
  const drawUnfold = useCallback(() => {
    const result = ufResultRef.current;
    const canvas = ufCanvasRef.current;
    if (!result || !canvas) return;
    const lower = wl.center - wl.width / 2;
    const range = Math.max(1e-6, wl.width);
    const img = new ImageData(result.width, result.height);
    for (let i = 0; i < result.pixels.length; i++) {
      let v = (result.pixels[i] - lower) / range;
      v = v < 0 ? 0 : v > 1 ? 1 : v;
      const g = Math.round(v * 255);
      const o = i * 4;
      img.data[o] = g;
      img.data[o + 1] = g;
      img.data[o + 2] = g;
      img.data[o + 3] = 255;
    }
    canvas.width = result.width;
    canvas.height = result.height;
    canvas.getContext("2d")?.putImageData(img, 0, 0);
  }, [wl]);

  const runUnfold = useCallback(() => {
    const cl = activeRef.current;
    if (!cl) {
      setUfInfo(t("centerline.needActive"));
      return;
    }
    const vol = resliceVolumeFromCache(volumeId);
    if (!vol) {
      setUfInfo(t("centerline.noVolume"));
      return;
    }
    const inPlane = (vol.spacing[0] + vol.spacing[1]) / 2;
    const p = defaultUnfoldParams();
    p.arcStepMm = Math.max(0.1, inPlane);
    p.angleStepDeg = ufAngle;
    p.frameMode = ufFrame;
    p.radialMinMm = ufRMin;
    p.radialMaxMm = ufRMax;
    p.radialSampleCount = ufCount;
    p.projectionMode = ufProj;
    p.outOfBoundsValue = vol.airValue ?? 0;
    try {
      const result = unfoldReformat(cl, vol, p);
      ufResultRef.current = result;
      setUfInfo(t("centerline.unfoldInfo", { w: String(result.width), h: String(result.height), deg: ufAngle.toFixed(1) }));
      requestAnimationFrame(drawUnfold);
    } catch (e) {
      setUfInfo(`${t("centerline.error")}: ${String(e)}`);
    }
  }, [volumeId, ufAngle, ufFrame, ufRMin, ufRMax, ufCount, ufProj, drawUnfold, t]);

  useEffect(() => {
    if (ufResultRef.current) drawUnfold();
  }, [wl, drawUnfold]);

  const onSaveUnfold = useCallback(async () => {
    const result = ufResultRef.current;
    if (!result || saving) return;
    setSaving(true);
    setStatus("");
    try {
      const n = result.width * result.height;
      const frame = new Int16Array(n);
      for (let i = 0; i < n; i++) {
        let v = Math.round(result.pixels[i]);
        if (v < -32768) v = -32768;
        else if (v > 32767) v = 32767;
        frame[i] = v;
      }
      const res = await httpSend<{ seriesInstanceUid: string; sopInstanceUids: string[] }>(
        "/api/series/derived",
        "POST",
        {
          studyInstanceUid: studyUid,
          seriesInstanceUid: seriesUid,
          seriesDescription: `${seriesDesc || "Series"} Unfolded CPR`,
          seriesNumber: null,
          rows: result.height,
          columns: result.width,
          pixelSpacing: [result.pixelSpacingY, result.pixelSpacingX],
          sliceThickness: ufRMax > ufRMin ? ufRMax - ufRMin : 0,
          spacingBetweenSlices: 0,
          // 展開図は合成空間（角度×弧長）のため患者座標を付けない。
          imageOrientationPatient: null,
          derivationDescription: `Unfolded CPR from 3D centerline (${ufFrame}, r=[${ufRMin},${ufRMax}]mm, ${ufProj})`,
          frames: [{ instanceNumber: 1, imagePositionPatient: null, pixels: framePixelsBase64(frame) }],
        },
      );
      emitDbChanged({ reason: "series-create", studyUids: [studyUid] });
      setStatus(t("centerline.saved", { n: String(res.sopInstanceUids.length) }));
    } catch (e) {
      setStatus(`${t("centerline.saveFailed")}: ${String(e)}`);
      // eslint-disable-next-line no-console
      console.error("[centerline] unfold save failed:", e);
    } finally {
      setSaving(false);
    }
  }, [saving, studyUid, seriesUid, seriesDesc, ufRMax, ufRMin, ufFrame, ufProj, t]);

  const onSaveCpr = useCallback(async () => {
    const result = cprResultRef.current;
    if (!result || saving) return;
    setSaving(true);
    setStatus("");
    try {
      const n = result.width * result.height;
      const frame = new Int16Array(n);
      for (let i = 0; i < n; i++) {
        let v = Math.round(result.pixels[i]);
        if (v < -32768) v = -32768;
        else if (v > 32767) v = 32767;
        frame[i] = v;
      }
      const res = await httpSend<{ seriesInstanceUid: string; sopInstanceUids: string[] }>(
        "/api/series/derived",
        "POST",
        {
          studyInstanceUid: studyUid,
          seriesInstanceUid: seriesUid,
          seriesDescription: `${seriesDesc || "Series"} CPR`,
          seriesNumber: null,
          rows: result.height,
          columns: result.width,
          pixelSpacing: [result.pixelSpacingY, result.pixelSpacingX],
          sliceThickness: cprBand > 0 ? 2 * cprBand : 0,
          spacingBetweenSlices: 0,
          imageOrientationPatient: null,
          derivationDescription: `Curved MPR from 3D centerline (${cprFrame}, ${cprProj}, band=${cprBand}mm)`,
          frames: [{ instanceNumber: 1, imagePositionPatient: null, pixels: framePixelsBase64(frame) }],
        },
      );
      emitDbChanged({ reason: "series-create", studyUids: [studyUid] });
      setStatus(t("centerline.saved", { n: String(res.sopInstanceUids.length) }));
    } catch (e) {
      setStatus(`${t("centerline.saveFailed")}: ${String(e)}`);
      // eslint-disable-next-line no-console
      console.error("[centerline] CPR save failed:", e);
    } finally {
      setSaving(false);
    }
  }, [saving, studyUid, seriesUid, seriesDesc, cprBand, cprFrame, cprProj, t]);

  // ── ストレート化 3D ──
  const [stArc, setStArc] = useState(1);
  const [stCross, setStCross] = useState(0.5);
  const [stHalf, setStHalf] = useState(20);
  const [stFrame, setStFrame] = useState<FrameMode>("ROTATION_MINIMIZING");

  const onSaveStraighten = useCallback(async () => {
    const cl = activeRef.current;
    if (!cl || saving) {
      if (!cl) setStatus(t("centerline.needActive"));
      return;
    }
    const vol = resliceVolumeFromCache(volumeId);
    if (!vol) {
      setStatus(t("centerline.noVolume"));
      return;
    }
    setSaving(true);
    setStatus(t("centerline.straightening"));
    try {
      const p = defaultStraightenParams();
      p.arcStepMm = stArc;
      p.crossStepMm = stCross;
      p.crossHalfWidthMm = stHalf;
      p.frameMode = stFrame;
      p.outOfBoundsValue = vol.airValue ?? 0;
      const result = buildStraightenedVolume(cl, vol, p);
      const frames = [];
      for (let k = 0; k < result.depth; k++) {
        frames.push({
          instanceNumber: k + 1,
          imagePositionPatient: null,
          pixels: framePixelsBase64(straightenedFrame(result, k)),
        });
      }
      const res = await httpSend<{ seriesInstanceUid: string; sopInstanceUids: string[] }>(
        "/api/series/derived",
        "POST",
        {
          studyInstanceUid: studyUid,
          seriesInstanceUid: seriesUid,
          seriesDescription: `${seriesDesc || "Series"} Straightened`,
          seriesNumber: null,
          rows: result.height,
          columns: result.width,
          pixelSpacing: result.pixelSpacing,
          sliceThickness: result.sliceSpacingMm,
          spacingBetweenSlices: result.sliceSpacingMm,
          // 合成空間のため患者座標を付けない（設計 §10）。
          imageOrientationPatient: null,
          derivationDescription: `Straightened CPR from 3D centerline (${stFrame}, len=${result.lengthMm.toFixed(0)}mm)`,
          frames,
        },
      );
      emitDbChanged({ reason: "series-create", studyUids: [studyUid] });
      setStatus(t("centerline.straightenedSaved", { n: String(res.sopInstanceUids.length) }));
    } catch (e) {
      setStatus(`${t("centerline.saveFailed")}: ${String(e)}`);
      // eslint-disable-next-line no-console
      console.error("[centerline] straighten save failed:", e);
    } finally {
      setSaving(false);
    }
  }, [saving, volumeId, stArc, stCross, stHalf, stFrame, studyUid, seriesUid, seriesDesc, t]);

  // W/L 既定を volume の VOI から補正（一度だけ）。
  useEffect(() => {
    const voi = volumeDefaultVoi(volumeId);
    if (voi) setWl(voi);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [volumeId]);

  const hasGraph = !!summary;
  const hasActive = !!activeRef.current;
  void hasActive; // activeLabel の有無で UI を制御するため参照のみ

  const branchLabel = useMemo(
    () => (id: number, len: number) => t("centerline.branchItem", { n: String(id), mm: len.toFixed(1) }),
    [t],
  );

  return (
    <div style={overlay}>
      <div style={dialog}>
        <div style={header}>
          <span style={hTitle}>{t("centerline.title")}</span>
          <span style={hSub}>{obj?.name ?? objectId}</span>
          <div style={{ flex: 1 }} />
          <button style={closeBtn} onClick={onClose}>
            ✕
          </button>
        </div>

        <div style={body}>
          {/* 抽出（ROI/メッシュのみ） */}
          {!isCenterlineObj && (
            <section style={section}>
              <div style={sectionTitle}>{t("centerline.extractTitle")}</div>
              <div style={row}>
                <NumField label={t("centerline.simplify")} value={epsilon} step={0.1} min={0} onCommit={setEpsilon} unit="mm" />
                <NumField label={t("centerline.prune")} value={pruneMm} step={0.5} min={0} onCommit={setPruneMm} unit="mm" />
                <button style={busy ? btnDisabled : primaryBtn} disabled={busy} onClick={runExtract}>
                  {busy ? t("centerline.working") : t("centerline.extract")}
                </button>
              </div>
              {summary && (
                <div style={summaryBox}>
                  {t("centerline.summary", {
                    branches: String(summary.branches),
                    leaves: String(summary.leaves),
                    bifs: String(summary.bifurcations),
                    mm: summary.totalMm.toFixed(0),
                  })}
                </div>
              )}
            </section>
          )}

          {/* 分枝/経路選択 */}
          {hasGraph && (
            <section style={section}>
              <div style={sectionTitle}>{t("centerline.selectTitle")}</div>
              <div style={row}>
                <button style={miniBtn} onClick={onLongest}>
                  {t("centerline.longestPath")}
                </button>
              </div>
              <div style={row}>
                <span style={fieldLabel}>{t("centerline.branches")}</span>
                <select
                  style={select}
                  value={selBranch}
                  onChange={(e) => onSelectBranch(Number(e.target.value))}
                >
                  <option value="">—</option>
                  {branchList.map((b) => (
                    <option key={b.id} value={b.id}>
                      {branchLabel(b.id, b.lengthMm)}
                    </option>
                  ))}
                </select>
              </div>
              <div style={row}>
                <span style={fieldLabel}>{t("centerline.shortestPath")}</span>
                <select style={selectSm} value={nodeA} onChange={(e) => setNodeA(e.target.value === "" ? "" : Number(e.target.value))}>
                  <option value="">A</option>
                  {nodeList.map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.id}{n.kind === "leaf" ? "◦" : "◆"}
                    </option>
                  ))}
                </select>
                <select style={selectSm} value={nodeB} onChange={(e) => setNodeB(e.target.value === "" ? "" : Number(e.target.value))}>
                  <option value="">B</option>
                  {nodeList.map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.id}{n.kind === "leaf" ? "◦" : "◆"}
                    </option>
                  ))}
                </select>
                <button style={miniBtn} onClick={onShortestPath}>
                  {t("centerline.compute")}
                </button>
              </div>
            </section>
          )}

          {/* アクティブ中心線 */}
          <section style={section}>
            <div style={sectionTitle}>{t("centerline.activeTitle")}</div>
            <div style={row}>
              <span style={activeLabel ? activeChip : activeChipEmpty}>
                {activeLabel || t("centerline.noneActive")}
              </span>
              <button style={activeLabel ? miniBtn : btnDisabled} disabled={!activeLabel} onClick={onAddToScene}>
                {t("centerline.addToScene")}
              </button>
            </div>
          </section>

          {/* CPR */}
          <section style={section}>
            <div style={sectionTitle}>{t("centerline.cprTitle")}</div>
            <div style={rowWrap}>
              <SelField label={t("centerline.frameMode")} value={cprFrame} options={FRAME_MODES} render={(m) => t(`curvedMpr.frame.${m}`)} onChange={setCprFrame} />
              <SelField label={t("centerline.projection")} value={cprProj} options={PROJECTION_MODES} render={(m) => t(`curvedMpr.proj.${m}`)} onChange={setCprProj} />
              <NumField label={t("centerline.band")} value={cprBand} step={0.5} min={0} onCommit={setCprBand} unit="mm" />
              <NumField label={t("centerline.halfWidth")} value={cprHalf} step={1} min={1} onCommit={setCprHalf} unit="mm" />
            </div>
            <div style={rowWrap}>
              <NumField label="WL C" value={wl.center} step={1} min={-10000} onCommit={(v) => setWl((w) => ({ ...w, center: v }))} />
              <NumField label="WL W" value={wl.width} step={1} min={1} onCommit={(v) => setWl((w) => ({ ...w, width: v }))} />
              <button style={activeLabel ? primaryBtn : btnDisabled} disabled={!activeLabel} onClick={runCpr}>
                {t("centerline.preview")}
              </button>
              <button
                style={cprResultRef.current && !saving ? genBtn : btnDisabled}
                disabled={!cprResultRef.current || saving}
                onClick={onSaveCpr}
              >
                {saving ? t("centerline.saving") : t("centerline.saveCpr")}
              </button>
            </div>
            {cprInfo && <div style={infoLine}>{cprInfo}</div>}
            <div style={cprPreviewWrap}>
              <canvas ref={cprCanvasRef} style={cprPreview} />
            </div>
          </section>

          {/* 展開図（アンフォールド CPR） */}
          <section style={section}>
            <div style={sectionTitle}>{t("centerline.unfoldTitle")}</div>
            <div style={rowWrap}>
              <SelField label={t("centerline.frameMode")} value={ufFrame} options={FRAME_MODES} render={(m) => t(`curvedMpr.frame.${m}`)} onChange={setUfFrame} />
              <NumField label={t("centerline.angleStep")} value={ufAngle} step={0.5} min={0.2} onCommit={setUfAngle} unit="°" />
              <NumField label={t("centerline.radiusMin")} value={ufRMin} step={0.5} min={0} onCommit={setUfRMin} unit="mm" />
              <NumField label={t("centerline.radiusMax")} value={ufRMax} step={0.5} min={0.1} onCommit={setUfRMax} unit="mm" />
            </div>
            <div style={rowWrap}>
              <SelField label={t("centerline.projection")} value={ufProj} options={PROJECTION_MODES} render={(m) => t(`curvedMpr.proj.${m}`)} onChange={setUfProj} />
              <NumField label={t("centerline.radialCount")} value={ufCount} step={1} min={2} onCommit={(v) => setUfCount(Math.round(v))} />
              <button style={activeLabel ? primaryBtn : btnDisabled} disabled={!activeLabel} onClick={runUnfold}>
                {t("centerline.preview")}
              </button>
              <button
                style={ufResultRef.current && !saving ? genBtn : btnDisabled}
                disabled={!ufResultRef.current || saving}
                onClick={onSaveUnfold}
              >
                {saving ? t("centerline.saving") : t("centerline.saveUnfold")}
              </button>
            </div>
            {ufInfo && <div style={infoLine}>{ufInfo}</div>}
            <div style={noteLine}>{t("centerline.unfoldNote")}</div>
            <div style={cprPreviewWrap}>
              <canvas ref={ufCanvasRef} style={cprPreview} />
            </div>
          </section>

          {/* ストレート化 3D */}
          <section style={section}>
            <div style={sectionTitle}>{t("centerline.straightenTitle")}</div>
            <div style={rowWrap}>
              <SelField label={t("centerline.frameMode")} value={stFrame} options={FRAME_MODES} render={(m) => t(`curvedMpr.frame.${m}`)} onChange={setStFrame} />
              <NumField label={t("centerline.arcStep")} value={stArc} step={0.5} min={0.1} onCommit={setStArc} unit="mm" />
              <NumField label={t("centerline.crossStep")} value={stCross} step={0.1} min={0.1} onCommit={setStCross} unit="mm" />
              <NumField label={t("centerline.halfWidth")} value={stHalf} step={1} min={1} onCommit={setStHalf} unit="mm" />
              <button
                style={activeLabel && !saving ? genBtn : btnDisabled}
                disabled={!activeLabel || saving}
                onClick={onSaveStraighten}
              >
                {saving ? t("centerline.saving") : t("centerline.saveStraighten")}
              </button>
            </div>
            <div style={noteLine}>{t("centerline.straightenNote")}</div>
          </section>

          {status && <div style={statusLine}>{status}</div>}
        </div>
      </div>
    </div>
  );
}

// ── 小コンポーネント ──────────────────────────────────────────
function NumField({
  label,
  value,
  step,
  min,
  unit,
  onCommit,
}: {
  label: string;
  value: number;
  step?: number;
  min: number;
  unit?: string;
  onCommit: (v: number) => void;
}) {
  const [text, setText] = useState(String(value));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(String(value));
  }, [value]);
  return (
    <label style={fieldWrap}>
      <span style={fieldLabel}>{label}</span>
      <input
        type="number"
        style={input}
        value={text}
        step={step ?? 1}
        min={min}
        onFocus={() => (focused.current = true)}
        onChange={(e) => {
          setText(e.target.value);
          const v = parseFloat(e.target.value);
          if (Number.isFinite(v)) onCommit(v);
        }}
        onBlur={() => {
          focused.current = false;
          let v = parseFloat(text);
          if (!Number.isFinite(v)) v = value;
          v = Math.max(min, v);
          onCommit(v);
          setText(String(v));
        }}
      />
      {unit && <span style={fieldUnit}>{unit}</span>}
    </label>
  );
}

function SelField<T extends string>({
  label,
  value,
  options,
  render,
  onChange,
}: {
  label: string;
  value: T;
  options: T[];
  render: (v: T) => string;
  onChange: (v: T) => void;
}) {
  return (
    <label style={fieldWrap}>
      <span style={fieldLabel}>{label}</span>
      <select style={select} value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((o) => (
          <option key={o} value={o}>
            {render(o)}
          </option>
        ))}
      </select>
    </label>
  );
}

// ── styles ────────────────────────────────────────────────────
const overlay: React.CSSProperties = { position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "flex-start", justifyContent: "center", zIndex: 60, paddingTop: 40 };
const dialog: React.CSSProperties = { width: 460, maxWidth: "94vw", maxHeight: "88vh", display: "flex", flexDirection: "column", background: "#14181c", color: "#e6eaee", border: "1px solid #2c343b", borderRadius: 10, boxShadow: "0 8px 32px rgba(0,0,0,0.5)", fontFamily: "system-ui, sans-serif", fontSize: 12 };
const header: React.CSSProperties = { display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", borderBottom: "1px solid #23292f" };
const hTitle: React.CSSProperties = { fontWeight: 600, fontSize: 13 };
const hSub: React.CSSProperties = { color: "#9aa6b2", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 200 };
const closeBtn: React.CSSProperties = { background: "transparent", color: "#9aa6b2", border: "none", fontSize: 15, cursor: "pointer" };
const body: React.CSSProperties = { padding: "6px 12px 12px", overflowY: "auto" };
const section: React.CSSProperties = { padding: "8px 0", borderBottom: "1px solid #1e242a" };
const sectionTitle: React.CSSProperties = { fontWeight: 600, color: "#cdd6df", marginBottom: 6 };
const row: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, marginBottom: 4, flexWrap: "wrap" };
const rowWrap: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, marginBottom: 6, flexWrap: "wrap" };
const fieldWrap: React.CSSProperties = { display: "flex", alignItems: "center", gap: 4 };
const fieldLabel: React.CSSProperties = { color: "#9aa6b2" };
const fieldUnit: React.CSSProperties = { color: "#7f8b96" };
const input: React.CSSProperties = { width: 62, background: "#1b2126", color: "#e6eaee", border: "1px solid #2c343b", borderRadius: 5, fontSize: 12, padding: "2px 6px" };
const select: React.CSSProperties = { background: "#1b2126", color: "#e6eaee", border: "1px solid #2c343b", borderRadius: 5, fontSize: 12, padding: "2px 6px" };
const selectSm: React.CSSProperties = { ...select, width: 60 };
const summaryBox: React.CSSProperties = { color: "#9fd3ff", fontSize: 11, marginTop: 2 };
const primaryBtn: React.CSSProperties = { background: "#0b5cad", color: "#fff", border: "none", borderRadius: 5, fontSize: 12, padding: "4px 12px", cursor: "pointer" };
const genBtn: React.CSSProperties = { background: "#1c7a45", color: "#fff", border: "none", borderRadius: 5, fontSize: 12, padding: "4px 12px", cursor: "pointer" };
const miniBtn: React.CSSProperties = { background: "#26303a", color: "#e6eaee", border: "1px solid #33404b", borderRadius: 5, fontSize: 12, padding: "3px 10px", cursor: "pointer" };
const btnDisabled: React.CSSProperties = { background: "#2c343b", color: "#7f8b96", border: "1px solid #2c343b", borderRadius: 5, fontSize: 12, padding: "4px 12px", cursor: "not-allowed" };
const activeChip: React.CSSProperties = { color: "#8fe0b0", border: "1px solid #2a5a42", background: "#0f2a1e", borderRadius: 4, padding: "2px 8px", flex: 1 };
const activeChipEmpty: React.CSSProperties = { color: "#7f8b96", border: "1px dashed #33404b", borderRadius: 4, padding: "2px 8px", flex: 1 };
const infoLine: React.CSSProperties = { color: "#9aa6b2", fontSize: 11, margin: "2px 0" };
const noteLine: React.CSSProperties = { color: "#c99", fontSize: 11 };
const statusLine: React.CSSProperties = { color: "#ffe08a", fontSize: 11, marginTop: 8 };
const cprPreviewWrap: React.CSSProperties = { marginTop: 6, maxHeight: 220, overflow: "auto", background: "#000", display: "flex", justifyContent: "center", borderRadius: 6 };
const cprPreview: React.CSSProperties = { imageRendering: "pixelated", maxWidth: "100%" };
