/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * XA/XRF の空間校正を Cornerstone の `imagePlaneModule` へ**注入する**層
 * （`fw/angio-design.md` §7.2 の最後）。
 *
 * <h3>なぜ注入が要るのか</h3>
 * dicom-image-loader は `PixelSpacing (0028,0030)` を**そのまま** `rowPixelSpacing` /
 * `columnPixelSpacing` にする（`ImagerPixelSpacing` へのフォールバックは無い）。つまり
 * <ul>
 *   <li>`PixelSpacing` が**未校正のコピー**（= `ImagerPixelSpacing` と同値）でも、
 *       Cornerstone Tools は**黙って mm を表示する**（検出器面の mm ＝ 患者内では倍率ぶん過大）。</li>
 *   <li>逆に `PixelSpacing` が無ければ px 表示になる（こちらは正しい挙動）。</li>
 * </ul>
 * ここで {@link resolveXaCalibration} の結論を注入して初めて、**表示と計算の校正が一致する**。
 *
 * <p>注入は「上書き」だけでなく「**取り消し**」も行う: 未校正と判定したら spacing を落として
 * px 表示に戻す。これが無いと「未校正なのに mm が出る」という一番危ない状態が残る。
 */
import { metaData } from "@cornerstonejs/core";
import { xaDataSetOf } from "./xaCine";
import {
  resolveXaCalibration,
  type XaCalibTags,
  type XaCalibration,
  type XaUserCalibration,
} from "./xaCalibration";

/** 空間校正の解決対象にする SOP クラス（XA/XRF。3D Angiographic は通常のボリューム経路）。 */
const XA_SOP_CLASSES = new Set([
  "1.2.840.10008.5.1.4.1.1.12.1",
  "1.2.840.10008.5.1.4.1.1.12.1.1",
  "1.2.840.10008.5.1.4.1.1.12.2",
  "1.2.840.10008.5.1.4.1.1.12.2.1",
  "1.2.840.10008.5.1.4.1.1.12.3",
]);

interface MinimalDataSet {
  string(tag: string): string | undefined;
  floatString(tag: string, index?: number): number | undefined;
}

/** SeriesInstanceUID → 人が確定した校正（カテーテル法 / ルーラー法）。 */
const userCalibrations = new Map<string, XaUserCalibration>();
/** imageId → 解決結果（null = XA ではない）。override 変更時に破棄する。 */
const resolved = new Map<string, XaCalibration | null>();

/** 人が確定した校正を設定する（A4 のカテーテル校正 UI から呼ぶ）。 */
export function setXaUserCalibration(seriesUid: string, calib: XaUserCalibration | null): void {
  if (calib) userCalibrations.set(seriesUid, calib);
  else userCalibrations.delete(seriesUid);
  resolved.clear();
}

/** 人が確定した校正を取り出す。 */
export function getXaUserCalibration(seriesUid: string): XaUserCalibration | null {
  return userCalibrations.get(seriesUid) ?? null;
}

/** テスト・シリーズ切替用。 */
export function clearXaCalibrationCache(): void {
  resolved.clear();
}

function dataSetFor(imageId: string): MinimalDataSet | null {
  // 未取得・非 wadouri の imageId はここで抜ける（プリウォーム前は解決しない）。
  return (xaDataSetOf(imageId) as unknown as MinimalDataSet) ?? null;
}

function readPair(ds: MinimalDataSet, tag: string): [number, number] | null {
  const a = ds.floatString(tag, 0);
  const b = ds.floatString(tag, 1);
  if (typeof a !== "number" || !Number.isFinite(a)) return null;
  const second = typeof b === "number" && Number.isFinite(b) ? b : a;
  return [a, second];
}

/** キャッシュ済み dataSet から校正タグを読む。XA/XRF でなければ null。 */
export function readXaCalibTags(imageId: string): XaCalibTags | null {
  const ds = dataSetFor(imageId);
  if (!ds) return null;
  const sopClass = ds.string("x00080016");
  if (!sopClass || !XA_SOP_CLASSES.has(sopClass)) return null;
  return {
    pixelSpacing: readPair(ds, "x00280030"),
    pixelSpacingCalibrationType: ds.string("x00280a02") ?? null,
    pixelSpacingCalibrationDescription: ds.string("x00280a04") ?? null,
    imagerPixelSpacing: readPair(ds, "x00181164"),
    distanceSourceToDetector: ds.floatString("x00181110") ?? null,
    distanceSourceToPatient: ds.floatString("x00181111") ?? null,
    estimatedRadiographicMagnificationFactor: ds.floatString("x00181114") ?? null,
  };
}

/** imageId の校正を解決する（memo 付き）。XA でなければ null。 */
export function calibrationForImageId(imageId: string): XaCalibration | null {
  const hit = resolved.get(imageId);
  if (hit !== undefined) return hit;
  const tags = readXaCalibTags(imageId);
  if (!tags) {
    // dataSet 未取得の段階では memo しない（プリウォーム後に再解決させる）。
    if (dataSetFor(imageId)) resolved.set(imageId, null);
    return null;
  }
  const ds = dataSetFor(imageId);
  const seriesUid = ds?.string("x0020000e") ?? "";
  const calib = resolveXaCalibration(tags, userCalibrations.get(seriesUid) ?? null);
  resolved.set(imageId, calib);
  return calib;
}

let registered = false;
/** provider の中から同じ imageId の metaData.get を呼ぶための再入ガード（無限再帰の防止）。 */
let reentrant = false;

/**
 * 高優先メタデータプロバイダを登録する。冪等。cornerstone 初期化時に呼ぶ。
 *
 * <p>優先度はローダ既定より高くする（ローダの `imagePlaneModule` を土台にして spacing だけ差し替える）。
 */
export function registerXaCalibrationProvider(): void {
  if (registered) return;
  registered = true;

  metaData.addProvider((type: string, ...query: unknown[]): unknown => {
    if (type !== "imagePlaneModule") return undefined;
    if (reentrant) return undefined;
    const imageId = query[0];
    if (typeof imageId !== "string") return undefined;
    const calib = calibrationForImageId(imageId);
    if (!calib) return undefined;

    reentrant = true;
    let base: Record<string, unknown> | undefined;
    try {
      base = metaData.get("imagePlaneModule", imageId) as Record<string, unknown> | undefined;
    } finally {
      reentrant = false;
    }
    if (!base) return undefined;

    if (calib.mmPerPxRow != null && calib.mmPerPxCol != null) {
      return {
        ...base,
        rowPixelSpacing: calib.mmPerPxRow,
        columnPixelSpacing: calib.mmPerPxCol,
        pixelSpacing: [calib.mmPerPxRow, calib.mmPerPxCol],
      };
    }
    // 未校正 → spacing を落として px 表示に戻す（「未校正なのに mm」を作らない）。
    const out = { ...base };
    delete out.rowPixelSpacing;
    delete out.columnPixelSpacing;
    delete out.pixelSpacing;
    return out;
  }, 12000);
}
