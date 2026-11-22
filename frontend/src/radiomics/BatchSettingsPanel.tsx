/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { useEffect, useState } from "react";
import { useI18n } from "../i18n/i18n";
import { SMALL_ROI_VOXELS_MAX, type SpecKind, type SpecQc, type SpecQcMode } from "./batchSpec";
import { CalibrationField, RoiFeatureSettingsFields, SettingsGroup } from "./RoiFeatureSettingsFields";
import { UNITS_2D, type RoiFeatureForm } from "./roiFeatureSettings";

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
  const unitsSummary = [
    t("roiFeat.mode.whole"),
    ...UNITS_2D.filter((u) => form.units2d.includes(u)).map((u) => t(u === "MAX_SECTION_2D" ? "roiFeat.mode.section" : "roiFeat.mode.slices")),
    ...(form.units2d.length > 0 && form.planesAll ? [t("roiFeat.planes.all")] : []),
  ].join(" + ");
  const labelsAndQc = (
          <>
            <div style={row}>
              <span style={label} title={t("roiFeat.tip.bLabels")}>{t("roiFeat.batch.labels")}</span>
              <input data-testid="batch-labels" value={labelsText} placeholder="GTV, tumor" disabled={disabled}
                style={{ ...input, width: 300 }} onChange={(e) => setLabelsText(e.target.value)} />
              <span style={hint}>{t("roiFeat.batch.labelsHelp")}</span>
            </div>
            <div style={row} data-testid="batch-qc">
              <span style={label} title={t("roiFeat.tip.bQc")}>{t("roiFeat.batch.qc.title")}</span>
              {/* 項目ごとのまとまりは折り返さない（幅が足りないときは、まとまりの間で折り返す） */}
              <span style={qcGroup}>
                <span title={t("roiFeat.tip.bQcSmall")}>{t("roiFeat.batch.qc.smallRoi")}</span>
                <QcRadios name="qc-small" value={qc.smallRoi} disabled={disabled} testId="batch-qc-small"
                  onChange={(v) => setQc({ ...qc, smallRoi: v })} />
                {/* 基準値は「小さい ROI」の値なので、その項目の隣に置く（非可逆圧縮より前） */}
                <span style={{ marginLeft: 4 }}>{t("roiFeat.batch.qc.voxels")}</span>
                <VoxelsField value={qc.smallRoiVoxels} disabled={disabled} onChange={(v) => setQc({ ...qc, smallRoiVoxels: v })} />
                <span>{t("roiFeat.batch.qc.voxelsUnit")}</span>
                <span style={{ marginLeft: 4 }} title={t("roiFeat.batch.qc.pixelsHelp")}>{t("roiFeat.batch.qc.pixels")}</span>
                <VoxelsField value={qc.smallRoiPixels} disabled={disabled} testId="batch-qc-pixels" help={t("roiFeat.batch.qc.pixelsHelp")}
                  onChange={(v) => setQc({ ...qc, smallRoiPixels: v })} />
                <span>{t("roiFeat.batch.qc.pixelsUnit")}</span>
              </span>
              <span style={qcGroup}>
                <span title={t("roiFeat.tip.bQcLossy")}>{t("roiFeat.batch.qc.lossy")}</span>
                <QcRadios name="qc-lossy" value={qc.lossy} disabled={disabled} testId="batch-qc-lossy"
                  onChange={(v) => setQc({ ...qc, lossy: v })} />
              </span>
            </div>
            <div style={hint}>{t("roiFeat.batch.qc.help")} {t("roiFeat.batch.qc.voxelsHelp")}</div>
          </>
  );
  return (
    <div data-testid="batch-settings" style={{ fontSize: 12 }}>
      <div style={row} data-testid="batch-kind">
        <span style={label} title={t("roiFeat.tip.bKind")}>{t("roiFeat.batch.kind.title")}</span>
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
          <CalibrationField form={form} setForm={setForm} disabled={disabled} testIdPrefix="batch"
            layout={{ labelMinWidth: 110, align: "left" }} />
          {labelsAndQc}
        </>
      ) : (
        <RoiFeatureSettingsFields form={form} setForm={setForm} disabled={disabled} testIdPrefix="batch"
          layout={{ labelMinWidth: 110, align: "left" }} showRange showPreset presetScale36={false}
          twoDSelected={form.units2d.length > 0}
          contentSummary={unitsSummary}
          contentSlot={(
            <>
              <div style={row} data-testid="batch-units">
                <span style={label} title={t("roiFeat.tip.modes")}>{t("roiFeat.field.modes")}</span>
                <label title={t("roiFeat.mode.alwaysOn")}>
                  <input type="checkbox" checked disabled /> {t("roiFeat.mode.whole")}
                </label>
                {UNITS_2D.map((u) => (
                  <label key={u}>
                    <input type="checkbox" checked={form.units2d.includes(u)} disabled={disabled} data-testid={`batch-unit-${u}`}
                      onChange={(e) => setForm((f) => {
                        const next = UNITS_2D.filter((x) => (x === u ? e.target.checked : f.units2d.includes(x)));
                        return { ...f, units2d: [...next], planesAll: next.length > 0 && f.planesAll };
                      })} /> {t(u === "MAX_SECTION_2D" ? "roiFeat.mode.section" : "roiFeat.mode.slices")}
                  </label>
                ))}
              </div>
              {form.units2d.length > 0 && (
                <>
                  <div style={row} data-testid="batch-planes">
                    <span style={label} title={t("roiFeat.tip.planes")}>{t("roiFeat.field.planes")}</span>
                    <label><input type="radio" name="batch-planes" checked={!form.planesAll} disabled={disabled} data-testid="batch-planes-acquisition"
                      onChange={() => setForm((f) => ({ ...f, planesAll: false }))} /> {t("roiFeat.planes.acquisition")}</label>
                    <label><input type="radio" name="batch-planes" checked={form.planesAll} disabled={disabled} data-testid="batch-planes-all"
                      onChange={() => setForm((f) => ({ ...f, planesAll: true }))} /> {t("roiFeat.planes.all")}</label>
                  </div>
                  <div style={hint} data-testid="batch-units-help">{t("roiFeat.batch.units.help")}</div>
                </>
              )}
            </>
          )}
          qcSlot={(
            <SettingsGroup id="qc" prefix="batch" defaultOpen={false} title={t("roiFeat.group.qc")}
              summary={t("roiFeat.group.qc.summary", {
                small: t(`roiFeat.group.qcMode.${qc.smallRoi}`), lossy: t(`roiFeat.group.qcMode.${qc.lossy}`),
                labels: labelsText.trim() === "" ? t("roiFeat.resampling.none") : labelsText.trim() })}
              nonDefault={qc.smallRoi !== "FLAG" || qc.lossy !== "FLAG" || qc.smallRoiVoxels != null || qc.smallRoiPixels != null || labelsText.trim() !== ""}>
              {labelsAndQc}
            </SettingsGroup>
          )} />
      )}
    </div>
  );
}

