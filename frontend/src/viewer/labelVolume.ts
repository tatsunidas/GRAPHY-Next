/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 3D ROI の**確定計算層**（`fw/3d-viewer-design.md` §8.1）。
 *
 * Cornerstone の segmentation labelmap は per-slice の 2D スタック（`getLabelmapImageIds`）で、
 * 各スライスの幾何（IPP/IOP/PixelSpacing）は参照 source から解決できる。ここでは**全スライスを走査して
 * 密な実空間 `vtkImageData`（origin=IPP0・direction=IOP 由来 3×3・spacing=[colSp,rowSp,sliceSp]）**に組み立てる。
 * これが 3D ROI のマスク本体（メッシュ化・ボクセル化・体積計測の入力）となる。
 *
 * ⚠️ 座標系（要件 11）: 頂点/世界座標は全て**患者 LPS mm**。`vtkImageData` の direction にIOPを載せるが、
 * `vtkImageMarchingCubes` は direction を無視して `origin + index*spacing` で頂点を出す（`roiMesh.ts` で後段補正）。
 * ここでは幾何を正しく保持し、voxel↔world 変換を提供する（`voxelToWorld`/`worldToVoxel`）。
 */
import { cache, metaData } from "@cornerstonejs/core";
import { segmentation as csSeg } from "@cornerstonejs/tools";
import vtkImageData from "@kitware/vtk.js/Common/DataModel/ImageData";
import vtkDataArray from "@kitware/vtk.js/Common/Core/DataArray";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
type V3 = [number, number, number];

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const len = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
const norm = (a: V3): V3 => {
  const n = len(a) || 1;
  return [a[0] / n, a[1] / n, a[2] / n];
};

/** 実空間ボリューム幾何（患者 LPS mm）。 */
export interface VolumeGeom {
  /** [nx(=cols), ny(=rows), nz(=slices)] */
  dims: [number, number, number];
  /** [sx(col), sy(row), sz(slice)] mm */
  spacing: [number, number, number];
  /** voxel(0,0,0) の world（= 先頭スライス IPP） */
  origin: [number, number, number];
  /** vtk row-major 3×3。列 = 各 index 軸の単位方向（col0=x, col1=y, col2=z）。 */
  direction: number[];
}

