/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 血管の木（区間が複数）に解析値（H12）を色で乗せるための、区間ごとの色の組み立て（純関数）。
 *
 * <p>値の意味は解釈しない（`vesselColorMap.ts` と同じ）。**値が無い区間・点はグレー（値なし）**で、補間しない。
 * 区間ごとに `segmentId` で値を振り分けるので、他の区間の値が混ざらない。
 */
import type { XaVesselAnalysis } from "../viewer/xaVesselModelStore";
import { segmentValues, valuesToRgb } from "./vesselColorMap";

/**
 * 区間 id → 点ごとの RGB（`Uint8Array`、3 要素 × 点数）。解析値があるときは**全区間**に色を作り、
 * 値の無い区間・点は「値なし」のグレーにする（物体の既定色のままだと、解析されていない区間が解析済みの色に見える）。
 * 解析値が無ければ空（物体の既定色）。
 */
export function buildSegmentColors(
  segments: readonly { id: string; points: readonly unknown[] }[],
  analysis: Pick<XaVesselAnalysis, "perPoint" | "range"> | null,
): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  if (!analysis) return out;
  for (const seg of segments) {
    const mine = analysis.perPoint.filter((p) => p.segmentId === seg.id);
    out.set(seg.id, valuesToRgb(segmentValues(seg.points.length, mine), analysis.range));
  }
  return out;
}
