/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import type { CSSProperties, ReactNode } from "react";
import { NumberField } from "../hooks/NumberField";
import { useI18n } from "../i18n/i18n";
import {
  ROI_FEATURE_FAMILIES, applyScale36, applySixStatistics, isScale36, isSixStatistics, rangeBounds,
  type RoiFeatureForm,
} from "./roiFeatureSettings";

/**
 * ROI 特徴量の設定欄の共通部分（離散化・リサンプリング・範囲・プリセット・特徴量の族）。
 * ROI 特徴量の画面と一括抽出ダイアログが同じ部品を使い、`RoiFeatureForm` と `roiFeatureSettings` の値の扱いをそろえる。
 * 画面だけにある欄（画像フィルタなど）と、一括抽出だけにある欄（絞り込み・QC）は `middleSlot` で差し込む。
 */
export function RoiFeatureSettingsFields({
  form,
  setForm,
  disabled,
  testIdPrefix,
  layout,
  showRange,
  showPreset,
  presetScale36 = true,
  middleSlot,
}: {
  form: RoiFeatureForm;
  setForm: (f: (prev: RoiFeatureForm) => RoiFeatureForm) => void;
  disabled: boolean;
  /** data-testid の接頭辞（画面は `roifeat`、一括抽出は `batch`）。 */
  testIdPrefix: "roifeat" | "batch";
  /** 行の見た目。画面は右寄せ（項目名の幅 150）、一括抽出は左詰め（幅 110）。 */
  layout: { labelMinWidth: number; align: "left" | "right" };
  showRange: boolean;
  showPreset: boolean;
  /** プリセットに「36 特徴」（LoG が前提）を出すか。画像フィルタを使わない一括抽出は false。 */
  presetScale36?: boolean;
  /** 範囲（無ければリサンプリング）の後、プリセット（無ければ族）の前に差し込む。 */
  middleSlot?: ReactNode;
}) {
  const { t } = useI18n();
  const p = testIdPrefix;
  const familyLabel = (key: string): string => {
    const k = `roiFeat.family.${key}`;
    const v = t(k);
    return v === k ? key : v;
  };
  const rangeProblem = rangeBounds(form).problem;
  const row = (labelText: string, gap: number, children: ReactNode) => (
    <Row label={labelText} layout={layout} gap={gap}>{children}</Row>
  );
  return (
    <>
      {row(t("roiFeat.field.discretisation"), 8, (
        <>
          <label>
            <input type="radio" checked={form.fixedBinNumber} disabled={disabled}
              onChange={() => setForm((f) => ({ ...f, fixedBinNumber: true }))} /> {t("roiFeat.disc.binCount")}
          </label>
          <span data-testid={`${p}-bincount`}>
            <NumberField value={form.binCount} onChange={(v) => setForm((f) => ({ ...f, binCount: v }))}
              min={2} max={1024} disabled={disabled || !form.fixedBinNumber} style={{ ...input, width: 64 }} />
          </span>
          <label>
            <input type="radio" checked={!form.fixedBinNumber} disabled={disabled}
              onChange={() => setForm((f) => ({ ...f, fixedBinNumber: false }))} /> {t("roiFeat.disc.binWidth")}
          </label>
          <NumberField value={form.binWidth} onChange={(v) => setForm((f) => ({ ...f, binWidth: v }))}
            min={0.001} max={100000} step={0.5} disabled={disabled || form.fixedBinNumber} style={{ ...input, width: 64 }} />
        </>
      ))}
      {row(t("roiFeat.field.resampling"), 8, (
        <>
          <select value={form.resampleMm == null ? "none" : "iso"} disabled={disabled} style={{ ...input, width: 110 }}
            data-testid={`${p}-resampling`}
            onChange={(e) => setForm((f) => ({ ...f, resampleMm: e.target.value === "none" ? null : 1 }))}>
            <option value="none">{t("roiFeat.resampling.none")}</option>
            <option value="iso">{t("roiFeat.resampling.iso")}</option>
          </select>
          {form.resampleMm != null && (
            <>
              <span data-testid={`${p}-resample-mm`}>
                <NumberField value={form.resampleMm} onChange={(v) => setForm((f) => ({ ...f, resampleMm: v }))}
                  min={0.05} max={20} step={0.1} disabled={disabled} style={{ ...input, width: 64 }} />
              </span>
              <span>mm</span>
            </>
          )}
        </>
      ))}
      {showRange && (
        <>
          {row(t("roiFeat.field.range"), 6, (
            <>
              <input value={form.rangeMinText} disabled={disabled} style={{ ...input, width: 72 }} inputMode="decimal"
                placeholder={t("roiFeat.range.min")} data-testid={`${p}-range-min`}
                onChange={(e) => setForm((f) => ({ ...f, rangeMinText: e.target.value }))} />
              <span>〜</span>
              <input value={form.rangeMaxText} disabled={disabled} style={{ ...input, width: 72 }} inputMode="decimal"
                placeholder={t("roiFeat.range.max")} data-testid={`${p}-range-max`}
                onChange={(e) => setForm((f) => ({ ...f, rangeMaxText: e.target.value }))} />
            </>
          ))}
          {rangeProblem && (
            <div style={warnBand} data-testid={`${p}-range-problem`}>{t(`roiFeat.range.problem.${rangeProblem}`)}</div>
          )}
        </>
      )}
      {middleSlot}
      {showPreset && row(t("roiFeat.field.preset"), 8, (
        <select value={presetScale36 && isScale36(form) ? "scale36" : isSixStatistics(form) ? "six" : "custom"} disabled={disabled}
          style={{ ...input, width: 260 }} data-testid={`${p}-preset`}
          onChange={(e) => {
            if (e.target.value === "six") setForm((f) => applySixStatistics(f));
            if (e.target.value === "scale36") setForm((f) => applyScale36(f));
          }}>
          <option value="custom">{t("roiFeat.preset.custom")}</option>
          <option value="six">{t("roiFeat.preset.six")}</option>
          {presetScale36 && <option value="scale36">{t("roiFeat.preset.scale36")}</option>}
        </select>
      ))}
      <div style={{ color: "#5a6672", marginTop: 6 }}>{t("roiFeat.field.families")}</div>
      <div style={familyGrid}>
        {ROI_FEATURE_FAMILIES.map((fam) => (
          <label key={fam.key}>
            <input type="checkbox" checked={!!form.families[fam.key]} disabled={disabled}
              onChange={(e) => setForm((f) => ({ ...f, families: { ...f.families, [fam.key]: e.target.checked } }))} />{" "}
            {familyLabel(fam.key)}
          </label>
        ))}
      </div>
    </>
  );
}

