/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { useMemo, useState } from "react";
import type { TagDictEntry, TagPath, TagPathSegment } from "../api";
import { useI18n } from "../i18n/i18n";
import { ggggeeee, isPrivateGroup, isSQ, normHex, pathLabel } from "./tagPathUtil";

type Seg = TagPathSegment & { keyword: string; vr: string };

/**
 * シーケンスタグのパス編集ダイアログ（GRAPHY NestedTagBuilderDialog 移植）。
 * 辞書から選ぶ or Private を手入力してセグメントを積み、並べ替え、検証して 1 つのパスを返す。
 * 検証: 中間セグメントは SQ 必須／末尾は非SQ／Private（奇数群）は検証スキップ。
 */
export function NestedTagBuilder({
  open,
  dict,
  dictMapByTag,
  onClose,
  onConfirm,
}: {
  open: boolean;
  dict: TagDictEntry[];
  dictMapByTag: Map<string, TagDictEntry>;
  onClose: () => void;
  onConfirm: (path: TagPath) => void;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [segs, setSegs] = useState<Seg[]>([]);
  const [pvTag, setPvTag] = useState("");
  const [pvName, setPvName] = useState("");
  const [pvCreator, setPvCreator] = useState("");
  const [error, setError] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return dict.slice(0, 200);
    return dict
      .filter((e) => e.keyword.toLowerCase().includes(q) || e.tag.toLowerCase().includes(q) || ggggeeee(e.tag).includes(q))
      .slice(0, 200);
  }, [query, dict]);

  if (!open) return null;

  const addFromDict = (e: TagDictEntry) => {
    setSegs((s) => [...s, { tag: e.tag, keyword: e.keyword, vr: e.vr }]);
    setError(null);
  };
  const addPrivate = () => {
    const hex = normHex(pvTag);
    if (!hex) {
      setError(t("tagext.err.badTag", { tag: pvTag }));
      return;
    }
    setSegs((s) => [...s, { tag: hex, keyword: pvName || "", vr: "", creator: pvCreator || undefined }]);
    setPvTag("");
    setPvName("");
    setPvCreator("");
    setError(null);
  };
  const move = (i: number, d: number) => {
    setSegs((s) => {
      const n = [...s];
      const j = i + d;
      if (j < 0 || j >= n.length) return n;
      [n[i], n[j]] = [n[j], n[i]];
      return n;
    });
  };
  const remove = (i: number) => setSegs((s) => s.filter((_, idx) => idx !== i));

  const validate = (): string | null => {
    if (segs.length === 0) return t("tagext.err.empty");
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      if (isPrivateGroup(s.tag)) continue; // Private は検証スキップ（GRAPHY 準拠）
      const entry = dictMapByTag.get(s.tag);
      const sq = isSQ(entry);
      if (i < segs.length - 1 && !sq) return t("tagext.err.midNotSq", { tag: ggggeeee(s.tag) });
      if (i === segs.length - 1 && sq) return t("tagext.err.endIsSq", { tag: ggggeeee(s.tag) });
    }
    return null;
  };

  const confirm = () => {
    const err = validate();
    if (err) {
      setError(err);
      return;
    }
    const segments: TagPathSegment[] = segs.map((s) => ({ tag: s.tag, creator: s.creator }));
    onConfirm({ segments, label: pathLabel(dictMapByTag, segments) });
    setSegs([]);
    setError(null);
  };

  return (
    <div style={overlay} onClick={onClose}>
      <div style={dialog} onClick={(e) => e.stopPropagation()}>
        <div style={header}>
          <span style={{ fontWeight: 700 }}>{t("tagext.nested.title")}</span>
          <button style={closeBtn} onClick={onClose}>✕</button>
        </div>

        <div style={{ padding: "10px 14px", display: "flex", flexDirection: "column", gap: 10, overflow: "auto" }}>
          <p style={{ margin: 0, fontSize: 12, color: "#6b7785" }}>{t("tagext.nested.help")}</p>

          {/* 辞書検索 */}
          <input
            style={inp}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("tagext.dict.search")}
            spellCheck={false}
          />
          <div style={listBox}>
            {filtered.map((e) => (
              <div key={e.tag} style={dictRow} onDoubleClick={() => addFromDict(e)}>
                <span style={{ fontFamily: "monospace", color: "#556" }}>{ggggeeee(e.tag)}</span>
                <span style={{ flex: 1 }}>{e.keyword}</span>
                <span style={{ color: "#8a98a6", fontSize: 11 }}>{e.vr}</span>
                <button style={miniBtn} onClick={() => addFromDict(e)}>+</button>
              </div>
            ))}
          </div>

          {/* Private 手入力 */}
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ fontSize: 12, color: "#556" }}>{t("tagext.private.label")}</span>
            <input style={{ ...inp, width: 110 }} value={pvTag} onChange={(e) => setPvTag(e.target.value)} placeholder="0019,1001" />
            <input style={{ ...inp, width: 120 }} value={pvName} onChange={(e) => setPvName(e.target.value)} placeholder={t("tagext.private.name")} />
            <input style={{ ...inp, width: 140 }} value={pvCreator} onChange={(e) => setPvCreator(e.target.value)} placeholder={t("tagext.private.creator")} />
            <button style={miniBtn} onClick={addPrivate}>{t("common.add")}</button>
          </div>

          {/* 構築中のパス */}
          <div style={{ fontSize: 12, fontWeight: 600, color: "#33404d" }}>{t("tagext.nested.path")}</div>
          <div style={pathBox}>
            {segs.length === 0 && <span style={{ color: "#8a98a6", fontSize: 12 }}>{t("tagext.nested.empty")}</span>}
            {segs.map((s, i) => (
              <div key={i} style={segRow}>
                <span style={{ color: "#8a98a6" }}>{i + 1}.</span>
                <span style={{ fontFamily: "monospace", color: "#556" }}>{ggggeeee(s.tag)}</span>
                <span style={{ flex: 1 }}>{s.keyword || (isPrivateGroup(s.tag) ? "(private)" : "")}{s.creator ? ` [${s.creator}]` : ""}</span>
                <span style={{ color: "#8a98a6", fontSize: 11 }}>{s.vr}</span>
                <button style={miniBtn} disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
                <button style={miniBtn} disabled={i === segs.length - 1} onClick={() => move(i, 1)}>↓</button>
                <button style={{ ...miniBtn, color: "#b00020" }} onClick={() => remove(i)}>✕</button>
              </div>
            ))}
          </div>
        </div>

        {error && <div style={{ color: "#b00020", fontSize: 12, padding: "0 14px 6px" }}>{error}</div>}
        <div style={footer}>
          <button style={btn} onClick={onClose}>{t("common.cancel")}</button>
          <button style={{ ...btn, background: "#0b5cad", color: "#fff", border: "none" }} onClick={confirm}>
            {t("tagext.nested.add")}
          </button>
        </div>
      </div>
    </div>
  );
}

