/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// タグビューアの編集モードの中身（画面から切り離した純粋な計算）。
import type { TagDumpRow } from "../api";
import type { TagEdit } from "./tagEditApi";
import { lockReason, parseTagNumber, valueError } from "./tagEditRules";

/** 既存の行への変更（値を変える／消す）。 */
export interface Draft {
  value?: string;
  remove?: boolean;
}

/** 「＋タグを追加」の行。tag はキーワードか (gggg,eeee)、vr はプライベートタグのときだけ要る。 */
export interface AddedRow {
  key: number;
  tag: string;
  vr: string;
  value: string;
}

/** 行の鍵: 既存は `r<行番号>`、追加は `a<key>`。 */
export const rowKey = (i: number) => `r${i}`;
export const addedKey = (a: AddedRow) => `a${a.key}`;

/** 既存の行が編集できない理由（null なら編集できる）。 */
export function rowLock(r: TagDumpRow): string | null {
  const n = parseTagNumber(r.tag);
  if (n < 0) return "structure";
  return lockReason(n, r.vr, r.depth);
}

/** 表示の振り分け・並びに効くタグ（確認で注記する）: Modality・SeriesNumber・InstanceNumber。 */
const ROUTING = new Set([0x00080060, 0x00200011, 0x00200013]);

export function affectsRouting(tag: string): boolean {
  const n = parseTagNumber(tag);
  return n >= 0 && ROUTING.has(n);
}

export interface Built {
  edits: TagEdit[];
  /** edits[i] がどの行か（サーバーの理由を行へ戻す）。 */
  keys: string[];
  /** 画面で分かる違反（行の鍵 → 理由）。1 つでもあれば保存できない。 */
  problems: Record<string, string>;
}

/** 下書きから送る編集を作る。値が元と同じ行は送らない。 */
export function buildEdits(rows: TagDumpRow[], drafts: Record<string, Draft>, added: AddedRow[]): Built {
  const edits: TagEdit[] = [];
  const keys: string[] = [];
  const problems: Record<string, string> = {};
  rows.forEach((r, i) => {
    const k = rowKey(i);
    const d = drafts[k];
    if (!d || rowLock(r)) return;
    if (d.remove) {
      edits.push({ tag: r.tag, vr: r.vr, op: "remove", before: r.value });
      keys.push(k);
      return;
    }
    if (d.value === undefined || d.value === r.value) return;
    const err = valueError(r.vr, d.value);
    if (err) problems[k] = err;
    edits.push({ tag: r.tag, vr: r.vr, op: "set", before: r.value, value: d.value });
    keys.push(k);
  });
  for (const a of added) {
    const tag = a.tag.trim();
    if (!tag) continue;
    const k = addedKey(a);
    const vr = a.vr.trim().toUpperCase();
    const n = parseTagNumber(tag);
    // キーワードや VR 未指定の標準タグは、ここでは VR が分からない。確認（preview）でサーバーが検査する
    if (n >= 0 && vr) {
      const lock = lockReason(n, vr);
      if (lock) problems[k] = lock;
    }
    if (!problems[k] && vr) {
      const err = valueError(vr, a.value);
      if (err) problems[k] = err;
    }
    edits.push({ tag, vr: vr || undefined, op: "set", before: "", value: a.value });
    keys.push(k);
  }
  return { edits, keys, problems };
}
