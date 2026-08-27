/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * プラグイン host API の書き出し層（H22 / H23）の**純ロジック**。
 *
 * <p>ここには DOM も Cornerstone も HTTP も入れない（{@link pluginExportApi} が担当）。
 * 量子化と幾何の変換は「静かに間違える」種類の処理なので、単体テストで押さえられる形に
 * 切り出してある。
 */

/** [x, y, z] 患者 LPS mm。 */
export type Vec3 = [number, number, number];

/** 1 セグメント（labelmap の 1 ラベル）。 */
export interface MaskSegmentInput {
  label: string;
  color?: [number, number, number];
  description?: string;
  /** dims のボクセル数と同じ長さ。**0 以外が前景**。 */
  data: Uint8Array;
}

/** 1 スライスぶんのマスク平面（前景ゼロの平面は含めない）。 */
export interface MaskPlane {
  /** ボリュームの z（0 始まり）。 */
  z: number;
  /** rows*cols の 0/1 バイト列。 */
  mask: Uint8Array;
}

export interface SlicedMask {
  planes: MaskPlane[];
  /** 前景ボクセルの総数（0 なら書き出さない）。 */
  foregroundVoxels: number;
}

/**
 * セグメントを**前景のある z だけ**の平面へ切り分ける。
 *
 * <p>SEG は非空スライスだけを送る（全 z を送ると 512×512×数百のゼロ平面が乗る）。
 * ⚠ 前景ゼロのセグメントは呼び出し側が落とすこと。**空のセグメントを持つ SEG を作らない**
 * （受け側で「あるはずのラベルが無い」ように見える）。
 */
export function sliceMask(dims: [number, number, number], data: Uint8Array): SlicedMask {
  const [nx, ny, nz] = dims;
  const area = nx * ny;
  if (data.length !== area * nz) {
    throw new Error(`マスクの長さが格子と一致しません（期待 ${area * nz} / 実際 ${data.length}）`);
  }
  const planes: MaskPlane[] = [];
  let total = 0;
  for (let z = 0; z < nz; z++) {
    const src = data.subarray(z * area, (z + 1) * area);
    let count = 0;
    for (let i = 0; i < area; i++) if (src[i] !== 0) count++;
    if (count === 0) continue;
    const plane = new Uint8Array(area);
    for (let i = 0; i < area; i++) plane[i] = src[i] !== 0 ? 1 : 0;
    planes.push({ z, mask: plane });
    total += count;
  }
  return { planes, foregroundVoxels: total };
}

/** Uint8Array → Base64（`viewer/segExport.ts` と同じ方法）。 */
export function u8ToBase64(u8: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) {
    bin += String.fromCharCode.apply(null, Array.from(u8.subarray(i, i + chunk)));
  }
  return btoa(bin);
}

export interface QuantizedDose {
  /** uint16 のリトルエンディアン列（そのまま Base64 化して送る）。 */
  bytes: Uint8Array;
  /** 格納値 → Gy の係数。 */
  doseGridScaling: number;
  /** 量子化で生じる最大誤差 [Gy]（＝係数の半分）。 */
  quantizationErrorGy: number;
  /** 背景で埋めたボクセル数（NaN だったところ）。 */
  filledVoxels: number;
  /** 元データの最大値 [Gy]。 */
  maxGy: number;
}

/**
 * 線量 [Gy] の Float32 格子を **uint16 ＋ DoseGridScaling** に量子化する。
 *
 * <h3>🔴 NaN を黙って 0 にしない</h3>
 *
 * <p>線量マップは「データが無い」ところを NaN で持つ（voxelDose の作法）。RTDOSE には
 * パディングの概念が無いので何かの値で埋めるほかないが、<b>0 Gy で埋めると
 * 「線量が無かった」と読まれる</b>。そこで H4b の `background` と同じ作法にして、
 * <b>NaN があるのに `backgroundGy` が指定されていなければ拒否する</b>
 * （呼び出し側に「何で埋めるか」を必ず決めさせる）。埋めた数は返して報告できるようにする。
 *
 * <h3>係数の決め方</h3>
 *
 * <p>`doseGridScaling = max / 65535`。最大値を 65535 段に割り当てるので、
 * 相対分解能は常に 1/65535（≒ 0.0015%）。最大が 0（全域ゼロ）なら係数が決まらないので拒否する
 * ——「全部 0 の線量」を保存しても受け側で何も分からない。
 */
