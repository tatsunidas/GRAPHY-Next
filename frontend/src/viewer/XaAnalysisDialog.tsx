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
import { annotation as csAnnotation } from "@cornerstonejs/tools";
import { useI18n } from "../i18n/i18n";
import { readModalitySlice } from "./pixelCalibration";
import { runQca, type QcaResult } from "./qca";
import { calibrationForImageId, clearXaCalibrationCache, setXaUserCalibration } from "./xaCalibrationProvider";

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
 * （原点 0・行/列方向が x/y 軸）を使う。よって world = (x·列spacing, y·行spacing) であり、
 * spacing で割れば画像ピクセルに戻る。spacing 未設定（未校正）なら world はそのまま px。
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

export function XaAnalysisDialog({
  imageId,
  seriesUid,
  isSubtracted,
  onClose,
  onCalibrated,
}: {
  /** 解析対象の imageId（表示中フレーム。DSA 表示中は合成 imageId）。 */
  imageId: string;
  seriesUid: string;
  /** DSA 表示中か（血管が明るいか暗いかの判断に使う）。 */
  isSubtracted: boolean;
  onClose: () => void;
  onCalibrated?: () => void;
}) {
  const { t } = useI18n();
  const calib = useMemo(() => calibrationForImageId(imageId), [imageId]);
  const picks = useMemo(
    () => collectLengthPicks(imageId, calib?.mmPerPxRow ?? null, calib?.mmPerPxCol ?? null),
    [imageId, calib],
  );
  const [selected, setSelected] = useState(0);
  const [knownMm, setKnownMm] = useState("");
  const [frSize, setFrSize] = useState("6");
  const [result, setResult] = useState<QcaResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setResult(null);
    setError(null);
  }, [imageId]);

  const pick = picks[selected] ?? null;

  const applyCalibration = (mm: number, method: "catheter" | "ruler", note: string) => {
    if (!pick || !(pick.lengthPx > 0) || !(mm > 0)) {
      setError(t("xa.analysis.needLength"));
      return;
    }
    setXaUserCalibration(seriesUid, { mmPerPx: mm / pick.lengthPx, method, note });
    clearXaCalibrationCache();
    setError(null);
    onCalibrated?.();
  };

  const runAnalysis = () => {
    if (!pick) {
      setError(t("xa.analysis.needLength"));
      return;
    }
    setBusy(true);
    setError(null);
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
        <div style={title}>{t("xa.analysis.title")}</div>

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
          <div style={hint}>
            {t("xa.calib.label")}: {calib ? t(`xa.calib.source.${calib.source}`) : "—"}
            {calib?.mmPerPxCol != null && ` (${calib.mmPerPxCol.toFixed(4)} mm/px)`}
          </div>
          <div style={row}>
            <label style={label}>
              {t("xa.analysis.catheterFr")}
              <input
                value={frSize}
                onChange={(e) => setFrSize(e.target.value)}
                style={input}
                inputMode="decimal"
              />
            </label>
            <button
              style={btn}
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
              onClick={() => {
                setXaUserCalibration(seriesUid, null);
                clearXaCalibrationCache();
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

        {error && <div style={errorText}>{error}</div>}

        <div style={{ ...row, justifyContent: "flex-end" }}>
          <button style={btn} onClick={onClose}>
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
