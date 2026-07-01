/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * ガントリチルト補正（旧 GRAPHY `GantryTiltCorrector.java` の TS 移植）。
 *
 * CT のガントリ/検出器チルト（DICOM `0018,1120` Gantry/Detector Tilt）により、Axial 収集でも
 * スライス平面が患者 Z 軸に対して傾く（＝ボリュームが Y-Z 面でシアーする）。この状態のまま
 * Cornerstone の VolumeViewport に渡すと、ボリュームジオメトリは **スライス法線方向に真っ直ぐ
 * 積む前提**（`generateVolumePropsFromImageIds`：第3軸 = rowCos×colCos、zSpacing = IPP差の法線投影）
 * で構築されるため、面内シアー成分が無視され、SAG/COR が歪む。
 *
 * 本モジュールは、傾いた Axial ボリュームを**逆マッピングで 3D 再サンプリング**して直交（純 Axial）
 * ボリュームへ復元する。出力は `core.volumeLoader.createLocalVolume(volumeId, {...})` に
 * そのまま渡せる `{ data, dimensions, spacing, origin, direction }` 形式。
 *
 * 前提: 標準的な Axial 収集（rowCos ≈ [1,0,0]、チルトは colCos の Z 成分に現れる Y-Z 面シアー）。
 * `tiltAngleDeg` は DICOM `0018,1120`（符号付き）を渡すこと（旧 Java 実装が検証済みの入力）。
 *
 * データ配列は z-major フラット: index(x,y,z) = z*W*H + y*W + x（生の格納画素値）。
 */

export type Vec3 = [number, number, number];
export type TypedPixels =
  | Int8Array
  | Uint8Array
  | Int16Array
  | Uint16Array
  | Float32Array;

export interface TiltSourceVolume {
  /** z-major フラット配列（生の格納画素値）。長さ = width*height*depth。 */
  data: TypedPixels;
  width: number;
  height: number;
  depth: number;
  /** 列方向ピクセル間隔 PixelSpacing[1]（mm）。 */
  pixelSpacingX: number;
  /** 行方向ピクセル間隔 PixelSpacing[0]（mm）。 */
  pixelSpacingY: number;
  /** ソースのスライス間隔（mm）。 */
  sliceSpacing: number;
  /** 先頭スライスの ImagePositionPatient [x,y,z]（mm）。 */
  ippFirst: Vec3;
  /** 末尾スライスの ImagePositionPatient [x,y,z]（mm）。 */
  ippLast: Vec3;
  /** ImageOrientationPatient [Rx,Ry,Rz, Cx,Cy,Cz]。 */
  iop: number[];
  /** FOV 外に割り当てる生値（空気 HU の格納値など）。既定 0。 */
  padding?: number;
}

export interface TiltCorrectedVolume {
  /** z-major フラット配列（入力と同じ型）。 */
  data: TypedPixels;
  width: number;
  height: number;
  depth: number;
  /** [sx, sy, sz]（mm）。createLocalVolume の spacing。 */
  spacing: Vec3;
  /** ボクセル(0,0,0) の患者座標（mm）。createLocalVolume の origin。 */
  origin: Vec3;
  /** 9 要素の右手系方向余弦（純 Axial）。createLocalVolume の direction。 */
  direction: number[];
  /** 適用したチルト角（度, 符号付き）。 */
  tiltAngleDeg: number;
}

const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const norm = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);

/**
 * IPP/IOP から実際のシアー（ガントリチルト）角の**大きさ**を幾何的に求める（度）。
 * スライス法線 N（=Row×Col）とボリューム進行ベクトル V（=IPP_last−IPP_first）の成す角。
 * 旧 `calculateActualShearAngle` の移植。
 */
