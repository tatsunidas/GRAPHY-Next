/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * ROI マネージャ（右サイドパネル, M1）。
 *
 * 患者の 2D Viewer ウィンドウ内に存在する ROI（Cornerstone annotation）と
 * Mask（Cornerstone segmentation labelmap）を一覧し、表示/非表示・削除・マスク不透明度を操作する。
 * 設計: `fw/roi-manager-design.md`（M1=骨組み＋表示属性）。
 * 後続(M2+): 色/線幅/塗り, ZCT scope/メタ編集, ブール演算, 3D 変換, 保存(ImageJ/DICOM)。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { eventTarget, getRenderingEngine, Enums as csEnums } from "@cornerstonejs/core";
import {
  annotation as csAnnotation,
  segmentation as csSeg,
  Enums as csToolsEnums,
} from "@cornerstonejs/tools";
import { ENGINE_ID } from "../viewer/Viewer2D";
import { getRoiMaskMeta, setRoiMaskMeta, deleteRoiMaskMeta, subscribeRoiMaskStore, getSegEditTarget, getMaskSegments } from "../viewer/roiMaskStore";
import { createNewMask, addSegmentToActiveMask, activateMask, getLastSegViewport } from "../viewer/segmentation";
import { fetchSettings } from "../settings/settingsApi";
import { combineMasks, splitMask, roiToMask, isAreaRoi, type BoolOp, type SplitConnectivity } from "../viewer/roiBooleanOps";
import { sphereFromCircleRoi, createSphere3DFromCircleRoi, bakeSphere3D, splitMaskToSlices, maskVolumeStats, type MaskVolumeStats } from "../viewer/roi3d";
import { listSpheres3D, updateSphere3D, deleteSphere3D, subscribeSphere3D, type Sphere3D } from "../viewer/sphere3dStore";
import { annotationsToImageJDtos } from "../viewer/imagejExport";
import { importImageJDtos } from "../viewer/imagejImport";
import { exportImageJRoiSet, importImageJRoiSet } from "../api";
import { RoiMetaEditDialog } from "./RoiMetaEditDialog";
import { useI18n } from "../i18n/i18n";

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

interface RoiRow { uid: string; tool: string; visible: boolean; scope: string; }
interface MaskRow { id: string; label: string; scope: string; visible: boolean; }

/** マスク（segmentation representation）の表示状態を読む（先頭ビューポート基準。未取得は表示扱い）。 */
function getMaskVisible(id: string): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vps = (csSeg.state as any).getViewportIdsWithSegmentation(id) as string[] | undefined;
    const vp = vps?.[0];
    if (!vp) return true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const v = (csSeg.config.visibility as any).getSegmentationRepresentationVisibility(vp, { segmentationId: id, type: LABELMAP });
    return v !== false;
  } catch {
    return true;
  }
}

/** scope メタ → 表示文字列。 */
function scopeText(itemId: string): string {
  const s = getRoiMaskMeta(itemId)?.scope;
  if (!s) return "";
  const z = s.z === "all" ? "Z:all" : `z${s.z}`;
  const c = s.c === "all" ? "C:all" : `c${s.c}`;
  const tt = s.t === "all" ? "T:all" : `t${s.t}`;
  return `${z} ${c} ${tt}`;
}

