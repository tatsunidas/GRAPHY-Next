/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * Fusion オーバーレイ（前景）のカーソル値を、base ビューア（`Viewer2D`）へ渡すためのレジストリ。
 *
 * <p>Fusion では画面に 2 つの画像が重なっているのに、状態バーの「値」は base（背景）の
 * 画素値しか出していなかった。前景の値は `FusionImageViewer` が再構成した配列の中にしか無く、
 * base 側からは覗けないため、ここに**ビューポート ID をキーにして置き場を 1 つ**作る。
 *
 * <p>置かれる配列は `computeFusionSlice` の出力＝**背景スライスの画素格子に載った前景値**なので、
 * 位置合わせ（自動 R3 ＋ 手動 R1）を掛けた場合は**ワープ後・補間後**の値がそのまま読める。
 * 非空間フォールバック（IOP/IPP 無し）のときだけ前景自身の格子が載るので、読み出し時に
 * 格子間の比例マッピングを掛ける（{@link sampleFusionValue}）。
 *
 * <p>校正の入口は `pixelCalibration` / `readImageInfo` のまま。ここは**表示用に解決済みの値**
 * （SUV 校正済みなら SUV 空間、単位ラベル付き）を受け取るだけで、自前で slope/intercept を掛けない。
 */

/** 前景の値配列とその表示メタ。`FusionImageViewer` が再構成のたびに差し替える。 */
export interface FusionProbeData {
  /** 値の配列（行優先）。前景が存在しない画素は NaN（`computeFusionSlice` の範囲外表現）。 */
  values: Float32Array;
  cols: number;
  rows: number;
  /** 表示単位（"HU" / "SUVbw" / 空文字）。 */
  unit: string;
  /** `values` に掛けて表示値にする係数（SUV 校正済みなら SUV 乗数、それ以外は 1）。 */
  scale: number;
  /** SUV 空間の値か。臨床慣習に合わせて 2 桁固定で出すかの判定に使う。 */
  suv: boolean;
}

/** カーソル位置で読み出した前景の値。 */
export interface FusionProbeSample {
  /** 表示値（`suv` が true なら SUV 空間）。 */
  value: number;
  unit: string;
  suv: boolean;
}

const store = new Map<string, FusionProbeData | null>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      /* 購読側の例外は無視 */
    }
  }
}

/**
 * 前景プローブの登録・解除を購読する。返り値で解除。
 *
 * <p>値の差し替え（スライス送り・W/L 変更など）では通知しない。base 側はカーソルが動いた
 * ときに読みに来るので、毎回の再構成で再レンダを撃つ必要が無いため。
 */
export function subscribeFusionProbe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** そのビューポートに Fusion オーバーレイが載っているか（値の有無は問わない）。 */
export function hasFusionProbe(viewportId: string): boolean {
  return store.has(viewportId);
}

/** Fusion オーバーレイの登録（マウント時）。以後 {@link setFusionProbeData} で値を差し替える。 */
export function registerFusionProbe(viewportId: string): void {
  if (store.has(viewportId)) return;
  store.set(viewportId, null);
  notify();
}

/** Fusion オーバーレイの解除（アンマウント時）。 */
export function unregisterFusionProbe(viewportId: string): void {
  if (!store.has(viewportId)) return;
  store.delete(viewportId);
  notify();
}

/**
 * 前景の値配列を差し替える。`null` は「この断面に前景が無い」（範囲外で消去した場合）。
 * 登録前に呼ばれても取りこぼさないよう、未登録なら登録も兼ねる。
 */
export function setFusionProbeData(viewportId: string, data: FusionProbeData | null): void {
  const known = store.has(viewportId);
  store.set(viewportId, data);
  if (!known) notify();
}

/** 現在の前景の値配列（未登録・前景なしは null）。 */
export function getFusionProbeData(viewportId: string): FusionProbeData | null {
  return store.get(viewportId) ?? null;
}

/** 軸 1 本ぶんの格子間マッピング（画素中心どうしを対応させる）。 */
function mapAxis(f: number, from: number, to: number): number {
  if (from === to || from <= 0 || to <= 0) return f;
  return ((f + 0.5) / from) * to - 0.5;
}

/**
 * base 画像の連続 index 座標 `(fx, fy)` に対応する前景の値を読む。
 *
 * <p>空間 Fusion では `data` の格子＝背景の格子なので添字はそのまま。非空間フォールバックでは
 * 前景を base の表示矩形へ引き伸ばしているので、格子間の比例で対応づける。
 *
 * @param baseCols base 画像の列数（`ImageInfo.columns`）。
 * @param baseRows base 画像の行数（`ImageInfo.rows`）。
 * @returns 前景が無い画素（NaN）・範囲外・データ未取得なら null。
 */
export function sampleFusionValue(
  data: FusionProbeData | null,
  fx: number,
  fy: number,
  baseCols: number,
  baseRows: number,
): FusionProbeSample | null {
  if (!data || !data.cols || !data.rows) return null;
  const i = Math.round(mapAxis(fx, baseCols, data.cols));
  const j = Math.round(mapAxis(fy, baseRows, data.rows));
  if (i < 0 || j < 0 || i >= data.cols || j >= data.rows) return null;
  const v = data.values[j * data.cols + i];
  if (v === undefined || !Number.isFinite(v)) return null;
  return { value: v * data.scale, unit: data.unit, suv: data.suv };
}

/** テスト用。モジュールレベルの状態を捨てる。 */
export function _resetFusionProbeStore(): void {
  store.clear();
  listeners.clear();
}
