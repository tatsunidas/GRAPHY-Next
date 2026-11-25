/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * ROI マネージャの見出し（患者・シリーズ・グループ）の折りたたみ状態。
 *
 * ROI の一覧と Measurements の一覧は同じ見出しの鍵（`p:<患者>` など）を持つ。折りたたみの鍵を共有していたため、
 * Measurements 側で展開すると ROI 側も展開されていた。鍵に一覧の種別を前置して、一覧ごとに独立させる。
 */
export type FoldList = "roi" | "meas";

/** 一覧の種別つきの、折りたたみの鍵。 */
export const foldKey = (list: FoldList, sec: string): string => `${list}|${sec}`;

/** 鍵の入れ替え（開いていれば閉じ、閉じていれば開く）。元の集合は変えない。 */
export function toggleFold(folded: ReadonlySet<string>, key: string): ReadonlySet<string> {
  const next = new Set(folded);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

export const isFolded = (folded: ReadonlySet<string>, list: FoldList, sec: string): boolean =>
  folded.has(foldKey(list, sec));
