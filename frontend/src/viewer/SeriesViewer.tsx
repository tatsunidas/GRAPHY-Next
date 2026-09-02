/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { getRenderingEngine, type Types } from "@cornerstonejs/core";
import { ToolGroupManager } from "@cornerstonejs/tools";
import { Viewer2D, ENGINE_ID, type ViewerOverlays, type RenderOverlay } from "./Viewer2D";
import { applyTransform, readTransform, FIT_TRANSFORM } from "./transform";
import { ToolIcon } from "../icons/ToolIcon";
import { UI_ICON_FILES } from "../icons/toolIcons";
import { buildSeriesLayout, buildLayoutFromDto, DEFAULT_AXES, type AxisSpec, type SeriesLayout } from "./seriesLayout";
import CineControls from "./CineControls";
import { XaAnalysisDialog } from "./XaAnalysisDialog";
import { Xa3dBifurcationDialog } from "./Xa3dBifurcationDialog";
import { XaQlvDialog } from "./XaQlvDialog";
import { Xa3dQcaDialog } from "./Xa3dQcaDialog";
import { useQcaRuns } from "./xaRecon3dStore";
import { consumeXaTask, isFreshRequest, matchesRequest, onXaTaskRequest, pullXaTask } from "./xaTaskLaunch";
import { prewarmXaDataset, readXaCineSource, resolveXaFps, type XaCineSource } from "./xaCine";
import { readVoiWindow } from "./viewportRead";
import type { XaExportWindow } from "./xaFrameExport";
import { downloadBytes, exportFramesAsZip } from "./xaFrameExport";
import { encodeXaMp4 } from "../api";
import {
  autoAlignDsa,
  dsaImageId,
  dsaSessionState,
  measureDsaResidual,
  prepareDsaSession,
  readXaDsaTags,
  rebuildDsaMask,
  releaseDsaSession,
  setDsaLogarithmic,
  setDsaMaskFrames,
  setDsaShift,
  type DsaSessionState,
} from "./dsaLoader";
import {
  buildSortMeta,
  computeZOrder,
  applySortToLayout,
  isIppMode,
  type SortMeta,
  type SortMode,
} from "./seriesSort";
import { registerSeriesCommands } from "./seriesCommands";
import { emitToast } from "./toast";
import { registerSegGeometryFromLayout } from "./segMetadata";
import { registerSliceSync, publishSlice, setSliceSyncConfig } from "./sliceSync";
import { computeSliceSpacing } from "./imageInfo";
import {
  THICK_SLAB_THICKNESSES,
  isThickSlabAvailable,
  isOriginalThickness,
  slicesPerStepOf,
  digitalCountOf,
  digitalToFractionalOriginalZ,
  digitalToNativeZ,
  originalToDigitalZ,
  registerThickSlabSession,
  thickSlabImageId,
} from "./thickSlab";
import { imageIdForInstance, sopUidFromImageId, type ViewerMode } from "./imageId";
import { XaPresentationDialog } from "./XaPresentationDialog";
import type { PresentationPlan } from "./xaPresentationApply";
import {
  ensureXaCalibrationsLoaded,
  persistXaUserCalibration,
} from "./xaCalibrationPersistence";
import { advanceAnchor, sliceStepsFromDrag } from "./touchScroll";
import { createWheelStepper } from "./wheelScroll";
import { isSliceNavigationLocked, useSliceNavigationLocked } from "./sliceNavigationLock";
import { isInsideViewerOverlay } from "./viewerOverlay";
import { installDebugApi, countStackSwap } from "./debugApi";
import { matchesCombo, matchesShortcut } from "../shortcuts/registry";
import { fetchSeriesLayout, type Instance } from "../api";
import { fetchSettings } from "../settings/settingsApi";
import { useI18n } from "../i18n/i18n";
import { LoadingSpinner } from "./LoadingSpinner";
// 副作用インポート: このウィンドウが保持するマスクを、他ウィンドウからのウィンドウ間同期要求
// （BroadcastChannel）に応答できるよう即座に待ち受け開始する（`fw/mask-driven-pipelines-gap-analysis.md` 課題#1）。
import "./maskBridge";

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
/** 参照同一性を保つための空配列（毎回新しい [] を渡すと Viewer2D が組み直す）。 */
const EMPTY_IMAGE_IDS: string[] = [];

