/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * **プラグインが作った値ボリュームを Cornerstone に載せる合成ローダ**
 * （`fw/subtraction-design.md` §12.2。H31 / H32 の土台）。
 *
 * `graphy-thickslab:` と**同じ作法**である。設計時は「サブトラクション専用の
 * `graphy-subtract:` スキーム」を想定していたが、host API として公開する以上、
 * **値ボリュームを受け取って表示する汎用の形**にしてある。本体側にサブトラクションの語は出ない。
 *
 * <h3>約束ごと</h3>
 *
 * - **1 スライス = 1 imageId。** メタデータは**対応するネイティブスライスへ委譲する**ので、
 *   参照線・向きマーカー・座標同期・スライス同期が元シリーズとそのまま一致する。
 * - 🔴 **`modalityLutModule` は恒等（slope 1 / intercept 0）にする。** プラグインが渡す値は
 *   既に `pixelCalibration` を通った校正済みの値どうしの計算結果なので、GPU 側の Modality LUT を
 *   掛けると**二重適用**になる（ThickSlab が踏んだのと同じ罠。`CLAUDE.md` 絶対ルール 2）。
 * - 🔴 **`voiLutModule` は元シリーズに委譲しない**（`window` が渡されたとき）。差分画像に
 *   元シリーズの W/L を当てると、値域がまるで違うので**真っ黒か真っ白にしか見えない**。
 * - **ネイティブ imageId の並びは呼び出し側の責任。** ここは受け取った順に 1:1 で対応させる。
 *   並びが違えば「もっともらしいが別スライスの絵」になり、見て気付けない。
 */
import { cache, metaData, registerImageLoader, utilities as csUtils } from "@cornerstonejs/core";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

/** 合成 imageId のスキーム（カスタムローダ登録名）。 */
export const PLUGIN_VOLUME_SCHEME = "graphy-plugin-volume";

interface ValueStackSession {
  pluginId: string;
  /** z-major のフラット配列（長さ nx·ny·nz）。 */
  data: Float32Array;
  dims: [number, number, number];
  /** z 昇順のネイティブ imageId。長さは nz と一致していること。 */
  nativeIds: string[];
  unit: string;
  /** 表示窓。省略時は値域から自動で決める。 */
  window: { center: number; width: number } | null;
}

const sessions = new Map<string, ValueStackSession>();
let counter = 0;

/** トークン ＋ z から合成 imageId を組み立てる。 */
export function pluginVolumeImageId(token: string, z: number): string {
  return `${PLUGIN_VOLUME_SCHEME}:${token}#${z}`;
}

/** 合成 imageId をトークンと z に分解。スキーム不一致・壊れた形なら null。 */
export function parsePluginVolumeImageId(imageId: string): { token: string; z: number } | null {
  if (typeof imageId !== "string" || !imageId.startsWith(`${PLUGIN_VOLUME_SCHEME}:`)) return null;
  const rest = imageId.slice(PLUGIN_VOLUME_SCHEME.length + 1);
  const hash = rest.lastIndexOf("#");
  if (hash < 0) return null;
  const token = rest.slice(0, hash);
  const z = Number(rest.slice(hash + 1));
  if (!token || !Number.isInteger(z) || z < 0) return null;
  return { token, z };
}

/**
 * 値ボリュームの有限値から表示窓を決める（`window` を渡さなかったとき）。
 *
 * 上下 1% を落とした範囲にする。差分画像は少数の外れ値でレンジが決まりやすく、
 * 素の min/max だと**ほぼ全面が中間色**になる。
 */
export function autoWindow(data: Float32Array): { center: number; width: number } {
  const finite: number[] = [];
  const step = Math.max(1, Math.floor(data.length / 200_000));
  for (let i = 0; i < data.length; i += step) {
    if (Number.isFinite(data[i])) finite.push(data[i]);
  }
  if (finite.length === 0) return { center: 0, width: 1 };
  finite.sort((a, b) => a - b);
  const lo = finite[Math.floor(finite.length * 0.01)];
  const hi = finite[Math.floor(finite.length * 0.99)];
  const width = hi > lo ? hi - lo : 1;
  return { center: (hi + lo) / 2, width };
}

/**
 * 値ボリュームを登録し、スライスごとの imageId を返す。
 *
 * @throws 大きさが合わない / ネイティブ imageId の枚数が z と違うとき。
 *   **黙って合わせない** — 合わせた結果は「別スライスの絵」になる。
 */
export function createValueStack(params: {
  pluginId: string;
  data: Float32Array;
  dims: [number, number, number];
  nativeIds: string[];
  unit?: string;
  window?: { center: number; width: number } | null;
}): { token: string; imageIds: string[] } {
  const [nx, ny, nz] = params.dims;
  if (!(nx > 0 && ny > 0 && nz > 0)) throw new Error(`bad dims ${nx}x${ny}x${nz}`);
  if (params.data.length !== nx * ny * nz) {
    throw new Error(`data length ${params.data.length} != ${nx * ny * nz}`);
  }
  if (params.nativeIds.length !== nz) {
    throw new Error(
      `nativeIds length ${params.nativeIds.length} != slices ${nz}; ` +
        "the plugin volume and the reference stack must line up 1:1",
    );
  }
  counter += 1;
  const token = `${encodeURIComponent(params.pluginId)}-${counter}`;
  sessions.set(token, {
    pluginId: params.pluginId,
    data: params.data,
    dims: params.dims,
    nativeIds: [...params.nativeIds],
    unit: params.unit ?? "",
    window: params.window ?? null,
  });
  const imageIds = Array.from({ length: nz }, (_, z) => pluginVolumeImageId(token, z));
  return { token, imageIds };
}

