/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// シリーズ選択の窓（`host.db.pickSeries`）の選択ロジック（純関数）。React にも通信にも触れない。
import type { Series } from "../api";

/** プラグインに返す 1 件。**UID だけ**（患者名・記述などは渡さない）。 */
export interface PickedSeries {
  studyUid: string;
  seriesUid: string;
}

export type CheckState = "all" | "some" | "none";

/** 選択の鍵。UID はピリオドと数字だけなので `|` で区切って衝突しない。 */
export const pickKey = (studyUid: string, seriesUid: string): string => `${studyUid}|${seriesUid}`;

/** 選べるシリーズの種類の制限。`allowed` が空（制限なし）なら全部選べる。種類が分からないシリーズは、制限があるとき選べない。 */
export function isEligible(s: Pick<Series, "modality">, allowed: readonly string[]): boolean {
  if (allowed.length === 0) return true;
  return s.modality != null && allowed.includes(s.modality.toUpperCase());
}

/** スタディの三状態。選べるシリーズが 1 つも無ければ none（チェックできない）。 */
export function studyState(
  studyUid: string,
  series: readonly Series[],
  selected: ReadonlySet<string>,
  allowed: readonly string[],
): CheckState {
  const eligible = series.filter((s) => isEligible(s, allowed));
  if (eligible.length === 0) return "none";
  const n = eligible.filter((s) => selected.has(pickKey(studyUid, s.seriesInstanceUid))).length;
  return n === 0 ? "none" : n === eligible.length ? "all" : "some";
}

/**
 * スタディのチェックを押したときの新しい選択。全部選べていれば外し、そうでなければ選べるものを全部足す。
 * `multiple: false` のときは 1 件だけ（そのスタディの最初の選べるシリーズ）に置き換える。
 */
export function toggleStudy(
  studyUid: string,
  series: readonly Series[],
  selected: ReadonlySet<string>,
  allowed: readonly string[],
  multiple: boolean,
): Set<string> {
  const eligible = series.filter((s) => isEligible(s, allowed)).map((s) => pickKey(studyUid, s.seriesInstanceUid));
  if (eligible.length === 0) return new Set(selected);
  if (!multiple) return new Set(selected.has(eligible[0]) ? [] : [eligible[0]]);
  const next = new Set(selected);
  if (studyState(studyUid, series, selected, allowed) === "all") eligible.forEach((k) => next.delete(k));
  else eligible.forEach((k) => next.add(k));
  return next;
}

/** シリーズ 1 つのチェック。制限外は動かさない。`multiple: false` は 1 件に置き換える。 */
export function toggleSeries(
  studyUid: string,
  s: Series,
  selected: ReadonlySet<string>,
  allowed: readonly string[],
  multiple: boolean,
): Set<string> {
  if (!isEligible(s, allowed)) return new Set(selected);
  const k = pickKey(studyUid, s.seriesInstanceUid);
  if (!multiple) return new Set(selected.has(k) ? [] : [k]);
  const next = new Set(selected);
  if (next.has(k)) next.delete(k);
  else next.add(k);
  return next;
}

/** 選択（選んだ順）をプラグインへ返す形にする。キーは `studyUid`・`seriesUid` だけ。 */
export function toResult(selected: ReadonlySet<string>): PickedSeries[] {
  return [...selected].map((k) => {
    const i = k.indexOf("|");
    return { studyUid: k.slice(0, i), seriesUid: k.slice(i + 1) };
  });
}

const MAX_TITLE = 120;
const MODALITY = /^[A-Z]{1,16}$/;

/** プラグインから来た値を整える。タイトルは長さを切り、種類は英大文字だけを残す（画面に出す・絞り込みに使う値なので）。 */
export function normalizeOptions(opts: { title?: unknown; modalities?: unknown; multiple?: unknown } | undefined): {
  title: string;
  modalities: string[];
  multiple: boolean;
} {
  const title = typeof opts?.title === "string" ? opts.title.trim().slice(0, MAX_TITLE) : "";
  const mods = Array.isArray(opts?.modalities)
    ? [...new Set((opts?.modalities as unknown[]).filter((m): m is string => typeof m === "string").map((m) => m.trim().toUpperCase()).filter((m) => MODALITY.test(m)))]
    : [];
  return { title, modalities: mods, multiple: opts?.multiple !== false };
}
