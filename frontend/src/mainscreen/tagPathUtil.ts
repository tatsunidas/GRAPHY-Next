/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import type { TagDictEntry, TagPath, TagPathSegment } from "../api";

/** 入力を 8 桁 hex（大文字）へ正規化。8 桁でなければ null。 */
export function normHex(s: string): string | null {
  const h = (s || "").replace(/[^0-9A-Fa-f]/g, "").toUpperCase();
  return h.length === 8 ? h : null;
}

/** "00400275" → "0040,0275"。 */
export function ggggeeee(hex8: string): string {
  return `${hex8.slice(0, 4)},${hex8.slice(4, 8)}`;
}

/** Private タグ（群番号が奇数）か。 */
export function isPrivateGroup(hex8: string): boolean {
  return (parseInt(hex8.slice(0, 4), 16) & 1) === 1;
}

/** 辞書エントリ（または tag）から VR が SQ か。 */
export function isSQ(entry: TagDictEntry | undefined): boolean {
  return !!entry && entry.vr.split(/[ ,/]/).includes("SQ");
}

/** tag(8hex) → 辞書の keyword（無ければ ""）。 */
export function keywordOf(dict: Map<string, TagDictEntry>, hex8: string): string {
  return dict.get(hex8)?.keyword ?? "";
}

/** パスの表示ラベル（CSV 列名）: 各セグメントの keyword（無ければ GGGG,EEEE）を "." 連結。 */
export function pathLabel(dict: Map<string, TagDictEntry>, segments: TagPathSegment[]): string {
  return segments
    .map((s) => keywordOf(dict, s.tag) || ggggeeee(s.tag))
    .join(".");
}

/** 選択リスト表示用（" > " 連結。Private は creator を併記）。 */
export function pathDisplay(dict: Map<string, TagDictEntry>, p: TagPath): string {
  return p.segments
    .map((s) => {
      const kw = keywordOf(dict, s.tag);
      const head = `${ggggeeee(s.tag)}${kw ? " " + kw : ""}`;
      return s.creator ? `${head} [${s.creator}]` : head;
    })
    .join(" > ");
}

/** タグリストを .properties 形式へ（GRAPHY 互換: tag.N=GGGG,EEEE > ...。creator は {..} 併記）。 */
export function serializeTagList(paths: TagPath[]): string {
  const lines: string[] = ["# GRAPHY-Next TagExtractor tag list"];
  paths.forEach((p, i) => {
    const segs = p.segments
      .map((s) => (s.creator ? `${ggggeeee(s.tag)}{${s.creator}}` : ggggeeee(s.tag)))
      .join(" > ");
    lines.push(`tag.${i}=${segs}`);
  });
  return lines.join("\n") + "\n";
}

/** .properties テキストからタグリストを復元。 */
export function parseTagList(text: string, dict: Map<string, TagDictEntry>): TagPath[] {
  const out: { idx: number; path: TagPath }[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^tag\.(\d+)\s*=\s*(.+)$/.exec(line);
    if (!m) continue;
    const idx = Number(m[1]);
    const segments: TagPathSegment[] = [];
    for (const part of m[2].split(">")) {
      const seg = part.trim();
      if (!seg) continue;
      const cm = /^([0-9A-Fa-f]{4},[0-9A-Fa-f]{4})(?:\{(.+)\})?$/.exec(seg);
      if (!cm) continue;
      const hex = normHex(cm[1]);
      if (!hex) continue;
      segments.push({ tag: hex, creator: cm[2] || undefined });
    }
    if (segments.length > 0) {
      out.push({ idx, path: { segments, label: pathLabel(dict, segments) } });
    }
  }
  out.sort((a, b) => a.idx - b.idx);
  return out.map((o) => o.path);
}

/** dict 配列 → tag→entry の Map。 */
export function dictMap(entries: TagDictEntry[]): Map<string, TagDictEntry> {
  const m = new Map<string, TagDictEntry>();
  for (const e of entries) m.set(e.tag, e);
  return m;
}
