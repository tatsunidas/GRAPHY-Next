/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 接続モニターの**並び・向き・画素数**を、OS が返す値（`graphy:list-displays` の `DisplayInfo`）から求める純関数。
 *
 * <p>診断用モニターの**自動判定はしない**（「6MP 相当」などの閾値の根拠が一次資料で未確認）。ここは配置の把握（表示）だけ。
 * 輝度・GSDF の定量はしない（`fw/monitor-qc-design.md` §1 の限界）。
 *
 * <p>欠損は 0 で埋めない: `bounds` が壊れたモニターは `known=false`、`scaleFactor` が壊れたら物理画素・メガピクセルは `null`（表示は「不明」）。
 */

export interface LayoutDisplayInput {
  id: number;
  bounds?: { x: number; y: number; width: number; height: number } | null;
  scaleFactor?: number | null;
}

export type Orientation = "portrait" | "landscape" | "square";

export interface DisplayLayoutRow {
  id: number;
  /** `bounds` が使える（有限・幅と高さが正）。 */
  known: boolean;
  /** 左→右（`x` の昇順、同じなら `y`、さらに `id`）に 1 から。`known=false` は null。 */
  order: number | null;
  /** OS の回転設定を反映した向き（`bounds` の縦横から）。 */
  orientation: Orientation | null;
  /** OS の座標（DIP）での大きさ。 */
  width: number | null;
  height: number | null;
  /** `bounds × scaleFactor` を丸めた物理画素の推定。`scaleFactor` が使えなければ null。 */
  physicalW: number | null;
  physicalH: number | null;
  /** 丸めが入っていない（拡大率が 1・2 など整数に収まる）。false なら「≈」と表示する。 */
  physicalExact: boolean | null;
  /** 物理画素の積 ÷ 10⁶（丸めていない値。表示は呼ぶ側が小数 1 桁に）。 */
  megapixels: number | null;
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function usableBounds(d: LayoutDisplayInput): d is LayoutDisplayInput & { bounds: { x: number; y: number; width: number; height: number } } {
  const b = d.bounds;
  return !!b && finite(b.x) && finite(b.y) && finite(b.width) && finite(b.height) && b.width > 0 && b.height > 0;
}

/**
 * 戻り値は**入力と同じ順・同じ長さ**（呼ぶ側は配列の位置で対応させる）。モニターの `id` は Electron が大きな整数（Linux で 2.5×10¹⁶ など、
 * JavaScript の安全な整数 9×10¹⁵ を超える値）を返すことがあり、`id` を鍵にすると取り違えるおそれがあるため、位置で引く。
 */
export function describeDisplayLayout(displays: LayoutDisplayInput[]): DisplayLayoutRow[] {
  const sortedIdx = displays
    .map((d, i) => ({ d, i }))
    .filter((x) => usableBounds(x.d))
    .sort((a, b) => a.d.bounds!.x - b.d.bounds!.x || a.d.bounds!.y - b.d.bounds!.y || a.i - b.i)
    .map((x) => x.i);
  const orderOf = new Map<number, number>(sortedIdx.map((idx, n) => [idx, n + 1]));
  return displays.map((d, idx): DisplayLayoutRow => {
    if (!usableBounds(d)) {
      return { id: d.id, known: false, order: null, orientation: null, width: null, height: null, physicalW: null, physicalH: null, physicalExact: null, megapixels: null };
    }
    const { width, height } = d.bounds;
    const orientation: Orientation = height > width ? "portrait" : width > height ? "landscape" : "square";
    const s = d.scaleFactor;
    const scaleOk = finite(s) && s > 0;
    const rawW = scaleOk ? width * s : null;
    const rawH = scaleOk ? height * s : null;
    const physicalW = rawW === null ? null : Math.round(rawW);
    const physicalH = rawH === null ? null : Math.round(rawH);
    return {
      id: d.id,
      known: true,
      order: orderOf.get(idx) ?? null,
      orientation,
      width,
      height,
      physicalW,
      physicalH,
      physicalExact: rawW === null || rawH === null ? null : Math.abs(rawW - (physicalW as number)) < 1e-6 && Math.abs(rawH - (physicalH as number)) < 1e-6,
      megapixels: physicalW === null || physicalH === null ? null : (physicalW * physicalH) / 1e6,
    };
  });
}

export interface LayoutMapBox {
  /** 入力の配列の位置（`describeDisplayLayout` の戻り値の位置と同じ）。 */
  index: number;
  id: number;
  order: number;
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * 略図の矩形。全モニターの外接矩形を `maxW × maxH` に収まるように縮尺する（拡大はしない上限は設けず、比率を保つ）。
 * 負の座標・縦に積んだ配置・段違いに対応する。`known=false` は含めない。
 */
export function layoutMap(displays: LayoutDisplayInput[], maxW: number, maxH: number): LayoutMapBox[] {
  const rows = describeDisplayLayout(displays);
  const items = displays
    .map((d, index) => ({ d, index, order: rows[index].order ?? 0 }))
    .filter((x): x is { d: LayoutDisplayInput & { bounds: NonNullable<LayoutDisplayInput["bounds"]> }; index: number; order: number } => usableBounds(x.d));
  if (items.length === 0 || !(maxW > 0) || !(maxH > 0)) return [];
  const minX = Math.min(...items.map((i) => i.d.bounds.x));
  const minY = Math.min(...items.map((i) => i.d.bounds.y));
  const maxX = Math.max(...items.map((i) => i.d.bounds.x + i.d.bounds.width));
  const maxY = Math.max(...items.map((i) => i.d.bounds.y + i.d.bounds.height));
  const k = Math.min(maxW / (maxX - minX), maxH / (maxY - minY));
  return items.map(({ d, index, order }) => ({
    index,
    id: d.id,
    order,
    left: (d.bounds.x - minX) * k,
    top: (d.bounds.y - minY) * k,
    width: d.bounds.width * k,
    height: d.bounds.height * k,
  }));
}
