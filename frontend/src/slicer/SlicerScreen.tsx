/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * Slicer ウィンドウ（P2 改3 = world 自前描画版）。2×2 レイアウト:
 *   左上=Axial / 右上=Coronal / 左下=Sagittal / 右下=再構成スタック。
 *
 * **3 面（AX/COR/SAG）は cornerstone を使わず world(LPS mm) 座標で自前リスライス描画する**（`viewer/orthoMpr.ts`）。
 * 各面は患者軸の直交平面で、表示スライスは常にスラブ中心 `center` の深さを通す（3 面のオーバーレイ中心が
 * 原理的に一致）。スラブ（各出力スライスの立方体）を各面にバンド投影し、**中央ハンドル/背景左ドラッグ=平行移動 /
 * 四隅ハンドル=回転 / 右ドラッグ=W/L / ホイール=面法線方向にスクロール** で操作する。
 * cornerstone は **再構成スタック（右下）表示専用**（`setupReconViewport`）。
 * CT はガントリチルトを起動時に自動補正（`buildMprVolume`）。
 *
 * 起動: `localStorage("graphy-slicer-ctx")` 経由。幾何/描画は `viewer/orthoMpr.ts`・`viewer/slicer.ts`、確定リスライスは `viewer/reslice.ts`。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { RenderingEngine } from "@cornerstonejs/core";
import { fetchSeries, fetchInstances, fetchSeriesLayout, prefetchSeries, type AppStatus, type Study, type Series, type SeriesLayoutDto } from "../api";
import { ensureCornerstoneInitialized } from "../viewer/cornerstoneSetup";
import { imageIdForInstance, imageIdForCell } from "../viewer/imageId";
import {
  teardownSlicer,
  displayReconStack,
  planeFromGeometry,
  buildMprVolume,
  resliceVolumeFromCache,
  setupReconViewport,
  volumeDefaultVoi,
  geometryToAngles,
  anglesToGeometry,
  type SlicerGeometry,
} from "../viewer/slicer";
import {
  ORTHO_AXES,
  computePanelLayout,
  renderPanelSlice,
  computeSlabBandsPanel,
  computeSlabHandlesPanel,
  translateGeomInPlanePanel,
  rotateGeomInPlanePanel,
  worldToVoxel,
  voxelToWorld,
  volumeCenterWorld,
  type OrthoAxis,
  type PanelLayout,
  type PanelPolygon,
  type SlabHandlesPanel,
} from "../viewer/orthoMpr";
import { createReslicer, type ReconMode, type Interpolation, type Vec3, type ResliceVolume } from "../viewer/reslice";
import { fetchSettings } from "../settings/settingsApi";
import { httpSend } from "../http";
import { emitDbChanged } from "../dbEvents";
import { useI18n } from "../i18n/i18n";

const ENGINE_ID = "graphy-slicer-engine";
const TOOL_GROUP_ID = "graphy-slicer-tg";
const RECON_VP = "slicer-recon";

const RECON_MODES: ReconMode[] = ["SLICECUT", "MEAN", "MAX", "MIN", "MEDIAN", "MODE"];

const AXIS_COLOR: Record<OrthoAxis, string> = { axial: "#00dc00", coronal: "#00a0ff", sagittal: "#dcdc00" };

interface SlicerContext {
  study: Study;
  series?: Series;
  /** マルチC/T シリーズをソースにする場合の表示中インデックス（任意）。無ければ 0。 */
  c?: number;
  t?: number;
  ts: number;
}

/** レイアウトから (c,t) 固定の単一 Z スタックの imageIds を取り出す（z 昇順、モザイク/多フレーム対応）。 */
function imageIdsForCT(
  layout: SeriesLayoutDto,
  mode: "standalone" | "web",
  c: number,
  t: number,
  studyUid: string,
  seriesUid: string,
): string[] {
  return layout.cells
    .filter((cell) => cell.c === c && cell.t === t)
    .slice()
    .sort((a, b) => a.z - b.z)
    .map((cell) => imageIdForCell(mode, cell.sopInstanceUid, cell.frame, studyUid, seriesUid));
}
type Phase = "idle" | "loading" | "ready" | "error" | "unsupported";

interface SlabParams {
  fovWidth: number;
  fovHeight: number;
  thickness: number;
  gap: number;
  numSlices: number;
  mode: ReconMode;
}
const DEFAULT_SLAB: SlabParams = { fovWidth: 200, fovHeight: 200, thickness: 3, gap: 0, numSlices: 20, mode: "SLICECUT" };

interface Wl {
  center: number;
  width: number;
}
interface Progress {
  active: boolean;
  done: number;
  total: number;
}
type DragKind = "move" | "rotate" | "wl";
interface DragState {
  kind: DragKind;
  axis: OrthoAxis;
  rect: DOMRect;
  lastPanel: [number, number];
  lastClient: [number, number];
}

/** 直近の再構成結果（canonical 正順）。保存時に reverse を適用して並び替える。 */
interface GenResult {
  framesCanon: Int16Array[];
  ippsCanon: Vec3[];
  rows: number;
  cols: number;
  rowDir: Vec3;
  colDir: Vec3;
  pixelSpacing: [number, number]; // DICOM [row, col]
  sliceThickness: number;
  spacingBetweenSlices: number;
}

/** Int16Array を Int16LE のバイト列とみなして Base64 化（ブラウザは LE 前提）。 */
function framePixelsBase64(frame: Int16Array): string {
  const bytes = new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength);
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(bin);
}

const raf = () => new Promise<void>((res) => requestAnimationFrame(() => res()));
const crossVec = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalizeVec = (a: Vec3): Vec3 => {
  const n = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / n, a[1] / n, a[2] / n];
};

