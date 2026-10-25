/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * スタディ一覧・シリーズ一覧に足したタグ列の設定と、セルの表示の決め方。
 *
 * <p>設定は PC・ブラウザごと（localStorage）。作りは `viewer/overlayConfig.ts` と同じ（保存すると同じウィンドウへは
 * カスタムイベント、別ウィンドウへは storage イベントで届く）。値そのものは持たない（バックエンドが
 * 表示中の行のぶんだけヘッダから読む）。DICOM ファイルにも索引にも何も書かない。
 */
import { useSyncExternalStore } from "react";
import type { ColumnCell, TagPathSegment } from "../api";

/** どの表に出すか。study=スタディ一覧、series=シリーズ一覧、both=両方。 */
export type ListColumnWhere = "study" | "series" | "both";

export interface ListColumn {
  /** 設定の中で一意。バックエンドとのやり取りの識別子にも使う。 */
  id: string;
  /** TagExtractor と同じタグの指定（シーケンスの中・プライベートも同じ）。 */
  segments: TagPathSegment[];
  /** 列の見出し。 */
  label: string;
  where: ListColumnWhere;
}

export const LIST_COLUMNS_KEY = "graphy.listColumns";
const EVENT = "graphy:listColumns";
const WHERES: ListColumnWhere[] = ["study", "series", "both"];

const isHex8 = (s: unknown): s is string => typeof s === "string" && /^[0-9A-Fa-f]{8}$/.test(s);

/** 保存値 → 列の一覧。壊れた JSON・形の違う要素は捨てる（読めない設定で一覧を壊さない）。 */
export function parseListColumns(raw: string | null | undefined): ListColumn[] {
  if (!raw) return [];
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(v)) return [];
  const out: ListColumn[] = [];
  const seen = new Set<string>();
  for (const e of v as unknown[]) {
    if (!e || typeof e !== "object") continue;
    const c = e as Record<string, unknown>;
    if (typeof c.id !== "string" || !c.id || seen.has(c.id)) continue;
    if (!Array.isArray(c.segments) || c.segments.length === 0) continue;
    const segments: TagPathSegment[] = [];
    let ok = true;
    for (const s of c.segments as unknown[]) {
      const sg = s as Record<string, unknown> | null;
      if (!sg || !isHex8(sg.tag) || (sg.creator !== undefined && sg.creator !== null && typeof sg.creator !== "string")) {
        ok = false;
        break;
      }
      segments.push(sg.creator ? { tag: sg.tag.toUpperCase(), creator: sg.creator as string } : { tag: sg.tag.toUpperCase() });
    }
    if (!ok) continue;
    const where = WHERES.includes(c.where as ListColumnWhere) ? (c.where as ListColumnWhere) : "both";
    seen.add(c.id);
    out.push({ id: c.id, segments, label: typeof c.label === "string" ? c.label : "", where });
  }
  return out;
}

export function loadListColumns(): ListColumn[] {
  try {
    return parseListColumns(localStorage.getItem(LIST_COLUMNS_KEY));
  } catch {
    return [];
  }
}

export function saveListColumns(columns: ListColumn[]): void {
  try {
    localStorage.setItem(LIST_COLUMNS_KEY, JSON.stringify(columns));
  } catch {
    /* 保存できなくても、この回の画面は更新する */
  }
  window.dispatchEvent(new Event(EVENT));
}

/** 新しい列の id（設定の中で重ならない）。 */
export function newColumnId(existing: readonly ListColumn[]): string {
  let n = existing.length + 1;
  const used = new Set(existing.map((c) => c.id));
  while (used.has(`col${n}`)) n++;
  return `col${n}`;
}

/** スタディ一覧に出す列 / シリーズ一覧に出す列。 */
export const studyColumns = (cols: readonly ListColumn[]) => cols.filter((c) => c.where !== "series");
export const seriesColumns = (cols: readonly ListColumn[]) => cols.filter((c) => c.where !== "study");

/** バックエンドへ渡す形（id とタグの指定だけ）。 */
export const toRequestColumns = (cols: readonly ListColumn[]) =>
  cols.map((c) => ({ id: c.id, segments: c.segments.map((s) => (s.creator ? { tag: s.tag, creator: s.creator } : { tag: s.tag })) }));

// --- セルの表示 ---

export type CellKind = "loading" | "value" | "empty" | "absent" | "notLocal" | "unreadable" | "notReturned";

export interface CellView {
  kind: CellKind;
  /** 画面に出す文字。 */
  text: string;
  /** 吹き出し（理由）。無ければ undefined。 */
  titleKey?: string;
}

/**
 * セル → 表示。タグが無い（—）と値が空（空欄）を区別し、読めなかったときは「—」にせず理由の印を出す。
 * cell が undefined は、まだ届いていない（…）。
 */
export function cellView(cell: ColumnCell | undefined): CellView {
  if (!cell) return { kind: "loading", text: "…" };
  switch (cell.state) {
    case "OK": {
      const text = cell.values.join(" / ");
      if (cell.incomplete) return { kind: "value", text: text ? `${text} ⚠` : "⚠", titleKey: "listCol.incomplete" };
      return text ? { kind: "value", text } : { kind: "empty", text: "" };
    }
    case "ABSENT":
      return { kind: "absent", text: "—", titleKey: "listCol.absent" };
    case "NOT_LOCAL":
      return { kind: "notLocal", text: "☁", titleKey: "listCol.notLocal" };
    case "NOT_RETURNED":
      return { kind: "notReturned", text: "⚠", titleKey: "listCol.notReturned" };
    case "UNREADABLE":
    default:
      return { kind: "unreadable", text: "⚠", titleKey: "listCol.unreadable" };
  }
}

// --- React 連携（設定変更で再描画）---

let cached: ListColumn[] = [];
let cachedRaw: string | null = null;

function getSnapshot(): ListColumn[] {
  let raw = "";
  try {
    raw = localStorage.getItem(LIST_COLUMNS_KEY) ?? "";
  } catch {
    raw = "";
  }
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cached = parseListColumns(raw);
  }
  return cached;
}

function subscribe(cb: () => void): () => void {
  const handler = () => cb();
  window.addEventListener(EVENT, handler);
  window.addEventListener("storage", handler); // 別ウィンドウの変更も拾う
  return () => {
    window.removeEventListener(EVENT, handler);
    window.removeEventListener("storage", handler);
  };
}

/** 現在の列の設定を購読する（保存で自動再描画。同じ内容の間は同じ配列を返す）。 */
export function useListColumns(): ListColumn[] {
  return useSyncExternalStore(subscribe, getSnapshot, () => []);
}
