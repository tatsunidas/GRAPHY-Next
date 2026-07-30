/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { RenderingEngine, Enums, EVENTS, eventTarget } from "@cornerstonejs/core";
import {
  ToolGroupManager,
  PanTool,
  ZoomTool,
  WindowLevelTool,
  LengthTool,
  AngleTool,
  EllipticalROITool,
  RectangleROITool,
  ProbeTool,
  annotation as csToolsAnnotation,
  Enums as csToolsEnums,
} from "@cornerstonejs/tools";
import { useI18n } from "../i18n/i18n";
import { fetchVideoMetadata, videoRenderedUrl, type VideoMetadata } from "../api";
import { ensureCornerstoneInitialized } from "./cornerstoneSetup";
import { ensureVideoMetadataProvider, registerVideoMetadata } from "./videoMetadataProvider";
import {
  analyzeFrameRoi,
  analyzeGlobalRoi,
  histogramToCsv,
  timeSeriesToCsv,
  type FrameRoiResult,
  type RoiPixels,
  type TimeSeriesPoint,
} from "./videoRoiAnalysis";
import {
  applyScopeToReference,
  assignScope,
  frameScope,
  isVisibleOnFrame,
  pruneScopes,
  scopeCounts,
  scopeOf,
  toggleScope,
  type RoiAnnotationReference,
  type RoiScopeMap,
} from "./videoRoiScope";
import { TimeIntensityChart } from "./TimeIntensityChart";
import { RoiHistogramChart } from "./RoiHistogramChart";

const { MouseBindings } = csToolsEnums;

/**
 * 左ドラッグ（Primary）に割り当て可能な動画ツール。WW/WL と計測/ROI を切り替える
 * （Pan=中ドラッグ・Zoom=右ドラッグは固定）。P3c で ROI 解析（時系列）を載せる土台。
 */
const VIDEO_PRIMARY_TOOLS: { name: string; key: string }[] = [
  { name: WindowLevelTool.toolName, key: "wwwl" },
  { name: LengthTool.toolName, key: "length" },
  { name: AngleTool.toolName, key: "angle" },
  { name: RectangleROITool.toolName, key: "rectangle" },
  { name: EllipticalROITool.toolName, key: "ellipse" },
  { name: ProbeTool.toolName, key: "probe" },
];

/** ROI 一覧・管理の対象（注釈系ツール。WW/WL・Pan/Zoom は注釈ではないので除く）。 */
const ANNOTATION_TOOL_DEFS: { name: string; key: string }[] = [
  { name: LengthTool.toolName, key: "length" },
  { name: AngleTool.toolName, key: "angle" },
  { name: RectangleROITool.toolName, key: "rectangle" },
  { name: EllipticalROITool.toolName, key: "ellipse" },
  { name: ProbeTool.toolName, key: "probe" },
];

interface RoiItem {
  uid: string;
  toolKey: string;
}

/**
 * encapsulated 動画（Video Photographic/Endoscopic/Microscopic）を 2D ビューア枠内で再生する。
 *
 * <p>P3: **方式 A（Cornerstone VideoViewport）を primary** とし、cine コントロール（再生/一時停止・
 * シークバー・再生速度・ループ・フレーム精度送り）を自作で載せる。VideoViewport は WebGL キャンバスに
 * 動画フレームを描くため、後続 P3 で Pan/Zoom・WW/WL・ROI/計測ツールをフレーム上に載せられる。
 *
 * <p>VideoViewport の初期化に失敗した環境（WebGL 不可・HEVC 非対応等）は **方式 B（HTML5 `<video>`）に
 * 自動フォールバック**する。standalone 専用（`/rendered` は索引ローカルファイル前提）。
 */

/** VideoViewport の使用メソッドだけを型付けした最小インタフェース（Types 依存を避ける）。 */
interface VideoVP {
  setVideo(imageId: string, frame?: number): Promise<unknown>;
  setProperties(p: { loop?: boolean; playbackRate?: number }): void;
  play(): Promise<void>;
  pause(): void;
  togglePlayPause(): boolean;
  setFrameNumber(f: number): Promise<void>;
  setPlaybackRate(r?: number): void;
  getFrameNumber(): number;
  getNumberOfSlices(): number;
  resetCamera(): boolean;
  render(): void;
}

type Phase = "loading" | "viewport" | "fallback" | "transcode" | "error";

let engineSeq = 0;

const SPEEDS = [0.25, 0.5, 1, 1.5, 2, 4];

function fmtTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) {
    return "0:00";
  }
  const s = Math.floor(sec % 60);
  const m = Math.floor(sec / 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function VideoViewer({ sopInstanceUid }: { sopInstanceUid: string }) {
  const { t } = useI18n();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<RenderingEngine | null>(null);
  const vpRef = useRef<VideoVP | null>(null);
  const toolGroupIdRef = useRef<string | null>(null);

  const [phase, setPhase] = useState<Phase>("loading");
  const [meta, setMeta] = useState<VideoMetadata | null>(null);
  const [playing, setPlaying] = useState(false);
  const [frame, setFrame] = useState(1); // 1-based 現在フレーム
  const [rate, setRate] = useState(1);
  const [loop, setLoop] = useState(true);
  const [activeTool, setActiveTool] = useState<string>(WindowLevelTool.toolName);

  // グローバル ROI 時系列解析（P3c）。
  const analysisAbortRef = useRef<AbortController | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisProgress, setAnalysisProgress] = useState<{ done: number; total: number } | null>(null);
  const [series, setSeries] = useState<TimeSeriesPoint[] | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [analyzedRoi, setAnalyzedRoi] = useState<RoiPixels | null>(null);
  const [showChannels, setShowChannels] = useState(false);

  // ROI 管理（一覧・削除・全消去）。
  const [rois, setRois] = useState<RoiItem[]>([]);

  // ROI の帰属モード（§12）。`scopes` は uid → スコープ、`newRoiFrameBound` は**新規作成時**の既定。
  const [scopes, setScopes] = useState<RoiScopeMap>({});
  const [newRoiFrameBound, setNewRoiFrameBound] = useState(false);
  // 注釈イベントのリスナは sopInstanceUid 変更時にしか張り替えないため、
  // 作成時に参照する「現在フレーム」「既定モード」は ref 経由で最新値を読む。
  const newRoiFrameBoundRef = useRef(newRoiFrameBound);
  newRoiFrameBoundRef.current = newRoiFrameBound;
  const frameRef = useRef(frame);
  frameRef.current = frame;
  // 可視性を戻すため、この動画で触った uid を覚えておく（隠し集合は cornerstone のモジュール全体で共有）。
  const managedUidsRef = useRef<Set<string>>(new Set());
  // 計測テキストを無効化した最後のフレーム（フレームが変わった時だけ再計算させるため）。
  const statsFrameRef = useRef(0);

  // 解析対象に選んだ ROI（null なら「直近に描いたもの」を使う従来動作）。複数 ROI を置いた時に
  // どれを解析するかを利用者が決められるようにするため（§12 残タスク「複数 ROI の選択解析」）。
  const [selectedRoiUid, setSelectedRoiUid] = useState<string | null>(null);

  // フレーム指定 ROI の単一フレーム解析（面積・平均/最大/最小・SD・ヒストグラム）。
  const [frameResult, setFrameResult] = useState<FrameRoiResult | null>(null);
  const [frameAnalyzing, setFrameAnalyzing] = useState(false);

  const src = useMemo(() => videoRenderedUrl(sopInstanceUid), [sopInstanceUid]);
  const fps = meta && meta.fps > 0 ? meta.fps : 0;
  const totalFrames = meta && meta.numberOfFrames > 0 ? meta.numberOfFrames : 1;

  useEffect(() => {
    let cancelled = false;
    const host = hostRef.current;

    // 高頻度（毎フレーム）の IMAGE_RENDERED で現在フレームを更新。整数フレームが変わった時だけ setState。
    let lastFrame = 0;
    const onRendered = () => {
      const vp = vpRef.current;
      if (!vp) {
        return;
      }
      const f = vp.getFrameNumber();
      if (f !== lastFrame) {
        lastFrame = f;
        setFrame(f);
      }
    };

    // 注釈（ROI）の作成/削除で一覧を更新。
    // 注意: cornerstone-tools の annotation 系イベント（ADDED/COMPLETED/MODIFIED/REMOVED）は
    // host element ではなくグローバル `eventTarget` で発火する（tools/.../helpers/state.js が
    // `triggerEvent(eventTarget, ...)`）。よって element ではなく eventTarget で購読する。
    const onAnnotationChanged = () => refreshRois();

    const cleanup = () => {
      if (host) {
        host.removeEventListener(EVENTS.IMAGE_RENDERED, onRendered);
      }
      eventTarget.removeEventListener(csToolsEnums.Events.ANNOTATION_COMPLETED, onAnnotationChanged);
      eventTarget.removeEventListener(csToolsEnums.Events.ANNOTATION_MODIFIED, onAnnotationChanged);
      eventTarget.removeEventListener(csToolsEnums.Events.ANNOTATION_REMOVED, onAnnotationChanged);
      const vp = vpRef.current;
      if (vp) {
        try {
          vp.pause();
        } catch {
          /* 破棄済み等は無視 */
        }
      }
      const tgId = toolGroupIdRef.current;
      if (tgId) {
        try {
          ToolGroupManager.destroyToolGroup(tgId);
        } catch {
          /* 破棄済み等は無視 */
        }
      }
      const engine = engineRef.current;
      if (engine) {
        try {
          engine.destroy(); // enableElement した VIDEO viewport／WebGL コンテキストを解放
        } catch {
          /* 破棄済み等は無視 */
        }
      }
      toolGroupIdRef.current = null;
      vpRef.current = null;
      engineRef.current = null;
    };

    setPhase("loading");
    setMeta(null);
    setPlaying(false);
    setFrame(1);
    // 解析状態は SOP 切替でリセット（走行中なら中断）。
    analysisAbortRef.current?.abort();
    setAnalyzing(false);
    setAnalysisProgress(null);
    setSeries(null);
    setAnalysisError(null);
    setAnalyzedRoi(null);
    setRois([]);
    // 帰属表とフレーム解析も SOP 切替でリセット（隠していた注釈は戻してから捨てる）。
    for (const uid of managedUidsRef.current) {
      try {
        csToolsAnnotation.visibility.setAnnotationVisibility(uid, true);
      } catch {
        /* 無視 */
      }
    }
    managedUidsRef.current = new Set();
    setScopes({});
    setFrameResult(null);
    setFrameAnalyzing(false);

    (async () => {
      await ensureCornerstoneInitialized();
      let m: VideoMetadata;
      try {
        m = await fetchVideoMetadata(sopInstanceUid);
      } catch {
        // メタ取得失敗 → <video> フォールバックで再生を試みる。
        if (!cancelled) {
          setPhase("fallback");
        }
        return;
      }
      if (cancelled) {
        return;
      }
      setMeta(m);
      if (m.transcodeRequired) {
        setPhase("transcode");
        return;
      }
      const imageId = registerVideoMetadata(sopInstanceUid, m);
      ensureVideoMetadataProvider();

      const el = hostRef.current;
      if (!el) {
        setPhase("fallback");
        return;
      }
      const engineId = `graphy-video-engine-${engineSeq}`;
      const viewportId = `graphy-video-vp-${engineSeq}`;
      engineSeq += 1;
      try {
        const engine = new RenderingEngine(engineId);
        engineRef.current = engine;
        engine.enableElement({ viewportId, type: Enums.ViewportType.VIDEO, element: el });
        const vp = engine.getViewport(viewportId) as unknown as VideoVP;
        vpRef.current = vp;
        await vp.setVideo(imageId, 1);
        if (cancelled) {
          cleanup();
          return;
        }
        vp.setProperties({ loop });
        vp.pause();
        el.addEventListener(EVENTS.IMAGE_RENDERED, onRendered);
        // ここで再生（方式 A）は成立。以降のツール配線が失敗しても再生・ツールバー表示は維持する。
        setActiveTool(WindowLevelTool.toolName);
        setPhase("viewport");
      } catch (e) {
        // VideoViewport 初期化失敗（WebGL 不可・コーデック非対応等）→ 方式 B にフォールバック。
        console.warn("VideoViewport 初期化に失敗、<video> にフォールバックします", e);
        cleanup();
        if (!cancelled) {
          setPhase("fallback");
        }
        return;
      }

      // ツール（Pan/Zoom/WW-WL ＋ 計測/ROI）を video viewport に紐付ける（best-effort。失敗しても再生は継続）。
      // グローバルツール登録は ensureCornerstoneInitialized 済み。Pan=中ドラッグ・Zoom=右ドラッグ固定、Primary 切替式。
      try {
        const toolGroupId = `${viewportId}-tg`;
        const tg = ToolGroupManager.getToolGroup(toolGroupId) ?? ToolGroupManager.createToolGroup(toolGroupId);
        if (tg) {
          tg.addTool(PanTool.toolName);
          tg.addTool(ZoomTool.toolName);
          for (const { name } of VIDEO_PRIMARY_TOOLS) {
            tg.addTool(name);
            tg.setToolPassive(name);
          }
          tg.setToolActive(PanTool.toolName, { bindings: [{ mouseButton: MouseBindings.Auxiliary }] });
          tg.setToolActive(ZoomTool.toolName, { bindings: [{ mouseButton: MouseBindings.Secondary }] });
          tg.setToolActive(WindowLevelTool.toolName, { bindings: [{ mouseButton: MouseBindings.Primary }] });
          tg.addViewport(viewportId, engineId);
          toolGroupIdRef.current = toolGroupId;
        }
        // ROI 作成/変更/削除で一覧を更新（グローバル eventTarget で購読。element では発火しない）。
        eventTarget.addEventListener(csToolsEnums.Events.ANNOTATION_COMPLETED, onAnnotationChanged);
        eventTarget.addEventListener(csToolsEnums.Events.ANNOTATION_MODIFIED, onAnnotationChanged);
        eventTarget.addEventListener(csToolsEnums.Events.ANNOTATION_REMOVED, onAnnotationChanged);
        refreshRois();
      } catch (e) {
        console.warn("動画ツールの初期化に失敗（再生は継続）", e);
      }
    })();

    return () => {
      cancelled = true;
      cleanup();
    };
    // loop はマウント後に viewport へ反映（別 effect）。ここでの初期値のみ使用。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sopInstanceUid]);

  // アンマウント時に走行中の解析を中断。
  useEffect(() => () => analysisAbortRef.current?.abort(), []);

  // ループ／再生速度を viewport に反映。
  useEffect(() => {
    const vp = vpRef.current;
    if (phase === "viewport" && vp) {
      try {
        vp.setProperties({ loop, playbackRate: rate });
        vp.setPlaybackRate(rate);
      } catch {
        /* 未初期化はスキップ */
      }
    }
  }, [loop, rate, phase]);

  // 帰属モードに従って ROI の表示/非表示をフレームごとに切り替える（§12 モード①の中核）。
  //
  // ⚠ **表示フィルタの実体は annotation metadata の参照フレーム**であって visibility ではない。
  // AnnotationTool は生成時に `viewport.getViewReference()`（= 描いた瞬間のフレーム）を metadata に入れ、
  // `VideoViewport.isReferenceViewable()` が `sliceIndex === 現在フレーム` を要求するため、素の annotation は
  // **描いた 1 フレームにしか出ない**。よってグローバル帰属は `sliceIndex` を消して初めて全フレームに出る
  // （2026-07-30 の実機検証で判明。visibility だけ true に戻しても他フレームでは描画されなかった）。
  //
  // setAnnotationVisibility は冪等で ANNOTATION_VISIBILITY_CHANGE しか出さない（購読していない）ため、
  // ここから注釈イベント → refreshRois の連鎖は起きない。
  useEffect(() => {
    if (phase !== "viewport") {
      return;
    }
    // フレームが変わったら、cornerstone が ROI に重ねる計測テキスト（Area/Mean/Max/Min/SD）を
    // 無効化して現在フレームの値へ更新させる。cachedStats は**作成フレームの値のまま**なので、
    // 放置すると「フレーム統計」パネルと別の数字が出続けて紛らわしい（invalidateAnnotation は
    // `invalidated = true` を立てるだけでイベントを出さないため、refreshRois の連鎖は起きない）。
    const frameChanged = statsFrameRef.current !== frame;
    statsFrameRef.current = frame;
    for (const r of rois) {
      const scope = scopeOf(scopes, r.uid);
      const visible = isVisibleOnFrame(scope, frame);
      try {
        const ann = csToolsAnnotation.state.getAnnotation(r.uid);
        if (ann?.metadata) {
          applyScopeToReference(ann.metadata as RoiAnnotationReference, scope);
        }
        if (ann && frameChanged && visible) {
          csToolsAnnotation.state.invalidateAnnotation(ann);
        }
      } catch {
        /* 破棄済み等は無視 */
      }
      try {
        csToolsAnnotation.visibility.setAnnotationVisibility(r.uid, visible);
      } catch {
        /* 破棄済み等は無視 */
      }
    }
    try {
      // render() → IMAGE_RENDERED → cs-tools の imageRenderedEventDispatcher が注釈を再描画する。
      vpRef.current?.render();
    } catch {
      /* 無視 */
    }
  }, [rois, scopes, frame, phase]);

  // アンマウント時に隠した ROI を戻す。cornerstone の隠し集合はモジュール全体で共有されるため、
  // 放置すると他のビューアで同じ注釈が見えなくなる。
  useEffect(() => {
    const managed = managedUidsRef;
    return () => {
      for (const uid of managed.current) {
        try {
          csToolsAnnotation.visibility.setAnnotationVisibility(uid, true);
        } catch {
          /* 無視 */
        }
      }
      managed.current = new Set();
    };
  }, []);

  const togglePlay = () => {
    const vp = vpRef.current;
    if (!vp) {
      return;
    }
    try {
      // シーク中はループを外してある（{@link seekToFrame} 参照）ので、再生開始時に設定を戻す。
      vp.setProperties({ loop, playbackRate: rate });
      setPlaying(vp.togglePlayPause());
    } catch {
      /* 無視 */
    }
  };

  // Primary（左ドラッグ）ツールを切り替える。Pan/Zoom（中/右）は据え置き。
  const selectPrimaryTool = (toolName: string) => {
    const tgId = toolGroupIdRef.current;
    if (!tgId) {
      return;
    }
    const tg = ToolGroupManager.getToolGroup(tgId);
    if (!tg) {
      return;
    }
    for (const { name } of VIDEO_PRIMARY_TOOLS) {
      if (name !== toolName) {
        try {
          tg.setToolPassive(name);
        } catch {
          /* 無視 */
        }
      }
    }
    try {
      tg.setToolActive(toolName, { bindings: [{ mouseButton: MouseBindings.Primary }] });
      setActiveTool(toolName);
    } catch {
      /* 無視 */
    }
  };

  const fitView = () => {
    const vp = vpRef.current;
    if (!vp) {
      return;
    }
    try {
      vp.resetCamera();
      vp.render();
    } catch {
      /* 無視 */
    }
  };

  /**
   * 解析対象の Rectangle/Ellipse ROI をピクセル座標（world=pixel）で取り出す。無ければ null。
   *
   * <p>選び方の優先順: ① 一覧で**選択中**の ROI（`selectedRoiUid`。複数 ROI を置いた時にどれを解析するかを
   * 利用者が決められる）→ ② 現在の Primary ツールと同じ形の直近の ROI → ③ 直近の ROI。
   *
   * @param accept 対象にする ROI の uid 判定。現在フレームに表示されていない（別フレームに紐づく）
   *               ROI や、帰属が合わない ROI を解析対象にしないために使う。
   */
  const currentRoiPixels = (accept?: (uid: string) => boolean): RoiPixels | null => {
    const host = hostRef.current;
    if (!host) {
      return null;
    }
    /** ROI 候補（描かれた順）。uid つきで返すので選択との突き合わせができる。 */
    const candidates = (toolName: string, shape: "rect" | "ellipse"): { uid: string; roi: RoiPixels }[] => {
      let anns: unknown[] = [];
      try {
        anns = (csToolsAnnotation.state.getAnnotations(toolName, host) as unknown[]) ?? [];
      } catch {
        anns = [];
      }
      const out: { uid: string; roi: RoiPixels }[] = [];
      for (const a of anns) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ann = a as any;
        const uid = (ann?.annotationUID as string) ?? "";
        if (accept && !accept(uid)) {
          continue;
        }
        const pts = ann?.data?.handles?.points as number[][] | undefined;
        if (!pts || pts.length < 2) {
          continue;
        }
        let x0 = Infinity;
        let y0 = Infinity;
        let x1 = -Infinity;
        let y1 = -Infinity;
        for (const p of pts) {
          x0 = Math.min(x0, p[0]);
          y0 = Math.min(y0, p[1]);
          x1 = Math.max(x1, p[0]);
          y1 = Math.max(y1, p[1]);
        }
        if (![x0, y0, x1, y1].every(Number.isFinite)) {
          continue;
        }
        out.push({ uid, roi: { shape, x0, y0, x1, y1 } });
      }
      return out;
    };
    const rects = candidates(RectangleROITool.toolName, "rect");
    const ells = candidates(EllipticalROITool.toolName, "ellipse");
    // ① 選択中の ROI（形は問わない）。
    if (selectedRoiUid) {
      const hit = [...rects, ...ells].find((c) => c.uid === selectedRoiUid);
      if (hit) {
        return hit.roi;
      }
    }
    const rect = rects.length > 0 ? rects[rects.length - 1].roi : null;
    const ell = ells.length > 0 ? ells[ells.length - 1].roi : null;
    // ② Primary ツールと同じ形を優先 → ③ 直近。
    if (activeTool === RectangleROITool.toolName && rect) {
      return rect;
    }
    if (activeTool === EllipticalROITool.toolName && ell) {
      return ell;
    }
    return ell ?? rect;
  };

  const runAnalysis = async () => {
    // 選択した ROI が解析できない帰属なら、黙って別の ROI を解析しない（選択を無視したように見えるため）。
    if (selectedRoiUid && scopeOf(scopes, selectedRoiUid).kind !== "global") {
      setSeries(null);
      setAnalysisError(t("video.analyze.selectedNotGlobal"));
      return;
    }
    // 時系列解析はグローバル帰属の ROI のみ（フレーム指定 ROI は単一フレーム解析の対象）。
    const roi = currentRoiPixels((uid) => scopeOf(scopes, uid).kind === "global");
    if (!roi || !meta) {
      setSeries(null);
      setAnalysisError(t("video.analyze.noGlobalRoi"));
      return;
    }
    setAnalysisError(null);
    setSeries(null);
    setAnalyzedRoi(roi);
    setAnalyzing(true);
    setAnalysisProgress({ done: 0, total: totalFrames });
    const ac = new AbortController();
    analysisAbortRef.current = ac;
    try {
      vpRef.current?.pause();
      setPlaying(false);
    } catch {
      /* noop */
    }
    try {
      const s = await analyzeGlobalRoi(
        src,
        meta,
        roi,
        (done, total) => setAnalysisProgress({ done, total }),
        ac.signal,
      );
      setSeries(s);
    } catch (e) {
      if ((e as Error)?.name !== "AbortError") {
        setAnalysisError(String((e as Error)?.message ?? e));
      }
    } finally {
      setAnalyzing(false);
      setAnalysisProgress(null);
      analysisAbortRef.current = null;
    }
  };

  const cancelAnalysis = () => analysisAbortRef.current?.abort();

  const downloadCsv = () => {
    if (!series) {
      return;
    }
    const blob = new Blob([timeSeriesToCsv(series)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `video-roi-${sopInstanceUid}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const closeAnalysis = () => {
    setSeries(null);
    setAnalysisError(null);
    setAnalyzedRoi(null);
  };

  /** 現在フレームに表示されている ROI の単一フレーム統計（§12 モード①）。 */
  const runFrameAnalysis = async () => {
    // 選択した ROI が現在フレームに出ていないなら、黙って別の ROI を解析しない。
    if (selectedRoiUid && !isVisibleOnFrame(scopeOf(scopes, selectedRoiUid), frame)) {
      setFrameResult(null);
      setAnalysisError(t("video.frameStats.selectedNotOnFrame"));
      return;
    }
    const roi = currentRoiPixels((uid) => isVisibleOnFrame(scopeOf(scopes, uid), frame));
    if (!roi || !meta) {
      setFrameResult(null);
      setAnalysisError(t("video.frameStats.noRoi"));
      return;
    }
    setAnalysisError(null);
    setFrameAnalyzing(true);
    try {
      vpRef.current?.pause();
      setPlaying(false);
    } catch {
      /* noop */
    }
    try {
      setFrameResult(await analyzeFrameRoi(src, meta, roi, frame));
    } catch (e) {
      setFrameResult(null);
      setAnalysisError(String((e as Error)?.message ?? e));
    } finally {
      setFrameAnalyzing(false);
    }
  };

  const downloadHistogramCsv = () => {
    if (!frameResult) {
      return;
    }
    const blob = new Blob([histogramToCsv(frameResult.histogram)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `video-roi-${sopInstanceUid}-f${frameResult.frame}-histogram.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  // ROI 一覧を注釈状態から作り直す。併せて帰属表を同期する（新規 uid に既定スコープ、消えた uid を削除）。
  const refreshRois = () => {
    const host = hostRef.current;
    if (!host) {
      setRois([]);
      return;
    }
    const out: RoiItem[] = [];
    for (const { name, key } of ANNOTATION_TOOL_DEFS) {
      let anns: unknown[] = [];
      try {
        anns = (csToolsAnnotation.state.getAnnotations(name, host) as unknown[]) ?? [];
      } catch {
        anns = [];
      }
      for (const a of anns) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const uid = (a as any)?.annotationUID as string | undefined;
        if (uid) {
          out.push({ uid, toolKey: key });
        }
      }
    }
    setRois(out);

    const uids = out.map((r) => r.uid);
    const known = managedUidsRef.current;
    // 新規作成された ROI（＝まだ見たことのない uid）に、作成時点の既定モードを割り当てる。
    const created = uids.filter((u) => !known.has(u));
    setScopes((prev) => {
      let next = pruneScopes(prev, uids);
      if (newRoiFrameBoundRef.current) {
        for (const uid of created) {
          next = assignScope(next, uid, frameScope(frameRef.current));
        }
      }
      return next;
    });
    managedUidsRef.current = new Set(uids);
    // 消えた ROI が選択されたままだと解析対象が迷子になる（選択は「無選択＝直近」に戻す）。
    setSelectedRoiUid((prev) => (prev && uids.includes(prev) ? prev : null));
  };

  /** ROI の帰属をグローバル ⇔ 現在フレーム で切り替える。 */
  const toggleRoiScope = (uid: string) => setScopes((prev) => toggleScope(prev, uid, frame));

  /** 解析対象の ROI を選ぶ（同じものを押したら選択解除＝直近を使う従来動作に戻す）。 */
  const toggleRoiSelection = (uid: string) => setSelectedRoiUid((prev) => (prev === uid ? null : uid));

  const deleteRoi = (uid: string) => {
    // 削除前に表示へ戻す。cornerstone の隠し集合は uid を保持し続けるため、隠したまま消すと取り残される。
    try {
      csToolsAnnotation.visibility.setAnnotationVisibility(uid, true);
    } catch {
      /* 無視 */
    }
    try {
      csToolsAnnotation.state.removeAnnotation(uid);
    } catch {
      /* 無視 */
    }
    try {
      vpRef.current?.render();
    } catch {
      /* 無視 */
    }
    refreshRois();
  };

  const clearRois = () => {
    for (const r of rois) {
      try {
        csToolsAnnotation.visibility.setAnnotationVisibility(r.uid, true);
      } catch {
        /* 無視 */
      }
      try {
        csToolsAnnotation.state.removeAnnotation(r.uid);
      } catch {
        /* 無視 */
      }
    }
    try {
      vpRef.current?.render();
    } catch {
      /* 無視 */
    }
    refreshRois();
  };

  const seekToFrame = (f: number) => {
    const vp = vpRef.current;
    if (!vp) {
      return;
    }
    const clamped = Math.min(Math.max(1, f), totalFrames);
    try {
      vp.pause();
      setPlaying(false);
      // ⚠ **ループ有効のままだと最終フレームへシークできない**（frame 1 に巻き戻る。2026-07-30 実機検証）。
      // VideoViewport は再生位置がフレーム範囲を超えたと判断すると loop 時に先頭へ戻すため、シーク中は
      // ループを外す。再生を始めるときに {@link togglePlay} が設定を戻す（ループ再生の挙動は変えない）。
      vp.setProperties({ loop: false });
      vp.setFrameNumber(clamped);
      setFrame(clamped);
    } catch {
      /* 無視 */
    }
  };

  if (phase === "transcode") {
    return <div style={noticeStyle}>🎞 {t("video.needsFfmpeg")}</div>;
  }

  // 方式 B フォールバック（VideoViewport 不可時）。P1 と同じ <video> 直再生。
  if (phase === "fallback") {
    return (
      <div style={{ marginTop: 10 }}>
        <div style={frameStyle}>
          <video key={src} src={src} controls loop={loop} playsInline preload="metadata" style={videoStyle} />
        </div>
        <div style={{ ...controlRowStyle }}>
          <span style={{ color: "#889", fontSize: 12 }}>{t("video.fallbackMode")}</span>
        </div>
      </div>
    );
  }

  const curSec = fps > 0 ? (frame - 1) / fps : 0;
  const totSec = fps > 0 ? (totalFrames - 1) / fps : 0;

  return (
    <div style={{ marginTop: 10 }}>
      {/* VideoViewport のホスト。cornerstone が内部に canvas を生成する。常時マウントして ref を確保。 */}
      <div style={frameStyle}>
        <div ref={hostRef} data-testid="video-viewport-host" style={hostStyle} />
      </div>

      {phase === "loading" && <div style={{ ...noticeStyle, color: "#889" }}>{t("common.loading")}</div>}

      {phase === "viewport" && (
        <>
          {/* ツールバー（左ドラッグ=WW/WL・計測/ROI 切替。中=Pan・右=Zoom は固定）。 */}
          <div style={{ ...controlRowStyle, gap: 6 }}>
            {VIDEO_PRIMARY_TOOLS.map(({ name, key }) => (
              <button
                key={key}
                type="button"
                data-testid={`video-tool-${key}`}
                style={activeTool === name ? toolBtnActive : toolBtn}
                onClick={() => selectPrimaryTool(name)}
                title={t(`video.tool.${key}`)}
              >
                {t(`video.tool.${key}`)}
              </button>
            ))}
            <button type="button" style={toolBtn} onClick={fitView} title={t("video.tool.fit")}>
              {t("video.tool.fit")}
            </button>
            <span style={{ width: 1, height: 18, background: "#dce2e9" }} aria-hidden />
            {!analyzing ? (
              <button
                type="button"
                style={analyzeBtn}
                data-testid="video-analyze-run"
                onClick={runAnalysis}
                title={t("video.analyze.hint")}
              >
                {t("video.analyze.button")}
              </button>
            ) : (
              <button type="button" style={toolBtn} onClick={cancelAnalysis}>
                {t("common.cancel")}
                {analysisProgress ? ` (${analysisProgress.done}/${analysisProgress.total})` : ""}
              </button>
            )}
            <button
              type="button"
              style={analyzeBtn}
              data-testid="video-frame-stats"
              onClick={runFrameAnalysis}
              disabled={frameAnalyzing}
              title={t("video.frameStats.hint")}
            >
              {frameAnalyzing ? t("common.loading") : t("video.frameStats.button")}
            </button>
            <span style={{ color: "#889", fontSize: 11 }}>{t("video.tool.hint")}</span>
          </div>

          {/* ROI の帰属モード（§12）。新規作成される ROI がどちらになるかを決める。 */}
          <div style={{ ...controlRowStyle, gap: 6 }}>
            <span style={{ color: "#667", fontSize: 12 }}>{t("video.roi.scopeLabel")}</span>
            <button
              type="button"
              data-testid="video-roi-scope-global"
              style={newRoiFrameBound ? toolBtn : toolBtnActive}
              onClick={() => setNewRoiFrameBound(false)}
            >
              {t("video.roi.scopeGlobal")}
            </button>
            <button
              type="button"
              data-testid="video-roi-scope-frame"
              style={newRoiFrameBound ? toolBtnActive : toolBtn}
              onClick={() => setNewRoiFrameBound(true)}
            >
              {t("video.roi.scopeFrame")}
            </button>
            <span style={{ color: "#889", fontSize: 11 }}>
              {t(newRoiFrameBound ? "video.roi.scopeHintFrame" : "video.roi.scopeHintGlobal", { f: frame })}
            </span>
          </div>

          {/* ROI 一覧・管理（削除/全消去）。 */}
          {rois.length > 0 && (
            <div style={{ ...controlRowStyle, gap: 8 }} data-testid="video-roi-list">
              <span style={{ color: "#667", fontSize: 12 }}>{t("video.roi.list", { n: rois.length })}</span>
              {(() => {
                const c = scopeCounts(scopes, rois.map((r) => r.uid), frame);
                return (
                  <span style={{ color: "#889", fontSize: 11 }} data-testid="video-roi-scope-counts">
                    {t("video.roi.scopeCounts", { g: c.global, cur: c.thisFrame, other: c.otherFrame })}
                  </span>
                );
              })()}
              {selectedRoiUid && (
                <span style={{ color: "#0b5cad", fontSize: 11 }} data-testid="video-roi-selected-note">
                  {t("video.roi.selectedNote")}
                </span>
              )}
              {rois.map((r, i) => {
                const sc = scopeOf(scopes, r.uid);
                const visible = isVisibleOnFrame(sc, frame);
                const selected = selectedRoiUid === r.uid;
                return (
                  <span
                    key={r.uid}
                    style={selected ? { ...(visible ? roiChip : roiChipHidden), ...roiChipSelected } : visible ? roiChip : roiChipHidden}
                    data-testid="video-roi-chip"
                    data-selected={selected ? "1" : "0"}
                    title={
                      sc.kind === "global"
                        ? t("video.roi.scopeGlobal")
                        : t("video.roi.boundToFrame", { f: sc.frame })
                    }
                  >
                    {/* ラベル部分を押すと解析対象として選択（もう一度押すと解除＝直近を使う）。 */}
                    <button
                      type="button"
                      style={selected ? roiChipLabelSelected : roiChipLabel}
                      data-testid={`video-roi-select-${r.uid}`}
                      title={t(selected ? "video.roi.deselect" : "video.roi.select")}
                      aria-pressed={selected}
                      onClick={() => toggleRoiSelection(r.uid)}
                    >
                      {selected ? "◎ " : ""}
                      {t(`video.tool.${r.toolKey}`)} #{i + 1}
                    </button>
                    <button
                      type="button"
                      style={sc.kind === "global" ? roiScopeBadgeGlobal : roiScopeBadgeFrame}
                      data-testid={`video-roi-scope-toggle-${r.uid}`}
                      title={t("video.roi.scopeToggle")}
                      aria-label={t("video.roi.scopeToggle")}
                      onClick={() => toggleRoiScope(r.uid)}
                    >
                      {sc.kind === "global" ? t("video.roi.badgeGlobal") : `F${sc.frame}`}
                    </button>
                    <button
                      type="button"
                      style={roiChipDel}
                      title={t("video.roi.delete")}
                      aria-label={t("video.roi.delete")}
                      data-testid={`video-roi-del-${r.uid}`}
                      onClick={() => deleteRoi(r.uid)}
                    >
                      ×
                    </button>
                  </span>
                );
              })}
              <button type="button" style={toolBtn} onClick={clearRois} data-testid="video-roi-clear">
                {t("video.roi.clear")}
              </button>
            </div>
          )}

          {/* シークバー（フレーム精度。1..totalFrames）。 */}
          <div style={{ ...controlRowStyle, gap: 10 }}>
            <button type="button" style={playBtn} onClick={togglePlay} title={t(playing ? "video.pause" : "video.play")}>
              {playing ? "⏸" : "▶"}
            </button>
            <input
              type="range"
              data-testid="video-seek"
              min={1}
              max={totalFrames}
              step={1}
              value={frame}
              onChange={(e) => seekToFrame(Number(e.target.value))}
              style={{ flex: 1, minWidth: 120 }}
            />
            <span
              style={{ color: "#556", fontSize: 12, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}
              data-testid="video-frame-indicator"
            >
              {fps > 0 ? `${fmtTime(curSec)} / ${fmtTime(totSec)}` : `${frame} / ${totalFrames}`}
            </span>
          </div>

          <div style={controlRowStyle}>
            <label style={ctrlLabel}>
              <input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} />
              {t("video.loop")}
            </label>

            <span style={ctrlLabel}>
              {t("video.speed")}
              <select value={rate} onChange={(e) => setRate(Number(e.target.value))} style={selectStyle}>
                {SPEEDS.map((r) => (
                  <option key={r} value={r}>
                    {r}×
                  </option>
                ))}
              </select>
            </span>

            <span style={ctrlLabel}>
              {t("video.frame")}
              <button
                type="button"
                style={frameBtn}
                data-testid="video-frame-prev"
                title={t("video.prevFrame")}
                onClick={() => seekToFrame(frame - 1)}
              >
                ◀
              </button>
              <button
                type="button"
                style={frameBtn}
                data-testid="video-frame-next"
                title={t("video.nextFrame")}
                onClick={() => seekToFrame(frame + 1)}
              >
                ▶
              </button>
            </span>

            {meta && (
              <span style={{ color: "#889", fontSize: 12 }}>
                {meta.columns}×{meta.rows}
                {fps > 0 ? ` · ${fps.toFixed(fps % 1 === 0 ? 0 : 1)} fps` : ""}
                {totalFrames > 1 ? ` · ${totalFrames} ${t("video.frame")}` : ""}
              </span>
            )}
          </div>

          {analysisError && (
            <div style={{ ...controlRowStyle, color: "#b00020" }}>⚠ {analysisError}</div>
          )}

          {/* グローバル ROI 時系列解析パネル（P3c）。 */}
          {series && series.length > 0 && analyzedRoi && (
            <div style={analysisPanel}>
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 6 }}>
                <strong style={{ fontSize: 13, color: "#334" }}>{t("video.analyze.title")}</strong>
                <span style={{ color: "#889", fontSize: 12 }}>
                  {t(analyzedRoi.shape === "ellipse" ? "video.analyze.roiEllipse" : "video.analyze.roiRect", {
                    w: Math.abs(Math.round(analyzedRoi.x1 - analyzedRoi.x0)),
                    h: Math.abs(Math.round(analyzedRoi.y1 - analyzedRoi.y0)),
                  })}
                  {` · ${series.length} ${t("video.frame")}`}
                </span>
                <span style={{ flex: 1 }} />
                <label style={{ display: "flex", alignItems: "center", gap: 4, color: "#667", fontSize: 12 }}>
                  <input type="checkbox" checked={showChannels} onChange={(e) => setShowChannels(e.target.checked)} data-testid="video-analyze-channels" />
                  {t("video.analyze.channels")}
                </label>
                <button type="button" style={toolBtn} onClick={downloadCsv}>
                  {t("video.analyze.csv")}
                </button>
                <button type="button" style={toolBtn} onClick={closeAnalysis}>
                  {t("video.analyze.close")}
                </button>
              </div>
              {(() => {
                // 系列全体の要約統計（平均輝度の平均／全体 min–max／SD の平均）。
                let sumMean = 0;
                let sumSd = 0;
                let lo = Infinity;
                let hi = -Infinity;
                for (const p of series) {
                  sumMean += p.meanY;
                  sumSd += p.sdY;
                  lo = Math.min(lo, p.minY);
                  hi = Math.max(hi, p.maxY);
                }
                const inv = series.length > 0 ? 1 / series.length : 0;
                return (
                  <div style={{ color: "#667", fontSize: 12, marginBottom: 6 }} data-testid="video-analyze-summary">
                    {t("video.analyze.summary", {
                      mean: (sumMean * inv).toFixed(1),
                      min: (Number.isFinite(lo) ? lo : 0).toFixed(0),
                      max: (Number.isFinite(hi) ? hi : 0).toFixed(0),
                      sd: (sumSd * inv).toFixed(1),
                    })}
                  </div>
                );
              })()}
              <TimeIntensityChart
                series={series}
                frameLabel={t("video.analyze.frameAxis")}
                intensityLabel={t("video.analyze.intensityAxis")}
                showChannels={showChannels}
              />
            </div>
          )}

          {/* フレーム指定 ROI の単一フレーム統計パネル（§12 モード①）。 */}
          {frameResult && (
            <div style={analysisPanel} data-testid="video-frame-stats-panel">
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 6 }}>
                <strong style={{ fontSize: 13, color: "#334" }}>
                  {t("video.frameStats.title", { f: frameResult.frame })}
                </strong>
                <span style={{ color: "#889", fontSize: 12 }}>
                  {`${frameResult.bbox.w}×${frameResult.bbox.h}px`}
                </span>
                <span style={{ flex: 1 }} />
                <button type="button" style={toolBtn} onClick={downloadHistogramCsv}>
                  {t("video.frameStats.csv")}
                </button>
                <button
                  type="button"
                  style={toolBtn}
                  data-testid="video-frame-stats-close"
                  onClick={() => setFrameResult(null)}
                >
                  {t("video.analyze.close")}
                </button>
              </div>
              <div style={{ color: "#445", fontSize: 12, marginBottom: 6 }} data-testid="video-frame-stats-summary">
                {t("video.frameStats.summary", {
                  area: frameResult.nPixels,
                  mean: frameResult.meanY.toFixed(1),
                  min: frameResult.minY.toFixed(0),
                  max: frameResult.maxY.toFixed(0),
                  sd: frameResult.sdY.toFixed(1),
                })}
              </div>
              <RoiHistogramChart
                histogram={frameResult.histogram}
                mean={frameResult.meanY}
                intensityLabel={t("video.frameStats.intensityAxis")}
                countLabel={t("video.frameStats.countAxis")}
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}

const frameStyle: React.CSSProperties = {
  background: "#000",
  borderRadius: 8,
  overflow: "hidden",
  display: "flex",
  justifyContent: "center",
  maxWidth: 900,
};

const hostStyle: React.CSSProperties = {
  width: "100%",
  height: "60vh",
  maxHeight: 640,
  minHeight: 240,
};

const videoStyle: React.CSSProperties = {
  width: "100%",
  maxHeight: "70vh",
  display: "block",
};

const controlRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  flexWrap: "wrap",
  gap: 16,
  marginTop: 8,
  maxWidth: 900,
  fontSize: 13,
  color: "#445",
};

const ctrlLabel: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: 6 };
const selectStyle: React.CSSProperties = { padding: "2px 4px", borderRadius: 4, border: "1px solid #cdd5de" };
const frameBtn: React.CSSProperties = {
  padding: "2px 8px",
  border: "1px solid #cdd5de",
  borderRadius: 4,
  background: "#f4f7fa",
  cursor: "pointer",
};
const playBtn: React.CSSProperties = {
  padding: "4px 12px",
  border: "1px solid #cdd5de",
  borderRadius: 6,
  background: "#0b5cad",
  color: "#fff",
  cursor: "pointer",
  fontSize: 14,
  minWidth: 42,
};
const toolBtn: React.CSSProperties = {
  padding: "3px 10px",
  border: "1px solid #cdd5de",
  borderRadius: 6,
  background: "#f4f7fa",
  color: "#334",
  cursor: "pointer",
  fontSize: 12,
};
const toolBtnActive: React.CSSProperties = {
  ...toolBtn,
  background: "#0b5cad",
  color: "#fff",
  // border は shorthand で上書き（toolBtn の border shorthand と borderColor を混在させない＝React 警告回避）。
  border: "1px solid #0b5cad",
};
const analyzeBtn: React.CSSProperties = {
  padding: "3px 10px",
  border: "1px solid #0b5cad",
  borderRadius: 6,
  background: "#eaf2fb",
  color: "#0b5cad",
  cursor: "pointer",
  fontSize: 12,
  fontWeight: 600,
};
// 枠線は borderWidth/Style/Color を個別指定する。ショートハンド `border` と非表示側の `borderStyle` を
// 混ぜると React が「shorthand と non-shorthand の混在」を警告し、実際に再描画時に枠が消えることがある。
const roiChip: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  padding: "2px 4px 2px 8px",
  borderWidth: 1,
  borderStyle: "solid",
  borderColor: "#d3dbe4",
  borderRadius: 12,
  background: "#f4f7fa",
  fontSize: 12,
  color: "#334",
};
/** 現在フレームで非表示の ROI（別フレームに紐づく）。一覧には残すが淡く見せる。 */
const roiChipHidden: React.CSSProperties = {
  ...roiChip,
  background: "#fbfcfd",
  color: "#98a1ab",
  borderStyle: "dashed",
};
/** 解析対象として選択中の ROI。 */
const roiChipSelected: React.CSSProperties = {
  borderColor: "#0b5cad",
  boxShadow: "0 0 0 1px #0b5cad inset",
};
/**
 * チップのラベル（選択ボタン兼用）。見た目は素のテキストに寄せる。
 * ⚠ ショートハンド `font` は使わない（選択時に `fontWeight` を足すと React が混在を警告し、
 * 再描画で片方が消えることがある。同じ理由で {@link roiChip} の枠線も分解してある）。
 */
const roiChipLabel: React.CSSProperties = {
  border: "none",
  background: "transparent",
  padding: 0,
  fontSize: "inherit",
  fontFamily: "inherit",
  color: "inherit",
  cursor: "pointer",
};
const roiChipLabelSelected: React.CSSProperties = {
  ...roiChipLabel,
  color: "#0b5cad",
  fontWeight: 600,
};
const roiScopeBadge: React.CSSProperties = {
  border: "none",
  borderRadius: 8,
  padding: "1px 6px",
  fontSize: 10,
  lineHeight: 1.6,
  cursor: "pointer",
  fontWeight: 600,
};
const roiScopeBadgeGlobal: React.CSSProperties = {
  ...roiScopeBadge,
  background: "#e3edf9",
  color: "#0b5cad",
};
const roiScopeBadgeFrame: React.CSSProperties = {
  ...roiScopeBadge,
  background: "#e8f3ea",
  color: "#2f7a45",
};
const roiChipDel: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 16,
  height: 16,
  border: "none",
  borderRadius: "50%",
  background: "#dce2e9",
  color: "#556",
  cursor: "pointer",
  fontSize: 12,
  lineHeight: 1,
  padding: 0,
};
const analysisPanel: React.CSSProperties = {
  marginTop: 10,
  maxWidth: 900,
  padding: 10,
  border: "1px solid #e2e7ee",
  borderRadius: 8,
  background: "#fff",
};
const noticeStyle: React.CSSProperties = { marginTop: 10, fontSize: 13, color: "#8a6d3b" };