export function shearAngleDeg(ippFirst: Vec3, ippLast: Vec3, iop: number[]): number {
  const r: Vec3 = [iop[0], iop[1], iop[2]];
  const c: Vec3 = [iop[3], iop[4], iop[5]];
  const n = cross(r, c);
  const nLen = norm(n);
  if (nLen === 0) return 0;
  const nn: Vec3 = [n[0] / nLen, n[1] / nLen, n[2] / nLen];

  const v = sub(ippLast, ippFirst);
  const vLen = norm(v);
  if (vLen === 0) return 0;
  const vv: Vec3 = [v[0] / vLen, v[1] / vLen, v[2] / vLen];

  let d = Math.abs(dot(nn, vv));
  if (d > 1) d = 1;
  return (Math.acos(d) * 180) / Math.PI;
}

/**
 * チルト補正が必要か（既定: 実シアー角 > 0.5°）。旧 `needsTiltCorrection` の移植。
 * 微小誤差や実用上無視できる傾きはスキップ。
 */
export function needsTiltCorrection(
  ippFirst: Vec3,
  ippLast: Vec3,
  iop: number[],
  thresholdDeg = 0.5,
): boolean {
  return shearAngleDeg(ippFirst, ippLast, iop) > thresholdDeg;
}

/** 整数型 typed array なら丸め・範囲クランプして格納する store 関数を返す。 */
function makeStore(out: TypedPixels): (i: number, v: number) => void {
  if (out instanceof Float32Array) {
    return (i, v) => {
      out[i] = v;
    };
  }
  // 整数型: 丸め。範囲は typed array の代入で自動的にラップ/クランプされるが、
  // 明示的に丸めのみ行う（値は元の格納レンジ内に収まる想定）。
  return (i, v) => {
    out[i] = Math.round(v);
  };
}

/**
 * 傾いた Axial ボリュームを直交（純 Axial）ボリュームへ再サンプリングする。
 * 旧 `correctVolume3D` の移植（逆マッピング + Y-Z バイリニア、X はパススルー）。
 *
 * @param src               ソースボリューム（z-major）。
 * @param tiltAngleDeg      符号付きチルト角（DICOM 0018,1120）。
 * @param reconSliceSpacing 再構成スライス厚（mm）。既定 = src.sliceSpacing。
 * @returns createLocalVolume に渡せる補正済みボリューム。
 */
