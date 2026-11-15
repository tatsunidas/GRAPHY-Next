/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * DICOM SEG の Pixel Measures（SliceThickness・SpacingBetweenSlices）の値を、source シリーズから決める。純関数。
 *
 * <p>DICOM の定義: SliceThickness (0018,0050) は**公称のスライス厚**、SpacingBetweenSlices (0018,0088) は隣接スライスの
 * **中心間の距離**（Pixel Measures Macro では任意）。各フレームの位置は PlanePositionSequence の IPP が正本。
 * 以前は「先頭 2 枚の IPP 間距離」を両方に書いていたため、不等間隔・欠損のシリーズで全体の代表にならない値が書かれ、
 * 厚みと間隔が違う一様なシリーズでも厚みに間隔が入っていた。
 *
 * <p>間隔が一様でなければ SpacingBetweenSlices は書かない（0）。「1 つの間隔」が存在しないので、省略するのが正しい。
 */

export interface SegSliceMeasures {
  /** 公称のスライス厚 [mm]（> 0）。 */
  sliceThickness: number;
  /** 一様なときの中心間距離 [mm]。一様でなければ 0（書かない）。 */
  spacingBetweenSlices: number;
}

type V3 = readonly [number, number, number];

const median = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * @param ipps      source の各スライスの IPP（取れないスライスは undefined）
 * @param iop       ImageOrientationPatient（6 要素）。スライスの並び順（法線方向）を決める
 * @param nominalThickness source の SliceThickness（無ければ null）
 */
export function segSliceMeasures(
  ipps: ReadonlyArray<V3 | undefined>,
  iop: ReadonlyArray<number> | undefined,
  nominalThickness: number | null | undefined,
): SegSliceMeasures {
  const pts = ipps.filter((p): p is V3 => !!p && p.every((n) => Number.isFinite(n)));
  let gaps: number[] = [];
  if (pts.length >= 2) {
    // 法線方向の位置で並べ替える（逆順・順不同の系列でも隣接するスライス同士を結ぶ）。
    let order = pts;
    if (iop && iop.length >= 6) {
      const n = [
        iop[1] * iop[5] - iop[2] * iop[4],
        iop[2] * iop[3] - iop[0] * iop[5],
        iop[0] * iop[4] - iop[1] * iop[3],
      ];
      const pos = (p: V3) => p[0] * n[0] + p[1] * n[1] + p[2] * n[2];
      order = [...pts].sort((a, b) => pos(a) - pos(b));
    }
    for (let i = 1; i < order.length; i++) {
      const a = order[i - 1], b = order[i];
      gaps.push(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]));
    }
    gaps = gaps.filter((g) => g > 0);
  }
  const thicknessOk = typeof nominalThickness === "number" && Number.isFinite(nominalThickness) && nominalThickness > 0;
  const sliceThickness = thicknessOk ? (nominalThickness as number) : gaps.length ? median(gaps) : 1;
  if (!gaps.length) return { sliceThickness, spacingBetweenSlices: 0 };
  const mean = gaps.reduce((s, g) => s + g, 0) / gaps.length;
  // 一様か: 間隔の最大と最小の差が、IPP の DS 丸め（0.01 mm）と公称間隔の 1% の大きい方以内（slice-depth-policy と同じ許容）。
  const tol = Math.max(0.01, 0.01 * mean);
  const uniform = Math.max(...gaps) - Math.min(...gaps) <= tol;
  return { sliceThickness, spacingBetweenSlices: uniform ? mean : 0 };
}
