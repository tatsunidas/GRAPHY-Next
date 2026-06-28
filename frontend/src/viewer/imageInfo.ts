import { metaData, imageLoader, utilities as csUtils, type Types } from "@cornerstonejs/core";
import dicomImageLoader from "@cornerstonejs/dicom-image-loader";

/**
 * 表示中スライスのキャリブレーション情報（輝度=Modality LUT / ボクセル / FOV）。
 * 値は Cornerstone の metaData プロバイダ（standalone は wadouri が dicom-parser で解析）から取得。
 */
export interface ImageInfo {
  modality?: string;
  rows?: number;
  columns?: number;
  /** 行間隔(縦/Y, mm) = PixelSpacing[0] */
  rowPixelSpacing?: number;
  /** 列間隔(横/X, mm) = PixelSpacing[1] */
  columnPixelSpacing?: number;
  sliceThickness?: number;
  /** スライス方向のボクセル奥行(mm)。算出は computeSliceSpacing 参照。 */
  sliceSpacing?: number;
  /** sliceSpacing の導出元。 */
  sliceSpacingSource?: SliceSpacingSource;
  /** FOV = columns × columnPixelSpacing（横, mm） */
  fovWidthMm?: number;
  /** FOV = rows × rowPixelSpacing（縦, mm） */
  fovHeightMm?: number;
  rescaleSlope?: number;
  rescaleIntercept?: number;
  windowCenter?: number;
  windowWidth?: number;
  bitsAllocated?: number;
  bitsStored?: number;
  /** 0=符号なし, 1=符号あり(2の補数) */
  pixelRepresentation?: number;
  photometricInterpretation?: string;
  /** ImageOrientationPatient(IOP) が存在するか（向きマーカー表示の可否） */
  hasOrientation?: boolean;
}

function firstNumber(v: unknown): number | undefined {
  if (Array.isArray(v)) return typeof v[0] === "number" ? v[0] : undefined;
  return typeof v === "number" ? v : undefined;
}

/** imageId から表示・キャリブレーション情報を集約する。 */
export function readImageInfo(imageId: string): ImageInfo {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const series: any = metaData.get("generalSeriesModule", imageId) ?? {};
  const plane: any = metaData.get("imagePlaneModule", imageId) ?? {};
  const pixel: any = metaData.get("imagePixelModule", imageId) ?? {};
  const voi: any = metaData.get("voiLutModule", imageId) ?? {};
  const modalityLut: any = metaData.get("modalityLutModule", imageId) ?? {};
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const rows: number | undefined = plane.rows ?? pixel.rows;
  const columns: number | undefined = plane.columns ?? pixel.columns;
  const rowPixelSpacing: number | undefined = plane.rowPixelSpacing ?? undefined;
  const columnPixelSpacing: number | undefined = plane.columnPixelSpacing ?? undefined;

  return {
    modality: series.modality,
    rows,
    columns,
    rowPixelSpacing,
    columnPixelSpacing,
    sliceThickness: plane.sliceThickness ?? undefined,
    fovWidthMm: columns && columnPixelSpacing ? columns * columnPixelSpacing : undefined,
    fovHeightMm: rows && rowPixelSpacing ? rows * rowPixelSpacing : undefined,
    rescaleSlope: modalityLut.rescaleSlope ?? undefined,
    rescaleIntercept: modalityLut.rescaleIntercept ?? undefined,
    windowCenter: firstNumber(voi.windowCenter),
    windowWidth: firstNumber(voi.windowWidth),
    bitsAllocated: pixel.bitsAllocated,
    bitsStored: pixel.bitsStored,
    pixelRepresentation: pixel.pixelRepresentation,
    photometricInterpretation: pixel.photometricInterpretation,
    hasOrientation: Array.isArray(plane.imageOrientationPatient) && plane.imageOrientationPatient.length >= 6,
  };
}

/** スライス方向ボクセル奥行きの導出元。 */
export type SliceSpacingSource = "iop-ipp" | "spacingBetweenSlices" | "sliceThickness" | "default";

