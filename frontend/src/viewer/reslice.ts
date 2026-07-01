/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * Slicer リスライスコア（P1）。旧 GRAPHY `com.vis.core.slicer.VolumeSampler` / `Slicer` /
 * `com.vis.core.view.D2.ui.orientation.SlicePlane` の TS 移植（純関数・Cornerstone 非依存）。
 * 設計: `fw/slicer-design.md` §5。
 *
 * 役割:
 * - 患者座標系(LPS, world) で完結する 3D ボリュームに対する **トリリニアサンプリング**。
 * - **任意断面（オブリーク）平面**の定義と、その平面上の出力ピクセル → world → ボクセル座標変換。
 * - **Slab**（スライス厚・Gap・枚数）と**再構成モード**（SLICECUT/MEAN/MAX/MIN/MEDIAN/MODE）による集約。
 * - 出力スタックの **DICOM 幾何**（IOP 共通・スライス毎 IPP・PixelSpacing・SliceThickness・SpacingBetweenSlices）。
 *
 * ジオメトリ前提: `direction` は正規直交（各行が単位ベクトルかつ相互直交）の 3×3（行優先）。
 * `createLocalVolume`（純 Axial: direction=[1,0,0,0,1,0,0,0,1]）にも streaming volume の
 * `getImageData().direction` にも当てはまる（Cornerstone のボリューム軸は正規直交）。
 * データ配列は z-major フラット: index(i,j,k) = k*W*H + j*W + i。
 */

export type Vec3 = [number, number, number];

/** リスライス対象ボリューム（world 幾何で完結）。 */
export interface ResliceVolume {
  /** z-major フラット配列。長さ = W*H*D。値は格納レンジ（CT=HU 等）。 */
  data: ArrayLike<number>;
  /** [W, H, D]（ボクセル数、整数）。 */
  dimensions: Vec3;
  /** [sx, sy, sz]（mm）。i/j/k 各軸のボクセル間隔。 */
  spacing: Vec3;
  /** ボクセル(0,0,0) 中心の world 座標（mm, LPS）。 */
  origin: Vec3;
  /** 9 要素・行優先の正規直交方向余弦 [dirI(3), dirJ(3), dirK(3)]。 */
  direction: number[];
  /** FOV 外に割り当てる値（空気 HU の格納値など）。既定 0。 */
  airValue?: number;
}

/** 再構成（Slab 集約）モード。旧 `Slicer.java` の定数に対応。 */
export type ReconMode = "SLICECUT" | "MEAN" | "MAX" | "MIN" | "MEDIAN" | "MODE";

/**
 * 出力断面平面。DICOM 慣習に合わせる:
 * - `rowDir` = 列インデックス増加方向（行に沿う, IOP 第1三つ組）。
 * - `colDir` = 行インデックス増加方向（列に沿う, IOP 第2三つ組）。
 * - 法線 = rowDir × colDir。
 * - `origin` = 出力ピクセル(col=0,row=0) 中心の world 座標（＝オフセット0の基準平面の左上）。
 * ピクセル(col=c, row=r) の world = origin + rowDir*(c*colSpacing) + colDir*(r*rowSpacing)。
 */
export interface ReslicePlane {
  origin: Vec3;
  rowDir: Vec3;
  colDir: Vec3;
  /** 出力の列数（幅）。 */
  cols: number;
  /** 出力の行数（高さ）。 */
  rows: number;
  /** 隣接列間の距離（mm）＝ DICOM PixelSpacing[1]。 */
  colSpacing: number;
  /** 隣接行間の距離（mm）＝ DICOM PixelSpacing[0]。 */
  rowSpacing: number;
}

/** Slab（スライス厚・Gap・枚数・再構成モード）。 */
export interface SlabSpec {
  /** 出力スタック枚数（1 以上）。 */
  numSlices: number;
  /** 1 スライスの厚み（mm）。 */
  thickness: number;
  /** スライス間 Gap（mm）。中心間距離 = thickness + gap。 */
  gap: number;
  /** 再構成モード。 */
  mode: ReconMode;
  /** スラブ内サブサンプル間隔（mm）。既定 = ボリュームの最小 spacing。SLICECUT では無視。 */
  subSampleSpacing?: number;
}

