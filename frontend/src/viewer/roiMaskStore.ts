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

/** scope → 表示文字列。保存は 0 始まりだが、ビューアのスライス番号に合わせて表示は 1 始まり。 */
export function formatScope(s: RoiScope | undefined): string {
  if (!s) return "";
  const z = s.z === "all" ? "Z:all" : `z${(s.z ?? 0) + 1}`;
  const c = s.c === "all" ? "C:all" : `c${(s.c ?? 0) + 1}`;
  const tt = s.t === "all" ? "T:all" : `t${(s.t ?? 0) + 1}`;
  return `${z} ${c} ${tt}`;
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
  /** ROI グループの鍵と名前（同じ鍵の ROI が 1 つのグループ。名前は所属 ROI に持たせ、メンバーがいる間だけグループが存在する）。 */
  groupId?: string;
  groupName?: string;
  /** 任意のカスタム属性（DICOM/ImageJ 出力時に保持）。 */
  custom?: Record<string, string>;
  /** このマスクに存在する segment index の一覧（多セグメント, D3）。Mask のみ。既定 [1]。 */
  segments?: number[];
  /** segment index → 名前（SEG の SegmentLabel・プラグインのラベル表）。ROI マネージャのセグメントの札に出す。 */
  segmentLabels?: Record<string, string>;
  /** このマスクを直近 SEG 書き出しした先（再書き出し時、standalone なら旧シリーズを自動削除して
   * 「更新」相当にするために使う。`segExport.ts` 参照）。 */
  lastSegExport?: { studyUid: string; seriesUid: string; sopInstanceUid: string };
  /** 保存（`roi_mask_document`）の行の鍵。初めて保存するときに採番し、復元したマスクは保存時の値を引き継ぐ。 */
  persistUid?: string;
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
  const cur = metaById.get(itemId);
  if (!metaById.delete(itemId)) return;
  notify();
  for (const l of [...deletedListeners]) {
    try {
      l(itemId, cur);
    } catch {
      /* ignore */
    }
  }
}

const deletedListeners = new Set<(itemId: string, meta: RoiMaskMeta | undefined) => void>();

/**
 * メタが削除されたことの購読（マスクを利用者が消した合図）。保存側が、保存済みの行を消すのに使う。
 * 🔴 ビューポートの破棄ではメタは消えない（`deleteRoiMaskMeta` を呼ぶのは削除操作だけ）ので、
 * タイルを閉じただけで保存済みのマスクが消えることはない。
 */
export function subscribeRoiMaskDeleted(l: (itemId: string, meta: RoiMaskMeta | undefined) => void): () => void {
  deletedListeners.add(l);
  return () => {
    deletedListeners.delete(l);
  };
}

/** 変更購読（マネージャ UI の再描画用）。 */
export function subscribeRoiMaskStore(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