/** 密な実空間 labelmap（3D ROI マスク本体）。 */
export interface LabelVolume {
  geom: VolumeGeom;
  /** 長さ nx*ny*nz。0=背景, >0=前景（segment index）。 */
  data: Uint8Array;
  /** 1 ボクセルの体積 mm³ = sx*sy*sz。 */
  voxelMm3: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function img(id: string): any {
  return cache.getImage(id);
}

interface Plane {
  ipp: V3;
  rows: number;
  cols: number;
  rowSp: number; // rowPixelSpacing（行間隔＝縦, columnCosines 方向）
  colSp: number; // columnPixelSpacing（列間隔＝横, rowCosines 方向）
  rowCos: V3; // 列 index 増加方向（x, 横）
  colCos: V3; // 行 index 増加方向（y, 縦）
}

/** imagePlaneModule から平面幾何を取得。 */
function planeOf(imageId: string): Plane | null {
  const m = metaData.get("imagePlaneModule", imageId) as Any;
  if (!m || !m.imagePositionPatient || !m.rowCosines || !m.columnCosines) return null;
  return {
    ipp: m.imagePositionPatient as V3,
    rows: (m.rows ?? 0) as number,
    cols: (m.columns ?? 0) as number,
    rowSp: (m.rowPixelSpacing || 1) as number,
    colSp: (m.columnPixelSpacing || 1) as number,
    rowCos: m.rowCosines as V3,
    colCos: m.columnCosines as V3,
  };
}

/**
 * segmentation の per-slice labelmap から幾何を解決する（データは読まない）。
 * labelmapIds の順序をそのまま z 軸順とみなす（segExport/roi3d と同一規約）。
 */
function resolveGeom(labelmapIds: string[]): {
  geom: VolumeGeom;
  planes: (Plane | null)[];
  ippByZ: (V3 | null)[];
} | null {
  const sourceIds = labelmapIds.map((id) => img(id)?.referencedImageId as string | undefined);
  const planes = sourceIds.map((s) => (s ? planeOf(s) : null));
  const p0 = planes.find(Boolean) as Plane | undefined;
  if (!p0 || !p0.rows || !p0.cols) return null;

  const rowCos = norm(p0.rowCos);
  const colCos = norm(p0.colCos);
  const normal = norm(cross(rowCos, colCos));

  // 各 z の IPP。
  const ippByZ: (V3 | null)[] = planes.map((p) =>
    p ? [Number(p.ipp[0]), Number(p.ipp[1]), Number(p.ipp[2])] : null,
  );

  const nz = labelmapIds.length;
  // z 軸方向・間隔: 最初と最後の有効 IPP から（reverse order もそのまま扱える）。
  let zDir: V3 = normal;
  let sliceSp = 1;
  const firstIdx = ippByZ.findIndex(Boolean);
  let lastIdx = -1;
  for (let z = nz - 1; z >= 0; z--) if (ippByZ[z]) { lastIdx = z; break; }
  if (firstIdx >= 0 && lastIdx > firstIdx) {
    const v = sub(ippByZ[lastIdx] as V3, ippByZ[firstIdx] as V3);
    const total = len(v);
    if (total > 1e-6) {
      zDir = norm(v);
      sliceSp = total / (lastIdx - firstIdx);
    }
  } else {
    // 単一スライス等: sliceThickness を試し、無ければ 1。
    const src = sourceIds.find(Boolean);
    const m = src ? (metaData.get("imagePlaneModule", src) as Any) : null;
    sliceSp = Number(m?.sliceThickness) || 1;
  }

  const origin: V3 = (firstIdx >= 0 ? (ippByZ[firstIdx] as V3) : [0, 0, 0]).slice() as V3;
  const geom: VolumeGeom = {
    dims: [p0.cols, p0.rows, nz],
    spacing: [p0.colSp, p0.rowSp, sliceSp],
    origin,
    // 列: x=rowCos, y=colCos, z=zDir（vtk row-major）。
    direction: [
      rowCos[0], colCos[0], zDir[0],
      rowCos[1], colCos[1], zDir[1],
      rowCos[2], colCos[2], zDir[2],
    ],
  };
  return { geom, planes, ippByZ };
}

/**
 * Cornerstone segmentation → 密な実空間 LabelVolume。
 * `segmentIndex` 指定時はその値のみ前景、未指定は全非ゼロを前景（値 1）にする。
 * 幾何/labelmap が解決できなければ null。
 */
export function buildLabelVolumeFromSegmentation(
  segmentationId: string,
  segmentIndex?: number,
): LabelVolume | null {
  let labelmapIds: string[];
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    labelmapIds = (csSeg as any).getLabelmapImageIds(segmentationId) as string[];
  } catch {
    return null;
  }
  if (!labelmapIds?.length) return null;

  const resolved = resolveGeom(labelmapIds);
  if (!resolved) return null;
  const { geom } = resolved;
  const [nx, ny, nz] = geom.dims;
  const frame = nx * ny;
  const data = new Uint8Array(frame * nz);

  let any = false;
  for (let z = 0; z < nz; z++) {
    const vm = img(labelmapIds[z])?.voxelManager;
    if (!vm) continue;
    const base = z * frame;
    let scalar: ArrayLike<number> | undefined;
    try {
      scalar = vm.getScalarData?.() as ArrayLike<number> | undefined;
    } catch {
      scalar = undefined;
    }
    if (scalar && scalar.length >= frame) {
      for (let i = 0; i < frame; i++) {
        const v = scalar[i];
        if (segmentIndex != null ? v === segmentIndex : v > 0) {
          data[base + i] = 1;
          any = true;
        }
      }
    } else {
      for (let i = 0; i < frame; i++) {
        const v = vm.getAtIndex(i);
        if (segmentIndex != null ? v === segmentIndex : v > 0) {
          data[base + i] = 1;
          any = true;
        }
      }
    }
  }
  if (!any) return null;

