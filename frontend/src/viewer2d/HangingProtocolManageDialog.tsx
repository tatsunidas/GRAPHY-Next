/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 保存したハンギングプロトコルの管理（一覧・新規・編集・削除・書き出し・取り込み・自動適用の切替）。
 *
 * <p>操作の前に毎回設定を読み直す（別の窓や、web では別の利用者が同じ保存先を変えうる）。保存に失敗したら理由を出し、
 * 成功の表示にしない。`window.confirm` は使わない。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n/i18n";
import type { SettingsMap } from "../settings/settingsApi";
import { viewerOverlayProps } from "../viewer/viewerOverlay";
import { parseHangingProtocol, serializeHangingProtocol, type HangingGrid, type HangingProtocol } from "./hangingProtocol";
import {
  exportProtocols,
  extractProtocols,
  hasStored,
  HANGING_AUTO_APPLY_KEY,
  HANGING_PREFIX,
  isAutoApplyOn,
  parseImport,
  toStoreUpdate,
  type ImportEntry,
} from "./hangingProtocolStore";

const TEMPLATE = `{
  "id": "new-protocol",
  "name": "New protocol",
  "version": 1,
  "match": { "modality": ["CT"] },
  "slots": [
    { "series": { "descriptionContains": "" } }
  ],
  "grid": { "rows": 0, "cols": 0 }
}`;

type View =
  | { kind: "list" }
  /** originalId が null なら新規。 */
  | { kind: "editor"; originalId: string | null; text: string }
  | { kind: "import"; entries: ImportEntry[]; overwrites: string[] };

export const prettyProtocol = (p: HangingProtocol): string => JSON.stringify(JSON.parse(serializeHangingProtocol(p)), null, 2);

