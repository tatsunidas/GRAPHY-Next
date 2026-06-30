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
import { useCallback, useEffect, useState } from "react";
import { eventTarget, getRenderingEngine, Enums as csEnums } from "@cornerstonejs/core";
import {
  annotation as csAnnotation,
  segmentation as csSeg,
  Enums as csToolsEnums,
} from "@cornerstonejs/tools";
import { ENGINE_ID } from "../viewer/Viewer2D";
import { getRoiMaskMeta, setRoiMaskMeta, deleteRoiMaskMeta, subscribeRoiMaskStore } from "../viewer/roiMaskStore";
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
interface MaskRow { id: string; label: string; scope: string; }

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
          })),
      );
    } catch {
      setMasks([]);
    }
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
    return () => {
      for (const n of names) eventTarget.removeEventListener(n, refresh);
      unsub();
    };
  }, [refresh]);

  const deleteRoi = (uid: string) => {
    try { csAnnotation.state.removeAnnotation(uid); } catch { /* ignore */ }
    deleteRoiMaskMeta(uid);
    refresh();
  };
  // マスク色: そのセグメンテーションを表示中の全ビューポートで segment 1 の色を変更。
  const setMaskColor = (id: string, hex: string) => {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
    if (!m) return;
    const color: [number, number, number, number] = [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16), 255];
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const vps = (csSeg.state as any).getViewportIdsWithSegmentation(id) as string[] | undefined;
      for (const vpId of vps ?? []) {
        try { csSeg.config.color.setSegmentIndexColor(vpId, id, 1, color); } catch { /* ignore */ }
      }
      renderAll();
    } catch {
      /* ignore */
    }
  };
  const toggleRoi = (uid: string, vis: boolean) => {
    try { csAnnotation.visibility.setAnnotationVisibility(uid, vis); } catch { /* ignore */ }
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
    refresh();
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

      <div style={section}>{t("roiMgr.rois")} ({rois.length})</div>
      {rois.length === 0 && <div style={empty}>{t("roiMgr.empty")}</div>}
      {rois.map((r) => (
        <div key={r.uid} style={row}>
          <input type="checkbox" checked={r.visible} onChange={(e) => toggleRoi(r.uid, e.target.checked)} title={t("roiMgr.visible")} />
          <input
            type="text" style={name} title={r.tool}
            defaultValue={getRoiMaskMeta(r.uid)?.label ?? r.tool}
            onChange={(e) => setRoiMaskMeta(r.uid, { label: e.target.value })}
          />
          <input type="color" defaultValue="#ffff00" onChange={(e) => setRoiStyle(r.uid, { color: hexToRgb(e.target.value) })} title={t("roiMgr.color")} style={colorInput} />
          <input type="number" min={1} max={10} defaultValue={1} onChange={(e) => setRoiStyle(r.uid, { lineWidth: String(e.target.value) })} title={t("roiMgr.lineWidth")} style={numInput} />
          <input type="checkbox" onChange={(e) => setRoiStyle(r.uid, { fillOpacity: e.target.checked ? 0.3 : 0 })} title={t("roiMgr.fill")} />
          {r.scope && <button onClick={() => toggleScopeZ(r.uid)} style={scopeChip} title={t("roiMgr.scopeToggle")}>{r.scope}</button>}
          <button onClick={() => setEditId(r.uid)} style={editBtn} title={t("roiMgr.editTitle")}>✎</button>
          <button onClick={() => deleteRoi(r.uid)} style={delBtn} title={t("common.delete")}>🗑</button>
        </div>
      ))}

      <div style={section}>{t("roiMgr.masks")} ({masks.length})</div>
      {masks.length === 0 && <div style={empty}>{t("roiMgr.empty")}</div>}
      {masks.map((m) => (
        <div key={m.id} style={row}>
          <input
            type="text" style={name} title={m.id}
            defaultValue={getRoiMaskMeta(m.id)?.label ?? m.label}
            onChange={(e) => setRoiMaskMeta(m.id, { label: e.target.value })}
          />
          <input type="color" defaultValue="#ff0000" onChange={(e) => setMaskColor(m.id, e.target.value)} title={t("roiMgr.color")} style={colorInput} />
          <input
            type="range" min={0} max={1} step={0.05} defaultValue={0.5}
            onChange={(e) => setMaskStyle(m.id, { fillAlpha: Number(e.target.value) })}
            style={{ width: 56 }} title={t("roiMgr.opacity")}
          />
          <input type="number" min={0} max={10} defaultValue={0} onChange={(e) => setMaskStyle(m.id, { outlineWidth: Number(e.target.value) })} title={t("roiMgr.lineWidth")} style={numInput} />
          <input type="checkbox" defaultChecked onChange={(e) => setMaskStyle(m.id, { renderFill: e.target.checked })} title={t("roiMgr.fill")} />
          {m.scope && <button onClick={() => toggleScopeZ(m.id)} style={scopeChip} title={t("roiMgr.scopeToggle")}>{m.scope}</button>}
          <button onClick={() => setEditId(m.id)} style={editBtn} title={t("roiMgr.editTitle")}>✎</button>
          <button onClick={() => deleteMask(m.id)} style={delBtn} title={t("common.delete")}>🗑</button>
        </div>
      ))}

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
const colorInput: React.CSSProperties = { width: 22, height: 20, padding: 0, border: "1px solid #cdd5de", borderRadius: 3, background: "#fff", cursor: "pointer" };
const numInput: React.CSSProperties = { width: 36, border: "1px solid #cdd5de", borderRadius: 4, fontSize: 11 };
const scopeChip: React.CSSProperties = { fontSize: 10, color: "#5a6672", background: "#eef2f6", border: "1px solid #dde4ea", borderRadius: 4, padding: "1px 4px", whiteSpace: "nowrap", cursor: "pointer" };
const empty: React.CSSProperties = { padding: "2px 10px", color: "#9aa6b2" };
const note: React.CSSProperties = { marginTop: "auto", padding: 8, color: "#9aa6b2", fontSize: 11, borderTop: "1px solid #eef1f4" };
