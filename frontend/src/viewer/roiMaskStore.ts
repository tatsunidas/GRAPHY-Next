/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * ROI/Mask のアプリ側メタデータ store（M2）。
 *
 * Cornerstone の annotation/segmentation を権威データとしつつ、アプリ固有のメタ
 * （ラベル・説明・ZCT scope・任意属性）を **itemId（annotationUID / segmentationId）単位**で保持する。
 * 将来は patientKey・ZCT scope を作成時に捕捉して紐付ける（`fw/roi-manager-design.md` 参照）。
 */

export type DimScope = number | "all";

export interface RoiScope {
  studyUid?: string;
  seriesUid?: string;
  z?: DimScope;
  c?: DimScope;
  t?: DimScope;
}

export interface RoiMaskMeta {
  label?: string;
  description?: string;
  /** どの患者に属するか（マネージャの患者フィルタ用）。 */
  patientKey?: string;
  /** シリーズ表示名（UI 用）。 */
  seriesLabel?: string;
  /** 現在の scope（編集可能。global/local 切替に使う）。 */
  scope?: RoiScope;
  /** 作成時の scope（原本。編集で "all" にしても元 index を復元できるよう保持）。 */
  origin?: RoiScope;
  /** 任意のカスタム属性（DICOM/ImageJ 出力時に保持）。 */
  custom?: Record<string, string>;
  /** このマスクに存在する segment index の一覧（多セグメント, D3）。Mask のみ。既定 [1]。 */
  segments?: number[];
  /** このマスクを直近 SEG 書き出しした先（再書き出し時、standalone なら旧シリーズを自動削除して
   * 「更新」相当にするために使う。`segExport.ts` 参照）。 */
  lastSegExport?: { studyUid: string; seriesUid: string; sopInstanceUid: string };
}

const metaById = new Map<string, RoiMaskMeta>();
const listeners = new Set<() => void>();

/**
 * セグメンテーション編集の**アクティブ対象**（D2: モードレス化の核）。
 * Brush/Eraser/3D Wand はこの (segmentationId, segmentIndex) に対して塗る。
 * null = 未選択（塗りツール起動時に自動で新規マスク作成→ここへ設定）。
 */
export interface SegEditTarget {
  segmentationId: string | null;
  segmentIndex: number;
}
let editTarget: SegEditTarget = { segmentationId: null, segmentIndex: 1 };

export function getSegEditTarget(): SegEditTarget {
  return editTarget;
}

/** アクティブマスクを設定（null で解除）。segmentIndex は据え置き。 */
export function setActiveSegmentationId(id: string | null): void {
  if (editTarget.segmentationId === id) return;
  editTarget = { ...editTarget, segmentationId: id };
  notify();
}

/** アクティブ segment index を設定（1 以上）。 */
export function setActiveSegmentIndexStore(idx: number): void {
  const i = Math.max(1, Math.floor(idx) || 1);
  if (editTarget.segmentIndex === i) return;
  editTarget = { ...editTarget, segmentIndex: i };
  notify();
}

/** マスクの segment index 一覧を取得（未登録は [1]）。 */
export function getMaskSegments(segmentationId: string): number[] {
  const segs = metaById.get(segmentationId)?.segments;
  return segs && segs.length ? segs : [1];
}

/** マスクに segment index を追加登録（重複は無視）。追加後の一覧を返す。 */
export function addMaskSegment(segmentationId: string, index: number): number[] {
  const cur = getMaskSegments(segmentationId);
  if (cur.includes(index)) return cur;
  const next = [...cur, index].sort((a, b) => a - b);
  setRoiMaskMeta(segmentationId, { segments: next });
  return next;
}

function notify(): void {
  for (const l of [...listeners]) {
    try {
      l();
    } catch {
      /* ignore */
    }
  }
}

export function getRoiMaskMeta(itemId: string): RoiMaskMeta | undefined {
  return metaById.get(itemId);
}

/** メタを部分更新（マージ）。 */
export function setRoiMaskMeta(itemId: string, patch: Partial<RoiMaskMeta>): void {
  const cur = metaById.get(itemId) ?? {};
  metaById.set(itemId, { ...cur, ...patch, custom: { ...cur.custom, ...patch.custom } });
  notify();
}

export function deleteRoiMaskMeta(itemId: string): void {
  if (metaById.delete(itemId)) notify();
}

/** 変更購読（マネージャ UI の再描画用）。 */
export function subscribeRoiMaskStore(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