function vsub(a: number[], b: number[]): number[] {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function vcross(a: number[], b: number[]): number[] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function vdot(a: number[], b: number[]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function toNums(a: unknown): number[] | undefined {
  if (!Array.isArray(a) || a.length < 3) return undefined;
  const n = a.slice(0, 3).map((v) => Number(v));
  return n.every((v) => Number.isFinite(v)) ? n : undefined;
}

/** wadouri のキャッシュ済データセットから SpacingBetweenSlices(0018,0088) を読む。 */
function spacingBetweenSlicesOf(imageId: string): number | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wadouri = (dicomImageLoader as any).wadouri;
    const { url } = wadouri.parseImageId(imageId);
    const ds = wadouri.dataSetCacheManager.get(url);
    const v = ds?.floatString?.("x00180088");
    return typeof v === "number" && v > 0 ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * スライス方向のボクセル奥行き(mm)を求める。
 *
 * <ul>
 *   <li>スライス 1 枚: SpacingBetweenSlices（優先）＞ SliceThickness ＞ 1mm。</li>
 *   <li>2 枚以上: 隣接 2 スライスの IOP/IPP から面間距離を計算。
 *       IOP/IPP が無ければ SpacingBetweenSlices ＞ SliceThickness ＞ 1mm にフォールバック。</li>
 * </ul>
 */
export async function computeSliceSpacing(
  displayedImageId: string,
  seriesImageIds: string[] | undefined,
  sliceThickness: number | undefined,
): Promise<{ spacing: number; source: SliceSpacingSource }> {
  const fallback = (): { spacing: number; source: SliceSpacingSource } => {
    const sbs = spacingBetweenSlicesOf(displayedImageId);
    if (sbs !== undefined) return { spacing: sbs, source: "spacingBetweenSlices" };
    if (sliceThickness && sliceThickness > 0) return { spacing: sliceThickness, source: "sliceThickness" };
    return { spacing: 1, source: "default" };
  };

  if (!seriesImageIds || seriesImageIds.length <= 1) {
    return fallback();
  }

  try {
    const id0 = seriesImageIds[0];
    const id1 = seriesImageIds[1];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plane = (id: string): any => metaData.get("imagePlaneModule", id);
    if (!plane(id1)?.imagePositionPatient) {
      await imageLoader.loadAndCacheImage(id1); // 隣接スライスのメタを揃える
    }
    const p0 = plane(id0);
    const p1 = plane(id1);
    const ipp0 = toNums(p0?.imagePositionPatient);
    const ipp1 = toNums(p1?.imagePositionPatient);
    const rowCos = toNums(p0?.rowCosines);
    const colCos = toNums(p0?.columnCosines);
    if (ipp0 && ipp1 && rowCos && colCos) {
      const normal = vcross(rowCos, colCos);
      const dist = Math.abs(vdot(vsub(ipp1, ipp0), normal)); // 面の法線方向に投影した距離
      if (Number.isFinite(dist) && dist > 1e-4) {
        return { spacing: dist, source: "iop-ipp" };
      }
    }
  } catch {
    /* フォールバックへ */
  }
  return fallback();
}

/** カーソル位置のサンプル値。 */
export interface PixelSample {
  /** 画像内インデックス(列, 行) 整数（表示用） */
  i: number;
  j: number;
  /** 画像(OffScreen)座標 連続値（サブピクセル, 小数表示用） */
  fx: number;
  fy: number;
  /** カラー画像か */
  color: boolean;
  /** カラー時の RGB（0–255 など格納値そのまま） */
  rgb?: [number, number, number];
  /** グレースケール時の格納値（生ピクセル値。符号付/符号なし・8/16bit いずれも typed array が正しい型） */
  stored?: number;
  /** グレースケール時のモダリティ値（CT なら HU）。Rescale 適用後。 */
  modalityValue?: number;
}

/**
 * canvas 座標のピクセル値を取り出す。範囲外は null。
 *
 * <p>scalarData は Cornerstone が信号の符号・ビット深度に応じた typed array
 * （Uint8/Int8/Uint16/Int16/Float32）で保持するため、<b>グレースケールは符号付/符号なし・
 * 8/16bit いずれもそのまま読めば正しい</b>。コンポーネント数で grayscale/color を分岐する。
 * グレースケールは GPU 側 Modality LUT のため scalarData は「格納値」。preScale 済みなら
 * モダリティ値なので二重適用しない。
 */
export function sampleAtCanvas(
  viewport: Types.IStackViewport,
  canvas: [number, number],
  info: ImageInfo,
): PixelSample | null {
  try {
    const world = viewport.canvasToWorld(canvas);
    // getImageData の戻りは版差があるため any で受ける（scalarData/getScalarData/preScale）。
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const imgData = viewport.getImageData() as any;
    if (!imgData) return null;
    // world→index(連続)。整数は最近傍格子点、連続は OffScreen 座標として保持。
    const cont = csUtils.transformWorldToIndexContinuous(imgData.imageData, world);
    const fx = cont[0];
    const fy = cont[1];
    const i = Math.round(fx);
    const j = Math.round(fy);
    const cols = info.columns ?? imgData.dimensions?.[0] ?? 0;
    const rows = info.rows ?? imgData.dimensions?.[1] ?? 0;
    if (i < 0 || j < 0 || i >= cols || j >= rows) return null;

    const scalarData = imgData.getScalarData ? imgData.getScalarData() : imgData.scalarData;
    if (!scalarData || !cols || !rows) return null;

    // コンポーネント数（grayscale=1, RGB=3, RGBA=4）を scalarData 長から推定。
    const comps = Math.max(1, Math.round(scalarData.length / (cols * rows)));
    const pixelOffset = j * cols + i;

    if (comps >= 3) {
      const o = pixelOffset * comps;
      const rgb: [number, number, number] = [scalarData[o], scalarData[o + 1], scalarData[o + 2]];
      if (rgb.some((v) => v === undefined || Number.isNaN(v))) return null;
      return { i, j, fx, fy, color: true, rgb };
    }

    const stored = scalarData[pixelOffset];
    if (stored === undefined || Number.isNaN(stored)) return null;
    const alreadyScaled = Boolean(imgData.preScale?.scaled);
    const slope = info.rescaleSlope ?? 1;
    const intercept = info.rescaleIntercept ?? 0;
    const modalityValue = alreadyScaled ? stored : stored * slope + intercept;
    return { i, j, fx, fy, color: false, stored, modalityValue };
  } catch {
    return null;
  }
}
