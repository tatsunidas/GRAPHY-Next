/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * DICOM SEG のフレームを、表示中シリーズのどのスライスに載せるか決める（純関数）。
 *
 * <p>位置が合わないフレームは**黙って載せない**。以前は、参照 SOP が表示中シリーズにあればフレームの IPP を見ずに
 * 画素配列をそのまま書いたため、面内にずれた格子の SEG が元の位置から外れて入り、参照 SOP が表示中シリーズに無い
 * （別シリーズの）フレームは IPP が 5 mm 以内なら採用していた。
 */

export type Vec3 = readonly [number, number, number];

export type SegFramePlacement =
  | { z: number }
  | { reject: "otherSeries" | "positionMismatch" | "noPosition" };

/**
 * IPP の一致の許容 [mm]。IPP は DS 値（16 文字）で丸められるので 0.01 mm を下限に、画素間隔の 5% を上限の目安にする
 * （丸め誤差は吸収し、1 画素以上のずれ（100%）は確実に弾く）。画素間隔が取れなければ 0.01 mm。
 */
export function ippToleranceMm(rowSpacing: number | null | undefined, colSpacing: number | null | undefined): number {
  const pos = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
  const r = pos(rowSpacing), c = pos(colSpacing);
  const minSp = r !== null && c !== null ? Math.min(r, c) : (r ?? c);
  return Math.max(0.01, minSp !== null ? minSp * 0.05 : 0);
}

const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/**
 * @param referencedSop フレームの参照 SOP Instance UID（DerivationImageSequence。無ければ null）
 * @param frameIpp      フレームの IPP（PlanePositionSequence。無ければ null）
 * @param sopToZ        表示中シリーズの SOP → スライス index
 * @param ippOfZ        スライス index → そのスライスの IPP（取れなければ null。XA など幾何の無い画像）
 * @param count         スライス数
 * @param tolMm         IPP の一致の許容（{@link ippToleranceMm}）
 * @param strict        true: SEG の取り込み（上のとおり厳密に）。false: 保存済みマスクの復元（従来の寛容な対応づけ:
 *                      SOP が一致すれば IPP は見ず、無ければ IPP 最近傍 {@link LENIENT_IPP_MM} 以内。シリーズを
 *                      取り込み直して SOP が変わっても IPP で復元できるようにするため）
 */
export function placeSegFrame(
  referencedSop: string | null,
  frameIpp: Vec3 | null,
  sopToZ: ReadonlyMap<string, number>,
  ippOfZ: (z: number) => Vec3 | null,
  count: number,
  tolMm: number,
  strict = true,
): SegFramePlacement {
  if (!strict) {
    const z0 = referencedSop ? sopToZ.get(referencedSop) : undefined;
    if (z0 !== undefined) return { z: z0 };
    return nearestWithin(frameIpp, ippOfZ, count, LENIENT_IPP_MM);
  }
  if (referencedSop) {
    const z = sopToZ.get(referencedSop);
    // 参照 SOP があるのに表示中シリーズに無い = 別シリーズの SEG。IPP の近さで拾わない。
    if (z === undefined) return { reject: "otherSeries" };
    const imageIpp = ippOfZ(z);
    // どちらかの IPP が無ければ（XA など）SOP だけで受理する。
    if (frameIpp && imageIpp && dist(frameIpp, imageIpp) > tolMm) return { reject: "positionMismatch" };
    return { z };
  }
  return nearestWithin(frameIpp, ippOfZ, count, tolMm);
}

/** 保存済みマスクの復元で使う、IPP 最近傍の許容 [mm]（従来値）。 */
export const LENIENT_IPP_MM = 5;

function nearestWithin(frameIpp: Vec3 | null, ippOfZ: (z: number) => Vec3 | null, count: number, tolMm: number): SegFramePlacement {
  if (!frameIpp) return { reject: "noPosition" };
  let best = -1;
  let bestDist = Infinity;
  for (let z = 0; z < count; z++) {
    const p = ippOfZ(z);
    if (!p) continue;
    const d = dist(p, frameIpp);
    if (d < bestDist) {
      bestDist = d;
      best = z;
    }
  }
  return best >= 0 && bestDist <= tolMm ? { z: best } : { reject: "noPosition" };
}

/** 拒否の集計（フレーム数）。 */
export interface SegRejectCounts {
  otherSeries: number;
  positionMismatch: number;
  noPosition: number;
  /** rows/columns が表示中シリーズと違う（フレーム数ではなく SEG 1 件につき 1）。 */
  sizeMismatch: number;
}

export const emptyRejectCounts = (): SegRejectCounts => ({ otherSeries: 0, positionMismatch: 0, noPosition: 0, sizeMismatch: 0 });

export const totalRejected = (c: SegRejectCounts): number =>
  c.otherSeries + c.positionMismatch + c.noPosition + c.sizeMismatch;
