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
  Enums as csToolsEnums,
} from "@cornerstonejs/tools";
import { useI18n } from "../i18n/i18n";
import { fetchVideoMetadata, videoRenderedUrl, type VideoMetadata } from "../api";
import { ensureCornerstoneInitialized } from "./cornerstoneSetup";
import { ensureVideoMetadataProvider, registerVideoMetadata } from "./videoMetadataProvider";
import { clampFrame, frameToSeekTime } from "./videoFrameTime";
import {
  IDENTITY,
  VIDEO_DEFAULT_VOI,
  flipH as flipHOrient,
  flipV as flipVOrient,
  installVideoDisplay,
  rotate90 as rotate90Orient,
  type OrientableVideoViewport,
  type Orient,
} from "./videoTransform";
import { registerViewerDisplayCommands } from "./viewerCommands";
import { setRoiMaskMeta } from "./roiMaskStore";
import { TOOL_IDS } from "./toolIds";
import { ToolIcon } from "../icons/ToolIcon";
import { UI_ICON_FILES, ACTIVE_ICON_STYLE } from "../icons/toolIcons";

const { MouseBindings } = csToolsEnums;

/**
 * 動画の上に描ける計測・ROI ツール。**ROI は 2D ビューアの ROI 機能が管理する**（段 A3・2026-09-26）。
 * 選ぶのは画面のツールバー（2D ビューアのメニュー）で、`registerViewerDisplayCommands` の `setActiveTool` で届く。
 * 以前は動画ビューアが独自のツールの列・ROI 一覧・帰属の切替・解析を持っていたが、外した
 * （計画 `purrfect-knitting-brooks.md` 段 A3。保存・統計は段 B、全フレーム共通の ROI は段 C）。
 */
const VIDEO_ANNOTATION_TOOLS = [
  TOOL_IDS.length,
  TOOL_IDS.bidirectional,
  TOOL_IDS.angle,
  TOOL_IDS.ellipse,
  TOOL_IDS.rect,
  TOOL_IDS.probe,
  TOOL_IDS.polygon,
  TOOL_IDS.polyline,
  TOOL_IDS.freehand,
  TOOL_IDS.freeLine,
];

/**
 * 画面のツールバー（`setTool`）から動画タイルへ届けてよいツール。Pan・Zoom は左ドラッグにも割り当てられる
 * （中・右ドラッグの割り当てはそのまま残る）。ここに無いツール（ブラシ等）は動画では黙って無視する。
 */
const VIDEO_TOOLBAR_TOOLS = new Set<string>([
  WindowLevelTool.toolName,
  PanTool.toolName,
  ZoomTool.toolName,
  ...VIDEO_ANNOTATION_TOOLS,
]);

/** 動画の ROI を ROI マネージャに載せるための文脈（`SeriesViewer` の `roiContext` と同じ中身）。 */
export interface VideoRoiContext {
  patientKey: string;
  studyUid: string;
  seriesUid: string;
  seriesLabel: string;
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
  /**
   * 🔴 **内部フィールド。公開 API では触れないので直接読み書きする。**
   *
   * `setProperties({ loop })` が更新するのは `videoElement.loop`（HTML 要素の
   * ネイティブループ）**だけ**で、**フレーム範囲の折り返し判定に使う `loop` は
   * コンストラクタの `true` のまま一度も更新されない**（@cornerstonejs/core の
   * `VideoViewport`）。しかも `getProperties()` は `videoElement.loop` を返すため、
   * **設定できたように見えて効いていない**。2 つの loop があることに気付けない。
   */
  loop?: boolean;
  /** 🔴 内部フィールド。再生状態を変えずにプロパティを当てるのに要る（{@link applyPlaybackProps}）。 */
  isPlaying?: boolean;
  play(): Promise<void>;
  pause(): void;
  togglePlayPause(): boolean;
  setFrameNumber(f: number): Promise<void>;
  /** 再生時刻へシーク（秒）。フレーム送りはこちらを使う（{@link frameToSeekTime}）。 */
  setTime(t: number): Promise<void>;
  setPlaybackRate(r?: number): void;
  getFrameNumber(): number;
  getNumberOfSlices(): number;
  resetCamera(): boolean;
  render(): void;
}

