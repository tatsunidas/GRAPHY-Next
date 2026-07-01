/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// W/L プリセット編集ダイアログ（GRAPHY WwWlPresets 相当）。
// 一覧＋[新規][編集][削除][既定に戻す][閉じる]。各操作で backend 設定へ即永続化し、
// 変更通知で全ウィンドウのメニュー/ツールバーへ反映する。
import { useEffect, useState } from "react";
import { useI18n } from "../i18n/i18n";
import { DEFAULT_PRESETS, presetLabel, type WlPreset } from "./wlPresets";
import { loadWlPresets, resetWlPresets, saveWlPresets } from "./wlPresetStore";

interface EditRow {
  key: string;
  name: string;
  center: number;
  width: number;
}

interface FormState {
  mode: "new" | "edit";
  index: number; // edit 対象（new は -1）
  name: string;
  wl: string;
  ww: string;
}

let keySeq = 0;
function newKey(): string {
  keySeq += 1;
  return `custom-${Date.now()}-${keySeq}`;
}

/** WlPreset[] → 編集行（組み込み既定は表示名を実名化して編集可能に）。 */
function toRows(presets: WlPreset[], t: (k: string) => string): EditRow[] {
  return presets.map((p) => ({ key: p.key, name: presetLabel(p, t), center: p.center, width: p.width }));
}

export function WlPresetDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const [rows, setRows] = useState<EditRow[]>([]);
  const [selected, setSelected] = useState<number>(-1);
  const [form, setForm] = useState<FormState | null>(null);

  useEffect(() => {
    if (!open) return;
    setForm(null);
    setSelected(-1);
    loadWlPresets()
      .then((p) => setRows(toRows(p, t)))
      .catch(() => setRows(toRows(DEFAULT_PRESETS, t)));
  }, [open, t]);

  if (!open) return null;

  const persist = (next: EditRow[]) => {
    setRows(next);
    void saveWlPresets(next.map((r) => ({ key: r.key, name: r.name, center: r.center, width: r.width })));
  };

  const onNew = () => setForm({ mode: "new", index: -1, name: "", wl: "", ww: "" });
  const onEdit = () => {
    if (selected < 0) return;
    const r = rows[selected];
    setForm({ mode: "edit", index: selected, name: r.name, wl: String(r.center), ww: String(r.width) });
  };
  const onDelete = () => {
    if (selected < 0) return;
    if (!window.confirm(t("wlPreset.confirmDelete"))) return;
    const next = rows.filter((_, i) => i !== selected);
    setSelected(-1);
    persist(next);
  };
  const onReset = () => {
    if (!window.confirm(t("wlPreset.confirmReset"))) return;
    void resetWlPresets();
    setRows(toRows(DEFAULT_PRESETS, t));
    setSelected(-1);
    setForm(null);
  };

  const onFormSave = () => {
    if (!form) return;
    const name = form.name.trim();
    if (!name) {
      window.alert(t("wlPreset.nameRequired"));
      return;
    }
    const center = Number(form.wl);
    const width = Number(form.ww);
    if (!Number.isFinite(center) || !Number.isFinite(width) || width < 1) {
      window.alert(t("wlPreset.invalidNum"));
      return;
    }
    if (form.mode === "new") {
      persist([...rows, { key: newKey(), name, center, width }]);
      setSelected(rows.length);
    } else {
      const next = rows.slice();
      next[form.index] = { ...next[form.index], name, center, width };
      persist(next);
    }
    setForm(null);
  };

  return (
    <div style={backdrop} onClick={onClose}>
      <div style={card} onClick={(e) => e.stopPropagation()}>
        <div style={titleBar}>{t("wlPreset.title")}</div>

        <div style={listBox}>
          {rows.length === 0 && <div style={emptyRow}>{t("wlPreset.empty")}</div>}
          {rows.map((r, i) => (
            <button
              key={r.key}
              onClick={() => setSelected(i)}
              onDoubleClick={() => { setSelected(i); setForm({ mode: "edit", index: i, name: r.name, wl: String(r.center), ww: String(r.width) }); }}
              style={{ ...listItem, ...(i === selected ? listItemSel : null) }}
            >
              <span>{r.name}</span>
              <span style={valSpan}>WL {fmt(r.center)} / WW {fmt(r.width)}</span>
            </button>
          ))}
        </div>

        {form && (
          <div style={formBox}>
            <div style={formTitle}>{form.mode === "new" ? t("wlPreset.newTitle") : t("wlPreset.editTitle")}</div>
            <label style={fieldRow}>
              <span style={fieldLabel}>{t("wlPreset.name")}</span>
              <input style={input} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus />
            </label>
            <label style={fieldRow}>
              <span style={fieldLabel}>{t("wlPreset.wl")}</span>
              <input style={input} value={form.wl} inputMode="numeric" onChange={(e) => setForm({ ...form, wl: e.target.value })} />
            </label>
            <label style={fieldRow}>
              <span style={fieldLabel}>{t("wlPreset.ww")}</span>
              <input style={input} value={form.ww} inputMode="numeric" onChange={(e) => setForm({ ...form, ww: e.target.value })} />
            </label>
            <div style={formBtns}>
              <button style={primaryBtn} onClick={onFormSave}>{t("common.save")}</button>
              <button style={btn} onClick={() => setForm(null)}>{t("common.cancel")}</button>
            </div>
          </div>
        )}

        <div style={btnRow}>
          <button style={btn} onClick={onNew}>{t("wlPreset.new")}</button>
          <button style={btn} disabled={selected < 0} onClick={onEdit}>{t("wlPreset.edit")}</button>
          <button style={btn} disabled={selected < 0} onClick={onDelete}>{t("wlPreset.delete")}</button>
          <button style={btn} onClick={onReset}>{t("wlPreset.reset")}</button>
          <button style={{ ...primaryBtn, marginLeft: "auto" }} onClick={onClose}>{t("common.close")}</button>
        </div>
      </div>
    </div>
  );
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