  const [sx, sy, sz] = geom.spacing;
  return { geom, data, voxelMm3: sx * sy * sz };
}

/** LabelVolume（または任意 geom+data）から vtkImageData を組み立てる。 */
export function labelVolumeToImageData(lv: LabelVolume): Any {
  return imageDataFromGeom(lv.geom, lv.data);
}

/** geom + scalar 配列 から vtkImageData を作る（direction 付き）。 */
export function imageDataFromGeom(geom: VolumeGeom, data: ArrayLike<number>): Any {
  const id: Any = vtkImageData.newInstance();
  id.setDimensions(geom.dims[0], geom.dims[1], geom.dims[2]);
  id.setSpacing(geom.spacing[0], geom.spacing[1], geom.spacing[2]);
  id.setOrigin(geom.origin[0], geom.origin[1], geom.origin[2]);
  if (geom.direction && geom.direction.length === 9) {
    id.setDirection(Float32Array.from(geom.direction));
  }
  const scalars = vtkDataArray.newInstance({
    numberOfComponents: 1,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    values: data as any,
  });
  id.getPointData().setScalars(scalars);
  return id;
}

/** 同一幾何の空 LabelVolume（メッシュ→ROI ボクセル化の出力先）。 */
export function emptyLabelVolume(geom: VolumeGeom): LabelVolume {
  const [nx, ny, nz] = geom.dims;
  const [sx, sy, sz] = geom.spacing;
  return {
    geom,
    data: new Uint8Array(nx * ny * nz),
    voxelMm3: sx * sy * sz,
  };
}

/** vtkImageData の幾何を VolumeGeom に読み出す（表示 volume から ROI 幾何を得る等）。 */
export function geomFromImageData(imageData: Any): VolumeGeom | null {
  try {
    const dims = imageData.getDimensions() as number[];
    const spacing = imageData.getSpacing() as number[];
    const origin = imageData.getOrigin() as number[];
    let direction = imageData.getDirection() as number[] | undefined;
    if (!dims || dims.length < 3) return null;
    if (!direction || direction.length !== 9) direction = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    return {
      dims: [dims[0], dims[1], dims[2]],
      spacing: [spacing[0], spacing[1], spacing[2]],
      origin: [origin[0], origin[1], origin[2]],
      direction: Array.from(direction),
    };
  } catch {
    return null;
  }
}

/** voxel index (i,j,k, 連続値可) → world mm。 */
export function voxelToWorld(geom: VolumeGeom, i: number, j: number, k: number): V3 {
  const { origin: o, spacing: s, direction: d } = geom;
  const lx = i * s[0];
  const ly = j * s[1];
  const lz = k * s[2];
  return [
    o[0] + d[0] * lx + d[1] * ly + d[2] * lz,
    o[1] + d[3] * lx + d[4] * ly + d[5] * lz,
    o[2] + d[6] * lx + d[7] * ly + d[8] * lz,
  ];
}

/** world mm → voxel index (連続値, 丸めなし)。direction は正規直交前提（転置＝逆）。 */
export function worldToVoxel(geom: VolumeGeom, w: V3): V3 {
  const { origin: o, spacing: s, direction: d } = geom;
  const dx = w[0] - o[0];
  const dy = w[1] - o[1];
  const dz = w[2] - o[2];
  // local = R^T · (w - origin)。R^T 行 b = R 列 b = 軸方向 b。
  const l0 = d[0] * dx + d[3] * dy + d[6] * dz;
  const l1 = d[1] * dx + d[4] * dy + d[7] * dz;
  const l2 = d[2] * dx + d[5] * dy + d[8] * dz;
  return [l0 / (s[0] || 1), l1 / (s[1] || 1), l2 / (s[2] || 1)];
}

/** 前景ボクセル数。 */
export function countForeground(lv: LabelVolume): number {
  let n = 0;
  const d = lv.data;
  for (let i = 0; i < d.length; i++) if (d[i] > 0) n++;
  return n;
}
