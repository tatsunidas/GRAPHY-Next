/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import type { FindProfile } from "../api";
import { useI18n } from "../i18n/i18n";

/** 返却項目のひな形。standard は「指定なし」（backend の標準の一覧を使う）。 */
export const KEY_PRESETS = {
  standard: undefined,
  minimal: { patientKeys: ["PatientID"], studyKeys: ["StudyInstanceUID"], seriesKeys: ["SeriesInstanceUID"] },
  basic: { patientKeys: undefined, studyKeys: ["StudyInstanceUID", "PatientID", "PatientName", "StudyDate", "AccessionNumber"], seriesKeys: undefined },
} as const;

export type KeyPreset = keyof typeof KEY_PRESETS;

export function presetOf(p: FindProfile | null | undefined): KeyPreset | "custom" {
  const sk = p?.studyKeys;
  if (!sk || sk.length === 0) return "standard";
  const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
  if (same(sk, KEY_PRESETS.minimal.studyKeys)) return "minimal";
  if (same(sk, KEY_PRESETS.basic.studyKeys)) return "basic";
  return "custom";
}

/** 空の項目を落とす。何も残らなければ null（＝標準）。 */
export function compactProfile(p: FindProfile): FindProfile | null {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) {
    if (v == null) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    if (k === "model" && v === "StudyRoot") continue;
    if (k === "wildcard" && v === "contains") continue;
    if (k === "charset" && v === "") continue;
    out[k] = v;
  }
  return Object.keys(out).length === 0 ? null : (out as FindProfile);
}

interface Props {
  value: FindProfile | null | undefined;
  onChange: (p: FindProfile | null) => void;
}

/** 通信先ごとの検索方式の編集（通常は触らない。通る組み合わせは［通信テスト］で見つけられる）。 */
export function FindProfileEditor({ value, onChange }: Props) {
  const { t } = useI18n();
  const v: FindProfile = value ?? {};
  const set = (patch: Partial<FindProfile>) => onChange(compactProfile({ ...v, ...patch }));
  const preset = presetOf(v);

  return (
    <div style={box} data-testid="find-editor">
      <label style={lab}>
        <span>{t("qrProbe.fp.model")}</span>
        <select style={sel} value={v.model ?? "StudyRoot"} data-testid="fp-model"
          onChange={(e) => set({ model: e.target.value as FindProfile["model"] })}>
          <option value="StudyRoot">{t("qrProbe.fp.model.StudyRoot")}</option>
          <option value="PatientRoot">{t("qrProbe.fp.model.PatientRoot")}</option>
        </select>
      </label>
      <label style={lab}>
        <span>{t("qrProbe.fp.keys")}</span>
        <select style={sel} value={preset} data-testid="fp-keys"
          onChange={(e) => {
            const k = e.target.value as KeyPreset;
            const p = KEY_PRESETS[k];
            set(p ? { ...p } : { patientKeys: undefined, studyKeys: undefined, seriesKeys: undefined });
          }}>
          <option value="standard">{t("qrProbe.fp.keys.standard")}</option>
          <option value="minimal">{t("qrProbe.fp.keys.minimal")}</option>
          <option value="basic">{t("qrProbe.fp.keys.basic")}</option>
          {preset === "custom" && <option value="custom">{(v.studyKeys ?? []).join(", ")}</option>}
        </select>
      </label>
      <label style={lab}>
        <span>{t("qrProbe.fp.wildcard")}</span>
        <select style={sel} value={v.wildcard ?? "contains"} data-testid="fp-wildcard"
          onChange={(e) => set({ wildcard: e.target.value as FindProfile["wildcard"] })}>
          <option value="contains">{t("qrProbe.fp.wildcard.contains")}</option>
          <option value="prefix">{t("qrProbe.fp.wildcard.prefix")}</option>
          <option value="exact">{t("qrProbe.fp.wildcard.exact")}</option>
        </select>
      </label>
      <label style={lab}>
        <span>{t("qrProbe.fp.ts")}</span>
        <select style={sel} value={v.transferSyntax ?? "default"} data-testid="fp-ts"
          onChange={(e) => set({ transferSyntax: e.target.value === "default" ? undefined : (e.target.value as FindProfile["transferSyntax"]) })}>
          <option value="default">{t("qrProbe.fp.ts.default")}</option>
          <option value="implicit">{t("qrProbe.fp.ts.implicit")}</option>
          <option value="explicit">{t("qrProbe.fp.ts.explicit")}</option>
        </select>
      </label>
      <label style={lab}>
        <span>{t("qrProbe.fp.charset")}</span>
        <select style={sel} value={v.charset ?? ""} data-testid="fp-charset"
          onChange={(e) => set({ charset: e.target.value || undefined })}>
          <option value="">{t("qrProbe.fp.charset.none")}</option>
          <option value="ISO_IR 192">UTF-8（ISO_IR 192）</option>
          <option value="ISO 2022 IR 87">ISO 2022 IR 87</option>
        </select>
      </label>
      <button style={btn} data-testid="fp-reset" onClick={() => onChange(null)}>{t("qrProbe.fp.reset")}</button>
    </div>
  );
}

const box: React.CSSProperties = { margin: "2px 0 10px 12px", padding: "10px 12px", border: "1px solid #dfe5ec", borderRadius: 6, background: "#f8fafc", display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" };
const lab: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 2, fontSize: 11, color: "#5a6672" };
const sel: React.CSSProperties = { padding: "4px 6px", border: "1px solid #cdd5de", borderRadius: 5, fontSize: 13, maxWidth: 240 };
const btn: React.CSSProperties = { padding: "5px 12px", border: "1px solid #cdd5de", borderRadius: 6, background: "#fff", cursor: "pointer", fontSize: 13 };
