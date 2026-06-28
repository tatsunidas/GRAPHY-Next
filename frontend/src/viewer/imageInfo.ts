import { metaData, utilities as csUtils, type Types } from "@cornerstonejs/core";

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
  };
}

/** カーソル位置のサンプル値。 */
export interface PixelSample {
  /** 画像内インデックス(列, 行) */
  i: number;
  j: number;
  /** 格納値（生のピクセル値） */
  stored: number;
  /** モダリティ値（CT なら HU）。Rescale 適用後。 */
  modalityValue: number;
}

/**
 * canvas 座標のピクセル値を取り出す。範囲外は null。
 *
 * <p>StackViewport の scalarData は通常「格納値」（GPU 側で Modality LUT を適用）。
 * preScale 済みならそのままモダリティ値なので二重適用しない。
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
    // vtkImageData。world→index(連続)を丸めて格子点に。
    const cont = csUtils.transformWorldToIndex(imgData.imageData, world);
    const i = Math.round(cont[0]);
    const j = Math.round(cont[1]);
    const cols = info.columns ?? imgData.dimensions?.[0] ?? 0;
    const rows = info.rows ?? imgData.dimensions?.[1] ?? 0;
    if (i < 0 || j < 0 || i >= cols || j >= rows) return null;

    const scalarData = imgData.getScalarData ? imgData.getScalarData() : imgData.scalarData;
    if (!scalarData) return null;
    const stored = scalarData[j * cols + i];
    if (stored === undefined || Number.isNaN(stored)) return null;

    const alreadyScaled = Boolean(imgData.preScale?.scaled);
    const slope = info.rescaleSlope ?? 1;
    const intercept = info.rescaleIntercept ?? 0;
    const modalityValue = alreadyScaled ? stored : stored * slope + intercept;
    return { i, j, stored, modalityValue };
  } catch {
    return null;
  }
}
