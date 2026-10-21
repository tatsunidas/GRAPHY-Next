// 媒体（DICOMDIR）から読んだ内容の保持。画像の URL 向け直し・レイアウト DTO の供給を行う。
import type { DicomDirModel, SeriesRec } from "./dicomdir";
import type { Instance, SeriesLayoutDto } from "../../src/api";
import { buildLayoutDto, readHeaders } from "./layout";
import { registerMediaRoute, registerRoute } from "./mediaRoute";

const layouts = new Map<string, Promise<SeriesLayoutDto>>();

// Export が書く VIEWER/layouts.json（本体の backend が計算したレイアウト）。あればそれを使い、
// 無い媒体（他社製の DICOMDIR など）や載っていないシリーズだけ、ヘッダからブラウザ側で組む。
let exported: Promise<Record<string, SeriesLayoutDto>> = Promise.resolve({});
// 穴を埋める空白画像（VIEWER/blanks.json: {seriesUid: [{z, file}]}）。本体は backend が都度作る。
let blanks: Promise<Record<string, { z: number | null; file: string }[]>> = Promise.resolve({});
let mediaBase = "";

export function loadExportedLayouts(base: string): void {
  mediaBase = base;
  blanks = fetch(`${base}VIEWER/blanks.json`, { cache: "no-store" })
    .then((r) => (r.ok ? (r.json() as Promise<Record<string, { z: number | null; file: string }[]>>) : {}))
    .catch(() => ({}));
  exported = fetch(`${base}VIEWER/layouts.json`, { cache: "no-store" })
    .then((r) => (r.ok ? (r.json() as Promise<Record<string, SeriesLayoutDto>>) : {}))
    .catch(() => ({}));
}

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
export function layoutFor(series: SeriesRec, studyUid: string): Promise<SeriesLayoutDto> {
  let p = layouts.get(series.seriesUid);
  if (!p) {
    p = exported
      .then((all) => all[series.seriesUid] ?? fromHeaders(series))
      .then(async (dto) => {
        // 空白画像の URL（本体と同じ形）を、媒体の実ファイルへ向ける。
        for (const b of (await blanks)[series.seriesUid] ?? []) {
          const zs = b.z === null ? null : dto.zSpatial?.find((x) => x.z === b.z);
          if (b.z !== null && !zs) continue;
          const key = `/__media/api/studies/${encodeURIComponent(studyUid)}/series/${encodeURIComponent(series.seriesUid)}/blank/file${zs ? `?ipp=${zs.imagePositionPatient[0]},${zs.imagePositionPatient[1]},${zs.imagePositionPatient[2]}` : ""}`;
          registerRoute(key, `${mediaBase}VIEWER/${b.file}`);
        }
        return dto;
      });
    layouts.set(series.seriesUid, p);
  }
  return p;
}

function fromHeaders(series: SeriesRec): Promise<SeriesLayoutDto> {
  return readHeaders(
    series.images.filter((im) => im.url).map((im) => ({ sopUid: im.sopUid, url: im.url!, instanceNumber: im.instanceNumber })),
  ).then(buildLayoutDto);
}

const bySeriesUid = new Map<string, SeriesRec>();
export function indexSeries(model: DicomDirModel): void {
  for (const p of model.patients) for (const s of p.studies) for (const se of s.series) bySeriesUid.set(se.seriesUid, se);
}
export function seriesByUid(uid: string): SeriesRec | undefined {
  return bySeriesUid.get(uid);
}
