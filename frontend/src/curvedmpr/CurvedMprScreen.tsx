/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * Curved MPR ウィンドウ（P4）。旧 GRAPHY `2D Viewer > Image > Curved MPR...`
 * （`CurvedMprDialog` / `CurvedMprCurvePanel` / `CurvedReformatter`）の Web 移植。
 *
 * 左＝参照 Axial ビュー上にセンターライン（制御点）を描く（**ダブルクリックで点追加 / ドラッグで移動 /
 * 右クリックで削除**）。右＝曲線に沿った Curved MPR プレビュー。パラメータ（第2軸=FIXED_Z/RMF、投影＝
 * MIP/MinIP/Average・帯半幅、第2軸範囲）を変えて再構成し、**派生セカンダリシリーズとして DB 保存**する。
 *
 * ボリューム構築・world 幾何抽出・トリリニアサンプリングは Slicer と共有（`viewer/slicer.ts` /
 * `viewer/reslice.ts`）。曲線＋再構成コアは `viewer/centerline.ts` / `viewer/curvedReformat.ts`（純関数）。
 * 起動: `localStorage("graphy-curvedmpr-ctx")`（2D ビューアの Image メニューから）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RenderingEngine, Enums, type Types } from "@cornerstonejs/core";
import {
  ToolGroupManager,
  StackScrollTool,
  WindowLevelTool,
  PanTool,
  ZoomTool,
  Enums as csToolsEnums,
} from "@cornerstonejs/tools";
import { fetchSeries, fetchInstances, fetchSeriesLayout, type AppStatus, type Study, type Series, type SeriesLayoutDto } from "../api";
import { ensureCornerstoneInitialized } from "../viewer/cornerstoneSetup";
import { imageIdForInstance, imageIdForCell } from "../viewer/imageId";
import { buildMprVolume, extractResliceVolume, worldToIndex } from "../viewer/slicer";
import type { ResliceVolume, Vec3 } from "../viewer/reslice";
import { Centerline3D, type FrameMode } from "../viewer/centerline";
import { reformat, defaultCurvedParams, type ProjectionMode, type CurvedResult } from "../viewer/curvedReformat";
import { httpSend } from "../http";
import { emitDbChanged } from "../dbEvents";
import { useI18n } from "../i18n/i18n";

const ENGINE_ID = "graphy-curvedmpr-engine";
const TOOL_GROUP_ID = "graphy-curvedmpr-tg";
const REF_VP = "curvedmpr-ref";

const { ViewportType, OrientationAxis } = Enums;
const { MouseBindings } = csToolsEnums;

const FRAME_MODES: FrameMode[] = ["FIXED_Z", "ROTATION_MINIMIZING"];
const PROJECTION_MODES: ProjectionMode[] = ["CENTERLINE_ONLY", "AVERAGE", "MIP", "MINIP"];

interface CurvedMprContext {
  study: Study;
  series?: Series;
  c?: number;
  t?: number;
  ts: number;
}

type Phase = "idle" | "loading" | "ready" | "error" | "unsupported";

interface CurveParamsUi {
  frameMode: FrameMode;
  projectionMode: ProjectionMode;
  bandHalfWidthMm: number;
  secondAxisMinMm: number;
  secondAxisMaxMm: number;
}

// ── ベクトル小道具 ─────────────────────────────────────────────
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

/** レイアウトから (c,t) 固定の単一 Z スタック imageIds を取り出す（z 昇順）。 */
function imageIdsForCT(layout: SeriesLayoutDto, mode: "standalone" | "web", c: number, t: number): string[] {
  return layout.cells
    .filter((cell) => cell.c === c && cell.t === t)
    .slice()
    .sort((a, b) => a.z - b.z)
    .map((cell) => imageIdForCell(mode, cell.sopInstanceUid, cell.frame));
}

/** Int16Array を Int16LE バイト列とみなして Base64 化（LE 前提）。 */
function framePixelsBase64(frame: Int16Array): string {
  const bytes = new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength);
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(bin);
}