/** 出力スタック（frames＋DICOM 幾何）。 */
export interface ResliceStack {
  /** スライス毎の出力画素（row-major, 長さ = rows*cols）。CT は Int16（HU 格納値）。 */
  frames: Int16Array[];
  rows: number;
  cols: number;
  numSlices: number;
  /** ImageOrientationPatient（6 要素、全スライス共通）= [rowDir, colDir]。 */
  imageOrientationPatient: number[];
  /** スライス毎の ImagePositionPatient（左上ピクセル中心の world 座標）。 */
  imagePositionPatient: Vec3[];
  /** DICOM PixelSpacing [rowSpacing, colSpacing]（mm）。 */
  pixelSpacing: [number, number];
  /** SliceThickness（mm）。 */
  sliceThickness: number;
  /** SpacingBetweenSlices（mm）= thickness + gap。 */
  spacingBetweenSlices: number;
}

// ── ベクトル小道具 ────────────────────────────────────────────
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const norm = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
const normalize = (a: Vec3): Vec3 => {
  const n = norm(a) || 1;
  return [a[0] / n, a[1] / n, a[2] / n];
};

/**
 * world 座標 → ボリューム値（トリリニア補間）のサンプラーを生成する。
 * 逆写像は direction が正規直交である前提で内積により解く（行列反転不要）:
 *   fi = dot(w - origin, dirI) / sx など。
 * 完全に範囲外なら airValue。境界近傍で一部近傍が範囲外の場合、その近傍は airValue で補間される
 * （旧 GRAPHY の境界=raw_min と同挙動）。
 */
export function makeWorldSampler(vol: ResliceVolume): (w: Vec3) => number {
  const [W, H, D] = vol.dimensions;
  const [sx, sy, sz] = vol.spacing;
  const d = vol.direction;
  const dirI: Vec3 = [d[0], d[1], d[2]];
  const dirJ: Vec3 = [d[3], d[4], d[5]];
  const dirK: Vec3 = [d[6], d[7], d[8]];
  const ox = vol.origin[0];
  const oy = vol.origin[1];
  const oz = vol.origin[2];
  const air = vol.airValue ?? 0;
  const data = vol.data;
  const WH = W * H;

  const at = (i: number, j: number, k: number): number => {
    if (i < 0 || i >= W || j < 0 || j >= H || k < 0 || k >= D) return air;
    return data[k * WH + j * W + i];
  };

  return (w: Vec3): number => {
    const dx = w[0] - ox;
    const dy = w[1] - oy;
    const dz = w[2] - oz;
    const fi = (dx * dirI[0] + dy * dirI[1] + dz * dirI[2]) / sx;
    const fj = (dx * dirJ[0] + dy * dirJ[1] + dz * dirJ[2]) / sy;
    const fk = (dx * dirK[0] + dy * dirK[1] + dz * dirK[2]) / sz;

    const i0 = Math.floor(fi);
    const j0 = Math.floor(fj);
    const k0 = Math.floor(fk);
    const i1 = i0 + 1;
    const j1 = j0 + 1;
    const k1 = k0 + 1;

    // 完全に外側（両端が範囲外）は air。
    if (i1 < 0 || i0 >= W || j1 < 0 || j0 >= H || k1 < 0 || k0 >= D) return air;

    const tx = fi - i0;
    const ty = fj - j0;
    const tz = fk - k0;

    const c000 = at(i0, j0, k0);
    const c100 = at(i1, j0, k0);
    const c010 = at(i0, j1, k0);
    const c110 = at(i1, j1, k0);
    const c001 = at(i0, j0, k1);
    const c101 = at(i1, j0, k1);
    const c011 = at(i0, j1, k1);
    const c111 = at(i1, j1, k1);

    const c00 = c000 * (1 - tx) + c100 * tx;
    const c10 = c010 * (1 - tx) + c110 * tx;
    const c01 = c001 * (1 - tx) + c101 * tx;
    const c11 = c011 * (1 - tx) + c111 * tx;
    const c0 = c00 * (1 - ty) + c10 * ty;
    const c1 = c01 * (1 - ty) + c11 * ty;
    return c0 * (1 - tz) + c1 * tz;
  };
}

