/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 3D Viewer ウィンドウ。描画・操作は **pure VTK.js**（`viewer/vtkVolumeView.ts`）。
 *
 * ボリューム構築は Cornerstone 共通の `buildMprVolume`（CT ガントリチルト補正込み）を流用し、その
 * `vtkImageData` を pure vtk の `vtkGenericRenderWindow` へ横取りして渡す（設計 `fw/3d-viewer-design.md`）。
 * これにより cornerstone VOLUME_3D の制約（blend no-op / clipping-plane CONTEXT_LOST / オフスクリーン
 * interactor でウィジェット操作不可 / 回転後 worldToCanvas 不正確）を回避し、**ドラッグ可能なクリップ箱**・
 * 真の MIP/MinIP・座標整合を得る。2D/MPR/Slicer は現状維持。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchSeries,
  fetchInstances,
  fetchSeriesLayout,
  prefetchSeries,
  type AppStatus,
  type Study,
  type Series,
  type LutData,
  type SeriesLayoutDto,
} from "../api";
import { ensureCornerstoneInitialized } from "../viewer/cornerstoneSetup";
import {
  findExceeding3dTextureDim,
  getAppliedVolumeMaxMb,
  getMax3dTextureSize,
  isCacheSizeExceeded,
} from "../viewer/volumeMemory";
import { confirmVolumeMemory } from "../viewer/volumeMemoryGuard";
import { rangedStackIds } from "../viewer/rangedStack";
import type { ZRange } from "../viewer/virtualLayout";
import { MIN_SLAB_MM, finestVoxelMm, tooFineForVolumeRendering } from "../viewer/volumeScale";
import { useDeviceClass } from "../mobile/useDeviceClass";
import { imageIdForInstance, imageIdForCell } from "../viewer/imageId";
import { metaData } from "@cornerstonejs/core";
import { buildMprVolume } from "../viewer/mpr";
import { SliceDuplicatesError, sopGridIndexMap, volumeDepthNote, type VolumeDepthNote } from "../viewer/depthVolume";
import { VolumeDepthChip } from "../viewer/VolumeDepthChip";
import { loadRenderEnvSummary } from "../viewer/renderEnvReport";
import { parseRenderQuality, type RenderKind, type RenderQuality } from "../viewer/renderEnv";
import { installDebugApi, publishRender3dStats, publishViewer3dControl } from "../viewer/debugApi";
import { requestOpenSettings } from "../settings/settingsOpenEvents";
import {
  createVtkVolumeView,
  vtkImageDataFromVolume,
  isWebGLContextUnavailable,
  type VtkVolumeView,
  type VtkRenderMode,
  type VtkOpacityPoint,
} from "../viewer/vtkVolumeView";
import { presetLabel } from "../viewer2d/wlPresets";
import { useWlPresets } from "../viewer2d/wlPresetStore";
import { presetsForModality } from "../viewer/transferFunction";
import { LutDialog } from "../viewer/LutDialog";
import { OpacityCurveDialog } from "./OpacityCurveDialog";
import { SceneObjectPanel } from "./SceneObjectPanel";
import { Viewer3DCutOverlay } from "./Viewer3DCutOverlay";
import { Viewer3DMeasureOverlay } from "./Viewer3DMeasureOverlay";
import { Viewer3DEndoPathOverlay } from "./Viewer3DEndoPathOverlay";
import { Viewer3DCinematicOverlay } from "./Viewer3DCinematicOverlay";
import { CenterlineDialog } from "./CenterlineDialog";
import { MeshRepairDialog } from "./MeshRepairDialog";
import { ColorLegend } from "./ColorLegend";
import { legendUnit } from "./legendUnit";
import { resolveValueUnit } from "../viewer/pixelCalibration";
import { Viewer3DMenuBar } from "./Viewer3DMenuBar";
import { CinematicSettingsDialog } from "./CinematicSettingsDialog";
import { SlabPanel } from "./SlabPanel";
import { RepresentationStateDialog } from "./RepresentationStateDialog";
import { ViewInfoOverlay } from "./ViewInfoOverlay";
import { fetchLutData } from "../api";
import { attachSceneRenderer, resetScene, setClipContext, updateClip, setOrthoSlice, setVolumeDepth, setPluginClipPlanes } from "./scene3d";
import { geomFromImageData, type VolumeGeom } from "../viewer/labelVolume";
import { useI18n } from "../i18n/i18n";
import { fetchSettings } from "../settings/settingsApi";
import { hexToRgb01 } from "../viewer/hexColor";
import { VIEWER3D_CTX_KEY, parseViewer3dCtx, shouldApplyPluginView, subscribeViewer3dContext, viewer3dCtxChanged, type Viewer3DPluginView } from "./viewer3dCtx";
import { cameraFromView, validateClipPlanes } from "../viewer/viewer3dCamera";
import { concatFailureMessage, resolveConcatStack } from "../viewer/concatVolume";
import { buildConcatResampledVolume, ConcatResampleError, concatResampleErrorMessage, confirmConcatResampleMemory } from "../viewer/concatResample";
import { concatTileId, type ConcatOpened } from "../viewer/virtualLayout";

interface Viewer3DContext {
  study: Study;
  series?: Series;
  /** 起動元 2D Viewer タイルで表示中だったチャンネルインデックス（無ければ 0）。 */
  c?: number;
  /** 起動元 2D Viewer タイルで表示中だったタイムフレームインデックス（無ければ 0）。 */
  t?: number;
  /** 範囲つきで開いたタイルから起動したとき、ボリュームをこの範囲だけで組む。 */
  range?: ZRange;
  /** 連結して開いたタイルから起動したとき。選んだシリーズから連結を作り直してボリュームにする。 */
  concat?: { parts: ConcatOpened["parts"]; labels: string[] };
  /** プラグインが指定する視点・クリップ面。読み直し（再読込）の判定には使わない。 */
  pluginView?: Viewer3DPluginView;
  ts: number;
}

type Phase = "idle" | "loading" | "ready" | "error" | "unsupported";

/** レイアウトから (c,t) 固定の単一 Z スタック imageIds を取り出す（z 昇順）。 */
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

const MODES: VtkRenderMode[] = ["VR", "MIP", "MINIP", "ORTHO", "SLAB"];

/** モダリティ既定の W/L（CT=40/400、他は scalar 範囲）。 */
function defaultWl(modality: string | null, range: [number, number]): { center: number; width: number } {
  if ((modality ?? "").toUpperCase() === "CT") return { center: 40, width: 400 };
  const [mn, mx] = range;
  // 幅を 1 以上にすると、値域 0.001 の ADC（Parametric Map）が一様に潰れる。
  return { center: (mn + mx) / 2, width: mx > mn ? mx - mn : 1 };
}

