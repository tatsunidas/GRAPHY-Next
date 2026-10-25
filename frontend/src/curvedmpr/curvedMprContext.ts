/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 単独 Curved MPR ウィンドウ（`#curvedmpr`）の起動コンテキスト。
 *
 * <p>他のビューア窓と同じく **localStorage 経由の使い捨ての引数**（保存領域ではない）。
 * ウィンドウは画面キーごとのシングルトンで、既に開いていると `openViewer` はフォーカスするだけで
 * 読み直さない。2 回目以降の起動（プラグインからの中心線の差し替えを含む）は
 * {@link notifyCurvedMprContext} で「読み直せ」を流す（`geometry3dContext.ts` と同じ作法）。
 */
import type { Series, Study } from "../api";

export type CurvedMprFrameMode = "FIXED_Z" | "ROTATION_MINIMIZING";
export type CurvedMprProjection = "CENTERLINE_ONLY" | "AVERAGE" | "MIP" | "MINIP";

/** プラグインが指定できる見え方。省略したものは窓の既定のまま。 */
export interface CurvedMprOptions {
  frameMode?: CurvedMprFrameMode;
  projection?: CurvedMprProjection;
  bandHalfWidthMm?: number;
  /** [min, max]（mm、min < max）。 */
  secondAxisRangeMm?: [number, number];
  arcStepMm?: number;
}

/** 中心線の出所。**host が入れる**（プラグインに名乗らせない）。 */
export interface CurvedMprProvenance {
  pluginId: string;
  pluginName: string;
  pluginVersion: string;
  title?: string;
}

export interface CurvedMprContext {
  study: Study;
  series?: Series;
  c?: number;
  t?: number;
  ts: number;
  /** 中心線の制御点列（world mm, LPS）。3D Viewer のマスク由来中心線・プラグインから渡す。 */
  centerline?: [number, number, number][];
  options?: CurvedMprOptions;
  provenance?: CurvedMprProvenance;
}

export const CURVEDMPR_CTX_KEY = "graphy-curvedmpr-ctx";
const CHANNEL = "graphy-curvedmpr";

export function writeCurvedMprContext(ctx: CurvedMprContext): void {
  localStorage.setItem(CURVEDMPR_CTX_KEY, JSON.stringify(ctx));
}

export function readCurvedMprContext(): CurvedMprContext | null {
  try {
    const raw = localStorage.getItem(CURVEDMPR_CTX_KEY);
    return raw ? (JSON.parse(raw) as CurvedMprContext) : null;
  } catch {
    return null;
  }
}

/** 開いている窓へ「コンテキストを読み直せ」と伝える（窓が無ければ誰も受けない）。 */
export function notifyCurvedMprContext(): void {
  try {
    const bc = new BroadcastChannel(CHANNEL);
    bc.postMessage({ type: "updated" });
    bc.close();
  } catch {
    /* BroadcastChannel が無い環境では、2 回目の起動は反映されない（窓を開き直せば反映される） */
  }
}

/** 読み直しの通知を購読する。戻り値で解除。 */
export function subscribeCurvedMprContext(onUpdated: () => void): () => void {
  let bc: BroadcastChannel | null = null;
  try {
    bc = new BroadcastChannel(CHANNEL);
    bc.onmessage = () => onUpdated();
  } catch {
    bc = null;
  }
  return () => bc?.close();
}
