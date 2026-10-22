/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import type { SeriesCondition, TagDictEntry, TagPathSegment } from "../api";
import { ggggeeee } from "./tagPathUtil";

// SeriesExtractor の条件まわりの純ロジック（画面から切り離してテストする）。

const NUMERIC_VR = new Set(["DS", "IS", "FL", "FD", "SL", "SS", "UL", "US"]);
const DATE_VR = new Set(["DA"]);
const DATETIME_VR = new Set(["DA", "DT", "TM"]);

export const isNumericVr = (vr: string) => NUMERIC_VR.has((vr || "").toUpperCase());
export const isDateVr = (vr: string) => DATE_VR.has((vr || "").toUpperCase());
export const isDateTimeVr = (vr: string) => DATETIME_VR.has((vr || "").toUpperCase());

/** 数値・日時は大小比較、それ以外（文字）は一致の種類を選べる。 */
export function opsForVr(vr: string): string[] {
  if (isNumericVr(vr) || isDateTimeVr(vr)) return ["EQUALS", "GT", "LT", "GE", "LE", "RANGE"];
  return ["EQUALS", "CONTAINS", "STARTS_WITH", "ENDS_WITH"];
}

/** VR を変えたあとに、新しい VR で使えない演算子が残らないようにする。 */
export function coerceOp(op: string, vr: string): string {
  const ops = opsForVr(vr);
  return ops.includes(op) ? op : ops[0];
}

/** セグメント列の同一判定キー。Private は creator も含める（同じ番号でも creator が違えば別経路）。 */
export function pathKey(segments: TagPathSegment[]): string {
  return segments.map((s) => `${(s.tag || "").toUpperCase()}{${s.creator ?? ""}}`).join(">");
}

export function hasPath(conditions: SeriesCondition[], segments: TagPathSegment[]): boolean {
  const k = pathKey(segments);
  return conditions.some((c) => pathKey(c.segments) === k);
}

/** 単独タグ（SQ を経由しない）として使用済みの tag（辞書一覧から隠す対象）。 */
export function usedSingleTags(conditions: SeriesCondition[]): Set<string> {
  const out = new Set<string>();
  for (const c of conditions) {
    if (c.segments.length === 1 && !c.segments[0].creator) out.add(c.segments[0].tag.toUpperCase());
  }
  return out;
}

/** 検索語の正規化: 区切り（, ( ) 空白）を除き小文字化。タグ番号（0018,0050 / 00180050）も名前も同じ欄で引く。 */
function norm(s: string): string {
  return (s || "").toLowerCase().replace(/[\s,()]/g, "");
}

/** 辞書を検索語で絞り、使用済みの単独タグを除く。 */
export function visibleDict(dict: TagDictEntry[], query: string, used: Set<string>): TagDictEntry[] {
  const q = norm(query);
  return dict.filter((e) => {
    if (used.has(e.tag.toUpperCase())) return false;
    if (!q) return true;
    return norm(e.keyword).includes(q) || norm(e.tag).includes(q) || norm(ggggeeee(e.tag)).includes(q);
  });
}

/** DA の "YYYYMMDD" ⇄ <input type=date> の "YYYY-MM-DD"。 */
export const daToInput = (v: string) => (/^\d{8}$/.test(v) ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}` : "");
export const inputToDa = (v: string) => v.replace(/-/g, "");

/** 数値入力欄に許す文字（数字・小数点・符号・指数）だけ残す。 */
export const keepNumeric = (v: string) => v.replace(/[^0-9.+\-eE]/g, "");

/** 1 条件の入力エラー（問題なければ null）。値の欠け・数値でない・範囲の上下逆を検出する。 */
export function conditionError(c: SeriesCondition): string | null {
  if (c.value1.trim() === "") return "value";
  if (isNumericVr(c.vr)) {
    if (Number.isNaN(Number(c.value1))) return "number";
    if (c.op === "RANGE") {
      if (c.value2.trim() === "" || Number.isNaN(Number(c.value2))) return "number";
      if (Number(c.value1) > Number(c.value2)) return "order";
    }
  } else if (isDateTimeVr(c.vr) && c.op === "RANGE") {
    if (c.value2.trim() === "") return "value";
    if (c.value1 > c.value2) return "order";
  }
  return null;
}

/**
 * 検証・実行ボタンを押してよいか。全条件の入力が正しければよい。
 * 条件も断面も無いときは「全シリーズ」を対象にする（データシートで全体を一覧するのに使う）。
 */
export function canRun(conditions: SeriesCondition[]): boolean {
  return conditions.every((c) => conditionError(c) === null);
}
