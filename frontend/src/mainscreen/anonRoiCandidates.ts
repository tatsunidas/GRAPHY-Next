/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 匿名化の焼き込みマスクに使える ROI を、**保存済み ROI から**組み立てる。
 *
 * <h3>なぜこれが要るのか</h3>
 * <p>以前は 2D ビューアの ROI マネージャに「匿名化の焼き込みに使用」ボタンがあった。
 * しかし匿名化をするのは MainScreen の Anonymizer なので、マスクを登録するためだけに
 * **別ウィンドウ（2D ビューア）を開く**必要があり、操作が 2 つの画面に割れていた。
 * さらに押すたびに追記されるので、二度押すと多角形が重複し、**個別に外す手段が無かった**。
 *
 * <p>ROI は `/api/rois?patientKey=` に患者単位で自動保存されている（`roiSaveStore`）ので、
 * ウィンドウを跨がずに読める。ここはそれを読んで「焼き込みに使える面 ROI」の一覧にする。
 *
 * <h3>守っていること</h3>
 * <ul>
 *   <li>🔴 **backend に ROI JSON を解釈させない。** `RoiDocument.java` が「backend は中身を
 *       解釈しない・スキーマの正本はフロント」と決めている。変換はここ（フロント）で行う。</li>
 *   <li>🔴 **判定と多角形化は `anonMaskExport` の正本を通す。** 「楕円を bbox に潰さない」
 *       「頂点はサブピクセルのまま」「面積を持つ閉 ROI だけ」を 2 つ目の実装で書き直さない。</li>
 *   <li>🔴 **world → 画素は `roiRead` の正本を通す。** MainScreen には Cornerstone が無いので
 *       `worldToPixelOnPlane()` を注入し、幾何が無いシリーズ（XA）のフォールバックは
 *       `roiPointsPx()` に任せる。</li>
 * </ul>
 */
import {
  fetchSeriesLayout,
  type AnonMaskPolygon,
  type Series,
  type SeriesLayoutDto,
  type Study,
} from "../api";
import { derivePatientKey } from "../viewer/patientKey";
import { fetchRoiDocument } from "../viewer/roiPersistenceApi";
import { parseSaveFile, type SavedRoi } from "../viewer/roiPersistence";
import { pickSampleKind } from "../viewer/roiStats";
import { roiPointsPx, worldToPixelOnPlane } from "../viewer/roiRead";
import { maskPolygonFromResolved, type MaskSkipReason } from "../viewer/anonMaskExport";

/** 焼き込みに使える ROI 1 件（画面の 1 行）。 */
export interface AnonRoiCandidate {
  roiUid: string;
  /** 表示名（ROI のラベル、無ければツール名）。 */
  label: string;
  tool: string;
  seriesUid: string;
  /** 行に出すシリーズの説明（`#3 AXIAL` など）。 */
  seriesLabel: string;
  sopInstanceUid: string;
  /** multi-frame のフレーム番号（0 origin）。単一フレームは null。 */
  frame: number | null;
  polygon: AnonMaskPolygon;
}

/** 使えなかった ROI（理由つきで見せる。黙って消さない）。 */
export interface AnonRoiSkip {
  label: string;
  reason: MaskSkipReason | "noGeometry" | "noSeries";
}

export interface AnonRoiCandidates {
  candidates: AnonRoiCandidate[];
  skipped: AnonRoiSkip[];
}

/**
 * 対象スタディの保存済み ROI から焼き込み候補を作る。
 *
 * @param study  匿名化の対象スタディ（患者鍵と studyUid の出どころ）
 * @param series そのスタディのシリーズ一覧（既にダイアログが引いている）
 */
