/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 3D 再構成の結果 → **プラグインへ渡す血管モデル**（A7 の H11）への変換。
 * `fw/angio-design.md` §11。
 *
 * <p>ダイアログの状態から作るだけの純関数にしてあるのは、**渡す前に検算したい**から。
 * ここが静かに間違えると、外部モジュールは「もっともらしいが別物の血管」で FFR を計算し、
 * 返ってきた値は本体の絵にきれいに乗る——**誰も気付けない種類の誤り**になる。
 */

import type { CrossSectionProfile, GeometryRefinement, Recon3DResult } from "./xaRecon3d";
import { stableQcaRunKey, type XaQcaRun } from "./xaRecon3dStore";
import {
  vesselRunId,
  vesselStableKey,
  type XaVesselModel,
  type XaVesselSegment,
} from "./xaVesselModelStore";
import type { QcaDiameterMethod } from "./qca";

/** 単一血管（A6a）の 1 区間の id。 */
export const MAIN_SEGMENT_ID = "main";

export interface BuildQca3dModelArgs {
  runA: XaQcaRun;
  runB: XaQcaRun;
  result: Recon3DResult;
  /** 断面プロファイル（径の供給元）。無い / 出せていないなら径は全点 null。 */
  profile: CrossSectionProfile | null;
  /** 角度補正（バンドル調整）の結果。null なら補正なし。 */
  refinement: GeometryRefinement | null;
  /** 2 方向の測り方（ダイアログが決めた値をそのまま受ける。ここで導出し直さない）。 */
  diameterMethod: QcaDiameterMethod | "mixed" | null;
  separationDeg: number | null;
  label: string;
  /**
   * 利用者が選んだ近位端（H62）。`"start"` = 方向 A の中心線の始点側、`"end"` = 終点側。
   * null / 省略は「確かめていない」——点順は描いた順のまま、`orientation` も null。
   * `"end"` なら点と径を逆順にして、`points[0]` が近位になるように渡す。
   */
  proximalEnd?: "start" | "end" | null;
}

/**
 * 3D 点ごとの内腔径 [mm] を取り出す。
 *
 * <p>🔴 **測れなかった点は null のまま返す。** `CrossSectionProfile.sections` は
 * 3D 中心線の点と 1 対 1 に並んでおり、測れなかった点は null が入っている。
 * ここで前後から補間すると、**解析していない区間が解析済みに見える**。
 *
 * <p>🔴 **未校正（`unavailable`）なら全点 null。** px の径を掛け合わせた「mm² に見える数」を
 * 渡さない（`fuseCrossSection` が断面を出さないのと同じ理由）。
 */
export function diametersForPoints(
  pointCount: number,
  profile: CrossSectionProfile | null,
): (number | null)[] {
  const out: (number | null)[] = new Array(pointCount).fill(null);
  if (!profile || profile.unavailable) return out;
  for (let i = 0; i < pointCount && i < profile.sections.length; i++) {
    const s = profile.sections[i];
    out[i] = s && Number.isFinite(s.equivalentDiameterMm) ? s.equivalentDiameterMm : null;
  }
  return out;
}

function toPoints(points: Recon3DResult["points"]): [number, number, number][] {
  return points.map((p) => [p[0], p[1], p[2]] as [number, number, number]);
}

/** 単一血管（A6a）の再構成結果からモデルを作る。結果が使えないなら null。 */
export function buildQca3dVesselModel(args: BuildQca3dModelArgs): XaVesselModel | null {
  const { runA, runB, result, profile, refinement, diameterMethod, separationDeg, label } = args;
  const proximalEnd = args.proximalEnd ?? null;
  // blocking な警告がある結果は表示もしない（§10.2）。渡すのはなおさら駄目。
  if (!result.acceptable || result.points.length < 2) return null;

  const points = toPoints(result.points);
  const diameterMm = diametersForPoints(result.points.length, profile);
  // 🔴 点と径は**必ず一緒に**反転する（径は点と 1 対 1）。片方だけだと狭窄の位置がずれる。
  if (proximalEnd === "end") {
    points.reverse();
    diameterMm.reverse();
  }
  const segment: XaVesselSegment = {
    id: MAIN_SEGMENT_ID,
    points,
    diameterMm,
    parentId: null,
  };

  return {
    runId: vesselRunId("xa-qca3d", [runA.runKey, runB.runKey]),
    stableKey: vesselStableKey("xa-qca3d", [stableQcaRunKey(runA), stableQcaRunKey(runB)]),
    orientation: proximalEnd
      ? { proximalFirst: true, source: "user" }
      : { proximalFirst: null, source: null },
    kind: "xa-qca3d",
    label,
    segments: [segment],
    calibration: {
      diameterCalibrated: !!profile && !profile.unavailable,
      // 出自が読めなかった方向は "unknown"。**"none" と書き分ける**——
      // 「校正が無い」と「校正が何か分からない」は別の状態で、後者は注記の書き方が変わる。
      sources: [runA.calibrationSource ?? "unknown", runB.calibrationSource ?? "unknown"],
      tiers: [runA.calibrationTier ?? "uncalibrated", runB.calibrationTier ?? "uncalibrated"],
      diameterMethod,
    },
    provenance: {
      studyUid: runA.studyUid,
      seriesUids: [runA.seriesUid, runB.seriesUid],
      sopUids: [runA.sopInstanceUid, runB.sopInstanceUid].filter((u): u is string => !!u),
      angles: [
        [runA.geometry.primaryAngleDeg, runA.geometry.secondaryAngleDeg],
        [runB.geometry.primaryAngleDeg, runB.geometry.secondaryAngleDeg],
      ],
      angleCorrected: refinement != null,
      visibleFractions: [
        result.foreshortening.a?.visibleFraction ?? null,
        result.foreshortening.b?.visibleFraction ?? null,
      ],
      anchorReprojectionPx: result.anchorReprojectionPx,
      separationDeg: separationDeg ?? result.separationDeg,
      frameIndices: [runA.frameIndex, runB.frameIndex],
    },
    at: Date.now(),
  };
}