/** 患者軸整列の基準幾何（回転 0°）: rowDir=+X, colDir=+Y, normal=+Z。center はボリューム中心。 */
function baseGeometry(vol: ResliceVolume): SlicerGeometry {
  return { center: volumeCenterWorld(vol), rowDir: [1, 0, 0], colDir: [0, 1, 0], normal: [0, 0, 1] };
}

/** voiLut が無い場合の既定 W/L をデータ範囲から推定（air を含むが右ドラッグで調整可）。 */
function dataRangeVoi(vol: ResliceVolume): Wl {
  const d = vol.data;
  let mn = Infinity;
  let mx = -Infinity;
  const step = Math.max(1, Math.floor(d.length / 200000));
  for (let i = 0; i < d.length; i += step) {
    const v = d[i];
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  if (!Number.isFinite(mn)) {
    mn = 0;
    mx = 1;
  }
  return { center: (mn + mx) / 2, width: Math.max(1, mx - mn) };
}

export function SlicerScreen({ status }: { status: AppStatus | null }) {
  const { t } = useI18n();
  // 3 面: セル(letterbox 計算用)・canvas(自前描画)。recon のみ cornerstone。
  const cellRefs: Record<OrthoAxis, React.RefObject<HTMLDivElement>> = {
    axial: useRef<HTMLDivElement>(null),
    coronal: useRef<HTMLDivElement>(null),
    sagittal: useRef<HTMLDivElement>(null),
  };
  const canvasRefs: Record<OrthoAxis, React.RefObject<HTMLCanvasElement>> = {
    axial: useRef<HTMLCanvasElement>(null),
    coronal: useRef<HTMLCanvasElement>(null),
    sagittal: useRef<HTMLCanvasElement>(null),
  };
  const reconRef = useRef<HTMLDivElement>(null);

  const engineRef = useRef<RenderingEngine | null>(null);
  const startedRef = useRef(false);
  const volRef = useRef<ResliceVolume | null>(null);
  const layoutsRef = useRef<Record<OrthoAxis, PanelLayout> | null>(null);
  const geomRef = useRef<SlicerGeometry | null>(null);
  const baseRef = useRef<SlicerGeometry | null>(null); // 回転角の基準フレーム
  const wlRef = useRef<Wl>({ center: 40, width: 400 });
  const slabRef = useRef<SlabParams>(DEFAULT_SLAB);
  const dragRef = useRef<DragState | null>(null);
  const renderPendingRef = useRef(false);
  const reconSeqRef = useRef(0);
  const srcStudyRef = useRef<string>("");
  const srcSeriesRef = useRef<string>("");
  const srcDescRef = useRef<string>("");
  const genResultRef = useRef<GenResult | null>(null);
  const layoutRef = useRef<SeriesLayoutDto | null>(null);
  const modalityRef = useRef<string | null>(null);

  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState("");
  const [title, setTitle] = useState("");
  const [tilt, setTilt] = useState<number | null>(null);
  const [slab, setSlab] = useState<SlabParams>(DEFAULT_SLAB);
  const [geom, setGeom] = useState<SlicerGeometry | null>(null);
  const [wl, setWl] = useState<Wl>({ center: 40, width: 400 });
  const [layouts, setLayouts] = useState<Record<OrthoAxis, PanelLayout> | null>(null);
  const [bands, setBands] = useState<Record<OrthoAxis, PanelPolygon[]>>({ axial: [], coronal: [], sagittal: [] });
  const [handles, setHandles] = useState<Record<OrthoAxis, SlabHandlesPanel | null>>({ axial: null, coronal: null, sagittal: null });
  const [progress, setProgress] = useState<Progress>({ active: false, done: 0, total: 0 });
  const [genInfo, setGenInfo] = useState("");
  const [reverse, setReverse] = useState(false);
  const [hasResult, setHasResult] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dims, setDims] = useState<{ nC: number; nT: number; cDim: string | null; tDim: string | null }>({ nC: 1, nT: 1, cDim: null, tDim: null });
  const [cSel, setCSel] = useState(0);
  const [tSel, setTSel] = useState(0);
  slabRef.current = slab;
  geomRef.current = geom;
  wlRef.current = wl;

  const mode = status?.mode === "standalone" ? "standalone" : "web";

  // ── パネル描画（rAF コアレス。geom/wl の最新は ref から読む） ──
  const renderAllPanels = useCallback(() => {
    const vol = volRef.current;
    const ls = layoutsRef.current;
    const g = geomRef.current;
    if (!vol || !ls || !g) return;
    for (const axis of ORTHO_AXES) {
      const canvas = canvasRefs[axis].current;
      const layout = ls[axis];
      if (!canvas || !layout) continue;
      if (canvas.width !== layout.widthPx || canvas.height !== layout.heightPx) {
        canvas.width = layout.widthPx;
        canvas.height = layout.heightPx;
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) continue;
      const rgba = renderPanelSlice(vol, layout, g.center, wlRef.current, "linear");
      const img = ctx.createImageData(layout.widthPx, layout.heightPx);
      img.data.set(rgba);
      ctx.putImageData(img, 0, 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const requestPanelRender = useCallback(() => {
    if (renderPendingRef.current) return;
    renderPendingRef.current = true;
    requestAnimationFrame(() => {
      renderPendingRef.current = false;
      renderAllPanels();
    });
  }, [renderAllPanels]);

  /** バンド・ハンドル（SVG オーバーレイ）を再計算し、パネル再描画を予約。 */
  const recompute = useCallback(
    (g: SlicerGeometry | null) => {
      const ls = layoutsRef.current;
      if (!ls || !g) return;
      const s = slabRef.current;
      const slabDims = { numSlices: s.numSlices, thickness: s.thickness, gap: s.gap, fovWidth: s.fovWidth, fovHeight: s.fovHeight };
      const nb: Record<OrthoAxis, PanelPolygon[]> = { axial: [], coronal: [], sagittal: [] };
      const nh: Record<OrthoAxis, SlabHandlesPanel | null> = { axial: null, coronal: null, sagittal: null };
      for (const axis of ORTHO_AXES) {
        nb[axis] = computeSlabBandsPanel(ls[axis], g, slabDims);
        nh[axis] = computeSlabHandlesPanel(ls[axis], g, slabDims);
      }
      setBands(nb);
      setHandles(nh);
      requestPanelRender();
    },
    [requestPanelRender],
  );

  const start = useCallback(async () => {
    let ctx: SlicerContext | null = null;
    try {
      const raw = localStorage.getItem("graphy-slicer-ctx");
      if (raw) ctx = JSON.parse(raw) as SlicerContext;
    } catch {
      ctx = null;
    }
    if (!ctx?.study) {
      setPhase("error");
      setMessage(t("slicer.noContext"));
      return;
    }
    // web も対応: imageId は BFF(WADO-RS) 経由の wadouri。reslice 用 volume は cornerstone が
    // 各スライスを BFF から読み込んで構築する（standalone と同一経路。3面は自前 canvas 描画）。
    setPhase("loading");
    setMessage(t("slicer.loading"));
    try {
      await ensureCornerstoneInitialized();
      let series = ctx.series;
      if (!series) {
        const list = await fetchSeries(ctx.study.studyInstanceUid);
        series = list.slice().sort((a, b) => b.numberOfInstances - a.numberOfInstances)[0];
      }
      if (!series) {
        setPhase("error");
        setMessage(t("slicer.noSeries"));
        return;
      }
      setTitle(series.seriesDescription || series.seriesInstanceUid);
      srcStudyRef.current = ctx.study.studyInstanceUid;
      srcSeriesRef.current = series.seriesInstanceUid;
      srcDescRef.current = series.seriesDescription || "";
      modalityRef.current = series.modality;

      // ZCT レイアウトを取得。マルチ C/T のときは単一（c,t）Z スタックを取り出してから volume 化する。
      let imageIds: string[];
      let c0 = 0;
      let t0 = 0;
      try {
        const layout = await fetchSeriesLayout(ctx.study.studyInstanceUid, series.seriesInstanceUid);
        layoutRef.current = layout;
        setDims({ nC: layout.nC, nT: layout.nT, cDim: layout.cDimension, tDim: layout.tDimension });
        c0 = Math.min(Math.max(0, ctx.c ?? 0), Math.max(0, layout.nC - 1));
        t0 = Math.min(Math.max(0, ctx.t ?? 0), Math.max(0, layout.nT - 1));
        setCSel(c0);
        setTSel(t0);
        imageIds = imageIdsForCT(layout, mode, c0, t0, ctx.study.studyInstanceUid, series.seriesInstanceUid);
        if (imageIds.length < 3) {
          const instances = await fetchInstances(ctx.study.studyInstanceUid, series.seriesInstanceUid);
          imageIds = instances.map((i) =>
            imageIdForInstance(mode, i.sopInstanceUid, ctx.study.studyInstanceUid, series.seriesInstanceUid),
          );
        }
      } catch {
        layoutRef.current = null;
        const instances = await fetchInstances(ctx.study.studyInstanceUid, series.seriesInstanceUid);
        imageIds = instances.map((i) =>
          imageIdForInstance(mode, i.sopInstanceUid, ctx.study.studyInstanceUid, series.seriesInstanceUid),
        );
      }
      if (imageIds.length < 3) {
        setPhase("error");
        setMessage(t("slicer.needVolume"));
        return;
      }
      // web: 全スライスを 1 リクエストで BFF キャッシュに載せてから volume 構築（個別 WADO-RS 往復を回避）。
      if (mode === "web") {
        try {
          await prefetchSeries(ctx.study.studyInstanceUid, series.seriesInstanceUid);
        } catch {
          /* prefetch は最適化。失敗しても個別取得で続行 */
        }
      }
      const volumeId = `graphy-slicer-vol:${series.seriesInstanceUid}:c${c0}t${t0}`;
      // CT はガントリチルトを必要に応じて自動補正（buildMprVolume 内で判定）。
      const built = await buildMprVolume(imageIds, series.modality, volumeId);
      setTilt(built.corrected ? (built.tiltAngleDeg ?? null) : null);

      const vol = resliceVolumeFromCache(volumeId);
      if (!vol) {
        setPhase("error");
        setMessage(t("slicer.needVolume"));
        return;
      }
      volRef.current = vol;
      const ls: Record<OrthoAxis, PanelLayout> = {
        axial: computePanelLayout(vol, "axial"),
        coronal: computePanelLayout(vol, "coronal"),
        sagittal: computePanelLayout(vol, "sagittal"),
      };
      layoutsRef.current = ls;
      setLayouts(ls);

      const base = baseGeometry(vol);
      baseRef.current = base;
      const g0: SlicerGeometry = { ...base };
      setGeom(g0);
      const voi = volumeDefaultVoi(volumeId) ?? dataRangeVoi(vol);
      wlRef.current = voi;
      setWl(voi);

      // recon プレビュー用の cornerstone ビューポート（右下 1 面のみ）。
      if (!reconRef.current) {
        setPhase("error");
        setMessage(t("slicer.error"));
        return;
      }
      const engine = new RenderingEngine(ENGINE_ID);
      engineRef.current = engine;
      await setupReconViewport(engine, ENGINE_ID, reconRef.current, RECON_VP, TOOL_GROUP_ID);

      setPhase("ready");
      requestAnimationFrame(() => recompute(g0));
    } catch (e) {
      setPhase("error");
      setMessage(`${t("slicer.error")}: ${String(e)}`);
    }
  }, [mode, t, recompute]);

  useEffect(() => {
    if (startedRef.current || !status) return;
    startedRef.current = true;
    void start();
  }, [status, start]);

  useEffect(() => {
    return () => {
      teardownSlicer(engineRef.current, TOOL_GROUP_ID);
      engineRef.current = null;
    };
  }, []);

  // geom / slab 変更でバンド・ハンドル・パネル再描画。
  useEffect(() => {
    if (phase === "ready") recompute(geom);
  }, [phase, geom, slab, recompute]);

  // wl 変更でパネル再描画（オーバーレイは不変）。
  useEffect(() => {
    if (phase === "ready") requestPanelRender();
  }, [phase, wl, requestPanelRender]);

  // セルサイズ変更（ウィンドウリサイズ等）でパネル再描画（object-fit で自動フィットするが再描画で高精細維持）。
  useEffect(() => {
    if (phase !== "ready") return;
    const ro = new ResizeObserver(() => requestPanelRender());
    for (const axis of ORTHO_AXES) {
      const el = cellRefs[axis].current;
      if (el) ro.observe(el);
    }
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, requestPanelRender]);

  // ── ポインタ操作（クライアント座標 → パネル画素） ──
  const clientToPanel = useCallback(
    (axis: OrthoAxis, clientX: number, clientY: number, rect: DOMRect): [number, number] => {
      const layout = layoutsRef.current?.[axis];
      if (!layout) return [0, 0];
      const scl = Math.min(rect.width / layout.widthPx, rect.height / layout.heightPx) || 1;
      const dispW = layout.widthPx * scl;
      const dispH = layout.heightPx * scl;
      const offX = (rect.width - dispW) / 2;
      const offY = (rect.height - dispH) / 2;
      return [(clientX - rect.left - offX) / scl, (clientY - rect.top - offY) / scl];
    },
    [],
  );

  const startDrag = useCallback(
    (kind: DragKind, axis: OrthoAxis, e: React.PointerEvent) => {
      const el = cellRefs[axis].current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      dragRef.current = { kind, axis, rect, lastPanel: clientToPanel(axis, e.clientX, e.clientY, rect), lastClient: [e.clientX, e.clientY] };
      e.stopPropagation();
      e.preventDefault();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [clientToPanel],
  );

  // 背景ドラッグ: 左=平行移動 / 右=W/L。
  const onCellPointerDown = useCallback(
    (axis: OrthoAxis, e: React.PointerEvent) => {
      if (e.button === 2) startDrag("wl", axis, e);
      else if (e.button === 0) startDrag("move", axis, e);
    },
    [startDrag],
  );

  // ホイール: 面法線方向に center をスクロール（1 ステップ = 最小 voxel 間隔）。
  const onCellWheel = useCallback(
    (axis: OrthoAxis, e: React.WheelEvent) => {
      const vol = volRef.current;
      const g = geomRef.current;
      const layout = layoutsRef.current?.[axis];
      if (!vol || !g || !layout) return;
      const stepMm = Math.max(0.1, Math.min(vol.spacing[0], vol.spacing[1], vol.spacing[2]));
      const dir = e.deltaY > 0 ? 1 : -1;
      const n = layout.normal;
      const ng: SlicerGeometry = { ...g, center: [g.center[0] + n[0] * stepMm * dir, g.center[1] + n[1] * stepMm * dir, g.center[2] + n[2] * stepMm * dir] };
      setGeom(ng);
      recompute(ng);
    },
    [recompute],
  );

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const cur = geomRef.current;
      const layout = layoutsRef.current?.[d.axis];
      if (!cur || !layout) return;
      if (d.kind === "wl") {
        const dx = e.clientX - d.lastClient[0];
        const dy = e.clientY - d.lastClient[1];
        const k = Math.max(1, wlRef.current.width / 256);
        const nw: Wl = { width: Math.max(1, wlRef.current.width + dx * k), center: wlRef.current.center + dy * k };
        d.lastClient = [e.clientX, e.clientY];
        setWl(nw);
        return;
      }
      const now = clientToPanel(d.axis, e.clientX, e.clientY, d.rect);
      const ng = d.kind === "move" ? translateGeomInPlanePanel(layout, cur, d.lastPanel, now) : rotateGeomInPlanePanel(layout, cur, d.lastPanel, now);
      d.lastPanel = now;
      setGeom(ng as SlicerGeometry);
      recompute(ng as SlicerGeometry);
    };
    const onUp = () => {
      dragRef.current = null;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [clientToPanel, recompute]);

  // ── 確定リスライス（進捗バー付き）＋ 右下にスタック表示 ──
  const onGenerate = useCallback(async () => {
    const engine = engineRef.current;
    const vol = volRef.current;
    const g = geomRef.current;
    if (!engine || !vol || !g || progress.active) return;
    try {
      const outSpacing = Math.max(0.05, Math.min(vol.spacing[0], vol.spacing[1], vol.spacing[2]));
      const modality = modalityRef.current || "OT";
      // Settings で指定された補間アルゴリズムを毎回最新で取得（別ウィンドウで変更されても反映）。
      let interpolation: Interpolation = "linear";
      try {
        const s = await fetchSettings();
        if (s["slicer.interpolation"] === "nearest") interpolation = "nearest";
      } catch {
        /* 既定 linear */
      }
      // 断面平面は geom（colDir=画面下）から直接構成。IOP は geom の rowDir/colDir をそのまま採用。
      const plane = planeFromGeometry(g, slab.fovWidth, slab.fovHeight, outSpacing, outSpacing);
      const r = createReslicer(vol, plane, { numSlices: slab.numSlices, thickness: slab.thickness, gap: slab.gap, mode: slab.mode, interpolation });
      setGenInfo("");
      setProgress({ active: true, done: 0, total: r.numSlices });
      // 常に正順（canonical, s=0..N-1）で再構成。IOP=rowDir/colDir は不変。
      const frames: Int16Array[] = [];
      const ipps: Vec3[] = [];
      for (let s = 0; s < r.numSlices; s++) {
        frames.push(r.sliceAt(s));
        ipps.push(r.imagePositionPatientAt(s));
        setProgress({ active: true, done: s + 1, total: r.numSlices });
        await raf();
      }
      // recon の幾何（IOP・視点・積層方向）は reverse に関係なく canonical で固定（§10.5）。
      const rowDir: Vec3 = [plane.rowDir[0], plane.rowDir[1], plane.rowDir[2]];
      const colDir: Vec3 = [plane.colDir[0], plane.colDir[1], plane.colDir[2]];
      const dir3: Vec3 =
        ipps.length >= 2
          ? normalizeVec([ipps[1][0] - ipps[0][0], ipps[1][1] - ipps[0][1], ipps[1][2] - ipps[0][2]])
          : crossVec(rowDir, colDir);
      genResultRef.current = {
        framesCanon: frames,
        ippsCanon: ipps,
        rows: r.rows,
        cols: r.cols,
        rowDir,
        colDir,
        pixelSpacing: [r.pixelSpacing[0], r.pixelSpacing[1]],
        sliceThickness: r.sliceThickness,
        spacingBetweenSlices: r.spacingBetweenSlices,
      };
      setHasResult(true);
      // reverse は「再構成後にスライス表示順を並び替えるだけ」＝表示フレーム列のみ反転。
      const displayFrames = reverse ? frames.slice().reverse() : frames;
      const reconVolId = `graphy-slicer-recon:${++reconSeqRef.current}`;
      try {
        await displayReconStack(engine, RECON_VP, reconVolId, {
          frames: displayFrames,
          cols: r.cols,
          rows: r.rows,
          numSlices: r.numSlices,
          origin: ipps[0],
          rowDir,
          colDir,
          normal: dir3,
          colSpacing: r.pixelSpacing[1],
          rowSpacing: r.pixelSpacing[0],
          spacingBetweenSlices: r.spacingBetweenSlices,
          modality,
        });
      } catch {
        /* ignore */
      }
      setProgress({ active: false, done: r.numSlices, total: r.numSlices });
      setGenInfo(t("slicer.generated", { n: String(r.numSlices), rows: String(r.rows), cols: String(r.cols) }));
    } catch (e) {
      setProgress({ active: false, done: 0, total: 0 });
      setGenInfo(`${t("slicer.error")}: ${String(e)}`);
      // eslint-disable-next-line no-console
      console.error("[slicer] reconstruct failed:", e);
    }
  }, [slab, progress.active, reverse, t]);

  // ── 派生（セカンダリ）シリーズとして DICOM 保存 ──
  const onSave = useCallback(async () => {
    const g = genResultRef.current;
    if (!g || saving) return;
    setSaving(true);
    setGenInfo("");
    try {
      const n = g.framesCanon.length;
      // 出力順（reverse は InstanceNumber と IPP の並び順で表現。IOP は不変）。
      const order = reverse ? Array.from({ length: n }, (_, k) => n - 1 - k) : Array.from({ length: n }, (_, k) => k);
      const frames = order.map((idx, k) => ({
        instanceNumber: k + 1,
        imagePositionPatient: g.ippsCanon[idx],
        pixels: framePixelsBase64(g.framesCanon[idx]),
      }));
      const desc = `${srcDescRef.current || "Series"} Reslice`;
      const res = await httpSend<{ seriesInstanceUid: string; sopInstanceUids: string[] }>(
        "/api/series/derived",
        "POST",
        {
          studyInstanceUid: srcStudyRef.current,
          seriesInstanceUid: srcSeriesRef.current,
          seriesDescription: desc,
          seriesNumber: null,
          rows: g.rows,
          columns: g.cols,
          pixelSpacing: g.pixelSpacing,
          sliceThickness: g.sliceThickness,
          spacingBetweenSlices: g.spacingBetweenSlices,
          imageOrientationPatient: [...g.rowDir, ...g.colDir],
          frames,
        },
      );
      emitDbChanged({ reason: "series-create", studyUids: [srcStudyRef.current] });
      setGenInfo(t("slicer.saved", { n: String(res.sopInstanceUids.length) }));
    } catch (e) {
      setGenInfo(`${t("slicer.saveFailed")}: ${String(e)}`);
      // eslint-disable-next-line no-console
      console.error("[slicer] save failed:", e);
    } finally {
      setSaving(false);
    }
  }, [reverse, saving, t]);

  // マルチ C/T シリーズで表示チャンネル/時相を切り替える（単一 Z スタックを差し替え。幾何は保持）。
  const applyCT = useCallback(
    async (cIdx: number, tIdx: number) => {
      const layout = layoutRef.current;
      if (!layout) return;
      const ids = imageIdsForCT(layout, mode, cIdx, tIdx, srcStudyRef.current ?? "", srcSeriesRef.current ?? "");
      if (ids.length < 3) return;
      const volId = `graphy-slicer-vol:${srcSeriesRef.current}:c${cIdx}t${tIdx}`;
      try {
        const built = await buildMprVolume(ids, modalityRef.current, volId);
        setTilt(built.corrected ? (built.tiltAngleDeg ?? null) : null);
        const vol = resliceVolumeFromCache(volId);
        if (!vol) {
          setGenInfo(t("slicer.error"));
          return;
        }
        volRef.current = vol;
        const ls: Record<OrthoAxis, PanelLayout> = {
          axial: computePanelLayout(vol, "axial"),
          coronal: computePanelLayout(vol, "coronal"),
          sagittal: computePanelLayout(vol, "sagittal"),
        };
        layoutsRef.current = ls;
        setLayouts(ls);
        // 同一空間・同一 IPP のため geom は保持。recon 結果はクリア（内容が変わるため）。
        genResultRef.current = null;
        setHasResult(false);
        setGenInfo("");
        recompute(geomRef.current);
      } catch (e) {
        setGenInfo(`${t("slicer.error")}: ${String(e)}`);
      }
    },
    [mode, recompute, t],
  );

  const busy = phase === "loading" || phase === "idle";
  const commit = (key: keyof SlabParams) => (v: number) => setSlab((s) => ({ ...s, [key]: v }));
  const pct = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

  // ── 回転角(XYZ, deg) と 中心ボクセル座標(IJK) の表示値（小数切り捨て） ──
  const base = baseRef.current;
  const anglesRaw = geom && base ? geometryToAngles(base, geom) : [0, 0, 0];
  const angles: [number, number, number] = [Math.trunc(anglesRaw[0]), Math.trunc(anglesRaw[1]), Math.trunc(anglesRaw[2])];
  const centerIjkRaw = volRef.current && geom ? worldToVoxel(volRef.current, geom.center) : null;
  const centerIjk: [number, number, number] | null = centerIjkRaw
    ? [Math.trunc(centerIjkRaw[0]), Math.trunc(centerIjkRaw[1]), Math.trunc(centerIjkRaw[2])]
    : null;

  // 回転角のマニュアル入力 → base に Euler を適用して geom を再構成。
  const onAngleCommit = (axis: 0 | 1 | 2) => (v: number) => {
    const b = baseRef.current;
    const g = geomRef.current;
    if (!b || !g) return;
    const cur = geometryToAngles(b, g);
    cur[axis] = v;
    const ng = anglesToGeometry(b, g.center, [cur[0], cur[1], cur[2]]);
    setGeom(ng);
    recompute(ng);
  };
  // 中心ボクセル座標のマニュアル入力 → world へ変換して center を更新。
  const onCenterCommit = (axis: 0 | 1 | 2) => (v: number) => {
    const vol = volRef.current;
    const g = geomRef.current;
    if (!vol || !g) return;
    const cur = worldToVoxel(vol, g.center);
    const ijk: Vec3 = [cur[0], cur[1], cur[2]];
    ijk[axis] = v;
    const ng = { ...g, center: voxelToWorld(vol, ijk) };
    setGeom(ng);
    recompute(ng);
  };

  return (
    <div style={root}>
      <div style={header}>
        <span style={hTitle}>{t("main.toolbar.slicer")}</span>
        {title && <span style={hSeries}>{title}</span>}
        {tilt !== null && (
          <span style={tiltChip} title={t("mpr.tiltCorrectedHint")}>
            {t("mpr.tiltCorrected", { deg: tilt.toFixed(1) })}
          </span>
        )}
      </div>

      {phase === "ready" && (
        <div style={ctrlBar}>
          {(dims.nC > 1 || dims.nT > 1) && (
            <>
              {dims.nC > 1 && (
                <label style={selWrap}>
                  <span style={ctrlGroupLabel}>{dims.cDim || "C"}</span>
                  <select style={select} value={cSel} onChange={(e) => { const c = Number(e.target.value); setCSel(c); void applyCT(c, tSel); }}>
                    {Array.from({ length: dims.nC }, (_, i) => (<option key={i} value={i}>{i}</option>))}
                  </select>
                </label>
              )}
              {dims.nT > 1 && (
                <label style={selWrap}>
                  <span style={ctrlGroupLabel}>{dims.tDim || "T"}</span>
                  <select style={select} value={tSel} onChange={(e) => { const tt = Number(e.target.value); setTSel(tt); void applyCT(cSel, tt); }}>
                    {Array.from({ length: dims.nT }, (_, i) => (<option key={i} value={i}>{i}</option>))}
                  </select>
                </label>
              )}
              <span style={ctrlSep} />
            </>
          )}
          <span style={ctrlGroupLabel}>{t("slicer.rotation")}</span>
          <Field label="X" value={angles[0]} min={-360} step={1} onCommit={onAngleCommit(0)} unit="°" />
          <Field label="Y" value={angles[1]} min={-360} step={1} onCommit={onAngleCommit(1)} unit="°" />
          <Field label="Z" value={angles[2]} min={-360} step={1} onCommit={onAngleCommit(2)} unit="°" />
          <span style={ctrlSep} />
          <span style={ctrlGroupLabel}>{t("slicer.centerVox")}</span>
          <Field label="I" value={centerIjk ? centerIjk[0] : 0} min={0} step={1} onCommit={onCenterCommit(0)} />
          <Field label="J" value={centerIjk ? centerIjk[1] : 0} min={0} step={1} onCommit={onCenterCommit(1)} />
          <Field label="K" value={centerIjk ? centerIjk[2] : 0} min={0} step={1} onCommit={onCenterCommit(2)} />
          <span style={ctrlSep} />
          <label style={selWrap}>
            <input type="checkbox" checked={reverse} onChange={(e) => setReverse(e.target.checked)} />
            <span style={fieldLabel}>{t("slicer.reverse")}</span>
          </label>
        </div>
      )}

      <div style={grid}>
        {ORTHO_AXES.map((axis) => (
          <PanelCell
            key={axis}
            label={t(`mpr.${axis}`)}
            color={AXIS_COLOR[axis]}
            axis={axis}
            cellRef={cellRefs[axis]}
            canvasRef={canvasRefs[axis]}
            layout={layouts?.[axis] ?? null}
            bands={bands[axis]}
            handles={handles[axis]}
            reverse={reverse}
            onCellPointerDown={onCellPointerDown}
            onHandleDown={startDrag}
            onWheel={onCellWheel}
          />
        ))}
        <div style={cell}>
          <div ref={reconRef} style={vpEl} onContextMenu={(e) => e.preventDefault()} />
          <span style={{ ...cellLabel, color: "#ff9a5a" }}>{t("slicer.recon")}</span>
        </div>
        {phase !== "ready" && (
          <div style={overlay}>
            <div style={overlayBox}>{busy ? t("slicer.loading") : message}</div>
          </div>
        )}
      </div>

      {phase === "ready" && (
        <div style={panel}>
          <Field label={t("slicer.fovW")} value={slab.fovWidth} min={1} onCommit={commit("fovWidth")} unit="mm" />
          <Field label={t("slicer.fovH")} value={slab.fovHeight} min={1} onCommit={commit("fovHeight")} unit="mm" />
          <Field label={t("slicer.thickness")} value={slab.thickness} min={0.1} step={0.5} onCommit={commit("thickness")} unit="mm" />
          <Field label={t("slicer.gap")} value={slab.gap} min={0} step={0.5} onCommit={commit("gap")} unit="mm" />
          <Field label={t("slicer.numSlices")} value={slab.numSlices} min={1} step={1} onCommit={commit("numSlices")} />
          <label style={selWrap}>
            <span style={fieldLabel}>{t("slicer.reconMode")}</span>
            <select style={select} value={slab.mode} onChange={(e) => setSlab((s) => ({ ...s, mode: e.target.value as ReconMode }))}>
              {RECON_MODES.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
          <span style={hint}>{t("slicer.handleHint")}</span>
          <div style={{ flex: 1 }} />
          {progress.active ? (
            <div style={progWrap}>
              <div style={progBarOuter}>
                <div style={{ ...progBarInner, width: `${pct}%` }} />
              </div>
              <span style={progText}>
                {t("slicer.reconstructing")} {progress.done}/{progress.total}
              </span>
            </div>
          ) : (
            genInfo && <span style={genInfoStyle}>{genInfo}</span>
          )}
          <button style={progress.active ? genBtnDisabled : genBtn} onClick={onGenerate} disabled={progress.active}>
            {t("slicer.generate")}
          </button>
          <button
            style={hasResult && !saving && !progress.active ? genBtn : genBtnDisabled}
            onClick={onSave}
            disabled={!hasResult || saving || progress.active}
            title={hasResult ? "" : t("slicer.saveNeedGen")}
          >
            {saving ? t("slicer.saving") : t("slicer.save")}
          </button>
        </div>
      )}
    </div>
  );
}

/** 1 面（AX/COR/SAG）: 自前描画 canvas ＋ SVG バンド/ハンドルオーバーレイ。座標系はパネル画素。 */
function PanelCell({
  label,
  color,
  axis,
  cellRef,
  canvasRef,
  layout,
  bands,
  handles,
  reverse,
  onCellPointerDown,
  onHandleDown,
  onWheel,
}: {
  label: string;
  color: string;
  axis: OrthoAxis;
  cellRef: React.RefObject<HTMLDivElement>;
  canvasRef: React.RefObject<HTMLCanvasElement>;
  layout: PanelLayout | null;
  bands?: PanelPolygon[];
  handles?: SlabHandlesPanel | null;
  reverse?: boolean;
  onCellPointerDown: (axis: OrthoAxis, e: React.PointerEvent) => void;
  onHandleDown: (kind: "move" | "rotate", axis: OrthoAxis, e: React.PointerEvent) => void;
  onWheel: (axis: OrthoAxis, e: React.WheelEvent) => void;
}) {
  const n = bands?.length ?? 0;
  const vb = layout ? `0 0 ${layout.widthPx} ${layout.heightPx}` : "0 0 1 1";
  // ハンドル半径をパネル画素基準に（表示時のフィット倍率と相殺しておおむね一定の見た目に）。
  const rBase = layout ? Math.max(4, Math.min(layout.widthPx, layout.heightPx) / 45) : 6;
  const centroid = (p: PanelPolygon): [number, number] => {
    let x = 0;
    let y = 0;
    for (const pt of p) {
      x += pt[0];
      y += pt[1];
    }
    return [x / p.length, y / p.length];
  };
  return (
    <div ref={cellRef} style={cell} onPointerDown={(e) => onCellPointerDown(axis, e)} onWheel={(e) => onWheel(axis, e)} onContextMenu={(e) => e.preventDefault()}>
      <canvas ref={canvasRef} style={panelCanvas} />
      <svg style={svgOverlay} viewBox={vb} preserveAspectRatio="xMidYMid meet">
        {(bands ?? []).map((p, i) =>
          p.length >= 3 ? (
            <polygon key={i} points={p.map((pt) => `${pt[0]},${pt[1]}`).join(" ")} fill="rgba(255,120,80,0.10)" stroke="#ff7a50" strokeWidth={rBase / 6} vectorEffect="non-scaling-stroke" />
          ) : null,
        )}
        {(bands ?? []).map((p, i) => {
          if (p.length < 3) return null;
          const [cx, cy] = centroid(p);
          // 番号は再構成ビューの表示スライス順に合わせる（reverse で反転）。
          const num = reverse ? i + 1 : n - i;
          return (
            <text key={`n${i}`} x={cx} y={cy} fill="#ffd27a" fontSize={rBase * 1.6} textAnchor="middle" dominantBaseline="central" style={{ pointerEvents: "none", textShadow: "0 0 3px #000" }}>
              {num}
            </text>
          );
        })}
        {handles?.corners.map((c, i) => (
          <circle
            key={`c${i}`}
            cx={c[0]}
            cy={c[1]}
            r={rBase}
            fill="#ffd27a"
            stroke="#7a4a2a"
            style={{ pointerEvents: "auto", cursor: "crosshair" }}
            onPointerDown={(e) => onHandleDown("rotate", axis, e)}
          />
        ))}
        {handles?.center && (
          <circle
            cx={handles.center[0]}
            cy={handles.center[1]}
            r={rBase * 1.15}
            fill="rgba(255,120,80,0.85)"
            stroke="#fff"
            style={{ pointerEvents: "auto", cursor: "move" }}
            onPointerDown={(e) => onHandleDown("move", axis, e)}
          />
        )}
      </svg>
      <span style={{ ...cellLabel, color }}>{label}</span>
    </div>
  );
}

/** 手入力を許可する数値フィールド。入力中は文字列を保持し、妥当な値は即コミット、blur で min クランプ。 */
function Field({
  label,
  value,
  min,
  step,
  unit,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  step?: number;
  unit?: string;
  onCommit: (v: number) => void;
}) {
  const [text, setText] = useState(String(value));
  const focusedRef = useRef(false);
  useEffect(() => {
    if (!focusedRef.current) setText(String(value));
  }, [value]);
  const onChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const tt = e.target.value;
    setText(tt);
    const v = parseFloat(tt);
    if (Number.isFinite(v)) onCommit(v);
  };
  const onBlur = () => {
    focusedRef.current = false;
    let v = parseFloat(text);
    if (!Number.isFinite(v)) v = value;
    v = Math.max(min, v);
    onCommit(v);
    setText(String(v));
  };
  return (
    <label style={selWrap}>
      <span style={fieldLabel}>{label}</span>
      <input
        type="number"
        style={input}
        value={text}
        step={step ?? 1}
        min={min}
        onFocus={() => {
          focusedRef.current = true;
        }}
        onChange={onChange}
        onBlur={onBlur}
      />
      {unit && <span style={fieldUnit}>{unit}</span>}
    </label>
  );
}

// ── styles ────────────────────────────────────────────────────
const root: React.CSSProperties = { position: "fixed", inset: 0, display: "flex", flexDirection: "column", background: "#000", color: "#e6eaee", fontFamily: "system-ui, sans-serif" };
const header: React.CSSProperties = { display: "flex", alignItems: "center", gap: 12, padding: "6px 12px", background: "#14181c", borderBottom: "1px solid #23292f", fontSize: 13 };
const hTitle: React.CSSProperties = { fontWeight: 600 };
const hSeries: React.CSSProperties = { color: "#9aa6b2" };
const tiltChip: React.CSSProperties = { marginLeft: "auto", fontSize: 11, color: "#ffd27a", border: "1px solid #5a4a2a", background: "#2a220f", borderRadius: 4, padding: "1px 7px" };
const ctrlBar: React.CSSProperties = { display: "flex", alignItems: "center", gap: 10, padding: "5px 12px", background: "#0d1013", borderBottom: "1px solid #23292f", fontSize: 12, flexWrap: "wrap" };
const ctrlGroupLabel: React.CSSProperties = { color: "#7f8b96", fontWeight: 600 };
const ctrlSep: React.CSSProperties = { width: 1, height: 16, background: "#2c343b", margin: "0 4px" };
const grid: React.CSSProperties = { position: "relative", flex: 1, display: "grid", gridTemplateColumns: "1fr 1fr", gridTemplateRows: "1fr 1fr", minHeight: 0 };
const cell: React.CSSProperties = { position: "relative", minWidth: 0, minHeight: 0, border: "1px solid #23292f", touchAction: "none" };
const vpEl: React.CSSProperties = { position: "absolute", inset: 0 };
const panelCanvas: React.CSSProperties = { position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain", background: "#000" };
const svgOverlay: React.CSSProperties = { position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" };
const cellLabel: React.CSSProperties = { position: "absolute", top: 6, left: 8, fontSize: 12, fontWeight: 600, textShadow: "0 0 3px #000", pointerEvents: "none" };
const overlay: React.CSSProperties = { position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.55)" };
const overlayBox: React.CSSProperties = { padding: "10px 18px", background: "#1b2126", border: "1px solid #2c343b", borderRadius: 8, fontSize: 13, maxWidth: "80%", textAlign: "center" };
const panel: React.CSSProperties = { display: "flex", alignItems: "center", gap: 14, padding: "8px 12px", background: "#14181c", borderTop: "1px solid #23292f", fontSize: 12, flexWrap: "wrap" };
const selWrap: React.CSSProperties = { display: "flex", alignItems: "center", gap: 5 };
const fieldLabel: React.CSSProperties = { color: "#9aa6b2" };
const fieldUnit: React.CSSProperties = { color: "#7f8b96" };
const hint: React.CSSProperties = { color: "#6b7680", fontSize: 11 };
const input: React.CSSProperties = { width: 62, background: "#1b2126", color: "#e6eaee", border: "1px solid #2c343b", borderRadius: 5, fontSize: 12, padding: "2px 6px" };
const select: React.CSSProperties = { background: "#1b2126", color: "#e6eaee", border: "1px solid #2c343b", borderRadius: 5, fontSize: 12, padding: "2px 6px" };
const genInfoStyle: React.CSSProperties = { color: "#8fe08f", fontSize: 12 };
const progWrap: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, minWidth: 220 };
const progBarOuter: React.CSSProperties = { flex: 1, height: 8, background: "#1b2126", border: "1px solid #2c343b", borderRadius: 4, overflow: "hidden", minWidth: 120 };
const progBarInner: React.CSSProperties = { height: "100%", background: "#0b8f4d", transition: "width 0.05s linear" };
const progText: React.CSSProperties = { color: "#9aa6b2", whiteSpace: "nowrap" };
const genBtn: React.CSSProperties = { background: "#0b5cad", color: "#fff", border: "none", borderRadius: 5, fontSize: 12, padding: "5px 12px", cursor: "pointer" };
const genBtnDisabled: React.CSSProperties = { ...genBtn, background: "#2c343b", color: "#7f8b96", cursor: "not-allowed" };
