/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { useEffect, useState } from "react";
import { useI18n } from "../i18n/i18n";
import { SMALL_ROI_VOXELS_MAX, type SpecKind, type SpecQc, type SpecQcMode } from "./batchSpec";
import { RoiFeatureSettingsFields } from "./RoiFeatureSettingsFields";
import type { RoiFeatureForm } from "./roiFeatureSettings";

/**
 * 一括抽出の特徴量の設定欄。離散化・リサンプリング・範囲・プリセット・族は ROI 特徴量の画面と共通の `RoiFeatureSettingsFields`。値と変換も同じ
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
  kind,
  setKind,
}: {
  form: RoiFeatureForm;
  setForm: (f: (prev: RoiFeatureForm) => RoiFeatureForm) => void;
  disabled: boolean;
  qc: SpecQc;
  setQc: (q: SpecQc) => void;
  labelsText: string;
  setLabelsText: (s: string) => void;
  kind: SpecKind;
  setKind: (k: SpecKind) => void;
}) {
  const { t } = useI18n();
  const labelsAndQc = (
          <>
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
          </>
  );
  return (
    <div data-testid="batch-settings" style={{ fontSize: 12 }}>
      <div style={row} data-testid="batch-kind">
        <span style={label}>{t("roiFeat.batch.kind.title")}</span>
        {(["radiomics", "voiStats"] as const).map((k) => (
          <label key={k}>
            <input type="radio" name="batch-kind" checked={kind === k} disabled={disabled} data-testid={`batch-kind-${k}`}
              onChange={() => setKind(k)} /> {t(`roiFeat.batch.kind.${k}`)}
          </label>
        ))}
      </div>
      {kind === "voiStats" ? (
        <>
          <div style={hint} data-testid="batch-kind-voi-help">{t("roiFeat.batch.kind.voiHelp")}</div>
          {labelsAndQc}
        </>
      ) : (
        <RoiFeatureSettingsFields form={form} setForm={setForm} disabled={disabled} testIdPrefix="batch"
          layout={{ labelMinWidth: 110, align: "left" }} showRange showPreset presetScale36={false}
          middleSlot={labelsAndQc} />
      )}
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
const input: React.CSSProperties = {
  boxSizing: "border-box", border: "1px solid #cdd5de", borderRadius: 4, fontSize: 12, padding: "3px 6px",
};
