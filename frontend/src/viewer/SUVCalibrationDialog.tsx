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
import { useEffect, useMemo, useState } from "react";
import { useI18n } from "../i18n/i18n";
import {
  extractSuvParams,
  computeSuvScale,
  isSuvError,
  type SuvParams,
  type SuvType,
} from "./suv";
import { setSuv, type SuvCalibration } from "./suvStore";
import { suvrScale, type RefMeasure } from "./suvr";
import { loadReferenceMeasures } from "./suvrReference";
import { saveCalibratedSeries } from "./calibratedSeriesSaveRun";
import type { Instance, Series, Study } from "../api";
import type { ViewerMode } from "./imageId";

/** 校正値を派生シリーズとして保存するときの対象（対象タイルのシリーズ）。無ければ保存ボタンは出さない。 */
export interface SuvSaveContext {
  study: Study;
  series: Series;
  instances: Instance[];
  mode: ViewerMode;
  c: number;
  t: number;
}

/** SUV 計算タイプの選択肢。 */
type DialogType = SuvType | "suvr";
const TYPES: { value: DialogType; labelKey: string }[] = [
  { value: "bw", labelKey: "suv.type.bw" },
  { value: "sul-james", labelKey: "suv.type.sulJames" },
  { value: "sul-janma", labelKey: "suv.type.sulJanma" },
  { value: "bsa", labelKey: "suv.type.bsa" },
  { value: "pid", labelKey: "suv.type.pid" },
  { value: "suvr", labelKey: "suv.type.suvr" },
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
  saveCtx,
  onClose,
}: {
  /** 対象 PET シリーズの表示中 imageId。 */
  imageId: string;
  /** 対象 SeriesInstanceUID（適用先キー）。 */
  seriesUid: string;
  /** 現在この シリーズに適用中の SUV 校正（あれば「解除」を表示）。 */
  applied?: SuvCalibration | null;
  /** 校正値の保存先（シリーズ）。 */
  saveCtx?: SuvSaveContext;
  onClose: () => void;
}) {
  const { t } = useI18n();

  // DICOM から一度だけ抽出（マウント時）。
  const base: SuvParams = useMemo(() => extractSuvParams(imageId), [imageId]);

  const locked = base.alreadySuv;
  // SUV 化済みの画像は SUVR（比）だけ作れる。%ID/cc・SUV の再計算はできない。
  const [type, setType] = useState<DialogType>(locked ? "suvr" : (applied?.type ?? "bw"));
  const [weight, setWeight] = useState(fmt2(base.patientWeight));
  const [height, setHeight] = useState(fmt2(base.patientHeight));
  const [sex, setSex] = useState<"M" | "F" | "">(base.patientSex ?? "");
  const [dose, setDose] = useState(fmt2(base.totalDoseBq ? base.totalDoseBq / 1e6 : undefined)); // MBq
  const [halfLife, setHalfLife] = useState(fmt2(base.halfLifeSec ? base.halfLifeSec / 60 : undefined)); // min
  const [injTime, setInjTime] = useState(fmtHms(base.injectionTimeMs));
  const [serTime, setSerTime] = useState(fmtHms(base.scanTimeMs));
  const [error, setError] = useState<string | null>(null);

  const isPid = type === "pid";
  const isSuvr = type === "suvr";
  const fieldsOff = locked || isSuvr;
  // SUVR の参照領域: この PET シリーズの ROI／VOI／グループの平均（今の校正込み）。
  const [measures, setMeasures] = useState<RefMeasure[] | null>(null);
  const [refKey, setRefKey] = useState("");
  useEffect(() => {
    if (!isSuvr) return;
    let cancelled = false;
    setMeasures(null);
    loadReferenceMeasures(seriesUid)
      .then((m) => {
        if (cancelled) return;
        setMeasures(m);
        setRefKey((cur) => (m.some((x) => x.key === cur) ? cur : (m[0]?.key ?? "")));
      })
      .catch(() => !cancelled && setMeasures([]));
    return () => {
      cancelled = true;
    };
  }, [isSuvr, seriesUid]);
  const refMeasure = measures?.find((x) => x.key === refKey);
  const suvrReady = isSuvr && refMeasure !== undefined && refMeasure.reason === undefined;
  const philips = (base.philipsSuvScaleFactor ?? 0) > 0;

  const onApply = () => {
    setError(null);
    if (isSuvr) {
      if (!refMeasure) return setError(t("suv.err.refNone"));
      if (refMeasure.reason) return setError(t(`suv.err.${refMeasure.reason}`));
      // 参照の平均は今の校正込みの値なので、今の乗数を渡して打ち消す。
      const r = suvrScale(refMeasure.mean!, applied?.scale);
      if ("error" in r) return setError(t(`suv.err.${r.error}`));
      setSuv(seriesUid, {
        scale: r.scale,
        unit: "SUVR",
        type: "suvr",
        ref: { label: refMeasure.label, mean: refMeasure.mean!, unit: refMeasure.unit ?? "", n: refMeasure.n ?? 0 },
      });
      onClose();
      return;
    }
    // 必須（BW 以外は身長も）。
    const w = Number(weight);
    const h = height.trim() === "" ? 0 : Number(height);
    const doseMBq = Number(dose);
    const hlMin = Number(halfLife);
    // %ID/cc は体重を使わないので任意。
    if ((!isPid && weight.trim() === "") || dose.trim() === "" || halfLife.trim() === "") {
      setError(t("suv.err.missingFields"));
      return;
    }
    // 臨床レンジチェック（本家準拠）。
    if (!(isPid && weight.trim() === "") && !(w >= 0.001 && w <= 250)) return setError(t("suv.err.weight"));
    if (h !== 0 && !(h >= 0.4 && h <= 2.5)) return setError(t("suv.err.height"));
    // 小動物 PET の %ID/cc は 1 MBq 未満があり得る（下限 0.01 MBq）。SUV 4 種は従来の 1 MBq。
    if (!(doseMBq >= (isPid ? 0.01 : 1) && doseMBq <= 1000)) return setError(t(isPid ? "suv.err.dosePid" : "suv.err.dose"));
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
      patientWeight: weight.trim() === "" ? undefined : w,
      patientHeight: h > 0 ? h : undefined,
      patientSex: sex === "" ? undefined : sex,
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

  // 適用中の校正（ダイアログ内の未適用の編集ではなく）を、新しいシリーズとして保存する。
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ text: string; err: boolean } | null>(null);
  const onSaveDerived = async () => {
    if (!applied || !saveCtx || saveBusy) return;
    setSaveBusy(true);
    setSaveMsg({ text: t("suv.saving"), err: false });
    try {
      const r = await saveCalibratedSeries({
        cal: applied,
        ...saveCtx,
        confirmMemory: (mb, limit) => window.confirm(t("resample.confirmMemory", { mb, limit })),
      });
      if (r.ok) setSaveMsg({ text: t("suv.saved", { n: r.count }), err: false });
      else if (r.reason === "declined") setSaveMsg(null);
      else setSaveMsg({ text: t(r.reason === "nonUniform" ? "suv.saveNonUniform" : "suv.saveNoGeometry"), err: true });
    } catch (e) {
      setSaveMsg({ text: `${t("suv.saveFailed")}: ${String(e)}`, err: true });
    } finally {
      setSaveBusy(false);
    }
  };

  const onClear = () => {
    setSuv(seriesUid, null);
    onClose();
  };

  return (
    <div style={overlay} onMouseDown={onClose}>
      <div style={panel} onMouseDown={(e) => e.stopPropagation()} data-testid="suv-dialog">
        <div style={header}>{t("suv.title")}</div>

        {locked && (
          <div style={warnRed}>{t("suv.alreadyCalibrated")}</div>
        )}
        {philips && !locked && (
          <div style={warnBlue}>{t("suv.philipsDetected")}</div>
        )}

        <Field label={t("suv.field.type")}>
          <select data-testid="suv-type" value={type} onChange={(e) => setType(e.target.value as DialogType)} style={input}>
            {TYPES.filter((tp) => !locked || tp.value === "suvr").map((tp) => (
              <option key={tp.value} value={tp.value}>{t(tp.labelKey)}</option>
            ))}
          </select>
        </Field>

        <Field label={t("suv.field.radionuclide")}>
          <span style={{ fontWeight: 600 }}>{base.radionuclideName || "Unknown"}</span>
        </Field>

        <Field label={isPid ? t("suv.field.weightOptional") : t("suv.field.weight")}>
          <input data-testid="suv-weight" value={weight} onChange={(e) => setWeight(e.target.value)} disabled={fieldsOff} inputMode="decimal" style={input} />
        </Field>
        <Field label={t("suv.field.height")}>
          <input data-testid="suv-height" value={height} onChange={(e) => setHeight(e.target.value)} disabled={fieldsOff || isPid} inputMode="decimal" style={input} />
        </Field>
        <Field label={t("suv.field.sex")}>
          <select data-testid="suv-sex" value={sex} onChange={(e) => setSex(e.target.value as "M" | "F" | "")} disabled={fieldsOff || isPid} style={input}>
            <option value="">{t("suv.sex.unknown")}</option>
            <option value="M">{t("suv.sex.male")}</option>
            <option value="F">{t("suv.sex.female")}</option>
          </select>
        </Field>
        <Field label={t("suv.field.dose")}>
          <input data-testid="suv-dose" value={dose} onChange={(e) => setDose(e.target.value)} disabled={fieldsOff} inputMode="decimal" style={input} />
        </Field>
        <Field label={t("suv.field.halfLife")}>
          <input data-testid="suv-half-life" value={halfLife} onChange={(e) => setHalfLife(e.target.value)} disabled={fieldsOff} inputMode="decimal" style={input} />
        </Field>
        <Field label={t("suv.field.injTime")}>
          <input data-testid="suv-inj-time" value={injTime} onChange={(e) => setInjTime(e.target.value)} disabled={fieldsOff} placeholder="HH:mm:ss" style={input} />
        </Field>
        <Field label={t("suv.field.serTime")}>
          <input data-testid="suv-ser-time" value={serTime} onChange={(e) => setSerTime(e.target.value)} disabled={fieldsOff} placeholder="HH:mm:ss" style={input} />
        </Field>

        {isSuvr && (
          <>
            <Field label={t("suv.field.reference")}>
              <select data-testid="suv-ref" value={refKey} onChange={(e) => setRefKey(e.target.value)} disabled={!measures?.length} style={input}>
                {(measures ?? []).map((m) => (
                  <option key={m.key} value={m.key}>
                    {m.label}{m.group ? " (group)" : ""}{m.mean !== undefined ? ` — ${m.mean.toPrecision(4)} ${m.unit ?? ""}` : ""}
                  </option>
                ))}
              </select>
            </Field>
            <div data-testid="suv-ref-note" style={refMeasure?.reason || (measures && measures.length === 0) ? errText : { ...fieldLabel, marginTop: 4 }}>
              {measures === null
                ? "…"
                : measures.length === 0
                  ? t("suv.err.refNone")
                  : refMeasure?.reason
                    ? t(`suv.err.${refMeasure.reason}`)
                    : `${t("suv.ref.mean")}: ${refMeasure?.mean?.toPrecision(5)} ${refMeasure?.unit ?? ""} / n=${refMeasure?.n}`}
            </div>
          </>
        )}

        {error && <div style={errText}>{error}</div>}

        {saveCtx && (
          <div style={{ marginTop: 10 }}>
            <button
              data-testid="suv-save-derived"
              onClick={onSaveDerived}
              disabled={!applied || saveBusy}
              title={applied ? undefined : t("suv.saveNoCalibration")}
              style={{ ...btn, opacity: !applied || saveBusy ? 0.5 : 1 }}
            >
              {t("suv.saveDerived")}
            </button>
            {!applied && <div style={{ ...fieldLabel, marginTop: 4 }} data-testid="suv-save-hint">{t("suv.saveNoCalibration")}</div>}
            {saveMsg && <div data-testid="suv-save-msg" style={saveMsg.err ? errText : { ...fieldLabel, marginTop: 4 }}>{saveMsg.text}</div>}
          </div>
        )}

        <div style={{ display: "flex", gap: 6, marginTop: 12, justifyContent: "flex-end" }}>
          {applied && (
            <button onClick={onClear} style={btn}>{t("suv.clear")}</button>
          )}
          <button onClick={onClose} style={btn}>{t("common.cancel")}</button>
          <button data-testid="suv-apply" onClick={onApply} disabled={isSuvr ? !suvrReady : locked} style={{ ...btnPrimary, opacity: (isSuvr ? !suvrReady : locked) ? 0.5 : 1 }}>
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
