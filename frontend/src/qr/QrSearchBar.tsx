/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import type { StudyFilters } from "../api";
import { useI18n } from "../i18n/i18n";

/** QR 検索バーの 1 行コンパクト版。ローカル Search ボタンは持たず、上部の Query ボタンで実行する。 */
const MODALITIES = ["CT", "MR", "CR", "DX", "US", "XA", "RF", "MG", "NM", "PT", "OT", "SC"];

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
function ymd(d: Date): string {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}
function shift(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return ymd(d);
}
/** "YYYYMMDD" → input[type=date] 用 "YYYY-MM-DD"。 */
function toInput(s?: string): string {
  return s && s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : "";
}
/** input[type=date] "YYYY-MM-DD" → "YYYYMMDD"（空は undefined）。 */
function fromInput(s: string): string | undefined {
  const v = s.replace(/-/g, "");
  return v ? v : undefined;
}

export function QrSearchBar({
  value,
  onChange,
}: {
  value: StudyFilters;
  onChange: (f: StudyFilters) => void;
}) {
  const { t } = useI18n();
  const set = (patch: Partial<StudyFilters>) => onChange({ ...value, ...patch });
  const setRange = (from?: string, to?: string) => set({ studyDateFrom: from, studyDateTo: to });

  return (
    <div style={bar}>
      <Field label={t("field.patientId")}>
        <input
          style={inp}
          value={value.patientId ?? ""}
          onChange={(e) => set({ patientId: e.target.value || undefined })}
          placeholder={t("main.search.partialHint")}
        />
      </Field>
      <Field label={t("field.patientName")}>
        <input
          style={inp}
          value={value.patientName ?? ""}
          onChange={(e) => set({ patientName: e.target.value || undefined })}
          placeholder={t("main.search.partialHint")}
        />
      </Field>
      <Field label={t("main.search.studyDate")}>
        <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
          <input
            type="date"
            style={dateInp}
            value={toInput(value.studyDateFrom)}
            onChange={(e) => set({ studyDateFrom: fromInput(e.target.value) })}
          />
          <span style={{ color: "#8a98a6" }}>–</span>
          <input
            type="date"
            style={dateInp}
            value={toInput(value.studyDateTo)}
            onChange={(e) => set({ studyDateTo: fromInput(e.target.value) })}
          />
        </div>
      </Field>
      <div style={{ display: "flex", gap: 3, alignSelf: "flex-end", paddingBottom: 1 }}>
        <button style={chip} onClick={() => setRange(shift(0), shift(0))}>{t("main.search.today")}</button>
        <button style={chip} onClick={() => setRange(shift(-1), shift(-1))}>{t("main.search.yesterday")}</button>
        <button style={chip} onClick={() => setRange(shift(-6), shift(0))}>{t("main.search.week")}</button>
        <button style={chip} onClick={() => setRange(undefined, undefined)}>{t("qr.search.allDates")}</button>
      </div>
      <Field label={t("field.modality")}>
        <select
          style={sel}
          value={value.modality ?? ""}
          onChange={(e) => set({ modality: e.target.value || undefined })}
        >
          <option value="">{t("qr.search.anyModality")}</option>
          {MODALITIES.map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
      </Field>
      <Field label={t("main.search.accession")}>
        <input
          style={inp}
          value={value.accessionNumber ?? ""}
          onChange={(e) => set({ accessionNumber: e.target.value || undefined })}
        />
      </Field>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={fieldBox}>
      <span style={fieldLabel}>{label}</span>
      {children}
    </label>
  );
}

const bar: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-end",
  flexWrap: "wrap",
  gap: "6px 14px",
  padding: "6px 14px",
  borderBottom: "1px solid #e6eaee",
  background: "#fbfcfd",
};
const fieldBox: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 2 };
const fieldLabel: React.CSSProperties = { fontSize: 11, color: "#6b7785" };
const inp: React.CSSProperties = { width: 130, padding: "4px 7px", border: "1px solid #cdd5de", borderRadius: 5, fontSize: 12.5 };
const dateInp: React.CSSProperties = { padding: "3px 5px", border: "1px solid #cdd5de", borderRadius: 5, fontSize: 12 };
const sel: React.CSSProperties = { padding: "4px 6px", border: "1px solid #cdd5de", borderRadius: 5, fontSize: 12.5, width: 90 };
const chip: React.CSSProperties = { padding: "4px 8px", border: "1px solid #cdd5de", borderRadius: 5, background: "#fff", cursor: "pointer", fontSize: 11.5 };
