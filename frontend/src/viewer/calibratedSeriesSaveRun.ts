/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/** 適用中の校正を、シリーズ全体の Parametric Map として保存する（純関数は {@link ./calibratedSeriesSave}）。 */
import { metaData } from "@cornerstonejs/core";
import type { Instance, Series, Study } from "../api";
import { saveDerivedVolume } from "./derivedVolumeSave";
import { estimateGridBytes } from "./gridResample";
import type { ViewerMode } from "./imageId";
import { loadRegVolume } from "./regVolumeLoader";
import type { SuvCalibration } from "./suvStore";
import { calibrationUnit, describeCalibratedSave, gridOfVolume, isUniformStack } from "./calibratedSeriesSave";
import { getAppliedVolumeMaxMb } from "./volumeMemory";

export interface SaveCalibratedInput {
  cal: SuvCalibration;
  study: Study;
  series: Series;
  instances: Instance[];
  mode: ViewerMode;
  c: number;
  t: number;
  /** 出力が上限を超えるとき、続けるか（UI が確認ダイアログを出す）。 */
  confirmMemory: (mb: number, limitMb: number) => boolean;
}

export type SaveCalibratedResult =
  | { ok: true; count: number }
  | { ok: false; reason: "noGeometry" | "nonUniform" | "declined" };

export async function saveCalibratedSeries(i: SaveCalibratedInput): Promise<SaveCalibratedResult> {
  const loaded = await loadRegVolume(i.mode, i.study.studyInstanceUid, i.series.seriesInstanceUid, i.instances, i.c, i.t);
  if (!loaded) return { ok: false, reason: "noGeometry" };
  // 保存するのは元と同じ格子。等間隔でない元はアフィン 1 つで IPP を再現できないので断る。
  if (!isUniformStack(loaded.volume, loaded.slices)) return { ok: false, reason: "nonUniform" };
  const grid = gridOfVolume(loaded.volume);
  const mb = Math.round(estimateGridBytes(grid) / 1024 / 1024);
  const limit = getAppliedVolumeMaxMb();
  if (mb > limit && !i.confirmMemory(mb, limit)) return { ok: false, reason: "declined" };

  const first = loaded.firstImageId ?? undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const plane = first ? (metaData.get("imagePlaneModule", first) as any) : null;
  const th = Number(plane?.sliceThickness);
  const d = describeCalibratedSave(i.cal, i.series.seriesDescription || "");
  const unit = calibrationUnit(i.cal);
  const res = await saveDerivedVolume({
    grid,
    // loadRegVolume の値は校正込み。Parametric Map では割り戻さない（suvScale は渡さない）。
    data: loaded.volume.data,
    studyUid: i.study.studyInstanceUid,
    seriesUid: i.series.seriesInstanceUid,
    seriesDescription: d.seriesDescription,
    derivationDescription: d.derivationDescription,
    sourceSliceThickness: Number.isFinite(th) && th > 0 ? th : null,
    background: NaN,
    parametricMap: { label: d.label, explanation: d.explanation, unitCode: unit.unitCode, unitMeaning: unit.unitMeaning },
  });
  return { ok: true, count: res.count };
}
