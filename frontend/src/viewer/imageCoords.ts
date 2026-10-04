/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * world（患者 mm）⇔ 画像画素座標の変換。**Cornerstone の `utilities.worldToImageCoords` /
 * `imageToWorldCoords` の代わりに必ずこちらを使う。**
 *
 * <h3>なぜ自前で持つのか（Cornerstone 3.33 の取り違え）</h3>
 * 上流の 2 関数は、行方向（`rowCosines` ＝ 列 index が増える向き＝x）の距離を
 * `rowPixelSpacing` で割っている。ところがローダは `rowPixelSpacing = PixelSpacing[0]`
 * （**行と行の間隔＝縦**）、`columnPixelSpacing = PixelSpacing[1]`（**列と列の間隔＝横**）を入れる。
 * 描画（vtkImageData の spacing）は `columnPixelSpacing` を x に使うので正しく、
 * **変換だけが縦横を入れ替える**。等方画素では差が出ないので気づきにくい。
 *
 * <p>実害（2026-10-01 に計測ハーネス GNBP-1M-MR で発覚。画素 0.9 × 0.6 mm）:
 * 18 × 18 mm の正方形に Length を引くと **12.04 mm（横）/ 27.08 mm（縦）**。
 * ROI 統計も同じ変換で頂点を画素へ戻すので、**ROI 内の画素の選び方そのものがずれる**。
 *
 * <h3>規約</h3>
 * 上流と同じ「画素の左上隅が 0」の連続座標（画素 i の中心が i + 0.5）を返す。
 * 等方画素では上流と**同じ値**になるので、呼び出し側の他の前提は変わらない。
 */
import { cache, metaData } from "@cornerstonejs/core";

type V3 = [number, number, number];

/** 変換に要る平面の情報（imagePlaneModule の該当フィールド）。 */
export interface PlaneGeometry {
  imagePositionPatient: ArrayLike<number>;
  /** IOP の前 3 要素: 列 index が増える向き（x）。 */
  rowCosines: ArrayLike<number>;
  /** IOP の後ろ 3 要素: 行 index が増える向き（y）。 */
  columnCosines: ArrayLike<number>;
  /** 行と行の間隔（縦, PixelSpacing[0]）。 */
  rowPixelSpacing?: number | null;
  /** 列と列の間隔（横, PixelSpacing[1]）。 */
  columnPixelSpacing?: number | null;
}

function sp(v: number | null | undefined): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 1;
}

/** world → [x(列), y(行)]。純関数。 */
export function worldToImageOnPlane(p: PlaneGeometry, world: ArrayLike<number>): [number, number] {
  const o = p.imagePositionPatient, r = p.rowCosines, c = p.columnCosines;
  const dx = sp(p.columnPixelSpacing); // x 方向の画素間隔
  const dy = sp(p.rowPixelSpacing); // y 方向の画素間隔
  // 画素 (0,0) の左上隅
  const ox = o[0] - r[0] * (dx / 2) - c[0] * (dy / 2);
  const oy = o[1] - r[1] * (dx / 2) - c[1] * (dy / 2);
  const oz = o[2] - r[2] * (dx / 2) - c[2] * (dy / 2);
  const d0 = world[0] - ox, d1 = world[1] - oy, d2 = world[2] - oz;
  return [(d0 * r[0] + d1 * r[1] + d2 * r[2]) / dx, (d0 * c[0] + d1 * c[1] + d2 * c[2]) / dy];
}

/** [x(列), y(行)] → world。{@link worldToImageOnPlane} の逆。純関数。 */
export function imageToWorldOnPlane(p: PlaneGeometry, ic: ArrayLike<number>): V3 {
  const o = p.imagePositionPatient, r = p.rowCosines, c = p.columnCosines;
  const dx = sp(p.columnPixelSpacing);
  const dy = sp(p.rowPixelSpacing);
  const a = dx * (ic[0] - 0.5), b = dy * (ic[1] - 0.5);
  return [o[0] + r[0] * a + c[0] * b, o[1] + r[1] * a + c[1] * b, o[2] + r[2] * a + c[2] * b];
}

function planeOf(imageId: string): PlaneGeometry {
  const m = metaData.get("imagePlaneModule", imageId) as Partial<PlaneGeometry> | undefined;
  if (!m) throw new Error(`No imagePlaneModule found for imageId: ${imageId}`);
  // 🚨 幾何（IPP/IOP）が無いときは上流と同じく **NaN を返す**（既定値で埋めない）。
  // 呼び出し側（roiPointsPx など）は NaN を見て「幾何なし」の換算へ落ちる。ここで
  // [0,0,0] などを入れると、その換算より半画素ずれた値が「成功」として返ってしまう。
  const nan = [Number.NaN, Number.NaN, Number.NaN];
  return {
    imagePositionPatient: m.imagePositionPatient ?? nan,
    rowCosines: m.rowCosines ?? nan,
    columnCosines: m.columnCosines ?? nan,
    rowPixelSpacing: m.rowPixelSpacing ?? null,
    columnPixelSpacing: m.columnPixelSpacing ?? null,
  };
}

/** `utilities.worldToImageCoords` の置き換え（同じ引数・同じ規約、縦横の取り違えなし）。 */
export function worldToImageCoords(imageId: string, world: ArrayLike<number>): [number, number] {
  return worldToImageOnPlane(planeOf(imageId), world);
}

/** `utilities.imageToWorldCoords` の置き換え。 */
export function imageToWorldCoords(imageId: string, ic: ArrayLike<number>): V3 {
  return imageToWorldOnPlane(planeOf(imageId), ic);
}

/**
 * **world の基準の間隔**（行＝縦, 列＝横）。幾何（IPP/IOP）の無い画像で world を画素へ戻すとき（world ＝ 画素 × この間隔）に使う。
 *
 * <p>world は「画像オブジェクトが作られたときの間隔」で決まる。読み込みの後で校正した（カテーテル・定規）ときは
 * imagePlaneModule には校正値が入るが、画像は作り直されないので world は前の間隔のまま。**imagePlaneModule の値で割らない**
 * （割ると画素の位置が 1/mmPerPx 倍に膨らむ。fw/viewer-2d-architecture.md「画素間隔の縦横と…」）。
 * 画像が無ければ imagePlaneModule（作られるときに入る値）、それも無ければ 1。
 */
export function worldSpacingOf(imageId: string): { row: number; col: number } {
  let img: { rowPixelSpacing?: number | null; columnPixelSpacing?: number | null } | undefined;
  try {
    img = cache.getImage(imageId) as typeof img;
  } catch {
    img = undefined; // テストの差し替えなど cache が無い環境
  }
  const pos = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 1);
  if (img) return { row: pos(img.rowPixelSpacing), col: pos(img.columnPixelSpacing) };
  const m = metaData.get("imagePlaneModule", imageId) as { rowPixelSpacing?: number; columnPixelSpacing?: number } | undefined;
  return { row: pos(m?.rowPixelSpacing), col: pos(m?.columnPixelSpacing) };
}
