/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { useState, type CSSProperties, type ReactNode } from "react";
import { NumberField } from "../hooks/NumberField";
import { useI18n } from "../i18n/i18n";
import { advancedToText, managedKeys, parseAdvanced } from "./advancedSettings";
import { useSettingsSchema } from "./useSettingsSchema";
import { familyUnits } from "./unitRules";
import {
  CALIBRATION_CHOICES, ROI_FEATURE_FAMILIES, VALUE_KIND_CHOICES, applyScale36, applySixStatistics, ivhBinWidthOf, isScale36,
  isSixStatistics, rangeBounds,
  type CalibrationChoice, type RoiFeatureForm, type ValueKindChoice,
} from "./roiFeatureSettings";

/**
 * PET の校正（SUV・SUL）の選択。範囲・離散化・特徴量は、校正後の値に対して働く。
 * 一括抽出の「VOI 統計」でも使うので、別の部品にしてある。
 */
export function CalibrationField({ form, setForm, disabled, testIdPrefix, layout }: {
  form: RoiFeatureForm;
  setForm: (f: (prev: RoiFeatureForm) => RoiFeatureForm) => void;
  disabled: boolean;
  testIdPrefix: "roifeat" | "batch";
  layout: { labelMinWidth: number; align: "left" | "right" };
}) {
  const { t } = useI18n();
  return (
    <>
      <Row label={t("roiFeat.field.calibration")} layout={layout} gap={8}>
        <select value={form.calibration} disabled={disabled} style={{ ...input, width: 320, maxWidth: "100%" }}
          data-testid={`${testIdPrefix}-calibration`} title={t("roiFeat.calibration.tooltip")}
          onChange={(e) => setForm((f) => ({ ...f, calibration: e.target.value as CalibrationChoice }))}>
          {CALIBRATION_CHOICES.map((c) => <option key={c} value={c}>{t(`roiFeat.calibration.${c}`)}</option>)}
        </select>
      </Row>
      <div style={{ color: "#5a6672", fontSize: 11, margin: "0 0 4px" }} data-testid={`${testIdPrefix}-calibration-help`}>
        {t("roiFeat.calibration.help")}
      </div>
      {form.calibration === "none" && (
        <div style={warnBand} data-testid={`${testIdPrefix}-calibration-none-warn`}>{t("roiFeat.calibration.noneWarn")}</div>
      )}
    </>
  );
}

/**
 * 詳細設定（上級者向け）: RadiomicsJ の設定キーを `KEY=値` で 1 行 1 項目に書く。他の欄が決めるキーは書けない（理由を出す）。
 * RadiomicsJ の既定値の一覧（backend から）を見て、行を追加できる。
 */