export function CurvedMprScreen({ status }: { status: AppStatus | null }) {
  const { t } = useI18n();
  const refElRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<RenderingEngine | null>(null);
  const startedRef = useRef(false);
  const volRef = useRef<ResliceVolume | null>(null);
  const sliceNormalRef = useRef<Vec3>([0, 0, 1]); // ボリューム積層方向（drag の深さ保持用）
  const curveRef = useRef<Centerline3D>(new Centerline3D());
  const modalityRef = useRef<string>("");
  const srcStudyRef = useRef<string>("");
  const srcSeriesRef = useRef<string>("");
  const srcDescRef = useRef<string>("");
  const outSpacingRef = useRef<number>(1); // 出力等方ピクセル間隔（mm）
  const resultRef = useRef<CurvedResult | null>(null);
  const dragRef = useRef<{ index: number } | null>(null);

  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState("");
  const [title, setTitle] = useState("");
  const [tilt, setTilt] = useState<number | null>(null);
  const [params, setParams] = useState<CurveParamsUi>({
    frameMode: "FIXED_Z",
    projectionMode: "CENTERLINE_ONLY",
    bandHalfWidthMm: 0,
    secondAxisMinMm: -50,
    secondAxisMaxMm: 50,
  });
  const [curveVersion, setCurveVersion] = useState(0); // 曲線編集の再描画トリガ
  const [previewInfo, setPreviewInfo] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState("");
  // 表示中の C/T 次元（マルチ C/T シリーズで単一スタックを取り出した際のインデックス）。
  const [dimInfo, setDimInfo] = useState<{ nC: number; nT: number; c: number; t: number } | null>(null);
  const paramsRef = useRef(params);
  paramsRef.current = params;

  const mode = status?.mode === "standalone" ? "standalone" : "web";

  // ── world → 参照ビューの canvas 座標（要素相対 CSS px） ──
  const worldToCanvas = useCallback((w: Vec3): [number, number] | null => {
    const engine = engineRef.current;
    if (!engine) return null;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const vp = engine.getViewport(REF_VP) as any;
      const p = vp.worldToCanvas(w as Types.Point3) as [number, number];
      return [p[0], p[1]];
    } catch {
      return null;
    }
  }, []);

  const canvasToWorld = useCallback((cx: number, cy: number): Vec3 | null => {
    const engine = engineRef.current;
    if (!engine) return null;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const vp = engine.getViewport(REF_VP) as any;
      const w = vp.canvasToWorld([cx, cy]) as [number, number, number];
      return [w[0], w[1], w[2]];
    } catch {
      return null;
    }
  }, []);

  // クリック点を「表示中スライス面」上に載せた world 座標。
  // Cornerstone の VolumeViewport.canvasToWorld は displayToWorld(x,y,**0**) ＝ near クリップ面上の点を返すため、
  // 正射影で面内(x,y)は正しいが面外（スライス方向）は near 面の一定値になりスライスとズレる。
  // カメラ焦点(fp=現在スライス面上の点)・視線法線(n) で焦点面へ投影し、面外成分をスライス位置へ補正する。
  const canvasToWorldOnSlice = useCallback((cx: number, cy: number): Vec3 | null => {
    const engine = engineRef.current;
    if (!engine) return null;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const vp = engine.getViewport(REF_VP) as any;
      const w = vp.canvasToWorld([cx, cy]) as [number, number, number];
      const cam = vp.getCamera();
      const nRaw = cam.viewPlaneNormal as [number, number, number];
      const nl = Math.hypot(nRaw[0], nRaw[1], nRaw[2]) || 1;
      const n: Vec3 = [nRaw[0] / nl, nRaw[1] / nl, nRaw[2] / nl];
      const fp = cam.focalPoint as [number, number, number];
      const d = (w[0] - fp[0]) * n[0] + (w[1] - fp[1]) * n[1] + (w[2] - fp[2]) * n[2];
      return [w[0] - n[0] * d, w[1] - n[1] * d, w[2] - n[2] * d];
    } catch {
      return null;
    }
  }, []);

  // ── 現在の参照ビュー VOI（プレビューのグレースケール階調に使う） ──
  const currentVoi = useCallback((): { lower: number; upper: number } => {
    const engine = engineRef.current;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const vp = engine?.getViewport(REF_VP) as any;
      const voi = vp?.getProperties?.()?.voiRange;
      if (voi && Number.isFinite(voi.lower) && Number.isFinite(voi.upper) && voi.upper > voi.lower) {
        return { lower: voi.lower, upper: voi.upper };
      }
    } catch {
      /* ignore */
    }
    return { lower: -160, upper: 240 };
  }, []);

  // Cornerstone の voxelManager.getAtIJK で値を読むサンプラ。分数 index は自前式（cs と一致確認済み）で算出し、
  // 値の読み出しだけ voxelManager に委譲する。streaming volume の生配列レイアウト仮定に依存しないため確実。
  const buildViewportSampler = useCallback((): ((w: Vec3) => number) | null => {
    const engine = engineRef.current;
    const vol = volRef.current;
    if (!engine || !vol) return null;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const vp = engine.getViewport(REF_VP) as any;
      const vm = vp.getImageData?.()?.voxelManager;
      if (!vm?.getAtIJK) return null;
      const [W, H, D] = vol.dimensions;
      const d = vol.direction;
      const o = vol.origin;
      const sp = vol.spacing;
      const air = vol.airValue ?? 0;
      const at = (i: number, j: number, k: number): number => {
        if (i < 0 || i >= W || j < 0 || j >= H || k < 0 || k >= D) return air;
        const v = vm.getAtIJK(i, j, k);
        return typeof v === "number" ? v : air;
      };
      return (w: Vec3): number => {
        const dx = w[0] - o[0], dy = w[1] - o[1], dz = w[2] - o[2];
        const fi = (dx * d[0] + dy * d[1] + dz * d[2]) / sp[0];
        const fj = (dx * d[3] + dy * d[4] + dz * d[5]) / sp[1];
        const fk = (dx * d[6] + dy * d[7] + dz * d[8]) / sp[2];
        const i0 = Math.floor(fi), j0 = Math.floor(fj), k0 = Math.floor(fk);
        const i1 = i0 + 1, j1 = j0 + 1, k1 = k0 + 1;
        if (i1 < 0 || i0 >= W || j1 < 0 || j0 >= H || k1 < 0 || k0 >= D) return air;
        const tx = fi - i0, ty = fj - j0, tz = fk - k0;
        const c000 = at(i0, j0, k0), c100 = at(i1, j0, k0), c010 = at(i0, j1, k0), c110 = at(i1, j1, k0);
        const c001 = at(i0, j0, k1), c101 = at(i1, j0, k1), c011 = at(i0, j1, k1), c111 = at(i1, j1, k1);
        const c00 = c000 * (1 - tx) + c100 * tx, c10 = c010 * (1 - tx) + c110 * tx;
        const c01 = c001 * (1 - tx) + c101 * tx, c11 = c011 * (1 - tx) + c111 * tx;
        const c0 = c00 * (1 - ty) + c10 * ty, c1 = c01 * (1 - ty) + c11 * ty;
        return c0 * (1 - tz) + c1 * tz;
      };
    } catch {
      return null;
    }
  }, []);

  // ── プレビュー再構成＋描画 ──
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);
  const recomputePreview = useCallback(() => {
    const vol = volRef.current;
    const curve = curveRef.current;
    const canvas = previewCanvasRef.current;
    if (!vol || !canvas) return;
    if (curve.size() < 2) {
      resultRef.current = null;
      const ctx = canvas.getContext("2d");
      canvas.width = 1;
      canvas.height = 1;
      ctx?.clearRect(0, 0, 1, 1);
      setPreviewInfo(t("curvedMpr.needPoints"));
      return;
    }
    const p = paramsRef.current;
    const step = outSpacingRef.current;
    const cp = defaultCurvedParams();
    cp.arcStepMm = step;
    cp.secondAxisStepMm = step; // 出力を等方（正方）に保つ＝表示/保存で歪まない
    cp.secondAxisMinMm = p.secondAxisMinMm;
    cp.secondAxisMaxMm = p.secondAxisMaxMm;
    cp.frameMode = p.frameMode;
    cp.projectionMode = p.projectionMode;
    cp.bandHalfWidthMm = p.bandHalfWidthMm;
    cp.bandSampleCount = 9;
    cp.outOfBoundsValue = vol.airValue ?? 0;

    // 値の読み出しは voxelManager 経由（生配列レイアウト非依存）。取得不可時のみ生配列サンプラにフォールバック。
    const sampler = buildViewportSampler() ?? undefined;
    let result: CurvedResult;
    try {
      result = reformat(curve, vol, cp, sampler);
    } catch (e) {
      setPreviewInfo(`${t("curvedMpr.error")}: ${String(e)}`);
      return;
    }
    resultRef.current = result;

    const { lower, upper } = currentVoi();
    const range = Math.max(1e-6, upper - lower);
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
    const pctx = canvas.getContext("2d");
    pctx?.putImageData(img, 0, 0);
    // 描いたスライスレベル(h=0)の目印線。参照で曲線が通る解剖と、この線上の解剖が一致すれば整合。
    // 目印のみ（保存は resultRef.current.pixels を使うので画像には焼き込まれない）。
    if (pctx) {
      const y0 = Math.round(p.secondAxisMaxMm / step);
      if (y0 >= 0 && y0 < result.height) {
        pctx.strokeStyle = "rgba(0,220,255,0.55)";
        pctx.lineWidth = 1;
        pctx.beginPath();
        pctx.moveTo(0, y0 + 0.5);
        pctx.lineTo(result.width, y0 + 0.5);
        pctx.stroke();
      }
    }
    setPreviewInfo(
      t("curvedMpr.previewInfo", {
        w: String(result.width),
        h: String(result.height),
        px: step.toFixed(2),
      }),
    );
  }, [currentVoi, buildViewportSampler, t]);

  // ── 起動: コンテキスト読込 → ボリューム構築 → 参照ビュー ──
  const start = useCallback(async () => {
    let ctx: CurvedMprContext | null = null;
    try {
      const raw = localStorage.getItem("graphy-curvedmpr-ctx");
      if (raw) ctx = JSON.parse(raw) as CurvedMprContext;
    } catch {
      ctx = null;
    }
    if (!ctx?.study) {
      setPhase("error");
      setMessage(t("curvedMpr.noContext"));
      return;
    }
    if (mode !== "standalone") {
      setPhase("unsupported");
      setMessage(t("curvedMpr.webUnsupported"));
      return;
    }
    setPhase("loading");
    setMessage(t("curvedMpr.loading"));
    try {
      await ensureCornerstoneInitialized();
      let series = ctx.series;
      if (!series) {
        const list = await fetchSeries(ctx.study.studyInstanceUid);
        series = list.slice().sort((a, b) => b.numberOfInstances - a.numberOfInstances)[0];
      }
      if (!series) {
        setPhase("error");
        setMessage(t("curvedMpr.noSeries"));
        return;
      }
      setTitle(series.seriesDescription || series.seriesInstanceUid);
      srcStudyRef.current = ctx.study.studyInstanceUid;
      srcSeriesRef.current = series.seriesInstanceUid;
      srcDescRef.current = series.seriesDescription || "";
      modalityRef.current = series.modality ?? "";

      // ZCT レイアウト → 初期 (c,t) の単一 Z スタックを volume 化。
      let imageIds: string[];
      let c0 = 0;
      let t0 = 0;
      try {
        const layout = await fetchSeriesLayout(ctx.study.studyInstanceUid, series.seriesInstanceUid);
        // C,T 次元があるシリーズは「2D ビューアで表示中だった次元(ctx.c/ctx.t)」で単一 Z スタックを取り出す。
        c0 = Math.min(Math.max(0, ctx.c ?? 0), Math.max(0, layout.nC - 1));
        t0 = Math.min(Math.max(0, ctx.t ?? 0), Math.max(0, layout.nT - 1));
        setDimInfo({ nC: layout.nC, nT: layout.nT, c: c0, t: t0 });
        imageIds = imageIdsForCT(layout, mode, c0, t0);
        // フォールバック（全インスタンス混在）は単一次元のときのみ。多次元では次元を混ぜない。
        if (imageIds.length < 3 && layout.nC <= 1 && layout.nT <= 1) {
          const instances = await fetchInstances(ctx.study.studyInstanceUid, series.seriesInstanceUid);
          imageIds = instances.map((i) => imageIdForInstance(mode, i.sopInstanceUid));
        }
      } catch {
        const instances = await fetchInstances(ctx.study.studyInstanceUid, series.seriesInstanceUid);
        imageIds = instances.map((i) => imageIdForInstance(mode, i.sopInstanceUid));
      }
      if (imageIds.length < 3) {
        setPhase("error");
        setMessage(t("curvedMpr.needVolume"));
        return;
      }

      const volumeId = `graphy-curvedmpr-vol:${series.seriesInstanceUid}:c${c0}t${t0}`;
      const built = await buildMprVolume(imageIds, series.modality, volumeId);
      setTilt(built.corrected ? (built.tiltAngleDeg ?? null) : null);

      if (!refElRef.current) {
        setPhase("error");
        setMessage(t("curvedMpr.error"));
        return;
      }
      const engine = new RenderingEngine(ENGINE_ID);
      engineRef.current = engine;
      engine.setViewports([
        {
          viewportId: REF_VP,
          type: ViewportType.ORTHOGRAPHIC,
          element: refElRef.current,
          defaultOptions: { orientation: OrientationAxis.AXIAL, background: [0, 0, 0] as Types.Point3 },
        },
      ]);
      const vp = engine.getViewport(REF_VP) as Types.IVolumeViewport;
      await vp.setVolumes([{ volumeId }]);

      // ツール: ホイール=スライス送り / 右=W/L / 中=Pan / ズーム。左ボタンは曲線編集用に空ける。
      let tg = ToolGroupManager.getToolGroup(TOOL_GROUP_ID);
      if (tg) ToolGroupManager.destroyToolGroup(TOOL_GROUP_ID);
      tg = ToolGroupManager.createToolGroup(TOOL_GROUP_ID);
      if (tg) {
        tg.addTool(StackScrollTool.toolName);
        tg.addTool(WindowLevelTool.toolName);
        tg.addTool(PanTool.toolName);
        tg.addTool(ZoomTool.toolName);
        tg.addViewport(REF_VP, ENGINE_ID);
        tg.setToolActive(WindowLevelTool.toolName, { bindings: [{ mouseButton: MouseBindings.Secondary }] });
        tg.setToolActive(PanTool.toolName, { bindings: [{ mouseButton: MouseBindings.Auxiliary }] });
        tg.setToolActive(StackScrollTool.toolName, { bindings: [{ mouseButton: MouseBindings.Wheel }] });
      }
      engine.renderViewports([REF_VP]);

      // reslice.ts 用の world ボリューム（サンプラ＋幾何）を抽出。
      const vol = extractResliceVolume(engine, REF_VP);
      if (!vol) {
        setPhase("error");
        setMessage(t("curvedMpr.error"));
        return;
      }
      volRef.current = vol;
      // 積層方向 = direction の 3 行目（dirK）。ドラッグ時に点の深さを保持するのに使う。
      sliceNormalRef.current = [vol.direction[6], vol.direction[7], vol.direction[8]];
      // 出力等方ピクセル = 面内 spacing 平均（旧 CurvedMprDialog と同じ方針）。
      const inPlane = (vol.spacing[0] + vol.spacing[1]) / 2;
      outSpacingRef.current = Math.max(0.1, inPlane);

      // 第2軸の既定範囲 = 頭尾方向（積層）全長を中央対称に（旧実装 zExtent）。
      const zExtent = vol.spacing[2] * (vol.dimensions[2] - 1);
      const half = Math.max(10, zExtent / 2);
      setParams((p) => ({ ...p, secondAxisMinMm: -half, secondAxisMaxMm: half }));

      setPhase("ready");
      requestAnimationFrame(() => recomputePreview());
    } catch (e) {
      setPhase("error");
      setMessage(`${t("curvedMpr.error")}: ${String(e)}`);
    }
  }, [mode, t, recomputePreview]);

  useEffect(() => {
    if (startedRef.current || !status) return;
    startedRef.current = true;
    void start();
  }, [status, start]);

  useEffect(() => {
    return () => {
      try {
        if (ToolGroupManager.getToolGroup(TOOL_GROUP_ID)) ToolGroupManager.destroyToolGroup(TOOL_GROUP_ID);
      } catch {
        /* ignore */
      }
      try {
        engineRef.current?.destroy();
      } catch {
        /* ignore */
      }
      engineRef.current = null;
    };
  }, []);

  // パラメータ変更でプレビュー再計算。
  useEffect(() => {
    if (phase === "ready") recomputePreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params, phase]);

  // カメラ変更（スクロール/パン/ズーム/リサイズ）で曲線オーバーレイを再投影する。
  useEffect(() => {
    const el = refElRef.current;
    if (!el || phase !== "ready") return;
    const onCam = () => setCurveVersion((v) => v + 1);
    el.addEventListener(Enums.Events.CAMERA_MODIFIED, onCam);
    return () => el.removeEventListener(Enums.Events.CAMERA_MODIFIED, onCam);
  }, [phase]);

  // ── 曲線編集: ダブルクリックで追加 / 円ハンドルをドラッグで移動・右クリックで削除 ──
  const elRect = useCallback((): DOMRect | null => refElRef.current?.getBoundingClientRect() ?? null, []);

  // ダブルクリック（左）で末尾に制御点を追加。
  useEffect(() => {
    const el = refElRef.current;
    if (!el || phase !== "ready") return;
    const onDbl = (e: MouseEvent) => {
      if (e.button !== 0) return;
      const rect = el.getBoundingClientRect();
      const w = canvasToWorldOnSlice(e.clientX - rect.left, e.clientY - rect.top);
      if (!w) return;
      curveRef.current.addControlPoint(w);
      setCurveVersion((v) => v + 1);
      recomputePreview();
    };
    el.addEventListener("dblclick", onDbl);
    return () => el.removeEventListener("dblclick", onDbl);
  }, [phase, canvasToWorldOnSlice, recomputePreview]);

  // 点ハンドルのドラッグ（左）。ドラッグ中は曲線のみ再描画し、離した時にプレビュー再計算。
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      const rect = elRect();
      if (!d || !rect) return;
      const w = canvasToWorld(e.clientX - rect.left, e.clientY - rect.top);
      if (!w) return;
      // 点の元の深さ（積層方向成分）を保持: 面内成分のみ更新（旧 physicalOfKeepingDepth）。
      const n = sliceNormalRef.current;
      const old = curveRef.current.getControlPoint(d.index);
      const depthDelta = dot(sub(w, old), n);
      const kept: Vec3 = [w[0] - n[0] * depthDelta, w[1] - n[1] * depthDelta, w[2] - n[2] * depthDelta];
      curveRef.current.setControlPoint(d.index, kept);
      setCurveVersion((v) => v + 1);
    };
    const onUp = () => {
      if (dragRef.current) {
        dragRef.current = null;
        recomputePreview();
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [elRect, canvasToWorld, recomputePreview]);

  const onPointDown = useCallback(
    (index: number, e: React.PointerEvent) => {
      if (e.button === 2) {
        // 右クリック削除（最低 2 点は残す前提で自由に削除、0/1 点でもプレビューは消える）。
        e.preventDefault();
        e.stopPropagation();
        curveRef.current.removeControlPoint(index);
        setCurveVersion((v) => v + 1);
        recomputePreview();
        return;
      }
      if (e.button !== 0) return;
      e.stopPropagation();
      dragRef.current = { index };
    },
    [recomputePreview],
  );

  const resetCurve = useCallback(() => {
    curveRef.current.clear();
    setCurveVersion((v) => v + 1);
    recomputePreview();
  }, [recomputePreview]);

  // 再構成結果を派生セカンダリシリーズとして保存。
  const onSave = useCallback(async () => {
    const result = resultRef.current;
    if (!result || saving) return;
    setSaving(true);
    setSaveMsg("");
    try {
      // Float32 → Int16（丸め＋クランプ）。派生シリーズは 16bit signed 保存。
      const n = result.width * result.height;
      const frame = new Int16Array(n);
      for (let i = 0; i < n; i++) {
        let v = Math.round(result.pixels[i]);
        if (v < -32768) v = -32768;
        else if (v > 32767) v = 32767;
        frame[i] = v;
      }
      const p = paramsRef.current;
      const desc = `${srcDescRef.current || "Series"} Curved MPR`;
      const res = await httpSend<{ seriesInstanceUid: string; sopInstanceUids: string[] }>(
        "/api/series/derived",
        "POST",
        {
          studyInstanceUid: srcStudyRef.current,
          seriesInstanceUid: srcSeriesRef.current,
          seriesDescription: desc,
          seriesNumber: null,
          rows: result.height,
          columns: result.width,
          // DICOM PixelSpacing = [row(第2軸), col(弧長)]。等方なので両者同値。
          pixelSpacing: [result.pixelSpacingY, result.pixelSpacingX],
          sliceThickness: p.bandHalfWidthMm > 0 ? 2 * p.bandHalfWidthMm : 0,
          spacingBetweenSlices: 0,
          // 曲面/平坦化再構成は単一の平面 IPP/IOP を持たないため幾何は付与しない（backend が省略を許容）。
          imageOrientationPatient: null,
          derivationDescription: `Curved MPR (${p.frameMode}, ${p.projectionMode}, band=${p.bandHalfWidthMm}mm)`,
          frames: [
            {
              instanceNumber: 1,
              imagePositionPatient: null,
              pixels: framePixelsBase64(frame),
            },
          ],
        },
      );
      emitDbChanged({ reason: "series-create", studyUids: [srcStudyRef.current] });
      setSaveMsg(t("curvedMpr.saved", { n: String(res.sopInstanceUids.length) }));
    } catch (e) {
      setSaveMsg(`${t("curvedMpr.saveFailed")}: ${String(e)}`);
      // eslint-disable-next-line no-console
      console.error("[curvedmpr] save failed:", e);
    } finally {
      setSaving(false);
    }
  }, [saving, t]);

  // ── 曲線オーバーレイの座標（world→canvas。curveVersion / phase で再計算） ──
  const overlay = useMemo(() => {
    void curveVersion;
    if (phase !== "ready") return { pts: [] as Array<[number, number]>, poly: "" };
    const curve = curveRef.current;
    const pts: Array<[number, number]> = [];
    for (let i = 0; i < curve.size(); i++) {
      const s = worldToCanvas(curve.getControlPoint(i));
      if (s) pts.push(s);
    }
    const poly = pts.map((p) => `${p[0]},${p[1]}`).join(" ");
    return { pts, poly };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curveVersion, phase, worldToCanvas]);

  // デバッグ: 参照ビューの現在スライス番号 と 曲線 1 点目のスライス番号（両者一致＝クリック点が表示スライス上）。
  // さらに、cornerstone の world→index と 自前 makeWorldSampler の index を比較（面内 i,j のズレ検出）。
  const debugSlice = (() => {
    void curveVersion;
    const engine = engineRef.current;
    const vol = volRef.current;
    if (!engine || !vol || phase !== "ready") return null;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const vp = engine.getViewport(REF_VP) as any;
      // 現在スライス番号は focalPoint→index で算出（getSliceIndex は imageId lookup で "No imageId found" を出すため回避）。
      let view: number | null = null;
      try {
        const fp = vp.getCamera().focalPoint as [number, number, number];
        const vIdx = worldToIndex(engine, REF_VP, [fp[0], fp[1], fp[2]]);
        view = vIdx ? Math.round(vIdx[2]) : null;
      } catch {
        /* ignore */
      }
      let curveK: number | null = null;
      let cs: number[] | null = null;
      let mine: [number, number, number] | null = null;
      let rawV: number | null = null; // 生配列 [k*W*H+j*W+i] 直読み
      let vmV: number | null = null; // voxelManager.getAtIJK
      if (curveRef.current.size() > 0) {
        // 中間の制御点（椎体を通す点）で検証する。
        const W = curveRef.current.getControlPoint(Math.floor(curveRef.current.size() / 2));
        cs = worldToIndex(engine, REF_VP, W);
        if (cs) curveK = Math.round(cs[2]);
        // 自前サンプラの index（reslice.ts makeWorldSampler と同一式）。
        const d = vol.direction;
        const o = vol.origin;
        const s = vol.spacing;
        const dx = W[0] - o[0], dy = W[1] - o[1], dz = W[2] - o[2];
        mine = [
          (dx * d[0] + dy * d[1] + dz * d[2]) / s[0],
          (dx * d[3] + dy * d[4] + dz * d[5]) / s[1],
          (dx * d[6] + dy * d[7] + dz * d[8]) / s[2],
        ];
        // 生配列直読み vs voxelManager の値（食い違えばレイアウト不一致＝今回の原因）。
        const [W0, H0, D0] = vol.dimensions;
        const ii = Math.round(mine[0]), jj = Math.round(mine[1]), kk = Math.round(mine[2]);
        if (ii >= 0 && ii < W0 && jj >= 0 && jj < H0 && kk >= 0 && kk < D0) {
          rawV = Math.round(vol.data[kk * W0 * H0 + jj * W0 + ii]);
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const vm = (engine.getViewport(REF_VP) as any).getImageData?.()?.voxelManager;
        if (vm?.getAtIJK && ii >= 0 && ii < W0 && jj >= 0 && jj < H0 && kk >= 0 && kk < D0) {
          const v = vm.getAtIJK(ii, jj, kk);
          if (typeof v === "number") vmV = Math.round(v);
        }
      }
      return { view, curveK, cs, mine, rawV, vmV, spacing: vol.spacing, dims: vol.dimensions };
    } catch {
      return null;
    }
  })();

  const busy = phase === "loading" || phase === "idle";
  const hasResult = !!resultRef.current;
  const setP = <K extends keyof CurveParamsUi>(key: K, v: CurveParamsUi[K]) => setParams((s) => ({ ...s, [key]: v }));

  return (
    <div style={root}>
      <div style={header}>
        <span style={hTitle}>{t("curvedMpr.title")}</span>
        {title && <span style={hSeries}>{title}</span>}
        {dimInfo && (dimInfo.nC > 1 || dimInfo.nT > 1) && (
          <span style={dimChip}>{t("curvedMpr.dimUsed", { c: String(dimInfo.c), tt: String(dimInfo.t) })}</span>
        )}
        {tilt !== null && (
          <span style={tiltChip} title={t("mpr.tiltCorrectedHint")}>
            {t("mpr.tiltCorrected", { deg: tilt.toFixed(1) })}
          </span>
        )}
      </div>

      {phase === "ready" && (
        <div style={ctrlBar}>
          <span style={hint}>{t("curvedMpr.hint")}</span>
          <div style={{ flex: 1 }} />
          <label style={selWrap}>
            <span style={fieldLabel}>{t("curvedMpr.secondAxis")}</span>
            <select style={select} value={params.frameMode} onChange={(e) => setP("frameMode", e.target.value as FrameMode)}>
              {FRAME_MODES.map((m) => (
                <option key={m} value={m}>
                  {t(`curvedMpr.frame.${m}`)}
                </option>
              ))}
            </select>
          </label>
          <label style={selWrap}>
            <span style={fieldLabel}>{t("curvedMpr.projection")}</span>
            <select style={select} value={params.projectionMode} onChange={(e) => setP("projectionMode", e.target.value as ProjectionMode)}>
              {PROJECTION_MODES.map((m) => (
                <option key={m} value={m}>
                  {t(`curvedMpr.proj.${m}`)}
                </option>
              ))}
            </select>
          </label>
          <Field label={t("curvedMpr.band")} value={params.bandHalfWidthMm} min={0} step={0.5} onCommit={(v) => setP("bandHalfWidthMm", v)} unit="mm" />
          <Field label={t("curvedMpr.axisMin")} value={params.secondAxisMinMm} min={-2000} step={1} onCommit={(v) => setP("secondAxisMinMm", v)} unit="mm" />
          <Field label={t("curvedMpr.axisMax")} value={params.secondAxisMaxMm} min={-2000} step={1} onCommit={(v) => setP("secondAxisMaxMm", v)} unit="mm" />
        </div>
      )}

      <div style={grid}>
        <div style={cell}>
          <div ref={refElRef} style={vpEl} onContextMenu={(e) => e.preventDefault()} />
          <svg style={svgOverlay}>
            {overlay.pts.length >= 2 && (
              <polyline points={overlay.poly} fill="none" stroke="#ffd200" strokeWidth={1.8} />
            )}
            {overlay.pts.map((p, i) => (
              <circle
                key={i}
                cx={p[0]}
                cy={p[1]}
                r={5}
                fill="#ffa030"
                stroke="#000"
                strokeWidth={1}
                style={{ pointerEvents: "auto", cursor: "move" }}
                onPointerDown={(e) => onPointDown(i, e)}
                onContextMenu={(e) => e.preventDefault()}
              />
            ))}
          </svg>
          <span style={{ ...cellLabel, color: "#00dc00" }}>{t("curvedMpr.reference")}</span>
          {phase === "ready" && overlay.pts.length < 2 && (
            <div style={drawPromptWrap}>
              <span style={drawPromptBox}>{t("curvedMpr.drawPrompt")}</span>
            </div>
          )}
          {debugSlice && (
            <span style={debugText}>
              slice: view {debugSlice.view ?? "-"} / curve {debugSlice.curveK ?? "-"}
              {debugSlice.cs && debugSlice.mine && (
                <>
                  {" · cs["}
                  {debugSlice.cs.map((n) => Math.round(n)).join(",")}
                  {"] mine["}
                  {debugSlice.mine.map((n) => Math.round(n)).join(",")}
                  {"] raw="}
                  {debugSlice.rawV ?? "-"}
                  {" vm="}
                  {debugSlice.vmV ?? "-"}
                  {" sp["}
                  {debugSlice.spacing.map((n) => n.toFixed(2)).join(",")}
                  {"] dim["}
                  {debugSlice.dims.join(",")}
                  {"]"}
                </>
              )}
            </span>
          )}
        </div>
        <div style={cell}>
          <div style={previewWrap}>
            <canvas ref={previewCanvasRef} style={previewCanvas} />
          </div>
          <span style={{ ...cellLabel, color: "#ff9a5a" }}>{t("curvedMpr.preview")}</span>
          {previewInfo && <span style={previewInfoStyle}>{previewInfo}</span>}
        </div>
        {phase !== "ready" && (
          <div style={overlayBoxWrap}>
            <div style={overlayBox}>{busy ? t("curvedMpr.loading") : message}</div>
          </div>
        )}
      </div>

      {phase === "ready" && (
        <div style={panel}>
          <button style={btn} onClick={resetCurve}>
            {t("curvedMpr.resetCurve")}
          </button>
          <div style={{ flex: 1 }} />
          {saveMsg && <span style={saveMsgStyle}>{saveMsg}</span>}
          <button
            style={hasResult && !saving ? genBtn : genBtnDisabled}
            onClick={onSave}
            disabled={!hasResult || saving}
            title={hasResult ? "" : t("curvedMpr.saveNeedResult")}
          >
            {saving ? t("curvedMpr.saving") : t("curvedMpr.save")}
          </button>
          <button style={btn} onClick={() => window.close()}>
            {t("common.close")}
          </button>
        </div>
      )}
    </div>
  );
}

