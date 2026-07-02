/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 3D シーンオブジェクト管理パネル（`fw/3d-viewer-design.md` §8.6）。旧 GRAPHY `SceneObjectTableModel` に対応。
 *
 * メッシュ / 3D ROI の一覧・可視・色・透明度・計測を管理し、以下の変換/入出力を提供:
 *  - 既存マスク（Cornerstone segmentation, 2D ビューアで作成）→ 3D ROI として読み込み
 *  - STL インポート → メッシュ
 *  - 選択 ROI → メッシュ生成 / 選択メッシュ → 3D ROI 生成（表示ボリューム幾何へボクセル化）
 *  - 選択オブジェクト → STL 書き出し
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { segmentation as csSeg } from "@cornerstonejs/tools";
import { useI18n } from "../i18n/i18n";
import { getRoiMaskMeta } from "../viewer/roiMaskStore";
import { buildLabelVolumeFromSegmentation, type VolumeGeom } from "../viewer/labelVolume";
import { exportStlBinary, importObj, importStl } from "../viewer/mesh3d";
import {
  addMeshObject,
  addRoiObject,
  convertMeshToRoi,
  convertRoiToMesh,
  extractCenterlineFromObject,
  getObjectPolyData,
  removeObject,
  setObjectColor,
  setObjectDisplayMode,
  setObjectOpacity,
  setObjectVisible,
  startEndoscopy,
  stopEndoscopy,
} from "./scene3d";
import { EndoscopyControls } from "./EndoscopyControls";
import type { EndoController } from "../viewer/endoscopy";
import { removeMeasurement3D } from "./scene3d";
import { useMeasurements } from "./measureStore";
import { undo, redo, useUndoState } from "./undoStore";
import {
  selectSceneObject,
  useSceneObjects,
  type SceneDisplayMode,
  type SceneObject,
} from "./scene3dStore";

/** [0..1] RGB → #rrggbb。 */
function rgbToHex(c: [number, number, number]): string {
  const h = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v * 255)))
      .toString(16)
      .padStart(2, "0");
  return `#${h(c[0])}${h(c[1])}${h(c[2])}`;
}
/** #rrggbb → [0..1] RGB。 */
function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) return [1, 1, 1];
  return [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255];
}