export function quantizeDoseGrid(data: Float32Array, backgroundGy?: number): QuantizedDose {
  let max = 0;
  let nan = 0;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (!Number.isFinite(v)) {
      nan++;
      continue;
    }
    if (v < 0) {
      throw new Error("線量に負の値が含まれています（RTDOSE は unsigned で書きます）");
    }
    if (v > max) max = v;
  }
  if (nan > 0 && (backgroundGy === undefined || !Number.isFinite(backgroundGy))) {
    throw new Error(
      `線量マップに ${nan} 個の NaN があります。0 Gy で埋めると「線量が無かった」と読まれるため、` +
        "backgroundGy を明示してください。",
    );
  }
  const bg = backgroundGy ?? 0;
  if (bg < 0) throw new Error("backgroundGy が負です");
  if (bg > max) max = bg;
  if (!(max > 0)) {
    throw new Error("線量が全域 0 です（DoseGridScaling を決められません）");
  }
  const scaling = max / 65535;
  const bytes = new Uint8Array(data.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < data.length; i++) {
    const v = Number.isFinite(data[i]) ? data[i] : bg;
    let stored = Math.round(v / scaling);
    if (stored < 0) stored = 0;
    if (stored > 65535) stored = 65535;
    view.setUint16(i * 2, stored, true);
  }
  return {
    bytes,
    doseGridScaling: scaling,
    quantizationErrorGy: scaling / 2,
    filledVoxels: nan,
    maxGy: max,
  };
}

/**
 * スライス方向のオフセット列（RTDOSE の `GridFrameOffsetVector`）を作る。
 *
 * <p>RTDOSE のフレームは<b>面法線に沿って</b>並ぶ前提の表現しか持たない。
 * ガントリ傾斜などで `sliceStep` が法線と平行でない格子は、この表現では**書けない**。
 * そこを丸めて書くと、受け側では 1 枚ごとに面内へずれた線量になる（気付きにくい）。
 * <b>書けないものは書かない</b>で null を返し、呼び出し側が理由を出す。
 *
 * @param iop       ImageOrientationPatient（6 要素）
 * @param sliceStep スライスが 1 進むときの移動ベクトル（実測の IPP 差）
 * @param nz        スライス数
 */
export function gridFrameOffsets(iop: number[], sliceStep: Vec3, nz: number): number[] | null {
  if (iop.length < 6 || nz <= 0) return null;
  const r: Vec3 = [iop[0], iop[1], iop[2]];
  const c: Vec3 = [iop[3], iop[4], iop[5]];
  const n: Vec3 = [
    r[1] * c[2] - r[2] * c[1],
    r[2] * c[0] - r[0] * c[2],
    r[0] * c[1] - r[1] * c[0],
  ];
  const nlen = Math.hypot(n[0], n[1], n[2]);
  if (!(nlen > 0)) return null;
  const un: Vec3 = [n[0] / nlen, n[1] / nlen, n[2] / nlen];
  const step = Math.hypot(sliceStep[0], sliceStep[1], sliceStep[2]);
  if (nz > 1 && !(step > 0)) return null;
  const along = sliceStep[0] * un[0] + sliceStep[1] * un[1] + sliceStep[2] * un[2];
  if (nz > 1) {
    // 法線成分の大きさが移動量とほぼ等しいこと＝平行であること。0.1% を許容にする
    // （実データの IPP は DS 文字列なので厳密一致にはならない）。
    if (Math.abs(Math.abs(along) - step) > step * 1e-3) return null;
  }
  const offsets: number[] = new Array(nz);
  for (let k = 0; k < nz; k++) offsets[k] = k * along;
  return offsets;
}
