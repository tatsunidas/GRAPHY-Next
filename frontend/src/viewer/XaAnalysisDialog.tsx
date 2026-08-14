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
import { useEffect, useMemo, useState } from "react";
import { getRenderingEngine } from "@cornerstonejs/core";
import { annotation as csAnnotation } from "@cornerstonejs/tools";
import {
  createQcaSr,
  createXaPresentationState,
  type AngioPresentationRequest,
} from "../api";
import { useI18n } from "../i18n/i18n";
import { readModalitySlice } from "./pixelCalibration";
import { runQca, type QcaResult } from "./qca";
import { ENGINE_ID } from "./Viewer2D";
import { readVoiWindow } from "./viewportRead";
import {
  calibrationForImageId,
  clearXaCalibrationCache,
  loaderSpacingFor,
  setXaUserCalibration,
} from "./xaCalibrationProvider";

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

function shortUid(uid: string): string {
  return uid.length > 12 ? `…${uid.slice(-12)}` : uid;
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

interface LengthPick {
  uid: string;
  /** 画像座標 [px]。 */
  p0: [number, number];
  p1: [number, number];
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

/** この imageId に紐づく Length 計測を集める。 */
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
    if (a?.metadata?.toolName !== "Length") continue;
    if (a?.metadata?.referencedImageId && a.metadata.referencedImageId !== imageId) continue;
    const pts = a?.data?.handles?.points;
    if (!Array.isArray(pts) || pts.length < 2) continue;
    const p0 = worldToImagePx(pts[0], mmPerPxRow, mmPerPxCol);
    const p1 = worldToImagePx(pts[1], mmPerPxRow, mmPerPxCol);
    out.push({
      uid: String(a.annotationUID ?? out.length),
      p0,
      p1,
      lengthPx: Math.hypot(p1[0] - p0[0], p1[1] - p0[1]),
    });
  }
  return out;
}