export function AdvancedSettingsField({ form, setForm, disabled, testIdPrefix }: {
  form: RoiFeatureForm;
  setForm: (f: (prev: RoiFeatureForm) => RoiFeatureForm) => void;
  disabled: boolean;
  testIdPrefix: "roifeat" | "batch";
}) {
  const { t } = useI18n();
  const p = testIdPrefix;
  const schema = useSettingsSchema();
  const [filter, setFilter] = useState("");
  // 既定値の一覧は、開いたときだけ描く（キーが 40 項目ほど並ぶので、閉じている間は DOM に出さない）
  const [defaultsOpen, setDefaultsOpen] = useState(false);
  const parsed = parseAdvanced(form.advancedText, schema);
  const managed = managedKeys();
  const shown = (schema ?? []).filter((e) => !managed.has(e.key) && e.key.toLowerCase().includes(filter.trim().toLowerCase())).slice(0, 40);
  const message = (e: (typeof parsed.errors)[number]): string =>
    t(`roiFeat.advanced.err.${e.code}`, {
      line: String(e.line), key: e.key, type: e.detail ?? "",
      field: e.code === "managed" ? t(`roiFeat.advanced.group.${e.detail}`) : "",
    });
  const append = (key: string, v: string | null) =>
    setForm((f) => {
      const cur = parseAdvanced(f.advancedText).entries;
      if (key in cur) return f;
      return { ...f, advancedText: advancedToText({ ...cur, [key]: v ?? "" }) };
    });
  return (
    <details open={form.advancedText.trim() !== ""} style={{ marginTop: 8 }} data-testid={`${p}-advanced`}>
      <summary style={{ cursor: "pointer", color: "#5a6672" }}>{t("roiFeat.advanced.title")}</summary>
      <div style={{ color: "#5a6672", fontSize: 11, margin: "4px 0" }} data-testid={`${p}-advanced-help`}>{t("roiFeat.advanced.help")}</div>
      <textarea value={form.advancedText} disabled={disabled} rows={4} spellCheck={false}
        placeholder={t("roiFeat.advanced.placeholder")} data-testid={`${p}-advanced-text`}
        style={{ ...input, width: "100%", fontFamily: "monospace", resize: "vertical" }}
        onChange={(e) => setForm((f) => ({ ...f, advancedText: e.target.value }))} />
      {parsed.errors.length > 0 && (
        <ul style={{ ...warnBand, margin: "4px 0", paddingLeft: 22, color: "#b00020", background: "#fdecee", borderColor: "#e6a4ad" }}
          data-testid={`${p}-advanced-errors`}>
          {parsed.errors.map((e, i) => <li key={i}>{message(e)}</li>)}
        </ul>
      )}
      <details style={{ marginTop: 4 }} data-testid={`${p}-advanced-defaults`}
        onToggle={(e) => setDefaultsOpen((e.currentTarget as HTMLDetailsElement).open)}>
        <summary style={{ cursor: "pointer", color: "#5a6672", fontSize: 11 }}>{t("roiFeat.advanced.defaults.title")}</summary>
        {defaultsOpen && !schema && <div style={{ color: "#7a4b00", fontSize: 11 }}>{t("roiFeat.advanced.defaults.unavailable")}</div>}
        {defaultsOpen && schema && (
          <>
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t("roiFeat.advanced.defaults.filter")}
              data-testid={`${p}-advanced-filter`} style={{ ...input, width: 220, margin: "4px 0" }} />
            <div style={{ maxHeight: 160, overflowY: "auto", fontSize: 11, fontFamily: "monospace" }}>
              {shown.map((e) => (
                <div key={e.key} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <button type="button" disabled={disabled} style={{ fontSize: 11 }} data-testid={`${p}-advanced-add-${e.key}`}
                    onClick={() => append(e.key, e.defaultValue)}>{t("roiFeat.advanced.defaults.add")}</button>
                  <span>{e.key}</span>
                  <span style={{ color: "#6b7785" }}>= {e.defaultValue === null || e.defaultValue === "" ? t("roiFeat.advanced.defaults.none") : e.defaultValue}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </details>
    </details>
  );
}

/**
 * 値の種類（離散の校正値・連続の校正値・任意単位）の選択と、それで決まる IVH のビン幅・補間後の丸め。
 * 自動は DICOM のメタデータから判定する（結果の表に判定と根拠が残る）。
 */
export function ValueKindField({ form, setForm, disabled, testIdPrefix, layout }: {
  form: RoiFeatureForm;
  setForm: (f: (prev: RoiFeatureForm) => RoiFeatureForm) => void;
  disabled: boolean;
  testIdPrefix: "roifeat" | "batch";
  layout: { labelMinWidth: number; align: "left" | "right" };
}) {
  const { t } = useI18n();
  const k = form.valueKind;
  const binWidthProblem = ivhBinWidthOf(form).problem !== null;
  const showBinWidth = k === "auto" || k === "continuous";
  const showRounding = k === "auto" || k === "discrete";
  return (
    <>
      <Row label={t("roiFeat.field.valueKind")} layout={layout} gap={8}>
        <select value={k} disabled={disabled} style={{ ...input, width: 320, maxWidth: "100%" }}
          data-testid={`${testIdPrefix}-valuekind`} title={t("roiFeat.valueKind.tooltip")}
          onChange={(e) => setForm((f) => ({ ...f, valueKind: e.target.value as ValueKindChoice }))}>
          {VALUE_KIND_CHOICES.map((c) => <option key={c} value={c}>{t(`roiFeat.valueKind.${c}`)}</option>)}
        </select>
      </Row>
      <div style={{ color: "#5a6672", fontSize: 11, margin: "0 0 4px" }} data-testid={`${testIdPrefix}-valuekind-help`}>
        {t(`roiFeat.valueKind.help.${k}`)}
      </div>
      {showBinWidth && (
        <Row label={t("roiFeat.field.ivhBinWidth")} layout={layout} gap={8}>
          <input value={form.ivhBinWidthText} disabled={disabled} style={{ ...input, width: 90 }} inputMode="decimal"
            placeholder={t("roiFeat.ivhBinWidth.placeholder")} data-testid={`${testIdPrefix}-ivh-binwidth`}
            title={t("roiFeat.ivhBinWidth.tooltip")}
            onChange={(e) => setForm((f) => ({ ...f, ivhBinWidthText: e.target.value }))} />
          <span style={{ color: "#5a6672", fontSize: 11 }}>{t("roiFeat.ivhBinWidth.unit")}</span>
        </Row>
      )}
      {showBinWidth && binWidthProblem && (
        <div style={warnBand} data-testid={`${testIdPrefix}-ivh-binwidth-warn`}>{t("roiFeat.ivhBinWidth.invalid")}</div>
      )}
      {showRounding && (
        <Row label={t("roiFeat.field.intensityRounding")} layout={layout} gap={8}>
          <label title={t("roiFeat.rounding.tooltip")}>
            <input type="checkbox" checked={form.intensityRounding} disabled={disabled}
              data-testid={`${testIdPrefix}-rounding`}
              onChange={(e) => setForm((f) => ({ ...f, intensityRounding: e.target.checked }))} /> {t("roiFeat.rounding.label")}
          </label>
        </Row>
      )}
    </>
  );
}

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
  twoDSelected,
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
  /**
   * 2D の単位を選んでいるか。渡すと、族の欄に計算される単位（3D のみ・2D のみ）を注記し、2D の単位を選んでいないときは
   * Shape2D を選べなくする。渡さない（一括抽出）ときは従来どおり注記も制限もしない。
   */
  twoDSelected?: boolean;
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
      <CalibrationField form={form} setForm={setForm} disabled={disabled} testIdPrefix={testIdPrefix} layout={layout} />
      <ValueKindField form={form} setForm={setForm} disabled={disabled} testIdPrefix={testIdPrefix} layout={layout} />
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
              <span style={{ color: "#5a6672", fontSize: 11 }} data-testid={`${p}-range-unit`}>{t("roiFeat.range.unit")}</span>
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
        {ROI_FEATURE_FAMILIES.map((fam) => {
          const u = familyUnits(fam.key);
          const gated = twoDSelected !== undefined;
          const blocked = gated && !u.in3d && !twoDSelected;
          const unitNote = !gated || (u.in3d && u.in2d) ? "" : u.in3d ? t("roiFeat.family.only3d") : t("roiFeat.family.only2d");
          return (
            <label key={fam.key} title={blocked ? t("roiFeat.family.needs2d") : undefined}
              style={blocked ? { opacity: 0.55 } : undefined}>
              <input type="checkbox" checked={!!form.families[fam.key] && !blocked} disabled={disabled || blocked}
                data-testid={`${p}-family-${fam.key}`}
                onChange={(e) => setForm((f) => ({ ...f, families: { ...f.families, [fam.key]: e.target.checked } }))} />{" "}
              {familyLabel(fam.key)}{unitNote && <span style={{ color: "#5a6672", fontSize: 11 }}>{unitNote}</span>}
            </label>
          );
        })}
      </div>
      <AdvancedSettingsField form={form} setForm={setForm} disabled={disabled} testIdPrefix={testIdPrefix} />
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
