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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../i18n/i18n";
import { buildLabelVolumeFromSegmentation, type LabelVolume, type VolumeGeom } from "../viewer/labelVolume";
import { exportStlBinary, importObj, importStl } from "../viewer/mesh3d";
import { framesToLabelVolume } from "../viewer/maskFrames";
import { rtStructRoiToLabelVolume } from "../viewer/rtstructToLabelVolume";
import { rasterizeSphereToLabelVolume } from "../viewer/sphereRaster";
import { collectLocalRois, requestRemoteRois, requestRemoteMaskFrames } from "../viewer/maskBridge";
import { announceKey, dedupeAnnounce, type AnnounceEntry } from "../viewer/maskBridgeCore";
import { filterRtRois, filterSegSegments } from "../viewer/serverRoiFilter";
import { fetchInstances, fetchSeries, readDicomSeg, readDicomRtStruct } from "../api";
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
  sceneSourceKey,
  selectSceneObject,
  useSceneObjects,
  type SceneDisplayMode,
  type SceneObject,
  type SceneObjectSource,
} from "./scene3dStore";

/** 取り込み候補の 2D ROI。windowId が null ならこのウィンドウ自身が持つもの。 */
type ListedRoi = AnnounceEntry & { windowId: string | null };

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
  sopToK,
  onStartCut,
  onAnalyzeCenterline,
  onRepairMesh,
  measureMode,
  onToggleMeasure,
  endoPathMode,
  onToggleEndoPath,
  studyUid,
  seriesUid,
  ctxC,
  ctxT,
  isDemo,
}: {
  geom: VolumeGeom | null;
  /** 体積のスライス順の SOP → k。2D の ROI を、描かれている画像と同じスライスに載せる。 */
  sopToK?: ReadonlyMap<string, number>;
  onStartCut?: (id: string) => void;
  onAnalyzeCenterline?: (id: string, name: string) => void;
  onRepairMesh?: (id: string, name: string) => void;
  measureMode?: boolean;
  onToggleMeasure?: () => void;
  endoPathMode?: boolean;
  onToggleEndoPath?: () => void;
  /** 他ウィンドウ（2D Viewer 等）のマスクをウィンドウ間同期で取り込むためのスコープ。
   * `fw/mask-driven-pipelines-gap-analysis.md` 課題#1。 */
  studyUid?: string;
  seriesUid?: string;
  /** 3D で表示中のチャンネル/タイムフレーム（2D の ROI を C/T で絞る）。 */
  ctxC?: number;
  ctxT?: number;
  /** 公開デモ。クライアント完結でバックエンドに来ないため DemoModeFilter では止められない
   * STL/OBJ インポートボタンを隠す。 */
  isDemo?: boolean;
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

  // 2D ビューアの ROI（塗りは segment 単位・パラメトリック球）。別ウィンドウは BroadcastChannel、
  // 同じウィンドウ（モバイル等）はローカルの状態から作り、同じ一覧にまとめる。
  const [roiList, setRoiList] = useState<ListedRoi[]>([]);
  const [roiOpen, setRoiOpen] = useState(false);
  const refreshRois = useCallback(async () => {
    if (!studyUid || !seriesUid) {
      setRoiList([]);
      return;
    }
    const q = { studyUid, seriesUid, c: ctxC, t: ctxT };
    const local: ListedRoi[] = collectLocalRois(q).map((e) => ({ ...e, windowId: null }));
    const remote = await requestRemoteRois(q);
    setRoiList(dedupeAnnounce([...local, ...remote]));
  }, [studyUid, seriesUid, ctxC, ctxT]);
  useEffect(() => {
    void refreshRois();
  }, [refreshRois]);

  const importedKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const o of objects) {
      const k = sceneSourceKey(o.source);
      if (k) keys.add(k);
    }
    return keys;
  }, [objects]);

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

  const rgb01 = (c: [number, number, number] | null): [number, number, number] | undefined =>
    c ? [c[0] / 255, c[1] / 255, c[2] / 255] : undefined;

  // 2D の ROI 1 件を 3D ROI として追加する。名前と色は 2D の行と同じ。成功なら true。
  const importRoiEntry = async (e: ListedRoi): Promise<boolean> => {
    if (!geom || !seriesUid) return false;
    let lv: LabelVolume | null = null;
    // 2D 側で求めた体積（2D の Σ³ と同じ値）。ウィンドウ間で受け取ったときだけ。
    let vol2d: { volumeMm3?: number; depthSource?: SceneObject["volumeDepthSource"] } | null = null;
    if (e.kind === "sphere") {
      lv = rasterizeSphereToLabelVolume(geom, e.center, e.radiusMm);
    } else if (e.windowId == null) {
      lv = buildLabelVolumeFromSegmentation(e.segmentationId, e.segmentIndex);
    } else {
      const frames = await requestRemoteMaskFrames(e.windowId, e.segmentationId, e.segmentIndex);
      lv = frames ? framesToLabelVolume(frames, geom, e.segmentIndex, sopToK) : null;
      if (frames?.depthSource) vol2d = { volumeMm3: frames.volumeMm3, depthSource: frames.depthSource };
    }
    if (!lv) return false;
    const source: SceneObjectSource =
      e.kind === "sphere"
        ? { origin: "2d", seriesUid, c: e.c, t: e.t, sphereId: e.sphereId }
        : { origin: "2d", seriesUid, c: e.c, t: e.t, segmentationId: e.segmentationId, segmentIndex: e.segmentIndex };
    return !!addRoiObject(lv, {
      name: e.label,
      color: rgb01(e.color),
      source,
      ...(vol2d ? { volumeOverride: vol2d } : {}),
    });
  };

  const onAddRoi = (e: ListedRoi) => {
    void withBusy(async () => {
      if (!(await importRoiEntry(e))) setStatus(t("scene3d.remoteMaskFailed"));
    });
  };

  // 取り込み済み（source が同じ）は飛ばす。
  const onAddAllRois = () => {
    void withBusy(async () => {
      let failed = 0;
      for (const e of roiList) {
        if (importedKeys.has(announceKey(e))) continue;
        if (!(await importRoiEntry(e))) failed++;
      }
      if (failed > 0) setStatus(t("scene3d.remoteMaskFailed"));
    });
  };

  // 表示中スタディの SEG/RTSTRUCT のうち、表示中シリーズを参照するものをサーバ（dcm4chee 経由）から取り込む。
  // 参照の判定は SOP Instance UID（backend が返すフレーム/輪郭の参照）と表示中シリーズのインスタンス集合の突き合わせ。
  const onFetchServerMasks = () => {
    if (!studyUid || !seriesUid || !geom) return;
    void withBusy(async () => {
      let added = 0;
      const source: SceneObjectSource = { origin: "server", seriesUid };
      const [seriesList, instances] = await Promise.all([
        fetchSeries(studyUid).catch(() => []),
        fetchInstances(studyUid, seriesUid).catch(() => []),
      ]);
      const sops = new Set(instances.map((i) => i.sopInstanceUid));

      const segSeries = seriesList.filter((s) => (s.modality ?? "").toUpperCase() === "SEG");
      for (const s of segSeries) {
        const result = await readDicomSeg(studyUid, s.seriesInstanceUid).catch(() => null);
        if (!result?.segments.length) continue;
        for (const seg of filterSegSegments(result.segments, sops)) {
          const lv = framesToLabelVolume(result, geom, seg.number, sopToK);
          if (!lv) continue;
          const id = addRoiObject(lv, { name: seg.label || seg.description || undefined, color: rgb01(seg.color), source });
          if (id) added++;
        }
      }

      const rtSeries = seriesList.filter((s) => (s.modality ?? "").toUpperCase() === "RTSTRUCT");
      for (const s of rtSeries) {
        const rois = await readDicomRtStruct(studyUid, s.seriesInstanceUid).catch(() => []);
        for (const roi of filterRtRois(rois, sops)) {
          const lv = rtStructRoiToLabelVolume(roi, geom, 1, sopToK);
          if (!lv) continue;
          const color: [number, number, number] | null =
            roi.color && roi.color.length >= 3 ? [roi.color[0], roi.color[1], roi.color[2]] : null;
          const id = addRoiObject(lv, { name: roi.name, color: rgb01(color), source });
          if (id) added++;
        }
      }

      setStatus(added > 0 ? t("scene3d.serverFetchDone", { count: String(added) }) : t("scene3d.serverFetchEmpty"));
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

      {/* アクション: 2D の ROI → 3D ROI, サーバの SEG/RTSTRUCT, STL インポート */}
      <div style={actionsCol}>
        {studyUid && seriesUid && (
          <>
            <button
              style={btn}
              disabled={busy}
              onClick={() => {
                if (!roiOpen) void refreshRois();
                setRoiOpen((v) => !v);
              }}
            >
              {t("scene3d.importRoi")} {roiOpen ? "▴" : "▾"}
            </button>
            {roiOpen && (
              <div style={roiBox}>
                <div style={roiBoxHead}>
                  <button style={btnSm} disabled={busy || !geom || roiList.length === 0} onClick={onAddAllRois}>
                    {t("scene3d.addAllRois")}
                  </button>
                  <button style={btnSm} disabled={busy} title={t("scene3d.refreshRois")} onClick={() => void refreshRois()}>
                    ⟳
                  </button>
                </div>
                {roiList.length === 0 ? (
                  <div style={empty}>{t("scene3d.noRoisIn2d")}</div>
                ) : (
                  roiList.map((e) => {
                    const done = importedKeys.has(announceKey(e));
                    const col = e.color ? `rgb(${e.color[0]},${e.color[1]},${e.color[2]})` : "#8a96a3";
                    return (
                      <div key={announceKey(e)} style={roiItem}>
                        <span style={{ color: col }} title={e.kind === "sphere" ? "sphere" : "painted"}>
                          {e.kind === "sphere" ? "◍" : "▨"}
                        </span>
                        <span style={roiItemName} title={e.label}>
                          {e.label}
                        </span>
                        {done ? (
                          <span style={roiDone}>{t("scene3d.imported")}</span>
                        ) : (
                          <button style={btnSm} disabled={busy || !geom} onClick={() => onAddRoi(e)}>
                            {t("scene3d.addRoi")}
                          </button>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            )}
          </>
        )}
        {studyUid && geom && (
          <button style={btn} disabled={busy} title={t("scene3d.fetchServerMasks.hint")} onClick={onFetchServerMasks}>
            {t("scene3d.fetchServerMasks")}
          </button>
        )}
        {!isDemo && (
          <>
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
          </>
        )}
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
              {t("scene3d.extractCenterline")}
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
                <Stat
                  k={t("scene3d.volume")}
                  v={
                    selected.volumeMl === undefined
                      ? "—"
                      : `${num(selected.volumeMl, 2)} mL${selected.kind === "roi" && selected.volumeDepthSource === "thickness" ? ` (${t("scene3d.volumeEstimated")})` : ""}`
                  }
                />
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
const roiBox: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 4, padding: 6, border: "1px solid #dbe2ea", borderRadius: 6, background: "#f8fafc" };
const roiBoxHead: React.CSSProperties = { display: "flex", gap: 4 };
const roiItem: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6, fontSize: 12 };
const roiItemName: React.CSSProperties = { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "#33404d" };
const roiDone: React.CSSProperties = { fontSize: 11, color: "#7a8794" };
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