/** 項目名と値の 1 行。右寄せは ROI 特徴量の画面の `Field`、左詰めは一括抽出の設定欄の行と同じ見た目。 */
function Row({ label, layout, gap, children }: {
  label: string; layout: { labelMinWidth: number; align: "left" | "right" }; gap: number; children: ReactNode;
}) {
  if (layout.align === "right") {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "3px 0" }}>
        <span style={{ color: "#5a6672", flex: "none", minWidth: layout.labelMinWidth }}>{label}</span>
        <span style={{ flex: 1, textAlign: "right" }}>
          <span style={{ display: "inline-flex", gap, alignItems: "center", justifyContent: "flex-end" }}>{children}</span>
        </span>
      </div>
    );
  }
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "3px 0", flexWrap: "wrap" }}>
      <span style={{ color: "#5a6672", minWidth: layout.labelMinWidth }}>{label}</span>
      {children}
    </div>
  );
}

const input: CSSProperties = {
  boxSizing: "border-box", border: "1px solid #cdd5de", borderRadius: 4, fontSize: 12, padding: "3px 6px",
};
const warnBand: CSSProperties = {
  marginTop: 6, padding: "6px 10px", fontSize: 12, color: "#7a4b00", background: "#fff4d6",
  border: "1px solid #f0c36d", borderRadius: 4,
};
const familyGrid: CSSProperties = {
  display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))", gap: "2px 10px", marginTop: 4,
};