/**
 * 中心・法線・up ベクトル・FOV から `ReslicePlane` を構築する（UI からの平面指定を正規化）。
 * 出力の `center` が画像中心（(cols-1)/2, (rows-1)/2 のピクセル）に一致するよう origin を配置する。
 *
 * 構築フレーム（右手・正規直交、法線 = rowDir × colDir = 与えた normal）:
 *   n = normalize(normal)
 *   u = normalize(up - (up·n)n)          … 平面内 up（colDir と一致）
 *   rowDir = normalize(u × n)            … 列インデックス増加方向
 *   colDir = n × rowDir (= u)            … 行インデックス増加方向
 * ゆえに row は up 方向に増える（＝表示では上下反転だが、IPP/IOP と画素バッファは自己整合するため
 * DICOM ビューアは IOP に従って正しく描画する）。
 */
export function buildReslicePlane(params: {
  center: Vec3;
  normal: Vec3;
  up: Vec3;
  fovWidth: number; // mm（rowDir 方向の視野）
  fovHeight: number; // mm（colDir 方向の視野）
  colSpacing: number; // mm/列
  rowSpacing: number; // mm/行
}): ReslicePlane {
  const n = normalize(params.normal);
  let u = sub(params.up, scale(n, dot(params.up, n)));
  if (norm(u) < 1e-8) {
    // up が法線とほぼ平行: フォールバックで別の基底を選ぶ。
    const alt: Vec3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    u = sub(alt, scale(n, dot(alt, n)));
  }
  u = normalize(u);
  const rowDir = normalize(cross(u, n));
  const colDir = cross(n, rowDir); // = u（正規直交）

  const cols = Math.max(1, Math.round(params.fovWidth / params.colSpacing));
  const rows = Math.max(1, Math.round(params.fovHeight / params.rowSpacing));

  // center が画像中心に来るよう左上(0,0)ピクセル中心へ戻す。
  const halfW = ((cols - 1) / 2) * params.colSpacing;
  const halfH = ((rows - 1) / 2) * params.rowSpacing;
  const origin: Vec3 = [
    params.center[0] - rowDir[0] * halfW - colDir[0] * halfH,
    params.center[1] - rowDir[1] * halfW - colDir[1] * halfH,
    params.center[2] - rowDir[2] * halfW - colDir[2] * halfH,
  ];

  return { origin, rowDir, colDir, cols, rows, colSpacing: params.colSpacing, rowSpacing: params.rowSpacing };
}

/** サブサンプル列 → 単一値の集約（旧 `Slicer.applyCalculateMode` 移植）。 */
function aggregate(vals: Float64Array, count: number, mode: ReconMode): number {
  if (count === 1) return vals[0];
  switch (mode) {
    case "MEAN": {
      let s = 0;
      for (let i = 0; i < count; i++) s += vals[i];
      return s / count;
    }
    case "MAX": {
      let m = vals[0];
      for (let i = 1; i < count; i++) if (vals[i] > m) m = vals[i];
      return m;
    }
    case "MIN": {
      let m = vals[0];
      for (let i = 1; i < count; i++) if (vals[i] < m) m = vals[i];
      return m;
    }
    case "MEDIAN": {
      const arr = Array.prototype.slice.call(vals, 0, count) as number[];
      arr.sort((a, b) => a - b);
      const mid = count >> 1;
      return count % 2 === 1 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
    }
    case "MODE": {
      // 連続値のため整数丸めで最頻値を数える（DICOM 格納値のセマンティクスに合わせる）。
      const counts = new Map<number, number>();
      let best = Math.round(vals[0]);
      let bestC = 0;
      for (let i = 0; i < count; i++) {
        const key = Math.round(vals[i]);
        const c = (counts.get(key) ?? 0) + 1;
        counts.set(key, c);
        if (c > bestC) {
          bestC = c;
          best = key;
        }
      }
      return best;
    }
    case "SLICECUT":
    default:
      return vals[0];
  }
}

