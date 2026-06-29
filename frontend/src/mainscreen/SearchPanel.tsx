/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { type StudyFilters } from "../api";
import { useI18n } from "../i18n/i18n";

/** チェックボックスグリッドに出すモダリティ候補（放射線でよく使うもの）。 */
const MODALITY_OPTIONS = [
  "CT", "MR", "CR", "DX", "DR", "US", "XA", "RF",
  "MG", "NM", "PT", "OT", "SC", "ES", "SM", "PR",
];

/** Date → "YYYYMMDD"（ローカル日付）。 */
function ymd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}
function addDays(base: Date, days: number): Date {
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate());
  d.setDate(d.getDate() + days);
  return d;
}
/** "YYYYMMDD" ⇄ <input type=date> の "YYYY-MM-DD"。 */
const toInputDate = (v: string) => (v.length === 8 ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}` : "");
const fromInputDate = (v: string) => v.replace(/-/g, "");

export function SearchPanel({ onSearch }: { onSearch: (f: StudyFilters) => void }) {
  const { t } = useI18n();
  const todayStr = useMemo(() => ymd(new Date()), []);

  // 初期検索条件は「今日のみ」。
  const [patientId, setPatientId] = useState("");
  const [patientName, setPatientName] = useState("");
  const [dateFrom, setDateFrom] = useState(todayStr);
  const [dateTo, setDateTo] = useState(todayStr);
  const [modalities, setModalities] = useState<string[]>([]);
  const [accession, setAccession] = useState("");
  const [showModalityGrid, setShowModalityGrid] = useState(false);

  const filters: StudyFilters = useMemo(() => {
    const f: StudyFilters = {};
    if (patientId.trim()) f.patientId = patientId.trim();
    if (patientName.trim()) f.patientName = patientName.trim();
    if (dateFrom) f.studyDateFrom = dateFrom;
    if (dateTo) f.studyDateTo = dateTo;
    if (modalities.length) f.modality = modalities.join(",");
    if (accession.trim()) f.accessionNumber = accession.trim();
    return f;
  }, [patientId, patientName, dateFrom, dateTo, modalities, accession]);

  const isEmpty = Object.keys(filters).length === 0;
  const filterKey = JSON.stringify(filters);

  // 入力を随時検知してリストを更新（デバウンス）。ただし無条件のときは自動検索しない
  //（無条件検索は明示の「検索」ボタンで確認を取ってから）。
  const onSearchRef = useRef(onSearch);
  onSearchRef.current = onSearch;
  useEffect(() => {
    if (isEmpty) return;
    const id = setTimeout(() => onSearchRef.current(filters), 250);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey]);

  // 明示の「検索」: 無条件なら警告して許可を取る。
  const runSearch = () => {
    if (isEmpty) {
      if (!window.confirm(t("main.search.noConditionWarn"))) return;
    }
    onSearchRef.current(filters);
  };

  const setRange = (from: string, to: string) => {
    setDateFrom(from);
    setDateTo(to);
    // 期間ボタン押下時は即検索（filters の変化でデバウンス検索も走るが、即時実行で体感を上げる）。
    const f: StudyFilters = { ...filters, studyDateFrom: from, studyDateTo: to };
    onSearchRef.current(f);
  };
  const pickToday = () => setRange(todayStr, todayStr);
  const pickYesterday = () => {
    const y = ymd(addDays(new Date(), -1));
    setRange(y, y);
  };
  const pickWeek = () => setRange(ymd(addDays(new Date(), -6)), todayStr);

  const toggleModality = (m: string) =>
    setModalities((prev) => (prev.includes(m) ? prev.filter((x) => x !== m) : [...prev, m]));

  const clear = () => {
    setPatientId("");
    setPatientName("");
    setDateFrom("");
    setDateTo("");
    setModalities([]);
    setAccession("");
  };

  return (
    <div style={panel}>
      <h3 style={{ fontSize: 14, margin: "0 0 10px" }}>{t("main.search.title")}</h3>

      <Field label={t("field.patientId")}>
        <input
          value={patientId}
          onChange={(e) => setPatientId(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && runSearch()}
          placeholder={t("main.search.partialHint")}
          style={input}
        />
      </Field>
      <Field label={t("field.patientName")}>
        <input
          value={patientName}
          onChange={(e) => setPatientName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && runSearch()}
          placeholder={t("main.search.partialHint")}
          style={input}
        />
      </Field>

      <Field label={t("main.search.studyDate")}>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input
            type="date"
            value={toInputDate(dateFrom)}
            onChange={(e) => setDateFrom(fromInputDate(e.target.value))}
            style={{ ...input, padding: "5px 6px" }}
          />
          <span style={{ color: "#9aa6b2" }}>〜</span>
          <input
            type="date"
            value={toInputDate(dateTo)}
            onChange={(e) => setDateTo(fromInputDate(e.target.value))}
            style={{ ...input, padding: "5px 6px" }}
          />
        </div>
        <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
          <button onClick={pickToday} style={chip}>{t("main.search.today")}</button>
          <button onClick={pickYesterday} style={chip}>{t("main.search.yesterday")}</button>
          <button onClick={pickWeek} style={chip}>{t("main.search.week")}</button>
        </div>
      </Field>

      <Field label={t("field.modality")}>
        <div style={{ display: "flex", gap: 6 }}>
          <input value={modalities.join(",")} readOnly placeholder="—" style={{ ...input, background: "#f1f4f7" }} />
          <button onClick={() => setShowModalityGrid((v) => !v)} style={{ ...btn, whiteSpace: "nowrap" }}>
            {t("main.search.modalitySelect")}
          </button>
        </div>
        {showModalityGrid && (
          <div style={grid}>
            {MODALITY_OPTIONS.map((m) => (
              <label key={m} style={gridCell}>
                <input type="checkbox" checked={modalities.includes(m)} onChange={() => toggleModality(m)} />
                {m}
              </label>
            ))}
          </div>
        )}
      </Field>

      <Field label={t("main.search.accession")}>
        <input
          value={accession}
          onChange={(e) => setAccession(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && runSearch()}
          style={input}
        />
      </Field>

      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <button onClick={runSearch} style={{ ...btn, background: "#0b5cad", color: "#fff", flex: 1 }}>
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
    <label style={{ display: "block", marginBottom: 10 }}>
      <div style={{ fontSize: 12, color: "#6b7785", marginBottom: 2 }}>{label}</div>
      {children}
    </label>
  );
}

const panel: React.CSSProperties = {
  width: 250,
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
const chip: React.CSSProperties = {
  flex: 1,
  padding: "5px 6px",
  border: "1px solid #cdd5de",
  borderRadius: 6,
  background: "#fff",
  cursor: "pointer",
  fontSize: 12,
};
const grid: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(4, 1fr)",
  gap: 4,
  marginTop: 6,
  padding: 8,
  border: "1px solid #d6dde4",
  borderRadius: 6,
  background: "#fff",
};
const gridCell: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 3,
  fontSize: 12,
  cursor: "pointer",
};
