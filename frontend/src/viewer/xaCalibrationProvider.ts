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
import { Enums, cache, metaData } from "@cornerstonejs/core";
import { dsaNativeImageId } from "./dsaLoader";
import { xaDataSetOf } from "./xaCine";
import { readUsRegions, resolveUsCalibration } from "./usCalibration";
import {
  calibrationScaleFor,
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

/**
 * 一般撮影（CR/DX/MG/IO）。XA と同じ解決連鎖に乗せるが、`generalRadiography` として
 * `PixelSpacing` 単独をそのまま採り、検出器面の値も近似の mm として採る（{@link resolveXaCalibration}）。
 */
const GENERAL_RADIOGRAPHY_SOP_CLASSES = new Set([
  "1.2.840.10008.5.1.4.1.1.1", // CR
  "1.2.840.10008.5.1.4.1.1.1.1", // DX for presentation
  "1.2.840.10008.5.1.4.1.1.1.1.1", // DX for processing
  "1.2.840.10008.5.1.4.1.1.1.2", // MG for presentation
  "1.2.840.10008.5.1.4.1.1.1.2.1", // MG for processing
  "1.2.840.10008.5.1.4.1.1.1.3", // intra-oral for presentation
  "1.2.840.10008.5.1.4.1.1.1.3.1", // intra-oral for processing
]);

/** 超音波（単フレーム・マルチフレーム。退役版も含む）。校正は Sequence of Ultrasound Regions から。 */
const US_SOP_CLASSES = new Set([
  "1.2.840.10008.5.1.4.1.1.6.1",
  "1.2.840.10008.5.1.4.1.1.3.1",
  "1.2.840.10008.5.1.4.1.1.6",
  "1.2.840.10008.5.1.4.1.1.3",
]);

interface MinimalDataSet {
  string(tag: string): string | undefined;
  floatString(tag: string, index?: number): number | undefined;
}

/** SeriesInstanceUID → 人が確定した校正（カテーテル法 / ルーラー法）。 */
const userCalibrations = new Map<string, XaUserCalibration>();
/** imageId → 解決結果（null = XA ではない）。override 変更時に破棄する。 */
const resolved = new Map<string, XaCalibration | null>();
/**
 * imageId → Cornerstone へ渡す calibration オブジェクト。
 * 🚨 **同一性を保つ**こと。`StackViewport.calibrateIfNecessary` は `this.calibration !== calibration`
 * で更新を検知するため、毎回新しいオブジェクトを返すと**フレームごとに calibration イベントが飛ぶ**。
 */
const calibrationPayloads = new Map<string, { type: string; scale: number }>();

/** 校正が変わったときに呼ぶもの（画面が ROI の統計を作り直すため）。 */
const calibrationListeners = new Set<() => void>();

/** 人の校正が変わったら知らせる。返り値で解除。 */
export function subscribeXaCalibration(fn: () => void): () => void {
  calibrationListeners.add(fn);
  return () => calibrationListeners.delete(fn);
}

/** 人が確定した校正を設定する（A4 のカテーテル校正 UI から呼ぶ）。 */
export function setXaUserCalibration(seriesUid: string, calib: XaUserCalibration | null): void {
  if (calib) userCalibrations.set(seriesUid, calib);
  else userCalibrations.delete(seriesUid);
  // calibration 種別（mm/px の別）も校正で変わるので**両方**捨てる。
  resolved.clear();
  calibrationPayloads.clear();
  // 🔴 ROI の統計（長さ・面積）も作り直させる。画素の位置は校正で変わらない（world の基準は画像の間隔のまま）ので、
  //    頂点の署名だけでは作り直しが起きない（以前は画素の位置が誤って変わっていたので、たまたま作り直されていた）。
  for (const fn of calibrationListeners) {
    try {
      fn();
    } catch {
      /* 購読側の失敗で校正を止めない */
    }
  }
}

/** 人が確定した校正を取り出す。 */
export function getXaUserCalibration(seriesUid: string): XaUserCalibration | null {
  return userCalibrations.get(seriesUid) ?? null;
}

/** テスト・シリーズ切替用。 */
export function clearXaCalibrationCache(): void {
  resolved.clear();
  calibrationPayloads.clear();
}

/**
 * 解決結果を Cornerstone の calibration 種別へ写す。
 *
 * <p>🚨 **これが無いと「未校正なのに計測ラベルが mm」になる**（実機で発覚）。
 * この版の `StackViewport` は `hasPixelSpacing` を `!imagePlaneModule.usingDefaultValues` で決めるが、
 * `usingDefaultValues` を立てる実装が無いため**実質常に true**＝計測ツールは常に "mm" を出す。
 * 単位を px にできる唯一の経路が **`calibratedPixelSpacing` メタデータの
 * `type: "Uncalibrated"`**（`getCalibratedLengthUnitsAndScale` がここで短絡する）。
 *
 * <p>校正済みのときは種別を渡すと計測ラベルが `mm User` / `mm Proj` のようになり、
 * **どの校正で測った値かが計測そのものに出る**（設計 §7.4 の「出自を必ず表示」と同じ狙い）。
 */
function calibrationPayloadFor(
  imageId: string,
  calib: XaCalibration,
): { type: string; scale: number } {
  const hit = calibrationPayloads.get(imageId);
  if (hit) return hit;
  const { CalibrationTypes } = Enums;
  let type: string = CalibrationTypes.UNCALIBRATED;
  if (calib.mmPerPxRow != null && calib.mmPerPxCol != null) {
    if (calib.source === "user-catheter" || calib.source === "user-ruler") {
      type = CalibrationTypes.USER;
    } else if (calib.source === "us-region") {
      type = CalibrationTypes.REGION;
    } else if (
      calib.source === "geometric-sid-sod" ||
      calib.source === "geometric-magfactor" ||
      calib.source === "detector-plane-measured"
    ) {
      // 幾何倍率による近似＝投影補正。
      type = CalibrationTypes.PROJECTION;
    } else {
      type = CalibrationTypes.CALIBRATED;
    }
  }
  // world 長 → 表示値の比。🔴 割る基準は「**画像が作られたときの間隔**」（＝ world の基準。loaderSpacingFor）。
  // 読み込みの時点で校正が決まっていれば imagePlaneModule への注入がそのまま world になるので倍率は 1、
  // 読み込みの後で校正した（カテーテル・定規）なら world は前の間隔のままなので、その比を渡す。
  // 以前は DICOM の PixelSpacing タグ（無ければ 1）で割っていて、PixelSpacing の無い DX・US では
  // world（校正済みの mm）をもう一度割り、長さが「1 / 画素間隔」倍ずれていた（DX 0.1 mm/px で 10 倍小さい）。
  const scale = calibrationScaleFor(loaderSpacingFor(imageId).col, calib.mmPerPxCol);
  const payload = { type, scale };
  calibrationPayloads.set(imageId, payload);
  return payload;
}

/**
 * タグを読む対象の imageId。**合成（`graphy-dsa:`）はネイティブフレームへ読み替える。**
 *
 * <p>🚨 合成 imageId には元の URL が入っていないので、そのままではタグが 1 つも読めず
 * **「未校正」に見える**。実機で踏んだ形（2026-08-23）: DSA 表示中に保存した GSPS に
 * 空間校正が入らず、解析ダイアログの校正欄も "—" になっていた。
 * ⚠️ **Cornerstone の計測は mm のまま**（DSA ローダの provider がネイティブへ委譲している）
 * なので、画面を見ているだけでは気づけない。
 */
function nativeXaImageId(imageId: string): string {
  return dsaNativeImageId(imageId) ?? imageId;
}

function dataSetFor(imageId: string): MinimalDataSet | null {
  // 未取得・非 wadouri の imageId はここで抜ける（プリウォーム前は解決しない）。
  return (xaDataSetOf(nativeXaImageId(imageId)) as unknown as MinimalDataSet) ?? null;
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
  if (!sopClass || !(XA_SOP_CLASSES.has(sopClass) || GENERAL_RADIOGRAPHY_SOP_CLASSES.has(sopClass))) return null;
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

/**
 * **Cornerstone の world 座標が使っている**列/行 spacing（＝**画像が作られたときの間隔**）。
 *
 * <p>world は「ローダが画像オブジェクトを作ったときの `imagePlaneModule`」で決まる。ローダはこの provider を通して
 * 読むので、**読み込みの時点で校正が決まっていれば、注入した校正値がそのまま world になる**
 * （2026-10-04 に実機で確認: ImagerPixelSpacing だけの DX・領域のある US）。読み込みの後で校正した（カテーテル・定規）なら
 * 画像は作り直されないので、world は前の間隔のまま（実機で「校正後に QCA が失敗し、古い結果が残る」形で出たのはこちら）。
 * どちらの場合も正しいのは「画像オブジェクトに付いている間隔」なので、それを返す。world ↔ 画像ピクセルの換算は必ずこれを使う。
 *
 * <p>画像がまだ作られていなければ、作られるときに入る値（注入する校正値・無ければ DICOM の PixelSpacing・無ければ 1）を返す。
 */
export function loaderSpacingFor(imageId: string): { row: number; col: number } {
  const img = cache.getImage(imageId) as { rowPixelSpacing?: number | null; columnPixelSpacing?: number | null } | undefined;
  if (img) {
    // 🔴 画像がもう作られているなら、その間隔が world。間隔の無い画像（未校正で読み込んだ XA）は 1（world は px）。
    //    ここで後から決まった校正値（カテーテル）を返すと、倍率が 1 になって「px の値に mm」を付けてしまう。
    const r = img.rowPixelSpacing ?? 0;
    const c = img.columnPixelSpacing ?? 0;
    return { row: r > 0 ? r : 1, col: c > 0 ? c : 1 };
  }
  const calib = calibrationForImageId(imageId);
  if (calib && calib.source !== "dicom-pixel-spacing" && calib.mmPerPxRow != null && calib.mmPerPxCol != null) {
    return { row: calib.mmPerPxRow, col: calib.mmPerPxCol };
  }
  const ps = readXaCalibTags(imageId)?.pixelSpacing;
  const row = ps && ps[0] > 0 ? ps[0] : 1;
  const col = ps && ps[1] > 0 ? ps[1] : 1;
  return { row, col };
}

/** imageId の校正を解決する（memo 付き）。XA でなければ null。 */
export function calibrationForImageId(rawImageId: string): XaCalibration | null {
  // 合成（DSA）はネイティブへ読み替えてから解決・記憶する。合成 id で覚えると、
  // 版番号やフレームが変わるたびに別キーになり、キャッシュが無限に増える。
  const imageId = nativeXaImageId(rawImageId);
  const hit = resolved.get(imageId);
  if (hit !== undefined) return hit;
  const sop = dataSetFor(imageId)?.string("x00080016") ?? "";
  if (US_SOP_CLASSES.has(sop)) {
    const calib = resolveUsCalibration(readUsRegions(dataSetFor(imageId)));
    resolved.set(imageId, calib);
    return calib;
  }
  const tags = readXaCalibTags(imageId);
  if (!tags) {
    // dataSet 未取得の段階では memo しない（プリウォーム後に再解決させる）。
    if (dataSetFor(imageId)) resolved.set(imageId, null);
    return null;
  }
  const ds = dataSetFor(imageId);
  const seriesUid = ds?.string("x0020000e") ?? "";
  const calib = resolveXaCalibration(tags, userCalibrations.get(seriesUid) ?? null, {
    generalRadiography: GENERAL_RADIOGRAPHY_SOP_CLASSES.has(sop),
  });
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
    if (type !== "imagePlaneModule" && type !== "calibratedPixelSpacing" && type !== "calibrationModule") return undefined;
    if (reentrant) return undefined;
    const imageId = query[0];
    if (typeof imageId !== "string") return undefined;
    const calib = calibrationForImageId(imageId);
    if (!calib) return undefined;
    // CR の PixelSpacing 単独はローダの既定と同じ値。注入せず、ローダの挙動（単位 "mm"）をそのまま残す。
    if (calib.source === "dicom-pixel-spacing") return undefined;

    // 超音波の領域: ローダは calibrationModule に領域（sequenceOfUltrasoundRegions）を入れ、計測ツールは
    // 「world は px」とみなして PhysicalDelta で換算する。こちらは領域の値を imagePlaneModule に注入して world を mm に
    // しているので、領域の換算を残すと二重になる（縦横の値が違う領域では単位が px に落ちる）。注入するときは外す。
    if (type === "calibrationModule") {
      return calib.source === "us-region" && calib.mmPerPxRow != null && calib.mmPerPxCol != null ? {} : undefined;
    }

    // 計測ツールの単位（mm / px）はここで決まる。imagePlaneModule の spacing だけでは px にできない。
    if (type === "calibratedPixelSpacing") {
      return calibrationPayloadFor(imageId, calib);
    }

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
