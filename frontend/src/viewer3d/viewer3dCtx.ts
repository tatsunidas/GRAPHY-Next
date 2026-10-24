/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 3D ビューアの起動コンテキスト（localStorage `graphy-viewer3d-ctx`）の同一性判定。
 * 3D ウィンドウが開いたまま 2D から別のシリーズ/C/T で再起動されたとき、読み込み直すかの判断に使う。
 * `ts`（書き込み時刻）だけが違う場合は同じ内容なので読み込み直さない。
 */
import { concatTileId, rangeKey, type ZRange } from "../viewer/virtualLayout";

export const VIEWER3D_CTX_KEY = "graphy-viewer3d-ctx";

export interface Viewer3DCtxLike {
  study?: { studyInstanceUid?: string } | null;
  series?: { seriesInstanceUid?: string } | null;
  c?: number;
  t?: number;
  /** 範囲つきで開いたときの範囲。違えば別の内容として読み直す。 */
  range?: ZRange;
  /** 連結して開いたときの選んだシリーズ。違えば別の内容として読み直す。 */
  concat?: { parts: Array<{ study: { studyInstanceUid: string }; series: { seriesInstanceUid: string } }> };
}

export function viewer3dCtxKey(ctx: Viewer3DCtxLike | null | undefined): string | null {
  const study = ctx?.study?.studyInstanceUid;
  if (!study) return null;
  return `${study}|${ctx?.series?.seriesInstanceUid ?? ""}|${ctx?.c ?? 0}|${ctx?.t ?? 0}${ctx?.range ? `|${rangeKey(ctx.range)}` : ""}${ctx?.concat ? `|${concatTileId(ctx.concat.parts.map((p) => ({ study: p.study.studyInstanceUid, series: p.series.seriesInstanceUid })))}` : ""}`;
}

/** 現在のコンテキストと、新しく書かれたコンテキストが（読み込み直すべきほど）違うか。 */
export function viewer3dCtxChanged(current: Viewer3DCtxLike | null | undefined, next: Viewer3DCtxLike | null | undefined): boolean {
  const n = viewer3dCtxKey(next);
  return n !== null && n !== viewer3dCtxKey(current);
}

/** localStorage の値（JSON 文字列）を解析する。不正なら null。 */
export function parseViewer3dCtx<T extends Viewer3DCtxLike>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
