/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * MPR の 3D ROI の計測ダイアログ。一覧（形・容積）と、選んだ 1 件の展開行（中心・3 径の編集・式・警告）。
 * 2D の ROI 計測ダイアログ（`viewer2d/RoiStatsDialog.tsx`）とは別物で、そちらは変更しない。
 */
import { useI18n } from "../i18n/i18n";
import {
  AXIS_NAMES,
  formatMl,
  formulaText,
  outOfBounds,
  volumeMl,
  withCenter,
  withSize,
  type Axis3,
  type Bounds6,
  type Roi3dBox,
} from "../viewer/roi3dBox";

interface Props {
  boxes: Roi3dBox[];
  selectedId: string | null;
  bounds: Bounds6 | null;
  onSelect: (id: string | null) => void;
  onChange: (b: Roi3dBox) => void;
  onRemove: (id: string) => void;
  onClose: () => void;
}

const AXES: Axis3[] = [0, 1, 2];

export function MprRoiDialog({ boxes, selectedId, bounds, onSelect, onChange, onRemove, onClose }: Props) {
  const { t } = useI18n();
  return (
    <div style={backdrop} onClick={onClose}>
      <div style={dialog} onClick={(e) => e.stopPropagation()} data-testid="mpr-roi3d-dialog">
        <div style={head}>
          <strong style={{ fontSize: 13 }}>{t("mpr.roi3d.title")}</strong>
          <span style={{ flex: 1 }} />
          <button onClick={onClose} style={btn} title={t("common.close")}>×</button>
        </div>
        {boxes.length === 0 ? (
          <div style={{ padding: 16, color: "#5a6672" }}>{t("mpr.roi3d.empty")}</div>
        ) : (
          <div style={{ overflow: "auto" }}>
            <table style={table}>
              <thead>
                <tr>
                  <th style={th}>#</th>
                  <th style={th}>{t("mpr.roi3d.shape")}</th>
                  <th style={thNum}>{t("mpr.roi3d.volume")}</th>
                </tr>
              </thead>
              <tbody>
                {boxes.map((b, i) => {
                  const open = b.id === selectedId;
                  return (
                    <RowGroup key={b.id}>
                      <tr onClick={() => onSelect(open ? null : b.id)} style={{ ...tr, ...(open ? trOpen : null) }} data-testid="mpr-roi3d-row">
                        <td style={td}>{open ? "▾" : "▸"} {i + 1}</td>
                        <td style={td}>{t(`mpr.roi3d.${b.shape}`)}</td>
                        <td style={tdNum} data-testid="mpr-roi3d-volume">{formatMl(volumeMl(b))} mL</td>
                      </tr>
                      {open && (
                        <tr>
                          <td colSpan={3} style={detail} data-testid="mpr-roi3d-detail">
                            <div style={grid}>
                              <span style={dim}>{t("mpr.roi3d.center")}</span>
                              {AXES.map((a) => (
                                <NumField key={`c${a}`} label={AXIS_NAMES[a]} value={b.center[a]} testId={`mpr-roi3d-center-${AXIS_NAMES[a]}`}
                                  onCommit={(v) => onChange(withCenter(b, a, v))} />
                              ))}
                              <span style={dim}>{t("mpr.roi3d.lengths")}</span>
                              {AXES.map((a) => (
                                <NumField key={`s${a}`} label={AXIS_NAMES[a]} value={b.size[a]} testId={`mpr-roi3d-size-${AXIS_NAMES[a]}`}
                                  onCommit={(v) => onChange(withSize(b, a, v))} />
                              ))}
                            </div>
                            <div style={{ marginTop: 6 }}>
                              <span style={dim}>{t("mpr.roi3d.formula")}: </span>
                              <span data-testid="mpr-roi3d-formula">{formulaText(b)}</span>
                            </div>
                            {bounds && outOfBounds(b, bounds) && (
                              <div style={warn} data-testid="mpr-roi3d-warn">{t("mpr.roi3d.outOfVolume")}</div>
                            )}
                            <div style={{ marginTop: 6 }}>
                              <button style={btn} onClick={() => onRemove(b.id)}>{t("mpr.roi3d.delete")}</button>
                            </div>
                          </td>
                        </tr>
                      )}
                    </RowGroup>
                  );
                })}
              </tbody>
            </table>
            <div style={{ ...dim, padding: "6px 12px" }}>{t("mpr.roi3d.note")}</div>
          </div>
        )}
      </div>
    </div>
  );
}

function RowGroup({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

/** 確定（Enter／フォーカス移動）で反映する数値欄。値が外から変わったら作り直す（key）。 */
function NumField({ label, value, testId, onCommit }: { label: string; value: number; testId: string; onCommit: (v: number) => void }) {
  return (
    <label style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
      <span style={dim}>{label}</span>
      <input
        key={value}
        type="number"
        step={0.1}
        defaultValue={Number(value.toFixed(2))}
        style={input}
        data-testid={testId}
        onBlur={(e) => {
          const v = Number(e.target.value);
          if (e.target.value !== "" && Number.isFinite(v)) onCommit(v);
          else e.target.value = String(Number(value.toFixed(2)));
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
      />
    </label>
  );
}

const backdrop: React.CSSProperties = { position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 };
const dialog: React.CSSProperties = { width: 640, maxWidth: "92vw", maxHeight: "80vh", display: "flex", flexDirection: "column", background: "#14181c", color: "#e6eaee", border: "1px solid #2c343b", borderRadius: 8, fontSize: 12 };
const head: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6, padding: "8px 12px", borderBottom: "1px solid #23292f" };
const btn: React.CSSProperties = { background: "#1b2126", color: "#e6eaee", border: "1px solid #2c343b", borderRadius: 5, fontSize: 12, padding: "2px 8px", cursor: "pointer" };
const table: React.CSSProperties = { width: "100%", borderCollapse: "collapse" };
const th: React.CSSProperties = { textAlign: "left", padding: "4px 12px", color: "#9aa6b2", fontWeight: 600, borderBottom: "1px solid #23292f" };
const thNum: React.CSSProperties = { ...th, textAlign: "right" };
const tr: React.CSSProperties = { cursor: "pointer" };
const trOpen: React.CSSProperties = { background: "#1b2530" };
const td: React.CSSProperties = { padding: "4px 12px" };
const tdNum: React.CSSProperties = { ...td, textAlign: "right", fontFamily: "ui-monospace, monospace" };
const detail: React.CSSProperties = { padding: "8px 12px", background: "#10151a", borderBottom: "1px solid #23292f" };
const grid: React.CSSProperties = { display: "grid", gridTemplateColumns: "110px repeat(3, auto)", gap: "4px 10px", alignItems: "center", justifyContent: "start" };
const dim: React.CSSProperties = { color: "#7f8b96" };
const warn: React.CSSProperties = { marginTop: 6, color: "#ffb454" };
const input: React.CSSProperties = { width: 72, background: "#1b2126", color: "#e6eaee", border: "1px solid #2c343b", borderRadius: 4, fontSize: 12, padding: "1px 4px" };
