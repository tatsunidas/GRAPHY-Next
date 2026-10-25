/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * ROI マネージャの行モデル（Cornerstone に触れない純関数。`fw/roi-mask-model.md` §10）。
 *
 * <p>パネルは 2 つの区画に分ける。
 * <ul>
 *   <li><b>ROI</b>: 保存形式によらず 1 件 1 行。形の ROI（annotation の area/line/point）、
 *       塗りの ROI（labelmap の <b>segment 1 つにつき 1 行</b>）、パラメトリック球。</li>
 *   <li><b>計測</b>: Length / Bidirectional / Angle / Cobb / Probe（kind = "measure"）。</li>
 * </ul>
 * 種別不明のツール（矢印注記など）は ROI にも塗りにもならないので、落とさず計測の区画に出す。
 */
import { annotationRoiKind, isRoiKind, type RoiKind } from "./roiKind";

/** いま画面に出ているシリーズ（タイル）。ROI マネージャはこの集合に属する ROI だけを並べる。 */
export interface ShownSeries {
  patientKey: string;
  seriesUid: string;
}

export interface RoiRowEnv {
  /** フォーカス中の患者。`shown` が無いときは、この患者だけを出す（未紐付けのものは常に表示）。 */
  patientKey: string;
  /** 画面に出ている（患者, シリーズ）。あれば、これに属する ROI だけを出す（全患者表示用）。 */
  shown?: ReadonlyArray<ShownSeries>;
  metaOf(id: string): {
    patientKey?: string;
    label?: string;
    segments?: number[];
    segmentLabels?: Record<string, string>;
    scope?: { seriesUid?: string };
  } | undefined;
  isAnnotationVisible(uid: string): boolean;
  isLocked(uid: string): boolean;
  scopeText(id: string): string;
  isSegmentVisible(maskId: string, segIndex: number): boolean;
}

export interface SegmentationInput {
  segmentationId: string;
  label?: string;
}

export interface SphereInput {
  id: string;
  patientKey?: string;
  seriesUid?: string;
}

/** 行がどの患者・シリーズのものか（一覧を見出しでまとめるための印）。不明なら未設定。 */
export interface RowOwner {
  patientKey?: string;
  seriesUid?: string;
}

export interface ShapeRoiRow extends RowOwner {
  rowKind: "shape";
  key: string;
  uid: string;
  tool: string;
  kind: "area" | "line" | "point";
  visible: boolean;
  locked: boolean;
  scope: string;
}

export interface PaintedRoiRow extends RowOwner {
  rowKind: "painted";
  /** segment ごとに一意。統計ダイアログの uid にもそのまま使う。 */
  key: string;
  maskId: string;
  segIndex: number;
  /** 表示名（segment 名 → 単一 segment ならマスク名 → "<マスク名> #<番号>"）。 */
  name: string;
  /** そのマスクの segment が 1 つだけか（名前の編集をマスク名にも反映する判断に使う）。 */
  single: boolean;
  scope: string;
  visible: boolean;
}

export interface SphereRoiRow extends RowOwner {
  rowKind: "sphere";
  key: string;
  id: string;
}

export type RoiRow = ShapeRoiRow | PaintedRoiRow | SphereRoiRow;

export interface MeasureRow extends RowOwner {
  key: string;
  uid: string;
  tool: string;
  kind: RoiKind | null;
  visible: boolean;
  locked: boolean;
  scope: string;
}

export interface RoiPanelModel {
  rois: RoiRow[];
  measures: MeasureRow[];
}

export function paintedRowKey(maskId: string, segIndex: number): string {
  return `${maskId}#${segIndex}`;
}

export function paintedRowName(
  meta: { label?: string; segmentLabels?: Record<string, string> } | undefined,
  fallbackLabel: string,
  segIndex: number,
  single: boolean,
): string {
  const named = meta?.segmentLabels?.[String(segIndex)];
  // segment が 1 つだけなら ✎ 属性編集で書き換わる `label` を正とする（segmentLabels は取り込み時の名前で古くなり得る）。
  if (single) return meta?.label || named || fallbackLabel;
  return named || `${meta?.label || fallbackLabel} #${segIndex}`;
}

