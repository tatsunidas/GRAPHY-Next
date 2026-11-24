/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */

/**
 * 値なし（NaN）を含む float の画像が、真っ黒に描画される問題の修正（Parametric Map の ROI の外・ROI の無いスライス）。
 *
 * <p>実測した原因（automator の texturePmViewCheck）: ① 描画に使う vtk のスカラー配列（画像のピクセル配列の**複製**）に NaN が
 * あると、ROI の値の読み取り・W/L が正しいのに、全面が黒になる（NaN を有限の値に置き換えると ROI が写る）。
 * ② さらに StackViewport は 1 枚目の配列を使い回して `set` と `modified()` だけで中身を入れ替え、配列が覚えている値域
 * （`ranges`）を捨てない。NaN だけのスライスの値域は `[Number.MAX_VALUE, -Number.MAX_VALUE]`（最小 > 最大）で、
 * これが次のスライスに残る。
 *
 * <p>修正（描画の前に、描画用の複製だけを直す。画像のピクセル配列は触らないので、値の読み取り・ROI 統計は NaN のまま）:
 * NaN を、そのスライスの有限な最小値（全部 NaN なら 0）に置き換え、値域の記憶を捨てる。値なしは最小色で描かれる。
 * NaN が無いときは、値域の記憶が壊れている（最小 > 最大）ときだけ捨てる。正常な画像の表示は変わらない。
 */
export interface ScalarsLike {
  getData(): ArrayLike<number> & { [i: number]: number };
  getRanges(computeRanges?: boolean): ReadonlyArray<{ min: number; max: number } | null> | null | undefined;
  dataChange(): void;
}

/** 描画用の配列を直した（`dataChange()` を呼んだ）なら true。 */
export function prepareScalarsForRender(scalars: ScalarsLike | null | undefined): boolean {
  if (!scalars) return false;
  const data = scalars.getData();
  if (data instanceof Float32Array || data instanceof Float64Array) {
    let min = Infinity;
    let hasNaN = false;
    for (let i = 0; i < data.length; i++) {
      const v = data[i];
      if (v !== v) hasNaN = true;
      else if (v < min) min = v;
    }
    if (hasNaN) {
      const fill = min === Infinity ? 0 : min;
      for (let i = 0; i < data.length; i++) {
        if (data[i] !== data[i]) data[i] = fill;
      }
      scalars.dataChange();
      return true;
    }
  }
  const ranges = scalars.getRanges(false);
  if (ranges?.some((r) => r !== null && r !== undefined && !(r.min <= r.max))) {
    scalars.dataChange();
    return true;
  }
  return false;
}

/** スタックのビューポートの vtk スカラー配列（無ければ null）。 */
export function scalarsOf(viewport: unknown): ScalarsLike | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = (viewport as any)?.getImageData?.();
    const s = data?.imageData?.getPointData?.()?.getScalars?.();
    return s && typeof s.getData === "function" && typeof s.getRanges === "function" && typeof s.dataChange === "function" ? (s as ScalarsLike) : null;
  } catch {
    return null;
  }
}
