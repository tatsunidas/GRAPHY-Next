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
import { prewarmXaDataset, readXaCineSource, type XaCineSource } from "./xaCine";
import { downloadBytes, exportFramesAsZip } from "./xaFrameExport";
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
import { advanceAnchor, sliceStepsFromDrag } from "./touchScroll";
import { installDebugApi, countStackSwap } from "./debugApi";
import { matchesCombo } from "../shortcuts/registry";
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
  // 連番 PNG エクスポート（fw/angio-design.md §14.3）。
  const [exportBusy, setExportBusy] = useState(false);
  const [exportDone, setExportDone] = useState(0);

  const dsaImageIds = useMemo(() => {
    if (!dsaToken) return null;
    return zStack.map((_id, t) => dsaImageId(dsaToken, t, dsaVersion));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dsaToken, dsaVersion, zStackKey]);
  const displayImageIds = dsaImageIds ?? thickImageIds ?? zStack;

  // ── XA シネ: dataSet を先に温めてから表示する（fw/angio-design.md §5.5）──────────────
  // 🚨 プリウォームは必須。dicom-image-loader は「dataSet 未キャッシュの初回だけ 1 origin の
  //    フレーム番号を渡す」ため、温めずに描くと最初の 1 枚だけ 1 フレームずれた画像が
  //    Cornerstone の画像キャッシュに載ってしまう（詳細は prewarmXaDataset の JSDoc）。
  const [xaCineSource, setXaCineSource] = useState<XaCineSource | null>(null);
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
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isFrameStack, zStackKey]);

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
  const exportFrames = () => {
    if (!window.confirm(t("xa.export.burnedInWarning"))) return;
    setExportBusy(true);
    setExportDone(0);
    const ids = [...displayImageIds];
    exportFramesAsZip(ids, null, `${seriesLabel || "xa"}-frame`, (done) => setExportDone(done))
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

  /** DSA のパラメータを変えた後に呼ぶ（再合成 → 状態と残差の更新）。 */
  const refreshDsa = (token: string, frame: number) => {
    setDsaVersion((v) => v + 1);
    setDsaState(dsaSessionState(token));
    measureDsaResidual(token, frame)
      .then((r) => setDsaResidual(r))
      .catch(() => setDsaResidual(null));
  };

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
    if (!playZ || activeCount <= 1) return;
    const id = window.setInterval(() => setZ((p) => (p + 1) % activeCount), cineInterval);
    return () => window.clearInterval(id);
  }, [playZ, cineInterval, activeCount]);
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
    const step = (d: number) => setZ((p) => Math.max(0, Math.min(activeCount - 1, p + d)));
    // 既定ショートカット（registry）に従う。ArrowUp=前, ArrowDown=次, Home/End=先頭/末尾,
    // Space=シネ, O=テキストオーバーレイ切替。
    const onKey = (e: KeyboardEvent) => {
      // コントロール（スライダー/ボタン/セレクト）操作中は誤爆させない。
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || tag === "BUTTON") return;
      if (matchesCombo("ArrowUp", e)) {
        step(-1);
        e.preventDefault();
      } else if (matchesCombo("ArrowDown", e)) {
        step(1);
        e.preventDefault();
      } else if (matchesCombo("Home", e)) {
        setZ(0);
        e.preventDefault();
      } else if (matchesCombo("End", e)) {
        setZ(activeCount - 1);
        e.preventDefault();
      } else if (matchesCombo("Space", e)) {
        setPlayZ((p) => !p);
        e.preventDefault();
      } else if (matchesCombo("O", e)) {
        setOverlays((o) => ({ ...o, text: !o.text }));
        e.preventDefault();
      }
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      step(e.deltaY > 0 ? 1 : -1);
    };

    // ── 3 本指の縦ドラッグでスライス送り（タッチ端末。fw/mobile-ui-design.md §3.3） ──
    // ⚠️ Cornerstone の StackScrollTool は使わない。表示スライスは**この React state（z）が唯一の
    // 出所**で、ツールが viewport の imageIdIndex を直接動かすと次の再描画で巻き戻る。
    // 1 本指＝アクティブツール、2 本指＝ピンチ Zoom+Pan は Cornerstone 側（Viewer2D のバインド）。
    let scrollAnchorY: number | null = null;
    const onTouchStart = (e: TouchEvent) => {
      scrollAnchorY = e.touches.length === 3 ? e.touches[0].clientY : null;
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
        <Viewer2D imageIds={displayImageIds} imageIndex={zc} overlays={overlays} fill={fillHeight} showControls={showControls} viewSyncEnabled={syncOn} referenceLinesEnabled={referenceLinesEnabled} referenceLabel={referenceLabel} commandKey={commandKey} roiContext={roiContext} renderOverlay={renderFusionOverlay} thickSlab={effectiveThick} />
      )}

      {showControls && (
      <div style={controls}>
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
                <CineControls count={activeCount} index={zc} onIndex={setZ} source={xaCineSource} />
              ) : (
                <DimSlider
                  label={axisLabel(t, stackAxisSpec)}
                  dim={stackAxisSpec.dim}
                  idx={zc}
                  count={activeCount}
                  onChange={setZ}
                  trailing={cinePlayBtn(playZ, () => setPlayZ((p) => !p), activeCount <= 1, "cine-play-z")}
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
                      <span style={hint}>
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
                    <span style={hint}>
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
                      label={t("dsa.logarithmic")}
                      checked={dsaState.logarithmic}
                      onChange={() => {
                        if (!dsaToken || !dsaState) return;
                        setDsaLogarithmic(dsaToken, !dsaState.logarithmic);
                        refreshDsa(dsaToken, zc);
                      }}
                    />
                    {dsaResidual != null && (
                      <span style={hint} title={t("dsa.residual.title")}>
                        {t("dsa.residual", { v: dsaResidual.toFixed(1) })}
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
      {xaDialogOpen && displayImageIds[zc] && (
        <XaAnalysisDialog
          imageId={displayImageIds[zc]}
          seriesUid={seriesUid}
          isSubtracted={!!dsaToken}
          saveContext={{
            studyUid,
            // 保存の参照先は**合成 imageId ではなくネイティブフレーム**の元インスタンス。
            sopInstanceUid: sopUidFromImageId(zStack[zc] ?? ""),
            frameIndex: zc,
            dsa: dsaState ? { maskFrames: dsaState.maskFrames, dx: dsaState.dx, dy: dsaState.dy } : null,
          }}
          onClose={() => setXaDialogOpen(false)}
          // 校正が変わったら表示（スケールバー・計測ラベル）を作り直す。
          onCalibrated={() => setDsaVersion((v) => v + 1)}
        />
      )}
    </div>
  );
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
const selectBox: React.CSSProperties = {
  padding: "3px 6px",
  border: "1px solid #cdd5de",
  borderRadius: 6,
  background: "#fff",
  fontSize: 13,
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