/** 各スライス s のスラブ中心オフセット（基準平面からの mm）。中央対称に配置。 */
function sliceCenterOffset(s: number, numSlices: number, thickness: number, gap: number): number {
  return (s - (numSlices - 1) / 2) * (thickness + gap);
}

/**
 * 任意断面平面 + Slab で参照ボリュームをリスライスし、出力スタック（frames + DICOM 幾何）を生成する。
 * 設計 `fw/slicer-design.md` §5.2。
 */
export function reslice(vol: ResliceVolume, plane: ReslicePlane, slab: SlabSpec): ResliceStack {
  const sample = makeWorldSampler(vol);
  const { origin, rowDir, colDir, cols, rows, colSpacing, rowSpacing } = plane;
  const numSlices = Math.max(1, Math.floor(slab.numSlices));
  const thickness = slab.thickness;
  const gap = slab.gap;
  const normal = normalize(cross(rowDir, colDir));

  // スラブ内サブサンプル数と各オフセット（基準スライス中心からの相対 mm）。
  const minSpacing = Math.min(vol.spacing[0], vol.spacing[1], vol.spacing[2]) || 1;
  const subStep = slab.subSampleSpacing && slab.subSampleSpacing > 0 ? slab.subSampleSpacing : minSpacing;
  const k = slab.mode === "SLICECUT" ? 1 : Math.max(1, Math.round(thickness / subStep));
  const subOffsets = new Float64Array(k);
  for (let t = 0; t < k; t++) subOffsets[t] = (t - (k - 1) / 2) * (thickness / k);

  const frames: Int16Array[] = [];
  const ipps: Vec3[] = [];
  const vals = new Float64Array(k);

  for (let s = 0; s < numSlices; s++) {
    const centerOff = sliceCenterOffset(s, numSlices, thickness, gap);
    const frame = new Int16Array(rows * cols);

    for (let r = 0; r < rows; r++) {
      // 行原点（col=0）: origin + colDir*(r*rowSpacing)。
      const rx = origin[0] + colDir[0] * (r * rowSpacing);
      const ry = origin[1] + colDir[1] * (r * rowSpacing);
      const rz = origin[2] + colDir[2] * (r * rowSpacing);
      const rowBase = r * cols;
      for (let c = 0; c < cols; c++) {
        const bx = rx + rowDir[0] * (c * colSpacing);
        const by = ry + rowDir[1] * (c * colSpacing);
        const bz = rz + rowDir[2] * (c * colSpacing);
        for (let t = 0; t < k; t++) {
          const d = centerOff + subOffsets[t];
          vals[t] = sample([bx + normal[0] * d, by + normal[1] * d, bz + normal[2] * d]);
        }
        frame[rowBase + c] = Math.round(aggregate(vals, k, slab.mode));
      }
    }

    frames.push(frame);
    // IPP = 基準平面左上(origin) を法線方向に centerOff 移動した位置。
    ipps.push([
      origin[0] + normal[0] * centerOff,
      origin[1] + normal[1] * centerOff,
      origin[2] + normal[2] * centerOff,
    ]);
  }

  return {
    frames,
    rows,
    cols,
    numSlices,
    imageOrientationPatient: [rowDir[0], rowDir[1], rowDir[2], colDir[0], colDir[1], colDir[2]],
    imagePositionPatient: ipps,
    pixelSpacing: [rowSpacing, colSpacing],
    sliceThickness: thickness,
    spacingBetweenSlices: thickness + gap,
  };
}