function download(name: string, buf: ArrayBuffer): void {
  const blob = new Blob([buf], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function SceneObjectPanel({
  geom,
  onStartCut,
  onAnalyzeCenterline,
  onRepairMesh,
  measureMode,
  onToggleMeasure,
  endoPathMode,
  onToggleEndoPath,
}: {
  geom: VolumeGeom | null;
  onStartCut?: (id: string) => void;
  onAnalyzeCenterline?: (id: string, name: string) => void;
  onRepairMesh?: (id: string, name: string) => void;
  measureMode?: boolean;
  onToggleMeasure?: () => void;
  endoPathMode?: boolean;
  onToggleEndoPath?: () => void;
}) {
  const { t } = useI18n();
  const objects = useSceneObjects();
  const measures = useMeasurements();
  const fileRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [endoCtrl, setEndoCtrl] = useState<EndoController | null>(null);
  const undoState = useUndoState();

  // アンマウント時に内視鏡を確実に終了。
  useEffect(() => {
    return () => {
      stopEndoscopy();
    };
  }, []);

  // Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y の Undo/Redo（入力欄フォーカス時は無視）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement | null;
      if (tgt && /^(INPUT|TEXTAREA|SELECT)$/.test(tgt.tagName)) return;
      const k = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && k === "z") {
        e.preventDefault();
        undo();
      } else if ((e.ctrlKey || e.metaKey) && (k === "y" || (e.shiftKey && k === "z"))) {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const selected = objects.find((o) => o.selected) ?? null;

  // 利用可能なマスク（Cornerstone segmentation）。
  const masks = useMemo(() => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const segs = ((csSeg.state as any).getSegmentations?.() ?? []) as {
        segmentationId: string;
        label?: string;
      }[];
      return segs.map((s) => ({
        id: s.segmentationId,
        label: getRoiMaskMeta(s.segmentationId)?.label ?? s.label ?? s.segmentationId,
      }));
    } catch {
      return [];
    }
    // objects を依存に入れて、ROI 追加後にも再評価（新規マスク生成に追従）。
  }, [objects.length]);

  const withBusy = async (fn: () => void | Promise<void>) => {
    setBusy(true);
    setStatus("");
    // 「処理中」表示を先に描画させてから重い同期処理（骨格化/ボクセル化等）を実行。
    await new Promise((r) => setTimeout(r, 16));
    try {
      await Promise.resolve(fn());
    } catch (e) {
      setStatus(`${t("scene3d.error")}: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const onAddRoiFromMask = (segmentationId: string) => {
    if (!segmentationId) return;
    void withBusy(() => {
      const lv = buildLabelVolumeFromSegmentation(segmentationId);
      if (!lv) {
        setStatus(t("scene3d.error"));
        return;
      }
      const label = getRoiMaskMeta(segmentationId)?.label;
      const id = addRoiObject(lv, { name: label ? `${label}` : undefined });
      if (!id) setStatus(t("scene3d.error"));
    });
  };

  const onImportFile = (file: File) => {
    void withBusy(async () => {
      const lower = file.name.toLowerCase();
      let id: string | null = null;
      if (lower.endsWith(".obj")) {
        const text = await file.text();
        const pd = importObj(text);
        if (pd) id = addMeshObject(pd, { name: file.name });
      } else {
        const buf = await file.arrayBuffer();
        const pd = importStl(buf);
        if (pd) id = addMeshObject(pd, { name: file.name });
      }
      if (!id) setStatus(t("scene3d.importFailed"));
    });
  };

  const onRoiToMesh = () => {
    if (!selected || selected.kind !== "roi") return;
    void withBusy(() => {
      const id = convertRoiToMesh(selected.id);
      if (!id) setStatus(t("scene3d.convertFailed"));
    });
  };

  const onMeshToRoi = () => {
    if (!selected || selected.kind !== "mesh" || !geom) return;
    void withBusy(() => {
      const id = convertMeshToRoi(selected.id, geom);
      if (!id) setStatus(t("scene3d.convertFailed"));
    });
  };

  const onExtractCenterline = () => {
    if (!selected || (selected.kind !== "roi" && selected.kind !== "mesh")) return;
    void withBusy(() => {
      const res = extractCenterlineFromObject(selected.id);
      if (!res) {
        setStatus(t("scene3d.centerlineFailed"));
        return;
      }
      const s = res.summary;
      setStatus(
        t("scene3d.centerlineDone", {
          branches: String(s.branches),
          length: s.totalMm.toFixed(0),
        }),
      );
    });
  };

  const onFlyThrough = () => {
    if (!selected || selected.kind !== "centerline") return;
    const ctrl = startEndoscopy(selected.id);
    if (!ctrl) {
      setStatus(t("scene3d.error"));
      return;
    }
    setEndoCtrl(ctrl);
  };

  const onExitEndo = () => {
    stopEndoscopy();
    setEndoCtrl(null);
  };

  const onExportStl = () => {
    if (!selected) return;
    const pd = getObjectPolyData(selected.id);
    if (!pd) return;
    const buf = exportStlBinary(pd);
    if (!buf) {
      setStatus(t("scene3d.exportFailed"));
      return;
    }
    download(`${selected.name.replace(/\s+/g, "_")}.stl`, buf);
  };

  const num = (v: number | undefined, digits = 1) =>
    v == null ? "—" : v.toLocaleString(undefined, { maximumFractionDigits: digits });

  return (
    <div style={wrap}>
      <div style={headerRow}>
        <span style={label}>{t("scene3d.title")}</span>
        <div style={undoBtns}>
          <button
            style={undoState.canUndo ? undoBtn : undoBtnDisabled}
            disabled={!undoState.canUndo}
            title={undoState.undoLabel ? `${t("undo.undo")}: ${undoState.undoLabel}` : t("undo.undo")}
            onClick={() => undo()}
          >
            ↶
          </button>
          <button
            style={undoState.canRedo ? undoBtn : undoBtnDisabled}
            disabled={!undoState.canRedo}
            title={undoState.redoLabel ? `${t("undo.redo")}: ${undoState.redoLabel}` : t("undo.redo")}
            onClick={() => redo()}
          >
            ↷
          </button>
        </div>
      </div>

      {/* アクション: マスク→ROI, STL インポート */}
      <div style={actionsCol}>
        <select
          style={select}
          value=""
          disabled={busy || masks.length === 0}
          onChange={(e) => {
            onAddRoiFromMask(e.target.value);
            e.currentTarget.value = "";
          }}
        >
          <option value="">
            {masks.length ? t("scene3d.importRoi") : t("scene3d.noMasks")}
          </option>
          {masks.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
        <button style={btn} disabled={busy} onClick={() => fileRef.current?.click()}>
          {t("scene3d.importStl")}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".stl,.obj"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onImportFile(f);
            e.currentTarget.value = "";
          }}
        />
      </div>

      {/* オブジェクト一覧 */}
      {objects.length === 0 ? (
        <div style={empty}>{t("scene3d.noObjects")}</div>
      ) : (
        <div style={listCol}>
          {objects.map((o) => (
            <SceneRow
              key={o.id}
              o={o}
              onSelect={() => selectSceneObject(o.selected ? null : o.id)}
              onVisible={(v) => setObjectVisible(o.id, v)}
              onColor={(hex) => setObjectColor(o.id, hexToRgb(hex))}
              onOpacity={(v) => setObjectOpacity(o.id, v)}
              onDelete={() => {
                removeObject(o.id);
              }}
              kindLabel={t(`scene3d.${o.kind}`)}
            />
          ))}
        </div>
      )}

      {/* 選択オブジェクトのアクション/計測 */}
      {selected && (
        <div style={detailBox}>
          <div style={modeRow}>
            <span style={modeLabel}>{t("scene3d.displayMode")}</span>
            {(["float", "embedded"] as SceneDisplayMode[]).map((m) => (
              <button
                key={m}
                style={selected.displayMode === m ? modeBtnActive : modeBtn}
                title={t(`scene3d.displayMode.${m}.hint`)}
                onClick={() => setObjectDisplayMode(selected.id, m)}
              >
                {t(`scene3d.displayMode.${m}`)}
              </button>
            ))}
          </div>
          <div style={detailActions}>
            {selected.kind === "roi" && (
              <button style={btnSm} disabled={busy} onClick={onRoiToMesh}>
                {t("scene3d.roiToMesh")}
              </button>
            )}
            {selected.kind === "mesh" && (
              <button style={btnSm} disabled={busy || !geom} onClick={onMeshToRoi}>
                {t("scene3d.meshToRoi")}
              </button>
            )}
            {selected.kind !== "centerline" && (
              <button style={btnSm} disabled={busy} onClick={onExportStl}>
                {t("scene3d.exportStl")}
              </button>
            )}
          </div>
          {selected.kind === "roi" && onStartCut && (
            <button
              style={wideBtn}
              disabled={busy}
              title={t("scene3d.cut.hint")}
              onClick={() => onStartCut(selected.id)}
            >
              {t("scene3d.cut")}
            </button>
          )}
          {(selected.kind === "roi" || selected.kind === "mesh") && (
            <button
              style={wideBtn}
              disabled={busy || (selected.kind === "mesh" && !geom)}
              title={t("scene3d.centerline.hint")}
              onClick={onExtractCenterline}
            >
              {t("scene3d.centerline")}
            </button>
          )}
          {onAnalyzeCenterline && (
            <button
              style={wideBtn}
              disabled={busy || (selected.kind === "mesh" && !geom)}
              title={t("scene3d.analyze.hint")}
              onClick={() => onAnalyzeCenterline(selected.id, selected.name)}
            >
              {t("scene3d.analyze")}
            </button>
          )}
          {selected.kind === "mesh" && onRepairMesh && (
            <button
              style={wideBtn}
              disabled={busy}
              title={t("scene3d.repair.hint")}
              onClick={() => onRepairMesh(selected.id, selected.name)}
            >
              {t("scene3d.repair")}
            </button>
          )}
          {selected.kind === "centerline" && !endoCtrl && (
            <button style={flyBtn} onClick={onFlyThrough}>
              {t("scene3d.flyThrough")}
            </button>
          )}
          <dl style={statsDl}>
            {selected.kind === "centerline" ? (
              <Stat k={t("scene3d.length")} v={`${num(selected.lengthMm, 1)} mm`} />
            ) : (
              <>
                {selected.voxels != null && (
                  <Stat k={t("scene3d.voxels")} v={num(selected.voxels, 0)} />
                )}
                <Stat k={t("scene3d.volume")} v={`${num(selected.volumeMl, 2)} mL`} />
                <Stat k={t("scene3d.area")} v={`${num(selected.surfaceAreaMm2, 0)} mm²`} />
                {selected.diameters && (
                  <Stat
                    k={t("scene3d.diameters")}
                    v={selected.diameters.map((d) => num(d, 1)).join(" / ") + " mm"}
                  />
                )}
                <Stat k={t("scene3d.triangles")} v={num(selected.numTriangles, 0)} />
              </>
            )}
          </dl>
        </div>
      )}

      {/* 3D 計測（ルーラー）: 表面 2 点間の実 mm 距離 */}
      {onToggleMeasure && (
        <div style={measureBox}>
          <button style={measureMode ? measureBtnActive : measureBtn} onClick={onToggleMeasure}>
            {measureMode ? t("measure.stop") : t("measure.start")}
          </button>
          {measures.length > 0 && (
            <div style={measureList}>
              {measures.map((m, i) => (
                <div key={m.id} style={measureRow}>
                  <span style={measureName}>
                    {t("measure.item")} {i + 1}
                  </span>
                  <span style={measureVal}>{m.distMm.toFixed(1)} mm</span>
                  <button style={delBtn} title="delete" onClick={() => removeMeasurement3D(m.id)}>
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
          {onToggleEndoPath && (
            <button style={endoPathMode ? measureBtnActive : measureBtn} onClick={onToggleEndoPath}>
              {endoPathMode ? t("endoPath.stop") : t("endoPath.start")}
            </button>
          )}
        </div>
      )}

      {busy && <div style={hint}>{t("scene3d.busy")}</div>}
      {status && <div style={errText}>{status}</div>}

      {endoCtrl && <EndoscopyControls controller={endoCtrl} onExit={onExitEndo} />}
    </div>
  );
}

function SceneRow({
  o,
  onSelect,
  onVisible,
  onColor,
  onOpacity,
  onDelete,
  kindLabel,
}: {
  o: SceneObject;
  onSelect: () => void;
  onVisible: (v: boolean) => void;
  onColor: (hex: string) => void;
  onOpacity: (v: number) => void;
  onDelete: () => void;
  kindLabel: string;
}) {
  return (
    <div style={o.selected ? rowSel : row}>
      <div style={rowTop}>
        <input
          type="checkbox"
          checked={o.visible}
          title="visible"
          onChange={(e) => onVisible(e.target.checked)}
        />
        <input
          type="color"
          value={rgbToHex(o.color)}
          title="color"
          style={colorInput}
          onChange={(e) => onColor(e.target.value)}
        />
        <span style={rowName} onClick={onSelect} title={o.name}>
          <span style={kindTag}>{kindLabel}</span>
          {o.name}
        </span>
        <button style={delBtn} title="delete" onClick={onDelete}>
          ×
        </button>
      </div>
      <input
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={o.opacity}
        style={opSlider}
        onChange={(e) => onOpacity(Number(e.target.value))}
      />
    </div>
  );
}

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <div style={statRow}>
      <dt style={statK}>{k}</dt>
      <dd style={statV}>{v}</dd>
    </div>
  );
}

// ── styles ────────────────────────────────────────────────────
const wrap: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 8 };
const headerRow: React.CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between" };
const undoBtns: React.CSSProperties = { display: "flex", gap: 4 };
const undoBtn: React.CSSProperties = {
  width: 26,
  height: 22,
  background: "#1b2126",
  color: "#e6eaee",
  border: "1px solid #2c343b",
  borderRadius: 5,
  cursor: "pointer",
  fontSize: 13,
  lineHeight: "18px",
  padding: 0,
};
const undoBtnDisabled: React.CSSProperties = { ...undoBtn, color: "#4a545e", cursor: "default", opacity: 0.5 };
const label: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: "#7f8b96",
  textTransform: "uppercase",
  letterSpacing: 0.4,
};
const actionsCol: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 6 };
const select: React.CSSProperties = {
  background: "#1b2126",
  color: "#e6eaee",
  border: "1px solid #2c343b",
  borderRadius: 5,
  fontSize: 12,
  padding: "5px 6px",
};
const btn: React.CSSProperties = {
  padding: "6px 8px",
  background: "#1b2126",
  color: "#e6eaee",
  border: "1px solid #2c343b",
  borderRadius: 5,
  cursor: "pointer",
  fontSize: 12,
};
const btnSm: React.CSSProperties = { ...btn, padding: "5px 6px", fontSize: 11, flex: 1 };
const wideBtn: React.CSSProperties = { ...btn, width: "100%", padding: "6px 8px", fontSize: 12 };
const flyBtn: React.CSSProperties = {
  ...btn,
  width: "100%",
  padding: "8px",
  fontSize: 13,
  background: "#0b5cad",
  border: "1px solid #0b5cad",
  color: "#fff",
  fontWeight: 600,
};
const listCol: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  maxHeight: 260,
  overflowY: "auto",
};
const row: React.CSSProperties = {
  border: "1px solid #23292f",
  borderRadius: 5,
  padding: "5px 6px",
  background: "#12161a",
  display: "flex",
  flexDirection: "column",
  gap: 4,
};
const rowSel: React.CSSProperties = { ...row, border: "1px solid #0b5cad", background: "#0e2033" };
const rowTop: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6 };
const rowName: React.CSSProperties = {
  flex: 1,
  fontSize: 12,
  color: "#dbe2e8",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  cursor: "pointer",
};
const kindTag: React.CSSProperties = {
  fontSize: 9,
  color: "#8b97a3",
  border: "1px solid #2c343b",
  borderRadius: 3,
  padding: "0 4px",
  marginRight: 5,
};
const colorInput: React.CSSProperties = {
  width: 22,
  height: 18,
  padding: 0,
  border: "1px solid #2c343b",
  background: "transparent",
  cursor: "pointer",
};
const opSlider: React.CSSProperties = { width: "100%" };
const delBtn: React.CSSProperties = {
  width: 18,
  height: 18,
  lineHeight: "16px",
  textAlign: "center",
  background: "transparent",
  color: "#9aa6b2",
  border: "1px solid #2c343b",
  borderRadius: 4,
  cursor: "pointer",
  fontSize: 12,
  padding: 0,
};
const empty: React.CSSProperties = { fontSize: 11, color: "#5a6672", lineHeight: 1.5 };
const detailBox: React.CSSProperties = {
  borderTop: "1px solid #23292f",
  paddingTop: 8,
  display: "flex",
  flexDirection: "column",
  gap: 8,
};
const detailActions: React.CSSProperties = { display: "flex", gap: 6 };
const modeRow: React.CSSProperties = { display: "flex", alignItems: "center", gap: 4 };
const modeLabel: React.CSSProperties = { fontSize: 10, color: "#8b97a3", marginRight: 2 };
const modeBtn: React.CSSProperties = {
  flex: 1,
  padding: "4px 4px",
  background: "#1b2126",
  color: "#c7d0d8",
  border: "1px solid #2c343b",
  borderRadius: 4,
  cursor: "pointer",
  fontSize: 11,
};
const modeBtnActive: React.CSSProperties = {
  ...modeBtn,
  background: "#0b5cad",
  color: "#fff",
  border: "1px solid #0b5cad",
};
const statsDl: React.CSSProperties = { margin: 0, display: "flex", flexDirection: "column", gap: 2 };
const statRow: React.CSSProperties = { display: "flex", justifyContent: "space-between", gap: 8 };
const statK: React.CSSProperties = { margin: 0, fontSize: 11, color: "#8b97a3" };
const statV: React.CSSProperties = { margin: 0, fontSize: 11, color: "#dbe2e8", fontVariantNumeric: "tabular-nums" };
const hint: React.CSSProperties = { fontSize: 11, color: "#7a8794" };
const errText: React.CSSProperties = { fontSize: 11, color: "#ff9b9b" };
const measureBox: React.CSSProperties = {
  borderTop: "1px solid #23292f",
  paddingTop: 8,
  display: "flex",
  flexDirection: "column",
  gap: 6,
};
const measureBtn: React.CSSProperties = { ...btn, width: "100%" };
const measureBtnActive: React.CSSProperties = {
  ...measureBtn,
  background: "#7a5c12",
  color: "#fff",
  border: "1px solid #a9820f",
};
const measureList: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 3 };
const measureRow: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  fontSize: 11,
  color: "#dbe2e8",
};
const measureName: React.CSSProperties = { flex: 1, color: "#8b97a3" };
const measureVal: React.CSSProperties = { fontVariantNumeric: "tabular-nums", color: "#ffe9a6" };