/** 基準値の入力欄。空欄は null（環境設定の値を使う）。整数以外・範囲外の打鍵は確定せず、赤枠で知らせる。 */
function VoxelsField({ value, disabled, onChange, testId = "batch-qc-voxels", help }: {
  value: number | null; disabled: boolean; onChange: (v: number | null) => void; testId?: string; help?: string;
}) {
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
    <input data-testid={testId} type="text" inputMode="numeric" value={text} disabled={disabled}
      placeholder={t("roiFeat.batch.qc.voxelsEmpty")} title={help ?? t("roiFeat.batch.qc.voxelsHelp")}
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
      <label title={t("roiFeat.batch.qc.skipTip")}><input type="radio" name={name} checked={value === "SKIP"} disabled={disabled}
        onChange={() => onChange("SKIP")} /> {t("roiFeat.batch.qc.skip")}</label>
    </span>
  );
}

const qcGroup: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: 8, whiteSpace: "nowrap" };
const hint: React.CSSProperties = { color: "#6b7785", fontSize: 11 };
const row: React.CSSProperties = { display: "flex", alignItems: "center", gap: 10, padding: "3px 0", flexWrap: "wrap" };
const label: React.CSSProperties = { color: "#5a6672", minWidth: 110 };
const input: React.CSSProperties = {
  boxSizing: "border-box", border: "1px solid #cdd5de", borderRadius: 4, fontSize: 12, padding: "3px 6px",
};
