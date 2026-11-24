/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * テクスチャのマップと GLAM 解析の「PET の校正」の選択欄。ターゲットが PET（Modality=PT）のときだけ出す。
 * 選択肢と文言は ROI 特徴量の校正（{@link CALIBRATION_CHOICES}・`roiFeat.calibration.*`）と同じ。
 * PET 以外では欄を出さず、`auto`（CT・MR は何もしない）を送る。
 */
import { useI18n } from "../i18n/i18n";
import { CALIBRATION_CHOICES, type CalibrationChoice } from "./roiFeatureSettings";

/** ターゲットが PET か（校正の欄を出すか、非 PET では auto を送るかの判定）。 */
export const isPetModality = (modality: string | null | undefined): boolean =>
  (modality ?? "").trim().toUpperCase() === "PT";

/** 実際に送る校正の指定。PET 以外は選択に関わらず auto。 */
export const calibrationToSend = (modality: string | null | undefined, choice: CalibrationChoice): CalibrationChoice =>
  isPetModality(modality) ? choice : "auto";

export function PetCalibrationField({ value, onChange, disabled, labelKey, noneWarnKey, helpKey = "roiFeat.calibration.help", testId }: {
  value: CalibrationChoice;
  onChange: (v: CalibrationChoice) => void;
  disabled: boolean;
  labelKey: string;
  noneWarnKey: string;
  /** 説明文の鍵。既定は ROI 特徴量と同じ文言 */
  helpKey?: string;
  testId: string;
}) {
  const { t } = useI18n();
  return (
    <>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "4px 0" }}>
        <span style={{ color: "#5a6672", flex: "none", minWidth: 150 }}>{t(labelKey)}</span>
        <span style={{ flex: 1, textAlign: "right" }}>
          <select value={value} disabled={disabled} data-testid={testId} title={t("roiFeat.calibration.tooltip")}
            onChange={(e) => onChange(e.target.value as CalibrationChoice)}
            style={{ width: "100%", boxSizing: "border-box", border: "1px solid #cdd5de", borderRadius: 4, fontSize: 12, padding: "3px 6px" }}>
            {CALIBRATION_CHOICES.map((c) => <option key={c} value={c}>{t(`roiFeat.calibration.${c}`)}</option>)}
          </select>
        </span>
      </div>
      <div style={{ color: "#6b7785", fontSize: 11, marginTop: 4, lineHeight: 1.5 }} data-testid={`${testId}-help`}>
        {t(helpKey)}
      </div>
      {value === "none" && (
        <div data-testid={`${testId}-none-warn`} style={{
          color: "#8a5300", background: "#fff6e5", border: "1px solid #f0d9a8",
          borderRadius: 4, padding: "5px 7px", marginTop: 8, fontSize: 11, lineHeight: 1.5,
        }}>{t(noneWarnKey)}</div>
      )}
    </>
  );
}
