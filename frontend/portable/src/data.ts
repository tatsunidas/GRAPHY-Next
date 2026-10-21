// 媒体（DICOMDIR）から読んだ内容の保持。画像の URL 向け直し・レイアウト DTO の供給を行う。
import type { DicomDirModel, SeriesRec } from "./dicomdir";
import type { Instance, SeriesLayoutDto } from "../../src/api";
import { buildLayoutDto, readHeaders } from "./layout";
import { registerMediaRoute } from "./mediaRoute";

const layouts = new Map<string, Promise<SeriesLayoutDto>>();

export function registerModel(model: DicomDirModel): void {
  for (const p of model.patients)
    for (const s of p.studies)
      for (const se of s.series)
        for (const im of se.images) if (im.url) registerMediaRoute(im.sopUid, im.url);
}

// 描画核は instances の参照が変わるとビューポートを組み直す。毎回同じ配列を返すこと。
const instanceCache = new Map<string, Instance[]>();

export function instancesOf(series: SeriesRec): Instance[] {
  let v = instanceCache.get(series.seriesUid);
  if (!v) {
    v = series.images.map((im) => ({
      sopInstanceUid: im.sopUid,
      instanceNumber: im.instanceNumber,
      sopClassUid: im.sopClassUid ?? null,
      transferSyntaxUid: null,
    }));
    instanceCache.set(series.seriesUid, v);
  }
  return v;
}

/** シリーズのレイアウト（初回のみヘッダを読む。同じシリーズへの再要求は同じ結果を返す）。 */
export function layoutFor(series: SeriesRec): Promise<SeriesLayoutDto> {
  let p = layouts.get(series.seriesUid);
  if (!p) {
    p = readHeaders(
      series.images.filter((im) => im.url).map((im) => ({ sopUid: im.sopUid, url: im.url!, instanceNumber: im.instanceNumber })),
    ).then(buildLayoutDto);
    layouts.set(series.seriesUid, p);
  }
  return p;
}

const bySeriesUid = new Map<string, SeriesRec>();
export function indexSeries(model: DicomDirModel): void {
  for (const p of model.patients) for (const s of p.studies) for (const se of s.series) bySeriesUid.set(se.seriesUid, se);
}
export function seriesByUid(uid: string): SeriesRec | undefined {
  return bySeriesUid.get(uid);
}