export function SeriesViewer({
  instances,
  mode,
  studyUid,
  seriesUid,
  fillHeight = false,
  showControls = true,
  syncEnabled = false,
  referenceLinesEnabled = false,
  referenceLabel,
  commandKey,
  patientKey,
  seriesLabel,
  onDimChange,
  renderFusionOverlay,
  acceptsTaskLaunch = false,
}: {
  instances: Instance[];
  mode: ViewerMode;
  studyUid: string;
  seriesUid: string;
  /** タイル表示用: 親コンテナの高さに追従する（flex:1 レイアウト）。 */
  fillHeight?: boolean;
  /**
   * 画像下のツールパネル（Viewer2D の操作バー＋スライダー/ThickSlab/オーバーレイ行）を表示するか。
   * false にするとパネルを畳んで画像領域を全高まで拡張する。複数タイル比較時に全タイルで false に
   * すれば、次元数（C/T スライダーの有無）に依らず全タイルが同一サイズの画像パネルになる。
   * 既定 true（単独表示・StudyList では従来どおり）。
   */
  showControls?: boolean;
  /** シリーズ Sync: このタイルの Sync トグルが ON か。ON かつ SliderView 時のみ同期に参加。 */
  syncEnabled?: boolean;
  /** リファレンスライン: 他シリーズの現在スライス面の交差線をこのビューに描画する。 */
  referenceLinesEnabled?: boolean;
  /** リファレンスラインの凡例に使うシリーズ名。 */
  referenceLabel?: string;
  /** 画面メニュー/ツールバーからの一括コマンドのキー（= tileId）。 */
  commandKey?: string;
  /** ROI/Mask 紐付け用: 患者キー・シリーズ表示名。 */
  patientKey?: string;
  seriesLabel?: string;
  /** 現在表示中の Z/C/T インデックス変化を上位に通知（Fusion の初期 C/T 引き継ぎ・Histogram の初期 Z/C/T 用）。 */
  onDimChange?: (c: number, t: number, z: number) => void;
  /** Fusion オーバーレイ。スライダー表示時に base 画像へ重ねて描画する（GridView では無効）。 */
  renderFusionOverlay?: RenderOverlay;
  /**
   * タスク・ランチャー（A13-2）からの依頼を引き受けるか。**2D ビューアのタイルだけ true**。
   *
   * <p>🚨 既定 false なのは、`StudyList` のプレビューも同じ `SeriesViewer` だからである。
   * これを付けないと**メインウィンドウのプレビューが依頼を先に引き取り**、
   * 開いたばかりの 2D ビューアには何も起きない（実機検証で実際にこうなった）。
   */
  acceptsTaskLaunch?: boolean;
}) {
  const { t } = useI18n();
  // automator（自律検証ツール）用デバッグAPI。dev ビルドのみ、冪等（fw/HANDOFF.md 参照なし・
  // automator/checklist/10-viewer2d-core.md 参照）。
  useEffect(() => { installDebugApi(); }, []);
  const imageIds = useMemo(
    () => instances.map((i) => imageIdForInstance(mode, i.sopInstanceUid, studyUid, seriesUid)),
    [instances, mode, studyUid, seriesUid],
  );
  const fallback = useMemo(() => buildSeriesLayout(imageIds), [imageIds]);

  // backend の ZCT レイアウト（IPP→Z / Temporal→T / Echo・Bvalue→C / モザイク Z×T）。
  // 取得まで/失敗時は単一次元。
  const [baseLayout, setBaseLayout] = useState<SeriesLayout>(fallback);
  // backend レイアウトが解決したか（then/catch=finally で true）。解決までは Viewer をマウントせず、
  // モザイク/マルチフレームの「生画像1枚（＝モザイクグリッド）が一瞬見えてから分解パネルへ遷移」を防ぐ。
  // フォールバック（imageIdForInstance=生インスタンス）はモザイクだと必ず生グリッドを描くため、
  // instances 数に依らず解決待ちにする。レイアウトはメタデータのみで高速（実測 ~45ms）なので、
  // 通常シリーズも Viewer 自身の初期ロード内に収まり体感差はほぼ無い。ハング対策に安全タイムアウトあり。
  const [layoutReady, setLayoutReady] = useState(false);
  // Z 並べ替え（InstanceNumber / IPP, 昇順・降順）。null=backend 既定順（IPP 昇順）。
  const [sortMode, setSortMode] = useState<SortMode | null>(null);
  const [sortMeta, setSortMeta] = useState<SortMeta | null>(null);
  useEffect(() => {
    setBaseLayout(fallback);
    setLayoutReady(false);
    // シリーズが変わったら並べ替え状態をリセット。
    setSortMode(null);
    setSortMeta(null);
    let cancelled = false;
    fetchSeriesLayout(studyUid, seriesUid)
      .then((dto) => {
        if (cancelled) return;
        const built = buildLayoutFromDto(dto, mode, studyUid, seriesUid);
        if (built) {
          setBaseLayout(built);
          setSortMeta(buildSortMeta(dto, instances, built.normal ?? null));
          // セグメンテーション labelmap 生成の画素プリロード撤廃用に、backend 幾何を
          // メタデータプロバイダへ登録（fw/segmentation-tools-design.md §3.4）。
          registerSegGeometryFromLayout(dto, built, seriesUid);
        }
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
  }, [studyUid, seriesUid, fallback, mode, instances]);

  // 安全網: レイアウト取得がハング/極端に遅い場合でも、一定時間で Viewer 描画へ進む
  // （その場合はフォールバック描画＝従来挙動）。通常は 45ms 程度で解決し先に ready になる。
  useEffect(() => {
    if (layoutReady) return;
    const id = window.setTimeout(() => setLayoutReady(true), 1000);
    return () => window.clearTimeout(id);
  }, [layoutReady, studyUid, seriesUid]);

  // 表示用レイアウト = 既定順に Z 並べ替えを適用（C/T 割当は保持）。
  const layout = useMemo(() => {
    if (!sortMode || !sortMeta) return baseLayout;
    return applySortToLayout(baseLayout, computeZOrder(sortMeta, sortMode));
  }, [baseLayout, sortMode, sortMeta]);

  const [z, setZ] = useState(0);
  const [c, setC] = useState(0);
  const [tIdx, setTIdx] = useState(0);
  const [overlays, setOverlays] = useState<OverlayState>({
    text: true,
    caliper: true,
    orientation: true,
    roi: false,
  });
  // シネ再生は Z/C/T それぞれ独立。各次元のインデックスをループ送りする。
  const [playZ, setPlayZ] = useState(false);
  // 解析中（QCA 等）はフレームを固定する。スライダー・シネ・ホイール・キーの**全部**を止める
  // ——1 つでも残すと、そこから裏でフレームが動いて数値と画像が食い違う。
  const navLocked = useSliceNavigationLocked();
  const [playC, setPlayC] = useState(false);
  const [playT, setPlayT] = useState(false);
  // シネ速度は環境設定 viewer.cineFps から（既定 10）。
  const [fps, setFps] = useState(10);
  useEffect(() => {
    fetchSettings()
      .then((m) => {
        const v = Number(m["viewer.cineFps"]);
        if (Number.isFinite(v) && v >= 1) setFps(v);
        // シリーズ Sync の方式（座標/単純）と許容半径(mm)をグローバル coordinator に反映。
        const coord = m["viewer.coordinateSync"] !== "false"; // 既定 true
        const margin = Number(m["viewer.coordinateSyncMargin"]);
        setSliceSyncConfig(coord ? "coordinate" : "simple", Number.isFinite(margin) ? margin : 2.5);
      })
      .catch(() => {
        /* 既定のまま */
      });
  }, []);
  const [gridCols, setGridCols] = useState(0); // 0=Slider(SingleGridView), >0=Grid(FilmGrid) 列数

  // ── 軸の提示とスタック軸（fw/angio-design.md §5.7）───────────────────────────
  // 「スタック」= Viewer2D に渡す imageIds ＝ホイール送り/Grid/プリフェッチの単位。
  // 既定は Z（CT/MR）。XA シネは T（フレーム）で、その場合 z 状態＝フレーム位置・
  // tIdx 状態＝ラン選択、という**役割の入れ替え**だけで既存の送り機構がそのまま効く。
  const axes: { z: AxisSpec; c: AxisSpec; t: AxisSpec } = layout.axes ?? DEFAULT_AXES;
  const isFrameStack = layout.stackAxis === "t" && typeof layout.tStack === "function";
  /** スタック軸の提示（スライダーのラベル・種別）。 */
  const stackAxisSpec = isFrameStack ? axes.t : axes.z;
  /** スタック以外のもう 1 本（frame-stack ならラン、通常なら T=時相）。 */
  const otherAxisSpec = isFrameStack ? axes.z : axes.t;
  const otherCount = isFrameStack ? layout.nZ : layout.nT;
  /** もう一方の軸の現在位置（frame-stack ではラン番号、通常は T）。状態は tIdx を共用する。 */
  const otherIdx = Math.min(Math.max(0, tIdx), Math.max(0, otherCount - 1));

  const cc = Math.min(Math.max(0, c), layout.nC - 1);
  const tc = isFrameStack ? 0 : otherIdx;
  const zStack = isFrameStack ? (layout.tStack?.(otherIdx, cc) ?? []) : layout.zStack(cc, tc);
  const nZ = zStack.length;
  // zStack は layout.zStack が毎レンダ新配列を返すため、依存キーは (layout, cc, tc/otherIdx) で安定化する。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const zStackKey = useMemo(() => zStack.join("|"), [layout, cc, tc, otherIdx, isFrameStack]);

  // マルチチャンネル / 動画(ビデオ UID) / スライス1枚 では GridView を無効化。
  // XA シネはスタック＝フレームなので Grid は「フレーム一覧」として意味が通る（無効化しない）。
  const hasVideo = useMemo(
    () => instances.some((i) => i.sopClassUid && VIDEO_SOP_CLASSES.has(i.sopClassUid)),
    [instances],
  );
  const gridDisabled = layout.nC > 1 || hasVideo || nZ <= 1;
  const gridOn = gridCols > 0 && !gridDisabled;

  // ── ThickSlab（デジタルスライス厚）─ 2D Slice(SliderView) のみ。動画(MPEG含む)/単一スライス/
  //    カラーでは無効。実スライス厚に一致する厚みを選ぶと Original（合成しない）。─────────────
  const [thickSlabOn, setThickSlabOn] = useState(false);
  const [thickSlabMm, setThickSlabMm] = useState<number>(2.0);
  const [spacingZ, setSpacingZ] = useState<number | null>(null);
  // スタックが空間スライスでない（XA のフレーム軸など）なら ThickSlab の概念が無い → 行ごと隠す。
  const spatialStack = stackAxisSpec.kind === "slice";
  const thickAvailable = spatialStack && isThickSlabAvailable({ hasVideo, nZ }) && !gridOn;

  // 実スライス間隔(mm)を先頭2枚の IOP/IPP から算出（デジタル枚数換算・厚み範囲に使う）。
  const spacingDep = `${spatialStack ? 1 : 0}|${nZ}|${zStack[0] ?? ""}|${zStack[1] ?? ""}`;
  useEffect(() => {
    if (!spatialStack || nZ < 2) {
      setSpacingZ(null);
      return;
    }
    let cancelled = false;
    computeSliceSpacing(zStack[0], zStack, undefined)
      .then((r) => {
        if (!cancelled) setSpacingZ(r.spacing);
      })
      .catch(() => {
        if (!cancelled) setSpacingZ(null);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spacingDep]);

  const thickOriginal = spacingZ != null && isOriginalThickness(thickSlabMm, spacingZ);
  const effectiveThick =
    thickSlabOn && thickAvailable && spacingZ != null && spacingZ > 0 && thickSlabMm > 0 && !thickOriginal;
  const slicesPerStep = effectiveThick ? slicesPerStepOf(thickSlabMm, spacingZ!) : 1;
  const digitalCount = effectiveThick ? digitalCountOf(nZ, slicesPerStep) : nZ;
  // 送り(スライダー/キー/ホイール/シネ/同期)の母数。ThickSlab ON はデジタル枚数、OFF はネイティブ枚数。
  const activeCount = effectiveThick ? digitalCount : nZ;

  const zc = Math.min(Math.max(0, z), activeCount - 1);
  // 現在位置に対応するネイティブ Z（currentImageId・ippAt・onDimChange・参照線に使う）。
  const nativeZ = effectiveThick ? digitalToNativeZ(zc, slicesPerStep, nZ) : zc;

  // ThickSlab セッション登録 → 合成 imageId 配列（graphy-thickslab:）。パラメータが同じなら
  // 同一トークン＝配列安定＝StackViewport を再初期化しない。
  const thickToken = useMemo(() => {
    if (!effectiveThick) return null;
    return registerThickSlabSession({
      seriesUid,
      c: cc,
      t: tc,
      thicknessMm: thickSlabMm,
      spacingZmm: spacingZ!,
      nativeIds: zStack,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveThick, seriesUid, cc, tc, thickSlabMm, spacingZ, zStackKey]);
  const thickImageIds = useMemo(() => {
    if (!thickToken) return null;
    return Array.from({ length: digitalCount }, (_, dz) => thickSlabImageId(thickToken, dz));
  }, [thickToken, digitalCount]);
  // Viewer2D に渡す実表示スタック（ThickSlab ON なら合成 imageId、OFF なら native）。
  // DSA ON（フレーム軸）のときは graphy-dsa: の合成 imageId に差し替える。
  // 版番号を imageId に混ぜることで、シフト/マスクを変えたら別 imageId ＝ 再合成になる。
  // ── DSA（サブトラクション）─ フレーム軸（XA/XRF）のときだけ（fw/angio-design.md §6）────
  const [dsaOn, setDsaOn] = useState(false);
  const [dsaToken, setDsaToken] = useState<string | null>(null);
  const [dsaState, setDsaState] = useState<DsaSessionState | null>(null);
  const [dsaResidual, setDsaResidual] = useState<number | null>(null);
  // 合成パラメータ（シフト・マスク）を変えたら imageId を作り直して再合成させるための版番号。
  const [dsaVersion, setDsaVersion] = useState(0);
  const [dsaBusy, setDsaBusy] = useState(false);
  // 校正 / QCA ダイアログ（fw/angio-design.md §7.3 / §8）。
  const [xaDialogOpen, setXaDialogOpen] = useState(false);
  const [qlvDialogOpen, setQlvDialogOpen] = useState(false);
  const [qvaDialogOpen, setQvaDialogOpen] = useState(false);
  const [xaBifDialogOpen, setXaBifDialogOpen] = useState(false);
  const [xa3dDialogOpen, setXa3dDialogOpen] = useState(false);
  /** 表示状態（GSPS）の読み込み（§14.1）。 */
  const [prDialogOpen, setPrDialogOpen] = useState(false);
  /**
   * DSA を後から立ち上げて当てるための保留分。
   * 🚨 DSA のセッションは非同期に張られるので、**token が来てから**マスクとシフトを当てる。
   * 当てる前に「適用しました」と出すと、DSA だけ効いていない状態を成功と読ませてしまう。
   */
  const [pendingDsaPlan, setPendingDsaPlan] = useState<PresentationPlan["dsa"] | null>(null);
  /** 3D QCA に使える「2D QCA 実行済みの方向」。2 つ揃うまでボタンは押せない。 */
  const qcaRuns = useQcaRuns();
  // 空間校正の確定/解除は imageId を変えないため、Viewer2D にメタデータを読み直させる鍵。
  const [calibVersion, setCalibVersion] = useState(0);
  // 保存済みの空間校正を戻す（§7.4）。戻ったら表示（スケールバー・計測ラベル）を作り直す。
  useEffect(() => {
    let cancelled = false;
    ensureXaCalibrationsLoaded()
      .then((n) => {
        if (!cancelled && n > 0) setCalibVersion((v) => v + 1);
      })
      .catch(() => {
        /* 取れなくても表示は続ける（校正が無い状態＝px 表示で安全側） */
      });
    return () => {
      cancelled = true;
    };
  }, []);
  // 連番 PNG エクスポート（fw/angio-design.md §14.3）。
  const [exportBusy, setExportBusy] = useState(false);
  const [exportDone, setExportDone] = useState(0);

  // タスク・ランチャー（A13-2）からの「このシリーズでこの解析を開け」を受ける。
  // 🚨 **宛先と鮮度は受け手が判定する**（`viewer/xaTaskLaunch.ts`）。タイルは複数開けるので、
  //    判定を省くと**依頼したのとは別のシリーズで解析ダイアログが開く**。
  useEffect(() => {
    // プレビュー（`StudyList`）は依頼を引き受けない。上の `acceptsTaskLaunch` を参照。
    if (!acceptsTaskLaunch) return;
    const off = onXaTaskRequest((req) => {
      if (!matchesRequest(req, { studyUid, seriesUid })) return;
      if (!isFreshRequest(req, Date.now())) return;
      // 🚨 **まだ判断できない状態で引き取らない。** レイアウトが解決する前は `isFrameStack` が
      //    false なので、ここで引き取ると「解析できないシリーズ」として捨ててしまう
      //    （実際にこれで実機検証が落ちた）。レイアウトが決まると依存が変わって効果が張り直り、
      //    もう一度 `pullXaTask()` が走るので取りこぼさない。
      if (!layoutReady) return;
      consumeXaTask(req.id);
      if (!isFrameStack) {
        // XA でもフレーム軸が無いシリーズ（単発の静止画など）は解析できない。
        // 引き取った上で**黙って何も起きない状態にしない**。
        emitToast(t("xa.task.reason.noFrames"));
        return;
      }
      if (req.target === "xaAnalysis") setXaDialogOpen(true);
      else if (req.target === "qva") setQvaDialogOpen(true);
      else if (req.target === "qlv") setQlvDialogOpen(true);
      else if (req.target === "qca3d") setXa3dDialogOpen(true);
    });
    // ビューアのウィンドウは依頼より後に立ち上がる。保留分を取りに行く。
    pullXaTask();
    return off;
  }, [acceptsTaskLaunch, studyUid, seriesUid, isFrameStack, layoutReady, t]);

  const dsaImageIds = useMemo(() => {
    if (!dsaToken) return null;
    return zStack.map((_id, t) => dsaImageId(dsaToken, t, dsaVersion));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dsaToken, dsaVersion, zStackKey]);
  const rawDisplayImageIds = dsaImageIds ?? thickImageIds ?? zStack;

  // ── XA シネ: dataSet を先に温めてから表示する（fw/angio-design.md §5.5）──────────────
  // 🚨 プリウォームは必須。dicom-image-loader は「dataSet 未キャッシュの初回だけ 1 origin の
  //    フレーム番号を渡す」ため、温めずに描くと最初の 1 枚だけ 1 フレームずれた画像が
  //    Cornerstone の画像キャッシュに載ってしまう（詳細は prewarmXaDataset の JSDoc）。
  const [xaCineSource, setXaCineSource] = useState<XaCineSource | null>(null);
  /** プリウォームが決着した（成功・失敗どちらでも）スタック。表示のゲートに使う。 */
  const [xaPrewarmedKey, setXaPrewarmedKey] = useState<string | null>(null);
  const isFrameStackRef = useRef(isFrameStack);
  isFrameStackRef.current = isFrameStack;
  useEffect(() => {
    if (!isFrameStack) {
      setXaCineSource(null);
      return;
    }
    const first = zStack[0];
    if (!first) return;
    let cancelled = false;
    prewarmXaDataset(first)
      .then(() => {
        if (!cancelled) setXaCineSource(readXaCineSource(first));
      })
      .catch(() => {
        // 取得できなくても既定 fps で再生はできる（描画は通常の imageLoader が再試行する）。
        if (!cancelled) setXaCineSource(null);
      })
      .finally(() => {
        // 失敗しても解除する。ここで止め続けると「何も映らない」ほうの事故になる。
        if (!cancelled) setXaPrewarmedKey(zStackKey);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isFrameStack, zStackKey]);

  /**
   * プリウォームが終わるまでフレームを渡さない。
   *
   * <p>🚨 プリウォームを**始める**だけでは足りない。`Viewer2D` は同じマウントで即座に
   * 1 枚目を読みに行くので、dataSet の取得と競走になる。画像ロードが先に立つと
   * 1 origin の枝を通り、**1 枚目だけ「次のフレーム」の画素**が Cornerstone の画像
   * キャッシュに載る。しかも表示は正しく見える（隣接フレームは似ているため）。
   *
   * <p>実データ（Rubo）では毎回プリウォームが競走に勝っていたので気づけず、
   * **フレームごとに中身が違う GNBP-XA ファントム**で初めて露見した
   * （1 フレーム目の QCA が 2 フレーム目の値を返した）。`isXaDatasetReady` は
   * このために用意してあったのに、どこからも呼ばれていなかった。
   */
  const xaReady = !isFrameStack || xaPrewarmedKey === zStackKey;
  const displayImageIds = xaReady ? rawDisplayImageIds : EMPTY_IMAGE_IDS;

  // シリーズ/ランが変わったら DSA は解除する（別ランのマスクを引きずらない）。
  useEffect(() => {
    setDsaOn(false);
  }, [seriesUid, otherIdx]);

  useEffect(() => {
    if (!dsaOn || !isFrameStack || zStack.length < 2) {
      setDsaToken((prev) => {
        if (prev) releaseDsaSession(prev);
        return null;
      });
      setDsaState(null);
      setDsaResidual(null);
      return;
    }
    let cancelled = false;
    setDsaBusy(true);
    const tags = readXaDsaTags(zStack[0]);
    prepareDsaSession({
      frameIds: zStack,
      maskFrames: tags?.maskFrames ?? null,
      pixelIntensityRelationship: tags?.pixelIntensityRelationship ?? null,
      dx: tags?.dx ?? 0,
      dy: tags?.dy ?? 0,
    })
      .then((token) => {
        if (cancelled) {
          if (token) releaseDsaSession(token);
          return;
        }
        if (!token) {
          emitToast(t("dsa.failed"));
          setDsaOn(false);
          return;
        }
        setDsaToken(token);
        setDsaState(dsaSessionState(token));
        // 残差は最初から出す（シフトを触るまで数値が出ないと「効いているか」が判断できない）。
        measureDsaResidual(token, zc)
          .then((r) => setDsaResidual(r))
          .catch(() => setDsaResidual(null));
      })
      .catch(() => {
        if (!cancelled) {
          emitToast(t("dsa.failed"));
          setDsaOn(false);
        }
      })
      .finally(() => {
        if (!cancelled) setDsaBusy(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dsaOn, isFrameStack, zStackKey]);

  /**
   * 表示中のフレーム列を PNG にして ZIP で保存する（fw/angio-design.md §14.3）。
   * DSA 表示中は差分画像がそのまま出る（displayImageIds を読むため）。
   */
  /**
   * 書き出しに焼く表示条件。**画面と同じ W/L・反転**を全フレームに当てる。
   *
   * 🚨 null を渡す（＝フレームごとに自動 W/L）と**画面と違う絵**になり、しかも
   * フレームごとに窓が変わるので**ちらつく**。DSA のマスク区間のような一様なフレームでは
   * ノイズが全幅に引き伸ばされ、実機で「マスク区間なのに砂嵐」になった（2026-08-23）。
   */
  const exportWindow = (): XaExportWindow | null => {
    // 🚨 **表示中の imageId が一致するビューポートから読む。**
    //    リンク用ツールグループの先頭（`firstLinkedViewport`）から読むと、レイアウトや
    //    登録の状況で**取れないことがある**——実機ではそれで null になり、
    //    フレームごとの自動 W/L に落ちていた（MP4 の先頭フレームが中間調へ寄る形で発覚）。
    const target = displayImageIds[zc];
    if (!target) return null;
    const engine = getRenderingEngine(ENGINE_ID);
    for (const vp of engine?.getViewports() ?? []) {
      const current = (vp as { getCurrentImageId?: () => string | undefined }).getCurrentImageId?.();
      if (current !== target) continue;
      const w = readVoiWindow(vp);
      if (!w) continue;
      const invert = !!(vp.getProperties?.() as { invert?: boolean } | undefined)?.invert;
      // 🔴 **DSA の合成画像は、素直な「lower→0 / upper→255」の逆で描かれている**
      //    （2026-08-23 に実機で測定）。ネイティブフレームは式どおりなので、合成のときだけ反転する。
      //
      //    実測: 合成フレーム 0 は画素平均 0.0000272・VOI [−0.1608, +0.2878] なので式では 91.4 だが、
      //    画面（canvas の画像矩形）は 163.5 ＝ 255 − 91.4。ネイティブは式 180.6 に対し画面 180.4 で一致。
      //    見た目は「血管が暗い＝古典的な DSA」になっており、利用者の期待には合っている。
      //    ⚠️ ただし**そうなっている理由は Cornerstone 側にあり、こちらの意図ではない**
      //      （合成画像に photometricInterpretation を載せていないのが疑わしい。§6.6 に記録）。
      //      表示の極性を変えるのは利用者に見える変更なので、ここでは**書き出しを画面に合わせる**。
      //      画面と書き出しがずれたら `automator/src/spike/xaMp4Check.ts` が落とす。
      const composite = target.startsWith("graphy-dsa:");
      return { windowCenter: w.center, windowWidth: w.width, invert: composite ? !invert : invert };
    }
    return null;
  };

  /**
   * 書き出しに使う fps。
   *
   * 🔴 **XA は `viewer.cineFps`（環境設定の既定 10）ではなく、DICOM タグ由来の再生速度**
   * （`resolveXaFps`）で再生している。前者で書き出すと**画面と尺が変わる**——
   * 実機で 15fps 相当のシネが 10fps の MP4 になっていた（2026-08-23）。
   */
  const exportFps = (): number => (xaCineSource ? resolveXaFps(xaCineSource).fps : fps);

  /**
   * 表示中のシネを MP4 で書き出す（§14.3）。
   *
   * 🚨 **PNG 書き出しと同じ絵**を送る（DSA の差分・W/L・反転を当てた後）。元の DICOM から
   * 作り直すと画面と違う動画になる。エンコードは backend の ffmpeg（取込側と同じ約束）。
   * 🔴 **再生速度は画面と同じ fps** で書く。既定値で書くと、可変レート DSA で尺が変わる。
   */
  const exportMp4 = () => {
    if (!window.confirm(t("xa.export.burnedInWarning"))) return;
    setExportBusy(true);
    setExportDone(0);
    const ids = [...displayImageIds];
    exportFramesAsZip(ids, exportWindow(), "f", (done) => setExportDone(done))
      .then((zip) => {
        if (!zip) throw new Error("no frames");
        return encodeXaMp4(zip, exportFps());
      })
      .then((mp4) => downloadBytes(mp4, `${seriesLabel || "xa"}.mp4`, "video/mp4"))
      .catch((e: unknown) => {
        // ffmpeg が無い環境は「壊れた」ではなく「足りない」。文言を分ける。
        const status = (e as { status?: number } | null)?.status;
        emitToast(status === 422 ? t("xa.export.mp4.needsFfmpeg") : t("xa.export.failed"));
      })
      .finally(() => setExportBusy(false));
  };

  const exportFrames = () => {
    if (!window.confirm(t("xa.export.burnedInWarning"))) return;
    setExportBusy(true);
    setExportDone(0);
    const ids = [...displayImageIds];
    exportFramesAsZip(ids, exportWindow(), `${seriesLabel || "xa"}-frame`, (done) => setExportDone(done))
      .then((zip) => {
        if (!zip) {
          emitToast(t("xa.export.failed"));
          return;
        }
        downloadBytes(zip, `${seriesLabel || "xa"}-frames.zip`, "application/zip");
      })
      .catch(() => emitToast(t("xa.export.failed")))
      .finally(() => setExportBusy(false));
  };

  /**
   * フレームを送ったら背景残差も測り直す。
   *
   * <p>🚨 **これが無いと、別のフレームの残差が出たまま**になる（GNBP-XA-2 の実機検証で発覚）。
   * 体動 (3, −2) のフレームへ送っても数値が動かず、**ずれているのに「合っている」**ように
   * 見えていた。目視でなく数値で判断させるための表示なので、古い値が残るのは致命的。
   *
   * <p>シネ再生中に毎フレーム測ると重い（512² の差分＋全画素ソート）ので、送るのが
   * 落ち着いてから測る。
   */
  useEffect(() => {
    if (!dsaToken) return;
    const id = window.setTimeout(() => {
      measureDsaResidual(dsaToken, zc)
        .then((r) => setDsaResidual(r))
        .catch(() => setDsaResidual(null));
    }, 300);
    return () => window.clearTimeout(id);
  }, [dsaToken, zc]);

  /** DSA のパラメータを変えた後に呼ぶ（再合成 → 状態と残差の更新）。 */
  const refreshDsa = (token: string, frame: number) => {
    setDsaVersion((v) => v + 1);
    setDsaState(dsaSessionState(token));
    measureDsaResidual(token, frame)
      .then((r) => setDsaResidual(r))
      .catch(() => setDsaResidual(null));
  };

  /**
   * 読み込んだ表示状態（GSPS）を当てる（§14.1）。
   *
   * 🚨 **当てられるものだけを当てる。** 何が当たり何が当たらなかったかは
   * {@link XaPresentationDialog} が一覧に出す（ここで握りつぶさない）。
   */
  const applyPresentation = (plan: PresentationPlan) => {
    const vp = firstLinkedViewport();
    if (vp) {
      if (plan.voi) {
        const half = plan.voi.windowWidth / 2;
        vp.setProperties({
          voiRange: { lower: plan.voi.windowCenter - half, upper: plan.voi.windowCenter + half },
        });
      }
      // 反転は「書いてある値にする」（トグルではない。二度当てて戻る事故を防ぐ）。
      vp.setProperties({ invert: plan.invert });
      vp.render();
      applyTransform(vp, { rotation: plan.rotation, flipHorizontal: plan.flipHorizontal });
    }
    if (plan.mmPerPx != null) {
      // 出自は "gsps"。人が測った校正と混ぜない（表示にもそう出る）。保存まで含めて確定する。
      void persistXaUserCalibration(seriesUid, { mmPerPx: plan.mmPerPx, method: "gsps" }).then(() =>
        setCalibVersion((v) => v + 1),
      );
      setCalibVersion((v) => v + 1);
    }
    if (plan.dsa) {
      if (dsaToken) {
        setDsaMaskFrames(dsaToken, plan.dsa.maskFrameIndices);
        setDsaShift(dsaToken, plan.dsa.dx, plan.dsa.dy);
        rebuildDsaMask(dsaToken)
          .then(() => refreshDsa(dsaToken, zc))
          .catch(() => emitToast(t("dsa.failed")));
      } else {
        // まだ DSA を張っていない。token が来てから当てる（下の effect）。
        setPendingDsaPlan(plan.dsa);
        setDsaOn(true);
      }
    }
  };

  // 保留していた DSA 設定を、セッションが張れた時点で当てる。
  useEffect(() => {
    if (!pendingDsaPlan || !dsaToken) return;
    setDsaMaskFrames(dsaToken, pendingDsaPlan.maskFrameIndices);
    setDsaShift(dsaToken, pendingDsaPlan.dx, pendingDsaPlan.dy);
    setPendingDsaPlan(null);
    rebuildDsaMask(dsaToken)
      .then(() => refreshDsa(dsaToken, zc))
      .catch(() => emitToast(t("dsa.failed")));
    // zc（表示フレーム）は残差の測り直しにだけ使う。依存に入れると当て直しが走る。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingDsaPlan, dsaToken]);

  // スタックの差し替え回数を数える（XA でフレーム送りのたびに増えるなら stackAxis の配線ミス）。
  const stackKeyForCount = displayImageIds[0] ?? "";
  useEffect(() => {
    if (stackKeyForCount) countStackSwap();
  }, [stackKeyForCount, displayImageIds.length]);

  // ThickSlab の ON/OFF・厚み変更で送りの母数（ドメイン）が変わる。同じ物理スライスを保つよう
  // 直前ドメインの位置 → ネイティブ連続 Z → 新ドメインへ変換する（モード切替時のみ）。
  const prevThickRef = useRef<{ on: boolean; sps: number }>({ on: false, sps: 1 });
  useEffect(() => {
    const prev = prevThickRef.current;
    if (prev.on === effectiveThick && prev.sps === slicesPerStep) return;
    setZ((cur) => {
      const nativePos = prev.on ? digitalToFractionalOriginalZ(cur, prev.sps, nZ) : cur;
      const next = effectiveThick
        ? originalToDigitalZ(nativePos, slicesPerStep, digitalCount)
        : Math.round(Math.min(Math.max(0, nativePos), nZ - 1));
      return Math.min(Math.max(0, next), (effectiveThick ? digitalCount : nZ) - 1);
    });
    prevThickRef.current = { on: effectiveThick, sps: slicesPerStep };
  }, [effectiveThick, slicesPerStep, nZ, digitalCount]);

  // ── Z 並べ替え（Image メニュー → seriesCommands）────────────────
  // 動画 IOD はブロック。IPP 並べ替えは幾何が無いシリーズでは不可。並べ替え後は
  // 表示中の画像（imageId）を追従させて同じスライスを保つ。
  const currentImageId = zStack[nativeZ];
  const hasVideoRef = useRef(hasVideo); hasVideoRef.current = hasVideo;
  const sortMetaRef = useRef<SortMeta | null>(sortMeta); sortMetaRef.current = sortMeta;
  const currentImageIdRef = useRef(currentImageId); currentImageIdRef.current = currentImageId;
  const pendingFollowRef = useRef<string | null>(null);

  // 並べ替えで Z 配列が変わった後、直前に見ていた画像の新しい位置へ Z を合わせる。
  useEffect(() => {
    const id = pendingFollowRef.current;
    if (id == null) return;
    pendingFollowRef.current = null;
    const idx = layout.zStack(cc, tc).indexOf(id);
    // ThickSlab ON 時は送りがデジタルドメインのため、ネイティブ位置 idx をデジタル Z に変換する。
    if (idx >= 0) setZ(effectiveThick ? originalToDigitalZ(idx, slicesPerStep, digitalCount) : idx);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, cc, tc]);

  // 画面メニュー/ツールバーからの並べ替えコマンドを受ける（キー = tileId）。
  useEffect(() => {
    if (!commandKey) return;
    return registerSeriesCommands(commandKey, {
      // 表示位置の移動（プラグイン・結果パネルからの「そのスライスへ飛ぶ」）。
      // 範囲外は端に丸める（黙って別の場所へ飛ばさない）。
      goTo: ({ z: nz, c: nc, t: nt }) => {
        if (typeof nz === "number" && Number.isFinite(nz)) {
          setZ(() => Math.max(0, Math.min(Math.max(0, activeCountRef.current - 1), Math.round(nz))));
        }
        if (typeof nc === "number" && Number.isFinite(nc)) {
          setC(() => Math.max(0, Math.min(Math.max(0, layoutRef.current.nC - 1), Math.round(nc))));
        }
        if (typeof nt === "number" && Number.isFinite(nt)) {
          setTIdx(() => Math.max(0, Math.min(Math.max(0, layoutRef.current.nT - 1), Math.round(nt))));
        }
      },
      setSortMode: (mode) => {
        if (hasVideoRef.current) {
          emitToast(t("viewer2d.sort.videoBlocked"));
          return;
        }
        const meta = sortMetaRef.current;
        if (isIppMode(mode)) {
          if (!meta?.hasSpatial) {
            emitToast(t("viewer2d.sort.noIpp"));
            return;
          }
        } else if (!meta?.hasInstance) {
          emitToast(t("viewer2d.sort.noInstance"));
          return;
        }
        pendingFollowRef.current = currentImageIdRef.current ?? null;
        setSortMode(mode);
      },
    });
  }, [commandKey, t]);

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
    }
  };

  // GridView リンク用の同期グループ ID（このシリーズビューア内で一意）。
  const rawId = useId();
  const syncGroupId = useMemo(() => `graphy-grid-${rawId.replace(/[^a-zA-Z0-9]/g, "")}`, [rawId]);

  // 先頭ビューポートに変換を適用 → camera/VOI 同期で全セルへ波及（シリーズ全体リンク）。
  const firstLinkedViewport = (): Types.IStackViewport | undefined => {
    const ids = ToolGroupManager.getToolGroup(syncGroupId)?.getViewportIds() ?? [];
    const engine = getRenderingEngine(ENGINE_ID);
    for (const id of ids) {
      const vp = engine?.getViewport(id) as Types.IStackViewport | undefined;
      if (vp) return vp;
    }
    return undefined;
  };
  const linkApply = (patch: Parameters<typeof applyTransform>[1]) => {
    const vp = firstLinkedViewport();
    if (vp) applyTransform(vp, patch);
  };
  const gRotate = () => {
    const vp = firstLinkedViewport();
    if (vp) applyTransform(vp, { rotation: (readTransform(vp).rotation + 90) % 360 });
  };
  const gFlipH = () => {
    const vp = firstLinkedViewport();
    if (vp) applyTransform(vp, { flipHorizontal: !readTransform(vp).flipHorizontal });
  };
  const gFlipV = () => {
    const vp = firstLinkedViewport();
    if (vp) applyTransform(vp, { flipVertical: !readTransform(vp).flipVertical });
  };
  const gZoom = (f: number) => {
    const vp = firstLinkedViewport();
    if (vp) applyTransform(vp, { zoom: readTransform(vp).zoom * f });
  };

  // シネ再生（各次元を独立してループ送り）。
  const cineInterval = Math.max(16, Math.round(1000 / fps));
  useEffect(() => {
    if (!playZ || activeCount <= 1 || navLocked) return;
    const id = window.setInterval(() => setZ((p) => (p + 1) % activeCount), cineInterval);
    return () => window.clearInterval(id);
  }, [playZ, cineInterval, activeCount, navLocked]);
  useEffect(() => {
    if (!playC || layout.nC <= 1) return;
    const id = window.setInterval(() => setC((p) => (p + 1) % layout.nC), cineInterval);
    return () => window.clearInterval(id);
  }, [playC, cineInterval, layout.nC]);
  useEffect(() => {
    // tIdx は「スタック以外のもう 1 本」の状態（frame-stack ではラン軸）。母数は otherCount。
    if (!playT || otherCount <= 1) return;
    const id = window.setInterval(() => setTIdx((p) => (p + 1) % otherCount), cineInterval);
    return () => window.clearInterval(id);
  }, [playT, cineInterval, otherCount]);

  // キー操作（↑/→ で次、↓/← で前スライス）とホイール送り。Grid 中は無効（グリッドをスクロール）。
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = rootRef.current;
    if (!el || gridOn) return;
    // 🔴 解析中（QCA 等）はフレームを動かさない（`sliceNavigationLock.ts`）。
    //    裏で送られると、画面の画像とダイアログの数値が別フレームのものになり、
    //    しかも**エラーが出ない**——気付けない食い違いになる。
    //    ホイール・キー・3 本指ドラッグの入口をここ 1 本に絞ってある。
    const step = (d: number) => {
      if (isSliceNavigationLocked()) return;
      setZ((p) => Math.max(0, Math.min(activeCount - 1, p + d)));
    };
    const jumpTo = (z: number) => {
      if (isSliceNavigationLocked()) return;
      setZ(z);
    };
    // 既定ショートカット（registry）に従う。ArrowUp=前, ArrowDown=次, Home/End=先頭/末尾,
    // Space=シネ, O=テキストオーバーレイ切替。
    const onKey = (e: KeyboardEvent) => {
      // コントロール（スライダー/ボタン/セレクト）操作中は誤爆させない。
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || tag === "BUTTON") return;
      // 器（解析ダイアログ等）の中のキーもビューアのものではない（ホイールと同じ理由）。
      if (isInsideViewerOverlay(e.target)) return;
      // ↑↓ に加えてテンキー 8/2 も受ける（NumLock 非依存・1 打鍵 = 1 スライス）。
      if (matchesShortcut("nav-prev-slice", e)) {
        step(-1);
        e.preventDefault();
      } else if (matchesShortcut("nav-next-slice", e)) {
        step(1);
        e.preventDefault();
      } else if (matchesCombo("Home", e)) {
        jumpTo(0);
        e.preventDefault();
      } else if (matchesCombo("End", e)) {
        jumpTo(activeCount - 1);
        e.preventDefault();
      } else if (matchesCombo("Space", e)) {
        // 解析中はシネも始めない（始まればフレームが動く＝同じ事故）。
        if (!isSliceNavigationLocked()) setPlayZ((p) => !p);
        e.preventDefault();
      } else if (matchesCombo("O", e)) {
        setOverlays((o) => ({ ...o, text: !o.text }));
        e.preventDefault();
      }
    };
    // 🔴 ホイールは **1 ノッチ = 1 スライス**（`wheelScroll.ts`）。
    // 以前は wheel イベントごとに step(±1) しており、高分解能ホイールとトラックパッドが
    // 1 回の操作で何十件もイベントを出すため、少し回しただけで一気に飛んでいた。
    const wheelStep = createWheelStepper();
    const onWheel = (e: WheelEvent) => {
      // 🔴 **器（解析ダイアログ等）の中で回したホイールはビューアのものではない**
      //    （実機で言われた・2026-09-01。`viewerOverlay.ts`）。器は根の子として描かれるので
      //    イベントがここまで上がってくる。ここで `preventDefault` すると器自身の縦スクロールが
      //    死に、**代わりに裏のフレームが送られる**。錠では直らない（錠はフレーム送りだけを
      //    止めるので、スクロールは `preventDefault` に殺されたまま）。
      if (isInsideViewerOverlay(e.target)) return;
      e.preventDefault();
      const d = wheelStep(e.deltaY, e.deltaMode, e.timeStamp);
      if (d !== 0) step(d);
    };

    // ── 3 本指の縦ドラッグでスライス送り（タッチ端末。fw/mobile-ui-design.md §3.3） ──
    // ⚠️ Cornerstone の StackScrollTool は使わない。表示スライスは**この React state（z）が唯一の
    // 出所**で、ツールが viewport の imageIdIndex を直接動かすと次の再描画で巻き戻る。
    // 1 本指＝アクティブツール、2 本指＝ピンチ Zoom+Pan は Cornerstone 側（Viewer2D のバインド）。
    let scrollAnchorY: number | null = null;
    const onTouchStart = (e: TouchEvent) => {
      // 器の中の 3 本指も同じ（器をなぞってスクロールしたいのであって、フレーム送りではない）。
      scrollAnchorY =
        e.touches.length === 3 && !isInsideViewerOverlay(e.target) ? e.touches[0].clientY : null;
    };
    const onTouchMove = (e: TouchEvent) => {
      if (scrollAnchorY === null || e.touches.length !== 3) return;
      e.preventDefault(); // ページスクロールに奪われないようにする
      const steps = sliceStepsFromDrag(e.touches[0].clientY - scrollAnchorY);
      if (steps === 0) return;
      step(steps); // 下へなぞる = 次のスライス（ホイールと同じ向き）
      scrollAnchorY = advanceAnchor(scrollAnchorY, steps);
    };
    const onTouchEnd = () => {
      scrollAnchorY = null;
    };

    el.addEventListener("keydown", onKey);
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd, { passive: true });
    el.addEventListener("touchcancel", onTouchEnd, { passive: true });
    return () => {
      el.removeEventListener("keydown", onKey);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [activeCount, gridOn]);

  // ── シリーズ Sync ─────────────────────────────────────────
  //
  // SliderView かつ Sync ON のとき、グローバル coordinator（sliceSync）に参加する。
  // ユーザー操作でスライスが動いたら publishSlice し、他タイルへ座標/単純同期で伝播する。
  // coordinator からの移動（applyIndex）は syncDrivenRef で再 publish を抑止（ループ防止）。

  const syncDrivenRef = useRef(false);
  const sliceSyncId = useMemo(() => `slicesync-${rawId.replace(/[^a-zA-Z0-9]/g, "")}`, [rawId]);
  // getState/applyIndex が常に最新値を参照するためのリーフ。
  const zcRef = useRef(zc); zcRef.current = zc;
  const layoutRef = useRef(layout); layoutRef.current = layout;
  // ThickSlab のデジタル写像を sync(getState) から最新参照するためのリーフ。
  const activeCountRef = useRef(activeCount); activeCountRef.current = activeCount;
  const nZNativeRef = useRef(nZ); nZNativeRef.current = nZ;
  const effectiveThickRef = useRef(effectiveThick); effectiveThickRef.current = effectiveThick;
  const slicesPerStepRef = useRef(slicesPerStep); slicesPerStepRef.current = slicesPerStep;

  // スタックが空間スライスでない（XA のフレーム軸など）シリーズは同期に参加しない。
  // 投影像には患者座標の断面が無く、他シリーズと突き合わせる意味がないため。
  const syncOn = syncEnabled && !gridOn && spatialStack;
  useEffect(() => {
    if (!syncOn) return;
    const unregister = registerSliceSync({
      id: sliceSyncId,
      getState: () => {
        const lay = layoutRef.current;
        // ThickSlab ON はデジタル枚数＋各デジタル Z→ネイティブ IPP 写像で座標同期する
        // （他シリーズはテーブル位置 mm で一致判定するため native と整合）。
        if (effectiveThickRef.current) {
          const dc = activeCountRef.current;
          const s = slicesPerStepRef.current;
          const nn = nZNativeRef.current;
          const ipps = Array.from({ length: dc }, (_, dz) => lay.ippAt?.(digitalToNativeZ(dz, s, nn)) ?? null);
          return { index: zcRef.current, nZ: dc, ipps, normal: lay.normal ?? null };
        }
        const n = nZNativeRef.current;
        const ipps = Array.from({ length: n }, (_, z2) => lay.ippAt?.(z2) ?? null);
        return { index: zcRef.current, nZ: n, ipps, normal: lay.normal ?? null };
      },
      applyIndex: (z) => {
        syncDrivenRef.current = true;
        setZ(z);
      },
    });
    return unregister;
  }, [syncOn, sliceSyncId]);

  // スライス変化を coordinator に publish。Sync 受信由来（syncDrivenRef）は再 publish しない。
  useEffect(() => {
    if (syncDrivenRef.current) {
      syncDrivenRef.current = false;
      return;
    }
    if (syncOn) publishSlice(sliceSyncId);
  }, [zc, activeCount, syncOn, sliceSyncId]);

  // 現在表示中の Z/C/T を上位へ通知（Fusion の初期 C/T 引き継ぎ・Histogram の初期 Z/C/T 用）。
  // ThickSlab ON でも下流はネイティブ Z を前提とするため、native 位置で通知する。
  // frame-stack（XA）では役割が入れ替わるので、レイアウト座標系（z=ラン, t=フレーム）へ戻して通知する。
  const dimZ = isFrameStack ? otherIdx : nativeZ;
  const dimT = isFrameStack ? zc : tc;
  useEffect(() => {
    onDimChange?.(cc, dimT, dimZ);
  }, [cc, dimT, dimZ, onDimChange]);

  const toggle = (k: keyof OverlayState) => setOverlays((o) => ({ ...o, [k]: !o[k] }));

  // ROI/Mask 作成時の紐付けコンテキスト（z は Viewer2D 側で現在 index を補う）。
  const roiContext = useMemo(
    () => ({ patientKey: patientKey ?? "", studyUid, seriesUid, seriesLabel: seriesLabel ?? "", c: cc, t: tc }),
    [patientKey, studyUid, seriesUid, seriesLabel, cc, tc],
  );

  // 各次元スライダー横のシネ再生ボタン（▶/⏸）。
  const cinePlayBtn = (on: boolean, onToggle: () => void, disabled: boolean, testId?: string) => (
    <button data-testid={testId} onClick={onToggle} disabled={disabled} style={btn} title={t("series.cine")}>
      {on ? "⏸" : "▶"}
    </button>
  );

  return (
    <div
      ref={rootRef}
      tabIndex={0}
      data-testid="series-viewer-root"
      style={fillHeight ? { ...root, flex: 1, display: "flex", flexDirection: "column", minHeight: 0 } : root}
    >
      {!layoutReady ? (
        // レイアウト解決までは Viewer をマウントしない（モザイク等の生画像フラッシュ防止）。
        // この間はスライス送り操作が画面に反映されないため、円形スピナーでロード中と分かるようにする。
        <div style={layoutPending}>
          <LoadingSpinner size={32} />
          <div>{t("common.loading")}</div>
        </div>
      ) : gridOn ? (
        <div style={gridScroll}>
          <div style={{ display: "grid", gridTemplateColumns: `repeat(${gridCols}, minmax(0, 1fr))`, gap: 6 }}>
            {zStack.map((id, i) => (
              <div key={id} data-testid="grid-cell" style={cellBox}>
                <div style={cellCaption}>{i + 1}</div>
                <Viewer2D
                  imageIds={[id]}
                  imageIndex={0}
                  overlays={overlays}
                  compact
                  height={CELL_HEIGHT}
                  syncGroupId={syncGroupId}
                />
              </div>
            ))}
          </div>
        </div>
      ) : (
        <Viewer2D imageIds={displayImageIds} imageIndex={zc} overlays={overlays} fill={fillHeight} showControls={showControls} viewSyncEnabled={syncOn} referenceLinesEnabled={referenceLinesEnabled} referenceLabel={referenceLabel} commandKey={commandKey} roiContext={roiContext} renderOverlay={renderFusionOverlay} thickSlab={effectiveThick} refreshKey={calibVersion} pendingImages={!xaReady} />
      )}

      {showControls && (
      <div style={controls} data-testid="series-controls">
        {/* GridView の操作バー（W/L・Pan・Zoom はドラッグ、回転/反転/Fit はボタン。全セルにリンク）。 */}
        {gridOn && (
          <div style={row}>
            <button onClick={() => linkApply({ zoom: 1, pan: [0, 0] })} style={btn} title={t("viewer.fit")}>
              <ToolIcon file={UI_ICON_FILES.fit} size={16} />
            </button>
            <button onClick={() => gZoom(1 / 1.2)} style={btn} title={t("viewer.zoomOut")}>−</button>
            <button onClick={() => gZoom(1.2)} style={btn} title={t("viewer.zoomIn")}>＋</button>
            <button onClick={gRotate} style={btn} title={t("viewer.rotate")}><ToolIcon file={UI_ICON_FILES.rotate} size={16} /></button>
            <button onClick={gFlipH} style={btn} title={t("viewer.flipH")}><ToolIcon file={UI_ICON_FILES.flipH} size={16} /></button>
            <button onClick={gFlipV} style={btn} title={t("viewer.flipV")}><ToolIcon file={UI_ICON_FILES.flipV} size={16} /></button>
            <button onClick={() => linkApply(FIT_TRANSFORM)} style={btn} title={t("viewer.reset")}>
              <ToolIcon file={UI_ICON_FILES.reset} size={16} />
            </button>
            <span style={hint}>{t("series.grid.linked")}</span>
          </div>
        )}

        {/* スライダー/シネは Slider モードのみ表示（Grid 中は非表示）。
            **要素数 > 1 の軸だけ描く**（fw/angio-design.md §5.7.4）。これにより単一スライスの
            モダリティ（XA/CR/DX/MG/US 静止画）で「死んだ Z スライダー」が出なくなる。 */}
        {!gridOn && (
          <>
            {/* スタック軸。実時間再生に意味がある軸（frame）はシネコントロールに差し替える。 */}
            {activeCount > 1 &&
              (stackAxisSpec.kind === "frame" ? (
                <CineControls
                  count={activeCount}
                  index={zc}
                  onIndex={navLocked ? () => {} : setZ}
                  source={xaCineSource}
                  locked={navLocked}
                />
              ) : (
                <DimSlider
                  label={axisLabel(t, stackAxisSpec)}
                  dim={stackAxisSpec.dim}
                  idx={zc}
                  count={activeCount}
                  onChange={navLocked ? () => {} : setZ}
                  trailing={cinePlayBtn(
                    playZ,
                    () => setPlayZ((p) => !p),
                    activeCount <= 1 || navLocked,
                    "cine-play-z",
                  )}
                  testId="dim-slider-z"
                />
              ))}
            {layout.nC > 1 && (
              <DimSlider
                label={axisLabel(t, axes.c)}
                dim={layout.cDimension}
                idx={cc}
                count={layout.nC}
                onChange={setC}
                trailing={cinePlayBtn(playC, () => setPlayC((p) => !p), layout.nC <= 1)}
              />
            )}
            {otherCount > 1 && (
              <DimSlider
                label={axisLabel(t, otherAxisSpec)}
                dim={otherAxisSpec.dim}
                idx={otherIdx}
                count={otherCount}
                onChange={setTIdx}
                trailing={cinePlayBtn(playT, () => setPlayT((p) => !p), otherCount <= 1)}
                testId="dim-slider-other"
              />
            )}
            {/* DSA（サブトラクション）: フレーム軸（XA/XRF）のときだけ。fw/angio-design.md §6 */}
            {isFrameStack && (
              <>
                <div style={row}>
                  <Check
                    testId="dsa-check"
                    label={t("dsa.enable")}
                    checked={dsaOn}
                    onChange={() => setDsaOn((v) => !v)}
                    disabled={dsaBusy || nZ < 2}
                  />
                  <button
                    style={btn}
                    data-testid="xa-analysis-open"
                    onClick={() => setXaDialogOpen(true)}
                    title={t("xa.analysis.title")}
                  >
                    {t("xa.analysis.open")}
                  </button>
                  {/* 🔴 **QVA のボタンは外してある**（2026-09-01）。理由は `xaTaskCatalog.ts` の
                      同名の注記を読むこと——報告していた「ネック径」が瘤頸ではなく、嚢状動脈瘤を
                      そもそも表現できない計測モデルだったため。ダイアログ自体は残してあるので、
                      作り直しの結論が出るまでは**導線だけが無い**状態。 */}
                  {/* 左室造影の解析（A5b）。QCA とは段の構成が違うので別ダイアログ（§21.2-3）。 */}
                  <button
                    style={btn}
                    data-testid="qlv-open"
                    disabled={nZ < 3}
                    onClick={() => setQlvDialogOpen(true)}
                    title={t("qlv.title")}
                  >
                    {t("qlv.open")}
                  </button>
                  {/* 3D QCA（A6a）。2 方向で 2D QCA を済ませてから開く（§10.2）。 */}
                  <button
                    style={btn}
                    data-testid="xa3d-open"
                    disabled={qcaRuns.length < 2}
                    onClick={() => setXa3dDialogOpen(true)}
                    title={
                      qcaRuns.length < 2 ? t("xa3d.needRuns") : t("xa3d.title")
                    }
                  >
                    {t("xa3d.open")}
                  </button>
                  {/* 分岐部 QCA（A6b）。3 本 × 2 方向ぶんの 2D QCA が要る（§21.4）。 */}
                  <button
                    style={btn}
                    data-testid="xa3dbif-open"
                    disabled={qcaRuns.length < 2}
                    onClick={() => setXaBifDialogOpen(true)}
                    title={qcaRuns.length < 2 ? t("xa3d.needRuns") : t("xa3dbif.title")}
                  >
                    {t("xa3dbif.open")}
                  </button>
                  {/* 表示状態（GSPS）の読み込み（§14.1）。書き出しは解析ダイアログ側。 */}
                  <button
                    style={btn}
                    data-testid="xa-pr-open"
                    title={t("xa.pr.title")}
                    onClick={() => setPrDialogOpen(true)}
                  >
                    {t("xa.pr.open")}
                  </button>
                  <button
                    style={btn}
                    data-testid="xa-export-mp4"
                    disabled={exportBusy || nZ < 2}
                    title={t("xa.export.mp4.title")}
                    onClick={exportMp4}
                  >
                    {t("xa.export.mp4")}
                  </button>
                  <button
                    style={btn}
                    data-testid="xa-export-frames"
                    disabled={exportBusy || nZ < 1}
                    title={t("xa.export.frames.title")}
                    onClick={exportFrames}
                  >
                    {exportBusy
                      ? t("xa.export.progress", { done: exportDone, total: nZ })
                      : t("xa.export.frames")}
                  </button>
                  {dsaState && (
                    <>
                      <span style={hint} data-testid="dsa-mask">
                        {t("dsa.mask", {
                          frames: dsaState.maskFrames.map((i) => i + 1).join(", "),
                        })}
                      </span>
                      <button
                        style={btn}
                        title={t("dsa.setMaskHere.title")}
                        onClick={() => {
                          if (!dsaToken) return;
                          setDsaMaskFrames(dsaToken, [zc]);
                          rebuildDsaMask(dsaToken).then((ok) => {
                            if (ok) refreshDsa(dsaToken, zc);
                          });
                        }}
                      >
                        {t("dsa.setMaskHere")}
                      </button>
                    </>
                  )}
                </div>
                {dsaState && (
                  <div style={row}>
                    <span style={hint} data-testid="dsa-shift">
                      {t("dsa.shift", { dx: dsaState.dx.toFixed(1), dy: dsaState.dy.toFixed(1) })}
                    </span>
                    {([
                      ["←", -1, 0],
                      ["→", 1, 0],
                      ["↑", 0, -1],
                      ["↓", 0, 1],
                    ] as const).map(([label, ddx, ddy]) => (
                      <button
                        key={label}
                        style={btn}
                        data-testid={`dsa-shift-${ddx}-${ddy}`}
                        title={t("dsa.shiftStep")}
                        onClick={() => {
                          if (!dsaToken || !dsaState) return;
                          setDsaShift(dsaToken, dsaState.dx + ddx, dsaState.dy + ddy);
                          refreshDsa(dsaToken, zc);
                        }}
                      >
                        {label}
                      </button>
                    ))}
                    <button
                      style={btn}
                      data-testid="dsa-auto-align"
                      title={t("dsa.autoAlign.title")}
                      onClick={() => {
                        if (!dsaToken) return;
                        setDsaBusy(true);
                        autoAlignDsa(dsaToken, zc)
                          .then(() => refreshDsa(dsaToken, zc))
                          .finally(() => setDsaBusy(false));
                      }}
                      disabled={dsaBusy}
                    >
                      {t("dsa.autoAlign")}
                    </button>
                    <Check
                      testId="dsa-log-check"
                      label={t("dsa.logarithmic")}
                      checked={dsaState.logarithmic}
                      onChange={() => {
                        if (!dsaToken || !dsaState) return;
                        setDsaLogarithmic(dsaToken, !dsaState.logarithmic);
                        refreshDsa(dsaToken, zc);
                      }}
                    />
                    {dsaResidual != null && (
                      <span style={hint} data-testid="dsa-residual" title={t("dsa.residual.title")}>
                        {t("dsa.residual", { v: formatResidual(dsaResidual) })}
                      </span>
                    )}
                  </div>
                )}
              </>
            )}
            {/* ThickSlab（デジタルスライス厚）: On/Off ＋ 厚み選択。SliderView かつ空間スライス軸のみ。 */}
            {spatialStack && (
            <div style={row}>
              <Check
                label={t("series.thickSlab")}
                checked={thickSlabOn}
                onChange={() => setThickSlabOn((v) => !v)}
                disabled={!thickAvailable}
              />
              <select
                value={thickSlabMm}
                disabled={!thickSlabOn || !thickAvailable}
                onChange={(e) => setThickSlabMm(Number(e.target.value))}
                style={selectBox}
                title={t("series.thickSlab.title")}
              >
                {THICK_SLAB_THICKNESSES.map((mm) => (
                  <option key={mm} value={mm}>
                    {mm.toFixed(1)} mm
                  </option>
                ))}
              </select>
              {thickSlabOn && thickAvailable && thickOriginal && (
                <span style={hint}>{t("series.thickSlab.off")}</span>
              )}
              {!thickAvailable && <span style={hint}>{t("series.thickSlab.unavailable")}</span>}
            </div>
            )}
          </>
        )}

        {/* オーバーレイ On/Off。列数ドロップダウン（Reset=SliderView, 1〜7=GridView）。 */}
        <div style={row}>
          <Check testId="overlay-check-text" label={t("series.ov.text")} checked={overlays.text} onChange={() => toggle("text")} />
          <Check testId="overlay-check-caliper" label={t("series.ov.caliper")} checked={overlays.caliper} onChange={() => toggle("caliper")} />
          <Check testId="overlay-check-orientation" label={t("series.ov.orientation")} checked={overlays.orientation} onChange={() => toggle("orientation")} />
          <Check label={t("series.ov.roi")} checked={overlays.roi} onChange={() => toggle("roi")} disabled />
          <select
            data-testid="grid-columns-select"
            value={gridOn ? gridCols : 0}
            disabled={gridDisabled}
            onChange={(e) => switchMode(Number(e.target.value))}
            style={selectBox}
          >
            <option value={0}>{t("series.grid.reset")}</option>
            {[1, 2, 3, 4, 5, 6, 7].map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
          {gridDisabled && <span style={hint}>{t("series.grid.disabled")}</span>}
        </div>
      </div>
      )}
      {prDialogOpen && (
        <XaPresentationDialog
          studyUid={studyUid}
          sopInstanceUid={sopUidFromImageId(zStack[zc] ?? "") ?? null}
          frameCount={nZ}
          onApply={(plan) => applyPresentation(plan)}
          onClose={() => setPrDialogOpen(false)}
        />
      )}
      {xaDialogOpen && displayImageIds[zc] && (
        <XaAnalysisDialog
          imageId={displayImageIds[zc]}
          seriesUid={seriesUid}
          isSubtracted={!!dsaToken}
          saveContext={{
            studyUid,
            // 解析状態の保存先（ROI と同じ患者ごとの JSON。§14.5）。
            patientKey,
            // 保存の参照先は**合成 imageId ではなくネイティブフレーム**の元インスタンス。
            sopInstanceUid: sopUidFromImageId(zStack[zc] ?? ""),
            frameIndex: zc,
            dsa: dsaState ? { maskFrames: dsaState.maskFrames, dx: dsaState.dx, dy: dsaState.dy } : null,
          }}
          onClose={() => setXaDialogOpen(false)}
          // 校正が変わったら表示（スケールバー・計測ラベル）を作り直す。
          // DSA 中は合成 imageId の版番号、非 DSA でも refreshKey でスタックを初期化し直す。
          onCalibrated={() => {
            setDsaVersion((v) => v + 1);
            setCalibVersion((v) => v + 1);
          }}
        />
      )}
      {qvaDialogOpen && displayImageIds[zc] && (
        <XaAnalysisDialog
          mode="qva"
          imageId={displayImageIds[zc]}
          seriesUid={seriesUid}
          isSubtracted={!!dsaToken}
          saveContext={{
            studyUid,
            // 解析状態の保存先（ROI と同じ患者ごとの JSON。§14.5）。
            patientKey,
            sopInstanceUid: sopUidFromImageId(zStack[zc] ?? ""),
            frameIndex: zc,
            dsa: dsaState ? { maskFrames: dsaState.maskFrames, dx: dsaState.dx, dy: dsaState.dy } : null,
          }}
          onClose={() => setQvaDialogOpen(false)}
          onCalibrated={() => {
            setDsaVersion((v) => v + 1);
            setCalibVersion((v) => v + 1);
          }}
        />
      )}
      {xa3dDialogOpen && <Xa3dQcaDialog onClose={() => setXa3dDialogOpen(false)} />}
      {xaBifDialogOpen && <Xa3dBifurcationDialog onClose={() => setXaBifDialogOpen(false)} />}
      {qlvDialogOpen && displayImageIds.length > 0 && (
        <XaQlvDialog
          imageIds={displayImageIds}
          seriesUid={seriesUid}
          saveContext={{
            studyUid,
            // 保存の参照先は合成 imageId ではなく**ネイティブフレーム**の元インスタンス。
            // 🔴 QLV には解析状態の保存（§14.5）をまだ入れていない。QCA/QVA と手修正の
            //    作りが違う（ED/ES の輪郭）ので、同じ器に入れる前に鍵の設計が要る。
            sopInstanceUidAt: (i) => sopUidFromImageId(zStack[i] ?? "") ?? null,
          }}
          frameTimeMs={fps > 0 ? 1000 / fps : null}
          onClose={() => setQlvDialogOpen(false)}
          // ⚠️ XA（isFrameStack）では**表示中のフレームは `z`**（`tIdx` は Run 軸）。
          //    `setTIdx` を渡すと「フレームを合わせたつもりで別のランへ飛ぶ」。
          onGoToFrame={setZ}
        />
      )}
    </div>
  );
}

/**
 * 背景残差の表示。
 *
 * <p>対数変換ありの DSA では差分が 0.0x のオーダーになるため、`toFixed(1)` だと**常に "0.0"** で
 * シフトを変えても数値が動かない（実機で発覚）。有効数字 3 桁で出す。
 */
function formatResidual(v: number): string {
  if (!Number.isFinite(v)) return "—";
  if (v === 0) return "0";
  const abs = Math.abs(v);
  if (abs >= 100) return v.toFixed(0);
  if (abs >= 1) return v.toFixed(2);
  return v.toPrecision(3);
}

/**
 * 軸ラベルの表示名。backend が供給する label（"Z"/"Run"/"Frame"）に訳があればそれを使い、
 * 無ければ label をそのまま出す（未知の軸でも壊れない）。
 */
function axisLabel(t: (key: string) => string, axis: AxisSpec): string {
  const key = `series.axis.${axis.label}`;
  const translated = t(key);
  return translated === key ? axis.label : translated;
}

function DimSlider({
  label,
  dim,
  idx,
  count,
  onChange,
  trailing,
  testId,
}: {
  label: string;
  dim?: string | null;
  idx: number;
  count: number;
  onChange: (v: number) => void;
  trailing?: React.ReactNode;
  testId?: string;
}) {
  return (
    <div style={row}>
      <span style={dimLabel}>
        {label} {idx + 1}/{count}
        {dim ? ` (${dim})` : ""}
      </span>
      <input
        data-testid={testId}
        type="range"
        min={0}
        max={Math.max(0, count - 1)}
        value={idx}
        disabled={count <= 1}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ flex: 1 }}
      />
      {trailing}
    </div>
  );
}

function Check({
  label,
  checked,
  onChange,
  disabled,
  testId,
}: {
  label: string;
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
  testId?: string;
}) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: disabled ? "#9aa6b2" : "#33404d" }}>
      <input data-testid={testId} type="checkbox" checked={checked} onChange={onChange} disabled={disabled} />
      {label}
    </label>
  );
}

const root: React.CSSProperties = { outline: "none" };
// レイアウト解決待ちのプレースホルダ（Viewer と同じ黒背景。生モザイクを描かないためのゲート）。
const layoutPending: React.CSSProperties = {
  flex: 1,
  minHeight: 240,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 10,
  background: "#000",
  color: "#5b6b7a",
  fontSize: 13,
};
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
/**
 * 操作行。**必ず折り返す**（`flexWrap`）。
 *
 * <p>アンギオ（XA）の行はボタンが 8 個以上並ぶ。折り返さないと flex が**ボタンだけを縮め**、
 * 文字は縮まないのでラベルが枠からはみ出す（実機で判明・2026-08-27）。
 * 併せて {@link btn} 側で `flexShrink: 0` と `whiteSpace: "nowrap"` を指定し、
 * 「ボタンは自然な幅を保ち、入り切らなければ次の行へ送る」に統一する。
 */
const row: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  flexWrap: "wrap",
  // ⚠ ショートハンドの `gap` と長い方（`rowGap`）を**混ぜない**。React は再レンダで
  //    片方だけが消えると警告を出す（"Removing a style property during rerender"）。
  //    行間と列間で値が違うので、最初から両方を長い方で書く。
  columnGap: 10,
  rowGap: 6,
};
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
  // ラベルを 1 行に保ち、狭いときは縮むのではなく次の行へ送る（`row` の flexWrap と対）。
  whiteSpace: "nowrap",
  flexShrink: 0,
};
const selectBox: React.CSSProperties = {
  padding: "3px 6px",
  border: "1px solid #cdd5de",
  borderRadius: 6,
  background: "#fff",
  fontSize: 13,
  flexShrink: 0,
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
