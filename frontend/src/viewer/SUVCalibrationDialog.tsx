/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * SUV 校正ダイアログ。本家 GRAPHY {@code SUVCalibrationDialog.java} の Next 移植。
 *
 * <p>表示中 PET シリーズの DICOM 属性から SUV 計算パラメータを自動抽出し（{@link extractSuvParams}）、
 * ユーザーが確認・修正のうえ計算タイプ（SUVbw / SUL James / SUL Janma / SUVbsa）を選んで適用する。
 * 適用結果は {@link setSuv}（シリーズ単位）へ書き込まれ、単一入口 pixelCalibration を通じて
 * カーソル値・ROI 統計・ヒストグラム・W/L 表示が SUV 値へ切り替わる。
 *
 * <p>時刻は本家同様 {@code HH:mm:ss}（秒精度）で扱い、投与→スキャンの経過で崩壊補正する
 * （日跨ぎは +24h 補正）。すでに SUV 化済み（Units=GML 等）の場合は入力をロックする。
 */
import { useMemo, useState } from "react";
import { useI18n } from "../i18n/i18n";
import {
  extractSuvParams,
  computeSuvScale,
  isSuvError,
  type SuvParams,
  type SuvType,
} from "./suv";
import { setSuv, type SuvCalibration } from "./suvStore";

/** SUV 計算タイプの選択肢。 */
const TYPES: { value: SuvType; labelKey: string }[] = [
  { value: "bw", labelKey: "suv.type.bw" },
  { value: "sul-james", labelKey: "suv.type.sulJames" },
  { value: "sul-janma", labelKey: "suv.type.sulJanma" },
  { value: "bsa", labelKey: "suv.type.bsa" },
];

