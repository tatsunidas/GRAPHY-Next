/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * XA の校正（C2/C3）と QCA を実行するダイアログ（`fw/angio-design.md` §7.3 / §8）。
 *
 * <h3>入力は「既存の Length 計測」</h3>
 * 専用のピッキングツールを新設せず、**ユーザが引いた Length 計測の 2 点**を入力にする。
 * - 校正: カテーテル外径（Fr）や既知ルーラーの上に引いた線 → その実寸 mm を入れて mm/px を確定
 * - QCA: 解析したい血管区間の始点・終点として使う
 * 既存の操作（計測を引く）をそのまま流用でき、道具を増やさない。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getRenderingEngine } from "@cornerstonejs/core";
import { annotation as csAnnotation, utilities as csToolsUtilities } from "@cornerstonejs/tools";
import {
  createQcaSr,
  createXaPresentationState,
  deleteSeries,
  type AngioPresentationRequest,
} from "../api";
import { useI18n } from "../i18n/i18n";
import { publishQcaSnapshot } from "./debugApi";
import { readModalitySlice } from "./pixelCalibration";
import { QcaEditor, type QcaEditMode } from "./QcaEditor";
import { defaultBrushRadius, mergeEdgeEdits } from "./qcaBrush";
import { lockSliceNavigation } from "./sliceNavigationLock";
import {
  analysisId,
  findAnalysis,
  type QcaAnalysisKey,
  type SavedQcaAnalysis,
} from "./qcaAnalysisState";
import { getQcaAnalyses, loadRoisCached, upsertQcaAnalysis } from "./roiSaveStore";
import { runQca, toRanges, type QcaManualEdits, type QcaReferenceMode, type QcaResult } from "./qca";
import {
  canCalibrateWith,
  minSegmentPx,
  pathLengthPx,
  segmentKindOf,
  segmentTooShort,
  suspiciousQcaReasons,
  toQcaKnots,
  type QcaSegmentKind,
} from "./qcaInput";
import { TaskStepRail } from "./TaskStepRail";
import { ENGINE_ID } from "./Viewer2D";
import { readVoiWindow } from "./viewportRead";
import { isXaCalibrated } from "./xaCalibration";
import { needsLogTransform } from "./dsa";
import { readXaDsaTags } from "./dsaLoader";
import { publishAnalysisResult } from "../report/analysisResultStore";
import { qcaRecord } from "../report/xaAnalysisRecords";
import { describeView, qcaRunKey, registerQcaRun, removeQcaRun } from "./xaRecon3dStore";
import { readXaViewGeometry } from "./xaViewGeometryProvider";
import { calibrationForImageId, loaderSpacingFor } from "./xaCalibrationProvider";
import { persistXaUserCalibration } from "./xaCalibrationPersistence";
import { clearedBy, deriveQcaSteps, type ManualInputKey } from "./xaTasks";
import { viewerOverlayProps } from "./viewerOverlay";

/** [x,y] の並びを GSPS 用のフラットな配列にする。 */
function flatten(points: readonly (readonly [number, number])[]): number[] {
  const out: number[] = [];
  for (const p of points) {
    out.push(p[0], p[1]);
  }
  return out;
}

/**
 * 全注釈の統計を無効化する。
 *
 * <p>🚨 空間校正を変えても、計測ラベルは **`cachedStats` に残った古い値のまま**になる
 * （Cornerstone は `invalidated` が立つまで再計算しない）。実機で「スケールバーは mm に
 * なったのに計測は px のまま」という形で出た。校正の確定/解除の直後に必ず呼ぶこと。
 */
function invalidateAnnotations(): void {
  try {
    const all = (csAnnotation.state.getAllAnnotations() as any[]) ?? [];
    for (const a of all) {
      if (a) a.invalidated = true;
    }
  } catch {
    /* 注釈が無ければ何もしない */
  }
}

/**
 * 解析に使い終わった Length 計測をロックする / 解除する。
 *
 * <h3>🔴 なぜロックするのか（2 つある）</h3>
 * 1. **分岐部（A6b）は同じ点から 3 本の区間を引く**。Cornerstone の mousedown は、
 *    既存注釈のハンドルの上（半径 6px）で押すと**新規作成ではなくそれを掴んで動かす**。
 *    分岐部は「3 本がカリーナで出会う」形なので**必ず踏む**（実機で、遠位を引いたつもりが
 *    近位の計測が 89.5px → 207px に伸びた）。`isLocked` が立っていると
 *    `filterToolsWithMoveableHandles` / `filterMoveableAnnotationTools` が対象から外すので、
 *    同じ点で押しても**新しい計測が生まれる**。
 * 2. 解析結果は**引かれた線と対で意味を持つ**。ランを登録した後に線だけ動かされると、
 *    登録簿の中心線・径が画面のどこを測ったものか分からなくなる（黙ってずれる）。
 *
 * <p>解除は利用者の操作でだけ行う（{@link XaAnalysisDialog} の「ロック解除」）。
 * 解除したら**登録も外す**——線を引き直す前提なので、古いランを残すと
 * 3D の一覧に「もう画面に無い区間」が並ぶ。
 */
function setPickLocked(uid: string, locked: boolean): void {
  try {
    csAnnotation.locking.setAnnotationLocked(uid, locked);
  } catch {
    /* ロックできない環境（テスト等）では素通しする */
  }
}

function lockedPickUids(): Set<string> {
  try {
    return new Set(csAnnotation.locking.getAnnotationsLocked() ?? []);
  } catch {
    return new Set();
  }
}

function shortUid(uid: string): string {
  return uid.length > 12 ? `…${uid.slice(-12)}` : uid;
}

/**
 * 手修正の内容を人が読める 1 行にする。**保存物（SR）にそのまま入れる**。
 *
 * <p>手で直した値を自動値と同じ顔で保存すると、読む側が再現性・監査可能性を判断できない
 * （`fw/angio-design.md` §8.6）。全自動なら null を返し、SR 側が "None" と書く。
 */
function describeManual(result: QcaResult): string | null {
  const p = result.provenance;
  if (!p.edited) return null;
  const parts: string[] = [];
  if (p.waypoints > 0) parts.push(`waypoints=${p.waypoints}`);
  if (p.editedEdges.length > 0) parts.push(`edges=${p.editedEdges.length}`);
  if (p.trimmed) parts.push("trimmed");
  if (p.reference !== "auto") parts.push(`reference=${p.reference}`);
  return parts.join("; ");
}

/**
 * 表示中ビューポートの実 VOI を読む。
 *
 * <p>メタデータ（voiLutModule）ではなく**実際に表示されている値**を保存する。
 * ユーザが W/L を触った後にメタデータの値を保存すると、開き直したときに違う見え方になる。
 * 対象が見つからなければ null（GSPS の VOI モジュールを省く）。
 */
function readVoiFor(imageId: string): { windowCenter: number; windowWidth: number } | null {
  try {
    const engine = getRenderingEngine(ENGINE_ID);
    if (!engine) return null;
    for (const vp of engine.getViewports()) {
      const current = (vp as { getCurrentImageId?: () => string | undefined }).getCurrentImageId?.();
      if (current !== imageId) continue;
      const w = readVoiWindow(vp as never);
      if (w && Number.isFinite(w.center) && Number.isFinite(w.width)) {
        return { windowCenter: w.center, windowWidth: w.width };
      }
    }
  } catch {
    /* 読めなければ VOI は保存しない */
  }
  return null;
}

/** 手修正パネル用の窓（ビューポートと同じ見え方にする）。 */
function readVoiWindowFor(imageId: string): { center: number; width: number } | null {
  const v = readVoiFor(imageId);
  return v ? { center: v.windowCenter, width: v.windowWidth } : null;
}

/**
 * 入力に選べる線 1 本。
 *
 * <p>🔴 **`kind` で用途が分かれる**（`fw/angio-design.md` §8.7）。解析区間は開いた輪郭も
 * 許すが、**空間校正は直線（`line`）だけ**——既知の長さは直線距離で、曲線の経路長とは
 * 意味が違う（`qcaInput.canCalibrateWith`）。
 */
