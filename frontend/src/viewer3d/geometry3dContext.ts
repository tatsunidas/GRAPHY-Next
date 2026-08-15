/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 幾何だけの 3D ウィンドウ（`#geometry3d`）へ渡す起動コンテキスト。
 *
 * <p>`graphy-viewer-ctx` / `graphy-viewer3d-ctx` と同じく **localStorage 経由**。
 * 別ウィンドウを開く既存の作法に合わせてある（`window.open` の named target ＋ ctx の読み出し）。
 *
 * <p>⚠️ **これは「起動時に読む使い捨ての引数」であって、保存領域ではない。**
 * 開くたびに上書きされる。3D QCA の結果そのものの保存は SR（§10.2.7）で行う。
 */

/** 患者 LPS mm の点列（[x,y,z] の配列）。 */
export type LpsPolyline = number[][];

export interface Geometry3DContext {
  /** 何を出すのか（表示名の決定と、将来の分岐に使う）。 */
  kind: "xa-qca3d";
  /** ウィンドウのタイトルに出す名前。 */
  name: string;
  /** 3D 中心線（患者 LPS mm）。 */
  centerlineLps: LpsPolyline;
  /** 情報バーに出す数値（**再計算しない**。ダイアログで出したものと同じ値を見せる）。 */
  info?: {
    lengthMm?: number;
    percentDiameterStenosis?: number;
    minEquivalentDiameterMm?: number;
    /** 角度補正が掛かっていたか。掛かっていない結果は歪みを含む（§10.2.2）。 */
    angleCorrected?: boolean;
    /** 各方向で見えている長さの割合（短縮。§10.2.5）。 */
    visibleFractionA?: number;
    visibleFractionB?: number;
  };
  ts: number;
}

const KEY = "graphy-geometry3d-ctx";
const CHANNEL = "graphy-geometry3d";

/**
 * 開いているウィンドウへ「コンテキストを読み直せ」と伝える。
 *
 * <p>🚨 **ビューアのウィンドウは画面キーごとのシングルトン**で、既に開いていると
 * `openViewer` は**フォーカスするだけ**（読み直さない）。これが無いと、2 回目以降に
 * 「押しても何も変わらない」という壊れ方をする。
 */
function notify(): void {
  try {
    const bc = new BroadcastChannel(CHANNEL);
    bc.postMessage({ type: "updated" });
    bc.close();
  } catch {
    /* 非対応環境ではウィンドウを開き直してもらう */
  }
}

/** コンテキストの更新を購読する。返り値で解除。 */
export function subscribeGeometry3dContext(cb: () => void): () => void {
  let bc: BroadcastChannel | null = null;
  try {
    bc = new BroadcastChannel(CHANNEL);
    bc.onmessage = () => cb();
  } catch {
    bc = null;
  }
  return () => bc?.close();
}

export function writeGeometry3dContext(ctx: Omit<Geometry3DContext, "ts">): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...ctx, ts: Date.now() }));
    notify();
  } catch {
    /* 書けなければ画面側が「コンテキストが無い」と出す */
  }
}

export function readGeometry3dContext(): Geometry3DContext | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const ctx = JSON.parse(raw) as Geometry3DContext;
    return Array.isArray(ctx?.centerlineLps) && ctx.centerlineLps.length >= 2 ? ctx : null;
  } catch {
    return null;
  }
}
