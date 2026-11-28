/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * ハンギングプロトコルの「適用」と「元に戻す」の、画面に依存しない部分。
 *
 * <p>照合と並び順は {@link ./hangingProtocol} が決める。ここは (a) 2D ビューアに開けるシリーズに絞って並びを解決する、
 * (b) 置き換える前の配置を 1 世代だけ写して戻す、(c) 適用してよい状態かを判定する、の 3 つ。**純関数だけ**。
 */
import { classifySeriesRenderability } from "../viewer/seriesRenderable";
import { arrange, matchProtocol, type HangingProtocol, type SeriesLike, type StudyLike } from "./hangingProtocol";

export type HangingPlanSeries = SeriesLike & { sopClassUid?: string | null };

export type HangingPlan<S> =
  | {
      ok: true;
      /** 配列の順がそのまま行優先のセルの順。 */
      series: S[];
      rows: number;
      cols: number;
      unfilledSlots: number[];
      nonImageCount: number;
    }
  | { ok: false; reason: "no-series" | "no-match"; nonImageCount: number };

/**
 * 適用の結果を、画面を変える前に求める。画像として開けないシリーズは**並べる前に**候補から外す
 * （後で外すと、説明の合う非画像が「先頭」の枠を取り、そのスロットが空になる）。
 * 手動の適用でも、規則の `match` は守る。
 */
export function planHanging<S extends HangingPlanSeries>(
  protocol: HangingProtocol,
  study: StudyLike,
  seriesList: readonly S[],
  opts: { portrait: boolean },
): HangingPlan<S> {
  const images = seriesList.filter(
    (s) => classifySeriesRenderability({ sopClassUid: s.sopClassUid ?? null, modality: s.modality ?? null }).renderable,
  );
  const nonImageCount = seriesList.length - images.length;
  const a = arrange(protocol, images, opts);
  if (a.seriesUids.length === 0) return { ok: false, reason: "no-series", nonImageCount };
  if (!matchProtocol([protocol], study, images)) return { ok: false, reason: "no-match", nonImageCount };
  const byUid = new Map(images.map((s) => [s.seriesInstanceUid, s] as const));
  return {
    ok: true,
    series: a.seriesUids.map((uid) => byUid.get(uid) as S),
    rows: a.rows,
    cols: a.cols,
    unfilledSlots: a.unfilledSlots,
    nonImageCount,
  };
}

/**
 * 適用してよい状態か。全患者の表示に複数の患者が並んでいるときは、どの患者の配置を置き換えるのかが画面から分からないので断る。
 */
export function canApplyHanging(isGlobal: boolean, patientCount: number): boolean {
  if (patientCount < 1) return false;
  return !isGlobal || patientCount === 1;
}

export interface HangingTile {
  id: string;
  /** プラグインの一時タイル。閉じると計算結果が失われ、作り直せない。 */
  transient?: unknown;
}

export interface HangingPatient<T extends HangingTile> {
  patientKey: string;
  tiles: T[];
  gridRows: number;
  gridCols: number;
  soloTileId?: string | null;
}

export interface HangingGlobalView {
  order: string[];
  grid: { rows: number; cols: number; solo: string | null };
}

export interface HangingSnapshot<T extends HangingTile> {
  patientKey: string;
  tiles: T[];
  gridRows: number;
  gridCols: number;
  soloTileId: string | null;
  global: HangingGlobalView;
}

/** 置き換える前の配置を写す。一時タイルは置き換えで後始末されるので含めない。 */
export function takeSnapshot<T extends HangingTile>(patient: HangingPatient<T>, global: HangingGlobalView): HangingSnapshot<T> {
  const tiles = patient.tiles.filter((t) => !t.transient);
  const solo = patient.soloTileId ?? null;
  return {
    patientKey: patient.patientKey,
    tiles,
    gridRows: patient.gridRows,
    gridCols: patient.gridCols,
    soloTileId: solo !== null && tiles.some((t) => t.id === solo) ? solo : null,
    global: { order: [...global.order], grid: { ...global.grid } },
  };
}

/** 写した配置に戻す。適用の後に開いた一時タイルは閉じずに末尾へ残す。 */
export function restoreSnapshot<T extends HangingTile, P extends HangingPatient<T>>(patient: P, snap: HangingSnapshot<T>): P {
  const later = patient.tiles.filter((t) => t.transient && !snap.tiles.some((s) => s.id === t.id));
  return {
    ...patient,
    tiles: [...snap.tiles, ...later],
    gridRows: snap.gridRows,
    gridCols: snap.gridCols,
    soloTileId: snap.soloTileId,
  };
}

/** 全患者の表示順で、置き換えた患者のタイルを新しい並びにする（他の患者のタイルの順は変えない）。 */
export function orderAfterApply(order: readonly string[], replacedIds: readonly string[], nextIds: readonly string[]): string[] {
  const drop = new Set([...replacedIds, ...nextIds]);
  return [...order.filter((id) => !drop.has(id)), ...nextIds];
}