export async function loadAnonRoiCandidates(
  study: Study,
  series: readonly Series[],
): Promise<AnonRoiCandidates> {
  const doc = await fetchRoiDocument(derivePatientKey(study));
  const parsed = parseSaveFile(doc.json);
  if (!parsed.rois.length) return { candidates: [], skipped: [] };

  const seriesByUid = new Map(series.map((s) => [s.seriesInstanceUid, s]));
  // 幾何はシリーズ単位。同じシリーズの ROI が何本あっても layout は 1 回だけ引く。
  const layouts = new Map<string, SeriesLayoutDto | null>();

  const candidates: AnonRoiCandidate[] = [];
  const skipped: AnonRoiSkip[] = [];

  for (const roi of parsed.rois) {
    const label = roi.label || roi.tool;
    // 面積を持つ閉 ROI 以外はここで落とす（線・点・角度は 1 画素も塗れない）。
    if (pickSampleKind((roi.tool ?? "").trim().toLowerCase(), !roi.isOpenContour) !== "area") {
      skipped.push({ label, reason: "notClosedArea" });
      continue;
    }
    // 🔴 **シリーズが分からない ROI は候補にしない。** 「スタディにシリーズが 1 本しか
    //    無いからこれだろう」と当てにいくと、SOP がそのシリーズに無いまま幾何なしの
    //    フォールバックへ落ち、**別の場所を塗るマスクが黙って出来上がる**。
    //
    // 🚨 **`SavedRoi.seriesUid` は実データでは基本入っていない**（実機で判明・2026-09-10）。
    //    保存の収集（`roiRestore.collectRoisForPatient`）は `RoiSaveContext.ct` を**わざと渡さない**
    //    ——まとめ保存なので「表示中の ZCT」を配ると別タイルの ROI に今見ている値を書くため。
    //    その結果 `studyUid` / `seriesUid` / `c` / `t` は空になる。
    //    シリーズの出どころは **ROI ごとに作成時へ固定される `scope`**（`viewerContext` 由来）。
    const seriesUid = roi.seriesUid || roi.scope?.seriesUid || roi.origin?.seriesUid;
    if (!seriesUid) {
      skipped.push({ label, reason: "noSeries" });
      continue;
    }
    // このスタディの外の ROI（保存は患者単位なので他スタディのものが普通に混ざる）。理由は出さない。
    if (!seriesByUid.has(seriesUid)) continue;
    if (!layouts.has(seriesUid)) {
      layouts.set(seriesUid, await loadLayout(study.studyInstanceUid, seriesUid));
    }
    const layout = layouts.get(seriesUid) ?? null;
    const pointsPx = toPixels(roi, layout);
    if (!pointsPx?.length) {
      skipped.push({ label, reason: "noGeometry" });
      continue;
    }
    const r = maskPolygonFromResolved(
      roi.tool,
      pointsPx,
      !roi.isOpenContour,
      roi.sopInstanceUid,
      roi.frame ?? null,
    );
    if (!("polygon" in r)) {
      skipped.push({ label, reason: r.reason });
      continue;
    }
    candidates.push({
      roiUid: roi.roiUid,
      label,
      tool: roi.tool,
      seriesUid,
      seriesLabel: seriesLabelOf(seriesByUid.get(seriesUid)),
      sopInstanceUid: roi.sopInstanceUid,
      frame: roi.frame ?? null,
      polygon: r.polygon,
    });
  }
  return { candidates, skipped };
}

/**
 * 保存形の world 座標（患者 LPS mm）→ 画像画素座標。**落とせなければ null。**
 *
 * <p>幾何が引けないシリーズ（XA）では `worldToPixelOnPlane` が null を返し、`roiPointsPx` の
 * 「world = 画素 × 画素間隔・原点 0」フォールバックへ落ちる。**規則を対にしておく**
 * ——ビューア上のマスクと焼き込まれた場所が違う、という気付けない食い違いを避けるため。
 *
 * <p>🔴 ただしフォールバックを使ってよいのは「そのシリーズに本当に幾何が無い」ときだけ。
 * **SOP がそのシリーズのものでない**（＝ ROI の属するシリーズを取り違えている）場合まで
 * フォールバックすると、もっともらしいが**別の場所を塗る多角形**が出来る。
 */
function toPixels(roi: SavedRoi, layout: SeriesLayoutDto | null) {
  if (!layout) return null;
  // その SOP がこのシリーズに存在することを確かめる（取り違えの検出）。
  const cell = layout.cells.find((c) => c.sopInstanceUid === roi.sopInstanceUid);
  if (!cell) return null;
  const iop = layout.imageOrientationPatient ?? null;
  const row = layout.pixelSpacingRow;
  const col = layout.pixelSpacingCol;
  const ipp = layout.zSpatial?.find((z) => z.z === cell.z)?.imagePositionPatient ?? null;
  return roiPointsPx(roi.polyline?.length ? roi.polyline : roi.points,
    (w) => worldToPixelOnPlane(w, ipp, iop, row, col), col, row);
}

async function loadLayout(studyUid: string, seriesUid: string): Promise<SeriesLayoutDto | null> {
  try {
    return await fetchSeriesLayout(studyUid, seriesUid);
  } catch {
    return null; // 幾何が引けなくても XA のフォールバックで拾える可能性がある
  }
}

function seriesLabelOf(s: Series | undefined): string {
  if (!s) return "";
  const num = s.seriesNumber != null ? `#${s.seriesNumber}` : "";
  return [num, s.seriesDescription || s.modality || ""].filter(Boolean).join(" ");
}
