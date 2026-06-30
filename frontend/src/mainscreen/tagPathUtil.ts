/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import type { SeriesCondition, TagDictEntry, TagPath, TagPathSegment } from "../api";

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

/** セグメント列 → "GGGG,EEEE{creator} > ..." 文字列。 */
function segEncode(segments: TagPathSegment[]): string {
  return segments
    .map((s) => (s.creator ? `${ggggeeee(s.tag)}{${s.creator}}` : ggggeeee(s.tag)))
    .join(" > ");
}
/** "GGGG,EEEE{creator} > ..." → セグメント列。 */
function segDecode(str: string): TagPathSegment[] {
  const out: TagPathSegment[] = [];
  for (const part of str.split(">")) {
    const seg = part.trim();
    if (!seg) continue;
    const cm = /^([0-9A-Fa-f]{4},[0-9A-Fa-f]{4})(?:\{(.+)\})?$/.exec(seg);
    if (!cm) continue;
    const hex = normHex(cm[1]);
    if (!hex) continue;
    out.push({ tag: hex, creator: cm[2] || undefined });
  }
  return out;
}

/** SeriesExtractor 条件＋平面を .properties 形式へ。 */
export function serializeConditions(conditions: SeriesCondition[], planes: string[]): string {
  const lines: string[] = ["# GRAPHY-Next SeriesExtractor conditions"];
  if (planes.length > 0) lines.push(`plane=${planes.join(",")}`);
  conditions.forEach((c, i) => {
    lines.push(`condition.${i}.path=${segEncode(c.segments)}`);
    lines.push(`condition.${i}.vr=${c.vr}`);
    lines.push(`condition.${i}.exclude=${c.exclude}`);
    lines.push(`condition.${i}.op=${c.op}`);
    lines.push(`condition.${i}.v1=${c.value1}`);
    lines.push(`condition.${i}.v2=${c.value2}`);
  });
  return lines.join("\n") + "\n";
}

/** .properties から SeriesExtractor 条件＋平面を復元。 */
export function parseConditions(text: string): { conditions: SeriesCondition[]; planes: string[] } {
  const byIdx = new Map<number, Partial<SeriesCondition>>();
  let planes: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1);
    if (key === "plane") {
      planes = val.split(",").map((s) => s.trim()).filter(Boolean);
      continue;
    }
    const m = /^condition\.(\d+)\.(path|vr|exclude|op|v1|v2)$/.exec(key);
    if (!m) continue;
    const idx = Number(m[1]);
    const c = byIdx.get(idx) ?? {};
    switch (m[2]) {
      case "path": c.segments = segDecode(val); break;
      case "vr": c.vr = val.trim(); break;
      case "exclude": c.exclude = val.trim() === "true"; break;
      case "op": c.op = val.trim(); break;
      case "v1": c.value1 = val; break;
      case "v2": c.value2 = val; break;
    }
    byIdx.set(idx, c);
  }
  const conditions: SeriesCondition[] = [...byIdx.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, c]) => ({
      segments: c.segments ?? [],
      vr: c.vr ?? "",
      exclude: c.exclude ?? false,
      op: c.op ?? "EQUALS",
      value1: c.value1 ?? "",
      value2: c.value2 ?? "",
    }))
    .filter((c) => c.segments.length > 0);
  return { conditions, planes };
}
