/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * Curved MPR 用のボリューム構築。DICOM 実 IPP/IOP から患者座標系(LPS mm) の 3D ボリュームを作る
 * （≒ GRAPHY `VolumeLoader.loadVolumeData`）。値は実ピクセル（未 prescale のみ rescale→HU。
 * getPixelData が既に HU を返す設定での二重適用＝空気値化を防ぐ）。
 *
 * <p>等間隔のシリーズは従来どおり（origin = 法線ソート先頭の IPP、dirK = IPP 進行方向、spacing_z = IPP 間隔）。
 * 欠損・不等間隔は、MPR・3D と同じ `sliceGeometry` ＋ `regularGrid`（最小間隔の等間隔格子）に載せる。
 * 全長 ÷ (枚数−1) の平均間隔で並べると、スライス k の位置が実際の IPP からずれる
 * （欠損 1 枚で最大 1.45 mm）ため。値の入れ方は MPR と同じ `interpolateToGrid`（元スライスは最寄りの
 * 格子点にそのまま、それ以外は前後の元スライスの線形補間）で、規則を二重に持たない。
 */
import { imageLoader, metaData, cache } from "@cornerstonejs/core";
import type { ResliceVolume, Vec3 } from "../viewer/reslice";
import { SliceDuplicatesError, interpolateToGrid, volumeDepthNote, type VolumeDepthNote } from "../viewer/depthVolume";
import { regularGrid, sliceGeometry } from "../viewer/sliceGeometry";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObj = Record<string, any>;

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = (a: Vec3): Vec3 => {
  const n = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / n, a[1] / n, a[2] / n];
};

export interface CurvedMprVolume {
  volume: ResliceVolume;
  /** 格子に取り直したとき（欠損・不等間隔）の注記。何も無ければ null。 */
  depthNote: VolumeDepthNote | null;
}

/**
 * @returns 幾何が足りない・読めないときは null。
 * @throws {@link SliceDuplicatesError} 同じ位置に重なるスライスがあるとき（MPR と同じ扱い）
 */
export async function buildDicomResliceVolume(imageIds: string[]): Promise<CurvedMprVolume | null> {
  try {
    await Promise.all(imageIds.map((id) => imageLoader.loadAndCacheImage(id).catch(() => null)));
    const plane0: AnyObj = metaData.get("imagePlaneModule", imageIds[0]) ?? {};
    const iopRaw = plane0.imageOrientationPatient;
    if (!Array.isArray(iopRaw) || iopRaw.length < 6) return null;
    const iop = iopRaw.map(Number);
    const rowCos: Vec3 = [iop[0], iop[1], iop[2]];
    const colCos: Vec3 = [iop[3], iop[4], iop[5]];
    const normal = normalize(cross(rowCos, colCos));
    const cols = Number(plane0.columns);
    const rows = Number(plane0.rows);
    if (!cols || !rows) return null;
    const ps = plane0.pixelSpacing ?? [1, 1];
    const psY = Number(ps[0]) || 1;
    const psX = Number(ps[1]) || 1;

    const recs: Array<{ id: string; ipp: Vec3 }> = [];
    for (const id of imageIds) {
      const p: AnyObj = metaData.get("imagePlaneModule", id) ?? {};
      const ipp = p.imagePositionPatient;
      if (!Array.isArray(ipp) || ipp.length < 3) continue;
      recs.push({ id, ipp: [Number(ipp[0]), Number(ipp[1]), Number(ipp[2])] });
    }
    if (recs.length < 2) return null;
    recs.sort((a, b) => dot(a.ipp, normal) - dot(b.ipp, normal));

    // 画素を読めたスライスだけを使う（読めなかった枚数は飛ばす。従来どおり）。
    const sliceLen = cols * rows;
    const slices: Array<{ ipp: Vec3; id: string; pixels: Int16Array }> = [];
    for (const r of recs) {
      const plane: AnyObj = metaData.get("imagePlaneModule", r.id) ?? {};
      if (Number(plane.columns || cols) !== cols || Number(plane.rows || rows) !== rows) continue;
      const img = cache.getImage(r.id) as AnyObj | undefined;
      if (!img?.getPixelData) continue;
      const px = img.getPixelData() as ArrayLike<number>;
      if (!px || px.length < sliceLen) continue;
      const preScaled = !!(img.preScale && img.preScale.scaled);
      const lut: AnyObj = metaData.get("modalityLutModule", r.id) ?? {};
      const slope = preScaled ? 1 : Number((lut.rescaleSlope ?? img.slope) ?? 1);
      const intercept = preScaled ? 0 : Number((lut.rescaleIntercept ?? img.intercept) ?? 0);
      const v = new Int16Array(sliceLen);
      for (let i = 0; i < sliceLen; i++) v[i] = Math.round(px[i] * slope + intercept);
      slices.push({ ipp: r.ipp, id: r.id, pixels: v });
    }
    if (slices.length < 2) return null;

    const D = slices.length;
    const origin = slices[0].ipp;
    const spanVec = sub(slices[D - 1].ipp, origin);
    const span = Math.hypot(spanVec[0], spanVec[1], spanVec[2]);
    const dirK: Vec3 = span > 1e-6 ? normalize(spanVec) : normal;
    const direction = [rowCos[0], rowCos[1], rowCos[2], colCos[0], colCos[1], colCos[2], dirK[0], dirK[1], dirK[2]];

    const geometry = sliceGeometry(slices.map((s) => ({ id: s.id, ipp: s.ipp, iop })));
    if (geometry.kind === "duplicates") throw new SliceDuplicatesError();

    let layers: Int16Array[] = slices.map((s) => s.pixels);
    let sliceSpacing = span / (D - 1) || Number(plane0.sliceThickness) || 1;
    let depthNote: VolumeDepthNote | null = null;
    if (geometry.kind === "missing" || geometry.kind === "irregular") {
      const grid = regularGrid(geometry);
      const { data } = interpolateToGrid(geometry.order.map((i) => slices[i].pixels), geometry.order.map((_, i) => geometry.positions[i]), grid, sliceLen);
      layers = Array.from({ length: grid.count }, (_, k) => {
        const l = new Int16Array(sliceLen);
        for (let i = 0; i < sliceLen; i++) l[i] = Math.round(data[k * sliceLen + i]);
        return l;
      });
      // 格子の間隔は法線方向の距離。層は IPP の進行方向（dirK）に並ぶので、チルトで dirK が法線と傾くぶん割り戻す。
      sliceSpacing = grid.spacing / Math.max(1e-3, Math.abs(dot(dirK, normal)));
      depthNote = volumeDepthNote(geometry, grid);
    }

    const out = new Int16Array(sliceLen * layers.length);
    let min = Infinity;
    layers.forEach((l, k) => {
      out.set(l, k * sliceLen);
      for (let i = 0; i < sliceLen; i++) if (l[i] < min) min = l[i];
    });
    if (!Number.isFinite(min)) min = 0;
    return {
      volume: { data: out, dimensions: [cols, rows, layers.length], spacing: [psX, psY, sliceSpacing], origin, direction, airValue: min },
      depthNote,
    };
  } catch (e) {
    if (e instanceof SliceDuplicatesError) throw e;
    return null;
  }
}
