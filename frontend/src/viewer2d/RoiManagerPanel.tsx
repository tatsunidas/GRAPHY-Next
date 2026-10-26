/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * ROI マネージャ（右サイドパネル, M1）。
 *
 * 2 つの区画に分ける。
 *  - ROI: 保存形式によらず 1 件 1 行。形の ROI（annotation の面積・線・点）、塗りの ROI
 *    （labelmap の segment 1 つにつき 1 行）、パラメトリック球。行モデルは `viewer/roiRows.ts`。
 *  - 計測: 長さ・角度・プローブなど（ROI ではない）。
 * 設計: `fw/roi-manager-design.md` / `fw/roi-mask-model.md` §10。
 */
import { selectRois, toggleRoiSelection } from "../viewer/roiInteriorGrab";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { eventTarget, getRenderingEngine, Enums as csEnums } from "@cornerstonejs/core";
import {
  annotation as csAnnotation,
  segmentation as csSeg,
  Enums as csToolsEnums,
} from "@cornerstonejs/tools";
import { ENGINE_ID } from "../viewer/Viewer2D";
import { formatScope, getRoiMaskMeta, setRoiMaskMeta, deleteRoiMaskMeta, subscribeRoiMaskStore, getSegEditTarget, getMaskSegments } from "../viewer/roiMaskStore";
import { createNewMask, activateMask, getLastSegViewport, getSegmentVisible, setSegmentVisible, removeMaskSegment } from "../viewer/segmentation";
import { fetchSettings } from "../settings/settingsApi";
import { exportMaskAsSeg } from "../viewer/segExport";
import { canConvertMeasureToRoi } from "../viewer/measureToRoi";
import { exportRoisAsRtStruct } from "../viewer/rtstructExport";
import { importRtStructForCurrentView } from "../viewer/rtstructImport";
import { importSegForCurrentView } from "../viewer/segImport";
import { LoadingSpinner } from "../viewer/LoadingSpinner";
import { emitToast } from "../viewer/toast";
import { isRoiLocked, setRoiLocked } from "../viewer/roiLock";
import { emitSeriesRefresh } from "../viewer/viewerRefresh";
import { emitDbChanged } from "../dbEvents";
import { combineRois, splitMask, roiToMask, withTempMask, isAreaRoi, resolveRoiStack, type BoolOp, type RoiOperand, type SplitConnectivity } from "../viewer/roiBooleanOps";
import { nextGroupNumber, planGroup } from "../viewer/roiGroups";
import { buildRoiPanelModel, type MeasureRow, type PaintedRoiRow, type RoiPanelModel, type RoiRow, type RoiRowEnv, type RowOwner, type ShapeRoiRow, type SphereRoiRow } from "../viewer/roiRows";
import { sphereFromCircleRoi, createSphere3DFromCircleRoi, bakeSphere3D, splitMaskToSlices, maskVolumeStats, type MaskVolumeStats } from "../viewer/roi3d";
import { listSpheres3D, updateSphere3D, deleteSphere3D, subscribeSphere3D, type Sphere3D } from "../viewer/sphere3dStore";
import { annotationsToImageJDtos } from "../viewer/imagejExport";
import { importImageJDtos } from "../viewer/imagejImport";
import { exportImageJRoiSet, importImageJRoiSet } from "../api";
import { saveRoiNow, scheduleRoiSave, subscribeRoiSave } from "../viewer/roiSaveStore";
import { RoiMetaEditDialog } from "./RoiMetaEditDialog";
import { RoiStatsDialog, type RoiStatsTarget } from "./RoiStatsDialog";
import { useI18n } from "../i18n/i18n";
import { useDateFormat, formatClockTime } from "../i18n/dateFormat";
import { useFusionMeasure } from "../viewer/fusionMeasureContext";
import { NumField } from "./WandDialog";
import { formatNumber, valueUnitLabel } from "../viewer/roiStatsText";
import { meanTimesVolumeLabelKey } from "../viewer/maskStatsCore";

const LABELMAP = csToolsEnums.SegmentationRepresentations.Labelmap;

/** 全ビューポートを再描画（スタイル変更の即時反映）。 */
function renderAll(): void {
  try { getRenderingEngine(ENGINE_ID)?.render(); } catch { /* ignore */ }
}

/** #rrggbb → "rgb(r,g,b)"。 */
function hexToRgb(hex: string): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return "rgb(255,255,0)";
  return `rgb(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)})`;
}

/** 塗りの ROI の統計・演算が対象にする segment。segment が 1 つだけなら行＝マスク全体（従来どおり非ゼロすべて）。 */
function segFilterOf(r: Pick<PaintedRoiRow, "single" | "segIndex">): number | undefined {
  return r.single ? undefined : r.segIndex;
}

/** scope メタ → 表示文字列（1 始まり）。 */
function scopeText(itemId: string): string {
  return formatScope(getRoiMaskMeta(itemId)?.scope);
}

/** ROI マネージャが一覧に出す、画面上のシリーズ（タイル）。 */
export interface PanelSeries {
  patientKey: string;
  patientName: string;
  seriesUid: string;
  /** 見出しに出すシリーズの名前。 */
  label: string;
}

/** 一覧の見出しの鍵。患者 `p:<患者>`、シリーズ `s:<患者>|<シリーズ>`。 */
const patientSec = (pk: string) => `p:${pk}`;
const groupSec = (groupId: string) => `g:${groupId}`;
const seriesSec = (pk: string, uid: string) => `s:${pk}|${uid}`;
function inSection(o: RowOwner, sec: string): boolean {
  if (sec.startsWith("g:")) return !!o.groupId && o.groupId === sec.slice(2);
  if (sec.startsWith("p:")) return o.patientKey === sec.slice(2);
  return !!o.patientKey && !!o.seriesUid && seriesSec(o.patientKey, o.seriesUid) === sec;
}

