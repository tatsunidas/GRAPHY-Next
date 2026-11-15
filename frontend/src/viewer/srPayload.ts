import type { ViewerSrMeasurementGroup } from "./viewerCommands";

/**
 * SR の計測 1 つを backend へ送る形にする。
 *
 * 単位の省略は **null のまま送る**（backend が種別ごとの既定の単位を入れる）。ここで "mm" を補うと、
 * 体積・線量・割合・スコアまで mm と書かれてしまう。
 */
export function srMeasurementPayload(m: ViewerSrMeasurementGroup["measurements"][number]) {
  return {
    type: m.type,
    value: m.value,
    unit: m.unit ?? null,
    name: m.name ?? null,
  };
}