export function RoiManagerPanel({ activePatientKey, onClose }: { activePatientKey: string; onClose: () => void }) {
  const { t } = useI18n();
  const [rois, setRois] = useState<RoiRow[]>([]);
  const [masks, setMasks] = useState<MaskRow[]>([]);
  const [editId, setEditId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
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

  const refresh = useCallback(() => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const all = csAnnotation.state.getAllAnnotations() as any[];
      setRois(
        all
          .filter((a) => a?.annotationUID)
          // 現在の患者に属するもの（未紐付け＝患者不明は表示）。
          .filter((a) => {
            const pk = getRoiMaskMeta(a.annotationUID)?.patientKey;
            return !pk || pk === activePatientKey;
          })
          .map((a) => ({
            uid: a.annotationUID as string,
            tool: (a.metadata?.toolName as string) ?? "ROI",
            visible: csAnnotation.visibility.isAnnotationVisible(a.annotationUID) ?? true,
            scope: scopeText(a.annotationUID),
          })),
      );
    } catch {
      setRois([]);
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const segs = csSeg.state.getSegmentations() as any[];
      setMasks(
        (segs ?? [])
          .filter((s) => {
            const pk = getRoiMaskMeta(s.segmentationId)?.patientKey;
            return !pk || pk === activePatientKey;
          })
          .map((s) => ({
            id: s.segmentationId as string,
            label: (s.label as string) || (s.segmentationId as string),
            scope: scopeText(s.segmentationId),
            visible: getMaskVisible(s.segmentationId as string),
          })),
      );
    } catch {
      setMasks([]);
    }
    setSpheres(listSpheres3D().filter((s) => !s.patientKey || s.patientKey === activePatientKey));
  }, [activePatientKey]);

  useEffect(() => {
    refresh();
    const ev = csToolsEnums.Events;
    const names = [
      ev.ANNOTATION_ADDED,
      ev.ANNOTATION_REMOVED,
      ev.ANNOTATION_MODIFIED,
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
    try { csAnnotation.state.removeAnnotation(uid); } catch { /* ignore */ }
    deleteRoiMaskMeta(uid);
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
  const toggleRoi = (uid: string, vis: boolean) => {
    try { csAnnotation.visibility.setAnnotationVisibility(uid, vis); } catch { /* ignore */ }
    refresh();
  };
  // マスク（labelmap representation）の表示 On/Off。表示中の全ビューポートへ適用。
  const setMaskVisible = (id: string, visible: boolean) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const vps = (csSeg.state as any).getViewportIdsWithSegmentation(id) as string[] | undefined;
      for (const vp of vps ?? []) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        try { (csSeg.config.visibility as any).setSegmentationRepresentationVisibility(vp, { segmentationId: id, type: LABELMAP }, visible); } catch { /* ignore */ }
      }
      renderAll();
    } catch { /* ignore */ }
    refresh();
  };
  // scope の Z を global("all") ↔ local(原本 index) でトグル。
  const toggleScopeZ = (itemId: string) => {
    const meta = getRoiMaskMeta(itemId);
    const cur = meta?.scope ?? {};
    const base = meta?.origin ?? cur;
    setRoiMaskMeta(itemId, { scope: { ...cur, z: cur.z === "all" ? (base.z ?? 0) : "all" } });
  };
  const deleteMask = (id: string) => {
    if (!window.confirm(t("roiMgr.deleteMaskConfirm"))) return;
    try { csSeg.removeSegmentation(id); } catch { /* ignore */ }
    deleteRoiMaskMeta(id);
    setSelected((s) => { const n = new Set(s); n.delete(id); return n; });
    refresh();
  };

  // ── アクティブ編集対象（D2: モードレス）──
  // 「＋新規マスク」= 直近でセグメンテーションツールを使ったタイルに新規マスクを作成しアクティブ化。
  const addNewMask = async () => {
    const vp = getLastSegViewport();
    if (!vp) { window.alert(t("roiMgr.needSegViewport")); return; }
    setBusy(true);
    try { await createNewMask(vp.viewportId, vp.imageIds); } finally { setBusy(false); }
    refresh();
  };
  const addSegment = () => { addSegmentToActiveMask(); refresh(); };
  const toggleSelect = (id: string) =>
    setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  // 演算結果を表示するビューポート: 選択 Mask を表示中のもの（union）。無ければエンジン全 viewport。
  const viewportsForMasks = (ids: string[]): string[] => {
    const set = new Set<string>();
    for (const id of ids) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const vp of ((csSeg.state as any).getViewportIdsWithSegmentation(id) as string[] | undefined) ?? []) set.add(vp);
      } catch { /* ignore */ }
    }
    if (set.size === 0) {
      try { for (const vp of getRenderingEngine(ENGINE_ID)?.getViewports() ?? []) set.add(vp.id); } catch { /* ignore */ }
    }
    return [...set];
  };
  // ブール演算（or/and/xor/merge）。merge=OR。選択 2 件以上で実行。
  const runCombine = async (op: BoolOp) => {
    const ids = [...selected];
    if (ids.length < 2 || busy) return;
    setBusy(true);
    try {
      const res = await combineMasks(ids, op, viewportsForMasks(ids));
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
  // 3D→2D split: ボリューム Mask を非空スライスごとの単一スライス Mask に分解。
  const runSplitToSlices = async (id: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const created = await splitMaskToSlices(id);
      if (created.length === 0) window.alert(t("roiMgr.opFailed"));
    } finally {
      setBusy(false);
      refresh();
    }
  };
  // ROI 群を ImageJ RoiSet.zip として書き出し（保存優先=ImageJ）。
  const runExportRois = async () => {
    if (busy) return;
    const dtos = annotationsToImageJDtos(rois.map((r) => r.uid));
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
  // Mask の体積統計（行下にインライン表示。再クリックで消す）。
  const runStats = (id: string) => {
    setStats((s) => {
      const n = { ...s };
      if (n[id]) { delete n[id]; return n; }
      const v = maskVolumeStats(id);
      if (v) n[id] = v;
      return n;
    });
  };
  // SPLIT（連結成分分割）。選択 1 件で実行。
  // 元マスクを構成成分（segment 1..N）へ再ラベルして**置換**する（元を残すと同一位置で重なり、
  // 下のマスクが消せない・操作できない混乱を招くため）。元を削除し結果をアクティブ化。
  const runSplit = async () => {
    const ids = [...selected];
    if (ids.length !== 1 || busy) return;
    setBusy(true);
    try {
      const res = await splitMask(ids[0], viewportsForMasks(ids), splitConn);
      if (!res) { window.alert(t("roiMgr.opFailed")); return; }
      try { csSeg.removeSegmentation(ids[0]); } catch { /* ignore */ }
      deleteRoiMaskMeta(ids[0]);
      setSelected(new Set());
      activateMask(res);
    } finally {
      setBusy(false);
      refresh();
    }
  };
  const setMaskStyle = (id: string, style: { fillAlpha?: number; renderFill?: boolean; outlineWidth?: number }) => {
    try {
      csSeg.segmentationStyle.setStyle({ type: LABELMAP, segmentationId: id }, style);
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

  return (
    <div style={panel}>
      <div style={head}>
        <strong style={{ fontSize: 13 }}>{t("roiMgr.title")}</strong>
        <span style={{ flex: 1 }} />
        <button onClick={refresh} style={hbtn} title={t("roiMgr.refresh")}>⟳</button>
        <button onClick={onClose} style={hbtn} title={t("common.close")}>×</button>
      </div>

      <div style={{ ...section, display: "flex", alignItems: "center", gap: 4 }}>
        <span>{t("roiMgr.rois")} ({rois.length})</span>
        <span style={{ flex: 1 }} />
        <input
          ref={importInputRef} type="file" accept=".roi,.zip" style={{ display: "none" }}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) runImportRois(f); e.target.value = ""; }}
        />
        <button onClick={() => importInputRef.current?.click()} disabled={busy} style={opBtn} title={t("roiMgr.importIJ")}>IJ ⬆</button>
        {rois.length > 0 && <button onClick={runExportRois} disabled={busy} style={opBtn} title={t("roiMgr.exportIJ")}>IJ ⬇</button>}
      </div>
      {rois.length === 0 && <div style={empty}>{t("roiMgr.empty")}</div>}
      {rois.map((r) => (
        <div key={r.uid} style={row}>
          <button onClick={() => toggleRoi(r.uid, !r.visible)} style={eyeBtn} title={t("roiMgr.visible")}>{r.visible ? "👁" : "🚫"}</button>
          <input
            type="text" style={name} title={r.tool}
            defaultValue={getRoiMaskMeta(r.uid)?.label ?? r.tool}
            onChange={(e) => setRoiMaskMeta(r.uid, { label: e.target.value })}
          />
          <input type="color" defaultValue="#ffff00" onChange={(e) => setRoiStyle(r.uid, { color: hexToRgb(e.target.value) })} title={t("roiMgr.color")} style={colorInput} />
          <input type="number" min={1} max={10} defaultValue={1} onChange={(e) => setRoiStyle(r.uid, { lineWidth: String(e.target.value) })} title={t("roiMgr.lineWidth")} style={numInput} />
          <input type="checkbox" onChange={(e) => setRoiStyle(r.uid, { fillOpacity: e.target.checked ? 0.3 : 0 })} title={t("roiMgr.fill")} />
          {r.scope && <button onClick={() => toggleScopeZ(r.uid)} style={scopeChip} title={t("roiMgr.scopeToggle")}>{r.scope}</button>}
          {isAreaRoi(r.tool) && <button onClick={() => runRoiToMask(r.uid)} disabled={busy} style={editBtn} title={t("roiMgr.toMask")}>▦</button>}
          {/circle/i.test(r.tool) && <button onClick={() => runDefineSphere(r.uid)} disabled={busy} style={editBtn} title={t("roiMgr.defineSphere")}>◎</button>}
          {/circle/i.test(r.tool) && <button onClick={() => runSphere(r.uid)} disabled={busy} style={editBtn} title={t("roiMgr.toSphere")}>⬤</button>}
          <button onClick={() => setEditId(r.uid)} style={editBtn} title={t("roiMgr.editTitle")}>✎</button>
          <button onClick={() => deleteRoi(r.uid)} style={delBtn} title={t("common.delete")}>🗑</button>
        </div>
      ))}

      <div style={{ ...section, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span>{t("roiMgr.masks")} ({masks.length})</span>
        <button onClick={addNewMask} disabled={busy} style={editBtn} title={t("roiMgr.newMask")}>＋{t("roiMgr.newMaskShort")}</button>
      </div>
      {masks.length === 0 && <div style={empty}>{t("roiMgr.empty")}</div>}
      {masks.map((m) => {
        const isActive = getSegEditTarget().segmentationId === m.id;
        const segs = getMaskSegments(m.id);
        const activeSeg = getSegEditTarget().segmentIndex;
        return (
        <div key={m.id} style={isActive ? activeMaskBox : undefined}>
        <div style={row}>
          <input type="radio" name="graphy-active-mask" checked={isActive} onChange={() => { activateMask(m.id); refresh(); }} title={t("roiMgr.activeMask")} />
          <button onClick={() => setMaskVisible(m.id, !m.visible)} style={eyeBtn} title={t("roiMgr.visible")}>{m.visible ? "👁" : "🚫"}</button>
          <input type="checkbox" checked={selected.has(m.id)} onChange={() => toggleSelect(m.id)} title={t("roiMgr.select")} />
          <input
            type="text" style={name} title={m.id}
            defaultValue={getRoiMaskMeta(m.id)?.label ?? m.label}
            onChange={(e) => setRoiMaskMeta(m.id, { label: e.target.value })}
          />
          <input type="color" defaultValue="#ff0000" onChange={(e) => setMaskColor(m.id, e.target.value)} title={t("roiMgr.color")} style={colorInput} />
          <input
            type="range" min={0} max={1} step={0.05} defaultValue={maskDefaults.fillOpacity}
            onChange={(e) => setMaskStyle(m.id, { fillAlpha: Number(e.target.value) })}
            style={{ width: 56 }} title={t("roiMgr.opacity")}
          />
          <input type="number" min={0} max={10} defaultValue={maskDefaults.outlineWidth} onChange={(e) => setMaskStyle(m.id, { outlineWidth: Number(e.target.value) })} title={t("roiMgr.lineWidth")} style={numInput} />
          <input type="checkbox" defaultChecked onChange={(e) => setMaskStyle(m.id, { renderFill: e.target.checked })} title={t("roiMgr.fill")} />
          {m.scope && <button onClick={() => toggleScopeZ(m.id)} style={scopeChip} title={t("roiMgr.scopeToggleMask")}>{m.scope}</button>}
          <button onClick={() => runStats(m.id)} style={editBtn} title={t("roiMgr.stats")}>Σ</button>
          <button onClick={() => runSplitToSlices(m.id)} disabled={busy} style={editBtn} title={t("roiMgr.toSlices")}>⬚</button>
          <button onClick={() => setEditId(m.id)} style={editBtn} title={t("roiMgr.editTitle")}>✎</button>
          <button onClick={() => deleteMask(m.id)} style={delBtn} title={t("common.delete")}>🗑</button>
        </div>
        {stats[m.id] && (
          <div style={statLine}>
            {t("roiMgr.statVol")}: {stats[m.id].volumeMl.toFixed(2)} mL ({stats[m.id].volumeMm3.toFixed(0)} mm³) ·
            {" "}{t("roiMgr.statVoxels")}: {stats[m.id].voxels.toLocaleString()} · {t("roiMgr.statSlices")}: {stats[m.id].slices}
            {stats[m.id].mean !== undefined && (
              <>
                <br />
                {t("roiMgr.statMean")}: {stats[m.id].mean!.toFixed(1)} ± {stats[m.id].sd!.toFixed(1)} ·
                {" "}min {stats[m.id].min!.toFixed(0)} / max {stats[m.id].max!.toFixed(0)} {stats[m.id].unit}
              </>
            )}
          </div>
        )}
        {isActive && (
          <div style={segLine}>
            <span style={{ color: "#5a6672" }}>{t("roiMgr.segments")}:</span>
            {segs.map((si) => {
              const col = segColorHex(m.id, si);
              return (
              <button
                key={si}
                onClick={() => { activateMask(m.id, si); refresh(); }}
                style={{ ...(si === activeSeg ? segChipActive : segChip), ...(col ? { boxShadow: `inset 5px 0 0 ${col}` } : {}) }}
                title={t("roiMgr.activeSegment")}
              >{si}</button>
              );
            })}
            <input type="color" value={segColorHex(m.id, activeSeg) ?? "#ff0000"} onChange={(e) => { setMaskColor(m.id, e.target.value, activeSeg); refresh(); }} title={t("roiMgr.color")} style={colorInput} />
            <button onClick={addSegment} style={editBtn} title={t("roiMgr.addSegment")}>＋</button>
          </div>
        )}
        </div>
        );
      })}

      {spheres.length > 0 && <div style={section}>{t("roiMgr.spheres")} ({spheres.length})</div>}
      {spheres.map((s) => (
        <div key={s.id} style={row}>
          <input type="checkbox" checked={s.visible} onChange={(e) => updateSphere3D(s.id, { visible: e.target.checked })} title={t("roiMgr.visible")} />
          <input type="text" style={name} defaultValue={s.label ?? "Sphere"} onChange={(e) => updateSphere3D(s.id, { label: e.target.value })} />
          <input type="color" defaultValue={s.color} onChange={(e) => updateSphere3D(s.id, { color: e.target.value })} title={t("roiMgr.color")} style={colorInput} />
          <input type="number" min={0.1} step={0.5} defaultValue={Number(s.radiusMm.toFixed(1))} onChange={(e) => { const v = Number(e.target.value); if (v > 0) updateSphere3D(s.id, { radiusMm: v }); }} title={t("roiMgr.radiusMm")} style={numInput} />
          <span style={{ color: "#9aa6b2", fontSize: 10 }}>mm</span>
          <button onClick={() => runBakeSphere(s.id)} disabled={busy} style={editBtn} title={t("roiMgr.bakeSphere")}>⬤</button>
          <button onClick={() => deleteSphere3D(s.id)} style={delBtn} title={t("common.delete")}>🗑</button>
        </div>
      ))}

      {masks.length > 0 && (
        <div style={opsBar}>
          <span style={{ color: "#5a6672", marginRight: 2 }}>{t("roiMgr.ops")} ({selected.size})</span>
          <button onClick={() => runCombine("or")} disabled={busy || selected.size < 2} style={opBtn} title={t("roiMgr.opMerge")}>{t("roiMgr.merge")}</button>
          <button onClick={() => runCombine("and")} disabled={busy || selected.size < 2} style={opBtn} title={t("roiMgr.opAnd")}>AND</button>
          <button onClick={() => runCombine("xor")} disabled={busy || selected.size < 2} style={opBtn} title={t("roiMgr.opXor")}>XOR</button>
          <button onClick={runSplit} disabled={busy || selected.size !== 1} style={opBtn} title={t("roiMgr.opSplit")}>{t("roiMgr.split")}</button>
          <select value={splitConn} onChange={(e) => setSplitConn(Number(e.target.value) as SplitConnectivity)} title={t("roiMgr.splitConn")} style={{ ...opBtn, padding: "2px 4px" }}>
            <option value={26}>26</option>
            <option value={18}>18</option>
            <option value={6}>6</option>
          </select>
        </div>
      )}

      <div style={note}>{t("roiMgr.m1note")}</div>
      {editId && <RoiMetaEditDialog itemId={editId} onClose={() => { setEditId(null); refresh(); }} />}
    </div>
  );
}

const panel: React.CSSProperties = {
  width: 260, flex: "none", borderLeft: "1px solid #dde4ea", background: "#fafbfc",
  display: "flex", flexDirection: "column", overflowY: "auto", fontSize: 12,
};
const head: React.CSSProperties = { display: "flex", alignItems: "center", gap: 4, padding: "6px 8px", borderBottom: "1px solid #e6eaee", background: "#fff" };
const hbtn: React.CSSProperties = { border: "1px solid #cdd5de", borderRadius: 5, background: "#fff", cursor: "pointer", fontSize: 13, padding: "1px 7px" };
const section: React.CSSProperties = { padding: "6px 8px 2px", fontWeight: 600, color: "#5a6672" };
const row: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6, padding: "3px 8px" };
const name: React.CSSProperties = {
  flex: 1, minWidth: 0, color: "#33404d", fontSize: 12,
  border: "1px solid transparent", borderRadius: 4, background: "transparent", padding: "2px 4px",
};
const delBtn: React.CSSProperties = { border: "1px solid #e3c2c2", borderRadius: 5, background: "#fff", cursor: "pointer", fontSize: 12, padding: "1px 6px" };
const editBtn: React.CSSProperties = { border: "1px solid #cdd5de", borderRadius: 5, background: "#fff", cursor: "pointer", fontSize: 12, padding: "1px 6px" };
const eyeBtn: React.CSSProperties = { border: "none", background: "transparent", cursor: "pointer", fontSize: 13, padding: 0, lineHeight: 1 };
const colorInput: React.CSSProperties = { width: 22, height: 20, padding: 0, border: "1px solid #cdd5de", borderRadius: 3, background: "#fff", cursor: "pointer" };
const numInput: React.CSSProperties = { width: 36, border: "1px solid #cdd5de", borderRadius: 4, fontSize: 11 };
const scopeChip: React.CSSProperties = { fontSize: 10, color: "#5a6672", background: "#eef2f6", border: "1px solid #dde4ea", borderRadius: 4, padding: "1px 4px", whiteSpace: "nowrap", cursor: "pointer" };
const opsBar: React.CSSProperties = { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 4, padding: "6px 8px", borderTop: "1px solid #eef1f4" };
const opBtn: React.CSSProperties = { border: "1px solid #cdd5de", borderRadius: 5, background: "#fff", cursor: "pointer", fontSize: 11, padding: "2px 7px" };
const statLine: React.CSSProperties = { padding: "0 10px 4px 28px", color: "#5a6672", fontSize: 11 };
const empty: React.CSSProperties = { padding: "2px 10px", color: "#9aa6b2" };
const note: React.CSSProperties = { marginTop: "auto", padding: 8, color: "#9aa6b2", fontSize: 11, borderTop: "1px solid #eef1f4" };
// アクティブ編集対象（D2）のハイライトと segment チップ。
const activeMaskBox: React.CSSProperties = { background: "#eef7ff", borderLeft: "3px solid #2b8aef" };
const segLine: React.CSSProperties = { display: "flex", alignItems: "center", gap: 4, padding: "0 10px 4px 28px", fontSize: 11 };
const segChip: React.CSSProperties = { minWidth: 20, border: "1px solid #cdd5de", borderRadius: 4, background: "#fff", cursor: "pointer", fontSize: 11, padding: "1px 6px" };
// アクティブ枠は border shorthand に統一（borderColor 非shorthand との混在で React 警告が出るため）。
const segChipActive: React.CSSProperties = { ...segChip, background: "#2b8aef", color: "#fff", border: "1px solid #2b8aef" };