/**
 * ROI をこの一覧に出すか。`env.shown` があれば「表示中のシリーズに属するか」、無ければ従来どおり
 * 「フォーカス患者のものか」。患者が未紐付けのものは常に出す（取りこぼして消えるより、出す方が安全）。
 * シリーズが不明な ROI は、患者が表示中なら出す。
 */
export function isShown(env: Pick<RoiRowEnv, "patientKey" | "shown">, pk: string | undefined, seriesUid?: string): boolean {
  if (!pk) return true;
  if (!env.shown) return pk === env.patientKey;
  const mine = env.shown.filter((s) => s.patientKey === pk);
  if (mine.length === 0) return false;
  return !seriesUid || mine.some((s) => s.seriesUid === seriesUid);
}

export function buildRoiPanelModel(
  annotations: ReadonlyArray<unknown>,
  segmentations: ReadonlyArray<SegmentationInput>,
  spheres: ReadonlyArray<SphereInput>,
  env: RoiRowEnv,
  segmentsOf: (maskId: string) => number[],
): RoiPanelModel {
  const mine = (pk: string | undefined, seriesUid?: string) => isShown(env, pk, seriesUid);
  const shapes: ShapeRoiRow[] = [];
  const measures: MeasureRow[] = [];
  for (const a of annotations) {
    const ann = a as { annotationUID?: string; metadata?: { toolName?: string } } | null;
    const uid = ann?.annotationUID;
    const am = env.metaOf(uid ?? "");
    const owner: RowOwner = { patientKey: am?.patientKey, seriesUid: am?.scope?.seriesUid };
    if (!uid || !mine(owner.patientKey, owner.seriesUid)) continue;
    const kind = annotationRoiKind(ann);
    const tool = ann?.metadata?.toolName ?? "ROI";
    const common = { key: uid, uid, tool, ...owner, visible: env.isAnnotationVisible(uid), locked: env.isLocked(uid), scope: env.scopeText(uid) };
    if (kind && isRoiKind(kind)) shapes.push({ rowKind: "shape", kind: kind as ShapeRoiRow["kind"], ...common });
    else measures.push({ kind, ...common });
  }
  const painted: PaintedRoiRow[] = [];
  for (const s of segmentations) {
    const meta = env.metaOf(s.segmentationId);
    const owner: RowOwner = { patientKey: meta?.patientKey, seriesUid: meta?.scope?.seriesUid };
    if (!mine(owner.patientKey, owner.seriesUid)) continue;
    const segs = segmentsOf(s.segmentationId);
    for (const segIndex of segs) {
      painted.push({
        rowKind: "painted",
        ...owner,
        key: paintedRowKey(s.segmentationId, segIndex),
        maskId: s.segmentationId,
        segIndex,
        name: paintedRowName(meta, s.label || s.segmentationId, segIndex, segs.length === 1),
        single: segs.length === 1,
        scope: env.scopeText(s.segmentationId),
        visible: env.isSegmentVisible(s.segmentationId, segIndex),
      });
    }
  }
  const sphereRows: SphereRoiRow[] = spheres
    .filter((s) => mine(s.patientKey, s.seriesUid))
    .map((s) => ({ rowKind: "sphere", key: s.id, id: s.id, patientKey: s.patientKey, seriesUid: s.seriesUid }));
  return { rois: [...shapes, ...painted, ...sphereRows], measures };
}

/** 新規の塗り ROI の既定名の番号。既存名の中で "ROI <n>" 形式の最大番号 + 1（無ければ 1）。 */
export function nextDefaultRoiNumber(existingLabels: ReadonlyArray<string | undefined>): number {
  let max = 0;
  for (const l of existingLabels) {
    const m = /^ROI (\d+)$/.exec(l ?? "");
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}
