/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * メイン画面の「資料」節。施設が配る設定ファイル（リンク集・参照カード）を、折りたたみ式で出す（既定はすべて閉じる）。
 * 🔴 選択中の検査・電子カルテ連携の状態・患者情報を**一切参照しない**。リンク先は設定ファイルの固定の文字列だけで、何も付け足さない。
 * 外部ホストを読まない（画像・iframe・フォント無し。リンクを押すまで外へ出ない）。本文はテキストのみ（HTML を解釈しない）。
 */
import { useMemo, useState, type CSSProperties } from "react";
import { openExternal } from "../help/links";
import { useI18n } from "../i18n/i18n";
import type { FacilityGroup, FacilityItem } from "../settings/facilityView";
import { contactUrl, loadOpen, saveOpen, SECTION_ID, sanitizeFacilityConfig } from "./resourcePanelView";
import { useFacilityConfig } from "./useFacilityConfig";

export function ResourcePanel({ enabled = true }: { enabled?: boolean }) {
  const { t } = useI18n();
  const res = useFacilityConfig(enabled);
  const [open, setOpen] = useState<Set<string>>(() => loadOpen());
  const config = useMemo(() => (res ? sanitizeFacilityConfig(res.config) : null), [res]);

  if (!res) return null; // 未設定（または、まだ取れていない）: 節を出さない
  if (!config && res.state !== "error" && res.state !== "missing") return null;

  const toggle = (id: string) => {
    const next = new Set(open);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setOpen(next);
    saveOpen(next);
  };

  const sectionOpen = open.has(SECTION_ID);
  const warn = res.state !== "ok";

  const renderItem = (it: FacilityItem) =>
    it.type === "link" ? (
      <div key={it.id} style={itemRow}>
        <button type="button" style={linkBtn} data-testid={`resource-panel-link-${it.id}`} title={it.url ?? ""} onClick={() => it.url && openExternal(it.url)}>
          {it.title} ↗
        </button>
        {it.note && <span style={noteStyle}>{it.note}</span>}
      </div>
    ) : (
      <div key={it.id} style={itemRow}>
        <button type="button" style={groupBtn} aria-expanded={open.has("c:" + it.id)} data-testid={`resource-panel-card-${it.id}`} onClick={() => toggle("c:" + it.id)}>
          {open.has("c:" + it.id) ? "▾" : "▸"} {it.title}
        </button>
        {open.has("c:" + it.id) && (
          <div style={cardBody} data-testid={`resource-panel-card-body-${it.id}`}>
            {it.body}
            {it.url && (
              <div>
                <button type="button" style={linkBtn} title={it.url} onClick={() => it.url && openExternal(it.url)}>
                  {t("resource.open")} ↗
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    );

  const renderGroup = (g: FacilityGroup, depth: number) => (
    <div key={g.id} style={{ marginLeft: depth * 10 }} data-testid={`resource-panel-group-${g.id}`}>
      <button type="button" style={groupBtn} aria-expanded={open.has(g.id)} data-testid={`resource-panel-group-toggle-${g.id}`} onClick={() => toggle(g.id)}>
        {open.has(g.id) ? "▾" : "▸"} {g.title}
      </button>
      {open.has(g.id) && (
        <div style={{ marginLeft: 12 }}>
          {g.items.map(renderItem)}
          {g.groups.map((s) => renderGroup(s, 0))}
        </div>
      )}
    </div>
  );

  return (
    <section style={box} data-testid="resource-panel" data-state={res.state} aria-label={t("resource.title")}>
      <button type="button" style={headBtn} aria-expanded={sectionOpen} data-testid="resource-panel-toggle" onClick={() => toggle(SECTION_ID)}>
        <span>
          {sectionOpen ? "▾" : "▸"} {config?.title || t("resource.title")}
        </span>
        {config?.updatedAt && <span style={noteStyle}>{t("resource.updated", { date: config.updatedAt })}</span>}
      </button>
      {sectionOpen && (
        <div style={scroll}>
          {warn && (
            <div style={warnStyle} data-testid="resource-panel-status">
              {config ? t("resource.status.kept") : t("resource.status.none")}
            </div>
          )}
          {config?.groups.map((g) => renderGroup(g, 0))}
          {config?.contact && (
            <button type="button" style={{ ...linkBtn, marginTop: 6 }} data-testid="resource-panel-contact" onClick={() => openExternal(contactUrl(config.contact!, t("resource.contact.subject")))}>
              {t("resource.contact")} ↗
            </button>
          )}
        </div>
      )}
    </section>
  );
}

const box: CSSProperties = { marginTop: 14, border: "1px solid #cfe0e3", borderRadius: 6, background: "#f2f8f9", fontSize: 13 };
const headBtn: CSSProperties = { width: "100%", display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 6, padding: "6px 8px", border: 0, background: "transparent", cursor: "pointer", fontWeight: 600, color: "#1c3d42", textAlign: "left", font: "inherit" };
const scroll: CSSProperties = { maxHeight: 260, overflowY: "auto", padding: "0 8px 8px" };
const groupBtn: CSSProperties = { display: "block", width: "100%", border: 0, background: "transparent", padding: "3px 0", textAlign: "left", cursor: "pointer", font: "inherit", color: "#222" };
const linkBtn: CSSProperties = { border: 0, background: "transparent", padding: "2px 0", cursor: "pointer", font: "inherit", color: "#0b5cad", textDecoration: "underline", textAlign: "left" };
const itemRow: CSSProperties = { padding: "1px 0" };
const noteStyle: CSSProperties = { color: "#6b7785", fontSize: 11, marginLeft: 6 };
const cardBody: CSSProperties = { whiteSpace: "pre-wrap", margin: "2px 0 4px 14px", padding: 6, background: "#fff", border: "1px solid #dde6e8", borderRadius: 4 };
const warnStyle: CSSProperties = { color: "#8a5a00", background: "#fbefcf", borderRadius: 4, padding: "3px 6px", marginBottom: 4, fontSize: 12 };
