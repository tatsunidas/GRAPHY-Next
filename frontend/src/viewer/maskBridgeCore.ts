/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * ウィンドウ間 ROI 同期（`maskBridge.ts`）の純関数部分。Cornerstone に触れないのでそのままテストできる。
 *
 * 2D ビューアの ROI マネージャと同じ粒度（塗りの ROI = segment 1 つ、パラメトリック球 1 つ）で
 * 3D ビューアへ一覧を渡す。名前は 2D の行と同じ規則（`roiRows.paintedRowName`）で決める。
 */
import type { DimScope, RoiMaskMeta } from "./roiMaskStore";
import { paintedRowName } from "./roiRows";

export interface PaintedAnnounce {
  kind: "painted";
  segmentationId: string;
  segmentIndex: number;
  label: string;
  /** 0..255。取得できなければ null。 */
  color: [number, number, number] | null;
  c: DimScope;
  t: DimScope;
}

export interface SphereAnnounce {
  kind: "sphere";
  sphereId: string;
  label: string;
  color: [number, number, number] | null;
  center: [number, number, number];
  radiusMm: number;
  c: DimScope;
  t: DimScope;
}

export type AnnounceEntry = PaintedAnnounce | SphereAnnounce;

/** 3D 側のコンテキスト（表示中の study/series と C/T）。c/t 未指定は「問わない」。 */
export interface AnnounceQuery {
  studyUid: string;
  seriesUid: string;
  c?: number;
  t?: number;
}

export interface AnnounceSphereInput {
  id: string;
  studyUid: string;
  seriesUid: string;
  center: [number, number, number];
  radiusMm: number;
  c: DimScope;
  t: DimScope;
  label?: string;
  /** "#rrggbb" */
  color: string;
}

export interface AnnounceSource {
  segmentations: ReadonlyArray<{ segmentationId: string; label?: string }>;
  metaOf(segmentationId: string): RoiMaskMeta | undefined;
  segmentsOf(segmentationId: string): number[];
  colorOf(segmentationId: string, segmentIndex: number): [number, number, number] | null;
  spheres: ReadonlyArray<AnnounceSphereInput>;
}

/** 次元の絞り込み。どちらかが未指定/"all" なら一致、数値同士は等しいときだけ一致。 */
export function dimMatches(entry: DimScope | undefined, want: number | undefined): boolean {
  if (want == null || entry == null || entry === "all") return true;
  return entry === want;
}

/** "#rrggbb" → [r,g,b]（不正なら null）。 */
export function hexToRgb255(hex: string | undefined): [number, number, number] | null {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec((hex ?? "").trim());
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : null;
}

/** segment の表示名。2D の行と同じ規則。名前が一切無ければ中立の "ROI n"。 */
export function segmentRoiLabel(meta: RoiMaskMeta | undefined, segmentIndex: number, single: boolean): string {
  const named = meta?.segmentLabels?.[String(segmentIndex)];
  if (!meta?.label && !named) return `ROI ${segmentIndex}`;
  return paintedRowName(meta, "ROI", segmentIndex, single);
}

/** 抽出対象の segment index。`only` 指定時はそれだけ（存在しなければ空）。 */
export function selectSegmentIndices(all: number[], only?: number): number[] {
  return only == null ? all : all.filter((i) => i === only);
}

export function buildAnnounceEntries(q: AnnounceQuery, src: AnnounceSource): AnnounceEntry[] {
  const out: AnnounceEntry[] = [];
  for (const s of src.segmentations) {
    const meta = src.metaOf(s.segmentationId);
    const sc = meta?.scope;
    if (!sc || sc.studyUid !== q.studyUid || sc.seriesUid !== q.seriesUid) continue;
    if (!dimMatches(sc.c, q.c) || !dimMatches(sc.t, q.t)) continue;
    const segs = src.segmentsOf(s.segmentationId);
    for (const segmentIndex of segs) {
      out.push({
        kind: "painted",
        segmentationId: s.segmentationId,
        segmentIndex,
        label: segmentRoiLabel(meta, segmentIndex, segs.length === 1),
        color: src.colorOf(s.segmentationId, segmentIndex),
        c: sc.c ?? "all",
        t: sc.t ?? "all",
      });
    }
  }
  src.spheres.forEach((s, i) => {
    if (s.studyUid !== q.studyUid || s.seriesUid !== q.seriesUid) return;
    if (!dimMatches(s.c, q.c) || !dimMatches(s.t, q.t)) return;
    out.push({
      kind: "sphere",
      sphereId: s.id,
      label: s.label || `ROI ${i + 1}`,
      color: hexToRgb255(s.color),
      center: s.center,
      radiusMm: s.radiusMm,
      c: s.c,
      t: s.t,
    });
  });
  return out;
}

/** 取り込み済み判定・重複排除に使うキー（3D の `SceneObject.source` と同じ規則）。 */
export function announceKey(e: AnnounceEntry): string {
  return e.kind === "painted" ? `painted:${e.segmentationId}#${e.segmentIndex}` : `sphere:${e.sphereId}`;
}

/** key で重複を落とす（先に現れたものを残す）。 */
export function dedupeAnnounce<T extends AnnounceEntry>(list: ReadonlyArray<T>): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const e of list) {
    const k = announceKey(e);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out;
}
