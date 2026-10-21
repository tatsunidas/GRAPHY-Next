// 本体 api.ts のうち、ポータブル版で意味を持つものだけ。残りは自動スタブ（reject / 何もしない）。
import type { SeriesLayoutDto } from "../../../src/api";
import { layoutFor, seriesByUid } from "../data";

export const fetchSeriesLayout = (studyUid: string, seriesUid: string): Promise<SeriesLayoutDto> => {
  const s = seriesByUid(seriesUid);
  return s ? layoutFor(s, studyUid) : Promise.reject(new Error("portable: unknown series"));
};
