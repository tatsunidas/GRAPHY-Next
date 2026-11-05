/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { DEFAULT_AXES, type SeriesLayout } from "./seriesLayout";

/**
 * **一時シリーズ**（プラグインが計算して `host.openTransientSeries` で開く値の画像）の仮想レイアウト。
 *
 * マップ（ADC・cDWI・μdiff など）を **C 次元**に並べる。Z は参照シリーズと 1:1 で、幾何は作り直さない
 * （参照線・向きマーカー・座標同期が元のシリーズと一致する）。`concat`（連結タイル）と同じく、
 * backend からレイアウトを取らずに通常のタイルへ載せるための純関数。
 */
export interface TransientMapStack {
  /** マップ名（C スライダーに出す）。 */
  name: string;
  /** z 昇順の合成 imageId。全マップで同じ長さ。 */
  imageIds: string[];
}

/** 参照シリーズの Z ごとの幾何（取れる範囲で。無ければ null）。 */
export interface TransientGeometry {
  ippAt?: (z: number) => [number, number, number] | null;
  normal?: [number, number, number] | null;
}

export function buildTransientLayout(maps: TransientMapStack[], geometry: TransientGeometry = {}): SeriesLayout {
  if (maps.length === 0) throw new Error("transient series needs at least one map");
  const nZ = maps[0].imageIds.length;
  if (nZ <= 0) throw new Error("transient series needs at least one slice");
  for (const m of maps) {
    // 黙って合わせない。合わせた結果は「別のスライスの絵」になり、見て気付けない。
    if (m.imageIds.length !== nZ) {
      throw new Error(`map "${m.name}" has ${m.imageIds.length} slices, expected ${nZ}`);
    }
  }
  return {
    nZ,
    nC: maps.length,
    nT: 1,
    cDimension: "Map",
    tDimension: null,
    cLabels: maps.map((m) => m.name),
    zStack: (c) => maps[Math.min(maps.length - 1, Math.max(0, c))].imageIds,
    axes: { z: { ...DEFAULT_AXES.z }, c: { label: "Map", kind: "generic", dim: "Map" }, t: { ...DEFAULT_AXES.t } },
    stackAxis: "z",
    ippAt: geometry.ippAt,
    normal: geometry.normal ?? null,
  };
}
