/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * プラグイン host API のリサンプル（H21 の後半）。
 *
 * <p>**cornerstone に依存しない層**にしてある（`regCore` / `regGeometry` と同じ方針）。
 * ブラウザ無しでテストできることが、幾何の正しさを守る唯一の現実的な方法である
 * （`fw/cornerstone-3d-geometry-caveat.md`）。
 */
import { sampleWorld, type RegVolume } from "../viewer/regGeometry";
import type { WorldTransform } from "../viewer/regTransform";
import type { PluginVolume, PluginVolumeGrid } from "./pluginTypes";

/** プラグインが持つ形 → 本体の {@link RegVolume}（データはコピーしない）。 */
export function toRegVolume(v: PluginVolume | PluginVolumeGrid, data?: Float32Array): RegVolume {
  return {
    data: data ?? (v as PluginVolume).data,
    dims: [v.dims[0], v.dims[1], v.dims[2]],
    indexToWorld: Float64Array.from(v.indexToWorld),
    worldToIndex: Float64Array.from(v.worldToIndex),
    spacing: [v.spacing[0], v.spacing[1], v.spacing[2]],
  };
}

/**
 * 位置合わせの結果を使って、`source` を `target` の格子へリサンプルする。
 *
 * <p>変換の向きは本体と同じ **fixed(target) world → moving(source) world**（pull-back）。
 * 範囲外は `NaN`（**0 で埋めない**。0 は CT では実在の値で、「視野の外」と区別が付かなくなる）。
 */
export function resamplePluginVolume(
  source: PluginVolume,
  transform: unknown,
  target: PluginVolumeGrid,
): PluginVolume {
  const src = toRegVolume(source);
  const t = (transform ?? null) as WorldTransform | null;
  const [nx, ny, nz] = target.dims;
  const out = new Float32Array(nx * ny * nz);
  const m = Float64Array.from(target.indexToWorld);
  const p: [number, number, number] = [0, 0, 0];
  let o = 0;
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const x = m[0] * i + m[1] * j + m[2] * k + m[3];
        const y = m[4] * i + m[5] * j + m[6] * k + m[7];
        const z = m[8] * i + m[9] * j + m[10] * k + m[11];
        if (t) {
          t.mapPoint(x, y, z, p);
          out[o++] = sampleWorld(src, p[0], p[1], p[2]);
        } else {
          out[o++] = sampleWorld(src, x, y, z);
        }
      }
    }
  }
  return {
    ...source,
    data: out,
    dims: [nx, ny, nz],
    spacing: [target.spacing[0], target.spacing[1], target.spacing[2]],
    indexToWorld: [...target.indexToWorld],
    worldToIndex: [...target.worldToIndex],
    ipp: [m[3], m[7], m[11]],
  };
}