export function Viewer3DScreen({ status }: { status: AppStatus | null }) {
  const isDemo = status?.demo === true;
  const { t } = useI18n();
  const presets = useWlPresets();
  const vpRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<VtkVolumeView | null>(null);
  const startedRef = useRef(false);
  const wlDefaultRef = useRef<{ center: number; width: number }>({ center: 40, width: 400 });

  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState<string>("");
  const [title, setTitle] = useState<string>("");
  const [tilt, setTilt] = useState<number | null>(null);
  // 体積のスライス順の SOP → k（2D の ROI を描かれている画像に合わせて載せる）と、間隔が不均一なときの各間隔。
  const [sopToK, setSopToK] = useState<Map<string, number> | undefined>(undefined);
  const [depthNote, setDepthNote] = useState<VolumeDepthNote | null>(null);
  // 描画の種別（ソフトウェア描画のときだけヘッダに印を出す。fw/render-environment-design.md）。
  const [renderKind, setRenderKind] = useState<RenderKind | null>(null);
  // 設定「3D の画質」（シネマティックの操作中の縮小にも効く。full は常に全解像度）。
  const [renderQuality, setRenderQuality] = useState<RenderQuality>("auto");
  const [gpuMemoryMb, setGpuMemoryMb] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    void loadRenderEnvSummary().then((v) => {
      if (alive) setRenderKind(v.kind);
    });
    return () => {
      alive = false;
    };
  }, []);
  // automator 用: このウィンドウでも window.__graphyDebug を用意し、3D の描画の実測を読めるようにする（dev ビルドのみ）。
  useEffect(() => {
    installDebugApi();
    publishRender3dStats(() => viewRef.current?.getRenderStats() ?? null);
    // 視点・クリップ面を読み書きする口（dev のみ。視点の検査用。画面の挙動は変えない）。
    publishViewer3dControl({
      getState: () => {
        const v = viewRef.current;
        if (!v) throw new Error("3D is not ready");
        const st = v.getState();
        const d = [st.focalPoint[0] - st.position[0], st.focalPoint[1] - st.position[1], st.focalPoint[2] - st.position[2]];
        const n = Math.hypot(d[0], d[1], d[2]) || 1;
        return {
          position: st.position,
          focalPoint: st.focalPoint,
          viewUp: st.viewUp,
          parallelScale: st.parallelScale,
          direction: [d[0] / n, d[1] / n, d[2] / n],
          clipPlanes: v.getClipPlanes(),
        };
      },
      applyCamera: (req) => {
        const v = viewRef.current;
        return v ? v.applyCamera(req) : { ok: false, reason: "3D is not ready" };
      },
      setClipPlanes: (planes) => {
        const v = viewRef.current;
        return v ? v.setClipPlanes(planes) : { ok: false, reason: "3D is not ready" };
      },
      render: () => viewRef.current?.render(),
    });
    return () => {
      publishRender3dStats(null);
      publishViewer3dControl(null);
    };
  }, []);
  const [mode, setMode] = useState<VtkRenderMode>("VR");
  const [orthoPos, setOrthoPos] = useState<{ x: number; y: number; z: number }>({ x: 0.5, y: 0.5, z: 0.5 });
  const [lutName, setLutName] = useState<string | null>(null);
  const [opacityPts, setOpacityPts] = useState<VtkOpacityPoint[]>([]);
  const [clipOn, setClipOn] = useState(false);
  const [lutOpen, setLutOpen] = useState(false);
  const [curveOpen, setCurveOpen] = useState(false);
  const [cinematicOpen, setCinematicOpen] = useState(false);
  // プラグインが指定した視点・クリップ面（札・［指定に戻す］・クリップ面の一覧）。
  const [pluginView, setPluginView] = useState<{
    view: Viewer3DPluginView;
    /** 適用のあとに利用者が視点を動かした（向きスナップ・Reset View・マウス操作）。 */
    away: boolean;
    /** 検証で拒否された理由（拒否したときは何も変えていない）。 */
    error: string | null;
    /** クリップ面ごとの ON/OFF。 */
    clipEnabled: boolean[];
  } | null>(null);
  const appliedSeqRef = useRef<number | null>(null);
  const modeRef = useRef<VtkRenderMode>("VR");
  const phaseRef = useRef<Phase>("idle");
  const applyingRef = useRef(false);
  const appliedCamRef = useRef<{ position: number[]; viewUp: number[] } | null>(null);
  const applyPluginViewRef = useRef<(pv: Viewer3DPluginView) => void>(() => undefined);
  const pluginViewRef = useRef<typeof pluginView>(null);
  // 狭幅・タッチ端末では固定幅 240px の右パネルをドロワーに落とす（fw/mobile-ui-design.md §4.2）。
  // 判定は端末クラス。手動でデスクトップ UI を選んでいれば従来どおり常設パネルのまま。
  const { uiMode } = useDeviceClass();
  const narrow = uiMode === "mobile";
  const [panelOpen, setPanelOpen] = useState(false);
  const [reprOpen, setReprOpen] = useState(false);
  const [rotateMode, setRotateMode] = useState<"camera" | "actor">("camera");
  const [presetName, setPresetName] = useState<string>("none");
  const modalityRef = useRef<string | null>(null);
  // 派生シリーズ保存（CPR/ストレート化）用の study/series 識別子。
  const seriesRef = useRef<{ studyUid: string; seriesUid: string; seriesDesc: string; c: number; t: number } | null>(null);
  // 起動時に読んだコンテキスト。別シリーズ/C/T で 2D から再起動されたかの判定に使う。
  const ctxRef = useRef<Viewer3DContext | null>(null);
  const [volumeId, setVolumeId] = useState<string>("");
  // 表示ボリュームの実空間幾何（mesh→ROI ボクセル化の対象）。
  const [sceneGeom, setSceneGeom] = useState<VolumeGeom | null>(null);
  // 3D Cut（lasso）対象 ROI の id（null=カット非アクティブ）。
  const [cutTargetId, setCutTargetId] = useState<string | null>(null);
  // 3D 計測（ルーラー）モード。
  const [measureMode, setMeasureMode] = useState(false);
  // 向きスナップの「反対側から」トグル（全モード共通）。
  const [snapFlip, setSnapFlip] = useState(false);
  // 手動内視鏡経路 編集モード。
  const [endoPathMode, setEndoPathMode] = useState(false);
  // 中心線解析ダイアログ対象（ROI/メッシュ）。
  const [analyzeTarget, setAnalyzeTarget] = useState<{ id: string; name: string } | null>(null);
  // メッシュ修復ダイアログ対象。
  const [repairTarget, setRepairTarget] = useState<{ id: string; name: string } | null>(null);
  // カラーレジェンド overlay 表示。
  const [legendOn, setLegendOn] = useState(false);
  // 凡例の単位（3D のボリュームの実際の単位）。ボリュームを作ったあとに決める。
  const [legendUnitText, setLegendUnitText] = useState("");
  // Cinematic v2（パストレース）オーバーレイ表示。
  const [pathTraceOn, setPathTraceOn] = useState(false);

  // カット/計測/経路編集は排他（同時にオーバーレイがクリックを奪い合わないように）。
  const startCut = useCallback((id: string) => {
    setMeasureMode(false);
    setEndoPathMode(false);
    setCutTargetId(id);
  }, []);
  const toggleMeasure = useCallback(() => {
    setCutTargetId(null);
    setEndoPathMode(false);
    setMeasureMode((v) => !v);
  }, []);
  const toggleEndoPath = useCallback(() => {
    setCutTargetId(null);
    setMeasureMode(false);
    setEndoPathMode((v) => !v);
  }, []);
  const analyzeCenterline = useCallback((id: string, name: string) => {
    setMeasureMode(false);
    setEndoPathMode(false);
    setCutTargetId(null);
    setAnalyzeTarget({ id, name });
  }, []);

  const mode2 = status?.mode === "standalone" ? "standalone" : "web";

  const start = useCallback(async () => {
    let ctx: Viewer3DContext | null = null;
    try {
      ctx = parseViewer3dCtx<Viewer3DContext>(localStorage.getItem(VIEWER3D_CTX_KEY));
    } catch {
      ctx = null;
    }
    ctxRef.current = ctx;
    if (!ctx?.study) {
      setPhase("error");
      setMessage(t("viewer3d.noContext"));
      return;
    }
    // web も対応: imageId は BFF(WADO-RS) 経由の wadouri。ボリューム構築は cornerstone が
    // 各スライスを BFF から読み込む（standalone と同一経路）。描画は pure vtk.js。

    setPhase("loading");
    setMessage(t("viewer3d.loading"));

    try {
      await ensureCornerstoneInitialized();

      let series = ctx.series;
      if (!series) {
        const list = await fetchSeries(ctx.study.studyInstanceUid);
        series = list.slice().sort((a, b) => b.numberOfInstances - a.numberOfInstances)[0];
      }
      if (!series) {
        setPhase("error");
        setMessage(t("viewer3d.noSeries"));
        return;
      }
      // 連結: 複数のシリーズにまたがるので、1 本のシリーズに紐づく機能（2D の ROI・サーバー上のオブジェクト・
      // 中心線の派生シリーズ保存）は出さない（seriesRef を持たない）。
      const cc = ctx.concat ? await resolveConcatStack(ctx.concat.parts, mode2) : null;
      if (cc && !cc.ok) {
        setPhase("error");
        setMessage(concatFailureMessage(cc, t));
        return;
      }
      // 面内の格子が違う連結: 元のスライスを並べず、共通の格子へ再サンプルしたメモリ内ボリュームにする。
      const rs = cc?.ok && cc.kind === "resample" ? cc : null;
      setTitle(ctx.concat ? ctx.concat.labels.join(" + ") : series.seriesDescription || series.seriesInstanceUid);
      modalityRef.current = series.modality;
      seriesRef.current = ctx.concat ? null : {
        studyUid: ctx.study.studyInstanceUid,
        seriesUid: series.seriesInstanceUid,
        seriesDesc: series.seriesDescription || series.seriesInstanceUid,
        c: ctx.c ?? 0,
        t: ctx.t ?? 0,
      };

      // 起動元タイルで表示中だった C/T のスタックのみをボリューム化する（マルチチャンネル/
      // マルチタイムフレームのシリーズで異なる C/T の画像が混在するのを防ぐ）。
      let imageIds: string[];
      // メモリ量の事前予測に使う（layout が取れなかったフォールバック経路では予測しない）。
      let guardLayout: SeriesLayoutDto | null = null;
      if (cc?.ok) {
        guardLayout = cc.dto;
        imageIds = cc.kind === "stack" ? cc.imageIds : [];
      } else try {
        const layout = await fetchSeriesLayout(ctx.study.studyInstanceUid, series.seriesInstanceUid);
        const c0 = Math.min(Math.max(0, ctx.c ?? 0), Math.max(0, layout.nC - 1));
        const t0 = Math.min(Math.max(0, ctx.t ?? 0), Math.max(0, layout.nT - 1));
        guardLayout = layout;
        if (seriesRef.current) seriesRef.current = { ...seriesRef.current, c: c0, t: t0 };
        if (ctx.range) {
          // 範囲つき: 全体に黙って戻さない（フォールバックもしない）。
          const ranged = rangedStackIds(layout, mode2, ctx.study.studyInstanceUid, series.seriesInstanceUid, c0, t0, ctx.range);
          if (!ranged.ok) {
            setPhase("error");
            setMessage(t(`series.range.fail.${ranged.reason}`));
            return;
          }
          imageIds = ranged.imageIds;
        } else {
          imageIds = imageIdsForCT(layout, mode2, c0, t0, ctx.study.studyInstanceUid, series.seriesInstanceUid);
        }
        if (!ctx.range && imageIds.length < 3 && layout.nC <= 1 && layout.nT <= 1) {
          const instances = await fetchInstances(ctx.study.studyInstanceUid, series.seriesInstanceUid);
          imageIds = instances.map((i) =>
            imageIdForInstance(mode2, i.sopInstanceUid, ctx.study.studyInstanceUid, series.seriesInstanceUid),
          );
        }
      } catch {
        if (ctx.range) {
          // 範囲つきでレイアウトが取れないときは、全体を組まずに止める。
          setPhase("error");
          setMessage(t("series.range.fail.invalid"));
          return;
        }
        const instances = await fetchInstances(ctx.study.studyInstanceUid, series.seriesInstanceUid);
        imageIds = instances.map((i) =>
          imageIdForInstance(mode2, i.sopInstanceUid, ctx.study.studyInstanceUid, series.seriesInstanceUid),
        );
      }
      if (!rs && imageIds.length < 3) {
        setPhase("error");
        setMessage(t("viewer3d.needVolume"));
        return;
      }
      if (tooFineForVolumeRendering(guardLayout)) {
        // ボクセルが描画ライブラリの最小のスラブより細かい（顕微鏡など）。組んでも真っ黒になるので、理由を出して止める
        setPhase("error");
        setMessage(t("volume.tooFine", { voxel: String(finestVoxelMm(guardLayout)?.toPrecision(3)), min: String(MIN_SLAB_MM) }));
        return;
      }

      // ボリューム構築で確保しようとする量を先に見積もり、バジェットを超えるなら確認する
      // （fw/volume-memory-guard.md V2）。予測不能・警告 OFF・利用者が続行なら素通り。
      const memDecision = rs ? { proceed: confirmConcatResampleMemory(rs.plan, t), enforceMaxBytes: undefined } : await confirmVolumeMemory({
        layout: guardLayout,
        sliceCount: imageIds.length,
        modality: series.modality,
        target: "viewer3d",
        t18n: t,
      });
      if (!memDecision.proceed) {
        // キャンセル時はビューア画面が空のままになるので、理由を出しておく。
        setPhase("error");
        setMessage(t("common.volumeMemCanceled"));
        return;
      }

      // web: 全スライスを 1 リクエストで BFF キャッシュに載せてから volume 構築（個別 WADO-RS 往復を回避）。
      if (mode2 === "web") {
        for (const p of ctx.concat?.parts ?? [{ study: ctx.study, series }]) {
          try {
            await prefetchSeries(p.study.studyInstanceUid, p.series.seriesInstanceUid);
          } catch {
            /* prefetch は最適化。失敗しても個別取得で続行 */
          }
        }
      }

      const volId = `graphy-viewer3d-vol:${ctx.concat ? concatTileId(ctx.concat.parts.map((p) => ({ study: p.study.studyInstanceUid, series: p.series.seriesInstanceUid }))) : series.seriesInstanceUid}`;
      const built = rs
        ? await buildConcatResampledVolume({
            mode: mode2, sources: ctx.concat!.parts, parts: rs.parts, plan: rs.plan, volumeId: volId,
            onProgress: (f) => setMessage(t("concat.resampling", { pct: Math.round(f * 100) })),
          })
        : await buildMprVolume(imageIds, series.modality, volId, {
        maxBytes: memDecision.enforceMaxBytes,
      });
      setTilt(built.corrected ? (built.tiltAngleDeg ?? null) : null);
      if (built.sortedImageIds) {
        const ids = built.sortedImageIds;
        // 体積のスライス順の SOP → 格子番号（2D の ROI を、描かれている画像と同じスライスに載せる。補間した面には載せない）。
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const sops = ids.map((id) => ((metaData.get("sopCommonModule", id) ?? {}) as any).sopInstanceUID as string | undefined);
        setSopToK(sopGridIndexMap(sops, built.grid?.gridIndexOf));
      } else {
        setSopToK(undefined);
      }
      setDepthNote(volumeDepthNote(built.geometry, built.grid));
      setVolumeDepth({
        gridIndexOf: built.grid?.gridIndexOf ?? (built.sortedImageIds ? built.geometry.order.map((_, i) => i) : undefined),
        widths: built.geometry.widths,
        positions: built.geometry.positions.map((p) => p - built.geometry.positions[0]),
        gridCount: built.grid?.count ?? built.geometry.positions.length,
        source: built.geometry.source,
        kind: built.geometry.kind,
      });
      setVolumeId(volId);
      // 先頭スライスのメタデータ（RescaleType）から単位を決める。imageId が無い連結の再サンプルはモダリティ既定。
      const firstId = built.sortedImageIds?.[0];
      setLegendUnitText(legendUnit(firstId ? resolveValueUnit(firstId) : undefined, series.modality));

      // Cornerstone が構築したボリュームから scalar 付き vtkImageData を組み立てて pure vtk へ渡す
      // （streaming volume の imageData は scalar を pointData に持たないため作り直す）。
      const imageData = vtkImageDataFromVolume(volId);
      if (!vpRef.current || !imageData) {
        setPhase("error");
        setMessage(t("viewer3d.error"));
        return;
      }

      // GPU の 3D テクスチャ寸法上限を超えるボリュームは、続行してもテクスチャ確保に失敗して
      // 無言で真っ黒になるだけなので、警告ではなくエラーで止める（fw/volume-memory-guard.md V4）。
      // RAM のバジェットとは別の天井であることに注意（枚数が少なくても面内が大きければ超える）。
      const maxTexDim = getMax3dTextureSize();
      const overDim = findExceeding3dTextureDim(imageData.getDimensions?.(), maxTexDim);
      if (overDim !== null) {
        setPhase("error");
        setMessage(
          t("viewer3d.texture3dTooLarge", { dim: String(overDim), maxDim: String(maxTexDim) }),
        );
        return;
      }

      // scalar 範囲から既定 W/L を決める。
      let range: [number, number] = [0, 1];
      try {
        const r = imageData.getPointData().getScalars().getRange();
        if (Array.isArray(r) && r.length >= 2) range = [r[0], r[1]];
      } catch {
        /* ignore */
      }
      const wl = defaultWl(series.modality, range);
      wlDefaultRef.current = wl;

      const view = createVtkVolumeView(vpRef.current, imageData, {
        mode: "VR",
        center: wl.center,
        width: wl.width,
      });
      viewRef.current = view;
      // 背景色（環境設定）。読めなければ黒のまま。設定を変えたら開き直すと反映する（2D と同じ）。
      fetchSettings()
        .then((m) => {
          if (viewRef.current !== view) return;
          view.setBackground(hexToRgb01(m["viewer3d.background"]));
          const gpuMb = Number(m["viewer3d.gpuMemoryMb"]);
          setGpuMemoryMb(Number.isFinite(gpuMb) && gpuMb > 0 ? gpuMb : null);
          const quality = parseRenderQuality(m["viewer3d.renderQuality"]);
          view.setRenderQuality(quality);
          setRenderQuality(quality);
        })
        .catch(() => undefined);
      // mesh / 3D ROI アクターを同一 vtk シーンへ重畳するため renderer を接続。
      try {
        const parts = view.getSceneParts();
        attachSceneRenderer({
          renderer: parts.renderer,
          render: parts.render,
          setVolumeOpacityScale: (f) => view.setOpacityScale(f),
        });
        const geom = geomFromImageData(parts.imageData);
        setSceneGeom(geom);
        // クリップ箱（埋め込み表示）の基準幾何を設定し、クロップ変化を購読して
        // 埋め込みオブジェクトをボリュームと一緒にカットする。
        setClipContext(geom);
        view.subscribeClip((extent) => updateClip(extent));
      } catch {
        /* シーン重畳が使えなくてもボリューム表示は継続 */
      }
      setPhase("ready");
    } catch (e) {
      setPhase("error");
      // WebGL コンテキストを取れない場合は原因が分かる案内にする（vtk.js の生の
      // "Cannot create proxy with a non-object..." では利用者が対処できない）。
      // 同様に、キャッシュ上限超過も対処を書いた案内に差し替える（fw/volume-memory-guard.md V1）。
      setMessage(
        isWebGLContextUnavailable(e)
          ? t("viewer3d.glLost")
          : isCacheSizeExceeded(e)
            ? t("common.volumeMemExceeded", { budgetMb: String(getAppliedVolumeMaxMb()) })
            : e instanceof ConcatResampleError
              ? concatResampleErrorMessage(e, t)
              : e instanceof SliceDuplicatesError
                ? t("volumeDepth.duplicates")
                : `${t("viewer3d.error")}: ${String(e)}`,
      );
    }
  }, [mode2, t]);

  // 3D ウィンドウが開いたまま 2D から別のシリーズ/C/T で再起動されたら、新しいコンテキストで読み込み直す。
  // 状態（ボリューム・シーンオブジェクト・各種オーバーレイ）が多いので、個別に初期化せず画面ごと再読込する。
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== VIEWER3D_CTX_KEY) return;
      const next = parseViewer3dCtx<Viewer3DContext>(e.newValue);
      if (viewer3dCtxChanged(ctxRef.current, next)) window.location.reload();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // プラグインが指定した視点・クリップ面。開いた直後（ready 後）と、開いたまま更新されたとき（通知）に適用する。
  // 同じシリーズのままなら読み直さず、視点と札だけが変わる（置いた計測・メッシュは残る）。
  useEffect(() => {
    if (phase !== "ready") return;
    const pv = ctxRef.current?.pluginView;
    if (shouldApplyPluginView(appliedSeqRef.current, pv)) applyPluginViewRef.current(pv!);
  }, [phase]);

  useEffect(() => {
    return subscribeViewer3dContext(() => {
      const next = parseViewer3dCtx<Viewer3DContext>(localStorage.getItem(VIEWER3D_CTX_KEY));
      if (!next || viewer3dCtxChanged(ctxRef.current, next)) return; // シリーズが変わったなら、既存の再読込（storage）に任せる
      ctxRef.current = next;
      if (phaseRef.current === "ready" && shouldApplyPluginView(appliedSeqRef.current, next.pluginView)) {
        applyPluginViewRef.current(next.pluginView!);
      }
    });
  }, []);

  // 適用のあとに視点が動いたら（向きスナップ・Reset View・マウス操作）札に「離れた」印を付ける。
  useEffect(() => {
    if (phase !== "ready") return;
    const view = viewRef.current;
    if (!view) return;
    return view.onStateChanged(() => {
      if (applyingRef.current || !appliedCamRef.current) return;
      const st = view.getState();
      const a = appliedCamRef.current;
      const moved = [...st.position, ...st.viewUp].some((v, i) => Math.abs(v - [...a.position, ...a.viewUp][i]) > 1e-6);
      if (moved) setPluginView((cur) => (cur && !cur.away ? { ...cur, away: true } : cur));
    });
  }, [phase]);

  useEffect(() => {
    if (startedRef.current || !status) return;
    startedRef.current = true;
    void start();
  }, [status, start]);

  // アンマウント時に vtk を破棄。
  useEffect(() => {
    return () => {
      try {
        resetScene();
      } catch {
        /* ignore */
      }
      try {
        viewRef.current?.destroy();
      } catch {
        /* ignore */
      }
      viewRef.current = null;
    };
  }, []);

  // 現在のビューを破棄して 3D 表示を作り直す（コンテキスト喪失やビルド失敗からの復帰）。
  const retry = useCallback(() => {
    try {
      resetScene();
    } catch {
      /* ignore */
    }
    try {
      viewRef.current?.destroy();
    } catch {
      /* ignore */
    }
    viewRef.current = null;
    setSceneGeom(null);
    setPhase("idle");
    setMessage("");
    void start();
  }, [start]);

  // WebGL コンテキスト喪失を検知して案内する。
  // ⚠️ vtk.js は webglcontextlost を preventDefault するだけで復帰処理をしないため、
  // 何もしないと「真っ白なパネル」のまま操作不能になる（原因が利用者に分からない）。
  // 喪失したビューはここで破棄し、コンテキスト枠を解放してから再構築できるようにする。
  useEffect(() => {
    if (phase !== "ready" || !vpRef.current) return;
    const canvas = vpRef.current.querySelector("canvas");
    if (!canvas) return;
    const onLost = () => {
      setPhase("error");
      setMessage(t("viewer3d.glLost"));
      try {
        resetScene();
      } catch {
        /* ignore */
      }
      try {
        viewRef.current?.destroy();
      } catch {
        /* ignore */
      }
      viewRef.current = null;
    };
    canvas.addEventListener("webglcontextlost", onLost);
    return () => canvas.removeEventListener("webglcontextlost", onLost);
  }, [phase, t]);

  // コンテナのリサイズに追従。
  useEffect(() => {
    if (phase !== "ready" || !vpRef.current) return;
    const ro = new ResizeObserver(() => viewRef.current?.resize());
    ro.observe(vpRef.current);
    return () => ro.disconnect();
  }, [phase]);

  // Ortho（3直交スライス）表示中は、embedded な ROI/メッシュをクリップ箱ではなく
  // 現在のスライス位置でカットするため、モード/スライス位置/幾何の変化を scene3d へ通知する。
  useEffect(() => {
    if (mode !== "ORTHO" || !sceneGeom) {
      setOrthoSlice(false, null);
      return;
    }
    const dims = sceneGeom.dims;
    const idx: [number, number, number] = [
      Math.max(0, Math.min(dims[0] - 1, Math.round(orthoPos.x * (dims[0] - 1)))),
      Math.max(0, Math.min(dims[1] - 1, Math.round(orthoPos.y * (dims[1] - 1)))),
      Math.max(0, Math.min(dims[2] - 1, Math.round(orthoPos.z * (dims[2] - 1)))),
    ];
    setOrthoSlice(true, idx);
  }, [mode, orthoPos, sceneGeom]);

  modeRef.current = mode;
  phaseRef.current = phase;
  pluginViewRef.current = pluginView;

  /** 面の ON/OFF を反映してボリュームとメッシュへ渡す。 */
  const pushClipPlanes = (planes: NonNullable<Viewer3DPluginView["clipPlanes"]>, enabled: boolean[]) => {
    const on = planes.filter((_, i) => enabled[i] !== false).map((p) => ({ origin: p.origin, normal: p.normal }));
    viewRef.current?.setClipPlanes(on);
    setPluginClipPlanes(on);
  };

  /**
   * プラグインが指定した視点・クリップ面を適用する。**先に全部検証し、拒否なら何も変えない**。
   * 順序: モード → プリセット → 視点 → クリップ面。
   */
  const applyPluginView = (pv: Viewer3DPluginView) => {
    const view = viewRef.current;
    if (!view) return;
    // 拒否したら今の指定（札・面）は変えず、理由だけを札に出す。最初の指定が拒否されたときだけ、その指定を札の元にする。
    const reject = (reason: string) =>
      setPluginView((prev) => (prev ? { ...prev, error: reason } : { view: pv, away: false, error: reason, clipEnabled: [] }));
    // 検証（何も変えない）
    if (pv.camera) {
      const c = pv.camera;
      const r = cameraFromView({ direction: c.direction, up: c.up, focalPoint: c.focalPoint ?? [0, 0, 0], distanceMm: c.distanceMm ?? 1 });
      if (!r.ok) return reject(r.reason);
    }
    if (pv.clipPlanes) {
      const r = validateClipPlanes(pv.clipPlanes);
      if (!r.ok) return reject(r.reason);
    }
    appliedSeqRef.current = pv.seq;
    applyingRef.current = true;
    try {
      if (pv.mode && pv.mode !== modeRef.current) onMode(pv.mode);
      if (pv.preset !== undefined) onPreset(pv.preset);
      if (pv.camera) {
        const c = pv.camera;
        let focal = c.focalPoint ?? pv.clipPlanes?.[0]?.origin;
        if (!focal) {
          const b = view.getSceneParts().imageData.getBounds() as number[];
          focal = [(b[0] + b[1]) / 2, (b[2] + b[3]) / 2, (b[4] + b[5]) / 2];
        }
        const res = view.applyCamera({
          direction: c.direction,
          up: c.up,
          focalPoint: focal,
          distanceMm: c.distanceMm,
          projection: c.projection,
          parallelScaleMm: c.parallelScaleMm,
        });
        if (!res.ok) return reject(res.reason);
      }
      let clipEnabled: boolean[] = pluginViewRef.current?.clipEnabled ?? [];
      if (pv.clipPlanes) {
        clipEnabled = pv.clipPlanes.map(() => true);
        pushClipPlanes(pv.clipPlanes, clipEnabled);
      } else if (pluginViewRef.current?.view.clipPlanes) {
        // クリップ面を省略した更新は「変えない」。前の面と ON/OFF をそのまま持ち越す。
        pv = { ...pv, clipPlanes: pluginViewRef.current.view.clipPlanes };
      }
      const st = view.getState();
      appliedCamRef.current = { position: [...st.position], viewUp: [...st.viewUp] };
      setPluginView({ view: pv, away: false, error: null, clipEnabled });
    } finally {
      applyingRef.current = false;
    }
  };
  applyPluginViewRef.current = applyPluginView;

  const onClearPluginView = () => {
    viewRef.current?.setClipPlanes([]);
    setPluginClipPlanes([]);
    setPluginView(null);
  };

  const onTogglePluginClip = (i: number, on: boolean) => {
    const cur = pluginView;
    if (!cur?.view.clipPlanes) return;
    const enabled = cur.clipEnabled.map((v, k) => (k === i ? on : v));
    pushClipPlanes(cur.view.clipPlanes, enabled);
    setPluginView({ ...cur, clipEnabled: enabled });
  };

  const onMode = (next: VtkRenderMode) => {
    setMode(next);
    setOpacityPts([]); // モード変更で手動不透明度カーブは解除（view 側も解除される）
    // VR プリセットは VR 専用。モード変更時は解除してから切替（MIP/MinIP の TF を正しく適用）。
    setPresetName("none");
    viewRef.current?.applyPreset(null);
    viewRef.current?.setMode(next);
    if (next === "ORTHO") viewRef.current?.setOrthoPositions(orthoPos.x, orthoPos.y, orthoPos.z);
  };

  // VR プリセット（色/不透明度 TF）。"none" でグレースケール/W-L へ。
  const onPreset = (value: string) => {
    setPresetName(value);
    viewRef.current?.applyPreset(value === "none" ? null : value);
  };

  // Ortho の各軸スライス位置（0..1）。
  const onOrthoChange = (axis: "x" | "y" | "z", val: number) => {
    const next = { ...orthoPos, [axis]: val };
    setOrthoPos(next);
    viewRef.current?.setOrthoPositions(next.x, next.y, next.z);
  };

  const onSelectLut = (lut: LutData | null) => {
    setLutName(lut ? lut.name : null);
    viewRef.current?.setColorLut(lut ? { r: lut.r, g: lut.g, b: lut.b } : null);
  };

  const onOpacityChange = (points: VtkOpacityPoint[]) => {
    setOpacityPts(points);
    viewRef.current?.setOpacityPoints(points);
  };

  const onWlPreset = (value: string) => {
    const view = viewRef.current;
    if (!view) return;
    if (value === "default") {
      const wl = wlDefaultRef.current;
      view.setWindowLevel(wl.center, wl.width);
    } else {
      const p = presets.find((x) => x.key === value);
      if (p) view.setWindowLevel(p.center, p.width);
    }
  };

  const onToggleClip = () => {
    const next = !clipOn;
    setClipOn(next);
    viewRef.current?.setClipEnabled(next);
  };

  const onResetView = () => {
    const view = viewRef.current;
    if (!view) return;
    // 視点＋コントラスト＋TF＋クリップを初期状態へ。
    view.resetView();
    const wl = wlDefaultRef.current;
    view.setWindowLevel(wl.center, wl.width);
    view.setColorLut(null);
    view.setOpacityPoints(null);
    view.setClipEnabled(false);
    setLutName(null);
    setOpacityPts([]);
    setClipOn(false);
  };

  const onSetRotate = (m: "camera" | "actor") => {
    setRotateMode(m);
    viewRef.current?.setRotateMode(m);
  };

  // Representation State ダイアログからの適用: 幾何は view 側で反映済み。ここではモードと LUT を同期。
  const onApplyReprState = (patch: { mode: VtkRenderMode; lutName: string | null }) => {
    if (patch.mode !== mode) {
      setMode(patch.mode);
      setOpacityPts([]);
      viewRef.current?.setMode(patch.mode);
      if (patch.mode === "ORTHO") viewRef.current?.setOrthoPositions(orthoPos.x, orthoPos.y, orthoPos.z);
    }
    if (patch.lutName !== lutName) {
      if (!patch.lutName) {
        onSelectLut(null);
      } else {
        fetchLutData(patch.lutName)
          .then((d) => onSelectLut(d))
          .catch(() => {
            /* ignore */
          });
      }
    }
  };

  const busy = phase === "loading" || phase === "idle";

  return (
    <div style={root}>
      <div style={header}>
        {/* 狭幅では別ウィンドウではなく同一タブの hash 遷移で来るので、戻る導線を出す。 */}
        {narrow && (
          <button
            style={backBtn}
            onClick={() => window.history.back()}
            aria-label={t("mobile.back")}
            data-testid="viewer3d-back"
          >
            ‹
          </button>
        )}
        <span style={hTitle}>{t("main.toolbar.viewer3d")}</span>
        {title && <span style={hSeries}>{title}</span>}
        {renderKind === "software" && (
          <button
            style={softwareBadge}
            onClick={() => requestOpenSettings("renderEnv")}
            title={t("viewer3d.softwareBadgeHint")}
            data-testid="viewer3d-software-badge"
          >
            ⚠ {t("viewer3d.softwareBadge")}
          </button>
        )}
        <VolumeDepthChip note={depthNote} style={tiltChip} />
        {tilt !== null && (
          <span style={tiltChip} title={t("mpr.tiltCorrectedHint")}>
            {t("mpr.tiltCorrected", { deg: tilt.toFixed(1) })}
          </span>
        )}
        {pluginView && (
          <span style={pluginBadge} data-testid="viewer3d-plugin-view-badge" data-away={pluginView.away ? "1" : "0"} data-error={pluginView.error ? "1" : "0"}>
            🧩 {t("viewer3d.pluginView.badge", { plugin: pluginView.view.provenance.pluginName, title: pluginView.view.provenance.title ?? "" })}
            {pluginView.away && <span style={pluginBadgeWarn}> · {t("viewer3d.pluginView.away")}</span>}
            {pluginView.error && <span style={pluginBadgeErr}> · {t("viewer3d.pluginView.rejected", { reason: pluginView.error })}</span>}
            {cinematicOpen && (pluginView.view.clipPlanes?.length ?? 0) > 0 && (
              <span style={pluginBadgeWarn}> · {t("viewer3d.pluginView.cinematicNote")}</span>
            )}
            <button
              style={pluginBadgeBtn}
              onClick={() => applyPluginView({ ...pluginView.view, seq: (appliedSeqRef.current ?? pluginView.view.seq) })}
              title={t("viewer3d.pluginView.restoreHint")}
              data-testid="viewer3d-plugin-view-restore"
            >
              {t("viewer3d.pluginView.restore")}
            </button>
            <button style={pluginBadgeBtn} onClick={onClearPluginView} title={t("viewer3d.pluginView.clearHint")} data-testid="viewer3d-plugin-view-clear">
              ×
            </button>
          </span>
        )}
        {narrow && phase === "ready" && (
          <button
            style={panelOpenBtn}
            onClick={() => setPanelOpen(true)}
            data-testid="viewer3d-panel-open"
          >
            {t("viewer3d.panel")}
          </button>
        )}
      </div>
      {phase === "ready" && (
        <Viewer3DMenuBar
          onOpenCinematic={() => setCinematicOpen(true)}
          onOpenReprState={() => setReprOpen(true)}
          rotateMode={rotateMode}
          onSetRotate={onSetRotate}
        />
      )}
      <div style={bodyWrap}>
        <div style={body}>
          <div
            ref={vpRef}
            style={vpEl}
            onContextMenu={(e) => e.preventDefault()}
            onDoubleClick={(e) => {
              // Slab: ダブルクリックした構造（MIP=最大/MinIP=最小の深さ）を回転中心＝スラブ中心に。
              if (mode !== "SLAB" || measureMode || !viewRef.current) return;
              const r = e.currentTarget.getBoundingClientRect();
              viewRef.current.pickSlabCenterAt(e.clientX - r.left, e.clientY - r.top, r.width, r.height);
            }}
          />
          {phase === "ready" && mode === "SLAB" && (
            // 平行投影では回転中心（焦点）が常に画面中央に写るので、中央に十字で示す。
            <div style={centerMark} data-testid="viewer3d-slab-center-mark" aria-hidden />
          )}
          {phase === "ready" && viewRef.current && (
            <ViewInfoOverlay view={viewRef.current} lutName={lutName} />
          )}
          {phase === "ready" && viewRef.current && (
            <Viewer3DCinematicOverlay
              view={viewRef.current}
              active={pathTraceOn}
              renderKind={renderKind}
              quality={renderQuality}
              gpuMemoryMb={gpuMemoryMb}
              onCancel={() => setPathTraceOn(false)}
            />
          )}
          {phase === "ready" && viewRef.current && (
            <Viewer3DMeasureOverlay view={viewRef.current} active={measureMode} />
          )}
          {phase === "ready" && viewRef.current && (
            <Viewer3DEndoPathOverlay
              view={viewRef.current}
              active={endoPathMode}
              onExit={() => setEndoPathMode(false)}
            />
          )}
          {phase === "ready" && viewRef.current && cutTargetId && (
            <Viewer3DCutOverlay
              view={viewRef.current}
              targetId={cutTargetId}
              onDone={() => setCutTargetId(null)}
            />
          )}
          {phase === "ready" && viewRef.current && analyzeTarget && volumeId && seriesRef.current && (
            <CenterlineDialog
              view={viewRef.current}
              objectId={analyzeTarget.id}
              volumeId={volumeId}
              geom={sceneGeom}
              studyUid={seriesRef.current.studyUid}
              seriesUid={seriesRef.current.seriesUid}
              seriesDesc={seriesRef.current.seriesDesc}
              modality={modalityRef.current}
              onClose={() => setAnalyzeTarget(null)}
            />
          )}
          {phase === "ready" && viewRef.current && legendOn && (
            <ColorLegend
              view={viewRef.current}
              lutName={lutName}
              unit={legendUnitText}
              corner="tr"
              onClose={() => setLegendOn(false)}
            />
          )}
          {phase === "ready" && repairTarget && (
            <MeshRepairDialog objectId={repairTarget.id} onClose={() => setRepairTarget(null)} />
          )}
          {phase !== "ready" && (
            <div style={overlay}>
              <div style={overlayBox}>
                {busy ? t("viewer3d.loading") : message}
                {phase === "error" && (
                  <div style={{ marginTop: 12 }}>
                    <button style={modeBtn} onClick={retry}>
                      {t("viewer3d.retry")}
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
        {/*
         * 狭幅では固定幅 240px の右パネルが画像を潰すのでドロワーにする
         * （fw/mobile-ui-design.md §4.2）。中身は共通で、器だけ差し替える。
         */}
        {phase === "ready" && (!narrow || panelOpen) && (
          <>
            {narrow && <div style={panelScrim} onClick={() => setPanelOpen(false)} />}
          <div style={narrow ? panelDrawer : panel}>
            {narrow && (
              <button
                style={panelCloseBtn}
                onClick={() => setPanelOpen(false)}
                aria-label={t("common.close")}
                data-testid="viewer3d-panel-close"
              >
                ✕
              </button>
            )}
            <div style={panelSection}>
              <div style={panelLabel}>{t("viewer3d.mode")}</div>
              <div style={modeRow}>
                {MODES.map((m) => (
                  <button
                    key={m}
                    style={mode === m ? modeBtnActive : modeBtn}
                    onClick={() => onMode(m)}
                    data-testid={`viewer3d-mode-${m.toLowerCase()}`}
                  >
                    {t(`viewer3d.mode.${m.toLowerCase()}`)}
                  </button>
                ))}
              </div>
            </div>

            {mode === "VR" && (
              <div style={panelSection}>
                <div style={panelLabel}>{t("viewer3d.preset")}</div>
                <select style={select} value={presetName} onChange={(e) => onPreset(e.target.value)}>
                  <option value="none">{t("viewer3d.presetNone")}</option>
                  {presetsForModality(modalityRef.current).map((n) => (
                    <option key={n} value={n}>
                      {n.replace(/_/g, " ")}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div style={panelSection}>
              <div style={panelLabel}>{t("viewer3d.snap")}</div>
              <div style={modeRow}>
                {(["AX", "COR", "SAG"] as const).map((k) => (
                  <button
                    key={k}
                    style={modeBtn}
                    onClick={() => viewRef.current?.snapOrientation(k, snapFlip)}
                    title={t(`viewer3d.snap.${k.toLowerCase()}.title`)}
                    data-testid={`viewer3d-snap-${k.toLowerCase()}`}
                  >
                    {t(`viewer3d.snap.${k.toLowerCase()}`)}
                  </button>
                ))}
                <button
                  style={snapFlip ? modeBtnActive : modeBtn}
                  onClick={() => setSnapFlip((v) => !v)}
                  title={t("viewer3d.snap.flip.title")}
                  aria-pressed={snapFlip}
                  data-testid="viewer3d-snap-flip"
                >
                  {t("viewer3d.snap.flip")}
                </button>
              </div>
            </div>

            {mode === "SLAB" && (
              <SlabPanel
                view={viewRef.current}
                styles={{
                  section: panelSection,
                  label: panelLabel,
                  row: orthoRow,
                  btn: modeBtn,
                  btnActive: modeBtnActive,
                  select,
                }}
              />
            )}

            {mode === "ORTHO" && (
              <div style={panelSection}>
                <div style={panelLabel}>{t("viewer3d.orthoPos")}</div>
                {(["x", "y", "z"] as const).map((ax) => (
                  <div key={ax} style={orthoRow}>
                    <span style={orthoAxis}>{ax.toUpperCase()}</span>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      value={Math.round(orthoPos[ax] * 100)}
                      onChange={(e) => onOrthoChange(ax, Number(e.target.value) / 100)}
                      style={{ flex: 1, minWidth: 0 }}
                    />
                  </div>
                ))}
              </div>
            )}

            <div style={panelSection}>
              <div style={panelLabel}>{mode === "VR" ? t("viewer3d.wlPresetVr") : t("viewer2d.wl.preset")}</div>
              <select style={select} defaultValue="default" onChange={(e) => onWlPreset(e.target.value)}>
                <option value="default">{t("viewer2d.wl.default")}</option>
                {presets.map((p) => (
                  <option key={p.key} value={p.key}>
                    {presetLabel(p, t)}
                  </option>
                ))}
              </select>
            </div>

            <div style={panelSection}>
              <div style={panelLabel}>{t("viewer3d.transfer")}</div>
              <button style={resetBtn} onClick={() => setLutOpen(true)}>
                {t("viewer3d.lut")}
                {lutName ? `: ${lutName.replace(/_/g, " ")}` : ""}
              </button>
              <button style={resetBtn} onClick={() => setCurveOpen((v) => !v)}>
                {t("viewer3d.opacityCurveBtn")}
              </button>
            </div>

            <div style={panelSection}>
              <div style={panelLabel}>{t("viewer3d.clip")}</div>
              <button style={clipOn ? modeBtnActive : resetBtn} onClick={onToggleClip}>
                {clipOn ? t("viewer3d.clipOnBtn") : t("viewer3d.clipOffBtn")}
              </button>
              {clipOn && <div style={hint}>{t("viewer3d.clipDragHint")}</div>}
            </div>

            {pluginView?.view.clipPlanes && pluginView.view.clipPlanes.length > 0 && (
              <div style={panelSection} data-testid="viewer3d-plugin-clip">
                <div style={panelLabel}>{t("viewer3d.pluginView.clipPlanes")}</div>
                {pluginView.view.clipPlanes.map((pl, i) => (
                  <label key={i} style={hint} data-testid={`viewer3d-plugin-clip-row-${i}`}>
                    <input
                      type="checkbox"
                      checked={pluginView.clipEnabled[i] !== false}
                      onChange={(e) => onTogglePluginClip(i, e.target.checked)}
                      data-testid="viewer3d-plugin-clip-toggle"
                    />{" "}
                    {pl.label ?? t("viewer3d.pluginView.clipPlane", { n: String(i + 1) })} ({pl.normal.map((x) => x.toFixed(2)).join(", ")})
                  </label>
                ))}
                <button
                  style={resetBtn}
                  onClick={() => {
                    const off = pluginView.view.clipPlanes!.map(() => false);
                    pushClipPlanes(pluginView.view.clipPlanes!, off);
                    setPluginView({ ...pluginView, clipEnabled: off });
                  }}
                >
                  {t("viewer3d.pluginView.allOff")}
                </button>
              </div>
            )}

            <div style={panelSection}>
              <button style={resetBtn} onClick={onResetView}>
                {t("viewer3d.resetView")}
              </button>
              <button style={resetBtn} onClick={() => setLegendOn((v) => !v)}>
                {legendOn ? t("legend.hide") : t("legend.show")}
              </button>
              {/*
               * Cinematic / パストレーサは狭幅では出さない（fw/mobile-ui-design.md §4.2）。
               * どちらも既定 OFF の opt-in で、`viewer/cinematicPathTracer.ts` に
               * 「standalone(Electron) 前提」と明記されている重い機能。
               */}
              {!narrow && (
                <button
                  style={pathTraceOn ? modeBtnActive : resetBtn}
                  title={t("cine2.hint")}
                  data-testid="viewer3d-cinematic-toggle"
                  onClick={() => setPathTraceOn((v) => !v)}
                >
                  {pathTraceOn ? t("cine2.stop") : t("cine2.start")}
                </button>
              )}
            </div>

            <div style={panelSection}>
              <SceneObjectPanel
                geom={sceneGeom}
                sopToK={sopToK}
                onStartCut={startCut}
                onAnalyzeCenterline={analyzeCenterline}
                onRepairMesh={(id, name) => setRepairTarget({ id, name })}
                measureMode={measureMode}
                onToggleMeasure={toggleMeasure}
                endoPathMode={endoPathMode}
                onToggleEndoPath={toggleEndoPath}
                studyUid={seriesRef.current?.studyUid}
                seriesUid={seriesRef.current?.seriesUid}
                ctxC={seriesRef.current?.c}
                ctxT={seriesRef.current?.t}
                isDemo={isDemo}
              />
            </div>

            <div style={hint}>{t("viewer3d.navHint")}</div>
          </div>
          </>
        )}
      </div>
      {lutOpen && (
        <LutDialog currentLutName={lutName} onSelect={onSelectLut} onClose={() => setLutOpen(false)} />
      )}
      {curveOpen && volumeId && (
        <OpacityCurveDialog
          volumeId={volumeId}
          points={opacityPts}
          onChange={onOpacityChange}
          onClose={() => setCurveOpen(false)}
        />
      )}
      {cinematicOpen && viewRef.current && (
        <CinematicSettingsDialog view={viewRef.current} onClose={() => setCinematicOpen(false)} />
      )}
      {reprOpen && viewRef.current && (
        <RepresentationStateDialog
          view={viewRef.current}
          lutName={lutName}
          onApplied={onApplyReprState}
          onClose={() => setReprOpen(false)}
        />
      )}
    </div>
  );
}

// ── styles ────────────────────────────────────────────────────
const root: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  display: "flex",
  flexDirection: "column",
  background: "#000",
  color: "#e6eaee",
  fontFamily: "system-ui, sans-serif",
};
const header: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "6px 12px",
  background: "#14181c",
  borderBottom: "1px solid #23292f",
  fontSize: 13,
};
const hTitle: React.CSSProperties = { fontWeight: 600 };
const hSeries: React.CSSProperties = { color: "#9aa6b2" };
const tiltChip: React.CSSProperties = {
  marginLeft: "auto",
  fontSize: 11,
  color: "#ffd27a",
  border: "1px solid #5a4a2a",
  background: "#2a220f",
  borderRadius: 4,
  padding: "1px 7px",
};
// ソフトウェア描画の印。tiltChip と同じ警告色。押せる（設定＞描画環境を開く）。
const softwareBadge: React.CSSProperties = {
  ...tiltChip,
  marginLeft: 8,
  cursor: "pointer",
};
const pluginBadge: React.CSSProperties = {
  ...tiltChip,
  marginLeft: 8,
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
};
const pluginBadgeWarn: React.CSSProperties = { color: "#e0b050" };
const pluginBadgeErr: React.CSSProperties = { color: "#e07070" };
const pluginBadgeBtn: React.CSSProperties = {
  marginLeft: 6,
  background: "transparent",
  color: "inherit",
  border: "1px solid rgba(255,255,255,.3)",
  borderRadius: 4,
  padding: "0 6px",
  cursor: "pointer",
  font: "inherit",
};
const bodyWrap: React.CSSProperties = { position: "relative", flex: 1, display: "flex", minHeight: 0 };
const body: React.CSSProperties = { position: "relative", flex: 1, minWidth: 0 };
// touchAction: none — 無いとタッチ端末で回転/ピンチがページスクロールに奪われる
// （`fw/mobile-ui-design.md` §3.3）。実際の回転/ピンチは vtk.js の interactor が処理する。
const vpEl: React.CSSProperties = { position: "absolute", inset: 0, touchAction: "none" };
// Slab の回転中心マーカー（画面中央の十字）。操作を邪魔しないよう pointerEvents なし。
const centerMark: React.CSSProperties = {
  position: "absolute",
  left: "50%",
  top: "50%",
  width: 18,
  height: 18,
  marginLeft: -9,
  marginTop: -9,
  pointerEvents: "none",
  zIndex: 4,
  background:
    "linear-gradient(#ffcc33,#ffcc33) center/2px 100% no-repeat, linear-gradient(#ffcc33,#ffcc33) center/100% 2px no-repeat",
  opacity: 0.85,
};
const panel: React.CSSProperties = {
  width: 240,
  flexShrink: 0,
  borderLeft: "1px solid #23292f",
  background: "#0d1013",
  padding: "12px 14px",
  display: "flex",
  flexDirection: "column",
  gap: 16,
  overflowY: "auto",
};
/** 狭幅時: 右からせり上がるドロワー（中身は `panel` と同じ）。 */
const panelDrawer: React.CSSProperties = {
  ...panel,
  position: "absolute",
  top: 0,
  right: 0,
  bottom: 0,
  zIndex: 60,
  width: "min(300px, 88%)",
  paddingTop: 40, // 閉じるボタンぶん
  boxShadow: "-8px 0 24px rgba(0,0,0,0.5)",
};
const panelScrim: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  zIndex: 55,
  background: "rgba(0,0,0,0.5)",
};
const panelCloseBtn: React.CSSProperties = {
  position: "absolute",
  top: 4,
  right: 6,
  minWidth: 44,
  minHeight: 36,
  border: "none",
  background: "transparent",
  color: "#9aa6b2",
  fontSize: 15,
  cursor: "pointer",
};
const backBtn: React.CSSProperties = {
  minWidth: 36,
  minHeight: 36,
  border: "none",
  background: "transparent",
  color: "#e6eaee",
  fontSize: 22,
  lineHeight: 1,
  cursor: "pointer",
};
const panelOpenBtn: React.CSSProperties = {
  marginLeft: "auto",
  minHeight: 36,
  padding: "0 12px",
  border: "1px solid #2c343b",
  borderRadius: 8,
  background: "transparent",
  color: "#c7d0d8",
  fontSize: 12,
  cursor: "pointer",
};
const panelSection: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 6 };
const panelLabel: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: "#7f8b96",
  textTransform: "uppercase",
  letterSpacing: 0.4,
};
const modeRow: React.CSSProperties = { display: "flex", gap: 4 };
const orthoRow: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8 };
const orthoAxis: React.CSSProperties = { width: 14, fontSize: 12, color: "#9aa6b2", flexShrink: 0 };
const modeBtn: React.CSSProperties = {
  flex: 1,
  padding: "6px 4px",
  background: "#1b2126",
  color: "#c7d0d8",
  border: "1px solid #2c343b",
  borderRadius: 5,
  cursor: "pointer",
  fontSize: 12,
};
const modeBtnActive: React.CSSProperties = {
  ...modeBtn,
  background: "#0b5cad",
  color: "#fff",
  border: "1px solid #0b5cad",
};
const select: React.CSSProperties = {
  background: "#1b2126",
  color: "#e6eaee",
  border: "1px solid #2c343b",
  borderRadius: 5,
  fontSize: 12,
  padding: "5px 6px",
};
const resetBtn: React.CSSProperties = {
  padding: "7px 10px",
  background: "#1b2126",
  color: "#e6eaee",
  border: "1px solid #2c343b",
  borderRadius: 5,
  cursor: "pointer",
  fontSize: 12,
};
const hint: React.CSSProperties = {
  marginTop: "auto",
  fontSize: 11,
  color: "#5a6672",
  lineHeight: 1.5,
};
const overlay: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "rgba(0,0,0,0.55)",
};
const overlayBox: React.CSSProperties = {
  padding: "10px 18px",
  background: "#1b2126",
  border: "1px solid #2c343b",
  borderRadius: 8,
  fontSize: 13,
  maxWidth: "80%",
  textAlign: "center",
};
