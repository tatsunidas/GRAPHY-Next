/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  extractCsv,
  extractTable,
  fetchStudies,
  fetchTagDictionary,
  type ExtractTableResult,
  type StudyFilters,
  type TagDictEntry,
  type TagPath,
} from "../api";
import { useI18n } from "../i18n/i18n";
import { NestedTagBuilder } from "./NestedTagBuilder";
import {
  dictMap,
  ggggeeee,
  normHex,
  parseTagList,
  pathDisplay,
  pathLabel,
  serializeTagList,
} from "./tagPathUtil";

/** よく使うタグのプリセット（クイック追加）。 */
const PRESETS = ["00100010", "00100020", "00080060", "0008103E", "00180015", "00081030", "00080020"];

/**
 * TagExtractor（GRAPHY 移植）。タグ／シーケンス（パス編集）／Private を指定し、MainScreen の
 * 検索リスト全体をシリーズ単位で抽出してテーブル化、CSV 保存する。タグリストの .properties 保存/読込も可。
 */
export function TagExtractorDialog({
  open,
  onClose,
  filters,
}: {
  open: boolean;
  onClose: () => void;
  filters: StudyFilters | null;
}) {
  const { t } = useI18n();
  const [dict, setDict] = useState<TagDictEntry[]>([]);
  const dmap = useMemo(() => dictMap(dict), [dict]);

  const [paths, setPaths] = useState<TagPath[]>([]);
  const [query, setQuery] = useState("");
  const [pvTag, setPvTag] = useState("");
  const [pvName, setPvName] = useState("");
  const [pvCreator, setPvCreator] = useState("");
  const [nestedOpen, setNestedOpen] = useState(false);

  const [result, setResult] = useState<ExtractTableResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const studyUidsRef = useRef<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open || dict.length > 0) return;
    fetchTagDictionary().then(setDict).catch(() => setError(t("tagext.err.dict")));
  }, [open, dict.length, t]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return dict.slice(0, 200);
    return dict
      .filter((e) => e.keyword.toLowerCase().includes(q) || e.tag.toLowerCase().includes(q) || ggggeeee(e.tag).includes(q))
      .slice(0, 200);
  }, [query, dict]);

  if (!open) return null;

  const addSingle = (hex: string) => {
    const h = normHex(hex);
    if (!h) {
      setError(t("tagext.err.badTag", { tag: hex }));
      return;
    }
    setPaths((p) => [...p, { segments: [{ tag: h }], label: pathLabel(dmap, [{ tag: h }]) }]);
  };
  const addPrivateSingle = () => {
    const h = normHex(pvTag);
    if (!h) {
      setError(t("tagext.err.badTag", { tag: pvTag }));
      return;
    }
    const seg = { tag: h, creator: pvCreator || undefined };
    setPaths((p) => [...p, { segments: [seg], label: pvName || pathLabel(dmap, [seg]) }]);
    setPvTag("");
    setPvName("");
    setPvCreator("");
  };
  const removePath = (i: number) => setPaths((p) => p.filter((_, idx) => idx !== i));
  const movePath = (i: number, d: number) =>
    setPaths((p) => {
      const n = [...p];
      const j = i + d;
      if (j < 0 || j >= n.length) return n;
      [n[i], n[j]] = [n[j], n[i]];
      return n;
    });

  const resolveStudyUids = async (): Promise<string[] | null> => {
    if (!filters) {
      setError(t("tagext.err.noSearch"));
      return null;
    }
    const studies = await fetchStudies(filters);
    if (studies.length === 0) {
      setError(t("tagext.err.noStudies"));
      return null;
    }
    return studies.map((s) => s.studyInstanceUid);
  };

  const run = async () => {
    if (paths.length === 0) {
      setError(t("tagext.err.noTags"));
      return;
    }
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const studyUids = await resolveStudyUids();
      if (!studyUids) return;
      studyUidsRef.current = studyUids;
      const r = await extractTable({ studyUids, paths });
      setResult(r);
      setInfo(t("tagext.result", { rows: r.rows.length, studies: studyUids.length }));
    } catch (e) {
      setError(t("common.fetchError", { error: String(e) }));
    } finally {
      setBusy(false);
    }
  };

  const saveCsv = async () => {
    if (paths.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const studyUids = studyUidsRef.current.length > 0 ? studyUidsRef.current : await resolveStudyUids();
      if (!studyUids) return;
      const { blob, filename } = await extractCsv({ studyUids, paths });
      downloadBlob(blob, filename);
    } catch (e) {
      setError(t("common.fetchError", { error: String(e) }));
    } finally {
      setBusy(false);
    }
  };

  const saveTagList = () => {
    if (paths.length === 0) return;
    downloadBlob(new Blob([serializeTagList(paths)], { type: "text/plain" }), "tag-list.properties");
  };
  const loadTagList = async (file: File) => {
    try {
      const text = await file.text();
      const loaded = parseTagList(text, dmap);
      setPaths(loaded);
      setInfo(t("tagext.loaded", { count: loaded.length }));
    } catch (e) {
      setError(t("common.fetchError", { error: String(e) }));
    }
  };

  const canRun = !busy && paths.length > 0;

  return (
    <div style={overlay} onClick={onClose}>
      <div data-testid="tag-extractor-dialog" style={dialog} onClick={(e) => e.stopPropagation()}>
        <div style={header}>
          <span style={{ fontWeight: 700 }}>{t("tagext.title")}</span>
          <button style={closeBtn} onClick={onClose}>✕</button>
        </div>

        <div style={bodyRow}>
          {/* 左: タグ選択 */}
          <div style={leftPane}>
            <div style={{ fontSize: 12, color: "#6b7785" }}>{t("tagext.scope.searchList")}</div>
            <input style={inp} value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("tagext.dict.search")} spellCheck={false} />
            <div style={listBox}>
              {dict.length === 0 && <div style={{ padding: 8, color: "#888", fontSize: 12 }}>{t("common.loading")}</div>}
              {filtered.map((e) => (
                <div key={e.tag} style={dictRow} onDoubleClick={() => addSingle(e.tag)}>
                  <span style={{ fontFamily: "monospace", color: "#556" }}>{ggggeeee(e.tag)}</span>
                  <span style={{ flex: 1 }}>{e.keyword}</span>
                  <span style={{ color: "#8a98a6", fontSize: 11 }}>{e.vr}</span>
                  <button style={miniBtn} onClick={() => addSingle(e.tag)}>+</button>
                </div>
              ))}
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <button style={btn} onClick={() => setNestedOpen(true)}>{t("tagext.addNested")}</button>
            </div>
            {/* Private 単独 */}
            <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ fontSize: 12, color: "#556" }}>{t("tagext.private.label")}</span>
              <input style={{ ...inp, width: 96 }} value={pvTag} onChange={(e) => setPvTag(e.target.value)} placeholder="0019,1001" />
              <input style={{ ...inp, width: 96 }} value={pvName} onChange={(e) => setPvName(e.target.value)} placeholder={t("tagext.private.name")} />
              <input style={{ ...inp, width: 110 }} value={pvCreator} onChange={(e) => setPvCreator(e.target.value)} placeholder={t("tagext.private.creator")} />
              <button style={miniBtn} onClick={addPrivateSingle}>{t("common.add")}</button>
            </div>
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
              <span style={{ fontSize: 11, color: "#8a98a6", alignSelf: "center" }}>{t("tagext.presets")}:</span>
              {PRESETS.map((h) => (
                <button key={h} data-testid={`tagext-preset-${h}`} style={chip} onClick={() => addSingle(h)}>{dmap.get(h)?.keyword ?? ggggeeee(h)}</button>
              ))}
            </div>
          </div>

          {/* 右: 選択済み */}
          <div style={rightPane}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: "#33404d" }}>{t("tagext.selected", { n: paths.length })}</span>
              <div style={{ display: "flex", gap: 6 }}>
                <button style={miniBtn} onClick={saveTagList} disabled={paths.length === 0} title={t("tagext.saveList")}>💾</button>
                <button style={miniBtn} onClick={() => fileInputRef.current?.click()} title={t("tagext.loadList")}>📂</button>
                <input ref={fileInputRef} type="file" accept=".properties,.txt" style={{ display: "none" }}
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) void loadTagList(f); e.target.value = ""; }} />
              </div>
            </div>
            <div style={selBox}>
              {paths.length === 0 && <div style={{ color: "#8a98a6", fontSize: 12, padding: 6 }}>{t("tagext.selected.empty")}</div>}
              {paths.map((p, i) => (
                <div key={i} style={selRow}>
                  <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={pathDisplay(dmap, p)}>
                    {pathDisplay(dmap, p)}
                  </span>
                  <button style={miniBtn} disabled={i === 0} onClick={() => movePath(i, -1)}>↑</button>
                  <button style={miniBtn} disabled={i === paths.length - 1} onClick={() => movePath(i, 1)}>↓</button>
                  <button style={{ ...miniBtn, color: "#b00020" }} onClick={() => removePath(i)}>✕</button>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* 結果テーブル */}
        <div style={resultPane}>
          {!result && <div style={{ color: "#8a98a6", fontSize: 12 }}>{t("tagext.notRun")}</div>}
          {result && (
            <div style={{ overflow: "auto", height: "100%" }}>
              <table data-testid="tag-extractor-result-table" style={tableStyle}>
                <thead>
                  <tr>{result.columns.map((c, i) => <th key={i} style={th}>{c}</th>)}</tr>
                </thead>
                <tbody>
                  {result.rows.map((row, ri) => (
                    <tr key={ri} style={{ borderBottom: "1px solid #eef1f4" }}>
                      {row.map((v, ci) => <td key={ci} style={td} title={v}>{v}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
              {result.errors.length > 0 && (
                <div style={errBox}>
                  <div style={{ fontWeight: 600, marginBottom: 2 }}>{t("tagext.errors", { n: result.errors.length })}</div>
                  {result.errors.slice(0, 50).map((e, i) => <div key={i}>{e}</div>)}
                </div>
              )}
            </div>
          )}
        </div>

        <div style={footer}>
          <div style={{ flex: 1, minWidth: 0, fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {info && <span style={{ color: "#2e5d27" }}>{info}</span>}
            {error && <span style={{ color: "#b00020" }}>{error}</span>}
          </div>
          <button style={btn} onClick={onClose}>{t("common.close")}</button>
          <button data-testid="tag-extractor-save-csv-btn" style={btn} onClick={saveCsv} disabled={busy || paths.length === 0}>{t("tagext.saveCsv")}</button>
          <button
            data-testid="tag-extractor-run-btn"
            style={{ ...btn, background: canRun ? "#0b5cad" : "#9fb6cf", color: "#fff", border: "none", cursor: canRun ? "pointer" : "default" }}
            onClick={run}
            disabled={!canRun}
          >
            {busy ? t("tagext.running") : t("tagext.run")}
          </button>
        </div>
      </div>

      <NestedTagBuilder
        open={nestedOpen}
        dict={dict}
        dictMapByTag={dmap}
        onClose={() => setNestedOpen(false)}
        onConfirm={(p) => { setPaths((prev) => [...prev, p]); setNestedOpen(false); }}
      />
    </div>
  );
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

const overlay: React.CSSProperties = { position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 };
const dialog: React.CSSProperties = { width: 980, maxWidth: "97vw", height: 720, maxHeight: "94vh", background: "#fff", borderRadius: 10, boxShadow: "0 12px 40px rgba(0,0,0,0.3)", display: "flex", flexDirection: "column", overflow: "hidden", fontFamily: "system-ui, sans-serif", color: "#1a1a1a" };
const header: React.CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", borderBottom: "1px solid #eee" };
const closeBtn: React.CSSProperties = { border: "none", background: "transparent", fontSize: 16, cursor: "pointer", color: "#666" };
const bodyRow: React.CSSProperties = { display: "flex", gap: 12, padding: "10px 16px", borderBottom: "1px solid #eef1f4" };
const leftPane: React.CSSProperties = { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 8 };
const rightPane: React.CSSProperties = { width: 360, display: "flex", flexDirection: "column", gap: 6 };
const inp: React.CSSProperties = { padding: "5px 8px", border: "1px solid #cdd5de", borderRadius: 5, fontSize: 13 };
const listBox: React.CSSProperties = { height: 170, overflow: "auto", border: "1px solid #e1e7ee", borderRadius: 6 };
const dictRow: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, padding: "3px 8px", fontSize: 12.5, borderBottom: "1px solid #f1f3f5", cursor: "pointer" };
const selBox: React.CSSProperties = { flex: 1, minHeight: 150, overflow: "auto", border: "1px solid #e1e7ee", borderRadius: 6, background: "#fafbfc" };
const selRow: React.CSSProperties = { display: "flex", alignItems: "center", gap: 4, padding: "3px 6px", fontSize: 12.5, borderBottom: "1px solid #f1f3f5" };
const resultPane: React.CSSProperties = { flex: 1, minHeight: 0, padding: "8px 16px", overflow: "hidden" };
const tableStyle: React.CSSProperties = { borderCollapse: "collapse", fontSize: 12, whiteSpace: "nowrap" };
const th: React.CSSProperties = { position: "sticky", top: 0, background: "#f7f9fb", border: "1px solid #e1e7ee", padding: "4px 8px", textAlign: "left", fontWeight: 600 };
const td: React.CSSProperties = { border: "1px solid #eef1f4", padding: "3px 8px", maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis" };
const errBox: React.CSSProperties = { marginTop: 8, padding: 8, background: "#fff4f4", border: "1px solid #f0d0d0", borderRadius: 6, fontSize: 11.5, color: "#a11" };
const footer: React.CSSProperties = { display: "flex", alignItems: "center", gap: 10, padding: "10px 16px", borderTop: "1px solid #eee" };
const btn: React.CSSProperties = { padding: "6px 14px", border: "1px solid #cdd5de", borderRadius: 6, background: "#fff", cursor: "pointer", fontSize: 13, whiteSpace: "nowrap" };
const miniBtn: React.CSSProperties = { minWidth: 24, padding: "2px 7px", border: "1px solid #cdd5de", borderRadius: 4, background: "#fff", cursor: "pointer", fontSize: 12 };
const chip: React.CSSProperties = { padding: "2px 8px", border: "1px solid #d7dde3", borderRadius: 10, background: "#fff", cursor: "pointer", fontSize: 11.5 };