/** epoch ms（相対）→ "HH:mm:ss"。 */
function fmtHms(ms: number | undefined): string {
  if (ms === undefined) return "";
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

/** "HH:mm:ss" → 当日 0 時基準の epoch ms（1970-01-01 上）。不正なら undefined。 */
function parseHms(s: string): number | undefined {
  const m = /^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/.exec(s.trim());
  if (!m) return undefined;
  const hh = +m[1];
  const mm = +m[2];
  const ss = m[3] ? +m[3] : 0;
  if (hh > 23 || mm > 59 || ss > 59) return undefined;
  return Date.UTC(1970, 0, 1, hh, mm, ss);
}

function fmt2(v: number | undefined): string {
  return v !== undefined && v > 0 ? v.toFixed(2) : "";
}

export function SUVCalibrationDialog({
  imageId,
  seriesUid,
  applied,
  onClose,
}: {
  /** 対象 PET シリーズの表示中 imageId。 */
  imageId: string;
  /** 対象 SeriesInstanceUID（適用先キー）。 */
  seriesUid: string;
  /** 現在この シリーズに適用中の SUV 校正（あれば「解除」を表示）。 */
  applied?: SuvCalibration | null;
  onClose: () => void;
}) {
  const { t } = useI18n();

  // DICOM から一度だけ抽出（マウント時）。
  const base: SuvParams = useMemo(() => extractSuvParams(imageId), [imageId]);

  const [type, setType] = useState<SuvType>(applied?.type ?? "bw");
  const [weight, setWeight] = useState(fmt2(base.patientWeight));
  const [height, setHeight] = useState(fmt2(base.patientHeight));
  const [sex, setSex] = useState<"M" | "F">(base.patientSex);
  const [dose, setDose] = useState(fmt2(base.totalDoseBq ? base.totalDoseBq / 1e6 : undefined)); // MBq
  const [halfLife, setHalfLife] = useState(fmt2(base.halfLifeSec ? base.halfLifeSec / 60 : undefined)); // min
  const [injTime, setInjTime] = useState(fmtHms(base.injectionTimeMs));
  const [serTime, setSerTime] = useState(fmtHms(base.scanTimeMs));
  const [error, setError] = useState<string | null>(null);

  const locked = base.alreadySuv;
  const philips = (base.philipsSuvScaleFactor ?? 0) > 0;

  const onApply = () => {
    setError(null);
    // 必須（BW 以外は身長も）。
    const w = Number(weight);
    const h = height.trim() === "" ? 0 : Number(height);
    const doseMBq = Number(dose);
    const hlMin = Number(halfLife);
    if (weight.trim() === "" || dose.trim() === "" || halfLife.trim() === "") {
      setError(t("suv.err.missingFields"));
      return;
    }
    // 臨床レンジチェック（本家準拠）。
    if (!(w >= 0.001 && w <= 250)) return setError(t("suv.err.weight"));
    if (h !== 0 && !(h >= 0.4 && h <= 2.5)) return setError(t("suv.err.height"));
    if (!(doseMBq >= 1 && doseMBq <= 1000)) return setError(t("suv.err.dose"));
    if (!(hlMin >= 1 && hlMin <= 10000)) return setError(t("suv.err.halfLife"));

    const injectionTimeMs = parseHms(injTime);
    const scanTimeMs = parseHms(serTime);
    // BQML の標準計算では時刻が必須（Philips/GML はこの限りでない）。
    const unitsUp = (base.units ?? "").toUpperCase();
    const needTime = unitsUp !== "GML" && !((base.philipsSuvScaleFactor ?? 0) > 0);
    if (needTime && (injectionTimeMs === undefined || scanTimeMs === undefined)) {
      setError(t("suv.err.timeFormat"));
      return;
    }

    const params: SuvParams = {
      ...base,
      patientWeight: w,
      patientHeight: h > 0 ? h : undefined,
      patientSex: sex,
      totalDoseBq: doseMBq * 1e6,
      halfLifeSec: hlMin * 60,
      injectionTimeMs,
      scanTimeMs,
    };
    const r = computeSuvScale(params, type);
    if (isSuvError(r)) {
      setError(t(`suv.err.${r.error}`));
      return;
    }
    const cal: SuvCalibration = { scale: r.scale, unit: r.unit, type: r.type };
    setSuv(seriesUid, cal);
    onClose();
  };

  const onClear = () => {
    setSuv(seriesUid, null);
    onClose();
  };

  return (
    <div style={overlay} onMouseDown={onClose}>
      <div style={panel} onMouseDown={(e) => e.stopPropagation()}>
        <div style={header}>{t("suv.title")}</div>

        {locked && (
          <div style={warnRed}>{t("suv.alreadyCalibrated")}</div>
        )}
        {philips && !locked && (
          <div style={warnBlue}>{t("suv.philipsDetected")}</div>
        )}

        <Field label={t("suv.field.type")}>
          <select value={type} onChange={(e) => setType(e.target.value as SuvType)} disabled={locked} style={input}>
            {TYPES.map((tp) => (
              <option key={tp.value} value={tp.value}>{t(tp.labelKey)}</option>
            ))}
          </select>
        </Field>

        <Field label={t("suv.field.radionuclide")}>
          <span style={{ fontWeight: 600 }}>{base.radionuclideName || "Unknown"}</span>
        </Field>

        <Field label={t("suv.field.weight")}>
          <input value={weight} onChange={(e) => setWeight(e.target.value)} disabled={locked} inputMode="decimal" style={input} />
        </Field>
        <Field label={t("suv.field.height")}>
          <input value={height} onChange={(e) => setHeight(e.target.value)} disabled={locked} inputMode="decimal" style={input} />
        </Field>
        <Field label={t("suv.field.sex")}>
          <select value={sex} onChange={(e) => setSex(e.target.value as "M" | "F")} disabled={locked} style={input}>
            <option value="M">{t("suv.sex.male")}</option>
            <option value="F">{t("suv.sex.female")}</option>
          </select>
        </Field>
        <Field label={t("suv.field.dose")}>
          <input value={dose} onChange={(e) => setDose(e.target.value)} disabled={locked} inputMode="decimal" style={input} />
        </Field>
        <Field label={t("suv.field.halfLife")}>
          <input value={halfLife} onChange={(e) => setHalfLife(e.target.value)} disabled={locked} inputMode="decimal" style={input} />
        </Field>
        <Field label={t("suv.field.injTime")}>
          <input value={injTime} onChange={(e) => setInjTime(e.target.value)} disabled={locked} placeholder="HH:mm:ss" style={input} />
        </Field>
        <Field label={t("suv.field.serTime")}>
          <input value={serTime} onChange={(e) => setSerTime(e.target.value)} disabled={locked} placeholder="HH:mm:ss" style={input} />
        </Field>

        {error && <div style={errText}>{error}</div>}

        <div style={{ display: "flex", gap: 6, marginTop: 12, justifyContent: "flex-end" }}>
          {applied && (
            <button onClick={onClear} style={btn}>{t("suv.clear")}</button>
          )}
          <button onClick={onClose} style={btn}>{t("common.cancel")}</button>
          <button onClick={onApply} disabled={locked} style={{ ...btnPrimary, opacity: locked ? 0.5 : 1 }}>
            {t("suv.apply")}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={fieldRow}>
      <span style={fieldLabel}>{label}</span>
      <span style={fieldValue}>{children}</span>
    </div>
  );
}

const overlay: React.CSSProperties = {
  position: "fixed", inset: 0, zIndex: 70, background: "rgba(0,0,0,0.35)",
  display: "flex", alignItems: "center", justifyContent: "center",
};
const panel: React.CSSProperties = {
  width: 380, maxHeight: "90vh", overflowY: "auto",
  background: "#fff", border: "1px solid #cfd8e2", borderRadius: 8,
  boxShadow: "0 12px 40px rgba(0,0,0,0.25)", padding: 16, fontSize: 12, color: "#222",
};
const header: React.CSSProperties = { fontSize: 14, fontWeight: 600, color: "#0b5cad", marginBottom: 10 };
const fieldRow: React.CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "4px 0" };
const fieldLabel: React.CSSProperties = { color: "#5a6672", flex: "none", minWidth: 150 };
const fieldValue: React.CSSProperties = { flex: 1, textAlign: "right" };
const input: React.CSSProperties = { width: "100%", boxSizing: "border-box", border: "1px solid #cdd5de", borderRadius: 4, fontSize: 12, padding: "3px 6px" };
const warnRed: React.CSSProperties = { color: "#b00020", fontWeight: 600, background: "#fdecef", border: "1px solid #f6c2cc", borderRadius: 4, padding: "6px 8px", marginBottom: 8 };
const warnBlue: React.CSSProperties = { color: "#0b5cad", background: "#eaf3fb", border: "1px solid #c2ddf6", borderRadius: 4, padding: "6px 8px", marginBottom: 8 };
const errText: React.CSSProperties = { color: "#b00020", marginTop: 8 };
const btn: React.CSSProperties = { border: "1px solid #cdd5de", borderRadius: 6, background: "#fff", cursor: "pointer", fontSize: 12, padding: "5px 12px" };
const btnPrimary: React.CSSProperties = { ...btn, background: "#0b5cad", border: "1px solid #0b5cad", color: "#fff" };
