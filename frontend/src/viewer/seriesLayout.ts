/**
 * シリーズの 5 次元（x,y は画像内）＝ Z(スライス) × C(チャンネル) × T(時間/フレーム) 構造。
 * GRAPHY Praparat の ZCT インデックスモデルに対応。
 */
export interface SeriesLayout {
  nZ: number;
  nC: number;
  nT: number;
  /** 指定 (c, t) に対する Z スタック（imageId 配列, z 昇順）。 */
  zStack(c: number, t: number): string[];
}

/**
 * imageId 群から ZCT レイアウトを構築する。
 *
 * <p>現状は単一次元（nC=1, nT=1, nZ=スライス数）。imageId は InstanceNumber 順
 * （backend がソート済み）。<b>実 5D 派生</b>（IPP→Z / TemporalPositionIdentifier→T /
 * EchoNumbers→C）は backend のヘッダ読取エンドポイントで次段に対応予定。ここが唯一の拡張点。
 */
export function buildSeriesLayout(imageIds: string[]): SeriesLayout {
  return {
    nZ: Math.max(1, imageIds.length),
    nC: 1,
    nT: 1,
    zStack: () => imageIds,
  };
}
