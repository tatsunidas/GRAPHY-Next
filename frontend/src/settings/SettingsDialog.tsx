import { useEffect, useState } from "react";
import { SETTINGS_REGISTRY, type CategoryDef, type FieldDef } from "./registry";
import { fetchSettings, saveSettings, type SettingsMap } from "./settingsApi";
import { useI18n, type Locale, type TFn } from "../i18n/i18n";

export function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t, locale, setLocale } = useI18n();
  const [map, setMap] = useState<SettingsMap>({});
  const [selectedId, setSelectedId] = useState<string>(SETTINGS_REGISTRY[0]?.id ?? "");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    fetchSettings()
      .then(setMap)
      .catch((e: unknown) => setError(String(e)));
  }, [open]);

  if (!open) return null;

  const category = SETTINGS_REGISTRY.find((c) => c.id === selectedId) ?? SETTINGS_REGISTRY[0];

  const update = (field: FieldDef, value: string) => {
    // 言語は i18n コンテキスト直結（即時切替）
    if (field.key === "general.language") {
      setLocale(value as Locale);
      return;
    }
    setMap((prev) => ({ ...prev, [field.key]: value }));
    saveSettings({ [field.key]: value }).catch((e: unknown) => setError(String(e)));
  };

  const valueOf = (field: FieldDef): string =>
    field.key === "general.language" ? locale : (map[field.key] ?? String(field.default));

  return (
    <div style={overlay} onClick={onClose}>
      <div style={dialog} onClick={(e) => e.stopPropagation()}>
        <div style={header}>
          <span style={{ fontWeight: 700 }}>{t("settings.title")}</span>
          <button style={closeBtn} onClick={onClose} aria-label={t("common.close")}>
            ✕
          </button>
        </div>

        {error && <div style={{ color: "#b00020", padding: "6px 16px" }}>{t("settings.saveError", { error })}</div>}

        <div style={body}>
          <nav style={sidebar}>
            {SETTINGS_REGISTRY.map((c: CategoryDef) => (
              <button
                key={c.id}
                onClick={() => setSelectedId(c.id)}
                style={{
                  ...navItem,
                  background: c.id === selectedId ? "#e6effa" : "transparent",
                  color: c.id === selectedId ? "#0b5cad" : "#222",
                  fontWeight: c.id === selectedId ? 600 : 400,
                }}
              >
                <span style={{ width: 20, display: "inline-block" }}>{c.icon ?? "•"}</span>
                {t(c.labelKey)}
              </button>
            ))}
          </nav>

          <div style={panel}>
            <h2 style={{ fontSize: 18, margin: "0 0 12px" }}>{t(category.labelKey)}</h2>
            {category.sections.map((section) => (
              <section key={section.titleKey} style={{ marginBottom: 22 }}>
                <h3 style={sectionTitle}>{t(section.titleKey)}</h3>
                {section.fields.map((field) => (
                  <Field key={field.key} field={field} t={t} value={valueOf(field)} onChange={update} />
                ))}
              </section>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({
  field,
  t,
  value,
  onChange,
}: {
  field: FieldDef;
  t: TFn;
  value: string;
  onChange: (f: FieldDef, value: string) => void;
}) {
  return (
    <div style={fieldRow}>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 14 }}>{t(field.labelKey)}</div>
        {field.helpKey && <div style={{ fontSize: 12, color: "#6b7785", marginTop: 2 }}>{t(field.helpKey)}</div>}
      </div>
      <div style={{ flex: "none" }}>{renderControl(field, t, value, onChange)}</div>
    </div>
  );
}

function renderControl(field: FieldDef, t: TFn, raw: string, onChange: (f: FieldDef, v: string) => void) {
  switch (field.type) {
    case "toggle":
      return (
        <input
          type="checkbox"
          checked={raw === "true"}
          onChange={(e) => onChange(field, String(e.target.checked))}
          style={{ width: 18, height: 18 }}
        />
      );
    case "number":
      return (
        <input
          type="number"
          value={raw}
          min={field.min}
          max={field.max}
          onChange={(e) => onChange(field, e.target.value)}
          style={input}
        />
      );
    case "select":
      return (
        <select value={raw} onChange={(e) => onChange(field, e.target.value)} style={input}>
          {field.options?.map((o) => (
            <option key={o.value} value={o.value}>
              {t(o.labelKey)}
            </option>
          ))}
        </select>
      );
    case "text":
    default:
      return <input type="text" value={raw} onChange={(e) => onChange(field, e.target.value)} style={input} />;
  }
}

// --- styles ---
const overlay: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.35)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
};
const dialog: React.CSSProperties = {
  width: 740,
  maxWidth: "92vw",
  height: 500,
  maxHeight: "88vh",
  background: "#fff",
  borderRadius: 10,
  boxShadow: "0 12px 40px rgba(0,0,0,0.3)",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
  fontFamily: "system-ui, sans-serif",
  color: "#1a1a1a",
};
const header: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "12px 16px",
  borderBottom: "1px solid #eee",
};
const closeBtn: React.CSSProperties = {
  border: "none",
  background: "transparent",
  fontSize: 16,
  cursor: "pointer",
  color: "#666",
};
const body: React.CSSProperties = { display: "flex", flex: 1, minHeight: 0 };
const sidebar: React.CSSProperties = {
  width: 200,
  flex: "none",
  borderRight: "1px solid #eee",
  padding: 8,
  overflowY: "auto",
  background: "#fafbfc",
};
const navItem: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  width: "100%",
  textAlign: "left",
  border: "none",
  borderRadius: 6,
  padding: "8px 10px",
  fontSize: 14,
  cursor: "pointer",
};
const panel: React.CSSProperties = { flex: 1, padding: "16px 22px", overflowY: "auto" };
const sectionTitle: React.CSSProperties = {
  fontSize: 12,
  textTransform: "uppercase",
  letterSpacing: 0.5,
  color: "#8a98a6",
  margin: "0 0 6px",
};
const fieldRow: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 16,
  padding: "10px 0",
  borderBottom: "1px solid #f1f3f5",
};
const input: React.CSSProperties = {
  padding: "6px 8px",
  border: "1px solid #cdd5de",
  borderRadius: 6,
  fontSize: 14,
  minWidth: 160,
};
