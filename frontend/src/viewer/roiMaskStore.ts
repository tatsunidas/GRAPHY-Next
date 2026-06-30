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
}

const metaById = new Map<string, RoiMaskMeta>();
const listeners = new Set<() => void>();

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
