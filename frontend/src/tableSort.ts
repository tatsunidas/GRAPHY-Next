/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// テーブルの列ソート共通ロジック。スタディリスト表・QR 表など複数テーブルで共有する。
//
// - 数値列は数値として自然に（"10" が "2" の後）昇順/降順。
// - 文字列列も数字混在を自然順で（例 "PT2" < "PT10"）。ロケール考慮・大小無視。
// - 空/NULL は方向に関わらず常に末尾へ寄せる。
// - 並びは安定ソート（同値は元の順序を維持）。元配列は破壊しない。

import { useState } from "react";

export type SortDir = "asc" | "desc";
export interface SortState {
  key: string;
  dir: SortDir;
}

export type Accessor<T> = (row: T) => string | number | null | undefined;

function isEmpty(v: unknown): boolean {
  return v == null || v === "";
}

/** 自然順比較（空でない値同士のみを想定。空判定は applySort 側で行う）。 */
export function naturalCompare(a: unknown, b: unknown): number {
  if (isEmpty(a) && isEmpty(b)) return 0;
  if (isEmpty(a)) return 1;
  if (isEmpty(b)) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
}

/** ヘッダクリックで 未ソート→昇順→降順→未ソート を巡回する sort 状態フック。 */
export function useTableSort(initial: SortState | null = null) {
  const [sort, setSort] = useState<SortState | null>(initial);
  const toggleSort = (key: string) =>
    setSort((prev) =>
      !prev || prev.key !== key
        ? { key, dir: "asc" }
        : prev.dir === "asc"
          ? { key, dir: "desc" }
          : null,
    );
  return { sort, setSort, toggleSort };
}

/** sort 状態と accessors に従いソートした新配列を返す（元配列は不変・安定・空は常に末尾）。 */
export function applySort<T>(
  rows: T[],
  sort: SortState | null,
  accessors: Record<string, Accessor<T>>,
): T[] {
  if (!sort) return rows;
  const acc = accessors[sort.key];
  if (!acc) return rows;
  const sign = sort.dir === "asc" ? 1 : -1;
  return [...rows].sort((x, y) => {
    const av = acc(x);
    const bv = acc(y);
    if (isEmpty(av) && isEmpty(bv)) return 0;
    if (isEmpty(av)) return 1; // 空は方向に関わらず末尾
    if (isEmpty(bv)) return -1;
    return sign * naturalCompare(av, bv);
  });
}

/** 見出しに付けるソート方向マーカー（昇順 ▲ / 降順 ▼ / 無印）。 */
export function sortIndicator(sort: SortState | null, key: string): string {
  if (!sort || sort.key !== key) return "";
  return sort.dir === "asc" ? " ▲" : " ▼";
}
