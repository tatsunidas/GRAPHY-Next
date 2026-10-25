/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * ツールバー・メニューの操作が「どのタイルに効くか」（選択が無いとき）。
 *
 * 患者タブでは今までどおり表示中の全タイル。全患者モードでは、**全患者へ一斉には効かせない**
 * （W/L・ROI・プラグイン保存などが別の患者のタイルまで巻き込むため）。最後に触ったタイルの患者のタイルだけにする。
 */
export interface ScopeTile {
  id: string;
  patientKey: string;
}

export interface DefaultTargets {
  ids: string[];
  /** 全患者モードで患者が複数あり、最後に触ったタイルも決まらないため、対象を決められなかった。 */
  ambiguous: boolean;
}

export function defaultTargets(
  tiles: readonly ScopeTile[],
  focusedTileId: string | null | undefined,
  global: boolean,
): DefaultTargets {
  const all = tiles.map((t) => t.id);
  if (!global) return { ids: all, ambiguous: false };
  const patients = new Set(tiles.map((t) => t.patientKey));
  if (patients.size <= 1) return { ids: all, ambiguous: false };
  const focused = tiles.find((t) => t.id === focusedTileId);
  if (!focused) return { ids: [], ambiguous: true };
  return { ids: tiles.filter((t) => t.patientKey === focused.patientKey).map((t) => t.id), ambiguous: false };
}

/** 対象のタイルが複数の患者にまたがっているか（またがるなら、患者単位の保存などは実行しない）。 */
export function spansPatients(patientKeys: readonly string[]): boolean {
  return new Set(patientKeys).size > 1;
}

/** ROI を持つタイルの id。どれも持たなければ null（コピー・複製の宛先を、画像のクリックに頼らず ROI から決める）。 */
export function ownerTileOf(tileIds: readonly string[], owns: (tileId: string) => boolean): string | null {
  return tileIds.find(owns) ?? null;
}