export function RoiManagerPanel({
  activePatientKey,
  shownSeries,
  isDemo,
  mode,
  onRevealRoi,
  onDuplicateRoi,
  onCopyRoi,
  onConvertToRoi,
  onClose,
}: {
  activePatientKey: string;
  /**
   * 画面に出ているシリーズ。あれば、このシリーズに属する ROI だけを患者→シリーズの見出しで並べる
   * （全患者表示）。無ければ `activePatientKey` の患者だけを、見出し無しで出す。
   */
  shownSeries?: ReadonlyArray<PanelSeries>;
  /** 公開デモ（backendが該当APIを403にする）。IJインポート/IJ・RTエクスポートを隠す。 */
  isDemo: boolean;
  /** `AppStatus.mode`（"standalone"/"web"）。SEG 再書き出し時の旧シリーズ自動削除の可否判定に使う。 */
  mode?: string;
  /** 行を選んだとき: その ROI をハイライトし、乗っているスライスへ表示を移す。 */
  onRevealRoi?: (roiUid: string) => void;
  /** ROI を複製する（貼り付け先は現在表示中のスライス）。 */
  onDuplicateRoi?: (roiUid: string) => void;
  /** ROI をコピーする（貼り付けは対象タイルを選んでから）。 */
  onCopyRoi?: (roiUid: string) => void;
  /** 計測（Length / Probe）を ROI に変える。 */
  onConvertToRoi?: (roiUid: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  useDateFormat(); // 書式の設定が変わったら再描画する
  const fusionMeasure = useFusionMeasure();
  const [model, setModel] = useState<RoiPanelModel>({ rois: [], measures: [] });
  const [editId, setEditId] = useState<string | null>(null);
  // 計測結果ダイアログ。null=閉。{focus} は開いた直後に詳細を出す ROI（ヘッダから開くと未指定）。
  // section は一覧の見出し（患者 `p:<患者>` / シリーズ `s:<患者>|<シリーズ>`）。指定があればその見出し配下の ROI だけを集計する。
  const [statsOpen, setStatsOpen] = useState<{ focus?: string; section?: string } | null>(null);
  // ⚠ ダイアログの `targets` は毎レンダで作り直さない。参照が変わるたびに統計の再計算
  // （非同期ループ）が最初からやり直しになり、表がちらつく。保存通知などで
  // このパネルは頻繁に再レンダされる。
  const statsTargets = useMemo<RoiStatsTarget[]>(
    () => {
      const sec = statsOpen?.section;
      const inSec = (o: RowOwner) => !sec || inSection(o, sec);
      const roiTargets: RoiStatsTarget[] = [];
      for (const r of model.rois) {
        if (!inSec(r)) continue;
        if (r.rowKind === "shape") roiTargets.push({ uid: r.uid, tool: r.tool });
        // 塗りの ROI は segment ごとに 1 件。uid は一意にし、マスクと segment は別フィールドで持つ（文字列を分解しない）。
        else if (r.rowKind === "painted") {
          roiTargets.push({ uid: r.key, tool: "mask", kind: "mask", label: r.name, maskId: r.maskId, segmentIndex: segFilterOf(r) });
        }
      }
      return [...roiTargets, ...model.measures.filter(inSec).map((m) => ({ uid: m.uid, tool: m.tool }))];
    },
    [model, statsOpen?.section],
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /** 一覧で選んでいる ROI（ハイライト＋スライス移動の対象）。マスクの選択チェックとは別物。 */
  const [focusedRoi, setFocusedRoi] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // SEG⬆ インポートの進捗率（0〜1）。null は非実行中（SEG⬆ ボタンの円形プログレス表示に使う）。
  const [segImportProgress, setSegImportProgress] = useState<number | null>(null);
  const [stats, setStats] = useState<Record<string, MaskVolumeStats>>({});
  const [spheres, setSpheres] = useState<Sphere3D[]>([]);
  // Split の 3D 連結性（6=面/18=面+辺/26=全て）。既定 26＝斜め接続もつなぎ過分割を抑える。
  const [splitConn, setSplitConn] = useState<SplitConnectivity>(26);
  // マスク行の初期値（環境設定 viewer.maskFillOpacity / maskOutlineWidth に追従）。
  const [maskDefaults, setMaskDefaults] = useState({ fillOpacity: 0.5, outlineWidth: 1 });
  useEffect(() => {
    fetchSettings()
      .then((m) => {
        const op = Number(m["viewer.maskFillOpacity"]);
        const ow = Number(m["viewer.maskOutlineWidth"]);
        setMaskDefaults({
          fillOpacity: Number.isFinite(op) ? Math.min(1, Math.max(0, op / 100)) : 0.5,
          outlineWidth: Number.isFinite(ow) ? ow : 1,
        });
      })
      .catch(() => {
        /* 既定のまま */
      });
  }, []);
  const importInputRef = useRef<HTMLInputElement>(null);

  // 画面に出ているシリーズ。参照が毎回変わっても再計算しないよう、中身の文字列をキーにする。
  const shownKey = (shownSeries ?? []).map((x) => `${x.patientKey}\u0001${x.seriesUid}`).join("\u0000");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const shown = useMemo(() => (shownSeries ? shownSeries.map((x) => ({ patientKey: x.patientKey, seriesUid: x.seriesUid })) : undefined), [shownKey]);
  // 保存・購読の対象にする患者（全患者表示なら表示中の全員。そうでなければフォーカス患者だけ）。
  const shownPatients = useMemo(() => (shown ? [...new Set(shown.map((x) => x.patientKey))] : [activePatientKey]), [shown, activePatientKey]);
  // Cornerstone で選択中の ROI（行のハイライトに使う）。パネルの focusedRoi とは別に、画像上・Ctrl クリックでの選択も映す。
  const [selUids, setSelUids] = useState<ReadonlySet<string>>(new Set());
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const sync = () => {
      try { setSelUids(new Set(csAnnotation.selection.getAnnotationsSelected() ?? [])); } catch { /* ignore */ }
    };
    sync();
    const ev = csToolsEnums.Events.ANNOTATION_SELECTION_CHANGE;
    if (!ev) return;
    eventTarget.addEventListener(ev, sync);
    return () => eventTarget.removeEventListener(ev, sync);
  }, []);

  // ROI の明示保存（自動保存は Viewer2DScreen が変更契機で走らせる）。
  // 最終保存の時刻・件数を出して「本当に書けたか」を人が確認できるようにする。
  const [saving, setSaving] = useState(false);
  const [lastSave, setLastSave] = useState<{ ok: boolean; at: string; count?: number; error?: string } | null>(null);
  useEffect(() => subscribeRoiSave((pk, r) => {
    if (!shownPatients.includes(pk)) return;
    setLastSave({
      ok: r.ok,
      at: formatClockTime(new Date(), { seconds: true }),
      count: r.roiCount,
      error: r.error,
    });
  }), [shownPatients]);
  const runSaveRois = async () => {
    setSaving(true);
    try {
      await Promise.all(shownPatients.map((pk) => saveRoiNow(pk)));
    } finally {
      setSaving(false);
    }
  };
  const saveTitle = lastSave
    ? lastSave.ok
      ? `${t("roiMgr.save")} — ${t("roiMgr.saved")} ${lastSave.at} (${lastSave.count ?? 0})`
      : `${t("roiMgr.save")} — ${t("roiMgr.saveFailed")}: ${lastSave.error ?? ""}`
    : t("roiMgr.save");

  const refresh = useCallback(() => {
    const env: RoiRowEnv = {
      patientKey: activePatientKey,
      shown,
      metaOf: getRoiMaskMeta,
      isAnnotationVisible: (uid) => csAnnotation.visibility.isAnnotationVisible(uid) ?? true,
      isLocked: isRoiLocked,
      scopeText,
      isSegmentVisible: getSegmentVisible,
    };
    const allSpheres = listSpheres3D();
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const anns = csAnnotation.state.getAllAnnotations() as any[];
      let segs: Array<{ segmentationId: string; label?: string }> = [];
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        segs = ((csSeg.state.getSegmentations() as any[]) ?? []).map((x) => ({ segmentationId: x.segmentationId as string, label: x.label as string | undefined }));
      } catch {
        /* マスクが読めなくても形の ROI は出す */
      }
      setModel(buildRoiPanelModel(anns, segs, allSpheres, env, getMaskSegments));
    } catch {
      setModel({ rois: [], measures: [] });
    }
    setSpheres(allSpheres);
  }, [activePatientKey, shown]);

  useEffect(() => {
    refresh();
    const ev = csToolsEnums.Events;
    const names = [
      ev.ANNOTATION_ADDED,
      ev.ANNOTATION_REMOVED,
      ev.ANNOTATION_MODIFIED,
      ev.ANNOTATION_LOCK_CHANGE,
      ev.ANNOTATION_VISIBILITY_CHANGE,
      ev.SEGMENTATION_MODIFIED,
      ev.SEGMENTATION_REMOVED,
      csEnums.Events.STACK_NEW_IMAGE,
    ].filter(Boolean) as string[];
    for (const n of names) eventTarget.addEventListener(n, refresh);
    const unsub = subscribeRoiMaskStore(refresh);
    const unsubSphere = subscribeSphere3D(refresh);
    return () => {
      unsubSphere();
      for (const n of names) eventTarget.removeEventListener(n, refresh);
      unsub();
    };
  }, [refresh]);

  const deleteRoi = (uid: string) => {
    if (isRoiLocked(uid)) return;
    // 全患者表示では、消す ROI の持ち主の患者へ保存を予約する（フォーカス患者とは限らない）。
    const owner = getRoiMaskMeta(uid)?.patientKey || activePatientKey;
    try { csAnnotation.state.removeAnnotation(uid); } catch { /* ignore */ }
    deleteRoiMaskMeta(uid);
    // 削除も保存対象。イベント購読でも拾えるが、経路ごとの発火差に依存しないよう明示的に予約する。
    scheduleRoiSave(owner);
    refresh();
  };
  // マスク色: そのセグメンテーションを表示中の全ビューポートで、対象 segment の色を変更。
  // アクティブマスクなら**アクティブ segment**、それ以外は segment 1 を対象にする（多セグメント D3）。
  const setMaskColor = (id: string, hex: string, segIndex?: number) => {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
    if (!m) return;
    const color: [number, number, number, number] = [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16), 255];
    const idx = segIndex ?? (getSegEditTarget().segmentationId === id ? getSegEditTarget().segmentIndex : 1);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const vps = (csSeg.state as any).getViewportIdsWithSegmentation(id) as string[] | undefined;
      for (const vpId of vps ?? []) {
        try { csSeg.config.color.setSegmentIndexColor(vpId, id, idx, color); } catch { /* ignore */ }
      }
      renderAll();
    } catch {
      /* ignore */
    }
  };
  // 指定 segment の現在色（#rrggbb）。segment チップの色表示用。
  const segColorHex = (id: string, idx: number): string | null => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const vps = (csSeg.state as any).getViewportIdsWithSegmentation(id) as string[] | undefined;
      const vp = vps?.[0];
      if (!vp) return null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const c = (csSeg.config.color as any).getSegmentIndexColor(vp, id, idx) as number[] | undefined;
      if (!c || c.length < 3) return null;
      return `#${[c[0], c[1], c[2]].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
    } catch {
      return null;
    }
  };
  const toggleRoiLock = (uid: string, locked: boolean) => {
    setRoiLocked(uid, locked);
    refresh();
  };
  const toggleRoi = (uid: string, vis: boolean) => {
    try { csAnnotation.visibility.setAnnotationVisibility(uid, vis); } catch { /* ignore */ }
    // 上流は表示の切り替えで再描画しない。選択中の ROI は選択解除の副作用で再描画されて動いて見えるだけ。
    renderAll();
    refresh();
  };
  // scope の Z を global("all") ↔ local(原本 index) でトグル。
  const toggleScopeZ = (itemId: string) => {
    const meta = getRoiMaskMeta(itemId);
    const cur = meta?.scope ?? {};
    const base = meta?.origin ?? cur;
    setRoiMaskMeta(itemId, { scope: { ...cur, z: cur.z === "all" ? (base.z ?? 0) : "all" } });
  };
  // 塗りの ROI（segment 1 つ）を削除。最後の 1 つなら（removeMaskSegment が）マスクごと消す。
  const deletePainted = (r: PaintedRoiRow) => {
    if (!window.confirm(t(r.single ? "roiMgr.deleteMaskConfirm" : "roiMgr.deleteSegmentConfirm"))) return;
    removeMaskSegment(r.maskId, r.segIndex);
    setSelected((s) => { const n = new Set(s); n.delete(r.key); return n; });
    renderAll();
    refresh();
  };

  // ── アクティブ編集対象（D2: モードレス）──
  // 「＋新規 ROI（塗り）」= 直近でセグメンテーションツールを使ったタイルに新規マスク（segment 1）を作成しアクティブ化。
  const addNewPainted = async () => {
    const vp = getLastSegViewport();
    if (!vp) { window.alert(t("roiMgr.needSegViewport")); return; }
    setBusy(true);
    try { await createNewMask(vp.viewportId, vp.imageIds); } finally { setBusy(false); }
    refresh();
  };
  const toggleSelect = (id: string) =>
    setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  // 演算結果を表示するビューポート: 選択 ROI を表示中のもの（union）。無ければエンジン全 viewport。
  // 形の ROI は、その ROI を載せているスタックのビューポート。
  const viewportsForOperands = (ops: RoiOperand[]): string[] => {
    const set = new Set<string>();
    for (const o of ops) {
      try {
        if (o.kind === "painted") {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          for (const vp of ((csSeg.state as any).getViewportIdsWithSegmentation(o.maskId) as string[] | undefined) ?? []) set.add(vp);
        } else {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const ref = (csAnnotation.state as any).getAnnotation(o.uid)?.metadata?.referencedImageId as string | undefined;
          for (const vp of (ref ? resolveRoiStack(ref)?.viewportIds : undefined) ?? []) set.add(vp);
        }
      } catch { /* ignore */ }
    }
    if (set.size === 0) {
      try { for (const vp of getRenderingEngine(ENGINE_ID)?.getViewports() ?? []) set.add(vp.id); } catch { /* ignore */ }
    }
    return [...set];
  };
  // 選択行 → 演算の入力。球は対象外。
  const focusRois = useMemo(
    () => model.rois.filter((r) => !r.patientKey || r.patientKey === activePatientKey),
    [model, activePatientKey],
  );
  const selectedRows = model.rois.filter((r) => selected.has(r.key) && r.rowKind !== "sphere");
  const operands: RoiOperand[] = selectedRows.map((r) =>
    r.rowKind === "painted" ? { kind: "painted", maskId: r.maskId, segIndex: segFilterOf(r) } : { kind: "shape", uid: (r as { uid: string }).uid },
  );
  // ブール演算（or/and/xor/merge）。merge=OR。選択 2 件以上で実行。形の ROI は一時的にラスタ化して計算し、結果だけを残す。
  const runCombine = async (op: BoolOp) => {
    if (operands.length < 2 || busy) return;
    setBusy(true);
    try {
      const res = await combineRois(operands, op, viewportsForOperands(operands));
      if (!res) window.alert(t("roiMgr.opFailed"));
    } finally {
      setBusy(false);
      refresh();
    }
  };
  // ベクタ ROI（エリア型）をラスタ化して新規 Mask に変換（→ 以後 Mask 演算の対象に）。
  const runRoiToMask = async (uid: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await roiToMask(uid);
      if (!res) window.alert(t("roiMgr.opFailed"));
    } finally {
      setBusy(false);
      refresh();
    }
  };
  // 円 ROI → 3D 球 Mask（即ラスタ化, GRAPHY SphereRoi3D→mask 相当）。
  const runSphere = async (uid: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await sphereFromCircleRoi(uid);
      if (!res) window.alert(t("roiMgr.opFailed"));
    } finally {
      setBusy(false);
      refresh();
    }
  };
  // 円 ROI → パラメトリック 3D 球（保持＋全スライスライブプレビュー）。
  const runDefineSphere = (uid: string) => {
    if (!createSphere3DFromCircleRoi(uid)) window.alert(t("roiMgr.opFailed"));
  };
  // パラメトリック球を Mask に焼き込み。
  const runBakeSphere = async (id: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await bakeSphere3D(id);
      if (!res) window.alert(t("roiMgr.opFailed"));
    } finally {
      setBusy(false);
      refresh();
    }
  };
  // 3D→2D split: ボリュームの塗り ROI を非空スライスごとの単一スライスの塗り ROI に分解（segment 指定ならその segment のみ）。
  const runSplitToSlices = async (r: PaintedRoiRow) => {
    if (busy) return;
    setBusy(true);
    try {
      const created = await splitMaskToSlices(r.maskId, segFilterOf(r));
      if (created.length === 0) window.alert(t("roiMgr.opFailed"));
    } finally {
      setBusy(false);
      refresh();
    }
  };
  // ROI 群を ImageJ RoiSet.zip として書き出し（保存優先=ImageJ）。
  const runExportRois = async () => {
    if (busy) return;
    const dtos = annotationsToImageJDtos(annotationUids);
    if (dtos.length === 0) { window.alert(t("roiMgr.exportEmpty")); return; }
    setBusy(true);
    try {
      const { blob, filename } = await exportImageJRoiSet(dtos);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      window.alert(t("roiMgr.opFailed"));
    } finally {
      setBusy(false);
    }
  };
  // ROI（形・塗り）を DICOM RTSTRUCT として保存（新シリーズ）。`only` を渡すとその塗りの ROI 1 件だけ。
  // 計測は書き出さない（exportRoisAsRtStruct 側でも除外）。
  const runExportRtStruct = async (only?: PaintedRoiRow) => {
    if (busy) return;
    setBusy(true);
    try {
      const shapeUids = only ? [] : focusRois.flatMap((r) => (r.rowKind === "shape" ? [r.uid] : []));
      const maskRefs = (only ? [only] : focusRois.filter((r): r is PaintedRoiRow => r.rowKind === "painted"))
        .map((r) => ({ maskId: r.maskId, segIndex: segFilterOf(r) }));
      const res = await exportRoisAsRtStruct(shapeUids, maskRefs);
      if (res) {
        emitToast(t("roiMgr.exportRtDone"));
        emitSeriesRefresh();
        // 他ウィンドウ（メイン画面の検索リスト等）へ新規シリーズ発生を通知（CPR/中心線解析/Slicer と同様）。
        const studyUids = [...new Set(
          [...shapeUids, ...maskRefs.map((m) => m.maskId)]
            .map((id) => getRoiMaskMeta(id)?.scope?.studyUid)
            .filter((v): v is string => !!v),
        )];
        emitDbChanged({ reason: "series-create", studyUids });
      } else window.alert(t("roiMgr.exportRtFail"));
    } catch {
      window.alert(t("roiMgr.exportRtFail"));
    } finally {
      setBusy(false);
    }
  };
  // 表示中スタディの RTSTRUCT を読み込み、表示中シリーズへ ROI を復元。
  const runImportRtStruct = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const { structureCount, skippedNotClosed, skippedNoSlice } = await importRtStructForCurrentView();
      if (structureCount === 0) window.alert(t("roiMgr.importRtEmpty"));
      else {
        const skipped = skippedNotClosed + skippedNoSlice;
        emitToast(
          t("roiMgr.importRtDone", { n: structureCount }) +
            (skipped > 0 ? t("roiMgr.importRtSkipped", { open: skippedNotClosed, nosop: skippedNoSlice }) : ""),
        );
      }
    } catch {
      window.alert(t("roiMgr.opFailed"));
    } finally {
      setBusy(false);
      refresh();
    }
  };
  // 表示中スタディの SEG を読み込み、表示中シリーズへ Mask を復元。
  const runImportSeg = async () => {
    if (busy) return;
    setBusy(true);
    setSegImportProgress(0);
    try {
      const n = await importSegForCurrentView((frac) => setSegImportProgress(frac));
      if (n === 0) window.alert(t("roiMgr.importSegEmpty"));
      else emitToast(t("roiMgr.importSegDone", { n }));
    } catch {
      window.alert(t("roiMgr.opFailed"));
    } finally {
      setBusy(false);
      setSegImportProgress(null);
      refresh();
    }
  };
  // ImageJ .roi/.zip をインポートして Cornerstone ROI に復元。
  const runImportRois = async (file: File) => {
    if (busy) return;
    setBusy(true);
    try {
      const dtos = await importImageJRoiSet(file);
      const n = importImageJDtos(dtos);
      if (n === 0) window.alert(t("roiMgr.importEmpty"));
    } catch {
      window.alert(t("roiMgr.opFailed"));
    } finally {
      setBusy(false);
      refresh();
    }
  };
  // 塗りの ROI の体積統計（行下にインライン表示。再クリックで消す）。segment 指定ならその segment のみ。
  const runStats = (r: PaintedRoiRow) => {
    setStats((s) => {
      const n = { ...s };
      if (n[r.key]) { delete n[r.key]; return n; }
      const v = maskVolumeStats(r.maskId, segFilterOf(r));
      if (v) {
        n[r.key] = v;
        // Volumetry 結果をメタへ持ち回す（SEG エクスポート時の SegmentDescription 生成にも利用）。
        // マスクに複数 segment があるとき 1 つの segment の体積をマスク全体のメタに書くと誤るので、行＝マスク全体のときだけ。
        if (r.single && v.volumeMl !== undefined) setRoiMaskMeta(r.maskId, { custom: { volumeMl: v.volumeMl.toFixed(2), volumeComputedAt: new Date().toISOString() } });
      }
      return n;
    });
  };
  // マスク → DICOM SEG 書き出し（新シリーズとして DB 保存）。同じマスクを再度書き出すと、
  // standalone なら直前のエクスポート先シリーズを自動削除し「更新」相当にする（exportMaskAsSeg 参照）。
  // `shape` があれば、その形の ROI を一時的に塗りへ変えて書き出す。SEG の名前は行と同じ。
  // 2 回目以降の置き換えに使う記録は形の ROI に残す（一時の塗りは毎回作り直すため）。
  const runExportSeg = async (id: string, shape?: { uid: string; tool: string }) => {
    const shapeUid = shape?.uid;
    if (busy) return;
    setBusy(true);
    try {
      const res = shapeUid
        ? await withTempMask(shape.uid, async (tmp) => {
            const m = getRoiMaskMeta(shapeUid);
            setRoiMaskMeta(tmp, { label: m?.label || shape.tool, lastSegExport: m?.lastSegExport });
            const r = await exportMaskAsSeg(tmp, { mode });
            if (r.ok) setRoiMaskMeta(shapeUid, { lastSegExport: getRoiMaskMeta(tmp)?.lastSegExport });
            return r;
          }) ?? { ok: false as const, reason: "noMask" as const }
        : await exportMaskAsSeg(id, { mode });
      if (res.ok) {
        emitToast(res.replacedPrevious ? t("roiMgr.exportSegUpdated") : t("roiMgr.exportSegDone"));
        emitSeriesRefresh(); // 2D Viewer の検索ツリーを再取得（新 SEG シリーズを出す）。
        // 他ウィンドウ（メイン画面の検索リスト等）へ新規シリーズ発生を通知（CPR/中心線解析/Slicer と同様）。
        // これが無いと、実際は保存されているのにメイン画面の検索結果には反映されず「保存されていない」
        // ように見えるバグになる（実機報告により判明）。
        const studyUid = getRoiMaskMeta(shapeUid ?? id)?.scope?.studyUid;
        emitDbChanged({ reason: "series-create", studyUids: studyUid ? [studyUid] : undefined });
      } else if (res.reason === "empty") {
        window.alert(t("roiMgr.exportSegEmpty"));
      } else {
        window.alert(t("roiMgr.exportSegFail"));
      }
    } catch {
      window.alert(t("roiMgr.exportSegFail"));
    } finally {
      setBusy(false);
    }
  };
  // SPLIT（連結成分分割）。選んだ塗りの ROI 1 件で実行。
  // 元の ROI（その segment）を構成成分（segment 1..N）の新規 ROI で**置換**する（元を残すと同一位置で重なり、
  // 下の ROI が消せない・操作できない混乱を招くため）。元が最後の segment ならマスクごと消え、結果をアクティブ化。
  const runSplit = async () => {
    if (selectedRows.length !== 1 || busy) return;
    const r = selectedRows[0];
    if (r.rowKind !== "painted") { window.alert(t("roiMgr.opNeedPainted")); return; }
    setBusy(true);
    try {
      const res = await splitMask(r.maskId, viewportsForOperands(operands), splitConn, segFilterOf(r));
      if (!res) { window.alert(t("roiMgr.opFailed")); return; }
      removeMaskSegment(r.maskId, r.segIndex);
      setSelected(new Set());
      activateMask(res);
    } finally {
      setBusy(false);
      refresh();
    }
  };
  // 塗りの ROI の不透明度・塗りは segment 単位。輪郭の太さは Cornerstone がマスク単位でしか持てない。
  const setSegmentStyle = (maskId: string, segIndex: number, style: { fillAlpha?: number; renderFill?: boolean }) => {
    try {
      csSeg.segmentationStyle.setStyle({ type: LABELMAP, segmentationId: maskId, segmentIndex: segIndex }, style);
      renderAll();
    } catch {
      /* ignore */
    }
  };
  const setMaskOutline = (maskId: string, outlineWidth: number) => {
    try {
      csSeg.segmentationStyle.setStyle({ type: LABELMAP, segmentationId: maskId }, { outlineWidth });
      renderAll();
    } catch {
      /* ignore */
    }
  };
  // ROI（annotation）スタイル: 色・線幅・塗り。
  const setRoiStyle = (uid: string, style: Record<string, unknown>) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (csAnnotation.config.style as any).setAnnotationStyles(uid, style);
      renderAll();
    } catch {
      /* ignore */
    }
  };

  // 書き出し（IJ・RT）は**フォーカス患者の ROI だけ**。患者をまたぐと 1 つのファイルに別の患者が混ざる。
  const ofFocus = (o: RowOwner) => !o.patientKey || o.patientKey === activePatientKey;
  const shapeRows = focusRois.filter((r): r is ShapeRoiRow => r.rowKind === "shape");
  const paintedRows = focusRois.filter((r): r is PaintedRoiRow => r.rowKind === "painted");
  const shapeCount = shapeRows.length;
  // IJ RoiSet に書ける annotation（形の ROI と計測。Length 等は線として書き出せる）。
  const annotationUids = [...shapeRows.map((r) => r.uid), ...model.measures.filter(ofFocus).map((m) => m.uid)];

  // 行の**余白**を押したら「この ROI を見せる」。
  //
  // 🔴 **行内のボタンは `stopPropagation()` すること。** しないと子の onClick の後に
  //    親のこれが走り、**ボタンの結果を上書きする**。実機で踏んだ: ⧉（複製）を押すと
  //    複製先スライスへ移った直後に、行の reveal が**元 ROI のスライスへ引き戻していた**
  //    （複製はできているのに「同じ場所に戻った」ようにしか見えない）。
  const onAnnotationRowClick = (e: React.MouseEvent, uid: string) => {
    // Ctrl/⌘＋クリックは画像上と同じく選択を足す・外す。スライスは動かさない（表示中のスライスでまとめて動かすため）。
    if (e.ctrlKey || e.metaKey) { toggleRoiSelection(uid); return; }
    setFocusedRoi(uid); onRevealRoi?.(uid);
  };
  const renameAnnotation = (uid: string, value: string) => setRoiMaskMeta(uid, { label: value });
  const annotationBasics = (r: { uid: string; tool: string; visible: boolean; locked: boolean }) => (
    <>
      <button onClick={(e) => { e.stopPropagation(); toggleRoi(r.uid, !r.visible); }} style={eyeBtn} title={t("roiMgr.visible")} data-testid="roi-row-visible">{r.visible ? "👁" : "🚫"}</button>
      <button
        onClick={(e) => { e.stopPropagation(); toggleRoiLock(r.uid, !r.locked); }}
        style={eyeBtn}
        title={r.locked ? t("roiMgr.unlock") : t("roiMgr.lock")}
        aria-pressed={r.locked}
        data-testid="roi-mgr-lock"
      >
        {r.locked ? "🔒" : "🔓"}
      </button>
    </>
  );
  const annotationDelete = (r: { uid: string; locked: boolean }) => (
    <button
      onClick={(e) => { e.stopPropagation(); deleteRoi(r.uid); }}
      disabled={r.locked}
      style={r.locked ? { ...delBtn, opacity: 0.35, cursor: "not-allowed" } : delBtn}
      title={r.locked ? t("roiMgr.lockedNoDelete") : t("common.delete")}
      data-testid="roi-row-delete"
    >
      🗑
    </button>
  );

  // 行の「コピー」。貼り付けは、貼り付け先のタイルを 1 度クリックしてから ROI メニュー／Ctrl+V。
  const copyButton = (uid: string) =>
    onCopyRoi ? (
      <button
        onClick={(e) => { e.stopPropagation(); onCopyRoi(uid); }}
        disabled={busy}
        style={editBtn}
        title={t("roiMgr.copy")}
        data-testid="roi-mgr-copy"
      >
        ⎘
      </button>
    ) : null;

  // 形の ROI（面積・線・点）。
  const renderShapeRow = (r: ShapeRoiRow) => (
    <div key={r.key} data-testid="roi-row" data-kind="shape" data-roi-key={r.key}>
      <div
        style={focusedRoi === r.uid || selUids.has(r.uid) ? { ...row, ...focusedRowBox } : row}
        onClick={(e) => onAnnotationRowClick(e, r.uid)}
        data-testid="roi-mgr-row"
        data-roi-uid={r.uid}
      >
        {annotationBasics(r)}
        <input type="checkbox" checked={selected.has(r.key)} onClick={(e) => e.stopPropagation()} onChange={() => toggleSelect(r.key)} title={t("roiMgr.select")} data-testid="roi-row-select" />
        <span title={t("roiMgr.iconShape")} style={{ color: "#5a6672" }}>{r.kind === "area" ? "▭" : r.kind === "line" ? "╱" : "•"}</span>
        <input
          type="text" style={name} title={r.tool}
          defaultValue={getRoiMaskMeta(r.uid)?.label ?? r.tool}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => renameAnnotation(r.uid, e.target.value)}
        />
        <input type="color" defaultValue="#ffff00" onClick={(e) => e.stopPropagation()} onChange={(e) => setRoiStyle(r.uid, { color: hexToRgb(e.target.value) })} title={t("roiMgr.color")} style={colorInput} />
        <input type="number" min={1} max={10} defaultValue={1} onClick={(e) => e.stopPropagation()} onChange={(e) => setRoiStyle(r.uid, { lineWidth: String(e.target.value) })} title={t("roiMgr.lineWidth")} style={numInput} />
        <input type="checkbox" onClick={(e) => e.stopPropagation()} onChange={(e) => setRoiStyle(r.uid, { fillOpacity: e.target.checked ? 0.3 : 0 })} title={t("roiMgr.fill")} />
        {r.scope && <button onClick={(e) => { e.stopPropagation(); toggleScopeZ(r.uid); }} style={scopeChip} title={t("roiMgr.scopeToggle")}>{r.scope}</button>}
        {isAreaRoi(r.tool) && <button onClick={(e) => { e.stopPropagation(); runRoiToMask(r.uid); }} disabled={busy} style={editBtn} title={t("roiMgr.toMask")}>▦</button>}
        {r.kind === "area" && (
          <button
            onClick={(e) => { e.stopPropagation(); runExportSeg(r.uid, r); }}
            disabled={busy}
            style={editBtn}
            title={mode === "standalone" ? t("roiMgr.exportSegStandalone") : t("roiMgr.exportSeg")}
            data-testid="roi-row-export-seg"
          >
            SEG ⬇
          </button>
        )}
        {onDuplicateRoi && (
          <button
            onClick={(e) => { e.stopPropagation(); setFocusedRoi(r.uid); onDuplicateRoi(r.uid); }}
            disabled={busy}
            style={editBtn}
            title={t("roiMgr.duplicate")}
            data-testid="roi-mgr-duplicate"
          >
            ⧉
          </button>
        )}
        {copyButton(r.uid)}
        {/circle/i.test(r.tool) && <button onClick={(e) => { e.stopPropagation(); runDefineSphere(r.uid); }} disabled={busy} style={editBtn} title={t("roiMgr.defineSphere")} data-testid="roi-mgr-define-sphere">◎</button>}
        {/circle/i.test(r.tool) && <button onClick={(e) => { e.stopPropagation(); runSphere(r.uid); }} disabled={busy} style={editBtn} title={t("roiMgr.toSphere")}>⬤</button>}
        <button onClick={(e) => { e.stopPropagation(); setStatsOpen({ focus: r.uid }); }} style={editBtn} title={t("roiMgr.statsRoi")}>Σ</button>
        <button onClick={(e) => { e.stopPropagation(); setEditId(r.uid); }} style={editBtn} title={t("roiMgr.editTitle")}>✎</button>
        {annotationDelete(r)}
      </div>
    </div>
  );

  // 計測（長さ・角度・プローブなど）。ROI ではないので、塗り・RT・演算の対象にしない。
  const renderMeasureRow = (m: MeasureRow) => (
    <div
      key={m.key}
      style={focusedRoi === m.uid || selUids.has(m.uid) ? { ...row, ...focusedRowBox } : row}
      onClick={(e) => onAnnotationRowClick(e, m.uid)}
      data-testid="measure-row"
      data-roi-uid={m.uid}
    >
      {annotationBasics(m)}
      <input
        type="text" style={name} title={m.tool}
        defaultValue={getRoiMaskMeta(m.uid)?.label ?? m.tool}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => renameAnnotation(m.uid, e.target.value)}
      />
      <input type="color" defaultValue="#ffff00" onClick={(e) => e.stopPropagation()} onChange={(e) => setRoiStyle(m.uid, { color: hexToRgb(e.target.value) })} title={t("roiMgr.color")} style={colorInput} />
      {onDuplicateRoi && (
        <button
          onClick={(e) => { e.stopPropagation(); setFocusedRoi(m.uid); onDuplicateRoi(m.uid); }}
          disabled={busy}
          style={editBtn}
          title={t("roiMgr.duplicate")}
          data-testid="roi-mgr-duplicate"
        >
          ⧉
        </button>
      )}
      {copyButton(m.uid)}
      {onConvertToRoi && canConvertMeasureToRoi(m.tool) && (
        <button
          onClick={(e) => { e.stopPropagation(); setFocusedRoi(m.uid); onConvertToRoi(m.uid); }}
          disabled={busy || m.locked}
          style={editBtn}
          title={m.locked ? t("roi.toRoi.locked") : t("viewer2d.roi.toRoi")}
          data-testid="roi-mgr-to-roi"
        >
          →ROI
        </button>
      )}
      <button onClick={(e) => { e.stopPropagation(); setStatsOpen({ focus: m.uid }); }} style={editBtn} title={t("roiMgr.statsRoi")}>Σ</button>
      <button onClick={(e) => { e.stopPropagation(); setEditId(m.uid); }} style={editBtn} title={t("roiMgr.editTitle")}>✎</button>
      {annotationDelete(m)}
    </div>
  );

  // 塗りの ROI（labelmap の segment 1 つ）。行を押す＝この segment を塗り先（Brush/Wand の編集対象）にする。
  const renderPaintedRow = (r: PaintedRoiRow) => {
    const target = getSegEditTarget();
    const isActive = target.segmentationId === r.maskId && target.segmentIndex === r.segIndex;
    const col = segColorHex(r.maskId, r.segIndex);
    const st = stats[r.key];
    const rename = (value: string) => {
      const cur = getRoiMaskMeta(r.maskId)?.segmentLabels ?? {};
      // segment が 1 つだけなら、✎ 属性編集や SEG 書き出しが見る `label` も同じ名前にそろえる。
      setRoiMaskMeta(r.maskId, { segmentLabels: { ...cur, [String(r.segIndex)]: value }, ...(r.single ? { label: value } : {}) });
    };
    return (
      <div
        key={r.key}
        style={isActive ? activeMaskBox : undefined}
        onClick={(e) => {
          if ((e.target as HTMLElement).closest("button,input,select")) return;
          activateMask(r.maskId, r.segIndex); refresh();
        }}
        data-testid="roi-row"
        data-kind="painted"
        data-roi-key={r.key}
        data-mask-id={r.maskId}
        data-seg-index={r.segIndex}
      >
        <div style={row}>
          <input type="radio" name="graphy-active-mask" checked={isActive} onChange={() => { activateMask(r.maskId, r.segIndex); refresh(); }} title={t("roiMgr.activeMask")} />
          <button
            onClick={() => { setSegmentVisible(r.maskId, r.segIndex, !r.visible); renderAll(); refresh(); }}
            style={eyeBtn} title={t("roiMgr.visible")} data-testid="roi-row-visible"
          >
            {r.visible ? "👁" : "🚫"}
          </button>
          <input type="checkbox" checked={selected.has(r.key)} onChange={() => toggleSelect(r.key)} title={t("roiMgr.select")} data-testid="roi-row-select" />
          <span title={t("roiMgr.iconPainted")} style={{ color: col ?? "#5a6672" }}>▨</span>
          <input
            type="text" style={nameInRow} title={r.maskId}
            defaultValue={r.name}
            onChange={(e) => rename(e.target.value)}
          />
          <button onClick={() => deletePainted(r)} style={delBtn} title={t("common.delete")} data-testid="roi-row-delete">🗑</button>
        </div>
        <div style={row}>
          <input type="color" value={col ?? "#ff0000"} onChange={(e) => { setMaskColor(r.maskId, e.target.value, r.segIndex); refresh(); }} title={t("roiMgr.color")} style={colorInput} />
          <input
            type="range" min={0} max={1} step={0.05} defaultValue={maskDefaults.fillOpacity}
            onChange={(e) => setSegmentStyle(r.maskId, r.segIndex, { fillAlpha: Number(e.target.value) })}
            style={{ width: 56 }} title={t("roiMgr.opacity")}
          />
          <input type="number" min={0} max={10} defaultValue={maskDefaults.outlineWidth} onChange={(e) => setMaskOutline(r.maskId, Number(e.target.value))} title={t("roiMgr.lineWidth")} style={numInput} />
          <input type="checkbox" defaultChecked onChange={(e) => setSegmentStyle(r.maskId, r.segIndex, { renderFill: e.target.checked })} title={t("roiMgr.fill")} />
          {/* 範囲は中身（塗ったスライス）で決まる。メタを書き換えても中身は変わらないので押せない表示にする */}
          {r.scope && <span style={scopeChipStatic} title={t("roiMgr.scopeToggleMask")} data-testid="mask-scope">{r.scope}</span>}
        </div>
        <div style={row}>
          <button onClick={() => runStats(r)} data-testid="mask-stats-run" style={editBtn} title={t("roiMgr.stats")}>Σ³</button>
          <button onClick={() => setStatsOpen({ focus: r.key })} data-testid="mask-stats-dialog" style={editBtn} title={t("roiMgr.statsMask")}>Σ</button>
          <button onClick={() => runSplitToSlices(r)} disabled={busy} style={editBtn} title={t("roiMgr.toSlices")}>⬚</button>
          {/* SEG書き出しは毎晩の自動リストアで確実に消えるため、他の持ち出し系と異なりデモでも許可
             （backend DemoModeFilter・fw/web-demo-hosting.md 参照）。マスク全体（同じマスクの ROI すべて）を書く。 */}
          <button onClick={() => runExportSeg(r.maskId)} disabled={busy} style={editBtn} title={mode === "standalone" ? t("roiMgr.exportSegStandalone") : t("roiMgr.exportSeg")}>SEG ⬇</button>
          {!isDemo && <button onClick={() => runExportRtStruct(r)} disabled={busy} style={editBtn} title={t("roiMgr.exportRtOne")} data-testid="roi-row-export-rt">RT ⬇</button>}
          <button onClick={() => setEditId(r.maskId)} style={editBtn} title={t("roiMgr.editTitle")}>✎</button>
        </div>
        {st && (
          <div style={statLine} data-testid="mask-stats">
            {t("roiMgr.statVol")}: {st.volumeMl === undefined ? "—" : `${st.volumeMl.toFixed(2)} mL (${st.volumeMm3!.toFixed(0)} mm³)`} ·
            {" "}{t("roiMgr.statVoxels")}: {st.voxels.toLocaleString()} · {t("roiMgr.statSlices")}: {st.slices}
            {st.warnings.length > 0 && (
              <>
                <br />
                <span data-testid="mask-stats-warn">{st.warnings.map((w) => t(`roiStats.warn.${w}`)).join(" / ")}</span>
              </>
            )}
            {(st.missingValueSlices ?? 0) > 0 && (
              <>
                <br />
                {t("roiMgr.statMissingSlices", { n: st.missingValueSlices! })}
              </>
            )}
            {st.mean !== undefined && (
              <>
                <br />
                {t("roiMgr.statMean")}: {formatNumber(st.mean!)} ± {formatNumber(st.sd!)} ·
                {" "}min {formatNumber(st.min!)} / max {formatNumber(st.max!)} {valueUnitLabel(st.unit ?? "", t)}
                {meanTimesVolumeLabelKey(st.unit) && st.meanTimesVolumeMl !== undefined && (
                  <>
                    <br />
                    {t("roiMgr.statTlg")}: {formatNumber(st.meanTimesVolumeMl!)} {valueUnitLabel(st.unit ?? "", t)}·mL
                  </>
                )}
              </>
            )}
          </div>
        )}
      </div>
    );
  };

  // パラメトリック球（保持＋全スライスのライブ断面）。「塗りにする」で塗りの ROI に焼き込む。
  const renderSphereRow = (id: string) => {
    const s = spheres.find((x) => x.id === id);
    if (!s) return null;
    return (
      <div key={s.id} style={row} data-testid="roi-row" data-kind="sphere" data-roi-key={s.id}>
        <button onClick={() => updateSphere3D(s.id, { visible: !s.visible })} style={eyeBtn} title={t("roiMgr.visible")} data-testid="roi-row-visible">{s.visible ? "👁" : "🚫"}</button>
        <input type="checkbox" checked={selected.has(s.id)} onChange={() => toggleSelect(s.id)} title={t("roiMgr.select")} data-testid="roi-row-select" />
        <span title={t("roiMgr.iconSphere")} style={{ color: s.color }}>◍</span>
        <input type="text" style={name} defaultValue={s.label ?? "Sphere"} onChange={(e) => updateSphere3D(s.id, { label: e.target.value })} />
        <input type="color" defaultValue={s.color} onChange={(e) => updateSphere3D(s.id, { color: e.target.value })} title={t("roiMgr.color")} style={colorInput} />
        <input type="number" min={0.1} step={0.5} defaultValue={Number(s.radiusMm.toFixed(1))} onChange={(e) => { const v = Number(e.target.value); if (v > 0) updateSphere3D(s.id, { radiusMm: v }); }} title={t("roiMgr.radiusMm")} style={numInput} data-testid="sphere-radius" />
        <span style={{ color: "#9aa6b2", fontSize: 10 }}>mm</span>
        <span style={{ color: "#9aa6b2", fontSize: 10 }}>{t("roiMgr.centerMm")}</span>
        {(["X", "Y", "Z"] as const).map((ax, i) => (
          <NumField
            key={ax}
            testid={`sphere-center-${ax.toLowerCase()}`}
            value={s.center[i]}
            format={(v) => v.toFixed(2)}
            title={t(`roiMgr.center${ax}`)}
            style={centerInput}
            onCommit={(v) => { const c = [...s.center] as [number, number, number]; c[i] = v; updateSphere3D(s.id, { center: c }); }}
          />
        ))}
        <button onClick={() => runBakeSphere(s.id)} disabled={busy} style={editBtn} title={t("roiMgr.bakeSphere")} data-testid="sphere-bake">{t("roiMgr.bakeSphereShort")}</button>
        <button onClick={() => deleteSphere3D(s.id)} style={delBtn} title={t("common.delete")} data-testid="roi-row-delete">🗑</button>
      </div>
    );
  };

  // ── ROI グループ ──
  // メンバーは、形の ROI・計測＝注釈 uid（`a:`）、塗り ROI＝マスク（`m:`。同じマスクの segment は同じグループ）、球＝球 id（`s:`）。
  // 🔴 保存されるのは形の ROI・計測の所属だけ。塗り ROI・球は ROI の保存ファイルに載らないので、再読み込みで外れる。
  const annUids = new Set([...model.rois.flatMap((r) => (r.rowKind === "shape" ? [r.uid] : [])), ...model.measures.map((m) => m.uid)]);
  const selectedAnnUids = [...selUids].filter((u) => annUids.has(u));
  const selectedPaintedMasks = [...new Set(model.rois.flatMap((r) => (r.rowKind === "painted" && selected.has(r.key) ? [r.maskId] : [])))];
  const selectedSphereIds = model.rois.flatMap((r) => (r.rowKind === "sphere" && selected.has(r.key) ? [r.id] : []));
  const selectedMembers = [
    ...selectedAnnUids.map((u) => `a:${u}`),
    ...selectedPaintedMasks.map((m) => `m:${m}`),
    ...selectedSphereIds.map((i) => `s:${i}`),
  ];
  const patientOfMember = (k: string): string | undefined =>
    k[0] === "s" ? spheres.find((x) => x.id === k.slice(2))?.patientKey : getRoiMaskMeta(k.slice(2))?.patientKey;
  const setMemberGroup = (k: string, patch: { groupId?: string; groupName?: string }) => {
    if (k[0] === "s") updateSphere3D(k.slice(2), patch);
    else setRoiMaskMeta(k.slice(2), patch);
  };
  const groupRowsOf = (gid: string) => ({
    rois: model.rois.filter((r) => r.groupId === gid),
    measures: model.measures.filter((m) => m.groupId === gid),
  });
  const groupMembers = (gid: string): string[] => {
    const g = groupRowsOf(gid);
    return [...new Set([
      ...g.rois.map((r) => (r.rowKind === "shape" ? `a:${r.uid}` : r.rowKind === "painted" ? `m:${r.maskId}` : `s:${r.id}`)),
      ...g.measures.map((m) => `a:${m.uid}`),
    ])];
  };
  const groupAnnUids = (gid: string) => groupMembers(gid).filter((k) => k[0] === "a").map((k) => k.slice(2));
  const groupNames = [...model.rois, ...model.measures].map((r) => r.groupName);
  // メンバーが 2 件に満たないグループは見出しを出さない（再読み込みで塗り ROI・球が外れた残りなど）。
  const groupSizes = new Map<string, number>();
  for (const r of [...model.rois, ...model.measures]) if (r.groupId) groupSizes.set(r.groupId, (groupSizes.get(r.groupId) ?? 0) + 1);
  const isRealGroup = (gid: string | undefined): gid is string => !!gid && (groupSizes.get(gid) ?? 0) >= 2;
  const makeGroup = () => {
    const prefix = t("roiMgr.groupPrefix");
    const plan = planGroup(
      selectedMembers,
      patientOfMember,
      () => crypto.randomUUID(),
      `${prefix} ${nextGroupNumber(groupNames, prefix)}`,
    );
    if (!plan.ok) { emitToast(t(plan.reason === "crossPatient" ? "roiMgr.group.crossPatient" : "roiMgr.group.tooFew")); return; }
    for (const k of selectedMembers) setMemberGroup(k, { groupId: plan.groupId, groupName: plan.name });
    emitToast(t("roiMgr.group.made", { n: selectedMembers.length, name: plan.name }));
    refresh();
  };
  const renameGroup = (gid: string, name: string) => { for (const k of groupMembers(gid)) setMemberGroup(k, { groupName: name }); };
  const ungroup = (gid: string) => { for (const k of groupMembers(gid)) setMemberGroup(k, { groupId: undefined, groupName: undefined }); refresh(); };
  // 錠があるのは形の ROI・計測だけ（塗り ROI・球には無い）。
  const lockGroup = (gid: string) => {
    const uids = groupAnnUids(gid);
    const allLocked = uids.length > 0 && uids.every(isRoiLocked);
    for (const u of uids) setRoiLocked(u, !allLocked);
    refresh();
  };
  const selectGroup = (gid: string) => {
    const g = groupRowsOf(gid);
    selectRois(groupAnnUids(gid));
    setSelected(new Set(g.rois.filter((r) => r.rowKind !== "shape").map((r) => r.key)));
  };
  const deleteGroup = (gid: string, name: string) => {
    const g = groupRowsOf(gid);
    const uids = groupAnnUids(gid).filter((u) => !isRoiLocked(u));
    const painted = g.rois.filter((r): r is PaintedRoiRow => r.rowKind === "painted");
    const sphereRows = g.rois.filter((r): r is SphereRoiRow => r.rowKind === "sphere");
    const n = uids.length + painted.length + sphereRows.length;
    if (n === 0) return;
    if (!window.confirm(t("roiMgr.group.deleteConfirm", { name, n }))) return;
    const owners = new Set(uids.map((u) => getRoiMaskMeta(u)?.patientKey || activePatientKey));
    for (const u of uids) {
      try { csAnnotation.state.removeAnnotation(u); } catch { /* ignore */ }
      deleteRoiMaskMeta(u);
    }
    for (const r of painted) removeMaskSegment(r.maskId, r.segIndex);
    for (const r of sphereRows) deleteSphere3D(r.id);
    for (const pk of owners) scheduleRoiSave(pk);
    renderAll();
    refresh();
  };
  const groupHead = (gid: string, name: string) => {
    const g = groupRowsOf(gid);
    const uids = groupAnnUids(gid);
    const allLocked = uids.length > 0 && uids.every(isRoiLocked);
    const anyVisible = g.rois.some(roiVisible) || g.measures.some((m) => m.visible);
    const tempOnly = g.rois.some((r) => r.rowKind !== "shape");
    const sec = groupSec(gid);
    return (
      <div key={`h:${sec}:${gid}`} style={groupHeadStyle} data-testid="roi-group-head" data-group-id={gid}>
        <button onClick={() => toggleCollapsed(sec)} style={eyeBtn} title={t("roiMgr.sectionFold")} aria-expanded={!collapsed.has(sec)}>
          {collapsed.has(sec) ? "▸" : "▾"}
        </button>
        <input
          type="text" style={{ ...name_, fontWeight: 600, flex: "1 1 80px" }} defaultValue={name} title={t("roiMgr.group.rename")}
          onChange={(e) => renameGroup(gid, e.target.value)}
          data-testid="roi-group-name"
        />
        <span style={countBadge}>{g.rois.length + g.measures.length}</span>
        {tempOnly && <span style={countBadge} title={t("roiMgr.group.sessionOnly")} data-testid="roi-group-temp">{t("roiMgr.group.sessionBadge")}</span>}
        <button onClick={() => setRowsVisible(g.rois, g.measures, !anyVisible)} style={eyeBtn} title={t("roiMgr.sectionEye")} data-testid="roi-group-visible">
          {anyVisible ? "👁" : "🚫"}
        </button>
        <button onClick={() => lockGroup(gid)} disabled={uids.length === 0} style={eyeBtn} title={t("roiMgr.group.lock")} aria-pressed={allLocked} data-testid="roi-group-lock">
          {allLocked ? "🔒" : "🔓"}
        </button>
        <button onClick={() => selectGroup(gid)} style={editBtn} title={t("roiMgr.group.select")} data-testid="roi-group-select">◎</button>
        <button onClick={() => setStatsOpen({ section: sec })} style={editBtn} title={t("roiMgr.sectionStats")} data-testid="roi-group-stats">Σ</button>
        <button onClick={() => ungroup(gid)} style={editBtn} title={t("roiMgr.group.ungroup")} data-testid="roi-group-ungroup">⛓</button>
        <button onClick={() => deleteGroup(gid, name)} disabled={allLocked && !tempOnly} style={allLocked && !tempOnly ? { ...delBtn, opacity: 0.35, cursor: "not-allowed" } : delBtn} title={t("roiMgr.group.delete")} data-testid="roi-group-delete">🗑</button>
      </div>
    );
  };

  // ── 患者→シリーズの見出し（全患者表示）──
  // 1 患者・1 シリーズだけで、グループも無いときは見出しを出さない（従来の見た目のまま）。
  const anyGroup = [...groupSizes.keys()].some((gid) => isRealGroup(gid));
  const grouping = !!shownSeries && (new Set(shownSeries.map((x) => x.patientKey)).size > 1 || shownSeries.length > 1 || anyGroup);
  const toggleCollapsed = (k: string) =>
    setCollapsed((c) => { const n = new Set(c); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const roiVisible = (r: RoiRow): boolean =>
    r.rowKind === "sphere" ? (spheres.find((x) => x.id === r.id)?.visible ?? true) : r.visible;
  // 見出し配下をまとめて表示・非表示（1 つでも見えていれば隠す、全部隠れていれば出す）。
  const setRowsVisible = (rois: RoiRow[], measures: MeasureRow[], vis: boolean) => {
    for (const r of rois) {
      if (r.rowKind === "shape") { try { csAnnotation.visibility.setAnnotationVisibility(r.uid, vis); } catch { /* ignore */ } }
      else if (r.rowKind === "painted") setSegmentVisible(r.maskId, r.segIndex, vis);
      else updateSphere3D(r.id, { visible: vis });
    }
    for (const m of measures) { try { csAnnotation.visibility.setAnnotationVisibility(m.uid, vis); } catch { /* ignore */ } }
    renderAll();
    refresh();
  };
  const sectionHead = (sec: string, title: string, level: 0 | 1, rois: RoiRow[], measures: MeasureRow[], isFocus = false) => {
    const n = rois.length + measures.length;
    const anyVisible = rois.some(roiVisible) || measures.some((m) => m.visible);
    return (
      <div key={`h:${sec}`} style={level === 0 ? patientHead : seriesHead} data-testid="roi-section-head" data-section={sec}>
        <button onClick={() => toggleCollapsed(sec)} style={eyeBtn} title={t("roiMgr.sectionFold")} aria-expanded={!collapsed.has(sec)}>
          {collapsed.has(sec) ? "▸" : "▾"}
        </button>
        <span style={headTitle} title={title}>{title}</span>
        {isFocus && <span style={focusBadge} title={t("roiMgr.focusPatient")}>●</span>}
        <span style={countBadge}>{n}</span>
        {n > 0 && (
          <>
            <button onClick={() => setRowsVisible(rois, measures, !anyVisible)} style={eyeBtn} title={t("roiMgr.sectionEye")} data-testid="roi-section-visible">
              {anyVisible ? "👁" : "🚫"}
            </button>
            <button onClick={() => setStatsOpen({ section: sec })} style={editBtn} title={t("roiMgr.sectionStats")} data-testid="roi-section-stats">Σ</button>
          </>
        )}
      </div>
    );
  };
  /** 行を患者→シリーズの見出しで並べる。見出しの無い（患者不明の）行は先頭に素のまま出す。 */
  function renderGrouped<T extends RowOwner & ({ rowKind: RoiRow["rowKind"] } | { uid: string })>(
    rows: T[],
    render: (r: T) => React.ReactNode,
    asRois: (rs: T[]) => RoiRow[],
    asMeasures: (rs: T[]) => MeasureRow[],
  ): React.ReactNode[] {
    if (!grouping || !shownSeries) return rows.map(render);
    const out: React.ReactNode[] = rows.filter((r) => !r.patientKey).map(render);
    const patients = [...new Map(shownSeries.map((x) => [x.patientKey, x.patientName])).entries()];
    for (const [pk, pname] of patients) {
      const prow = rows.filter((r) => r.patientKey === pk);
      const psec = patientSec(pk);
      out.push(sectionHead(psec, pname || pk, 0, asRois(prow), asMeasures(prow), pk === activePatientKey));
      if (collapsed.has(psec)) continue;
      // グループ: 所属 ROI はグループ見出しの下にだけ出す（シリーズ区画には重複させない）。
      for (const gid of [...new Set(prow.map((r) => r.groupId).filter(isRealGroup))]) {
        const grow = prow.filter((r) => r.groupId === gid);
        out.push(groupHead(gid, grow[0].groupName ?? ""));
        if (!collapsed.has(groupSec(gid))) out.push(...grow.map(render));
      }
      const ungrouped = prow.filter((r) => !isRealGroup(r.groupId));
      const seriesOf = shownSeries.filter((x) => x.patientKey === pk);
      const known = new Set(seriesOf.map((x) => x.seriesUid));
      out.push(...ungrouped.filter((r) => !r.seriesUid || !known.has(r.seriesUid)).map(render));
      for (const se of seriesOf) {
        const srow = ungrouped.filter((r) => r.seriesUid === se.seriesUid);
        if (seriesOf.length > 1) {
          const ssec = seriesSec(pk, se.seriesUid);
          out.push(sectionHead(ssec, se.label, 1, asRois(srow), asMeasures(srow)));
          if (collapsed.has(ssec)) continue;
        }
        out.push(...srow.map(render));
      }
    }
    return out;
  }

  return (
    <div style={panel}>
      <div style={head}>
        <strong style={{ fontSize: 13 }}>{t("roiMgr.title")}</strong>
        <span style={{ flex: 1 }} />
        {/* 明示保存。ROI は変更のたびに自動保存されるが、席を離れる前に確実に書いたと
            分かるようにする（自動保存の完了は見えないため）。 */}
        <button
          onClick={runSaveRois}
          disabled={saving}
          style={hbtn}
          title={saveTitle}
          data-testid="roi-mgr-save"
        >
          {saving ? "…" : "💾"}
        </button>
        <button onClick={refresh} style={hbtn} title={t("roiMgr.refresh")}>⟳</button>
        <button onClick={onClose} style={hbtn} title={t("common.close")}>×</button>
      </div>

      {fusionMeasure.length > 0 && (
        <div style={fusionNote} data-testid="roi-mgr-fusion-warn">
          ⚠ {t("roiMgr.fusionWarn", { blend: t(`fusion.blend.name.${fusionMeasure[0].blend}`) })}
        </div>
      )}

      <div style={{ ...section, display: "flex", alignItems: "center", gap: 4 }}>
        <span>{t("roiMgr.rois")} ({model.rois.length})</span>
        <span style={{ flex: 1 }} />
        <input
          ref={importInputRef} type="file" accept=".roi,.zip" style={{ display: "none" }}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) runImportRois(f); e.target.value = ""; }}
        />
        {!isDemo && <button onClick={() => importInputRef.current?.click()} disabled={busy} style={opBtn} title={t("roiMgr.importIJ")}>IJ ⬆</button>}
        <button onClick={runImportRtStruct} disabled={busy} style={opBtn} title={t("roiMgr.importRt")}>RT ⬆</button>
        <button
          onClick={runImportSeg}
          disabled={busy}
          style={{ ...opBtn, display: "inline-flex", alignItems: "center", gap: 4 }}
          title={segImportProgress != null ? `${t("roiMgr.importSeg")} ${Math.round(segImportProgress * 100)}%` : t("roiMgr.importSeg")}
        >
          {segImportProgress != null ? (
            <>
              <LoadingSpinner size={12} color="#2b8aef" trackColor="#dde4ea" progress={segImportProgress} />
              {Math.round(segImportProgress * 100)}%
            </>
          ) : (
            "SEG ⬆"
          )}
        </button>
        {statsTargets.length > 0 && (
          <button onClick={() => setStatsOpen({})} style={opBtn} title={t("roiMgr.statsAll")} data-testid="roi-mgr-stats-all">Σ</button>
        )}
        {!isDemo && annotationUids.length > 0 && <button onClick={runExportRois} disabled={busy} style={opBtn} title={t("roiMgr.exportIJ")}>IJ ⬇</button>}
        {!isDemo && shapeCount + paintedRows.length > 0 && <button onClick={() => runExportRtStruct()} disabled={busy} style={opBtn} title={t("roiMgr.exportRt")} data-testid="roi-mgr-export-rt">RT ⬇</button>}
      </div>
      <div style={{ ...row, justifyContent: "flex-start" }}>
        <button onClick={addNewPainted} disabled={busy} style={editBtn} title={t("roiMgr.newMask")} data-testid="roi-new-painted">＋{t("roiMgr.newMaskShort")}</button>
        <button onClick={makeGroup} disabled={selectedMembers.length < 2} style={editBtn} title={t("roiMgr.group.make")} data-testid="roi-group-make">🗂 {t("roiMgr.groupPrefix")} ({selectedMembers.length})</button>
      </div>
      {model.rois.length === 0 && <div style={empty}>{t("roiMgr.empty")}</div>}
      {renderGrouped<RoiRow>(
        model.rois,
        (r) => {
          if (r.rowKind === "shape") return renderShapeRow(r);
          if (r.rowKind === "painted") return renderPaintedRow(r);
          return renderSphereRow(r.id);
        },
        (rs) => rs,
        () => [],
      )}

      {shapeCount + paintedRows.length > 0 && (
        <div style={opsBar}>
          <span style={{ color: "#5a6672", marginRight: 2 }} title={t("roiMgr.ops")}>{t("roiMgr.ops")} ({selectedRows.length})</span>
          <button onClick={() => runCombine("or")} disabled={busy || operands.length < 2} style={opBtn} title={t("roiMgr.opMerge")}>{t("roiMgr.merge")}</button>
          <button onClick={() => runCombine("and")} disabled={busy || operands.length < 2} style={opBtn} title={t("roiMgr.opAnd")}>AND</button>
          <button onClick={() => runCombine("xor")} disabled={busy || operands.length < 2} style={opBtn} title={t("roiMgr.opXor")}>XOR</button>
          <button onClick={runSplit} disabled={busy || operands.length !== 1 || operands[0].kind !== "painted"} style={opBtn} title={t("roiMgr.opSplit")}>{t("roiMgr.split")}</button>
          <select value={splitConn} onChange={(e) => setSplitConn(Number(e.target.value) as SplitConnectivity)} title={t("roiMgr.splitConn")} style={{ ...opBtn, padding: "2px 4px" }}>
            <option value={26}>26</option>
            <option value={18}>18</option>
            <option value={6}>6</option>
          </select>
        </div>
      )}

      <div style={section} title={t("roiMgr.measuresNote")}>{t("roiMgr.measures")} ({model.measures.length})</div>
      {model.measures.length === 0 && <div style={empty}>{t("roiMgr.empty")}</div>}
      {renderGrouped<MeasureRow>(model.measures, renderMeasureRow, () => [], (ms) => ms)}

      <div style={note}>{t("roiMgr.m1note")}</div>
      {editId && <RoiMetaEditDialog itemId={editId} onClose={() => { setEditId(null); refresh(); }} />}
      {statsOpen && (
        <RoiStatsDialog
          targets={statsTargets}
          initialUid={statsOpen.focus}
          groupTitle={
            statsOpen.section?.startsWith("g:")
              ? [...model.rois, ...model.measures].find((r) => r.groupId === statsOpen.section!.slice(2))?.groupName ?? ""
              : undefined
          }
          onClose={() => setStatsOpen(null)}
        />
      )}
    </div>
  );
}

const panel: React.CSSProperties = {
  width: 260, flex: "none", borderLeft: "1px solid #dde4ea", background: "#fafbfc",
  display: "flex", flexDirection: "column", overflowY: "auto", fontSize: 12,
};
const head: React.CSSProperties = { display: "flex", alignItems: "center", gap: 4, padding: "6px 8px", borderBottom: "1px solid #e6eaee", background: "#fff" };
const hbtn: React.CSSProperties = { border: "1px solid #cdd5de", borderRadius: 5, background: "#fff", cursor: "pointer", fontSize: 13, padding: "1px 7px" };
const groupHeadStyle: React.CSSProperties = {
  display: "flex", flexWrap: "wrap", alignItems: "center", gap: 4, padding: "2px 8px 2px 14px", background: "#f1eefb",
  borderLeft: "3px solid #8a6fd1", color: "#4a3a7a",
};
const name_: React.CSSProperties = {
  flex: 1, minWidth: 0, color: "#33404d", fontSize: 12,
  border: "1px solid transparent", borderRadius: 4, background: "transparent", padding: "2px 4px",
};
const patientHead: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 4, padding: "4px 8px", background: "#eaf0f6",
  borderTop: "1px solid #dde4ea", borderBottom: "1px solid #dde4ea", fontWeight: 600, color: "#33404d",
};
const seriesHead: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 4, padding: "2px 8px 2px 18px", background: "#f3f6f9",
  fontWeight: 500, color: "#5a6672",
};
const headTitle: React.CSSProperties = { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const countBadge: React.CSSProperties = { fontSize: 10, color: "#5a6672", background: "#fff", border: "1px solid #dde4ea", borderRadius: 8, padding: "0 6px" };
const focusBadge: React.CSSProperties = { fontSize: 8, color: "#2b8aef" };
const section: React.CSSProperties = { padding: "6px 8px 2px", fontWeight: 600, color: "#5a6672" };
const row: React.CSSProperties = { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, padding: "3px 8px" };
const name: React.CSSProperties = {
  flex: 1, minWidth: 0, color: "#33404d", fontSize: 12,
  border: "1px solid transparent", borderRadius: 4, background: "transparent", padding: "2px 4px",
};
// マスク名は色/不透明度/各種操作ボタンと同じ行だと flex-wrap の詰め合いで幅を奪われ見切れるため、
// マスク行では名前だけ幅いっぱいの専用行にする（flexBasis 指定で強制的に単独行にする）。
// 塗りの行: 名前は 1 行目の残り幅に収め、🗑 を同じ行の右端に置く。
const nameInRow: React.CSSProperties = { ...name, minWidth: 80 };
const delBtn: React.CSSProperties = { border: "1px solid #e3c2c2", borderRadius: 5, background: "#fff", cursor: "pointer", fontSize: 12, padding: "1px 6px" };
const editBtn: React.CSSProperties = { border: "1px solid #cdd5de", borderRadius: 5, background: "#fff", cursor: "pointer", fontSize: 12, padding: "1px 6px" };
const eyeBtn: React.CSSProperties = { border: "none", background: "transparent", cursor: "pointer", fontSize: 13, padding: 0, lineHeight: 1 };
const colorInput: React.CSSProperties = { width: 22, height: 20, padding: 0, border: "1px solid #cdd5de", borderRadius: 3, background: "#fff", cursor: "pointer" };
const numInput: React.CSSProperties = { width: 36, border: "1px solid #cdd5de", borderRadius: 4, fontSize: 11 };
const centerInput: React.CSSProperties = { ...numInput, width: 64 }; // 「-123.45」が欠けずに読める幅
const scopeChip: React.CSSProperties = { fontSize: 10, color: "#5a6672", background: "#eef2f6", border: "1px solid #dde4ea", borderRadius: 4, padding: "1px 4px", whiteSpace: "nowrap", cursor: "pointer" };
const scopeChipStatic: React.CSSProperties = { ...scopeChip, cursor: "default", background: "transparent" };
const opsBar: React.CSSProperties = { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 4, padding: "6px 8px", borderTop: "1px solid #eef1f4" };
const opBtn: React.CSSProperties = { border: "1px solid #cdd5de", borderRadius: 5, background: "#fff", cursor: "pointer", fontSize: 11, padding: "2px 7px" };
const statLine: React.CSSProperties = { padding: "0 10px 4px 28px", color: "#5a6672", fontSize: 11 };
const fusionNote: React.CSSProperties = {
  margin: "6px 8px 0", padding: "5px 8px", border: "1px solid #e0b25a", background: "#fff6e0",
  color: "#7a4b00", fontSize: 11, lineHeight: 1.5, borderRadius: 4,
};
const empty: React.CSSProperties = { padding: "2px 10px", color: "#9aa6b2" };
const note: React.CSSProperties = { marginTop: "auto", padding: 8, color: "#9aa6b2", fontSize: 11, borderTop: "1px solid #eef1f4" };
// アクティブ編集対象（D2）のハイライト。
const activeMaskBox: React.CSSProperties = { background: "#eef7ff", borderLeft: "3px solid #2b8aef" };
// 一覧で選んでいる ROI の行。マスクのアクティブ表示と同じ見た目に揃える（別の意味に見せない）。
const focusedRowBox: React.CSSProperties = { background: "#eef7ff", borderLeft: "3px solid #2b8aef" };
