/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 「この ROI を見せて」の通知（同一ウィンドウ内）。
 *
 * <p>ROI マネージャで行を選んだとき／ROI を複製したときに、**その ROI が乗っているスライスへ
 * 表示を移す**ために使う。選択のハイライトは `ViewerCommands.selectRoi` が担い、ここは
 * スライス移動だけを担当する。
 *
 * <h3>なぜ ViewerCommands ではなくバスなのか</h3>
 * <p>表示スライス `z` を持っているのは `SeriesViewer` で、`Viewer2D` は `imageIndex` を
 * **prop で受け取るだけ**。ViewerCommands は Viewer2D が登録するので、そこからは動かせない。
 * `viewerRefresh.ts` / `toast.ts` と同じ emit/subscribe にして、`SeriesViewer` に購読させる。
 *
 * <p>宛先はビューポート id ではなく **SOP Instance UID ＋フレーム番号**で指定する。
 * 同じシリーズを複数タイルで開いていることがあり、どのタイルが持っているかは
 * 発火側には分からないため（受け手が「自分のスタックに在るか」を判定する）。
 */

/** 見せたい ROI の在り処。 */
export interface RoiRevealRequest {
  /**
   * DICOM インスタンス。
   *
   * <p>🚨 **SOP だけでは 1 枚に決まらない。** XA の 1 ラン数十〜数百フレームはすべて同じ
   * SOP Instance UID を持つ（`fw/roi-manager-design.md` §11.9）。受け手は `frame` と
   * imageId 自身の `frame=` を突き合わせて解決すること。
   */
  sopInstanceUid: string;
  /** マルチフレーム内のフレーム番号（0 origin）。単一フレームは null。 */
  frame: number | null;
  /** 分かっていればシリーズ（受け手の早期棄却に使う）。 */
  seriesUid?: string;
}

const listeners = new Set<(req: RoiRevealRequest) => void>();

export function emitRoiReveal(req: RoiRevealRequest): void {
  for (const l of [...listeners]) {
    try {
      l(req);
    } catch {
      /* 1 つのタイルが失敗しても他のタイルには配る */
    }
  }
}

export function subscribeRoiReveal(l: (req: RoiRevealRequest) => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