/**
 * セッションを破棄し、そのスライスを Cornerstone のキャッシュからも落とす。
 *
 * ⚠️ キャッシュを落とさないと、プラグインが計算し直しても**古い絵が出続ける**
 * （imageId が同じなら cornerstone は読み直さない）。トークンは毎回変わるので
 * 実際に衝突はしないが、落とさないぶんメモリが積み上がる。
 */
export function releaseValueStack(token: string): void {
  const session = sessions.get(token);
  if (!session) return;
  sessions.delete(token);
  for (let z = 0; z < session.dims[2]; z++) {
    try {
      (cache as Any).removeImageLoadObject?.(pluginVolumeImageId(token, z));
    } catch {
      /* キャッシュに無ければ何もしない */
    }
  }
}

/** テスト・診断用。 */
export function valueStackCount(): number {
  return sessions.size;
}

function nativeIdFor(session: ValueStackSession, z: number): string {
  const nz = session.nativeIds.length;
  return session.nativeIds[Math.min(nz - 1, Math.max(0, z))];
}

function buildImage(imageId: string): Record<string, unknown> {
  const parsed = parsePluginVolumeImageId(imageId);
  if (!parsed) throw new Error(`plugin-volume: bad imageId ${imageId}`);
  const session = sessions.get(parsed.token);
  if (!session) throw new Error(`plugin-volume: unknown session ${parsed.token}`);
  const [nx, ny, nz] = session.dims;
  if (parsed.z >= nz) throw new Error(`plugin-volume: z ${parsed.z} out of range (${nz})`);

  const plane = nx * ny;
  const slice = new Float32Array(plane);
  slice.set(session.data.subarray(parsed.z * plane, (parsed.z + 1) * plane));
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < plane; i++) {
    const v = slice[i];
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min)) {
    min = 0;
    max = 0;
  }

  const nativeId = nativeIdFor(session, parsed.z);
  const geom: Any = metaData.get("imagePlaneModule", nativeId) ?? {};
  const win = session.window ?? autoWindow(session.data);

  const voxelManager = csUtils.VoxelManager.createImageVoxelManager({
    width: nx,
    height: ny,
    scalarData: slice,
    numberOfComponents: 1,
    id: imageId,
  });

  return {
    imageId,
    referencedImageId: nativeId,
    dataType: "Float32Array",
    color: false,
    rgba: false,
    numberOfComponents: 1,
    // 値は既に校正済み。Modality LUT は恒等（二重適用を防ぐ）。
    slope: 1,
    intercept: 0,
    windowCenter: win.center,
    windowWidth: win.width,
    minPixelValue: min,
    maxPixelValue: max,
    rows: ny,
    columns: nx,
    height: ny,
    width: nx,
    columnPixelSpacing: Number(geom.columnPixelSpacing) || 1,
    rowPixelSpacing: Number(geom.rowPixelSpacing) || 1,
    sliceThickness: Number(geom.sliceThickness) || undefined,
    invert: false,
    getPixelData: () => voxelManager.getScalarData(),
    getCanvas: undefined,
    voxelManager,
    sizeInBytes: slice.byteLength,
    FrameOfReferenceUID: geom.frameOfReferenceUID,
  };
}

let registered = false;

/**
 * `graphy-plugin-volume:` の画像ローダとメタデータプロバイダを登録する。冪等。
 * cornerstone の初期化時（`ensureCornerstoneInitialized`）に呼ぶ。
 */
export function registerPluginVolumeLoader(): void {
  if (registered) return;
  registered = true;

  registerImageLoader(PLUGIN_VOLUME_SCHEME, (imageId: string) => ({
    promise: Promise.resolve(buildImage(imageId)) as Promise<Any>,
  }));

  metaData.addProvider((type: string, ...query: string[]): unknown => {
    const imageId = query[0];
    const parsed = parsePluginVolumeImageId(imageId);
    if (!parsed) return undefined;
    const session = sessions.get(parsed.token);
    if (!session) return undefined;
    const nativeId = nativeIdFor(session, parsed.z);

    if (type === "modalityLutModule") {
      // 校正済みの値なので恒等。**ここを委譲すると CT で約 −1024 ずれる**（既知の事故）。
      return { rescaleSlope: 1, rescaleIntercept: 0, rescaleType: session.unit || undefined };
    }
    if (type === "voiLutModule" && session.window) {
      // 差分画像に元シリーズの W/L を当てても何も見えない。指定があればそちらを使う。
      return { windowCenter: [session.window.center], windowWidth: [session.window.width] };
    }
    // 幾何もその他も元シリーズへ委譲する（**幾何を作り直さない**）。
    return metaData.get(type, nativeId);
  }, 10000);
}
