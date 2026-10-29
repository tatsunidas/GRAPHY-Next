/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { useEffect, useState } from "react";
import { NumberField } from "../hooks/NumberField";
import { useI18n } from "../i18n/i18n";
import { SMALL_ROI_VOXELS_MAX, type SpecQc, type SpecQcMode } from "./batchSpec";
import { ROI_FEATURE_FAMILIES, type RoiFeatureForm } from "./roiFeatureSettings";

/**
 * 一括抽出の特徴量の設定欄（離散化・リサンプリング・族）。値と変換は ROI 特徴量の画面と同じ
 * `RoiFeatureForm`・`roiFeatureSettings` を使い、入力欄だけを持つ。画像フィルタと 2D の単位は含めない。
 */
export function BatchSettingsPanel({
  form,
  setForm,
  disabled,
  qc,
  setQc,
  labelsText,
  setLabelsText,
}: {
  form: RoiFeatureForm;
  setForm: (f: (prev: RoiFeatureForm) => RoiFeatureForm) => void;
  disabled: boolean;
  qc: SpecQc;
  setQc: (q: SpecQc) => void;
  labelsText: string;
  setLabelsText: (s: string) => void;
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
      <div style={row}>
        <span style={label}>{t("roiFeat.batch.labels")}</span>
        <input data-testid="batch-labels" value={labelsText} placeholder="GTV, tumor" disabled={disabled}
          style={{ ...input, width: 300 }} onChange={(e) => setLabelsText(e.target.value)} />
        <span style={hint}>{t("roiFeat.batch.labelsHelp")}</span>
      </div>
      <div style={row} data-testid="batch-qc">
        <span style={label}>{t("roiFeat.batch.qc.title")}</span>
        <span>{t("roiFeat.batch.qc.smallRoi")}</span>
        <QcRadios name="qc-small" value={qc.smallRoi} disabled={disabled} testId="batch-qc-small"
          onChange={(v) => setQc({ ...qc, smallRoi: v })} />
        <span style={{ marginLeft: 10 }}>{t("roiFeat.batch.qc.lossy")}</span>
        <QcRadios name="qc-lossy" value={qc.lossy} disabled={disabled} testId="batch-qc-lossy"
          onChange={(v) => setQc({ ...qc, lossy: v })} />
        <span style={{ marginLeft: 10 }}>{t("roiFeat.batch.qc.voxels")}</span>
        <VoxelsField value={qc.smallRoiVoxels} disabled={disabled} onChange={(v) => setQc({ ...qc, smallRoiVoxels: v })} />
        <span>{t("roiFeat.batch.qc.voxelsUnit")}</span>
      </div>
      <div style={hint}>{t("roiFeat.batch.qc.help")} {t("roiFeat.batch.qc.voxelsHelp")}</div>
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

/** 基準値の入力欄。空欄は null（環境設定の値を使う）。整数以外・範囲外の打鍵は確定せず、赤枠で知らせる。 */
function VoxelsField({ value, disabled, onChange }: { value: number | null; disabled: boolean; onChange: (v: number | null) => void }) {
  const { t } = useI18n();
  const [text, setText] = useState(value == null ? "" : String(value));
  useEffect(() => {
    // 定義の読み込みなど、外から値が変わったときだけ追従する
    if ((text.trim() === "" ? null : Number(text)) !== value) setText(value == null ? "" : String(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  const parsed = (s: string): number | null | undefined => {
    const x = s.trim();
    if (x === "") return null;
    if (!/^\d+$/.test(x)) return undefined;
    const n = Number(x);
    return n >= 1 && n <= SMALL_ROI_VOXELS_MAX ? n : undefined;
  };
  const bad = parsed(text) === undefined;
  return (
    <input data-testid="batch-qc-voxels" type="text" inputMode="numeric" value={text} disabled={disabled}
      placeholder={t("roiFeat.batch.qc.voxelsEmpty")} title={t("roiFeat.batch.qc.voxelsHelp")}
      style={{ ...input, width: 110, ...(bad ? { border: "1px solid #c0392b" } : {}) }}
      onChange={(e) => {
        setText(e.target.value);
        const v = parsed(e.target.value);
        if (v !== undefined) onChange(v);
      }} />
  );
}

function QcRadios({ name, value, disabled, onChange, testId }: {
  name: string; value: SpecQcMode; disabled: boolean; onChange: (v: SpecQcMode) => void; testId: string;
}) {
  const { t } = useI18n();
  return (
    <span data-testid={testId} style={{ display: "inline-flex", gap: 8 }}>
      <label><input type="radio" name={name} checked={value === "FLAG"} disabled={disabled}
        onChange={() => onChange("FLAG")} /> {t("roiFeat.batch.qc.flag")}</label>
      <label><input type="radio" name={name} checked={value === "STOP"} disabled={disabled}
        onChange={() => onChange("STOP")} /> {t("roiFeat.batch.qc.stop")}</label>
    </span>
  );
}

const hint: React.CSSProperties = { color: "#6b7785", fontSize: 11 };
const row: React.CSSProperties = { display: "flex", alignItems: "center", gap: 10, padding: "3px 0", flexWrap: "wrap" };
const label: React.CSSProperties = { color: "#5a6672", minWidth: 110 };
const grid: React.CSSProperties = {
  display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))", gap: "2px 10px", marginTop: 4,
};
const input: React.CSSProperties = {
  boxSizing: "border-box", border: "1px solid #cdd5de", borderRadius: 4, fontSize: 12, padding: "3px 6px",
};
