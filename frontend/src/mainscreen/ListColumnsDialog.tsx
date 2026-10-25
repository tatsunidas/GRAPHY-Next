/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { useEffect, useMemo, useState } from "react";
import { fetchTagDictionary, type TagDictEntry } from "../api";
import { useI18n } from "../i18n/i18n";
import { NestedTagBuilder } from "./NestedTagBuilder";
import {
  newColumnId, saveListColumns, useListColumns, type ListColumn, type ListColumnWhere,
} from "./listColumns";
import { dictMap, ggggeeee, pathDisplay, pathLabel } from "./tagPathUtil";

const WHERES: ListColumnWhere[] = ["study", "series", "both"];

/**
 * 「一覧の列」ダイアログ。スタディ一覧・シリーズ一覧に出す DICOM タグの列を足す・消す・並べる。
 * 辞書から選ぶ、またはシーケンスの中・プライベートタグを指定する（TagExtractor と同じ指定のしかた）。
 * 変更はその場で保存される（PC・ブラウザごと）。値は DICOM ファイルにも索引にも書かない。
 */
export function ListColumnsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const columns = useListColumns();
  const [dict, setDict] = useState<TagDictEntry[]>([]);
  const dmap = useMemo(() => dictMap(dict), [dict]);
  const [query, setQuery] = useState("");
  const [nestedOpen, setNestedOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || dict.length > 0) return;
    fetchTagDictionary().then(setDict).catch(() => setError(t("tagext.err.dict")));
  }, [open, dict.length, t]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return dict
      .filter((e) => e.keyword.toLowerCase().includes(q) || e.tag.toLowerCase().includes(q) || ggggeeee(e.tag).includes(q))
      .slice(0, 100);
  }, [query, dict]);

  if (!open) return null;

  const add = (segments: { tag: string; creator?: string }[], label: string) => {
    saveListColumns([...columns, { id: newColumnId(columns), segments, label, where: "both" }]);
  };
  const update = (id: string, patch: Partial<ListColumn>) =>
    saveListColumns(columns.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  const remove = (id: string) => saveListColumns(columns.filter((c) => c.id !== id));
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= columns.length) return;
    const next = columns.slice();
    [next[i], next[j]] = [next[j], next[i]];
    saveListColumns(next);
  };

  return (
    <div style={overlay} data-testid="list-columns-dialog" onClick={onClose}>
      <div style={dialog} onClick={(e) => e.stopPropagation()}>
        <div style={header}>
          <strong>{t("listCol.title")}</strong>
          <button type="button" style={closeBtn} onClick={onClose} aria-label={t("common.close")}>✕</button>
        </div>

        <div style={section}>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              style={{ ...inp, flex: 1 }}
              data-testid="list-columns-search"
              value={query}
              placeholder={t("listCol.search")}
              onChange={(e) => setQuery(e.target.value)}
            />
            <button type="button" style={btn} data-testid="list-columns-nested" onClick={() => setNestedOpen(true)}>
              {t("listCol.nested")}
            </button>
          </div>
          {filtered.length > 0 && (
            <div style={listBox}>
              {filtered.map((e) => (
                <div
                  key={e.tag}
                  style={dictRow}
                  data-testid={`list-columns-dict-${e.tag}`}
                  onClick={() => { add([{ tag: e.tag }], e.keyword || ggggeeee(e.tag)); setQuery(""); }}
                >
                  <span style={{ color: "#667" }}>{ggggeeee(e.tag)}</span>
                  <span style={{ flex: 1 }}>{e.keyword}</span>
                  <span style={{ color: "#99a" }}>{e.vr}</span>
                  <span style={{ color: "#0b5cad" }}>{t("listCol.add")}</span>
                </div>
              ))}
            </div>
          )}
          {error && <div style={{ color: "#b00020", fontSize: 12 }}>{error}</div>}
        </div>

        <div style={{ ...section, flex: 1, overflow: "auto" }}>
          {columns.length === 0 && <div style={{ color: "#778", fontSize: 13 }}>{t("listCol.empty")}</div>}
          {columns.map((c, i) => (
            <div key={c.id} style={colRow} data-testid="list-columns-row">
              <button type="button" style={miniBtn} disabled={i === 0} onClick={() => move(i, -1)} aria-label={t("listCol.up")}>↑</button>
              <button type="button" style={miniBtn} disabled={i === columns.length - 1} onClick={() => move(i, 1)} aria-label={t("listCol.down")}>↓</button>
              <input
                style={{ ...inp, width: 150 }}
                value={c.label}
                aria-label={t("listCol.heading")}
                onChange={(e) => update(c.id, { label: e.target.value })}
              />
              <span style={{ flex: 1, minWidth: 0, color: "#556", fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                title={pathDisplay(dmap, { segments: c.segments, label: c.label })}>
                {pathDisplay(dmap, { segments: c.segments, label: c.label })}
              </span>
              <select
                style={inp}
                value={c.where}
                aria-label={t("listCol.where")}
                onChange={(e) => update(c.id, { where: e.target.value as ListColumnWhere })}
              >
                {WHERES.map((w) => <option key={w} value={w}>{t(`listCol.where.${w}`)}</option>)}
              </select>
              <button type="button" style={miniBtn} data-testid="list-columns-remove" onClick={() => remove(c.id)} aria-label={t("listCol.remove")}>🗑</button>
            </div>
          ))}
        </div>

        <div style={footer}>
          <span style={{ flex: 1, fontSize: 12, color: "#667" }}>{t("listCol.note")}</span>
          <button type="button" style={btn} onClick={onClose}>{t("common.close")}</button>
        </div>
      </div>

      <NestedTagBuilder
        open={nestedOpen}
        dict={dict}
        dictMapByTag={dmap}
        onClose={() => setNestedOpen(false)}
        onConfirm={(p) => {
          add(p.segments, p.label || pathLabel(dmap, p.segments));
          setNestedOpen(false);
        }}
      />
    </div>
  );
}

const overlay: React.CSSProperties = { position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 };
const dialog: React.CSSProperties = { width: 760, maxWidth: "96vw", maxHeight: "90vh", minHeight: 360, background: "#fff", borderRadius: 10, boxShadow: "0 12px 40px rgba(0,0,0,0.3)", display: "flex", flexDirection: "column", overflow: "hidden", fontFamily: "system-ui, sans-serif", color: "#1a1a1a" };
const header: React.CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", borderBottom: "1px solid #eee" };
const closeBtn: React.CSSProperties = { border: "none", background: "transparent", fontSize: 16, cursor: "pointer", color: "#666" };
const section: React.CSSProperties = { padding: "10px 16px", display: "flex", flexDirection: "column", gap: 6, borderBottom: "1px solid #eef1f4" };
const inp: React.CSSProperties = { padding: "5px 8px", border: "1px solid #cdd5de", borderRadius: 5, fontSize: 13 };
const listBox: React.CSSProperties = { maxHeight: 170, overflow: "auto", border: "1px solid #e1e7ee", borderRadius: 6 };
const dictRow: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, padding: "3px 8px", fontSize: 12.5, borderBottom: "1px solid #f1f3f5", cursor: "pointer" };
const colRow: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6, padding: "3px 0" };
const miniBtn: React.CSSProperties = { border: "1px solid #cdd5de", borderRadius: 5, background: "#fff", cursor: "pointer", fontSize: 12, padding: "2px 7px" };
const footer: React.CSSProperties = { display: "flex", alignItems: "center", gap: 10, padding: "10px 16px", borderTop: "1px solid #eee" };
const btn: React.CSSProperties = { padding: "6px 14px", border: "1px solid #cdd5de", borderRadius: 6, background: "#fff", cursor: "pointer", fontSize: 13, whiteSpace: "nowrap" };
