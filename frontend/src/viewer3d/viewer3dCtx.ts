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
const VIEWER3D_CHANNEL = "graphy-viewer3d";

/**
 * プラグインが指定する視点・クリップ面（患者座標 LPS・mm）。起動コンテキストの任意キー `pluginView`。
 *
 * **`viewer3dCtxChanged` はこれを見ない**（同じシリーズのまま視点だけ更新しても画面を読み直さない。
 * 読み直すと置いた計測・メッシュが消える）。`seq` は単調増加で、同じ内容を再送しても適用し直せる。
 */
export interface Viewer3DPluginView {
  seq: number;
  camera?: {
    /** 視線（カメラ→注視点）。 */
    direction: [number, number, number];
    up: [number, number, number];
    /** 省略時は最初のクリップ面の原点、それも無ければボリューム中心。 */
    focalPoint?: [number, number, number];
    distanceMm?: number;
    projection?: "perspective" | "parallel";
    parallelScaleMm?: number;
  };
  /** 法線の向く側を残す。最大 6 枚。`[]` で全部消す。省略は変えない。 */
  clipPlanes?: { origin: [number, number, number]; normal: [number, number, number]; label?: string }[];
  /** ORTHO・SLAB は視点がモードの意味を変えるので受けない。 */
  mode?: "VR" | "MIP" | "MINIP";
  preset?: string;
  /** 出所。**host が入れる**（プラグインに名乗らせない）。 */
  provenance: { pluginId: string; pluginName: string; pluginVersion: string; title?: string };
}

export interface Viewer3DCtxLike {
  study?: { studyInstanceUid?: string } | null;
  series?: { seriesInstanceUid?: string } | null;
  c?: number;
  t?: number;
  /** 範囲つきで開いたときの範囲。違えば別の内容として読み直す。 */
  range?: ZRange;
  /** 連結して開いたときの選んだシリーズ。違えば別の内容として読み直す。 */
  concat?: { parts: Array<{ study: { studyInstanceUid: string }; series: { seriesInstanceUid: string } }> };
  /** プラグインが指定する視点・クリップ面。**同一性の判定（読み直すか）には使わない。** */
  pluginView?: Viewer3DPluginView;
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

/** 開いている窓へ「コンテキストを読み直せ」と伝える（窓が無ければ誰も受けない。`curvedMprContext.ts` と同じ作法）。 */
export function notifyViewer3dContext(): void {
  try {
    const bc = new BroadcastChannel(VIEWER3D_CHANNEL);
    bc.postMessage({ type: "updated" });
    bc.close();
  } catch {
    /* BroadcastChannel が無い環境では、2 回目以降の視点の更新は反映されない（窓を開き直せば反映される） */
  }
}

/** 読み直しの通知を購読する。戻り値で解除。 */
export function subscribeViewer3dContext(onUpdated: () => void): () => void {
  let bc: BroadcastChannel | null = null;
  try {
    bc = new BroadcastChannel(VIEWER3D_CHANNEL);
    bc.onmessage = () => onUpdated();
  } catch {
    bc = null;
  }
  return () => bc?.close();
}

/** コンテキストを書き、開いている窓へ知らせる。 */
export function writeViewer3dContext(ctx: object): void {
  localStorage.setItem(VIEWER3D_CTX_KEY, JSON.stringify(ctx));
  notifyViewer3dContext();
}

/**
 * 新しい `pluginView` を適用すべきか。`seq` が今まで適用した値より大きいときだけ（同じ内容の再読み込み・古い通知を無視する）。
 * 窓を開いた直後（まだ何も適用していない: null）は、あれば適用する。
 */
export function shouldApplyPluginView(appliedSeq: number | null, next: Viewer3DPluginView | undefined | null): boolean {
  if (!next || !Number.isFinite(next.seq)) return false;
  return appliedSeq === null || next.seq > appliedSeq;
}