const overlay: React.CSSProperties = { position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1100 };
const dialog: React.CSSProperties = { width: 600, maxWidth: "94vw", maxHeight: "88vh", background: "#fff", borderRadius: 10, boxShadow: "0 12px 40px rgba(0,0,0,0.3)", display: "flex", flexDirection: "column", overflow: "hidden", fontFamily: "system-ui, sans-serif", color: "#1a1a1a" };
const header: React.CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px", borderBottom: "1px solid #eee" };
const closeBtn: React.CSSProperties = { border: "none", background: "transparent", fontSize: 16, cursor: "pointer", color: "#666" };
const inp: React.CSSProperties = { padding: "5px 8px", border: "1px solid #cdd5de", borderRadius: 5, fontSize: 13 };
const listBox: React.CSSProperties = { maxHeight: 180, overflow: "auto", border: "1px solid #e1e7ee", borderRadius: 6 };
const dictRow: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, padding: "3px 8px", fontSize: 12.5, borderBottom: "1px solid #f1f3f5", cursor: "pointer" };
const pathBox: React.CSSProperties = { border: "1px solid #e1e7ee", borderRadius: 6, padding: 6, minHeight: 60, display: "flex", flexDirection: "column", gap: 3, background: "#fafbfc" };
const segRow: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6, fontSize: 12.5 };
const miniBtn: React.CSSProperties = { minWidth: 24, padding: "2px 6px", border: "1px solid #cdd5de", borderRadius: 4, background: "#fff", cursor: "pointer", fontSize: 12 };
const footer: React.CSSProperties = { display: "flex", justifyContent: "flex-end", gap: 8, padding: "10px 14px", borderTop: "1px solid #eee" };
const btn: React.CSSProperties = { padding: "6px 14px", border: "1px solid #cdd5de", borderRadius: 6, background: "#fff", cursor: "pointer", fontSize: 13 };
