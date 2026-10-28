/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { NumberField } from "../hooks/NumberField";
import { useI18n } from "../i18n/i18n";
import { ROI_FEATURE_FAMILIES, type RoiFeatureForm } from "./roiFeatureSettings";

/**
 * 一括抽出の特徴量の設定欄（離散化・リサンプリング・族）。値と変換は ROI 特徴量の画面と同じ
 * `RoiFeatureForm`・`roiFeatureSettings` を使い、入力欄だけを持つ。画像フィルタと 2D の単位は含めない。
 */
export function BatchSettingsPanel({
  form,
  setForm,
  disabled,
}: {
  form: RoiFeatureForm;
  setForm: (f: (prev: RoiFeatureForm) => RoiFeatureForm) => void;
  disabled: boolean;
}) {
  const { t } = useI18n();
  const familyLabel = (key: string): string => {
    const k = `roiFeat.family.${key}`;
    const v = t(k);
    return v === k ? key : v;
  };
  return (
    <div data-testid="batch-settings" style={{ fontSize: 12 }}>
      <div style={row}>
        <span style={label}>{t("roiFeat.field.discretisation")}</span>
        <label>
          <input type="radio" checked={form.fixedBinNumber} disabled={disabled}
            onChange={() => setForm((f) => ({ ...f, fixedBinNumber: true }))} /> {t("roiFeat.disc.binCount")}
        </label>
        <span data-testid="batch-bincount">
          <NumberField value={form.binCount} onChange={(v) => setForm((f) => ({ ...f, binCount: v }))}
            min={2} max={1024} disabled={disabled || !form.fixedBinNumber} style={{ ...input, width: 64 }} />
        </span>
        <label>
          <input type="radio" checked={!form.fixedBinNumber} disabled={disabled}
            onChange={() => setForm((f) => ({ ...f, fixedBinNumber: false }))} /> {t("roiFeat.disc.binWidth")}
        </label>
        <NumberField value={form.binWidth} onChange={(v) => setForm((f) => ({ ...f, binWidth: v }))}
          min={0.001} max={100000} step={0.5} disabled={disabled || form.fixedBinNumber} style={{ ...input, width: 64 }} />
      </div>
      <div style={row}>
        <span style={label}>{t("roiFeat.field.resampling")}</span>
        <select value={form.resampleMm == null ? "none" : "iso"} disabled={disabled} style={{ ...input, width: 110 }}
          onChange={(e) => setForm((f) => ({ ...f, resampleMm: e.target.value === "none" ? null : 1 }))}>
          <option value="none">{t("roiFeat.resampling.none")}</option>
          <option value="iso">{t("roiFeat.resampling.iso")}</option>
        </select>
        {form.resampleMm != null && (
          <>
            <NumberField value={form.resampleMm} onChange={(v) => setForm((f) => ({ ...f, resampleMm: v }))}
              min={0.05} max={20} step={0.1} disabled={disabled} style={{ ...input, width: 64 }} />
            <span>mm</span>
          </>
        )}
      </div>
      <div style={{ ...label, marginTop: 6 }}>{t("roiFeat.field.families")}</div>
      <div style={grid}>
        {ROI_FEATURE_FAMILIES.map((fam) => (
          <label key={fam.key}>
            <input type="checkbox" checked={!!form.families[fam.key]} disabled={disabled}
              onChange={(e) => setForm((f) => ({ ...f, families: { ...f.families, [fam.key]: e.target.checked } }))} />{" "}
            {familyLabel(fam.key)}
          </label>
        ))}
      </div>
    </div>
  );
}

const row: React.CSSProperties = { display: "flex", alignItems: "center", gap: 10, padding: "3px 0", flexWrap: "wrap" };
const label: React.CSSProperties = { color: "#5a6672", minWidth: 110 };
const grid: React.CSSProperties = {
  display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))", gap: "2px 10px", marginTop: 4,
};
const input: React.CSSProperties = {
  boxSizing: "border-box", border: "1px solid #cdd5de", borderRadius: 4, fontSize: 12, padding: "3px 6px",
};
