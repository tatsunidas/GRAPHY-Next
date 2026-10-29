/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * XA の空間校正（カテーテル法 / ルーラー法）だけを行う小さなダイアログ。
 *
 * <p>旧「XA 校正・QCA」ダイアログから校正の部分だけを残したもの（QCA はプラグインへ移った）。
 * QLV・IVUS 同期など、本体に残る計測は `calibrationForImageId` の値を使うので、実測の校正を確定する入口は本体に要る。
 *
 * <h3>入力は「既存の Length 計測」</h3>
 * ユーザがカテーテルの太さ（または既知長）を横切るように引いた **直線（Length）** の長さ [px] と、
 * その実寸 [mm] から mm/px を確定する。🔴 曲線は使えない（経路長は既知の寸法と意味が違う）。
 */
import { useCallback, useMemo, useState } from "react";
import { getRenderingEngine } from "@cornerstonejs/core";
import { annotation as csAnnotation, utilities as csToolsUtilities } from "@cornerstonejs/tools";
import { createXaPresentationState } from "../api";
import { useI18n } from "../i18n/i18n";
import { readVoiWindow } from "./viewportRead";
import { ENGINE_ID } from "./Viewer2D";
import { calibrationForImageId, loaderSpacingFor } from "./xaCalibrationProvider";
import { persistXaUserCalibration } from "./xaCalibrationPersistence";
import { viewerOverlayProps } from "./viewerOverlay";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** 校正に使える線 1 本（直線のみ）。 */
interface CalibLine {
  uid: string;
  /** 経路長 [px]（直線なので 2 点間距離）。 */
  lengthPx: number;
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
 * この imageId の直線（Length）計測を集める。
 *
 * <p>world → 画像ピクセルの換算は **ローダが画像に付けた spacing** で行う（校正値ではない）。
 * XA は IPP/IOP を持たないので world = (x·列spacing, y·行spacing)。校正値で割ると、校正した瞬間に座標が桁違いになる。
 */
function collectCalibLines(imageId: string, mmPerPxRow: number | null, mmPerPxCol: number | null): CalibLine[] {
  let all: any[] = [];
  try {
    all = (csAnnotation.state.getAllAnnotations() as any[]) ?? [];
  } catch {
    return [];
  }
  const col = mmPerPxCol && mmPerPxCol > 0 ? mmPerPxCol : 1;
  const row = mmPerPxRow && mmPerPxRow > 0 ? mmPerPxRow : 1;
  const out: CalibLine[] = [];
  for (const a of all) {
    // 🔴 直線（Length）だけ。ポリラインやフリーラインの経路長は既知の寸法と意味が違う。
    if (a?.metadata?.toolName !== "Length") continue;
    if (a?.metadata?.referencedImageId && a.metadata.referencedImageId !== imageId) continue;
    const raw = a?.data?.handles?.points;
    if (!Array.isArray(raw) || raw.length < 2) continue;
    const points = raw.map((w: readonly number[]) => [w[0] / col, w[1] / row] as [number, number]);
    out.push({ uid: String(a.annotationUID ?? out.length), lengthPx: Math.hypot(points[1][0] - points[0][0], points[1][1] - points[0][1]) });
  }
  return out;
}

/** 選んでいる線を画像の上で光らせる（Cornerstone の annotation selection。本体の選択表示と同じ）。 */
function highlightLine(uid: string | null): void {
  try {
    for (const u of csAnnotation.selection.getAnnotationsSelected() ?? []) {
      csAnnotation.selection.setAnnotationSelected(u, false);
    }
    if (uid) csAnnotation.selection.setAnnotationSelected(uid, true, false);
    const engine = getRenderingEngine(ENGINE_ID);
    const ids = (engine?.getViewports() ?? []).map((v) => v.id);
    if (ids.length) csToolsUtilities.triggerAnnotationRenderForViewportIds(ids);
  } catch {
    /* 光らせられなくても校正はできる */
  }
}

/** 保存（GSPS）の参照先。SeriesViewer から渡す。 */
export interface XaSaveContext {
  studyUid: string;
  /** 表示中フレームの元インスタンス。 */
  sopInstanceUid: string | null;
  /** 表示中フレーム（**0 origin**。DICOM へ書くときに +1 する）。 */
  frameIndex: number;
  /** DSA 中ならその設定（マスクフレームは 0 origin）。 */
  dsa?: { maskFrames: number[]; dx: number; dy: number } | null;
}

/**
 * 表示中ビューポートの実 VOI を読む。メタデータではなく**実際に表示されている値**を保存する
 * （W/L を触った後にメタデータの値を保存すると、開き直したときに違う見え方になる）。読めなければ null。
 */
function readVoiFor(imageId: string): { windowCenter: number; windowWidth: number } | null {
  try {
    const engine = getRenderingEngine(ENGINE_ID);
    if (!engine) return null;
    for (const vp of engine.getViewports()) {
      const current = (vp as { getCurrentImageId?: () => string | undefined }).getCurrentImageId?.();
      if (current !== imageId) continue;
      const w = readVoiWindow(vp as never);
      if (w && Number.isFinite(w.center) && Number.isFinite(w.width)) return { windowCenter: w.center, windowWidth: w.width };
    }
  } catch {
    /* 読めなければ VOI は保存しない */
  }
  return null;
}

export function XaCalibrationDialog({
  imageId,
  seriesUid,
  saveContext,
  onClose,
  onCalibrated,
}: {
  /** 校正する線を探す imageId（表示中フレーム。DSA 表示中は合成 imageId）。 */
  imageId: string;
  seriesUid: string;
  saveContext: XaSaveContext;
  onClose: () => void;
  onCalibrated?: () => void;
}) {
  const { t } = useI18n();
  // 校正を確定/解除したら自分の表示も更新する（imageId は変わらないので版番号で回す）。
  const [calibVersion, setCalibVersion] = useState(0);
  const calib = useMemo(
    () => calibrationForImageId(imageId),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [imageId, calibVersion],
  );
  const lines = useMemo(() => {
    const sp = loaderSpacingFor(imageId);
    return collectCalibLines(imageId, sp.row, sp.col);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageId, calibVersion]);
  const [selected, setSelected] = useState(0);
  const [knownMm, setKnownMm] = useState("");
  const [frSize, setFrSize] = useState("6");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const line = lines[selected] ?? null;

  const label = useCallback(
    (l: CalibLine, i: number): string => {
      const mmPerPx = calib?.mmPerPxCol ?? null;
      const size = mmPerPx && mmPerPx > 0 ? `${(l.lengthPx * mmPerPx).toFixed(1)} mm` : `${l.lengthPx.toFixed(1)} px`;
      return `#${i + 1} — ${size}（${t("xa.analysis.kind.line")}）`;
    },
    [calib, t],
  );

  const apply = (mm: number, method: "catheter" | "ruler", note: string) => {
    if (!line || !(line.lengthPx > 0) || !(mm > 0)) {
      setError(t("xa.analysis.needCalibLine"));
      return;
    }
    // 🚨 保存まで含めて確定する（`setXaUserCalibration` を直に呼ぶと次に開いたとき消えている）。
    void persistXaUserCalibration(seriesUid, { mmPerPx: mm / line.lengthPx, method, note });
    invalidateAnnotations();
    setError(null);
    setCalibVersion((v) => v + 1);
    onCalibrated?.();
  };

  /** 表示状態（W/L・DSA マスク・校正）を XA/XRF の GSPS として保存する（非破壊）。 */
  const savePresentationState = () => {
    const sop = saveContext.sopInstanceUid;
    if (!sop) {
      setError(t("xa.analysis.noReference"));
      return;
    }
    setSaving(true);
    setError(null);
    const c = calibrationForImageId(imageId);
    createXaPresentationState({
      studyInstanceUid: saveContext.studyUid,
      seriesInstanceUid: seriesUid,
      sopInstanceUid: sop,
      // DICOM のフレーム番号は 1 origin。
      frameNumbers: [saveContext.frameIndex + 1],
      label: "XA",
      description: "GRAPHY-Next presentation state",
      voi: readVoiFor(imageId),
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
      polylines: [],
      texts: [],
    })
      .then((r) => setSaved(t("xa.analysis.savedGsps", { uid: r.sopInstanceUid.length > 12 ? `…${r.sopInstanceUid.slice(-12)}` : r.sopInstanceUid })))
      .catch(() => setError(t("xa.analysis.saveFailed")))
      .finally(() => setSaving(false));
  };

  return (
    <div style={backdrop} onClick={onClose}>
      <div style={panel} onClick={(e) => e.stopPropagation()} {...viewerOverlayProps}>
        <div style={title} data-testid="xa-calibration-dialog">
          {t("xa.calib.dialogTitle")}
        </div>
        <div style={section} data-step="calibration">
          <div style={hint} data-testid="xa-calib-status">
            {t("xa.calib.label")}: {calib ? t(`xa.calib.source.${calib.source}`) : "—"}
            {calib?.mmPerPxCol != null && ` (${calib.mmPerPxCol.toFixed(4)} mm/px)`}
          </div>
          {/* 🔴 校正に使う線は**直線のみ**（曲線の経路長は「既知の長さ」と意味が違う）。 */}
          <div style={hint}>{t("xa.analysis.calibHelp")}</div>
          {lines.length === 0 ? (
            <div style={warn} data-testid="xa-calib-need-line">{t("xa.analysis.needCalibLine")}</div>
          ) : (
            <div style={row}>
              <select
                value={selected}
                onChange={(e) => {
                  const i = Number(e.target.value);
                  setSelected(i);
                  highlightLine(lines[i]?.uid ?? null);
                }}
                style={select}
                data-testid="xa-calib-pick"
              >
                {lines.map((l, i) => (
                  <option key={l.uid} value={i}>
                    {label(l, i)}
                  </option>
                ))}
              </select>
              <button
                style={btn}
                data-testid="xa-calib-pick-show"
                disabled={!line}
                onClick={() => highlightLine(line?.uid ?? null)}
                title={t("xa.analysis.showOnImageHint")}
              >
                {t("xa.analysis.showOnImage")}
              </button>
            </div>
          )}
          <div style={row}>
            <label style={labelStyle}>
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
              disabled={!line}
              onClick={() => {
                const fr = Number(frSize);
                if (!(fr > 0)) {
                  setError(t("xa.analysis.badNumber"));
                  return;
                }
                // Fr → mm は定義計算（1Fr = 1/3 mm）。実測外径は製品差があるので「公称値による」。
                apply(fr / 3, "catheter", t("xa.analysis.catheterNote", { fr: String(fr) }));
              }}
            >
              {t("xa.analysis.calibrateCatheter")}
            </button>
          </div>
          <div style={row}>
            <label style={labelStyle}>
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
              data-testid="xa-calibrate-ruler"
              disabled={!line}
              onClick={() => {
                const mm = Number(knownMm);
                if (!(mm > 0)) {
                  setError(t("xa.analysis.badNumber"));
                  return;
                }
                apply(mm, "ruler", t("xa.analysis.rulerNote", { mm: String(mm) }));
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
        <div style={section} data-step="save">
          <div style={row}>
            <button
              style={btn}
              data-testid="xa-save-gsps"
              disabled={saving || !saveContext.sopInstanceUid}
              onClick={savePresentationState}
            >
              {t("xa.analysis.saveGsps")}
            </button>
            {saved && <span style={hint} data-testid="xa-save-gsps-msg">{saved}</span>}
          </div>
        </div>
        {error && <div style={warn} data-testid="xa-calib-error">{error}</div>}
        <div style={{ ...row, justifyContent: "flex-end" }}>
          <button style={btn} data-testid="xa-calibration-close" onClick={onClose}>
            {t("common.close")}
          </button>
        </div>
      </div>
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
  minWidth: 480,
  maxHeight: "86vh",
  overflowY: "auto",
  boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
};
const title: React.CSSProperties = { fontWeight: 600, fontSize: 15, marginBottom: 10 };
const section: React.CSSProperties = { border: "1px solid #d5dde4", borderRadius: 4, padding: 10, marginBottom: 10 };
const row: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, marginTop: 6, flexWrap: "wrap" };
const labelStyle: React.CSSProperties = { display: "flex", alignItems: "center", gap: 4, fontSize: 12 };
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
const hint: React.CSSProperties = { fontSize: 11, color: "#66788a", marginTop: 4 };
const warn: React.CSSProperties = { fontSize: 11, color: "#a5642a", marginTop: 4 };
