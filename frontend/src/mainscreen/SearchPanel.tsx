import { useState } from "react";
import { type StudyFilters } from "../api";
import { useI18n } from "../i18n/i18n";

export function SearchPanel({ onSearch }: { onSearch: (f: StudyFilters) => void }) {
  const { t } = useI18n();
  const [f, setF] = useState<StudyFilters>({});

  const set = (k: keyof StudyFilters, v: string) => setF((prev) => ({ ...prev, [k]: v }));
  const submit = () => onSearch(f);
  const clear = () => {
    setF({});
    onSearch({});
  };

  return (
    <div style={panel}>
      <h3 style={{ fontSize: 14, margin: "0 0 10px" }}>{t("main.search.title")}</h3>
      <div onKeyDown={(e) => e.key === "Enter" && submit()}>
        <Field label={t("field.patientId")}>
          <input value={f.patientId ?? ""} onChange={(e) => set("patientId", e.target.value)} style={input} />
        </Field>
        <Field label={t("field.patientName")}>
          <input value={f.patientName ?? ""} onChange={(e) => set("patientName", e.target.value)} style={input} />
        </Field>
        <Field label={t("main.search.studyDate")}>
          <input
            value={f.studyDate ?? ""}
            onChange={(e) => set("studyDate", e.target.value)}
            placeholder="YYYYMMDD"
            style={input}
          />
        </Field>
        <Field label={t("field.modality")}>
          <input value={f.modality ?? ""} onChange={(e) => set("modality", e.target.value)} placeholder="CT, MR…" style={input} />
        </Field>
        <Field label={t("main.search.accession")}>
          <input value={f.accessionNumber ?? ""} onChange={(e) => set("accessionNumber", e.target.value)} style={input} />
        </Field>
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <button onClick={submit} style={{ ...btn, background: "#0b5cad", color: "#fff", flex: 1 }}>
          {t("common.search")}
        </button>
        <button onClick={clear} style={btn}>
          {t("main.search.clear")}
        </button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "block", marginBottom: 8 }}>
      <div style={{ fontSize: 12, color: "#6b7785", marginBottom: 2 }}>{label}</div>
      {children}
    </label>
  );
}

const panel: React.CSSProperties = {
  width: 230,
  flex: "none",
  borderRight: "1px solid #e6eaee",
  padding: 14,
  overflowY: "auto",
  background: "#fafbfc",
};
const input: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "6px 8px",
  border: "1px solid #cdd5de",
  borderRadius: 6,
  fontSize: 13,
};
const btn: React.CSSProperties = {
  padding: "7px 12px",
  border: "1px solid #cdd5de",
  borderRadius: 6,
  background: "#fff",
  cursor: "pointer",
  fontSize: 13,
};
