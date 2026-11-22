/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 特徴量の族 × 計算の単位（3D・2D）の規則。どの族がどの単位で計算されるかを 1 か所に置く（画面の無効化・注記が参照する）。
 *
 * 実際の計算（RadiomicsJ）の挙動に合わせてある: 形態（Morphology）と GLAM は体積の量なので 2D の単位では計算せず、
 * Shape2D は 1 枚の画像の量なので 3D の単位では計算しない（RadiomicsJ は多断面の体積で黙って計算しない）。
 * 実アプリの検査（automator の planes2dCheck）が、2D の結果の族がこの表と一致することを確かめる。
 */
export interface FamilyUnits {
  in3d: boolean;
  in2d: boolean;
}

const BOTH: FamilyUnits = { in3d: true, in2d: true };

/** 表に無い族は両方（テクスチャ・強度の族）。 */
export const FAMILY_UNITS: Readonly<Record<string, FamilyUnits>> = {
  Morphology: { in3d: true, in2d: false },
  GLAM: { in3d: true, in2d: false },
  Shape2D: { in3d: false, in2d: true },
};

export function familyUnits(family: string): FamilyUnits {
  return FAMILY_UNITS[family] ?? BOTH;
}
