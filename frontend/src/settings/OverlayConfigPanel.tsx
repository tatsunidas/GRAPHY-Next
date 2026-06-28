import { useState } from "react";
import { fetchTagInfo } from "../api";
import {
  loadOverlayConfig,
  saveOverlayConfig,
  resetOverlayConfig,
  DEFAULT_OVERLAY_CONFIG,
  MAX_FIELDS_PER_CORNER,
  MAX_VALUE_CHARS,
  type OverlayConfig,
  type OverlayCorner,
} from "../viewer/overlayConfig";
import { useI18n } from "../i18n/i18n";

const CORNERS: { id: OverlayCorner; labelKey: string }[] = [
  { id: "topLeft", labelKey: "overlay.corner.tl" },
  { id: "topRight", labelKey: "overlay.corner.tr" },
  { id: "bottomLeft", labelKey: "overlay.corner.bl" },
  { id: "bottomRight", labelKey: "overlay.corner.br" },
];
const ALL: OverlayCorner[] = ["topLeft", "topRight", "bottomLeft", "bottomRight"];

/** "0010,0010" → "00100010"、"age" → "AGE"。最大8桁hex。 */
function normalizeTag(input: string): string {
  const up = input.trim().toUpperCase();
  if (up === "AGE") return "AGE";
  return up.replace(/[^0-9A-F]/g, "").slice(0, 8);
}

function cleaned(config: OverlayConfig): OverlayConfig {
  const out = { topLeft: [], topRight: [], bottomLeft: [], bottomRight: [] } as OverlayConfig;
  for (const c of ALL) {
    out[c] = config[c].filter((f) => f.tag.trim());
  }
  return out;
}

/** 環境設定の「画像オーバーレイ」カスタムパネル。4 隅×最大5項目をタグ番号で設定。 */
export function OverlayConfigPanel() {
  const { t } = useI18n();
  const [config, setConfig] = useState<OverlayConfig>(() => loadOverlayConfig());

  const apply = (next: OverlayConfig) => {
    setConfig(next);
    saveOverlayConfig(cleaned(next));
  };

  const updateField = (corner: OverlayCorner, idx: number, rawTag: string) => {
    const tag = normalizeTag(rawTag);
    const arr = [...config[corner]];
    while (arr.length <= idx) arr.push({ tag: "" });
    arr[idx] = { tag, keyword: tag === "AGE" ? "Age" : "", vr: "" };
    apply({ ...config, [corner]: arr });

    if (tag.length === 8) {
      fetchTagInfo(tag)
        .then((info) => {
          setConfig((prev) => {
            const a = [...prev[corner]];
            if (a[idx]?.tag !== tag) return prev;
            a[idx] = { tag, keyword: info.keyword, vr: info.vr };
            const next = { ...prev, [corner]: a };
            saveOverlayConfig(cleaned(next));
            return next;
          });
        })
        .catch(() => {
          /* 名前解決失敗は無視（タグ番号だけで表示は可能） */
        });
    }
  };

  const reset = () => {
    resetOverlayConfig();
    setConfig(JSON.parse(JSON.stringify(DEFAULT_OVERLAY_CONFIG)));
  };

  return (
    <div>
      <p style={{ fontSize: 13, color: "#6b7785", marginTop: 0 }}>
        {t("overlay.help", { max: MAX_VALUE_CHARS })}
      </p>
      <div style={grid}>
        {CORNERS.map(({ id, labelKey }) => (
          <div key={id} style={cornerBox}>
            <div style={cornerTitle}>{t(labelKey)}</div>
            {Array.from({ length: MAX_FIELDS_PER_CORNER }).map((_, i) => {
              const f = config[id][i];
              return (
                <div key={i} style={fieldRow}>
                  <input
                    value={f?.tag ?? ""}
                    onChange={(e) => updateField(id, i, e.target.value)}
                    placeholder="00100010 / AGE"
                    spellCheck={false}
                    style={tagInput}
                  />
                  <span style={keyword} title={f?.vr ? `VR: ${f.vr}` : undefined}>
                    {f?.keyword || ""}
                  </span>
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <button onClick={reset} style={resetBtn}>
        {t("overlay.reset")}
      </button>
    </div>
  );
}

const grid: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: 14,
};
const cornerBox: React.CSSProperties = {
  border: "1px solid #e1e7ee",
  borderRadius: 6,
  padding: "8px 10px",
  background: "#fafbfc",
};
const cornerTitle: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: "#33404d", marginBottom: 6 };
const fieldRow: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, marginBottom: 4 };
const tagInput: React.CSSProperties = {
  width: 110,
  flex: "none",
  padding: "4px 6px",
  border: "1px solid #cdd5de",
  borderRadius: 5,
  fontSize: 12,
  fontFamily: "monospace",
};
const keyword: React.CSSProperties = { fontSize: 12, color: "#5a6672", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const resetBtn: React.CSSProperties = {
  marginTop: 14,
  padding: "6px 14px",
  border: "1px solid #cdd5de",
  borderRadius: 6,
  background: "#fff",
  cursor: "pointer",
  fontSize: 13,
};
