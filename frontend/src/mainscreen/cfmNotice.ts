/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import type { Series } from "../api";

/** Confocal Microscopy Image Storage（fw/microscopy-cfm.md）。 */
export const CFM_SOP_CLASS = "1.2.840.10008.5.1.4.1.1.77.1.8";

/**
 * 選んだシリーズに CFM が含まれるか。本体が作る CFM は 32 ビット（規格外）なので、送信・書き出しの前に確認を出すのに使う。
 * SOP クラスが取れないとき（web の QIDO）は Modality で見る。
 */
export function selectionHasCfm(seriesByStudy: Map<string, Series[]>, checked: Set<string>): boolean {
  for (const list of seriesByStudy.values()) {
    for (const s of list) {
      if (checked.has(s.seriesInstanceUid) && (s.sopClassUid === CFM_SOP_CLASS || s.modality === "CFM")) return true;
    }
  }
  return false;
}
