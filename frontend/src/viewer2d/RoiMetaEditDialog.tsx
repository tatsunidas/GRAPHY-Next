/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * ROI/Mask 属性編集ダイアログ（M2）。
 *
 * ラベル・説明・ZCT scope（各次元を local(index) ↔ global("all") 切替）・カスタム属性を編集して
 * {@link ../viewer/roiMaskStore} に保存する。scope の "all" 化で global ROI/Mask を表現し、
 * local に戻す際は `origin`（作成時 scope）の index を既定値に復元する。
 * 設計: `fw/roi-manager-design.md`（M2=メタ＋scope 編集）。
 */
import { useMemo, useState } from "react";
import { getRoiMaskMeta, setRoiMaskMeta, type DimScope, type RoiScope } from "../viewer/roiMaskStore";
import { useI18n } from "../i18n/i18n";

type DimKey = "z" | "c" | "t";

/** scope の 1 次元編集行（all チェック + index 入力）。 */
function DimRow({
  label,
  value,
  fallback,
  onChange,
}: {
  label: string;
  value: DimScope | undefined;
  fallback: number;
  onChange: (v: DimScope) => void;
}) {
  const isAll = value === "all";
  const idx = typeof value === "number" ? value : fallback;
  return (
    <div style={dimRow}>
      <span style={dimLabel}>{label}</span>
      <label style={allLabel}>
        <input
          type="checkbox"
          checked={isAll}
          onChange={(e) => onChange(e.target.checked ? "all" : fallback)}
        />
        all
      </label>
      <input
        type="number"
        min={0}
        value={idx}
        disabled={isAll}
        onChange={(e) => onChange(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
        style={{ ...numInput, opacity: isAll ? 0.4 : 1 }}
      />
    </div>
  );
}

export function RoiMetaEditDialog({ itemId, onClose }: { itemId: string; onClose: () => void }) {
  const { t } = useI18n();
  const meta = useMemo(() => getRoiMaskMeta(itemId) ?? {}, [itemId]);
  const origin = meta.origin ?? meta.scope ?? {};

  const [label, setLabel] = useState(meta.label ?? "");
  const [description, setDescription] = useState(meta.description ?? "");
  const [scope, setScope] = useState<RoiScope>({ ...meta.scope });
  const [custom, setCustom] = useState<Array<[string, string]>>(
    Object.entries(meta.custom ?? {}),
  );

  const setDim = (dim: DimKey, v: DimScope) => setScope((s) => ({ ...s, [dim]: v }));
  const fallback = (dim: DimKey): number => {
    const o = origin[dim];
    return typeof o === "number" ? o : 0;
  };

  const setCustomKey = (i: number, k: string) =>
    setCustom((c) => c.map((row, j) => (j === i ? [k, row[1]] : row)));
  const setCustomVal = (i: number, v: string) =>
    setCustom((c) => c.map((row, j) => (j === i ? [row[0], v] : row)));
  const removeCustom = (i: number) => setCustom((c) => c.filter((_, j) => j !== i));
  const addCustom = () => setCustom((c) => [...c, ["", ""]]);

  const save = () => {
    const customObj: Record<string, string> = {};
    for (const [k, v] of custom) {
      const key = k.trim();
      if (key) customObj[key] = v;
    }
    setRoiMaskMeta(itemId, {
      label: label.trim() || undefined,
      description: description.trim() || undefined,
      scope,
      custom: customObj,
    });
    onClose();
  };

  return (
    <div style={backdrop} onClick={onClose}>
      <div style={dialog} onClick={(e) => e.stopPropagation()}>
        <div style={dlgHead}>
          <strong style={{ fontSize: 13 }}>{t("roiMgr.editTitle")}</strong>
          <span style={{ flex: 1 }} />
          <button onClick={onClose} style={hbtn} title={t("common.close")}>×</button>
        </div>

        <div style={field}>
          <label style={fieldLabel}>{t("roiMgr.label")}</label>
          <input type="text" value={label} onChange={(e) => setLabel(e.target.value)} style={textInput} />
        </div>
        <div style={field}>
          <label style={fieldLabel}>{t("roiMgr.description")}</label>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} style={textArea} rows={2} />
        </div>

        <div style={field}>
          <label style={fieldLabel}>{t("roiMgr.scope")}</label>
          <DimRow label={t("roiMgr.dimZ")} value={scope.z} fallback={fallback("z")} onChange={(v) => setDim("z", v)} />
          <DimRow label={t("roiMgr.dimC")} value={scope.c} fallback={fallback("c")} onChange={(v) => setDim("c", v)} />
          <DimRow label={t("roiMgr.dimT")} value={scope.t} fallback={fallback("t")} onChange={(v) => setDim("t", v)} />
        </div>

        <div style={field}>
          <div style={{ display: "flex", alignItems: "center" }}>
            <label style={fieldLabel}>{t("roiMgr.custom")}</label>
            <span style={{ flex: 1 }} />
            <button onClick={addCustom} style={hbtn} title={t("common.add")}>＋</button>
          </div>
          {custom.map((row, i) => (
            <div key={i} style={dimRow}>
              <input type="text" value={row[0]} placeholder={t("roiMgr.key")} onChange={(e) => setCustomKey(i, e.target.value)} style={kvInput} />
              <input type="text" value={row[1]} placeholder={t("roiMgr.value")} onChange={(e) => setCustomVal(i, e.target.value)} style={kvInput} />
              <button onClick={() => removeCustom(i)} style={delBtn} title={t("common.delete")}>🗑</button>
            </div>
          ))}
        </div>

        <div style={dlgFoot}>
          <button onClick={onClose} style={btn}>{t("common.cancel")}</button>
          <button onClick={save} style={{ ...btn, ...btnPrimary }}>{t("common.save")}</button>
        </div>
      </div>
    </div>
  );
}

const backdrop: React.CSSProperties = {
  position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", zIndex: 1000,
  display: "flex", alignItems: "center", justifyContent: "center",
};
const dialog: React.CSSProperties = {
  width: 340, maxHeight: "80vh", overflowY: "auto", background: "#fff",
  borderRadius: 8, boxShadow: "0 8px 32px rgba(0,0,0,0.25)", fontSize: 12,
  display: "flex", flexDirection: "column",
};
const dlgHead: React.CSSProperties = { display: "flex", alignItems: "center", gap: 4, padding: "8px 10px", borderBottom: "1px solid #e6eaee" };
const dlgFoot: React.CSSProperties = { display: "flex", justifyContent: "flex-end", gap: 8, padding: "8px 10px", borderTop: "1px solid #e6eaee" };
const field: React.CSSProperties = { padding: "8px 10px 0", display: "flex", flexDirection: "column", gap: 4 };
const fieldLabel: React.CSSProperties = { fontWeight: 600, color: "#5a6672" };
const textInput: React.CSSProperties = { border: "1px solid #cdd5de", borderRadius: 4, padding: "4px 6px", fontSize: 12 };
const textArea: React.CSSProperties = { border: "1px solid #cdd5de", borderRadius: 4, padding: "4px 6px", fontSize: 12, resize: "vertical", fontFamily: "inherit" };
const dimRow: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, padding: "2px 0" };
const dimLabel: React.CSSProperties = { width: 96, color: "#33404d" };
const allLabel: React.CSSProperties = { display: "flex", alignItems: "center", gap: 3, color: "#5a6672" };
const numInput: React.CSSProperties = { width: 60, border: "1px solid #cdd5de", borderRadius: 4, fontSize: 12, padding: "2px 4px" };
const kvInput: React.CSSProperties = { flex: 1, minWidth: 0, border: "1px solid #cdd5de", borderRadius: 4, fontSize: 12, padding: "2px 4px" };
const hbtn: React.CSSProperties = { border: "1px solid #cdd5de", borderRadius: 5, background: "#fff", cursor: "pointer", fontSize: 13, padding: "1px 7px" };
const delBtn: React.CSSProperties = { border: "1px solid #e3c2c2", borderRadius: 5, background: "#fff", cursor: "pointer", fontSize: 12, padding: "1px 6px" };
const btn: React.CSSProperties = { border: "1px solid #cdd5de", borderRadius: 5, background: "#fff", cursor: "pointer", fontSize: 12, padding: "4px 12px" };
const btnPrimary: React.CSSProperties = { background: "#2d7ff9", borderColor: "#2d7ff9", color: "#fff" };
