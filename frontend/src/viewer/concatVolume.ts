/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 連結して開いたタイルから、MPR・3D・Slicer に渡すボリューム用の imageId 列を作る。
 *
 * <p>連結のレイアウトは関数を含み ctx（localStorage の JSON）に載せられないので、受け側が選んだシリーズから
 * 作り直す（{@link rangedStackIds} が範囲から作り直すのと同じ位置づけ）。重なりは中点で切って片方だけにする
 * 2D の連結と同じ列を使う。
 *
 * <p>このボリュームは元のスライスをそのまま並べる。次の連結は**断る**（黙って別の形にしない）:
 * 隙間のある連結（ボリューム化が撮っていない範囲を補間で作ってしまう）、面内の格子が違う連結
 * （再サンプルが要る。段 3b）。
 */
import type { TFn } from "../i18n/i18n";
import { fetchSeriesLayout, type SeriesLayoutDto } from "../api";
import { buildLayoutFromDto } from "./seriesLayout";
import type { ViewerMode } from "./imageId";
import {
  concatLayouts, concatPartFromDto, sameInplaneGrid, type ConcatOpened, type ConcatPart, type ConcatViolation,
} from "./virtualLayout";

export type ConcatStackFailure =
  | { reason: "layoutFailed" }
  | { reason: "missing"; which: "iop" | "pixelSpacing" | "size" }
  | { reason: "violation"; violations: ConcatViolation[] }
  | { reason: "gap"; gapMm: number }
  | { reason: "grid"; which: "size" | "pixelSpacing" | "orientation" | "offset" };

export type ConcatStack =
  | { ok: true; imageIds: string[]; dto: SeriesLayoutDto; modality: string; count: number }
  | ({ ok: false } & ConcatStackFailure);

/** 判定に使う部分の一覧から連結の列を作る。レイアウトを取る部分（`ConcatPart` を作る）は {@link resolveConcatStack}。 */
export function concatStackFromParts(parts: readonly ConcatPart[]): { ok: true; imageIds: string[] } | ({ ok: false } & ConcatStackFailure) {
  const r = concatLayouts(parts);
  if (!r.ok) return { ok: false, reason: "violation", violations: r.violations };
  const gap = r.joints.reduce((m, j) => Math.max(m, j.gapMm), 0);
  if (gap > 0) return { ok: false, reason: "gap", gapMm: gap };
  const grid = sameInplaneGrid(parts);
  if (!grid.ok) return { ok: false, reason: "grid", which: grid.reason };
  return { ok: true, imageIds: r.layout.zStack(0, 0) };
}

export async function resolveConcatStack(
  parts: ConcatOpened["parts"],
  mode: ViewerMode,
): Promise<ConcatStack> {
  const loaded: ConcatPart[] = [];
  let dto0: SeriesLayoutDto | null = null;
  for (const { study, series } of parts) {
    let dto: SeriesLayoutDto;
    try {
      dto = await fetchSeriesLayout(study.studyInstanceUid, series.seriesInstanceUid);
    } catch {
      return { ok: false, reason: "layoutFailed" };
    }
    const layout = buildLayoutFromDto(dto, mode, study.studyInstanceUid, series.seriesInstanceUid);
    if (!layout) return { ok: false, reason: "layoutFailed" };
    const part = concatPartFromDto(
      {
        study: study.studyInstanceUid,
        series: series.seriesInstanceUid,
        layout,
        patientId: study.patientId ?? "",
        modality: series.modality ?? "",
      },
      dto,
    );
    if ("missing" in part) return { ok: false, reason: "missing", which: part.missing };
    if (!dto0) dto0 = dto;
    loaded.push(part);
  }
  const s = concatStackFromParts(loaded);
  if (!s.ok || !dto0) return s.ok ? { ok: false, reason: "layoutFailed" } : s;
  return { ok: true, imageIds: s.imageIds, dto: dto0, modality: loaded[0].modality, count: s.imageIds.length };
}

/** 失敗の理由を i18n キーと引数にする（`series.concat.fail.*`）。 */
export function concatFailureMessage(
  f: ConcatStackFailure,
  t: TFn,
): string {
  switch (f.reason) {
    case "gap": return t("series.concat.fail.gap", { mm: f.gapMm.toFixed(1) });
    case "grid": return t(`series.concat.fail.grid.${f.which}`);
    case "violation": return f.violations.map((v) => t(`openConcat.fail.${v}`)).join(" / ");
    case "missing": return t(`openConcat.missing.${f.which}`);
    default: return t("openConcat.fail.layoutFailed");
  }
}