/** 手入力の数値フィールド（Slicer と同流儀）。 */
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
const dimChip: React.CSSProperties = { fontSize: 11, color: "#9fd3ff", border: "1px solid #2a465a", background: "#0f1e2a", borderRadius: 4, padding: "1px 7px" };
const drawPromptWrap: React.CSSProperties = { position: "absolute", top: 34, left: 0, right: 0, display: "flex", justifyContent: "center", pointerEvents: "none" };
const drawPromptBox: React.CSSProperties = { background: "rgba(11,92,173,0.85)", color: "#fff", fontSize: 12, padding: "5px 12px", borderRadius: 6, boxShadow: "0 2px 8px rgba(0,0,0,0.4)" };
const debugText: React.CSSProperties = { position: "absolute", bottom: 6, left: 8, fontSize: 11, color: "#7fd8ff", textShadow: "0 0 3px #000", pointerEvents: "none" };
const ctrlBar: React.CSSProperties = { display: "flex", alignItems: "center", gap: 10, padding: "5px 12px", background: "#0d1013", borderBottom: "1px solid #23292f", fontSize: 12, flexWrap: "wrap" };
const grid: React.CSSProperties = { position: "relative", flex: 1, display: "grid", gridTemplateColumns: "1fr 1fr", minHeight: 0 };
const cell: React.CSSProperties = { position: "relative", minWidth: 0, minHeight: 0, border: "1px solid #23292f", overflow: "hidden" };
const vpEl: React.CSSProperties = { position: "absolute", inset: 0 };
const svgOverlay: React.CSSProperties = { position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" };
const cellLabel: React.CSSProperties = { position: "absolute", top: 6, left: 8, fontSize: 12, fontWeight: 600, textShadow: "0 0 3px #000", pointerEvents: "none" };
const previewWrap: React.CSSProperties = { position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", overflow: "auto", background: "#000" };
const previewCanvas: React.CSSProperties = { imageRendering: "pixelated", maxWidth: "100%", maxHeight: "100%", objectFit: "contain" };
const previewInfoStyle: React.CSSProperties = { position: "absolute", bottom: 6, left: 8, fontSize: 11, color: "#9aa6b2", textShadow: "0 0 3px #000", pointerEvents: "none" };
const overlayBoxWrap: React.CSSProperties = { position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.55)" };
const overlayBox: React.CSSProperties = { padding: "10px 18px", background: "#1b2126", border: "1px solid #2c343b", borderRadius: 8, fontSize: 13, maxWidth: "80%", textAlign: "center" };
const panel: React.CSSProperties = { display: "flex", alignItems: "center", gap: 12, padding: "8px 12px", background: "#14181c", borderTop: "1px solid #23292f", fontSize: 12, flexWrap: "wrap" };
const selWrap: React.CSSProperties = { display: "flex", alignItems: "center", gap: 5 };
const fieldLabel: React.CSSProperties = { color: "#9aa6b2" };
const fieldUnit: React.CSSProperties = { color: "#7f8b96" };
const hint: React.CSSProperties = { color: "#8b96a0", fontSize: 11 };
const input: React.CSSProperties = { width: 68, background: "#1b2126", color: "#e6eaee", border: "1px solid #2c343b", borderRadius: 5, fontSize: 12, padding: "2px 6px" };
const select: React.CSSProperties = { background: "#1b2126", color: "#e6eaee", border: "1px solid #2c343b", borderRadius: 5, fontSize: 12, padding: "2px 6px" };
const saveMsgStyle: React.CSSProperties = { color: "#8fe08f", fontSize: 12 };
const btn: React.CSSProperties = { background: "#26303a", color: "#e6eaee", border: "1px solid #33404b", borderRadius: 5, fontSize: 12, padding: "5px 12px", cursor: "pointer" };
const genBtn: React.CSSProperties = { background: "#0b5cad", color: "#fff", border: "none", borderRadius: 5, fontSize: 12, padding: "5px 12px", cursor: "pointer" };
const genBtnDisabled: React.CSSProperties = { ...genBtn, background: "#2c343b", color: "#7f8b96", cursor: "not-allowed" };