export function HangingProtocolManageDialog({
  load,
  save,
  download,
  onClose,
}: {
  load: () => Promise<SettingsMap>;
  save: (updates: SettingsMap) => Promise<SettingsMap>;
  download: (text: string, filename: string, type: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [settings, setSettings] = useState<SettingsMap | null>(null);
  const [view, setView] = useState<View>({ kind: "list" });
  const [errors, setErrors] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  /** 二重の実行を防ぎ、失敗は理由を出す。 */
  const run = useCallback(async (job: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setErrors([]);
    setMessage("");
    try {
      await job();
    } catch (e) {
      setErrors([t("viewer2d.hanging.manage.failed", { detail: e instanceof Error ? e.message : String(e) })]);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [t]);

  useEffect(() => {
    void run(async () => setSettings(await load()));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const stored = settings ? extractProtocols(settings) : { items: [], broken: [] };

  const openList = () => {
    setView({ kind: "list" });
    setErrors([]);
  };

  const saveEditor = (originalId: string | null, text: string) => run(async () => {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (e) {
      setErrors([t("viewer2d.hanging.jsonError", { detail: e instanceof Error ? e.message : String(e) })]);
      return;
    }
    const parsed = parseHangingProtocol(raw);
    if (!parsed.ok) { setErrors(parsed.errors); return; }
    const p = parsed.protocol;
    // id を変えて保存すると元の項目が残って 2 つになるので、編集では変えさせない。
    if (originalId !== null && p.id !== originalId) { setErrors([t("viewer2d.hanging.manage.idChanged", { id: originalId })]); return; }
    const update = toStoreUpdate(p);
    if (!update.ok) { setErrors([update.error]); return; }
    if (originalId === null && hasStored(await load(), p.id)) { setErrors([t("viewer2d.hanging.manage.idExists", { id: p.id })]); return; }
    setSettings(await save({ [update.key]: update.value }));
    setView({ kind: "list" });
    setMessage(t("viewer2d.hanging.manage.saved", { name: p.name }));
  });

  const remove = (key: string) => run(async () => {
    setSettings(await save({ [key]: "" }));
    setDeleting(null);
    setMessage(t("viewer2d.hanging.manage.deleted"));
  });

  const toggleAuto = (on: boolean) => run(async () => {
    setSettings(await save({ [HANGING_AUTO_APPLY_KEY]: String(on) }));
  });

  const exportAll = () => run(async () => {
    const latest = await load();
    setSettings(latest);
    download(exportProtocols(extractProtocols(latest).items), "hanging-protocols.json", "application/json");
  });

  const readImport = (file: File) => run(async () => {
    const parsed = parseImport(await file.text());
    if (!parsed.ok) { setErrors([t("viewer2d.hanging.jsonError", { detail: parsed.detail })]); return; }
    const latest = await load();
    setSettings(latest);
    const overwrites = parsed.entries.flatMap((e) => (e.ok && hasStored(latest, e.protocol.id) ? [e.protocol.id] : []));
    setView({ kind: "import", entries: parsed.entries, overwrites });
  });

  const commitImport = (entries: ImportEntry[]) => run(async () => {
    const updates: SettingsMap = {};
    for (const e of entries) if (e.ok) updates[e.key] = e.value;
    setSettings(await save(updates));
    setView({ kind: "list" });
    setMessage(t("viewer2d.hanging.manage.imported", { n: Object.keys(updates).length }));
  });

  const gridText = (g: HangingGrid) => `${g.rows || t("viewer2d.layout.auto")} × ${g.cols || t("viewer2d.layout.auto")}`;
  const valid = view.kind === "import" ? view.entries.filter((e) => e.ok).length : 0;

  return createPortal(
    <div style={backdrop}>
      <div style={panel} data-testid="hanging-manage-dialog" {...viewerOverlayProps}>
        <div style={title}>{t("viewer2d.hanging.manage.title")}</div>
        <div style={body}>
          {message && <p style={ok} data-testid="hanging-manage-message">{message}</p>}
          {errors.length > 0 && (
            <ul style={errorList} data-testid="hanging-manage-errors">{errors.map((m) => <li key={m}>{m}</li>)}</ul>
          )}

          {view.kind === "list" && settings && (
            <>
              <label style={autoRow}>
                <input
                  type="checkbox" data-testid="hanging-auto" checked={isAutoApplyOn(settings)} disabled={busy}
                  onChange={(e) => void toggleAuto(e.target.checked)}
                />
                {t("viewer2d.hanging.manage.auto")}
              </label>
              <p style={hint}>{t("viewer2d.hanging.manage.autoHelp")}</p>
              <p style={hint}>{t("viewer2d.hanging.manage.shared")}</p>
              {stored.items.length === 0 && <p data-testid="hanging-manage-empty">{t("viewer2d.hanging.manage.empty")}</p>}
              <table style={table}>
                <tbody>
                  {stored.items.map((p) => (
                    <tr key={p.id} data-testid="hanging-manage-row" data-protocol-id={p.id}>
                      <td style={td}>{p.name}</td>
                      <td style={tdSmall}>
                        {gridText(p.grid)}
                        {p.gridPortrait ? ` / ${t("viewer2d.hanging.manage.portrait")} ${gridText(p.gridPortrait)}` : ""}
                      </td>
                      <td style={tdActions}>
                        {deleting === p.id ? (
                          <>
                            <span style={warn}>{t("viewer2d.hanging.manage.confirmDelete")}</span>
                            <button style={btn} disabled={busy} data-testid="hanging-delete-yes" onClick={() => void remove(HANGING_PREFIX + p.id)}>{t("viewer2d.hanging.manage.delete")}</button>
                            <button style={btn} data-testid="hanging-delete-no" onClick={() => setDeleting(null)}>{t("common.cancel")}</button>
                          </>
                        ) : (
                          <>
                            <button style={btn} data-testid="hanging-edit" onClick={() => { setErrors([]); setMessage(""); setView({ kind: "editor", originalId: p.id, text: prettyProtocol(p) }); }}>{t("viewer2d.hanging.manage.edit")}</button>
                            <button style={btn} data-testid="hanging-delete" onClick={() => setDeleting(p.id)}>{t("viewer2d.hanging.manage.delete")}</button>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {stored.broken.length > 0 && (
                <div data-testid="hanging-broken">
                  <p style={warn}>{t("viewer2d.hanging.manage.broken", { n: stored.broken.length })}</p>
                  {stored.broken.map((b) => (
                    <div key={b.key} style={brokenRow}>
                      <span>{`${b.key}: ${b.errors.join(" / ")}`}</span>
                      <button style={btn} disabled={busy} data-testid="hanging-broken-delete" onClick={() => void remove(b.key)}>{t("viewer2d.hanging.manage.delete")}</button>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {view.kind === "editor" && (
            <textarea
              data-testid="hanging-editor" style={area} spellCheck={false} value={view.text}
              onChange={(e) => setView({ ...view, text: e.target.value })}
            />
          )}

          {view.kind === "import" && (
            <div data-testid="hanging-import-preview">
              <p data-testid="hanging-import-summary">
                {t("viewer2d.hanging.manage.importSummary", {
                  add: valid - view.overwrites.length, overwrite: view.overwrites.length, invalid: view.entries.length - valid,
                })}
              </p>
              <ul>
                {view.entries.map((e) => (
                  <li key={e.index} style={e.ok ? undefined : warn}>
                    {e.ok
                      ? `${e.protocol.name} (${e.protocol.id}) — ${t(view.overwrites.includes(e.protocol.id) ? "viewer2d.hanging.manage.willOverwrite" : "viewer2d.hanging.manage.willAdd")}`
                      : `#${e.index + 1}: ${e.errors.join(" / ")}`}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
        <div style={buttons}>
          {view.kind === "list" ? (
            <>
              <button style={btn} disabled={!settings || busy} data-testid="hanging-new" onClick={() => { setErrors([]); setMessage(""); setView({ kind: "editor", originalId: null, text: TEMPLATE }); }}>{t("viewer2d.hanging.manage.new")}</button>
              <button style={btn} disabled={stored.items.length === 0 || busy} data-testid="hanging-export" onClick={() => void exportAll()}>{t("viewer2d.hanging.manage.export")}</button>
              <label style={btn}>
                {t("viewer2d.hanging.manage.import")}
                <input
                  type="file" accept=".json,application/json" data-testid="hanging-import-file" style={{ display: "none" }}
                  disabled={!settings || busy}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = ""; // 同じファイルをもう一度選べるようにする
                    if (file) void readImport(file);
                  }}
                />
              </label>
              <span style={{ flex: 1 }} />
              <button style={btn} data-testid="hanging-manage-close" onClick={onClose}>{t("common.close")}</button>
            </>
          ) : (
            <>
              <button style={btn} data-testid="hanging-back" onClick={openList}>{t("common.cancel")}</button>
              {view.kind === "editor" ? (
                <button style={{ ...btn, ...primary }} disabled={busy} data-testid="hanging-save" onClick={() => void saveEditor(view.originalId, view.text)}>{t("viewer2d.hanging.manage.save")}</button>
              ) : (
                <button style={{ ...btn, ...primary }} disabled={busy || valid === 0} data-testid="hanging-import-commit" onClick={() => void commitImport(view.entries)}>{t("viewer2d.hanging.manage.importCommit", { n: valid })}</button>
              )}
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

const backdrop: React.CSSProperties = {
  position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)",
  display: "flex", alignItems: "center", justifyContent: "center", zIndex: 10000,
};
const panel: React.CSSProperties = {
  width: 640, maxWidth: "94vw", maxHeight: "90vh", display: "flex", flexDirection: "column",
  background: "#fff", borderRadius: 6, boxShadow: "0 8px 32px rgba(0,0,0,0.35)", overflow: "hidden",
  fontFamily: "system-ui, sans-serif",
};
const title: React.CSSProperties = { padding: "10px 16px", background: "#0b5cad", color: "#fff", fontSize: 13, fontWeight: 600 };
const body: React.CSSProperties = { padding: "14px 16px", fontSize: 12, color: "#22303d", overflowY: "auto" };
const autoRow: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6, fontWeight: 600 };
const hint: React.CSSProperties = { margin: "4px 0 8px", color: "#5a6b7d" };
const ok: React.CSSProperties = { margin: "0 0 8px", color: "#1b6b2f" };
const warn: React.CSSProperties = { color: "#8a4b00", marginRight: 6 };
const errorList: React.CSSProperties = { color: "#a4262c", margin: "0 0 8px", paddingLeft: 18 };
const table: React.CSSProperties = { width: "100%", borderCollapse: "collapse" };
const td: React.CSSProperties = { padding: "5px 8px 5px 0", borderTop: "1px solid #e5ebf1", wordBreak: "break-all" };
const tdSmall: React.CSSProperties = { ...td, color: "#5a6b7d" };
const tdActions: React.CSSProperties = { ...td, textAlign: "right", whiteSpace: "nowrap" };
const brokenRow: React.CSSProperties = { display: "flex", justifyContent: "space-between", gap: 8, wordBreak: "break-all" };
const area: React.CSSProperties = {
  width: "100%", boxSizing: "border-box", height: 320, fontFamily: "monospace", fontSize: 12, resize: "vertical",
};
const buttons: React.CSSProperties = { display: "flex", justifyContent: "flex-end", gap: 8, padding: "10px 16px", borderTop: "1px solid #dfe6ee" };
const btn: React.CSSProperties = {
  padding: "5px 12px", marginLeft: 4, fontSize: 12, border: "1px solid #b9c6d4", borderRadius: 4, background: "#fff", cursor: "pointer",
};
const primary: React.CSSProperties = { background: "#0b5cad", border: "1px solid #0b5cad", color: "#fff" };
