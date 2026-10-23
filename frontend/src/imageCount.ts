/**
 * 「枚数」に出す値。XA のマルチフレームは 1 SOP に何十枚も入るので、SOP 数ではなくフレーム総数を出す
 * （単一フレームの画像は 1 SOP = 1 枚で、どちらでも同じ）。
 *
 * フレーム数が分からない間（保存時に NumberOfFrames を持たなかった行の埋め直し前、読めないファイル、
 * web の QIDO など）は backend が null を返すので、SOP 数にフォールバックする。
 */
export function imageCount(x: { numberOfFrames?: number | null; numberOfInstances: number }): number {
  return x.numberOfFrames ?? x.numberOfInstances;
}