const backdrop: React.CSSProperties = {
  position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)",
  display: "flex", alignItems: "center", justifyContent: "center", zIndex: 3000,
};
const card: React.CSSProperties = {
  width: 460, maxWidth: "92vw", background: "#fff", borderRadius: 10,
  boxShadow: "0 10px 40px rgba(0,0,0,0.3)", padding: 16, fontSize: 13, color: "#222",
};
const titleBar: React.CSSProperties = { fontSize: 15, fontWeight: 600, marginBottom: 12 };
const listBox: React.CSSProperties = {
  border: "1px solid #dfe3e8", borderRadius: 8, maxHeight: 240, overflowY: "auto", padding: 4,
};
const emptyRow: React.CSSProperties = { padding: "12px 8px", color: "#8a97a4", textAlign: "center" };
const listItem: React.CSSProperties = {
  display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10,
  width: "100%", textAlign: "left", border: "none", background: "transparent",
  padding: "8px 10px", borderRadius: 6, cursor: "pointer", fontSize: 13,
};
const listItemSel: React.CSSProperties = { background: "#e6effa" };
const valSpan: React.CSSProperties = { color: "#6b7785", fontSize: 12, whiteSpace: "nowrap" };
const formBox: React.CSSProperties = {
  marginTop: 12, padding: 12, border: "1px solid #dfe3e8", borderRadius: 8, background: "#f8fafc",
};
const formTitle: React.CSSProperties = { fontWeight: 600, marginBottom: 8 };
const fieldRow: React.CSSProperties = { display: "flex", alignItems: "center", gap: 10, marginBottom: 8 };
const fieldLabel: React.CSSProperties = { width: 170, color: "#33404d" };
const input: React.CSSProperties = {
  flex: 1, padding: "5px 8px", border: "1px solid #cdd5de", borderRadius: 6, fontSize: 13,
};
const formBtns: React.CSSProperties = { display: "flex", gap: 8, marginTop: 4 };
const btnRow: React.CSSProperties = { display: "flex", gap: 8, marginTop: 14, alignItems: "center" };
const btn: React.CSSProperties = {
  padding: "6px 14px", border: "1px solid #cdd5de", borderRadius: 6, background: "#fff", cursor: "pointer", fontSize: 13,
};
const primaryBtn: React.CSSProperties = {
  padding: "6px 16px", border: "1px solid #0b5cad", borderRadius: 6, background: "#0b5cad", color: "#fff", cursor: "pointer", fontSize: 13,
};