/** 保存（GSPS / SR）に必要な、表示中フレームの素性。SeriesViewer から渡す。 */
export interface XaSaveContext {
  studyUid: string;
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
  const [knownMm, setKnownMm] = useState("");
  const [frSize, setFrSize] = useState("6");
  const [result, setResult] = useState<QcaResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setResult(null);
    setError(null);
    setSaved(null);
  }, [imageId]);

  const pick = picks[selected] ?? null;

  const applyCalibration = (mm: number, method: "catheter" | "ruler", note: string) => {
    if (!pick || !(pick.lengthPx > 0) || !(mm > 0)) {
      setError(t("xa.analysis.needLength"));
      return;
    }
    setXaUserCalibration(seriesUid, { mmPerPx: mm / pick.lengthPx, method, note });
    clearXaCalibrationCache();
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
        ? `QCA %DS ${result.percentDiameterStenosis.toFixed(1)}`
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
      .then((r) => setSaved(t("xa.analysis.savedGsps", { uid: shortUid(r.sopInstanceUid) })))
      .catch(() => setError(t("xa.analysis.saveFailed")))
      .finally(() => setSaving(false));
  };

  /** QCA の計測値を Comprehensive SR として保存する。 */
  const saveQca = () => {
    const sop = saveContext.sopInstanceUid;
    if (!sop || !result) return;
    setSaving(true);
    setError(null);
    const c = calibrationForImageId(imageId);
    createQcaSr({
      studyInstanceUid: saveContext.studyUid,
      seriesInstanceUid: seriesUid,
      sopInstanceUid: sop,
      frameNumber: saveContext.frameIndex + 1,
      unit: result.unit,
      calibration: c?.provenance ?? null,
      vesselLabel: null,
      mld: result.mld,
      rvd: result.rvd,
      percentDiameterStenosis: result.percentDiameterStenosis,
      percentAreaStenosis: result.percentAreaStenosis,
      lesionLength: result.lesionLength,
    })
      .then((r) => setSaved(t("xa.analysis.savedSr", { uid: shortUid(r.sopInstanceUid) })))
      .catch(() => setError(t("xa.analysis.saveFailed")))
      .finally(() => setSaving(false));
  };

  const runAnalysis = () => {
    if (!pick) {
      setError(t("xa.analysis.needLength"));
      return;
    }
    setBusy(true);
    setError(null);
    // 失敗したときに**古い結果が残らない**ようにする（前回値を見て「変わっていない」と
    // 誤解する事故を防ぐ。実機で踏んだ）。
    setResult(null);
    readModalitySlice(imageId)
      .then((slice) => {
        if (!slice) {
          setError(t("xa.analysis.noPixels"));
          return;
        }
        const c = calibrationForImageId(imageId);
        const r = runQca({
          pixels: slice.values,
          width: slice.width,
          height: slice.height,
          start: pick.p0,
          end: pick.p1,
          mmPerPxRow: c?.mmPerPxRow ?? null,
          mmPerPxCol: c?.mmPerPxCol ?? null,
          // DSA 後は血管が正の大きな値（明るい）、非サブトラクションは暗い。
          vesselIsDark: !isSubtracted,
        });
        if (!r) {
          setError(t("xa.analysis.failed"));
          return;
        }
        setResult(r);
      })
      .catch(() => setError(t("xa.analysis.failed")))
      .finally(() => setBusy(false));
  };

  return (
    <div style={backdrop} onClick={onClose}>
      <div style={panel} onClick={(e) => e.stopPropagation()}>
        <div style={title} data-testid="xa-analysis-dialog">{t("xa.analysis.title")}</div>

        {/* 入力（Length 計測）の選択 */}
        <div style={section}>
          <div style={sectionTitle}>{t("xa.analysis.input")}</div>
          {picks.length === 0 ? (
            <div style={hint}>{t("xa.analysis.needLength")}</div>
          ) : (
            <select value={selected} onChange={(e) => setSelected(Number(e.target.value))} style={select}>
              {picks.map((p, i) => (
                <option key={p.uid} value={i}>
                  #{i + 1} — {p.lengthPx.toFixed(1)} px
                </option>
              ))}
            </select>
          )}
        </div>

        {/* 校正（C2 カテーテル法 / C3 ルーラー法） */}
        <div style={section}>
          <div style={sectionTitle}>{t("xa.analysis.calibration")}</div>
          <div style={hint} data-testid="xa-calib-status">
            {t("xa.calib.label")}: {calib ? t(`xa.calib.source.${calib.source}`) : "—"}
            {calib?.mmPerPxCol != null && ` (${calib.mmPerPxCol.toFixed(4)} mm/px)`}
          </div>
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
              disabled={!pick}
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
              disabled={!pick}
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
                setXaUserCalibration(seriesUid, null);
                clearXaCalibrationCache();
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
        <div style={section}>
          <div style={sectionTitle}>{t("xa.analysis.qca")}</div>
          <div style={row}>
            <button style={primaryBtn} onClick={runAnalysis} disabled={!pick || busy}>
              {busy ? t("common.loading") : t("xa.analysis.run")}
            </button>
            <span style={hint}>{t("xa.analysis.researchOnly")}</span>
          </div>
          {result && <QcaReport result={result} />}
        </div>

        {/* 保存（非破壊: GSPS ＝表示状態と描画 / SR ＝計測値）。fw/angio-design.md §14 */}
        <div style={section}>
          <div style={sectionTitle}>{t("xa.analysis.save")}</div>
          <div style={row}>
            <button style={btn} disabled={saving || !saveContext.sopInstanceUid} onClick={savePresentationState}>
              {t("xa.analysis.saveGsps")}
            </button>
            <button
              style={btn}
              disabled={saving || !result || !saveContext.sopInstanceUid}
              onClick={saveQca}
            >
              {t("xa.analysis.saveSr")}
            </button>
            {saved && <span style={hint}>{saved}</span>}
          </div>
          <div style={hint}>{t("xa.analysis.saveHint")}</div>
        </div>

        {error && <div style={errorText}>{error}</div>}

        <div style={{ ...row, justifyContent: "flex-end" }}>
          <button style={btn} data-testid="xa-dialog-close" onClick={onClose}>
            {t("common.close")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 結果の数値と径プロファイル（依存を増やさないため素の SVG）。 */
function QcaReport({ result }: { result: QcaResult }) {
  const { t } = useI18n();
  const u = result.unit;
  const w = 460;
  const h = 120;
  const pad = 4;
  const maxD = Math.max(...result.diameters, ...result.reference) * 1.1 || 1;
  const maxP = result.positions[result.positions.length - 1] || 1;
  const px = (i: number) => pad + (result.positions[i] / maxP) * (w - pad * 2);
  const py = (v: number) => h - pad - (v / maxD) * (h - pad * 2);
  const line = (vals: number[]) => vals.map((v, i) => `${px(i)},${py(v)}`).join(" ");

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
      <svg width={w} height={h} style={{ background: "#0f1720", borderRadius: 4 }}>
        <polyline points={line(result.reference)} fill="none" stroke="#6d8ba8" strokeDasharray="4 3" />
        <polyline points={line(result.diameters)} fill="none" stroke="#7fd1b9" strokeWidth={1.5} />
        <circle cx={px(result.mldIndex)} cy={py(result.mld)} r={3} fill="#e07a5f" />
      </svg>
      <div style={hint}>{t("xa.analysis.chartHint", { unit: u })}</div>
      <div style={hint}>{t("xa.analysis.areaCaveat")}</div>
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
  overflowY: "auto",
  boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
};
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
  border: "1px solid #c3ced9",
  borderRadius: 4,
  cursor: "pointer",
};
const primaryBtn: React.CSSProperties = { ...btn, background: "#2f6f9f", color: "#fff", borderColor: "#2a6088" };
const hint: React.CSSProperties = { fontSize: 11, color: "#66788a", marginTop: 4 };
const warn: React.CSSProperties = { fontSize: 11, color: "#a5642a", marginTop: 4 };
const errorText: React.CSSProperties = { fontSize: 12, color: "#b3452f", marginBottom: 8 };
const table: React.CSSProperties = { fontSize: 12, borderCollapse: "collapse", marginBottom: 8 };
const th: React.CSSProperties = { textAlign: "left", padding: "2px 10px 2px 0", color: "#66788a" };
const td: React.CSSProperties = { textAlign: "right", padding: "2px 16px 2px 0", fontVariantNumeric: "tabular-nums" };
