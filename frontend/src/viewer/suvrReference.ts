/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * SUVR の参照領域の候補と、その値（今の校正込みの平均）を、アプリの ROI／VOI から読む。
 * 候補の一覧の作り方は ROI マネージャ（`RoiManagerPanel.refresh`）と同じ。
 */
import { annotation as csAnnotation, segmentation as csSeg } from "@cornerstonejs/tools";
import { measureCandidate, referenceCandidates, type MemberValues, type RefMeasure } from "./suvr";
import { buildRoiPanelModel, type RoiRowEnv } from "./roiRows";
import { getMaskSegments, getRoiMaskMeta } from "./roiMaskStore";
import { getSegmentVisible } from "./segmentation";
import { isRoiLocked } from "./roiLock";
import { computeRoiStatsAsync } from "./roiStatsStore";
import { computeMaskStatsAsync } from "./roi3d";

/** メタの患者を問わず、この PET シリーズに属するものだけを候補にするため、患者は固定の印にそろえる。 */
const ANY = "*";

export async function loadReferenceMeasures(seriesUid: string): Promise<RefMeasure[]> {
  const env: RoiRowEnv = {
    patientKey: ANY,
    metaOf: (id) => {
      const m = getRoiMaskMeta(id);
      return m ? { ...m, patientKey: ANY } : undefined;
    },
    isAnnotationVisible: () => true,
    isLocked: isRoiLocked,
    scopeText: () => "",
    isSegmentVisible: getSegmentVisible,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anns = (csAnnotation.state.getAllAnnotations() as any[]) ?? [];
  let segs: Array<{ segmentationId: string; label?: string }> = [];
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    segs = ((csSeg.state.getSegmentations() as any[]) ?? []).map((x) => ({ segmentationId: x.segmentationId as string, label: x.label as string | undefined }));
  } catch {
    /* マスクが読めなくても形の ROI は出す */
  }
  const model = buildRoiPanelModel(anns, segs, [], env, getMaskSegments);
  const cands = referenceCandidates(model, seriesUid, (uid) => getRoiMaskMeta(uid)?.label ?? "");

  // メンバーごとに 1 回だけ統計を読む（グループと単独で重複するため）。
  const loaded = new Map<string, MemberValues | undefined>();
  for (const c of cands) {
    for (const m of c.members) {
      if (loaded.has(m.key)) continue;
      if (m.kind === "shape" && m.uid) {
        const r = await computeRoiStatsAsync(m.uid, {});
        loaded.set(m.key, r?.values ? { n: r.values.n, mean: r.values.mean, sd: r.values.sd, unit: r.values.unit } : { missing: "refNoPixels" });
      } else if (m.maskId) {
        const r = await computeMaskStatsAsync(m.maskId, { segmentIndex: m.segmentIndex });
        loaded.set(m.key, r?.values ? { n: r.values.n, mean: r.values.mean, sd: r.values.sd, unit: r.unit } : { missing: "refNoPixels" });
      }
    }
  }
  return cands.map((c) => measureCandidate(c, (k) => loaded.get(k)));
}