export function correctGantryTilt(
  src: TiltSourceVolume,
  tiltAngleDeg: number,
  reconSliceSpacing?: number,
): TiltCorrectedVolume {
  const { data, width, height: heightOrig, depth: depthOrig } = src;
  const psX = src.pixelSpacingX;
  const psY = src.pixelSpacingY;
  const sliceSpacing = src.sliceSpacing;
  const recon = reconSliceSpacing && reconSliceSpacing > 0 ? reconSliceSpacing : sliceSpacing;
  const padding = src.padding ?? 0;

  const tiltRad = (tiltAngleDeg * Math.PI) / 180;
  const cosA = Math.cos(tiltRad);
  const sinA = Math.sin(tiltRad);
  const tanA = Math.tan(tiltRad);
  // cosA ≈ 0（≈90°）は現実のガントリチルトでは起こり得ないが、ゼロ除算防止。
  const cosSafe = Math.abs(cosA) < 1e-6 ? (cosA < 0 ? -1e-6 : 1e-6) : cosA;

  // 1. 新しいバウンディングボックス（物理サイズ）。
  const ySpanPhys = (heightOrig - 1) * psY * Math.abs(cosA);
  const zSpanPhys = (depthOrig - 1) * sliceSpacing + (heightOrig - 1) * psY * Math.abs(sinA);

  // 2. 新ボリュームサイズ。
  const heightNew = Math.ceil(ySpanPhys / psY) + 1;
  const depthNew = Math.ceil(zSpanPhys / recon) + 1;

  // チルトが負でスタート Z がマイナス側へずれる場合のオフセット。
  const zMinPhys = Math.min(0, (heightOrig - 1) * psY * sinA);

  const sliceLenOrig = width * heightOrig;
  const sliceLenNew = width * heightNew;
  // 出力は入力と同じ型。
  const Ctor = data.constructor as { new (len: number): TypedPixels };
  const out = new Ctor(sliceLenNew * depthNew);
  const store = makeStore(out);

  const getSrc = (x: number, y: number, z: number): number => {
    if (y < 0 || y >= heightOrig || z < 0 || z >= depthOrig) return padding;
    return data[z * sliceLenOrig + y * width + x];
  };

  // 3. 3D 再サンプリング（逆マッピング）。physZ 昇順で k=0..depthNew-1。
  for (let z = 0; z < depthNew; z++) {
    const physZ = zMinPhys + z * recon;
    const zBase = z * sliceLenNew;
    for (let y = 0; y < heightNew; y++) {
      const physY = y * psY;
      const srcY = physY / (psY * cosSafe);
      const srcZ = (physZ - physY * tanA) / sliceSpacing;

      const sy0 = Math.floor(srcY);
      const sy1 = sy0 + 1;
      const sz0 = Math.floor(srcZ);
      const sz1 = sz0 + 1;
      const wy1 = srcY - sy0;
      const wy0 = 1 - wy1;
      const wz1 = srcZ - sz0;
      const wz0 = 1 - wz1;

      const inside = sy0 >= 0 && sy1 < heightOrig && sz0 >= 0 && sz1 < depthOrig;
      const rowBase = zBase + y * width;

      if (inside) {
        const z0Base = sz0 * sliceLenOrig;
        const z1Base = sz1 * sliceLenOrig;
        const y0Off = sy0 * width;
        const y1Off = sy1 * width;
        for (let x = 0; x < width; x++) {
          const v00 = data[z0Base + y0Off + x];
          const v10 = data[z0Base + y1Off + x];
          const v01 = data[z1Base + y0Off + x];
          const v11 = data[z1Base + y1Off + x];
          const vY0 = v00 * wz0 + v01 * wz1;
          const vY1 = v10 * wz0 + v11 * wz1;
          store(rowBase + x, vY0 * wy0 + vY1 * wy1);
        }
      } else {
        for (let x = 0; x < width; x++) {
          const v00 = getSrc(x, sy0, sz0);
          const v10 = getSrc(x, sy1, sz0);
          const v01 = getSrc(x, sy0, sz1);
          const v11 = getSrc(x, sy1, sz1);
          const vY0 = v00 * wz0 + v01 * wz1;
          const vY1 = v10 * wz0 + v11 * wz1;
          store(rowBase + x, vY0 * wy0 + vY1 * wy1);
        }
      }
    }
  }

  // 4. ジオメトリ（純 Axial・右手系）。
  // 旧 Java: 新 IOP=[1,0,0,0,1,0]、IPP は Z のみ移動（X,Y は先頭スライス値を保持）。
  // Cornerstone 用に必ず右手系（第3軸=+Z）にするため、Z 進行が負なら slice 順を反転する。
  const x0 = src.ippFirst[0];
  const y0 = src.ippFirst[1];
  const z0 = src.ippFirst[2];
  const zDir = Math.sign(src.ippLast[2] - src.ippFirst[2]) || 1;

  let originZ: number;
  if (zDir >= 0) {
    originZ = z0 + zMinPhys;
  } else {
    // slice 順を反転して先頭を最小 Z に。
    const tmp = new Ctor(out.length);
    for (let z = 0; z < depthNew; z++) {
      tmp.set(out.subarray(z * sliceLenNew, (z + 1) * sliceLenNew), (depthNew - 1 - z) * sliceLenNew);
    }
    (out as TypedPixels).set(tmp);
    originZ = z0 - (zMinPhys + (depthNew - 1) * recon);
  }

  return {
    data: out,
    width,
    height: heightNew,
    depth: depthNew,
    spacing: [psX, psY, recon],
    origin: [x0, y0, originZ],
    // rowCos=[1,0,0], colCos=[0,1,0], normal=[0,0,1]
    direction: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    tiltAngleDeg,
  };
}