interface LengthPick {
  uid: string;
  kind: QcaSegmentKind;
  /** 頂点列（画像座標 [px]）。直線なら 2 点。 */
  points: [number, number][];
  /** 始点・終点（画像座標 [px]）。ラン登録の鍵にも使う。 */
  p0: [number, number];
  p1: [number, number];
  /** **経路長** [px]（折れ線は辺の合計。直線距離ではない）。 */
  lengthPx: number;
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * world 座標 → 画像ピクセル座標。
 *
 * <p>XA は IPP/IOP を持たないため、Cornerstone の StackViewport は既定平面
 * （原点 0・行/列方向が x/y 軸）を使う。よって world = (x·列spacing, y·行spacing)。
 *
 * <p>🚨 ここで使う spacing は **ローダが画像に付けた値**（DICOM の `PixelSpacing`、無ければ 1）で
 * あって、**我々が校正で決めた mm/px ではない**。校正値で割ると、校正した瞬間に座標が
 * 桁違いになり解析が黙って失敗する（実機で「校正後に古い結果が残る」形で発覚）。
 */
function worldToImagePx(
  w: readonly number[],
  mmPerPxRow: number | null,
  mmPerPxCol: number | null,
): [number, number] {
  const col = mmPerPxCol && mmPerPxCol > 0 ? mmPerPxCol : 1;
  const row = mmPerPxRow && mmPerPxRow > 0 ? mmPerPxRow : 1;
  return [w[0] / col, w[1] / row];
}

/** この imageId に紐づく「入力に使える線」を集める（長さ／ポリゴンライン／フリーライン）。 */
function collectLengthPicks(
  imageId: string,
  mmPerPxRow: number | null,
  mmPerPxCol: number | null,
): LengthPick[] {
  let all: any[] = [];
  try {
    all = (csAnnotation.state.getAllAnnotations() as any[]) ?? [];
  } catch {
    return [];
  }
  const out: LengthPick[] = [];
  for (const a of all) {
    const kind = segmentKindOf(a?.metadata?.toolName as string | undefined);
    if (!kind) continue;
    if (a?.metadata?.referencedImageId && a.metadata.referencedImageId !== imageId) continue;
    // 輪郭系は補間後の `contour.polyline`、直線は `handles.points`。
    const raw = a?.data?.contour?.polyline ?? a?.data?.handles?.points;
    if (!Array.isArray(raw) || raw.length < 2) continue;
    const points = raw.map((w: readonly number[]) => worldToImagePx(w, mmPerPxRow, mmPerPxCol));
    out.push({
      uid: String(a.annotationUID ?? out.length),
      kind,
      points,
      p0: points[0],
      p1: points[points.length - 1],
      // 🔴 折れ線は**経路長**。直線距離で扱うと校正でも解析でも長さを取り違える。
      lengthPx: pathLengthPx(points),
    });
  }
  return out;
}

/** 保存時刻を画面用に短くする。読めない ISO をそのまま出さない。 */
function formatSavedAt(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 保存（GSPS / SR）に必要な、表示中フレームの素性。SeriesViewer から渡す。 */
export interface XaSaveContext {
  studyUid: string;
  /**
   * 解析状態の保存先（患者ごとの JSON。ROI と同じ器。§14.5）。
   * 空なら解析状態は残さない（＝毎回自動解析からやり直しになる）。
   */
  patientKey?: string;
  /** 表示中フレームの元インスタンス（＝ラン）。 */
  sopInstanceUid: string | null;
  /** 表示中フレーム（**0 origin**。DICOM へ書くときに +1 する）。 */
  frameIndex: number;
  /** DSA 中ならその設定（マスクフレームは 0 origin）。 */
  dsa?: { maskFrames: number[]; dx: number; dy: number } | null;
}

export function XaAnalysisDialog({
  imageId,
  seriesUid,
  isSubtracted,
  saveContext,
  onClose,
  onCalibrated,
}: {
  /** 解析対象の imageId（表示中フレーム。DSA 表示中は合成 imageId）。 */
  imageId: string;
  seriesUid: string;
  /** DSA 表示中か（血管が明るいか暗いかの判断に使う）。 */
  isSubtracted: boolean;
  saveContext: XaSaveContext;
  onClose: () => void;
  onCalibrated?: () => void;
}) {
  const defaultReference: QcaReferenceMode = { kind: "auto" };
  const { t } = useI18n();
  // 校正を確定/解除したら自分の表示も更新する（imageId は変わらないので版番号で回す）。
  const [calibVersion, setCalibVersion] = useState(0);
  const calib = useMemo(
    () => calibrationForImageId(imageId),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [imageId, calibVersion],
  );
  // world → 画像ピクセルの換算は**ローダの spacing**で行う（校正値ではない）。
  const picks = useMemo(() => {
    const sp = loaderSpacingFor(imageId);
    return collectLengthPicks(imageId, sp.row, sp.col);
  }, [imageId, calibVersion]);
  const [selected, setSelected] = useState(0);
  /**
   * 🔴 **空間校正の選択は解析区間と別に持つ**（`fw/angio-design.md` §8.7）。
   * 以前は 1 つの一覧を共用しており、**カテーテル校正用の 9.2px の線がそのまま解析区間に
   * 使われて**、10 点しか測れないまま `MLD > RVD` の無意味な結果が出た（実機・2026-08-27）。
   */
  const [calibSelected, setCalibSelected] = useState(0);
  /** ロック済みの計測（§21.4.2 の 2）。解析に使い終わった線は掴めなくする。 */
  const [locked, setLocked] = useState<Set<string>>(() => lockedPickUids());
  const [knownMm, setKnownMm] = useState("");
  const [frSize, setFrSize] = useState("6");
  const [result, setResult] = useState<QcaResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // ── 手修正（§8.6）─────────────────────────────────────────────────
  const [waypoints, setWaypoints] = useState<[number, number][]>([]);
  const [edgeEdits, setEdgeEdits] = useState<Record<number, { left?: number; right?: number }>>({});
  const [edgeToken, setEdgeToken] = useState<string | null>(null);
  const [trim, setTrim] = useState<{ from: number; to: number } | null>(null);
  const [refMode, setRefMode] = useState<QcaReferenceMode>(defaultReference);
  const [editMode, setEditMode] = useState<QcaEditMode>("none");
  /** ブラシ半径。単位は結果と同じ（校正済み mm / 未校正 px）。 */
  const [brushRadius, setBrushRadius] = useState<number | null>(null);
  /**
   * 表示の切り替え（2026-08-28 の要望）。
   *
   * <p>**線と面は見え方が違う**——線は「どこを通っているか」、面は「どこまでを内腔と
   * みなしたか」を見せる。輪郭が外れているとき、面のほうが一目で分かることが多い。
   * 画像そのものを見たいときは両方消せる。
   *
   * <p>⚠️ 既定はエッジのみ（従来の見え方を変えない）。マスクは押したときだけ。
   */
  const [showEdges, setShowEdges] = useState(true);
  const [showMask, setShowMask] = useState(false);
  // ストレート像は既定 ON（§8.9）。曲がりの影響が消えるので、外れたエッジはここが一番早い。
  const [showStraight, setShowStraight] = useState(true);
  /**
   * この計測に対して保管庫に残っている解析状態（§14.5）。
   *
   * <p>🔴 **「結果」ではなく「入力」を戻す。** 復元したら同じ入力でもう一度解析する
   * ——保存した数値をそのまま表示すると、アルゴリズムを直したときに**古い数値が
   * 新しい画面に混ざる**。
   */
  const [savedAnalysis, setSavedAnalysis] = useState<SavedQcaAnalysis | null>(null);
  /** 復元したことを画面に出す（黙って手修正が入っていると「自動解析が変」に見える）。 */
  const [restoredAt, setRestoredAt] = useState<string | null>(null);
  /** 保存済みの SR があるときに出す「上書き / 新規」の選択。 */
  const [srChoice, setSrChoice] = useState(false);

  /**
   * 🔴 **解析結果がある間はフレームを固定する**（実機で言われた・2026-08-28）。
   *
   * <p>結果は「あるフレーム」に対して出ており、中心線・エッジ・手修正・校正はすべてその 1 枚に
   * 紐付いている。裏でホイールが効くと、**画面の画像とダイアログの数値が別フレームのもの**になり、
   * しかも**エラーが出ない**（値は内部整合したまま残る）。
   *
   * <p>⚠️ **ダイアログを開いている間ずっと、ではない。** 解析前にフレームを選ぶのは正当な操作で、
   * そこまで止めると「解析したいフレームに行けない」になる。錠は結果が出てから。
   *
   * <p>⚠️ **解析の実行中（`busy`）も掛ける**（2026-09-01）。走っている最中に送られると、
   * 読み終えた画素と出来上がる結果のフレームが食い違う——結果が出た後より気付きにくい。
   */
  const frameLocked = !!result || busy;
  useEffect(() => {
    if (!frameLocked) return;
    return lockSliceNavigation();
  }, [frameLocked]);
  const [chartMode, setChartMode] = useState<"none" | "trim" | "reference">("none");
  const [highlight, setHighlight] = useState<number | null>(null);
  /** 解析に使った画素。手修正のたびに読み直すと重いのでキャッシュする。 */
  const sliceRef = useRef<{ imageId: string; values: Float32Array; width: number; height: number } | null>(null);

  const resetEdits = () => {
    setWaypoints([]);
    setEdgeEdits({});
    setEdgeToken(null);
    setTrim(null);
    setRefMode(defaultReference);
    setEditMode("none");
    setChartMode("none");
    setHighlight(null);
  };

  useEffect(() => {
    setResult(null);
    setError(null);
    setSaved(null);
    sliceRef.current = null;
    resetEdits();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageId]);

  const pick = picks[selected] ?? null;
  /** 校正に使える線だけ（**直線のみ**）。 */
  const calibPicks = useMemo(() => picks.filter((p) => canCalibrateWith(p.kind)), [picks]);
  const calibPick = calibPicks[calibSelected] ?? null;
  /** 一覧の表示。🔴 **px ではなく mm で出す**——`9.2 px` では校正用か解析用か見分けられない。 */
  const pickLabel = useCallback(
    (p: LengthPick, i: number): string => {
      const mmPerPx = calib?.mmPerPxCol ?? null;
      const size = mmPerPx && mmPerPx > 0 ? `${(p.lengthPx * mmPerPx).toFixed(1)} mm` : `${p.lengthPx.toFixed(1)} px`;
      const kind = t(`xa.analysis.kind.${p.kind}`);
      const pts = p.kind === "line" ? "" : ` · ${p.points.length}${t("xa.analysis.points")}`;
      return `#${i + 1} — ${size}（${kind}${pts}）`;
    },
    [calib, t],
  );
  /**
   * 一覧に出す「この線は何に使われているか」。
   *
   * <p>🔴 **同じ線を解析区間と校正の両方に使うのは事故**（§8.7。カテーテル校正用の 9.2px の
   * 線がそのまま解析区間に使われ、10 点しか測れないまま `MLD > RVD` が出た）。
   * だから**どちらの一覧にも他方での使用を出す**——選ぶ前に気付けるようにする。
   */
  const pickUsage = useCallback(
    (p: LengthPick): string => {
      const tags: string[] = [];
      if (locked.has(p.uid)) tags.push(t("xa.analysis.usedForAnalysis"));
      if (calibPick && p.uid === calibPick.uid) tags.push(t("xa.analysis.usedForCalib"));
      return tags.length ? ` · ${tags.join(" / ")}` : "";
    },
    [locked, calibPick, t],
  );
  /** 解析区間と校正に**同じ線**を選んでいる（§8.7 の事故そのもの）。 */
  const samePickForBoth = !!pick && !!calibPick && pick.uid === calibPick.uid;
  /** 解析区間として短すぎるか（プロファイル半径の 3 倍が下限）。 */
  const tooShort = !!pick && segmentTooShort(pick.lengthPx);

  /**
   * 選んでいる線を**画像の上で光らせる**。
   *
   * <p>🚨 一覧のラベルだけでは「画面のどの線か」が分からない。解析区間と空間校正は
   * 別々に選ぶ（§8.7）が、**候補は同じ計測の一覧**なので、文字列は同じ顔で並ぶ
   * （`#1 — 45.9 mm（長さ）`）。実機で「どちらを選んでいるのか分かりにくい」と言われた。
   *
   * <p>ハイライトの実体は **Cornerstone の annotation selection**（本体の選択表示と同じ）。
   * 独自の強調を重ねると、本体の選択と二重に見えて余計に分からなくなる。
   */
  const highlightPick = useCallback((uid: string | null) => {
    try {
      for (const u of csAnnotation.selection.getAnnotationsSelected() ?? []) {
        csAnnotation.selection.setAnnotationSelected(u, false);
      }
      if (uid) csAnnotation.selection.setAnnotationSelected(uid, true, false);
      const engine = getRenderingEngine(ENGINE_ID);
      const ids = (engine?.getViewports() ?? []).map((v) => v.id);
      if (ids.length) csToolsUtilities.triggerAnnotationRenderForViewportIds(ids);
    } catch {
      /* 光らせられなくても解析は続けられる */
    }
  }, []);

  const applyCalibration = (mm: number, method: "catheter" | "ruler", note: string) => {
    // 🔴 校正は**直線のみ**（`calibPicks`）。曲線の経路長を既知長と突き合わせると、
    //    手ぶれのぶんだけ mm/px が小さく出て、以後のすべての計測が小さくなる。
    if (!calibPick || !(calibPick.lengthPx > 0) || !(mm > 0)) {
      setError(t("xa.analysis.needCalibLine"));
      return;
    }
    // 🚨 保存まで含めて確定する（`setXaUserCalibration` を直に呼ぶと次に開いたとき消えている）。
    void persistXaUserCalibration(seriesUid, { mmPerPx: mm / calibPick.lengthPx, method, note });
    invalidateAnnotations();
    setError(null);
    setCalibVersion((v) => v + 1);
    onCalibrated?.();
  };

  /**
   * 表示状態を XA/XRF GSPS として保存する（非破壊）。
   * QCA を実行済みなら、中心線とエッジ・%DS のラベルも図形として一緒に保存する。
   */
  const savePresentationState = () => {
    const sop = saveContext.sopInstanceUid;
    if (!sop) {
      setError(t("xa.analysis.noReference"));
      return;
    }
    setSaving(true);
    setError(null);
    const c = calibrationForImageId(imageId);
    const voi = readVoiFor(imageId);
    const polylines: NonNullable<AngioPresentationRequest["polylines"]> = [];
    const texts: NonNullable<AngioPresentationRequest["texts"]> = [];
    if (result) {
      polylines.push({ layer: "QCA", points: flatten(result.centerline) });
      polylines.push({ layer: "QCA", points: flatten(result.edges.map((e) => e.left)) });
      polylines.push({ layer: "QCA", points: flatten(result.edges.map((e) => e.right)) });
      const mldPoint = result.centerline[result.mldIndex];
      if (mldPoint) {
        texts.push({
          layer: "QCA",
          text: `%DS ${result.percentDiameterStenosis.toFixed(1)} / MLD ${result.mld.toFixed(2)}${result.unit}`,
          anchorX: mldPoint[0],
          anchorY: mldPoint[1],
        });
      }
    }
    createXaPresentationState({
      studyInstanceUid: saveContext.studyUid,
      seriesInstanceUid: seriesUid,
      sopInstanceUid: sop,
      // DICOM のフレーム番号は 1 origin。
      frameNumbers: [saveContext.frameIndex + 1],
      label: "QCA",
      description: result
        ? `QCA %DS ${result.percentDiameterStenosis.toFixed(1)}${
            result.provenance.edited ? " (manually corrected)" : ""
          }`
        : "GRAPHY-Next presentation state",
      voi,
      invert: false,
      mask: saveContext.dsa
        ? {
            maskFrameNumbers: saveContext.dsa.maskFrames.map((i) => i + 1),
            // DICOM の MaskSubPixelShift は [row, column]。内部の {dx=横, dy=縦} と並びが逆。
            subPixelShiftRow: saveContext.dsa.dy,
            subPixelShiftCol: saveContext.dsa.dx,
          }
        : null,
      calibration:
        c && c.mmPerPxRow != null && c.mmPerPxCol != null
          ? {
              mmPerPxRow: c.mmPerPxRow,
              mmPerPxCol: c.mmPerPxCol,
              type: c.source === "user-catheter" || c.source === "dicom-fiducial" ? "FIDUCIAL" : "GEOMETRY",
              description: c.provenance,
            }
          : null,
      polylines,
      texts,
    })
      .then((r) => {
        setSaved(t("xa.analysis.savedGsps", { uid: shortUid(r.sopInstanceUid) }));
        // 表示状態を残したなら、やり直せる材料（解析状態）も一緒に残す。
        // 🔴 SR の参照は触らない（GSPS は SR の版とは無関係）。
        persistAnalysis(undefined);
      })
      .catch(() => setError(t("xa.analysis.saveFailed")))
      .finally(() => setSaving(false));
  };

  /**
   * 保存の入口。**同じ解析から前に書いた SR があるなら、上書きか新規かを聞いてから**書く。
   *
   * <p>🔴 黙ってどちらかに決めない。新規で増え続けるのも、前の版が消えるのも、
   * どちらも「そのつもりが無かった」と言われる類の副作用。聞くのが一番安い。
   */
  const saveQca = () => {
    if (savedAnalysis?.sr) {
      setSrChoice(true);
      return;
    }
    doSaveQca(false);
  };

  /**
   * 計測値を Comprehensive SR として保存する（QVA なら瘤の指標込み）。
   *
   * @param replace 前の SR を保管庫から**削除してから**書く（＝上書き）
   */
  const doSaveQca = (replace: boolean) => {
    const sop = saveContext.sopInstanceUid;
    if (!sop || !result) return;
    setSrChoice(false);
    setSaving(true);
    setError(null);
    // 🔴 前の SR は「新しいものが書けてから」ではなく先に消す。後で消す作りにすると、
    //    書き込みに失敗したときに**前の版だけが残って新しい値が無い**状態になり得るが、
    //    先に消せば「消えたが書けなかった」が画面に出る（黙って古い値が残るより良い）。
    const before =
      replace && savedAnalysis?.sr
        ? deleteSeries(saveContext.studyUid, savedAnalysis.sr.seriesInstanceUid).catch(() => {
            // 既に手で消されていることがある。消せなくても保存は続ける（新規として残る）。
          })
        : Promise.resolve();
    void before.then(() => doSaveQcaInner(sop));
  };

  const doSaveQcaInner = (sop: string) => {
    if (!result) return;
    const c = calibrationForImageId(imageId);
    createQcaSr({
      studyInstanceUid: saveContext.studyUid,
      seriesInstanceUid: seriesUid,
      sopInstanceUid: sop,
      frameNumber: saveContext.frameIndex + 1,
      unit: result.unit,
      calibration: c?.provenance ?? null,
      vesselLabel: null,
      // 手で直した値を自動値と同じ顔で保存しない（§8.6）。
      manualCorrection: describeManual(result),
      // 測り方も同じ理由で必ず残す（§16.5）。
      diameterMethod: result.provenance.diameterMethod,
      mld: result.mld,
      rvd: result.rvd,
      percentDiameterStenosis: result.percentDiameterStenosis,
      percentAreaStenosis: result.percentAreaStenosis,
      lesionLength: result.lesionLength,
    })
      .then((r) => {
        setSaved(t("xa.analysis.savedSr", { uid: shortUid(r.sopInstanceUid) }));
        persistAnalysis({ seriesInstanceUid: r.seriesInstanceUid, sopInstanceUid: r.sopInstanceUid });
      })
      .catch(() => setError(t("xa.analysis.saveFailed")))
      .finally(() => setSaving(false));
  };

  /** 手修正を当てて解析し直す。画素はキャッシュを使うので同期的に終わる。 */
  const analyzeWith = (edits: QcaManualEdits, slice: { values: Float32Array; width: number; height: number }) => {
    if (!pick) return;
    const c = calibrationForImageId(imageId);
    // 🔴 開いた輪郭（ポリゴンライン / フリーライン）は**節（中間点）**として渡す。
    //    `runQca` は節ごとに最小経路を引くので、フリーラインは弧長で間引く
    //    （全頂点を渡すと中心線が手描きそのものになり、手ぶれが径プロファイルへ乗る）。
    const knots = toQcaKnots(pick.points, pick.kind);
    if (!knots) {
      setError(t("xa.analysis.failed"));
      return;
    }
    // 利用者が線の上に足した中間点は、線そのものの節より後に効かせる。
    const withPath: QcaManualEdits = {
      ...edits,
      waypoints: [...knots.waypoints, ...(edits.waypoints ?? [])],
    };
    const r = runQca({
      pixels: slice.values,
      width: slice.width,
      height: slice.height,
      start: knots.start,
      end: knots.end,
      edits: withPath,
      mmPerPxRow: c?.mmPerPxRow ?? null,
      mmPerPxCol: c?.mmPerPxCol ?? null,
      // DSA 後は血管が正の大きな値（明るい）、非サブトラクションは暗い。
      vesselIsDark: !isSubtracted,
      // 🚨 密度計測（§16.5）は画素値の意味に依る。**`vesselIsDark` では決まらない**——
      //    非サブトラクションでも装置が LOG で保存していれば、値は既に対数なので
      //    もう一度対数を取ってはいけない。タグが無い XA を LOG とみなすのは
      //    `dsa.ts` の `needsLogTransform` と同じ慣行（そこが正本）。
      profileDomain: isSubtracted
        ? "attenuation"
        : needsLogTransform(readXaDsaTags(imageId)?.pixelIntensityRelationship ?? null)
          ? "intensity"
          : "logIntensity",
    });
    if (!r) {
      // 失敗したときに**古い結果が残らない**ようにする（前回値を見て「変わっていない」と
      // 誤解する事故を防ぐ。実機で踏んだ）。
      setResult(null);
      // 🚨 検証用スナップショットも必ず消す。ここを残すと automator は**前のフレームの
      //    数値**を読んで合格してしまう（実際に「別フレームの結果が出ている」形で踏んだ）。
      //    画面と同じ理由で、失敗は「値が無い」でなければならない。
      publishQcaSnapshot(null);
      setError(t("xa.analysis.failed"));
      return;
    }
    setError(null);
    setResult(r);
    // 解析に使った線はロックする。次の区間を**同じ端点から**引けるようにするため
    // （分岐部は必ずここを踏む）と、結果と線がずれないようにするため。
    setPickLocked(pick.uid, true);
    setLocked(lockedPickUids());
    // 実機検証（automator）が掴む対象を計算できるように公開する。DEV 以外では何もしない。
    publishQcaSnapshot({
      imageId,
      centerline: r.centerline,
      edges: r.edges,
      pathIndices: r.pathIndices,
      centerlineToken: r.centerlineToken,
      provenance: r.provenance,
      mld: r.mld,
      rvd: r.rvd,
      percentDiameterStenosis: r.percentDiameterStenosis,
      percentAreaStenosis: r.percentAreaStenosis,
      lesionLength: r.lesionLength,
      profileNoise: r.profileNoise,
      diameterMethod: r.provenance.diameterMethod,
      muPerMm: r.provenance.muPerMm,
      densitometryFallback: r.provenance.densitometryFallback,
      points: r.diameters.length,
      referenceFirst: r.reference[0] ?? 0,
      referenceLast: r.reference[r.reference.length - 1] ?? 0,
      unit: r.unit,
      warnings: r.warnings,
    });
    // レポートへ差し込めるように登録する（A14）。**出自（校正・手修正）も一緒に持ち込む**。
    if (saveContext.sopInstanceUid) {
      publishAnalysisResult(
        qcaRecord(
          {
            studyUid: saveContext.studyUid,
            seriesUid,
            sopInstanceUid: saveContext.sopInstanceUid,
            frameIndex: saveContext.frameIndex,
            unit: r.unit,
            calibration: c?.provenance ?? null,
            manualCorrection: describeManual(r),
            mld: r.mld,
            rvd: r.rvd,
            percentDiameterStenosis: r.percentDiameterStenosis,
            percentAreaStenosis: r.percentAreaStenosis,
            lesionLength: r.lesionLength,
            diameterMethod: r.provenance.diameterMethod,
          },
          t,
        ),
      );
    }

    // 3D QCA（A6a）で選べるように登録する。投影幾何が読めない装置・データでは登録しない
    // （角度や SID/SOD が無ければ 3D にはできない。§10.1 の表）。
    const view = readXaViewGeometry(imageId, saveContext.frameIndex);
    if (view.geometry) {
      registerQcaRun({
        imageId,
        // 🔴 鍵は imageId ではなく**imageId ＋ 解析区間**（分岐部は同じフレームから 3 本取る）。
        runKey: qcaRunKey(imageId, pick.p0, pick.p1),
        studyUid: saveContext.studyUid,
        seriesUid,
        sopInstanceUid: saveContext.sopInstanceUid,
        frameIndex: saveContext.frameIndex,
        // 同じフレームから複数の区間を取るので、**区間の長さまで名前に入れる**
        // （さもないと一覧に同じ名前が並び、どれを選んでいるのか分からない）。
        label: `${describeView(view.geometry, saveContext.frameIndex)} · ${Math.round(
          Math.hypot(pick.p1[0] - pick.p0[0], pick.p1[1] - pick.p0[1]),
        )}px`,
        geometry: view.geometry,
        centerline: r.centerline,
        diameters: r.diameters,
        diameterPathIndices: r.pathIndices,
        unit: r.unit,
        diameterMethod: r.provenance.diameterMethod,
        edited: r.provenance.edited,
        // 校正の出自は 3D（A7 の H11）まで運ぶ。落とすと近似が実測として外部モジュールへ渡る。
        calibrationSource: c?.source,
        calibrationTier: c?.tier,
        at: Date.now(),
      });
    }
    // 中心線が変わったらエッジ修正の宛先も変わる。UI 側の token を追随させる
    // （合わないまま持ち回ると runQca が捨てて警告を出す）。
    if (r.centerlineToken !== edgeToken) {
      setEdgeToken(r.centerlineToken);
      if (r.warnings.includes("edgeEditsDropped")) setEdgeEdits({});
    }
  };

  const currentEdits = (over?: Partial<QcaManualEdits>): QcaManualEdits => ({
    waypoints,
    edges: edgeToken && Object.keys(edgeEdits).length ? { token: edgeToken, byPathIndex: edgeEdits } : null,
    trim,
    reference: refMode,
    ...over,
  });

  /** 手修正を変えたら即座に再解析する（押し直しを要求しない）。 */
  const reanalyze = (over: Partial<QcaManualEdits>) => {
    const slice = sliceRef.current;
    if (!slice) return;
    analyzeWith(currentEdits(over), slice);
  };

  // ── 段（ステップ・レール。§21.6）─────────────────────────────────
  // 🚨 段の状態は**持たずに導出する**。フラグを別に持つと必ず実体とずれる。
  //    結果があるときは `result.provenance`（＝実際に適用された手修正）を見る。
  //    UI の状態を見ると「捨てられた手修正」を「適用済み」と表示してしまう。
  const steps = useMemo(
    () =>
      deriveQcaSteps({
        hasPick: !!pick,
        calibrated: calib ? isXaCalibrated(calib) : false,
        calibrationSource: calib?.source ?? null,
        hasResult: !!result,
        waypoints: result?.provenance.waypoints ?? 0,
        editedEdges: result?.provenance.editedEdges.length ?? 0,
        trimmed: result?.provenance.trimmed ?? false,
        referenceKind: result?.provenance.reference ?? "auto",
        edgeEditsDropped: result?.warnings.includes("edgeEditsDropped") ?? false,
        canSave: !!saveContext.sopInstanceUid,
        saved: !!saved,
      }),
    [pick, calib, result, saveContext.sopInstanceUid, saved],
  );

  /** 段に対応する節へスクロールする。節側は `data-step`（空白区切りで複数可）で名乗る。 */
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const goToStep = (id: string) => {
    const el = bodyRef.current?.querySelector(`[data-step~="${id}"]`);
    el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  };

  /**
   * その段からやり直す。**捨てる範囲は `clearedBy()` が決める**（ここで個別に判断しない）。
   *
   * <p>「無効になる段」と「捨てる手修正」は別物。校正をやり直しても通過点は残る（画素座標なので）。
   */
  const redoFrom = (id: string) => {
    const keys: ManualInputKey[] = clearedBy(id);
    if (keys.length === 0) {
      goToStep(id);
      return;
    }
    const over: Partial<QcaManualEdits> = {};
    if (keys.includes("waypoints")) {
      setWaypoints([]);
      over.waypoints = [];
    }
    if (keys.includes("edges")) {
      setEdgeEdits({});
      over.edges = null;
    }
    if (keys.includes("trim")) {
      setTrim(null);
      over.trim = null;
    }
    if (keys.includes("reference")) {
      setRefMode({ kind: "auto" });
      over.reference = { kind: "auto" };
    }
    reanalyze(over);
    goToStep(id);
  };

  const runAnalysis = (edits?: QcaManualEdits) => {
    if (!pick) {
      setError(t("xa.analysis.needLength"));
      return;
    }
    // 🚨 短すぎる区間では幾何が成立しない。実機では**カテーテル校正用の 9.2px の線**が
    //    そのまま使われ、10 点しか測れないまま `MLD > RVD` の無意味な結果が出た。
    //    エラーも出ないので誰も気付けなかった（`fw/angio-design.md` §8.7）。
    if (segmentTooShort(pick.lengthPx)) {
      setError(t("xa.analysis.tooShort", { min: minSegmentPx().toFixed(0) }));
      return;
    }
    const cached = sliceRef.current;
    if (cached && cached.imageId === imageId) {
      analyzeWith(edits ?? currentEdits(), cached);
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    readModalitySlice(imageId)
      .then((slice) => {
        if (!slice) {
          setError(t("xa.analysis.noPixels"));
          return;
        }
        sliceRef.current = { imageId, values: slice.values, width: slice.width, height: slice.height };
        analyzeWith(edits ?? currentEdits(), slice);
      })
      .catch(() => setError(t("xa.analysis.failed")))
      .finally(() => setBusy(false));
  };

  /* ── 解析状態の保存と復元（§14.5）─────────────────────────────── */

  /** いまの解析を指す鍵。計測・フレーム・モードまで含める。 */
  const analysisKey = useMemo((): QcaAnalysisKey | null => {
    const sop = saveContext.sopInstanceUid;
    if (!sop || !pick) return null;
    // 🔴 `mode` は保存物の互換のために残す。QVA を撤去したので常に "qca"（2026-09-02）。
    return { sopInstanceUid: sop, frame: saveContext.frameIndex, pickUid: pick.uid, mode: "qca" };
  }, [saveContext.sopInstanceUid, saveContext.frameIndex, pick]);

  /**
   * 保存済みの解析があれば**自動で復元して再解析する**。
   *
   * <p>🔴 **1 つの鍵につき 1 回だけ**当てる。毎回当てると、利用者が「手修正をすべて破棄」した
   * 直後に**復元が勝って元に戻る**（何をしても戻ってくる、という最悪の壊れ方になる）。
   */
  const restoredKeys = useRef(new Set<string>());
  useEffect(() => {
    const patientKey = saveContext.patientKey;
    if (!patientKey || !analysisKey) return;
    const id = analysisId(analysisKey);
    if (restoredKeys.current.has(id)) return;
    let cancelled = false;
    void loadRoisCached(patientKey)
      .catch(() => null)
      .then(() => {
        if (cancelled) return;
        const found = findAnalysis(getQcaAnalyses(patientKey), analysisKey);
        setSavedAnalysis(found);
        if (!found) return;
        restoredKeys.current.add(id);
        setWaypoints(found.waypoints.map((w) => [w[0], w[1]] as [number, number]));
        setEdgeEdits(found.edgeEdits);
        setEdgeToken(found.edgeToken);
        setTrim(found.trim);
        setRefMode(found.reference);
        setRestoredAt(found.savedAt);
        // 入力を戻したら**そのまま解析まで走らせる**。押させると「復元したのに何も出ない」になる。
        runAnalysis({
          waypoints: found.waypoints.map((w) => [w[0], w[1]] as [number, number]),
          edges:
            found.edgeToken && Object.keys(found.edgeEdits).length
              ? { token: found.edgeToken, byPathIndex: found.edgeEdits }
              : null,
          trim: found.trim,
          reference: found.reference,
        });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysisKey, saveContext.patientKey]);

  /**
   * いまの解析状態を保管庫へ残す。
   *
   * <p>⚠️ **保存を押したときだけ**残す。編集のたびに残すと、捨てたはずの手修正が
   * 次に開いたときに戻ってくる（利用者は「保存した」ものだけが残ると考える）。
   */
  const persistAnalysis = useCallback(
    (sr: SavedQcaAnalysis["sr"] | undefined) => {
      const patientKey = saveContext.patientKey;
      if (!patientKey || !analysisKey) return;
      const next: SavedQcaAnalysis = {
        id: analysisId(analysisKey),
        mode: "qca",
        studyUid: saveContext.studyUid,
        seriesUid,
        sopInstanceUid: analysisKey.sopInstanceUid,
        frame: analysisKey.frame,
        pickUid: analysisKey.pickUid,
        edgeToken,
        waypoints: waypoints.map((w) => [w[0], w[1]] as [number, number]),
        edgeEdits,
        trim,
        reference: refMode,
        sr: sr === undefined ? (savedAnalysis?.sr ?? null) : sr,
        savedAt: new Date().toISOString(),
      };
      setSavedAnalysis(next);
      // 復元済みとして印を付ける（保存した直後に自分の復元が走って上書きするのを防ぐ）。
      restoredKeys.current.add(next.id);
      // 🔴 **失敗を黙って飲まない。** 保存に失敗したまま「保存しました」と出ると、
      //    次に開いたときに復元されず「動いていない」としか見えない（原因も辿れない）。
      void upsertQcaAnalysis(patientKey, next).then((r) => {
        if (!r.ok) setError(t("xa.analysis.stateSaveFailed", { error: r.error ?? "" }));
      });
    },
    [saveContext.patientKey, saveContext.studyUid, analysisKey, seriesUid, edgeToken, waypoints, edgeEdits, trim, refMode, savedAnalysis],
  );

  return (
    <div style={backdrop} onClick={onClose} {...viewerOverlayProps}>
      <div style={panel} onClick={(e) => e.stopPropagation()}>
        <div style={title} data-testid="xa-analysis-dialog" data-mode="qca">
          {t("xa.analysis.title")}
        </div>

        <div style={body}>
        <div style={content} ref={bodyRef}>

        {/* 解析区間の選択。🔴 **空間校正の線とは別**（校正側は下の section で選ぶ）。 */}
        <div style={section} data-step="input">
          <div style={sectionTitle}>{t("xa.analysis.input")}</div>
          <div style={hint}>{t("xa.analysis.inputHelp")}</div>
          {picks.length === 0 ? (
            <div style={hint}>{t("xa.analysis.needLength")}</div>
          ) : (
            <>
              <div style={row}>
                <select
                  value={selected}
                  onChange={(e) => {
                    const i = Number(e.target.value);
                    setSelected(i);
                    // 選んだ瞬間に**画面のどの線か**を示す（文字列だけでは分からない）。
                    highlightPick(picks[i]?.uid ?? null);
                  }}
                  style={select}
                  data-testid="xa-analysis-pick"
                >
                  {picks.map((p, i) => (
                    <option key={p.uid} value={i}>
                      {pickLabel(p, i)}
                      {pickUsage(p)}
                      {locked.has(p.uid) ? ` 🔒 ${t("xa.analysis.locked")}` : ""}
                    </option>
                  ))}
                </select>
                <button
                  style={btn}
                  data-testid="xa-analysis-pick-show"
                  disabled={!pick}
                  onClick={() => highlightPick(pick?.uid ?? null)}
                  title={t("xa.analysis.showOnImageHint")}
                >
                  {t("xa.analysis.showOnImage")}
                </button>
              </div>
              {tooShort && (
                <div style={warn} data-testid="xa-pick-too-short">
                  {t("xa.analysis.tooShort", { min: minSegmentPx().toFixed(0) })}
                </div>
              )}
              {pick && locked.has(pick.uid) && (
                <div style={row}>
                  <div style={hint} data-testid="xa-pick-locked">
                    {t("xa.analysis.lockHint")}
                  </div>
                  <button
                    style={btn}
                    data-testid="xa-pick-unlock"
                    onClick={() => {
                      setPickLocked(pick.uid, false);
                      // 引き直す前提なので、登録済みのランも外す（画面に無い区間が
                      // 3D の一覧に残らないように）。
                      removeQcaRun(qcaRunKey(imageId, pick.p0, pick.p1));
                      setLocked(lockedPickUids());
                    }}
                  >
                    {t("xa.analysis.unlock")}
                  </button>
                </div>
              )}
            </>
          )}
        </div>

        {/* 校正（C2 カテーテル法 / C3 ルーラー法） */}
        <div style={section} data-step="calibration">
          <div style={sectionTitle}>{t("xa.analysis.calibration")}</div>
          <div style={hint} data-testid="xa-calib-status">
            {t("xa.calib.label")}: {calib ? t(`xa.calib.source.${calib.source}`) : "—"}
            {calib?.mmPerPxCol != null && ` (${calib.mmPerPxCol.toFixed(4)} mm/px)`}
          </div>
          {/* 🔴 校正に使う線は**直線のみ**（曲線の経路長は「既知の長さ」と意味が違う）。 */}
          <div style={hint}>{t("xa.analysis.calibHelp")}</div>
          {calibPicks.length === 0 ? (
            <div style={warn} data-testid="xa-calib-need-line">{t("xa.analysis.needCalibLine")}</div>
          ) : (
            <div style={row}>
              <select
                value={calibSelected}
                onChange={(e) => {
                  const i = Number(e.target.value);
                  setCalibSelected(i);
                  highlightPick(calibPicks[i]?.uid ?? null);
                }}
                style={select}
                data-testid="xa-calib-pick"
              >
                {calibPicks.map((p, i) => (
                  <option key={p.uid} value={i}>
                    {pickLabel(p, picks.indexOf(p))}
                    {pickUsage(p)}
                  </option>
                ))}
              </select>
              <button
                style={btn}
                data-testid="xa-calib-pick-show"
                disabled={!calibPick}
                onClick={() => highlightPick(calibPick?.uid ?? null)}
                title={t("xa.analysis.showOnImageHint")}
              >
                {t("xa.analysis.showOnImage")}
              </button>
            </div>
          )}
          {/* 🔴 §8.7 の事故そのもの。選ぶ前に気付けるように、選んだ時点で言う。 */}
          {samePickForBoth && (
            <div style={warn} data-testid="xa-calib-same-as-analysis">{t("xa.analysis.sameLineWarn")}</div>
          )}
          <div style={row}>
            <label style={label}>
              {t("xa.analysis.catheterFr")}
              <input
                data-testid="xa-catheter-fr"
                value={frSize}
                onChange={(e) => setFrSize(e.target.value)}
                style={input}
                inputMode="decimal"
              />
            </label>
            <button
              style={btn}
              data-testid="xa-calibrate-catheter"
              disabled={!calibPick}
              onClick={() => {
                const fr = Number(frSize);
                if (!(fr > 0)) {
                  setError(t("xa.analysis.badNumber"));
                  return;
                }
                // Fr → mm は定義計算（1Fr = 1/3 mm）。実測外径は製品差があるので「公称値による」。
                applyCalibration(fr / 3, "catheter", t("xa.analysis.catheterNote", { fr: String(fr) }));
              }}
            >
              {t("xa.analysis.calibrateCatheter")}
            </button>
          </div>
          <div style={row}>
            <label style={label}>
              {t("xa.analysis.knownMm")}
              <input
                data-testid="xa-known-mm"
                value={knownMm}
                onChange={(e) => setKnownMm(e.target.value)}
                style={input}
                inputMode="decimal"
              />
            </label>
            <button
              style={btn}
              disabled={!calibPick}
              onClick={() => {
                const mm = Number(knownMm);
                if (!(mm > 0)) {
                  setError(t("xa.analysis.badNumber"));
                  return;
                }
                applyCalibration(mm, "ruler", t("xa.analysis.rulerNote", { mm: String(mm) }));
              }}
            >
              {t("xa.analysis.calibrateRuler")}
            </button>
            <button
              style={btn}
              data-testid="xa-clear-calibration"
              onClick={() => {
                // 解除も残す（次に開いたときに消したはずの校正が戻るのを防ぐ）。
                void persistXaUserCalibration(seriesUid, null);
                invalidateAnnotations();
                setCalibVersion((v) => v + 1);
                onCalibrated?.();
              }}
            >
              {t("xa.analysis.clearCalibration")}
            </button>
          </div>
          <div style={hint}>{t("xa.analysis.catheterCaveat")}</div>
        </div>

        {/* QCA */}
        <div style={section} data-step="analysis">
          <div style={sectionTitle}>{t("xa.analysis.qca")}</div>
          {/* 🔴 復元したことを言う。黙って手修正が入っていると「自動解析が変」に見える。 */}
          {restoredAt && (
            <div style={restoredBox} data-testid="xa-analysis-restored">
              {t("xa.analysis.restored", { at: formatSavedAt(restoredAt) })}
            </div>
          )}
          <div style={row}>
            <button style={primaryBtn} data-testid="xa-qca-run" onClick={() => runAnalysis()} disabled={!pick || busy}>
              {busy ? t("common.loading") : t("xa.analysis.run")}
            </button>
            {result && (
              <button
                style={btn}
                data-testid="xa-qca-reset"
                disabled={!result.provenance.edited}
                onClick={() => {
                  resetEdits();
                  runAnalysis({ waypoints: [], edges: null, trim: null, reference: defaultReference });
                }}
              >
                {t("xa.qca.resetEdits")}
              </button>
            )}
            <span style={hint}>{t("xa.analysis.researchOnly")}</span>
          </div>

          {result && sliceRef.current && (
            /* 中心線とエッジはどちらもこのパネルで直すので、両方の段がここを指す。 */
            <div data-step="centerline edges">
              {/* 手修正（§8.6）。自動の中心線は外れていても必ず結果を出すので、ここが要る。 */}
              {/* 🔴 止まっている理由を出す。動かないのに理由が無いと「壊れている」と読まれる。 */}
              <div style={{ fontSize: 11, color: "#8a6d3b", marginBottom: 4 }} data-testid="xa-qca-frame-locked">
                {t("xa.qca.frameLocked")}
              </div>
              <div style={row}>
                <span style={{ fontSize: 11, color: "#44586a" }}>{t("xa.qca.editMode")}:</span>
                {(["none", "waypoint", "edge", "brush", "smooth"] as const).map((m) => (
                  <button
                    key={m}
                    style={editMode === m ? primaryBtn : btn}
                    data-testid={`xa-qca-mode-${m}`}
                    onClick={() => setEditMode(m)}
                  >
                    {t(`xa.qca.mode.${m}`)}
                  </button>
                ))}
                {/* 表示の On/Off。1 クリックで切り替わる（押している＝出ている）。 */}
                <span style={{ width: 8 }} />
                <button
                  style={showEdges ? primaryBtn : btn}
                  data-testid="xa-qca-show-edges"
                  aria-pressed={showEdges}
                  onClick={() => setShowEdges((v) => !v)}
                  title={t("xa.qca.showEdgesHint")}
                >
                  {t("xa.qca.showEdges")}
                </button>
                <button
                  style={showMask ? primaryBtn : btn}
                  data-testid="xa-qca-show-mask"
                  aria-pressed={showMask}
                  onClick={() => setShowMask((v) => !v)}
                  title={t("xa.qca.showMaskHint")}
                >
                  {t("xa.qca.showMask")}
                </button>
                <button
                  style={showStraight ? primaryBtn : btn}
                  data-testid="xa-qca-show-straight"
                  aria-pressed={showStraight}
                  onClick={() => setShowStraight((v) => !v)}
                  title={t("xa.qca.showStraightHint")}
                >
                  {t("xa.qca.showStraight")}
                </button>
                {(editMode === "brush" || editMode === "smooth") && (
                  <label style={{ ...label, fontSize: 11 }}>
                    {t("xa.qca.brushRadius", { unit: result.unit })}
                    <input
                      data-testid="xa-qca-brush-radius"
                      style={{ ...input, width: 56 }}
                      inputMode="decimal"
                      value={String(brushRadius ?? defaultBrushRadius(result.unit))}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        setBrushRadius(Number.isFinite(v) && v > 0 ? v : null);
                      }}
                    />
                  </label>
                )}
              </div>
              <QcaEditor
                pixels={sliceRef.current.values}
                width={sliceRef.current.width}
                height={sliceRef.current.height}
                voi={readVoiWindowFor(imageId)}
                result={result}
                mode={editMode}
                waypoints={waypoints}
                edgeEdits={edgeEdits}
                highlightIndex={highlight}
                onWaypointsChange={(next) => {
                  // 中心線が変わる＝エッジ修正の宛先が無意味になる（§8.6 の token）。
                  setWaypoints(next);
                  setEdgeEdits({});
                  reanalyze({ waypoints: next, edges: null });
                }}
                brushRadius={brushRadius ?? defaultBrushRadius(result.unit)}
                showEdges={showEdges}
                showMask={showMask}
                showStraight={showStraight}
                onEdgeEdit={(pathIndex, side, offset) => {
                  if (!edgeToken) return;
                  const next = { ...edgeEdits, [pathIndex]: { ...edgeEdits[pathIndex], [side]: offset } };
                  setEdgeEdits(next);
                  reanalyze({ edges: { token: edgeToken, byPathIndex: next } });
                }}
                onEdgeEditMany={(brushed) => {
                  if (!edgeToken) return;
                  const next = mergeEdgeEdits(edgeEdits, brushed);
                  setEdgeEdits(next);
                  reanalyze({ edges: { token: edgeToken, byPathIndex: next } });
                }}
              />
            </div>
          )}

          {result && (
            <div data-step="range">
            <QcaReport
              result={result}
              chartMode={chartMode}
              trimmed={!!trim}
              referenceMode={refMode}
              onChartModeChange={setChartMode}
              onHighlight={setHighlight}
              onSelectRange={(from, to) => {
                if (chartMode === "trim") {
                  const next = { from, to };
                  setTrim(next);
                  // 切り詰めは計測点インデックスの意味なので、エッジ修正（path インデックス）は生きる。
                  reanalyze({ trim: next });
                } else if (chartMode === "reference") {
                  const ranges =
                    refMode.kind === "segments" ? [...refMode.ranges, [from, to] as [number, number]] : [[from, to] as [number, number]];
                  const next: QcaReferenceMode = { kind: "segments", ranges };
                  setRefMode(next);
                  reanalyze({ reference: next });
                }
              }}
              /*
               * 帯の端を掴んで動かした結果（2026-08-31・利用者の要望）。
               * 🔴 **掴んだ時点で「人の指定」へ変わる。** 自動当てはめの支持点をそのまま種にして
               *    区間へ変換するので、利用者から見ると「自動で出た範囲を手で直した」になる。
               *    参照径だけでなく **RVD・%DS・病変長・QVA の比まで**一度に更新される
               *    （`reanalyze` が同じ入力から全部を出し直すため）。
               */
              onReferenceRanges={(ranges) => {
                const next: QcaReferenceMode =
                  ranges.length > 0 ? { kind: "segments", ranges } : defaultReference;
                setRefMode(next);
                reanalyze({ reference: next });
              }}
              onClearTrim={() => {
                setTrim(null);
                reanalyze({ trim: null });
              }}
              onClearReference={() => {
                const next: QcaReferenceMode = defaultReference;
                setRefMode(next);
                reanalyze({ reference: next });
              }}
            />
            </div>
          )}
        </div>

        {/* 保存（非破壊: GSPS ＝表示状態と描画 / SR ＝計測値）。fw/angio-design.md §14 */}
        <div style={section} data-step="save">
          <div style={sectionTitle}>{t("xa.analysis.save")}</div>
          <div style={row}>
            <button
              style={btn}
              data-testid="xa-save-gsps"
              disabled={saving || !saveContext.sopInstanceUid}
              onClick={savePresentationState}
            >
              {t("xa.analysis.saveGsps")}
            </button>
            <button
              style={btn}
              data-testid="xa-save-sr"
              disabled={saving || !result || !saveContext.sopInstanceUid}
              onClick={saveQca}
            >
              {t("xa.analysis.saveSr")}
            </button>
            {saved && <span style={hint}>{saved}</span>}
          </div>
          {/* 🔴 前に書いた SR があるときだけ聞く。毎回聞くと「保存」が 2 手になる。 */}
          {srChoice && savedAnalysis?.sr && (
            <div style={choiceBox} data-testid="xa-save-sr-choice">
              <div>{t("xa.analysis.srExists", { uid: shortUid(savedAnalysis.sr.sopInstanceUid) })}</div>
              <div style={{ ...row, marginTop: 6 }}>
                <button style={primaryBtn} data-testid="xa-save-sr-replace" onClick={() => doSaveQca(true)}>
                  {t("xa.analysis.srReplace")}
                </button>
                <button style={btn} data-testid="xa-save-sr-new" onClick={() => doSaveQca(false)}>
                  {t("xa.analysis.srNew")}
                </button>
                <button style={btn} data-testid="xa-save-sr-cancel" onClick={() => setSrChoice(false)}>
                  {t("common.cancel")}
                </button>
              </div>
              {/* 🚨 外へ送った後では取り返せない。上書きの前に必ず言う。 */}
              <div style={warnText}>{t("xa.analysis.srReplaceWarn")}</div>
            </div>
          )}
          <div style={hint}>{t("xa.analysis.saveHint")}</div>
        </div>

        {error && <div style={errorText}>{error}</div>}

        </div>
        <TaskStepRail steps={steps} onGo={goToStep} onRedo={redoFrom} />
        </div>

        <div style={{ ...row, justifyContent: "flex-end" }}>
          <button style={btn} data-testid="xa-dialog-close" onClick={onClose}>
            {t("common.close")}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * 結果の数値と径プロファイル（依存を増やさないため素の SVG）。
 *
 * <p>グラフ上のドラッグで**解析区間の切り詰め**と**参照径に使う健常部の指定**ができる
 * （`fw/angio-design.md` §8.6）。どちらも「自動の推定が外れたときに人が決め直す」ためのもの。
 */
function QcaReport({
  result,
  chartMode,
  trimmed,
  referenceMode,
  onChartModeChange,
  onSelectRange,
  onClearTrim,
  onClearReference,
  onHighlight,
  onReferenceRanges,
  maxDiameterIndex,
}: {
  result: QcaResult;
  /** 最大径の計測点（QVA）。null なら描かない。**表に出している値と同じ点**を受け取る。 */
  maxDiameterIndex?: number | null;
  chartMode: "none" | "trim" | "reference";
  trimmed: boolean;
  referenceMode: QcaReferenceMode;
  onChartModeChange: (m: "none" | "trim" | "reference") => void;
  onSelectRange: (from: number, to: number) => void;
  onClearTrim: () => void;
  onClearReference: () => void;
  onHighlight: (i: number | null) => void;
  /** 参照径に使う範囲を差し替える（帯の端を掴んで動かしたとき）。空なら自動へ戻す。 */
  onReferenceRanges: (ranges: [number, number][]) => void;
}) {
  const { t } = useI18n();
  const u = result.unit;
  // 「もっともらしく間違った結果」を拾う（純関数・`viewer/qcaInput.ts`）。
  const suspicions = useMemo(() => suspiciousQcaReasons(result), [result]);
  const w = 460;
  const h = 120;
  const pad = 4;
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragTo, setDragTo] = useState<number | null>(null);
  /**
   * 帯の端を掴んで動かしている最中の状態（2026-08-31）。
   *
   * <p>🔴 **掴んでいる間は画面の帯を先に動かす**（`preview`）。再解析はドラッグを離した
   * ときに 1 回だけ走らせる —— 途中で毎回走らせると、密度計測を含む重い計算が
   * ポインタ移動のたびに動き、画面が固まる。
   */
  const [edgeDrag, setEdgeDrag] = useState<{ range: number; side: 0 | 1 } | null>(null);
  const [preview, setPreview] = useState<[number, number][] | null>(null);

  const n = result.diameters.length;
  const maxD = Math.max(...result.diameters, ...result.reference) * 1.1 || 1;
  const maxP = result.positions[result.positions.length - 1] || 1;
  const px = (i: number) => pad + (result.positions[i] / maxP) * (w - pad * 2);
  const py = (v: number) => h - pad - (v / maxD) * (h - pad * 2);
  const line = (vals: number[]) => vals.map((v, i) => `${px(i)},${py(v)}`).join(" ");

  /** 画面 x → 計測点インデックス。 */
  const indexAt = (clientX: number): number => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return 0;
    const target = ((clientX - rect.left) / rect.width) * w;
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < n; i++) {
      const d = Math.abs(px(i) - target);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return best;
  };

  /**
   * いま参照径に使っている範囲（帯として描き、端を掴めるようにする）。
   *
   * <p>ドラッグ中は `preview` を優先する。それ以外は**解析結果が返した支持点**を使う
   * ——自動当てはめでも人の指定でも同じ見た目・同じ掴み方になる。
   */
  const supportRanges: [number, number][] = preview ?? toRanges(result.referenceSupport);
  /** 掴める距離 [SVG px]。 */
  const GRAB = 6;

  /** クリック位置に近い帯の端（無ければ null）。 */
  const grabEdgeAt = (clientX: number): { range: number; side: 0 | 1 } | null => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const target = ((clientX - rect.left) / rect.width) * w;
    let best: { range: number; side: 0 | 1 } | null = null;
    let bd = GRAB;
    supportRanges.forEach((r, ri) => {
      ([0, 1] as const).forEach((side) => {
        const d = Math.abs(px(r[side]) - target);
        if (d < bd) {
          bd = d;
          best = { range: ri, side };
        }
      });
    });
    return best;
  };

  /** 端を動かした結果の範囲列（つぶれた区間は消す＝幅 0 まで詰めれば削除になる）。 */
  const movedRanges = (drag: { range: number; side: 0 | 1 }, to: number): [number, number][] =>
    supportRanges
      .map((r, ri): [number, number] => {
        if (ri !== drag.range) return [r[0], r[1]];
        const next: [number, number] = drag.side === 0 ? [to, r[1]] : [r[0], to];
        return [Math.min(next[0], next[1]), Math.max(next[0], next[1])];
      })
      .filter((r) => r[1] > r[0]);

  const band = (from: number, to: number, fill: string, key: string) => {
    const a = Math.min(from, to);
    const b = Math.max(from, to);
    return <rect key={key} x={px(a)} y={pad} width={Math.max(1, px(b) - px(a))} height={h - pad * 2} fill={fill} />;
  };

  return (
    <div>
      <table style={table}>
        <tbody>
          <tr>
            <td style={th}>MLD</td>
            <td style={td}>
              {result.mld.toFixed(2)} {u}
            </td>
            <td style={th}>RVD</td>
            <td style={td}>
              {result.rvd.toFixed(2)} {u}
            </td>
          </tr>
          <tr>
            <td style={th}>% Diameter Stenosis</td>
            <td style={td}>{result.percentDiameterStenosis.toFixed(1)} %</td>
            <td style={th}>% Area Stenosis</td>
            <td style={td}>{result.percentAreaStenosis.toFixed(1)} %</td>
          </tr>
          <tr>
            <td style={th}>{t("xa.analysis.lesionLength")}</td>
            <td style={td}>
              {result.lesionLength.toFixed(2)} {u}
            </td>
            <td style={th}>{t("xa.analysis.points")}</td>
            <td style={td}>{result.diameters.length}</td>
          </tr>
        </tbody>
      </table>

      {/*
        🚨 **線と数値が別方式であることを黙って並べない**（§16.5 の 2）。
        密度計測は径を返すが輪郭を返さないので、画面の輪郭は常に半値法のまま。
        どちらで測ったかを出さないと、読む側は線と数値の食い違いを説明できない。
      */}
      <div style={hint} data-testid="xa-diameter-method" data-method={result.provenance.diameterMethod}>
        {t(`xa.analysis.method.${result.provenance.diameterMethod}`)}
        {result.provenance.densitometryFallback &&
          result.provenance.densitometryFallback !== "disabled" &&
          ` — ${t(`xa.analysis.densitometryFallback.${result.provenance.densitometryFallback}`)}`}
      </div>

      {/*
        🚨 **もっともらしく間違った結果を、正しい結果と同じ顔で出さない**（§8.7）。
        中心線はコスト最小経路なので、血管から外れていても「それらしい」経路を必ず引く。
        `MLD ≥ RVD` / サンプル点が極端に少ない / 病変長 0 は、**単独では正常値に見えるが
        組み合わせは異常**。実機では 3 つ同時に出たまま「解析できた」ように見えていた。
      */}
      {suspicions.length > 0 && (
        <div style={warn} data-testid="xa-qca-suspicious" data-reasons={suspicions.join(" ")}>
          {t("xa.analysis.suspicious")}
          <ul style={{ margin: "2px 0 0", paddingLeft: 16 }}>
            {suspicions.map((k) => (
              <li key={k}>{t(`xa.analysis.suspicious.${k}`)}</li>
            ))}
          </ul>
        </div>
      )}

      {/* グラフ上での手修正（区間の切り詰め・健常部の指定）。 */}
      <div style={row}>
        <span style={{ fontSize: 11, color: "#44586a" }}>{t("xa.qca.chartMode")}:</span>
        {(["none", "trim", "reference"] as const).map((m) => (
          <button
            key={m}
            style={chartMode === m ? primaryBtn : btn}
            data-testid={`xa-qca-chart-${m}`}
            onClick={() => onChartModeChange(m)}
          >
            {t(`xa.qca.chart.${m}`)}
          </button>
        ))}
        {trimmed && (
          <button style={btn} data-testid="xa-qca-clear-trim" onClick={onClearTrim}>
            {t("xa.qca.clearTrim")}
          </button>
        )}
        {referenceMode.kind !== "auto" && (
          <button style={btn} data-testid="xa-qca-clear-reference" onClick={onClearReference}>
            {t("xa.qca.clearReference")}
          </button>
        )}
      </div>

      <svg
        ref={svgRef}
        width={w}
        height={h}
        data-testid="xa-qca-chart"
        style={{
          background: "#0f1720",
          borderRadius: 4,
          cursor: chartMode === "none" ? "default" : "col-resize",
          touchAction: "none",
        }}
        onPointerDown={(e) => {
          if (chartMode === "none") return;
          e.currentTarget.setPointerCapture(e.pointerId);
          const i = indexAt(e.clientX);
          // 「健常部を指定」モードでは、まず**既存の帯の端を掴もうとする**。
          // 掴めなければ従来どおり新しい区間を引く（追加）。
          const grabbed = chartMode === "reference" ? grabEdgeAt(e.clientX) : null;
          if (grabbed) {
            setEdgeDrag(grabbed);
            setPreview(movedRanges(grabbed, i));
            return;
          }
          setDragFrom(i);
          setDragTo(i);
        }}
        onPointerMove={(e) => {
          const i = indexAt(e.clientX);
          onHighlight(i);
          if (edgeDrag) {
            setPreview(movedRanges(edgeDrag, i));
            return;
          }
          if (dragFrom != null) setDragTo(i);
        }}
        onPointerLeave={() => onHighlight(null)}
        onPointerUp={(e) => {
          e.currentTarget.releasePointerCapture(e.pointerId);
          if (edgeDrag) {
            const next = preview ?? supportRanges;
            setEdgeDrag(null);
            // 🔴 **プレビューはここで捨てる。** 残すと、再解析で支持点が変わっても
            //    画面が古い帯を出し続ける（人の指定なら一致するが、つぶれて自動へ戻した
            //    ときに食い違う）。
            setPreview(null);
            onReferenceRanges(next.map((r): [number, number] => [r[0], r[1]]));
            return;
          }
          if (dragFrom != null && dragTo != null && dragFrom !== dragTo) {
            onSelectRange(Math.min(dragFrom, dragTo), Math.max(dragFrom, dragTo));
          }
          setDragFrom(null);
          setDragTo(null);
        }}
      >
        {/*
          🔴 **参照径をどの点から決めたか**を帯で出す（2026-08-31・利用者の要望）。
          人が指定した区間も、自動当てはめが健常として残した点も、**同じ帯**で表す
          ——利用者にとっての問いは「どこを測ったか」であって、決め方の分類ではない。
        */}
        {supportRanges.map((r, i) => band(r[0], r[1], "rgba(109,139,168,0.28)", `ref-${i}`))}
        {/*
          帯の端の掴み手。**「健常部を指定」モードのときだけ**出す
          ——いつでも出ていると「掴めそうなのに掴めない」線になる。
        */}
        {chartMode === "reference" &&
          supportRanges.flatMap((r, ri) =>
            ([0, 1] as const).map((side) => (
              <line
                key={`grab-${ri}-${side}`}
                x1={px(r[side])}
                x2={px(r[side])}
                y1={pad}
                y2={h - pad}
                stroke="#6d8ba8"
                strokeWidth={edgeDrag?.range === ri && edgeDrag?.side === side ? 3 : 1.5}
              />
            )),
          )}
        {dragFrom != null && dragTo != null && band(dragFrom, dragTo, "rgba(255,209,102,0.25)", "drag")}
        <polyline points={line(result.reference)} fill="none" stroke="#6d8ba8" strokeDasharray="4 3" />
        <polyline points={line(result.diameters)} fill="none" stroke="#7fd1b9" strokeWidth={1.5} />
        {result.provenance.editedEdges.map((i) => (
          <circle key={`e-${i}`} cx={px(i)} cy={py(result.diameters[i])} r={2} fill="#ffd166" />
        ))}
        <circle cx={px(result.mldIndex)} cy={py(result.mld)} r={3} fill="#e07a5f" />
        {/* 最大径（QVA）。画像・ストレート像と**同じ色**にして、3 つの絵で同じ点を指す。 */}
        {maxDiameterIndex != null && result.diameters[maxDiameterIndex] != null && (
          <circle
            cx={px(maxDiameterIndex)}
            cy={py(result.diameters[maxDiameterIndex])}
            r={3}
            fill="#c792ea"
          />
        )}
      </svg>
      <div style={hint}>
        {chartMode === "trim"
          ? t("xa.qca.hintTrim")
          : chartMode === "reference"
            ? t("xa.qca.hintReference")
            : t("xa.analysis.chartHint", { unit: u })}
      </div>
      <div style={hint}>{t("xa.analysis.areaCaveat")}</div>
      {/* 手が入っているなら**必ず**表示する。自動値と同じ顔をさせない（保存物にも入る）。 */}
      {result.provenance.edited && (
        <div style={warn} data-testid="xa-qca-manual-badge">
          {t("xa.qca.manualBadge", {
            waypoints: String(result.provenance.waypoints),
            edges: String(result.provenance.editedEdges.length),
            trim: result.provenance.trimmed ? t("xa.qca.yes") : t("xa.qca.no"),
            reference: t(`xa.qca.refKind.${result.provenance.reference}`),
          })}
        </div>
      )}
      {result.warnings.includes("uncalibrated") && <div style={warn}>{t("xa.analysis.uncalibratedWarn")}</div>}
    </div>
  );
}

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
  minWidth: 520,
  maxHeight: "86vh",
  // 中身（節の列）だけをスクロールさせ、**レールは常に見えている**ようにする。
  // パネル全体をスクロールさせると、段の一覧が画面外に出て意味を成さない。
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
  boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
};
/** 節の列 ＋ ステップ・レールの横並び。 */
const body: React.CSSProperties = { display: "flex", gap: 10, minHeight: 0, flex: 1 };
/** 節の列（ここだけスクロールする）。`minWidth:0` が無いと flex 子が縮まない。 */
const content: React.CSSProperties = { flex: 1, minWidth: 0, overflowY: "auto", paddingRight: 2 };
const title: React.CSSProperties = { fontWeight: 600, fontSize: 15, marginBottom: 10 };
const section: React.CSSProperties = {
  border: "1px solid #d5dde4",
  borderRadius: 4,
  padding: 10,
  marginBottom: 10,
};
const sectionTitle: React.CSSProperties = { fontSize: 12, fontWeight: 600, marginBottom: 6, color: "#44586a" };
const row: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, marginTop: 6, flexWrap: "wrap" };
const label: React.CSSProperties = { display: "flex", alignItems: "center", gap: 4, fontSize: 12 };
const input: React.CSSProperties = { width: 70, padding: "2px 4px", border: "1px solid #c3ced9", borderRadius: 3 };
const select: React.CSSProperties = { padding: "2px 4px", border: "1px solid #c3ced9", borderRadius: 3 };
const btn: React.CSSProperties = {
  padding: "3px 10px",
  background: "#e6ecf1",
  borderWidth: "1px",
  borderStyle: "solid",
  borderColor: "#c3ced9",
  borderRadius: 4,
  cursor: "pointer",
};
const primaryBtn: React.CSSProperties = { ...btn, background: "#2f6f9f", color: "#fff", borderColor: "#2a6088" };
const hint: React.CSSProperties = { fontSize: 11, color: "#66788a", marginTop: 4 };
const choiceBox: React.CSSProperties = {
  marginTop: 6,
  padding: 8,
  border: "1px solid #d9c08a",
  borderRadius: 4,
  background: "#fdf7e6",
  fontSize: 11,
  color: "#5c4a1e",
};
const warnText: React.CSSProperties = { fontSize: 11, color: "#a5642a", marginTop: 6 };
const restoredBox: React.CSSProperties = {
  fontSize: 11,
  color: "#2f6f4f",
  background: "#eaf6ef",
  border: "1px solid #bfe0cd",
  borderRadius: 4,
  padding: "4px 6px",
  marginBottom: 4,
};
const warn: React.CSSProperties = { fontSize: 11, color: "#a5642a", marginTop: 4 };
const errorText: React.CSSProperties = { fontSize: 12, color: "#b3452f", marginBottom: 8 };
const table: React.CSSProperties = { fontSize: 12, borderCollapse: "collapse", marginBottom: 8 };
const th: React.CSSProperties = { textAlign: "left", padding: "2px 10px 2px 0", color: "#66788a" };
const td: React.CSSProperties = { textAlign: "right", padding: "2px 16px 2px 0", fontVariantNumeric: "tabular-nums" };