type Phase = "loading" | "viewport" | "fallback" | "transcode" | "error";

let engineSeq = 0;

const SPEEDS = [0.25, 0.5, 1, 1.5, 2, 4];

/**
 * ループ／再生速度を viewport に当てる。**再生状態は変えない。**
 *
 * <h3>🚨 なぜ専用の関数が要るのか（2026-09-06 に利用者が発見・v0.2.7）</h3>
 * Cornerstone の `setProperties({ playbackRate })` は内部で `setPlaybackRate()` を呼び、
 * **その末尾が `this.play()` である**。つまり「速度を設定する」だけのつもりで**再生が始まる**。
 *
 * これを知らずに `setProperties(...)` → `togglePlayPause()` と続けると、
 * **直前に勝手に始まった再生を toggle が止める**ため、
 * <b>再生ボタンを押しても再生されず、ボタンも一時停止に切り替わらない</b>。
 * 実際にそのまま v0.2.7 として公開してしまった。
 *
 * <h3>🔴 loop は 2 か所へ入れる</h3>
 * `setProperties({ loop })` は `videoElement.loop` しか変えない。フレーム範囲の折り返し判定は
 * **内部フィールド `loop`** を見ており、そちらは更新されない。両方入れないと効かない。
 */
function applyPlaybackProps(vp: VideoVP, loop: boolean, rate: number): void {
  // 🔑 **当てる前に**再生中かどうかを控える（setProperties がこの後それを変えてしまうため）。
  const wasPlaying = vp.isPlaying === true;
  vp.setProperties({ loop, playbackRate: rate });
  vp.loop = loop;
  // setProperties が勝手に始めた再生を戻す。**元から再生中なら触らない。**
  if (!wasPlaying) {
    vp.pause();
  }
}

function fmtTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) {
    return "0:00";
  }
  const s = Math.floor(sec % 60);
  const m = Math.floor(sec / 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function VideoViewer({
  sopInstanceUid,
  commandKey,
  roiContext,
}: {
  sopInstanceUid: string;
  /**
   * 2D ビューアのタイル ID。渡すと、画面のツールバーの表示の操作（Fit・回転・反転・W/L・階調反転・ツール選択）が
   * この動画にも届く（`registerViewerDisplayCommands`）。
   */
  commandKey?: string;
  /**
   * 描いた ROI を 2D ビューアの ROI マネージャに載せるための文脈。渡すと、描き終えた ROI に
   * 患者・シリーズ・scope（**フレームは T 軸**: `t = フレーム - 1`）を付ける（段 A3）。
   */
  roiContext?: VideoRoiContext;
}) {
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
  // 表示の向き（回転・反転）と階調反転。Cornerstone に差し替えた関数が毎回 ref を読む（videoTransform.ts）
  const orientRef = useRef<Orient>(IDENTITY);
  const invertedRef = useRef(false);
  const [inverted, setInverted] = useState(false);
  // 注釈イベントのリスナは SOP が変わるときにしか張り替えないので、最新の文脈は ref で読む。
  const roiContextRef = useRef(roiContext);
  roiContextRef.current = roiContext;

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

    // この動画の注釈の参照 ID（`videoId:graphy-video:{sop}`）。VideoViewport が `getViewReferenceId` で付ける。
    let refIdOfThisVideo = "";

    /**
     * 描き終えた ROI を ROI マネージャに載せる（2D ビューアの `Viewer2D.onAnnotationDone` と同じ役目）。
     *
     * <p>🔑 **フレームは T 軸。** XA のフレームスタックと同じく `scope.t = フレーム - 1`（z=0・c=0）にする。
     * 全フレーム共通の ROI は、あとで `t: "all"` にする（段 C）。フレームは注釈自身の `sliceIndex`
     * （描いた瞬間のフレーム・0 始まり）から取る。表示中の値を使うと、再生中に描いた ROI がずれる。
     *
     * <p>注意: cornerstone-tools の annotation 系イベントは host element ではなくグローバル `eventTarget` で
     * 発火する。全タイルに届くので、**この動画の注釈だけ**を拾う。
     */
    const onAnnotationCompleted = (evt: Event) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ann = (evt as any)?.detail?.annotation;
      const uid = ann?.annotationUID as string | undefined;
      const md = ann?.metadata as { referencedImageId?: string; sliceIndex?: unknown } | undefined;
      const ctx = roiContextRef.current;
      if (!uid || !ctx || !refIdOfThisVideo || md?.referencedImageId !== refIdOfThisVideo) return;
      const t0 = typeof md.sliceIndex === "number" && md.sliceIndex >= 0 ? md.sliceIndex : 0;
      const sc = { studyUid: ctx.studyUid, seriesUid: ctx.seriesUid, z: 0, c: 0, t: t0 };
      setRoiMaskMeta(uid, { patientKey: ctx.patientKey, seriesLabel: ctx.seriesLabel, scope: sc, origin: sc });
    };
    /**
     * ROI マネージャからの削除・表示の切替を描き直す。動画は 2D ビューアと別の RenderingEngine なので、
     * 本体の描き直しでは届かない。
     */
    const onAnnotationRedraw = () => {
      try {
        vpRef.current?.render();
      } catch {
        /* 破棄済み等は無視 */
      }
    };
    const annotationEvents: [string, (e: Event) => void][] = [
      [csToolsEnums.Events.ANNOTATION_COMPLETED, onAnnotationCompleted],
      [csToolsEnums.Events.ANNOTATION_REMOVED, onAnnotationRedraw],
      [csToolsEnums.Events.ANNOTATION_VISIBILITY_CHANGE, onAnnotationRedraw],
    ];

    const cleanup = () => {
      if (host) {
        host.removeEventListener(EVENTS.IMAGE_RENDERED, onRendered);
      }
      for (const [name, fn] of annotationEvents) eventTarget.removeEventListener(name, fn);
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
    orientRef.current = IDENTITY;
    invertedRef.current = false;
    setInverted(false);
    setPlaying(false);
    setFrame(1);

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
      // ブラウザ非対応コーデックでも、サーバに ffmpeg があれば /rendered が変換して配信する（P4）。
      // 変換できない環境だけ案内を出す。
      if (m.transcodeRequired && !m.transcodeAvailable) {
        setPhase("transcode");
        return;
      }
      const imageId = registerVideoMetadata(sopInstanceUid, m);
      refIdOfThisVideo = `videoId:${imageId}`;
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
        // 回転・反転・ズーム・パン・WW/WL・階調反転を、注釈ツールと描画の両方に効く形で差し替える
        installVideoDisplay(vp as unknown as OrientableVideoViewport, {
          orient: () => orientRef.current,
          inverted: () => invertedRef.current,
        });
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
          tg.addTool(WindowLevelTool.toolName);
          for (const name of VIDEO_ANNOTATION_TOOLS) {
            tg.addTool(name);
            tg.setToolPassive(name);
          }
          tg.setToolActive(PanTool.toolName, { bindings: [{ mouseButton: MouseBindings.Auxiliary }] });
          tg.setToolActive(ZoomTool.toolName, { bindings: [{ mouseButton: MouseBindings.Secondary }] });
          tg.setToolActive(WindowLevelTool.toolName, { bindings: [{ mouseButton: MouseBindings.Primary }] });
          tg.addViewport(viewportId, engineId);
          toolGroupIdRef.current = toolGroupId;
        }
        for (const [name, fn] of annotationEvents) eventTarget.addEventListener(name, fn);
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


  // ループ／再生速度を viewport に反映。
  //
  // 🚨 **ここで再生を始めてはいけない。** 以前は `setProperties(...)` に続けて
  //    `setPlaybackRate(rate)` を呼んでいたが、**どちらも内部で `play()` を呼ぶ**ので、
  //    ループのチェックを触っただけで動画が動き出していた（v0.2.7 で利用者が遭遇）。
  useEffect(() => {
    const vp = vpRef.current;
    if (phase === "viewport" && vp) {
      try {
        applyPlaybackProps(vp, loop, rate);
      } catch {
        /* 未初期化はスキップ */
      }
    }
  }, [loop, rate, phase]);


  const togglePlay = () => {
    const vp = vpRef.current;
    if (!vp) {
      return;
    }
    try {
      // シーク中はループを外してある（{@link seekToFrame} 参照）ので、再生開始時に設定を戻す。
      // 🔴 **`applyPlaybackProps` を通すこと。** 素の `setProperties` は内部で `play()` を呼ぶため、
      //    直後の `togglePlayPause()` がそれを止めてしまい「押しても再生されない」になる。
      applyPlaybackProps(vp, loop, rate);
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
    for (const name of VIDEO_TOOLBAR_TOOLS) {
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

  // ── 表示の操作（画像タイルの操作バー・画面のツールバーと同じ並び）。状態は ref に置き、描き直すだけ ──
  const displayVp = () => vpRef.current as unknown as (VideoVP & OrientableVideoViewport) | null;
  const rerender = () => {
    try {
      vpRef.current?.render();
    } catch {
      /* 無視 */
    }
  };
  const rotateView = () => {
    orientRef.current = rotate90Orient(orientRef.current);
    fitView(); // 幅と高さが入れ替わるので収め直す（中心は保たれる）
  };
  const flipViewH = () => {
    orientRef.current = flipHOrient(orientRef.current);
    rerender();
  };
  const flipViewV = () => {
    orientRef.current = flipVOrient(orientRef.current);
    rerender();
  };
  const zoomView = (f: number) => {
    const vp = displayVp();
    if (!vp) return;
    try {
      vp.setCamera({ parallelScale: vp.getCamera().parallelScale / f });
    } catch {
      /* 無視 */
    }
  };
  const applyInverted = (on: boolean) => {
    invertedRef.current = on;
    setInverted(on);
    const vp = displayVp();
    vp?.setVOI(vp.voiRange);
  };
  const setViewWindow = (center: number, width: number) => {
    const vp = displayVp();
    if (!vp || !(width > 0)) return;
    vp.setVOI({ lower: center - width / 2, upper: center + width / 2 });
    rerender();
  };
  const resetViewWindow = () => {
    displayVp()?.setVOI({ ...VIDEO_DEFAULT_VOI });
    rerender();
  };
  const resetView = () => {
    orientRef.current = IDENTITY;
    invertedRef.current = false;
    setInverted(false);
    displayVp()?.setVOI({ ...VIDEO_DEFAULT_VOI });
    fitView();
  };

  // 画面のツールバー（2D ビューアの上部）からの操作をこの動画に届ける。関数は毎回作り直されるので、
  // 最新のものを ref 経由で呼ぶ（登録は viewport ができたときに 1 回）。
  const displayCmds = {
    fit: fitView,
    reset: resetView,
    rotate90: rotateView,
    flipH: flipViewH,
    flipV: flipViewV,
    invert: () => applyInverted(!invertedRef.current),
    setWindowLevel: setViewWindow,
    resetWindow: resetViewWindow,
    setActiveTool: (name: string) => {
      if (VIDEO_TOOLBAR_TOOLS.has(name)) selectPrimaryTool(name);
    },
  };
  const displayCmdsRef = useRef(displayCmds);
  displayCmdsRef.current = displayCmds;
  useEffect(() => {
    if (!commandKey || phase !== "viewport") return;
    const c = () => displayCmdsRef.current;
    return registerViewerDisplayCommands(commandKey, {
      fit: () => c().fit(),
      reset: () => c().reset(),
      rotate90: () => c().rotate90(),
      flipH: () => c().flipH(),
      flipV: () => c().flipV(),
      invert: () => c().invert(),
      setWindowLevel: (cc, ww) => c().setWindowLevel(cc, ww),
      resetWindow: () => c().resetWindow(),
      setActiveTool: (name) => c().setActiveTool(name),
    });
  }, [commandKey, phase]);


  const seekToFrame = (f: number) => {
    const vp = vpRef.current;
    if (!vp) {
      return;
    }
    const clamped = clampFrame(f, totalFrames);
    try {
      vp.pause();
      setPlaying(false);
      // ⚠ **ループ有効のままだと最終フレームへシークできない**（frame 1 に巻き戻る。2026-07-30 実機検証）。
      // VideoViewport は再生位置がフレーム範囲を超えたと判断すると loop 時に先頭へ戻すため、シーク中は
      // ループを外す。再生を始めるときに {@link togglePlay} が設定を戻す（ループ再生の挙動は変えない）。
      // 🔴 **2 か所に入れる。** `setProperties` は `videoElement.loop` しか変えず、
      //    折り返し判定が見る内部フィールドは更新されない（そのため、この回避策は
      //    2026-07-30 に入れて以来ずっと効いていなかった）。
      vp.setProperties({ loop: false });
      vp.loop = false;
      // 🔑 境目 (n-1)/fps（setFrameNumber）ではなく**フレームの 1/4 の位置**へシークする。
      //    境目だとブラウザの描く絵が 1 つ前になることがあり、「本当に 1 フレームずつ進んでいるのか
      //    分からない」原因になっていた（videoFrameTime.ts・2026-09-25）。
      if (fps > 0) {
        void vp.setTime(frameToSeekTime(clamped, fps, meta?.durationSec ?? undefined));
      } else {
        void vp.setFrameNumber(clamped);
      }
      setFrame(clamped);
    } catch {
      /* 無視 */
    }
  };

  // 🔑 表示領域の大きさが変わったら、描画面（canvas）の解像度を合わせる。これが無いと枠だけが
  //    伸び縮みして絵が引き伸ばされ、縦横比が崩れていた（2026-09-25 ユーザ報告）。表示の状態は保つ。
  useEffect(() => {
    const el = hostRef.current;
    if (phase !== "viewport" || !el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      try {
        engineRef.current?.resize(true, true);
      } catch {
        /* 破棄後の通知は無視 */
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [phase]);

  /**
   * キーボードでフレーム送り（この動画ビューアにフォーカスがあるときだけ）。
   * ←/→ = ±1、Shift で ±10、Home/End = 先頭/末尾、Space = 再生/一時停止。
   * 入力欄・選択欄では奪わない（数値を打っている最中に矢印キーでフレームが動かないように）。
   */
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const tag = (e.target as HTMLElement).tagName?.toLowerCase();
    const type = ((e.target as HTMLInputElement).type || "").toLowerCase();
    if (tag === "textarea" || tag === "select" || (tag === "input" && type !== "range" && type !== "checkbox")) return;
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    const step = e.shiftKey ? 10 : 1;
    if (e.key === "ArrowRight") seekToFrame(frame + step);
    else if (e.key === "ArrowLeft") seekToFrame(frame - step);
    else if (e.key === "Home") seekToFrame(1);
    else if (e.key === "End") seekToFrame(totalFrames);
    else if (e.key === " ") togglePlay();
    else return;
    e.preventDefault();
    e.stopPropagation(); // 2D ビューアの ↑↓ や Space（シネ）と取り合わない
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
    <div
      style={{ marginTop: 10, outline: "none" }}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onPointerDown={(e) => {
        // 動画の上を押したらキーボード送りの対象にする（入力欄・ボタンを押したときはそちらに任せる）。
        // 🔴 ボタンの中のアイコン（img）もボタンとして扱う。また focus でスクロールさせない。
        //    スクロールで押している最中のボタンがずれ、クリックが失われていた（パンのボタンが 1 回目に効かない）。
        const target = e.target as HTMLElement;
        if (!target.closest("input, select, textarea, button")) {
          (e.currentTarget as HTMLDivElement).focus({ preventScroll: true });
        }
      }}
      data-testid="video-viewer"
    >
      {/* VideoViewport のホスト。cornerstone が内部に canvas を生成する。常時マウントして ref を確保。 */}
      <div style={frameStyle}>
        <div ref={hostRef} data-testid="video-viewport-host" style={hostStyle} />
      </div>

      {phase === "loading" && <div style={{ ...noticeStyle, color: "#889" }}>{t("common.loading")}</div>}

      {phase === "viewport" && (
        <>
          {/* 表示の操作バー（画像タイルと同じ並び: Fit・パン・縮小/拡大・回転・左右/上下反転・階調反転・リセット） */}
          <div style={{ ...controlRowStyle, gap: 4 }} data-testid="video-display-bar">
            <button type="button" style={iconBtn} data-testid="video-fit" onClick={fitView} title={t("viewer.fit")}>
              <ToolIcon file={UI_ICON_FILES.fit} size={16} />
            </button>
            <button
              type="button"
              style={activeTool === PanTool.toolName ? iconBtnOn : iconBtn}
              data-testid="video-pan"
              aria-pressed={activeTool === PanTool.toolName}
              onClick={() => selectPrimaryTool(activeTool === PanTool.toolName ? WindowLevelTool.toolName : PanTool.toolName)}
              title={t("viewer.pan")}
            >
              <ToolIcon
                id={TOOL_IDS.pan}
                size={16}
                style={activeTool === PanTool.toolName ? ACTIVE_ICON_STYLE : undefined}
              />
            </button>
            <button type="button" style={iconBtn} data-testid="video-zoom-out" onClick={() => zoomView(1 / 1.2)} title={t("viewer.zoomOut")}>
              −
            </button>
            <button type="button" style={iconBtn} data-testid="video-zoom-in" onClick={() => zoomView(1.2)} title={t("viewer.zoomIn")}>
              ＋
            </button>
            <button type="button" style={iconBtn} data-testid="video-rotate" onClick={rotateView} title={t("viewer.rotate")}>
              <ToolIcon file={UI_ICON_FILES.rotate} size={16} />
            </button>
            <button type="button" style={iconBtn} data-testid="video-flip-h" onClick={flipViewH} title={t("viewer.flipH")}>
              <ToolIcon file={UI_ICON_FILES.flipH} size={16} />
            </button>
            <button type="button" style={iconBtn} data-testid="video-flip-v" onClick={flipViewV} title={t("viewer.flipV")}>
              <ToolIcon file={UI_ICON_FILES.flipV} size={16} />
            </button>
            <button
              type="button"
              style={inverted ? iconBtnOn : iconBtn}
              data-testid="video-invert"
              aria-pressed={inverted}
              onClick={() => applyInverted(!inverted)}
              title={t("viewer.invert")}
            >
              <ToolIcon file={UI_ICON_FILES.invert} size={16} style={inverted ? ACTIVE_ICON_STYLE : undefined} />
            </button>
            <button type="button" style={iconBtn} data-testid="video-reset" onClick={resetView} title={t("viewer.reset")}>
              <ToolIcon file={UI_ICON_FILES.reset} size={16} />
            </button>
          </div>


          {/* シークバー（フレーム精度。1..totalFrames）。 */}
          <div style={{ ...controlRowStyle, gap: 10 }}>
            <button
              type="button"
              style={playBtn}
              onClick={togglePlay}
              title={t(playing ? "video.pause" : "video.play")}
              // 🔴 **testid が無い操作対象は自動検査されない。** 実際これが無かったせいで
              //    再生ボタンの不具合が automator を素通りした（v0.2.7）。
              data-testid="video-play"
              data-playing={playing ? "1" : "0"}
            >
              {playing ? "⏸" : "▶"}
            </button>
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
              {/* フレーム番号を常に出す（1 フレームずつ進んでいることが分かるように）。時刻は添える */}
              <span data-testid="video-frame-number" style={{ fontWeight: 600, color: "#223" }}>
                {t("video.frame")} {frame} / {totalFrames}
              </span>
              {fps > 0 && <span style={{ marginLeft: 8 }}>{`${fmtTime(curSec)} / ${fmtTime(totSec)}`}</span>}
            </span>
          </div>

          <div style={controlRowStyle}>
            <label style={ctrlLabel}>
              <input
                type="checkbox"
                checked={loop}
                onChange={(e) => setLoop(e.target.checked)}
                data-testid="video-loop"
              />
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


            {meta && (
              <span style={{ color: "#889", fontSize: 12 }}>
                {meta.columns}×{meta.rows}
                {fps > 0 ? ` · ${fps.toFixed(fps % 1 === 0 ? 0 : 1)} fps` : ""}
                {totalFrames > 1 ? ` · ${totalFrames} ${t("video.frame")}` : ""}
              </span>
            )}
          </div>

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

const iconBtn: React.CSSProperties = {
  minWidth: 28,
  height: 26,
  padding: "0 6px",
  border: "1px solid #c9d3dd",
  borderRadius: 4,
  background: "#fff",
  color: "#223",
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
};
const iconBtnOn: React.CSSProperties = { ...iconBtn, background: "#0b5cad", border: "1px solid #0b5cad", color: "#fff" };

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
const noticeStyle: React.CSSProperties = { marginTop: 10, fontSize: 13, color: "#8a6d3b" };
