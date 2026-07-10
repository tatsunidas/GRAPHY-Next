/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { type ParticipationType, type ReportParticipantInput, type StaffRole } from "../api";
import { useI18n } from "../i18n/i18n";

const STAFF_ROLES: StaffRole[] = [
  "PHYSICIAN",
  "RADIOLOGIC_TECHNOLOGIST",
  "MEDICAL_ASSISTANT",
  "CLERICAL_WORKER",
  "SCIENTIST",
];
const PARTICIPATION_TYPES: ParticipationType[] = ["AUTHOR", "VERIFIER", "ENTERER", "REVIEWER"];

/**
 * レポート参加者（{@link StaffRole} × {@link ParticipationType} のペア）の編集テーブル。
 * 認証は無いため氏名は自由入力（`fw/report-design.md` §5/§7）。
 */
export function ParticipantsPanel({
  participants,
  onChange,
  readOnly,
}: {
  participants: ReportParticipantInput[];
  onChange: (next: ReportParticipantInput[]) => void;
  readOnly?: boolean;
}) {
  const { t } = useI18n();

  const update = (i: number, patch: Partial<ReportParticipantInput>) => {
    const next = participants.slice();
    next[i] = { ...next[i], ...patch };
    onChange(next);
  };
  const remove = (i: number) => onChange(participants.filter((_, idx) => idx !== i));
  const add = () =>
    onChange([...participants, { name: "", staffRole: "PHYSICIAN", participationType: "AUTHOR", organization: "" }]);

  return (
    <div>
      <div style={sectionHeader}>
        <span style={{ fontWeight: 700 }}>{t("report.participants.title")}</span>
        {!readOnly && (
          <button type="button" style={smallBtn} onClick={add}>
            {t("report.participants.add")}
          </button>
        )}
      </div>
      {participants.length === 0 && <div style={emptyMsg}>{t("report.participants.empty")}</div>}
      {participants.map((p, i) => (
        <div key={i} style={row}>
          <input
            style={inputSm}
            placeholder={t("report.participants.name")}
            value={p.name}
            disabled={readOnly}
            onChange={(e) => update(i, { name: e.target.value })}
          />
          <select
            style={selectSm}
            value={p.staffRole}
            disabled={readOnly}
            onChange={(e) => update(i, { staffRole: e.target.value as StaffRole })}
          >
            {STAFF_ROLES.map((r) => (
              <option key={r} value={r}>
                {t(`report.role.${r}`)}
              </option>
            ))}
          </select>
          <select
            style={selectSm}
            value={p.participationType}
            disabled={readOnly}
            onChange={(e) => update(i, { participationType: e.target.value as ParticipationType })}
          >
            {PARTICIPATION_TYPES.map((pt) => (
              <option key={pt} value={pt}>
                {t(`report.participationType.${pt}`)}
              </option>
            ))}
          </select>
          <input
            style={inputSm}
            placeholder={t("report.participants.organization")}
            value={p.organization ?? ""}
            disabled={readOnly}
            onChange={(e) => update(i, { organization: e.target.value })}
          />
          {!readOnly && (
            <button type="button" style={removeBtn} onClick={() => remove(i)}>
              {t("report.participants.remove")}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

const sectionHeader: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  marginBottom: 6,
};
const emptyMsg: React.CSSProperties = { color: "#888", fontSize: 12, padding: "4px 0" };
const row: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6, padding: "3px 0" };
const inputSm: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  padding: "4px 8px",
  border: "1px solid #d7dde3",
  borderRadius: 5,
  fontSize: 12,
};
const selectSm: React.CSSProperties = {
  padding: "4px 6px",
  border: "1px solid #d7dde3",
  borderRadius: 5,
  fontSize: 12,
  background: "#fff",
};
const smallBtn: React.CSSProperties = {
  padding: "3px 10px",
  border: "1px solid #cdd5de",
  borderRadius: 6,
  background: "#fff",
  cursor: "pointer",
  fontSize: 12,
};
const removeBtn: React.CSSProperties = {
  padding: "3px 8px",
  border: "1px solid #e0b4b4",
  color: "#a02525",
  borderRadius: 5,
  background: "#fff",
  cursor: "pointer",
  fontSize: 11,
};
